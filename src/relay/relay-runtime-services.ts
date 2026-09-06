import { homedir } from 'node:os'
import { getRemoteHostPlatform } from '../main/ssh/ssh-remote-platform'
import { parseUnameToRelayPlatform } from '../main/ssh/relay-protocol'
import type { RelayDispatcher } from './dispatcher'
import { RelayContext, expandTilde } from './context'
import { PtyHandler } from './pty-handler'
import { FsHandler } from './fs-handler'
import { GitHandler } from './git-handler'
import { PreflightHandler } from './preflight-handler'
import { ExternalAutomationsHandler } from './external-automations-handler'
import { PortScanHandler } from './port-scan-handler'
import { AgentExecHandler } from './agent-exec-handler'
import { WorkspaceSessionHandler } from './workspace-session-handler'
import { AiVaultHandler } from './ai-vault-handler'
import { createRelayAiVaultService } from './ai-vault-service-factory'
import { registerRelayPluginHostCallHandlers } from './plugin-host-call-handler'
import { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'
import { RelayPtySourcePublication } from './relay-pty-source-publication'
import { SkillInstallHandler } from './skill-install-handler'
import { relayLogLine } from './relay-diagnostic-log'
import { remoteCliRequestTimeoutMs } from './remote-cli-timeout'
import { adoptDormantRelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-runtime-adoption'
import type { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'
import { RelayPtyOwnershipTransferFileStore } from './relay-pty-ownership-transfer-file-store'

export class RelayRuntimeServices {
  readonly ptyHandler: PtyHandler
  readonly ptyConsumerSessionAdapter: SshPtyConsumerSessionAdapter
  readonly ptySourcePublication: RelayPtySourcePublication
  readonly ptyOwnershipTransferAdapter: RelayPtyOwnershipTransferAdapter
  readonly fsHandler: FsHandler
  readonly gitHandler: GitHandler
  readonly skillInstallHandler: SkillInstallHandler
  private readonly aiVaultService: ReturnType<typeof createRelayAiVaultService> | null
  private readonly registeredHandlers: readonly unknown[]

  constructor(
    readonly dispatcher: RelayDispatcher,
    graceTimeMs: number,
    launchVersion: string,
    options: Readonly<{
      ownershipTransferStoreDirectory?: string
      /** Test/release-canary opt-in; production remains fail-closed by default. */
      enableOwnershipTransferMutation?: boolean
    }> = {}
  ) {
    const context = new RelayContext()
    this.registerSessionHandlers(context)
    this.ptyHandler = new PtyHandler(dispatcher, graceTimeMs)
    this.ptyConsumerSessionAdapter = new SshPtyConsumerSessionAdapter(
      dispatcher,
      launchVersion,
      (id, paused) => this.ptyHandler.setConsumerDeliveryPaused(id, paused),
      (id) => this.ptyHandler.handleSourceCreditAvailable(id)
    )
    this.ptySourcePublication = new RelayPtySourcePublication(
      dispatcher,
      this.ptyConsumerSessionAdapter,
      (id) => this.ptyHandler.handleSourcePublicationCapacity(id)
    )
    this.ptyHandler.setSourcePublication(this.ptySourcePublication)
    const ownershipTransferStore = options.ownershipTransferStoreDirectory
      ? new RelayPtyOwnershipTransferFileStore(options.ownershipTransferStoreDirectory)
      : undefined
    // Mutation without an endpoint-local journal would lose ownership state on restart.
    // Keep the relay read-only unless both the explicit opt-in and durable store are present.
    const mutationEnabled =
      options.enableOwnershipTransferMutation === true && ownershipTransferStore !== undefined
    // A default relay must remain usable even if a stale/corrupt dormant journal is present.
    // Only the explicit mutation path is allowed to make journal restore a startup requirement.
    const storeForAdapter = mutationEnabled ? ownershipTransferStore : undefined
    this.ptyOwnershipTransferAdapter = adoptDormantRelayPtyOwnershipTransferAdapter(
      this.ptyHandler,
      this.ptySourcePublication,
      dispatcher,
      storeForAdapter
    )
    this.ptyHandler.setOwnershipTransferMutationEnabled(mutationEnabled)
    if (mutationEnabled) {
      this.ptyOwnershipTransferAdapter.register(dispatcher)
    } else {
      this.ptyOwnershipTransferAdapter.registerStatus(dispatcher)
    }

    this.fsHandler = new FsHandler(dispatcher, context)
    const watchRegistry = this.fsHandler.getWatchRegistry()
    this.ptyHandler.setWorktreeRemovalCoordinator(watchRegistry)
    watchRegistry.setWorktreePtyTeardown((rootPath) =>
      this.ptyHandler.shutdownForWorktreePath(rootPath)
    )
    this.gitHandler = new GitHandler(dispatcher, context, watchRegistry)
    const preflightHandler = new PreflightHandler(dispatcher)
    this.skillInstallHandler = new SkillInstallHandler(dispatcher)
    const externalAutomationsHandler = new ExternalAutomationsHandler(dispatcher)
    const portScanHandler = new PortScanHandler(dispatcher)
    const agentExecHandler = new AgentExecHandler(dispatcher)
    const workspaceSessionHandler = new WorkspaceSessionHandler(dispatcher)
    const relayPlatform = parseUnameToRelayPlatform(process.platform, process.arch)
    const hostPlatform = relayPlatform ? getRemoteHostPlatform(relayPlatform) : undefined
    this.aiVaultService = hostPlatform ? createRelayAiVaultService(homedir(), hostPlatform) : null
    this.registeredHandlers = [
      preflightHandler,
      this.skillInstallHandler,
      externalAutomationsHandler,
      portScanHandler,
      agentExecHandler,
      workspaceSessionHandler,
      new AiVaultHandler(dispatcher, {
        hostPlatform,
        service: this.aiVaultService ?? undefined
      })
    ]

    registerRelayPluginHostCallHandlers(
      dispatcher,
      () => null,
      () => ({ grantedCapabilities: null, services: null })
    )
    this.registerRemoteCliRoutes()
  }

  async disposeOwnedProcesses(): Promise<void> {
    await this.skillInstallHandler.dispose().catch((error) => {
      relayLogLine(
        `[relay] Skill upload cleanup failed: ${error instanceof Error ? error.message : String(error)}`
      )
    })
    await this.aiVaultService?.dispose().catch((error) => {
      relayLogLine(
        `[relay] AI Vault sidecar shutdown failed: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }

  disposeHandlers(): void {
    this.fsHandler.dispose()
    this.gitHandler.dispose()
    void this.registeredHandlers
  }

  private registerSessionHandlers(context: RelayContext): void {
    this.dispatcher.onNotification('session.registerRoot', (params) => {
      const rootPath = params.rootPath as string
      if (rootPath) {
        context.registerRoot(rootPath)
      }
    })
    this.dispatcher.onRequest('session.registerRoot', async (params) => {
      const rootPath = params.rootPath as string
      if (rootPath) {
        context.registerRoot(rootPath)
      }
      return { ok: true }
    })
    this.dispatcher.onRequest('session.resolveHome', async (params) => ({
      resolvedPath: expandTilde(params.path as string)
    }))
  }

  private registerRemoteCliRoutes(): void {
    this.dispatcher.onRequest('orca.cli', async (params, context) =>
      this.dispatcher.requestAnyClient('orca.cli', params, {
        excludeClientId: context.clientId,
        timeoutMs: remoteCliRequestTimeoutMs(params)
      })
    )
    this.dispatcher.onRequest('orca.cli.postOutput', async (params, context) =>
      this.dispatcher.requestAnyClient('orca.cli.postOutput', params, {
        excludeClientId: context.clientId,
        timeoutMs: remoteCliRequestTimeoutMs(params)
      })
    )
  }
}

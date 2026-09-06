import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { RelayPtyOwnershipTransferFileStore } from '../../relay/relay-pty-ownership-transfer-file-store'
import type { PtyOwnershipBridgeCapabilities } from '../../shared/pty-ownership-bridge-contract'
import type {
  PtyOwnershipTransferStatusRequest,
  PtyOwnershipTransferStatusResult
} from '../../shared/pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferWireIdentity,
  parsePtyOwnershipTransferPrepareRequest,
  PTY_OWNERSHIP_TRANSFER_METHODS,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferExitEvent
} from '../../shared/pty-ownership-transfer-wire'
import { samePtyOwnershipTransferIdentity } from '../../shared/pty-ownership-transfer-identity'
import { PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS } from '../../shared/pty-ownership-transfer-runtime-methods'
import {
  PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
  type PtyOwnershipTransferSourceGrant,
  type PtyOwnershipTransferSourceGrantRequest
} from '../../shared/pty-ownership-transfer-source-grant'
import {
  samePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from '../../shared/pty-ownership-transfer-surface-binding'
import type { IPtyProvider } from './pty-provider-contract'
import { applyRuntimePtyOwnershipTransferProviderControl } from './runtime-pty-ownership-transfer-provider-control'
import {
  RuntimePtyOwnershipTransferProviderLifecycle,
  type RuntimePtyProviderReconciliation
} from './runtime-pty-ownership-transfer-provider-lifecycle'
import {
  RuntimePtyOwnershipTransferSourceAdapter,
  type RuntimePtyOwnershipTransferAttachmentBinding,
  type RuntimePtyOwnershipTransferOutputEvent,
  type RuntimePtyOwnershipTransferSourceAdapterOptions
} from './runtime-pty-ownership-transfer-source-adapter'
import { RuntimePtySourceAuthorityFileStore } from './runtime-pty-source-authority-file-store'
import { RuntimePtySourceAuthorityRegistry } from './runtime-pty-source-authority-registry'

type ObservedProvider = Pick<
  IPtyProvider,
  | 'listProcesses'
  | 'onData'
  | 'onExit'
  | 'setInputFenced'
  | 'writeOwnershipTransferInput'
  | 'resize'
  | 'sendSignal'
  | 'clearBuffer'
  | 'shutdown'
  | 'getAppliedSize'
>

export type RuntimePtyOwnershipTransferReadOnlySourceOptions = Readonly<{
  stateDirectory: string
  /** Stable host identity; used to reject self-targeted mutation requests. */
  runtimeId?: string
  onError?: (error: unknown) => void
  /** Test/release-canary gate; omitted keeps this source read-only. */
  mutationEnabled?: () => boolean
  authorizeMutationRequest?: (
    method: string,
    request: unknown,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ) => boolean
  applyDestinationControl?: RuntimePtyOwnershipTransferSourceAdapterOptions['applyDestinationControl']
  /** Short-lived grant lifetime; injectable for deterministic expiry tests. */
  grantTtlMs?: number
  /** Clock used for grant expiry; defaults to Date.now. */
  now?: () => number
}>

type ProviderChangeSubscription = (listener: (provider: ObservedProvider) => void) => () => void

const DEFAULT_SOURCE_GRANT_TTL_MS = 2 * 60 * 1_000
const MAX_SOURCE_GRANTS = 256

/** Production-safe host-local status source; it deliberately exposes no mutation methods. */
export class RuntimePtyOwnershipTransferReadOnlySource {
  private readonly adapter: RuntimePtyOwnershipTransferSourceAdapter
  private readonly lifecycle: RuntimePtyOwnershipTransferProviderLifecycle
  private readonly authorityRegistry: RuntimePtySourceAuthorityRegistry
  private readonly mutationEnabled: () => boolean
  private provider: ObservedProvider | null = null
  private reconciliation: Promise<RuntimePtyProviderReconciliation> | null = null
  private lastReconciliation: RuntimePtyProviderReconciliation | null = null
  private readonly runtimeId: string | undefined
  private readonly grantTtlMs: number
  private readonly now: () => number
  private readonly grants = new Map<
    string,
    Readonly<{
      grant: PtyOwnershipTransferSourceGrant
      clientId: number
      transportGeneration: number
      pairedDeviceId: string
      issuedAt: number
      expiresAt: number
    }>
  >()

  constructor(options: RuntimePtyOwnershipTransferReadOnlySourceOptions) {
    this.runtimeId = options.runtimeId
    this.grantTtlMs = boundedGrantTtl(options.grantTtlMs)
    this.now = options.now ?? Date.now
    this.mutationEnabled = options.mutationEnabled ?? (() => false)
    const paths = runtimePtyOwnershipTransferReadOnlyStatePaths(options.stateDirectory)
    const registry = new RuntimePtySourceAuthorityRegistry({
      store: new RuntimePtySourceAuthorityFileStore(paths.authorityFile)
    })
    this.authorityRegistry = registry
    this.adapter = new RuntimePtyOwnershipTransferSourceAdapter({
      store: new RelayPtyOwnershipTransferFileStore(paths.transferDirectory),
      resolveSource: (terminalId) => registry.resolve(terminalId),
      setInputFenced: (terminalId, fenced) => {
        const setInputFenced = this.provider?.setInputFenced
        if (!setInputFenced) {
          throw new Error('pty_ownership_transfer_runtime_input_fence_unavailable')
        }
        setInputFenced.call(this.provider, terminalId, fenced)
      },
      writeDestinationInput: (terminalId, data) => {
        if (this.provider?.writeOwnershipTransferInput?.(terminalId, data) !== true) {
          throw new Error('pty_ownership_transfer_runtime_source_terminal_unavailable')
        }
      },
      publishDestinationOutput: () => {},
      publishDestinationExit: () => {},
      mutationEnabled: this.mutationEnabled,
      authorizeMutationRequest: options.authorizeMutationRequest,
      applyDestinationControl:
        options.applyDestinationControl ??
        ((identity, control) => {
          const provider = this.provider
          if (!provider) {
            return Promise.resolve('unverifiable' as const)
          }
          return applyRuntimePtyOwnershipTransferProviderControl({
            provider,
            isCurrentProvider: () => this.provider === provider,
            identity,
            control
          })
        })
    })
    this.lifecycle = new RuntimePtyOwnershipTransferProviderLifecycle(registry, this.adapter, {
      onError: options.onError
    })
  }

  /** Installs one exact provider generation before any local status probe is served. */
  reconcileProvider(provider: ObservedProvider): Promise<RuntimePtyProviderReconciliation> {
    if (
      provider === this.provider &&
      this.lastReconciliation?.state === 'current' &&
      !this.reconciliation
    ) {
      return Promise.resolve(this.lastReconciliation)
    }
    if (provider === this.provider && this.reconciliation) {
      return this.reconciliation
    }

    const providerReplaced = this.provider !== null && this.provider !== provider
    this.provider = provider
    if (providerReplaced) {
      // A grant is bound to one provider/socket lifecycle; never let an old
      // paired caller resume against a replacement provider.
      this.grants.clear()
    }
    const pending = this.lifecycle.replaceProvider(provider)
    this.reconciliation = pending
    void pending.then(
      (result) => {
        if (this.provider === provider && this.reconciliation === pending) {
          this.lastReconciliation = result
          this.reconciliation = null
        }
      },
      () => {
        if (this.provider === provider && this.reconciliation === pending) {
          this.lastReconciliation = null
          this.reconciliation = null
        }
      }
    )
    return pending
  }

  getOwnershipBridgeCapabilities(): PtyOwnershipBridgeCapabilities {
    return this.adapter.getCapabilities()
  }

  getOwnershipTransferStatus(
    request: PtyOwnershipTransferStatusRequest
  ): PtyOwnershipTransferStatusResult {
    return this.adapter.status(request)
  }

  /**
   * Authenticates a paired-runtime mutation against the host's current PTY authority.
   * The RPC layer authenticates the caller/device; this check authenticates the exact
   * process incarnation and prevents a stale or self-targeted wire identity from mutating.
   */
  authorizeMutationRequest(
    method: string,
    request: unknown,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ): boolean {
    if (!isRuntimeOwnershipTransferMutationMethod(method)) {
      return false
    }
    if (
      !Number.isSafeInteger(binding.clientId) ||
      binding.clientId <= 0 ||
      !Number.isSafeInteger(binding.transportGeneration) ||
      binding.transportGeneration! <= 0 ||
      !binding.pairedDeviceId ||
      binding.isStale()
    ) {
      return false
    }
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      return false
    }
    const record = request as { version?: unknown }
    if (record.version !== PTY_OWNERSHIP_TRANSFER_WIRE_VERSION) {
      return false
    }
    let identity: ReturnType<typeof parsePtyOwnershipTransferWireIdentity>
    try {
      identity = parsePtyOwnershipTransferWireIdentity(request)
    } catch {
      return false
    }
    if (this.runtimeId !== undefined && identity.destinationRuntimeId === this.runtimeId) {
      return false
    }
    this.pruneExpiredGrants()
    const issued = this.grants.get(identity.bridgeId)
    if (
      !issued ||
      this.now() >= issued.expiresAt ||
      issued.clientId !== binding.clientId ||
      issued.transportGeneration !== binding.transportGeneration ||
      issued.pairedDeviceId !== binding.pairedDeviceId ||
      !samePtyOwnershipTransferIdentity(issued.grant.identity, identity)
    ) {
      return false
    }
    if (isPrepareMutationMethod(method)) {
      let prepare: ReturnType<typeof parsePtyOwnershipTransferPrepareRequest>
      try {
        prepare = parsePtyOwnershipTransferPrepareRequest(request)
      } catch {
        return false
      }
      if (
        !prepare.surfacePublication ||
        !samePtyOwnershipTransferSurfaceBinding(
          prepare.surfacePublication.surfaceBinding,
          issued.grant.surfaceBinding
        )
      ) {
        return false
      }
    }
    const source = this.sourceAuthority(identity.terminalId)
    return (
      source !== null &&
      identity.bridgeId ===
        derivePairedGrantBridgeId(
          source,
          identity,
          issued.grant.surfaceBinding,
          issued.transportGeneration,
          issued.pairedDeviceId
        ) &&
      source.terminalId === identity.terminalId &&
      source.incarnationId === identity.incarnationId &&
      source.ownerLease === identity.ownerLease &&
      source.sourceOwnerGeneration === identity.sourceOwnerGeneration
    )
  }

  /** Returns a source-minted identity only while the exact host incarnation is current. */
  issueOwnershipTransferSourceGrant(
    request: PtyOwnershipTransferSourceGrantRequest,
    binding: RuntimePtyOwnershipTransferAttachmentBinding
  ): PtyOwnershipTransferSourceGrant {
    if (
      !this.mutationEnabled() ||
      binding.isStale() ||
      !Number.isSafeInteger(binding.clientId) ||
      binding.clientId <= 0 ||
      !Number.isSafeInteger(binding.transportGeneration) ||
      binding.transportGeneration! <= 0 ||
      !binding.pairedDeviceId
    ) {
      throw new Error('pty_ownership_transfer_runtime_request_stale')
    }
    if (this.runtimeId !== undefined && request.destinationRuntimeId === this.runtimeId) {
      throw new Error('pty_ownership_transfer_runtime_self_target')
    }
    const source = this.sourceAuthority(request.terminalId)
    if (!source) {
      throw new Error('pty_ownership_transfer_source_authority_unavailable')
    }
    if (this.runtimeId !== undefined && request.destinationRuntimeId === this.runtimeId) {
      throw new Error('pty_ownership_transfer_source_self_target')
    }
    const identity = Object.freeze({
      bridgeId: derivePairedGrantBridgeId(
        source,
        request,
        request.surfaceBinding,
        binding.transportGeneration!,
        binding.pairedDeviceId
      ),
      terminalId: source.terminalId,
      incarnationId: source.incarnationId,
      ownerLease: source.ownerLease,
      sourceOwnerGeneration: source.sourceOwnerGeneration,
      destinationRuntimeId: request.destinationRuntimeId
    })
    const grant = Object.freeze({
      version: PTY_OWNERSHIP_TRANSFER_SOURCE_GRANT_VERSION,
      identity,
      surfaceBinding: request.surfaceBinding
    })
    const issuedAt = this.now()
    this.pruneExpiredGrants(issuedAt)
    this.grants.delete(grant.identity.bridgeId)
    while (this.grants.size >= MAX_SOURCE_GRANTS) {
      const oldest = this.grants.keys().next().value
      if (oldest === undefined) {
        break
      }
      this.grants.delete(oldest)
    }
    this.grants.set(
      grant.identity.bridgeId,
      Object.freeze({
        grant,
        clientId: binding.clientId,
        transportGeneration: binding.transportGeneration!,
        pairedDeviceId: binding.pairedDeviceId,
        issuedAt,
        expiresAt: issuedAt + this.grantTtlMs
      })
    )
    return grant
  }

  /** Returns host-minted authority only while this incarnation is proven live. */
  getOwnershipTransferSourceIdentity(terminalId: string) {
    return this.sourceAuthority(terminalId)
  }

  private sourceAuthority(terminalId: string) {
    return this.authorityRegistry.resolve(terminalId)
  }

  private pruneExpiredGrants(now = this.now()): void {
    for (const [bridgeId, issued] of this.grants) {
      if (now >= issued.expiresAt) {
        this.grants.delete(bridgeId)
      }
    }
  }

  /** Internal mutation seam used only by the authenticated paired-runtime RPC bridge. */
  getMutationSource(): RuntimePtyOwnershipTransferSourceAdapter {
    return this.adapter
  }

  onDestinationOutput(
    listener: (event: RuntimePtyOwnershipTransferOutputEvent) => void
  ): () => void {
    return this.adapter.onDestinationOutput(listener)
  }

  onDestinationExit(listener: (event: PtyOwnershipTransferExitEvent) => void): () => void {
    return this.adapter.onDestinationExit(listener)
  }

  dispose(): void {
    this.grants.clear()
    this.provider = null
    this.reconciliation = null
    this.lastReconciliation = null
    this.lifecycle.dispose()
  }
}

function derivePairedGrantBridgeId(
  source: Readonly<{
    terminalId: string
    incarnationId: string
    ownerLease: string
    sourceOwnerGeneration: number
  }>,
  destination: Readonly<{ destinationRuntimeId: string }>,
  surfaceBinding: PtyOwnershipTransferSurfaceBinding,
  transportGeneration: number,
  pairedDeviceId: string
): string {
  const digest = createHash('sha256')
    .update('runtime-pty-ownership-transfer-grant\0')
    .update(source.terminalId)
    .update('\0')
    .update(source.incarnationId)
    .update('\0')
    .update(source.ownerLease)
    .update('\0')
    .update(String(source.sourceOwnerGeneration))
    .update('\0')
    .update(destination.destinationRuntimeId)
    .update('\0')
    .update(surfaceBinding.executionHostId)
    .update('\0')
    .update(surfaceBinding.workspaceKey)
    .update('\0')
    .update(surfaceBinding.tabId)
    .update('\0')
    .update(surfaceBinding.leafId)
    .update('\0')
    .update(surfaceBinding.ptyId)
    .update('\0')
    .update(String(transportGeneration))
    .update('\0')
    .update(pairedDeviceId)
    .digest('base64url')
  return `runtime-${digest}`
}

function isPrepareMutationMethod(method: string): boolean {
  return method === PTY_OWNERSHIP_TRANSFER_METHODS.prepare || method.endsWith('.prepareSource')
}

function boundedGrantTtl(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SOURCE_GRANT_TTL_MS
  }
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10 * 60 * 1_000) {
    throw new Error('pty_ownership_transfer_source_grant_ttl_invalid')
  }
  return value
}

function isRuntimeOwnershipTransferMutationMethod(method: string): boolean {
  return (
    Object.values(PTY_OWNERSHIP_TRANSFER_METHODS).includes(
      method as (typeof PTY_OWNERSHIP_TRANSFER_METHODS)[keyof typeof PTY_OWNERSHIP_TRANSFER_METHODS]
    ) ||
    Object.values(PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS).includes(
      method as (typeof PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS)[keyof typeof PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS]
    )
  )
}

export async function startRuntimePtyOwnershipTransferProviderReconciliation(options: {
  source: RuntimePtyOwnershipTransferReadOnlySource
  getProvider: () => ObservedProvider
  subscribe: ProviderChangeSubscription
  onError?: (error: unknown) => void
}): Promise<() => void> {
  const reconcile = (provider: ObservedProvider): void => {
    void options.source.reconcileProvider(provider).catch(options.onError)
  }
  const unsubscribe = options.subscribe(reconcile)
  try {
    await options.source.reconcileProvider(options.getProvider())
    await options.source.reconcileProvider(options.getProvider())
    return unsubscribe
  } catch (error) {
    unsubscribe()
    throw error
  }
}

export async function createReconciledRuntimePtyOwnershipTransferReadOnlySource(
  options: RuntimePtyOwnershipTransferReadOnlySourceOptions & {
    getProvider: () => ObservedProvider
    subscribe: ProviderChangeSubscription
  }
): Promise<
  Readonly<{
    source: RuntimePtyOwnershipTransferReadOnlySource
    unsubscribe: () => void
  }>
> {
  const source = new RuntimePtyOwnershipTransferReadOnlySource(options)
  try {
    const unsubscribe = await startRuntimePtyOwnershipTransferProviderReconciliation({
      source,
      getProvider: options.getProvider,
      subscribe: options.subscribe,
      onError: options.onError
    })
    return Object.freeze({ source, unsubscribe })
  } catch (error) {
    source.dispose()
    throw error
  }
}

export function runtimePtyOwnershipTransferReadOnlyStatePaths(stateDirectory: string): Readonly<{
  authorityFile: string
  transferDirectory: string
}> {
  return Object.freeze({
    authorityFile: join(stateDirectory, 'source-authorities.json'),
    transferDirectory: join(stateDirectory, 'source-transfer-journals')
  })
}

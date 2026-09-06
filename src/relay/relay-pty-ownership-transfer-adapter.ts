import {
  PTY_OWNERSHIP_TRANSFER_METHODS,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION
} from '../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
import type { RelayDispatcher, RequestContext } from './dispatcher'
import {
  acceptRelayPtyOwnershipTransferInput,
  abortRelayPtyOwnershipTransfer,
  retireRelayPtyOwnershipTransferInput,
  statusRelayPtyOwnershipTransfer,
  snapshotRelayPtyOwnershipTransfer,
  type RelayPtyOwnershipTransferSnapshot
} from './relay-pty-ownership-transfer-adapter-input'
import {
  commitRelayPtyOwnershipTransfer,
  prepareRelayPtyOwnershipTransfer,
  publishRelayPtyOwnershipTransfer,
  replayRelayPtyOwnershipTransfer
} from './relay-pty-ownership-transfer-adapter-operations'
import type { RelayPtyOwnershipTransferAdapterOptions } from './relay-pty-ownership-transfer-adapter-contract'
import { boundedTransferPositive } from './relay-pty-ownership-transfer-adapter-validation'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import {
  newRelayPtyOwnershipTransferAdapterState,
  type RelayPtyOwnershipTransferAdapterState
} from './relay-pty-ownership-transfer-adapter-state'
import { isRelayPtyOwnershipTransferDestinationAttachmentActive } from './relay-pty-ownership-transfer-adapter-attachment'
import {
  persistRelayPtyOwnershipTransfer,
  removePersistedRelayPtyOwnershipTransfer
} from './relay-pty-ownership-transfer-adapter-persistence'
import {
  attachRelayPtyOwnershipTransferDestination,
  controlRelayPtyOwnershipTransferDestination
} from './relay-pty-ownership-transfer-control'
import { observeRelayPtyOwnershipTransferAdapterExit } from './relay-pty-ownership-transfer-adapter-exit'
import { observeRelayPtyOwnershipTransferOutput } from './relay-pty-ownership-transfer-output-observation'
import { restoreRelayPtyOwnershipTransferInputFences } from './relay-pty-ownership-transfer-input-fence-recovery'
import { rekeyRelayPtyOwnershipTransferReconnect } from './relay-pty-ownership-transfer-reconnect-rekey'
import {
  canRecoverRelayPtyOwnershipTransferPreparedAbort,
  canRecoverRelayPtyOwnershipTransferReconnectRekey,
  canRecoverRelayPtyOwnershipTransferStatus,
  recoverRelayPtyOwnershipTransferPostCommitRouteGeneration
} from './relay-pty-ownership-transfer-recovery-authorization'

export type {
  RelayPtyOwnershipTransferAdapterOptions,
  RelayPtyOwnershipTransferSource
} from './relay-pty-ownership-transfer-adapter-contract'
export { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
export type { RelayPtyOwnershipTransferSnapshot } from './relay-pty-ownership-transfer-adapter-input'

const DEFAULT_REPLAY_BYTES = 128 * 1024
const MAX_REPLAY_BYTES = 4 * 1024 * 1024
const DEFAULT_INPUT_IDS = 4_096
const MAX_INPUT_IDS = 65_536

/** Relay-side source adapter; mutating registration remains dormant on mixed-version peers. */
export class RelayPtyOwnershipTransferAdapter {
  private readonly state: RelayPtyOwnershipTransferAdapterState

  constructor(options: RelayPtyOwnershipTransferAdapterOptions) {
    this.state = newRelayPtyOwnershipTransferAdapterState({
      options,
      replayBytes: boundedTransferPositive(
        options.replayBytes ?? DEFAULT_REPLAY_BYTES,
        MAX_REPLAY_BYTES
      ),
      inputIds: boundedTransferPositive(options.inputIds ?? DEFAULT_INPUT_IDS, MAX_INPUT_IDS)
    })
  }

  /** Register additive RPC methods. Capability advertisement stays with the caller. */
  register(dispatcher: RelayDispatcher): void {
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.prepare, params, context)
      return this.prepare(params)
    })
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.replay, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.replay, params, context)
      return this.replay(params, context)
    })
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.commit, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.commit, params, context)
      return this.commit(params)
    })
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.publish, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.publish, params, context)
      return this.publish(params)
    })
    this.registerStatus(dispatcher)
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.input, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.input, params, context)
      return this.acceptInput(params)
    })
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.retireInput, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.retireInput, params, context)
      return this.retireInput(params)
    })
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.attach, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.attach, params, context)
      return this.attach(params, context)
    })
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.rekeyReconnect, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.rekeyReconnect, params, context)
      return this.rekeyReconnect(params, context)
    })
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.control, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.control, params, context)
      return await this.control(params, context)
    })
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.abort, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.abort, params, context)
      return this.abort(params)
    })
    // A reconnect reuses the primary client id but advances its transport generation.  Retire
    // bindings at detach so an old attachment cannot publish controls through a later socket.
    const detach = (
      dispatcher as unknown as {
        onClientDetached?: (listener: (clientId: number) => void) => () => void
      }
    ).onClientDetached?.bind(dispatcher)
    detach?.((clientId) => {
      for (const transfer of this.state.transfers.values()) {
        if (transfer.attachmentBinding?.clientId === clientId) {
          transfer.attachmentBinding = undefined
          // Do not emit an exit (or route output) to a socket that has already detached.
          transfer.attachmentId = undefined
          // Persist the detach fence so a relay restart cannot resurrect a stale attachment route.
          try {
            persistRelayPtyOwnershipTransfer(this.state, transfer)
          } catch {
            // A failed persistence leaves the in-memory route detached and therefore fail-closed.
          }
        }
      }
    })
  }

  /** Register only the read-only recovery probe while live transfer remains disabled. */
  registerStatus(dispatcher: RelayDispatcher): void {
    dispatcher.onRequest(PTY_OWNERSHIP_TRANSFER_METHODS.status, async (params, context) => {
      await this.authorize(PTY_OWNERSHIP_TRANSFER_METHODS.status, params, context)
      return this.status(params)
    })
  }

  /** Allows only the exact prepared identity to use resumed-owner abort authorization. */
  canRecoverPreparedAbort(value: unknown): boolean {
    return canRecoverRelayPtyOwnershipTransferPreparedAbort(this.state, value)
  }

  /** Allows a resumed owner to inspect only the exact durable transfer it already owned. */
  canRecoverStatus(value: unknown): boolean {
    return canRecoverRelayPtyOwnershipTransferStatus(this.state, value)
  }

  /** Allows only attachment-fenced recovery routes for an exact committed transfer. */
  canRecoverPostCommitRoute(value: unknown): boolean {
    return this.recoverPostCommitRouteGeneration(value) !== null
  }

  /** Returns the exact durable generation only when the request names its active route. */
  recoverPostCommitRouteGeneration(value: unknown): number | null {
    return recoverRelayPtyOwnershipTransferPostCommitRouteGeneration(this.state, value)
  }

  /** Allows a resumed owner to advance only the exact durable route it already owns. */
  canRecoverReconnectRekey(value: unknown): boolean {
    return canRecoverRelayPtyOwnershipTransferReconnectRekey(this.state, value)
  }

  /** Feed raw PTY output before the normal source-credit publication path. */
  observeOutput(
    terminalId: string,
    data: string,
    emissionKey?: string
  ): ReturnType<typeof observeRelayPtyOwnershipTransferOutput> {
    return observeRelayPtyOwnershipTransferOutput(this.state, terminalId, data, emissionKey)
  }

  restoreInputFences(): number {
    return restoreRelayPtyOwnershipTransferInputFences(this.state)
  }

  /** Drop source history and close any transient bridge record when a PTY exits. */
  removeTerminal(terminalId: string, incarnationId?: string): void {
    const bridgeId = this.state.transferByTerminal.get(terminalId)
    if (!bridgeId) {
      return
    }
    const transfer = this.state.transfers.get(bridgeId)
    if (transfer && incarnationId && transfer.identity.incarnationId !== incarnationId) {
      return
    }
    if (transfer?.exit) {
      return
    }
    this.state.histories.delete(terminalId)
    if (transfer?.phase === 'prepared') {
      transfer.phase = 'aborted'
      this.state.options.setInputFenced(terminalId, false)
      this.state.options.onAborted?.(transfer.identity)
    }
    removePersistedRelayPtyOwnershipTransfer(this.state, bridgeId)
    this.state.transfers.delete(bridgeId)
    this.state.transferByTerminal.delete(terminalId)
  }

  prepare(value: unknown) {
    return prepareRelayPtyOwnershipTransfer(this.state, value)
  }

  replay(value: unknown, context?: RequestContext) {
    return replayRelayPtyOwnershipTransfer(
      this.state,
      value,
      context
        ? {
            clientId: context.clientId,
            ...(context.transportGeneration === undefined
              ? {}
              : { transportGeneration: context.transportGeneration })
          }
        : undefined
    )
  }

  commit(value: unknown) {
    return commitRelayPtyOwnershipTransfer(this.state, value)
  }

  publish(value: unknown) {
    return publishRelayPtyOwnershipTransfer(this.state, value)
  }

  status(value: unknown) {
    return statusRelayPtyOwnershipTransfer(this.state, value)
  }

  acceptInput(value: unknown) {
    return acceptRelayPtyOwnershipTransferInput(this.state, value)
  }

  retireInput(value: unknown) {
    return retireRelayPtyOwnershipTransferInput(this.state, value)
  }

  attach(value: unknown, context?: RequestContext) {
    return attachRelayPtyOwnershipTransferDestination(
      this.state,
      value,
      context
        ? {
            clientId: context.clientId,
            ...(context.transportGeneration === undefined
              ? {}
              : { transportGeneration: context.transportGeneration })
          }
        : undefined
    )
  }

  rekeyReconnect(value: unknown, context?: RequestContext) {
    return rekeyRelayPtyOwnershipTransferReconnect(
      this.state,
      value,
      context
        ? {
            clientId: context.clientId,
            ...(context.transportGeneration === undefined
              ? {}
              : { transportGeneration: context.transportGeneration })
          }
        : undefined
    )
  }

  control(value: unknown, context?: RequestContext) {
    return controlRelayPtyOwnershipTransferDestination(
      this.state,
      value,
      context
        ? {
            clientId: context.clientId,
            ...(context.transportGeneration === undefined
              ? {}
              : { transportGeneration: context.transportGeneration })
          }
        : undefined
    )
  }

  /** Return true only while the exact attachment and authenticated route are live. */
  isDestinationAttachmentActive(
    value: PtyOwnershipTransferWireIdentity & { attachmentId: string },
    context?: RequestContext
  ): boolean {
    return isRelayPtyOwnershipTransferDestinationAttachmentActive(this.state, value, context)
  }

  observeExit(
    terminalOrEvent: string | { terminalId: string; incarnationId: string; code?: number },
    incarnationId?: string,
    code?: number
  ): void {
    observeRelayPtyOwnershipTransferAdapterExit(this.state, terminalOrEvent, incarnationId, code)
  }

  abort(value: unknown) {
    return abortRelayPtyOwnershipTransfer(this.state, value)
  }

  snapshot(bridgeId: string): RelayPtyOwnershipTransferSnapshot | null {
    return snapshotRelayPtyOwnershipTransfer(this.state, bridgeId)
  }

  private async authorize(
    method: string,
    params: Record<string, unknown>,
    context: RequestContext
  ): Promise<void> {
    if (!(await this.state.options.authorizeRequest(method, params, context))) {
      throw new RelayPtyOwnershipTransferError(
        'identity-mismatch',
        'ownership transfer request is not authorized for this relay owner'
      )
    }
    if (context.isStale()) {
      throw new RelayPtyOwnershipTransferError(
        'stale-request',
        'ownership transfer request became stale before relay mutation'
      )
    }
  }
}

export type { PtyOwnershipTransferWireIdentity } from '../shared/pty-ownership-transfer-wire'
export { PTY_OWNERSHIP_TRANSFER_WIRE_VERSION }

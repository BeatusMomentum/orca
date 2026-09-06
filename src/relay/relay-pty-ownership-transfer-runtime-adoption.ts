import type { PtyHandler } from './pty-handler'
import {
  PTY_OWNERSHIP_TRANSFER_METHODS,
  PTY_OWNERSHIP_TRANSFER_NOTIFICATIONS
} from '../shared/pty-ownership-transfer-wire'
import { RelayPtyOwnershipTransferAdapter } from './relay-pty-ownership-transfer-adapter'
import type { RelayPtyOwnershipTransferStore } from './relay-pty-ownership-transfer-adapter-contract'
import type { RelayPtySourcePublication } from './relay-pty-source-publication'
import type { RelayDispatcher } from './dispatcher'

/** Captures relay PTY output without exposing an incomplete ownership-transfer transport. */
export function adoptDormantRelayPtyOwnershipTransferAdapter(
  ptyHandler: Pick<
    PtyHandler,
    | 'resolveOwnershipTransferTerminal'
    | 'setOwnershipTransferInputFenced'
    | 'setOwnershipTransferOutputObserver'
    | 'writeOwnershipTransferInput'
    | 'applyOwnershipTransferControl'
  >,
  sourcePublication: Readonly<{
    /** True when the existing source-credit route can carry tagged handoff frames to the client. */
    accepts?: (terminalId: string) => boolean
    ownershipTransfer: Pick<
      RelayPtySourcePublication['ownershipTransfer'],
      | 'authorizes'
      | 'authorizesResumedTransfer'
      | 'authorizesResumedTransferAtGeneration'
      | 'resolve'
    >
  }>,
  dispatcher?: Pick<RelayDispatcher, 'notify' | 'notifyClient'>,
  store?: RelayPtyOwnershipTransferStore
): RelayPtyOwnershipTransferAdapter {
  let adapter: RelayPtyOwnershipTransferAdapter | null = null
  adapter = new RelayPtyOwnershipTransferAdapter({
    resolveSource: (terminalId) => {
      const terminal = ptyHandler.resolveOwnershipTransferTerminal(terminalId)
      const source = sourcePublication.ownershipTransfer.resolve(terminalId)
      return terminal?.incarnationId === source?.incarnationId ? source : null
    },
    ...(store ? { store } : {}),
    authorizeRequest: (method, request, context) => {
      if (!isRecord(request)) {
        return false
      }
      const terminalId = request.terminalId
      const incarnationId = request.incarnationId
      const ownerLease = request.ownerLease
      const sourceOwnerGeneration = request.sourceOwnerGeneration
      if (
        typeof terminalId === 'string' &&
        typeof ownerLease === 'string' &&
        Number.isSafeInteger(sourceOwnerGeneration) &&
        sourcePublication.ownershipTransfer.authorizes(
          terminalId,
          ownerLease,
          Number(sourceOwnerGeneration),
          context.clientId
        )
      ) {
        return true
      }
      const liveTerminal =
        typeof terminalId === 'string'
          ? ptyHandler.resolveOwnershipTransferTerminal(terminalId)
          : null
      if (typeof ownerLease !== 'string' || !Number.isSafeInteger(sourceOwnerGeneration)) {
        return false
      }
      const resumedOwner = sourcePublication.ownershipTransfer.authorizesResumedTransfer(
        ownerLease,
        Number(sourceOwnerGeneration),
        context.clientId
      )
      if (method === PTY_OWNERSHIP_TRANSFER_METHODS.status) {
        return resumedOwner && adapter?.canRecoverStatus(request) === true
      }
      if (method === PTY_OWNERSHIP_TRANSFER_METHODS.rekeyReconnect) {
        const reconnectGeneration = request.reconnectGeneration
        return (
          typeof reconnectGeneration === 'number' &&
          sourcePublication.ownershipTransfer.authorizesResumedTransferAtGeneration(
            ownerLease,
            reconnectGeneration,
            context.clientId
          ) &&
          adapter?.canRecoverReconnectRekey(request) === true
        )
      }
      if (method === PTY_OWNERSHIP_TRANSFER_METHODS.replay) {
        const reconnectGeneration = adapter?.recoverPostCommitRouteGeneration(request)
        return (
          reconnectGeneration !== null &&
          reconnectGeneration !== undefined &&
          sourcePublication.ownershipTransfer.authorizesResumedTransferAtGeneration(
            ownerLease,
            reconnectGeneration,
            context.clientId
          )
        )
      }
      return (
        resumedOwner &&
        method === PTY_OWNERSHIP_TRANSFER_METHODS.abort &&
        typeof incarnationId === 'string' &&
        liveTerminal?.incarnationId === incarnationId &&
        adapter?.canRecoverPreparedAbort(request) === true
      )
    },
    setInputFenced: (terminalId, fenced) =>
      ptyHandler.setOwnershipTransferInputFenced(terminalId, fenced),
    writeDestinationInput: (terminalId, data) => {
      if (!ptyHandler.writeOwnershipTransferInput(terminalId, data)) {
        throw new Error('pty_ownership_transfer_source_terminal_gone')
      }
    },
    publishDestinationOutput: (identity) => {
      // Direct-SSH destinations already consume the relay's source-credit stream. Let the
      // observer return its additive envelope so PtyHandler can enqueue it through that bounded
      // path; a relay without an admitted stream remains fail-closed.
      if (!sourcePublication.accepts?.(identity.terminalId)) {
        throw new Error('pty_ownership_transfer_destination_output_transport_unavailable')
      }
    },
    applyDestinationControl: (identity, control) =>
      ptyHandler.applyOwnershipTransferControl(
        identity.terminalId,
        identity.incarnationId,
        control
      ),
    publishDestinationExit: (event, binding) => {
      if (!dispatcher || !binding) {
        throw new Error('pty_ownership_transfer_destination_exit_transport_unavailable')
      }
      // Exit is authoritative only for the attachment that committed this bridge. A broadcast
      // could make an unrelated client retire a same-ID PTY after a reconnect.
      dispatcher.notifyClient(binding.clientId, PTY_OWNERSHIP_TRANSFER_NOTIFICATIONS.exit, event)
    }
  })
  ptyHandler.setOwnershipTransferOutputObserver(adapter)
  return adapter
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

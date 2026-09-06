import type { RelayPtyOwnershipTransferAdapterState } from './relay-pty-ownership-transfer-adapter-state'

/** Re-applies durable fences after the current execution provider proves exact liveness. */
export function restoreRelayPtyOwnershipTransferInputFences(
  state: RelayPtyOwnershipTransferAdapterState
): number {
  let restored = 0
  for (const transfer of state.transfers.values()) {
    if (transfer.phase === 'aborted' || transfer.exit) {
      continue
    }
    const source = state.options.resolveSource(transfer.identity.terminalId)
    if (
      source?.terminalId !== transfer.identity.terminalId ||
      source.incarnationId !== transfer.identity.incarnationId ||
      source.ownerLease !== transfer.identity.ownerLease ||
      source.sourceOwnerGeneration !== transfer.identity.sourceOwnerGeneration
    ) {
      continue
    }
    state.options.setInputFenced(transfer.identity.terminalId, true)
    restored++
  }
  return restored
}

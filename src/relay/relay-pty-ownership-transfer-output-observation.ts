import type { PtyOwnershipTransferOutputFragment } from '../shared/pty-ownership-transfer-output-envelope'
import { PTY_OWNERSHIP_TRANSFER_WIRE_VERSION } from '../shared/pty-ownership-transfer-wire'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import {
  forgetRelayPtyOwnershipTransferEmission,
  rememberRelayPtyOwnershipTransferEmission,
  retryObservedRelayPtyOwnershipTransferEmission
} from './relay-pty-ownership-transfer-emission-retry'
import {
  emptyRelayPtyOwnershipTransferHistory,
  type RelayPtyOwnershipTransferAdapterState,
  type RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'
import { splitTransferOutputFrames } from './relay-pty-ownership-transfer-adapter-validation'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'

/** Capture source bytes and publish committed frames with durable sequence fencing. */
export function observeRelayPtyOwnershipTransferOutput(
  state: RelayPtyOwnershipTransferAdapterState,
  terminalId: string,
  data: string,
  emissionKey?: string
): readonly PtyOwnershipTransferOutputFragment[] | undefined {
  if (!terminalId || data.length === 0) {
    return undefined
  }
  const bridgeId = state.transferByTerminal.get(terminalId)
  const transfer = bridgeId ? state.transfers.get(bridgeId) : undefined
  if (transfer && !currentSourceMatchesTransfer(state, transfer)) {
    return undefined
  }
  if (transfer && emissionKey) {
    const retried = retryObservedRelayPtyOwnershipTransferEmission(
      state,
      transfer,
      emissionKey,
      data
    )
    if (retried) {
      return retried
    }
  }
  const history = state.histories.get(terminalId) ?? emptyRelayPtyOwnershipTransferHistory()
  const previousHistory = transfer
    ? {
        nextSeq: history.nextSeq,
        retainedBytes: history.retainedBytes,
        frames: history.frames.slice()
      }
    : undefined
  const previousSourceOutputEndSeq = transfer?.sourceOutputEndSeq
  const previousReplayStartSeq = transfer?.replayStartSeq
  const frames = splitTransferOutputFrames(data, () => history.nextSeq++)
  for (const frame of frames) {
    history.frames.push(frame)
    history.retainedBytes += Buffer.byteLength(frame.data, 'utf8')
    while (history.retainedBytes > state.replayBytes && history.frames.length > 0) {
      const removed = history.frames.shift()!
      history.retainedBytes -= Buffer.byteLength(removed.data, 'utf8')
    }
  }
  state.histories.set(terminalId, history)
  if (!transfer) {
    return undefined
  }
  transfer.sourceOutputEndSeq = history.nextSeq - 1
  transfer.replayStartSeq = history.frames[0]?.seq ?? history.nextSeq
  let fragments: PtyOwnershipTransferOutputFragment[] | undefined
  if (transfer.phase === 'committed' || transfer.phase === 'published') {
    fragments = frames.map((frame) =>
      Object.freeze({
        data: frame.data,
        ownershipTransfer: Object.freeze({
          ...transfer.identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          frameSeq: frame.seq,
          fragmentStartSu: 0,
          fragmentEndSu: frame.data.length,
          frameLengthSu: frame.data.length
        })
      })
    )
    if (emissionKey) {
      rememberRelayPtyOwnershipTransferEmission(transfer, {
        key: emissionKey,
        data,
        frames,
        fragments
      })
    }
  }
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    if (emissionKey && fragments) {
      forgetRelayPtyOwnershipTransferEmission(transfer, emissionKey)
    }
    state.histories.set(terminalId, previousHistory!)
    transfer.sourceOutputEndSeq = previousSourceOutputEndSeq!
    transfer.replayStartSeq = previousReplayStartSeq!
    throw error
  }
  if (transfer.phase === 'prepared') {
    return undefined
  }
  if (!fragments) {
    return undefined
  }
  const attachmentId = transfer.attachmentId
  if (!attachmentId) {
    throw new RelayPtyOwnershipTransferError(
      'stale-attachment',
      'post-commit output has no destination attachment'
    )
  }
  // Why: persist every sequence before fallible publication so retries cannot reuse it.
  for (const frame of frames) {
    state.options.publishDestinationOutput(transfer.identity, attachmentId, frame)
  }
  return Object.freeze(fragments)
}

function currentSourceMatchesTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  transfer: RelayPtyOwnershipTransferRecord
): boolean {
  const current = state.options.resolveSource(transfer.identity.terminalId)
  return Boolean(
    current &&
    current.terminalId === transfer.identity.terminalId &&
    current.incarnationId === transfer.identity.incarnationId &&
    current.ownerLease === transfer.identity.ownerLease &&
    current.sourceOwnerGeneration === transfer.identity.sourceOwnerGeneration
  )
}

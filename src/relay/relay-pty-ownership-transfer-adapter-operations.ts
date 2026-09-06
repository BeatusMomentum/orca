import {
  parsePtyOwnershipTransferCommitRequest,
  parsePtyOwnershipTransferPrepareRequest,
  parsePtyOwnershipTransferPublishRequest,
  parsePtyOwnershipTransferReplayRequest,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferPrepareRequest,
  type PtyOwnershipTransferCommitResult,
  type PtyOwnershipTransferPrepareResult,
  type PtyOwnershipTransferPublishResult,
  type PtyOwnershipTransferReplayResult
} from '../shared/pty-ownership-transfer-wire'
import {
  MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
  PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION,
  type PtyOwnershipTransferCommitReceipt,
  type PtyOwnershipTransferPublicationReceipt
} from '../shared/pty-ownership-transfer-journal-contract'
import { samePtyOwnershipTransferSurfaceBinding } from '../shared/pty-ownership-transfer-surface-binding'
import { RelayPtyOwnershipTransferError } from './relay-pty-ownership-transfer-errors'
import {
  assertRelayPtyOwnershipTransferIdentity,
  requireRelayPtyOwnershipTransfer,
  type RelayPtyOwnershipTransferAdapterState,
  type RelayPtyOwnershipTransferAttachmentBinding,
  type RelayPtyOwnershipTransferRecord,
  emptyRelayPtyOwnershipTransferHistory
} from './relay-pty-ownership-transfer-adapter-state'
import {
  sameTransferCommitReceipt,
  sameTransferPublicationReceipt
} from './relay-pty-ownership-transfer-adapter-validation'
import { persistRelayPtyOwnershipTransfer } from './relay-pty-ownership-transfer-adapter-persistence'
import { requireAttachedLiveDestination } from './relay-pty-ownership-transfer-control'

export function prepareRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): PtyOwnershipTransferPrepareResult {
  const request = parsePtyOwnershipTransferPrepareRequest(value)
  const existing = state.transfers.get(request.bridgeId)
  if (existing) {
    assertRelayPtyOwnershipTransferIdentity(existing, request)
    assertSurfacePublicationNegotiation(existing, request)
    if (existing.phase === 'aborted') {
      throw new RelayPtyOwnershipTransferError(
        'invalid-phase',
        'an aborted ownership transfer cannot be reused'
      )
    }
    return prepareRelayPtyOwnershipTransferResult(existing)
  }
  if (state.transferByTerminal.has(request.terminalId)) {
    throw new RelayPtyOwnershipTransferError(
      'already-transferring',
      'the PTY already has an ownership transfer in progress'
    )
  }
  if (state.transfers.size >= MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
    throw new RelayPtyOwnershipTransferError(
      'already-transferring',
      'relay ownership transfer capacity is exhausted'
    )
  }
  const source = state.options.resolveSource(request.terminalId)
  if (
    !source ||
    source.terminalId !== request.terminalId ||
    source.incarnationId !== request.incarnationId ||
    source.ownerLease !== request.ownerLease ||
    source.sourceOwnerGeneration !== request.sourceOwnerGeneration
  ) {
    throw new RelayPtyOwnershipTransferError(
      source ? 'identity-mismatch' : 'not-found',
      source
        ? 'ownership transfer identity does not match the live source PTY'
        : 'source PTY is not available'
    )
  }
  const history = state.histories.get(request.terminalId) ?? emptyRelayPtyOwnershipTransferHistory()
  const transfer: RelayPtyOwnershipTransferRecord = {
    identity: Object.freeze(identityFromPrepareRequest(request)),
    phase: 'prepared',
    sourceOutputEndSeq: history.nextSeq - 1,
    replayStartSeq: history.frames[0]?.seq ?? history.nextSeq,
    ...(request.surfacePublication
      ? { surfacePublication: Object.freeze({ ...request.surfacePublication }) }
      : {}),
    acceptedInputIds: new Map(),
    acceptedControls: new Map(),
    observedEmissions: new Map()
  }
  const hadHistory = state.histories.has(request.terminalId)
  state.options.setInputFenced(request.terminalId, true)
  state.histories.set(request.terminalId, history)
  state.transfers.set(request.bridgeId, transfer)
  state.transferByTerminal.set(request.terminalId, request.bridgeId)
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    state.transfers.delete(request.bridgeId)
    state.transferByTerminal.delete(request.terminalId)
    if (!hadHistory) {
      state.histories.delete(request.terminalId)
    }
    state.options.setInputFenced(request.terminalId, false)
    throw error
  }
  return prepareRelayPtyOwnershipTransferResult(transfer)
}

export function replayRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown,
  binding?: RelayPtyOwnershipTransferAttachmentBinding
): PtyOwnershipTransferReplayResult {
  const request = parsePtyOwnershipTransferReplayRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  let phase: PtyOwnershipTransferReplayResult['phase']
  if (transfer.phase === 'committed' || transfer.phase === 'published') {
    phase = transfer.phase
    if (!request.attachmentId) {
      throw new RelayPtyOwnershipTransferError(
        'stale-attachment',
        'post-commit replay requires the current destination attachment'
      )
    }
    requireAttachedLiveDestination(state, transfer, request.attachmentId, binding)
  } else if (transfer.phase === 'prepared' && !request.attachmentId) {
    phase = 'prepared'
  } else {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      `cannot replay output while transfer is ${transfer.phase}`
    )
  }
  const history = state.histories.get(request.terminalId)
  const firstSeq = history?.frames[0]?.seq ?? history?.nextSeq ?? 1
  if (request.afterSeq < firstSeq - 1) {
    throw new RelayPtyOwnershipTransferError(
      'replay-unavailable',
      `replay before sequence ${firstSeq} is no longer retained`
    )
  }
  const frames = (history?.frames ?? []).filter((frame) => frame.seq > request.afterSeq)
  if (frames.some((frame) => frame.truncated)) {
    throw new RelayPtyOwnershipTransferError(
      'replay-unavailable',
      'the requested output checkpoint is not losslessly retained'
    )
  }
  transfer.sourceOutputEndSeq = history?.nextSeq ? history.nextSeq - 1 : 0
  transfer.replayStartSeq = firstSeq
  persistRelayPtyOwnershipTransfer(state, transfer)
  return Object.freeze({
    ...request,
    phase,
    frames: Object.freeze(frames.map((frame) => Object.freeze({ ...frame }))),
    sourceOutputEndSeq: transfer.sourceOutputEndSeq,
    replayStartSeq: firstSeq,
    ...(request.attachmentId ? { attachmentId: request.attachmentId } : {})
  })
}

export function commitRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): PtyOwnershipTransferCommitResult {
  const request = parsePtyOwnershipTransferCommitRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  if (transfer.phase === 'committed' || transfer.phase === 'published') {
    assertCommitReceipt(transfer, request.receipt)
    return Object.freeze({
      ...request,
      phase: 'committed',
      receipt: Object.freeze({ ...transfer.commitReceipt! })
    })
  }
  if (transfer.phase !== 'prepared') {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      `cannot commit transfer in ${transfer.phase}`
    )
  }
  const history = state.histories.get(request.terminalId)
  const sourceOutputEndSeq = history?.nextSeq ? history.nextSeq - 1 : 0
  const previousSourceOutputEndSeq = transfer.sourceOutputEndSeq
  transfer.sourceOutputEndSeq = sourceOutputEndSeq
  if (request.acceptedSourceEndSeq !== sourceOutputEndSeq) {
    throw new RelayPtyOwnershipTransferError(
      'destination-not-caught-up',
      `destination ends at ${request.acceptedSourceEndSeq}, source ends at ${sourceOutputEndSeq}`
    )
  }
  assertCommitReceipt(transfer, request.receipt)
  transfer.commitReceipt = Object.freeze({ ...request.receipt })
  transfer.phase = 'committed'
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    transfer.commitReceipt = undefined
    transfer.phase = 'prepared'
    transfer.sourceOutputEndSeq = previousSourceOutputEndSeq
    throw error
  }
  state.options.onCommitted?.(transfer.identity)
  return Object.freeze({
    ...request,
    phase: 'committed',
    receipt: Object.freeze({ ...transfer.commitReceipt })
  })
}

export function publishRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  value: unknown
): PtyOwnershipTransferPublishResult {
  const request = parsePtyOwnershipTransferPublishRequest(value)
  const transfer = requireRelayPtyOwnershipTransfer(state, request)
  if (transfer.phase === 'published') {
    assertPublicationReceipt(transfer, request.publicationReceipt)
    return Object.freeze({
      ...request,
      phase: 'published',
      publicationReceipt: Object.freeze({ ...transfer.publicationReceipt! })
    })
  }
  if (transfer.phase !== 'committed' || !transfer.commitReceipt) {
    throw new RelayPtyOwnershipTransferError(
      'invalid-phase',
      'destination publication requires a committed transfer'
    )
  }
  assertPublicationReceipt(transfer, request.publicationReceipt)
  transfer.publicationReceipt = Object.freeze({ ...request.publicationReceipt })
  transfer.phase = 'published'
  try {
    persistRelayPtyOwnershipTransfer(state, transfer)
  } catch (error) {
    transfer.publicationReceipt = undefined
    transfer.phase = 'committed'
    throw error
  }
  state.options.onPublished?.(transfer.identity)
  return Object.freeze({
    ...request,
    phase: 'published',
    publicationReceipt: Object.freeze({ ...transfer.publicationReceipt })
  })
}

function prepareRelayPtyOwnershipTransferResult(
  transfer: RelayPtyOwnershipTransferRecord
): PtyOwnershipTransferPrepareResult {
  return Object.freeze({
    ...transfer.identity,
    version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
    phase: 'prepared',
    sourceOutputEndSeq: transfer.sourceOutputEndSeq,
    replayStartSeq: transfer.replayStartSeq,
    ...(transfer.surfacePublication
      ? { surfacePublication: Object.freeze({ ...transfer.surfacePublication }) }
      : {})
  })
}

function assertCommitReceipt(
  transfer: RelayPtyOwnershipTransferRecord,
  receipt: PtyOwnershipTransferCommitReceipt
): void {
  if (
    receipt.bridgeId !== transfer.identity.bridgeId ||
    receipt.acceptedSourceEndSeq !== transfer.sourceOutputEndSeq ||
    !receipt.receiptId ||
    !Number.isFinite(Date.parse(receipt.committedAt)) ||
    (transfer.commitReceipt !== undefined &&
      !sameTransferCommitReceipt(transfer.commitReceipt, receipt))
  ) {
    throw new RelayPtyOwnershipTransferError(
      'receipt-invalid',
      'commit receipt does not prove this bridge and source cursor'
    )
  }
}

function assertPublicationReceipt(
  transfer: RelayPtyOwnershipTransferRecord,
  receipt: PtyOwnershipTransferPublicationReceipt
): void {
  if (
    receipt.version !== PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION ||
    receipt.bridgeId !== transfer.identity.bridgeId ||
    receipt.destinationRuntimeId !== transfer.identity.destinationRuntimeId ||
    !receipt.publicationReceiptId ||
    !Number.isFinite(Date.parse(receipt.publishedAt)) ||
    !transfer.commitReceipt ||
    !sameTransferCommitReceipt(receipt.commitReceipt, transfer.commitReceipt) ||
    (transfer.surfacePublication !== undefined &&
      !samePtyOwnershipTransferSurfaceBinding(
        receipt.surfaceBinding,
        transfer.surfacePublication.surfaceBinding
      )) ||
    (transfer.publicationReceipt !== undefined &&
      !sameTransferPublicationReceipt(transfer.publicationReceipt, receipt))
  ) {
    throw new RelayPtyOwnershipTransferError(
      'receipt-invalid',
      'publication receipt does not prove the committed destination'
    )
  }
}

function assertSurfacePublicationNegotiation(
  transfer: RelayPtyOwnershipTransferRecord,
  request: PtyOwnershipTransferPrepareRequest
): void {
  const expected = transfer.surfacePublication
  const actual = request.surfacePublication
  if (
    expected?.version !== actual?.version ||
    !samePtyOwnershipTransferSurfaceBinding(expected?.surfaceBinding, actual?.surfaceBinding)
  ) {
    throw new RelayPtyOwnershipTransferError(
      'identity-mismatch',
      'ownership transfer surface-publication negotiation changed'
    )
  }
}

function identityFromPrepareRequest(
  request: PtyOwnershipTransferPrepareRequest
): RelayPtyOwnershipTransferRecord['identity'] {
  return {
    bridgeId: request.bridgeId,
    terminalId: request.terminalId,
    incarnationId: request.incarnationId,
    ownerLease: request.ownerLease,
    sourceOwnerGeneration: request.sourceOwnerGeneration,
    destinationRuntimeId: request.destinationRuntimeId
  }
}

import {
  MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
  PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION
} from '../shared/pty-ownership-transfer-journal-contract'
import {
  parsePtyOwnershipTransferCommitReceipt,
  parsePtyOwnershipTransferPublicationReceipt,
  parsePtyOwnershipTransferWireIdentity,
  PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
  type PtyOwnershipTransferOutputFrame
} from '../shared/pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferExit,
  type PtyOwnershipTransferExit
} from '../shared/pty-ownership-transfer-control-wire'
import { parseOptionalPtyOwnershipTransferSurfacePublication } from '../shared/pty-ownership-transfer-surface-publication'
import { publicationReceiptMatchesPtyOwnershipTransfer } from '../shared/pty-ownership-transfer-receipt-validation'
import { samePtyOwnershipTransferSurfaceBinding } from '../shared/pty-ownership-transfer-surface-binding'
import { RELAY_PTY_OWNERSHIP_TRANSFER_RETRY_MEMO_MAX } from './relay-pty-ownership-transfer-adapter-state'
import type {
  RelayPtyOwnershipTransferAdapterState,
  RelayPtyOwnershipTransferEmissionMemo,
  RelayPtyOwnershipTransferOutputHistory,
  RelayPtyOwnershipTransferRecord
} from './relay-pty-ownership-transfer-adapter-state'
import type {
  RelayPtyOwnershipTransferControlRecord,
  RelayPtyOwnershipTransferDurableRecord
} from './relay-pty-ownership-transfer-adapter-contract'
import { MAX_OUTPUT_FRAME_BYTES } from './relay-pty-ownership-transfer-adapter-validation'
import { parseRelayPtyOwnershipTransferReconnectRoute } from './relay-pty-ownership-transfer-reconnect-route'

const DURABLE_RECORD_VERSION = 1

export function restoreRelayPtyOwnershipTransferState(
  state: RelayPtyOwnershipTransferAdapterState
): void {
  const records = state.options.store?.loadAll() ?? []
  if (records.length > MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS) {
    throw invalidJournal()
  }
  for (const value of records) {
    const restored = parseDurableRecord(value, state.replayBytes, state.inputIds)
    const bridgeId = restored.transfer.identity.bridgeId
    const terminalId = restored.transfer.identity.terminalId
    if (state.transfers.has(bridgeId) || state.transferByTerminal.has(terminalId)) {
      throw invalidJournal()
    }
    state.transfers.set(bridgeId, restored.transfer)
    state.transferByTerminal.set(terminalId, bridgeId)
    state.histories.set(terminalId, restored.history)
  }
  for (const transfer of state.transfers.values()) {
    if (transfer.phase !== 'aborted') {
      // A relay may restore its journal before PTY revive; defer fencing until the source exists.
      const source = state.options.resolveSource(transfer.identity.terminalId)
      if (source?.incarnationId === transfer.identity.incarnationId) {
        state.options.setInputFenced(transfer.identity.terminalId, true)
      }
    }
  }
}

export function persistRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  transfer: RelayPtyOwnershipTransferRecord
): void {
  const store = state.options.store
  if (!store) {
    return
  }
  const history = state.histories.get(transfer.identity.terminalId)
  if (!history) {
    throw invalidJournal()
  }
  store.save(serializeDurableRecord(transfer, history, state.replayBytes))
}

export function removePersistedRelayPtyOwnershipTransfer(
  state: RelayPtyOwnershipTransferAdapterState,
  bridgeId: string
): void {
  state.options.store?.remove(bridgeId)
}

function serializeDurableRecord(
  transfer: RelayPtyOwnershipTransferRecord,
  history: RelayPtyOwnershipTransferOutputHistory,
  replayBytes: number
): RelayPtyOwnershipTransferDurableRecord {
  const observedEmissions = serializeObservedEmissions(transfer, history, replayBytes)
  return {
    version: DURABLE_RECORD_VERSION,
    identity: structuredClone(transfer.identity),
    phase: transfer.phase,
    sourceOutputEndSeq: transfer.sourceOutputEndSeq,
    replayStartSeq: transfer.replayStartSeq,
    history: {
      nextSeq: history.nextSeq,
      frames: structuredClone(history.frames)
    },
    ...(observedEmissions.length > 0 ? { observedEmissions } : {}),
    acceptedInputs: [...transfer.acceptedInputIds].map(([inputId, data]) => ({ inputId, data })),
    acceptedControls: [...transfer.acceptedControls].map(
      ([controlId, { serializedControl, outcome }]) => ({
        controlId,
        serializedControl,
        outcome
      })
    ),
    ...(transfer.reconnectRoute
      ? { reconnectRoute: structuredClone(transfer.reconnectRoute) }
      : {}),
    ...(transfer.exit ? { exit: structuredClone(transfer.exit) } : {}),
    ...(transfer.surfacePublication
      ? { surfacePublication: structuredClone(transfer.surfacePublication) }
      : {}),
    ...(transfer.commitReceipt ? { commitReceipt: structuredClone(transfer.commitReceipt) } : {}),
    ...(transfer.publicationReceipt
      ? { publicationReceipt: structuredClone(transfer.publicationReceipt) }
      : {})
  }
}

function parseDurableRecord(
  value: unknown,
  replayBytes: number,
  inputIds: number
): Readonly<{
  transfer: RelayPtyOwnershipTransferRecord
  history: RelayPtyOwnershipTransferOutputHistory
}> {
  const record = requireRecord(value)
  if (record.version !== DURABLE_RECORD_VERSION || !validPhase(record.phase)) {
    throw invalidJournal()
  }
  let identity
  try {
    identity = parsePtyOwnershipTransferWireIdentity(record.identity)
  } catch (error) {
    throw new Error('pty_ownership_transfer_relay_journal_invalid', { cause: error })
  }
  const sourceOutputEndSeq = sequence(record.sourceOutputEndSeq)
  const replayStartSeq = positiveSequence(record.replayStartSeq)
  const history = parseHistory(record.history, replayBytes)
  if (
    sourceOutputEndSeq !== history.nextSeq - 1 ||
    replayStartSeq !== (history.frames[0]?.seq ?? history.nextSeq)
  ) {
    throw invalidJournal()
  }
  const acceptedInputIds = parseAcceptedInputs(record.acceptedInputs, inputIds)
  const acceptedControls = parseAcceptedControls(record.acceptedControls, inputIds)
  const reconnectRoute = parseRelayPtyOwnershipTransferReconnectRoute(
    record.reconnectRoute,
    identity
  )
  const observedEmissions = parseObservedEmissions(
    record.observedEmissions,
    history,
    identity,
    replayBytes
  )
  const exit = parseExit(record.exit)
  let surfacePublication
  let commitReceipt
  let publicationReceipt
  try {
    surfacePublication = parseOptionalPtyOwnershipTransferSurfacePublication(
      record.surfacePublication
    )
    commitReceipt = optionalCommitReceipt(record.commitReceipt)
    publicationReceipt = optionalPublicationReceipt(record.publicationReceipt)
  } catch (error) {
    throw new Error('pty_ownership_transfer_relay_journal_invalid', { cause: error })
  }
  assertPhaseEvidence(
    record.phase,
    identity,
    sourceOutputEndSeq,
    acceptedInputIds,
    commitReceipt,
    publicationReceipt
  )
  if (
    publicationReceipt &&
    (!commitReceipt ||
      publicationReceipt.version !== PTY_OWNERSHIP_TRANSFER_PUBLICATION_RECEIPT_VERSION ||
      !publicationReceiptMatchesPtyOwnershipTransfer(publicationReceipt, identity, commitReceipt))
  ) {
    throw invalidJournal()
  }
  if (
    surfacePublication &&
    publicationReceipt &&
    !samePtyOwnershipTransferSurfaceBinding(
      surfacePublication.surfaceBinding,
      publicationReceipt.surfaceBinding
    )
  ) {
    throw invalidJournal()
  }
  return {
    transfer: {
      identity: Object.freeze(identity),
      phase: record.phase,
      sourceOutputEndSeq,
      replayStartSeq,
      acceptedInputIds,
      acceptedControls,
      observedEmissions,
      ...(reconnectRoute ? { reconnectRoute } : {}),
      ...(exit ? { exit } : {}),
      ...(surfacePublication ? { surfacePublication } : {}),
      ...(commitReceipt ? { commitReceipt } : {}),
      ...(publicationReceipt ? { publicationReceipt } : {})
    },
    history
  }
}

function serializeObservedEmissions(
  transfer: RelayPtyOwnershipTransferRecord,
  history: RelayPtyOwnershipTransferOutputHistory,
  replayBytes: number
): readonly Readonly<{
  key: string
  data: string
  frames: readonly PtyOwnershipTransferOutputFrame[]
}>[] {
  const retained = new Map(history.frames.map((frame) => [frame.seq, frame]))
  let bytes = 0
  const result: {
    key: string
    data: string
    frames: readonly PtyOwnershipTransferOutputFrame[]
  }[] = []
  for (const memo of transfer.observedEmissions.values()) {
    const dataBytes = Buffer.byteLength(memo.data, 'utf8')
    if (
      !memo.key ||
      !memo.data ||
      dataBytes > replayBytes ||
      bytes + dataBytes > replayBytes ||
      memo.frames.length === 0 ||
      memo.frames.some((frame) => {
        const retainedFrame = retained.get(frame.seq)
        return !retainedFrame || retainedFrame.data !== frame.data || frame.truncated === true
      })
    ) {
      continue
    }
    result.push({ key: memo.key, data: memo.data, frames: structuredClone(memo.frames) })
    bytes += dataBytes
    if (result.length >= RELAY_PTY_OWNERSHIP_TRANSFER_RETRY_MEMO_MAX) {
      break
    }
  }
  return result
}

function parseObservedEmissions(
  value: unknown,
  history: RelayPtyOwnershipTransferOutputHistory,
  identity: RelayPtyOwnershipTransferRecord['identity'],
  replayBytes: number
): Map<string, RelayPtyOwnershipTransferEmissionMemo> {
  if (value === undefined) {
    return new Map()
  }
  if (!Array.isArray(value) || value.length > RELAY_PTY_OWNERSHIP_TRANSFER_RETRY_MEMO_MAX) {
    throw invalidJournal()
  }
  const retained = new Map(history.frames.map((frame) => [frame.seq, frame]))
  const result = new Map<string, RelayPtyOwnershipTransferEmissionMemo>()
  let bytes = 0
  for (const candidate of value) {
    const record = requireRecord(candidate)
    if (
      typeof record.key !== 'string' ||
      record.key.length === 0 ||
      record.key.length > 256 ||
      typeof record.data !== 'string' ||
      record.data.length === 0 ||
      result.has(record.key) ||
      !Array.isArray(record.frames) ||
      record.frames.length === 0
    ) {
      throw invalidJournal()
    }
    const frames = parseMemoFrames(record.frames, retained, record.data)
    const dataBytes = Buffer.byteLength(record.data, 'utf8')
    if (dataBytes > replayBytes || bytes + dataBytes > replayBytes) {
      throw invalidJournal()
    }
    const fragments = frames.map((frame) =>
      Object.freeze({
        data: frame.data,
        ownershipTransfer: Object.freeze({
          ...identity,
          version: PTY_OWNERSHIP_TRANSFER_WIRE_VERSION,
          frameSeq: frame.seq,
          fragmentStartSu: 0,
          fragmentEndSu: frame.data.length,
          frameLengthSu: frame.data.length
        })
      })
    )
    result.set(record.key, {
      key: record.key,
      data: record.data,
      frames: Object.freeze(frames),
      fragments: Object.freeze(fragments)
    })
    bytes += dataBytes
  }
  return result
}

function parseMemoFrames(
  value: readonly unknown[],
  retained: ReadonlyMap<number, PtyOwnershipTransferOutputFrame>,
  data: string
): PtyOwnershipTransferOutputFrame[] {
  const frames: PtyOwnershipTransferOutputFrame[] = []
  let expected: number | undefined
  let concatenated = ''
  for (const candidate of value) {
    const record = requireRecord(candidate)
    const seq = positiveSequence(record.seq)
    if (
      typeof record.data !== 'string' ||
      record.data.length === 0 ||
      record.truncated !== undefined ||
      (expected !== undefined && seq !== expected) ||
      retained.get(seq)?.data !== record.data
    ) {
      throw invalidJournal()
    }
    const frame = Object.freeze({ seq, data: record.data })
    frames.push(frame)
    concatenated += record.data
    expected = seq + 1
  }
  if (concatenated !== data) {
    throw invalidJournal()
  }
  return frames
}

function parseAcceptedControls(
  value: unknown,
  maximum: number
): RelayPtyOwnershipTransferRecord['acceptedControls'] {
  if (value === undefined) {
    return new Map()
  }
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidJournal()
  }
  const accepted = new Map<string, RelayPtyOwnershipTransferControlRecord>()
  for (const entryValue of value) {
    const entry = requireRecord(entryValue)
    if (
      typeof entry.controlId !== 'string' ||
      entry.controlId.length === 0 ||
      typeof entry.serializedControl !== 'string' ||
      (entry.outcome !== 'applied' && entry.outcome !== 'unverifiable') ||
      accepted.has(entry.controlId)
    ) {
      throw invalidJournal()
    }
    accepted.set(entry.controlId, {
      serializedControl: entry.serializedControl,
      outcome: entry.outcome
    })
  }
  return accepted
}

function parseExit(value: unknown): PtyOwnershipTransferExit | undefined {
  if (value === undefined) {
    return undefined
  }
  try {
    return parsePtyOwnershipTransferExit(value)
  } catch {
    throw invalidJournal()
  }
}

function parseHistory(value: unknown, replayBytes: number): RelayPtyOwnershipTransferOutputHistory {
  const record = requireRecord(value)
  const nextSeq = positiveSequence(record.nextSeq)
  if (!Array.isArray(record.frames)) {
    throw invalidJournal()
  }
  let retainedBytes = 0
  let previousSeq: number | undefined
  const frames: PtyOwnershipTransferOutputFrame[] = record.frames.map((value) => {
    const frame = requireRecord(value)
    const seq = positiveSequence(frame.seq)
    if (
      typeof frame.data !== 'string' ||
      frame.data.length === 0 ||
      frame.truncated !== undefined ||
      (previousSeq !== undefined && seq !== previousSeq + 1)
    ) {
      throw invalidJournal()
    }
    const bytes = Buffer.byteLength(frame.data, 'utf8')
    if (bytes > MAX_OUTPUT_FRAME_BYTES) {
      throw invalidJournal()
    }
    retainedBytes += bytes
    previousSeq = seq
    return Object.freeze({ seq, data: frame.data })
  })
  if (retainedBytes > replayBytes || (frames.length > 0 && frames.at(-1)!.seq !== nextSeq - 1)) {
    throw invalidJournal()
  }
  return { nextSeq, retainedBytes, frames }
}

function parseAcceptedInputs(value: unknown, maximum: number): Map<string, string> {
  if (value === undefined) {
    return new Map()
  }
  if (!Array.isArray(value) || value.length > maximum) {
    throw invalidJournal()
  }
  const accepted = new Map<string, string>()
  for (const entryValue of value) {
    const entry = requireRecord(entryValue)
    if (
      typeof entry.inputId !== 'string' ||
      entry.inputId.length === 0 ||
      typeof entry.data !== 'string' ||
      accepted.has(entry.inputId)
    ) {
      throw invalidJournal()
    }
    accepted.set(entry.inputId, entry.data)
  }
  return accepted
}

function assertPhaseEvidence(
  phase: RelayPtyOwnershipTransferRecord['phase'],
  identity: RelayPtyOwnershipTransferRecord['identity'],
  sourceOutputEndSeq: number,
  acceptedInputs: ReadonlyMap<string, string>,
  commitReceipt: RelayPtyOwnershipTransferRecord['commitReceipt'],
  publicationReceipt: RelayPtyOwnershipTransferRecord['publicationReceipt']
): void {
  const committed = phase === 'committed' || phase === 'published'
  if (
    committed !== Boolean(commitReceipt) ||
    (phase === 'published') !== Boolean(publicationReceipt) ||
    (!committed && acceptedInputs.size > 0) ||
    (commitReceipt !== undefined &&
      (commitReceipt.bridgeId !== identity.bridgeId ||
        commitReceipt.acceptedSourceEndSeq > sourceOutputEndSeq))
  ) {
    throw invalidJournal()
  }
}

function optionalCommitReceipt(value: unknown) {
  return value === undefined ? undefined : parsePtyOwnershipTransferCommitReceipt(value)
}

function optionalPublicationReceipt(value: unknown) {
  return value === undefined ? undefined : parsePtyOwnershipTransferPublicationReceipt(value)
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidJournal()
  }
  return value as Record<string, unknown>
}

function sequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw invalidJournal()
  }
  return Number(value)
}

function positiveSequence(value: unknown): number {
  const parsed = sequence(value)
  if (parsed === 0) {
    throw invalidJournal()
  }
  return parsed
}

function validPhase(value: unknown): value is RelayPtyOwnershipTransferRecord['phase'] {
  return (
    value === 'prepared' || value === 'committed' || value === 'published' || value === 'aborted'
  )
}

function invalidJournal(): Error {
  return new Error('pty_ownership_transfer_relay_journal_invalid')
}

import { PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES } from '../../../shared/pty-ownership-transfer-destination-adapter'
import type { PtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-journal'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferOutputFrame
} from '../../../shared/pty-ownership-transfer-wire'

export type PtyOwnershipTransferOutputOutboxRecord = {
  version: 1
  identity: PtyOwnershipTransferIdentity
  baseEndSeq: number
  acknowledgedEndSeq: number
  frames: PtyOwnershipTransferOutputFrame[]
  modelCheckpoints: PtyOwnershipTransferOutputModelCheckpoint[]
}

/** Durable proof that one transfer frame fragment was admitted to the host model. */
export type PtyOwnershipTransferOutputModelCheckpoint = {
  ptyId: string
  frameSeq: number
  fragmentStartSu: number
  fragmentEndSu: number
  frameLengthSu: number
  data: string
  modelSequenceEnd: number
}

export const MAX_PTY_OWNERSHIP_TRANSFER_OUTPUT_MODEL_CHECKPOINTS = 4_096

export type PtyOwnershipTransferDestinationOutputSnapshot = Readonly<{
  identity: PtyOwnershipTransferIdentity
  baseEndSeq: number
  acknowledgedEndSeq: number
  acceptedEndSeq: number
  pendingBytes: number
  pendingFrames: readonly PtyOwnershipTransferOutputFrame[]
}>

export function parseOutputOutboxRecord(
  value: unknown,
  expectedIdentity: PtyOwnershipTransferIdentity,
  limits: Readonly<{ maxBytes: number; maxFrames: number }>
): PtyOwnershipTransferOutputOutboxRecord {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error('pty_ownership_transfer_output_outbox_version_invalid')
  }
  const identity = parsePtyOwnershipTransferWireIdentity(value.identity)
  if (!sameIdentity(identity, expectedIdentity)) {
    throw new Error('pty_ownership_transfer_output_outbox_identity_conflict')
  }
  const baseEndSeq = requireSequence(value.baseEndSeq)
  const acknowledgedEndSeq = requireSequence(value.acknowledgedEndSeq)
  if (
    acknowledgedEndSeq < baseEndSeq ||
    !Array.isArray(value.frames) ||
    value.frames.length > limits.maxFrames ||
    (value.modelCheckpoints !== undefined &&
      (!Array.isArray(value.modelCheckpoints) ||
        value.modelCheckpoints.length > MAX_PTY_OWNERSHIP_TRANSFER_OUTPUT_MODEL_CHECKPOINTS))
  ) {
    throw new Error('pty_ownership_transfer_output_outbox_cursor_invalid')
  }
  const frames: PtyOwnershipTransferOutputFrame[] = []
  let previousSeq = acknowledgedEndSeq
  let bytes = 0
  for (const candidate of value.frames) {
    const frame = validateOutputOutboxFrame(candidate)
    bytes += Buffer.byteLength(frame.data, 'utf8')
    if (frame.seq <= previousSeq || bytes > limits.maxBytes) {
      throw new Error('pty_ownership_transfer_output_outbox_frames_invalid')
    }
    previousSeq = frame.seq
    frames.push(frame)
  }
  const modelCheckpoints = parseModelCheckpoints(value.modelCheckpoints)
  return { version: 1, identity, baseEndSeq, acknowledgedEndSeq, frames, modelCheckpoints }
}

function parseModelCheckpoints(value: unknown): PtyOwnershipTransferOutputModelCheckpoint[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new Error('pty_ownership_transfer_output_model_checkpoints_invalid')
  }
  const checkpoints: PtyOwnershipTransferOutputModelCheckpoint[] = []
  const seen = new Set<string>()
  let bytes = 0
  for (const candidate of value) {
    if (!isRecord(candidate)) {
      throw new Error('pty_ownership_transfer_output_model_checkpoint_invalid')
    }
    const ptyId = candidate.ptyId
    const frameSeq = candidate.frameSeq
    const fragmentStartSu = candidate.fragmentStartSu
    const fragmentEndSu = candidate.fragmentEndSu
    const frameLengthSu = candidate.frameLengthSu
    const data = candidate.data
    const modelSequenceEnd = candidate.modelSequenceEnd
    if (
      typeof ptyId !== 'string' ||
      ptyId.length === 0 ||
      ptyId.length > 512 ||
      !positiveSequence(frameSeq) ||
      !nonNegativeSequence(fragmentStartSu) ||
      !positiveSequence(fragmentEndSu) ||
      !positiveSequence(frameLengthSu) ||
      fragmentEndSu > frameLengthSu ||
      fragmentEndSu - fragmentStartSu <= 0 ||
      typeof data !== 'string' ||
      data.length !== fragmentEndSu - fragmentStartSu ||
      !positiveSequence(modelSequenceEnd)
    ) {
      throw new Error('pty_ownership_transfer_output_model_checkpoint_invalid')
    }
    const key = `${frameSeq}\0${fragmentStartSu}`
    if (seen.has(key)) {
      throw new Error('pty_ownership_transfer_output_model_checkpoint_duplicate')
    }
    seen.add(key)
    bytes += Buffer.byteLength(data, 'utf8')
    if (bytes > 4 * 1024 * 1024) {
      throw new Error('pty_ownership_transfer_output_model_checkpoints_too_large')
    }
    checkpoints.push({
      ptyId,
      frameSeq: Number(frameSeq),
      fragmentStartSu: Number(fragmentStartSu),
      fragmentEndSu: Number(fragmentEndSu),
      frameLengthSu: Number(frameLengthSu),
      data,
      modelSequenceEnd: Number(modelSequenceEnd)
    })
  }
  return checkpoints
}

export function validateOutputModelCheckpoint(
  value: unknown
): PtyOwnershipTransferOutputModelCheckpoint {
  const parsed = parseModelCheckpoints([value])
  return parsed[0]
}

export function validateOutputOutboxFrame(value: unknown): PtyOwnershipTransferOutputFrame {
  if (!isRecord(value) || !Number.isSafeInteger(value.seq) || Number(value.seq) <= 0) {
    throw new Error('pty_ownership_transfer_output_outbox_frame_invalid')
  }
  const data = value.data
  const bytes = typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : 0
  if (
    typeof data !== 'string' ||
    data.length === 0 ||
    bytes > PTY_OWNERSHIP_TRANSFER_DESTINATION_MAX_FRAME_BYTES ||
    value.truncated !== undefined
  ) {
    throw new Error('pty_ownership_transfer_output_outbox_frame_invalid')
  }
  return { seq: Number(value.seq), data }
}

export function snapshotOutputOutboxRecord(
  record: PtyOwnershipTransferOutputOutboxRecord
): PtyOwnershipTransferDestinationOutputSnapshot {
  const pendingFrames = Object.freeze(record.frames.map((frame) => Object.freeze({ ...frame })))
  return Object.freeze({
    identity: Object.freeze({ ...record.identity }),
    baseEndSeq: record.baseEndSeq,
    acknowledgedEndSeq: record.acknowledgedEndSeq,
    acceptedEndSeq: pendingFrames.at(-1)?.seq ?? record.acknowledgedEndSeq,
    pendingBytes: frameBytes(pendingFrames),
    pendingFrames
  })
}

export function frameBytes(frames: readonly PtyOwnershipTransferOutputFrame[]): number {
  return frames.reduce((total, frame) => total + Buffer.byteLength(frame.data, 'utf8'), 0)
}

function sameIdentity(
  left: PtyOwnershipTransferIdentity,
  right: PtyOwnershipTransferIdentity
): boolean {
  return (
    left.bridgeId === right.bridgeId &&
    left.terminalId === right.terminalId &&
    left.incarnationId === right.incarnationId &&
    left.ownerLease === right.ownerLease &&
    left.sourceOwnerGeneration === right.sourceOwnerGeneration &&
    left.destinationRuntimeId === right.destinationRuntimeId
  )
}

function requireSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('pty_ownership_transfer_output_outbox_sequence_invalid')
  }
  return Number(value)
}

function positiveSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonNegativeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
  type PtyOwnershipTransferIdentity
} from '../../../shared/pty-ownership-transfer-journal'
import {
  parsePtyOwnershipTransferWireIdentity,
  type PtyOwnershipTransferOutputFrame
} from '../../../shared/pty-ownership-transfer-wire'
import { durableWriteTempPath, writeFileDurableSync } from '../../durable-file-write'
import {
  frameBytes,
  parseOutputOutboxRecord,
  snapshotOutputOutboxRecord,
  validateOutputModelCheckpoint,
  validateOutputOutboxFrame,
  type PtyOwnershipTransferOutputModelCheckpoint,
  type PtyOwnershipTransferDestinationOutputSnapshot,
  type PtyOwnershipTransferOutputOutboxRecord
} from './pty-ownership-transfer-destination-output-outbox-record'

export type { PtyOwnershipTransferDestinationOutputSnapshot } from './pty-ownership-transfer-destination-output-outbox-record'

export const PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_BYTES = 4 * 1024 * 1024
export const PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_FRAMES = 65_536
const OUTPUT_OUTBOX_FILE_MAX_BYTES = 32 * 1024 * 1024
type OutputOutboxOptions = Readonly<{
  directory: string
  maxBytes?: number
  maxFrames?: number
  maxRecords?: number
}>

/** Crash-safe queue between credited SSH output and the durable destination terminal surface. */
export class PtyOwnershipTransferDestinationOutputOutbox {
  private readonly maxBytes: number
  private readonly maxFrames: number
  private readonly maxRecords: number

  constructor(private readonly options: OutputOutboxOptions) {
    this.maxBytes = boundedPositive(
      options.maxBytes ?? PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_BYTES,
      PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_BYTES
    )
    this.maxFrames = boundedPositive(
      options.maxFrames ?? PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_FRAMES,
      PTY_OWNERSHIP_TRANSFER_OUTPUT_OUTBOX_MAX_FRAMES
    )
    this.maxRecords = boundedPositive(
      options.maxRecords ?? MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS,
      MAX_PTY_OWNERSHIP_TRANSFER_JOURNALS
    )
  }

  open(
    identity: PtyOwnershipTransferIdentity,
    baseEndSeq: number
  ): PtyOwnershipTransferDestinationOutputSnapshot {
    const validatedIdentity = parsePtyOwnershipTransferWireIdentity(identity)
    requireSequence(baseEndSeq)
    const existing = this.loadRecord(validatedIdentity)
    if (existing) {
      if (existing.baseEndSeq !== baseEndSeq) {
        throw new Error('pty_ownership_transfer_output_outbox_base_conflict')
      }
      return snapshotOutputOutboxRecord(existing)
    }
    this.requireCapacity()
    const record: PtyOwnershipTransferOutputOutboxRecord = {
      version: 1,
      identity: validatedIdentity,
      baseEndSeq,
      acknowledgedEndSeq: baseEndSeq,
      frames: [],
      modelCheckpoints: []
    }
    this.persist(record)
    return snapshotOutputOutboxRecord(record)
  }

  enqueue(
    identity: PtyOwnershipTransferIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): 'accepted' | 'duplicate' | 'acknowledged' {
    return this.insert(identity, frame, false)
  }

  /** Durably retain a future live frame while attachment recovery fills an earlier gap. */
  stage(
    identity: PtyOwnershipTransferIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): 'accepted' | 'duplicate' | 'acknowledged' {
    return this.insert(identity, frame, true)
  }

  private insert(
    identity: PtyOwnershipTransferIdentity,
    frame: PtyOwnershipTransferOutputFrame,
    allowGap: boolean
  ): 'accepted' | 'duplicate' | 'acknowledged' {
    const record = this.requireRecord(identity)
    const validated = validateOutputOutboxFrame(frame)
    if (validated.seq <= record.acknowledgedEndSeq) {
      return 'acknowledged'
    }
    const existingIndex = record.frames.findIndex((candidate) => candidate.seq >= validated.seq)
    const existing = existingIndex === -1 ? undefined : record.frames[existingIndex]
    if (existing?.seq === validated.seq) {
      if (!sameFrame(existing, validated)) {
        throw new Error('pty_ownership_transfer_output_outbox_frame_conflict')
      }
      return 'duplicate'
    }
    if (!allowGap && validated.seq !== contiguousEndSeq(record) + 1) {
      throw new Error('pty_ownership_transfer_output_outbox_gap')
    }
    const nextBytes = frameBytes(record.frames) + Buffer.byteLength(validated.data, 'utf8')
    if (record.frames.length >= this.maxFrames || nextBytes > this.maxBytes) {
      throw new Error('pty_ownership_transfer_output_outbox_backpressure')
    }
    if (existingIndex === -1) {
      record.frames.push(validated)
    } else {
      record.frames.splice(existingIndex, 0, validated)
    }
    this.persist(record)
    return 'accepted'
  }

  acknowledge(
    identity: PtyOwnershipTransferIdentity,
    throughSeq: number
  ): PtyOwnershipTransferDestinationOutputSnapshot {
    const record = this.requireRecord(identity)
    requireSequence(throughSeq)
    if (throughSeq <= record.acknowledgedEndSeq) {
      return snapshotOutputOutboxRecord(record)
    }
    if (throughSeq > contiguousEndSeq(record)) {
      throw new Error('pty_ownership_transfer_output_outbox_ack_ahead')
    }
    record.frames = record.frames.filter((frame) => frame.seq > throughSeq)
    record.modelCheckpoints = record.modelCheckpoints.filter(
      (checkpoint) => checkpoint.frameSeq > throughSeq
    )
    record.acknowledgedEndSeq = throughSeq
    this.persist(record)
    return snapshotOutputOutboxRecord(record)
  }

  /** Advance the durable baseline after replayed frames are committed at the destination. */
  markCommittedThrough(
    identity: PtyOwnershipTransferIdentity,
    throughSeq: number
  ): PtyOwnershipTransferDestinationOutputSnapshot {
    const record = this.requireRecord(identity)
    requireSequence(throughSeq)
    if (throughSeq < record.acknowledgedEndSeq) {
      throw new Error('pty_ownership_transfer_output_outbox_ack_regressed')
    }
    if (record.frames.length > 0 && throughSeq > record.acknowledgedEndSeq) {
      throw new Error('pty_ownership_transfer_output_outbox_pending_baseline')
    }
    if (throughSeq === record.acknowledgedEndSeq) {
      return snapshotOutputOutboxRecord(record)
    }
    record.acknowledgedEndSeq = throughSeq
    record.modelCheckpoints = record.modelCheckpoints.filter(
      (checkpoint) => checkpoint.frameSeq > throughSeq
    )
    this.persist(record)
    return snapshotOutputOutboxRecord(record)
  }

  load(
    identity: PtyOwnershipTransferIdentity
  ): PtyOwnershipTransferDestinationOutputSnapshot | null {
    const validated = parsePtyOwnershipTransferWireIdentity(identity)
    const record = this.loadRecord(validated)
    return record ? snapshotOutputOutboxRecord(record) : null
  }

  recordModelCheckpoint(
    identity: PtyOwnershipTransferIdentity,
    checkpoint: PtyOwnershipTransferOutputModelCheckpoint
  ): void {
    const record = this.requireRecord(identity)
    const validated = validateOutputModelCheckpoint(checkpoint)
    const existing = record.modelCheckpoints.find(
      (candidate) =>
        candidate.frameSeq === validated.frameSeq &&
        candidate.fragmentStartSu === validated.fragmentStartSu
    )
    if (existing) {
      if (!sameModelCheckpoint(existing, validated)) {
        throw new Error('pty_ownership_transfer_output_model_checkpoint_conflict')
      }
      return
    }
    if (record.modelCheckpoints.length >= 4_096) {
      throw new Error('pty_ownership_transfer_output_model_checkpoint_capacity')
    }
    record.modelCheckpoints.push({ ...validated })
    this.persist(record)
  }

  loadModelCheckpoints(
    identity: PtyOwnershipTransferIdentity
  ): readonly PtyOwnershipTransferOutputModelCheckpoint[] {
    return this.requireRecord(identity).modelCheckpoints.map((checkpoint) => ({ ...checkpoint }))
  }

  private loadRecord(
    identity: PtyOwnershipTransferIdentity
  ): PtyOwnershipTransferOutputOutboxRecord | null {
    const path = this.recordPath(identity.bridgeId)
    if (!existsSync(path)) {
      return null
    }
    try {
      const size = statSync(path).size
      if (size <= 0 || size > OUTPUT_OUTBOX_FILE_MAX_BYTES) {
        throw new Error('pty_ownership_transfer_output_outbox_file_size_invalid')
      }
      return parseOutputOutboxRecord(JSON.parse(readFileSync(path, 'utf8')) as unknown, identity, {
        maxBytes: this.maxBytes,
        maxFrames: this.maxFrames
      })
    } catch (error) {
      throw new Error('pty_ownership_transfer_output_outbox_invalid', { cause: error })
    }
  }

  private requireRecord(
    identity: PtyOwnershipTransferIdentity
  ): PtyOwnershipTransferOutputOutboxRecord {
    const validated = parsePtyOwnershipTransferWireIdentity(identity)
    const record = this.loadRecord(validated)
    if (!record) {
      throw new Error('pty_ownership_transfer_output_outbox_not_open')
    }
    return record
  }

  private persist(record: PtyOwnershipTransferOutputOutboxRecord): void {
    mkdirSync(this.options.directory, { recursive: true, mode: 0o700 })
    const path = this.recordPath(record.identity.bridgeId)
    writeFileDurableSync(durableWriteTempPath(path), path, `${JSON.stringify(record)}\n`)
  }

  private requireCapacity(): void {
    let records: string[] = []
    try {
      records = readdirSync(this.options.directory).filter((name) =>
        /^[a-f0-9]{64}\.json$/.test(name)
      )
    } catch (error) {
      if (!errorHasCode(error, 'ENOENT')) {
        throw error
      }
    }
    if (records.length >= this.maxRecords) {
      throw new Error('pty_ownership_transfer_output_outbox_record_capacity')
    }
  }

  private recordPath(bridgeId: string): string {
    return join(
      this.options.directory,
      `${createHash('sha256').update(bridgeId).digest('hex')}.json`
    )
  }
}

function contiguousEndSeq(record: PtyOwnershipTransferOutputOutboxRecord): number {
  let throughSeq = record.acknowledgedEndSeq
  for (const frame of record.frames) {
    if (frame.seq !== throughSeq + 1) {
      break
    }
    throughSeq = frame.seq
  }
  return throughSeq
}

function sameFrame(
  left: PtyOwnershipTransferOutputFrame,
  right: PtyOwnershipTransferOutputFrame
): boolean {
  return left.seq === right.seq && left.data === right.data && left.truncated === right.truncated
}

function sameModelCheckpoint(
  left: PtyOwnershipTransferOutputModelCheckpoint,
  right: PtyOwnershipTransferOutputModelCheckpoint
): boolean {
  return (
    left.ptyId === right.ptyId &&
    left.frameSeq === right.frameSeq &&
    left.fragmentStartSu === right.fragmentStartSu &&
    left.fragmentEndSu === right.fragmentEndSu &&
    left.frameLengthSu === right.frameLengthSu &&
    left.data === right.data &&
    left.modelSequenceEnd === right.modelSequenceEnd
  )
}

function requireSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error('pty_ownership_transfer_output_outbox_sequence_invalid')
  }
  return Number(value)
}

function boundedPositive(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new Error('pty_ownership_transfer_output_outbox_limit_invalid')
  }
  return value
}

function errorHasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

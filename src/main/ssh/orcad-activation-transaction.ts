import { z } from 'zod'
import {
  parseOrcadActivationRecord,
  serializeOrcadActivationRecord,
  type OrcadActivationRecord,
  type OrcadStateSnapshot
} from './orcad-activation-record'
import { isRemoteInstallVersion } from './remote-install-model'

export const ORCAD_ACTIVATION_TRANSACTION_FILENAME = 'transaction.json'
export const ORCAD_ACTIVATION_TRANSACTION_DIRNAME = '.orcad-activation-transaction'
export const ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION = 1

const RemoteVersionSchema = z
  .string()
  .refine(isRemoteInstallVersion, 'Expected a safe remote install version')
const SafeSnapshotNameSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9.+-]*$/u)
const TransactionBaseShape = {
  schemaVersion: z.literal(ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION),
  transactionId: z.uuid(),
  startedAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  recordBefore: z.unknown()
}

const TransactionSchema = z
  .discriminatedUnion('operation', [
    z.object({
      ...TransactionBaseShape,
      operation: z.literal('activate'),
      phase: z.enum(['prepared', 'incumbent-stopped', 'snapshot-captured', 'candidate-ready']),
      candidateVersion: RemoteVersionSchema,
      recordAfter: z.unknown().nullable(),
      snapshot: z.object({
        dirName: SafeSnapshotNameSchema,
        state: z.enum(['pending', 'captured', 'empty'])
      })
    }),
    z.object({
      ...TransactionBaseShape,
      operation: z.literal('rollback'),
      phase: z.enum([
        'prepared',
        'incumbent-stopped',
        'rescue-captured',
        'rollback-state-restored',
        'target-ready'
      ]),
      incumbentVersion: RemoteVersionSchema,
      targetVersion: RemoteVersionSchema,
      recordAfter: z.unknown(),
      rescue: z.object({
        dirName: SafeSnapshotNameSchema,
        state: z.enum(['pending', 'captured', 'empty'])
      })
    }),
    z.object({
      ...TransactionBaseShape,
      operation: z.literal('decommission'),
      phase: z.enum(['prepared', 'admission-fenced', 'process-exited']),
      activeVersion: RemoteVersionSchema,
      acceptedRecord: z.unknown(),
      recordAfter: z.unknown()
    })
  ])
  .superRefine((transaction, context) => {
    if (transaction.operation === 'activate') {
      const beforeSnapshot =
        transaction.phase === 'prepared' || transaction.phase === 'incumbent-stopped'
      if (beforeSnapshot && transaction.snapshot.state !== 'pending') {
        context.addIssue({ code: 'custom', message: 'Snapshot state advanced before its phase' })
      }
      if (!beforeSnapshot && transaction.snapshot.state === 'pending') {
        context.addIssue({ code: 'custom', message: 'Snapshot phase has no durable verdict' })
      }
      if ((transaction.phase === 'candidate-ready') !== (transaction.recordAfter !== null)) {
        context.addIssue({ code: 'custom', message: 'Committed record is inconsistent with phase' })
      }
      return
    }
    if (transaction.operation === 'rollback') {
      const beforeRescue =
        transaction.phase === 'prepared' || transaction.phase === 'incumbent-stopped'
      if (beforeRescue && transaction.rescue.state !== 'pending') {
        context.addIssue({ code: 'custom', message: 'Rescue state advanced before its phase' })
      }
      if (!beforeRescue && transaction.rescue.state === 'pending') {
        context.addIssue({
          code: 'custom',
          message: 'Rollback phase has no durable rescue verdict'
        })
      }
    }
  })

export type OrcadActivateTransaction = {
  schemaVersion: typeof ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION
  transactionId: string
  operation: 'activate'
  phase: 'prepared' | 'incumbent-stopped' | 'snapshot-captured' | 'candidate-ready'
  startedAt: string
  updatedAt: string
  candidateVersion: string
  recordBefore: OrcadActivationRecord
  recordAfter: OrcadActivationRecord | null
  snapshot: { dirName: string; state: 'pending' | 'captured' | 'empty' }
}

export type OrcadRollbackTransaction = {
  schemaVersion: typeof ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION
  transactionId: string
  operation: 'rollback'
  phase:
    | 'prepared'
    | 'incumbent-stopped'
    | 'rescue-captured'
    | 'rollback-state-restored'
    | 'target-ready'
  startedAt: string
  updatedAt: string
  incumbentVersion: string
  targetVersion: string
  recordBefore: OrcadActivationRecord
  recordAfter: OrcadActivationRecord
  rescue: { dirName: string; state: 'pending' | 'captured' | 'empty' }
}

export type OrcadDecommissionTransaction = {
  schemaVersion: typeof ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION
  transactionId: string
  operation: 'decommission'
  phase: 'prepared' | 'admission-fenced' | 'process-exited'
  startedAt: string
  updatedAt: string
  activeVersion: string
  recordBefore: OrcadActivationRecord
  acceptedRecord: OrcadActivationRecord
  recordAfter: OrcadActivationRecord
}

export type OrcadActivationTransaction =
  | OrcadActivateTransaction
  | OrcadRollbackTransaction
  | OrcadDecommissionTransaction

export type OrcadActivationTransactionReadResult =
  | { state: 'absent' }
  | { state: 'ok'; transaction: OrcadActivationTransaction }
  | { state: 'unreadable'; reason: string }

export type OrcadActivationRecoveryPlan =
  | {
      action: 'stabilize-committed'
      record: OrcadActivationRecord
    }
  | {
      action: 'restore-record-before'
      record: OrcadActivationRecord
      candidateVersion: string
      restoreSnapshot: boolean
      snapshot: OrcadActivateTransaction['snapshot']
    }
  | { action: 'refuse'; code: string; reason: string }

export function createOrcadActivationTransaction(options: {
  transactionId: string
  candidateVersion: string
  recordBefore: OrcadActivationRecord
  snapshotDirName: string
  now: Date
}): OrcadActivateTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'activate',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    candidateVersion: options.candidateVersion,
    recordBefore: options.recordBefore,
    recordAfter: null,
    snapshot: { dirName: options.snapshotDirName, state: 'pending' }
  }
}

export function createOrcadRollbackTransaction(options: {
  transactionId: string
  incumbentVersion: string
  targetVersion: string
  recordBefore: OrcadActivationRecord
  recordAfter: OrcadActivationRecord
  rescueDirName: string
  now: Date
}): OrcadRollbackTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'rollback',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    incumbentVersion: options.incumbentVersion,
    targetVersion: options.targetVersion,
    recordBefore: options.recordBefore,
    recordAfter: options.recordAfter,
    rescue: { dirName: options.rescueDirName, state: 'pending' }
  }
}

export function withOrcadRollbackPhase(
  transaction: OrcadRollbackTransaction,
  phase: 'incumbent-stopped' | 'rollback-state-restored' | 'target-ready',
  now: Date
): OrcadRollbackTransaction {
  return { ...transaction, phase, updatedAt: now.toISOString() }
}

export function withOrcadRollbackRescue(
  transaction: OrcadRollbackTransaction,
  state: 'captured' | 'empty',
  now: Date
): OrcadRollbackTransaction {
  return {
    ...transaction,
    phase: 'rescue-captured',
    updatedAt: now.toISOString(),
    rescue: { dirName: transaction.rescue.dirName, state }
  }
}

export function createOrcadDecommissionTransaction(options: {
  transactionId: string
  activeVersion: string
  recordBefore: OrcadActivationRecord
  acceptedRecord: OrcadActivationRecord
  recordAfter: OrcadActivationRecord
  now: Date
}): OrcadDecommissionTransaction {
  const timestamp = options.now.toISOString()
  return {
    schemaVersion: ORCAD_ACTIVATION_TRANSACTION_SCHEMA_VERSION,
    transactionId: options.transactionId,
    operation: 'decommission',
    phase: 'prepared',
    startedAt: timestamp,
    updatedAt: timestamp,
    activeVersion: options.activeVersion,
    recordBefore: options.recordBefore,
    acceptedRecord: options.acceptedRecord,
    recordAfter: options.recordAfter
  }
}

export function withOrcadDecommissionPhase(
  transaction: OrcadDecommissionTransaction,
  phase: 'admission-fenced' | 'process-exited',
  now: Date
): OrcadDecommissionTransaction {
  return { ...transaction, phase, updatedAt: now.toISOString() }
}

export function withOrcadActivationTransactionPhase(
  transaction: OrcadActivateTransaction,
  phase: 'incumbent-stopped',
  now: Date
): OrcadActivateTransaction {
  return { ...transaction, phase, updatedAt: now.toISOString() }
}

export function withOrcadActivationSnapshot(
  transaction: OrcadActivateTransaction,
  snapshot: OrcadStateSnapshot | null,
  now: Date
): OrcadActivateTransaction {
  return {
    ...transaction,
    phase: 'snapshot-captured',
    updatedAt: now.toISOString(),
    snapshot: {
      dirName: transaction.snapshot.dirName,
      state: snapshot ? 'captured' : 'empty'
    }
  }
}

export function withOrcadActivationCandidateReady(
  transaction: OrcadActivateTransaction,
  recordAfter: OrcadActivationRecord,
  now: Date
): OrcadActivateTransaction {
  return {
    ...transaction,
    phase: 'candidate-ready',
    updatedAt: now.toISOString(),
    recordAfter
  }
}

export function parseOrcadActivationTransaction(
  raw: string | null
): OrcadActivationTransactionReadResult {
  if (raw === null || raw.trim() === '') {
    return { state: 'absent' }
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    return unreadable(`transaction is not JSON: ${errorMessage(error)}`)
  }
  const parsed = TransactionSchema.safeParse(json)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = issue?.path.length ? issue.path.join('.') : 'transaction'
    return unreadable(`${path} is invalid: ${issue?.message ?? 'unknown shape'}`)
  }
  const recordBefore = parseNestedRecord(parsed.data.recordBefore, 'recordBefore')
  if (recordBefore.state === 'unreadable') {
    return recordBefore
  }
  if (parsed.data.operation === 'activate') {
    const recordAfter =
      parsed.data.recordAfter === null
        ? null
        : parseNestedRecord(parsed.data.recordAfter, 'recordAfter')
    if (recordAfter?.state === 'unreadable') {
      return recordAfter
    }
    if (recordAfter && recordAfter.record.active !== parsed.data.candidateVersion) {
      return unreadable('recordAfter does not activate candidateVersion')
    }
    return {
      state: 'ok',
      transaction: {
        ...parsed.data,
        recordBefore: recordBefore.record,
        recordAfter: recordAfter?.record ?? null
      }
    }
  }
  const recordAfter = parseNestedRecord(parsed.data.recordAfter, 'recordAfter')
  if (recordAfter.state === 'unreadable') {
    return recordAfter
  }
  if (parsed.data.operation === 'rollback') {
    if (
      recordBefore.record.active !== parsed.data.incumbentVersion ||
      recordBefore.record.previous !== parsed.data.targetVersion
    ) {
      return unreadable('rollback versions do not match recordBefore')
    }
    if (
      recordAfter.record.active !== parsed.data.targetVersion ||
      recordAfter.record.previous !== null ||
      recordAfter.record.snapshot !== null ||
      recordAfter.record.decommissioning
    ) {
      return unreadable('recordAfter is not a completed rollback record')
    }
    return {
      state: 'ok',
      transaction: {
        ...parsed.data,
        recordBefore: recordBefore.record,
        recordAfter: recordAfter.record
      }
    }
  }
  const acceptedRecord = parseNestedRecord(parsed.data.acceptedRecord, 'acceptedRecord')
  if (acceptedRecord.state === 'unreadable') {
    return acceptedRecord
  }
  if (
    recordBefore.record.active !== parsed.data.activeVersion ||
    acceptedRecord.record.active !== parsed.data.activeVersion ||
    acceptedRecord.record.decommissioning?.version !== parsed.data.activeVersion ||
    !sameOrcadActivationRecord(acceptedRecord.record, {
      ...recordBefore.record,
      decommissioning: acceptedRecord.record.decommissioning
    })
  ) {
    return unreadable('acceptedRecord is not the exact decommission transition')
  }
  if (
    recordAfter.record.active !== null ||
    recordAfter.record.previous !== parsed.data.activeVersion ||
    recordAfter.record.activatedAt !== null ||
    recordAfter.record.snapshot !== null ||
    recordAfter.record.decommissioning
  ) {
    return unreadable('recordAfter is not a completed decommission record')
  }
  return {
    state: 'ok',
    transaction: {
      ...parsed.data,
      recordBefore: recordBefore.record,
      acceptedRecord: acceptedRecord.record,
      recordAfter: recordAfter.record
    }
  }
}

export function serializeOrcadActivationTransaction(
  transaction: OrcadActivationTransaction
): string {
  return `${JSON.stringify(transaction, null, 2)}\n`
}

export function planOrcadActivationRecovery(
  transaction: OrcadActivateTransaction,
  currentRecord: OrcadActivationRecord
): OrcadActivationRecoveryPlan {
  if (
    transaction.recordAfter &&
    sameOrcadActivationRecord(currentRecord, transaction.recordAfter)
  ) {
    return { action: 'stabilize-committed', record: transaction.recordAfter }
  }
  if (!sameOrcadActivationRecord(currentRecord, transaction.recordBefore)) {
    return {
      action: 'refuse',
      code: 'orcad_recovery_activation_record_changed',
      reason:
        'The activation record matches neither side of the interrupted transaction. ' +
        'Preserving the activation fence for operator inspection.'
    }
  }
  return {
    action: 'restore-record-before',
    record: transaction.recordBefore,
    candidateVersion: transaction.candidateVersion,
    restoreSnapshot:
      transaction.phase === 'snapshot-captured' || transaction.phase === 'candidate-ready',
    snapshot: transaction.snapshot
  }
}

function parseNestedRecord(
  value: unknown,
  field: string
): { state: 'ok'; record: OrcadActivationRecord } | { state: 'unreadable'; reason: string } {
  const parsed = parseOrcadActivationRecord(JSON.stringify(value))
  return parsed.state === 'ok'
    ? { state: 'ok', record: parsed.record }
    : unreadable(
        `${field} is invalid: ${parsed.state === 'absent' ? 'record is absent' : parsed.reason}`
      )
}

function unreadable(reason: string): { state: 'unreadable'; reason: string } {
  return { state: 'unreadable', reason }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function sameOrcadActivationRecord(
  left: OrcadActivationRecord,
  right: OrcadActivationRecord
): boolean {
  return serializeOrcadActivationRecord(left) === serializeOrcadActivationRecord(right)
}

import type { SshConnection } from './ssh-connection'
import {
  planOrcadActivationRecovery,
  sameOrcadActivationRecord,
  withOrcadDecommissionPhase,
  type OrcadActivationRecoveryPlan,
  type OrcadDecommissionTransaction,
  type OrcadRollbackTransaction
} from './orcad-activation-transaction'
import { readOrcadActivationTransaction } from './orcad-activation-transaction-store'
import { writeOrcadActivationTransaction } from './orcad-activation-transaction-store'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import { withStaleOrcadActivationRecoveryLock } from './orcad-activation-lock'
import { RemoteInstallLockBusyError } from './ssh-relay-install-lock'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { readRemoteOrcadBuildHash } from './orcad-remote-build-hash'
import { resolveOrcadSlotNodeFallback } from './orcad-slot-runtime-eligibility'
import {
  launchOrcadSlotAndAwaitReadiness,
  probeActiveOrcadReadiness
} from './orcad-active-readiness'
import { orcadLivenessProbeCommand, parseOrcadLiveness } from './orcad-remote-launch'
import { execCommand } from './ssh-relay-deploy-helpers'
import {
  orcadStopFreedTheHost,
  parseOrcadStopOutcome,
  stopOrcadCommand
} from './orcad-remote-process-control'
import {
  clearOrcadStateSnapshotMembersCommand,
  parseOrcadSnapshotRestore,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { ORCAD_STATE_SNAPSHOT_DIR, type OrcadActivationRecord } from './orcad-activation-record'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  initialOrcadActivationAdmissionCommand,
  parseInitialOrcadActivationAdmission
} from './orcad-initial-activation-admission'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import type { ServeReadiness } from '../server/serve-readiness'
import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'

const STOP_WAIT_SECONDS = 20

export type OrcadActivationRecoveryResult =
  | { outcome: 'none' }
  | { outcome: 'pending'; code: string; reason: string }
  | {
      outcome: 'recovered'
      resolution: 'committed' | 'restored-incumbent'
      activeVersion: string | null
      readiness: ServeReadiness | null
    }
  | { outcome: 'refused'; verdict: 'live' | 'unverifiable'; code: string; reason: string }

type OrcadActivationRecoveryOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  userDataDir: string
  bindHost: string
  port: number
  readinessTimeoutMs?: number
  requestDecommission?: (
    activeVersion: string,
    transactionId: string
  ) => Promise<OrcadDecommissionResult>
  signal?: AbortSignal
  sleep?: (ms: number) => Promise<void>
}

type SlotIdentity = {
  version: string
  remoteDir: string
  buildHash: string
  nodePath?: string
  runtimeKind: 'bun' | 'node'
}

export async function recoverInterruptedOrcadActivation(
  options: OrcadActivationRecoveryOptions
): Promise<OrcadActivationRecoveryResult> {
  const pending = await readOrcadActivationTransaction(options)
  if (!pending) {
    return { outcome: 'none' }
  }
  try {
    return await withStaleOrcadActivationRecoveryLock(options, async (lock) => {
      const transaction = await readOrcadActivationTransaction(options)
      if (!transaction) {
        return { outcome: 'none' }
      }
      const currentRecord = await readOrcadActivationRecord(options)
      if (transaction.operation === 'rollback') {
        return recoverInterruptedRollback(options, transaction, currentRecord, lock)
      }
      if (transaction.operation === 'decommission') {
        return recoverInterruptedDecommission(options, transaction, currentRecord, lock)
      }
      const plan = planOrcadActivationRecovery(transaction, currentRecord)
      if (plan.action === 'refuse') {
        lock.retain()
        return { outcome: 'refused', verdict: 'unverifiable', ...plan }
      }
      return executeRecoveryPlan(options, plan)
    })
  } catch (error) {
    if (error instanceof RemoteInstallLockBusyError) {
      return {
        outcome: 'pending',
        code: 'orcad_recovery_transaction_still_fresh',
        reason:
          'The interrupted activation fence is not old enough to reclaim safely. Retry after its 20-minute recovery window.'
      }
    }
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_recovery_unverifiable',
      reason:
        `The interrupted activation could not be reconciled safely: ${errorMessage(error)} ` +
        'The host remains fenced.'
    }
  }
}

async function recoverInterruptedRollback(
  options: OrcadActivationRecoveryOptions,
  transaction: OrcadRollbackTransaction,
  currentRecord: OrcadActivationRecord,
  lock: { retain(): void }
): Promise<OrcadActivationRecoveryResult> {
  if (sameOrcadActivationRecord(currentRecord, transaction.recordAfter)) {
    if (!transaction.recordAfter.active) {
      throw new Error('The committed rollback record has no active version.')
    }
    const readiness = await ensureRecordedRuntimeServing(options, transaction.recordAfter.active)
    return {
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: transaction.recordAfter.active,
      readiness
    }
  }
  if (!sameOrcadActivationRecord(currentRecord, transaction.recordBefore)) {
    lock.retain()
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_recovery_rollback_record_changed',
      reason:
        'The activation record matches neither side of the interrupted rollback. ' +
        'Preserving the activation fence for operator inspection.'
    }
  }

  if (
    transaction.phase === 'rescue-captured' ||
    transaction.phase === 'rollback-state-restored' ||
    transaction.phase === 'target-ready'
  ) {
    const quiescence = await quiesceCandidate(
      options,
      transaction.targetVersion,
      transaction.recordBefore
    )
    if (quiescence === 'quiescent') {
      await restoreRollbackRescueState(options, transaction)
    }
  }
  const readiness = await ensureRecordedRuntimeServing(options, transaction.incumbentVersion)
  return {
    outcome: 'recovered',
    resolution: 'restored-incumbent',
    activeVersion: transaction.incumbentVersion,
    readiness
  }
}

async function restoreRollbackRescueState(
  options: OrcadActivationRecoveryOptions,
  transaction: OrcadRollbackTransaction
): Promise<void> {
  if (transaction.rescue.state === 'pending') {
    throw new Error('The interrupted rollback has no durable rescue snapshot verdict.')
  }
  const command =
    transaction.rescue.state === 'captured'
      ? restoreOrcadStateSnapshotCommand(
          options.host,
          options.userDataDir,
          joinRemotePath(
            options.host,
            options.remoteHome,
            RELAY_REMOTE_DIR,
            ORCAD_STATE_SNAPSHOT_DIR,
            transaction.rescue.dirName
          )
        )
      : clearOrcadStateSnapshotMembersCommand(options.host, options.userDataDir)
  const restored = parseOrcadSnapshotRestore(await exec(options, command))
  if (restored !== 'restored') {
    throw new Error(`The pre-rollback rescue could not be restored (${restored}).`)
  }
}

async function recoverInterruptedDecommission(
  options: OrcadActivationRecoveryOptions,
  transaction: OrcadDecommissionTransaction,
  currentRecord: OrcadActivationRecord,
  lock: { retain(): void }
): Promise<OrcadActivationRecoveryResult> {
  if (sameOrcadActivationRecord(currentRecord, transaction.recordAfter)) {
    return {
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: null,
      readiness: null
    }
  }

  let accepted = sameOrcadActivationRecord(currentRecord, transaction.acceptedRecord)
  if (!accepted && !sameOrcadActivationRecord(currentRecord, transaction.recordBefore)) {
    lock.retain()
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_recovery_decommission_record_changed',
      reason:
        'The activation record matches no durable side of the interrupted managed stop. ' +
        'Preserving the activation fence for operator inspection.'
    }
  }

  if (!accepted) {
    if (!options.requestDecommission) {
      lock.retain()
      return {
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_recovery_decommission_rpc_unavailable',
        reason: 'The interrupted managed stop requires its paired runtime to resume safely.'
      }
    }
    const response = await options.requestDecommission(
      transaction.activeVersion,
      transaction.transactionId
    )
    if (response.outcome === 'refused') {
      if (response.verdict === 'unverifiable') {
        lock.retain()
        return response
      }
      const readiness = await ensureRecordedRuntimeServing(options, transaction.activeVersion)
      return {
        outcome: 'recovered',
        resolution: 'restored-incumbent',
        activeVersion: transaction.activeVersion,
        readiness
      }
    }
    if (response.transactionId && response.transactionId !== transaction.transactionId) {
      lock.retain()
      return {
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_recovery_decommission_receipt_mismatch',
        reason: 'The host acknowledged a different managed-stop transaction.'
      }
    }
    const afterRpc = await readOrcadActivationRecord(options)
    if (sameOrcadActivationRecord(afterRpc, transaction.recordBefore)) {
      await writeOrcadActivationRecord(options, transaction.acceptedRecord)
    } else if (!sameOrcadActivationRecord(afterRpc, transaction.acceptedRecord)) {
      lock.retain()
      return {
        outcome: 'refused',
        verdict: 'unverifiable',
        code: 'orcad_recovery_decommission_record_changed',
        reason: 'The activation record changed while resuming decommission acceptance.'
      }
    }
    accepted = true
  }

  if (!accepted) {
    throw new Error('Managed stop acceptance was not established.')
  }
  let resumed = withOrcadDecommissionPhase(transaction, 'admission-fenced', new Date())
  await writeOrcadActivationTransaction(options, resumed)
  const remoteDir = installDir(options, transaction.activeVersion)
  const stopped = parseOrcadStopOutcome(
    await exec(
      options,
      stopOrcadCommand(options.host, remoteDir, { waitSeconds: STOP_WAIT_SECONDS })
    )
  )
  if (!orcadStopFreedTheHost(stopped)) {
    lock.retain()
    return {
      outcome: 'refused',
      verdict: stopped === 'still-running' || stopped === 'signal-failed' ? 'live' : 'unverifiable',
      code:
        stopped === 'still-running' || stopped === 'signal-failed'
          ? 'orcad_recovery_stop_incomplete'
          : 'orcad_recovery_stop_unverifiable',
      reason:
        `The host could not complete the interrupted stop for orcad ` +
        `${transaction.activeVersion} (${stopped}). The managed server remains linked.`
    }
  }
  resumed = withOrcadDecommissionPhase(resumed, 'process-exited', new Date())
  await writeOrcadActivationTransaction(options, resumed)
  await writeOrcadActivationRecord(options, transaction.recordAfter)
  return {
    outcome: 'recovered',
    resolution: 'committed',
    activeVersion: null,
    readiness: null
  }
}

async function executeRecoveryPlan(
  options: OrcadActivationRecoveryOptions,
  plan: Exclude<OrcadActivationRecoveryPlan, { action: 'refuse' }>
): Promise<OrcadActivationRecoveryResult> {
  if (plan.action === 'stabilize-committed') {
    if (!plan.record.active) {
      throw new Error('The committed activation record has no active version.')
    }
    const readiness = await ensureRecordedRuntimeServing(options, plan.record.active)
    return {
      outcome: 'recovered',
      resolution: 'committed',
      activeVersion: plan.record.active,
      readiness
    }
  }

  if (plan.restoreSnapshot) {
    const quiescence = await quiesceCandidate(options, plan.candidateVersion, plan.record)
    if (quiescence === 'quiescent') {
      await restorePreActivationState(options, plan.snapshot)
    }
  }
  const readiness = plan.record.active
    ? await ensureRecordedRuntimeServing(options, plan.record.active)
    : null
  return {
    outcome: 'recovered',
    resolution: 'restored-incumbent',
    activeVersion: plan.record.active,
    readiness
  }
}

async function quiesceCandidate(
  options: OrcadActivationRecoveryOptions,
  candidateVersion: string,
  recordBefore: OrcadActivationRecord
): Promise<'quiescent' | 'incumbent-live'> {
  const candidateDir = installDir(options, candidateVersion)
  const stopped = parseOrcadStopOutcome(
    await exec(
      options,
      stopOrcadCommand(options.host, candidateDir, { waitSeconds: STOP_WAIT_SECONDS })
    )
  )
  if (orcadStopFreedTheHost(stopped)) {
    return 'quiescent'
  }
  if (stopped === 'no-pid') {
    if (recordBefore.active && (await recordedRuntimeIsServing(options, recordBefore.active))) {
      return 'incumbent-live'
    }
    const admission = parseInitialOrcadActivationAdmission(
      await exec(
        options,
        initialOrcadActivationAdmissionCommand(options.host, options.userDataDir, candidateDir)
      )
    )
    if (admission.decision === 'proceed') {
      return 'quiescent'
    }
  }
  throw new Error(
    `The candidate ${candidateVersion} could not be confirmed stopped (${stopped}); ` +
      'state restoration would be unsafe.'
  )
}

async function restorePreActivationState(
  options: OrcadActivationRecoveryOptions,
  snapshot: { dirName: string; state: 'pending' | 'captured' | 'empty' }
): Promise<void> {
  if (snapshot.state === 'pending') {
    throw new Error('The interrupted activation has no durable snapshot verdict.')
  }
  const command =
    snapshot.state === 'captured'
      ? restoreOrcadStateSnapshotCommand(
          options.host,
          options.userDataDir,
          joinRemotePath(
            options.host,
            options.remoteHome,
            RELAY_REMOTE_DIR,
            ORCAD_STATE_SNAPSHOT_DIR,
            snapshot.dirName
          )
        )
      : clearOrcadStateSnapshotMembersCommand(options.host, options.userDataDir)
  const restored = parseOrcadSnapshotRestore(await exec(options, command))
  if (restored !== 'restored') {
    throw new Error(`The pre-activation state could not be restored (${restored}).`)
  }
}

async function ensureRecordedRuntimeServing(
  options: OrcadActivationRecoveryOptions,
  version: string
): Promise<ServeReadiness> {
  const identity = await resolveSlotIdentity(options, version)
  const liveness = parseOrcadLiveness(
    await exec(options, orcadLivenessProbeCommand(options.host, identity.remoteDir))
  )
  if (liveness === 'LIVE') {
    return probeSlot(options, identity)
  }
  if (liveness === 'UNKNOWN') {
    throw new Error(`orcad ${version} process state is unverifiable.`)
  }
  return launchOrcadSlotAndAwaitReadiness({
    conn: options.conn,
    host: options.host,
    remoteInstallDir: identity.remoteDir,
    nodePath: identity.nodePath,
    fullVersion: identity.version,
    userDataDir: options.userDataDir,
    bindHost: options.bindHost,
    port: options.port,
    buildHash: identity.buildHash,
    runtimeKind: identity.runtimeKind,
    readinessTimeoutMs: options.readinessTimeoutMs,
    signal: options.signal,
    sleep: options.sleep
  })
}

async function recordedRuntimeIsServing(
  options: OrcadActivationRecoveryOptions,
  version: string
): Promise<boolean> {
  try {
    const identity = await resolveSlotIdentity(options, version)
    const liveness = parseOrcadLiveness(
      await exec(options, orcadLivenessProbeCommand(options.host, identity.remoteDir))
    )
    if (liveness !== 'LIVE') {
      return false
    }
    await probeSlot(options, identity)
    return true
  } catch {
    return false
  }
}

function probeSlot(
  options: OrcadActivationRecoveryOptions,
  identity: SlotIdentity
): Promise<ServeReadiness> {
  return probeActiveOrcadReadiness({
    conn: options.conn,
    host: options.host,
    remoteInstallDir: identity.remoteDir,
    fullVersion: identity.version,
    buildHash: identity.buildHash,
    runtimeKind: identity.runtimeKind,
    port: options.port,
    signal: options.signal
  })
}

async function resolveSlotIdentity(
  options: OrcadActivationRecoveryOptions,
  version: string
): Promise<SlotIdentity> {
  const remoteDir = installDir(options, version)
  const [buildHash, nodePath] = await Promise.all([
    readRemoteOrcadBuildHash({ ...options, remoteInstallDir: remoteDir }),
    resolveOrcadSlotNodeFallback(options.conn, options.host, remoteDir, options.signal)
  ])
  return {
    version,
    remoteDir,
    buildHash,
    ...(nodePath ? { nodePath } : {}),
    runtimeKind: nodePath ? 'node' : 'bun'
  }
}

function installDir(options: OrcadActivationRecoveryOptions, version: string): string {
  return computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    version,
    options.host.pathFlavor
  )
}

function exec(options: OrcadActivationRecoveryOptions, command: string): Promise<string> {
  return execCommand(options.conn, command, {
    wrapCommand: options.host.commandDialect !== 'powershell',
    signal: options.signal
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

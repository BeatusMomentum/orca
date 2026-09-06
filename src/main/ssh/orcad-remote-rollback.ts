/**
 * Going back to the previously active orcad.
 *
 * Rollback is a state operation, not a binary swap. The version dirs are immutable and both
 * are still on disk, so pointing at the old one is trivial; what is not trivial is that both
 * versions share ONE data root, outside either dir. A newer orcad migrates that root on load
 * — and Orca's persisted state carries no schema version to migrate against, so the older
 * build cannot be shown to read the result. Rollback therefore restores the pre-activation
 * snapshot, and refuses when restoring it would orphan work (`assessOrcadRollback`).
 *
 * The order below is the whole safety argument: stop, then restore, then start. Restoring
 * under a running orcad would replace the store beneath a process holding it open, and
 * starting before restoring would let the old build migrate the new build's state — the
 * failure this is meant to avoid, arrived at from the other side.
 */
import { randomUUID } from 'node:crypto'
import type { SshConnection } from './ssh-connection'
import { execCommand, isUnconfirmedSshCommandTermination } from './ssh-relay-deploy-helpers'
import { ORCAD_INSTALL_MODEL } from './remote-install-model'
import { computeRemoteInstallDir } from './ssh-relay-versioned-install'
import { RELAY_REMOTE_DIR } from './relay-protocol'
import {
  ORCAD_STATE_SNAPSHOT_DIR,
  serializeOrcadActivationRecord,
  withRolledBackVersion,
  type OrcadActivationRecord
} from './orcad-activation-record'
import { assessOrcadRollback, type OrcadTerminalCensus } from './orcad-update-plan'
import { evaluateOrcadActivation, type OrcadActivationVerdict } from './orcad-activation-gate'
import {
  ORCAD_LOG_FILENAME,
  orcadLaunchCommand,
  parseOrcadReadinessOutput,
  readOrcadReadinessCommand
} from './orcad-remote-launch'
import {
  captureOrcadStateSnapshotCommand,
  clearOrcadStateSnapshotMembersCommand,
  newestStateMtimeCommand,
  orcadRollbackRescueDirName,
  parseNewestStateMtimeSeconds,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotPresence,
  parseOrcadSnapshotRestore,
  probeOrcadStateSnapshotCommand,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import {
  orcadStopFreedTheHost,
  parseOrcadStopOutcome,
  stopOrcadCommand
} from './orcad-remote-process-control'
import {
  readOrcadActivationRecord,
  writeOrcadActivationRecord
} from './orcad-activation-record-store'
import { joinRemotePath, type RemoteHostPlatform } from './ssh-remote-platform'
import {
  resolveOrcadActivationReadinessTimeout,
  withOrcadActivationLock,
  type OrcadActivationLockControl
} from './orcad-activation-lock'
import type { ServeReadiness } from '../server/serve-readiness'
import { readRemoteOrcadBuildHash } from './orcad-remote-build-hash'
import { resolveOrcadSlotNodeFallback } from './orcad-slot-runtime-eligibility'
import {
  createOrcadRollbackTransaction,
  withOrcadRollbackPhase,
  withOrcadRollbackRescue,
  type OrcadRollbackTransaction
} from './orcad-activation-transaction'
import { writeOrcadActivationTransaction } from './orcad-activation-transaction-store'

export type OrcadRollbackOptions = {
  conn: SshConnection
  host: RemoteHostPlatform
  remoteHome: string
  record: OrcadActivationRecord
  nodePath?: string
  userDataDir: string
  bindHost: string
  port: number
  census: OrcadTerminalCensus
  /** Expected build hash of the rollback target, from the client's copy of those bytes. */
  targetBuildHash: string
  readinessTimeoutMs?: number
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  signal?: AbortSignal
}

export type OrcadRollbackResult =
  | {
      outcome: 'rolled-back'
      target: string
      discarded: string[]
      verdict: OrcadActivationVerdict
      readiness: ServeReadiness
    }
  | { outcome: 'refused'; code: string; reason: string }
  | { outcome: 'failed'; code: string; reason: string }

const DEFAULT_READINESS_TIMEOUT_MS = 90_000
const READINESS_POLL_MS = 500
const STOP_WAIT_SECONDS = 20

function exec(options: OrcadRollbackOptions, command: string): Promise<string> {
  return execCommand(options.conn, command, {
    wrapCommand: options.host.commandDialect !== 'powershell',
    signal: options.signal
  })
}

function snapshotDirPath(options: OrcadRollbackOptions, dirName: string): string {
  return joinRemotePath(
    options.host,
    options.remoteHome,
    RELAY_REMOTE_DIR,
    ORCAD_STATE_SNAPSHOT_DIR,
    dirName
  )
}

/** Has the store been written since activation? `null` when it cannot be established. */
async function readStateWritesSinceActivation(
  options: OrcadRollbackOptions
): Promise<boolean | null> {
  if (!options.record.activatedAt) {
    return null
  }
  const activatedAtSeconds = Math.floor(Date.parse(options.record.activatedAt) / 1000)
  if (!Number.isFinite(activatedAtSeconds)) {
    return null
  }
  let output: string
  try {
    output = await exec(options, newestStateMtimeCommand(options.host, options.userDataDir))
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return null
  }
  const newest = parseNewestStateMtimeSeconds(output)
  return newest === null ? null : newest >= activatedAtSeconds
}

type ActiveRuntimeIdentity = {
  version: string
  remoteDir: string
  buildHash: string
  nodePath?: string
}

type RollbackRescueSnapshot = { state: 'captured'; dir: string } | { state: 'empty'; dir: null }

function withoutAbortSignal(options: OrcadRollbackOptions): OrcadRollbackOptions {
  const { signal: _signal, ...recoveryOptions } = options
  return recoveryOptions
}

async function resolveActiveRuntimeIdentity(
  options: OrcadRollbackOptions
): Promise<ActiveRuntimeIdentity | null> {
  if (!options.record.active) {
    return null
  }
  const remoteDir = computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    options.record.active,
    options.host.pathFlavor
  )
  const [buildHash, nodePath] = await Promise.all([
    readRemoteOrcadBuildHash({
      conn: options.conn,
      host: options.host,
      remoteInstallDir: remoteDir,
      signal: options.signal
    }),
    resolveOrcadSlotNodeFallback(options.conn, options.host, remoteDir, options.signal)
  ])
  return {
    version: options.record.active,
    remoteDir,
    buildHash,
    ...(nodePath ? { nodePath } : {})
  }
}

async function captureRollbackRescue(
  options: OrcadRollbackOptions,
  dirName: string
): Promise<RollbackRescueSnapshot | null> {
  const dir = snapshotDirPath(options, dirName)
  const captured = parseOrcadSnapshotCapture(
    await exec(options, captureOrcadStateSnapshotCommand(options.host, options.userDataDir, dir))
  )
  if (captured === 'failed') {
    return null
  }
  return captured === 'captured' ? { state: 'captured', dir } : { state: 'empty', dir: null }
}

async function restoreRollbackRescue(
  options: OrcadRollbackOptions,
  rescue: RollbackRescueSnapshot
): Promise<boolean> {
  const output = await exec(
    options,
    rescue.state === 'captured'
      ? restoreOrcadStateSnapshotCommand(options.host, options.userDataDir, rescue.dir)
      : clearOrcadStateSnapshotMembersCommand(options.host, options.userDataDir)
  )
  return parseOrcadSnapshotRestore(output) === 'restored'
}

async function launchAndGate(
  options: OrcadRollbackOptions,
  identity: ActiveRuntimeIdentity
): Promise<{
  verdict: OrcadActivationVerdict
  readiness: ServeReadiness | null
}> {
  await exec(
    options,
    orcadLaunchCommand(options.host, {
      remoteInstallDir: identity.remoteDir,
      nodePath: identity.nodePath,
      fullVersion: identity.version,
      userDataDir: options.userDataDir,
      bindHost: options.bindHost,
      port: options.port,
      allowHostNodeFallback: true
    })
  )
  const deadline =
    Date.now() +
    resolveOrcadActivationReadinessTimeout(options.readinessTimeoutMs, DEFAULT_READINESS_TIMEOUT_MS)
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))
  let parsed = parseOrcadReadinessOutput('')
  while (Date.now() < deadline && parsed.state === 'pending') {
    options.signal?.throwIfAborted()
    parsed = parseOrcadReadinessOutput(
      await exec(options, readOrcadReadinessCommand(options.host, identity.remoteDir))
    )
    if (parsed.state === 'pending') {
      await sleep(READINESS_POLL_MS)
    }
  }
  return {
    verdict: evaluateOrcadActivation(parsed.state === 'ready' ? parsed.readiness : null, {
      buildHash: identity.buildHash,
      fullVersion: identity.version,
      runtimeKind: identity.nodePath ? 'node' : 'bun',
      port: options.port
    }),
    readiness: parsed.state === 'ready' ? parsed.readiness : null
  }
}

async function recoverActiveRuntime(
  options: OrcadRollbackOptions,
  identity: ActiveRuntimeIdentity,
  rescue?: RollbackRescueSnapshot
): Promise<{ recovered: boolean; reason: string }> {
  const recoveryOptions = withoutAbortSignal(options)
  try {
    if (rescue && !(await restoreRollbackRescue(recoveryOptions, rescue))) {
      return {
        recovered: false,
        reason: 'the rescue snapshot could not be restored'
      }
    }
    const recovery = await launchAndGate(recoveryOptions, identity)
    if (recovery.verdict.decision === 'reject') {
      return {
        recovered: false,
        reason: `the active runtime failed its recovery health gate: ${recovery.verdict.reason}`
      }
    }
    return {
      recovered: true,
      reason: `orcad ${identity.version} was restored and is serving again`
    }
  } catch (error) {
    return {
      recovered: false,
      reason: `active-runtime recovery failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

async function stopFailedTargetAndRecoverActive(
  options: OrcadRollbackOptions,
  lock: OrcadActivationLockControl,
  target: ActiveRuntimeIdentity,
  active: ActiveRuntimeIdentity,
  rescue: RollbackRescueSnapshot
): Promise<{ code?: string; reason: string }> {
  let stoppedTarget: ReturnType<typeof parseOrcadStopOutcome>
  try {
    stoppedTarget = parseOrcadStopOutcome(
      await exec(
        withoutAbortSignal(options),
        stopOrcadCommand(options.host, target.remoteDir, { waitSeconds: STOP_WAIT_SECONDS })
      )
    )
  } catch (error) {
    lock.retain()
    return {
      code: 'orcad_rollback_target_stop_unverifiable',
      reason:
        `The rollback target could not be confirmed stopped: ` +
        `${error instanceof Error ? error.message : String(error)} The rescue snapshot is ` +
        'intact, but restoring it while the target may still own the data root would be unsafe.'
    }
  }
  if (!orcadStopFreedTheHost(stoppedTarget)) {
    lock.retain()
    return {
      code: 'orcad_rollback_target_stop_incomplete',
      reason:
        `The rollback target could not be confirmed stopped (${stoppedTarget}). The rescue ` +
        'snapshot is intact, but restoring it while the target may still own the data root ' +
        'would be unsafe.'
    }
  }
  const recovery = await recoverActiveRuntime(options, active, rescue)
  if (!recovery.recovered) {
    lock.retain()
  }
  return { reason: recovery.reason }
}

export async function rollbackOrcad(options: OrcadRollbackOptions): Promise<OrcadRollbackResult> {
  return withOrcadActivationLock(options, async (lock) => {
    const currentRecord = await readOrcadActivationRecord(options)
    if (
      serializeOrcadActivationRecord(currentRecord) !==
      serializeOrcadActivationRecord(options.record)
    ) {
      return {
        outcome: 'refused',
        code: 'orcad_rollback_record_changed',
        reason:
          'The host activation record changed while this rollback was waiting. Refresh the ' +
          'host state and review the new rollback target before trying again.'
      }
    }
    return rollbackLocked({ ...options, record: currentRecord }, lock)
  })
}

async function rollbackLocked(
  options: OrcadRollbackOptions,
  lock: OrcadActivationLockControl
): Promise<OrcadRollbackResult> {
  const now = options.now ?? ((): Date => new Date())
  let snapshotPresent: boolean | null = false
  if (options.record.snapshot) {
    let output: string
    try {
      output = await exec(
        options,
        probeOrcadStateSnapshotCommand(
          options.host,
          snapshotDirPath(options, options.record.snapshot.dirName)
        )
      )
    } catch (error) {
      if (isUnconfirmedSshCommandTermination(error)) {
        throw error
      }
      output = ''
    }
    const presence = parseOrcadSnapshotPresence(output)
    snapshotPresent = presence === 'unverifiable' ? null : presence === 'present'
  }

  const safety = assessOrcadRollback({
    record: options.record,
    snapshotPresent,
    census: options.census,
    stateWritesSinceActivation: await readStateWritesSinceActivation(options)
  })
  if (safety.safety === 'unsafe') {
    return { outcome: 'refused', code: safety.code, reason: safety.reason }
  }

  let activeIdentity: ActiveRuntimeIdentity | null
  try {
    activeIdentity = await resolveActiveRuntimeIdentity(options)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    return {
      outcome: 'refused',
      code: 'orcad_rollback_active_identity_unverifiable',
      reason:
        `The active orcad identity could not be verified before stopping it: ` +
        `${error instanceof Error ? error.message : String(error)} Nothing was changed.`
    }
  }

  if (!activeIdentity) {
    return {
      outcome: 'failed',
      code: 'orcad_rollback_active_identity_unverifiable',
      reason: 'The activation record has no active runtime to recover if rollback fails.'
    }
  }

  const transactionStartedAt = now()
  let transaction: OrcadRollbackTransaction = createOrcadRollbackTransaction({
    transactionId: randomUUID(),
    incumbentVersion: activeIdentity.version,
    targetVersion: safety.target,
    recordBefore: options.record,
    recordAfter: withRolledBackVersion(options.record, transactionStartedAt),
    rescueDirName: orcadRollbackRescueDirName(
      activeIdentity.version,
      transactionStartedAt.getTime()
    ),
    now: transactionStartedAt
  })
  await writeOrcadActivationTransaction(options, transaction)
  lock.retainOnError()

  const stopped = parseOrcadStopOutcome(
    await exec(
      options,
      stopOrcadCommand(options.host, activeIdentity.remoteDir, { waitSeconds: STOP_WAIT_SECONDS })
    )
  )
  if (!orcadStopFreedTheHost(stopped)) {
    return {
      outcome: 'failed',
      code: 'orcad_rollback_stop_incomplete',
      reason:
        `orcad ${options.record.active} did not exit within ${STOP_WAIT_SECONDS}s of its graceful stop request ` +
        `(${stopped}). Nothing was restored — the store is untouched and the host is still ` +
        'serving the version you tried to leave.'
    }
  }
  transaction = withOrcadRollbackPhase(transaction, 'incumbent-stopped', now())
  await writeOrcadActivationTransaction(options, transaction)

  let rescue: RollbackRescueSnapshot | null
  try {
    rescue = await captureRollbackRescue(options, transaction.rescue.dirName)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    rescue = null
  }
  if (!rescue) {
    const recovery = await recoverActiveRuntime(options, activeIdentity)
    if (!recovery.recovered) {
      lock.retain()
    }
    return {
      outcome: 'failed',
      code: 'orcad_rollback_rescue_snapshot_failed',
      reason:
        'The rollback was cancelled because the current state could not be preserved in a ' +
        `pre-rollback rescue snapshot; the data root was not replaced. ${recovery.reason}.`
    }
  }
  transaction = withOrcadRollbackRescue(transaction, rescue.state, now())
  await writeOrcadActivationTransaction(options, transaction)

  // Why between stop and start: the store must be replaced while no orcad holds it, and
  // before the older build gets a chance to migrate the newer build's state.
  lock.retainOnError()
  let restoreOutput: string
  try {
    restoreOutput = await exec(
      options,
      restoreOrcadStateSnapshotCommand(
        options.host,
        options.userDataDir,
        // Guarded by `assessOrcadRollback`: `unsafe` covers a missing snapshot.
        snapshotDirPath(options, options.record.snapshot?.dirName ?? '')
      )
    )
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    restoreOutput = 'FAILED'
  }
  const restored = parseOrcadSnapshotRestore(restoreOutput)
  if (restored !== 'restored') {
    const recovery = await recoverActiveRuntime(options, activeIdentity, rescue)
    if (!recovery.recovered) {
      lock.retain()
    }
    return {
      outcome: 'failed',
      code: 'orcad_rollback_restore_failed',
      reason:
        `The pre-activation snapshot could not be restored (${restored}). ` +
        `The pre-rollback state was preserved in a rescue snapshot; ${recovery.reason}.`
    }
  }
  transaction = withOrcadRollbackPhase(transaction, 'rollback-state-restored', now())
  await writeOrcadActivationTransaction(options, transaction)

  const targetDir = computeRemoteInstallDir(
    ORCAD_INSTALL_MODEL,
    options.remoteHome,
    safety.target,
    options.host.pathFlavor
  )
  const targetIdentity: ActiveRuntimeIdentity = {
    version: safety.target,
    remoteDir: targetDir,
    buildHash: options.targetBuildHash,
    ...(options.nodePath ? { nodePath: options.nodePath } : {})
  }
  let target: Awaited<ReturnType<typeof launchAndGate>>
  try {
    target = await launchAndGate(options, targetIdentity)
  } catch (error) {
    if (isUnconfirmedSshCommandTermination(error)) {
      throw error
    }
    const recovery = await stopFailedTargetAndRecoverActive(
      options,
      lock,
      targetIdentity,
      activeIdentity,
      rescue
    )
    return {
      outcome: 'failed',
      code: recovery.code ?? 'orcad_rollback_target_launch_failed',
      reason:
        `The rollback target ${safety.target} failed while starting or proving readiness: ` +
        `${error instanceof Error ? error.message : String(error)} ${recovery.reason}. Its ` +
        `stderr is at ${joinRemotePath(options.host, targetDir, ORCAD_LOG_FILENAME)}.`
    }
  }
  const verdict = target.verdict
  if (verdict.decision === 'reject') {
    const recovery = await stopFailedTargetAndRecoverActive(
      options,
      lock,
      targetIdentity,
      activeIdentity,
      rescue
    )
    return {
      outcome: 'failed',
      code: recovery.code ?? verdict.code,
      reason:
        `The rollback target ${safety.target} did not come up healthy: ${verdict.reason} ` +
        `${recovery.reason}. Its stderr is at ` +
        `${joinRemotePath(options.host, targetDir, ORCAD_LOG_FILENAME)}.`
    }
  }

  // Why the record is written last: until the target is proven serving, `active` still names
  // the version an operator would need to bring back, and `previous` still names this target.
  transaction = withOrcadRollbackPhase(transaction, 'target-ready', now())
  await writeOrcadActivationTransaction(options, transaction)
  await writeOrcadActivationRecord(options, transaction.recordAfter)
  return {
    outcome: 'rolled-back',
    target: safety.target,
    discarded: safety.safety === 'lossy' ? safety.discards : [],
    verdict,
    readiness: target.readiness ?? neverReadiness()
  }
}

function neverReadiness(): never {
  throw new Error('Accepted orcad rollback without readiness')
}

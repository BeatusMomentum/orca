import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import type {
  OrcadManagedDeployResult,
  OrcadManagedPendingMigration,
  OrcadManagedRuntimeStatus
} from '../../../../shared/orcad-managed-runtime'
import type { OrcadMigrationPreflight } from '../../../../shared/orcad-migration-preflight'
import {
  isManagedOrcadRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import type { SshTarget } from '../../../../shared/ssh-types'
import { translate } from '@/i18n/i18n'

export type ManagedOrcadStatusEntry =
  | { state: 'ready'; status: OrcadManagedRuntimeStatus }
  | { state: 'error'; message: string }
  | { state: 'loading' }

export type ManagedOrcadForceOperation =
  | {
      kind: 'create'
      name: string
      sshTargetId: string
      candidateVersion: string
      reason: string
    }
  | {
      kind: 'update'
      environmentId: string
      candidateVersion: string
      reason: string
    }
  | {
      kind: 'resume'
      environmentId: string
      name: string
      sshTargetId: string
      candidateVersion: string
      reason: string
    }

export type ManagedOrcadConfirmation =
  | { kind: 'rollback'; environmentId: string; environmentName: string; previousVersion: string }
  | { kind: 'stop'; environmentId: string; environmentName: string }

export type ManagedOrcadBusyAction = {
  id: string
  action: 'deploy' | 'resume' | 'update' | 'rollback' | 'recover' | 'stop'
}

export type ManagedOrcadResumeInput = Pick<
  OrcadManagedPendingMigration,
  'environmentId' | 'name' | 'sshTargetId'
>

export type ManagedOrcadTargetPreflightEntry =
  | { state: 'loading'; targetId: string }
  | { state: 'ready'; targetId: string; preflight: OrcadMigrationPreflight }
  | { state: 'error'; targetId: string; message: string }

export function useManagedOrcadServers(onEnvironmentsChanged: () => Promise<void> | void) {
  const [environments, setEnvironments] = useState<PublicKnownRuntimeEnvironment[]>([])
  const [targets, setTargets] = useState<SshTarget[]>([])
  const [pendingMigrations, setPendingMigrations] = useState<OrcadManagedPendingMigration[]>([])
  const [statuses, setStatuses] = useState<Record<string, ManagedOrcadStatusEntry>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [sshTargetId, setSshTargetId] = useState('')
  const [targetPreflight, setTargetPreflight] = useState<ManagedOrcadTargetPreflightEntry | null>(
    null
  )
  const [createError, setCreateError] = useState<string | null>(null)
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({})
  const [busyAction, setBusyAction] = useState<ManagedOrcadBusyAction | null>(null)
  const [forceOperation, setForceOperation] = useState<ManagedOrcadForceOperation | null>(null)
  const [confirmation, setConfirmation] = useState<ManagedOrcadConfirmation | null>(null)
  const loadRequestRef = useRef(0)
  const preflightRequestRef = useRef(0)

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++loadRequestRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const [listedEnvironments, listedTargets, listedPendingMigrations] = await Promise.all([
        window.api.runtimeEnvironments.list(),
        window.api.ssh.listTargets(),
        window.api.runtimeEnvironments.listPendingOrcadMigrations()
      ])
      const managed = listedEnvironments.filter(isManagedOrcadRuntimeEnvironment)
      const resolvedStatuses = await Promise.all(
        managed.map(async (environment) => {
          try {
            return [
              environment.id,
              {
                state: 'ready' as const,
                status: await window.api.runtimeEnvironments.getOrcadStatus({
                  selector: environment.id
                })
              }
            ] as const
          } catch (error) {
            return [
              environment.id,
              { state: 'error' as const, message: errorMessage(error) }
            ] as const
          }
        })
      )
      if (loadRequestRef.current !== requestId) {
        return
      }
      setEnvironments(managed)
      setTargets(listedTargets)
      setPendingMigrations(listedPendingMigrations)
      setStatuses(Object.fromEntries(resolvedStatuses))
    } catch (error) {
      if (loadRequestRef.current === requestId) {
        setLoadError(errorMessage(error))
      }
    } finally {
      if (loadRequestRef.current === requestId) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void load()
    return () => {
      loadRequestRef.current += 1
      preflightRequestRef.current += 1
    }
  }, [load])

  const selectSshTarget = (targetId: string): void => {
    setSshTargetId(targetId)
    const requestId = ++preflightRequestRef.current
    if (!targetId) {
      setTargetPreflight(null)
      return
    }
    setTargetPreflight({ state: 'loading', targetId })
    void window.api.runtimeEnvironments
      .preflightOrcadTarget({ sshTargetId: targetId })
      .then((preflight) => {
        if (preflightRequestRef.current === requestId) {
          setTargetPreflight({ state: 'ready', targetId, preflight })
        }
      })
      .catch((error: unknown) => {
        if (preflightRequestRef.current === requestId) {
          setTargetPreflight({ state: 'error', targetId, message: errorMessage(error) })
        }
      })
  }

  const refreshAfterMutation = async (): Promise<void> => {
    await Promise.all([load(), onEnvironmentsChanged()])
  }

  const deploy = async (input: {
    name: string
    sshTargetId: string
    force?: boolean
  }): Promise<void> => {
    setBusyAction({ id: 'create', action: 'deploy' })
    setCreateError(null)
    try {
      const result = await window.api.runtimeEnvironments.deployOrcad(input)
      if (result.outcome === 'deferred') {
        if (result.forceable === false) {
          setCreateError(result.reason)
          return
        }
        setForceOperation({
          kind: 'create',
          name: input.name,
          sshTargetId: input.sshTargetId,
          candidateVersion: result.candidateVersion,
          reason: result.reason
        })
        return
      }
      toast.success(deploySuccessMessage(result))
      setFormOpen(false)
      setName('')
      selectSshTarget('')
      await refreshAfterMutation()
    } catch (error) {
      setCreateError(errorMessage(error))
    } finally {
      setBusyAction(null)
    }
  }

  const update = async (environmentId: string, force?: boolean): Promise<void> => {
    setBusyAction({ id: environmentId, action: 'update' })
    clearRowError(environmentId)
    try {
      const result = await window.api.runtimeEnvironments.updateOrcad({
        selector: environmentId,
        force
      })
      if (result.outcome === 'deferred') {
        if (result.forceable === false) {
          setRowErrors((current) => ({ ...current, [environmentId]: result.reason }))
          return
        }
        setForceOperation({
          kind: 'update',
          environmentId,
          candidateVersion: result.candidateVersion,
          reason: result.reason
        })
        return
      }
      toast.success(deploySuccessMessage(result))
      await refreshAfterMutation()
    } catch (error) {
      setRowError(environmentId, error)
    } finally {
      setBusyAction(null)
    }
  }

  const resumeMigration = async (
    migration: ManagedOrcadResumeInput,
    force?: boolean
  ): Promise<void> => {
    setBusyAction({ id: migration.environmentId, action: 'resume' })
    clearRowError(migration.environmentId)
    try {
      const result = await window.api.runtimeEnvironments.deployOrcad({
        name: migration.name,
        sshTargetId: migration.sshTargetId,
        force
      })
      if (result.outcome === 'deferred') {
        if (result.forceable === false) {
          setRowErrors((current) => ({
            ...current,
            [migration.environmentId]: result.reason
          }))
          return
        }
        setForceOperation({
          kind: 'resume',
          ...migration,
          candidateVersion: result.candidateVersion,
          reason: result.reason
        })
        return
      }
      toast.success(deploySuccessMessage(result))
      await refreshAfterMutation()
    } catch (error) {
      setRowError(migration.environmentId, error)
    } finally {
      setBusyAction(null)
    }
  }

  const rollback = async (environmentId: string): Promise<void> => {
    setConfirmation(null)
    setBusyAction({ id: environmentId, action: 'rollback' })
    clearRowError(environmentId)
    try {
      const result = await window.api.runtimeEnvironments.rollbackOrcad({
        selector: environmentId
      })
      if (result.outcome !== 'rolled-back') {
        setRowErrors((current) => ({ ...current, [environmentId]: result.reason }))
        return
      }
      toast.success(
        translate(
          'auto.components.settings.ManagedOrcadServersSection.rollbackComplete',
          'Rolled back to orcad {{value0}}.',
          { value0: result.activeVersion }
        )
      )
      await refreshAfterMutation()
    } catch (error) {
      setRowError(environmentId, error)
    } finally {
      setBusyAction(null)
    }
  }

  const recover = async (environmentId: string): Promise<void> => {
    setBusyAction({ id: environmentId, action: 'recover' })
    clearRowError(environmentId)
    try {
      const result = await window.api.runtimeEnvironments.recoverOrcad({
        selector: environmentId
      })
      if (result.outcome !== 'recovered') {
        setRowErrors((current) => ({
          ...current,
          [environmentId]:
            result.outcome === 'none'
              ? translate(
                  'auto.components.settings.ManagedOrcadServersSection.noRecovery',
                  'No interrupted activation remains on this host.'
                )
              : result.reason
        }))
        return
      }
      toast.success(
        result.activeVersion
          ? translate(
              'auto.components.settings.ManagedOrcadServersSection.recoveryComplete',
              'Recovered orcad {{value0}}.',
              { value0: result.activeVersion }
            )
          : translate(
              'auto.components.settings.ManagedOrcadServersSection.recoveryNoActive',
              'Recovered the pre-activation state.'
            )
      )
      await refreshAfterMutation()
    } catch (error) {
      setRowError(environmentId, error)
    } finally {
      setBusyAction(null)
    }
  }

  const stopAndUnlink = async (environmentId: string): Promise<void> => {
    setConfirmation(null)
    setBusyAction({ id: environmentId, action: 'stop' })
    clearRowError(environmentId)
    try {
      const result = await window.api.runtimeEnvironments.stopOrcad({ selector: environmentId })
      if (result.outcome !== 'unlinked') {
        setRowErrors((current) => ({ ...current, [environmentId]: result.reason }))
        return
      }
      toast.success(
        translate(
          'auto.components.settings.ManagedOrcadServersSection.stopComplete',
          'Stopped and unlinked {{value0}}.',
          { value0: result.environment.name }
        )
      )
      await refreshAfterMutation()
    } catch (error) {
      setRowError(environmentId, error)
    } finally {
      setBusyAction(null)
    }
  }

  const clearRowError = (environmentId: string): void => {
    setRowErrors((current) => {
      if (!(environmentId in current)) {
        return current
      }
      const next = { ...current }
      delete next[environmentId]
      return next
    })
  }

  const setRowError = (environmentId: string, error: unknown): void => {
    setRowErrors((current) => ({ ...current, [environmentId]: errorMessage(error) }))
  }

  return {
    busyAction,
    confirmation,
    createError,
    deploy,
    environments,
    forceOperation,
    formOpen,
    load,
    loadError,
    loading,
    name,
    pendingMigrations,
    recover,
    resumeMigration,
    rollback,
    rowErrors,
    setConfirmation,
    setCreateError,
    setForceOperation,
    setFormOpen,
    setName,
    selectSshTarget,
    sshTargetId,
    statuses,
    stopAndUnlink,
    targets,
    targetPreflight,
    update
  }
}

function deploySuccessMessage(result: Exclude<OrcadManagedDeployResult, { outcome: 'deferred' }>) {
  return result.outcome === 'already-current'
    ? translate(
        'auto.components.settings.ManagedOrcadServersSection.alreadyCurrent',
        'orcad {{value0}} is already current.',
        { value0: result.activeVersion }
      )
    : translate(
        'auto.components.settings.ManagedOrcadServersSection.deployComplete',
        'Activated orcad {{value0}}.',
        { value0: result.activeVersion }
      )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrcadManagedPendingMigration } from '../../../../shared/orcad-managed-runtime'
import {
  isManagedOrcadRuntimeEnvironment,
  type PublicKnownRuntimeEnvironment
} from '../../../../shared/runtime-environments'
import type { SshTarget } from '../../../../shared/ssh-types'
import type {
  ManagedOrcadStatusEntry,
  ManagedOrcadTargetPreflightEntry
} from './managed-orcad-server-types'

export function useManagedOrcadCatalog() {
  const [environments, setEnvironments] = useState<PublicKnownRuntimeEnvironment[]>([])
  const [targets, setTargets] = useState<SshTarget[]>([])
  const [pendingMigrations, setPendingMigrations] = useState<OrcadManagedPendingMigration[]>([])
  const [statuses, setStatuses] = useState<Record<string, ManagedOrcadStatusEntry>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [sshTargetId, setSshTargetId] = useState('')
  const [targetPreflight, setTargetPreflight] = useState<ManagedOrcadTargetPreflightEntry | null>(
    null
  )
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

  return {
    environments,
    targets,
    pendingMigrations,
    statuses,
    loading,
    loadError,
    sshTargetId,
    targetPreflight,
    load,
    selectSshTarget
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

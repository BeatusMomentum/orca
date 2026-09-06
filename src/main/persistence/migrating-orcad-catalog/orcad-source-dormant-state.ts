import type {
  OrcadMigrationCatalogPayload,
  OrcadMigrationDormantStatePayload,
  OrcadMigrationManifest,
  OrcadMigrationManifestSource
} from '../../../shared/orcad-migration-manifest'
import { serializeOrcadMigrationValue } from '../../../shared/orcad-migration-manifest'
import { parsePersistedAutomationHostFilter } from '../../../shared/automation-host-filter'
import { hostStableKey } from '../../../shared/automation-owner-key'
import { toRuntimeExecutionHostId } from '../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import type { OrcadMigrationDependencyKind } from '../../../shared/orcad-migration-preflight'
import type { OrcadMigrationClientStatePayload } from '../../../shared/orcad-migration-client-state'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS,
  type ClientHostedBrowserCloseIntent
} from '../../../shared/client-hosted-browser-close-intent'
import {
  collectTerminalScrollbackSnapshotRefs,
  deleteTerminalScrollbackSnapshotSync,
  type TerminalScrollbackSnapshotStorage
} from '../../terminal-scrollback-snapshots'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { isEmptyRetiredNameRegistry } from '../../../shared/worktree/retired-name-registry'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { toOrcadDestinationRepository } from './orcad-catalog-records'
import { collectOrcadMigrationRetirementNamespaces } from './orcad-source-retirement-state'
import {
  assertOrcadMigrationSourceAutomationStateRetired,
  collectOrcadMigrationSourceAutomationState,
  retireOrcadMigrationSourceAutomationState
} from './orcad-source-automation-state'
import {
  assertOrcadMigrationSourceWorkspaceSessionRetired,
  collectOrcadMigrationSourceWorkspaceSession,
  retireOrcadMigrationSourceWorkspaceSession
} from './orcad-source-workspace-session'
import {
  createOrcadMigrationSourceScope,
  orcadMigrationOwnerMatchesScope,
  unqualifyOrcadMigrationOwnerKey
} from './orcad-source-scope'
import { collectOrcadMigrationSourceClientState } from './orcad-source-client-state'

export const ORCAD_MIGRATION_TRANSFERRED_DORMANT_KINDS = [
  'worktree-metadata',
  'worktree-lineage',
  'workspace-lineage',
  'workspace-session',
  'automation',
  'automation-run',
  'sparse-preset',
  'retired-worktree-name',
  'mobile-tab-selection',
  'ui-routing',
  'saved-port-forward'
] as const satisfies readonly OrcadMigrationDependencyKind[]

type TransferredDormantKind = (typeof ORCAD_MIGRATION_TRANSFERRED_DORMANT_KINDS)[number]

export type OrcadMigrationSourceDormantInspection = {
  payload: OrcadMigrationDormantStatePayload
  blockedCounts: Record<TransferredDormantKind, number>
}

export function collectOrcadMigrationSourceDormantState(
  state: PersistedState,
  source: OrcadMigrationManifestSource,
  catalog: OrcadMigrationCatalogPayload,
  storage?: TerminalScrollbackSnapshotStorage,
  destinationEnvironmentId?: string
): OrcadMigrationSourceDormantInspection {
  const scope = createOrcadMigrationSourceScope({ source, catalog })
  const blockedCounts = emptyBlockedCounts()
  const destinationRepos = catalog.repositories.map(toOrcadDestinationRepository)
  const setupByRepoId = new Map(
    projectHostSetupProjectionFromRepos(destinationRepos).setups.flatMap((setup) =>
      setup.repoId ? [[setup.repoId, setup] as const] : []
    )
  )
  const worktreeMeta = uniqueDestinationRows(
    Object.entries(state.worktreeMeta).flatMap(([sourceKey, meta]) => {
      const belongs = orcadMigrationOwnerMatchesScope(sourceKey, scope)
      if (!belongs && meta.hostId !== scope.hostId) {
        return []
      }
      if (!belongs) {
        blockedCounts['worktree-metadata'] += 1
        return []
      }
      const worktreeId = unqualifyOrcadMigrationOwnerKey(sourceKey)
      const setup = setupByRepoId.get(getRepoIdFromWorktreeId(worktreeId))
      return [
        {
          sourceKey,
          worktreeId,
          meta: {
            ...structuredClone(meta),
            ...(setup ? { projectId: setup.projectId, projectHostSetupId: setup.id } : {}),
            hostId: 'local' as const
          }
        }
      ]
    }),
    (entry) => entry.worktreeId,
    () => (blockedCounts['worktree-metadata'] += 1)
  )
  const worktreeLineage = uniqueDestinationRows(
    Object.entries(state.worktreeLineageById).flatMap(([sourceKey, lineage]) => {
      const touches = [sourceKey, lineage.worktreeId, lineage.parentWorktreeId].some((value) =>
        orcadMigrationOwnerMatchesScope(value, scope)
      )
      if (!touches) {
        return []
      }
      const worktreeId = unqualifyOrcadMigrationOwnerKey(sourceKey)
      if (
        worktreeId !== lineage.worktreeId ||
        !orcadMigrationOwnerMatchesScope(lineage.worktreeId, scope) ||
        !orcadMigrationOwnerMatchesScope(lineage.parentWorktreeId, scope)
      ) {
        blockedCounts['worktree-lineage'] += 1
        return []
      }
      return [{ sourceKey, worktreeId, lineage: structuredClone(lineage) }]
    }),
    (entry) => entry.worktreeId,
    () => (blockedCounts['worktree-lineage'] += 1)
  )
  const workspaceLineage = uniqueDestinationRows(
    Object.entries(state.workspaceLineageByChildKey).flatMap(([sourceKey, lineage]) => {
      const touches = [sourceKey, lineage.childWorkspaceKey, lineage.parentWorkspaceKey].some(
        (value) => orcadMigrationOwnerMatchesScope(value, scope)
      )
      if (!touches) {
        return []
      }
      const childWorkspaceKey = unqualifyOrcadMigrationOwnerKey(sourceKey)
      if (
        childWorkspaceKey !== lineage.childWorkspaceKey ||
        !orcadMigrationOwnerMatchesScope(lineage.childWorkspaceKey, scope) ||
        !orcadMigrationOwnerMatchesScope(lineage.parentWorkspaceKey, scope)
      ) {
        blockedCounts['workspace-lineage'] += 1
        return []
      }
      return [
        {
          sourceKey,
          childWorkspaceKey,
          lineage: {
            ...structuredClone(lineage),
            childInstanceId: lineage.childInstanceId ?? null,
            parentInstanceId: lineage.parentInstanceId ?? null
          }
        }
      ]
    }),
    (entry) => entry.childWorkspaceKey,
    () => (blockedCounts['workspace-lineage'] += 1)
  )
  const sparsePresets = [...scope.repoIds]
    .flatMap((repoId) => state.sparsePresetsByRepo[repoId] ?? [])
    .map((preset) => structuredClone(preset))
    .sort((left, right) =>
      compareKeys(`${left.repoId}\0${left.id}`, `${right.repoId}\0${right.id}`)
    )
  const retiredWorktreeNames = [...scope.repoIds]
    .flatMap((repoId) => {
      const registry = state.retiredWorktreeNamesByRepo?.[repoId]
      return registry && !isEmptyRetiredNameRegistry(registry)
        ? [{ repoId, registry: structuredClone(registry) }]
        : []
    })
    .sort((left, right) => compareKeys(left.repoId, right.repoId))
  const workspaceSession = collectOrcadMigrationSourceWorkspaceSession(
    state,
    source,
    catalog,
    storage
  )
  blockedCounts['workspace-session'] = workspaceSession.blockedCount
  const automationState = collectOrcadMigrationSourceAutomationState(state, source, catalog)
  blockedCounts.automation = automationState.blockedAutomationCount
  blockedCounts['automation-run'] = automationState.blockedRunCount
  const clientState = collectOrcadMigrationSourceClientState(
    state,
    source,
    catalog,
    destinationEnvironmentId,
    workspaceSession.payload
  )
  blockedCounts['mobile-tab-selection'] = clientState.blockedCounts['mobile-tab-selection']
  blockedCounts['ui-routing'] = clientState.blockedCounts['ui-routing']
  blockedCounts['saved-port-forward'] = clientState.blockedCounts['saved-port-forward']
  blockedCounts['workspace-session'] += clientState.blockedCount
  return {
    payload: {
      version: 1,
      worktreeMeta: worktreeMeta.sort((left, right) =>
        compareKeys(left.worktreeId, right.worktreeId)
      ),
      worktreeLineage: worktreeLineage.sort((left, right) =>
        compareKeys(left.worktreeId, right.worktreeId)
      ),
      workspaceLineage: workspaceLineage.sort((left, right) =>
        compareKeys(left.childWorkspaceKey, right.childWorkspaceKey)
      ),
      sparsePresets,
      retiredWorktreeNames,
      retiredWorktreeNamespaces: collectOrcadMigrationRetirementNamespaces(state, catalog),
      ...(workspaceSession.payload ? { workspaceSession: workspaceSession.payload } : {}),
      ...(workspaceSession.snapshots.length > 0
        ? { terminalScrollbackSnapshots: workspaceSession.snapshots }
        : {}),
      ...(automationState.automations.length > 0
        ? { automations: automationState.automations }
        : {}),
      ...(automationState.automationRuns.length > 0
        ? { automationRuns: automationState.automationRuns }
        : {}),
      ...(clientState.payload ? { clientState: clientState.payload } : {})
    },
    blockedCounts
  }
}

export function orcadMigrationDormantStateMatchesSource(
  state: PersistedState,
  manifest: OrcadMigrationManifest,
  storage?: TerminalScrollbackSnapshotStorage
): boolean {
  const current = collectOrcadMigrationSourceDormantState(
    state,
    manifest.source,
    manifest.payload,
    storage,
    manifest.destinationEnvironmentId
  ).payload
  return (
    serializeOrcadMigrationValue(current) ===
    serializeOrcadMigrationValue(manifest.payload.dormantState ?? emptyDormantPayload())
  )
}

export function assertOrcadMigrationSourceDormantStateRetired(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const dormant = manifest.payload.dormantState
  if (!dormant) {
    return
  }
  const hasRows =
    dormant.worktreeMeta.some((entry) => state.worktreeMeta[entry.sourceKey] !== undefined) ||
    dormant.worktreeLineage.some(
      (entry) => state.worktreeLineageById[entry.sourceKey] !== undefined
    ) ||
    dormant.workspaceLineage.some(
      (entry) => state.workspaceLineageByChildKey[entry.sourceKey] !== undefined
    ) ||
    dormant.sparsePresets.some((preset) =>
      state.sparsePresetsByRepo[preset.repoId]?.some((entry) => entry.id === preset.id)
    ) ||
    dormant.retiredWorktreeNames.some((entry) => {
      const registry = state.retiredWorktreeNamesByRepo?.[entry.repoId]
      return registry !== undefined && !isEmptyRetiredNameRegistry(registry)
    })
  if (hasRows) {
    throw new Error('orcad_migration_source_dormant_state_reappeared')
  }
  assertOrcadMigrationSourceWorkspaceSessionRetired(state, manifest)
  assertOrcadMigrationSourceAutomationStateRetired(state, manifest)
  assertOrcadMigrationClientStateRetired(state, manifest)
}

export function retireOrcadMigrationSourceDormantState(
  state: PersistedState,
  manifest: OrcadMigrationManifest,
  storage?: TerminalScrollbackSnapshotStorage
): void {
  const dormant = manifest.payload.dormantState
  if (!dormant) {
    return
  }
  dormant.worktreeMeta.forEach((entry) => delete state.worktreeMeta[entry.sourceKey])
  dormant.worktreeLineage.forEach((entry) => delete state.worktreeLineageById[entry.sourceKey])
  dormant.workspaceLineage.forEach(
    (entry) => delete state.workspaceLineageByChildKey[entry.sourceKey]
  )
  for (const preset of dormant.sparsePresets) {
    const remaining = (state.sparsePresetsByRepo[preset.repoId] ?? []).filter(
      (entry) => entry.id !== preset.id
    )
    if (remaining.length > 0) {
      state.sparsePresetsByRepo[preset.repoId] = remaining
    } else {
      delete state.sparsePresetsByRepo[preset.repoId]
    }
  }
  for (const entry of dormant.retiredWorktreeNames) {
    delete state.retiredWorktreeNamesByRepo?.[entry.repoId]
  }
  retireOrcadMigrationSourceWorkspaceSession(state, manifest)
  retireOrcadMigrationSourceAutomationState(state, manifest)
  retireOrcadMigrationClientState(state, manifest)
  const remainingRefs = new Set<string>()
  collectTerminalScrollbackSnapshotRefs(state.workspaceSession).forEach((ref) =>
    remainingRefs.add(ref)
  )
  for (const session of Object.values(state.workspaceSessionsByHostId ?? {})) {
    if (session) {
      collectTerminalScrollbackSnapshotRefs(session).forEach((ref) => remainingRefs.add(ref))
    }
  }
  for (const snapshot of dormant.terminalScrollbackSnapshots ?? []) {
    if (!remainingRefs.has(snapshot.ref)) {
      deleteTerminalScrollbackSnapshotSync(snapshot.ref, storage)
    }
  }
}

export function emptyDormantPayload(): OrcadMigrationDormantStatePayload {
  return {
    version: 1,
    worktreeMeta: [],
    worktreeLineage: [],
    workspaceLineage: [],
    sparsePresets: [],
    retiredWorktreeNames: [],
    retiredWorktreeNamespaces: []
  }
}

function uniqueDestinationRows<T>(
  rows: T[],
  key: (row: T) => string,
  onDuplicate: () => void
): T[] {
  const unique = new Map<string, T>()
  const duplicates = new Set<string>()
  for (const row of rows) {
    const rowKey = key(row)
    if (duplicates.has(rowKey)) {
      onDuplicate()
    } else if (unique.has(rowKey)) {
      unique.delete(rowKey)
      duplicates.add(rowKey)
      onDuplicate()
    } else {
      unique.set(rowKey, row)
    }
  }
  return [...unique.values()]
}

function emptyBlockedCounts(): Record<TransferredDormantKind, number> {
  return {
    'worktree-metadata': 0,
    'worktree-lineage': 0,
    'workspace-lineage': 0,
    'workspace-session': 0,
    automation: 0,
    'automation-run': 0,
    'sparse-preset': 0,
    'retired-worktree-name': 0,
    'mobile-tab-selection': 0,
    'ui-routing': 0,
    'saved-port-forward': 0
  }
}

function assertOrcadMigrationClientStateRetired(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const clientState = manifest.payload.dormantState?.clientState
  if (!clientState) {
    return
  }
  const source = manifest.source
  const scope = createOrcadMigrationSourceScope({ source, catalog: manifest.payload })
  for (const [deviceId, selections] of Object.entries(
    clientState.mobileClientTabSelectionsByDeviceId ?? {}
  )) {
    for (const ownerKey of Object.keys(selections)) {
      if (state.mobileClientTabSelectionsByDeviceId?.[deviceId]?.[ownerKey] !== undefined) {
        throw new Error('orcad_migration_source_mobile_selection_reappeared')
      }
    }
  }
  const ui = state.ui
  if (
    clientState.uiRouting?.lastActiveWorktreeId &&
    orcadMigrationOwnerMatchesScope(ui.lastActiveWorktreeId, scope)
  ) {
    throw new Error('orcad_migration_source_ui_routing_reappeared')
  }
  const target = state.sshTargets.find((entry) => entry.id === source.sshTargetId)
  if (
    clientState.savedPortForwards &&
    (!target ||
      serializeOrcadMigrationValue(target.portForwards ?? []) !==
        serializeOrcadMigrationValue(clientState.savedPortForwards))
  ) {
    throw new Error('orcad_migration_source_saved_port_forwards_changed')
  }
  for (const intent of clientState.clientHostedBrowserCloseIntents ?? []) {
    const sourceIntents =
      state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment?.[
        intent.sourceEnvironmentId
      ]
    if (
      sourceIntents?.some(
        (entry) =>
          entry.browserPageId === intent.browserPageId && entry.worktreeId === intent.worktreeId
      )
    ) {
      throw new Error('orcad_migration_source_close_intent_reappeared')
    }
    const destinationIntents =
      state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment?.[
        manifest.destinationEnvironmentId ?? ''
      ]
    const transferred = destinationIntents?.find(
      (entry) =>
        entry.browserPageId === intent.browserPageId && entry.worktreeId === intent.worktreeId
    )
    if (
      !transferred ||
      serializeOrcadMigrationValue(transferred) !==
        serializeOrcadMigrationValue({
          browserPageId: intent.browserPageId,
          worktreeId: intent.worktreeId,
          closedAt: intent.closedAt
        })
    ) {
      throw new Error('orcad_migration_source_close_intent_missing')
    }
  }
}

function retireOrcadMigrationClientState(
  state: PersistedState,
  manifest: OrcadMigrationManifest
): void {
  const clientState = manifest.payload.dormantState?.clientState
  if (!clientState) {
    return
  }
  const source = manifest.source
  const scope = createOrcadMigrationSourceScope({ source, catalog: manifest.payload })
  if (clientState.mobileClientTabSelectionsByDeviceId) {
    for (const [deviceId, captured] of Object.entries(
      clientState.mobileClientTabSelectionsByDeviceId
    )) {
      const selections = state.mobileClientTabSelectionsByDeviceId?.[deviceId]
      if (!selections) {
        continue
      }
      for (const ownerKey of Object.keys(captured)) {
        delete selections[ownerKey]
      }
      if (Object.keys(selections).length === 0) {
        delete state.mobileClientTabSelectionsByDeviceId?.[deviceId]
      }
    }
  }
  const target = state.sshTargets.find((entry) => entry.id === source.sshTargetId)
  if (target && clientState.savedPortForwards) {
    target.portForwards = structuredClone(clientState.savedPortForwards)
  }
  retireCloseIntents(state, clientState.clientHostedBrowserCloseIntents ?? [], manifest)
  rewriteDesktopUiForDestination(state, manifest, scope)
}

function retireCloseIntents(
  state: PersistedState,
  captured: readonly NonNullable<
    OrcadMigrationClientStatePayload['clientHostedBrowserCloseIntents']
  >[number][],
  manifest: OrcadMigrationManifest
): void {
  if (captured.length === 0) {
    return
  }
  const current = state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment ?? {}
  const next: Record<string, ClientHostedBrowserCloseIntent[]> = Object.fromEntries(
    Object.entries(current).map(([key, entries]) => [key, structuredClone(entries)])
  )
  const destinationEnvironmentId = manifest.destinationEnvironmentId
  if (!destinationEnvironmentId) {
    throw new Error('orcad_migration_source_close_intent_destination_invalid')
  }
  for (const intent of captured) {
    const sourceEntries = next[intent.sourceEnvironmentId] ?? []
    const sourceIndex = sourceEntries.findIndex(
      (entry) =>
        entry.browserPageId === intent.browserPageId && entry.worktreeId === intent.worktreeId
    )
    if (
      sourceIndex === -1 ||
      serializeOrcadMigrationValue(sourceEntries[sourceIndex]) !==
        serializeOrcadMigrationValue({
          browserPageId: intent.browserPageId,
          worktreeId: intent.worktreeId,
          closedAt: intent.closedAt
        })
    ) {
      throw new Error('orcad_migration_source_close_intent_changed')
    }
    sourceEntries.splice(sourceIndex, 1)
    if (sourceEntries.length === 0) {
      delete next[intent.sourceEnvironmentId]
    } else {
      next[intent.sourceEnvironmentId] = sourceEntries
    }
    const destinationEntries = next[destinationEnvironmentId] ?? []
    const existing = destinationEntries.find(
      (entry) =>
        entry.browserPageId === intent.browserPageId && entry.worktreeId === intent.worktreeId
    )
    if (existing) {
      if (
        serializeOrcadMigrationValue(existing) !==
        serializeOrcadMigrationValue({
          browserPageId: intent.browserPageId,
          worktreeId: intent.worktreeId,
          closedAt: intent.closedAt
        })
      ) {
        throw new Error('orcad_migration_close_intent_destination_conflict')
      }
      continue
    }
    if (destinationEntries.length >= MAX_CLIENT_HOSTED_BROWSER_CLOSE_INTENTS) {
      throw new Error('orcad_migration_close_intent_destination_capacity_exceeded')
    }
    destinationEntries.push({
      browserPageId: intent.browserPageId,
      worktreeId: intent.worktreeId,
      closedAt: intent.closedAt
    })
    next[destinationEnvironmentId] = destinationEntries
  }
  state.workspaceSession.clientHostedBrowserCloseIntentsByEnvironment = next
}

function rewriteDesktopUiForDestination(
  state: PersistedState,
  manifest: OrcadMigrationManifest,
  scope: ReturnType<typeof createOrcadMigrationSourceScope>
): void {
  const route = manifest.payload.dormantState?.clientState?.uiRouting
  const destinationEnvironmentId = manifest.destinationEnvironmentId
  if (!route || !destinationEnvironmentId) {
    return
  }
  if (
    route.lastActiveWorktreeId &&
    orcadMigrationOwnerMatchesScope(state.ui.lastActiveWorktreeId, scope)
  ) {
    state.ui.lastActiveWorktreeId = composeWorktreeHostIdentity(
      toRuntimeExecutionHostId(destinationEnvironmentId),
      route.lastActiveWorktreeId
    )
  }
  if (route.workspaceHostScope === 'local' && state.ui.workspaceHostScope === scope.hostId) {
    state.ui.workspaceHostScope = `runtime:${encodeURIComponent(destinationEnvironmentId)}`
  }
  if (route.visibleWorkspaceHostIds?.includes('local') && state.ui.visibleWorkspaceHostIds) {
    state.ui.visibleWorkspaceHostIds = state.ui.visibleWorkspaceHostIds.map((hostId) =>
      hostId === scope.hostId
        ? (`runtime:${encodeURIComponent(destinationEnvironmentId)}` as const)
        : hostId
    )
  }
  if (route.workspaceHostOrder?.includes('local')) {
    state.ui.workspaceHostOrder = (state.ui.workspaceHostOrder ?? []).map((hostId) =>
      hostId === scope.hostId
        ? (`runtime:${encodeURIComponent(destinationEnvironmentId)}` as const)
        : hostId
    )
  }
  if (route.manualRepoOrder) {
    const repoIds = new Set(route.manualRepoOrder.map((entry) => entry.repoId))
    state.ui.manualRepoOrder = (state.ui.manualRepoOrder ?? []).map((entry) =>
      entry.hostId === scope.hostId && repoIds.has(entry.repoId)
        ? { ...entry, hostId: `runtime:${encodeURIComponent(destinationEnvironmentId)}` as const }
        : entry
    )
  }
  if (route.showDotfilesByWorktree) {
    const next = { ...state.ui.showDotfilesByWorktree }
    for (const [ownerKey, enabled] of Object.entries(next)) {
      if (orcadMigrationOwnerMatchesScope(ownerKey, scope)) {
        delete next[ownerKey]
        next[
          `runtime:${encodeURIComponent(destinationEnvironmentId)}|${unqualifyOrcadMigrationOwnerKey(ownerKey)}`
        ] = enabled
      }
    }
    state.ui.showDotfilesByWorktree = next
  }
  if (route.automationHostFilter?.kind === 'host') {
    const current = parsePersistedAutomationHostFilter(state.ui.automationHostFilter)
    const sourceKey = hostStableKey({
      authority: { kind: 'desktop' },
      selector: { kind: 'ssh', targetId: scope.targetId }
    })
    if (current.kind === 'host' && hostStableKey(current.host) === sourceKey) {
      state.ui.automationHostFilter = structuredClone(route.automationHostFilter)
    }
  }
}

function compareKeys(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

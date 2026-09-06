import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { markdownFileIdCandidates } from '../../orca-profiles/profile-session-owner-transfer'
import { removeWorkspaceSessionOwners } from '../restoring-sessions/session-owner-removal'
import {
  orcadMigrationOwnerMatchesScope,
  type OrcadMigrationSourceScope
} from './orcad-source-scope'
import { collectSessionOwnerKeys } from './orcad-source-workspace-session-fragments'

export function removeOwnedSessionState(
  session: WorkspaceSessionState,
  scope: OrcadMigrationSourceScope
): WorkspaceSessionState {
  const ownerKeys = new Set(
    [...collectSessionOwnerKeys(session)].filter((ownerKey) =>
      orcadMigrationOwnerMatchesScope(ownerKey, scope)
    )
  )
  const removedMarkdownFileIds = new Set<string>()
  for (const [ownerKey, files] of Object.entries(session.openFilesByWorktree ?? {})) {
    if (!orcadMigrationOwnerMatchesScope(ownerKey, scope)) {
      continue
    }
    for (const file of files) {
      markdownFileIdCandidates(file.filePath, ownerKey, file.runtimeEnvironmentId).forEach((id) =>
        removedMarkdownFileIds.add(id)
      )
    }
  }
  const next = removeWorkspaceSessionOwners(session, ownerKeys) ?? session
  if (next.markdownFrontmatterVisible) {
    next.markdownFrontmatterVisible = Object.fromEntries(
      Object.entries(next.markdownFrontmatterVisible).filter(
        ([fileId]) => !removedMarkdownFileIds.has(fileId)
      )
    )
  }
  for (const repoId of scope.repoIds) {
    delete next.terminalTopologyRevisionByRepoId?.[repoId]
  }
  return next
}

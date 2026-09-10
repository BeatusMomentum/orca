// Agent-session tabs indexed by tab id, so a sidebar row can find the unified tab behind its
// pane key and read the session's own name from it.
//
// Split from worktree-agent-row-selectors.ts only because that file is at its line cap; the
// caching contract is the same one the indexes there use — rebuild on a new `unifiedTabsByWorktree`
// identity, hand back a stable map otherwise, so a row lookup allocates nothing on unrelated
// store updates.

import type { AppState } from '@/store/types'
import type { Tab } from '../../../../shared/tab-types'

type UnifiedTabsByWorktree = AppState['unifiedTabsByWorktree']

export const EMPTY_AGENT_SESSION_TABS: ReadonlyMap<string, Tab> = new Map()

let cache: {
  unifiedTabsByWorktree: UnifiedTabsByWorktree
  byWorktree: Map<string, Map<string, Tab>>
} | null = null

export function selectAgentSessionTabsByTabIdForWorktree(
  state: { unifiedTabsByWorktree?: UnifiedTabsByWorktree },
  worktreeId: string
): ReadonlyMap<string, Tab> {
  const unifiedTabsByWorktree = state.unifiedTabsByWorktree
  // `!cache` first: an undefined slice makes the identity compare equal against a null cache.
  if (!cache || cache.unifiedTabsByWorktree !== unifiedTabsByWorktree) {
    const byWorktree = new Map<string, Map<string, Tab>>()
    for (const [id, tabs] of Object.entries(unifiedTabsByWorktree ?? {})) {
      const index = new Map<string, Tab>()
      for (const tab of tabs) {
        if (tab.contentType === 'agent-session') {
          index.set(tab.id, tab)
        }
      }
      byWorktree.set(id, index)
    }
    cache = { unifiedTabsByWorktree, byWorktree }
  }
  return cache.byWorktree.get(worktreeId) ?? EMPTY_AGENT_SESSION_TABS
}

import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

export function effectiveWorktreeAgentRowStartedAt(entry: AgentStatusEntry): number {
  return entry.stateHistory[0]?.startedAt ?? entry.stateStartedAt
}

export function tabFromWorktreeAttributedStatusEntry(
  entry: AgentStatusEntry,
  effectiveStartedAt: number,
  unified?: Tab
): TerminalTab | null {
  const parsed = parsePaneKey(entry.paneKey)
  if (!parsed || !entry.worktreeId) {
    return null
  }
  return {
    id: parsed.tabId,
    ptyId: null,
    worktreeId: entry.worktreeId,
    title: entry.terminalTitle ?? 'Agent',
    // The user's own rename, and only that: customLabel means the user renamed this tab.
    customTitle: unified?.customLabel ?? null,
    color: null,
    sortOrder: Number.MAX_SAFE_INTEGER,
    // Why: missing-tab rows must keep their original clock through real state
    // transitions; current stateStartedAt is a status timestamp, not tab order.
    createdAt: effectiveStartedAt
  }
}

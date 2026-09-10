// The sidebar row reads the session's name from the unified agent-session tab the renderer
// already holds, so the record stays the one place the name lives.
import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { getAgentRowConversationName } from '../../../../shared/agent-row-conversation-name'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { Tab } from '../../../../shared/tab-types'
import { buildWorktreeAgentRows } from './worktree-agent-rows'
import { selectAgentSessionTabsByTabIdForWorktree } from './worktree-agent-session-tab-index'

const TAB_ID = 'structured-agent-session-session-1'
const PANE_KEY = makePaneKey(TAB_ID, '22222222-2222-4222-8222-222222222222')
const NOW = 1_000

function unifiedTab(overrides?: Partial<Tab>): Tab {
  return {
    id: TAB_ID,
    entityId: 'session-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    contentType: 'agent-session',
    agentSessionAgent: 'claude',
    agentSessionName: 'Fix the lease probe',
    label: 'Fix the lease probe',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0,
    ...overrides
  } as Tab
}

function attributedEntry(): AgentStatusEntry {
  return {
    paneKey: PANE_KEY,
    state: 'working',
    stateStartedAt: NOW,
    updatedAt: NOW,
    stateHistory: [],
    prompt: 'do the thing',
    agentType: 'claude',
    worktreeId: 'wt-1',
    terminalTitle: undefined,
    interrupted: false
  } as AgentStatusEntry
}

function rowFor(tab: Tab | undefined) {
  const [row] = buildWorktreeAgentRows({
    tabs: [],
    entries: [attributedEntry()],
    retained: [],
    agentSessionTabsByTabId: tab ? new Map([[TAB_ID, tab]]) : undefined,
    now: NOW
  })
  return row
}

describe('sidebar agent row session name', () => {
  it('carries the session name from the unified tab onto the row', () => {
    expect(rowFor(unifiedTab())?.sessionName).toBe('Fix the lease probe')
  })

  it('displays that name as the row conversation name', () => {
    const row = rowFor(unifiedTab())

    expect(
      getAgentRowConversationName(row.tab, row.agentType, false, undefined, row.sessionName)
    ).toBe('Fix the lease probe')
  })

  it('keeps a cwd-shaped name like `auth/login` instead of discarding it', () => {
    // The live-title sanitizer nulls `auth/login` as a cwd. A real session name must not reach it.
    const row = rowFor(unifiedTab({ agentSessionName: 'auth/login', label: 'auth/login' }))

    expect(
      getAgentRowConversationName(row.tab, row.agentType, false, undefined, row.sessionName)
    ).toBe('auth/login')
    // The sanitizer still owns scraped titles: the same text as a live title is still refused.
    expect(
      getAgentRowConversationName({ ...row.tab, title: 'auth/login' }, row.agentType, false)
    ).toBeNull()
  })

  it("shows the user's rename over the session name", () => {
    const row = rowFor(unifiedTab({ customLabel: 'My chat' }))

    expect(
      getAgentRowConversationName(row.tab, row.agentType, false, undefined, row.sessionName)
    ).toBe('My chat')
  })

  it('falls back to the existing path for a row with no unified tab', () => {
    const row = rowFor(undefined)

    // Known and deliberate: an attributed row whose tab has not arrived has no name to read,
    // and behaves exactly as it does on main.
    expect(row.sessionName).toBeNull()
    expect(
      getAgentRowConversationName(row.tab, row.agentType, false, undefined, row.sessionName)
    ).toBeNull()
  })
})

describe('selectAgentSessionTabsByTabIdForWorktree', () => {
  it('indexes only agent-session tabs, and returns a stable map for the same slice', () => {
    const unifiedTabsByWorktree = {
      'wt-1': [unifiedTab(), { ...unifiedTab({ id: 'term-1' }), contentType: 'terminal' } as Tab]
    }

    const first = selectAgentSessionTabsByTabIdForWorktree({ unifiedTabsByWorktree }, 'wt-1')

    expect([...first.keys()]).toEqual([TAB_ID])
    expect(selectAgentSessionTabsByTabIdForWorktree({ unifiedTabsByWorktree }, 'wt-1')).toBe(first)
  })

  it('survives a store slice that has no unified tabs at all', () => {
    expect(selectAgentSessionTabsByTabIdForWorktree({}, 'wt-1').size).toBe(0)
  })
})

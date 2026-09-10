// The published tab is where every client reads the session's name, so the restore sweep must
// carry the record's name onto it and a name that arrives later must still reach a client.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import type { RuntimeMobileSessionTabsResult } from '../../shared/runtime-types'
import { OrcaRuntimeService } from './orca-runtime'

afterEach(() => setStructuredAgentSessionHost(null))

type RuntimeInternals = {
  hasPersistedStructuredAgentSessionStore(): boolean
  getKnownWorkspaceSessionWorktreeIds(): Set<string>
  hydrateHeadlessMobileSessionTabsFromWorkspaceSession(): Set<string>
  refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  ensureStructuredAgentSessionHost(): Promise<void>
}

function stubRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  const internal = runtime as unknown as RuntimeInternals
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.getKnownWorkspaceSessionWorktreeIds = () => new Set()
  internal.hydrateHeadlessMobileSessionTabsFromWorkspaceSession = () => new Set()
  internal.refreshMobileSessionPtyRecords = async () => new Set()
  internal.ensureStructuredAgentSessionHost = async () => undefined
  return runtime
}

function installHost(tab: { title?: string }): void {
  setStructuredAgentSessionHost({
    reconcileRestartLeases: async () => undefined,
    restoreReadableSessions: async () => undefined,
    setSessionTabVisibility: async () => undefined,
    listSessionTabs: () => [
      { sessionId: 'restored-session', workspaceId: 'workspace-1', agent: 'codex', ...tab }
    ]
  } as never)
}

async function agentTabAfterRestore(tab: { title?: string }) {
  const runtime = stubRuntime()
  installHost(tab)

  await runtime.restoreStructuredAgentSessionTabs()

  const snapshot = await runtime.listMobileSessionTabs('id:workspace-1')
  return snapshot.tabs.find((candidate) => candidate.type === 'agent-session')
}

describe('restored agent-session tab naming', () => {
  it("publishes the record's name instead of the placeholder", async () => {
    const tab = await agentTabAfterRestore({ title: 'Fix the lease probe' })

    expect(tab?.title).toBe('Fix the lease probe')
    // Provenance: `title` alone cannot tell a real name from the placeholder.
    expect(tab?.sessionName).toBe('Fix the lease probe')
  })

  it('falls back to the placeholder when the session has no name', async () => {
    const tab = await agentTabAfterRestore({})

    expect(tab?.title).toBe('Codex Chat')
    expect(tab?.sessionName).toBeUndefined()
  })
})

describe('renameStructuredAgentSessionTab', () => {
  it('emits the renamed tab, because publish early-returns on an existing tab', async () => {
    const runtime = stubRuntime()
    installHost({})
    await runtime.restoreStructuredAgentSessionTabs()
    const emitted: RuntimeMobileSessionTabsResult[] = []
    const unsubscribe = runtime.onMobileSessionTabsChanged((snapshot) => emitted.push(snapshot))

    await runtime.renameStructuredAgentSessionTab(
      'workspace-1',
      'restored-session',
      'Fix the lease probe'
    )

    const after = await runtime.listMobileSessionTabs('id:workspace-1')
    const renamed = after.tabs.find((tab) => tab.type === 'agent-session')
    expect(renamed?.title).toBe('Fix the lease probe')
    expect(renamed?.sessionName).toBe('Fix the lease probe')
    expect(emitted).toHaveLength(1)
    unsubscribe()
  })

  it('restores the placeholder when the name is cleared', async () => {
    const runtime = stubRuntime()
    installHost({ title: 'Fix the lease probe' })
    await runtime.restoreStructuredAgentSessionTabs()

    await runtime.renameStructuredAgentSessionTab('workspace-1', 'restored-session', null)

    const after = await runtime.listMobileSessionTabs('id:workspace-1')
    const renamed = after.tabs.find((tab) => tab.type === 'agent-session')
    expect(renamed?.title).toBe('Codex Chat')
    expect(renamed?.sessionName).toBeUndefined()
  })

  it('ignores a session that has no published tab', async () => {
    const runtime = stubRuntime()
    const emit = vi.fn()
    const unsubscribe = runtime.onMobileSessionTabsChanged(emit)

    await runtime.renameStructuredAgentSessionTab('workspace-1', 'never-published', 'A name')

    expect(emit).not.toHaveBeenCalled()
    unsubscribe()
  })
})

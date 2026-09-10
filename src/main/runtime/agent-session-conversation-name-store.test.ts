// The name is durable state on the record, and the entry point below is the only way it is set.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionExecutionLocation } from '../../shared/agent-session-record'
import { setStructuredAgentSessionConversationName } from '../native-chat/structured-agent-session-conversation-name'
import { AgentSessionRecordStore } from './agent-session-record-store'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

const NOW = 1_800_000_000_000
const SESSION = 'session-alpha'
const NATIVE: AgentSessionExecutionLocation = {
  executionHostId: 'local',
  wslDistro: null,
  workspaceId: 'workspace-1',
  workspaceKind: 'git-worktree'
}

let counter = 0
/** Same shape the store's own suite uses: `<now>-<32 hex>`. */
function operationId(): string {
  counter += 1
  return `${NOW}-${String(counter)
    .padStart(32, '0')
    .replaceAll(/[^0-9a-f]/g, '0')}`
}

const reserveRequest = (): AgentSessionReserveRequest => ({
  sessionId: SESSION,
  location: NATIVE,
  provider: 'claude',
  accountHome: { variable: 'CLAUDE_CONFIG_DIR', path: '/home/dev/.claude-work' },
  runtimeKind: 'native',
  expectedFence: null,
  spawnToken: 'spawn-a',
  claimKeyId: 'key-1',
  handoffOperationId: null,
  probe: { outcome: 'indeterminate', reason: 'no answer' },
  operation: { callerKey: 'client-1', operationId: operationId(), fingerprint: 'fp-1' },
  now: NOW
})

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-conversation-name-store-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function reservedStore(): Promise<AgentSessionRecordStore> {
  const store = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
  await store.reserveOwner(reserveRequest())
  return store
}

describe('AgentSessionRecordStore.setConversationName', () => {
  it('stores the name and survives a reload, so the record is where it lives', async () => {
    const store = await reservedStore()

    await store.setConversationName(SESSION, 'Fix the lease probe')

    const reloaded = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    expect(reloaded.getRecord(SESSION)?.conversationName).toBe('Fix the lease probe')
  })

  it('normalizes at the boundary, so no caller can persist an invalid record', async () => {
    const store = await reservedStore()

    await store.setConversationName(SESSION, `Fix\nthe  ${'x'.repeat(400)}`)

    const name = store.getRecord(SESSION)?.conversationName ?? ''
    expect(name).toHaveLength(200)
    expect(name.startsWith('Fix the ')).toBe(true)
    // A reload validates every record; an over-long name would be dropped as unreadable.
    const reloaded = await AgentSessionRecordStore.open({ directory, hostId: 'local' })
    expect(reloaded.getRecord(SESSION)?.conversationName).toBe(name)
  })

  it('clears the name with null', async () => {
    const store = await reservedStore()
    await store.setConversationName(SESSION, 'Fix the lease probe')

    await store.setConversationName(SESSION, null)

    expect(store.getRecord(SESSION)?.conversationName).toBeUndefined()
  })

  it('does not need the lease: an unfenced rename never contends with the writer', async () => {
    const store = await reservedStore()

    // No fence argument exists to pass, and no fence error is raised.
    await expect(store.setConversationName(SESSION, 'Fix the lease probe')).resolves.toBeDefined()
  })

  it('refuses a session it has no record for', async () => {
    const store = await reservedStore()

    await expect(store.setConversationName('missing', 'A name')).rejects.toThrow(
      'agent_session_identity_required'
    )
  })
})

describe('setStructuredAgentSessionConversationName', () => {
  it('stores the name and renames the published tab from the record', async () => {
    const store = await reservedStore()
    const renameStructuredAgentSessionTab = vi.fn(async () => undefined)

    await setStructuredAgentSessionConversationName(
      { store, tabs: { renameStructuredAgentSessionTab } },
      SESSION,
      'Fix the lease probe'
    )

    expect(store.getRecord(SESSION)?.conversationName).toBe('Fix the lease probe')
    // The workspace comes from the record, never from the caller.
    expect(renameStructuredAgentSessionTab).toHaveBeenCalledWith(
      'workspace-1',
      SESSION,
      'Fix the lease probe'
    )
  })

  it('renames the tab with the stored value, not the raw caller text', async () => {
    const store = await reservedStore()
    const renameStructuredAgentSessionTab = vi.fn(async () => undefined)

    await setStructuredAgentSessionConversationName(
      { store, tabs: { renameStructuredAgentSessionTab } },
      SESSION,
      'Fix\nthe   probe'
    )

    expect(renameStructuredAgentSessionTab).toHaveBeenCalledWith(
      'workspace-1',
      SESSION,
      'Fix the probe'
    )
  })

  it('clears the record and the tab together', async () => {
    const store = await reservedStore()
    const renameStructuredAgentSessionTab = vi.fn(async () => undefined)
    const deps = { store, tabs: { renameStructuredAgentSessionTab } }
    await setStructuredAgentSessionConversationName(deps, SESSION, 'Fix the probe')

    await setStructuredAgentSessionConversationName(deps, SESSION, null)

    expect(store.getRecord(SESSION)?.conversationName).toBeUndefined()
    expect(renameStructuredAgentSessionTab).toHaveBeenLastCalledWith('workspace-1', SESSION, null)
  })

  it('clears when the caller text normalizes to nothing', async () => {
    const store = await reservedStore()
    const renameStructuredAgentSessionTab = vi.fn(async () => undefined)
    const deps = { store, tabs: { renameStructuredAgentSessionTab } }
    await setStructuredAgentSessionConversationName(deps, SESSION, 'Fix the probe')

    await setStructuredAgentSessionConversationName(deps, SESSION, '‮​ ')

    expect(store.getRecord(SESSION)?.conversationName).toBeUndefined()
    expect(renameStructuredAgentSessionTab).toHaveBeenLastCalledWith('workspace-1', SESSION, null)
  })
})

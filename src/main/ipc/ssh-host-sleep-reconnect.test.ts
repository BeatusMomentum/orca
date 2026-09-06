import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  off: vi.fn(),
  on: vi.fn(),
  recoverManagedTunnels: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('electron', () => ({ powerMonitor: { off: mocks.off, on: mocks.on } }))
vi.mock('../ssh/orcad-managed-tunnel', () => ({
  recoverOrcadManagedTunnelsAfterHostResume: mocks.recoverManagedTunnels
}))
vi.mock('./ssh-active-relay-sessions', () => ({ activeSessions: new Map() }))
vi.mock('./ssh-ipc-context', () => ({ connectionManager: null }))

import {
  registerPowerMonitorReconnect,
  unregisterPowerMonitorReconnect
} from './ssh-host-sleep-reconnect'

describe('SSH host sleep reconnect', () => {
  afterEach(() => {
    unregisterPowerMonitorReconnect()
    mocks.off.mockReset()
    mocks.on.mockReset()
    mocks.recoverManagedTunnels.mockReset().mockResolvedValue(undefined)
  })

  it('runs managed-tunnel wake recovery with the production probe policy', async () => {
    registerPowerMonitorReconnect(() => '/canonical-user-data')
    const resume = mocks.on.mock.calls.find(([event]) => event === 'resume')?.[1]
    expect(resume).toBeTypeOf('function')

    resume()

    await vi.waitFor(() =>
      expect(mocks.recoverManagedTunnels).toHaveBeenCalledWith('/canonical-user-data', {
        attempts: 2,
        timeoutMs: 5_000
      })
    )
  })
})

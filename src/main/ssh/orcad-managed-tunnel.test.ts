import { describe, expect, it, vi } from 'vitest'
import { createEnvironmentFromPairingOffer } from '../../shared/runtime-environments'
import { PAIRING_OFFER_VERSION } from '../../shared/pairing'
import type { SshTarget } from '../../shared/ssh-types'
import type { SshConnection } from './ssh-connection'
import type { SshConnectionManager } from './ssh-connection-manager'
import type { SshConnectionStore } from './ssh-connection-store'
import type { SshPortForwardManager } from './ssh-port-forward'
import { OrcadManagedTunnelManager } from './orcad-managed-tunnel'

function environment() {
  return createEnvironmentFromPairingOffer({
    id: 'environment-1',
    name: 'Managed server',
    now: 1,
    offer: {
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://127.0.0.1:46768',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key'
    },
    connectionDependency: 'ssh-tunnel',
    orcadDeployment: {
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 7,
      localPort: 46_768,
      remotePort: 6_768
    }
  })
}

function setup(overrides: Partial<SshTarget> = {}) {
  const target: SshTarget = {
    id: 'ssh-1',
    label: 'Managed server',
    host: 'example.com',
    port: 22,
    username: 'deploy',
    generation: 7,
    owner: { type: 'orcad-runtime', environmentId: 'environment-1' },
    ...overrides
  }
  let transportGeneration = 3
  const connection = {
    getTransportGeneration: vi.fn(() => transportGeneration)
  } as unknown as SshConnection
  const connect = vi.fn().mockResolvedValue(connection)
  const reconnect = vi.fn().mockImplementation(async () => {
    transportGeneration += 1
  })
  const getConnection = vi.fn(() => connection)
  const getState = vi.fn(() => ({ status: 'connected' }))
  const probeTunnel = vi.fn().mockResolvedValue(true)
  const addForward = vi
    .fn()
    .mockImplementation(
      async (
        connectionId: string,
        _connection: SshConnection,
        localPort: number,
        _remoteHost: string,
        remotePort: number
      ) => ({
        id: `forward-${addForward.mock.calls.length}`,
        connectionId,
        localPort,
        remoteHost: '127.0.0.1',
        remotePort
      })
    )
  const removeForwardAndWait = vi.fn().mockResolvedValue(null)
  const forwardManager = {
    setCallbacks: vi.fn(),
    addForward,
    removeForwardAndWait,
    dispose: vi.fn()
  } as unknown as SshPortForwardManager
  const connectionManager = {
    connect,
    getConnection,
    getState,
    reconnect
  } as unknown as SshConnectionManager
  const manager = new OrcadManagedTunnelManager({
    getConnectionManager: () => connectionManager,
    getTargetStore: () => ({ getTarget: vi.fn(() => target) }) as unknown as SshConnectionStore,
    forwardManager,
    probeTunnel
  })
  return {
    addForward,
    connect,
    connection,
    getConnection,
    getState,
    manager,
    probeTunnel,
    reconnect,
    removeForwardAndWait,
    setTransportGeneration: (generation: number) => {
      transportGeneration = generation
    }
  }
}

function resumeOptions() {
  return {
    attempts: 2,
    resolveEnvironment: () => environment(),
    timeoutMs: 5_000
  }
}

describe('OrcadManagedTunnelManager', () => {
  it('connects through the raw SSH manager and creates the exact loopback forward', async () => {
    const state = setup()

    await state.manager.ensure(environment())

    expect(state.connect).toHaveBeenCalledOnce()
    expect(state.addForward).toHaveBeenCalledWith(
      'ssh-1',
      expect.anything(),
      46_768,
      '127.0.0.1',
      6_768,
      'Managed Orca server: Managed server'
    )
  })

  it('reuses a tunnel only for the same SSH transport generation', async () => {
    const state = setup()

    await state.manager.ensure(environment())
    await state.manager.ensure(environment())
    expect(state.addForward).toHaveBeenCalledOnce()

    state.setTransportGeneration(4)
    await state.manager.ensure(environment())

    expect(state.removeForwardAndWait).toHaveBeenCalledWith('forward-1')
    expect(state.addForward).toHaveBeenCalledTimes(2)
  })

  it('fails closed when the SSH registration generation changed', async () => {
    const state = setup({ generation: 8 })

    await expect(state.manager.ensure(environment())).rejects.toThrow('removed or re-created')
    expect(state.connect).not.toHaveBeenCalled()
  })

  it('fails closed when another environment owns the target', async () => {
    const state = setup({ owner: { type: 'orcad-runtime', environmentId: 'environment-2' } })

    await expect(state.manager.ensure(environment())).rejects.toThrow('no longer owned')
    expect(state.connect).not.toHaveBeenCalled()
  })

  it('coalesces concurrent tunnel preflights', async () => {
    const state = setup()
    let finishConnect!: () => void
    state.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishConnect = () => resolve(state.connection)
        })
    )

    const first = state.manager.ensure(environment())
    const second = state.manager.ensure(environment())
    finishConnect()
    await Promise.all([first, second])

    expect(state.connect).toHaveBeenCalledOnce()
    expect(state.addForward).toHaveBeenCalledOnce()
  })

  it('keeps a healthy managed tunnel intact after host resume', async () => {
    const state = setup()
    await state.manager.ensure(environment())

    await state.manager.recoverAfterHostResume(resumeOptions())

    expect(state.probeTunnel).toHaveBeenCalledOnce()
    expect(state.probeTunnel).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'environment-1' }),
      5_000
    )
    expect(state.reconnect).not.toHaveBeenCalled()
    expect(state.removeForwardAndWait).not.toHaveBeenCalled()
  })

  it('retries a failed wake probe before reconnecting', async () => {
    const state = setup()
    state.probeTunnel.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    await state.manager.ensure(environment())

    await state.manager.recoverAfterHostResume(resumeOptions())

    expect(state.probeTunnel).toHaveBeenCalledTimes(2)
    expect(state.reconnect).not.toHaveBeenCalled()
  })

  it('reconnects and rebuilds the exact persisted port after failed wake probes', async () => {
    const state = setup()
    state.probeTunnel.mockResolvedValue(false)
    await state.manager.ensure(environment())

    await state.manager.recoverAfterHostResume(resumeOptions())

    expect(state.reconnect).toHaveBeenCalledOnce()
    expect(state.reconnect).toHaveBeenCalledWith('ssh-1')
    expect(state.removeForwardAndWait).toHaveBeenCalledWith('forward-1')
    expect(state.addForward).toHaveBeenLastCalledWith(
      'ssh-1',
      state.connection,
      46_768,
      '127.0.0.1',
      6_768,
      'Managed Orca server: Managed server'
    )

    await state.manager.ensure(environment())
    expect(state.addForward).toHaveBeenCalledTimes(2)
  })

  it('coalesces concurrent host-resume recoveries', async () => {
    const state = setup()
    let finishProbe!: () => void
    state.probeTunnel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = () => resolve(true)
        })
    )
    await state.manager.ensure(environment())

    const first = state.manager.recoverAfterHostResume(resumeOptions())
    const second = state.manager.recoverAfterHostResume(resumeOptions())
    expect(second).toBe(first)
    finishProbe()
    await Promise.all([first, second])

    expect(state.probeTunnel).toHaveBeenCalledOnce()
  })

  it('does not reconnect an environment closed during its wake probe', async () => {
    const state = setup()
    let finishProbe!: () => void
    state.probeTunnel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishProbe = () => resolve(false)
        })
    )
    await state.manager.ensure(environment())

    const recovery = state.manager.recoverAfterHostResume({
      ...resumeOptions(),
      attempts: 1
    })
    await vi.waitFor(() => expect(state.probeTunnel).toHaveBeenCalledOnce())
    await state.manager.close('environment-1')
    finishProbe()
    await recovery

    expect(state.reconnect).not.toHaveBeenCalled()
    expect(state.addForward).toHaveBeenCalledOnce()
  })

  it('does not rebuild when reconnect did not establish a newer transport', async () => {
    const state = setup()
    state.probeTunnel.mockResolvedValue(false)
    state.reconnect.mockImplementationOnce(async () => undefined)
    await state.manager.ensure(environment())

    await state.manager.recoverAfterHostResume({
      ...resumeOptions(),
      attempts: 1
    })

    expect(state.reconnect).toHaveBeenCalledOnce()
    expect(state.removeForwardAndWait).not.toHaveBeenCalled()
    expect(state.addForward).toHaveBeenCalledOnce()
  })
})

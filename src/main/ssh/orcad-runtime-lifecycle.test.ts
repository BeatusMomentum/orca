import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  addEnvironment: vi.fn(),
  beginCutover: vi.fn(),
  closeTunnel: vi.fn(),
  commitDestination: vi.fn(),
  connect: vi.fn(),
  collectCensus: vi.fn(),
  createManifest: vi.fn(),
  deploy: vi.fn(),
  encodePairingOffer: vi.fn(),
  ensureTunnel: vi.fn(),
  getPreferredPairingOffer: vi.fn(),
  hasDirectAuthority: vi.fn(),
  listCutovers: vi.fn(),
  listEnvironments: vi.fn(),
  materialize: vi.fn(),
  probeReadiness: vi.fn(),
  readTransaction: vi.fn(),
  readRecord: vi.fn(),
  recover: vi.fn(),
  requestDecommission: vi.fn(),
  retireSource: vi.fn(),
  removeEnvironment: vi.fn(),
  restoreEnvironmentLink: vi.fn(),
  releaseTarget: vi.fn(),
  resolveContext: vi.fn(),
  resolveEnvironment: vi.fn(),
  resolveNodeFallback: vi.fn(),
  startTunnel: vi.fn(),
  stopRemote: vi.fn(),
  tunnelPairingCode: vi.fn(),
  updateEnvironment: vi.fn()
}))

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    randomUUID: () => 'environment-1'
  }
})
vi.mock('../../shared/runtime-environment-store', () => ({
  addEnvironmentFromPairingCode: mocks.addEnvironment,
  listEnvironments: mocks.listEnvironments,
  removeEnvironment: mocks.removeEnvironment,
  restoreManagedOrcadEnvironmentLink: mocks.restoreEnvironmentLink,
  resolveEnvironment: mocks.resolveEnvironment,
  updateEnvironmentFromPairingCode: mocks.updateEnvironment
}))
vi.mock('../../shared/runtime-environments', () => ({
  getPreferredLoopbackRuntimePort: () => 46_768,
  getPreferredPairingOffer: mocks.getPreferredPairingOffer,
  redactRuntimeEnvironment: (environment: unknown) => environment
}))
vi.mock('../../shared/pairing', () => ({ encodePairingOffer: mocks.encodePairingOffer }))
vi.mock('./orcad-artifact-materializer', () => ({
  materializeOrcadArtifact: mocks.materialize
}))
vi.mock('./orcad-managed-tunnel', () => ({
  closeOrcadManagedTunnel: mocks.closeTunnel,
  ensureOrcadManagedTunnel: mocks.ensureTunnel,
  startOrcadManagedTunnel: mocks.startTunnel
}))
vi.mock('./orcad-active-readiness', () => ({
  probeActiveOrcadReadiness: mocks.probeReadiness
}))
vi.mock('./orcad-remote-context', () => ({
  resolveOrcadRemoteContext: mocks.resolveContext
}))
vi.mock('./orcad-remote-deploy', () => ({ deployOrcad: mocks.deploy }))
vi.mock('./orcad-activation-recovery', () => ({
  recoverInterruptedOrcadActivation: mocks.recover
}))
vi.mock('./orcad-activation-transaction-store', () => ({
  readOrcadActivationTransaction: mocks.readTransaction
}))
vi.mock('./orcad-activation-record-store', () => ({
  readOrcadActivationRecord: mocks.readRecord
}))
vi.mock('./orcad-remote-rollback', () => ({ rollbackOrcad: vi.fn() }))
vi.mock('./orcad-remote-stop', () => ({ stopRemoteOrcad: mocks.stopRemote }))
vi.mock('./orcad-decommission-client', () => ({
  requestRemoteOrcadDecommission: mocks.requestDecommission
}))
vi.mock('./orcad-slot-runtime-eligibility', () => ({
  resolveOrcadSlotNodeFallback: mocks.resolveNodeFallback
}))
vi.mock('./orcad-terminal-census-client', () => ({
  collectRemoteOrcadTerminalCensus: mocks.collectCensus
}))
vi.mock('./orcad-tunneled-pairing', () => ({
  tunneledOrcadPairingCode: mocks.tunnelPairingCode
}))
vi.mock('./orcad-migration-manifest-export', () => ({
  createOrcadMigrationManifest: mocks.createManifest
}))
vi.mock('./orcad-migration-cutover-coordinator', () => ({
  beginOrcadMigrationSourceCutoverDurably: mocks.beginCutover,
  commitOrcadMigrationDestination: mocks.commitDestination,
  retireOrcadMigrationSourceCatalogDurably: mocks.retireSource
}))

const operationOrder: string[] = []
const target = {
  id: 'ssh-1',
  label: 'Server',
  host: 'server.example',
  port: 22,
  username: 'deploy',
  generation: 7
}
const claimedTarget = {
  ...target,
  owner: { type: 'orcad-runtime' as const, environmentId: 'environment-1' }
}
const migrationManifest = {
  version: 1 as const,
  migrationId: 'migration-1',
  manifestSha256: 'a'.repeat(64),
  createdAt: '2026-08-30T00:00:00.000Z',
  source: {
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 7,
    targetLabel: 'Server'
  },
  payload: { repositories: [], projectGroups: [], folderWorkspaces: [] }
}
const sourceCutover = {
  version: 1 as const,
  phase: 'source-fenced' as const,
  destinationEnvironmentId: 'environment-1',
  destinationName: 'Managed server',
  manifest: migrationManifest,
  startedAt: '2026-08-30T00:00:00.000Z',
  updatedAt: '2026-08-30T00:00:00.000Z'
}
const migrationStore = {
  flushPendingOrThrowAsync: vi.fn().mockResolvedValue(undefined),
  listOrcadMigrationSourceCutovers: mocks.listCutovers
}
const managedEnvironment = {
  id: 'environment-1',
  name: 'Managed server',
  createdAt: 1_000,
  updatedAt: 1_000,
  lastUsedAt: null,
  runtimeId: null,
  connectionDependency: 'ssh-tunnel' as const,
  orcadDeployment: {
    sshTargetId: 'ssh-1',
    sshTargetGeneration: 7,
    localPort: 46_768,
    remotePort: 6_768
  },
  endpoints: [
    {
      id: 'ws-environment-1',
      kind: 'websocket' as const,
      label: 'WebSocket',
      endpoint: 'ws://127.0.0.1:46768',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key'
    }
  ],
  preferredEndpointId: 'ws-environment-1'
}
const targetStore = {
  assertOrcadRuntimeTargetClaimable: vi.fn(() => {
    operationOrder.push('assert')
    return target
  }),
  claimOrcadRuntimeTarget: vi.fn(() => {
    operationOrder.push('claim')
    return claimedTarget
  }),
  getTarget: vi.fn((_targetId: string): typeof target | typeof claimedTarget => claimedTarget),
  ensureOrcadRuntimeTargetGeneration: vi.fn(() => claimedTarget),
  getOrcadMigrationStore: vi.fn(() => migrationStore),
  releaseOrcadRuntimeTarget: mocks.releaseTarget
}

vi.mock('./ssh-target-registry', () => ({
  getSshConnectionManager: () => ({ connect: mocks.connect }),
  getSshTargetRegistryStore: () => targetStore,
  hasRegisteredDirectSshAuthority: mocks.hasDirectAuthority
}))

const {
  createManagedOrcadEnvironment,
  getManagedOrcadRuntimeStatus,
  listPendingManagedOrcadMigrations,
  recoverManagedOrcadEnvironment,
  stopManagedOrcadEnvironment
} = await import('./orcad-runtime-lifecycle')

const readiness = {
  type: 'orca_server_ready',
  runtimeId: 'runtime-1',
  endpoint: 'ws://127.0.0.1:6768'
}
const environment = {
  id: 'environment-1',
  name: 'Managed server'
}

beforeEach(() => {
  vi.clearAllMocks()
  operationOrder.length = 0
  targetStore.ensureOrcadRuntimeTargetGeneration.mockImplementation(() => {
    operationOrder.push('ensure-generation')
    return claimedTarget
  })
  migrationStore.flushPendingOrThrowAsync.mockImplementation(async () => {
    operationOrder.push('flush-generation')
  })
  mocks.hasDirectAuthority.mockReturnValue(false)
  mocks.listCutovers.mockReturnValue([])
  mocks.listEnvironments.mockReturnValue([])
  mocks.createManifest.mockReturnValue(migrationManifest)
  mocks.beginCutover.mockImplementation(async () => {
    operationOrder.push('begin')
    return sourceCutover
  })
  mocks.commitDestination.mockResolvedValue(sourceCutover)
  mocks.retireSource.mockResolvedValue(sourceCutover)
  mocks.getPreferredPairingOffer.mockReturnValue({})
  mocks.encodePairingOffer.mockReturnValue('orca://pair?existing')
  mocks.connect.mockImplementation(async () => {
    operationOrder.push('connect')
    return { getTransportGeneration: () => 1 }
  })
  mocks.resolveContext.mockResolvedValue({
    activationRecord: { active: null, previous: null, activatedAt: null, snapshot: null },
    bunTarget: 'linux-x64-glibc',
    connection: {},
    host: { platform: 'linux', pathFlavor: 'posix', commandDialect: 'posix' },
    remoteHome: '/home/deploy',
    target: claimedTarget,
    userDataDir: '/home/deploy/.orca'
  })
  mocks.materialize.mockResolvedValue('/local/orcad')
  mocks.deploy.mockResolvedValue({
    outcome: 'installed-and-activated',
    fullVersion: '0.1.0+abc123',
    verdict: { decision: 'accept' },
    readiness
  })
  mocks.startTunnel.mockResolvedValue(46_768)
  mocks.tunnelPairingCode.mockReturnValue('orca://pair?managed')
  mocks.addEnvironment.mockReturnValue(environment)
  mocks.removeEnvironment.mockReturnValue(managedEnvironment)
  mocks.restoreEnvironmentLink.mockReturnValue(managedEnvironment)
  mocks.updateEnvironment.mockReturnValue(managedEnvironment)
  mocks.resolveEnvironment.mockReturnValue(managedEnvironment)
  mocks.closeTunnel.mockResolvedValue(undefined)
  mocks.ensureTunnel.mockResolvedValue(undefined)
  mocks.collectCensus.mockResolvedValue({ liveSessions: 0, startedSinceActivation: 0 })
  mocks.stopRemote.mockResolvedValue({
    outcome: 'stopped',
    activeVersion: '0.1.0+abc123',
    alreadyDeactivated: false
  })
  mocks.releaseTarget.mockReturnValue(target)
  mocks.readTransaction.mockResolvedValue(null)
  mocks.readRecord.mockResolvedValue({
    active: null,
    previous: null,
    activatedAt: null,
    snapshot: null
  })
  mocks.recover.mockResolvedValue({ outcome: 'none' })
})

describe('createManagedOrcadEnvironment', () => {
  it('durably fences the SSH target before the first remote deployment boundary', async () => {
    const result = await createManagedOrcadEnvironment('/user-data', {
      name: 'Managed server',
      sshTargetId: 'ssh-1'
    })

    expect(operationOrder.slice(0, 5)).toEqual([
      'assert',
      'begin',
      'ensure-generation',
      'flush-generation',
      'connect'
    ])
    expect(mocks.beginCutover).toHaveBeenCalledWith(
      expect.objectContaining({
        destinationEnvironmentId: 'environment-1',
        destinationName: 'Managed server',
        manifest: migrationManifest
      })
    )
    expect(mocks.connect).toHaveBeenCalledWith(claimedTarget)
    expect(mocks.addEnvironment).toHaveBeenCalledWith(
      '/user-data',
      expect.objectContaining({
        id: 'environment-1',
        orcadDeployment: expect.objectContaining({ sshTargetGeneration: 7 })
      })
    )
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.commitDestination).toHaveBeenCalledWith(
      expect.objectContaining({ migrationId: 'migration-1', pairingCode: 'orca://pair?managed' })
    )
    expect(mocks.retireSource).toHaveBeenCalledWith(
      expect.objectContaining({ migrationId: 'migration-1' })
    )
    expect(result).toMatchObject({ outcome: 'created', environment })
  })

  it('keeps the durable fence when deployment is deferred', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.2.0+def456',
      code: 'orcad_update_terminals_running',
      reason: 'Terminals are still live.'
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).resolves.toMatchObject({
      outcome: 'deferred',
      code: 'orcad_update_terminals_running',
      forceable: true
    })

    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.addEnvironment).not.toHaveBeenCalled()
  })

  it('marks an ownership refusal non-forceable and keeps the durable fence', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.2.0+def456',
      code: 'orcad_initial_runtime_live',
      reason: 'An unmanaged runtime owns the data root.'
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1',
        force: true
      })
    ).resolves.toMatchObject({
      outcome: 'deferred',
      code: 'orcad_initial_runtime_live',
      forceable: false
    })

    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('keeps the durable fence after a failed connection or deployment', async () => {
    mocks.connect.mockRejectedValueOnce(new Error('SSH unavailable'))

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('SSH unavailable')

    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('does not contact SSH when the fenced target generation cannot flush', async () => {
    migrationStore.flushPendingOrThrowAsync.mockRejectedValueOnce(new Error('generation disk full'))

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('generation disk full')

    expect(operationOrder).toEqual(['assert', 'begin', 'ensure-generation'])
    expect(mocks.connect).not.toHaveBeenCalled()
    expect(mocks.deploy).not.toHaveBeenCalled()
    expect(mocks.addEnvironment).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('rejects a server-name collision before fencing the SSH target', async () => {
    mocks.listEnvironments.mockReturnValueOnce([
      { ...managedEnvironment, id: 'environment-other', name: 'Managed server' }
    ])

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('A server named "Managed server" already exists.')

    expect(targetStore.assertOrcadRuntimeTargetClaimable).not.toHaveBeenCalled()
    expect(mocks.beginCutover).not.toHaveBeenCalled()
    expect(mocks.connect).not.toHaveBeenCalled()
  })

  it('reconciles an interrupted first activation before retrying deployment', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: null,
      readiness: null
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).resolves.toMatchObject({ outcome: 'created' })

    expect(mocks.readRecord).toHaveBeenCalledOnce()
    expect(mocks.deploy).toHaveBeenCalledWith(
      expect.objectContaining({ census: { liveSessions: 0, startedSinceActivation: 0 } })
    )
  })

  it('keeps a fresh first-activation fence claimed for a later retry', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'pending',
      code: 'orcad_recovery_transaction_still_fresh',
      reason: 'Retry after the recovery window.'
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('Retry after the recovery window')

    expect(mocks.deploy).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('reuses the journal environment id when a deferred deployment is forced later', async () => {
    mocks.deploy.mockResolvedValueOnce({
      outcome: 'installed-not-activated',
      fullVersion: '0.2.0+def456',
      code: 'orcad_update_terminals_running',
      reason: 'Terminals are still live.'
    })

    await createManagedOrcadEnvironment('/user-data', {
      name: 'Managed server',
      sshTargetId: 'ssh-1'
    })
    mocks.listCutovers.mockReturnValue([sourceCutover])
    await createManagedOrcadEnvironment('/user-data', {
      name: 'Managed server',
      sshTargetId: 'ssh-1',
      force: true
    })

    expect(mocks.beginCutover).toHaveBeenCalledTimes(2)
    expect(mocks.beginCutover).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        destinationEnvironmentId: 'environment-1',
        manifest: migrationManifest
      })
    )
    expect(mocks.createManifest).toHaveBeenCalledOnce()
    expect(mocks.addEnvironment).toHaveBeenCalledOnce()
  })

  it('keeps the source fence when the local environment write fails', async () => {
    mocks.addEnvironment.mockImplementationOnce(() => {
      throw new Error('environment disk full')
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('environment disk full')

    expect(mocks.commitDestination).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
  })

  it('keeps the registered environment and source fence when destination commit fails', async () => {
    mocks.commitDestination.mockRejectedValueOnce(new Error('commit unavailable'))

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).rejects.toThrow('commit unavailable')

    expect(mocks.addEnvironment).toHaveBeenCalledOnce()
    expect(mocks.retireSource).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.closeTunnel).not.toHaveBeenCalled()
  })

  it('resumes catalog commit and retirement from an existing environment', async () => {
    mocks.listCutovers.mockReturnValue([sourceCutover])
    mocks.listEnvironments.mockReturnValue([managedEnvironment])
    mocks.resolveContext.mockResolvedValueOnce({
      activationRecord: {
        active: '0.1.0+abc123',
        previous: null,
        activatedAt: '2026-08-30T00:01:00.000Z',
        snapshot: null
      },
      bunTarget: 'linux-x64-glibc',
      connection: {},
      host: { platform: 'linux', pathFlavor: 'posix', commandDialect: 'posix' },
      remoteHome: '/home/deploy',
      target: claimedTarget,
      userDataDir: '/home/deploy/.orca'
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).resolves.toMatchObject({
      outcome: 'already-current',
      activeVersion: '0.1.0+abc123',
      environment: managedEnvironment
    })

    expect(mocks.ensureTunnel).toHaveBeenCalledWith('/user-data', 'environment-1')
    expect(mocks.commitDestination).toHaveBeenCalledWith(
      expect.objectContaining({ migrationId: 'migration-1', pairingCode: 'orca://pair?existing' })
    )
    expect(mocks.retireSource).toHaveBeenCalledOnce()
    expect(mocks.materialize).not.toHaveBeenCalled()
    expect(mocks.deploy).not.toHaveBeenCalled()
  })

  it.each([
    'source-fenced',
    'destination-staged',
    'destination-committed',
    'source-retired'
  ] as const)('repairs a downgraded environment link from the %s journal phase', async (phase) => {
    const cutover = { ...sourceCutover, phase }
    const downgradedEnvironment = { ...managedEnvironment, orcadDeployment: undefined }
    mocks.listCutovers.mockReturnValue([cutover])
    mocks.beginCutover.mockResolvedValueOnce(cutover)
    mocks.listEnvironments.mockReturnValue([downgradedEnvironment])
    mocks.resolveContext.mockResolvedValueOnce({
      activationRecord: {
        active: '0.1.0+abc123',
        previous: null,
        activatedAt: '2026-08-30T00:01:00.000Z',
        snapshot: null
      },
      bunTarget: 'linux-x64-glibc',
      connection: {},
      host: { platform: 'linux', pathFlavor: 'posix', commandDialect: 'posix' },
      remoteHome: '/home/deploy',
      target: claimedTarget,
      userDataDir: '/home/deploy/.orca'
    })

    await expect(
      createManagedOrcadEnvironment('/user-data', {
        name: 'Managed server',
        sshTargetId: 'ssh-1'
      })
    ).resolves.toMatchObject({ outcome: 'already-current', environment: managedEnvironment })

    expect(mocks.restoreEnvironmentLink).toHaveBeenCalledWith('/user-data', 'environment-1', {
      sshTargetId: 'ssh-1',
      sshTargetGeneration: 7,
      remotePort: 6_768
    })
    expect(mocks.ensureTunnel).toHaveBeenCalledWith('/user-data', 'environment-1')
    expect(mocks.deploy).not.toHaveBeenCalled()
  })
})

describe('listPendingManagedOrcadMigrations', () => {
  it('keeps a restart-visible recovery row until the environment is registered', () => {
    mocks.listCutovers.mockReturnValue([sourceCutover])

    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([
      {
        environmentId: 'environment-1',
        name: 'Managed server',
        sshTargetId: 'ssh-1',
        sshTargetLabel: 'Server',
        phase: 'source-fenced',
        startedAt: '2026-08-30T00:00:00.000Z'
      }
    ])

    mocks.listEnvironments.mockReturnValue([managedEnvironment])
    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([])
  })

  it('keeps a same-id environment visible when downgrade stripped its managed link', () => {
    mocks.listCutovers.mockReturnValue([sourceCutover])
    mocks.listEnvironments.mockReturnValue([{ ...managedEnvironment, orcadDeployment: undefined }])

    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([
      expect.objectContaining({
        environmentId: 'environment-1',
        sshTargetId: 'ssh-1',
        phase: 'source-fenced'
      })
    ])
  })

  it('keeps a legacy nameless journal resumable with the source target label', () => {
    mocks.listCutovers.mockReturnValue([{ ...sourceCutover, destinationName: undefined }])

    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([
      expect.objectContaining({
        environmentId: 'environment-1',
        name: 'Server',
        sshTargetId: 'ssh-1'
      })
    ])
  })

  it('keeps a source-retired crash resumable while its target fence remains', () => {
    mocks.listCutovers.mockReturnValue([
      {
        ...sourceCutover,
        phase: 'source-retired',
        receipt: {},
        retiredAt: '2026-08-30T00:01:00.000Z'
      }
    ])

    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([
      expect.objectContaining({
        environmentId: 'environment-1',
        phase: 'source-retired'
      })
    ])
  })

  it('does not turn a completed unlink receipt into a pending setup', () => {
    mocks.listCutovers.mockReturnValue([
      {
        ...sourceCutover,
        phase: 'source-retired',
        receipt: {},
        retiredAt: '2026-08-30T00:01:00.000Z'
      }
    ])
    targetStore.getTarget.mockReturnValueOnce(target)

    expect(listPendingManagedOrcadMigrations('/user-data')).toEqual([])
  })
})

describe('getManagedOrcadRuntimeStatus', () => {
  it('reports a registered environment whose catalog cutover is incomplete', async () => {
    mocks.listCutovers.mockReturnValue([sourceCutover])

    await expect(
      getManagedOrcadRuntimeStatus('/user-data', 'environment-1')
    ).resolves.toMatchObject({
      environmentId: 'environment-1',
      migration: {
        phase: 'source-fenced',
        startedAt: '2026-08-30T00:00:00.000Z'
      },
      recovery: null
    })
  })
})

describe('stopManagedOrcadEnvironment', () => {
  it('stops, retires transport, removes the environment, and releases the target', async () => {
    const invalidateTransport = vi.fn().mockResolvedValue(undefined)
    const cleanupLocalState = vi.fn().mockResolvedValue(undefined)

    const result = await stopManagedOrcadEnvironment(
      '/user-data',
      { selector: 'environment-1' },
      { invalidateTransport, cleanupLocalState, isActiveEnvironment: () => false }
    )

    expect(mocks.stopRemote).toHaveBeenCalledOnce()
    expect(mocks.closeTunnel).toHaveBeenCalledWith('environment-1')
    expect(invalidateTransport).toHaveBeenCalledWith('environment-1')
    expect(cleanupLocalState).toHaveBeenCalledWith('environment-1')
    expect(mocks.releaseTarget).toHaveBeenCalledWith('ssh-1', 'environment-1')
    expect(mocks.removeEnvironment).toHaveBeenCalledWith('/user-data', 'environment-1')
    expect(result).toMatchObject({
      outcome: 'unlinked',
      verdict: 'exited',
      sshTargetId: 'ssh-1'
    })
  })

  it('keeps exited decommission retryable when local browser cleanup fails', async () => {
    const invalidateTransport = vi.fn().mockResolvedValue(undefined)
    const cleanupLocalState = vi.fn().mockRejectedValue(new Error('partition busy'))

    await expect(
      stopManagedOrcadEnvironment(
        '/user-data',
        { selector: 'environment-1' },
        { invalidateTransport, cleanupLocalState, isActiveEnvironment: () => false }
      )
    ).resolves.toMatchObject({
      outcome: 'failed',
      verdict: 'exited',
      code: 'orcad_unlink_local_cleanup_failed'
    })

    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.removeEnvironment).not.toHaveBeenCalled()
  })

  it('keeps the environment and target ownership when atomic decommission is refused', async () => {
    mocks.stopRemote.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unverifiable',
      reason: 'The host could not fence terminal admission.'
    })
    const invalidateTransport = vi.fn()

    await expect(
      stopManagedOrcadEnvironment(
        '/user-data',
        { selector: 'environment-1' },
        { invalidateTransport, isActiveEnvironment: () => false }
      )
    ).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unverifiable'
    })

    expect(mocks.stopRemote).toHaveBeenCalledOnce()
    expect(invalidateTransport).not.toHaveBeenCalled()
    expect(mocks.removeEnvironment).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('reports loss of contact during stop as unverifiable without local unlink', async () => {
    mocks.stopRemote.mockRejectedValueOnce(new Error('SSH channel closed'))
    const invalidateTransport = vi.fn()

    await expect(
      stopManagedOrcadEnvironment(
        '/user-data',
        { selector: 'environment-1' },
        { invalidateTransport, isActiveEnvironment: () => false }
      )
    ).resolves.toMatchObject({
      outcome: 'failed',
      verdict: 'unverifiable',
      code: 'orcad_stop_process_unverifiable'
    })

    expect(invalidateTransport).not.toHaveBeenCalled()
    expect(mocks.removeEnvironment).not.toHaveBeenCalled()
    expect(mocks.releaseTarget).not.toHaveBeenCalled()
  })

  it('does not unlink a server selected as Active while local cleanup is in flight', async () => {
    let becameActive = false
    const invalidateTransport = vi.fn().mockResolvedValue(undefined)
    const cleanupLocalState = vi.fn().mockImplementation(async () => {
      becameActive = true
    })

    await expect(
      stopManagedOrcadEnvironment(
        '/user-data',
        { selector: 'environment-1' },
        {
          invalidateTransport,
          cleanupLocalState,
          isActiveEnvironment: () => becameActive
        }
      )
    ).resolves.toMatchObject({
      outcome: 'failed',
      verdict: 'exited',
      code: 'orcad_unlink_became_active'
    })

    expect(mocks.releaseTarget).not.toHaveBeenCalled()
    expect(mocks.removeEnvironment).not.toHaveBeenCalled()
  })
})

describe('recoverManagedOrcadEnvironment', () => {
  it('refreshes pairing and tunnel state after restoring a serving runtime', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: '0.1.0+abc123',
      readiness
    })

    await expect(
      recoverManagedOrcadEnvironment('/user-data', { selector: 'environment-1' })
    ).resolves.toMatchObject({
      outcome: 'recovered',
      resolution: 'restored-incumbent',
      activeVersion: '0.1.0+abc123',
      environment: managedEnvironment
    })

    expect(mocks.tunnelPairingCode).toHaveBeenCalledWith(readiness, 46_768)
    expect(mocks.updateEnvironment).toHaveBeenCalledWith('/user-data', 'environment-1', {
      pairingCode: 'orca://pair?managed'
    })
    expect(mocks.ensureTunnel).toHaveBeenCalledWith('/user-data', 'environment-1')
  })

  it('preserves a pending stale-window result without changing local credentials', async () => {
    mocks.recover.mockResolvedValueOnce({
      outcome: 'pending',
      code: 'orcad_recovery_transaction_still_fresh',
      reason: 'Retry later.'
    })

    await expect(
      recoverManagedOrcadEnvironment('/user-data', { selector: 'environment-1' })
    ).resolves.toMatchObject({ outcome: 'pending' })
    expect(mocks.updateEnvironment).not.toHaveBeenCalled()
    expect(mocks.ensureTunnel).not.toHaveBeenCalled()
  })
})

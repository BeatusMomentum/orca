import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyOrcadActivationRecord, type OrcadActivationRecord } from './orcad-activation-record'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  readRecord: vi.fn(),
  retain: vi.fn(),
  retainOnError: vi.fn(),
  writeRecord: vi.fn(),
  writeTransaction: vi.fn()
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({ execCommand: mocks.exec }))
vi.mock('./orcad-activation-record-store', () => ({
  readOrcadActivationRecord: mocks.readRecord,
  writeOrcadActivationRecord: mocks.writeRecord
}))
vi.mock('./orcad-activation-transaction-store', () => ({
  writeOrcadActivationTransaction: mocks.writeTransaction
}))
vi.mock('./orcad-activation-lock', () => ({
  withOrcadActivationLock: async (_options: unknown, run: (lock: unknown) => Promise<unknown>) =>
    run({ retain: mocks.retain, retainOnError: mocks.retainOnError })
}))

const { stopRemoteOrcad } = await import('./orcad-remote-stop')

const activeRecord: OrcadActivationRecord = {
  ...emptyOrcadActivationRecord(),
  active: '0.2.0+new',
  previous: '0.1.0+old',
  activatedAt: new Date(1).toISOString()
}
const options = {
  conn: {} as never,
  host: getRemoteHostPlatform('linux-x64'),
  remoteHome: '/home/deploy',
  record: activeRecord,
  requestDecommission: vi.fn().mockResolvedValue({ outcome: 'accepted' })
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.readRecord.mockResolvedValue(activeRecord)
  mocks.writeRecord.mockResolvedValue(undefined)
  mocks.writeTransaction.mockResolvedValue(undefined)
  options.requestDecommission.mockResolvedValue({ outcome: 'accepted' })
})

describe('stopRemoteOrcad', () => {
  it('records deactivation only after the host confirms process exit', async () => {
    mocks.exec.mockResolvedValue('STOPPED\n')

    await expect(stopRemoteOrcad(options)).resolves.toEqual({
      outcome: 'stopped',
      activeVersion: '0.2.0+new',
      alreadyDeactivated: false
    })
    expect(mocks.retainOnError).toHaveBeenCalledOnce()
    expect(options.requestDecommission).toHaveBeenCalledWith('0.2.0+new', expect.any(String))
    expect(mocks.retainOnError.mock.invocationCallOrder[0]).toBeLessThan(
      options.requestDecommission.mock.invocationCallOrder[0]
    )
    expect(mocks.writeRecord.mock.calls[0]?.[1]).toMatchObject({
      active: '0.2.0+new',
      decommissioning: { version: '0.2.0+new' }
    })
    expect(mocks.writeRecord).toHaveBeenCalledWith(
      options,
      expect.objectContaining({
        active: null,
        previous: '0.2.0+new',
        activatedAt: null,
        snapshot: null
      })
    )
    expect(mocks.writeTransaction.mock.calls.map((call) => call[1].phase)).toEqual([
      'prepared',
      'admission-fenced',
      'process-exited'
    ])
  })

  it('keeps a positively live process linked with retryable decommission proof', async () => {
    mocks.exec.mockResolvedValue('STILL_RUNNING\n')

    await expect(stopRemoteOrcad(options)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_stop_incomplete'
    })
    expect(mocks.writeRecord).toHaveBeenCalledOnce()
    expect(mocks.writeRecord.mock.calls[0]?.[1]).toMatchObject({
      active: '0.2.0+new',
      decommissioning: { version: '0.2.0+new' }
    })
  })

  it('does not turn a missing pid identity into an exited verdict', async () => {
    mocks.exec.mockResolvedValue('NO_PID\n')

    await expect(stopRemoteOrcad(options)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_stop_unverifiable'
    })
    expect(mocks.writeRecord).toHaveBeenCalledOnce()
  })

  it('recognizes a previously completed deactivation so local cleanup can retry', async () => {
    const deactivated = {
      ...emptyOrcadActivationRecord(),
      previous: '0.2.0+new'
    }
    mocks.readRecord.mockResolvedValue(deactivated)

    await expect(stopRemoteOrcad({ ...options, record: deactivated })).resolves.toEqual({
      outcome: 'stopped',
      activeVersion: '0.2.0+new',
      alreadyDeactivated: true
    })
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.writeRecord).not.toHaveBeenCalled()
  })

  it('resumes process stop from durable decommission proof without contacting the runtime', async () => {
    const decommissioning = {
      ...activeRecord,
      decommissioning: {
        version: '0.2.0+new',
        acceptedAt: new Date(2).toISOString()
      }
    }
    mocks.readRecord.mockResolvedValue(decommissioning)
    mocks.exec.mockResolvedValue('ALREADY_EXITED\n')

    await expect(stopRemoteOrcad({ ...options, record: decommissioning })).resolves.toMatchObject({
      outcome: 'stopped',
      activeVersion: '0.2.0+new'
    })

    expect(options.requestDecommission).not.toHaveBeenCalled()
    expect(mocks.writeRecord).toHaveBeenCalledOnce()
    expect(mocks.writeRecord.mock.calls[0]?.[1]).toMatchObject({
      active: null,
      previous: '0.2.0+new',
      decommissioning: null
    })
  })

  it('does not signal the process when atomic decommission is refused', async () => {
    options.requestDecommission.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_decommission_live_sessions',
      reason: 'A terminal is live.'
    })

    await expect(stopRemoteOrcad(options)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'live',
      code: 'orcad_decommission_live_sessions'
    })
    expect(mocks.exec).not.toHaveBeenCalled()
    expect(mocks.writeRecord).not.toHaveBeenCalled()
  })

  it('retains the durable transaction when decommission acceptance is unverifiable', async () => {
    options.requestDecommission.mockResolvedValueOnce({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unverifiable',
      reason: 'The response was lost.'
    })

    await expect(stopRemoteOrcad(options)).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable'
    })
    expect(mocks.retain).toHaveBeenCalledOnce()
    expect(mocks.writeTransaction.mock.calls[0]?.[1]).toMatchObject({
      operation: 'decommission',
      phase: 'prepared'
    })
    expect(mocks.exec).not.toHaveBeenCalled()
  })
})

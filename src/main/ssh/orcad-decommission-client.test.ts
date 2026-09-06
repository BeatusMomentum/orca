import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'

const sendRequest = vi.hoisted(() => vi.fn())
vi.mock('../../shared/remote-runtime-client', () => ({ sendRemoteRuntimeRequest: sendRequest }))

const { requestRemoteOrcadDecommission } = await import('./orcad-decommission-client')

const environment = {
  id: 'environment-1',
  name: 'Managed server',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: 'runtime-1',
  preferredEndpointId: 'endpoint-1',
  endpoints: [
    {
      id: 'endpoint-1',
      kind: 'websocket',
      label: 'SSH tunnel',
      endpoint: 'ws://127.0.0.1:46768',
      deviceToken: 'token',
      publicKeyB64: 'key'
    }
  ]
} satisfies KnownRuntimeEnvironment

beforeEach(() => vi.clearAllMocks())

describe('remote orcad decommission client', () => {
  it('parses an accepted host verdict', async () => {
    sendRequest.mockResolvedValue({ ok: true, result: { outcome: 'accepted' } })

    await expect(requestRemoteOrcadDecommission(environment, '0.2.0+new')).resolves.toEqual({
      outcome: 'accepted'
    })
    expect(sendRequest).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: 'ws://127.0.0.1:46768' }),
      'orcad.decommissionIfIdle',
      { version: '0.2.0+new' },
      15_000,
      undefined,
      undefined,
      expect.any(Object)
    )
  })

  it('sends and validates an optional durable transaction receipt', async () => {
    const transactionId = 'b407cda3-44bd-44d8-b75a-8268c18035b1'
    sendRequest.mockResolvedValue({
      ok: true,
      result: { outcome: 'accepted', transactionId }
    })

    await expect(
      requestRemoteOrcadDecommission(environment, '0.2.0+new', transactionId)
    ).resolves.toEqual({ outcome: 'accepted', transactionId })
    expect(sendRequest).toHaveBeenCalledWith(
      expect.any(Object),
      'orcad.decommissionIfIdle',
      { version: '0.2.0+new', transactionId },
      15_000,
      undefined,
      undefined,
      expect.any(Object)
    )
  })

  it.each([
    { ok: false, error: { message: 'method unavailable' } },
    { ok: true, result: { outcome: 'stopped' } }
  ])('fails closed for an unusable response', async (response) => {
    sendRequest.mockResolvedValue(response)

    await expect(requestRemoteOrcadDecommission(environment, '0.2.0+new')).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unverifiable'
    })
  })
})

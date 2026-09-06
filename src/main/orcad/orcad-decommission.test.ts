import { afterEach, describe, expect, it, vi } from 'vitest'

const persistAcceptance = vi.hoisted(() => vi.fn())
vi.mock('./orcad-decommission-acceptance', () => ({
  persistOrcadDecommissionAcceptance: persistAcceptance
}))

import { configureOrcadDecommission, requestOrcadDecommission } from './orcad-decommission'

afterEach(() => {
  configureOrcadDecommission(null)
  persistAcceptance.mockReset()
})

describe('orcad decommission adapter', () => {
  it('returns the host adapter verdict', async () => {
    const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter)

    await expect(requestOrcadDecommission('0.2.0+new', '0.2.0+new')).resolves.toEqual({
      outcome: 'accepted'
    })
    expect(adapter).toHaveBeenCalledOnce()
  })

  it('fails closed outside a configured orcad runtime', async () => {
    await expect(requestOrcadDecommission('0.2.0+new', '0.2.0+new')).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unavailable'
    })
  })

  it('does not fence a runtime that differs from the activation record', async () => {
    const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter)

    await expect(requestOrcadDecommission('0.2.0+old', '0.3.0+new')).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_version_mismatch'
    })
    expect(adapter).not.toHaveBeenCalled()
  })

  it('persists and echoes the durable transaction receipt after admission is fenced', async () => {
    const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter)
    const transactionId = 'b407cda3-44bd-44d8-b75a-8268c18035b1'

    await expect(
      requestOrcadDecommission('0.2.0+new', '0.2.0+new', transactionId)
    ).resolves.toEqual({ outcome: 'accepted', transactionId })
    expect(persistAcceptance).toHaveBeenCalledWith(transactionId, '0.2.0+new')
  })

  it('reports an unverifiable receipt without claiming admission stayed open', async () => {
    const adapter = vi.fn().mockResolvedValue({ outcome: 'accepted' })
    configureOrcadDecommission(adapter)
    persistAcceptance.mockImplementation(() => {
      throw new Error('disk unavailable')
    })

    await expect(
      requestOrcadDecommission('0.2.0+new', '0.2.0+new', 'b407cda3-44bd-44d8-b75a-8268c18035b1')
    ).resolves.toMatchObject({
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_receipt_unverifiable'
    })
  })
})

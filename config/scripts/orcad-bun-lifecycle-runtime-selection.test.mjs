import { describe, expect, it } from 'vitest'
import { selectOrcadLifecycleRuntime } from './orcad-bun-lifecycle-runtime-selection.mjs'

describe('selectOrcadLifecycleRuntime', () => {
  it('selects the invoking Node executable for migration mode', () => {
    expect(
      selectOrcadLifecycleRuntime({
        migrationMode: true,
        bundledBun: '/artifact/bun-runtime',
        hostNodeRuntime: '/usr/local/bin/node'
      })
    ).toBe('/usr/local/bin/node')
  })

  it('selects the bundled Bun executable for the normal lifecycle', () => {
    expect(
      selectOrcadLifecycleRuntime({
        migrationMode: false,
        bundledBun: '/artifact/bun-runtime',
        hostNodeRuntime: '/usr/local/bin/node'
      })
    ).toBe('/artifact/bun-runtime')
  })
})

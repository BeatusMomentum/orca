import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildGuestInstallScript, buildGuestLaunchScript } from './wsl-hook-relay-launch'

describe('WSL hook relay guest launcher', () => {
  it('prefers a staged target-native Bun before probing Node', () => {
    const script = buildGuestLaunchScript('0.1.0+abc123')
    expect(script).toContain('bun-runtime-${orca_arch}-${orca_libc}')
    expect(script.indexOf('exec "$r"')).toBeLessThan(script.indexOf('command -v node'))
    expect(script).toContain('1.4.0')
    expect(script).toContain('exit 43')
  })

  it('streams optional Bun runtimes into the versioned guest install', () => {
    const script = buildGuestInstallScript(Buffer.from('relay'), '0.1.0+abc123', {
      'x64-glibc': Buffer.from('bun-binary')
    })
    expect(script).toContain('bun-runtime-x64-glibc')
    expect(script).toContain(Buffer.from('bun-binary').toString('base64'))
    expect(script).toContain('chmod 700 "$d/bun-runtime-x64-glibc"')
  })

  it('makes release launchers fail closed instead of probing distro Node', () => {
    const script = buildGuestLaunchScript('0.1.0+strict', { requiresBundledBun: true })
    execFileSync('sh', ['-n'], { input: script })
    expect(script).not.toContain('command -v node')
    expect(script).toContain('exit 43')
  })

  it('propagates the Bun-only policy into the installed launcher', () => {
    const script = buildGuestInstallScript(
      Buffer.from('relay'),
      '0.1.0+strict',
      { 'x64-glibc': Buffer.from('bun-binary') },
      { requiresBundledBun: true }
    )
    expect(script).not.toContain('command -v node')
    expect(script).toContain('exit 43')
  })
})

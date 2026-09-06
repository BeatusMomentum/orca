#!/usr/bin/env node

import { join, resolve } from 'node:path'
import { readOrcadBunSshTestFile } from './orcad-bun-ssh-test-file.mjs'
import { runProcessSync } from './script-child-process.mjs'

const root = resolve(import.meta.dirname, '../..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const image = 'orca-orcad-ssh-lifecycle:e2e'
const fixture = join(root, 'tests', 'e2e', 'fixtures', 'docker-ssh-relay')
const artifactDir = join(root, 'out', 'orcad-ssh-lifecycle')
const lifecycleTest = readOrcadBunSshTestFile(
  process.argv.slice(2),
  'tests/e2e/orcad-remote-lifecycle.docker.unit.test.ts'
)

function run(program, args, options = {}) {
  const result = runProcessSync({
    program,
    args,
    cwd: root,
    timeoutMs: null,
    ...options
  })
  if (result.code !== 0) {
    process.stderr.write(result.stderr || result.stdout)
    process.exit(result.code ?? 1)
  }
  return result.stdout.trim()
}

const dockerArch = run('docker', ['version', '--format', '{{.Server.Arch}}'])
const targetArch =
  dockerArch === 'arm64' || dockerArch === 'aarch64'
    ? 'arm64'
    : dockerArch === 'amd64' || dockerArch === 'x86_64'
      ? 'x64'
      : null
if (!targetArch) {
  throw new Error(`Unsupported Docker architecture: ${dockerArch}`)
}
const bunTarget = `linux-${targetArch}-glibc`

run('docker', ['build', '--tag', image, '--file', join(fixture, 'Dockerfile'), fixture], {
  stdio: 'inherit'
})
run(
  process.execPath,
  [
    join(root, 'config', 'scripts', 'build-orcad-bun.mjs'),
    '--target',
    bunTarget,
    '--out-dir',
    artifactDir
  ],
  { stdio: 'inherit' }
)
run(
  pnpm,
  [
    'exec',
    'vitest',
    'run',
    '--config',
    'config/vitest.config.ts',
    lifecycleTest,
    '--maxWorkers=1',
    '--reporter=verbose'
  ],
  {
    env: {
      ...process.env,
      ORCA_E2E_SSH_DOCKER_IMAGE: image,
      ORCA_REVIEW_ORCAD_ARTIFACT_DIR: artifactDir,
      ORCA_REVIEW_ORCAD_SSH_LIFECYCLE: '1',
      ORCA_REVIEW_ORCAD_TARGET: bunTarget
    },
    stdio: 'inherit'
  }
)

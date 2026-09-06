#!/usr/bin/env node

import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { orcadBunRuntimeFilename } from '../../src/shared/orcad-artifacts.ts'
import { selectOrcadLifecycleRuntime } from './orcad-bun-lifecycle-runtime-selection.mjs'

const root = join(import.meta.dirname, '..', '..')

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

const artifactDir =
  argument('--artifact-dir') ?? process.env.ORCAD_E2E_ARTIFACT_DIR ?? join(root, 'out', 'orcad')
const orcadEntry = join(artifactDir, 'orcad.js')
const cliEntry = process.env.ORCAD_E2E_CLI_ENTRY ?? join(root, 'out', 'cli', 'index.js')
const bundledBun = join(artifactDir, orcadBunRuntimeFilename(process.platform))
const bun = process.env.BUN_EXECUTABLE ?? (existsSync(bundledBun) ? bundledBun : 'bun')
const cliRuntime = process.env.ORCAD_E2E_CLI_RUNTIME ?? process.execPath
const hostNodeRuntime = process.env.ORCA_BUN_SCRIPT_HOST_NODE ?? process.execPath
const migrationMode = process.argv.includes('--node-bun-node')
const port = 6900 + Math.floor(Math.random() * 100)
const dataRoot = mkdtempSync(join(tmpdir(), 'orca-bun-lifecycle-'))
const repoRoot = mkdtempSync(join(tmpdir(), 'orca-bun-repo-'))
const logPath = join(dataRoot, 'orcad.log')
const stopRequestPath = join(artifactDir, '.orcad-stop-request')
const daemonPids = []
let runtime = null
let worktreePath = null

function fail(message) {
  throw new Error(message)
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  if (result.status !== 0) {
    fail(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function cli(pairingCode, args) {
  const raw = run(cliRuntime, [cliEntry, ...args, '--pairing-code', pairingCode, '--json'])
  const response = JSON.parse(raw)
  if (response.ok !== true) {
    fail(`CLI ${args.join(' ')} failed: ${raw}`)
  }
  return response.result ?? response
}

function waitForExit(child, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(
      () => reject(new Error('orcad did not exit after stop request')),
      timeoutMs
    )
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
}

async function stopRuntime(child) {
  if (child.exitCode !== null) {
    return
  }
  if (process.platform === 'win32') {
    writeFileSync(stopRequestPath, '')
  } else {
    child.kill('SIGTERM')
  }
  await waitForExit(child)
}

function startRuntime(runtimeExecutable = bun) {
  const child = spawn(runtimeExecutable, [orcadEntry, '--port', String(port), '--json'], {
    env: { ...process.env, ORCA_USER_DATA: dataRoot },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
    writeFileSync(logPath, output)
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
    writeFileSync(logPath, output)
  })
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bun orcad readiness timeout')), 90_000)
    const onData = () => {
      const line = output
        .split('\n')
        .find((candidate) => candidate.startsWith('{"type":"orca_server_ready"'))
      if (!line) {
        return
      }
      clearTimeout(timer)
      child.stdout.off('data', onData)
      try {
        resolve(JSON.parse(line))
      } catch (error) {
        reject(error)
      }
    }
    child.stdout.on('data', onData)
    child.once('exit', (code) => reject(new Error(`Bun orcad exited before readiness: ${code}`)))
  })
  return { child, ready }
}

function readTerminal(pairingCode, handle) {
  return cli(pairingCode, ['terminal', 'read', '--terminal', handle])
}

try {
  run('git', ['init', '-q', repoRoot])
  run('git', ['-C', repoRoot, 'checkout', '-q', '-b', 'main'])
  writeFileSync(join(repoRoot, 'README.md'), '# Bun lifecycle\n')
  run('git', ['-C', repoRoot, 'add', '-A'])
  run('git', [
    '-C',
    repoRoot,
    '-c',
    'user.email=orca@test',
    '-c',
    'user.name=Orca',
    'commit',
    '-qm',
    'seed'
  ])

  runtime = startRuntime(
    selectOrcadLifecycleRuntime({
      migrationMode,
      bundledBun: bun,
      hostNodeRuntime
    })
  )
  const firstReady = await runtime.ready
  const firstPairing = firstReady.pairing.url
  const firstHealth = firstReady.health
  const expectedFirstRuntime = migrationMode ? 'node' : 'bun'
  const expectedFirstBackend = migrationMode ? 'node-pty' : 'bun-terminal'
  if (
    firstHealth?.platform !== process.platform ||
    firstHealth?.arch !== process.arch ||
    firstHealth?.runtimeKind !== expectedFirstRuntime ||
    firstHealth?.ptyBackend !== expectedFirstBackend ||
    (expectedFirstRuntime === 'bun' && !firstHealth?.runtimeVersion)
  ) {
    fail(`unexpected first runtime health metadata: ${JSON.stringify(firstHealth)}`)
  }
  if (!firstHealth?.terminalDaemon?.pid) {
    fail('Bun readiness omitted terminal daemon PID')
  }
  if (
    firstHealth.terminalDaemon.runtimeKind !== expectedFirstRuntime ||
    firstHealth.terminalDaemon.ptyBackend !== expectedFirstBackend ||
    (expectedFirstRuntime === 'bun' && !firstHealth.terminalDaemon.runtimeVersion)
  ) {
    fail(
      `terminal daemon runtime does not match the orcad runtime: ${JSON.stringify(firstHealth.terminalDaemon)}`
    )
  }
  daemonPids.push(firstHealth.terminalDaemon.pid)

  const repo = cli(firstPairing, ['repo', 'add', '--path', repoRoot]).repo
  const created = cli(firstPairing, [
    'worktree',
    'create',
    '--repo',
    `id:${repo.id}`,
    '--name',
    `bun-e2e-${randomBytes(4).toString('hex')}`,
    '--setup',
    'skip'
  ]).worktree
  worktreePath = created.id.split('::')[1]
  const terminal = cli(firstPairing, ['terminal', 'create', '--worktree', created.id]).terminal
  const marker = `ORCAD_BUN_LIFECYCLE_${randomBytes(8).toString('hex')}`
  cli(firstPairing, [
    'terminal',
    'send',
    '--terminal',
    terminal.handle,
    '--text',
    `echo ${marker}`,
    '--enter'
  ])
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (JSON.stringify(readTerminal(firstPairing, terminal.handle)).includes(marker)) {
      break
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  if (!JSON.stringify(readTerminal(firstPairing, terminal.handle)).includes(marker)) {
    fail('Bun PTY did not round-trip output')
  }

  await stopRuntime(runtime.child)
  if (process.kill(firstHealth.terminalDaemon.pid, 0) === false) {
    fail('Bun daemon did not survive orcad shutdown')
  }

  runtime = startRuntime(bun)
  const secondReady = await runtime.ready
  const secondHealth = secondReady.health
  daemonPids.push(secondHealth?.terminalDaemon?.pid)
  if (secondHealth?.terminalDaemon?.pid !== firstHealth.terminalDaemon.pid) {
    fail(
      `Bun restart did not adopt daemon ${firstHealth.terminalDaemon.pid} -> ${secondHealth?.terminalDaemon?.pid}`
    )
  }
  if (!JSON.stringify(readTerminal(secondReady.pairing.url, terminal.handle)).includes(marker)) {
    fail('Bun terminal scrollback did not survive runtime restart')
  }
  if (migrationMode) {
    await stopRuntime(runtime.child)
    runtime = startRuntime(
      selectOrcadLifecycleRuntime({
        migrationMode,
        bundledBun: bun,
        hostNodeRuntime
      })
    )
    const rollbackReady = await runtime.ready
    const rollbackHealth = rollbackReady.health
    daemonPids.push(rollbackHealth?.terminalDaemon?.pid)
    if (rollbackHealth?.runtimeKind !== 'node' || rollbackHealth?.ptyBackend !== 'node-pty') {
      fail(`rollback did not run under Node: ${JSON.stringify(rollbackHealth)}`)
    }
    if (rollbackHealth?.terminalDaemon?.pid !== firstHealth.terminalDaemon.pid) {
      fail('Node rollback replaced the live daemon')
    }
    if (
      !JSON.stringify(readTerminal(rollbackReady.pairing.url, terminal.handle)).includes(marker)
    ) {
      fail('terminal scrollback did not survive Bun-to-Node rollback')
    }
  }
  console.log(
    JSON.stringify({
      ok: true,
      runtime: migrationMode ? 'node-bun-node' : 'bun',
      platform: `${process.platform}-${process.arch}`,
      daemonPid: firstHealth.terminalDaemon.pid,
      marker,
      checks: [
        'readiness',
        'repo-rpc',
        'worktree-rpc',
        'pty-output',
        'daemon-survival',
        'daemon-reattach',
        'scrollback-replay',
        ...(migrationMode ? ['node-bun-adoption', 'bun-node-rollback'] : [])
      ]
    })
  )
} finally {
  if (runtime?.child.exitCode === null) {
    await stopRuntime(runtime.child).catch(() => runtime.child.kill('SIGKILL'))
  }
  for (const pid of new Set(daemonPids.filter(Boolean))) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // The daemon may already have retired after the runtime cleanup.
    }
  }
  if (worktreePath) {
    rmSync(worktreePath, { recursive: true, force: true })
  }
  rmSync(repoRoot, { recursive: true, force: true })
  rmSync(dataRoot, { recursive: true, force: true })
}

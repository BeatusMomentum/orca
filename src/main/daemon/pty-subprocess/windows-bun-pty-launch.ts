import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildWindowsCmdCommand,
  buildWindowsCmdShimCommandLine
} from '../../../shared/child-process/windows-command-line'
import { getCmdExePath } from '../../../shared/windows-batch-spawn'

const GATE_ENV = 'ORCA_BUN_PTY_JOB_GATE'
const COMMAND_ENV = 'ORCA_BUN_PTY_CHILD_COMMAND'
const CLEAR_SEQUENCE = '\x1b[3J\x1b[2J\x1b[H'
const CLEANUP_MAX_RETRIES = 5
const CLEANUP_RETRY_DELAY_MS = 50

function removeLaunchDirectory(directory: string): void {
  try {
    rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: CLEANUP_MAX_RETRIES,
      retryDelay: CLEANUP_RETRY_DELAY_MS
    })
  } catch (error) {
    console.warn(`[pty] failed to remove Windows Bun launch directory ${directory}:`, error)
  }
}

export type WindowsBunPtyLaunch = {
  command: string[]
  clearCommand: string[]
  env: Record<string, string>
  windowsVerbatimArguments: true
  release(): void
  dispose(): void
}

export function createWindowsBunPtyLaunch(args: {
  file: string
  args: string[]
  env: Record<string, string>
}): WindowsBunPtyLaunch {
  const childCommand = buildWindowsCmdCommand(args.file, args.args)
  const directory = mkdtempSync(join(tmpdir(), 'orca-bun-pty-'))
  const gatePath = join(directory, 'job-assigned')
  const launchPath = join(directory, 'launch.cmd')
  const clearPath = join(directory, 'clear.cmd')
  const cmdExe = getCmdExePath()
  let released = false
  let disposed = false

  try {
    writeFileSync(
      launchPath,
      [
        '@echo off',
        ':orca_wait_for_job',
        `if not exist "%${GATE_ENV}%" goto orca_wait_for_job`,
        `del /q "%${GATE_ENV}%" >nul 2>&1`,
        `set "${GATE_ENV}=" & set "${COMMAND_ENV}=" & %${COMMAND_ENV}%`,
        'exit /b %errorlevel%'
      ].join('\r\n'),
      { encoding: 'ascii', flag: 'wx' }
    )
    writeFileSync(clearPath, `@echo off\r\n<nul set /p "=${CLEAR_SEQUENCE}"\r\n`, {
      encoding: 'ascii',
      flag: 'wx'
    })
  } catch (error) {
    removeLaunchDirectory(directory)
    throw error
  }

  return {
    command: [cmdExe, buildWindowsCmdShimCommandLine(launchPath, [])],
    clearCommand: [cmdExe, buildWindowsCmdShimCommandLine(clearPath, [])],
    env: {
      ...args.env,
      [GATE_ENV]: gatePath,
      [COMMAND_ENV]: childCommand
    },
    windowsVerbatimArguments: true,
    release() {
      if (released) {
        return
      }
      writeFileSync(gatePath, '', { flag: 'wx' })
      released = true
    },
    dispose() {
      if (disposed) {
        return
      }
      disposed = true
      removeLaunchDirectory(directory)
    }
  }
}

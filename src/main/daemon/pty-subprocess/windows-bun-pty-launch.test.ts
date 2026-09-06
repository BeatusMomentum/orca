import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildWindowsCmdCommand } from '../../../shared/child-process/windows-command-line'
import { createWindowsBunPtyLaunch } from './windows-bun-pty-launch'

describe('Windows Bun PTY gated launch', () => {
  it.each(['/K', '/k', '/C', '/c'])(
    'leaves the nested cmd %s switch unquoted while retaining command escaping',
    (commandSwitch) => {
      const file = 'C:\\Windows\\System32\\CMD.EXE'
      const command = 'chcp 65001 > nul & echo 状態%VALUE%!'
      const launch = createWindowsBunPtyLaunch({ file, args: [commandSwitch, command], env: {} })
      try {
        expect(launch.env.ORCA_BUN_PTY_CHILD_COMMAND).toBe(
          `${buildWindowsCmdCommand(file, [])} ${commandSwitch} ${buildWindowsCmdCommand(command, [])}`
        )
        expect(existsSync(launch.env.ORCA_BUN_PTY_JOB_GATE)).toBe(false)
      } finally {
        launch.dispose()
      }
    }
  )

  it('does not interpret command switches in non-cmd argv or after the cmd command switch', () => {
    for (const file of ['C:\\Tools\\shell.exe', 'C:\\Windows\\System32\\cmd.exe']) {
      const launch = createWindowsBunPtyLaunch({ file, args: ['/K', '/C'], env: {} })
      try {
        expect(launch.env.ORCA_BUN_PTY_CHILD_COMMAND).toBe(
          file.endsWith('cmd.exe')
            ? `${buildWindowsCmdCommand(file, [])} /K "/C"`
            : buildWindowsCmdCommand(file, ['/K', '/C'])
        )
      } finally {
        launch.dispose()
      }
    }
  })

  it('keeps hostile Unicode argv in the UTF-16 environment and gates the ASCII batch', () => {
    const file = 'C:\\状 態\\%tool%&shell.exe'
    const args = ['a b', 'c"d', 'e%F%g', 'h&i', 'j^k', 'bang!']
    const launch = createWindowsBunPtyLaunch({ file, args, env: { TERM: 'xterm-256color' } })
    const gate = launch.env.ORCA_BUN_PTY_JOB_GATE
    const directory = dirname(gate)

    try {
      expect(launch.env.ORCA_BUN_PTY_CHILD_COMMAND).toBe(buildWindowsCmdCommand(file, args))
      expect(launch.command).toHaveLength(2)
      expect(launch.command[1]).toContain('/d /v:off /s /c')
      expect(launch.windowsVerbatimArguments).toBe(true)

      const wrapper = readFileSync(join(directory, 'launch.cmd'), 'ascii')
      expect(wrapper).toContain(':orca_wait_for_job')
      expect(wrapper).toContain('if not exist "%ORCA_BUN_PTY_JOB_GATE%"')
      expect(wrapper).toContain('%ORCA_BUN_PTY_CHILD_COMMAND%')
      expect(wrapper).not.toContain(file)

      const clear = readFileSync(join(directory, 'clear.cmd'))
      expect(clear.includes(Buffer.from('\x1b[3J\x1b[2J\x1b[H'))).toBe(true)
      expect(existsSync(gate)).toBe(false)
      launch.release()
      launch.release()
      expect(existsSync(gate)).toBe(true)
    } finally {
      launch.dispose()
      launch.dispose()
    }

    expect(existsSync(directory)).toBe(false)
  })

  it('rejects a cmd-unsafe line break before creating launch state', () => {
    expect(() =>
      createWindowsBunPtyLaunch({
        file: 'C:\\Windows\\System32\\cmd.exe',
        args: ['/c', 'first\nsecond'],
        env: {}
      })
    ).toThrow('cmd.exe cannot receive an argument containing a line break')
  })
})

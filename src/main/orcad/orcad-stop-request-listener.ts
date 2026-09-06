import { watch, unlinkSync, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import { ORCAD_STOP_REQUEST_FILENAME } from '../../shared/orcad-stop-request'

export type OrcadStopRequestListenerOptions = {
  installRoot: string
  watchDirectory?: typeof watch
  unlinkFile?: typeof unlinkSync
  pollIntervalMs?: number
}

export type OrcadStopRequestListener = { close(): void }

function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Slot-local request files avoid signaling a stale PID that the OS has already reused. */
export function installOrcadStopRequestListener(
  onRequest: () => void,
  options: OrcadStopRequestListenerOptions
): OrcadStopRequestListener {
  const requestPath = join(options.installRoot, ORCAD_STOP_REQUEST_FILENAME)
  const unlinkFile = options.unlinkFile ?? unlinkSync
  const consume = (): void => {
    try {
      unlinkFile(requestPath)
    } catch (error) {
      if (isMissingFileError(error)) {
        return
      }
      console.error('[orcad] failed to consume stop request:', error)
      return
    }
    onRequest()
  }
  let watcher: FSWatcher | null = null
  try {
    watcher = (options.watchDirectory ?? watch)(options.installRoot, (_event, filename) => {
      if (!filename || basename(String(filename)) === ORCAD_STOP_REQUEST_FILENAME) {
        consume()
      }
    })
    watcher.on('error', (error) => {
      console.error('[orcad] stop-request watcher failed:', error)
    })
    watcher.unref()
  } catch (error) {
    console.error('[orcad] stop-request watcher could not start:', error)
  }
  const poll = setInterval(consume, options.pollIntervalMs ?? 1_000)
  poll.unref()
  // Covers a request written after readiness but before the watcher was installed.
  consume()
  return {
    close: () => {
      watcher?.close()
      clearInterval(poll)
    }
  }
}

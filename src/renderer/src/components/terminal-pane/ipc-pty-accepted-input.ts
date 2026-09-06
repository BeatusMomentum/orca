import {
  isTerminalInputTooLargeWithDeferredMeasurement,
  iterateTerminalInputChunks
} from '../../../../shared/terminal-input'
import type { PtyInputOperationOptions } from './pty-transport-types'

export async function writeAcceptedIpcPtyInput(
  id: string,
  data: string,
  isCurrent: () => boolean,
  options?: PtyInputOperationOptions
): Promise<boolean> {
  try {
    const tooLarge = isTerminalInputTooLargeWithDeferredMeasurement(data)
    if (typeof tooLarge === 'boolean' ? tooLarge : await tooLarge) {
      return false
    }
    const chunks = iterateTerminalInputChunks(data)
    let chunk = chunks.next()
    let chunkIndex = 0
    while (!chunk.done) {
      if (!isCurrent()) {
        return false
      }
      const operationId = options?.operationId
        ? chunkOperationId(options.operationId, chunkIndex)
        : undefined
      const accepted = operationId
        ? await window.api.pty.writeAccepted(id, chunk.value, { operationId })
        : await window.api.pty.writeAccepted(id, chunk.value)
      if (!accepted) {
        return false
      }
      chunk = chunks.next()
      chunkIndex += 1
      if (!chunk.done) {
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
    return true
  } catch {
    return false
  }
}

function chunkOperationId(operationId: string, index: number): string {
  return index === 0 ? operationId : `${operationId}:chunk:${index}`
}

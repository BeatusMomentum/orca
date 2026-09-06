import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { PTY_OWNERSHIP_TRANSFER_METHODS } from '../shared/pty-ownership-transfer-wire'
import { RelayDispatcher, type MethodHandler } from './dispatcher'
import { RelayRuntimeServices } from './relay-runtime-services'

function createRuntime(
  enableOwnershipTransferMutation?: boolean,
  ownershipTransferStoreDirectory?: string
) {
  const dispatcher = new RelayDispatcher(vi.fn(() => true))
  const options =
    enableOwnershipTransferMutation === undefined && ownershipTransferStoreDirectory === undefined
      ? {}
      : {
          ...(enableOwnershipTransferMutation === undefined
            ? {}
            : { enableOwnershipTransferMutation }),
          ...(ownershipTransferStoreDirectory === undefined
            ? {}
            : { ownershipTransferStoreDirectory })
        }
  const runtime = new RelayRuntimeServices(dispatcher, 1_000, 'test-version', options)
  const requestHandlers = (dispatcher as unknown as { requestHandlers: Map<string, MethodHandler> })
    .requestHandlers
  return { dispatcher, requestHandlers, runtime }
}

async function ownershipCapabilities(requestHandlers: Map<string, MethodHandler>) {
  const handler = requestHandlers.get('pty.getOwnershipBridgeCapabilities')
  if (!handler) {
    throw new Error('ownership-transfer capability handler was not registered')
  }
  return handler({}, { clientId: 1, isStale: () => false })
}

describe('RelayRuntimeServices ownership-transfer mutation gate', () => {
  it('defaults to status-only registration and disabled mutation capabilities', async () => {
    const { dispatcher, requestHandlers, runtime } = createRuntime()
    try {
      await expect(ownershipCapabilities(requestHandlers)).resolves.toMatchObject({
        liveTransfer: false,
        destinationOutput: false,
        destinationControl: false,
        authoritativeExit: false,
        postCommitReplay: false,
        reconnectRekey: false
      })
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.status)).toBe(true)
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.prepare)).toBe(false)
    } finally {
      runtime.disposeHandlers()
      dispatcher.dispose()
    }
  })

  it('keeps mutation disabled when the explicit opt-in lacks a durable store', async () => {
    const { dispatcher, requestHandlers, runtime } = createRuntime(true)
    try {
      await expect(ownershipCapabilities(requestHandlers)).resolves.toMatchObject({
        liveTransfer: false,
        destinationOutput: false,
        destinationControl: false,
        authoritativeExit: false,
        postCommitReplay: false,
        reconnectRekey: false
      })
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.status)).toBe(true)
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.prepare)).toBe(false)
    } finally {
      runtime.disposeHandlers()
      dispatcher.dispose()
    }
  })

  it('registers mutation routes only for an explicit opt-in with a durable store', async () => {
    const storeDirectory = mkdtempSync(join(tmpdir(), 'orca-relay-transfer-store-'))
    const { dispatcher, requestHandlers, runtime } = createRuntime(true, storeDirectory)
    try {
      await expect(ownershipCapabilities(requestHandlers)).resolves.toMatchObject({
        liveTransfer: true,
        destinationOutput: true,
        destinationControl: true,
        authoritativeExit: true,
        postCommitReplay: true,
        reconnectRekey: true
      })
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.status)).toBe(true)
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.prepare)).toBe(true)
    } finally {
      runtime.disposeHandlers()
      dispatcher.dispose()
      rmSync(storeDirectory, { recursive: true, force: true })
    }
  })

  it('keeps ordinary relay startup alive when a dormant journal is malformed and mutation is off', () => {
    const storeDirectory = mkdtempSync(join(tmpdir(), 'orca-relay-transfer-store-'))
    writeFileSync(join(storeDirectory, `${'a'.repeat(64)}.json`), '{not-json\n', 'utf8')
    let runtime: RelayRuntimeServices | undefined
    let dispatcher: RelayDispatcher | undefined
    try {
      dispatcher = new RelayDispatcher(vi.fn(() => true))
      runtime = new RelayRuntimeServices(dispatcher, 1_000, 'test-version', {
        ownershipTransferStoreDirectory: storeDirectory
      })
      const requestHandlers = (
        dispatcher as unknown as { requestHandlers: Map<string, MethodHandler> }
      ).requestHandlers
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.status)).toBe(true)
      expect(requestHandlers.has(PTY_OWNERSHIP_TRANSFER_METHODS.prepare)).toBe(false)
    } finally {
      runtime?.disposeHandlers()
      dispatcher?.dispose()
      rmSync(storeDirectory, { recursive: true, force: true })
    }
  })
})

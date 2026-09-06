import type { PtyOwnershipTransferOutputEnvelope } from '../../shared/pty-ownership-transfer-output-envelope'
import {
  PtyOwnershipTransferDestinationRuntimeRegistry,
  type PtyOwnershipTransferDestinationRuntimeOptions
} from '../persistence/pty-ownership-transfer/pty-ownership-transfer-destination-runtime'
import type { PtyOwnershipTransferWireIdentity } from '../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import type { RuntimeStore } from './runtime-store-contract'
export type RuntimePtyOwnershipTransferModelCheckpoint = Readonly<{
  ptyId: string
  ptyIncarnation: string
  modelSequenceEnd: number
  projectionSequenceEnd: number
  ownershipTransfer: PtyOwnershipTransferOutputEnvelope
  /** Exact fragment bytes admitted to the authoritative model. */
  data: string
}>

export type PtyOwnershipTransferModelCheckpointFragment = Readonly<{
  identity: PtyOwnershipTransferWireIdentity
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
  ptyId: string
  frameSeq: number
  fragmentStartSu: number
  fragmentEndSu: number
  frameLengthSu: number
  data: string
  modelSequenceEnd: number
}>

export type PtyOwnershipTransferModelCheckpointFrame = {
  identity: PtyOwnershipTransferWireIdentity
  surfaceBinding: PtyOwnershipTransferSurfaceBinding
  ptyId: string
  frameLengthSu: number
  fragments: Map<number, PtyOwnershipTransferModelCheckpointFragment>
}

export type TerminalSendOperationRecord = Readonly<{
  incarnationId: string
  payloadFingerprint: string
  bytesWritten: number
  expiresAt: number
}>

export type TerminalSendOperationInFlight = Readonly<{
  incarnationId: string
  payloadFingerprint: string
  promise: Promise<number>
}>

export const TERMINAL_SEND_OPERATION_TTL_MS = 15 * 60_000

export const TERMINAL_SEND_OPERATION_MAX_PER_PTY = 256

export function createPtyOwnershipTransferDestinationRegistry(
  store: RuntimeStore | null,
  runtimeId: string,
  publishPostCommitOutput:
    | PtyOwnershipTransferDestinationRuntimeOptions['publishPostCommitOutput']
    | undefined,
  publishPostCommitOutputAcknowledged?: PtyOwnershipTransferDestinationRuntimeOptions['publishPostCommitOutputAcknowledged']
): PtyOwnershipTransferDestinationRuntimeRegistry | null {
  if (
    !store ||
    !publishPostCommitOutput ||
    !publishPostCommitOutputAcknowledged ||
    typeof store.getProfileStorageDirectory !== 'function' ||
    typeof store.inspectPtyOwnershipTransferSurface !== 'function' ||
    typeof store.publishPtyOwnershipTransferSurface !== 'function'
  ) {
    return null
  }
  try {
    return new PtyOwnershipTransferDestinationRuntimeRegistry({
      runtimeId,
      store: store as PtyOwnershipTransferDestinationRuntimeOptions['store'],
      publishPostCommitOutput,
      publishPostCommitOutputAcknowledged
    })
  } catch {
    // A bad optional transfer sink must not prevent runtime startup.
    return null
  }
}

export function samePtyOwnershipTransferIdentity(
  left: PtyOwnershipTransferWireIdentity,
  right: PtyOwnershipTransferWireIdentity
): boolean {
  return (
    left.bridgeId === right.bridgeId &&
    left.terminalId === right.terminalId &&
    left.incarnationId === right.incarnationId &&
    left.ownerLease === right.ownerLease &&
    left.sourceOwnerGeneration === right.sourceOwnerGeneration &&
    left.destinationRuntimeId === right.destinationRuntimeId
  )
}

export function operationIdForChunk(operationId: string, index: number): string {
  return index === 0 ? operationId : `${operationId}:chunk:${index}`
}

import type {
  PtyOwnershipTransferAttachmentResult,
  PtyOwnershipTransferExitEvent
} from './pty-ownership-transfer-control-wire'
import {
  PtyOwnershipTransferDestinationError,
  type DestinationAdapterState,
  type PtyOwnershipTransferDestinationAttachmentReservation,
  type PtyOwnershipTransferDestinationSnapshot
} from './pty-ownership-transfer-destination-adapter-contract'
import { requireDestinationRecord } from './pty-ownership-transfer-destination-adapter-state'
import { snapshotDestinationTransfer } from './pty-ownership-transfer-destination-adapter-replay'

export function attachDestinationExecution(
  state: DestinationAdapterState,
  result: PtyOwnershipTransferAttachmentResult,
  reservation: PtyOwnershipTransferDestinationAttachmentReservation
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state, result)
  if (
    record.pendingAttachment !== reservation ||
    reservation.bridgeId !== record.identity.bridgeId ||
    reservation.destinationRuntimeId !== record.identity.destinationRuntimeId ||
    reservation.attachmentId !== result.attachmentId
  ) {
    throw new PtyOwnershipTransferDestinationError(
      'stale-attachment',
      'destination attachment result does not match the current attachment generation'
    )
  }
  if (record.phase === 'aborted' || result.phase !== record.phase) {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      'destination attachment does not match the durable transfer phase'
    )
  }
  record.pendingAttachment = undefined
  record.attachmentId = result.attachmentId
  record.attachmentGeneration = reservation.generation
  record.executionVerdict = result.executionVerdict
  record.exit = result.exit ? structuredClone(result.exit) : undefined
  return snapshotDestinationTransfer(state)
}

export function reserveDestinationExecutionAttachment(
  state: DestinationAdapterState,
  attachmentId: string
): PtyOwnershipTransferDestinationAttachmentReservation {
  const record = requireDestinationRecord(state)
  if (!attachmentId || record.phase === 'aborted' || record.executionVerdict === 'exited') {
    throw new PtyOwnershipTransferDestinationError(
      'invalid-phase',
      'destination execution cannot reserve this attachment'
    )
  }
  const reservation = Object.freeze({
    bridgeId: record.identity.bridgeId,
    destinationRuntimeId: record.identity.destinationRuntimeId,
    attachmentId,
    generation: record.nextAttachmentGeneration++
  })
  record.pendingAttachment = reservation
  record.attachmentId = undefined
  record.attachmentGeneration = undefined
  record.executionVerdict = 'unverifiable'
  return reservation
}

export function markDestinationExecutionUnverifiable(
  state: DestinationAdapterState,
  attachmentId: string
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state)
  if (record.attachmentId !== attachmentId || record.executionVerdict === 'exited') {
    return snapshotDestinationTransfer(state)
  }
  record.attachmentId = undefined
  record.attachmentGeneration = undefined
  record.executionVerdict = 'unverifiable'
  return snapshotDestinationTransfer(state)
}

export function acceptDestinationExit(
  state: DestinationAdapterState,
  event: PtyOwnershipTransferExitEvent
): PtyOwnershipTransferDestinationSnapshot {
  const record = requireDestinationRecord(state, event)
  if (record.attachmentId !== event.attachmentId) {
    throw new PtyOwnershipTransferDestinationError(
      'stale-attachment',
      'exit evidence does not match the current destination attachment'
    )
  }
  if (record.exit) {
    if (JSON.stringify(record.exit) !== JSON.stringify(event.exit)) {
      throw new PtyOwnershipTransferDestinationError(
        'exit-conflict',
        'exit evidence changed for the same ownership transfer'
      )
    }
    return snapshotDestinationTransfer(state)
  }
  record.exit = structuredClone(event.exit)
  record.executionVerdict = 'exited'
  return snapshotDestinationTransfer(state)
}

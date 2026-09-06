import { samePtyOwnershipTransferPublicationReceipt } from '../../shared/pty-ownership-transfer-receipt-validation'
import { samePtyOwnershipTransferSurfaceBinding } from '../../shared/pty-ownership-transfer-surface-binding'
import { validatePtyOwnershipTransferDestinationOutputRoute } from './pty-ownership-transfer-destination-output-admission'
import type { PtyOwnershipTransferTerminalModelCheckpointRequest } from '../persistence/loading-store/pty-ownership-transfer-surface-persistence'
import { normalizeDesktopTerminalScrollbackRows } from '../../shared/terminal-scrollback-policy'
import type {
  RuntimePtyOwnershipTransferModelCheckpoint,
  PtyOwnershipTransferModelCheckpointFragment
} from './runtime-ownership-transfer-contracts'
import { samePtyOwnershipTransferIdentity } from './runtime-ownership-transfer-contracts'
import { OrcaRuntimeWithOwnershipTransferRecovery } from './orca-runtime-ownership-transfer-recovery'

export class OrcaRuntimeWithOwnershipTransferCheckpoints extends OrcaRuntimeWithOwnershipTransferRecovery {
  async checkpointPtyOwnershipTransferModel(
    request: RuntimePtyOwnershipTransferModelCheckpoint
  ): Promise<void> {
    const destination = this.ptyOwnershipTransferDestinationRegistry
    const persist = this.store?.checkpointPtyOwnershipTransferTerminalModel
    if (!destination || !persist) {
      throw new Error('pty_ownership_transfer_model_checkpoint_unavailable')
    }
    const transfer = request.ownershipTransfer
    if (
      request.ptyIncarnation !== transfer.incarnationId ||
      transfer.destinationRuntimeId !== this.runtimeId ||
      !Number.isSafeInteger(request.modelSequenceEnd) ||
      request.modelSequenceEnd <= 0 ||
      request.projectionSequenceEnd !== request.modelSequenceEnd
    ) {
      throw new Error('pty_ownership_transfer_model_checkpoint_invalid')
    }
    const adapter = destination.get(transfer.bridgeId)
    if (!adapter) {
      throw new Error('pty_ownership_transfer_model_checkpoint_destination_unavailable')
    }
    const before = adapter.snapshot()
    if (
      !before ||
      before.phase !== 'published' ||
      !before.surfaceBinding ||
      !before.publicationReceipt ||
      !samePtyOwnershipTransferIdentity(before.identity, transfer)
    ) {
      throw new Error('pty_ownership_transfer_model_checkpoint_destination_unavailable')
    }
    validatePtyOwnershipTransferDestinationOutputRoute(
      {
        runtimeId: this.runtimeId,
        inspectPty: (ptyId) => this.ptysById.get(ptyId) ?? null
      },
      before.identity,
      before.surfaceBinding
    )
    if (before.surfaceBinding.ptyId !== request.ptyId) {
      throw new Error('pty_ownership_transfer_model_checkpoint_route_mismatch')
    }

    const snapshot = await this.serializeHeadlessTerminalBuffer(request.ptyId, {
      scrollbackRows: normalizeDesktopTerminalScrollbackRows(
        this.store?.getSettings().terminalScrollbackRows
      ),
      includeEmpty: true
    })
    if (!snapshot || snapshot.seq !== request.modelSequenceEnd) {
      throw new Error('pty_ownership_transfer_model_checkpoint_sequence_mismatch')
    }
    const after = adapter.snapshot()
    if (
      after.phase !== 'published' ||
      !after.surfaceBinding ||
      !after.publicationReceipt ||
      !samePtyOwnershipTransferIdentity(after.identity, before.identity) ||
      !samePtyOwnershipTransferPublicationReceipt(
        after.publicationReceipt,
        before.publicationReceipt
      ) ||
      this.getPtyOutputSequence(request.ptyId) !== request.modelSequenceEnd
    ) {
      throw new Error('pty_ownership_transfer_model_checkpoint_superseded')
    }
    validatePtyOwnershipTransferDestinationOutputRoute(
      {
        runtimeId: this.runtimeId,
        inspectPty: (ptyId) => this.ptysById.get(ptyId) ?? null
      },
      after.identity,
      after.surfaceBinding
    )
    const checkpoint: PtyOwnershipTransferTerminalModelCheckpointRequest = {
      identity: after.identity,
      surfaceBinding: after.surfaceBinding,
      publicationReceipt: after.publicationReceipt,
      modelData: `${snapshot.scrollbackAnsi ?? ''}${snapshot.data}${snapshot.frameRestoreAnsi ?? ''}${snapshot.pendingEscapeTailAnsi ?? ''}`
    }
    persist.call(this.store, checkpoint)
    destination.recordModelCheckpoint(after.identity, {
      ptyId: request.ptyId,
      frameSeq: transfer.frameSeq,
      fragmentStartSu: transfer.fragmentStartSu,
      fragmentEndSu: transfer.fragmentEndSu,
      frameLengthSu: transfer.frameLengthSu,
      data: request.data,
      modelSequenceEnd: request.modelSequenceEnd
    })
    this.recordPtyOwnershipTransferModelCheckpoint({
      identity: after.identity,
      surfaceBinding: after.surfaceBinding,
      ptyId: request.ptyId,
      frameSeq: transfer.frameSeq,
      fragmentStartSu: transfer.fragmentStartSu,
      fragmentEndSu: transfer.fragmentEndSu,
      frameLengthSu: transfer.frameLengthSu,
      data: request.data,
      modelSequenceEnd: request.modelSequenceEnd
    })
  }

  protected recordPtyOwnershipTransferModelCheckpoint(
    fragment: PtyOwnershipTransferModelCheckpointFragment
  ): void {
    let frames = this.ptyOwnershipTransferModelCheckpointsByBridge.get(fragment.identity.bridgeId)
    if (!frames) {
      frames = new Map()
      this.ptyOwnershipTransferModelCheckpointsByBridge.set(fragment.identity.bridgeId, frames)
    }
    const existing = frames.get(fragment.frameSeq)
    if (existing) {
      if (
        !samePtyOwnershipTransferIdentity(existing.identity, fragment.identity) ||
        existing.ptyId !== fragment.ptyId ||
        existing.frameLengthSu !== fragment.frameLengthSu ||
        !samePtyOwnershipTransferSurfaceBinding(existing.surfaceBinding, fragment.surfaceBinding)
      ) {
        throw new Error('pty_ownership_transfer_model_checkpoint_conflict')
      }
    } else {
      frames.set(fragment.frameSeq, {
        identity: Object.freeze({ ...fragment.identity }),
        surfaceBinding: Object.freeze({ ...fragment.surfaceBinding }),
        ptyId: fragment.ptyId,
        frameLengthSu: fragment.frameLengthSu,
        fragments: new Map()
      })
    }
    const frame = frames.get(fragment.frameSeq)!
    const previous = frame.fragments.get(fragment.fragmentStartSu)
    if (previous) {
      if (
        previous.fragmentEndSu !== fragment.fragmentEndSu ||
        previous.data !== fragment.data ||
        previous.modelSequenceEnd !== fragment.modelSequenceEnd
      ) {
        throw new Error('pty_ownership_transfer_model_checkpoint_conflict')
      }
      return
    }
    frame.fragments.set(fragment.fragmentStartSu, Object.freeze({ ...fragment }))
    // Keep this receipt ledger bounded across long-lived SSH sessions.
    const allFrames = [...this.ptyOwnershipTransferModelCheckpointsByBridge.values()]
    let count = allFrames.reduce((total, entries) => total + entries.size, 0)
    while (count > 4096) {
      const first = allFrames.find((entries) => entries.size > 0)
      const oldest = first ? [...first.keys()].sort((left, right) => left - right)[0] : undefined
      if (first && oldest !== undefined) {
        first.delete(oldest)
        count -= 1
      } else {
        break
      }
    }
  }
}

import { createHash } from 'node:crypto'
import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferIdentity,
  PtyOwnershipTransferPublicationReceipt
} from '../../../shared/pty-ownership-transfer-journal'
import {
  samePtyOwnershipTransferCommitReceipt,
  samePtyOwnershipTransferPublicationReceipt
} from '../../../shared/pty-ownership-transfer-receipt-validation'
import {
  parsePtyOwnershipTransferSurfaceBinding,
  samePtyOwnershipTransferSurfaceBinding,
  type PtyOwnershipTransferSurfaceBinding
} from '../../../shared/pty-ownership-transfer-surface-binding'
import type { PtyOwnershipTransferDestinationFileRecord } from './pty-ownership-transfer-destination-file'

type DestinationSurfaceFileStoreContext = Readonly<{
  loadRecord: (identity: PtyOwnershipTransferIdentity) => PtyOwnershipTransferDestinationFileRecord
  persist: (
    identity: PtyOwnershipTransferIdentity,
    record: PtyOwnershipTransferDestinationFileRecord
  ) => void
  now: () => Date
}>

export class PtyOwnershipTransferDestinationSurfaceFileStore {
  constructor(private readonly context: DestinationSurfaceFileStoreContext) {}

  loadSurfaceBinding(
    identity: PtyOwnershipTransferIdentity
  ): PtyOwnershipTransferSurfaceBinding | null {
    return structuredClone(this.context.loadRecord(identity).surfaceBinding ?? null)
  }

  bindSurface(
    identity: PtyOwnershipTransferIdentity,
    binding: PtyOwnershipTransferSurfaceBinding
  ): PtyOwnershipTransferSurfaceBinding {
    const current = this.context.loadRecord(identity)
    const parsed = parsePtyOwnershipTransferSurfaceBinding(binding)
    if (current.surfaceBinding) {
      if (!samePtyOwnershipTransferSurfaceBinding(current.surfaceBinding, parsed)) {
        throw new Error('pty_ownership_transfer_destination_surface_conflict')
      }
      return structuredClone(current.surfaceBinding)
    }
    if (current.journal.phase === 'published' || current.journal.phase === 'aborted') {
      throw new Error('pty_ownership_transfer_destination_surface_phase_invalid')
    }
    this.context.persist(identity, { ...current, surfaceBinding: parsed })
    return structuredClone(parsed)
  }

  reservePublication(
    identity: PtyOwnershipTransferIdentity,
    receipt: PtyOwnershipTransferCommitReceipt
  ): PtyOwnershipTransferPublicationReceipt {
    const current = this.context.loadRecord(identity)
    if (
      (current.journal.phase !== 'committed' && current.journal.phase !== 'published') ||
      !current.journal.receipt ||
      !samePtyOwnershipTransferCommitReceipt(current.journal.receipt, receipt)
    ) {
      throw new Error('pty_ownership_transfer_destination_publication_phase_invalid')
    }
    if (!current.surfaceBinding) {
      throw new Error('pty_ownership_transfer_destination_surface_unbound')
    }
    if (current.publicationIntent) {
      return structuredClone(current.publicationIntent)
    }
    const publicationIntent: PtyOwnershipTransferPublicationReceipt = {
      version: 1,
      publicationReceiptId: publicationReceiptId(identity, current.surfaceBinding, receipt),
      bridgeId: identity.bridgeId,
      destinationRuntimeId: identity.destinationRuntimeId,
      commitReceipt: structuredClone(receipt),
      publishedAt: this.context.now().toISOString(),
      surfaceBinding: structuredClone(current.surfaceBinding)
    }
    this.context.persist(identity, { ...current, publicationIntent })
    return structuredClone(publicationIntent)
  }

  assertPublicationIntent(
    identity: PtyOwnershipTransferIdentity,
    receipt: PtyOwnershipTransferPublicationReceipt
  ): void {
    const current = this.context.loadRecord(identity)
    if (
      !current.publicationIntent ||
      !samePtyOwnershipTransferPublicationReceipt(current.publicationIntent, receipt)
    ) {
      throw new Error('pty_ownership_transfer_destination_publication_intent_conflict')
    }
  }
}

function publicationReceiptId(
  identity: PtyOwnershipTransferIdentity,
  binding: PtyOwnershipTransferSurfaceBinding,
  receipt: PtyOwnershipTransferCommitReceipt
): string {
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        identity.bridgeId,
        identity.terminalId,
        identity.incarnationId,
        identity.ownerLease,
        identity.sourceOwnerGeneration,
        identity.destinationRuntimeId,
        binding.executionHostId,
        binding.workspaceKey,
        binding.tabId,
        binding.leafId,
        binding.ptyId,
        receipt.receiptId,
        receipt.bridgeId,
        receipt.acceptedSourceEndSeq,
        receipt.committedAt
      ])
    )
    .digest('hex')
  return `surface-publication-${digest}`
}

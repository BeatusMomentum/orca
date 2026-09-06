import { join } from 'node:path'
import {
  PtyOwnershipTransferDestinationAdapter,
  PtyOwnershipTransferDestinationError,
  type PtyOwnershipTransferDestinationAttachmentReservation,
  type PtyOwnershipTransferDestinationAdapterOptions,
  type PtyOwnershipTransferDestinationSnapshot
} from '../../../shared/pty-ownership-transfer-destination-adapter'
import type {
  PtyOwnershipTransferPrepareResult,
  PtyOwnershipTransferWireIdentity,
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferAttachmentResult,
  PtyOwnershipTransferExitEvent
} from '../../../shared/pty-ownership-transfer-wire'
import type { PtyOwnershipBridgeCapabilities } from '../../../shared/pty-ownership-bridge-contract'
import type { Store } from '../loading-store/store'
import {
  PtyOwnershipTransferDestinationFileStore,
  ptyOwnershipTransferDestinationDirectory
} from './pty-ownership-transfer-destination-file-store'
import { PtyOwnershipTransferDestinationOutputOutbox } from './pty-ownership-transfer-destination-output-outbox'
import { PtyOwnershipTransferDestinationOutputAdmission } from './pty-ownership-transfer-destination-output-admission'
import { PtyOwnershipTransferDestinationExitAdmission } from './pty-ownership-transfer-destination-exit-admission'
import {
  PtyOwnershipTransferDestinationOutputSink,
  type PtyOwnershipTransferOutputAcknowledgement
} from './pty-ownership-transfer-destination-output-sink'
import type { PtyOwnershipTransferOutputModelCheckpoint } from './pty-ownership-transfer-destination-output-outbox-record'
import {
  PtyOwnershipTransferSurfacePublicationCoordinator,
  type PtyOwnershipTransferDurableSurfaceTarget
} from './pty-ownership-transfer-surface-publication'
import {
  prepareResultFromPtyOwnershipTransferRecoveryCandidate,
  type PtyOwnershipTransferDestinationRecoveryCandidate
} from './pty-ownership-transfer-destination-recovery-candidates'
import { samePtyOwnershipTransferIdentity } from '../../../shared/pty-ownership-transfer-identity'
import {
  watchPtyOwnershipTransferDestinationExit,
  type PtyOwnershipTransferDestinationExitSource
} from './pty-ownership-transfer-destination-exit-watch'
import {
  watchPtyOwnershipTransferDestinationOutput,
  type PtyOwnershipTransferDestinationOutputSource
} from './pty-ownership-transfer-destination-output-watch'

export type { PtyOwnershipTransferDestinationSnapshot } from '../../../shared/pty-ownership-transfer-destination-adapter'

type DestinationSurfaceStore = Pick<
  Store,
  | 'getProfileStorageDirectory'
  | 'inspectPtyOwnershipTransferSurface'
  | 'publishPtyOwnershipTransferSurface'
>

export type PtyOwnershipTransferDestinationRuntimeOptions = Readonly<{
  runtimeId: string
  store: DestinationSurfaceStore
  publishPostCommitOutput: PtyOwnershipTransferDestinationAdapterOptions['publishPostCommitOutput']
  /** Optional strict sink acknowledgement; omission retains the legacy callback path. */
  publishPostCommitOutputAcknowledged?: (
    identity: Parameters<
      PtyOwnershipTransferDestinationAdapterOptions['publishPostCommitOutput']
    >[0],
    surfaceBinding: Parameters<
      PtyOwnershipTransferDestinationAdapterOptions['publishPostCommitOutput']
    >[1],
    frame: Parameters<PtyOwnershipTransferDestinationAdapterOptions['publishPostCommitOutput']>[2]
  ) => PtyOwnershipTransferOutputAcknowledgement
  inputIds?: number
}>

export type PreparedPtyOwnershipTransferDestination = Readonly<{
  adapter: PtyOwnershipTransferDestinationAdapter
  snapshot: PtyOwnershipTransferDestinationSnapshot
}>

export type RecoveredPtyOwnershipTransferDestination = Readonly<{
  bridgeId: string
  destinationRuntimeId: string
  phase: PtyOwnershipTransferDestinationSnapshot['phase']
  adapter: PtyOwnershipTransferDestinationAdapter
  snapshot: PtyOwnershipTransferDestinationSnapshot
}>

export class PtyOwnershipTransferWorkspaceSurfaceTarget implements PtyOwnershipTransferDurableSurfaceTarget {
  constructor(private readonly store: DestinationSurfaceStore) {}

  inspectDurablePublication: PtyOwnershipTransferDurableSurfaceTarget['inspectDurablePublication'] =
    (request) => this.store.inspectPtyOwnershipTransferSurface(request)

  publishDurably: PtyOwnershipTransferDurableSurfaceTarget['publishDurably'] = (request) => {
    this.store.publishPtyOwnershipTransferSurface(request)
  }
}

/** Profile-scoped construction point for crash-recoverable destination adapters. */
export class PtyOwnershipTransferDestinationRuntimeRegistry {
  private readonly adapters = new Map<string, PtyOwnershipTransferDestinationAdapter>()
  private readonly exitListeners = new Map<string, () => void>()
  private readonly destinationStore: PtyOwnershipTransferDestinationFileStore
  private readonly outputOutbox: PtyOwnershipTransferDestinationOutputOutbox
  private readonly outputSink: PtyOwnershipTransferDestinationOutputSink
  private readonly outputAdmission = new PtyOwnershipTransferDestinationOutputAdmission()
  private readonly exitAdmission = new PtyOwnershipTransferDestinationExitAdmission()
  private readonly publication: PtyOwnershipTransferSurfacePublicationCoordinator

  constructor(private readonly options: PtyOwnershipTransferDestinationRuntimeOptions) {
    if (!options.runtimeId) {
      throw new Error('pty_ownership_transfer_destination_runtime_invalid')
    }
    this.destinationStore = new PtyOwnershipTransferDestinationFileStore({
      directory: ptyOwnershipTransferDestinationDirectory(
        options.store.getProfileStorageDirectory()
      )
    })
    this.outputOutbox = new PtyOwnershipTransferDestinationOutputOutbox({
      directory: join(
        ptyOwnershipTransferDestinationDirectory(options.store.getProfileStorageDirectory()),
        'output-outbox-v1'
      )
    })
    this.outputSink = new PtyOwnershipTransferDestinationOutputSink({
      outbox: this.outputOutbox,
      deliver: (identity, surfaceBinding, frame) => {
        if (this.options.publishPostCommitOutputAcknowledged) {
          return this.options.publishPostCommitOutputAcknowledged(identity, surfaceBinding, frame)
        }
        this.options.publishPostCommitOutput(identity, surfaceBinding, frame)
        return { identity, throughSeq: frame.seq }
      }
    })
    this.publication = new PtyOwnershipTransferSurfacePublicationCoordinator(
      new PtyOwnershipTransferWorkspaceSurfaceTarget(options.store)
    )
  }

  prepare(result: PtyOwnershipTransferPrepareResult): PreparedPtyOwnershipTransferDestination {
    if (result.destinationRuntimeId !== this.options.runtimeId) {
      throw new Error('pty_ownership_transfer_destination_runtime_mismatch')
    }
    // Open the post-commit outbox once per transfer. A later prepare may report a newer source
    // cursor while the source is fenced; retain the original baseline instead of conflicting.
    const outputSnapshot = this.outputOutbox.load(result)
    if (!outputSnapshot) {
      this.outputSink.open(result, result.sourceOutputEndSeq)
    }
    let adapter = this.adapters.get(result.bridgeId)
    if (!adapter) {
      adapter = new PtyOwnershipTransferDestinationAdapter({
        store: this.destinationStore,
        publishDurably: (request) => this.publication.publish(request),
        publishPostCommitOutput: (identity, surfaceBinding, frame) =>
          this.outputSink.publish(identity, surfaceBinding, frame),
        markPostCommitOutputBaseline: (identity, throughSeq) =>
          this.outputSink.markCommittedThrough(identity, throughSeq),
        ...(this.options.inputIds === undefined ? {} : { inputIds: this.options.inputIds })
      })
      this.adapters.set(result.bridgeId, adapter)
    }
    const snapshot = adapter.prepare(result)
    if (outputSnapshot && (snapshot.phase === 'committed' || snapshot.phase === 'published')) {
      adapter.restorePostCommitOutputBaseline(outputSnapshot.acknowledgedEndSeq)
    }
    return Object.freeze({ adapter, snapshot: adapter.snapshot() })
  }

  get(bridgeId: string): PtyOwnershipTransferDestinationAdapter | null {
    return this.adapters.get(bridgeId) ?? null
  }

  /** Discover interrupted sessions at startup without contacting or mutating their source. */
  listRecoveryCandidates(): readonly PtyOwnershipTransferDestinationRecoveryCandidate[] {
    return this.destinationStore.listRecoveryCandidates()
  }

  /** Reopen durable sessions for this runtime without contacting their source host. */
  recoverPersistedAdapters(): readonly RecoveredPtyOwnershipTransferDestination[] {
    const recovered: RecoveredPtyOwnershipTransferDestination[] = []
    for (const candidate of this.listRecoveryCandidates()) {
      if (candidate.journal.destinationRuntimeId !== this.options.runtimeId) {
        continue
      }
      const prepared = this.prepare(
        prepareResultFromPtyOwnershipTransferRecoveryCandidate(candidate)
      )
      recovered.push(
        Object.freeze({
          bridgeId: candidate.journal.bridgeId,
          destinationRuntimeId: candidate.journal.destinationRuntimeId,
          phase: prepared.snapshot.phase,
          adapter: prepared.adapter,
          snapshot: prepared.snapshot
        })
      )
    }
    return Object.freeze(recovered)
  }

  /** Keep authoritative source exit evidence attached to the exact destination adapter. */
  watchDestinationExit(
    source: PtyOwnershipTransferDestinationExitSource,
    capabilities: PtyOwnershipBridgeCapabilities,
    adapter: PtyOwnershipTransferDestinationAdapter,
    reservation?: PtyOwnershipTransferDestinationAttachmentReservation
  ): () => void {
    return watchPtyOwnershipTransferDestinationExit(
      source,
      capabilities,
      adapter.snapshot().identity,
      adapter.snapshot().attachmentId ?? '',
      adapter,
      reservation,
      this.exitAdmission,
      this.exitListeners
    )
  }

  watchDestinationExitForAttachment(
    source: PtyOwnershipTransferDestinationExitSource,
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    adapter: PtyOwnershipTransferDestinationAdapter,
    reservation?: PtyOwnershipTransferDestinationAttachmentReservation
  ): () => void {
    return watchPtyOwnershipTransferDestinationExit(
      source,
      capabilities,
      identity,
      attachmentId,
      adapter,
      reservation,
      this.exitAdmission,
      this.exitListeners
    )
  }

  /** Keep a paired source output stream bound to the exact attachment reservation. */
  watchDestinationOutput(
    source: PtyOwnershipTransferDestinationOutputSource,
    capabilities: PtyOwnershipBridgeCapabilities,
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    adapter: PtyOwnershipTransferDestinationAdapter,
    reservation?: PtyOwnershipTransferDestinationAttachmentReservation
  ): () => void {
    return watchPtyOwnershipTransferDestinationOutput(
      source,
      capabilities,
      identity,
      attachmentId,
      adapter,
      reservation
        ? (eventIdentity, frame) => this.acceptPostCommitOutputAfterAttachment(eventIdentity, frame)
        : undefined
    )
  }

  /** Return frames durably queued after a crash, without mutating the transfer. */
  pendingPostCommitOutput(
    identity: PtyOwnershipTransferWireIdentity
  ): ReturnType<PtyOwnershipTransferDestinationOutputOutbox['load']> {
    return this.outputOutbox.load(identity)
  }

  /** Durably stage one complete frame without publishing it to the terminal surface. */
  stagePostCommitOutput(
    identity: PtyOwnershipTransferWireIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): void {
    const adapter = this.adapters.get(identity.bridgeId)
    if (!adapter) {
      throw new Error('pty_ownership_transfer_destination_adapter_unavailable')
    }
    const snapshot = adapter.snapshot()
    if (!samePtyOwnershipTransferIdentity(snapshot.identity, identity)) {
      throw new Error('pty_ownership_transfer_destination_identity_mismatch')
    }
    if (snapshot.phase !== 'committed' && snapshot.phase !== 'published') {
      throw new Error('pty_ownership_transfer_destination_output_unavailable')
    }
    if (!snapshot.surfaceBinding) {
      throw new Error('pty_ownership_transfer_destination_surface_unbound')
    }
    this.outputSink.stage(identity, frame)
  }

  /** Persist the exact model fragment that made a post-commit frame safe to acknowledge. */
  recordModelCheckpoint(
    identity: PtyOwnershipTransferWireIdentity,
    checkpoint: PtyOwnershipTransferOutputModelCheckpoint
  ): void {
    const adapter = this.adapters.get(identity.bridgeId)
    if (!adapter) {
      throw new Error('pty_ownership_transfer_destination_adapter_unavailable')
    }
    const snapshot = adapter.snapshot()
    if (
      !samePtyOwnershipTransferIdentity(snapshot.identity, identity) ||
      (snapshot.phase !== 'committed' && snapshot.phase !== 'published')
    ) {
      throw new Error('pty_ownership_transfer_destination_identity_mismatch')
    }
    this.outputOutbox.recordModelCheckpoint(identity, checkpoint)
  }

  loadModelCheckpoints(
    identity: PtyOwnershipTransferWireIdentity
  ): readonly PtyOwnershipTransferOutputModelCheckpoint[] {
    return this.outputOutbox.loadModelCheckpoints(identity)
  }

  /** Route one complete frame from the transport receive path into the durable destination sink. */
  acceptPostCommitOutput(
    identity: PtyOwnershipTransferWireIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): void {
    const adapter = this.adapters.get(identity.bridgeId)
    if (!adapter) {
      throw new Error('pty_ownership_transfer_destination_adapter_unavailable')
    }
    const snapshot = adapter.snapshot()
    if (!samePtyOwnershipTransferIdentity(snapshot.identity, identity)) {
      throw new Error('pty_ownership_transfer_destination_identity_mismatch')
    }
    adapter.acceptPostCommitOutput(frame)
  }

  /** Wait for recovery's attachment barrier without releasing this frame's source credit. */
  async acceptPostCommitOutputAfterAttachment(
    identity: PtyOwnershipTransferWireIdentity,
    frame: PtyOwnershipTransferOutputFrame
  ): Promise<void> {
    try {
      this.acceptPostCommitOutput(identity, frame)
    } catch (error) {
      if (
        !(error instanceof PtyOwnershipTransferDestinationError) ||
        error.reason !== 'stale-attachment'
      ) {
        throw error
      }
      await this.outputAdmission.defer(identity, frame)
    }
  }

  /** Apply a relay attachment result to the exact durable destination adapter. */
  acceptDestinationAttachment(
    result: PtyOwnershipTransferAttachmentResult,
    reservation: PtyOwnershipTransferDestinationAttachmentReservation
  ): ReturnType<PtyOwnershipTransferDestinationAdapter['attachExecution']> {
    const adapter = this.adapters.get(result.bridgeId)
    if (!adapter) {
      throw new Error('pty_ownership_transfer_destination_adapter_unavailable')
    }
    const snapshot = adapter.snapshot()
    if (!samePtyOwnershipTransferIdentity(snapshot.identity, result)) {
      throw new Error('pty_ownership_transfer_destination_identity_mismatch')
    }
    adapter.attachExecution(result, reservation)
    this.exitAdmission.settle(reservation, adapter)
    this.outputAdmission.settle(result, (frame) => adapter.acceptPostCommitOutput(frame))
    return adapter.snapshot()
  }

  rejectPendingPostCommitOutputAdmission(
    identity: PtyOwnershipTransferWireIdentity,
    error: unknown
  ): void {
    this.outputAdmission.reject(identity, error)
  }

  /** Apply a generation-fenced relay exit notification to the destination journal. */
  acceptDestinationExit(
    event: PtyOwnershipTransferExitEvent
  ): ReturnType<PtyOwnershipTransferDestinationAdapter['acceptExit']> {
    const adapter = this.adapters.get(event.bridgeId)
    if (!adapter) {
      throw new Error('pty_ownership_transfer_destination_adapter_unavailable')
    }
    const snapshot = adapter.snapshot()
    if (!samePtyOwnershipTransferIdentity(snapshot.identity, event)) {
      throw new Error('pty_ownership_transfer_destination_identity_mismatch')
    }
    return adapter.acceptExit(event)
  }

  /** Replay queued frames through the same idempotent sink used for live output. */
  replayPendingPostCommitOutput(identity: PtyOwnershipTransferWireIdentity): number {
    const adapter = this.adapters.get(identity.bridgeId)
    if (!adapter) {
      throw new Error('pty_ownership_transfer_destination_adapter_unavailable')
    }
    const pending = this.outputOutbox.load(identity)?.pendingFrames ?? []
    for (const frame of pending) {
      adapter.acceptPostCommitOutput(frame)
    }
    return pending.length
  }
}

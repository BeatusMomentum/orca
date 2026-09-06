import type {
  PtyOwnershipTransferControl,
  PtyOwnershipTransferControlResult,
  PtyOwnershipTransferExit,
  PtyOwnershipTransferExitEvent,
  PtyOwnershipTransferOutputFrame,
  PtyOwnershipTransferSurfacePublication,
  PtyOwnershipTransferWireIdentity
} from '../shared/pty-ownership-transfer-wire'
import type {
  PtyOwnershipTransferCommitReceipt,
  PtyOwnershipTransferPublicationReceipt
} from '../shared/pty-ownership-transfer-journal-contract'
import type { RequestContext } from './dispatcher'

export type RelayPtyOwnershipTransferSource = Readonly<{
  terminalId: string
  incarnationId: string
  ownerLease: string
  sourceOwnerGeneration: number
}>

export type RelayPtyOwnershipTransferDurableRecord = Readonly<{
  version: 1
  identity: PtyOwnershipTransferWireIdentity
  phase: 'prepared' | 'committed' | 'published' | 'aborted'
  sourceOutputEndSeq: number
  replayStartSeq: number
  history: Readonly<{
    nextSeq: number
    frames: readonly PtyOwnershipTransferOutputFrame[]
  }>
  /** Bounded retry identity retained so a relay restart can replay a failed publication safely. */
  observedEmissions?: readonly Readonly<{
    key: string
    data: string
    frames: readonly PtyOwnershipTransferOutputFrame[]
  }>[]
  acceptedInputs: readonly Readonly<{ inputId: string; data: string }>[]
  acceptedControls: readonly Readonly<{
    controlId: string
    serializedControl: string
    outcome: PtyOwnershipTransferControlResult['outcome']
  }>[]
  /** Stable across relay restart; the socket/client binding remains intentionally ephemeral. */
  reconnectRoute?: Readonly<{
    generation: number
    attachmentId: string
  }>
  exit?: PtyOwnershipTransferExit
  surfacePublication?: PtyOwnershipTransferSurfacePublication
  commitReceipt?: PtyOwnershipTransferCommitReceipt
  publicationReceipt?: PtyOwnershipTransferPublicationReceipt
}>

export type RelayPtyOwnershipTransferStore = Readonly<{
  loadAll: () => readonly RelayPtyOwnershipTransferDurableRecord[]
  save: (record: RelayPtyOwnershipTransferDurableRecord) => void
  remove: (bridgeId: string) => void
}>

export type RelayPtyOwnershipTransferAdapterOptions = Readonly<{
  replayBytes?: number
  inputIds?: number
  /** Optional crash-safe source journal. Mutations remain dormant unless the caller registers them. */
  store?: RelayPtyOwnershipTransferStore
  resolveSource: (terminalId: string) => RelayPtyOwnershipTransferSource | null
  /** Authorizes the requesting owner before any transfer RPC mutates relay state. */
  authorizeRequest: (
    method: string,
    request: unknown,
    context: RequestContext
  ) => boolean | Promise<boolean>
  /** Fences source-side input. Output remains live and is captured by observeOutput(). */
  setInputFenced: (terminalId: string, fenced: boolean) => void
  /** Destination input is written only after a commit receipt has been accepted. */
  writeDestinationInput: (terminalId: string, data: string) => void
  /** Publishes output generated after commit through the existing source-credit transport. */
  publishDestinationOutput: (
    identity: PtyOwnershipTransferWireIdentity,
    attachmentId: string,
    frame: PtyOwnershipTransferOutputFrame
  ) => void
  applyDestinationControl?: (
    identity: PtyOwnershipTransferWireIdentity,
    control: PtyOwnershipTransferControl
  ) => 'applied' | 'unverifiable' | Promise<'applied' | 'unverifiable'>
  /** Publishes exit only to the relay client/generation that owns the attachment. */
  publishDestinationExit?: (
    event: PtyOwnershipTransferExitEvent,
    binding?: Readonly<{ clientId: number; transportGeneration?: number }>
  ) => void
  createExitEventId?: () => string
  now?: () => Date
  onCommitted?: (identity: PtyOwnershipTransferWireIdentity) => void
  onPublished?: (identity: PtyOwnershipTransferWireIdentity) => void
  onAborted?: (identity: PtyOwnershipTransferWireIdentity) => void
}>

export type RelayPtyOwnershipTransferControlRecord = Readonly<{
  serializedControl: string
  outcome: PtyOwnershipTransferControlResult['outcome']
}>

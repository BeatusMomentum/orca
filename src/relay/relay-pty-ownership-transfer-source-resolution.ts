import type { RelayPtyOwnershipTransferSource } from './relay-pty-ownership-transfer-adapter-contract'
import type { RelayPtySourceDeliveryRecord } from './relay-pty-source-send-scheduler'
import type { SshPtyConsumerSessionAdapter } from './ssh-pty-consumer-session-adapter'

/** Exact live owner lookup used before any source-side transfer mutation. */
export class RelayPtyOwnershipTransferSourceResolver {
  constructor(
    private readonly deliveries: ReadonlyMap<string, RelayPtySourceDeliveryRecord>,
    private readonly session: SshPtyConsumerSessionAdapter
  ) {}

  resolve(id: string): RelayPtyOwnershipTransferSource | null {
    const record = this.deliveries.get(id)
    if (!record) {
      return null
    }
    const owner = this.session.activeSessionOwner(record.clientId)
    if (!owner || owner.ownerGeneration !== record.identity.ownerGeneration) {
      return null
    }
    return Object.freeze({
      terminalId: id,
      incarnationId: record.identity.ptyIncarnation,
      ownerLease: owner.ownerLease,
      sourceOwnerGeneration: owner.ownerGeneration
    })
  }

  authorizes(
    id: string,
    ownerLease: string,
    sourceOwnerGeneration: number,
    clientId: number
  ): boolean {
    const record = this.deliveries.get(id)
    if (!record || record.clientId !== clientId) {
      return false
    }
    const source = this.resolve(id)
    return (
      source?.ownerLease === ownerLease && source.sourceOwnerGeneration === sourceOwnerGeneration
    )
  }

  authorizesResumedTransfer(
    ownerLease: string,
    sourceOwnerGeneration: number,
    clientId: number
  ): boolean {
    const owner = this.session.activeSessionOwner(clientId)
    return Boolean(
      Number.isSafeInteger(sourceOwnerGeneration) &&
      sourceOwnerGeneration > 0 &&
      owner &&
      owner.ownerLease === ownerLease &&
      owner.ownerGeneration > sourceOwnerGeneration
    )
  }

  /** Exact generation check used after a durable route rekey; later owners cannot reuse it. */
  authorizesResumedTransferAtGeneration(
    ownerLease: string,
    reconnectGeneration: number,
    clientId: number
  ): boolean {
    const owner = this.session.activeSessionOwner(clientId)
    return Boolean(
      Number.isSafeInteger(reconnectGeneration) &&
      reconnectGeneration > 0 &&
      owner &&
      owner.ownerLease === ownerLease &&
      owner.ownerGeneration === reconnectGeneration
    )
  }
}

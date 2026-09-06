import { z } from 'zod'
import { PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS } from '../../../../shared/pty-ownership-transfer-runtime-methods'
import {
  parsePtyOwnershipTransferAbortRequest,
  parsePtyOwnershipTransferCommitRequest,
  parsePtyOwnershipTransferInputRequest,
  parsePtyOwnershipTransferPrepareRequest,
  parsePtyOwnershipTransferPublishRequest,
  parsePtyOwnershipTransferReplayRequest,
  parsePtyOwnershipTransferRetireInputRequest,
  parsePtyOwnershipTransferSourceStreamRequest,
  parsePtyOwnershipTransferOutputAcknowledgementRequest
} from '../../../../shared/pty-ownership-transfer-wire'
import {
  parsePtyOwnershipTransferAttachmentRequest,
  parsePtyOwnershipTransferControlRequest
} from '../../../../shared/pty-ownership-transfer-control-wire'
import { parsePtyOwnershipTransferReconnectRekeyRequest } from '../../../../shared/pty-ownership-transfer-reconnect-rekey-wire'
import type { RuntimePtyOwnershipTransferSourceAdapter } from '../../../providers/runtime-pty-ownership-transfer-source-adapter'
import { PtyOwnershipTransferOutputCreditWindow } from '../../../../shared/pty-ownership-transfer-output-credit'
import type { PtyOwnershipTransferOutputFrame } from '../../../../shared/pty-ownership-transfer-wire'
import {
  defineMethod,
  defineStreamingMethod,
  type RpcAnyMethod,
  type RpcContext,
  type RpcMethod
} from '../core'
import { samePtyOwnershipTransferIdentity } from '../../../../shared/pty-ownership-transfer-identity'
import { parsePtyOwnershipTransferSourceGrantRequest } from '../../../../shared/pty-ownership-transfer-source-grant'

const RuntimeOwnedPtyPreflight = z.object({
  ptyId: z.string().min(1),
  destinationRuntimeId: z.string().min(1)
})

const PtyOwnershipTransferIdentity = z.object({
  bridgeId: z.string().min(1),
  terminalId: z.string().min(1),
  incarnationId: z.string().min(1),
  ownerLease: z.string().min(1),
  sourceOwnerGeneration: z.number().int().positive(),
  destinationRuntimeId: z.string().min(1)
})

const RuntimeOwnedPtyStatus = RuntimeOwnedPtyPreflight.extend({
  identity: PtyOwnershipTransferIdentity,
  timeoutMs: z.number().int().positive().optional()
})

const RuntimeOwnedPtyMutation = z.unknown()

const RuntimeOwnedPtyStream = z.unknown()

export const PTY_OWNERSHIP_TRANSFER_METHODS: RpcAnyMethod[] = [
  defineMethod({
    name: PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.preflightSource,
    params: RuntimeOwnedPtyPreflight,
    handler: (params, context) => {
      requirePairedRuntimeClient(context)
      return context.runtime.preflightPtyOwnershipTransfer({
        connectionId: null,
        ptyId: params.ptyId,
        destinationRuntimeId: params.destinationRuntimeId
      })
    }
  }),
  defineMethod({
    name: PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.statusSource,
    params: RuntimeOwnedPtyStatus,
    handler: (params, context) => {
      requirePairedRuntimeClient(context)
      return context.runtime.getPtyOwnershipTransferStatus({
        connectionId: null,
        ptyId: params.ptyId,
        destinationRuntimeId: params.destinationRuntimeId,
        identity: params.identity,
        ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs })
      })
    }
  }),
  defineMethod({
    name: PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.grantSource,
    params: z.unknown(),
    handler: (params, context) => {
      requirePairedRuntimeClient(context)
      return context.runtime.issuePairedRuntimePtyOwnershipTransferSourceGrant(
        parsePtyOwnershipTransferSourceGrantRequest(params),
        createBinding(context)
      )
    }
  }),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.prepareSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferPrepareRequest,
    (source, request, binding) => source.prepare(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.replaySource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferReplayRequest,
    (source, request, binding) => source.replay(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.commitSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferCommitRequest,
    (source, request, binding) => source.commit(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.publishSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferPublishRequest,
    (source, request, binding) => source.publish(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.inputSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferInputRequest,
    (source, request, binding) => source.acceptInput(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.retireInputSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferRetireInputRequest,
    (source, request, binding) => source.retireInput(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.attachSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferAttachmentRequest,
    (source, request, binding) => source.attachDestination(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.rekeyReconnectSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferReconnectRekeyRequest,
    (source, request, binding) => source.rekeyReconnect(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.controlSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferControlRequest,
    (source, request, binding) => source.controlDestination(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.abortSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferAbortRequest,
    (source, request, binding) => source.abort(request, binding)
  ),
  sourceMethod(
    PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.acknowledgeOutputSource,
    RuntimeOwnedPtyMutation,
    parsePtyOwnershipTransferOutputAcknowledgementRequest,
    (source, request, binding) => source.acknowledgeDestinationOutput(request, binding)
  ),
  defineStreamingMethod({
    name: PTY_OWNERSHIP_TRANSFER_RUNTIME_METHODS.streamSource,
    params: RuntimeOwnedPtyStream,
    handler: async (params, context, emit) => {
      requirePairedRuntimeClient(context)
      const request = parsePtyOwnershipTransferSourceStreamRequest(params)
      const source = getSource(context)
      const capabilities = source.getCapabilities()
      if (
        !capabilities.liveTransfer ||
        capabilities.destinationOutput !== true ||
        capabilities.authoritativeExit !== true
      ) {
        throw new Error('pty_ownership_transfer_runtime_source_unavailable')
      }
      const binding = createBinding(context)
      source.assertStreamAuthorized(request, binding)
      const current = source.snapshot(request.bridgeId)
      if (!current || !samePtyOwnershipTransferIdentity(current.identity, request)) {
        throw new Error('pty_ownership_transfer_runtime_source_unavailable')
      }
      const requestedOutputCredit = request.outputCredit
      const canNegotiateOutputCredit =
        requestedOutputCredit !== undefined &&
        typeof source.onDestinationOutputAcknowledgement === 'function'
      const negotiatedOutputCredit = canNegotiateOutputCredit ? requestedOutputCredit : undefined
      const outputCredit = canNegotiateOutputCredit
        ? new PtyOwnershipTransferOutputCreditWindow(
            negotiatedOutputCredit!.windowBytes,
            negotiatedOutputCredit!.windowFrames
          )
        : undefined
      const pendingOutput: PtyOwnershipTransferOutputFrame[] = []
      let pendingOutputBytes = 0
      let streamBroken = false
      const emitLoss = (code: string): void => {
        if (streamBroken) {
          return
        }
        streamBroken = true
        emit({ kind: 'loss', code })
      }
      const flushPendingOutput = (): void => {
        if (!outputCredit || streamBroken) {
          return
        }
        while (pendingOutput.length > 0) {
          const frame = pendingOutput[0]!
          let admission: ReturnType<PtyOwnershipTransferOutputCreditWindow['admit']>
          try {
            admission = outputCredit.admit(frame)
          } catch (error) {
            emitLoss(error instanceof Error ? error.message : 'pty_ownership_transfer_output_loss')
            return
          }
          if (admission === 'capacity') {
            return
          }
          pendingOutput.shift()
          pendingOutputBytes -= Buffer.byteLength(frame.data, 'utf8')
          if (admission === 'accepted') {
            emitOutput(frame)
          }
        }
      }
      const emitOutput = (frame: PtyOwnershipTransferOutputFrame): void => {
        if (!streamBroken) {
          emit({
            kind: 'output',
            identity: current.identity,
            attachmentId: request.attachmentId,
            frame
          })
        }
      }
      const acceptCreditOutput = (frame: PtyOwnershipTransferOutputFrame): void => {
        if (!outputCredit || streamBroken) {
          return
        }
        const frameBytes = Buffer.byteLength(frame.data, 'utf8')
        let classification: ReturnType<PtyOwnershipTransferOutputCreditWindow['classify']>
        try {
          classification = outputCredit.classify(frame)
        } catch (error) {
          emitLoss(error instanceof Error ? error.message : 'pty_ownership_transfer_output_loss')
          return
        }
        if (classification === 'conflict') {
          emitLoss('pty_ownership_transfer_output_credit_frame_conflict')
          return
        }
        if (classification === 'duplicate') {
          return
        }
        const queued = pendingOutput.find((candidate) => candidate.seq === frame.seq)
        if (queued) {
          if (queued.data !== frame.data || queued.truncated !== frame.truncated) {
            emitLoss('pty_ownership_transfer_output_credit_frame_conflict')
          }
          return
        }
        if (pendingOutput.length > 0) {
          const tail = pendingOutput.at(-1)!
          if (frame.seq !== tail.seq + 1) {
            emitLoss('pty_ownership_transfer_output_credit_sequence_gap')
            return
          }
          if (
            pendingOutputBytes + frameBytes > outputCredit.windowBytes ||
            pendingOutput.length >= outputCredit.windowFrames
          ) {
            emitLoss('pty_ownership_transfer_output_credit_queue_overflow')
            return
          }
          pendingOutput.push(frame)
          pendingOutputBytes += frameBytes
          return
        }
        let admission: ReturnType<PtyOwnershipTransferOutputCreditWindow['admit']>
        try {
          admission = outputCredit.admit(frame)
        } catch (error) {
          emitLoss(error instanceof Error ? error.message : 'pty_ownership_transfer_output_loss')
          return
        }
        if (admission === 'accepted') {
          emitOutput(frame)
        } else if (admission === 'capacity') {
          if (frameBytes > outputCredit.windowBytes) {
            emitLoss('pty_ownership_transfer_output_credit_frame_too_large')
            return
          }
          pendingOutput.push(frame)
          pendingOutputBytes = frameBytes
        }
      }
      const disposeAcknowledgement = canNegotiateOutputCredit
        ? source.onDestinationOutputAcknowledgement(
            request,
            request.attachmentId,
            binding,
            (throughSeq) => {
              if (!outputCredit || streamBroken) {
                return
              }
              try {
                outputCredit.acknowledge(throughSeq)
                flushPendingOutput()
              } catch (error) {
                emitLoss(
                  error instanceof Error ? error.message : 'pty_ownership_transfer_output_loss'
                )
              }
            }
          )
        : undefined
      const disposeOutput = source.onDestinationOutput((event) => {
        if (
          !streamBroken &&
          event.attachmentId === request.attachmentId &&
          sameIdentity(event.identity, request)
        ) {
          if (outputCredit) {
            acceptCreditOutput(event.frame)
          } else {
            emit({
              kind: 'output',
              identity: event.identity,
              attachmentId: event.attachmentId,
              frame: event.frame
            })
          }
        }
      })
      const disposeExit = source.onDestinationExit((event) => {
        if (event.attachmentId === request.attachmentId && sameIdentity(event, request)) {
          emit({ kind: 'exit', event })
        }
      })
      // The paired caller must not attach or commit until this listener is installed. This
      // readiness frame closes the otherwise unobservable attach/stream race.
      emit({
        kind: 'ready',
        identity: current.identity,
        attachmentId: request.attachmentId,
        ...(outputCredit ? { outputCredit: requestedOutputCredit } : {})
      })
      try {
        await waitForStreamEnd(context.signal)
      } finally {
        disposeOutput()
        disposeExit()
        disposeAcknowledgement?.()
      }
    }
  })
]

function sourceMethod<T>(
  name: string,
  params: z.ZodType,
  parse: (value: unknown) => T,
  invoke: (
    source: RuntimePtyOwnershipTransferSourceAdapter,
    request: T,
    binding: Parameters<RuntimePtyOwnershipTransferSourceAdapter['prepare']>[1]
  ) => unknown
): RpcMethod {
  return defineMethod({
    name,
    params,
    handler: (value, context) => {
      requirePairedRuntimeClient(context)
      return invoke(getSource(context), parse(value), createBinding(context))
    }
  })
}

function getSource(context: RpcContext): RuntimePtyOwnershipTransferSourceAdapter {
  const source = context.runtime.getLocalPtyOwnershipTransferSource?.()
  if (!source) {
    throw new Error('pty_ownership_transfer_runtime_source_unavailable')
  }
  return source
}

function createBinding(
  context: RpcContext
): Parameters<RuntimePtyOwnershipTransferSourceAdapter['prepare']>[1] {
  const token = context.connectionId ?? context.pairedDeviceId ?? context.clientId ?? 'runtime'
  return {
    clientId: stableClientId(token),
    ...(context.transportGeneration === undefined
      ? {}
      : { transportGeneration: context.transportGeneration }),
    ...(context.pairedDeviceId === undefined ? {} : { pairedDeviceId: context.pairedDeviceId }),
    isStale: () => context.signal?.aborted === true
  }
}

function stableClientId(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0 || 1
}

function sameIdentity(
  left: {
    bridgeId: string
    terminalId: string
    incarnationId: string
    ownerLease: string
    sourceOwnerGeneration: number
    destinationRuntimeId: string
  },
  right: {
    bridgeId: string
    terminalId: string
    incarnationId: string
    ownerLease: string
    sourceOwnerGeneration: number
    destinationRuntimeId: string
  }
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

function waitForStreamEnd(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve()
  }
  if (!signal) {
    return Promise.reject(new Error('pty_ownership_transfer_stream_signal_required'))
  }
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function requirePairedRuntimeClient(context: RpcContext): void {
  if (context.clientKind !== 'runtime' || !context.pairedDeviceId || !context.connectionId) {
    throw new Error('pty_ownership_transfer_runtime_client_required')
  }
}

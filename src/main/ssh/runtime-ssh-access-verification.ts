import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { verifyRemotePairingRuntimeStatus } from '../../shared/remote-pairing-verification'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import type { PairingOffer } from '../../shared/pairing'
import type { RuntimeStatus } from '../../shared/runtime-types'

export async function verifyRuntimeEnvironmentSshTunnel(
  environment: KnownRuntimeEnvironment,
  localPort: number,
  signal?: AbortSignal
): Promise<{
  verifiedPairing: PairingOffer
  verifiedRuntimeId: string
  runtimeStatus: RuntimeStatus
}> {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new Error('The SSH tunnel did not provide a valid local port.')
  }
  // The tunnel targets the native listener, not the public reverse proxy; E2EE still pins its key.
  const verifiedPairing = {
    ...getPreferredPairingOffer(environment),
    endpoint: `ws://127.0.0.1:${localPort}`
  }
  const response = await sendRemoteRuntimeRequest<RuntimeStatus>(
    verifiedPairing,
    'status.get',
    undefined,
    15_000,
    undefined,
    signal,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  if (!response.ok) {
    throw new Error(`SSH access verification failed: ${response.error.message}`)
  }
  const status = verifyRemotePairingRuntimeStatus(response.result)
  if (!status.ok) {
    throw new Error(status.message)
  }
  const runtimeId = status.runtimeStatus.runtimeId
  if (
    response._meta.runtimeId !== runtimeId ||
    (environment.runtimeId !== null && runtimeId !== environment.runtimeId) ||
    (environment.pairedDeviceId !== undefined &&
      status.runtimeStatus.pairedDeviceId !== undefined &&
      status.runtimeStatus.pairedDeviceId !== environment.pairedDeviceId)
  ) {
    throw new Error('The SSH endpoint does not match this paired runtime identity.')
  }
  return { verifiedPairing, verifiedRuntimeId: runtimeId, runtimeStatus: status.runtimeStatus }
}

import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import { OrcadDecommissionResultSchema } from '../../shared/orcad-decommission'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import {
  getPreferredPairingOffer,
  type KnownRuntimeEnvironment
} from '../../shared/runtime-environments'

export async function requestRemoteOrcadDecommission(
  environment: KnownRuntimeEnvironment,
  expectedVersion: string,
  transactionId?: string,
  timeoutMs = 15_000
) {
  try {
    const response = await sendRemoteRuntimeRequest<unknown>(
      getPreferredPairingOffer(environment),
      'orcad.decommissionIfIdle',
      { version: expectedVersion, ...(transactionId ? { transactionId } : {}) },
      timeoutMs,
      undefined,
      undefined,
      ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
    )
    if (!response.ok) {
      return unverifiableResult(response.error.message)
    }
    return OrcadDecommissionResultSchema.parse(response.result)
  } catch (error) {
    return unverifiableResult(error instanceof Error ? error.message : String(error))
  }
}

function unverifiableResult(detail: string) {
  return {
    outcome: 'refused' as const,
    verdict: 'unverifiable' as const,
    code: 'orcad_decommission_unverifiable',
    reason: `The host could not atomically fence terminal creation and prove the daemon idle. ${detail}`
  }
}

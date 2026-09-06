import type { OrcadDecommissionResult } from '../../shared/orcad-decommission'
import { persistOrcadDecommissionAcceptance } from './orcad-decommission-acceptance'

type OrcadDecommissionAdapter = () => Promise<OrcadDecommissionResult>

let adapter: OrcadDecommissionAdapter | null = null

export function configureOrcadDecommission(next: OrcadDecommissionAdapter | null): void {
  adapter = next
}

export async function requestOrcadDecommission(
  expectedVersion: string,
  runningVersion: string,
  transactionId?: string
): Promise<OrcadDecommissionResult> {
  if (!adapter) {
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_unavailable',
      reason: 'This runtime does not expose the managed orcad decommission contract.'
    }
  }
  if (expectedVersion !== runningVersion) {
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_version_mismatch',
      reason:
        `The managed activation record names orcad ${expectedVersion}, but the contacted ` +
        `runtime is ${runningVersion}. Refresh the server status before stopping it.`
    }
  }
  const result = await adapter()
  if (result.outcome === 'refused' || !transactionId) {
    return result
  }
  try {
    persistOrcadDecommissionAcceptance(transactionId, expectedVersion)
    return { outcome: 'accepted', transactionId }
  } catch (error) {
    return {
      outcome: 'refused',
      verdict: 'unverifiable',
      code: 'orcad_decommission_receipt_unverifiable',
      reason:
        `Terminal admission is fenced, but the durable managed-stop receipt could not be ` +
        `written: ${error instanceof Error ? error.message : String(error)}`
    }
  }
}

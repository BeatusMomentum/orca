import {
  parseOrcadMigrationCatalogAbortResult,
  parseOrcadMigrationCatalogState
} from '../../shared/orcad-migration-catalog-state'
import type {
  OrcadMigrationCatalogAbortResult,
  OrcadMigrationCatalogState,
  OrcadMigrationManifest
} from '../../shared/orcad-migration-manifest'
import {
  parseOrcadMigrationSnapshotChunkResult,
  type OrcadMigrationSnapshotChunkRequest,
  type OrcadMigrationSnapshotChunkResult
} from '../../shared/orcad-migration-scrollback'
import { parsePairingCode } from '../../shared/pairing'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'

type OrcadCatalogMigrationOperation = 'abort' | 'commit' | 'stage' | 'state'

const METHOD_BY_OPERATION: Record<OrcadCatalogMigrationOperation, string> = {
  abort: 'orcad.migration.abortCatalog',
  commit: 'orcad.migration.commitCatalog',
  stage: 'orcad.migration.stageCatalog',
  state: 'orcad.migration.catalogState'
}

export function stageRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<OrcadMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'stage', manifest, options)
}

export function commitRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<OrcadMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'commit', manifest, options)
}

export function readRemoteOrcadMigrationCatalogState(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<OrcadMigrationCatalogState> {
  return requestCatalogState(pairingCode, 'state', manifest, options)
}

export async function abortRemoteOrcadMigrationCatalog(
  pairingCode: string,
  manifest: OrcadMigrationManifest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<OrcadMigrationCatalogAbortResult> {
  const result = await request(pairingCode, 'abort', manifest, options)
  return parseOrcadMigrationCatalogAbortResult(result, manifest)
}

export async function stageRemoteOrcadMigrationSnapshotChunk(
  pairingCode: string,
  request: OrcadMigrationSnapshotChunkRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<OrcadMigrationSnapshotChunkResult> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendRemoteRuntimeRequest<unknown>(
    pairing,
    'orcad.migration.stageSnapshotChunk',
    request,
    options.timeoutMs ?? 15_000,
    undefined,
    options.signal,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_snapshot_failed:${response.error.message}`)
  }
  return parseOrcadMigrationSnapshotChunkResult(response.result, request)
}

async function requestCatalogState(
  pairingCode: string,
  operation: Exclude<OrcadCatalogMigrationOperation, 'abort'>,
  manifest: OrcadMigrationManifest,
  options: { signal?: AbortSignal; timeoutMs?: number }
): Promise<OrcadMigrationCatalogState> {
  const result = await request(pairingCode, operation, manifest, options)
  return parseOrcadMigrationCatalogState(result, manifest)
}

async function request(
  pairingCode: string,
  operation: OrcadCatalogMigrationOperation,
  manifest: OrcadMigrationManifest,
  options: { signal?: AbortSignal; timeoutMs?: number }
): Promise<unknown> {
  const pairing = parsePairingCode(pairingCode)
  if (!pairing) {
    throw new Error('orcad_migration_pairing_code_invalid')
  }
  const response = await sendRemoteRuntimeRequest<unknown>(
    pairing,
    METHOD_BY_OPERATION[operation],
    { manifest },
    options.timeoutMs ?? 15_000,
    undefined,
    options.signal,
    ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
  )
  if (!response.ok) {
    throw new Error(`orcad_migration_${operation}_failed:${response.error.message}`)
  }
  return response.result
}

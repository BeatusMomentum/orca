import {
  compactOrcadMigrationSourceCutoversForAdmission,
  MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS,
  ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
  parseOrcadMigrationSourceCutover,
  type OrcadMigrationSourceCutover
} from '../../../shared/orcad-migration-source-cutover'
import type { OrcadMigrationManifest } from '../../../shared/orcad-migration-manifest'
import { assertOrcadMigrationManifestDigest } from '../../orcad/orcad-migration-manifest-digest'
import { createManagedOrcadSshOwner } from '../../../shared/managed-orcad-ssh-owner'
import { scheduleSave } from '../loading-store/write-scheduling'
import type { OrcadMigrationSourceReleaseEvidence } from './orcad-source-cutover'
import type { OrcadSourceCutoverContext } from './orcad-source-cutover-context'
import {
  assertDestinationStateIdentity,
  assertSameCutover,
  assertSourceCatalogRetired,
  assertSourceCatalogUnchanged,
  assertSourceDependenciesAbsent,
  assertSourceDependenciesRetired,
  assertSourceTargetIdentity,
  findCutover,
  requireCutover,
  requireSourceFence
} from './orcad-source-cutover-validation'

export function beginOrcadMigrationSourceCutover(
  context: OrcadSourceCutoverContext,
  manifest: OrcadMigrationManifest,
  destinationEnvironmentId: string,
  options: { destinationName?: string; now?: () => Date }
): OrcadMigrationSourceCutover {
  assertOrcadMigrationManifestDigest(manifest)
  if (!destinationEnvironmentId) {
    throw new Error('orcad_migration_source_cutover_environment_invalid')
  }
  const existing = findCutover(context.runtime.state, manifest.migrationId)
  if (existing) {
    assertSameCutover(existing, manifest, destinationEnvironmentId, options.destinationName)
    requireSourceFence(context.runtime.state, existing)
    if (existing.phase === 'source-retired') {
      assertSourceCatalogRetired(context.runtime.state, manifest)
      assertSourceDependenciesRetired(context.runtime, manifest)
      return structuredClone(existing)
    }
    assertSourceCatalogUnchanged(context.projects, manifest)
    assertSourceDependenciesAbsent(context.runtime, manifest)
    return structuredClone(existing)
  }
  const existingCutovers = context.runtime.state.orcadMigrationSourceCutovers ?? []
  if (
    existingCutovers.some(
      (entry) => entry.manifest.source.sshTargetId === manifest.source.sshTargetId
    )
  ) {
    throw new Error('orcad_migration_source_target_already_fenced')
  }
  const cutovers = compactOrcadMigrationSourceCutoversForAdmission(existingCutovers)
  if (cutovers.length >= MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS) {
    throw new Error('orcad_migration_source_cutover_capacity_exceeded')
  }
  const target = context.runtime.state.sshTargets.find(
    (entry) => entry.id === manifest.source.sshTargetId
  )
  if (!target) {
    throw new Error('orcad_migration_source_target_not_found')
  }
  assertSourceTargetIdentity(target, manifest)
  if (target.owner) {
    throw new Error('orcad_migration_source_target_owned')
  }
  if (
    context.runtime.state.sshRemotePtyLeases.some(
      (lease) =>
        lease.targetId === target.id && lease.state !== 'terminated' && lease.state !== 'expired'
    )
  ) {
    throw new Error('orcad_migration_source_terminal_lease_unresolved')
  }
  assertSourceCatalogUnchanged(context.projects, manifest)
  assertSourceDependenciesAbsent(context.runtime, manifest)
  const timestamp = (options.now ?? (() => new Date()))().toISOString()
  const cutover = parseOrcadMigrationSourceCutover({
    version: ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION,
    phase: 'source-fenced',
    destinationEnvironmentId,
    ...(options.destinationName ? { destinationName: options.destinationName } : {}),
    manifest: structuredClone(manifest),
    startedAt: timestamp,
    updatedAt: timestamp
  })
  target.owner = createManagedOrcadSshOwner(destinationEnvironmentId)
  context.runtime.state.orcadMigrationSourceCutovers = [...cutovers, cutover]
  scheduleSave(context.scheduling)
  return structuredClone(cutover)
}

export function releaseOrcadMigrationSourceCutover(
  context: OrcadSourceCutoverContext,
  migrationId: string,
  evidence: OrcadMigrationSourceReleaseEvidence
): void {
  const cutover = requireCutover(context.runtime.state, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    throw new Error('orcad_migration_committed_source_cannot_be_released')
  }
  if (evidence.kind === 'catalog-absent') {
    assertDestinationStateIdentity(cutover, evidence.state)
  } else if (cutover.phase !== 'source-fenced') {
    throw new Error('orcad_migration_stage_method_evidence_too_late')
  }
  const target = requireSourceFence(context.runtime.state, cutover)
  delete target.owner
  context.runtime.state.orcadMigrationSourceCutovers = (
    context.runtime.state.orcadMigrationSourceCutovers ?? []
  ).filter((entry) => entry.manifest.migrationId !== migrationId)
  scheduleSave(context.scheduling)
}

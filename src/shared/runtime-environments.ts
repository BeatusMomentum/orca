import { z } from 'zod'
import { PAIRING_OFFER_VERSION, type PairingOffer } from './pairing'
import { classifyRemotePairingHostname } from './remote-pairing-address'

export const RuntimeAccessEndpointSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('websocket'),
  label: z.string().min(1),
  endpoint: z.string().min(1),
  deviceToken: z.string().min(1),
  publicKeyB64: z.string().min(1)
})

export const PublicRuntimeAccessEndpointSchema = RuntimeAccessEndpointSchema.omit({
  deviceToken: true,
  publicKeyB64: true
})

export type PublicRuntimeAccessEndpoint = z.infer<typeof PublicRuntimeAccessEndpointSchema>

export const RuntimeEnvironmentSourceSchema = z.enum(['manual', 'ephemeral-vm'])
export type RuntimeEnvironmentSource = z.infer<typeof RuntimeEnvironmentSourceSchema>

export const OrcadDeploymentLinkSchema = z.object({
  sshTargetId: z.string().min(1),
  sshTargetGeneration: z.number().int().positive(),
  localPort: z.number().int().min(1).max(65_535),
  remotePort: z.number().int().min(1).max(65_535)
})

export type OrcadDeploymentLink = z.infer<typeof OrcadDeploymentLinkSchema>

export const KnownRuntimeEnvironmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  pairingRevision: z.number().finite().optional(),
  pairedDeviceId: z.string().min(1).optional(),
  lastUsedAt: z.number().finite().nullable(),
  runtimeId: z.string().min(1).nullable(),
  source: RuntimeEnvironmentSourceSchema.optional(),
  connectionDependency: z.literal('ssh-tunnel').optional(),
  orcadDeployment: OrcadDeploymentLinkSchema.optional(),
  endpoints: z.array(RuntimeAccessEndpointSchema).min(1),
  preferredEndpointId: z.string().min(1)
})

export type KnownRuntimeEnvironment = z.infer<typeof KnownRuntimeEnvironmentSchema>

export type PublicKnownRuntimeEnvironment = Omit<KnownRuntimeEnvironment, 'endpoints'> & {
  endpoints: PublicRuntimeAccessEndpoint[]
}

export function redactRuntimeEnvironment(
  environment: KnownRuntimeEnvironment
): PublicKnownRuntimeEnvironment {
  return {
    ...environment,
    endpoints: environment.endpoints.map(
      ({ deviceToken: _deviceToken, publicKeyB64: _key, ...rest }) => rest
    )
  }
}

export const RuntimeEnvironmentStoreSchema = z.object({
  version: z.literal(1),
  environments: z.array(KnownRuntimeEnvironmentSchema)
})

export type RuntimeEnvironmentStore = z.infer<typeof RuntimeEnvironmentStoreSchema>

export function createEnvironmentFromPairingOffer(args: {
  id: string
  name: string
  now: number
  offer: PairingOffer
  runtimeId?: string | null
  source?: RuntimeEnvironmentSource
  connectionDependency?: 'ssh-tunnel'
  orcadDeployment?: OrcadDeploymentLink
}): KnownRuntimeEnvironment {
  const endpointId = `ws-${args.id}`
  return KnownRuntimeEnvironmentSchema.parse({
    id: args.id,
    name: args.name,
    createdAt: args.now,
    updatedAt: args.now,
    pairingRevision: args.now,
    ...(args.offer.pairedDeviceId ? { pairedDeviceId: args.offer.pairedDeviceId } : {}),
    lastUsedAt: null,
    runtimeId: args.runtimeId ?? null,
    ...(args.source ? { source: args.source } : {}),
    ...(args.connectionDependency ? { connectionDependency: args.connectionDependency } : {}),
    ...(args.orcadDeployment ? { orcadDeployment: args.orcadDeployment } : {}),
    endpoints: [
      {
        id: endpointId,
        kind: 'websocket',
        label: 'WebSocket',
        endpoint: args.offer.endpoint,
        deviceToken: args.offer.deviceToken,
        publicKeyB64: args.offer.publicKeyB64
      }
    ],
    preferredEndpointId: endpointId
  })
}

export function isEphemeralVmRuntimeEnvironment(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source'>
): boolean {
  return environment.source === 'ephemeral-vm'
}

export function isManagedOrcadRuntimeEnvironment(
  environment: Pick<PublicKnownRuntimeEnvironment, 'orcadDeployment'>
): boolean {
  return environment.orcadDeployment !== undefined
}

export function isUserManagedRuntimeEnvironment(
  environment: Pick<PublicKnownRuntimeEnvironment, 'source'>
): boolean {
  return !isEphemeralVmRuntimeEnvironment(environment)
}

export function getPreferredPairingOffer(environment: KnownRuntimeEnvironment): PairingOffer {
  const endpoint =
    environment.endpoints.find((entry) => entry.id === environment.preferredEndpointId) ??
    environment.endpoints[0]
  if (!endpoint) {
    throw new Error(`Environment ${environment.name} has no access endpoints`)
  }
  return {
    v: PAIRING_OFFER_VERSION,
    endpoint: endpoint.endpoint,
    deviceToken: endpoint.deviceToken,
    publicKeyB64: endpoint.publicKeyB64,
    ...(environment.pairedDeviceId ? { pairedDeviceId: environment.pairedDeviceId } : {})
  }
}

export function getPreferredLoopbackRuntimePort(
  environment: KnownRuntimeEnvironment
): number | null {
  const endpoint = environment.endpoints.find(
    (entry) => entry.id === environment.preferredEndpointId
  )
  if (!endpoint) {
    return null
  }
  try {
    const url = new URL(endpoint.endpoint)
    const port = Number(url.port)
    return classifyRemotePairingHostname(url.hostname) === 'loopback' &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65_535
      ? port
      : null
  } catch {
    return null
  }
}

import { defineMethod, type RpcMethod } from '../core'
import { getRemoteServerUpdaterSnapshot } from '../../remote-server-updater'
import { collectOrcadTerminalCensus } from '../../../orcad/orcad-terminal-census'
import { requestOrcadDecommission } from '../../../orcad/orcad-decommission'
import { getAppEnvironment } from '../../../../shared/app-environment'
import { OrcadDecommissionParamsSchema } from '../../../../shared/orcad-decommission'
import { z } from 'zod'
import { collectCachedOrcadHealth } from '../../../orcad/orcad-health'

export const STATUS_METHODS: RpcMethod[] = [
  defineMethod({
    name: 'status.get',
    params: null,
    handler: (_params, { runtime, pairedDeviceId }) => {
      const snapshot = getRemoteServerUpdaterSnapshot(runtime.getRuntimeId())
      return {
        ...runtime.getStatus(),
        ...(pairedDeviceId ? { pairedDeviceId } : {}),
        appVersion: snapshot.appVersion,
        remoteUpdateSupport: snapshot.support
      }
    }
  }),
  defineMethod({
    name: 'orcad.health',
    params: null,
    handler: () => collectCachedOrcadHealth(getAppEnvironment().getVersion())
  }),
  defineMethod({
    name: 'orcad.terminalCensus',
    params: z.object({ activatedAt: z.number().finite().nonnegative() }),
    handler: (params) => collectOrcadTerminalCensus(params.activatedAt)
  }),
  defineMethod({
    name: 'orcad.decommissionIfIdle',
    params: OrcadDecommissionParamsSchema,
    handler: (params) =>
      requestOrcadDecommission(
        params.version,
        getAppEnvironment().getVersion(),
        params.transactionId
      )
  })
]

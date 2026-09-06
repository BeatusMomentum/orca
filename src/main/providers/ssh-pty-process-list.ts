import type { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import type { PtyProcessInfo } from './types'
import { toAppSshPtyId, toRelaySshPtyId } from './ssh-pty-id'
import { mapSshPtyProcessList } from './ssh-agent-session-process-list'
import type { SshPtyProviderOutputState } from './ssh-pty-provider-output-state'

export async function listSshPtyProcesses(
  args: Readonly<{
    mux: SshChannelMultiplexer
    connectionId: string
    livePtyIds: Set<string>
    outputState: SshPtyProviderOutputState
    deadlineMs?: number
  }>
): Promise<PtyProcessInfo[]> {
  const result = await args.mux.request(
    'pty.listProcesses',
    undefined,
    args.deadlineMs === undefined
      ? undefined
      : { timeoutMs: Math.max(1, args.deadlineMs - Date.now()) }
  )
  const processes = mapSshPtyProcessList(result as PtyProcessInfo[], (id) =>
    toAppSshPtyId(args.connectionId, id)
  )
  for (const process of processes) {
    args.livePtyIds.add(process.id)
    args.outputState.rememberPtyIncarnation(
      toRelaySshPtyId(args.connectionId, process.id),
      process.incarnationId
    )
  }
  return processes
}

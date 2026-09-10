import type { AgentSessionRecord } from '../../../shared/agent-session-record'

export type StructuredAgentSessionTab = {
  sessionId: string
  workspaceId: string
  agent: AgentSessionRecord['provider']
  /** The session's own name, absent until a producer sets one. */
  title?: string
}

export function listStructuredAgentSessionTabs(
  sessions: ReadonlyMap<
    string,
    { params: { location: { workspaceId: string }; provider: AgentSessionRecord['provider'] } }
  >,
  findRecord: (sessionId: string) => AgentSessionRecord | null = () => null
): StructuredAgentSessionTab[] {
  return [...sessions.entries()].map(([sessionId, session]) => {
    const title = findRecord(sessionId)?.conversationName
    return {
      sessionId,
      workspaceId: session.params.location.workspaceId,
      agent: session.params.provider,
      ...(title === undefined ? {} : { title })
    }
  })
}

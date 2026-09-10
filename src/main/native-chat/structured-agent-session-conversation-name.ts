// The one call that names a conversation.
//
// Normalize once, store the name on the record — the single place it lives — then rename the
// published tab, because `publishStructuredAgentSessionTab` early-returns on a tab that already
// exists and a name almost always arrives after the tab. Kept apart from any provider so naming
// code never writes the record field itself.

import { normalizeAgentSessionConversationName } from '../../shared/agent-session-conversation-name'
import type { AgentSessionRecordStore } from '../runtime/agent-session-record-store'

type StructuredAgentSessionTabRenamer = {
  renameStructuredAgentSessionTab(
    workspaceId: string,
    sessionId: string,
    name: string | null
  ): Promise<void>
}

export async function setStructuredAgentSessionConversationName(
  deps: {
    store: Pick<AgentSessionRecordStore, 'setConversationName'>
    tabs: StructuredAgentSessionTabRenamer
  },
  sessionId: string,
  name: string | null
): Promise<void> {
  const normalized = name === null ? null : normalizeAgentSessionConversationName(name)
  const record = await deps.store.setConversationName(sessionId, normalized)
  // Read the stored value back rather than reusing `normalized`, so the tab cannot disagree with
  // the record about what the name is. The workspace comes from the record for the same reason.
  await deps.tabs.renameStructuredAgentSessionTab(
    record.location.workspaceId,
    sessionId,
    record.conversationName ?? null
  )
}

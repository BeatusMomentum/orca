import { describe, expect, it } from 'vitest'
import { getDefaultPersistedState, getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
  type PersistedClientHostedBrowserPage
} from '../../../shared/client-hosted-browser-page-record'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { prepareOrcadMigrationWorkspaceSession } from './orcad-destination-workspace-session'

const OWNER = 'repo-1::/srv/worktree'

function page(browserPageId: string): PersistedClientHostedBrowserPage {
  return {
    v: CLIENT_HOSTED_BROWSER_PAGE_RECORD_VERSION,
    browserPageId,
    workspaceId: 'browser-workspace-1',
    browserProfileId: 'profile-1',
    url: 'https://example.test/',
    title: 'Example',
    pairedDeviceId: 'device-1',
    savedAt: 1
  }
}

function state(): PersistedState {
  return getDefaultPersistedState('/tmp/orca-test')
}

function incoming(pages: ReturnType<typeof page>[]): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    clientHostedBrowserPagesByWorktree: { [OWNER]: pages }
  }
}

describe('destination workspace-session merge validation', () => {
  it('accepts a unique client-hosted page identity', () => {
    expect(() =>
      prepareOrcadMigrationWorkspaceSession(incoming([page('page-1')]), state())
    ).not.toThrow()
  })

  it('rejects duplicate client-hosted page identities before merge', () => {
    expect(() =>
      prepareOrcadMigrationWorkspaceSession(incoming([page('page-1'), page('page-1')]), state())
    ).toThrow('orcad_migration_dormant_id_conflict:workspace_session:client-browser-page:page-1')
  })
})

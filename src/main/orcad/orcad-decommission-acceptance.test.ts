import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  emptyOrcadActivationRecord,
  parseOrcadActivationRecord,
  serializeOrcadActivationRecord,
  withDeactivatedVersion,
  withDecommissioningVersion
} from '../ssh/orcad-activation-record'
import {
  ORCAD_ACTIVATION_TRANSACTION_DIRNAME,
  ORCAD_ACTIVATION_TRANSACTION_FILENAME,
  createOrcadDecommissionTransaction,
  serializeOrcadActivationTransaction
} from '../ssh/orcad-activation-transaction'
import { persistOrcadDecommissionAcceptance } from './orcad-decommission-acceptance'

const VERSION = '0.2.0+new'
const TRANSACTION_ID = 'b407cda3-44bd-44d8-b75a-8268c18035b1'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'orcad-decommission-'))
  roots.push(home)
  const controlRoot = join(home, '.orca-remote')
  const transactionRoot = join(controlRoot, ORCAD_ACTIVATION_TRANSACTION_DIRNAME)
  mkdirSync(transactionRoot, { recursive: true })
  const recordBefore = {
    ...emptyOrcadActivationRecord(),
    active: VERSION,
    activatedAt: new Date(1).toISOString()
  }
  const acceptedRecord = withDecommissioningVersion(recordBefore, new Date(2))
  const transaction = createOrcadDecommissionTransaction({
    transactionId: TRANSACTION_ID,
    activeVersion: VERSION,
    recordBefore,
    acceptedRecord,
    recordAfter: withDeactivatedVersion(acceptedRecord),
    now: new Date(2)
  })
  const activationPath = join(controlRoot, 'orcad-active.json')
  writeFileSync(activationPath, serializeOrcadActivationRecord(recordBefore), { mode: 0o600 })
  writeFileSync(
    join(transactionRoot, ORCAD_ACTIVATION_TRANSACTION_FILENAME),
    serializeOrcadActivationTransaction(transaction),
    { mode: 0o600 }
  )
  return { home, activationPath, acceptedRecord }
}

describe('host-owned orcad decommission acceptance', () => {
  it('durably publishes the exact accepted record before acknowledging the RPC', () => {
    const { home, activationPath, acceptedRecord } = fixture()

    persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home)
    persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home)

    expect(parseOrcadActivationRecord(readFileSync(activationPath, 'utf8'))).toEqual({
      state: 'ok',
      record: acceptedRecord
    })
  })

  it('refuses a receipt for a different transaction', () => {
    const { home, activationPath } = fixture()
    const before = readFileSync(activationPath, 'utf8')

    expect(() =>
      persistOrcadDecommissionAcceptance('9b677c21-e307-4e2e-a60a-9d4f807019b1', VERSION, home)
    ).toThrow('does not match')
    expect(readFileSync(activationPath, 'utf8')).toBe(before)
  })

  it('refuses to overwrite a third activation record', () => {
    const { home, activationPath } = fixture()
    const changed = {
      ...emptyOrcadActivationRecord(),
      active: '0.3.0+other',
      activatedAt: new Date(3).toISOString()
    }
    writeFileSync(activationPath, serializeOrcadActivationRecord(changed))

    expect(() => persistOrcadDecommissionAcceptance(TRANSACTION_ID, VERSION, home)).toThrow(
      'changed during decommission'
    )
    expect(parseOrcadActivationRecord(readFileSync(activationPath, 'utf8'))).toEqual({
      state: 'ok',
      record: changed
    })
  })
})

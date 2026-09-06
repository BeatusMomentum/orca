import { randomUUID } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  ORCAD_ACTIVATION_FILENAME,
  parseOrcadActivationRecord,
  serializeOrcadActivationRecord
} from '../ssh/orcad-activation-record'
import {
  ORCAD_ACTIVATION_TRANSACTION_DIRNAME,
  ORCAD_ACTIVATION_TRANSACTION_FILENAME,
  parseOrcadActivationTransaction,
  sameOrcadActivationRecord
} from '../ssh/orcad-activation-transaction'
import { RELAY_REMOTE_DIR } from '../ssh/relay-protocol'

const MAX_RECORD_BYTES = 64 * 1024

export function persistOrcadDecommissionAcceptance(
  transactionId: string,
  expectedVersion: string,
  home = homedir()
): void {
  const controlRoot = join(home, RELAY_REMOTE_DIR)
  const transactionPath = join(
    controlRoot,
    ORCAD_ACTIVATION_TRANSACTION_DIRNAME,
    ORCAD_ACTIVATION_TRANSACTION_FILENAME
  )
  const parsedTransaction = parseOrcadActivationTransaction(readBoundedFile(transactionPath))
  if (parsedTransaction.state !== 'ok') {
    throw new Error(
      `Cannot verify the managed stop transaction: ${
        parsedTransaction.state === 'absent' ? 'transaction is absent' : parsedTransaction.reason
      }`
    )
  }
  const transaction = parsedTransaction.transaction
  if (
    transaction.operation !== 'decommission' ||
    transaction.transactionId !== transactionId ||
    transaction.activeVersion !== expectedVersion
  ) {
    throw new Error('The managed stop transaction does not match this decommission request.')
  }
  if (
    transaction.recordBefore.active !== expectedVersion ||
    transaction.acceptedRecord.active !== expectedVersion ||
    transaction.acceptedRecord.decommissioning?.version !== expectedVersion
  ) {
    throw new Error('The managed stop transaction does not preserve the active runtime identity.')
  }

  const activationPath = join(controlRoot, ORCAD_ACTIVATION_FILENAME)
  const parsedRecord = parseOrcadActivationRecord(readBoundedFile(activationPath))
  if (parsedRecord.state !== 'ok') {
    throw new Error(
      `Cannot verify the managed activation record: ${
        parsedRecord.state === 'absent' ? 'record is absent' : parsedRecord.reason
      }`
    )
  }
  if (sameOrcadActivationRecord(parsedRecord.record, transaction.acceptedRecord)) {
    return
  }
  if (!sameOrcadActivationRecord(parsedRecord.record, transaction.recordBefore)) {
    throw new Error('The managed activation record changed during decommission acceptance.')
  }
  writeDurableRecord(activationPath, serializeOrcadActivationRecord(transaction.acceptedRecord))
}

function readBoundedFile(path: string): string {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.size > MAX_RECORD_BYTES) {
    throw new Error(`${path} is not a bounded regular file.`)
  }
  return readFileSync(path, 'utf8')
}

function writeDurableRecord(path: string, contents: string): void {
  const partialPath = `${path}.${process.pid}.${randomUUID()}.partial`
  try {
    writeFileSync(partialPath, contents, { encoding: 'utf8', mode: 0o600 })
    fsyncFile(partialPath)
    renameSync(partialPath, path)
    if (process.platform !== 'win32') {
      try {
        fsyncFile(dirname(path))
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EOPNOTSUPP') {
          throw error
        }
      }
    }
  } finally {
    rmSync(partialPath, { force: true })
  }
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, process.platform === 'win32' ? 'r+' : 'r')
  try {
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
}

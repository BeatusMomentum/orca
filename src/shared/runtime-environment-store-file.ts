import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { writeSecureJsonFileWithinLimit } from './bounded-secure-json-file'
import { readNodeFileSyncWithinLimit } from './node-bounded-file-reader'
import { JsonStringifyByteLimitError } from './node-bounded-json-stringify'
import {
  KnownRuntimeEnvironmentSchema,
  RuntimeEnvironmentStoreSchema,
  type RuntimeEnvironmentStore
} from './runtime-environments'
import { hardenExistingSecureFile } from './secure-file'

const ENVIRONMENTS_FILE = 'orca-environments.json'
export const MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES = 1024 * 1024

export type RuntimeEnvironmentStoreErrorCode = 'invalid_argument' | 'runtime_error'

export class RuntimeEnvironmentStoreError extends Error {
  readonly code: RuntimeEnvironmentStoreErrorCode

  constructor(code: RuntimeEnvironmentStoreErrorCode, message: string) {
    super(message)
    this.name = 'RuntimeEnvironmentStoreError'
    this.code = code
  }
}

export function getEnvironmentStorePath(userDataPath: string): string {
  return join(userDataPath, ENVIRONMENTS_FILE)
}

export function readEnvironmentStore(userDataPath: string): RuntimeEnvironmentStore {
  const path = getEnvironmentStorePath(userDataPath)
  if (!existsSync(path)) {
    return { version: 1, environments: [] }
  }
  try {
    hardenExistingSecureFile(path)
    const parsed = RuntimeEnvironmentStoreSchema.parse(
      JSON.parse(
        readNodeFileSyncWithinLimit(path, MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES).buffer.toString(
          'utf8'
        )
      )
    )
    return {
      version: 1,
      environments: parsed.environments
        .map((entry) => KnownRuntimeEnvironmentSchema.parse(entry))
        .sort((a, b) => a.name.localeCompare(b.name))
    }
  } catch {
    throw new RuntimeEnvironmentStoreError(
      'runtime_error',
      `Could not read Orca environments at ${path}; the file is invalid.`
    )
  }
}

export function writeEnvironmentStore(userDataPath: string, store: RuntimeEnvironmentStore): void {
  const path = getEnvironmentStorePath(userDataPath)
  try {
    writeSecureJsonFileWithinLimit(
      path,
      RuntimeEnvironmentStoreSchema.parse(store),
      MAX_RUNTIME_ENVIRONMENT_STORE_FILE_BYTES
    )
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      throw new RuntimeEnvironmentStoreError(
        'runtime_error',
        `Could not write Orca environments at ${path}; the store exceeds its durable capacity.`
      )
    }
    throw error
  }
}

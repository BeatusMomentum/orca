import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ORCAD_BUILD_TARGET_FILENAME,
  ORCAD_BUN_RUNTIME_FILENAME,
  ORCAD_TEMPLATE_MANIFEST_FILENAME,
  ORCAD_TEMPLATE_TARGETS_DIR,
  orcadArtifactFilenames
} from '../../src/shared/orcad-artifacts.ts'
import { ORCAD_BUN_TARGETS } from '../../src/shared/orcad-bun-runtime.ts'

const require = createRequire(import.meta.url)
const { verifyPackagedOrcadTemplate } = require('./verify-packaged-orcad-template.cjs')
const roots = []

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
  return digest(contents)
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-packaged-orcad-template-'))
  roots.push(root)
  const templateDir = join(root, 'orcad-template')
  const commonFilenames = orcadArtifactFilenames().filter(
    (filename) =>
      filename !== ORCAD_BUN_RUNTIME_FILENAME &&
      filename !== ORCAD_BUILD_TARGET_FILENAME &&
      !filename.endsWith('watcher.node')
  )
  const commonSha256 = {}
  for (const filename of commonFilenames) {
    const contents = Buffer.from(`common:${filename}`)
    commonSha256[filename] = await write(join(templateDir, ...filename.split('/')), contents)
  }
  const targets = {}
  for (const target of ORCAD_BUN_TARGETS) {
    const targetDir = join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, target)
    const targetIdentity = Buffer.from(`${target}\n`)
    const watcher = Buffer.from(`watcher:${target}`)
    targets[target] = {
      targetSha256: await write(join(targetDir, ORCAD_BUILD_TARGET_FILENAME), targetIdentity),
      watcherSha256: await write(join(targetDir, 'watcher.node'), watcher)
    }
  }
  const browserName = 'agent-browser-linux-x64'
  const browser = Buffer.from('browser')
  targets['linux-x64-glibc'] = {
    ...targets['linux-x64-glibc'],
    browserName,
    browserSha256: await write(
      join(templateDir, ORCAD_TEMPLATE_TARGETS_DIR, 'linux-x64-glibc', browserName),
      browser
    )
  }
  await writeFile(
    join(templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME),
    JSON.stringify({ schemaVersion: 2, commonSha256, targets })
  )
  return { root, templateDir }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('verifyPackagedOrcadTemplate', () => {
  it('accepts the exact eight-target packaged template', async () => {
    const fixture = await createFixture()

    expect(() => verifyPackagedOrcadTemplate(fixture.root)).not.toThrow()
  })

  it('rejects target-native bytes changed after manifest generation', async () => {
    const fixture = await createFixture()
    await writeFile(
      join(
        fixture.templateDir,
        ORCAD_TEMPLATE_TARGETS_DIR,
        'linux-x64-glibc',
        'watcher.node'
      ),
      'mutated'
    )

    expect(() => verifyPackagedOrcadTemplate(fixture.root)).toThrow(
      'linux-x64-glibc watcher checksum mismatch'
    )
  })

  it('rejects a missing target before the package reaches deployment', async () => {
    const fixture = await createFixture()
    const manifestPath = join(fixture.templateDir, ORCAD_TEMPLATE_MANIFEST_FILENAME)
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    delete manifest.targets['win32-arm64']
    await writeFile(manifestPath, JSON.stringify(manifest))

    expect(() => verifyPackagedOrcadTemplate(fixture.root)).toThrow(
      'target manifest inventory mismatch'
    )
  })

  it('keeps the verifier connected to every packaged platform', async () => {
    const configSource = await readFile(
      join(process.cwd(), 'config', 'electron-builder.config.cjs'),
      'utf8'
    )
    const config = require('../electron-builder.config.cjs')

    expect(configSource).toContain("require('./scripts/verify-packaged-orcad-template.cjs')")
    expect(configSource).toContain('verifyPackagedOrcadTemplate(resourcesDir)')
    for (const platform of ['win', 'mac', 'linux']) {
      expect(config[platform].extraResources).toEqual(
        expect.arrayContaining([expect.objectContaining({ to: 'orcad-template' })])
      )
    }
  })
})

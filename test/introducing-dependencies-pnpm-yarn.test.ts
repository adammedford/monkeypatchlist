// Introducing dependencies from pnpm and Yarn lockfiles (§10 Introducing dependencies; §2 Inputs).
// `pnpm-lock.yaml` (6.0, 9.x) and `yarn.lock` (Berry, v1) give the same introducers as the npm lockfile of the same
// project. Yarn records no direct dependencies, so the `package.json` manifests beside the lockfile give them, and its
// facts are capped at `medium`. Nothing here re-keys a finding.

import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'
import { identityMappings, mappings } from './support/source-map.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** A build of `index.html` running each script in `list`, `[name, code, source]`, with a sidecar map for each. */
function scripts(list: [string, string, string][]): Record<string, string> {
  const files: Record<string, string> = {
    'index.html': list.map(([name]) => `<script src="${name}"></script>`).join(''),
  }
  for (const [name, code, source] of list) {
    files[name] = code
    files[`${name}.map`] = JSON.stringify({
      version: 3,
      sources: [source],
      sourcesContent: [code],
      names: [],
      mappings: mappings(identityMappings(code)),
    })
  }
  return files
}

/** A build whose `main.js` is `code`, mapped to `source`. */
const mapped = (code: string, source: string) => scripts([['main.js', code, source]])

/** Writes `files` and the lockfile `name` into a fresh working directory, and returns the lockfile's path. */
function lockfileAt(name: string, text: string, files: Record<string, string> = {}): string {
  return join(workingDir({ ...files, [name]: text }), name)
}

const finding = (report: Json, target: string) => {
  const found = report.findings.filter((each: Json) => each.target.name === target)
  expect(found).toHaveLength(1)
  return found[0]
}

/**
 * The project of the npm fixture (test/introducing-dependencies.test.ts): `portal` depends on @acme/telemetry, which depends on otel-fetch; `debug` is
 * a dev dependency, and engine.io-client depends on its own `debug` 3.2.7.
 */
const portalManifest = JSON.stringify({
  name: 'portal',
  version: '1.0.0',
  dependencies: { '@acme/telemetry': '^8.0.0', 'engine.io-client': '^6.0.0' },
  devDependencies: { debug: '^4.3.4' },
})

const pnpm9 = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      '@acme/telemetry':
        specifier: ^8.0.0
        version: 8.0.0
      engine.io-client:
        specifier: ^6.0.0
        version: 6.5.0
    devDependencies:
      debug:
        specifier: ^4.3.4
        version: 4.3.4

packages:

  '@acme/telemetry@8.0.0':
    resolution: {integrity: sha512-a}

  debug@3.2.7:
    resolution: {integrity: sha512-e}

  debug@4.3.4:
    resolution: {integrity: sha512-c}

  engine.io-client@6.5.0:
    resolution: {integrity: sha512-d}

  otel-fetch@0.57.0:
    resolution: {integrity: sha512-b}

snapshots:

  '@acme/telemetry@8.0.0':
    dependencies:
      otel-fetch: 0.57.0

  debug@3.2.7: {}

  debug@4.3.4: {}

  engine.io-client@6.5.0:
    dependencies:
      debug: 3.2.7

  otel-fetch@0.57.0: {}
`

/** The 6.0 lockfile of the same project, with a project-only layout: its importer's lists at the top. */
const pnpm6 = `lockfileVersion: '6.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

dependencies:
  '@acme/telemetry':
    specifier: ^8.0.0
    version: 8.0.0
  engine.io-client:
    specifier: ^6.0.0
    version: 6.5.0

devDependencies:
  debug:
    specifier: ^4.3.4
    version: 4.3.4

packages:

  /@acme/telemetry@8.0.0:
    resolution: {integrity: sha512-a}
    dependencies:
      otel-fetch: 0.57.0
    dev: false

  /debug@3.2.7:
    resolution: {integrity: sha512-e}
    dev: false

  /debug@4.3.4:
    resolution: {integrity: sha512-c}
    dev: true

  /engine.io-client@6.5.0:
    resolution: {integrity: sha512-d}
    dependencies:
      debug: 3.2.7
    dev: false

  /otel-fetch@0.57.0:
    resolution: {integrity: sha512-b}
    dev: false
`

/** The introducers of a scan of `source` with the lockfile `name`. */
async function introducedBy(name: string, text: string, source: string, files: Record<string, string> = {}): Promise<Json> {
  const { report } = await scanBuild(mapped('window.fetch = w', source), ['--lockfile', lockfileAt(name, text, files)])
  return { report, fetch: finding(report, 'Window.fetch') }
}

describe('pnpm-lock.yaml (§10 Introducing dependencies)', () => {
  test.each([
    ['9.0', pnpm9],
    ['6.0', pnpm6],
  ])('%s: the walk gives what npm gives, in the store and hoisted', async (_, text) => {
    const cases: [string, string[]][] = [
      ['node_modules/.pnpm/otel-fetch@0.57.0/node_modules/otel-fetch/index.js', ['@acme/telemetry@8.0.0']],
      ['webpack://app/./node_modules/otel-fetch/index.js', ['@acme/telemetry@8.0.0']],
      ['webpack://app/./node_modules/debug/index.js', ['debug@4.3.4']],
      ['node_modules/.pnpm/debug@3.2.7/node_modules/debug/index.js', ['engine.io-client@6.5.0']],
      ['webpack://app/./node_modules/engine.io-client/node_modules/debug/index.js', ['engine.io-client@6.5.0']],
    ]
    for (const [source, expected] of cases) {
      const { report, fetch } = await introducedBy('pnpm-lock.yaml', text, source)
      expect(fetch.introducedBy, source).toEqual(expected)
      expect(report.completeness.attribution.introducers.confidence).toBe('high')
    }
  })

  test('a lockfile keyed by name and version gives no lockfile version (§10 Version)', async () => {
    const { report, fetch } = await introducedBy('pnpm-lock.yaml', pnpm9, 'webpack://app/./node_modules/otel-fetch/index.js')

    expect(fetch.occurrences[0].evidence.version).toBeUndefined()
    expect(report.packages).toEqual({})
  })

  test('two installed versions leave a hoisted copy unplaced, neither introduced nor vendored', async () => {
    const { fetch } = await introducedBy('pnpm-lock.yaml', pnpm9, 'webpack://app/./node_modules/@acme/telemetry/node_modules/debug/index.js')

    expect(fetch.introducedBy).toBeUndefined()
    expect(fetch.attribution.vendoredBy).toBeUndefined()
  })

  test('a package the lockfile does not install is vendored in the package around it', async () => {
    const { fetch } = await introducedBy('pnpm-lock.yaml', pnpm9, 'webpack://app/./node_modules/@acme/telemetry/node_modules/tiny-helper/x.js')

    expect(fetch.attribution.vendoredBy).toBe('@acme/telemetry@8.0.0')
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['vendored'] })
    expect(fetch.introducedBy).toEqual(['@acme/telemetry@8.0.0'])
  })

  test.each([
    ['5.4', "lockfileVersion: 5.4\n\nspecifiers:\n  otel-fetch: ^0.57.0\n", 'pnpm-lock.yaml lockfileVersion 5.4'],
    ['7.0', "lockfileVersion: '7.0'\n", 'pnpm-lock.yaml lockfileVersion 7.0'],
    ['no version', 'importers: {}\n', 'pnpm-lock.yaml lockfileVersion null'],
  ])('lockfileVersion %s is no usable lockfile', async (_, text, evidence) => {
    const { report, fetch } = await introducedBy('pnpm-lock.yaml', text, 'node_modules/.pnpm/otel-fetch@0.57.0/node_modules/otel-fetch/index.js')

    expect(fetch.introducedBy).toBeUndefined()
    expect(report.completeness.attribution.introducers).toEqual({ reason: 'no-lockfile', evidence })
    expect(report.completeness.level).toBe('complete')
  })

  test("a store version the lockfile doesn't install makes it stale", async () => {
    const { report } = await introducedBy('pnpm-lock.yaml', pnpm9, 'node_modules/.pnpm/otel-fetch@0.58.0/node_modules/otel-fetch/index.js')

    expect(report.completeness.attribution.introducers).toEqual({
      reason: 'lockfile-stale',
      evidence: "a store path gives otel-fetch@0.58.0, which the lockfile doesn't install",
    })
  })

  test('9.0: a transitive dependency in the store is introduced as npm finds it', async () => {
    const lockfile = lockfileAt('pnpm-lock.yaml', pnpm9)
    const { report } = await scanBuild(
      mapped('window.fetch = w', 'node_modules/.pnpm/otel-fetch@0.57.0/node_modules/otel-fetch/index.js'),
      ['--lockfile', lockfile],
    )

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|pkg:otel-fetch')
    expect(fetch.introducedBy).toEqual(['@acme/telemetry@8.0.0'])
    expect(fetch.occurrences[0].introducedBy).toEqual(['@acme/telemetry@8.0.0'])
    expect(report.completeness.attribution.introducers).toEqual({ reason: null, evidence: null, confidence: 'high' })
  })
})

/** The monorepo of the npm workspace fixture (test/introducing-dependencies.test.ts): apps/portal depends on @acme/telemetry and libs/telemetry. */
const monorepoManifests = {
  'package.json': JSON.stringify({ name: 'monorepo', private: true, workspaces: ['apps/*', 'libs/*'] }),
  'apps/portal/package.json': JSON.stringify({
    name: 'portal',
    version: '2.0.0',
    dependencies: { '@acme/telemetry': '^8.0.0', telemetry: '*' },
  }),
  'libs/telemetry/package.json': JSON.stringify({
    name: 'telemetry',
    version: '0.1.0',
    dependencies: { 'otel-fetch': '^0.57.0' },
    devDependencies: { debug: '^4.3.4' },
  }),
}

const pnpmWorkspace = `lockfileVersion: '9.0'

importers:

  .: {}

  apps/portal:
    dependencies:
      '@acme/telemetry':
        specifier: ^8.0.0
        version: 8.0.0
      telemetry:
        specifier: workspace:*
        version: link:../../libs/telemetry

  libs/telemetry:
    dependencies:
      otel-fetch:
        specifier: ^0.57.0
        version: 0.57.0
    devDependencies:
      debug:
        specifier: ^4.3.4
        version: 4.3.4

packages:

  '@acme/telemetry@8.0.0':
    resolution: {integrity: sha512-a}

  debug@4.3.4:
    resolution: {integrity: sha512-c}

  otel-fetch@0.57.0:
    resolution: {integrity: sha512-b}

snapshots:

  '@acme/telemetry@8.0.0': {}

  debug@4.3.4: {}

  otel-fetch@0.57.0: {}
`

/** A monorepo build: first-party code in apps/portal, and `source` bundled beside it. */
const monorepoBuild = (source: string) =>
  scripts([
    ['a.js', 'window.fetch = w', 'webpack://app/./apps/portal/src/main.ts'],
    ['b.js', 'window.setTimeout = w', source],
  ])

describe('workspaces (§10 Importer)', () => {
  test('pnpm: a linked workspace introduces what it depends on, named by its manifest, but not its dev dependencies', async () => {
    const lockfile = lockfileAt('pnpm-lock.yaml', pnpmWorkspace, monorepoManifests)
    const { report } = await scanBuild(monorepoBuild('node_modules/.pnpm/otel-fetch@0.57.0/node_modules/otel-fetch/index.js'), [
      '--lockfile',
      lockfile,
    ])
    expect(finding(report, 'Window.setTimeout').introducedBy).toEqual(['telemetry@0.1.0'])

    const dev = await scanBuild(monorepoBuild('node_modules/.pnpm/debug@4.3.4/node_modules/debug/index.js'), ['--lockfile', lockfile])
    expect(finding(dev.report, 'Window.setTimeout').introducedBy).toEqual([])
    expect(finding(dev.report, 'Window.fetch').attribution.workspace).toBeUndefined()
  })
})

/** The Yarn v1 lockfile of the same project: it records no direct dependencies and no dev/prod split. */
const yarnV1 = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


"@acme/telemetry@^8.0.0":
  version "8.0.0"
  resolved "https://registry.yarnpkg.com/@acme/telemetry/-/telemetry-8.0.0.tgz#a"
  integrity sha512-a
  dependencies:
    otel-fetch "^0.57.0"

debug@^4.3.4:
  version "4.3.4"
  resolved "https://registry.yarnpkg.com/debug/-/debug-4.3.4.tgz#c"
  integrity sha512-c

debug@~3.2.7:
  version "3.2.7"
  resolved "https://registry.yarnpkg.com/debug/-/debug-3.2.7.tgz#e"
  integrity sha512-e

engine.io-client@^6.0.0:
  version "6.5.0"
  resolved "https://registry.yarnpkg.com/engine.io-client/-/engine.io-client-6.5.0.tgz#d"
  integrity sha512-d
  dependencies:
    debug "~3.2.7"

otel-fetch@^0.57.0, otel-fetch@^0.57.0-rc.1:
  version "0.57.0"
  resolved "https://registry.yarnpkg.com/otel-fetch/-/otel-fetch-0.57.0.tgz#b"
  integrity sha512-b
`

/** The Yarn Berry lockfile of the same project: its root workspace entry merges the dev dependencies in. */
const yarnBerry = (metadata: string) => `# This file is generated by running "yarn install" inside your project.
# Manual changes might be lost - proceed with caution!

__metadata:
  version: ${metadata}
  cacheKey: 10c0

"@acme/telemetry@npm:^8.0.0":
  version: 8.0.0
  resolution: "@acme/telemetry@npm:8.0.0"
  dependencies:
    otel-fetch: "npm:^0.57.0"
  checksum: 10c0/a
  languageName: node
  linkType: hard

"debug@npm:^4.3.4":
  version: 4.3.4
  resolution: "debug@npm:4.3.4"
  checksum: 10c0/c
  languageName: node
  linkType: hard

"debug@npm:~3.2.7":
  version: 3.2.7
  resolution: "debug@npm:3.2.7"
  checksum: 10c0/e
  languageName: node
  linkType: hard

"engine.io-client@npm:^6.0.0":
  version: 6.5.0
  resolution: "engine.io-client@npm:6.5.0"
  dependencies:
    debug: "npm:~3.2.7"
  checksum: 10c0/d
  languageName: node
  linkType: hard

"otel-fetch@npm:^0.57.0":
  version: 0.57.0
  resolution: "otel-fetch@npm:0.57.0"
  checksum: 10c0/b
  languageName: node
  linkType: hard

"portal@workspace:.":
  version: 0.0.0-use.local
  resolution: "portal@workspace:."
  dependencies:
    "@acme/telemetry": "npm:^8.0.0"
    debug: "npm:^4.3.4"
    engine.io-client: "npm:^6.0.0"
  languageName: unknown
  linkType: soft
`

describe('yarn.lock (§10 Introducing dependencies)', () => {
  const formats: [string, string, string][] = [
    ['v1', yarnV1, 'webpack://app/./node_modules'],
    ['Berry 8', yarnBerry('8'), 'webpack://app/./node_modules'],
    ['Berry 4, in its cache', yarnBerry('4'), '.yarn/cache'],
  ]

  test.each(formats)('%s: the walk gives what npm gives, capped at medium', async (_, text, at) => {
    const cases: [string, string[]][] =
      at === '.yarn/cache'
        ? [
            ['.yarn/cache/otel-fetch-npm-0.57.0-0123456789-abcdef.zip/node_modules/otel-fetch/index.js', ['@acme/telemetry@8.0.0']],
            ['.yarn/cache/debug-npm-3.2.7-0123456789-abcdef.zip/node_modules/debug/index.js', ['engine.io-client@6.5.0']],
            ['.yarn/cache/debug-npm-4.3.4-0123456789-abcdef.zip/node_modules/debug/index.js', ['debug@4.3.4']],
          ]
        : [
            [`${at}/otel-fetch/index.js`, ['@acme/telemetry@8.0.0']],
            [`${at}/debug/index.js`, ['debug@4.3.4']],
            [`${at}/engine.io-client/node_modules/debug/index.js`, ['engine.io-client@6.5.0']],
          ]
    for (const [source, expected] of cases) {
      const { report, fetch } = await introducedBy('yarn.lock', text, source, { 'package.json': portalManifest })
      expect(fetch.introducedBy, source).toEqual(expected)
      expect(report.completeness.attribution.introducers).toEqual({ reason: null, evidence: null, confidence: 'medium' })
      expect(fetch.occurrences[0].evidence.version?.versionSource).not.toBe('lockfile')
    }
  })

  test.each(formats)('%s: without the manifest beside it, `importer-unresolved`', async (_, text, at) => {
    const source = at === '.yarn/cache' ? '.yarn/cache/otel-fetch-npm-0.57.0-0123456789-abcdef.zip/node_modules/otel-fetch/index.js' : `${at}/otel-fetch/index.js`
    const { report, fetch } = await introducedBy('yarn.lock', text, source)

    expect(fetch.introducedBy).toBeUndefined()
    expect(report.completeness.attribution.introducers.reason).toBe('importer-unresolved')
    expect(report.completeness.attribution.introducers.evidence).toContain('package.json')
  })

  test('an unreadable manifest is `importer-unresolved` too', async () => {
    const { report } = await introducedBy('yarn.lock', yarnV1, 'webpack://app/./node_modules/otel-fetch/index.js', {
      'package.json': '{ not json',
    })

    expect(report.completeness.attribution.introducers.reason).toBe('importer-unresolved')
  })

  test('a .lock file that is no Yarn lockfile is no usable lockfile', async () => {
    const { report } = await introducedBy('yarn.lock', 'hello: [\n', 'webpack://app/./node_modules/otel-fetch/index.js')

    expect(report.completeness.attribution.introducers.reason).toBe('no-lockfile')
    expect(report.completeness.attribution.introducers.evidence).toContain('yarn.lock')
  })
})

const yarnV1Workspace = `# yarn lockfile v1


"@acme/telemetry@^8.0.0":
  version "8.0.0"

debug@^4.3.4:
  version "4.3.4"

otel-fetch@^0.57.0:
  version "0.57.0"
`

const yarnBerryWorkspace = `__metadata:
  version: 8
  cacheKey: 10c0

"@acme/telemetry@npm:^8.0.0":
  version: 8.0.0
  resolution: "@acme/telemetry@npm:8.0.0"
  languageName: node
  linkType: hard

"debug@npm:^4.3.4":
  version: 4.3.4
  resolution: "debug@npm:4.3.4"
  languageName: node
  linkType: hard

"monorepo@workspace:.":
  version: 0.0.0-use.local
  resolution: "monorepo@workspace:."
  languageName: unknown
  linkType: soft

"otel-fetch@npm:^0.57.0":
  version: 0.57.0
  resolution: "otel-fetch@npm:0.57.0"
  languageName: node
  linkType: hard

"portal@workspace:apps/portal":
  version: 0.0.0-use.local
  resolution: "portal@workspace:apps/portal"
  dependencies:
    "@acme/telemetry": "npm:^8.0.0"
    telemetry: "workspace:*"
  languageName: unknown
  linkType: soft

"telemetry@workspace:*, telemetry@workspace:libs/telemetry":
  version: 0.0.0-use.local
  resolution: "telemetry@workspace:libs/telemetry"
  dependencies:
    debug: "npm:^4.3.4"
    otel-fetch: "npm:^0.57.0"
  languageName: unknown
  linkType: soft
`

describe('Yarn workspaces (§10 Importer)', () => {
  const berryManifests = {
    ...monorepoManifests,
    'apps/portal/package.json': JSON.stringify({
      name: 'portal',
      version: '2.0.0',
      dependencies: { '@acme/telemetry': '^8.0.0', telemetry: 'workspace:*' },
    }),
  }
  test.each([
    ['v1, through its workspaces globs', yarnV1Workspace, monorepoManifests],
    ['Berry, through its workspace entries', yarnBerryWorkspace, berryManifests],
  ])('%s: a workspace introduces what it depends on, but not its dev dependencies', async (_, text, files) => {
    const lockfile = lockfileAt('yarn.lock', text, files)
    const { report } = await scanBuild(monorepoBuild('webpack://app/./node_modules/otel-fetch/index.js'), ['--lockfile', lockfile])
    expect(finding(report, 'Window.setTimeout').introducedBy).toEqual(['telemetry@0.1.0'])
    expect(report.completeness.attribution.introducers.confidence).toBe('medium')

    const dev = await scanBuild(monorepoBuild('webpack://app/./node_modules/debug/index.js'), ['--lockfile', lockfile])
    expect(finding(dev.report, 'Window.setTimeout').introducedBy).toEqual([])
  })

  test('Berry names the workspace that holds first-party code; v1 does not', async () => {
    const berry = await scanBuild(monorepoBuild('webpack://app/./node_modules/otel-fetch/index.js'), [
      '--lockfile',
      lockfileAt('yarn.lock', yarnBerryWorkspace, berryManifests),
    ])
    expect(finding(berry.report, 'Window.fetch').attribution.workspace).toBe('portal')

    const v1 = await scanBuild(monorepoBuild('webpack://app/./node_modules/otel-fetch/index.js'), [
      '--lockfile',
      lockfileAt('yarn.lock', yarnV1Workspace, monorepoManifests),
    ])
    expect(finding(v1.report, 'Window.fetch').attribution.workspace).toBeUndefined()
  })

  test.each([
    ['pnpm-lock.yaml', pnpmWorkspace, monorepoManifests],
    ['yarn.lock', yarnV1Workspace, monorepoManifests],
    ['yarn.lock', yarnBerryWorkspace, berryManifests],
  ])('%s: a workspace linked into node_modules is installed, not vendored', async (name, text, files) => {
    const lockfile = lockfileAt(name, text, files)
    const { report } = await scanBuild(monorepoBuild('webpack://app/./node_modules/telemetry/index.js'), ['--lockfile', lockfile])
    const linked = finding(report, 'Window.setTimeout')
    expect(linked.introducedBy).toEqual(['telemetry@0.1.0'])
    expect(linked.confidence.attribution.reasons).not.toContain('vendored')
  })

  test("a missing workspace manifest is `importer-unresolved`", async () => {
    const files: Record<string, string> = { ...berryManifests }
    delete files['libs/telemetry/package.json']
    const lockfile = lockfileAt('yarn.lock', yarnBerryWorkspace, files)
    const { report } = await scanBuild(monorepoBuild('webpack://app/./node_modules/otel-fetch/index.js'), ['--lockfile', lockfile])

    expect(report.completeness.attribution.introducers).toEqual({
      reason: 'importer-unresolved',
      evidence: 'the manifest libs/telemetry/package.json beside the lockfile is missing or unreadable',
    })
  })
})

describe('switching package manager (ADR 0006)', () => {
  /** The npm lockfile of the project. */
  const npmLock = JSON.stringify({
    name: 'portal',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'portal',
        version: '1.0.0',
        dependencies: { '@acme/telemetry': '^8.0.0', 'engine.io-client': '^6.0.0' },
        devDependencies: { debug: '^4.3.4' },
      },
      'node_modules/@acme/telemetry': { version: '8.0.0', dependencies: { 'otel-fetch': '^0.57.0' } },
      'node_modules/otel-fetch': { version: '0.57.0' },
      'node_modules/debug': { version: '4.3.4', dev: true },
      'node_modules/engine.io-client': { version: '6.5.0', dependencies: { debug: '~3.2.7' } },
      'node_modules/engine.io-client/node_modules/debug': { version: '3.2.7' },
    },
  })
  const build = () =>
    fixtureBuild(
      scripts([
        ['a.js', 'window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js'],
        ['b.js', 'window.setTimeout = w', 'webpack://app/./node_modules/debug/index.js'],
        ['c.js', 'XMLHttpRequest.prototype.send = w', 'webpack://app/./node_modules/engine.io-client/node_modules/debug/index.js'],
        ['d.js', 'history.pushState = w', 'webpack://app/./src/main.ts'],
      ]),
    )
  const introducers = (report: Json) =>
    Object.fromEntries(report.findings.map((each: Json) => [each.fingerprint, each.introducedBy ?? null]))

  test('pnpm, Yarn Berry and Yarn v1 give the introducers npm gives, and the same fingerprints with none', async () => {
    const dir = build()
    const npm = (await scanBuild(dir, ['--lockfile', lockfileAt('package-lock.json', npmLock)])).report
    const none = (await scanBuild(dir)).report
    expect(introducers(npm)).toEqual({
      'window|Window.fetch|replace|pkg:otel-fetch': ['@acme/telemetry@8.0.0'],
      'window|Window.setTimeout|replace|pkg:debug': ['debug@4.3.4'],
      'window|XMLHttpRequest.prototype.send|replace|pkg:debug': ['engine.io-client@6.5.0'],
      'window|history.pushState|replace|app:src/main.ts': null,
    })
    for (const [name, text] of [
      ['pnpm-lock.yaml', pnpm9],
      ['pnpm-lock.yaml', pnpm6],
      ['yarn.lock', yarnBerry('8')],
      ['yarn.lock', yarnV1],
    ] as const) {
      const { report } = await scanBuild(dir, ['--lockfile', lockfileAt(name, text, { 'package.json': portalManifest })])
      expect(introducers(report), `${name}: ${text.slice(0, 40)}`).toEqual(introducers(npm))
      expect(report.findings.map((each: Json) => each.fingerprint)).toEqual(none.findings.map((each: Json) => each.fingerprint))
      expect(report.config.scanConfigId).toBe(none.config.scanConfigId)
    }
  })
})

describe('terminal wording (§10 Terminal wording)', () => {
  test("Yarn's introducers read as medium", async () => {
    const run = await runCli([
      'scan',
      fixtureBuild(mapped('window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js')),
      '--map',
      defaultMap,
      '--surface',
      'all',
      '--lockfile',
      lockfileAt('yarn.lock', yarnV1, { 'package.json': portalManifest }),
    ])

    expect(run.stdout).toContain('    Package          otel-fetch\n    Introduced by    @acme/telemetry@8.0.0 (medium)\n')
    expect(run.stdout).toMatch(/\n {2}Lockfile {5}\S*yarn\.lock · Introduced by medium\n/)
  })
})

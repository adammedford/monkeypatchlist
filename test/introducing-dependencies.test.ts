// Introducing dependencies from npm and Bun lockfiles (§10 Introducing dependencies, Version, Terminal
// wording; ADR 0006). An explicit `--lockfile` finds, for each bundled-dependency occurrence, the direct dependencies of
// the scanned application whose installed tree includes the containing package. Introducers, lockfile versions and
// workspaces are evidence only: they never re-key a finding.

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

/** Writes `files` into a fresh working directory, and returns the path of the one named `lockfile` in it. */
function lockfileAt(name: string, content: unknown, files: Record<string, string> = {}): string {
  const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  return join(workingDir({ ...files, [name]: text }), name)
}

const finding = (report: Json, target: string) => {
  const found = report.findings.filter((each: Json) => each.target.name === target)
  expect(found).toHaveLength(1)
  return found[0]
}

/**
 * An npm project: `portal` depends on @acme/telemetry, which depends on otel-fetch; `debug` is a dev dependency, and
 * engine.io-client nests its own copy of `debug`.
 */
const npmLock = {
  name: 'portal',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
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
}

describe('npm package-lock.json (§10 Introducing dependencies)', () => {
  test('a transitive dependency is introduced by the direct dependency whose tree includes it', async () => {
    const lockfile = lockfileAt('package-lock.json', npmLock)
    const { report } = await scanBuild(mapped('window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js'), [
      '--lockfile',
      lockfile,
    ])

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|pkg:otel-fetch')
    expect(fetch.introducedBy).toEqual(['@acme/telemetry@8.0.0'])
    expect(fetch.occurrences[0].introducedBy).toEqual(['@acme/telemetry@8.0.0'])
    expect(fetch.occurrences[0].evidence.version).toEqual({ version: '0.57.0', versionSource: 'lockfile' })
    expect(report.packages).toEqual({ 'otel-fetch': { version: '0.57.0', versionSource: 'lockfile' } })
    expect(report.completeness.attribution.introducers).toEqual({ reason: null, evidence: null, confidence: 'high' })
  })
})

/** The Bun lockfile of the same project, hoisted, with comments and trailing commas as Bun writes them. */
const bunLock = `{
  "lockfileVersion": 1,
  "workspaces": {
    "": {
      "name": "portal",
      "dependencies": {
        "@acme/telemetry": "^8.0.0",
        "engine.io-client": "^6.0.0",
      },
      "devDependencies": {
        "debug": "^4.3.4",
      },
    },
  },
  "packages": {
    "@acme/telemetry": ["@acme/telemetry@8.0.0", "", { "dependencies": { "otel-fetch": "^0.57.0" } }, "sha512-a"],
    "otel-fetch": ["otel-fetch@0.57.0", "", {}, "sha512-b"],
    "debug": ["debug@4.3.4", "", {}, "sha512-c"],
    "engine.io-client": ["engine.io-client@6.5.0", "", { "dependencies": { "debug": "~3.2.7" } }, "sha512-d"],
    "engine.io-client/debug": ["debug@3.2.7", "", {}, "sha512-e"],
  }
}
`

describe('bun.lock (§10 Introducing dependencies)', () => {
  test('a transitive dependency is introduced as npm finds it', async () => {
    const lockfile = lockfileAt('bun.lock', bunLock)
    const { report } = await scanBuild(mapped('window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js'), [
      '--lockfile',
      lockfile,
    ])

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.introducedBy).toEqual(['@acme/telemetry@8.0.0'])
    expect(fetch.occurrences[0].evidence.version).toEqual({ version: '0.57.0', versionSource: 'lockfile' })
    expect(report.completeness.attribution.introducers).toEqual({ reason: null, evidence: null, confidence: 'high' })
  })

  test("Bun's isolated store matches by name and version", async () => {
    const lockfile = lockfileAt('bun.lock', bunLock)
    const { report } = await scanBuild(
      mapped('window.fetch = w', 'node_modules/.bun/otel-fetch@0.57.0/node_modules/otel-fetch/index.js'),
      ['--lockfile', lockfile],
    )

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.introducedBy).toEqual(['@acme/telemetry@8.0.0'])
    expect(fetch.occurrences[0].evidence.version).toEqual({ version: '0.57.0', versionSource: 'store-path' })
  })

  test('a nested copy is matched by its hoisted key', async () => {
    const lockfile = lockfileAt('bun.lock', bunLock)
    const { report } = await scanBuild(
      mapped('window.fetch = w', 'webpack://app/./node_modules/engine.io-client/node_modules/debug/index.js'),
      ['--lockfile', lockfile],
    )

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.introducedBy).toEqual(['engine.io-client@6.5.0'])
    expect(fetch.occurrences[0].evidence.version).toEqual({ version: '3.2.7', versionSource: 'lockfile' })
  })
})

describe('the walk (§10 Walk)', () => {
  test("a dev dependency of the importer is followed, and a direct dependency introduces itself", async () => {
    const lockfile = lockfileAt('package-lock.json', npmLock)
    const { report } = await scanBuild(mapped('window.fetch = w', 'webpack://app/./node_modules/debug/index.js'), [
      '--lockfile',
      lockfile,
    ])

    expect(finding(report, 'Window.fetch').introducedBy).toEqual(['debug@4.3.4'])
  })

  test('a nested copy is introduced by the package that nests it', async () => {
    const lockfile = lockfileAt('package-lock.json', npmLock)
    const { report } = await scanBuild(
      mapped('window.fetch = w', 'webpack://app/./node_modules/engine.io-client/node_modules/debug/index.js'),
      ['--lockfile', lockfile],
    )

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.introducedBy).toEqual(['engine.io-client@6.5.0'])
    expect(fetch.occurrences[0].evidence.version).toEqual({ version: '3.2.7', versionSource: 'lockfile' })
  })

  test('a package the lockfile says isn\'t installed is vendored, and walked from its vendoring package', async () => {
    const lockfile = lockfileAt('package-lock.json', npmLock)
    const { report } = await scanBuild(
      mapped('window.fetch = w', 'webpack://app/./node_modules/@acme/telemetry/node_modules/tiny-helper/index.js'),
      ['--lockfile', lockfile],
    )

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|pkg:tiny-helper')
    expect(fetch.attribution.vendoredBy).toBe('@acme/telemetry@8.0.0')
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['vendored'] })
    expect(fetch.introducedBy).toEqual(['@acme/telemetry@8.0.0'])
    expect(fetch.occurrences[0].evidence).toEqual({ vendoredBy: '@acme/telemetry@8.0.0' })
    expect(report.packages).toEqual({})
  })

  test('a store-name mismatch walks from the vendoring package', async () => {
    const lockfile = lockfileAt('bun.lock', bunLock)
    const { report } = await scanBuild(
      mapped('window.fetch = w', 'node_modules/.bun/engine.io-client@6.5.0/node_modules/engine.io-client/node_modules/tiny-helper/x.js'),
      ['--lockfile', lockfile],
    )

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.vendoredBy).toBe('engine.io-client@6.5.0')
    expect(fetch.introducedBy).toEqual(['engine.io-client@6.5.0'])
  })

  test('introducers apply only to bundled-dependency code', async () => {
    const lockfile = lockfileAt('package-lock.json', npmLock)
    const { report } = await scanBuild(mapped('window.fetch = w', 'webpack://app/./src/main.ts'), ['--lockfile', lockfile])

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: 'app:src/main.ts', provenance: 'first-party', workspace: 'portal@1.0.0' })
    expect(fetch.introducedBy).toBeUndefined()
    expect(fetch.occurrences[0].introducedBy).toBeUndefined()
  })
})

describe('workspaces (§10 Importer)', () => {
  const workspaceLock = {
    name: 'monorepo',
    lockfileVersion: 3,
    packages: {
      '': { name: 'monorepo', workspaces: ['apps/*', 'libs/*'] },
      'apps/portal': { name: 'portal', version: '2.0.0', dependencies: { '@acme/telemetry': '^8.0.0', telemetry: '*' } },
      'libs/telemetry': { name: 'telemetry', version: '0.1.0', dependencies: { 'otel-fetch': '^0.57.0' } },
      'node_modules/portal': { resolved: 'apps/portal', link: true },
      'node_modules/telemetry': { resolved: 'libs/telemetry', link: true },
      'node_modules/@acme/telemetry': { version: '8.0.0' },
      'apps/portal/node_modules/otel-fetch': { version: '0.56.1' },
      'node_modules/otel-fetch': { version: '0.57.0' },
    },
  }

  test('the first-party source paths pick the importer, and a workspace introduces what it depends on', async () => {
    const lockfile = lockfileAt('package-lock.json', workspaceLock)
    const { report } = await scanBuild(
      scripts([
        ['a.js', 'window.fetch = w', 'webpack://app/./apps/portal/src/main.ts'],
        ['b.js', 'window.setTimeout = w', 'webpack://app/./node_modules/otel-fetch/index.js'],
      ]),
      ['--lockfile', lockfile],
    )

    expect(finding(report, 'Window.fetch').attribution.workspace).toBe('portal@2.0.0')
    expect(finding(report, 'Window.setTimeout').introducedBy).toEqual(['telemetry@0.1.0'])
    expect(report.completeness.attribution.introducers.reason).toBeNull()
  })

  test('lockfile.importer overrides the first-party source paths', async () => {
    const lockfile = lockfileAt('package-lock.json', workspaceLock)
    const cwd = workingDir({
      'monkeypatchlist.config.json': JSON.stringify({ lockfile: { path: lockfile, importer: 'libs/telemetry' } }),
    })
    const { report } = await scanBuild(
      scripts([
        ['a.js', 'window.fetch = w', 'webpack://app/./apps/portal/src/main.ts'],
        ['b.js', 'window.setTimeout = w', 'webpack://app/./node_modules/otel-fetch/index.js'],
      ]),
      [],
      { cwd },
    )

    expect(report.config.lockfile).toEqual({ path: lockfile, importer: 'libs/telemetry' })
    expect(finding(report, 'Window.setTimeout').introducedBy).toEqual(['otel-fetch@0.57.0'])
  })
})

describe('unknown introducers (§10 Unknown is not empty)', () => {
  const otel = () => mapped('window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js')

  test('no lockfile: `no-lockfile`, and no lockfile version', async () => {
    const { report } = await scanBuild(otel())

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.introducedBy).toBeUndefined()
    expect(fetch.occurrences[0].evidence).toEqual({})
    expect(report.config.lockfile).toBeNull()
    expect(report.completeness.attribution.introducers).toEqual({ reason: 'no-lockfile', evidence: null })
    expect(report.completeness.level).toBe('complete')
  })

  test.each([
    ['a missing file', join(workingDir(), 'package-lock.json'), "package-lock.json can't be read"],
    ['package-lock.json v1', lockfileAt('package-lock.json', { lockfileVersion: 1, dependencies: {} }), 'package-lock.json lockfileVersion 1'],
    ['a bun.lockb-era version', lockfileAt('bun.lock', '{ "lockfileVersion": 7, "workspaces": {}, "packages": {} }'), 'bun.lock lockfileVersion 7'],
  ])('an unusable lockfile, %s: `no-lockfile` with evidence', async (_, lockfile, evidence) => {
    const { report } = await scanBuild(otel(), ['--lockfile', lockfile])

    expect(finding(report, 'Window.fetch').introducedBy).toBeUndefined()
    expect(report.completeness.attribution.introducers.reason).toBe('no-lockfile')
    expect(report.completeness.attribution.introducers.evidence).toContain(evidence)
    expect(report.completeness.level).toBe('complete')
  })

  test('an importer no workspace is: `importer-unresolved`, and versions still come from the lockfile', async () => {
    const lockfile = lockfileAt('package-lock.json', npmLock)
    const cwd = workingDir({ 'monkeypatchlist.config.json': JSON.stringify({ lockfile: { path: lockfile, importer: 'apps/nope' } }) })
    const { report } = await scanBuild(otel(), [], { cwd })

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.introducedBy).toBeUndefined()
    expect(fetch.occurrences[0].evidence.version).toEqual({ version: '0.57.0', versionSource: 'lockfile' })
    expect(report.completeness.attribution.introducers.reason).toBe('importer-unresolved')
  })

  test('first-party code in two workspaces: `importer-unresolved`', async () => {
    const lockfile = lockfileAt('package-lock.json', {
      name: 'monorepo',
      lockfileVersion: 3,
      packages: {
        '': { name: 'monorepo' },
        'apps/portal': { name: 'portal', version: '2.0.0' },
        'apps/admin': { name: 'admin', version: '2.0.0' },
      },
    })
    const { report } = await scanBuild(
      scripts([
        ['a.js', 'window.fetch = w', 'webpack://app/./apps/portal/src/main.ts'],
        ['b.js', 'window.setTimeout = w', 'webpack://app/./apps/admin/src/main.ts'],
      ]),
      ['--lockfile', lockfile],
    )

    expect(report.completeness.attribution.introducers.reason).toBe('importer-unresolved')
  })
})

describe('a stale lockfile (§10)', () => {
  /** A Bun build: its map paths hold `.bun/otel-fetch@0.57.0`, and its `bun.lock` records 0.56.1. */
  const staleLock = `{
    "lockfileVersion": 1,
    "workspaces": { "": { "name": "portal", "dependencies": { "@acme/telemetry": "^8.0.0" } } },
    "packages": {
      "@acme/telemetry": ["@acme/telemetry@8.0.0", "", { "dependencies": { "otel-fetch": "^0.56.0" } }, "sha512-a"],
      "otel-fetch": ["otel-fetch@0.56.1", "", {}, "sha512-b"],
      "tiny-helper": ["tiny-helper@1.0.0", "", {}, "sha512-c"],
    },
  }`
  const build = () =>
    scripts([
      ['a.js', 'window.fetch = w', 'node_modules/.bun/otel-fetch@0.57.0/node_modules/otel-fetch/index.js'],
      ['b.js', 'window.setTimeout = w', 'webpack://app/./node_modules/@acme/telemetry/index.js'],
      ['c.js', 'XMLHttpRequest.prototype.send = w', 'webpack://app/./node_modules/@acme/telemetry/node_modules/tiny-helper/x.js'],
    ])

  test('derives nothing: no introducers, no lockfile versions, no lockfile vendoring', async () => {
    const lockfile = lockfileAt('bun.lock', staleLock)
    const { report } = await scanBuild(build(), ['--lockfile', lockfile])

    expect(report.completeness.attribution.introducers.reason).toBe('lockfile-stale')
    expect(report.completeness.attribution.introducers.evidence).toContain('otel-fetch@0.57.0')
    for (const each of report.findings) {
      expect(each.introducedBy).toBeUndefined()
      expect(each.attribution.vendoredBy).toBeUndefined()
    }
    expect(finding(report, 'Window.setTimeout').occurrences[0].evidence).toEqual({})
    expect(report.packages).toEqual({ 'otel-fetch': { version: '0.57.0', versionSource: 'store-path' } })
  })

  test("the baseline header matches a scan run without --lockfile", async () => {
    const dir = fixtureBuild(build())
    const lockfile = lockfileAt('bun.lock', staleLock)
    const without = await scanBuild(dir)
    const withLockfile = await scanBuild(dir, ['--lockfile', lockfile])

    expect(withLockfile.report.packages).toEqual(without.report.packages)
    expect(withLockfile.report.findings.map((each: Json) => each.fingerprint)).toEqual(
      without.report.findings.map((each: Json) => each.fingerprint),
    )
  })

  test("a vendoring package's store version the lockfile doesn't install makes it stale too", async () => {
    const lockfile = lockfileAt('bun.lock', bunLock)
    const { report } = await scanBuild(
      mapped('window.fetch = w', 'node_modules/.bun/engine.io-client@6.4.0/node_modules/engine.io-client/node_modules/tiny-helper/x.js'),
      ['--lockfile', lockfile],
    )

    expect(report.completeness.attribution.introducers).toEqual({
      reason: 'lockfile-stale',
      evidence: "a store path gives engine.io-client@6.4.0, which the lockfile doesn't install",
    })
    expect(finding(report, 'Window.fetch').introducedBy).toBeUndefined()
  })
})

describe('identity (ADR 0006)', () => {
  test('fingerprints are byte-identical with and without --lockfile', async () => {
    const dir = fixtureBuild(
      scripts([
        ['a.js', 'window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js'],
        ['b.js', 'window.setTimeout = w', 'webpack://app/./node_modules/@acme/telemetry/node_modules/tiny-helper/x.js'],
        ['c.js', 'XMLHttpRequest.prototype.send = w', 'webpack://app/./src/main.ts'],
      ]),
    )
    const lockfile = lockfileAt('package-lock.json', npmLock)
    const without = await scanBuild(dir)
    const withLockfile = await scanBuild(dir, ['--lockfile', lockfile])

    const fingerprints = (report: Json) => JSON.stringify(report.findings.map((each: Json) => each.fingerprint))
    expect(fingerprints(withLockfile.report)).toBe(fingerprints(without.report))
    expect(withLockfile.report.config.scanConfigId).toBe(without.report.config.scanConfigId)
  })
})

describe('two strong lockfile versions of one name', () => {
  test('leave it out of `packages`, with no `previousVersion` note on either side', async () => {
    const dir = fixtureBuild(
      scripts([
        ['a.js', 'window.fetch = w', 'webpack://app/./node_modules/debug/index.js'],
        ['b.js', 'window.fetch = w', 'webpack://app/./node_modules/engine.io-client/node_modules/debug/index.js'],
      ]),
    )
    const before = lockfileAt('package-lock.json', npmLock)
    const cwd = workingDir()
    const init = await scanBuild(dir, ['--lockfile', before], { cwd })
    expect(init.report.packages).toEqual({})

    // Only the nested copy is upgraded.
    const upgraded = structuredClone(npmLock) as Json
    upgraded.packages['node_modules/engine.io-client/node_modules/debug'].version = '3.2.8'
    const baseline = join(cwd, 'report.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(baseline, JSON.stringify(init.report))
    const { report } = await scanBuild(dir, ['--lockfile', lockfileAt('package-lock.json', upgraded), '--baseline', baseline], { cwd })

    expect(report.packages).toEqual({})
    const fetch = finding(report, 'Window.fetch')
    expect(fetch.baselineState).toBe('existing')
    expect(fetch.notes.filter((note: Json) => note.kind === 'previous-version')).toEqual([])
  })
})

describe('terminal wording (§10 Terminal wording)', () => {
  /** The terminal report of a scan of `files`, with `args`. */
  async function terminal(files: Record<string, string>, args: string[] = []): Promise<string> {
    const run = await runCli(['scan', fixtureBuild(files), '--map', defaultMap, '--surface', 'all', ...args])
    expect(run.exitCode).toBe(0)
    return run.stdout
  }

  test('`Introduced by` follows Package when it differs from it', async () => {
    const out = await terminal(mapped('window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js'), [
      '--lockfile',
      lockfileAt('package-lock.json', npmLock),
    ])

    expect(out).toContain('    Package          otel-fetch@0.57.0\n    Introduced by    @acme/telemetry@8.0.0\n')
    expect(out).toMatch(/\n {2}Lockfile {5}\S*package-lock\.json\n/)
  })

  test('is omitted when the containing package is itself a direct dependency', async () => {
    const out = await terminal(mapped('window.fetch = w', 'webpack://app/./node_modules/debug/index.js'), [
      '--lockfile',
      lockfileAt('package-lock.json', npmLock),
    ])

    expect(out).toContain('    Package          debug@4.3.4\n')
    expect(out).not.toContain('Introduced by    ')
  })

  test('reads `unknown (no lockfile)` without one, and the recorded reason otherwise', async () => {
    const files = mapped('window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js')
    expect(await terminal(files)).toContain('    Package          otel-fetch\n    Introduced by    unknown (no lockfile)\n')

    const cwd = workingDir({
      'monkeypatchlist.config.json': JSON.stringify({
        lockfile: { path: lockfileAt('package-lock.json', npmLock), importer: 'apps/nope' },
      }),
    })
    const run = await runCli(['scan', fixtureBuild(files), '--map', defaultMap, '--surface', 'all'], { cwd })
    expect(run.stdout).toContain('    Introduced by    unknown (importer-unresolved)\n')
    expect(run.stdout).toMatch(/ {2}Lockfile {5}\S*package-lock\.json · importer-unresolved: [^\n]* · Introduced by unknown\n/)
  })

  test('is not shown for first-party code', async () => {
    const out = await terminal(mapped('window.fetch = w', 'webpack://app/./src/main.ts'), [
      '--lockfile',
      lockfileAt('package-lock.json', npmLock),
    ])

    expect(out).not.toContain('Introduced by    ')
  })
})

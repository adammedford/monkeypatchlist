// Package versions and `previousVersion` (§10 Version; §11 Baseline, `previousVersion`; §15; ADR 0005). A
// version is evidence, never identity. Only strong versions (a store path, or a path-keyed lockfile)
// feed the report's and the baseline's `packages` map and the `previousVersion` note.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertValidReport, defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'
import { identityMappings, mappings } from './support/source-map.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** A source map whose sources are `sources` (each `[path, content]`), with every token of `code` on source 0. */
function sourceMap(code: string, sources: [string, string | null][]): string {
  return JSON.stringify({
    version: 3,
    sources: sources.map(([path]) => path),
    sourcesContent: sources.map(([, content]) => content),
    names: [],
    mappings: mappings(identityMappings(code)),
  })
}

/** A build whose `main.js` is `code`, with a sidecar map naming `source` (and any `more` sources) for its tokens. */
function mapped(code: string, source: string, more: [string, string | null][] = []): Record<string, string> {
  return {
    'index.html': '<script src="main.js"></script>',
    'main.js': code,
    'main.js.map': sourceMap(code, [[source, code], ...more]),
  }
}

const finding = (report: Json, target: string) => {
  const found = report.findings.filter((each: Json) => each.target.name === target)
  expect(found).toHaveLength(1)
  return found[0]
}

const pnpm = (name: string, version: string) =>
  `webpack://app/./node_modules/.pnpm/${name.replace('/', '+')}@${version}/node_modules/${name}/index.js`

describe('strong versions (§10 Version)', () => {
  test('a pnpm store path gives a strong version in `packages`, and the occurrence carries it as evidence', async () => {
    const { report } = await scanBuild(mapped('window.fetch = w', pnpm('otel-fetch', '0.57.0')))

    expect(report.packages).toEqual({ 'otel-fetch': { version: '0.57.0', versionSource: 'store-path' } })
    const fetch = finding(report, 'Window.fetch')
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|pkg:otel-fetch')
    expect(fetch.occurrences[0].evidence).toEqual({ version: { version: '0.57.0', versionSource: 'store-path' } })
  })

  test.each([
    ['pnpm, scoped', 'node_modules/.pnpm/@acme+otel@1.2.3/node_modules/@acme/otel/index.js', '@acme/otel', '1.2.3'],
    ['pnpm, with a peer suffix', 'node_modules/.pnpm/otel-fetch@0.57.0_react@18.2.0/node_modules/otel-fetch/index.js', 'otel-fetch', '0.57.0'],
    ['pnpm, with a pre-release', 'node_modules/.pnpm/otel-fetch@1.0.0-rc.1/node_modules/otel-fetch/index.js', 'otel-fetch', '1.0.0-rc.1'],
    ['Bun', 'node_modules/.bun/otel-fetch@0.57.0/node_modules/otel-fetch/index.js', 'otel-fetch', '0.57.0'],
    ['a Yarn cache archive', '.yarn/cache/otel-fetch-npm-0.57.0-6382451519-eb835a2e51.zip/node_modules/otel-fetch/index.js', 'otel-fetch', '0.57.0'],
    ['a scoped Yarn cache archive', '.yarn/cache/@acme-otel-npm-1.2.3-6382451519-eb835a2e51.zip/node_modules/@acme/otel/index.js', '@acme/otel', '1.2.3'],
    ["Yarn's global cache", '/home/dev/.yarn/berry/cache/otel-fetch-npm-0.57.0-6382451519-eb835a2e51.zip/node_modules/otel-fetch/index.js', 'otel-fetch', '0.57.0'],
    ["Yarn's pnpm linker", 'node_modules/.store/otel-fetch-npm-0.57.0-6382451519/package/index.js', 'otel-fetch', '0.57.0'],
    ["pnpm's global virtual store", '/home/dev/.local/share/pnpm/store/v10/links/@acme/otel/1.2.3/0f3a9c/node_modules/@acme/otel/index.js', '@acme/otel', '1.2.3'],
  ])('%s gives a strong store-path version', async (_, source, name, version) => {
    const { report } = await scanBuild(mapped('window.fetch = w', source))

    expect(finding(report, 'Window.fetch').attribution.package).toBe(name)
    expect(report.packages).toEqual({ [name]: { version, versionSource: 'store-path' } })
  })

  test.each([
    ['plain node_modules', 'webpack://app/./node_modules/otel-fetch/index.js'],
    ["a package inside another package's store entry", 'node_modules/.pnpm/telemetry-agent@8.0.0/node_modules/telemetry-agent/vendor/node_modules/otel-fetch/index.js'],
    ['a store entry that names another package', 'node_modules/.pnpm/telemetry-agent@8.0.0/node_modules/otel-fetch/index.js'],
    ['a git dependency', 'node_modules/.pnpm/otel-fetch@https+++codeload.github.com+acme+otel-fetch+tar.gz+0f3a9c/node_modules/otel-fetch/index.js'],
  ])('%s gives no version', async (_, source) => {
    const { report } = await scanBuild(mapped('window.fetch = w', source))

    expect(finding(report, 'Window.fetch').attribution.package).toBe('otel-fetch')
    // Vendored code carries `vendoredBy` instead, and no version either.
    expect(finding(report, 'Window.fetch').occurrences[0].evidence.version).toBeUndefined()
    expect(report.packages).toEqual({})
  })
})

describe('weak versions (§10 Version)', () => {
  const source = 'webpack://app/./node_modules/otel-fetch/index.js'
  const own = (file: string) => `webpack://app/./node_modules/otel-fetch/${file}`

  test.each([
    [
      'its package.json in sourcesContent',
      [[own('package.json'), '{ "name": "otel-fetch", "version": "0.57.0" }']],
      'package-json',
    ],
    ['an in-package VERSION constant', [[own('version.js'), "export const SDK_VERSION = '0.57.0'\n"]], 'version-constant'],
    ['a banner', [[own('lib.js'), '/*! otel-fetch v0.57.0 | MIT */\nexport {}\n']], 'banner'],
  ] as [string, [string, string][], string][])(
    '%s is shown as evidence, but kept out of `packages`',
    async (_, more, versionSource) => {
      const { report } = await scanBuild(mapped('window.fetch = w', source, more))

      const fetch = finding(report, 'Window.fetch')
      expect(fetch.occurrences[0].evidence).toEqual({ version: { version: '0.57.0', versionSource } })
      expect(report.packages).toEqual({})
    },
  )

  test("another package's signals, or a package.json naming another package, give nothing", async () => {
    const { report } = await scanBuild(
      mapped('window.fetch = w', source, [
        ['webpack://app/./node_modules/other/package.json', '{ "name": "other", "version": "9.9.9" }'],
        ['webpack://app/./node_modules/other/version.js', "export const VERSION = '9.9.9'"],
        [own('package.json'), '{ "name": "not-otel-fetch", "version": "9.9.9" }'],
      ]),
    )

    expect(finding(report, 'Window.fetch').occurrences[0].evidence).toEqual({})
  })

  test('a store-path version is stronger than a weak signal', async () => {
    const { report } = await scanBuild(
      mapped('window.fetch = w', pnpm('otel-fetch', '0.57.0'), [
        [pnpm('otel-fetch', '0.57.0').replace('index.js', 'package.json'), '{ "name": "otel-fetch", "version": "0.56.0" }'],
      ]),
    )

    expect(finding(report, 'Window.fetch').occurrences[0].evidence).toEqual({
      version: { version: '0.57.0', versionSource: 'store-path' },
    })
    expect(report.packages).toEqual({ 'otel-fetch': { version: '0.57.0', versionSource: 'store-path' } })
  })
})

/** A build of `index.html` running each script in `scripts`, `[name, code, source]`, with a sidecar map for each. */
function scripts(list: [string, string, string][]): Record<string, string> {
  const files: Record<string, string> = {
    'index.html': list.map(([name]) => `<script src="${name}"></script>`).join(''),
  }
  for (const [name, code, source] of list) {
    files[name] = code
    files[`${name}.map`] = sourceMap(code, [[source, code]])
  }
  return files
}

/** zone.js at each of `versions`, one script per version, every one writing `window.fetch`. */
const zone = (...versions: string[]) =>
  scripts(versions.map((version, i) => [`chunk-${i}.js`, 'window.fetch = w', pnpm('zone.js', version)]))

describe('a package with more than one strong version', () => {
  test('gets no `packages` entry, while each occurrence keeps its own version as evidence', async () => {
    const { report } = await scanBuild(zone('0.14.2', '0.15.0'))

    expect(report.packages).toEqual({})
    const fetch = finding(report, 'Window.fetch')
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|pkg:zone.js')
    expect(fetch.occurrences.map((occurrence: Json) => occurrence.evidence.version.version)).toEqual(['0.14.2', '0.15.0'])
  })
})

/** Runs `monkeypatchlist baseline init` over `files` in `cwd`, and returns the baseline it wrote. */
async function baselineInit(cwd: string, files: Record<string, string>): Promise<Json> {
  const run = await runCli(['baseline', 'init', fixtureBuild(files), '--map', defaultMap, '--surface', 'all'], { cwd })
  if (run.exitCode !== 0) throw new Error(`baseline init exited ${run.exitCode}:\n${run.stderr}`)
  return JSON.parse(readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8'))
}

/** Scans `files` against the baseline in `cwd`, and returns the validated report. */
async function scanAgainst(cwd: string, files: Record<string, string>): Promise<Json> {
  const run = await runCli(
    ['scan', fixtureBuild(files), '--map', defaultMap, '--surface', 'all', '--baseline', 'monkeypatchlist.baseline.json', '--json', '-'],
    { cwd },
  )
  if (run.exitCode !== 0) throw new Error(`scan exited ${run.exitCode}:\n${run.stderr}`)
  const report = JSON.parse(run.stdout)
  assertValidReport(report)
  return report
}

const previousVersion = (finding: Json) => finding.notes.filter((note: Json) => note.kind === 'previous-version')

describe('the baseline `packages` map and `previousVersion` (§11)', () => {
  test('`baseline init` writes the strong versions into the header', async () => {
    const cwd = workingDir()
    const baseline = await baselineInit(cwd, mapped('window.fetch = w', pnpm('otel-fetch', '0.56.1')))

    expect(baseline.packages).toEqual({ 'otel-fetch': { version: '0.56.1', versionSource: 'store-path' } })
  })

  test('an upgraded package gives a `previousVersion` note, and the fingerprint does not change', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, mapped('window.fetch = w', pnpm('otel-fetch', '0.56.1')))

    const report = await scanAgainst(cwd, mapped('window.fetch = w', pnpm('otel-fetch', '0.57.0')))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|pkg:otel-fetch')
    expect(fetch.baselineState).toBe('existing')
    expect(fetch.matchedBy).toBe('fingerprint')
    expect(fetch.changedReasons).toEqual([])
    expect(fetch.notes).toEqual([{ kind: 'previous-version', package: 'otel-fetch', before: '0.56.1', after: '0.57.0' }])
    expect(report.baseline.header.packages).toEqual({ 'otel-fetch': { version: '0.56.1', versionSource: 'store-path' } })
    expect(report.packages).toEqual({ 'otel-fetch': { version: '0.57.0', versionSource: 'store-path' } })
  })

  test('the note is set in any state: an added finding of an upgraded package carries it too', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, mapped('window.fetch = w', pnpm('otel-fetch', '0.56.1')))

    const report = await scanAgainst(cwd, mapped('window.fetch = w; window.setTimeout = t', pnpm('otel-fetch', '0.57.0')))

    const timeout = finding(report, 'Window.setTimeout')
    expect(timeout.baselineState).toBe('added')
    expect(previousVersion(timeout)).toEqual([
      { kind: 'previous-version', package: 'otel-fetch', before: '0.56.1', after: '0.57.0' },
    ])
  })

  test.each([
    ['the same version', pnpm('otel-fetch', '0.56.1')],
    ['no strong version in the scan', 'webpack://app/./node_modules/otel-fetch/index.js'],
  ])('%s gives no note', async (_, source) => {
    const cwd = workingDir()
    await baselineInit(cwd, mapped('window.fetch = w', pnpm('otel-fetch', '0.56.1')))

    const report = await scanAgainst(cwd, mapped('window.fetch = w', source))

    expect(finding(report, 'Window.fetch').notes).toEqual([])
  })

  test('a weak version on either side gives no note', async () => {
    const cwd = workingDir()
    const weak = (version: string) =>
      mapped('window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js', [
        ['webpack://app/./node_modules/otel-fetch/package.json', `{ "name": "otel-fetch", "version": "${version}" }`],
      ])
    const baseline = await baselineInit(cwd, weak('0.56.1'))
    expect(baseline.packages).toEqual({})

    const report = await scanAgainst(cwd, mapped('window.fetch = w', pnpm('otel-fetch', '0.57.0')))

    expect(finding(report, 'Window.fetch').notes).toEqual([])
  })

  test('an ambiguous package is noted on neither side: {0.14.2, 0.15.0} → {0.15.0}, and back', async () => {
    const cwd = workingDir()
    const baseline = await baselineInit(cwd, zone('0.14.2', '0.15.0'))
    expect(baseline.packages).toEqual({})

    const upgraded = await scanAgainst(cwd, zone('0.15.0'))
    expect(upgraded.packages).toEqual({ 'zone.js': { version: '0.15.0', versionSource: 'store-path' } })
    expect(finding(upgraded, 'Window.fetch').notes).toEqual([])

    const back = workingDir()
    await baselineInit(back, zone('0.14.2'))
    expect(finding(await scanAgainst(back, zone('0.14.2', '0.15.0')), 'Window.fetch').notes).toEqual([])
  })
})

describe('the terminal card (§15 Terminal, §10 Terminal wording)', () => {
  /** The terminal report of scanning `files`, against the baseline in `cwd` when there is one. */
  async function terminal(cwd: string, files: Record<string, string>, baseline: boolean): Promise<string> {
    const against = baseline ? ['--baseline', 'monkeypatchlist.baseline.json'] : []
    const run = await runCli(['scan', fixtureBuild(files), '--map', defaultMap, '--surface', 'all', ...against], { cwd })
    if (run.exitCode !== 0) throw new Error(`scan exited ${run.exitCode}:\n${run.stderr}`)
    return run.stdout
  }

  test('shows `Package name@version` and a `Previous version` line for an upgraded package', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, mapped('window.fetch = w', pnpm('otel-fetch', '0.56.1')))

    const out = await terminal(cwd, mapped('window.fetch = w; window.setTimeout = t', pnpm('otel-fetch', '0.57.0')), true)

    expect(out).toContain(
      [
        '  Window.setTimeout                replace',
        '    Package          otel-fetch@0.57.0',
        '    Previous version otel-fetch@0.56.1',
      ].join('\n'),
    )
  })

  test('shows no version for a package with none, a weak one with its source, and every version of an ambiguous one', async () => {
    const cwd = workingDir()
    const plain = await terminal(cwd, mapped('window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js'), false)
    expect(plain).toContain('    Package          otel-fetch\n')
    expect(plain).not.toContain('Previous version')

    const weak = await terminal(
      cwd,
      mapped('window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js', [
        ['webpack://app/./node_modules/otel-fetch/package.json', '{ "name": "otel-fetch", "version": "0.57.0" }'],
      ]),
      false,
    )
    expect(weak).toContain('    Package          otel-fetch (0.57.0 from package-json, a weak signal)\n')

    const ambiguous = await terminal(cwd, zone('0.15.0', '0.14.2'), false)
    expect(ambiguous).toContain('    Package          zone.js (versions 0.14.2, 0.15.0)\n')
  })

  test('shows every version of a package ambiguous across findings, each of which has one version', async () => {
    const out = await terminal(
      workingDir(),
      scripts([
        ['chunk-0.js', 'window.fetch = w', pnpm('zone.js', '0.14.2')],
        ['chunk-1.js', 'window.setTimeout = t', pnpm('zone.js', '0.15.0')],
      ]),
      false,
    )

    expect(out.split('    Package          zone.js (versions 0.14.2, 0.15.0)\n')).toHaveLength(3)
    expect(out).not.toContain('Package          zone.js@')
  })
})

describe("Yarn's pnpm linker (§10 step 2, §9)", () => {
  test('a scoped package slug keys `unknown` with `yarn-slug` (low), the slug as evidence, and no `packages` entry', async () => {
    const { report } = await scanBuild(
      mapped('window.fetch = w', 'node_modules/.store/@acme-otel-npm-1.2.3-6382451519/package/index.js'),
    )

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['yarn-slug'] })
    expect(fetch.occurrences[0].evidence).toEqual({ slug: '@acme-otel' })
    expect(report.packages).toEqual({})
  })
})

describe('monkeypatchlist explain (§15)', () => {
  test("shows an occurrence's version and its source as evidence", async () => {
    const cwd = workingDir()
    const build = fixtureBuild(mapped('window.fetch = w', pnpm('otel-fetch', '0.57.0')))
    const scan = await runCli(['scan', build, '--map', defaultMap, '--surface', 'all', '--json', 'report.json'], { cwd })
    expect(scan.exitCode).toBe(0)

    const run = await runCli(['explain', 'window|Window.fetch|replace|pkg:otel-fetch', '--report', 'report.json'], { cwd })

    expect(run.stdout).toContain('Evidence     version 0.57.0 (store-path)\n')
  })
})

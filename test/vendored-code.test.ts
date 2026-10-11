// Vendored code (§10 Provenance, Terminal wording; §9 `vendored`; ADR 0006). A store-name mismatch, a
// package path inside another package's store entry, names the path's package, with the vendoring package as
// `vendoredBy` evidence and the reason `vendored` (low). `vendoredBy` is evidence only: it never enters the
// fingerprint, the baseline or `changed`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'
import { identityMappings, mappings } from './support/source-map.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** A build whose `main.js` is `code`, with a sidecar map naming `source` for its tokens. */
function mapped(code: string, source: string): Record<string, string> {
  return {
    'index.html': '<script src="main.js"></script>',
    'main.js': code,
    'main.js.map': JSON.stringify({
      version: 3,
      sources: [source],
      sourcesContent: [code],
      names: [],
      mappings: mappings(identityMappings(code)),
    }),
  }
}

/** A build of `index.html` running each script in `list`, `[name, code, source]`, with a sidecar map for each. */
function scripts(list: [string, string, string][]): Record<string, string> {
  const files: Record<string, string> = {
    'index.html': list.map(([name]) => `<script src="${name}"></script>`).join(''),
  }
  for (const [name, code, source] of list) Object.assign(files, prefixed(name, mapped(code, source)))
  return files
}

/** `mapped`'s script and map, renamed to `name`. */
function prefixed(name: string, files: Record<string, string>): Record<string, string> {
  return { [name]: files['main.js']!, [`${name}.map`]: files['main.js.map']! }
}

const finding = (report: Json, target: string) => {
  const found = report.findings.filter((each: Json) => each.target.name === target)
  expect(found).toHaveLength(1)
  return found[0]
}

/** telemetry-agent@1.2.0's own pnpm store entry, with tiny-helper's file at `inner` inside it. */
const agent = (inner: string) => `webpack://app/./node_modules/.pnpm/telemetry-agent@1.2.0/node_modules/${inner}`

describe('a store-name mismatch is vendored code (§10 Provenance)', () => {
  test('names the package its path names, with `vendoredBy` as evidence and `vendored` (low)', async () => {
    const { report } = await scanBuild(mapped('window.fetch = w', agent('telemetry-agent/node_modules/tiny-helper/index.js')))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|pkg:tiny-helper')
    expect(fetch.attribution).toEqual({
      key: 'pkg:tiny-helper',
      provenance: 'bundled-dependency',
      package: 'tiny-helper',
      vendoredBy: 'telemetry-agent@1.2.0',
    })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['vendored'] })
    expect(fetch.occurrences[0].evidence).toEqual({ vendoredBy: 'telemetry-agent@1.2.0' })
    expect(report.packages).toEqual({})
  })
})

describe('every store layout §10 Version reads (§10 Provenance)', () => {
  test.each([
    ['a hoisted build of the vendoring package, collapsed into its store entry', agent('tiny-helper/index.js'), 'tiny-helper', 'telemetry-agent@1.2.0'],
    ['a scoped vendoring package', 'node_modules/.pnpm/@acme+agent@2.0.0_react@18.2.0/node_modules/@acme/agent/node_modules/tiny-helper/index.js', 'tiny-helper', '@acme/agent@2.0.0'],
    ['a scoped vendored package', agent('telemetry-agent/node_modules/@tiny/helper/index.js'), '@tiny/helper', 'telemetry-agent@1.2.0'],
    ['Bun', 'node_modules/.bun/telemetry-agent@1.2.0/node_modules/telemetry-agent/node_modules/tiny-helper/index.js', 'tiny-helper', 'telemetry-agent@1.2.0'],
    ['a Yarn cache archive', '.yarn/cache/telemetry-agent-npm-1.2.0-6382451519-eb835a2e51.zip/node_modules/telemetry-agent/node_modules/tiny-helper/index.js', 'tiny-helper', 'telemetry-agent@1.2.0'],
    ['a scoped Yarn cache archive', '.yarn/cache/@acme-agent-npm-2.0.0-6382451519-eb835a2e51.zip/node_modules/@acme/agent/node_modules/tiny-helper/index.js', 'tiny-helper', '@acme/agent@2.0.0'],
    ["Yarn's pnpm linker", 'node_modules/.store/telemetry-agent-npm-1.2.0-6382451519/package/node_modules/tiny-helper/index.js', 'tiny-helper', 'telemetry-agent@1.2.0'],
    ["pnpm's global virtual store", '/home/dev/.local/share/pnpm/store/v10/links/@acme/agent/2.0.0/0f3a9c/node_modules/@acme/agent/node_modules/tiny-helper/index.js', 'tiny-helper', '@acme/agent@2.0.0'],
  ])('%s', async (_, source, name, vendoredBy) => {
    const { report } = await scanBuild(mapped('window.fetch = w', source))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: `pkg:${name}`, provenance: 'bundled-dependency', package: name, vendoredBy })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['vendored'] })
  })

  test.each([
    ['a package in its own store entry', 'node_modules/.pnpm/tiny-helper@1.0.0/node_modules/tiny-helper/index.js'],
    ['plain node_modules, nested or not', 'webpack://app/./node_modules/telemetry-agent/node_modules/tiny-helper/index.js'],
    ["pnpm's hoisted node_modules", 'node_modules/.pnpm/node_modules/tiny-helper/index.js'],
    ['a git dependency\'s store entry', 'node_modules/.pnpm/github.com+acme+agent@0f3a9c/node_modules/tiny-helper/index.js'],
    ["a scoped slug under Yarn's pnpm linker, which can't name the vendoring package", 'node_modules/.store/@acme-agent-npm-2.0.0-6382451519/package/node_modules/tiny-helper/index.js'],
  ])('%s is not vendored', async (_, source) => {
    const { report } = await scanBuild(mapped('window.fetch = w', source))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.package).toBe('tiny-helper')
    expect(fetch.attribution.vendoredBy).toBeUndefined()
    expect(fetch.occurrences[0].evidence.vendoredBy).toBeUndefined()
    expect(fetch.confidence.attribution.reasons).not.toContain('vendored')
  })
})

describe("a finding's `vendoredBy` over its occurrences", () => {
  test('a copy that is not vendored leaves `vendoredBy` to the occurrences, and keeps the finding high', async () => {
    const { report } = await scanBuild(
      scripts([
        ['a.js', 'window.fetch = w', agent('telemetry-agent/node_modules/tiny-helper/index.js')],
        ['b.js', 'window.fetch = w', 'node_modules/.pnpm/tiny-helper@1.0.0/node_modules/tiny-helper/index.js'],
      ]),
    )

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|pkg:tiny-helper')
    expect(fetch.attribution).toEqual({ key: 'pkg:tiny-helper', provenance: 'bundled-dependency', package: 'tiny-helper' })
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
    expect(fetch.occurrences.map((each: Json) => each.evidence.vendoredBy)).toEqual(['telemetry-agent@1.2.0', undefined])
    expect(fetch.occurrences.map((each: Json) => each.confidence.attribution.level)).toEqual(['low', 'high'])
  })

  test('two vendoring packages leave it to the occurrences too', async () => {
    const { report } = await scanBuild(
      scripts([
        ['a.js', 'window.fetch = w', agent('telemetry-agent/node_modules/tiny-helper/index.js')],
        ['b.js', 'window.fetch = w', 'node_modules/.pnpm/other-agent@3.0.0/node_modules/other-agent/node_modules/tiny-helper/index.js'],
      ]),
    )

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.vendoredBy).toBeUndefined()
    expect(fetch.occurrences.map((each: Json) => each.evidence.vendoredBy)).toEqual([
      'telemetry-agent@1.2.0',
      'other-agent@3.0.0',
    ])
  })
})

describe('`vendoredBy` is evidence only (ADR 0006)', () => {
  /** Runs `monkeypatchlist baseline init` over `files` in `cwd`, and returns the baseline file's text. */
  async function baselineInit(cwd: string, files: Record<string, string>): Promise<string> {
    const run = await runCli(['baseline', 'init', fixtureBuild(files), '--map', defaultMap, '--surface', 'all'], { cwd })
    if (run.exitCode !== 0) throw new Error(`baseline init exited ${run.exitCode}:\n${run.stderr}`)
    return readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8')
  }

  async function scanAgainst(cwd: string, files: Record<string, string>): Promise<Json> {
    const run = await runCli(
      ['scan', fixtureBuild(files), '--map', defaultMap, '--surface', 'all', '--baseline', 'monkeypatchlist.baseline.json', '--json', '-'],
      { cwd },
    )
    if (run.exitCode !== 0) throw new Error(`scan exited ${run.exitCode}:\n${run.stderr}`)
    return JSON.parse(run.stdout)
  }

  test('a vendored and an installed copy write the same baseline, and switching between them is `existing`', async () => {
    const vendored = mapped('window.fetch = w', agent('telemetry-agent/node_modules/tiny-helper/index.js'))
    const installed = mapped('window.fetch = w', 'webpack://app/./node_modules/tiny-helper/index.js')
    const cwd = workingDir()
    const baseline = await baselineInit(cwd, vendored)
    expect(baseline).not.toContain('vendoredBy')
    expect(baseline).not.toContain('telemetry-agent')
    expect(baseline).toBe(await baselineInit(workingDir(), installed))

    const fetch = finding(await scanAgainst(cwd, installed), 'Window.fetch')
    expect(fetch).toMatchObject({ baselineState: 'existing', matchedBy: 'fingerprint', changedReasons: [], notes: [] })

    const other = mapped('window.fetch = w', 'node_modules/.pnpm/other-agent@3.0.0/node_modules/other-agent/node_modules/tiny-helper/index.js')
    const moved = finding(await scanAgainst(cwd, other), 'Window.fetch')
    expect(moved).toMatchObject({ baselineState: 'existing', matchedBy: 'fingerprint', changedReasons: [], notes: [] })
    expect(moved.attribution.vendoredBy).toBe('other-agent@3.0.0')
  })
})

describe('the terminal card (§10 Terminal wording)', () => {
  test('reads `Package tiny-helper (vendored in telemetry-agent@x)`', async () => {
    const run = await runCli(
      ['scan', fixtureBuild(mapped('window.fetch = w', agent('telemetry-agent/node_modules/tiny-helper/index.js'))), '--map', defaultMap, '--surface', 'all'],
      { cwd: workingDir() },
    )

    expect(run.stdout).toContain('    Package          tiny-helper (vendored in telemetry-agent@1.2.0)\n')
  })

  test("never shows an installed copy's version for the vendored copy", async () => {
    const files = scripts([
      ['a.js', 'window.fetch = w', agent('telemetry-agent/node_modules/tiny-helper/index.js')],
      ['b.js', 'history.pushState = w', 'node_modules/.pnpm/tiny-helper@1.0.0/node_modules/tiny-helper/index.js'],
    ])
    const run = await runCli(['scan', fixtureBuild(files), '--map', defaultMap, '--surface', 'all'], { cwd: workingDir() })

    expect(run.stdout).toContain('    Package          tiny-helper (vendored in telemetry-agent@1.2.0)\n')
    expect(run.stdout).toContain('    Package          tiny-helper@1.0.0\n')
  })
})

describe('monkeypatchlist explain (§15)', () => {
  test('shows the vendoring package in the attribution and as occurrence evidence', async () => {
    const cwd = workingDir()
    const build = fixtureBuild(mapped('window.fetch = w', agent('telemetry-agent/node_modules/tiny-helper/index.js')))
    expect((await runCli(['scan', build, '--map', defaultMap, '--surface', 'all', '--json', 'report.json'], { cwd })).exitCode).toBe(0)

    const run = await runCli(['explain', 'window|Window.fetch|replace|pkg:tiny-helper', '--report', 'report.json'], { cwd })

    expect(run.stdout).toContain('pkg:tiny-helper · package tiny-helper · vendored in telemetry-agent@1.2.0 · provenance')
    expect(run.stdout).toContain('Evidence     vendored in telemetry-agent@1.2.0\n')
  })
})

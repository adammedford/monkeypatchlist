// Version skew and format versions (§4 Version skew, §11 Format versions, §16 Exit codes; ADR 0008): a baseline written
// by another monkeypatchlist version. Tests write a baseline with `monkeypatchlist baseline init`, sometimes under a catalog with
// another version swapped in through the CLI's `deps`, or edit the file it wrote, then run `monkeypatchlist scan --json -` or
// `monkeypatchlist baseline update` over a fixture build in the same working directory.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Deps } from '../src/cli.ts'
import { loadCatalog, type SerializedCatalog } from '../src/index.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, workingDir } from './support/fixture-build.ts'

const page = '<script src="main.js"></script>'
const code = 'window.fetch = a\nwindow.setTimeout = b\n'
const build = () => fixtureBuild({ 'index.html': page, 'main.js': code })

const catalog = loadCatalog()
const { catalogVersion } = catalog.metadata
const { version: monkeypatchlistVersion } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

/** The committed catalog under another catalog version, as another monkeypatchlist release would ship it. */
function catalogAt(version: number): Partial<Deps> {
  const other: SerializedCatalog = { ...catalog, metadata: { ...catalog.metadata, catalogVersion: version } }
  return { loadCatalog: () => other }
}

/** Runs `monkeypatchlist baseline init` in `cwd`, which writes `monkeypatchlist.baseline.json` there. */
async function baselineInit(cwd: string, deps: Partial<Deps> = {}): Promise<void> {
  const run = await runCli(['baseline', 'init', build(), '--map', defaultMap], { cwd, deps })
  if (run.exitCode !== 0) throw new Error(`baseline init exited ${run.exitCode}:\n${run.stderr}`)
}

/** Runs `monkeypatchlist scan … --json - --baseline monkeypatchlist.baseline.json <args…>` in `cwd`, with the report validated. */
async function scan(cwd: string, args: string[] = [], deps: Partial<Deps> = {}) {
  const argv = ['scan', build(), '--map', defaultMap, '--json', '-', '--baseline', 'monkeypatchlist.baseline.json', ...args]
  const run = await runCli(argv, { cwd, deps })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
  let report: any = null
  if (run.stdout !== '') {
    report = JSON.parse(run.stdout)
    assertValidReport(report)
  }
  return { ...run, report }
}

describe('catalog skew (§4 Version skew)', () => {
  test('a baseline from an older catalog scans normally, with a note naming both versions', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const { exitCode, stderr, report } = await scan(cwd, ['--fail-on', 'added,changed'], catalogAt(catalogVersion + 1))

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(report.findings.map((finding: { baselineState: string }) => finding.baselineState)).toEqual([
      'existing',
      'existing',
    ])
    expect(report.baseline.notes).toEqual([
      {
        kind: 'version-skew',
        newer: 'scan',
        formatVersion: { baseline: 1, scan: 1 },
        fingerprintScheme: { baseline: 1, scan: 1 },
        catalogVersion: { baseline: catalogVersion, scan: catalogVersion + 1 },
        monkeypatchlistVersion: { baseline: monkeypatchlistVersion, scan: monkeypatchlistVersion },
      },
    ])
  })

  test('the report with the note is byte-identical across runs, except its run block', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    const dir = build()
    const argv = ['scan', dir, '--map', defaultMap, '--json', '-', '--baseline', 'monkeypatchlist.baseline.json']

    const [first, second] = await Promise.all([1, 2].map(() => runCli(argv, { cwd, deps: catalogAt(catalogVersion + 1) })))

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(JSON.parse(first!.stdout).baseline.notes).toHaveLength(1)
    expect(beforeRun(first!.stdout)).toBe(beforeRun(second!.stdout))
  })

  test('a baseline from a newer catalog scans with a warning, and no explainedBy', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, catalogAt(catalogVersion + 1))

    const { exitCode, stderr, report } = await scan(cwd, ['--fail-on', 'added,changed'])

    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/^monkeypatchlist: warning: .*newer/)
    expect(stderr).toContain(`catalog ${catalogVersion + 1}`)
    expect(report.findings.map((finding: { baselineState: string }) => finding.baselineState)).toEqual([
      'existing',
      'existing',
    ])
    expect(report.findings.flatMap((finding: { explainedBy?: unknown[] }) => finding.explainedBy ?? [])).toEqual([])
    expect(report.baseline.notes).toEqual([
      {
        kind: 'version-skew',
        newer: 'baseline',
        formatVersion: { baseline: 1, scan: 1 },
        fingerprintScheme: { baseline: 1, scan: 1 },
        catalogVersion: { baseline: catalogVersion + 1, scan: catalogVersion },
        monkeypatchlistVersion: { baseline: monkeypatchlistVersion, scan: monkeypatchlistVersion },
      },
    ])
  })
})

/** The next patch release after `version`: `1.2.4` after `1.2.3`. */
function nextPatch(version: string): string {
  const [major, minor, patch] = version.split(/[.+-]/).map(Number)
  return `${major}.${minor}.${patch! + 1}`
}

/** Rewrites `monkeypatchlist.baseline.json` in `cwd` with `change` applied to its parsed contents. */
function editBaseline(cwd: string, change: (baseline: Record<string, unknown>) => void): void {
  const path = join(cwd, 'monkeypatchlist.baseline.json')
  const baseline = JSON.parse(readFileSync(path, 'utf8'))
  change(baseline)
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`)
}

describe('monkeypatchlist version skew (§4 Version skew, ADR 0008)', () => {
  test.each([
    ['newer', '999.0.0', 'baseline'],
    ['newer, as a prerelease of a later version', `${nextPatch(monkeypatchlistVersion)}-rc.1`, 'baseline'],
    ['older, as a prerelease of this version', `${monkeypatchlistVersion}-rc.1`, 'scan'],
  ])('a baseline written by a monkeypatchlist that is %s gives the note', async (_, version, newer) => {
    const cwd = workingDir()
    await baselineInit(cwd)
    editBaseline(cwd, (baseline) => (baseline.monkeypatchlistVersion = version))

    const { exitCode, stderr, report } = await scan(cwd, ['--fail-on', 'added,changed'])

    expect(exitCode).toBe(0)
    expect(report.baseline.notes).toEqual([
      {
        kind: 'version-skew',
        newer,
        formatVersion: { baseline: 1, scan: 1 },
        fingerprintScheme: { baseline: 1, scan: 1 },
        catalogVersion: { baseline: catalogVersion, scan: catalogVersion },
        monkeypatchlistVersion: { baseline: version, scan: monkeypatchlistVersion },
      },
    ])
    // Only a newer baseline warns.
    if (newer === 'baseline') expect(stderr).toContain(`monkeypatchlist ${version}`)
    else expect(stderr).toBe('')
  })

  test('build metadata alone is no skew', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    editBaseline(cwd, (baseline) => (baseline.monkeypatchlistVersion = `${monkeypatchlistVersion}+build.7`))

    const { stderr, report } = await scan(cwd)

    expect(stderr).toBe('')
    expect(report.baseline.notes).toEqual([])
  })

  test('a monkeypatchlistVersion that is not a semantic version is not a baseline', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    editBaseline(cwd, (baseline) => (baseline.monkeypatchlistVersion = 'latest'))

    const gated = await scan(cwd, ['--fail-on', 'added'])
    const plain = await scan(cwd)

    expect(gated.exitCode).toBe(2)
    expect(gated.stderr).toContain('/monkeypatchlistVersion: must match format "semver"')
    expect(plain.exitCode).toBe(0)
    expect(plain.report.baseline).toBeNull()
  })
})

/** Runs `monkeypatchlist baseline update … <args…>` in `cwd`, which rewrites `monkeypatchlist.baseline.json` there. */
function baselineUpdate(cwd: string, args: string[] = [], deps: Partial<Deps> = {}) {
  return runCli(['baseline', 'update', build(), '--map', defaultMap, ...args], { cwd, deps })
}

const baselineText = (cwd: string) => readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8')

describe('baseline update refuses a downgrade (§4 Version skew, §16 --allow-downgrade; ADR 0008)', () => {
  test.each([
    ['catalog', (cwd: string) => baselineInit(cwd, catalogAt(catalogVersion + 1))],
    [
      'monkeypatchlist',
      async (cwd: string) => {
        await baselineInit(cwd)
        editBaseline(cwd, (baseline) => (baseline.monkeypatchlistVersion = '999.0.0'))
      },
    ],
  ])('over a baseline from a newer %s, it exits 2 and leaves the file as it was', async (_, write) => {
    const cwd = workingDir()
    await write(cwd)
    const text = baselineText(cwd)

    const run = await baselineUpdate(cwd)

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('--allow-downgrade')
    expect(baselineText(cwd)).toBe(text)
  })

  test('with --allow-downgrade, it rewrites the baseline under this version, with the warning', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, catalogAt(catalogVersion + 1))
    editBaseline(cwd, (baseline) => (baseline.monkeypatchlistVersion = '999.0.0'))
    const fresh = workingDir()
    await baselineInit(fresh)

    const run = await baselineUpdate(cwd, ['--allow-downgrade'])

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toMatch(/^monkeypatchlist: warning: .*newer/)
    // The rewritten file is the one this version writes over the build: its header names this version.
    expect(baselineText(cwd)).toBe(baselineText(fresh))
  })

  test('the config key allowDowngrade does the same', async () => {
    const cwd = workingDir({ 'monkeypatchlist.config.json': JSON.stringify({ allowDowngrade: true }) })
    await baselineInit(cwd, catalogAt(catalogVersion + 1))

    const run = await baselineUpdate(cwd)

    expect(run.exitCode).toBe(0)
    expect(JSON.parse(baselineText(cwd)).catalogVersion).toBe(catalogVersion)
  })

  test('over an older baseline it needs no flag', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const run = await baselineUpdate(cwd, [], catalogAt(catalogVersion + 1))

    expect(run.exitCode).toBe(0)
    expect(JSON.parse(baselineText(cwd)).catalogVersion).toBe(catalogVersion + 1)
  })
})

/**
 * A fixture format migration. Format 0 is made up for the test: it kept the header fields under a `header` key, and
 * format 1 has them at the top level.
 */
const formatMigrations = (): Partial<Deps> => ({
  migrations: {
    format: new Map([
      [
        0,
        (old: unknown) => {
          const { header, entries } = old as { header: Record<string, unknown>; entries: unknown[] }
          return { formatVersion: 1, ...header, entries }
        },
      ],
    ]),
    fingerprintScheme: new Map(),
  },
})

/** Rewrites `monkeypatchlist.baseline.json` in `cwd` in the made-up format 0. */
function writeFormat0(cwd: string): void {
  const path = join(cwd, 'monkeypatchlist.baseline.json')
  const { entries, ...header } = JSON.parse(readFileSync(path, 'utf8'))
  delete header.formatVersion
  writeFileSync(path, `${JSON.stringify({ formatVersion: 0, header, entries }, null, 2)}\n`)
}

describe('format versions (§11 Format versions)', () => {
  test('an older formatVersion is migrated in memory, with a warning and the note', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    writeFormat0(cwd)

    const { exitCode, stderr, report } = await scan(cwd, ['--fail-on', 'added,changed'], formatMigrations())

    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/^monkeypatchlist: warning: .*formatVersion 0/)
    expect(report.findings.map((finding: { baselineState: string }) => finding.baselineState)).toEqual([
      'existing',
      'existing',
    ])
    expect(report.baseline.header.formatVersion).toBe(1)
    expect(report.baseline.notes).toEqual([
      {
        kind: 'version-skew',
        newer: 'scan',
        formatVersion: { baseline: 0, scan: 1 },
        fingerprintScheme: { baseline: 1, scan: 1 },
        catalogVersion: { baseline: catalogVersion, scan: catalogVersion },
        monkeypatchlistVersion: { baseline: monkeypatchlistVersion, scan: monkeypatchlistVersion },
      },
    ])
  })

  test('baseline update rewrites an older formatVersion in the current one', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    const current = baselineText(cwd)
    writeFormat0(cwd)

    const run = await baselineUpdate(cwd, [], formatMigrations())

    expect(run.exitCode).toBe(0)
    expect(baselineText(cwd)).toBe(current)
  })

  test('an older formatVersion with no migration is not a readable baseline', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    writeFormat0(cwd)

    const gated = await scan(cwd, ['--fail-on', 'added'])
    const plain = await scan(cwd)

    expect(gated.exitCode).toBe(2)
    expect(gated.stderr).toContain('formatVersion 0')
    expect(plain.exitCode).toBe(0)
    expect(plain.report.baseline).toBeNull()
  })

  test('an older formatVersion that its migration throws on is not a readable baseline', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    writeFormat0(cwd)
    const throwing: Partial<Deps> = {
      migrations: {
        format: new Map([
          [
            0,
            () => {
              throw new TypeError('no header')
            },
          ],
        ]),
        fingerprintScheme: new Map(),
      },
    }

    const gated = await scan(cwd, ['--fail-on', 'added'], throwing)
    const plain = await scan(cwd, [], throwing)

    expect(gated.exitCode).toBe(2)
    expect(gated.stderr).toContain('not a baseline in formatVersion 0: no header')
    expect(plain.exitCode).toBe(0)
    expect(plain.report.baseline).toBeNull()
  })

  test('a newer formatVersion exits 2, even for baseline update under --allow-downgrade', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    editBaseline(cwd, (baseline) => (baseline.formatVersion = 2))
    const text = baselineText(cwd)

    const scanned = await scan(cwd)
    const updated = await baselineUpdate(cwd, ['--allow-downgrade'])

    expect(scanned.exitCode).toBe(2)
    expect(scanned.stderr).toContain('formatVersion 2')
    expect(updated.exitCode).toBe(2)
    expect(baselineText(cwd)).toBe(text)
  })
})

/**
 * A fixture fingerprint scheme migration. Scheme 0 is made up for the test: it wrote the attribution key first
 * (`unknown|window|Window.fetch|replace`), and scheme 1 writes it last.
 */
const schemeMigrations = (): Partial<Deps> => ({
  migrations: {
    format: new Map(),
    fingerprintScheme: new Map([
      [
        0,
        (entries) =>
          entries.map((entry) => ({
            ...entry,
            fingerprint: `${entry.target.realm}|${entry.target.name}|${entry.effect}|${entry.attribution.key}`,
          })),
      ],
    ]),
  },
})

/** Rewrites `monkeypatchlist.baseline.json` in `cwd` under the made-up fingerprint scheme 0. */
function writeScheme0(cwd: string): void {
  editBaseline(cwd, (baseline) => {
    baseline.fingerprintScheme = 0
    for (const entry of baseline.entries as { fingerprint: string }[]) {
      const parts = entry.fingerprint.split('|')
      entry.fingerprint = [parts.at(-1), ...parts.slice(0, -1)].join('|')
    }
  })
}

describe('fingerprint schemes (§4 Version skew)', () => {
  test('a fixture scheme migration lets an older scheme match by fingerprint, with a warning and the note', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    writeScheme0(cwd)
    expect(baselineText(cwd)).toContain('"unknown|window|Window.fetch|replace"')

    const { exitCode, stderr, report } = await scan(cwd, ['--fail-on', 'added,changed'], schemeMigrations())

    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/^monkeypatchlist: warning: .*fingerprint scheme 0/)
    expect(
      report.findings.map((finding: { fingerprint: string; baselineState: string; matchedBy: string }) => [
        finding.fingerprint,
        finding.baselineState,
        finding.matchedBy,
      ]),
    ).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing', 'fingerprint'],
      ['window|Window.setTimeout|replace|unknown', 'existing', 'fingerprint'],
    ])
    expect(report.baseline.header.fingerprintScheme).toBe(1)
    expect(report.baseline.notes).toEqual([
      {
        kind: 'version-skew',
        newer: 'scan',
        formatVersion: { baseline: 1, scan: 1 },
        fingerprintScheme: { baseline: 0, scan: 1 },
        catalogVersion: { baseline: catalogVersion, scan: catalogVersion },
        monkeypatchlistVersion: { baseline: monkeypatchlistVersion, scan: monkeypatchlistVersion },
      },
    ])
  })

  test('baseline update rewrites an older scheme in the current one', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    const current = baselineText(cwd)
    writeScheme0(cwd)

    const run = await baselineUpdate(cwd, [], schemeMigrations())

    expect(run.exitCode).toBe(0)
    expect(baselineText(cwd)).toBe(current)
  })

  test.each([
    ['a newer scheme', (cwd: string) => editBaseline(cwd, (baseline) => (baseline.fingerprintScheme = 2)), 2, true],
    ['an older scheme with no migration', writeScheme0, 0, false],
  ])('%s is a hard error under --fail-on that says to run baseline init', async (_, write, scheme, newer) => {
    const cwd = workingDir()
    await baselineInit(cwd)
    write(cwd)

    const run = await scan(cwd, ['--fail-on', 'added,changed'])

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain(`fingerprint scheme ${scheme}`)
    expect(run.stderr).toContain('monkeypatchlist baseline init')
    // A newer scheme comes from a newer monkeypatchlist, so upgrading is offered before a downgrading init.
    expect(run.stderr.includes('Upgrade monkeypatchlist')).toBe(newer)
  })

  test('without --fail-on, a scheme that cannot be migrated leaves the scan without a baseline, with a warning', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    editBaseline(cwd, (baseline) => (baseline.fingerprintScheme = 2))

    const { exitCode, stderr, report } = await scan(cwd)

    expect(exitCode).toBe(0)
    expect(stderr).toMatch(/^monkeypatchlist: warning: scanning without a baseline.*fingerprint scheme 2/)
    expect(report.baseline).toBeNull()
    expect(report.findings.map((finding: { baselineState: string | null }) => finding.baselineState)).toEqual([
      null,
      null,
    ])
  })

  test('baseline update over a scheme that cannot be migrated exits 2, even under --allow-downgrade', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    editBaseline(cwd, (baseline) => (baseline.fingerprintScheme = 2))
    const text = baselineText(cwd)

    const run = await baselineUpdate(cwd, ['--allow-downgrade'])

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('monkeypatchlist baseline init')
    expect(baselineText(cwd)).toBe(text)
  })
})

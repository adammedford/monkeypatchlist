// `monkeypatchlist scan --baseline <path>` and the gate (§11 Baseline states and matching, The gate, No baseline; §15;
// §16 Exit codes; ADR 0017). Tests write a baseline with `monkeypatchlist baseline init` over one fixture build, then scan
// another with `monkeypatchlist scan --json -` in the same working directory, and assert on report fields.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, workingDir } from './support/fixture-build.ts'

const page = '<script src="main.js"></script>'

/** A build whose `main.js` is `code`. */
const build = (code: string) => fixtureBuild({ 'index.html': page, 'main.js': code })

/** Runs `monkeypatchlist baseline init <build> --map … <args…>` in `cwd`, which writes `monkeypatchlist.baseline.json` there. */
async function baselineInit(cwd: string, code: string, args: string[] = []): Promise<void> {
  const run = await runCli(['baseline', 'init', build(code), '--map', defaultMap, ...args], { cwd })
  if (run.exitCode !== 0) throw new Error(`baseline init exited ${run.exitCode}:\n${run.stderr}`)
}

/**
 * Runs `monkeypatchlist scan <build> --map … --json - <args…>` in `cwd`, and returns the exit code and output, with the report
 * parsed and validated against the shipped report JSON Schema when there is one. The `--map` is left out when `args`
 * has one.
 */
async function scan(cwd: string, code: string, args: string[] = []) {
  const map = args.includes('--map') ? [] : ['--map', defaultMap]
  const run = await runCli(['scan', build(code), ...map, '--json', '-', ...args], { cwd })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
  let report: any = null
  if (run.stdout !== '') {
    report = JSON.parse(run.stdout)
    assertValidReport(report)
  }
  return { ...run, report }
}

// The baseline's build mutates fetch and setTimeout; the scanned build keeps fetch, drops setTimeout and adds clearInterval.
const before = 'window.fetch = a\nwindow.setTimeout = b\n'
const after = 'window.fetch = a\nwindow.clearInterval = c\n'

/** A broken baseline: its text, or the change to make to a baseline that `baseline init` wrote. */
type BrokenBaseline = string | { formatVersion?: number; effect?: string; twice?: true }

/** Baseline files that aren't a readable baseline (§11 No baseline). */
const unreadableBaselines: [string, BrokenBaseline][] = [
  ['not JSON', '{ "formatVersion": 1,'],
  ['not a baseline', '{ "entries": [] }'],
  ['an entry with an unknown effect', { effect: 'mutate' }],
  ['a fingerprint listed twice', { twice: true }],
]

/** Writes `monkeypatchlist.baseline.json` in `cwd`: `baseline init`'s over the `before` build, broken as `content` says. */
async function writeBrokenBaseline(cwd: string, content: BrokenBaseline): Promise<void> {
  await baselineInit(cwd, before)
  const path = join(cwd, 'monkeypatchlist.baseline.json')
  if (typeof content === 'string') return writeFileSync(path, content)
  const baseline = JSON.parse(readFileSync(path, 'utf8'))
  if (content.formatVersion !== undefined) baseline.formatVersion = content.formatVersion
  if (content.effect !== undefined) baseline.entries[0].effect = content.effect
  if (content.twice) baseline.entries.push(baseline.entries[0])
  writeFileSync(path, JSON.stringify(baseline))
}

describe('baseline states by exact fingerprint (§11 Baseline states and matching)', () => {
  test('a match is existing, an unmatched finding is added, and an unmatched entry is removed', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const { exitCode, report } = await scan(cwd, after, ['--baseline', 'monkeypatchlist.baseline.json'])

    expect(exitCode).toBe(0)
    expect(
      report.findings.map((finding: { fingerprint: string; baselineState: string | null; matchedBy: string | null }) => [
        finding.fingerprint,
        finding.baselineState,
        finding.matchedBy,
      ]),
    ).toEqual([
      ['window|Window.clearInterval|replace|unknown', 'added', null],
      ['window|Window.fetch|replace|unknown', 'existing', 'fingerprint'],
      ['window|Window.setTimeout|replace|unknown', 'removed', null],
    ])
    expect(report.summary).toMatchObject({ added: 1, changed: 0, existing: 1, removed: 1, unconfirmed: 0, ineffectiveWrites: 0 })
  })

  test("a removed finding carries the baseline entry's readable context, and no occurrences or confidence", async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const { report } = await scan(cwd, after, ['--baseline', 'monkeypatchlist.baseline.json'])

    const removed = report.findings.find((finding: { baselineState: string }) => finding.baselineState === 'removed')
    expect(removed).toEqual({
      fingerprint: 'window|Window.setTimeout|replace|unknown',
      targetKey: 'window|Window.setTimeout|replace',
      target: { realm: 'window', holder: 'global', name: 'Window.setTimeout' },
      surface: 'scheduling',
      effect: 'replace',
      locks: false,
      attribution: { key: 'unknown', provenance: 'unknown' },
      reachability: null,
      reachabilityBasis: null,
      installContext: null,
      confidence: null,
      baselineState: 'removed',
      matchedBy: null,
      changedReasons: [],
      notes: [],
      policy: null,
      occurrences: [],
    })
  })

  test('an unchanged build is all existing', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const { report } = await scan(cwd, before, ['--baseline', 'monkeypatchlist.baseline.json'])

    expect(report.findings.map((finding: { baselineState: string }) => finding.baselineState)).toEqual([
      'existing',
      'existing',
    ])
    expect(report.summary).toMatchObject({ added: 0, changed: 0, existing: 2, removed: 0, unconfirmed: 0, ineffectiveWrites: 0 })
  })
})

describe('no baseline (§11 No baseline)', () => {
  test('without --baseline, every baseline state is null, and the summary counts nothing', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const { exitCode, report } = await scan(cwd, after)

    expect(exitCode).toBe(0)
    expect(
      report.findings.map((finding: { baselineState: string | null; matchedBy: string | null }) => [
        finding.baselineState,
        finding.matchedBy,
      ]),
    ).toEqual([
      [null, null],
      [null, null],
    ])
    expect(report.summary).toMatchObject({ added: 0, changed: 0, existing: 0, removed: 0, unconfirmed: 0, ineffectiveWrites: 0 })
  })
})

describe('the gate (§11 The gate, §15, §16 Exit codes)', () => {
  test('--fail-on added exits 1 when a finding is added, and marks it in its policy slot', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const { exitCode, report } = await scan(cwd, after, ['--baseline', 'monkeypatchlist.baseline.json', '--fail-on', 'added'])

    expect(exitCode).toBe(1)
    expect(
      report.findings.map((finding: { baselineState: string; policy: unknown }) => [finding.baselineState, finding.policy]),
    ).toEqual([
      ['added', { outcome: 'fail', by: 'fail-on:added' }],
      ['existing', null],
      ['removed', null],
    ])
    expect(report.gate).toEqual({ failOn: ['added'], result: 'fail', exitCode: 1 })
  })

  test('--fail-on added exits 0 when nothing is added, even with a removed finding', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const { exitCode, report } = await scan(cwd, 'window.fetch = a\n', ['--fail-on', 'added'])

    expect(exitCode).toBe(0)
    expect(report.summary).toMatchObject({ added: 0, changed: 0, existing: 1, removed: 1, unconfirmed: 0, ineffectiveWrites: 0 })
    expect(report.findings.map((finding: { policy: unknown }) => finding.policy)).toEqual([null, null])
    expect(report.gate).toEqual({ failOn: ['added'], result: 'pass', exitCode: 0 })
  })

  test('--fail-on changed does not trip on an added finding', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const { exitCode, report } = await scan(cwd, after, ['--fail-on', 'changed'])

    expect(exitCode).toBe(0)
    expect(report.summary.added).toBe(1)
    expect(report.findings.map((finding: { policy: unknown }) => finding.policy)).toEqual([null, null, null])
    expect(report.gate).toEqual({ failOn: ['changed'], result: 'pass', exitCode: 0 })
  })

  test('without --fail-on, the gate is not run', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const { exitCode, report } = await scan(cwd, after, ['--baseline', 'monkeypatchlist.baseline.json'])

    expect(exitCode).toBe(0)
    expect(report.findings.map((finding: { policy: unknown }) => finding.policy)).toEqual([null, null, null])
    expect(report.gate).toEqual({ failOn: [], result: 'not-run', exitCode: 0 })
  })
})

describe('a gate never runs without a readable baseline (§11 No baseline, §16 Exit codes)', () => {
  test('a mistyped baseline path under --fail-on exits 2, with no report', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const run = await scan(cwd, after, ['--baseline', 'monkeypatchlist.baseline.jsn', '--fail-on', 'added'])

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('monkeypatchlist.baseline.jsn')
  })

  test('--fail-on with no --baseline and no monkeypatchlist.baseline.json exits 2', async () => {
    const run = await scan(workingDir(), after, ['--fail-on', 'added,changed'])

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('monkeypatchlist.baseline.json')
  })

  test.each(unreadableBaselines)('a baseline file that is %s exits 2 under --fail-on', async (_, content) => {
    const cwd = workingDir()
    await writeBrokenBaseline(cwd, content)

    const run = await scan(cwd, after, ['--fail-on', 'added'])

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('monkeypatchlist.baseline.json')
  })

  test('a baseline in a newer formatVersion exits 2, with or without --fail-on (§11 Format versions)', async () => {
    const cwd = workingDir()
    await writeBrokenBaseline(cwd, { formatVersion: 2 })

    const gated = await scan(cwd, after, ['--fail-on', 'added'])
    const plain = await scan(cwd, after, ['--baseline', 'monkeypatchlist.baseline.json'])

    for (const run of [gated, plain]) {
      expect(run.exitCode).toBe(2)
      expect(run.stdout).toBe('')
      expect(run.stderr).toContain('formatVersion 2')
    }
  })
})

describe('without --fail-on, a baseline that is not readable leaves the scan without one (§11 No baseline)', () => {
  /** Asserts the report of a scan that has no baseline: null states and baseline block, and no gate. */
  function expectNoBaseline(run: Awaited<ReturnType<typeof scan>>, path: string) {
    expect(run.exitCode).toBe(0)
    expect(run.report.baseline).toBeNull()
    expect(run.report.findings.map((finding: { baselineState: string | null }) => finding.baselineState)).toEqual([
      null,
      null,
    ])
    expect(run.report.summary).toMatchObject({ added: 0, changed: 0, existing: 0, removed: 0, unconfirmed: 0, ineffectiveWrites: 0 })
    expect(run.report.gate).toEqual({ failOn: [], result: 'not-run', exitCode: 0 })
    expect(run.stderr).toContain('warning')
    expect(run.stderr).toContain(path)
  }

  test('a --baseline that names no file gives null baseline states, with a warning', async () => {
    const run = await scan(workingDir(), after, ['--baseline', 'missing.json'])

    expectNoBaseline(run, 'missing.json')
  })

  test.each(unreadableBaselines)('a baseline file that is %s gives null baseline states and a warning', async (_, file) => {
    const cwd = workingDir()
    await writeBrokenBaseline(cwd, file)

    const run = await scan(cwd, after, ['--baseline', 'monkeypatchlist.baseline.json'])

    expectNoBaseline(run, 'monkeypatchlist.baseline.json')
  })
})

describe('a baseline is compared only with a scan of its configuration (§16 Scan configuration identity, ADR 0017)', () => {
  /** The first line of stderr: the error, without the usage text after it. */
  const error = (stderr: string) => stderr.split('\n')[0]!

  test('a surface mismatch exits 2, and the error names the surface alone', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before, ['--surface', 'all'])

    const run = await scan(cwd, before, ['--fail-on', 'added'])

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(error(run.stderr)).toMatch(/\bsurface\b/)
    expect(error(run.stderr)).not.toMatch(/\b(entries|mappings|realms)\b/)
  })

  test('an entry and a mapping mismatch exits 2, even without --fail-on, and the error names both fields', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const run = await scan(cwd, before, [
      '--baseline',
      'monkeypatchlist.baseline.json',
      '--map',
      'https://app.example/=.',
      '--map',
      'https://cdn.example/=assets',
      '--entry',
      'index.html@https://app.example/home',
    ])

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(error(run.stderr)).toMatch(/\bentries\b/)
    expect(error(run.stderr)).toMatch(/\bmappings\b/)
    expect(error(run.stderr)).not.toMatch(/\b(surface|realms)\b/)
  })

  test('the mode, which is not part of the id, does not make a mismatch', async () => {
    const cwd = workingDir({ 'monkeypatchlist.config.json': JSON.stringify({ mode: 'resolve' }) })
    // `resolve` mode reads remote URLs through the fixture fetcher, which this build never asks.
    const init = await runCli(['baseline', 'init', build(before), '--map', defaultMap], {
      cwd,
      deps: { resolveFetcher: () => fixtureFetcher({}) },
    })
    expect(init.exitCode).toBe(0)
    writeFileSync(join(cwd, 'monkeypatchlist.config.json'), JSON.stringify({ mode: 'offline' }))

    const run = await scan(cwd, before, ['--fail-on', 'added'])

    expect(run.exitCode).toBe(0)
    expect(run.report.gate.result).toBe('pass')
  })
})

describe('the report records the baseline and the configuration it gated (§15)', () => {
  test('the baseline block holds the path as given, the header and no notes', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)
    const file = JSON.parse(readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8'))

    const { report } = await scan(cwd, after, ['--fail-on', 'added'])

    expect(report.baseline).toEqual({
      path: 'monkeypatchlist.baseline.json',
      header: {
        formatVersion: 1,
        scanConfigId: file.scanConfigId,
        fingerprintScheme: 1,
        catalogVersion: 1,
        monkeypatchlistVersion: file.monkeypatchlistVersion,
        completeness: 'complete',
        surface: 'protected',
        packages: {},
      },
      notes: [],
    })
    expect(Object.keys(report.baseline.header)).toEqual([
      'formatVersion',
      'scanConfigId',
      'fingerprintScheme',
      'catalogVersion',
      'monkeypatchlistVersion',
      'completeness',
      'surface',
      'packages',
    ])
  })

  test('without a baseline, the baseline block is null', async () => {
    const { report } = await scan(workingDir(), after)

    expect(report.baseline).toBeNull()
  })

  test('the config block records the scan-config id, the surface and --fail-on', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)
    const { scanConfigId } = JSON.parse(readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8'))

    const gated = await scan(cwd, after, ['--fail-on', 'changed,added'])
    const plain = await scan(cwd, after)

    expect(gated.report.config).toMatchObject({ scanConfigId, surface: 'protected', failOn: ['added', 'changed'] })
    expect(gated.report.gate.failOn).toEqual(['added', 'changed'])
    expect(plain.report.config).toMatchObject({ scanConfigId, surface: 'protected', failOn: [] })
  })

  test('the report keys are in the order of §15', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const { report } = await scan(cwd, after, ['--fail-on', 'added'])

    expect(Object.keys(report)).toEqual([
      'reportVersion',
      'tool',
      'application',
      'config',
      'summary',
      'gate',
      'completeness',
      'baseline',
      'packages',
      'findings',
      'ineffectiveWrites',
      'artifacts',
      'run',
    ])
    expect(Object.keys(report.config)).toEqual([
      'scanConfigId',
      'surface',
      'mode',
      'entries',
      'mappings',
      'sourceMaps',
      'lockfile',
      'failOn',
    ])
    expect(Object.keys(report.findings[0])).toEqual([
      'fingerprint',
      'targetKey',
      'target',
      'surface',
      'effect',
      'locks',
      'attribution',
      'reachability',
      'reachabilityBasis',
      'installContext',
      'confidence',
      'baselineState',
      'matchedBy',
      'changedReasons',
      'notes',
      'policy',
      'occurrences',
    ])
  })

  test('the gated report is byte-identical across runs, except its run block', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const first = await scan(cwd, after, ['--fail-on', 'added'])
    const second = await scan(cwd, after, ['--fail-on', 'added'])

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
    expect(first.exitCode).toBe(1)
  })
})

describe('the config keys baseline and failOn (§16 Configuration file)', () => {
  test('failOn gates, and baseline is relative to the config file', async () => {
    const config = { baseline: 'pl.baseline.json', failOn: ['added'] }
    const cwd = workingDir({ 'ci/monkeypatchlist.config.json': JSON.stringify(config) })
    await baselineInit(cwd, before, ['--out', 'ci/pl.baseline.json'])

    const run = await scan(cwd, after, ['--config', 'ci/monkeypatchlist.config.json'])

    expect(run.exitCode).toBe(1)
    expect(run.report.baseline.path).toBe(join('ci', 'pl.baseline.json'))
    expect(run.report.gate).toEqual({ failOn: ['added'], result: 'fail', exitCode: 1 })
  })

  test('the flags override the keys', async () => {
    const cwd = workingDir({ 'monkeypatchlist.config.json': JSON.stringify({ baseline: 'missing.json', failOn: ['added'] }) })
    await baselineInit(cwd, before)

    const run = await scan(cwd, before, ['--baseline', 'monkeypatchlist.baseline.json', '--fail-on', 'changed'])

    expect(run.exitCode).toBe(0)
    expect(run.report.gate).toEqual({ failOn: ['changed'], result: 'pass', exitCode: 0 })
  })

  test('baseline init ignores the scan keys', async () => {
    const cwd = workingDir({ 'monkeypatchlist.config.json': JSON.stringify({ baseline: 'missing.json', failOn: ['added'] }) })

    await baselineInit(cwd, before)

    expect(JSON.parse(readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8')).entries).toHaveLength(2)
  })
})

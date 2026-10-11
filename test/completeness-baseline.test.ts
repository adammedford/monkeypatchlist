// Completeness in baselines and the gate (§13 Effects on the baseline and the gate, §11 Baseline states and matching,
// §16 Exit codes). Tests write a baseline with `monkeypatchlist baseline init` over one fixture build, then scan another with
// `monkeypatchlist scan --json -` (or rewrite the baseline with `monkeypatchlist baseline update`) in the same working directory.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { crashGuardMs, type Deps } from '../src/cli.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, workingDir } from './support/fixture-build.ts'

/** A build whose entry document is `page`, with `main.js` holding `code` and any `other` files. */
const build = (page: string, code: string, other: Record<string, string> = {}) =>
  fixtureBuild({ 'index.html': page, 'main.js': code, ...other })

const page = '<script src="main.js"></script>'
/** A page that also runs `broken.js`, which doesn't parse: a `parse-failure` makes the scan `incomplete` (§13). */
const incompletePage = '<script src="main.js"></script><script src="broken.js"></script>'
const broken = { 'broken.js': 'window.setTimeout = (' }
/** A page that also runs a remote script, which an `offline` scan skips: `complete-with-limitations` (§13). */
const remotePage = '<script src="main.js"></script><script src="https://cdn.example/lib.js"></script>'

// The baseline's build mutates fetch and setTimeout; the scanned builds keep fetch and drop setTimeout.
const before = 'window.fetch = a\nwindow.setTimeout = b\n'
const after = 'window.fetch = a\n'

/** Runs `monkeypatchlist baseline init` over the `before` build in `cwd`, which writes `monkeypatchlist.baseline.json` there. */
async function baselineInit(cwd: string): Promise<void> {
  const run = await runCli(['baseline', 'init', build(page, before), '--map', defaultMap], { cwd })
  if (run.exitCode !== 0) throw new Error(`baseline init exited ${run.exitCode}:\n${run.stderr}`)
}

/**
 * Runs `monkeypatchlist scan <build> --map … --json - <args…>` in `cwd`, with `deps` swapped into the pipeline. Returns the
 * exit code and output, with the report parsed and validated against the shipped report JSON Schema when there is one.
 */
async function scan(cwd: string, dir: string, args: string[] = [], deps: Partial<Deps> = {}) {
  const run = await runCli(['scan', dir, '--map', defaultMap, '--json', '-', ...args], { cwd, deps })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
  let report: any = null
  if (run.stdout !== '') {
    report = JSON.parse(run.stdout)
    assertValidReport(report)
  }
  return { ...run, report }
}

/** A baseline entry whose code came from the remote script `remotePage` runs (§10 Provenance, §11 Attribution keys). */
const remoteEntry = {
  fingerprint: 'window|Window.open|wrap|url:https://cdn.example/lib.js',
  target: { realm: 'window', holder: 'global', name: 'Window.open' },
  surface: 'navigation',
  effect: 'wrap',
  locks: false,
  attribution: { key: 'url:https://cdn.example/lib.js', provenance: 'remote' },
}

/** Adds `entries` to the baseline in `cwd`, as a scan that analyzed that remote code would have written them. */
function addEntries(cwd: string, ...entries: object[]): void {
  const path = join(cwd, 'monkeypatchlist.baseline.json')
  const baseline = JSON.parse(readFileSync(path, 'utf8'))
  baseline.entries.push(...entries)
  writeFileSync(path, JSON.stringify(baseline, null, 2))
}

/** Each finding's fingerprint and baseline state. */
const states = (report: { findings: { fingerprint: string; baselineState: string | null }[] }) =>
  report.findings.map((finding) => [finding.fingerprint, finding.baselineState])

describe('unconfirmed baseline entries (§11 Baseline states and matching, §13)', () => {
  test('an incomplete scan turns a missing entry into unconfirmed, not removed', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const dir = build(incompletePage, after, broken)
    const { exitCode, report } = await scan(cwd, dir, ['--baseline', 'monkeypatchlist.baseline.json'])

    expect(exitCode).toBe(0)
    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.limitations.map(({ kind }: { kind: string }) => kind)).toEqual(['parse-failure'])
    expect(states(report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.setTimeout|replace|unknown', 'unconfirmed'],
    ])
    expect(report.summary).toMatchObject({ added: 0, changed: 0, existing: 1, removed: 0, unconfirmed: 1, ineffectiveWrites: 0 })
  })

  test("an unconfirmed finding carries the baseline entry's readable context, and no occurrences or confidence", async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const { report } = await scan(cwd, build(incompletePage, after, broken), ['--fail-on', 'added,changed'])

    const unconfirmed = report.findings.find(
      (finding: { baselineState: string }) => finding.baselineState === 'unconfirmed',
    )
    expect(unconfirmed).toEqual({
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
      baselineState: 'unconfirmed',
      matchedBy: null,
      changedReasons: [],
      notes: [],
      policy: null,
      occurrences: [],
    })
  })

  test('a remote entry missing from a scan that skipped a remote script is unconfirmed; a local one is removed', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    addEntries(cwd, remoteEntry)

    const { exitCode, report } = await scan(cwd, build(remotePage, after), ['--baseline', 'monkeypatchlist.baseline.json'])

    expect(exitCode).toBe(0)
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.completeness.limitations.map(({ kind }: { kind: string }) => kind)).toEqual(['offline-skipped'])
    expect(states(report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.open|wrap|url:https://cdn.example/lib.js', 'unconfirmed'],
      ['window|Window.setTimeout|replace|unknown', 'removed'],
    ])
    expect(report.summary).toMatchObject({ added: 0, changed: 0, existing: 1, removed: 1, unconfirmed: 1, ineffectiveWrites: 0 })
  })

  test('a remote entry missing from a scan that skipped no remote script is removed', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    addEntries(cwd, remoteEntry)

    const { report } = await scan(cwd, build(page, after), ['--baseline', 'monkeypatchlist.baseline.json'])

    expect(report.completeness.level).toBe('complete')
    expect(states(report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.open|wrap|url:https://cdn.example/lib.js', 'removed'],
      ['window|Window.setTimeout|replace|unknown', 'removed'],
    ])
  })
})

describe('the gate on an incomplete scan (§11 The gate, §13, §16 Exit codes)', () => {
  test('under --fail-on, an incomplete scan exits 3 even when no finding matched, and the gate itself passes', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const { exitCode, report } = await scan(cwd, build(incompletePage, after, broken), ['--fail-on', 'added'])

    expect(exitCode).toBe(3)
    expect(report.completeness.level).toBe('incomplete')
    expect(report.gate).toEqual({ failOn: ['added'], result: 'pass', exitCode: 3 })
    expect(report.findings.map((finding: { policy: unknown }) => finding.policy)).toEqual([null, null])
  })

  test('an incomplete scan whose gate fails also exits 3, and the report shows both results', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const added = 'window.fetch = a\nwindow.clearInterval = c\n'
    const { exitCode, report } = await scan(cwd, build(incompletePage, added, broken), ['--fail-on', 'added'])

    expect(exitCode).toBe(3)
    expect(report.completeness.level).toBe('incomplete')
    expect(report.gate).toEqual({ failOn: ['added'], result: 'fail', exitCode: 3 })
    const policies = report.findings.map((finding: { fingerprint: string; policy: unknown }) => [
      finding.fingerprint,
      finding.policy,
    ])
    expect(policies).toEqual([
      ['window|Window.clearInterval|replace|unknown', { outcome: 'fail', by: 'fail-on:added' }],
      ['window|Window.fetch|replace|unknown', null],
      ['window|Window.setTimeout|replace|unknown', null],
    ])
  })

  test('a crash guard that fires makes the scan incomplete, which exits 3 with no code of its own', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    let now = 0
    const clock = () => (now += crashGuardMs)

    const { exitCode, report } = await scan(cwd, build(page, before), ['--fail-on', 'added'], { clock })

    expect(exitCode).toBe(3)
    expect(report.completeness.counters.statistics.crashGuard).toBe('fired')
    expect(report.gate).toEqual({ failOn: ['added'], result: 'pass', exitCode: 3 })
    expect(states(report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'unconfirmed'],
      ['window|Window.setTimeout|replace|unknown', 'unconfirmed'],
    ])
  })

  test('the report of an incomplete, gated scan is byte-identical across runs, except its run block', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    const dir = build(incompletePage, after, broken)

    const runs = await Promise.all([1, 2].map(() => scan(cwd, dir, ['--fail-on', 'added'])))

    const [first, second] = runs.map(({ report }) => JSON.stringify({ ...report, run: null }, null, 2))
    expect(first).toBe(second)
    expect(runs.map(({ exitCode }) => exitCode)).toEqual([3, 3])
  })

  test('complete-with-limitations never fails the gate on its own', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const { exitCode, report } = await scan(cwd, build(remotePage, before), ['--fail-on', 'added,changed'])

    expect(exitCode).toBe(0)
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.gate).toEqual({ failOn: ['added', 'changed'], result: 'pass', exitCode: 0 })
  })

  test('without --fail-on, an incomplete scan exits 0: no gate runs', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const dir = build(incompletePage, after, broken)
    const { exitCode, report } = await scan(cwd, dir, ['--baseline', 'monkeypatchlist.baseline.json'])

    expect(exitCode).toBe(0)
    expect(report.gate).toEqual({ failOn: [], result: 'not-run', exitCode: 0 })
  })
})

describe('--allow-incomplete downgrades exit code 3 to a warning (§13, §16)', () => {
  test('an incomplete scan whose gate passes exits 0, with a warning', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const { exitCode, report, stderr } = await scan(cwd, build(incompletePage, after, broken), [
      '--fail-on',
      'added',
      '--allow-incomplete',
    ])

    expect(exitCode).toBe(0)
    expect(report.completeness.level).toBe('incomplete')
    expect(report.gate).toEqual({ failOn: ['added'], result: 'pass', exitCode: 0 })
    expect(stderr).toMatch(/^monkeypatchlist: warning: .*incomplete.*--allow-incomplete/m)
  })

  test('an incomplete scan whose gate fails exits 1', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const added = 'window.fetch = a\nwindow.clearInterval = c\n'
    const { exitCode, report } = await scan(cwd, build(incompletePage, added, broken), [
      '--fail-on',
      'added',
      '--allow-incomplete',
    ])

    expect(exitCode).toBe(1)
    expect(report.gate).toEqual({ failOn: ['added'], result: 'fail', exitCode: 1 })
  })

  test('the config key allowIncomplete does the same', async () => {
    const cwd = workingDir({ 'monkeypatchlist.config.json': JSON.stringify({ allowIncomplete: true }) })
    await baselineInit(cwd)

    const { exitCode, report, stderr } = await scan(cwd, build(incompletePage, after, broken), ['--fail-on', 'added'])

    expect(exitCode).toBe(0)
    expect(report.gate).toEqual({ failOn: ['added'], result: 'pass', exitCode: 0 })
    expect(stderr).toMatch(/^monkeypatchlist: warning: .*--allow-incomplete/m)
  })

  test('a complete scan gives no warning', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const { exitCode, stderr } = await scan(cwd, build(page, before), ['--fail-on', 'added', '--allow-incomplete'])

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
  })
})

/**
 * Runs `monkeypatchlist baseline update <build> --map … --json - <args…>` in `cwd`, which rewrites `monkeypatchlist.baseline.json`
 * there. Returns the exit code and output, with the report of its scan parsed and validated. What it accepts, and its
 * diagnostics, go to stderr.
 */
async function baselineUpdate(cwd: string, dir: string, args: string[] = []) {
  const run = await runCli(['baseline', 'update', dir, '--map', defaultMap, '--json', '-', ...args], { cwd })
  const report = JSON.parse(run.stdout)
  assertValidReport(report)
  return { ...run, report }
}

/** The text of `monkeypatchlist.baseline.json` in `cwd`. */
const baselineText = (cwd: string) => readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8')

describe('baseline update and completeness (§11 Commands, §13)', () => {
  test('it refuses an incomplete scan: exit 3, and the baseline is left as it was', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    const text = baselineText(cwd)

    const run = await baselineUpdate(cwd, build(incompletePage, after, broken))

    expect(run.exitCode).toBe(3)
    expect(baselineText(cwd)).toBe(text)
    expect(run.report.completeness.level).toBe('incomplete')
    expect(run.stderr).toMatch(/^monkeypatchlist: .*incomplete.*--allow-incomplete/m)
    expect(run.stderr).not.toContain('Accepted into')
    expect(run.stderr).not.toContain('wrote')
  })

  test('with --allow-incomplete it writes, with a warning, and carries the unconfirmed entries forward unchanged', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    const entries = JSON.parse(baselineText(cwd)).entries

    const run = await baselineUpdate(cwd, build(incompletePage, after, broken), ['--allow-incomplete'])

    expect(run.exitCode).toBe(0)
    expect(states(run.report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.setTimeout|replace|unknown', 'unconfirmed'],
    ])
    expect(run.stderr).toMatch(/^monkeypatchlist: warning: .*incomplete/m)
    expect(run.stderr).toContain('monkeypatchlist: wrote monkeypatchlist.baseline.json (2 entries)')
    const written = JSON.parse(baselineText(cwd))
    expect(written.completeness).toBe('incomplete')
    expect(written.entries).toEqual(entries)
  })

  test('it writes on a complete-with-limitations scan, with a warning, carrying a remote unconfirmed entry forward', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    addEntries(cwd, remoteEntry)

    const run = await baselineUpdate(cwd, build(remotePage, after))

    expect(run.exitCode).toBe(0)
    expect(run.report.completeness.level).toBe('complete-with-limitations')
    expect(states(run.report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.open|wrap|url:https://cdn.example/lib.js', 'unconfirmed'],
      ['window|Window.setTimeout|replace|unknown', 'removed'],
    ])
    expect(run.stderr).toMatch(/^monkeypatchlist: warning: .*complete-with-limitations.*1 unconfirmed entry/m)
    const written = JSON.parse(baselineText(cwd))
    expect(written.completeness).toBe('complete-with-limitations')
    expect(written.entries.map((entry: { fingerprint: string }) => entry.fingerprint)).toEqual([
      'window|Window.fetch|replace|unknown',
      'window|Window.open|wrap|url:https://cdn.example/lib.js',
    ])
    // Unchanged: the same fields, in the same order.
    expect(JSON.stringify(written.entries[1])).toBe(JSON.stringify(remoteEntry))
  })

  test('a rescan against the updated baseline still finds the carried entry unconfirmed', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)
    addEntries(cwd, remoteEntry)
    await baselineUpdate(cwd, build(remotePage, after))

    const { report } = await scan(cwd, build(remotePage, after), ['--baseline', 'monkeypatchlist.baseline.json'])

    expect(states(report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.open|wrap|url:https://cdn.example/lib.js', 'unconfirmed'],
    ])
  })

  test('on a complete scan it gives no warning', async () => {
    const cwd = workingDir()
    await baselineInit(cwd)

    const run = await baselineUpdate(cwd, build(page, after))

    expect(run.exitCode).toBe(0)
    expect(run.stderr).not.toContain('warning')
  })

  test('baseline init refuses an incomplete scan too, and writes one under --allow-incomplete', async () => {
    // test/baseline-init-guards.test.ts covers `init`'s guards in full.
    const dir = build(incompletePage, after, broken)
    const cwd = workingDir()

    const without = await runCli(['baseline', 'init', dir, '--map', defaultMap], { cwd })
    const run = await runCli(['baseline', 'init', dir, '--map', defaultMap, '--allow-incomplete'], { cwd })

    expect([without.exitCode, run.exitCode]).toEqual([3, 0])
    expect(JSON.parse(baselineText(cwd)).completeness).toBe('incomplete')
  })
})

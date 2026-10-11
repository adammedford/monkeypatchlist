// `monkeypatchlist baseline update <buildDir>` (§11 Commands, §16 Commands): it scans against the baseline it rewrites,
// prints the added, changed and removed entries it accepts, and rewrites the baseline with the whole current finding
// set. Tests write a baseline with `monkeypatchlist baseline init` over one fixture build, run `baseline update` over another
// in the same working directory, then read the file and rescan with `monkeypatchlist scan --json -`.

import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { renderAccepted } from '../src/packages/report/index.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, workingDir } from './support/fixture-build.ts'

const page = '<script src="main.js"></script>'

/** A build whose `main.js` is `code`. */
const build = (code: string) => fixtureBuild({ 'index.html': page, 'main.js': code })

/** Runs `monkeypatchlist baseline <command> <build> --map … <args…>` in `cwd`, and returns the exit code and output. */
function baseline(command: 'init' | 'update', cwd: string, code: string, args: string[] = []) {
  return runCli(['baseline', command, build(code), '--map', defaultMap, ...args], { cwd })
}

/** Runs `baseline init`, which writes `monkeypatchlist.baseline.json` in `cwd`, and fails the test if it doesn't exit 0. */
async function baselineInit(cwd: string, code: string, args: string[] = []): Promise<void> {
  const run = await baseline('init', cwd, code, args)
  if (run.exitCode !== 0) throw new Error(`baseline init exited ${run.exitCode}:\n${run.stderr}`)
}

/** Runs `monkeypatchlist scan <build> --map … --json - <args…>` in `cwd`, and returns the validated report. */
async function scan(cwd: string, code: string, args: string[] = []) {
  const run = await runCli(['scan', build(code), '--map', defaultMap, '--json', '-', ...args], { cwd })
  if (run.exitCode !== 0) throw new Error(`scan exited ${run.exitCode}:\n${run.stderr}`)
  const report = JSON.parse(run.stdout)
  assertValidReport(report)
  return report
}

/** The text of `monkeypatchlist.baseline.json` in `cwd`. */
const baselineText = (cwd: string, file = 'monkeypatchlist.baseline.json') => readFileSync(join(cwd, file), 'utf8')

// The baseline's build mutates fetch and setTimeout; the updated build keeps fetch, drops setTimeout and adds clearInterval.
const before = 'window.fetch = a\nwindow.setTimeout = b\n'
const after = 'window.fetch = a\nwindow.clearInterval = c\n'

describe('baseline update accepts the whole current finding set (§11 Commands)', () => {
  test('after update, a rescan of the same build gives only existing', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const run = await baseline('update', cwd, after)

    expect(run.exitCode).toBe(0)
    const report = await scan(cwd, after, ['--baseline', 'monkeypatchlist.baseline.json'])
    expect(
      report.findings.map((finding: { fingerprint: string; baselineState: string }) => [
        finding.fingerprint,
        finding.baselineState,
      ]),
    ).toEqual([
      ['window|Window.clearInterval|replace|unknown', 'existing'],
      ['window|Window.fetch|replace|unknown', 'existing'],
    ])
    expect(report.summary).toMatchObject({ added: 0, changed: 0, existing: 2, removed: 0, unconfirmed: 0, ineffectiveWrites: 0 })
  })
})

/** The block of `stdout` from its line `heading` to the end, one string per line. */
function block(stdout: string, heading: string): string[] {
  const lines = stdout.trimEnd().split('\n')
  const start = lines.indexOf(heading)
  return start === -1 ? [] : lines.slice(start)
}

describe('the list of accepted findings (report module)', () => {
  test('a changed finding is listed under Changed, between the added and removed ones, by current fingerprint', async () => {
    const cwd = workingDir()
    // The baseline's fetch locks, and the scanned build's doesn't: `changed` (`locks`) under the same fingerprint.
    await baselineInit(cwd, "Object.defineProperty(window, 'fetch', { value: a, configurable: false })\nwindow.setTimeout = b\n")
    const report = await scan(cwd, after, ['--baseline', 'monkeypatchlist.baseline.json'])
    expect(report.findings[1].baselineState).toBe('changed')

    expect(renderAccepted(report, 'monkeypatchlist.baseline.json').trimEnd().split('\n')).toEqual([
      'Accepted into monkeypatchlist.baseline.json',
      '  Added 1',
      '    window|Window.clearInterval|replace|unknown',
      '  Changed 1',
      '    window|Window.fetch|replace|unknown',
      '  Removed 1',
      '    window|Window.setTimeout|replace|unknown',
    ])
  })
})

describe('the baseline update writes (§11 Baseline, Determinism)', () => {
  test('it is the baseline init writes over the same build: removed entries are dropped', async () => {
    const updated = workingDir()
    await baselineInit(updated, before)
    const fresh = workingDir()
    await baselineInit(fresh, after)

    const run = await baseline('update', updated, after)

    expect(run.exitCode).toBe(0)
    expect(baselineText(updated)).toBe(baselineText(fresh))
    expect(JSON.parse(baselineText(updated)).entries.map((entry: { fingerprint: string }) => entry.fingerprint)).toEqual([
      'window|Window.clearInterval|replace|unknown',
      'window|Window.fetch|replace|unknown',
    ])
    expect(run.stderr).toContain('monkeypatchlist: wrote monkeypatchlist.baseline.json (2 entries)')
  })

  test('over an unchanged build, it accepts nothing and rewrites the file byte for byte', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)
    const text = baselineText(cwd)

    const run = await baseline('update', cwd, before)

    expect(run.exitCode).toBe(0)
    expect(baselineText(cwd)).toBe(text)
    expect(block(run.stdout, 'Accepted into monkeypatchlist.baseline.json')).toEqual([
      'Accepted into monkeypatchlist.baseline.json',
      '  Added 0',
      '  Changed 0',
      '  Removed 0',
    ])
  })

  test('an existing entry is rewritten from the current finding, refreshing its readable context', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)
    const text = baselineText(cwd)
    const stale = JSON.parse(text)
    stale.entries[0].surface = 'storage'
    writeFileSync(join(cwd, 'monkeypatchlist.baseline.json'), `${JSON.stringify(stale, null, 2)}\n`)

    const run = await baseline('update', cwd, before)

    expect(run.exitCode).toBe(0)
    expect(baselineText(cwd)).toBe(text)
  })

  test('it reads and rewrites the file --out names', async () => {
    const cwd = workingDir({ 'ci/README': 'baselines' })
    await baselineInit(cwd, before, ['--out', 'ci/app.baseline.json'])

    const run = await baseline('update', cwd, after, ['--out', 'ci/app.baseline.json', '--json', '-'])

    expect(run.exitCode).toBe(0)
    expect(JSON.parse(run.stdout).baseline.path).toBe('ci/app.baseline.json')
    expect(existsSync(join(cwd, 'monkeypatchlist.baseline.json'))).toBe(false)
    expect(JSON.parse(baselineText(cwd, 'ci/app.baseline.json')).entries).toHaveLength(2)
    expect(run.stderr).toContain('Accepted into ci/app.baseline.json')
  })

  test('it reads and rewrites the file the config key out names, relative to the config file', async () => {
    const cwd = workingDir({ 'ci/monkeypatchlist.config.json': JSON.stringify({ out: 'app.baseline.json' }) })
    await baselineInit(cwd, before, ['--config', 'ci/monkeypatchlist.config.json'])

    const run = await baseline('update', cwd, after, ['--config', 'ci/monkeypatchlist.config.json'])

    expect(run.exitCode).toBe(0)
    expect(JSON.parse(baselineText(cwd, 'ci/app.baseline.json')).entries).toHaveLength(2)
    expect(run.stdout).toContain(`Accepted into ${join('ci', 'app.baseline.json')}`)
  })
})

describe('baseline update prints what it accepts (§11 Commands, §16 Commands)', () => {
  test('after the terminal report, it lists the added, changed and removed entries, grouped by state', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const run = await baseline('update', cwd, after)

    expect(run.exitCode).toBe(0)
    expect(block(run.stdout, 'Accepted into monkeypatchlist.baseline.json')).toEqual([
      'Accepted into monkeypatchlist.baseline.json',
      '  Added 1',
      '    window|Window.clearInterval|replace|unknown',
      '  Changed 0',
      '  Removed 1',
      '    window|Window.setTimeout|replace|unknown',
    ])
  })

  test('under --json -, stdout is the JSON report of the scan against the baseline, and the list goes to stderr', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const run = await baseline('update', cwd, after, ['--json', '-'])

    expect(run.exitCode).toBe(0)
    const report = JSON.parse(run.stdout)
    assertValidReport(report)
    expect(
      report.findings.map((finding: { fingerprint: string; baselineState: string }) => [
        finding.fingerprint,
        finding.baselineState,
      ]),
    ).toEqual([
      ['window|Window.clearInterval|replace|unknown', 'added'],
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.setTimeout|replace|unknown', 'removed'],
    ])
    expect(report.summary).toMatchObject({ added: 1, changed: 0, existing: 1, removed: 1, unconfirmed: 0, ineffectiveWrites: 0 })
    expect(report.baseline.path).toBe('monkeypatchlist.baseline.json')
    expect(report.gate).toEqual({ failOn: [], result: 'not-run', exitCode: 0 })
    expect(block(run.stderr, 'Accepted into monkeypatchlist.baseline.json').slice(0, 6)).toEqual([
      'Accepted into monkeypatchlist.baseline.json',
      '  Added 1',
      '    window|Window.clearInterval|replace|unknown',
      '  Changed 0',
      '  Removed 1',
      '    window|Window.setTimeout|replace|unknown',
    ])
  })
})

describe('baseline update rewrites an existing, readable baseline (§11, §16 Exit codes)', () => {
  /** The first line of stderr: the error, without the usage text after it. */
  const error = (stderr: string) => stderr.split('\n')[0]!

  test('with no baseline file, it exits 2, points to baseline init, and writes nothing', async () => {
    const cwd = workingDir()

    const run = await baseline('update', cwd, after)

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(error(run.stderr)).toContain("'monkeypatchlist.baseline.json'")
    expect(error(run.stderr)).toContain('monkeypatchlist baseline init')
    expect(existsSync(join(cwd, 'monkeypatchlist.baseline.json'))).toBe(false)
  })

  test.each([
    ['with merge-conflict markers', '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> branch\n'],
    ['that is not a baseline', '{ "entries": [] }\n'],
  ])('a baseline file %s exits 2, and is left as it was', async (_, text) => {
    const cwd = workingDir({ 'monkeypatchlist.baseline.json': text })

    const run = await baseline('update', cwd, after)

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(error(run.stderr)).toContain("'monkeypatchlist.baseline.json'")
    expect(baselineText(cwd)).toBe(text)
  })

  test('a baseline in a newer formatVersion exits 2, and is left as it was (§11 Format versions)', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)
    const newer = baselineText(cwd).replace('"formatVersion": 1,', '"formatVersion": 2,')
    writeFileSync(join(cwd, 'monkeypatchlist.baseline.json'), newer)

    const run = await baseline('update', cwd, after)

    expect(run.exitCode).toBe(2)
    expect(error(run.stderr)).toContain('formatVersion 2')
    expect(baselineText(cwd)).toBe(newer)
  })

  test('a baseline written for another scan configuration exits 2, names the fields, and is left as it was', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)
    const text = baselineText(cwd)

    const run = await baseline('update', cwd, after, ['--surface', 'all'])

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(error(run.stderr)).toMatch(/\bsurface\b/)
    expect(error(run.stderr)).not.toMatch(/\b(entries|mappings|realms)\b/)
    expect(baselineText(cwd)).toBe(text)
  })

  // Root can write a read-only file, so this runs only as another user.
  test.skipIf(process.getuid?.() === 0)('a baseline it can read but not write lists nothing as accepted', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, before)
    const text = baselineText(cwd)
    chmodSync(join(cwd, 'monkeypatchlist.baseline.json'), 0o444)

    const run = await baseline('update', cwd, after)

    expect(run.exitCode).not.toBe(0)
    expect(run.stdout).not.toContain('Accepted into')
    expect(run.stderr).not.toContain('Accepted into')
    expect(baselineText(cwd)).toBe(text)
  })
})

describe('there is no selective accept (§11 Commands: that would be a Release 2 policy exception)', () => {
  test.each([
    ['an --accept flag', ['--accept', 'window|Window.clearInterval|replace|unknown']],
    ['a --fingerprint flag', ['--fingerprint', 'window|Window.clearInterval|replace|unknown']],
    ['a fingerprint as a second argument', ['window|Window.clearInterval|replace|unknown']],
  ])('%s is a usage error (exit 2), and the baseline is left as it was', async (_, args) => {
    const cwd = workingDir()
    await baselineInit(cwd, before)
    const text = baselineText(cwd)

    const run = await baseline('update', cwd, after, args)

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(baselineText(cwd)).toBe(text)
  })

  test('the usage names no flag that selects findings', async () => {
    const run = await runCli(['baseline'])

    const update = run.stderr.split('\n').find((line) => line.includes('monkeypatchlist baseline update <buildDir>'))
    expect(update).toBeDefined()
    expect(update).not.toMatch(/accept|fingerprint|--baseline|--fail-on/)
  })

  test.each([
    ['--baseline', 'a.json'],
    ['--fail-on', 'added'],
  ])('the scan flag %s is a usage error that names it', async (flag, value) => {
    const cwd = workingDir()
    await baselineInit(cwd, before)

    const run = await baseline('update', cwd, after, [flag, value])

    expect(run.exitCode).toBe(2)
    expect(run.stderr.split('\n')[0]).toBe(
      `monkeypatchlist: ${flag} is a scan flag: baseline update accepts the whole finding set`,
    )
  })
})

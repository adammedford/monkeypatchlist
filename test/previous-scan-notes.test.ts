// Previous-scan notes (§11 Never `changed`, §15 notes, §16 `--previous`; ADRs 0013, 0014). A difference in
// reachability or install context against a previous scan leaves a finding's state as it is, with a
// `reachability-change` or `install-context-change` note (before → after) that never trips the gate. The previous values
// come from `--previous <report.json>`, or from `--baseline` when it is a full report.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertValidReport, defaultMap, fixtureBuild, runCli, workingDir } from './support/fixture-build.ts'
import { identityMappings, mappings } from './support/source-map.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const page = '<script src="main.js"></script>'
const modulePage = '<script type="module" src="main.js"></script>'

/** A build whose entry document is `html`, with `main.js` holding `code`. */
const build = (code: string, html = page) => fixtureBuild({ 'index.html': html, 'main.js': code })

/** Runs the CLI in `cwd`, failing the test on an unexpected exit code. */
async function cli(cwd: string, argv: string[], expected = 0) {
  const run = await runCli(argv, { cwd })
  if (run.exitCode !== expected) throw new Error(`${argv.join(' ')} exited ${run.exitCode}:\n${run.stderr}`)
  return run
}

/** `monkeypatchlist scan <dir> --json - <args…>` in `cwd`: the exit code, stderr and the validated report. */
async function scan(cwd: string, dir: string, args: string[] = []) {
  const run = await runCli(['scan', dir, '--map', defaultMap, '--json', '-', ...args], { cwd })
  let report: Json = null
  if (run.stdout !== '') {
    report = JSON.parse(run.stdout)
    assertValidReport(report)
  }
  return { ...run, report }
}

/** Saves the JSON report of a scan of `dir` in `cwd` as `name`, and returns it. */
async function saveReport(cwd: string, dir: string, name: string, args: string[] = []): Promise<Json> {
  const { exitCode, stdout, stderr } = await scan(cwd, dir, args)
  if (exitCode !== 0) throw new Error(`scan exited ${exitCode}:\n${stderr}`)
  writeFileSync(join(cwd, name), stdout)
  return JSON.parse(stdout)
}

/** The finding with fingerprint `fingerprint`. */
const finding = (report: Json, fingerprint: string) =>
  report.findings.find((each: Json) => each.fingerprint === fingerprint)

const guarded = 'if (window.c) { window.fetch = a }\n'
const unguarded = 'window.fetch = a\n'
const fetchKey = 'window|Window.fetch|replace|unknown'

describe('the reachability-change note (§11 Never `changed`)', () => {
  test('a full report as --baseline supplies the previous values: a reachability change is `existing` with a note', async () => {
    const cwd = workingDir()
    const before = await saveReport(cwd, build(guarded), 'last-run.json')
    expect(finding(before, fetchKey).reachability).toBe('conditional')

    const { report } = await scan(cwd, build(unguarded), ['--baseline', 'last-run.json'])

    const fetch = finding(report, fetchKey)
    expect(fetch.reachability).toBe('unconditional')
    expect(fetch.baselineState).toBe('existing')
    expect(fetch.changedReasons).toEqual([])
    expect(fetch.notes).toEqual([{ kind: 'reachability-change', before: 'conditional', after: 'unconditional' }])
  })
})

describe('where the previous values come from (§16 `--previous`)', () => {
  test('a baseline file stores no previous values, so a reachability change gives no note without --previous', async () => {
    const cwd = workingDir()
    await cli(cwd, ['baseline', 'init', build(guarded), '--map', defaultMap])

    const { report } = await scan(cwd, build(unguarded), ['--baseline', 'monkeypatchlist.baseline.json'])

    const fetch = finding(report, fetchKey)
    expect(fetch.baselineState).toBe('existing')
    expect(fetch.notes).toEqual([])
  })

  test('--previous beside a baseline file supplies them', async () => {
    const cwd = workingDir()
    const guardedDir = build(guarded)
    await cli(cwd, ['baseline', 'init', guardedDir, '--map', defaultMap])
    await saveReport(cwd, guardedDir, 'last.json')

    const { report } = await scan(cwd, build(unguarded), ['--baseline', 'monkeypatchlist.baseline.json', '--previous', 'last.json'])

    expect(finding(report, fetchKey).notes).toEqual([
      { kind: 'reachability-change', before: 'conditional', after: 'unconditional' },
    ])
  })

  test('`previous` works as a config key, relative to the config file', async () => {
    const cwd = workingDir()
    const guardedDir = build(guarded)
    await cli(cwd, ['baseline', 'init', guardedDir, '--map', defaultMap])
    await saveReport(cwd, guardedDir, 'last.json')
    writeFileSync(
      join(cwd, 'monkeypatchlist.config.json'),
      JSON.stringify({ baseline: 'monkeypatchlist.baseline.json', previous: 'last.json' }),
    )

    const { report } = await scan(cwd, build(unguarded))

    expect(finding(report, fetchKey).notes).toEqual([
      { kind: 'reachability-change', before: 'conditional', after: 'unconditional' },
    ])
  })

  test('--previous with no --baseline gives no notes and a warning', async () => {
    const cwd = workingDir()
    await saveReport(cwd, build(guarded), 'last.json')

    const { exitCode, report, stderr } = await scan(cwd, build(unguarded), ['--previous', 'last.json'])

    expect(exitCode).toBe(0)
    const fetch = finding(report, fetchKey)
    expect(fetch.baselineState).toBeNull()
    expect(fetch.notes).toEqual([])
    expect(stderr).toContain('--previous')
    expect(stderr).toContain('warning')
  })

  test('an explicit --previous overrides a report baseline as the source of the previous values', async () => {
    const cwd = workingDir()
    await saveReport(cwd, build(guarded), 'report-A.json')
    // report-A has fetch `conditional` at load, report-B `unconditional` in a deferred callback.
    await saveReport(cwd, build('window.addEventListener("load", function () { window.fetch = a })\n'), 'report-B.json')

    const { report } = await scan(cwd, build(unguarded), [
      '--baseline',
      'report-A.json',
      '--previous',
      'report-B.json',
    ])

    expect(finding(report, fetchKey).notes).toEqual([{ kind: 'install-context-change', before: 'deferred', after: 'load' }])
  })

  test('a previous report written for another scan configuration exits 2 and names the differing fields', async () => {
    const cwd = workingDir()
    const guardedDir = build(guarded)
    await cli(cwd, ['baseline', 'init', guardedDir, '--map', defaultMap])
    await saveReport(cwd, guardedDir, 'last.json', ['--surface', 'all'])

    const { exitCode, report, stderr } = await scan(cwd, build(unguarded), [
      '--baseline',
      'monkeypatchlist.baseline.json',
      '--previous',
      'last.json',
    ])

    expect(exitCode).toBe(2)
    expect(report).toBeNull()
    expect(stderr).toContain("previous report 'last.json' was written for another scan configuration")
    expect(stderr).toContain('surface')
  })
})

describe('the install-context-change note (§11 Never `changed`)', () => {
  test('a deferred install that now runs at load is `existing`, with a note', async () => {
    const cwd = workingDir()
    await saveReport(cwd, build('export function init() { window.fetch = a }\n', modulePage), 'last-run.json')

    const { report } = await scan(cwd, build(unguarded), ['--baseline', 'last-run.json'])

    const fetch = finding(report, fetchKey)
    expect(fetch.installContext).toBe('load')
    expect(fetch.baselineState).toBe('existing')
    expect(fetch.notes).toEqual([{ kind: 'install-context-change', before: 'deferred', after: 'load' }])
  })
})

describe('the notes never affect the gate or the baseline state (§11, ADR 0014)', () => {
  test('`--fail-on added,changed` passes on a finding with both notes', async () => {
    const cwd = workingDir()
    await saveReport(cwd, build('export function init() { if (window.c) { window.fetch = a } }\n', modulePage), 'last.json')

    const { exitCode, report } = await scan(cwd, build(unguarded), ['--baseline', 'last.json', '--fail-on', 'added,changed'])

    expect(exitCode).toBe(0)
    expect(report.gate.result).toBe('pass')
    expect(report.summary.existing).toBe(1)
    const fetch = finding(report, fetchKey)
    expect(fetch.baselineState).toBe('existing')
    expect(fetch.policy).toBeNull()
    expect(fetch.notes).toEqual([
      { kind: 'reachability-change', before: 'conditional', after: 'unconditional' },
      { kind: 'install-context-change', before: 'deferred', after: 'load' },
    ])
  })
})

describe('previous values follow the baseline pairing, on `existing` and `changed` findings', () => {
  /** A build whose `main.js` is `code`, with a sidecar map putting every token in `whatwg-fetch`'s store path. */
  const packaged = (code: string) => {
    const source = 'webpack://app/./node_modules/.pnpm/whatwg-fetch@3.6.20/node_modules/whatwg-fetch/fetch.js'
    const map = { version: 3, sources: [source], sourcesContent: [code], names: [], mappings: mappings(identityMappings(code)) }
    return fixtureBuild({ 'index.html': page, 'main.js': code, 'main.js.map': JSON.stringify(map) })
  }
  const wrap = 'const o = window.fetch\nwindow.fetch = function (r) { return o(r) }\n'

  test('a `rekeyed` finding takes the previous value of the baseline entry it paired with', async () => {
    const cwd = workingDir()
    const before = build(`if (window.c) { ${wrap} }`)
    await cli(cwd, ['baseline', 'init', before, '--map', defaultMap])
    const previous = await saveReport(cwd, before, 'last.json')
    expect(finding(previous, 'window|Window.fetch|wrap|unknown').reachability).toBe('conditional')

    const { report } = await scan(cwd, packaged(wrap), ['--baseline', 'monkeypatchlist.baseline.json', '--previous', 'last.json'])

    const fetch = finding(report, 'window|Window.fetch|wrap|pkg:whatwg-fetch')
    expect(fetch.reachability).toBe('unconditional')
    expect(fetch.baselineState).toBe('existing')
    expect(fetch.matchedBy).toBe('target-key')
    expect(fetch.notes).toEqual([
      { kind: 'rekeyed', before: ['unknown'], after: 'pkg:whatwg-fetch' },
      { kind: 'reachability-change', before: 'conditional', after: 'unconditional' },
    ])
  })

  test('a `changed` finding carries the notes beside its changedReasons, and its state is unchanged', async () => {
    const cwd = workingDir()
    const unlocked = "Object.defineProperty(History.prototype, 'pushState', { value: f })"
    const locked = "Object.defineProperty(History.prototype, 'pushState', { value: f, configurable: false })"
    await saveReport(cwd, build(`export function init() { ${unlocked} }\n`, modulePage), 'last.json')

    const { exitCode, report } = await scan(cwd, build(`${locked}\n`), ['--baseline', 'last.json', '--fail-on', 'changed'])

    const pushState = finding(report, 'window|History.prototype.pushState|replace|unknown')
    expect(pushState.baselineState).toBe('changed')
    expect(pushState.changedReasons).toEqual([{ reason: 'locks', before: false, after: true }])
    expect(pushState.notes).toEqual([{ kind: 'install-context-change', before: 'deferred', after: 'load' }])
    expect(exitCode).toBe(1)
    expect(report.summary.changed).toBe(1)
  })

  test('an `added` finding gets no note', async () => {
    const cwd = workingDir()
    await saveReport(cwd, build(guarded), 'last.json')

    const { report } = await scan(cwd, build(`${unguarded}window.setTimeout = b\n`), ['--baseline', 'last.json'])

    const timeout = finding(report, 'window|Window.setTimeout|replace|unknown')
    expect(timeout.baselineState).toBe('added')
    expect(timeout.notes).toEqual([])
  })
})

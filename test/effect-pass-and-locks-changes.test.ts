// The effect pass and `locks` changes (§11 Baseline states and matching, `changed`; ADR 0014). Tests write a baseline
// with `monkeypatchlist baseline init` over one fixture build, then scan another with `monkeypatchlist scan --json -` in the same
// working directory, and assert on report fields.

import { describe, expect, test } from 'vitest'
import { assertValidReport, defaultMap, fixtureBuild, runCli, workingDir } from './support/fixture-build.ts'

const page = '<script src="main.js"></script>'
const lines = (...code: string[]) => code.join('\n')

/** A build whose `main.js` is `code`. */
const build = (code: string) => fixtureBuild({ 'index.html': page, 'main.js': code })

/** Runs `monkeypatchlist baseline <command> <build>`, which writes `monkeypatchlist.baseline.json` in `cwd`, and fails unless it exits 0. */
async function baseline(command: 'init' | 'update', cwd: string, code: string): Promise<void> {
  const run = await runCli(['baseline', command, build(code), '--map', defaultMap], { cwd })
  if (run.exitCode !== 0) throw new Error(`baseline ${command} exited ${run.exitCode}:\n${run.stderr}`)
}

/** Runs `monkeypatchlist scan <build> --baseline monkeypatchlist.baseline.json --json - <args…>` in `cwd`. */
async function scan(cwd: string, code: string, args: string[] = []) {
  const run = await runCli(
    ['scan', build(code), '--map', defaultMap, '--baseline', 'monkeypatchlist.baseline.json', '--json', '-', ...args],
    { cwd },
  )
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
  const report: any = JSON.parse(run.stdout)
  assertValidReport(report)
  return { exitCode: run.exitCode, report }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

/** Each finding as `[fingerprint, baselineState, matchedBy, changedReasons]`. */
const states = (report: { findings: Finding[] }) =>
  report.findings.map((finding: Finding) => [
    finding.fingerprint,
    finding.baselineState,
    finding.matchedBy,
    finding.changedReasons,
  ])

const replaceFetch = 'window.fetch = f'
const wrapFetch = 'const o = window.fetch; window.fetch = function(){ return o.apply(this, arguments) }'
const lockedFetch = "Object.defineProperty(window, 'fetch', { value: f, configurable: false })"
const unlockedFetch = "Object.defineProperty(window, 'fetch', { value: f })"
const undecidedFetch = "Object.defineProperty(window, 'fetch', { value: f, configurable: c })"

describe('the effect pass (§11 Baseline states and matching, step 2)', () => {
  test('`wrap` → `replace` on the same (realm, target, attribution key) is changed (effect)', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, wrapFetch)

    const { report } = await scan(cwd, replaceFetch)

    expect(states(report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'changed', 'effect', [{ reason: 'effect', before: 'wrap', after: 'replace' }]],
    ])
    expect(report.summary).toMatchObject({ added: 0, changed: 1, existing: 0, removed: 0 })
  })

  test('the comparison is symmetric: `replace` → `wrap` is changed too', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, replaceFetch)

    const { report } = await scan(cwd, wrapFetch)

    expect(states(report)).toEqual([
      ['window|Window.fetch|wrap|unknown', 'changed', 'effect', [{ reason: 'effect', before: 'replace', after: 'wrap' }]],
    ])
  })

  test('a 1:N effect ambiguity stays added and removed', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, replaceFetch)

    const { report } = await scan(cwd, lines('window.fetch = new Proxy(window.fetch, h)', "Object.defineProperty(window, 'fetch', d)"))

    expect(states(report)).toEqual([
      ['window|Window.fetch|descriptor-change|unknown', 'added', null, []],
      ['window|Window.fetch|replace|unknown', 'removed', null, []],
      ['window|Window.fetch|wrap|unknown', 'added', null, []],
    ])
  })

  test('an N:1 effect ambiguity stays added and removed', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, lines('window.fetch = new Proxy(window.fetch, h)', "Object.defineProperty(window, 'fetch', d)"))

    const { report } = await scan(cwd, replaceFetch)

    expect(states(report).map(([fingerprint, state]: string[]) => [fingerprint, state])).toEqual([
      ['window|Window.fetch|descriptor-change|unknown', 'removed'],
      ['window|Window.fetch|replace|unknown', 'added'],
      ['window|Window.fetch|wrap|unknown', 'removed'],
    ])
  })

  test('only findings and entries the exact-fingerprint pass left take part', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, lines('window.fetch = new Proxy(window.fetch, h)', "Object.defineProperty(window, 'fetch', d)"))

    const { report } = await scan(cwd, lines('window.fetch = new Proxy(window.fetch, h)', replaceFetch))

    expect(states(report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'changed', 'effect', [{ reason: 'effect', before: 'descriptor-change', after: 'replace' }]],
      ['window|Window.fetch|wrap|unknown', 'existing', 'fingerprint', []],
    ])
  })

  test('a different target or attribution key is not an effect pair', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, 'const o = window.setTimeout; window.setTimeout = function(){ return o.apply(this, arguments) }')

    const { report } = await scan(cwd, replaceFetch)

    expect(states(report).map(([fingerprint, state]: string[]) => [fingerprint, state])).toEqual([
      ['window|Window.fetch|replace|unknown', 'added'],
      ['window|Window.setTimeout|wrap|unknown', 'removed'],
    ])
  })

  test('an effect pair that also differs in locks records both reasons', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, wrapFetch)

    const { report } = await scan(cwd, lockedFetch)

    expect(states(report)).toEqual([
      [
        'window|Window.fetch|replace|unknown',
        'changed',
        'effect',
        [
          { reason: 'effect', before: 'wrap', after: 'replace' },
          { reason: 'locks', before: false, after: true },
        ],
      ],
    ])
  })
})

describe('`locks` changes (§11 `changed`)', () => {
  test('`locks` true → false is changed', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, lockedFetch)

    const { report } = await scan(cwd, unlockedFetch)

    expect(states(report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'changed', 'fingerprint', [{ reason: 'locks', before: true, after: false }]],
    ])
  })

  test('the comparison is symmetric: `locks` false → true is changed too', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, replaceFetch)

    const { report } = await scan(cwd, lockedFetch)

    expect(states(report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'changed', 'fingerprint', [{ reason: 'locks', before: false, after: true }]],
    ])
  })

  test.each([
    ['unknown → true', undecidedFetch, lockedFetch],
    ['true → unknown', lockedFetch, undecidedFetch],
    ['unknown → false', undecidedFetch, unlockedFetch],
  ])('`locks` %s is not changed', async (_, before, after) => {
    const cwd = workingDir()
    await baseline('init', cwd, before)

    const { report } = await scan(cwd, after)

    expect(states(report)).toEqual([['window|Window.fetch|replace|unknown', 'existing', 'fingerprint', []]])
  })

  test('`--fail-on changed` trips on a `locks` change', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, lockedFetch)

    const { exitCode, report } = await scan(cwd, unlockedFetch, ['--fail-on', 'changed'])

    expect(exitCode).toBe(1)
    expect(report.findings[0].policy).toEqual({ outcome: 'fail', by: 'fail-on:changed' })
  })

  test('`--fail-on changed` trips on an effect change', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, wrapFetch)

    const { exitCode, report } = await scan(cwd, replaceFetch, ['--fail-on', 'changed'])

    expect(exitCode).toBe(1)
    expect(report.findings[0].policy).toEqual({ outcome: 'fail', by: 'fail-on:changed' })
  })
})

describe('never changed (§11)', () => {
  test('a mechanism change (`=` → `defineProperty`) is existing', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, replaceFetch)

    const { report } = await scan(cwd, unlockedFetch)

    expect(states(report)).toEqual([['window|Window.fetch|replace|unknown', 'existing', 'fingerprint', []]])
  })

  test('more occurrences are existing', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, replaceFetch)

    const { report } = await scan(cwd, lines(replaceFetch, 'window.fetch = g'))

    expect(states(report)).toEqual([['window|Window.fetch|replace|unknown', 'existing', 'fingerprint', []]])
  })
})

describe('`baseline update` writes the current `locks`', () => {
  test('`true → unknown → false` across two updates never gives changed (locks)', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, lockedFetch)

    const first = await scan(cwd, undecidedFetch)
    expect(states(first.report)).toEqual([['window|Window.fetch|replace|unknown', 'existing', 'fingerprint', []]])
    await baseline('update', cwd, undecidedFetch)

    const second = await scan(cwd, unlockedFetch)
    expect(states(second.report)).toEqual([['window|Window.fetch|replace|unknown', 'existing', 'fingerprint', []]])
  })

  test('a paired entry is rewritten under its new effect and current locks, so a rescan is existing', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, wrapFetch)
    await baseline('update', cwd, lockedFetch)

    const { report } = await scan(cwd, lockedFetch)

    expect(states(report)).toEqual([['window|Window.fetch|replace|unknown', 'existing', 'fingerprint', []]])
  })
})

// Full reports as baselines (§11 Baseline, ADR 0020). `--baseline` also accepts a full scan JSON report, read
// as if `baseline update` had just been run on that scan. Tests write a baseline with `monkeypatchlist baseline init` over one
// fixture build, save the JSON report of a scan of another against it, and scan a third against that report.

import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { crashGuardMs, type Deps } from '../src/cli.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, workingDir } from './support/fixture-build.ts'
import { identityMappings, mappings } from './support/source-map.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const page = '<script src="main.js"></script>'
/** A page that also runs a remote script, which an `offline` scan skips: `complete-with-limitations` (§13). */
const remotePage = '<script src="main.js"></script><script src="https://cdn.example/lib.js"></script>'

/** A build whose entry document is `html`, with `main.js` holding `code` and any `other` files. */
const build = (html: string, code: string, other: Record<string, string> = {}) =>
  fixtureBuild({ 'index.html': html, 'main.js': code, ...other })

/** A baseline entry whose code came from the remote script `remotePage` runs (§10 Provenance). */
const remoteEntry = {
  fingerprint: 'window|Window.open|wrap|url:https://cdn.example/lib.js',
  target: { realm: 'window', holder: 'global', name: 'Window.open' },
  surface: 'navigation',
  effect: 'wrap',
  locks: false,
  attribution: { key: 'url:https://cdn.example/lib.js', provenance: 'remote' },
}

/** Runs the CLI in `cwd`, failing the test on an unexpected exit code. */
async function cli(cwd: string, argv: string[], expected = 0) {
  const run = await runCli(argv, { cwd })
  if (run.exitCode !== expected) throw new Error(`${argv.join(' ')} exited ${run.exitCode}:\n${run.stderr}`)
  return run
}

/** `monkeypatchlist baseline init` over `dir` in `cwd`, which writes `monkeypatchlist.baseline.json` there, plus any `extra` entries. */
async function baselineInit(cwd: string, dir: string, ...extra: object[]): Promise<void> {
  await cli(cwd, ['baseline', 'init', dir, '--map', defaultMap])
  const path = join(cwd, 'monkeypatchlist.baseline.json')
  const baseline = JSON.parse(readFileSync(path, 'utf8'))
  baseline.entries.push(...extra)
  writeFileSync(path, JSON.stringify(baseline, null, 2))
}

/** `monkeypatchlist scan <dir> --json - <args…>` in `cwd`: the exit code, stderr and the validated report. */
async function scan(cwd: string, dir: string, args: string[] = [], deps: Partial<Deps> = {}) {
  const run = await runCli(['scan', dir, '--map', defaultMap, '--json', '-', ...args], { cwd, deps })
  let report: Json = null
  if (run.stdout !== '') {
    report = JSON.parse(run.stdout)
    assertValidReport(report)
  }
  return { ...run, report }
}

/** Saves the JSON report of a scan of `dir` in `cwd` as `name`, and returns it. */
async function saveReport(cwd: string, dir: string, args: string[], deps: Partial<Deps> = {}): Promise<Json> {
  const { exitCode, stdout, stderr } = await scan(cwd, dir, args, deps)
  if (exitCode !== 0) throw new Error(`scan exited ${exitCode}:\n${stderr}`)
  writeFileSync(join(cwd, 'last-run.json'), stdout)
  return JSON.parse(stdout)
}

/** Each finding's fingerprint and baseline state. */
const states = (report: Json) => report.findings.map((finding: Json) => [finding.fingerprint, finding.baselineState])

describe('a report read as a baseline (§11 Baseline, ADR 0020)', () => {
  // The baseline build mutates fetch, setTimeout and setInterval, plus a remote `Window.open` entry. The report's build keeps
  // fetch, wraps setTimeout instead (`changed`, `effect`), adds clearInterval, drops setInterval (`removed`), and skips the
  // remote script, so the remote entry is `unconfirmed`. The last build keeps fetch and the wrap, drops clearInterval and
  // adds queueMicrotask.
  const first = 'window.fetch = a\nwindow.setTimeout = b\nwindow.setInterval = d\n'
  const second =
    'window.fetch = a\nconst o = window.setTimeout\nwindow.setTimeout = function (f, t) { return o(f, t) }\n' +
    'window.clearInterval = c\n'
  const third =
    'window.fetch = a\nconst o = window.setTimeout\nwindow.setTimeout = function (f, t) { return o(f, t) }\n' +
    'window.queueMicrotask = q\n'

  test('scanning against a report gives the states of `baseline update` from its scan, then a scan against the file', async () => {
    const [byReport, byUpdate] = [workingDir(), workingDir()]
    await baselineInit(byReport, build(page, first), remoteEntry)
    copyFileSync(join(byReport, 'monkeypatchlist.baseline.json'), join(byUpdate, 'monkeypatchlist.baseline.json'))
    const secondDir = build(remotePage, second)
    const thirdDir = build(page, third)

    const saved = await saveReport(byReport, secondDir, ['--baseline', 'monkeypatchlist.baseline.json'])
    expect(states(saved)).toEqual([
      ['window|Window.clearInterval|replace|unknown', 'added'],
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.open|wrap|url:https://cdn.example/lib.js', 'unconfirmed'],
      ['window|Window.setInterval|replace|unknown', 'removed'],
      ['window|Window.setTimeout|wrap|unknown', 'changed'],
    ])
    const { report: againstReport, stderr } = await scan(byReport, thirdDir, ['--baseline', 'last-run.json'])
    expect(stderr).toBe('')

    await cli(byUpdate, ['baseline', 'update', secondDir, '--map', defaultMap])
    const { report: againstFile } = await scan(byUpdate, thirdDir, ['--baseline', 'monkeypatchlist.baseline.json'])

    expect(states(againstReport)).toEqual(states(againstFile))
    expect(states(againstReport)).toEqual([
      ['window|Window.clearInterval|replace|unknown', 'removed'],
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.open|wrap|url:https://cdn.example/lib.js', 'removed'],
      ['window|Window.queueMicrotask|replace|unknown', 'added'],
      ['window|Window.setTimeout|wrap|unknown', 'existing'],
    ])
    expect(againstReport.baseline.header).toEqual(againstFile.baseline.header)
    expect(againstReport.baseline.path).toBe('last-run.json')
  })
})

describe("the report's scan configuration (§11 Baseline, §16, ADR 0017)", () => {
  test('a report written for another scan configuration exits 2, as a baseline file does', async () => {
    const cwd = workingDir()
    const dir = build(page, 'window.fetch = a\n')
    await saveReport(cwd, dir, ['--surface', 'all'])

    const { exitCode, report, stderr } = await scan(cwd, dir, ['--baseline', 'last-run.json'])

    expect(exitCode).toBe(2)
    expect(report).toBeNull()
    expect(stderr).toContain("baseline 'last-run.json' was written for another scan configuration")
    expect(stderr).toContain('surface')
  })
})

describe("the report's `packages` map (§11 `previousVersion`)", () => {
  /** A build whose `main.js` is `code`, with a sidecar map putting every token in `otel-fetch@<version>`'s store path. */
  const versioned = (code: string, version: string) => {
    const source = `webpack://app/./node_modules/.pnpm/otel-fetch@${version}/node_modules/otel-fetch/index.js`
    const map = { version: 3, sources: [source], sourcesContent: [code], names: [], mappings: mappings(identityMappings(code)) }
    return build(page, code, { 'main.js.map': JSON.stringify(map) })
  }

  test("drives the `previous-version` note: the report's version is the previous one", async () => {
    const cwd = workingDir()
    const saved = await saveReport(cwd, versioned('window.fetch = w', '0.56.1'), [])
    expect(saved.packages).toEqual({ 'otel-fetch': { version: '0.56.1', versionSource: 'store-path' } })

    const { report } = await scan(cwd, versioned('window.fetch = w', '0.57.0'), ['--baseline', 'last-run.json'])

    const [fetch] = report.findings
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|pkg:otel-fetch')
    expect(fetch.baselineState).toBe('existing')
    expect(fetch.notes).toEqual([{ kind: 'previous-version', package: 'otel-fetch', before: '0.56.1', after: '0.57.0' }])
    expect(report.baseline.header.packages).toEqual({ 'otel-fetch': { version: '0.56.1', versionSource: 'store-path' } })
  })
})

describe('an incomplete report (§11 Baseline, §13)', () => {
  /** A page that also runs `broken.js`, which doesn't parse: a `parse-failure` makes the scan `incomplete` (§13). */
  const incompletePage = '<script src="main.js"></script><script src="broken.js"></script>'
  const broken = { 'broken.js': 'window.setTimeout = (' }
  const before = 'window.fetch = a\nwindow.setTimeout = b\n'
  const after = 'window.fetch = a\n'
  /** A clock that has passed the crash guard by the time the scan asks it. */
  const fired = (): Partial<Deps> => {
    let now = 0
    return { clock: () => (now += crashGuardMs) }
  }

  /** Saves the report of an incomplete scan of the `after` build against a baseline of the `before` build, in `cwd`. */
  async function incompleteReport(cwd: string): Promise<Json> {
    await baselineInit(cwd, build(page, before))
    const saved = await saveReport(cwd, build(incompletePage, after, broken), ['--baseline', 'monkeypatchlist.baseline.json'])
    expect(saved.completeness.level).toBe('incomplete')
    expect(states(saved)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.setTimeout|replace|unknown', 'unconfirmed'],
    ])
    return saved
  }

  test('without --allow-incomplete, it is no readable baseline: under --fail-on the scan exits 2', async () => {
    const cwd = workingDir()
    await incompleteReport(cwd)

    const { exitCode, report, stderr } = await scan(cwd, build(page, after), ['--baseline', 'last-run.json', '--fail-on', 'added'])

    expect(exitCode).toBe(2)
    expect(report).toBeNull()
    expect(stderr).toContain('--fail-on needs a readable baseline')
    expect(stderr).toContain('--allow-incomplete')
  })

  test('without --allow-incomplete or --fail-on, the scan warns and findings have null baseline states', async () => {
    const cwd = workingDir()
    await incompleteReport(cwd)

    const { exitCode, report, stderr } = await scan(cwd, build(page, after), ['--baseline', 'last-run.json'])

    expect(exitCode).toBe(0)
    expect(stderr).toContain('warning: scanning without a baseline')
    expect(report.baseline).toBeNull()
    expect(states(report)).toEqual([['window|Window.fetch|replace|unknown', null]])
  })

  test('with --allow-incomplete, it reads as `baseline update --allow-incomplete` would write it', async () => {
    const [byReport, byUpdate] = [workingDir(), workingDir()]
    await incompleteReport(byReport)
    await baselineInit(byUpdate, build(page, before))
    await cli(byUpdate, ['baseline', 'update', build(incompletePage, after, broken), '--map', defaultMap, '--allow-incomplete'])
    const next = build(page, 'window.fetch = a\nwindow.clearInterval = c\n')

    const { report: againstReport, exitCode } = await scan(byReport, next, ['--baseline', 'last-run.json', '--allow-incomplete'])
    const { report: againstFile } = await scan(byUpdate, next, ['--baseline', 'monkeypatchlist.baseline.json'])

    expect(exitCode).toBe(0)
    expect(states(againstReport)).toEqual(states(againstFile))
    expect(states(againstReport)).toEqual([
      ['window|Window.clearInterval|replace|unknown', 'added'],
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.setTimeout|replace|unknown', 'removed'],
    ])
    expect(againstReport.baseline.header).toEqual(againstFile.baseline.header)
    expect(againstReport.baseline.header.completeness).toBe('incomplete')
  })

  test('a report whose crash guard fired gives back its own baseline through its unconfirmed entries', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, build(page, before))
    const original = JSON.parse(readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8'))
    const saved = await saveReport(cwd, build(page, after), ['--baseline', 'monkeypatchlist.baseline.json'], fired())
    expect(saved.completeness.counters.statistics.crashGuard).toBe('fired')
    expect(states(saved)).toEqual([
      ['window|Window.fetch|replace|unknown', 'unconfirmed'],
      ['window|Window.setTimeout|replace|unknown', 'unconfirmed'],
    ])

    const { report } = await scan(cwd, build(page, after), ['--baseline', 'last-run.json', '--allow-incomplete'])

    expect(states(report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.setTimeout|replace|unknown', 'removed'],
    ])
    delete original.entries
    expect(report.baseline.header).toEqual(original)
  })

  test.each([
    ['under --fail-on, the scan exits 2', ['--fail-on', 'added'], 2],
    ['without --fail-on, the scan warns and has no baseline', [], 0],
  ])(
    'a guard-fired report with no baseline of its own is refused even with --allow-incomplete: %s',
    async (_, args, code) => {
      const cwd = workingDir()
      const saved = await saveReport(cwd, build(page, before), [], fired())
      expect(saved.completeness.counters.statistics.crashGuard).toBe('fired')
      expect(saved.baseline).toBeNull()

      const { exitCode, report, stderr } = await scan(cwd, build(page, after), [
        '--baseline',
        'last-run.json',
        '--allow-incomplete',
        ...args,
      ])

      expect(exitCode).toBe(code)
      expect(stderr).toContain('crash guard fired')
      if (code === 0) {
        expect(report.baseline).toBeNull()
        expect(states(report)).toEqual([['window|Window.fetch|replace|unknown', null]])
      }
    },
  )
})

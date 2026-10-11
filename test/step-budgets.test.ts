// Step budgets (§18 Budgets are deterministic, §13 `analysis-budget`): each link group has a step budget of steps per
// source byte of its members. Exhausting it keeps the writes whose resolution finished inside it, byte-identical to the
// unbudgeted run's, raises `analysis-budget` naming the artifacts, and makes the scan `complete-with-limitations`. The
// budget and the caps are constants the scan's deps can replace, never a user flag.

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { defaultBudget, type Budget } from '../src/packages/analysis/index.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'
import { loadCatalog } from '../src/catalog.ts'
import { scanCorpusSite } from '../tools/corpus-scan.ts'
import { corpusDir } from '../tools/paths.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const lines = (...code: string[]) => code.join('\n')

/** a.js: a write whose holder and key need frames from a later call, between two plain writes. */
const aJs = lines(
  'window.setTimeout = function () {}',
  'function mk(o, n) { const orig = o[n]; return function () { return orig.apply(this, arguments) } }',
  "const k = 'fetch'",
  "window[k] = mk(window, 'fetch')",
  'window.setInterval = function () {}',
  'XMLHttpRequest.prototype.send = function () {}',
  'history.pushState = function () {}',
)
const build = { 'index.html': '<script src="a.js"></script>', 'a.js': aJs }

/** The budget with `stepsPerByte` steps per source byte, and the default caps. */
const perByte = (stepsPerByte: number): Budget => ({ ...defaultBudget, stepsPerByte })

async function scanWith(budget?: Budget): Promise<Report> {
  const { report } = await scanBuild(build, [], budget === undefined ? {} : { deps: { budget } })
  return report
}

/** Every occurrence of a report, as the JSON text it has there, in report order. */
const occurrences = (report: Report): string[] =>
  report.findings.flatMap((finding: Report) =>
    finding.occurrences.map((occurrence: Report) => JSON.stringify({ fingerprint: finding.fingerprint, occurrence })),
  )
const budgetRecords = (report: Report) =>
  report.completeness.limitations.filter((record: Report) => record.kind === 'analysis-budget')

describe('step budgets', () => {
  test('the default budget never fires on a small fixture, and the statistics show the steps and the budget', async () => {
    const report = await scanWith()

    expect(report.completeness.level).toBe('complete')
    expect(budgetRecords(report)).toEqual([])
    const { statistics } = report.completeness.counters
    expect(statistics.steps).toBeGreaterThan(0)
    expect(statistics.stepBudget).toBeGreaterThan(statistics.steps)
    expect(statistics.budgetExhausted).toBe(0)
    expect(statistics.limits.stepsPerByte).toBe(defaultBudget.stepsPerByte)
    expect(statistics.limits.caps).toEqual(defaultBudget.caps)
  })

  test('a budget of no steps reports no findings, raises analysis-budget naming the artifact, and leaves the scan complete-with-limitations', async () => {
    const report = await scanWith(perByte(0))

    expect(report.findings).toEqual([])
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(budgetRecords(report)).toEqual([
      expect.objectContaining({ kind: 'analysis-budget', artifact: expect.objectContaining({ url: 'https://app.example/a.js' }) }),
    ])
    expect(report.completeness.counters.statistics.budgetExhausted).toBe(1)
  })

  test('an exhausted budget keeps a prefix of the writes in walk order, each occurrence byte-identical to the full run', async () => {
    const full = await scanWith()
    const all = occurrences(full)
    expect(full.findings.map((finding: Report) => finding.target.name)).toEqual([
      'Window.fetch',
      'Window.setInterval',
      'Window.setTimeout',
      'XMLHttpRequest.prototype.send',
      'history.pushState',
    ])
    const { steps } = full.completeness.counters.statistics
    const bytes = Buffer.byteLength(aJs)

    // Budgets from none up to the full run's steps: each keeps a subset of the full run's occurrences, and a bigger
    // budget never keeps less.
    let partial = 0
    let before: string[] = []
    for (let spent = 0; spent <= steps; spent += Math.max(1, Math.floor(steps / 40))) {
      const report = await scanWith(perByte(spent / bytes))
      const kept = occurrences(report)
      for (const occurrence of kept) expect(all).toContain(occurrence)
      for (const occurrence of before) expect(kept).toContain(occurrence)
      before = kept
      if (kept.length > 0 && kept.length < all.length) {
        partial++
        expect(report.completeness.level).toBe('complete-with-limitations')
        expect(budgetRecords(report)).toHaveLength(1)
      }
    }
    expect(partial).toBeGreaterThan(0)
  })

  test('when the budget ends inside the frames of window[k] = mk(window, "fetch"), that write and every later one are dropped', async () => {
    const bytes = Buffer.byteLength(aJs)
    const names = async (spent: number) =>
      (await scanWith(perByte(spent / bytes))).findings.map((finding: Report) => finding.target.name)
    // The fewest steps that keep the first write, Window.setTimeout, and the fewest that also keep Window.fetch.
    // A bigger budget never keeps less, so a binary search finds them.
    const { steps } = (await scanWith()).completeness.counters.statistics
    const fewest = async (name: string) => {
      let [low, high] = [0, steps]
      while (low < high) {
        const middle = Math.floor((low + high) / 2)
        if ((await names(middle)).includes(name)) high = middle
        else low = middle + 1
      }
      return low
    }
    const first = await fewest('Window.setTimeout')
    const fetch = await fewest('Window.fetch')

    // Resolving `window[k] = mk(window, 'fetch')` takes many steps, through the frames of `mk`. A budget that runs out
    // anywhere in them drops that write and every one after it, and keeps the one before.
    expect(fetch - first).toBeGreaterThan(10)
    for (const spent of [first, Math.floor((first + fetch) / 2), fetch - 1]) {
      expect(await names(spent)).toEqual(['Window.setTimeout'])
    }
    expect(await names(fetch)).toEqual(['Window.fetch', 'Window.setTimeout'])
  })

  test('a budgeted scan is byte-identical across runs, however fast the clock runs', async () => {
    // Half the steps the full run takes.
    const { steps } = (await scanWith()).completeness.counters.statistics
    const budget = perByte(steps / 2 / Buffer.byteLength(aJs))
    // A clock that runs a minute per reading, short of the crash guard: no wall-clock limit changes results (§18).
    let now = 0
    const clock = () => (now += 60_000)
    const reports = [
      (await scanBuild(build, [], { deps: { budget } })).report,
      (await scanBuild(build, [], { deps: { budget } })).report,
      (await scanBuild(build, [], { deps: { budget, clock } })).report,
    ]
    expect(budgetRecords(reports[0])).toHaveLength(1)
    for (const report of reports) delete report.run
    for (const report of reports) expect(JSON.stringify(report)).toBe(JSON.stringify(reports[0]))
  })
})

describe('a missing baseline entry under an exhausted step budget (§11, §13)', () => {
  const page = '<script src="main.js"></script>'
  const dir = fixtureBuild({ 'index.html': page, 'main.js': 'window.fetch = a\nwindow.setTimeout = b\n' })
  /** A build that drops setTimeout and folds an over-long key for a write of the global object, which the fold-length cap cuts. */
  const capped = fixtureBuild({
    'index.html': page,
    'main.js': "window.fetch = a\nconst k = 'xxxxxxxx'\nwindow[k + k] = c\n",
  })

  async function run(cwd: string, argv: string[], budget?: Budget) {
    const deps = budget === undefined ? {} : { budget }
    const result = await runCli([...argv, '--map', defaultMap, '--json', '-'], { cwd, deps })
    const report = JSON.parse(result.stdout)
    assertValidReport(report)
    return { ...result, report }
  }
  const states = (report: Report) =>
    report.findings.map((finding: Report) => [finding.fingerprint, finding.baselineState])
  const baselineText = (cwd: string) => readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8')

  test('is unconfirmed, not removed, and baseline update carries it forward', async () => {
    const cwd = workingDir()
    await run(cwd, ['baseline', 'init', dir])
    const entries = JSON.parse(baselineText(cwd)).entries

    const scanned = await run(cwd, ['scan', dir, '--baseline', 'monkeypatchlist.baseline.json'], perByte(0))
    expect(scanned.report.completeness.level).toBe('complete-with-limitations')
    expect(states(scanned.report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'unconfirmed'],
      ['window|Window.setTimeout|replace|unknown', 'unconfirmed'],
    ])

    const updated = await run(cwd, ['baseline', 'update', dir], perByte(0))
    expect(updated.exitCode).toBe(0)
    expect(JSON.parse(baselineText(cwd)).entries).toEqual(entries)
  })

  test('a Principle 5 cap cut alone keeps a missing entry removed', async () => {
    const cwd = workingDir()
    await run(cwd, ['baseline', 'init', dir])

    const scanned = await run(cwd, ['scan', capped, '--baseline', 'monkeypatchlist.baseline.json'], {
      ...defaultBudget,
      caps: { ...defaultBudget.caps, foldLength: 10 },
    })
    expect(scanned.report.completeness.counters.statistics.budgetExhausted).toBe(0)
    expect(budgetRecords(scanned.report)).not.toEqual([])
    expect(states(scanned.report)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.setTimeout|replace|unknown', 'removed'],
    ])
  })
})

describe('the caps are constants the deps replace', () => {
  test('a raised cap is what the scan runs with, and shows in the statistics', async () => {
    // Twelve alternatives of one key: past an alternatives cap of 8, not past the default 16.
    const keys = Array.from({ length: 12 }, (_, index) => `c${index} ? 'k${index}' : `).join('')
    const code = `const k = ${keys}'k'\nwindow[k] = f\n`
    const build = { 'index.html': '<script src="main.js"></script>', 'main.js': code }
    const low = { ...defaultBudget, caps: { ...defaultBudget.caps, alternatives: 8 } }

    const shipped = await scanBuild(build)
    const lowered = await scanBuild(build, [], { deps: { budget: low } })

    expect(shipped.report.completeness.counters.statistics.caps.alternatives).toBeUndefined()
    expect(lowered.report.completeness.counters.statistics.caps.alternatives).toBeGreaterThan(0)
    expect(lowered.report.completeness.counters.statistics.limits.caps.alternatives).toBe(8)
  })
})

// The corpus builds are git-ignored, so a checkout without them skips this.
describe.skipIf(!existsSync(join(corpusDir, 'dist/webpack/promise-polyfill/nomaps')))('the shipped step budget never fires on the corpus (§18)', () => {
  const corpus = corpusDir

  // At `depth` 24 / `contexts` 256, webpack promise-polyfill's recursion is found provisionally once per heap instance:
  // about 14 M steps for a 4.6 KB group, past 1024 steps per byte, so `stepsPerByte` is raised instead.
  test('webpack promise-polyfill keeps its four findings, complete, inside the budget', { timeout: 300_000 }, async () => {
    const text = await scanCorpusSite(join(corpus, 'dist/webpack/promise-polyfill/nomaps'), 'all', loadCatalog())
    const report = JSON.parse(text)

    expect(report.completeness.counters.statistics.budgetExhausted).toBe(0)
    expect(budgetRecords(report)).toEqual([])
    expect(report.completeness.level).toBe('complete')
    expect(report.findings).toHaveLength(4)
  })
})

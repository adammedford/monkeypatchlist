// Completeness aggregator and counters (§13, §19 Failures are data), end to end through
// `monkeypatchlist scan --json`. The aggregator's kind → level table is in test/completeness.test.ts.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { crashGuardMs, exitCodes } from '../src/cli.ts'
import { jsResolver, type AnalyzeGroupInput, type Limitation, type Resolver } from '../src/packages/analysis/index.ts'
import { defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** The report with its `run` block, which alone holds wall-clock data (§15), blanked. */
const deterministic = (report: Json) => ({ ...report, run: null })

describe('a clean result (§13 Counters)', () => {
  test('tells "0 mutations found" apart from "0 mutations found, 2 known resources unresolved"', async () => {
    const clean = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': 'export const page = location.hash.slice(1)',
    })
    const unresolved = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': 'export const page = location.hash.slice(1)\nimport(page)\nimport(`./pages/${page}.js`)',
    })

    expect(clean.report.findings).toEqual([])
    expect(unresolved.report.findings).toEqual([])
    expect(clean.report.completeness).toMatchObject({ level: 'complete', limitations: [] })
    expect(clean.report.completeness.counters.blindSpots.unresolvedReference).toBe(0)
    expect(unresolved.report.completeness.level).toBe('complete-with-limitations')
    expect(unresolved.report.completeness.counters.blindSpots.unresolvedReference).toBe(2)
    expect(unresolved.report.completeness.limitations.map(({ kind, location }: Json) => [kind, location.line])).toEqual([
      ['unresolved-reference', 2],
      ['unresolved-reference', 3],
    ])
  })

  test('has no percentages: every number among the counters is a whole count', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script src="a.js"></script>',
        '<script src="missing.js"></script>',
        '<script src="https://cdn.example/x.js"></script>',
        '<script nomodule src="legacy.js"></script>',
        '<button onclick="go()">Go</button>',
      ].join(''),
      'a.js': 'eval(code)',
    })
    const counts: [string, unknown][] = []
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'object' && value !== null) {
        for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`)
      } else counts.push([path, value])
    }
    walk(report.completeness.counters, 'counters')
    const numbers = counts.filter(([, value]) => typeof value === 'number')

    expect(numbers.length).toBeGreaterThan(10)
    for (const [path, count] of numbers) expect(Number.isInteger(count) && (count as number) >= 0, path).toBe(true)
    // The one leaf that is no number says whether the crash guard fired.
    expect(counts.filter(([, value]) => typeof value !== 'number')).toEqual([
      ['counters.statistics.crashGuard', 'not-fired'],
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({
      known: 3,
      analyzed: 1,
      failed: { unreadable: 1 },
      skipped: { offline: 1 },
    })
    expect(report.completeness.counters.html).toEqual({ nomodule: 1, inlineHandlers: 1 })
  })
})

describe('limitation records (§13)', () => {
  const build = {
    'index.html': [
      '<script src="z.js"></script>',
      '<script src="https://cdn.example/lib.js"></script>',
      '<script src="missing.js"></script>',
      '<script type="module" src="m.js"></script>',
      '<script src="a.js"></script>',
    ].join(''),
    'z.js': 'eval(a); eval(more)',
    'm.js': 'import(specifier); eval(text)',
    'a.js': 'new Function(body)',
  }

  /** The JS resolver, returning each group's limitation records in reverse order. */
  const reversing: Resolver = {
    analyzerVersion: jsResolver.analyzerVersion,
    analyzeGroup(input: AnalyzeGroupInput) {
      const output = jsResolver.analyzeGroup(input)
      return { ...output, limitations: [...output.limitations].reverse() }
    },
  }

  test('are sorted by artifact, then location, kind and detail', async () => {
    const { report } = await scanBuild(build)

    expect(
      report.completeness.limitations.map(({ kind, artifact, location }: Json) => [
        artifact.url,
        location?.start ?? null,
        kind,
      ]),
    ).toEqual([
      ['https://app.example/a.js', 13, 'dynamic-code'],
      ['https://app.example/m.js', 7, 'unresolved-reference'],
      ['https://app.example/m.js', 24, 'dynamic-code'],
      ['https://app.example/missing.js', null, 'unreadable'],
      ['https://app.example/z.js', 5, 'dynamic-code'],
      ['https://app.example/z.js', 14, 'dynamic-code'],
      ['https://cdn.example/lib.js', null, 'offline-skipped'],
    ])
  })

  test('are in the same order, and the report byte-identical, whatever order a module returns them in', async () => {
    const first = await scanBuild(build)
    const second = await scanBuild(build, [], { deps: { resolver: reversing } })

    expect(JSON.stringify(deterministic(second.report))).toBe(JSON.stringify(deterministic(first.report)))
  })
})

describe('scan statistics (§13 Counters, §18)', () => {
  test("add up the step counts and caps of every link group, from the resolver seam's stats", async () => {
    const stats: Record<string, { steps: number; budget: number; exhausted: boolean; caps: Record<string, number> }> = {
      'https://app.example/a.js': { steps: 5, budget: 100, exhausted: false, caps: { depth: 1 } },
      'https://app.example/b.js': { steps: 7, budget: 7, exhausted: true, caps: { contexts: 2, depth: 3 } },
    }
    const resolver: Resolver = {
      analyzerVersion: jsResolver.analyzerVersion,
      analyzeGroup: (input) => ({ ...jsResolver.analyzeGroup(input), stats: stats[input.entry.url]! }),
    }

    const { report } = await scanBuild(
      { 'index.html': '<script src="b.js"></script><script src="a.js"></script>', 'a.js': 'a()', 'b.js': 'b()' },
      [],
      { deps: { resolver } },
    )

    expect(report.completeness.counters.statistics).toMatchObject({
      steps: 12,
      stepBudget: 107,
      budgetExhausted: 1,
      caps: { contexts: 2, depth: 4 },
    })
    expect(Object.keys(report.completeness.counters.statistics.caps)).toEqual(['contexts', 'depth'])
  })

  test("count the resolver's steps, the same on every run", async () => {
    const build = { 'index.html': '<script src="a.js"></script>', 'a.js': 'window.fetch = function (x) { return x }' }

    const first = await scanBuild(build)
    const second = await scanBuild(build)

    expect(first.report.completeness.counters.statistics.steps).toBeGreaterThan(0)
    expect(second.report.completeness.counters.statistics).toEqual(first.report.completeness.counters.statistics)
  })
})

describe('the wall-clock crash guard (§13, §18)', () => {
  // Groups run in URL order: a.js, then b.js.
  const build = {
    'index.html': '<script src="b.js"></script><script src="a.js"></script>',
    'a.js': 'window.fetch = f; eval(code)',
    'b.js': 'window.alert = g',
  }

  /** The JS resolver, running `after` once each group is analyzed. */
  const resolverThen = (after: () => void): Resolver => ({
    analyzerVersion: jsResolver.analyzerVersion,
    analyzeGroup(input: AnalyzeGroupInput) {
      const output = jsResolver.analyzeGroup(input)
      after()
      return output
    },
  })

  test('that fires before any link group runs makes the scan incomplete, with nothing analyzed', async () => {
    let now = 0
    const clock = () => (now += crashGuardMs)

    const { report } = await scanBuild(build, [], { deps: { clock } })

    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.counters.statistics).toMatchObject({ steps: 0, crashGuard: 'fired' })
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 2, analyzed: 0, failed: { 'crash-guard': 2 } })
    expect(report.findings).toEqual([])
    expect(report.completeness.limitations).toEqual([])
  })

  test('that fires between link groups makes the scan incomplete, and reports no findings', async () => {
    let now = 0
    const unguarded = await scanBuild(build)

    const { report } = await scanBuild(build, [], {
      deps: { clock: () => now, resolver: resolverThen(() => (now = crashGuardMs)) },
    })

    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.counters.statistics.crashGuard).toBe('fired')
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 2, analyzed: 1, failed: { 'crash-guard': 1 } })
    // a.js's group finished before the guard fired. A scan whose guard fired reports no findings (§13), so a.js's
    // finding is not reported, but its record and counts are the unguarded scan's.
    expect(unguarded.report.findings).toHaveLength(2)
    expect(report.findings).toEqual([])
    expect(report.completeness.limitations).toEqual(unguarded.report.completeness.limitations)
  })

  test('that never fires changes nothing', async () => {
    let now = 0
    const unguarded = await scanBuild(build)

    const { report } = await scanBuild(build, [], { deps: { clock: () => (now += crashGuardMs / 100) } })

    expect(report.completeness.counters.statistics.crashGuard).toBe('not-fired')
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(JSON.stringify(deterministic(report))).toBe(JSON.stringify(deterministic(unguarded.report)))
  })
})

describe('the attribution block stays separate (§13)', () => {
  test('a missing or unusable source map is not a coverage limitation', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="a.js"></script><script src="b.js"></script>',
      'a.js': 'window.fetch = f\n//# sourceMappingURL=a.js.map',
      'b.js': 'window.alert = g\n//# sourceMappingURL=b.js.map',
      'b.js.map': '{"version": 3, "sources": [], "mappings": "not a map"}',
    })

    expect(report.findings).toHaveLength(2)
    expect(report.completeness).toMatchObject({ level: 'complete', limitations: [] })
  })
})

describe('an exception inside a module (§19 Failures are data)', () => {
  const build = () =>
    fixtureBuild({
      'index.html': '<script src="a.js"></script><script src="b.js"></script><script src="https://cdn.example/c.js"></script>',
      'a.js': 'window.fetch = f',
      'b.js': 'window.alert = g',
    })

  /** The JS resolver, throwing when it is given the group of `url`. */
  const throwingAt = (url: string): Resolver => ({
    analyzerVersion: jsResolver.analyzerVersion,
    analyzeGroup(input: AnalyzeGroupInput) {
      if (input.entry.url === url) throw new Error(`resolver bug in ${url}`)
      return jsResolver.analyzeGroup(input)
    },
  })

  test('in the resolver, after a link group finished, is an internal error: exit 4, and no report is written', async () => {
    const cwd = workingDir()

    const run = await runCli(['scan', build(), '--map', defaultMap, '--json', 'report.json'], {
      cwd,
      deps: { resolver: throwingAt('https://app.example/b.js') },
    })

    expect(run.exitCode).toBe(exitCodes.internal)
    expect(run.stderr).toContain('resolver bug in https://app.example/b.js')
    expect(run.stdout).toBe('')
    expect(existsSync(join(cwd, 'report.json'))).toBe(false)
  })

  test('in the source store, reading a remote script, is an internal error, never `fetch-failed` or `offline-skipped`', async () => {
    const resolveFetcher = { fetch: async () => Promise.reject(new Error('fetcher bug')) }

    const run = await runCli(['scan', build(), '--map', defaultMap, '--mode', 'resolve', '--json', '-'], {
      deps: { resolveFetcher: () => resolveFetcher },
    })

    expect(run.exitCode).toBe(exitCodes.internal)
    expect(run.stderr).toContain('fetcher bug')
    expect(run.stdout).toBe('')
  })

  test('a limitation record of a kind outside §13 is an internal error, never a limitation', async () => {
    const resolver: Resolver = {
      analyzerVersion: jsResolver.analyzerVersion,
      analyzeGroup(input: AnalyzeGroupInput) {
        const output = jsResolver.analyzeGroup(input)
        const timeout = { kind: 'timeout', artifact: { url: input.entry.url, hash: input.entry.hash }, detail: 'slow' }
        return { ...output, limitations: [timeout as unknown as Limitation] }
      },
    }

    const run = await runCli(['scan', build(), '--map', defaultMap, '--json', '-'], { deps: { resolver } })

    expect(run.exitCode).toBe(exitCodes.internal)
    expect(run.stderr).toContain('timeout')
    expect(run.stdout).toBe('')
  })

  test('during baseline init writes no baseline', async () => {
    const cwd = workingDir()

    const run = await runCli(['baseline', 'init', build(), '--map', defaultMap], {
      cwd,
      deps: { resolver: throwingAt('https://app.example/a.js') },
    })

    expect(run.exitCode).toBe(exitCodes.internal)
    expect(existsSync(join(cwd, 'monkeypatchlist.baseline.json'))).toBe(false)
  })
})

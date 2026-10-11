// Parallel link groups (§18 Parallelism, §19 Serializable seams): link groups run one after another by default. An
// internal worker-count setting lets them run in parallel, each only while the estimated peak heaps of the groups
// running fit the memory budget, and their results merge in a fixed order, so a 1-worker and a 4-worker run print
// byte-identical reports.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { shuffledResolver } from '../src/packages/analysis/visit-order.ts'
import { schedule } from '../src/packages/parallel/index.ts'
import { corpusDir } from '../tools/paths.ts'
import { fixtureBuild, runCli, scanBuild } from './support/fixture-build.ts'

/** The report a scan prints, without its `run` block, the only part that may differ between runs (§15). */
async function reportOf(dir: string, args: string[], workers: number): Promise<string> {
  const { stdout } = await scanBuild(dir, args, { deps: { workers } })
  const report = JSON.parse(stdout)
  delete report.run
  return JSON.stringify(report)
}

/** A promise and the function that settles it, so a test decides when each group finishes. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => (resolve = settle))
  return { promise, resolve }
}

/** Lets every settled promise's callbacks run. */
const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('the link-group schedule', () => {
  test('results come back in group order, whatever order the groups finish in', async () => {
    const finish = [deferred<string>(), deferred<string>(), deferred<string>()]
    const results = schedule([{ heap: 1 }, { heap: 1 }, { heap: 1 }], { workers: 4, memoryBudget: 10 }, (index) =>
      finish[index]!.promise,
    )
    finish[2]!.resolve('c')
    await settle()
    finish[0]!.resolve('a')
    await settle()
    finish[1]!.resolve('b')
    expect(await results).toEqual(['a', 'b', 'c'])
  })

  test('a group whose estimated heap exceeds the memory left waits for memory', async () => {
    const finish = [deferred<number>(), deferred<number>(), deferred<number>()]
    const started: number[] = []
    const results = schedule([{ heap: 3 }, { heap: 3 }, { heap: 8 }], { workers: 4, memoryBudget: 10 }, (index) => {
      started.push(index)
      return finish[index]!.promise
    })
    await settle()
    // Two workers are free, but 3 + 3 + 8 doesn't fit 10.
    expect(started).toEqual([0, 1])
    finish[0]!.resolve(0)
    await settle()
    // 3 + 8 still doesn't.
    expect(started).toEqual([0, 1])
    finish[1]!.resolve(1)
    await settle()
    expect(started).toEqual([0, 1, 2])
    finish[2]!.resolve(2)
    expect(await results).toEqual([0, 1, 2])
  })

  test('a group whose estimate alone exceeds the budget runs alone', async () => {
    const started: number[] = []
    const results = await schedule([{ heap: 20 }, { heap: 1 }], { workers: 4, memoryBudget: 10 }, async (index) => {
      started.push(index)
      return index
    })
    expect(started).toEqual([0, 1])
    expect(results).toEqual([0, 1])
  })

  test('one worker runs the groups one after another', async () => {
    const finish = [deferred<number>(), deferred<number>()]
    const started: number[] = []
    const results = schedule([{ heap: 1 }, { heap: 1 }], { workers: 1, memoryBudget: 10 }, (index) => {
      started.push(index)
      return finish[index]!.promise
    })
    await settle()
    expect(started).toEqual([0])
    finish[0]!.resolve(0)
    await settle()
    expect(started).toEqual([0, 1])
    finish[1]!.resolve(1)
    expect(await results).toEqual([0, 1])
  })

  test('once the crash guard fires, no further group starts', async () => {
    let asked = 0
    const results = await schedule(
      [{ heap: 1 }, { heap: 1 }, { heap: 1 }],
      { workers: 1, memoryBudget: 10 },
      async (index) => index,
      () => ++asked < 2,
    )
    expect(results).toEqual([0, undefined, undefined])
    expect(asked).toBe(2)
  })
})

describe('1- and 4-worker scans print byte-identical reports', () => {
  test('over a build of several link groups', async () => {
    const dir = fixtureBuild({
      'index.html': [
        '<script src="a.js"></script>',
        '<script src="b.js"></script>',
        '<script type="module" src="app.mjs"></script>',
        '<script src="c.js"></script>',
      ].join(''),
      'a.js': 'window.fetch = function (u) { return u }',
      'b.js': 'XMLHttpRequest.prototype.open = function () {}; let shared = 1',
      'c.js': 'history.pushState = function () {}; Object.defineProperty(window, "onerror", { value: null })',
      'app.mjs': 'import { instrument } from "./lib.mjs"; instrument(window, "setTimeout"); import("./lazy.mjs")',
      'lib.mjs': 'export function instrument(o, n) { const f = o[n]; o[n] = function () { return f.apply(this, arguments) } }',
      'lazy.mjs': 'import { instrument } from "./lib.mjs"; instrument(EventTarget.prototype, "addEventListener")',
      'swept.js': 'delete window.queueMicrotask; Promise.prototype.then = function () {}',
      'broken.js': 'window.alert = (',
    })
    const one = await reportOf(dir, [], 1)
    expect(JSON.parse(one).findings.length).toBeGreaterThan(5)
    expect(await reportOf(dir, [], 4)).toBe(one)
  })

  test('workers run the shipped resolver, so a scan that swaps in another may not ask for them', async () => {
    const dir = fixtureBuild({ 'index.html': '<script src="a.js"></script>', 'a.js': 'window.fetch = null' })
    const run = await runCli(['scan', dir, '--map', 'https://app.example/=.', '--json', '-'], { deps: { workers: 4, resolver: shuffledResolver(1) } })
    expect(run.exitCode).toBe(4)
    expect(run.stderr).toContain('parallel link groups run only the shipped resolver')
  })

  // A subset of the validation corpus, when its builds are present: webpack chunk loaders, Vite and Rollup imports, an
  // esbuild IIFE and a vendor CDN site.
  const corpus = corpusDir
  const sites = [
    'dist/webpack/datadog/maps',
    'dist/vite/newrelic/nomaps',
    'dist/rollup/sentry-11/nomaps',
    'dist/esbuild/zonejs/maps',
    'static-sites/sentry-cdn',
  ]
  test.skipIf(!sites.every((site) => existsSync(resolve(corpus, site))))(
    'over a subset of the validation corpus',
    async () => {
      for (const site of sites) {
        const args = ['--map', 'https://app.corpus.test/=.']
        const one = await reportOf(resolve(corpus, site), args, 1)
        expect(await reportOf(resolve(corpus, site), args, 4), site).toBe(one)
      }
    },
    600_000,
  )
})

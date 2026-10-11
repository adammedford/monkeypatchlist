// A native writer a resolved call returns is an alias of it (§5 Resolver capabilities 2 and 3), checked on
// the corpus builds that showed it: core-js's es.promise.constructor calls object-set-prototype-of's
// `Object.setPrototypeOf || shim` on `Promise.prototype`. Following such a return can evaluate a call first while the
// dynamic-call index is built; a memoized value from that round that stays the code's still raises the
// `analysis-budget` cuts it met (Principle 5), as Application Insights' recursive `Sm(…)` shows. The builds are
// git-ignored, so a checkout without them skips this.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { corpusDir } from '../tools/paths.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const dist = resolve(corpusDir, 'dist')
const scan = async (build: string) => (await scanBuild(resolve(dist, build), ['--map', 'https://app.corpus.test/=.'])).report

describe.skipIf(!existsSync(resolve(dist, 'esbuild/core-js')))('the corpus core-js builds', () => {
  // Two bundlers' module links, esbuild's lazy thunks and Rollup's hoisted modules; the corpus snapshot has all four.
  test.each(['esbuild', 'rollup'])(
    "the %s build gives Promise.prototype's prototype change, beside the same block's delete of its constructor",
    async (bundler) => {
      const report = await scan(`${bundler}/core-js/nomaps`)
      const fingerprints = report.findings.map((each: Json) => each.fingerprint)

      expect(fingerprints).toEqual(
        expect.arrayContaining([
          'window|Promise.prototype.[[Prototype]]|prototype-change|unknown',
          'window|Promise.prototype.constructor|delete|unknown',
        ]),
      )
      const change = report.findings.find((each: Json) => each.target.name === 'Promise.prototype.[[Prototype]]')
      expect(change.occurrences.map((occurrence: Json) => occurrence.mechanism)).toEqual(['set-prototype'])
    },
    120_000,
  )
})

describe.skipIf(!existsSync(resolve(dist, 'vite/appinsights')))('the corpus Application Insights vite build', () => {
  test('its recursive Sm(…) call, which carries a native, still raises analysis-budget', async () => {
    const report = await scan('vite/appinsights/nomaps')

    const budget = report.completeness.limitations.filter((each: Json) => each.kind === 'analysis-budget')
    expect(budget.map((each: Json) => [each.kind, each.detail])).toEqual([
      [
        'analysis-budget',
        'the call `Sm(…)` at 2:60377 carries a native, and it recurses or lies past the call-depth cap, so its function ran in a widened frame',
      ],
    ])
  }, 120_000)
})

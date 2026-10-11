// A scan under raised caps (§18) completes. The cost benchmark's raised-budget rerun multiplied every
// cap, and a frame id that named every frame it merged and every caller grew geometrically with the chain, until the
// join in `mergedFrame` threw `RangeError: Invalid string length` on webpack es6-promise, sentry-7 and zone.js. The
// benchmark's rerun that raises `depth` and `contexts` together is the one that drives merged frames hardest.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { defaultBudget } from '../src/packages/analysis/index.ts'
import { loadCatalog } from '../src/catalog.ts'
import { reruns } from '../tools/cost-benchmark/results.ts'
import { scanCorpusSite } from '../tools/corpus-scan.ts'
import { corpusDir } from '../tools/paths.ts'
import { assertValidReport } from './support/fixture-build.ts'

const corpus = corpusDir

// The corpus builds are git-ignored, so a checkout without them skips this.
describe.skipIf(!existsSync(join(corpus, 'dist/webpack/es6-promise/maps')))('a scan with depth and contexts ×4 and the step budget ×64', () => {
  test('completes on webpack es6-promise, which crashed in mergedFrame', { timeout: 600_000 }, async () => {
    const text = await scanCorpusSite(join(corpus, 'dist/webpack/es6-promise/maps'), 'all', loadCatalog(), {
      budget: reruns(defaultBudget, 4).find((rerun) => rerun.name === 'depth+contexts')!.budget,
    })
    const report = JSON.parse(text)

    assertValidReport(report)
    expect(report.findings.length).toBeGreaterThan(0)
    expect(report.completeness.counters.statistics.limits.caps.contexts).toBe(defaultBudget.caps.contexts * 4)
  })
})

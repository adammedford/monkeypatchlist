// The cost of judging a write's call chains (§7, §18 step 1). A chain out through recursive calls meets a
// call already being judged, and that judgement held only for the walk it was in, so it was never kept: every way into
// the recursion judged it again, which grew exponentially with the recursion's size (on webpack New Relic, ×22–68 when
// the `depth` and `contexts` caps were raised together). Results stay what they were; only the steps fall.

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const lines = (...code: string[]) => code.join('\n')
const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })

/**
 * Recursive helpers g1…gN, each calling itself and the one below it from two calls, with g1 writing `window.fetch`:
 * every call out of g1 is judged through recursions, 2^N ways in.
 */
const ladder = (n: number) =>
  lines(
    `function g1(k) { if (typeof fetch !== 'undefined') { window.fetch = w } if (k) g1(k - 1) }`,
    ...Array.from(
      { length: n - 1 },
      (_, i) => `function g${i + 2}(k) { if (typeof Promise !== 'undefined') g${i + 1}(k); if (k > 1) g${i + 1}(k); if (k) g${i + 2}(k - 1) }`,
    ),
    `g${n}(3)`,
  )

const scan = async (n: number): Promise<Report> => (await scanBuild(classic(ladder(n)))).report

describe('judging call chains through a recursion', () => {
  test('costs steps that grow with the recursion, not with the ways through it', async () => {
    const small = await scan(6)
    const large = await scan(12)

    for (const report of [small, large]) {
      expect(report.findings.map((finding: Report) => finding.fingerprint)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(report.completeness.level).toBe('complete')
    }
    // Twice the helpers: about twice the steps. Judging each way in again took about 4,000× (209 M steps against 51 K
    // with no step budget), and the shipped step budget ran out before the write.
    expect(large.completeness.counters.statistics.steps).toBeLessThan(3 * small.completeness.counters.statistics.steps)
  })
})

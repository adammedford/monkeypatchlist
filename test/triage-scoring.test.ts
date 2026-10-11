// Triage of the protected surface (tools/scoring, spec §20 Scoring rules: Triage, Reachability labels). The
// scoring command reads the corpus's reachability hand sample beside its adjudications. Tests run it over small fixture
// corpora with canned reports, as test/scoring.test.ts does.

import { describe, expect, test } from 'vitest'
import {
  build,
  cannedScan,
  finding,
  fixtureCorpus,
  groundTruth,
  reachabilitySample,
  runScoring,
  scoreCorpus,
  scratchDir,
} from './support/fixture-corpus.ts'

const fetch = { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' }
const open = { target: 'XMLHttpRequest.prototype.open', holder: 'XMLHttpRequest.prototype', effect: 'wrap' }

/** A base build directory and its ground truth. */
function base(site: string): Record<string, string> {
  return { ...build(site, ''), ...groundTruth(site, [fetch, open]) }
}

describe('the reachability hand sample (§20 Reachability labels)', () => {
  test('a sampled true positive observed in the base run expects its hand label, not either of unconditional and conditional', async () => {
    const corpus = fixtureCorpus({
      ...base('webpack/datadog/maps'),
      ...reachabilitySample({ datadog: [{ target: 'Window.fetch', reachability: 'conditional' }] }),
    })

    const run = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/datadog/maps': [
          finding('Window.fetch', 'wrap', { reachability: 'unconditional' }),
          finding('XMLHttpRequest.prototype.open', 'wrap', { reachability: 'unconditional' }),
        ],
      }),
    )

    expect(run.scores.protected.libraries.datadog).toMatchObject({
      reachabilityAccuracy: 0.5,
      reachabilityErrors: { 'Window.fetch': { builds: 1, found: ['unconditional'], expected: ['conditional'] } },
    })
  })

  test('a sample label must name a true positive the base run observed, with a citation', async () => {
    const send = { target: 'XMLHttpRequest.prototype.send', holder: 'XMLHttpRequest.prototype', effect: 'wrap' }
    const corpus = fixtureCorpus({
      ...base('webpack/datadog/maps'),
      // Observed only with features on: its label is `conditional` already, and the sample is for base-run positives.
      ...build('features-on:webpack/datadog/maps', ''),
      ...groundTruth('features-on:webpack/datadog/maps', [send]),
      ...reachabilitySample({ datadog: [{ target: 'XMLHttpRequest.prototype.send', reachability: 'unconditional' }] }),
    })

    const run = await runScoring(['--corpus', corpus, '--out', scratchDir()], cannedScan({}))

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain("reachability sample: datadog 'XMLHttpRequest.prototype.send': names no positive the base run observed")
  })
})

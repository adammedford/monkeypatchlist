// Invariance and reachability scoring (tools/scoring, spec §20 Scoring rules, Bars, Identity invariance,
// Set invariance). Tests run the scoring command over small fixture corpora with canned reports, as the scoring
// harness's own tests do (test/scoring.test.ts), so they can show findings and attribution keys the resolver gives only
// on real bundles.

import { describe, expect, test } from 'vitest'
import {
  build,
  cannedScan,
  finding,
  fixtureCorpus,
  groundTruth,
  handLabels,
  scoreCorpus,
  type Mutation,
} from './support/fixture-corpus.ts'

const fetch = { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' }
const xhrOpen = { target: 'XMLHttpRequest.prototype.open', effect: 'wrap' }

/** A build directory and its ground truth, for each of `sites`. */
function builds(sites: string[], mutations: Mutation[] = [fetch]): Record<string, string> {
  return Object.assign({}, ...sites.map((site) => ({ ...build(site, ''), ...groundTruth(site, mutations) })))
}

describe('identity invariance (zero tolerance)', () => {
  test('a same-map-status attribution difference fails, listed by library, pair and target, and the command exits 1', async () => {
    const corpus = fixtureCorpus(
      builds(['webpack/sentry-11/maps', 'esbuild/sentry-11/maps', 'webpack/sentry-11/nomaps', 'esbuild/sentry-11/nomaps']),
    )

    const run = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/sentry-11/maps': [finding('Window.fetch', 'wrap', { key: 'pkg:@sentry/utils' })],
        'dist/esbuild/sentry-11/maps': [finding('Window.fetch', 'wrap', { key: 'pkg:@sentry/src' })],
        'dist/webpack/sentry-11/nomaps': [finding('Window.fetch', 'wrap')],
        'dist/esbuild/sentry-11/nomaps': [finding('Window.fetch', 'wrap')],
      }),
    )

    expect(run.exitCode).toBe(1)
    const pair = ['esbuild/sentry-11/maps', 'webpack/sentry-11/maps']
    expect(run.scores.identityInvariance).toEqual({
      pairs: 6,
      failures: 2,
      libraries: {
        'sentry-11': [
          {
            pair,
            realm: 'window',
            target: 'Window.fetch',
            check: 'fingerprint',
            first: ['window|Window.fetch|wrap|pkg:@sentry/src'],
            second: ['window|Window.fetch|wrap|pkg:@sentry/utils'],
          },
          {
            pair,
            realm: 'window',
            target: 'Window.fetch',
            check: 'changed',
            changedReasons: [{ reason: 'attribution', before: 'pkg:@sentry/src', after: 'pkg:@sentry/utils' }],
          },
        ],
      },
      exempted: {},
    })
    expect(run.scores.bars.identityInvariance).toEqual({ failures: 2, met: false })
    expect(run.table).toContain('| Identity invariance | zero failures | 2 | **no** |')
    expect(run.table).toContain(
      '| sentry-11 | esbuild/sentry-11/maps ↔ webpack/sentry-11/maps | `Window.fetch` | changed: attribution ' +
        '`pkg:@sentry/src` → `pkg:@sentry/utils` |',
    )
  })

  test('within the same map status a key may move pkg: ↔ unknown (existing + rekeyed), but not app: ↔ unknown', async () => {
    const corpus = fixtureCorpus(builds(['esbuild/datadog/maps', 'webpack/datadog/maps'], [fetch, xhrOpen]))

    const run = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/esbuild/datadog/maps': [
          finding('Window.fetch', 'wrap'),
          finding('XMLHttpRequest.prototype.open', 'wrap', { key: 'app:src/xhr.ts' }),
        ],
        'dist/webpack/datadog/maps': [
          finding('Window.fetch', 'wrap', { key: 'pkg:@datadog/browser-core' }),
          finding('XMLHttpRequest.prototype.open', 'wrap'),
        ],
      }),
    )

    expect(run.scores.identityInvariance).toEqual({
      pairs: 1,
      failures: 1,
      libraries: {
        datadog: [
          {
            pair: ['esbuild/datadog/maps', 'webpack/datadog/maps'],
            realm: 'window',
            target: 'XMLHttpRequest.prototype.open',
            check: 'fingerprint',
            first: ['window|XMLHttpRequest.prototype.open|wrap|app:src/xhr.ts'],
            second: ['window|XMLHttpRequest.prototype.open|wrap|unknown'],
          },
        ],
      },
      exempted: {},
    })
  })

  test('the esbuild composed-map cases §21 names (Sentry 7 timers keyed app:src/integrations/trycatch.ts) are exempted and listed, not failed', async () => {
    const setTimeout = { target: 'Window.setTimeout', holder: 'Window', holderKind: 'global', effect: 'wrap' }
    const corpus = fixtureCorpus(builds(['esbuild/sentry-7/maps', 'webpack/sentry-7/maps'], [setTimeout, xhrOpen]))
    const named = 'app:src/integrations/trycatch.ts'

    const run = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/esbuild/sentry-7/maps': [
          finding('Window.setTimeout', 'wrap', { key: named }),
          // Another app: key is not the case §21 names.
          finding('XMLHttpRequest.prototype.open', 'wrap', { key: 'app:src/xhr.ts' }),
        ],
        'dist/webpack/sentry-7/maps': [
          finding('Window.setTimeout', 'wrap', { key: 'pkg:sentry-browser-7' }),
          finding('XMLHttpRequest.prototype.open', 'wrap', { key: 'pkg:sentry-browser-7' }),
        ],
      }),
    )

    const pair = ['esbuild/sentry-7/maps', 'webpack/sentry-7/maps']
    const { identityInvariance: invariance } = run.scores
    expect(invariance.failures).toBe(2)
    expect(invariance.libraries['sentry-7'].map((f: { target: string; check: string }) => [f.target, f.check])).toEqual([
      ['XMLHttpRequest.prototype.open', 'fingerprint'],
      ['XMLHttpRequest.prototype.open', 'changed'],
    ])
    expect(invariance.exempted).toEqual({
      'sentry-7': [
        {
          pair,
          realm: 'window',
          target: 'Window.setTimeout',
          check: 'fingerprint',
          first: [`window|Window.setTimeout|wrap|${named}`],
          second: ['window|Window.setTimeout|wrap|pkg:sentry-browser-7'],
        },
        {
          pair,
          realm: 'window',
          target: 'Window.setTimeout',
          check: 'changed',
          changedReasons: [{ reason: 'attribution', before: named, after: 'pkg:sentry-browser-7' }],
        },
      ],
    })
    expect(run.scores.bars.identityInvariance).toEqual({ failures: 2, met: false })
    expect(run.table).toContain('2 failures; 2 exempted as esbuild composed-map cases (§21 Attribution).')
    expect(run.table).toContain(
      '| sentry-7 | esbuild/sentry-7/maps ↔ webpack/sentry-7/maps | `Window.setTimeout` | changed: attribution ' +
        `\`${named}\` → \`pkg:sentry-browser-7\` |`,
    )
  })

  test('across maps and nomaps a key may move pkg: ↔ unknown, but a different effect or locks fails, and only on protected targets both find', async () => {
    const corpus = fixtureCorpus(builds(['rollup/datadog/maps', 'rollup/datadog/nomaps', 'vite/datadog/nomaps']))

    const run = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/rollup/datadog/maps': [
          finding('Window.fetch', 'wrap', { key: 'pkg:@datadog/browser-core' }),
          // `Window.alert` is not protected, and only this build finds `XMLHttpRequest.prototype.open`.
          finding('Window.alert', 'replace', { key: 'pkg:@datadog/browser-core' }),
          finding('XMLHttpRequest.prototype.open', 'wrap', { key: 'pkg:@datadog/browser-core' }),
        ],
        'dist/rollup/datadog/nomaps': [finding('Window.fetch', 'wrap'), finding('Window.alert', 'wrap')],
        'dist/vite/datadog/nomaps': [finding('Window.fetch', 'wrap', { locks: true }), finding('Window.alert', 'wrap')],
      }),
    )

    expect(run.scores.identityInvariance).toEqual({
      pairs: 3,
      failures: 4,
      libraries: {
        datadog: [
          {
            pair: ['rollup/datadog/maps', 'vite/datadog/nomaps'],
            realm: 'window',
            target: 'Window.fetch',
            check: 'effect-locks',
            first: [{ effect: 'wrap', locks: false }],
            second: [{ effect: 'wrap', locks: true }],
          },
          {
            pair: ['rollup/datadog/maps', 'vite/datadog/nomaps'],
            realm: 'window',
            target: 'Window.fetch',
            check: 'changed',
            changedReasons: [{ reason: 'locks', before: false, after: true }],
          },
          {
            pair: ['rollup/datadog/nomaps', 'vite/datadog/nomaps'],
            realm: 'window',
            target: 'Window.fetch',
            check: 'effect-locks',
            first: [{ effect: 'wrap', locks: false }],
            second: [{ effect: 'wrap', locks: true }],
          },
          {
            pair: ['rollup/datadog/nomaps', 'vite/datadog/nomaps'],
            realm: 'window',
            target: 'Window.fetch',
            check: 'changed',
            changedReasons: [{ reason: 'locks', before: false, after: true }],
          },
        ],
      },
      exempted: {},
    })
  })

  test('variant builds and the negatives are not in the pairs, and a run with no failure exits 0', async () => {
    const corpus = fixtureCorpus({
      ...builds(['webpack/otel/maps', 'webpack/otel/nomaps', 'webpack/segment/maps', 'webpack/segment/nomaps']),
      ...builds(['features-on:webpack/otel/maps']),
    })

    const run = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/otel/maps': [finding('Window.fetch', 'wrap', { key: 'pkg:@opentelemetry/instrumentation-fetch' })],
        'dist/webpack/otel/nomaps': [finding('Window.fetch', 'wrap')],
        'variants/features-on/dist/webpack/otel/maps': [finding('Window.fetch', 'replace')],
        'dist/webpack/segment/maps': [finding('Window.fetch', 'wrap')],
        'dist/webpack/segment/nomaps': [finding('Window.fetch', 'replace')],
      }),
    )

    expect(run.exitCode).toBe(0)
    expect(run.scores.identityInvariance).toEqual({ pairs: 1, failures: 0, libraries: {}, exempted: {} })
    expect(run.scores.bars.identityInvariance).toEqual({ failures: 0, met: true })
  })
})

describe('set invariance (no bar)', () => {
  test('names every target one bundled build finds and another misses, per library and per bundler, on each slice', async () => {
    const corpus = fixtureCorpus({
      ...builds(['webpack/datadog/maps', 'webpack/datadog/nomaps', 'esbuild/datadog/maps', 'esbuild/datadog/nomaps']),
      ...builds(['features-on:esbuild/datadog/maps']),
    })

    const run = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/datadog/maps': [finding('Window.fetch', 'wrap'), finding('Window.alert', 'wrap')],
        'dist/webpack/datadog/nomaps': [finding('Window.fetch', 'wrap'), finding('Window.alert', 'wrap')],
        'dist/esbuild/datadog/maps': [finding('Window.fetch', 'wrap')],
        'dist/esbuild/datadog/nomaps': [finding('XMLHttpRequest.prototype.open', 'wrap', { realm: 'dedicated-worker' })],
        // A variant build is not one of the bundled builds compared.
        'variants/features-on/dist/esbuild/datadog/maps': [finding('XMLHttpRequest.prototype.send', 'wrap')],
      }),
    )

    expect(run.scores.setInvariance.protected).toEqual({
      datadog: {
        targets: {
          'Window.fetch': { foundBy: ['esbuild/datadog/maps', 'webpack/datadog/maps', 'webpack/datadog/nomaps'], missedBy: ['esbuild/datadog/nomaps'] },
          'dedicated-worker:XMLHttpRequest.prototype.open': {
            foundBy: ['esbuild/datadog/nomaps'],
            missedBy: ['esbuild/datadog/maps', 'webpack/datadog/maps', 'webpack/datadog/nomaps'],
          },
        },
        byBundler: {
          esbuild: ['Window.fetch', 'dedicated-worker:XMLHttpRequest.prototype.open'],
          webpack: ['dedicated-worker:XMLHttpRequest.prototype.open'],
        },
      },
    })
    expect(Object.keys(run.scores.setInvariance.all.datadog.targets)).toEqual([
      'Window.alert',
      'Window.fetch',
      'dedicated-worker:XMLHttpRequest.prototype.open',
    ])
  })
})

describe('reachability accuracy (scored per build, on true positives)', () => {
  const open = { target: 'XMLHttpRequest.prototype.open', holder: 'XMLHttpRequest.prototype', effect: 'wrap' }
  const send = { target: 'XMLHttpRequest.prototype.send', holder: 'XMLHttpRequest.prototype', effect: 'wrap' }
  const pushState = { target: 'History.prototype.pushState', holder: 'History.prototype', effect: 'wrap' }

  test('labels come from the variants, and a rule-corrected hand label beats a derived one', async () => {
    const corpus = fixtureCorpus({
      // Observed in the base run: not `guarded-native-absence`.
      ...builds(['webpack/datadog/maps', 'webpack/datadog/nomaps']),
      // Observed only with features on: `conditional`.
      ...builds(['features-on:webpack/datadog/maps'], [open]),
      // Observed only where natives were deleted: `guarded-native-absence`, but a rule-corrected hand label says
      // `conditional` for `pushState`.
      ...groundTruth('native-absent:webpack/datadog/maps.x', [send, pushState]),
      ...handLabels({
        datadog: [
          {
            target: 'History.prototype.pushState',
            effect: 'wrap',
            reachability: 'conditional',
            correction: { from: 'guarded-native-absence', citation: 'datadog@0.0.0 index.js L2' },
          },
        ],
      }),
    })
    const all = (fetch: string, xhrOpen: string, xhrSend: string, history: string) => [
      finding('Window.fetch', 'wrap', { reachability: fetch }),
      finding('XMLHttpRequest.prototype.open', 'wrap', { reachability: xhrOpen }),
      finding('XMLHttpRequest.prototype.send', 'wrap', { reachability: xhrSend }),
      finding('History.prototype.pushState', 'wrap', { reachability: history }),
    ]

    const run = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/datadog/maps': all('unconditional', 'conditional', 'guarded-native-absence', 'conditional'),
        'dist/webpack/datadog/nomaps': all('unknown', 'unconditional', 'guarded-native-absence', 'guarded-native-absence'),
      }),
    )

    const perBuild = Object.fromEntries(run.scores.perBuild.map((b: { build: string; protected: object }) => [b.build, b.protected]))
    expect(perBuild['webpack/datadog/maps']).toMatchObject({ reachabilityScored: 4, reachabilityCorrect: 4, reachabilityAccuracy: 1 })
    expect(perBuild['webpack/datadog/nomaps']).toMatchObject({ reachabilityScored: 4, reachabilityCorrect: 1, reachabilityAccuracy: 0.25 })
    expect(run.scores.protected.libraries.datadog).toMatchObject({
      reachabilityAccuracy: 0.625,
      reachabilityErrors: {
        'History.prototype.pushState': { builds: 1, found: ['guarded-native-absence'], expected: ['conditional'] },
        'Window.fetch': { builds: 1, found: ['unknown'], expected: ['conditional', 'unconditional'] },
        'XMLHttpRequest.prototype.open': { builds: 1, found: ['unconditional'], expected: ['conditional'] },
      },
    })
    expect(run.scores.protected.macro.reachabilityAccuracy).toBe(0.625)
    expect(run.scores.bars.reachabilityAccuracy).toEqual({ value: 0.625, met: false })
  })
  test('a mutation observed in Chromium is never guarded-native-absence for a guard on a feature Chromium has', async () => {
    const corpus = fixtureCorpus({
      ...builds(['webpack/whatwg-fetch/maps'], [fetch, open]),
      ...groundTruth('native-absent:webpack/whatwg-fetch/maps.fetch', [send]),
    })
    const absence = (tested: string) => [{ class: 'absence', tested, result: 'guarded-native-absence' }]

    const run = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/whatwg-fetch/maps': [
          // Chromium has `fetch`, and the base run observed the write: a violation.
          finding('Window.fetch', 'wrap', { reachability: 'guarded-native-absence', guards: absence('Window.fetch') }),
          // Chromium ships no `AudioTrack` (BCD): the label is wrong, but the rule holds.
          finding('XMLHttpRequest.prototype.open', 'wrap', {
            reachability: 'guarded-native-absence',
            guards: absence('Window.AudioTrack'),
          }),
          // Observed only where the harness deleted `fetch`: no Chromium run with every native observed it.
          finding('XMLHttpRequest.prototype.send', 'wrap', {
            reachability: 'guarded-native-absence',
            guards: absence('Window.fetch'),
          }),
        ],
      }),
    )

    expect(run.scores.protected.libraries['whatwg-fetch']).toMatchObject({
      reachabilityAccuracy: 1 / 3,
      chromiumRuleViolations: { 'Window.fetch': { builds: 1, tested: ['Window.fetch'] } },
    })
    expect(run.scores.bars.chromiumRule).toEqual({ violations: 1, met: false })
    expect(run.table).toContain('| Chromium rule | no violation | 1 | **no** |')
  })
})

describe('variance reports (no bar)', () => {
  test('reachability, install context and basis that differ between bundled builds are reported per library and target', async () => {
    const corpus = fixtureCorpus(builds(['webpack/datadog/maps', 'esbuild/datadog/maps', 'rollup/datadog/maps']))
    const fetchFinding = (reachability: string, installContext: 'load' | 'deferred', reachabilityBasis: 'call-path' | 'creation-site') =>
      finding('Window.fetch', 'wrap', { reachability, installContext, reachabilityBasis })

    const run = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/datadog/maps': [fetchFinding('unconditional', 'load', 'call-path'), finding('Window.alert', 'wrap', { reachability: 'unknown' })],
        'dist/esbuild/datadog/maps': [fetchFinding('unconditional', 'deferred', 'call-path'), finding('Window.alert', 'wrap', { reachability: 'unconditional' })],
        'dist/rollup/datadog/maps': [fetchFinding('conditional', 'load', 'creation-site')],
      }),
    )

    expect(run.scores.variance.protected).toEqual({
      datadog: {
        'Window.fetch': {
          reachability: { 'esbuild/datadog/maps': 'unconditional', 'rollup/datadog/maps': 'conditional', 'webpack/datadog/maps': 'unconditional' },
          installContext: { 'esbuild/datadog/maps': 'deferred', 'rollup/datadog/maps': 'load', 'webpack/datadog/maps': 'load' },
          reachabilityBasis: { 'esbuild/datadog/maps': 'call-path', 'rollup/datadog/maps': 'creation-site', 'webpack/datadog/maps': 'call-path' },
        },
      },
    })
    expect(run.scores.variance.all.datadog['Window.alert']).toEqual({
      reachability: { 'esbuild/datadog/maps': 'unconditional', 'webpack/datadog/maps': 'unknown' },
    })
  })
})

describe('end to end, through monkeypatchlist scan --json', () => {
  test('builds of one library that give a protected target different effects fail identity invariance, and reachability is scored', async () => {
    const replace = 'window.fetch = function () {}'
    const wrap = 'var original = window.fetch; window.fetch = function () { return original.apply(this, arguments) }'
    const corpus = fixtureCorpus({
      ...build('webpack/otel/maps', wrap),
      ...groundTruth('webpack/otel/maps', [fetch]),
      ...build('webpack/otel/nomaps', wrap),
      ...groundTruth('webpack/otel/nomaps', [fetch]),
      ...build('esbuild/otel/nomaps', replace),
      ...groundTruth('esbuild/otel/nomaps', [fetch]),
    })

    const run = await scoreCorpus(corpus)

    expect(run.exitCode).toBe(1)
    expect(run.scores.identityInvariance.pairs).toBe(3)
    expect(run.scores.identityInvariance.libraries.otel.map((f: { pair: string[]; check: string }) => [f.pair, f.check])).toEqual([
      [['esbuild/otel/nomaps', 'webpack/otel/maps'], 'effect-locks'],
      [['esbuild/otel/nomaps', 'webpack/otel/maps'], 'changed'],
      [['esbuild/otel/nomaps', 'webpack/otel/nomaps'], 'effect-locks'],
      [['esbuild/otel/nomaps', 'webpack/otel/nomaps'], 'fingerprint'],
      [['esbuild/otel/nomaps', 'webpack/otel/nomaps'], 'changed'],
    ])
    expect(run.scores.identityInvariance.libraries.otel[1].changedReasons).toEqual([
      { reason: 'effect', before: 'replace', after: 'wrap' },
    ])
    // Observed in the base run, and found `unconditional` by every build.
    expect(run.scores.protected.libraries.otel).toMatchObject({ reachabilityAccuracy: 1, reachabilityErrors: {} })
  })
})

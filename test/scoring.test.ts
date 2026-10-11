// The accuracy scoring harness (tools/scoring, spec §20 Scoring rules and Bars). Tests run the command over
// small fixture corpora. The end-to-end tests scan their fixture builds with the production `monkeypatchlist scan --json`;
// the rule tests swap in canned reports, so they can show findings the resolver can't produce yet.

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  adjudications,
  build,
  cannedScan,
  finding,
  fixtureCorpus,
  groundTruth,
  handLabels,
  runScoring,
  scoreCorpus,
  scratchDir,
} from './support/fixture-corpus.ts'

describe('end to end, through monkeypatchlist scan --json', () => {
  test('a V8 engine extension is a catalog target: Error.stackTraceLimit is scored, and its replace is right', async () => {
    const corpus = fixtureCorpus({
      ...build('webpack/sentry-11/maps', 'Error.stackTraceLimit = 50'),
      ...groundTruth('webpack/sentry-11/maps', [
        { target: 'Error.stackTraceLimit', holder: 'Error', holderKind: 'constructor', effect: 'replace' },
      ]),
    })

    const { scores } = await scoreCorpus(corpus)

    expect(scores.excludedPositives).toEqual({})
    expect(scores.all.libraries['sentry-11']).toMatchObject({
      precision: 1,
      observedRecall: 1,
      effectAccuracy: 1,
      falsePositives: {},
      effectErrors: {},
    })
  })

  test('bars are judged on the protected slice, and the whole catalog is scored beside it', async () => {
    // `Window.fetch` is protected (networking); `alert` and `confirm` are not on the protected list.
    const corpus = fixtureCorpus({
      ...build('webpack/otel/maps', 'window.fetch = function () {}; window.alert = function () {}'),
      ...groundTruth('webpack/otel/maps', [
        { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'replace' },
        { target: 'Window.confirm', holder: 'Window', holderKind: 'global', effect: 'wrap' },
      ]),
    })

    const { scores } = await scoreCorpus(corpus)

    expect(scores.protected.libraries.otel).toMatchObject({ precision: 1, observedRecall: 1 })
    expect(scores.all.libraries.otel).toMatchObject({ precision: 0.5, observedRecall: 0.5 })
  })

  test('each library is scored per build and averaged, then libraries are macro-averaged; recall per bundler too', async () => {
    const fetch = { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'replace' }
    const setTimeout = { target: 'Window.setTimeout', holder: 'Window', holderKind: 'global', effect: 'replace' }
    const corpus = fixtureCorpus({
      ...build('webpack/otel/maps', 'window.fetch = function () {}'),
      ...groundTruth('webpack/otel/maps', [fetch]),
      ...build('esbuild/otel/maps', 'var nothing = 1'),
      ...groundTruth('esbuild/otel/maps', [fetch]),
      ...build('webpack/sentry-11/maps', 'window.fetch = function () {}; window.setTimeout = function () {}'),
      ...groundTruth('webpack/sentry-11/maps', [fetch, setTimeout]),
    })

    const { scores } = await scoreCorpus(corpus)

    expect(scores.protected.libraries.otel).toMatchObject({
      builds: 2,
      precision: 1,
      observedRecall: 0.5,
      observedRecallByBundler: { esbuild: 0, webpack: 1 },
    })
    expect(scores.protected.libraries['sentry-11']).toMatchObject({
      builds: 1,
      observedRecall: 1,
      observedRecallByBundler: { webpack: 1 },
    })
    expect(scores.protected.macro).toMatchObject({
      precision: 1,
      observedRecall: 0.75,
      observedRecallByBundler: { esbuild: 0, webpack: 1 },
    })
  })

  test('hand labels join the positive set as counted relabels, and hand-labeled recall is scored apart', async () => {
    const corpus = fixtureCorpus({
      ...build('webpack/core-js/maps', 'window.Promise = function () {}'),
      ...groundTruth('webpack/core-js/maps', [{ target: 'Function.prototype.toString', effect: 'wrap' }]),
      ...handLabels({
        'core-js': [
          { target: 'Window.Promise', effect: 'replace', reachability: 'conditional' },
          { target: 'Window.queueMicrotask', effect: 'replace', reachability: 'conditional' },
        ],
      }),
    })

    const { scores } = await scoreCorpus(corpus)

    // `Window.Promise` rests on a hand label alone: a true positive only once relabels are counted.
    expect(scores.protected.libraries['core-js']).toMatchObject({
      precision: 0,
      precisionWithRelabels: 1,
      relabels: ['Window.Promise'],
      observedRecall: 0,
      handLabeledRecall: 0.5,
      handLabeledRecallByBundler: { webpack: 0.5 },
    })
    expect(scores.protected.macro).toMatchObject({ handLabeledRecall: 0.5, handLabeledRecallByBundler: { webpack: 0.5 } })
  })

  test("the exercise variants' runs are runtime-confirmed positives, and their builds are scored apart, with no bar", async () => {
    const both = 'window.fetch = function () {}; window.WebSocket = function () {}'
    const fetch = { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' }
    const webSocket = { target: 'Window.WebSocket', holder: 'Window', holderKind: 'global', effect: 'wrap' }
    const corpus = fixtureCorpus({
      ...build('webpack/datadog/maps', both),
      ...groundTruth('webpack/datadog/maps', [fetch]),
      ...build('features-on:webpack/datadog/maps', both),
      ...groundTruth('features-on:webpack/datadog/maps', [fetch, webSocket]),
    })

    const { scores } = await scoreCorpus(corpus)

    expect(scores.protected.libraries.datadog).toMatchObject({ builds: 1, precision: 1, observedRecall: 1 })
    expect(scores.variants['features-on'].protected.libraries.datadog).toMatchObject({
      builds: 1,
      precision: 1,
      observedRecall: 1,
    })
  })

  test('the negatives (Segment, OTel document-load and the control) count their findings, apart from the libraries', async () => {
    const fetch = { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'replace' }
    const corpus = fixtureCorpus({
      ...build('webpack/otel/maps', 'window.fetch = function () {}'),
      ...groundTruth('webpack/otel/maps', [fetch]),
      ...build('webpack/segment/maps', 'window.fetch = function () {}; window.alert = function () {}'),
      ...groundTruth('webpack/segment/maps', []),
      ...build('webpack/otel-document-load/nomaps', 'var quiet = 1'),
      ...groundTruth('webpack/otel-document-load/nomaps', []),
      'static-sites/control/index.html': '<!doctype html><script>window.fetch = function () {}</script>',
      'ground-truth/static/control.json': JSON.stringify({ site: 'static/control', mutations: [] }),
    })

    const { scores } = await scoreCorpus(corpus)

    expect(Object.keys(scores.protected.libraries)).toEqual(['otel'])
    expect(scores.protected.macro).toMatchObject({ precision: 1, observedRecallByBundler: { webpack: 1 } })
    expect(scores.protected.negatives).toEqual({
      control: { builds: 1, findings: 1, targets: { 'Window.fetch': 1 } },
      'otel-document-load': { builds: 1, findings: 0, targets: {} },
      segment: { builds: 1, findings: 1, targets: { 'Window.fetch': 1 } },
    })
    expect(scores.all.negatives.segment).toEqual({
      builds: 1,
      findings: 2,
      targets: { 'Window.alert': 1, 'Window.fetch': 1 },
    })
  })
})

describe('the command', () => {
  const corpusFiles = () => ({
    ...build('webpack/otel/maps', 'window.fetch = function () {}; window.alert = function () {}'),
    ...groundTruth('webpack/otel/maps', [{ target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' }]),
    ...build('esbuild/otel/nomaps', 'window.setTimeout = function () {}'),
    ...groundTruth('esbuild/otel/nomaps', [{ target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' }]),
    ...handLabels({ otel: [{ target: 'Window.queueMicrotask', effect: 'replace', reachability: 'conditional' }] }),
  })

  test('writes a machine-readable scores file and a readable table, and prints the table', async () => {
    const run = await scoreCorpus(fixtureCorpus(corpusFiles()))

    expect(run.scores.scoresVersion).toBe(1)
    expect(run.scores.tool).toMatchObject({ analyzerVersion: 'js-98', fingerprintScheme: 1 })
    expect(run.table.length).toBeGreaterThan(0)
    expect(run.stdout).toBe(run.table)
  })

  test('is deterministic: two runs give identical score files', async () => {
    const corpus = fixtureCorpus(corpusFiles())

    const first = await scoreCorpus(corpus)
    const second = await scoreCorpus(corpus)

    expect(readFileSync(join(second.out, 'scores.json'), 'utf8')).toBe(readFileSync(join(first.out, 'scores.json'), 'utf8'))
    expect(second.table).toBe(first.table)
  })

  test('writes nothing under the corpus, and refuses an output directory inside it', async () => {
    const corpus = fixtureCorpus(corpusFiles())
    const before = snapshot(corpus)

    await scoreCorpus(corpus)
    const refused = await runScoring(['--corpus', corpus, '--out', join(corpus, 'scores')])
    const dotted = await runScoring(['--corpus', corpus, '--out', join(corpus, '..scores')])

    expect(snapshot(corpus)).toEqual(before)
    expect(refused.exitCode).toBe(2)
    expect(refused.stderr).toContain('writes nothing under the corpus')
    expect(dotted.exitCode).toBe(2)
  })

  test('a build directory without ground truth is refused', async () => {
    const corpus = fixtureCorpus({ ...corpusFiles(), ...build('rollup/otel/maps', '') })

    const run = await runScoring(['--corpus', corpus, '--out', scratchDir()])

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('rollup/otel/maps has no ground truth')
  })

  test('ground truth whose build directory is missing is refused: an unbuilt corpus is never scored in part', async () => {
    const fetch = { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' }
    const base = fixtureCorpus({ ...corpusFiles(), ...groundTruth('vite/otel/nomaps', [fetch]) })
    const variant = fixtureCorpus({
      ...corpusFiles(),
      'variants/features-on/apps/otel/index.js': '',
      ...groundTruth('features-on:webpack/otel/maps', [fetch]),
    })

    const baseRun = await runScoring(['--corpus', base, '--out', scratchDir()])
    const variantRun = await runScoring(['--corpus', variant, '--out', scratchDir()])

    expect(baseRun.exitCode).toBe(2)
    expect(baseRun.stderr).toContain('ground-truth/vite/otel/nomaps.json has no build directory')
    expect(variantRun.exitCode).toBe(2)
    expect(variantRun.stderr).toContain('variants/features-on/ground-truth/webpack/otel/maps.json has no build directory')
  })
})

/** Every file under `dir`, with its contents. */
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {}
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) files[relative(dir, join(entry.parentPath, entry.name))] = readFileSync(join(entry.parentPath, entry.name), 'utf8')
  }
  return files
}

describe('the positive set and the true-positive rules (canned reports)', () => {
  test('positives are restricted to catalog targets, and symbol keys are spelled as the catalog spells them', async () => {
    const corpus = fixtureCorpus({
      ...build('webpack/core-js/maps', ''),
      ...groundTruth('webpack/core-js/maps', [
        { target: 'Array.prototype.[Symbol.iterator]', holder: 'Array.prototype', key: '[Symbol.iterator]', effect: 'replace' },
        // An interface object's `length`, which is not a target (§4).
        { target: 'Request.length', holder: 'Request', holderKind: 'constructor', effect: 'replace' },
      ]),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({ 'dist/webpack/core-js/maps': [finding('Array.prototype.@@iterator', 'replace')] }),
    )

    expect(scores.all.libraries['core-js']).toMatchObject({ precision: 1, observedRecall: 1 })
    expect(scores.excludedPositives).toEqual({ 'core-js': ['Request.length'] })
  })

  test("a hand label on a shadowing write takes its `shadows` from the catalog's prototype chain", async () => {
    const corpus = fixtureCorpus({
      ...build('webpack/datadog/maps', ''),
      ...groundTruth('webpack/datadog/maps', []),
      ...groundTruth('native-absent:webpack/datadog/maps.css-grouping-rule', [
        { target: 'CSSMediaRule.prototype.deleteRule', effect: 'wrap', shadows: 'CSSGroupingRule.prototype.deleteRule' },
      ]),
      ...handLabels({
        datadog: [
          { target: 'CSSMediaRule.prototype.deleteRule', effect: 'wrap', reachability: 'guarded-native-absence' },
          { target: 'CSSMediaRule.prototype.insertRule', effect: 'wrap', reachability: 'guarded-native-absence' },
        ],
      }),
    })
    const gna = { reachability: 'guarded-native-absence' }

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/datadog/maps': [
          finding('CSSMediaRule.prototype.deleteRule', 'wrap', { shadows: 'CSSGroupingRule.prototype.deleteRule', ...gna }),
          finding('CSSMediaRule.prototype.insertRule', 'wrap', { shadows: 'CSSGroupingRule.prototype.insertRule', ...gna }),
        ],
      }),
    )

    // `deleteRule` was observed in a native-absent run; `insertRule` rests on its hand label alone.
    expect(scores.all.libraries.datadog).toMatchObject({
      precision: 0.5,
      precisionWithRelabels: 1,
      observedRecall: 1,
      handLabeledRecall: 1,
    })
    expect(scores.excludedPositives).toEqual({})
  })

  test('shadowing writes match their entry through `shadows`, and named adds are protected on a whole entry only', async () => {
    const corpus = fixtureCorpus({
      ...build('webpack/sentry-11/maps', ''),
      ...groundTruth('webpack/sentry-11/maps', [
        // Protected: `History` is a whole entry, matched through `shadows`; `Array` is a whole entry, so a named add
        // to its prototype is covered.
        { target: 'history.pushState', holder: 'history', holderKind: 'singleton', effect: 'wrap', shadows: 'History.prototype.pushState' },
        { target: 'Array.prototype.last', effect: 'add' },
        // Not protected: `CustomElementRegistry.define` is left off the list, and `EventTarget` has member entries.
        {
          target: 'customElements.define',
          holder: 'customElements',
          holderKind: 'singleton',
          effect: 'wrap',
          shadows: 'CustomElementRegistry.prototype.define',
        },
        { target: 'EventTarget.prototype.eventListeners', effect: 'add' },
      ]),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/sentry-11/maps': [
          finding('history.pushState', 'wrap', { shadows: 'History.prototype.pushState' }),
          finding('Array.prototype.last', 'add'),
          finding('Element.prototype.attachShadow', 'wrap'),
        ],
      }),
    )

    expect(scores.protected.libraries['sentry-11']).toMatchObject({ precision: 1, observedRecall: 1 })
    expect(scores.all.libraries['sentry-11']).toMatchObject({ precision: 2 / 3, observedRecall: 0.5 })
  })

  test("a wildcard is a true positive when it matches a positive, and earns recall only for zone.js's group, covered in full", async () => {
    const zoneAdds = [
      { target: 'EventTarget.prototype.__zone_symbol__addEventListener', effect: 'add' },
      { target: 'XMLHttpRequest.prototype.__zone_symbol__send', effect: 'add' },
    ]
    const others = [
      { target: 'console.log', holder: 'console', holderKind: 'namespace', effect: 'wrap' },
      { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' },
    ]
    const found = [
      finding('EventTarget.prototype.__zone_symbol__*', 'add'),
      finding('console.*', 'wrap'),
      finding('Document.prototype.*', 'wrap'),
      finding('Window.fetch', 'wrap'),
    ]
    const corpus = fixtureCorpus({
      ...build('webpack/zonejs/maps', ''),
      ...groundTruth('webpack/zonejs/maps', [...zoneAdds, ...others]),
      ...build('webpack/zonejs/nomaps', ''),
      ...groundTruth('webpack/zonejs/nomaps', [...zoneAdds, ...others]),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/zonejs/maps': found,
        'dist/webpack/zonejs/nomaps': [...found, finding('XMLHttpRequest.prototype.__zone_symbol__*', 'add')],
      }),
    )

    // Whole catalog. maps: `Document.prototype.*` matches nothing (precision 3/4); recall units are the group (half
    // covered), `console.log` (a wildcard earns it nothing) and `Window.fetch`. nomaps covers the group in full.
    expect(scores.all.libraries.zonejs).toMatchObject({ precision: (3 / 4 + 4 / 5) / 2, observedRecall: (1 / 3 + 2 / 3) / 2 })
    // Protected: the group and the pattern wildcards are outside it, and so is `Document.prototype.*`.
    expect(scores.protected.libraries.zonejs).toMatchObject({ precision: 1, observedRecall: 0.5 })
  })

  test('a pattern wildcard written in brackets matches the positives on its holder whose key starts with its prefix', async () => {
    const hidden = { target: 'Object.prototype["__core.hidden.x"]', holder: 'Object.prototype', key: '__core.hidden.x', effect: 'add' }
    const corpus = fixtureCorpus({
      ...build('webpack/core-js/maps', ''),
      ...groundTruth('webpack/core-js/maps', [hidden]),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/core-js/maps': [
          finding('Object.prototype["__core.hidden."]*', 'add'),
          finding('Object.prototype["__core.other."]*', 'add'),
        ],
      }),
    )

    expect(scores.all.libraries['core-js'].falsePositives).toEqual({ 'Object.prototype["__core.other."]*': expect.anything() })
  })

  test('a finding that can only run where a native is missing is a true positive when tagged guarded-native-absence or conditional', async () => {
    const promise = { target: 'Window.Promise', holder: 'Window', holderKind: 'global', effect: 'replace' }
    const corpus = fixtureCorpus({
      // Hand-labeled `guarded-native-absence`.
      ...build('webpack/whatwg-fetch/maps', ''),
      ...groundTruth('webpack/whatwg-fetch/maps', []),
      ...build('webpack/whatwg-fetch/nomaps', ''),
      ...groundTruth('webpack/whatwg-fetch/nomaps', []),
      // Observed only where the harness deleted the native.
      ...build('webpack/core-js/maps', ''),
      ...groundTruth('webpack/core-js/maps', []),
      ...groundTruth('native-absent:webpack/core-js/maps.promise', [
        promise,
        { target: 'Promise.allSettled', holder: 'Promise', holderKind: 'constructor', effect: 'replace' },
      ]),
      // Observed only without the native, but a rule-corrected hand label says `conditional`: it can replace a native
      // that exists.
      ...build('webpack/es6-promise/maps', ''),
      ...groundTruth('webpack/es6-promise/maps', []),
      ...groundTruth('native-absent:webpack/es6-promise/maps.constructor', [promise]),
      ...handLabels({
        'whatwg-fetch': [{ target: 'Window.fetch', effect: 'replace', reachability: 'guarded-native-absence' }],
        'es6-promise': [{ target: 'Window.Promise', effect: 'replace', reachability: 'conditional' }],
      }),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/whatwg-fetch/maps': [finding('Window.fetch', 'replace')],
        'dist/webpack/whatwg-fetch/nomaps': [finding('Window.fetch', 'replace', { reachability: 'guarded-native-absence' })],
        'dist/webpack/core-js/maps': [
          finding('Window.Promise', 'replace', { reachability: 'conditional' }),
          finding('Promise.allSettled', 'replace', { reachability: 'unconditional' }),
        ],
        'dist/webpack/es6-promise/maps': [finding('Window.Promise', 'replace')],
      }),
    )

    const libraries = scores.protected.libraries
    expect(libraries['whatwg-fetch']).toMatchObject({
      precision: 0,
      precisionWithRelabels: 0.5,
      handLabeledRecall: 0.5,
      observedRecall: null,
    })
    expect(libraries['core-js']).toMatchObject({ precision: 0.5, observedRecall: 0.5 })
    expect(libraries['es6-promise']).toMatchObject({ precision: 1, observedRecall: 1, handLabeledRecall: 1 })
  })

  test("a singleton's wildcard is protected through its whole entry or its covered members, and document.* and performance.* are not", async () => {
    const corpus = fixtureCorpus({
      ...build('webpack/sentry-11/maps', ''),
      ...groundTruth('webpack/sentry-11/maps', [{ target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' }]),
    })
    const wildcards = [
      'history.*',
      'localStorage.*',
      'sessionStorage.*',
      'crypto.*',
      'crypto.subtle.*',
      'navigator.serviceWorker.*',
      'navigator.*',
      'document.*',
      'performance.*',
      'navigator.geolocation.*',
    ]

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/sentry-11/maps': [finding('Window.fetch', 'wrap'), ...wildcards.map((name) => finding(name, 'wrap'))],
      }),
    )

    // Seven wildcards match nothing and are in the slice; the last three are outside it (§12).
    expect(scores.protected.libraries['sentry-11']).toMatchObject({ precision: 1 / 8, observedRecall: 1 })
    expect(Object.keys(scores.protected.libraries['sentry-11'].falsePositives).sort()).toEqual(wildcards.slice(0, 7).sort())
  })

  test('a prototype-change matches under either spelling of its holder, and is protected on a whole entry', async () => {
    const truth = [{ target: 'Promise.prototype.[[Prototype]]', holder: 'Promise.prototype', key: '[[Prototype]]', effect: 'prototype-change' }]
    const corpus = fixtureCorpus({
      ...build('webpack/core-js/maps', ''),
      ...groundTruth('webpack/core-js/maps', []),
      ...build('webpack/core-js/nomaps', ''),
      ...groundTruth('webpack/core-js/nomaps', []),
      ...groundTruth('features-on:webpack/core-js/maps', truth),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/core-js/maps': [finding('Promise.prototype.[[Prototype]]', 'prototype-change')],
        'dist/webpack/core-js/nomaps': [finding('Promise.prototype', 'prototype-change')],
      }),
    )

    expect(scores.protected.libraries['core-js']).toMatchObject({ precision: 1, observedRecall: 1, effectAccuracy: 1 })
  })

  test('findings outside the window realm are counted per build, not scored: the corpus snapshots only the window', async () => {
    const corpus = fixtureCorpus({ ...build('webpack/sentry-11/maps', ''), ...groundTruth('webpack/sentry-11/maps', []) })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/sentry-11/maps': [finding('DedicatedWorkerGlobalScope.fetch', 'wrap', { realm: 'dedicated-worker' })],
      }),
    )

    expect(scores.perBuild).toEqual([
      expect.objectContaining({ build: 'webpack/sentry-11/maps', unscoredFindings: 1 }),
    ])
    expect(scores.protected.libraries['sentry-11']).toMatchObject({ precision: null })
  })

  test('a negative counts its protected findings in every realm: it needs no ground truth', async () => {
    const corpus = fixtureCorpus({
      'static-sites/control/index.html': '<!doctype html>',
      'ground-truth/static/control.json': JSON.stringify({ site: 'static/control', mutations: [] }),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'static-sites/control': [finding('WorkerGlobalScope.prototype.fetch', 'wrap', { realm: 'dedicated-worker' })],
      }),
    )

    expect(scores.protected.negatives.control).toEqual({
      builds: 1,
      findings: 1,
      targets: { 'dedicated-worker:WorkerGlobalScope.prototype.fetch': 1 },
    })
    expect(scores.bars.negatives).toEqual({ findings: 1, met: false })
  })

  test('protected recall counts only the findings the protected slice keeps', async () => {
    // A named add to a whole entry is protected. A finding that calls it a `replace` of a member the catalog doesn't
    // list is outside the slice, so it recalls nothing there.
    const corpus = fixtureCorpus({
      ...build('webpack/core-js/maps', ''),
      ...groundTruth('webpack/core-js/maps', [{ target: 'Array.prototype.last', effect: 'add' }]),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({ 'dist/webpack/core-js/maps': [finding('Array.prototype.last', 'replace')] }),
    )

    expect(scores.protected.libraries['core-js']).toMatchObject({ precision: null, observedRecall: 0 })
    expect(scores.all.libraries['core-js']).toMatchObject({ precision: 1, observedRecall: 1, effectAccuracy: 0 })
  })
})

describe('effect accuracy, relabels, the headline set and the bars (canned reports)', () => {
  test("effect accuracy is scored on true positives: a target's findings must all have its effect", async () => {
    const corpus = fixtureCorpus({
      ...build('webpack/sentry-11/maps', ''),
      ...groundTruth('webpack/sentry-11/maps', [
        { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' },
        { target: 'XMLHttpRequest.prototype.open', effect: 'wrap' },
        { target: 'XMLHttpRequest.prototype.send', effect: 'wrap' },
      ]),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/sentry-11/maps': [
          finding('Window.fetch', 'wrap'),
          finding('XMLHttpRequest.prototype.open', 'replace'),
          finding('XMLHttpRequest.prototype.send', 'wrap'),
          finding('XMLHttpRequest.prototype.send', 'replace'),
        ],
      }),
    )

    expect(scores.protected.libraries['sentry-11']).toMatchObject({ precision: 1, effectAccuracy: 1 / 3 })
    expect(scores.protected.macro).toMatchObject({ effectAccuracy: 1 / 3 })
  })

  test('precision is reported twice, and cited relabels from the adjudications file are counted', async () => {
    const corpus = fixtureCorpus({
      ...build('webpack/core-js/maps', ''),
      ...groundTruth('webpack/core-js/maps', [{ target: 'Function.prototype.toString', effect: 'wrap' }]),
      ...adjudications({
        'core-js': [
          { target: 'Array.prototype.at', disagreement: 'false-positive', class: 'unobserved-real' },
          { target: 'Window.Promise', disagreement: 'false-positive', class: 'resolver-defect' },
          { target: 'Window.queueMicrotask', disagreement: 'false-negative', class: 'beyond-model' },
        ],
      }),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/core-js/maps': [
          finding('Function.prototype.toString', 'wrap'),
          finding('Array.prototype.at', 'replace'),
          finding('Array.prototype.flat', 'replace'),
          finding('Window.Promise', 'replace'),
        ],
      }),
    )

    expect(scores.protected.libraries['core-js']).toMatchObject({
      precision: 1 / 4,
      precisionWithRelabels: 2 / 4,
      relabels: ['Array.prototype.at'],
      falsePositives: {
        'Array.prototype.at': { builds: 1, class: 'unobserved-real' },
        'Array.prototype.flat': { builds: 1, class: null },
        'Window.Promise': { builds: 1, class: 'resolver-defect' },
      },
    })
    expect(scores.protected.macro).toMatchObject({ precision: 1 / 4, precisionWithRelabels: 2 / 4, relabels: 1 })
  })

  test('misses and effect errors are listed per library, with the triage class of each adjudicated miss', async () => {
    const truth = [
      { target: 'Function.prototype.toString', effect: 'wrap' },
      { target: 'Window.setTimeout', holder: 'Window', holderKind: 'global', effect: 'wrap' },
    ]
    const corpus = fixtureCorpus({
      ...build('webpack/core-js/maps', ''),
      ...groundTruth('webpack/core-js/maps', truth),
      ...build('webpack/core-js/nomaps', ''),
      ...groundTruth('webpack/core-js/nomaps', truth),
      ...handLabels({ 'core-js': [{ target: 'Window.queueMicrotask', effect: 'replace', reachability: 'conditional' }] }),
      ...adjudications({
        'core-js': [{ target: 'Window.queueMicrotask', disagreement: 'false-negative', class: 'beyond-model' }],
      }),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/core-js/maps': [finding('Function.prototype.toString', 'replace')],
        'dist/webpack/core-js/nomaps': [finding('Function.prototype.toString', 'wrap'), finding('Window.setTimeout', 'wrap')],
      }),
    )

    expect(scores.protected.libraries['core-js']).toMatchObject({
      observedMisses: { 'Window.setTimeout': { builds: 1, class: null } },
      handLabeledMisses: { 'Window.queueMicrotask': { builds: 2, class: 'beyond-model' } },
      effectErrors: { 'Function.prototype.toString': { builds: 1, found: ['replace'], expected: ['wrap'] } },
    })
  })

  test('the bars are judged on the protected slice, and micro totals are reported for information', async () => {
    const fetch = { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' }
    const corpus = fixtureCorpus({
      ...build('webpack/otel/maps', ''),
      ...groundTruth('webpack/otel/maps', [fetch]),
      ...build('esbuild/otel/maps', ''),
      ...groundTruth('esbuild/otel/maps', [fetch]),
      ...build('webpack/whatwg-fetch/maps', ''),
      ...groundTruth('webpack/whatwg-fetch/maps', []),
      ...handLabels({ 'whatwg-fetch': [{ target: 'Window.fetch', effect: 'replace', reachability: 'guarded-native-absence' }] }),
      ...build('webpack/segment/maps', ''),
      ...groundTruth('webpack/segment/maps', []),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/otel/maps': [finding('Window.fetch', 'wrap')],
        'dist/webpack/whatwg-fetch/maps': [finding('Window.fetch', 'replace', { reachability: 'guarded-native-absence' })],
        'dist/webpack/segment/maps': [finding('Window.fetch', 'wrap')],
      }),
    )

    expect(scores.bars).toEqual({
      precision: { value: 1, minLibrary: 1, met: true },
      observedRecall: { byBundler: { esbuild: 0, webpack: 1 }, met: false },
      handLabeledRecall: { value: 1, met: true },
      headline: { value: 0.5, met: false },
      effectAccuracy: { value: 1, met: true },
      // otel's canned `Window.fetch` reports no reachability; whatwg-fetch's matches its hand label.
      reachabilityAccuracy: { value: 0.5, met: false },
      negatives: { findings: 1, met: false },
      chromiumRule: { violations: 0, met: true },
      identityInvariance: { failures: 0, met: true },
    })
    // whatwg-fetch's `Window.fetch` rests on a hand label: runtime-confirmed only, it isn't a true positive.
    expect(scores.protected.micro).toEqual({
      findings: 2,
      truePositives: 1,
      truePositivesWithRelabels: 2,
      precision: 0.5,
      precisionWithRelabels: 1,
      observedPositives: 2,
      observedHits: 1,
      observedRecall: 0.5,
      handLabeledPositives: 1,
      handLabeledHits: 1,
      handLabeledRecall: 1,
      effectScored: 2,
      effectCorrect: 2,
      effectAccuracy: 1,
      reachabilityScored: 2,
      reachabilityCorrect: 1,
      reachabilityAccuracy: 0.5,
      chromiumRuleViolations: 0,
    })
  })

  test.each([
    ['no citation', { citation: '' }, "core-js 'Array.prototype.at': an adjudication needs a citation"],
    ['an unknown class', { class: 'probably-fine' }, "core-js 'Array.prototype.at': unknown class 'probably-fine'"],
  ])('an adjudication with %s is refused', async (_, change, message) => {
    const entry = { target: 'Array.prototype.at', disagreement: 'false-positive', class: 'unobserved-real', ...change }
    const corpus = fixtureCorpus({
      ...build('webpack/core-js/maps', ''),
      ...groundTruth('webpack/core-js/maps', []),
      'labels/adjudications.json': JSON.stringify({ 'core-js': [{ citation: 'core-js@3.50.0 x.js L1', ...entry }] }),
    })

    const run = await runScoring(['--corpus', corpus, '--out', scratchDir()], cannedScan({}))

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain(message)
  })

  test('two adjudications of one disagreement are refused: each gets exactly one class', async () => {
    const entry = { target: 'Array.prototype.at', disagreement: 'false-positive' as const }
    const corpus = fixtureCorpus({
      ...build('webpack/core-js/maps', ''),
      ...groundTruth('webpack/core-js/maps', []),
      ...adjudications({
        'core-js': [
          { ...entry, class: 'unobserved-real' },
          { ...entry, class: 'resolver-defect' },
        ],
      }),
    })

    const run = await runScoring(['--corpus', corpus, '--out', scratchDir()], cannedScan({}))

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain("core-js 'Array.prototype.at': false-positive is adjudicated twice")
  })

  test('the headline set is scored for Sentry, Datadog and OTel, and never for Application Insights', async () => {
    const fetch = { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' }
    const open = { target: 'XMLHttpRequest.prototype.open', effect: 'wrap' }
    const history = (member: string) => ({
      target: `history.${member}`,
      holder: 'history',
      holderKind: 'singleton',
      effect: 'wrap',
      shadows: `History.prototype.${member}`,
    })
    const corpus = fixtureCorpus({
      ...build('webpack/sentry-11/maps', ''),
      ...groundTruth('webpack/sentry-11/maps', [
        fetch,
        open,
        { target: 'XMLHttpRequest.prototype.send', effect: 'wrap' },
        history('pushState'),
        history('replaceState'),
      ]),
      // Only the headline targets in its positive set count.
      ...build('webpack/otel/maps', ''),
      ...groundTruth('webpack/otel/maps', [open]),
      // §20 excludes Application Insights' `fetch` and `history` from the headline set.
      ...build('webpack/appinsights/maps', ''),
      ...groundTruth('webpack/appinsights/maps', [fetch, { target: 'History.prototype.pushState', effect: 'wrap' }]),
    })

    const { scores } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/sentry-11/maps': [
          finding('Window.fetch', 'wrap'),
          finding('XMLHttpRequest.prototype.open', 'wrap'),
          finding('XMLHttpRequest.prototype.send', 'wrap'),
          finding('history.pushState', 'wrap', { shadows: 'History.prototype.pushState' }),
        ],
        'dist/webpack/otel/maps': [finding('XMLHttpRequest.prototype.open', 'wrap')],
      }),
    )

    const libraries = scores.protected.libraries
    expect(libraries['sentry-11']).toMatchObject({ headline: 0.8, headlineMisses: { 'History.prototype.replaceState': 1 } })
    expect(libraries.otel).toMatchObject({ headline: 1, headlineMisses: {} })
    expect(libraries.appinsights).toMatchObject({ headline: null, headlineMisses: {} })
    expect(scores.protected.macro.headline).toBe(0.9)
  })
})

describe('idiom conformance (§6)', () => {
  test("the module-linking idioms are summarized per bundler and per CDN bundle, from each base build's artifacts", async () => {
    const esbuildMain = readFileSync('test/fixtures/module-link-idioms/esbuild/main.js', 'utf8')
    const corpus = fixtureCorpus({
      ...build('esbuild/otel/maps', esbuildMain),
      ...groundTruth('esbuild/otel/maps', []),
      ...build('esbuild/otel/nomaps', 'window.fetch = function () {}'),
      ...groundTruth('esbuild/otel/nomaps', []),
      ...build('webpack/otel/maps', 'window.fetch = function () {}'),
      ...groundTruth('webpack/otel/maps', []),
    })

    const { scores, table } = await scoreCorpus(corpus)

    // Each idiom counts the builds whose artifacts link through it; modules and unlinked calls are summed.
    expect(scores.idioms).toEqual({
      esbuild: { builds: 2, idioms: { 'getter-export': 1, interop: 1, 'lazy-thunk': 1 }, modules: 4, unlinked: 0 },
      webpack: { builds: 1, idioms: {}, modules: 0, unlinked: 0 },
    })
    expect(table).toContain('Module-linking idioms')
  })
})

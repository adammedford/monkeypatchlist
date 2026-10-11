// The vendor CDN sites in the scoring harness (tools/scoring; §20 Validation corpus, Identity invariance,
// Set invariance). The 4 CDN sites are scored as sites of their libraries, their remote scripts served from the
// corpus's `vendor/` copies by the fixture fetcher, and the CDN ↔ bundled differences are reported with set invariance.

import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { build, cannedScan, finding, fixtureCorpus, groundTruth, scoreCorpus, type Mutation } from './support/fixture-corpus.ts'

const fetch: Mutation = { target: 'Window.fetch', holder: 'Window', holderKind: 'global', effect: 'wrap' }
const open: Mutation = { target: 'XMLHttpRequest.prototype.open', effect: 'wrap' }

/** A CDN site whose page loads `url`, with its ground truth. */
function cdnSite(site: string, url: string, mutations: Mutation[]): Record<string, string> {
  return {
    [`static-sites/${site}/index.html`]: `<!doctype html><script src="${url}"></script>`,
    ...groundTruth(`static/${site}`, mutations),
  }
}

/** `vendor/`: each URL's pinned copy, with `sources.json` mapping the URL to its file and sha256. */
function vendor(files: Record<string, { file: string; body: string; sha256?: string }>): Record<string, string> {
  const sources = Object.fromEntries(
    Object.entries(files).map(([url, { file, body, sha256 }]) => [
      url,
      { file, sha256: sha256 ?? createHash('sha256').update(body).digest('hex') },
    ]),
  )
  return {
    'vendor/sources.json': JSON.stringify(sources, null, 1),
    ...Object.fromEntries(Object.values(files).map(({ file, body }) => [`vendor/${file}`, body])),
  }
}

const rumUrl = 'https://cdn.vendor.example/v7/rum.js'

describe('the CDN sites are scored as sites of their libraries', () => {
  test('a CDN site is scanned in `resolve` mode with its remote scripts served from `vendor/`, and scored', async () => {
    const corpus = fixtureCorpus({
      ...cdnSite('datadog-cdn', rumUrl, [fetch]),
      ...vendor({ [rumUrl]: { file: 'rum.js', body: 'window.fetch = (f => function () { return f.apply(this, arguments) })(window.fetch)' } }),
    })

    const { scores } = await scoreCorpus(corpus)

    expect(scores.perBuild).toEqual([
      expect.objectContaining({ build: 'static/datadog-cdn', set: 'base', library: 'datadog', bundler: 'cdn' }),
    ])
    expect(scores.all.libraries.datadog.observedRecall).toBe(1)
    expect(scores.all.libraries.datadog.precision).toBe(1)
  })

  test('a vendored copy whose sha256 differs from `sources.json` is refused (exit 2)', async () => {
    const corpus = fixtureCorpus({
      ...cdnSite('datadog-cdn', rumUrl, [fetch]),
      ...vendor({ [rumUrl]: { file: 'rum.js', body: 'window.fetch = 1', sha256: '0'.repeat(64) } }),
    })

    await expect(scoreCorpus(corpus)).rejects.toThrow(/sha256/)
  })
})

describe('CDN ↔ bundled differences are reported with set invariance', () => {
  test('each target the CDN site and a bundled build disagree on is named, and the CDN site is in no identity pair', async () => {
    const corpus = fixtureCorpus({
      ...build('webpack/newrelic/maps', ''),
      ...groundTruth('webpack/newrelic/maps', [fetch, open]),
      ...build('rollup/newrelic/maps', ''),
      ...groundTruth('rollup/newrelic/maps', [fetch, open]),
      ...cdnSite('newrelic-cdn', 'https://js-agent.example/loader.js', [fetch, open]),
    })

    const { scores, table } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/newrelic/maps': [finding('Window.fetch', 'wrap'), finding('XMLHttpRequest.prototype.open', 'wrap')],
        'dist/rollup/newrelic/maps': [finding('Window.fetch', 'wrap')],
        'static-sites/newrelic-cdn': [finding('Window.fetch', 'wrap'), finding('XMLHttpRequest.prototype.open', 'wrap')],
      }),
    )

    expect(scores.identityInvariance.pairs).toBe(1)
    // Among the bundled builds alone, rollup misses `open`, and the CDN site isn't one of them.
    expect(scores.setInvariance.all.newrelic.targets).toEqual({
      'XMLHttpRequest.prototype.open': { foundBy: ['webpack/newrelic/maps'], missedBy: ['rollup/newrelic/maps'] },
    })
    expect(scores.setInvariance.cdn.all).toEqual({
      newrelic: {
        cdn: 'static/newrelic-cdn',
        targets: { 'XMLHttpRequest.prototype.open': { foundBy: ['static/newrelic-cdn', 'webpack/newrelic/maps'], missedBy: ['rollup/newrelic/maps'] } },
      },
    })
    expect(scores.setInvariance.cdn.protected.newrelic.targets).toEqual(scores.setInvariance.cdn.all.newrelic.targets)
    expect(table).toContain('## CDN ↔ bundled differences (protected surface, no bar)')
    expect(table).toContain(
      '| newrelic | `XMLHttpRequest.prototype.open` | static/newrelic-cdn, webpack/newrelic/maps | rollup/newrelic/maps |',
    )
  })

  test('a CDN site that finds what every bundled build finds has no differences', async () => {
    const corpus = fixtureCorpus({
      ...build('webpack/newrelic/maps', ''),
      ...groundTruth('webpack/newrelic/maps', [fetch]),
      ...cdnSite('newrelic-cdn', 'https://js-agent.example/loader.js', [fetch]),
    })

    const { scores, table } = await scoreCorpus(
      corpus,
      cannedScan({
        'dist/webpack/newrelic/maps': [finding('Window.fetch', 'wrap')],
        'static-sites/newrelic-cdn': [finding('Window.fetch', 'wrap')],
      }),
    )

    expect(scores.setInvariance.cdn).toEqual({ protected: {}, all: {} })
    expect(table).toContain('Each CDN site finds the same targets as every bundled build of its library.')
  })
})

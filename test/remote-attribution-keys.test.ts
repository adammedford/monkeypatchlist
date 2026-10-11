// Remote attribution keys and URL normalization (§11 Attribution keys, Remote URL normalization; §10
// Provenance; §17). Scans run end to end through `monkeypatchlist scan --json -` in `--mode resolve`, with the fixture
// fetcher swapped in as the CLI's resolve fetcher.

import { describe, expect, test } from 'vitest'
import type { Fetcher } from '../src/packages/source-store/index.ts'
import { fixtureFetcher, type RecordedResponse } from '../src/packages/source-store/fixture.ts'
import { scanBuild } from './support/fixture-build.ts'
import { identityMappings, mappings } from './support/source-map.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** A recorded JavaScript response with `body`. */
const js = (body: string): RecordedResponse => ({ headers: { 'content-type': 'text/javascript' }, body })

/** The fixture fetcher over `responses`, recording each URL it is asked for. */
function served(responses: Record<string, RecordedResponse>): Fetcher & { urls: string[] } {
  const fixture = fixtureFetcher(responses)
  const urls: string[] = []
  return { urls, fetch: (url, request) => (urls.push(url), fixture.fetch(url, request)) }
}

/** Scans an entry document that is `html`, in resolve mode, fetching from `responses`. */
const scanPage = (html: string, responses: Record<string, RecordedResponse>) =>
  scanBuild({ 'index.html': html }, ['--mode', 'resolve'], { deps: { resolveFetcher: () => fixtureFetcher(responses) } })

/** The one finding on `target`. */
const finding = (report: Json, target: string) => {
  const found = report.findings.filter((each: Json) => each.target.name === target)
  expect(found).toHaveLength(1)
  return found[0]
}

/** The attribution key of the finding a classic `<script src>` of `url`, holding `window.fetch = w`, gives. */
async function keyOf(url: string): Promise<string> {
  const { report } = await scanPage(`<script src="${url}"></script>`, { [url]: js('window.fetch = w') })
  return finding(report, 'Window.fetch').attribution.key
}

describe('remote code is keyed `url:` (§11 Attribution keys)', () => {
  test('a remote script keys `url:` with its URL, provenance `remote`, and high attribution confidence', async () => {
    const { report } = await scanPage('<script src="https://cdn.example/lib.js"></script>', {
      'https://cdn.example/lib.js': js('window.fetch = w'),
    })

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: 'url:https://cdn.example/lib.js', provenance: 'remote' })
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|url:https://cdn.example/lib.js')
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
    expect(fetch.occurrences[0].confidence.attribution).toEqual({ level: 'high', reasons: [] })
  })
})

describe('remote URL normalization (§11 Remote URL normalization)', () => {
  test.each([
    // The ticket's and §11's own examples.
    ['https://browser.sentry-cdn.com/11.0.0/bundle.tracing.replay.min.js', 'https://browser.sentry-cdn.com/*/bundle.tracing.replay.min.js'],
    ['https://js-agent.newrelic.com/nr-loader-spa-1.322.0.min.js', 'https://js-agent.newrelic.com/nr-loader-spa-*.min.js'],
    ['https://js.monitor.azure.com/scripts/b/ai.3.gbl.min.js', 'https://js.monitor.azure.com/scripts/b/ai.3.gbl.min.js'],
    // Step 2: the host is lowercased, and a default port, the query and the fragment are dropped.
    ['https://CDN.Example:443/Lib.js?v=3&x=1#top', 'https://cdn.example/Lib.js'],
    ['https://cdn.example:8443/lib.js', 'https://cdn.example:8443/lib.js'],
    // Step 3, `v\d+` as a whole token.
    ['https://cdn.example/datadog-rum-v4.js', 'https://cdn.example/datadog-rum-*.js'],
    ['https://cdn.example/d3.v7.min.js', 'https://cdn.example/d3.*.min.js'],
    ['https://cdn.example/v3/sdk.js', 'https://cdn.example/*/sdk.js'],
    ['https://cdn.example/tv4.js', 'https://cdn.example/tv4.js'],
    // Step 3, semver as a whole segment: 2 or 3 numeric parts, with an optional `v`.
    ['https://cdn.example/sdk/v2.1/sdk.js', 'https://cdn.example/sdk/*/sdk.js'],
    // Step 3, a maximal version run in a filename.
    ['https://js.monitor.azure.com/scripts/b/ext/ai.clck.2.8.18.min.js', 'https://js.monitor.azure.com/scripts/b/ext/ai.clck.*.min.js'],
    ['https://cdn.example/lib.v1.2.3.js', 'https://cdn.example/lib.*.js'],
    ['https://cdn.example/lib-1.2.3.4.min.js', 'https://cdn.example/lib-*.min.js'],
    ['https://cdn.example/sdk-2.0.0-rc.1.umd.min.js', 'https://cdn.example/sdk-*.umd.min.js'],
    ['https://cdn.example/sdk-2.0.0.umd.min.js', 'https://cdn.example/sdk-*.umd.min.js'],
    ['https://cdn.example/lib-1.2.3-beta.mjs', 'https://cdn.example/lib-*.mjs'],
    ['https://cdn.example/sdk-2.0.0-rc.1.min.js', 'https://cdn.example/sdk-*.min.js'],
    ['https://cdn.example/sdk_1.4.js', 'https://cdn.example/sdk_*.js'],
    // Step 3, `@` and a numeric version after a package name, even major-only; the `@` stays.
    ['https://unpkg.com/react@18/umd/react.production.min.js', 'https://unpkg.com/react@*/umd/react.production.min.js'],
    ['https://unpkg.com/vue@3.4/dist/vue.global.js', 'https://unpkg.com/vue@*/dist/vue.global.js'],
    ['https://cdn.jsdelivr.net/gh/user/repo@v1.2.3/dist/x.js', 'https://cdn.jsdelivr.net/gh/user/repo@*/dist/x.js'],
    ['https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js', 'https://cdn.jsdelivr.net/npm/bootstrap@*/dist/js/bootstrap.bundle.min.js'],
    ['https://cdn.jsdelivr.net/npm/@sentry/browser@7.1.0/build/bundle.min.js', 'https://cdn.jsdelivr.net/npm/@sentry/browser@*/build/bundle.min.js'],
    // Step 4: hex runs of 8 or more characters, in either case, as whole tokens.
    ['https://cdn.example/assets/main.A1B2c3d4e5.js', 'https://cdn.example/assets/main.#.js'],
    ['https://cdn.example/0123abcd/chunk.js', 'https://cdn.example/#/chunk.js'],
    ['https://cdn.example/main.a1b2c3d.js', 'https://cdn.example/main.a1b2c3d.js'],
    ['https://cdn.example/main.a1b2c3d4x.js', 'https://cdn.example/main.a1b2c3d4x.js'],
    // Steps 3 and 4 apply to the path only: hosts are kept.
    ['https://deadbeef00.v2.cdn.example/lib.js', 'https://deadbeef00.v2.cdn.example/lib.js'],
  ])('%s keys url:%s', async (url, normalized) => {
    expect(await keyOf(url)).toBe(`url:${normalized}`)
  })

  test('step 1: a protocol-relative URL is `https:`', async () => {
    const { report } = await scanPage('<script src="//cdn.example/lib.js"></script>', {
      'https://cdn.example/lib.js': js('window.fetch = w'),
    })
    expect(finding(report, 'Window.fetch').attribution.key).toBe('url:https://cdn.example/lib.js')
  })

  test('step 1: an `http:` URL is `https:`, and its default port is dropped', async () => {
    const { report } = await scanBuild(
      { 'index.html': '<script src="http://CDN.example:80/lib.js"></script><script src="http://cdn.example:8080/x.js"></script>' },
      ['--mode', 'resolve', '--entry', 'index.html@http://app.example/'],
      {
        deps: {
          resolveFetcher: () =>
            fixtureFetcher({
              'http://cdn.example/lib.js': js('window.fetch = w'),
              'http://cdn.example:8080/x.js': js('window.alert = w'),
            }),
        },
      },
    )
    expect(finding(report, 'Window.fetch').attribution.key).toBe('url:https://cdn.example/lib.js')
    expect(finding(report, 'Window.alert').attribution.key).toBe('url:https://cdn.example:8080/x.js')
  })

  test('a region switch (`us1` → `eu1`) gives a new key', async () => {
    const us = await keyOf('https://us1.cdn.example/rum.js')
    const eu = await keyOf('https://eu1.cdn.example/rum.js')
    expect(us).toBe('url:https://us1.cdn.example/rum.js')
    expect(eu).toBe('url:https://eu1.cdn.example/rum.js')
  })
})

describe('a package a remote map names is evidence only (§9, §10 Provenance, §17)', () => {
  const lib = 'https://cdn.example/sdk@2.1.0/lib.min.js'
  const code = 'window.fetch = w'
  /** A version 3 map of `code` whose one source is `source`, holding `content`. */
  const map = (source: string, content: string) =>
    JSON.stringify({ version: 3, sources: [source], sourcesContent: [content], names: [], mappings: mappings(identityMappings(code)) })
  const scanMapped = (source: string, content: string) =>
    scanPage(`<script src="${lib}"></script>`, {
      [lib]: js(`${code}\n//# sourceMappingURL=lib.min.js.map`),
      'https://cdn.example/sdk@2.1.0/lib.min.js.map': { body: map(source, content) },
    })

  test('the finding stays keyed `url:`, high, with the package the map names as evidence', async () => {
    const { report } = await scanMapped('webpack://sdk/./node_modules/otel-fetch/index.js', `${code}\n`)

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: 'url:https://cdn.example/sdk@*/lib.min.js', provenance: 'remote' })
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
    expect(fetch.occurrences[0].evidence).toEqual({ package: 'otel-fetch' })
    expect(fetch.occurrences[0].original).toMatchObject({ source: 'webpack://sdk/./node_modules/otel-fetch/index.js' })
  })

  test('a map position that fails the token check, or names no package, still keys `url:`, high', async () => {
    const failed = finding((await scanMapped('webpack://sdk/./node_modules/otel-fetch/index.js', 'export {}\n')).report, 'Window.fetch')
    const firstParty = finding((await scanMapped('webpack://sdk/./src/fetch.js', `${code}\n`)).report, 'Window.fetch')

    for (const fetch of [failed, firstParty]) {
      expect(fetch.attribution).toEqual({ key: 'url:https://cdn.example/sdk@*/lib.min.js', provenance: 'remote' })
      expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
    }
    expect(failed.occurrences[0].evidence).toEqual({ rejected: { source: 'webpack://sdk/./node_modules/otel-fetch/index.js', line: 1, column: 7 } })
    expect(firstParty.occurrences[0].evidence).toEqual({})
  })
})

describe('keys come from the URL as referenced, not after redirects (§11, §17 What is recorded)', () => {
  /** A redirect to `location`. */
  const redirect = (location: string): RecordedResponse => ({ status: 302, headers: { location } })

  /** Each finding's target name and key. */
  const keys = (report: Json) => report.findings.map((each: Json) => [each.target.name, each.attribution.key])

  test('a redirect does not change the key, wherever it points', async () => {
    const page = '<script src="https://cdn.example/latest/sdk.js"></script>'
    const scanTo = (target: string) =>
      scanPage(page, {
        'https://cdn.example/latest/sdk.js': redirect(target),
        [target]: js('window.fetch = w'),
      })

    const us = (await scanTo('https://us1.cdn.example/sdk/5f3a9c21/sdk.js')).report
    const eu = (await scanTo('https://eu1.cdn.example/other/sdk.js')).report

    expect(keys(us)).toEqual([['Window.fetch', 'url:https://cdn.example/latest/sdk.js']])
    expect(keys(eu)).toEqual(keys(us))
    expect(us.artifacts[0].retrieval.finalUrl).toBe('https://us1.cdn.example/sdk/5f3a9c21/sdk.js')
  })

  test("a redirected script's imports are fetched against its final URL, and keyed against its requested one", async () => {
    const page = '<script type="module" src="https://cdn.example/loader.js"></script>'
    const scanTo = (region: string) => {
      const final = `https://${region}.cdn.example/v2`
      const fetcher = served({
        'https://cdn.example/loader.js': redirect(`${final}/loader.js`),
        [`${final}/loader.js`]: js('import "./rum.js"; import("./lazy/replay.js")'),
        [`${final}/rum.js`]: js('import "./util.js"; window.fetch = w'),
        [`${final}/util.js`]: js('window.alert = w'),
        [`${final}/lazy/replay.js`]: js('window.open = w'),
      })
      return scanBuild({ 'index.html': page }, ['--mode', 'resolve'], { deps: { resolveFetcher: () => fetcher } }).then(
        ({ report }) => ({ report, fetched: fetcher.urls }),
      )
    }

    const us = await scanTo('us1')
    const eu = await scanTo('eu1')

    expect(keys(us.report)).toEqual([
      ['Window.alert', 'url:https://cdn.example/util.js'],
      ['Window.fetch', 'url:https://cdn.example/rum.js'],
      ['Window.open', 'url:https://cdn.example/lazy/replay.js'],
    ])
    // Moving the redirect target leaves every key unchanged.
    expect(keys(eu.report)).toEqual(keys(us.report))
    expect(us.fetched.sort()).toEqual([
      'https://cdn.example/loader.js',
      'https://us1.cdn.example/v2/lazy/replay.js',
      'https://us1.cdn.example/v2/rum.js',
      'https://us1.cdn.example/v2/util.js',
    ])
    const rum = us.report.artifacts.find((each: Json) => each.url === 'https://cdn.example/rum.js')
    expect(rum).toMatchObject({
      parent: 'https://cdn.example/loader.js',
      retrieval: { status: 'ok', requestedUrl: 'https://us1.cdn.example/v2/rum.js', finalUrl: 'https://us1.cdn.example/v2/rum.js' },
    })
    expect(us.report.completeness.level).toBe('complete')
  })

  test("a redirected worker's `importScripts` and nested workers are fetched against its final URL, and keyed against its requested one", async () => {
    const scanTo = (version: string) =>
      scanBuild(
        { 'index.html': '<script src="/js/boot.js"></script>' },
        ['--mode', 'resolve', '--map', 'https://app.example/static/=static', '--entry', 'index.html@https://app.example/'],
        {
          deps: {
            resolveFetcher: () =>
              fixtureFetcher({
                'https://app.example/js/boot.js': js('new Worker("/w/latest.js")'),
                'https://app.example/w/latest.js': redirect(`/w/${version}/worker.js`),
                [`https://app.example/w/${version}/worker.js`]: js('importScripts("./helper.js"); new Worker("./nested.js")'),
                [`https://app.example/w/${version}/helper.js`]: js('self.fetch = w'),
                [`https://app.example/w/${version}/nested.js`]: js('self.setTimeout = w'),
              }),
          },
        },
      )

    const v2 = (await scanTo('v2')).report
    const v3 = (await scanTo('b91c02ffe1')).report

    expect(keys(v2)).toEqual([
      ['DedicatedWorkerGlobalScope.fetch', 'url:https://app.example/w/helper.js'],
      ['DedicatedWorkerGlobalScope.setTimeout', 'url:https://app.example/w/nested.js'],
    ].sort(([a], [b]) => (a! < b! ? -1 : 1)))
    expect(keys(v3)).toEqual(keys(v2))
  })

  test('one fetched URL reached under two key URLs is an artifact record per key, sharing one fetch, in either order', async () => {
    const loader = '<script type="module" src="https://cdn.example/loader.js"></script>'
    const direct = '<script type="module" src="https://us1.cdn.example/v2/rum.js"></script>'
    const scanOrder = (html: string) => {
      const fetcher = served({
        'https://cdn.example/loader.js': redirect('https://us1.cdn.example/v2/loader.js'),
        'https://us1.cdn.example/v2/loader.js': js('import "./rum.js"'),
        'https://us1.cdn.example/v2/rum.js': js('window.fetch = w'),
      })
      return scanBuild({ 'index.html': html }, ['--mode', 'resolve'], { deps: { resolveFetcher: () => fetcher } }).then(
        ({ report }) => ({ report, fetched: fetcher.urls }),
      )
    }

    const loaderFirst = await scanOrder(loader + direct)
    const directFirst = await scanOrder(direct + loader)

    const expected = [
      ['Window.fetch', 'url:https://cdn.example/rum.js'],
      ['Window.fetch', 'url:https://us1.cdn.example/*/rum.js'],
    ]
    expect(keys(loaderFirst.report)).toEqual(expected)
    expect(keys(directFirst.report)).toEqual(expected)
    expect(loaderFirst.fetched.filter((url) => url.endsWith('/rum.js'))).toEqual(['https://us1.cdn.example/v2/rum.js'])
    const hashes = (report: Json) =>
      report.artifacts.filter((each: Json) => each.url.endsWith('/rum.js')).map((each: Json) => [each.url, each.hash])
    expect(hashes(loaderFirst.report)).toHaveLength(2)
    expect(new Set(hashes(loaderFirst.report).map(([, hash]: string[]) => hash)).size).toBe(1)
  })

  test('one key URL reached through two fetched URLs is an artifact record per (key URL, fetched URL), both analyzed, in either order', async () => {
    const loader = '<script type="module" src="https://cdn.example/loader.js"></script>'
    const direct = '<script type="module" src="https://cdn.example/rum.js"></script>'
    const scanOrder = (html: string) =>
      scanPage(html, {
        'https://cdn.example/loader.js': redirect('https://us1.cdn.example/v2/loader.js'),
        'https://us1.cdn.example/v2/loader.js': js('import "./rum.js"; window.fetch = w'),
        'https://us1.cdn.example/v2/rum.js': js('window.fetch = w; window.open = w'),
        'https://cdn.example/rum.js': js('window.fetch = w; window.alert = w'),
      }).then(({ report }) => report)

    const loaderFirst = await scanOrder(loader + direct)
    const directFirst = await scanOrder(direct + loader)

    // Both fetches are analyzed, and each finding lands under the one key.
    expect(keys(loaderFirst)).toEqual([
      ['Window.alert', 'url:https://cdn.example/rum.js'],
      ['Window.fetch', 'url:https://cdn.example/loader.js'],
      ['Window.fetch', 'url:https://cdn.example/rum.js'],
      ['Window.open', 'url:https://cdn.example/rum.js'],
    ])
    expect(keys(directFirst)).toEqual(keys(loaderFirst))
    // `Window.fetch` is written by both fetches of the key URL: one finding, an occurrence from each record.
    const fetch = loaderFirst.findings.find(
      (each: Json) => each.target.name === 'Window.fetch' && each.attribution.key === 'url:https://cdn.example/rum.js',
    )
    expect(fetch.occurrences.map((each: Json) => each.artifact.url)).toEqual([
      'https://cdn.example/rum.js',
      'https://cdn.example/rum.js',
    ])
    expect(new Set(fetch.occurrences.map((each: Json) => each.artifact.hash)).size).toBe(2)
    // The records share their `url`, and `retrieval.requestedUrl` tells them apart.
    const records = (report: Json) =>
      report.artifacts
        .filter((each: Json) => each.url === 'https://cdn.example/rum.js')
        .map((each: Json) => each.retrieval.requestedUrl)
    expect(records(loaderFirst).sort()).toEqual(['https://cdn.example/rum.js', 'https://us1.cdn.example/v2/rum.js'])
    expect(records(directFirst)).toEqual(records(loaderFirst))
    expect(loaderFirst.completeness.level).toBe('complete')
    expect(JSON.stringify({ ...directFirst, run: null })).toBe(JSON.stringify({ ...loaderFirst, run: null }))
  })
})

describe("a redirected script's bare import and the import-map scope of its final URL (§11 Redirects and keys)", () => {
  const redirect = (location: string): RecordedResponse => ({ status: 302, headers: { location } })
  const importMap = (map: object) => `<script type="importmap">${JSON.stringify(map)}</script>`
  const loader = '<script type="module" src="https://cdn.example/loader.js"></script>'
  const responses = {
    'https://cdn.example/loader.js': redirect('https://us1.cdn.example/v2/loader.js'),
    'https://us1.cdn.example/v2/loader.js': js('import "rum"'),
    'https://us1.cdn.example/v2/rum.js': js('window.fetch = w'),
    'https://cdn.example/rum.js': js('window.alert = w'),
  }

  test('an import that resolves only through the scope matching the final URL is keyed by the fetched URL', async () => {
    const map = { scopes: { 'https://us1.cdn.example/v2/': { rum: 'https://us1.cdn.example/v2/rum.js' } } }
    const { report } = await scanPage(importMap(map) + loader, responses)

    expect(finding(report, 'Window.fetch').attribution.key).toBe('url:https://us1.cdn.example/*/rum.js')
    expect(report.completeness.level).toBe('complete')
  })

  test('when both resolutions succeed, the key follows the requested URL and the bytes the final URL', async () => {
    const map = {
      imports: { rum: 'https://cdn.example/rum.js' },
      scopes: { 'https://us1.cdn.example/v2/': { rum: 'https://us1.cdn.example/v2/rum.js' } },
    }
    const { report } = await scanPage(importMap(map) + loader, responses)

    expect(finding(report, 'Window.fetch').attribution.key).toBe('url:https://cdn.example/rum.js')
    expect(report.findings.some((each: Json) => each.target.name === 'Window.alert')).toBe(false)
  })
})

test("one fetch of a key URL that fails doesn't count the key URL's other, analyzed record as failed (§13 Counters)", async () => {
  const html =
    '<script type="module" src="https://cdn.example/loader.js"></script>' +
    '<script type="module" src="https://cdn.example/rum.js"></script>'
  const { report } = await scanPage(html, {
    'https://cdn.example/loader.js': { status: 302, headers: { location: 'https://us1.cdn.example/v2/loader.js' } },
    'https://us1.cdn.example/v2/loader.js': js('import "./rum.js"'),
    'https://us1.cdn.example/v2/rum.js': { status: 500, headers: {} },
    'https://cdn.example/rum.js': js('window.fetch = w'),
  })

  const { known, analyzed, failed } = report.completeness.counters.artifacts
  expect([known, analyzed, failed['fetch-failed']]).toEqual([3, 2, 1])
  expect(finding(report, 'Window.fetch').attribution.key).toBe('url:https://cdn.example/rum.js')
})

test("a failed fetch of a key URL doesn't carry the hash of the key URL's other, read record (§13 Counters)", async () => {
  const loader = '<script type="module" src="https://cdn.example/loader.js"></script>'
  const direct = '<script type="module" src="https://cdn.example/rum.js"></script>'
  const responses = {
    'https://cdn.example/loader.js': { status: 302, headers: { location: 'https://us1.cdn.example/v2/loader.js' } },
    'https://us1.cdn.example/v2/loader.js': js('import "./rum.js"'),
    'https://cdn.example/rum.js': { status: 500, headers: {} },
    'https://us1.cdn.example/v2/rum.js': js('window.fetch = w'),
  }
  for (const html of [loader + direct, direct + loader]) {
    const { report } = await scanPage(html, responses)

    expect(report.completeness.limitations).toEqual([
      { kind: 'fetch-failed', artifact: { url: 'https://cdn.example/rum.js' }, detail: 'HTTP 500' },
    ])
    expect(report.completeness.counters.artifacts.failed['fetch-failed']).toBe(1)
  }
})

test('the report is byte-identical across runs, outside its `run` block', async () => {
  const responses = {
    'https://cdn.example/loader.js': { status: 302, headers: { location: 'https://us1.cdn.example/v2/loader.js' } },
    'https://us1.cdn.example/v2/loader.js': js('import "./rum.js"'),
    'https://us1.cdn.example/v2/rum.js': js('window.fetch = w'),
  }
  const html =
    '<script type="module" src="https://cdn.example/loader.js"></script>' +
    '<script type="module" src="https://us1.cdn.example/v2/rum.js"></script>'
  const first = await scanPage(html, responses)
  const second = await scanPage(html, responses)

  const withoutRun = (text: string) => JSON.stringify({ ...JSON.parse(text), run: null })
  expect(first.report.findings).toHaveLength(2)
  expect(withoutRun(second.stdout)).toBe(withoutRun(first.stdout))
})

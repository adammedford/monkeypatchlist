// Remote source maps (§17 What is fetched, Content types; §2 Source maps; §13 Attribution block). A remote
// artifact's map is fetched in `resolve` mode under the same safety floor, only after every script fetch. A map that
// is refused, fails or can't be read changes counters only, never completeness.

import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { fixtureFetcher, type RecordedResponse } from '../src/packages/source-store/fixture.ts'
import type { Fetcher, FetchRequest } from '../src/packages/source-store/index.ts'
import { fakeNetwork, type Handler } from './support/fake-network.ts'
import { fixtureBuild, scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/**
 * Code that reads `window.fetch` and writes nothing: a remote artifact's findings would need its `url:` attribution
 * key (§11), which other tests cover.
 */
const remoteCode = 'window.fetch + f'

/** A version 3 map of `remoteCode`: a segment at `window`, `fetch`, `+` and `f`, each to the same original place. */
const remoteMap = JSON.stringify({
  version: 3,
  sources: ['../src/lib.js'],
  sourcesContent: ['window.fetch + f\n'],
  names: [],
  mappings: 'AAAA,OAAO,MAAM,EAAE',
})

/** A recorded JavaScript response with `body`, and `headers` besides its type. */
const js = (body: string, headers: Record<string, string> = {}): RecordedResponse => ({
  headers: { 'content-type': 'text/javascript', ...headers },
  body,
})

/** The fixture fetcher over `responses`, recording each URL it is asked for, and how. */
function served(responses: Record<string, RecordedResponse>): Fetcher & { requests: [string, FetchRequest][] } {
  const fixture = fixtureFetcher(responses)
  const requests: [string, FetchRequest][] = []
  return { requests, fetch: (url, request) => (requests.push([url, request]), fixture.fetch(url, request)) }
}

/** Scans `files` in resolve mode (§17), fetching through `fetcher`. */
const scanResolved = (files: string | Record<string, string>, fetcher: Fetcher) =>
  scanBuild(files, ['--mode', 'resolve'], { deps: { resolveFetcher: () => fetcher } })

/** An address of the fake network that the safety floor lets the fetcher connect to. */
const cdn = '203.0.113.10'

/** Serves each path's response from `paths`, and a 404 for any other. */
const routes =
  (paths: Record<string, { type?: string; body: string; headers?: Record<string, string> }>): Handler =>
  (request, response) => {
    const route = paths[request.url ?? '']
    if (route === undefined) return void response.writeHead(404).end()
    response.writeHead(200, { 'content-type': route.type ?? 'application/json', ...route.headers }).end(route.body)
  }

const artifact = (report: Json, url: string) => report.artifacts.find((found: Json) => found.url === url)
const lib = 'https://cdn.example/lib.js'
const page = { 'index.html': `<script src="${lib}"></script>` }

describe('a remote map is fetched and verified (§17 What is fetched, §2 Verification)', () => {
  test("a header's or annotation's map is fetched as a map and pairs when it verifies; another build's is stale", async () => {
    const fetcher = served({
      'https://cdn.example/a.js': js(remoteCode, { SourceMap: 'a.js.map' }),
      'https://cdn.example/a.js.map': { headers: { 'content-type': 'text/plain' }, body: remoteMap },
      'https://cdn.example/b.js': js(`${remoteCode}\n//# sourceMappingURL=b.js.map`),
      'https://cdn.example/b.js.map': { body: remoteMap },
      // A map of other code: its segment at column 20 is past the end of the line.
      'https://cdn.example/c.js': js(`${remoteCode}\n//# sourceMappingURL=c.js.map`),
      'https://cdn.example/c.js.map': { body: remoteMap.replace('EAAE', 'EAAE,KAAK') },
    })
    const { report } = await scanResolved(
      {
        'index.html': ['a', 'b', 'c'].map((name) => `<script src="https://cdn.example/${name}.js"></script>`).join(''),
      },
      fetcher,
    )

    expect(report.artifacts.map(({ url, sourceMap }: Json) => [url, sourceMap])).toEqual([
      ['https://cdn.example/a.js', { method: 'header', path: null, status: 'verified' }],
      ['https://cdn.example/b.js', { method: 'annotation', path: null, status: 'verified' }],
      ['https://cdn.example/c.js', { method: 'none', path: null, status: 'stale' }],
    ])
    expect(fetcher.requests.filter(([, { destination }]) => destination === 'map').map(([url]) => url)).toEqual([
      'https://cdn.example/a.js.map',
      'https://cdn.example/b.js.map',
      'https://cdn.example/c.js.map',
    ])
    expect(report.completeness.attribution).toMatchObject({
      artifacts: { withMap: 2, withoutMap: 0, withBrokenMap: 1 },
      staleCandidates: 1,
      unreadMaps: { refused: 0, failed: 0, unreadable: 0 },
    })
  })
})

describe("a remote artifact's map that isn't read changes counters only (§17)", () => {
  test('a map whose fetch fails is counted, and the scan stays complete', async () => {
    const fetcher = served({
      [lib]: js(`${remoteCode}\n//# sourceMappingURL=lib.js.map`),
      'https://cdn.example/lib.js.map': { status: 404 },
    })
    const { report } = await scanResolved(page, fetcher)

    expect(artifact(report, lib).sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.attribution.unreadMaps).toEqual({ refused: 0, failed: 1, unreadable: 0 })
  })

  test('a header map that fails is counted though the annotation pairs, and a map named twice counts once', async () => {
    const fetcher = served({
      [lib]: js(`${remoteCode}\n//# sourceMappingURL=lib.js.map`, { SourceMap: '/gone.js.map' }),
      'https://cdn.example/lib.js.map': { body: remoteMap },
      'https://cdn.example/other.js': js(`${remoteCode};\n//# sourceMappingURL=/gone.js.map`, { SourceMap: '/gone.js.map' }),
    })
    const files = { 'index.html': `<script src="${lib}"></script><script src="https://cdn.example/other.js"></script>` }
    const { report } = await scanResolved(files, fetcher)

    expect(artifact(report, lib).sourceMap).toEqual({ method: 'annotation', path: null, status: 'verified' })
    expect(artifact(report, 'https://cdn.example/other.js').sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
    // `gone.js.map` is counted once for each artifact that names it, however many of its methods do.
    expect(report.completeness.attribution.unreadMaps).toEqual({ refused: 0, failed: 2, unreadable: 0 })
    expect(report.completeness.level).toBe('complete')
  })

  test('the report is byte-identical across runs, outside its `run` block', async () => {
    const files = { 'index.html': `<script src="${lib}"></script>` }
    const responses = {
      [lib]: js(`${remoteCode}\n//# sourceMappingURL=lib.js.map`, { SourceMap: 'https://maps.example/lib.js.map' }),
    }
    const withoutRun = ({ stdout }: { stdout: string }) => JSON.stringify({ ...JSON.parse(stdout), run: null })
    const first = await scanResolved(files, served(responses))
    const second = await scanResolved(files, served(responses))

    expect(first.report.completeness.attribution.unreadMaps).toEqual({ refused: 0, failed: 2, unreadable: 0 })
    expect(withoutRun(second)).toBe(withoutRun(first))
  })

  test('a map the safety floor refuses is counted, and the scan stays complete', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn, 'maps.example': '10.0.0.7' })
    network.serve(
      cdn,
      routes({
        // An `http:` map for an `https:` document is refused for its scheme, and a private address is refused too.
        '/a.js': { type: 'text/javascript', body: `${remoteCode}\n//# sourceMappingURL=http://cdn.example/a.js.map` },
        '/b.js': { type: 'text/javascript', body: `${remoteCode}\n//# sourceMappingURL=https://maps.example/b.js.map` },
      }),
    )
    const { report } = await scanBuild(
      { 'index.html': '<script src="https://cdn.example/a.js"></script><script src="https://cdn.example/b.js"></script>' },
      ['--mode', 'resolve'],
      { deps: { resolveFetcher: network.fetcher() } },
    )

    expect(network.requests.map(({ url }) => url)).toEqual(['https://cdn.example/a.js', 'https://cdn.example/b.js'])
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.attribution.unreadMaps).toEqual({ refused: 2, failed: 0, unreadable: 0 })
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 2, analyzed: 2 })
  })

  test('a build file a remote script names that exists but can\'t be read is counted; a missing one is not', async () => {
    const fetcher = served({
      'https://cdn.example/a.js': js(`${remoteCode}\n//# sourceMappingURL=https://app.example/maps/a.js.map`),
      'https://cdn.example/b.js': js(`${remoteCode}\n//# sourceMappingURL=https://app.example/maps/missing.js.map`),
    })
    const dir = fixtureBuild({
      'index.html': '<script src="https://cdn.example/a.js"></script><script src="https://cdn.example/b.js"></script>',
      'maps/a.js.map': remoteMap,
    })
    chmodSync(join(dir, 'maps/a.js.map'), 0o000)
    const { report } = await scanResolved(dir, fetcher)

    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.attribution.unreadMaps).toEqual({ refused: 0, failed: 0, unreadable: 1 })
    expect(report.completeness.attribution.artifacts).toEqual({ withMap: 0, withoutMap: 2, withBrokenMap: 0 })
  })
})

describe('remote maps are fetched only after every script fetch, and never displace a script (§17)', () => {
  test('every map is requested after every script, whatever references the scripts', async () => {
    const withMap = (code: string, name: string) => js(`${code}\n//# sourceMappingURL=${name}.map`)
    const fetcher = served({
      'https://cdn.example/a.js': withMap(`${remoteCode};import("https://cdn.example/b.js")`, 'a.js'),
      'https://cdn.example/a.js.map': { body: remoteMap },
      'https://cdn.example/b.js': withMap(`${remoteCode};import "./c.js"`, 'b.js'),
      'https://cdn.example/b.js.map': { body: remoteMap },
      'https://cdn.example/c.js': withMap(remoteCode, 'c.js'),
      'https://cdn.example/c.js.map': { body: remoteMap },
      'https://cdn.example/d.js': withMap(remoteCode, 'd.js'),
      'https://cdn.example/d.js.map': { body: remoteMap },
      'https://cdn.example/preloaded.js': withMap(remoteCode, 'preloaded.js'),
      'https://cdn.example/preloaded.js.map': { body: remoteMap },
    })
    const { report } = await scanResolved(
      {
        'index.html': [
          '<script src="https://cdn.example/a.js"></script>',
          '<link rel="preload" as="script" href="https://cdn.example/preloaded.js">',
          '<script src="main.js"></script>',
        ].join(''),
        'main.js': 'new Worker("worker.js")',
        'worker.js': 'importScripts("https://cdn.example/d.js")',
      },
      fetcher,
    )

    const requested = fetcher.requests.map(([url, { destination }]) => [url, destination])
    const firstMap = requested.findIndex(([, destination]) => destination === 'map')
    expect(requested.slice(0, firstMap).map(([url]) => url).sort()).toEqual([
      'https://cdn.example/a.js',
      'https://cdn.example/b.js',
      'https://cdn.example/c.js',
      'https://cdn.example/d.js',
      'https://cdn.example/preloaded.js',
    ])
    expect(requested.slice(firstMap).every(([, destination]) => destination === 'map')).toBe(true)
    expect(requested.slice(firstMap)).toHaveLength(5)
    expect(report.completeness.attribution.pairings.annotation).toBe(5)
  })

  describe('maps count toward the caps and budgets, and use only what the scripts left', () => {
    const twoScripts = {
      'index.html': '<script src="https://cdn.example/a.js"></script><script src="https://cdn.example/b.js"></script>',
    }
    const script = (name: string) => ({
      type: 'text/javascript',
      body: `${remoteCode}\n//# sourceMappingURL=${name}.map`,
    })
    const cdnRoutes = routes({
      '/a.js': script('a.js'),
      '/b.js': script('b.js'),
      '/a.js.map': { body: remoteMap },
      '/b.js.map': { body: remoteMap },
    })
    const scan = (fetcher: () => Fetcher) => scanBuild(twoScripts, ['--mode', 'resolve'], { deps: { resolveFetcher: fetcher } })
    const statuses = (report: Json) => report.artifacts.map(({ url, retrieval }: Json) => [url, retrieval.status])

    test('the count: two scripts under a limit of two are both fetched, and their maps are refused', async () => {
      const network = fakeNetwork({ 'cdn.example': cdn })
      network.serve(cdn, cdnRoutes)
      const { report } = await scan(network.fetcher({ limits: { artifacts: 2 } }))

      expect(statuses(report)).toEqual([
        ['https://cdn.example/a.js', 'ok'],
        ['https://cdn.example/b.js', 'ok'],
      ])
      expect(network.requests.map(({ url }) => url)).toEqual(['https://cdn.example/a.js', 'https://cdn.example/b.js'])
      expect(report.completeness.level).toBe('complete')
      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.attribution.unreadMaps).toEqual({ refused: 2, failed: 0, unreadable: 0 })
    })

    test('the count: under a limit of three, the one map left pairs', async () => {
      const network = fakeNetwork({ 'cdn.example': cdn })
      network.serve(cdn, cdnRoutes)
      const { report } = await scan(network.fetcher({ limits: { artifacts: 3 } }))

      expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap.method)).toEqual(['annotation', 'none'])
      expect(report.completeness.attribution.unreadMaps).toEqual({ refused: 1, failed: 0, unreadable: 0 })
    })

    test('the size budget: a map past what the scripts left of it is refused, and the scripts are analyzed', async () => {
      const network = fakeNetwork({ 'cdn.example': cdn })
      network.serve(cdn, cdnRoutes)
      // Room for both scripts, or for a script and a map, but not for both scripts and a map.
      const bytes = (text: string) => new TextEncoder().encode(text).length
      const scanBytes = 2 * bytes(script('a.js').body) + bytes(remoteMap) - 1
      const { report } = await scan(network.fetcher({ limits: { scanBytes } }))

      expect(statuses(report)).toEqual([
        ['https://cdn.example/a.js', 'ok'],
        ['https://cdn.example/b.js', 'ok'],
      ])
      expect(report.completeness.level).toBe('complete')
      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.attribution.unreadMaps).toEqual({ refused: 2, failed: 0, unreadable: 0 })
    })

    test('the time budget: once the scripts have spent it, the maps fail, and the scan stays complete', async () => {
      let now = 0
      const network = fakeNetwork({ 'cdn.example': cdn })
      network.serve(cdn, (request, response) => {
        now += 100
        cdnRoutes(request, response)
      })
      const { report } = await scan(network.fetcher({ limits: { scanMs: 200 }, clock: () => now }))

      expect(statuses(report)).toEqual([
        ['https://cdn.example/a.js', 'ok'],
        ['https://cdn.example/b.js', 'ok'],
      ])
      expect(network.requests).toHaveLength(2)
      expect(report.completeness.level).toBe('complete')
      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.attribution.unreadMaps).toEqual({ refused: 0, failed: 2, unreadable: 0 })
    })
  })
})


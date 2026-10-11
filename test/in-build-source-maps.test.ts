// In-build source maps (§2 Source maps, §13 Attribution block, §19 Discovery), with the pairing
// refinements: the quote rule, `.map` in any case, and named maps that can't be read. A quoted line comment counts
// as code, and whether a named map exists is judged by the sweep's listing, which holds the paths and that it holds a file under any spelling.

import { chmodSync, existsSync, mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { fixtureFetcher, type RecordedResponse } from '../src/packages/source-store/fixture.ts'
import type { Fetcher, FetchRequest } from '../src/packages/source-store/index.ts'
import { fakeNetwork } from './support/fake-network.ts'
import { fixtureBuild, scanBuild } from './support/fixture-build.ts'
import { mappings, type Segment } from './support/source-map.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** A version 3 source map of one original source, as JSON text. */
function sourceMap(lines: Segment[][], fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 3,
    sources: ['../src/app.js'],
    sourcesContent: ['window.fetch = wrapped\n'],
    names: [],
    mappings: mappings(lines),
    ...fields,
  })
}

/** `window.fetch = f` on line 1: a segment at `window`, `fetch`, `=` and `f`. */
const code = 'window.fetch = f'
/**
 * Code with the same tokens as `code` that writes nothing, for fetched artifacts: their findings would need remote
 * attribution keys (§11), which other tests cover.
 */
const remoteCode = 'window.fetch + f'
const codeMap = (fields: Record<string, unknown> = {}) =>
  sourceMap(
    [
      [
        [0, 0, 0, 0],
        [7, 0, 0, 7],
        [13, 0, 0, 13],
        [15, 0, 0, 15],
      ],
    ],
    fields,
  )

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

const artifact = (report: Json, url: string) => report.artifacts.find((found: Json) => found.url === url)
const main = 'https://app.example/main.js'

describe('source maps in the build directory (§2 Source maps)', () => {
  test('a `sourceMappingURL` annotation pairs the map it names, and the artifact records the pairing', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script><script src="other.js"></script>',
      'main.js': `${code}\n//# sourceMappingURL=maps/main.js.map\n`,
      'maps/main.js.map': codeMap(),
      'other.js': code,
    })

    expect(artifact(report, main).sourceMap).toEqual({ method: 'annotation', path: 'maps/main.js.map', status: 'verified' })
    expect(artifact(report, 'https://app.example/other.js').sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
  })

  test('a `<file>.map` sidecar pairs when there is no annotation', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="js/main.js?v=2"></script>',
      'js/main.js': code,
      'js/main.js.map': codeMap(),
    })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'sidecar', path: 'js/main.js.map', status: 'verified' })
  })

  test("a map elsewhere in the build directory pairs by `debugId` when it is the artifact's", async () => {
    const id = '85314830-023f-4cf1-a267-535f4e37bb17'
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${code}\n//# debugId=${id}\n`,
      // Not the sidecar's name, and no annotation names it.
      'maps/3f2a.map': codeMap({ debugId: id.toUpperCase() }),
      'maps/other.map': codeMap({ debugId: '00000000-0000-4000-8000-000000000000' }),
      'maps/broken.map': '{',
    })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'debug-id', path: 'maps/3f2a.map', status: 'verified' })
  })

  test('a map file whose `.map` extension is in any case is a `debugId` candidate', async () => {
    const id = '85314830-023f-4cf1-a267-535f4e37bb17'
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script><script src="other.js"></script>',
      'main.js': `${code}\n//# debugId=${id}\n`,
      'other.js': `${code};\n//# debugId=${id.replace('8', '9')}\n`,
      'maps/bundle.MAP': codeMap({ debugId: id }),
      'maps/other.Map': codeMap({ debugId: id.replace('8', '9') }),
    })

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'debug-id', path: 'maps/bundle.MAP', status: 'verified' },
      { method: 'debug-id', path: 'maps/other.Map', status: 'verified' },
    ])
  })

  test("a map reached only through a symbolic link is a `debugId` candidate: the search uses the sweep's listing", async () => {
    const id = '85314830-023f-4cf1-a267-535f4e37bb17'
    const dir = fixtureBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': `${code}\n//# debugId=${id}\n` })
    mkdirSync(join(dir, '../shared'))
    writeFileSync(join(dir, '../shared/3f2a.map'), codeMap({ debugId: id }))
    symlinkSync('../shared', join(dir, 'maps'))

    const { report } = await scanBuild(dir)

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'debug-id', path: 'maps/3f2a.map', status: 'verified' })
  })

  test('a `//# debugId=` comment whose own text holds a quote names no debug ID', async () => {
    const id = '85314830-023f-4cf1-a267-535f4e37bb17'
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${code}\nvar s = "//# debugId=${id}"`,
      // The debug ID the quoted value would name.
      'maps/3f2a.map': codeMap({ debugId: `${id}"` }),
    })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
  })

  test("a fetched artifact's `SourceMap` header pairs the map it names, before its annotation", async () => {
    const fetcher = served({
      'https://cdn.example/lib.js': js(`${remoteCode}\n//# sourceMappingURL=stale.js.map\n`, {
        SourceMap: '/maps/lib.js.map',
      }),
      'https://cdn.example/maps/lib.js.map': { body: codeMap() },
      'https://cdn.example/stale.js.map': { body: codeMap() },
    })
    const { report } = await scanResolved({ 'index.html': '<script src="https://cdn.example/lib.js"></script>' }, fetcher)

    expect(artifact(report, 'https://cdn.example/lib.js')).toMatchObject({
      origin: 'cross-origin',
      retrieval: { status: 'ok' },
      sourceMap: { method: 'header', path: null, status: 'verified' },
    })
  })

  test('an empty `SourceMap` header names no map, so the annotation pairs', async () => {
    const fetcher = served({
      'https://cdn.example/lib.js': js(`${remoteCode}\n//# sourceMappingURL=lib.js.map\n`, { SourceMap: '' }),
      'https://cdn.example/lib.js.map': { body: codeMap() },
    })
    const { report } = await scanResolved({ 'index.html': '<script src="https://cdn.example/lib.js"></script>' }, fetcher)

    expect(artifact(report, 'https://cdn.example/lib.js').sourceMap).toEqual({
      method: 'annotation',
      path: null,
      status: 'verified',
    })
    // The script is not fetched again as its own map.
    expect(fetcher.requests.map(([url]) => url)).toEqual(['https://cdn.example/lib.js', 'https://cdn.example/lib.js.map'])
  })
})

describe('the maps of fetched artifacts (§17 Remote source maps)', () => {
  test("a redirected script's map resolves against the URL its bytes came from", async () => {
    const fetcher = served({
      'https://cdn.example/latest/lib.js': { status: 302, headers: { location: '/v2/lib.js' } },
      'https://cdn.example/v2/lib.js': js(`${remoteCode}\n//# sourceMappingURL=lib.js.map`),
      'https://cdn.example/v2/lib.js.map': { body: codeMap() },
      'https://cdn.example/latest/lib.js.map': { body: '{}' },
    })
    const { report } = await scanResolved(
      { 'index.html': '<script src="https://cdn.example/latest/lib.js"></script>' },
      fetcher,
    )

    expect(artifact(report, 'https://cdn.example/latest/lib.js').sourceMap).toEqual({
      method: 'annotation',
      path: null,
      status: 'verified',
    })
    expect(fetcher.requests.map(([url]) => url)).toEqual([
      'https://cdn.example/latest/lib.js',
      'https://cdn.example/v2/lib.js.map',
    ])
  })

  test('a map is fetched under the safety floor as a map, for the entry document, and read as JSON whatever its type', async () => {
    const cdn = '203.0.113.10'
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (request, response) => {
      if (request.url === '/lib.js') {
        response.writeHead(200, { 'content-type': 'text/javascript', sourcemap: '/maps/lib.js.map' }).end(remoteCode)
      } else {
        // A classic script served like this would be refused (§17 Content types).
        response.writeHead(200, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' })
        response.end(codeMap())
      }
    })
    const { report } = await scanBuild(
      { 'index.html': '<script src="https://cdn.example/lib.js"></script>' },
      ['--mode', 'resolve'],
      { deps: { resolveFetcher: network.fetcher() } },
    )

    expect(artifact(report, 'https://cdn.example/lib.js').sourceMap).toEqual({
      method: 'header',
      path: null,
      status: 'verified',
    })
    expect(Object.keys(report.run.retrievals)).toEqual([
      'https://cdn.example/lib.js',
      'https://cdn.example/maps/lib.js.map',
    ])
  })

  test('a map that is not fetched is no candidate, and adds no limitation', async () => {
    const fetcher = served({
      'https://cdn.example/lib.js': js(`${remoteCode}\n//# sourceMappingURL=lib.js.map`, {
        SourceMap: 'https://maps.example/lib.js.map',
      }),
      'https://cdn.example/lib.js.map': { status: 404 },
    })
    const { report } = await scanResolved({ 'index.html': '<script src="https://cdn.example/lib.js"></script>' }, fetcher)

    expect(fetcher.requests).toEqual([
      ['https://cdn.example/lib.js', { destination: 'script', document: 'https://app.example/' }],
      ['https://maps.example/lib.js.map', { destination: 'map', document: 'https://app.example/' }],
      ['https://cdn.example/lib.js.map', { destination: 'map', document: 'https://app.example/' }],
    ])
    expect(artifact(report, 'https://cdn.example/lib.js').sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.attribution.artifacts).toEqual({ withMap: 0, withoutMap: 1, withBrokenMap: 0 })
  })

  test("a URL read in two realms pairs by each realm's bytes, when one realm's are withheld", async () => {
    const fetcher = served({
      'https://cdn.example/lib.js': js(`${remoteCode}\n//# sourceMappingURL=lib.js.map`),
      'https://cdn.example/lib.js.map': { body: codeMap() },
    })
    const { report } = await scanResolved(
      {
        // The window's reference fails its integrity check, so its bytes are withheld (§17 Integrity). The worker's
        // reference carries no integrity value, so the worker reads them.
        'index.html': `<script src="https://cdn.example/lib.js" integrity="sha256-${'A'.repeat(43)}="></script><script src="main.js"></script>`,
        'main.js': 'new Worker("worker.js")',
        'worker.js': 'importScripts("https://cdn.example/lib.js")',
      },
      fetcher,
    )

    const lib = report.artifacts.filter(({ url }: Json) => url === 'https://cdn.example/lib.js')
    expect(lib.map(({ realm, retrieval, sourceMap }: Json) => [realm, retrieval.status, sourceMap])).toEqual([
      ['window', 'sri-mismatch', { method: 'none', path: null, status: 'none' }],
      ['dedicated-worker', 'ok', { method: 'annotation', path: null, status: 'verified' }],
    ])
  })
})

describe('the `sourceMappingURL` annotation (§2 Source maps)', () => {
  /** The pairing of `main.js`, with `tail` after its code, a map at `a.js.map` and one at `b.js.map`. */
  async function pairing(tail: string): Promise<Json> {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${code}\n${tail}`,
      'a.js.map': codeMap(),
      'b.js.map': codeMap(),
    })
    return report.artifacts[0].sourceMap
  }

  test.each([
    ['the last annotation', '//# sourceMappingURL=a.js.map\n//# sourceMappingURL=b.js.map', 'b.js.map'],
    ['the `//@` form', '//@ sourceMappingURL=a.js.map', 'a.js.map'],
    ['an annotation after code on its line', ';//# sourceMappingURL=a.js.map', 'a.js.map'],
    ['an annotation after a block comment on its line', '/* x */ //# sourceMappingURL=a.js.map', 'a.js.map'],
    ['an annotation that line comments and whitespace follow', '//# sourceMappingURL=a.js.map\n  // end\n\n', 'a.js.map'],
    ['an annotation beside a debugId', '//# sourceMappingURL=a.js.map\n//# debugId=85314830-023f-4cf1-a267-535f4e37bb17', 'a.js.map'],
    ['an absolute URL a mapping covers', '//# sourceMappingURL=https://app.example/a.js.map', 'a.js.map'],
    // The quote check reads only the comment's own text.
    ['an annotation after code with a string on its line', '}).call(this,"x");//# sourceMappingURL=a.js.map', 'a.js.map'],
    // A quoted line comment counts as code, so an annotation after it still names a map.
    ['an annotation after a line comment with a quote', "// don't edit\n//# sourceMappingURL=a.js.map", 'a.js.map'],
  ])('names the map: %s', async (_, tail, path) => {
    expect(await pairing(tail)).toEqual({ method: 'annotation', path, status: 'verified' })
  })

  test.each([
    ['one that code follows', '//# sourceMappingURL=a.js.map\nwindow.x = 1'],
    ['one that a block comment naming no map follows', '//# sourceMappingURL=a.js.map\n/*! license */'],
    // ECMA-426 reads an annotation only from a line comment.
    ['a block comment', '/*# sourceMappingURL=a.js.map */'],
    ['a line comment inside a block comment', '/*//# sourceMappingURL=a.js.map*/'],
    ['one inside a block comment that runs past its line', '/*\n//# sourceMappingURL=a.js.map\n*/ x()'],
    ['an empty URL', '//# sourceMappingURL='],
    ['an empty URL after one that names a map', '//# sourceMappingURL=a.js.map\n//# sourceMappingURL='],
    ['a URL no mapping covers, which is not fetched for a local artifact', '//# sourceMappingURL=https://maps.example/a.js.map'],
    // A line comment whose own text holds a quote counts as code, as ECMA-426's check
    // without parsing has it, so it cancels the annotation before it.
    ['an annotation that a line comment with a quote follows', "//# sourceMappingURL=a.js.map\n// don't edit"],
    ['an annotation that a line comment with a double quote follows', '//# sourceMappingURL=a.js.map\n// "use strict"'],
    ['an annotation that a line comment with a backtick follows', '//# sourceMappingURL=a.js.map\n  // `x`\n'],
    // ECMA-426's own example: the annotation is inside a template literal, which the quoted comment closes.
    ['an annotation inside a template literal', 'let a = `\n//# sourceMappingURL=a.js.map\n// `'],
  ])('names no map: %s', async (_, tail) => {
    expect(await pairing(tail)).toEqual({ method: 'none', path: null, status: 'none' })
  })

  // ECMA-426's check without parsing. The build holds a map at the path each quoted value
  // would name, so only the rule keeps it from pairing.
  test.each([
    ['a `//` inside a double-quoted string on the last line', 'var s = "//# sourceMappingURL=x.map"'],
    ['a `//` inside a single-quoted string on the last line', "var s = '//# sourceMappingURL=x.map'"],
    ['a `//` inside a template on the last line', 'var s = `//# sourceMappingURL=x.map`'],
    // The quoted annotation counts as code, so the earlier one names nothing either.
    ['a quoted annotation after one that names a map', '//# sourceMappingURL=a.js.map\n//# sourceMappingURL=x.map"'],
  ])('a line comment whose own text holds a quote names no map: %s', async (_, tail) => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${code}\n${tail}`,
      'a.js.map': codeMap(),
      'x.map"': codeMap(),
      "x.map'": codeMap(),
      'x.map`': codeMap(),
    })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
  })

  test('an annotation a quoted line comment cancels falls through to the sidecar, then `debugId`, then none', async () => {
    const id = '85314830-023f-4cf1-a267-535f4e37bb17'
    const tail = "//# sourceMappingURL=maps/app.js.map\n// don't edit"
    const { report } = await scanBuild({
      'index.html': '<script src="a.js"></script><script src="b.js"></script><script src="c.js"></script>',
      'a.js': `${code}\n${tail}`,
      'a.js.map': codeMap(),
      // The `debugId` comes after the quoted comment, so it still names.
      'b.js': `${code};\n${tail}\n//# debugId=${id}`,
      'debug/3f2a.map': codeMap({ debugId: id }),
      'c.js': `${code};;\n${tail}`,
      // The map every annotation names, which would verify against each.
      'maps/app.js.map': codeMap(),
    })

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'sidecar', path: 'a.js.map', status: 'verified' },
      { method: 'debug-id', path: 'debug/3f2a.map', status: 'verified' },
      { method: 'none', path: null, status: 'none' },
    ])
  })

  // The quoted comment cancels both annotations before it, and one after it still names.
  test("a quoted line comment cancels the URL before it and keeps the `debugId` after it", async () => {
    const id = '85314830-023f-4cf1-a267-535f4e37bb17'
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${code};\n//# sourceMappingURL=a.js.map\n// 'x'\n//# debugId=${id}`,
      'a.js.map': codeMap(),
      'maps/3f2a.map': codeMap({ debugId: id }),
    })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'debug-id', path: 'maps/3f2a.map', status: 'verified' })
  })

  test('a quoted line comment cancels the `debugId` before it', async () => {
    const id = '85314830-023f-4cf1-a267-535f4e37bb17'
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${code};\n//# debugId=${id}\n// don't edit`,
      'maps/3f2a.map': codeMap({ debugId: id }),
    })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
  })

  test('a `data:` URL holds the map, base64 or percent-encoded, for a file or an inline script', async () => {
    const base64 = `data:application/json;charset=utf-8;base64,${btoa(codeMap())}`
    // A fragment is not part of the data (Fetch § data: URL processor).
    const percent = `data:application/json,${encodeURIComponent(codeMap())}#not-json`
    const emptyFragment = `data:application/json,${encodeURIComponent(codeMap())}#`
    const { report } = await scanBuild({
      'index.html': `<script src="a.js"></script><script src="b.js"></script><script src="c.js"></script><script>${code}\n//# sourceMappingURL=${base64}</script>`,
      'a.js': `${code}\n//# sourceMappingURL=${base64}`,
      'b.js': `${code};\n//# sourceMappingURL=${percent}`,
      'c.js': `${code};;\n//# sourceMappingURL=${emptyFragment}`,
    })

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'annotation', path: null, status: 'verified' },
      { method: 'annotation', path: null, status: 'verified' },
      { method: 'annotation', path: null, status: 'verified' },
      { method: 'annotation', path: null, status: 'verified' },
    ])
  })

  test('a local artifact never fetches a map, and a fetched one reads its maps through the fetcher', async () => {
    const fetcher = served({
      'https://cdn.example/lib.js': js(`${remoteCode}\n//# sourceMappingURL=lib.js.map`),
      'https://cdn.example/lib.js.map': { body: codeMap() },
      'https://cdn.example/deprecated.js': js(`${remoteCode};`, { 'X-SourceMap': 'lib.js.map' }),
      // It would verify, if it were fetched.
      'https://maps.example/main.js.map': { body: codeMap() },
    })
    const { report } = await scanResolved(
      {
        'index.html': [
          '<script src="main.js"></script>',
          '<script src="https://cdn.example/lib.js"></script>',
          '<script src="https://cdn.example/deprecated.js"></script>',
        ].join(''),
        'main.js': `${code}\n//# sourceMappingURL=https://maps.example/main.js.map`,
      },
      fetcher,
    )

    expect(report.artifacts.map(({ url, sourceMap }: Json) => [url, sourceMap.method])).toEqual([
      [main, 'none'],
      ['https://cdn.example/deprecated.js', 'header'],
      ['https://cdn.example/lib.js', 'annotation'],
    ])
    expect(new Set(fetcher.requests.map(([url]) => url))).toEqual(
      new Set(['https://cdn.example/deprecated.js', 'https://cdn.example/lib.js', 'https://cdn.example/lib.js.map']),
    )
  })
})

describe('verification (§2 Source maps)', () => {
  /** This build's code, which the map of an earlier build (`codeMap`) was not made for. */
  const rebuilt = 'var a=window.fetch;window.fetch=function(){return a()}'

  test('a map from a different build fails verification, is `stale`, and the next method is tried', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      // The annotation names the earlier build's map, whose segment at column 7 splits `window`.
      'main.js': `${rebuilt}\n//# sourceMappingURL=old/main.js.map`,
      'old/main.js.map': codeMap(),
      // The sidecar is this build's.
      'main.js.map': sourceMap([
        [
          [0, 0, 0, 0],
          [6, 0, 0, 6],
          [19, 0, 0, 19],
        ],
      ]),
    })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'sidecar', path: 'main.js.map', status: 'verified' })
    expect(report.completeness.attribution.staleCandidates).toBe(1)
  })

  test('an artifact whose every candidate fails is `stale`, with no method and the first candidate\'s path', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${rebuilt}\n//# sourceMappingURL=old/main.js.map`,
      'old/main.js.map': codeMap(),
      'main.js.map': codeMap(),
    })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: 'old/main.js.map', status: 'stale' })
  })

  test.each([
    ['a mapped line past the end of the artifact', sourceMap([[[0, 0, 0, 0]], [], [[0, 0, 1, 0]]])],
    ['a mapped column past the end of its line', sourceMap([[[17, 0, 0, 0]]])],
    ['a mapped position inside a token', sourceMap([[[2, 0, 0, 0]]])],
    ['a version other than 3', codeMap({ version: 2 })],
    ['mappings that are not a string', codeMap({ mappings: [[[0, 0, 0, 0]]] })],
    ['text that is not JSON', '{"version":3,'],
    ["a debugId that is not the artifact's", codeMap({ debugId: '00000000-0000-4000-8000-000000000000' })],
  ])('a map with %s is `stale`', async (_, map) => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${code}\n//# debugId=85314830-023f-4cf1-a267-535f4e37bb17`,
      'main.js.map': map,
    })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: 'main.js.map', status: 'stale' })
  })

  test('a map verifies at the end of a line, with a BOM or a `)]}\'` line before its JSON, and with no segments', async () => {
    const endOfLine = sourceMap([[[16, 0, 0, 0]]])
    const { report } = await scanBuild({
      'index.html': ['a', 'b', 'c'].map((name) => `<script src="${name}.js"></script>`).join(''),
      'a.js': code,
      'a.js.map': `\ufeff${endOfLine}`,
      // Each file's bytes differ, so that each is its own artifact.
      'b.js': `${code} `,
      'b.js.map': `)]}'\n${codeMap()}`,
      'c.js': `${code}  `,
      'c.js.map': sourceMap([]),
    })

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap.status)).toEqual(['verified', 'verified', 'verified'])
  })

  test('an artifact with a raw U+2028 verifies whether its map splits lines there or not', async () => {
    // A string literal may hold a raw U+2028, a LineTerminator (§5) that some tools don't split lines at.
    const text = 'var s="a\u2028b";window.fetch=f'
    const { report } = await scanBuild({
      'index.html': '<script src="a.js"></script><script src="b.js"></script>',
      'a.js': text,
      'a.js.map': sourceMap([[[0, 0, 0, 0], [12, 0, 0, 0]]]),
      'b.js': `${text};`,
      'b.js.map': sourceMap([[[0, 0, 0, 0]], [[3, 0, 0, 0]]]),
    })

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap.status)).toEqual(['verified', 'verified'])
  })

  describe('a sectioned map (an index map)', () => {
    /** Two scripts on one line: the second starts at column 17. */
    const joined = 'window.fetch = f;document.title = t'
    /** An index map of two sections, one per script, the second at `column`. */
    const indexMap = (column: number) =>
      JSON.stringify({
        version: 3,
        sections: [
          { offset: { line: 0, column: 0 }, map: JSON.parse(codeMap()) },
          {
            offset: { line: 0, column },
            map: JSON.parse(sourceMap([[[0, 0, 0, 0], [9, 0, 0, 9]]], { sources: ['../src/title.js'] })),
          },
        ],
      })

    test('is read, with each section at its offset', async () => {
      const { report } = await scanBuild({
        'index.html': '<script src="main.js"></script>',
        'main.js': `${joined}\n//# sourceMappingURL=main.js.map`,
        'main.js.map': indexMap(17),
      })

      expect(report.artifacts[0].sourceMap).toEqual({ method: 'annotation', path: 'main.js.map', status: 'verified' })
    })

    test('is `stale` when a section, at its offset, splits a token', async () => {
      const { report } = await scanBuild({
        'index.html': '<script src="main.js"></script>',
        'main.js': `${joined}\n//# sourceMappingURL=main.js.map`,
        'main.js.map': indexMap(18),
      })

      expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: 'main.js.map', status: 'stale' })
    })
  })
})

describe('which named paths the listing holds (§2 Source maps, §13 `unreadable`)', () => {
  const id = '85314830-023f-4cf1-a267-535f4e37bb17'
  // The script's sidecar can't be read, and a map elsewhere carries its `debugId`, so pairing can fall through to it.
  const build = {
    'index.html': '<script src="main.js"></script>',
    'main.js': `${code}\n//# debugId=${id}`,
    'maps/z.map': codeMap({ debugId: id }),
    'cdn/notes.txt': '',
  }
  // A longer prefix reads the sidecar's URL, and every URL under it, from `cdn`, so no mapping serves its path.
  const shadowed = ['--map', 'https://app.example/=.', '--map', 'https://app.example/main.js.map=cdn']
  const byDebugId = { method: 'debug-id', path: 'maps/z.map', status: 'verified' }

  test.each<[string, string, string]>([
    ['an annotation target', '//# sourceMappingURL=maps/loop', 'maps/loop'],
    ['a sidecar', '', 'main.js.map'],
  ])('%s at a loop link the sweep stops at is `unreadable` (EISDIR)', async (_, tail, path) => {
    const dir = fixtureBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': `${code}\n${tail}`, 'maps/a': '' })
    symlinkSync('.', join(dir, path))
    const { report } = await scanBuild(dir)

    expect(report.completeness.limitations).toEqual([
      {
        kind: 'unreadable',
        artifact: { url: `https://app.example/${path}`, path },
        detail: expect.stringContaining('EISDIR'),
      },
    ])
    expect(report.completeness.level).toBe('incomplete')
  })

  /** Scans `dir` with `args`, with the directory `locked` unlistable, and restores it after. */
  async function scanLocked(dir: string, locked: string, args: string[] = []): Promise<Json> {
    chmodSync(join(dir, locked), 0o000)
    try {
      return (await scanBuild(dir, args)).report
    } finally {
      chmodSync(join(dir, locked), 0o755)
    }
  }

  test("a sidecar at a directory the sweep can't list, and records, is `unreadable` beside the sweep's record", async () => {
    const dir = fixtureBuild(build)
    mkdirSync(join(dir, 'main.js.map'))
    const report = await scanLocked(dir, 'main.js.map')

    expect(report.completeness.limitations).toEqual([
      {
        kind: 'unreadable',
        artifact: { url: 'https://app.example/main.js.map', path: 'main.js.map' },
        detail: expect.any(String),
      },
      { kind: 'unreadable', artifact: { path: 'main.js.map' }, detail: expect.stringContaining('EACCES') },
    ])
    expect(report.artifacts[0].sourceMap).toEqual(byDebugId)
  })

  test("a sidecar at a directory the sweep can't list, and doesn't record, gives no record", async () => {
    const dir = fixtureBuild(build)
    mkdirSync(join(dir, 'main.js.map'))
    const report = await scanLocked(dir, 'main.js.map', shadowed)

    expect(report.artifacts[0].sourceMap).toEqual(byDebugId)
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.level).toBe('complete')
  })

  test("a sidecar at a link whose target the sweep can't reach, and no mapping serves, gives no record", async () => {
    const dir = fixtureBuild(build)
    const outside = join(dir, '../private')
    mkdirSync(outside)
    writeFileSync(join(outside, 'main.js.map'), codeMap())
    symlinkSync('../private/main.js.map', join(dir, 'main.js.map'))
    const report = await scanLocked(dir, '../private', shadowed)

    expect(report.artifacts[0].sourceMap).toEqual(byDebugId)
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.level).toBe('complete')
  })

  describe('a named map spelled otherwise than its listed path is held when it is the same file', () => {
    const cases: [string, string, (dir: string) => void][] = [
      ['through a link `self -> .`', 'self/app.map', (dir) => symlinkSync('.', join(dir, 'self'))],
    ]
    if (caseInsensitive()) cases.push(['in another case, on a case-insensitive file system', 'App.map', () => {}])

    test.each(cases)("%s: it is `unreadable` when it can't be read", async (_, named, prepare) => {
      const dir = fixtureBuild({
        'index.html': '<script src="app.js"></script>',
        'app.js': `${code}\n//# sourceMappingURL=${named}`,
        'app.map': codeMap(),
      })
      prepare(dir)
      chmodSync(join(dir, 'app.map'), 0o000)
      const { report } = await scanBuild(dir)

      expect(report.completeness.limitations).toEqual([
        {
          kind: 'unreadable',
          artifact: { url: `https://app.example/${named}`, path: named },
          detail: expect.stringContaining('EACCES'),
        },
      ])
      expect(report.completeness.level).toBe('incomplete')
    })

    test.each(cases)('%s: it pairs when it can be read', async (_, named, prepare) => {
      const dir = fixtureBuild({
        'index.html': '<script src="app.js"></script>',
        'app.js': `${code}\n//# sourceMappingURL=${named}`,
        'app.map': codeMap(),
      })
      prepare(dir)
      const { report } = await scanBuild(dir)

      expect(report.artifacts[0].sourceMap).toEqual({ method: 'annotation', path: named, status: 'verified' })
      expect(report.completeness.level).toBe('complete')
    })
  })
})

/** Whether the file system that holds scratch directories ignores case in names, as macOS's APFS does by default. */
function caseInsensitive(): boolean {
  const dir = fixtureBuild({ probe: '' })
  return existsSync(join(dir, 'PROBE'))
}

/**
 * Makes `path`, in the build directory `dir`, the first of `length` symbolic links in a chain, which ends at a map
 * outside it: more links than a system follows (32 on macOS, 40 on Linux) when `length` is over 40.
 */
function linkChain(dir: string, path: string, length: number): void {
  const chain = join(dir, '../chain')
  mkdirSync(chain)
  writeFileSync(join(chain, 'end.map'), codeMap())
  for (let i = 1; i < length; i++) symlinkSync(i === length - 1 ? 'end.map' : `link-${i + 1}`, join(chain, `link-${i}`))
  symlinkSync('../chain/link-1', join(dir, path))
}

describe('a source map that exists but can\'t be read (§2 Source maps, §13 `unreadable`)', () => {
  const locked = (files: Record<string, string>, path: string) => {
    const dir = fixtureBuild(files)
    chmodSync(join(dir, path), 0o000)
    return dir
  }
  const mapUrl = (path: string) => `https://app.example/${path}`

  test("an annotation's target that can't be read is `unreadable`, and the scan is `incomplete`", async () => {
    const dir = locked(
      {
        'index.html': '<script src="main.js"></script><script src="missing.js"></script>',
        'main.js': `${code}\n//# sourceMappingURL=maps/main.js.map`,
        'maps/main.js.map': codeMap(),
        // A target that doesn't exist is a missing map, as before.
        'missing.js': `${code};\n//# sourceMappingURL=maps/missing.js.map`,
      },
      'maps/main.js.map',
    )
    const { report } = await scanBuild(dir)

    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.limitations).toEqual([
      {
        kind: 'unreadable',
        artifact: { url: mapUrl('maps/main.js.map'), path: 'maps/main.js.map' },
        detail: expect.stringContaining('EACCES'),
      },
    ])
    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'none', path: null, status: 'none' },
      { method: 'none', path: null, status: 'none' },
    ])
    expect(report.completeness.attribution.artifacts).toEqual({ withMap: 0, withoutMap: 2, withBrokenMap: 0 })
    // The script was read and analyzed: only its map failed.
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 2, analyzed: 2 })
    expect(report.completeness.counters.artifacts.failed.unreadable).toBe(0)
  })

  test("an existing sidecar that can't be read is `unreadable`", async () => {
    const dir = locked(
      { 'index.html': '<script src="main.js"></script>', 'main.js': code, 'main.js.map': codeMap() },
      'main.js.map',
    )
    const { report } = await scanBuild(dir)

    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.limitations).toEqual([
      {
        kind: 'unreadable',
        artifact: { url: mapUrl('main.js.map'), path: 'main.js.map' },
        detail: expect.stringContaining('EACCES'),
      },
    ])
    expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
  })

  // The listing holds the directories it walks, and a path that ends in `/` names one too.
  test.each(['maps/main.js.map', 'maps/main.js.map/'])("a named map that is a directory can't be read either: %s", async (path) => {
    const dir = fixtureBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${code}\n//# sourceMappingURL=${path}`,
    })
    mkdirSync(join(dir, 'maps/main.js.map'), { recursive: true })
    const { report } = await scanBuild(dir)

    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.limitations).toEqual([
      { kind: 'unreadable', artifact: { url: mapUrl(path), path }, detail: expect.stringContaining('EISDIR') },
    ])
  })

  test("a named map that is a link whose target the sweep can't reach is `unreadable`", async () => {
    const dir = fixtureBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
    const locked = join(dir, '../private')
    mkdirSync(locked)
    writeFileSync(join(locked, 'main.js.map'), codeMap())
    symlinkSync('../private/main.js.map', join(dir, 'main.js.map'))
    chmodSync(locked, 0o000)
    let report: Json
    try {
      ;({ report } = await scanBuild(dir))
    } finally {
      chmodSync(locked, 0o755)
    }

    // The sidecar's record, and the sweep's: the listing holds the link.
    expect(report.completeness.limitations).toEqual([
      {
        kind: 'unreadable',
        artifact: { url: mapUrl('main.js.map'), path: 'main.js.map' },
        detail: expect.stringContaining('EACCES'),
      },
      { kind: 'unreadable', artifact: { path: 'main.js.map' }, detail: expect.stringContaining('EACCES') },
    ])
  })

  test("an inline script's annotation target that can't be read is `unreadable`", async () => {
    const dir = locked(
      {
        'index.html': `<script>${code}\n//# sourceMappingURL=maps/inline.js.map</script>`,
        'maps/inline.js.map': codeMap(),
      },
      'maps/inline.js.map',
    )
    const { report } = await scanBuild(dir)

    expect(report.completeness.limitations).toEqual([
      {
        kind: 'unreadable',
        artifact: { url: mapUrl('maps/inline.js.map'), path: 'maps/inline.js.map' },
        detail: expect.stringContaining('EACCES'),
      },
    ])
  })

  test('the next method is still tried, and a map two methods name gives one record', async () => {
    const dir = locked(
      {
        'index.html': '<script src="a.js"></script><script src="b.js"></script>',
        // The annotation's map can't be read, and the sidecar verifies.
        'a.js': `${code}\n//# sourceMappingURL=maps/a.js.map`,
        'maps/a.js.map': codeMap(),
        'a.js.map': codeMap(),
        // The annotation names the sidecar, which can't be read.
        'b.js': `${code};\n//# sourceMappingURL=b.js.map`,
        'b.js.map': codeMap(),
      },
      'maps/a.js.map',
    )
    chmodSync(join(dir, 'b.js.map'), 0o000)
    const { report } = await scanBuild(dir)

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'sidecar', path: 'a.js.map', status: 'verified' },
      { method: 'none', path: null, status: 'none' },
    ])
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.path])).toEqual([
      ['unreadable', 'b.js.map'],
      ['unreadable', 'maps/a.js.map'],
    ])
  })

  test.each<[string, string, (dir: string) => void]>([
    ['a missing annotation target', '//# sourceMappingURL=maps/main.js.map', () => {}],
    ['an annotation target under a file', '//# sourceMappingURL=index.html/main.js.map', () => {}],
    ['an annotation URL that names no path', '//# sourceMappingURL=maps/%E0%A4%A.map', () => {}],
    // No file can have a name with a NUL, or one longer than a file system allows (255 bytes).
    ['an annotation target whose name holds a NUL', '//# sourceMappingURL=maps/main%00.js.map', () => {}],
    ['an annotation target whose name is too long', `//# sourceMappingURL=${'m'.repeat(300)}.map`, () => {}],
    ['a dangling sidecar link', '', (dir) => symlinkSync('gone.map', join(dir, 'main.js.map'))],
    ['a sidecar link cycle', '', (dir) => symlinkSync('main.js.map', join(dir, 'main.js.map'))],
    // A map exists when the sweep's listing holds it. A URL whose percent-encoding is
    // malformed names no path, though a file has its literal name. The listing drops a link chain too long to follow.
    [
      'an annotation URL with malformed percent-encoding, though a file has its literal name',
      '//# sourceMappingURL=maps/a%ZZ.map',
      (dir) => (mkdirSync(join(dir, 'maps')), writeFileSync(join(dir, 'maps/a%ZZ.map'), codeMap())),
    ],
    ['a sidecar at the end of a link chain too long to follow', '', (dir) => linkChain(dir, 'main.js.map', 50)],
  ])('a named map that is not there gives no record: %s', async (_, tail, prepare) => {
    const dir = fixtureBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': `${code}\n${tail}` })
    prepare(dir)
    const { report } = await scanBuild(dir)

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
    expect(report.completeness.attribution.artifacts).toEqual({ withMap: 0, withoutMap: 1, withBrokenMap: 0 })
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
  })

  // A named map exists when the sweep's listing holds it, whatever the read error.
  test("a named sidecar the listing holds, whose absolute path is too long to read, is `unreadable`", async () => {
    // The longest absolute path a system call takes, in bytes, with its NUL: PATH_MAX (MAXPATHLEN on macOS).
    const pathMax = process.platform === 'darwin' ? 1024 : 4096
    // The build directory's real path, so that no symbolic link in it (macOS's `/var`) lengthens what the kernel reads.
    const dir = realpathSync(fixtureBuild({}))
    // Directories whose names are valid, so deep that the script's absolute path is 2 bytes short of the limit and its
    // sidecar's is 2 over. Nothing can create a file that deep by its absolute path, so the files are written to a
    // short directory, which is moved into place.
    const length = pathMax - 2 - `${dir}/`.length - '/leaf/app.js'.length
    const count = Math.ceil(length / 200)
    const names = Array.from({ length: count }, (_, i) => 'd'.repeat(i < count - 1 ? 199 : length - 200 * (count - 1)))
    const deep = names.join('/')
    mkdirSync(join(dir, deep), { recursive: true })
    const leaf = join(dir, '../leaf')
    mkdirSync(leaf)
    writeFileSync(join(leaf, 'app.js'), code)
    writeFileSync(join(leaf, 'app.js.map'), codeMap())
    renameSync(leaf, join(dir, deep, 'leaf'))
    writeFileSync(join(dir, 'index.html'), `<script src="${deep}/leaf/app.js"></script>`)

    try {
      expect(`${dir}/${deep}/leaf/app.js`.length).toBe(pathMax - 2)
      const { report } = await scanBuild(dir)

      expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
      expect(report.completeness.level).toBe('incomplete')
      expect(report.completeness.limitations).toEqual([
        {
          kind: 'unreadable',
          artifact: { url: mapUrl(`${deep}/leaf/app.js.map`), path: `${deep}/leaf/app.js.map` },
          detail: expect.stringContaining('ENAMETOOLONG'),
        },
      ])
    } finally {
      // Moved back out, so that removing the scratch directory never meets a path that long.
      renameSync(join(dir, deep, 'leaf'), leaf)
    }
  })

  test('a script whose sidecar name would be too long to exist has no sidecar, and gives no record', async () => {
    // 253 bytes is a valid file name, and its sidecar's, 257 bytes, is not.
    const name = `${'b'.repeat(250)}.js`
    const { report } = await scanBuild({ 'index.html': `<script src="${name}"></script>`, [name]: code })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
  })

  test('an unreadable `.map` that no method names gives no record', async () => {
    const id = '85314830-023f-4cf1-a267-535f4e37bb17'
    const dir = locked(
      {
        'index.html': '<script src="main.js"></script>',
        // The `debugId` search meets the locked map, which is known to belong to no artifact.
        'main.js': `${code}\n//# debugId=${id}`,
        'maps/locked.map': codeMap({ debugId: id }),
        'maps/z.map': codeMap({ debugId: id }),
      },
      'maps/locked.map',
    )
    const { report } = await scanBuild(dir)

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'debug-id', path: 'maps/z.map', status: 'verified' })
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
  })

  test("a remote script's map that is a build file and can't be read changes no record", async () => {
    const fetcher = served({
      'https://cdn.example/lib.js': js(`${remoteCode}\n//# sourceMappingURL=https://app.example/maps/lib.js.map`),
    })
    const dir = locked(
      { 'index.html': '<script src="https://cdn.example/lib.js"></script>', 'maps/lib.js.map': codeMap() },
      'maps/lib.js.map',
    )
    const { report } = await scanResolved(dir, fetcher)

    expect(artifact(report, 'https://cdn.example/lib.js').sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
  })
})

describe('the attribution block (§13)', () => {
  test('counts the artifacts with, without and with broken maps, and those with a map by pairing method', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script src="annotated.js"></script>',
        '<script src="sidecar.js"></script>',
        '<script src="stale.js"></script>',
        '<script src="bare.js"></script>',
        '<script src="https://cdn.example/remote.js"></script>',
        '<script>window.x = 1</script>',
      ].join(''),
      // A page script and a dedicated worker: one file, an artifact in each realm, each counted.
      'annotated.js': `new Worker("annotated.js");${code}\n//# sourceMappingURL=annotated.js.map`,
      'annotated.js.map': sourceMap([[[0, 0, 0, 0], [27, 0, 0, 0]]]),
      'sidecar.js': `${code};`,
      'sidecar.js.map': codeMap(),
      'stale.js': 'var a=window.fetch;window.fetch=function(){return a()}',
      'stale.js.map': codeMap(),
      'bare.js': `${code};;`,
    })

    expect(report.artifacts.map(({ url, realm, sourceMap }: Json) => [url, realm, sourceMap.method, sourceMap.status])).toEqual([
      ['https://app.example/#inline-1', 'window', 'none', 'none'],
      ['https://app.example/annotated.js', 'window', 'annotation', 'verified'],
      ['https://app.example/annotated.js', 'dedicated-worker', 'annotation', 'verified'],
      ['https://app.example/bare.js', 'window', 'none', 'none'],
      ['https://app.example/sidecar.js', 'window', 'sidecar', 'verified'],
      ['https://app.example/stale.js', 'window', 'none', 'stale'],
      ['https://cdn.example/remote.js', 'window', 'none', 'none'],
    ])
    expect(report.completeness.attribution).toEqual({
      artifacts: { withMap: 3, withoutMap: 3, withBrokenMap: 1 },
      pairings: {
        header: 0,
        annotation: 2,
        sidecar: 1,
        'debug-id': 0,
        'external-debug-id': 0,
        'external-annotation': 0,
        'external-sidecar': 0,
      },
      // `stale.js.map` was an earlier build's.
      staleCandidates: 1,
      unreadMaps: { refused: 0, failed: 0, unreadable: 0 },
      sourceMapDirectories: [],
      // The maps' `../src/app.js` lies outside the root, the build directory, as no package source is anywhere: it is
      // escaped (low). `stale.js` wraps `fetch`, a finding of its own, escaped too.
      cappedFindings: { medium: 0, low: 2 },
      introducers: { reason: 'no-lockfile', evidence: null },
    })
    expect(report.completeness.counters.artifacts.known).toBe(7)
  })

  test('counts every candidate that fails verification as `stale`, including one a later map replaces', async () => {
    const rebuilt = 'var a=window.fetch;window.fetch=function(){return a()}'
    const { report } = await scanBuild({
      'index.html': ['a', 'b', 'c', 'd'].map((name) => `<script src="${name}.js"></script>`).join(''),
      // The annotation's map is an earlier build's, and the sidecar is this one's: one stale candidate.
      'a.js': `${rebuilt}\n//# sourceMappingURL=old/a.js.map`,
      'old/a.js.map': codeMap(),
      'a.js.map': sourceMap([[[0, 0, 0, 0], [6, 0, 0, 6], [19, 0, 0, 19]]]),
      // Both candidates are an earlier build's: two.
      'b.js': `${rebuilt};\n//# sourceMappingURL=old/b.js.map`,
      'old/b.js.map': codeMap(),
      'b.js.map': codeMap(),
      // The annotation names the sidecar, which is tried once: one.
      'c.js': `${rebuilt};;\n//# sourceMappingURL=c.js.map`,
      'c.js.map': codeMap(),
      // The first candidate verifies: none.
      'd.js': `${code}\n//# sourceMappingURL=d.js.map`,
      'd.js.map': codeMap(),
    })

    expect(report.artifacts.map(({ sourceMap }: Json) => [sourceMap.method, sourceMap.status])).toEqual([
      ['sidecar', 'verified'],
      ['none', 'stale'],
      ['none', 'stale'],
      ['annotation', 'verified'],
    ])
    expect(report.completeness.attribution).toMatchObject({
      artifacts: { withMap: 2, withoutMap: 0, withBrokenMap: 2 },
      staleCandidates: 4,
    })
  })

  test('missing and broken maps are not coverage limitations', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script><script src="stale.js"></script>',
      'main.js': `${code}\n//# sourceMappingURL=missing.js.map`,
      'stale.js': `${code};\n//# sourceMappingURL=data:application/json;base64,e30=`,
    })

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'none', path: null, status: 'none' },
      { method: 'none', path: null, status: 'stale' },
    ])
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
  })
})

describe('determinism (§15)', () => {
  test('two scans of copies of a build with source maps give byte-identical reports, except run', async () => {
    const id = '85314830-023f-4cf1-a267-535f4e37bb17'
    const files = {
      'index.html': ['a', 'b', 'c', 'd'].map((name) => `<script src="${name}.js"></script>`).join(''),
      'a.js': `${code}\n//# sourceMappingURL=a.js.map`,
      'a.js.map': codeMap(),
      'b.js': `${code};`,
      'b.js.map': codeMap(),
      'c.js': `${code};;\n//# debugId=${id}`,
      'maps/z.map': codeMap({ debugId: id }),
      'maps/y.map': codeMap({ debugId: id, version: 2 }),
      'd.js': 'var a=window.fetch;window.fetch=function(){return a()}\n//# sourceMappingURL=a.js.map',
    }

    const first = await scanBuild(files)
    const second = await scanBuild(files)

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
    expect(first.report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'annotation', path: 'a.js.map', status: 'verified' },
      { method: 'sidecar', path: 'b.js.map', status: 'verified' },
      // The stale map at `maps/y.map` sorts first, and the next is tried.
      { method: 'debug-id', path: 'maps/z.map', status: 'verified' },
      { method: 'none', path: 'a.js.map', status: 'stale' },
    ])
  })
})


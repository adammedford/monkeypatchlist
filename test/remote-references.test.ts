// Remote references and SRI (§17 What is fetched, Integrity; §2 Discovery). Scans run end to end through
// `monkeypatchlist scan --json -` in `--mode resolve`, with the fixture fetcher swapped in as the CLI's resolve fetcher.

import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { Fetcher } from '../src/packages/source-store/index.ts'
import { fixtureFetcher, type RecordedResponse } from '../src/packages/source-store/fixture.ts'
import { fakeNetwork } from './support/fake-network.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const resolve = ['--mode', 'resolve']

/** The Subresource Integrity digest of `text`: the algorithm, `-`, and the base64 value. */
const digest = (algorithm: 'sha256' | 'sha384' | 'sha512', text: string) =>
  `${algorithm}-${createHash(algorithm).update(text).digest('base64')}`

/** A recorded JavaScript response with `body`. */
const js = (body: string): RecordedResponse => ({ headers: { 'content-type': 'text/javascript' }, body })

/** The fixture fetcher over `responses`, recording each URL it is asked for. */
function served(responses: Record<string, RecordedResponse>): Fetcher & { urls: string[] } {
  const fixture = fixtureFetcher(responses)
  const urls: string[] = []
  return { urls, fetch: (url, request) => (urls.push(url), fixture.fetch(url, request)) }
}

/** Scans `files` in resolve mode, fetching through `fetcher`. */
const scanResolved = (files: Record<string, string>, fetcher: Fetcher) =>
  scanBuild(files, resolve, { deps: { resolveFetcher: () => fetcher } })

/** Each artifact's URL, realm, source type, parent and retrieval status. */
const graph = (report: Json) =>
  report.artifacts.map(({ url, realm, sourceType, parent, retrieval }: Json) => [
    url,
    realm,
    sourceType,
    parent,
    retrieval.status,
  ])

/** A retrieval record's integrity check: `none`, or whether the bytes matched. */
const sriResult = ({ sri }: Json) => (sri === 'none' ? sri : sri.result)

/** Each artifact's URL, retrieval status and integrity check. */
const checks = (report: Json) =>
  report.artifacts.map(({ url, retrieval }: Json) => [url, retrieval.status, sriResult(retrieval)])

/** Each finding's target key and the artifact URL of its first occurrence. */
const found = (report: Json) =>
  report.findings.map(({ targetKey, occurrences }: Json) => [targetKey, occurrences[0].artifact.url])

describe('what is fetched (§17 What is fetched)', () => {
  test('a remote module that imports another is fetched in turn, and so is what that one imports', async () => {
    const fetcher = served({
      'https://cdn.example/sdk/main.js': js('import "./util.js"; import("https://other.example/lazy.js")'),
      'https://cdn.example/sdk/util.js': js('export {} from "/shared/deep.js"; window.fetch = f'),
      'https://cdn.example/shared/deep.js': js('window.alert = g'),
      'https://other.example/lazy.js': js('window.open = h'),
    })

    const { report } = await scanResolved(
      { 'index.html': '<script type="module" src="https://cdn.example/sdk/main.js"></script>' },
      fetcher,
    )

    expect(graph(report)).toEqual([
      ['https://cdn.example/sdk/main.js', 'window', 'module', 'https://app.example/', 'ok'],
      ['https://cdn.example/sdk/util.js', 'window', 'module', 'https://cdn.example/sdk/main.js', 'ok'],
      ['https://cdn.example/shared/deep.js', 'window', 'module', 'https://cdn.example/sdk/util.js', 'ok'],
      ['https://other.example/lazy.js', 'window', 'module', 'https://cdn.example/sdk/main.js', 'ok'],
    ])
    expect(found(report)).toEqual([
      ['window|Window.alert|replace', 'https://cdn.example/shared/deep.js'],
      ['window|Window.fetch|replace', 'https://cdn.example/sdk/util.js'],
      ['window|Window.open|replace', 'https://other.example/lazy.js'],
    ])
    expect(report.completeness.level).toBe('complete')
    expect(fetcher.urls.sort()).toEqual([
      'https://cdn.example/sdk/main.js',
      'https://cdn.example/sdk/util.js',
      'https://cdn.example/shared/deep.js',
      'https://other.example/lazy.js',
    ])
  })

  test('`modulepreload` and import-map targets, worker URLs and `importScripts` are fetched, from local and fetched code', async () => {
    const fetcher = served({
      'https://cdn.example/preloaded.js': js('window.fetch = f'),
      'https://cdn.example/mapped/index.js': js(
        'import "vendor/extra.js"; new Worker("https://app.example/worker.js")',
      ),
      'https://cdn.example/mapped/extra.js': js('window.alert = g'),
      'https://cdn.example/classic.js': js('import("https://cdn.example/from-classic.js")'),
      'https://cdn.example/from-classic.js': js('window.open = h'),
      'https://cdn.example/imported.js': js('self.fetch = f'),
    })
    const files = {
      'index.html': [
        '<script type="importmap">{ "imports": { "vendor/": "https://cdn.example/mapped/" } }</script>',
        '<link rel="modulepreload" href="https://cdn.example/preloaded.js">',
        '<script type="module">import "vendor/index.js"</script>',
        '<script src="https://cdn.example/classic.js"></script>',
      ].join(''),
      'worker.js': 'importScripts("https://cdn.example/imported.js")',
    }

    const { report } = await scanResolved(files, fetcher)

    expect(graph(report)).toEqual([
      ['https://app.example/#inline-2', 'window', 'module', 'https://app.example/', 'ok'],
      ['https://app.example/worker.js', 'dedicated-worker', 'script', 'https://cdn.example/mapped/index.js', 'ok'],
      ['https://cdn.example/classic.js', 'window', 'script', 'https://app.example/', 'ok'],
      ['https://cdn.example/from-classic.js', 'window', 'module', 'https://cdn.example/classic.js', 'ok'],
      ['https://cdn.example/imported.js', 'dedicated-worker', 'script', 'https://app.example/worker.js', 'ok'],
      ['https://cdn.example/mapped/extra.js', 'window', 'module', 'https://cdn.example/mapped/index.js', 'ok'],
      ['https://cdn.example/mapped/index.js', 'window', 'module', 'https://app.example/#inline-2', 'ok'],
      ['https://cdn.example/preloaded.js', 'window', 'module', 'https://app.example/', 'ok'],
    ])
    expect(report.completeness.limitations).toEqual([])
  })

  test('fetched artifacts are reached only by reference, never swept, and identical bytes share one analysis', async () => {
    const fetcher = served({
      'https://cdn.example/a.js': js('window.fetch = f'),
      'https://mirror.example/a.js': js('window.fetch = f'),
      'https://cdn.example/chunk.js': js('window.alert = g'),
    })

    const { report } = await scanResolved(
      { 'index.html': ['cdn', 'mirror'].map((host) => `<script src="https://${host}.example/a.js"></script>`).join('') },
      fetcher,
    )

    expect(fetcher.urls.sort()).toEqual(['https://cdn.example/a.js', 'https://mirror.example/a.js'])
    // Each URL keeps its own record, and its own occurrence (§2 Artifacts).
    expect(report.artifacts.map(({ url, discovery }: Json) => [url, discovery])).toEqual([
      ['https://cdn.example/a.js', 'reference'],
      ['https://mirror.example/a.js', 'reference'],
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 2, analyzed: 2, sweepOnly: 0 })
    // Each URL keys `url:` by itself (§11), so each gives its own finding from the one analysis.
    expect(found(report)).toEqual([
      ['window|Window.fetch|replace', 'https://cdn.example/a.js'],
      ['window|Window.fetch|replace', 'https://mirror.example/a.js'],
    ])
  })

  test('a redirected script’s relative references are fetched against its final URL, and keyed against its requested one', async () => {
    const fetcher = served({
      'https://cdn.example/latest/sdk.js': { status: 302, headers: { location: '/v3/sdk.js' } },
      'https://cdn.example/v3/sdk.js': js('import "./util.js"; import("./lazy.js")'),
      'https://cdn.example/v3/util.js': js('window.fetch = f'),
      'https://cdn.example/v3/lazy.js': js('window.alert = g'),
    })

    const { report } = await scanResolved(
      { 'index.html': '<script type="module" src="https://cdn.example/latest/sdk.js"></script>' },
      fetcher,
    )

    expect(graph(report)).toEqual([
      ['https://cdn.example/latest/lazy.js', 'window', 'module', 'https://cdn.example/latest/sdk.js', 'ok'],
      ['https://cdn.example/latest/sdk.js', 'window', 'module', 'https://app.example/', 'ok'],
      ['https://cdn.example/latest/util.js', 'window', 'module', 'https://cdn.example/latest/sdk.js', 'ok'],
    ])
    expect(report.artifacts[1].retrieval.finalUrl).toBe('https://cdn.example/v3/sdk.js')
    // Each is fetched against the final URL (§11).
    expect(report.artifacts[0].retrieval.requestedUrl).toBe('https://cdn.example/v3/lazy.js')
    expect(report.completeness.limitations).toEqual([])
  })

  test('a redirected worker script’s `importScripts` are fetched against its final URL and keyed against its requested one, and its creator’s resolve against the page', async () => {
    const fetcher = served({
      'https://app.example/js/boot.js': js('new Worker("worker/latest.js")'),
      'https://app.example/worker/latest.js': { status: 302, headers: { location: '/worker/v2/worker.js' } },
      'https://app.example/worker/v2/worker.js': js('importScripts("./helper.js")'),
      'https://app.example/worker/v2/helper.js': js('self.fetch = f'),
    })

    const { report } = await scanBuild(
      { 'index.html': '<script src="/js/boot.js"></script>', 'static/app.js': '' },
      [...resolve, '--map', 'https://app.example/static/=static', '--entry', 'index.html@https://app.example/'],
      { deps: { resolveFetcher: () => fetcher } },
    )

    expect(graph(report)).toEqual([
      ['https://app.example/js/boot.js', 'window', 'script', 'https://app.example/', 'ok'],
      // The build's own file, which only the sweep finds (§2 Sweep).
      ['https://app.example/static/app.js', 'window', 'script', null, 'ok'],
      [
        'https://app.example/worker/helper.js',
        'dedicated-worker',
        'script',
        'https://app.example/worker/latest.js',
        'ok',
      ],
      [
        'https://app.example/worker/latest.js',
        'dedicated-worker',
        'script',
        'https://app.example/js/boot.js',
        'ok',
      ],
    ])
  })
})

// The SRI spec's worked example (Subresource Integrity § Integrity metadata): the digests of
// `alert('Hello, world.');`.
const hello = "alert('Hello, world.');"
const helloDigests = {
  sha256: 'sha256-qznLcsROx4GACP2dm0UCKCzCG+HiZ1guq6ZZDob/Tng=',
  sha384: 'sha384-H8BRh8j48O9oYatfu5AZzq6A9RINhZO5H16dQZngK7T62em8MUt1FLm52t+eX6xO',
  sha512: 'sha512-Q2bFTOhEALkN8hOms2FKTDLy7eugP2zFZ1T8LCvX42Fp3WoNr3bjZSAHeOsHrbV1Fu9/A0EzCinRE7Af1ofPrw==',
}

describe('integrity (§17 Integrity)', () => {
  test('bytes that match the element’s integrity value pass, and are analyzed', async () => {
    const fetcher = served({ 'https://cdn.example/hello.js': js(hello) })

    const { report } = await scanResolved(
      { 'index.html': `<script src="https://cdn.example/hello.js" integrity="${helloDigests.sha384}"></script>` },
      fetcher,
    )

    expect(report.artifacts).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example/hello.js',
        hash: `sha256:${createHash('sha256').update(hello).digest('hex')}`,
        retrieval: {
          status: 'ok',
          requestedUrl: 'https://cdn.example/hello.js',
          finalUrl: 'https://cdn.example/hello.js',
          contentType: 'text/javascript',
          sri: { result: 'match', expected: [helloDigests.sha384], actual: helloDigests.sha384 },
        },
      }),
    ])
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 1, analyzed: 1 })
  })

  test('bytes that don’t match are `sri-mismatch`: not analyzed, with both digests, and the scan is incomplete', async () => {
    const fetcher = served({
      'https://cdn.example/hello.js': js(hello),
      'https://cdn.example/patch.js': js('window.fetch = f'),
    })
    const page = [
      `<script src="https://cdn.example/hello.js" integrity="${helloDigests.sha512.replace('Q2bF', 'AAAA')}"></script>`,
      `<script src="https://cdn.example/patch.js" integrity="${helloDigests.sha384}"></script>`,
    ].join('')

    const { report, stdout } = await scanResolved({ 'index.html': page }, fetcher)

    expect(report.artifacts).toEqual([
      expect.objectContaining({
        url: 'https://cdn.example/hello.js',
        hash: null,
        retrieval: {
          status: 'sri-mismatch',
          requestedUrl: 'https://cdn.example/hello.js',
          finalUrl: 'https://cdn.example/hello.js',
          contentType: 'text/javascript',
          sri: {
            result: 'mismatch',
            expected: [helloDigests.sha512.replace('Q2bF', 'AAAA')],
            actual: helloDigests.sha512,
          },
        },
      }),
      expect.objectContaining({
        url: 'https://cdn.example/patch.js',
        hash: null,
        retrieval: expect.objectContaining({
          status: 'sri-mismatch',
          sri: { result: 'mismatch', expected: [helloDigests.sha384], actual: expect.stringMatching(/^sha384-/) },
        }),
      }),
    ])
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact])).toEqual([
      ['sri-mismatch', { url: 'https://cdn.example/hello.js' }],
      ['sri-mismatch', { url: 'https://cdn.example/patch.js' }],
    ])
    const [helloRecord] = report.completeness.limitations
    expect(helloRecord.detail).toContain(helloDigests.sha512)
    expect(helloRecord.detail).toContain(helloDigests.sha512.replace('Q2bF', 'AAAA'))
    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.counters.artifacts).toMatchObject({
      known: 2,
      analyzed: 0,
      failed: { 'sri-mismatch': 2 },
    })
    expect(report.findings).toEqual([])
    // The fetch happened, so the run block records it.
    expect(Object.keys(report.run.retrievals)).toEqual(['https://cdn.example/hello.js', 'https://cdn.example/patch.js'])
    // The checks are the same on every run: the report is byte-identical outside `run` (§15 Determinism).
    const again = await scanResolved({ 'index.html': page }, fetcher)
    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(again.stdout)).toBe(beforeRun(stdout))
  })

  test.each([
    [
      'a weaker digest that doesn’t match is ignored',
      `sha256-${'A'.repeat(43)}= ${helloDigests.sha384}`,
      { result: 'match', expected: [helloDigests.sha384], actual: helloDigests.sha384 },
    ],
    [
      'a weaker digest that matches doesn’t save a stronger one that doesn’t',
      `${helloDigests.sha512.replace('Q2bF', 'AAAA')} ${helloDigests.sha256}`,
      { result: 'mismatch', expected: [helloDigests.sha512.replace('Q2bF', 'AAAA')], actual: helloDigests.sha512 },
    ],
    [
      'any digest in the strongest algorithm may match, and options after `?` are ignored',
      `sha384-${'A'.repeat(64)} ${helloDigests.sha384}?v=2 ${helloDigests.sha256}`,
      { result: 'match', expected: [`sha384-${'A'.repeat(64)}`, helloDigests.sha384], actual: helloDigests.sha384 },
    ],
    [
      'an algorithm is named ignoring case, and an unsupported one is skipped',
      `md5-XrY7u+Ae7tCTyyK7j1rNww== ${helloDigests.sha384.replace('sha384', 'SHA384')}`,
      { result: 'match', expected: [helloDigests.sha384], actual: helloDigests.sha384 },
    ],
  ])('a mix of algorithms uses the strongest (SRI § Get the strongest metadata): %s', async (_, integrity, sri) => {
    const fetcher = served({ 'https://cdn.example/hello.js': js(hello) })

    const { report } = await scanResolved(
      { 'index.html': `<script src="https://cdn.example/hello.js" integrity="${integrity}"></script>` },
      fetcher,
    )

    expect(report.artifacts[0].retrieval.sri).toEqual(sri)
    expect(report.artifacts[0].retrieval.status).toBe(sri.result === 'match' ? 'ok' : 'sri-mismatch')
    expect(report.completeness.level).toBe(sri.result === 'match' ? 'complete' : 'incomplete')
  })

  test('an integrity value of any length is checked, and is no internal error', async () => {
    const fetcher = served({ 'https://cdn.example/hello.js': js(hello) })
    // Enough digests to overflow the stack if they were ever spread into one call's arguments.
    const integrity = [...Array<string>(250_000).fill(`sha256-${'A'.repeat(43)}=`), helloDigests.sha384].join(' ')

    const { report } = await scanResolved(
      { 'index.html': `<script src="https://cdn.example/hello.js" integrity="${integrity}"></script>` },
      fetcher,
    )

    expect(report.artifacts[0].retrieval.status).toBe('ok')
    expect(report.artifacts[0].retrieval.sri).toEqual({
      result: 'match',
      expected: [helloDigests.sha384],
      actual: helloDigests.sha384,
    })
  })

  test('`sri: none` is recorded when no integrity value is checked, and the bytes are analyzed', async () => {
    const fetcher = served({
      'https://cdn.example/plain.js': js('window.fetch = f'),
      'https://cdn.example/empty.js': js('window.alert = g'),
      'https://cdn.example/unsupported.js': js('window.open = h'),
    })
    const page = [
      '<script src="https://cdn.example/plain.js"></script>',
      '<script src="https://cdn.example/empty.js" integrity=""></script>',
      '<script src="https://cdn.example/unsupported.js" integrity="md5-XrY7u+Ae7tCTyyK7j1rNww== sha1-x"></script>',
      // A build file and an inline script are never fetched, so nothing is checked against them.
      `<script src="local.js" integrity="${helloDigests.sha384}"></script>`,
      `<script integrity="${helloDigests.sha384}">window.close = i</script>`,
    ].join('')

    const { report } = await scanResolved({ 'index.html': page, 'local.js': 'window.print = j' }, fetcher)

    expect(report.artifacts.map(({ url, retrieval }: Json) => [url, retrieval.status, retrieval.sri])).toEqual([
      ['https://app.example/#inline-1', 'ok', 'none'],
      ['https://app.example/local.js', 'ok', 'none'],
      ['https://cdn.example/empty.js', 'ok', 'none'],
      ['https://cdn.example/plain.js', 'ok', 'none'],
      ['https://cdn.example/unsupported.js', 'ok', 'none'],
    ])
    expect(report.completeness.level).toBe('complete')
    expect(report.findings).toHaveLength(5)
  })

  test('an import map’s `integrity` section checks the modules it names that no `integrity` attribute covers', async () => {
    const bodies = {
      sdk: 'window.fetch = f',
      bad: 'window.alert = g',
      top: 'window.open = h',
      attr: 'window.close = i',
      classic: 'window.print = j',
      preloaded: 'window.stop = k',
    }
    const fetcher = served(
      Object.fromEntries(Object.entries(bodies).map(([name, body]) => [`https://cdn.example/${name}.js`, js(body)])),
    )
    const wrong = digest('sha384', 'something else')
    const integrity = {
      'https://cdn.example/sdk.js': digest('sha384', bodies.sdk),
      'https://cdn.example/bad.js': wrong,
      'https://cdn.example/top.js': digest('sha256', bodies.top),
      'https://cdn.example/attr.js': wrong,
      'https://cdn.example/classic.js': wrong,
      'https://cdn.example/preloaded.js': digest('sha512', bodies.preloaded),
      'not a URL-like key': wrong,
      'https://cdn.example/other.js': 42,
    }
    const page = [
      `<script type="importmap">${JSON.stringify({ imports: { sdk: 'https://cdn.example/sdk.js' }, integrity })}`,
      '</script>',
      // A later import map can't change an integrity value the document already has (HTML § Merge existing and new
      // import maps).
      `<script type="importmap">${JSON.stringify({ integrity: { 'https://cdn.example/sdk.js': wrong } })}</script>`,
      '<script type="module">import "sdk"; import "https://cdn.example/bad.js"</script>',
      '<script type="module" src="https://cdn.example/top.js"></script>',
      '<script type="module" src="https://cdn.example/attr.js" integrity=""></script>',
      '<script src="https://cdn.example/classic.js"></script>',
      '<link rel="modulepreload" href="https://cdn.example/preloaded.js">',
    ].join('')

    const { report } = await scanResolved({ 'index.html': page }, fetcher)

    expect(checks(report)).toEqual([
      ['https://app.example/#inline-3', 'ok', 'none'],
      ['https://cdn.example/attr.js', 'ok', 'none'],
      ['https://cdn.example/bad.js', 'sri-mismatch', 'mismatch'],
      ['https://cdn.example/classic.js', 'ok', 'none'],
      ['https://cdn.example/preloaded.js', 'ok', 'match'],
      ['https://cdn.example/sdk.js', 'ok', 'match'],
      ['https://cdn.example/top.js', 'ok', 'match'],
    ])
    expect(report.artifacts[2].retrieval.sri.expected).toEqual([wrong])
    expect(report.artifacts[6].retrieval.sri.expected).toEqual([digest('sha256', bodies.top)])
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
      ['sri-mismatch', 'https://cdn.example/bad.js'],
    ])
  })

  test('a script a preload fetched is fetched again when its own integrity value differs (HTML § Consume a preloaded resource)', async () => {
    const bodies = { a: 'window.fetch = f', b: 'window.alert = g', c: 'window.open = h', d: 'window.close = i' }
    const fetcher = served(
      Object.fromEntries(Object.entries(bodies).map(([name, body]) => [`https://cdn.example/${name}.js`, js(body)])),
    )
    const wrong = digest('sha384', 'something else')
    const page = [
      // The script's own value differs from the preload's, so it is fetched again, and checked against it.
      '<link rel="preload" as="script" href="https://cdn.example/a.js">',
      `<script src="https://cdn.example/a.js" integrity="${wrong}"></script>`,
      `<link rel="preload" as="script" href="https://cdn.example/b.js" integrity="${wrong}">`,
      `<script src="https://cdn.example/b.js" integrity="${digest('sha256', bodies.b)}"></script>`,
      // A script with no integrity value takes what the preload fetched.
      `<link rel="preload" as="script" href="https://cdn.example/c.js" integrity="${wrong}">`,
      '<script src="https://cdn.example/c.js"></script>',
      // A module is fetched once per document (HTML § Fetch a single module script): the preload's fetch is the one.
      `<link rel="modulepreload" href="https://cdn.example/d.js" integrity="${wrong}">`,
      `<script type="module" src="https://cdn.example/d.js" integrity="${digest('sha256', bodies.d)}"></script>`,
    ].join('')

    const { report } = await scanResolved({ 'index.html': page }, fetcher)

    expect(checks(report)).toEqual([
      ['https://cdn.example/a.js', 'sri-mismatch', 'mismatch'],
      ['https://cdn.example/b.js', 'ok', 'match'],
      ['https://cdn.example/c.js', 'sri-mismatch', 'mismatch'],
      ['https://cdn.example/d.js', 'sri-mismatch', 'mismatch'],
    ])
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
      ['sri-mismatch', 'https://cdn.example/a.js'],
      ['sri-mismatch', 'https://cdn.example/c.js'],
      ['sri-mismatch', 'https://cdn.example/d.js'],
    ])
    expect(found(report)).toEqual([['window|Window.alert|replace', 'https://cdn.example/b.js']])
  })

  test('a mismatch fails only the artifact whose bytes it withheld: the same URL fetched in another realm is analyzed', async () => {
    const fetcher = served({ 'https://cdn.example/shared.js': js('self.fetch = f') })
    const files = {
      'index.html': [
        `<script type="module" src="https://cdn.example/shared.js" integrity="${digest('sha384', 'other')}"></script>`,
        '<script src="main.js"></script>',
      ].join(''),
      'main.js': 'new Worker("worker.js", { type: "module" })',
      // A worker has no import map, so nothing checks its import (HTML § Import maps).
      'worker.js': 'import "https://cdn.example/shared.js"',
    }

    const { report } = await scanResolved(files, fetcher)

    expect(report.artifacts.map(({ url, realm, retrieval }: Json) => [url, realm, retrieval.status])).toEqual([
      ['https://app.example/main.js', 'window', 'ok'],
      ['https://app.example/worker.js', 'dedicated-worker', 'ok'],
      ['https://cdn.example/shared.js', 'window', 'sri-mismatch'],
      ['https://cdn.example/shared.js', 'dedicated-worker', 'ok'],
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({
      known: 4,
      analyzed: 3,
      failed: { 'sri-mismatch': 1 },
    })
    expect(report.completeness.level).toBe('incomplete')
    expect(found(report).map(([targetKey]: Json) => targetKey)).toEqual([
      expect.stringMatching(/^dedicated-worker\|.*fetch\|replace$/),
    ])
  })
})

describe('integrity in the resolve fetcher (§19 Source store and retrieval)', () => {
  const cdn = '203.0.113.10'

  test('checks each reference’s integrity value against the bytes of the one request it makes for a URL', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (request, response) => {
      const type = request.url === '/text.js' ? 'text/plain' : 'text/javascript'
      response.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff' }).end(hello)
    })
    const files = {
      'index.html': [
        `<script src="https://cdn.example/hello.js" integrity="${helloDigests.sha512}"></script>`,
        `<script src="https://cdn.example/shared.js" integrity="${digest('sha256', 'other')}"></script>`,
        // The floor refuses what a browser blocks before it checks integrity.
        `<script src="https://cdn.example/text.js" integrity="${digest('sha256', 'other')}"></script>`,
        '<script src="main.js"></script>',
      ].join(''),
      'main.js': 'new Worker("worker.js")',
      'worker.js': 'importScripts("https://cdn.example/shared.js")',
    }

    const { report } = await scanBuild(files, resolve, { deps: { resolveFetcher: network.fetcher() } })

    const inRealms = report.artifacts.map(({ url, realm, retrieval }: Json) => [
      url,
      realm,
      retrieval.status,
      sriResult(retrieval),
    ])
    expect(inRealms).toEqual([
      ['https://app.example/main.js', 'window', 'ok', 'none'],
      ['https://app.example/worker.js', 'dedicated-worker', 'ok', 'none'],
      ['https://cdn.example/hello.js', 'window', 'ok', 'match'],
      ['https://cdn.example/shared.js', 'window', 'sri-mismatch', 'mismatch'],
      ['https://cdn.example/shared.js', 'dedicated-worker', 'ok', 'none'],
      ['https://cdn.example/text.js', 'window', 'remote-refused', 'none'],
    ])
    expect(report.artifacts[3].retrieval.sri).toEqual({
      result: 'mismatch',
      expected: [digest('sha256', 'other')],
      actual: helloDigests.sha256,
    })
    expect(network.requests.map(({ url }) => url).sort()).toEqual([
      'https://cdn.example/hello.js',
      'https://cdn.example/shared.js',
      'https://cdn.example/text.js',
    ])
  })
})

// For each destination, the floor checks what a browser checks, in
// the browser's order (Fetch § main fetch, then HTML § Fetching scripts): blocked types and `nosniff` first, then
// integrity, then the JavaScript MIME type that modules, workers and dynamic imports need.
describe('the order of the content-type and integrity checks (§17 Content types)', () => {
  const cdn = '203.0.113.10'
  /** The headers each path is served with. Every path serves its own bytes, `body(path)`. */
  const types: Record<string, Record<string, string>> = {
    '/classic-image.js': { 'content-type': 'image/png' },
    '/classic-nosniff.js': { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff' },
    '/classic-plain.js': { 'content-type': 'text/plain' },
    '/module-plain.js': { 'content-type': 'text/plain' },
    '/module-untyped.js': {},
    '/module-plain-matching.js': { 'content-type': 'text/plain' },
    '/module-image.js': { 'content-type': 'image/png' },
    '/module-csv.js': { 'content-type': 'text/csv' },
    '/module-nosniff.js': { 'content-type': 'text/plain', 'x-content-type-options': 'nosniff' },
    '/lazy-html.js': { 'content-type': 'text/html' },
    '/lazy-html-matching.js': { 'content-type': 'text/html' },
  }
  const body = (path: string) => `window.fetch = f // ${path}`
  const url = (path: string) => `https://cdn.example${path}`
  /** An integrity value the bytes at `path` match, when `matching`, or one they don't. */
  const integrity = (path: string) => digest('sha256', path.includes('matching') ? body(path) : 'other')

  test('blocked types and `nosniff` come before integrity, and the JavaScript MIME requirement after it', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (request, response) => response.writeHead(200, types[request.url!] ?? {}).end(body(request.url!)))
    const element = (type: string, path: string) =>
      `<script${type} src="${url(path)}" integrity="${integrity(path)}"></script>`
    const lazy = ['/lazy-html.js', '/lazy-html-matching.js']
    const entry = (path: string) => [url(path), integrity(path)]
    const files = {
      'index.html': [
        // Dynamic imports take their integrity value from the import map (§17 Integrity).
        `<script type="importmap">${JSON.stringify({ integrity: Object.fromEntries(lazy.map(entry)) })}</script>`,
        ...Object.keys(types)
          .filter((path) => !lazy.includes(path))
          .map((path) => element(path.startsWith('/module') ? ' type="module"' : '', path)),
        '<script src="main.js"></script>',
      ].join(''),
      'main.js': lazy.map((path) => `import("${url(path)}")`).join('; '),
    }

    const { report } = await scanBuild(files, resolve, { deps: { resolveFetcher: network.fetcher() } })

    const remote = report.artifacts.filter(({ url }: Json) => url.startsWith('https://cdn.example/'))
    const outcomes = remote.map(({ url, sourceType, retrieval }: Json) => [
      new URL(url).pathname,
      sourceType,
      retrieval.status,
      sriResult(retrieval),
    ])
    expect(outcomes).toEqual([
      // A classic script: blocked types and `nosniff` are refused before integrity is checked.
      ['/classic-image.js', 'script', 'remote-refused', 'none'],
      ['/classic-nosniff.js', 'script', 'remote-refused', 'none'],
      ['/classic-plain.js', 'script', 'sri-mismatch', 'mismatch'],
      // Dynamic imports: integrity before the JavaScript MIME requirement.
      ['/lazy-html-matching.js', 'module', 'remote-refused', 'match'],
      ['/lazy-html.js', 'module', 'sri-mismatch', 'mismatch'],
      // Module scripts: blocked types and `nosniff` first, then integrity, then the JavaScript MIME requirement.
      ['/module-csv.js', 'module', 'remote-refused', 'none'],
      ['/module-image.js', 'module', 'remote-refused', 'none'],
      ['/module-nosniff.js', 'module', 'remote-refused', 'none'],
      ['/module-plain-matching.js', 'module', 'remote-refused', 'match'],
      ['/module-plain.js', 'module', 'sri-mismatch', 'mismatch'],
      ['/module-untyped.js', 'module', 'sri-mismatch', 'mismatch'],
    ])
    const detail = (path: string) =>
      report.completeness.limitations.find(({ artifact }: Json) => artifact.url === url(path)).detail
    expect(detail('/module-image.js')).toContain('image/png')
    expect(detail('/module-nosniff.js')).toContain('nosniff')
    expect(detail('/module-plain-matching.js')).toContain('JavaScript MIME type')
    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.counters.artifacts).toMatchObject({
      known: 12,
      analyzed: 1,
      failed: { 'sri-mismatch': 4 },
      skipped: { refused: 7 },
    })
    expect(network.requests).toHaveLength(Object.keys(types).length)
  })
})

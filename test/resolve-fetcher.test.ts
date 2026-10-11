// The resolve fetcher and the safety floor (§17 Safety floor, Content types, Outcomes, Caching; §19 Source
// store and retrieval). Scans run end to end through `monkeypatchlist scan --json -` in `--mode resolve`, with the CLI's
// resolve fetcher built over an in-process network: its DNS and connect hooks answer from `fakeNetwork`, whose servers
// are real Node HTTP and HTTPS servers.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, gzipSync } from 'node:zlib'
import { describe, expect, test } from 'vitest'
import { fakeNetwork } from './support/fake-network.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const resolve = ['--mode', 'resolve']
const cdn = '203.0.113.10'
/**
 * Serves a script that replaces `fetch`, with a JavaScript MIME type. A comment names the path, so that no two URLs
 * serve the same bytes, which would make them one artifact (§2).
 */
const javascript = (body = 'window.fetch = f') => (request: Json, response: Json) =>
  response.writeHead(200, { 'content-type': 'text/javascript' }).end(`${body} // ${request.url}`)

/** Each artifact's URL and retrieval status. */
const statuses = (report: Json) => report.artifacts.map(({ url, retrieval }: Json) => [url, retrieval.status])
/** Each limitation's kind and artifact URL. */
const limitations = (report: Json) =>
  report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])

describe('the resolve fetcher', () => {
  test('fetches a remote script over verified HTTPS, and it is analyzed like any other artifact', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, javascript())

    const { report } = await scanBuild(
      { 'index.html': '<script src="https://cdn.example/sdk.js"></script>' },
      resolve,
      { deps: { resolveFetcher: network.fetcher() } },
    )

    expect(statuses(report)).toEqual([['https://cdn.example/sdk.js', 'ok']])
    expect(report.artifacts[0].retrieval).toEqual({
      status: 'ok',
      requestedUrl: 'https://cdn.example/sdk.js',
      finalUrl: 'https://cdn.example/sdk.js',
      contentType: 'text/javascript',
      sri: 'none',
    })
    expect(report.findings.map(({ targetKey }: Json) => targetKey)).toEqual(['window|Window.fetch|replace'])
    expect(limitations(report)).toEqual([])
    expect(network.lookups).toEqual(['cdn.example'])
    expect(network.connects).toEqual([`${cdn}:443`])
    expect(network.requests.map(({ method, url }) => [method, url])).toEqual([['GET', 'https://cdn.example/sdk.js']])
  })
})

describe('schemes (§17 Safety floor)', () => {
  // A script URL whose scheme is not `http:`, `https:` or `data:` gives nothing
  // (§2 Other script URLs), so it never reaches the fetcher. A redirect to one is refused by the floor (below).
  test('an `https:` document may fetch `https:` only: `http:` is refused before any lookup, and an `ftp:` src is no reference', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, javascript())
    const page = ['http://cdn.example/plain.js', 'ftp://cdn.example/ftp.js', 'https://cdn.example/sdk.js']
      .map((url) => `<script src="${url}"></script>`)
      .join('')

    const { report } = await scanBuild({ 'index.html': page }, resolve, { deps: { resolveFetcher: network.fetcher() } })

    expect(statuses(report)).toEqual([
      ['http://cdn.example/plain.js', 'remote-refused'],
      ['https://cdn.example/sdk.js', 'ok'],
    ])
    expect(limitations(report)).toEqual([['remote-refused', 'http://cdn.example/plain.js']])
    expect(report.completeness.limitations[0].detail).toContain('http:')
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 2, analyzed: 1, skipped: { refused: 1 } })
    expect(network.requests.map(({ url }) => url)).toEqual(['https://cdn.example/sdk.js'])
    expect(network.lookups).toEqual(['cdn.example'])
  })

  test('an `http:` document may fetch `http:` too', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, javascript())

    const { report } = await scanBuild(
      { 'index.html': '<script src="http://cdn.example/plain.js"></script>' },
      [...resolve, '--map', 'http://app.example/=.'],
      { deps: { resolveFetcher: network.fetcher() } },
    )

    expect(statuses(report)).toEqual([['http://cdn.example/plain.js', 'ok']])
    expect(network.connects).toEqual([`${cdn}:80`])
    expect(network.requests.map(({ url }) => url)).toEqual(['http://cdn.example/plain.js'])
  })
})

describe('addresses (§17 Safety floor)', () => {
  /** A page that runs the script at `url`. */
  const page = (url: string) => ({ 'index.html': `<script src="${url}"></script>` })

  test.each([
    ['loopback', '127.0.0.1'],
    ['loopback', '127.255.0.9'],
    ['loopback', '::1'],
    ['unspecified', '0.0.0.0'],
    ['unspecified', '::'],
    ['private', '10.1.2.3'],
    ['private', '172.16.0.1'],
    ['private', '172.31.255.254'],
    ['private', '192.168.1.1'],
    ['link-local', '169.254.10.20'],
    ['link-local', 'fe80::1'],
    ['cloud-metadata', '169.254.169.254'],
    ['cloud-metadata', '168.63.129.16'],
    ['cloud-metadata', '100.100.100.200'],
    ['cloud-metadata', 'fd00:ec2::254'],
    ['unique-local', 'fc00::1'],
    ['unique-local', 'fdab:cdef::1'],
    ['carrier-grade NAT', '100.64.0.1'],
    ['carrier-grade NAT', '100.127.255.254'],
    ['multicast', '224.0.0.1'],
    ['multicast', '239.255.255.250'],
    ['multicast', 'ff02::1'],
    ['IPv4-mapped loopback', '::ffff:127.0.0.1'],
    ['IPv4-mapped private', '::ffff:a00:1'],
    ['IPv4-mapped cloud-metadata', '::ffff:169.254.169.254'],
    ['NAT64 loopback', '64:ff9b::7f00:1'],
    ['IPv4-compatible loopback', '::127.0.0.1'],
    ['6to4 private', '2002:a00:1::1'],
    ['cloud-metadata', '192.0.0.192'],
    ['broadcast', '255.255.255.255'],
    ['site-local', 'fec0::1'],
  ])('a host that resolves to a refused address, %s (%s), is refused and never connected to', async (kind, address) => {
    const network = fakeNetwork({ 'cdn.example': address })
    network.serve(address, javascript())

    const { report } = await scanBuild(page('https://cdn.example/sdk.js'), resolve, {
      deps: { resolveFetcher: network.fetcher() },
    })

    expect(statuses(report)).toEqual([['https://cdn.example/sdk.js', 'remote-refused']])
    expect(limitations(report)).toEqual([['remote-refused', 'https://cdn.example/sdk.js']])
    expect(report.completeness.limitations[0].detail).toContain(`cdn.example resolves to ${address} (${kind})`)
    expect(network.lookups).toEqual(['cdn.example'])
    expect(network.connects).toEqual([])
  })

  test.each([
    ['a public IPv4 address', '203.0.113.10'],
    ['a public IPv6 address', '2001:db8::10'],
    ['an address just outside the private ranges', '172.32.0.1'],
    ['an address just outside carrier-grade NAT', '100.128.0.1'],
  ])('a host that resolves to %s is fetched', async (_, address) => {
    const network = fakeNetwork({ 'cdn.example': address })
    network.serve(address, javascript())

    const { report } = await scanBuild(page('https://cdn.example/sdk.js'), resolve, {
      deps: { resolveFetcher: network.fetcher() },
    })

    expect(statuses(report)).toEqual([['https://cdn.example/sdk.js', 'ok']])
    expect(network.connects).toEqual([`${address}:443`])
  })

  test('a host with a public and a private address is refused', async () => {
    const network = fakeNetwork({ 'cdn.example': [cdn, '10.0.0.8'] })
    network.serve(cdn, javascript())

    const { report } = await scanBuild(page('https://cdn.example/sdk.js'), resolve, {
      deps: { resolveFetcher: network.fetcher() },
    })

    expect(statuses(report)).toEqual([['https://cdn.example/sdk.js', 'remote-refused']])
    expect(network.connects).toEqual([])
  })

  test.each([
    ['http://127.0.0.1/sdk.js'],
    ['http://[::1]/sdk.js'],
    ['http://169.254.169.254/latest/meta-data/'],
    ['http://2130706433/sdk.js'],
    ['http://[::ffff:7f00:1]/sdk.js'],
  ])('an IP-literal URL in a refused range (%s) is refused without a lookup', async (url) => {
    const network = fakeNetwork()

    const { report } = await scanBuild(page(url), [...resolve, '--map', 'http://app.example/=.'], {
      deps: { resolveFetcher: network.fetcher() },
    })

    expect(report.artifacts.map(({ retrieval }: Json) => retrieval.status)).toEqual(['remote-refused'])
    expect(network.lookups).toEqual([])
    expect(network.connects).toEqual([])
  })

  test('DNS rebinding: the address checked is the address connected to, for each connection', async () => {
    // The first lookup gives a public address, and every later one the loopback address.
    let lookups = 0
    const network = fakeNetwork({ 'cdn.example': () => (lookups++ === 0 ? cdn : '127.0.0.1') })
    network.serve(cdn, javascript())
    network.serve('127.0.0.1', javascript('window.alert = a'))
    const files = {
      'index.html': '<script src="https://cdn.example/first.js"></script><script src="https://cdn.example/second.js"></script>',
    }

    const { report } = await scanBuild(files, resolve, { deps: { resolveFetcher: network.fetcher() } })

    expect(statuses(report)).toEqual([
      ['https://cdn.example/first.js', 'ok'],
      ['https://cdn.example/second.js', 'remote-refused'],
    ])
    expect(report.completeness.limitations[0].detail).toContain('127.0.0.1')
    expect(network.lookups).toEqual(['cdn.example', 'cdn.example'])
    expect(network.connects).toEqual([`${cdn}:443`])
    expect(report.findings.map(({ targetKey }: Json) => targetKey)).toEqual(['window|Window.fetch|replace'])
  })
})

describe('redirects (§17 Safety floor)', () => {
  /** A server that redirects `/r<n>.js` to `/r<n+1>.js` until `/r<last>.js`, which serves a script. */
  const chain = (last: number) => (request: Json, response: Json) => {
    const n = Number(/^\/r(\d+)\.js$/.exec(request.url)?.[1])
    if (n < last) response.writeHead(302, { location: `/r${n + 1}.js` }).end()
    else javascript()(request, response)
  }
  const page = { 'index.html': '<script src="https://cdn.example/r0.js"></script>' }

  test('at most 5 are followed, and the final URL is recorded', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, chain(5))

    const { report } = await scanBuild(page, resolve, { deps: { resolveFetcher: network.fetcher() } })

    expect(report.artifacts[0].retrieval).toMatchObject({
      status: 'ok',
      requestedUrl: 'https://cdn.example/r0.js',
      finalUrl: 'https://cdn.example/r5.js',
    })
    expect(network.requests).toHaveLength(6)
  })

  test('a sixth redirect is refused, and never requested', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, chain(6))

    const { report } = await scanBuild(page, resolve, { deps: { resolveFetcher: network.fetcher() } })

    expect(statuses(report)).toEqual([['https://cdn.example/r0.js', 'remote-refused']])
    expect(report.completeness.limitations[0].detail).toContain('5 redirects')
    expect(network.requests.map(({ url }) => url).at(-1)).toBe('https://cdn.example/r5.js')
    expect(network.requests).toHaveLength(6)
  })

  test.each([
    ['to a cloud-metadata address', 'http://169.254.169.254/latest/meta-data/', 'http://app.example/'],
    ['to a host that resolves to a private address', 'https://internal.example/sdk.js', 'https://app.example/'],
    ['from `https:` to `http:`', 'http://cdn.example/sdk.js', 'https://app.example/'],
    ['to another scheme', 'ftp://cdn.example/sdk.js', 'https://app.example/'],
  ])('every hop is checked against the whole floor: a redirect %s is refused', async (_, location, document) => {
    const network = fakeNetwork({ 'cdn.example': cdn, 'internal.example': '10.0.0.8' })
    network.serve(cdn, (request, response) => {
      if (request.url === '/moved.js') response.writeHead(301, { location }).end()
      else javascript()(request, response)
    })
    network.serve('10.0.0.8', javascript())
    network.serve('169.254.169.254', javascript())
    const scheme = new URL(document).protocol

    const { report } = await scanBuild(
      { 'index.html': `<script src="${scheme}//cdn.example/moved.js"></script>` },
      [...resolve, '--map', `${document}=.`],
      { deps: { resolveFetcher: network.fetcher() } },
    )

    expect(statuses(report)).toEqual([[`${scheme}//cdn.example/moved.js`, 'remote-refused']])
    expect(network.connects).toEqual([`${cdn}:${scheme === 'https:' ? 443 : 80}`])
    expect(network.requests).toHaveLength(1)
  })

  // There is no separate loop check. A loop runs into the cap.
  test('a redirect loop within 5 hops is refused, as a sixth redirect is, and each URL in it is requested once', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (request, response) =>
      response.writeHead(302, { location: request.url === '/a.js' ? '/b.js' : '/a.js' }).end(),
    )

    const { report } = await scanBuild(
      { 'index.html': '<script src="https://cdn.example/a.js"></script>' },
      resolve,
      { deps: { resolveFetcher: network.fetcher() } },
    )

    expect(statuses(report)).toEqual([['https://cdn.example/a.js', 'remote-refused']])
    expect(limitations(report)).toEqual([['remote-refused', 'https://cdn.example/a.js']])
    expect(report.completeness.limitations[0].detail).toContain('5 redirects')
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 1, analyzed: 0, skipped: { refused: 1 } })
    expect(network.requests.map(({ url }) => url)).toEqual(['https://cdn.example/a.js', 'https://cdn.example/b.js'])
  })

  test('a URL that redirects to itself is refused at the sixth redirect', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (request, response) => response.writeHead(307, { location: request.url }).end())

    const { report } = await scanBuild(
      { 'index.html': '<script src="https://cdn.example/self.js"></script>' },
      resolve,
      { deps: { resolveFetcher: network.fetcher() } },
    )

    expect(limitations(report)).toEqual([['remote-refused', 'https://cdn.example/self.js']])
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(network.requests).toHaveLength(1)
  })
})

describe('size (§17 Safety floor)', () => {
  /** A script of exactly `size` bytes: a statement that replaces `fetch`, padded with a comment. */
  const script = (size: number) => {
    const statement = 'window.fetch = f //'
    return statement + 'x'.repeat(size - statement.length)
  }
  /** Serves `/<n>.js` as a script of `n` bytes, compressed with `encoding` when it is given. */
  const sized = (encoding?: 'gzip' | 'br') => (request: Json, response: Json) => {
    const body = Buffer.from(script(Number(/^\/(\d+)\.js$/.exec(request.url)?.[1])))
    const coding = encoding === undefined ? {} : { 'content-encoding': encoding }
    const headers = { 'content-type': 'text/javascript', ...coding }
    const encoded = encoding === 'gzip' ? gzipSync(body) : encoding === 'br' ? brotliCompressSync(body) : body
    response.writeHead(200, headers).end(encoded)
  }
  const page = (...sizes: number[]) => ({
    'index.html': sizes.map((size) => `<script src="https://cdn.example/${size}.js"></script>`).join(''),
  })

  test('a response may have at most the per-response limit of bytes', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, sized())

    const { report } = await scanBuild(page(1000, 1001), resolve, {
      deps: { resolveFetcher: network.fetcher({ limits: { responseBytes: 1000 } }) },
    })

    expect(statuses(report)).toEqual([
      ['https://cdn.example/1000.js', 'ok'],
      ['https://cdn.example/1001.js', 'remote-refused'],
    ])
    expect(report.completeness.limitations[0].detail).toContain('1000 bytes')
  })

  test.each(['gzip', 'br'] as const)('the limit counts %s responses decompressed', async (encoding) => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, sized(encoding))

    const { report } = await scanBuild(page(1000, 50_000), resolve, {
      deps: { resolveFetcher: network.fetcher({ limits: { responseBytes: 1000 } }) },
    })

    expect(statuses(report)).toEqual([
      ['https://cdn.example/1000.js', 'ok'],
      ['https://cdn.example/50000.js', 'remote-refused'],
    ])
    expect(report.findings.map(({ targetKey }: Json) => targetKey)).toEqual(['window|Window.fetch|replace'])
  })

  test('all the responses of a scan may have at most the per-scan limit of bytes', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, sized())

    const { report } = await scanBuild(page(600, 601, 400), resolve, {
      deps: { resolveFetcher: network.fetcher({ limits: { scanBytes: 1000 } }) },
    })

    expect(statuses(report)).toEqual([
      ['https://cdn.example/400.js', 'ok'],
      ['https://cdn.example/600.js', 'ok'],
      ['https://cdn.example/601.js', 'remote-refused'],
    ])
    expect(report.completeness.limitations[0].detail).toContain('1000 bytes')
  })
})

describe('time (§17 Safety floor)', () => {
  const page = (...names: string[]) => ({
    'index.html': names.map((name) => `<script src="https://cdn.example/${name}.js"></script>`).join(''),
  })

  test('a connection that takes longer than the connect limit fails the fetch', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.blackhole(cdn, 443)

    const { report } = await scanBuild(page('sdk'), resolve, {
      deps: { resolveFetcher: network.fetcher({ limits: { connectMs: 20 } }) },
    })

    expect(limitations(report)).toEqual([['fetch-failed', 'https://cdn.example/sdk.js']])
    expect(report.completeness.limitations[0].detail).toContain('20 ms')
    expect(report.completeness.level).toBe('incomplete')
  })

  test('a connection still being opened when the connect limit runs out is given up, and no other address is tried', async () => {
    const network = fakeNetwork({ 'cdn.example': [cdn, '203.0.113.11'] })
    network.blackhole(cdn, 443)
    network.blackhole('203.0.113.11', 443)

    const { report } = await scanBuild(page('sdk'), resolve, {
      deps: { resolveFetcher: network.fetcher({ limits: { connectMs: 20 } }) },
    })

    expect(limitations(report)).toEqual([['fetch-failed', 'https://cdn.example/sdk.js']])
    expect(network.connects).toEqual([`${cdn}:443`])
    expect(network.abandoned).toEqual([`${cdn}:443`])
  })

  test.each([
    ['sends nothing', () => {}],
    ['sends its headers and never ends its body', (_: Json, response: Json) => response.writeHead(200).write('a')],
  ])('a response that takes longer than the request limit fails the fetch: a server that %s', async (_, handler) => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (request, response) =>
      request.url === '/slow.js' ? handler(request, response) : javascript()(request, response),
    )

    const { report } = await scanBuild(page('slow', 'sdk'), resolve, {
      deps: { resolveFetcher: network.fetcher({ limits: { requestMs: 50 } }) },
    })

    expect(statuses(report)).toEqual([
      ['https://cdn.example/sdk.js', 'ok'],
      ['https://cdn.example/slow.js', 'fetch-failed'],
    ])
    expect(report.completeness.limitations[0].detail).toContain('50 ms')
  })

  test('once the fetches of a scan have taken the scan limit, every later fetch fails without a request', async () => {
    // A clock each request moves on by 100 ms.
    let now = 0
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (request, response) => {
      now += 100
      javascript()(request, response)
    })

    const { report } = await scanBuild(page('a', 'b', 'c', 'd'), resolve, {
      deps: { resolveFetcher: network.fetcher({ limits: { scanMs: 250 }, clock: () => now }) },
    })

    expect(statuses(report)).toEqual([
      ['https://cdn.example/a.js', 'ok'],
      ['https://cdn.example/b.js', 'ok'],
      ['https://cdn.example/c.js', 'ok'],
      ['https://cdn.example/d.js', 'fetch-failed'],
    ])
    expect(report.completeness.limitations[0].detail).toContain('250 ms')
    expect(network.requests).toHaveLength(3)
  })

  test('a fetch is cut off when the scan limit runs out before the request limit', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, () => {})

    const { report } = await scanBuild(page('slow'), resolve, {
      deps: { resolveFetcher: network.fetcher({ limits: { scanMs: 40 } }) },
    })

    expect(limitations(report)).toEqual([['fetch-failed', 'https://cdn.example/slow.js']])
    expect(report.completeness.limitations[0].detail).toContain('40 ms')
  })
})

describe('requests (§17 Safety floor)', () => {
  test('are `GET`s with monkeypatchlist’s User-Agent that accept `gzip` and `br`, with no cookies, credentials or conditions', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (request, response) =>
      response
        .writeHead(200, {
          'content-type': 'text/javascript',
          'set-cookie': 'session=1; Path=/',
          etag: '"v1"',
          'last-modified': 'Tue, 02 Jan 2024 00:00:00 GMT',
        })
        .end(`window.fetch = f // ${request.url}`),
    )
    const files = {
      'index.html': [
        '<script src="https://cdn.example/first.js"></script>',
        '<script src="https://user:secret@cdn.example/second.js"></script>',
      ].join(''),
    }

    const { report } = await scanBuild(files, resolve, { deps: { resolveFetcher: network.fetcher() } })

    expect(statuses(report).map(([, status]: Json) => status)).toEqual(['ok', 'ok'])
    expect(network.requests.map(({ method, url }) => [method, url])).toEqual([
      ['GET', 'https://cdn.example/first.js'],
      ['GET', 'https://cdn.example/second.js'],
    ])
    for (const { headers } of network.requests) {
      expect(headers['user-agent']).toBe('monkeypatchlist/0.0.0-test')
      expect(headers['accept-encoding']).toBe('gzip, br')
      expect(Object.keys(headers).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent'])
    }
  })
})

describe('proxies (§17 Safety floor)', () => {
  const page = { 'index.html': '<script src="https://cdn.example/sdk.js"></script>' }
  const proxy = '10.0.0.5'
  const proxyUrl = 'http://proxy.internal:3128'

  test('`HTTPS_PROXY` tunnels each request, with the credentials in its URL, and TLS runs to the host through the tunnel', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn, 'proxy.internal': proxy })
    network.serve(cdn, javascript())
    const tunnels = network.proxy(proxy, 3128)
    const env = { HTTPS_PROXY: 'http://monkeypatchlist:p%40ss@proxy.internal:3128' }

    const { report } = await scanBuild(page, resolve, { deps: { resolveFetcher: network.fetcher({ env }) } })

    expect(statuses(report)).toEqual([['https://cdn.example/sdk.js', 'ok']])
    expect(tunnels).toEqual([
      { target: 'cdn.example:443', proxyAuthorization: `Basic ${Buffer.from('monkeypatchlist:p@ss').toString('base64')}` },
    ])
    expect(network.connects).toEqual([`${proxy}:3128`])
    expect(network.requests.map(({ url, headers }) => [url, headers['proxy-authorization']])).toEqual([
      ['https://cdn.example/sdk.js', undefined],
    ])
  })

  test('`https_proxy` and `no_proxy` are read too', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn, 'proxy.internal': proxy })
    network.serve(cdn, javascript())
    const tunnels = network.proxy(proxy, 3128)

    await scanBuild(page, resolve, { deps: { resolveFetcher: network.fetcher({ env: { https_proxy: proxyUrl } }) } })
    const bypassed = await scanBuild(page, resolve, {
      deps: { resolveFetcher: network.fetcher({ env: { https_proxy: proxyUrl, no_proxy: 'cdn.example' } }) },
    })

    expect(tunnels.map(({ target }) => target)).toEqual(['cdn.example:443'])
    expect(statuses(bypassed.report)).toEqual([['https://cdn.example/sdk.js', 'ok']])
  })

  test.each([['cdn.example'], ['.example'], ['example'], ['*'], ['other.test, cdn.example:443'], ['CDN.EXAMPLE']])(
    '`NO_PROXY=%s` connects directly',
    async (noProxy) => {
      const network = fakeNetwork({ 'cdn.example': cdn, 'proxy.internal': proxy })
      network.serve(cdn, javascript())
      const tunnels = network.proxy(proxy, 3128)
      const env = { HTTPS_PROXY: proxyUrl, NO_PROXY: noProxy }

      const { report } = await scanBuild(page, resolve, { deps: { resolveFetcher: network.fetcher({ env }) } })

      expect(statuses(report)).toEqual([['https://cdn.example/sdk.js', 'ok']])
      expect(tunnels).toEqual([])
      expect(network.connects).toEqual([`${cdn}:443`])
    },
  )

  test.each([['xcdn.example'], ['cdn.example:8443'], ['other.test']])('`NO_PROXY=%s` still uses the proxy', async (noProxy) => {
    const network = fakeNetwork({ 'cdn.example': cdn, 'proxy.internal': proxy })
    network.serve(cdn, javascript())
    const tunnels = network.proxy(proxy, 3128)
    const env = { HTTPS_PROXY: proxyUrl, NO_PROXY: noProxy }

    await scanBuild(page, resolve, { deps: { resolveFetcher: network.fetcher({ env }) } })

    expect(tunnels.map(({ target }) => target)).toEqual(['cdn.example:443'])
  })

  test('through a proxy, a host in a refused range here is refused, and one that resolves only at the proxy is tunnelled', async () => {
    const network = fakeNetwork({ 'proxy.internal': proxy, 'internal.example': '10.0.0.8' })
    network.serve(cdn, javascript())
    const tunnels = network.proxy(proxy, 3128, { zone: { 'cdn.example': cdn } })
    const env = { HTTPS_PROXY: proxyUrl }
    const files = {
      'index.html': ['https://internal.example/a.js', 'https://127.0.0.1/b.js', 'https://cdn.example/c.js']
        .map((url) => `<script src="${url}"></script>`)
        .join(''),
    }

    const { report } = await scanBuild(files, resolve, { deps: { resolveFetcher: network.fetcher({ env }) } })

    expect(statuses(report)).toEqual([
      ['https://127.0.0.1/b.js', 'remote-refused'],
      ['https://cdn.example/c.js', 'ok'],
      ['https://internal.example/a.js', 'remote-refused'],
    ])
    expect(tunnels.map(({ target }) => target)).toEqual(['cdn.example:443'])
  })

  test('`http:` is fetched directly: only `HTTPS_PROXY` is honoured', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn, 'proxy.internal': proxy })
    network.serve(cdn, javascript())
    const tunnels = network.proxy(proxy, 3128)
    const env = { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl }

    const { report } = await scanBuild(
      { 'index.html': '<script src="http://cdn.example/sdk.js"></script>' },
      [...resolve, '--map', 'http://app.example/=.'],
      { deps: { resolveFetcher: network.fetcher({ env }) } },
    )

    expect(statuses(report)).toEqual([['http://cdn.example/sdk.js', 'ok']])
    expect(tunnels).toEqual([])
    expect(network.connects).toEqual([`${cdn}:80`])
  })

  test('a proxy that refuses the tunnel fails the fetch', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn, 'proxy.internal': proxy })
    network.proxy(proxy, 3128, { status: 407 })

    const { report } = await scanBuild(page, resolve, {
      deps: { resolveFetcher: network.fetcher({ env: { HTTPS_PROXY: proxyUrl } }) },
    })

    expect(limitations(report)).toEqual([['fetch-failed', 'https://cdn.example/sdk.js']])
    expect(report.completeness.limitations[0].detail).toContain('407')
  })
})

describe('TLS (§17 Safety floor)', () => {
  test.each([
    ['a certificate no trusted authority issued', 'cdn.example', false],
    ['a certificate for another host', 'other.test', true],
  ])('is verified: %s fails the fetch', async (_, host, trusted) => {
    const network = fakeNetwork({ [host]: cdn })
    network.serve(cdn, javascript())

    const { report } = await scanBuild(
      { 'index.html': `<script src="https://${host}/sdk.js"></script>` },
      resolve,
      { deps: { resolveFetcher: network.fetcher({ trusted }) } },
    )

    expect(limitations(report)).toEqual([['fetch-failed', `https://${host}/sdk.js`]])
    expect(report.completeness.limitations[0].detail).toContain('TLS')
    expect(network.requests).toEqual([])
  })

  test('has no override: `NODE_TLS_REJECT_UNAUTHORIZED=0` does not turn verification off', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, javascript())
    const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    try {
      const { report } = await scanBuild(
        { 'index.html': '<script src="https://cdn.example/sdk.js"></script>' },
        resolve,
        { deps: { resolveFetcher: network.fetcher({ trusted: false }) } },
      )

      expect(limitations(report)).toEqual([['fetch-failed', 'https://cdn.example/sdk.js']])
      expect(network.requests).toEqual([])
    } finally {
      if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved
    }
  })
})

describe('count (§17 Safety floor)', () => {
  test('a scan fetches at most the artifact limit of remote URLs; one URL asked for again counts once', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, javascript())
    const files = {
      'index.html': ['a.js', 'a.js#again', 'b.js', 'c.js']
        .map((name) => `<script src="https://cdn.example/${name}"></script>`)
        .join(''),
    }

    const { report } = await scanBuild(files, resolve, {
      deps: { resolveFetcher: network.fetcher({ limits: { artifacts: 2 } }) },
    })

    // The two URLs of `a.js` are one fetch. Each keeps its own record of the same bytes (§2 Artifacts).
    expect(statuses(report)).toEqual([
      ['https://cdn.example/a.js', 'ok'],
      ['https://cdn.example/a.js#again', 'ok'],
      ['https://cdn.example/b.js', 'ok'],
      ['https://cdn.example/c.js', 'remote-refused'],
    ])
    expect(report.completeness.limitations[0].detail).toContain('2 remote artifacts')
    expect(network.requests.map(({ url }) => url)).toEqual(['https://cdn.example/a.js', 'https://cdn.example/b.js'])
  })
})

describe('failures (§17 Outcomes)', () => {
  test('a DNS error, a refused connection and a non-2xx response fail the fetch, and make the scan incomplete', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn, 'down.example': '203.0.113.99' })
    network.serve(cdn, (request, response) =>
      request.url === '/gone.js'
        ? response.writeHead(404, { 'content-type': 'text/html' }).end('<h1>Gone</h1>')
        : javascript()(request, response),
    )
    const files = {
      'index.html': ['https://nowhere.example/a.js', 'https://down.example/b.js', 'https://cdn.example/gone.js']
        .map((url) => `<script src="${url}"></script>`)
        .join(''),
    }

    const { report } = await scanBuild(files, resolve, { deps: { resolveFetcher: network.fetcher() } })

    expect(limitations(report)).toEqual([
      ['fetch-failed', 'https://cdn.example/gone.js'],
      ['fetch-failed', 'https://down.example/b.js'],
      ['fetch-failed', 'https://nowhere.example/a.js'],
    ])
    expect(report.completeness.limitations.map(({ detail }: Json) => detail)).toEqual([
      expect.stringContaining('404'),
      expect.stringContaining('ECONNREFUSED'),
      expect.stringContaining('ENOTFOUND'),
    ])
    expect(report.artifacts[0].retrieval).toEqual({
      status: 'fetch-failed',
      requestedUrl: 'https://cdn.example/gone.js',
      finalUrl: 'https://cdn.example/gone.js',
      contentType: 'text/html',
      sri: 'none',
    })
    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 3, failed: { 'fetch-failed': 3 } })
  })
})

describe('content types (§17 Content types)', () => {
  /**
   * A page on the CDN's origin, whose build the CDN serves under `/app/`: a browser runs only a same-origin worker's
   * script, so only then is a worker URL on the CDN followed and fetched (§2).
   */
  const onCdn = ['--map', 'https://cdn.example/app/=.', '--entry', 'index.html@https://cdn.example/app/']
  /** Serves each path with the headers `types` gives it. */
  const typed = (types: Record<string, Record<string, string>>) => (request: Json, response: Json) =>
    response.writeHead(200, types[request.url] ?? {}).end(`window.fetch = f // ${request.url}`)
  /** The status of each artifact, by its realm and the path of its URL. */
  const byPath = (report: Json) =>
    Object.fromEntries(
      report.artifacts.map(({ url, realm, retrieval }: Json) => [
        `${realm} ${new URL(url).pathname}`,
        retrieval.status,
      ]),
    )

  test('a classic script is refused only when a browser would block it', async () => {
    const types: Record<string, Record<string, string>> = {
      '/javascript.js': { 'content-type': 'application/javascript; charset=utf-8' },
      '/plain.js': { 'content-type': 'text/plain' },
      '/html.js': { 'content-type': 'text/html' },
      '/untyped.js': {},
      '/nosniff-javascript.js': { 'content-type': 'text/javascript', 'x-content-type-options': 'nosniff' },
      '/image.js': { 'content-type': 'image/png' },
      '/audio.js': { 'content-type': 'Audio/MPEG' },
      '/video.js': { 'content-type': 'video/mp4' },
      '/csv.js': { 'content-type': 'text/csv; charset=utf-8' },
      '/nosniff-plain.js': { 'content-type': 'text/plain', 'x-content-type-options': 'NoSniff' },
      '/nosniff-untyped.js': { 'x-content-type-options': 'nosniff' },
    }
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, typed(types))
    const page = Object.keys(types).map((path) => `<script src="https://cdn.example${path}"></script>`).join('')

    const { report } = await scanBuild({ 'index.html': page }, resolve, { deps: { resolveFetcher: network.fetcher() } })

    expect(byPath(report)).toEqual({
      'window /javascript.js': 'ok',
      'window /plain.js': 'ok',
      'window /html.js': 'ok',
      'window /untyped.js': 'ok',
      'window /nosniff-javascript.js': 'ok',
      'window /image.js': 'remote-refused',
      'window /audio.js': 'remote-refused',
      'window /video.js': 'remote-refused',
      'window /csv.js': 'remote-refused',
      'window /nosniff-plain.js': 'remote-refused',
      'window /nosniff-untyped.js': 'remote-refused',
    })
    const image = report.artifacts.find(({ url }: Json) => url.endsWith('/image.js'))
    expect(image.retrieval).toMatchObject({ finalUrl: 'https://cdn.example/image.js', contentType: 'image/png' })
    expect(report.completeness.limitations.map(({ detail }: Json) => detail)).toContainEqual(
      expect.stringContaining('image/png'),
    )
  })

  test('module scripts, dynamic imports and workers need a JavaScript MIME type', async () => {
    const javascriptType = { 'content-type': 'text/javascript' }
    const plain = { 'content-type': 'text/plain' }
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(
      cdn,
      typed({
        '/module.js': javascriptType,
        '/module-plain.js': plain,
        '/module-untyped.js': {},
        '/lazy.js': { 'content-type': 'application/x-javascript' },
        '/lazy-html.js': { 'content-type': 'text/html' },
        '/worker.js': javascriptType,
        '/worker-plain.js': plain,
        '/imported-plain.js': plain,
      }),
    )
    const files = {
      'index.html': [
        '<script type="module" src="https://cdn.example/module.js"></script>',
        '<script type="module" src="https://cdn.example/module-plain.js"></script>',
        '<script type="module" src="https://cdn.example/module-untyped.js"></script>',
        '<script src="main.js"></script>',
      ].join(''),
      'main.js': [
        'import("https://cdn.example/lazy.js"); import("https://cdn.example/lazy-html.js")',
        'new Worker("https://cdn.example/worker.js"); new Worker("https://cdn.example/worker-plain.js")',
      ].join('\n'),
    }

    const { report } = await scanBuild(files, [...resolve, ...onCdn], { deps: { resolveFetcher: network.fetcher() } })

    expect(byPath(report)).toMatchObject({
      'window /module.js': 'ok',
      'window /module-plain.js': 'remote-refused',
      'window /module-untyped.js': 'remote-refused',
      'window /lazy.js': 'ok',
      'window /lazy-html.js': 'remote-refused',
      'dedicated-worker /worker.js': 'ok',
      'dedicated-worker /worker-plain.js': 'remote-refused',
    })
  })

  test('a script `importScripts` loads needs a JavaScript MIME type, as a worker does', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (request, response) =>
      request.url === '/worker.js'
        ? response.writeHead(200, { 'content-type': 'text/javascript' }).end('importScripts("imported.js")')
        : response.writeHead(200, { 'content-type': 'text/plain' }).end('self.fetch = f'),
    )
    const files = {
      'index.html': '<script src="main.js"></script>',
      'main.js': 'new Worker("https://cdn.example/worker.js")',
    }

    const { report } = await scanBuild(files, [...resolve, ...onCdn], { deps: { resolveFetcher: network.fetcher() } })

    expect(byPath(report)).toMatchObject({
      'dedicated-worker /worker.js': 'ok',
      'dedicated-worker /imported.js': 'remote-refused',
    })
  })

  test('one URL is judged as each reference fetches it, and requested once', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, typed({ '/sdk.js': { 'content-type': 'text/plain' } }))
    const files = {
      'index.html': [
        // A classic preload, then a module script: the window runs the module.
        '<link rel="preload" as="script" href="https://cdn.example/sdk.js">',
        '<script type="module" src="https://cdn.example/sdk.js"></script>',
        '<script src="main.js"></script>',
      ].join(''),
      // A classic worker of the same script, and a classic script of the window at another fragment.
      'main.js': 'new Worker("https://cdn.example/sdk.js"); document.head.append("…")',
      'other.html': '<script src="https://cdn.example/sdk.js#classic"></script>',
    }
    const entries = [...onCdn, '--entry', 'other.html@https://cdn.example/app/other']

    const { report } = await scanBuild(files, [...resolve, ...entries], { deps: { resolveFetcher: network.fetcher() } })

    const artifacts = report.artifacts.map(({ url, realm, sourceType, retrieval }: Json) => [
      url,
      realm,
      sourceType,
      retrieval.status,
    ])
    expect(artifacts).toEqual([
      ['https://cdn.example/app/main.js', 'window', 'script', 'ok'],
      ['https://cdn.example/sdk.js', 'window', 'module', 'remote-refused'],
      ['https://cdn.example/sdk.js', 'dedicated-worker', 'script', 'remote-refused'],
      ['https://cdn.example/sdk.js#classic', 'window', 'script', 'ok'],
    ])
    expect(network.requests.map(({ url }) => url)).toEqual(['https://cdn.example/sdk.js'])
  })

  test('a URL refused as a worker’s script but run as a classic script of the window is analyzed there, and counted so', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, typed({ '/sdk.js': { 'content-type': 'text/plain' } }))
    const files = {
      'index.html': '<script src="https://cdn.example/sdk.js"></script><script src="main.js"></script>',
      'main.js': 'new Worker("https://cdn.example/sdk.js")',
    }

    const { report } = await scanBuild(files, [...resolve, ...onCdn], { deps: { resolveFetcher: network.fetcher() } })

    expect(byPath(report)).toEqual({
      'window /app/main.js': 'ok',
      'window /sdk.js': 'ok',
      'dedicated-worker /sdk.js': 'remote-refused',
    })
    expect(limitations(report)).toEqual([['remote-refused', 'https://cdn.example/sdk.js']])
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 3, analyzed: 2, skipped: { refused: 1 } })
    expect(report.findings.map(({ targetKey }: Json) => targetKey)).toEqual(['window|Window.fetch|replace'])
    expect(network.requests).toHaveLength(1)
  })

  test('a module preload the floor refuses, which a classic script then runs, is read again as the classic script', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, typed({ '/sdk.js': { 'content-type': 'text/plain' } }))
    const files = {
      'index.html': [
        '<link rel="modulepreload" href="https://cdn.example/sdk.js">',
        '<script src="https://cdn.example/sdk.js"></script>',
      ].join(''),
    }

    const { report } = await scanBuild(files, resolve, { deps: { resolveFetcher: network.fetcher() } })

    expect(report.artifacts.map(({ sourceType, retrieval }: Json) => [sourceType, retrieval.status])).toEqual([
      ['script', 'ok'],
    ])
    // The module preload's refusal is not the artifact's: the classic script was fetched and analyzed.
    expect(limitations(report)).toEqual([])
    expect(report.completeness.level).toBe('complete')
    expect(report.findings.map(({ targetKey }: Json) => targetKey)).toEqual(['window|Window.fetch|replace'])
    expect(network.requests).toHaveLength(1)
  })

  test('a source map is read whatever its type', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (_, response) =>
      response
        .writeHead(200, { 'content-type': 'application/octet-stream', 'x-content-type-options': 'nosniff' })
        .end('{}'),
    )
    const hooks = network.fetcher()

    const document = 'https://app.example/'
    const map = await hooks().fetch('https://cdn.example/sdk.js.map', { destination: 'map', document })
    const asScript = await hooks().fetch('https://cdn.example/sdk.js.map', { destination: 'script', document })

    expect(map.status).toBe('ok')
    expect(asScript.status).toBe('remote-refused')
  })
})

describe('caching (§17 What is fetched)', () => {
  test('each URL is requested once per scan: from any reference, realm or fragment, and as a redirect’s target', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (request, response) => {
      if (request.url === '/sdk.js') javascript()(request, response)
      else response.writeHead(301, { location: '/sdk.js' }).end()
    })
    const files = {
      'index.html': [
        '<script src="https://cdn.example/sdk.js"></script>',
        '<script src="https://cdn.example/sdk.js#again"></script>',
        '<script src="https://cdn.example/old.js"></script>',
        '<script src="https://cdn.example/older.js"></script>',
        '<script src="main.js"></script>',
      ].join(''),
      'main.js': 'new Worker("https://cdn.example/sdk.js"); import("https://cdn.example/sdk.js")',
    }

    const { report } = await scanBuild(files, resolve, { deps: { resolveFetcher: network.fetcher() } })

    expect(report.completeness.limitations).toEqual([])
    expect(network.requests.map(({ url }) => url).sort()).toEqual([
      'https://cdn.example/old.js',
      'https://cdn.example/older.js',
      'https://cdn.example/sdk.js',
    ])
    expect(network.lookups).toHaveLength(3)
  })

  test('nothing is cached across scans', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, javascript())
    const build = fixtureBuild({ 'index.html': '<script src="https://cdn.example/sdk.js"></script>' })
    const resolveFetcher = network.fetcher({ limits: { artifacts: 1 } })

    const first = await scanBuild(build, resolve, { deps: { resolveFetcher } })
    const second = await scanBuild(build, resolve, { deps: { resolveFetcher } })

    expect([first, second].map(({ report }) => statuses(report))).toEqual([
      [['https://cdn.example/sdk.js', 'ok']],
      [['https://cdn.example/sdk.js', 'ok']],
    ])
    expect(network.requests).toHaveLength(2)
  })
})

describe('the network is reached only in `--mode resolve` (§16, §17 Modes)', () => {
  const files = { 'index.html': '<script src="https://cdn.example/sdk.js"></script>', 'main.js': '' }

  test('scans and baseline commands without `--mode resolve` never make the resolve fetcher, look up or connect', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, javascript())
    const made: string[] = []
    const factory = network.fetcher()
    const resolveFetcher = () => (made.push('fetcher'), factory())
    const build = fixtureBuild(files)
    const cwd = workingDir()

    const runs = [
      await runCli(['scan', build, '--map', defaultMap], { cwd, deps: { resolveFetcher } }),
      await runCli(['scan', build, '--map', defaultMap, '--mode', 'offline'], { cwd, deps: { resolveFetcher } }),
      await runCli(['baseline', 'init', build, '--map', defaultMap], { cwd, deps: { resolveFetcher } }),
      await runCli(['baseline', 'update', build, '--map', defaultMap], { cwd, deps: { resolveFetcher } }),
    ]

    expect(runs.map(({ exitCode }) => exitCode)).toEqual([0, 0, 0, 0])
    expect(made).toEqual([])
    expect([network.lookups, network.connects, network.requests]).toEqual([[], [], []])
  })

  test('the CLI’s own resolve fetcher applies the floor: a loopback URL is refused without touching the network', async () => {
    const run = await runCli([
      'scan',
      fixtureBuild({ 'index.html': '<script src="http://127.0.0.1:9/sdk.js"></script>' }),
      '--map',
      'http://app.example/=.',
      '--mode',
      'resolve',
      '--json',
      '-',
    ])

    expect(run.exitCode).toBe(0)
    const report = JSON.parse(run.stdout)
    assertValidReport(report)
    expect(limitations(report)).toEqual([['remote-refused', 'http://127.0.0.1:9/sdk.js']])
    expect(report.run.retrievals).toEqual({})
  })
})

describe('what a refusal means for the report and the baseline (§13, §17 What is recorded)', () => {
  test('a refusal made on a response records its retrieval facts in `run`; one made before any request records none', async () => {
    const network = fakeNetwork({ 'cdn.example': cdn })
    network.serve(cdn, (_, response) =>
      response.writeHead(200, { 'content-type': 'image/png', etag: '"png"' }).end('window.fetch = f'),
    )
    const files = {
      'index.html': '<script src="https://cdn.example/image.js"></script><script src="https://127.0.0.1/sdk.js"></script>',
    }

    const { report } = await scanBuild(files, resolve, { deps: { resolveFetcher: network.fetcher() } })

    expect(statuses(report)).toEqual([
      ['https://127.0.0.1/sdk.js', 'remote-refused'],
      ['https://cdn.example/image.js', 'remote-refused'],
    ])
    expect(Object.keys(report.run.retrievals)).toEqual(['https://cdn.example/image.js'])
    expect(report.run.retrievals['https://cdn.example/image.js'].etag).toBe('"png"')
  })

  test('a remote baseline entry missing from a scan that refused a remote script is unconfirmed; a local one is removed', async () => {
    const network = fakeNetwork({ 'cdn.example': '10.0.0.8' })
    const cwd = workingDir()
    const page = '<script src="main.js"></script><script src="https://cdn.example/lib.js"></script>'
    const before = fixtureBuild({ 'index.html': page, 'main.js': 'window.fetch = a\nwindow.setTimeout = b\n' })
    const init = await runCli(['baseline', 'init', before, '--map', defaultMap], { cwd })
    expect(init.exitCode).toBe(0)
    const path = join(cwd, 'monkeypatchlist.baseline.json')
    const baseline = JSON.parse(readFileSync(path, 'utf8'))
    baseline.entries.push({
      fingerprint: 'window|Window.open|wrap|url:https://cdn.example/lib.js',
      target: { realm: 'window', holder: 'global', name: 'Window.open' },
      surface: 'navigation',
      effect: 'wrap',
      locks: false,
      attribution: { key: 'url:https://cdn.example/lib.js', provenance: 'remote' },
    })
    writeFileSync(path, JSON.stringify(baseline, null, 2))

    const run = await runCli(
      [
        'scan',
        fixtureBuild({ 'index.html': page, 'main.js': 'window.fetch = a\n' }),
        '--map',
        defaultMap,
        '--baseline',
        'monkeypatchlist.baseline.json',
        '--json',
        '-',
        ...resolve,
      ],
      { cwd, deps: { resolveFetcher: network.fetcher() } },
    )

    const report = JSON.parse(run.stdout)
    assertValidReport(report)
    expect(limitations(report)).toEqual([['remote-refused', 'https://cdn.example/lib.js']])
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.findings.map(({ fingerprint, baselineState }: Json) => [fingerprint, baselineState])).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing'],
      ['window|Window.open|wrap|url:https://cdn.example/lib.js', 'unconfirmed'],
      ['window|Window.setTimeout|replace|unknown', 'removed'],
    ])
  })
})

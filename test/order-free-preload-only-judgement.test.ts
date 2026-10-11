// Whether a classically preloaded file gets its syntax-typed visit is judged against running references in
// any realm, and in no order (§2 Files that don't run as referenced).
// Scans run end to end through `monkeypatchlist scan --json -`; a spy resolver and a recording
// fixture fetcher, swapped in through the CLI's `deps`, show which analyses and fetches run.

import { describe, expect, test } from 'vitest'
import { jsResolver, type AnalyzeGroupInput, type Resolver } from '../src/packages/analysis/index.ts'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import type { FetchRequest } from '../src/packages/source-store/index.ts'
import { fakeNetwork } from './support/fake-network.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** The JS resolver, recording the entry of each group it analyzes, with its realm and source type. */
function spyResolver(): Resolver & { entries: string[] } {
  const entries: string[] = []
  return {
    entries,
    analyzerVersion: jsResolver.analyzerVersion,
    analyzeGroup(input: AnalyzeGroupInput) {
      const { url, sourceType, realm } = input.entry
      entries.push(`${realm} ${sourceType} ${url}`)
      return jsResolver.analyzeGroup(input)
    },
  }
}

/** The fixture fetcher over `responses`, recording the URL of every fetch it is asked for. */
function recordingFetcher(responses: Parameters<typeof fixtureFetcher>[0] = {}) {
  const fetcher = fixtureFetcher(responses)
  const urls: string[] = []
  return {
    urls,
    fetch: (url: string, request: FetchRequest) => (urls.push(url), fetcher.fetch(url, request)),
  }
}

const js = (body: string) => ({
  headers: { 'content-type': 'text/javascript' },
  body,
})

/** Both orders of two `<link rel=preload as=script>` elements. */
const bothOrders = (first: string, second: string) => [
  [
    `${first} first`,
    `<link rel="preload" as="script" href="${first}"><link rel="preload" as="script" href="${second}">`,
  ],
  [
    `${second} first`,
    `<link rel="preload" as="script" href="${second}"><link rel="preload" as="script" href="${first}">`,
  ],
]

/** The report without its `run` block, as JSON. */
const stable = (report: Json) => JSON.stringify({ ...report, run: null })

/** Each artifact's URL, realm, source type, realm basis and discovery method. */
const graphOf = (report: Json) =>
  report.artifacts.map(({ url, realm, sourceType, realmBasis, discovery }: Json) =>
    [url, realm, sourceType, realmBasis, discovery].join(' '),
  )

// b.js parses only as a classic script (an HTML-like comment), so only its classic parse finds its requests.
const classicOnly = '<!-- classic only\nimport("./c.mjs"); import("https://cdn.example/r.mjs"); new Worker("/w.js")'

describe('a classically preloaded file a preload-only module also imports', () => {
  test.each(bothOrders('a.mjs', 'b.js'))(
    'gets its syntax-typed visit (%s): its classic requests are followed with the assumed basis',
    async (_, links) => {
      const fetcher = recordingFetcher({
        'https://cdn.example/r.mjs': js('window.open = o'),
      })
      const files = {
        'index.html': links,
        'a.mjs': 'import "./b.js"; export {}',
        'b.js': classicOnly,
        'c.mjs': 'export {}; window.fetch = f',
        'w.js': 'self.close = c',
      }

      const { report } = await scanBuild(files, ['--mode', 'resolve'], {
        deps: { resolveFetcher: () => fetcher },
      })

      expect(graphOf(report)).toEqual([
        'https://app.example/a.mjs window module assumed reference',
        'https://app.example/b.js window module assumed reference',
        'https://app.example/c.mjs window module assumed reference',
        'https://app.example/w.js dedicated-worker script reference reference',
        'https://cdn.example/r.mjs window module assumed reference',
      ])
      expect(fetcher.urls).toEqual(['https://cdn.example/r.mjs'])
      expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual(
        expect.arrayContaining([
          'window|Window.fetch|replace|unknown',
          'dedicated-worker|DedicatedWorkerGlobalScope.close|replace|unknown',
        ]),
      )
      // b.js is a module artifact, which its classic syntax fails.
      expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
        ['parse-failure', 'https://app.example/b.js'],
      ])
    },
  )

  test.each(bothOrders('a.mjs', 'b.js'))(
    'a remote request of its classic parse is offline-skipped offline (%s)',
    async (_, links) => {
      const { report } = await scanBuild({
        'index.html': links,
        'a.mjs': 'import "./b.js"; export {}',
        'b.js': classicOnly,
        'c.mjs': 'export {}',
        'w.js': '',
      })

      const [remote] = report.artifacts.filter(({ url }: Json) => url === 'https://cdn.example/r.mjs')
      expect(remote).toMatchObject({
        realmBasis: 'assumed',
        retrieval: { status: 'offline-skipped' },
      })
      expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual(
        expect.arrayContaining([['offline-skipped', 'https://cdn.example/r.mjs']]),
      )
    },
  )

  test('the report is byte-identical whichever order the preloads come in', async () => {
    const files = (links: string) => ({
      'index.html': links,
      'a.mjs': 'import "./b.js"; export {}',
      'b.js': classicOnly,
      'c.mjs': 'import "./d.mjs"; export {}; window.fetch = f',
      'd.mjs': 'export {}',
      'w.js': 'self.close = c',
    })
    const [[, first], [, second]] = bothOrders('a.mjs', 'b.js') as [[string, string], [string, string]]

    const one = await scanBuild(files(first))
    const other = await scanBuild(files(second))

    expect(stable(one.report)).toBe(stable(other.report))
  })
})

describe('two classically preloaded files that import each other', () => {
  test.each(bothOrders('b.js', 'c.js'))('each gets its syntax-typed visit (%s)', async (_, links) => {
    const { report } = await scanBuild({
      'index.html': links,
      'b.js': '<!-- classic only\nimport("./c.js"); new Worker("/wb.js")',
      'c.js': '<!-- classic only\nimport("./b.js"); new Worker("/wc.js")',
      'wb.js': '',
      'wc.js': '',
    })

    expect(graphOf(report)).toEqual([
      'https://app.example/b.js window module assumed reference',
      'https://app.example/c.js window module assumed reference',
      'https://app.example/wb.js dedicated-worker script reference reference',
      'https://app.example/wc.js dedicated-worker script reference reference',
    ])
  })
})

describe('the visit changes, not the artifact', () => {
  test.each(bothOrders('a.mjs', 'b.js'))(
    'b.js stays one module artifact with its realm assumed, and its this.fetch gives no finding (%s)',
    async (_, links) => {
      const resolver = spyResolver()

      const { report } = await scanBuild(
        {
          'index.html': links,
          'a.mjs': "import './b.js'; export {}",
          'b.js': 'this.fetch = wrap(fetch)',
        },
        [],
        { deps: { resolver } },
      )

      expect(graphOf(report)).toEqual([
        'https://app.example/a.mjs window module assumed reference',
        'https://app.example/b.js window module assumed reference',
      ])
      expect(resolver.entries).not.toContain('window script https://app.example/b.js')
      expect(report.findings).toEqual([])
      expect(report.completeness.limitations).toEqual([])
    },
  )
})

describe('a running reference in any realm counts', () => {
  test.each([
    ['a worker', 'new Worker("/worker.js")', 'dedicated-worker', {}],
    ['a service worker', 'navigator.serviceWorker.register("/worker.js")', 'service-worker', {}],
    [
      'importScripts in a running worker',
      'new Worker("/w.js")',
      'dedicated-worker',
      { 'w.js': 'importScripts("/worker.js")' },
    ],
  ])('a classically preloaded file %s runs is analyzed only in that realm', async (_, main, realm, extra) => {
    const resolver = spyResolver()
    const links = '<link rel="preload" as="script" href="/worker.js">'

    for (const page of [`${links}<script src="main.js"></script>`, `<script src="main.js"></script>${links}`]) {
      const { report } = await scanBuild(
        {
          'index.html': page,
          'main.js': main,
          'worker.js': 'self.addEventListener("message", onMessage); self.close = c',
          ...extra,
        },
        [],
        { deps: { resolver } },
      )

      const worker = report.artifacts.filter(({ url }: Json) => url === 'https://app.example/worker.js')
      expect(worker.map(({ realm, realmBasis }: Json) => [realm, realmBasis])).toEqual([[realm, 'reference']])
      expect(resolver.entries).not.toContain('window script https://app.example/worker.js')
      expect(report.findings.filter(({ fingerprint }: Json) => fingerprint.startsWith('window|'))).toEqual([])
      expect(report.completeness.limitations).toEqual([])
    }
  })

  test("a reference that doesn't run, such as a preload-only file's worker URL, doesn't count", async () => {
    const { report } = await scanBuild({
      'index.html': '<link rel="preload" as="script" href="a.js"><link rel="preload" as="script" href="/worker.js">',
      'a.js': 'new Worker("/worker.js")',
      'worker.js': 'self.close = c',
    })

    expect(graphOf(report)).toEqual([
      'https://app.example/a.js window script assumed reference',
      'https://app.example/worker.js window script assumed reference',
      'https://app.example/worker.js dedicated-worker script reference reference',
    ])
  })
})

describe("a syntax-typed visit parses the bytes of the preload's own fetch", () => {
  const bBody = "import('https://cdn.example/c.mjs')"

  test.each([
    [
      'b.js first',
      '<link rel="preload" as="script" href="https://cdn.example/b.js"><link rel="preload" as="script" href="/a.mjs">',
    ],
    [
      'a.mjs first',
      '<link rel="preload" as="script" href="/a.mjs"><link rel="preload" as="script" href="https://cdn.example/b.js">',
    ],
  ])('a remote file refused as a module is still visited as the preload fetched it (%s)', async (_, links) => {
    // The real resolve fetcher over an in-process network, so the safety floor judges each destination (§17).
    const network = fakeNetwork({ 'cdn.example': '203.0.113.10' })
    network.serve('203.0.113.10', (request, response) => {
      if (request.url === '/b.js') response.writeHead(200, { 'content-type': 'text/plain' }).end(bBody)
      else response.writeHead(200, { 'content-type': 'text/javascript' }).end('window.fetch = f')
    })

    const { report } = await scanBuild(
      {
        'index.html': links,
        'a.mjs': "import 'https://cdn.example/b.js'; export {}",
      },
      ['--mode', 'resolve'],
      { deps: { resolveFetcher: network.fetcher() } },
    )

    const byUrl = Object.fromEntries(report.artifacts.map((artifact: Json) => [artifact.url, artifact]))
    expect(byUrl['https://cdn.example/b.js']).toMatchObject({
      sourceType: 'module',
      retrieval: { status: 'remote-refused' },
    })
    expect(byUrl['https://cdn.example/c.mjs']).toMatchObject({
      realmBasis: 'assumed',
      retrieval: { status: 'ok' },
    })
    const [finding] = report.findings
    // Remote code keys `url:` (§11).
    expect(finding.fingerprint).toBe('window|Window.fetch|replace|url:https://cdn.example/c.mjs')
    expect(finding.occurrences[0].artifact).toMatchObject({
      url: 'https://cdn.example/c.mjs',
      origin: 'cross-origin',
    })
    expect(finding.occurrences[0].confidence.target.reasons).toEqual(['realm-assumed'])
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
      ['remote-refused', 'https://cdn.example/b.js'],
    ])
  })
})

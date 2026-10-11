// Preload-only files and other script URLs (§2 Files that don't run as referenced, Other script URLs; §13
// `realm-uncertain`). Scans run end to end through
// `monkeypatchlist scan --json -`; a spy resolver swapped in through the CLI's `deps` shows which analyses run.

import { describe, expect, test } from 'vitest'
import { jsResolver, type AnalyzeGroupInput, type Resolver } from '../src/packages/analysis/index.ts'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import type { FetchRequest } from '../src/packages/source-store/index.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** The JS resolver, recording the entry of each group it analyzes, in order, with its source type and realm. */
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
  return { urls, fetch: (url: string, request: FetchRequest) => (urls.push(url), fetcher.fetch(url, request)) }
}

describe('other script URLs (§2 Other script URLs)', () => {
  test('a blob:, file: or about: script src gives no artifact and no record, and is no remote reference', async () => {
    const page = [
      '<script src="blob:https://app.example/3f1c2a9e-5b8d-4e7a-9c61-0d2f4b8a7e13"></script>',
      '<script src="file:///srv/app/sdk.js"></script>',
      '<script type="module" src="about:blank"></script>',
      '<script src="main.js"></script>',
    ].join('')
    const files = { 'index.html': page, 'main.js': 'window.fetch = f' }

    for (const mode of ['offline', 'resolve']) {
      const fetcher = recordingFetcher()
      const { report } = await scanBuild(files, ['--mode', mode], { deps: { resolveFetcher: () => fetcher } })

      expect(report.artifacts.map(({ url }: Json) => url)).toEqual(['https://app.example/main.js'])
      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.level).toBe('complete')
      expect(report.completeness.counters.artifacts).toMatchObject({ known: 1, analyzed: 1 })
      expect(fetcher.urls).toEqual([])
      expect(report.run.retrievals).toEqual({})
    }
  })

  test('so does one wherever it appears: preloads, imports, workers, importScripts and service workers', async () => {
    const fetcher = recordingFetcher()

    const { report } = await scanBuild(
      {
        'index.html': [
          '<link rel="preload" as="script" href="blob:https://app.example/a">',
          '<link rel="modulepreload" href="file:///srv/b.js">',
          '<link rel="modulepreload" as="serviceworker" href="about:blank">',
          '<script type="module">import "blob:https://app.example/c"; import("file:///srv/d.js")</script>',
          '<script src="main.js"></script>',
        ].join(''),
        'main.js': [
          'new Worker("blob:https://app.example/e"); new SharedWorker("about:blank")',
          'navigator.serviceWorker.register("blob:https://app.example/f"); new Worker("/w.js")',
        ].join('\n'),
        'w.js': 'importScripts("file:///srv/g.js", "about:srcdoc")',
      },
      ['--mode', 'resolve'],
      { deps: { resolveFetcher: () => fetcher } },
    )

    expect(report.artifacts.map(({ url, realm }: Json) => [url, realm])).toEqual([
      ['https://app.example/#inline-1', 'window'],
      ['https://app.example/main.js', 'window'],
      ['https://app.example/w.js', 'dedicated-worker'],
    ])
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.level).toBe('complete')
    expect(fetcher.urls).toEqual([])
  })

  test('a data: service-worker URL gives no artifact, record or finding, from register or a modulepreload', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<link rel="modulepreload" as="serviceworker" href="data:text/javascript,self.fetch=f">',
        '<script src="main.js"></script>',
      ].join(''),
      'main.js': 'navigator.serviceWorker.register("data:text/javascript,self.close=c")',
    })

    expect(report.artifacts.map(({ url }: Json) => url)).toEqual(['https://app.example/main.js'])
    expect(report.findings).toEqual([])
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.level).toBe('complete')
  })
})

describe("a preload of a file a reference runs (§2 Files that don't run as referenced)", () => {
  test.each([
    ['before', '<link rel="preload" as="script" href="x.js"><script src="x.js"></script>'],
    ['after', '<script src="x.js"></script><link rel="preload" as="script" href="x.js">'],
  ])('a preload %s the script element adds no visit of its own, so a module import is not followed', async (_, page) => {
    const resolver = spyResolver()
    const fetcher = recordingFetcher()

    const { report } = await scanBuild(
      {
        'index.html': page,
        'x.js': 'import "./dep.js"; import "https://cdn.example/sdk.js"',
        'dep.js': 'window.fetch = f',
      },
      ['--mode', 'resolve'],
      { deps: { resolver, resolveFetcher: () => fetcher } },
    )

    // x.js runs as a classic script, which its module syntax fails, and is analyzed once, that way. The sweep finds
    // dep.js, and the remote import is neither fetched nor recorded.
    expect(report.artifacts.map(({ url, sourceType, discovery }: Json) => [url, sourceType, discovery])).toEqual([
      ['https://app.example/dep.js', 'script', 'sweep'],
      ['https://app.example/x.js', 'script', 'reference'],
    ])
    expect(resolver.entries).toEqual(['window script https://app.example/x.js', 'window script https://app.example/dep.js'])
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
      ['parse-failure', 'https://app.example/x.js'],
    ])
    expect(fetcher.urls).toEqual([])
  })
})

describe("a preload-only file's imports (§2 Files that don't run as referenced)", () => {
  test('are followed, and inherit its assumed realm basis: realm-assumed', async () => {
    const { report } = await scanBuild({
      'index.html': '<link rel="preload" as="script" href="chunk.js">',
      'chunk.js': 'import "./dep.js"; export {}',
      'dep.js': 'export {}; window.fetch = f',
    })

    const graph = report.artifacts.map(({ url, sourceType, realm, realmBasis, discovery, parent }: Json) => [
      url,
      sourceType,
      realm,
      realmBasis,
      discovery,
      parent,
    ])
    expect(graph).toEqual([
      ['https://app.example/chunk.js', 'module', 'window', 'assumed', 'reference', 'https://app.example/'],
      ['https://app.example/dep.js', 'module', 'window', 'assumed', 'reference', 'https://app.example/chunk.js'],
    ])
    const [finding] = report.findings
    expect(finding.fingerprint).toBe('window|Window.fetch|replace|unknown')
    expect(finding.occurrences[0].confidence.target).toEqual({ level: 'medium', reasons: ['realm-assumed'] })
    expect(finding.occurrences[0].trace[0]).toMatchObject({ kind: 'confidence-reason', reason: 'realm-assumed' })
    expect(report.completeness.level).toBe('complete')
  })

  test("pass the basis on to their own imports, and a reference's basis wins", async () => {
    const { report } = await scanBuild({
      'index.html': '<link rel="preload" as="script" href="chunk.js"><script type="module" src="main.js"></script>',
      'chunk.js': 'import "./dep.js"; import "./shared.js"',
      'dep.js': 'import "./deeper.js"',
      'deeper.js': 'export {}',
      'shared.js': 'export {}',
      'main.js': 'import "./shared.js"',
    })

    expect(report.artifacts.map(({ url, realmBasis }: Json) => [url, realmBasis])).toEqual([
      ['https://app.example/chunk.js', 'assumed'],
      ['https://app.example/deeper.js', 'assumed'],
      ['https://app.example/dep.js', 'assumed'],
      ['https://app.example/main.js', 'reference'],
      ['https://app.example/shared.js', 'reference'],
    ])
  })

  test('raise realm-uncertain when they have worker markers', async () => {
    const { report } = await scanBuild({
      'index.html': '<link rel="preload" as="script" href="chunk.js">',
      'chunk.js': 'import "./dep.js"',
      'dep.js': 'export {}; self.addEventListener("message", onMessage)',
    })

    const [dep] = report.artifacts.filter(({ url }: Json) => url === 'https://app.example/dep.js')
    expect(dep).toMatchObject({ sourceType: 'module', realmBasis: 'assumed' })
    expect(report.completeness.limitations).toEqual([
      {
        kind: 'realm-uncertain',
        artifact: { url: 'https://app.example/dep.js', path: 'dep.js', hash: dep.hash },
        location: { start: 11, end: 54, line: 1, column: 11 },
        detail: expect.stringContaining('self.addEventListener("message")'),
      },
    ])
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.completeness.counters.blindSpots.realmUncertain).toBe(1)
  })

  test('a remote import is still fetched in resolve mode, and inherits the basis too', async () => {
    const fetcher = recordingFetcher({
      'https://cdn.example/dep.js': { headers: { 'content-type': 'text/javascript' }, body: 'window.fetch = f' },
    })

    const { report } = await scanBuild(
      { 'index.html': '<link rel="preload" as="script" href="chunk.js">', 'chunk.js': 'import "https://cdn.example/dep.js"' },
      ['--mode', 'resolve'],
      { deps: { resolveFetcher: () => fetcher } },
    )

    const [remote] = report.artifacts.filter(({ url }: Json) => url === 'https://cdn.example/dep.js')
    expect(remote).toMatchObject({ origin: 'cross-origin', sourceType: 'module', realmBasis: 'assumed' })
    expect(remote.retrieval.status).toBe('ok')
    expect(fetcher.urls).toEqual(['https://cdn.example/dep.js'])
    const [finding] = report.findings
    expect(finding.occurrences[0].confidence.target).toEqual({ level: 'medium', reasons: ['realm-assumed'] })
  })
})

describe('realm-uncertain for a preload-only file (§2 Realm, §13)', () => {
  test('a preload-only file with top-level importScripts raises realm-uncertain, and the scan has limitations', async () => {
    const { report } = await scanBuild({
      'index.html': '<link rel="preload" as="script" href="sw.js">',
      'sw.js': 'importScripts("/lib.js");\nself.addEventListener("fetch", onFetch)',
      'lib.js': '',
    })

    const [sw] = report.artifacts.filter(({ url }: Json) => url === 'https://app.example/sw.js')
    expect(sw).toMatchObject({ discovery: 'reference', realm: 'window', realmBasis: 'assumed' })
    expect(report.completeness.limitations).toEqual([
      {
        kind: 'realm-uncertain',
        artifact: { url: 'https://app.example/sw.js', path: 'sw.js', hash: sw.hash },
        location: { start: 0, end: 24, line: 1, column: 0 },
        detail: expect.stringContaining('importScripts'),
      },
    ])
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.completeness.counters.blindSpots.realmUncertain).toBe(1)
  })

  test('a file preloads and a running reference both name has its realm from the reference, and no record', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<link rel="preload" as="script" href="a.js"><script src="a.js"></script>',
        '<link rel="preload" as="script" href="b.js"><link rel="modulepreload" href="b.js">',
      ].join(''),
      'a.js': 'importScripts("/lib.js")',
      'b.js': 'self.addEventListener("install", onInstall)',
    })

    expect(report.artifacts.map(({ url, realmBasis }: Json) => [url, realmBasis])).toEqual([
      ['https://app.example/a.js', 'reference'],
      ['https://app.example/b.js', 'reference'],
    ])
    expect(report.completeness.limitations).toEqual([])
  })
})

describe('determinism (§15)', () => {
  test('two scans of a build with preload-only files, their imports and other script URLs give byte-identical reports', async () => {
    const files = {
      'index.html': [
        '<link rel="preload" as="script" href="chunk.js"><link rel="preload" as="script" href="x.js">',
        '<script src="x.js"></script><script src="blob:https://app.example/a"></script>',
        '<link rel="modulepreload" as="serviceworker" href="data:text/javascript,self.fetch=f">',
      ].join(''),
      'chunk.js': 'import "./dep.js"; importScripts("/x.js")',
      'dep.js': 'export {}; window.open = o',
      'x.js': 'window.alert = g',
    }

    const first = await scanBuild(files)
    const second = await scanBuild(files)

    expect(first.report.artifacts).toHaveLength(3)
    expect(JSON.stringify({ ...first.report, run: null })).toBe(JSON.stringify({ ...second.report, run: null }))
  })
})

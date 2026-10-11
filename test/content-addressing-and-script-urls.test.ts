// Content addressing per URL, `data:` scripts and files that don't run as referenced (§2 Discovery,
// Artifacts, Files that don't run as referenced, Other script URLs; §17). Scans run end to end through
// `monkeypatchlist scan --json -`; a spy resolver swapped in through the CLI's `deps` shows which analyses run.

import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { crashGuardMs } from '../src/cli.ts'
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

/** Each finding's fingerprint, and the artifact URL of each of its occurrences. */
const found = (report: Json) =>
  report.findings.map(({ fingerprint, occurrences }: Json) => [
    fingerprint,
    occurrences.map(({ artifact }: Json) => artifact.url),
  ])

/** A source map of one segment, at the start of the first line: it verifies against any artifact. */
const map = (source: string) => JSON.stringify({ version: 3, sources: [source], names: [], mappings: 'AAAA' })

describe('identical bytes are analyzed once, and each copy keeps its own record (§2 Artifacts)', () => {
  test('two local paths with identical bytes are two records that share one analysis; each has its findings and its map', async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(
      {
        'index.html': '<script src="v1/sdk.js"></script><script src="v2/sdk.js"></script>',
        'v1/sdk.js': 'window.alert = g',
        'v1/sdk.js.map': map('one.js'),
        'v2/sdk.js': 'window.alert = g',
        'v2/sdk.js.map': map('two.js'),
      },
      [],
      { deps: { resolver } },
    )

    expect(report.artifacts.map(({ url, path, origin, sourceMap }: Json) => [url, path, origin, sourceMap])).toEqual([
      [
        'https://app.example/v1/sdk.js',
        'v1/sdk.js',
        'local-build',
        { method: 'sidecar', path: 'v1/sdk.js.map', status: 'verified' },
      ],
      [
        'https://app.example/v2/sdk.js',
        'v2/sdk.js',
        'local-build',
        { method: 'sidecar', path: 'v2/sdk.js.map', status: 'verified' },
      ],
    ])
    expect(report.artifacts[0].hash).toBe(report.artifacts[1].hash)
    expect(resolver.entries).toEqual(['window script https://app.example/v1/sdk.js'])
    // Each copy is attributed through its own map: with no package source, each map's directory is its root (§10
    // Roots with no shared place), so each names its own first-party file.
    expect(found(report)).toEqual([
      ['window|Window.alert|replace|app:one.js', ['https://app.example/v1/sdk.js']],
      ['window|Window.alert|replace|app:two.js', ['https://app.example/v2/sdk.js']],
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 2, analyzed: 2 })
    expect(report.completeness.attribution.artifacts).toEqual({ withMap: 2, withoutMap: 0, withBrokenMap: 0 })
  })

  test("each copy has the analysis's limitation records, and counts as failed when it fails", async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(
      {
        'index.html': ['a', 'b', 'c', 'd'].map((name) => `<script src="${name}.js"></script>`).join(''),
        'a.js': 'window.fetch = (',
        'b.js': 'window.fetch = (',
        'c.js': 'eval(code)',
        'd.js': 'eval(code)',
      },
      [],
      { deps: { resolver } },
    )

    expect(resolver.entries).toEqual([
      'window script https://app.example/a.js',
      'window script https://app.example/c.js',
    ])
    const records = report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url, artifact.path])
    expect(records).toEqual([
      ['parse-failure', 'https://app.example/a.js', 'a.js'],
      ['parse-failure', 'https://app.example/b.js', 'b.js'],
      ['dynamic-code', 'https://app.example/c.js', 'c.js'],
      ['dynamic-code', 'https://app.example/d.js', 'd.js'],
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 4, analyzed: 2 })
    expect(report.completeness.counters.artifacts.failed['parse-failure']).toBe(2)
    expect(report.completeness.counters.blindSpots.dynamicCode).toBe(2)
  })

  test('two remote URLs with identical bytes are two records that share one analysis, each with its origin and map', async () => {
    const resolver = spyResolver()
    const script = (map: string) => ({
      headers: { 'content-type': 'text/javascript', sourcemap: map },
      body: 'window.alert = g',
    })
    const fetcher = fixtureFetcher({
      'https://app.example/vendor/sdk.js': script('sdk.js.map'),
      'https://app.example/vendor/sdk.js.map': { body: map('vendor.js') },
      'https://cdn.example/sdk.js': script('https://cdn.example/maps/sdk.js.map'),
      'https://cdn.example/maps/sdk.js.map': { body: map('cdn.js') },
    })

    const { report } = await scanBuild(
      {
        'static/index.html': '<script src="/vendor/sdk.js"></script><script src="https://cdn.example/sdk.js"></script>',
      },
      ['--map', 'https://app.example/static/=static', '--entry', 'static/index.html', '--mode', 'resolve'],
      { deps: { resolver, resolveFetcher: () => fetcher } },
    )

    expect(report.artifacts.map(({ url, origin, sourceMap }: Json) => [url, origin, sourceMap])).toEqual([
      ['https://app.example/vendor/sdk.js', 'same-origin', { method: 'header', path: null, status: 'verified' }],
      ['https://cdn.example/sdk.js', 'cross-origin', { method: 'header', path: null, status: 'verified' }],
    ])
    expect(report.artifacts[0].hash).toBe(report.artifacts[1].hash)
    expect(resolver.entries).toEqual(['window script https://app.example/vendor/sdk.js'])
    // Remote code keys `url:` by its own URL (§11), so each copy is a finding of its own.
    expect(found(report)).toEqual([
      ['window|Window.alert|replace|url:https://app.example/vendor/sdk.js', ['https://app.example/vendor/sdk.js']],
      ['window|Window.alert|replace|url:https://cdn.example/sdk.js', ['https://cdn.example/sdk.js']],
    ])
    expect(report.findings.map(({ occurrences }: Json) => occurrences[0].artifact.origin)).toEqual([
      'same-origin',
      'cross-origin',
    ])
  })
})

describe('copies that stay apart (§2 Artifacts, Realm)', () => {
  test('a referenced file and a sweep-only copy of it keep their own realm basis, so the copy carries realm-assumed', async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(
      { 'index.html': '<script src="main.js"></script>', 'main.js': 'window.fetch = f', 'copy.js': 'window.fetch = f' },
      [],
      { deps: { resolver } },
    )

    expect(report.artifacts.map(({ url, discovery, realmBasis }: Json) => [url, discovery, realmBasis])).toEqual([
      ['https://app.example/copy.js', 'sweep', 'assumed'],
      ['https://app.example/main.js', 'reference', 'reference'],
    ])
    expect(resolver.entries).toEqual([
      'window script https://app.example/main.js',
      'window script https://app.example/copy.js',
    ])
    const [finding] = report.findings
    const reasons = finding.occurrences.map(({ artifact, confidence }: Json) => [artifact.url, confidence.target.reasons])
    expect(reasons).toEqual([
      ['https://app.example/copy.js', ['realm-assumed']],
      ['https://app.example/main.js', []],
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 2, analyzed: 2, sweepOnly: 1 })
  })

  test('an inline script and a file with identical bytes are two records, with their own keys, and one analysis', async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(
      {
        'index.html': '<script>window.fetch = f</script><script src="main.js"></script>',
        'main.js': 'window.fetch = f',
      },
      [],
      { deps: { resolver } },
    )

    expect(report.artifacts.map(({ url, origin }: Json) => [url, origin])).toEqual([
      ['https://app.example/#inline-1', 'inline'],
      ['https://app.example/main.js', 'local-build'],
    ])
    expect(resolver.entries).toEqual(['window script https://app.example/#inline-1'])
    expect(found(report)).toEqual([
      ['window|Window.fetch|replace|inline', ['https://app.example/#inline-1']],
      ['window|Window.fetch|replace|unknown', ['https://app.example/main.js']],
    ])
  })

  test('the same bytes in the window and in a worker are two records, each analyzed in its realm', async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(
      {
        'index.html': '<script src="main.js"></script><script src="shared.js"></script>',
        'main.js': 'new Worker("/shared.js")',
        'shared.js': 'self.fetch = f',
      },
      [],
      { deps: { resolver } },
    )

    expect(report.artifacts.map(({ url, realm }: Json) => [url, realm])).toEqual([
      ['https://app.example/main.js', 'window'],
      ['https://app.example/shared.js', 'window'],
      ['https://app.example/shared.js', 'dedicated-worker'],
    ])
    expect(resolver.entries).toEqual([
      'window script https://app.example/main.js',
      'window script https://app.example/shared.js',
      'dedicated-worker script https://app.example/shared.js',
    ])
    expect(found(report).map(([fingerprint]: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown',
      'window|Window.fetch|replace|unknown',
    ])
  })
})

describe('other script URLs (§2 Other script URLs)', () => {
  test('a data: script src is decoded and analyzed as code the page carries, with origin inline', async () => {
    const { report } = await scanBuild({ 'index.html': '<script src="data:text/javascript,window.fetch=f"></script>' })

    expect(report.artifacts).toEqual([
      {
        url: 'data:text/javascript,window.fetch=f',
        path: null,
        hash: expect.stringMatching(/^sha256:/),
        origin: 'inline',
        discovery: 'reference',
        sourceType: 'script',
        realm: 'window',
        realmBasis: 'reference',
        parent: 'https://app.example/',
        sourceMap: { method: 'none', path: null, status: 'none' },
        retrieval: {
          status: 'ok',
          requestedUrl: 'data:text/javascript,window.fetch=f',
          finalUrl: 'data:text/javascript,window.fetch=f',
          contentType: 'text/javascript',
          sri: 'none',
        },
        moduleLinking: { idioms: [], modules: 0, unlinked: 0, linkGroups: 1 },
      },
    ])
    expect(found(report)).toEqual([['window|Window.fetch|replace|inline', ['data:text/javascript,window.fetch=f']]])
    expect(report.findings[0].occurrences[0].artifact.origin).toBe('inline')
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
  })

  test('a javascript: src gives no artifact and no record, and neither is a remote reference in resolve mode', async () => {
    const fetcher = fixtureFetcher({})
    const urls: string[] = []
    const recording = { fetch: (url: string, request: FetchRequest) => (urls.push(url), fetcher.fetch(url, request)) }

    const { report } = await scanBuild(
      {
        'index.html': [
          '<script src="javascript:window.fetch=f"></script>',
          '<script type="module" src="javascript:x()"></script>',
          '<script src="data:,window.alert=g"></script>',
        ].join(''),
      },
      ['--mode', 'resolve'],
      { deps: { resolveFetcher: () => recording } },
    )

    expect(report.artifacts.map(({ url, origin }: Json) => [url, origin])).toEqual([['data:,window.alert=g', 'inline']])
    expect(found(report).map(([fingerprint]: Json) => fingerprint)).toEqual(['window|Window.alert|replace|inline'])
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 1, analyzed: 1 })
    expect(urls).toEqual([])
    expect(report.run.retrievals).toEqual({})
  })

  test('a javascript: URL gives nothing wherever it appears: imports, preloads, workers and service workers', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<link rel="preload" as="script" href="javascript:a()"><link rel="modulepreload" href="javascript:b()">',
        '<script type="module">import("javascript:c()")</script>',
        '<script src="main.js"></script>',
      ].join(''),
      'main.js': 'new Worker("javascript:d()"); navigator.serviceWorker.register("javascript:e()")',
    })

    expect(report.artifacts.map(({ url }: Json) => url)).toEqual([
      'https://app.example/#inline-1',
      'https://app.example/main.js',
    ])
    expect(report.completeness.limitations).toEqual([])
  })

  test('a data: script the browser refuses to run gives no artifact, no record and no findings', async () => {
    const stop = 'window.stop=k'
    const integrity = `sha384-${createHash('sha384').update(stop).digest('base64')}`

    const { report } = await scanBuild({
      'index.html': [
        // Refused: a module without a JavaScript MIME type, a blocked classic type, malformed base64, and bytes that
        // fail their integrity check.
        '<script type="module" src="data:text/plain,window.fetch=f"></script>',
        '<script src="data:image/png,window.alert=g"></script>',
        '<script src="data:text/javascript;base64,d2luZG93%"></script>',
        '<script src="data:text/javascript,window.open=h" integrity="sha256-AAAA"></script>',
        // Run: a classic script needs no JavaScript MIME type, and these bytes match their integrity value.
        `<script src="data:text/javascript;base64,${btoa(stop)}" integrity="${integrity}"></script>`,
        '<script src="data:text/plain,window.print=p"></script>',
      ].join(''),
    })

    expect(report.artifacts.map(({ url, sourceType, retrieval }: Json) => [url, sourceType, retrieval.sri])).toEqual([
      [`data:text/javascript;base64,${btoa(stop)}`, 'script', { result: 'match', expected: [integrity], actual: integrity }],
      ['data:text/plain,window.print=p', 'script', 'none'],
    ])
    expect(report.artifacts[1].retrieval.contentType).toBe('text/plain')
    expect(found(report).map(([fingerprint]: Json) => fingerprint)).toEqual([
      'window|Window.print|replace|inline',
      'window|Window.stop|replace|inline',
    ])
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 2, analyzed: 2 })
  })

  test("a worker's own classic data: script needs no JavaScript MIME type, but one importScripts loads does", async () => {
    // A browser runs a classic worker script from a URL that isn't HTTP(S) whatever its MIME type, but refuses a script
    // `importScripts` loads without a JavaScript one (HTML § Fetch a classic worker script, § Fetch a classic
    // worker-imported script). The shared worker reads the URL first, and the import still refuses it.
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': 'new SharedWorker("data:text/plain,self.fetch=f"); new Worker("/w.js")',
      'w.js': 'importScripts("data:text/plain,self.fetch=f", "data:text/javascript,self.close=c")',
    })

    expect(report.artifacts.map(({ url, origin, realm }: Json) => [url, origin, realm])).toEqual([
      ['data:text/javascript,self.close=c', 'inline', 'dedicated-worker'],
      ['data:text/plain,self.fetch=f', 'inline', 'shared-worker'],
      ['https://app.example/main.js', 'local-build', 'window'],
      ['https://app.example/w.js', 'local-build', 'dedicated-worker'],
    ])
    expect(found(report).map(([fingerprint]: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.close|replace|inline',
      'shared-worker|SharedWorkerGlobalScope.fetch|replace|inline',
    ])
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
  })

  test('imports, dynamic imports, modulepreloads and importScripts of data: URLs are inline code of the referencing realm', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script type="module">',
        'import "data:text/javascript,window.fetch=f"; import("data:text/javascript,window.alert=g")',
        '</script>',
        '<link rel="modulepreload" href="data:text/javascript,export const x = 1">',
        '<script src="main.js"></script>',
      ].join(''),
      'main.js': 'new Worker("/w.js")',
      'w.js': 'importScripts("data:text/javascript,self.fetch=f")',
    })

    const graph = report.artifacts.map(({ url, origin, sourceType, realm, parent }: Json) => [
      url,
      origin,
      sourceType,
      realm,
      parent,
    ])
    const page = 'https://app.example/'
    const inline = 'https://app.example/#inline-1'
    expect(graph).toEqual([
      ['data:text/javascript,export const x = 1', 'inline', 'module', 'window', page],
      ['data:text/javascript,self.fetch=f', 'inline', 'script', 'dedicated-worker', 'https://app.example/w.js'],
      ['data:text/javascript,window.alert=g', 'inline', 'module', 'window', inline],
      ['data:text/javascript,window.fetch=f', 'inline', 'module', 'window', inline],
      [inline, 'inline', 'module', 'window', page],
      ['https://app.example/main.js', 'local-build', 'script', 'window', page],
      ['https://app.example/w.js', 'local-build', 'script', 'dedicated-worker', 'https://app.example/main.js'],
    ])
    expect(found(report).map(([fingerprint]: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|inline',
      'window|Window.alert|replace|inline',
      'window|Window.fetch|replace|inline',
    ])
    expect(report.completeness.limitations).toEqual([])
  })
})

describe("files that don't run as referenced (§2)", () => {
  test('a file only a preload names that holds an ES module parses as a module, with its realm assumed', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<link rel="preload" as="script" href="chunk.js"><link rel="preload" as="script" href="legacy.js">',
        '<link rel="preload" as="script" href="data:text/javascript,import.meta; window.alert=g">',
      ].join(''),
      'chunk.js': 'export const a = 1; window.fetch = f',
      'legacy.js': 'var open; open = o',
    })

    const graph = report.artifacts.map(({ url, sourceType, realm, realmBasis, discovery }: Json) => [
      url,
      sourceType,
      realm,
      realmBasis,
      discovery,
    ])
    expect(graph).toEqual([
      ['data:text/javascript,import.meta; window.alert=g', 'module', 'window', 'assumed', 'reference'],
      ['https://app.example/chunk.js', 'module', 'window', 'assumed', 'reference'],
      ['https://app.example/legacy.js', 'script', 'window', 'assumed', 'reference'],
    ])
    expect(found(report).map(([fingerprint]: Json) => fingerprint)).toEqual([
      'window|Window.alert|replace|inline',
      'window|Window.fetch|replace|unknown',
      'window|Window.open|replace|unknown',
    ])
    for (const finding of report.findings) {
      const [occurrence] = finding.occurrences
      expect(occurrence.confidence.target).toEqual({ level: 'medium', reasons: ['realm-assumed'] })
      expect(occurrence.trace[0]).toMatchObject({ kind: 'confidence-reason', reason: 'realm-assumed' })
    }
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
  })

  test("the imports of a file only a preload names are followed as its syntax says: a module's, as modules", async () => {
    const { report } = await scanBuild({
      'index.html': '<link rel="preload" as="script" href="chunk.js">',
      'chunk.js': 'import "./dep.js"; export {}',
      'dep.js': 'var fetch; fetch = f',
    })

    expect(report.artifacts.map(({ url, sourceType, parent }: Json) => [url, sourceType, parent])).toEqual([
      ['https://app.example/chunk.js', 'module', 'https://app.example/'],
      ['https://app.example/dep.js', 'module', 'https://app.example/chunk.js'],
    ])
    // A module's top-level `var` declares no global, so it writes nothing native.
    expect(report.findings).toEqual([])
  })

  test('a remote file only a preload names is still fetched in resolve mode, and parsed by its syntax', async () => {
    const fetcher = fixtureFetcher({
      'https://cdn.example/chunk.js': {
        headers: { 'content-type': 'text/javascript' },
        body: 'export {}; window.fetch = f',
      },
    })

    const { report } = await scanBuild(
      { 'index.html': '<link rel="preload" as="script" href="https://cdn.example/chunk.js">' },
      ['--mode', 'resolve'],
      { deps: { resolveFetcher: () => fetcher } },
    )

    const [artifact] = report.artifacts
    expect(artifact).toMatchObject({ url: 'https://cdn.example/chunk.js', sourceType: 'module', realmBasis: 'assumed' })
    expect(artifact.retrieval.status).toBe('ok')
    expect(found(report).map(([fingerprint]: Json) => fingerprint)).toEqual([
      'window|Window.fetch|replace|url:https://cdn.example/chunk.js',
    ])
    expect(report.completeness.level).toBe('complete')
  })
})

describe("a file run as a classic script and as a module (§2 Files that don't run as referenced)", () => {
  test('is analyzed both ways, and its top-level var gives the classic script its finding', async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(
      {
        'index.html': '<script src="x.js"></script><script type="module" src="m.js"></script>',
        'm.js': 'import "./x.js"',
        'x.js': 'var fetch; fetch = w; window.alert = g',
      },
      [],
      { deps: { resolver } },
    )

    expect(report.artifacts.map(({ url, sourceType, parent }: Json) => [url, sourceType, parent])).toEqual([
      ['https://app.example/m.js', 'module', 'https://app.example/'],
      ['https://app.example/x.js', 'script', 'https://app.example/'],
      ['https://app.example/x.js', 'module', 'https://app.example/m.js'],
    ])
    expect(resolver.entries).toEqual([
      'window module https://app.example/m.js',
      'window script https://app.example/x.js',
      'window module https://app.example/x.js',
    ])
    // A write both analyses find is one occurrence.
    expect(found(report)).toEqual([
      ['window|Window.alert|replace|unknown', ['https://app.example/x.js']],
      ['window|Window.fetch|replace|unknown', ['https://app.example/x.js']],
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 3, analyzed: 3 })
  })

  test('each way is its own artifact to the crash guard', async () => {
    let now = 0
    let groups = 0
    const resolver: Resolver = {
      analyzerVersion: jsResolver.analyzerVersion,
      analyzeGroup(input) {
        if (++groups === 2) now = crashGuardMs
        return jsResolver.analyzeGroup(input)
      },
    }

    const { report } = await scanBuild(
      {
        'index.html': '<script src="x.js"></script><script type="module" src="m.js"></script>',
        'm.js': 'import "./x.js"',
        'x.js': 'window.alert = g',
      },
      [],
      { deps: { clock: () => now, resolver } },
    )

    // The guard fires after `m.js` and the classic `x.js`, before the module `x.js`.
    const counted = report.completeness.counters.artifacts
    expect(counted).toMatchObject({ known: 3, analyzed: 2, failed: { 'crash-guard': 1 } })
  })

  test('a preload does not make a file run a second way', async () => {
    const { report } = await scanBuild({
      'index.html': '<link rel="modulepreload" href="x.js"><script src="x.js"></script>',
      'x.js': 'window.alert = g',
    })

    expect(report.artifacts.map(({ url, sourceType }: Json) => [url, sourceType])).toEqual([
      ['https://app.example/x.js', 'script'],
    ])
  })
})

describe("hints that disagree (§2 Files that don't run as referenced)", () => {
  test('a file only a classic preload and a modulepreload name takes its source type from its syntax', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<link rel="preload" as="script" href="classic.js"><link rel="modulepreload" href="classic.js">',
        '<link rel="modulepreload" href="esm.js"><link rel="preload" as="script" href="esm.js">',
      ].join(''),
      'classic.js': 'var open; open = o',
      'esm.js': 'export {}; window.fetch = f',
    })

    expect(report.artifacts.map(({ url, sourceType, realmBasis }: Json) => [url, sourceType, realmBasis])).toEqual([
      ['https://app.example/classic.js', 'script', 'reference'],
      ['https://app.example/esm.js', 'module', 'reference'],
    ])
    expect(found(report).map(([fingerprint]: Json) => fingerprint)).toEqual([
      'window|Window.fetch|replace|unknown',
      'window|Window.open|replace|unknown',
    ])
    expect(report.completeness.limitations).toEqual([])
  })

  test('a modulepreload alone, or an import, still says a file is a module', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<link rel="modulepreload" href="pre.js"><link rel="modulepreload" href="entry.js">',
        '<link rel="preload" as="script" href="dep.js">',
      ].join(''),
      'pre.js': 'window.alert = g',
      'entry.js': 'import "./dep.js"',
      'dep.js': 'window.fetch = f',
    })

    expect(report.artifacts.map(({ url, sourceType, realmBasis }: Json) => [url, sourceType, realmBasis])).toEqual([
      ['https://app.example/dep.js', 'module', 'reference'],
      ['https://app.example/entry.js', 'module', 'reference'],
      ['https://app.example/pre.js', 'module', 'reference'],
    ])
  })
})

describe('determinism (§15)', () => {
  test('two scans of copies of a build with copies, data: scripts and files run both ways give byte-identical reports', async () => {
    const files = {
      'index.html': [
        '<script src="v1/sdk.js"></script><script src="v2/sdk.js"></script><script>window.alert = g</script>',
        '<script src="data:text/javascript,window.alert = g"></script><script src="x.js"></script>',
        '<script type="module">import "./x.js"</script><link rel="preload" as="script" href="chunk.js">',
      ].join(''),
      'v1/sdk.js': 'window.alert = g',
      'v2/sdk.js': 'window.alert = g',
      'x.js': 'var fetch; fetch = f',
      'chunk.js': 'export {}; window.open = o',
    }

    const first = await scanBuild(files)
    const second = await scanBuild(files)

    expect(first.report.artifacts).toHaveLength(8)
    expect(JSON.stringify({ ...first.report, run: null })).toBe(JSON.stringify({ ...second.report, run: null }))
  })
})

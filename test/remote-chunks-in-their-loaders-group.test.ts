// Remote chunks in their loader's group (§2 Discovery, §6 idiom 6, §17, §19). A chunk loader's chunk URLs
// that fold to constants are references, fetched in `resolve` mode and linked into the loader's group; any other remote
// chunk URL is an `unresolved-reference`. Every scenario goes through `monkeypatchlist scan --json`, in `--mode resolve` with
// the fixture fetcher swapped in, or offline.

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { fixtureFetcher, type RecordedResponse } from '../src/packages/source-store/fixture.ts'
import { corpusDir } from '../tools/paths.ts'
import { vendorFetcher } from '../tools/scoring/main.ts'
import { scanBuild } from './support/fixture-build.ts'
import { webpackChunk, webpackEntry, webpackEsmChunk, webpackEsmEntry } from './support/webpack.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const js = (body: string): RecordedResponse => ({ headers: { 'content-type': 'text/javascript' }, body })

const resolve = (responses: Record<string, RecordedResponse>) =>
  [['--mode', 'resolve'], { deps: { resolveFetcher: () => fixtureFetcher(responses) } }] as [string[], object]

const artifactAt = (report: Report, url: string) => {
  const found = report.artifacts.filter((each: Report) => each.url === url)
  expect(found).toHaveLength(1)
  return found[0]
}

const findings = (report: Report): string[] =>
  report.findings.map((finding: Report) => `${finding.target.realm}|${finding.target.name}|${finding.effect}`).sort()

const limitations = (report: Report, kind: string): Report[] =>
  report.completeness.limitations.filter((limitation: Report) => limitation.kind === kind)

const patch = 'window.fetch=function(){}'
const cdn = 'https://cdn.example/'
const chunkUrl = `${cdn}lazy.0123abcd.js`

describe('a remote chunk URL that folds is a reference, fetched and linked into its loader\'s group', () => {
  const build = {
    'index.html': '<script src="main.js"></script>',
    'main.js': webpackEntry({}, { 581: 'lazy' }, 'n.e(581).then(()=>n(6954));', { publicPath: `n.p="${cdn}",` }),
  }

  test('in `resolve` mode, the chunk is fetched, linked, and its code is `deferred`', async () => {
    const { report } = await scanBuild(build, ...resolve({ [chunkUrl]: js(webpackChunk(['581'], { 6954: patch })) }))

    expect(artifactAt(report, chunkUrl)).toMatchObject({
      discovery: 'reference',
      origin: 'cross-origin',
      parent: 'https://app.example/main.js',
      sourceType: 'script',
      retrieval: { status: 'ok' },
    })
    expect(findings(report)).toEqual(['window|Window.fetch|replace'])
    expect(report.findings[0].occurrences.map((each: Report) => [each.artifact.url, each.installContext])).toEqual([
      [chunkUrl, 'deferred'],
    ])
    // The loader's require links the chunk's module: no broken link, and the chunk is analyzed only in its group.
    expect(artifactAt(report, 'https://app.example/main.js').moduleLinking.unlinked).toBe(0)
    expect(artifactAt(report, chunkUrl).moduleLinking.linkGroups).toBe(1)
    expect(limitations(report, 'unresolved-reference')).toEqual([])
  })

  test('offline, the chunk is `offline-skipped`', async () => {
    const { report } = await scanBuild(build)

    expect(artifactAt(report, chunkUrl)).toMatchObject({ retrieval: { status: 'offline-skipped' } })
    expect(limitations(report, 'offline-skipped').map((record: Report) => record.artifact.url)).toEqual([chunkUrl])
    expect(limitations(report, 'unresolved-reference')).toEqual([])
    expect(findings(report)).toEqual([])
  })
})

describe('a remote chunk URL that does not fold is an `unresolved-reference`', () => {
  const loaderUrl = `${cdn}main.js`
  const page = { 'index.html': `<script src="${loaderUrl}"></script>` }
  const loader = (publicPath: string) =>
    js(webpackEntry({}, { 581: 'lazy' }, 'n.e(581).then(()=>n(6954));', { publicPath }))

  test('a public path a config may override gives the constant chunk, fetched and linked, and one `unresolved-reference`', async () => {
    const { report } = await scanBuild(
      page,
      ...resolve({
        [loaderUrl]: loader(`n.p="${cdn}",self.cfg&&(n.p=self.cfg.path),`),
        [chunkUrl]: js(webpackChunk(['581'], { 6954: patch })),
      }),
    )

    expect(artifactAt(report, chunkUrl)).toMatchObject({ discovery: 'reference', parent: loaderUrl, retrieval: { status: 'ok' } })
    expect(findings(report)).toEqual(['window|Window.fetch|replace'])
    expect(report.findings[0].occurrences[0].installContext).toBe('deferred')
    const unresolved = limitations(report, 'unresolved-reference')
    expect(unresolved.map((record: Report) => record.artifact.url)).toEqual([loaderUrl])
    expect(report.completeness.level).toBe('complete-with-limitations')
  })

  test('a public path that never folds gives one `unresolved-reference` and fetches nothing', async () => {
    const { report } = await scanBuild(page, ...resolve({ [loaderUrl]: loader('n.p=self.cfg.path,') }))

    expect(report.artifacts.map((each: Report) => each.url)).not.toContain(chunkUrl)
    expect(limitations(report, 'unresolved-reference').map((record: Report) => record.artifact.url)).toEqual([loaderUrl])
  })
})

describe("webpack's script-loading helper (`n.l(url, done, key, chunkId)`)", () => {
  test('a chunk URL passed to the helper folds through its parameter, and the chunk is fetched and linked', async () => {
    const { report } = await scanBuild(
      {
        'index.html': '<script src="main.js"></script>',
        'main.js': webpackEntry({}, { 581: 'lazy' }, 'n.e(581).then(()=>n(6954));', { publicPath: `n.p="${cdn}",`, load: 'helper' }),
      },
      ...resolve({ [chunkUrl]: js(webpackChunk(['581'], { 6954: patch })) }),
    )

    expect(artifactAt(report, chunkUrl)).toMatchObject({ discovery: 'reference', retrieval: { status: 'ok', sri: 'none' } })
    expect(findings(report)).toEqual(['window|Window.fetch|replace'])
    expect(report.findings[0].occurrences[0].installContext).toBe('deferred')
    expect(limitations(report, 'unresolved-reference')).toEqual([])
  })
})

describe('a folded `integrity` code sets on a chunk\'s script element is verified', () => {
  const chunk = webpackChunk(['581'], { 6954: patch })
  const sha512 = (text: string) => `sha512-${createHash('sha512').update(text).digest('base64')}`
  const scanWith = (integrity: string) =>
    scanBuild(
      {
        'index.html': '<script src="main.js"></script>',
        'main.js': webpackEntry({}, { 581: 'lazy' }, 'n.e(581).then(()=>n(6954));', {
          publicPath: `n.p="${cdn}",`,
          load: 'helper',
          integrity: { 581: integrity },
        }),
      },
      ...resolve({ [chunkUrl]: js(chunk) }),
    )

  test('a match is recorded, and the chunk is analyzed', async () => {
    const { report } = await scanWith(sha512(chunk))

    expect(artifactAt(report, chunkUrl).retrieval.sri).toEqual({ result: 'match', expected: [sha512(chunk)], actual: sha512(chunk) })
    expect(findings(report)).toEqual(['window|Window.fetch|replace'])
  })

  test('a mismatch gives `sri-mismatch`: the scan is incomplete, and the bytes are withheld with no findings', async () => {
    const { report } = await scanWith(sha512('other bytes'))

    const record = artifactAt(report, chunkUrl)
    expect(record.retrieval).toMatchObject({ status: 'sri-mismatch', sri: { result: 'mismatch', expected: [sha512('other bytes')] } })
    expect(record.hash).toBeNull()
    expect(limitations(report, 'sri-mismatch').map((each: Report) => each.artifact.url)).toEqual([chunkUrl])
    expect(report.completeness.level).toBe('incomplete')
    expect(findings(report)).toEqual([])
  })
})

describe('an ESM chunk loader is a chunk loader (§6 idiom 6)', () => {
  const loader = webpackEsmEntry({}, { recorder: 'abc123' }, 'n.e("recorder").then(()=>n(6954));')
  const chunk = webpackEsmChunk(['recorder'], { 6954: patch })

  test("a remote loader's `import()` chunk is a `module` reference, fetched and linked into its group as `deferred`", async () => {
    const loaderUrl = `${cdn}v7/rum.js`
    const esmChunkUrl = `${cdn}v7/chunks/recorder-abc123.js`
    const { report } = await scanBuild(
      { 'index.html': `<script src="${loaderUrl}"></script>` },
      ...resolve({ [loaderUrl]: js(loader), [esmChunkUrl]: js(chunk) }),
    )

    expect(artifactAt(report, esmChunkUrl)).toMatchObject({
      discovery: 'reference',
      parent: loaderUrl,
      sourceType: 'module',
      retrieval: { status: 'ok' },
    })
    expect(findings(report)).toEqual(['window|Window.fetch|replace'])
    expect(report.findings[0].occurrences.map((each: Report) => [each.artifact.url, each.installContext])).toEqual([
      [esmChunkUrl, 'deferred'],
    ])
    expect(artifactAt(report, loaderUrl).moduleLinking).toMatchObject({ unlinked: 0 })
    // The chunk's exported module table joins the loader's factory table, in the loader's group only.
    expect(artifactAt(report, esmChunkUrl).moduleLinking).toEqual({ idioms: ['factory-table'], modules: 1, unlinked: 0, linkGroups: 1 })
    expect(limitations(report, 'unresolved-reference')).toEqual([])
  })

  test('a local build of this form is linked, with no `unresolved-reference`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="rum.js"></script>',
      'rum.js': loader,
      'chunks/recorder-abc123.js': chunk,
    })

    expect(artifactAt(report, 'https://app.example/chunks/recorder-abc123.js')).toMatchObject({ discovery: 'reference', sourceType: 'module' })
    expect(report.findings[0].occurrences.map((each: Report) => each.installContext)).toEqual(['deferred'])
    expect(artifactAt(report, 'https://app.example/rum.js').moduleLinking).toMatchObject({ unlinked: 0 })
    expect(artifactAt(report, 'https://app.example/chunks/recorder-abc123.js').moduleLinking).toEqual({
      idioms: ['factory-table'],
      modules: 1,
      unlinked: 0,
      linkGroups: 1,
    })
    expect(limitations(report, 'unresolved-reference')).toEqual([])
  })
})

// The vendor CDN sites of the validation corpus, their remote scripts served from its pinned `vendor/` copies.
const corpus = `${corpusDir}/`
const scanCdnSite = (site: string) =>
  scanBuild(`${corpus}static-sites/${site}`, ['--map', 'https://app.corpus.test/=.', '--mode', 'resolve'], {
    deps: { resolveFetcher: () => vendorFetcher(`${corpus}vendor`) },
  })

// Only `sources.json` is committed: the copies are there once the corpus's `npm run vendor` has fetched them.
const vendored = (): boolean => {
  if (!existsSync(`${corpus}vendor/sources.json`)) return false
  const sources = JSON.parse(readFileSync(`${corpus}vendor/sources.json`, 'utf8')) as Record<string, { file: string }>
  return Object.values(sources).every(({ file }) => existsSync(`${corpus}vendor/${file}`))
}

describe.skipIf(!vendored())('the corpus CDN sites', () => {
  test("New Relic's four lazy chunks are fetched, SRI-checked against the loader's table and linked, their code `deferred`, with one `unresolved-reference` at the load site", async () => {
    const { report } = await scanCdnSite('newrelic-cdn')

    const loader = 'https://js-agent.newrelic.com/nr-loader-spa-1.322.0.min.js'
    const chunks = ['nr-spa', 'nr-spa-compressor', 'nr-spa-iframe-message-handler', 'nr-spa-recorder'].map(
      (name) => `https://js-agent.newrelic.com/${name}-1.322.0.min.js`,
    )
    for (const url of chunks) {
      const chunk = artifactAt(report, url)
      expect(chunk).toMatchObject({ discovery: 'reference', parent: loader, sourceType: 'script', retrieval: { status: 'ok' } })
      expect(chunk.retrieval.sri.result).toBe('match')
      expect(chunk.moduleLinking).toMatchObject({ idioms: expect.arrayContaining(['factory-table']), linkGroups: 1 })
    }
    expect(artifactAt(report, loader).moduleLinking.unlinked).toBe(0)
    const inChunks = report.findings.flatMap((finding: Report) =>
      finding.occurrences.filter((occurrence: Report) => chunks.includes(occurrence.artifact.url)),
    )
    expect(inChunks.length).toBeGreaterThan(0)
    expect(new Set(inChunks.map((occurrence: Report) => occurrence.installContext))).toEqual(new Set(['deferred']))
    // The public path a config branch from `NREUM.init` may overwrite: one record at the load site. The recorder's
    // compression worker adds two: its `createObjectURL` URL and its `data:` URL built with `encodeURI`.
    const recorder = chunks.at(-1)
    expect(limitations(report, 'unresolved-reference').map((record: Report) => [record.artifact.url, record.detail])).toEqual([
      [loader, "a chunk loader's chunk URL that doesn't fold to a constant"],
      [recorder, 'a worker URL that is not a constant'],
      [recorder, 'a worker URL that is not a constant'],
    ])
    expect(report.completeness.level).toBe('complete-with-limitations')
  }, 120_000)

  test("Datadog's recorder and profiler chunks are `module` references, fetched and linked into the loader's group", async () => {
    const { report } = await scanCdnSite('datadog-cdn')

    const loader = 'https://www.datadoghq-browser-agent.com/us1/v7/datadog-rum.js'
    for (const name of ['datadogProfiler-155594a8950db9a4b941', 'datadogRecorder-95b3116c17acc4609842']) {
      expect(artifactAt(report, `https://www.datadoghq-browser-agent.com/us1/v7/chunks/${name}-datadog-rum.js`)).toMatchObject({
        discovery: 'reference',
        parent: loader,
        sourceType: 'module',
        retrieval: { status: 'ok', sri: 'none' },
        moduleLinking: { idioms: ['factory-table'], modules: 1, unlinked: 0, linkGroups: 1 },
      })
    }
    expect(artifactAt(report, loader).moduleLinking.unlinked).toBe(0)
    // Only the loader's `new Worker(t.workerUrl || URL.createObjectURL(blob))`: one record per alternative.
    expect(limitations(report, 'unresolved-reference').map((record: Report) => [record.artifact.url, record.detail])).toEqual([
      [loader, 'a worker URL that is not a constant'],
      [loader, 'a worker URL that is not a constant'],
    ])
  }, 120_000)
})

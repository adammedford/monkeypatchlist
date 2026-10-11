// Discovery rounds and the fixpoint (§2 Discovery, Sweep; §19 References only the resolver can see, The result doesn't
// depend on the rounds). The resolver returns the references only constant propagation can see, and the scan runs in
// rounds until a round adds no artifact. Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import type { ResolvedReference } from '../src/packages/discovery/index.ts'
import { fixtureFetcher, type RecordedResponse } from '../src/packages/source-store/fixture.ts'
import { scanBuild } from './support/fixture-build.ts'
import { webpackChunk, webpackEntry } from './support/webpack.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const artifact = (report: Report, url: string): Report[] =>
  report.artifacts
    .filter((each: Report) => each.url === `https://app.example/${url}`)
    .map(({ discovery, realm, realmBasis, parent, sourceType }: Report) => ({ discovery, realm, realmBasis, parent, sourceType }))

const findings = (report: Report): string[] =>
  report.findings.map((finding: Report) => `${finding.target.realm}|${finding.target.name}|${finding.effect}`).sort()

const limitations = (report: Report, kind: string): Report[] =>
  report.completeness.limitations.filter((limitation: Report) => limitation.kind === kind)

const patch = 'window.fetch=function(){}'

describe('chunk references a loader folds', () => {
  test('a chunk only a constant-folded loader URL references is found through a round', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': webpackEntry({}, { 581: 'lazy' }, 'n.e(581).then(()=>n(6954));'),
      'lazy.0123abcd.js': webpackChunk(['581'], { 6954: patch }),
    })

    expect(artifact(report, 'lazy.0123abcd.js')).toEqual([
      {
        discovery: 'reference',
        realm: 'window',
        realmBasis: 'reference',
        parent: 'https://app.example/main.js',
        sourceType: 'script',
      },
    ])
    expect(findings(report)).toEqual(['window|Window.fetch|replace'])
    expect(report.findings[0].occurrences).toHaveLength(1)
    expect(report.findings[0].occurrences[0].installContext).toBe('deferred')
    expect(limitations(report, 'unresolved-reference')).toEqual([])
  })
})

describe("a chunk a group links takes the group's realm", () => {
  test("a worker's chunk that its folded `importScripts` URL references is a worker artifact, never a window sweep", async () => {
    const { report } = await scanBuild({
      'index.html': '<script>new Worker("/w.js")</script>',
      'w.js': webpackEntry({}, { 581: 'lazy' }, 'n.e(581).then(()=>n(6954));', { load: 'import-scripts' }),
      'lazy.0123abcd.js': webpackChunk(['581'], { 6954: 'self.fetch=function(){}' }),
    })

    expect(artifact(report, 'lazy.0123abcd.js')).toEqual([
      {
        discovery: 'reference',
        realm: 'dedicated-worker',
        realmBasis: 'reference',
        parent: 'https://app.example/w.js',
        sourceType: 'script',
      },
    ])
    expect(findings(report)).toEqual(['dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace'])
    expect(report.findings[0].occurrences).toHaveLength(1)
    expect(report.findings[0].occurrences[0].installContext).toBe('deferred')
  })
})

// A build where legacy.js is reached by no reference.
const legacy = {
  'index.html': '<script src="main.js"></script>',
  'main.js': 'console.log(1)',
  'assets/legacy.js': 'navigator.serviceWorker.register("/sw.js");import("https://cdn.example.com/rum.js")',
  'sw.js': 'self.addEventListener("fetch",e=>{});self.fetch=function(){}',
}
const rum = 'window.fetch=function(){}'

describe("a sweep-only file's own literal requests are followed", () => {
  test('its service worker is an ordinary worker reference, dropped as a standalone window sweep', async () => {
    const { report } = await scanBuild(legacy)

    expect(artifact(report, 'sw.js')).toEqual([
      {
        discovery: 'reference',
        realm: 'service-worker',
        realmBasis: 'reference',
        parent: 'https://app.example/assets/legacy.js',
        sourceType: 'script',
      },
    ])
    expect(findings(report)).toEqual(['service-worker|ServiceWorkerGlobalScope.fetch|replace'])
    expect(limitations(report, 'realm-uncertain')).toEqual([])
  })

  test('offline, its remote import gives an `offline-skipped` record', async () => {
    const { report } = await scanBuild(legacy)

    expect(limitations(report, 'offline-skipped').map((record: Report) => record.artifact.url)).toEqual([
      'https://cdn.example.com/rum.js',
    ])
  })

  test('in `resolve` mode, its remote import is fetched, inherits its assumed basis, and can add findings', async () => {
    const responses: Record<string, RecordedResponse> = {
      'https://cdn.example.com/rum.js': { headers: { 'content-type': 'text/javascript' }, body: rum },
    }
    const { report } = await scanBuild(legacy, ['--mode', 'resolve'], {
      deps: { resolveFetcher: () => fixtureFetcher(responses) },
    })

    const remote = report.artifacts.find((each: Report) => each.url === 'https://cdn.example.com/rum.js')
    expect(remote).toMatchObject({
      discovery: 'reference',
      realm: 'window',
      realmBasis: 'assumed',
      sourceType: 'module',
      parent: 'https://app.example/assets/legacy.js',
    })
    expect(findings(report)).toEqual(['service-worker|ServiceWorkerGlobalScope.fetch|replace', 'window|Window.fetch|replace'])
    const [occurrence] = report.findings.find((finding: Report) => finding.target.realm === 'window').occurrences
    expect(occurrence.artifact.url).toBe('https://cdn.example.com/rum.js')
    expect(occurrence.confidence.target.reasons).toContain('realm-assumed')
  })
})

describe('a folded chunk URL is a reference', () => {
  test('one that names a file the build lacks is a missing chunk, never `unreadable`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': webpackEntry({}, { 581: 'lazy' }, 'n.e(581).then(()=>n(6954));'),
    })

    expect(limitations(report, 'unreadable')).toEqual([])
    expect(report.completeness.level).toBe('complete')
  })
})

// An ESM chunk loader (§6 idiom 6): it loads its chunks with `import()`.
const unfolded = 'n.p=document.currentScript.src.replace(/[^/]+$/,""),'
const esmLoader = (publicPath = unfolded) =>
  webpackEntry({}, { 581: 'lazy' }, 'n.e(581);', { load: 'import', publicPath })

describe('local chunk URLs (§2)', () => {
  test('a local chunk URL a loader builds at runtime raises no `unresolved-reference`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': esmLoader(),
      'lazy.0123abcd.js': 'export const __webpack_esm_ids__ = [581]',
    })

    expect(limitations(report, 'unresolved-reference')).toEqual([])
    expect(report.completeness.level).toBe('complete')
  })

  test('nor does one whose folded URL is local', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': esmLoader('n.p="/",'),
      'lazy.0123abcd.js': 'export const __webpack_esm_ids__ = [581]',
    })

    expect(limitations(report, 'unresolved-reference')).toEqual([])
  })

  test("a folded prefix outside every mapping makes a local loader's chunk URL remote", async () => {
    const loader = 'const h={581:"lazy.0123abcd.js"};self.load=t=>import("https://cdn.example.com/assets/"+h[t]);'
    const { report } = await scanBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': loader })

    expect(limitations(report, 'unresolved-reference')).toEqual([
      expect.objectContaining({ artifact: expect.objectContaining({ url: 'https://app.example/main.js' }) }),
    ])
    expect(report.completeness.level).toBe('complete-with-limitations')
  })

  test('a public path that folds outside every mapping gives a remote chunk reference, offline `offline-skipped`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': esmLoader('n.p="https://cdn.example.com/assets/",'),
    })

    expect(limitations(report, 'unresolved-reference')).toEqual([])
    expect(limitations(report, 'offline-skipped').map((record: Report) => record.artifact.url)).toEqual([
      'https://cdn.example.com/assets/lazy.0123abcd.js',
    ])
  })

  test('an inline loader counts as local', async () => {
    const { report } = await scanBuild({
      'index.html': `<script>${esmLoader()}</script>`,
      'lazy.0123abcd.js': 'export const __webpack_esm_ids__ = [581]',
    })

    expect(limitations(report, 'unresolved-reference')).toEqual([])
  })

  test("a CDN-fetched loader's chunk URL raises `unresolved-reference`", async () => {
    const responses: Record<string, RecordedResponse> = {
      'https://cdn.example.com/loader.js': { headers: { 'content-type': 'text/javascript' }, body: esmLoader() },
    }
    const { report } = await scanBuild(
      { 'index.html': '<script src="https://cdn.example.com/loader.js"></script>' },
      ['--mode', 'resolve'],
      { deps: { resolveFetcher: () => fixtureFetcher(responses) } },
    )

    expect(limitations(report, 'unresolved-reference')).toEqual([
      expect.objectContaining({ artifact: expect.objectContaining({ url: 'https://cdn.example.com/loader.js' }) }),
    ])
  })
})

// A worker that only a sweep-only file starts: its realm comes from a reference found after the sweep.
const lateWorker = (publicPath: string) => ({
  'index.html': '<script src="main.js"></script>',
  'main.js': 'console.log(1)',
  'legacy.js': 'new Worker("/w.js")',
  'w.js': webpackEntry({}, { 581: 'lazy' }, 'n.e(581).then(()=>n(6954));', { load: 'import-scripts', publicPath }),
  'lazy.0123abcd.js': webpackChunk(['581'], { 6954: 'self.fetch=function(){}' }),
})

describe('links found in a later round', () => {
  test("a swept chunk a late worker's registry and id table map is linked: no standalone sweep", async () => {
    const { report } = await scanBuild(lateWorker(unfolded.replace('document.currentScript.src', 'self.location.href')))

    expect(artifact(report, 'w.js')).toEqual([
      { discovery: 'reference', realm: 'dedicated-worker', realmBasis: 'reference', parent: 'https://app.example/legacy.js', sourceType: 'script' },
    ])
    expect(artifact(report, 'lazy.0123abcd.js')).toEqual([
      { discovery: 'sweep', realm: 'window', realmBasis: 'assumed', parent: null, sourceType: 'script' },
    ])
    expect(findings(report)).toEqual(['dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace'])
    expect(report.findings[0].occurrences).toHaveLength(1)
    expect(report.findings[0].occurrences[0].installContext).toBe('deferred')
  })

  test("a swept chunk a late worker's folded URL references becomes the worker's artifact", async () => {
    const { report } = await scanBuild(lateWorker('n.p="/",'))

    expect(artifact(report, 'lazy.0123abcd.js')).toEqual([
      { discovery: 'reference', realm: 'dedicated-worker', realmBasis: 'reference', parent: 'https://app.example/w.js', sourceType: 'script' },
    ])
    expect(findings(report)).toEqual(['dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace'])
    expect(report.findings[0].occurrences).toHaveLength(1)
    expect(limitations(report, 'realm-uncertain')).toEqual([])
  })
})

describe("a swept loader's references resume the rounds (§19)", () => {
  // No document names assets/main.js: only the sweep finds it.
  const sweptLoader = webpackEntry({}, { 581: 'lazy' }, 'n.e(581).then(()=>n(6954));')

  test('the chunk its folded URL references becomes its artifact, with its assumed basis', async () => {
    const { report } = await scanBuild({
      'index.html': '<p>',
      'assets/main.js': sweptLoader,
      'lazy.0123abcd.js': webpackChunk(['581'], { 6954: patch }),
    })

    expect(artifact(report, 'lazy.0123abcd.js')).toEqual([
      { discovery: 'reference', realm: 'window', realmBasis: 'assumed', parent: 'https://app.example/assets/main.js', sourceType: 'script' },
    ])
    expect(findings(report)).toEqual(['window|Window.fetch|replace'])
    expect(report.findings[0].occurrences).toHaveLength(1)
    expect(report.findings[0].occurrences[0].installContext).toBe('deferred')
  })

  test('one that names a file the build lacks is a missing chunk, as a referenced loader\'s is', async () => {
    const { report } = await scanBuild({ 'index.html': '<p>', 'assets/main.js': sweptLoader })

    expect(limitations(report, 'unreadable')).toEqual([])
    expect(report.completeness.level).toBe('complete')
  })
})

/** The shipped resolver, recording every reference its groups find, as the scan's rounds take them. */
function recording(): { resolver: Resolver; references: ResolvedReference[] } {
  const references: ResolvedReference[] = []
  const resolver: Resolver = {
    analyzerVersion: jsResolver.analyzerVersion,
    analyzeGroup(input) {
      const output = jsResolver.analyzeGroup(input)
      for (const { kind, url, artifact: from, location, load, partial } of output.references) {
        if (kind !== 'chunk' || load === undefined) continue
        references.push({ realm: input.entry.realm, from: { url: from }, kind, url, load, ...(partial && { partial }), location })
      }
      return output
    },
  }
  return { resolver, references }
}

/** A report without its `run` block, which is all a scan may change from run to run (§15 Determinism). */
const withoutRun = (report: Report) => ({ ...report, run: null })

describe("the result doesn't depend on the rounds", () => {
  // Rounds: main.js's group references its chunk (round 2), and the sweep-only legacy.js starts a worker whose folded
  // `importScripts` URL references another (round 2), which its group links (round 3).
  const build = {
    ...lateWorker('n.p="/",'),
    'index.html': '<script src="main.js"></script>',
    'main.js': webpackEntry({}, { 7: 'page' }, 'n.e(7).then(()=>n(70));', { registry: 'webpackChunkpage' }),
    'page.0123abcd.js': webpackChunk(['7'], { 70: 'history.pushState=function(){}' }, 'webpackChunkpage'),
  }

  test('seeding every reference up front gives the same report as running rounds', async () => {
    const rounds = recording()
    const { report } = await scanBuild(build, [], { deps: { resolver: rounds.resolver } })
    const urls = rounds.references.filter((reference) => reference.partial === undefined).map(({ url }) => url)
    expect([...new Set(urls)].sort()).toEqual([
      '/lazy.0123abcd.js',
      '/page.0123abcd.js',
    ])

    const seeded = await scanBuild(build, [], { deps: { seed: rounds.references } })

    expect(withoutRun(seeded.report)).toEqual(withoutRun(report))
    expect(findings(report)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace',
      'window|history.pushState|replace',
    ])
  })
})

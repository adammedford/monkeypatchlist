// Chunk loaders and chunk registries across artifacts (§6 Module links, Link groups, Degradation; ADR 0010): module-
// linking idiom 6. A chunk loader maps constant chunk ids to URLs, and its chunks push into a global array, the chunk
// registry, that a factory table reads. A chunk joins the loader's link group when the loader reads the same constant
// registry name and its id table maps an id the chunk pushes. Every scenario goes through `monkeypatchlist scan --json`.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { corpusDir } from '../tools/paths.ts'
import { scanBuild } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

// The shipped resolver, with eslint-scope behind the binding-resolution seam, and the verified drop-in (§19).
const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** Each finding as `realm|name|effect`, sorted. */
const findings = (report: Report): string[] =>
  report.findings.map((finding: Report) => `${finding.target.realm}|${finding.target.name}|${finding.effect}`).sort()

/** A finding's occurrences, each as the URL of its artifact, its install context and its reachability. */
const occurrences = (report: Report, name: string): Report[] =>
  report.findings
    .find((finding: Report) => finding.target.name === name)
    .occurrences.map((occurrence: Report) => ({
      artifact: occurrence.artifact.url,
      installContext: occurrence.installContext,
      reachability: occurrence.reachability,
    }))

const limitations = (report: Report, kind: string): Report[] =>
  report.completeness.limitations.filter((limitation: Report) => limitation.kind === kind)

const registry = 'webpackChunkapp'


/**
 * A webpack 5 entry bundle, minified as webpack emits it: its factory table, the require function and its runtime
 * (`n.d`, `n.o`, the chunk loader `n.e` with its URL function `n.u` over the id table `chunks`, and the JSONP chunk
 * registry `self[name]`, whose `push` the runtime overrides), then the entry code.
 */
function webpackEntry(modules: Record<string, string>, chunks: Record<string, string>, entry: string, name = registry): string {
  const table = Object.entries(modules).map(([id, body]) => `${id}(t,e,n){${body}}`).join(',')
  const names = Object.entries(chunks).map(([id, file]) => `${id}:"${file}"`).join(',')
  const hashes = Object.keys(chunks).map((id) => `${id}:"0123abcd"`).join(',')
  return (
    `(()=>{"use strict";var t={${table}},r={};` +
    'function n(e){var o=r[e];if(void 0!==o)return o.exports;var i=r[e]={exports:{}};return t[e](i,i.exports,n),i.exports}' +
    'n.m=t,n.d=(t,e)=>{for(var r in e)n.o(e,r)&&!n.o(t,r)&&Object.defineProperty(t,r,{enumerable:!0,get:e[r]})},' +
    'n.o=(t,e)=>Object.prototype.hasOwnProperty.call(t,e),n.f={},' +
    'n.e=e=>Promise.all(Object.keys(n.f).reduce((t,r)=>(n.f[r](e,t),t),[])),' +
    `n.u=e=>({${names}}[e]+"."+{${hashes}}[e]+".js"),n.p="/",` +
    '(()=>{var e={792:0};n.f.j=(t,r)=>{var o=n.o(e,t)?e[t]:void 0;if(0!==o)if(o)r.push(o[2]);else{var i=new Promise((r,i)=>o=e[t]=[r,i]);' +
    'r.push(o[2]=i);var s=n.p+n.u(t),a=document.createElement("script");a.src=s,document.head.appendChild(a)}};' +
    'const o=(t,r)=>{let[i,s,a]=r;var c,d,u=0;if(i.some(t=>0!==e[t])){for(c in s)n.o(s,c)&&(n.m[c]=s[c]);a&&a(n)}' +
    'for(t&&t(r);u<i.length;u++)d=i[u],n.o(e,d)&&e[d]&&e[d][0](),e[d]=0},' +
    `l=self.${name}=self.${name}||[];l.forEach(o.bind(null,0)),l.push=o.bind(null,l.push.bind(l))})();` +
    `${entry}})();`
  )
}

/** A webpack 5 JSONP chunk: it pushes its chunk ids and factories into the registry `self[name]`. */
function webpackChunk(ids: string[], modules: Record<string, string>, name = registry): string {
  const table = Object.entries(modules).map(([id, body]) => `${id}(t,e,n){${body}}`).join(',')
  return `"use strict";(self.${name}=self.${name}||[]).push([[${ids.join(',')}],{${table}}]);`
}

// The shape of Datadog's recorder: the entry exports its patch helper (`H7`) from module 100, and lazy chunk 581's
// module 6954 wraps a CSS rule method through it when the entry starts recording.
const helper = 'n.d(e,{H7:()=>a});function a(o,k,f){const s=o[k];o[k]=function(){return f(s,arguments)}}'
const recorder = 'n.d(e,{start:()=>s});var h=n(100);function s(){(0,h.H7)(CSSStyleSheet.prototype,"insertRule",(f,a)=>f.apply(this,a))}'

describe.each(resolvers)('chunk loaders and chunk registries, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = async (files: Record<string, string>, args: string[] = []) =>
    (await scanBuild(files, args, { deps: { resolver } })).report

  test("a lazy chunk's mutation through the entry's helper is found in the loader's group, `deferred`", async () => {
    const report = await scan({
      'index.html': '<script src="main.js"></script>',
      'main.js': webpackEntry({ 100: helper }, { 581: 'recorder' }, 'n.e(581).then(()=>n(6954)).then(m=>m.start());'),
      'recorder.0123abcd.js': webpackChunk(['581'], { 6954: recorder }),
    })

    expect(findings(report)).toEqual(['window|CSSStyleSheet.prototype.insertRule|wrap'])
    expect(occurrences(report, 'CSSStyleSheet.prototype.insertRule')).toEqual([
      { artifact: 'https://app.example/main.js', installContext: 'deferred', reachability: 'unconditional' },
    ])
  })

  test("a recognized chunk registry is a known non-native array: overriding its `push` gives nothing", async () => {
    const report = await scan({
      'index.html': '<script src="main.js"></script>',
      'main.js': webpackEntry({ 100: helper }, { 581: 'recorder' }, 'n.e(581).then(()=>n(6954)).then(m=>m.start());'),
      'recorder.0123abcd.js': webpackChunk(['581'], { 6954: recorder }),
    })

    expect(findings(report)).toEqual(['window|CSSStyleSheet.prototype.insertRule|wrap'])
    expect(limitations(report, 'unresolved-holder')).toEqual([])
    expect(report.completeness.counters.blindSpots.unresolvedHolder).toBe(0)
  })

  // The entry starts the recorder through a bound require, and passes it the global object.
  const startRecording = 'n.e(581).then(n.bind(n,6954)).then(m=>m.startRecording(window));'
  const recording = 'n.d(e,{startRecording:()=>s});var h=n(100);function s(w){w.fetch=function(){}}'

  // That entry, once with a folded public path (`n.p="/"`: the chunk's URL names a file the build lacks) and once
  // with webpack's `auto` public path, which comes from `document.currentScript` so the URL doesn't fold.
  const publicPaths = [
    ['a constant', (code: string) => code],
    ['an `auto`', (code: string) => code.replace('n.p="/"', 'n.p=document.currentScript.src.replace(/[^/]+$/,"")')],
  ] as const

  describe.each(publicPaths)('with %s public path', (_name, publicPath) => {
    test('a missing chunk that the global object flows into raises `unlinked-module-call`', async () => {
      const report = await scan({
        'index.html': '<script src="main.js"></script>',
        'main.js': publicPath(webpackEntry({ 100: helper }, { 581: 'datadogRecorder' }, startRecording)),
      })

      expect(findings(report)).toEqual([])
      expect(limitations(report, 'unreadable')).toEqual([])
      expect(limitations(report, 'unlinked-module-call')).toEqual([
        expect.objectContaining({ artifact: expect.objectContaining({ url: 'https://app.example/main.js' }) }),
      ])
      expect(report.completeness.level).toBe('complete-with-limitations')
    })

    test('a missing chunk no global object flows into is only counted', async () => {
      const report = await scan({
        'index.html': '<script src="main.js"></script>',
        'main.js': publicPath(webpackEntry({ 100: helper }, { 581: 'datadogRecorder' }, 'n.e(581).then(n.bind(n,6954)).then(m=>m.startRecording(1));')),
      })

      expect(limitations(report, 'unreadable')).toEqual([])
      expect(limitations(report, 'unlinked-module-call')).toEqual([])
      expect(report.completeness.level).toBe('complete')
      expect(report.artifacts.map((artifact: Report) => [artifact.url, artifact.moduleLinking.unlinked])).toEqual([
        ['https://app.example/main.js', 1],
      ])
    })
  })

  test('a file an HTML element names keeps `unreadable`, even when a loader folds the same URL', async () => {
    const report = await scan({
      'index.html': '<script src="main.js"></script><script src="/datadogRecorder.0123abcd.js"></script>',
      'main.js': webpackEntry({ 100: helper }, { 581: 'datadogRecorder' }, startRecording),
    })

    expect(limitations(report, 'unreadable')).toEqual([
      expect.objectContaining({ artifact: expect.objectContaining({ path: 'datadogRecorder.0123abcd.js' }) }),
    ])
  })

  test('a loader promise of a variable holding a broken module still raises `unlinked-module-call`', async () => {
    // `()=>r` reads a variable whose value is a missing module: followed through its definition, as the scale
    // fixture's webpack runtime needs, without failing the scan.
    const report = await scan({
      'index.html': '<script src="main.js"></script>',
      'main.js': webpackEntry({ 100: helper }, { 581: 'datadogRecorder' }, 'const r=n(6954);n.e(581).then(()=>r).then(m=>m.startRecording(window));'),
    })

    expect(limitations(report, 'unlinked-module-call')).toEqual([
      expect.objectContaining({ artifact: expect.objectContaining({ url: 'https://app.example/main.js' }) }),
    ])
  })

  test('with the chunk present, the same call links: nothing is raised, and each artifact reports its links', async () => {
    const report = await scan({
      'index.html': '<script src="main.js"></script>',
      'main.js': webpackEntry({ 100: helper }, { 581: 'datadogRecorder' }, startRecording),
      'datadogRecorder.0123abcd.js': webpackChunk(['581'], { 6954: recording }),
    })

    expect(limitations(report, 'unlinked-module-call')).toEqual([])
    expect(report.artifacts.map((artifact: Report) => [artifact.url, artifact.moduleLinking])).toEqual([
      [
        'https://app.example/datadogRecorder.0123abcd.js',
        { idioms: ['factory-table'], modules: 1, unlinked: 0, linkGroups: 1 },
      ],
      ['https://app.example/main.js', { idioms: ['chunk-loader', 'factory-table', 'getter-export'], modules: 1, unlinked: 0, linkGroups: 1 }],
    ])
  })

  const patch = 'window.fetch=function(){}'
  const page = '<script src="main.js"></script>'
  const loads581 = webpackEntry({ 100: helper }, { 581: 'lazy' }, 'n.e(581).then(()=>n(6954));')

  test('a linked chunk is analyzed only in its group: its code gives no standalone sweep occurrence', async () => {
    const report = await scan({
      'index.html': page,
      'main.js': loads581,
      'lazy.0123abcd.js': webpackChunk(['581'], { 6954: patch }),
    })

    expect(findings(report)).toEqual(['window|Window.fetch|replace'])
    expect(occurrences(report, 'Window.fetch')).toEqual([
      { artifact: 'https://app.example/lazy.0123abcd.js', installContext: 'deferred', reachability: 'unconditional' },
    ])
    // The group's realm is the entry's, which a reference gives: nothing is assumed.
    const [occurrence] = report.findings[0].occurrences
    expect(occurrence.confidence.target.reasons).not.toContain('realm-assumed')
  })

  test('code only a chunk load reaches is `deferred`, even when its module is required at top level', async () => {
    const report = await scan({
      'index.html': page,
      'main.js': webpackEntry({ 100: helper }, { 581: 'lazy' }, 'n.e(581);n(6954);'),
      'lazy.0123abcd.js': webpackChunk(['581'], { 6954: patch }),
    })

    expect(occurrences(report, 'Window.fetch')).toEqual([
      { artifact: 'https://app.example/lazy.0123abcd.js', installContext: 'deferred', reachability: 'unconditional' },
    ])
  })

  test('a chunk whose id no id table maps, or that pushes into another registry, stays a standalone sweep', async () => {
    const report = await scan({
      'index.html': page,
      'main.js': loads581,
      'other.js': webpackChunk(['582'], { 7000: patch }),
      'elsewhere.js': webpackChunk(['581'], { 6954: 'history.pushState=function(){}' }, 'webpackChunkother'),
    })

    expect(findings(report)).toEqual(['window|Window.fetch|replace', 'window|history.pushState|replace'])
    for (const name of ['Window.fetch', 'history.pushState']) {
      const [occurrence] = report.findings.find((finding: Report) => finding.target.name === name).occurrences
      expect(occurrence.reachabilityBasis).toBe('creation-site')
      expect(occurrence.confidence.target.reasons).toContain('realm-assumed')
    }
    expect(report.artifacts.find((artifact: Report) => artifact.url.endsWith('/main.js')).moduleLinking.unlinked).toBe(1)
  })

  test("other functions that concatenate their parameter don't widen the loader's id table", async () => {
    // An escape helper and a CSS chunk URL function each concatenate their parameter, but only `n.u` builds a script
    // URL: chunk 582 stays unmapped.
    const others = 'const q=e=>"\\\\"+e;n.miniCssF=e=>"css/"+e+".css";n.e(581).then(()=>n(6954));'
    const report = await scan({
      'index.html': page,
      'main.js': webpackEntry({ 100: helper }, { 581: 'lazy' }, others),
      'other.js': webpackChunk(['582'], { 7000: patch }),
    })

    const [occurrence] = report.findings.find((finding: Report) => finding.target.name === 'Window.fetch').occurrences
    expect(occurrence.reachabilityBasis).toBe('creation-site')
    expect(occurrence.confidence.target.reasons).toContain('realm-assumed')
  })

  test("a URL function whose table falls back to the id itself maps every id", async () => {
    const entry = webpackEntry({ 100: helper }, { 581: 'lazy' }, 'n.e(582).then(()=>n(7000));').replace(
      'n.u=e=>({581:"lazy"}[e]+',
      'n.u=e=>(({581:"lazy"}[e]||e)+',
    )
    const report = await scan({
      'index.html': page,
      'main.js': entry.replace('{581:"0123abcd"}[e]+".js"', '"0123abcd.js"'),
      '582.0123abcd.js': webpackChunk(['582'], { 7000: patch }),
    })

    expect(occurrences(report, 'Window.fetch')).toEqual([
      { artifact: 'https://app.example/582.0123abcd.js', installContext: 'deferred', reachability: 'unconditional' },
    ])
  })

  test('a stale copy pushing the same id joins too, as an alternative', async () => {
    const report = await scan({
      'index.html': page,
      'main.js': loads581,
      'lazy.0123abcd.js': webpackChunk(['581'], { 6954: patch }),
      'lazy.0ld.js': webpackChunk(['581'], { 6954: 'history.pushState=function(){}' }),
    })

    expect(findings(report)).toEqual(['window|Window.fetch|replace', 'window|history.pushState|replace'])
    expect(occurrences(report, 'history.pushState')).toEqual([
      { artifact: 'https://app.example/lazy.0ld.js', installContext: 'deferred', reachability: 'unconditional' },
    ])
  })

  test('chunk and module ids stay out of fingerprints', async () => {
    const fingerprints = async (chunk: string, module: string) => {
      const report = await scan({
        'index.html': page,
        'main.js': webpackEntry({ 100: helper }, { [chunk]: 'lazy' }, `n.e(${chunk}).then(()=>n(${module}));`),
        'lazy.0123abcd.js': webpackChunk([chunk], { [module]: patch }),
      })
      return report.findings.map((finding: Report) => [finding.fingerprint, finding.targetKey])
    }

    const first = await fingerprints('581', '6954')
    expect(first).toEqual([['window|Window.fetch|replace|unknown', 'window|Window.fetch|replace']])
    expect(await fingerprints('17', '42')).toEqual(first)
  })

  test("a chunk joins only the groups whose id table maps its id, and takes that group's realm", async () => {
    const report = await scan({
      'index.html': page,
      'main.js': webpackEntry({ 100: helper }, { 123: 'page' }, 'new Worker("worker.js");n.e(123).then(()=>n(1230));'),
      'worker.js': webpackEntry({ 100: helper }, { 200: 'background' }, 'n.e(200).then(()=>n(2000));'),
      'page.0123abcd.js': webpackChunk(['123'], { 1230: 'self.fetch=function(){}' }),
      'background.0123abcd.js': webpackChunk(['200'], { 2000: 'self.fetch=function(){}' }),
    })

    expect(findings(report)).toEqual(['dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace', 'window|Window.fetch|replace'])
    expect(occurrences(report, 'Window.fetch')).toEqual([
      { artifact: 'https://app.example/page.0123abcd.js', installContext: 'deferred', reachability: 'unconditional' },
    ])
    expect(occurrences(report, 'DedicatedWorkerGlobalScope.fetch')).toEqual([
      { artifact: 'https://app.example/background.0123abcd.js', installContext: 'deferred', reachability: 'unconditional' },
    ])
  })

  test("HTML-referenced scripts a chunk registry links form one group, entered at the first that links the others", async () => {
    // An Angular-style page: runtime.js reads the registry, and polyfills.js and main.js push their factories into it
    // with a callback that the runtime calls with its require, which starts their entry modules.
    const report = await scan({
      'index.html': '<script src="runtime.js"></script><script src="polyfills.js"></script><script src="main.js"></script>',
      'runtime.js': webpackEntry({ 1: 'n.d(e,{x:()=>1})' }, {}, ''),
      'polyfills.js': `(self.${registry}=self.${registry}||[]).push([[429],{5321(t,e,n){window.Promise=function ZoneAwarePromise(){}}},t=>t(t.s=5321)]);`,
      'main.js': `(self.${registry}=self.${registry}||[]).push([[792],{4429(t,e,n){n(5321);history.pushState=function(){}}},t=>t(t.s=4429)]);`,
    })

    expect(findings(report)).toEqual(['window|Window.Promise|replace', 'window|history.pushState|replace'])
    expect(occurrences(report, 'Window.Promise')).toEqual([
      { artifact: 'https://app.example/polyfills.js', installContext: 'load', reachability: 'unconditional' },
    ])
    expect(occurrences(report, 'history.pushState')).toEqual([
      { artifact: 'https://app.example/main.js', installContext: 'load', reachability: 'unconditional' },
    ])
    for (const finding of report.findings) {
      for (const occurrence of finding.occurrences) expect(occurrence.reachabilityBasis).toBe('call-path')
    }
    // main.js and polyfills.js come first in URL order, but only runtime.js links the others: it is the group's entry,
    // and the scripts it links are analyzed only in its group.
    expect(report.artifacts.map((artifact: Report) => [artifact.url, artifact.moduleLinking.linkGroups])).toEqual([
      ['https://app.example/main.js', 1],
      ['https://app.example/polyfills.js', 1],
      ['https://app.example/runtime.js', 1],
    ])
  })

  test("a runtime chunk whose factory table starts empty still starts the page's initial chunks at load", async () => {
    // A real runtime.js has no modules of its own (`var t={}`): every factory comes from the scripts that push.
    const report = await scan({
      'index.html': '<script src="runtime.js"></script><script src="polyfills.js"></script><script src="main.js"></script>',
      'runtime.js': webpackEntry({}, {}, ''),
      'polyfills.js': `(self.${registry}=self.${registry}||[]).push([[429],{5321(t,e,n){window.Promise=function ZoneAwarePromise(){}}},t=>t(t.s=5321)]);`,
      'main.js': `(self.${registry}=self.${registry}||[]).push([[792],{4429(t,e,n){n(5321);history.pushState=function(){}}},t=>t(t.s=4429)]);`,
    })

    expect(findings(report)).toEqual(['window|Window.Promise|replace', 'window|history.pushState|replace'])
    for (const finding of report.findings) {
      for (const occurrence of finding.occurrences) {
        expect([occurrence.installContext, occurrence.reachabilityBasis]).toEqual(['load', 'call-path'])
      }
    }
    expect(report.artifacts.find((artifact: Report) => artifact.url.endsWith('/runtime.js')).moduleLinking).toEqual({
      idioms: ['chunk-loader'],
      modules: 0,
      unlinked: 0,
      linkGroups: 1,
    })
  })
})

// The validation corpus's webpack builds of Datadog and New Relic, whose lazy chunks push into the entry's registry. The
// builds are git-ignored, so these tests are skipped when they are absent.
const corpus = resolve(corpusDir, 'dist/webpack')
describe.skipIf(!existsSync(resolve(corpus, 'datadog/nomaps')))('the corpus webpack builds', () => {
  const scanCorpus = async (site: string) =>
    (await scanBuild(resolve(corpus, site), ['--map', 'https://app.corpus.test/=.', '--surface', 'all'])).report

  test("Datadog's recorder chunk wraps CSS rules, canvas and input setters through the entry's helper", { timeout: 300_000 }, async () => {
    const report = await scanCorpus('datadog/nomaps')

    expect(findings(report)).toEqual(
      expect.arrayContaining([
        'window|CSSStyleSheet.prototype.insertRule|wrap',
        'window|CSSGroupingRule.prototype.deleteRule|wrap',
        'window|CanvasRenderingContext2D.prototype.drawImage|wrap',
        'window|HTMLInputElement.prototype.value|descriptor-change',
      ]),
    )
    const insertRule = report.findings.find((finding: Report) => finding.target.name === 'CSSStyleSheet.prototype.insertRule')
    for (const occurrence of insertRule.occurrences) {
      expect(occurrence.installContext).toBe('deferred')
      // The helper's write is in the entry, and the call that reaches it in the recorder chunk.
      expect(occurrence.trace.map((step: Report) => step.artifact)).toContain('https://app.corpus.test/datadogRecorder.27e3d77f.js')
    }
    // Every chunk is linked, and none is a standalone sweep, so no occurrence assumes its realm.
    for (const artifact of report.artifacts) expect(artifact.moduleLinking.linkGroups).toBe(1)
    expect(report.artifacts.find((artifact: Report) => artifact.url.includes('/main.')).moduleLinking.unlinked).toBe(0)
    expect(limitations(report, 'unresolved-holder').map((limitation: Report) => limitation.detail)).not.toContainEqual(
      expect.stringContaining('Array.prototype.push'),
    )
  })

  test("New Relic's harvester chunk wraps `window.close` through the entry's modules", { timeout: 300_000 }, async () => {
    const report = await scanCorpus('newrelic/nomaps')

    expect(findings(report)).toContain('window|Window.close|wrap')
    expect(occurrences(report, 'Window.close')).toEqual([
      expect.objectContaining({ artifact: 'https://app.corpus.test/harvester.f6c3ee54.js', installContext: 'deferred' }),
    ])
    for (const finding of report.findings) {
      for (const occurrence of finding.occurrences) expect(occurrence.confidence.target.reasons).not.toContain('realm-assumed')
    }
  })
})

// A link group crosses a worker boundary as plain data (§18 Parallelism, §19 Serializable seams): its chunk lookups go
// with it.
test('a lazy chunk joins its loader\'s group in a worker too, and 1- and 4-worker scans print the same report', async () => {
  const files = {
    'index.html': '<script src="main.js"></script>',
    'main.js': webpackEntry({ 100: helper }, { 581: 'recorder' }, 'n.e(581).then(()=>n(6954)).then(m=>m.start());'),
    'recorder.0123abcd.js': webpackChunk(['581'], { 6954: recorder }),
  }
  const reportOf = async (workers: number) => {
    const { report } = await scanBuild(files, [], { deps: { workers } })
    delete report.run
    return report
  }
  const four = await reportOf(4)
  expect(findings(four)).toEqual(['window|CSSStyleSheet.prototype.insertRule|wrap'])
  expect(occurrences(four, 'CSSStyleSheet.prototype.insertRule')).toEqual([
    { artifact: 'https://app.example/main.js', installContext: 'deferred', reachability: 'unconditional' },
  ])
  expect(JSON.stringify(four)).toBe(JSON.stringify(await reportOf(1)))
})

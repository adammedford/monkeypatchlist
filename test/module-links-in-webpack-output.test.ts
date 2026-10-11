// Module links in webpack output (§6): the factory table + require, getter export definer and interop wrapper idioms,
// the per-artifact `moduleLinking` summary, `module-link` trace steps, and broken links. Every scenario goes through
// `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { corpusDir } from '../tools/paths.ts'
import { scanBuild } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

// The shipped resolver, with eslint-scope behind the binding-resolution seam, and the verified drop-in (§19).
const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })

/** webpack 5's runtime pieces, as it emits them minified: the require function, `n.d`, `n.o` and `n.n`. */
const require5 =
  'const e={};function n(r){const o=e[r];if(void 0!==o)return o.exports;const i=e[r]={exports:{}};return t[r](i,i.exports,n),i.exports}'
const define5 =
  'n.d=(t,e)=>{if(Array.isArray(e))for(var r=0;r<e.length;){var o=e[r++],i=e[r++],s=0===i?{enumerable:!0,value:e[r++]}:' +
  '{enumerable:!0,get:i};n.o(t,o)||Object.defineProperty(t,o,s)}else for(var o in e)n.o(e,o)&&!n.o(t,o)&&' +
  'Object.defineProperty(t,o,{enumerable:!0,get:e[o]})},n.o=(t,e)=>Object.prototype.hasOwnProperty.call(t,e),' +
  'n.n=t=>{var e=t&&t.__esModule?()=>t.default:()=>t;return n.d(e,{a:e}),e};'

/** A webpack 5 bundle: an object factory table keyed by module id, the runtime, and the entry code. */
function webpack5(modules: Record<string, string>, entry: string): string {
  const table = Object.entries(modules).map(([id, body]) => `${id}(t,e,n){${body}}`).join(',')
  return `(()=>{"use strict";var t={${table}};${require5}${define5}${entry}})();`
}

/** A webpack 4-style bundle: an IIFE over an array of factories, indexed by module id. */
function webpack4(modules: string[], entry: string): string {
  const table = modules.map((body) => `function(e,t,n){${body}}`).join(',')
  return (
    '!function(e){var t={};function n(r){if(t[r])return t[r].exports;var o=t[r]={i:r,l:!1,exports:{}};' +
    'return e[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}' +
    'n.d=function(e,t,r){n.o(e,t)||Object.defineProperty(e,t,{enumerable:!0,get:r})},' +
    'n.o=function(e,t){return Object.prototype.hasOwnProperty.call(e,t)};' +
    `${entry}}([${table}]);`
  )
}

// The shape of Datadog's fetch instrumentation: module 8104 exports the global object as a value (`J`), module 8974
// exports the patch helper (`H7`) through a getter, and the entry calls the helper on the global object.
const helper = 'n.d(e,{H7:()=>a});function a(t,e,n){const s=t[e];t[e]=function(){return n(s,arguments)}}'
const globals = 'const r=globalThis;n.d(e,["J",0,r])'
const datadogShape = (ids: { global: string; helper: string }) =>
  webpack5(
    { [ids.global]: globals, [ids.helper]: helper },
    `var c=n(${ids.global}),o=n(${ids.helper});(0,o.H7)(c.J,"fetch",(f,a)=>f.apply(this,a));`,
  )

const moduleLinks = (occurrence: Json): Json[] => occurrence.trace.filter((step: Json) => step.kind === 'module-link')
const fingerprints = (report: Json): string[] => report.findings.map((finding: Json) => finding.fingerprint)

describe.each(resolvers)('module links in webpack output, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test('a write whose path crosses modules carries a `module-link` step for each export it goes through', async () => {
    const { report } = await scan(datadogShape({ global: '8104', helper: '8974' }))

    expect(fingerprints(report)).toEqual(['window|Window.fetch|wrap|unknown'])
    const links = moduleLinks(report.findings[0].occurrences[0])
    expect(links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ idiom: 'getter-export', module: '8104', export: 'J' }),
        expect.objectContaining({ idiom: 'getter-export', module: '8974', export: 'H7' }),
      ]),
    )
    expect(report.artifacts[0].moduleLinking).toEqual({
      idioms: ['factory-table', 'getter-export'],
      modules: 2,
      unlinked: 0,
      linkGroups: 1,
    })
  })

  test('rebuilding with other module ids gives the same fingerprints, and the trace names the new ids', async () => {
    const first = (await scan(datadogShape({ global: '8104', helper: '8974' }))).report
    const second = (await scan(datadogShape({ global: '12', helper: '345' }))).report

    expect(fingerprints(second)).toEqual(fingerprints(first))
    expect(moduleLinks(second.findings[0].occurrences[0]).map((step: Json) => step.module).sort()).toEqual(['12', '12', '345', '345'])
  })

  test('a webpack 4-style array table links, with `n.d(exports, name, getter)`', async () => {
    const code = webpack4(
      ['n.d(t,"g",function(){return r});function r(){return window}', 'var o=n(0);(0,o.g)().fetch=function(){}'],
      'n(n.s=1)',
    )
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(moduleLinks(report.findings[0].occurrences[0])).toEqual(
      expect.arrayContaining([expect.objectContaining({ idiom: 'getter-export', module: '0', export: 'g' })]),
    )
    expect(report.artifacts[0].moduleLinking).toMatchObject({ idioms: ['factory-table', 'getter-export'], modules: 2 })
  })

  test.each([
    ['an id missing from the table', 'var o=n(9999);(0,o.H7)(window,"fetch",w)'],
    ['a non-constant id', 'var o=n(k);o.H7(window,"fetch",w)'],
    ['a direct call of what it returns', 'n(9999)(XMLHttpRequest.prototype,"send",w)'],
  ])('a broken link that a native flows into raises `unlinked-module-call`: %s', async (_, entry) => {
    const { report } = await scan(webpack5({ 8974: helper }, `var k=Math.random(),w=function(){};${entry};`))

    expect(report.completeness.limitations.map((limitation: Json) => limitation.kind)).toEqual(['unlinked-module-call'])
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.artifacts[0].moduleLinking.unlinked).toBe(1)
  })

  test('a broken link that no native flows into is only counted', async () => {
    const { report } = await scan(webpack5({ 8974: helper }, 'var o=n(9999);(0,o.H7)({},"x",function(){});'))

    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.level).toBe('complete')
    expect(report.artifacts[0].moduleLinking.unlinked).toBe(1)
  })

  test('an unrecognized runtime degrades silently', async () => {
    const { report } = await scan('var mods={1:function(m){m.x=window}};function load(id){var m={};mods[id](m);return m}load(q).x.fetch=function(){}')

    expect(report.completeness.limitations).toEqual([])
    expect(report.artifacts[0].moduleLinking).toEqual({ idioms: [], modules: 0, unlinked: 0, linkGroups: 1 })
  })

  test.each([
    ['`n.n` of a CommonJS module', { 1: 't.exports=window' }, 'var r=n(1),o=n.n(r);o().fetch=function(){}'],
    ['`n.n(m).a`', { 1: 't.exports=window' }, 'var r=n(1),o=n.n(r);o.a.fetch=function(){}'],
    ['`.default` of an ES module', { 1: 'n.d(e,{default:()=>r});const r=window' }, 'var o=n(1);o.default.fetch=function(){}'],
  ])('an interop wrapper links: %s', async (_, modules, entry) => {
    const { report } = await scan(webpack5(modules, entry))

    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(moduleLinks(report.findings[0].occurrences[0])).toEqual(
      expect.arrayContaining([expect.objectContaining({ idiom: 'factory-table', module: '1' })]),
    )
  })

  test('two runtimes in one artifact that reuse a module id each link their own module', async () => {
    const code =
      webpack5({ 1: 'n.d(e,{g:()=>r});const r=window' }, 'if(typeof fetch!=="function"){var o=n(1);o.g.fetch=function(){}}') +
      webpack5({ 1: 'n.d(e,{p:()=>r});const r=XMLHttpRequest.prototype' }, 'var o=n(1);o.p.send=function(){}')
    const { report } = await scan(code)

    expect(fingerprints(report).sort()).toEqual([
      'window|Window.fetch|replace|unknown',
      'window|XMLHttpRequest.prototype.send|replace|unknown',
    ])
    const send = report.findings.find((finding: Json) => finding.fingerprint.includes('send')).occurrences[0]
    expect(moduleLinks(send)).toEqual(
      expect.arrayContaining([expect.objectContaining({ idiom: 'getter-export', module: '1', export: 'p' })]),
    )
    // Its module is required at top level with no guard, whatever the other runtime's require of the same id is under.
    expect(send.trace.filter((step: Json) => step.kind === 'guard')).toEqual([])
    expect(report.artifacts[0].moduleLinking).toMatchObject({ modules: 2, unlinked: 0 })
  })

  test('`.cw` wraps a concatenated CommonJS module', async () => {
    const code =
      '(()=>{"use strict";const r={cw:e=>{var t;return()=>{if(e){var n=e;e=0,t={exports:{}},n.call(t.exports,t,t.exports)}' +
      'return t.exports}}};var p=r.cw(function(t,e){t.exports=XMLHttpRequest.prototype});p().send=function(){}})();'
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
  })

  test('`.cw` modules that export functions and read each other, as core-js\'s `$export` does', async () => {
    // The shape of core-js in webpack output: each module is a `.cw` thunk at the top of the bundle's IIFE, the export
    // helper reads the global object and the define helper through other modules' thunks, and an entry module calls it.
    const code =
      '(()=>{"use strict";const r={};' +
      'r.cw=t=>{var e;return()=>{if(t){var r=t;t=0,e={exports:{}},r.call(e.exports,e,e.exports)}return e.exports}};' +
      'var g=r.cw(function(t,e){t.exports=window}),' +
      'd=r.cw(function(t,e){t.exports=function(o,k,v){o[k]=v}}),' +
      'x=r.cw(function(t,e){var G=g(),D=d();t.exports=function(p,s){var o=G[p.target].prototype;for(var k in s)D(o,k,s[k])}}),' +
      'm=r.cw(function(t,e){x()({target:"XMLHttpRequest"},{send:function(){}})});m()})();'
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
  })
})

// The validation corpus's webpack builds. The builds are git-ignored, so a checkout
// without them skips these.
const dist = resolve(corpusDir, 'dist/webpack')
describe.skipIf(!existsSync(resolve(dist)))('the corpus webpack builds', () => {
  const scanCorpus = (build: string) => scanBuild(resolve(dist, build), ['--map', 'https://app.corpus.test/=.'])
  const headline = (report: Json) =>
    report.findings.filter((finding: Json) =>
      /^(Window\.fetch|XMLHttpRequest\.prototype\.(open|send)|History\.prototype\.(pushState|replaceState))$/.test(finding.target.name),
    )

  // The first scan of a corpus build in this file also parses the shared catalog: loaded runners take seconds over it.
  test('Datadog\'s headline findings carry a `module-link` step wherever their path crosses a module', async () => {
    const { report } = await scanCorpus('datadog/nomaps')

    // Datadog's `stop()` writes each original back: a restore, never a `replace` finding of its own (§3 Restores).
    expect(headline(report).map((finding: Json) => finding.fingerprint)).toEqual([
      'window|History.prototype.pushState|wrap|unknown',
      'window|History.prototype.replaceState|wrap|unknown',
      'window|Window.fetch|wrap|unknown',
      'window|XMLHttpRequest.prototype.open|wrap|unknown',
      'window|XMLHttpRequest.prototype.send|wrap|unknown',
    ])
    for (const finding of headline(report)) {
      for (const occurrence of finding.occurrences) {
        expect(moduleLinks(occurrence)).toEqual(
          expect.arrayContaining([expect.objectContaining({ idiom: 'getter-export', module: '8974', export: 'H7' })]),
        )
      }
    }
    const fetch = report.findings.find((finding: Json) => finding.target.name === 'Window.fetch')
    for (const occurrence of fetch.occurrences) {
      expect(moduleLinks(occurrence)).toEqual(
        expect.arrayContaining([expect.objectContaining({ idiom: 'getter-export', module: '8104', export: 'J' })]),
      )
    }
    const main = report.artifacts.find((artifact: Json) => artifact.path.startsWith('main.'))
    expect(main.moduleLinking).toMatchObject({ idioms: ['chunk-loader', 'factory-table', 'getter-export'], modules: 80, linkGroups: 1 })
  }, 120_000)

  test('Sentry 11\'s fully scope-hoisted build keeps its headline findings, with no modules and no `module-link` steps', async () => {
    const { report } = await scanCorpus('sentry-11/nomaps')

    expect(headline(report).map((finding: Json) => finding.fingerprint)).toEqual([
      'window|Window.fetch|wrap|unknown',
      'window|XMLHttpRequest.prototype.open|wrap|unknown',
      'window|XMLHttpRequest.prototype.send|wrap|unknown',
    ])
    expect(report.findings.map((finding: Json) => finding.fingerprint)).toEqual(
      expect.arrayContaining(['window|history.pushState|wrap|unknown', 'window|history.replaceState|wrap|unknown']),
    )
    expect(report.findings.flatMap((finding: Json) => finding.occurrences.flatMap(moduleLinks))).toEqual([])
    expect(report.artifacts.map((artifact: Json) => artifact.moduleLinking)).toEqual([
      { idioms: [], modules: 0, unlinked: 0, linkGroups: 1 },
    ])
  }, 120_000)

  test("core-js's `.cw` modules link as lazy module thunks, and its `$export` install paths resolve", async () => {
    const { report } = await scanCorpus('core-js/nomaps')

    expect(report.artifacts.map((artifact: Json) => artifact.moduleLinking)).toEqual([
      { idioms: ['factory-table', 'interop', 'lazy-thunk'], modules: 181, unlinked: 0, linkGroups: 1 },
    ])
    expect(report.findings.map((finding: Json) => finding.fingerprint)).toEqual(
      expect.arrayContaining([
        'window|Window.fetch|wrap|unknown',
        'window|Window.Promise|replace|unknown',
        'window|Promise.prototype.then|replace|unknown',
        'window|Array.prototype.at|replace|unknown',
      ]),
    )
    const fetch = report.findings.find((finding: Json) => finding.fingerprint === 'window|Window.fetch|wrap|unknown')
    expect(fetch.occurrences.flatMap(moduleLinks)).toEqual(expect.arrayContaining([expect.objectContaining({ idiom: 'lazy-thunk' })]))
  }, 180_000)
})


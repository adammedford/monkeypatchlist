// Module links in esbuild, Rollup and Rolldown output (§6): the memoized getter, lazy module thunk, getter export definer
// and interop wrapper idioms, as those bundlers emit them. The fixtures under `test/fixtures/module-link-idioms/` are
// real bundler output: one small app (`app/`), built by the validation corpus's pinned esbuild, Rollup 4 and Vite
// (Rolldown) as the corpus builds its apps (`build.mjs`). Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
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
type Json = any

const fixture = (bundler: string) => resolve('test/fixtures/module-link-idioms', bundler)
const moduleLinks = (occurrence: Json): Json[] => occurrence.trace.filter((step: Json) => step.kind === 'module-link')
const finding = (report: Json, name: string): Json => report.findings.find((each: Json) => each.target.name === name)
const linksOf = (report: Json, name: string): Json[] => finding(report, name).occurrences.flatMap(moduleLinks)
const artifact = (report: Json, path: string): Json => report.artifacts.find((each: Json) => each.path === path)

describe.each(resolvers)('module links in esbuild, Rollup and Rolldown output, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (build: string | Record<string, string>) => scanBuild(build, [], { deps: { resolver } })

  test('esbuild: lazy module thunks (`__commonJS`), the interop wrapper `__toESM` and the definer `__export` link', async () => {
    const { report } = await scan(fixture('esbuild'))

    // `fetch` is patched in a CommonJS module, through two others it requires: the patch helper and the global object.
    expect(finding(report, 'Window.fetch').fingerprint).toBe('window|Window.fetch|replace|unknown')
    expect(linksOf(report, 'Window.fetch')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ idiom: 'lazy-thunk', module: 'e' }),
        expect.objectContaining({ idiom: 'lazy-thunk', module: 'y' }),
      ]),
    )
    // `send` is named through an ES module's namespace object, whose exports `__export` defines, and patched by the
    // helper, read as the `default` of `__toESM` over its module.
    expect(finding(report, 'XMLHttpRequest.prototype.send').fingerprint).toBe('window|XMLHttpRequest.prototype.send|replace|unknown')
    expect(linksOf(report, 'XMLHttpRequest.prototype.send')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ idiom: 'getter-export', module: 'u', export: 'prototype' }),
        expect.objectContaining({ idiom: 'interop', module: 'e' }),
      ]),
    )
    expect(artifact(report, 'main.js').moduleLinking).toEqual({
      idioms: ['getter-export', 'interop', 'lazy-thunk'],
      modules: 4,
      unlinked: 0,
      linkGroups: 1,
    })
  })

  test('esbuild: an init-only lazy thunk (`__esm`) runs its module, whose export a dynamic import reads', async () => {
    const { report } = await scan(fixture('esbuild'))

    expect(finding(report, 'History.prototype.pushState').fingerprint).toBe('window|History.prototype.pushState|replace|unknown')
    expect(linksOf(report, 'History.prototype.pushState')).toEqual(
      expect.arrayContaining([expect.objectContaining({ idiom: 'lazy-thunk' })]),
    )
  })

  test('Rollup: memoized getters (`requireX`) and the interop wrapper `getDefaultExportFromCjs` link', async () => {
    const { report } = await scan(fixture('rollup'))

    expect(finding(report, 'Window.fetch').fingerprint).toBe('window|Window.fetch|replace|unknown')
    expect(linksOf(report, 'Window.fetch')).toEqual(
      expect.arrayContaining([expect.objectContaining({ idiom: 'memoized-getter' })]),
    )
    expect(linksOf(report, 'Window.fetch')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ idiom: 'memoized-getter', module: 'o' }),
        expect.objectContaining({ idiom: 'memoized-getter', module: 'f' }),
      ]),
    )
    expect(artifact(report, 'main.js').moduleLinking).toEqual({
      idioms: ['interop', 'memoized-getter'],
      modules: 2,
      unlinked: 0,
      linkGroups: 1,
    })
  })

  test('Vite (Rolldown): lazy module thunks (`__commonJSMin`) and `__toESM` link', async () => {
    const { report } = await scan(fixture('vite'))

    expect(finding(report, 'Window.fetch').fingerprint).toBe('window|Window.fetch|replace|unknown')
    expect(linksOf(report, 'Window.fetch')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ idiom: 'lazy-thunk', module: 'u' }),
        expect.objectContaining({ idiom: 'lazy-thunk', module: 'd' }),
      ]),
    )
    // Rolldown's `__exportAll` defines a fresh namespace object's getters, as esbuild's `__export` defines a given one's.
    expect(linksOf(report, 'XMLHttpRequest.prototype.send')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ idiom: 'getter-export', module: 'h', export: 'prototype' }),
        expect.objectContaining({ idiom: 'interop', module: 'u' }),
      ]),
    )
    expect(artifact(report, 'assets/index.js').moduleLinking).toEqual({
      idioms: ['getter-export', 'interop', 'lazy-thunk'],
      modules: 3,
      unlinked: 0,
      linkGroups: 1,
    })
  })

  test('the three builds find the same targets inside their entry artifact', async () => {
    const names = async (bundler: string) =>
      (await scan(fixture(bundler))).report.findings
        .filter((each: Json) => each.target.name === 'Window.fetch')
        .map((each: Json) => each.fingerprint)
    expect(await names('rollup')).toEqual(await names('esbuild'))
    expect(await names('vite')).toEqual(await names('esbuild'))
  })

  test('a rebuilt module keeps its fingerprints: thunk and getter names never enter identity', async () => {
    const code = (thunk: string) =>
      `(()=>{var c=(r,t)=>()=>(t||r((t={exports:{}}).exports,t),t.exports);var ${thunk}=c((B,s)=>{s.exports=window});${thunk}().fetch=function(){};})();`
    const first = (await scan({ 'index.html': '<script src="main.js"></script>', 'main.js': code('e') })).report
    const second = (await scan({ 'index.html': '<script src="main.js"></script>', 'main.js': code('q') })).report

    expect(first.findings.map((each: Json) => each.fingerprint)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(second.findings.map((each: Json) => each.fingerprint)).toEqual(first.findings.map((each: Json) => each.fingerprint))
    expect(moduleLinks(second.findings[0].occurrences[0])).toEqual([expect.objectContaining({ idiom: 'lazy-thunk', module: 'q' })])
  })

  test("a thunk's or getter's step names a call, not a require call", async () => {
    const texts = async (bundler: string) => linksOf((await scan(fixture(bundler))).report, 'Window.fetch').map((step: Json) => step.text)
    for (const bundler of ['esbuild', 'rollup', 'vite']) {
      const runs = (await texts(bundler)).filter((text: string) => text.includes(' runs ('))
      expect(runs.length).toBeGreaterThan(0)
      for (const text of runs) expect(text).toMatch(/, which the call at \d+:\d+ runs \((lazy-thunk|memoized-getter|interop)\)$/)
    }
  })

  test('a run-once guard is not a memoized getter: its early return gives no value', async () => {
    const code = `(()=>{var d;function o(){if(d)return;d=!0;window.fetch=function(){}}o();})();`
    const { report } = await scan({ 'index.html': '<script src="main.js"></script>', 'main.js': code })

    expect(finding(report, 'Window.fetch').fingerprint).toBe('window|Window.fetch|replace|unknown')
    expect(linksOf(report, 'Window.fetch')).toEqual([])
    expect(artifact(report, 'main.js').moduleLinking).toEqual({ idioms: [], modules: 0, unlinked: 0, linkGroups: 1 })
  })
})

// The corpus's Sentry 11 builds (criterion 2): esbuild's and webpack's find the same headline targets. The builds are
// git-ignored, so a checkout without them skips this.
const dist = resolve(corpusDir, 'dist')
describe.skipIf(!existsSync(resolve(dist, 'esbuild/sentry-11')))('the corpus Sentry 11 builds', () => {
  const headline = async (bundler: string) => {
    const { report } = await scanBuild(resolve(dist, bundler, 'sentry-11/nomaps'), ['--map', 'https://app.corpus.test/=.'])
    return report.findings
      .filter((each: Json) =>
        /^(Window\.fetch|XMLHttpRequest\.prototype\.(open|send)|history\.(pushState|replaceState))$/.test(each.target.name),
      )
      .map((each: Json) => each.fingerprint)
  }

  test('the esbuild build and the webpack build find the same headline targets', async () => {
    const webpack = await headline('webpack')
    expect(webpack).toEqual([
      'window|Window.fetch|wrap|unknown',
      'window|XMLHttpRequest.prototype.open|wrap|unknown',
      'window|XMLHttpRequest.prototype.send|wrap|unknown',
      'window|history.pushState|wrap|unknown',
      'window|history.replaceState|wrap|unknown',
    ])
    expect(await headline('esbuild')).toEqual(webpack)
  }, 60_000)
})

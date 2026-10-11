// Global resolution (§5): the global-object forms that need call evaluation. IIFEs that return the global, `this` under
// ECMA-262's this-binding for the calls the resolver evaluates, callback-supplied globals, and the bundlers' global
// helpers. Every scenario goes through `monkeypatchlist scan --json`.

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

// The shipped resolver, with eslint-scope behind the binding-resolution seam, and the verified drop-in (§19).
const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const module = (code: string) => ({ 'index.html': '<script type="module" src="main.js"></script>', 'main.js': code })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** A fixture build cut from a real bundler's output (`test/fixtures/global-helpers/<bundler>/`). */
const cut = (bundler: string) => {
  const read = (file: string) => readFileSync(new URL(`fixtures/global-helpers/${bundler}/${file}`, import.meta.url), 'utf8')
  return { 'index.html': read('index.html'), 'main.js': read('main.js') }
}

const names = (report: Report): string[] => report.findings.map((finding: { target: { name: string } }) => finding.target.name)
const limitations = (report: Report): string[] => report.completeness.limitations.map((record: { kind: string }) => record.kind)
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Step = any
/** The trace steps of the first occurrence of the first finding. */
const trace = (report: Report): Step[] => report.findings[0].occurrences[0].trace
/** The `binding` steps' forms of the first occurrence. */
const forms = (report: Report): string[] => trace(report).filter((step) => step.kind === 'binding').map((step) => step.form)

describe.each(resolvers)('global-object forms through calls, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = async (files: Record<string, string>): Promise<Report> => (await scanBuild(files, [], { deps: { resolver } })).report

  describe('IIFEs that return the global', () => {
    test.each([
      ['spelled out', 'var g = (function () { return this })();\ng.fetch = w'],
      ['minified', 'var g=function(){return this}();g.fetch=w'],
      ['negated and minified', '!function(){var g=function(){return this}();g.fetch=w}()'],
    ])('a sloppy (function(){ return this })() is the global object: %s', async (_, code) => {
      const report = await scan(classic(code))

      expect(names(report)).toEqual(['Window.fetch'])
      expect(forms(report)).toEqual(['sloppy-this'])
      expect(report.completeness.level).toBe('complete')
    })

    test.each([
      ['a "use strict" function', classic('var g = (function () { "use strict"; return this })();\ng.fetch = w;\ng.fetch = wrap(g.fetch)')],
      ['minified', classic('var g=function(){"use strict";return this}();g.fetch=w;g.fetch=wrap(g.fetch)')],
      ['in strict code around it', classic('"use strict";\nvar g = (function () { return this })();\ng.fetch = wrap(g.fetch)')],
      ['in a module, which is strict code', module('const g = (function () { return this })();\ng.fetch = wrap(g.fetch)')],
    ])('a strict (function(){ return this })() gives nothing: %s', async (_, files) => {
      const report = await scan(files)

      expect(names(report)).toEqual([])
      expect(report.completeness.level).toBe('complete')
    })

    test.each([
      ['an arrow that returns window', 'var g = (() => window)();\ng.fetch = w'],
      ['an arrow that returns self, minified', 'var g=(()=>self)();g.fetch=w'],
      ['an arrow with a typeof chain', 'var g = (() => typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : void 0)();\ng.fetch = w'],
      ['an arrow that calls an arrow', 'var a = () => self, b = () => a();\nb().fetch = w'],
      ['nested arrow IIFEs', 'var g = (() => (() => window)())();\ng.fetch = w'],
    ])('%s is the global object', async (_, code) => {
      const report = await scan(classic(code))

      expect(names(report)).toEqual(['Window.fetch'])
    })
  })

  describe('callback-supplied globals', () => {
    test.each([
      ['with this', '(function (root, factory) { root.Lib = factory(root) })(this, function (g) { g.fetch = w; return {} })'],
      ['with window', '(function (root, factory) { factory(root) })(window, function (g) { g.fetch = w })'],
      [
        'minified, with the CommonJS and AMD tests',
        '!function(e,t){"object"==typeof exports&&"undefined"!=typeof module?t(e):"function"==typeof define&&define.amd?define(["exports"],t):t((e="undefined"!=typeof globalThis?globalThis:e||self))}(this,function(g){g.fetch=w})',
      ],
    ])('a UMD factory called %s writes through the global it is given', async (_, code) => {
      const report = await scan(classic(code))

      expect(names(report)).toEqual(['Window.fetch'])
      expect(trace(report).map((step) => step.kind)).toContain('call')
    })
  })

  describe('`this` follows ECMA-262 for the calls the resolver evaluates', () => {
    test.each([
      ['f()', 'function f() { this.fetch = w }\nf()'],
      ['f.call(null)', 'function f() { this.fetch = w }\nf.call(null)'],
      ['f.apply(undefined)', 'function f() { this.fetch = w }\nf.apply(undefined)'],
      ['f.call(this) at the top level', 'function f() { this.fetch = w }\nf.call(this)'],
      ['a function value called plainly', 'var f = function () { this.fetch = w }, g = f;\ng()'],
      ['a bound function with a null this', 'function f() { this.fetch = w }\nf.bind(null)()'],
      ['a callback a user function calls', 'function run(cb) { cb() }\nrun(function () { this.fetch = w })'],
      ['an unrolled forEach without a thisArg', '[0].forEach(function () { this.fetch = w })'],
      ['an unrolled reduce', '[0, 1].reduce(function (a) { this.fetch = w; return a }, 0)'],
      ['a method called through a sequence', 'var o = { m: function () { this.fetch = w } };\n(0, o.m)()'],
    ])('a sloppy function with no `this` is the global object: %s', async (_, code) => {
      const report = await scan(classic(code))

      expect(names(report)).toEqual(['Window.fetch'])
      expect(forms(report)).toEqual([code.includes('f.call(this)') ? 'top-level-this' : 'sloppy-this'])
      expect(report.completeness.level).toBe('complete')
    })

    test('a method called on its object keeps the object as `this`', async () => {
      const report = await scan(classic('var o = { m: function () { this.fetch = w } };\no.m()'))

      expect(names(report)).toEqual([])
    })

    test('an iteration native passes its thisArg', async () => {
      const report = await scan(classic('[0].forEach(function () { this.send = w }, XMLHttpRequest.prototype)'))

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.send'])
    })

    test.each([
      ['f()', '"use strict";\nfunction f() { this.fetch = wrap(this.fetch) }\nf()'],
      ['f.call(null)', 'function f() { "use strict"; this.fetch = wrap(this.fetch) }\nf.call(null)'],
      ['a forEach callback', '[0].forEach(function () { "use strict"; this.fetch = wrap(this.fetch) })'],
    ])("a strict function's `this` is what the call passes, so %s gives nothing", async (_, code) => {
      const report = await scan(classic(code))

      expect(names(report)).toEqual([])
      expect(report.completeness.level).toBe('complete')
    })

    test.each([
      ['a function with no resolved call', 'function f() { this.fetch = wrap(this.fetch) }'],
      ['a timer callback', 'setTimeout(function () { this.fetch = wrap(this.fetch) }, 0)'],
      ['a listener', "addEventListener('load', function () { this.fetch = wrap(this.fetch) })"],
      ['a callback passed to an unresolved function', 'lib.run(function () { this.fetch = wrap(this.fetch) })'],
    ])('%s keeps `this` unknown: a patch-shaped write gives unresolved-holder', async (_, code) => {
      const report = await scan(classic(code))

      expect(names(report)).toEqual([])
      expect(limitations(report)).toEqual(['unresolved-holder'])
      expect(report.completeness.level).toBe('complete-with-limitations')
    })

    test.each([
      ['a function with no resolved call', 'function f() { this.fetch = w }'],
      ['a timer callback', 'setTimeout(function () { this.fetch = w }, 0)'],
      ['a listener', "addEventListener('load', function () { this.fetch = w })"],
    ])('%s keeps `this` unknown: a plain write gives nothing', async (_, code) => {
      const report = await scan(classic(code))

      expect(names(report)).toEqual([])
      expect(report.completeness.level).toBe('complete')
    })

    test('uncalled code gives no new findings: a function no call reaches keeps an unknown `this`, nested or not', async () => {
      const report = await scan(
        classic('function install() { this.fetch = w; function inner() { this.open = w } var o = { m: function () { var f = function () { this.alert = w } } } }'),
      )

      expect(names(report)).toEqual([])
      expect(report.completeness.level).toBe('complete')
    })

    test('an IIFE in a function no call reaches is a call the resolver evaluates there, as its other code is', async () => {
      const iife = await scan(classic('function install() { var g = (function () { return this })(); g.fetch = w }'))
      const named = await scan(classic('function install() { var g = window; g.fetch = w }'))

      expect(names(iife)).toEqual(names(named))
      expect(names(iife)).toEqual(['Window.fetch'])
    })
  })

  describe('bundler global helpers, in fixtures cut from real output', () => {
    test("webpack's __webpack_require__.g, read in a linked module's factory (es6-promise's polyfill)", async () => {
      const report = await scan(cut('webpack'))

      expect(names(report)).toEqual(['Window.Promise'])
      const steps = trace(report)
      // `r.g = function(){ if ("object" == typeof globalThis) return globalThis; try { return this || … } … }()`
      expect(steps.filter((step) => step.kind === 'binding')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'globalThis', form: 'global-name' }),
          expect.objectContaining({ name: 'this', form: 'sloppy-this', resolution: 'alias', aliasOf: 'Window' }),
        ]),
      )
      expect(steps.map((step) => step.kind)).toContain('call')
    })

    test("Rollup's commonjs global module, behind its memoized getter, through define-global-property", async () => {
      const report = await scan(cut('rollup'))

      expect(names(report)).toEqual(['Window.fetch'])
      const links = trace(report).filter((step) => step.kind === 'module-link')
      expect(links.length).toBeGreaterThan(0)
      for (const link of links) expect(link.idiom).toBe('memoized-getter')
    })

    test("esbuild's commonjs global module, behind its lazy thunk", async () => {
      const report = await scan(cut('esbuild'))

      expect(names(report)).toEqual(['Window.fetch'])
      expect(trace(report).filter((step) => step.kind === 'module-link').map((step) => step.idiom)).toEqual(['lazy-thunk'])
      expect(forms(report)).toEqual(['global-name'])
    })
  })
})

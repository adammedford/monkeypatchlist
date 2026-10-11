// Global resolution (§5): the syntactic forms that reach the global object, and the native holders reached from it,
// without evaluating a call. Every scenario goes through `monkeypatchlist scan --json`. The forms that need calls (IIFEs that
// return the global, callback-supplied globals, bundler global helpers) have tests of their own.

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

const fingerprints = (report: Report): string[] => report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)

/** The `binding` steps of every occurrence, in report order. */
const bindings = (report: Report) =>
  report.findings.flatMap((finding: { occurrences: { trace: { kind: string }[] }[] }) =>
    finding.occurrences.flatMap((occurrence) => occurrence.trace.filter((step) => step.kind === 'binding')),
  )

const current = { realm: 'window', realmInstance: 'current' }
const text = expect.any(String)

describe.each(resolvers)('global resolution, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe('free window, self and globalThis', () => {
    test('each is the global object, directly, through one another and through an assignment', async () => {
      const { report } = await scan(
        classic('window.fetch = a\nself.alert = b\nglobalThis.open = c\nwindow.self.globalThis.print = d\nvar w; (w = self).stop = e'),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|Window.print|replace|unknown',
        'window|Window.stop|replace|unknown',
      ])
      const alias = { kind: 'binding', resolution: 'alias', form: 'global-name', aliasOf: 'Window', ...current, text }
      expect(bindings(report)).toEqual(
        ['self', 'window', 'globalThis', 'window', 'self'].map((name) => ({ ...alias, name })),
      )
    })
  })

  describe('bare constructors and their prototypes', () => {
    test('XMLHttpRequest.prototype.send = w gives XMLHttpRequest.prototype.send, reached from the global object', async () => {
      const { report } = await scan(classic('XMLHttpRequest.prototype.send = w'))

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
      expect(report.findings[0].target).toEqual({ realm: 'window', holder: 'prototype', name: 'XMLHttpRequest.prototype.send' })
      expect(bindings(report)).toEqual([
        {
          kind: 'binding',
          name: 'XMLHttpRequest',
          resolution: 'global',
          form: 'global-property',
          holds: 'XMLHttpRequest',
          ...current,
          text,
        },
      ])
    })

    test('the same holders are reached through window, from namespaces and constructors, and down qualified paths', async () => {
      const { report } = await scan(
        classic(
          [
            'window.XMLHttpRequest.prototype.open = a',
            'Math.random = b',
            'Promise.resolve = c',
            'Array.prototype.map = d',
            'WebAssembly.Memory.prototype.grow = e',
            'self.EventTarget.prototype.addEventListener = f',
          ].join('\n'),
        ),
      )

      expect(report.findings.map((finding: { target: unknown }) => finding.target)).toEqual([
        { realm: 'window', holder: 'prototype', name: 'Array.prototype.map' },
        { realm: 'window', holder: 'prototype', name: 'EventTarget.prototype.addEventListener' },
        { realm: 'window', holder: 'namespace', name: 'Math.random' },
        { realm: 'window', holder: 'constructor', name: 'Promise.resolve' },
        { realm: 'window', holder: 'prototype', name: 'WebAssembly.Memory.prototype.grow' },
        { realm: 'window', holder: 'prototype', name: 'XMLHttpRequest.prototype.open' },
      ])
      expect(bindings(report).map((step: { name: string; form: string }) => [step.name, step.form])).toEqual([
        ['Array', 'global-property'],
        ['self', 'global-name'],
        ['Math', 'global-property'],
        ['Promise', 'global-property'],
        ['WebAssembly', 'global-property'],
        ['window', 'global-name'],
      ])
    })

    test('a user object never reaches a native holder, whatever its prototype chain', async () => {
      const { report } = await scan(
        classic(
          [
            'var o = Object.create(XMLHttpRequest.prototype); o.send = a',
            'Object.create(XMLHttpRequest.prototype).send = b',
            'new XMLHttpRequest().open = c',
            '({ __proto__: XMLHttpRequest.prototype }).abort = d',
          ].join(';\n'),
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('a local that shares a native name is no native: a class, a parameter, a module import or a top-level function', async () => {
      const local = await scan(
        classic(
          [
            'function f(Promise){ Promise.prototype.finally = a }',
            'class XMLHttpRequest {}; XMLHttpRequest.prototype.send = b',
            'function Math(){}; Math.random = c',
          ].join('\n'),
        ),
      )
      const imported = await scan(module('import { Promise } from "./p.js"\nPromise.prototype.finally = a'))

      // Only the top-level class and function themselves (§3 Declarations in classic scripts).
      expect(local.report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
        'window|Window.Math|replace|unknown',
        'window|Window.XMLHttpRequest|replace|unknown',
      ])
      expect(imported.report.findings).toEqual([])
    })
  })

  describe('top-level this', () => {
    test('this at the top level of a classic script is the global object, strict or not, and inside arrows', async () => {
      const { report } = await scan(
        classic('this.fetch = a\n"use strict"; this.setTimeout = b\nvar f = () => { this.alert = c }\nclass A extends (this.open = d, Object) {}'),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|Window.setTimeout|replace|unknown',
      ])
      expect(bindings(report)[0]).toEqual({
        kind: 'binding',
        name: 'this',
        resolution: 'alias',
        form: 'top-level-this',
        aliasOf: 'Window',
        ...current,
        text,
      })
    })

    test('top-level this in a module is undefined, so writing through it gives no finding', async () => {
      const { report } = await scan(module('this.fetch = a\nvar f = () => { this.alert = b }'))

      expect(report.findings).toEqual([])
    })

    test('this in a function, a class field or a static block is not the top-level this', async () => {
      const { report } = await scan(
        classic(
          [
            'function f(){ this.fetch = a }',
            'var g = function(){ this.alert = b }',
            'class A { x = this.open = c; static { this.print = d } m(){ this.stop = e } }',
            'var o = { m(){ this.focus = f } }',
          ].join('\n'),
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('UMD this: the top-level this a UMD wrapper passes is the global object where a chain selects it', async () => {
      const { report } = await scan(classic('(typeof exports === "object" ? exports : this).fetch = a'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(bindings(report)).toEqual([
        expect.objectContaining({ name: 'this', form: 'top-level-this', chain: { start: 1, end: 45, line: 1, column: 1 } }),
      ])
    })
  })

  describe('typeof chains, in every minified spelling', () => {
    // A typeof test of one of the realm's names for its global object folds against the catalog, so a chain keeps only
    // the arms it can take: here, the first.
    const cases: [string, string][] = [
      // Rollup's commonjsGlobal, minified.
      ['"undefined"!=typeof globalThis?globalThis:"undefined"!=typeof self?self:"undefined"!=typeof window?window:"undefined"!=typeof global?global:{}', 'globalThis'],
      // whatwg-fetch.
      ["(typeof globalThis !== 'undefined' && globalThis) || (typeof self !== 'undefined' && self) || (typeof global !== 'undefined' && global) || {}", 'globalThis'],
      // esbuild's `typeof x < "u"`, in zone.js's UMD wrapper, whose last arm is the top-level this.
      ['typeof globalThis<"u"?globalThis:typeof self<"u"?self:this', 'globalThis'],
      // PostHog's reversed test, with `void 0` as the fallback.
      ['"u">typeof window?window:void 0', 'window'],
      // core-js's object test, unwrapped.
      ['"object"==typeof globalThis&&globalThis||"object"==typeof window&&window', 'globalThis'],
      // underscore's self-check: `self.self === self` compares the global object with itself.
      ["typeof self == 'object' && self.self === self && self || typeof global == 'object' && global.global === global && global || this || {}", 'self'],
      // A negated test, and the arm on its false side.
      ['typeof window>"u"?{}:window', 'window'],
    ]

    test.each(cases)('(%s).fetch = w gives Window.fetch through %s', async (chain, name) => {
      const code = `(${chain}).fetch = w`
      const { report } = await scan(classic(code))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      const [step, ...others] = bindings(report)
      expect(others).toEqual([])
      expect(step).toEqual({
        kind: 'binding',
        name,
        resolution: 'alias',
        form: 'global-name',
        aliasOf: 'Window',
        chain: { start: 1, end: 1 + chain.length, line: 1, column: 1 },
        ...current,
        text,
      })
    })

    test('a chain reaches holders through the global object, and one that never selects it gives nothing', async () => {
      const { report } = await scan(
        classic(
          [
            '("undefined"!=typeof self?self:{}).XMLHttpRequest.prototype.send = a',
            '(typeof module<"u"?module:{}).fetch = b',
            '(typeof self>"u"&&self).alert = c',
          ].join(';\n'),
        ),
      )

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
    })

    test('an undecided arm that holds no native leaves the other arm the one holder written', async () => {
      const { report } = await scan(classic('function f(e){ (e || window).fetch = a; (e ? {} : self).alert = b }'))

      expect(fingerprints(report)).toEqual(['window|Window.alert|replace|unknown', 'window|Window.fetch|replace|unknown'])
    })
  })

  describe('a typeof-guarded global', () => {
    test('global under a typeof global guard is the global object: if statements, && and || sides, ?: arms', async () => {
      const { report } = await scan(
        classic(
          [
            "if (typeof global !== 'undefined') global.fetch = a",
            'typeof global<"u"&&(global.alert=b)',
            '"undefined"==typeof global||(global.open=c)',
            "if (typeof global === 'undefined') {} else { global.print = d }",
            '(typeof global == "object" && global).stop = e',
          ].join('\n'),
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|Window.print|replace|unknown',
        'window|Window.stop|replace|unknown',
      ])
      expect(bindings(report)[1]).toEqual({
        kind: 'binding',
        name: 'global',
        resolution: 'alias',
        form: 'guarded-global',
        aliasOf: 'Window',
        ...current,
        text,
      })
    })

    test('a chain that can select both a guarded global and self records both', async () => {
      const { report } = await scan(classic('(typeof global<"u"?global:self).fetch = a'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      const chain = { start: 1, end: 30, line: 1, column: 1 }
      expect(bindings(report)).toEqual([
        { kind: 'binding', name: 'global', resolution: 'alias', form: 'guarded-global', aliasOf: 'Window', chain, ...current, text },
        { kind: 'binding', name: 'self', resolution: 'alias', form: 'global-name', aliasOf: 'Window', chain, ...current, text },
      ])
    })

    test('an unguarded, wrongly guarded or declared global is not the global object', async () => {
      const { report } = await scan(
        classic(
          [
            'global.fetch = a',
            "if (typeof global === 'undefined') global.alert = b",
            "if (typeof window !== 'undefined') global.open = c",
            'function f(global){ if (typeof global<"u") global.print = d }',
            'function g(){ var global; if (typeof global<"u") global.stop = e }',
          ].join('\n'),
        ),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe("Function('return this')()", () => {
    test('calling a function the Function constructor made from `return this` gives the global object', async () => {
      const { report } = await scan(
        classic(
          [
            "Function('return this')().fetch = a",
            'new Function("return this")().alert = b',
            'Function(`return this;`)().open = c',
            'window.Function("return this")().print = d',
          ].join('\n'),
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|Window.print|replace|unknown',
      ])
      expect(bindings(report)[1]).toEqual({
        kind: 'binding',
        name: 'Function',
        resolution: 'alias',
        form: 'function-return-this',
        aliasOf: 'Window',
        ...current,
        text,
      })
    })

    test('the function is sloppy whatever the code around it, so it reaches the global object from a module too', async () => {
      const { report } = await scan(module("Function('return this')().fetch = a"))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    })

    test('a strict body, another receiver, an uncalled function or a local Function is not the global object', async () => {
      const { report } = await scan(
        classic(
          [
            `Function('"use strict"; return this')().fetch = a`,
            "Function('return this').call(o).alert = b",
            "Function('return this').open = c",
            "function f(Function){ Function('return this')().print = d }",
          ].join('\n'),
        ),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe('with and eval taint on the names a form starts from (§9)', () => {
    test('a with block around a bare constructor or a chain lowers target confidence, and around this it does not', async () => {
      const { report } = await scan(
        classic('with (o) { XMLHttpRequest.prototype.send = a; ("undefined"!=typeof self?self:{}).fetch = b; this.alert = c }'),
      )

      const confidence = Object.fromEntries(
        report.findings.map((finding: { target: { name: string }; confidence: { target: unknown } }) => [
          finding.target.name,
          finding.confidence.target,
        ]),
      )
      expect(confidence).toEqual({
        'Window.alert': { level: 'high', reasons: [] },
        'Window.fetch': { level: 'low', reasons: ['with-scope'] },
        'XMLHttpRequest.prototype.send': { level: 'low', reasons: ['with-scope'] },
      })
      const trace = report.findings[2].occurrences[0].trace
      expect(trace.map((step: { kind: string }) => step.kind)).toEqual(['binding', 'confidence-reason', 'guard'])
      expect(trace[1]).toMatchObject({ reason: 'with-scope', name: 'XMLHttpRequest' })
    })
  })

  describe("each realm's names for its global object", () => {
    // The same script runs in the window and, through `importScripts`, in a dedicated worker (§2 Realm).
    const targets = async (code: string) => {
      const { report } = await scan({
        'index.html': '<script src="shared.js"></script><script>new Worker("worker.js")</script>',
        'worker.js': 'importScripts("shared.js")',
        'shared.js': code,
      })
      return report.findings.map(({ target }: Report) => `${target.realm}|${target.name}`)
    }

    test('a worker global is self and globalThis, not window, and a chain there takes the arm it can', async () => {
      const code = [
        'self.XMLHttpRequest.prototype.open = a',
        'globalThis.XMLHttpRequest.prototype.send = b',
        'window.XMLHttpRequest.prototype.abort = c',
        '("undefined"!=typeof window?window:self).Promise = d',
      ].join(';\n')

      expect(await targets(code)).toEqual([
        'dedicated-worker|DedicatedWorkerGlobalScope.Promise',
        'dedicated-worker|XMLHttpRequest.prototype.open',
        'dedicated-worker|XMLHttpRequest.prototype.send',
        'window|Window.Promise',
        'window|XMLHttpRequest.prototype.abort',
        'window|XMLHttpRequest.prototype.open',
        'window|XMLHttpRequest.prototype.send',
      ])
    })
  })
})

// monkeypatchlist's scope post-passes (§5 Parsing and scope, Global resolution), which run above the binding-resolution seam
// (§19). Every scenario goes through `monkeypatchlist scan --json` with each binding resolver behind the seam.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

// The shipped resolver, with eslint-scope behind the seam, and the same resolver with the verified drop-in (§19).
const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const module = (code: string) => ({ 'index.html': '<script type="module" src="main.js"></script>', 'main.js': code })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
const fingerprints = (report: any): string[] => report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)

describe.each(resolvers)('scope post-passes, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe('1. global var and function declarations in a classic script', () => {
    test('a top-level var binds the global object property, so writing it is a finding', async () => {
      const { report } = await scan(classic('var fetch; fetch = w'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    })

    test('so does a top-level function, and a write from a nested function reaches the same property', async () => {
      const { report } = await scan(classic('function setTimeout(){}\nvar fetch\nfunction f(){ fetch = w; setTimeout = x }'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown', 'window|Window.setTimeout|replace|unknown'])
    })

    test('top-level let, const and class do not: a write to them changes the lexical binding only', async () => {
      const { report } = await scan(
        classic('let fetch; fetch = w\nconst alert = 1; function f(){ alert = w }\nclass Event {}; Event = w'),
      )

      // Only the declarations themselves, which hide the global object's members (§3).
      expect(report.findings.map((finding: { occurrences: { mechanism: string }[] }) => finding.occurrences.map((each) => each.mechanism))).toEqual([
        ['declare'],
        ['declare'],
        ['declare'],
      ])
      expect(fingerprints(report)).toEqual([
        'window|Window.Event|replace|unknown',
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
      ])
    })

    test('a top-level function named self or globalThis replaces the global object there, and a var does not', async () => {
      const { report } = await scan(
        classic('function self(){}\nself.fetch = w\nfunction globalThis(){}\nglobalThis.alert = x\nvar window; window.setTimeout = y'),
      )

      // The functions themselves replace `Window.self` and `Window.globalThis` (§3); the bare `var window` sets nothing.
      expect(fingerprints(report)).toEqual([
        'window|Window.globalThis|replace|unknown',
        'window|Window.self|replace|unknown',
        'window|Window.setTimeout|replace|unknown',
      ])
    })

    test('the same code in a module gives nothing: a module top-level var is local', async () => {
      const { report } = await scan(module('var fetch; fetch = w'))

      expect(report.artifacts.map((artifact: { sourceType: string }) => artifact.sourceType)).toEqual(['module'])
      expect(fingerprints(report)).toEqual([])
    })
  })

  describe('2. Annex B block-function hoisting', () => {
    // In sloppy code, a plain function declared in a block also gets a var binding in the enclosing function (B.3.2).
    const hoisted = 'function g(){ if (c) { function fetch(){} } fetch = w }'

    test('a sloppy block function is a var of its function, so a write to its name there is local', async () => {
      const { report } = await scan(classic(hoisted))

      expect(fingerprints(report)).toEqual([])
    })

    test('in strict code the function stays block-scoped, so the same write reaches the global', async () => {
      const strictFunction = await scan(classic('function g(){ "use strict"; if (c) { function fetch(){} } fetch = w }'))
      const strictScript = await scan(classic(`"use strict"; ${hoisted}`))
      const inModule = await scan(module(hoisted))
      const inClass = await scan(classic('class A { m(){ { function fetch(){} } fetch = w } }'))

      for (const { report } of [strictFunction, strictScript, inClass]) {
        expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      }
      expect(inModule.report.findings).toHaveLength(1)
    })

    test('the var binding covers closures in the function, switch cases and names an outer declaration shares', async () => {
      const { report } = await scan(
        classic(
          [
            'function g(){ { function fetch(){} } return function(){ fetch = w } }',
            'function h(){ switch (x) { case 1: function setTimeout(){} } setTimeout = w }',
            'var alert; function k(){ { function alert(){} } alert = w }',
          ].join('\n'),
        ),
      )

      expect(fingerprints(report)).toEqual([])
    })

    test('no var binding when the declaration would clash with an enclosing let, or is async or a generator', async () => {
      const { report } = await scan(
        classic(
          [
            'function g(){ { let fetch; { function fetch(){} } } fetch = w }',
            'function h(){ { async function setTimeout(){} } setTimeout = w }',
            'function k(){ { function* alert(){} } alert = w }',
          ].join('\n'),
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.setTimeout|replace|unknown',
      ])
    })

    test('at the top of a classic script the var binding is the global property itself', async () => {
      const { report } = await scan(classic('if (c) { function fetch(){} } fetch = w'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    })
  })

  describe('3. with and direct-eval taint lower target confidence (§9)', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
    const occurrences = (report: any) => report.findings.flatMap((finding: { occurrences: unknown[] }) => finding.occurrences)
    const high = { level: 'high', reasons: [] }

    test('a with block on the resolution path gives with-scope (low), with the with statement as evidence', async () => {
      const { report } = await scan(classic('var o = {}\nwith (o) { fetch = w }'))

      const [occurrence] = occurrences(report)
      expect(occurrence.confidence.target).toEqual({ level: 'low', reasons: ['with-scope'] })
      // The taint makes reachability `unknown` (§7).
      expect(occurrence.trace.map((step: { kind: string }) => step.kind)).toEqual(['binding', 'confidence-reason', 'guard'])
      expect(occurrence.reachability).toBe('unknown')
      expect(occurrence.trace[1]).toEqual({
        kind: 'confidence-reason',
        dimension: 'target',
        reason: 'with-scope',
        level: 'low',
        name: 'fetch',
        sites: [{ start: 11, end: 33, line: 2, column: 0 }],
        text: expect.any(String),
      })
      expect(report.findings[0].confidence.target).toEqual({ level: 'low', reasons: ['with-scope'] })
    })

    test('it covers aliases of the global object, closures created in the block and nested with blocks', async () => {
      const { report } = await scan(
        classic('with (a) { window.fetch = w }\nwith (b) { with (c) { function f(){ setTimeout = w } } }'),
      )

      expect(occurrences(report).map((occurrence: { confidence: { target: unknown } }) => occurrence.confidence.target)).toEqual([
        { level: 'low', reasons: ['with-scope'] },
        { level: 'low', reasons: ['with-scope'] },
      ])
      const nested = report.findings[1].occurrences[0].trace[1]
      expect(nested).toMatchObject({ reason: 'with-scope', name: 'setTimeout' })
      expect(nested.sites.map((site: { line: number; column: number }) => [site.line, site.column])).toEqual([
        [2, 0],
        [2, 11],
      ])
    })

    test('a sloppy direct eval on the resolution path gives direct-eval-scope (medium), with the call as evidence', async () => {
      const { report } = await scan(classic('function g(){ eval(s); fetch = w }\nfunction h(){ eval(t); function k(){ setTimeout = w } }'))

      const [fetch, setTimeout] = occurrences(report)
      expect(fetch.confidence.target).toEqual({ level: 'medium', reasons: ['direct-eval-scope'] })
      expect(fetch.trace[1]).toEqual({
        kind: 'confidence-reason',
        dimension: 'target',
        reason: 'direct-eval-scope',
        level: 'medium',
        name: 'fetch',
        sites: [{ start: 14, end: 21, line: 1, column: 14 }],
        text: expect.any(String),
      })
      expect(setTimeout.confidence.target).toEqual({ level: 'medium', reasons: ['direct-eval-scope'] })
      expect(report.findings[0].confidence.target).toEqual({ level: 'medium', reasons: ['direct-eval-scope'] })
    })

    test('an eval that could add no shadowing var lowers nothing', async () => {
      const { report } = await scan(
        classic(
          [
            // At the top of a script, a var the eval declares is the global property itself.
            'eval(s); fetch = w',
            // Strict code evaluates its own vars. An indirect or optional call is no direct eval.
            'function a(){ "use strict"; eval(s); setTimeout = w }',
            'function b(){ (0, eval)(s); eval?.(s); alert = w }',
            // A local named eval is not the global eval, and an eval in a function the name is not in is off its path.
            'function c(eval){ eval(s); open = w }',
            'function d(){ print = w; function e(){ eval(s) } }',
          ].join('\n'),
        ),
      )

      expect(occurrences(report)).toHaveLength(5)
      for (const occurrence of occurrences(report)) expect(occurrence.confidence.target).toEqual(high)
    })

    test('with and eval on the same path give both reasons, and the level is the lowest', async () => {
      const { report } = await scan(classic('function g(o){ eval(s); with (o) { fetch = w } }'))

      const [occurrence] = occurrences(report)
      expect(occurrence.confidence.target).toEqual({ level: 'low', reasons: ['direct-eval-scope', 'with-scope'] })
      expect(occurrence.trace.map((step: { kind: string; reason?: string }) => step.reason ?? step.kind)).toEqual([
        'binding',
        'direct-eval-scope',
        'with-scope',
        'creation-site',
        'guard',
        'guard',
      ])
    })

    test('a with block off the resolution path lowers nothing', async () => {
      const { report } = await scan(classic('with (a) {} fetch = w\nwith (setTimeout = w) {}'))

      expect(occurrences(report)).toHaveLength(2)
      for (const occurrence of occurrences(report)) {
        expect(occurrence.confidence.target).toEqual(high)
        expect(occurrence.trace.map((step: { kind: string }) => step.kind)).toEqual(['binding'])
      }
    })
  })

  describe('4. an unqualified delete is a global delete', () => {
    test('delete fetch in a sloppy script deletes Window.fetch, with effect and mechanism delete', async () => {
      const { report } = await scan(classic('delete fetch\nvar setTimeout; function f(){ delete setTimeout }'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|delete|unknown', 'window|Window.setTimeout|delete|unknown'])
      expect(report.findings[0].occurrences[0]).toMatchObject({
        generated: { start: 0, end: 12, line: 1, column: 0 },
        mechanism: 'delete',
      })
    })

    test('deleting a local, or deleting in strict code (a SyntaxError), gives nothing', async () => {
      const local = await scan(classic('function f(fetch){ delete fetch }\nfunction g(){ var alert; delete alert }'))
      const strictFunction = await scan(classic('function f(){ "use strict"; delete fetch }'))
      const strictScript = await scan(classic('"use strict"; delete fetch'))
      const inModule = await scan(module('delete fetch'))
      const inClass = await scan(classic('class A { m(){ delete fetch } }'))

      for (const { report } of [local, strictFunction, strictScript, inModule, inClass]) expect(report.findings).toEqual([])
    })

    test('deleting a non-configurable global member changes nothing, so it is no finding', async () => {
      const { report } = await scan(classic('delete document\ndelete NaN'))

      expect(report.findings).toEqual([])
    })
  })

  describe('binding trace steps record how each name resolved (§14)', () => {
    // The references' steps: a declaration's own write (mechanism `declare`) is left out.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
    const bindings = (report: any) =>
      report.findings.flatMap((finding: { occurrences: { mechanism: string; trace: { kind: string }[] }[] }) =>
        finding.occurrences
          .filter((occurrence) => occurrence.mechanism !== 'declare')
          .flatMap((occurrence) => occurrence.trace.filter((step) => step.kind === 'binding')),
      )
    const current = { realm: 'window', realmInstance: 'current' }

    test('a name with no declaration is a global, and window, self and globalThis are aliases of the global object', async () => {
      const { report } = await scan(classic('fetch = a\nself.setTimeout = b'))

      expect(bindings(report)).toEqual([
        { kind: 'binding', name: 'fetch', resolution: 'global', form: 'global-property', ...current, text: expect.any(String) },
        { kind: 'binding', name: 'self', resolution: 'alias', form: 'global-name', aliasOf: 'Window', ...current, text: expect.any(String) },
      ])
    })

    test('a name bound by a global declaration records the declaration: var, function or Annex B block function', async () => {
      const { report } = await scan(
        classic('var fetch;\nfetch = a\nfunction alert(){}\nalert = b\nif (c) { function open(){} }\nopen = d\nvar self; self.print = e'),
      )

      const declaration = (kind: string, start: number, end: number, line: number, column = 0) => ({
        kind,
        generated: { start, end, line, column },
      })
      expect(bindings(report)).toEqual([
        { kind: 'binding', name: 'alert', resolution: 'declaration', form: 'global-property', declaration: declaration('function', 21, 39, 3), ...current, text: expect.any(String) },
        { kind: 'binding', name: 'fetch', resolution: 'declaration', form: 'global-property', declaration: declaration('var', 0, 10, 1), ...current, text: expect.any(String) },
        { kind: 'binding', name: 'open', resolution: 'declaration', form: 'global-property', declaration: declaration('block-function', 59, 76, 5, 9), ...current, text: expect.any(String) },
        { kind: 'binding', name: 'self', resolution: 'declaration', form: 'global-name', aliasOf: 'Window', declaration: declaration('var', 88, 97, 7), ...current, text: expect.any(String) },
      ])
    })
  })
})

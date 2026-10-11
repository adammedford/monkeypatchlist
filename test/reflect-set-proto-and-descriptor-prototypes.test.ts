// Reflect.set __proto__ writes and descriptor prototypes (§3 Undecidable outcomes, Principle 1).
// `Reflect.set(T, '__proto__', p, R)` with a T known to be an ordinary object whose chain reaches
// `Object.prototype` runs `Object.prototype.__proto__`'s setter on R. A descriptor's `__proto__:` field whose value is
// a catalog holder is read through as ECMA-262 reads it, against the unmutated catalog. Every scenario goes through
// `monkeypatchlist scan --json`.

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
const lines = (...code: string[]) => code.join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

/**
 * Each finding's fingerprint, locks, mutation confidence level and reasons, and the mechanisms of its occurrences.
 */
const outcomes = (report: { findings: Finding[] }) =>
  report.findings.map(({ fingerprint, locks, confidence, occurrences }: Finding) => [
    fingerprint,
    locks,
    confidence.mutation.level,
    confidence.mutation.reasons ?? [],
    occurrences.map(({ mechanism }: Finding) => mechanism),
  ])

describe.each(resolvers)('Reflect.set __proto__ writes and descriptor prototypes, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  describe("Reflect.set(T, '__proto__', p, R) with an ordinary T runs Object.prototype.__proto__'s setter on R", () => {
    test.each([
      ["Reflect.set({}, '__proto__', X, Math)"],
      ["Reflect.set([], '__proto__', X, Math)"],
      ["Reflect.set(function(){}, '__proto__', X, Math)"],
    ])('%s is a set-prototype of Math, with no outcome-undecidable', async (code) => {
      const { report } = await scan(code)

      expect(outcomes(report)).toEqual([
        ['window|Math.[[Prototype]]|prototype-change|unknown', false, 'high', [], ['set-prototype']],
      ])
    })

    test('window has an immutable prototype, so the write gives no finding, as window.__proto__ = x gives none', async () => {
      const { report } = await scan(
        lines("Reflect.set({}, '__proto__', x, window)", "Reflect.set([], '__proto__', x, self)", 'window.__proto__ = x'),
      )

      expect(report.findings).toEqual([])
    })

    test('an unresolved T, or a literal that may have its own __proto__, is written as if it lacked it: nothing', async () => {
      // An own `__proto__` data property (a computed key, a spread) is what [[Set]] finds first; a literal with a
      // `__proto__:` prototype has another chain.
      const { report } = await scan(
        lines(
          "Reflect.set(o, '__proto__', p, Math)",
          "Reflect.set(o, '__proto__', p, window)",
          "Reflect.set({ ['__proto__']: 1 }, '__proto__', p, Math)",
          "Reflect.set({ ...a }, '__proto__', p, Math)",
          "Reflect.set({ [k]: 1 }, '__proto__', p, Math)",
          "Reflect.set({ __proto__: null }, '__proto__', p, Math)",
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('a literal with other own properties, or a native prototype, still reaches the setter, and the key may fold', async () => {
      const { report } = await scan(
        lines(
          "const K = '__proto__'",
          "Reflect.set({ a: 1, get b() { return 2 } }, K, X, Math)",
          "Reflect.set({ __proto__: Array.prototype }, '__proto__', X, JSON)",
          "Reflect.set({ __proto__: 5 }, '__proto__', X, Reflect)",
        ),
      )

      expect(outcomes(report)).toEqual([
        ['window|JSON.[[Prototype]]|prototype-change|unknown', false, 'high', [], ['set-prototype']],
        ['window|Math.[[Prototype]]|prototype-change|unknown', false, 'high', [], ['set-prototype']],
        ['window|Reflect.[[Prototype]]|prototype-change|unknown', false, 'high', [], ['set-prototype']],
      ])
    })
  })

  describe('a descriptor __proto__ field that holds a catalog holder is read through, against the unmutated catalog', () => {
    test('Object.prototype supplies no fields: { __proto__: Object.prototype, value: f } is { value: f }', async () => {
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'fetch', { __proto__: Object.prototype, value: f })",
          "Object.defineProperty(window, 'open', { __proto__: Object.prototype })",
        ),
      )

      expect(outcomes(report)).toEqual([['window|Window.fetch|replace|unknown', false, 'high', [], ['define-property']]])
    })

    test("a holder's callable get and set beside an own data field make ToPropertyDescriptor throw: nothing", async () => {
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'fetch', { __proto__: Map.prototype, value: f })",
          "Reflect.defineProperty(window, 'open', { __proto__: Reflect, writable: true })",
          "Object.defineProperties(window, { alert: { value: f }, stop: { __proto__: WeakMap.prototype, value: g } })",
        ),
      )

      expect(report.findings).toEqual([])
    })

    test("{ __proto__: Map.prototype } alone reads Map.prototype's get and set as its accessors: a descriptor-change", async () => {
      const { report } = await scan("Object.defineProperty(window, 'fetch', { __proto__: Map.prototype })")

      expect(outcomes(report)).toEqual([
        ['window|Window.fetch|descriptor-change|unknown', false, 'high', [], ['define-property']],
      ])
    })

    test("the holder may be reached through the global object, or another window's", async () => {
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'fetch', { __proto__: window.Object.prototype, value: f })",
          "Object.defineProperty(window, 'open', { __proto__: parent.Map.prototype, value: f })",
        ),
      )

      expect(outcomes(report)).toEqual([['window|Window.fetch|replace|unknown', false, 'high', [], ['define-property']]])
    })

    test('a platform singleton or the global object is read through the unmutated catalog too, and supplies no fields', async () => {
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'fetch', { __proto__: localStorage, value: f })",
          "Object.defineProperty(window, 'open', { __proto__: window, value: f })",
          "Object.defineProperty(window, 'alert', { __proto__: window })",
        ),
      )

      expect(outcomes(report)).toEqual([
        ['window|Window.fetch|replace|unknown', false, 'high', [], ['define-property']],
        ['window|Window.open|replace|unknown', false, 'high', [], ['define-property']],
      ])
    })

    test("a Web IDL attribute the holder supplies as a field runs its getter on the descriptor, which throws: nothing", async () => {
      // `Attr.prototype.value` is an attribute: ToPropertyDescriptor's Get runs its getter on the descriptor literal,
      // which is no Attr, so it throws (Principle 1). An own `value` shadows it, and a spread may give one.
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'fetch', { __proto__: Attr.prototype })",
          "Object.defineProperty(window, 'open', { __proto__: Attr.prototype, value: f })",
          "Object.defineProperty(window, 'alert', { __proto__: Attr.prototype, ...d })",
        ),
      )

      expect(outcomes(report)).toEqual([
        ['window|Window.alert|descriptor-change|unknown', 'unknown', 'medium', ['outcome-undecidable'], ['define-property']],
        ['window|Window.open|replace|unknown', false, 'high', [], ['define-property']],
      ])
    })

    test('a __proto__ value that does not resolve stays unseen, and { __proto__: null, value: f } stays a replace', async () => {
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'fetch', { __proto__: p })",
          "Object.defineProperty(window, 'open', { __proto__: null, value: f })",
        ),
      )

      expect(outcomes(report)).toEqual([
        ['window|Window.fetch|descriptor-change|unknown', 'unknown', 'medium', ['outcome-undecidable'], ['define-property']],
        ['window|Window.open|replace|unknown', false, 'high', [], ['define-property']],
      ])
    })
  })
})

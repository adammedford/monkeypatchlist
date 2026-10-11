// Descriptor alternatives with an unseen part, and `__proto__:` candidate splits (§3 Undecidable outcomes, §5
// Candidate sets, Principle 3). A descriptor that may be a seen heap object or a value the
// analyzer can't see gives one finding per effect: the seen object's own effect, with its own `locks`, plus a
// `descriptor-change` with `locks: unknown` for the unseen alternative, each `outcome-undecidable`. A `__proto__:` field
// with several candidate values splits one descriptor per candidate only when every candidate is a catalog holder.
// Every scenario goes through `monkeypatchlist scan --json`.

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

/** Each finding's fingerprint, locks and mutation confidence reasons. */
const outcomes = (report: { findings: Finding[] }) =>
  report.findings.map(({ fingerprint, locks, confidence }: Finding) => [fingerprint, locks, confidence.mutation.reasons ?? []])

describe.each(resolvers)('descriptor alternatives with an unseen part, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  describe('a descriptor that may be a seen heap object or an unseen value gives one finding per effect', () => {
    test.each([
      ['a || fallback', "var d = window.__cfg || { value: w, configurable: true }; Object.defineProperty(window, 'fetch', d)"],
      ['a ?: with an unresolved branch', "Object.defineProperty(window, 'fetch', c ? x : { value: w, configurable: true })"],
    ])('%s gives the seen replace with its own locks, and an unseen descriptor-change', async (_, code) => {
      const { report } = await scan(code)

      expect(outcomes(report)).toEqual([
        ['window|Window.fetch|descriptor-change|unknown', 'unknown', ['outcome-undecidable']],
        ['window|Window.fetch|replace|unknown', false, ['outcome-undecidable']],
      ])
    })

    test('the outcome-undecidable trace step names what the outcome depends on', async () => {
      const { report } = await scan("var d = window.__cfg || { value: w, configurable: true }; Object.defineProperty(window, 'fetch', d)")

      for (const finding of report.findings) {
        const kinds = finding.occurrences[0].trace.map((step: Finding) => step.kind)
        expect(kinds).toContain('confidence-reason')
      }
    })

    test('a seen alternative that gives a descriptor-change too merges with the unseen one, with locks unknown', async () => {
      const { report } = await scan(
        "var d = window.__cfg || { get: function () { return w }, configurable: true }; Object.defineProperty(window, 'fetch', d)",
      )

      expect(outcomes(report)).toEqual([['window|Window.fetch|descriptor-change|unknown', 'unknown', ['outcome-undecidable']]])
    })

    // A primitive alternative makes ToPropertyDescriptor throw, so it gives nothing (Principle 1); the seen object's
    // own effect stays, as an alternative (Principle 3).
    test('a primitive alternative gives nothing, and the seen object keeps its own effect', async () => {
      const { report } = await scan("Object.defineProperty(window, 'fetch', c ? undefined : { value: w, configurable: true })")

      expect(outcomes(report)).toEqual([['window|Window.fetch|replace|unknown', false, ['outcome-undecidable']]])
    })

    test('several seen heap objects with different effects are unchanged', async () => {
      const { report } = await scan(
        "let d = { value: w }; if (lazy) d = { get: () => w }; Object.defineProperty(window, 'fetch', d)",
      )

      expect(outcomes(report)).toEqual([
        ['window|Window.fetch|descriptor-change|unknown', false, ['outcome-undecidable']],
        ['window|Window.fetch|replace|unknown', false, ['outcome-undecidable']],
      ])
    })
  })

  describe('a __proto__: field with several candidates splits per candidate only when every one is a catalog holder', () => {
    test("Map.prototype's branch throws in ToPropertyDescriptor, so only Object.prototype's replace stays", async () => {
      const { report } = await scan(
        "Object.defineProperty(window, 'fetch', { __proto__: c ? Map.prototype : Object.prototype, value: f })",
      )

      expect(outcomes(report)).toEqual([['window|Window.fetch|replace|unknown', false, ['outcome-undecidable']]])
    })

    test('candidates with different effects give one finding per effect', async () => {
      const { report } = await scan("Object.defineProperty(window, 'fetch', { __proto__: c ? Map.prototype : Object.prototype })")

      // Map.prototype supplies callable get and set (a descriptor-change); Object.prototype supplies nothing.
      expect(outcomes(report)).toEqual([['window|Window.fetch|descriptor-change|unknown', false, ['outcome-undecidable']]])
    })

    test('candidates that are one holder reached twice read through as that holder', async () => {
      const { report } = await scan(
        "Object.defineProperty(window, 'fetch', { __proto__: c ? Object.prototype : window.Object.prototype, value: f })",
      )

      expect(outcomes(report)).toEqual([['window|Window.fetch|replace|unknown', false, []]])
    })

    // A candidate set that includes an unknown value stays unseen, read like a lone unresolved `__proto__:` value:
    // a replace with locks unknown when an own `value` follows every unseen part, a descriptor-change otherwise.
    test.each([
      ['with an own value after it', '{ __proto__: c ? Object.prototype : x, value: f }', '{ __proto__: p, value: f }', [
        ['window|Window.fetch|replace|unknown', 'unknown', ['outcome-undecidable']],
      ]],
      ['without an own value', '{ __proto__: c ? Object.prototype : x }', '{ __proto__: p }', [
        ['window|Window.fetch|descriptor-change|unknown', 'unknown', ['outcome-undecidable']],
      ]],
    ])('a candidate set with an unknown value, %s, reads like a lone unresolved value', async (_, mixed, lone, expected) => {
      const { report } = await scan(`Object.defineProperty(window, 'fetch', ${mixed})`)
      const { report: loneReport } = await scan(`Object.defineProperty(window, 'fetch', ${lone})`)

      expect(outcomes(report)).toEqual(expected)
      expect(outcomes(loneReport)).toEqual(expected)
    })
  })
})

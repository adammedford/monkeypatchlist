// Constants, string folding and computed properties (§5 Resolver capabilities 1, §14): a computed key names the member
// its constant value names, whether the key is a string fold, a template literal with constant parts, or a `const`
// (destructured or not) whose value is constant. Each fold is a `fold` trace step. Every scenario goes through
// `monkeypatchlist scan --json`. Aliases of holders and wildcards have tests of their own.

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

const fingerprints = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.fingerprint)

/** The trace of a finding's only occurrence. */
const traceOf = (finding: Finding): { kind: string; [field: string]: unknown }[] => {
  expect(finding.occurrences).toHaveLength(1)
  return finding.occurrences[0].trace
}

describe.each(resolvers)('constants and folding, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  describe('string folds', () => {
    test('EventTarget.prototype["add" + "EventListener"] = w gives EventTarget.prototype.addEventListener, with a fold', async () => {
      const { report } = await scan('EventTarget.prototype["add" + "EventListener"] = w')

      expect(fingerprints(report)).toEqual(['window|EventTarget.prototype.addEventListener|replace|unknown'])
      const trace = traceOf(report.findings[0])
      expect(trace.map((step) => step.kind)).toEqual(['binding', 'fold'])
      expect(trace[1]).toMatchObject({
        kind: 'fold',
        expression: '"add" + "EventListener"',
        value: 'addEventListener',
        generated: { start: 22, end: 45, line: 1, column: 22 },
      })
      expect(trace[1]).not.toHaveProperty('name')
    })

    test('a chain of + is one fold, and numbers and booleans fold into it as JavaScript converts them', async () => {
      const { report } = await scan(lines('Array.prototype["a" + "t" + "Index" + 1 + !0] = f'))

      expect(fingerprints(report)).toEqual(['window|Array.prototype.atIndex1true|add|unknown'])
      const folds = traceOf(report.findings[0]).filter((step) => step.kind === 'fold')
      expect(folds).toMatchObject([{ expression: '"a" + "t" + "Index" + 1 + !0', value: 'atIndex1true' }])
    })
  })

  describe('constants', () => {
    test('proto[method] with const method = "add" + "EventListener" names EventTarget.prototype.addEventListener', async () => {
      const { report } = await scan(lines('const method = "add" + "EventListener"', 'EventTarget.prototype[method] = w'))

      expect(fingerprints(report)).toEqual(['window|EventTarget.prototype.addEventListener|replace|unknown'])
      const trace = traceOf(report.findings[0])
      expect(trace.map((step) => step.kind)).toEqual(['binding', 'fold'])
      expect(trace[1]).toMatchObject({
        name: 'method',
        expression: '"add" + "EventListener"',
        value: 'addEventListener',
        generated: { line: 1, column: 15 },
      })
    })

    test('a constant read through another constant gives a fold for each, the one it reads first', async () => {
      const { report } = await scan(lines('const a = "add"', "const m = a + 'EventListener'", 'EventTarget.prototype[m] = w'))

      expect(fingerprints(report)).toEqual(['window|EventTarget.prototype.addEventListener|replace|unknown'])
      const folds = traceOf(report.findings[0]).filter((step) => step.kind === 'fold')
      expect(folds).toMatchObject([
        { name: 'a', expression: '"add"', value: 'add' },
        { name: 'm', expression: 'a + "EventListener"', value: 'addEventListener' },
      ])
    })

    test('template literals with constant parts fold', async () => {
      const { report } = await scan(
        lines('const verb = "add"', 'EventTarget.prototype[`${verb}EventListener`] = w', 'const s = `se${"n"}d`', 'XMLHttpRequest.prototype[s] = w'),
      )

      expect(fingerprints(report)).toEqual([
        'window|EventTarget.prototype.addEventListener|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
      ])
      expect(report.findings[0].occurrences[0].trace.filter((step: { kind: string }) => step.kind === 'fold')).toMatchObject([
        { name: 'verb', value: 'add' },
        { expression: '`${verb}EventListener`', value: 'addEventListener' },
      ])
      expect(report.findings[1].occurrences[0].trace.filter((step: { kind: string }) => step.kind === 'fold')).toMatchObject([
        { name: 's', expression: '`se${"n"}d`', value: 'send' },
      ])
    })

    test('destructured constants: const [a, b] = ["open", "send"]', async () => {
      const { report } = await scan(
        lines('const [a, b] = ["open", "send"]', 'XMLHttpRequest.prototype[a] = w', 'XMLHttpRequest.prototype[b] = w'),
      )

      expect(fingerprints(report)).toEqual([
        'window|XMLHttpRequest.prototype.open|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
      ])
      expect(report.findings[1].occurrences[0].trace.filter((step: { kind: string }) => step.kind === 'fold')).toMatchObject([
        { name: 'b', expression: '"send"', value: 'send', generated: { line: 1, column: 24 } },
      ])
    })

    test('object patterns, nested patterns and defaults destructure too', async () => {
      const { report } = await scan(
        lines(
          'const { m: open, n: [, send] } = { m: "open", n: ["x", "send"] }',
          'const { k = "abort", q: { r: getAll = "no" } = { r: "getAllResponseHeaders" } } = {}',
          'XMLHttpRequest.prototype[open] = w',
          'XMLHttpRequest.prototype[send] = w',
          'XMLHttpRequest.prototype[k] = w',
          'XMLHttpRequest.prototype[getAll] = w',
        ),
      )

      // The top-level `const open` itself hides `Window.open` (§3 Declarations in classic scripts).
      expect(fingerprints(report)).toEqual([
        'window|Window.open|replace|unknown',
        'window|XMLHttpRequest.prototype.abort|replace|unknown',
        'window|XMLHttpRequest.prototype.getAllResponseHeaders|replace|unknown',
        'window|XMLHttpRequest.prototype.open|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
      ])
      expect(report.findings[1].occurrences[0].trace.filter((step: { kind: string }) => step.kind === 'fold')).toMatchObject([
        { name: 'k', expression: '"abort"', value: 'abort', generated: { line: 2, column: 12 } },
      ])
    })

    test('a later definition of a key in the literal wins, and a key the literal lacks is undefined', async () => {
      const { report } = await scan(
        lines(
          'const { a } = { a: "open", a: "send" }',
          'const { b = "abort" } = { c: "open" }',
          'XMLHttpRequest.prototype[a] = w',
          'XMLHttpRequest.prototype[b] = w',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|XMLHttpRequest.prototype.abort|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
      ])
    })
  })

  describe('a key that is not constant gives no finding', () => {
    test.each([
      ['a parameter', 'function f(m) { XMLHttpRequest.prototype[m] = w }'],
      ['a free name', 'XMLHttpRequest.prototype[method] = w'],
      ['a constant from a call', 'const m = pick(); XMLHttpRequest.prototype[m] = w'],
      ['a fold with an unknown part', 'const m = "se" + x; XMLHttpRequest.prototype[m] = w; XMLHttpRequest.prototype[`${x}nd`] = w'],
      ['a rest element', 'const [...m] = ["send"]; XMLHttpRequest.prototype[m] = w'],
      ['an element after a spread', 'const [m] = [...xs, "send"]; XMLHttpRequest.prototype[m] = w'],
      ['a property after a spread', 'const { m } = { m: "send", ...o }; XMLHttpRequest.prototype[m] = w'],
      ['a property from a getter', 'const { m } = { get m() { return "send" } }; XMLHttpRequest.prototype[m] = w'],
      ['a constant that reads itself', 'const m = m + "send"; XMLHttpRequest.prototype[m] = w'],
      ['a constant from a destructured non-literal', 'const [m] = names; const { n } = names; XMLHttpRequest.prototype[m] = w; XMLHttpRequest.prototype[n] = w'],
    ])('%s', async (_, code) => {
      const { report } = await scan(code)

      expect(fingerprints(report)).toEqual([])
    })
  })

  describe('a constant with two values is a candidate set', () => {
    test('a default beside a property an object inherits is a candidate, the inherited value unknown (§5)', async () => {
      // A catalog function read is unknown beside wrap evidence (§5 Resolver capabilities 10), so the default may apply.
      const { report } = await scan('const { toString: m = "send" } = {}; XMLHttpRequest.prototype[m] = w')

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
      expect(report.findings[0].confidence.target.reasons).toEqual(['member-alternatives'])
    })

    test('const m = c ? "open" : "send"; XMLHttpRequest.prototype[m] = w gives both, with member-alternatives', async () => {
      const { report } = await scan('const m = c ? "open" : "send"; XMLHttpRequest.prototype[m] = w')

      expect(fingerprints(report)).toEqual([
        'window|XMLHttpRequest.prototype.open|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
      ])
    })
  })

  describe('scope', () => {
    test('the constant a name resolves to is the one in scope, and a parameter or inner declaration shadows it', async () => {
      const { report } = await scan(
        lines(
          'const m = "open"',
          'function f(m) { XMLHttpRequest.prototype[m] = w }',
          'function g() { const m = "send"; XMLHttpRequest.prototype[m] = w }',
          '{ const m = "abort"; XMLHttpRequest.prototype[m] = w }',
          'XMLHttpRequest.prototype[m] = w',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|XMLHttpRequest.prototype.abort|replace|unknown',
        'window|XMLHttpRequest.prototype.open|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
      ])
    })

    test("a module's exported constant folds where the module reads it", async () => {
      const files = {
        'index.html': '<script type="module" src="main.js"></script>',
        'main.js': lines('export const m = "se" + "nd"', 'XMLHttpRequest.prototype[m] = w'),
      }
      const { report } = await scanBuild(files, [], { deps: { resolver } })

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
    })

    test('a function reads a constant declared after it, which always has its value when read', async () => {
      const { report } = await scan(lines('function f() { XMLHttpRequest.prototype[m] = w }', 'const m = "send"', 'f()'))

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
    })

    test('an Annex B function hoisted over the constant hides it (§5 post-pass 2)', async () => {
      const { report } = await scan(
        lines('const m = "send"', 'function f() {', '  { function m() {} }', '  XMLHttpRequest.prototype[m] = w', '}'),
      )

      expect(fingerprints(report)).toEqual([])
    })

    test('a with block between the name and its constant lowers target confidence (§5 post-pass 3)', async () => {
      const { report } = await scan(lines('const m = "send"', 'with (o) { XMLHttpRequest.prototype[m] = w }'))

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.confidence.target).toEqual({ level: 'low', reasons: ['with-scope'] })
      expect(occurrence.trace.map((step: { kind: string }) => step.kind)).toEqual([
        'binding',
        'confidence-reason',
        'fold',
        'confidence-reason',
        // The taint makes reachability `unknown` (§7).
        'guard',
      ])
      expect(occurrence.trace[3]).toMatchObject({ reason: 'with-scope', name: 'm', sites: [{ line: 2, column: 0 }] })
    })

    test('a with block around the constant is not on its path', async () => {
      const { report } = await scan(lines('with (o) { const m = "send"; window.XMLHttpRequest.prototype[m] = w }'))

      const [occurrence] = report.findings[0].occurrences
      const tainted = occurrence.trace.filter((step: { kind: string; name?: string }) => step.name === 'm' && step.kind !== 'fold')
      expect(tainted).toEqual([])
    })

    test('a direct eval in a sloppy function between the name and its constant lowers target confidence', async () => {
      const { report } = await scan(lines('const m = "send"', 'function f(s) { eval(s); XMLHttpRequest.prototype[m] = w }'))

      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.confidence.target.reasons).toContain('direct-eval-scope')
      expect(occurrence.trace.filter((step: { kind: string }) => step.kind === 'confidence-reason')).toContainEqual(
        expect.objectContaining({ reason: 'direct-eval-scope', name: 'm' }),
      )
    })
  })

  describe('computed properties on the way to the holder', () => {
    test('a computed key that folds reads the member it names, as the dot form does', async () => {
      const { report } = await scan(
        lines(
          'const ctor = "XML" + "HttpRequest"',
          'window[ctor]["proto" + "type"].send = w',
          'Object.setPrototypeOf(self["local" + "Storage"], X)',
          'window[`par${"ent"}`].fetch = w',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.fetch|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
        'window|localStorage.[[Prototype]]|prototype-change|unknown',
      ])
      const send = report.findings[1].occurrences[0]
      expect(send.trace.map((step: { kind: string }) => step.kind)).toEqual(['binding', 'fold', 'fold'])
      expect(send.trace.filter((step: { kind: string }) => step.kind === 'fold')).toMatchObject([
        { name: 'ctor', expression: '"XML" + "HttpRequest"', value: 'XMLHttpRequest' },
        { expression: '"proto" + "type"', value: 'prototype' },
      ])
      const fetch = report.findings[0].occurrences[0]
      expect(fetch.realmInstance).toBe('other')
    })

    test('a constant index on a window is a child window', async () => {
      const { report } = await scan(lines('const i = 0', 'frames[i].fetch = w'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.realmInstance).toBe('other')
      expect(occurrence.trace).toContainEqual(expect.objectContaining({ kind: 'binding', name: '[0]', form: 'other-window' }))
      expect(occurrence.trace).toContainEqual(expect.objectContaining({ kind: 'fold', name: 'i', value: 0 }))
    })

    test('Function("return " + "this")() is the global object', async () => {
      const { report } = await scan('Function("return " + "this")().fetch = w')

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(report.findings[0].occurrences[0].trace).toContainEqual(
        expect.objectContaining({ kind: 'fold', expression: '"return " + "this"', value: 'return this' }),
      )
    })

    test('Function reached through a computed key is an indirect call, whose code is not analyzed (§2)', async () => {
      const { report } = await scan('window["Function"]("return this")().fetch = w')

      expect(fingerprints(report)).toEqual([])
    })
  })

  describe('constants that decide a value', () => {
    test('a constant test that picks a holder gives its fold, and a with block on its path lowers target confidence', async () => {
      const { report } = await scan(
        lines(
          'const on = !0;',
          '(on ? EventTarget.prototype : XMLHttpRequest.prototype).addEventListener = w;',
          '(on && XMLHttpRequest.prototype).send = w;',
          'with (o) { (on ? Node.prototype : Element.prototype).appendChild = w }',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|EventTarget.prototype.addEventListener|replace|unknown',
        'window|Node.prototype.appendChild|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
      ])
      for (const finding of report.findings) {
        expect(finding.occurrences[0].trace).toContainEqual(expect.objectContaining({ kind: 'fold', name: 'on', value: true }))
      }
      const [inWith] = report.findings[1].occurrences
      expect(inWith.confidence.target.reasons).toEqual(['with-scope'])
      expect(inWith.trace).toContainEqual(expect.objectContaining({ kind: 'confidence-reason', reason: 'with-scope', name: 'on' }))
    })

    test('!, typeof and comparisons carry the folds of what they read', async () => {
      const { report } = await scan(
        lines(
          'const mode = "a" + "b", yes = "y";',
          '(mode === "ab" ? window : x).fetch = w;',
          'Object.defineProperty(window, "alert", { value: window.alert, writable: !yes });',
          '(typeof yes == "string" ? window : x).open = w',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|descriptor-change|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
      ])
      const foldsOf = (index: number) =>
        report.findings[index].occurrences[0].trace.filter((step: { kind: string }) => step.kind === 'fold')
      expect(foldsOf(0)).toMatchObject([{ name: 'yes', value: 'y' }])
      expect(foldsOf(1)).toMatchObject([{ name: 'mode', expression: '"a" + "b"', value: 'ab' }])
      expect(foldsOf(2)).toMatchObject([{ name: 'yes', value: 'y' }])
    })

    test('a constant JSON cannot carry has no fold step, but its taint still lowers target confidence', async () => {
      const { report } = await scan(
        lines('const u = void 0', 'with (o) { Object.defineProperty(window, "fetch", { value: window.fetch, writable: u }) }'),
      )

      expect(fingerprints(report)).toEqual(['window|Window.fetch|descriptor-change|unknown'])
      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.trace.filter((step: { kind: string }) => step.kind === 'fold')).toEqual([])
      expect(occurrence.trace).toContainEqual(expect.objectContaining({ kind: 'confidence-reason', reason: 'with-scope', name: 'u' }))
    })
  })

  describe('every mechanism takes a folded key', () => {
    test.each([
      ['define-property', 'Object.defineProperty(window, k, { value: f })'],
      ['reflect-define', 'Reflect.defineProperty(window, k, { value: f })'],
      ['define-properties', 'Object.defineProperties(window, { [k]: { value: f } })'],
      ['bulk-assign', 'Object.assign(window, { [k]: f })'],
      ['assign', 'window[k] = f'],
    ])('%s', async (mechanism, code) => {
      const { report } = await scan(lines('const k = "fe" + "tch"', code))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.mechanism).toBe(mechanism)
      expect(occurrence.trace.filter((step: { kind: string }) => step.kind === 'fold')).toMatchObject([
        { name: 'k', value: 'fetch' },
      ])
    })

    test('delete', async () => {
      const { report } = await scan(lines('const k = `fe${"tch"}`', 'delete window[k]'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|delete|unknown'])
    })

    test('a native writer reached through a folded key', async () => {
      const { report } = await scan('Object["define" + "Property"](window, "fetch", { value: f })')

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(report.findings[0].occurrences[0].trace.filter((step: { kind: string }) => step.kind === 'fold')).toMatchObject([
        { expression: '"define" + "Property"', value: 'defineProperty' },
      ])
    })

    test("a descriptor's attributes and field names fold", async () => {
      const { report } = await scan(
        lines(
          'const no = !1, field = "writ" + "able"',
          'Object.defineProperty(window, "fetch", { value: window.fetch, [field]: no })',
        ),
      )

      expect(fingerprints(report)).toEqual(['window|Window.fetch|descriptor-change|unknown'])
      expect(report.findings[0].occurrences[0].trace.filter((step: { kind: string }) => step.kind === 'fold')).toMatchObject([
        { name: 'field', value: 'writable' },
        { name: 'no', expression: '!1', value: false },
      ])
    })

    test('writing back what a folded key reads changes nothing', async () => {
      const { report } = await scan(lines('const k = "fe" + "tch"', 'window[k] = window.fetch', 'window.fetch = window[k]'))

      expect(fingerprints(report)).toEqual([])
    })
  })

  describe('nested code', () => {
    test('constants fold in code a literal eval runs, and the trace prints the nested code', async () => {
      const { report } = await scan(`eval('const k = "add" + "EventListener"; EventTarget.prototype[k] = w')`)

      expect(fingerprints(report)).toEqual(['window|EventTarget.prototype.addEventListener|replace|unknown'])
      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.trace.filter((step: { kind: string }) => step.kind === 'fold')).toMatchObject([
        { name: 'k', expression: '"add" + "EventListener"', value: 'addEventListener', generated: { line: 1, column: 16 } },
      ])
    })
  })

  describe('code strings (§2)', () => {
    test('a timer given a constant string compiles code that is not a string literal: a dynamic-code limitation', async () => {
      const { report } = await scan(lines('const code = "tick()"', 'setTimeout(code, 10)'))

      expect(report.completeness.limitations.map((limitation: { kind: string }) => limitation.kind)).toEqual(['dynamic-code'])
    })

    test('eval of a constant that is no string runs no code', async () => {
      const { report } = await scan(lines('const n = 5', 'eval(n)'))

      expect(report.completeness.limitations).toEqual([])
    })
  })

  describe('limits', () => {
    test('a fold longer than the fold-length cap is unknown, and the cap is counted (§18)', async () => {
      const doubling = Array.from({ length: 22 }, (_, i) => `const s${i + 1} = s${i} + s${i}`)
      const { report } = await scan(lines('const s0 = "x"', ...doubling, 'Array.prototype[s22] = f', 'Array.prototype[s1] = f'))

      expect(fingerprints(report)).toEqual(['window|Array.prototype.xx|add|unknown'])
      expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
    })

    test('a constant read through 1000 constants resolves, whatever was read before it (no depth limit)', async () => {
      // c0 is "x", and each constant adds a "y".
      const chain = ['const c0 = "x"', ...Array.from({ length: 1000 }, (_, i) => `const c${i + 1} = c${i} + "y"`)]
      const orders = [
        ['Array.prototype[c100] = f', 'Array.prototype[c99] = f', 'Array.prototype[c1000] = f'],
        ['Array.prototype[c1000] = f', 'Array.prototype[c99] = f', 'Array.prototype[c100] = f'],
      ]
      const add = (ys: number) => `window|Array.prototype.x${'y'.repeat(ys)}|add|unknown`
      for (const writes of orders) {
        const { report } = await scan(lines(...chain, ...writes))

        expect(fingerprints(report).toSorted()).toEqual([add(99), add(100), add(1000)].toSorted())
        // Nothing is cut: constants past 64 deep only wait, which the nesting cap counts.
        expect(Object.keys(report.completeness.counters.statistics.caps)).toEqual(['nesting'])
      }
    })

    test('a chain of computed reads with two-valued keys is evaluated once per read', async () => {
      // Each key has two values, so evaluating the object once per value would take 2^40 steps.
      const reads = Array.from({ length: 40 }, (_, i) => `[c${i} ? "a" : "b"]`).join('')
      const { report } = await scan(`window${reads}.fetch = w`)

      expect(fingerprints(report)).toEqual([])
    })

    test('a long expression is cut in the trace', async () => {
      const parts = Array.from({ length: 40 }, (_, i) => `"p${i}"`).join(' + ')
      const { report } = await scan(`Array.prototype[${parts}] = f`)

      const [fold] = report.findings[0].occurrences[0].trace.filter((step: { kind: string }) => step.kind === 'fold')
      expect(fold.expression).toHaveLength(120)
      expect(fold.expression.endsWith('…')).toBe(true)
    })
  })

  test('the report is byte-identical across runs', async () => {
    const code = lines(
      'const [a, b] = ["open", "send"], { c = "abort" } = {}',
      'const m = "add" + "EventListener"',
      'EventTarget.prototype[m] = w',
      'XMLHttpRequest.prototype[a] = w; XMLHttpRequest.prototype[`${b}`] = w; XMLHttpRequest.prototype[c] = w',
      'with (o) { window["fe" + "tch"] = w }',
    )
    const first = await scan(code)
    const second = await scan(code)

    const withoutRun = (text: string) => JSON.stringify({ ...JSON.parse(text), run: undefined })
    expect(withoutRun(first.stdout)).toBe(withoutRun(second.stdout))
    expect(first.report.findings).toHaveLength(5)
  })
})

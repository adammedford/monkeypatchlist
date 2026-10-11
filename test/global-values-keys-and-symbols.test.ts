// Constant folding beyond literals and constants (§4 Property keys, §5 Resolver capabilities 1, §13 `analysis-budget`, §18): the free
// global values `undefined`, `NaN` and `Infinity` fold to their values; every constant key goes through ToPropertyKey;
// a well-known symbol read from the real `Symbol` holder is a constant that names the catalog's `@@` member; a string
// key never names one, and gets the escaped spelling; `const` chains have no depth limit; a `fold-length` hit raises
// `analysis-budget`; and the alternatives cap never drops a native holder. Every scenario goes through
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
type Step = { kind: string; [field: string]: unknown }

const fingerprints = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.fingerprint)

/** The trace of a finding's only occurrence. */
const traceOf = (finding: Finding): Step[] => {
  expect(finding.occurrences).toHaveLength(1)
  return finding.occurrences[0].trace
}

describe.each(resolvers)('global values, property keys and symbols, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  describe('free undefined, NaN and Infinity fold to their values', () => {
    test('Object.setPrototypeOf(h, undefined) gives nothing, as a prototype that is no object or null changes nothing', async () => {
      const { report } = await scan(
        lines(
          'Object.setPrototypeOf(XMLHttpRequest.prototype, undefined)',
          'Object.setPrototypeOf(Storage.prototype, NaN)',
          'Reflect.setPrototypeOf(Node.prototype, Infinity)',
        ),
      )

      expect(fingerprints(report)).toEqual([])
    })

    test('a descriptor attribute written as undefined or NaN reads as false', async () => {
      const { report } = await scan(
        lines(
          'Object.defineProperty(window, "fetch", { value: window.fetch, configurable: undefined })',
          'Object.defineProperty(window, "alert", { value: window.alert, writable: NaN })',
          'Object.defineProperty(window, "open", { value: window.open, enumerable: Infinity })',
          'Object.defineProperty(window, "close", { value: window.close, configurable: !undefined })',
        ),
      )

      // Window.open is enumerable, so an enumerable Infinity changes nothing, and nor does a configurable true.
      expect(fingerprints(report)).toEqual([
        'window|Window.alert|descriptor-change|unknown',
        'window|Window.fetch|descriptor-change|unknown',
      ])
      expect(traceOf(report.findings[1]).map((step) => step.kind)).toEqual(['binding', 'binding'])
    })

    test('x === undefined decides a branch', async () => {
      const { report } = await scan(
        lines(
          '(window === undefined ? XMLHttpRequest.prototype : EventTarget.prototype).addEventListener = w;',
          'const u = void 0;',
          '(u === undefined ? XMLHttpRequest.prototype : EventTarget.prototype).open = w;',
          '(typeof NaN == "number" && Infinity > 1 ? Node.prototype : Element.prototype).appendChild = w',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|EventTarget.prototype.addEventListener|replace|unknown',
        'window|Node.prototype.appendChild|replace|unknown',
        'window|XMLHttpRequest.prototype.open|replace|unknown',
      ])
    })

    test('a name that resolves to a declaration does not fold', async () => {
      const { report } = await scan(
        lines(
          'function f(undefined) { Object.setPrototypeOf(XMLHttpRequest.prototype, undefined) }',
          'function g() { var NaN = p; Object.defineProperty(window, "fetch", { value: window.fetch, writable: NaN }) }',
        ),
      )

      // The prototype may be an object. The attribute is unknown, so the define is a descriptor-change whose outcome
      // can't be decided (§3 Undecidable outcomes): a folded NaN would be a plain `writable: false`.
      expect(fingerprints(report)).toEqual([
        'window|Window.fetch|descriptor-change|unknown',
        'window|XMLHttpRequest.prototype.[[Prototype]]|prototype-change|unknown',
      ])
      expect(report.findings[0].confidence.mutation.reasons).toEqual(['outcome-undecidable'])
    })

    test('a with block on the path keeps its taint, with no fold step', async () => {
      const { report } = await scan(
        'with (o) { Object.defineProperty(window, "fetch", { value: window.fetch, configurable: undefined }) }',
      )

      expect(fingerprints(report)).toEqual(['window|Window.fetch|descriptor-change|unknown'])
      const trace = traceOf(report.findings[0])
      expect(trace.filter((step) => step.kind === 'fold')).toEqual([])
      expect(trace).toContainEqual(expect.objectContaining({ kind: 'confidence-reason', reason: 'with-scope', name: 'undefined' }))
      expect(report.findings[0].occurrences[0].confidence.target.reasons).toEqual(['with-scope'])
    })
  })

  describe('a well-known symbol names the catalog @@ member (§4 Property keys)', () => {
    test('Array.prototype[Symbol.iterator] = f gives Array.prototype.@@iterator, with the Symbol binding and a fold', async () => {
      const { report } = await scan('Array.prototype[Symbol.iterator] = f')

      expect(fingerprints(report)).toEqual(['window|Array.prototype.@@iterator|replace|unknown'])
      const trace = traceOf(report.findings[0])
      expect(trace.map((step) => step.kind)).toEqual(['binding', 'binding', 'fold'])
      expect(trace[1]).toMatchObject({ kind: 'binding', name: 'Symbol', resolution: 'global', holds: 'Symbol' })
      expect(trace[2]).toMatchObject({
        kind: 'fold',
        expression: 'Symbol.iterator',
        symbol: '@@iterator',
        generated: { line: 1, column: 16 },
      })
      expect(trace[2]).not.toHaveProperty('value')
    })

    test('every mechanism takes a symbol key, and a symbol member no holder has is an add', async () => {
      const { report } = await scan(
        lines(
          'Object.defineProperty(Array.prototype, Symbol.unscopables, { value: u })',
          'Object.assign(Array.prototype, { [Symbol.isConcatSpreadable]: true })',
          'delete Map.prototype[Symbol.toStringTag]',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Array.prototype.@@isConcatSpreadable|add|unknown',
        'window|Array.prototype.@@unscopables|replace|unknown',
        'window|Map.prototype.@@toStringTag|delete|unknown',
      ])
    })

    test('the symbol counts however the real Symbol holder is reached', async () => {
      const { report } = await scan(
        lines(
          'Array.prototype[window.Symbol.iterator] = f',
          'Set.prototype[globalThis.Symbol["iterator"]] = f',
          'Map.prototype[parent.Symbol.iterator] = f',
          'String.prototype[self["Sym" + "bol"].iterator] = f',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Array.prototype.@@iterator|replace|unknown',
        'window|Map.prototype.@@iterator|replace|unknown',
        'window|Set.prototype.@@iterator|replace|unknown',
        'window|String.prototype.@@iterator|replace|unknown',
      ])
      // The holder written is this window's: another window's Symbol gives the same symbol (ECMA-262 well-known symbols).
      expect(report.findings[1].occurrences[0].realmInstance).toBe('current')
      expect(traceOf(report.findings[1])).toContainEqual(expect.objectContaining({ kind: 'binding', name: 'parent', form: 'other-window' }))
    })

    test('the symbol is a constant that flows like other constants', async () => {
      const { report } = await scan(
        lines(
          'const it = Symbol.iterator',
          'Array.prototype[it] = f',
          'const [un] = [Symbol.unscopables], { tag = Symbol.toStringTag } = {}',
          // Both are non-writable, so an assignment would change nothing.
          'Object.defineProperty(Array.prototype, un, { value: u })',
          'delete Map.prototype[tag]',
          'const on = !0, ai = on ? Symbol.asyncIterator : x',
          'Array.prototype[ai] = g;',
          '(typeof it == "symbol" ? Node.prototype : Element.prototype).appendChild = w',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Array.prototype.@@asyncIterator|add|unknown',
        'window|Array.prototype.@@iterator|replace|unknown',
        'window|Array.prototype.@@unscopables|replace|unknown',
        'window|Map.prototype.@@toStringTag|delete|unknown',
        'window|Node.prototype.appendChild|replace|unknown',
      ])
      const iterator = traceOf(report.findings[1])
      expect(iterator.map((step) => step.kind)).toEqual(['binding', 'binding', 'fold'])
      expect(iterator[2]).toMatchObject({ kind: 'fold', name: 'it', expression: 'Symbol.iterator', symbol: '@@iterator' })
    })

    test('writing back what a symbol key reads changes nothing', async () => {
      const { report } = await scan(lines('const it = Symbol.iterator', 'Array.prototype[Symbol.iterator] = Array.prototype[it]'))

      expect(fingerprints(report)).toEqual([])
    })

    test('a symbol key in a literal destructures', async () => {
      const { report } = await scan(
        lines('const { [Symbol.iterator]: m, a } = { a: "x", [Symbol.iterator]: "values" }', 'Array.prototype[m] = f'),
      )

      expect(fingerprints(report)).toEqual(['window|Array.prototype.values|replace|unknown'])
    })

    test('a with block on the path to Symbol lowers target confidence', async () => {
      const { report } = await scan('with (o) { Array.prototype[Symbol.iterator] = f }')

      expect(fingerprints(report)).toEqual(['window|Array.prototype.@@iterator|replace|unknown'])
      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.confidence.target.reasons).toEqual(['with-scope'])
      expect(occurrence.trace).toContainEqual(expect.objectContaining({ kind: 'confidence-reason', reason: 'with-scope', name: 'Symbol' }))
    })

    test('a worker names the same @@ member on its own realm', async () => {
      const files = {
        'index.html': '<script src="main.js"></script>',
        'main.js': 'new Worker("/w.js")',
        'w.js': 'Array.prototype[self.Symbol.iterator] = f; Object.setPrototypeOf(Array.prototype, undefined)',
      }
      const { report } = await scanBuild(files, [], { deps: { resolver } })

      expect(fingerprints(report)).toEqual(['dedicated-worker|Array.prototype.@@iterator|replace|unknown'])
    })

    test('Symbol() and Symbol.for() keys, and other members of Symbol, stay unknown', async () => {
      const { report } = await scan(
        lines(
          'Array.prototype[Symbol()] = f',
          'Array.prototype[Symbol("iterator")] = f',
          'Array.prototype[Symbol.for("iterator")] = f',
          'Array.prototype[Symbol.for] = f',
          'Array.prototype[Symbol.prototype] = f',
          'Array.prototype[Symbol.notWellKnown] = f',
          'function g(Symbol) { Array.prototype[Symbol.iterator] = f }',
        ),
      )

      expect(fingerprints(report)).toEqual([])
    })

    test('a symbol is no string: + and templates with one throw, so they are unknown', async () => {
      const { report } = await scan(lines('Array.prototype["a" + Symbol.iterator] = f', 'Array.prototype[`${Symbol.iterator}`] = f'))

      expect(fingerprints(report)).toEqual([])
    })
  })

  describe('a string key never spells another target (§4 Property keys)', () => {
    test('X.prototype["@@toStringTag"] = v is the string-keyed member, not the symbol member', async () => {
      const { report } = await scan(
        lines(
          'Map.prototype["@@toStringTag"] = v',
          'const k = "@@" + "iterator"',
          'Array.prototype[k] = f',
          'Object.defineProperty(Array.prototype, "@@unscopables", { value: u })',
          'delete Array.prototype["@@iterator"]',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Array.prototype["@@iterator"]|add|unknown',
        'window|Array.prototype["@@unscopables"]|add|unknown',
        'window|Map.prototype["@@toStringTag"]|add|unknown',
      ])
      expect(report.findings.map((finding: Finding) => finding.target)).toEqual([
        { realm: 'window', holder: 'prototype', name: 'Array.prototype["@@iterator"]' },
        { realm: 'window', holder: 'prototype', name: 'Array.prototype["@@unscopables"]' },
        { realm: 'window', holder: 'prototype', name: 'Map.prototype["@@toStringTag"]' },
      ])
      expect(report.findings.map((finding: Finding) => finding.surface)).toEqual(['ECMAScript', 'ECMAScript', 'ECMAScript'])
    })

    test('a key with a dot, a bracket, a quote, a backslash or a control character, or ending in *, is written in JSON-quoted brackets', async () => {
      const { report } = await scan(
        lines(
          'Array["prototype.map"] = f',
          'console["*"] = f',
          'console["log*"] = f',
          'Array.prototype["[[Prototype]]"] = f',
          'Array.prototype["a]"] = f',
          `Array.prototype['say "hi"'] = f`,
          'Array.prototype["back\\\\slash"] = f',
          'Array.prototype["bell\\u0007"] = f',
          'Array.prototype["del\\u007f"] = f',
          'Array.prototype["plain key"] = f',
        ),
      )

      expect(report.findings.map((finding: Finding) => finding.target.name).toSorted()).toEqual(
        [
          'Array["prototype.map"]',
          'console["*"]',
          'console["log*"]',
          'Array.prototype["[[Prototype]]"]',
          'Array.prototype["a]"]',
          'Array.prototype["say \\"hi\\""]',
          'Array.prototype["back\\\\slash"]',
          'Array.prototype["bell\\u0007"]',
          'Array.prototype["del\u007f"]',
          'Array.prototype.plain key',
        ].toSorted(),
      )
      expect(report.findings.every((finding: Finding) => finding.effect === 'add')).toBe(true)
    })

    test('a string key on the global object that spells another member shadows nothing', async () => {
      const { report } = await scan(lines('window["@@toStringTag"] = x', 'window["XMLHttpRequest.prototype"] = x'))

      expect(fingerprints(report)).toEqual([])
    })

    test('a computed read whose key spells a path reads no holder', async () => {
      const { report } = await scan(
        lines('Intl["DateTimeFormat.prototype"].formatToParts = f', 'Intl["DateTimeFormat"].prototype.formatRange = f'),
      )

      expect(fingerprints(report)).toEqual(['window|Intl.DateTimeFormat.prototype.formatRange|replace|unknown'])
    })

    test("a computed read whose key spells a singleton's access path reads no singleton", async () => {
      const { report } = await scan(
        lines('Object.setPrototypeOf(window["navigator.geolocation"], X)', 'Object.setPrototypeOf(window["navigator"]["geolocation"], Y)'),
      )

      expect(fingerprints(report)).toEqual(['window|navigator.geolocation.[[Prototype]]|prototype-change|unknown'])
      expect(report.findings[0].occurrences).toHaveLength(1)
    })
  })

  describe('const chains have no depth limit (§5 Resolver capabilities 1)', () => {
    test('a 150-deep const chain resolves, whatever was read before it, and only the nesting cap counts its deferrals', async () => {
      // c0 is "x", and each constant adds a "y".
      const chain = ['const c0 = "x"', ...Array.from({ length: 150 }, (_, i) => `const c${i + 1} = c${i} + "y"`)]
      const add = (ys: number) => `window|Array.prototype.x${'y'.repeat(ys)}|add|unknown`
      for (const writes of [['Array.prototype[c150] = f'], ['Array.prototype[c50] = f', 'Array.prototype[c150] = f']]) {
        const { report } = await scan(lines(...chain, ...writes))

        const expected = writes.length === 1 ? [add(150)] : [add(150), add(50)]
        expect(fingerprints(report)).toEqual(expected)
        // Constants past 64 deep wait for the ones they are read within, and the nesting cap counts that.
        expect(Object.keys(report.completeness.counters.statistics.caps)).toEqual(['nesting'])
        expect(report.completeness.level).toBe('complete')
      }
    })

    test('a chain far too deep to evaluate by recursion resolves', async () => {
      const chain = ['const c0 = 0', ...Array.from({ length: 5000 }, (_, i) => `const c${i + 1} = c${i} + 1`)]
      const { report } = await scan(lines(...chain, 'Array.prototype[c5000] = f'))

      expect(fingerprints(report)).toEqual(['window|Array.prototype.5000|add|unknown'])
    })

    test('a chain through destructuring, defaults and several constants per initializer resolves', async () => {
      const chain = [
        'const a0 = "a", b0 = "b"',
        ...Array.from({ length: 300 }, (_, i) =>
          i % 2 === 0
            ? `const [a${i + 1}] = [a${i} + b${i}], { b${i + 1} = b${i} } = {}`
            : `const { a: a${i + 1} } = { a: a${i} }, b${i + 1} = \`\${b${i}}\``,
        ),
      ]
      const { report } = await scan(lines(...chain, 'Array.prototype[a300] = f'))

      expect(fingerprints(report)).toEqual([`window|Array.prototype.a${'b'.repeat(150)}|add|unknown`])
    })

    test('constants that read each other, or themselves, are unknown', async () => {
      const { report } = await scan(
        lines(
          'const a = b + "x", b = a + "y"',
          'const s = s + "send"',
          'const p = "open", q = p + r, r = q',
          'XMLHttpRequest.prototype[a] = w',
          'XMLHttpRequest.prototype[b] = w',
          'XMLHttpRequest.prototype[s] = w',
          'XMLHttpRequest.prototype[r] = w',
          'XMLHttpRequest.prototype[p] = w',
        ),
      )

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.open|replace|unknown'])
    })
  })

  describe('a fold-length hit raises analysis-budget (§13, §18)', () => {
    // s1 is 2 units long, and each constant doubles the last: s20 is 2^20 units, the most a fold may be.
    const doubling = ['const s0 = "x"', ...Array.from({ length: 20 }, (_, i) => `const s${i + 1} = s${i} + s${i}`)]

    test('a folded string over 2^20 units is unknown, and raises analysis-budget at the fold', async () => {
      const { report } = await scan(lines(...doubling, 'const s21 = s20 + s20', 'Array.prototype[s21] = f', 'Array.prototype[s1] = f'))

      expect(fingerprints(report)).toEqual(['window|Array.prototype.xx|add|unknown'])
      expect(report.completeness.level).toBe('complete-with-limitations')
      expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
      expect(report.completeness.limitations).toEqual([
        {
          kind: 'analysis-budget',
          artifact: expect.objectContaining({ url: 'https://app.example/main.js' }),
          location: expect.objectContaining({ line: 22, column: 12 }),
          detail: expect.any(String),
        },
      ])
    })

    test('a fold at its cap is kept, and a fold outside a constant raises it where it is', async () => {
      const { report } = await scan(
        lines(...doubling, 'Array.prototype[s20] = f', 'Array.prototype[s20 + "!"] = f', 'Array.prototype[`${s20}?`] = f'),
      )

      expect(report.findings).toHaveLength(1)
      expect(report.findings[0].target.name).toHaveLength('Array.prototype.'.length + 2 ** 20)
      expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 2 })
      expect(report.completeness.limitations.map((limitation: Finding) => [limitation.kind, limitation.location.line])).toEqual([
        ['analysis-budget', 23],
        ['analysis-budget', 24],
      ])
    })

    test('a constant no write reads raises nothing', async () => {
      const { report } = await scan(lines(...doubling, 'const s21 = s20 + s20'))

      expect(report.completeness.level).toBe('complete')
      expect(report.completeness.limitations).toEqual([])
    })
  })

  describe('the alternatives cap never drops a native holder (§18)', () => {
    test('a value with more than 16 alternatives keeps its native holders, collapses the rest, and counts the cap', async () => {
      const strings = Array.from({ length: 17 }, (_, i) => `c${i} ? "s${i}" : `).join('')
      const { report } = await scan(`(${strings}XMLHttpRequest.prototype).send = w`)

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
      expect(report.completeness.counters.statistics.caps).toEqual({ alternatives: 1 })
      expect(report.completeness.level).toBe('complete')
    })

    test('a sum or comparison with too many alternatives is unknown, and counts the cap', async () => {
      const five = (tag: string) => Array.from({ length: 4 }, (_, i) => `${tag}${i} ? "${tag}${i}" : `).join('') + `"${tag}"`
      const { report } = await scan(`Array.prototype[(${five('a')}) + (${five('b')})] = f`)

      expect(fingerprints(report)).toEqual([])
      expect(report.completeness.counters.statistics.caps).toEqual({ alternatives: 1 })
    })
  })

  describe('every constant key goes through ToPropertyKey (§4 Property keys)', () => {
    test('a number key names its string: 0 and "0" both name Array.prototype.0, in every mechanism', async () => {
      const { report } = await scan(
        lines(
          'Array.prototype[0] = f',
          'const k = 0',
          'Array.prototype[k] = f',
          'Object.defineProperty(Array.prototype, 0, { value: f })',
          'Object.assign(Array.prototype, { [k]: f })',
          'Array.prototype["0"] = f',
        ),
      )

      expect(fingerprints(report)).toEqual(['window|Array.prototype.0|add|unknown'])
      expect(report.findings[0].occurrences.map((occurrence: Finding) => occurrence.mechanism)).toEqual([
        'assign',
        'assign',
        'define-property',
        'bulk-assign',
        'assign',
      ])
      expect(report.findings[0].occurrences[1].trace).toContainEqual(expect.objectContaining({ kind: 'fold', name: 'k', value: 0 }))
    })

    test('numeric members use their canonical string: 1e21 names 1e+21', async () => {
      const { report } = await scan(lines('Array.prototype[1e21] = f', 'Object.assign(Array.prototype, { 1e21: f })'))

      expect(fingerprints(report)).toEqual(['window|Array.prototype.1e+21|add|unknown'])
      expect(report.findings[0].occurrences).toHaveLength(2)
    })

    test('boolean, null, undefined, NaN and Infinity keys name their strings', async () => {
      const { report } = await scan(
        lines(
          'Array.prototype[!0] = f',
          'Array.prototype[null] = f',
          'Array.prototype[undefined] = f',
          'Array.prototype[void 0] = f',
          'Array.prototype[NaN] = f',
          'delete Array.prototype[Infinity]',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Array.prototype.NaN|add|unknown',
        'window|Array.prototype.null|add|unknown',
        'window|Array.prototype.true|add|unknown',
        'window|Array.prototype.undefined|add|unknown',
      ])
    })

    test('a canonical numeric key keeps the dot form, whatever spells it', async () => {
      const { report } = await scan(lines('Array.prototype[1.5] = f', 'Array.prototype["1.5"] = f', 'Array.prototype["1.50"] = f'))

      expect(fingerprints(report)).toEqual([
        'window|Array.prototype.1.5|add|unknown',
        'window|Array.prototype["1.50"]|add|unknown',
      ])
      expect(report.findings[0].occurrences).toHaveLength(2)
      expect(report.findings.map((finding: Finding) => finding.surface)).toEqual(['ECMAScript', 'ECMAScript'])
    })

    test('a key on a holder the catalog chose, Object.getPrototypeOf(h), is converted and spelt the same way', async () => {
      const { report } = await scan(
        lines(
          'Object.getPrototypeOf(console)[0] = f',
          'Object.getPrototypeOf(console)[Symbol.iterator] = f',
          'Object.getPrototypeOf(console)["a.b"] = f',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|console.[[Prototype]].0|add|unknown',
        'window|console.[[Prototype]].@@iterator|add|unknown',
        'window|console.[[Prototype]]["a.b"]|add|unknown',
      ])
      const surfaces = report.findings.map((finding: Finding) => finding.surface)
      expect(new Set(surfaces).size).toBe(1)
      // `Object`, `console`, the prototype the catalog gives it, then `Symbol` and the symbol read from it.
      expect(traceOf(report.findings[1]).map((step) => step.kind)).toEqual([
        'binding',
        'binding',
        'catalog-holder',
        'binding',
        'fold',
      ])
    })

    test('an index key on a window still writes nothing it names', async () => {
      const { report } = await scan(lines('window[0] = f', 'Object.defineProperty(window, 1, { value: f })'))

      expect(fingerprints(report)).toEqual([])
    })
  })

  test('the report is byte-identical across runs', async () => {
    const code = lines(
      'const it = Symbol.iterator, k = 0',
      'Array.prototype[it] = f; Array.prototype[k] = f; Array.prototype[1.5] = f',
      'Map.prototype["@@toStringTag"] = v; Array["prototype.map"] = f',
      'with (o) { Object.defineProperty(window, "fetch", { value: window.fetch, configurable: undefined }) }',
      'const s0 = "x"',
      ...Array.from({ length: 21 }, (_, i) => `const s${i + 1} = s${i} + s${i}`),
      'Array.prototype[s21] = f',
    )
    const first = await scan(code)
    const second = await scan(code)

    const withoutRun = (text: string) => JSON.stringify({ ...JSON.parse(text), run: undefined })
    expect(withoutRun(first.stdout)).toBe(withoutRun(second.stdout))
    expect(first.report.findings).toHaveLength(6)
    expect(first.report.completeness.limitations).toHaveLength(1)
  })
})

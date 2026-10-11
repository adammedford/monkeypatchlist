// Context policy (§18): results are independent of visit order; a call that carries a native is merged last; depth
// limits defer calls, never drop them, so a call that carries a native is exempt from the depth cap; and the
// caps and their hits are in the scan statistics. Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { defaultBudget, type Budget } from '../src/packages/analysis/index.ts'
import { shuffledResolver } from '../src/packages/analysis/visit-order.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join('\n')
const scan = async (code: string) => (await scanBuild(classic(code))).report
const fingerprints = (report: Report): string[] => report.findings.map((finding: Report) => finding.fingerprint)
const kinds = (report: Report): string[] => report.completeness.limitations.map((record: Report) => record.kind)

/** A chain of `depth` named helpers, each passing its holder one level down, the last one writing `o.fetch`. */
const namedChain = (depth: number, call = 'h1(window)') =>
  lines(
    ...Array.from({ length: depth - 1 }, (_, index) => `function h${index + 1}(o) { h${index + 2}(o) }`),
    `function h${depth}(o) { o.fetch = w }`,
    call,
  )

describe('depth limits defer calls that carry a native, never drop them', () => {
  test('an 8-deep chain of named helpers gives Window.fetch at the confidence of a 3-deep one, and the scan stays complete', async () => {
    const deep = await scan(namedChain(8))
    const shallow = await scan(namedChain(3))

    expect(fingerprints(deep)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(deep.completeness.level).toBe('complete')
    expect(kinds(deep)).toEqual([])
    expect(deep.findings[0].confidence).toEqual(shallow.findings[0].confidence)
  })

  test('only the step budget bounds a deferred chain: 60 deep still finds Window.fetch, and a quarter of its steps runs out and raises analysis-budget', async () => {
    const code = namedChain(60)
    const full = await scan(code)
    expect(fingerprints(full)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(full.completeness.level).toBe('complete')
    expect(full.completeness.counters.statistics.caps.recursion).toBeUndefined()

    const { steps } = full.completeness.counters.statistics
    const budget: Budget = { ...defaultBudget, stepsPerByte: steps / 4 / Buffer.byteLength(code) }
    const short = (await scanBuild(classic(code), [], { deps: { budget } })).report
    expect(short.findings).toEqual([])
    expect(short.completeness.level).toBe('complete-with-limitations')
    expect(kinds(short)).toEqual(['analysis-budget'])
    expect(short.completeness.counters.statistics.budgetExhausted).toBe(1)
  })
})

/** A chain of `depth` helpers the syntax doesn't name (closures through `id`), the last one writing `o[n]`. */
const closureChain = (depth: number) =>
  lines(
    'const id = (f) => f',
    'const a1 = id((o, n) => { o[n] = w })',
    ...Array.from({ length: depth - 1 }, (_, index) => `const a${index + 2} = id((o, n) => a${index + 1}(o, n))`),
    `a${depth}(XMLHttpRequest.prototype, 'send')`,
  )

describe('depth limits defer calls the syntax does not name too', () => {
  test('an 8-deep chain of closures gives XMLHttpRequest.prototype.send, and the scan stays complete', async () => {
    const report = await scan(closureChain(8))

    expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
    expect(report.completeness.level).toBe('complete')
    expect(report.findings[0].confidence).toEqual((await scan(closureChain(3))).findings[0].confidence)
  })
})

describe('recursion still widens', () => {
  test('a deep chain into a recursive helper defers its calls past the depth cap, finds the write, and raises analysis-budget for the recursion alone', async () => {
    const code = lines(
      ...Array.from({ length: 8 }, (_, index) => `function h${index + 1}(o) { h${index + 2}(o, 3) }`),
      'function h9(o, i) { o.fetch = w; if (i) h9(o, i - 1) }',
      'h1(window)',
    )
    const report = await scan(code)

    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(report.completeness.level).toBe('complete-with-limitations')
    const budget = report.completeness.limitations.filter((record: Report) => record.kind === 'analysis-budget')
    // Only the recursive call, on line 9, is cut; the chain's calls past the depth cap are deferred.
    expect(budget.map((record: Report) => record.location.line)).toEqual([9])
  })

  test('a native that arrives only through the recursion is judged in the real caller frames: analysis-budget, and no finding for it', async () => {
    const report = await scan(
      lines("function r(o, k) { if (k.length) return r(o[k[0]], k.slice(1)); o.fetch = w }", "r(window, ['document'])"),
    )

    expect(fingerprints(report)).not.toContain('window|document.fetch|replace|unknown')
    expect(report.completeness.level).toBe('complete-with-limitations')
    const budget = report.completeness.limitations.filter((record: Report) => record.kind === 'analysis-budget')
    expect(budget).toEqual([expect.objectContaining({ location: expect.objectContaining({ line: 1 }) })])
  })
})

describe('the context cap merges calls that carry a native last', () => {
  test('past the context cap, the one call that carries a native keeps its own frame and finds its exact target', async () => {
    const plain = Array.from({ length: defaultBudget.caps.contexts + 6 }, (_, index) => `patch({}, 'k${index}')`)
    const report = await scan(
      lines('function patch(o, n) { o[n] = w }', ...plain, "patch(XMLHttpRequest.prototype, 'send')", ...plain),
    )

    expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
    // At the confidence the call alone gives.
    const alone = await scan(lines('function patch(o, n) { o[n] = w }', "patch(XMLHttpRequest.prototype, 'send')"))
    expect(report.findings[0].confidence).toEqual(alone.findings[0].confidence)
    expect(kinds(report)).toEqual([])
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.counters.statistics.caps.contexts).toBeGreaterThan(0)
  })
})

describe('results are independent of visit order', () => {
  // Helpers, a context cap overflow with calls that carry a native among the others, closures and methods the syntax
  // doesn't name, a loop, a recursion and a chain past the depth cap: each resolves the same whatever order the
  // resolver visits the calls of a function and the calls of the program in.
  const code = lines(
    'function patch(o, n) { o[n] = w }',
    ...Array.from({ length: defaultBudget.caps.contexts / 2 + 8 }, (_, index) => `patch({}, 'a${index}')`),
    "patch(XMLHttpRequest.prototype, 'send')",
    ...Array.from({ length: defaultBudget.caps.contexts / 2 + 8 }, (_, index) => `patch({}, 'b${index}')`),
    "patch(window, 'fetch')",
    "patch(history, 'pushState')",
    'const id = (f) => f',
    'const a1 = id((o, n) => { o[n] = w })',
    ...Array.from({ length: 7 }, (_, index) => `const a${index + 2} = id((o, n) => a${index + 1}(o, n))`),
    "a8(XMLHttpRequest.prototype, 'open')",
    "class P { constructor(o) { this.o = o } on(n) { this.o[n] = w } }",
    "new P(window).on('setTimeout')",
    "for (const n of ['addEventListener', 'removeEventListener']) patch(EventTarget.prototype, n)",
    'function walk(o, i) { o.setInterval = w; if (i) walk(o, i - 1) }',
    'walk(window, 3)',
    ...Array.from({ length: 7 }, (_, index) => `function h${index + 1}(o) { h${index + 2}(o) }`),
    'function h8(o) { o.postMessage = w }',
    'h1(window)',
  )
  const build = classic(code)
  const withoutRun = (report: Report) => JSON.stringify({ ...report, run: null })

  test('a permutation test that shuffles visit order gives byte-identical reports', async () => {
    const natural = (await scanBuild(build)).report
    expect(natural.findings.length).toBeGreaterThan(5)
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      const shuffled = (await scanBuild(build, [], { deps: { resolver: shuffledResolver(seed) } })).report
      expect(withoutRun(shuffled)).toBe(withoutRun(natural))
    }
  })
})

describe('a starting `undefined` that ECMA-262 never returns gives no ".undefined" key in frames past the shipped depth', () => {
  // core-js's set-to-string-tag over its define helper: `toPropertyKey` runs `ordinaryToPrimitive`, whose `val` starts
  // `undefined` and is returned only where the `&&` test assigned it. The well-known-symbol key is unknown (§21).
  // The holder's name reaches the write only through a chain of calls that carry no native, deeper than the shipped
  // depth cap, so at shipped caps the frame is widened and the write has no holder.
  const code = lines(
    "function isObject(i) { return typeof i == 'object' ? i !== null : typeof i == 'function' }",
    "function ordinaryToPrimitive(input, pref) { var fn, val; if (pref === 'string' && typeof (fn = input.toString) == 'function' && !isObject(val = fn.call(input))) return val; throw TypeError() }",
    'function toPrimitive(input, pref) { if (!isObject(input)) return input; return ordinaryToPrimitive(input, pref) }',
    "function toPropertyKey(a) { var key = toPrimitive(a, 'string'); return typeof key == 'symbol' ? key : key + '' }",
    'function define(O, P, A) { Object.defineProperty(O, toPropertyKey(P), A) }',
    'var TAG = store.wks',
    "function setToStringTag(target, tag, STATIC) { if (target && !STATIC) target = target.prototype; if (target) { define(target, TAG, { configurable: true, value: tag }); define(target, 'tagged', { value: tag }) } }",
    ...Array.from({ length: 6 }, (_, index) => `function l${index + 1}(n) { l${index + 2}(n) }`),
    'function l7(n) { setToStringTag(window[n], n); setToStringTag(window[n], n, true) }',
    "l1('Promise')",
  )
  // The caps before they were raised: `depth` 6, `contexts` 64.
  const before: Budget = { ...defaultBudget, caps: { ...defaultBudget.caps, depth: 6, contexts: 64 } }

  test('at the shipped caps (depth 24), the deep frames name Promise and Promise.prototype, and the unknown key gives no .undefined target', async () => {
    const report = await scan(code)

    expect(fingerprints(report)).toEqual([
      'window|Promise.prototype.tagged|add|unknown',
      'window|Promise.tagged|add|unknown',
    ])
  })

  test('at depth 6, the earlier cap, the frames are widened and the write has no holder', async () => {
    expect(fingerprints((await scanBuild(classic(code), [], { deps: { budget: before } })).report)).toEqual([])
  })
})

describe('the context caps are deterministic, reported in the statistics, and replaceable through the deps', () => {
  const withCaps = (caps: Partial<Budget['caps']>): Budget => ({ ...defaultBudget, caps: { ...defaultBudget.caps, ...caps } })
  const scanWith = async (code: string, budget: Budget) => (await scanBuild(classic(code), [], { deps: { budget } })).report

  test('an injected context cap is the one the scan merges at, and the statistics show it and its hits', async () => {
    // Six calls that carry no native, one that carries one: past a cap of 4, three frames merge.
    const code = lines('function patch(o, n) { o[n] = w }', ...Array.from({ length: 6 }, () => "patch({}, 'x')"), "patch(window, 'fetch')")
    const shipped = await scan(code)
    const lowered = await scanWith(code, withCaps({ contexts: 4 }))

    expect(shipped.completeness.counters.statistics.caps.contexts).toBeUndefined()
    expect(fingerprints(lowered)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(kinds(lowered)).toEqual([])
    expect(lowered.completeness.counters.statistics.caps.contexts).toBe(4)
    expect(lowered.completeness.counters.statistics.limits.caps.contexts).toBe(4)
    expect(shipped.completeness.counters.statistics.limits.caps.contexts).toBe(defaultBudget.caps.contexts)
  })

  test('an injected depth cap widens a deep chain that carries no native, and counts the hit, while one that carries a native is deferred', async () => {
    const plain = lines('function g1(o) { g2(o) }', 'function g2(o) { g3(o) }', 'function g3(o) { o.x = 1 }', 'g1({})')
    const native = namedChain(3)
    const budget = withCaps({ depth: 1 })

    const cut = await scanWith(plain, budget)
    expect(cut.completeness.counters.statistics.caps.recursion).toBeGreaterThan(0)
    expect(cut.completeness.counters.statistics.limits.caps.depth).toBe(1)
    expect(kinds(cut)).toEqual([])

    const deferred = await scanWith(native, budget)
    expect(fingerprints(deferred)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(deferred.completeness.level).toBe('complete')
    expect(deferred.completeness.counters.statistics.caps.recursion).toBeUndefined()
  })

  test('a scan that hits the caps is byte-identical across runs', async () => {
    const code = lines(
      'function patch(o, n) { o[n] = w }',
      ...Array.from({ length: defaultBudget.caps.contexts + 6 }, (_, index) => `patch({}, 'k${index}')`),
      "patch(window, 'fetch')",
      'function walk(o, i) { o.setInterval = w; if (i) walk(o, i - 1) }',
      'walk(window, 3)',
    )
    const first = await scan(code)
    const second = await scan(code)
    expect(first.completeness.counters.statistics.caps).toMatchObject({ contexts: expect.any(Number), recursion: expect.any(Number) })
    expect(JSON.stringify({ ...first, run: null })).toBe(JSON.stringify({ ...second, run: null }))
  })
})

describe('a widened or merged frame that passes a native function raises analysis-budget (Principle 5)', () => {
  const withCaps = (caps: Partial<Budget['caps']>): Budget => ({ ...defaultBudget, caps: { ...defaultBudget.caps, ...caps } })
  const scanWith = async (code: string, budget: Budget) => (await scanBuild(classic(code), [], { deps: { budget } })).report
  const budgetLines = (report: Report): number[] =>
    report.completeness.limitations
      .filter((record: Report) => record.kind === 'analysis-budget')
      .map((record: Report) => record.location.line)
  const effects = (report: Report): string[][] =>
    report.findings.map((finding: Report) => [finding.target.name, finding.effect])

  // A recursive installer the original is passed through, and nothing else native: the recursion widens its frame.
  const recursive = (passed: string) =>
    lines(
      'function install(f, i) { if (i) install(f, i - 1); window.fetch = function () { return f.apply(this, arguments) } }',
      `install(${passed}, 3)`,
    )

  test('the original window.fetch, a native function read from a native holder, passed into a recursion', async () => {
    const report = await scan(recursive('window.fetch'))

    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(budgetLines(report)).toEqual([1])
  })

  test('a native function passed on alone, Object.defineProperty, the same', async () => {
    const report = await scan(recursive('Object.defineProperty'))

    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(budgetLines(report)).toEqual([1])
  })

  test('a function that is no native passes nothing, and the recursion is only counted', async () => {
    const report = await scan(recursive('function () {}'))

    expect(budgetLines(report)).toEqual([])
    expect(report.completeness.counters.statistics.caps.recursion).toBeGreaterThan(0)
  })

  // Each call passes an original: past a context cap of 2, one of their frames is merged.
  const installs = (names: string[]) =>
    names.map((name) => `install(window.${name}, '${name}')`)
  const installer = 'function install(f, n) { window[n] = function () { return f.apply(this, arguments) } }'

  test('the original window.fetch passed into calls the context cap merges', async () => {
    const report = await scanWith(lines(installer, ...installs(['fetch', 'open', 'setTimeout'])), withCaps({ contexts: 2 }))

    expect(report.completeness.counters.statistics.caps.contexts).toBeGreaterThan(0)
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(budgetLines(report).length).toBeGreaterThan(0)
  })

  test('the context cap keeps the frame that passes the original apart from frames that pass no native', async () => {
    // Kept apart, the frame writes `window.fetch` back to its own slot, which changes nothing (§3). Merged with the
    // others, it could write one of their functions there.
    const code = lines(
      'function put(f, n) { window[n] = f }',
      ...['a', 'b', 'c'].map((name) => `put(function () {}, '${name}')`),
      "put(window.fetch, 'fetch')",
    )
    const report = await scanWith(code, withCaps({ contexts: 2 }))

    expect(report.completeness.counters.statistics.caps.contexts).toBeGreaterThan(0)
    expect(budgetLines(report)).toEqual([])
    expect(effects(report)).toEqual([])
  })
})

describe('the shipped caps', () => {
  test('R1 ships the depth cap at 24 and the contexts cap at 256, and the statistics show them', async () => {
    const report = await scan('window.fetch = w')

    expect(report.completeness.counters.statistics.limits.caps).toMatchObject({ depth: 24, contexts: 256 })
  })
})

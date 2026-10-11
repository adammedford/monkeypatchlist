// Constant loops (§5 Resolver capabilities 4): the resolver iterates constant arrays, `split` lists and an object
// literal's own enumerable keys, and simulates counted loops whose counter is bumped in the body. Every scenario goes
// through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'
import { mappings, type Segment } from './support/source-map.ts'
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
 * A build whose `main.js` has one line per source, each copied unchanged from its own original file, with a sidecar map
 * that holds each file's content.
 */
function mapped(files: [source: string, code: string][]): Record<string, string> {
  const code = files.map(([, text]) => text).join('\n')
  const lines = files.map(([, text], index) => {
    const segments: Segment[] = []
    for (const match of text.matchAll(/[\w$]+|[^\s\w$]/g)) segments.push([match.index, index, 0, match.index])
    return segments
  })
  const map = {
    version: 3,
    sources: files.map(([source]) => source),
    sourcesContent: files.map(([, text]) => text),
    names: [],
    mappings: mappings(lines),
  }
  return { 'index.html': '<script src="main.js"></script>', 'main.js': code, 'main.js.map': JSON.stringify(map) }
}

const library = 'webpack://app/./node_modules/@acme/sdk/index.js'
const instrument = 'webpack://app/./src/instrument.js'

const fingerprints = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.fingerprint)
const open = 'window|XMLHttpRequest.prototype.open|replace|unknown'
const send = 'window|XMLHttpRequest.prototype.send|replace|unknown'

describe.each(resolvers)('constant loops, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test('for…of over a constant array gives one finding per element', async () => {
    const { report } = await scan("for (const m of ['open', 'send']) XMLHttpRequest.prototype[m] = w")

    expect(fingerprints(report)).toEqual([open, send])
  })

  test.each([
    ['a counted for', "var names = ['open', 'send']; for (var i = 0; i < names.length; i++) XMLHttpRequest.prototype[names[i]] = w"],
    ['a while loop with a counter', "var names = ['open', 'send'], i = 0; while (i < 2) { XMLHttpRequest.prototype[names[i]] = w; i++ }"],
    ['forEach', "['open', 'send'].forEach(m => patch(XMLHttpRequest.prototype, m)); function patch(p, m) { p[m] = w }"],
    ['a split list', "'open send'.split(' ').forEach(function (m) { XMLHttpRequest.prototype[m] = w })"],
    ['for…of over a const array', "const names = ['open', 'send']; for (const m of names) XMLHttpRequest.prototype[m] = w"],
  ])('%s gives one finding per element', async (_, code) => {
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual([open, send])
  })

  test.each([
    ['a loop in a helper that writes its parameter', "function patch(proto) { for (const m of ['open', 'send']) proto[m] = w } patch(XMLHttpRequest.prototype)"],
    ['a callback in a helper that reads its parameter', "function patch(proto) { ['open', 'send'].forEach(m => { proto[m] = w }) } patch(XMLHttpRequest.prototype)"],
    ['nested loops', "for (const p of [XMLHttpRequest.prototype]) for (const m of ['open', 'send']) p[m] = w"],
  ])('iterations run within the frames of the code around them: %s', async (_, code) => {
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual([open, send])
  })

  test.each([
    ['a parameter no call site folds', 'function f(names) { names.forEach(m => { XMLHttpRequest.prototype[m] = w }) }'],
    ['an unknown global', 'for (const m of config.methods) XMLHttpRequest.prototype[m] = w'],
    ['a list read from an object', 'var o = { l: ["open"] }; o.l.forEach(m => { XMLHttpRequest.prototype[m] = w })'],
  ])('a loop over %s is not unrolled, and gives no finding from an unknown key', async (_, code) => {
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual([])
    expect(report.completeness.limitations).toEqual([])
  })

  test.each([
    ['push', "var names = ['open']; names.push('send'); names.forEach(m => fill(XMLHttpRequest.prototype, m, w))"],
    ['an index write', "var names = ['open']; names[1] = 'send'; names.forEach(m => fill(XMLHttpRequest.prototype, m, w))"],
    ['a length write', "var names = ['open', 'send']; names.length = 1; for (const m of names) fill(XMLHttpRequest.prototype, m, w)"],
    ['sort through an alias', "var names = ['open', 'send']; var a = names; a.sort(); for (const m of names) fill(XMLHttpRequest.prototype, m, w)"],
    ['a splice in a known helper', "var names = ['open', 'send']; drop(names); function drop(l) { l.splice(0, 1) } names.forEach(m => fill(XMLHttpRequest.prototype, m, w))"],
  ])('an array the analyzer sees written (%s) is not unrolled and gives no finding', async (_, code) => {
    const { report } = await scan(lines(code, 'function fill(o, n, f) { o[n] = f }'))

    expect(fingerprints(report)).toEqual([])
    // Its elements are unknown, so a helper that reuses the key gives only the wildcard (§5 Partially resolved writes).
    const reused = await scan(lines(code, 'function fill(o, n, f) { o[n] = f(o[n]) }'))
    expect(fingerprints(reused.report)).toEqual(['window|XMLHttpRequest.prototype.*|wrap|unknown'])
  })

  test('passing an array to a call the analyzer cannot resolve leaves it constant', async () => {
    const { report } = await scan(
      lines(
        "var names = ['open', 'send']; track(names)",
        'names.forEach(m => fill(XMLHttpRequest.prototype, m, w))',
        'function fill(o, n, f) { o[n] = f }',
      ),
    )

    expect(fingerprints(report)).toEqual([open, send])
  })

  test('a counted loop whose bound is a parameter no call site folds is not unrolled, and its reused key gives the wildcard', async () => {
    const code = 'function f(n) { for (var i = 0; i < n; i++) XMLHttpRequest.prototype[names[i]] = wrap(XMLHttpRequest.prototype[names[i]]) }'
    const { report } = await scan(lines("var names = ['open', 'send']", code))

    expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.*|wrap|unknown'])
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.counters.statistics.caps.iterations).toBeUndefined()
  })

  test.each([
    ['a counted loop whose bound is a parameter no call site folds', 'function f(n) { for (var i = 0; i < n; i++) XMLHttpRequest.prototype[names[i]] = w }'],
    ['a counted loop with no test that breaks on a call', 'for (var i = 0; ; i++) { if (stop(i)) break; XMLHttpRequest.prototype[names[i]] = w }'],
    ['a counted loop whose counter another function writes', 'function reset() { i = 5 } for (var i = 0; i < 2; i++) { XMLHttpRequest.prototype[names[i]] = w; reset() }'],
  ])('%s is not unrolled: no .undefined target, no cap hit and no analysis-budget', async (_, code) => {
    const { report } = await scan(lines("var names = ['open', 'send']", code))

    expect(fingerprints(report)).toEqual([])
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.counters.statistics.caps.iterations).toBeUndefined()
  })

  test('a counted loop with an undecided bound that always exits within the cap is unrolled', async () => {
    const { report } = await scan(
      "var names = ['open', 'send']; function f(n) { for (var i = 0; i < n; i++) { XMLHttpRequest.prototype[names[i]] = w; if (i === 1) break } }",
    )

    expect(fingerprints(report)).toEqual([open, send])
  })

  describe('the iteration cap (Principle 5)', () => {
    test('a loop cut by the cap keeps the findings of the iterations done, and raises one analysis-budget naming the artifact', async () => {
      const { report } = await scan('for (var i = 0; i < 1e6; i++) Array.prototype["x" + i] = f')

      const names = report.findings.map((finding: Finding) => finding.target.name)
      expect(names).toHaveLength(256)
      expect(names).toContain('Array.prototype.x0')
      expect(names).toContain('Array.prototype.x255')
      const budget = report.completeness.limitations.filter((record: Finding) => record.kind === 'analysis-budget')
      expect(budget).toHaveLength(1)
      expect(budget[0].artifact.url).toMatch(/main\.js$/)
      expect(report.completeness.counters.statistics.caps.iterations).toBe(1)
    })

    test("an iteration native's callback cut by the cap keeps the calls done, and raises analysis-budget", async () => {
      const names = Array.from({ length: 300 }, (_, index) => `x${index}`).join(' ')
      const { report } = await scan(`'${names}'.split(' ').forEach(m => { Array.prototype[m] = f })`)

      expect(report.findings).toHaveLength(256)
      const budget = report.completeness.limitations.filter((record: Finding) => record.kind === 'analysis-budget')
      expect(budget).toHaveLength(1)
    })

    test('a capped loop that writes no native only counts the hit', async () => {
      const { report } = await scan('var o = {}; for (var i = 0; i < 1e6; i++) o["x" + i] = f')

      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.counters.statistics.caps.iterations).toBe(1)
    })
  })

  describe("an object literal's own enumerable keys", () => {
    test.each([
      ['for…in', 'var impl = { open: o, send: s }; for (var k in impl) XMLHttpRequest.prototype[k] = impl[k]'],
      ['Object.keys', 'var impl = { open: o, send: s }; Object.keys(impl).forEach(k => { XMLHttpRequest.prototype[k] = impl[k] })'],
      ['Object.entries', 'for (const [k, v] of Object.entries({ open: o, send: s })) XMLHttpRequest.prototype[k] = v'],
      ['Object.values', 'for (const m of Object.values({ a: "open", b: "send" })) XMLHttpRequest.prototype[m] = w'],
    ])('are iterated by %s', async (_, code) => {
      const { report } = await scan(code)

      expect(fingerprints(report)).toEqual([open, send])
    })

    test('in ECMA-262 order: integer keys ascending first, then the others as created', async () => {
      const { report } = await scan(
        'var seen = { b: 1, 2: 1, a: 1, 1: 1 }; var keys = Object.keys(seen); XMLHttpRequest.prototype[keys[0] + keys[1] + keys[2] + keys[3]] = w',
      )

      expect(report.findings.map((finding: Finding) => finding.target.name)).toEqual(['XMLHttpRequest.prototype.12ba'])
    })

    test('a literal written to later is not iterated', async () => {
      const { report } = await scan('var impl = { open: o }; impl.send = s; for (var k in impl) XMLHttpRequest.prototype[k] = impl[k]')

      expect(fingerprints(report)).toEqual([])
    })

    test.each([
      ['a call returns', 'function make() { return { open: o } } var impl = make(); impl.send = s'],
      ['a field holds', 'var cfg = { impl: { open: o } }; cfg.impl.send = s; var impl = cfg.impl'],
    ])('a literal %s that is written to later is not iterated', async (_, code) => {
      const { report } = await scan(lines(code, 'for (var k in impl) XMLHttpRequest.prototype[k] = 1'))

      expect(fingerprints(report)).toEqual([])
    })

    test.each([
      ['a constructor it holds', 'function U() { this.host = 1 } function ex(source) { for (var k in source) XMLHttpRequest.prototype[k] = w }', 'ex({ open: U, send: s })'],
      ['a method it holds', 'function ex(source) { for (var k in source) XMLHttpRequest.prototype[k] = w }', 'ex({ open: function () { this.size++ }, send: s })'],
      ['an arrow in a method it holds', 'function ex(source) { for (var k in source) XMLHttpRequest.prototype[k] = w }', 'ex({ open: function () { [1].forEach(() => { this.n = 1 }) }, send: s })'],
      ['a method it holds, through a call that returns it', 'function ex(source) { for (var k in source) XMLHttpRequest.prototype[k] = w } function inst(it) { return it }', 'ex({ open: function () { var t = inst(this); t.host = 1 }, send: s })'],
      ['a method it holds, through a call it is passed to', 'function ex(source) { for (var k in source) XMLHttpRequest.prototype[k] = w } function setState(it, v) { it.state = v }', 'ex({ open: function () { setState(this, 1) }, send: s })'],
    ])("a literal written only through the assumed `this` of %s is still iterated", async (_, helper, call) => {
      const { report } = await scan(lines(helper, call))

      expect(fingerprints(report)).toEqual([open, send])
    })

    test('a literal a method it holds writes through its name is not iterated', async () => {
      const { report } = await scan(
        lines('var impl = { open: function () { impl.send = s } }', 'for (var k in impl) XMLHttpRequest.prototype[k] = 1'),
      )

      expect(fingerprints(report)).toEqual([])
    })

    test('a literal a method writes through the `this` of a resolved call is not iterated', async () => {
      const { report } = await scan(
        lines(
          'function ex(source) { source.init(); for (var k in source) XMLHttpRequest.prototype[k] = 1 }',
          'ex({ open: o, init: function () { this.send = s } })',
        ),
      )

      expect(fingerprints(report)).toEqual([])
    })

    test('a literal a call returns that nothing writes to is iterated', async () => {
      const { report } = await scan(
        lines('function make() { return { open: o, send: s } } var impl = make()', 'for (var k in impl) XMLHttpRequest.prototype[k] = w'),
      )

      expect(fingerprints(report)).toEqual([open, send])
    })
  })

  describe('an array reached through alternatives and returns', () => {
    const fill = 'function fill(o, n, f) { o[n] = f }'

    test.each([
      ['a `?:` with an undecided test', "var names = c ? ['open'] : ['send']; names.forEach(m => fill(XMLHttpRequest.prototype, m, w))"],
      ['a `?:` inline', "(c ? ['open'] : ['send']).forEach(m => fill(XMLHttpRequest.prototype, m, w))"],
    ])('each alternative of %s is its own collection', async (_, code) => {
      const { report } = await scan(lines(code, fill))

      expect(fingerprints(report)).toEqual([open, send])
    })

    test.each([
      ['`&&`', "(c && ['open', 'send']).forEach(m => fill(XMLHttpRequest.prototype, m, w))"],
      ['`||` with a constant left', "(['open', 'send'] || ['abort']).forEach(m => fill(XMLHttpRequest.prototype, m, w))"],
      ['`||` with a falsy left', "(0 || ['open', 'send']).forEach(m => fill(XMLHttpRequest.prototype, m, w))"],
      ['`??` with a nullish left', "(null ?? ['open', 'send']).forEach(m => fill(XMLHttpRequest.prototype, m, w))"],
      ['a `?:` with a decided test', "(1 ? ['open', 'send'] : ['abort']).forEach(m => fill(XMLHttpRequest.prototype, m, w))"],
    ])('%s gives the alternatives that may be the value', async (_, code) => {
      const { report } = await scan(lines(code, fill))

      expect(fingerprints(report)).toEqual([open, send])
    })

    test.each([
      ['a function', "function names() { return ['open', 'send'] } names().forEach(m => fill(XMLHttpRequest.prototype, m, w))"],
      ['an arrow', "const names = () => ['open', 'send']; for (const m of names()) fill(XMLHttpRequest.prototype, m, w)"],
      [
        'a method through `this`',
        "const o = { names() { return c ? ['open'] : ['send'] }, run() { this.names().forEach(m => fill(XMLHttpRequest.prototype, m, w)) } }; o.run()",
      ],
    ])("the array %s returns is iterated, each return's alternative its own collection", async (_, code) => {
      const { report } = await scan(lines(code, fill))

      expect(fingerprints(report)).toEqual([open, send])
    })

    test('an array a heap field carries stays un-iterated', async () => {
      const { report } = await scan(lines("const o = { l: ['open', 'send'] }; o.l.forEach(m => fill(XMLHttpRequest.prototype, m, w))", fill))

      expect(fingerprints(report)).toEqual([])
    })
  })

  describe('iteration natives unroll in ECMA-262 order, with their early exits', () => {
    const fill = 'function fill(o, n, f) { o[n] = f }'

    test.each([
      ['map', 'names.map(m => fill(XMLHttpRequest.prototype, m, w))'],
      ['filter', 'names.filter(m => fill(XMLHttpRequest.prototype, m, w))'],
      ['some with an undecided result', 'names.some(m => fill(XMLHttpRequest.prototype, m, w))'],
      ['every', 'names.every(m => { fill(XMLHttpRequest.prototype, m, w); return true })'],
      ['flatMap', 'names.flatMap(m => fill(XMLHttpRequest.prototype, m, w))'],
      ['reduce with a seed', 'names.reduce((a, m) => fill(XMLHttpRequest.prototype, m, w), 0)'],
      ['reduceRight with a seed', 'names.reduceRight((a, m) => fill(XMLHttpRequest.prototype, m, w), 0)'],
      ['Array.from with a map function', 'Array.from(names, m => fill(XMLHttpRequest.prototype, m, w))'],
      ['spread', 'for (const m of [...names]) fill(XMLHttpRequest.prototype, m, w)'],
      ['entries', 'for (const [i, m] of names.entries()) fill(XMLHttpRequest.prototype, m, w)'],
      ['values', 'for (const m of names.values()) fill(XMLHttpRequest.prototype, m, w)'],
      ['keys', 'for (const i of names.keys()) fill(XMLHttpRequest.prototype, names[i], w)'],
      ['findLast with an undecided result', 'names.findLast(m => fill(XMLHttpRequest.prototype, m, w))'],
    ])('%s', async (_, code) => {
      const { report } = await scan(lines("var names = ['open', 'send']", code, fill))

      expect(fingerprints(report)).toEqual([open, send])
    })

    test('find takes its early exit on a decided result', async () => {
      const { report } = await scan(
        lines(
          "['open', 'send', 'abort'].find(m => { fill(XMLHttpRequest.prototype, m, w); return m === 'send' });",
          "['open', 'send', 'abort'].findLastIndex(m => { fill(XMLHttpRequest.prototype, m, w); return m === 'send' });",
          fill,
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|XMLHttpRequest.prototype.abort|replace|unknown',
        open,
        send,
      ])
      // The first loop stops at `send`, and the second, from the end, too: `open` comes only from the first.
      const opened = report.findings.find((finding: Finding) => finding.fingerprint === open)
      expect(opened.occurrences).toHaveLength(1)
    })

    test('reduce with no seed starts from the second element', async () => {
      const { report } = await scan(
        lines("['open', 'send'].reduce((a, m) => fill(XMLHttpRequest.prototype, m, w))", fill),
      )

      expect(fingerprints(report)).toEqual([send])
    })
  })

  describe('an argument carries the elements a loop takes out of it', () => {
    const scanMapped = (files: [string, string][]) => scanBuild(mapped(files), [], { deps: { resolver } })
    const fill = 'function fill(source, name, w) { source[name] = w(source[name]) }'

    test.each([
      ['forEach', 'function wrapAll(proto, names, w) { names.forEach(n => fill(proto, n, w)) }', '["open", "send"]'],
      ['for…of', 'function wrapAll(proto, names, w) { for (const n of names) fill(proto, n, w) }', '["open", "send"]'],
      ['a split string', 'function wrapAll(proto, names, w) { names.split(" ").forEach(n => fill(proto, n, w)) }', '"open send"'],
    ])("the app's wrapAll(…) call is looked up for both findings, through %s", async (_, helper, names) => {
      const { report } = await scanMapped([
        [library, fill],
        [library, helper],
        [instrument, `wrapAll(XMLHttpRequest.prototype, ${names}, wrap)`],
      ])

      expect(report.findings.map((finding: Finding) => finding.target.name)).toEqual([
        'XMLHttpRequest.prototype.open',
        'XMLHttpRequest.prototype.send',
      ])
      for (const finding of report.findings) {
        const [occurrence] = finding.occurrences
        // The reported position stays the helper's write, and attribution looks up the app's call.
        expect(occurrence.generated).toMatchObject({ line: 1 })
        expect(occurrence.original).toMatchObject({ source: instrument, line: 1, column: 0 })
      }
    })
  })

  test('the core-js DOM-iterables loop shape: for…in over an inline literal writes each collection prototype', async () => {
    const { report } = await scan(
      lines(
        'var DOMIterables = { CSSRuleList: 0, DOMTokenList: 1, NodeList: 1 };',
        'var ITERATOR = Symbol.iterator;',
        'for (var COLLECTION_NAME in DOMIterables) {',
        '  var Collection = window[COLLECTION_NAME];',
        '  var CollectionPrototype = Collection && Collection.prototype;',
        '  if (DOMIterables[COLLECTION_NAME]) CollectionPrototype[ITERATOR] = ArrayValues;',
        '  else CollectionPrototype[ITERATOR] = ArrayValues;',
        '}',
      ),
    )

    expect(report.findings.map((finding: Finding) => finding.target.name)).toEqual([
      'CSSRuleList.prototype.@@iterator',
      'DOMTokenList.prototype.@@iterator',
      'NodeList.prototype.@@iterator',
    ])
  })

  test("a constant collection's elements decide a loop's early exit", async () => {
    const { report } = await scan(
      lines(
        "var names = ['open', 'abort', 'send'];",
        "for (var i = 0; i < names.length; i++) { XMLHttpRequest.prototype[names[i]] = w; if (names[i] === 'abort') break }",
      ),
    )

    expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.abort|replace|unknown', open])
  })
})

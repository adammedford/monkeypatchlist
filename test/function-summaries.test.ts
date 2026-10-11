// Function summaries (§5 Resolver capabilities 3, §14): a call is instantiated per call site with its constant
// arguments. Summaries compose through helper chains, bind IIFE parameters and fold strings through parameters, so a
// `patch(obj, name, wrapper)` helper resolves. Each summarized call is a `call` trace step. Every scenario goes through
// `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { defaultBudget, jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
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

const core = 'webpack://app/./node_modules/@sentry/core/object.js'
const utils = 'webpack://app/./node_modules/@sentry/browser-utils/history.js'
const sdk = 'webpack://app/./node_modules/@acme/sdk/index.js'

const fingerprints = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.fingerprint)
const kinds = (occurrence: Finding): string[] => occurrence.trace.map((step: Finding) => step.kind)

describe.each(resolvers)('function summaries, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test("a patch(obj, name, fn) helper called as patch(window, 'fetch', w) gives Window.fetch", async () => {
    const { report } = await scan(lines('function patch(obj, name, fn) { obj[name] = fn }', "patch(window, 'fetch', w)"))

    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
  })

  test('a helper chain 3 deep resolves', async () => {
    const { report } = await scan(
      lines(
        'function a(o, n, f) { b(o, n, f) }',
        'function b(o, n, f) { c(o, n, f) }',
        'function c(o, n, f) { o[n] = f }',
        "a(XMLHttpRequest.prototype, 'open', w)",
      ),
    )

    expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.open|replace|unknown'])
    expect(kinds(report.findings[0].occurrences[0])).toEqual(['binding', 'call', 'call', 'call'])
  })

  test('calling the same helper with two targets gives two findings', async () => {
    const { report } = await scan(
      lines('var patch = function (obj, name, fn) { obj[name] = fn }', "patch(window, 'fetch', w)", "patch(history, 'pushState', w)"),
    )

    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown', 'window|history.pushState|replace|unknown'])
  })

  test("patch(XMLHttpRequest.prototype, 'se' + 'nd', w) folds through the parameter", async () => {
    const { report } = await scan(
      lines('const patch = (obj, name, fn) => { obj[name] = fn }', "patch(XMLHttpRequest.prototype, 'se' + 'nd', w)"),
    )

    expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
    expect(kinds(report.findings[0].occurrences[0])).toEqual(['binding', 'call', 'fold'])
  })

  test('IIFE parameters bind to the arguments: (function (g) { g.fetch = w })(window)', async () => {
    const { report } = await scan(
      lines(
        '(function (g) { g.fetch = w })(window);',
        '!function (g, k) { g[k] = w }(this, "setTimeout");',
        '(function (p) { p.send = w }).call(null, XMLHttpRequest.prototype);',
        '(function (p, m) { p[m] = w }).apply(null, [console, "log"])',
      ),
    )

    expect(fingerprints(report)).toEqual([
      'window|Window.fetch|replace|unknown',
      'window|Window.setTimeout|replace|unknown',
      'window|XMLHttpRequest.prototype.send|replace|unknown',
      'window|console.log|replace|unknown',
    ])
  })

  test('a call step records the callee, the call site and the argument bindings', async () => {
    const { report } = await scan(lines('function patch(obj, name, fn) { obj[name] = fn }', "patch(window, 'fetch')"))

    const trace = report.findings[0].occurrences[0].trace
    expect(trace.map((step: Finding) => step.kind)).toEqual(['binding', 'call'])
    expect(trace[1]).toMatchObject({
      kind: 'call',
      callee: 'patch',
      generated: { line: 2, column: 0 },
      function: { line: 1, column: 0 },
      bindings: [
        { parameter: 'obj', argument: 'window' },
        { parameter: 'name', argument: '"fetch"' },
        { parameter: 'fn', argument: null },
      ],
    })
  })

  test("a call step binds a parameter past a spread, in the call or in .apply's array, to that spread", async () => {
    for (const [call, argument] of [
      ['patch(window, ...rest)', '...rest'],
      ['patch.apply(null, [window, ...list])', '...list'],
    ]) {
      const { report } = await scan(lines('function patch(obj, fn) { obj.fetch = fn }', call!))

      const trace = report.findings.flatMap((finding: Finding) => finding.occurrences[0].trace)
      const step = trace.find((each: Finding) => each.kind === 'call')
      expect(step?.bindings.at(-1)).toEqual({ parameter: 'fn', argument })
    }
  })

  test('a default parameter applies when no argument is passed', async () => {
    const { report } = await scan(lines('function patch(obj, name = "fetch") { obj[name] = w }', 'patch(window)'))

    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
  })

  test('what a helper returns is its value at the call: a key or a holder', async () => {
    const { report } = await scan(
      lines(
        'function key(a, b) { return a + b }',
        'function proto(C) { if (C) { return C.prototype } return undefined }',
        'var target = (k) => window[k]',
        'proto(XMLHttpRequest)[key("se", "nd")] = w',
        "target('history').pushState = w",
      ),
    )

    expect(fingerprints(report)).toEqual([
      'window|XMLHttpRequest.prototype.send|replace|unknown',
      'window|history.pushState|replace|unknown',
    ])
  })

  test("a call of a nested function declaration that names a parameter like itself runs the function", async () => {
    // Rollup's New Relic `wrapFn`: `function n(t, n){…}` is called by its name from outside, where `n` is the function.
    const { report } = await scan(
      lines(
        'function make() { return n; function n(t, n) { history.pushState = function () { return t.apply(this, arguments) } } }',
        'make()(history.pushState)',
      ),
    )

    expect(fingerprints(report)).toEqual(['window|history.pushState|wrap|unknown'])
  })

  test('a closure passed to a helper that calls it keeps the bindings of the frame that made it', async () => {
    // webpack's New Relic `wrap-events`: `h(document, p)`, whose callback `p` reads `f` of the function around it.
    const declared = await scan('function f(o){ function p(k){ o[k] = w } h("open", p) } function h(x, cb){ cb(x) } f(XMLHttpRequest.prototype)')
    const inline = await scan('function f(o){ h("open", function(k){ o[k] = w }) } function h(x, cb){ cb(x) } f(XMLHttpRequest.prototype)')

    expect(fingerprints(declared.report)).toEqual(['window|XMLHttpRequest.prototype.open|replace|unknown'])
    expect(fingerprints(inline.report)).toEqual(['window|XMLHttpRequest.prototype.open|replace|unknown'])
  })

  test('a write that no parameter decides is reported once, however many calls there are', async () => {
    const { report } = await scan(lines('function init(x) { window.fetch = w }', 'init(1); init(2)'))

    expect(report.findings.map((finding: Finding) => finding.occurrences.length)).toEqual([1])
  })

  test('a helper with no known call keeps its parameters unknown, and gives nothing', async () => {
    const { report } = await scan(lines('function patch(obj, name) { obj[name] = w }', 'export_(patch)'))

    expect(fingerprints(report)).toEqual([])
  })

  describe('recursion and determinism', () => {
    test('a recursive helper terminates, and its report is byte-identical across runs', async () => {
      const code = lines(
        'function walk(o, names, i) { if (i < 2) { o[names] = w; walk(o, names, i + 1) } }',
        "walk(window, 'fetch', 0)",
        'function r(k) { return r(k) }',
        'window[r("x")] = w',
        'function even(n) { return n ? odd(n) : "fetch" }',
        'function odd(n) { return even(n) }',
        'window[even(0)] = w',
      )
      const first = await scan(code)
      const second = await scan(code)

      expect(fingerprints(first.report)).toEqual(['window|Window.fetch|replace|unknown'])
      const withoutRun = (report: Finding) => JSON.stringify({ ...report, run: null })
      expect(withoutRun(first.report)).toEqual(withoutRun(second.report))
    })

    test('a recursive call that carries a native raises analysis-budget naming the artifact', async () => {
      const { report } = await scan(
        lines('function walk(o, i) { o.fetch = w; if (i) walk(o, i - 1) }', 'walk(window, 3)'),
      )

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      const budget = report.completeness.limitations.filter((record: Finding) => record.kind === 'analysis-budget')
      expect(budget).toHaveLength(1)
      expect(budget[0]).toMatchObject({ artifact: { url: expect.stringContaining('main.js') }, location: { line: 1 } })
      expect(report.completeness.level).toBe('complete-with-limitations')
    })

    test('past the context cap, calls that carry a native merge last, and raise analysis-budget when they merge', async () => {
      const cap = defaultBudget.caps.contexts
      const calls = Array.from({ length: cap + 2 }, () => 'patch(window)')
      const { report } = await scan(lines('function patch(g) { g.fetch = w }', ...calls))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      const budget = report.completeness.limitations.filter((record: Finding) => record.kind === 'analysis-budget')
      // The first cap - 1 calls keep their own frame, and the other 3 merge.
      expect(budget.map((record: Finding) => record.location.line)).toEqual([cap + 1, cap + 2, cap + 3])
    })

    test('past the context cap, calls that carry no native merge first and are only counted', async () => {
      const calls = [...Array.from({ length: defaultBudget.caps.contexts + 2 }, () => 'patch({})'), 'patch(window)']
      const { report } = await scan(lines('function patch(g) { g.fetch = w }', ...calls))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(report.completeness.limitations).toEqual([])
    })

    test('a recursive call that carries no native is only counted', async () => {
      const { report } = await scan(lines('function f(o, i) { o.x = 1; if (i) f(o, i - 1) }', 'f({}, 3)'))

      expect(report.completeness.limitations).toEqual([])
    })

    test('a string naming a catalog member carries no native on its own, so a recursive or merged call is only counted', async () => {
      const merged = Array.from({ length: defaultBudget.caps.contexts + 2 }, () => "set({}, 'value')")
      const { report } = await scan(
        lines(
          'function f(o, k, i) { o[k] = 1; if (i) f(o, k, i - 1) }',
          "f({}, 'fetch', 3)",
          'function set(o, k) { o[k] = 1 }',
          ...merged,
        ),
      )

      expect(report.completeness.limitations).toEqual([])
    })

    test('a string naming a member of a native holder the same call passes carries it', async () => {
      const { report } = await scan(
        lines('function walk(o, k, i) { o[k] = w; if (i) walk(o, k, i - 1) }', "walk(XMLHttpRequest.prototype, 'send', 3)"),
      )

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
      const budget = report.completeness.limitations.filter((record: Finding) => record.kind === 'analysis-budget')
      expect(budget).toHaveLength(1)
    })
  })

  describe('the lookup of a write inside a helper (§10)', () => {
    const scanMapped = (files: [string, string][]) => scanBuild(mapped(files), [], { deps: { resolver } })

    test('looks up the outermost call whose arguments carry both the holder and the member, and keeps the write as its position', async () => {
      const { report } = await scanMapped([
        [core, 'function fill(source, name, replacement) { source[name] = replacement }'],
        [utils, 'fill(window.history, "pushState", wrap)'],
      ])

      expect(fingerprints(report)).toEqual(['window|history.pushState|replace|pkg:@sentry/browser-utils'])
      const [occurrence] = report.findings[0].occurrences
      // The reported position stays the helper's write, on line 1.
      expect(occurrence.generated).toMatchObject({ line: 1, column: 43 })
      expect(occurrence.original).toMatchObject({ source: utils, line: 1, column: 0 })
      expect(occurrence.trace.at(-1)).toMatchObject({ kind: 'token-check', result: 'passed', token: 'pushState' })
    })

    test('through a chain, the outermost call that carries both wins', async () => {
      const { report } = await scanMapped([
        [core, 'function fill(o, n, f) { o[n] = f }'],
        [core, 'function wrapMethod(o, n) { fill(o, n, w) }'],
        [sdk, 'wrapMethod(XMLHttpRequest.prototype, "send")'],
      ])

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|pkg:@acme/sdk'])
    })

    test('an argument that carries part of a member the helper builds carries the member', async () => {
      const { report } = await scanMapped([
        [core, 'function set(o, n) { o["set" + n] = w }'],
        [utils, 'set(window, "Timeout")'],
      ])

      expect(fingerprints(report)).toEqual(['window|Window.setTimeout|replace|pkg:@sentry/browser-utils'])
    })

    test('when no call carries both, the helper write is looked up', async () => {
      const { report } = await scanMapped([
        [core, 'function patchFetch(g) { g.fetch = w }'],
        [utils, 'patchFetch(window)'],
      ])

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|pkg:@sentry/core'])
    })
  })
})

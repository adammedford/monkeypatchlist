// Holders chosen at runtime (§4 A holder chosen at runtime, §5 Resolver capabilities 8, §14 `catalog-holder`): a
// runtime choice (`hasOwnProperty.call(history, m) ? history : History.prototype`) or a prototype walk to the first owner
// gives one target, decided against the unmutated catalog, and the trace records that the catalog chose it. Target
// confidence stays `high`. Every scenario goes through `monkeypatchlist scan --json`, with both binding resolvers behind the
// seam.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** The target names of the report's findings. */
const found = (report: Report): string[] => report.findings.map((finding: Report) => finding.target.name)

/** The trace step kinds of a finding's first occurrence. */
const kinds = (finding: Report): string[] => finding.occurrences[0].trace.map((step: Report) => step.kind)

/** The `catalog-holder` steps of a finding's first occurrence. */
const chosen = (finding: Report): Report[] =>
  finding.occurrences[0].trace.filter((step: Report) => step.kind === 'catalog-holder')

describe.each(resolvers)('holders chosen at runtime, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe('a runtime choice by an own-property test', () => {
    test('hasOwnProperty.call(history, m) ? history : History.prototype gives History.prototype.pushState', async () => {
      const { report } = await scan(
        classic(
          lines(
            "var m = 'pushState'",
            'var hasOwnProperty = Object.prototype.hasOwnProperty',
            ';(hasOwnProperty.call(history, m) ? history : History.prototype)[m] = w',
          ),
        ),
      )

      expect(found(report)).toEqual(['History.prototype.pushState'])
      const [finding] = report.findings
      expect(kinds(finding)).toContain('catalog-holder')
      expect(chosen(finding)).toEqual([
        expect.objectContaining({ kind: 'catalog-holder', tested: 'history', member: 'pushState', owns: false }),
      ])
      expect(finding.confidence.target).toEqual({ level: 'high', reasons: [] })
    })

    test.each([
      ['Object.hasOwn(history, m)'],
      ['Object.prototype.hasOwnProperty.call(history, m)'],
      ['{}.hasOwnProperty.call(history, m)'],
      ['Object.prototype.hasOwnProperty.apply(history, [m])'],
      ['history.hasOwnProperty(m)'],
      ['window.hasOwnProperty.call(history, m)'],
      ['hasOwnProperty.call(history, m)'],
      ['Reflect.apply(Object.prototype.hasOwnProperty, history, [m])'],
      ['(0, Object.hasOwn)(history, m)'],
      ['Object["hasOwn"](history, m)'],
    ])('the own-property test %s is decided by the catalog, as every ECMA-262 route with its meaning is', async (test) => {
      const { report } = await scan(classic(`var m = 'pushState'\n;(${test} ? history : History.prototype)[m] = w`))

      expect(found(report)).toEqual(['History.prototype.pushState'])
      expect(chosen(report.findings[0])).toEqual([
        expect.objectContaining({ tested: 'history', member: 'pushState', owns: false }),
      ])
      expect(report.findings[0].confidence.target.level).toBe('high')
    })

    test('a holder that owns the member is the one taken: Object.hasOwn(window, m) ? window : Window.prototype', async () => {
      const { report } = await scan(classic("(function () {\n  var m = 'fetch'\n  ;(Object.hasOwn(window, m) ? window : Window.prototype)[m] = w\n})()"))

      expect(found(report)).toEqual(['Window.fetch'])
      expect(chosen(report.findings[0])).toEqual([expect.objectContaining({ tested: 'Window', member: 'fetch', owns: true })])
    })

    test('a user object is not decided by the catalog, so both holders stay', async () => {
      const { report } = await scan(classic("var m = 'pushState'\n;(Object.hasOwn(api, m) ? history : History.prototype)[m] = w"))

      expect(found(report)).not.toEqual(['History.prototype.pushState'])
    })
  })

  describe('a prototype walk to the first owner, simulated per start value', () => {
    // zone.js's walk, with `f` an alias of `Object.getPrototypeOf`, in a bundle's module function.
    const zone = (call: string) =>
      lines(
        ';(function () {',
        '  var f = Object.getPrototypeOf',
        '  function x(e, t, n) { let o = e; for (; o && !Object.hasOwn(o, t); ) o = f(o); o[t] = n(o[t]) }',
        `  ${call}`,
        '})()',
      )

    test.each([
      ["x(window, 'addEventListener', wrap)", 'EventTarget.prototype.addEventListener', ['Window', 'Window.prototype', 'WindowProperties', 'EventTarget.prototype']],
      ["x(XMLHttpRequest.prototype, 'addEventListener', wrap)", 'EventTarget.prototype.addEventListener', ['XMLHttpRequest.prototype', 'XMLHttpRequestEventTarget.prototype', 'EventTarget.prototype']],
      ["x(XMLHttpRequest.prototype, 'open', wrap)", 'XMLHttpRequest.prototype.open', ['XMLHttpRequest.prototype']],
      ["x(window, 'fetch', wrap)", 'Window.fetch', ['Window']],
    ])('%s gives %s, one target at high confidence, with a catalog-holder step', async (call, name, walk) => {
      const { report } = await scan(classic(zone(call)))

      expect(found(report)).toEqual([name])
      const [finding] = report.findings
      expect(finding.confidence.target).toEqual({ level: 'high', reasons: [] })
      expect(chosen(finding)).toContainEqual(
        expect.objectContaining({ walk, holder: walk.at(-1), member: name.slice(walk.at(-1)!.length + 1) }),
      )
    })

    test('each start value is walked on its own: one walk function called from window and XMLHttpRequest.prototype', async () => {
      const { report } = await scan(classic(zone("x(window, 'fetch', wrap)\nx(XMLHttpRequest.prototype, 'send', wrap)")))

      expect(found(report).toSorted()).toEqual(['Window.fetch', 'XMLHttpRequest.prototype.send'])
    })

    test.each([
      ['while (o && !o.hasOwnProperty(k)) o = Object.getPrototypeOf(o)'],
      ['while (!Object.prototype.hasOwnProperty.call(o, k)) { o = Reflect.getPrototypeOf(o) }'],
      ['while (o != null && !Object.hasOwn(o, k)) o = o.__proto__'],
      ['for (; !Object.hasOwn(o, k); o = Object.getPrototypeOf(o));'],
      ['do { if (Object.hasOwn(o, k)) break; o = Object.getPrototypeOf(o) } while (o)'],
    ])('the walk %s is simulated through every own-property test and prototype step', async (loop) => {
      const code = lines('function owner(o, k) {', `  ${loop}`, '  return o', '}', "var p = owner(window, 'addEventListener')", "p.addEventListener = wrap(p.addEventListener)")
      const { report } = await scan(classic(code))

      expect(found(report)).toEqual(['EventTarget.prototype.addEventListener'])
    })

    // zone.js's `patchEventTarget`: after the walk, `!proto && obj[k]` would re-add the start object, but
    // ECMA-262 decides `!proto` false for the native holder the catalog chose, so that assignment never runs.
    test.each([
      ['!o && e[t] && (o = e)'],
      ['if (!o && e[t]) { o = e }'],
      ['if (o == null && e[t]) o = e'],
      ['if (!o) o = e'],
      ['if (!o && e[t] && (o = e), !o) return false'],
      ['o || (o = e)'],
      ['o = o ? o : e'],
    ])('a test of the walk result, %s, does not re-add the start object', async (readd) => {
      const code = lines(
        ';(function () {',
        '  var f = Object.getPrototypeOf',
        `  function x(e, t, n) { let o = e; for (; o && !Object.hasOwn(o, t); ) o = f(o); ${readd}; if (!o) return false; o[t] = n(o[t]) }`,
        "  x(XMLHttpRequestEventTarget.prototype, 'addEventListener', wrap)",
        '})()',
      )
      const { report } = await scan(classic(code))

      expect(found(report)).toEqual(['EventTarget.prototype.addEventListener'])
    })

    test('a test that another definition after the walk also reaches keeps the start object it re-adds', async () => {
      const code = lines(
        ';(function () {',
        '  function x(e, t, n, c) { let o = e; while (o && !Object.hasOwn(o, t)) o = Object.getPrototypeOf(o); if (c) o = null; if (!o) o = e; o[t] = n(o[t]) }',
        "  x(XMLHttpRequestEventTarget.prototype, 'addEventListener', wrap, cond)",
        '})()',
      )
      const { report } = await scan(classic(code))

      expect(found(report).toSorted()).toEqual([
        'EventTarget.prototype.addEventListener',
        'XMLHttpRequestEventTarget.prototype.addEventListener',
      ])
    })

    test('a walk result that can be null keeps the start object a test of it re-adds', async () => {
      const code = lines(
        ';(function () {',
        '  function x(e, t, n) { let o = e; while (o && !Object.hasOwn(o, t)) o = Object.getPrototypeOf(o); if (!o) o = e; o[t] = n(o[t]) }',
        "  x(XMLHttpRequest.prototype, 'nope', wrap)",
        '})()',
      )
      const { report } = await scan(classic(code))

      expect(found(report)).toEqual(['XMLHttpRequest.prototype.nope'])
    })

    // New Relic's walk: a `typeof … === 'object'` test, decided at each step, since `typeof` of a native
    // holder is `'object'` (Principle 2), and the result passed on under `if (step)`.
    const newRelic = (test: string, ...calls: string[]) =>
      lines(
        ';(function () {',
        "  var rc = 'addEventListener', Cd = 'removeEventListener'",
        '  function wrapNode(node) { node[rc] = wrap(node[rc]); node[Cd] = wrap(node[Cd]) }',
        `  function tc(t, e) { let i = t; for (; ${test} && !Object.prototype.hasOwnProperty.call(i, rc); ) i = Object.getPrototypeOf(i); i && e(i) }`,
        ...calls.map((call) => `  ${call}`),
        '})()',
      )

    test.each([["typeof i == 'object'"], ["typeof i === 'object'"], ["'object' === typeof i"], ["!(typeof i !== 'object')"]])(
      'the walk tested by %s reaches the first owner from document, XMLHttpRequest.prototype and window',
      async (test) => {
        const code = newRelic(test, 'tc(document, wrapNode)', 'tc(XMLHttpRequest.prototype, wrapNode)', 'tc(window, wrapNode)')
        const { report } = await scan(classic(code))

        expect(found(report).toSorted()).toEqual([
          'EventTarget.prototype.addEventListener',
          'EventTarget.prototype.removeEventListener',
        ])
        const finding = report.findings.find((each: Report) => each.target.name === 'EventTarget.prototype.addEventListener')
        expect(finding.confidence.target).toEqual({ level: 'high', reasons: [] })
        expect(chosen(finding)).toContainEqual(
          expect.objectContaining({
            walk: ['document', 'HTMLDocument.prototype', 'Document.prototype', 'Node.prototype', 'EventTarget.prototype'],
            holder: 'EventTarget.prototype',
          }),
        )
      },
    )

    test.each([
      ["var o = window; if (c) { while (o && !Object.hasOwn(o, 'addEventListener')) o = Object.getPrototypeOf(o) }"],
      ["var o; if (c) o = window; else { o = history; while (o && !Object.hasOwn(o, 'addEventListener')) o = Object.getPrototypeOf(o) }"],
    ])('a walk that not every path to the read runs is not taken as its answer: %s', async (code) => {
      const { report } = await scan(classic(`(function (c) { ${code}; o.addEventListener = w })(x)`))

      expect(found(report)).not.toEqual(['EventTarget.prototype.addEventListener'])
    })
  })

  describe('a prototype step by every ECMA-262 route with its meaning', () => {
    test('window.__proto__.__proto__.addEventListener = w gives WindowProperties.addEventListener', async () => {
      const { report } = await scan(classic('window.__proto__.__proto__.addEventListener = w'))

      expect(found(report)).toEqual(['WindowProperties.addEventListener'])
      expect(chosen(report.findings[0])).toEqual([
        expect.objectContaining({ expression: 'window.__proto__', prototypeOf: 'Window', holder: 'Window.prototype' }),
        expect.objectContaining({ expression: 'window.__proto__.__proto__', prototypeOf: 'Window.prototype', holder: 'WindowProperties' }),
      ])
    })

    test('Reflect.getPrototypeOf, directly or through an alias, is a prototype step', async () => {
      const { report } = await scan(
        classic(
          lines(
            'Reflect.getPrototypeOf(Window.prototype).addEventListener = w',
            ';(function () { var g = Reflect.getPrototypeOf; g(XMLHttpRequest.prototype).addEventListener = w })()',
          ),
        ),
      )

      expect(found(report).toSorted()).toEqual(['WindowProperties.addEventListener', 'XMLHttpRequestEventTarget.prototype.addEventListener'])
    })

    test('Object.prototype.__proto__ is null, and a __proto__ read on a user object is no prototype step', async () => {
      const { report } = await scan(classic(lines('Object.prototype.__proto__.x = 1', '({}).__proto__.toString = f')))

      expect(found(report)).toEqual([])
    })
  })

  describe('structural members do not count toward first ownership when the member does not fold', () => {
    test('history owns no catalog member, so hasOwnProperty.call(history, cfg.name) is false', async () => {
      const code = '(function (k) { (Object.hasOwn(history, k) ? history : History.prototype).pushState = w })(cfg.name)'
      const { report } = await scan(classic(code))

      expect(found(report)).toEqual(['History.prototype.pushState'])
      expect(chosen(report.findings[0])).toEqual([expect.objectContaining({ tested: 'history', owns: false })])
      expect(chosen(report.findings[0])[0]).not.toHaveProperty('member')
    })

    test('Window.prototype owns only constructor and @@toStringTag, so it is never a first owner', async () => {
      const code =
        '(function (k) { (Object.hasOwn(Window.prototype, k) ? Window.prototype : EventTarget.prototype).addEventListener = w })(cfg.name)'
      const { report } = await scan(classic(code))

      expect(found(report)).toEqual(['EventTarget.prototype.addEventListener'])
      expect(chosen(report.findings[0])).toEqual([expect.objectContaining({ tested: 'Window.prototype', owns: false })])
    })

    test('a holder that owns a member other than a structural one stays undecided', async () => {
      const code = '(function (k) { (Object.hasOwn(EventTarget.prototype, k) ? history : History.prototype).pushState = w })(cfg.name)'
      const { report } = await scan(classic(code))

      expect(found(report)).not.toEqual(['History.prototype.pushState'])
    })
  })
})

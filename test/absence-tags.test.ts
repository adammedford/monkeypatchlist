// Absence tags on values (§5 Resolver capabilities 7, §7): a holder or value chosen on a branch where a native is absent
// keeps `guarded-native-absence` wherever it is later written, through variables, parameters and heap fields. The
// absence of any native counts, not only the target's. Every scenario goes through `monkeypatchlist scan --json`.

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
type Report = any

/** Each finding's target name and effect, with its reachability. */
const reachabilities = (report: Report): Record<string, string> =>
  Object.fromEntries(
    report.findings.map((finding: Report) => [`${finding.target.name} ${finding.effect}`, finding.reachability]),
  )

/** The `guard` steps of a finding's first occurrence: their expression, class, tested native and result. */
const guardSteps = (report: Report, name: string): Report[] =>
  report.findings
    .find((finding: Report) => finding.target.name === name)
    .occurrences[0].trace.filter((step: Report) => step.kind === 'guard')
    .map((step: Report) => ({ expression: step.expression, class: step.class, tested: step.tested, result: step.result }))

describe.each(resolvers)('absence tags on values, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = async (code: string) => (await scanBuild(classic(code), [], { deps: { resolver } })).report

  test('a value chosen on a native-absent branch and written later through a variable gives `guarded-native-absence`', async () => {
    const report = await scan('var impl = window.fetch || polyfill; window.fetch = impl')

    expect(reachabilities(report)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
    expect(guardSteps(report, 'Window.fetch')).toEqual([
      { expression: 'window.fetch', class: 'absence', tested: 'Window.fetch', result: 'guarded-native-absence' },
    ])
  })

  test('a holder chosen on a native-absent branch and written through later keeps `guarded-native-absence`', async () => {
    const report = await scan('var g = window.fetch ? {} : window; g.fetch = polyfill')

    expect(reachabilities(report)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
    expect(guardSteps(report, 'Window.fetch')).toEqual([
      { expression: 'window.fetch', class: 'absence', tested: 'Window.fetch', result: 'guarded-native-absence' },
    ])
  })

  test('a value assigned in a native-absent arm and written after it keeps the tag', async () => {
    const report = await scan('var impl = window.fetch; if (!window.fetch) { impl = polyfill } window.fetch = impl')

    expect(reachabilities(report)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
  })

  test('a value chosen on a native-absent branch and written through a parameter keeps the tag', async () => {
    const value = await scan('function install(fn){ window.fetch = fn } install(window.fetch || polyfill)')
    const holder = await scan('function install(g){ g.fetch = polyfill } install(window.fetch ? {} : window)')

    expect(reachabilities(value)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
    expect(reachabilities(holder)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
  })

  test('a value chosen on a native-absent branch and written through a heap field keeps the tag', async () => {
    const value = await scan('var s = {}; s.impl = window.fetch || polyfill; window.fetch = s.impl')
    const holder = await scan('var s = { g: window.fetch ? {} : window }; s.g.fetch = polyfill')

    expect(reachabilities(value)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
    expect(reachabilities(holder)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
  })

  test('a chain of variables, parameters and heap fields carries the tag along', async () => {
    const report = await scan(
      'var impl = typeof window.fetch === "function" ? window.fetch : polyfill; var s = { f: impl };' +
        'function install(o){ var fn = o.f; window.fetch = fn } install(s)',
    )

    expect(reachabilities(report)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
  })

  test('a branch guarded on the absence of a different native tags the value and the holder too', async () => {
    const value = await scan('var impl = window.Promise ? window.fetch : polyfill; window.fetch = impl')
    const holder = await scan('var g = typeof Promise === "undefined" ? window : {}; g.fetch = polyfill')

    expect(reachabilities(value)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
    expect(guardSteps(value, 'Window.fetch')).toEqual([
      { expression: 'window.Promise', class: 'absence', tested: 'Window.Promise', result: 'guarded-native-absence' },
    ])
    expect(reachabilities(holder)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
    expect(guardSteps(holder, 'Window.fetch')).toEqual([
      {
        expression: 'typeof Promise === "undefined"',
        class: 'absence',
        tested: 'Window.Promise',
        result: 'guarded-native-absence',
      },
    ])
  })

  test('merging a tagged value with an untagged one follows the OR rule', async () => {
    const untagged = await scan('var impl = window.fetch ? other : polyfill; window.fetch = impl')
    const both = await scan('var impl = !window.fetch ? polyfill : !window.Promise ? other : window.fetch; window.fetch = impl')
    const holders = await scan('var g = window.fetch ? self : window; g.fetch = polyfill')
    const callers = await scan(
      'function install(fn){ window.fetch = fn } install(window.fetch || polyfill); install(other)',
    )

    expect(reachabilities(untagged)).toEqual({ 'Window.fetch replace': 'unconditional' })
    expect(reachabilities(both)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
    expect(reachabilities(holders)).toEqual({ 'Window.fetch replace': 'unconditional' })
    expect(reachabilities(callers)).toEqual({ 'Window.fetch replace': 'unconditional' })
  })

  test('a variable whose start value reaches the write is untagged', async () => {
    const report = await scan('var impl; if (!window.fetch) { impl = polyfill } window.fetch = impl')

    expect(reachabilities(report)).toEqual({ 'Window.fetch replace': 'unconditional' })
  })

  test('each effect of a value whose alternatives differ in wrap evidence takes the tags of its own alternatives', async () => {
    const report = await scan('var impl = window.fetch ? wrap(window.fetch) : polyfill; window.fetch = impl')

    expect(reachabilities(report)).toEqual({
      'Window.fetch replace': 'guarded-native-absence',
      'Window.fetch wrap': 'unconditional',
    })
  })

  test('a value chosen on a branch that only tests a config flag keeps no tag', async () => {
    const report = await scan('var impl = cfg.native ? window.fetch : polyfill; window.fetch = impl')

    expect(reachabilities(report)).toEqual({ 'Window.fetch replace': 'unconditional' })
  })

  test('a define through a holder or descriptor value chosen on a native-absent branch keeps the tag', async () => {
    const holder = await scan('var g = window.fetch ? {} : window; Object.defineProperty(g, "fetch", { value: polyfill })')
    const value = await scan(
      'function polyfill(){} var impl = window.fetch; if (!window.fetch) impl = polyfill;' +
        'Object.defineProperty(window, "fetch", { value: impl })',
    )

    expect(reachabilities(holder)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
    expect(reachabilities(value)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
  })

  test("another window's copy is no write-back, and a falsy left side of `||` is no alternative", async () => {
    const report = await scan(
      'var f = document.createElement("iframe"); document.body.appendChild(f);' +
        'window.fetch = (null == (w = f.contentWindow) ? void 0 : w.fetch) || window.fetch',
    )

    // The clean copy is chosen when the iframe's window is there, so the write keeps no tag.
    expect(reachabilities(report)).toEqual({ 'Window.fetch replace': 'unconditional' })
  })

  test('a holder alternative whose global object was reached elsewhere still counts', async () => {
    const report = await scan(
      'var r = function(){}; r.g = function(){ if (typeof globalThis === "object") return globalThis; return window }();' +
        '(function(){ var g = void 0 !== r.g ? r.g : self; g.fetch = polyfill })()',
    )

    // `self` is chosen only when `r.g`, the global object, is missing, but `r.g` is chosen otherwise.
    expect(reachabilities(report)).toEqual({ 'Window.fetch replace': 'unconditional' })
  })

  test.each([
    ['`?:`', '(window.EventTarget ? EventTarget.prototype : Node.prototype).addEventListener = polyfill'],
    ['`||`', '(self.EventTarget && EventTarget.prototype || Node.prototype).addEventListener = polyfill'],
    ['`??`', '(globalThis.EventTarget ?? Node).prototype.addEventListener = polyfill'],
  ])('a native holder read from the global object may be absent, so %s takes the arm where it is missing', async (_, code) => {
    const report = await scan(code)

    expect(reachabilities(report)['Node.prototype.addEventListener replace']).toBe('guarded-native-absence')
    expect(Object.keys(reachabilities(report)).length).toBe(2)
  })

  test('a holder chosen where a native holder read from the global object is missing keeps the tag', async () => {
    const report = await scan('var g = window.Promise ? {} : window; g.fetch = polyfill')

    expect(reachabilities(report)).toEqual({ 'Window.fetch replace': 'guarded-native-absence' })
  })

  test('a holder an iteration native visits keeps the tag of the arm its array literal is in', async () => {
    const report = await scan(
      'var l = self.EventTarget ? [EventTarget.prototype] : [Node.prototype, Window.prototype]; l.forEach(function (p) { p.addEventListener = polyfill })',
    )

    expect(reachabilities(report)).toEqual({
      'EventTarget.prototype.addEventListener replace': 'unconditional',
      'Node.prototype.addEventListener replace': 'guarded-native-absence',
      'Window.prototype.addEventListener replace': 'guarded-native-absence',
    })
  })

  test("a catalog check of a holder that may be missing still rules its arm out: the missing holder's lookup throws", async () => {
    // Sentry 7's `_wrapEventTarget`: `Node.prototype` owns no `addEventListener`, and `undefined.hasOwnProperty` throws.
    const report = await scan(
      '["EventTarget", "Node"].forEach(function (n) { var r = window[n] && window[n].prototype;' +
        ' !r || !r.hasOwnProperty("addEventListener") || (r.addEventListener = polyfill) })',
    )

    expect(Object.keys(reachabilities(report))).toEqual(['EventTarget.prototype.addEventListener replace'])
  })

  test.each([
    ['the global object', '(window ? EventTarget.prototype : Node.prototype).addEventListener = polyfill'],
    ['a bare global name', '(EventTarget ? EventTarget.prototype : Node.prototype).addEventListener = polyfill'],
    ['a prototype', '(window.EventTarget.prototype ? EventTarget.prototype : Node.prototype).addEventListener = polyfill'],
    ['a constructor read from a prototype', '(window.Node.prototype.constructor ? EventTarget.prototype : Node.prototype).addEventListener = polyfill'],
    ['a holder that ends `||`', '((window.EventTarget || {}) ? EventTarget.prototype : Node.prototype).addEventListener = polyfill'],
    ['a holder that ends `??`', '((window.EventTarget ?? {}) ? EventTarget.prototype : Node.prototype).addEventListener = polyfill'],
  ])('%s is always present, so its missing arm is never taken', async (_, code) => {
    const report = await scan(code)

    expect(Object.keys(reachabilities(report))).toEqual(['EventTarget.prototype.addEventListener replace'])
  })
})

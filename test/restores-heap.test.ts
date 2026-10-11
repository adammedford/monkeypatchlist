// Restores through heap fields and descriptors (§3 Restores, §14 `restore`): a saved native carried in a heap field,
// and a define-property whose descriptor is the slot's `getOwnPropertyDescriptor` or a fresh literal carrying the saved
// native as `value`, put back the unmutated native. Every scenario goes through `monkeypatchlist scan --json`.

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

/** Each finding as `target|effect`, with the positions of its occurrences as `line:column`. */
const findings = (report: Report): Record<string, string[]> =>
  Object.fromEntries(
    report.findings.map((finding: Report) => [
      `${finding.target.name}|${finding.effect}`,
      finding.occurrences.map((o: Report) => `${o.generated.line}:${o.generated.column}`),
    ]),
  )

/** The `restore` steps on every occurrence of every finding, by finding, without their text. */
const restoreSteps = (report: Report): Record<string, Report[]> =>
  Object.fromEntries(
    report.findings.flatMap((finding: Report) => {
      const steps = finding.occurrences.flatMap((o: Report) =>
        o.trace
          .filter((step: Report) => step.kind === 'restore')
          .map(({ generated, guard, leavesOwnShadow }: Report) => ({
            at: `${generated.line}:${generated.column}`,
            guard,
            leavesOwnShadow,
          })),
      )
      return steps.length === 0 ? [] : [[finding.target.name, steps]]
    }),
  )

describe.each(resolvers)('restores through heap fields and descriptors, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = async (code: string) => (await scanBuild(classic(code), [], { deps: { resolver } })).report

  test('a native saved in a heap field and written back is a proven restore with a restore entry', async () => {
    const report = await scan(
      'var saved = {};\nsaved.log = console.log;\nconsole.log = function () { return saved.log.apply(console, arguments); };\n' +
        'window.__teardown = function () { console.log = saved.log; };',
    )

    expect(findings(report)).toEqual({ 'console.log|wrap': ['3:0'] })
    expect(restoreSteps(report)).toEqual({ 'console.log': [{ at: '4:34', guard: 'none', leavesOwnShadow: false }] })
  })

  test('a heap field that may also hold a non-native value is not proven: the restore joins its install', async () => {
    const report = await scan(
      'var saved = {};\nsaved.log = console.log;\nconsole.log = function () { return saved.log.apply(console, arguments); };\n' +
        'window.__teardown = function () { console.log = saved.log; saved.log = null };',
    )

    expect(findings(report)).toEqual({ 'console.log|wrap': ['3:0', '4:34'] })
    expect(restoreSteps(report)).toEqual({})
  })

  const instrumentation =
    'function I() {}\n' +
    'I.prototype.enable = function () { this._orig = window.fetch; var s = this; window.fetch = function () { return s._orig.apply(this, arguments) } };\n' +
    'I.prototype.disable = function () { window.fetch = this._orig };\n'

  test('`this._orig` saved in `enable()` and written back in `disable()` is a proven restore', async () => {
    const report = await scan(instrumentation + 'var i = new I(); i.enable(); window.__teardown = function () { i.disable() };')

    expect(findings(report)).toEqual({ 'Window.fetch|wrap': ['2:76'] })
    expect(restoreSteps(report)).toEqual({ 'Window.fetch': [{ at: '3:36', guard: 'none', leavesOwnShadow: false }] })
  })

  test('an instance passed to an unresolved registry keeps its `this._orig`, and its restore is still proven', async () => {
    const report = await scan(
      instrumentation + 'var i = new I(); registerInstrumentations([i]); i.enable(); window.__teardown = function () { i.disable() };',
    )

    expect(findings(report)).toEqual({ 'Window.fetch|wrap': ['2:76'] })
    expect(restoreSteps(report)).toEqual({ 'Window.fetch': [{ at: '3:36', guard: 'none', leavesOwnShadow: false }] })
  })

  test('a define of the slot’s own `getOwnPropertyDescriptor` is a proven descriptor restore', async () => {
    const report = await scan(
      "var d = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'send');\n" +
        "Object.defineProperty(XMLHttpRequest.prototype, 'send', { value: function () {}, configurable: true, writable: true });\n" +
        "window.__teardown = function () { Object.defineProperty(XMLHttpRequest.prototype, 'send', d) };",
    )

    expect(findings(report)).toEqual({ 'XMLHttpRequest.prototype.send|replace': ['2:0'] })
    expect(restoreSteps(report)).toEqual({
      'XMLHttpRequest.prototype.send': [{ at: '3:34', guard: 'none', leavesOwnShadow: false }],
    })
  })

  test('a descriptor restore with a `||` fallback the catalog makes dead is proven (rrweb hookSetter)', async () => {
    const report = await scan(
      'function hook(t, k) {\n  var d = Object.getOwnPropertyDescriptor(t, k);\n' +
        '  Object.defineProperty(t, k, { set: function (v) { d.set.call(this, v); } });\n' +
        '  return function () { Object.defineProperty(t, k, d || {}); };\n}\n' +
        "window.__teardown = hook(HTMLInputElement.prototype, 'value');",
    )

    expect(findings(report)).toEqual({ 'HTMLInputElement.prototype.value|descriptor-change': ['3:2'] })
    expect(restoreSteps(report)).toEqual({
      'HTMLInputElement.prototype.value': [{ at: '4:23', guard: 'none', leavesOwnShadow: false }],
    })
  })

  test('a descriptor of the inherited holder, carried in a heap field, restores an own shadow', async () => {
    const report = await scan(
      'function B() {}\n' +
        "B.prototype.start = function () { var cd = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie') || Object.getOwnPropertyDescriptor(HTMLDocument.prototype, 'cookie'); this._cd = cd; " +
        "Object.defineProperty(document, 'cookie', { get: function () { return cd.get.call(document) }, set: function (v) { cd.set.call(document, v) }, configurable: true }) };\n" +
        "B.prototype.stop = function () { Object.defineProperty(document, 'cookie', this._cd) };\n" +
        'var b = new B(); b.start(); window.__teardown = function () { b.stop() };',
    )

    expect(findings(report)).toEqual({ 'document.cookie|descriptor-change': ['2:190'] })
    expect(restoreSteps(report)).toEqual({ 'document.cookie': [{ at: '3:33', guard: 'none', leavesOwnShadow: true }] })
  })

  test('`getOwnPropertyDescriptor(History.prototype, …)` defined back on `history` restores its shadow', async () => {
    const report = await scan(
      'var w = function () {};\nhistory.pushState = w;\n' +
        "window.__teardown = function () { Object.defineProperty(history, 'pushState', Object.getOwnPropertyDescriptor(History.prototype, 'pushState')) };",
    )

    expect(findings(report)).toEqual({ 'history.pushState|replace': ['2:0'] })
    expect(restoreSteps(report)).toEqual({ 'history.pushState': [{ at: '3:34', guard: 'none', leavesOwnShadow: true }] })
  })

  test('a descriptor with a field written to it puts back no native: the define follows the ordinary rules', async () => {
    const report = await scan(
      "var d = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'send');\n" +
        "Object.defineProperty(XMLHttpRequest.prototype, 'send', { value: function () {}, configurable: true, writable: true });\n" +
        "window.__teardown = function () { d.writable = false; Object.defineProperty(XMLHttpRequest.prototype, 'send', d) };",
    )

    expect(findings(report)).toEqual({
      'XMLHttpRequest.prototype.send|replace': ['2:0'],
      'XMLHttpRequest.prototype.send|descriptor-change': ['3:54'],
    })
    expect(restoreSteps(report)).toEqual({})
  })

  const shimmer =
    'function wn(t,e,n){const r=!!t[e]&&Object.prototype.propertyIsEnumerable.call(t,e);Object.defineProperty(t,e,{configurable:!0,enumerable:r,writable:!0,value:n})}\n' +
    'const Cn=(t,e,n)=>{if(!t||!t[e])return;const r=t[e];if("function"!=typeof r||"function"!=typeof n)return;const s=n(r,e);' +
    'return wn(s,"__original",r),wn(s,"__unwrap",()=>{t[e]===s&&wn(t,e,r)}),wn(s,"__wrapped",!0),wn(t,e,s),s};\n' +
    'const An=(t,e)=>{const n=t[e];n.__unwrap?n.__unwrap():0};\n' +
    'const f=function(o){return function(){return o.apply(this,arguments)}};\n'

  test('a shimmer unwrap is a proven restore, on an own member and on an own shadow', async () => {
    const report = await scan(
      shimmer +
        "Cn(window,'fetch',f);Cn(EventTarget.prototype,'addEventListener',f);Cn(history,'pushState',f);\n" +
        "window.__teardown=function(){An(window,'fetch');An(EventTarget.prototype,'addEventListener');An(history,'pushState')};",
    )

    // The shimmer's factory is given the original, so each install is a `wrap`.
    expect(Object.keys(findings(report)).sort()).toEqual([
      'EventTarget.prototype.addEventListener|wrap',
      'Window.fetch|wrap',
      'history.pushState|wrap',
    ])
    expect(findings(report)['Window.fetch|wrap']).toEqual(['1:83'])
    expect(restoreSteps(report)).toEqual({
      'Window.fetch': [{ at: '1:83', guard: 'none', leavesOwnShadow: false }],
      'EventTarget.prototype.addEventListener': [{ at: '1:83', guard: 'none', leavesOwnShadow: false }],
      'history.pushState': [{ at: '1:83', guard: 'none', leavesOwnShadow: true }],
    })
  })

  test('a callback a resolved call reaches is never framed from its creation site: no second occurrence', async () => {
    // Sentry's `instrumentHistory`, inside a module wrapper, is run by `maybeInstrument`'s callback call only.
    const report = await scan(
      '(function () {\nvar Ps = window;\n' +
        'function A(t,n,r){ if(!(n in t))return; const s=t[n]; if("function"!=typeof s)return; t[n]=r(s) }\n' +
        'var An={}; function Ln(t,n){ if(!An[t]){An[t]=!0; n()} }\n' +
        'function yo(){ function t(t){return function(){return t.apply(this,arguments)}} "history" in Ps && Ps.history && A(Ps.history,"pushState",t) }\n' +
        'window.__init = function(cfg){ if (cfg.history) Ln("history", yo) };\n})();',
    )

    expect(findings(report)).toEqual({ 'history.pushState|wrap': ['3:86'] })
    expect(report.findings[0].reachability).toBe('conditional')
  })

  test('a fresh literal carrying the native with an attribute that differs from the catalog’s puts back no native descriptor', async () => {
    const report = await scan(
      'var o = window.fetch;\nwindow.fetch = function () { return o.apply(this, arguments) };\n' +
        "window.__teardown = function () { Object.defineProperty(window, 'fetch', { value: o, writable: false }) };",
    )

    expect(findings(report)).toEqual({ 'Window.fetch|wrap': ['2:0'], 'Window.fetch|replace': ['3:34'] })
    expect(restoreSteps(report)).toEqual({})
  })
})

// Reachability on the corpus's true positives (§7 Values, Where reachability is judged from, §20 the
// Chromium rule). Each scenario is the shape of an SDK whose observed write the scoring run judged wrongly, cut down,
// and goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const scan = async (code: string): Promise<Report> =>
  (await scanBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': code })).report

/** A finding's reachability and the classes of the `guard` steps of its first occurrence. */
const judged = (report: Report, name: string): { reachability: string; classes: string[] } => {
  const finding = report.findings.find((each: Report) => each.target.name === name)
  return {
    reachability: finding.reachability,
    classes: finding.occurrences[0].trace.filter((step: Report) => step.kind === 'guard').map((step: Report) => step.class),
  }
}

describe('reachability on true positives', () => {
  test("a caller-less function's guards are judged with the bindings of where it was made (Application Insights)", async () => {
    // `initialize` is caller-less, so it is judged from its creation site (§7), with the closure that made it (§5
    // Resolver capabilities 3): `F` is the instance, and `F.isInitialized()` calls a method the code gave it.
    const report = await scan(
      'function A(){ var F = this; F.isInitialized = function(){ return false };' +
        ' F.initialize = function(cfg){ if (!F.isInitialized()) XMLHttpRequest.prototype.open = function(){} } }' +
        ' var a = new A();',
    )

    expect(judged(report, 'XMLHttpRequest.prototype.open')).toEqual({ reachability: 'conditional', classes: ['config'] })
  })

  test("a subclass's `_super.call(this)` in tslib's class IIFE runs the superclass on the instance (Application Insights)", async () => {
    // The call reads only the IIFE's `_super`, so it runs in the frames of the constructor, whose closure binds it: the
    // superclass gives the instance `isInitialized`, and the guard calls it.
    const report = await scan(
      'function dyn(cls, target, fn){ fn(target, {}) }' +
        ' var Base = (function(){ function B(){ var _this = this; dyn(B, _this, function(s){ s.isInitialized = function(){ return false } }) } return B })();' +
        ' var Ajax = (function(_super){ function A(){ var t = _super.call(this) || this;' +
        ' dyn(A, t, function(F){ F.initialize = function(cfg){ F.isInitialized() || (XMLHttpRequest.prototype.open = function(){}) } }); return t }' +
        ' return A })(Base);' +
        ' var ajax = new Ajax();',
    )

    expect(judged(report, 'XMLHttpRequest.prototype.open')).toEqual({ reachability: 'conditional', classes: ['config'] })
  })

  test('a superclass field the IIFE-bound `_super.call(this)` writes is read on the instance', async () => {
    const report = await scan(
      'function B(){ this.h = XMLHttpRequest.prototype }' +
        ' var Sub = (function(_super){ function S(){ _super.call(this); this.h.open = function(){} } return S })(B);' +
        ' var sub = new Sub();',
    )

    expect(report.findings.map((finding: Report) => finding.target.name)).toEqual(['XMLHttpRequest.prototype.open'])
  })

  test("a null test on a value whose `null` is the code's own start value is no absence test (Clarity, the Chromium rule)", async () => {
    // `original` is the saved native once `proxy` has run, and the variable's own `null` before: the first call writes
    // whether or not `History.prototype.pushState` exists, so the test is not `guarded-native-absence` (§7, §20).
    const report = await scan(
      'var pushState = null;' +
        ' function proxy(original, method){ if (original === null) { original = history[method];' +
        ' history[method] = function(){ return original.apply(this, arguments) } } return original }' +
        ' window.start = function(){ pushState = proxy(pushState, "pushState") };',
    )

    expect(judged(report, 'history.pushState')).toEqual({ reachability: 'unconditional', classes: ['transparent'] })
  })

  test('a null test on a native read alone stays an absence test', async () => {
    const report = await scan('var f = window.fetch; if (f === null || f === undefined) window.fetch = function(){};')

    expect(judged(report, 'Window.fetch').reachability).toBe('guarded-native-absence')
  })

  test("a null test on a variable that is no once-flag stays an absence test, whatever `null` the code gives it elsewhere", async () => {
    // Only a once-flag's own nullish value takes the arm whatever the native (§5 Resolver capabilities 6): core-js's
    // `targetProperty = descriptor && descriptor.value` is undefined exactly when the native is missing.
    const report = await scan(
      'var v = window.fetch; function reset(){ v = null } window.r = reset;' +
        ' if (v === null || v === undefined) window.fetch = function(){};',
    )

    expect(judged(report, 'Window.fetch').reachability).toBe('guarded-native-absence')
  })

  test("a call's value that mixes a once-flag with presence tests of other natives is no once-flag test (Clarity's `check`)", async () => {
    // `check()` is `status === false && typeof Promise !== "undefined" && window.MutationObserver && …`: its once-flag
    // part doesn't make the whole test transparent, and the other natives it tests give conditional (§7).
    const report = await scan(
      'var status = false;' +
        ' function check(config){ if (config === void 0) { config = null } try {' +
        ' var gpc = navigator && "globalPrivacyControl" in navigator && navigator.globalPrivacyControl == true;' +
        ' return status === false && typeof Promise !== "undefined" && window.MutationObserver && document.createTreeWalker' +
        ' && "now" in Date && typeof WeakMap !== "undefined" && (!gpc || (config && config.diagnostics)) } catch (e) { return false } }' +
        ' function start(config){ if (check(config)) { status = true; var o = history.pushState;' +
        ' history.pushState = function(){ return o.apply(this, arguments) } } }' +
        ' function halt(){ if (status) { status = false } }' +
        ' window.go = start; window.end = halt;',
    )

    expect(judged(report, 'history.pushState').reachability).toBe('conditional')
  })

  test('a test whose constants differ is not decided (Application Insights `!_disableAjaxTracking`)', async () => {
    const report = await scan(
      'function hook(cfg){ var disabled = !!cfg.disableAjaxTracking; if (!disabled) XMLHttpRequest.prototype.open = function(){} }' +
        ' window.go = hook;',
    )

    expect(judged(report, 'XMLHttpRequest.prototype.open')).toEqual({ reachability: 'conditional', classes: ['config'] })
  })

  test('a once-flag test stays transparent', async () => {
    const report = await scan(
      'var done = false; function start(){ if (done) return; done = true; XMLHttpRequest.prototype.open = function(){} } window.go = start;',
    )

    expect(judged(report, 'XMLHttpRequest.prototype.open')).toEqual({ reachability: 'unconditional', classes: ['transparent'] })
  })

  test("a native method called on an object the code made is a recognized guard it can't decide (Sentry's `instrumentedLevels.has`)", async () => {
    // `Set.prototype.has` on a `new Set()` the code made is a catalog native whose answer the analyzer doesn't model: the
    // test is `undecided` (§7 `conditional`), not unrecognized control flow (`unknown`).
    const report = await scan(
      'var done = new Set();' +
        ' function instrument(){ ["log", "warn"].forEach(function(level){ if (done.has(level) || !(level in console)) return;' +
        ' done.add(level); var orig = console[level]; console[level] = function(){ return orig.apply(console, arguments) } }) }' +
        ' instrument();',
    )

    expect(judged(report, 'console.log')).toEqual({ reachability: 'conditional', classes: ['undecided', 'transparent'] })
  })

  test('a test that calls a function expression in place is judged as a call of that function by name is (Sentry 7 under Rollup)', async () => {
    // Rollup inlines `supportsHistory()` as `!function(){ … }()`: the same guard as the named call, which other bundlers
    // keep, so the same code gets the same class (§7, §20 invariance).
    const inline = await scan(
      'var g = window; function inst(){ if (!function(){ var c = g.chrome, r = c && c.app && c.app.runtime; return !r && "history" in g }()) return;' +
        ' var o = history.pushState; history.pushState = function(){ return o.apply(this, arguments) } } inst();',
    )
    const named = await scan(
      'var g = window; function supports(){ var c = g.chrome, r = c && c.app && c.app.runtime; return !r && "history" in g }' +
        ' function inst(){ if (!supports()) return; var o = history.pushState; history.pushState = function(){ return o.apply(this, arguments) } } inst();',
    )

    expect(judged(inline, 'history.pushState')).toEqual(judged(named, 'history.pushState'))
    expect(judged(inline, 'history.pushState').reachability).toBe('conditional')
  })
})

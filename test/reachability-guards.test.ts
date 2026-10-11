// Guard classification and reachability values (§7 Values, §14 `guard` steps): every occurrence and finding reports
// its reachability, judged from the guards between the write and the start of its function. Every scenario goes
// through `monkeypatchlist scan --json`.

import { readFileSync } from 'node:fs'
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

/** A module's build by a real bundler (`test/fixtures/early-throw/<bundler>/`). */
const built = (bundler: string) => {
  const read = (file: string) => readFileSync(new URL(`fixtures/early-throw/${bundler}/${file}`, import.meta.url), 'utf8')
  return { 'index.html': read('index.html'), 'main.js': read('main.js') }
}

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** Each finding's target name and reachability. */
const reachabilities = (report: Report): Record<string, string> =>
  Object.fromEntries(report.findings.map((finding: Report) => [finding.target.name, finding.reachability]))

/** The `guard` steps of a finding's first occurrence, without their text. */
const guardSteps = (report: Report, name: string): Report[] =>
  report.findings
    .find((finding: Report) => finding.target.name === name)
    .occurrences[0].trace.filter((step: Report) => step.kind === 'guard')
    .map((step: Report) => {
      const { text, generated, ...fields } = step
      expect([typeof text, typeof generated]).toEqual(['string', 'object'])
      return fields
    })

describe.each(resolvers)('guard classification, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = async (code: string) => (await scanBuild(classic(code), [], { deps: { resolver } })).report

  test("whatwg-fetch's single `!g.fetch` guards all four of its targets, and the evidence names `fetch`", async () => {
    const report = await scan(
      '(function(){ var g = typeof globalThis !== "undefined" ? globalThis : self;' +
        'function fetch(){} function Headers(){} function Request(){} function Response(){}' +
        'if (!g.fetch) { g.fetch = fetch; g.Headers = Headers; g.Request = Request; g.Response = Response } })()',
    )

    expect(reachabilities(report)).toEqual({
      'Window.fetch': 'guarded-native-absence',
      'Window.Headers': 'guarded-native-absence',
      'Window.Request': 'guarded-native-absence',
      'Window.Response': 'guarded-native-absence',
    })
    for (const name of ['Window.fetch', 'Window.Headers', 'Window.Request', 'Window.Response']) {
      expect(guardSteps(report, name)).toEqual([
        { kind: 'guard', expression: '!g.fetch', class: 'absence', tested: 'Window.fetch', result: 'guarded-native-absence' },
      ])
    }
  })

  test.each([
    ['`config.polyfill && !window.fetch`', 'function f(config){ if (config.polyfill && !window.fetch) window.fetch = p } f(cfg)', 'guarded-native-absence', ['config', 'absence']],
    ['`!window.fetch || force`', 'function f(force){ if (!window.fetch || force) window.fetch = p } f(x)', 'conditional', ['absence', 'config']],
  ])('guards combine along a path and across alternatives: %s', async (_, code, reachability, classes) => {
    const report = await scan(code)

    expect(reachabilities(report)).toEqual({ 'Window.fetch': reachability })
    expect(guardSteps(report, 'Window.fetch').map((step) => step.class)).toEqual(classes)
  })

  // Each absence form, written and minified (§7 `guarded-native-absence`), with the native it tests.
  test.each([
    ['`if (!x)`', 'if (!window.Promise) window.Promise = P', 'Window.Promise'],
    ['`if (!x)`, minified', 'window.Promise||(window.Promise=P)', 'Window.Promise'],
    ["`typeof x === 'undefined'`", "if (typeof Promise === 'undefined') window.Promise = P", 'Window.Promise'],
    ['`typeof x > "u"`, minified', 'typeof Promise>"u"&&(window.Promise=P)', 'Window.Promise'],
    ["`\"undefined\" == typeof x`, minified", '"undefined"==typeof Promise&&(window.Promise=P)', 'Window.Promise'],
    ["`typeof x !== 'function'`", "if (typeof window.Promise !== 'function') window.Promise = P", 'Window.Promise'],
    ['`"function" != typeof x`, minified', '"function"!=typeof window.Promise&&(window.Promise=P)', 'Window.Promise'],
    ["`!('x' in o)`", "if (!('fetch' in window)) window.fetch = p", 'Window.fetch'],
    ['`!("x" in o)`, minified', '"fetch"in window||(window.fetch=p)', 'Window.fetch'],
    ['`x == null`', 'if (window.fetch == null) window.fetch = p', 'Window.fetch'],
    ['`void 0 === x`, minified', 'void 0===window.fetch&&(window.fetch=p)', 'Window.fetch'],
    ['`x = x || p`', 'window.fetch = window.fetch || p', 'Window.fetch'],
    ['`x = x ?? p`', 'window.fetch = window.fetch ?? p', 'Window.fetch'],
    ['`x || (x = p)`', 'window.fetch || (window.fetch = p)', 'Window.fetch'],
    ['`x ??= p`', 'window.fetch ??= p', 'Window.fetch'],
    ['`x ||= p`', 'window.fetch ||= p', 'Window.fetch'],
    ['a ternary write', 'window.fetch = window.fetch ? window.fetch : p', 'Window.fetch'],
    ['a ternary write, the other way', "window.Promise = typeof window.Promise === 'function' ? window.Promise : P", 'Window.Promise'],
    ['a ternary arm', 'window.fetch ? 0 : (window.fetch = p)', 'Window.fetch'],
    ['an early return with the opposite test', '(function(){ if (window.fetch) return; window.fetch = p })()', 'Window.fetch'],
    ['an early return, minified', '!function(){if(window.fetch)return;window.fetch=p}()', 'Window.fetch'],
    ['an early throw in an `else`', "(function(){ if (typeof Promise !== 'function') {} else { throw 0 } window.Promise = P })()", 'Window.Promise'],
    ['another native than the target', 'if (!window.Promise) window.fetch = p', 'Window.Promise'],
    ['a prototype member', "if (!Promise.prototype.finally) Promise.prototype.finally = f", 'Promise.prototype.finally'],
    ['a member of an alias', 'var g = self; if (!g.fetch) g.fetch = p', 'Window.fetch'],
  ])('%s is `guarded-native-absence`, naming the native it tests', async (_, code, tested) => {
    const report = await scan(code)

    for (const finding of report.findings) expect(finding.reachability).toBe('guarded-native-absence')
    expect(report.findings.length).toBeGreaterThan(0)
    const steps = report.findings[0].occurrences[0].trace.filter((step: Report) => step.kind === 'guard')
    expect(steps.map((step: Report) => [step.class, step.tested, step.result])).toEqual([
      ['absence', tested, 'guarded-native-absence'],
    ])
  })

  // Each other class (§7, §14): its guard step's class and result, and the occurrence's value.
  test.each([
    ['core-js `FORCED`', 'Window.Promise', 'var FORCED = isForced("Promise", check); if (FORCED) window.Promise = P', 'broken-native', 'conditional'],
    ['a brand check', 'Window.Promise', "if (Object.prototype.toString.call(window.Promise.resolve()) !== '[object Promise]') window.Promise = P", 'broken-native', 'conditional'],
    ['`isNativeFunction`', 'Window.fetch', "function isNativeFunction(f){ return /native code/.test(Function.prototype.toString.call(f)) } if (!isNativeFunction(window.fetch)) window.fetch = p", 'broken-native', 'conditional'],
    ['a minified native-code check', 'Window.fetch', 'function n(f){return/\\[native code\\]/.test(""+f)} n(window.fetch)||(window.fetch=p)', 'broken-native', 'conditional'],
    ['a config flag', 'Window.fetch', 'function init(options){ if (options.patchFetch) window.fetch = w } init(o)', 'config', 'conditional'],
    ['an option variable', 'Window.fetch', 'var enabled = readConfig(); (function(){ if (enabled) window.fetch = w })()', 'config', 'conditional'],
    ['a presence test of another target', 'Window.fetch', 'if (window.Promise) window.fetch = w', 'other-target', 'conditional'],
    ['Datadog and Sentry sampling', 'Window.fetch', 'var sampleRate = cfg.rate; if (Math.random() < sampleRate) { window.fetch = w }', 'undecided', 'conditional'],
    ["`document.readyState === 'complete'`", 'Window.fetch', "if (document.readyState === 'complete') window.fetch = w", 'undecided', 'conditional'],
    ["`typeof global !== 'undefined'`", 'Window.fetch', "if (typeof global !== 'undefined') global.fetch = w", 'undecided', 'conditional'],
    ['a config flag, minified', 'Window.fetch', '!function(e){e.patchFetch&&(window.fetch=w)}(o)', 'config', 'conditional'],
    ['a presence test of another target, minified', 'Window.fetch', 'window.Promise&&(window.fetch=w)', 'other-target', 'conditional'],
    ['sampling, minified', 'Window.fetch', 'Math.random()<n&&(window.fetch=w)', 'undecided', 'conditional'],
    ['`typeof global`, minified', 'Window.fetch', '"undefined"!=typeof global&&(global.fetch=w)', 'undecided', 'conditional'],
    ['an unresolved call', 'Window.fetch', 'if (shouldPatch()) window.fetch = w', 'unknown', 'unknown'],
    ['`with` taint', 'Window.fetch', 'with (scope) { window.fetch = w }', 'unknown', 'unknown'],
    ['a test the analyzer does not recognize', 'Window.fetch', 'if ([] + {}) window.fetch = w', 'unknown', 'unknown'],
  ])('%s', async (_, target, code, cls, result) => {
    const report = await scan(code)

    expect(reachabilities(report)[target]).toBe(result)
    const finding = report.findings.find((each: Report) => each.target.name === target)
    const steps = finding.occurrences.flatMap((occurrence: Report) => occurrence.trace.filter((step: Report) => step.kind === 'guard'))
    expect(steps.map((step: Report) => [step.class, step.result])).toContainEqual([cls, result])
  })

  // Transparent guards leave the occurrence `unconditional` (§7).
  test.each([
    ['a check that the written target exists', 'XMLHttpRequest.prototype.open', '(function(){ var W = window; if (!W.XMLHttpRequest) return; XMLHttpRequest.prototype.open = w })()'],
    ['a check that the original is a function', 'Window.fetch', "(function(){ var original = window.fetch; if (typeof original !== 'function') return; window.fetch = function(){ return original.apply(this, arguments) } })()"],
    ['a check that the written member exists', 'Window.fetch', 'if (window.fetch) window.fetch = wrap(window.fetch)'],
    ['`x &&= p`', 'Window.fetch', 'window.fetch &&= wrap(window.fetch)'],
    ['a once-flag', 'Window.fetch', 'var st; function start(){ if (st) return; st = "on"; window.fetch = w } start()'],
    ["Rollup's once-flag", 'Window.fetch', 'var t, r; function i(){ if (t) return r; t = 1; window.fetch = w; return r } i()'],
    ['a check that the written target exists, minified', 'XMLHttpRequest.prototype.open', '!function(){if(!window.XMLHttpRequest)return;XMLHttpRequest.prototype.open=w}()'],
    ['`try/catch` around the write', 'Window.fetch', 'try { window.fetch = w } catch (e) {}'],
    ['a writability check', 'Window.fetch', 'function isPropertyWritable(o, k){ var d = Object.getOwnPropertyDescriptor(o, k); return !d || d.writable } if (isPropertyWritable(window, "fetch")) window.fetch = w'],
  ])('%s is transparent', async (_, target, code) => {
    const report = await scan(code)

    expect(reachabilities(report)[target]).toBe('unconditional')
    const finding = report.findings.find((each: Report) => each.target.name === target)
    for (const step of finding.occurrences[0].trace.filter((each: Report) => each.kind === 'guard')) {
      expect([step.class, step.result]).toEqual(['transparent', 'unconditional'])
    }
  })

  test("an early return on some paths guards the rest of its list across those paths: es6-promise's polyfill", async () => {
    const report = await scan(
      '(function polyfill(P2){ var local = window; var P = local.Promise;' +
        ' if (P) { var promiseToString = null; try { promiseToString = Object.prototype.toString.call(P.resolve()) } catch (e) {}' +
        ' if (promiseToString === "[object Promise]" && !P.cast) { return } }' +
        ' local.Promise = P2 })(function Promise(){})',
    )

    // The write runs where `Promise` is missing, or where it is there and fails the brand check: OR gives conditional.
    expect(reachabilities(report)).toEqual({ 'Window.Promise': 'conditional' })
    expect(guardSteps(report, 'Window.Promise').map((step) => [step.class, step.tested])).toEqual([
      ['transparent', 'Window.Promise'],
      ['broken-native', undefined],
      ['undecided', undefined],
      ['absence', 'Window.Promise'],
    ])
  })

  test.each([
    ['an unguarded and an absence-guarded write', 'if (!window.fetch) window.fetch = p; window.fetch = p', 'unconditional', ['guarded-native-absence', 'unconditional']],
    ['an absence-guarded and a config-guarded write', 'if (!window.fetch) window.fetch = p; if (cfg.on) window.fetch = p', 'conditional', ['guarded-native-absence', 'conditional']],
    ['an unknown and an absence-guarded write', 'if (!window.fetch) window.fetch = p; if (check()) window.fetch = p', 'unknown', ['guarded-native-absence', 'unknown']],
  ])('a finding reports the most-reaching value over its occurrences: %s', async (_, code, reachability, occurrences) => {
    const report = await scan(code)

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].reachability).toBe(reachability)
    expect(report.findings[0].occurrences.map((occurrence: Report) => occurrence.reachability)).toEqual(occurrences)
  })

  test('an ineffective write carries its reachability', async () => {
    const report = await scan('if (!window.top) window.top = 1')

    expect(report.ineffectiveWrites[0].occurrences[0].reachability).toBe('guarded-native-absence')
  })

  // An early `return` or `throw` under the opposite `typeof global` test guards `global` (§5).
  test.each([
    ['in the same function body', '(function(){ if (typeof global === "undefined") return; global.fetch = w })()'],
    ['in a function created after it', '(function(){ if (typeof global === "undefined") return; function patch(){ global.fetch = wrap(global.fetch) } patch() })()'],
    ['in a nested block', '(function(){ if (typeof global === "undefined") return; if (ok) { global.fetch = w } })()'],
    ['minified', '!function(){if("undefined"==typeof global)return;global.fetch=w}()'],
    ['a throw at the top level of a script', 'if (typeof global === "undefined") throw new Error("needs global"); global.fetch = w'],
  ])('an early exit under `typeof global` guards it: %s', async (_, code) => {
    const report = await scan(code)

    expect(Object.keys(reachabilities(report))).toEqual(['Window.fetch'])
    // `typeof global` is a recognized guard that can't be decided. A write in a function the guarded code
    // calls is judged along the call chain.
    if (!code.includes('patch')) expect(reachabilities(report)['Window.fetch']).toBe('conditional')
  })

  test('an early return that does not cover every path guards nothing', async () => {
    const report = await scan('function f(a){ if (a) { if (typeof global === "undefined") return } global.fetch = w } f(x)')

    expect(report.findings).toEqual([])
  })

  test.each(['webpack', 'rollup', 'esbuild', 'vite'])(
    'a module\'s top-level early `throw` under `typeof global` guards it in a %s build',
    async (bundler) => {
      const { report } = await scanBuild(built(bundler), [], { deps: { resolver } })

      expect(report.findings.map((finding: Report) => [finding.target.name, finding.effect])).toEqual([['Window.fetch', 'replace']])
    },
  )
})

test("the report schema's guard classes are §14's closed list, `undecided` the seventh", () => {
  const schema = JSON.parse(readFileSync(new URL('../schema/report.schema.json', import.meta.url), 'utf8'))
  const guard = schema.$defs.traceStep.allOf.find(
    (branch: Report) => branch.if.properties.kind.const === 'guard',
  )

  expect(guard.then.properties.class.enum).toEqual([
    'transparent',
    'absence',
    'broken-native',
    'config',
    'other-target',
    'unknown',
    'undecided',
  ])
  expect(guard.then.required).toEqual(['expression', 'generated', 'class', 'result'])
})

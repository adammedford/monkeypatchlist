// Checking guards against the catalog (§7, §14 `prune`): a `hasOwnProperty`, `in` or `typeof` guard whose object
// resolves to a native holder and whose name is a constant is decided against the catalog. A catalog name tested where
// no catalog version places it is statically false, and the finding occurrences only it reaches are pruned, counted and
// traced; a name the catalog has nowhere is `conditional`. Every scenario goes through `monkeypatchlist scan --json`.

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

/** Each finding's target name and reachability. */
const reachabilities = (report: Report): Record<string, string> =>
  Object.fromEntries(report.findings.map((finding: Report) => [finding.target.name, finding.reachability]))

/** The steps of one kind in each occurrence of a finding, without their text. */
const stepsOf = (report: Report, name: string, kind: string): Report[][] =>
  report.findings
    .find((finding: Report) => finding.target.name === name)
    .occurrences.map((occurrence: Report) =>
      occurrence.trace
        .filter((step: Report) => step.kind === kind)
        .map((step: Report) => {
          const { text, ...fields } = step
          expect(typeof text).toBe('string')
          return fields
        }),
    )

const pruned = (report: Report): number => report.completeness.counters.statistics.pruned

describe.each(resolvers)('catalog-checked guards, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = async (files: Record<string, string>) => (await scanBuild(files, [], { deps: { resolver } })).report

  test('`hasOwnProperty.call(history, "pushState")` is statically false: the write it guards is pruned', async () => {
    const report = await scan(
      classic('if (Object.prototype.hasOwnProperty.call(history, "pushState")) history.pushState = w'),
    )

    expect(reachabilities(report)).toEqual({})
    expect(pruned(report)).toBe(1)
  })

  test('the negated form is statically true, so it is transparent', async () => {
    const report = await scan(
      classic('if (!Object.prototype.hasOwnProperty.call(history, "pushState")) history.pushState = w'),
    )

    expect(reachabilities(report)).toEqual({ 'history.pushState': 'unconditional' })
    expect(stepsOf(report, 'history.pushState', 'guard')[0]).toEqual([
      {
        kind: 'guard',
        expression: '!Object.prototype.hasOwnProperty.call(history, "pushState")',
        generated: { start: 4, end: 63, line: 1, column: 4 },
        class: 'transparent',
        tested: 'history.pushState',
        result: 'unconditional',
      },
    ])
    expect(pruned(report)).toBe(0)
  })

  // `hasOwnProperty` by any route (§7): each is the same own test, and so each is statically false here.
  test.each([
    ['a method call', 'if (history.hasOwnProperty("pushState")) history.pushState = w'],
    ['`.apply`', 'if (Object.prototype.hasOwnProperty.apply(history, ["pushState"])) history.pushState = w'],
    ['`Reflect.apply`', 'if (Reflect.apply(Object.prototype.hasOwnProperty, history, ["pushState"])) history.pushState = w'],
    ['an early exit in a function', 'function f() { if (!Object.hasOwn(history, "pushState")) return; history.pushState = w } f()'],
  ])('an own test through %s is checked against the catalog', async (_, code) => {
    const report = await scan(classic(code))

    expect(reachabilities(report)).toEqual({})
    expect(pruned(report)).toBe(1)
  })

  // ADR 0009: an absence test on a native the catalog places there keeps its guard class, and nothing is pruned.
  test.each([
    ['`in`', 'if (!("fetch" in window)) window.fetch = w', 'Window.fetch'],
    ['`typeof`', 'if (typeof Promise.prototype.finally !== "function") Promise.prototype.finally = w', 'Promise.prototype.finally'],
    ['an own test', 'if (!Object.hasOwn(Object, "assign")) Object.assign = w', 'Object.assign'],
  ])('an absence test of a catalog native through %s stays `guarded-native-absence`', async (_, code, name) => {
    const report = await scan(classic(code))

    expect(reachabilities(report)).toEqual({ [name]: 'guarded-native-absence' })
    expect(pruned(report)).toBe(0)
  })

  test('a surviving occurrence of the same guard records the prune: its count and the guard', async () => {
    const report = await scan(
      classic(
        'if (Object.hasOwn(history, "pushState")) { history.pushState = w; history.replaceState = w }\n' +
          'else history.go = g',
      ),
    )

    expect(reachabilities(report)).toEqual({ 'history.go': 'unconditional' })
    expect(pruned(report)).toBe(2)
    const [steps] = stepsOf(report, 'history.go', 'prune')
    expect(steps).toEqual([
      {
        kind: 'prune',
        count: 2,
        expression: 'Object.hasOwn(history, "pushState")',
        generated: { start: 4, end: 39, line: 1, column: 4 },
      },
    ])
    // The `prune` step follows the guard's own step.
    const trace = report.findings[0].occurrences[0].trace.map((step: Report) => step.kind)
    expect(trace[trace.indexOf('guard') + 1]).toBe('prune')
  })
  test("`'document' in self` in a worker is statically false: no catalog version puts `document` on its chain", async () => {
    const report = await scan({
      'index.html': '<script src="main.js"></script>',
      'main.js': 'new Worker("worker.js")',
      'worker.js': 'if ("document" in self) self.fetch = f; else self.postMessage = p',
    })

    expect(reachabilities(report)).toEqual({ 'DedicatedWorkerGlobalScope.postMessage': 'unconditional' })
    expect(pruned(report)).toBe(1)
    expect(stepsOf(report, 'DedicatedWorkerGlobalScope.postMessage', 'prune')[0]).toEqual([
      { kind: 'prune', count: 1, expression: '"document" in self', generated: expect.any(Object) },
    ])
  })

  // A name the catalog has on no holder in any realm: `conditional`, and both arms analyzed.
  test.each([
    [
      'a vendor-prefixed name',
      'if (typeof window.webkitRequestAnimationFrame === "function") window.requestAnimationFrame = wrap(window.webkitRequestAnimationFrame)',
      'Window.requestAnimationFrame',
    ],
    [
      'an expando',
      'XMLHttpRequest.prototype.__zone = z; if ("__zone" in XMLHttpRequest.prototype) XMLHttpRequest.prototype.open = w',
      'XMLHttpRequest.prototype.open',
    ],
    ['an engine-only name', 'if (typeof window.process !== "undefined") window.fetch = w', 'Window.fetch'],
    ['a legacy IE name', 'if ("attachEvent" in window) window.addEventListener = shim', 'Window.addEventListener'],
    ['a legacy IE name, negated', 'if (!("attachEvent" in window)) window.addEventListener = shim', 'Window.addEventListener'],
    ['an expando, negated', 'if (!("__zone" in XMLHttpRequest.prototype)) XMLHttpRequest.prototype.open = w', 'XMLHttpRequest.prototype.open'],
    ['an own test of an expando', 'if (!Object.hasOwn(history, "__patched")) history.pushState = w', 'history.pushState'],
  ])('%s is `conditional`, never pruned', async (_, code, name) => {
    const report = await scan(classic(code))

    expect(reachabilities(report)[name]).toBe('conditional')
    expect(pruned(report)).toBe(0)
  })
  // Only a name the catalog places on no holder in any realm is `conditional`. `attachEvent` is on none, so its
  // branch keeps its findings; `ClipboardEvent.prototype.clipboardData` is a holder of `clipboardData`, so
  // `'clipboardData' in window` stays statically false and prunes.
  test("`'attachEvent' in window` is `conditional` and its branch keeps its findings", async () => {
    const report = await scan(classic('if ("attachEvent" in window) { window.fetch = f; history.pushState = w }'))

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'conditional', 'history.pushState': 'conditional' })
    expect(pruned(report)).toBe(0)
  })

  test("`'clipboardData' in window` stays statically false: pruned, counted and traced", async () => {
    const report = await scan(
      classic('if ("clipboardData" in window) { window.fetch = f; history.pushState = w }\nelse history.go = g'),
    )

    expect(reachabilities(report)).toEqual({ 'history.go': 'unconditional' })
    expect(pruned(report)).toBe(2)
    expect(stepsOf(report, 'history.go', 'prune')[0]).toEqual([
      { kind: 'prune', count: 2, expression: '"clipboardData" in window', generated: expect.any(Object) },
    ])
  })

  test('a `typeof` test of a catalog name no catalog version puts on the chain of its holder is statically false', async () => {
    const report = await scan(
      classic(
        'if (typeof history.fetch === "function") history.pushState = w\n' +
          'if (typeof history.fetch === "undefined") history.replaceState = w',
      ),
    )

    expect(reachabilities(report)).toEqual({ 'history.replaceState': 'unconditional' })
    expect(pruned(report)).toBe(1)
  })

  // A bare-name `typeof` test on a name no catalog version has on the realm's global is never statically false (§7).
  test.each([
    ['`global`', 'if (typeof global !== "undefined") window.fetch = w'],
    ['`process`', 'if (typeof process === "object") window.fetch = w'],
    ['`module`', 'if (typeof module === "object") window.fetch = w'],
    ['`exports`', 'if (typeof exports !== "undefined") window.fetch = w'],
  ])('a bare-name `typeof` test of %s is `conditional`', async (_, code) => {
    const report = await scan(classic(code))

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'conditional' })
    expect(pruned(report)).toBe(0)
  })

  test('a bare-name `typeof window` test in a worker is `conditional`', async () => {
    const report = await scan({
      'index.html': '<script src="main.js"></script>',
      'main.js': 'new Worker("worker.js")',
      'worker.js': 'if (typeof window !== "undefined") self.fetch = f',
    })

    expect(reachabilities(report)).toEqual({ 'DedicatedWorkerGlobalScope.fetch': 'conditional' })
    expect(pruned(report)).toBe(0)
  })
  test.each([
    ['a `for…of` loop', 'for (const m of ["pushState", "addEventListener"]) { if (m in history) { history[m] = w; EventTarget.prototype[m] = w } }'],
    ['`forEach`', '["pushState", "addEventListener"].forEach(function (m) { if (m in history) { history[m] = w; EventTarget.prototype[m] = w } })'],
  ])('names unrolled from a constant array are checked one by one: %s', async (_, code) => {
    const report = await scan(classic(code))

    // `pushState` is on `history`'s chain, so the test is the written target's own presence for its first write, and a
    // presence test of another native for its second. No catalog version puts `addEventListener` on that chain, so its
    // write is pruned.
    expect(reachabilities(report)).toEqual({
      'history.pushState': 'unconditional',
      'EventTarget.prototype.pushState': 'conditional',
    })
    expect(pruned(report)).toBe(1)
    expect(stepsOf(report, 'history.pushState', 'prune')[0]).toEqual([
      { kind: 'prune', count: 1, expression: 'm in history', generated: expect.any(Object) },
    ])
  })

  test('a prune removes only finding occurrences: the dead branch keeps its records, counters, wildcard findings and references', async () => {
    const report = await scan({
      'index.html': '<script src="main.js"></script>',
      'main.js':
        'if (Object.prototype.hasOwnProperty.call(history, "pushState")) {\n' +
        // A wildcard needs its key reused (§5), so this one wraps what it read.
        '  eval(src); history[cfg.m] = wrap(history[cfg.m]); new Worker("shim.js"); history.pushState = w\n' +
        '}',
      'shim.js': 'self.fetch = f',
    })

    expect(Object.keys(reachabilities(report)).sort()).toEqual(['DedicatedWorkerGlobalScope.fetch', 'history.*'])
    expect(pruned(report)).toBe(1)
    expect(report.completeness.counters.blindSpots.dynamicCode).toBe(1)
    expect(report.completeness.limitations.map((limitation: Report) => limitation.kind)).toContain('dynamic-code')
    expect(report.completeness.level).toBe('complete-with-limitations')
  })

  // ECMA-262 gives every function its own `length` and `name`: the presence arm is transparent and the absence
  // arm is pruned.
  test.each([
    ['`typeof` of `name`', 'if (typeof Promise.name === "string") Promise.prototype.finally = f'],
    ['`typeof` of `length`', 'if (typeof Promise.length === "number") Promise.prototype.finally = f'],
    ['`in`', 'if ("name" in Promise) Promise.prototype.finally = f'],
    ['an own test', 'if (Object.hasOwn(Promise, "length")) Promise.prototype.finally = f'],
  ])("a function's own `length` or `name` reads as always present through %s: the guard is transparent", async (_, code) => {
    const report = await scan(classic(code))

    expect(reachabilities(report)).toEqual({ 'Promise.prototype.finally': 'unconditional' })
    expect(stepsOf(report, 'Promise.prototype.finally', 'guard')[0]).toEqual([
      expect.objectContaining({ kind: 'guard', class: 'transparent', result: 'unconditional' }),
    ])
    expect(pruned(report)).toBe(0)
  })

  test.each([
    ['`typeof` of `length`', 'if (typeof Promise.length !== "number") Promise.prototype.finally = f'],
    ['`typeof` of `name`', 'if (typeof Promise.name === "undefined") Promise.prototype.finally = f'],
    ['`in`', 'if (!("length" in Promise)) Promise.prototype.finally = f'],
    ['an own test', 'if (!Object.hasOwn(Promise, "name")) Promise.prototype.finally = f'],
  ])("the absence arm of a function's own `length` or `name` through %s is pruned, counted and traced", async (_, code) => {
    const report = await scan(classic(code + '\nelse window.fetch = g'))

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'unconditional' })
    expect(pruned(report)).toBe(1)
    expect(stepsOf(report, 'Window.fetch', 'prune')[0]).toEqual([
      { kind: 'prune', count: 1, expression: expect.any(String), generated: expect.any(Object) },
    ])
  })

  test('a native holder read from the heap is still that holder for the catalog check', async () => {
    const report = await scan(
      classic('const t = { h: history }; if (Object.prototype.hasOwnProperty.call(t.h, "pushState")) t.h.pushState = w'),
    )

    expect(reachabilities(report)).toEqual({})
    expect(pruned(report)).toBe(1)
  })
})


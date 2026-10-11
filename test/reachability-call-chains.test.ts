// Reachability from install entries along call chains (§7 Where reachability is judged from): a write's reachability
// is judged from the outermost function on its resolved call chain that has no resolved caller, and guards anywhere
// along the chain count. Every scenario goes through `monkeypatchlist scan --json`.

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

/** A finding's occurrences. */
const occurrencesOf = (report: Report, name: string): Report[] =>
  report.findings.find((finding: Report) => finding.target.name === name).occurrences

/** The `guard` steps of a finding's first occurrence: their expression, class and result. */
const guardSteps = (report: Report, name: string): Report[] =>
  occurrencesOf(report, name)[0]
    .trace.filter((step: Report) => step.kind === 'guard')
    .map((step: Report) => ({ expression: step.expression, class: step.class, result: step.result }))

describe.each(resolvers)('reachability along call chains, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = async (code: string) => (await scanBuild(classic(code), [], { deps: { resolver } })).report

  test('a guard in the caller applies to a write inside the callee', async () => {
    const report = await scan('function patch(){ window.fetch = p } if (!window.fetch) patch()')

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'guarded-native-absence' })
    expect(guardSteps(report, 'Window.fetch')).toEqual([
      { expression: '!window.fetch', class: 'absence', result: 'guarded-native-absence' },
    ])
  })

  test('two callers, one guarded and one not, give `unconditional`', async () => {
    const report = await scan('function patch(){ window.fetch = p } if (!window.fetch) patch(); patch()')

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'unconditional' })
  })

  test('two callers guarded alike give their guard, and the guards along a chain combine', async () => {
    const report = await scan(
      'function patch(){ window.fetch = p } function install(cfg){ if (cfg.on) patch() }' +
        'if (!window.fetch) install(c); else if (!window.Promise) install(d)',
    )

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'guarded-native-absence' })
    expect(guardSteps(report, 'Window.fetch')).toEqual([
      { expression: '!window.fetch', class: 'absence', result: 'guarded-native-absence' },
      { expression: 'cfg.on', class: 'config', result: 'conditional' },
    ])
  })

  test('a guard inside a helper summary applies, judged with the arguments of its call', async () => {
    const report = await scan(
      '(function(){ function when(test, run){ if (test) run() }' +
        'when(!window.fetch, function(){ window.fetch = p }) })()',
    )

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'guarded-native-absence' })
    expect(guardSteps(report, 'Window.fetch')).toEqual([
      { expression: '!window.fetch', class: 'absence', result: 'guarded-native-absence' },
    ])
  })

  test('a parameter the helper reassigns is not judged as the argument its call passes', async () => {
    const report = await scan(
      '(function(){ function install(force){ force = force || !window.fetch; if (force) window.fetch = p }' +
        'install(false) })()',
    )

    // `force` may be `!window.fetch` or the `false` passed, so its test can't be decided: not `false`'s transparency.
    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'conditional' })
  })

  test("a test of a parameter is judged as each named call's argument, in the write's function and along the chain", async () => {
    const own = await scan(
      '(function(){ function install(on){ if (on) window.fetch = p } install(!window.fetch); install(!window.Promise) })()',
    )
    const chained = await scan(
      'function patch(){ window.fetch = p } function install(on){ if (on) patch() } install(!window.fetch)',
    )
    const either = await scan(
      '(function(){ function install(on){ if (on) window.fetch = p } install(!window.fetch); install(cfg.on) })()',
    )

    expect(reachabilities(own)).toEqual({ 'Window.fetch': 'guarded-native-absence' })
    expect(guardSteps(own, 'Window.fetch')).toEqual([
      { expression: '!window.fetch', class: 'absence', result: 'guarded-native-absence' },
    ])
    expect(reachabilities(chained)).toEqual({ 'Window.fetch': 'guarded-native-absence' })
    expect(reachabilities(either)).toEqual({ 'Window.fetch': 'conditional' })
  })

  test('a guard in a helper the write is in applies along the chain out from it', async () => {
    const report = await scan(
      'function fill(o, k, v){ if (!(k in o)) return; o[k] = v(o[k]) }' +
        'function install(){ fill(window, "fetch", w) } if (Math.random() < rate) install()',
    )

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'conditional' })
    expect(guardSteps(report, 'Window.fetch').map((step) => step.class)).toEqual(['undecided', 'transparent'])
  })

  test('an unresolved call on the path gives `unknown`', async () => {
    const report = await scan('function patch(){ window.fetch = p } if (sdk.shouldPatch()) patch()')

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'unknown' })
    expect(guardSteps(report, 'Window.fetch')).toEqual([
      { expression: 'sdk.shouldPatch()', class: 'unknown', result: 'unknown' },
    ])
  })

  test('a recursion adds no alternative of its own', async () => {
    const report = await scan(
      'function patch(n){ if (n > 0) patch(n - 1); window.fetch = p } if (!window.fetch) patch(3)',
    )

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'guarded-native-absence' })
  })

  test('a top-level function with no resolved caller is an install entry: its own guards decide', async () => {
    const report = await scan('function patch(){ if (!window.fetch) window.fetch = p }')

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'guarded-native-absence' })
  })
  test('each occurrence records its reachability basis as `call-path`', async () => {
    const report = await scan(
      'function patch(){ window.fetch = p } if (!window.fetch) patch(); if (!window.Promise) window.Promise = P',
    )

    for (const name of ['Window.fetch', 'Window.Promise']) {
      expect(occurrencesOf(report, name).map((occurrence) => occurrence.reachabilityBasis)).toEqual(['call-path'])
    }
  })
  test("a wildcard write is judged along its call chain too: the caller's guard applies and the basis is `call-path`", async () => {
    const report = await scan(
      'function patchAll(keys){ keys.forEach(function(k){ console[k] = wrap(console[k]) }) } if (cfg.on) patchAll(cfg.levels)',
    )

    expect(reachabilities(report)).toEqual({ 'console.*': 'conditional' })
    expect(guardSteps(report, 'console.*')).toEqual([{ expression: 'cfg.on', class: 'config', result: 'conditional' }])
    expect(occurrencesOf(report, 'console.*').map((occurrence) => occurrence.reachabilityBasis)).toEqual(['call-path'])
  })
  test("a helper's test of an object its call passes is decided: objects are truthy", async () => {
    const report = await scan(
      '(function(){ function fill(o, k, opts){ if (o && k && opts) o[k] = opts.wrap(o[k]) }' +
        'fill(window, "fetch", { wrap: function(f){ return f } }) })()',
    )

    expect(reachabilities(report)).toEqual({ 'Window.fetch': 'unconditional' })
  })
})

// Creation-site reachability (§7 Where reachability is judged from, ADR 0013): a function nothing resolvably calls, but
// that analyzed code created, is judged from its creation site: the reachability of the code that created it, AND the
// guards in force where it was created, then its own guards. Every scenario goes through `monkeypatchlist scan --json`.

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

/** A finding by target name. */
const findingOf = (report: Report, name: string): Report =>
  report.findings.find((finding: Report) => finding.target.name === name)

/** Each finding's target name, reachability and basis. */
const judged = (report: Report): Record<string, [string, string]> =>
  Object.fromEntries(
    report.findings.map((finding: Report) => [finding.target.name, [finding.reachability, finding.reachabilityBasis]]),
  )

/** The trace step kinds of a finding's first occurrence. */
const kinds = (report: Report, name: string): string[] =>
  findingOf(report, name).occurrences[0].trace.map((step: Report) => step.kind)

describe.each(resolvers)('creation-site reachability, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = async (code: string) => (await scanBuild(classic(code), [], { deps: { resolver } })).report

  test('a callback created inside a native-absence branch and stored on the heap is guarded-native-absence', async () => {
    const report = await scan('const handlers = []; if (!window.fetch) { handlers.push(() => { window.fetch = p }) }')

    expect(judged(report)).toEqual({ 'Window.fetch': ['guarded-native-absence', 'creation-site'] })
    const occurrence = findingOf(report, 'Window.fetch').occurrences[0]
    expect(occurrence.reachabilityBasis).toBe('creation-site')
    expect(kinds(report, 'Window.fetch')).toContain('creation-site')
  })

  test('a returned closure is judged from where it was returned: the guards around its creation and its creator\'s call', async () => {
    const report = await scan(
      'function mk(){ if (!window.Promise) return function stop(){ window.fetch = p }; return null }' +
        'var s; if (config.polyfill) s = mk()',
    )

    expect(judged(report)).toEqual({ 'Window.fetch': ['guarded-native-absence', 'creation-site'] })
    const guards = findingOf(report, 'Window.fetch')
      .occurrences[0].trace.filter((step: Report) => step.kind === 'guard')
      .map((step: Report) => step.expression)
    expect(guards).toEqual(['config.polyfill', '!window.Promise'])
  })

  test('the closure\'s own guards come after its creation site', async () => {
    const report = await scan('function mk(){ return () => { if (cfg.on) window.fetch = p } } var s = mk()')

    expect(judged(report)).toEqual({ 'Window.fetch': ['conditional', 'creation-site'] })
    expect(kinds(report, 'Window.fetch').filter((kind) => kind === 'creation-site' || kind === 'guard')).toEqual([
      'creation-site',
      'guard',
    ])
  })

  test('a caller-less top-level declaration is created unconditionally at load, so its own guards decide', async () => {
    const report = await scan('function init(){ if (!window.fetch) window.fetch = p }')

    expect(judged(report)).toEqual({ 'Window.fetch': ['guarded-native-absence', 'creation-site'] })
  })

  test('an `if` before the creation that never exits guards nothing after it', async () => {
    const report = await scan('if (cfg.on) setup(); handlers.push(() => { window.fetch = p })')

    expect(judged(report)).toEqual({ 'Window.fetch': ['unconditional', 'creation-site'] })
  })

  test('a function whose creation was never evaluated is unknown', async () => {
    const report = await scan('function g(){ return 1; handlers.push(() => { window.fetch = p }) } g()')

    expect(judged(report)).toEqual({ 'Window.fetch': ['unknown', 'creation-site'] })
    expect(kinds(report, 'Window.fetch')).toContain('creation-site')
  })

  test('a chain whose callers resolved is not ANDed with the creation site', async () => {
    const report = await scan('var f; if (!window.fetch) f = function(){ window.fetch = p }; function run(){ f() } run()')

    expect(judged(report)).toEqual({ 'Window.fetch': ['unconditional', 'call-path'] })
    expect(kinds(report, 'Window.fetch')).not.toContain('creation-site')
  })

  test('basis roll-up: call-path wins over creation-site among the occurrences that give the value', async () => {
    const report = await scan('function patch(){ window.fetch = p } patch(); handlers.push(() => { window.fetch = q })')

    expect(findingOf(report, 'Window.fetch').occurrences.map((each: Report) => each.reachabilityBasis).sort()).toEqual([
      'call-path',
      'creation-site',
    ])
    expect(judged(report)).toEqual({ 'Window.fetch': ['unconditional', 'call-path'] })
  })

  test('basis roll-up: only the occurrences that give the value count', async () => {
    const report = await scan('cfg.on && (window.fetch = p); handlers.push(() => { window.fetch = q })')

    expect(judged(report)).toEqual({ 'Window.fetch': ['unconditional', 'creation-site'] })
  })

  describe('a statically false catalog check where a caller-less function was created prunes its writes', () => {
    const own = "Object.prototype.hasOwnProperty.call(history, 'pushState')"

    test('the stored arrow gives no finding, and the prune is counted', async () => {
      const report = await scan(`const handlers = []; if (${own}) { handlers.push(() => { history.pushState = w }) }`)

      expect(report.findings).toEqual([])
      expect(report.completeness.counters.statistics.pruned).toBe(1)
    })

    test('a surviving occurrence of the same guard traces the prune next to the creation-site step', async () => {
      const report = await scan(
        `const handlers = []; if (${own}) { handlers.push(() => { history.pushState = w }) }` +
          ' else { handlers.push(() => { history.replaceState = w }) }',
      )

      expect(Object.keys(judged(report))).toEqual(['history.replaceState'])
      const trace = findingOf(report, 'history.replaceState').occurrences[0].trace
      const at = trace.findIndex((step: Report) => step.kind === 'prune')
      expect(trace[at]).toMatchObject({ kind: 'prune', count: 1, expression: own.replaceAll("'", '"') })
      expect(trace[at + 1].kind).toBe('creation-site')
    })

    const patcher = 'class P { constructor(h){ this.h = h } enable(){ this.h.pushState = w } }'

    test('a function with several creation sites keeps its finding while any one is not statically false', async () => {
      const report = await scan(`${patcher} var a, b; if (${own}) a = new P(history); b = new P(history)`)

      expect(Object.keys(judged(report))).toEqual(['history.pushState'])
    })

    test('a function whose every creation site is statically false is pruned', async () => {
      const report = await scan(`${patcher} var a, b; if (${own}) { a = new P(history); b = new P(history) }`)

      expect(report.findings).toEqual([])
      expect(report.completeness.counters.statistics.pruned).toBeGreaterThan(0)
    })
  })
})

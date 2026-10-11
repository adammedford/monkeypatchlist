// Scope-wide aliasing and reaching definitions (§5 Resolver capabilities 2, §14): a variable's value is the union of
// its definitions, and within a function the definitions that reach a read through statement lists, `if` arms and comma
// sequences decide it. Each alias followed is an `alias` trace step. Bare `self`, `frames` and `globalThis`, and every
// other catalog name whose assignment takes effect, follow their value once the script assigns them (§5 Reassigned
// globals). Every scenario goes through `monkeypatchlist scan --json`.

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
const lines = (...code: string[]) => code.join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

const fingerprints = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.fingerprint)

/** The trace of a finding's only occurrence. */
const traceOf = (finding: Finding): { kind: string; [field: string]: unknown }[] => {
  expect(finding.occurrences).toHaveLength(1)
  return finding.occurrences[0].trace
}

describe.each(resolvers)('scope-wide aliasing, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  describe('aliases of holders', () => {
    test('var p = XMLHttpRequest.prototype; p.send = w gives XMLHttpRequest.prototype.send, with an alias step', async () => {
      const { report } = await scan(lines('var p = XMLHttpRequest.prototype;', 'p.send = w'))

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
      const trace = traceOf(report.findings[0])
      expect(trace.map((step) => step.kind)).toEqual(['binding', 'alias'])
      expect(trace[0]).toMatchObject({ name: 'XMLHttpRequest', resolution: 'global' })
      expect(trace[1]).toMatchObject({
        kind: 'alias',
        name: 'p',
        expression: 'p = XMLHttpRequest.prototype',
        generated: { line: 1, column: 4 },
      })
    })
  
    test('let and var keys fold through their definitions, each after its alias', async () => {
      const { report } = await scan(
        'let m = "send"; var n = "op" + "en"; XMLHttpRequest.prototype[m] = w; XMLHttpRequest.prototype[n] = w',
      )

      expect(fingerprints(report)).toEqual([
        'window|XMLHttpRequest.prototype.open|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
      ])
      expect(traceOf(report.findings[0]).map((step) => step.kind)).toEqual(['binding', 'fold', 'alias'])
      expect(traceOf(report.findings[1]).map((step) => step.kind)).toEqual(['binding', 'alias'])
    })

    test('let t = window; t = {}; t.fetch = w gives nothing: the later definition kills the earlier one', async () => {
      const { report } = await scan(lines('let t = window;', 't = {};', 't.fetch = w'))

      expect(fingerprints(report)).toEqual([])
    })

    test('an alias of an alias gives an alias step for each, the first definition first', async () => {
      const { report } = await scan(lines('var a = window', 'var b = a', 'b.fetch = w'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      const trace = traceOf(report.findings[0])
      expect(trace.map((step) => step.kind)).toEqual(['binding', 'alias', 'alias'])
      expect(trace.slice(1)).toMatchObject([
        { name: 'a', expression: 'a = window' },
        { name: 'b', expression: 'b = a' },
      ])
    })

    test("the brief's proto[method] = wrapper gives the binding and fold steps, with the alias of proto", async () => {
      const { report } = await scan(
        lines('const proto = EventTarget.prototype;', 'const method = "add" + "EventListener";', '', 'proto[method] = wrapper;'),
      )

      expect(fingerprints(report)).toEqual(['window|EventTarget.prototype.addEventListener|replace|unknown'])
      const trace = traceOf(report.findings[0])
      expect(trace.map((step) => step.kind)).toEqual(['binding', 'alias', 'fold'])
      expect(trace[0]).toMatchObject({ name: 'EventTarget', resolution: 'global' })
      expect(trace[1]).toMatchObject({ name: 'proto', generated: { line: 1, column: 6 } })
      expect(trace[2]).toMatchObject({ name: 'method', expression: '"add" + "EventListener"', value: 'addEventListener' })
    })

    test('a destructured alias: const { prototype: p } = XMLHttpRequest', async () => {
      const { report } = await scan(
        lines(
          'const { prototype: p } = XMLHttpRequest',
          'p.send = w',
          'var { XMLHttpRequest: { prototype: q } } = window',
          'q.open = w',
          'let [r] = [console]',
          'r.log = w',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|XMLHttpRequest.prototype.open|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
        'window|console.log|replace|unknown',
      ])
      expect(traceOf(report.findings[1]).map((step) => step.kind)).toEqual(['binding', 'alias'])
    })
  })

  describe('aliases of native functions', () => {
    test('an aliased writer gives its mechanism\'s findings: Ae = Object.defineProperty, and const { assign } = Object', async () => {
      const { report } = await scan(
        lines('var Ae = Object.defineProperty', 'Ae(window, "fetch", { value: w })', 'const { assign } = Object', 'assign(console, { log: w })'),
      )

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown', 'window|console.log|replace|unknown'])
      expect(report.findings.map((finding: Finding) => finding.occurrences[0].mechanism)).toEqual([
        'define-property',
        'bulk-assign',
      ])
      expect(traceOf(report.findings[0]).map((step) => step.kind)).toEqual(['binding', 'binding', 'alias'])
      expect(traceOf(report.findings[1]).map((step) => step.kind)).toEqual(['binding', 'binding', 'alias'])
    })

    test('a writer a resolved call returns is followed: var sp = f(), where f returns Object.setPrototypeOf', async () => {
      // core-js's shape: its object-set-prototype-of module returns `Object.setPrototypeOf || shim`.
      const { report } = await scan(
        lines(
          'function f() { return Object.setPrototypeOf || function (o, p) { o.__proto__ = p; return o } }',
          'var sp = f()',
          'sp && sp(Promise.prototype, X.prototype)',
        ),
      )

      expect(fingerprints(report)).toEqual(['window|Promise.prototype.[[Prototype]]|prototype-change|unknown'])
      expect(report.findings[0].occurrences.map((occurrence: Finding) => occurrence.mechanism)).toEqual(['set-prototype'])
      expect(traceOf(report.findings[0]).map((step) => step.kind)).toEqual(expect.arrayContaining(['call', 'alias']))
    })

    test('an aliased Object.getPrototypeOf chooses the holder against the catalog', async () => {
      const { report } = await scan(lines('var gp = Object.getPrototypeOf', 'gp(console).x = f'))

      expect(fingerprints(report)).toEqual(['window|console.[[Prototype]].x|add|unknown'])
      expect(traceOf(report.findings[0]).map((step) => step.kind)).toEqual(['binding', 'binding', 'catalog-holder', 'alias'])
    })

    test('an aliased eval, string timer or Function with literal code is analyzed as global nested code', async () => {
      const { report } = await scan(
        lines(
          'var e = eval',
          'function f(fetch) { e("fetch = w") }',
          'var t = setTimeout',
          't("XMLHttpRequest.prototype.send = w")',
          'var F = Function',
          'F("console.log = w")()',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.fetch|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
        'window|console.log|replace|unknown',
      ])
      const trace = traceOf(report.findings[0])
      expect(trace.slice(0, 3).map((step) => step.kind)).toEqual(['note', 'binding', 'alias'])
      expect(trace[0]).toMatchObject({ about: 'nested-code', callee: 'eval', scope: 'global' })
    })

    test('an aliased eval given code that is not a literal raises dynamic-code', async () => {
      const { report } = await scan(lines('var e = eval', 'e(code)'))

      expect(fingerprints(report)).toEqual([])
      expect(report.completeness.limitations.map((limitation: Finding) => limitation.kind)).toEqual(['dynamic-code'])
    })

    test('a route through an aliased eval or Function raises dynamic-code, its code unread', async () => {
      const { report } = await scan(lines('var e = eval', 'e.call(null, "fetch = w")', 'const F = Function', 'F.apply(null, ["console.log = w"])'))

      expect(fingerprints(report)).toEqual([])
      const limitations = report.completeness.limitations
      expect(limitations.map((limitation: Finding) => limitation.kind)).toEqual(['dynamic-code', 'dynamic-code'])
      expect(limitations[0].detail).toContain('reaches the native `eval` indirectly')
    })

    test('a route through an aliased Reflect.apply or call reaches eval, and raises dynamic-code', async () => {
      const { report } = await scan(lines('const { apply } = Reflect', 'apply(eval, null, ["fetch = w"])'))

      expect(fingerprints(report)).toEqual([])
      expect(report.completeness.limitations.map((limitation: Finding) => limitation.kind)).toEqual(['dynamic-code'])
    })
  })

  describe('other values through aliases', () => {
    test('a top-level this alias is the global object, and a function\'s this alias is not', async () => {
      const { report } = await scan(lines('var root = this', 'root.fetch = w', 'function f() { var self_ = this; self_.open = w }'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    })

    test('a window read as frames keeps its mark through an alias', async () => {
      const { report } = await scan(lines('var fs = frames', 'fs[i].fetch = w', 'var win = window', 'win[i].open = w'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(report.findings[0].occurrences[0].realmInstance).toBe('other')
    })
  })

  describe('reaching definitions', () => {
    test('an if arm decides: a definition in one arm joins the one before, and one in both arms kills it', async () => {
      const { report } = await scan(
        lines(
          'var a = window',
          'if (c) { a = {} }',
          'a.fetch = w',
          'var b = window',
          'if (c) { b = {} } else { b = [] }',
          'b.open = w',
          'function f() { var h = {}; if (c) return; h = console; h.log = w }',
        ),
      )

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown', 'window|console.log|replace|unknown'])
    })

    test('a comma sequence decides: each definition kills the one before it', async () => {
      const { report } = await scan(
        lines('var a, b', '(a = window, a.fetch = w, a = {}, a.open = w)', '(b = {}, b = console, b.log = w)'),
      )

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown', 'window|console.log|replace|unknown'])
    })

    test('flow-insensitive aliasing would give a false positive and a false negative: reaching definitions give neither', async () => {
      const { report } = await scan(
        lines('function f() {', '  var p = XMLHttpRequest.prototype', '  p.send = w', '  p = {}', '  p.open = w', '}'),
      )

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
    })

    test("a var's starting undefined counts only where the walk shows it reaches the read", async () => {
      // New Relic's hoisted constant: an init function assigns it, and another function reads it.
      const { report } = await scan(
        lines('var rc', 'function init() { rc = "addEventListener" }', 'function patch() { EventTarget.prototype[rc] = w }'),
      )

      expect(fingerprints(report)).toEqual(['window|EventTarget.prototype.addEventListener|replace|unknown'])
    })

    test("an if or ?: arm is taken only where its test is true: an assignment in every operand an && test runs reaches it", async () => {
      // core-js's ordinaryToPrimitive: `var u, a; if ("string" === o && t(u = i.toString) && !e(a = r(u, i))) return a`.
      const { report } = await scan(
        lines(
          'function key(i) { var a; if (c && !g(a = i)) return a; return "send" }',
          'XMLHttpRequest.prototype[key("open")] = w',
          'function either(i) { var a; if (c || (a = i)) return "send"; return a }',
          'XMLHttpRequest.prototype[either("abort")] = w',
          'function pick(i) { var a; return c && (a = i) ? a : "send" }',
          'XMLHttpRequest.prototype[pick("overrideMimeType")] = w',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|XMLHttpRequest.prototype.abort|replace|unknown',
        'window|XMLHttpRequest.prototype.open|replace|unknown',
        'window|XMLHttpRequest.prototype.overrideMimeType|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
      ])
    })

    test("a closure's assignment joins a read only across a call, new, await or yield", async () => {
      const { report } = await scan(
        lines(
          'function f() {',
          '  var h = console',
          '  function g() { h = {} }',
          '  h.log = w',
          '  g()',
          '  h.warn = w',
          '}',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|console.log|replace|unknown',
        'window|console.warn|replace|unknown',
      ])
    })

    test("a closure's assignment of a holder reaches a read after a call", async () => {
      const { report } = await scan(
        lines('function f() {', '  var h = {}', '  function g() { h = console }', '  h.log = w', '  g()', '  h.warn = w', '}'),
      )

      expect(fingerprints(report)).toEqual(['window|console.warn|replace|unknown'])
    })

    test.each([
      ['await', 'async function f() { var h = {}; function g() { h = console } h.log = w; await p; h.warn = w }'],
      ['new', 'function f() { var h = {}; function g() { h = console } h.log = w; new X(); h.warn = w }'],
      ['yield', 'function* f() { var h = {}; function g() { h = console } h.log = w; yield 1; h.warn = w }'],
    ])("a closure's assignment joins a read after %s", async (_, code) => {
      const { report } = await scan(code)

      expect(fingerprints(report)).toEqual(['window|console.warn|replace|unknown'])
    })

    test('a read in a loop falls back to the union of the definitions', async () => {
      const { report } = await scan(lines('var h = {}', 'for (;;) { h.log = w; h = console }', 'h.warn = w'))

      expect(fingerprints(report)).toEqual(['window|console.log|replace|unknown', 'window|console.warn|replace|unknown'])
    })

    test('a read in a nested function sees the values the code assigns', async () => {
      const { report } = await scan(lines('var p', 'p = XMLHttpRequest.prototype', 'function f() { p.send = w }'))

      expect(fingerprints(report)).toEqual(['window|XMLHttpRequest.prototype.send|replace|unknown'])
    })

    test('a class evaluation runs its heritage, computed keys, static blocks and static fields in order', async () => {
      const { report } = await scan(
        lines(
          'function f() { var h = console; class A { static { h = {} } } h.log = w }',
          'function g() { var h = console; class A extends (h = {}, B) {} h.warn = w }',
          'function k() { var h = {}; class A { static x = (h = console) } h.info = w }',
          'function m() { var h = {}; class A { y = (h = console) } h.error = w }',
          'class C { static { var r = this; r.fetch = w } }',
        ),
      )

      expect(fingerprints(report)).toEqual(['window|console.info|replace|unknown'])
    })
  })

  describe('reassigned globals', () => {
    test.each([
      ['var frames = []', 'frames.fetch = w', ['window|Window.frames|replace|unknown']],
      ['var self = {}', 'self.fetch = w', ['window|Window.self|replace|unknown']],
      ['globalThis = {}', 'globalThis.fetch = w', ['window|Window.globalThis|replace|unknown']],
      ['self = {}', 'function f() { self.fetch = w }', ['window|Window.self|replace|unknown']],
    ])('after %s, the bare name is the value assigned, so %s writes no Window.fetch', async (assign, write, expected) => {
      const { report } = await scan(lines(assign, write))

      // The assignment itself replaces the global's own member (§3), and so does a `var`'s; the write
      // through the name is the value's.
      expect(fingerprints(report)).toEqual(expected)
    })

    test('a read before the assignment, and var self = self || this, keep the window', async () => {
      const { report } = await scan(lines('self.fetch = w', 'var self = self || this', 'self.open = w'))

      // The `var` itself replaces `Window.self`, a [Replaceable] attribute (§3 Declarations in classic scripts).
      expect(fingerprints(report)).toEqual([
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|Window.self|replace|unknown',
      ])
    })

    test('window and top stay the window whatever the script assigns them', async () => {
      const { report } = await scan(lines('window = {}', 'window.fetch = w'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    })

    test('var Promise = window.Promise || Shim still patches the native where Promise is the native', async () => {
      const { report } = await scan(lines('var Promise = window.Promise || Shim', 'Promise.prototype.finally = f'))

      // The `var` itself replaces `Window.Promise` with a value that may be another (§3 Declarations in classic scripts).
      expect(fingerprints(report)).toEqual(['window|Promise.prototype.finally|replace|unknown', 'window|Window.Promise|replace|unknown'])
    })

    test('a catalog name that can be reassigned follows its value, and one that can\'t stays native', async () => {
      const { report } = await scan(
        lines('XMLHttpRequest = Shim', 'XMLHttpRequest.prototype.send = w', 'var top = {}', 'top.fetch = w'),
      )

      expect(fingerprints(report)).toEqual(['window|Window.XMLHttpRequest|replace|unknown', 'window|Window.fetch|replace|unknown'])
    })

    test('in a worker realm, self follows its value too', async () => {
      const files = {
        'index.html': '<script>new Worker("worker.js")</script>',
        'worker.js': lines('self.fetch = w', 'var self = {}', 'self.open = w'),
      }
      const { report } = await scanBuild(files, [], { deps: { resolver } })

      // The `var` shadows the inherited `WorkerGlobalScope.prototype.self` with an own property.
      expect(fingerprints(report)).toEqual([
        'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown',
        'dedicated-worker|DedicatedWorkerGlobalScope.self|replace|unknown',
      ])
    })
  })

  test('reports are byte-identical across runs', async () => {
    const code = lines('var p = XMLHttpRequest.prototype', 'if (c) { p = {} }', 'var { prototype: q } = History', 'p.send = w; q.back = w; var h = console; h.log = w')
    const first = await scan(code)
    const second = await scan(code)

    const withoutRun = (text: string) => JSON.stringify({ ...JSON.parse(text), run: undefined })
    expect(first.report.findings).toHaveLength(3)
    expect(withoutRun(first.stdout)).toBe(withoutRun(second.stdout))
  })
})

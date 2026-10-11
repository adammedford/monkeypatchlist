// Closures, callbacks and method dispatch (§5 Resolver capabilities 3): summaries follow `this` and class-field
// dispatch and callback invocation, and analyze escaping closures with the bindings of the call site that created them.
// A function with no resolved call still has a `this`, and is judged per function object from where it was created.
// Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
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

const names = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.target.name)
const kinds = (occurrence: Finding): string[] => occurrence.trace.map((step: Finding) => step.kind)
const levels = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.confidence.target.level)

describe.each(resolvers)('closures, callbacks and method dispatch, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test('a method on a class instance writes through the holder its constructor stored on `this`', async () => {
    const { report } = await scan(
      lines(
        'class P { constructor() { this.t = XMLHttpRequest.prototype } enable() { this.t.send = w } }',
        'new P().enable()',
      ),
    )

    expect(names(report)).toEqual(['XMLHttpRequest.prototype.send'])
    expect(levels(report)).toEqual(['high'])
  })

  test("a call step records the method's dispatch through `this`", async () => {
    const { report } = await scan(
      lines(
        'class P { constructor() { this.t = XMLHttpRequest.prototype } enable() { this.t.send = w } }',
        'const p = new P(); p.enable()',
      ),
    )

    const steps = report.findings[0].occurrences[0].trace.filter((step: Finding) => step.kind === 'call')
    expect(steps).toContainEqual(expect.objectContaining({ callee: 'p.enable', this: 'p', generated: expect.objectContaining({ line: 2 }) }))
  })

  test.each([
    ['an arrow', 'class P { t = window; enable = () => { this.t.fetch = w } }\nnew P().enable()'],
    ['a function', 'class P { t = window; enable = function () { this.t.fetch = w } }\nnew P().enable()'],
  ])('a class field that holds %s dispatches through the instance', async (_, code) => {
    const { report } = await scan(code)

    expect(names(report)).toEqual(['Window.fetch'])
  })

  test('a callback passed to a user function, and invoked there, resolves', async () => {
    const { report } = await scan(lines('function run(cb) { cb(XMLHttpRequest.prototype) }', 'run(p => { p.send = w })'))

    expect(names(report)).toEqual(['XMLHttpRequest.prototype.send'])
    const steps = report.findings[0].occurrences[0].trace.filter((step: Finding) => step.kind === 'call')
    expect(steps).toContainEqual(expect.objectContaining({ callee: 'cb', bindings: [{ parameter: 'p', argument: 'XMLHttpRequest.prototype' }] }))
  })

  test.each([
    ['an unrolled forEach', "[EventTarget.prototype].forEach((t) => { this.w(t, 'addEventListener') })"],
    ['an unrolled map', "[EventTarget.prototype].map((t) => this.w(t, 'addEventListener'))"],
    ['a user function', "each([EventTarget.prototype], (t) => { this.w(t, 'addEventListener') })"],
    ['a nested arrow', "[0].forEach(() => { [EventTarget.prototype].forEach((t) => { this.w(t, 'addEventListener') }) })"],
    ['an arrow invoked in place', "(() => { this.w(EventTarget.prototype, 'addEventListener') })()"],
  ])("an arrow callback invoked by %s sees its enclosing method's `this`", async (_, body) => {
    const { report } = await scan(
      lines(
        'function each(list, cb) { cb(list[0]) }',
        'const o = {',
        '  w(obj, n) { const f = obj[n]; obj[n] = function () { return f.apply(this, arguments) } },',
        `  run() { ${body} },`,
        '}',
        'o.run()',
      ),
    )

    expect(names(report)).toEqual(['EventTarget.prototype.addEventListener'])
    expect(report.findings[0].effect).toBe('wrap')
  })

  test("a method's `?:` of arrays, returned through `this` and iterated by an arrow that calls `this._wrap`, gives every arm's targets", async () => {
    const { report } = await scan(
      lines(
        'class Instr {',
        '  _wrap(obj, n) { const f = obj[n]; obj[n] = function () { return f.apply(this, arguments) } }',
        '  _targets() { return c ? [EventTarget.prototype] : [Node.prototype, Window.prototype] }',
        "  enable() { this._targets().forEach((t) => { this._wrap(t, 'addEventListener') }) }",
        '}',
        'new Instr().enable()',
      ),
    )

    expect(names(report).sort()).toEqual([
      'EventTarget.prototype.addEventListener',
      'Node.prototype.addEventListener',
      'Window.prototype.addEventListener',
    ])
  })

  // `window.EventTarget` may be absent, so both arms are taken (§7).
  test("OpenTelemetry user-interaction's `targets.forEach(target => { this._wrap(target, …) })` gives both arms' targets", async () => {
    const { report } = await scan(
      lines(
        'class Instr {',
        '  _wrap(obj, n, make) { const f = obj[n]; obj[n] = make(f) }',
        '  _patch(original) { return function (...args) { return original.apply(this, args) } }',
        '  _targets() { return window.EventTarget ? [EventTarget.prototype] : [Node.prototype, Window.prototype] }',
        '  enable() {',
        '    const targets = this._targets()',
        "    targets.forEach((target) => { this._wrap(target, 'addEventListener', (f) => this._patch(f)); this._wrap(target, 'removeEventListener', (f) => this._patch(f)) })",
        '  }',
        '}',
        'new Instr().enable()',
      ),
    )

    expect(names(report).sort()).toEqual([
      'EventTarget.prototype.addEventListener',
      'EventTarget.prototype.removeEventListener',
      'Node.prototype.addEventListener',
      'Node.prototype.removeEventListener',
      'Window.prototype.addEventListener',
      'Window.prototype.removeEventListener',
    ])
    // The missing-native arm's holders, iterated and written through two parameters, keep the absence tag (§7).
    const reachability = Object.fromEntries(report.findings.map((finding: Finding) => [finding.target.name, finding.reachability]))
    expect(reachability).toEqual({
      'EventTarget.prototype.addEventListener': 'unconditional',
      'EventTarget.prototype.removeEventListener': 'unconditional',
      'Node.prototype.addEventListener': 'guarded-native-absence',
      'Node.prototype.removeEventListener': 'guarded-native-absence',
      'Window.prototype.addEventListener': 'guarded-native-absence',
      'Window.prototype.removeEventListener': 'guarded-native-absence',
    })
  })

  test.each([
    ['invoked later', "function mk(name) { return function (f) { window[name] = f } }\nconst set = mk('fetch'); set(w)"],
    ['invoked at once', "function mk(name) { return function (f) { window[name] = f } }\nmk('fetch')(w)"],
    ['an arrow', "const mk = (name) => (f) => { window[name] = f }\nconst set = mk('fetch'); set(w)"],
  ])("a closure returned by mk(name) and %s resolves with mk's binding", async (_, code) => {
    const { report } = await scan(code)

    expect(names(report)).toEqual(['Window.fetch'])
    const steps = report.findings[0].occurrences[0].trace.filter((step: Finding) => step.kind === 'call')
    expect(steps).toContainEqual(expect.objectContaining({ callee: 'mk', bindings: [{ parameter: 'name', argument: '"fetch"' }] }))
  })

  test('objects allocated per summary instantiation stay apart, and a method is instantiated once per receiver', async () => {
    const { report } = await scan(
      lines(
        'class Patcher { constructor(o, n) { this.o = o; this.n = n } enable() { const orig = this.o[this.n]; this.o[this.n] = function () { return orig.apply(this, arguments) } } }',
        'const make = (o, n) => new Patcher(o, n)',
        "make(window, 'fetch').enable(); make(XMLHttpRequest.prototype, 'send').enable()",
      ),
    )

    expect(names(report)).toEqual(['Window.fetch', 'XMLHttpRequest.prototype.send'])
    expect(levels(report)).toEqual(['high', 'high'])
  })

  const fetchInstr = (instance: string, call: string) =>
    lines(
      'class FetchInstr {',
      '  constructor() { this.original = window.fetch; this.target = XMLHttpRequest.prototype }',
      '  enable() { const self = this; window.fetch = function (...a) { return self.original.apply(this, a) }; const s = this.target.send; this.target.send = function (...a) { return s.apply(this, a) } }',
      '}',
      instance,
      call,
    )

  test.each([
    ['a resolved call', fetchInstr('const instr = new FetchInstr()', 'instr.enable()')],
    ['no resolved call', fetchInstr('const instr = new FetchInstr()', '')],
    ['no new of the class', fetchInstr('', '')],
  ])('a method gives the same findings with %s', async (_, code) => {
    const { report } = await scan(code)

    expect(names(report)).toEqual(['Window.fetch', 'XMLHttpRequest.prototype.send'])
    expect(levels(report)).toEqual(['high', 'high'])
    for (const finding of report.findings) {
      expect(finding.occurrences[0].trace.filter((step: Finding) => step.kind === 'confidence-reason')).toEqual([])
    }
  })

  test('a caller-less method shows the instance it is assumed to run with in a creation-site step', async () => {
    const { report } = await scan(fetchInstr('const instr = new FetchInstr()', ''))

    const trace = report.findings[1].occurrences[0].trace
    expect(trace.find((step: Finding) => step.kind === 'creation-site')).toMatchObject({ this: 'new FetchInstr()' })
  })

  test.each([
    ['a static member, with the class', 'class Instr { static target = window; static install() { this.target.fetch = w } }', ['Window.fetch']],
    [
      'an ES5 constructor-prototype method, with the instances of new F',
      'function Instr() { this.target = XMLHttpRequest.prototype } Instr.prototype.enable = function () { this.target.send = w }; new Instr()',
      ['XMLHttpRequest.prototype.send'],
    ],
    ['an object-literal method, with the literal', 'const o = { target: window, install() { this.target.fetch = w } }', ['Window.fetch']],
  ])('a caller-less function runs with its `this`: %s', async (_, code, expected) => {
    const { report } = await scan(code)

    expect(names(report)).toEqual(expected)
    expect(levels(report)).toEqual(expected.map(() => 'high'))
    expect(kinds(report.findings[0].occurrences[0])).toContain('creation-site')
  })

  test.each([
    [
      'each receiver',
      lines(
        'class Instr { constructor(h, m) { this.h = h; this.m = m } enable() { const o = this.h[this.m]; this.h[this.m] = function () { return o.apply(this, arguments) } } }',
        "const f = new Instr(window, 'fetch'); const x = new Instr(XMLHttpRequest.prototype, 'send'); f.enable()",
      ),
    ],
    [
      'each closure',
      lines(
        'function makePatch(obj, name) { return (f) => { obj[name] = f(obj[name]) } }',
        "const a = makePatch(window, 'fetch'); const b = makePatch(XMLHttpRequest.prototype, 'send'); a(wrap)",
      ),
    ],
  ])('a function with no resolved call is judged per function object: %s', async (_, code) => {
    const { report } = await scan(code)

    expect(names(report)).toEqual(['Window.fetch', 'XMLHttpRequest.prototype.send'])
    expect(kinds(report.findings[0].occurrences[0])).not.toContain('creation-site')
    expect(kinds(report.findings[1].occurrences[0])).toContain('creation-site')
    expect(report.findings[1].occurrences[0].trace.filter((step: Finding) => step.kind === 'confidence-reason')).toEqual([])
  })

  test.each([
    [
      'a replaced F.prototype',
      'function Instr() { this.target = XMLHttpRequest.prototype } Instr.prototype = { constructor: Instr, enable: function () { this.target.send = w } }; new Instr()',
      'XMLHttpRequest.prototype.send',
    ],
    ['an expando', 'const o = { target: window }; o.install = function () { this.target.fetch = w }', 'Window.fetch'],
    [
      'Object.assign',
      'function Instr() { this.target = XMLHttpRequest.prototype } Object.assign(Instr.prototype, { enable() { this.target.send = w } }); new Instr()',
      'XMLHttpRequest.prototype.send',
    ],
    [
      'defineProperty',
      "function Instr() { this.target = XMLHttpRequest.prototype } Object.defineProperty(Instr.prototype, 'enable', { value: function () { this.target.send = w } }); new Instr()",
      'XMLHttpRequest.prototype.send',
    ],
  ])('a caller-less function held on an object through %s runs with it', async (_, code, expected) => {
    const { report } = await scan(code)

    expect(names(report)).toEqual([expected])
    expect(levels(report)).toEqual(['high'])
  })

  test('a caller-less function passed to a native has an unknown `this`', async () => {
    const { report } = await scan("window.addEventListener('load', function () { this.fetch = wrap(this.fetch) })")

    expect(names(report)).toEqual([])
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.completeness.limitations.map((record: Finding) => record.kind)).toEqual(['unresolved-holder'])
  })

  test.each([
    ["Reflect.apply", "function install(o, m) { o[m] = w }\nReflect.apply(install, null, [XMLHttpRequest.prototype, 'send'])", 'XMLHttpRequest.prototype.send'],
    ['a bound function', "function patch(o, m) { o[m] = w }\nconst e = patch.bind(null, window); e('fetch')", 'Window.fetch'],
    [
      'Reflect.construct',
      "class Patcher { constructor(o, n) { this.o = o; this.n = n } enable() { this.o[this.n] = w } }\nReflect.construct(Patcher, [window, 'fetch']).enable()",
      'Window.fetch',
    ],
  ])('callback invocation follows %s, with a call step', async (_, code, expected) => {
    const { report } = await scan(code)

    expect(names(report)).toEqual([expected])
    expect(kinds(report.findings[0].occurrences[0])).toContain('call')
    expect(kinds(report.findings[0].occurrences[0])).not.toContain('creation-site')
  })

  const chain = (depth: number) =>
    lines(
      'const id = (f) => f',
      'const a1 = id((o, n) => { o[n] = w })',
      ...Array.from({ length: depth - 1 }, (_, index) => `const a${index + 2} = id((o, n) => a${index + 1}(o, n))`),
      `a${depth}(XMLHttpRequest.prototype, 'send')`,
    )

  test('a chain of calls the syntax does not name, three deep, resolves with no limitation', async () => {
    const { report } = await scan(chain(3))

    expect(names(report)).toEqual(['XMLHttpRequest.prototype.send'])
    expect(report.completeness.level).toBe('complete')
  })

  test('a chain of calls the syntax does not name, eight deep, is deferred past the caps while it carries a native, never cut', async () => {
    const { report } = await scan(chain(8))

    expect(names(report)).toEqual(['XMLHttpRequest.prototype.send'])
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.counters.statistics.caps.recursion).toBeUndefined()
  })

  test.each([
    ['a timer','function install(p) { p.send = wrap(p.send) }\nsetTimeout(install, 0, XMLHttpRequest.prototype)'],
    ['a Promise reaction', 'Promise.resolve(window).then((g) => { g.fetch = wrap(g.fetch) })'],
  ])('a callback %s invokes runs caller-less, with unknown parameters', async (_, code) => {
    const { report } = await scan(code)

    expect(names(report)).toEqual([])
    expect(report.completeness.limitations.map((record: Finding) => record.kind)).toEqual(['unresolved-holder'])
  })

  // core-js's export helper, cut down: it chooses `target` from `options` fields, whose tests stay undecided as heap
  // reads, so the real helper gives several candidate holders, which form a candidate set (§5).
  test("an object literal the heap carries iterates its own keys: core-js's $() export helper", async () => {
    const { report } = await scan(
      lines(
        'var definePropertyModule = {}',
        'definePropertyModule.f = function (O, P, Attributes) { Object.defineProperty(O, P, Attributes); return O }',
        'var defineBuiltIn = function (O, key, value, options) {',
        '  if (!options) options = {}',
        '  if (options.unsafe) O[key] = value',
        '  else definePropertyModule.f(O, key, { value: value, enumerable: false, configurable: !options.nonConfigurable, writable: !options.nonWritable })',
        '  return O',
        '}',
        'var exported = { exports: {} }',
        'exported.exports = function (options, source) {',
        '  var TARGET = options.target',
        '  var FORCED, key, targetProperty, sourceProperty',
        '  var target = globalThis[TARGET].prototype',
        '  if (target) for (key in source) {',
        '    sourceProperty = source[key]',
        '    targetProperty = target[key]',
        '    FORCED = options.forced',
        '    if (!FORCED && targetProperty !== undefined) {',
        '      if (typeof sourceProperty == typeof targetProperty) continue',
        '    }',
        '    defineBuiltIn(target, key, sourceProperty, options)',
        '  }',
        '}',
        'var $ = exported.exports',
        "$({ target: 'Array', proto: true }, { flat: function flat() {}, at: function at() {} })",
      ),
    )

    expect(names(report).toSorted()).toEqual(['Array.prototype.at', 'Array.prototype.flat'])
  })

  test('for the lookup point, the call that bound the holder and member counts: a closure\'s creation call, and a new that stored `this` fields', async () => {
    const core = 'webpack://app/./node_modules/@acme/core/index.js'
    const browser = 'webpack://app/./node_modules/@acme/browser/index.js'
    const { report } = await scanBuild(
      mapped([
        [core, 'function makePatch(obj, name) { return (f) => { obj[name] = f(obj[name]) } }'],
        [core, 'class Patcher { constructor(o, n) { this.o = o; this.n = n } enable(f) { this.o[this.n] = f(this.o[this.n]) } }'],
        [browser, "const installFetch = makePatch(window, 'fetch'); const xhr = new Patcher(XMLHttpRequest.prototype, 'send')"],
        ['webpack://app/./src/app.js', 'installFetch(wrapFetch); xhr.enable(wrapSend)'],
      ]),
      [],
      { deps: { resolver } },
    )

    expect(report.findings.map((finding: Finding) => [finding.target.name, finding.fingerprint.split('|').at(-1)])).toEqual([
      ['Window.fetch', 'pkg:@acme/browser'],
      ['XMLHttpRequest.prototype.send', 'pkg:@acme/browser'],
    ])
    for (const finding of report.findings) {
      const occurrence = finding.occurrences[0]
      // The reported position stays the write, in @acme/core.
      expect(occurrence.generated.line).toBeLessThanOrEqual(2)
      // The lookup is at the binding call, in @acme/browser.
      expect(occurrence.trace.find((step: Finding) => step.kind === 'token-check')).toMatchObject({ result: 'passed', lookup: { line: 3 } })
    }
    expect(report.findings.map((finding: Finding) => finding.occurrences[0].trace.find((step: Finding) => step.kind === 'token-check').token)).toEqual([
      'fetch',
      'send',
    ])
  })

  describe('for the lookup point, an argument that carries part of a folded key carries the member', () => {
    const core = 'webpack://app/./node_modules/@acme/core/index.js'
    const hook = "function hook(p, n) { p['set' + n] = wrap(p['set' + n]) }"
    const scanMapped = (files: [string, string][]) => scanBuild(mapped(files), [], { deps: { resolver } })

    test.each([
      ['@acme/browser', 'webpack://app/./node_modules/@acme/browser/index.js', 'pkg:@acme/browser'],
      ['app code', 'webpack://app/./src/instrument.js', 'app:src/instrument.js'],
    ])('hook(XMLHttpRequest.prototype, \'RequestHeader\') called from %s keys it, looked up at the call start with no token', async (_, source, key) => {
      const call = "hook(XMLHttpRequest.prototype, 'RequestHeader')"
      const { report } = await scanMapped([
        [core, hook],
        [source, `var x = 1; ${call}`],
      ])

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.setRequestHeader'])
      expect(report.findings[0].attribution.key).toBe(key)
      const [occurrence] = report.findings[0].occurrences
      // The reported position stays the helper's write, in @acme/core.
      expect(occurrence.generated).toMatchObject({ line: 1 })
      // The lookup is at the call's start, with no token.
      expect(occurrence.original).toMatchObject({ source, line: 1, column: 'var x = 1; '.length })
      expect(report.findings[0].confidence.attribution.reasons).toEqual(['token-check-n/a'])
    })

    test('a template with a substitution folds the key the same way', async () => {
      const { report } = await scanMapped([
        [core, 'function hook(p, n) { p[`set${n}`] = wrap(p[`set${n}`]) }'],
        ['webpack://app/./node_modules/@acme/browser/index.js', "hook(XMLHttpRequest.prototype, 'RequestHeader')"],
      ])

      expect(report.findings.map((finding: Finding) => finding.attribution.key)).toEqual(['pkg:@acme/browser'])
    })

    test('when no call carries both the holder and a part of the key, the helper write is looked up', async () => {
      const { report } = await scanMapped([
        [core, "function hook(p) { var n = 'RequestHeader'; p['set' + n] = wrap(p['set' + n]) }"],
        ['webpack://app/./node_modules/@acme/browser/index.js', 'hook(XMLHttpRequest.prototype)'],
      ])

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.setRequestHeader'])
      expect(report.findings[0].attribution.key).toBe('pkg:@acme/core')
    })
  })
})

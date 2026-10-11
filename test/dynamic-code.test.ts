// Dynamic code for unparseable and indirectly compiled code (§2 Content that isn't JavaScript, §13). Literal
// code given to `eval`, `Function` or a string timer that doesn't parse raises `dynamic-code` at the literal. A call
// that reaches the native `eval`, `Function`, a string timer or another function constructor indirectly raises
// `dynamic-code`, and its code is not analyzed. Every scenario goes through `monkeypatchlist scan --json`, with both binding
// resolvers behind the seam.

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

// Each line is a statement of its own.
const classic = (...lines: string[]) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': lines.join(';\n') })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** The location of `part` in `code` (its first occurrence at or after `from`), as a report gives it. Lines end at LF. */
function at(code: string, part: string, from = 0) {
  const start = code.indexOf(part, from)
  if (start < 0) throw new Error(`${part} is not in the code`)
  const line = code.slice(0, start).split('\n').length
  const lineStart = code.lastIndexOf('\n', start - 1) + 1
  return { start, end: start + part.length, line, column: start - lineStart }
}

/** Each limitation record's kind and location. */
const records = (report: Report) =>
  report.completeness.limitations.map(({ kind, location }: { kind: string; location: unknown }) => ({ kind, location }))

const dynamicCode = (code: string, part: string, from = 0) => ({ kind: 'dynamic-code', location: at(code, part, from) })

describe.each(resolvers)('dynamic code, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe('literal code that does not parse', () => {
    test('a direct eval whose literal the parser refuses gives a dynamic-code record at the literal', async () => {
      const files = classic('function f(){ eval("new.target; window.fetch = a") }')
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([dynamicCode(files['main.js'], '"new.target; window.fetch = a"')])
      expect(report.completeness.level).toBe('complete-with-limitations')
      expect(report.completeness.counters.blindSpots).toMatchObject({ dynamicCode: 1 })
    })

    test('a Function body that closes the function early gives a dynamic-code record, over all its code literals', async () => {
      const files = classic(
        'Function("return 1; }")',
        'new Function("a) { window.fetch = a }; (function(", "")',
        'new Function("a", "window.alert = a")',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings.map((finding: { target: { name: string } }) => finding.target.name)).toEqual(['Window.alert'])
      expect(records(report)).toEqual([
        dynamicCode(code, '"return 1; }"'),
        dynamicCode(code, '"a) { window.fetch = a }; (function(", ""'),
      ])
    })

    test('an indirect eval, a string timer and code nested in a literal that do not parse give records where they are', async () => {
      const files = classic('(0, eval)("window.fetch = ")', 'setTimeout("window.alert = a; }", 0)', 'eval("setTimeout(\'x =\')")')
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        dynamicCode(code, '"window.fetch = "'),
        dynamicCode(code, '"window.alert = a; }"'),
        dynamicCode(code, "'x ='"),
      ])
    })
  })

  describe('indirect calls of a native that compiles code', () => {
    test('eval.call(null, "window.fetch = f") gives a dynamic-code record at its code, and no finding from its code', async () => {
      const files = classic('eval.call(null, "window.fetch = f")')
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([dynamicCode(files['main.js'], '"window.fetch = f"')])
      expect(report.completeness.level).toBe('complete-with-limitations')
    })

    test('Reflect.apply, Reflect.construct, a computed key and (function(){}).constructor each give one', async () => {
      const files = classic(
        'Reflect.apply(eval, null, ["window.fetch = f"])',
        'Reflect.construct(Function, [$s])',
        'window["eval"]("window.alert = f")',
        '(function(){}).constructor("window.open = f")',
        'new window["Function"]("a", "window.print = a")',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        dynamicCode(code, '"window.fetch = f"'),
        dynamicCode(code, '$s'),
        dynamicCode(code, '"window.alert = f"'),
        dynamicCode(code, '"window.open = f"'),
        dynamicCode(code, '"a"'),
      ])
    })

    test('the same forms on a callee that is no native give nothing', async () => {
      const { report } = await scan(
        classic(
          'function f(eval, Function, Reflect, window) {',
          '  eval.call(null, "window.fetch = f")',
          '  Reflect.apply(eval, null, [s])',
          '  Reflect.construct(Function, [s])',
          '  window["eval"](s)',
          '}',
          'function g(Reflect) { Reflect.apply(window.eval, null, [s]) }',
          'o.eval.call(null, s)',
          '({ constructor: f }).constructor(s)',
          'x.constructor.constructor(s)',
          'window["alert"](s)',
          '(0, eval.call)(null, s)',
        ),
      )

      expect(report.findings).toEqual([])
      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.level).toBe('complete')
    })

    test('any route shown to reach one counts: .bind, .apply, .constructor of any known function, and chains of them', async () => {
      const files = classic(
        'eval.bind(null)($a)',
        'new (Function.bind(null, "b"))("c")',
        'eval.apply(null, arguments)',
        '[]["constructor"]["constructor"]($d)',
        '"".constructor.constructor($e)',
        'Function.prototype.constructor("window.fetch = f")',
        'Function.prototype.call.call(eval, null, $g)',
        'Reflect.apply(Function.prototype.call, eval, [null, $h])',
        'window.Function.apply(null, [$i])',
        'self["set" + "Timeout"]("window.alert = f")',
        'parent["eval"]($j)',
        // A bound function calls its target with its bound `this`: here `.call`, with `this` the native `eval`.
        'Function.prototype.call.bind(eval)(null, $k)',
        'Function.prototype.apply.bind(Function)(null, [$l])',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        dynamicCode(code, '$a'),
        dynamicCode(code, '"b"'),
        dynamicCode(code, 'arguments'),
        dynamicCode(code, '$d'),
        dynamicCode(code, '$e'),
        dynamicCode(code, '"window.fetch = f"'),
        dynamicCode(code, '$g'),
        dynamicCode(code, '$h'),
        dynamicCode(code, '$i'),
        dynamicCode(code, '"window.alert = f"'),
        dynamicCode(code, '$j'),
        dynamicCode(code, '$k'),
        dynamicCode(code, '$l'),
      ])
    })

    test('so does any route to %AsyncFunction%, %GeneratorFunction% or %AsyncGeneratorFunction%', async () => {
      const files = classic(
        '(async function(){}).constructor("await x")',
        '(async () => {}).constructor($a)',
        'Object.getPrototypeOf(function*(){}).constructor("yield window.fetch = f")',
        'new (Reflect.getPrototypeOf(async function*(){}).constructor)($b)',
        // `%AsyncFunction%` inherits from `Function` itself.
        'Object.getPrototypeOf((async () => {}).constructor)($c)',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        dynamicCode(code, '"await x"'),
        dynamicCode(code, '$a'),
        dynamicCode(code, '"yield window.fetch = f"'),
        dynamicCode(code, '$b'),
        dynamicCode(code, '$c'),
      ])
    })

    test('a call that reaches eval or a function constructor counts whatever it passes, and a timer when it is a string timer', async () => {
      const files = classic(
        'eval.call(null, 42)',
        'eval.call(null)',
        'eval.apply(null, [function(){}])',
        'setTimeout.call(window, function(){}, 10)',
        'setTimeout.apply(window, arguments)',
        'setInterval.call(window, callback, 10)',
        'Function.call(null)',
        'Reflect.construct(Function, [])',
        'new eval.bind(null)("window.fetch = f")',
        'Reflect.construct(eval, ["window.alert = f"])',
        'setTimeout.call(window, "tick()")',
        'setInterval.bind(null, "go(" + id + ")")()',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      // A call located where it passes its code, or at the call when it passes none. `new` throws before a function
      // that is no constructor runs, and a timer whose handler is no string is no string timer.
      expect(records(report)).toEqual([
        dynamicCode(code, '42'),
        dynamicCode(code, 'eval.call(null)'),
        dynamicCode(code, 'function(){}'),
        dynamicCode(code, 'Function.call(null)'),
        dynamicCode(code, 'Reflect.construct(Function, [])'),
        dynamicCode(code, '"tick()"'),
        dynamicCode(code, '"go(" + id + ")"'),
      ])
    })

    test('an argument list that makes the call throw before it reaches the native gives nothing', async () => {
      const files = classic(
        'Reflect.apply(eval, null)',
        'Reflect.apply(eval, null, null)',
        'Reflect.construct(Function)',
        'Reflect.construct(Function, "window.fetch = f")',
        'eval.apply(null, "window.alert = f")',
        'Function.apply(null, 5)',
        'eval.apply(null, null)',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      // Reflect.apply and Reflect.construct need an array-like object, and `.apply` one or nothing
      // (CreateListFromArrayLike). `.apply` with a `null` list passes no arguments, so only that call reaches `eval`.
      expect(records(report)).toEqual([dynamicCode(code, 'eval.apply(null, null)')])
    })

    test('a tagged template calls its tag with its strings array, which Function and a timer compile as a string', async () => {
      const files = classic(
        'Function`window.fetch = f`',
        'setTimeout`window.alert = f`',
        'eval`window.open = f`',
        'Reflect.construct`${Function}`',
        'o.setTimeout`window.print = f`',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        dynamicCode(code, '`window.fetch = f`'),
        dynamicCode(code, '`window.alert = f`'),
        dynamicCode(code, '`window.open = f`'),
      ])
    })

    test('a long route is followed once per step, however it nests', async () => {
      const files = classic(`eval${'.bind(null)'.repeat(40)}($x)`, `a${'.b()'.repeat(200)}.call($y)`)
      const { report } = await scan(files)

      expect(records(report)).toEqual([dynamicCode(files['main.js'], '$x')])
    })

    test("in a worker, its global object's inherited string timer is reached the same way", async () => {
      const { report } = await scan({
        'index.html': '<script>new Worker("worker.js")</script>',
        'worker.js': 'self["setTimeout"]("Math.random = a"); setTimeout.call(self, "Math.max = b")',
      })

      expect(report.findings).toEqual([])
      expect(records(report).map(({ kind }: { kind: string }) => kind)).toEqual(['dynamic-code', 'dynamic-code'])
    })
  })

  describe('more shown routes', () => {
    test('a catalog reader given the global object and a constant key reaches its member', async () => {
      const files = classic(
        'Reflect.get(window, "eval")($a)',
        'Object.getOwnPropertyDescriptor(window, "eval").value($b)',
        'Reflect.getOwnPropertyDescriptor(self, "Function").value.call(null, $c)',
        'Reflect.get(Array.prototype.map, "constructor")($d)',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        dynamicCode(code, '$a'),
        dynamicCode(code, '$b'),
        dynamicCode(code, '$c'),
        dynamicCode(code, '$d'),
      ])
      expect(report.completeness.level).toBe('complete-with-limitations')
    })

    test('an unknown object, a key that is not constant or a primitive given to a reader shows nothing', async () => {
      const { report } = await scan(
        classic(
          'Reflect.get(o, "eval")(s)',
          'Reflect.get(window, k)(s)',
          'Object.getOwnPropertyDescriptor(o, "eval").value(s)',
          'Object.getOwnPropertyDescriptor(Function.prototype, "call").value(s)',
          'Reflect.get("", "constructor").constructor(s)',
        ),
      )

      expect(report.completeness.limitations).toEqual([])
    })

    test('.constructor of a class literal whose statics do not write constructor, or of a local function never written', async () => {
      const files = classic(
        '(class { static x = 1 }).constructor($a)',
        '(function(){ function f(){} f.constructor($b) })()',
        '(class { static x = init(this) }).constructor($c)',
        '(class { static m() {} static #p = 1; y = 2 }).constructor.call(null, $d)',
        '(function(){ function* g(){} g.constructor.bind(null)($e) })()',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(records(report)).toEqual([
        dynamicCode(code, '$a'),
        dynamicCode(code, '$b'),
        dynamicCode(code, '$c'),
        dynamicCode(code, '$d'),
        dynamicCode(code, '$e'),
      ])
    })

    test('an unknown base shows nothing', async () => {
      const { report } = await scan(
        classic(
          '(class extends B { }).constructor(s)',
          '({...o}).constructor(s)',
          'o.constructor(s)',
          '(class { static constructor() {} }).constructor(s)',
          '(class { static get "constructor"() {} }).constructor(s)',
        ),
      )

      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.level).toBe('complete')
    })

    test('.constructor of any function-valued catalog member reaches Function, through .call, .apply and .bind too', async () => {
      const files = classic(
        "[]['filter']['constructor']($a)",
        'Array.prototype.map.constructor($b)',
        'alert.constructor($c)',
        'Math.max.constructor($d)',
        'console.log.constructor($e)',
        'alert.constructor.call(null, $f)',
        'window.fetch.constructor.apply(null, [$g])',
        'Math.min.constructor.bind(null)($h)',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        dynamicCode(code, '$a'),
        dynamicCode(code, '$b'),
        dynamicCode(code, '$c'),
        dynamicCode(code, '$d'),
        dynamicCode(code, '$e'),
        dynamicCode(code, '$f'),
        dynamicCode(code, '$g'),
        dynamicCode(code, '$h'),
      ])
    })

    test('a base stops being shown when a static key may be constructor, its name is written, or seen code changes it', async () => {
      const { report } = await scan(
        classic(
          '(class { static { this.constructor = g } }).constructor(s)',
          '(class { static [k]() {} }).constructor(s)',
          '(class C { static m() { C.__proto__ = P } }).constructor(s)',
          '(class { static x = Object.setPrototypeOf(this, P) }).constructor(s)',
          '(function(){ function f(){} f.constructor = g; f.constructor(s) })()',
          "(function(){ function f(){} Object.defineProperty(f, 'constructor', d); f.constructor(s) })()",
          '(function(){ function f(){} Object.setPrototypeOf(f, P); f.constructor(s) })()',
          '(function(){ function f(){} f = g; f.constructor(s) })()',
          '(function(){ function f(){} [f] = a; f.constructor(s) })()',
          '(function(){ function f(){} function f(){ } f.constructor(s) })()',
          '(function(){ function f(){} Object.assign(f, { constructor: g }); f.constructor(s) })()',
          "(function(){ function f(){} Reflect.set(f, 'constructor', g); f.constructor(s) })()",
          'function h(){} h = g; h.constructor(s)',
          'function n(c){ new c.constructor(s); arguments.constructor(s) }',
          'function p(p){ p.constructor(s) }',
        ),
      )

      expect(report.completeness.limitations).toEqual([])
    })

    test('code that only may change the base, or changes another, leaves it shown', async () => {
      const files = classic(
        '(function(){ function f(){} f[k] = g; f.constructor($a) })()',
        '(function(){ function f(){} function i(){} i.constructor = g; f.constructor($b) })()',
        '(function(){ function f(){} (function(f){ f = 1 })(); f.constructor($c) })()',
        '(class { static ["x"]() {} m() { this.constructor = g } }).constructor($d)',
        '(class { static { this.x = g; (function(){ this.constructor = g })() } }).constructor($e)',
        '(class C { static m() { C.x = P } }).constructor($f)',
        '(function(){ function f(){} Object.defineProperty(f, k, d); f.constructor($g) })()',
        'function q(q){ q = 1 } q.constructor($h)',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(records(report)).toEqual([
        dynamicCode(code, '$a'),
        dynamicCode(code, '$b'),
        dynamicCode(code, '$c'),
        dynamicCode(code, '$d'),
        dynamicCode(code, '$e'),
        dynamicCode(code, '$f'),
        dynamicCode(code, '$g'),
        dynamicCode(code, '$h'),
      ])
    })
  })

  describe('class declarations and named function expressions', () => {
    test('.constructor of a class declaration or of a named function expression by its own name gives one record each', async () => {
      const files = classic('class C {}', 'C.constructor($a)', '(function g(){ g.constructor($b) })()')
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([dynamicCode(code, '$a'), dynamicCode(code, '$b')])
      expect(report.completeness.level).toBe('complete-with-limitations')
    })

    test('the stop rules apply to both, and a class declaration with an unknown base shows nothing', async () => {
      const { report } = await scan(
        classic(
          '(function(){ class C { static constructor(){} } C.constructor(s) })()',
          '(function(){ class C {} C.constructor = g; C.constructor(s) })()',
          '(function(){ class C {} Object.setPrototypeOf(C, P); C.constructor(s) })()',
          '(function(){ class C {} C = g; C.constructor(s) })()',
          '(function(){ class C { static [k]() {} } C.constructor(s) })()',
          '(function(){ class C { static { this.constructor = g } } C.constructor(s) })()',
          '(function(){ class C extends B {} C.constructor(s) })()',
          '(function g(){ g.constructor = h; g.constructor(s) })()',
          '(function g(){ Object.setPrototypeOf(g, P); g.constructor(s) })()',
          '(function g(){ g = h; g.constructor(s) })()',
          '(function g(g){ g.constructor(s) })()',
          '(function arguments(){ arguments.constructor(s) })()',
        ),
      )

      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.level).toBe('complete')
    })

    test('a const alias of a class or function is not followed (§21)', async () => {
      const { report } = await scan(classic('const K = class {}', 'K.constructor(s)', 'const F = function(){}', 'F.constructor(s)'))

      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.level).toBe('complete')
    })

    test('a read of a class declaration before it is initialized throws, so gives nothing (Principle 1)', async () => {
      const files = classic(
        'D.constructor(s)',
        'class D {}',
        'class E extends E.constructor(s) {}',
        'class F { [F.constructor(s)]() {} static x = F.constructor($a) }',
        'function later(){ G.constructor($b) }',
        'class G {}',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(records(report)).toEqual([dynamicCode(code, '$a'), dynamicCode(code, '$b')])
    })
  })

  describe('alternatives (Principle 3)', () => {
    test('a callee or computed key any of whose values reaches a native raises what that value raises', async () => {
      const files = classic(
        '(c ? eval : f).call(null, $a)',
        'window[c ? "eval" : "x"]($b)',
        '(o.e || eval).apply(null, [$c])',
        'window[k ? "setTimeout" : "x"]("window.fetch = f")',
        '(c ? Reflect.construct : f)(Function, [$d])',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        dynamicCode(code, '$a'),
        dynamicCode(code, '$b'),
        dynamicCode(code, '$c'),
        dynamicCode(code, '"window.fetch = f"'),
        dynamicCode(code, '$d'),
      ])
      expect(report.completeness.level).toBe('complete-with-limitations')
    })

    test('alternatives that reach different natives give one record for each native', async () => {
      const files = classic('(c ? eval : Function).call(null, $a)', 'window[c ? "eval" : "Function"]($b)')
      const code = files['main.js']
      const { report } = await scan(files)

      const details = report.completeness.limitations.map((record: { detail: string }) => record.detail)
      expect(records(report)).toEqual([
        dynamicCode(code, '$a'),
        dynamicCode(code, '$a'),
        dynamicCode(code, '$b'),
        dynamicCode(code, '$b'),
      ])
      expect(details.filter((detail: string) => detail.includes('`eval`'))).toHaveLength(2)
      expect(details.filter((detail: string) => detail.includes('`Function`'))).toHaveLength(2)
    })

    test('a test that decides the branch leaves only that alternative', async () => {
      const files = classic('(false ? eval : f).call(null, s)', 'window[1 ? "x" : "eval"](s)', '(f || eval).call(null, $a)')
      const { report } = await scan(files)

      expect(records(report)).toEqual([dynamicCode(files['main.js'], '$a')])
    })

    test('a callee whose alternative is a native called directly raises what that call raises on its own', async () => {
      const files = classic(
        '(c ? eval : f)("window.fetch = g")',
        '(c ? eval : window.eval)($a)',
        'new (c ? Function : f)("a", "window.alert = a")',
        '(c ? setTimeout : f)($b + "")',
        '(c ? eval : eval.bind(null))($d)',
        '(true ? eval : f)("window.print = g")',
        '(f && eval)("window.stop = g")',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings.map((finding: { target: { name: string } }) => finding.target.name).sort()).toEqual([
        'Window.alert',
        'Window.fetch',
        'Window.print',
        'Window.stop',
      ])
      expect(records(report)).toEqual([dynamicCode(code, '$a'), dynamicCode(code, '$b + ""'), dynamicCode(code, '$d')])
    })
  })

  describe('number, boolean and null literals given to Function', () => {
    test('as the body they are converted with ToString, and the call is analyzed as nested code', async () => {
      const files = classic(
        'Function("a = window.fetch = f", 1)',
        'Function("b = window.alert = f", true)',
        'new Function("c = window.open = f", null)',
        'Function("d = window.print = f", 1e21)',
        'Function("e = window.stop = f", 0x10n)',
      )
      const { report } = await scan(files)

      expect(report.findings.map((finding: { target: { name: string } }) => finding.target.name).sort()).toEqual([
        'Window.alert',
        'Window.fetch',
        'Window.open',
        'Window.print',
        'Window.stop',
      ])
      expect(records(report)).toEqual([])
      expect(report.completeness.level).toBe('complete')
    })

    test('as a parameter they convert to no parameter name, so the literal code does not parse', async () => {
      const files = classic(
        'Function(1, "window.fetch = f")',
        'Function(true, "window.alert = f")',
        'Function("a", null, "window.open = f")',
      )
      const code = files['main.js']
      const { report } = await scan(files)

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        dynamicCode(code, '1, "window.fetch = f"'),
        dynamicCode(code, 'true, "window.alert = f"'),
        dynamicCode(code, '"a", null, "window.open = f"'),
      ])
    })
  })

})

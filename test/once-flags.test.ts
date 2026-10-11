// Once-flags (§5 Resolver capabilities 6): lazy init and memoized getters are transparent to values, a flag is
// recognized by use and its tests are never decided as constants, and lazy init narrows. Also §3's delete that is
// always rewritten. Every scenario goes through `monkeypatchlist scan --json`.

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
type Finding = any

const fingerprints = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.fingerprint)
const addEventListener = 'window|EventTarget.prototype.addEventListener|replace|unknown'
const send = 'window|XMLHttpRequest.prototype.send|replace|unknown'
const fetch = 'window|Window.fetch|replace|unknown'

describe.each(resolvers)('once-flags, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test.each([
    ['Rollup\'s `requireX`', 'var hasRequired, x; function requireX(){ if (hasRequired) return x; hasRequired = 1; x = XMLHttpRequest.prototype; return x } requireX().send = w'],
    ['Rollup\'s `requireX` with an exports object', 'var hasRequired, x = {}; function requireX(){ if (hasRequired) return x; hasRequired = 1; x.proto = XMLHttpRequest.prototype; return x } function p(){ requireX().proto.send = w } p()'],
    ['`if (!p)`', 'var p; function getP(){ if (!p) p = XMLHttpRequest.prototype; return p } getP().send = w'],
    ['`p || (p = …)`', 'var p; function getP(){ return p || (p = XMLHttpRequest.prototype) } getP().send = w'],
  ])('a memoized getter returns its holder: %s', async (_, code) => {
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual([send])
    expect(report.findings[0].occurrences[0].confidence.target.level).toBe('high')
  })

  test.each([
    ['at the top level', 'var h; h || (h = history); h.pushState = w'],
    ['in a function', 'var h; function f(){ h || (h = history); h.pushState = w } f()'],
    ['with `if`', '(function(){ var h = null; if (h == null) h = history; h.pushState = w })()'],
  ])('lazy init gives the aliased holder: %s', async (_, code) => {
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual(['window|history.pushState|replace|unknown'])
    expect(report.findings[0].occurrences[0].confidence.target.level).toBe('high')
  })

  test.each([
    ['`if (!k)`', 'var k = null; function key(){ if (!k) k = "add" + "EventListener"; return k } EventTarget.prototype[key()] = w'],
    ['`if (k == null)`', 'var k = null; function key(){ if (k == null) k = "add" + "EventListener"; return k } EventTarget.prototype[key()] = w'],
    ['`k || (k = …)` as a statement', 'var k = null; function key(){ k || (k = "add" + "EventListener"); return k } EventTarget.prototype[key()] = w'],
    ['`k || (k = …)` as a value', 'var k = null; function key(){ return k || (k = "add" + "EventListener") } EventTarget.prototype[key()] = w'],
    ['`k ??= …`', 'var k = null; function key(){ k ??= "add" + "EventListener"; return k } EventTarget.prototype[key()] = w'],
    ['a block in a function scope', '(function(){ var k = null; if (!k) { k = "addEventListener" } EventTarget.prototype[k] = w })()'],
  ])('lazy init narrows: %s gives only the assigned target', async (_, code) => {
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual([addEventListener])
    expect(report.findings[0].occurrences[0].confidence.target.level).toBe('high')
  })

  test.each([
    ['Rollup\'s `hasRequiredX`', 'var Ki,Yi,Xi={};function Zi(){if(Ki)return Xi;Ki=1} function f(){ Zi(); (Ki ? {} : XMLHttpRequest.prototype).send = w } f()'],
    ['`ge||(ge=1,…)`', 'var ge; function f(){ ge||(ge=1,g()) } function p(){ (ge ? {} : XMLHttpRequest.prototype).send = w } f(); p()'],
    ['`Fc||(Fc=!0,Gn(Zi))`', 'var Fc; function Gn(f){ f() } function Zi(){} function f(){ Fc||(Fc=!0,Gn(Zi)) } function p(){ (Fc ? {} : XMLHttpRequest.prototype).send = w } f(); p()'],
    ['esbuild\'s `__esm` `t`', 'var __esm = (t, e) => function(){ (t ? XMLHttpRequest.prototype : {}).send = w; return t&&(e=(0,t[Object.keys(t)[0]])(t=0)),e }; __esm({ "a.js"(){} })()'],
    ['esbuild\'s `r`', 'var r; function init(){ if(r)throw r[0]; try { g() } catch(i){ r=[i] } } function p(){ init(); (r ? {} : XMLHttpRequest.prototype).send = w } p()'],
    ['a string flag', 'var st; function start(){ if (st) return; st = "on" } function p(){ start(); (st ? {} : XMLHttpRequest.prototype).send = w } p()'],
    ['a flag assigned in a call on the path', 'var ready; function mark(){ ready = true } function init(){ if (!ready) mark() } function p(){ init(); (ready ? {} : XMLHttpRequest.prototype).send = w } p()'],
    ['a parameter', 'function once(done){ return function(){ if (done) return; done = 1; (done ? {} : XMLHttpRequest.prototype).send = w } } once(false)()'],
  ])('a once-flag\'s test is never decided: %s', async (_, code) => {
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual([send])
  })

  test.each([
    ['||, a flag true', "var st; function s(){ if (st) return; st = true } s(); XMLHttpRequest.prototype[st || 'send'] = w", 'send'],
    ['&&, a flag true or undefined', "var st; function s(){ if (st) return; st = true } s(); XMLHttpRequest.prototype[st && 'open'] = w", 'open'],
    ['??, a flag null or false', "var st = null; function s(){ if (st) return; st = false } s(); XMLHttpRequest.prototype[st ?? 'send'] = w", 'send'],
  ])(
    "a once-flag test operand's boolean, null or undefined in %s selection is never a key, and the key keeps member-alternatives",
    async (_, code, member) => {
      const { report } = await scan(code)

      expect(report.findings.map((finding: Finding) => finding.target.name)).toEqual([`XMLHttpRequest.prototype.${member}`])
      expect(report.findings[0].confidence.target.level).toBe('medium')
      expect(report.findings[0].confidence.target.reasons).toEqual(['member-alternatives'])
      const step = report.findings[0].occurrences[0].trace.find(
        (each: Finding) => each.kind === 'confidence-reason' && each.reason === 'member-alternatives',
      )
      expect(step).toBeDefined()
    },
  )

  test("a once-flag's string is still a key: `st || 'send'` with `st = 'on'` gives .on and .send", async () => {
    const { report } = await scan("var st; function s(){ if (st) return; st = 'on' } s(); XMLHttpRequest.prototype[st || 'send'] = w")

    expect(report.findings.map((finding: Finding) => finding.target.name)).toEqual([
      'XMLHttpRequest.prototype.on',
      'XMLHttpRequest.prototype.send',
    ])
  })

  test.each([
    ['`if (installed) return; installed = true`', 'var installed = false; function install(){ if (installed) return; installed = true; window.fetch = w } install(); install()'],
    ['`if(Ki)return Xi;Ki=1`', 'var Ki,Xi={};function Zi(){if(Ki)return Xi;Ki=1;window.fetch=w;return Xi} Zi(); Zi()'],
    ['`ge||(ge=1,…)`', 'var ge; function f(){ ge||(ge=1,window.fetch=w) } f(); f()'],
    ['`Fc||(Fc=!0,Gn(Zi))`', 'var Fc=!1; function Gn(f){ f() } function Zi(){ window.fetch = w } function f(){ Fc||(Fc=!0,Gn(Zi)) } f(); f()'],
    ['`var st; function start(){ if (st) return; st = "on"; … }`', 'var st; function start(){ if (st) return; st = "on"; window.fetch = w }'],
  ])('an install guarded by a once-flag keeps its finding: %s', async (_, code) => {
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual([fetch])
  })

  test('a variable no function tests before assigning it is a constant whose tests decide', async () => {
    const { report } = await scan(
      'var Nl, rc; var init = function(){ Nl = 4; rc = "send" }; function p(){ (Nl === 4 ? XMLHttpRequest.prototype : {})[rc] = w; (Nl === 4 ? {} : WebSocket.prototype).close = w } init(); p()',
    )

    expect(fingerprints(report)).toEqual([send])
  })

  test('a test of a catalog native stays a guard, not a flag', async () => {
    const { report } = await scan('var P = window.Promise; function f(){ P || (P = 1); (P ? {} : XMLHttpRequest.prototype).send = w } f()')

    expect(fingerprints(report)).toEqual([])
  })

  const defineBuiltIn = (f: string) =>
    `function defineBuiltIn(O, key, value, options){ if (!options) options = {}; var simple = options.enumerable; try { if (!options.unsafe) delete O[key]; else if (O[key]) simple = true } catch (e) {} if (simple) O[key] = value; else definePropertyModule.f(O, key, { value: value, enumerable: false, configurable: !options.nonConfigurable, writable: !options.nonWritable }); return O } var definePropertyModule = { f: ${f} }; defineBuiltIn(Array.prototype, Symbol.iterator, function values(){}, { name: 'values' })`

  test.each([
    ['an aliased native define', 'var $defineProperty = Object.defineProperty; function defineBuiltIn(O, key, value, options){ if (!options) options = {}; var simple = options.enumerable; try { if (!options.unsafe) delete O[key]; else if (O[key]) simple = true } catch (e) {} if (simple) O[key] = value; else $defineProperty(O, key, { value: value, enumerable: false, configurable: true, writable: true }); return O } defineBuiltIn(Array.prototype, Symbol.iterator, function values(){}, { name: "values" })'],
    ['a helper that defines', defineBuiltIn('function (O, P, A) { return Object.defineProperty(O, P, A) }')],
    ['a minified conditional', 'function d(t,e,n,o){o||(o={});var u=o.enumerable;try{o.unsafe?t[e]&&(u=!0):delete t[e]}catch(r){}return u?t[e]=n:Object.defineProperty(t,e,{value:n,enumerable:!1,configurable:!0,writable:!0}),t} d(Array.prototype,Symbol.iterator,function(){},{})'],
    ['an assign right after', 'delete Array.prototype.at; Array.prototype.at = f'],
    ['a bulk define right after', 'delete Array.prototype.at; Object.defineProperties(Array.prototype, { at: { value: f, writable: true, configurable: true } })'],
  ])('a delete the same function always follows with a write of the same slot gives no finding: %s', async (_, code) => {
    const { report } = await scan(code)

    expect(report.findings.map((finding: Finding) => [finding.target.name, finding.effect])).toEqual([
      [code.startsWith('delete') ? 'Array.prototype.at' : 'Array.prototype.@@iterator', 'replace'],
    ])
    const notes = report.findings[0].occurrences.flatMap((occurrence: Finding) =>
      occurrence.trace.filter((step: Finding) => step.kind === 'note' && step.about === 'rewritten-delete'),
    )
    expect(notes.length).toBeGreaterThan(0)
    expect(notes.every((note: Finding) => note.delete.line === 1)).toBe(true)
  })

  test.each([
    ['a write on only one path', 'function d(O, k, c){ delete O[k]; if (c) O[k] = 1 } d(Array.prototype, "at", x)'],
    ['a write of another holder', 'function d(O, P, k){ delete O[k]; P[k] = 1 } d(Array.prototype, String.prototype, "at")'],
    ['a return before the write', 'function d(O, k, c){ delete O[k]; if (c) return; O[k] = 1 } d(Array.prototype, "at", x)'],
    ['a write in another function', 'function d(O, k){ delete O[k] } function r(O, k){ O[k] = 1 } d(Array.prototype, "at"); r(Array.prototype, "at")'],
  ])('a delete that is not always rewritten stays a delete finding: %s', async (_, code) => {
    const { report } = await scan(code)

    expect(report.findings.map((finding: Finding) => finding.effect)).toContain('delete')
  })

  test('a delete one instantiation does not rewrite keeps its finding, and no write notes it as rewritten', async () => {
    const { report } = await scan(
      'function d(O, k, r){ delete O[k]; r(O, k) } d(Array.prototype, "at", function (O, k){ O[k] = 1 }); d(Array.prototype, "at", function (){})',
    )

    expect(report.findings.map((finding: Finding) => [finding.target.name, finding.effect])).toEqual([
      ['Array.prototype.at', 'delete'],
      ['Array.prototype.at', 'replace'],
    ])
    const notes = report.findings.flatMap((finding: Finding) =>
      finding.occurrences.flatMap((occurrence: Finding) =>
        occurrence.trace.filter((step: Finding) => step.kind === 'note' && step.about === 'rewritten-delete'),
      ),
    )
    expect(notes).toEqual([])
  })
})

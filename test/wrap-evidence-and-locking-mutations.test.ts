// Wrap evidence and locking mutations (§5 Resolver capabilities 10, §8 Effect and mechanism, `locks`): a replacement
// shown to call the original is a `wrap`, and a mutation that leaves its target non-configurable, or a non-writable
// data property, locks it. Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

const scan = async (code: string) => (await scanBuild(classic(code))).report
/** Each finding as `target|effect|locks`. */
const found = (report: { findings: Finding[] }): string[] =>
  report.findings.map((finding) => `${finding.target.name}|${finding.effect}|${String(finding.locks)}`)

describe('locks', () => {
  test('a define that makes its target non-configurable locks it', async () => {
    const report = await scan("Object.defineProperty(window, 'fetch', { value: f, configurable: false })")
    expect(found(report)).toEqual(['Window.fetch|replace|true'])
  })

  test('a define whose descriptor the analyzer cannot see leaves locks unknown', async () => {
    const report = await scan("Object.defineProperty(window, 'fetch', d)")
    expect(found(report)).toEqual(['Window.fetch|descriptor-change|unknown'])
  })

  test('`configurable: undefined` is false, so a define of the native value with it locks the target (R3)', async () => {
    const report = await scan("Object.defineProperty(window, 'fetch', { value: window.fetch, configurable: undefined })")
    expect(found(report)).toEqual(['Window.fetch|descriptor-change|true'])
  })

  test('a non-writable data property locks, and a configurable getter does not', async () => {
    const report = await scan(
      lines(
        "Object.defineProperty(window, 'fetch', { value: f, writable: false })",
        "Object.defineProperty(XMLHttpRequest.prototype, 'send', { get: () => wrapped, configurable: true })",
      ),
    )
    expect(found(report)).toEqual(['Window.fetch|replace|true', 'XMLHttpRequest.prototype.send|descriptor-change|false'])
  })

  test('a field the define leaves out keeps the attribute the target had', async () => {
    const report = await scan("Object.defineProperty(window, 'fetch', { value: f })")
    expect(found(report)).toEqual(['Window.fetch|replace|false'])
  })

  test('a property a define adds starts non-configurable and non-writable, so it locks unless the define says otherwise', async () => {
    const report = await scan(
      lines(
        "Object.defineProperty(Array.prototype, 'first', { value: f })",
        "Object.defineProperty(Array.prototype, 'last', { value: f, writable: true, configurable: true })",
      ),
    )
    expect(found(report)).toEqual(['Array.prototype.first|add|true', 'Array.prototype.last|add|false'])
  })

  test('a plain assignment never locks', async () => {
    const report = await scan('window.fetch = f')
    expect(found(report)).toEqual(['Window.fetch|replace|false'])
  })
})

describe('wrap evidence', () => {
  test('a new value that applies a captured original is a wrap', async () => {
    const report = await scan('const o = window.fetch; window.fetch = function(){ return o.apply(this, arguments) }')
    expect(found(report)).toEqual(['Window.fetch|wrap|false'])
  })

  test.each([
    ['a Proxy over the original', 'window.fetch = new Proxy(window.fetch, h)'],
    ['a factory that receives the original', 'window.fetch = wrapFactory(window.fetch)'],
    ['a `.bind` rebind of the original', 'window.fetch = window.fetch.bind(window)'],
    ['a `.bind` of a bare global timer', 'window.setTimeout = setTimeout.bind(window)'],
    ['a `.bind` of a captured original', 'const o = fetch; window.fetch = o.bind(null)'],
    ['a class that extends the original and calls super', 'const W = window.WebSocket; window.WebSocket = class extends W { constructor(u, p){ super(u, p); track(this) } }'],
    ['a constructor that news the original', 'const X = window.XMLHttpRequest; window.XMLHttpRequest = function(){ const x = new X(); hook(x); return x }'],
    ['Reflect.apply of the original', 'const o = window.fetch; window.fetch = (...a) => Reflect.apply(o, window, a)'],
    ['a call in a closure the new value creates', 'const o = window.fetch; window.fetch = function(){ return p.then(() => o.apply(this, arguments)) }'],
    ['a call through a bound copy', 'const b = window.fetch.bind(window); window.fetch = function(){ return b.apply(null, arguments) }'],
    ['a direct call of a captured original', 'const o = window.fetch; window.fetch = function(a, b){ return o(a, b) }'],
    ['Reflect.construct of the original', 'const X = window.XMLHttpRequest; window.XMLHttpRequest = function(){ return Reflect.construct(X, []) }'],
    [
      'a captured original reached through a long chain of aliases, with no depth cap',
      'const a = window.fetch; const b = a; const c = b; const d = c; const e = d; const f = e; const g = f; window.fetch = function(){ return g.apply(this, arguments) }',
    ],
    [
      'a call in a helper several helpers deep, with no depth cap',
      lines(
        'function h1(f, a){ return f.apply(null, a) }',
        'function h2(f, a){ return h1(f, a) }',
        'function h3(f, a){ return h2(f, a) }',
        'function h4(f, a){ return h3(f, a) }',
        'function h5(f, a){ return h4(f, a) }',
        'function h6(f, a){ return h5(f, a) }',
        'const o = window.fetch; window.fetch = function(){ return h6(o, arguments) }',
      ),
    ],
  ])('%s is a wrap', async (_, code) => {
    const report = await scan(code)
    expect(report.findings.map((finding: Finding) => finding.effect)).toEqual(['wrap'])
  })

  test('a call in a helper the summaries resolve is a wrap', async () => {
    const report = await scan(
      lines(
        'function callThrough(f, args){ return f.apply(null, args) }',
        'const o = window.fetch; window.fetch = function(){ return callThrough(o, arguments) }',
      ),
    )
    expect(found(report)).toEqual(['Window.fetch|wrap|false'])
  })

  test.each([
    ['a replacement with no evidence', 'window.fetch = function(){ return 1 }'],
    ['a frozen original, since Object.freeze is a catalog native', 'window.Promise = Object.freeze(window.Promise)'],
    ["another window's copy", 'const clean = iframe.contentWindow.fetch; window.fetch = function(){ return clean.apply(window, arguments) }'],
    ['a read at call time through the object written, which then holds the new value', 'window.fetch = function(){ return window.fetch.apply(this, arguments) }'],
  ])('%s is a replace', async (_, code) => {
    const report = await scan(code)
    expect(report.findings.map((finding: Finding) => finding.effect)).toEqual(['replace'])
  })

  test.each([
    ['a factory whose summary picks among its arguments', "const pick = (a, b) => supported ? a : b; window.fetch = pick(window.fetch, poly)"],
    ['a factory given the original in an object', "window.fetch = instrument({ orig: window.fetch, name: 'fetch' })"],
  ])('%s is a wrap', async (_, code) => {
    const report = await scan(code)
    expect(report.findings.map((finding: Finding) => finding.effect)).toEqual(['wrap'])
  })

  test.each([
    ['the shadowed inherited member', 'navigator.sendBeacon = function(){ return Navigator.prototype.sendBeacon.apply(navigator, arguments) }'],
    ['a prototype member read at call time', 'window.addEventListener = function(t, l, o){ return EventTarget.prototype.addEventListener.call(this, t, l, o) }'],
  ])('a call of %s is a wrap', async (_, code) => {
    const report = await scan(code)
    expect(report.findings.map((finding: Finding) => finding.effect)).toEqual(['wrap'])
  })

  test.each([
    ['a choice', 'window.fetch = supported ? wrap(window.fetch) : polyfillFetch'],
    ['an if/else', 'if (supported) window.fetch = wrap(window.fetch); else window.fetch = polyfillFetch'],
    [
      'a choice between a maker and the wrapper it makes, whatever order the alternatives are read in',
      'const mk = function(){ const o = window.fetch; return function(){ return o.apply(this, arguments) } }; window.fetch = cond ? mk : mk()',
    ],
  ])('%s whose alternatives differ in evidence gives one finding per effect', async (_, code) => {
    const report = await scan(code)
    expect(report.findings.map((finding: Finding) => `${finding.target.name}|${finding.effect}`).sort()).toEqual([
      'Window.fetch|replace',
      'Window.fetch|wrap',
    ])
    expect(report.findings.map((finding: Finding) => finding.confidence.mutation.level)).toEqual(['high', 'high'])
  })

  test('an instrumentation class that stores the original on `this` wraps whether or not enable() is called', async () => {
    const report = await scan(
      lines(
        'class I { constructor(){ this.original = window.fetch } enable(){ const self = this; window.fetch = function(){ return self.original.apply(this, arguments) } } }',
        'new I()',
      ),
    )
    expect(found(report)).toEqual(['Window.fetch|wrap|false'])
  })

  test('a define whose value wraps the original is a wrap', async () => {
    const report = await scan("const o = window.fetch; Object.defineProperty(window, 'fetch', { value: function(){ return o.apply(this, arguments) }, configurable: false })")
    expect(found(report)).toEqual(['Window.fetch|wrap|true'])
  })
})

// Effects on the protected surface's true positives (§5 Resolver capabilities 10, §8 Effect and
// mechanism, ADR 0011): the effect follows the written value, so a library's wrapper that calls the original is a
// `wrap` however the library's helpers carry it to the write. Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

const scan = async (code: string) => (await scanBuild(classic(code))).report
/** Each finding as `target|effect`, sorted. */
const found = (report: { findings: Finding[] }): string[] =>
  report.findings.map((finding) => `${finding.target.name}|${finding.effect}`).sort()

/** OpenTelemetry's shimmer `wrap` and its `defineProperty` helper, as esbuild ships them. */
const shimmer = lines(
  'function Ft(e,t,r){let n=!!e[t]&&Object.prototype.propertyIsEnumerable.call(e,t);Object.defineProperty(e,t,{configurable:!0,enumerable:n,writable:!0,value:r})}',
  'var $e=(e,t,r)=>{if(!e||!e[t]){return}if(!r){return}let n=e[t];if(typeof n!="function"||typeof r!="function"){return}let o=r(n,t);return Ft(o,"__original",n),Ft(o,"__unwrap",()=>{e[t]===o&&Ft(e,t,n)}),Ft(o,"__wrapped",!0),Ft(e,t,o),o};',
)

describe('OpenTelemetry shimmer wrappers', () => {
  test('a wrapper factory passed to the shimmer helper from an instrumentation method is a wrap', async () => {
    const report = await scan(
      lines(
        shimmer,
        'class Base { _wrap=$e }',
        'class Fetch extends Base {',
        '  _patchConstructor(){ return t => { let r=this; return function(...o){ return t.apply(this,o) } } }',
        '  enable(){ this._wrap(globalThis,"fetch",this._patchConstructor()) }',
        '}',
        'new Fetch()',
      ),
    )
    expect(found(report)).toEqual(['Window.fetch|wrap'])
  })

  test.each([
    ['a resolved factory', 'mk=t=>function(){return t.apply(this,arguments)}'],
    ['an unresolved factory', 'mk=window.makeWrapper'],
  ])('%s whose result a define helper writes is a wrap', async (_, factory) => {
    const report = await scan(lines(shimmer, `var ${factory};`, '$e(globalThis,"fetch",mk)'))
    expect(found(report)).toEqual(['Window.fetch|wrap'])
  })

  test.each([
    ['inline in the call, as Rollup ships it', 'var a=function(r){return function(){return r.f.apply(this,arguments)}}(i={n:e,f:t});'],
    ['through a variable, as esbuild ships it', 'i={n:e,f:t};var a=mk(i);'],
    ['inline in an unresolved factory call', 'var a=window.makeHook(i={n:e,f:t});'],
    ['through a variable to an unresolved factory', 'i={n:e,f:t};var a=window.makeHook(i);'],
  ])('a factory given an object holding the original is a wrap, %s', async (_, made) => {
    // Application Insights' `_createInstrumentHook`: the hook is made from `{ i, n, f: original, h }`.
    const report = await scan(
      lines(
        'function mk(r){return function(){return r.f.apply(this,arguments)}}',
        `function hook(r,e,t){var i=t&&t.__hook;if(!i){${made}r[e]=a}}`,
        'function inst(r,e){var o=r[e];if(typeof o==="function")hook(r,e,o)}',
        'inst(XMLHttpRequest.prototype,"open")',
      ),
    )
    expect(found(report)).toEqual(['XMLHttpRequest.prototype.open|wrap'])
  })

  test('a helper that writes each value of a source object keeps each value its own effect', async () => {
    // core-js's export helper: `for (key in source) defineBuiltIn(target, key, source[key])`.
    const report = await scan(
      lines(
        'function def(o,k,v){ o[k]=v }',
        'function exp(target, source){ for (var f in source){ var h; if ((h = source[f]) !== undefined) def(target, f, h) } }',
        'var nf = window.fetch',
        'exp(window, { fetch: function(i){ return nf.apply(this, arguments) }, Request: function(){} })',
      ),
    )
    expect(found(report)).toEqual(['Window.Request|replace', 'Window.fetch|wrap'])
  })
})

/** Datadog's `instrumentConstructor` and its `wa` install helper, whose `stop()` writes the saved original back. */
const datadog = lines(
  'function wa(t,e,r,o){return ud(t,e)?{stop:noop}:(t[e]=o,{stop:()=>{t[e]===o&&(t[e]=r)}})}',
  'function ud(t,e){let r=Object.getOwnPropertyDescriptor(t,e);return!!r&&!r.writable&&!r.set}',
  'function noop(){}',
)

describe('restores of a saved constructor', () => {
  test('a stop() that writes back the constructor its install read is a proven restore, not a replace', async () => {
    const report = await scan(
      lines(
        datadog,
        'function ic(t,e){let n=t[e];if(typeof n!="function")return;let s=function(){return Reflect.construct(n,arguments)};return wa(t,e,n,s)}',
        'ic(globalThis,"WebSocket")',
      ),
    )
    expect(found(report)).toEqual(['Window.WebSocket|wrap'])
    const steps = report.findings[0].occurrences.flatMap((occurrence: Finding) => occurrence.trace)
    expect(steps.map((step: Finding) => step.kind)).toContain('restore')
  })

  test('a constructor saved from its prototype and written back there is a proven restore', async () => {
    const report = await scan(
      lines(
        'var n=window.WebSocket; var s=function(){return Reflect.construct(n,arguments)}',
        'var c=n.prototype.constructor; n.prototype.constructor=s',
        'window.__stop=function(){n.prototype.constructor=c}',
      ),
    )
    expect(found(report)).toEqual(['WebSocket.prototype.constructor|wrap'])
  })

  test('a constructor the catalog knows is the same, read from another slot, is no restore (§3)', async () => {
    const report = await scan(lines('window.URL=function(){}', 'window.__stop=function(){window.URL=window.webkitURL}'))
    expect(found(report)).toEqual(['Window.URL|replace'])
    expect(report.findings[0].occurrences).toHaveLength(2)
  })
})

/** zone.js's `patchMethod`, as esbuild ships it: the new value calls what the patch function makes from the original. */
const patchMethod =
  'function de(t,e,a){let n=t;for(;n&&!Object.hasOwn(n,e);)n=Object.getPrototypeOf(n);!n&&t[e]&&(n=t);let c="__zone_symbol__"+e,h=null;if(n&&(!(h=n[c])||!Object.hasOwn(n,c))){h=n[c]=n[e];let _=a(h,c,e);n[e]=function(){return _(this,arguments)}}return h}'

describe('zone.js patchMethod wrappers', () => {
  test('a patch function whose result calls the delegate it is given is a wrap (§5 capabilities 3 and 10)', async () => {
    const report = await scan(lines(patchMethod, 'function ge(u){return function(l,s){return u.apply(l,s)}}', 'de(window,"fetch",l=>ge(l))'))
    expect(found(report)).toContain('Window.fetch|wrap')
    expect(found(report)).not.toContain('Window.fetch|replace')
  })

  test('a patch function whose result calls the original patchMethod returned is a wrap', async () => {
    const report = await scan(lines(patchMethod, 'let F=de(XMLHttpRequest.prototype,"open",()=>function(R,M){return F.apply(R,M)})'))
    expect(found(report)).toContain('XMLHttpRequest.prototype.open|wrap')
    expect(found(report)).not.toContain('XMLHttpRequest.prototype.open|replace')
  })

  test('a patch function whose result never calls the original is a replace, whatever the original is saved on (§8)', async () => {
    // zone.js's `queueMicrotask` patch schedules a Zone microtask instead.
    const report = await scan(lines(patchMethod, 'de(window,"queueMicrotask",a=>function(n,c){Zone.current.scheduleMicroTask("queueMicrotask",c[0])})'))
    expect(found(report)).toContain('Window.queueMicrotask|replace')
    expect(found(report)).not.toContain('Window.queueMicrotask|wrap')
  })

  test('a native function passed down a call chain past the depth cap keeps its frames (Principle 5)', async () => {
    const report = await scan(
      lines(
        'function w(o){return function(){return o.apply(this,arguments)}}',
        'function f1(o){return w(o)} function f2(o){return f1(o)} function f3(o){return f2(o)}',
        'function f4(o){return f3(o)} function f5(o){return f4(o)} function f6(o){return f5(o)}',
        'function f7(o){return f6(o)} function f8(o){return f7(o)}',
        'function install(t,e,a){let h=t[e];let _=a(h);t[e]=function(){return _(this,arguments)}}',
        'install(window,"fetch",l=>f8(l))',
      ),
    )
    expect(found(report)).toEqual(['Window.fetch|wrap'])
  })
})

describe('core-js defineBuiltIn deletes', () => {
  /** core-js's `defineBuiltIn` (`internals/define-built-in.js`), with its `definePropertyModule.f` call. */
  const defineBuiltIn = lines(
    'function def(t,e,d){ Object.defineProperty(t,e,d) }',
    'function dbi(t,e,a,c){ c||(c={}); var u=c.enumerable; try{ c.unsafe ? t[e]&&(u=!0) : delete t[e] }catch(x){}',
    '  u ? t[e]=a : def(t,e,{value:a,enumerable:!1,configurable:!0,writable:!0}); return t }',
  )

  test('a delete always rewritten is no finding, though one instantiation writes back what the slot holds', async () => {
    // `es.promise.constructor`: `defineBuiltIn(NativePromisePrototype, 'then', getBuiltIn('Promise').prototype.then)`,
    // a write-back against the unmutated catalog, beside the usual installs through the same helper.
    const report = await scan(
      lines(defineBuiltIn, 'dbi(Array.prototype,"at",function(){})', 'dbi(Promise.prototype,"then",Promise.prototype.then)'),
    )
    expect(found(report)).toEqual(['Array.prototype.at|replace'])
  })
})

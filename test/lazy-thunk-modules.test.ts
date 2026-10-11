// esbuild, Rolldown and webpack `.cw` lazy-thunk modules (§6 Lazy module thunk, §18 context policy). Every module's
// thunk is the same function node, so a thunk call has to run in one frame per module: nested requires are no
// recursion, and many modules are no context-cap merge. A thunk module's `exports` is what its factory assigns to `module.exports`, through its
// module link, not through the heap field of the one `{ exports: {} }` literal all modules share.

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

// The thunk makers, as the corpus's pinned bundlers emit them. The tests below make modules with `c(factory)`, whose
// factory takes `(exports, module)`.
const makers: Record<string, string> = {
  esbuild: 'var c=(r,t)=>()=>{try{return t||r((t={exports:{}}).exports,t),t.exports}catch(o){throw t=0,o}};',
  'esbuild (old form)': 'var c=(r,t)=>()=>(t||r((t={exports:{}}).exports,t),t.exports);',
  rolldown: 'var c=(e,t)=>()=>(t||(e((t={exports:{}}).exports,t),e=null),t.exports);',
  // webpack 5's `.cw`, set on its require function beside a factory table, whose factories take `(module, exports)`
  // and are called with `exports` as `this`. The module object is the maker's own variable, not a parameter.
  'webpack .cw':
    'var T={1(t){t.exports=0}};const E={};function R(n){const o=E[n];if(void 0!==o)return o.exports;const i=E[n]={exports:{}};' +
    'return T[n](i,i.exports,R),i.exports}' +
    'R.cw=t=>{var e;return()=>{if(t){var r=t;t=0,e={exports:{}},r.call(e.exports,e,e.exports)}return e.exports}};',
  // The same with no table: `R` is a plain object.
  'webpack .cw (no table)': 'const R={};R.cw=t=>{var e;return()=>{if(t){var r=t;t=0,e={exports:{}},r.call(e.exports,e,e.exports)}return e.exports}};',
  // The same maker set in the object's literal.
  'webpack .cw (in a literal)': 'const R={cw:t=>{var e;return()=>{if(t){var r=t;t=0,e={exports:{}},r.call(e.exports,e,e.exports)}return e.exports}}};',
}

/** The code with its modules made by the maker: webpack's `R.cw(factory)` takes its factory's parameters the other way. */
const made = (code: string): string =>
  /\bR(\.cw=|=\{cw:)/.test(code) ? code.replace(/\bc\(\((\w+),(\w+)\)=>/g, 'R.cw(($2,$1)=>').replace(/\bc\(\(\)=>/g, 'R.cw(()=>') : code

const scan = async (code: string) =>
  (await scanBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': `(()=>{${made(code)}})();` })).report
const fingerprints = (report: Json): string[] => report.findings.map((each: Json) => each.fingerprint)
const moduleLinks = (report: Json, name: string): Json[] =>
  report.findings
    .find((each: Json) => each.target.name === name)
    .occurrences.flatMap((occurrence: Json) => occurrence.trace.filter((step: Json) => step.kind === 'module-link'))

describe.each(Object.entries(makers))('lazy-thunk modules (%s)', (_, maker) => {
  test('a module that requires another runs in its own frame: a nested require is no recursion', async () => {
    const report = await scan(`${maker}var a=c((B,s)=>{s.exports=window});var b=c((B,s)=>{s.exports=a()});b().fetch=function(){};`)

    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(moduleLinks(report, 'Window.fetch')).toEqual(
      expect.arrayContaining([expect.objectContaining({ idiom: 'lazy-thunk', module: 'a' }), expect.objectContaining({ idiom: 'lazy-thunk', module: 'b' })]),
    )
    expect(report.completeness.counters.statistics.caps).toEqual({})
  })

  test('each of more modules than the context cap runs in its own frame, and exports what its own factory assigns', async () => {
    // 80 modules, past the 64-context cap: one exports the global object, the others a fresh object each, and every
    // module is required from the one before it.
    const plain = Array.from({ length: 80 }, (_, i) => `var m${i}=c((B,s)=>{${i > 0 ? `m${i - 1}();` : ''}s.exports={n:${i}}});`).join('')
    const report = await scan(
      `${maker}var g=c((B,s)=>{s.exports=window});${plain}var z=c((B,s)=>{m79();s.exports=g()});m40().open=function(){};z().fetch=function(){};`,
    )

    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(report.completeness.counters.statistics.caps).toEqual({})
  })

  test("a module's exports are what its factory assigns to `module.exports`, not the object the thunk made first", async () => {
    const report = await scan(`${maker}var k=c((B,s)=>{s.exports="fetch"});window[k()]=function(){};`)

    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(moduleLinks(report, 'Window.fetch')).toEqual([expect.objectContaining({ idiom: 'lazy-thunk', module: 'k' })])
  })

  test("a module's exports are its factory's own: another module's assignment never reaches them", async () => {
    const report = await scan(`${maker}var w=c((B,s)=>{s.exports=window});var k=c((B,s)=>{s.exports="fetch"});var o=c((B,s)=>{s.exports={}});w();window[k()]=function(){};o().open=1;`)

    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
  })

  test('a factory that writes `exports` fields keeps the object the thunk made, with those fields', async () => {
    const report = await scan(`${maker}var k=c((B,s)=>{B.key="fetch";s.exports.other="open"});window[k().key]=function(){};window[k().other]=1;`)

    expect(fingerprints(report).sort()).toEqual(['window|Window.fetch|replace|unknown', 'window|Window.open|replace|unknown'])
  })

  test('a native writer a module exports is followed where another module requires and calls it', async () => {
    // core-js's es.promise.constructor: `setPrototypeOf` is object-set-prototype-of's `Object.setPrototypeOf || shim`,
    // called guarded on the native Promise.prototype.
    const report = await scan(
      `${maker}var S=c((q,m)=>{m.exports=Object.setPrototypeOf||("__proto__"in{}?function(o,p){return o.__proto__=p,o}:void 0)});` +
        `var N=c((q,m)=>{m.exports=window.Promise});` +
        `var P=c(()=>{var sp=S(),Ot=N(),Mr=Ot&&Ot.prototype,Er=function(){};try{delete Mr.constructor}catch(e){}sp&&sp(Mr,Er.prototype)});P();`,
    )

    expect(fingerprints(report).sort()).toEqual([
      'window|Promise.prototype.[[Prototype]]|prototype-change|unknown',
      'window|Promise.prototype.constructor|delete|unknown',
    ])
    expect(moduleLinks(report, 'Promise.prototype.[[Prototype]]')).toEqual(
      expect.arrayContaining([expect.objectContaining({ module: 'S' })]),
    )
  })

  test("a module's factory runs from its module link, not after a round of the dynamic-call index per require", async () => {
    // core-js's shape: a module calls an export helper from another module, which defines each key of its source
    // through a third module's helper (`$export` → `defineBuiltIn`).
    const report = await scan(
      `${maker}var D=c((q,m)=>{m.exports=function(r,e,t){r[e]=t}});` +
        `var X=c((q,m)=>{var d=D();m.exports=function(o,s){for(var k in s)d(window,k,s[k])}});` +
        `var Y=c(()=>{var x=X();x({},{fetch:function(){}})});var Z=c(()=>{var x=X();x({},{open:function(){}})});Y();Z();`,
    )

    expect(fingerprints(report).sort()).toEqual(['window|Window.fetch|replace|unknown', 'window|Window.open|replace|unknown'])
    expect(report.completeness.counters.statistics.caps).toEqual({})
  })
})

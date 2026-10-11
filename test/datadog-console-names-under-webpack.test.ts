// Datadog's console instrumentation under webpack: `initConsoleObservable(Object.values(ConsoleApiName))`
// gives each console member its own Observable, whose callback wraps `globalConsole[api]`. Two things kept the api
// from reaching that callback under webpack's factory table:
// - `Object.keys`, `Object.values` and `Object.entries` of an object literal the heap carries (§5 Resolver capabilities
//   4 and 5): a literal a module exports reaches its importer through the heap, and is iterated as the same literal
//   seen directly is.
// - A require function runs each module it links in one frame (§6), which the context cap never merges, as a lazy
//   module thunk's.
// Iterating a literal the heap carries refuses one its code writes (§5 Resolver capabilities 4) by the syntactic test
// first, so a loop whose own writes need the iteration leaves nothing provisional to redo.
// A closure made in a call's arguments that reads a variable of the function around the call keeps that function's
// frame (§5 Resolver capabilities 3), also where the call's callee is a value (`new r.cP(e => …)`), so the
// Observable's caller-less methods call it with its api bound.
// Every scenario goes through `monkeypatchlist scan --json`.

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })

/** webpack 5's runtime pieces, as it emits them minified: the require function, `n.d` and `n.o`. */
const require5 =
  'const e={};function n(r){const o=e[r];if(void 0!==o)return o.exports;const i=e[r]={exports:{}};return t[r](i,i.exports,n),i.exports}'
const define5 =
  'n.d=(t,e)=>{if(Array.isArray(e))for(var r=0;r<e.length;){var o=e[r++],i=e[r++],s=0===i?{enumerable:!0,value:e[r++]}:' +
  '{enumerable:!0,get:i};n.o(t,o)||Object.defineProperty(t,o,s)}else for(var o in e)n.o(e,o)&&!n.o(t,o)&&' +
  'Object.defineProperty(t,o,{enumerable:!0,get:e[o]})},n.o=(t,e)=>Object.prototype.hasOwnProperty.call(t,e);'

/** A webpack 5 bundle: an object factory table keyed by module id, the runtime, and the entry code. */
function webpack5(modules: Record<string, string>, entry: string): string {
  const table = Object.entries(modules).map(([id, body]) => `${id}(t,e,n){${body}}`).join(',')
  return `(()=>{"use strict";var t={${table}};${require5}${define5}${entry}})();`
}

const names = (report: Json): string[] => report.findings.map((finding: Json) => finding.target.name).sort()

// Datadog's console module: the console, and `ConsoleApiName`, exported as values (`n.d`'s array form) or by getters.
const consoleModule = {
  value: 'const r=console;n.d(e,["JZ",0,r,"bP",0,{log:"log",warn:"warn"}])',
  getter: 'const r=console,b={log:"log",warn:"warn"};n.d(e,{JZ:()=>r,bP:()=>b})',
}

describe.each(resolvers)('Datadog console names under webpack, with %s', (_, resolver) => {
  const scan = async (code: string) => (await scanBuild(classic(code), [], { deps: { resolver } })).report

  test.each(Object.entries(consoleModule))('Object.values of a literal a module exports (%s) names each member', async (_, module) => {
    const report = await scan(
      webpack5(
        { '1294': module },
        'var w=n(1294);Object.values(w.bP).forEach(k=>{const q=w.JZ[k];w.JZ[k]=(...a)=>q.apply(console,a)})',
      ),
    )

    expect(names(report)).toEqual(['console.log', 'console.warn'])
  })

  test('Datadog\'s console observable under webpack: each callback is judged with the api its creation bound', async () => {
    // `initConsoleObservable(Object.values(ConsoleApiName))` and `createConsoleObservable(api)`, both inlined as IIFEs.
    const observable =
      'n.d(e,{cP:()=>r});class r{constructor(t){this.onFirstSubscribe=t,this.observers=[]}subscribe(t){this.addObserver(t)}' +
      'addObserver(t){this.observers.push(t),1===this.observers.length&&this.onFirstSubscribe&&(this.onLastUnsubscribe=this.onFirstSubscribe(this)||void 0)}}'
    const report = await scan(
      webpack5(
        { '1294': consoleModule.value, '7': observable },
        'var r=n(7),w=n(1294);let S={};function k(){const e=[];function n(n,r){r.forEach(o=>e.push(o.subscribe(t=>t)))}' +
          'return n(3,function(t){return t.map(t=>(S[t]||(S[t]=function(t){' +
          'return new r.cP(e=>{const n=w.JZ[t];return w.JZ[t]=(...r)=>{n.apply(console,r)},()=>{w.JZ[t]=n}})}(t)),S[t]))' +
          '}(Object.values(w.bP))),e}',
      ),
    )

    // The callback keeps the frame of `createConsoleObservable` that made it (§5 Resolver capabilities 3), so
    // the Observable's caller-less methods, judged with `this` = an instance, call it with its api bound: no `console.*`.
    expect(names(report)).toEqual(['console.log', 'console.warn'])
    const log = report.findings.find((finding: Json) => finding.target.name === 'console.log')
    expect(log.occurrences[0].trace.map((step: Json) => step.kind)).toContain('creation-site')
  })

  test('a module required past the context cap still exports its literal: each module has one require frame', async () => {
    // More linked modules than the context cap (64) allows frames of one function: Datadog's webpack build has 139.
    const fillers = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`${100 + i}`, `n.d(e,["a",0,${i}])`]))
    const requires = Object.keys(fillers).map((id) => `n(${id});`).join('')
    const report = await scan(
      webpack5(
        { ...fillers, '1294': consoleModule.value },
        `${requires}var w=n(1294);Object.values(w.bP).forEach(k=>{const q=w.JZ[k];w.JZ[k]=(...a)=>q.apply(console,a)})`,
      ),
    )

    expect(names(report)).toEqual(['console.log', 'console.warn'])
  })

  test('a literal its own code writes, iterated by a loop whose writes need the iteration, is refused at once', async () => {
    // New Relic's rrweb recorder: `const l={}`, written per CSS rule class, then `Object.entries(l).forEach(([k,n])=>
    // {n.prototype.insertRule=…})`. Finding whether the code writes `l` evaluates that loop's own write, which iterates
    // `l` again. The syntactic test refuses `l` there, so nothing in the loop is left provisional and redone: the scan
    // takes as many steps wherever an unrelated write of the same key stands.
    const recorder =
      'function rec(s){const l={};"CSSGroupingRule" in s?l.CSSGroupingRule=s.CSSGroupingRule:("CSSMediaRule" in s&&' +
      '(l.CSSMediaRule=s.CSSMediaRule));const c={};Object.entries(l).forEach(([k,n])=>{c[k]=n.prototype.insertRule,' +
      'n.prototype.insertRule=function(){return c[k].apply(this,arguments)}})}\nrec(window)'
    const other = 'var X={};X.insertRule=1;'
    const before = await scan(`${other}\n${recorder}`)
    const after = await scan(`${recorder}\n${other}`)

    expect(names(before)).toEqual([])
    expect(before.completeness.counters.statistics.steps).toBe(after.completeness.counters.statistics.steps)
  })
})

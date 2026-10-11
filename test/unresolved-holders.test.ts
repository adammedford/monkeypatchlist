// Unresolved holders (§5 Partially resolved writes, §13): a patch-shaped write whose member names a catalog member it
// could mutate, but whose holder doesn't resolve, is an `unresolved-holder` coverage limitation listing the candidate
// targets, never a finding. Every scenario goes through `monkeypatchlist scan --json`, with both binding resolvers behind the
// seam.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** The target names of the report's findings. */
const found = (report: Report): string[] => report.findings.map((finding: Report) => finding.target.name)

/** The report's `unresolved-holder` records, as their line and detail. */
const holders = (report: Report): [number, string][] =>
  report.completeness.limitations
    .filter((record: Report) => record.kind === 'unresolved-holder')
    .map((record: Report) => [record.location.line, record.detail])

describe.each(resolvers)('unresolved holders, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  test('api.o[n] = wrap(api.o[n]) with n = "fetch" gives unresolved-holder listing Window.fetch, and no finding', async () => {
    const { report } = await scan(classic("var n = 'fetch'\napi.o[n] = wrap(api.o[n])"))

    expect(found(report)).toEqual([])
    const records = holders(report)
    expect(records).toHaveLength(1)
    expect(records[0]![0]).toBe(2)
    expect(records[0]![1]).toContain('Window.fetch')
    expect(report.completeness.counters.blindSpots.unresolvedHolder).toBe(1)
    expect(report.completeness.level).toBe('complete-with-limitations')
  })

  test('a write that is not patch-shaped gives nothing: x.fetch = 1, x.fetch = w, x.fetch = String(x.fetch)', async () => {
    // A test that isn't one of presence (`!== 0`) doesn't keep the original either.
    // Nor does a presence test that lets the write run when the original is present (`if (z.fetch) z.fetch = w`), or a
    // bulk field that writes the read back.
    const code = [
      'x.fetch = 1',
      'x.fetch = w',
      'x.fetch = String(x.fetch)',
      'x.fetch = x.fetch',
      'if (y.fetch !== 0) y.fetch = w',
      'if (z.fetch) z.fetch = w',
      'z.fetch && (z.fetch = w)',
      "if (typeof z.fetch === 'function') z.fetch = w",
      'if (!z.fetch || force) z.fetch = w',
      'Object.assign(v, { fetch: v.fetch })',
      "Reflect.set(rs, 'fetch', w)",
      "Reflect.set(rt, 'fetch', rt.fetch)",
    ]
    const { report } = await scan(classic(code.join('\n')))

    expect(found(report)).toEqual([])
    expect(holders(report)).toEqual([])
    expect(report.completeness.counters.blindSpots.unresolvedHolder).toBe(0)
    expect(report.completeness.level).toBe('complete')
  })

  test('a site where neither holder nor member resolves gives nothing', async () => {
    const { report } = await scan(classic('x[k] = wrap(x[k])'))

    expect(holders(report)).toEqual([])
  })

  test('a member no catalog target could be mutated through gives nothing', async () => {
    // `title` is API use on every holder that has it, and `zzNotAMember` names no target.
    const { report } = await scan(classic('x.title = wrap(x.title)\nx.zzNotAMember = wrap(x.zzNotAMember)'))

    expect(holders(report)).toEqual([])
  })

  test('each way of keeping the original makes the site patch-shaped', async () => {
    const code = [
      'var a = x.fetch; x.fetch = w', // stored
      'y.fetch = y.fetch || p', // kept when present
      'if (typeof z.fetch == "undefined") z.fetch = p', // tested for presence before the write
      'q.fetch = q.fetch.bind(q)', // bound
      'r.fetch ||= p', // logical assignment
      'function f(){ var o = s.fetch; s.fetch = function(){ return o.apply(this, arguments) } }',
      't.fetch || (t.fetch = p)', // kept when present, as a guard
      'if (u.fetch) {} else u.fetch = p', // absent in the else arm
      "Reflect.set(v, 'fetch', wrap(v.fetch))", // Reflect.set is an assign (§3)
    ]
    const { report } = await scan(classic(code.join('\n')))

    expect(found(report)).toEqual([])
    expect(holders(report).map(([line]) => line)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('a read of the same slot in another function, or before the root is redefined, does not count', async () => {
    const code = [
      'function f(){ return x.fetch }',
      'x.fetch = function(){ return x.fetch.apply(this, arguments) }',
      'var o = a.fetch; a = b; a.fetch = w',
    ]
    const { report } = await scan(classic(code.join('\n')))

    expect(holders(report)).toEqual([])
  })

  test('a patch-shaped write through an alias carried from one classic script to another gives unresolved-holder', async () => {
    const files = {
      'index.html': '<script src="a.js"></script><script src="b.js"></script>',
      'a.js': 'var g = window',
      'b.js': 'g.fetch = wrap(g.fetch)',
    }
    const { report } = await scan(files)

    expect(found(report)).toEqual([])
    expect(holders(report).map(([line]) => line)).toEqual([1])

    const plain = await scan({ ...files, 'b.js': 'g.fetch = w' })
    expect(found(plain.report)).toEqual([])
    expect(holders(plain.report)).toEqual([])
  })

  test('a define with get or set, or after a descriptor read of the same slot, and a delete after a capture', async () => {
    const code = [
      "Object.defineProperty(o, 'fetch', { get: function(){ return w } })",
      "var d = Object.getOwnPropertyDescriptor(p, 'fetch'); Object.defineProperty(p, 'fetch', { value: w })",
      "var saved = q.fetch; delete q.fetch",
      "delete r.fetch",
      "Object.defineProperty(s, 'fetch', { value: w })",
    ]
    const { report } = await scan(classic(code.join('\n')))

    expect(found(report)).toEqual([])
    expect(holders(report).map(([line]) => line)).toEqual([1, 2, 3])
  })

  test('holders with several values raise unresolved-holder only when no alternative gives a finding', async () => {
    const code = [
      'var o = window.NREUM || {}; o.fetch = wrap(o.fetch);',
      '(c ? history : api).fetch = wrap((c ? history : api).fetch);',
      'function p(o){ o.fetch = wrap(o.fetch) } p(window); p(api);',
    ]
    const { report } = await scan(classic(code.join('\n')))

    expect(found(report)).toEqual(['Window.fetch'])
    expect(holders(report).map(([line]) => line)).toEqual([1, 2])
  })

  test('a set-prototype site, and a __proto__ assign, on an unknown object give no record', async () => {
    const babel = [
      'function _setPrototypeOf(o, p) { _setPrototypeOf = Object.setPrototypeOf || function (o, p) { o.__proto__ = p; return o }; return _setPrototypeOf(o, p) }',
      'function _inherits(subClass, superClass) { subClass.prototype = Object.create(superClass && superClass.prototype, { constructor: { value: subClass, writable: true, configurable: true } }); Object.defineProperty(subClass, "prototype", { writable: false }); if (superClass) _setPrototypeOf(subClass, superClass) }',
    ]
    const code = ['Object.setPrototypeOf(x, mk(Object.getPrototypeOf(x)))', 'x.__proto__ = mk(x.__proto__)', ...babel]
    const { report } = await scan(classic(code.join('\n')))

    expect(found(report)).toEqual([])
    expect(holders(report)).toEqual([])
  })

  test('this in a caller-less function or a host callback gives unresolved-holder for a wrap, and nothing for a plain write', async () => {
    const code = [
      'function install(){ this.fetch = wrap(this.fetch) }',
      'setTimeout(function(){ this.fetch = w }, 0)',
    ]
    const { report } = await scan(classic(code.join('\n')))

    expect(found(report)).toEqual([])
    expect(holders(report).map(([line]) => line)).toEqual([1])
  })

  test('the bulk mechanisms and __defineGetter__ follow the same rule, property by property', async () => {
    const code = [
      'Object.assign(o, { fetch: wrap(o.fetch), close: 1 })',
      'Object.defineProperties(p, { fetch: { get: function(){ return w } }, close: { value: 1 } })',
      "q.__defineGetter__('fetch', function(){ return w })",
    ]
    const { report } = await scan(classic(code.join('\n')))

    expect(found(report)).toEqual([])
    expect(holders(report).map(([line]) => line)).toEqual([1, 2, 3])
  })
})

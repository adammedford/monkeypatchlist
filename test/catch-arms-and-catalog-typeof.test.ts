// A member sweep's `typeof` decided from the catalog kind, and writes in a `catch` arm whose `try` can't throw (§5
// Resolver capabilities 9). rrweb's canvas observers are the motivating case: they
// sweep `WebGLRenderingContext.prototype`, skip what isn't a function, wrap each operation in a `try`, and redefine the
// member as a setter in its `catch`. Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { scanBuild } from './support/fixture-build.ts'

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const scan = (code: string) => scanBuild(classic(code))

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

// The catalog is the independent source of the expected members.
const targets = loadCatalog().targets.window
const own = (holder: string, kind: string) =>
  Object.entries(targets)
    .filter(([name, target]) => name === `${holder}.${target.member}` && target.kind === kind)
    .map(([name]) => name)
    .sort()

const byEffect = (report: { findings: Finding[] }, effect: string): string[] =>
  report.findings
    .filter((finding: Finding) => finding.effect === effect)
    .map((finding: Finding) => finding.target.name)
    .sort()

describe('a typeof of a swept catalog member is decided from its catalog kind', () => {
  test("typeof proto[k] !== 'function' skips the WebGL constants, so they give no finding and no ineffective write", async () => {
    const { report } = await scan(`
      const proto = WebGLRenderingContext.prototype
      for (const k of Object.getOwnPropertyNames(proto)) {
        if (typeof proto[k] !== 'function') continue
        proto[k] = wrap(proto[k])
      }
    `)

    const constants = own('WebGLRenderingContext.prototype', 'constant')
    expect(constants).toContain('WebGLRenderingContext.prototype.ACTIVE_TEXTURE')
    const refused = report.ineffectiveWrites.map((write: Finding) => write.target.name)
    const found = report.findings.map((finding: Finding) => finding.target.name)
    expect(constants.filter((name) => refused.includes(name) || found.includes(name))).toEqual([])
    // The operations pass the filter, unconditionally. An attribute's `typeof` runs its getter, which the catalog
    // doesn't type, so the filter stays undecided for it (the read-only ones are refused writes).
    const operations = own('WebGLRenderingContext.prototype', 'operation')
    expect(byEffect(report, 'wrap')).toEqual(expect.arrayContaining(operations))
    for (const finding of report.findings.filter((each: Finding) => operations.includes(each.target.name))) {
      expect(finding.reachability).toBe('unconditional')
    }
    expect(refused.length).toBeGreaterThan(0)
    expect(own('WebGLRenderingContext.prototype', 'attribute')).toEqual(expect.arrayContaining(refused))
  })

  test('a native holder read from the heap is still that holder for the catalog: its typeof filter decides', async () => {
    const { report } = await scan(`
      function observe(options) {
        const { win } = options
        const proto = win.WebGLRenderingContext.prototype
        for (const k of Object.getOwnPropertyNames(proto)) {
          if (typeof proto[k] !== 'function') continue
          proto[k] = wrap(proto[k])
        }
      }
      observe({ win: window })
    `)

    const constants = own('WebGLRenderingContext.prototype', 'constant')
    const refused = report.ineffectiveWrites.map((write: Finding) => write.target.name)
    expect(constants.filter((name) => refused.includes(name))).toEqual([])
    expect(byEffect(report, 'wrap')).toEqual(expect.arrayContaining(own('WebGLRenderingContext.prototype', 'operation')))
  })

  test("typeof proto[k] === 'number' keeps only the constants", async () => {
    const { report } = await scan(`
      const proto = WebGLRenderingContext.prototype
      Object.getOwnPropertyNames(proto).forEach(k => { if (typeof proto[k] === 'number') Object.defineProperty(proto, k, { value: 0 }) })
    `)

    // Only the attributes, whose type the catalog doesn't fix, stay besides the constants, each conditional.
    const found = report.findings.map((finding: Finding) => finding.target.name).sort()
    expect(found).toEqual(own('WebGLRenderingContext.prototype', 'attribute'))
    for (const finding of report.findings) expect(finding.reachability).toBe('conditional')
    const refused = report.ineffectiveWrites.map((write: Finding) => write.target.name).sort()
    expect(refused).toEqual(own('WebGLRenderingContext.prototype', 'constant'))
  })
})

// rrweb's `patch`, cut down: it catches internally, so a call of it never throws.
const patch = `
  function patch(source, name, replacement) {
    try {
      if (!(name in source)) return () => {}
      const original = source[name]
      const wrapped = replacement(original)
      source[name] = wrapped
      return () => { source[name] = original }
    } catch { return () => {} }
  }`
// rrweb's `hookSetter`, cut down: it redefines a member as a setter.
const hookSetter = `
  function hookSetter(target, key, d) {
    Object.defineProperty(target, key, { set(v) { d.set.call(this, v) }, configurable: true })
  }`

describe('a write in a catch arm counts only when its try block may throw', () => {
  test("rrweb's 2D canvas observer: the catch arm redefines only the accessors, whose read throws", async () => {
    const { report } = await scan(`${patch}${hookSetter}
      const handlers = []
      const names = Object.getOwnPropertyNames(CanvasRenderingContext2D.prototype)
      for (const prop of names) {
        try {
          if (typeof CanvasRenderingContext2D.prototype[prop] !== 'function') continue
          const restore = patch(CanvasRenderingContext2D.prototype, prop, (original) => function (...args) { return original.apply(this, args) })
          handlers.push(restore)
        } catch {
          hookSetter(CanvasRenderingContext2D.prototype, prop, { set(v) {} })
        }
      }
    `)

    const operations = own('CanvasRenderingContext2D.prototype', 'operation')
    expect(operations).toContain('CanvasRenderingContext2D.prototype.drawImage')
    expect(byEffect(report, 'wrap')).toEqual(expect.arrayContaining(operations))
    const redefined = byEffect(report, 'descriptor-change')
    expect(redefined.filter((name) => operations.includes(name))).toEqual([])
    expect(redefined).toContain('CanvasRenderingContext2D.prototype.fillStyle')
  })

  test('a write in the catch arm itself is no finding for a member whose try block cannot throw', async () => {
    const { report } = await scan(`
      const proto = WebGLRenderingContext.prototype
      function wrap(f) { const wrapped = function () {}; return wrapped }
      for (const k of Object.getOwnPropertyNames(proto)) {
        try {
          if (typeof proto[k] !== 'function') continue
          proto[k] = wrap(proto[k])
        } catch {
          Object.defineProperty(proto, k, { set(v) {}, configurable: true })
        }
      }
    `)

    const operations = own('WebGLRenderingContext.prototype', 'operation')
    expect(report.findings.map((finding: Finding) => finding.target.name)).toEqual(expect.arrayContaining(operations))
    expect(byEffect(report, 'descriptor-change').filter((name) => operations.includes(name))).toEqual([])
    expect(byEffect(report, 'descriptor-change')).toContain('WebGLRenderingContext.prototype.drawingBufferWidth')
  })

  test('a try block that calls code the analyzer cannot see may throw, so its catch arm counts', async () => {
    const { report } = await scan(`
      const proto = WebGLRenderingContext.prototype
      for (const k of Object.getOwnPropertyNames(proto)) {
        try {
          if (typeof proto[k] !== 'function') continue
          proto[k] = cfg.wrap(proto[k])
        } catch {
          Object.defineProperty(proto, k, { set(v) {}, configurable: true })
        }
      }
    `)

    expect(byEffect(report, 'descriptor-change')).toContain('WebGLRenderingContext.prototype.drawArrays')
  })

  test('a catch arm outside any sweep follows its try block too', async () => {
    const reached = await scan(`try { JSON.parse(s) } catch { window.fetch = f }`)
    expect(reached.report.findings.map((finding: Finding) => finding.target.name)).toEqual(['Window.fetch'])

    const never = await scan(`try { const a = [] } catch { window.fetch = f }`)
    expect(never.report.findings).toEqual([])
  })

  // Each of these throws in Chromium, so its catch arm runs and its write counts.
  test.each([
    ['assigning a const', 'const n = 1; try { n = 2 } catch { window.fetch = f }'],
    ['assigning a class name', 'class C {} try { C = 1 } catch { window.fetch = f }'],
    ['a define whose getter is no function', "try { Object.defineProperty(window, 'x', { get: 5 }) } catch { window.fetch = f }"],
    ['a define whose descriptor has an accessor field', "try { Object.defineProperty(window, 'x', { get value() { throw 1 } }) } catch { window.fetch = f }"],
    ['a descriptor read whose key is an object', 'try { Object.getOwnPropertyDescriptor(window, o) } catch { window.fetch = f }'],
    ['a destructuring catch parameter', 'try { try { JSON.parse(s) } catch ({ a }) {} } catch { window.fetch = f }'],
    ['setting an array length', 'const a = []; try { a.length = -1 } catch { window.fetch = f }'],
  ])('a try block that may throw keeps its catch arm: %s', async (_, code) => {
    const { report } = await scan(code)
    expect(report.findings.map((finding: Finding) => finding.target.name)).toEqual(['Window.fetch'])
  })
})

// Every write the catch-arm rule drops leaves a counted, traced `prune` (§5 Resolver capabilities 9, §7, §14), so no
// write is dropped silently.
describe('a write the catch-arm rule drops is counted as a prune', () => {
  const pruned = (report: Finding): number => report.completeness.counters.statistics.pruned
  const prunes = (report: Finding, name: string): Finding[] =>
    report.findings
      .find((finding: Finding) => finding.target.name === name)
      .occurrences[0].trace.filter((step: Finding) => step.kind === 'prune')
      .map(({ text, ...fields }: Finding) => {
        expect(typeof text).toBe('string')
        return fields
      })

  test("a catch arm whose try calls a function that can't throw gives no finding and one prune", async () => {
    const { report } = await scan(`
      function setup() { const a = []; a.push(1) }
      try { setup() } catch (e) { window.fetch = fallback }
    `)

    expect(report.findings).toEqual([])
    expect(report.ineffectiveWrites).toEqual([])
    expect(pruned(report)).toBe(1)
  })

  test('a surviving occurrence in the try block traces the prune: the try, its count and the judgement', async () => {
    const { report } = await scan(
      "function setup() { const a = []; a.push(1) }\nfunction g() {}\ntry { setup(); history.go = g } catch (e) { window.fetch = fallback }",
    )

    expect(report.findings.map((finding: Finding) => finding.target.name)).toEqual(['history.go'])
    expect(report.findings[0].reachability).toBe('unconditional')
    expect(pruned(report)).toBe(1)
    expect(prunes(report, 'history.go')).toEqual([
      {
        kind: 'prune',
        count: 1,
        expression: 'try { setup(); history.go = g }',
        generated: { start: 61, end: 130, line: 3, column: 0 },
        judgement: 'try-cannot-throw',
      },
    ])
  })

  test("the sweep's catch arm: each operation's dropped redefine is counted, and the wraps trace it", async () => {
    const { report } = await scan(`
      const proto = WebGLRenderingContext.prototype
      function wrap(f) { const wrapped = function () {}; return wrapped }
      for (const k of Object.getOwnPropertyNames(proto)) {
        try {
          if (typeof proto[k] !== 'function') continue
          proto[k] = wrap(proto[k])
        } catch {
          Object.defineProperty(proto, k, { set(v) {}, configurable: true })
        }
      }
    `)

    const operations = own('WebGLRenderingContext.prototype', 'operation')
    // Every member whose `typeof` is 'function': the operations, and the `constructor`.
    const functions = [...operations, ...own('WebGLRenderingContext.prototype', 'function')]
    expect(functions).toHaveLength(operations.length + 1)
    // Their redefines are dropped, one prune each; the accessors' redefines stay findings.
    expect(byEffect(report, 'descriptor-change').filter((name) => functions.includes(name))).toEqual([])
    expect(byEffect(report, 'descriptor-change')).toContain('WebGLRenderingContext.prototype.drawingBufferWidth')
    expect(pruned(report)).toBe(functions.length)
    expect(prunes(report, 'WebGLRenderingContext.prototype.drawArrays')).toEqual([
      {
        kind: 'prune',
        count: functions.length,
        expression: 'try { …; proto[k] = wrap(proto[k]) }',
        generated: expect.objectContaining({ line: 5 }),
        judgement: 'try-cannot-throw',
      },
    ])
  })

  test('a write the arm drops that would have been ineffective is counted too, and gives no ineffective write', async () => {
    const { report } = await scan(`try {} catch (e) { Math.PI = 3 }`)

    expect(report.ineffectiveWrites).toEqual([])
    expect(pruned(report)).toBe(1)
    // The same write where its catch arm runs is an ineffective write.
    const reached = await scan(`try { JSON.parse(s) } catch (e) { Math.PI = 3 }`)
    expect(reached.report.ineffectiveWrites.map((write: Finding) => write.target.name)).toEqual(['Math.PI'])
  })

  test('a try block that may throw keeps its catch-arm finding, and prunes nothing', async () => {
    const { report } = await scan(`try { JSON.parse(s) } catch (e) { window.fetch = fallback }`)

    expect(report.findings.map((finding: Finding) => finding.target.name)).toEqual(['Window.fetch'])
    expect(pruned(report)).toBe(0)
    expect(report.findings[0].occurrences[0].trace.some((step: Finding) => step.kind === 'prune')).toBe(false)
  })
})

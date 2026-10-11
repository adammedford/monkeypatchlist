// Wildcard targets (§5 Partially resolved writes, §3, §9, §12, ADR 0004): a write whose holder resolves and whose member
// doesn't is a wildcard target `<holder>.*` when the same unresolved key is reused. Its effect follows the value
// written, and its outcome is evaluated over the catalog members it matches. Every scenario goes through
// `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

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

/** The report's findings, as `target|effect`. */
const found = (report: Report): string[] =>
  report.findings.map((finding: Report) => `${finding.target.name}|${finding.effect}`)

/** The report's ineffective-write records, as `target|reason`. */
const records = (report: Report): string[] =>
  report.ineffectiveWrites.map((record: Report) => `${record.target.name}|${record.reason}`)

describe.each(resolvers)('wildcard targets, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>, args: string[] = []) => scanBuild(files, args, { deps: { resolver } })

  test('a reused unknown key on a known holder gives a wildcard: console[k] = wrap(console[k]) is console.* wrap', async () => {
    const { report } = await scan(classic('cfg.levels.forEach(function(k){ console[k] = wrap(console[k]) })'))

    expect(found(report)).toEqual(['console.*|wrap'])
    const [finding] = report.findings
    expect(finding.target).toEqual({ realm: 'window', holder: 'namespace', name: 'console.*' })
    expect(finding.fingerprint).toMatch(/^window\|console\.\*\|wrap\|/)
    // Wildcards claim only what is known, so they don't lower target confidence (§9).
    expect(finding.confidence.target.level).toBe('high')
    // `console.@@toStringTag` is non-writable, so the members `console.*` matches are partly ineffective (§3).
    expect(finding.confidence.mutation.reasons).toEqual(['wildcard-outcome-mixed'])
    expect(finding.occurrences[0].trace.map((step: Report) => step.kind)).toContain('confidence-reason')
  })

  test('a key that is not reused gives nothing: JSONP window[cb] = fn, and console[k] = noop', async () => {
    const code = ['window[cb] = function(data){ handle(data) }', 'console[k] = function(){}', 'delete console[j]']
    const { report } = await scan(classic(code.join('\n')))

    expect(found(report)).toEqual([])
    expect(records(report)).toEqual([])
  })

  test('no wildcard lands on the global object, whatever the key reuse', async () => {
    const code = [
      // jQuery's JSONP.
      'var overwritten = window[callbackName]; window[callbackName] = function(){ responseContainer = arguments }',
      'overwritten(responseContainer[0])',
      // The dataLayer and a chunk global.
      'w[l] = w[l] || []',
      'self[chunkName] = self[chunkName] || []',
      // A real unknown-key wrap of a global function.
      'var o = window[k]; window[k] = function(){ return o.apply(this, arguments) }',
      'if (!(n in window)) window[n] = shim',
    ]
    const { report } = await scan(classic(['var w = window', ...code].join('\n')))

    expect(found(report)).toEqual([])
    expect(records(report)).toEqual([])
  })

  test('the effect follows the value written, as for a named member', async () => {
    const cases: [string, string[]][] = [
      // Wrap evidence: a captured original that the new value calls.
      [
        'var o = XMLHttpRequest.prototype[k]; XMLHttpRequest.prototype[k] = function(){ return o.apply(this, arguments) }',
        ['XMLHttpRequest.prototype.*|wrap'],
      ],
      // Read but not called: any other value is a replace.
      ['var saved = XMLHttpRequest.prototype[k]; XMLHttpRequest.prototype[k] = function(){}', ['XMLHttpRequest.prototype.*|replace']],
      // A value that equals the read when present is an add.
      ['console[k] = console[k] || noop', ['console.*|add']],
      ['if (!Array.prototype[k]) Array.prototype[k] = impl[k]', ['Array.prototype.*|add']],
      ['if (!(k in Array.prototype)) Array.prototype[k] = impl[k]', ['Array.prototype.*|add']],
      ['Array.prototype[k] ||= impl[k]', ['Array.prototype.*|add']],
      // A define that gives get or set, or no value, after the descriptor is fetched, is a descriptor-change.
      [
        'var d = Object.getOwnPropertyDescriptor(Element.prototype, k); Object.defineProperty(Element.prototype, k, { get: function(){ return 1 } })',
        ['Element.prototype.*|descriptor-change'],
      ],
      [
        'var d = Object.getOwnPropertyDescriptor(Element.prototype, k); Object.defineProperty(Element.prototype, k, { enumerable: false })',
        ['Element.prototype.*|descriptor-change'],
      ],
      // A define whose value calls the fetched descriptor's value is a wrap.
      [
        'const d = Object.getOwnPropertyDescriptor(Element.prototype, k); Object.defineProperty(Element.prototype, k, { ...d, value: function(){ return d.value.apply(this, arguments) } })',
        ['Element.prototype.*|wrap'],
      ],
      // Read, then deleted.
      ['var gone = Element.prototype[k]; delete Element.prototype[k]', ['Element.prototype.*|delete']],
      ['var gone = Element.prototype[k]; Reflect.deleteProperty(Element.prototype, k)', ['Element.prototype.*|delete']],
      // Reflect.set is an assign (§3).
      ['Reflect.set(Element.prototype, k, wrap(Element.prototype[k]))', ['Element.prototype.*|wrap']],
      // The bulk mechanisms and the accessor definers are assign and define sites too (§3, §5).
      ['Object.assign(Element.prototype, { [k]: wrap(Element.prototype[k]) })', ['Element.prototype.*|wrap']],
      ['Object.assign(Element.prototype, { [k]: noop })', []],
      [
        'var d = Object.getOwnPropertyDescriptor(Element.prototype, k); Object.defineProperties(Element.prototype, { [k]: { get: g } })',
        ['Element.prototype.*|descriptor-change'],
      ],
      ['Object.defineProperties(Element.prototype, { [k]: { get: g } })', []],
      ['var o = Element.prototype[k]; Element.prototype.__defineGetter__(k, function(){ return o })', ['Element.prototype.*|descriptor-change']],
      ['Element.prototype.__defineSetter__(k, function(){})', []],
    ]
    for (const [code, expected] of cases) {
      const { report } = await scan(classic(`function f(k){ ${code} }`), ['--surface', 'all'])
      expect([code, found(report)]).toEqual([code, expected])
    }
  })

  test('a write-back of the same slot gives nothing: P[k] = P[k]', async () => {
    const { report } = await scan(classic('Element.prototype[k] = Element.prototype[k]'), ['--surface', 'all'])

    expect(found(report)).toEqual([])
  })

  test('an absence-guarded write gives an add only on prototype, constructor and namespace holders', async () => {
    const code = [
      'if (!(k in history)) history[k] = impl[k]',
      'navigator[j] = navigator[j] || shim',
      'Promise[n] = Promise[n] || impl[n]',
    ]
    const { report } = await scan(classic(code.join('\n')), ['--surface', 'all'])

    expect(found(report)).toEqual(['Promise.*|add'])
    expect(records(report)).toEqual([])
  })

  test('the outcome is evaluated over every member the wildcard matches: all effective, mixed, all ineffective', async () => {
    const code = [
      // Every Object.prototype member a [[Set]] could change is writable: a finding at high mutation confidence.
      'Object.prototype[a] = wrap(Object.prototype[a])',
      // Math's constants are non-writable and its functions writable: a finding with wildcard-outcome-mixed.
      'Math[b] = wrap(Math[b])',
      // Location's own members are non-writable or readonly, and its setters API use: an ineffective-write record.
      'location[c] = wrap(location[c])',
    ]
    const { report } = await scan(classic(code.join('\n')), ['--surface', 'all'])

    expect(found(report)).toEqual(['Math.*|wrap', 'Object.prototype.*|wrap'])
    const mutation = (name: string) =>
      report.findings.find((finding: Report) => finding.target.name === name).confidence.mutation
    expect(mutation('Object.prototype.*')).toEqual({ level: 'high', reasons: [] })
    expect(mutation('Math.*')).toEqual({ level: 'medium', reasons: ['wildcard-outcome-mixed'] })
    expect(records(report)).toEqual(['location.*|non-writable', 'location.*|readonly'])
    const [record] = report.ineffectiveWrites
    expect(record.target).toEqual({ realm: 'window', holder: 'instance', name: 'location.*' })
    expect(record.occurrences[0]).toMatchObject({ effect: 'wrap', mechanism: 'assign', throws: 'strict-only' })
    expect(record.occurrences[0].trace.at(-1).kind).toBe('outcome')
  })

  test('a consoleSandbox-style loop gives console.*, which coexists with console.log, both protected', async () => {
    const code = [
      'function consoleSandbox(callback) {',
      '  var wrappedLevels = {};',
      '  var levels = Object.keys(originalConsoleMethods);',
      '  levels.forEach(function (level) {',
      '    var originalConsoleMethod = originalConsoleMethods[level];',
      '    wrappedLevels[level] = console[level];',
      '    console[level] = originalConsoleMethod;',
      '  });',
      '  try { return callback() } finally { levels.forEach(function (level) { console[level] = wrappedLevels[level] }) }',
      '}',
      'var log = console.log',
      'console.log = function () { report(arguments); return log.apply(console, arguments) }',
    ]
    // `console` is a whole entry, so both are in scope.
    const { report } = await scan(classic(code.join('\n')), ['--surface', 'protected'])

    expect(found(report)).toEqual(['console.*|replace', 'console.log|wrap'])
    expect(report.findings.map((finding: Report) => finding.surface)).toEqual(['diagnostics', 'diagnostics'])
    // No subsumption: the wildcard doesn't lower the named finding's target confidence, nor its own.
    expect(report.findings.map((finding: Report) => finding.confidence.target.level)).toEqual(['high', 'high'])
  })

  test('a wildcard is in protected scope when a member it matches is covered (§12)', async () => {
    const code = [
      'history[a] = wrap(history[a])',
      'HTMLElement.prototype[b] = wrap(HTMLElement.prototype[b])',
      'location[c] = wrap(location[c])',
      'localStorage[d] = wrap(localStorage[d])',
    ]
    const files = classic(code.join('\n'))
    const all = await scan(files, ['--surface', 'all'])
    expect(found(all.report)).toEqual(['HTMLElement.prototype.*|wrap', 'history.*|wrap', 'localStorage.*|wrap'])
    expect(records(all.report)).toEqual(['location.*|non-writable', 'location.*|readonly'])

    const { report } = await scan(files, ['--surface', 'protected'])
    expect(found(report)).toEqual(['history.*|wrap', 'localStorage.*|wrap'])
    expect(report.summary.outOfScopeBySurface.DOM).toBe(1)
    // `location.*` is all ineffective: a record, and out of the protected surface.
    expect(records(report)).toEqual([])
  })

  test('a read inside a summarized callee bound to the same key counts as reuse; separate loops do not', async () => {
    const reused = [
      'function getOrig(h, n){ return h[n] }',
      'function patch(k){ const o = getOrig(console, k); console[k] = wrap(o) }',
      'cfg.levels.forEach(patch)',
    ]
    const one = await scan(classic(reused.join('\n')))
    expect(found(one.report)).toEqual(['console.*|wrap'])

    const separate = [
      'var saved = {}',
      'keys.forEach(k => { saved[k] = console[k] })',
      'keys.forEach(k => { console[k] = function(){ return saved[k].apply(console, arguments) } })',
    ]
    const two = await scan(classic(separate.join('\n')))
    expect(found(two.report)).toEqual([])
    expect(records(two.report)).toEqual([])
  })

  test('a loop that is not unrolled leaves names[i] unknown, and the reused key gives the wildcard', async () => {
    const code = [
      "var names = ['open', 'send']",
      'for (var i = 0; i < n; i++) XMLHttpRequest.prototype[names[i]] = wrap(XMLHttpRequest.prototype[names[i]])',
    ]
    const { report } = await scan(classic(code.join('\n')))

    expect(found(report)).toEqual(['XMLHttpRequest.prototype.*|wrap'])
  })

  test('a reused key on a key variable redefined between the read and the write is not reused', async () => {
    const { report } = await scan(classic('var o = console[k]; k = other(); console[k] = wrap(o)'))

    expect(found(report)).toEqual([])
  })
})

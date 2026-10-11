// Pattern wildcards (§5 Partially resolved writes, Pattern wildcards; §12): a key that folds to a constant prefix no
// catalog member of the holder or its catalog prototype chain starts with is a non-native `add`, named
// `<holder>.<prefix>*`, on prototype, constructor and namespace holders only. It is never in protected scope. Every
// scenario goes through `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

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
const lines = (...code: string[]) => code.join('\n')
const all = ['--surface', 'all']

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** The report's findings, as `target|effect`, sorted. */
const found = (report: Report): string[] =>
  report.findings.map((finding: Report) => `${finding.target.name}|${finding.effect}`).sort()

/** A finding's target-confidence reasons. */
const targetReasons = (finding: Report): string[] => finding.confidence.target.reasons

/** The steps of a kind in a finding's first occurrence. */
const steps = (finding: Report, kind: string): Report[] =>
  finding.occurrences[0].trace.filter((step: Report) => step.kind === kind)

/** How many findings a `protected` scan left out, over every surface. */
const outOfScope = (report: Report): number =>
  Object.values(report.summary.outOfScopeBySurface as Record<string, number>).reduce((a, b) => a + b, 0)

/** The finding on a target. */
const findingOn = (report: Report, name: string): Report =>
  report.findings.find((finding: Report) => finding.target.name === name)

describe.each(resolvers)('pattern wildcards, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>, args: string[] = all) => scanBuild(files, args, { deps: { resolver } })

  test('a key that folds to a prefix no catalog member starts with gives <holder>.<prefix>* add', async () => {
    const { report } = await scan(classic("EventTarget.prototype['__zone_symbol__' + name] = f"))

    expect(found(report)).toEqual(['EventTarget.prototype.__zone_symbol__*|add'])
    const finding = findingOn(report, 'EventTarget.prototype.__zone_symbol__*')
    expect(finding.target.holder).toBe('prototype')
    expect(finding.confidence.target).toEqual({ level: 'high', reasons: [] })
  })

  test('a zone.js-style configurable prefix gives its __zone_symbol__* pattern wildcard, with member-alternatives', async () => {
    const { report } = await scan(
      classic(
        lines(
          "var p = window['__Zone_symbol_prefix'] || '__zone_symbol__'",
          'function sym(n) { return p + n }',
          'function patch(proto, name) { proto[sym(name)] = proto[name] }',
          'patch(EventTarget.prototype, cfg.name)',
        ),
      ),
    )

    // The unresolved alternative gives nothing, and no `EventTarget.prototype.*` comes from the configurable part.
    expect(found(report)).toEqual(['EventTarget.prototype.__zone_symbol__*|add'])
    const finding = findingOn(report, 'EventTarget.prototype.__zone_symbol__*')
    expect(targetReasons(finding)).toEqual(['member-alternatives'])
    // An `enumeration` step records that the prefix is configurable and names its default.
    expect(steps(finding, 'enumeration')).toEqual([
      expect.objectContaining({ holder: 'EventTarget.prototype', prefix: '__zone_symbol__', configurable: true }),
    ])
  })

  test('each literal alternative, including one the link group writes, gives its own pattern wildcard', async () => {
    // A module the entry imports is in its link group (§6); scripts of one page are not linked in R1.
    const { report } = await scan({
      'index.html': '<script type="module" src="main.js"></script>',
      'config.js': "window.__Zone_symbol_prefix = '__ng_'",
      'main.js': lines(
        "import './config.js'",
        "var p = window['__Zone_symbol_prefix'] || '__zone_symbol__'",
        'function patch(proto, name) { proto[p + name] = proto[name] }',
        'patch(EventTarget.prototype, cfg.name)',
      ),
    })

    expect(found(report)).toEqual(['EventTarget.prototype.__ng_*|add', 'EventTarget.prototype.__zone_symbol__*|add'])
    for (const finding of report.findings) {
      expect(targetReasons(finding)).toEqual(['member-alternatives'])
      const [step] = steps(finding, 'confidence-reason').filter((each: Report) => each.reason === 'member-alternatives')
      const other = finding.target.name.includes('__ng_') ? 'EventTarget.prototype.__zone_symbol__*' : 'EventTarget.prototype.__ng_*'
      expect(step.alternatives).toEqual([other])
    }
  })

  test.each([
    ['??', 'XMLHttpRequest.prototype[(cfg.prefix ?? "__x_") + k] = f'],
    ['?:', 'XMLHttpRequest.prototype[(typeof P === "string" ? P : "__x_") + k] = f'],
    ['a parameter default', 'function sym(n, p = "__x_") { return p + n } XMLHttpRequest.prototype[sym(k, cfg.p)] = f'],
    ['a destructuring default', 'const { prefix = "__x_" } = cfg; XMLHttpRequest.prototype[prefix + k] = f'],
  ])('a configurable prefix by %s gives its literal pattern wildcard', async (_, code) => {
    const { report } = await scan(classic(code))

    expect(found(report)).toEqual(['XMLHttpRequest.prototype.__x_*|add'])
    const [finding] = report.findings
    expect(targetReasons(finding)).toEqual(['member-alternatives'])
    expect(steps(finding, 'enumeration')).toEqual([
      expect.objectContaining({ holder: 'XMLHttpRequest.prototype', prefix: '__x_', configurable: true }),
    ])
  })

  test('the same shape on an instance or global holder gives no pattern wildcard', async () => {
    for (const code of ["history['__x_' + k] = f", "window['__x_' + k] = f", "navigator['__x_' + k] = f"]) {
      const { report } = await scan(classic(code))
      expect(found(report)).toEqual([])
      expect(report.ineffectiveWrites).toEqual([])
    }
  })

  test('a pattern wildcard is out of scope under --surface protected, and counted per surface', async () => {
    const code = "XMLHttpRequest.prototype['__zone_symbol__' + k] = f"
    const scoped = await scan(classic(code), ['--surface', 'protected'])
    expect(found(scoped.report)).toEqual([])
    expect(scoped.report.summary.outOfScopeBySurface.networking).toBe(1)

    // A named add on the same whole entry is protected.
    const named = await scan(classic("XMLHttpRequest.prototype['__zone_symbol__open'] = f"), ['--surface', 'protected'])
    expect(found(named.report)).toEqual(['XMLHttpRequest.prototype.__zone_symbol__open|add'])
  })

  test('a prefix catalog members start with narrows <holder>.* to them, under the reuse rule', async () => {
    const code = 'function f(k) { navigator["get" + k] = wrap(navigator["get" + k]) }'
    const { report } = await scan(classic(code))
    expect(found(report)).toEqual(['navigator.*|wrap'])
    // Narrowed to the `get…` members, none of which is covered, it is out of protected scope.
    const scoped = await scan(classic(code), ['--surface', 'protected'])
    expect(found(scoped.report)).toEqual([])
    expect(outOfScope(scoped.report)).toBe(1)

    // Without key reuse, nothing.
    const unread = await scan(classic('function f(k) { navigator["get" + k] = w }'))
    expect(found(unread.report)).toEqual([])
  })

  test("a prefix is checked against the holder's chain: Node.prototype['add' + k] falls to the reuse rule", async () => {
    const unread = await scan(classic('function f(k) { Node.prototype["add" + k] = w }'))
    expect(found(unread.report)).toEqual([])

    // With reuse, `Node.prototype.*` matches the shadow of `EventTarget.prototype.addEventListener`: protected (events).
    const reused = await scan(classic('function f(k) { Node.prototype["add" + k] = wrap(Node.prototype["add" + k]) }'), [
      '--surface',
      'protected',
    ])
    expect(found(reused.report)).toEqual(['Node.prototype.*|wrap'])

    // `__zone_symbol__` and `Symbol(` prefixes are unaffected.
    const pattern = await scan(classic('Node.prototype["__zone_symbol__" + k] = w; Node.prototype["Symbol(" + k] = w'))
    expect(found(pattern.report)).toEqual(['Node.prototype.Symbol(*|add', 'Node.prototype.__zone_symbol__*|add'])
  })

  test('a prefix §4 writes in brackets is JSON-quoted, with the star outside', async () => {
    const { report } = await scan(
      classic(lines('Object.prototype["__core.hidden." + k] = v', 'Object.prototype["__core.hidden.*"] = v')),
    )
    expect(found(report)).toEqual(['Object.prototype["__core.hidden."]*|add', 'Object.prototype["__core.hidden.*"]|add'])
  })

  test('literal prefixes follow the 4-candidate rule: four give four, five give nothing', async () => {
    const four = await scan(classic("XMLHttpRequest.prototype[(a ? '__a_' : b ? '__b_' : c ? '__c_' : '__d_') + k] = f"))
    expect(found(four.report)).toEqual(['__a_', '__b_', '__c_', '__d_'].map((prefix) => `XMLHttpRequest.prototype.${prefix}*|add`))
    for (const finding of four.report.findings) expect(targetReasons(finding)).toEqual(['member-alternatives'])

    // Above 4, the wildcard rule narrowed to the candidates, which no catalog member starts with: nothing.
    const five = await scan(classic("XMLHttpRequest.prototype[(a ? '__a_' : b ? '__b_' : c ? '__c_' : d ? '__d_' : '__e_') + k] = f"))
    expect(found(five.report)).toEqual([])
    expect(five.report.completeness.limitations).toEqual([])
  })

  test('a prefix folds as ECMA-262 adds: a constant before a prefixed string, and a template part that folds', async () => {
    const nested = await scan(classic('XMLHttpRequest.prototype["__zone" + ("_symbol__" + k)] = f'))
    expect(found(nested.report)).toEqual(['XMLHttpRequest.prototype.__zone_symbol__*|add'])

    // An alternative that folds whole stays a constant, as it does outside a template.
    for (const key of ['`${c ? "open" : k}`', '`${c ? "op" : k}en`']) {
      const { report } = await scan(classic(`XMLHttpRequest.prototype[${key}] = f`))
      expect(found(report)).toEqual(['XMLHttpRequest.prototype.open|replace'])
      expect(targetReasons(report.findings[0])).toEqual(['member-alternatives'])
    }
  })

  test('several prefixes catalog members start with give one <holder>.*, narrowed to the members of any (Principle 3)', async () => {
    // Whichever alternative comes first, the `add…` members keep `Node.prototype.*` protected (events).
    for (const p of ['c ? "get" : "add"', 'c ? "add" : "get"']) {
      const code = `function f(k) { var p = ${p}; Node.prototype[p + k] = wrap(Node.prototype[p + k]) }`
      const { report } = await scan(classic(code), ['--surface', 'protected'])
      expect(found(report)).toEqual(['Node.prototype.*|wrap'])
    }

    // Above 4 candidates, the narrowed wildcard keeps the members that start with a native prefix.
    const five = 'a ? "get" : b ? "__a_" : c ? "__b_" : d ? "__c_" : "add"'
    const wide = await scan(classic(`function f(k) { var p = ${five}; Node.prototype[p + k] = wrap(Node.prototype[p + k]) }`), [
      '--surface',
      'protected',
    ])
    expect(found(wide.report)).toEqual(['Node.prototype.*|wrap'])
  })

  test('a native prefix and a pattern prefix at one site are one candidate set, each with member-alternatives', async () => {
    const reused = await scan(classic('function f(k) { var p = c ? "get" : "__x_"; Node.prototype[p + k] = wrap(Node.prototype[p + k]) }'))
    expect(found(reused.report)).toEqual(['Node.prototype.*|wrap', 'Node.prototype.__x_*|add'])
    for (const finding of reused.report.findings) expect(targetReasons(finding)).toEqual(['member-alternatives'])

    // Without reuse the native prefix gives nothing, and the pattern keeps its candidate set.
    const unread = await scan(classic('function f(k) { var p = c ? "get" : "__x_"; Node.prototype[p + k] = w }'))
    expect(found(unread.report)).toEqual(['Node.prototype.__x_*|add'])
    expect(targetReasons(unread.report.findings[0])).toEqual(['member-alternatives'])
  })

  test('a define of a prefixed key is a pattern wildcard add too, and a delete of one changes no native', async () => {
    const define = await scan(classic("Object.defineProperty(EventTarget.prototype, '__zone_symbol__' + k, { value: f })"))
    expect(found(define.report)).toEqual(['EventTarget.prototype.__zone_symbol__*|add'])

    const deleted = await scan(classic("delete EventTarget.prototype['__zone_symbol__' + k]"))
    expect(found(deleted.report)).toEqual([])
    expect(deleted.report.ineffectiveWrites).toEqual([])
  })
})

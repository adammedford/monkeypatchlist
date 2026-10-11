// Restores through locals, parameters and closures (§3 Restores, §14 `restore`): a write that puts back the unmutated
// native of the same object and member on every path is a proven restore. It is never a finding or an occurrence, and
// it leaves a `restore` step on the install occurrence in its chain. Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'
import { identityMappings, mappings } from './support/source-map.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

// The shipped resolver, with eslint-scope behind the binding-resolution seam, and the verified drop-in (§19).
const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })

/**
 * `classic(code)` with a sidecar map that sends each line to the same place in one of two package files: `lines[i]`
 * names the package of line `i + 1`, `x` or `y`.
 */
const twoPackages = (code: string, lines: ('x' | 'y')[]) => {
  const sources = ['webpack://app/./node_modules/x/index.js', 'webpack://app/./node_modules/y/index.js']
  const inY = identityMappings(code, 1)
  const decoded = identityMappings(code, 0).map((segments, line) => (lines[line] === 'y' ? inY[line]! : segments))
  const map = { version: 3, sources, sourcesContent: [code, code], names: [], mappings: mappings(decoded) }
  return { ...classic(code), 'main.js.map': JSON.stringify(map) }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** Each finding as `target|effect`, with the positions of its occurrences as `line:column`. */
const findings = (report: Report): Record<string, string[]> =>
  Object.fromEntries(
    report.findings.map((finding: Report) => [
      `${finding.target.name}|${finding.effect}`,
      finding.occurrences.map((o: Report) => `${o.generated.line}:${o.generated.column}`),
    ]),
  )

/** The `restore` steps on every occurrence of every finding, without their text. */
const restoreSteps = (report: Report): Report[] =>
  report.findings.flatMap((finding: Report) =>
    finding.occurrences.flatMap((o: Report) =>
      o.trace
        .filter((step: Report) => step.kind === 'restore')
        .map(({ generated, guard, leavesOwnShadow }: Report) => ({
          at: `${generated.line}:${generated.column}`,
          guard,
          leavesOwnShadow,
        })),
    ),
  )

describe.each(resolvers)('restores, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = async (code: string) => (await scanBuild(classic(code), [], { deps: { resolver } })).report

  test('a local capture written back is a proven restore: one finding, with a restore step on its install', async () => {
    const report = await scan(
      'const o = window.fetch;\nwindow.fetch = function () { return o.apply(this, arguments) };\nfunction teardown() { window.fetch = o }\nwindow.__teardown = teardown',
    )

    expect(findings(report)).toEqual({ 'Window.fetch|wrap': ['2:0'] })
    expect(restoreSteps(report)).toEqual([{ at: '3:22', guard: 'none', leavesOwnShadow: false }])
  })

  test('an identity-guarded restore records `guard: identity`', async () => {
    const report = await scan(
      'var o = window.fetch;\nvar ours = function () { return o.apply(this, arguments) };\nwindow.fetch = ours;\n' +
        'window.__teardown = function () { if (window.fetch === ours) window.fetch = o }',
    )

    expect(findings(report)).toEqual({ 'Window.fetch|wrap': ['3:0'] })
    expect(restoreSteps(report)).toEqual([{ at: '4:61', guard: 'identity', leavesOwnShadow: false }])
  })

  test('`patch(history, "pushState")` and its returned restore record `leavesOwnShadow: true`', async () => {
    const report = await scan(
      'function patch(s, n, f) {\n  var orig = s[n];\n  s[n] = f(orig);\n  return function () { s[n] = orig }\n}\n' +
        "window.__teardown = patch(history, 'pushState', function (o) { return function () { return o.apply(this, arguments) } })",
    )

    expect(findings(report)).toEqual({ 'history.pushState|wrap': ['3:2'] })
    expect(restoreSteps(report)).toEqual([{ at: '4:23', guard: 'none', leavesOwnShadow: true }])
  })

  test('a parameter passed through a two-level helper is a proven restore', async () => {
    const report = await scan(
      'function repl(t, m, orig, inst) {\n  t[m] = inst;\n  return { stop: function () { if (t[m] === inst) { t[m] = orig } } }\n}\n' +
        'function instrument(t, m) { var orig = t[m]; return repl(t, m, orig, function () { return orig.apply(this, arguments) }) }\n' +
        "window.__teardown = instrument(History.prototype, 'pushState').stop",
    )

    expect(findings(report)).toEqual({ 'History.prototype.pushState|wrap': ['2:2'] })
    expect(restoreSteps(report)).toEqual([{ at: '3:52', guard: 'identity', leavesOwnShadow: false }])
  })

  test('a proven restore with no install in its chain is dropped', async () => {
    const report = await scan('var o = window.fetch;\nwindow.__teardown = function () { window.fetch = o }')

    expect(findings(report)).toEqual({})
  })

  test('an unproven restore with an install in its chain joins the install’s finding and takes its effect', async () => {
    const report = await scan(
      'let o = null;\nfunction start() { o = window.fetch; window.fetch = function () { return o.apply(this, arguments) } }\n' +
        'function teardown() { window.fetch = o }\nwindow.__start = start; window.__teardown = teardown',
    )

    expect(findings(report)).toEqual({ 'Window.fetch|wrap': ['2:37', '3:22'] })
    expect(restoreSteps(report)).toEqual([])
  })

  test('a guard that tests the saved value narrows it, so the reset after the restore leaves it proven', async () => {
    const report = await scan(
      'let orig = null;\nfunction start() { orig = window.fetch; window.fetch = function () { return orig.apply(this, arguments) } }\n' +
        'function teardown() { if (orig) { window.fetch = orig; orig = null } }\nwindow.__start = start; window.__teardown = teardown',
    )

    expect(findings(report)).toEqual({ 'Window.fetch|wrap': ['2:40'] })
    expect(restoreSteps(report)).toEqual([{ at: '3:34', guard: 'none', leavesOwnShadow: false }])
  })

  test.each([
    ['if (orig != null)', 'orig != null'],
    ["if (typeof orig === 'function')", "typeof orig === 'function'"],
  ])('`%s` narrows the saved value too', async (guard) => {
    const report = await scan(
      'let orig = null;\nfunction start() { orig = window.fetch; window.fetch = function () { return orig.apply(this, arguments) } }\n' +
        `function teardown() { ${guard} { window.fetch = orig; orig = undefined } }\nwindow.__start = start; window.__teardown = teardown`,
    )

    expect(Object.keys(findings(report))).toEqual(['Window.fetch|wrap'])
    expect(findings(report)['Window.fetch|wrap']).toHaveLength(1)
    expect(restoreSteps(report)).toHaveLength(1)
  })

  test('a reset after an unguarded restore leaves it unproven: a second call writes `undefined`', async () => {
    const report = await scan(
      'let orig;\nfunction start() { orig = window.fetch; window.fetch = function () { return orig.apply(this, arguments) } }\n' +
        'function teardown() { window.fetch = orig; orig = undefined }\nwindow.__start = start; window.__teardown = teardown',
    )

    expect(findings(report)).toEqual({ 'Window.fetch|wrap': ['2:40', '3:22'] })
    expect(restoreSteps(report)).toEqual([])
  })

  test('a fallback after a value read is live: §3 makes only a fallback after a descriptor read dead code', async () => {
    const report = await scan(
      'var o = XMLHttpRequest.prototype.open || function () {};\n' +
        'XMLHttpRequest.prototype.open = function () { return o.apply(this, arguments) };\n' +
        'window.__teardown = function () { XMLHttpRequest.prototype.open = o }',
    )

    // Unproven, so the restore joins its install's finding as one more occurrence.
    expect(findings(report)).toEqual({ 'XMLHttpRequest.prototype.open|wrap': ['2:0', '3:34'] })
    expect(restoreSteps(report)).toEqual([])
  })

  test('a write-back with a fallback in the same expression stays the polyfill it is', async () => {
    const report = await scan('window.fetch = window.fetch || function () {}')

    expect(findings(report)).toEqual({ 'Window.fetch|replace': ['1:0'] })
  })

  test("another window's slot is never shown restored", async () => {
    const report = await scan(
      'var o = parent.fetch;\nparent.fetch = function () { return o.apply(this, arguments) };\n' +
        'window.__teardown = function () { parent.fetch = o }',
    )

    // Not a restore at all: the ordinary rules give the write its own effect.
    expect(findings(report)).toEqual({ 'Window.fetch|replace': ['3:34'], 'Window.fetch|wrap': ['2:0'] })
    expect(restoreSteps(report)).toEqual([])
  })

  test('a union with any non-native value is not proven, and with no install it follows the ordinary rules', async () => {
    const report = await scan(
      'var o = window.fetch;\nif (window.__x) o = function () {};\nwindow.__teardown = function () { window.fetch = o }',
    )

    expect(findings(report)).toEqual({ 'Window.fetch|replace': ['3:34'] })
    expect(restoreSteps(report)).toEqual([])
  })

  test('a `delete` is never an install: an unproven restore after one in its chain keeps its own effect', async () => {
    const report = await scan(
      'var o = window.fetch;\nif (window.__x) o = function () {};\nwindow.__a = function () { delete window.fetch };\n' +
        'window.__b = function () { window.fetch = o }',
    )

    // Only a write that sets a value (`replace`, `wrap`, `descriptor-change`) is an install.
    expect(findings(report)).toEqual({ 'Window.fetch|delete': ['3:27'], 'Window.fetch|replace': ['4:27'] })
    expect(restoreSteps(report)).toEqual([])
  })

  test('a proven restore leaves no `restore` step on a `delete` in its chain', async () => {
    const report = await scan(
      'var o = window.fetch;\nwindow.__a = function () { delete window.fetch };\nwindow.__b = function () { window.fetch = o }',
    )

    expect(findings(report)).toEqual({ 'Window.fetch|delete': ['2:27'] })
    expect(restoreSteps(report)).toEqual([])
  })
  test('with several installs in its chain, an unproven restore joins the first in document order', async () => {
    const report = await scan(
      'var o = window.fetch;\nwindow.fetch = function () { return o.apply(this, arguments) };\n' +
        'window.__r = function () { window.fetch = function () {} };\nwindow.__stop = function () { window.fetch = window.__c ? o : null }',
    )

    // §3: the first install in document order is the `wrap`.
    expect(findings(report)).toEqual({ 'Window.fetch|wrap': ['2:0', '4:30'], 'Window.fetch|replace': ['3:27'] })
  })

  test('an unproven restore takes its install’s attribution lookup too, so it never adds a fingerprint', async () => {
    const code =
      'var o = window.fetch;\nwindow.fetch = function () { return o.apply(this, arguments) };\n' +
      'window.__stop = function () { window.fetch = window.__c ? o : null }'
    const { report } = await scanBuild(twoPackages(code, ['x', 'x', 'y']), [], { deps: { resolver } })

    // The restore's code maps to `pkg:y`, but it is one more occurrence of `pkg:x`'s wrap (§3).
    expect(report.findings.map((finding: Report) => finding.fingerprint)).toEqual(['window|Window.fetch|wrap|pkg:x'])
    expect(findings(report)).toEqual({ 'Window.fetch|wrap': ['2:0', '3:30'] })
  })
})

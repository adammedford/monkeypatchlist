// Classic-script declarations (§3 Declarations in classic scripts, Ineffective writes). A top-level `var`,
// `function`, `let`, `const` or `class` of a native name in a classic script mutates the global object's member, with
// mechanism `declare`. Each form follows ECMA-262 (GlobalDeclarationInstantiation, CreateGlobalVarBinding,
// CreateGlobalFunctionBinding, Annex B and EvalDeclarationInstantiation). Every
// scenario goes through `monkeypatchlist scan --json`.

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** Each finding as `target|effect`, its `locks`, and its occurrences' mechanisms. */
const findings = (report: Report) =>
  report.findings.map((finding: Report) => [
    `${finding.target.name}|${finding.effect}`,
    finding.locks,
    finding.occurrences.map((occurrence: Report) => occurrence.mechanism),
  ])

/** Each ineffective-write record as `target|reason|throws`, one per `throws` of its occurrences. */
const ineffective = (report: Report) =>
  report.ineffectiveWrites.flatMap((record: Report) =>
    [...new Set(record.occurrences.map((occurrence: Report) => occurrence.throws))].map(
      (throws) => `${record.target.name}|${record.reason}|${throws}`,
    ),
  )

describe.each(resolvers)('classic-script declarations, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test('a top-level function over a configurable global is a locking replace, with mechanism declare', async () => {
    const { report } = await scan('function fetch() {}')

    expect(findings(report)).toEqual([['Window.fetch|replace', true, ['declare']]])
  })

  test('var follows the assign row: API use, a Replaceable replace, a readonly ineffective write', async () => {
    const { report } = await scan(lines("var name = 'x'", 'var onload = f', 'var length = 5', 'var closed = 1'))

    expect(findings(report)).toEqual([['Window.length|replace', false, ['declare']]])
    expect(ineffective(report)).toEqual(['Window.closed|readonly|strict-only'])
  })

  test('a bare var of a name the global object has as its own is not recorded', async () => {
    const { report } = await scan(lines('var fetch;', 'var closed;', 'var NaN;'))

    expect(findings(report)).toEqual([])
    expect(report.ineffectiveWrites).toEqual([])
  })

  test('a var of an inherited native name defines an own property first, then sets it', async () => {
    const { report } = await scan(lines('var addEventListener;', 'var __proto__ = x;'))

    expect(findings(report)).toEqual([['Window.addEventListener|replace', true, ['declare']]])
    expect(report.findings[0].target).toMatchObject({ shadows: 'EventTarget.prototype.addEventListener' })
  })

  test('non-configurable collisions are ineffective writes that always throw', async () => {
    const { report } = await scan(lines('function top() {}', 'let document = 1', 'const location = 1', 'class window {}', 'function NaN() {}'))

    expect(findings(report)).toEqual([])
    expect(ineffective(report).sort()).toEqual([
      'Window.NaN|non-configurable|always',
      'Window.document|non-configurable|always',
      'Window.location|non-configurable|always',
      'Window.top|non-configurable|always',
      'Window.window|non-configurable|always',
    ])
    expect(report.ineffectiveWrites[0].occurrences[0].mechanism).toBe('declare')
  })

  test('a collision leaves the rest of the script analyzed, before and after it', async () => {
    for (const code of ['let document = 1; window.fetch = w', 'window.fetch = w; function top() {}']) {
      const { report } = await scan(code)

      expect(findings(report)).toEqual([['Window.fetch|replace', false, ['assign']]])
      expect(report.ineffectiveWrites).toHaveLength(1)
    }
  })

  test("let, const and class follow the binding's value, with locks false", async () => {
    const { report } = await scan(
      lines('let fetch;', 'class Request {}', "let name = 'x'", 'const onload = f', 'const Response = window.Response'),
    )

    expect(findings(report)).toEqual([
      ['Window.Request|replace', false, ['declare']],
      ['Window.fetch|replace', false, ['declare']],
      ['Window.name|replace', false, ['declare']],
      ['Window.onload|replace', false, ['declare']],
    ])
  })

  test('a let, const or class whose value reads the same slot writes it back, and gives nothing', async () => {
    const { report } = await scan(lines('const fetch = window.fetch', 'const { Request } = window', 'let { Headers: Headers } = self'))

    expect(findings(report)).toEqual([])
  })

  test('a destructured name reads its own key, so a pattern over another object is a replace', async () => {
    const { report } = await scan(lines('const { fetch } = other', 'var { Request } = parent', 'let [Response] = xs', 'const { ["Headers"]: Headers } = window'))

    expect(findings(report)).toEqual([
      ['Window.Request|replace', false, ['declare']],
      ['Window.Response|replace', false, ['declare']],
      ['Window.fetch|replace', false, ['declare']],
    ])
  })

  test('a declaration whose value calls the original is a wrap', async () => {
    const { report } = await scan(lines('const fetch = wrap(window.fetch)', 'var Request = mk(window.Request)'))

    expect(findings(report)).toEqual([
      ['Window.Request|wrap', false, ['declare']],
      ['Window.fetch|wrap', false, ['declare']],
    ])
  })

  test('module-script declarations give nothing', async () => {
    const { report } = await scanBuild(
      { 'index.html': '<script type="module" src="main.js"></script>', 'main.js': 'var fetch = f; function Request() {}; let top = 1; class Response {}' },
      [],
      { deps: { resolver } },
    )

    expect(findings(report)).toEqual([])
    expect(report.ineffectiveWrites).toEqual([])
  })

  test('var opener = {} is a Window.opener replace, with mechanism declare', async () => {
    const { report } = await scan('var opener = {}')

    expect(findings(report)).toEqual([['Window.opener|replace', false, ['declare']]])
    expect(report.findings[0].confidence.mutation.level).toBe('high')
  })

  test('var opener = window.opener at the top of an inline script is a replace with outcome-undecidable', async () => {
    const { report } = await scanBuild(
      { 'index.html': '<script>var opener = window.opener</script>' },
      ['--surface', 'all'],
      { deps: { resolver } },
    )

    expect(findings(report)).toEqual([['Window.opener|replace', false, ['declare']]])
    const [finding] = report.findings
    expect(finding.confidence.mutation).toMatchObject({ level: 'medium', reasons: ['outcome-undecidable'] })
    expect(finding.occurrences[0].artifact.url).toMatch(/#inline-1$/)
    expect(finding.occurrences[0].trace.map((step: Report) => step.kind)).toContain('confidence-reason')
  })

  test('an Annex B block function follows the assign row where its block runs', async () => {
    const { report } = await scan(lines('if (!window.fetch) { function fetch() {} }', '{ function onload() {} }', '{ function top() {} }'))

    expect(findings(report)).toEqual([['Window.fetch|replace', false, ['declare']]])
    expect(ineffective(report)).toEqual(['Window.top|readonly|never'])
  })

  test("direct-eval var and function give replace with locks false, and eval's lexical declarations nothing", async () => {
    const { report } = await scan(
      lines('eval("function fetch() {}")', 'eval("var Request = f")', 'eval("let Response = 1; const Headers = 1; class URL {}")'),
    )

    expect(findings(report)).toEqual([
      ['Window.Request|replace', false, ['declare']],
      ['Window.fetch|replace', false, ['declare']],
    ])
  })

  test('string-timer code gets the full classic-script rules', async () => {
    const { report } = await scan(lines('setTimeout("function fetch() {}")', 'setTimeout("let Request = 1")'))

    expect(findings(report)).toEqual([
      ['Window.Request|replace', false, ['declare']],
      ['Window.fetch|replace', true, ['declare']],
    ])
  })

  test('declarations inside a function, or in strict eval code, are local', async () => {
    const { report } = await scan(
      lines('(function () { var fetch = 1; function Request() {} { function Response() {} } })()', 'eval("\'use strict\'; var Headers = 1")'),
    )

    expect(findings(report)).toEqual([])
  })

  test("a for-in or for-of var assigns each iteration's value", async () => {
    const { report } = await scan('for (var fetch of fs) {}')

    expect(findings(report)).toEqual([['Window.fetch|replace', false, ['declare']]])
  })

  test("in a classic worker script, a declaration names the worker global's member", async () => {
    const { report } = await scanBuild(
      { 'index.html': '<script src="main.js"></script>', 'main.js': 'new Worker("/worker.js")', 'worker.js': 'function fetch() {}' },
      [],
      { deps: { resolver } },
    )

    expect(findings(report)).toEqual([['DedicatedWorkerGlobalScope.fetch|replace', true, ['declare']]])
  })

  test("indirect-eval code declares configurable globals, and keeps its lexical declarations (ECMA-262 per form)", async () => {
    const { report } = await scan(lines('(0, eval)("function fetch() {} var Request; let Response = 1")'))

    expect(findings(report)).toEqual([['Window.fetch|replace', false, ['declare']]])
  })
})

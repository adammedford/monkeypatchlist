// Code in literal `eval`, `new Function` and string timers (§2 Content that isn't JavaScript, §19 Raw occurrences). A
// literal code string is parsed and analyzed as nested code, and its occurrences are located inside the host artifact,
// at the literal. Every scenario goes through `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

import { describe, expect, test } from 'vitest'
import { loadCatalog, type Realm } from '../src/index.ts'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { defaultBudget, jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

// The shipped resolver, with eslint-scope behind the binding-resolution seam, and the verified drop-in (§19).
const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const fingerprints = (report: Report): string[] => report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)

const current = { realm: 'window', realmInstance: 'current' }
const text = expect.any(String)

/** The location of `part` in `code` (its first occurrence at or after `from`), as a report gives it. Lines end at LF. */
function at(code: string, part: string, from = 0) {
  const start = code.indexOf(part, from)
  if (start < 0) throw new Error(`${part} is not in the code`)
  const line = code.slice(0, start).split('\n').length
  const lineStart = code.lastIndexOf('\n', start - 1) + 1
  return { start, end: start + part.length, line, column: start - lineStart }
}

describe.each(resolvers)('nested code, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe('a direct eval of a string literal', () => {
    test('eval("window.fetch = function(){}") gives Window.fetch, located in the host artifact at the literal', async () => {
      const code = 'var ready = 1;\neval("window.fetch = function(){}")'
      const { report } = await scan(classic(code))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.artifact.url).toBe('https://app.example/main.js')
      expect(occurrence.generated).toEqual(at(code, 'window.fetch = function(){}'))
      expect(occurrence.trace).toEqual([
        {
          kind: 'note',
          about: 'nested-code',
          callee: 'eval',
          scope: 'caller',
          call: at(code, 'eval("window.fetch = function(){}")'),
          text,
        },
        { kind: 'binding', name: 'eval', resolution: 'global', form: 'global-property', ...current, text },
        { kind: 'binding', name: 'window', resolution: 'alias', form: 'global-name', aliasOf: 'Window', ...current, text },
      ])
    })

    test("its names resolve in the caller's scope: a local there is no native", async () => {
      const { report } = await scan(
        classic(
          [
            'function a(window){ eval("window.fetch = w") }',
            'function b(){ var XMLHttpRequest = {}; eval("XMLHttpRequest.prototype.send = w") }',
            '{ let fetch; eval("fetch = w") }',
            'let open = 1; eval("open = w")',
          ].join('\n'),
        ),
      )

      // Only the top-level `let open` itself, which hides `Window.open` (§3 Declarations in classic scripts).
      expect(fingerprints(report)).toEqual(['window|Window.open|replace|unknown'])
    })

    test("sloppy eval code declares its vars in the caller's var scope, and strict eval code in its own", async () => {
      const code = [
        'eval("var fetch; fetch = a")',
        'function f(){ eval("var alert; alert = b") }',
        'eval(\'"use strict"; var open; open = c\')',
        'function g(){ "use strict"; eval("var print; print = d") }',
      ].join('\n')
      const { report } = await scan(classic(code))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(report.findings[0].occurrences[0].trace.at(-1)).toEqual({
        kind: 'binding',
        name: 'fetch',
        resolution: 'declaration',
        form: 'global-property',
        declaration: { kind: 'var', generated: at(code, 'var fetch;') },
        ...current,
        text,
      })
    })

    test('in a module, eval code is strict, and its free names are still the global object', async () => {
      const { report } = await scan({
        'index.html': '<script type="module" src="main.js"></script>',
        'main.js': 'eval("var fetch; fetch = a")\neval("window.alert = b")',
      })

      expect(fingerprints(report)).toEqual(['window|Window.alert|replace|unknown'])
    })

    test('the direct-eval-scope taint still applies to the enclosing scope, and to the names of the eval code', async () => {
      const code = 'function f(){ eval("var x = 1; window.alert = a"); fetch = b }'
      const { report } = await scan(classic(code))

      expect(fingerprints(report)).toEqual(['window|Window.alert|replace|unknown', 'window|Window.fetch|replace|unknown'])
      const [alert, fetch] = report.findings
      const taint = (name: string) => ({
        kind: 'confidence-reason',
        dimension: 'target',
        reason: 'direct-eval-scope',
        level: 'medium',
        name,
        sites: [at(code, 'eval("var x = 1; window.alert = a")')],
        text,
      })
      expect(fetch.confidence.target).toEqual({ level: 'medium', reasons: ['direct-eval-scope'] })
      // The taint makes reachability `unknown` (§7).
      const unknown = expect.objectContaining({ kind: 'guard', class: 'unknown', result: 'unknown' })
      // `f` has no resolved caller, so it is judged from where it was created (§7).
      expect(fetch.occurrences[0].trace).toEqual([
        expect.objectContaining({ kind: 'binding', name: 'fetch' }),
        taint('fetch'),
        expect.objectContaining({ kind: 'creation-site' }),
        unknown,
      ])
      expect(alert.confidence.target).toEqual({ level: 'medium', reasons: ['direct-eval-scope'] })
      expect(alert.occurrences[0].trace.map((step: { kind: string; name?: string }) => [step.kind, step.name])).toEqual([
        ['note', undefined],
        ['binding', 'eval'],
        ['confidence-reason', 'eval'],
        ['binding', 'window'],
        ['confidence-reason', 'window'],
        ['creation-site', undefined],
        ['guard', undefined],
      ])
      expect(alert.occurrences[0].trace[4]).toEqual(taint('window'))
    })

    test('a with block around the eval is on the resolution path of its code', async () => {
      const { report } = await scan(classic('with (o) { eval("fetch = w") }'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(report.findings[0].confidence.target).toEqual({ level: 'low', reasons: ['with-scope'] })
    })

    test("eval code sees its caller's this and typeof guards, and hoists block functions to the caller's var scope", async () => {
      const { report } = await scan(
        classic(
          [
            'eval("this.fetch = a")',
            'function f(){ eval("this.alert = b") }',
            'if (typeof global !== "undefined") eval("global.open = c")',
            'eval("{ function print(){} } print = d")',
            'function g(){ eval("{ function stop(){} } stop = e") }',
            'function h(){ eval("{ function focus(){} }"); focus = f }',
            'setTimeout("delete blur")',
          ].join('\n'),
        ),
      )
      const module = await scan({
        'index.html': '<script type="module" src="main.js"></script>',
        'main.js': 'eval("this.fetch = a")',
      })

      expect(fingerprints(report)).toEqual([
        'window|Window.blur|delete|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.focus|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|Window.print|replace|unknown',
      ])
      const byName = (name: string) => report.findings.find((finding: { target: { name: string } }) => finding.target.name === name)
      const open = byName('Window.open').occurrences[0]
      expect(open.trace.find((step: { name?: string }) => step.name === 'global')).toMatchObject({ form: 'guarded-global' })
      // Direct-eval code runs at its call, so the guard around the call is on its path (§7).
      expect(open.trace.at(-1)).toMatchObject({ kind: 'guard', expression: 'typeof global !== "undefined"' })
      expect(open.reachabilityBasis).toBe('call-path')
      expect(byName('Window.print').occurrences[0].trace.at(-1)).toMatchObject({
        name: 'print',
        resolution: 'declaration',
        declaration: { kind: 'block-function' },
      })
      // The eval's block function doesn't change what the caller's own names resolve to: `focus` is still tainted.
      expect(byName('Window.focus').confidence.target).toEqual({ level: 'medium', reasons: ['direct-eval-scope'] })
      expect(module.report.findings).toEqual([])
    })

    test('an eval that is no native eval gives nothing, and one whose code does not parse gives only dynamic code', async () => {
      const { report } = await scan(
        classic(
          [
            'function a(eval){ eval("window.fetch = w") }',
            'function eval(){}',
            'eval("window.alert = w")',
            'o.eval("window.open = w")',
          ].join('\n'),
        ),
      )
      const unparsed = await scan(classic('eval("window.fetch = w; return")\neval("window.alert = ")'))

      // Only the top-level `function eval` itself (§3 Declarations in classic scripts).
      expect(fingerprints(report)).toEqual(['window|Window.eval|replace|unknown'])
      expect(report.completeness.limitations).toEqual([])
      expect(unparsed.report.findings).toEqual([])
      // Literal code that doesn't parse is a dynamic-code limitation.
      expect(unparsed.report.completeness.limitations.map((record: { kind: string }) => record.kind)).toEqual([
        'dynamic-code',
        'dynamic-code',
      ])
    })
  })

  describe('global code: an indirect eval, a string timer, and the Function constructor', () => {
    test('an indirect eval runs its code in the global scope, whatever the caller declares', async () => {
      const code = [
        '(0, eval)("fetch = a")',
        'window.eval("alert = b")',
        'eval?.("open = c")',
        'function f(window, print){ (0, eval)("window.print = d") }',
      ].join('\n')
      const { report } = await scan(classic(code))

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|Window.print|replace|unknown',
      ])
      const [alert, fetch] = report.findings
      expect(fetch.occurrences[0].generated).toEqual(at(code, 'fetch = a'))
      expect(fetch.occurrences[0].trace).toEqual([
        { kind: 'note', about: 'nested-code', callee: 'eval', scope: 'global', call: at(code, '(0, eval)("fetch = a")'), text },
        { kind: 'binding', name: 'eval', resolution: 'global', form: 'global-property', ...current, text },
        { kind: 'binding', name: 'fetch', resolution: 'global', form: 'global-property', ...current, text },
      ])
      expect(alert.occurrences[0].trace.slice(0, 2)).toEqual([
        { kind: 'note', about: 'nested-code', callee: 'eval', scope: 'global', call: at(code, 'window.eval("alert = b")'), text },
        { kind: 'binding', name: 'window', resolution: 'alias', form: 'global-name', aliasOf: 'Window', ...current, text },
      ])
    })

    test("sloppy indirect eval code's vars are the global object's properties, and strict eval code's are its own", async () => {
      const { report } = await scan(
        classic('(0, eval)("var fetch; fetch = a")\n(0, eval)(\'"use strict"; var alert; alert = b\')'),
      )

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    })

    test('new Function("a", "XMLHttpRequest.prototype.send = a") is analyzed, with its parameters as locals', async () => {
      const code = [
        'new Function("a", "XMLHttpRequest.prototype.send = a")',
        'Function("fetch", "b", "fetch = b; window.alert = b")',
        'new window.Function("var open; open = 1")',
      ].join('\n')
      const { report } = await scan(classic(code))

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|XMLHttpRequest.prototype.send|replace|unknown',
      ])
      const [alert, send] = report.findings
      expect(send.occurrences[0].generated).toEqual(at(code, 'XMLHttpRequest.prototype.send = a'))
      expect(send.occurrences[0].trace).toEqual([
        {
          kind: 'note',
          about: 'nested-code',
          callee: 'Function',
          scope: 'global',
          call: at(code, 'new Function("a", "XMLHttpRequest.prototype.send = a")'),
          text,
        },
        { kind: 'binding', name: 'Function', resolution: 'global', form: 'global-property', holds: 'Function', ...current, text },
        {
          kind: 'binding',
          name: 'XMLHttpRequest',
          resolution: 'global',
          form: 'global-property',
          holds: 'XMLHttpRequest',
          ...current,
          text,
        },
        // The function the constructor makes has no resolved call, so it is judged from where it was made (§7).
        expect.objectContaining({ kind: 'creation-site' }),
      ])
      expect(alert.occurrences[0].generated).toEqual(at(code, 'window.alert = b'))
    })

    test('parameters and a body that close the function early are not the code of one function, but dynamic code', async () => {
      const { report } = await scan(
        classic(
          [
            'new Function("}); window.fetch = a; (function(){")',
            'new Function("a) { window.alert = b }; (function(", "")',
          ].join('\n'),
        ),
      )

      expect(report.findings).toEqual([])
      expect(report.completeness.limitations.map((record: { kind: string }) => record.kind)).toEqual([
        'dynamic-code',
        'dynamic-code',
      ])
    })

    test('a string setTimeout or setInterval is compiled as a classic script', async () => {
      const code = [
        'setTimeout("window.fetch = a", 10)',
        'window.setInterval("var alert; alert = b")',
        'self.setTimeout("this.open = c")',
        'setTimeout(function(){ window.print = d }, 0)',
      ].join('\n')
      const { report } = await scan(classic(code))

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|Window.print|replace|unknown',
      ])
      const [alert, fetch, open, print] = report.findings
      expect(fetch.occurrences[0].trace[0]).toEqual({
        kind: 'note',
        about: 'nested-code',
        callee: 'setTimeout',
        scope: 'global',
        call: at(code, 'setTimeout("window.fetch = a", 10)'),
        text,
      })
      expect(alert.occurrences[0].trace[0]).toMatchObject({ kind: 'note', callee: 'setInterval', scope: 'global' })
      expect(open.occurrences[0].trace.at(-1)).toMatchObject({ kind: 'binding', name: 'this', form: 'top-level-this' })
      // A function handler is ordinary code in the host, which the timer calls: it is judged from where it was made.
      expect(print.occurrences[0].trace.map((step: { kind: string }) => step.kind)).toEqual(['binding', 'creation-site'])
    })

    test("global code sees the host script's top-level lexical declarations, and not a module's", async () => {
      const script = await scan(classic('let fetch = 1\nsetTimeout("fetch = a")\nconst alert = 2; (0, eval)("alert = b")'))
      const module = await scan({
        'index.html': '<script type="module" src="main.js"></script>',
        'main.js': 'let fetch = 1\nsetTimeout("fetch = a")',
      })

      // Only the declarations themselves (§3 Declarations in classic scripts).
      expect(fingerprints(script.report)).toEqual(['window|Window.alert|replace|unknown', 'window|Window.fetch|replace|unknown'])
      expect(fingerprints(module.report)).toEqual(['window|Window.fetch|replace|unknown'])
    })
  })

  describe('nested code in nested code', () => {
    test('is located through each literal in turn, with a note per level, outermost first', async () => {
      const code = 'function f(){ eval("setTimeout(\'window.fetch = a\')") }'
      const { report } = await scan(classic(code))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.generated).toEqual(at(code, 'window.fetch = a'))
      const notes = occurrence.trace.filter((step: { kind: string }) => step.kind === 'note')
      expect(notes).toEqual([
        { kind: 'note', about: 'nested-code', callee: 'eval', scope: 'caller', call: at(code, `eval("setTimeout('window.fetch = a')")`), text },
        {
          kind: 'note',
          about: 'nested-code',
          callee: 'setTimeout',
          scope: 'global',
          call: at(code, "setTimeout('window.fetch = a')"),
          text,
        },
      ])
    })
  })

  describe('locations', () => {
    test("are where each character of the code is written in the host, through the literal's escapes", async () => {
      const lines = [
        String.raw`eval("\x77indow.fetch = a")`,
        String.raw`eval("'\u{1F600}\101\0'; window.alert = b")`,
        'eval("x = 1;\\\nwindow.open = c")',
        String.raw`eval("x = 1\nwindow.print = d")`,
        'eval(`x = 1\r\nwindow.stop = e`)',
      ]
      const code = lines.join('\n')
      const { report } = await scan(classic(code))

      const located = Object.fromEntries(
        report.findings.map((finding: { target: { name: string }; occurrences: { generated: unknown }[] }) => [
          finding.target.name,
          finding.occurrences[0]!.generated,
        ]),
      )
      expect(located).toEqual({
        'Window.fetch': at(code, String.raw`\x77indow.fetch = a`),
        'Window.alert': at(code, 'window.alert = b'),
        'Window.open': at(code, 'window.open = c'),
        'Window.print': at(code, 'window.print = d'),
        // The template's CRLF is one LF in its code, and one line end in the host.
        'Window.stop': at(code, 'window.stop = e'),
      })
      expect(located['Window.open']).toMatchObject({ line: 4, column: 0 })
    })
  })
})

// Limitation records are shown here at the resolver seam (§19), as the resolver returns them. The completeness
// aggregator that sorts and counts them for the report is in test/completeness-report.test.ts.
describe.each(resolvers)('dynamic-code limitations, with %s behind the binding-resolution seam', (_, resolver) => {
  const catalog = loadCatalog()
  const analyze = (text: string, realm: Realm = 'window') => {
    const entry = {
      url: 'https://app.example/main.js',
      hash: 'sha256:test',
      sourceType: 'script' as const,
      realm,
      realmBasis: 'reference' as const,
    }
    return resolver.analyzeGroup({
      entry,
      artifact: (url) => (url === entry.url ? { ...entry, text } : undefined),
      catalog,
      budget: defaultBudget,
    })
  }
  const record = (code: string, part: string, from = 0) => ({
    kind: 'dynamic-code',
    artifact: { url: 'https://app.example/main.js', hash: 'sha256:test' },
    location: at(code, part, from),
    detail: expect.any(String),
  })

  test('a code string that may not be a literal is a dynamic-code record, located at the code string', () => {
    const code = [
      'eval(code)',
      'window.eval("x" + y)',
      'new Function(body)',
      'Function("a", "b", source.text)',
      'setTimeout("go(" + id + ")", 10)',
      'setInterval(`tick(${n})`)',
      'eval(...parts)',
      'function f(){ eval(s) }',
    ].join('\n')

    expect(analyze(code).limitations).toEqual([
      record(code, 'code'),
      record(code, '"x" + y'),
      record(code, 'body'),
      record(code, 'source.text'),
      record(code, '"go(" + id + ")"'),
      record(code, '`tick(${n})`'),
      record(code, '...parts'),
      record(code, 's', code.indexOf('eval(s)')),
    ])
  })

  test('a dynamic code string inside nested code is located inside its literal', () => {
    const code = 'setTimeout("eval(window.name)")'

    expect(analyze(code).limitations).toEqual([record(code, 'window.name')])
  })

  test('code that is a literal, a handler that is no string, and calls of no native are not dynamic code', () => {
    const code = [
      'eval("x = 1")',
      'eval()',
      'eval(42)',
      'eval(function(){})',
      'setTimeout(function(){}, 10)',
      'setTimeout(callback, 10)',
      'setInterval(() => tick())',
      'new Function("a", "return a")',
      'new Function()',
      'function f(eval){ eval(x) }',
      'o.eval(x)',
      'o.setTimeout("x" + y)',
    ].join('\n')

    expect(analyze(code).limitations).toEqual([])
  })

  test("a worker's string timer is its global object's inherited setTimeout", () => {
    const { occurrences } = analyze('self.setTimeout("Math.random = a")', 'dedicated-worker')

    expect(occurrences.map((occurrence) => occurrence.target)).toEqual([
      { realm: 'dedicated-worker', holder: 'namespace', name: 'Math.random' },
    ])
  })
})

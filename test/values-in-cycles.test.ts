// Values in cycles (§5 Resolver capabilities 4 and 5, §18 determinism): a memoized value or a heap write read while it
// is still being found reads `unknown` there, and whatever is found from that read is found again once it is done, so
// what the analyzer finds doesn't depend on the order it visits the code in. Every scenario goes through
// `monkeypatchlist scan --json`.

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

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

const targets = (report: { findings: Finding[] }): string[] => report.findings.map((finding: Finding) => finding.target.name)

describe.each(resolvers)('values in cycles, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test('a store a function writes and reads back gives the keys it writes', async () => {
    const { report } = await scan(
      lines(
        'var s = {}',
        'function w(n) { s[n] = c ? "open" : "send"; return s[n] }',
        'XMLHttpRequest.prototype[w("iterator")] = 1',
      ),
    )

    expect(targets(report)).toEqual(['XMLHttpRequest.prototype.open', 'XMLHttpRequest.prototype.send'])
  })

  test('a value read while it is being found is found again, whichever write is visited first', async () => {
    const store = ['var s = {}', 'function w(n) { s[n] = c ? "open" : "send"; return s[n] }']
    const writes = ['XMLHttpRequest.prototype[w("iterator")] = 1', 'Document.prototype[w("x")] = 1']
    const expected = [
      'Document.prototype.open',
      'Document.prototype.send',
      'XMLHttpRequest.prototype.open',
      'XMLHttpRequest.prototype.send',
    ]

    for (const code of [lines(...store, ...writes), lines(...writes.reverse(), ...store)]) {
      const { report } = await scan(code)

      expect(targets(report).sort()).toEqual(expected)
    }
  })

  test('a value read while it waits on one past the nesting cap is found again, whichever write is visited first', async () => {
    // Each field reads the next, a hundred deep, past the nesting cap, and the last reads the first back.
    const fields = ['var o = {}', 'o.a0 = c ? "open" : o.a1']
    for (let index = 1; index < 100; index++) fields.push(`o.a${index} = o.a${index + 1}`)
    fields.push('o.a100 = o.a0')
    const writes = ['XMLHttpRequest.prototype[o.a0] = 1', 'Document.prototype[o.a100] = 1']

    for (const code of [lines(...fields, ...writes), lines(...fields, ...writes.reverse())]) {
      const { report } = await scan(code)

      expect(targets(report).sort()).toEqual(['Document.prototype.open', 'XMLHttpRequest.prototype.open'])
    }
  })

  test('a class method that makes an instance runs with the instances of its class, not its generic one', async () => {
    // Finding the instances finds the frames of `run`, which no resolved call reaches, and those read the instances.
    const { report } = await scan(
      lines(
        'class T { constructor() {} }',
        'class C { constructor(w) { this.w = w } run() { new T(); this.w.fetch = function () {} } }',
        'new C(window)',
      ),
    )

    expect(targets(report)).toEqual(['Window.fetch'])
    const steps = report.findings[0].occurrences[0].trace.filter((step: Finding) => step.kind === 'creation-site')
    expect(steps.map((step: Finding) => step.this)).toEqual(['new C(window)'])
  })
  test('a call that passes a field its callee writes gives the field what the callee writes', async () => {
    // Finding `f`'s frames reads the argument `t.x`, whose writes are placed through `f`'s frames: webpack's
    // `r.call(e.exports, e, e.exports)` passes every CommonJS module the `exports` it assigns.
    const { report } = await scan(lines('function f(t, e) { t.x = XMLHttpRequest.prototype }', 'var t = {}', 'f(t, t.x)', 't.x.send = 1'))

    expect(targets(report)).toEqual(['XMLHttpRequest.prototype.send'])
  })

  test('a field its callee writes reads the same whichever is visited first', async () => {
    // The field is read before the call that writes it is visited, and after.
    for (const code of [
      lines('var t = {}', 't.x.send = 1', 'function f(t, e) { t.x = XMLHttpRequest.prototype }', 'f(t, t.x)'),
      lines('var t = {}', 'function f(t, e) { t.x = XMLHttpRequest.prototype }', 'f(t, t.x)', 't.x.open = 1', 't.x.send = 1'),
    ]) {
      const { report } = await scan(code)
      expect(targets(report).filter((name) => name.endsWith('.send'))).toEqual(['XMLHttpRequest.prototype.send'])
    }
  })
})

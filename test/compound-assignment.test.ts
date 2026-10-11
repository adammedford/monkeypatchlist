// Compound assignment folds (Principle 2, §5 Resolver capabilities 1 and 2): ECMA-262 evaluates `x op= y`
// as `x = x op y`, reading `x` before `y`, so a compound assignment of a variable folds like the plain assignment it
// abbreviates, for `+` and every numeric operator Principle 2 folds, on numbers and on BigInts. `??=`, `||=` and `&&=`
// keep their §7 meaning. zone.js's `patchTimer` (`setName += nameSuffix`) is the case that found it. Every scenario
// goes through `monkeypatchlist scan --json`.

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

const fingerprints = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.fingerprint)

describe.each(resolvers)('compound assignment, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test('s += x through parameters gives Window.setTimeout, as s = s + x does', async () => {
    const compound = await scan("function t(w, s, x){ s += x; w[s] = function(){} } t(window, 'set', 'Timeout')")
    const plain = await scan("function t(w, s, x){ s = s + x; w[s] = function(){} } t(window, 'set', 'Timeout')")

    expect(fingerprints(plain.report)).toEqual(['window|Window.setTimeout|replace|unknown'])
    expect(fingerprints(compound.report)).toEqual(fingerprints(plain.report))
  })

  test('the trace of s += x has the step kinds of s = s + x', async () => {
    const kinds = (report: { findings: Finding[] }) =>
      report.findings.map((finding) => finding.occurrences[0].trace.map((step: { kind: string }) => step.kind))
    const compound = await scan("function t(w, s, x){ s += x; w[s] = function(){} } t(window, 'set', 'Timeout')")
    const plain = await scan("function t(w, s, x){ s = s + x; w[s] = function(){} } t(window, 'set', 'Timeout')")

    expect(kinds(compound.report)).toEqual(kinds(plain.report))
  })

  test('-=, *=, /=, %=, **=, &=, |=, ^=, <<=, >>= and >>>= fold, on numbers and on BigInts', async () => {
    const { report } = await scan(
      lines(
        'var a = 9; a -= 2; Array.prototype[a] = f', // 7
        'var b = 2; b *= 3; Array.prototype[b] = f', // 6
        'var c = 9; c /= 3; Array.prototype[c] = f', // 3
        'var d = 7; d %= 4; Array.prototype[d] = f', // 3
        'var e = 2; e **= 3; Array.prototype[e] = f', // 8
        'var g = 12; g &= 10; Array.prototype[g] = f', // 8
        'var h = 12; h |= 3; Array.prototype[h] = f', // 15
        'var i = 6; i ^= 3; Array.prototype[i] = f', // 5
        'var j = 1; j <<= 4; Array.prototype[j] = f', // 16
        'var k = -32; k >>= 1; Array.prototype[k] = f', // -16
        'var l = -1; l >>>= 28; Array.prototype[l] = f', // 15
        'var m = 2n; m **= 5n; Array.prototype[m] = f', // 32
        'var n = 40n; n -= 1n; Array.prototype[n] = f', // 39
      ),
    )

    expect(report.findings.map((finding: Finding) => finding.target.name).sort()).toEqual(
      [
        'Array.prototype.-16',
        'Array.prototype.15',
        'Array.prototype.16',
        'Array.prototype.3',
        'Array.prototype.32',
        'Array.prototype.39',
        'Array.prototype.5',
        'Array.prototype.6',
        'Array.prototype.7',
        'Array.prototype.8',
      ].sort(),
    )
  })

  test('a compound assignment that throws folds to no value: 1n += 1 gives nothing (Principle 1)', async () => {
    const { report } = await scan('var a = 1n; a += 1; Array.prototype[a] = f')

    expect(report.findings).toEqual([])
  })

  test('the value of s += x itself folds: w[s += x] = f gives Window.setTimeout', async () => {
    const { report } = await scan("var s = 'set'; window[s += 'Timeout'] = function(){}")

    expect(fingerprints(report)).toEqual(['window|Window.setTimeout|replace|unknown'])
  })

  test('each += in a sequence reads the value before it: s += "Time"; s += "out" gives Window.setTimeout', async () => {
    const { report } = await scan("var s = 'set'; s += 'Time'; s += 'out'; window[s] = function(){}")

    expect(fingerprints(report)).toEqual(['window|Window.setTimeout|replace|unknown'])
  })

  test.each(['||', '&&', '??'])('k %s= "send" keeps its §7 meaning: it gives what the plain logical assignment gives', async (operator) => {
    const compound = await scan(`function g(k){ k ${operator}= "send"; XMLHttpRequest.prototype[k] = w } g(u)`)
    const plain = await scan(`function g(k){ k = k ${operator} "send"; XMLHttpRequest.prototype[k] = w } g(u)`)

    expect(fingerprints(compound.report)).toEqual(fingerprints(plain.report))
    expect(compound.report.findings.map((finding: Finding) => finding.target.name)).toContain('XMLHttpRequest.prototype.send')
  })
})

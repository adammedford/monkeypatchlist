// Numeric key folding and the `fold-length` scope (Principles 1, 2 and 5, §4 Property keys, §5 Resolver
// capabilities 1, §13 `analysis-budget`): every numeric operator folds constant operands as ECMA-262 does, BigInt
// literals are constants, and the result goes through ToPropertyKey; a key that throws folds to no value, and its write
// gives nothing; a BigInt too large to evaluate is a `fold-length` hit, judged before it is computed; and a `fold-length`
// hit raises `analysis-budget` only when the oversized fold is the key, holder or descriptor of a write that reaches the
// global object, a native holder or a native member. Every scenario goes through `monkeypatchlist scan --json`.

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

describe.each(resolvers)('numeric keys and the fold-length scope, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  describe('a BigInt literal is a constant, and names its string (§4 Property keys)', () => {
    test('Array.prototype[1n] = f, { 1n: f } and { [1n]: f } give Array.prototype.1, the fingerprint of [1] and ["1"]', async () => {
      const bigints = await scan(
        lines(
          'Array.prototype[1n] = f',
          'Object.assign(Array.prototype, { 1n: f })',
          'Object.assign(Array.prototype, { [1n]: f })',
        ),
      )
      const numbers = await scan(lines('Array.prototype[1] = f', 'Array.prototype["1"] = f'))

      expect(fingerprints(bigints.report)).toEqual(['window|Array.prototype.1|add|unknown'])
      expect(bigints.report.findings[0].occurrences).toHaveLength(3)
      expect(fingerprints(numbers.report)).toEqual(fingerprints(bigints.report))
    })
  })

  describe('every numeric operator folds constant operands as ECMA-262 does (Principle 2)', () => {
    test('-1 and ~0 give Array.prototype.-1, the fingerprint of "-1"', async () => {
      const folded = await scan(lines('Array.prototype[-1] = f', 'Array.prototype[~0] = f'))
      const string = await scan('Array.prototype["-1"] = f')

      expect(fingerprints(folded.report)).toEqual(['window|Array.prototype.-1|add|unknown'])
      expect(folded.report.findings[0].occurrences).toHaveLength(2)
      expect(fingerprints(string.report)).toEqual(fingerprints(folded.report))
    })

    test('+1 and 2-1 give Array.prototype.1, -0 gives Array.prototype.0, and 1/0 gives Array.prototype.Infinity', async () => {
      const { report } = await scan(
        lines('Array.prototype[+1] = f', 'Array.prototype[2-1] = f', 'Array.prototype[-0] = f', 'Array.prototype[1/0] = f'),
      )

      expect(fingerprints(report)).toEqual([
        'window|Array.prototype.0|add|unknown',
        'window|Array.prototype.1|add|unknown',
        'window|Array.prototype.Infinity|add|unknown',
      ])
      expect(report.findings[1].occurrences).toHaveLength(2)
    })

    test('*, %, **, &, |, ^, <<, >> and >>> fold, on numbers and on BigInts', async () => {
      const { report } = await scan(
        lines(
          'Array.prototype[2 * 3] = f', // 6
          'Array.prototype[7 % 4] = f', // 3
          'Array.prototype[2 ** 3] = f', // 8
          'Array.prototype[12 & 10] = f', // 8
          'Array.prototype[12 | 3] = f', // 15
          'Array.prototype[6 ^ 3] = f', // 5
          'Array.prototype[1 << 4] = f', // 16
          'Array.prototype[-32 >> 1] = f', // -16
          'Array.prototype[-1 >>> 28] = f', // 15
          'Array.prototype["3" * "2"] = f', // 6
          'Array.prototype[2n ** 3n - 1n] = f', // 7
          'Array.prototype[-(5n / 2n)] = f', // -2
          'Array.prototype[~1n << 2n] = f', // -8
          'Array.prototype["a" + 1n] = f', // a1
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Array.prototype.-16|add|unknown',
        'window|Array.prototype.-2|add|unknown',
        'window|Array.prototype.-8|add|unknown',
        'window|Array.prototype.15|add|unknown',
        'window|Array.prototype.16|add|unknown',
        'window|Array.prototype.3|add|unknown',
        'window|Array.prototype.5|add|unknown',
        'window|Array.prototype.6|add|unknown',
        'window|Array.prototype.7|add|unknown',
        'window|Array.prototype.8|add|unknown',
        'window|Array.prototype.a1|add|unknown',
      ])
    })

    test('Object.assign with { [-1]: f } and defineProperty with -1 give Array.prototype.-1 add', async () => {
      const { report } = await scan(
        lines(
          'Object.assign(Array.prototype, { [-1]: f })',
          'Object.defineProperty(Array.prototype, -1, { value: f })',
          'Object.defineProperty(Array.prototype, -1, d)',
          'Object.defineProperty(Array.prototype, 0, d)',
        ),
      )

      // An unseen descriptor gives for -1 what it gives for 0: an add.
      expect(fingerprints(report)).toEqual(['window|Array.prototype.-1|add|unknown', 'window|Array.prototype.0|add|unknown'])
      expect(report.findings[0].occurrences.map((occurrence: Finding) => occurrence.mechanism)).toEqual([
        'bulk-assign',
        'define-property',
        'define-property',
      ])
      const unseen = ({ effect, confidence }: Finding) => ({ effect, confidence })
      expect(unseen(report.findings[0])).toEqual(unseen(report.findings[1]))
      // The seen define adds a non-configurable property, which locks, and the most-locking occurrence wins (§8).
      expect(report.findings.map((finding: Finding) => finding.locks)).toEqual([true, 'unknown'])
    })
  })

  describe('a key that throws folds to no value, and its write gives nothing (Principle 1)', () => {
    test('1n + 1, +1n, 1n >>> 0n, 1n / 0n and 2n ** -1n give neither a finding nor a record', async () => {
      const { report } = await scan(
        lines(
          'Array.prototype[1n + 1] = f',
          'Array.prototype[+1n] = f',
          'Array.prototype[1n >>> 0n] = f',
          'Array.prototype[1n / 0n] = f',
          'Object.defineProperty(Array.prototype, 2n ** -1n, { value: f })',
          'Object.assign(Array.prototype, { [1n % 0n]: f })',
          'Array.prototype[1n - Symbol.iterator] = f',
        ),
      )

      expect(fingerprints(report)).toEqual([])
      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.level).toBe('complete')
    })
  })

  describe('an array-index write on Array.prototype gives only the add of the index member (§21)', () => {
    test('no Array.prototype.length finding comes with it', async () => {
      const { report } = await scan(
        lines(
          'Array.prototype[1n] = f',
          'Array.prototype[+1] = f',
          'Array.prototype[-0] = f',
          'Object.assign(Array.prototype, { 1n: f })',
          'Object.defineProperty(Array.prototype, 0, { value: f })',
        ),
      )

      expect(fingerprints(report)).toEqual(['window|Array.prototype.0|add|unknown', 'window|Array.prototype.1|add|unknown'])
    })
  })

  describe('a BigInt too large to evaluate is a fold-length hit, judged before it is computed (§5)', () => {
    const budget = (report: Finding) => report.completeness.limitations.filter((record: Finding) => record.kind === 'analysis-budget')

    test('Array.prototype[10n ** 2000000n] = f raises analysis-budget at the operator', async () => {
      const { report } = await scan('Array.prototype[10n ** 2000000n] = f')

      expect(fingerprints(report)).toEqual([])
      expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
      expect(budget(report)).toEqual([
        {
          kind: 'analysis-budget',
          artifact: expect.objectContaining({ url: 'https://app.example/main.js' }),
          location: expect.objectContaining({ line: 1, column: 16 }),
          detail: expect.any(String),
        },
      ])
      expect(report.completeness.level).toBe('complete-with-limitations')
    })

    test('an intermediate too large to evaluate makes the whole key unknown: (1n << 900000000n) % 7n', async () => {
      const started = Date.now()
      const { report } = await scan('Array.prototype[(1n << 900000000n) % 7n] = f')

      expect(fingerprints(report)).toEqual([])
      expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
      expect(budget(report)).toHaveLength(1)
      // 2^900000000 would take over 100 MB and a long time to compute.
      expect(Date.now() - started).toBeLessThan(5000)
    })

    test('a BigInt whose decimal string is at the cap is kept, and one digit more is a hit', async () => {
      // 10n ** 1048575n has 1,048,576 digits, 2^20; its negation has one more character.
      const { report } = await scan(lines('Array.prototype[10n ** 1048575n] = f', 'Array.prototype[-(10n ** 1048575n)] = f'))

      expect(report.findings).toHaveLength(1)
      expect(report.findings[0].target.name).toHaveLength('Array.prototype.'.length + 2 ** 20)
      expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
    })

    test('a BigInt literal is never capped', async () => {
      const digits = '9'.repeat(2 ** 20 + 1)
      const { report } = await scan(`Array.prototype[${digits}n] = f`)

      expect(report.findings).toHaveLength(1)
      expect(report.completeness.counters.statistics.caps).toEqual({})
      expect(report.completeness.limitations).toEqual([])
    })

    test("a result past V8's 2^30-bit limit throws, so 1n << 2000000000n gives nothing (Principle 1)", async () => {
      const { report } = await scan(
        lines('Array.prototype[1n << 2000000000n] = f', 'Array.prototype[2n ** 2000000000n] = f', 'Array.prototype[7n * (1n << 1073741824n)] = f'),
      )

      expect(fingerprints(report)).toEqual([])
      expect(report.completeness.counters.statistics.caps).toEqual({})
      expect(report.completeness.limitations).toEqual([])
    })
    test('at the limit, 2n ** 1073741824n throws and (-2n) ** 1073741823n, exactly 2^30 bits, is a hit', async () => {
      const past = await scan(lines('Array.prototype[2n ** 1073741824n] = f', 'Array.prototype[4n ** 536870912n] = f'))
      const at = await scan('Array.prototype[(-2n) ** 1073741823n] = f')

      expect(fingerprints(past.report)).toEqual([])
      expect(past.report.completeness.counters.statistics.caps).toEqual({})
      expect(past.report.completeness.limitations).toEqual([])
      expect(at.report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
      expect(budget(at.report)).toHaveLength(1)
    })
  })

  describe('a fold-length hit raises analysis-budget only where it cuts native work (Principle 5, §13)', () => {
    // s1 is 2 units long, and each constant doubles the last: s21, `huge`, is 2^21 units, past the cap.
    const doubling = ['const s0 = "x"', ...Array.from({ length: 21 }, (_, i) => `const s${i + 1} = s${i} + s${i}`)]
    const huge = (...code: string[]) => lines(...doubling, 'const huge = s21;', ...code)
    const budget = (report: Finding) => report.completeness.limitations.filter((record: Finding) => record.kind === 'analysis-budget')

    test('o[huge] = 1 on a user object is only counted', async () => {
      const { report } = await scan(huge('var o = {}; o[huge] = 1'))

      expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.level).toBe('complete')
    })

    test('Array.prototype[huge] = f still raises it, after the hit was counted for a user object', async () => {
      const { report } = await scan(huge('var o = {}; o[huge] = 1', 'Array.prototype[huge] = f'))

      expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
      // At the fold that passed the cap, in s21's initializer.
      expect(budget(report).map((record: Finding) => record.location.line)).toEqual([22])
      expect(report.completeness.level).toBe('complete-with-limitations')
    })

    for (const write of ['window[huge].x = f', 'Array.prototype[huge].y = f', 'Object.setPrototypeOf(document[huge], p)']) {
      test(`a write whose holder resolves to nothing only counts the hit: ${write}`, async () => {
        const { report } = await scan(huge(write))

        expect(fingerprints(report)).toEqual([])
        expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
        expect(report.completeness.limitations).toEqual([])
      })
    }

    for (const write of [
      'window[huge] = f',
      'frames[huge].fetch = f',
      'Array.prototype[window[huge]] = f',
      '(huge === s ? Array.prototype : o).x = f',
      'Object.defineProperty(Array.prototype, huge, { value: f })',
      'Object.defineProperty(Array.prototype, "x", { value: f, configurable: huge })',
      'Object.assign(Array.prototype, { [huge]: f })',
      'Reflect.set(o, huge, f, window)',
      'delete Array.prototype[huge]',
    ]) {
      test(`a write that resolves to a native, any alternative counting, raises it: ${write}`, async () => {
        const { report } = await scan(huge(write))

        expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
        expect(budget(report)).toHaveLength(1)
        expect(report.completeness.level).toBe('complete-with-limitations')
      })
    }

    test('a hit in the value written, not its key, holder or descriptor, is only counted', async () => {
      const { report } = await scan(huge('Array.prototype.x = o[huge]', 'window.y = huge + "!"'))

      // `huge` is one constant, whose hit counts once. The value `huge + "!"` is never evaluated.
      expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
      expect(report.completeness.limitations).toEqual([])
    })

    test('o[10n ** 2000000n] = 1 is only counted', async () => {
      const { report } = await scan('var o = {}; o[10n ** 2000000n] = 1')

      expect(report.completeness.counters.statistics.caps).toEqual({ 'fold-length': 1 })
      expect(report.completeness.limitations).toEqual([])
    })
  })

  test('the report is byte-identical across runs', async () => {
    const code = lines(
      'Array.prototype[1n] = f; Array.prototype[-1] = f; Array.prototype[2n ** 3n - 1n] = f; Array.prototype[1n + 1] = f',
      'Array.prototype[10n ** 2000000n] = f; o[10n ** 2000001n] = 1',
    )
    const first = await scan(code)
    const second = await scan(code)

    const withoutRun = (text: string) => JSON.stringify({ ...JSON.parse(text), run: undefined })
    expect(withoutRun(first.stdout)).toBe(withoutRun(second.stdout))
  })
})

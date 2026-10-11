// Window.opener assigns follow the value (§3 What is a platform mutation, §4 Member data).
// HTML's `opener` setter redefines `opener` as an own data property holding the value for any value but `null`, as a
// `[Replaceable]` setter does. `null` is API use, a value shown to be non-null a `replace`, and a value that may be
// `null` a `replace` with `outcome-undecidable`, as writing back what the getter returns is. The
// catalog keeps the IDL `assign` kind `setter`. Every scenario goes through `monkeypatchlist scan --json`.

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

/**
 * Each finding's fingerprint, mutation confidence level and reasons, and per occurrence its mechanism and the parts of
 * `code` its `outcome-undecidable` evidence locates, if it has any.
 */
const outcomes = (code: string, report: { findings: Finding[] }) =>
  report.findings.map(({ fingerprint, confidence, occurrences }: Finding) => [
    fingerprint,
    confidence.mutation.level,
    confidence.mutation.reasons,
    occurrences.map(({ mechanism, trace }: Finding) => {
      const step = trace.find(({ reason }: Finding) => reason === 'outcome-undecidable')
      return [mechanism, step?.sites.map(({ start, end }: Finding) => code.slice(start, end))]
    }),
  ])

describe.each(resolvers)('Window.opener assigns follow the value, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test('null is API use, through a member, a bare name or a bulk assign', async () => {
    const { report } = await scan(
      lines('window.opener = null', 'opener = null', 'Object.assign(window, { opener: null })', 'self.opener ??= null'),
    )

    expect(report.findings).toEqual([])
  })

  test('a value shown to be non-null is a replace, with mutation confidence high', async () => {
    const code = lines(
      'window.opener = {}',
      'opener = window',
      'Object.assign(window, { opener: parent })',
      'self.opener = undefined',
      'window.opener += "x"',
    )
    const { report } = await scan(code)

    expect(outcomes(code, report)).toEqual([
      [
        'window|Window.opener|replace|unknown',
        'high',
        [],
        [
          ['assign', undefined],
          ['assign', undefined],
          ['bulk-assign', undefined],
          ['assign', undefined],
          ['assign', undefined],
        ],
      ],
    ])
    expect(report.findings[0].target).toEqual({ realm: 'window', holder: 'global', name: 'Window.opener' })
  })

  test('an unresolved value is a replace with outcome-undecidable, sited at the value', async () => {
    const code = lines('window.opener = f()', 'Object.assign(window, { get opener() { return g } })', 'opener = x ? null : {}')
    const { report } = await scan(code)

    expect(outcomes(code, report)).toEqual([
      [
        'window|Window.opener|replace|unknown',
        'medium',
        ['outcome-undecidable'],
        [
          ['assign', ['f()']],
          ['bulk-assign', ['get opener() { return g }']],
          ['assign', ['x ? null : {}']],
        ],
      ],
    ])
  })

  test("writing back what opener's getter returns is a replace with outcome-undecidable, since it may be null", async () => {
    const code = lines('window.opener = window.opener', 'Object.assign(window, { opener })')
    const { report } = await scan(code)

    expect(outcomes(code, report)).toEqual([
      [
        'window|Window.opener|replace|unknown',
        'medium',
        ['outcome-undecidable'],
        [
          ['assign', ['window.opener']],
          ['bulk-assign', ['opener']],
        ],
      ],
    ])
    const [occurrence] = report.findings[0].occurrences
    expect(occurrence.trace.map(({ kind }: Finding) => kind)).toContain('confidence-reason')
  })

  test("another window's opener follows the value too", async () => {
    const code = lines('parent.opener = null', 'top.opener = {}')
    const { report } = await scan(code)

    expect(outcomes(code, report)).toEqual([
      ['window|Window.opener|replace|unknown', 'high', [], [['assign', undefined]]],
    ])
    expect(report.findings[0].occurrences[0].realmInstance).toBe('other')
  })
})

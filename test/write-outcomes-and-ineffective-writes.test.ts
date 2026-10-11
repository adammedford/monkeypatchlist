// Write outcomes and ineffective writes (§3 Ineffective writes, §9 Mutation confidence, §14): each occurrence's
// outcome is decided by the outcome table against the unmutated catalog. A write that can't change its target is an
// ineffective write, never a finding: it is listed in the scan-level `ineffectiveWrites[]`, one record per
// `(realm, target, reason)`, whose occurrences each carry their effect, mechanism, strictness and `throws`. Every
// scenario goes through `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

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
type Report = any

/** Each record as `target|reason`, with its occurrences as `effect mechanism strictness throws`, in report order. */
const records = (report: Report): [string, string[]][] =>
  report.ineffectiveWrites.map((record: Report) => [
    `${record.target.name}|${record.reason}`,
    record.occurrences.map(
      (occurrence: Report) =>
        `${occurrence.effect} ${occurrence.mechanism} ${occurrence.strictness} ${occurrence.throws}`,
    ),
  ])

/** Each finding's fingerprint, in report order. */
const fingerprints = (report: Report): string[] => report.findings.map((finding: Report) => finding.fingerprint)

describe.each(resolvers)('write outcomes, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe('one fixture per reason', () => {
    test('non-writable: `Math.PI = 3` is an ineffective write, never a finding', async () => {
      const { report } = await scan(classic('Math.PI = 3'))

      expect(report.findings).toEqual([])
      expect(report.summary.ineffectiveWrites).toBe(1)
      expect(report.ineffectiveWrites).toMatchObject([
        {
          target: { realm: 'window', holder: 'namespace', name: 'Math.PI' },
          reason: 'non-writable',
          occurrences: [
            {
              artifact: { url: 'https://app.example/main.js', origin: 'local-build' },
              generated: { line: 1, column: 0 },
              attribution: { key: 'unknown', provenance: 'unknown' },
              effect: 'replace',
              mechanism: 'assign',
              strictness: 'sloppy',
              throws: 'strict-only',
            },
          ],
        },
      ])
      expect(report.ineffectiveWrites[0]).not.toHaveProperty('fingerprint')
      expect(report.ineffectiveWrites[0]).not.toHaveProperty('baselineState')
      expect(report.ineffectiveWrites[0]).not.toHaveProperty('effect')
    })

    test('readonly: `navigator.userAgent = x` and `localStorage.length = 5`, named on the object written', async () => {
      const { report } = await scan(classic(lines("navigator.userAgent = 'x'", 'localStorage.length = 5')))

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        ['localStorage.length|readonly', ['replace assign sloppy strict-only']],
        ['navigator.userAgent|readonly', ['replace assign sloppy strict-only']],
      ])
      expect(report.ineffectiveWrites.map((record: Report) => record.target)).toEqual([
        { realm: 'window', holder: 'instance', name: 'localStorage.length', shadows: 'Storage.prototype.length' },
        { realm: 'window', holder: 'instance', name: 'navigator.userAgent', shadows: 'Navigator.prototype.userAgent' },
      ])
    })

    test('lenient-setter: an assign to a [LegacyLenientSetter] attribute never throws', async () => {
      const { report } = await scan(classic(lines('document.fullscreen = true', "(function () { 'use strict'; document.fullscreen = true })()")))

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        ['document.fullscreen|lenient-setter', ['replace assign sloppy never', 'replace assign strict never']],
      ])
    })

    test('non-configurable: redefining a constant', async () => {
      const { report } = await scan(
        classic(lines("Object.defineProperty(Node, 'ELEMENT_NODE', { value: {} })", "Reflect.defineProperty(Math, 'E', { value: {} })")),
      )

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        ['Math.E|non-configurable', ['replace reflect-define sloppy never']],
        ['Node.ELEMENT_NODE|non-configurable', ['replace define-property sloppy always']],
      ])
    })

    test('immutable-prototype: `setPrototypeOf(window, …)` and `window.__proto__ = x`', async () => {
      const { report } = await scan(
        classic(lines('Object.setPrototypeOf(window, {})', 'window.__proto__ = {}', 'Reflect.setPrototypeOf(window, {})')),
      )

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([
        [
          'Window.[[Prototype]]|immutable-prototype',
          [
            'prototype-change set-prototype sloppy always',
            'prototype-change set-prototype sloppy always',
            'prototype-change set-prototype sloppy never',
          ],
        ],
      ])
    })
  })

  describe('these are real mutations, not ineffective writes', () => {
    test('a define of a configurable accessor, setPrototypeOf of a singleton, and writes onto WindowProperties', async () => {
      const { report } = await scan(
        classic(
          lines(
            "Object.defineProperty(navigator, 'userAgent', { get: function () { return 'x' } })",
            'Object.setPrototypeOf(localStorage, {})',
            'var WP = Object.getPrototypeOf(Window.prototype)',
            'WP.addEventListener = w',
            "Object.defineProperty(WP, 'removeEventListener', { value: w })",
          ),
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|WindowProperties.addEventListener|replace|unknown',
        'window|WindowProperties.removeEventListener|replace|unknown',
        'window|localStorage.[[Prototype]]|prototype-change|unknown',
        'window|navigator.userAgent|descriptor-change|unknown',
      ])
      expect(report.ineffectiveWrites).toEqual([])
      expect(report.summary.ineffectiveWrites).toBe(0)
    })
  })

  test('a `=` that works only because an earlier defineProperty made the member writable is still ineffective', async () => {
    const { report } = await scan(
      classic(lines("Object.defineProperty(navigator, 'userAgent', { value: 'a', writable: true })", "navigator.userAgent = 'b'")),
    )

    expect(fingerprints(report)).toEqual(['window|navigator.userAgent|replace|unknown'])
    expect(records(report)).toEqual([['navigator.userAgent|readonly', ['replace assign sloppy strict-only']]])
  })

  test('strictness and `throws` are recorded, and the code after a throwing write is still analyzed', async () => {
    const { report } = await scan(
      classic(lines("'use strict'", 'Math.PI = 3', 'delete Math.PI', 'Reflect.deleteProperty(Math, "PI")', 'window.fetch = w')),
    )

    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(records(report)).toEqual([
      ['Math.PI|non-configurable', ['delete delete strict strict-only', 'delete delete strict never']],
      ['Math.PI|non-writable', ['replace assign strict strict-only']],
    ])
  })

  test('each decision is an `outcome` trace step, after the binding steps', async () => {
    const { report } = await scan(classic('Math.PI = 3'))

    const [occurrence] = report.ineffectiveWrites[0].occurrences
    expect(occurrence.trace.map(({ kind }: Report) => kind)).toEqual(['binding', 'outcome'])
    expect(occurrence.trace.at(-1)).toMatchObject({
      kind: 'outcome',
      result: 'ineffective',
      reason: 'non-writable',
      throws: 'strict-only',
      mayChangeNothing: false,
    })
  })

  test('an undecidable write stays a finding with outcome-undecidable', async () => {
    const { report } = await scan(classic("Object.defineProperty(window, 'fetch', d)"))

    expect(fingerprints(report)).toEqual(['window|Window.fetch|descriptor-change|unknown'])
    expect(report.findings[0].confidence.mutation).toEqual({ level: 'medium', reasons: ['outcome-undecidable'] })
    expect(report.ineffectiveWrites).toEqual([])
  })

  describe('the ineffective-write records of an immutable prototype and of non-writable members', () => {
    test.each([
      ['Object.setPrototypeOf(Window.prototype, {})', 'Window.prototype.[[Prototype]]|immutable-prototype', 'always'],
      ['String.prototype.length = 1', 'String.prototype.length|non-writable', 'strict-only'],
      ['location.valueOf = f', 'location.valueOf|non-writable', 'strict-only'],
    ])('`%s` gives a %s record', async (code, record, throws) => {
      const { report } = await scan(classic(code))

      expect(report.findings).toEqual([])
      expect(report.ineffectiveWrites.map((each: Report) => `${each.target.name}|${each.reason}`)).toEqual([record])
      expect(report.ineffectiveWrites[0].occurrences.map((each: Report) => each.throws)).toEqual([throws])
    })
  })

  test("Reflect.set({}, '__proto__', x, window) is window.__proto__ = x; with an unresolved lookup object, nothing", async () => {
    const { report } = await scan(
      classic(lines("Reflect.set({}, '__proto__', x, window)", 'window.__proto__ = x', "Reflect.set(o, '__proto__', x, window)")),
    )

    expect(report.findings).toEqual([])
    expect(records(report)).toEqual([
      [
        'Window.[[Prototype]]|immutable-prototype',
        ['prototype-change set-prototype sloppy always', 'prototype-change set-prototype sloppy always'],
      ],
    ])
  })

  test('define, setPrototypeOf and __proto__ writes that throw in sloppy and strict code alike record `always`', async () => {
    const { report } = await scan(
      classic(
        lines(
          "Object.defineProperty(Math, 'PI', { value: {} })",
          'Object.setPrototypeOf(window, {})',
          'window.__proto__ = {}',
          'Object.setPrototypeOf(location, {})',
        ),
      ),
    )

    expect(report.ineffectiveWrites.map((each: Report) => [each.target.name, each.occurrences.map((o: Report) => o.throws)])).toEqual([
      ['Math.PI', ['always']],
      ['Window.[[Prototype]]', ['always', 'always']],
      ['location.[[Prototype]]', ['always']],
    ])
  })

  describe('a write that is either a no-op or ineffective, on a value the analyzer can’t see, is ineffective', () => {
    test.each([
      ["Object.defineProperty(Math, 'PI', d)", 'Math.PI|non-configurable', 'always'],
      ["Object.defineProperty(window, 'document', d)", 'Window.document|non-configurable', 'always'],
      ["Object.defineProperty(Math, 'PI', { value: v })", 'Math.PI|non-configurable', 'always'],
      ["Reflect.defineProperty(Math, 'PI', d)", 'Math.PI|non-configurable', 'never'],
      ['Object.setPrototypeOf(window, p)', 'Window.[[Prototype]]|immutable-prototype', 'always'],
      ['Reflect.setPrototypeOf(window, p)', 'Window.[[Prototype]]|immutable-prototype', 'never'],
      ['window.__proto__ = p', 'Window.[[Prototype]]|immutable-prototype', 'always'],
    ])('`%s` gives one %s record, throws %s, and an outcome step saying it may change nothing', async (code, record, throws) => {
      const { report } = await scan(classic(code))

      expect(report.findings).toEqual([])
      expect(report.summary.ineffectiveWrites).toBe(1)
      expect(report.ineffectiveWrites.map((each: Report) => `${each.target.name}|${each.reason}`)).toEqual([record])
      const [occurrence] = report.ineffectiveWrites[0].occurrences
      expect(occurrence.throws).toBe(throws)
      expect(occurrence.trace.at(-1)).toMatchObject({ kind: 'outcome', mayChangeNothing: true })
    })

    test('a define whose value is a fresh object is plainly refused, and a define of the same attributes changes nothing', async () => {
      const { report } = await scan(
        classic(
          lines(
            "Object.defineProperty(Math, 'PI', { value: {} })",
            "Object.defineProperty(Math, 'PI', { enumerable: false })",
            'Object.setPrototypeOf(window, Window.prototype)',
          ),
        ),
      )

      expect(report.findings).toEqual([])
      expect(records(report)).toEqual([['Math.PI|non-configurable', ['replace define-property sloppy always']]])
      expect(report.ineffectiveWrites[0].occurrences[0].trace.at(-1)).toMatchObject({ mayChangeNothing: false })
    })
  })

  test('a refused define intends the effect it would have on a configurable member: attributes alone are a descriptor-change', async () => {
    const { report } = await scan(
      classic(
        lines(
          "Object.defineProperty(window, 'document', { enumerable: false })",
          "Object.defineProperty(Math, 'PI', { value: Math.PI, enumerable: true })",
          "Object.defineProperty(window, 'top', { value: {} })",
        ),
      ),
    )

    expect(report.findings).toEqual([])
    expect(records(report)).toEqual([
      ['Math.PI|non-configurable', ['descriptor-change define-property sloppy always']],
      ['Window.document|non-configurable', ['descriptor-change define-property sloppy always']],
      ['Window.top|non-configurable', ['replace define-property sloppy always']],
    ])
  })

  test('one record per (realm, target, reason), with effect and mechanism on each occurrence', async () => {
    const { report } = await scan(classic(lines('delete Math.PI', "Object.defineProperty(Math, 'PI', { value: 3 })")))

    expect(records(report)).toEqual([
      ['Math.PI|non-configurable', ['delete delete sloppy strict-only', 'replace define-property sloppy always']],
    ])
    expect(report.summary.ineffectiveWrites).toBe(1)
  })
})

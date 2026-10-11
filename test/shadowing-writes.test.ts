// Shadowing writes (§3 Shadowing writes, §4 naming rules, ADR 0002): an own-property write that shadows an inherited
// member is named after the object written, with a derived `shadows` naming the inherited member, which is not
// identity. Every scenario goes through `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

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

/** Each finding's fingerprint and target, in report order. */
const findings = (report: Report): [string, Report][] =>
  report.findings.map((finding: Report) => [finding.fingerprint, finding.target])

const target = (holder: string, name: string, shadows?: string) => ({
  realm: 'window',
  holder,
  name,
  ...(shadows === undefined ? {} : { shadows }),
})

describe.each(resolvers)('shadowing writes, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe('the examples of §3 and §4 are named on the object written, with the inherited member in `shadows`', () => {
    test('on the global object, a singleton, WindowProperties, and through a define with an unseen descriptor', async () => {
      const { report } = await scan(
        classic(
          lines(
            'window.addEventListener = w',
            'history.pushState = w',
            "Object.defineProperty(document, 'cookie', d)",
            'localStorage.setItem = f',
            'Object.getPrototypeOf(Window.prototype).addEventListener = w',
          ),
        ),
      )

      expect(findings(report)).toEqual([
        [
          'window|Window.addEventListener|replace|unknown',
          target('global', 'Window.addEventListener', 'EventTarget.prototype.addEventListener'),
        ],
        [
          'window|WindowProperties.addEventListener|replace|unknown',
          target('prototype', 'WindowProperties.addEventListener', 'EventTarget.prototype.addEventListener'),
        ],
        ['window|document.cookie|descriptor-change|unknown', target('instance', 'document.cookie', 'Document.prototype.cookie')],
        ['window|history.pushState|replace|unknown', target('instance', 'history.pushState', 'History.prototype.pushState')],
        ['window|localStorage.setItem|replace|unknown', target('instance', 'localStorage.setItem', 'Storage.prototype.setItem')],
      ])
    })

    test('a define over an inherited member with an unseen descriptor has locks unknown and no outcome-undecidable', async () => {
      // §3 Undecidable outcomes: a define on an object that only inherits the member can't be refused.
      const { report } = await scan(classic("Object.defineProperty(document, 'cookie', d)"))

      const [finding] = report.findings
      expect(finding.locks).toBe('unknown')
      expect(finding.confidence.mutation).toEqual({ level: 'high', reasons: [] })
      expect(finding.occurrences[0].trace.map(({ kind }: Report) => kind)).not.toContain('confidence-reason')
    })

    test('a define over an inherited member whose own value follows every unseen part is a replace', async () => {
      // §3 Undecidable outcomes and ADR 0011: the new own property holds the value, and the define can't be refused.
      const { report } = await scan(classic("Object.defineProperty(document, 'cookie', { ...d, value: v })"))

      expect(findings(report)).toEqual([
        ['window|document.cookie|replace|unknown', target('instance', 'document.cookie', 'Document.prototype.cookie')],
      ])
      const [finding] = report.findings
      expect(finding.locks).toBe('unknown')
      expect(finding.confidence.mutation).toEqual({ level: 'high', reasons: [] })
    })

    test('document.createElement = w shadows Document.prototype.createElement, past HTMLDocument.prototype', async () => {
      const { report } = await scan(classic('document.createElement = w'))

      expect(findings(report)).toEqual([
        [
          'window|document.createElement|replace|unknown',
          target('instance', 'document.createElement', 'Document.prototype.createElement'),
        ],
      ])
    })
  })

  describe('`shadows` is not identity', () => {
    test('the fingerprint and target key never include it', async () => {
      const { report } = await scan(classic(lines('history.pushState = w', 'window.addEventListener = w')))

      for (const finding of report.findings) {
        expect(finding.fingerprint).not.toContain(finding.target.shadows)
        expect(finding.targetKey).not.toContain(finding.target.shadows)
      }
      expect(report.findings.map((finding: Report) => finding.fingerprint)).toEqual([
        'window|Window.addEventListener|replace|unknown',
        'window|history.pushState|replace|unknown',
      ])
    })
  })

  describe('expandos, Storage data and deletes through an inheriting object give nothing', () => {
    test('window.foo = 1 and localStorage.foo = "bar"', async () => {
      const { report } = await scan(classic(lines('window.foo = 1', "localStorage.foo = 'bar'", "Object.defineProperty(history, 'zz', d)")))

      expect(report.findings).toEqual([])
    })

    test('delete localStorage.setItem and delete history.pushState', async () => {
      const { report } = await scan(
        classic(lines('delete localStorage.setItem', 'delete history.pushState', "Reflect.deleteProperty(navigator, 'userAgent')")),
      )

      expect(report.findings).toEqual([])
      expect(report.ineffectiveWrites ?? []).toEqual([])
    })
  })

  describe("a member only the realm's ECMAScript tail supplies", () => {
    test('is shadowed by a write on a Web IDL prototype, constructor or namespace, console among them', async () => {
      const { report } = await scan(
        classic(
          lines(
            'XMLHttpRequest.prototype.toString = f',
            'XMLHttpRequest.call = f',
            'CSS.hasOwnProperty = f',
            'console.toString = f',
            'console.trace2 = f',
          ),
        ),
      )

      expect(findings(report)).toEqual([
        ['window|CSS.hasOwnProperty|replace|unknown', target('namespace', 'CSS.hasOwnProperty', 'Object.prototype.hasOwnProperty')],
        ['window|XMLHttpRequest.call|replace|unknown', target('constructor', 'XMLHttpRequest.call', 'Function.prototype.call')],
        [
          'window|XMLHttpRequest.prototype.toString|replace|unknown',
          target('prototype', 'XMLHttpRequest.prototype.toString', 'Object.prototype.toString'),
        ],
        ['window|console.toString|replace|unknown', target('namespace', 'console.toString', 'Object.prototype.toString')],
        ['window|console.trace2|add|unknown', target('namespace', 'console.trace2')],
      ])
    })

    test('is an expando on a singleton or the global object, by any mechanism', async () => {
      const { report } = await scan(
        classic(
          lines(
            'window.toString = f',
            'localStorage.toString = f',
            "Object.defineProperty(history, 'hasOwnProperty', { value: f })",
            'Object.assign(navigator, { valueOf: f })',
          ),
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('ECMAScript holders shadow along their own chains', async () => {
      const { report } = await scan(classic(lines('Uint8Array.prototype.at = f', 'Array.prototype.hasOwnProperty = f', 'Promise.call = f')))

      expect(findings(report)).toEqual([
        [
          'window|Array.prototype.hasOwnProperty|replace|unknown',
          target('prototype', 'Array.prototype.hasOwnProperty', 'Object.prototype.hasOwnProperty'),
        ],
        ['window|Promise.call|replace|unknown', target('constructor', 'Promise.call', 'Function.prototype.call')],
        [
          'window|Uint8Array.prototype.at|replace|unknown',
          target('prototype', 'Uint8Array.prototype.at', '%TypedArray%.prototype.at'),
        ],
      ])
    })
  })

  describe('what a shadowing write does follows the inherited member and the new value (ADR 0011)', () => {
    test("an assign runs an inherited attribute's setter: API use on a singleton, ineffective when readonly", async () => {
      const { report } = await scan(
        classic(lines('document.title = t', "history.scrollRestoration = 'manual'", 'navigator.userAgent = u', 'history.go = history.go')),
      )

      expect(report.findings).toEqual([])
    })

    test('a define gives a replace for a new value, a descriptor-change for an accessor or new attributes', async () => {
      const { report } = await scan(
        classic(
          lines(
            "Object.defineProperty(navigator, 'userAgent', { get(){ return ua } })",
            "Object.defineProperty(navigator, 'vendor', { value: navigator.vendor })",
            "Object.defineProperty(navigator, 'language', { configurable: true })",
            "Object.defineProperty(history, 'back', { value: b })",
            "Object.defineProperty(history, 'forward', { value: history.forward, writable: true, enumerable: true, configurable: true })",
            "Object.defineProperty(history, 'go', { value: history.go })",
          ),
        ),
      )

      // A getter is a descriptor-change. A data property over an accessor, or one holding `undefined`, is a new value.
      // The inherited operation's own value with its attributes changes nothing; with other attributes, they change.
      expect(report.findings.map((finding: Report) => [finding.fingerprint, finding.target.shadows])).toEqual([
        ['window|history.back|replace|unknown', 'History.prototype.back'],
        ['window|history.go|descriptor-change|unknown', 'History.prototype.go'],
        ['window|navigator.language|replace|unknown', 'Navigator.prototype.language'],
        ['window|navigator.userAgent|descriptor-change|unknown', 'Navigator.prototype.userAgent'],
        ['window|navigator.vendor|replace|unknown', 'Navigator.prototype.vendor'],
      ])
    })

    test('a Reflect.set whose lookup object resolves writes its receiver as [[Set]] does', async () => {
      const { report } = await scan(classic("Reflect.set(History.prototype, 'replaceState', f, history)"))

      expect(findings(report)).toEqual([
        [
          'window|history.replaceState|replace|unknown',
          target('instance', 'history.replaceState', 'History.prototype.replaceState'),
        ],
      ])
    })
  })

  test('in a worker, self.fetch = w is named on the realm global interface', async () => {
    const { report } = await scan({
      'index.html': '<script>new Worker("worker.js")</script>',
      'worker.js': 'self.fetch = w',
    })

    expect(report.findings.map((finding: Report) => finding.target)).toEqual([
      {
        realm: 'dedicated-worker',
        holder: 'global',
        name: 'DedicatedWorkerGlobalScope.fetch',
        shadows: 'WorkerGlobalScope.prototype.fetch',
      },
    ])
  })
})

describe('determinism (§15)', () => {
  test('two scans of a build of shadowing writes give byte-identical reports, except run', async () => {
    const files = classic(
      lines('history.pushState = w', "Object.defineProperty(document, 'cookie', d)", 'XMLHttpRequest.prototype.toString = f'),
    )
    const first = await scanBuild(files)
    const second = await scanBuild(files)

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
    expect(first.report.findings).toHaveLength(3)
  })
})

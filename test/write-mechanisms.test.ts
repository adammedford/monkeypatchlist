// Write mechanisms and effects (§3 Mechanisms, §8 Effect and mechanism, ADR 0011): every way code writes a native
// member, the mechanism each occurrence records, and the effect, which follows the member's new value. Every scenario
// goes through `monkeypatchlist scan --json`. `declare`, `wrap` and ineffective writes have tests of their own.

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

/** Each finding's fingerprint, with the mechanism of each of its occurrences, in report order. */
const mechanisms = (report: { findings: Finding[] }): [string, string[]][] =>
  report.findings.map((finding) => [
    finding.fingerprint,
    finding.occurrences.map((occurrence: { mechanism: string }) => occurrence.mechanism),
  ])

describe.each(resolvers)('write mechanisms, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  describe('each mechanism', () => {
    // One fixture per mechanism (§3): the target, the effect and the mechanism its occurrence records. `declare` has
    // tests of its own.
    const cases: [string, string, string][] = [
      ['assign', 'window.fetch = f', 'window|Window.fetch|replace|unknown'],
      ['define-property', "Object.defineProperty(window, 'fetch', { value: f })", 'window|Window.fetch|replace|unknown'],
      [
        'define-properties',
        'Object.defineProperties(window, { fetch: { value: f, writable: true } })',
        'window|Window.fetch|replace|unknown',
      ],
      ['reflect-define', "Reflect.defineProperty(window, 'fetch', { value: f })", 'window|Window.fetch|replace|unknown'],
      ['bulk-assign', 'Object.assign(window, { fetch: f })', 'window|Window.fetch|replace|unknown'],
      ['delete', 'delete window.fetch', 'window|Window.fetch|delete|unknown'],
      [
        'set-prototype',
        'Object.setPrototypeOf(Storage.prototype, X)',
        'window|Storage.prototype.[[Prototype]]|prototype-change|unknown',
      ],
    ]

    test.each(cases)('%s: %s', async (mechanism, code, fingerprint) => {
      const { report } = await scan(code)

      expect(mechanisms(report)).toEqual([[fingerprint, [mechanism]]])
    })
  })

  describe('the mechanism is evidence, not identity', () => {
    test('the same mutation made with = and with defineProperty gives the same fingerprint', async () => {
      const { report } = await scan(lines('window.fetch = f', "Object.defineProperty(window, 'fetch', { value: g })"))

      expect(mechanisms(report)).toEqual([['window|Window.fetch|replace|unknown', ['assign', 'define-property']]])
    })

    test('so does an add made with =, a define and a bulk assign', async () => {
      const { report } = await scan(
        lines(
          'Array.prototype.last = f',
          "Object.defineProperty(Array.prototype, 'last', { value: f })",
          'Object.assign(Array.prototype, { last: f })',
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Array.prototype.last|add|unknown', ['assign', 'define-property', 'bulk-assign']],
      ])
    })
  })

  describe('define-property', () => {
    test("Object.defineProperty(window, 'fetch', { value: f }) is a replace", async () => {
      const { report } = await scan("Object.defineProperty(window, 'fetch', { value: f })")

      expect(mechanisms(report)).toEqual([['window|Window.fetch|replace|unknown', ['define-property']]])
    })

    test('a getter, a setter or both over a data property is a descriptor-change', async () => {
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'fetch', { get(){} })",
          "Object.defineProperty(window, 'alert', { set: function(v){} })",
          "Object.defineProperty(window, 'open', { get: g, set: s, configurable: true })",
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|descriptor-change|unknown',
        'window|Window.fetch|descriptor-change|unknown',
        'window|Window.open|descriptor-change|unknown',
      ])
    })

    test('an attribute-only change with the same value is a descriptor-change', async () => {
      // Window.fetch, Window.alert and Window.open are writable, enumerable and configurable data properties.
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'fetch', { enumerable: false })",
          "Object.defineProperty(window, 'alert', { value: window.alert, writable: !1 })",
          "Object.defineProperty(self, 'open', { value: open, enumerable: 0, configurable: !0 })",
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|descriptor-change|unknown',
        'window|Window.fetch|descriptor-change|unknown',
        'window|Window.open|descriptor-change|unknown',
      ])
    })

    test('a define that changes nothing, or is a TypeError, gives nothing', async () => {
      // The first two leave Window.fetch as it is. The last two are TypeErrors: a descriptor with both a value and a
      // getter, and one that is no object. Descriptors the analyzer can't see are in
      // test/writer-forms-and-unseen-descriptors.test.ts.
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'fetch', { configurable: true, enumerable: 1 })",
          "Object.defineProperty(window, 'fetch', { value: window.fetch })",
          "Object.defineProperty(window, 'focus', { value: f, get(){} })",
          "Object.defineProperty(window, 'open', 'descriptor')",
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('a method or computed key named __proto__ in a descriptor is an own field, not its prototype', async () => {
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'fetch', { __proto__(){}, value: f })",
          'Object.defineProperty(window, \'alert\', { ["__proto__"]: p, get(){} })',
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|descriptor-change|unknown',
        'window|Window.fetch|replace|unknown',
      ])
    })

    test('over an accessor, a data descriptor is a replace, and new accessors or attributes a descriptor-change', async () => {
      // Web IDL attributes are enumerable, configurable accessors.
      const { report } = await scan(
        lines(
          "Object.defineProperty(Document.prototype, 'cookie', { get(){ return c }, set(v){} })",
          "Object.defineProperty(Node.prototype, 'textContent', { value: 'x' })",
          "Object.defineProperty(Element.prototype, 'innerHTML', { enumerable: false })",
          "Object.defineProperty(Element.prototype, 'outerHTML', { writable: true })",
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Document.prototype.cookie|descriptor-change|unknown',
        'window|Element.prototype.innerHTML|descriptor-change|unknown',
        'window|Element.prototype.outerHTML|replace|unknown',
        'window|Node.prototype.textContent|replace|unknown',
      ])
    })

    test('a define or delete of a non-configurable member gives no finding: it is ineffective', async () => {
      const { report } = await scan(
        lines(
          "Object.defineProperty(Math, 'PI', { value: 3 })",
          "Object.defineProperty(window, 'document', { get(){} })",
          'delete Math.PI',
          'delete window.document',
          'delete window.top',
        ),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe('define-properties and bulk-assign', () => {
    test('each key is its own write, located at its property', async () => {
      const code = lines(
        'Object.defineProperties(window, { fetch: { value: f }, alert: { get(){} } })',
        'Object.assign(window, { open: f, stop: g })',
      )
      const { report } = await scan(code)

      const sites = report.findings.map((finding: Finding) => [
        finding.fingerprint,
        finding.occurrences.map(({ generated }: Finding) => code.slice(generated.start, generated.end)),
      ])
      expect(sites).toEqual([
        ['window|Window.alert|descriptor-change|unknown', ['alert: { get(){} }']],
        ['window|Window.fetch|replace|unknown', ['fetch: { value: f }']],
        ['window|Window.open|replace|unknown', ['open: f']],
        ['window|Window.stop|replace|unknown', ['stop: g']],
      ])
    })

    test('keys the syntax shows: literal sources, getters and methods; not spreads, other sources or __proto__', async () => {
      // The descriptors of `stop` and `focus` can't be seen, so each is a descriptor-change (§3 Undecidable outcomes).
      const { report } = await scan(
        lines(
          'Object.assign(window, { fetch: f }, sources, { ...more, get alert(){ return a }, open(){} }, { __proto__: p })',
          'Object.assign(window, ...sources)',
          'Object.defineProperties(window, { ...more, print: { value: f }, stop: d, get focus(){ return d } })',
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Window.alert|replace|unknown', ['bulk-assign']],
        ['window|Window.fetch|replace|unknown', ['bulk-assign']],
        ['window|Window.focus|descriptor-change|unknown', ['define-properties']],
        ['window|Window.open|replace|unknown', ['bulk-assign']],
        ['window|Window.print|replace|unknown', ['define-properties']],
        ['window|Window.stop|descriptor-change|unknown', ['define-properties']],
      ])
    })
  })

  describe('assign', () => {
    test('a key that folds to a constant string is the member it names, and one that does not gives nothing', async () => {
      // Folding and constant propagation: test/constants-and-folding.test.ts.
      const { report } = await scan(
        lines('window["fetch"] = a', 'window[`alert`] = b', 'window[k] = c', 'window["op" + "en"] = d'),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
      ])
    })

    test('writing back the value a member holds changes nothing', async () => {
      const { report } = await scan(
        lines('window.fetch = window.fetch', 'alert = self.alert', 'Array.prototype.map = Array.prototype.map'),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe('delete', () => {
    test('delete of a configurable native member, qualified or not, is a delete', async () => {
      const { report } = await scan(
        lines('delete window.fetch', 'delete self["alert"]', 'delete Array.prototype.map', 'delete open'),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Array.prototype.map|delete|unknown', ['delete']],
        ['window|Window.alert|delete|unknown', ['delete']],
        ['window|Window.fetch|delete|unknown', ['delete']],
        ['window|Window.open|delete|unknown', ['delete']],
      ])
    })
  })

  describe('set-prototype', () => {
    test('Object.setPrototypeOf, Reflect.setPrototypeOf and a __proto__ assignment change a holder’s prototype', async () => {
      const { report } = await scan(
        lines(
          'Object.setPrototypeOf(Storage.prototype, X)',
          'Reflect.setPrototypeOf(XMLHttpRequest, null)',
          'Math.__proto__ = X',
          'Array.prototype["__proto__"] = X',
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Array.prototype.[[Prototype]]|prototype-change|unknown', ['set-prototype']],
        ['window|Math.[[Prototype]]|prototype-change|unknown', ['set-prototype']],
        ['window|Storage.prototype.[[Prototype]]|prototype-change|unknown', ['set-prototype']],
        ['window|XMLHttpRequest.[[Prototype]]|prototype-change|unknown', ['set-prototype']],
      ])
      // The target is on the holder whose prototype changes, and takes the surface of its owner.
      expect(report.findings.map(({ target, surface }: Finding) => [target, surface])).toEqual([
        [{ realm: 'window', holder: 'prototype', name: 'Array.prototype.[[Prototype]]' }, 'ECMAScript'],
        [{ realm: 'window', holder: 'namespace', name: 'Math.[[Prototype]]' }, 'ECMAScript'],
        [{ realm: 'window', holder: 'prototype', name: 'Storage.prototype.[[Prototype]]' }, 'storage'],
        [{ realm: 'window', holder: 'constructor', name: 'XMLHttpRequest.[[Prototype]]' }, 'networking'],
      ])
    })

    test('an own __proto__ key in a bulk assign source goes through the __proto__ setter', async () => {
      // A computed key or a method named __proto__ is an own property of the literal, which Object.assign [[Set]]s on
      // the target. `__proto__: X` only gives the literal its prototype.
      const { report } = await scan(
        lines(
          'Object.assign(JSON, { ["__proto__"]: X })',
          'Object.assign(Reflect, { __proto__(){} })',
          'Object.assign(Math, { __proto__: X })',
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|JSON.[[Prototype]]|prototype-change|unknown', ['set-prototype']],
        ['window|Reflect.[[Prototype]]|prototype-change|unknown', ['set-prototype']],
      ])
    })

    test('an immutable prototype, the prototype a holder already has, or a value that is no object gives nothing', async () => {
      // Immutable prototypes are ineffective writes.
      const { report } = await scan(
        lines(
          'Object.setPrototypeOf(window, X)',
          'Object.setPrototypeOf(Object.prototype, X)',
          'Reflect.setPrototypeOf(EventTarget.prototype, X)',
          'window.__proto__ = X',
          '__proto__ = X',
          'Object.prototype.__proto__ = X',
          'Object.setPrototypeOf(Storage.prototype, Object.prototype)',
          'XMLHttpRequest.prototype.__proto__ = XMLHttpRequestEventTarget.prototype',
          'Array.prototype.__proto__ = 5',
          'var o = {}; o.__proto__ = X; Object.setPrototypeOf(o, X)',
        ),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe('the native writer functions', () => {
    test('are recognized through the global object and a comma callee, with their binding steps in the trace', async () => {
      const { report } = await scan(
        lines(
          "window.Object.defineProperty(self, 'fetch', { value: f });",
          "(0, Reflect.defineProperty)(window, 'alert', { value: f })",
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Window.alert|replace|unknown', ['reflect-define']],
        ['window|Window.fetch|replace|unknown', ['define-property']],
      ])
      const steps = report.findings.map((finding: Finding) =>
        finding.occurrences[0].trace.map(({ kind, name, form }: Finding) => [kind, name, form]),
      )
      expect(steps).toEqual([
        [
          ['binding', 'Reflect', 'global-property'],
          ['binding', 'window', 'global-name'],
        ],
        [
          ['binding', 'window', 'global-name'],
          ['binding', 'self', 'global-name'],
        ],
      ])
    })

    test('are recognized behind nested comma sequences', async () => {
      const { report } = await scan("(0, (0, Object.defineProperty))(window, 'fetch', { value: f })")

      expect(mechanisms(report)).toEqual([['window|Window.fetch|replace|unknown', ['define-property']]])
    })

    test('a local that shares their name is no native writer', async () => {
      const { report } = await scan(
        lines(
          "function a(Object){ Object.defineProperty(window, 'fetch', { value: f }) }",
          'function b(Reflect){ Reflect.setPrototypeOf(Storage.prototype, X) }',
          'var c = { assign: Object.assign }; c.assign(window, { alert: f })',
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('a with block around the native writer lowers target confidence, with its evidence', async () => {
      const { report } = await scan("with (o) { Object.defineProperty(window, 'fetch', { value: f }) }")

      const [finding] = report.findings
      expect(finding.confidence.target).toEqual({ level: 'low', reasons: ['with-scope'] })
      expect(finding.occurrences[0].trace.map(({ kind, name }: Finding) => [kind, name])).toEqual([
        ['binding', 'Object'],
        ['confidence-reason', 'Object'],
        ['binding', 'window'],
        ['confidence-reason', 'window'],
        ['guard', undefined],
      ])
    })
  })

  describe("the global object's inherited members (§3 Shadowing writes)", () => {
    test('a bulk assign shadows an inherited member as = does, with the same fingerprint', async () => {
      // Both are a [[Set]] on the global object, which creates an own property over EventTarget.prototype's member.
      const { report } = await scan(lines('window.addEventListener = a', 'Object.assign(window, { addEventListener: b })'))

      expect(mechanisms(report)).toEqual([['window|Window.addEventListener|replace|unknown', ['assign', 'bulk-assign']]])
      expect(report.findings[0].target).toEqual({
        realm: 'window',
        holder: 'global',
        name: 'Window.addEventListener',
        shadows: 'EventTarget.prototype.addEventListener',
      })
    })

    test('a define of an inherited member shadows it too, and a delete through the global object gives nothing', async () => {
      // A define always creates the own property. A delete through an object that only inherits the member changes no
      // native (§3).
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'addEventListener', { value: f })",
          'Object.defineProperties(window, { removeEventListener: { get(){} } })',
          'delete window.addEventListener',
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Window.addEventListener|replace|unknown', ['define-property']],
        ['window|Window.removeEventListener|descriptor-change|unknown', ['define-properties']],
      ])
      expect(report.findings.map(({ target }: Finding) => target.shadows)).toEqual([
        'EventTarget.prototype.addEventListener',
        'EventTarget.prototype.removeEventListener',
      ])
    })
  })

  describe('in nested code (§2)', () => {
    test('the writes a literal eval string makes are found, located in the host, after the nested-code note', async () => {
      const code = `eval("Object.defineProperty(window, 'fetch', { value: f }); Object.assign(window, { alert: g })")`
      const { report } = await scan(code)

      expect(mechanisms(report)).toEqual([
        ['window|Window.alert|replace|unknown', ['bulk-assign']],
        ['window|Window.fetch|replace|unknown', ['define-property']],
      ])
      const occurrences = report.findings.map(({ occurrences: [occurrence] }: Finding) => [
        code.slice(occurrence.generated.start, occurrence.generated.end),
        occurrence.trace.map(({ kind, name }: Finding) => [kind, name]),
      ])
      const trace = [
        ['note', undefined],
        ['binding', 'eval'],
        ['binding', 'Object'],
        ['binding', 'window'],
      ]
      expect(occurrences).toEqual([
        ['alert: g', trace],
        ["Object.defineProperty(window, 'fetch', { value: f })", trace],
      ])
    })
  })

  describe('add', () => {
    test('Array.prototype.last = f is an add, on the prototype holder', async () => {
      const { report } = await scan('Array.prototype.last = f')

      expect(mechanisms(report)).toEqual([['window|Array.prototype.last|add|unknown', ['assign']]])
      const [finding] = report.findings
      expect(finding.target).toEqual({ realm: 'window', holder: 'prototype', name: 'Array.prototype.last' })
      // A target the catalog doesn't list takes the surface of its holder's owner (§12 Surfaces and data).
      expect(finding.surface).toBe('ECMAScript')
    })

    test('a member added to a native prototype, constructor or namespace, by any mechanism', async () => {
      const { report } = await scan(
        lines(
          "Object.defineProperty(XMLHttpRequest.prototype, '__sdk_open', { value: f })",
          'Object.defineProperties(Promise, { any2: { get(){} } })',
          'Object.assign(Math, { clamp: f }, { lerp(){} })',
          "Reflect.defineProperty(console, 'trace2', { value: f })",
          'Storage.prototype["getObject"] = f',
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Math.clamp|add|unknown', ['bulk-assign']],
        ['window|Math.lerp|add|unknown', ['bulk-assign']],
        ['window|Promise.any2|add|unknown', ['define-properties']],
        ['window|Storage.prototype.getObject|add|unknown', ['assign']],
        ['window|XMLHttpRequest.prototype.__sdk_open|add|unknown', ['define-property']],
        ['window|console.trace2|add|unknown', ['reflect-define']],
      ])
      expect(report.findings.map(({ target, surface }: Finding) => [target.holder, surface])).toEqual([
        ['namespace', 'ECMAScript'],
        ['namespace', 'ECMAScript'],
        ['constructor', 'ECMAScript'],
        ['prototype', 'storage'],
        ['prototype', 'networking'],
        ['namespace', 'diagnostics'],
      ])
    })

    test('no add: new globals, singletons, inherited and structural members, user objects and deletes', async () => {
      // A new global is no finding (§3). A member the holder inherits makes a shadowing write, or an expando
      // (shadowing-writes.test.ts), and an inherited attribute's setter throws on a prototype. A constructor's
      // `length` and `name` are native, though not targets (§4), and a Web IDL interface object's `prototype` is a
      // non-writable target (its prototype's `constructor` is a writable one, so
      // `XMLHttpRequest.prototype.constructor = X` is a replace). Deleting a key that isn't native changes no native.
      const { report } = await scan(
        lines(
          'window.jQuery = $',
          'Object.assign(self, { webpackChunkapp: [] })',
          "Object.defineProperty(globalThis, '__sdk', { value: 1 })",
          'XMLHttpRequest.prototype.onload = f',
          'Storage.name = "S"',
          "Object.defineProperty(Array, 'length', { value: 2 })",
          'XMLHttpRequest.prototype = p',
          'var o = {}; o.last = f',
          'delete Array.prototype.last',
        ),
      )

      expect(report.findings).toEqual([])
    })
  })
})

describe('determinism (§15)', () => {
  test('two scans of copies of a build that writes by every mechanism give byte-identical reports, except run', async () => {
    const files = classic(
      lines(
        'window.fetch = a; Object.defineProperty(window, "alert", { get(){} })',
        'Object.defineProperties(Array.prototype, { last: { value: b }, first: { value: c } })',
        'Reflect.defineProperty(Element.prototype, "innerHTML", { enumerable: false })',
        'Object.assign(window, { open: d, addEventListener: e }); delete window.stop',
        'Object.setPrototypeOf(Storage.prototype, X); Math.__proto__ = Y',
      ),
    )

    const first = await scanBuild(files)
    const second = await scanBuild(files)

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
    expect(first.report.findings).toHaveLength(10)
  })
})

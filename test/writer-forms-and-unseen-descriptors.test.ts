// More writer forms and unseen descriptors (§3 Mechanisms, Undecidable outcomes). `Reflect.set` is an
// `assign` with the same [[Set]] rules, `Reflect.deleteProperty` is a `delete`, and `__defineGetter__` and
// `__defineSetter__` are a `define-property` of an enumerable, configurable accessor. A define whose descriptor the
// analyzer can't see is a `descriptor-change` of a catalog member, with `outcome-undecidable` where the outcome depends
// on the descriptor and `locks: unknown`, and an `add` of a member the catalog doesn't list. `Reflect.set(T, k, v, R)`
// writes R, and as if T's chain lacked k when T denotes no native holder. Every scenario goes through
// `monkeypatchlist scan --json`.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'
import { identityMappings, mappings } from './support/source-map.ts'
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

/**
 * Each finding's fingerprint, locks and mutation confidence level, and the parts of `code` that the evidence for its
 * first occurrence's `outcome-undecidable` locates, if it has any.
 */
const outcomes = (code: string, report: { findings: Finding[] }) =>
  report.findings.map(({ fingerprint, locks, confidence, occurrences: [occurrence] }: Finding) => {
    const step = occurrence.trace.find(({ dimension }: Finding) => dimension === 'mutation')
    const sites = step?.sites.map(({ start, end }: Finding) => code.slice(start, end))
    return [fingerprint, locks, confidence.mutation.level, sites]
  })

/** The copy-then-override idiom: a define of the native's own descriptor, with a new value. */
const copyThenOverride =
  "Object.defineProperty(XMLHttpRequest.prototype, 'send', " +
  "{ ...Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'send'), value: patched })"

/** Each finding's fingerprint, with the mechanism of each of its occurrences, in report order. */
const mechanisms = (report: { findings: Finding[] }): [string, string[]][] =>
  report.findings.map((finding) => [
    finding.fingerprint,
    finding.occurrences.map((occurrence: { mechanism: string }) => occurrence.mechanism),
  ])

describe.each(resolvers)('more writer forms and unseen descriptors, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  describe('Reflect.set is an assign, with the same [[Set]] rules', () => {
    // Each write as `=` spells it, and as Reflect.set spells it.
    const pairs: [string, string][] = [
      ['window.fetch = f', "Reflect.set(window, 'fetch', f)"],
      // API use: a setter attribute and an event handler run the attribute's setter.
      ['window.onerror = f', "Reflect.set(window, 'onerror', f)"],
      ['document.title = t', "Reflect.set(document, 'title', t)"],
      // A [[Set]] on the global object of a member it inherits shadows it.
      ['window.addEventListener = f', "Reflect.set(self, 'addEventListener', f)"],
      // [Replaceable] replaces the attribute with an own data property.
      ['window.length = 5', "Reflect.set(window, 'length', 5)"],
      ['Array.prototype.last = f', "Reflect.set(Array.prototype, 'last', f)"],
      ['XMLHttpRequest.prototype["se" + "nd"] = f', "Reflect.set(XMLHttpRequest.prototype, 'se' + 'nd', f)"],
      // Writing back the value a member holds changes nothing.
      ['window.alert = window.alert', "Reflect.set(window, 'alert', window.alert)"],
      ['Math.__proto__ = X', "Reflect.set(Math, '__proto__', X)"],
    ]

    test.each(pairs)('%s and its Reflect.set give the same findings', async (assign, reflect) => {
      const [byAssign, byReflect] = await Promise.all([scan(assign), scan(reflect)])

      const findings = ({ report }: { report: { findings: Finding[] } }) =>
        report.findings.map(({ fingerprint, target, surface, effect, locks }: Finding) => ({
          fingerprint,
          target,
          surface,
          effect,
          locks,
        }))
      expect(findings(byReflect)).toEqual(findings(byAssign))
      expect(mechanisms(byReflect.report)).toEqual(mechanisms(byAssign.report))
    })

    test('it is located at the call, with the binding steps of Reflect and the holder', async () => {
      const code = "Reflect.set(window, 'fetch', f)"
      const { report } = await scan(code)

      expect(mechanisms(report)).toEqual([['window|Window.fetch|replace|unknown', ['assign']]])
      const [occurrence] = report.findings[0].occurrences
      expect(code.slice(occurrence.generated.start, occurrence.generated.end)).toBe(code)
      expect(occurrence.trace.map(({ kind, name }: Finding) => [kind, name])).toEqual([
        ['binding', 'Reflect'],
        ['binding', 'window'],
      ])
    })

    test('a missing value sets undefined, and a key or holder that does not resolve gives nothing', async () => {
      const { report } = await scan(
        lines("Reflect.set(window, 'fetch')", 'Reflect.set(window, k, f)', "Reflect.set(o, 'alert', f)", 'Reflect.set(...args)'),
      )

      expect(mechanisms(report)).toEqual([['window|Window.fetch|replace|unknown', ['assign']]])
    })
  })

  describe('Reflect.set(T, k, v, R) follows [[Set]]: it writes R', () => {
    test('a receiver that is the same holder is T[k] = v, named on the receiver', async () => {
      const { report } = await scan(
        lines(
          "Reflect.set(window, 'fetch', f, window)",
          "Reflect.set(window, 'alert', f, self)",
          "Reflect.set(self, 'open', f, parent)",
          "Reflect.set(window, 'stop', parent.stop, parent)",
        ),
      )

      // `parent.stop` read back into `parent` changes nothing.
      expect(mechanisms(report)).toEqual([
        ['window|Window.alert|replace|unknown', ['assign']],
        ['window|Window.fetch|replace|unknown', ['assign']],
        ['window|Window.open|replace|unknown', ['assign']],
      ])
      expect(report.findings.map(({ occurrences: [occurrence] }: Finding) => occurrence.realmInstance)).toEqual([
        'current',
        'current',
        'other',
      ])
    })

    test('a receiver that does not resolve to a native holder gives nothing', async () => {
      const { report } = await scan(
        lines(
          "Reflect.set(window, 'fetch', f, receiver)",
          "Reflect.set(window, 'alert', f, ...rest)",
          "Reflect.set(window, 'open', f, 5)",
        ),
      )

      expect(report.findings).toEqual([])
    })

    test("another native holder is written when T's chain gives a writable data property, or none", async () => {
      // Math has no fetch, so Window's own fetch is replaced. Array.prototype has no last, so Math gets one. Math.max
      // is writable, and Array.prototype has no own max, so it gets one. Window only inherits addEventListener.
      const { report } = await scan(
        lines(
          "Reflect.set(Math, 'fetch', f, window)",
          "Reflect.set(Array.prototype, 'last', f, Math)",
          "Reflect.set(Math, 'max', f, Array.prototype)",
          "Reflect.set(Math, 'addEventListener', f, window)",
          "Reflect.set(Object.prototype, '__proto__', X, Math)",
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Array.prototype.max|add|unknown', ['assign']],
        ['window|Math.[[Prototype]]|prototype-change|unknown', ['set-prototype']],
        ['window|Math.last|add|unknown', ['assign']],
        ['window|Window.addEventListener|replace|unknown', ['assign']],
        ['window|Window.fetch|replace|unknown', ['assign']],
      ])
      expect(report.findings[3].target.shadows).toBe('EventTarget.prototype.addEventListener')
    })

    test("and nothing is written when T's member is not writable, or is an accessor that doesn't write R", async () => {
      // Math.PI is non-writable. Window's own onerror is an accessor, which [[Set]] leaves alone. Document's title
      // setter and Window's [Replaceable] length setter throw on a `this` that doesn't implement them. A new global is
      // no finding.
      const { report } = await scan(
        lines(
          "Reflect.set(Math, 'PI', 3, Array.prototype)",
          "Reflect.set(Math, 'onerror', f, window)",
          "Reflect.set(Document.prototype, 'title', t, Array.prototype)",
          "Reflect.set(window, 'length', 5, Math)",
          "Reflect.set(Math, 'max', f, window)",
        ),
      )

      expect(report.findings).toEqual([])
    })

    test("a [Replaceable] setter T's chain gives writes a receiver that implements its interface", async () => {
      // In a worker, `performance` is a [Replaceable] attribute of WorkerGlobalScope.prototype. Its setter, run with the
      // worker global as `this`, defines the global's own property, as `self.performance = p` does.
      const worker = (code: string) => ({ 'index.html': '<script>new Worker("worker.js")</script>', 'worker.js': code })
      const { report } = await scanBuild(
        worker(
          lines(
            "Reflect.set(WorkerGlobalScope.prototype, 'performance', p, self)",
            'self.performance = q',
            "Reflect.set(WorkerGlobalScope.prototype, 'performance', p, Math)",
          ),
        ),
        [],
        { deps: { resolver } },
      )

      expect(mechanisms(report)).toEqual([
        ['dedicated-worker|DedicatedWorkerGlobalScope.performance|replace|unknown', ['assign', 'assign']],
      ])
      expect(report.findings[0].target.shadows).toBe('WorkerGlobalScope.prototype.performance')
    })
  })

  describe("Reflect.set(T, k, v, R) with R resolved and T not: R is written as if T's chain lacked the member", () => {
    const undecidable = { level: 'medium', reasons: ['outcome-undecidable'] }

    test("R's own writable data property is a replace, with outcome-undecidable sited at T and locks: false", async () => {
      const code = "Reflect.set(o, 'fetch', f, window)"
      const { report } = await scan(code)

      expect(outcomes(code, report)).toEqual([['window|Window.fetch|replace|unknown', false, 'medium', ['o']]])
      const [finding] = report.findings
      expect(finding.confidence.mutation).toEqual(undecidable)
      const [occurrence] = finding.occurrences
      expect(occurrence.mechanism).toBe('assign')
      expect(occurrence.realmInstance).toBe('current')
      expect(occurrence.confidence.mutation).toEqual(undecidable)
      expect(code.slice(occurrence.generated.start, occurrence.generated.end)).toBe(code)
      // The binding steps of Reflect and R, then the evidence that T doesn't resolve.
      expect(occurrence.trace.map(({ kind, name, reason }: Finding) => [kind, name ?? reason])).toEqual([
        ['binding', 'Reflect'],
        ['binding', 'window'],
        ['confidence-reason', 'outcome-undecidable'],
      ])
    })

    test('an inherited Web IDL member of a global or prototype holder is a shadowing replace, and one an addable holder lacks an add', async () => {
      // Window only inherits addEventListener, and HTMLElement.prototype only inherits Element.prototype's remove.
      // Array.prototype has no last. A literal object, a call's result and a parameter all denote no native holder.
      const code = lines(
        "Reflect.set(o, 'addEventListener', f, window)",
        "Reflect.set({}, 'remove', f, HTMLElement.prototype)",
        "Reflect.set(make(), 'last', f, Array.prototype)",
        "function install(target) { Reflect.set(target, 'fetch', f, parent) }",
      )
      const { report } = await scan(code)

      expect(outcomes(code, report)).toEqual([
        ['window|Array.prototype.last|add|unknown', false, 'medium', ['make()']],
        ['window|HTMLElement.prototype.remove|replace|unknown', false, 'medium', ['{}']],
        ['window|Window.addEventListener|replace|unknown', false, 'medium', ['o']],
        ['window|Window.fetch|replace|unknown', false, 'medium', ['target']],
      ])
      expect(report.findings.map(({ target }: Finding) => target.shadows)).toEqual([
        undefined,
        'Element.prototype.remove',
        'EventTarget.prototype.addEventListener',
        undefined,
      ])
      // The receiver decides the window written.
      expect(report.findings[3].occurrences[0].realmInstance).toBe('other')
    })

    test("R's own accessor, a non-writable member, a write-back, a new global and a shadowing write give nothing", async () => {
      // Window's own onerror and Document.prototype's title are accessors, Math.PI is non-writable, and Window's own
      // fetch read back into it changes nothing. A new global is no finding. An own data property over an inherited
      // ECMAScript member (Object.prototype's hasOwnProperty, and its `__proto__` accessor) is a shadowing write, as `Array.prototype.hasOwnProperty = f` is.
      const { report } = await scan(
        lines(
          "Reflect.set(o, 'onerror', f, window)",
          "Reflect.set(o, 'title', t, Document.prototype)",
          "Reflect.set(o, 'PI', 3, Math)",
          "Reflect.set(o, 'fetch', window.fetch, window)",
          "Reflect.set(o, 'jQuery', f, window)",
          "Reflect.set(o, 'hasOwnProperty', f, Array.prototype)",
          "Reflect.set(o, '__proto__', p, window)",
          "Reflect.set(o, '__proto__', p, Math)",
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('a T that is plainly no object throws before any write, and gives nothing (Principle 1)', async () => {
      const { report } = await scan(
        lines(
          "Reflect.set(undefined, 'fetch', f, window)",
          "Reflect.set('x', 'fetch', f, window)",
          "Reflect.set(null, 'open', f, window)",
          "const n = 5; Reflect.set(n, 'alert', f, window)",
          "Reflect.set(c ? 1 : 'x', 'stop', f, window)",
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('a T that is a primitive in one alternative and any object in another is written as if it lacked the member', async () => {
      const code = "Reflect.set(c ? undefined : o, 'fetch', f, window)"
      const { report } = await scan(code)

      expect(outcomes(code, report)).toEqual([['window|Window.fetch|replace|unknown', false, 'medium', ['c ? undefined : o']]])
    })

    test('an unresolved R, or no R, or a key that does not fold, gives nothing', async () => {
      const { report } = await scan(
        lines("Reflect.set(o, 'fetch', f, receiver)", "Reflect.set(o, 'fetch', f)", "Reflect.set(o, k, f, window)"),
      )

      expect(report.findings).toEqual([])
    })

    test('a T that may be several native holders waits for candidate sets (§5), as `(c ? A : B).m = v` does', async () => {
      const { report } = await scan("Reflect.set(c ? Math : JSON, 'fetch', f, window)")

      expect(report.findings).toEqual([])
    })
  })

  describe('__defineGetter__ and __defineSetter__ define an enumerable, configurable accessor', () => {
    test("window.__defineGetter__('fetch', g) is a define-property descriptor-change on Window.fetch, located at the call", async () => {
      const code = "window.__defineGetter__('fetch', g)"
      const { report } = await scan(code)

      expect(mechanisms(report)).toEqual([['window|Window.fetch|descriptor-change|unknown', ['define-property']]])
      const [occurrence] = report.findings[0].occurrences
      expect(code.slice(occurrence.generated.start, occurrence.generated.end)).toBe(code)
      expect(report.findings[0].locks).toBe(false)
    })

    test('each gives the fingerprint the same define with Object.defineProperty gives', async () => {
      const { report } = await scan(
        lines(
          "window.__defineGetter__('fetch', g)",
          "Object.defineProperty(window, 'fetch', { get: g, enumerable: true, configurable: true })",
          "self.__defineSetter__('alert', s)",
          "Document.prototype.__defineGetter__('cookie', function(){ return c })",
          "Array.prototype['__define' + 'Setter__']('last', s)",
          "this.__defineGetter__('open', g)",
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Array.prototype.last|add|unknown', ['define-property']],
        ['window|Document.prototype.cookie|descriptor-change|unknown', ['define-property']],
        ['window|Window.alert|descriptor-change|unknown', ['define-property']],
        ['window|Window.fetch|descriptor-change|unknown', ['define-property', 'define-property']],
        ['window|Window.open|descriptor-change|unknown', ['define-property']],
      ])
    })

    test('no this, no native method, a non-callable accessor or a non-configurable member gives nothing', async () => {
      // A bare call, or one through a comma sequence, has no `this`, so ToObject throws. A local object is no holder. The
      // accessor must be callable. Math.PI can not be redefined (an ineffective write).
      const { report } = await scan(
        lines(
          "__defineGetter__('fetch', g)",
          "(0, window.__defineGetter__)('fetch', g)",
          "o.__defineGetter__('fetch', g)",
          "window.__defineGetter__('fetch', 5)",
          "window.__defineSetter__('alert')",
          "Math.__defineGetter__('PI', g)",
          "window.__defineGetter__(k, g)",
        ),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe('a define of a catalog member whose descriptor the analyzer can not see', () => {
    const undecidable = { level: 'medium', reasons: ['outcome-undecidable'] }

    test.each([
      ["Object.defineProperty(window, 'open', d)", 'd'],
      ["Object.defineProperty(window, 'open', { ...d })", '...d'],
      ["Object.defineProperty(window, 'open', { __proto__: p })", '__proto__: p'],
      ["Reflect.defineProperty(window, 'open', getDescriptor())", 'getDescriptor()'],
      ['Object.defineProperties(window, { open: d })', 'd'],
    ])(
      '%s is a Window.open descriptor-change, with outcome-undecidable and locks: unknown',
      async (code, unseen) => {
        const { report } = await scan(code)

        expect(fingerprints(report)).toEqual(['window|Window.open|descriptor-change|unknown'])
        const [finding] = report.findings
        expect(finding.locks).toBe('unknown')
        expect(finding.confidence.mutation).toEqual(undecidable)
        const [occurrence] = finding.occurrences
        expect(occurrence.confidence.mutation).toEqual(undecidable)
        // The evidence: a mutation confidence-reason step that locates the part of the descriptor it can't see.
        const step = occurrence.trace.at(-1)
        expect(step).toMatchObject({
          kind: 'confidence-reason',
          dimension: 'mutation',
          reason: 'outcome-undecidable',
          level: 'medium',
        })
        expect(step.sites.map(({ start, end }: Finding) => code.slice(start, end))).toEqual([unseen])
      },
    )

    test('over an accessor too, a Web IDL attribute', async () => {
      const { report } = await scan("Object.defineProperty(Document.prototype, 'cookie', d)")

      expect(fingerprints(report)).toEqual(['window|Document.prototype.cookie|descriptor-change|unknown'])
      expect(report.findings[0].locks).toBe('unknown')
    })

    test('a data descriptor with a new value is a replace: { __proto__: null, value: f } and { get value(){…} }', async () => {
      const code = lines(
        "Object.defineProperty(window, 'fetch', { __proto__: null, value: f })",
        "Object.defineProperty(window, 'open', { get value(){ return f } })",
        "Object.defineProperty(window, 'alert', { __proto__: 0, value: f })",
      )
      const { report } = await scan(code)

      expect(outcomes(code, report)).toEqual([
        ['window|Window.alert|replace|unknown', false, 'high', undefined],
        ['window|Window.fetch|replace|unknown', false, 'high', undefined],
        ['window|Window.open|replace|unknown', false, 'high', undefined],
      ])
    })

    test('a __proto__ field that folds to null sets no prototype, and the trace shows the fold', async () => {
      const { report } = await scan(lines('const P = null', "Object.defineProperty(window, 'fetch', { __proto__: P, value: f })"))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(report.findings[0].confidence.mutation.level).toBe('high')
      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.trace.filter(({ kind }: Finding) => kind === 'fold')).toMatchObject([
        { kind: 'fold', name: 'P', value: null },
      ])
    })

    test('an own value after every spread, not read from the same slot, is a replace with outcome-undecidable', async () => {
      const code = lines(
        copyThenOverride,
        "Object.defineProperty(window, 'fetch', { __proto__: p, value: f })",
        "Object.defineProperty(window, 'open', { ...a, enumerable: false, ...b, value: f })",
      )
      const { report } = await scan(code)

      expect(outcomes(code, report)).toEqual([
        ['window|Window.fetch|replace|unknown', 'unknown', 'medium', ['__proto__: p']],
        ['window|Window.open|replace|unknown', 'unknown', 'medium', ['...a', '...b']],
        [
          'window|XMLHttpRequest.prototype.send|replace|unknown',
          'unknown',
          'medium',
          ["...Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'send')"],
        ],
      ])
    })

    test('the copy-then-override idiom shares its fingerprint with =', async () => {
      const { report } = await scan(lines('XMLHttpRequest.prototype.send = patched', copyThenOverride))

      expect(mechanisms(report)).toEqual([
        ['window|XMLHttpRequest.prototype.send|replace|unknown', ['assign', 'define-property']],
      ])
      // One certain site proves the mutation (§9), and the most-locking occurrence gives locks (§8).
      expect(report.findings[0].confidence.mutation.level).toBe('high')
      expect(report.findings[0].locks).toBe('unknown')
    })

    test('any other unseen descriptor is a descriptor-change: a value before a spread, one read back, an accessor', async () => {
      const code = lines(
        "Object.defineProperty(window, 'fetch', { value: f, ...d })",
        "Object.defineProperty(window, 'open', { ...d, value: window.open })",
        "Object.defineProperty(window, 'alert', { ...d, get: g })",
        "Object.defineProperty(window, 'stop', { value: f, [k]: v })",
        "Object.defineProperty(window, 'focus', { ...d, value: f, get: g })",
        "Object.defineProperty(window, 'print', { ...d, enumerable: flag })",
      )
      const { report } = await scan(code)

      // `focus` shows both a value and a getter, a TypeError whatever the spread gives. The evidence for `print` is every
      // part the analyzer can't see or decide.
      expect(outcomes(code, report)).toEqual([
        ['window|Window.alert|descriptor-change|unknown', 'unknown', 'medium', ['...d']],
        ['window|Window.fetch|descriptor-change|unknown', 'unknown', 'medium', ['...d']],
        ['window|Window.open|descriptor-change|unknown', 'unknown', 'medium', ['...d']],
        ['window|Window.print|descriptor-change|unknown', 'unknown', 'medium', ['...d', 'enumerable: flag']],
        ['window|Window.stop|descriptor-change|unknown', 'unknown', 'medium', ['[k]: v']],
      ])
    })
  })

  describe('a define whose attributes can not be decided', () => {
    test('that only changes attributes is a descriptor-change with outcome-undecidable', async () => {
      // Window.alert, Window.open and Window.stop are writable, enumerable and configurable data properties. locks is
      // unknown only when configurable or writable can't be decided.
      const code = lines(
        "Object.defineProperty(window, 'alert', { enumerable: flag })",
        "Object.defineProperty(window, 'open', { configurable: c, enumerable: true })",
        "Object.defineProperty(window, 'stop', { get writable(){ return w }, value: window.stop })",
      )
      const { report } = await scan(code)

      expect(outcomes(code, report)).toEqual([
        ['window|Window.alert|descriptor-change|unknown', false, 'medium', ['enumerable: flag']],
        ['window|Window.open|descriptor-change|unknown', 'unknown', 'medium', ['configurable: c']],
        ['window|Window.stop|descriptor-change|unknown', 'unknown', 'medium', ['get writable(){ return w }']],
      ])
    })

    test('a setter alone gives its attribute undefined, which is false; with a getter before it, what the getter returns', async () => {
      // Array.prototype.map is not enumerable, so a setter-only enumerable changes nothing. Window.alert is configurable,
      // so a setter-only configurable plainly changes it. A setter joins a getter before it, spread or not, and one whose
      // key doesn't fold may be any field's (ECMA-262 PropertyDefinitionEvaluation).
      const code = lines(
        "Object.defineProperty(Array.prototype, 'map', { set enumerable(v){} })",
        "Object.defineProperty(window, 'alert', { set configurable(v){} })",
        "Object.defineProperty(window, 'open', { get enumerable(){ return e }, set enumerable(v){} })",
        "Object.defineProperty(window, 'stop', { get enumerable(){ return e }, enumerable: true, set enumerable(v){} })",
        "Object.defineProperty(window, 'focus', { get [k](){ return e }, value: window.focus, set enumerable(v){} })",
      )
      const { report } = await scan(code)

      expect(outcomes(code, report)).toEqual([
        // A setter-only `configurable` is false, which locks the target (§8).
        ['window|Window.alert|descriptor-change|unknown', true, 'high', undefined],
        ['window|Window.focus|descriptor-change|unknown', 'unknown', 'medium', ['get [k](){ return e }']],
        ['window|Window.open|descriptor-change|unknown', false, 'medium', ['get enumerable(){ return e }']],
        ['window|Window.stop|descriptor-change|unknown', false, 'high', undefined],
      ])
    })

    test('whose effect is decided anyway keeps high mutation confidence', async () => {
      const code = lines(
        "Object.defineProperty(window, 'fetch', { value: f, configurable: c })",
        "Object.defineProperty(window, 'open', { value: f, enumerable: e })",
        "Object.defineProperty(window, 'alert', { enumerable: false, configurable: c })",
        "Object.defineProperty(Array.prototype, 'last', { value: f, writable: w })",
      )
      const { report } = await scan(code)

      expect(outcomes(code, report)).toEqual([
        // A property a define adds is non-configurable unless the descriptor says otherwise, so it locks (§8).
        ['window|Array.prototype.last|add|unknown', true, 'high', undefined],
        ['window|Window.alert|descriptor-change|unknown', 'unknown', 'high', undefined],
        ['window|Window.fetch|replace|unknown', 'unknown', 'high', undefined],
        ['window|Window.open|replace|unknown', false, 'high', undefined],
      ])
    })
  })

  describe('an unseen descriptor on a member the catalog does not list', () => {
    test('is an add with locks: unknown and no outcome-undecidable, with the fingerprint of =', async () => {
      const { report } = await scan(
        lines(
          'Array.prototype.last = f',
          "Object.defineProperty(Array.prototype, 'last', d)",
          'Object.defineProperties(Promise, { any2: d })',
          "Reflect.defineProperty(Array.prototype, 0, { ...d })",
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Array.prototype.0|add|unknown', ['reflect-define']],
        ['window|Array.prototype.last|add|unknown', ['assign', 'define-property']],
        ['window|Promise.any2|add|unknown', ['define-properties']],
      ])
      expect(report.findings.map(({ locks, confidence }: Finding) => [locks, confidence.mutation])).toEqual([
        ['unknown', { level: 'high', reasons: [] }],
        ['unknown', { level: 'high', reasons: [] }],
        ['unknown', { level: 'high', reasons: [] }],
      ])
      // The = site leaves Array.prototype.last unlocked, and the unseen define may lock it: the most-locking wins.
      expect(report.findings[1].occurrences.map(({ mechanism }: Finding) => mechanism)).toEqual(['assign', 'define-property'])
    })

    test('a new global or a structural member gives nothing', async () => {
      // A new global is no finding (§3). A constructor's length is native, though no target (§4). A define over an
      // inherited member is a shadowing write (shadowing-writes.test.ts).
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, '__sdk', d)",
          "Object.defineProperty(Array, 'length', d)",
        ),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe('an unseen define that can not change its target', () => {
    test('a non-configurable member gives nothing, unless it is a writable data property', async () => {
      // Math.PI and Window.document can't be redefined: every define throws or changes nothing (an
      // ineffective write). Array.prototype.length is non-configurable but writable, so a define may change it, unless
      // the fields it shows make the engine throw (Principle 1): `configurable: true`, `enumerable: true`, or an accessor.
      const code = lines(
        "Object.defineProperty(Math, 'PI', d)",
        "Object.defineProperty(window, 'document', { ...d })",
        "Object.defineProperty(Array.prototype, 'length', { ...d, get: g })",
        "Object.defineProperty(Array.prototype, 'length', { ...d, set: s })",
        "Object.defineProperty(Array.prototype, 'length', { ...d, configurable: true })",
        "Object.defineProperty(Array.prototype, 'length', { ...d, enumerable: true })",
        // The literal keeps its getter whatever the spread gives it.
        "Object.defineProperty(Array.prototype, 'length', { get: g, ...d })",
        "Object.defineProperty(Array.prototype, 'length', d)",
      )
      const { report } = await scan(code)

      expect(fingerprints(report)).toEqual(['window|Array.prototype.length|descriptor-change|unknown'])
      expect(report.findings[0].locks).toBe('unknown')
      expect(report.findings[0].confidence.mutation.reasons).toEqual(['outcome-undecidable'])
    })

    test('a descriptor that is plainly no object is a TypeError, and gives nothing', async () => {
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'open', null)",
          "Object.defineProperty(window, 'open', undefined)",
          "Object.defineProperty(window, 'open', flag ? 1 : 'a')",
          "Object.defineProperties(window, { open: 5 })",
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('a descriptor ToPropertyDescriptor refuses gives nothing, and in defineProperties nothing is defined (Principle 1)', async () => {
      // A spread or a key that doesn't fold may change a field's value, but the literal keeps the field, so each of the
      // first three has both accessor and data fields. An accessor must be callable or undefined. ObjectDefineProperties
      // converts every descriptor, whatever its key, before it defines any.
      const { report } = await scan(
        lines(
          "Object.defineProperty(window, 'fetch', { get: g, ...d, value: f })",
          "Object.defineProperty(window, 'open', { value: f, ...d, get: g })",
          "Object.defineProperty(window, 'alert', { writable: true, [k]: v, set: s })",
          "Object.defineProperty(window, 'stop', { get: 5 })",
          "Reflect.defineProperty(window, 'focus', { set: null })",
          'Object.defineProperties(window, { print: 5, blur: { value: f } })',
          'Object.defineProperties(window, { [k]: { value: f, get(){} }, close: { value: f } })',
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('one that may be accepted still gives its finding', async () => {
      // An undefined getter is allowed, and a spread may give a callable one. A descriptor that isn't seen may be valid.
      const code = lines(
        "Object.defineProperty(window, 'fetch', { get: undefined })",
        "Object.defineProperty(window, 'open', { get: 5, ...d })",
        'Object.defineProperties(window, { [k]: d, stop: { value: f } })',
      )
      const { report } = await scan(code)

      expect(outcomes(code, report)).toEqual([
        ['window|Window.fetch|descriptor-change|unknown', false, 'high', undefined],
        ['window|Window.open|descriptor-change|unknown', 'unknown', 'medium', ['...d']],
        ['window|Window.stop|replace|unknown', false, 'high', undefined],
      ])
    })
  })

  describe('freezing a native holder is not recognized in R1 (§21)', () => {
    test('Object.freeze(Object.prototype), Object.seal and Object.preventExtensions give nothing', async () => {
      const { report } = await scan(
        lines('Object.freeze(Object.prototype)', 'Object.seal(window)', 'Object.preventExtensions(Array.prototype)'),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe('Reflect.deleteProperty is a delete', () => {
    test("Reflect.deleteProperty(XMLHttpRequest.prototype, 'send') gives a delete, located at the call", async () => {
      const code = "Reflect.deleteProperty(XMLHttpRequest.prototype, 'send')"
      const { report } = await scan(code)

      expect(mechanisms(report)).toEqual([['window|XMLHttpRequest.prototype.send|delete|unknown', ['delete']]])
      const [{ generated }] = report.findings[0].occurrences
      expect(code.slice(generated.start, generated.end)).toBe(code)
    })
  })
})

describe("a finding's locks when its occurrences disagree (§8)", () => {
  // The resolver seam (§19) gives each occurrence its `locks`: a resolver that overrides them, in document order, shows
  // how a finding rolls them up. Only a wrap derives `true`.
  const withLocks = (locks: (boolean | 'unknown')[]): Resolver => ({
    analyzerVersion: jsResolver.analyzerVersion,
    analyzeGroup: (input) => {
      const output = jsResolver.analyzeGroup(input)
      return { ...output, occurrences: output.occurrences.map((occurrence, at) => ({ ...occurrence, locks: locks[at]! })) }
    },
  })

  test.each([
    [[false, false, false], false],
    [[false, 'unknown', false], 'unknown'],
    [['unknown', false, false], 'unknown'],
    [[false, true, 'unknown'], true],
    [['unknown', 'unknown', true], true],
  ] as [(boolean | 'unknown')[], boolean | 'unknown'][])('%j gives %j: the most-locking wins', async (locks, expected) => {
    const { report } = await scanBuild(classic('window.fetch = a; window.fetch = b; window.fetch = c'), [], {
      deps: { resolver: withLocks(locks) },
    })

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].locks).toBe(expected)
  })
})

describe('the lookup point of the new writer forms (§10)', () => {
  const source = 'webpack://app/./node_modules/x/index.js'
  /** A build whose `main.js` is `code`, with a map that names `source` for every token and holds `code` as its content. */
  const mapped = (code: string) => {
    const map = { version: 3, sources: [source], sourcesContent: [code], names: [], mappings: mappings(identityMappings(code)) }
    return { 'index.html': '<script src="main.js"></script>', 'main.js': code, 'main.js.map': JSON.stringify(map) }
  }
  const check = (finding: Finding) => finding.occurrences[0].trace.at(-1)

  test.each([
    ['Reflect.set', "Reflect.set(\n  window,\n  'fetch',\n  w,\n)", 'window|Window.fetch|replace|pkg:x'],
    ['Reflect.set with a receiver', "Reflect.set(\n  Math,\n  'fetch',\n  w,\n  window,\n)", 'window|Window.fetch|replace|pkg:x'],
    ['Reflect.set with a T that does not resolve', "Reflect.set(\n  o,\n  'fetch',\n  w,\n  window,\n)", 'window|Window.fetch|replace|pkg:x'],
    ['Reflect.deleteProperty', "Reflect.deleteProperty(\n  window,\n  'fetch',\n)", 'window|Window.fetch|delete|pkg:x'],
    ['__defineGetter__', "window.__defineGetter__(\n  'fetch',\n  g,\n)", 'window|Window.fetch|descriptor-change|pkg:x'],
  ])('%s looks up its key argument, the member token', async (_, code, fingerprint) => {
    const { report } = await scanBuild(mapped(code))

    const [finding] = report.findings
    expect(finding.fingerprint).toBe(fingerprint)
    expect(finding.attribution.key).toBe('pkg:x')
    expect(check(finding)).toMatchObject({ result: 'passed', token: 'fetch' })
    expect(check(finding).lookup).toMatchObject({ line: code.split('\n').findIndex((line) => line.includes("'fetch'")) + 1 })
  })

  test('a Reflect.set of __proto__ has no member, and looks up the object written', async () => {
    const { report } = await scanBuild(mapped("Reflect.set(\n  Object.prototype,\n  '__proto__',\n  p,\n  Math,\n)"))

    const [finding] = report.findings
    expect(finding.fingerprint).toBe('window|Math.[[Prototype]]|prototype-change|pkg:x')
    expect(check(finding)).toMatchObject({ result: 'passed', token: 'Math', lookup: { line: 5, column: 2 } })
  })

  test('a key not written as a string has no token: the object written is looked up, and the check does not apply', async () => {
    const { report } = await scanBuild(mapped("const k = 'fetch'\nReflect.set(\n  o,\n  k,\n  w,\n  window,\n)"))

    const [finding] = report.findings
    expect(finding.fingerprint).toBe('window|Window.fetch|replace|pkg:x')
    expect(check(finding)).toMatchObject({ result: 'n/a', token: null, lookup: { line: 6, column: 2 } })
  })
})

describe('locks: unknown in a baseline (§11)', () => {
  test('baseline init writes it, and a scan against that baseline reads it back', async () => {
    const dir = fixtureBuild(classic("Object.defineProperty(window, 'fetch', d)"))
    const cwd = workingDir()

    const init = await runCli(['baseline', 'init', dir, '--map', defaultMap, '--surface', 'all'], { cwd })
    expect(init.exitCode).toBe(0)
    const baseline = JSON.parse(readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8'))
    expect(baseline.entries.map(({ fingerprint, locks }: Finding) => [fingerprint, locks])).toEqual([
      ['window|Window.fetch|descriptor-change|unknown', 'unknown'],
    ])

    const { report } = await scanBuild(dir, ['--baseline', join(cwd, 'monkeypatchlist.baseline.json')])
    expect(report.findings.map(({ locks, baselineState }: Finding) => [locks, baselineState])).toEqual([
      ['unknown', 'existing'],
    ])
  })
})

describe('determinism (§15)', () => {
  test('two scans of copies of a build with every new writer form give byte-identical reports, except run', async () => {
    const files = classic(
      lines(
        "Reflect.set(window, 'fetch', f); Reflect.set(Math, 'max', g, Array.prototype)",
        "Reflect.deleteProperty(XMLHttpRequest.prototype, 'send'); window.__defineGetter__('alert', g)",
        "Object.defineProperty(window, 'open', d); Object.defineProperty(window, 'stop', { ...d, value: f })",
        "Object.defineProperty(window, 'focus', { enumerable: flag }); Object.defineProperty(Array.prototype, 'last', d)",
      ),
    )

    const first = await scanBuild(files)
    const second = await scanBuild(files)

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
    expect(first.report.findings).toHaveLength(8)
  })
})

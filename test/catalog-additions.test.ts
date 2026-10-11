// Catalog additions (§3 platform singletons, §4 Sources and Targets and holders): the
// realm global interface's own interface object, console's empty prototype, the four ECMA-262 own properties without a
// clause of their own, the curated singletons, and Location's own valueOf and @@toPrimitive. Every scenario goes
// through `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

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
const lines = (...code: string[]) => code.join(';\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** Each finding's target and effect, in report order. */
const findings = (report: Report) =>
  report.findings.map(({ target, effect }: { target: unknown; effect: string }) => ({ target, effect }))

const fingerprints = (report: Report): string[] => report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)

describe.each(resolvers)('catalog additions, with %s behind the seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe("the realm global interface's own interface object", () => {
    test('is the constructor holder Window.Window: a member added to it, and a change of its prototype, are named on it', async () => {
      const { report } = await scan(
        classic(
          lines(
            'Window.foo = f',
            'window.Window.bar = g',
            'Object.setPrototypeOf(Window, X)',
            'Object.setPrototypeOf(self.Window, Y)',
          ),
        ),
      )

      expect(findings(report)).toEqual([
        { target: { realm: 'window', holder: 'constructor', name: 'Window.Window.[[Prototype]]' }, effect: 'prototype-change' },
        { target: { realm: 'window', holder: 'constructor', name: 'Window.Window.bar' }, effect: 'add' },
        { target: { realm: 'window', holder: 'constructor', name: 'Window.Window.foo' }, effect: 'add' },
      ])
      // `Window` read bare and through the global object is the same holder: one finding, one occurrence per site.
      expect(report.findings[0].occurrences).toHaveLength(2)
    })

    test('the same holds in each worker realm, named by its global interface', async () => {
      const { report } = await scan({
        'index.html': '<script>new Worker("worker.js")</script>',
        'worker.js': lines('DedicatedWorkerGlobalScope.foo = f', 'Object.setPrototypeOf(self.DedicatedWorkerGlobalScope, X)'),
      })

      expect(fingerprints(report)).toEqual([
        'dedicated-worker|DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope.[[Prototype]]|prototype-change|unknown',
        'dedicated-worker|DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope.foo|add|unknown',
      ])
    })

    test('its prototype is the existing Window.prototype holder, the global object’s prototype', async () => {
      const { report } = await scan(
        classic(
          lines(
            'Window.prototype.foo = f',
            // Only a resolved holder decides an identity comparison: the fetch write shows the two are one object.
            '(Window.prototype === window.Window.prototype ? window : parent).fetch = a',
          ),
        ),
      )

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown', 'window|Window.prototype.foo|add|unknown'])
      expect(report.findings[0].occurrences[0].realmInstance).toBe('current')
    })

    test('Window.prototype.addEventListener = w is named on Window.prototype, shadowing EventTarget.prototype.addEventListener', async () => {
      const { report } = await scan(classic(lines('Window.prototype.addEventListener = w', 'window.Window.prototype.removeEventListener = v')))

      expect(findings(report)).toEqual([
        {
          target: {
            realm: 'window',
            holder: 'prototype',
            name: 'Window.prototype.addEventListener',
            shadows: 'EventTarget.prototype.addEventListener',
          },
          effect: 'replace',
        },
        {
          target: {
            realm: 'window',
            holder: 'prototype',
            name: 'Window.prototype.removeEventListener',
            shadows: 'EventTarget.prototype.removeEventListener',
          },
          effect: 'replace',
        },
      ])
      // `shadows` is derived, not identity (ADR 0002).
      expect(fingerprints(report)).toEqual([
        'window|Window.prototype.addEventListener|replace|unknown',
        'window|Window.prototype.removeEventListener|replace|unknown',
      ])
    })

    test('on a prototype holder, an inherited [Replaceable] attribute’s setter throws, so only the operation is shadowed', async () => {
      // The object written is an interface prototype object, which implements no interface, so the inherited
      // `[Replaceable]` setter throws before writing (§3). On the global object the same write is a `replace`.
      const { report } = await scan({
        'index.html': '<script>new Worker("worker.js")</script>',
        'worker.js': lines('DedicatedWorkerGlobalScope.prototype.fetch = w', 'DedicatedWorkerGlobalScope.prototype.performance = p'),
      })

      expect(findings(report)).toEqual([
        {
          target: {
            realm: 'dedicated-worker',
            holder: 'prototype',
            name: 'DedicatedWorkerGlobalScope.prototype.fetch',
            shadows: 'WorkerGlobalScope.prototype.fetch',
          },
          effect: 'replace',
        },
      ])
    })

    test('a change of Window.prototype’s prototype is no finding: it is an immutable prototype exotic object', async () => {
      // The ineffective-write record the fixture expects, `Window.prototype.[[Prototype]]|immutable-prototype`, is
      // its own record's. What this test shows is that the write reaches
      // `Window.prototype`, whose holder carries `immutablePrototype`.
      const { report } = await scan(
        classic(lines('Object.setPrototypeOf(Window.prototype, Object.create(null))', 'Window.prototype.__proto__ = X')),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe('Object.getPrototypeOf of a native holder is its prototype in the unmutated catalog', () => {
    test('of window, Window.prototype; of Window.prototype, WindowProperties, whose writes are named on it', async () => {
      const { report } = await scan(
        classic(
          lines(
            'Object.getPrototypeOf(window).foo = f',
            'Object.getPrototypeOf(Window.prototype).addEventListener = w',
            '(Object.getPrototypeOf(Object.getPrototypeOf(Window.prototype)) === EventTarget.prototype ? window : parent).open = o',
          ),
        ),
      )

      expect(findings(report)).toEqual([
        { target: { realm: 'window', holder: 'global', name: 'Window.open' }, effect: 'replace' },
        { target: { realm: 'window', holder: 'prototype', name: 'Window.prototype.foo' }, effect: 'add' },
        {
          target: {
            realm: 'window',
            holder: 'prototype',
            name: 'WindowProperties.addEventListener',
            shadows: 'EventTarget.prototype.addEventListener',
          },
          effect: 'replace',
        },
      ])
      expect(report.findings[0].occurrences[0].realmInstance).toBe('current')
    })

    test('a name not visible on its chain is no member WindowProperties can take, so writing one gives nothing', async () => {
      // Chromium's named properties object refuses to define a name its chain doesn't have ("Named property setter is
      // not supported"), so the write changes nothing (§3). Its ineffective-write record, if any, is tested elsewhere.
      const { report } = await scan(
        classic(
          lines(
            'Object.getPrototypeOf(Window.prototype).zz = 1',
            "Object.defineProperty(Object.getPrototypeOf(Window.prototype), 'yy', { value: 2 })",
          ),
        ),
      )

      expect(report.findings).toEqual([])
    })

    test("of another window's holder, that window's prototype holder", async () => {
      const { report } = await scan(classic('Object.getPrototypeOf(parent.console).x = 1'))

      expect(fingerprints(report)).toEqual(['window|console.[[Prototype]].x|add|unknown'])
      expect(report.findings[0].occurrences[0].realmInstance).toBe('other')
    })

    test('the key may fold, and Object may be read from the global object; the steps record both', async () => {
      const { report } = await scan(classic('window.Object["getPrototype" + "Of"](console).x = 1'))

      expect(fingerprints(report)).toEqual(['window|console.[[Prototype]].x|add|unknown'])
      const kinds = report.findings[0].occurrences[0].trace.map((step: { kind: string }) => step.kind)
      // `window`, then `console`: `Object` read from the global object is no step of its own.
      expect(kinds).toEqual(['binding', 'binding', 'catalog-holder', 'fold'])
    })

    test('gives nothing for null, a user object, or a local Object', async () => {
      const { report } = await scan(
        classic(
          lines(
            'Object.getPrototypeOf(Object.prototype).x = 1',
            'Object.getPrototypeOf({}).y = 2',
            'function f(Object) { Object.getPrototypeOf(console).z = 3 }',
          ),
        ),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe('the four ECMA-262 own properties without a clause of their own are native members', () => {
    test('String.prototype.length = 1 is no finding: the property is non-writable, so the write is ineffective', async () => {
      // Before the catalog had it, this was an `add`. Its ineffective-write record (`non-writable`) is tested elsewhere.
      const { report } = await scan(
        classic(lines('String.prototype.length = 1', "Object.defineProperty(String.prototype, 'length', { value: 2 })")),
      )

      expect(report.findings).toEqual([])
    })

    test('delete Function.prototype.caller is a delete of a native member, and so is .arguments', async () => {
      const { report } = await scan(classic(lines('delete Function.prototype.caller', 'delete Function.prototype.arguments')))

      expect(findings(report)).toEqual([
        { target: { realm: 'window', holder: 'prototype', name: 'Function.prototype.arguments' }, effect: 'delete' },
        { target: { realm: 'window', holder: 'prototype', name: 'Function.prototype.caller' }, effect: 'delete' },
      ])
    })

    test('the other writes follow their ECMA-262 descriptors', async () => {
      const { report } = await scan(
        classic(
          lines(
            // A writable, non-configurable data property: a new value replaces it, and a delete can't remove it.
            'Array.prototype.length = 0',
            'delete Array.prototype.length',
            // An accessor with a setter (%ThrowTypeError%): an assignment through it is no mutation (§3).
            'Function.prototype.caller = f',
            // Redefining the configurable accessor as a data property gives it a new value.
            "Object.defineProperty(Function.prototype, 'arguments', { value: null })",
          ),
        ),
      )

      expect(findings(report)).toEqual([
        { target: { realm: 'window', holder: 'prototype', name: 'Array.prototype.length' }, effect: 'replace' },
        { target: { realm: 'window', holder: 'prototype', name: 'Function.prototype.arguments' }, effect: 'replace' },
      ])
      expect(report.findings.map((finding: { surface: string }) => finding.surface)).toEqual(['ECMAScript', 'ECMAScript'])
    })

    test('in a worker realm too', async () => {
      const { report } = await scan({
        'index.html': '<script>new Worker("worker.js")</script>',
        'worker.js': lines('delete self.Function.prototype.caller', 'String.prototype.length = 1'),
      })

      expect(fingerprints(report)).toEqual(['dedicated-worker|Function.prototype.caller|delete|unknown'])
    })
  })

  describe('the curated singletons', () => {
    test('customElements, document.fonts and the nested navigator objects are singletons under every alias path', async () => {
      const set = (path: string) => `Object.setPrototypeOf(${path}, X)`
      const { report } = await scan(
        classic(
          lines(
            set('customElements'),
            set('window.document.fonts'),
            set('navigator.clipboard'),
            set('clientInformation.storage'),
            set('self.navigator.mediaDevices'),
            set('globalThis.clientInformation.permissions'),
            set('navigator.locks'),
            set('window.navigator.userActivation'),
          ),
        ),
      )

      expect(findings(report)).toEqual(
        [
          'customElements',
          'document.fonts',
          'navigator.clipboard',
          'navigator.locks',
          'navigator.mediaDevices',
          'navigator.permissions',
          'navigator.storage',
          'navigator.userActivation',
        ].map((name) => ({
          target: { realm: 'window', holder: 'instance', name: `${name}.[[Prototype]]` },
          effect: 'prototype-change',
        })),
      )
      expect(report.findings[6].occurrences[0].trace).toEqual([
        expect.objectContaining({ kind: 'binding', form: 'global-property', name: 'Object' }),
        expect.objectContaining({ kind: 'binding', form: 'global-property', name: 'clientInformation', holds: 'navigator' }),
        expect.objectContaining({ kind: 'binding', form: 'singleton', name: 'storage', aliasOf: 'navigator.storage' }),
      ])
    })

    test('navigator.storage, .locks and .permissions are singletons in worker realms too, and the others are not', async () => {
      const set = (path: string) => `Object.setPrototypeOf(${path}, X)`
      const { report } = await scan({
        'index.html': '<script>new Worker("worker.js")</script>',
        'worker.js': lines(
          set('navigator.storage'),
          set('self.navigator.locks'),
          set('navigator.permissions'),
          set('navigator.clipboard'),
          set('navigator.userActivation'),
        ),
      })

      expect(fingerprints(report)).toEqual([
        'dedicated-worker|navigator.locks.[[Prototype]]|prototype-change|unknown',
        'dedicated-worker|navigator.permissions.[[Prototype]]|prototype-change|unknown',
        'dedicated-worker|navigator.storage.[[Prototype]]|prototype-change|unknown',
      ])
    })
  })

  describe("Location's own valueOf and @@toPrimitive", () => {
    test('location.valueOf = f is no finding: the property is non-writable, so the write is ineffective', async () => {
      // Its ineffective-write record (`non-writable`, and `non-configurable` for the define and delete) is tested elsewhere.
      const { report } = await scan(
        classic(
          lines(
            'location.valueOf = f',
            'document.location.valueOf = g',
            "Object.defineProperty(window.location, 'valueOf', { value: h })",
            'delete location.valueOf',
            'location[Symbol.toPrimitive] = p',
          ),
        ),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe("console's empty prototype", () => {
    test('Object.getPrototypeOf(console) is its own prototype holder console.[[Prototype]], not Object.prototype', async () => {
      const { report } = await scan(classic('Object.getPrototypeOf(console).x = y'))

      expect(findings(report)).toEqual([
        { target: { realm: 'window', holder: 'prototype', name: 'console.[[Prototype]].x' }, effect: 'add' },
      ])
      const trace = report.findings[0].occurrences[0].trace
      expect(trace.map((step: { kind: string }) => step.kind)).toEqual(['binding', 'binding', 'catalog-holder'])
      expect(trace[2]).toEqual({
        kind: 'catalog-holder',
        expression: 'Object.getPrototypeOf(console)',
        generated: { start: 0, end: 30, line: 1, column: 0 },
        prototypeOf: 'console',
        holder: 'console.[[Prototype]]',
        text: expect.any(String),
      })
    })

    test('its own prototype is Object.prototype, and a change of it is named console.[[Prototype]].[[Prototype]]', async () => {
      const { report } = await scan(
        classic(
          lines(
            'Object.setPrototypeOf(Object.getPrototypeOf(console), X)',
            'Object.getPrototypeOf(Object.getPrototypeOf(console)).z = 1',
          ),
        ),
      )

      expect(findings(report)).toEqual([
        { target: { realm: 'window', holder: 'prototype', name: 'Object.prototype.z' }, effect: 'add' },
        {
          target: { realm: 'window', holder: 'prototype', name: 'console.[[Prototype]].[[Prototype]]' },
          effect: 'prototype-change',
        },
      ])
    })

    test('setting console’s prototype to Object.prototype now changes it, since its prototype is the empty object', async () => {
      const { report } = await scan(
        classic(lines('Object.setPrototypeOf(console, Object.prototype)', 'Object.setPrototypeOf(console, Object.getPrototypeOf(console))')),
      )

      expect(findings(report)).toEqual([
        { target: { realm: 'window', holder: 'namespace', name: 'console.[[Prototype]]' }, effect: 'prototype-change' },
      ])
      expect(report.findings[0].occurrences).toHaveLength(1)
    })
  })
})

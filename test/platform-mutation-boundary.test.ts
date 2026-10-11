// The platform mutation boundary (§3 What is a platform mutation, ADR 0011): which writes are platform mutations, and
// which are API use, writes to ordinary instances or new non-native globals. An assign follows the member's `assign`
// kind (§4 Member data): `setter`, `put-forwards` and `event-handler` are API use, and `replaceable` is a `replace`.
// Every scenario goes through `monkeypatchlist scan --json`, with both binding resolvers behind the seam. Storage data,
// deletes through an inheriting object and ineffective writes have tests of their own.

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

/** Each finding's fingerprint, with the mechanism of each of its occurrences, in report order. */
const mechanisms = (report: Report): [string, string[]][] =>
  report.findings.map((finding: Report) => [
    finding.fingerprint,
    finding.occurrences.map((occurrence: Report) => occurrence.mechanism),
  ])

describe.each(resolvers)('the platform mutation boundary, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe('a [Replaceable] assign is a replace', () => {
    test('window.length = 5 gives Window.length replace', async () => {
      const { report } = await scan(classic('window.length = 5'))

      expect(mechanisms(report)).toEqual([['window|Window.length|replace|unknown', ['assign']]])
      expect(report.findings[0].target).toEqual({ realm: 'window', holder: 'global', name: 'Window.length' })
    })

    test('so do a bare name, the other global-object forms, another window and a bulk assign, as one finding', async () => {
      const { report } = await scan(
        classic(
          lines(
            'length = 1',
            'self.length = 2',
            'globalThis["length"] = 3',
            'parent.length = 4',
            'window.length += 1',
            'Object.assign(window, { length: 6 })',
          ),
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Window.length|replace|unknown', ['assign', 'assign', 'assign', 'assign', 'assign', 'bulk-assign']],
      ])
      expect(report.findings[0].occurrences.map((occurrence: Report) => occurrence.realmInstance)).toEqual([
        'current',
        'current',
        'current',
        'other',
        'current',
        'current',
      ])
    })

    test("writing back what the attribute's getter returns still replaces it, with a data property that no longer tracks it", async () => {
      // `window.fetch = window.fetch` changes nothing (§3), because a data property keeps its value and its
      // descriptor.
      // A [Replaceable] accessor becomes an own data property holding a snapshot of the getter's value (ADR 0011).
      const { report } = await scan(classic(lines('window.length = window.length', 'self.performance = performance')))

      expect(mechanisms(report)).toEqual([
        ['window|Window.length|replace|unknown', ['assign']],
        ['window|Window.performance|replace|unknown', ['assign']],
      ])
    })

    test("the window global's other [Replaceable] attributes are replaced the same way", async () => {
      const { report } = await scan(
        classic(lines('window.innerWidth = 1', 'self.performance = p', 'window.event = e', 'window.self = s')),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Window.event|replace|unknown', ['assign']],
        ['window|Window.innerWidth|replace|unknown', ['assign']],
        ['window|Window.performance|replace|unknown', ['assign']],
        ['window|Window.self|replace|unknown', ['assign']],
      ])
    })
  })

  describe('in a worker', () => {
    const worker = (code: string) => ({ 'index.html': '<script>new Worker("worker.js")</script>', 'worker.js': code })

    test("an assign through the global to an inherited [Replaceable] attribute replaces it with the global's own property", async () => {
      // The [Replaceable] setter creates an own data property on the object written, the worker global (§3 Shadowing
      // writes), which shadows `WorkerGlobalScope.prototype.performance`.
      const { report } = await scan(
        worker(lines('self.performance = p', 'origin = o', 'self.name = n', 'self.onmessage = f')),
      )

      expect(mechanisms(report)).toEqual([
        ['dedicated-worker|DedicatedWorkerGlobalScope.name|replace|unknown', ['assign']],
        ['dedicated-worker|DedicatedWorkerGlobalScope.origin|replace|unknown', ['assign']],
        ['dedicated-worker|DedicatedWorkerGlobalScope.performance|replace|unknown', ['assign']],
      ])
      expect(report.findings.map((finding: Report) => finding.target)).toEqual([
        { realm: 'dedicated-worker', holder: 'global', name: 'DedicatedWorkerGlobalScope.name' },
        {
          realm: 'dedicated-worker',
          holder: 'global',
          name: 'DedicatedWorkerGlobalScope.origin',
          shadows: 'WorkerGlobalScope.prototype.origin',
        },
        {
          realm: 'dedicated-worker',
          holder: 'global',
          name: 'DedicatedWorkerGlobalScope.performance',
          shadows: 'WorkerGlobalScope.prototype.performance',
        },
      ])
    })

    test("an assign on the interface prototype object itself fails the setter's brand check, so it changes nothing", async () => {
      // Web IDL's attribute setter throws a TypeError before a [Replaceable] setter writes, when the object written
      // doesn't implement the interface. An interface prototype object implements none.
      const { report } = await scan(
        worker(lines('WorkerGlobalScope.prototype.performance = p', 'WorkerGlobalScope.prototype.onerror = f')),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe('assigning a writable Web IDL attribute is API use', () => {
    test('window.onerror = f, document.title = t and location.href = u give no finding', async () => {
      const { report } = await scan(classic(lines('window.onerror = f', 'document.title = t', 'location.href = u')))

      expect(report.findings).toEqual([])
    })

    test('nor does any other setter, put-forwards or event-handler assign, however it is spelt', async () => {
      const { report } = await scan(
        classic(
          lines(
            // event-handler
            'onerror = f',
            'self.onload = g',
            'parent.onmessage = h',
            'window.onclick ||= k',
            // put-forwards: `Window.location` and the location singleton's own `document.location`
            'window.location = u',
            'location = u',
            'document.location = u',
            'window.document.location = u',
            // setter, on the global and on a singleton's own member
            'window.name = n',
            'status = s',
            'window.opener = null',
            'location.hash = h',
            'window.location.search = q',
            // the same writes through a bulk assign
            'Object.assign(window, { onerror: f, name: n, location: u })',
            'Object.assign(location, { href: u })',
          ),
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('an assign to an ECMAScript accessor with a setter is API use, while one without a setter is an ineffective write', async () => {
      // `Iterator.prototype.constructor` and `@@toStringTag` are accessors with setters (ECMA-262
      // SetterThatIgnoresPrototypeProperties). `Map.prototype.size` has no setter: an ineffective write.
      const { report } = await scan(
        classic(
          lines(
            'Iterator.prototype.constructor = C',
            'Iterator.prototype[Symbol.toStringTag] = "x"',
            'Map.prototype.size = 1',
          ),
        ),
      )

      expect(report.findings).toEqual([])
    })

    test('a define of the same attribute is still a mutation, and so is a delete', async () => {
      const { report } = await scan(
        classic(
          lines(
            "Object.defineProperty(window, 'onerror', { value: f })",
            "Object.defineProperty(window, 'name', { get: g })",
            'delete window.onerror',
          ),
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Window.name|descriptor-change|unknown', ['define-property']],
        ['window|Window.onerror|delete|unknown', ['delete']],
        ['window|Window.onerror|replace|unknown', ['define-property']],
      ])
    })
  })

  describe('ordinary instances are never targets', () => {
    test('a write to a member of an XHR instance gives no finding', async () => {
      const { report } = await scan(
        classic(
          lines(
            'var xhr = new XMLHttpRequest()',
            'xhr.onreadystatechange = f',
            'xhr.send = w',
            "Object.defineProperty(xhr, 'open', { value: o })",
            'delete xhr.abort',
            'new XMLHttpRequest().setRequestHeader = s',
          ),
        ),
      )

      expect(report.findings).toEqual([])
    })

    test("nor does a write to an element's handler or dataset, or to what a native call returns", async () => {
      const { report } = await scan(
        classic(
          lines(
            'var el = document.createElement("div")',
            'el.onclick = f',
            'el.dataset.id = "x"',
            'document.body.onload = g',
            'document.getElementById("app").innerHTML = h',
            'new Headers().set = s',
          ),
        ),
      )

      expect(report.findings).toEqual([])
    })

    test("the instance's interface prototype is a native holder, so a write there is a finding", async () => {
      const { report } = await scan(classic('XMLHttpRequest.prototype.send = w'))

      expect(mechanisms(report)).toEqual([['window|XMLHttpRequest.prototype.send|replace|unknown', ['assign']]])
    })
  })

  describe('new non-native globals are not findings', () => {
    test('window.jQuery = … and self.webpackChunkapp = … give no finding', async () => {
      const { report } = await scan(
        classic(lines('window.jQuery = $', 'self.webpackChunkapp = self.webpackChunkapp || []')),
      )

      expect(report.findings).toEqual([])
    })

    test('nor does any other spelling or mechanism, or deleting one again', async () => {
      const { report } = await scan(
        classic(
          lines(
            'jQuery = $',
            'globalThis.__APP_STATE__ = {}',
            'parent.dataLayer = []',
            "Object.defineProperty(window, '__sdk', { value: 1 })",
            'Object.defineProperties(self, { a: { value: 1 }, b: { get: g } })',
            'Object.assign(window, { gtag: g })',
            'delete window.jQuery',
          ),
        ),
      )

      expect(report.findings).toEqual([])
    })
  })

  describe('add applies only to native holders', () => {
    test('a new member of a native prototype, constructor or namespace is an add, and of any other object nothing', async () => {
      const { report } = await scan(
        classic(
          lines(
            'Array.prototype.last = f',
            'Promise.settle = t',
            'JSON.parse5 = p',
            'var o = {}; o.last = f',
            'function F(){}; F.prototype.last = f',
            'history.custom = c',
          ),
        ),
      )

      expect(mechanisms(report)).toEqual([
        ['window|Array.prototype.last|add|unknown', ['assign']],
        ['window|JSON.parse5|add|unknown', ['assign']],
        ['window|Promise.settle|add|unknown', ['assign']],
      ])
    })
  })
})

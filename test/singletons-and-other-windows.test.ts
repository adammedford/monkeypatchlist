// Platform singletons and other windows (§4 naming rules, §5 Other windows). Every scenario goes through
// `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const fingerprints = (report: Report): string[] => report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)

/** The `binding` steps of every occurrence, in report order. */
const bindings = (report: Report) =>
  report.findings.flatMap((finding: { occurrences: { trace: { kind: string }[] }[] }) =>
    finding.occurrences.flatMap((occurrence) => occurrence.trace.filter((step) => step.kind === 'binding')),
  )

const current = { realm: 'window', realmInstance: 'current' }
const other = { realm: 'window', realmInstance: 'other' }
const text = expect.any(String)

/** Every occurrence's realm instance, in report order. */
const realmInstances = (report: Report): string[] =>
  report.findings.flatMap((finding: { occurrences: { realmInstance: string }[] }) =>
    finding.occurrences.map((occurrence) => occurrence.realmInstance),
  )

describe.each(resolvers)('singletons and other windows, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe('platform singletons', () => {
    test('a singleton is one holder through every access path in its alias group, and the trace records the path', async () => {
      const code = ['console.log = a', 'window.console.warn = b', 'self.console.error = c', 'globalThis.console.info = d']
      const { report } = await scan(classic(code.join('\n')))

      expect(report.findings.map((finding: { target: unknown }) => finding.target)).toEqual([
        { realm: 'window', holder: 'namespace', name: 'console.error' },
        { realm: 'window', holder: 'namespace', name: 'console.info' },
        { realm: 'window', holder: 'namespace', name: 'console.log' },
        { realm: 'window', holder: 'namespace', name: 'console.warn' },
      ])
      const singleton = { kind: 'binding', name: 'console', resolution: 'alias', form: 'singleton', path: 'console', aliasOf: 'console' }
      expect(bindings(report)).toEqual([
        { kind: 'binding', name: 'self', resolution: 'alias', form: 'global-name', aliasOf: 'Window', ...current, text },
        { ...singleton, ...current, text },
        { kind: 'binding', name: 'globalThis', resolution: 'alias', form: 'global-name', aliasOf: 'Window', ...current, text },
        { ...singleton, ...current, text },
        { kind: 'binding', name: 'console', resolution: 'global', form: 'global-property', holds: 'console', ...current, text },
        { kind: 'binding', name: 'window', resolution: 'alias', form: 'global-name', aliasOf: 'Window', ...current, text },
        { ...singleton, ...current, text },
      ])
    })

    test('instance singletons, nested ones included, are one holder under every alias path, told apart by identity', async () => {
      // Besides a set-prototype (below), no write to an instance singleton gives a finding until shadowing writes
      // land, so their resolution shows through identity comparisons, which only a resolved holder can decide.
      const same = [
        'window.localStorage === localStorage',
        'self.history === globalThis.history',
        'document.location === window.location',
        'window.document.location === self.location',
        'navigator.geolocation === window.clientInformation.geolocation',
        'globalThis.navigator.serviceWorker === clientInformation.serviceWorker',
        'crypto.subtle === self.crypto.subtle',
        'window.performance === performance',
      ]
      const code = [
        `(${same.join(' && ')} ? window : parent).fetch = a`,
        '(localStorage === sessionStorage ? window : parent).alert = b',
        '(navigator.geolocation !== navigator ? window : parent).open = c',
        '(parent.localStorage === localStorage ? window : parent).print = d',
      ]
      const { report } = await scan(classic(code.join(';\n')))

      expect(report.findings.map((finding: { target: { name: string } }) => finding.target.name)).toEqual([
        'Window.alert',
        'Window.fetch',
        'Window.open',
        'Window.print',
      ])
      expect(realmInstances(report)).toEqual(['other', 'current', 'current', 'unknown'])
    })

    test('Object.setPrototypeOf(window.localStorage, X) gives localStorage.[[Prototype]], and so does every other alias path', async () => {
      const code = [
        'Object.setPrototypeOf(window.localStorage, X)',
        'Object.setPrototypeOf(localStorage, X)',
        'Reflect.setPrototypeOf(self.localStorage, X)',
        'globalThis.localStorage.__proto__ = X',
        'Object.setPrototypeOf(parent.localStorage, X)',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(fingerprints(report)).toEqual(['window|localStorage.[[Prototype]]|prototype-change|unknown'])
      const [finding] = report.findings
      expect(finding.target).toEqual({ realm: 'window', holder: 'instance', name: 'localStorage.[[Prototype]]' })
      expect(finding.occurrences.map((occurrence: { mechanism: string }) => occurrence.mechanism)).toEqual([
        'set-prototype',
        'set-prototype',
        'set-prototype',
        'set-prototype',
        'set-prototype',
      ])
      expect(realmInstances(report)).toEqual(['current', 'current', 'current', 'current', 'other'])
      // Each path's steps to the singleton, without those of the native writer function.
      const singletonSteps = finding.occurrences.map((occurrence: { trace: { kind: string; name: string }[] }) =>
        occurrence.trace
          .filter((step) => step.kind === 'binding' && step.name !== 'Object' && step.name !== 'Reflect')
          .map(({ name, form, aliasOf, holds, path }: Report) => ({ name, form, aliasOf, holds, path })),
      )
      const singleton = { name: 'localStorage', form: 'singleton', aliasOf: 'localStorage', holds: undefined, path: 'localStorage' }
      const globalName = (name: string) => ({ name, form: 'global-name', aliasOf: 'Window', holds: undefined, path: undefined })
      expect(singletonSteps).toEqual([
        [globalName('window'), singleton],
        [{ name: 'localStorage', form: 'global-property', aliasOf: undefined, holds: 'localStorage', path: undefined }],
        [globalName('self'), singleton],
        [globalName('globalThis'), singleton],
        [{ name: 'parent', form: 'other-window', aliasOf: 'Window', holds: undefined, path: undefined }, singleton],
      ])
    })

    test('nested singletons resolve to their canonical path, through every alias path', async () => {
      const code = [
        'Object.setPrototypeOf(navigator.geolocation, X)',
        'Object.setPrototypeOf(window.clientInformation.geolocation, X)',
        'Object.setPrototypeOf(self.navigator.geolocation, X)',
        'Object.setPrototypeOf(crypto.subtle, Y)',
        'Object.setPrototypeOf(globalThis.crypto.subtle, Y)',
        'Object.setPrototypeOf(clientInformation.serviceWorker, Z)',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(fingerprints(report)).toEqual([
        'window|crypto.subtle.[[Prototype]]|prototype-change|unknown',
        'window|navigator.geolocation.[[Prototype]]|prototype-change|unknown',
        'window|navigator.serviceWorker.[[Prototype]]|prototype-change|unknown',
      ])
      expect(report.findings.map((finding: Report) => [finding.target.holder, finding.occurrences.length])).toEqual([
        ['instance', 2],
        ['instance', 3],
        ['instance', 1],
      ])
      // The last step names the canonical path, whichever access path reached it.
      const geolocation = report.findings[1].occurrences.map((occurrence: Report) =>
        occurrence.trace
          .filter((step: Report) => step.kind === 'binding' && step.form === 'singleton')
          .map(({ name, aliasOf, path }: Report) => [name, aliasOf, path]),
      )
      expect(geolocation).toEqual([
        [['geolocation', 'navigator.geolocation', 'navigator.geolocation']],
        [
          ['clientInformation', 'navigator', 'clientInformation'],
          ['geolocation', 'navigator.geolocation', 'navigator.geolocation'],
        ],
        [
          ['navigator', 'navigator', 'navigator'],
          ['geolocation', 'navigator.geolocation', 'navigator.geolocation'],
        ],
      ])
    })

    test("a singleton whose prototype is immutable, or a change to the prototype it has, gives nothing", async () => {
      // `Location` instances are immutable prototype exotic objects (§4 Member data), so these are ineffective writes
      // (§3), and setting localStorage's own prototype changes nothing.
      const code = [
        'Object.setPrototypeOf(document.location, X)',
        'Object.setPrototypeOf(window.location, X)',
        'location.__proto__ = X',
        'Object.setPrototypeOf(localStorage, Storage.prototype)',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(report.findings).toEqual([])
    })

    test("another window's singleton is the same holder, with that window's realm instance", async () => {
      const { report } = await scan(classic('parent.console.log = a\niframe.contentWindow.console.log = b'))

      expect(fingerprints(report)).toEqual(['window|console.log|replace|unknown'])
      expect(realmInstances(report)).toEqual(['other', 'unknown'])
      expect(bindings(report).map((step: { name: string; form: string; realmInstance: string }) => [
        step.name,
        step.form,
        step.realmInstance,
      ])).toEqual([
        ['parent', 'other-window', 'other'],
        ['console', 'singleton', 'other'],
        ['contentWindow', 'other-window', 'unknown'],
        ['console', 'singleton', 'unknown'],
      ])
    })
  })

  describe('other windows', () => {
    test('iframe.contentWindow.fetch = w gives Window.fetch, with realm instance unknown', async () => {
      const { report } = await scan(classic('var iframe = document.createElement("iframe")\niframe.contentWindow.fetch = w'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(report.findings[0].target).toEqual({ realm: 'window', holder: 'global', name: 'Window.fetch' })
      expect(realmInstances(report)).toEqual(['unknown'])
    })

    test('window.parent.fetch = w gives Window.fetch, with realm instance other', async () => {
      const { report } = await scan(classic('window.parent.fetch = w'))

      expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(realmInstances(report)).toEqual(['other'])
      expect(bindings(report)).toEqual([
        { kind: 'binding', name: 'window', resolution: 'alias', form: 'global-name', aliasOf: 'Window', ...current, text },
        { kind: 'binding', name: 'parent', resolution: 'alias', form: 'other-window', aliasOf: 'Window', ...other, text },
      ])
    })

    test('parent, top, opener and frames[i] from any form of the global object, or bare, are other windows', async () => {
      const code = [
        'parent.fetch = a',
        'top.alert = b',
        'opener.open = c',
        'frames[0].print = d',
        'self.frames[i].stop = e',
        'globalThis.frames["1"].focus = f',
        'this.top.blur = g',
        'parent.parent.close = h',
        'top.frames[0].parent.self.postMessage = k',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.blur|replace|unknown',
        'window|Window.close|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.focus|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|Window.postMessage|replace|unknown',
        'window|Window.print|replace|unknown',
        'window|Window.stop|replace|unknown',
      ])
      expect(new Set(realmInstances(report))).toEqual(new Set(['other']))
      const steps = (target: string) =>
        report.findings
          .find((finding: { target: { name: string } }) => finding.target.name === target)
          .occurrences[0].trace.map((step: { name: string; form: string; realmInstance: string }) => [
            step.name,
            step.form,
            step.realmInstance,
          ])
      expect(steps('Window.fetch')).toEqual([['parent', 'other-window', 'other']])
      // `frames` is the window itself, and an index read on it a child window.
      expect(steps('Window.print')).toEqual([
        ['frames', 'global-name', 'current'],
        ['[0]', 'other-window', 'other'],
      ])
      expect(steps('Window.stop')).toEqual([
        ['self', 'global-name', 'current'],
        ['[i]', 'other-window', 'other'],
      ])
      expect(steps('Window.blur')).toEqual([
        ['this', 'top-level-this', 'current'],
        ['top', 'other-window', 'other'],
      ])
      expect(steps('Window.postMessage')).toEqual([
        ['top', 'other-window', 'other'],
        ['[0]', 'other-window', 'other'],
        ['parent', 'other-window', 'other'],
      ])
    })

    test('defaultView and contentWindow on any object are a window, and which one is unknown', async () => {
      // This window's own `document.defaultView` is this window, so another window's document stands in.
      const code = [
        'parent.document.defaultView.fetch = a',
        'el.ownerDocument.defaultView.alert = b',
        'this.contentWindow.open = c',
        'function f(frame) { frame.contentWindow.parent.print = d }',
        'iframe.contentWindow.frames[0].stop = e',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|Window.print|replace|unknown',
        'window|Window.stop|replace|unknown',
      ])
      expect(new Set(realmInstances(report))).toEqual(new Set(['unknown']))
      const open = report.findings.find((finding: { target: { name: string } }) => finding.target.name === 'Window.open')
      expect(open.occurrences[0].trace).toEqual([
        {
          kind: 'binding',
          name: 'contentWindow',
          resolution: 'alias',
          form: 'other-window',
          aliasOf: 'Window',
          realm: 'window',
          realmInstance: 'unknown',
          text,
        },
      ])
    })

    test('an opener or a contentWindow can be null, so a chain that falls back to this window reaches either', async () => {
      const { report } = await scan(classic('(window.opener || window).fetch = a;\n(iframe.contentWindow || self).alert = b'))

      expect(fingerprints(report)).toEqual(['window|Window.alert|replace|unknown', 'window|Window.fetch|replace|unknown'])
      expect(realmInstances(report)).toEqual(['unknown', 'unknown'])
      expect(bindings(report).map((step: { name: string; realmInstance: string }) => [step.name, step.realmInstance])).toEqual([
        ['contentWindow', 'unknown'],
        ['self', 'current'],
        ['window', 'current'],
        ['opener', 'other'],
        ['window', 'current'],
      ])
    })

    test("another window's native is not this window's, so writing one over the other changes something", async () => {
      // Writing a member's own value back changes nothing (§3), but the same member of two windows is two values: a
      // slot is known to be the one read only through the same window expression.
      const code = [
        'parent.fetch = window.fetch',
        'window.alert = top.alert',
        "Object.defineProperty(opener, 'open', { value: self.open })",
        'Object.setPrototypeOf(parent.localStorage, Storage.prototype)',
        'Object.setPrototypeOf(sessionStorage, frames[0].Storage.prototype)',
        // Both are this window's: nothing changes.
        'window.stop = self.stop',
        'Object.setPrototypeOf(window.localStorage, self.Storage.prototype)',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|localStorage.[[Prototype]]|prototype-change|unknown',
        'window|sessionStorage.[[Prototype]]|prototype-change|unknown',
      ])
      expect(realmInstances(report)).toEqual(['current', 'other', 'other', 'other', 'current'])
    })

    test("code that another window's eval, Function or timer compiles runs in that window", async () => {
      // Its free names are that window's global properties, and its `window` and `this` that window.
      const code = [
        'parent.eval("fetch = a")',
        'top.Function("window.alert = b")()',
        'iframe.contentWindow.setTimeout("this.open = c")',
        'parent.eval("parent.print = d")',
        'eval("stop = e")',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
        'window|Window.print|replace|unknown',
        'window|Window.stop|replace|unknown',
      ])
      expect(realmInstances(report)).toEqual(['other', 'other', 'unknown', 'other', 'current'])
      const alert = report.findings[0].occurrences[0].trace
      expect(alert.map((step: Report) => [step.kind, step.name, step.form, step.realmInstance])).toEqual([
        ['note', undefined, undefined, undefined],
        ['binding', 'top', 'other-window', 'other'],
        ['binding', 'window', 'global-name', 'other'],
        ['creation-site', undefined, undefined, undefined],
      ])
    })

    test("Function('return this')() through another window's Function returns that window, a nullable one included", async () => {
      const code = [
        'parent.Function("return this")().fetch = a',
        'window.opener.Function("return this")().alert = b',
        'x.contentWindow.Function("return this")().open = c',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(fingerprints(report)).toEqual([
        'window|Window.alert|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|Window.open|replace|unknown',
      ])
      expect(realmInstances(report)).toEqual(['other', 'other', 'unknown'])
      // The step that reached the window stays, and the `function-return-this` step follows it.
      expect(bindings(report).map((step: Report) => [step.name, step.form, step.realmInstance])).toEqual([
        ['window', 'global-name', 'current'],
        ['opener', 'other-window', 'other'],
        ['Function', 'function-return-this', 'other'],
        ['parent', 'other-window', 'other'],
        ['Function', 'function-return-this', 'other'],
        ['contentWindow', 'other-window', 'unknown'],
        ['Function', 'function-return-this', 'unknown'],
      ])
    })

    test('another window is not this one, so comparing them decides nothing', async () => {
      const { report } = await scan(classic('(top === self ? window : parent).fetch = a;\n(window === self ? window : parent).alert = b'))

      expect(fingerprints(report)).toEqual(['window|Window.alert|replace|unknown', 'window|Window.fetch|replace|unknown'])
      expect(realmInstances(report)).toEqual(['current', 'unknown'])
    })

    test('x.parent.fetch = w on an unresolved x gives nothing, and neither does another window without a window base', async () => {
      const code = [
        'x.parent.fetch = a',
        'document.parent.alert = b',
        'el.top.open = c',
        'x.opener.print = d',
        'x.frames[0].stop = e',
        'frames["fetch"].blur = g',
        'frames[{}].close = h',
        'function t(parent, frames) { parent.fetch = k; frames[0].alert = l }',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(report.findings).toEqual([])
    })

    test('a with block around a bare parent or frames lowers target confidence, and one around contentWindow does not', async () => {
      const { report } = await scan(
        classic('with (o) { parent.fetch = a }\nwith (o) { frames[0].alert = b }\nwith (o) { x.contentWindow.open = c }'),
      )

      expect(report.findings.map((finding: { target: { name: string }; confidence: { target: unknown } }) => [
        finding.target.name,
        finding.confidence.target,
      ])).toEqual([
        ['Window.alert', { level: 'low', reasons: ['with-scope'] }],
        ['Window.fetch', { level: 'low', reasons: ['with-scope'] }],
        ['Window.open', { level: 'high', reasons: [] }],
      ])
    })

    test('a worker has no other windows', async () => {
      const code = 'self.parent.fetch = a; top.fetch = b; frames[0].fetch = c; x.contentWindow.fetch = d; self.Promise = e'
      const { report } = await scan({
        'index.html': '<script src="main.js"></script>',
        'main.js': `new Worker("worker.js");\n${code}`,
        'worker.js': code,
      })

      const occurrences = report.findings.map((finding: Report) => [
        finding.fingerprint,
        finding.occurrences.map((occurrence: Report) => [occurrence.artifact.url, occurrence.realmInstance]),
      ])
      expect(occurrences).toEqual([
        ['dedicated-worker|DedicatedWorkerGlobalScope.Promise|replace|unknown', [['https://app.example/worker.js', 'current']]],
        ['window|Window.Promise|replace|unknown', [['https://app.example/main.js', 'current']]],
        [
          'window|Window.fetch|replace|unknown',
          [
            ['https://app.example/main.js', 'other'],
            ['https://app.example/main.js', 'other'],
            ['https://app.example/main.js', 'other'],
            ['https://app.example/main.js', 'unknown'],
          ],
        ],
      ])
    })
  })

  describe('realm instance is evidence, never identity (§4, §8)', () => {
    test('writes to the same member of this window, another and an unknown one are one finding, with an occurrence each', async () => {
      const { report } = await scan(classic('window.fetch = a\nparent.fetch = b\niframe.contentWindow.fetch = c'))

      expect(report.findings).toHaveLength(1)
      const [finding] = report.findings
      expect(finding.fingerprint).toBe('window|Window.fetch|replace|unknown')
      expect(finding.targetKey).toBe('window|Window.fetch|replace')
      expect(finding.target).toEqual({ realm: 'window', holder: 'global', name: 'Window.fetch' })
      expect(realmInstances(report)).toEqual(['current', 'other', 'unknown'])
    })
  })
})

// Other-window refinements (§3 Undecidable outcomes, §4 and §5 Other windows): `frames` is the window it is read from,
// an index read on a window is a child window, and a write-back through the same window expression changes nothing.
// Every scenario goes through `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

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

/** Each finding's target name, with the realm instance of each of its occurrences, in report order. */
const found = (report: Report): [string, string[]][] =>
  report.findings.map((finding: Report) => [
    finding.target.name,
    finding.occurrences.map((occurrence: Report) => occurrence.realmInstance),
  ])

/** The name, form and realm instance of each `binding` step of a finding's first occurrence. */
const steps = (report: Report, target: string): [string, string, string][] =>
  report.findings
    .find((finding: Report) => finding.target.name === target)
    .occurrences[0].trace.filter((step: Report) => step.kind === 'binding')
    .map((step: Report) => [step.name, step.form, step.realmInstance])

describe.each(resolvers)('other-window refinements, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe('frames is the window it is read from', () => {
    test('frames.fetch = w and window.frames.fetch = w give Window.fetch, with realm instance current', async () => {
      const { report } = await scan(classic('frames.fetch = a\nwindow.frames.fetch = b'))

      expect(report.findings.map((finding: Report) => finding.fingerprint)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(report.findings[0].target).toEqual({ realm: 'window', holder: 'global', name: 'Window.fetch' })
      expect(found(report)).toEqual([['Window.fetch', ['current', 'current']]])
    })

    test("frames read from another window is that window, and frames is this window's steps as a name of the global object", async () => {
      const { report } = await scan(classic('parent.frames.alert = a\nself.frames.frames.open = b\nframes.localStorage.__proto__ = X'))

      expect(found(report)).toEqual([
        ['Window.alert', ['other']],
        ['Window.open', ['current']],
        ['localStorage.[[Prototype]]', ['current']],
      ])
      expect(steps(report, 'Window.alert')).toEqual([['parent', 'other-window', 'other']])
      expect(steps(report, 'Window.open')).toEqual([['self', 'global-name', 'current']])
      expect(steps(report, 'localStorage.[[Prototype]]')).toEqual([
        ['frames', 'global-name', 'current'],
        ['localStorage', 'singleton', 'current'],
      ])
    })
  })

  describe('an index read on a window is a child window', () => {
    test('window[0].fetch = w and parent[0].fetch = w give Window.fetch, with realm instance other', async () => {
      const { report } = await scan(classic('window[0].fetch = a\nparent[0].fetch = b'))

      expect(report.findings.map((finding: Report) => finding.fingerprint)).toEqual(['window|Window.fetch|replace|unknown'])
      expect(found(report)).toEqual([['Window.fetch', ['other', 'other']]])
      const occurrences = report.findings[0].occurrences.map((occurrence: Report) =>
        occurrence.trace.map((step: Report) => [step.kind, step.name, step.form, step.realmInstance]),
      )
      expect(occurrences).toEqual([
        [
          ['binding', 'window', 'global-name', 'current'],
          ['binding', '[0]', 'other-window', 'other'],
        ],
        [
          ['binding', 'parent', 'other-window', 'other'],
          ['binding', '[0]', 'other-window', 'other'],
        ],
      ])
    })

    test('every form of a window takes a constant index, and a child of an unknown window is unknown', async () => {
      // An unresolved key is a child window only on the frames spelling: `this[i]` gives nothing.
      const code = [
        'self[1].alert = a',
        'globalThis["2"].open = b',
        'this[3].print = c',
        'top[0][1].stop = d',
        'opener[0].focus = e',
        'x.contentWindow[0].blur = f',
        'Function("return this")()[0].close = g',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(found(report)).toEqual([
        ['Window.alert', ['other']],
        ['Window.blur', ['unknown']],
        ['Window.close', ['other']],
        ['Window.focus', ['other']],
        ['Window.open', ['other']],
        ['Window.print', ['other']],
        ['Window.stop', ['other']],
      ])
      expect(steps(report, 'Window.print')).toEqual([
        ['this', 'top-level-this', 'current'],
        ['[3]', 'other-window', 'other'],
      ])
      expect(steps(report, 'Window.stop')).toEqual([
        ['top', 'other-window', 'other'],
        ['[0]', 'other-window', 'other'],
        ['[1]', 'other-window', 'other'],
      ])
    })

    test('a key that is no index, an index on no window, and a worker global give nothing', async () => {
      const code = [
        'window["fetch"].alert = a',
        'self[{}].open = b',
        'window[1.5].print = c',
        'window[true].stop = d',
        'localStorage[0].focus = e',
        'x[0].blur = f',
        'function t(window) { window[0].close = g }',
      ]
      const { report } = await scan({
        'index.html': '<script src="main.js"></script>',
        'main.js': `new Worker("worker.js");\n${code.join('\n')}`,
        'worker.js': 'self[0].fetch = a\nglobalThis[0].fetch = b',
      })

      expect(report.findings).toEqual([])
    })
  })

  describe('a write-back through the same window expression changes nothing (§3)', () => {
    test('parent.fetch = parent.fetch, top.fetch = top.fetch and frames[0].fetch = frames[0].fetch give nothing', async () => {
      const { report } = await scan(
        classic('parent.fetch = parent.fetch\ntop.fetch = top.fetch\nframes[0].fetch = frames[0].fetch'),
      )

      expect(report.findings).toEqual([])
    })

    test('the same window expression, however the window it starts from is spelt, and through every writer', async () => {
      const code = [
        'window.parent.alert = parent.alert',
        'opener.open = self.opener.open',
        'window[0].print = frames["0"].print',
        'parent.frames[1].stop = parent[1].stop',
        'x.contentWindow.focus = x.contentWindow.focus',
        'frames[i].blur = frames[i].blur',
        'el.ownerDocument.defaultView.close = el.ownerDocument.defaultView.close',
        'parent.XMLHttpRequest.prototype.send = parent.XMLHttpRequest.prototype.send',
        'parent.console.log = window.parent.console.log',
        "Object.defineProperty(top, 'postMessage', { value: top.postMessage })",
        'Object.assign(parent, { moveTo: window.parent.moveTo })',
        'parent.eval("fetch = fetch")',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(report.findings).toEqual([])
    })

    test('document.defaultView.fetch = window.fetch and frames[0].parent.fetch = window.fetch give nothing', async () => {
      const { report } = await scan(
        classic('document.defaultView.fetch = window.fetch\nframes[0].parent.fetch = window.fetch'),
      )

      expect(report.findings).toEqual([])
    })

    test("this window's document and a child's parent are this window through every spelling", async () => {
      const code = [
        'self.document.defaultView.alert = alert',
        'window[0].parent.open = document.defaultView.open',
        'frames.frames[1].parent.print = self.print',
        'Object.defineProperty(document.defaultView, "stop", { value: frames[i].parent.stop })',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(report.findings).toEqual([])
    })

    test('a compound assignment writes a new value, and a logical assignment writes back what is there', async () => {
      const code = [
        'window.fetch += window.fetch',
        'parent.alert -= parent.alert',
        'frames[0].print |= frames[0].print',
        'x.contentWindow.focus **= x.contentWindow.focus',
        // `||=`, `&&=` and `??=` write the value read, or nothing.
        'top.open ||= top.open',
        'window.stop &&= self.stop',
        'opener.close ??= opener.close',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(found(report)).toEqual([
        ['Window.alert', ['other']],
        ['Window.fetch', ['current']],
        ['Window.focus', ['unknown']],
        ['Window.print', ['other']],
      ])
      expect(report.findings.map((finding: Report) => finding.effect)).toEqual(Array(4).fill('replace'))
    })

    test('parent.fetch = window.fetch is still a replace, and so is every write-back the analyzer cannot show is one', async () => {
      const code = [
        'parent.fetch = window.fetch',
        'parent.alert = top.alert',
        'frames[0].open = frames[1].open',
        'frames[i].print = frames[j].print',
        'frames[i++].stop = frames[i++].stop',
        'f().contentWindow.focus = f().contentWindow.focus',
        'x.contentWindow.blur = y.contentWindow.blur',
        '(a ? parent : top).close = (a ? parent : top).close',
        // Another window's document, and a child's parent of another window, are that window only as the same expression.
        'parent.document.defaultView.moveTo = parent.moveTo',
        'parent[0].parent.moveBy = parent.moveBy',
        // The same expression, where the code between the two reads could change which window it reaches.
        'frames[i].scroll = (i = 1, frames[i]).scroll',
        'frames[0].scrollBy = frames[(f(), 0)].scrollBy',
        'x.contentWindow.scrollTo = (x = y, x.contentWindow.scrollTo)',
      ]
      const { report } = await scan(classic(code.join(';\n')))

      expect(found(report)).toEqual([
        ['Window.alert', ['other']],
        ['Window.blur', ['unknown']],
        ['Window.close', ['other']],
        ['Window.fetch', ['other']],
        ['Window.focus', ['unknown']],
        ['Window.moveBy', ['other']],
        ['Window.moveTo', ['unknown']],
        ['Window.open', ['other']],
        ['Window.print', ['other']],
        // Findings are in fingerprint order, and `|` sorts after the letters.
        ['Window.scrollBy', ['other']],
        ['Window.scrollTo', ['unknown']],
        ['Window.scroll', ['other']],
        ['Window.stop', ['other']],
      ])
      expect(report.findings.map((finding: Report) => finding.effect)).toEqual(Array(13).fill('replace'))
    })
  })
})

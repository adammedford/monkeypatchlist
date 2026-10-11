// Window index keys and this-window no-ops (§3 Undecidable outcomes, §5 Other windows): a constant array index on any
// resolved window is a child window, and an unresolved key only on a window spelled as the frames collection.
// `document.defaultView` and `frames[i].parent` are this window everywhere, and holders reached through one window
// expression compare equal and take their own prototype back. Every scenario goes through `monkeypatchlist scan --json`, with
// both binding resolvers behind the seam.

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

describe.each(resolvers)('window index keys and this-window no-ops, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  describe('an unresolved key is a child window only through the frames spelling', () => {
    test('window[cfg.globalName].close = fn and window[ns].open = f give nothing, and frames[i].close = fn gives Window.close', async () => {
      // A wrap through an unresolved key keeps no finding either, and gives no `unresolved-holder` record: its holder
      // is reached through no constant property chain, so the site isn't patch-shaped (§5).
      const code = [
        'window[cfg.globalName].close = fn',
        'window[ns].open = f',
        'window[ns].print = wrap(window[ns].print)',
        'frames[i].close = fn',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(found(report)).toEqual([['Window.close', ['other']]])
      expect(report.completeness.limitations.filter((record: Report) => record.kind === 'unresolved-holder')).toEqual([])
      expect(steps(report, 'Window.close')).toEqual([
        ['frames', 'global-name', 'current'],
        ['[i]', 'other-window', 'other'],
      ])
    })

    test('window[0].fetch = w and parent["1"].fetch = w give Window.fetch, with realm instance other', async () => {
      const { report } = await scan(classic('window[0].fetch = a\nparent["1"].fetch = b'))

      expect(found(report)).toEqual([['Window.fetch', ['other', 'other']]])
      const occurrences = report.findings[0].occurrences.map((occurrence: Report) =>
        occurrence.trace.filter((step: Report) => step.kind === 'binding').map((step: Report) => [step.name, step.form]),
      )
      expect(occurrences).toEqual([
        [
          ['window', 'global-name'],
          ['[0]', 'other-window'],
        ],
        [
          ['parent', 'other-window'],
          ['[1]', 'other-window'],
        ],
      ])
    })

    test('an unresolved key on every other spelling of a window gives nothing', async () => {
      const code = [
        'self[k].alert = a',
        'globalThis[k].open = b',
        'this[i].print = c',
        'parent[i].stop = d',
        'top[i].focus = e',
        'opener[i].blur = f',
        'x.contentWindow[i].scroll = g',
        'Function("return this")()[i].scrollBy = h',
        'window[i + 1].scrollTo = j',
        'window[`${n}`].moveTo = k',
        'window[f()].moveBy = l',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(report.findings).toEqual([])
    })

    test('the frames spelling is bare, .frames or a constant ["frames"], on any window, and survives what keeps a value', async () => {
      const code = [
        'window.frames[i].alert = a',
        'parent.frames[i].open = b',
        'window["frames"][i].print = c',
        'self.frames.frames[i].stop = d',
        'x.contentWindow.frames[k].focus = e',
        '(0, frames)[i].blur = f',
        '(g = frames)[i].scroll = h',
        '(frames?.[i]).scrollBy = j',
        '(c ? frames : parent.frames)[i].scrollTo = k',
      ]
      const { report } = await scan(classic(`const F = "fra" + "mes";\nwindow[F][i].moveTo = m;\n${code.join(';\n')}`))

      expect(found(report)).toEqual([
        ['Window.alert', ['other']],
        ['Window.blur', ['other']],
        ['Window.focus', ['unknown']],
        ['Window.moveTo', ['other']],
        ['Window.open', ['other']],
        ['Window.print', ['other']],
        ['Window.scrollBy', ['other']],
        // A child of either window is another window, but which of the two the chain reads is unknown.
        ['Window.scrollTo', ['unknown']],
        ['Window.scroll', ['other']],
        ['Window.stop', ['other']],
      ])
      expect(steps(report, 'Window.open')).toEqual([
        ['parent', 'other-window', 'other'],
        ['[i]', 'other-window', 'other'],
      ])
    })

    test('reading any other member drops the frames spelling', async () => {
      const code = [
        'frames.self[i].alert = a',
        'frames.window[i].open = b',
        'frames["globalThis"][i].print = c',
        'frames.parent[i].stop = d',
        'frames.top[i].focus = e',
        'frames[0][i].blur = f',
        'frames.frames.self[i].scroll = g',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(report.findings).toEqual([])
    })

    test('a key that may be a constant index or unresolved reads a child window through the constant', async () => {
      const code = [
        'window[c ? 0 : k].alert = a',
        '(c ? frames : window)[i].open = b',
        'parent[c ? "1" : k].print = d',
        // The `frames` read of the window reads a child window, and the `self` read beside it an unknown.
        'window[c ? "self" : "frames"][i].stop = e',
      ]
      const { report } = await scan(classic(code.join(';\n')))

      expect(found(report)).toEqual([
        ['Window.alert', ['other']],
        ['Window.open', ['other']],
        ['Window.print', ['other']],
        ['Window.stop', ['other']],
      ])
      // Only the frames arm of the chain reads a child window for the unresolved key.
      expect(steps(report, 'Window.open')).toEqual([
        ['frames', 'global-name', 'current'],
        ['[i]', 'other-window', 'other'],
      ])
      expect(steps(report, 'Window.alert')).toEqual([
        ['window', 'global-name', 'current'],
        ['[0]', 'other-window', 'other'],
      ])
    })
  })

  describe("this window's document.defaultView and a child's parent are this window, with realm instance current", () => {
    test('document.defaultView.fetch = a and frames[0].parent.alert = b are writes to this window', async () => {
      const { report } = await scan(classic('document.defaultView.fetch = a\nframes[0].parent.alert = b'))

      expect(found(report)).toEqual([
        ['Window.alert', ['current']],
        ['Window.fetch', ['current']],
      ])
      expect(steps(report, 'Window.fetch')).toEqual([
        ['document', 'global-property', 'current'],
        ['defaultView', 'other-window', 'current'],
      ])
      expect(steps(report, 'Window.alert')).toEqual([
        ['frames', 'global-name', 'current'],
        ['[0]', 'other-window', 'other'],
        ['parent', 'other-window', 'current'],
      ])
    })

    test("another window's document, an unknown object's defaultView, and code another window compiles", async () => {
      const code = [
        'parent.document.defaultView.fetch = a',
        'el.ownerDocument.defaultView.alert = b',
        'parent[0].parent.open = c',
        'parent.eval("document.defaultView.print = d; frames[0].parent.stop = e")',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(found(report)).toEqual([
        ['Window.alert', ['unknown']],
        ['Window.fetch', ['unknown']],
        ['Window.open', ['other']],
        // Code that another window's `eval` compiles has that window as its own.
        ['Window.print', ['other']],
        ['Window.stop', ['other']],
      ])
    })
  })

  describe('a prototype set through one window expression changes nothing (§3)', () => {
    test("setting localStorage's own prototype through this window's or another window's one expression gives nothing", async () => {
      const code = [
        'Object.setPrototypeOf(document.defaultView.localStorage, Storage.prototype)',
        'Object.setPrototypeOf(frames[0].parent.localStorage, Storage.prototype)',
        'Object.setPrototypeOf(parent.localStorage, parent.Storage.prototype)',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(report.findings).toEqual([])
    })

    test('through every spelling of one window expression, and through every set-prototype writer', async () => {
      const code = [
        'Object.setPrototypeOf(window.parent.localStorage, parent.Storage.prototype)',
        'Reflect.setPrototypeOf(frames[i].sessionStorage, frames[i].Storage.prototype)',
        'Object.setPrototypeOf(x.contentWindow.history, x.contentWindow.History.prototype)',
        'parent[0].localStorage.__proto__ = window.parent.frames["0"].Storage.prototype',
        'Object.assign(top.localStorage, { ["__proto__"]: top.Storage.prototype })',
        'Object.setPrototypeOf(opener.XMLHttpRequest.prototype, self.opener.XMLHttpRequestEventTarget.prototype)',
        'Object.setPrototypeOf(el.ownerDocument.defaultView.localStorage, el.ownerDocument.defaultView.Storage.prototype)',
        'Object.setPrototypeOf(document.defaultView.localStorage, frames[1].parent.Storage.prototype)',
      ]
      const { report } = await scan(classic(code.join('\n')))

      expect(report.findings).toEqual([])
    })

    test('a prototype from another window, or through code that could change which window it reaches, is a prototype-change', async () => {
      const code = [
        'Object.setPrototypeOf(parent.localStorage, Storage.prototype)',
        'Object.setPrototypeOf(localStorage, top.Storage.prototype)',
        'Object.setPrototypeOf(frames[0].sessionStorage, frames[1].Storage.prototype)',
        'Object.setPrototypeOf(frames[i].history, frames[j].History.prototype)',
        'Object.setPrototypeOf(frames[i].navigator, (i++, frames[i]).Navigator.prototype)',
        'Object.setPrototypeOf(parent.document, (f(), parent.Document.prototype))',
        'x.contentWindow.crypto.__proto__ = (x = y, x.contentWindow.Crypto.prototype)',
        // Another window's document is that window only as the same expression.
        'Object.setPrototypeOf(parent.document.defaultView.sessionStorage, parent.Storage.prototype)',
      ]
      const { report } = await scan(classic(code.join(';\n')))

      expect(found(report)).toEqual([
        ['crypto.[[Prototype]]', ['unknown']],
        ['document.[[Prototype]]', ['other']],
        ['history.[[Prototype]]', ['other']],
        ['localStorage.[[Prototype]]', ['other', 'current']],
        ['navigator.[[Prototype]]', ['other']],
        ['sessionStorage.[[Prototype]]', ['other', 'unknown']],
      ])
      expect(report.findings.map((finding: Report) => finding.effect)).toEqual(Array(6).fill('prototype-change'))
    })
  })

  describe('holders reached through one window expression compare equal', () => {
    // A comparison that folds decides the chain: `window` gives a finding, and `history.<member>` is an expando that
    // gives nothing. An undecided one reaches both holders, which gives nothing until candidate sets.
    test('document.defaultView === window and parent.localStorage === parent.localStorage fold to true', async () => {
      const code = [
        '(document.defaultView === window ? window : history).fetch = a',
        '(parent.localStorage === parent.localStorage ? window : history).alert = b',
      ]
      const { report } = await scan(classic(code.join(';\n')))

      expect(found(report)).toEqual([
        ['Window.alert', ['current']],
        ['Window.fetch', ['current']],
      ])
    })

    test('every spelling of one window expression compares equal, and this window is never null', async () => {
      const code = [
        '(frames[0].parent !== self ? history : window).fetch = a',
        '(x.contentWindow.localStorage === x.contentWindow.localStorage ? window : history).alert = b',
        '(parent.frames[i].history == window.parent["frames"][i].history ? window : history).open = c',
        '(window.top.XMLHttpRequest.prototype === top.XMLHttpRequest.prototype ? window : history).print = d',
        '(document.defaultView == null ? history : window).stop = e',
        '(window === frames ? window : history).focus = f',
      ]
      const { report } = await scan(classic(code.join(';\n')))

      expect(found(report).map(([name]) => name)).toEqual([
        'Window.alert',
        'Window.fetch',
        'Window.focus',
        'Window.open',
        'Window.print',
        'Window.stop',
      ])
    })

    test('different windows, or code between the reads that could change the window, stay undecided', async () => {
      const code = [
        '(parent.localStorage === top.localStorage ? window : history).fetch = a',
        '(parent.localStorage === localStorage ? window : history).alert = b',
        '(frames[i].history === frames[i++].history ? window : history).open = c',
        '(parent.localStorage === (f(), parent.localStorage) ? window : history).print = d',
        '(x.contentWindow === y.contentWindow ? window : history).stop = e',
        '(parent.document.defaultView === parent ? window : history).focus = f',
      ]
      const { report } = await scan(classic(code.join(';\n')))

      // Undecided, each reaches both holders, a candidate set: `window`'s candidate gives a finding with
      // `holder-alternatives`, and `history`'s, an expando, nothing.
      expect(found(report).map(([name]) => name)).toEqual([
        'Window.alert',
        'Window.fetch',
        'Window.focus',
        'Window.open',
        'Window.print',
        'Window.stop',
      ])
      for (const finding of report.findings) expect(finding.confidence.target.reasons).toEqual(['holder-alternatives'])
    })
  })
})

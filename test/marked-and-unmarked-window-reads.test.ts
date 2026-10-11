// Marked and unmarked reads of one window stay apart (Principle 3, §5 Other windows). When one expression reads a window
// both as `frames` and as another member (`window[c ? "self" : "frames"][i]`), each alternative raises what it would
// raise on its own: the `frames` read takes the unresolved `[i]` as a child window, and the `self` read, which drops the
// mark, reads a member the analyzer can't name. Every scenario goes through `monkeypatchlist scan --json`, with both binding
// resolvers behind the seam.

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

/** Each finding's target name, effect and the realm instance of each of its occurrences, in report order. */
const found = (report: Report): [string, string, string[]][] =>
  report.findings.map((finding: Report) => [
    finding.target.name,
    finding.effect,
    finding.occurrences.map((occurrence: Report) => occurrence.realmInstance),
  ])

/** The name, form and realm instance of each `binding` step of a finding's first occurrence. */
const steps = (report: Report, target: string): [string, string, string][] =>
  report.findings
    .find((finding: Report) => finding.target.name === target)
    .occurrences[0].trace.filter((step: Report) => step.kind === 'binding')
    .map((step: Report) => [step.name, step.form, step.realmInstance])

/** The kinds of the report's limitations, in report order. */
const limitations = (report: Report): string[] => report.completeness.limitations.map((limitation: Report) => limitation.kind)

// The window read both ways, as the ticket spells it.
const mixed = 'window[c ? "self" : "frames"][i]'

describe.each(resolvers)('marked and unmarked reads of one window stay apart, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  test(`${mixed} reads the child window through frames, plus an unknown alternative`, async () => {
    // The child window is the `frames` read's: a write through it is found on another window.
    const { report: written } = await scan(classic(`${mixed}.stop = e`))

    expect(found(written)).toEqual([['Window.stop', 'replace', ['other']]])
    expect(steps(written, 'Window.stop')).toEqual([
      ['window', 'global-name', 'current'],
      ['[i]', 'other-window', 'other'],
    ])

    // The `self` read's unknown alternative may be falsy, so a test on the chain decides no branch, and `eval` stays a
    // route for dynamic code. `frames[i]` alone is a child window, which is always an object.
    const { report: tested } = await scan(classic(`(${mixed} ? f : eval)(s);\n(frames[i] ? g : eval)(t)`))

    expect(limitations(tested)).toEqual(['dynamic-code'])
    expect(tested.completeness.limitations[0].location.line).toBe(1)
  })

  test('window[c?"self":"frames"][i].stop = e gives Window.stop, with realm instance other', async () => {
    const { report } = await scan(classic('window[c?"self":"frames"][i].stop = e'))

    expect(found(report)).toEqual([['Window.stop', 'replace', ['other']]])
  })

  test('a write on the mixed read itself lists the window read once', async () => {
    // Without an index, both reads are this window, and one read of one node is one step (§14).
    const { report } = await scan(classic('window[c ? "self" : "frames"].stop = e'))

    expect(found(report)).toEqual([['Window.stop', 'replace', ['current']]])
    expect(steps(report, 'Window.stop')).toEqual([['window', 'global-name', 'current']])
  })

  test('a prototype set through the mixed chain is a prototype-change on localStorage.[[Prototype]], with realm instance other', async () => {
    const code = 'Object.setPrototypeOf(window[c?"self":"frames"][i].localStorage, window[c?"self":"frames"][i].Storage.prototype)'
    const { report } = await scan(classic(code))

    expect(found(report)).toEqual([['localStorage.[[Prototype]]', 'prototype-change', ['other']]])
  })

  test('the same set through frames alone changes nothing', async () => {
    const { report } = await scan(classic('Object.setPrototypeOf(frames[i].localStorage, frames[i].Storage.prototype)'))

    expect(report.findings).toEqual([])
  })

  test('comparing two reads through the mixed chain stays undecided, and an if on it prunes no branch', async () => {
    // A comparison that folds decides the chain: `window` gives a finding, and `history.<member>` is an expando that
    // gives nothing. An undecided one reaches both holders, a candidate set: `window`'s candidate gives a
    // finding with `holder-alternatives`, and `history`'s, an expando, nothing.
    const code = [
      `(${mixed}.history === ${mixed}.history ? window : history).fetch = a`,
      `(${mixed} ? window : history).alert = b`,
      `if (${mixed}) { window.print = d } else { window.stop = e }`,
    ]
    const { report } = await scan(classic(code.join(';\n')))

    expect(found(report).map(([name]) => name)).toEqual(['Window.alert', 'Window.fetch', 'Window.print', 'Window.stop'])
    const reasons = report.findings.map((finding: { confidence: { target: { reasons: string[] } } }) => finding.confidence.target.reasons)
    expect(reasons).toEqual([['holder-alternatives'], ['holder-alternatives'], [], []])
  })

  test('through frames alone, the same comparison and test are decided', async () => {
    const code = [
      '(frames[i].history === frames[i].history ? window : history).fetch = a',
      '(frames[i] ? window : history).alert = b',
    ]
    const { report } = await scan(classic(code.join(';\n')))

    expect(found(report).map(([name]) => name)).toEqual(['Window.alert', 'Window.fetch'])
  })
})

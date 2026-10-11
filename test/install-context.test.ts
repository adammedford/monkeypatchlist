// Install context (§7 Install context): whether a mutation runs at load (`load`, a resolved synchronous chain reaches
// top-level code) or only when a later call reaches it (`deferred`, with its install entry's name). Every scenario goes
// through `monkeypatchlist scan --json`.

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
const module = (code: string) => ({ 'index.html': '<script type="module" src="main.js"></script>', 'main.js': code })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** Each finding's target name and install context. */
const contexts = (report: Report): Record<string, string> =>
  Object.fromEntries(report.findings.map((finding: Report) => [finding.target.name, finding.installContext]))

/** A finding's occurrences, each as its install context and install entry. */
const occurrenceContexts = (report: Report, name: string): Report[] =>
  report.findings
    .find((finding: Report) => finding.target.name === name)
    .occurrences.map((occurrence: Report) => ({
      installContext: occurrence.installContext,
      installEntry: occurrence.installEntry,
    }))

describe.each(resolvers)('install context, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = async (code: string) => (await scanBuild(classic(code), [], { deps: { resolver } })).report

  test('a top-level IIFE install is `load`', async () => {
    const report = await scan('(function(){ window.fetch = p })()')

    expect(contexts(report)).toEqual({ 'Window.fetch': 'load' })
    expect(occurrenceContexts(report, 'Window.fetch')).toEqual([{ installContext: 'load', installEntry: null }])
  })

  test('an exported `init()` that is never called is `deferred`, with the name `init`', async () => {
    const report = (await scanBuild(module('export function init(){ window.fetch = p }'), [], { deps: { resolver } }))
      .report

    expect(contexts(report)).toEqual({ 'Window.fetch': 'deferred' })
    expect(occurrenceContexts(report, 'Window.fetch')).toEqual([{ installContext: 'deferred', installEntry: 'init' }])
  })

  test('a callback registered with `addEventListener` is `deferred`', async () => {
    const report = await scan('window.addEventListener("load", function(){ window.fetch = p })')

    expect(contexts(report)).toEqual({ 'Window.fetch': 'deferred' })
    expect(occurrenceContexts(report, 'Window.fetch')).toEqual([{ installContext: 'deferred', installEntry: null }])
  })

  test('a named callback registered with `addEventListener` records its name', async () => {
    const report = await scan('function onLoad(){ window.fetch = p } document.addEventListener("DOMContentLoaded", onLoad)')

    expect(occurrenceContexts(report, 'Window.fetch')).toEqual([{ installContext: 'deferred', installEntry: 'onLoad' }])
  })

  test('a finding with one `load` occurrence and one `deferred` occurrence is `load`', async () => {
    const report = await scan('function init(){ window.fetch = p } (function(){ window.fetch = p })()')

    expect(contexts(report)).toEqual({ 'Window.fetch': 'load' })
    expect(occurrenceContexts(report, 'Window.fetch')).toEqual([
      { installContext: 'deferred', installEntry: 'init' },
      { installContext: 'load', installEntry: null },
    ])
  })

  test('code a resolved call chain reaches from top-level code is `load`, through any one of its callers', async () => {
    const report = await scan(
      'function patch(){ window.fetch = p } function init(){ patch() } function start(){ patch() } start()',
    )

    expect(occurrenceContexts(report, 'Window.fetch')).toEqual([{ installContext: 'load', installEntry: null }])
  })

  test('code reached only through a function with no resolved caller is `deferred`, named for that entry', async () => {
    const report = await scan('function patch(){ window.fetch = p } function setup(){ patch() } var api = { init: setup }')

    expect(occurrenceContexts(report, 'Window.fetch')).toEqual([{ installContext: 'deferred', installEntry: 'setup' }])
  })

  test('an install entry with no name of its own takes the name it is bound to', async () => {
    const names = async (code: string) => occurrenceContexts(await scan(code), 'Window.fetch')[0].installEntry

    expect(await names('var init = function(){ window.fetch = p }')).toBe('init')
    expect(await names('const start = () => { window.fetch = p }')).toBe('start')
    expect(await names('var sdk = {}; sdk.init = function(){ window.fetch = p }')).toBe('init')
    expect(await names('var sdk = { install: function(){ window.fetch = p } }')).toBe('install')
    expect(await names('var sdk = { patch(){ window.fetch = p } }')).toBe('patch')
    expect(await names('class Sdk { setup(){ window.fetch = p } }')).toBe('setup')
  })

  test('code compiled from a string runs where its compile site runs, and a timer runs it later', async () => {
    const entries = async (code: string) => occurrenceContexts(await scan(code), 'Window.fetch')

    expect(await entries('eval("window.fetch = p")')).toEqual([{ installContext: 'load', installEntry: null }])
    expect(await entries('(0, eval)("window.fetch = p")')).toEqual([{ installContext: 'load', installEntry: null }])
    expect(await entries('function start(){ (0, eval)("window.fetch = p") } start()')).toEqual([
      { installContext: 'load', installEntry: null },
    ])
    expect(await entries('function init(){ eval("window.fetch = p") }')).toEqual([
      { installContext: 'deferred', installEntry: 'init' },
    ])
    expect(await entries('function init(){ (0, eval)("window.fetch = p") }')).toEqual([
      { installContext: 'deferred', installEntry: 'init' },
    ])
    expect(await entries('function init(){ new Function("window.fetch = p")() }')).toEqual([
      { installContext: 'deferred', installEntry: 'init' },
    ])
    expect(await entries('setTimeout("window.fetch = p")')).toEqual([{ installContext: 'deferred', installEntry: null }])
    expect(await entries('function init(){ setTimeout("window.fetch = p") }')).toEqual([
      { installContext: 'deferred', installEntry: 'init' },
    ])
  })

  test('an ineffective write records its install context too', async () => {
    const report = await scan('function init(){ "use strict"; Object.freeze(window.Math); Math.PI = 3 }')

    expect(report.ineffectiveWrites.flatMap((record: Report) => record.occurrences.map((o: Report) => o.installContext)))
      .toEqual(['deferred'])
  })
})

// The protected surface and `--surface` (§12): the resolver detects across the whole catalog, and a scan reports,
// baselines and gates only the protected surface unless `--surface all` asks for everything. Every scenario goes
// through `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { loadCatalog, type Realm } from '../src/catalog.ts'
import { jsResolver, type Effect, type Resolver } from '../src/packages/analysis/index.ts'
import { applySurface, type Finding, type IneffectiveWriteRecord } from '../src/packages/findings/index.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const fingerprints = (report: Report): string[] => report.findings.map((finding: Report) => finding.fingerprint)

/** Every surface at 0, as a scan with nothing out of scope reports them. */
const noneOutOfScope = {
  networking: 0,
  events: 0,
  scheduling: 0,
  navigation: 0,
  storage: 0,
  crypto: 0,
  DOM: 0,
  ECMAScript: 0,
  diagnostics: 0,
  workers: 0,
  other: 0,
}

describe.each(resolvers)('the protected surface, with %s behind the binding-resolution seam', (_, resolver) => {
  /** Scans `--surface protected`, or with the `--surface` that `args` gives. */
  const scan = (files: Record<string, string>, args: string[] = []) =>
    scanBuild(files, args.includes('--surface') ? args : ['--surface', 'protected', ...args], { deps: { resolver } })

  /** Scans with no `--surface` at all, as `monkeypatchlist scan <dir> --map … --json -`. */
  const scanDefault = async (files: Record<string, string>) => {
    const run = await runCli(['scan', fixtureBuild(files), '--map', defaultMap, '--json', '-'], { deps: { resolver } })
    expect(run.exitCode).toBe(0)
    const report = JSON.parse(run.stdout)
    assertValidReport(report)
    return { report }
  }

  describe('`protected` is the default, and `--surface all` reports everything', () => {
    const code = classic(lines('history.pushState = w', 'document.createElement = w', 'window.alert = w'))

    test('a default scan reports only protected findings, and counts the rest per surface', async () => {
      const { report } = await scanDefault(code)

      expect(report.config.surface).toBe('protected')
      expect(fingerprints(report)).toEqual(['window|history.pushState|replace|unknown'])
      expect(report.findings[0].surface).toBe('navigation')
      expect(report.summary.outOfScopeBySurface).toEqual({ ...noneOutOfScope, DOM: 1, other: 1 })
    })

    test('`--surface all` reports every finding, each with its surface, and nothing is out of scope', async () => {
      const { report } = await scan(code, ['--surface', 'all'])

      expect(report.config.surface).toBe('all')
      expect(report.findings.map((finding: Report) => [finding.fingerprint, finding.surface])).toEqual([
        ['window|Window.alert|replace|unknown', 'other'],
        ['window|document.createElement|replace|unknown', 'DOM'],
        ['window|history.pushState|replace|unknown', 'navigation'],
      ])
      expect(report.summary.outOfScopeBySurface).toEqual(noneOutOfScope)
    })
  })

  test('out-of-scope findings stay out of the baseline, and a scan against it gives them no baseline state', async () => {
    const cwd = workingDir()
    const build = fixtureBuild(classic(lines('history.pushState = w', 'document.createElement = w')))
    const init = await runCli(['baseline', 'init', build, '--map', defaultMap], { cwd, deps: { resolver } })
    expect(init.exitCode).toBe(0)
    const baseline = JSON.parse(readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8'))
    expect(baseline.surface).toBe('protected')
    expect(baseline.entries.map(({ fingerprint }: Report) => fingerprint)).toEqual(['window|history.pushState|replace|unknown'])

    const run = await runCli(['scan', build, '--map', defaultMap, '--json', '-', '--fail-on', 'added'], { cwd, deps: { resolver } })
    const report = JSON.parse(run.stdout)
    assertValidReport(report)
    expect(run.exitCode).toBe(0)
    expect(report.findings.map((finding: Report) => [finding.fingerprint, finding.baselineState])).toEqual([
      ['window|history.pushState|replace|unknown', 'existing'],
    ])
    expect(report.summary).toMatchObject({ added: 0, existing: 1, outOfScopeBySurface: { ...noneOutOfScope, DOM: 1 } })
  })

  describe('matching (§12 Matching)', () => {
    test('a shadowing write matches its entry through `shadows`, on whatever holder it lands', async () => {
      const { report } = await scan(
        classic(
          lines(
            'history.pushState = w',
            'window.addEventListener = w',
            'localStorage.setItem = f',
            'Object.getPrototypeOf(Window.prototype).addEventListener = w',
            'Window.prototype.addEventListener = w',
            // An ES-tail shadow on a Web IDL holder is protected under the `Object` entry.
            'XMLHttpRequest.prototype.toString = f',
            'navigator.sendBeacon = f',
          ),
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Window.addEventListener|replace|unknown',
        'window|Window.prototype.addEventListener|replace|unknown',
        'window|WindowProperties.addEventListener|replace|unknown',
        'window|XMLHttpRequest.prototype.toString|replace|unknown',
        'window|history.pushState|replace|unknown',
        'window|localStorage.setItem|replace|unknown',
        'window|navigator.sendBeacon|replace|unknown',
      ])
      expect(report.summary.outOfScopeBySurface).toEqual(noneOutOfScope)
    })

    test("a whole entry covers its global binding, its members, and named adds whatever the key; a member entry only its member", async () => {
      const { report } = await scan(
        classic(
          lines(
            'window.XMLHttpRequest = X',
            'fetch = f',
            'Promise.allSettled = f',
            'Array.prototype.last = f',
            'XMLHttpRequest.foo = 1',
            'XMLHttpRequest.prototype.__zone_symbol__open = f',
            'console.foo = f',
            'JSON.foo = f',
            'Object.getPrototypeOf(console).bar = f',
            // Not covered: `Document` has no entry, and `onX` members are excluded from the whole `WebSocket` entry.
            'Document.prototype.foo = 1',
            "Object.defineProperty(WebSocket.prototype, 'onmessage', { get() {} })",
          ),
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|Array.prototype.last|add|unknown',
        'window|JSON.foo|add|unknown',
        'window|Promise.allSettled|replace|unknown',
        'window|Window.XMLHttpRequest|replace|unknown',
        'window|Window.fetch|replace|unknown',
        'window|XMLHttpRequest.foo|add|unknown',
        'window|XMLHttpRequest.prototype.__zone_symbol__open|add|unknown',
        'window|console.[[Prototype]].bar|add|unknown',
        'window|console.foo|add|unknown',
      ])
      expect(report.summary.outOfScopeBySurface).toEqual({ ...noneOutOfScope, DOM: 1, networking: 1 })
    })

    test('an `onX` member is out of scope, and so under `--surface all` only', async () => {
      const code = classic("Object.defineProperty(WebSocket.prototype, 'onmessage', { get() {} })")

      expect((await scan(code)).report.findings).toEqual([])
      expect(fingerprints((await scan(code, ['--surface', 'all'])).report)).toEqual([
        'window|WebSocket.prototype.onmessage|descriptor-change|unknown',
      ])
    })

    test("a prototype change is covered on a whole entry's prototype or namespace, and on a covered singleton", async () => {
      const { report } = await scan(
        classic(
          lines(
            'Object.setPrototypeOf(XMLHttpRequest.prototype, P)',
            'Object.setPrototypeOf(console, P)',
            'Object.setPrototypeOf(JSON, P)',
            'Object.setPrototypeOf(Object.getPrototypeOf(console), P)',
            'Object.setPrototypeOf(history, P)',
            'Object.setPrototypeOf(localStorage, P)',
            'Object.setPrototypeOf(crypto.subtle, P)',
            'Object.setPrototypeOf(navigator.serviceWorker, P)',
            'Object.setPrototypeOf(navigator, P)',
            // Not covered: a constructor's own [[Prototype]], and singletons with no covered interface.
            'Object.setPrototypeOf(XMLHttpRequest, P)',
            'Object.setPrototypeOf(document, P)',
            'Object.setPrototypeOf(performance, P)',
            'Object.setPrototypeOf(navigator.geolocation, P)',
          ),
        ),
      )

      expect(fingerprints(report)).toEqual([
        'window|JSON.[[Prototype]]|prototype-change|unknown',
        'window|XMLHttpRequest.prototype.[[Prototype]]|prototype-change|unknown',
        'window|console.[[Prototype]].[[Prototype]]|prototype-change|unknown',
        'window|console.[[Prototype]]|prototype-change|unknown',
        'window|crypto.subtle.[[Prototype]]|prototype-change|unknown',
        'window|history.[[Prototype]]|prototype-change|unknown',
        'window|localStorage.[[Prototype]]|prototype-change|unknown',
        'window|navigator.[[Prototype]]|prototype-change|unknown',
        'window|navigator.serviceWorker.[[Prototype]]|prototype-change|unknown',
      ])
      expect(report.summary.outOfScopeBySurface).toEqual({
        ...noneOutOfScope,
        networking: 1,
        DOM: 1,
        diagnostics: 1,
        other: 1,
      })
    })
  })

  describe('what a scan reports besides findings follows the scope', () => {
    const ineffective = (report: Report): string[] =>
      report.ineffectiveWrites.map(({ target, reason }: Report) => `${target.name} ${reason}`)

    test('`ineffectiveWrites[]` and its summary count keep only the records the protected surface covers', async () => {
      const code = classic(lines('Object.defineProperty(Math, "PI", { value: 3 })', 'Object.setPrototypeOf(Object.prototype, P)'))

      const { report } = await scan(code)
      expect(ineffective(report)).toEqual(['Object.prototype.[[Prototype]] immutable-prototype'])
      expect(report.summary.ineffectiveWrites).toBe(1)

      const all = (await scan(code, ['--surface', 'all'])).report
      expect(ineffective(all)).toEqual(['Math.PI non-configurable', 'Object.prototype.[[Prototype]] immutable-prototype'])
      expect(all.summary.ineffectiveWrites).toBe(2)
    })

    const holders = (report: Report): string[] =>
      report.completeness.limitations
        .filter(({ kind }: Report) => kind === 'unresolved-holder')
        .map(({ detail }: Report) => detail.slice(detail.indexOf('could write ') + 'could write '.length))

    test('a protected scan keeps an `unresolved-holder` record with a covered candidate, listing only those', async () => {
      const code = classic(
        lines('var n = "getItem"', 'api.o[n] = wrap(api.o[n])', 'var m = "createElement"', 'api.p[m] = wrap(api.p[m])'),
      )

      const protectedHolders = holders((await scan(code)).report)
      expect(protectedHolders).toEqual(['Storage.prototype.getItem'])

      const allHolders = holders((await scan(code, ['--surface', 'all'])).report)
      expect(allHolders).toEqual([
        'SVGLengthList.prototype.getItem, SVGNumberList.prototype.getItem, SVGPointList.prototype.getItem, ' +
          'SVGStringList.prototype.getItem, SVGTransformList.prototype.getItem, Storage.prototype.getItem',
        'Document.prototype.createElement',
      ])
    })

    test('a protected scan with no covered candidate drops the record, and the counters follow', async () => {
      const { report } = await scan(classic(lines('var m = "createElement"', 'api.p[m] = wrap(api.p[m])')))
      expect(holders(report)).toEqual([])
      expect(report.completeness.counters.blindSpots.unresolvedHolder).toBe(0)
    })
  })
})

// The findings module applies `--surface` (§19). Worker-realm occurrences, ineffective writes and `unresolved-holder`
// candidates are shown here, at its interface, with the shipped catalog.
describe('the findings module applies --surface', () => {
  const catalog = loadCatalog()

  /** A finding as `applySurface` reads it: its target, effect and surface. */
  const finding = (realm: Realm, name: string, effect: Effect, shadows?: string): Finding =>
    ({
      fingerprint: `${realm}|${name}|${effect}|unknown`,
      target: { realm, holder: 'prototype', name, ...(shadows === undefined ? {} : { shadows }) },
      effect,
      surface: 'other',
    }) as Finding
  const scoped = (findings: Finding[], scope: 'protected' | 'all' = 'protected') =>
    applySurface({ findings, ineffectiveWrites: [], limitations: [] }, scope, catalog).findings.map(
      ({ fingerprint }) => fingerprint,
    )

  const workers: Realm[] = ['dedicated-worker', 'shared-worker', 'service-worker']

  test.each(workers)('in the %s realm, the fetch entry matches WorkerGlobalScope.prototype.fetch and a global shadow of it', (realm) => {
    const global = { 'dedicated-worker': 'DedicatedWorkerGlobalScope', 'shared-worker': 'SharedWorkerGlobalScope', 'service-worker': 'ServiceWorkerGlobalScope' }[realm as 'dedicated-worker']

    expect(
      scoped([
        finding(realm, 'WorkerGlobalScope.prototype.fetch', 'wrap'),
        finding(realm, `${global}.fetch`, 'replace', 'WorkerGlobalScope.prototype.fetch'),
        finding(realm, 'WorkerGlobalScope.prototype.importScripts', 'wrap'),
      ]),
    ).toEqual([`${realm}|WorkerGlobalScope.prototype.fetch|wrap|unknown`, `${realm}|${global}.fetch|replace|unknown`])
  })

  test.each(workers)('in the %s realm, WorkerNavigator.prototype.serviceWorker is the Navigator.serviceWorker entry\'s equivalent', (realm) => {
    expect(
      scoped([
        finding(realm, 'WorkerNavigator.prototype.serviceWorker', 'descriptor-change'),
        finding(realm, 'navigator.[[Prototype]]', 'prototype-change'),
      ]),
    ).toEqual([
      `${realm}|WorkerNavigator.prototype.serviceWorker|descriptor-change|unknown`,
      `${realm}|navigator.[[Prototype]]|prototype-change|unknown`,
    ])
  })

  test('ineffective-write records follow the scope, matched through `shadows` with their occurrences\' effects', () => {
    const record = (name: string, effects: Effect[], shadows?: string) =>
      ({
        target: { realm: 'window', holder: 'prototype', name, ...(shadows === undefined ? {} : { shadows }) },
        surface: 'other',
        reason: 'non-configurable',
        occurrences: effects.map((effect) => ({ effect })),
      }) as unknown as IneffectiveWriteRecord
    const writes = [
      record('history.pushState', ['replace'], 'History.prototype.pushState'),
      record('Document.prototype.title', ['replace']),
      record('Object.prototype.[[Prototype]]', ['prototype-change']),
      record('Math.PI', ['replace', 'delete']),
    ]
    const kept = (scope: 'protected' | 'all') =>
      applySurface({ findings: [], ineffectiveWrites: writes, limitations: [] }, scope, catalog).ineffectiveWrites

    expect(kept('protected')).toEqual([writes[0], writes[2]])
    expect(kept('all')).toEqual(writes)
  })

  describe('`unresolved-holder` records follow --surface', () => {
    const prose = '`api.o` at 2:0 doesn\'t resolve, and the patch-shaped assign there could write '
    const record = (candidates: string[]) => ({
      kind: 'unresolved-holder' as const,
      artifact: { url: 'https://app.example/main.js' },
      detail: prose + candidates.join(', '),
      candidates: candidates.map((name) => ({ realm: 'window' as const, name })),
    })
    const other = { kind: 'dynamic-code' as const, artifact: { url: 'https://app.example/main.js' }, detail: 'eval' }
    const kept = (scope: 'protected' | 'all') =>
      applySurface(
        {
          findings: [],
          ineffectiveWrites: [],
          limitations: [
            record(['Document.prototype.title', 'Request.prototype.clone', 'Window.fetch']),
            record(['Document.prototype.title', 'Window.alert']),
            other,
          ],
        },
        scope,
        catalog,
      ).limitations

    test('a protected scan keeps a record with a covered candidate, and its detail lists only the covered ones', () => {
      expect(kept('protected')).toEqual([
        {
          kind: 'unresolved-holder',
          artifact: { url: 'https://app.example/main.js' },
          detail: prose + 'Request.prototype.clone, Window.fetch',
        },
        other,
      ])
    })

    test('`--surface all` keeps every record, with every candidate', () => {
      expect(kept('all')).toEqual([
        {
          kind: 'unresolved-holder',
          artifact: { url: 'https://app.example/main.js' },
          detail: prose + 'Document.prototype.title, Request.prototype.clone, Window.fetch',
        },
        { kind: 'unresolved-holder', artifact: { url: 'https://app.example/main.js' }, detail: prose + 'Document.prototype.title, Window.alert' },
        other,
      ])
    })

    test('a candidate matches through `shadows`', () => {
      const limitations = [
        {
          ...record(['history.pushState', 'Document.prototype.title']),
          candidates: [
            { realm: 'window' as const, name: 'history.pushState', shadows: 'History.prototype.pushState' },
            { realm: 'window' as const, name: 'Document.prototype.title' },
          ],
        },
      ]
      expect(applySurface({ findings: [], ineffectiveWrites: [], limitations }, 'protected', catalog).limitations).toEqual([
        { kind: 'unresolved-holder', artifact: { url: 'https://app.example/main.js' }, detail: prose + 'history.pushState' },
      ])
    })
  })
})

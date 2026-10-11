// The catalog changelog and `explainedBy` (§4 Catalog versions, §11 Commands), and `catalogStatus` (§4). Tests build a
// synthetic two-version catalog from the shipped one: version 1 with a change undone, version 2 as shipped, and the
// changelog the generator writes between them. A baseline is written with `monkeypatchlist baseline init` under version 1,
// then `monkeypatchlist scan --json -` or `monkeypatchlist baseline update` runs under version 2 over a fixture build.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Deps } from '../src/cli.ts'
import {
  loadCatalog,
  type CatalogHolder,
  type CatalogTarget,
  type Realm,
  type SerializedCatalog,
  type Surface,
} from '../src/index.ts'
import { withExplainedBy } from '../src/packages/compare/index.ts'
import { changelog, changelogProblems, changeRecords } from '../tools/catalog-generator/changelog.ts'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import { identityMappings, mappings } from './support/source-map.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'

const page = '<script src="main.js"></script>'
/** A build whose `main.js` is `code`, or the build of these files. */
const build = (code: string | Record<string, string>) =>
  fixtureBuild(typeof code === 'string' ? { 'index.html': page, 'main.js': code } : code)

const shipped = loadCatalog()

/** The shipped catalog with `name`'s entry in `realm` replaced by `target`, or removed when `target` is undefined. */
function withTarget(catalog: SerializedCatalog, realm: Realm, name: string, target: CatalogTarget | undefined) {
  const targets = { ...catalog.targets[realm] }
  if (target === undefined) delete targets[name]
  else targets[name] = target
  return { ...catalog, targets: { ...catalog.targets, [realm]: targets } }
}

const deps = (catalog: SerializedCatalog): Partial<Deps> => ({ loadCatalog: () => catalog })

describe('catalogStatus (§4 Catalog versions)', () => {
  test('a finding on a retained target carries catalogStatus retained, and one on a current target none', async () => {
    const fetch = shipped.targets.window['Window.fetch']!
    const catalog = withTarget(shipped, 'window', 'Window.fetch', { ...fetch, catalogStatus: 'retained' })

    const { report } = await scanBuild({ 'index.html': page, 'main.js': 'window.fetch = a\nwindow.setTimeout = b\n' }, [], {
      deps: deps(catalog),
    })

    expect(report.findings.map((finding: { target: { name: string }; catalogStatus?: string }) => [
      finding.target.name,
      finding.catalogStatus,
    ])).toEqual([
      ['Window.fetch', 'retained'],
      ['Window.setTimeout', undefined],
    ])
  })
})

/** `catalog` as catalog version `version`. */
const at = (catalog: SerializedCatalog, version: number): SerializedCatalog => ({
  ...catalog,
  metadata: { ...catalog.metadata, catalogVersion: version },
})

/**
 * A synthetic two-version catalog: `v1` and `v2` become catalog versions 1 and 2, and the changelog is the one the
 * generator writes between them.
 */
function versions(v1: SerializedCatalog, v2: SerializedCatalog) {
  const one = at(v1, 1)
  const two = at(v2, 2)
  const changelog = { versions: [{ catalogVersion: 2, changes: changeRecords(one, two) }] }
  return {
    v1: { loadCatalog: () => one } satisfies Partial<Deps>,
    v2: { loadCatalog: () => two, loadChangelog: () => changelog } satisfies Partial<Deps>,
  }
}

type Catalogs = ReturnType<typeof versions>

/**
 * Writes a baseline of `before` under catalog version 1, then scans `after` (`before` when not given) under version 2
 * against it, with `args` (`--surface all` by default) and `deps`, and returns the validated report's findings.
 */
async function upgrade(
  catalogs: Catalogs,
  before: string | Record<string, string>,
  after: string | Record<string, string> = before,
  { args = ['--surface', 'all'], deps = {} }: { args?: string[]; deps?: Partial<Deps> } = {},
) {
  const cwd = workingDir()
  const init = await runCli(['baseline', 'init', build(before), '--map', defaultMap, ...args], {
    cwd,
    deps: { ...deps, ...catalogs.v1 },
  })
  if (init.exitCode !== 0) throw new Error(`baseline init exited ${init.exitCode}:\n${init.stderr}`)
  const argv = ['scan', build(after), '--map', defaultMap, '--json', '-', '--baseline', 'monkeypatchlist.baseline.json', ...args]
  const run = await runCli(argv, { cwd, deps: { ...deps, ...catalogs.v2 } })
  if (run.exitCode !== 0) throw new Error(`scan exited ${run.exitCode}:\n${run.stderr}`)
  const report = JSON.parse(run.stdout)
  assertValidReport(report)
  return { cwd, findings: report.findings as Delta[] }
}

interface Delta {
  fingerprint: string
  baselineState: string
  changedReasons: { reason: string; before: unknown; after: unknown }[]
  explainedBy?: { catalogVersion: number; kind: string; [field: string]: unknown }[]
}

/** Each finding's fingerprint, state and the kinds and names of its `explainedBy` records. */
const explained = (findings: Delta[]) =>
  findings.map(({ fingerprint, baselineState, explainedBy }) => [
    fingerprint,
    baselineState,
    explainedBy?.map(({ catalogVersion, kind, change, name, holder, id }) =>
      [catalogVersion, kind, change, name ?? holder ?? id].filter((part) => part !== undefined).join(' '),
    ),
  ])

describe('explainedBy: target added or deliberately dropped (§4 table)', () => {
  const setHTMLUnsafe = 'Element.prototype.setHTMLUnsafe'

  test('a target added explains an added finding that shadows it, and a target dropped a removed one', async () => {
    const foo: CatalogTarget = { ...shipped.targets.window['EventTarget.prototype.addEventListener']!, member: 'foo' }
    const withFoo = withTarget(shipped, 'window', 'EventTarget.prototype.foo', foo)

    const added = await upgrade(versions(shipped, withFoo), 'window.fetch = a\n', 'window.fetch = a\nwindow.foo = w\n')
    const removed = await upgrade(versions(withFoo, shipped), 'window.fetch = a\nwindow.foo = w\n', 'window.fetch = a\n')

    expect(explained(added.findings)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing', undefined],
      ['window|Window.foo|replace|unknown', 'added', ['2 target added EventTarget.prototype.foo']],
    ])
    expect(explained(removed.findings)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing', undefined],
      ['window|Window.foo|replace|unknown', 'removed', ['2 target dropped EventTarget.prototype.foo']],
    ])
  })

  test('a target added or dropped explains the add ↔ replace flip of a member that shadows it', async () => {
    const without = withTarget(shipped, 'window', setHTMLUnsafe, undefined)
    const code = 'HTMLDivElement.prototype.setHTMLUnsafe = f\n'

    const flipped = await upgrade(versions(without, shipped), code)
    const back = await upgrade(versions(shipped, without), code)

    expect(explained(flipped.findings)).toEqual([
      ['window|HTMLDivElement.prototype.setHTMLUnsafe|replace|unknown', 'changed', [`2 target added ${setHTMLUnsafe}`]],
    ])
    expect(flipped.findings[0]!.changedReasons).toEqual([{ reason: 'effect', before: 'add', after: 'replace' }])
    expect(explained(back.findings)).toEqual([
      ['window|HTMLDivElement.prototype.setHTMLUnsafe|add|unknown', 'changed', [`2 target dropped ${setHTMLUnsafe}`]],
    ])
  })
})

describe('where explainedBy is never set (§4 Catalog versions)', () => {
  const foo: CatalogTarget = { ...shipped.targets.window['EventTarget.prototype.addEventListener']!, member: 'foo' }
  const withFoo = withTarget(shipped, 'window', 'EventTarget.prototype.foo', foo)

  test('an unconfirmed entry carries none, though its target was dropped', async () => {
    // `broken.js` doesn't parse, so the scan is incomplete and a missing entry is unconfirmed (§13).
    const page = '<script src="main.js"></script><script src="broken.js"></script>'
    const after = { 'index.html': page, 'main.js': 'window.fetch = a\n', 'broken.js': 'window.x = (' }

    const { findings } = await upgrade(versions(withFoo, shipped), 'window.fetch = a\nwindow.foo = w\n', after)

    expect(explained(findings)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing', undefined],
      ['window|Window.foo|replace|unknown', 'unconfirmed', undefined],
    ])
  })

  test('baseline update prints each accepted delta with its explainedBy, and writes none into the baseline', async () => {
    const catalogs = versions(shipped, withFoo)
    const { cwd } = await upgrade(catalogs, 'window.fetch = a\n', 'window.fetch = a\nwindow.foo = w\n')
    const code = 'window.fetch = a\nwindow.foo = w\n'

    const run = await runCli(['baseline', 'update', build(code), '--map', defaultMap, '--surface', 'all'], {
      cwd,
      deps: catalogs.v2,
    })

    expect(run.exitCode).toBe(0)
    const accepted = run.stdout.slice(run.stdout.indexOf('Accepted into')).trimEnd().split('\n')
    expect(accepted).toEqual([
      'Accepted into monkeypatchlist.baseline.json',
      '  Added 1',
      '    window|Window.foo|replace|unknown',
      '      explained by catalog 2: target added EventTarget.prototype.foo (window)',
      '  Changed 0',
      '  Removed 0',
    ])
    const baseline = readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8')
    expect(JSON.parse(baseline).entries).toHaveLength(2)
    expect(baseline).not.toContain('explainedBy')
  })
})

/** The shipped catalog with the protected-surface entry for `member` of `name` left out of `surface`. */
function withoutEntry(catalog: SerializedCatalog, surface: Surface, name: string, member?: string): SerializedCatalog {
  const entries = catalog.protectedSurface[surface]!.filter((entry) => entry.interface !== name || entry.member !== member)
  return { ...catalog, protectedSurface: { ...catalog.protectedSurface, [surface]: entries } }
}

/** The shipped catalog with `name`'s holder in `realm` replaced by `holder`, or removed when it is undefined. */
function withHolder(catalog: SerializedCatalog, realm: Realm, name: string, holder: CatalogHolder | undefined) {
  const holders = { ...catalog.holders[realm] }
  if (holder === undefined) delete holders[name]
  else holders[name] = holder
  return { ...catalog, holders: { ...catalog.holders, [realm]: holders } }
}

describe('explainedBy: protected entry gained or lost (§4 table, §12)', () => {
  const without = withoutEntry(shipped, 'networking', 'Navigator', 'sendBeacon')
  const code = 'window.fetch = a\nnavigator.sendBeacon = w\n'
  const protectedScope = { args: ['--surface', 'protected'] }

  test('a gained entry explains the findings it brings into scope, and a lost one those it takes out', async () => {
    const gained = await upgrade(versions(without, shipped), code, code, protectedScope)
    const lost = await upgrade(versions(shipped, without), code, code, protectedScope)

    expect(explained(gained.findings)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing', undefined],
      ['window|navigator.sendBeacon|replace|unknown', 'added', ['2 protected-entry gained']],
    ])
    expect(gained.findings[1]!.explainedBy![0]).toMatchObject({ surface: 'networking', entry: { interface: 'Navigator', member: 'sendBeacon' } })
    expect(explained(lost.findings)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing', undefined],
      ['window|navigator.sendBeacon|replace|unknown', 'removed', ['2 protected-entry lost']],
    ])
  })

  test("a gained entry explains a wildcard on its holder (a wildcard's holder is in the diff)", async () => {
    const before = withoutEntry(shipped, 'diagnostics', 'console')
    const wildcard = 'cfg.levels.forEach(function(k){ console[k] = wrap(console[k]) })\n'

    const { findings } = await upgrade(versions(before, shipped), wildcard, wildcard, protectedScope)

    expect(explained(findings)).toEqual([['window|console.*|wrap|unknown', 'added', ['2 protected-entry gained']]])
  })

  test('under --surface all, an entry change explains nothing', async () => {
    const { findings } = await upgrade(versions(without, shipped), 'window.fetch = a\n', code)

    expect(explained(findings)).toEqual([
      ['window|Window.fetch|replace|unknown', 'existing', undefined],
      ['window|navigator.sendBeacon|replace|unknown', 'added', undefined],
    ])
  })
})

describe('explainedBy: descriptor or assign kind (§4 table)', () => {
  const fetch = shipped.targets.window['Window.fetch']!
  const locked = withTarget(shipped, 'window', 'Window.fetch', {
    ...fetch,
    descriptor: { type: 'data', writable: false, enumerable: true, configurable: false },
  })

  test('a write that was ineffective is added, and one that becomes ineffective removed', async () => {
    const code = 'window.fetch = a\nwindow.setTimeout = b\n'

    const effective = await upgrade(versions(locked, shipped), code)
    const ineffective = await upgrade(versions(shipped, locked), code)

    expect(explained(effective.findings)).toEqual([
      ['window|Window.fetch|replace|unknown', 'added', ['2 member-data Window.fetch']],
      ['window|Window.setTimeout|replace|unknown', 'existing', undefined],
    ])
    expect(effective.findings[0]!.explainedBy![0]).toMatchObject({
      before: { descriptor: { writable: false } },
      after: { descriptor: { writable: true } },
    })
    expect(explained(ineffective.findings)).toEqual([
      ['window|Window.fetch|replace|unknown', 'removed', ['2 member-data Window.fetch']],
      ['window|Window.setTimeout|replace|unknown', 'existing', undefined],
    ])
  })

  test('a member entering a holder\'s enumeration explains the wildcard-expanded finding it adds', async () => {
    const log = shipped.targets.window['console.log']!
    const hidden = withTarget(shipped, 'window', 'console.log', { ...log, descriptor: { ...log.descriptor, enumerable: false } })
    const code = 'for (const k in console) if (k === "log" || k === "warn") console[k] = wrap(console[k])\n'

    const { findings } = await upgrade(versions(hidden, shipped), code)

    expect(explained(findings)).toEqual([
      ['window|console.log|wrap|unknown', 'added', ['2 member-data console.log']],
      ['window|console.warn|wrap|unknown', 'existing', undefined],
    ])
  })
})

describe('explainedBy: holders (§4 table)', () => {
  test('WindowProperties added between Window.prototype and EventTarget.prototype explains the move it makes', async () => {
    const windowPrototype = shipped.holders.window['Window.prototype']!
    const before = withHolder(
      withHolder(shipped, 'window', 'WindowProperties', undefined),
      'window',
      'Window.prototype',
      { ...windowPrototype, proto: 'EventTarget.prototype' },
    )

    const { findings } = await upgrade(versions(before, shipped), 'window.__proto__.__proto__.addEventListener = w\n')

    expect(explained(findings)).toEqual([
      [
        'window|EventTarget.prototype.addEventListener|replace|unknown',
        'removed',
        ['2 holder rechained Window.prototype', '2 holder added WindowProperties'],
      ],
      [
        'window|WindowProperties.addEventListener|replace|unknown',
        'added',
        ['2 holder rechained Window.prototype', '2 holder added WindowProperties'],
      ],
    ])
  })

  test("a holder's immutablePrototype explains its prototype-change", async () => {
    const div = shipped.holders.window['HTMLDivElement.prototype']!
    const immutable = withHolder(shipped, 'window', 'HTMLDivElement.prototype', { ...div, immutablePrototype: true })
    const code = 'Object.setPrototypeOf(HTMLDivElement.prototype, P)\nwindow.fetch = a\n'

    const { findings } = await upgrade(versions(immutable, shipped), code)

    expect(explained(findings)).toEqual([
      ['window|HTMLDivElement.prototype.[[Prototype]]|prototype-change|unknown', 'added', ['2 immutable-prototype HTMLDivElement.prototype']],
      ['window|Window.fetch|replace|unknown', 'existing', undefined],
    ])
  })
})

describe('explainedBy: framework path rules and URL normalization rules (§4 table)', () => {
  const nextSource = 'webpack://_N_E/../../src/client/components/app-router.tsx'
  const code = 'window.fetch = w'
  const mapped = {
    'index.html': page,
    'main.js': code,
    'main.js.map': JSON.stringify({
      version: 3,
      sources: [nextSource],
      sourcesContent: [code],
      names: [],
      mappings: mappings(identityMappings(code, 0)),
    }),
  }

  test('a framework path rule added explains the rekeyed pair it makes, by rule id', async () => {
    const rules = { ...shipped.frameworkPathRules }
    delete rules['next-webpack-client']
    const before = { ...shipped, frameworkPathRules: rules }

    const { findings } = await upgrade(versions(before, shipped), mapped)

    expect(explained(findings)).toEqual([['window|Window.fetch|replace|pkg:next', 'existing', ['2 framework-path-rule added next-webpack-client']]])
  })

  test('a framework path rule changed explains the changed (attribution) pair it makes', async () => {
    const rule = shipped.frameworkPathRules['next-webpack-client']!
    const before = { ...shipped, frameworkPathRules: { ...shipped.frameworkPathRules, 'next-webpack-client': { ...rule, package: 'next-old' } } }

    const { findings } = await upgrade(versions(before, shipped), mapped)

    expect(explained(findings)).toEqual([['window|Window.fetch|replace|pkg:next', 'changed', ['2 framework-path-rule changed next-webpack-client']]])
  })

  test('a URL normalization rule added explains the changed (attribution) pair it makes', async () => {
    const normalization = shipped.remoteUrlNormalization
    const before = {
      ...shipped,
      remoteUrlNormalization: { ...normalization, path: normalization.path.filter(({ id }) => id !== 'filename-version-run') },
    }
    const html = '<script src="https://cdn.example/lib-1.2.3.min.js"></script>'
    const resolve = {
      args: ['--surface', 'all', '--mode', 'resolve'],
      deps: {
        resolveFetcher: () =>
          fixtureFetcher({
            'https://cdn.example/lib-1.2.3.min.js': { headers: { 'content-type': 'text/javascript' }, body: code },
          }),
      },
    }

    const { findings } = await upgrade(versions(before, shipped), { 'index.html': html }, { 'index.html': html }, resolve)

    expect(explained(findings)).toEqual([
      ['window|Window.fetch|replace|url:https://cdn.example/lib-*.min.js', 'changed', ['2 url-normalization added filename-version-run']],
    ])
  })
})

describe('explainedBy: URL normalization added / removed pair (§4 table)', () => {
  const finding = (state: 'added' | 'removed' | 'existing', key: string, name = 'Window.fetch') => ({
    target: { realm: 'window' as const, name },
    effect: 'replace',
    attribution: { key },
    baselineState: state,
    changedReasons: [],
    notes: [],
    occurrences: [],
  })
  const record = { kind: 'url-normalization' as const, change: 'added' as const, id: 'filename-version-run', after: {} }
  const explain = (findings: ReturnType<typeof finding>[]) =>
    withExplainedBy(findings, {
      catalog: at(shipped, 2),
      changelog: { versions: [{ catalogVersion: 2, changes: [record] }] },
      baselineCatalogVersion: 1,
      surface: 'all',
    }).map(({ baselineState, explainedBy }) => [baselineState, explainedBy?.length ?? 0])

  test('a rule explains an added and a removed url: finding of the same target and effect', () => {
    expect(explain([finding('added', 'url:https://a/lib-*.js'), finding('removed', 'url:https://a/lib-1.js')])).toEqual([
      ['added', 1],
      ['removed', 1],
    ])
  })

  test('a lone added url: finding, or one whose counterpart is another target, is not explained', () => {
    expect(explain([finding('added', 'url:https://a/lib-*.js')])).toEqual([['added', 0]])
    expect(
      explain([finding('added', 'url:https://a/lib-*.js'), finding('removed', 'url:https://a/lib-1.js', 'Window.open')]),
    ).toEqual([
      ['added', 0],
      ['removed', 0],
    ])
  })
})

describe('explainedBy: surface reassignment (§4 table)', () => {
  test('a surface reassignment gives no change record and explains nothing', async () => {
    const fetch = shipped.targets.window['Window.fetch']!
    const before = withTarget(shipped, 'window', 'Window.fetch', { ...fetch, surface: 'other' })

    expect(changeRecords(at(before, 1), at(shipped, 2))).toEqual([])
    const { findings } = await upgrade(versions(before, shipped), 'window.fetch = a\n')
    expect(explained(findings)).toEqual([['window|Window.fetch|replace|unknown', 'existing', undefined]])
  })
})

describe('the changelog the generator writes (§4 Catalog versions)', () => {
  const withFoo = withTarget(shipped, 'window', 'EventTarget.prototype.foo', {
    ...shipped.targets.window['EventTarget.prototype.addEventListener']!,
    member: 'foo',
  })

  test('the first catalog version has no records; a later one keeps the earlier versions and adds its own', () => {
    const two = { catalogVersion: 2, changes: changeRecords(shipped, withFoo) }

    expect(JSON.parse(changelog({ catalog: at(shipped, 1), previous: undefined, committed: undefined }))).toEqual({ versions: [] })
    expect(JSON.parse(changelog({ catalog: at(withFoo, 2), previous: shipped, committed: { versions: [] } }))).toEqual({
      versions: [two],
    })
    expect(JSON.parse(changelog({ catalog: at(withFoo, 3), previous: withFoo, committed: { versions: [two] } }))).toEqual({
      versions: [two, { catalogVersion: 3, changes: [] }],
    })
    expect(() => changelog({ catalog: at(withFoo, 2), previous: undefined, committed: undefined })).toThrow(
      /needs the last catalog of version 1/,
    )
  })

  test('catalog:check fails on a changelog that is not the one the generator writes', () => {
    const committed = changelog({ catalog: at(withFoo, 2), previous: shipped, committed: undefined })

    expect(changelogProblems({ catalog: at(withFoo, 2), previous: shipped, committed })).toEqual([])
    expect(changelogProblems({ catalog: at(withFoo, 2), previous: withFoo, committed })).toEqual([
      'catalog/changelog.json is not the changelog from the last catalog of the previous version. Run `npm run catalog` and commit the result.',
    ])
  })

  test('the shipped changelog is the one the generator writes for the shipped catalog', () => {
    const committed = readFileSync(new URL('../catalog/changelog.json', import.meta.url), 'utf8')

    expect(shipped.metadata.catalogVersion).toBe(1)
    expect(changelogProblems({ catalog: shipped, previous: undefined, committed })).toEqual([])
  })
})

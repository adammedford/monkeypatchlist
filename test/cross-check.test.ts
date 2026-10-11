import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { CatalogHolder, CatalogTarget } from '../src/index.ts'
import { canonicalJson } from '../tools/catalog-generator/canonical-json.ts'
import { crossCheck, crossCheckProblems, type Bcd, type SesPermits } from '../tools/catalog-generator/cross-check.ts'

const data = { type: 'data', writable: true, enumerable: false, configurable: true } as const

/** A catalog target, as the cross-check reads it. */
function target(owner: string, member: string, holder: CatalogTarget['holder'], spec: string): CatalogTarget {
  const surface = spec === 'ecma262' || spec === 'ecma402' ? 'ECMAScript' : 'other'
  return { owner, member, holder, kind: 'function', spec, descriptor: data, surface }
}

const holder = (kind: CatalogHolder['kind'], owner: string, proto: string | null): CatalogHolder => ({ kind, owner, proto })

/**
 * A small catalog: `Array` with `from` and `prototype.map`, `%TypedArray%.prototype.at`, `Intl.DateTimeFormat`, and
 * the Web IDL `History.prototype.back`, `Navigator.prototype.userAgent` and `.contacts`, `Window.fetch` and
 * `console.log`, in the window realm, and `History` in no worker realm.
 */
function catalogText(
  extra: { retained?: object; targets?: Record<string, CatalogTarget>; engineExtensions?: object } = {},
) {
  const window = {
    'Window.Object': { ...target('Window', 'Object', 'global', 'ecma262'), holds: 'Object' },
    'Window.Function': { ...target('Window', 'Function', 'global', 'ecma262'), holds: 'Function' },
    'Object.prototype': { ...target('Object', 'prototype', 'constructor', 'ecma262'), kind: 'value', holds: 'Object.prototype' },
    'Function.prototype': { ...target('Function', 'prototype', 'constructor', 'ecma262'), holds: 'Function.prototype' },
    'Function.prototype.constructor': { ...target('Function', 'constructor', 'prototype', 'ecma262'), holds: 'Function' },
    'Window.Array': { ...target('Window', 'Array', 'global', 'ecma262'), holds: 'Array' },
    'Window.Intl': { ...target('Window', 'Intl', 'global', 'ecma402'), kind: 'namespace', holds: 'Intl' },
    'Array.from': target('Array', 'from', 'constructor', 'ecma262'),
    'Array.prototype': { ...target('Array', 'prototype', 'constructor', 'ecma262'), kind: 'value', holds: 'Array.prototype' },
    'Array.prototype.map': target('Array', 'map', 'prototype', 'ecma262'),
    '%TypedArray%.prototype': {
      ...target('%TypedArray%', 'prototype', 'constructor', 'ecma262'),
      kind: 'value',
      holds: '%TypedArray%.prototype',
    },
    '%TypedArray%.prototype.at': target('%TypedArray%', 'at', 'prototype', 'ecma262'),
    'Intl.DateTimeFormat.prototype.format': target('Intl.DateTimeFormat', 'format', 'prototype', 'ecma402'),
    'History.prototype.back': target('History', 'back', 'prototype', 'html'),
    'Navigator.prototype.userAgent': target('Navigator', 'userAgent', 'prototype', 'html'),
    'Navigator.prototype.contacts': target('Navigator', 'contacts', 'prototype', 'html'),
    'Window.fetch': { ...target('Window', 'fetch', 'global', 'fetch'), mixin: 'WindowOrWorkerGlobalScope' },
    'console.log': target('console', 'log', 'namespace', 'console'),
    ...extra.targets,
  }
  const holders = {
    Window: holder('global', 'Window', 'Object.prototype'),
    Object: holder('constructor', 'Object', 'Function.prototype'),
    'Object.prototype': holder('prototype', 'Object', null),
    Function: holder('constructor', 'Function', 'Function.prototype'),
    'Function.prototype': holder('prototype', 'Function', 'Object.prototype'),
    Array: holder('constructor', 'Array', 'Function.prototype'),
    'Array.prototype': holder('prototype', 'Array', 'Object.prototype'),
    '%TypedArray%': holder('constructor', '%TypedArray%', 'Function.prototype'),
    '%TypedArray%.prototype': holder('prototype', '%TypedArray%', 'Object.prototype'),
    Intl: holder('namespace', 'Intl', 'Object.prototype'),
    'Intl.DateTimeFormat': holder('constructor', 'Intl.DateTimeFormat', 'Function.prototype'),
    'Intl.DateTimeFormat.prototype': holder('prototype', 'Intl.DateTimeFormat', 'Object.prototype'),
    History: holder('constructor', 'History', 'Function.prototype'),
    'History.prototype': holder('prototype', 'History', 'Object.prototype'),
    Navigator: holder('constructor', 'Navigator', 'Function.prototype'),
    'Navigator.prototype': holder('prototype', 'Navigator', 'Object.prototype'),
    console: holder('namespace', 'console', 'Object.prototype'),
  }
  const none = { window: {}, 'dedicated-worker': {}, 'shared-worker': {}, 'service-worker': {} }
  return canonicalJson({
    metadata: { catalogVersion: 2, upstream: { '@webref/idl': '1.0.0' }, overlays: {} },
    targets: { ...none, window },
    holders: { ...none, window: holders },
    retained: extra.retained ?? { targets: none, holders: none, dropped: none },
    ...(extra.engineExtensions && { engineExtensions: extra.engineExtensions }),
  })
}

/**
 * SES's permits for `Object`, `Function`, `Array` and `%TypedArray%`, which it names differently (`%UniqueFunction%`
 * and `%InertFunction%` are both `Function`), SES's own `harden`, `%ThrowTypeError%`, which no property reaches, an
 * intrinsic SES suppresses, and nothing for `Intl`.
 */
const ses: SesPermits = {
  globals: { Array: 'Array', Function: '%UniqueFunction%', Object: 'Object', harden: 'harden' },
  intrinsics: {
    Object: { proto: '%FunctionPrototype%', properties: { prototype: '%ObjectPrototype%' } },
    '%ObjectPrototype%': { proto: null, properties: {} },
    '%UniqueFunction%': { proto: '%FunctionPrototype%', properties: { prototype: '%FunctionPrototype%' } },
    '%FunctionPrototype%': { proto: '%ObjectPrototype%', properties: { constructor: '%InertFunction%' } },
    '%InertFunction%': { proto: '%FunctionPrototype%', properties: { prototype: '%FunctionPrototype%' } },
    Array: { proto: '%FunctionPrototype%', properties: { from: 'fn', of: 'fn', prototype: '%ArrayPrototype%' } },
    '%ArrayPrototype%': { proto: '%ObjectPrototype%', properties: { map: 'fn', length: 'number', group: 'fn' } },
    '%TypedArray%': { proto: '%FunctionPrototype%', properties: { prototype: '%TypedArrayPrototype%' } },
    '%TypedArrayPrototype%': { proto: '%ArrayPrototype%', properties: { at: false } },
    '%ThrowTypeError%': 'fn',
    '%SharedArrayBufferPrototype%': false,
    harden: 'fn',
  },
}

/** The browsers and runtimes the BCD fixture has support statements for, as BCD names them. */
const browsers = ['chrome', 'chrome_android', 'edge', 'firefox', 'firefox_android', 'nodejs', 'safari', 'safari_ios', 'webview_android']

/** A BCD feature with support in the named engines only, from version 10. */
function feature(engines: string[], status = { standard_track: true, deprecated: false }, children: object = {}) {
  const support = Object.fromEntries(
    browsers.map((engine) => [engine, { version_added: engines.includes(engine) ? '10' : false }]),
  )
  return { __compat: { support, status }, ...children }
}

/** A BCD feature whose only support is this statement, in one engine. */
function supportedAs(engine: string, statement: object) {
  const support = Object.fromEntries(browsers.map((name) => [name, name === engine ? statement : { version_added: false }]))
  return { __compat: { support, status: { standard_track: true, deprecated: false } } }
}

const desktop = ['chrome', 'firefox', 'safari']

/**
 * Each fixture browser's releases, as BCD's `browsers` gives them: released versions are `retired`, `current` or `esr`,
 * and `30`, `31` and `32` are a beta, a nightly and a planned version.
 */
const releases = {
  '3': { status: 'retired' },
  '10': { status: 'retired' },
  '15': { status: 'retired' },
  '18': { status: 'retired' },
  '20': { status: 'esr' },
  '21': { status: 'current' },
  '30': { status: 'beta' },
  '31': { status: 'nightly' },
  '32': { status: 'planned' },
}

const bcd: Bcd = {
  browsers: Object.fromEntries(browsers.map((browser) => [browser, { releases }])),
  api: {
    History: feature(desktop, undefined, { back: feature(desktop), forward: feature(desktop), popstate_event: feature(desktop) }),
    console: feature(desktop, undefined, { log_static: feature(desktop), table_static: feature(['firefox']) }),
    fetch: feature(desktop),
    Navigator: feature(desktop, undefined, {
      joinAdInterestGroup: feature(['chrome'], { standard_track: false, deprecated: true }),
      webkitGetUserMedia: {
        __compat: {
          support: { chrome: { version_added: '21', prefix: 'webkit' }, firefox: { version_added: false }, safari: { version_added: false } },
          status: { standard_track: false, deprecated: true },
        },
      },
      userAgent: feature(desktop),
      // Shipped only by a mobile engine.
      contacts: feature(['chrome_android']),
      share: feature(['safari_ios', 'firefox_android']),
    }),
    ContactsManager: feature(['chrome_android'], undefined, { select: feature(['chrome_android']) }),
    SharedStorage: feature(['chrome'], undefined, { clear: feature(['chrome']), get: feature(['chrome']) }),
  },
  javascript: {
    builtins: {
      // `Array.Array` is BCD's feature for the constructor itself, which is no property.
      Array: feature(desktop, undefined, { Array: feature(desktop), from: feature(desktop), map: feature(desktop), of: feature(desktop) }),
      TypedArray: feature(desktop, undefined, { at: feature(desktop), findLast: feature(desktop) }),
      Intl: feature(desktop, undefined, { DateTimeFormat: feature(desktop, undefined, { format: feature([]) }) }),
    },
  },
}

const pins = { ses: '2.3.0', bcd: '8.1.3' }
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** The lines of one section of a cross-check report. */
function section(report: string, heading: string): string[] {
  const start = report.indexOf(`\n## ${heading} (`)
  expect(start, heading).toBeGreaterThan(-1)
  const body = report.slice(start + 1).split('\n## ')[0]!
  return body.split('\n').filter((line) => line.startsWith('- '))
}

describe('cross-check against SES permits and BCD', () => {
  const text = catalogText()
  const report = crossCheck(text, { ses, bcd, pins })

  test('names the catalog it checks and the SES and BCD versions, and says it changes nothing', () => {
    expect(report.startsWith('# Catalog cross-check\n\n')).toBe(true)
    expect(report).toContain('checks, never sources')
    expect(report).toContain(`\n- Catalog: catalog version 2 (catalog sha256 \`${sha256(text)}\`)\n`)
    expect(report).toContain('\n- SES: `ses` 2.3.0 (`src/permits.js`)\n- BCD: `@mdn/browser-compat-data` 8.1.3\n')
  })

  test('says which engines count as shipping: desktop and mobile Chrome, Firefox and Safari, even partly', () => {
    expect(report).toContain(
      'An engine ships a BCD feature when Chrome, Firefox, Safari, Chrome Android, Firefox Android or Safari iOS ' +
        'supports it in a released version, even partly, without a prefix, flag or alternative name, and has not ' +
        'removed it in a released version. A released version is one BCD marks current, ESR or retired: a preview, ' +
        'beta, nightly or planned version does not count.',
    )
  })

  test('lists what SES permits that the catalog lacks, naming SES intrinsics by their catalog path', () => {
    expect(section(report, 'SES permits, the catalog lacks')).toEqual([
      '- `%ThrowTypeError%` (no catalog holder)',
      '- `Array.of`',
      '- `Array.prototype.group`',
      '- `Window.harden`',
    ])
  })

  test('lists the ECMAScript targets SES does not permit, or removes', () => {
    expect(section(report, 'The catalog has, SES does not permit')).toEqual([
      '- `%TypedArray%.prototype.at`',
      '- `Intl.DateTimeFormat.prototype` (no SES record; 1 target)',
      '- `Window.Intl`',
    ])
  })

  test('lists the prototype links that differ from SES', () => {
    expect(section(report, 'Prototype links that differ from SES')).toEqual([
      '- `%TypedArray%.prototype`: catalog `Object.prototype`, SES `Array.prototype`',
    ])
  })

  test('lists what BCD shows an engine ships unprefixed that the catalog lacks: an interface once, with its members', () => {
    expect(section(report, 'BCD shows an engine ships, the catalog lacks')).toEqual([
      '- `api.ContactsManager` and 1 member (chrome_android)',
      '- `api.History.forward` (chrome, firefox, safari)',
      '- `api.Navigator.joinAdInterestGroup` (chrome; non-standard, deprecated)',
      '- `api.Navigator.share` (firefox_android, safari_ios)',
      '- `api.SharedStorage` and 2 members (chrome)',
      '- `api.console.table_static` (firefox)',
      '- `javascript.builtins.Array.of` (chrome, firefox, safari)',
      '- `javascript.builtins.TypedArray.findLast` (chrome, firefox, safari)',
    ])
  })

  test('lists the targets whose BCD feature no engine ships: a feature only a mobile engine ships is shipped', () => {
    expect(section(report, 'The catalog has, BCD shows no engine ships')).toEqual([
      '- `Intl.DateTimeFormat.prototype.format`: `javascript.builtins.Intl.DateTimeFormat.format`',
    ])
  })

  test('checks retained targets, and the drops of targets and holders, against BCD', () => {
    const none = { window: {}, 'dedicated-worker': {}, 'shared-worker': {}, 'service-worker': {} }
    const retention = { lastUpstream: '@webref/idl 1.0.0', reason: 'Discontinued.' }
    const retained = {
      targets: { ...none, window: { 'Intl.DateTimeFormat.prototype.format': retention, 'History.prototype.back': retention } },
      holders: none,
      dropped: {
        ...none,
        window: {
          'Navigator.prototype.joinAdInterestGroup': { bcd: 'api.Navigator.joinAdInterestGroup', evidence: 'None ships it.' },
          'Navigator.prototype.gone': { bcd: 'api.Navigator.gone', evidence: 'BCD has no entry.' },
        },
      },
      droppedHolders: { ...none, window: { 'SharedStorage.prototype': { bcd: 'api.SharedStorage', evidence: 'None ships it.' } } },
    }
    const checked = crossCheck(catalogText({ retained }), { ses, bcd, pins })

    expect(section(checked, 'Retained, but BCD shows no engine ships')).toEqual([
      '- `Intl.DateTimeFormat.prototype.format` (window): `javascript.builtins.Intl.DateTimeFormat.format`',
    ])
    expect(section(checked, 'Dropped, but BCD shows an engine ships')).toEqual([
      '- `Navigator.prototype.joinAdInterestGroup` (window): `api.Navigator.joinAdInterestGroup` (chrome)',
      '- `SharedStorage.prototype` (window, holder): `api.SharedStorage` (chrome)',
    ])
  })

  test('an engine extension is an ECMAScript target: SES and BCD check it as one', () => {
    const engine = { engine: 'v8', source: 'V8, for this test', kind: 'function', descriptor: data }
    const extended = catalogText({
      targets: { 'Array.captureStack': target('Array', 'captureStack', 'constructor', 'v8') },
      engineExtensions: { 'Array.captureStack': engine },
    })
    const array = { ...bcd.javascript.builtins.Array!, captureStack: feature(['chrome']) }
    const withFeature = { ...bcd, javascript: { builtins: { ...bcd.javascript.builtins, Array: array } } }
    const checked = crossCheck(extended, { ses, bcd: withFeature, pins })

    expect(section(checked, 'The catalog has, SES does not permit')).toContain('- `Array.captureStack`')
    expect(section(checked, 'BCD shows an engine ships, the catalog lacks')).toEqual(
      section(report, 'BCD shows an engine ships, the catalog lacks'),
    )
  })

  test('is the same report whatever order its inputs list things in', () => {
    const reversed = <T extends object>(record: T): T =>
      Object.fromEntries(Object.entries(record).reverse().map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? reversed(v) : v])) as T

    expect(crossCheck(text, { ses: reversed(ses), bcd: reversed(bcd), pins })).toBe(report)
  })
})

describe('cross-check drift', () => {
  const text = catalogText()

  test('passes when the committed report is the one written from the committed catalog, and fails when it is stale', () => {
    const report = crossCheck(text, { ses, bcd, pins })
    const rerun = 'catalog/cross-check.md is not the cross-check of catalog/catalog.json against the pinned SES and BCD. Run `npm run catalog` and commit the result.'

    expect(crossCheckProblems(text, report, { ses, bcd, pins })).toEqual([])
    expect(crossCheckProblems(text, report, { ses, bcd, pins: { ...pins, bcd: '8.1.4' } })).toEqual([rerun])
    expect(crossCheckProblems(text, undefined, { ses, bcd, pins })).toEqual([rerun])
  })

  describe('drops', () => {
    const none = { window: {}, 'dedicated-worker': {}, 'shared-worker': {}, 'service-worker': {} }
    /**
     * BCD with `api.Support`, whose members each have one support statement, in one engine: shipped in a mobile
     * engine, partly, in a preview, under another name, prefixed, flagged, removed, or in a browser that doesn't count.
     */
    const support = feature([], undefined, {
      chromeAndroid: supportedAs('chrome_android', { version_added: '18' }),
      safariIos: supportedAs('safari_ios', { version_added: '≤3' }),
      firefoxAndroid: supportedAs('firefox_android', { version_added: true }),
      partly: supportedAs('safari_ios', { version_added: '15', partial_implementation: true, notes: 'Only some.' }),
      preview: supportedAs('chrome_android', { version_added: 'preview' }),
      renamed: supportedAs('firefox_android', { version_added: '10', alternative_name: 'mozRenamed' }),
      prefixed: supportedAs('safari_ios', { version_added: '10', prefix: 'webkit' }),
      flagged: supportedAs('chrome_android', { version_added: '10', flags: [{ type: 'preference', name: 'x' }] }),
      removed: supportedAs('firefox_android', { version_added: '10', version_removed: '20' }),
      removedInPreview: supportedAs('safari_ios', { version_added: '10', version_removed: 'preview' }),
      removedInBeta: supportedAs('chrome_android', { version_added: '≤18', version_removed: '30' }),
      removedInPlanned: supportedAs('firefox_android', { version_added: '20', version_removed: '32' }),
      beta: supportedAs('chrome_android', { version_added: '30' }),
      nightly: supportedAs('firefox_android', { version_added: '31' }),
      planned: supportedAs('safari_ios', { version_added: '32' }),
      unlisted: supportedAs('safari_ios', { version_added: '40' }),
      edge: supportedAs('edge', { version_added: '10' }),
      webview: supportedAs('webview_android', { version_added: '10' }),
      node: supportedAs('nodejs', { version_added: '10' }),
    })
    const sources = { ses, bcd: { ...bcd, api: { ...bcd.api, Support: support } }, pins }
    /** The problems with a catalog that drops these targets and holders in the window realm, its report fresh. */
    const problemsWith = (dropped: object, droppedHolders: object = {}) => {
      const retained = {
        targets: none,
        holders: none,
        dropped: { ...none, window: dropped },
        droppedHolders: { ...none, window: droppedHolders },
      }
      const catalog = catalogText({ retained })
      return crossCheckProblems(catalog, crossCheck(catalog, sources), sources)
    }
    const needs = 'A drop needs BCD evidence that no current engine ships it (§4 Catalog versions): keep it in the retained overlay instead.'

    test('fails on a drop whose BCD feature Chrome, Firefox or Safari ships, target or holder', () => {
      expect(
        problemsWith(
          { 'Navigator.prototype.joinAdInterestGroup': { bcd: 'api.Navigator.joinAdInterestGroup', evidence: 'None ships it.' } },
          { 'SharedStorage.prototype': { bcd: 'api.SharedStorage', evidence: 'None ships it.' } },
        ),
      ).toEqual([
        `\`Navigator.prototype.joinAdInterestGroup\` (window) is dropped, but BCD shows chrome shipping \`api.Navigator.joinAdInterestGroup\`. ${needs}`,
        `The holder \`SharedStorage.prototype\` (window) is dropped, but BCD shows chrome shipping \`api.SharedStorage\`. ${needs}`,
      ])
    })

    test('fails on a drop whose BCD feature only Chrome Android, Safari iOS or Firefox Android ships, even partly', () => {
      const drop = (member: string) => ({ [`Support.prototype.${member}`]: { bcd: `api.Support.${member}`, evidence: 'Desktop lacks it.' } })

      expect(
        problemsWith(
          { ...drop('chromeAndroid'), ...drop('safariIos'), ...drop('firefoxAndroid'), ...drop('partly') },
          { 'ContactsManager.prototype': { bcd: 'api.ContactsManager', evidence: 'Desktop lacks it.' } },
        ),
      ).toEqual([
        `\`Support.prototype.chromeAndroid\` (window) is dropped, but BCD shows chrome_android shipping \`api.Support.chromeAndroid\`. ${needs}`,
        `\`Support.prototype.firefoxAndroid\` (window) is dropped, but BCD shows firefox_android shipping \`api.Support.firefoxAndroid\`. ${needs}`,
        `\`Support.prototype.partly\` (window) is dropped, but BCD shows safari_ios shipping \`api.Support.partly\`. ${needs}`,
        `\`Support.prototype.safariIos\` (window) is dropped, but BCD shows safari_ios shipping \`api.Support.safariIos\`. ${needs}`,
        `The holder \`ContactsManager.prototype\` (window) is dropped, but BCD shows chrome_android shipping \`api.ContactsManager\`. ${needs}`,
      ])
    })

    test('fails on a drop whose only removal is in a preview, beta or planned version, since the released browser still ships it', () => {
      const drop = (member: string) => ({ [`Support.prototype.${member}`]: { bcd: `api.Support.${member}`, evidence: 'Removed.' } })

      expect(problemsWith({ ...drop('removedInPreview'), ...drop('removedInBeta'), ...drop('removedInPlanned') })).toEqual([
        `\`Support.prototype.removedInBeta\` (window) is dropped, but BCD shows chrome_android shipping \`api.Support.removedInBeta\`. ${needs}`,
        `\`Support.prototype.removedInPlanned\` (window) is dropped, but BCD shows firefox_android shipping \`api.Support.removedInPlanned\`. ${needs}`,
        `\`Support.prototype.removedInPreview\` (window) is dropped, but BCD shows safari_ios shipping \`api.Support.removedInPreview\`. ${needs}`,
      ])
    })

    test('accepts a drop whose only support is in a beta, nightly or planned version, or one BCD lists no release for', () => {
      const members = ['beta', 'nightly', 'planned', 'unlisted']
      const dropped = Object.fromEntries(
        members.map((member) => [`Support.prototype.${member}`, { bcd: `api.Support.${member}`, evidence: 'Not released.' }]),
      )

      expect(problemsWith(dropped)).toEqual([])
    })

    test('accepts a drop whose BCD feature ships only prefixed, and one citing a path BCD does not have', () => {
      expect(
        problemsWith(
          {
            'Navigator.prototype.webkitGetUserMedia': { bcd: 'api.Navigator.webkitGetUserMedia', evidence: 'Only prefixed.' },
            'Navigator.prototype.gone': { bcd: 'api.Navigator.gone', evidence: 'BCD has no entry.' },
          },
          { 'Gone.prototype': { bcd: 'api.Gone', evidence: 'BCD has no entry.' } },
        ),
      ).toEqual([])
    })

    test('accepts a drop whose only support is a preview, another name, a prefix, a flag, a removal, or a browser that does not count', () => {
      const members = ['preview', 'renamed', 'prefixed', 'flagged', 'removed', 'edge', 'webview', 'node']
      const dropped = Object.fromEntries(
        members.map((member) => [`Support.prototype.${member}`, { bcd: `api.Support.${member}`, evidence: 'No engine ships it.' }]),
      )

      expect(problemsWith(dropped)).toEqual([])
    })
  })
})

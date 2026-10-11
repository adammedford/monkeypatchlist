import { describe, expect, test } from 'vitest'
import { realms, type CatalogTarget } from '../src/index.ts'
import { generate, type Sources } from '../tools/catalog-generator/generate.ts'
import type { RetainedOverlay } from '../tools/catalog-generator/retained.ts'

const upstream = { '@webref/idl': '1.0.0', webidl2: '24.5.0' }
const bumped = { '@webref/idl': '1.1.0', webidl2: '24.5.0' }

/** The global interfaces of the four realms. */
const globals = `
  [Global=Window, Exposed=Window] interface Window {};
  [Global=(Worker,DedicatedWorker), Exposed=DedicatedWorker] interface DedicatedWorkerGlobalScope {};
  [Global=(Worker,SharedWorker), Exposed=SharedWorker] interface SharedWorkerGlobalScope {};
  [Global=(Worker,ServiceWorker), Exposed=ServiceWorker] interface ServiceWorkerGlobalScope {};`

/** Navigator before and after upstream drops `joinAdInterestGroup`, as `@webref/idl` did when its spec was discontinued. */
const before = `
  [Exposed=Window] interface Navigator {
    readonly attribute DOMString userAgent;
    Promise<undefined> joinAdInterestGroup(AuctionAdInterestGroup group);
  };`
const after = `
  [Exposed=Window] interface Navigator {
    readonly attribute DOMString userAgent;
  };`

/** A whole interface that upstream drops, with the global property that holds it and the attribute that returns one. */
const sharedStorage = `
  [Exposed=Window] interface SharedStorage { Promise<any> clear(); };
  partial interface Window { readonly attribute SharedStorage sharedStorage; };`

const catalogOf = (sources: Omit<Sources, 'upstream'> & { upstream?: Sources['upstream'] }) =>
  JSON.parse(generate({ upstream, ...sources }).catalog)

/** A target's record as the catalog last generated it, without the surface the map gives it. */
function lastGenerated(catalog: { targets: Record<string, Record<string, CatalogTarget>> }, name: string) {
  const target: Partial<CatalogTarget> = { ...catalog.targets.window![name]! }
  delete target.surface
  return target as Omit<CatalogTarget, 'surface'>
}

const reason = 'Its spec was discontinued (browser-specs), but Chrome still ships it.'

/** A monotonic refusal's list of removed targets, and the retained entries it gives to start from. */
function refusalOf(generation: () => unknown) {
  try {
    generation()
  } catch (error) {
    const [list, entries] = (error as Error).message.split('\nRetained entries to start from, each still needing a reason:\n')
    return { list, entries: JSON.parse(entries!) }
  }
  throw new Error('the generation was not refused')
}

describe('retained targets', () => {
  const previous = catalogOf({ idl: { globals, html: before } })
  const retained: RetainedOverlay = {
    targets: {
      window: {
        'Navigator.prototype.joinAdInterestGroup': {
          lastUpstream: '@webref/idl 1.0.0',
          reason,
          target: lastGenerated(previous, 'Navigator.prototype.joinAdInterestGroup'),
        },
      },
    },
    holders: {},
    dropped: {},
  }

  test('a retained target resolves like any other: a target on its holder, with a surface, flagged retained', () => {
    const catalog = catalogOf({
      idl: { globals, html: after },
      upstream: bumped,
      retained,
      surfaces: { owners: { Navigator: 'DOM' }, members: {} },
    })

    expect(catalog.targets.window['Navigator.prototype.joinAdInterestGroup']).toEqual({
      owner: 'Navigator',
      member: 'joinAdInterestGroup',
      holder: 'prototype',
      kind: 'operation',
      spec: 'html',
      descriptor: { type: 'data', writable: true, enumerable: true, configurable: true },
      surface: 'DOM',
      catalogStatus: 'retained',
    })
    expect(catalog.targets.window['Navigator.prototype.userAgent']).not.toHaveProperty('catalogStatus')
    expect(catalog.retained).toEqual({
      targets: {
        window: { 'Navigator.prototype.joinAdInterestGroup': { lastUpstream: '@webref/idl 1.0.0', reason } },
        'dedicated-worker': {},
        'shared-worker': {},
        'service-worker': {},
      },
      holders: { window: {}, 'dedicated-worker': {}, 'shared-worker': {}, 'service-worker': {} },
      dropped: { window: {}, 'dedicated-worker': {}, 'shared-worker': {}, 'service-worker': {} },
      droppedHolders: { window: {}, 'dedicated-worker': {}, 'shared-worker': {}, 'service-worker': {} },
    })
  })

  test('the protected-surface list names a retained target like any other', () => {
    const catalog = catalogOf({
      idl: { globals, html: after },
      retained,
      surfaces: { owners: { Navigator: 'networking' }, members: {} },
      protectedSurface: { networking: [{ interface: 'Navigator', member: 'joinAdInterestGroup' }] },
    })

    expect(catalog.protectedSurface.networking[0].targets.window).toEqual(['Navigator.prototype.joinAdInterestGroup'])
  })

  test('an interface upstream drops whole keeps its targets and holders through retained entries', () => {
    const had = catalogOf({ idl: { globals, html: after, sharedStorage } })
    const last = (name: string) => ({ lastUpstream: '@webref/idl 1.0.0', reason, target: lastGenerated(had, name) })
    const holder = (name: string) => ({ lastUpstream: '@webref/idl 1.0.0', reason, holder: had.holders.window[name] })
    const catalog = catalogOf({
      idl: { globals, html: after },
      retained: {
        targets: {
          window: {
            'SharedStorage.prototype.clear': last('SharedStorage.prototype.clear'),
            'Window.SharedStorage': last('Window.SharedStorage'),
            'Window.sharedStorage': last('Window.sharedStorage'),
          },
        },
        holders: { window: { SharedStorage: holder('SharedStorage'), 'SharedStorage.prototype': holder('SharedStorage.prototype') } },
        dropped: {},
      },
    })

    expect(catalog.holders.window.SharedStorage).toEqual(had.holders.window.SharedStorage)
    expect(catalog.holders.window['SharedStorage.prototype']).toEqual(had.holders.window['SharedStorage.prototype'])
    expect(catalog.targets.window['Window.SharedStorage']).toMatchObject({ holds: 'SharedStorage', catalogStatus: 'retained' })
    expect(Object.keys(catalog.retained.holders.window)).toEqual(['SharedStorage', 'SharedStorage.prototype'])
  })

  test('refuses a retained entry for a target or holder upstream has again, and a target whose holder is gone', () => {
    const idl = { globals, html: after }
    const entry = retained.targets.window!['Navigator.prototype.joinAdInterestGroup']!

    expect(() => catalogOf({ idl: { globals, html: before }, retained })).toThrow(
      'Navigator.prototype.joinAdInterestGroup is retained, but upstream has it again in window: remove its retained entry',
    )
    expect(() =>
      catalogOf({
        idl,
        retained: {
          targets: {},
          holders: { window: { 'Navigator.prototype': { lastUpstream: '@webref/idl 1.0.0', reason, holder: previous.holders.window['Navigator.prototype'] } } },
          dropped: {},
        },
      }),
    ).toThrow('Navigator.prototype is a retained holder, but upstream has it again in window: remove its retained entry')
    expect(() =>
      catalogOf({ idl, retained: { targets: { 'dedicated-worker': { 'Navigator.prototype.joinAdInterestGroup': entry } }, holders: {}, dropped: {} } }),
    ).toThrow('the retained target Navigator.prototype.joinAdInterestGroup is on Navigator.prototype, which is no prototype holder in dedicated-worker')
    expect(() =>
      catalogOf({
        idl,
        retained: { targets: { window: { 'Navigator.prototype.joinAdInterestGroup': { ...entry, target: { ...entry.target, holds: 'Gone' } } } }, holders: {}, dropped: {} },
      }),
    ).toThrow('the retained target Navigator.prototype.joinAdInterestGroup holds Gone, which is no holder in window')
    expect(() => catalogOf({ idl, retained, exclusions: { Navigator: 'Test-only.' } })).toThrow(
      'Navigator.prototype.joinAdInterestGroup is retained, but the exclusion of Navigator removes its owner',
    )
  })

  test('refuses a retained holder whose owner an exclusion removes, so that it cannot bring back an excluded interface', () => {
    const had = catalogOf({ idl: { globals, html: after, sharedStorage } })
    const holder = { lastUpstream: '@webref/idl 1.0.0', reason, holder: had.holders.window.SharedStorage }

    expect(() =>
      catalogOf({
        idl: { globals, html: after, excluded: '[Exposed=Window] interface SharedStorage {};' },
        exclusions: { SharedStorage: 'Test-only.' },
        retained: { targets: {}, holders: { window: { SharedStorage: holder } }, dropped: {} },
      }),
    ).toThrow('SharedStorage is a retained holder, but the exclusion of SharedStorage removes its owner')
  })

  test('refuses a drop of a target the catalog has, and a target both retained and dropped', () => {
    const drop = { bcd: 'api.Navigator.userAgent', evidence: 'BCD 8.1.3 lists no engine that ships it.' }

    expect(() =>
      catalogOf({ idl: { globals, html: after }, retained: { targets: {}, holders: {}, dropped: { window: { 'Navigator.prototype.userAgent': drop } } } }),
    ).toThrow('Navigator.prototype.userAgent is dropped, but the catalog has it in window: remove its drop entry')
    expect(() =>
      catalogOf({
        idl: { globals, html: after },
        retained: { ...retained, dropped: { window: { 'Navigator.prototype.joinAdInterestGroup': drop } } },
      }),
    ).toThrow('Navigator.prototype.joinAdInterestGroup is dropped, but the catalog has it in window: remove its drop entry')
  })

  test('a retained ECMAScript target keeps the surface ECMAScript, whatever the owner → surface map says', () => {
    const escape = {
      owner: 'Window',
      member: 'escape',
      holder: 'global' as const,
      kind: 'function' as const,
      spec: 'ecma262',
      descriptor: { type: 'data' as const, writable: true, enumerable: false, configurable: true },
    }
    const catalog = catalogOf({
      idl: { globals, html: after },
      retained: {
        targets: { window: { 'Window.escape': { lastUpstream: '@tc39/ecma262-biblio 2.2.3180', reason, target: escape } } },
        holders: {},
        dropped: {},
      },
    })

    expect(catalog.targets.window['Window.escape']).toMatchObject({ surface: 'ECMAScript', catalogStatus: 'retained' })
  })

  test('with no retained overlay, the section is empty in every realm', () => {
    const catalog = catalogOf({ idl: { globals, html: after } })

    for (const section of ['targets', 'holders', 'dropped', 'droppedHolders']) {
      expect(catalog.retained[section]).toEqual(Object.fromEntries(realms.map((realm) => [realm, {}])))
    }
  })
})

describe('the catalog is monotonic', () => {
  const previous = generate({ idl: { globals, html: before }, upstream })
  const last = lastGenerated(JSON.parse(previous.catalog), 'Navigator.prototype.joinAdInterestGroup')

  test('refuses a generation in which upstream removed a target, and gives the retained entry to start from', () => {
    const refusal = refusalOf(() => generate({ idl: { globals, html: after }, upstream: bumped, previous }))

    expect(refusal.list).toBe(
      'upstream removed 1 target the previous catalog had. The catalog is monotonic: keep each in the retained overlay, ' +
        'or drop it there with BCD evidence that no current engine ships it.\n' +
        '- `Navigator.prototype.joinAdInterestGroup` (window)',
    )
    expect(refusal.entries).toEqual({
      holders: {},
      targets: {
        window: { 'Navigator.prototype.joinAdInterestGroup': { lastUpstream: '@webref/idl 1.0.0', reason: '', target: last } },
      },
    })
  })

  test('the entry to start from also retains the holders a removed target needs that upstream removed too', () => {
    const had = generate({ idl: { globals, html: after, sharedStorage }, upstream })
    const { holders } = JSON.parse(had.catalog)
    const refusal = refusalOf(() => generate({ idl: { globals, html: after }, upstream, previous: had }))

    expect(Object.keys(refusal.entries.targets.window)).toEqual([
      'SharedStorage.prototype',
      'SharedStorage.prototype.@@toStringTag',
      'SharedStorage.prototype.clear',
      'SharedStorage.prototype.constructor',
      'Window.SharedStorage',
      'Window.sharedStorage',
    ])
    expect(refusal.entries.holders).toEqual({
      window: {
        SharedStorage: { lastUpstream: '@webref/idl 1.0.0', reason: '', holder: holders.window.SharedStorage },
        'SharedStorage.prototype': {
          lastUpstream: '@webref/idl 1.0.0',
          reason: '',
          holder: holders.window['SharedStorage.prototype'],
        },
      },
    })
  })

  test('accepts the removal when a retained entry keeps the target', () => {
    const retained = {
      targets: { window: { 'Navigator.prototype.joinAdInterestGroup': { lastUpstream: '@webref/idl 1.0.0', reason, target: last } } },
      holders: {},
      dropped: {},
    }
    const { catalog } = generate({ idl: { globals, html: after }, upstream: bumped, retained, previous })

    expect(JSON.parse(catalog).targets.window['Navigator.prototype.joinAdInterestGroup'].catalogStatus).toBe('retained')
  })

  test('accepts the removal of a target deliberately dropped, and of one an exclusion removes', () => {
    const drop = { bcd: 'api.Navigator.joinAdInterestGroup', evidence: 'BCD 9.0.0 lists no engine that ships it.' }
    const dropped = { targets: {}, holders: {}, dropped: { window: { 'Navigator.prototype.joinAdInterestGroup': drop } } }
    const { catalog } = generate({ idl: { globals, html: after }, upstream: bumped, retained: dropped, previous })

    expect(JSON.parse(catalog).targets.window).not.toHaveProperty(['Navigator.prototype.joinAdInterestGroup'])
    expect(() =>
      generate({ idl: { globals, html: before }, upstream, exclusions: { Navigator: 'Test-only.' }, previous }),
    ).not.toThrow()
  })

  test('a target whose holder kind changes keeps its name, so it is no removal, but a holder the change loses is', () => {
    const had = generate({ idl: { globals, spec: '[Exposed=Window] interface Foo { static undefined bar(); };' }, upstream })
    const refusal = refusalOf(() =>
      generate({ idl: { globals, spec: '[Exposed=Window] namespace Foo { undefined bar(); };' }, upstream, previous: had }),
    )

    // The interface's structural properties, which a namespace doesn't have, are removals too.
    expect(refusal.list).toMatch(/^upstream removed 3 targets and 1 holder the previous catalog had\./)
    expect(refusal.list!.split('\n').slice(1)).toEqual([
      '- `Foo.prototype` (window)',
      '- `Foo.prototype.@@toStringTag` (window)',
      '- `Foo.prototype.constructor` (window)',
      '- `Foo.prototype` (window, prototype holder)',
    ])
    expect(Object.keys(refusal.entries.targets.window)).toEqual([
      'Foo.prototype',
      'Foo.prototype.@@toStringTag',
      'Foo.prototype.constructor',
    ])
  })

  describe('holders are monotonic too', () => {
    /**
     * `CDATASection` inherits `Text` and has no members: only the structural properties Web IDL gives every interface
     * sit on its holders, and the bump drops them.
     */
    const dom = '[Exposed=Window] interface Text { undefined splitText(); };'
    const cdata = '[Exposed=Window] interface CDATASection : Text {};'
    const had = generate({ idl: { globals, dom: `${dom}\n${cdata}` }, upstream })
    const hadCatalog = JSON.parse(had.catalog)
    /** The target and interface object a bump keeps, which leaves `CDATASection.prototype` out. */
    const keptObject: RetainedOverlay = {
      targets: {
        window: {
          'Window.CDATASection': { lastUpstream: '@webref/idl 1.0.0', reason, target: lastGenerated(hadCatalog, 'Window.CDATASection') },
        },
      },
      holders: { window: { CDATASection: { lastUpstream: '@webref/idl 1.0.0', reason, holder: hadCatalog.holders.window.CDATASection } } },
      dropped: {
        window: Object.fromEntries(
          ['CDATASection.prototype', 'CDATASection.prototype.@@toStringTag', 'CDATASection.prototype.constructor'].map((name) => [
            name,
            { bcd: 'api.CDATASection', evidence: 'BCD 9.0.0 lists no engine that ships it.' },
          ]),
        ),
      },
    }

    test('refuses a bump that loses a holder no target sits on, and gives its retained entry to start from', () => {
      const refusal = refusalOf(() => generate({ idl: { globals, dom }, upstream: bumped, retained: keptObject, previous: had }))

      expect(refusal.list).toBe(
        'upstream removed 1 holder the previous catalog had. The catalog is monotonic: keep each in the retained ' +
          'overlay, or drop it there with BCD evidence that no current engine ships it.\n' +
          '- `CDATASection.prototype` (window, prototype holder)',
      )
      expect(refusal.entries).toEqual({
        holders: {
          window: {
            'CDATASection.prototype': {
              lastUpstream: '@webref/idl 1.0.0',
              reason: '',
              holder: hadCatalog.holders.window['CDATASection.prototype'],
            },
          },
        },
        targets: {},
      })
    })

    test('accepts the bump once the holder is retained, or dropped with BCD evidence', () => {
      const holder = hadCatalog.holders.window['CDATASection.prototype']
      const retainedToo: RetainedOverlay = {
        ...keptObject,
        holders: { window: { ...keptObject.holders.window, 'CDATASection.prototype': { lastUpstream: '@webref/idl 1.0.0', reason, holder } } },
      }
      const drop = { bcd: 'api.CDATASection', evidence: 'BCD 9.0.0 lists no engine that ships it.' }
      const droppedToo: RetainedOverlay = { ...keptObject, droppedHolders: { window: { 'CDATASection.prototype': drop } } }

      const kept = JSON.parse(generate({ idl: { globals, dom }, upstream: bumped, retained: retainedToo, previous: had }).catalog)
      expect(kept.holders.window['CDATASection.prototype']).toEqual(holder)
      expect(kept.retained.holders.window['CDATASection.prototype']).toEqual({ lastUpstream: '@webref/idl 1.0.0', reason })

      const dropped = JSON.parse(generate({ idl: { globals, dom }, upstream: bumped, retained: droppedToo, previous: had }).catalog)
      expect(dropped.holders.window).not.toHaveProperty(['CDATASection.prototype'])
      expect(dropped.retained.droppedHolders.window).toEqual({ 'CDATASection.prototype': drop })
    })

    test('accepts the holders an exclusion removes, with the targets it removes', () => {
      expect(() =>
        generate({ idl: { globals, dom: `${dom}\n${cdata}` }, upstream, exclusions: { CDATASection: 'Test-only.' }, previous: had }),
      ).not.toThrow()
    })

    test('refuses a drop of a holder the catalog has', () => {
      const drop = { bcd: 'api.Text', evidence: 'BCD 9.0.0 lists no engine that ships it.' }

      expect(() =>
        generate({
          idl: { globals, dom: `${dom}\n${cdata}` },
          upstream,
          retained: { targets: {}, holders: {}, dropped: {}, droppedHolders: { window: { 'Text.prototype': drop } } },
        }),
      ).toThrow('the holder Text.prototype is dropped, but the catalog has it in window: remove its drop entry')
    })
  })

  test('a removal in one realm is a removal, even when the target stays in another', () => {
    const had = generate({ idl: { globals, spec: '[Exposed=(Window,Worker)] interface Foo { undefined bar(); };' }, upstream })

    expect(() =>
      generate({ idl: { globals, spec: '[Exposed=Window] interface Foo { undefined bar(); };' }, upstream, previous: had }),
    ).toThrow(/- `DedicatedWorkerGlobalScope\.Foo` \(dedicated-worker\)\n(.*\n)*- `Foo\.prototype\.bar` \(dedicated-worker\)\n- `Foo\.prototype\.bar` \(shared-worker\)/)
  })
})

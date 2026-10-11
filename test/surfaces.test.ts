import { describe, expect, test } from 'vitest'
import { surfaces, type CatalogTarget } from '../src/index.ts'
import { generate, type Sources } from '../tools/catalog-generator/generate.ts'

const upstream = { '@webref/idl': '1.0.0', webidl2: '24.5.0' }

/** The global interfaces of the four realms. */
const globals = `
  [Exposed=*] interface EventTarget { undefined addEventListener(DOMString type); };
  [Global=Window, Exposed=Window] interface Window : EventTarget {};
  [Exposed=Worker] interface WorkerGlobalScope : EventTarget {};
  [Global=(Worker,DedicatedWorker), Exposed=DedicatedWorker]
  interface DedicatedWorkerGlobalScope : WorkerGlobalScope {};
  [Global=(Worker,SharedWorker), Exposed=SharedWorker] interface SharedWorkerGlobalScope : WorkerGlobalScope {};
  [Global=(Worker,ServiceWorker), Exposed=ServiceWorker] interface ServiceWorkerGlobalScope : WorkerGlobalScope {};`

const html = `
  [Exposed=Window] interface History { undefined pushState(any data, DOMString unused); attribute EventHandler onpopstate; };
  [Exposed=Window] interface Location { [LegacyUnforgeable] stringifier attribute USVString href; };
  interface mixin WindowOrWorkerGlobalScope {
    long setTimeout(TimerHandler handler);
    readonly attribute USVString origin;
  };
  Window includes WindowOrWorkerGlobalScope;
  WorkerGlobalScope includes WindowOrWorkerGlobalScope;
  partial interface Window {
    undefined open();
    [PutForwards=href, LegacyUnforgeable] readonly attribute Location location;
  };
  interface mixin WindowLocalStorage { readonly attribute Storage localStorage; };
  Window includes WindowLocalStorage;
  [Exposed=Window] interface Storage { DOMString? getItem(DOMString key); };`

const fetch = `
  partial interface mixin WindowOrWorkerGlobalScope { Promise<Response> fetch(RequestInfo input); };
  [Exposed=(Window,Worker)] interface Response { static Response error(); Promise<any> json(); };`

let clauseCount = 0

/** A biblio clause entry, as `@tc39/ecma262-biblio` lists them. */
function clause(number: string, title: string, id = `sec-fixture-${++clauseCount}`) {
  return { type: 'clause', id, number, title, aoid: null as string | null }
}

/**
 * The structural clauses of ECMA-262 the generator finds its way by, the intrinsics every realm needs for its
 * prototype chains, and `Promise`.
 */
const ecma262 = [
  clause('19', 'The Global Object', 'sec-global-object'),
  clause('19.1', 'Value Properties of the Global Object', 'sec-value-properties-of-the-global-object'),
  clause('19.2', 'Function Properties of the Global Object', 'sec-function-properties-of-the-global-object'),
  clause('19.3', 'Constructor Properties of the Global Object', 'sec-constructor-properties-of-the-global-object'),
  clause('19.3.1', 'Function ( . . . )'),
  clause('19.3.2', 'Object ( . . . )'),
  clause('19.3.3', 'Promise ( . . . )'),
  clause('19.4', 'Other Properties of the Global Object', 'sec-other-properties-of-the-global-object'),
  clause('20', 'Fundamental Objects', 'sec-fundamental-objects'),
  clause('20.1.2.1', 'Object.prototype'),
  clause('20.2.2.1', 'Function.prototype'),
  clause('20.5.5', 'Native Error Types Used in This Standard', 'sec-native-error-types-used-in-this-standard'),
  clause('27.2.4.2', 'Promise.allSettled ( iterable )'),
  clause('27.2.4.4', 'Promise.prototype'),
  clause('27.2.5.4', 'Promise.prototype.then ( onFulfilled, onRejected )'),
  clause('28', 'Reflection', 'sec-reflection'),
  clause('B.2', 'Additional Built-in Properties', 'sec-additional-built-in-properties'),
  clause('B.2.1', 'Additional Properties of the Global Object', 'sec-additional-properties-of-the-global-object'),
]

const ecmascript = {
  ecma262: { entries: ecma262 },
  ecma402: { entries: [clause('8', 'The Intl Object', 'intl-object')] },
  additions: {},
  engineExtensions: {},
  proseProperties: {},
}

/** The singletons overlay, with `location`, whose own members are instance targets. */
const singletons = { globalNames: [], singletons: ['location'], aliases: {} }

function catalogOf(overlays: Partial<Sources> = {}, idl: Record<string, string> = { html, fetch }) {
  return JSON.parse(generate({ idl: { globals, ...idl }, ecmascript, singletons, upstream, ...overlays }).catalog)
}

/** The surface of each named target, in `realm`. */
function surfacesOf(catalog: { targets: Record<string, Record<string, CatalogTarget>> }, realm = 'window') {
  return (...names: string[]) => Object.fromEntries(names.map((name) => [name, catalog.targets[realm]?.[name]?.surface]))
}

describe('surfaces', () => {
  test('every target and per-instance member has a surface: other for an owner nobody has reviewed, ECMAScript for ECMAScript', () => {
    const catalog = catalogOf()

    expect(catalog.targets.window['History.prototype.pushState'].surface).toBe('other')
    expect(catalog.instanceMembers.window.Location.href.surface).toBe('other')
    expect(catalog.targets.window['Promise.allSettled'].surface).toBe('ECMAScript')
    expect(catalog.targets.window['Promise.prototype.then'].surface).toBe('ECMAScript')
    expect(catalog.targets['service-worker']['ServiceWorkerGlobalScope.Promise'].surface).toBe('ECMAScript')
    for (const [realm, named] of Object.entries(catalog.targets as Record<string, Record<string, CatalogTarget>>)) {
      for (const [name, { surface }] of Object.entries(named)) expect(surfaces, `${name} (${realm})`).toContain(surface)
    }
  })

  test("an owner in the owner → surface map gives its members its surface, and so do the properties that hold its objects", () => {
    const owners = { History: 'navigation', Location: 'navigation', Response: 'networking' } as const
    const catalog = catalogOf({ surfaces: { owners, members: {} } })

    expect(surfacesOf(catalog)('History.prototype.pushState', 'Window.History', 'Response.error', 'Window.open')).toEqual({
      'History.prototype.pushState': 'navigation',
      'Window.History': 'navigation',
      'Response.error': 'networking',
      'Window.open': 'other',
    })
    expect(surfacesOf(catalog, 'dedicated-worker')('DedicatedWorkerGlobalScope.Response')).toEqual({
      'DedicatedWorkerGlobalScope.Response': 'networking',
    })
    expect(catalog.targets.window['location.href'].surface).toBe('navigation')
    expect(catalog.instanceMembers.window.Location.href.surface).toBe('navigation')
  })

  test('a per-member override, keyed on its owner or on the mixin it came through, wins over the owner', () => {
    const catalog = catalogOf({
      surfaces: {
        owners: { Window: 'navigation', WorkerGlobalScope: 'workers' },
        members: { WindowOrWorkerGlobalScope: { fetch: 'networking' }, Window: { fetch: 'DOM', setTimeout: 'scheduling' } },
      },
    })

    expect(surfacesOf(catalog)('Window.fetch', 'Window.setTimeout', 'Window.origin', 'Window.open')).toEqual({
      'Window.fetch': 'DOM',
      'Window.setTimeout': 'scheduling',
      'Window.origin': 'navigation',
      'Window.open': 'navigation',
    })
    const worker = surfacesOf(catalog, 'dedicated-worker')
    expect(worker('WorkerGlobalScope.prototype.fetch', 'WorkerGlobalScope.prototype.setTimeout')).toEqual({
      'WorkerGlobalScope.prototype.fetch': 'networking',
      'WorkerGlobalScope.prototype.setTimeout': 'workers',
    })
  })

  test('a mixin in the map gives its members its surface on every interface that includes it', () => {
    const catalog = catalogOf({
      surfaces: { owners: { Window: 'navigation', WindowLocalStorage: 'storage', Storage: 'storage' }, members: {} },
    })

    expect(surfacesOf(catalog)('Window.localStorage', 'Window.open', 'Storage.prototype.getItem')).toEqual({
      'Window.localStorage': 'storage',
      'Window.open': 'navigation',
      'Storage.prototype.getItem': 'storage',
    })
  })

  test('an interface with no members of its own is in the map through the property that holds it', () => {
    const idl = { html, fetch, dom: '[Exposed=Window] interface Comment {};' }
    const catalog = catalogOf({ surfaces: { owners: { Comment: 'DOM' }, members: {} } }, idl)

    expect(surfacesOf(catalog)('Window.Comment')).toEqual({ 'Window.Comment': 'DOM' })
    expect(surfacesOf(catalogOf({}, idl))('Window.Comment')).toEqual({ 'Window.Comment': 'other' })
  })

  test('refuses a map entry that names nothing in the catalog, an ECMAScript owner or member, other, or no surface', () => {
    const refusal = (owners: Record<string, string>, members: Record<string, Record<string, string>> = {}) => () =>
      catalogOf({ surfaces: { owners, members } as NonNullable<Sources['surfaces']> })

    expect(refusal({ Histroy: 'navigation' })).toThrow(
      'surface map: Histroy owns no member of the catalog, and no property holds it',
    )
    expect(refusal({}, { History: { pushstate: 'navigation' } })).toThrow(
      'surface map: History.pushstate names no member of the catalog',
    )
    expect(refusal({ Promise: 'networking' })).toThrow(
      'surface map: Promise is an ECMAScript owner, whose members are always ECMAScript',
    )
    expect(refusal({}, { Window: { Promise: 'networking' } })).toThrow(
      'surface map: Window.Promise is an ECMAScript member, which is always ECMAScript',
    )
    expect(refusal({ History: 'other' })).toThrow(
      'surface map: History is other, which the map never says: other is an owner nobody has reviewed',
    )
    expect(refusal({ History: 'history' })).toThrow('surface map: History is history, which is no surface')
  })

  test('the owner → surface map is a named section of the merged catalog', () => {
    const map = { owners: { History: 'navigation' }, members: { WindowOrWorkerGlobalScope: { fetch: 'networking' } } } as const

    expect(catalogOf({ surfaces: map }).surfaceMap).toEqual(map)
    expect(catalogOf().surfaceMap).toEqual({ owners: {}, members: {} })
  })
})

describe('protected-surface list', () => {
  const xhr = `
    [Exposed=(Window,DedicatedWorker)]
    interface XMLHttpRequest : EventTarget {
      const unsigned short DONE = 4;
      attribute EventHandler onreadystatechange;
      undefined send();
      static undefined reset();
    };`
  const idl = { html, fetch, xhr }
  const reviewed = {
    owners: { EventTarget: 'events', XMLHttpRequest: 'networking' },
    members: { WindowOrWorkerGlobalScope: { fetch: 'networking' } },
  } as const

  function listOf(protectedSurface: NonNullable<Sources['protectedSurface']>, surfaces: Sources['surfaces'] = reviewed) {
    return catalogOf({ surfaces, protectedSurface }, idl).protectedSurface
  }

  test('a member entry, keyed on (interface, member), resolves to that member in every realm, on its owner or through its mixin', () => {
    const list = listOf({
      networking: [{ interface: 'WindowOrWorkerGlobalScope', member: 'fetch' }],
      events: [{ interface: 'EventTarget', member: 'addEventListener' }],
    })

    expect(list).toEqual({
      events: [
        {
          interface: 'EventTarget',
          member: 'addEventListener',
          targets: {
            window: ['EventTarget.prototype.addEventListener'],
            'dedicated-worker': ['EventTarget.prototype.addEventListener'],
            'shared-worker': ['EventTarget.prototype.addEventListener'],
            'service-worker': ['EventTarget.prototype.addEventListener'],
          },
        },
      ],
      networking: [
        {
          interface: 'WindowOrWorkerGlobalScope',
          member: 'fetch',
          targets: {
            window: ['Window.fetch'],
            'dedicated-worker': ['WorkerGlobalScope.prototype.fetch'],
            'shared-worker': ['WorkerGlobalScope.prototype.fetch'],
            'service-worker': ['WorkerGlobalScope.prototype.fetch'],
          },
        },
      ],
    })
  })

  test("a member entry's workerEquivalent names that interface's member of the same name in the worker realms only", () => {
    const navigator = `
      [Exposed=Window] interface Navigator { readonly attribute ServiceWorkerContainer serviceWorker; };
      [Exposed=Worker] interface WorkerNavigator { readonly attribute ServiceWorkerContainer serviceWorker; };
      [Exposed=(Window,Worker)] interface ServiceWorkerContainer {};`
    const list = catalogOf(
      {
        surfaces: { owners: { Navigator: 'workers', WorkerNavigator: 'workers' }, members: {} },
        protectedSurface: {
          workers: [{ interface: 'Navigator', member: 'serviceWorker', workerEquivalent: 'WorkerNavigator' }],
        },
      },
      { html, fetch, navigator },
    ).protectedSurface

    expect(list.workers).toEqual([
      {
        interface: 'Navigator',
        member: 'serviceWorker',
        workerEquivalent: 'WorkerNavigator',
        targets: {
          window: ['Navigator.prototype.serviceWorker'],
          'dedicated-worker': ['WorkerNavigator.prototype.serviceWorker'],
          'shared-worker': ['WorkerNavigator.prototype.serviceWorker'],
          'service-worker': ['WorkerNavigator.prototype.serviceWorker'],
        },
      },
    ])
  })

  test("a whole entry resolves to the global binding, statics, constants and prototype members, but not event handlers", () => {
    const list = listOf({ networking: [{ interface: 'XMLHttpRequest' }], ECMAScript: [{ interface: 'Promise' }] })
    const xhrTargets = [
      'XMLHttpRequest.DONE',
      'XMLHttpRequest.prototype',
      'XMLHttpRequest.prototype.@@toStringTag',
      'XMLHttpRequest.prototype.DONE',
      'XMLHttpRequest.prototype.constructor',
      'XMLHttpRequest.prototype.send',
      'XMLHttpRequest.reset',
    ]
    const promiseTargets = ['Promise.allSettled', 'Promise.prototype', 'Promise.prototype.then']

    expect(list.networking).toEqual([
      {
        interface: 'XMLHttpRequest',
        targets: {
          window: ['Window.XMLHttpRequest', ...xhrTargets],
          'dedicated-worker': ['DedicatedWorkerGlobalScope.XMLHttpRequest', ...xhrTargets],
          'shared-worker': [],
          'service-worker': [],
        },
      },
    ])
    expect(list.ECMAScript[0].targets.window).toEqual([...promiseTargets, 'Window.Promise'])
    expect(list.ECMAScript[0].targets['shared-worker']).toEqual([...promiseTargets, 'SharedWorkerGlobalScope.Promise'])
  })

  test('writes the same catalog whatever order the overlays list their entries in', () => {
    const scheduling = [
      { interface: 'WindowOrWorkerGlobalScope', member: 'setTimeout' },
      { interface: 'WindowOrWorkerGlobalScope', member: 'fetch' },
    ]
    const map = (members: Record<string, string>) => ({ ...reviewed, members: { WindowOrWorkerGlobalScope: members } })
    const generateWith = (list: NonNullable<Sources['protectedSurface']>, surfaces: Sources['surfaces']) =>
      generate({ idl: { globals, ...idl }, ecmascript, singletons, upstream, surfaces, protectedSurface: list }).catalog
    const forward = generateWith(
      { scheduling },
      map({ fetch: 'scheduling', setTimeout: 'scheduling' }) as Sources['surfaces'],
    )
    const backward = generateWith(
      { scheduling: [...scheduling].reverse() },
      map({ setTimeout: 'scheduling', fetch: 'scheduling' }) as Sources['surfaces'],
    )

    expect(backward).toBe(forward)
    expect(JSON.parse(forward).protectedSurface.scheduling.map(({ member }: { member: string }) => member)).toEqual([
      'fetch',
      'setTimeout',
    ])
  })

  test('refuses an entry that resolves to no target, one whose targets have another surface, a duplicate, and other', () => {
    const refusal = (list: object, surfaces: Sources['surfaces'] = reviewed) => () =>
      listOf(list as NonNullable<Sources['protectedSurface']>, surfaces)

    expect(refusal({ networking: [{ interface: 'Navigator', member: 'sendBeacon' }] })).toThrow(
      'protected surface: the networking entry Navigator.sendBeacon resolves to no target',
    )
    expect(refusal({ scheduling: [{ interface: 'WindowOrWorkerGlobalScope' }] })).toThrow(
      'protected surface: the scheduling entry WindowOrWorkerGlobalScope resolves to no target',
    )
    expect(refusal({ networking: [{ interface: 'XMLHttpRequest' }] }, { owners: {}, members: {} })).toThrow(
      'protected surface: the networking entry XMLHttpRequest covers Window.XMLHttpRequest (window), whose surface is other',
    )
    const addEventListener = { interface: 'EventTarget', member: 'addEventListener' }
    expect(refusal({ events: [addEventListener], networking: [addEventListener] })).toThrow(
      'protected surface: EventTarget.addEventListener is listed twice',
    )
    expect(refusal({ other: [{ interface: 'History' }] })).toThrow(
      'protected surface: other is no surface an entry can be listed under',
    )
  })
})


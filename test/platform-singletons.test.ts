import { describe, expect, test } from 'vitest'
import { generate, type Sources } from '../tools/catalog-generator/generate.ts'

const upstream = { '@webref/idl': '1.0.0', webidl2: '24.5.0' }

/** The global interfaces of the four realms, with the inheritance and the self-references real IDL gives them. */
const globals = `
  [Exposed=*] interface EventTarget {};
  [Global=Window, Exposed=Window]
  interface Window : EventTarget {
    [LegacyUnforgeable] readonly attribute WindowProxy window;
    [Replaceable] readonly attribute WindowProxy self;
  };
  [Exposed=Worker] interface WorkerGlobalScope : EventTarget { readonly attribute WorkerGlobalScope self; };
  [Global=(Worker,DedicatedWorker), Exposed=DedicatedWorker]
  interface DedicatedWorkerGlobalScope : WorkerGlobalScope {};
  [Global=(Worker,SharedWorker), Exposed=SharedWorker] interface SharedWorkerGlobalScope : WorkerGlobalScope {};
  [Global=(Worker,ServiceWorker), Exposed=ServiceWorker] interface ServiceWorkerGlobalScope : WorkerGlobalScope {};`

const history = `
  [Exposed=Window] interface History { undefined pushState(any data, DOMString unused); };
  partial interface Window { readonly attribute History history; };`

const location = `
  [Exposed=Window]
  interface Location {
    [LegacyUnforgeable] stringifier attribute USVString href;
    [LegacyUnforgeable] undefined reload();
  };
  partial interface Window { [PutForwards=href, LegacyUnforgeable] readonly attribute Location location; };
  [Exposed=Worker] interface WorkerLocation { stringifier readonly attribute USVString href; };
  partial interface WorkerGlobalScope { readonly attribute WorkerLocation location; };`

const navigator = `
  [Exposed=Window] interface Navigator {};
  [Exposed=Worker] interface WorkerNavigator {};
  partial interface Window {
    [SameObject, Replaceable] readonly attribute Navigator navigator;
    [Replaceable] readonly attribute Navigator clientInformation;
  };
  partial interface WorkerGlobalScope { readonly attribute WorkerNavigator navigator; };`

const geolocation = `
  [Exposed=Window] interface Geolocation { undefined getCurrentPosition(PositionCallback successCallback); };
  partial interface Navigator { [SameObject] readonly attribute Geolocation geolocation; };`

const document = `
  [Exposed=Window]
  interface Document { [PutForwards=href, LegacyUnforgeable] readonly attribute Location? location; };
  partial interface Window { [LegacyUnforgeable] readonly attribute Document document; };`

type Overlay = NonNullable<Sources['singletons']>

function catalogOf(idl: Record<string, string>, singletons: Partial<Overlay>, proseMembers?: Sources['proseMembers']) {
  const overlay = { globalNames: ['self', 'window'], singletons: [], aliases: {}, ...singletons }
  return JSON.parse(generate({ idl: { globals, ...idl }, singletons: overlay, proseMembers, upstream }).catalog)
}

/** HTML's own `valueOf` and `@@toPrimitive` of each Location object, which its prose defines rather than its IDL. */
const nonWritable = { type: 'data', writable: false, enumerable: false, configurable: false } as const
const locationProse = {
  Location: {
    valueOf: { spec: 'html', source: 'HTML, for this test', kind: 'function', descriptor: nonWritable },
    '@@toPrimitive': { spec: 'html', source: 'HTML, for this test', kind: 'value', descriptor: nonWritable },
  },
} as const

describe('platform singletons', () => {
  test('a singleton is an instance holder of its interface, under its canonical path, in each realm its path resolves', () => {
    const catalog = catalogOf({ html: history }, { singletons: ['history'] })

    expect(catalog.holders.window.history).toEqual({ kind: 'instance', owner: 'History', proto: 'History.prototype' })
    expect(catalog.singletons.window).toEqual({ history: { interface: 'History', via: 'Window.history' } })
    for (const realm of ['dedicated-worker', 'shared-worker', 'service-worker']) {
      expect(catalog.singletons[realm], realm).toEqual({})
      expect(catalog.holders[realm], realm).not.toHaveProperty('history')
    }
  })

  test("a singleton's own members, its interface's [LegacyUnforgeable] ones, are instance targets named by its canonical path", () => {
    const catalog = catalogOf({ html: location }, { singletons: ['location'] })
    const href = catalog.instanceMembers.window.Location.href
    const reload = catalog.instanceMembers.window.Location.reload

    expect(catalog.targets.window['location.href']).toEqual({ ...href, holder: 'instance' })
    expect(catalog.targets.window['location.reload']).toEqual({ ...reload, holder: 'instance' })
    expect(href).toMatchObject({ owner: 'Location', member: 'href', kind: 'attribute', assign: 'setter' })
    // The unforgeable stringifier's toString is an own member of each instance too.
    expect(Object.keys(catalog.targets.window).filter((name) => name.includes('location.'))).toEqual([
      'location.href',
      'location.reload',
      'location.toString',
    ])
  })

  test("a singleton also owns the [LegacyUnforgeable] members of the interfaces its interface inherits", () => {
    const catalog = catalogOf(
      {
        html: `
          [Exposed=Window] interface Base { [LegacyUnforgeable] readonly attribute DOMString id; };
          [Exposed=Window] interface Thing : Base { [LegacyUnforgeable] undefined poke(); };
          partial interface Window { readonly attribute Thing thing; };`,
      },
      { singletons: ['thing'] },
    )

    expect(catalog.targets.window['thing.id']).toMatchObject({ owner: 'Base', holder: 'instance', kind: 'attribute' })
    expect(catalog.targets.window['thing.poke']).toMatchObject({ owner: 'Thing', holder: 'instance', kind: 'operation' })
  })

  test('Location instances keep their immutable prototype on the location holder', () => {
    const catalog = catalogOf({ html: location }, { singletons: ['location'] })

    expect(catalog.holders.window.location).toEqual({
      kind: 'instance',
      owner: 'Location',
      proto: 'Location.prototype',
      immutablePrototype: true,
    })
  })

  test("a singleton's interface can differ by realm, as its path's IDL type does: location is a WorkerLocation in workers", () => {
    const catalog = catalogOf({ html: location }, { singletons: ['location'] })

    for (const realm of ['dedicated-worker', 'shared-worker', 'service-worker']) {
      expect(catalog.singletons[realm].location, realm).toEqual({
        interface: 'WorkerLocation',
        via: 'WorkerGlobalScope.prototype.location',
      })
      expect(catalog.holders[realm].location, realm).toEqual({
        kind: 'instance',
        owner: 'WorkerLocation',
        proto: 'WorkerLocation.prototype',
      })
      expect(Object.keys(catalog.targets[realm]).filter((name) => name.startsWith('location.')), realm).toEqual([])
    }
  })

  test('a nested singleton is reached through the singleton its path extends, and named without the global prefix', () => {
    const catalog = catalogOf({ geolocation, html: navigator }, { singletons: ['navigator.geolocation', 'navigator'] })

    expect(catalog.singletons.window).toEqual({
      navigator: { interface: 'Navigator', via: 'Window.navigator' },
      'navigator.geolocation': { interface: 'Geolocation', via: 'Navigator.prototype.geolocation' },
    })
    expect(catalog.holders.window['navigator.geolocation']).toEqual({
      kind: 'instance',
      owner: 'Geolocation',
      proto: 'Geolocation.prototype',
    })
    expect(catalog.singletons['dedicated-worker']).toEqual({
      navigator: { interface: 'WorkerNavigator', via: 'WorkerGlobalScope.prototype.navigator' },
    })
  })

  test('refuses a nested singleton whose path extends no singleton', () => {
    expect(() => catalogOf({ geolocation, html: navigator }, { singletons: ['navigator.geolocation'] })).toThrow(
      'platform singleton navigator.geolocation extends navigator, which is not a platform singleton',
    )
  })

  test('refuses a singleton the IDL does not resolve: no such property, or one that holds no interface instance', () => {
    const idl = {
      html: `${history} partial interface Window { readonly attribute DOMString status; undefined stop(); };`,
    }

    expect(() => catalogOf(idl, { singletons: ['histroy'] })).toThrow('platform singleton histroy resolves in no realm')
    expect(() => catalogOf(idl, { singletons: ['status'] })).toThrow(
      'platform singleton status is Window.status, which holds no interface instance or namespace named status',
    )
    expect(() => catalogOf(idl, { singletons: ['stop'] })).toThrow(
      'platform singleton stop is Window.stop, which holds no interface instance or namespace named stop',
    )
    expect(() =>
      catalogOf(
        {
          ...idl,
          workers: `
            [Exposed=Worker] interface WorkerOnly {};
            partial interface Window { readonly attribute WorkerOnly workerOnly; };`,
        },
        { singletons: ['workerOnly'] },
      ),
    ).toThrow(
      'platform singleton workerOnly is an instance of WorkerOnly, which has no interface prototype object in window',
    )
  })

  test('console is a singleton that stays the namespace holder it is, in every realm', () => {
    const catalog = catalogOf({ console: '[Exposed=*] namespace console { undefined log(any... data); };' }, {
      singletons: ['console'],
    })

    expect(catalog.singletons.window.console).toEqual({ namespace: 'console', via: 'Window.console' })
    expect(catalog.singletons['service-worker'].console).toEqual({
      namespace: 'console',
      via: 'ServiceWorkerGlobalScope.console',
    })
    expect(catalog.holders.window.console).toEqual({ kind: 'namespace', owner: 'console', proto: 'console.[[Prototype]]' })
    expect(catalog.targets.window['console.log']).toMatchObject({ holder: 'namespace' })
  })
})

describe('alias groups', () => {
  test("a singleton's group has every access path to it: its canonical path, and that path from each name of the global", () => {
    const catalog = catalogOf({ html: `${history}${location}` }, { singletons: ['history', 'location'] })

    expect(catalog.aliasGroups.window).toEqual({
      history: ['history', 'self.history', 'window.history'],
      location: ['location', 'self.location', 'window.location'],
    })
    expect(catalog.aliasGroups['dedicated-worker']).toEqual({ location: ['location', 'self.location'] })
  })

  test('an alias joins its singleton\'s group, from the global or through another singleton, in the realms it resolves in', () => {
    const catalog = catalogOf(
      { html: `${location}${navigator}${document}` },
      {
        singletons: ['document', 'location', 'navigator'],
        aliases: { 'document.location': 'location', clientInformation: 'navigator' },
      },
    )

    expect(catalog.aliasGroups.window.location).toEqual([
      'document.location',
      'location',
      'self.document.location',
      'self.location',
      'window.document.location',
      'window.location',
    ])
    expect(catalog.aliasGroups.window.navigator).toEqual([
      'clientInformation',
      'navigator',
      'self.clientInformation',
      'self.navigator',
      'window.clientInformation',
      'window.navigator',
    ])
    expect(catalog.aliasGroups['shared-worker'].navigator).toEqual(['navigator', 'self.navigator'])
  })

  test("a nested singleton's group extends every path to the singleton it extends, aliases included", () => {
    const catalog = catalogOf(
      { geolocation, html: navigator },
      { singletons: ['navigator', 'navigator.geolocation'], aliases: { clientInformation: 'navigator' } },
    )

    expect(catalog.aliasGroups.window['navigator.geolocation']).toEqual([
      'clientInformation.geolocation',
      'navigator.geolocation',
      'self.clientInformation.geolocation',
      'self.navigator.geolocation',
      'window.clientInformation.geolocation',
      'window.navigator.geolocation',
    ])
  })

  test('refuses an alias or a name of the global that the IDL does not resolve, and an alias that reaches another value', () => {
    const idl = { html: `${history}${location}${navigator}${document}` }
    const singletons = ['document', 'history', 'location', 'navigator']
    const aliasing = (aliases: Record<string, string>) => () => catalogOf(idl, { singletons, aliases })

    expect(aliasing({ clientInformation: 'nav' })).toThrow(
      'alias clientInformation names nav, which is not a platform singleton',
    )
    expect(aliasing({ clientInfo: 'navigator' })).toThrow('alias clientInfo resolves in no realm')
    expect(aliasing({ 'frames.location': 'location' })).toThrow(
      'alias frames.location extends frames, which is not a platform singleton',
    )
    expect(aliasing({ clientInformation: 'history' })).toThrow(
      'alias clientInformation is Window.clientInformation, which does not hold platform singleton history in window',
    )
    expect(aliasing({ history: 'navigator' })).toThrow('alias history is itself a platform singleton')
    expect(() => catalogOf(idl, { singletons, globalNames: ['self', 'globalThis'] })).toThrow(
      'global name globalThis resolves in no realm',
    )
  })

  test('refuses aliases whose paths never end, because they go through the singleton they reach', () => {
    const loop = `
      [Exposed=Window] interface Loop { readonly attribute Loop again; };
      partial interface Window { readonly attribute Loop loop; };`

    expect(() => catalogOf({ loop }, { singletons: ['loop'], aliases: { 'loop.again': 'loop' } })).toThrow(
      'the alias paths to loop go through loop itself',
    )
  })

  test("members a spec defines in prose on each instance are per-instance members too, so a singleton owns them", () => {
    const catalog = catalogOf({ html: location }, { singletons: ['location'] }, locationProse)
    const valueOf = { owner: 'Location', member: 'valueOf', kind: 'function', spec: 'html', descriptor: nonWritable }

    expect(catalog.instanceMembers.window.Location.valueOf).toEqual({ ...valueOf, surface: 'other' })
    expect(catalog.targets.window['location.valueOf']).toEqual({ ...valueOf, holder: 'instance', surface: 'other' })
    expect(catalog.targets.window['location.@@toPrimitive']).toEqual({
      owner: 'Location',
      member: '@@toPrimitive',
      holder: 'instance',
      kind: 'value',
      spec: 'html',
      descriptor: nonWritable,
      surface: 'other',
    })
    expect(catalog.proseMembers).toEqual(locationProse)
    // A WorkerLocation is no Location, so worker realms have none.
    for (const realm of ['dedicated-worker', 'shared-worker', 'service-worker']) {
      expect(Object.keys(catalog.targets[realm]).filter((name) => name.startsWith('location.')), realm).toEqual([])
    }
  })

  test('refuses a prose member of an interface no realm exposes, one its IDL defines, or one whose kind and descriptor disagree', () => {
    const member = locationProse.Location.valueOf
    const refused = [
      [{ Place: { valueOf: member } }, 'the prose member Place.valueOf is on Place, which no realm exposes'],
      [{ Location: { reload: member } }, 'the prose member Location.reload is already defined by the IDL of Location'],
      [
        { Location: { valueOf: { ...member, kind: 'accessor' } } },
        'the prose member Location.valueOf has kind accessor, but a data descriptor',
      ],
    ] as const

    for (const [overlay, message] of refused) {
      expect(() => catalogOf({ html: location }, { singletons: ['location'] }, overlay)).toThrow(message)
    }
    const prototypeMember = { Location: { assign: member } }
    const withPrototypeMember = location.replace('undefined reload();', 'undefined reload(); undefined assign();')
    expect(() => catalogOf({ html: withPrototypeMember }, {}, prototypeMember)).toThrow(
      'the prose member Location.assign is already defined by the IDL of Location',
    )
  })

  test('writes the same catalog whatever order the overlay lists its singletons and aliases in', () => {
    const idl = { geolocation, html: `${location}${navigator}${document}` }
    const listed = ['document', 'location', 'navigator', 'navigator.geolocation']
    const aliases = { 'document.location': 'location', clientInformation: 'navigator' }
    const generateWith = (overlay: Overlay) => generate({ idl: { globals, ...idl }, singletons: overlay, upstream })

    const first = generateWith({ globalNames: ['self', 'window'], singletons: listed, aliases })
    const second = generateWith({
      globalNames: ['window', 'self'],
      singletons: [...listed].reverse(),
      aliases: { clientInformation: 'navigator', 'document.location': 'location' },
    })

    expect(second.catalog).toBe(first.catalog)
  })
})

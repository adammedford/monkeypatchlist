import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import type { CatalogTarget, Realm } from '../src/index.ts'
import { canonicalJson } from '../tools/catalog-generator/canonical-json.ts'
import { check, generate, type Sources } from '../tools/catalog-generator/generate.ts'
import { escapeOnlyShapesOverlay, frameworkPathRulesOverlay } from '../tools/catalog-generator/path-rules.ts'
import { remoteUrlNormalizationOverlay } from '../tools/catalog-generator/remote-url-normalization.ts'
import { targetDiff as diffCatalogs } from '../tools/catalog-generator/target-diff.ts'

const upstream = { '@webref/idl': '1.0.0', webidl2: '24.5.0' }

/** Web IDL's descriptors (ECMAScript binding), as the member data records them. */
const descriptors = {
  operation: { type: 'data', writable: true, enumerable: true, configurable: true },
  constant: { type: 'data', writable: false, enumerable: true, configurable: false },
  readonlyAttribute: { type: 'accessor', setter: false, enumerable: true, configurable: true },
  /** A property of the global or of a namespace that holds an interface or namespace object. */
  globalProperty: { type: 'data', writable: true, enumerable: false, configurable: true },
}

/** The global interfaces of the four realms, plus a worklet global that maps to no realm. */
const globals = `
  [Global=Window, Exposed=Window] interface Window {};
  [Global=(Worker,DedicatedWorker), Exposed=DedicatedWorker] interface DedicatedWorkerGlobalScope {};
  [Global=(Worker,SharedWorker), Exposed=SharedWorker] interface SharedWorkerGlobalScope {};
  [Global=(Worker,ServiceWorker), Exposed=ServiceWorker] interface ServiceWorkerGlobalScope {};
  [Global=(Worklet,PaintWorklet), Exposed=PaintWorklet] interface PaintWorkletGlobalScope {};`

function catalogOf(idl: Record<string, string>) {
  return JSON.parse(generate({ idl: { globals, ...idl }, upstream }).catalog)
}

/**
 * The targets, per realm, without the structural properties Web IDL gives every interface and namespace (`X.prototype`,
 * `X.prototype.constructor`, `@@toStringTag`), which `web-idl-synthesized-members.test.ts` covers.
 */
function targetsOf(idl: Record<string, string>): ReturnType<typeof catalogOf> {
  return withoutStructural(catalogOf(idl).targets)
}

const structuralMembers = new Set(['prototype', 'constructor', '@@toStringTag'])

function withoutStructural(targets: Record<Realm, Record<string, CatalogTarget>>): Record<Realm, Record<string, CatalogTarget>> {
  return Object.fromEntries(
    Object.entries(targets).map(([realm, named]) => [
      realm,
      Object.fromEntries(Object.entries(named).filter(([, { member }]) => !structuralMembers.has(member))),
    ]),
  ) as Record<Realm, Record<string, CatalogTarget>>
}

/**
 * The targets that are IDL members, per realm: without the properties that hold interface and namespace objects,
 * which every interface and namespace adds to the global.
 */
function memberTargetsOf(idl: Record<string, string>): Record<Realm, Record<string, CatalogTarget>> {
  const targets: Record<Realm, Record<string, CatalogTarget>> = targetsOf(idl)
  return Object.fromEntries(
    Object.entries(targets).map(([realm, named]) => [
      realm,
      Object.fromEntries(Object.entries(named).filter(([, { kind }]) => kind !== 'interface' && kind !== 'namespace')),
    ]),
  ) as Record<Realm, Record<string, CatalogTarget>>
}

/** The target names listed in each realm. */
function realmsOf(targets: Record<string, Record<string, unknown>>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(targets).map(([realm, named]) => [realm, Object.keys(named)]))
}

describe('exposure', () => {
  test('lists targets per realm: an interface exposed to Window has its targets in window only', () => {
    const targets = memberTargetsOf({ html: '[Exposed=Window] interface History { undefined back(); };' })

    expect(targets).toEqual({
      window: {
        'History.prototype.back': {
          owner: 'History',
          member: 'back',
          holder: 'prototype',
          kind: 'operation',
          spec: 'html',
          descriptor: descriptors.operation,
          surface: 'other',
        },
      },
      'dedicated-worker': {},
      'shared-worker': {},
      'service-worker': {},
    })
  })

  test('the Worker shorthand reaches every worker realm, and a list reaches each realm it names', () => {
    const targets = memberTargetsOf({
      html: '[Exposed=Worker] interface WorkerGlobalScope { undefined importScripts(); };',
      xhr: '[Exposed=(Window,DedicatedWorker,SharedWorker)] interface XMLHttpRequest { undefined abort(); };',
    })

    expect(realmsOf(targets)).toEqual({
      window: ['XMLHttpRequest.prototype.abort'],
      'dedicated-worker': ['WorkerGlobalScope.prototype.importScripts', 'XMLHttpRequest.prototype.abort'],
      'shared-worker': ['WorkerGlobalScope.prototype.importScripts', 'XMLHttpRequest.prototype.abort'],
      'service-worker': ['WorkerGlobalScope.prototype.importScripts'],
    })
  })

  test('[Exposed=*] reaches all four realms, and a worklet-only interface reaches none', () => {
    const targets = memberTargetsOf({
      url: '[Exposed=*] interface URL { static boolean canParse(USVString url); };',
      'css-paint-api': '[Exposed=PaintWorklet] interface PaintSize { readonly attribute double width; };',
    })

    expect(realmsOf(targets)).toEqual({
      window: ['URL.canParse'],
      'dedicated-worker': ['URL.canParse'],
      'shared-worker': ['URL.canParse'],
      'service-worker': ['URL.canParse'],
    })
  })

  test('a member with its own [Exposed] is only in the realms it names', () => {
    const targets = memberTargetsOf({
      xhr: `
        [Exposed=(Window,DedicatedWorker,SharedWorker)]
        interface XMLHttpRequest {
          undefined abort();
          [Exposed=Window] readonly attribute Document? responseXML;
        };`,
    })

    expect(realmsOf(targets)).toEqual({
      window: ['XMLHttpRequest.prototype.abort', 'XMLHttpRequest.prototype.responseXML'],
      'dedicated-worker': ['XMLHttpRequest.prototype.abort'],
      'shared-worker': ['XMLHttpRequest.prototype.abort'],
      'service-worker': [],
    })
  })

  test('a partial with its own [Exposed] exposes its members there, and a partial without one follows its base', () => {
    const targets = memberTargetsOf({
      url: '[Exposed=*] interface URL { static boolean canParse(USVString url); };',
      FileAPI: `
        [Exposed=(Window,DedicatedWorker,SharedWorker)]
        partial interface URL {
          static DOMString createObjectURL((Blob or MediaSource) obj);
        };`,
      'url-extra': 'partial interface URL { static URL? parse(USVString url); };',
    })

    expect(realmsOf(targets)).toEqual({
      window: ['URL.canParse', 'URL.createObjectURL', 'URL.parse'],
      'dedicated-worker': ['URL.canParse', 'URL.createObjectURL', 'URL.parse'],
      'shared-worker': ['URL.canParse', 'URL.createObjectURL', 'URL.parse'],
      'service-worker': ['URL.canParse', 'URL.parse'],
    })
  })

  test("mixin members intersect with each host's exposure; a partial mixin without [Exposed] follows its mixin", () => {
    const targets = memberTargetsOf({
      html: `
        [Exposed=Window] interface Navigator {};
        [Exposed=Worker] interface WorkerNavigator {};
        interface mixin NavigatorID {
          readonly attribute DOMString userAgent;
          [Exposed=Window] readonly attribute DOMString vendor;
        };
        Navigator includes NavigatorID;
        WorkerNavigator includes NavigatorID;`,
      'html-extra': '[Exposed=Window] partial interface mixin NavigatorID { boolean taintEnabled(); };',
      'ua-client-hints': `
        [Exposed=Window] interface mixin NavigatorUA {
          [SecureContext] readonly attribute NavigatorUAData userAgentData;
        };
        Navigator includes NavigatorUA;
        WorkerNavigator includes NavigatorUA;`,
      'ua-extra': 'partial interface mixin NavigatorUA { readonly attribute DOMString platformVersion; };',
    })

    expect(realmsOf(targets)).toEqual({
      window: [
        'Navigator.prototype.platformVersion',
        'Navigator.prototype.taintEnabled',
        'Navigator.prototype.userAgent',
        'Navigator.prototype.userAgentData',
        'Navigator.prototype.vendor',
      ],
      'dedicated-worker': ['WorkerNavigator.prototype.userAgent'],
      'shared-worker': ['WorkerNavigator.prototype.userAgent'],
      'service-worker': ['WorkerNavigator.prototype.userAgent'],
    })
  })

  test('the intersection with the host is of global names, as Web IDL defines it, and * yields to the other side', () => {
    const targets = memberTargetsOf({
      spec: `
        [Exposed=DedicatedWorker] interface DedicatedOnly {};
        [Exposed=*] interface Everywhere {};
        [Exposed=Worker] interface mixin ForWorkers { undefined run(); };
        [Exposed=*] interface mixin ForAll { undefined go(); };
        DedicatedOnly includes ForWorkers;
        DedicatedOnly includes ForAll;
        Everywhere includes ForWorkers;`,
    })

    expect(realmsOf(targets)).toEqual({
      window: [],
      'dedicated-worker': ['DedicatedOnly.prototype.go', 'Everywhere.prototype.run'],
      'shared-worker': ['Everywhere.prototype.run'],
      'service-worker': ['Everywhere.prototype.run'],
    })
  })

  test('a callback interface without [Exposed] has no interface object, so its constants are in no realm', () => {
    const targets = memberTargetsOf({
      dom: 'callback interface EventListener { const unsigned short CAPTURE = 1; undefined handleEvent(Event event); };',
    })

    expect(realmsOf(targets)).toEqual({ window: [], 'dedicated-worker': [], 'shared-worker': [], 'service-worker': [] })
  })

  test('refuses an interface or namespace without [Exposed]', () => {
    expect(() => memberTargetsOf({ dom: 'interface Node { undefined normalize(); };' })).toThrow(
      'interface Node (dom) has no [Exposed]',
    )
    expect(() => memberTargetsOf({ console: 'namespace console { undefined log(); };' })).toThrow(
      'namespace console (console) has no [Exposed]',
    )
  })

  test('refuses an [Exposed] that names no global', () => {
    expect(() => memberTargetsOf({ dom: '[Exposed=(Window,Wrker)] interface Node {};' })).toThrow(
      'interface Node (dom): [Exposed] names Wrker, which no [Global] interface declares',
    )
    expect(() =>
      memberTargetsOf({ dom: '[Exposed=Window] interface Node { [Exposed=Windw] undefined normalize(); };' }),
    ).toThrow('Node.normalize (dom): [Exposed] names Windw, which no [Global] interface declares')
  })

  test('refuses IDL that declares no global interface for one of the four realms', () => {
    const withoutServiceWorker = globals.replace(/^.*ServiceWorkerGlobalScope.*$/m, '')

    expect(() => generate({ idl: { globals: withoutServiceWorker }, upstream })).toThrow(
      'no interface declares [Global=ServiceWorker], so the service-worker realm has no global',
    )
  })

  test('refuses a member or partial exposed in a realm where its interface is not', () => {
    expect(() =>
      memberTargetsOf({ xhr: '[Exposed=Window] interface XMLHttpRequest { [Exposed=Worker] undefined abort(); };' }),
    ).toThrow('XMLHttpRequest.abort (xhr) is exposed in dedicated-worker, where XMLHttpRequest is not')
    expect(() =>
      memberTargetsOf({
        html: '[Exposed=Window] interface Navigator {};',
        serial: '[Exposed=Worker] partial interface Navigator { readonly attribute Serial serial; };',
      }),
    ).toThrow('Navigator.serial (serial) is exposed in dedicated-worker, where Navigator is not')
  })
})

/** The global interfaces with the inheritance real IDL gives them: the worker globals inherit WorkerGlobalScope. */
const inheritingGlobals = `
  [Exposed=*] interface EventTarget { undefined addEventListener(DOMString type); };
  [Global=Window, Exposed=Window] interface Window : EventTarget { getter object (DOMString name); };
  [Exposed=Worker] interface WorkerGlobalScope : EventTarget {};
  [Global=(Worker,DedicatedWorker), Exposed=DedicatedWorker]
  interface DedicatedWorkerGlobalScope : WorkerGlobalScope { undefined postMessage(any message); };
  [Global=(Worker,SharedWorker), Exposed=SharedWorker] interface SharedWorkerGlobalScope : WorkerGlobalScope {};
  [Global=(Worker,ServiceWorker), Exposed=ServiceWorker] interface ServiceWorkerGlobalScope : WorkerGlobalScope {};`

describe('holder placement', () => {
  test("a [Global] interface's members, mixins and partials included, are own properties of the global", () => {
    const targets = targetsOf({
      globals: inheritingGlobals,
      html: `
        [Exposed=(Window,Worker)]
        interface mixin WindowOrWorkerGlobalScope { undefined setTimeout(); };
        Window includes WindowOrWorkerGlobalScope;
        WorkerGlobalScope includes WindowOrWorkerGlobalScope;
        partial interface Window { readonly attribute boolean closed; };`,
      fetch: 'partial interface mixin WindowOrWorkerGlobalScope { Promise<Response> fetch(RequestInfo input); };',
    })

    expect(targets.window['Window.fetch']).toEqual({
      owner: 'Window',
      member: 'fetch',
      holder: 'global',
      kind: 'operation',
      spec: 'fetch',
      mixin: 'WindowOrWorkerGlobalScope',
      descriptor: descriptors.operation,
      surface: 'other',
    })
    expect(targets.window['Window.setTimeout']).toMatchObject({ holder: 'global', mixin: 'WindowOrWorkerGlobalScope' })
    expect(targets.window['Window.closed']).toMatchObject({ holder: 'global', kind: 'attribute', spec: 'html' })
    expect(targets.window['Window.prototype.fetch']).toBeUndefined()
    expect(targets['dedicated-worker']['DedicatedWorkerGlobalScope.postMessage']).toMatchObject({ holder: 'global' })
  })

  test('an interface the global inherits keeps its members on its prototype', () => {
    const targets = targetsOf({
      globals: inheritingGlobals,
      html: `
        [Exposed=(Window,Worker)]
        interface mixin WindowOrWorkerGlobalScope { undefined setTimeout(); };
        WorkerGlobalScope includes WindowOrWorkerGlobalScope;`,
    })

    for (const realm of ['dedicated-worker', 'shared-worker', 'service-worker']) {
      expect(targets[realm]['WorkerGlobalScope.prototype.setTimeout']).toMatchObject({
        owner: 'WorkerGlobalScope',
        holder: 'prototype',
      })
      expect(targets[realm]['EventTarget.prototype.addEventListener']).toMatchObject({ holder: 'prototype' })
    }
    expect(targets.window['EventTarget.prototype.addEventListener']).toMatchObject({ holder: 'prototype' })
  })

  test('holders chain to their parents: the window global runs through WindowProperties to EventTarget.prototype', () => {
    const { holders, targets } = catalogOf({ globals: inheritingGlobals })

    expect(holders.window).toMatchObject({
      Window: { kind: 'global', owner: 'Window', proto: 'Window.prototype' },
      'Window.prototype': { kind: 'prototype', owner: 'Window', proto: 'WindowProperties' },
      WindowProperties: { kind: 'prototype', owner: 'Window', proto: 'EventTarget.prototype' },
      'EventTarget.prototype': { kind: 'prototype', owner: 'EventTarget', proto: 'Object.prototype' },
    })
    expect(Object.keys(targets.window).filter((name) => name.startsWith('WindowProperties.'))).toEqual([])
  })

  test('chains that inherit no interface end in the ECMAScript intrinsics, as the Web IDL binding links them', () => {
    const { holders } = catalogOf({
      globals: inheritingGlobals,
      dom: `
        [Exposed=Window] interface Node {};
        [Exposed=*, Serializable] interface DOMException {};
        [Exposed=Window] callback interface NodeFilter { const unsigned short FILTER_ACCEPT = 1; };
        [Exposed=Window] namespace CSS {};`,
    })

    expect(holders.window).toMatchObject({
      'Node.prototype': { proto: 'Object.prototype' },
      Node: { kind: 'constructor', proto: 'Function.prototype' },
      NodeFilter: { kind: 'constructor', proto: 'Function.prototype' },
      CSS: { kind: 'namespace', proto: 'Object.prototype' },
      'DOMException.prototype': { proto: 'Error.prototype' },
      DOMException: { kind: 'constructor', proto: 'Function.prototype' },
      EventTarget: { kind: 'constructor', proto: 'Function.prototype' },
    })
    expect(holders['service-worker']['DOMException.prototype']).toMatchObject({ proto: 'Error.prototype' })
  })

  test('worker globals chain through WorkerGlobalScope.prototype and have no WindowProperties', () => {
    const { holders } = catalogOf({ globals: inheritingGlobals })

    expect(holders['dedicated-worker']).toMatchObject({
      DedicatedWorkerGlobalScope: {
        kind: 'global',
        owner: 'DedicatedWorkerGlobalScope',
        proto: 'DedicatedWorkerGlobalScope.prototype',
      },
      'DedicatedWorkerGlobalScope.prototype': {
        kind: 'prototype',
        owner: 'DedicatedWorkerGlobalScope',
        proto: 'WorkerGlobalScope.prototype',
      },
      'WorkerGlobalScope.prototype': { kind: 'prototype', owner: 'WorkerGlobalScope', proto: 'EventTarget.prototype' },
    })
    expect(holders['shared-worker'].SharedWorkerGlobalScope).toMatchObject({ kind: 'global' })
    expect(holders['service-worker'].ServiceWorkerGlobalScope).toMatchObject({ kind: 'global' })
    for (const realm of ['dedicated-worker', 'shared-worker', 'service-worker']) {
      expect(holders[realm]).not.toHaveProperty('WindowProperties')
      expect(holders[realm]).not.toHaveProperty('Window.prototype')
    }
  })

  test('refuses an interface that inherits an undefined interface, or one not exposed where it is', () => {
    expect(() => targetsOf({ dom: '[Exposed=Window] interface Element : Node {};' })).toThrow(
      'interface Element (dom) inherits Node, which is not an interface',
    )
    expect(() =>
      targetsOf({ dom: '[Exposed=Window] interface Node {}; [Exposed=*] interface Element : Node {};' }),
    ).toThrow('Element is exposed in dedicated-worker, where the interface it inherits, Node, is not')
  })

  test("interface objects are constructor holders, reached from each realm's global", () => {
    const { holders, targets } = catalogOf({
      globals: inheritingGlobals,
      xhr: `
        [Exposed=(Window,DedicatedWorker,SharedWorker)]
        interface XMLHttpRequestEventTarget : EventTarget {};
        [Exposed=(Window,DedicatedWorker,SharedWorker)]
        interface XMLHttpRequest : XMLHttpRequestEventTarget { constructor(); };`,
    })

    expect(targets.window['Window.XMLHttpRequest']).toEqual({
      owner: 'Window',
      member: 'XMLHttpRequest',
      holder: 'global',
      kind: 'interface',
      holds: 'XMLHttpRequest',
      spec: 'xhr',
      descriptor: descriptors.globalProperty,
      surface: 'other',
    })
    expect(targets['dedicated-worker']['DedicatedWorkerGlobalScope.XMLHttpRequest']).toMatchObject({
      owner: 'DedicatedWorkerGlobalScope',
      holder: 'global',
      holds: 'XMLHttpRequest',
    })
    expect(targets['shared-worker']['SharedWorkerGlobalScope.XMLHttpRequest']).toMatchObject({ holder: 'global' })
    expect(targets['service-worker']).not.toHaveProperty(['ServiceWorkerGlobalScope.XMLHttpRequest'])
    expect(targets['service-worker']['ServiceWorkerGlobalScope.EventTarget']).toMatchObject({ holds: 'EventTarget' })
    expect(holders.window.XMLHttpRequest).toEqual({
      kind: 'constructor',
      owner: 'XMLHttpRequest',
      proto: 'XMLHttpRequestEventTarget',
    })
    expect(holders.window.EventTarget).toEqual({ kind: 'constructor', owner: 'EventTarget', proto: 'Function.prototype' })
    expect(holders['service-worker']).not.toHaveProperty('XMLHttpRequest')
  })

  test('an interface with [LegacyNoInterfaceObject] has a prototype, but no interface object on the global', () => {
    const { holders, targets } = catalogOf({
      WEBGL_lose_context: `
        [LegacyNoInterfaceObject, Exposed=(Window,Worker)]
        interface WEBGL_lose_context { undefined loseContext(); };`,
    })

    expect(holders.window['WEBGL_lose_context.prototype']).toEqual({
      kind: 'prototype',
      owner: 'WEBGL_lose_context',
      proto: 'Object.prototype',
    })
    expect(targets.window['WEBGL_lose_context.prototype.loseContext']).toMatchObject({ holder: 'prototype' })
    expect(holders.window).not.toHaveProperty('WEBGL_lose_context')
    expect(targets.window).not.toHaveProperty(['Window.WEBGL_lose_context'])
  })

  test('a callback interface with constants has a legacy callback interface object on the global, and no prototype', () => {
    const { holders, targets } = catalogOf({
      dom: `
        [Exposed=Window]
        callback interface NodeFilter { const unsigned short FILTER_ACCEPT = 1; unsigned short acceptNode(Node node); };
        [Exposed=Window] callback interface NoConstants { undefined handle(); };`,
    })

    expect(targets.window['Window.NodeFilter']).toEqual({
      owner: 'Window',
      member: 'NodeFilter',
      holder: 'global',
      kind: 'interface',
      holds: 'NodeFilter',
      spec: 'dom',
      descriptor: descriptors.globalProperty,
      surface: 'other',
    })
    expect(holders.window.NodeFilter).toEqual({ kind: 'constructor', owner: 'NodeFilter', proto: 'Function.prototype' })
    expect(holders.window).not.toHaveProperty(['NodeFilter.prototype'])
    expect(targets.window).not.toHaveProperty(['Window.NoConstants'])
    expect(holders.window).not.toHaveProperty('NoConstants')
  })

  test("a realm global interface's own interface object is a constructor holder named by its path from the global", () => {
    const { holders, targets } = catalogOf({})

    expect(targets.window['Window.Window']).toEqual({
      owner: 'Window',
      member: 'Window',
      holder: 'global',
      kind: 'interface',
      spec: 'globals',
      holds: 'Window.Window',
      descriptor: descriptors.globalProperty,
      surface: 'other',
    })
    expect(holders.window['Window.Window']).toEqual({ kind: 'constructor', owner: 'Window', proto: 'Function.prototype' })
    expect(holders.window.Window).toMatchObject({ kind: 'global', proto: 'Window.prototype' })
    expect(targets['dedicated-worker']['DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope']).toMatchObject({
      kind: 'interface',
      holds: 'DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope',
      descriptor: descriptors.globalProperty,
      surface: 'other',
    })
    expect(holders['dedicated-worker']['DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope']).toEqual({
      kind: 'constructor',
      owner: 'DedicatedWorkerGlobalScope',
      proto: 'Function.prototype',
    })
    expect(holders.window).not.toHaveProperty(['Window.Window.prototype'])
  })

  test("the global interface's interface object chains to the interface object of the interface it inherits", () => {
    const idl = {
      globals: globals.replace('interface Window {}', 'interface Window : EventTarget {}'),
      dom: '[Exposed=*] interface EventTarget {};',
      html: '[Exposed=Window] interface Frame : Window {};',
    }
    const { holders } = JSON.parse(generate({ idl, upstream }).catalog)

    expect(holders.window['Window.Window']).toEqual({ kind: 'constructor', owner: 'Window', proto: 'EventTarget' })
    // An interface object's [[Prototype]] is its parent's interface object, which for the global's interface is the
    // holder `Window.Window`, not the global object `Window`.
    expect(holders.window.Frame).toEqual({ kind: 'constructor', owner: 'Frame', proto: 'Window.Window' })
    expect(holders.window['Frame.prototype']).toMatchObject({ proto: 'Window.prototype' })
  })

  test('constants are on both the interface object and the interface prototype object', () => {
    const targets = targetsOf({ dom: '[Exposed=Window] interface Node { const unsigned short ELEMENT_NODE = 1; };' })

    expect(targets.window['Node.ELEMENT_NODE']).toEqual({
      owner: 'Node',
      member: 'ELEMENT_NODE',
      holder: 'constructor',
      kind: 'constant',
      spec: 'dom',
      descriptor: descriptors.constant,
      surface: 'other',
    })
    expect(targets.window['Node.prototype.ELEMENT_NODE']).toEqual({
      owner: 'Node',
      member: 'ELEMENT_NODE',
      holder: 'prototype',
      kind: 'constant',
      spec: 'dom',
      descriptor: descriptors.constant,
      surface: 'other',
    })
  })

  test('an interface without an interface object has its constants on its prototype only', () => {
    const targets = targetsOf({
      EXT_texture_filter_anisotropic: `
        [Exposed=(Window,Worker), LegacyNoInterfaceObject]
        interface EXT_texture_filter_anisotropic { const GLenum TEXTURE_MAX_ANISOTROPY_EXT = 0x84FE; };`,
    })

    expect(targets.window['EXT_texture_filter_anisotropic.prototype.TEXTURE_MAX_ANISOTROPY_EXT']).toMatchObject({
      holder: 'prototype',
      kind: 'constant',
      descriptor: descriptors.constant,
      surface: 'other',
    })
    expect(targets.window).not.toHaveProperty(['EXT_texture_filter_anisotropic.TEXTURE_MAX_ANISOTROPY_EXT'])
  })

  test("statics and constants on a [Global] interface are named by its interface object's path from the global", () => {
    const targets = memberTargetsOf({
      html: 'partial interface Window { const unsigned short TEMPORARY = 0; static undefined go(); undefined stop(); };',
      workers: 'partial interface DedicatedWorkerGlobalScope { static undefined go(); };',
    })

    expect(targets.window).toEqual({
      'Window.Window.TEMPORARY': expect.objectContaining({ holder: 'constructor', kind: 'constant', owner: 'Window' }),
      'Window.prototype.TEMPORARY': expect.objectContaining({ holder: 'prototype', kind: 'constant', owner: 'Window' }),
      'Window.Window.go': expect.objectContaining({ holder: 'constructor', kind: 'operation', owner: 'Window' }),
      'Window.stop': expect.objectContaining({ holder: 'global', kind: 'operation', owner: 'Window' }),
    })
    expect(targets['dedicated-worker']).toEqual({
      'DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope.go': expect.objectContaining({
        holder: 'constructor',
        kind: 'operation',
        owner: 'DedicatedWorkerGlobalScope',
      }),
    })
  })

  test('refuses a static member of an interface without an interface object', () => {
    expect(() =>
      targetsOf({ webgl: '[Exposed=Window, LegacyNoInterfaceObject] interface Ext { static undefined go(); };' }),
    ).toThrow('Ext.go (webgl) is static, but Ext has no interface object')
  })

  test("IDL namespaces are namespace holders, reached from each realm's global", () => {
    const { holders, targets } = catalogOf({
      console: '[Exposed=*] namespace console { undefined log(any... data); };',
      css: '[Exposed=Window] namespace CSS { boolean supports(CSSOMString conditionText); };',
    })

    expect(holders.window.CSS).toEqual({ kind: 'namespace', owner: 'CSS', proto: 'Object.prototype' })
    expect(targets.window['Window.console']).toEqual({
      owner: 'Window',
      member: 'console',
      holder: 'global',
      kind: 'namespace',
      holds: 'console',
      spec: 'console',
      descriptor: descriptors.globalProperty,
      surface: 'other',
    })
    expect(targets['service-worker']['ServiceWorkerGlobalScope.console']).toMatchObject({ holds: 'console' })
    expect(targets.window['console.log']).toMatchObject({ holder: 'namespace' })
  })

  test("console's [[Prototype]] is an empty object of its own, a prototype holder named by its path from the global", () => {
    const { holders, targets } = catalogOf({
      console: '[Exposed=*] namespace console { undefined log(any... data); };',
    })

    for (const realm of ['window', 'dedicated-worker', 'shared-worker', 'service-worker']) {
      expect(holders[realm].console).toEqual({ kind: 'namespace', owner: 'console', proto: 'console.[[Prototype]]' })
      expect(holders[realm]['console.[[Prototype]]']).toEqual({
        kind: 'prototype',
        owner: 'console',
        proto: 'Object.prototype',
      })
    }
    // It has no members of its own, so no target is on it.
    expect(Object.keys(targets.window).filter((name) => name.startsWith('console.[[Prototype]]'))).toEqual([])
  })

  test('the property holding a [LegacyNamespace] interface object is a namespace target; the object is a constructor', () => {
    const { holders, targets } = catalogOf({
      'wasm-js-api': `
        [Exposed=*] namespace WebAssembly { boolean validate(BufferSource bytes); };
        [LegacyNamespace=WebAssembly, Exposed=*]
        interface Module {
          constructor(BufferSource bytes);
          static sequence<ModuleExportDescriptor> exports(Module moduleObject);
        };
        [LegacyNamespace=WebAssembly, Exposed=*]
        interface Memory { undefined grow([EnforceRange] unsigned long delta); };`,
    })

    expect(targets.window['WebAssembly.Module']).toEqual({
      owner: 'WebAssembly',
      member: 'Module',
      holder: 'namespace',
      kind: 'interface',
      holds: 'WebAssembly.Module',
      spec: 'wasm-js-api',
      descriptor: descriptors.globalProperty,
      surface: 'other',
    })
    expect(holders.window['WebAssembly.Module']).toEqual({ kind: 'constructor', owner: 'Module', proto: 'Function.prototype' })
    expect(targets.window['WebAssembly.validate']).toMatchObject({ holder: 'namespace' })
    expect(targets.window).not.toHaveProperty(['Window.Module'])
    expect(targets.window['Window.WebAssembly']).toMatchObject({ kind: 'namespace', holds: 'WebAssembly' })
  })

  test('[LegacyNamespace] interfaces name their holders and targets by their qualified path from the namespace', () => {
    const { holders, targets } = catalogOf({
      'wasm-js-api': `
        [Exposed=*] namespace WebAssembly {};
        [LegacyNamespace=WebAssembly, Exposed=*]
        interface Module {
          constructor(BufferSource bytes);
          static sequence<ModuleExportDescriptor> exports(Module moduleObject);
        };
        [LegacyNamespace=WebAssembly, Exposed=*]
        interface Memory {
          const unsigned short PAGE = 1;
          undefined grow([EnforceRange] unsigned long delta);
        };`,
    })

    expect(targets.window['WebAssembly.Module.exports']).toEqual({
      owner: 'Module',
      member: 'exports',
      holder: 'constructor',
      kind: 'operation',
      spec: 'wasm-js-api',
      descriptor: descriptors.operation,
      surface: 'other',
    })
    expect(targets.window['WebAssembly.Memory.prototype.grow']).toEqual({
      owner: 'Memory',
      member: 'grow',
      holder: 'prototype',
      kind: 'operation',
      spec: 'wasm-js-api',
      descriptor: descriptors.operation,
      surface: 'other',
    })
    expect(targets.window['WebAssembly.Memory.PAGE']).toMatchObject({ holder: 'constructor', kind: 'constant' })
    expect(targets.window['WebAssembly.Memory.prototype.PAGE']).toMatchObject({ holder: 'prototype' })
    expect(holders.window['WebAssembly.Memory.prototype']).toEqual({
      kind: 'prototype',
      owner: 'Memory',
      proto: 'Object.prototype',
    })
    expect(targets['service-worker']['WebAssembly.Memory.prototype.grow']).toMatchObject({ holder: 'prototype' })
    for (const unqualified of ['Module.exports', 'Memory.prototype.grow', 'Memory.PAGE', 'Memory.prototype.PAGE']) {
      expect(targets.window).not.toHaveProperty([unqualified])
    }
    for (const unqualified of ['Module', 'Memory', 'Memory.prototype']) {
      expect(holders.window).not.toHaveProperty([unqualified])
    }
  })

  test('a [LegacyNamespace] interface chains to the qualified holders of the interface it inherits', () => {
    const { holders } = catalogOf({
      'wasm-js-api': `
        [Exposed=*] namespace WebAssembly {};
        [LegacyNamespace=WebAssembly, Exposed=*] interface Base {};
        [LegacyNamespace=WebAssembly, Exposed=*] interface Derived : Base {};
        [Exposed=*] interface Plain : Derived {};`,
    })

    expect(holders.window['WebAssembly.Derived']).toEqual({
      kind: 'constructor',
      owner: 'Derived',
      proto: 'WebAssembly.Base',
    })
    expect(holders.window['WebAssembly.Derived.prototype']).toEqual({
      kind: 'prototype',
      owner: 'Derived',
      proto: 'WebAssembly.Base.prototype',
    })
    expect(holders.window.Plain).toEqual({ kind: 'constructor', owner: 'Plain', proto: 'WebAssembly.Derived' })
    expect(holders.window['Plain.prototype']).toMatchObject({ proto: 'WebAssembly.Derived.prototype' })
  })

  test('refuses a [LegacyNamespace] that names no namespace exposed where the interface is', () => {
    expect(() => targetsOf({ wasm: '[LegacyNamespace=WebAssembly, Exposed=*] interface Module {};' })).toThrow(
      'Module (wasm) is in namespace WebAssembly, which is not exposed in window',
    )
    expect(() =>
      targetsOf({
        wasm: `
          [Exposed=Window] namespace WebAssembly {};
          [LegacyNamespace=WebAssembly, Exposed=*] interface Module {};`,
      }),
    ).toThrow('Module (wasm) is in namespace WebAssembly, which is not exposed in dedicated-worker')
  })

  test('[LegacyUnforgeable] members are per-instance: own members of each instance, never on the prototype', () => {
    const { targets, instanceMembers } = catalogOf({
      globals: inheritingGlobals,
      dom: `
        [Exposed=*] interface Event { [LegacyUnforgeable] readonly attribute boolean isTrusted; };
        [Exposed=Window] interface Document { readonly attribute DOMString title; };`,
      html: `
        [Exposed=Window]
        interface Location {
          [LegacyUnforgeable] stringifier attribute USVString href;
          [LegacyUnforgeable] undefined reload();
          readonly attribute DOMString hash;
        };
        partial interface Document { [PutForwards=href, LegacyUnforgeable] readonly attribute Location? location; };
        partial interface Window { [PutForwards=href, LegacyUnforgeable] readonly attribute Location location; };`,
    })

    const unforgeable = (setter: boolean) => ({ type: 'accessor', setter, enumerable: true, configurable: false })
    const unforgeableOperation = { type: 'data', writable: false, enumerable: true, configurable: false }
    expect(instanceMembers.window).toEqual({
      Document: {
        location: {
          owner: 'Document',
          member: 'location',
          kind: 'attribute',
          spec: 'html',
          descriptor: unforgeable(true),
          surface: 'other',
          assign: 'put-forwards',
        },
      },
      Event: {
        isTrusted: {
          owner: 'Event',
          member: 'isTrusted',
          kind: 'attribute',
          spec: 'dom',
          descriptor: unforgeable(false),
          surface: 'other',
          assign: 'readonly',
        },
      },
      Location: {
        href: {
          owner: 'Location',
          member: 'href',
          kind: 'attribute',
          spec: 'html',
          descriptor: unforgeable(true),
          surface: 'other',
          assign: 'setter',
        },
        reload: {
          owner: 'Location',
          member: 'reload',
          kind: 'operation',
          spec: 'html',
          descriptor: unforgeableOperation,
          surface: 'other',
        },
        // An unforgeable stringifier's toString is per-instance too.
        toString: {
          owner: 'Location',
          member: 'toString',
          kind: 'operation',
          spec: 'html',
          descriptor: unforgeableOperation,
          surface: 'other',
        },
      },
    })
    for (const realm of ['dedicated-worker', 'shared-worker', 'service-worker']) {
      expect(instanceMembers[realm]).toEqual({ Event: instanceMembers.window.Event })
    }
    expect(targets.window['Location.prototype.hash']).toMatchObject({ holder: 'prototype' })
    for (const name of ['Location.prototype.href', 'Location.prototype.reload', 'Document.prototype.location']) {
      expect(targets.window[name]).toBeUndefined()
    }
    expect(targets.window['Event.prototype.isTrusted']).toBeUndefined()
  })

  test("the global is the only instance of its [Global] interface, so that interface's unforgeables are global targets", () => {
    const { targets, instanceMembers } = catalogOf({
      globals: inheritingGlobals,
      html: `
        [Exposed=Window] interface Location {};
        partial interface Window { [PutForwards=href, LegacyUnforgeable] readonly attribute Location location; };`,
    })

    expect(targets.window['Window.location']).toEqual({
      owner: 'Window',
      member: 'location',
      holder: 'global',
      kind: 'attribute',
      spec: 'html',
      descriptor: { type: 'accessor', setter: true, enumerable: true, configurable: false },
      surface: 'other',
      assign: 'put-forwards',
    })
    expect(targets.window['Window.prototype.location']).toBeUndefined()
    expect(instanceMembers.window).toEqual({})
  })

  test('refuses a [LegacyUnforgeable] member of an interface a realm global inherits', () => {
    expect(() =>
      targetsOf({
        globals: inheritingGlobals,
        dom: 'partial interface EventTarget { [LegacyUnforgeable] readonly attribute boolean trusted; };',
      }),
    ).toThrow(
      'EventTarget.trusted (dom) is [LegacyUnforgeable], so it would be an own member of the window global, which inherits EventTarget',
    )
  })
})

describe('catalog generator', () => {
  test('places operations and attributes on the interface prototype', () => {
    const targets = memberTargetsOf({
      dom: `
        [Exposed=Window]
        interface Node {
          undefined normalize();
          readonly attribute DOMString nodeName;
        };`,
    })

    expect(targets.window).toEqual({
      'Node.prototype.normalize': {
        owner: 'Node',
        member: 'normalize',
        holder: 'prototype',
        kind: 'operation',
        spec: 'dom',
        descriptor: descriptors.operation,
        surface: 'other',
      },
      'Node.prototype.nodeName': {
        owner: 'Node',
        member: 'nodeName',
        holder: 'prototype',
        kind: 'attribute',
        spec: 'dom',
        descriptor: descriptors.readonlyAttribute,
        surface: 'other',
        assign: 'readonly',
      },
    })
  })

  test('places statics and constants on the interface object, and constants on the prototype too', () => {
    const targets = memberTargetsOf({
      url: `
        [Exposed=*]
        interface URL {
          static DOMString createObjectURL(Blob obj);
          static readonly attribute boolean ready;
          const unsigned short SPECIAL = 1;
        };`,
    })

    expect(targets.window).toEqual({
      'URL.createObjectURL': {
        owner: 'URL',
        member: 'createObjectURL',
        holder: 'constructor',
        kind: 'operation',
        spec: 'url',
        descriptor: descriptors.operation,
        surface: 'other',
      },
      'URL.ready': {
        owner: 'URL',
        member: 'ready',
        holder: 'constructor',
        kind: 'attribute',
        spec: 'url',
        descriptor: descriptors.readonlyAttribute,
        surface: 'other',
        assign: 'readonly',
      },
      'URL.SPECIAL': {
        owner: 'URL',
        member: 'SPECIAL',
        holder: 'constructor',
        kind: 'constant',
        spec: 'url',
        descriptor: descriptors.constant,
        surface: 'other',
      },
      'URL.prototype.SPECIAL': {
        owner: 'URL',
        member: 'SPECIAL',
        holder: 'prototype',
        kind: 'constant',
        spec: 'url',
        descriptor: descriptors.constant,
        surface: 'other',
      },
    })
  })

  test('merges partial interfaces into their base, keeping each member\'s own spec', () => {
    const targets = memberTargetsOf({
      geolocation: `
        partial interface Navigator {
          [SameObject] readonly attribute Geolocation geolocation;
        };`,
      html: `
        [Exposed=Window]
        interface Navigator {
          readonly attribute DOMString userAgent;
        };`,
    })

    expect(targets.window['Navigator.prototype.geolocation']).toMatchObject({ owner: 'Navigator', spec: 'geolocation' })
    expect(targets.window['Navigator.prototype.userAgent']).toMatchObject({ owner: 'Navigator', spec: 'html' })
  })

  test('refuses a partial whose base is not defined', () => {
    expect(() =>
      memberTargetsOf({ geolocation: 'partial interface Navigator { readonly attribute Geolocation geolocation; };' }),
    ).toThrow('partial interface Navigator (geolocation) has no base definition')
  })

  test('copies mixin members, partial mixins included, onto every interface that includes the mixin', () => {
    const targets = memberTargetsOf({
      fetch: `
        partial interface mixin WindowOrWorkerGlobalScope {
          [NewObject] Promise<Response> fetch(RequestInfo input, optional RequestInit init = {});
        };`,
      html: `
        [Exposed=Worker]
        interface WorkerGlobalScope {};
        [Exposed=(Window,Worker)]
        interface mixin WindowOrWorkerGlobalScope {
          readonly attribute boolean isSecureContext;
        };
        Window includes WindowOrWorkerGlobalScope;
        WorkerGlobalScope includes WindowOrWorkerGlobalScope;`,
    })

    const inWorkers = {
      'WorkerGlobalScope.prototype.fetch': {
        owner: 'WorkerGlobalScope',
        member: 'fetch',
        holder: 'prototype',
        kind: 'operation',
        spec: 'fetch',
        mixin: 'WindowOrWorkerGlobalScope',
        descriptor: descriptors.operation,
        surface: 'other',
      },
      'WorkerGlobalScope.prototype.isSecureContext': {
        owner: 'WorkerGlobalScope',
        member: 'isSecureContext',
        holder: 'prototype',
        kind: 'attribute',
        spec: 'html',
        mixin: 'WindowOrWorkerGlobalScope',
        descriptor: descriptors.readonlyAttribute,
        surface: 'other',
        assign: 'readonly',
      },
    }
    expect(targets['dedicated-worker']).toEqual(inWorkers)
    expect(targets['shared-worker']).toEqual(inWorkers)
    expect(targets['service-worker']).toEqual(inWorkers)
    expect(targets.window).toEqual({
      'Window.fetch': {
        owner: 'Window',
        member: 'fetch',
        holder: 'global',
        kind: 'operation',
        spec: 'fetch',
        mixin: 'WindowOrWorkerGlobalScope',
        descriptor: descriptors.operation,
        surface: 'other',
      },
      'Window.isSecureContext': {
        owner: 'Window',
        member: 'isSecureContext',
        holder: 'global',
        kind: 'attribute',
        spec: 'html',
        mixin: 'WindowOrWorkerGlobalScope',
        descriptor: descriptors.readonlyAttribute,
        surface: 'other',
        assign: 'readonly',
      },
    })
  })

  test('refuses an includes statement that names an undefined interface or mixin', () => {
    expect(() => memberTargetsOf({ dom: '[Exposed=Window] interface Document {}; Document includes ParentNode;' })).toThrow(
      'Document includes ParentNode (dom): no interface mixin ParentNode',
    )
    expect(() => memberTargetsOf({ dom: 'interface mixin ParentNode {}; Document includes ParentNode;' })).toThrow(
      'Document includes ParentNode (dom): no interface Document',
    )
  })

  test('places namespace members, partial namespaces included, on the namespace object', () => {
    const targets = memberTargetsOf({
      cssom: `
        [Exposed=Window]
        namespace CSS {
          CSSOMString escape(CSSOMString ident);
        };`,
      'css-conditional': `
        partial namespace CSS {
          boolean supports(CSSOMString conditionText);
        };`,
      webgpu: `
        [Exposed=(Window, Worker)]
        namespace GPUBufferUsage {
          const GPUFlagsConstant MAP_READ = 0x0001;
        };`,
    })

    expect(targets.window).toEqual({
      'CSS.escape': {
        owner: 'CSS',
        member: 'escape',
        holder: 'namespace',
        kind: 'operation',
        spec: 'cssom',
        descriptor: descriptors.operation,
        surface: 'other',
      },
      'CSS.supports': {
        owner: 'CSS',
        member: 'supports',
        holder: 'namespace',
        kind: 'operation',
        spec: 'css-conditional',
        descriptor: descriptors.operation,
        surface: 'other',
      },
      'GPUBufferUsage.MAP_READ': {
        owner: 'GPUBufferUsage',
        member: 'MAP_READ',
        holder: 'namespace',
        kind: 'constant',
        spec: 'webgpu',
        descriptor: descriptors.constant,
        surface: 'other',
      },
    })
  })

  test('keeps the constants of a callback interface, which live on its interface object', () => {
    const targets = memberTargetsOf({
      dom: `
        [Exposed=Window]
        callback interface NodeFilter {
          const unsigned short FILTER_ACCEPT = 1;
          unsigned short acceptNode(Node node);
        };`,
    })

    expect(targets.window).toEqual({
      'NodeFilter.FILTER_ACCEPT': {
        owner: 'NodeFilter',
        member: 'FILTER_ACCEPT',
        holder: 'constructor',
        kind: 'constant',
        spec: 'dom',
        descriptor: descriptors.constant,
        surface: 'other',
      },
    })
  })

  test('gives overloads one target, attributed to the first declaration', () => {
    const targets = memberTargetsOf({
      html: `
        [Exposed=Window]
        interface CanvasRenderingContext2D {
          undefined drawImage(CanvasImageSource image, double dx, double dy);
        };`,
      'html-extra': `
        partial interface CanvasRenderingContext2D {
          undefined drawImage(CanvasImageSource image, double dx, double dy, double dw, double dh);
        };`,
    })

    expect(targets.window).toEqual({
      'CanvasRenderingContext2D.prototype.drawImage': {
        owner: 'CanvasRenderingContext2D',
        member: 'drawImage',
        holder: 'prototype',
        kind: 'operation',
        spec: 'html',
        descriptor: descriptors.operation,
        surface: 'other',
      },
    })
  })

  test('refuses two different members that land on the same target', () => {
    expect(() =>
      memberTargetsOf({
        a: '[Exposed=Window] interface Foo { attribute long bar; };',
        b: 'partial interface Foo { undefined bar(); };',
      }),
    ).toThrow('Foo.prototype.bar is declared as an attribute (a) and as an operation (b)')
  })

  test('writes one JSON file with a fixed key order, whatever order the IDL arrives in', () => {
    const dom = `
      [Exposed=Window]
      interface Node {
        Node appendChild(Node node);
        const unsigned short ELEMENT_NODE = 1;
      };
      Node includes Slottable;`
    const shadow = `
      interface mixin Slottable {
        readonly attribute HTMLSlotElement? assignedSlot;
      };`
    const first = generate({ idl: { shadow, dom, globals }, upstream: { webidl2: '24.5.0', '@webref/idl': '1.0.0' } })
    const second = generate({ idl: { globals, dom, shadow }, upstream })

    expect(second.catalog).toBe(first.catalog)
    expect(first.catalog).toBe(`{
  "aliasGroups": {
    "dedicated-worker": {},
    "service-worker": {},
    "shared-worker": {},
    "window": {}
  },
  "engineExtensions": {},
  "enginePrototypes": {},
  "esAdditions": {},
  "esProseProperties": {},
  "escapeOnlyShapes": {},
  "exclusions": {},
  "frameworkPathRules": {},
  "holders": {
    "dedicated-worker": {
      "DedicatedWorkerGlobalScope": {
        "immutablePrototype": true,
        "kind": "global",
        "owner": "DedicatedWorkerGlobalScope",
        "proto": "DedicatedWorkerGlobalScope.prototype"
      },
      "DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope": {
        "kind": "constructor",
        "owner": "DedicatedWorkerGlobalScope",
        "proto": "Function.prototype"
      },
      "DedicatedWorkerGlobalScope.prototype": {
        "immutablePrototype": true,
        "kind": "prototype",
        "owner": "DedicatedWorkerGlobalScope",
        "proto": "Object.prototype"
      }
    },
    "service-worker": {
      "ServiceWorkerGlobalScope": {
        "immutablePrototype": true,
        "kind": "global",
        "owner": "ServiceWorkerGlobalScope",
        "proto": "ServiceWorkerGlobalScope.prototype"
      },
      "ServiceWorkerGlobalScope.ServiceWorkerGlobalScope": {
        "kind": "constructor",
        "owner": "ServiceWorkerGlobalScope",
        "proto": "Function.prototype"
      },
      "ServiceWorkerGlobalScope.prototype": {
        "immutablePrototype": true,
        "kind": "prototype",
        "owner": "ServiceWorkerGlobalScope",
        "proto": "Object.prototype"
      }
    },
    "shared-worker": {
      "SharedWorkerGlobalScope": {
        "immutablePrototype": true,
        "kind": "global",
        "owner": "SharedWorkerGlobalScope",
        "proto": "SharedWorkerGlobalScope.prototype"
      },
      "SharedWorkerGlobalScope.SharedWorkerGlobalScope": {
        "kind": "constructor",
        "owner": "SharedWorkerGlobalScope",
        "proto": "Function.prototype"
      },
      "SharedWorkerGlobalScope.prototype": {
        "immutablePrototype": true,
        "kind": "prototype",
        "owner": "SharedWorkerGlobalScope",
        "proto": "Object.prototype"
      }
    },
    "window": {
      "Node": {
        "kind": "constructor",
        "owner": "Node",
        "proto": "Function.prototype"
      },
      "Node.prototype": {
        "kind": "prototype",
        "owner": "Node",
        "proto": "Object.prototype"
      },
      "Window": {
        "immutablePrototype": true,
        "kind": "global",
        "owner": "Window",
        "proto": "Window.prototype"
      },
      "Window.Window": {
        "kind": "constructor",
        "owner": "Window",
        "proto": "Function.prototype"
      },
      "Window.prototype": {
        "immutablePrototype": true,
        "kind": "prototype",
        "owner": "Window",
        "proto": "Object.prototype"
      }
    }
  },
  "instanceMembers": {
    "dedicated-worker": {},
    "service-worker": {},
    "shared-worker": {},
    "window": {}
  },
  "instances": {
    "dedicated-worker": {},
    "service-worker": {},
    "shared-worker": {},
    "window": {}
  },
  "metadata": {
    "overlays": {},
    "upstream": {
      "@webref/idl": "1.0.0",
      "webidl2": "24.5.0"
    }
  },
  "proseMembers": {},
  "protectedSurface": {},
  "remoteUrlNormalization": {
    "drop": [],
    "host": "lowercase",
    "path": [],
    "scheme": {
      "from": [],
      "to": "https:"
    }
  },
  "retained": {
    "dropped": {
      "dedicated-worker": {},
      "service-worker": {},
      "shared-worker": {},
      "window": {}
    },
    "droppedHolders": {
      "dedicated-worker": {},
      "service-worker": {},
      "shared-worker": {},
      "window": {}
    },
    "holders": {
      "dedicated-worker": {},
      "service-worker": {},
      "shared-worker": {},
      "window": {}
    },
    "targets": {
      "dedicated-worker": {},
      "service-worker": {},
      "shared-worker": {},
      "window": {}
    }
  },
  "singletons": {
    "dedicated-worker": {},
    "service-worker": {},
    "shared-worker": {},
    "window": {}
  },
  "surfaceMap": {
    "members": {},
    "owners": {}
  },
  "targets": {
    "dedicated-worker": {
      "DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": true
        },
        "holder": "global",
        "holds": "DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope",
        "kind": "interface",
        "member": "DedicatedWorkerGlobalScope",
        "owner": "DedicatedWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      },
      "DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope.prototype": {
        "descriptor": {
          "configurable": false,
          "enumerable": false,
          "type": "data",
          "writable": false
        },
        "holder": "constructor",
        "holds": "DedicatedWorkerGlobalScope.prototype",
        "kind": "value",
        "member": "prototype",
        "owner": "DedicatedWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      },
      "DedicatedWorkerGlobalScope.prototype.@@toStringTag": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": false
        },
        "holder": "prototype",
        "kind": "value",
        "member": "@@toStringTag",
        "owner": "DedicatedWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      },
      "DedicatedWorkerGlobalScope.prototype.constructor": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": true
        },
        "holder": "prototype",
        "holds": "DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope",
        "kind": "function",
        "member": "constructor",
        "owner": "DedicatedWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      }
    },
    "service-worker": {
      "ServiceWorkerGlobalScope.ServiceWorkerGlobalScope": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": true
        },
        "holder": "global",
        "holds": "ServiceWorkerGlobalScope.ServiceWorkerGlobalScope",
        "kind": "interface",
        "member": "ServiceWorkerGlobalScope",
        "owner": "ServiceWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      },
      "ServiceWorkerGlobalScope.ServiceWorkerGlobalScope.prototype": {
        "descriptor": {
          "configurable": false,
          "enumerable": false,
          "type": "data",
          "writable": false
        },
        "holder": "constructor",
        "holds": "ServiceWorkerGlobalScope.prototype",
        "kind": "value",
        "member": "prototype",
        "owner": "ServiceWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      },
      "ServiceWorkerGlobalScope.prototype.@@toStringTag": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": false
        },
        "holder": "prototype",
        "kind": "value",
        "member": "@@toStringTag",
        "owner": "ServiceWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      },
      "ServiceWorkerGlobalScope.prototype.constructor": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": true
        },
        "holder": "prototype",
        "holds": "ServiceWorkerGlobalScope.ServiceWorkerGlobalScope",
        "kind": "function",
        "member": "constructor",
        "owner": "ServiceWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      }
    },
    "shared-worker": {
      "SharedWorkerGlobalScope.SharedWorkerGlobalScope": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": true
        },
        "holder": "global",
        "holds": "SharedWorkerGlobalScope.SharedWorkerGlobalScope",
        "kind": "interface",
        "member": "SharedWorkerGlobalScope",
        "owner": "SharedWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      },
      "SharedWorkerGlobalScope.SharedWorkerGlobalScope.prototype": {
        "descriptor": {
          "configurable": false,
          "enumerable": false,
          "type": "data",
          "writable": false
        },
        "holder": "constructor",
        "holds": "SharedWorkerGlobalScope.prototype",
        "kind": "value",
        "member": "prototype",
        "owner": "SharedWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      },
      "SharedWorkerGlobalScope.prototype.@@toStringTag": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": false
        },
        "holder": "prototype",
        "kind": "value",
        "member": "@@toStringTag",
        "owner": "SharedWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      },
      "SharedWorkerGlobalScope.prototype.constructor": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": true
        },
        "holder": "prototype",
        "holds": "SharedWorkerGlobalScope.SharedWorkerGlobalScope",
        "kind": "function",
        "member": "constructor",
        "owner": "SharedWorkerGlobalScope",
        "spec": "globals",
        "surface": "other"
      }
    },
    "window": {
      "Node.ELEMENT_NODE": {
        "descriptor": {
          "configurable": false,
          "enumerable": true,
          "type": "data",
          "writable": false
        },
        "holder": "constructor",
        "kind": "constant",
        "member": "ELEMENT_NODE",
        "owner": "Node",
        "spec": "dom",
        "surface": "other"
      },
      "Node.prototype": {
        "descriptor": {
          "configurable": false,
          "enumerable": false,
          "type": "data",
          "writable": false
        },
        "holder": "constructor",
        "holds": "Node.prototype",
        "kind": "value",
        "member": "prototype",
        "owner": "Node",
        "spec": "dom",
        "surface": "other"
      },
      "Node.prototype.@@toStringTag": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": false
        },
        "holder": "prototype",
        "kind": "value",
        "member": "@@toStringTag",
        "owner": "Node",
        "spec": "dom",
        "surface": "other"
      },
      "Node.prototype.ELEMENT_NODE": {
        "descriptor": {
          "configurable": false,
          "enumerable": true,
          "type": "data",
          "writable": false
        },
        "holder": "prototype",
        "kind": "constant",
        "member": "ELEMENT_NODE",
        "owner": "Node",
        "spec": "dom",
        "surface": "other"
      },
      "Node.prototype.appendChild": {
        "descriptor": {
          "configurable": true,
          "enumerable": true,
          "type": "data",
          "writable": true
        },
        "holder": "prototype",
        "kind": "operation",
        "member": "appendChild",
        "owner": "Node",
        "spec": "dom",
        "surface": "other"
      },
      "Node.prototype.assignedSlot": {
        "assign": "readonly",
        "descriptor": {
          "configurable": true,
          "enumerable": true,
          "setter": false,
          "type": "accessor"
        },
        "holder": "prototype",
        "kind": "attribute",
        "member": "assignedSlot",
        "mixin": "Slottable",
        "owner": "Node",
        "spec": "shadow",
        "surface": "other"
      },
      "Node.prototype.constructor": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": true
        },
        "holder": "prototype",
        "holds": "Node",
        "kind": "function",
        "member": "constructor",
        "owner": "Node",
        "spec": "dom",
        "surface": "other"
      },
      "Window.Node": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": true
        },
        "holder": "global",
        "holds": "Node",
        "kind": "interface",
        "member": "Node",
        "owner": "Window",
        "spec": "dom",
        "surface": "other"
      },
      "Window.Window": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": true
        },
        "holder": "global",
        "holds": "Window.Window",
        "kind": "interface",
        "member": "Window",
        "owner": "Window",
        "spec": "globals",
        "surface": "other"
      },
      "Window.Window.prototype": {
        "descriptor": {
          "configurable": false,
          "enumerable": false,
          "type": "data",
          "writable": false
        },
        "holder": "constructor",
        "holds": "Window.prototype",
        "kind": "value",
        "member": "prototype",
        "owner": "Window",
        "spec": "globals",
        "surface": "other"
      },
      "Window.prototype.@@toStringTag": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": false
        },
        "holder": "prototype",
        "kind": "value",
        "member": "@@toStringTag",
        "owner": "Window",
        "spec": "globals",
        "surface": "other"
      },
      "Window.prototype.constructor": {
        "descriptor": {
          "configurable": true,
          "enumerable": false,
          "type": "data",
          "writable": true
        },
        "holder": "prototype",
        "holds": "Window.Window",
        "kind": "function",
        "member": "constructor",
        "owner": "Window",
        "spec": "globals",
        "surface": "other"
      }
    }
  }
}
`)
  })
})

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

describe('catalog version', () => {
  test('the metadata records the catalog version, the upstream packages and a pin of each overlay', () => {
    const overlays = { 'singletons.json': 'a'.repeat(64), 'exclusions.json': 'b'.repeat(64) }
    const { catalog } = generate({ idl: { globals }, upstream, catalogVersion: 3, overlays })

    expect(JSON.parse(catalog).metadata).toEqual({
      catalogVersion: 3,
      upstream: { '@webref/idl': '1.0.0', webidl2: '24.5.0' },
      overlays: { 'exclusions.json': 'b'.repeat(64), 'singletons.json': 'a'.repeat(64) },
    })
    expect(catalog.indexOf('"catalogVersion"')).toBeLessThan(catalog.indexOf('"overlays"'))
  })
})

const header =
  'Generated by `npm run catalog`. Do not edit. It lists the targets added, removed and newly retained by the last ' +
  'catalog change, the holders it added, removed or newly retained, the targets whose descriptor, assign kind, ' +
  'surface or protection it changed, the owners it added, with the surfaces of their members: an owner nobody has ' +
  'reviewed shows as other, and the framework path rules and escape-only shapes it added, removed or changed. A line marked [sign-off] changes a protected target, retains a target or holder, or ' +
  'removes one through an exclusion, and CI fails until `catalog/sign-off.json` records who signed it off.'

describe('target diff', () => {
  const before = `
    [Exposed=Window]
    interface Navigator {
      readonly attribute DOMString userAgent;
      Promise<undefined> joinAdInterestGroup(AuctionAdInterestGroup group);
    };
    [Exposed=Window]
    interface Performance {
      DOMHighResTimeStamp now();
    };`
  const after = `
    [Exposed=Window]
    interface Navigator {
      readonly attribute DOMString userAgent;
      readonly attribute boolean webdriver;
    };
    [Exposed=(Window,Worker)]
    interface Performance {
      DOMHighResTimeStamp now();
    };
    [Exposed=Window]
    interface Geolocation {
      undefined clearWatch(long watchId);
    };`

  /** Upstream drops `joinAdInterestGroup`, which BCD shows no engine ships in this fixture. */
  const drop = { bcd: 'api.Navigator.joinAdInterestGroup', evidence: 'BCD 9.0.0 lists no engine that ships it.' }
  const dropped = { targets: {}, holders: {}, dropped: { window: { 'Navigator.prototype.joinAdInterestGroup': drop } } }

  test('lists every target, with its realm and holder kind, as added when there is no previous catalog', () => {
    const { catalog, targetDiff } = generate({ idl: { globals, html: before }, upstream })

    expect(targetDiff).toBe(`# Catalog target diff

${header}

- From: no previous catalog
- To: \`@webref/idl\` 1.0.0, \`webidl2\` 24.5.0 (catalog sha256 \`${sha256(catalog)}\`)

## Added (27)

- \`DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope\` (dedicated-worker, global)
- \`DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope.prototype\` (dedicated-worker, constructor)
- \`DedicatedWorkerGlobalScope.prototype.@@toStringTag\` (dedicated-worker, prototype)
- \`DedicatedWorkerGlobalScope.prototype.constructor\` (dedicated-worker, prototype)
- \`Navigator.prototype\` (window, constructor)
- \`Navigator.prototype.@@toStringTag\` (window, prototype)
- \`Navigator.prototype.constructor\` (window, prototype)
- \`Navigator.prototype.joinAdInterestGroup\` (window, prototype)
- \`Navigator.prototype.userAgent\` (window, prototype)
- \`Performance.prototype\` (window, constructor)
- \`Performance.prototype.@@toStringTag\` (window, prototype)
- \`Performance.prototype.constructor\` (window, prototype)
- \`Performance.prototype.now\` (window, prototype)
- \`ServiceWorkerGlobalScope.ServiceWorkerGlobalScope\` (service-worker, global)
- \`ServiceWorkerGlobalScope.ServiceWorkerGlobalScope.prototype\` (service-worker, constructor)
- \`ServiceWorkerGlobalScope.prototype.@@toStringTag\` (service-worker, prototype)
- \`ServiceWorkerGlobalScope.prototype.constructor\` (service-worker, prototype)
- \`SharedWorkerGlobalScope.SharedWorkerGlobalScope\` (shared-worker, global)
- \`SharedWorkerGlobalScope.SharedWorkerGlobalScope.prototype\` (shared-worker, constructor)
- \`SharedWorkerGlobalScope.prototype.@@toStringTag\` (shared-worker, prototype)
- \`SharedWorkerGlobalScope.prototype.constructor\` (shared-worker, prototype)
- \`Window.Navigator\` (window, global)
- \`Window.Performance\` (window, global)
- \`Window.Window\` (window, global)
- \`Window.Window.prototype\` (window, constructor)
- \`Window.prototype.@@toStringTag\` (window, prototype)
- \`Window.prototype.constructor\` (window, prototype)

## Removed (0)

## Added holders (16)

- \`DedicatedWorkerGlobalScope\` (dedicated-worker, global holder)
- \`DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope\` (dedicated-worker, constructor holder)
- \`DedicatedWorkerGlobalScope.prototype\` (dedicated-worker, prototype holder)
- \`Navigator\` (window, constructor holder)
- \`Navigator.prototype\` (window, prototype holder)
- \`Performance\` (window, constructor holder)
- \`Performance.prototype\` (window, prototype holder)
- \`ServiceWorkerGlobalScope\` (service-worker, global holder)
- \`ServiceWorkerGlobalScope.ServiceWorkerGlobalScope\` (service-worker, constructor holder)
- \`ServiceWorkerGlobalScope.prototype\` (service-worker, prototype holder)
- \`SharedWorkerGlobalScope\` (shared-worker, global holder)
- \`SharedWorkerGlobalScope.SharedWorkerGlobalScope\` (shared-worker, constructor holder)
- \`SharedWorkerGlobalScope.prototype\` (shared-worker, prototype holder)
- \`Window\` (window, global holder)
- \`Window.Window\` (window, constructor holder)
- \`Window.prototype\` (window, prototype holder)

## Removed holders (0)

## Retained (0)

## Changed (0)

## New owners (6)

- \`DedicatedWorkerGlobalScope\`: other
- \`Navigator\`: other
- \`Performance\`: other
- \`ServiceWorkerGlobalScope\`: other
- \`SharedWorkerGlobalScope\`: other
- \`Window\`: other

## Framework path rules (0)

## Escape-only shapes (0)
`)
  })

  test('lists the targets added and removed since the previous catalog, one per realm, with holder kinds', () => {
    const previous = generate({ idl: { globals, html: before }, upstream })
    const bumped = { '@webref/idl': '1.1.0', webidl2: '24.5.0' }
    const { catalog, targetDiff } = generate({ idl: { globals, html: after }, upstream: bumped, retained: dropped, previous })

    expect(targetDiff).toBe(`# Catalog target diff

${header}

- From: \`@webref/idl\` 1.0.0, \`webidl2\` 24.5.0 (catalog sha256 \`${sha256(previous.catalog)}\`)
- To: \`@webref/idl\` 1.1.0, \`webidl2\` 24.5.0 (catalog sha256 \`${sha256(catalog)}\`)

## Added (21)

- \`DedicatedWorkerGlobalScope.Performance\` (dedicated-worker, global)
- \`Geolocation.prototype\` (window, constructor)
- \`Geolocation.prototype.@@toStringTag\` (window, prototype)
- \`Geolocation.prototype.clearWatch\` (window, prototype)
- \`Geolocation.prototype.constructor\` (window, prototype)
- \`Navigator.prototype.webdriver\` (window, prototype)
- \`Performance.prototype\` (dedicated-worker, constructor)
- \`Performance.prototype\` (shared-worker, constructor)
- \`Performance.prototype\` (service-worker, constructor)
- \`Performance.prototype.@@toStringTag\` (dedicated-worker, prototype)
- \`Performance.prototype.@@toStringTag\` (shared-worker, prototype)
- \`Performance.prototype.@@toStringTag\` (service-worker, prototype)
- \`Performance.prototype.constructor\` (dedicated-worker, prototype)
- \`Performance.prototype.constructor\` (shared-worker, prototype)
- \`Performance.prototype.constructor\` (service-worker, prototype)
- \`Performance.prototype.now\` (dedicated-worker, prototype)
- \`Performance.prototype.now\` (shared-worker, prototype)
- \`Performance.prototype.now\` (service-worker, prototype)
- \`ServiceWorkerGlobalScope.Performance\` (service-worker, global)
- \`SharedWorkerGlobalScope.Performance\` (shared-worker, global)
- \`Window.Geolocation\` (window, global)

## Removed (1)

- \`Navigator.prototype.joinAdInterestGroup\` (window, prototype): dropped: api.Navigator.joinAdInterestGroup: BCD 9.0.0 lists no engine that ships it.

## Added holders (8)

- \`Geolocation\` (window, constructor holder)
- \`Geolocation.prototype\` (window, prototype holder)
- \`Performance\` (dedicated-worker, constructor holder)
- \`Performance\` (shared-worker, constructor holder)
- \`Performance\` (service-worker, constructor holder)
- \`Performance.prototype\` (dedicated-worker, prototype holder)
- \`Performance.prototype\` (shared-worker, prototype holder)
- \`Performance.prototype\` (service-worker, prototype holder)

## Removed holders (0)

## Retained (0)

## Changed (0)

## New owners (1)

- \`Geolocation\`: other

## Framework path rules (0)

## Escape-only shapes (0)
`)
  })

  test('shows a target whose holder kind changes as removed under the old kind and added under the new', () => {
    const previous = generate({ idl: { globals, spec: '[Exposed=Window] interface Foo { static undefined bar(); };' }, upstream })
    // A namespace has no prototype object, so the change loses `Foo.prototype`, which the bump drops.
    const drop = { bcd: 'api.Foo.prototype', evidence: 'BCD 9.0.0 has no such feature: a namespace has no prototype.' }
    const { targetDiff } = generate({
      idl: { globals, spec: '[Exposed=Window] namespace Foo { undefined bar(); };' },
      upstream,
      retained: {
        targets: {},
        holders: {},
        // So are the interface's structural properties, which a namespace doesn't have.
        dropped: { window: Object.fromEntries(['Foo.prototype', 'Foo.prototype.@@toStringTag', 'Foo.prototype.constructor'].map((name) => [name, drop])) },
        droppedHolders: { window: { 'Foo.prototype': drop } },
      },
      previous,
    })

    expect(targetDiff).toContain('## Added (2)\n\n- `Foo.@@toStringTag` (window, namespace)\n- `Foo.bar` (window, namespace)\n')
    expect(targetDiff).toContain('## Removed (4)\n\n- `Foo.bar` (window, constructor)\n')
  })

  test('lists the targets whose descriptor or assign kind changed, with the old and new member data', () => {
    const previous = generate({
      idl: {
        globals,
        html: `
          partial interface Window { readonly attribute unsigned long length; undefined stop(); };
          [Exposed=Window] interface Document { attribute DOMString title; };`,
      },
      upstream,
    })
    const { targetDiff } = generate({
      idl: {
        globals,
        html: `
          partial interface Window {
            [Replaceable] readonly attribute unsigned long length;
            [LegacyUnforgeable] undefined stop();
          };
          [Exposed=Window] interface Document { attribute DOMString title; };`,
      },
      upstream,
      previous,
    })

    expect(targetDiff).toContain('## Added (0)\n\n## Removed (0)\n\n## Added holders (0)\n\n## Removed holders (0)\n\n## Retained (0)\n\n## Changed (2)\n\n')
    expect(targetDiff).toContain(
      '\n- `Window.length` (window, global): descriptor accessor without setter (enumerable, configurable) → accessor with setter (enumerable, configurable); assign readonly → replaceable\n',
    )
    expect(targetDiff).toContain(
      '\n- `Window.stop` (window, global): descriptor data (writable, enumerable, configurable) → data (non-writable, enumerable, non-configurable)\n',
    )
  })

  test('shows member data a target gains or loses as none on the other side', () => {
    const idl = { globals, html: 'partial interface Window { attribute DOMString name; };' }
    const catalog = JSON.parse(generate({ idl, upstream }).catalog)
    delete catalog.targets.window['Window.name'].descriptor
    delete catalog.targets.window['Window.name'].assign
    const withoutData = canonicalJson(catalog)
    const withData = generate({ idl, upstream, previous: { catalog: withoutData, targetDiff: '' } })

    expect(withData.targetDiff).toContain(
      '\n- `Window.name` (window, global): descriptor none → accessor with setter (enumerable, configurable); assign none → setter\n',
    )
    expect(diffCatalogs(withData.catalog, withoutData)).toContain(
      '\n- `Window.name` (window, global): descriptor accessor with setter (enumerable, configurable) → none; assign setter → none\n',
    )
  })

  test('compares a previous catalog from before realms by name alone, so its targets are removed without a realm', () => {
    const realmFree = `{
  "metadata": {
    "upstream": {
      "@webref/idl": "1.0.0",
      "webidl2": "24.5.0"
    }
  },
  "targets": {
    "Navigator.prototype.userAgent": {
      "holder": "prototype",
      "kind": "attribute",
      "member": "userAgent",
      "owner": "Navigator",
      "spec": "html"
    }
  }
}
`
    const previous = { catalog: realmFree, targetDiff: '' }
    const { catalog, targetDiff } = generate({ idl: { globals, html: before }, upstream, previous })

    expect(targetDiff).toBe(`# Catalog target diff

${header}

- From: \`@webref/idl\` 1.0.0, \`webidl2\` 24.5.0 (catalog sha256 \`${sha256(realmFree)}\`), whose targets have no realm
- To: \`@webref/idl\` 1.0.0, \`webidl2\` 24.5.0 (catalog sha256 \`${sha256(catalog)}\`)

## Added (27)

- \`DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope\` (dedicated-worker, global)
- \`DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope.prototype\` (dedicated-worker, constructor)
- \`DedicatedWorkerGlobalScope.prototype.@@toStringTag\` (dedicated-worker, prototype)
- \`DedicatedWorkerGlobalScope.prototype.constructor\` (dedicated-worker, prototype)
- \`Navigator.prototype\` (window, constructor)
- \`Navigator.prototype.@@toStringTag\` (window, prototype)
- \`Navigator.prototype.constructor\` (window, prototype)
- \`Navigator.prototype.joinAdInterestGroup\` (window, prototype)
- \`Navigator.prototype.userAgent\` (window, prototype)
- \`Performance.prototype\` (window, constructor)
- \`Performance.prototype.@@toStringTag\` (window, prototype)
- \`Performance.prototype.constructor\` (window, prototype)
- \`Performance.prototype.now\` (window, prototype)
- \`ServiceWorkerGlobalScope.ServiceWorkerGlobalScope\` (service-worker, global)
- \`ServiceWorkerGlobalScope.ServiceWorkerGlobalScope.prototype\` (service-worker, constructor)
- \`ServiceWorkerGlobalScope.prototype.@@toStringTag\` (service-worker, prototype)
- \`ServiceWorkerGlobalScope.prototype.constructor\` (service-worker, prototype)
- \`SharedWorkerGlobalScope.SharedWorkerGlobalScope\` (shared-worker, global)
- \`SharedWorkerGlobalScope.SharedWorkerGlobalScope.prototype\` (shared-worker, constructor)
- \`SharedWorkerGlobalScope.prototype.@@toStringTag\` (shared-worker, prototype)
- \`SharedWorkerGlobalScope.prototype.constructor\` (shared-worker, prototype)
- \`Window.Navigator\` (window, global)
- \`Window.Performance\` (window, global)
- \`Window.Window\` (window, global)
- \`Window.Window.prototype\` (window, constructor)
- \`Window.prototype.@@toStringTag\` (window, prototype)
- \`Window.prototype.constructor\` (window, prototype)

## Removed (1)

- \`Navigator.prototype.userAgent\` (prototype)

## Added holders (16)

- \`DedicatedWorkerGlobalScope\` (dedicated-worker, global holder)
- \`DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope\` (dedicated-worker, constructor holder)
- \`DedicatedWorkerGlobalScope.prototype\` (dedicated-worker, prototype holder)
- \`Navigator\` (window, constructor holder)
- \`Navigator.prototype\` (window, prototype holder)
- \`Performance\` (window, constructor holder)
- \`Performance.prototype\` (window, prototype holder)
- \`ServiceWorkerGlobalScope\` (service-worker, global holder)
- \`ServiceWorkerGlobalScope.ServiceWorkerGlobalScope\` (service-worker, constructor holder)
- \`ServiceWorkerGlobalScope.prototype\` (service-worker, prototype holder)
- \`SharedWorkerGlobalScope\` (shared-worker, global holder)
- \`SharedWorkerGlobalScope.SharedWorkerGlobalScope\` (shared-worker, constructor holder)
- \`SharedWorkerGlobalScope.prototype\` (shared-worker, prototype holder)
- \`Window\` (window, global holder)
- \`Window.Window\` (window, constructor holder)
- \`Window.prototype\` (window, prototype holder)

## Removed holders (0)

## Retained (0)

## Changed (0)

## New owners (5)

- \`DedicatedWorkerGlobalScope\`: other
- \`Performance\`: other
- \`ServiceWorkerGlobalScope\`: other
- \`SharedWorkerGlobalScope\`: other
- \`Window\`: other

## Framework path rules (0)

## Escape-only shapes (0)
`)
  })

  test('lists the targets whose surface changed, with the old and new surface', () => {
    const idl = { globals, html: before }
    const previous = generate({ idl, upstream, surfaces: { owners: { Navigator: 'DOM' }, members: {} } })
    const surfaces = { owners: { Navigator: 'DOM' }, members: { Navigator: { userAgent: 'diagnostics' } } } as const
    const { targetDiff } = generate({ idl, upstream, surfaces, previous })

    expect(targetDiff).toContain('## Changed (1)\n\n- `Navigator.prototype.userAgent` (window, prototype): surface DOM → diagnostics\n')
  })

  test('lists each owner the change adds, with the surfaces of its members: one nobody has reviewed is other', () => {
    const previous = generate({ idl: { globals, html: before }, upstream })
    const surfaces = { owners: { Navigator: 'DOM', Performance: 'diagnostics' }, members: {} } as const
    const { targetDiff } = generate({ idl: { globals, html: after }, upstream, surfaces, retained: dropped, previous })

    expect(targetDiff).toContain('\n## New owners (1)\n\n- `Geolocation`: other\n')
  })

  test('lists a new interface with no members of its own as an owner, through the property that holds it', () => {
    const previous = generate({ idl: { globals, html: before }, upstream })
    const html = `${before}\n    [Exposed=Window] interface Comment {};`
    const { targetDiff } = generate({ idl: { globals, html }, upstream, previous })

    expect(targetDiff).toContain('\n## New owners (1)\n\n- `Comment`: other\n')
  })

  test('keeps the previous diff when the catalog is unchanged, so a second run writes the same bytes', () => {
    const first = generate({ idl: { globals, html: before }, upstream })
    const bumped = generate({ idl: { globals, html: after }, upstream, retained: dropped, previous: first })
    const rerun = generate({ idl: { globals, html: after }, upstream, retained: dropped, previous: bumped })

    expect(rerun).toEqual(bumped)
  })

  test('lists the framework path rules and escape-only shapes added, removed or changed (§4 Catalog versions)', () => {
    const next = { source: 'observed', namespace: 'webpack:_N_E', up: 2, segments: ['src', 'client'], package: 'next' }
    const angular = { source: 'observed', segments: ['<platform>-fastbuild-ST-*', 'bin', 'packages', '<pkg>'], package: '@angular/<pkg>' }
    const shared = { source: 'observed', namespace: 'webpack:_N_E', up: 2, segments: ['src', 'shared'] }
    const lib = { source: 'observed', namespace: 'webpack:_N_E', up: 2, segments: ['src', 'lib'] }
    const ng = { source: 'observed', up: 2, segments: ['packages', '<pkg>'], captures: { pkg: ['core', 'common'] } }
    const idl = { globals, html: before }
    const previous = generate({ idl, upstream, frameworkPathRules: { next }, escapeOnlyShapes: { shared } })
    const { targetDiff } = generate({
      idl,
      upstream,
      frameworkPathRules: { next: { ...next, up: 3 }, angular },
      escapeOnlyShapes: { lib, ng },
      previous,
    })

    expect(targetDiff).toContain(
      '\n## Framework path rules (2)\n\n' +
        '- `angular` added: anywhere, `<platform>-fastbuild-ST-*/bin/packages/<pkg>/` → `@angular/<pkg>`\n' +
        '- `next` changed: in `webpack:_N_E`, 2 or more leading `../`, then `src/client/` → `next`; now in ' +
        '`webpack:_N_E`, 3 or more leading `../`, then `src/client/` → `next`\n',
    )
    expect(targetDiff).toContain(
      '\n## Escape-only shapes (3)\n\n' +
        '- `lib` added: in `webpack:_N_E`, 2 or more leading `../`, then `src/lib/`\n' +
        '- `ng` added: 2 or more leading `../`, then `packages/<pkg>/`, where `<pkg>` is one of `core`, `common`\n' +
        '- `shared` removed: in `webpack:_N_E`, 2 or more leading `../`, then `src/shared/`\n',
    )
    const unchanged = generate({ idl: { globals, html: after }, upstream, frameworkPathRules: { next }, escapeOnlyShapes: { shared }, retained: dropped, previous })
    expect(unchanged.targetDiff).toContain('\n## Framework path rules (0)\n\n## Escape-only shapes (0)\n')
  })

  test('names the catalog version of each side on the From and To lines', () => {
    const previous = generate({ idl: { globals, html: before }, upstream, catalogVersion: 1 })
    const html = `${before}\n    [Exposed=Window] interface Comment {};`
    const { targetDiff } = generate({ idl: { globals, html }, upstream, catalogVersion: 2, previous })

    expect(targetDiff).toContain('\n- From: catalog version 1, `@webref/idl` 1.0.0, `webidl2` 24.5.0 (catalog sha256 `')
    expect(targetDiff).toContain('\n- To: catalog version 2, `@webref/idl` 1.0.0, `webidl2` 24.5.0 (catalog sha256 `')
  })

  test('lists each newly retained target with the last upstream version that had it and why, marked for sign-off', () => {
    const previous = generate({ idl: { globals, html: before }, upstream })
    const target = JSON.parse(previous.catalog).targets.window['Navigator.prototype.joinAdInterestGroup']
    delete target.surface
    const reason = 'Its spec was discontinued, but Chrome still ships it.'
    const bumped = { '@webref/idl': '1.1.0', webidl2: '24.5.0' }
    const retained = {
      targets: { window: { 'Navigator.prototype.joinAdInterestGroup': { lastUpstream: '@webref/idl 1.0.0', reason, target } } },
      holders: {},
      dropped: {},
    }
    const bump = generate({ idl: { globals, html: after }, upstream: bumped, retained, previous })
    const later = generate({
      idl: { globals, html: `${after}\n    [Exposed=Window] interface Comment {};` },
      upstream: bumped,
      retained,
      previous: bump,
    })

    expect(bump.targetDiff).toContain(
      '\n## Removed holders (0)\n\n## Retained (1)\n\n' +
        '- `Navigator.prototype.joinAdInterestGroup` (window, prototype) [sign-off: retained]: last in @webref/idl ' +
        `1.0.0; ${reason}\n\n## Changed (0)\n`,
    )
    expect(later.targetDiff).toContain('\n## Retained (0)\n')
  })

  test('marks each line that touches a protected target for sign-off, and lists a change of protection', () => {
    const history = '[Exposed=Window] interface History { undefined back(); undefined go(); };'
    const surfaces = { owners: { History: 'navigation' }, members: {} } as const
    const previous = generate({
      idl: { globals, html: history },
      upstream,
      surfaces,
      protectedSurface: { navigation: [{ interface: 'History', member: 'back' }] },
    })
    const { targetDiff } = generate({
      idl: {
        globals,
        html: `${history}\n    partial interface History { undefined forward(); };\n    [Exposed=Window] interface Comment {};`,
      },
      upstream,
      surfaces,
      protectedSurface: { navigation: [{ interface: 'History' }] },
      previous,
    })

    expect(targetDiff).toContain(
      '\n## Added (5)\n\n' +
        '- `Comment.prototype` (window, constructor)\n' +
        '- `Comment.prototype.@@toStringTag` (window, prototype)\n' +
        '- `Comment.prototype.constructor` (window, prototype)\n' +
        '- `History.prototype.forward` (window, prototype) [sign-off: protected]\n' +
        '- `Window.Comment` (window, global)\n\n',
    )
    expect(targetDiff).toContain(
      '\n## Changed (5)\n\n' +
        '- `History.prototype` (window, constructor) [sign-off: protected]: protected no → yes\n' +
        '- `History.prototype.@@toStringTag` (window, prototype) [sign-off: protected]: protected no → yes\n' +
        '- `History.prototype.constructor` (window, prototype) [sign-off: protected]: protected no → yes\n' +
        '- `History.prototype.go` (window, prototype) [sign-off: protected]: protected no → yes\n' +
        '- `Window.History` (window, global) [sign-off: protected]: protected no → yes\n',
    )
  })

  test('shows why a removed target left: dropped with its BCD evidence, or excluded with the reason', () => {
    const surfaces = { owners: { Navigator: 'networking' }, members: {} } as const
    const previous = generate({
      idl: { globals, html: before },
      upstream,
      surfaces,
      protectedSurface: { networking: [{ interface: 'Navigator', member: 'joinAdInterestGroup' }] },
    })
    const withDrop = generate({ idl: { globals, html: after }, upstream, surfaces, retained: dropped, previous })
    const withExclusion = generate({
      idl: { globals, html: before },
      upstream,
      exclusions: { Navigator: 'Test-only.' },
      previous,
    })

    expect(withDrop.targetDiff).toContain(
      '\n## Removed (1)\n\n- `Navigator.prototype.joinAdInterestGroup` (window, prototype) [sign-off: protected]: ' +
        'dropped: api.Navigator.joinAdInterestGroup: BCD 9.0.0 lists no engine that ships it.\n',
    )
    expect(withExclusion.targetDiff).toContain(
      '\n- `Navigator.prototype.userAgent` (window, prototype) [sign-off: excluded]: excluded: Test-only.\n',
    )
  })

  test('marks every Removed line an exclusion causes for sign-off, with protected first when both apply', () => {
    const surfaces = { owners: { Navigator: 'networking' }, members: {} } as const
    const previous = generate({
      idl: { globals, html: before },
      upstream,
      surfaces,
      protectedSurface: { networking: [{ interface: 'Navigator', member: 'joinAdInterestGroup' }] },
    })
    const { targetDiff } = generate({ idl: { globals, html: before }, upstream, exclusions: { Navigator: 'Test-only.' }, previous })

    expect(targetDiff).toContain(
      '\n## Removed (6)\n\n' +
        '- `Navigator.prototype` (window, constructor) [sign-off: excluded]: excluded: Test-only.\n' +
        '- `Navigator.prototype.@@toStringTag` (window, prototype) [sign-off: excluded]: excluded: Test-only.\n' +
        '- `Navigator.prototype.constructor` (window, prototype) [sign-off: excluded]: excluded: Test-only.\n' +
        '- `Navigator.prototype.joinAdInterestGroup` (window, prototype) [sign-off: protected, excluded]: excluded: Test-only.\n' +
        '- `Navigator.prototype.userAgent` (window, prototype) [sign-off: excluded]: excluded: Test-only.\n' +
        '- `Window.Navigator` (window, global) [sign-off: excluded]: excluded: Test-only.\n\n',
    )
  })

  describe('holders', () => {
    /**
     * `CDATASection` inherits `Text` and declares no members: only the structural properties Web IDL gives every
     * interface sit on its holders.
     */
    const dom = '[Exposed=Window] interface Text { undefined splitText(); };'
    const cdata = '[Exposed=Window] interface CDATASection : Text {};'
    const previous = generate({ idl: { globals, dom: `${dom}\n${cdata}` }, upstream })
    const drop = { bcd: 'api.CDATASection', evidence: 'BCD 9.0.0 lists no engine that ships it.' }
    const cdataTargets = [
      'CDATASection.prototype',
      'CDATASection.prototype.@@toStringTag',
      'CDATASection.prototype.constructor',
      'Window.CDATASection',
    ]
    const cdataLines = (why: string, mark = '') =>
      [
        `- \`CDATASection.prototype\` (window, constructor)${mark}: ${why}\n`,
        `- \`CDATASection.prototype.@@toStringTag\` (window, prototype)${mark}: ${why}\n`,
        `- \`CDATASection.prototype.constructor\` (window, prototype)${mark}: ${why}\n`,
        `- \`Window.CDATASection\` (window, global)${mark}: ${why}\n`,
      ].join('')

    test('lists the holders added since the previous catalog, with their realm and kind', () => {
      const { targetDiff } = generate({
        idl: { globals, dom: `${dom}\n${cdata}\n[Exposed=(Window,Worker)] namespace Tracing {};` },
        upstream,
        previous,
      })

      expect(targetDiff).toContain(
        '\n## Added holders (4)\n\n' +
          '- `Tracing` (window, namespace holder)\n' +
          '- `Tracing` (dedicated-worker, namespace holder)\n' +
          '- `Tracing` (shared-worker, namespace holder)\n' +
          '- `Tracing` (service-worker, namespace holder)\n\n' +
          '## Removed holders (0)\n',
      )
    })

    test('lists the holders removed since the previous catalog, with their realm and kind, and why each left', () => {
      const retained = {
        targets: {},
        holders: {},
        dropped: { window: Object.fromEntries(cdataTargets.map((name) => [name, drop])) },
        droppedHolders: { window: { CDATASection: drop, 'CDATASection.prototype': drop } },
      }
      const { targetDiff } = generate({ idl: { globals, dom }, upstream, retained, previous })
      const why = 'dropped: api.CDATASection: BCD 9.0.0 lists no engine that ships it.'

      expect(targetDiff).toContain(
        `\n## Removed (4)\n\n${cdataLines(why)}\n` +
          '## Added holders (0)\n\n' +
          '## Removed holders (2)\n\n' +
          `- \`CDATASection\` (window, constructor holder): ${why}\n` +
          `- \`CDATASection.prototype\` (window, prototype holder): ${why}\n\n` +
          '## Retained (0)\n',
      )
    })

    test('lists each newly retained holder with the retained targets, marked for sign-off', () => {
      const had = JSON.parse(previous.catalog)
      const reason = 'Its spec was discontinued, but engines still ship it.'
      const retainedTarget = (name: string) => {
        const target = { ...had.targets.window[name] }
        delete target.surface
        return [name, { lastUpstream: '@webref/idl 1.0.0', reason, target }]
      }
      const holder = (name: string) => ({ lastUpstream: '@webref/idl 1.0.0', reason, holder: had.holders.window[name] })
      const retained = {
        targets: { window: Object.fromEntries(cdataTargets.map(retainedTarget)) },
        holders: { window: { CDATASection: holder('CDATASection'), 'CDATASection.prototype': holder('CDATASection.prototype') } },
        dropped: {},
      }
      const bump = generate({ idl: { globals, dom }, upstream, retained, previous })
      const later = generate({ idl: { globals, dom: `${dom}\n[Exposed=Window] interface Comment {};` }, upstream, retained, previous: bump })
      const why = `last in @webref/idl 1.0.0; ${reason}`

      expect(bump.targetDiff).toContain(
        '\n## Removed holders (0)\n\n## Retained (6)\n\n' +
          `- \`CDATASection\` (window, constructor holder) [sign-off: retained]: ${why}\n` +
          `- \`CDATASection.prototype\` (window, constructor) [sign-off: retained]: ${why}\n` +
          `- \`CDATASection.prototype\` (window, prototype holder) [sign-off: retained]: ${why}\n` +
          cdataLines(why, ' [sign-off: retained]').split('\n').slice(1).join('\n') +
          '\n## Changed (0)\n',
      )
      expect(later.targetDiff).toContain('\n## Retained (0)\n')
    })

    test('marks the holders an exclusion removes for sign-off, like its targets', () => {
      const { targetDiff } = generate({
        idl: { globals, dom: `${dom}\n${cdata}` },
        upstream,
        exclusions: { CDATASection: 'Test-only.' },
        previous,
      })

      expect(targetDiff).toContain(
        `\n## Removed (4)\n\n${cdataLines('excluded: Test-only.', ' [sign-off: excluded]')}\n` +
          '## Added holders (0)\n\n' +
          '## Removed holders (2)\n\n' +
          '- `CDATASection` (window, constructor holder) [sign-off: excluded]: excluded: Test-only.\n' +
          '- `CDATASection.prototype` (window, prototype holder) [sign-off: excluded]: excluded: Test-only.\n\n',
      )
    })

    test('marks a removal an exclusion causes for sign-off even when the overlay also drops it', () => {
      const { targetDiff } = generate({
        idl: { globals, dom: `${dom}\n${cdata}` },
        upstream,
        exclusions: { CDATASection: 'Test-only.' },
        retained: {
          targets: {},
          holders: {},
          dropped: { window: Object.fromEntries(cdataTargets.map((name) => [name, drop])) },
          droppedHolders: { window: { CDATASection: drop, 'CDATASection.prototype': drop } },
        },
        previous,
      })

      expect(targetDiff).toContain(
        `\n## Removed (4)\n\n${cdataLines('excluded: Test-only.', ' [sign-off: excluded]')}\n` +
          '## Added holders (0)\n\n' +
          '## Removed holders (2)\n\n' +
          '- `CDATASection` (window, constructor holder) [sign-off: excluded]: excluded: Test-only.\n' +
          '- `CDATASection.prototype` (window, prototype holder) [sign-off: excluded]: excluded: Test-only.\n\n',
      )
    })
  })
})

describe('drift check', () => {
  const idl = { globals, dom: '[Exposed=Window] interface Node { undefined normalize(); };' }
  const older = generate({ idl: { globals, dom: '[Exposed=Window] interface Node {};' }, upstream })
  const rerun = 'Run `npm run catalog` and commit the result.'

  test('passes when the committed files are a fresh generation, and the diff is the one from the catalog it names', () => {
    expect(check({ idl, upstream, committed: generate({ idl, upstream }), base: undefined })).toEqual([])
    expect(check({ idl, upstream, committed: generate({ idl, upstream, previous: older }), base: older.catalog })).toEqual(
      [],
    )
  })

  test('fails when the committed catalog differs from a fresh generation', () => {
    const fresh = generate({ idl, upstream })
    const edited = { ...fresh, catalog: fresh.catalog.replace('"normalize"', '"normalise"') }

    expect(check({ idl, upstream, committed: edited, base: undefined })).toContain(
      `catalog/catalog.json differs from a fresh generation. ${rerun}`,
    )
  })

  test('fails when the committed target diff is not the diff from the catalog it names to the committed catalog', () => {
    const fresh = generate({ idl, upstream, previous: older })
    const handEdited = fresh.targetDiff.replace('## Added (1)\n\n- `Node.prototype.normalize` (window, prototype)\n', '## Added (0)\n')
    const problem = `catalog/target-diff.md is not the diff from the catalog it names to catalog/catalog.json. ${rerun}`

    expect(handEdited).not.toBe(fresh.targetDiff)
    expect(check({ idl, upstream, committed: { ...fresh, targetDiff: handEdited }, base: older.catalog })).toEqual([problem])
    expect(check({ idl, upstream, committed: { ...fresh, targetDiff: older.targetDiff }, base: undefined })).toEqual([
      problem,
    ])
  })

  test('fails when the committed catalog lost a target the catalog its diff names had', () => {
    const had = generate({ idl, upstream })
    const lost = { globals, dom: '[Exposed=Window] interface Node {};' }
    const [problem] = check({ idl: lost, upstream, committed: older, base: had.catalog })

    expect(problem).toMatch(/^upstream removed 1 target the previous catalog had\. The catalog is monotonic/)
  })

  test('fails when the committed catalog lost a holder the catalog its diff names had, even one no target sits on', () => {
    const dom = '[Exposed=Window] interface Text { undefined splitText(); };'
    const cdata = '[LegacyNoInterfaceObject, Exposed=Window] interface CDATASection : Text {};'
    const had = generate({ idl: { globals, dom: `${dom}\n${cdata}` }, upstream })
    const committed = generate({ idl: { globals, dom }, upstream })
    // Its one target, the @@toStringTag every interface prototype has, is dropped.
    const drop = { bcd: 'api.CDATASection', evidence: 'BCD 9.0.0 lists no engine that ships it.' }
    const retained = { targets: {}, holders: {}, dropped: { window: { 'CDATASection.prototype.@@toStringTag': drop } } }

    expect(JSON.parse(had.catalog).targets.window).not.toHaveProperty(['Window.CDATASection'])
    expect(check({ idl: { globals, dom }, upstream, retained, committed, base: had.catalog })[0]).toMatch(
      /^upstream removed 1 holder the previous catalog had\. The catalog is monotonic.*\n- `CDATASection\.prototype` \(window, prototype holder\)\n/,
    )
  })

  test('fails until each Removed line an exclusion causes is signed off', () => {
    const base = generate({ idl, upstream })
    const sources: Sources = { idl, upstream, exclusions: { Node: 'Test-only.' } }
    const committed = generate({ ...sources, previous: base })
    const marked = [
      '`Node.prototype` (window, constructor) [sign-off: excluded]: excluded: Test-only.',
      '`Node.prototype.@@toStringTag` (window, prototype) [sign-off: excluded]: excluded: Test-only.',
      '`Node.prototype.constructor` (window, prototype) [sign-off: excluded]: excluded: Test-only.',
      '`Node.prototype.normalize` (window, prototype) [sign-off: excluded]: excluded: Test-only.',
      '`Window.Node` (window, global) [sign-off: excluded]: excluded: Test-only.',
      '`Node` (window, constructor holder) [sign-off: excluded]: excluded: Test-only.',
      '`Node.prototype` (window, prototype holder) [sign-off: excluded]: excluded: Test-only.',
    ]
    const [problem] = check({ ...sources, committed, base: base.catalog })

    expect(problem).toBe(
      '7 lines of catalog/target-diff.md need explicit sign-off (§4 Bump review). A reviewer adds each to ' +
        'catalog/sign-off.json with their name:\n' +
        JSON.stringify(Object.fromEntries(marked.map((line) => [line, ''])), null, 2),
    )
    const signOff = Object.fromEntries(marked.map((line) => [line, 'A. Reviewer']))
    expect(check({ ...sources, committed, base: base.catalog, signOff })).toEqual([])
  })

  describe('sign-off', () => {
    const history = '[Exposed=Window] interface History { undefined back(); };'
    const sources: Sources = {
      idl: { globals, html: history },
      upstream,
      surfaces: { owners: { History: 'navigation' }, members: {} },
      protectedSurface: { navigation: [{ interface: 'History' }] },
    }
    const base = generate({ idl: { globals }, upstream })
    const committed = generate({ ...sources, previous: base })
    const marked = [
      '`History.prototype.back` (window, prototype) [sign-off: protected]',
      '`Window.History` (window, global) [sign-off: protected]',
    ]
    // The structural properties Web IDL gives History are protected too, and signed off in every test.
    const structural = {
      '`History.prototype` (window, constructor) [sign-off: protected]': 'A. Reviewer',
      '`History.prototype.@@toStringTag` (window, prototype) [sign-off: protected]': 'A. Reviewer',
      '`History.prototype.constructor` (window, prototype) [sign-off: protected]': 'A. Reviewer',
    }

    test('fails until each line the diff marks has a sign-off, naming who signed it off', () => {
      const [problem] = check({ ...sources, committed, base: base.catalog, signOff: structural })

      expect(problem).toBe(
        '2 lines of catalog/target-diff.md need explicit sign-off (§4 Bump review). A reviewer adds each to ' +
          'catalog/sign-off.json with their name:\n' +
          JSON.stringify(Object.fromEntries(marked.map((line) => [line, ''])), null, 2),
      )
      expect(check({ ...sources, committed, base: base.catalog, signOff: { ...structural, [marked[0]!]: 'A. Reviewer' } })).toEqual([
        '1 line of catalog/target-diff.md needs explicit sign-off (§4 Bump review). A reviewer adds each to ' +
          `catalog/sign-off.json with their name:\n${JSON.stringify({ [marked[1]!]: '' }, null, 2)}`,
      ])
      expect(
        check({ ...sources, committed, base: base.catalog, signOff: { ...structural, [marked[0]!]: 'A. Reviewer', [marked[1]!]: ' ' } }),
      ).toHaveLength(1)
    })

    test('passes once every marked line is signed off', () => {
      const signOff = { ...structural, ...Object.fromEntries(marked.map((line) => [line, 'A. Reviewer'])) }

      expect(check({ ...sources, committed, base: base.catalog, signOff })).toEqual([])
    })

    test('fails on a sign-off for a line the diff does not mark', () => {
      const stale = '`Window.fetch` (window, global) [sign-off: protected]'
      const signOff = { ...structural, ...Object.fromEntries(marked.map((line) => [line, 'A. Reviewer'])), [stale]: 'A. Reviewer' }

      expect(check({ ...sources, committed, base: base.catalog, signOff })).toEqual([
        'catalog/sign-off.json signs off a line catalog/target-diff.md does not mark: `Window.fetch` (window, global) ' +
          '[sign-off: protected]. Remove it; `npm run catalog` removes such lines.',
      ])
    })
  })
})

describe('framework path rules and escape-only shapes overlays (§10)', () => {
  const next = { source: 'observed', namespace: 'webpack:_N_E', up: 2, segments: ['src', 'client'], package: 'next' }

  test('reads well-formed entries, sorted by id', () => {
    const shared = { source: 'observed', up: 2, segments: ['src', 'shared'] }
    expect(Object.keys(frameworkPathRulesOverlay({ z: next, a: next }, 'rules.json'))).toEqual(['a', 'z'])
    expect(escapeOnlyShapesOverlay({ shared }, 'shapes.json')).toEqual({ shared })
  })

  test.each([
    ['a package placeholder its segments do not capture', { ...next, package: '@angular/<pkg>' }, /<pkg>/],
    ['no package', { ...next, package: undefined }, /needs a package/],
    ['no segments', { ...next, segments: [] }, /one or more segments/],
    ['a segment with a slash', { ...next, segments: ['src/client'] }, /segment/],
    ['a `..` segment', { ...next, segments: ['..', 'src'] }, /segment/],
    ['an up of zero', { ...next, up: 0 }, /positive integer/],
    ['an unknown field', { ...next, version: '1.0.0' }, /version/],
    ['captures for a placeholder its segments do not have', { ...next, captures: { pkg: ['core'] } }, /<pkg>/],
    ['captures that list nothing', { ...next, segments: ['src', '<dir>'], package: 'next', captures: { dir: [] } }, /<dir>/],
    ['a capture that is not a whole segment', { ...next, segments: ['src', '<dir>'], captures: { dir: ['a/b'] } }, /<dir>/],
  ])('refuses a rule with %s', (_, rule, message) => {
    expect(() => frameworkPathRulesOverlay({ next: rule }, 'rules.json')).toThrow(message)
  })

  test('refuses an escape-only shape that names a package', () => {
    expect(() => escapeOnlyShapesOverlay({ next }, 'shapes.json')).toThrow(/package/)
  })
})

describe('remote URL normalization rules (§11 Remote URL normalization)', () => {
  const rules = {
    scheme: { from: ['http:'], to: 'https:' },
    host: 'lowercase' as const,
    drop: ['default-port' as const, 'query' as const, 'fragment' as const],
    path: [{ id: 'hex-run', step: 4 as const, pattern: '[0-9a-f]{8,}', replacement: '#' }],
  }

  test('the catalog carries them as a named section, so a change to a rule shows in the catalog diff', () => {
    const { catalog } = generate({ idl: { globals }, upstream, remoteUrlNormalization: rules })
    const changed = { ...rules, path: [{ ...rules.path[0]!, pattern: '[0-9a-f]{10,}' }] }
    const after = generate({ idl: { globals }, upstream, remoteUrlNormalization: changed })

    expect(JSON.parse(catalog).remoteUrlNormalization).toEqual(rules)
    const lines = (text: string) => new Set(text.split('\n'))
    const added = [...lines(after.catalog)].filter((line) => !lines(catalog).has(line))
    expect(added).toEqual(['        "pattern": "[0-9a-f]{10,}",'])
  })

  test('an overlay whose pattern does not compile, or that is malformed, is refused', () => {
    const broken = { ...rules, path: [{ ...rules.path[0]!, pattern: '(' }] }
    expect(() => remoteUrlNormalizationOverlay(broken, 'o.json')).toThrow(/hex-run's pattern doesn't compile/)
    expect(() => remoteUrlNormalizationOverlay({ ...rules, drop: ['path'] }, 'o.json')).toThrow(/drop is malformed/)
    expect(remoteUrlNormalizationOverlay(rules, 'o.json')).toEqual(rules)
  })
})

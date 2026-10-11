import { describe, expect, test } from 'vitest'
import { generate } from '../tools/catalog-generator/generate.ts'

const upstream = { '@webref/idl': '1.0.0', webidl2: '24.5.0' }

/** The global interfaces of the four realms, with the inheritance real IDL gives them. */
const globals = `
  [Exposed=*] interface EventTarget {};
  [Global=Window, Exposed=Window] interface Window : EventTarget { getter object (DOMString name); };
  [Exposed=Worker] interface WorkerGlobalScope : EventTarget {};
  [Global=(Worker,DedicatedWorker), Exposed=DedicatedWorker]
  interface DedicatedWorkerGlobalScope : WorkerGlobalScope {};
  [Global=(Worker,SharedWorker), Exposed=SharedWorker] interface SharedWorkerGlobalScope : WorkerGlobalScope {};
  [Global=(Worker,ServiceWorker), Exposed=ServiceWorker] interface ServiceWorkerGlobalScope : WorkerGlobalScope {};`

/** Each worker realm, with the interface of its global. */
const workerGlobals = [
  ['dedicated-worker', 'DedicatedWorkerGlobalScope'],
  ['shared-worker', 'SharedWorkerGlobalScope'],
  ['service-worker', 'ServiceWorkerGlobalScope'],
] as const

function catalogOf(idl: Record<string, string>) {
  return JSON.parse(generate({ idl: { globals, ...idl }, upstream }).catalog)
}

/** Web IDL's descriptor for an operation or an interface's own data property (ECMAScript binding). */
const method = { type: 'data', writable: true, enumerable: true, configurable: true }

describe('member data: descriptors follow the Web IDL ECMAScript binding', () => {
  test('operations are writable, enumerable, configurable data properties, wherever they are placed', () => {
    const { targets } = catalogOf({
      dom: `
        [Exposed=Window] interface Node { undefined normalize(); };
        partial interface Window { undefined focus(); };`,
      url: '[Exposed=*] interface URL { static boolean canParse(USVString url); };',
      console: '[Exposed=*] namespace console { undefined log(any... data); };',
      fetch: `
        partial interface WorkerGlobalScope { Promise<Response> fetch(RequestInfo input); };`,
    })

    for (const name of ['Node.prototype.normalize', 'Window.focus', 'URL.canParse', 'console.log']) {
      expect(targets.window[name].descriptor, name).toEqual(method)
    }
    expect(targets['dedicated-worker']['WorkerGlobalScope.prototype.fetch'].descriptor).toEqual(method)
  })

  test('regular attributes are enumerable, configurable accessors, with a setter unless they are readonly', () => {
    const { targets } = catalogOf({
      dom: `
        [Exposed=Window] interface Document { attribute DOMString title; readonly attribute DOMString URL; };
        partial interface Window { readonly attribute boolean closed; attribute DOMString name; };`,
      url: '[Exposed=*] interface URL { static readonly attribute boolean ready; };',
      webgpu: '[Exposed=Window] namespace GPUInfo { readonly attribute DOMString vendor; };',
    })
    const accessor = (setter: boolean) => ({ type: 'accessor', setter, enumerable: true, configurable: true })

    expect(targets.window['Document.prototype.title'].descriptor).toEqual(accessor(true))
    expect(targets.window['Document.prototype.URL'].descriptor).toEqual(accessor(false))
    expect(targets.window['Window.name'].descriptor).toEqual(accessor(true))
    expect(targets.window['Window.closed'].descriptor).toEqual(accessor(false))
    expect(targets.window['URL.ready'].descriptor).toEqual(accessor(false))
    expect(targets.window['GPUInfo.vendor'].descriptor).toEqual(accessor(false))
  })

  test('constants are enumerable, non-writable, non-configurable data properties, on every holder they sit on', () => {
    const { targets } = catalogOf({
      dom: `
        [Exposed=Window] interface Node { const unsigned short ELEMENT_NODE = 1; };
        [Exposed=Window] callback interface NodeFilter { const unsigned long SHOW_ALL = 0xFFFFFFFF; };`,
      webgpu: '[Exposed=(Window,Worker)] namespace GPUBufferUsage { const GPUFlagsConstant MAP_READ = 0x0001; };',
      webgl: '[Exposed=Window, LegacyNoInterfaceObject] interface EXT_ext { const GLenum EXT_CONST = 0x84FE; };',
    })
    const constant = { type: 'data', writable: false, enumerable: true, configurable: false }

    for (const name of [
      'Node.ELEMENT_NODE',
      'Node.prototype.ELEMENT_NODE',
      'NodeFilter.SHOW_ALL',
      'GPUBufferUsage.MAP_READ',
      'EXT_ext.prototype.EXT_CONST',
    ]) {
      expect(targets.window[name].descriptor, name).toEqual(constant)
    }
  })

  test('[LegacyUnforgeable] members are non-configurable, and unforgeable operations non-writable, on the global and on each instance', () => {
    const { targets, instanceMembers } = catalogOf({
      html: `
        [Exposed=Window]
        interface Location {
          [LegacyUnforgeable] stringifier attribute USVString href;
          [LegacyUnforgeable] readonly attribute USVString origin;
          [LegacyUnforgeable] undefined reload();
        };
        partial interface Window {
          [PutForwards=href, LegacyUnforgeable] readonly attribute Location location;
          [LegacyUnforgeable] readonly attribute WindowProxy window;
          [LegacyUnforgeable] undefined stop();
        };`,
    })
    const unforgeable = (setter: boolean) => ({ type: 'accessor', setter, enumerable: true, configurable: false })
    const unforgeableMethod = { type: 'data', writable: false, enumerable: true, configurable: false }

    expect(targets.window['Window.location'].descriptor).toEqual(unforgeable(true))
    expect(targets.window['Window.window'].descriptor).toEqual(unforgeable(false))
    expect(targets.window['Window.stop'].descriptor).toEqual(unforgeableMethod)
    expect(instanceMembers.window.Location.href.descriptor).toEqual(unforgeable(true))
    expect(instanceMembers.window.Location.origin.descriptor).toEqual(unforgeable(false))
    expect(instanceMembers.window.Location.reload.descriptor).toEqual(unforgeableMethod)
  })

  test('the properties holding interface, namespace and legacy callback interface objects are writable, non-enumerable and configurable', () => {
    const { targets } = catalogOf({
      dom: `
        [Exposed=Window] interface Node {};
        [Exposed=Window] callback interface NodeFilter { const unsigned long SHOW_ALL = 0xFFFFFFFF; };`,
      console: '[Exposed=*] namespace console {};',
      'wasm-js-api': `
        [Exposed=*] namespace WebAssembly {};
        [LegacyNamespace=WebAssembly, Exposed=*] interface Module {};`,
    })
    const hidden = { type: 'data', writable: true, enumerable: false, configurable: true }

    for (const name of [
      'Window.Node',
      'Window.EventTarget',
      'Window.NodeFilter',
      'Window.console',
      'Window.WebAssembly',
      'WebAssembly.Module',
      'Window.Window',
    ]) {
      expect(targets.window[name].descriptor, name).toEqual(hidden)
    }
    expect(targets['service-worker']['ServiceWorkerGlobalScope.console'].descriptor).toEqual(hidden)
  })
})

describe('member data: immutable prototypes', () => {
  /** The holders of a realm that carry `immutablePrototype`, sorted. */
  const immutableIn = (holders: Record<string, { immutablePrototype?: true }>) =>
    Object.keys(holders)
      .filter((name) => holders[name]?.immutablePrototype)
      .sort()

  test("each realm's global object, WindowProperties, and the prototypes of the global's interface and its ancestors are immutable", () => {
    const { holders } = catalogOf({
      dom: '[Exposed=*] interface Node : EventTarget {};',
      html: '[Exposed=Window] interface Location {};',
    })

    expect(immutableIn(holders.window)).toEqual([
      'EventTarget.prototype',
      'Window',
      'Window.prototype',
      'WindowProperties',
    ])
    for (const [realm, global] of workerGlobals) {
      expect(immutableIn(holders[realm]), realm).toEqual(
        [global, `${global}.prototype`, 'WorkerGlobalScope.prototype', 'EventTarget.prototype'].sort(),
      )
    }
  })

  test('an interface any [Global] interface inherits has an immutable prototype, even when that global is in no realm', () => {
    const { holders } = catalogOf({
      worklets: `
        [Exposed=(Window,Worklet)] interface WorkletGlobalScope {};
        [Global=(Worklet,PaintWorklet), Exposed=PaintWorklet]
        interface PaintWorkletGlobalScope : WorkletGlobalScope {};`,
    })

    expect(holders.window['WorkletGlobalScope.prototype']).toMatchObject({ immutablePrototype: true })
    expect(holders.window.WorkletGlobalScope).not.toHaveProperty('immutablePrototype')
  })

  test('Location instances are immutable, wherever Location is exposed; its prototype and interface object are not', () => {
    const { holders, instances } = catalogOf({
      html: `
        [Exposed=Window] interface Location { [LegacyUnforgeable] undefined reload(); };
        [Exposed=Worker] interface WorkerLocation {};`,
    })

    expect(instances).toEqual({
      window: { Location: { immutablePrototype: true } },
      'dedicated-worker': {},
      'shared-worker': {},
      'service-worker': {},
    })
    expect(holders.window['Location.prototype']).not.toHaveProperty('immutablePrototype')
    expect(holders.window.Location).not.toHaveProperty('immutablePrototype')
  })
})

describe('member data: assign kinds come from IDL', () => {
  const html = `
    typedef EventHandlerNonNull? EventHandler;
    typedef OnErrorEventHandlerNonNull? OnErrorEventHandler;
    typedef OnBeforeUnloadEventHandlerNonNull? OnBeforeUnloadEventHandler;
    [Exposed=Window] interface Location { [LegacyUnforgeable] stringifier attribute USVString href; };
    [Exposed=Window] interface Document { attribute DOMString title; };
    [Exposed=Window] interface Navigator {};
    interface mixin NavigatorID { readonly attribute DOMString userAgent; };
    Navigator includes NavigatorID;
    interface mixin GlobalEventHandlers { attribute OnErrorEventHandler onerror; attribute EventHandler onclick; };
    Window includes GlobalEventHandlers;
    Document includes GlobalEventHandlers;
    partial interface Window {
      [PutForwards=href, LegacyUnforgeable] readonly attribute Location location;
      [Replaceable] readonly attribute unsigned long length;
      attribute OnBeforeUnloadEventHandler onbeforeunload;
      undefined focus();
    };`
  const fullscreen = 'partial interface Document { [LegacyLenientSetter] readonly attribute boolean fullscreen; };'

  test('each attribute has the assign kind its IDL declares', () => {
    const { targets, instanceMembers } = catalogOf({ html, fullscreen })
    const assignOf = (name: string) => targets.window[name].assign

    expect(assignOf('Document.prototype.title')).toBe('setter')
    expect(instanceMembers.window.Location.href.assign).toBe('setter')
    expect(assignOf('Window.location')).toBe('put-forwards')
    expect(assignOf('Window.onerror')).toBe('event-handler')
    expect(assignOf('Document.prototype.onclick')).toBe('event-handler')
    expect(assignOf('Window.onbeforeunload')).toBe('event-handler')
    expect(assignOf('Window.length')).toBe('replaceable')
    expect(assignOf('Document.prototype.fullscreen')).toBe('lenient-setter')
    expect(assignOf('Navigator.prototype.userAgent')).toBe('readonly')
  })

  test('only attributes have an assign kind', () => {
    const { targets } = catalogOf({
      html,
      dom: '[Exposed=Window] interface Node { const unsigned short ELEMENT_NODE = 1; };',
    })

    for (const name of ['Window.focus', 'Node.ELEMENT_NODE', 'Node.prototype.ELEMENT_NODE', 'Window.Node']) {
      expect(targets.window[name], name).not.toHaveProperty('assign')
    }
  })

  test('refuses a writable attribute with [PutForwards], [Replaceable] or [LegacyLenientSetter], or one with two of them', () => {
    expect(() =>
      catalogOf({ html: 'partial interface Window { [Replaceable] attribute unsigned long length; };' }),
    ).toThrow('Window.length (html) is [Replaceable], which only a readonly attribute can be')
    expect(() =>
      catalogOf({
        html: 'partial interface Window { [Replaceable, LegacyLenientSetter] readonly attribute unsigned long length; };',
      }),
    ).toThrow('Window.length (html) is both [Replaceable] and [LegacyLenientSetter]')
  })
})

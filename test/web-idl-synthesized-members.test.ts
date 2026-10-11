// Members the Web IDL ECMAScript binding synthesizes rather than declares (§4 Sources): stringifier
// `toString`, the methods of iterable, async_iterable, maplike and setlike declarations, the `@@iterator` of every
// interface with an indexed property getter, and the structural properties `X.prototype`, `X.prototype.constructor`,
// `@@toStringTag` and `@@unscopables`; and the `[LegacyWindowAlias]` and `[LegacyFactoryFunction]` names on the global.
// These tests go through the generator seam with small IDL.

import { describe, expect, test } from 'vitest'
import { generate } from '../tools/catalog-generator/generate.ts'

const upstream = { '@webref/idl': '1.0.0', webidl2: '24.5.0' }

const globals = `
  [Global=Window, Exposed=Window] interface Window {};
  [Global=(Worker,DedicatedWorker), Exposed=DedicatedWorker] interface DedicatedWorkerGlobalScope {};
  [Global=(Worker,SharedWorker), Exposed=SharedWorker] interface SharedWorkerGlobalScope {};
  [Global=(Worker,ServiceWorker), Exposed=ServiceWorker] interface ServiceWorkerGlobalScope {};`

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read catalog fields freely
type Catalog = any

function catalogOf(idl: Record<string, string>): Catalog {
  return JSON.parse(generate({ idl: { globals, ...idl }, upstream }).catalog)
}

/** Web IDL's descriptors (ECMAScript binding). */
const method = { type: 'data', writable: true, enumerable: true, configurable: true }

describe('stringifiers', () => {
  test('an anonymous stringifier, a typed one and a stringifier attribute each give the prototype a toString', () => {
    const { targets } = catalogOf({
      url: '[Exposed=*] interface URL { stringifier attribute USVString href; };',
      dom: '[Exposed=Window] interface Range { stringifier; };',
      geometry: '[Exposed=Window] interface DOMMatrixReadOnly { stringifier DOMString (); };',
    })

    expect(targets.window['URL.prototype.toString']).toEqual({
      owner: 'URL',
      member: 'toString',
      holder: 'prototype',
      kind: 'operation',
      spec: 'url',
      descriptor: method,
      surface: 'other',
    })
    expect(targets['dedicated-worker']['URL.prototype.toString']).toBeDefined()
    expect(targets.window['Range.prototype.toString']).toMatchObject({ owner: 'Range', spec: 'dom', descriptor: method })
    expect(targets.window['DOMMatrixReadOnly.prototype.toString']).toMatchObject({ kind: 'operation' })
  })
})

const hiddenMethod = { type: 'data', writable: true, enumerable: false, configurable: true }

/** The names of a holder's targets in a realm, sorted: `Headers.prototype` → `entries`, `@@iterator`, … */
function membersOn(catalog: Catalog, holder: string, realm = 'window'): string[] {
  return Object.entries(catalog.targets[realm] as Record<string, { member: string }>)
    .filter(([name, { member }]) => name === `${holder}.${member}`)
    .map(([, { member }]) => member)
    .sort()
}

describe('iterable, async_iterable, maplike and setlike declarations', () => {
  test('a pair iterable gives entries, keys, values, forEach and a hidden @@iterator', () => {
    const catalog = catalogOf({
      fetch: '[Exposed=(Window,Worker)] interface Headers { iterable<ByteString, ByteString>; };',
    })

    expect(membersOn(catalog, 'Headers.prototype')).toEqual([
      '@@iterator',
      '@@toStringTag',
      'constructor',
      'entries',
      'forEach',
      'keys',
      'values',
    ])
    expect(catalog.targets.window['Headers.prototype.entries']).toEqual({
      owner: 'Headers',
      member: 'entries',
      holder: 'prototype',
      kind: 'operation',
      spec: 'fetch',
      descriptor: method,
      surface: 'other',
    })
    expect(catalog.targets.window['Headers.prototype.@@iterator']).toMatchObject({ descriptor: hiddenMethod })
    expect(catalog.targets['service-worker']['Headers.prototype.@@iterator']).toBeDefined()
  })

  test('a value iterable has an indexed getter, whose @@iterator is its own, and entries, keys, values and forEach', () => {
    const catalog = catalogOf({
      dom: `[Exposed=Window] interface NodeList {
        getter Node? item(unsigned long index);
        iterable<Node>;
      };`,
    })

    expect(membersOn(catalog, 'NodeList.prototype')).toEqual([
      '@@iterator',
      '@@toStringTag',
      'constructor',
      'entries',
      'forEach',
      'item',
      'keys',
      'values',
    ])
  })

  test('every interface with an indexed property getter has @@iterator, whether or not it declares iterable', () => {
    const catalog = catalogOf({
      dom: `[Exposed=Window] interface HTMLCollection {
        getter Element? item(unsigned long index);
        getter Element? namedItem(DOMString name);
      };`,
    })

    expect(membersOn(catalog, 'HTMLCollection.prototype')).toEqual([
      '@@iterator',
      '@@toStringTag',
      'constructor',
      'item',
      'namedItem',
    ])
    expect(catalog.targets.window['HTMLCollection.prototype.@@iterator']).toMatchObject({
      kind: 'operation',
      descriptor: hiddenMethod,
    })
  })

  test('async_iterable gives @@asyncIterator and values, and entries and keys for pairs', () => {
    const catalog = catalogOf({
      streams: '[Exposed=*] interface ReadableStream { async_iterable<any>; };',
      fs: '[Exposed=(Window,Worker)] interface FileSystemDirectoryHandle { async_iterable<USVString, any>; };',
    })

    expect(membersOn(catalog, 'ReadableStream.prototype')).toEqual([
      '@@asyncIterator',
      '@@toStringTag',
      'constructor',
      'values',
    ])
    expect(membersOn(catalog, 'FileSystemDirectoryHandle.prototype')).toEqual([
      '@@asyncIterator',
      '@@toStringTag',
      'constructor',
      'entries',
      'keys',
      'values',
    ])
    expect(catalog.targets.window['ReadableStream.prototype.@@asyncIterator']).toMatchObject({ descriptor: hiddenMethod })
  })

  test('a maplike gives size, its readers and @@iterator, and set, delete and clear unless readonly', () => {
    const catalog = catalogOf({
      webrtc: '[Exposed=Window] interface RTCStatsReport { readonly maplike<DOMString, object>; };',
      css: `[Exposed=Window] interface HighlightRegistry { maplike<DOMString, Highlight>; };`,
    })

    const readers = ['@@iterator', '@@toStringTag', 'constructor', 'entries', 'forEach', 'get', 'has', 'keys', 'size', 'values']
    expect(membersOn(catalog, 'RTCStatsReport.prototype')).toEqual(readers)
    expect(membersOn(catalog, 'HighlightRegistry.prototype')).toEqual([...readers, 'clear', 'delete', 'set'].sort())
    expect(catalog.targets.window['RTCStatsReport.prototype.size']).toEqual({
      owner: 'RTCStatsReport',
      member: 'size',
      holder: 'prototype',
      kind: 'attribute',
      spec: 'webrtc',
      descriptor: { type: 'accessor', setter: false, enumerable: true, configurable: true },
      assign: 'readonly',
      surface: 'other',
    })
  })

  test('a setlike gives size, its readers and @@iterator, and add, delete and clear unless readonly', () => {
    const catalog = catalogOf({
      fonts: '[Exposed=(Window,Worker)] interface FontFaceSet { setlike<FontFace>; };',
      webgpu: '[Exposed=(Window,Worker)] interface GPUSupportedFeatures { readonly setlike<DOMString>; };',
    })

    const readers = ['@@iterator', '@@toStringTag', 'constructor', 'entries', 'forEach', 'has', 'keys', 'size', 'values']
    expect(membersOn(catalog, 'GPUSupportedFeatures.prototype')).toEqual(readers)
    expect(membersOn(catalog, 'FontFaceSet.prototype')).toEqual([...readers, 'add', 'clear', 'delete'].sort())
  })

  test('a member the interface declares itself keeps its declaration', () => {
    const catalog = catalogOf({
      css: `[Exposed=Window] interface CSSFontFeatureValuesMap {
        maplike<CSSOMString, sequence<unsigned long>>;
        undefined set(CSSOMString featureValueName, (unsigned long or sequence<unsigned long>) values);
      };`,
    })

    expect(catalog.targets.window['CSSFontFeatureValuesMap.prototype.set']).toMatchObject({ spec: 'css', kind: 'operation' })
    expect(membersOn(catalog, 'CSSFontFeatureValuesMap.prototype')).toContain('delete')
  })
})

describe('structural properties', () => {
  test("an interface object's prototype and its prototype's constructor hold each other; @@toStringTag is on the prototype", () => {
    const catalog = catalogOf({
      dom: '[Exposed=Window] interface EventTarget {}; [Exposed=Window] interface Node : EventTarget {};',
    })

    expect(catalog.targets.window['Node.prototype']).toEqual({
      owner: 'Node',
      member: 'prototype',
      holder: 'constructor',
      kind: 'value',
      spec: 'dom',
      holds: 'Node.prototype',
      descriptor: { type: 'data', writable: false, enumerable: false, configurable: false },
      surface: 'other',
    })
    expect(catalog.targets.window['Node.prototype.constructor']).toEqual({
      owner: 'Node',
      member: 'constructor',
      holder: 'prototype',
      kind: 'function',
      spec: 'dom',
      holds: 'Node',
      descriptor: { type: 'data', writable: true, enumerable: false, configurable: true },
      surface: 'other',
    })
    expect(catalog.targets.window['Node.prototype.@@toStringTag']).toEqual({
      owner: 'Node',
      member: '@@toStringTag',
      holder: 'prototype',
      kind: 'value',
      spec: 'dom',
      descriptor: { type: 'data', writable: false, enumerable: false, configurable: true },
      surface: 'other',
    })
  })

  test("an interface object's and an operation's length and name are not targets", () => {
    const catalog = catalogOf({ dom: '[Exposed=Window] interface Node { undefined normalize(); };' })

    const names = Object.keys(catalog.targets.window)
    expect(names.filter((name) => /\.(length|name)$/.test(name))).toEqual([])
  })

  test("the realm global interface's objects are named by their path from the global", () => {
    const catalog = catalogOf({})

    expect(catalog.targets.window['Window.Window.prototype']).toMatchObject({ holder: 'constructor', holds: 'Window.prototype' })
    expect(catalog.targets.window['Window.prototype.constructor']).toMatchObject({ holder: 'prototype', holds: 'Window.Window' })
    expect(catalog.targets.window['Window.prototype.@@toStringTag']).toBeDefined()
    expect(catalog.targets['dedicated-worker']['DedicatedWorkerGlobalScope.prototype.constructor']).toMatchObject({
      holds: 'DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope',
    })
  })

  test('[LegacyNamespace] interfaces use their qualified names', () => {
    const catalog = catalogOf({
      wasm: `[Exposed=*] namespace WebAssembly {};
        [LegacyNamespace=WebAssembly, Exposed=*] interface Module {};`,
    })

    expect(catalog.targets.window['WebAssembly.Module.prototype']).toMatchObject({ holds: 'WebAssembly.Module.prototype' })
    expect(catalog.targets.window['WebAssembly.Module.prototype.constructor']).toMatchObject({ holds: 'WebAssembly.Module' })
    expect(catalog.targets.window['WebAssembly.@@toStringTag']).toMatchObject({ holder: 'namespace', kind: 'value' })
  })

  test('an interface without an interface object has @@toStringTag, but no prototype or constructor', () => {
    const catalog = catalogOf({ dom: '[Exposed=Window, LegacyNoInterfaceObject] interface Hidden {};' })

    expect(membersOn(catalog, 'Hidden.prototype')).toEqual(['@@toStringTag'])
  })

  test('@@unscopables is on the prototype of an interface with [Unscopable] members, mixins included', () => {
    const catalog = catalogOf({
      dom: `[Exposed=Window] interface Element {};
        interface mixin ChildNode { [Unscopable] undefined remove(); };
        Element includes ChildNode;
        [Exposed=Window] interface Attr {};`,
    })

    expect(catalog.targets.window['Element.prototype.@@unscopables']).toEqual({
      owner: 'Element',
      member: '@@unscopables',
      holder: 'prototype',
      kind: 'value',
      spec: 'dom',
      descriptor: { type: 'data', writable: false, enumerable: false, configurable: true },
      surface: 'other',
    })
    expect(catalog.targets.window['Attr.prototype.@@unscopables']).toBeUndefined()
  })

  test('a namespace has @@toStringTag', () => {
    const catalog = catalogOf({ console: '[Exposed=*] namespace console { undefined log(any... data); };' })

    expect(membersOn(catalog, 'console', 'service-worker')).toEqual(['@@toStringTag', 'log'])
  })

  test('a callback interface synthesizes nothing', () => {
    const catalog = catalogOf({ dom: '[Exposed=Window] callback interface NodeFilter { const unsigned short FILTER_ACCEPT = 1; };' })

    expect(membersOn(catalog, 'NodeFilter')).toEqual(['FILTER_ACCEPT'])
  })
})

describe('an unforgeable stringifier', () => {
  test("puts toString on each instance, neither writable nor configurable", () => {
    const catalog = catalogOf({
      html: '[Exposed=Window] interface Location { [LegacyUnforgeable] stringifier attribute USVString href; };',
    })

    expect(catalog.targets.window['Location.prototype.toString']).toBeUndefined()
    expect(catalog.instanceMembers.window.Location.toString).toEqual({
      owner: 'Location',
      member: 'toString',
      kind: 'operation',
      spec: 'html',
      descriptor: { type: 'data', writable: false, enumerable: true, configurable: false },
      surface: 'other',
    })
  })
})

describe('names on the global', () => {
  const globalProperty = { type: 'data', writable: true, enumerable: false, configurable: true }

  test('a [LegacyWindowAlias] name is a global target holding the same interface object, in the window realm only', () => {
    const catalog = catalogOf({
      url: '[Exposed=*, LegacyWindowAlias=webkitURL] interface URL {};',
      geometry: '[Exposed=(Window,Worker), LegacyWindowAlias=(SVGMatrix,WebKitCSSMatrix)] interface DOMMatrix {};',
    })

    expect(catalog.targets.window['Window.webkitURL']).toEqual({
      owner: 'Window',
      member: 'webkitURL',
      holder: 'global',
      kind: 'interface',
      spec: 'url',
      holds: 'URL',
      descriptor: globalProperty,
      surface: 'other',
    })
    expect(catalog.targets.window['Window.SVGMatrix']).toMatchObject({ holds: 'DOMMatrix' })
    expect(catalog.targets.window['Window.WebKitCSSMatrix']).toMatchObject({ holds: 'DOMMatrix' })
    expect(catalog.targets['dedicated-worker']['DedicatedWorkerGlobalScope.webkitURL']).toBeUndefined()
    expect(catalog.holders.window.webkitURL).toBeUndefined()
  })

  test('a [LegacyFactoryFunction] is its own constructor holder, whose only target is its prototype', () => {
    const catalog = catalogOf({
      dom: '[Exposed=Window] interface HTMLElement {};',
      html: `[Exposed=Window, LegacyFactoryFunction=Image(optional unsigned long width, optional unsigned long height)]
        interface HTMLImageElement : HTMLElement {};`,
    })

    expect(catalog.targets.window['Window.Image']).toEqual({
      owner: 'Window',
      member: 'Image',
      holder: 'global',
      kind: 'interface',
      spec: 'html',
      holds: 'Image',
      descriptor: globalProperty,
      surface: 'other',
    })
    expect(catalog.holders.window.Image).toEqual({ kind: 'constructor', owner: 'HTMLImageElement', proto: 'Function.prototype' })
    expect(membersOn(catalog, 'Image')).toEqual(['prototype'])
    expect(catalog.targets.window['Image.prototype']).toEqual({
      owner: 'HTMLImageElement',
      member: 'prototype',
      holder: 'constructor',
      kind: 'value',
      spec: 'html',
      holds: 'HTMLImageElement.prototype',
      descriptor: { type: 'data', writable: false, enumerable: false, configurable: false },
      surface: 'other',
    })
  })
})

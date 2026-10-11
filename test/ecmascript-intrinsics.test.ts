import { describe, expect, test } from 'vitest'
import type { EngineExtension, EsAddition, EsProseProperty } from '../src/index.ts'
import { generate } from '../tools/catalog-generator/generate.ts'

const upstream = { '@webref/idl': '1.0.0', webidl2: '24.5.0' }

/** The global interfaces of the four realms. */
const globals = `
  [Global=Window, Exposed=Window] interface Window {};
  [Global=(Worker,DedicatedWorker), Exposed=DedicatedWorker] interface DedicatedWorkerGlobalScope {};
  [Global=(Worker,SharedWorker), Exposed=SharedWorker] interface SharedWorkerGlobalScope {};
  [Global=(Worker,ServiceWorker), Exposed=ServiceWorker] interface ServiceWorkerGlobalScope {};`

let clauseCount = 0

/** A biblio clause entry, as `@tc39/ecma262-biblio` and `@tc39/ecma402-biblio` list them. */
function clause(number: string, title: string, id = `sec-fixture-${++clauseCount}`) {
  return { type: 'clause', id, number, title, aoid: null as string | null }
}

/**
 * The structural clauses of ECMA-262 the generator finds its way by, and the intrinsics every ECMAScript realm needs
 * for its prototype chains: `Object`, `Object.prototype`, `Function` and `Function.prototype`.
 */
const ecma262Skeleton = [
  clause('19', 'The Global Object', 'sec-global-object'),
  clause('19.1', 'Value Properties of the Global Object', 'sec-value-properties-of-the-global-object'),
  clause('19.2', 'Function Properties of the Global Object', 'sec-function-properties-of-the-global-object'),
  clause('19.3', 'Constructor Properties of the Global Object', 'sec-constructor-properties-of-the-global-object'),
  clause('19.3.1', 'Function ( . . . )'),
  clause('19.3.2', 'Object ( . . . )'),
  clause('19.4', 'Other Properties of the Global Object', 'sec-other-properties-of-the-global-object'),
  clause('20', 'Fundamental Objects', 'sec-fundamental-objects'),
  clause('20.1.2.1', 'Object.prototype'),
  clause('20.2.2.1', 'Function.prototype'),
  clause('20.5.5', 'Native Error Types Used in This Standard', 'sec-native-error-types-used-in-this-standard'),
  clause('28', 'Reflection', 'sec-reflection'),
  clause('B.2', 'Additional Built-in Properties', 'sec-additional-built-in-properties'),
  clause('B.2.1', 'Additional Properties of the Global Object', 'sec-additional-properties-of-the-global-object'),
]

const ecma402Skeleton = [clause('8', 'The Intl Object', 'intl-object')]

interface Fixture {
  ecma262?: ReturnType<typeof clause>[]
  ecma402?: ReturnType<typeof clause>[]
  additions?: Record<string, EsAddition>
  engineExtensions?: Record<string, EngineExtension>
  proseProperties?: Record<string, EsProseProperty>
  idl?: Record<string, string>
}

function generateWith(fixture: Fixture) {
  const { ecma262 = [], ecma402 = [], additions = {}, engineExtensions = {}, proseProperties = {}, idl = {} } = fixture
  const ecmascript = {
    ecma262: { entries: [...ecma262Skeleton, ...ecma262] },
    ecma402: { entries: [...ecma402Skeleton, ...ecma402] },
    additions,
    engineExtensions,
    proseProperties,
  }
  return JSON.parse(generate({ idl: { globals, ...idl }, ecmascript, upstream }).catalog)
}

describe('ECMAScript intrinsics', () => {
  test('a global constructor is a global target in every realm, and its statics sit on the constructor', () => {
    const catalog = generateWith({
      ecma262: [
        clause('19.3.3', 'Promise ( . . . )'),
        clause('27.2.4.2', 'Promise.allSettled ( iterable )'),
        clause('27.2.4.4', 'Promise.prototype'),
      ],
    })

    expect(catalog.targets.window['Window.Promise']).toMatchObject({
      owner: 'Window',
      member: 'Promise',
      holder: 'global',
      kind: 'function',
      spec: 'ecma262',
      holds: 'Promise',
    })
    expect(catalog.targets['dedicated-worker']['DedicatedWorkerGlobalScope.Promise']).toMatchObject({
      owner: 'DedicatedWorkerGlobalScope',
      holder: 'global',
      holds: 'Promise',
    })
    for (const realm of ['window', 'dedicated-worker', 'shared-worker', 'service-worker']) {
      expect(catalog.targets[realm]['Promise.allSettled']).toMatchObject({
        owner: 'Promise',
        member: 'allSettled',
        holder: 'constructor',
        kind: 'function',
        spec: 'ecma262',
      })
    }
  })

  test('prototype members sit on the prototype, and well-known-symbol members are named @@', () => {
    const { window } = generateWith({
      ecma262: [
        clause('19.3.3', 'Array ( . . . )'),
        clause('23.1.2.5', 'Array.prototype'),
        clause('23.1.3.21', 'Array.prototype.map ( callback [ , thisArg ] )'),
        clause('23.1.3.40', 'Array.prototype [ %Symbol.iterator% ] ( )'),
        clause('23.1.2.6', 'get Array [ %Symbol.species% ]'),
      ],
    }).targets

    expect(window['Array.prototype.map']).toMatchObject({
      owner: 'Array',
      member: 'map',
      holder: 'prototype',
      kind: 'function',
    })
    expect(window['Array.prototype.@@iterator']).toMatchObject({
      owner: 'Array',
      member: '@@iterator',
      holder: 'prototype',
      kind: 'function',
    })
    expect(window['Array.@@species']).toMatchObject({ member: '@@species', holder: 'constructor', kind: 'accessor' })
    expect(window['Array.prototype']).toMatchObject({ holder: 'constructor', kind: 'value', holds: 'Array.prototype' })
  })

  test('the global object’s other properties are namespaces: Math, JSON, Reflect, Atomics; the properties holding them have kind namespace', () => {
    const { window } = generateWith({
      ecma262: [
        clause('19.4.1', 'Atomics'),
        clause('19.4.2', 'JSON'),
        clause('19.4.3', 'Math'),
        clause('19.4.4', 'Reflect'),
        clause('21.3.1.6', 'Math.PI'),
        clause('25.4.9', 'Atomics.load ( typedArray, index )'),
        clause('25.5.2', 'JSON.parse ( text [ , reviver ] )'),
        clause('28.1.1', 'Reflect.apply ( target, thisArgument, argumentsList )'),
      ],
    }).targets

    expect(window['Window.Math']).toMatchObject({ holder: 'global', kind: 'namespace', holds: 'Math' })
    expect(window['Math.PI']).toMatchObject({ owner: 'Math', member: 'PI', holder: 'namespace', kind: 'value' })
    expect(window['JSON.parse']).toMatchObject({ owner: 'JSON', holder: 'namespace', kind: 'function' })
    expect(window['Reflect.apply']).toMatchObject({ holder: 'namespace' })
    expect(window['Atomics.load']).toMatchObject({ holder: 'namespace' })
  })

  describe('descriptors follow ECMA-262', () => {
    const { window } = generateWith({
      ecma262: [
        clause('19.1.1', 'globalThis'),
        clause('19.1.2', 'Infinity'),
        clause('19.1.3', 'NaN'),
        clause('19.1.4', 'undefined'),
        clause('19.2.1', 'eval ( x )'),
        clause('19.3.3', 'Array ( . . . )'),
        clause('19.3.4', 'Number ( . . . )'),
        clause('19.3.5', 'Symbol ( . . . )'),
        clause('19.4.1', 'Math'),
        clause('20.1.3.8', 'Object.prototype.__proto__'),
        clause('20.1.3.8.1', 'get Object.prototype.__proto__'),
        clause('20.1.3.8.2', 'set Object.prototype.__proto__'),
        clause('20.2.3.6', 'Function.prototype [ %Symbol.hasInstance% ] ( V )'),
        clause('20.4.2.7', 'Symbol.iterator'),
        clause('20.4.2.4', 'Symbol.for ( key )'),
        clause('20.4.3.5', 'Symbol.prototype [ %Symbol.toPrimitive% ] ( hint )'),
        clause('21.1.2.7', 'Number.MAX_VALUE'),
        clause('21.1.2.15', 'Number.prototype'),
        clause('21.3.1.6', 'Math.PI'),
        clause('21.3.1.9', 'Math [ %Symbol.toStringTag% ]'),
        clause('21.3.2.28', 'Math.random ( )'),
        clause('23.1.2.5', 'Array.prototype'),
        clause('23.1.3.1', 'Array.prototype.constructor'),
        clause('23.1.3.41', 'Array.prototype [ %Symbol.unscopables% ]'),
        clause('24.1.3.10', 'get Map.prototype.size'),
        clause('19.3.7', 'Map ( . . . )'),
        clause('24.1.2.2', 'Map.prototype'),
      ],
    }).targets
    const writable = { type: 'data', writable: true, enumerable: false, configurable: true }
    const readonly = { type: 'data', writable: false, enumerable: false, configurable: false }
    const readonlyConfigurable = { type: 'data', writable: false, enumerable: false, configurable: true }

    test('functions and other data properties are writable, non-enumerable and configurable', () => {
      for (const name of ['Window.eval', 'Window.Array', 'Window.Math', 'Window.globalThis', 'Math.random']) {
        expect(window[name].descriptor, name).toEqual(writable)
      }
      expect(window['Symbol.for'].descriptor).toEqual(writable)
      expect(window['Array.prototype.constructor'].descriptor).toEqual(writable)
    })

    test('accessors are non-enumerable and configurable, with a setter only where ECMA-262 defines one', () => {
      expect(window['Map.prototype.size'].descriptor).toEqual({
        type: 'accessor',
        setter: false,
        enumerable: false,
        configurable: true,
      })
      expect(window['Object.prototype.__proto__'].descriptor).toEqual({
        type: 'accessor',
        setter: true,
        enumerable: false,
        configurable: true,
      })
    })

    test('Math.PI, the global NaN, Infinity and undefined, and other constants are non-writable and non-configurable', () => {
      for (const name of ['Math.PI', 'Window.NaN', 'Window.Infinity', 'Window.undefined', 'Number.MAX_VALUE']) {
        expect(window[name].descriptor, name).toEqual(readonly)
      }
    })

    test('a constructor’s prototype and the well-known symbols are non-writable and non-configurable', () => {
      expect(window['Array.prototype'].descriptor).toEqual(readonly)
      expect(window['Number.prototype'].descriptor).toEqual(readonly)
      expect(window['Symbol.iterator'].descriptor).toEqual(readonly)
      expect(window['Function.prototype.@@hasInstance'].descriptor).toEqual(readonly)
    })

    test('@@toStringTag, @@unscopables and @@toPrimitive are non-writable but configurable', () => {
      expect(window['Math.@@toStringTag'].descriptor).toEqual(readonlyConfigurable)
      expect(window['Array.prototype.@@unscopables'].descriptor).toEqual(readonlyConfigurable)
      expect(window['Symbol.prototype.@@toPrimitive'].descriptor).toEqual(readonlyConfigurable)
    })
  })

  test('lists each intrinsic as a holder with its kind and prototype, in every realm, where the Web IDL chains end', () => {
    const { holders } = generateWith({
      ecma262: [
        clause('19.3.3', 'Promise ( . . . )'),
        clause('19.3.4', 'WeakRef ( . . . )'),
        clause('19.4.1', 'Math'),
        clause('20.1.3.2', 'Object.prototype.hasOwnProperty ( V )'),
        clause('21.3.1.6', 'Math.PI'),
        clause('26.1.2.1', 'WeakRef.prototype'),
        clause('27.2.4.4', 'Promise.prototype'),
        clause('27.2.5.4', 'Promise.prototype.then ( onFulfilled, onRejected )'),
      ],
    })

    const expected = {
      Function: { kind: 'constructor', owner: 'Function', proto: 'Function.prototype' },
      'Function.prototype': { kind: 'prototype', owner: 'Function', proto: 'Object.prototype' },
      Intl: { kind: 'namespace', owner: 'Intl', proto: 'Object.prototype' },
      Math: { kind: 'namespace', owner: 'Math', proto: 'Object.prototype' },
      Object: { kind: 'constructor', owner: 'Object', proto: 'Function.prototype' },
      'Object.prototype': { kind: 'prototype', owner: 'Object', proto: null, immutablePrototype: true },
      Promise: { kind: 'constructor', owner: 'Promise', proto: 'Function.prototype' },
      'Promise.prototype': { kind: 'prototype', owner: 'Promise', proto: 'Object.prototype' },
      WeakRef: { kind: 'constructor', owner: 'WeakRef', proto: 'Function.prototype' },
      'WeakRef.prototype': { kind: 'prototype', owner: 'WeakRef', proto: 'Object.prototype' },
    }
    const webIdlGlobals = {
      window: 'Window',
      'dedicated-worker': 'DedicatedWorkerGlobalScope',
      'shared-worker': 'SharedWorkerGlobalScope',
      'service-worker': 'ServiceWorkerGlobalScope',
    }
    for (const [realm, global] of Object.entries(webIdlGlobals)) {
      expect(holders[realm]).toEqual({
        ...expected,
        [global]: { kind: 'global', owner: global, proto: `${global}.prototype`, immutablePrototype: true },
        [`${global}.${global}`]: { kind: 'constructor', owner: global, proto: 'Function.prototype' },
        [`${global}.prototype`]: {
          kind: 'prototype',
          owner: global,
          proto: 'Object.prototype',
          immutablePrototype: true,
        },
      })
    }
  })

  test('the generic TypedArray and NativeError clauses define each typed array and native error', () => {
    const typedArrays = ['Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array']
      .concat(['Uint32Array', 'BigInt64Array', 'BigUint64Array', 'Float16Array', 'Float32Array', 'Float64Array'])
    const { targets, holders } = generateWith({
      ecma262: [
        ...typedArrays.map((name, index) => clause(`19.3.${10 + index}`, `${name} ( . . . )`)),
        clause('19.3.30', 'Error ( . . . )'),
        clause('19.3.31', 'EvalError ( . . . )'),
        clause('19.3.32', 'RangeError ( . . . )'),
        clause('20.5.2.2', 'Error.prototype'),
        clause('20.5.5.1', 'EvalError'),
        clause('20.5.5.2', 'RangeError'),
        clause('20.5.6.1.1', 'NativeError ( message [ , options ] )'),
        clause('20.5.6.2.1', 'NativeError.prototype'),
        clause('20.5.6.3.2', 'NativeError.prototype.message'),
        clause('23.2.1.1', '%TypedArray% ( )'),
        clause('23.2.2.3', '%TypedArray%.prototype'),
        clause('23.2.3.22', '%TypedArray%.prototype.map ( callback [ , thisArg ] )'),
        clause('23.2.6.1', 'TypedArray.BYTES_PER_ELEMENT'),
        clause('23.2.6.2', 'TypedArray.prototype'),
        clause('23.2.7.1', 'TypedArray.prototype.BYTES_PER_ELEMENT'),
      ],
    })
    const { window } = targets

    for (const name of typedArrays) {
      expect(window[`${name}.BYTES_PER_ELEMENT`].descriptor, name).toMatchObject({ writable: false, configurable: false })
      expect(window[`${name}.prototype.BYTES_PER_ELEMENT`], name).toMatchObject({ owner: name, holder: 'prototype' })
      expect(holders.window[name], name).toEqual({ kind: 'constructor', owner: name, proto: '%TypedArray%' })
      expect(holders.window[`${name}.prototype`], name).toMatchObject({ proto: '%TypedArray%.prototype' })
    }
    expect(window['EvalError.prototype.message']).toMatchObject({ owner: 'EvalError', holder: 'prototype' })
    expect(window['RangeError.prototype']).toMatchObject({ holds: 'RangeError.prototype' })
    expect(holders.window.EvalError).toEqual({ kind: 'constructor', owner: 'EvalError', proto: 'Error' })
    expect(holders.window['RangeError.prototype']).toMatchObject({ proto: 'Error.prototype' })
    expect(Object.keys(window).filter((name) => /^(TypedArray|NativeError)\b/.test(name))).toEqual([])
  })

  test('a prototype’s constructor property holds its constructor, which is a function', () => {
    const { window } = generateWith({
      ecma262: [
        clause('19.3.3', 'Array ( . . . )'),
        clause('23.1.2.5', 'Array.prototype'),
        clause('23.1.3.1', 'Array.prototype.constructor'),
      ],
    }).targets

    expect(window['Array.prototype.constructor']).toMatchObject({ kind: 'function', holds: 'Array' })
    expect(window['Array.prototype']).toMatchObject({ kind: 'value', holds: 'Array.prototype' })
    expect(window['Function.prototype']).toMatchObject({ kind: 'function', holds: 'Function.prototype' })
  })

  describe('intrinsics that no global property names keep their ECMA-262 %names%', () => {
    const { targets, holders } = generateWith({
      ecma262: [
        clause('19.3.3', 'Iterator ( . . . )'),
        clause('27.1.3.2.3', 'Iterator.prototype'),
        clause('23.1.5.2.1', '%ArrayIteratorPrototype%.next ( )'),
        clause('27.1.4.2', '%AsyncIteratorPrototype% [ %Symbol.asyncIterator% ] ( )'),
        clause('27.1.5.2.1', '%AsyncFromSyncIteratorPrototype%.next ( [ value ] )'),
        clause('27.6.1.1', 'GeneratorFunction ( ...parameterArgs, bodyArg )'),
        clause('27.6.2.1', 'GeneratorFunction.prototype'),
        clause('27.6.3.1', 'GeneratorFunction.prototype.constructor'),
        clause('27.6.3.2', 'GeneratorFunction.prototype.prototype'),
        clause('27.6.3.3', 'GeneratorFunction.prototype [ %Symbol.toStringTag% ]'),
        clause('27.8.1.1', '%GeneratorPrototype%.constructor'),
        clause('27.8.1.2', '%GeneratorPrototype%.next ( value )'),
        clause('27.9.1.2', '%AsyncGeneratorPrototype%.next ( value )'),
      ],
    })
    const { window } = targets
    const fixed = { type: 'data', writable: false, enumerable: false, configurable: false }
    const configurable = { type: 'data', writable: false, enumerable: false, configurable: true }

    test('an iterator prototype is a prototype holder chained to Iterator.prototype', () => {
      expect(window['%ArrayIteratorPrototype%.next']).toMatchObject({
        owner: '%ArrayIteratorPrototype%',
        member: 'next',
        holder: 'prototype',
      })
      expect(holders.window['%ArrayIteratorPrototype%']).toEqual({
        kind: 'prototype',
        owner: '%ArrayIteratorPrototype%',
        proto: 'Iterator.prototype',
      })
      expect(holders.window['%AsyncIteratorPrototype%']).toMatchObject({ proto: 'Object.prototype' })
      expect(holders.window['%AsyncGeneratorPrototype%']).toMatchObject({ proto: '%AsyncIteratorPrototype%' })
    })

    test('GeneratorFunction is %GeneratorFunction%, and its prototype’s prototype is %GeneratorPrototype%', () => {
      expect(holders.window['%GeneratorFunction%']).toEqual({
        kind: 'constructor',
        owner: '%GeneratorFunction%',
        proto: 'Function',
      })
      expect(holders.window['%GeneratorFunction%.prototype']).toMatchObject({ proto: 'Function.prototype' })
      expect(holders.window['%GeneratorPrototype%']).toMatchObject({ kind: 'prototype', proto: 'Iterator.prototype' })
      expect(window['%GeneratorFunction%.prototype']).toMatchObject({ holds: '%GeneratorFunction%.prototype' })
      expect(window['%GeneratorFunction%.prototype.prototype']).toMatchObject({ holds: '%GeneratorPrototype%' })
      expect(window['%GeneratorPrototype%.constructor']).toMatchObject({ holds: '%GeneratorFunction%.prototype' })
      expect(window['%GeneratorFunction%.prototype.constructor']).toMatchObject({ holds: '%GeneratorFunction%' })
      expect(Object.keys(window).filter((name) => name.startsWith('GeneratorFunction'))).toEqual([])
    })

    test('the generator family’s prototype and constructor links are non-writable, as ECMA-262 states', () => {
      expect(window['%GeneratorFunction%.prototype'].descriptor).toEqual(fixed)
      expect(window['%GeneratorFunction%.prototype.prototype'].descriptor).toEqual(configurable)
      expect(window['%GeneratorFunction%.prototype.constructor'].descriptor).toEqual(configurable)
      expect(window['%GeneratorPrototype%.constructor'].descriptor).toEqual(configurable)
    })

    test('%AsyncFromSyncIteratorPrototype%, which ECMAScript code can never reach, is left out', () => {
      expect(Object.keys(window).filter((name) => name.includes('AsyncFromSync'))).toEqual([])
      expect(Object.keys(holders.window).filter((name) => name.includes('AsyncFromSync'))).toEqual([])
    })
  })

  describe('ECMA-402 adds Intl', () => {
    const { targets, holders } = generateWith({
      ecma262: [
        clause('19.3.3', 'String ( . . . )'),
        clause('22.1.2.3', 'String.prototype'),
        clause('22.1.3.12', 'String.prototype.localeCompare ( that [ , reserved1 [ , reserved2 ] ] )'),
      ],
      ecma402: [
        clause('4', 'Overview'),
        clause('8.1.1', 'Intl [ %Symbol.toStringTag% ]'),
        clause('8.2.2', 'Intl.DateTimeFormat ( . . . )'),
        clause('8.3.1', 'Intl.getCanonicalLocales ( locales )'),
        { ...clause('9.2.1', 'CanonicalizeLocaleList ( locales )'), aoid: 'CanonicalizeLocaleList' },
        clause('11.1.1', 'Intl.DateTimeFormat ( [ locales [ , options ] ] )'),
        clause('11.2.1', 'Intl.DateTimeFormat.prototype'),
        clause('11.2.2', 'Intl.DateTimeFormat.supportedLocalesOf ( locales [ , options ] )'),
        clause('11.3.1', 'Intl.DateTimeFormat.prototype.constructor'),
        clause('11.3.3', 'get Intl.DateTimeFormat.prototype.format'),
        clause('19.5.2.1', '%IntlSegmentsPrototype%.containing ( index )'),
        clause('20.1.1', 'String.prototype.localeCompare ( that [ , locales [ , options ] ] )'),
      ],
    })
    const { window } = targets

    test('Intl is a namespace on the global object in every realm', () => {
      expect(window['Window.Intl']).toMatchObject({ holder: 'global', kind: 'namespace', spec: 'ecma402', holds: 'Intl' })
      expect(targets['service-worker']['ServiceWorkerGlobalScope.Intl']).toMatchObject({ holds: 'Intl' })
      expect(window['Window.Intl'].descriptor).toEqual({
        type: 'data',
        writable: true,
        enumerable: false,
        configurable: true,
      })
      expect(window['Intl.getCanonicalLocales']).toMatchObject({ owner: 'Intl', holder: 'namespace', spec: 'ecma402' })
      expect(window['Intl.@@toStringTag'].descriptor).toMatchObject({ writable: false, configurable: true })
      expect(holders.window.Intl).toEqual({ kind: 'namespace', owner: 'Intl', proto: 'Object.prototype' })
    })

    test('Intl.DateTimeFormat is a constructor on the Intl namespace, named by its ECMA-402 path', () => {
      expect(window['Intl.DateTimeFormat']).toMatchObject({
        owner: 'Intl',
        member: 'DateTimeFormat',
        holder: 'namespace',
        kind: 'function',
        holds: 'Intl.DateTimeFormat',
      })
      expect(window['Intl.DateTimeFormat.supportedLocalesOf']).toMatchObject({
        owner: 'Intl.DateTimeFormat',
        holder: 'constructor',
      })
      expect(window['Intl.DateTimeFormat.prototype.format']).toMatchObject({
        owner: 'Intl.DateTimeFormat',
        holder: 'prototype',
        kind: 'accessor',
      })
      expect(window['Intl.DateTimeFormat.prototype.constructor']).toMatchObject({ holds: 'Intl.DateTimeFormat' })
      expect(window['Intl.DateTimeFormat.prototype'].descriptor).toMatchObject({ writable: false, configurable: false })
      expect(holders.window['Intl.DateTimeFormat']).toMatchObject({ kind: 'constructor', proto: 'Function.prototype' })
      expect(window['%IntlSegmentsPrototype%.containing']).toMatchObject({ holder: 'prototype', spec: 'ecma402' })
    })

    test('an ECMA-262 function that ECMA-402 redefines stays one ECMA-262 target', () => {
      expect(window['String.prototype.localeCompare']).toMatchObject({ spec: 'ecma262' })
      expect(Object.keys(window).filter((name) => name.includes('Canonicalize') || name === 'Overview')).toEqual([])
    })
  })

  describe('ES additions come from a curated overlay entry', () => {
    const temporal = {
      spec: 'proposal-temporal',
      source: 'the Temporal proposal, for this test',
      namespaces: ['Temporal', 'Temporal.Now'],
      properties: [
        'Temporal',
        'Temporal [ %Symbol.toStringTag% ]',
        'Temporal.Now',
        'Temporal.Now.instant ( )',
        'Temporal.PlainDate ( . . . )',
        'Temporal.PlainDate.from ( item [ , options ] )',
        'Temporal.PlainDate.prototype',
        'get Temporal.PlainDate.prototype.year',
        'Date.prototype.toTemporalInstant ( )',
      ],
    }
    const date = [clause('19.3.3', 'Date ( . . . )'), clause('21.4.3.3', 'Date.prototype')]
    const catalog = generateWith({ ecma262: date, additions: { Temporal: temporal } })
    const { window } = catalog.targets

    test('Temporal and Temporal.Now are namespaces, credited to the entry’s spec', () => {
      expect(window['Window.Temporal']).toMatchObject({
        holder: 'global',
        kind: 'namespace',
        spec: 'proposal-temporal',
        holds: 'Temporal',
      })
      expect(window['Temporal.Now']).toMatchObject({ holder: 'namespace', kind: 'namespace', holds: 'Temporal.Now' })
      expect(window['Temporal.Now.instant']).toMatchObject({ owner: 'Temporal.Now', holder: 'namespace' })
      expect(window['Temporal.@@toStringTag']).toMatchObject({ spec: 'proposal-temporal' })
      expect(catalog.holders.window['Temporal.Now']).toMatchObject({ kind: 'namespace' })
    })

    test('its constructors, their members, and what it adds to ECMA-262 intrinsics are targets', () => {
      expect(window['Temporal.PlainDate']).toMatchObject({ holder: 'namespace', kind: 'function' })
      expect(window['Temporal.PlainDate.from']).toMatchObject({ owner: 'Temporal.PlainDate', holder: 'constructor' })
      expect(window['Temporal.PlainDate.prototype.year']).toMatchObject({ holder: 'prototype', kind: 'accessor' })
      expect(window['Date.prototype.toTemporalInstant']).toMatchObject({
        owner: 'Date',
        holder: 'prototype',
        spec: 'proposal-temporal',
      })
    })

    test('the merged catalog keeps the overlay as its esAdditions section', () => {
      expect(catalog.esAdditions).toEqual({ Temporal: temporal })
    })

    test('an entry that adds what ECMA-262 already defines is refused', () => {
      const stale = { ...temporal, properties: [...temporal.properties, 'Date.prototype'] }

      expect(() => generateWith({ ecma262: date, additions: { Temporal: stale } })).toThrow(
        'the Temporal addition defines Date.prototype, which ECMA-262 or ECMA-402 already defines',
      )
      const staleGlobal = { ...temporal, properties: [...temporal.properties, 'Date ( . . . )'] }
      expect(() => generateWith({ ecma262: date, additions: { Temporal: staleGlobal } })).toThrow(
        'the Temporal addition defines Date, which ECMA-262 or ECMA-402 already defines',
      )
    })

    test('an entry whose title names no property is refused', () => {
      const malformed = { ...temporal, properties: ['Temporal.PlainDate objects'] }

      expect(() => generateWith({ additions: { Temporal: malformed } })).toThrow(
        'the Temporal addition lists "Temporal.PlainDate objects", which names no property',
      )
    })

    test('an entry that declares a namespace it does not define is refused', () => {
      const undefinedNamespace = { ...temporal, namespaces: [...temporal.namespaces, 'Temporal.Later'] }

      expect(() => generateWith({ ecma262: date, additions: { Temporal: undefinedNamespace } })).toThrow(
        'the Temporal addition declares Temporal.Later a namespace, but defines no property Temporal.Later',
      )
    })
  })

  describe('engine extensions come from a curated overlay', () => {
    const errorClauses = [
      clause('19.3.3', 'Error ( . . . )'),
      clause('20.5.2.1', 'Error.prototype'),
      clause('20.5.3.4', 'Error.prototype.toString ( )'),
    ]
    const extensions = {
      'Error.captureStackTrace': {
        engine: 'v8',
        source: 'V8, for this test',
        kind: 'function',
        descriptor: { type: 'data', writable: true, enumerable: false, configurable: true },
      },
      'Error.stackTraceLimit': {
        engine: 'v8',
        source: 'V8, for this test',
        kind: 'value',
        descriptor: { type: 'data', writable: true, enumerable: true, configurable: true },
      },
    } as const
    const catalog = generateWith({ ecma262: errorClauses, engineExtensions: extensions })

    test('each is a native member of the intrinsic it is on, in every realm, with the engine’s own descriptor', () => {
      for (const realm of ['window', 'dedicated-worker', 'shared-worker', 'service-worker']) {
        expect(catalog.targets[realm]['Error.stackTraceLimit'], realm).toEqual({
          owner: 'Error',
          member: 'stackTraceLimit',
          holder: 'constructor',
          kind: 'value',
          spec: 'v8',
          descriptor: { type: 'data', writable: true, enumerable: true, configurable: true },
          surface: 'ECMAScript',
        })
        expect(catalog.targets[realm]['Error.captureStackTrace'], realm).toEqual({
          owner: 'Error',
          member: 'captureStackTrace',
          holder: 'constructor',
          kind: 'function',
          spec: 'v8',
          descriptor: { type: 'data', writable: true, enumerable: false, configurable: true },
          surface: 'ECMAScript',
        })
      }
    })

    test('the merged catalog keeps the overlay as its engineExtensions section, beside esAdditions', () => {
      expect(catalog.engineExtensions).toEqual(extensions)
      expect(generateWith({}).engineExtensions).toEqual({})
    })

    test('an entry for a property ECMA-262, ECMA-402 or an ES addition defines is refused, so it is dropped once standardized', () => {
      const standardized = { ...extensions, 'Error.prototype.toString': extensions['Error.captureStackTrace'] }

      expect(() => generateWith({ ecma262: errorClauses, engineExtensions: standardized })).toThrow(
        'the engine extension Error.prototype.toString is already defined by ECMA-262, ECMA-402 or an ES addition',
      )
    })

    test('an entry on anything but an ECMAScript intrinsic is refused', () => {
      for (const name of ['Map.prototype.extension', 'stackTraceLimit', 'Error.prototype.message.length']) {
        const stray = { [name]: extensions['Error.stackTraceLimit'] }

        expect(() => generateWith({ ecma262: errorClauses, engineExtensions: stray }), name).toThrow(
          `the engine extension ${name} is not on an ECMAScript intrinsic`,
        )
      }
    })

    test('an entry that names its intrinsic by another path than the catalog’s is refused, since its path is its name', () => {
      const generators = [
        clause('19.3.3', 'Iterator ( . . . )'),
        clause('27.1.3.2.3', 'Iterator.prototype'),
        clause('27.6.1.1', 'GeneratorFunction ( ...parameterArgs, bodyArg )'),
        clause('27.6.2.1', 'GeneratorFunction.prototype'),
        clause('27.6.3.2', 'GeneratorFunction.prototype.prototype'),
        clause('27.8.1.2', '%GeneratorPrototype%.next ( value )'),
      ]
      const onGenerators = (name: string) => ({ [name]: extensions['Error.captureStackTrace'] })

      expect(() =>
        generateWith({ ecma262: generators, engineExtensions: onGenerators('%GeneratorFunction%.prototype.prototype.x') }),
      ).toThrow(
        'the engine extension %GeneratorFunction%.prototype.prototype.x must be named from %GeneratorPrototype%, ' +
          "the catalog's name for the intrinsic it is on",
      )
      const { targets } = generateWith({ ecma262: generators, engineExtensions: onGenerators('%GeneratorPrototype%.x') })
      expect(targets.window['%GeneratorPrototype%.x']).toMatchObject({ owner: '%GeneratorPrototype%', holder: 'prototype' })
    })

    test('an entry whose kind and descriptor disagree is refused', () => {
      const accessor = { type: 'accessor', setter: true, enumerable: false, configurable: true } as const
      const mismatched = [
        { ...extensions['Error.stackTraceLimit'], kind: 'accessor' },
        { ...extensions['Error.stackTraceLimit'], descriptor: accessor },
      ] as const

      for (const entry of mismatched) {
        expect(() => generateWith({ ecma262: errorClauses, engineExtensions: { 'Error.stackTraceLimit': entry } })).toThrow(
          'the engine extension Error.stackTraceLimit has kind',
        )
      }
    })
  })

  describe('ECMA-262 own properties without a clause of their own come from a curated overlay', () => {
    const clauses = [
      clause('19.3.3', 'Array ( . . . )'),
      clause('19.3.4', 'String ( . . . )'),
      clause('20.2.3.5', 'Function.prototype.toString ( )'),
      clause('22.1.2.3', 'String.prototype'),
      clause('23.1.2.5', 'Array.prototype'),
    ]
    const restricted = { type: 'accessor', setter: true, enumerable: false, configurable: true } as const
    const prose = {
      'Array.prototype.length': {
        source: 'ECMA-262, for this test',
        kind: 'value',
        descriptor: { type: 'data', writable: true, enumerable: false, configurable: false },
      },
      'Function.prototype.caller': { source: 'ECMA-262, for this test', kind: 'accessor', descriptor: restricted },
      'String.prototype.length': {
        source: 'ECMA-262, for this test',
        kind: 'value',
        descriptor: { type: 'data', writable: false, enumerable: false, configurable: false },
      },
    } as const
    const catalog = generateWith({ ecma262: clauses, proseProperties: prose })

    test('each is an ECMA-262 member of the intrinsic it is on, in every realm, with the descriptor ECMA-262 gives it', () => {
      for (const realm of ['window', 'dedicated-worker', 'shared-worker', 'service-worker']) {
        expect(catalog.targets[realm]['Function.prototype.caller'], realm).toEqual({
          owner: 'Function',
          member: 'caller',
          holder: 'prototype',
          kind: 'accessor',
          spec: 'ecma262',
          descriptor: restricted,
          surface: 'ECMAScript',
        })
        expect(catalog.targets[realm]['Array.prototype.length'], realm).toEqual({
          owner: 'Array',
          member: 'length',
          holder: 'prototype',
          kind: 'value',
          spec: 'ecma262',
          descriptor: { type: 'data', writable: true, enumerable: false, configurable: false },
          surface: 'ECMAScript',
        })
        expect(catalog.targets[realm]['String.prototype.length'], realm).toMatchObject({
          owner: 'String',
          holder: 'prototype',
          descriptor: { type: 'data', writable: false, enumerable: false, configurable: false },
        })
      }
    })

    test('the merged catalog keeps the overlay as its esProseProperties section', () => {
      expect(catalog.esProseProperties).toEqual(prose)
      expect(generateWith({}).esProseProperties).toEqual({})
    })

    test('an entry for a property a clause of ECMA-262, ECMA-402 or an ES addition defines is refused', () => {
      const claused = { ...prose, 'Function.prototype.toString': prose['Function.prototype.caller'] }

      expect(() => generateWith({ ecma262: clauses, proseProperties: claused })).toThrow(
        'the ECMA-262 prose property Function.prototype.toString is already defined by ECMA-262, ECMA-402 or an ES addition',
      )
    })

    test('an entry on anything but an ECMAScript intrinsic, or whose kind and descriptor disagree, is refused', () => {
      expect(() =>
        generateWith({ ecma262: clauses, proseProperties: { 'Map.prototype.size': prose['String.prototype.length'] } }),
      ).toThrow('the ECMA-262 prose property Map.prototype.size is not on an ECMAScript intrinsic')
      const mismatched = { ...prose['Function.prototype.caller'], kind: 'function' } as const
      expect(() =>
        generateWith({ ecma262: clauses, proseProperties: { 'Function.prototype.caller': mismatched } }),
      ).toThrow('the ECMA-262 prose property Function.prototype.caller has kind function, but an accessor descriptor')
    })

    test('an engine extension for one of them is refused, as for any property ECMA-262 defines', () => {
      const engine = { engine: 'v8', ...prose['String.prototype.length'] }

      expect(() =>
        generateWith({
          ecma262: clauses,
          proseProperties: prose,
          engineExtensions: { 'String.prototype.length': engine },
        }),
      ).toThrow(
        'the engine extension String.prototype.length is already defined by ECMA-262, ECMA-402 or an ES addition',
      )
    })
  })

  test('reads only the built-in objects’ clauses, and only titles that name a property', () => {
    const { targets, holders } = generateWith({
      ecma262: [
        clause('10.2.4.1', '%ThrowTypeError% ( )'),
        clause('14.7.5.10.2.1', '%ForInIteratorPrototype%.next ( )'),
        clause('20.2.4.1', 'length'),
        clause('20.5.5.1', 'EvalError'),
        { ...clause('23.1.3.4.1', 'FindViaPredicate ( O, len, direction, predicate, thisArg )'), aoid: 'FindViaPredicate' },
        clause('27.1', 'Iteration'),
        clause('28.3.1', '%Symbol.toStringTag%'),
        clause('29.1', 'Races'),
        clause('B.1.1', 'HTML-like Comments'),
      ],
    })
    const skeletonOnly = generateWith({})

    expect(targets).toEqual(skeletonOnly.targets)
    expect(holders).toEqual(skeletonOnly.holders)
  })

  test('a property on something that is neither a global property nor an intrinsic is refused', () => {
    expect(() => generateWith({ ecma262: [clause('20.9.1', 'Temporal.Now.instant ( )')] })).toThrow(
      'Temporal.Now.instant starts from Temporal, which is neither a global property nor an intrinsic',
    )
  })

  test('an intrinsic no global property names must be reviewed before it enters the catalog', () => {
    expect(() => generateWith({ ecma262: [clause('27.1.9.1', '%SomeNewIteratorPrototype%.next ( )')] })).toThrow(
      '%SomeNewIteratorPrototype% is an intrinsic no global property names, and it is not reviewed',
    )
  })

  test('a property defined both as a function and as another kind is refused', () => {
    expect(() =>
      generateWith({
        ecma262: [clause('19.4.1', 'Math'), clause('21.3.1.6', 'Math.PI'), clause('21.3.2.99', 'Math.PI ( )')],
      }),
    ).toThrow('Math.PI is defined both as a value and as a function')
  })

  test('an ECMAScript intrinsic may not share its name with a Web IDL target or holder', () => {
    expect(() =>
      generateWith({
        ecma262: [clause('19.4.1', 'JSON'), clause('25.5.2', 'JSON.parse ( text [ , reviver ] )')],
        idl: { fake: '[Exposed=Window] namespace JSON { undefined parse(); };' },
      }),
    ).toThrow('Window.JSON is both a Web IDL target and an ECMAScript intrinsic (window)')
    expect(() =>
      generateWith({
        ecma262: [clause('19.3.3', 'WeakRef ( . . . )'), clause('26.1.2.1', 'WeakRef.prototype')],
        idl: { fake: '[LegacyNoInterfaceObject, Exposed=Window] interface WeakRef {};' },
      }),
    ).toThrow('WeakRef.prototype is both a Web IDL holder and an ECMAScript intrinsic (window)')
  })

  test('refuses a Web IDL chain that ends in an intrinsic the ECMAScript sources lack', () => {
    expect(() => generateWith({ idl: { dom: '[Exposed=*] interface DOMException {};' } })).toThrow(
      'the prototype of DOMException.prototype, Error.prototype, is not a holder in window',
    )
  })

  test('the catalog is the same whatever order the clauses arrive in', () => {
    const ecma262 = [
      clause('19.3.3', 'Map ( . . . )'),
      clause('24.1.2.2', 'Map.prototype'),
      clause('24.1.3.9', 'Map.prototype.get ( key )'),
      clause('20.1.3.8', 'Object.prototype.__proto__'),
      clause('20.1.3.8.1', 'get Object.prototype.__proto__'),
      clause('20.1.3.8.2', 'set Object.prototype.__proto__'),
    ]
    const forwards = generateWith({ ecma262 })
    const backwards = generateWith({ ecma262: [...ecma262].reverse() })

    expect(JSON.stringify(backwards)).toBe(JSON.stringify(forwards))
    expect(forwards.targets.window['Object.prototype.__proto__'].descriptor).toMatchObject({ setter: true })
  })

  test('a getter and a setter define one accessor, whatever clause groups them', () => {
    const { window } = generateWith({
      ecma262: [
        clause('20.1.3.8', 'Object.prototype.__proto__'),
        clause('20.1.3.8.1', 'get Object.prototype.__proto__'),
        clause('20.1.3.8.2', 'set Object.prototype.__proto__'),
        clause('19.3.4', 'String ( . . . )'),
        clause('22.1.3.1', 'String.prototype'),
        clause('22.1.3.2', 'get String.prototype.size'),
      ],
    }).targets

    expect(window['Object.prototype.__proto__']).toMatchObject({
      owner: 'Object',
      member: '__proto__',
      holder: 'prototype',
      kind: 'accessor',
    })
    expect(Object.keys(window).filter((name) => name.includes('__proto__'))).toEqual(['Object.prototype.__proto__'])
    expect(window['String.prototype.size']).toMatchObject({ kind: 'accessor' })
  })
})

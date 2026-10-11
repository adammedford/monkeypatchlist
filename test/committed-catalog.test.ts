import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, test } from 'vitest'
import {
  loadCatalog,
  realms,
  surfaces,
  type CatalogHolder,
  type CatalogTarget,
  type EngineExtension,
  type EsAddition,
  type Exclusion,
  type InstanceMember,
  type ProtectedEntry,
  type Realm,
  type Singleton,
} from '../src/index.ts'
import { canonicalJson } from '../tools/catalog-generator/canonical-json.ts'
import { readCommitted } from '../tools/catalog-generator/committed.ts'
import { crossCheck, crossCheckProblems } from '../tools/catalog-generator/cross-check.ts'
import { loadCrossCheckSources } from '../tools/catalog-generator/cross-check-sources.ts'
import { check } from '../tools/catalog-generator/generate.ts'
import { loadUpstream } from '../tools/catalog-generator/upstream.ts'

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const committed = { catalog: read('catalog/catalog.json'), targetDiff: read('catalog/target-diff.md') }
const catalog = JSON.parse(committed.catalog)
const validate = new Ajv2020({ allErrors: true, strict: true }).compile(JSON.parse(read('catalog/catalog.schema.json')))

/** The realms whose targets include `name`, in the catalog's realm order. */
const realmsWith = (name: string) => realms.filter((realm) => name in catalog.targets[realm])

/** Each worker realm, with the interface of its global. */
const workerGlobals = [
  ['dedicated-worker', 'DedicatedWorkerGlobalScope'],
  ['shared-worker', 'SharedWorkerGlobalScope'],
  ['service-worker', 'ServiceWorkerGlobalScope'],
] as const

/** The owners of the targets listed in `realm`. */
const ownersIn = (realm: Realm) =>
  new Set(Object.values(catalog.targets[realm]).map((target) => (target as CatalogTarget).owner))

describe('committed catalog', () => {
  test('is exactly what the generator writes from the pinned upstreams, with the diff from the catalog it names', async () => {
    expect(check({ ...(await loadUpstream()), ...(await readCommitted()) })).toEqual([])
  })

  test('validates against the catalog JSON Schema', () => {
    const valid = validate(catalog)

    expect(validate.errors).toBeNull()
    expect(valid).toBe(true)
  })

  test('the schema rejects a target without a holder, a realm it does not know, and a section it does not know', () => {
    const withoutHolder = { ...catalog.targets.window['Window.fetch'] }
    delete withoutHolder.holder

    expect(validate({ ...catalog, targets: { ...catalog.targets, window: { 'Window.fetch': withoutHolder } } })).toBe(
      false,
    )
    expect(validate({ ...catalog, targets: { ...catalog.targets, 'audio-worklet': {} } })).toBe(false)
    expect(validate({ ...catalog, overrides: {} })).toBe(false)
  })

  test('the schema rejects holds on a member target, and a per-instance member that is no operation or attribute', () => {
    const withHolds = { ...catalog.targets.window['Window.fetch'], holds: 'console' }
    const constant = { owner: 'Location', member: 'X', kind: 'constant', spec: 'html' }

    expect(validate({ ...catalog, targets: { ...catalog.targets, window: { 'Window.fetch': withHolds } } })).toBe(false)
    expect(
      validate({ ...catalog, instanceMembers: { ...catalog.instanceMembers, window: { Location: { X: constant } } } }),
    ).toBe(false)
  })

  test('records the catalog version, the exact pins from package.json, and a sha256 pin of every overlay file', () => {
    const { devDependencies, dependencies = {} } = JSON.parse(read('package.json'))
    const upstreams = ['@webref/idl', 'webidl2', '@tc39/ecma262-biblio', '@tc39/ecma402-biblio']
    const overlayFiles = readdirSync(new URL('../tools/catalog-generator/overlays/', import.meta.url))

    for (const name of upstreams) {
      expect(devDependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/)
      expect(dependencies).not.toHaveProperty(name)
    }
    expect(catalog.metadata.upstream).toEqual(Object.fromEntries(upstreams.map((name) => [name, devDependencies[name]])))
    expect(catalog.metadata.catalogVersion).toBe(JSON.parse(read('tools/catalog-generator/catalog-version.json')).catalogVersion)
    expect(Number.isSafeInteger(catalog.metadata.catalogVersion) && catalog.metadata.catalogVersion > 0).toBe(true)
    expect(overlayFiles).toEqual(expect.arrayContaining(['es-additions.json', 'protected-surface.json', 'retained.json']))
    expect(catalog.metadata.overlays).toEqual(
      Object.fromEntries(
        overlayFiles.map((file) => [
          file,
          createHash('sha256').update(readFileSync(new URL(`../tools/catalog-generator/overlays/${file}`, import.meta.url))).digest('hex'),
        ]),
      ),
    )
  })

  test('merges mixins from their partials: fetch reaches Window through WindowOrWorkerGlobalScope', () => {
    expect(catalog.targets.window['Window.fetch']).toEqual({
      owner: 'Window',
      member: 'fetch',
      holder: 'global',
      kind: 'operation',
      spec: 'fetch',
      mixin: 'WindowOrWorkerGlobalScope',
      descriptor: { type: 'data', writable: true, enumerable: true, configurable: true },
      surface: 'networking',
    })
  })

  test('lists targets per realm: History only in window, WorkerGlobalScope in every worker realm but not window', () => {
    expect(realmsWith('History.prototype.pushState')).toEqual(['window'])
    expect(realmsWith('WorkerGlobalScope.prototype.importScripts')).toEqual([
      'dedicated-worker',
      'shared-worker',
      'service-worker',
    ])
    expect(ownersIn('window')).toContain('History')
    expect(ownersIn('window')).not.toContain('WorkerGlobalScope')
    for (const realm of ['dedicated-worker', 'shared-worker', 'service-worker'] as const) {
      expect(ownersIn(realm)).not.toContain('History')
      expect(ownersIn(realm)).toContain('WorkerGlobalScope')
    }
  })

  test('XMLHttpRequest is in window, dedicated-worker and shared-worker, but not service-worker', () => {
    expect(realmsWith('XMLHttpRequest.prototype.open')).toEqual(['window', 'dedicated-worker', 'shared-worker'])
    expect(ownersIn('service-worker')).not.toContain('XMLHttpRequest')
    expect(realmsWith('XMLHttpRequest.prototype.responseXML')).toEqual(['window'])
  })

  test('the same name in several realms is a separate target in each: fetch on WorkerGlobalScope', () => {
    const inDedicatedWorker = catalog.targets['dedicated-worker']['WorkerGlobalScope.prototype.fetch']

    expect(inDedicatedWorker).toMatchObject({ owner: 'WorkerGlobalScope', mixin: 'WindowOrWorkerGlobalScope' })
    expect(catalog.targets['service-worker']['WorkerGlobalScope.prototype.fetch']).toEqual(inDedicatedWorker)
    expect(catalog.targets.window['WorkerGlobalScope.prototype.fetch']).toBeUndefined()
  })

  test('Window.fetch is an own member of the window global; in worker realms fetch is WorkerGlobalScope.prototype.fetch', () => {
    expect(catalog.targets.window['Window.fetch']).toMatchObject({ holder: 'global' })
    expect(catalog.targets.window['Window.setTimeout']).toMatchObject({ holder: 'global' })
    expect(catalog.targets.window).not.toHaveProperty(['Window.prototype.fetch'])
    for (const [realm, global] of workerGlobals) {
      expect(catalog.targets[realm]['WorkerGlobalScope.prototype.fetch']).toMatchObject({ holder: 'prototype' })
      expect(catalog.targets[realm]).not.toHaveProperty([`${global}.fetch`])
    }
  })

  test('EventTarget.prototype.addEventListener and History.prototype.pushState are prototype targets', () => {
    for (const realm of realms) {
      expect(catalog.targets[realm]['EventTarget.prototype.addEventListener']).toMatchObject({ holder: 'prototype' })
    }
    expect(catalog.targets.window['History.prototype.pushState']).toMatchObject({
      owner: 'History',
      holder: 'prototype',
    })
  })

  test('[LegacyUnforgeable] members are per-instance: Window.location on the global, Location.href on each instance', () => {
    for (const member of ['location', 'document', 'top', 'window']) {
      expect(catalog.targets.window[`Window.${member}`]).toMatchObject({ holder: 'global', kind: 'attribute' })
      expect(catalog.targets.window).not.toHaveProperty([`Window.prototype.${member}`])
    }
    const unforgeable = Object.entries<{ kind: string }>(catalog.instanceMembers.window.Location)
      .filter(([, { kind }]) => kind === 'operation' || kind === 'attribute')
      .map(([name]) => name)
    expect(unforgeable.sort()).toEqual([
      'ancestorOrigins',
      'assign',
      'hash',
      'host',
      'hostname',
      'href',
      'origin',
      'pathname',
      'port',
      'protocol',
      'reload',
      'replace',
      'search',
      // The unforgeable stringifier's toString.
      'toString',
    ])
    expect(catalog.instanceMembers.window.Document.location).toMatchObject({ owner: 'Document', kind: 'attribute' })
    for (const realm of realms) {
      expect(catalog.instanceMembers[realm].Event.isTrusted).toMatchObject({ owner: 'Event' })
      expect(catalog.targets[realm]).not.toHaveProperty(['Event.prototype.isTrusted'])
    }
    expect(catalog.targets.window).not.toHaveProperty(['Location.prototype.href'])
    expect(catalog.targets.window).not.toHaveProperty(['Document.prototype.location'])
  })

  test('statics and constants are on the interface object, and constants on the interface prototype object too', () => {
    expect(catalog.targets.window['URL.createObjectURL']).toMatchObject({ holder: 'constructor', kind: 'operation' })
    expect(catalog.targets.window['Response.json']).toMatchObject({ holder: 'constructor', kind: 'operation' })
    expect(catalog.targets.window['Response.prototype.json']).toMatchObject({ holder: 'prototype' })
    expect(catalog.targets.window['Node.ELEMENT_NODE']).toMatchObject({ holder: 'constructor', kind: 'constant' })
    expect(catalog.targets.window['Node.prototype.ELEMENT_NODE']).toMatchObject({ holder: 'prototype' })
    expect(catalog.targets.window['NodeFilter.SHOW_ALL']).toMatchObject({ holder: 'constructor' })
  })

  test('interface objects are constructor holders reached from the global', () => {
    expect(catalog.targets.window['Window.XMLHttpRequest']).toEqual({
      owner: 'Window',
      member: 'XMLHttpRequest',
      holder: 'global',
      kind: 'interface',
      holds: 'XMLHttpRequest',
      spec: 'xhr',
      descriptor: { type: 'data', writable: true, enumerable: false, configurable: true },
      surface: 'networking',
    })
    expect(catalog.holders.window.XMLHttpRequest).toEqual({
      kind: 'constructor',
      owner: 'XMLHttpRequest',
      proto: 'XMLHttpRequestEventTarget',
    })
    expect(catalog.targets['dedicated-worker']['DedicatedWorkerGlobalScope.XMLHttpRequest']).toMatchObject({
      holds: 'XMLHttpRequest',
    })
    expect(catalog.targets['service-worker']).not.toHaveProperty(['ServiceWorkerGlobalScope.XMLHttpRequest'])
    // A constructor or namespace is held by one property of the global or of a namespace, named by its name, besides
    // any [LegacyWindowAlias] names. The intrinsics no global property reaches (`%TypedArray%`) are held by
    // none.
    const aliases = new Set(['Window.webkitURL', 'Window.SVGMatrix', 'Window.WebKitCSSMatrix', 'Window.SVGPoint', 'Window.SVGRect'])
    for (const realm of realms) {
      const held = Object.entries(catalog.targets[realm] as Record<string, CatalogTarget>)
        .filter(([name, { holder }]) => (holder === 'global' || holder === 'namespace') && !aliases.has(name))
        .map(([, { holds }]) => holds)
      for (const [name, { kind }] of Object.entries(catalog.holders[realm] as Record<string, CatalogHolder>)) {
        if (kind !== 'constructor' && kind !== 'namespace') continue
        expect(held.filter((holds) => holds === name)).toEqual(name.startsWith('%') ? [] : [name])
      }
    }
  })

  test('IDL namespaces, and the properties holding [LegacyNamespace] interface objects, have holder namespace', () => {
    expect(catalog.holders.window.console).toEqual({ kind: 'namespace', owner: 'console', proto: 'console.[[Prototype]]' })
    expect(catalog.targets.window['Window.console']).toMatchObject({ holder: 'global', holds: 'console' })
    expect(catalog.targets.window['console.log']).toMatchObject({ holder: 'namespace' })
    expect(catalog.targets.window['CSS.supports']).toMatchObject({ holder: 'namespace' })
    expect(catalog.targets.window['WebAssembly.Module']).toMatchObject({
      holder: 'namespace',
      kind: 'interface',
      holds: 'WebAssembly.Module',
    })
    expect(catalog.holders.window['WebAssembly.Module']).toMatchObject({ kind: 'constructor' })
    expect(catalog.targets.window).not.toHaveProperty(['Window.Module'])
  })

  test('[LegacyNamespace] interfaces are named by their qualified path from the namespace', () => {
    for (const realm of realms) {
      expect(catalog.targets[realm]['WebAssembly.Module.exports']).toMatchObject({ holder: 'constructor' })
      expect(catalog.targets[realm]['WebAssembly.Memory.prototype.grow']).toMatchObject({ holder: 'prototype' })
      expect(catalog.holders[realm]['WebAssembly.Memory.prototype']).toEqual({
        kind: 'prototype',
        owner: 'Memory',
        proto: 'Object.prototype',
      })
      expect(catalog.targets[realm]).not.toHaveProperty(['Module.exports'])
      expect(catalog.targets[realm]).not.toHaveProperty(['Memory.prototype.grow'])
      expect(catalog.holders[realm]).not.toHaveProperty(['Memory.prototype'])
    }
  })

  test('WindowProperties is on the window chain, with no own members, and absent from worker realms', () => {
    const chain = (realm: Realm, from: string) => {
      const names = [from]
      for (let next = catalog.holders[realm][from]?.proto; next; next = catalog.holders[realm][next]?.proto) {
        names.push(next)
      }
      return names
    }

    expect(chain('window', 'Window')).toEqual([
      'Window',
      'Window.prototype',
      'WindowProperties',
      'EventTarget.prototype',
      'Object.prototype',
    ])
    expect(catalog.holders.window.WindowProperties).toEqual({
      kind: 'prototype',
      owner: 'Window',
      proto: 'EventTarget.prototype',
      immutablePrototype: true,
    })
    expect(Object.keys(catalog.targets.window).filter((name) => name.startsWith('WindowProperties.'))).toEqual([])
    for (const [realm, global] of workerGlobals) {
      expect(chain(realm, global)).toEqual([
        global,
        `${global}.prototype`,
        'WorkerGlobalScope.prototype',
        'EventTarget.prototype',
        'Object.prototype',
      ])
      expect(catalog.holders[realm]).not.toHaveProperty('WindowProperties')
    }
  })

  test("every target is on a holder of its realm, of the target's holder kind, and every link names a holder", () => {
    for (const realm of realms) {
      const holders = catalog.holders[realm] as Record<string, CatalogHolder>
      for (const [name, target] of Object.entries(catalog.targets[realm] as Record<string, CatalogTarget>)) {
        const holder = name.slice(0, -(target.member.length + 1))
        expect(`${holder}.${target.member}`).toBe(name)
        expect({ name, kind: holders[holder]?.kind }).toEqual({ name, kind: target.holder })
        if (target.holds) expect(holders).toHaveProperty([target.holds])
      }
      for (const { proto } of Object.values(holders)) if (proto) expect(holders).toHaveProperty([proto])
    }
  })

  test('the committed target diff shows the realm and holder kind of each target', () => {
    // Checks every target line rather than particular ones: the diff lists only the last bump's changes.
    const shape = new RegExp(
      `^- \`[^\`]+\` \\((${realms.join('|')}), (global|constructor|prototype|instance|namespace)\\)` +
        '( \\[sign-off: (protected|excluded|protected, excluded)\\])?(: (dropped|excluded): .+)?$',
    )
    const addedAndRemoved = committed.targetDiff.split('\n## Added holders (')[0] ?? ''
    const lines = addedAndRemoved.split('\n').filter((line) => line.startsWith('- `'))

    expect(lines.filter((line) => !shape.test(line))).toEqual([])
  })

  test('the committed target diff lists holder additions with the realm and kind of each holder', () => {
    const shape = new RegExp(
      `^- \`[^\`]+\` \\((${realms.join('|')}), (global|constructor|prototype|instance|namespace) holder\\)$`,
    )
    const addedHolders = committed.targetDiff.split('\n## Added holders (')[1]?.split('\n## Removed holders (')[0]
    const lines = (addedHolders ?? '').split('\n').filter((line) => line.startsWith('- '))

    expect(addedHolders).toBeDefined()
    expect(lines.filter((line) => !shape.test(line))).toEqual([])
  })

  test('the committed target diff lists holder removals with the realm and kind of each holder, and why it left', () => {
    const shape = new RegExp(
      `^- \`[^\`]+\` \\((${realms.join('|')}), (global|constructor|prototype|instance|namespace) holder\\)` +
        '( \\[sign-off: excluded\\])?(: (dropped|excluded): .+)?$',
    )
    const removedHolders = committed.targetDiff.split('\n## Removed holders (')[1]?.split('\n## Retained (')[0]
    const lines = (removedHolders ?? '').split('\n').filter((line) => line.startsWith('- '))

    expect(removedHolders).toBeDefined()
    expect(lines.filter((line) => !shape.test(line))).toEqual([])
  })

  test('keeps a member named __proto__ through serialization and parsing', () => {
    // ECMAScript's `Object.prototype.__proto__` is a target. No per-instance member is named `__proto__`, and IDL
    // cannot declare one, so the test adds one to the section keyed by member name.
    const member = {
      owner: 'Object',
      member: '__proto__',
      kind: 'attribute',
      spec: 'ecma262',
      descriptor: { type: 'accessor', setter: true, enumerable: false, configurable: true },
      assign: 'setter',
      surface: 'other',
    }
    const withProto = structuredClone(catalog)
    withProto.instanceMembers.window.Object = { ['__proto__']: member }

    expect(catalog.targets.window['Object.prototype.__proto__']).toMatchObject({ member: '__proto__' })

    const text = canonicalJson(withProto)
    const parsed = JSON.parse(text)

    expect(text).toContain('"__proto__": {')
    expect(Object.hasOwn(parsed.instanceMembers.window.Object, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(parsed.instanceMembers.window.Object)).toBe(Object.prototype)
    expect(parsed.instanceMembers.window.Object['__proto__']).toEqual(member)
    expect(parsed.targets.window['Object.prototype.__proto__'].member).toBe('__proto__')
    expect(canonicalJson(parsed)).toBe(text)
    expect(validate(parsed)).toBe(true)
  })

  test('is what the runtime loads', () => {
    expect(loadCatalog()).toEqual(catalog)
  })
})

describe('committed catalog: ECMAScript intrinsics', () => {
  const globals = {
    window: 'Window',
    'dedicated-worker': 'DedicatedWorkerGlobalScope',
    'shared-worker': 'SharedWorkerGlobalScope',
    'service-worker': 'ServiceWorkerGlobalScope',
  } as const
  const writable = { type: 'data', writable: true, enumerable: false, configurable: true }
  const readonly = { type: 'data', writable: false, enumerable: false, configurable: false }

  test('every realm has its own Promise, Promise.allSettled, Array.prototype.@@iterator, Object.prototype.__proto__, JSON.parse, Math.PI and Intl.DateTimeFormat', () => {
    for (const realm of realms) {
      const targets = catalog.targets[realm]
      expect(targets[`${globals[realm]}.Promise`], realm).toMatchObject({ holder: 'global', holds: 'Promise' })
      expect(targets['Promise.allSettled'], realm).toMatchObject({ holder: 'constructor', kind: 'function' })
      expect(targets['Array.prototype.@@iterator'], realm).toMatchObject({ holder: 'prototype', kind: 'function' })
      expect(targets['Object.prototype.__proto__'], realm).toMatchObject({ holder: 'prototype', kind: 'accessor' })
      expect(targets['JSON.parse'], realm).toMatchObject({ holder: 'namespace', kind: 'function' })
      expect(targets['Math.PI'], realm).toMatchObject({ holder: 'namespace', kind: 'value' })
      expect(targets['Intl.DateTimeFormat'], realm).toMatchObject({ holder: 'namespace', holds: 'Intl.DateTimeFormat' })
    }
  })

  test('Math, JSON, Reflect, Atomics and Intl are namespace holders on the global object', () => {
    for (const realm of realms) {
      for (const namespace of ['Math', 'JSON', 'Reflect', 'Atomics', 'Intl']) {
        expect(catalog.holders[realm][namespace], `${namespace} (${realm})`).toMatchObject({ kind: 'namespace' })
        expect(catalog.targets[realm][`${globals[realm]}.${namespace}`], realm).toMatchObject({
          holder: 'global',
          kind: 'namespace',
          holds: namespace,
        })
      }
    }
  })

  test('functions are writable, non-enumerable and configurable', () => {
    const functions = ['Promise.allSettled', 'Array.prototype.map', 'Array.prototype.@@iterator', 'JSON.parse']
    for (const realm of realms) {
      for (const name of [...functions, `${globals[realm]}.Promise`, `${globals[realm]}.parseInt`]) {
        expect(catalog.targets[realm][name].descriptor, `${name} (${realm})`).toEqual(writable)
      }
    }
  })

  test('Math.PI and the global NaN, Infinity and undefined are non-writable and non-configurable', () => {
    for (const realm of realms) {
      for (const name of ['Math.PI', ...['NaN', 'Infinity', 'undefined'].map((key) => `${globals[realm]}.${key}`)]) {
        expect(catalog.targets[realm][name].descriptor, `${name} (${realm})`).toEqual(readonly)
      }
    }
  })

  test('Object.prototype carries immutablePrototype in every realm, and ends every prototype chain', () => {
    for (const realm of realms) {
      expect(catalog.holders[realm]['Object.prototype']).toEqual({
        kind: 'prototype',
        owner: 'Object',
        proto: null,
        immutablePrototype: true,
      })
      expect(catalog.holders[realm]['Array.prototype']).toMatchObject({ proto: 'Object.prototype' })
    }
  })

  test('Web IDL chains end in the realm’s intrinsics, and every chain ends at Object.prototype', () => {
    for (const realm of realms) {
      const holders = catalog.holders[realm] as Record<string, CatalogHolder>
      expect(holders['EventTarget.prototype'], realm).toMatchObject({ proto: 'Object.prototype' })
      expect(holders.EventTarget, realm).toMatchObject({ proto: 'Function.prototype' })
      expect(holders.console, realm).toMatchObject({ proto: 'console.[[Prototype]]' })
      expect(holders['console.[[Prototype]]'], realm).toMatchObject({ proto: 'Object.prototype' })
      expect(holders['DOMException.prototype'], realm).toMatchObject({ proto: 'Error.prototype' })
      for (const name of Object.keys(holders)) {
        const seen = [name]
        for (let next = holders[name]?.proto; next; next = holders[next]?.proto) {
          expect(seen, `${name} (${realm})`).not.toContain(next)
          seen.push(next)
        }
        expect(seen.at(-1), `${name} (${realm})`).toBe('Object.prototype')
      }
    }
    expect(catalog.holders.window.WindowProperties).toMatchObject({ proto: 'EventTarget.prototype' })
  })

  test('Temporal comes from the curated ES additions overlay, not from ECMA-262', () => {
    const overlay = JSON.parse(read('tools/catalog-generator/overlays/es-additions.json'))
    const temporal = (name: string) => name === 'Window.Temporal' || name.startsWith('Temporal.')
    const temporalTargets = Object.entries(catalog.targets.window).filter(([name]) => temporal(name))

    expect(catalog.esAdditions).toEqual(overlay)
    expect(catalog.esAdditions.Temporal.spec).toBe('proposal-temporal')
    expect(catalog.targets.window['Temporal.PlainDate.prototype.add']).toMatchObject({ holder: 'prototype' })
    expect(temporalTargets.length).toBeGreaterThan(200)
    for (const [name, target] of temporalTargets) expect((target as CatalogTarget).spec, name).toBe('proposal-temporal')
  })

  describe('engine extensions come from a curated overlay beside the ES additions', () => {
    const overlay = JSON.parse(read('tools/catalog-generator/overlays/engine-extensions.json'))

    test('it lists exactly Error.stackTraceLimit and Error.captureStackTrace, each from V8, and the catalog keeps it', () => {
      expect(Object.keys(overlay).sort()).toEqual(['Error.captureStackTrace', 'Error.stackTraceLimit'])
      for (const [name, entry] of Object.entries<EngineExtension>(overlay)) {
        expect(entry.engine, name).toBe('v8')
        expect(entry.source, name).toMatch(/^V8 \d+\.\d+/)
      }
      expect(catalog.engineExtensions).toEqual(overlay)
    })

    test('both are native members of the Error constructor in every realm, with V8’s descriptors', () => {
      for (const realm of realms) {
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

    test('their descriptors are the ones the V8 running these tests gives a fresh context, which has no own Error.prepareStackTrace', () => {
      // A fresh context has only what V8 defines: Node's own bootstrap adds Error.prepareStackTrace to its main context.
      const inV8 = runInNewContext(
        'Object.fromEntries(Object.getOwnPropertyNames(Error).map((key) => [key, Object.getOwnPropertyDescriptor(Error, key)]))',
      ) as Record<string, PropertyDescriptor>
      const kindOf = ({ value, get, set }: PropertyDescriptor) =>
        get || set ? 'accessor' : typeof value === 'function' ? 'function' : 'value'

      for (const [name, entry] of Object.entries<EngineExtension>(overlay)) {
        const own = inV8[name.slice('Error.'.length)]
        expect(own, name).toBeDefined()
        const { writable, enumerable, configurable } = own!
        expect(entry.kind, name).toBe(kindOf(own!))
        expect(entry.descriptor, name).toEqual({ type: 'data', writable, enumerable, configurable })
      }
      expect(Object.keys(inV8)).not.toContain('prepareStackTrace')
    })

    test('Error.prepareStackTrace stays out: V8 does not define it, so writing it is an add', () => {
      for (const realm of realms) expect(catalog.targets[realm], realm).not.toHaveProperty(['Error.prepareStackTrace'])
    })
  })

  test('the schema rejects an accessor descriptor that claims writable, and a holder without a kind', () => {
    const withAccessor = (descriptor: object) => ({
      ...catalog,
      targets: {
        ...catalog.targets,
        window: { 'Map.prototype.size': { ...catalog.targets.window['Map.prototype.size'], descriptor } },
      },
    })
    const accessor = { type: 'accessor', setter: false, enumerable: false, configurable: true }
    const kindless = { ...catalog.holders.window.Math }
    delete kindless.kind

    expect(validate(withAccessor(accessor))).toBe(true)
    expect(validate(withAccessor({ ...accessor, writable: true }))).toBe(false)
    expect(validate({ ...catalog, holders: { ...catalog.holders, window: { Math: kindless } } })).toBe(false)
  })

  test('every intrinsic target has a descriptor, sits on a listed holder, and holds only listed holders', () => {
    // An intrinsic is told apart by the spec it comes from, not by its descriptor, so a missing descriptor fails.
    const additions = Object.values<{ spec: string }>(catalog.esAdditions).map(({ spec }) => spec)
    const engines = Object.values<{ engine: string }>(catalog.engineExtensions).map(({ engine }) => engine)
    const esSpecs = new Set(['ecma262', 'ecma402', ...additions, ...engines])
    for (const realm of realms) {
      const holders = catalog.holders[realm]
      const intrinsics = Object.entries(catalog.targets[realm] as Record<string, CatalogTarget>).filter(([, target]) =>
        esSpecs.has(target.spec),
      )
      expect(intrinsics.length).toBeGreaterThan(1000)
      for (const [name, target] of intrinsics) {
        expect(target.descriptor, name).toBeDefined()
        if (target.holder !== 'global') expect(holders[name.slice(0, -target.member.length - 1)], name).toBeDefined()
        if (target.holds) expect(holders[target.holds], name).toBeDefined()
      }
      for (const [name, holder] of Object.entries(holders as Record<string, CatalogHolder>)) {
        if (holder.proto) expect(holders[holder.proto], name).toBeDefined()
      }
    }
  })
})

describe('committed catalog: member data', () => {
  const method = { type: 'data', writable: true, enumerable: true, configurable: true }
  const accessor = (setter: boolean, configurable = true) => ({
    type: 'accessor',
    setter,
    enumerable: true,
    configurable,
  })

  test('operations are writable, enumerable, configurable data properties', () => {
    for (const realm of realms) {
      expect(catalog.targets[realm]['EventTarget.prototype.addEventListener'].descriptor, realm).toEqual(method)
    }
    expect(catalog.targets.window['URL.createObjectURL'].descriptor).toEqual(method)
    expect(catalog.targets.window['Window.fetch'].descriptor).toEqual(method)
    expect(catalog.targets.window['console.log'].descriptor).toEqual(method)
    expect(catalog.targets['dedicated-worker']['WorkerGlobalScope.prototype.fetch'].descriptor).toEqual(method)
  })

  test('regular attributes are configurable accessors, with a setter unless they are readonly', () => {
    expect(catalog.targets.window['Document.prototype.title'].descriptor).toEqual(accessor(true))
    expect(catalog.targets.window['Navigator.prototype.userAgent'].descriptor).toEqual(accessor(false))
    expect(catalog.targets.window['Window.name'].descriptor).toEqual(accessor(true))
    expect(catalog.targets.window['Window.length'].descriptor).toEqual(accessor(true))
  })

  test('[LegacyUnforgeable] members are non-configurable, on the global and on each instance', () => {
    expect(catalog.targets.window['Window.location'].descriptor).toEqual(accessor(true, false))
    for (const member of ['document', 'top', 'window']) {
      expect(catalog.targets.window[`Window.${member}`].descriptor, member).toEqual(accessor(false, false))
    }
    expect(catalog.instanceMembers.window.Location.href.descriptor).toEqual(accessor(true, false))
    expect(catalog.instanceMembers.window.Location.reload.descriptor).toEqual({
      type: 'data',
      writable: false,
      enumerable: true,
      configurable: false,
    })
    for (const realm of realms) {
      expect(catalog.instanceMembers[realm].Event.isTrusted.descriptor, realm).toEqual(accessor(false, false))
    }
  })

  test('constants are non-writable and non-configurable: Node.ELEMENT_NODE', () => {
    const constant = { type: 'data', writable: false, enumerable: true, configurable: false }

    expect(catalog.targets.window['Node.ELEMENT_NODE'].descriptor).toEqual(constant)
    expect(catalog.targets.window['Node.prototype.ELEMENT_NODE'].descriptor).toEqual(constant)
    expect(catalog.targets.window['NodeFilter.SHOW_ALL'].descriptor).toEqual(constant)
  })

  test('the properties holding interface and namespace objects are writable, non-enumerable and configurable', () => {
    const hidden = { type: 'data', writable: true, enumerable: false, configurable: true }

    for (const name of ['Window.XMLHttpRequest', 'Window.console', 'Window.NodeFilter', 'WebAssembly.Module']) {
      expect(catalog.targets.window[name].descriptor, name).toEqual(hidden)
    }
  })

  test('assign kinds are right on known cases', () => {
    const assignOf = (name: string, realm: Realm = 'window') => catalog.targets[realm][name].assign

    expect(assignOf('Document.prototype.title')).toBe('setter')
    expect(assignOf('Window.location')).toBe('put-forwards')
    expect(assignOf('Window.onerror')).toBe('event-handler')
    expect(assignOf('WorkerGlobalScope.prototype.onerror', 'dedicated-worker')).toBe('event-handler')
    expect(assignOf('Window.length')).toBe('replaceable')
    expect(assignOf('Document.prototype.fullscreen')).toBe('lenient-setter')
    expect(assignOf('Navigator.prototype.userAgent')).toBe('readonly')
    expect(assignOf('WorkerNavigator.prototype.userAgent', 'service-worker')).toBe('readonly')
    expect(catalog.instanceMembers.window.Location.href.assign).toBe('setter')
  })

  test('every Web IDL target has a descriptor, every attribute an assign kind and an accessor, and nothing else an assign kind', () => {
    const members = (realm: Realm) => [
      ...Object.entries(catalog.targets[realm] as Record<string, CatalogTarget>),
      ...Object.values(catalog.instanceMembers[realm] as Record<string, Record<string, CatalogTarget>>).flatMap(
        (named) => Object.entries(named),
      ),
    ]
    for (const realm of realms) {
      for (const [name, target] of members(realm)) {
        expect(target.descriptor, name).toBeDefined()
        if (target.kind === 'attribute') {
          expect(target.assign, name).toBeDefined()
          expect(target.descriptor?.type, name).toBe('accessor')
          expect(target.descriptor, name).toMatchObject({ setter: target.assign !== 'readonly' })
        } else {
          expect(target, name).not.toHaveProperty('assign')
        }
      }
    }
  })

  test('immutablePrototype is set on the global, WindowProperties, the prototypes of the global chain and the location singleton, in each realm', () => {
    const immutableIn = (realm: Realm) =>
      Object.keys(catalog.holders[realm])
        .filter((name) => catalog.holders[realm][name].immutablePrototype)
        .sort()

    expect(immutableIn('window')).toEqual([
      'EventTarget.prototype',
      'Object.prototype',
      'Window',
      'Window.prototype',
      'WindowProperties',
      'location',
    ])
    for (const [realm, global] of workerGlobals) {
      expect(immutableIn(realm)).toEqual(
        [global, `${global}.prototype`, 'WorkerGlobalScope.prototype', 'EventTarget.prototype', 'Object.prototype'].sort(),
      )
    }
  })

  test('Location instances carry immutablePrototype, in the window realm, where Location is exposed', () => {
    expect(catalog.instances).toEqual({
      window: { Location: { immutablePrototype: true } },
      'dedicated-worker': {},
      'shared-worker': {},
      'service-worker': {},
    })
  })

  test('the schema rejects a target without a descriptor, an attribute without an assign kind, and an assign kind on an operation', () => {
    const withTarget = (target: object) => ({
      ...catalog,
      targets: { ...catalog.targets, window: { ...catalog.targets.window, 'Window.x': target } },
    })
    const { descriptor, ...withoutDescriptor } = catalog.targets.window['Window.fetch']
    const { assign, ...withoutAssign } = catalog.targets.window['Window.name']

    expect(descriptor).toBeDefined()
    expect(assign).toBe('setter')
    expect(validate(withTarget(withoutDescriptor))).toBe(false)
    expect(validate(withTarget(withoutAssign))).toBe(false)
    expect(validate(withTarget({ ...catalog.targets.window['Window.fetch'], assign: 'setter' }))).toBe(false)
    expect(validate(withTarget({ ...catalog.targets.window['Window.name'], assign: 'settable' }))).toBe(false)
  })

  test('the schema ties an attribute to an accessor whose setter matches its assign kind, on targets and per-instance members', () => {
    const withTarget = (target: object) => ({
      ...catalog,
      targets: { ...catalog.targets, window: { ...catalog.targets.window, 'Window.x': target } },
    })
    const withLocationMember = (member: object) => ({
      ...catalog,
      instanceMembers: {
        ...catalog.instanceMembers,
        window: { ...catalog.instanceMembers.window, Location: { ...catalog.instanceMembers.window.Location, x: member } },
      },
    })
    const name = catalog.targets.window['Window.name']
    const userAgent = catalog.targets.window['Navigator.prototype.userAgent']
    const href = catalog.instanceMembers.window.Location.href

    expect(validate(withTarget({ ...userAgent, assign: 'setter' }))).toBe(false)
    expect(validate(withTarget({ ...name, assign: 'readonly' }))).toBe(false)
    expect(validate(withTarget({ ...name, descriptor: method }))).toBe(false)
    expect(validate(withLocationMember(href))).toBe(true)
    expect(validate(withLocationMember({ ...href, assign: 'readonly' }))).toBe(false)
    expect(validate(withLocationMember({ ...catalog.instanceMembers.window.Location.reload, assign: 'setter' }))).toBe(
      false,
    )
  })

  test('every changed line of the committed target diff names a descriptor, assign-kind, surface or protection change', () => {
    // Checks every changed line rather than particular ones: the diff lists only the last bump's changes, and the
    // generator tests show a descriptor, assign-kind and surface change.
    const changed = committed.targetDiff.split('## Changed (')[1]?.split('## New owners (')[0] ?? ''
    const lines = changed.split('\n').filter((line) => line.startsWith('- `'))
    const change =
      '(descriptor [^;]+ → [^;]+|assign [a-z-]+ → [a-z-]+|surface [A-Za-z]+ → [A-Za-z]+|protected (yes|no) → (yes|no))'
    const shape = new RegExp(`^- \`[^\`]+\` \\([a-z-]+, [a-z]+\\)( \\[sign-off: protected\\])?: ${change}(; ${change})*$`)

    expect(committed.targetDiff).toContain('\n## Changed (')
    expect(lines.filter((line) => !shape.test(line))).toEqual([])
  })
})

describe('committed catalog: platform singletons, alias groups and exclusions', () => {
  test('lists every §3 platform singleton, nested ones included, with its interface, realms and canonical path', () => {
    const interfacesIn = (realm: Realm) =>
      Object.fromEntries(
        Object.entries(catalog.singletons[realm] as Record<string, Singleton>).map(([path, singleton]) => [
          path,
          'interface' in singleton ? singleton.interface : `namespace ${singleton.namespace}`,
        ]),
      )
    // The 12 of §3's first list, and in the window realm, the curated addition covering the corpus (§3):
    // customElements, document.fonts and six nested navigator objects. Of those,
    // navigator.locks, .permissions and .storage are also singletons in worker realms.
    const inWorkers = {
      console: 'namespace console',
      crypto: 'Crypto',
      'crypto.subtle': 'SubtleCrypto',
      location: 'WorkerLocation',
      navigator: 'WorkerNavigator',
      'navigator.locks': 'LockManager',
      'navigator.permissions': 'Permissions',
      'navigator.serviceWorker': 'ServiceWorkerContainer',
      'navigator.storage': 'StorageManager',
      performance: 'Performance',
    }

    expect(interfacesIn('window')).toEqual({
      console: 'namespace console',
      crypto: 'Crypto',
      'crypto.subtle': 'SubtleCrypto',
      customElements: 'CustomElementRegistry',
      document: 'Document',
      'document.fonts': 'FontFaceSet',
      history: 'History',
      localStorage: 'Storage',
      location: 'Location',
      navigator: 'Navigator',
      'navigator.clipboard': 'Clipboard',
      'navigator.geolocation': 'Geolocation',
      'navigator.locks': 'LockManager',
      'navigator.mediaDevices': 'MediaDevices',
      'navigator.permissions': 'Permissions',
      'navigator.serviceWorker': 'ServiceWorkerContainer',
      'navigator.storage': 'StorageManager',
      'navigator.userActivation': 'UserActivation',
      performance: 'Performance',
      sessionStorage: 'Storage',
    })
    for (const [realm] of workerGlobals) expect(interfacesIn(realm), realm).toEqual(inWorkers)
    expect(catalog.singletons.window['navigator.geolocation'].via).toBe('Navigator.prototype.geolocation')
    expect(catalog.singletons['shared-worker'].location.via).toBe('WorkerGlobalScope.prototype.location')
  })

  test('each singleton is the holder its canonical path names: an instance of its interface, or the console namespace', () => {
    for (const realm of realms) {
      for (const [path, singleton] of Object.entries(catalog.singletons[realm] as Record<string, Singleton>)) {
        const holder = catalog.holders[realm][path] as CatalogHolder
        if ('interface' in singleton) {
          // An engine prototype may sit in between (`document` → `HTMLDocument.prototype` → `Document.prototype`).
          const engines = catalog.enginePrototypes as Record<string, { realms: string[]; prototypeOf: string[] }>
          const engine = Object.entries(engines).find(
            ([, { realms: listed, prototypeOf }]) => listed.includes(realm) && prototypeOf.includes(path),
          )?.[0]
          expect(holder, `${path} (${realm})`).toMatchObject({
            kind: 'instance',
            owner: singleton.interface,
            proto: engine ?? `${singleton.interface}.prototype`,
          })
          if (engine) expect(catalog.holders[realm][engine].proto).toBe(`${singleton.interface}.prototype`)
        } else {
          expect(holder, `${path} (${realm})`).toMatchObject({ kind: 'namespace', owner: 'console' })
        }
        expect(catalog.targets[realm], `${path} (${realm})`).toHaveProperty([singleton.via])
      }
      const instanceHolders = Object.keys(catalog.holders[realm]).filter(
        (name) => catalog.holders[realm][name].kind === 'instance',
      )
      expect(instanceHolders.sort(), realm).toEqual(
        Object.keys(catalog.singletons[realm])
          .filter((path) => path !== 'console')
          .sort(),
      )
    }
  })

  test("a singleton's own members are its only instance targets, named by its canonical path: location's and document.location", () => {
    const instanceTargets = (realm: Realm) =>
      Object.keys(catalog.targets[realm])
        .filter((name) => catalog.targets[realm][name].holder === 'instance')
        .sort()

    expect(instanceTargets('window')).toEqual([
      'document.location',
      ...Object.keys(catalog.instanceMembers.window.Location).map((member) => `location.${member}`),
    ].sort())
    expect(catalog.targets.window['location.href']).toEqual({
      ...catalog.instanceMembers.window.Location.href,
      holder: 'instance',
    })
    expect(catalog.targets.window['location.reload'].descriptor).toEqual({
      type: 'data',
      writable: false,
      enumerable: true,
      configurable: false,
    })
    expect(catalog.targets.window['document.location']).toMatchObject({ owner: 'Document', assign: 'put-forwards' })
    for (const [realm] of workerGlobals) expect(instanceTargets(realm), realm).toEqual([])
  })

  test("alias groups map every access path to the canonical path: through each name of the global, document.location and clientInformation", () => {
    expect(catalog.aliasGroups.window.history).toEqual([
      'globalThis.history',
      'history',
      'self.history',
      'window.history',
    ])
    expect(catalog.aliasGroups.window.location).toEqual([
      'document.location',
      'globalThis.document.location',
      'globalThis.location',
      'location',
      'self.document.location',
      'self.location',
      'window.document.location',
      'window.location',
    ])
    expect(catalog.aliasGroups.window['navigator.serviceWorker']).toEqual([
      'clientInformation.serviceWorker',
      'globalThis.clientInformation.serviceWorker',
      'globalThis.navigator.serviceWorker',
      'navigator.serviceWorker',
      'self.clientInformation.serviceWorker',
      'self.navigator.serviceWorker',
      'window.clientInformation.serviceWorker',
      'window.navigator.serviceWorker',
    ])
    expect(catalog.aliasGroups['dedicated-worker']['crypto.subtle']).toEqual([
      'crypto.subtle',
      'globalThis.crypto.subtle',
      'self.crypto.subtle',
    ])
    for (const realm of realms) {
      const canonical = Object.keys(catalog.singletons[realm]).sort()
      expect(Object.keys(catalog.aliasGroups[realm]).sort(), realm).toEqual(canonical)
      const paths = Object.values(catalog.aliasGroups[realm] as Record<string, string[]>).flat()
      expect(new Set(paths).size, `each path reaches one singleton (${realm})`).toBe(paths.length)
      for (const [canonical, group] of Object.entries(catalog.aliasGroups[realm] as Record<string, string[]>)) {
        expect(group, `${canonical} (${realm})`).toContain(canonical)
      }
    }
  })

  test("target and holder names never carry the global's prefix: navigator.geolocation, crypto.subtle, location.href", () => {
    const globalNames = ['window', 'self', 'globalThis', 'Window', ...workerGlobals.map(([, global]) => global)]
    const prefixed = new RegExp(`^(${globalNames.join('|')})\\.`)

    for (const realm of realms) {
      const holders = catalog.holders[realm] as Record<string, CatalogHolder>
      const targets = catalog.targets[realm] as Record<string, CatalogTarget>
      const instances = Object.keys(holders).filter((name) => holders[name]?.kind === 'instance')
      const onInstances = Object.keys(targets).filter((name) => targets[name]?.holder === 'instance')
      for (const path of Object.keys(catalog.singletons[realm])) expect(path, realm).not.toMatch(prefixed)
      for (const name of [...instances, ...onInstances]) expect(name, realm).not.toMatch(prefixed)
    }
    expect(catalog.holders.window).toHaveProperty(['navigator.geolocation'])
    expect(catalog.holders['service-worker']).toHaveProperty(['crypto.subtle'])
    expect(catalog.targets.window).toHaveProperty(['location.href'])
    expect(catalog.targets.window).not.toHaveProperty(['Window.location.href'])
  })

  test('excluded targets are absent from the targets, and listed in the exclusions section', () => {
    // The committed overlay excludes nothing yet ; the generator tests show an exclusion at work.
    const exclusions = Object.entries(catalog.exclusions as Record<string, Exclusion>)
    const reasons = exclusions.map(([owner, { reason }]) => [owner, reason])

    expect(Object.fromEntries(reasons)).toEqual(JSON.parse(read('tools/catalog-generator/overlays/exclusions.json')))
    for (const [owner, exclusion] of exclusions) {
      for (const realm of realms) {
        const targets = catalog.targets[realm] as Record<string, CatalogTarget>
        for (const name of exclusion.targets[realm]) expect(targets, owner).not.toHaveProperty([name])
        expect(Object.values(targets).filter((target) => target.owner === owner)).toEqual([])
      }
    }
  })

  test('singletons, alias groups and exclusions are named sections, which the schema requires', () => {
    for (const section of ['singletons', 'aliasGroups', 'exclusions']) {
      expect(catalog).toHaveProperty([section])
      const without = { ...catalog }
      delete without[section]
      expect(validate(without), section).toBe(false)
    }
    const nowhere = { ...catalog.singletons.window, history: { via: 'Window.history' } }
    expect(validate({ ...catalog, singletons: { ...catalog.singletons, window: nowhere } })).toBe(false)
  })
})

describe('committed catalog: surfaces and the protected-surface list', () => {
  const list = catalog.protectedSurface as Record<string, ProtectedEntry[]>
  const entryName = ({ interface: name, member }: ProtectedEntry) => (member === undefined ? name : `${name}.${member}`)
  /** Every target any entry names, as `name (realm)`. */
  const covered = new Set(
    Object.values(list).flatMap((entries) =>
      entries.flatMap(({ targets }) => realms.flatMap((realm) => targets[realm].map((name) => `${name} (${realm})`))),
    ),
  )

  test('every target and per-instance member has a surface, and exactly the ECMAScript members are ECMAScript', () => {
    const additions = Object.values(catalog.esAdditions as Record<string, EsAddition>)
    const engines = Object.values(catalog.engineExtensions as Record<string, EngineExtension>)
    const ecmascriptSpecs = new Set([
      'ecma262',
      'ecma402',
      ...additions.map(({ spec }) => spec),
      ...engines.map(({ engine }) => engine),
    ])
    for (const realm of realms) {
      for (const [name, target] of Object.entries(catalog.targets[realm] as Record<string, CatalogTarget>)) {
        expect(surfaces, `${name} (${realm})`).toContain(target.surface)
        expect(target.surface === 'ECMAScript', `${name} (${realm})`).toBe(ecmascriptSpecs.has(target.spec))
      }
      const byOwner = catalog.instanceMembers[realm] as Record<string, Record<string, InstanceMember>>
      for (const member of Object.values(byOwner).flatMap((members) => Object.values(members))) {
        expect(surfaces).toContain(member.surface)
        expect(member.surface).not.toBe('ECMAScript')
      }
    }
  })

  test('members take their surface from the owner → surface map, and an owner nobody has reviewed is other', () => {
    const surfaceOf = (realm: Realm) => (name: string) => [name, catalog.targets[realm][name]?.surface]
    const window = [
      ['Window.fetch', 'networking'],
      ['Window.XMLHttpRequest', 'networking'],
      ['Navigator.prototype.sendBeacon', 'networking'],
      ['EventTarget.prototype.addEventListener', 'events'],
      ['Window.setTimeout', 'scheduling'],
      ['Window.requestAnimationFrame', 'scheduling'],
      ['Window.requestIdleCallback', 'scheduling'],
      ['History.prototype.pushState', 'navigation'],
      ['Window.open', 'navigation'],
      ['location.href', 'navigation'],
      ['Storage.prototype.setItem', 'storage'],
      ['Window.localStorage', 'storage'],
      ['Crypto.prototype.getRandomValues', 'crypto'],
      ['Node.prototype.appendChild', 'DOM'],
      ['Element.prototype.attachShadow', 'DOM'],
      ['Window.Comment', 'DOM'],
      ['Window.XMLHttpRequestUpload', 'networking'],
      ['Window.Promise', 'ECMAScript'],
      ['Array.prototype.map', 'ECMAScript'],
      ['console.log', 'diagnostics'],
      ['Window.console', 'diagnostics'],
      ['Worker.prototype.postMessage', 'workers'],
      ['Navigator.prototype.serviceWorker', 'workers'],
      ['GPU.prototype.requestAdapter', 'other'],
    ]
    const worker = [
      ['WorkerGlobalScope.prototype.fetch', 'networking'],
      ['WorkerGlobalScope.prototype.setTimeout', 'scheduling'],
      ['DedicatedWorkerGlobalScope.requestAnimationFrame', 'scheduling'],
    ]

    expect(window.map(([name]) => surfaceOf('window')(name!))).toEqual(window)
    expect(worker.map(([name]) => surfaceOf('dedicated-worker')(name!))).toEqual(worker)
    expect(catalog.instanceMembers.window.Location.href.surface).toBe('navigation')
    expect(catalog.surfaceMap).toEqual(JSON.parse(read('tools/catalog-generator/overlays/surfaces.json')))
    expect(catalog.surfaceMap.owners).not.toHaveProperty(['GPU'])
  })

  test('the committed target diff lists the owners it adds, each with the surfaces of its members', () => {
    // The generator tests show a new owner nobody has reviewed as other; this bump adds no owner.
    const added = (committed.targetDiff.split('## New owners (')[1] ?? '').split('\n## ')[0]!
    const lines = added.split('\n').filter((line) => line.startsWith('- '))
    const shape = new RegExp(`^- \`[^\`]+\`: (${surfaces.join('|')})(, (${surfaces.join('|')}))*$`)

    expect(committed.targetDiff).toContain('\n## New owners (')
    expect(lines.filter((line) => !shape.test(line))).toEqual([])
  })

  test("§12's table is encoded exactly: each surface with its whole and member entries", () => {
    const table = {
      networking: [
        'WindowOrWorkerGlobalScope.fetch',
        'XMLHttpRequest',
        'WebSocket',
        'EventSource',
        'Request',
        'Response',
        'Headers',
        'Navigator.sendBeacon',
      ],
      events: ['EventTarget.addEventListener', 'EventTarget.removeEventListener', 'EventTarget.dispatchEvent'],
      scheduling: [
        'WindowOrWorkerGlobalScope.setTimeout',
        'WindowOrWorkerGlobalScope.setInterval',
        'WindowOrWorkerGlobalScope.clearTimeout',
        'WindowOrWorkerGlobalScope.clearInterval',
        'AnimationFrameProvider.requestAnimationFrame',
        'AnimationFrameProvider.cancelAnimationFrame',
        'Window.requestIdleCallback',
        'Window.cancelIdleCallback',
        'WindowOrWorkerGlobalScope.queueMicrotask',
      ],
      navigation: ['History', 'Window.open'],
      storage: ['Storage', 'Window.localStorage', 'Window.sessionStorage'],
      crypto: ['Crypto', 'SubtleCrypto'],
      ECMAScript: ['Promise', 'Function', 'Object', 'Array', 'Map', 'Set', 'JSON'],
      diagnostics: ['console'],
      workers: ['Worker', 'SharedWorker', 'ServiceWorkerContainer', 'Navigator.serviceWorker'],
    }
    const encoded = Object.fromEntries(Object.entries(list).map(([surface, entries]) => [surface, entries.map(entryName)]))

    expect(Object.keys(encoded).sort()).toEqual(Object.keys(table).sort())
    for (const [surface, entries] of Object.entries(table)) expect(encoded[surface]?.sort(), surface).toEqual(entries.sort())
  })

  test('entries name their catalog targets: members in every realm, and whole interfaces without event handlers', () => {
    const entry = (name: string) => Object.values(list).flat().find((candidate) => entryName(candidate) === name)!

    expect(entry('WindowOrWorkerGlobalScope.fetch').targets).toEqual({
      window: ['Window.fetch'],
      'dedicated-worker': ['WorkerGlobalScope.prototype.fetch'],
      'shared-worker': ['WorkerGlobalScope.prototype.fetch'],
      'service-worker': ['WorkerGlobalScope.prototype.fetch'],
    })
    expect(entry('History').targets.window).toEqual(
      expect.arrayContaining(['Window.History', 'History.prototype.pushState', 'History.prototype.back']),
    )
    expect(entry('console').targets['service-worker']).toEqual(
      expect.arrayContaining(['ServiceWorkerGlobalScope.console', 'console.log']),
    )
    expect(entry('Array').targets.window).toEqual(
      expect.arrayContaining(['Window.Array', 'Array.from', 'Array.prototype.map', 'Array.prototype.@@iterator']),
    )
    for (const handler of ['WebSocket.prototype.onmessage', 'EventSource.prototype.onmessage', 'Worker.prototype.onmessage']) {
      expect(catalog.targets.window, handler).toHaveProperty([handler])
      expect(covered, handler).not.toContain(`${handler} (window)`)
    }
  })

  test('session-replay DOM hooks and the observer constructors are absent from the list', () => {
    const replayHooks = [
      'CustomElementRegistry.prototype.define',
      'Element.prototype.attachShadow',
      ...['insertRule', 'deleteRule', 'addRule', 'removeRule', 'replace', 'replaceSync'].map(
        (method) => `CSSStyleSheet.prototype.${method}`,
      ),
      'HTMLInputElement.prototype.value',
      'HTMLTextAreaElement.prototype.value',
      'HTMLSelectElement.prototype.value',
    ]
    const observers = ['MutationObserver', 'IntersectionObserver', 'ResizeObserver', 'PerformanceObserver', 'ReportingObserver']
    const left = [...replayHooks, ...observers.flatMap((observer) => [`Window.${observer}`, `${observer}.prototype.observe`])]
    const interfaces = new Set(Object.values(list).flatMap((entries) => entries.map(({ interface: name }) => name)))

    for (const name of left) {
      expect(catalog.targets.window, name).toHaveProperty([name])
      expect(covered, name).not.toContain(`${name} (window)`)
    }
    for (const name of [...observers, 'CustomElementRegistry', 'Element', 'CSSStyleSheet', 'HTMLInputElement']) {
      expect(interfaces, name).not.toContain(name)
    }
  })

  test("every target an entry names exists in its realm and has the entry's surface", () => {
    for (const [surface, entries] of Object.entries(list)) {
      for (const { targets } of entries) {
        for (const realm of realms) {
          for (const name of targets[realm]) expect(catalog.targets[realm][name]?.surface, `${name} (${realm})`).toBe(surface)
        }
      }
    }
  })

  test('the owner → surface map and the protected list are named sections, which the schema requires', () => {
    for (const section of ['surfaceMap', 'protectedSurface']) {
      expect(catalog).toHaveProperty([section])
      const without = { ...catalog }
      delete without[section]
      expect(validate(without), section).toBe(false)
    }
    const withoutSurface = { ...catalog.targets.window['Window.fetch'] }
    delete withoutSurface.surface
    const withTarget = (target: object) => ({ ...catalog, targets: { ...catalog.targets, window: { 'Window.fetch': target } } })

    expect(validate(withTarget(withoutSurface))).toBe(false)
    expect(validate(withTarget({ ...catalog.targets.window['Window.fetch'], surface: 'network' }))).toBe(false)
    expect(validate({ ...catalog, surfaceMap: { ...catalog.surfaceMap, owners: { History: 'other' } } })).toBe(false)
    expect(validate({ ...catalog, protectedSurface: { ...list, other: list.navigation } })).toBe(false)
  })
})

describe('committed catalog: catalog version and retained targets', () => {
  const overlay = JSON.parse(read('tools/catalog-generator/overlays/retained.json'))

  test('the retained overlay is a named section, which the schema requires, with every realm in each part', () => {
    const without = { ...catalog }
    delete without.retained

    expect(validate(without)).toBe(false)
    for (const part of ['targets', 'holders', 'dropped', 'droppedHolders']) {
      expect(Object.keys(catalog.retained[part]).sort(), part).toEqual([...realms].sort())
      for (const realm of realms) {
        expect(catalog.retained[part][realm], `${part} (${realm})`).toEqual(
          Object.fromEntries(
            Object.entries(overlay[part][realm] ?? {}).map(([name, entry]) => {
              const recorded = { ...(entry as Record<string, unknown>) }
              delete recorded.target
              delete recorded.holder
              return [name, recorded]
            }),
          ),
        )
      }
    }
  })

  test('exactly the retained targets are flagged retained, each on a holder of its realm, and no dropped target or holder is in the catalog', () => {
    for (const realm of realms) {
      const flagged = Object.entries(catalog.targets[realm] as Record<string, CatalogTarget>)
        .filter(([, target]) => target.catalogStatus !== undefined)
        .map(([name]) => name)
      expect(flagged.sort(), realm).toEqual(Object.keys(catalog.retained.targets[realm]).sort())
      for (const name of Object.keys(catalog.retained.holders[realm])) expect(catalog.holders[realm]).toHaveProperty([name])
      for (const name of Object.keys(catalog.retained.dropped[realm])) expect(catalog.targets[realm]).not.toHaveProperty([name])
      for (const name of Object.keys(catalog.retained.droppedHolders[realm])) expect(catalog.holders[realm]).not.toHaveProperty([name])
    }
  })

  test('the schema accepts catalogStatus retained on a target, and rejects another status or a retained entry without a reason', () => {
    const fetch = catalog.targets.window['Window.fetch']
    const withTarget = (target: object) => ({ ...catalog, targets: { ...catalog.targets, window: { 'Window.fetch': target } } })
    const retainedWith = (entry: object) => ({
      ...catalog,
      retained: { ...catalog.retained, targets: { ...catalog.retained.targets, window: { 'Window.fetch': entry } } },
    })

    expect(validate(withTarget({ ...fetch, catalogStatus: 'retained' }))).toBe(true)
    expect(validate(withTarget({ ...fetch, catalogStatus: 'current' }))).toBe(false)
    expect(validate(retainedWith({ lastUpstream: '@webref/idl 3.84.0', reason: 'Still ships.' }))).toBe(true)
    expect(validate(retainedWith({ lastUpstream: '@webref/idl 3.84.0' }))).toBe(false)
    expect(validate(retainedWith({ lastUpstream: '3.84.0', reason: 'Still ships.' }))).toBe(false)
  })
})

describe('committed catalog: bump review and cross-checks', () => {
  test('every line the committed target diff marks for sign-off is signed off, and only those', async () => {
    const { signOff } = await readCommitted()
    const marked = committed.targetDiff.split('\n').filter((line) => line.includes(' [sign-off: '))

    for (const line of marked) expect(signOff[line.slice(2)]?.trim(), line).toBeTruthy()
    expect(Object.keys(signOff).length).toBe(marked.length)
  })

  test('the committed target diff lists newly retained targets and holders with the last upstream version and why, marked for sign-off', () => {
    const retained = committed.targetDiff.split('\n## Retained (')[1]?.split('\n## Changed (')[0] ?? ''
    const lines = retained.split('\n').filter((line) => line.startsWith('- '))
    const shape = /^- `[^`]+` \([a-z-]+, [a-z]+( holder)?\) \[sign-off: (protected, )?retained\]: last in \S+ \d+\.\d+\.\d+; .+$/

    expect(committed.targetDiff).toContain('\n## Retained (')
    expect(lines.filter((line) => !shape.test(line))).toEqual([])
  })

  test('the committed cross-check report is the one written from the committed catalog and the pinned SES and BCD', async () => {
    const sources = await loadCrossCheckSources()
    const report = read('catalog/cross-check.md')
    const { devDependencies } = JSON.parse(read('package.json'))

    expect(crossCheckProblems(committed.catalog, report, sources)).toEqual([])
    expect(sources.pins).toEqual({ ses: devDependencies.ses, bcd: devDependencies['@mdn/browser-compat-data'] })
    // Known discrepancies, each by design: SES permits Error.prepareStackTrace, which V8 does not define, and has no
    // Intl; BCD shows engines shipping CSPViolationReportBody, an interface webref left when CSP3 made it a dictionary.
    expect(report).toContain('\n- `Error.prepareStackTrace`\n')
    expect(report).toContain('\n- `Window.Intl`\n')
    // V8's engine extensions are in the catalog (§4 Sources), so neither SES nor BCD finds them lacking.
    for (const name of ['captureStackTrace', 'stackTraceLimit']) {
      expect(report).not.toContain(`\n- \`Error.${name}\`\n`)
      expect(report).not.toContain(`\n- \`javascript.builtins.Error.${name}\``)
    }
    expect(report).toMatch(/\n- `api\.CSPViolationReportBody` and \d+ members \(/)
  })

  test('catalog:check fails on a drop citing any BCD feature an engine ships, whatever part of BCD it is in', async () => {
    const sources = await loadCrossCheckSources()
    const withDrop = (bcd: string) => {
      const drop = { bcd, evidence: 'Test-only.' }
      const edited = { ...catalog, retained: { ...catalog.retained, dropped: { ...catalog.retained.dropped, window: { 'Window.gone': drop } } } }
      const text = JSON.stringify(edited)
      return crossCheckProblems(text, crossCheck(text, sources), sources)
    }

    for (const shipped of ['api.fetch', 'javascript.builtins.Array.from', 'javascript.statements.let', 'css.properties.color']) {
      expect(withDrop(shipped), shipped).toEqual([expect.stringMatching(/^`Window\.gone` \(window\) is dropped, but BCD shows chrome, firefox, safari, chrome_android, firefox_android, safari_ios shipping/)])
    }
    expect(withDrop('api.NoSuchInterface')).toEqual([])
  })

  test('only released BCD versions count: a preview removal still ships, and beta-only support does not', async () => {
    const sources = await loadCrossCheckSources()
    const withDrop = (bcd: string) => {
      const drop = { bcd, evidence: 'Test-only.' }
      const edited = { ...catalog, retained: { ...catalog.retained, dropped: { ...catalog.retained.dropped, window: { 'Window.gone': drop } } } }
      const text = JSON.stringify(edited)
      return crossCheckProblems(text, crossCheck(text, sources), sources)
    }
    const shipping = (engines: string, bcd: string) =>
      `\`Window.gone\` (window) is dropped, but BCD shows ${engines} shipping \`${bcd}\`. A drop needs BCD evidence that ` +
      'no current engine ships it (§4 Catalog versions): keep it in the retained overlay instead.'

    // At BCD 8.1.3 Safari removes these only in its preview, so Safari still ships them.
    for (const member of ['incomingHighWaterMark', 'outgoingHighWaterMark']) {
      const bcd = `api.WebTransportDatagramDuplexStream.${member}`
      expect(withDrop(bcd)).toEqual([shipping('chrome, firefox, safari, chrome_android, firefox_android, safari_ios', bcd)])
    }
    // Chrome and Chrome Android 155, and Firefox 157, are betas at BCD 8.1.3.
    for (const member of ['decapsulateBits', 'decapsulateKey', 'encapsulateBits', 'encapsulateKey', 'getPublicKey', 'supports_static']) {
      expect(withDrop(`api.SubtleCrypto.${member}`), member).toEqual([])
    }
    for (const bcd of ['api.GPUTexture.usage.transient_attachment', 'api.GPUTexture.createView.descriptor_usage_parameter.transient_attachment']) {
      expect(withDrop(bcd)).toEqual([shipping('chrome, chrome_android', bcd)])
    }
    const typeText = 'javascript.statements.import.import_attributes.type_text'
    expect(withDrop(typeText)).toEqual([shipping('firefox, firefox_android', typeText)])
    // Twelve cross-checks of the full catalog take about 2.5s alone, and past vitest's 5s default under a loaded suite.
  }, 30_000)

  test('the committed cross-check report lists the SubtleCrypto features only a beta ships as shipped by no engine', () => {
    const report = read('catalog/cross-check.md')
    const unshipped = report.split('\n## The catalog has, BCD shows no engine ships (')[1]?.split('\n## ')[0]

    for (const [name, bcd] of [
      ['SubtleCrypto.prototype.decapsulateBits', 'api.SubtleCrypto.decapsulateBits'],
      ['SubtleCrypto.prototype.getPublicKey', 'api.SubtleCrypto.getPublicKey'],
      ['SubtleCrypto.supports', 'api.SubtleCrypto.supports_static'],
    ]) {
      expect(unshipped, name).toContain(`\n- \`${name}\`: \`${bcd}\`\n`)
    }
  })

  test('catalog:check fails on a drop of Window.orientation, which only mobile engines ship', async () => {
    const sources = await loadCrossCheckSources()
    const window = { ...catalog.targets.window }
    delete window['Window.orientation']
    const drop = { bcd: 'api.Window.orientation', evidence: 'Desktop browsers lack it.' }
    const edited = {
      ...catalog,
      targets: { ...catalog.targets, window },
      retained: { ...catalog.retained, dropped: { ...catalog.retained.dropped, window: { 'Window.orientation': drop } } },
    }
    const text = JSON.stringify(edited)

    expect(crossCheckProblems(text, crossCheck(text, sources), sources)).toEqual([
      '`Window.orientation` (window) is dropped, but BCD shows chrome_android, firefox_android, safari_ios shipping ' +
        '`api.Window.orientation`. A drop needs BCD evidence that no current engine ships it (§4 Catalog versions): ' +
        'keep it in the retained overlay instead.',
    ])
  })

  test('the committed cross-check report does not list features only mobile engines ship as shipped by no engine', () => {
    const report = read('catalog/cross-check.md')
    const unshipped = report.split('\n## The catalog has, BCD shows no engine ships (')[1]?.split('\n## ')[0]

    expect(unshipped).toBeDefined()
    for (const name of [
      'Window.orientation',
      'Navigator.prototype.contacts',
      'Window.ContactsManager',
      'ContactsManager.prototype.select',
      'Window.NDEFReader',
      'NDEFReader.prototype.scan',
      'HTMLInputElement.prototype.capture',
      'ServiceWorkerRegistration.prototype.index',
    ]) {
      expect(catalog.targets.window, name).toHaveProperty([name])
      expect(unshipped, name).not.toContain(`\n- \`${name}\`: `)
    }
  })

  test('SES and BCD are checks, never sources: the catalog records no pin of them', () => {
    expect(Object.keys(catalog.metadata.upstream)).not.toContain('ses')
    expect(Object.keys(catalog.metadata.upstream)).not.toContain('@mdn/browser-compat-data')
    expect(committed.catalog).not.toContain('browser-compat-data')
  })
})

describe("committed catalog: the realm globals' interface objects, console's prototype and the other added targets", () => {
  const globalsOf: (readonly [Realm, string])[] = [['window', 'Window'], ...workerGlobals]

  test("each realm global interface's own interface object is a constructor holder named by its path from the global", () => {
    for (const [realm, global] of globalsOf) {
      const holders = catalog.holders[realm] as Record<string, CatalogHolder>
      expect(catalog.targets[realm][`${global}.${global}`], realm).toMatchObject({
        holder: 'global',
        kind: 'interface',
        holds: `${global}.${global}`,
      })
      expect(holders[`${global}.${global}`], realm).toMatchObject({ kind: 'constructor', owner: global })
      expect(holders[global], realm).toMatchObject({ kind: 'global', proto: `${global}.prototype` })
    }
    // An interface object's [[Prototype]] is the interface object of the interface it inherits (Web IDL).
    expect(catalog.holders.window['Window.Window'].proto).toBe('EventTarget')
    expect(catalog.holders['dedicated-worker']['DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope'].proto).toBe(
      'WorkerGlobalScope',
    )
  })

  test("console's empty [[Prototype]] is a holder of its own, between console and Object.prototype, in every realm", () => {
    for (const realm of realms) {
      expect(catalog.holders[realm].console, realm).toMatchObject({ proto: 'console.[[Prototype]]' })
      expect(catalog.holders[realm]['console.[[Prototype]]'], realm).toEqual({
        kind: 'prototype',
        owner: 'console',
        proto: 'Object.prototype',
      })
    }
  })

  describe('the four ECMA-262 own properties without a clause of their own', () => {
    const overlay = JSON.parse(read('tools/catalog-generator/overlays/es-prose-properties.json'))
    const described = {
      'Array.prototype.length': { type: 'data', writable: true, enumerable: false, configurable: false },
      'Function.prototype.arguments': { type: 'accessor', setter: true, enumerable: false, configurable: true },
      'Function.prototype.caller': { type: 'accessor', setter: true, enumerable: false, configurable: true },
      'String.prototype.length': { type: 'data', writable: false, enumerable: false, configurable: false },
    }

    test('are ECMA-262 targets in every realm, with the descriptors ECMA-262 gives them', () => {
      expect(Object.keys(overlay).sort()).toEqual(Object.keys(described))
      expect(catalog.esProseProperties).toEqual(overlay)
      for (const realm of realms) {
        for (const [name, descriptor] of Object.entries(described)) {
          expect(catalog.targets[realm][name], `${name} (${realm})`).toMatchObject({
            holder: 'prototype',
            kind: descriptor.type === 'accessor' ? 'accessor' : 'value',
            spec: 'ecma262',
            descriptor,
            surface: 'ECMAScript',
          })
        }
      }
    })

    test('their descriptors are the ones the V8 running these tests gives a fresh context', () => {
      const inV8 = runInNewContext(
        `Object.fromEntries(${JSON.stringify(Object.keys(described))}.map((name) => {
          const [owner, , key] = name.split('.')
          return [name, Object.getOwnPropertyDescriptor(globalThis[owner].prototype, key)]
        }))`,
      ) as Record<string, PropertyDescriptor>

      for (const [name, { descriptor }] of Object.entries<{ descriptor: CatalogTarget['descriptor'] }>(overlay)) {
        const own = inV8[name]!
        const { enumerable, configurable } = own
        const seen =
          own.get || own.set
            ? { type: 'accessor', setter: own.set !== undefined, enumerable, configurable }
            : { type: 'data', writable: own.writable, enumerable, configurable }
        expect(descriptor, name).toEqual(seen)
      }
    })

    // Their sign-off lines left catalog/sign-off.json with an earlier target diff; git history keeps who signed them.
    test('Function.prototype.caller and .arguments and Array.prototype.length are protected', () => {
      const ecmascript = catalog.protectedSurface.ECMAScript as ProtectedEntry[]
      const entry = (name: string) => ecmascript.find((listed) => listed.interface === name && !listed.member)!
      for (const realm of realms) {
        expect(entry('Function').targets[realm], realm).toEqual(
          expect.arrayContaining(['Function.prototype.arguments', 'Function.prototype.caller']),
        )
        expect(entry('Array').targets[realm], realm).toContain('Array.prototype.length')
      }
    })
  })

  test("location.valueOf and location.@@toPrimitive are instance targets with HTML's non-writable, non-configurable descriptors", () => {
    const fixed = { type: 'data', writable: false, enumerable: false, configurable: false }

    expect(catalog.targets.window['location.valueOf']).toMatchObject({
      owner: 'Location',
      holder: 'instance',
      kind: 'function',
      spec: 'html',
      descriptor: fixed,
    })
    expect(catalog.targets.window['location.@@toPrimitive']).toMatchObject({
      owner: 'Location',
      holder: 'instance',
      kind: 'value',
      spec: 'html',
      descriptor: fixed,
    })
    expect(catalog.proseMembers).toEqual(JSON.parse(read('tools/catalog-generator/overlays/prose-members.json')))
    // A worker's location is a WorkerLocation, which HTML gives neither.
    for (const [realm] of workerGlobals) {
      expect(catalog.targets[realm], realm).not.toHaveProperty(['location.valueOf'])
    }
  })

  test('the added singletons are reached through every alias path, nested navigator objects through clientInformation too', () => {
    expect(catalog.aliasGroups.window['navigator.clipboard']).toEqual([
      'clientInformation.clipboard',
      'globalThis.clientInformation.clipboard',
      'globalThis.navigator.clipboard',
      'navigator.clipboard',
      'self.clientInformation.clipboard',
      'self.navigator.clipboard',
      'window.clientInformation.clipboard',
      'window.navigator.clipboard',
    ])
    expect(catalog.aliasGroups.window['document.fonts']).toEqual([
      'document.fonts',
      'globalThis.document.fonts',
      'self.document.fonts',
      'window.document.fonts',
    ])
    expect(catalog.aliasGroups.window.customElements).toEqual([
      'customElements',
      'globalThis.customElements',
      'self.customElements',
      'window.customElements',
    ])
    expect(catalog.aliasGroups['service-worker']['navigator.storage']).toEqual([
      'globalThis.navigator.storage',
      'navigator.storage',
      'self.navigator.storage',
    ])
  })
})

describe('committed catalog: the HTMLDocument interface', () => {
  test("HTMLDocument.prototype is a prototype holder on document's chain, in the window realm only", () => {
    expect(catalog.holders.window['HTMLDocument.prototype']).toEqual({
      kind: 'prototype',
      owner: 'HTMLDocument',
      proto: 'Document.prototype',
    })
    expect(catalog.holders.window.document).toMatchObject({ kind: 'instance', owner: 'Document', proto: 'HTMLDocument.prototype' })
    for (const [realm] of workerGlobals) {
      expect(catalog.holders[realm], realm).not.toHaveProperty(['HTMLDocument.prototype'])
      expect(catalog.holders[realm], realm).not.toHaveProperty(['HTMLDocument'])
      expect(Object.keys(catalog.targets[realm]).filter((name) => /(^|\.)HTMLDocument(\.|$)/.test(name)), realm).toEqual([])
    }
    expect(catalog.enginePrototypes).toEqual(JSON.parse(read('tools/catalog-generator/overlays/engine-prototypes.json')))
  })

  // §4.
  test('Window.HTMLDocument holds the HTMLDocument interface object, and the prototype has constructor and @@toStringTag', () => {
    const targets = catalog.targets.window
    expect(catalog.holders.window.HTMLDocument).toEqual({ kind: 'constructor', owner: 'HTMLDocument', proto: 'Document' })
    expect(targets['Window.HTMLDocument']).toMatchObject({ holder: 'global', kind: 'interface', holds: 'HTMLDocument' })
    expect(targets['HTMLDocument.prototype']).toMatchObject({ holder: 'constructor', holds: 'HTMLDocument.prototype' })
    expect(targets['HTMLDocument.prototype.constructor']).toMatchObject({ holder: 'prototype', holds: 'HTMLDocument' })
    expect(targets['HTMLDocument.prototype.@@toStringTag']).toMatchObject({
      holder: 'prototype',
      descriptor: { type: 'data', writable: false, enumerable: false, configurable: true },
    })
    expect(Object.keys(targets).filter((name) => /(^|\.)HTMLDocument(\.|$)/.test(name)).sort()).toEqual([
      'HTMLDocument.prototype',
      'HTMLDocument.prototype.@@toStringTag',
      'HTMLDocument.prototype.constructor',
      'Window.HTMLDocument',
    ])
  })

  // No other interface @webref/idl lacks is added in R1 (§4, §21): the only engine prototype is HTMLDocument's.
  test('no other engine-only interface is catalogued', () => {
    expect(Object.keys(catalog.enginePrototypes)).toEqual(['HTMLDocument.prototype'])
    for (const name of ['SharedStorage', 'WebSocketStream', 'ReportBody', 'FeaturePolicy', 'StyleMedia']) {
      expect(catalog.targets.window, name).not.toHaveProperty([`Window.${name}`])
    }
  })

  // The changes since the previous catalog: HTMLDocument's four targets, the interface object's holder and its owner's
  // surface, and the reworded source notes of two framework path rules and four escape-only shapes; nothing else. None is
  // protected, so nothing needs sign-off.
  test('the target diff adds the four targets, the holder and the owner, rewords six source notes, and nothing else', () => {
    const section = (heading: string) =>
      (committed.targetDiff.split(`\n## ${heading} (`)[1] ?? '').split('\n## ')[0]!.split('\n').filter((line) => line.startsWith('- '))
    expect(section('Added')).toEqual([
      '- `HTMLDocument.prototype` (window, constructor)',
      '- `HTMLDocument.prototype.@@toStringTag` (window, prototype)',
      '- `HTMLDocument.prototype.constructor` (window, prototype)',
      '- `Window.HTMLDocument` (window, global)',
    ])
    expect(section('Added holders')).toEqual(['- `HTMLDocument` (window, constructor holder)'])
    expect(section('New owners')).toEqual(['- `HTMLDocument`: DOM'])
    expect(section('Framework path rules')).toEqual([
      '- `angular-bazel` changed: source changed',
      '- `next-webpack-client` changed: source changed',
    ])
    expect(section('Escape-only shapes')).toEqual([
      '- `angular-fesm-packages` changed: source changed',
      '- `next-webpack-build` changed: source changed',
      '- `next-webpack-lib` changed: source changed',
      '- `next-webpack-shared` changed: source changed',
    ])
    for (const title of ['Removed', 'Removed holders', 'Retained', 'Changed']) {
      expect(section(title), title).toEqual([])
    }
    expect(committed.targetDiff).not.toContain('[sign-off:')
  })
})

describe('committed catalog: members Web IDL synthesizes', () => {

  test('the criteria targets exist, with the holders the binding puts them on', () => {
    const expected: Record<string, [string, string]> = {
      'URL.prototype.toString': ['prototype', 'operation'],
      'Headers.prototype.entries': ['prototype', 'operation'],
      'Headers.prototype.@@iterator': ['prototype', 'operation'],
      'RTCStatsReport.prototype.size': ['prototype', 'attribute'],
      'RTCStatsReport.prototype.get': ['prototype', 'operation'],
      'RTCStatsReport.prototype.has': ['prototype', 'operation'],
      'FontFaceSet.prototype.add': ['prototype', 'operation'],
      'Node.prototype.constructor': ['prototype', 'function'],
      'Node.prototype.@@toStringTag': ['prototype', 'value'],
      'Node.prototype': ['constructor', 'value'],
      'HTMLCollection.prototype.@@iterator': ['prototype', 'operation'],
      'FileList.prototype.@@iterator': ['prototype', 'operation'],
      'CSSRuleList.prototype.@@iterator': ['prototype', 'operation'],
      'Element.prototype.@@unscopables': ['prototype', 'value'],
      'console.@@toStringTag': ['namespace', 'value'],
    }
    for (const [name, [holder, kind]] of Object.entries(expected)) {
      expect(catalog.targets.window[name], name).toMatchObject({ holder, kind })
    }
    // %Array.prototype.values%: writable, not enumerable, configurable.
    for (const name of ['HTMLCollection.prototype.@@iterator', 'FileList.prototype.@@iterator', 'CSSRuleList.prototype.@@iterator']) {
      expect(catalog.targets.window[name].descriptor).toEqual({ type: 'data', writable: true, enumerable: false, configurable: true })
    }
    expect(catalog.targets.window['Node.prototype.constructor'].holds).toBe('Node')
    expect(catalog.targets.window['Node.prototype'].holds).toBe('Node.prototype')
  })

  test('readonly maplike and setlike declarations have no set, add, delete or clear', () => {
    for (const holder of ['RTCStatsReport.prototype', 'EventCounts.prototype', 'GPUSupportedFeatures.prototype', 'XRAnchorSet.prototype']) {
      for (const member of ['set', 'add', 'delete', 'clear']) {
        expect(realmsWith(`${holder}.${member}`), `${holder}.${member}`).toEqual([])
      }
    }
    for (const member of ['add', 'delete', 'clear']) expect(realmsWith(`FontFaceSet.prototype.${member}`)).toContain('window')
  })

  test("an interface object's and an operation's length and name are not targets", () => {
    for (const realm of realms) {
      const names = Object.keys(catalog.targets[realm]).filter((name) => /^[A-Z]\w*(\.prototype\.\w+)?\.(length|name)$/.test(name))
      // Only ECMAScript and Web IDL members that are really called length or name (`History.prototype.length`).
      for (const name of names) expect(catalog.targets[realm][name].kind, name).not.toBe('function')
    }
    for (const name of ['Node.length', 'Node.name', 'Image.length', 'Image.name', 'Node.prototype.appendChild.name']) {
      expect(realmsWith(name), name).toEqual([])
    }
  })

  test('[LegacyWindowAlias] and [LegacyFactoryFunction] names are global targets; an alias holds the same object', () => {
    expect(catalog.targets.window['Window.webkitURL']).toMatchObject({ holder: 'global', kind: 'interface', holds: 'URL' })
    expect(catalog.targets.window['Window.URL'].holds).toBe('URL')
    expect(realmsWith('Window.webkitURL')).toEqual(['window'])
    for (const [factory, element] of [
      ['Image', 'HTMLImageElement'],
      ['Audio', 'HTMLAudioElement'],
      ['Option', 'HTMLOptionElement'],
    ] as const) {
      expect(catalog.targets.window[`Window.${factory}`]).toMatchObject({ holder: 'global', holds: factory })
      expect(catalog.holders.window[factory]).toEqual({ kind: 'constructor', owner: element, proto: 'Function.prototype' })
      const own = Object.keys(catalog.targets.window).filter((name) => name.startsWith(`${factory}.`))
      expect(own).toEqual([`${factory}.prototype`])
      expect(catalog.targets.window[`${factory}.prototype`]).toMatchObject({ holds: `${element}.prototype`, owner: element })
    }
  })
  // A later diff replaced this bump's, which listed the added targets and holders and their sign-offs: git
  // history keeps it.
})

describe("committed catalog: the Navigator.serviceWorker entry's worker equivalent", () => {
  test('WorkerNavigator.prototype.serviceWorker is protected in the three worker realms, and nothing else changes', () => {
    const [entry] = catalog.protectedSurface.workers!.filter(({ member }: { member?: string }) => member === 'serviceWorker')
    expect(entry).toMatchObject({ interface: 'Navigator', member: 'serviceWorker', workerEquivalent: 'WorkerNavigator' })
    expect(entry!.targets).toEqual({
      window: ['Navigator.prototype.serviceWorker'],
      'dedicated-worker': ['WorkerNavigator.prototype.serviceWorker'],
      'shared-worker': ['WorkerNavigator.prototype.serviceWorker'],
      'service-worker': ['WorkerNavigator.prototype.serviceWorker'],
    })
  })

  // The diff that added the framework path rules and escape-only shapes and nothing else was replaced by a later
  // one: git history keeps it. This bump's `Changed` lines were signed off in its own bump.
})

describe('remote URL normalization rules (§11 Remote URL normalization)', () => {
  test('the committed catalog carries the overlay as it is, pinned in the metadata', () => {
    const overlay = read('tools/catalog-generator/overlays/remote-url-normalization.json')
    expect(catalog.remoteUrlNormalization).toEqual(JSON.parse(overlay))
    expect(catalog.metadata.overlays['remote-url-normalization.json']).toBe(
      createHash('sha256').update(overlay).digest('hex'),
    )
    expect(catalog.remoteUrlNormalization.path.map(({ id, step }: { id: string; step: number }) => [id, step])).toEqual([
      ['package-version', 3],
      ['semver-segment', 3],
      ['filename-version-run', 3],
      ['v-number', 3],
      ['hex-run', 4],
    ])
  })
})

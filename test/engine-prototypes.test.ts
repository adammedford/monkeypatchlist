// HTMLDocument (§4 Sources, Targets and holders): a curated prototype holder an engine puts on a
// platform singleton's chain where Web IDL has none, `document` → `HTMLDocument.prototype` → `Document.prototype`, with
// its own `constructor` and `@@toStringTag`, and its interface object, held by the global target `Window.HTMLDocument`.
// The generator seam first, then scans through `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { generate, type Sources } from '../tools/catalog-generator/generate.ts'
import { scanBuild } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

const upstream = { '@webref/idl': '1.0.0', webidl2: '24.5.0' }

const globals = `
  [Exposed=*] interface EventTarget {};
  [Global=Window, Exposed=Window] interface Window : EventTarget {};
  [Exposed=Worker] interface WorkerGlobalScope : EventTarget {};
  [Global=(Worker,DedicatedWorker), Exposed=DedicatedWorker]
  interface DedicatedWorkerGlobalScope : WorkerGlobalScope {};
  [Global=(Worker,SharedWorker), Exposed=SharedWorker] interface SharedWorkerGlobalScope : WorkerGlobalScope {};
  [Global=(Worker,ServiceWorker), Exposed=ServiceWorker] interface ServiceWorkerGlobalScope : WorkerGlobalScope {};`

const dom = `
  [Exposed=*] interface Node : EventTarget {};
  [Exposed=Window] interface Document : Node { Element createElement(DOMString localName); };
  partial interface Window { [LegacyUnforgeable] readonly attribute Document document; };`

type Overlay = NonNullable<Sources['enginePrototypes']>

const htmlDocument: Overlay = {
  'HTMLDocument.prototype': {
    engine: 'blink',
    source: 'Chromium, for this test',
    realms: ['window'],
    owner: 'HTMLDocument',
    proto: 'Document.prototype',
    prototypeOf: ['document'],
    interfaceObject: { proto: 'Document' },
  },
}

function catalogOf(
  enginePrototypes: Overlay | undefined,
  idl: Record<string, string> = { dom },
  retained?: Sources['retained'],
) {
  const singletons = { globalNames: [], singletons: ['document'], aliases: {} }
  return JSON.parse(generate({ idl: { globals, ...idl }, singletons, enginePrototypes, retained, upstream }).catalog)
}

describe('engine prototypes in the generator', () => {
  test('HTMLDocument.prototype is a prototype holder between document and Document.prototype', () => {
    const catalog = catalogOf(htmlDocument)

    expect(catalog.holders.window['HTMLDocument.prototype']).toEqual({
      kind: 'prototype',
      owner: 'HTMLDocument',
      proto: 'Document.prototype',
    })
    expect(catalog.holders.window.document).toEqual({ kind: 'instance', owner: 'Document', proto: 'HTMLDocument.prototype' })
    expect(catalog.enginePrototypes).toEqual(htmlDocument)
    for (const realm of ['dedicated-worker', 'shared-worker', 'service-worker']) {
      expect(catalog.holders[realm], realm).not.toHaveProperty('HTMLDocument.prototype')
      expect(catalog.holders[realm], realm).not.toHaveProperty('HTMLDocument')
      expect(Object.keys(catalog.targets[realm]).filter((name) => name.includes('HTMLDocument')), realm).toEqual([])
    }
  })

  // §4: the global target Window.HTMLDocument holds a constructor holder
  // HTMLDocument whose .prototype is HTMLDocument.prototype, which has its own constructor and @@toStringTag.
  test('Window.HTMLDocument holds the HTMLDocument interface object, and the prototype has constructor and @@toStringTag', () => {
    const catalog = catalogOf(htmlDocument)
    const targets = catalog.targets.window

    expect(catalog.holders.window.HTMLDocument).toEqual({ kind: 'constructor', owner: 'HTMLDocument', proto: 'Document' })
    expect(targets['Window.HTMLDocument']).toMatchObject({
      holder: 'global',
      owner: 'Window',
      member: 'HTMLDocument',
      kind: 'interface',
      holds: 'HTMLDocument',
      descriptor: { type: 'data', writable: true, enumerable: false, configurable: true },
    })
    expect(targets['HTMLDocument.prototype']).toMatchObject({
      holder: 'constructor',
      owner: 'HTMLDocument',
      member: 'prototype',
      kind: 'value',
      holds: 'HTMLDocument.prototype',
      descriptor: { type: 'data', writable: false, enumerable: false, configurable: false },
    })
    expect(targets['HTMLDocument.prototype.constructor']).toMatchObject({
      holder: 'prototype',
      owner: 'HTMLDocument',
      member: 'constructor',
      kind: 'function',
      holds: 'HTMLDocument',
      descriptor: { type: 'data', writable: true, enumerable: false, configurable: true },
    })
    expect(targets['HTMLDocument.prototype.@@toStringTag']).toMatchObject({
      holder: 'prototype',
      owner: 'HTMLDocument',
      member: '@@toStringTag',
      kind: 'value',
      descriptor: { type: 'data', writable: false, enumerable: false, configurable: true },
    })
    expect(Object.keys(targets).filter((name) => name.includes('HTMLDocument')).sort()).toEqual([
      'HTMLDocument.prototype',
      'HTMLDocument.prototype.@@toStringTag',
      'HTMLDocument.prototype.constructor',
      'Window.HTMLDocument',
    ])
  })
})

describe('the generator refuses an engine prototype', () => {
  const entry = htmlDocument['HTMLDocument.prototype']!
  const refused = (changes: Partial<Overlay[string]>, idl?: Record<string, string>) => () =>
    catalogOf({ 'HTMLDocument.prototype': { ...entry, ...changes } }, idl)

  test('that is not in between: its proto must be the prototype each holder it goes under had', () => {
    expect(refused({ proto: 'Node.prototype' })).toThrow(
      'the engine prototype HTMLDocument.prototype goes between document and Node.prototype, but the prototype of document is Document.prototype in window',
    )
    expect(refused({ proto: 'Nope.prototype' })).toThrow('inherits from Nope.prototype, which is no holder in window')
    expect(refused({ prototypeOf: ['history'] })).toThrow('is the prototype of history, which is no holder in window')
    expect(refused({ realms: ['dedicated-worker'] })).toThrow(
      'inherits from Document.prototype, which is no holder in dedicated-worker',
    )
  })

  test('that names nothing to go in, or a holder that is taken', () => {
    expect(refused({ realms: [] })).toThrow('lists no realm')
    expect(refused({ prototypeOf: [] })).toThrow('is the prototype of no holder')
    const taken = `${dom}\n[Exposed=Window] interface HTMLDocument : Document {};`
    expect(refused({}, { dom: taken })).toThrow('the engine prototype HTMLDocument.prototype is already a prototype holder in window')
  })

  test('whose interface object cannot go in', () => {
    expect(refused({ interfaceObject: { proto: 'Nope' } })).toThrow(
      'has an interface object inheriting from Nope, which is no constructor holder in window',
    )
    expect(refused({ interfaceObject: { proto: 'Document.prototype' } })).toThrow(
      'has an interface object inheriting from Document.prototype, which is no constructor holder in window',
    )
    expect(refused({ owner: 'Node' })).toThrow('has the interface object Node, which is already a holder in window')
  })

  const retainedOn = (name: string, member: string, holder = 'prototype'): Sources['retained'] => ({
    targets: {
      window: {
        [name]: {
          lastUpstream: 'a test',
          reason: 'a test',
          target: {
            owner: 'HTMLDocument',
            member,
            holder, kind: 'value', spec: 'html',
            descriptor: { type: 'data', writable: true, enumerable: false, configurable: true },
          },
        },
      },
    },
    holders: {},
    dropped: {},
  }) as Sources['retained']

  test('that would have a member besides constructor and @@toStringTag', () => {
    expect(() => catalogOf(htmlDocument, { dom }, retainedOn('HTMLDocument.prototype.x', 'x'))).toThrow(
      'the engine prototype HTMLDocument.prototype has only constructor and @@toStringTag, but HTMLDocument.prototype.x is a target in window',
    )
    expect(() => catalogOf(htmlDocument, { dom }, retainedOn('HTMLDocument.y', 'y', 'constructor'))).toThrow(
      'the engine prototype HTMLDocument.prototype has only constructor and @@toStringTag, but HTMLDocument.y is a target in window',
    )
  })
})

// The shipped resolver, with eslint-scope behind the binding-resolution seam, and the verified drop-in (§19).
const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** Each finding's target and effect, in report order. */
const findings = (report: Report) =>
  report.findings.map(({ target, effect }: { target: unknown; effect: string }) => ({ target, effect }))

describe.each(resolvers)("HTMLDocument.prototype on document's chain, with %s behind the seam", (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test('Object.getPrototypeOf(document) is HTMLDocument.prototype: a new member on it is an add named on it', async () => {
    const { report } = await scan('Object.getPrototypeOf(document).x = y')

    expect(findings(report)).toEqual([
      { target: { realm: 'window', holder: 'prototype', name: 'HTMLDocument.prototype.x' }, effect: 'add' },
    ])
    const steps = report.findings[0].occurrences[0].trace
    expect(steps.at(-1)).toMatchObject({ kind: 'catalog-holder', prototypeOf: 'document', holder: 'HTMLDocument.prototype' })
  })

  test('a member it inherits is a replace named on it, shadowing Document.prototype', async () => {
    const { report } = await scan('Object.getPrototypeOf(document).createElement = w')

    expect(findings(report)).toEqual([
      {
        target: {
          realm: 'window',
          holder: 'prototype',
          name: 'HTMLDocument.prototype.createElement',
          shadows: 'Document.prototype.createElement',
        },
        effect: 'replace',
      },
    ])
    expect(report.findings[0].fingerprint).toBe('window|HTMLDocument.prototype.createElement|replace|unknown')
  })

  test('a change of its prototype is HTMLDocument.prototype.[[Prototype]]', async () => {
    const { report } = await scan('Object.setPrototypeOf(Object.getPrototypeOf(document), X)')

    expect(findings(report)).toEqual([
      {
        target: { realm: 'window', holder: 'prototype', name: 'HTMLDocument.prototype.[[Prototype]]' },
        effect: 'prototype-change',
      },
    ])
  })

  test('the prototype after it is Document.prototype', async () => {
    const { report } = await scan('Object.getPrototypeOf(Object.getPrototypeOf(document)).z = 1')

    expect(findings(report)).toEqual([
      { target: { realm: 'window', holder: 'prototype', name: 'Document.prototype.z' }, effect: 'add' },
    ])
  })

  // §4: `document.createElement = w` is unchanged. Naming it `document.createElement`, shadowing
  // `Document.prototype.createElement`, is a singleton's shadowing write. Either way it is never named on HTMLDocument.prototype.
  test('a write on document itself is never named on HTMLDocument.prototype', async () => {
    const { report } = await scan('document.createElement = w')

    expect(JSON.stringify(report.findings)).not.toContain('HTMLDocument')
  })
})

// §4: Window.HTMLDocument is a global target holding the HTMLDocument interface
// object, and HTMLDocument.prototype has its own constructor and @@toStringTag.
describe.each(resolvers)('the HTMLDocument interface, with %s behind the seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test("deleting the prototype's @@toStringTag is a delete of HTMLDocument.prototype.@@toStringTag", async () => {
    const { report } = await scan('delete Object.getPrototypeOf(document)[Symbol.toStringTag]')

    expect(findings(report)).toEqual([
      { target: { realm: 'window', holder: 'prototype', name: 'HTMLDocument.prototype.@@toStringTag' }, effect: 'delete' },
    ])
  })

  test("assigning the prototype's constructor is a replace of HTMLDocument.prototype.constructor", async () => {
    const { report } = await scan('Object.getPrototypeOf(document).constructor = X')

    expect(findings(report)).toEqual([
      { target: { realm: 'window', holder: 'prototype', name: 'HTMLDocument.prototype.constructor' }, effect: 'replace' },
    ])
  })

  test("deleting the prototype's constructor is a delete of HTMLDocument.prototype.constructor", async () => {
    const { report } = await scan('delete Object.getPrototypeOf(document).constructor')

    expect(findings(report)).toEqual([
      { target: { realm: 'window', holder: 'prototype', name: 'HTMLDocument.prototype.constructor' }, effect: 'delete' },
    ])
  })

  test('the global HTMLDocument reaches the same prototype', async () => {
    const { report } = await scan('HTMLDocument.prototype.x = 1')

    expect(findings(report)).toEqual([
      { target: { realm: 'window', holder: 'prototype', name: 'HTMLDocument.prototype.x' }, effect: 'add' },
    ])
  })

  test('assigning window.HTMLDocument is a replace of the global target Window.HTMLDocument', async () => {
    const { report } = await scan('window.HTMLDocument = X')

    expect(findings(report)).toEqual([
      { target: { realm: 'window', holder: 'global', name: 'Window.HTMLDocument' }, effect: 'replace' },
    ])
  })

  test("the interface object's constructor chain reaches Document", async () => {
    const { report } = await scan('Object.getPrototypeOf(HTMLDocument).y = 1')

    expect(findings(report)).toEqual([{ target: { realm: 'window', holder: 'constructor', name: 'Document.y' }, effect: 'add' }])
  })
})

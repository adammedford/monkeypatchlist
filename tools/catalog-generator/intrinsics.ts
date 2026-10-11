import {
  realms,
  type CatalogHolder,
  type Descriptor,
  type EngineExtension,
  type EsAddition,
  type EsProseProperty,
  type Holder,
  type MemberKind,
  type PropertyKind,
  type Realm,
} from '../../src/catalog.ts'
import type { PlacedTarget } from './targets.ts'

/** A biblio as `@tc39/ecma262-biblio` and `@tc39/ecma402-biblio` publish it. Only its clause entries are read. */
export interface Biblio {
  entries: readonly BiblioEntry[]
}

export interface BiblioEntry {
  type: string
  id?: string
  number?: string
  title?: string
  /** Set on the clause of an abstract operation. */
  aoid?: string | null
}

/** The pinned ECMAScript inputs a generation reads (§4 Sources). */
export interface EcmascriptSources {
  ecma262: Biblio
  /** ECMA-402, for `Intl`. */
  ecma402: Biblio
  /** The curated overlay of small ES additions, such as `Temporal`, by name. */
  additions: Readonly<Record<string, EsAddition>>
  /** The curated overlay of engine extensions, such as V8's `Error.stackTraceLimit`, by the path of each property. */
  engineExtensions: Readonly<Record<string, EngineExtension>>
  /**
   * The curated overlay of ECMA-262 own properties without a clause of their own, such as `Function.prototype.caller`,
   * by the path of each property.
   */
  proseProperties: Readonly<Record<string, EsProseProperty>>
}

/** The ECMAScript part of the catalog: each realm has its own intrinsics. */
export interface IntrinsicsCatalog {
  targets: Record<Realm, Record<string, PlacedTarget>>
  holders: Record<Realm, Record<string, CatalogHolder>>
}

/** How a clause title defines a property. */
type Form = 'function' | 'value' | 'get' | 'set'

/** A property one clause defines, by path: `['Array', 'prototype', 'map']`, `['Array', 'prototype', '@@iterator']`. */
interface Defined {
  path: readonly string[]
  form: Form
  spec: string
}

/**
 * A clause title that defines a property: `Array.prototype.map ( callbackfn [ , thisArg ] )`, `get Map.prototype.size`,
 * `Array.prototype [ %Symbol.iterator% ] ( )`, `Math.PI`, or `Array ( . . . )` in the global object's clause.
 */
const titlePattern =
  /^(?:(get|set) )?(%[^%\s]+%|[A-Za-z_$][\w$]*)((?:\.[A-Za-z_$][\w$]*)*)(?: ?\[ %Symbol\.(\w+)% \])?( \(.*\))?$/

function parseTitle(title: string): Omit<Defined, 'spec'> | undefined {
  const match = titlePattern.exec(title)
  if (!match) return undefined
  const [, accessor, root = '', rest = '', symbol, parameters] = match
  const path = [root, ...rest.split('.').slice(1), ...(symbol ? [`@@${symbol}`] : [])]
  const form: Form = accessor === 'get' || accessor === 'set' ? accessor : parameters ? 'function' : 'value'
  return { path, form }
}

/** The clauses of ECMA-262 that the built-in objects are defined in. */
const ecma262Clauses = {
  /** Clause 18: the built-in objects are described in clauses 19 through 28 and in Annex B.2. */
  first: 'sec-global-object',
  last: 'sec-reflection',
  annex: 'sec-additional-built-in-properties',
  /** The clause whose single-name titles are the namespace objects on the global object. */
  namespaces: 'sec-other-properties-of-the-global-object',
  /** The clause whose subclauses name the NativeError constructors. */
  nativeErrors: 'sec-native-error-types-used-in-this-standard',
  /** The clauses whose single-name titles are properties of the global object. */
  global: [
    'sec-value-properties-of-the-global-object',
    'sec-function-properties-of-the-global-object',
    'sec-constructor-properties-of-the-global-object',
    'sec-other-properties-of-the-global-object',
    'sec-additional-properties-of-the-global-object',
  ],
}

/** A property of an intrinsic, merged from every clause that defines it. */
interface Property {
  /** The intrinsic it is on, e.g. `Array.prototype`; `undefined` for the global object. */
  on: string | undefined
  key: string
  kind: 'function' | 'value' | 'accessor'
  /** For an accessor, whether it has a setter. */
  setter: boolean
  spec: string
}

/**
 * Builds the ECMAScript intrinsics of every realm from ECMA-262 and ECMA-402 (§4 Sources). A property of the global
 * object is named on the realm's global interface, as Web IDL's global members are: `Window.Promise`,
 * `DedicatedWorkerGlobalScope.Promise`.
 */
export function buildIntrinsics(sources: EcmascriptSources, globals: Record<Realm, string>): IntrinsicsCatalog {
  const upstream = combine([readEcma262(sources.ecma262), readEcma402(sources.ecma402)])
  const read = combine([upstream, ...readAdditions(sources.additions, upstream)])
  const globalFunctions = new Set(read.globalProperties.filter(({ form }) => form === 'function').map(nameOf))
  const missing = read.constructors.includes('TypedArray') && typedArrays.find((name) => !globalFunctions.has(name))
  if (missing) throw new Error(`${missing} is not a constructor property of the global object in ECMA-262`)
  const expand = generics({ TypedArray: typedArrays, NativeError: read.nativeErrors })
  const rooted = naming(new Set(read.globalProperties.map(nameOf)), new Set(read.constructors))

  const properties = merge([
    ...read.globalProperties.map((defined) => ({ ...defined, global: true })),
    ...read.properties.flatMap(expand).flatMap(rooted),
  ])
  const facts: Facts = {
    constructors: new Set([
      ...properties.filter(({ kind }) => kind === 'function').map(pathOf),
      ...read.constructors.flatMap((constructor) => expand({ path: [constructor] }).flatMap(rooted).map(nameOf)),
    ]),
    namespaces: new Set(read.namespaces),
    errors: new Set([...read.nativeErrors, ...errorsBesidesNativeErrors]),
  }
  // Every object a property is on, every prototype object (even one with no properties of its own), and every
  // namespace object.
  const holders = new Set([
    ...properties.flatMap(({ on }) => (on === undefined ? [] : [on])),
    ...properties.filter(({ key, on }) => key === 'prototype' && on !== undefined).map(pathOf).map(canonical),
    ...read.namespaces,
  ])
  const holderRecords = new Map([...holders].sort().map((name) => [name, holderRecord(name, facts)]))
  for (const [name, { proto }] of holderRecords) {
    if (proto && !holders.has(proto)) throw new Error(`the prototype of ${name}, ${proto}, is not in the catalog`)
  }

  const targets = Object.fromEntries(realms.map((realm) => [realm, {}])) as Record<Realm, Record<string, PlacedTarget>>
  const realmHolders = Object.fromEntries(realms.map((realm) => [realm, Object.fromEntries(holderRecords)])) as Record<
    Realm,
    Record<string, CatalogHolder>
  >
  // Each property ECMA-262, ECMA-402 or an ES addition defines, by the intrinsic it is on and its key.
  const defined = new Set(properties.map(({ on, key }) => `${on ?? ''}|${key}`))
  const prose = curatedTargets('ECMA-262 prose property', credited(sources.proseProperties, () => 'ecma262'), {
    facts,
    holders,
    defined,
  })
  const extensions = curatedTargets('engine extension', credited(sources.engineExtensions, ({ engine }) => engine), {
    facts,
    holders,
    defined: new Set([...defined, ...prose.map(([name]) => definedKey(name))]),
  })
  for (const realm of realms) {
    const global = globals[realm]
    for (const property of properties) {
      const { on, key, kind, spec } = property
      const holder = on === undefined ? 'global' : holderKind(on, facts)
      const holds = heldBy(property, holders)
      targets[realm][on === undefined ? `${global}.${key}` : pathOf(property)] = {
        owner: on === undefined ? global : on.replace(/\.prototype$/, ''),
        member: key,
        holder,
        kind: kind === 'value' && holds ? heldKind(holds, facts) : kind,
        spec,
        descriptor: descriptorOf(property, holder),
        ...(holds && { holds }),
      }
    }
    for (const [name, target] of [...prose, ...extensions]) targets[realm][name] = { ...target }
  }
  return { targets, holders: realmHolders }
}

/** A curated entry's property as `defined` keys it: the intrinsic its path is on, and its key. */
function definedKey(name: string): string {
  const dot = name.lastIndexOf('.')
  return `${name.slice(0, Math.max(dot, 0))}|${name.slice(dot + 1)}`
}

/** An entry of a curated overlay of single properties, with the spec its target is credited to. */
interface CuratedProperty {
  spec: string
  kind: PropertyKind
  descriptor: Descriptor
}

/**
 * A curated overlay's entries, each with the spec `specOf` credits it to: `ecma262` for an ECMA-262 prose property, and
 * its engine for an engine extension.
 */
function credited<Entry extends EsProseProperty | EngineExtension>(
  entries: Readonly<Record<string, Entry>>,
  specOf: (entry: Entry) => string,
): Record<string, CuratedProperty> {
  return Object.fromEntries(
    Object.entries(entries).map(([name, entry]) => [name, { spec: specOf(entry), kind: entry.kind, descriptor: entry.descriptor }]),
  )
}

/**
 * The targets of a curated overlay of single properties (§4 Sources), by name: the ECMA-262 own properties without a
 * clause of their own, or the engine extensions. Each is a member of the intrinsic its path is on, with the kind and
 * descriptor its entry gives it, credited to `ecma262` or to the engine. Refuses an entry for a property already
 * `defined` (by a clause of ECMA-262 or ECMA-402, an ES addition, or for an engine extension, a prose property), so an
 * engine extension is dropped once its property is standardized; an entry on anything but an intrinsic, or that names
 * the intrinsic by another path than the catalog's; and one whose kind and descriptor disagree.
 */
function curatedTargets(
  what: string,
  entries: Readonly<Record<string, CuratedProperty>>,
  { facts, holders, defined }: { facts: Facts; holders: ReadonlySet<string>; defined: ReadonlySet<string> },
): [string, PlacedTarget][] {
  return Object.keys(entries)
    .sort()
    .map((name) => {
      const { spec, kind, descriptor } = entries[name] as CuratedProperty
      const dot = name.lastIndexOf('.')
      const path = name.slice(0, Math.max(dot, 0))
      const on = canonical(path)
      const refuse = (why: string) => new Error(`the ${what} ${name} ${why}`)
      if (!holders.has(on)) throw refuse('is not on an ECMAScript intrinsic')
      // The entry's path is its target's name, so it must name the intrinsic as the catalog does.
      if (on !== path) throw refuse(`must be named from ${on}, the catalog's name for the intrinsic it is on`)
      if (defined.has(definedKey(name))) {
        throw refuse('is already defined by ECMA-262, ECMA-402 or an ES addition')
      }
      if ((kind === 'accessor') !== (descriptor.type === 'accessor')) {
        throw refuse(`has kind ${kind}, but ${descriptor.type === 'accessor' ? 'an accessor' : 'a data'} descriptor`)
      }
      return [
        name,
        {
          owner: on.replace(/\.prototype$/, ''),
          member: name.slice(dot + 1),
          holder: holderKind(on, facts),
          kind,
          spec,
          descriptor: { ...descriptor },
        },
      ]
    })
}

/**
 * The holder a data property's initial value is, if any: `Window.Array` holds `Array`, `Array.prototype` holds
 * `Array.prototype`, and a prototype's `constructor` holds its constructor.
 */
function heldBy(property: Property, holders: ReadonlySet<string>): string | undefined {
  if (property.kind === 'accessor') return undefined
  const { key } = property
  const on = property.on === undefined ? undefined : longName(property.on)
  const value = key === 'constructor' && on?.endsWith('.prototype') ? on.slice(0, -'.prototype'.length) : pathOf(property)
  return holders.has(canonical(value)) ? canonical(value) : undefined
}

/**
 * The kind of a value property that holds `holder`. It is a `namespace` when it holds a namespace object, as Web IDL's
 * `Window.console` does: `Window.Math`, `Temporal.Now`. It is a `function` when it holds a constructor, as
 * `Array.prototype.constructor` does, or `Function.prototype`, which ECMA-262 makes a built-in function object itself.
 */
function heldKind(holder: string, facts: Facts): MemberKind {
  if (facts.namespaces.has(holder)) return 'namespace'
  return facts.constructors.has(holder) || holder === 'Function.prototype' ? 'function' : 'value'
}

/** What ECMA-262 says about each intrinsic beyond its properties. */
interface Facts {
  /** The intrinsics that are functions, so their holders are `constructor`s. */
  constructors: ReadonlySet<string>
  namespaces: ReadonlySet<string>
  /** The error constructors whose prototype is `Error` rather than `Function.prototype`. */
  errors: ReadonlySet<string>
}

/** The TypedArray constructors, which ECMA-262 defines once as `TypedArray` (Table "The TypedArray Constructors"). */
const typedArrays = [
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'BigInt64Array',
  'BigUint64Array',
  'Float16Array',
  'Float32Array',
  'Float64Array',
]

/** Error constructors outside NativeError whose prototype is `Error` (ECMA-262 "Properties of the … Constructor"). */
const errorsBesidesNativeErrors = ['AggregateError', 'SuppressedError']

/** Expands a definition on a generic intrinsic (`TypedArray.prototype`) into one per intrinsic it stands for. */
function generics(names: Readonly<Record<string, readonly string[]>>) {
  return <T extends { path: readonly string[] }>(defined: T): T[] => {
    const [root = '', ...rest] = defined.path
    const expanded = Object.hasOwn(names, root) ? (names[root] ?? []) : [root]
    return expanded.map((name) => ({ ...defined, path: [name, ...rest] }))
  }
}

/**
 * The intrinsics that no property of the global object names, by their ECMA-262 or ECMA-402 %name%, each with its
 * [[Prototype]] as its "Properties of …" clause states. The generator refuses one this list lacks, so each is reviewed.
 */
const unnamedIntrinsics: Readonly<Record<string, string>> = {
  '%TypedArray%': 'Function.prototype',
  '%TypedArray%.prototype': 'Object.prototype',
  '%GeneratorFunction%': 'Function',
  '%GeneratorFunction%.prototype': 'Function.prototype',
  '%GeneratorPrototype%': 'Iterator.prototype',
  '%AsyncGeneratorFunction%': 'Function',
  '%AsyncGeneratorFunction%.prototype': 'Function.prototype',
  '%AsyncGeneratorPrototype%': '%AsyncIteratorPrototype%',
  '%AsyncFunction%': 'Function',
  '%AsyncFunction%.prototype': 'Function.prototype',
  '%AsyncIteratorPrototype%': 'Object.prototype',
  '%ArrayIteratorPrototype%': 'Iterator.prototype',
  '%StringIteratorPrototype%': 'Iterator.prototype',
  '%RegExpStringIteratorPrototype%': 'Iterator.prototype',
  '%MapIteratorPrototype%': 'Iterator.prototype',
  '%SetIteratorPrototype%': 'Iterator.prototype',
  '%IteratorHelperPrototype%': 'Iterator.prototype',
  '%WrapForValidIteratorPrototype%': 'Iterator.prototype',
  '%IntlSegmentsPrototype%': 'Object.prototype',
  '%IntlSegmentIteratorPrototype%': 'Iterator.prototype',
}

/** Paths ECMA-262 also names directly: `%GeneratorFunction.prototype.prototype%` is `%GeneratorPrototype%`. */
const aliases: Readonly<Record<string, string>> = {
  '%GeneratorFunction%.prototype.prototype': '%GeneratorPrototype%',
  '%AsyncGeneratorFunction%.prototype.prototype': '%AsyncGeneratorPrototype%',
}

/** The name the catalog gives the intrinsic at `path`. */
function canonical(path: string): string {
  return aliases[path] ?? path
}

/** The path to an intrinsic from its constructor, where ECMA-262 has one: `%GeneratorFunction%.prototype.prototype`. */
function longName(name: string): string {
  return Object.keys(aliases).find((path) => aliases[path] === name) ?? name
}

/** Intrinsics ECMA-262 says ECMAScript code can never reach directly, so no write lands on them. */
const unreachable = new Set(['%AsyncFromSyncIteratorPrototype%'])

/**
 * Names the intrinsic a definition's path starts from. A global property keeps its name, and an intrinsic function no
 * global property names takes ECMA-262's %name% (`GeneratorFunction` → `%GeneratorFunction%`). An unreachable
 * intrinsic defines nothing, and a path from anything else is refused.
 */
function naming(globalNames: ReadonlySet<string>, constructors: ReadonlySet<string>) {
  return <T extends { path: readonly string[] }>(defined: T): T[] => {
    const [root = '', ...rest] = defined.path
    if (unreachable.has(root)) return []
    if (root.startsWith('%') || globalNames.has(root)) return [defined]
    if (constructors.has(root)) return [{ ...defined, path: [`%${root}%`, ...rest] }]
    throw new Error(`${defined.path.join('.')} starts from ${root}, which is neither a global property nor an intrinsic`)
  }
}

/**
 * A holder's record. Its prototype follows ECMA-262 clause 18: a built-in function's is `Function.prototype`, any other
 * built-in object's is `Object.prototype`, whose own is null. The exceptions are the error constructors, the
 * TypedArray constructors and their prototype objects, and the intrinsics no global property names. `Object.prototype`
 * is an immutable prototype exotic object (ECMA-262 "Properties of the Object Prototype Object").
 */
function holderRecord(name: string, facts: Facts): CatalogHolder {
  const kind = holderKind(name, facts)
  const owner = name.replace(/\.prototype$/, '')
  if (name === 'Object.prototype') return { kind, owner, proto: null, immutablePrototype: true }
  if (name.startsWith('%')) {
    const proto = unnamedIntrinsics[name]
    if (proto === undefined) throw new Error(`${name} is an intrinsic no global property names, and it is not reviewed`)
    return { kind, owner, proto }
  }
  const parent = facts.errors.has(owner) ? 'Error' : typedArrays.includes(owner) ? '%TypedArray%' : undefined
  if (parent) return { kind, owner, proto: kind === 'constructor' ? parent : `${parent}.prototype` }
  return { kind, owner, proto: kind === 'constructor' ? 'Function.prototype' : 'Object.prototype' }
}

/** What a source defines. */
interface Read {
  /** Properties of the global object. */
  globalProperties: Defined[]
  /** Properties of the other intrinsics. */
  properties: Defined[]
  namespaces: string[]
  /** Intrinsic functions defined outside the global object: `%TypedArray%`, `NativeError`. */
  constructors: string[]
  /** The NativeError constructors: `EvalError`, `RangeError`, … */
  nativeErrors: string[]
}

function readEcma262(biblio: Biblio): Read {
  const clauses = biblio.entries.filter((entry) => entry.type === 'clause')
  const numberOf = (id: string) => {
    const number = clauses.find((entry) => entry.id === id)?.number
    if (number === undefined) throw new Error(`ECMA-262 has no clause ${id}`)
    return number
  }
  const [first, last] = [Number(numberOf(ecma262Clauses.first)), Number(numberOf(ecma262Clauses.last))]
  const annex = numberOf(ecma262Clauses.annex)
  const globalClauses = ecma262Clauses.global.map(numberOf)
  const namespaceClause = numberOf(ecma262Clauses.namespaces)
  const nativeErrorClause = numberOf(ecma262Clauses.nativeErrors)
  const builtIn = (number: string) => {
    const top = Number(number.split('.')[0])
    return (top >= first && top <= last) || within(number, annex)
  }

  const read: Read = { globalProperties: [], properties: [], namespaces: [], constructors: [], nativeErrors: [] }
  for (const { number, title, aoid } of clauses) {
    if (aoid || number === undefined || title === undefined || !builtIn(number)) continue
    const parsed = parseTitle(title)
    if (!parsed) continue
    const defined = { ...parsed, spec: 'ecma262' }
    const name = nameOf(defined)
    if (parsed.path.length > 1) read.properties.push(defined)
    else if (globalClauses.some((global) => within(number, global))) {
      read.globalProperties.push(defined)
      if (within(number, namespaceClause)) read.namespaces.push(name)
    } else if (parsed.form === 'function') read.constructors.push(name)
    else if (number.startsWith(`${nativeErrorClause}.`) && !number.slice(nativeErrorClause.length + 1).includes('.')) {
      read.nativeErrors.push(name)
    }
  }
  return read
}

/** The clause of ECMA-402 that defines the Intl object, the first of the built-in objects it adds. */
const intlClause = 'intl-object'

/**
 * Reads ECMA-402: the `Intl` namespace, which is a property of the global object ("The Intl Object"), and the
 * properties its clauses define, from the Intl object's clause on.
 */
function readEcma402(biblio: Biblio): Read {
  const clauses = biblio.entries.filter((entry) => entry.type === 'clause')
  const intl = clauses.find((entry) => entry.id === intlClause)?.number
  if (intl === undefined) throw new Error(`ECMA-402 has no clause ${intlClause}`)
  const read: Read = {
    globalProperties: [{ path: ['Intl'], form: 'value', spec: 'ecma402' }],
    properties: [],
    namespaces: ['Intl'],
    constructors: [],
    nativeErrors: [],
  }
  for (const { number, title, aoid } of clauses) {
    if (aoid || number === undefined || title === undefined || !(Number(number.split('.')[0]) >= Number(intl))) continue
    const parsed = parseTitle(title)
    if (!parsed) continue
    const defined = { ...parsed, spec: 'ecma402' }
    if (parsed.path.length > 1) read.properties.push(defined)
    else if (parsed.form === 'function') read.constructors.push(nameOf(defined))
  }
  return read
}

/**
 * Reads the ES additions overlay (§4 Sources). Each entry lists its properties as ECMA-262 titles its clauses would
 * have. A single name is a property of the global object. An entry may only add: a property ECMA-262 or ECMA-402
 * already defines is refused, so the overlay entry is dropped once its proposal lands upstream.
 */
function readAdditions(additions: Readonly<Record<string, EsAddition>>, upstream: Read): Read[] {
  // A property by the object it is on and its key; a property of the global object is on "".
  const keyOf = ({ path }: { path: readonly string[] }) => `${path.slice(0, -1).join('.')}|${path.at(-1)}`
  const defined = new Set([...upstream.globalProperties, ...upstream.properties].map(keyOf))
  return Object.keys(additions)
    .sort()
    .map((name) => {
      const { spec, namespaces, properties } = additions[name] as EsAddition
      const read: Read = {
        globalProperties: [],
        properties: [],
        namespaces: [...namespaces],
        constructors: [],
        nativeErrors: [],
      }
      for (const title of properties) {
        const parsed = parseTitle(title)
        if (!parsed) throw new Error(`the ${name} addition lists "${title}", which names no property`)
        if (defined.has(keyOf(parsed))) {
          throw new Error(`the ${name} addition defines ${nameOf(parsed)}, which ECMA-262 or ECMA-402 already defines`)
        }
        if (parsed.path.length > 1) read.properties.push({ ...parsed, spec })
        else read.globalProperties.push({ ...parsed, spec })
      }
      const paths = new Set([...read.globalProperties, ...read.properties].map(nameOf))
      const missing = namespaces.find((namespace) => !paths.has(namespace))
      if (missing) {
        throw new Error(`the ${name} addition declares ${missing} a namespace, but defines no property ${missing}`)
      }
      return read
    })
}

/** What several sources define together, in order: an earlier source is credited with a property both define. */
function combine(reads: readonly Read[]): Read {
  return {
    globalProperties: reads.flatMap((read) => read.globalProperties),
    properties: reads.flatMap((read) => read.properties),
    namespaces: reads.flatMap((read) => read.namespaces),
    constructors: reads.flatMap((read) => read.constructors),
    nativeErrors: reads.flatMap((read) => read.nativeErrors),
  }
}

/**
 * Merges the clauses that define each property. A getter and a setter make one accessor, and a clause that only
 * groups them adds nothing. The first source to define a property is credited with it.
 */
function merge(definitions: readonly (Defined & { global?: boolean })[]): Property[] {
  const merged = new Map<string, Property>()
  for (const { path, form, spec, global } of definitions) {
    const on = global ? undefined : canonical(path.slice(0, -1).join('.'))
    const key = path.at(-1) ?? ''
    const name = `${on ?? ''}|${key}`
    const kind = form === 'function' ? 'function' : form === 'value' ? 'value' : 'accessor'
    const earlier = merged.get(name)
    if (!earlier) {
      merged.set(name, { on, key, kind, setter: form === 'set', spec })
      continue
    }
    if (earlier.kind !== kind && (earlier.kind === 'function' || kind === 'function')) {
      throw new Error(`${path.join('.')} is defined both as ${article(earlier.kind)} and as ${article(kind)}`)
    }
    if (kind === 'accessor') earlier.kind = 'accessor'
    if (form === 'set') earlier.setter = true
  }
  return [...merged.values()]
}

/** Whether clause `number` is `parent` or nested in it. */
function within(number: string, parent: string): boolean {
  return number === parent || number.startsWith(`${parent}.`)
}

function nameOf({ path }: { path: readonly string[] }): string {
  return path.join('.')
}

function pathOf({ on, key }: Pick<Property, 'on' | 'key'>): string {
  return on === undefined ? key : `${on}.${key}`
}

function article(kind: Property['kind']): string {
  return kind === 'accessor' ? 'an accessor' : `a ${kind}`
}

function holderKind(holder: string, { constructors, namespaces }: Facts): Holder {
  if (namespaces.has(holder)) return 'namespace'
  if (constructors.has(holder)) return 'constructor'
  if (holder.endsWith('.prototype') || /^%\w+Prototype%$/.test(holder)) return 'prototype'
  throw new Error(`cannot tell what kind of holder ${holder} is`)
}

/** The generator and async function intrinsics, whose `constructor` properties ECMA-262 makes non-writable. */
const generatorFamily = new Set([
  '%GeneratorFunction%.prototype',
  '%GeneratorPrototype%',
  '%AsyncGeneratorFunction%.prototype',
  '%AsyncGeneratorPrototype%',
  '%AsyncFunction%.prototype',
])

const data = (writable: boolean, configurable: boolean): Descriptor => ({
  type: 'data',
  writable,
  enumerable: false,
  configurable,
})

/**
 * A property's descriptor. ECMA-262 clause 18 gives the defaults: every data property is writable, non-enumerable and
 * configurable, and every accessor is non-enumerable and configurable. The exceptions are those the property's own
 * clause states.
 */
function descriptorOf({ on, key, kind, setter }: Property, holder: Holder): Descriptor {
  if (kind === 'accessor') return { type: 'accessor', setter, enumerable: false, configurable: true }
  if (kind === 'function') {
    if (key === '@@hasInstance') return data(false, false) // Function.prototype [ %Symbol.hasInstance% ]
    if (key === '@@toPrimitive') return data(false, true) // Date.prototype and Symbol.prototype [ %Symbol.toPrimitive% ]
    return data(true, true)
  }
  if (on === undefined) return ['NaN', 'Infinity', 'undefined'].includes(key) ? data(false, false) : data(true, true)
  if (key === 'prototype' && holder === 'constructor') return data(false, false) // e.g. Array.prototype
  if (key === 'prototype') return data(false, true) // %GeneratorFunction.prototype.prototype% and its async kin
  if (key === 'constructor' && generatorFamily.has(on)) return data(false, true)
  if (key === '@@toStringTag' || key === '@@unscopables') return data(false, true)
  if (on === 'Symbol' || on === 'Math' || on === 'Number') return data(false, false) // well-known symbols, constants
  if (key === 'BYTES_PER_ELEMENT') return data(false, false) // TypedArray.BYTES_PER_ELEMENT and on its prototype
  return data(true, true)
}

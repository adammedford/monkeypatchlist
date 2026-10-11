import * as WebIDL2 from 'webidl2'
import {
  namedPropertiesObject,
  realms,
  type AssignKind,
  type CatalogHolder,
  type CatalogTarget,
  type Descriptor,
  type Holder,
  type InstanceData,
  type InstanceMember,
  type MemberKind,
  type Realm,
} from '../../src/catalog.ts'
import { Exposure } from './exposure.ts'
import { prototypeProperty, synthesize, type Synthesized } from './synthesized.ts'

type Container =
  | WebIDL2.InterfaceType
  | WebIDL2.InterfaceMixinType
  | WebIDL2.NamespaceType
  | WebIDL2.CallbackInterfaceType

type Member = Container['members'][number]

const containerTypes = new Set<string>(['interface', 'interface mixin', 'namespace', 'callback interface'])

function isContainer(definition: WebIDL2.IDLRootType): definition is Container {
  return containerTypes.has(definition.type)
}

interface Declared {
  definition: Container
  spec: string
}

/** A member merged onto the interface or namespace that will hold it, with where it was declared. */
interface OwnedMember {
  member: Member
  spec: string
  /** The definition the member appears in, a partial or the original. */
  declaredOn: Container
  mixin?: string
}

/**
 * Parses every IDL file, merges partials and mixins (`includes`) into their interfaces, and, in every realm each is
 * exposed in (§4), adds the holders each interface and namespace defines, the global or namespace properties that
 * reach them, and each member, as a target on its holder or as a per-instance member. Specs are read in shortname
 * order, so an overload is credited to the first spec that declares it.
 */
export function buildCatalog(
  idl: Readonly<Record<string, string>>,
): PlacedSections & { attributeTypes: AttributeTypes } {
  const bases = new Map<string, Declared>()
  const partials: Declared[] = []
  const includes: { statement: WebIDL2.IncludesType; spec: string }[] = []
  for (const spec of Object.keys(idl).sort()) {
    for (const definition of WebIDL2.parse(idl[spec] ?? '', { sourceName: spec })) {
      if (definition.type === 'includes') includes.push({ statement: definition, spec })
      if (!isContainer(definition)) continue
      if (definition.partial) partials.push({ definition, spec })
      else if (bases.has(definition.name)) throw new Error(`${definition.name} (${spec}) is defined twice`)
      else bases.set(definition.name, { definition, spec })
    }
  }

  const declarations = new Map<string, Declared[]>()
  for (const [name, base] of bases) declarations.set(name, [base])
  for (const partial of partials) {
    const { type, name } = partial.definition
    const merged = declarations.get(name)
    if (merged?.[0]?.definition.type !== type) {
      throw new Error(`partial ${type} ${name} (${partial.spec}) has no base definition`)
    }
    merged.push(partial)
  }

  const membersOf = (name: string, mixin?: string): OwnedMember[] =>
    (declarations.get(name) ?? []).flatMap(({ definition, spec }) =>
      definition.members.map((member) => ({ member, spec, declaredOn: definition, ...(mixin && { mixin }) })),
    )

  const owners = new Map<string, Owner>()
  for (const [name, base] of bases) {
    if (base.definition.type !== 'interface mixin') owners.set(name, { base, members: membersOf(name) })
  }
  for (const { statement, spec } of includes) {
    const where = `${statement.target} includes ${statement.includes} (${spec})`
    const host = owners.get(statement.target)
    if (host?.base.definition.type !== 'interface') throw new Error(`${where}: no interface ${statement.target}`)
    if (bases.get(statement.includes)?.definition.type !== 'interface mixin') {
      throw new Error(`${where}: no interface mixin ${statement.includes}`)
    }
    host.members.push(...membersOf(statement.includes, statement.includes))
  }

  const exposure = new Exposure([...bases.values(), ...partials])
  const realmsOf = new Map([...owners].map(([name, { base }]) => [name, exposure.ofDefinition(base)]))
  const globalChain = new Set(
    [...bases.values()]
      .filter(({ definition }) => definition.type === 'interface' && isGlobal(definition))
      .flatMap(({ definition: { name } }) => [name, ...ancestorsOf(name, bases)]),
  )
  const context: Context = { bases, owners, exposure, realmsOf, globalChain }
  const catalog = new Placed()
  for (const owner of owners.values()) {
    placeHolders(catalog, owner, context)
    for (const owned of owner.members) placeMember(catalog, owner, owned, context)
    placeSynthesized(catalog, owner, context)
  }
  return { ...catalog.sections(), attributeTypes: attributeTypesOf(owners) }
}

/**
 * The interface each attribute's value is an instance of, by owner and then member, for the attributes whose IDL type
 * is one interface, or a nullable one: `Window` → `history` → `History`, `Document` → `location` →
 * `Location`. It is not serialized: the generator reads it to resolve platform singletons.
 */
export type AttributeTypes = ReadonlyMap<string, ReadonlyMap<string, string>>

function attributeTypesOf(owners: ReadonlyMap<string, Owner>): AttributeTypes {
  const types = new Map<string, Map<string, string>>()
  for (const [name, { members }] of owners) {
    for (const { member } of members) {
      if (member.type !== 'attribute' || member.idlType.union || member.idlType.generic) continue
      const { idlType } = member.idlType
      if (typeof idlType !== 'string' || owners.get(idlType)?.base.definition.type !== 'interface') continue
      let byMember = types.get(name)
      if (!byMember) types.set(name, (byMember = new Map()))
      if (!byMember.has(member.name)) byMember.set(member.name, idlType)
    }
  }
  return types
}

/** An interface, callback interface or namespace, with its members merged from partials and mixins. */
interface Owner {
  base: Declared
  members: OwnedMember[]
}

interface Context {
  bases: ReadonlyMap<string, Declared>
  owners: ReadonlyMap<string, Owner>
  exposure: Exposure
  /** The realms each owner is exposed in. */
  realmsOf: ReadonlyMap<string, Realm[]>
  /** The `[Global]` interfaces, of any global, and the interfaces they inherit. */
  globalChain: ReadonlySet<string>
}

/**
 * The ECMAScript intrinsics, of the same realm, that Web IDL chains end in: an interface prototype object or named
 * properties object whose interface inherits none has `%Object.prototype%` as its [[Prototype]] (DOMException's has
 * `%Error.prototype%`), an interface object whose interface inherits none and a legacy callback interface object have
 * `%Function.prototype%`, and a namespace object has `%Object.prototype%` (Web IDL, ECMAScript binding).
 */
const intrinsics = {
  objectPrototype: 'Object.prototype',
  functionPrototype: 'Function.prototype',
  errorPrototype: 'Error.prototype',
} as const

/**
 * The namespaces whose namespace object has an empty object of its own as its [[Prototype]], created as if by
 * OrdinaryObjectCreate(%Object.prototype%), instead of `%Object.prototype%`. Their specs define this in prose, not in
 * IDL: the Console Standard does for `console`, for historical web compatibility.
 */
const emptyPrototypes = new Set(['console'])

/**
 * The interfaces whose instances are immutable prototype exotic objects. Their specs define this in prose, not in IDL:
 * HTML's `Location` objects have a [[SetPrototypeOf]] that returns SetImmutablePrototype.
 */
const immutableInstances = new Set(['Location'])

/**
 * Adds the holders an owner defines in each realm it is exposed in, and the properties that reach them:
 * - an interface: its interface prototype object, chained to its parent's (through its named properties object, for
 *   a `[Global]` interface with a named getter, e.g. WindowProperties); the global object, in the realm whose global
 *   it is; and its interface object, on the global or on its `[LegacyNamespace]`
 * - a callback interface with constants: its legacy callback interface object, on the global
 * - a namespace: its namespace object, on the global
 *
 * A chain whose interface inherits none continues into the ECMAScript intrinsics (see `intrinsics`).
 *
 * The global object, its named properties object, and the interface prototype objects of every `[Global]` interface
 * and of each interface one inherits are immutable prototype exotic objects (Web IDL), and so their holders carry
 * `immutablePrototype` (§4 Member data). So do the instances of `immutableInstances`, which are no holders of their
 * own until a platform singleton is one.
 */
function placeHolders(
  catalog: Placed,
  { base }: Owner,
  { bases, owners, exposure, realmsOf, globalChain }: Context,
): void {
  const { definition } = base
  const { name } = definition
  const exposedIn = (owner: string) => realmsOf.get(owner) ?? []
  if (definition.type === 'namespace') {
    for (const realm of exposedIn(name)) catalog.addNamespaceObject(realm, exposure.globalOf(realm), base)
    return
  }
  if (definition.type === 'callback interface') {
    if (!hasInterfaceObject(definition)) return
    for (const realm of exposedIn(name)) {
      catalog.addInterfaceObject(realm, { name: exposure.globalOf(realm), holder: 'global' }, base, undefined)
    }
    return
  }

  const parent = parentOf(base, bases)
  const unexposed = parent && exposedIn(name).find((realm) => !exposedIn(parent).includes(realm))
  if (unexposed) {
    throw new Error(`${name} is exposed in ${unexposed}, where the interface it inherits, ${parent}, is not`)
  }
  const namedProperties = isGlobal(definition) && supportsNamedProperties(name, owners, bases)
  const qualified = qualifiedName(name, bases)
  const qualifiedParent = parent && qualifiedName(parent, bases)
  // The [[Prototype]] of the interface prototype object, or of its named properties object if it has one.
  const inherited = qualifiedParent
    ? `${qualifiedParent}.prototype`
    : name === 'DOMException'
      ? intrinsics.errorPrototype
      : intrinsics.objectPrototype
  const immutable = { immutablePrototype: true } as const
  for (const realm of exposedIn(name)) {
    if (namedProperties) {
      catalog.addHolder(realm, namedPropertiesObject(name), { kind: 'prototype', owner: name, proto: inherited, ...immutable })
    }
    const proto = namedProperties ? namedPropertiesObject(name) : inherited
    catalog.addHolder(realm, `${qualified}.prototype`, {
      kind: 'prototype',
      owner: name,
      proto,
      ...(globalChain.has(name) && immutable),
    })
    if (exposure.globalOf(realm) === name) {
      catalog.addHolder(realm, name, { kind: 'global', owner: name, proto: `${name}.prototype`, ...immutable })
    }
    if (immutableInstances.has(name)) catalog.addInstanceData(realm, name, immutable)
  }

  if (!hasInterfaceObject(definition)) return
  if (parent && !hasInterfaceObject(bases.get(parent)?.definition)) {
    throw new Error(`${name} has an interface object, but the interface it inherits, ${parent}, has none`)
  }
  const namespace = legacyNamespaceOf(definition)
  for (const realm of exposedIn(name)) {
    if (namespace && (bases.get(namespace)?.definition.type !== 'namespace' || !exposedIn(namespace).includes(realm))) {
      throw new Error(`${name} (${base.spec}) is in namespace ${namespace}, which is not exposed in ${realm}`)
    }
    const global = exposure.globalOf(realm)
    const on = namespace
      ? ({ name: namespace, holder: 'namespace' } as const)
      : ({ name: global, holder: 'global' } as const)
    catalog.addInterfaceObject(realm, on, base, qualifiedParent && interfaceObjectName(qualifiedParent, global))
    const objectName = on.holder === 'namespace' ? qualified : interfaceObjectName(qualified, global)
    // [LegacyWindowAlias] names are properties of the Window global only.
    if (realm === 'window') {
      for (const alias of extAttrNames(definition, 'LegacyWindowAlias')) {
        catalog.addGlobalProperty(realm, global, alias, { holds: objectName, spec: base.spec })
      }
    }
    for (const factory of extAttrNames(definition, 'LegacyFactoryFunction')) {
      catalog.addLegacyFactoryFunction(realm, global, factory, { owner: name, prototype: `${qualified}.prototype`, spec: base.spec })
    }
  }
}

/**
 * The identifiers an extended attribute names: `[LegacyWindowAlias=webkitURL]`, `[LegacyWindowAlias=(SVGMatrix,
 * WebKitCSSMatrix)]`, and the name of a `[LegacyFactoryFunction=Image(…)]`.
 */
function extAttrNames(definition: Container, extAttr: string): string[] {
  return definition.extAttrs
    .filter(({ name }) => name === extAttr)
    .flatMap(({ rhs }) => {
      if (rhs?.type === 'identifier') return [rhs.value]
      if (rhs?.type === 'identifier-list') return rhs.value.map(({ value }) => value)
      throw new Error(`[${extAttr}] on ${definition.name} names no identifier`)
    })
}

/**
 * The name of an interface's interface object holder, from the name of its interface's holders: that name itself, but
 * for the realm's global interface, whose name is the global object's, its path from the global (`Window.Window`,
 * `DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope`, §4).
 */
function interfaceObjectName(qualified: string, global: string): string {
  return qualified === global ? `${global}.${global}` : qualified
}

/** Adds a member, in each realm it is exposed in, as a target or as a per-instance member (see `place`). */
function placeMember(
  catalog: Placed,
  { base }: Owner,
  { member, spec, declaredOn, mixin }: OwnedMember,
  { bases, exposure, realmsOf }: Context,
): void {
  // Anonymous getters, setters and deleters define no property. The members stringifiers, indexed getters and
  // iterable, async_iterable, maplike and setlike declarations imply are synthesized (`placeSynthesized`).
  if (!isNamedProperty(member)) return
  const { definition } = base
  const owner = definition.name
  const ownerRealms = realmsOf.get(owner) ?? []
  const memberRealms = exposure.ofMember({ member, declaredOn, host: mixin ? definition : undefined })
  const outside = memberRealms.find((realm) => !ownerRealms.includes(realm))
  if (outside) throw new Error(`${owner}.${member.name} (${spec}) is exposed in ${outside}, where ${owner} is not`)
  const record = {
    owner,
    member: member.name,
    kind: kindOf(member),
    spec,
    ...(mixin && { mixin }),
    ...memberData(member, `${owner}.${member.name} (${spec})`),
  }
  const qualified = qualifiedName(owner, bases)
  for (const realm of memberRealms) {
    const global = exposure.globalOf(realm)
    const where = { realm, global, qualified, interfaceObject: hasInterfaceObject(definition) }
    for (const placement of place(owner, definition.type, member, spec, where)) {
      if (!('instance' in placement)) catalog.addTarget(realm, placement.name, { ...record, holder: placement.holder })
      else if (!ancestorsOf(global, bases).includes(owner)) {
        catalog.addInstanceMember(realm, { ...record, kind: placement.instance })
      } else {
        throw new Error(
          `${owner}.${member.name} (${spec}) is [LegacyUnforgeable], so it would be an own member of the ${realm} global, which inherits ${owner}`,
        )
      }
    }
  }
}

/**
 * Adds the members the Web IDL binding synthesizes for an owner (see `synthesize`), in each realm the declarations that
 * imply them are exposed in, placed as §4 places them: on the interface prototype object (named by the interface's
 * qualified name), on the interface object (named by its holder's name), on the namespace object, or, for a
 * `[LegacyUnforgeable]` stringifier's `toString`, on each instance. A name the owner already declares keeps its
 * declared member.
 */
function placeSynthesized(catalog: Placed, { base, members }: Owner, { bases, exposure, realmsOf }: Context): void {
  const { definition, spec } = base
  const owner = definition.name
  const interfaceObject = hasInterfaceObject(definition)
  const declared = members.map(({ member, spec, declaredOn, mixin }) => ({
    member,
    spec,
    mixin,
    realms: exposure.ofMember({ member, declaredOn, host: mixin ? definition : undefined }),
  }))
  const synthesized = synthesize({ type: definition.type, spec }, declared, {
    realms: realmsOf.get(owner) ?? [],
    interfaceObject,
  })
  const qualified = qualifiedName(owner, bases)
  for (const each of synthesized) {
    const record = {
      owner,
      member: each.name,
      kind: each.kind,
      spec: each.spec,
      ...(each.mixin && { mixin: each.mixin }),
      descriptor: each.descriptor,
      ...(each.assign && { assign: each.assign }),
    }
    for (const realm of each.realms) {
      const global = exposure.globalOf(realm)
      const objectName = interfaceObjectName(qualified, global)
      if (each.instance) {
        if (ancestorsOf(global, bases).includes(owner) || owner === global) {
          throw new Error(`${owner}.${each.name} would be an own member of the ${realm} global, which is [LegacyUnforgeable]`)
        }
        if (!catalog.hasInstanceMember(realm, owner, each.name)) {
          catalog.addInstanceMember(realm, record)
        }
        continue
      }
      const placement = placementOf(each, { owner, qualified, objectName })
      if (catalog.hasTarget(realm, placement.name)) continue
      const holds = heldBy(each, { qualified, objectName })
      catalog.addTarget(realm, placement.name, { ...record, holder: placement.holder, ...(holds && { holds }) })
    }
  }
}

function placementOf(
  { name, on }: Synthesized,
  { owner, qualified, objectName }: { owner: string; qualified: string; objectName: string },
): { name: string; holder: Holder } {
  if (on === 'namespace') return { name: `${owner}.${name}`, holder: 'namespace' }
  if (on === 'object') return { name: `${objectName}.${name}`, holder: 'constructor' }
  return { name: `${qualified}.prototype.${name}`, holder: 'prototype' }
}

function heldBy(
  { holds }: Synthesized,
  { qualified, objectName }: { qualified: string; objectName: string },
): string | undefined {
  if (holds === 'interface object') return objectName
  if (holds === 'interface prototype object') return `${qualified}.prototype`
  return undefined
}

/** A target as placement records it, before it has a surface (see `surfaces.ts`). */
export type PlacedTarget = Omit<CatalogTarget, 'surface'>

/** A per-instance member as placement records it, before it has a surface. */
export type PlacedInstanceMember = Omit<InstanceMember, 'surface'>

/** The catalog sections that placement fills, per realm. */
export interface PlacedSections {
  targets: Record<Realm, Record<string, PlacedTarget>>
  holders: Record<Realm, Record<string, CatalogHolder>>
  instanceMembers: Record<Realm, Record<string, Record<string, PlacedInstanceMember>>>
  instances: Record<Realm, Record<string, InstanceData>>
}

/**
 * Collects placed members. Maps keyed by a member name have no prototype, so a member named `__proto__` is an own
 * entry like any other.
 */
class Placed {
  readonly #targets = perRealm<Record<string, PlacedTarget>>()
  readonly #instanceMembers = perRealm<Record<string, Record<string, PlacedInstanceMember>>>()
  readonly #holders = perRealm<Record<string, CatalogHolder>>()
  readonly #instances = perRealm<Record<string, InstanceData>>()

  addHolder(realm: Realm, name: string, holder: CatalogHolder): void {
    const earlier = this.#holders[realm][name]
    if (earlier) throw new Error(`${name} names both a ${earlier.kind} and a ${holder.kind} holder in ${realm}`)
    this.#holders[realm][name] = holder
  }

  addTarget(realm: Realm, name: string, target: PlacedTarget): void {
    const earlier = this.#targets[realm][name]
    if (!earlier) this.#targets[realm][name] = target
    else if (earlier.kind !== target.kind) {
      throw new Error(
        `${name} is declared as ${article(earlier.kind)} (${earlier.spec}) and as ${article(target.kind)} (${target.spec})`,
      )
    }
  }

  hasTarget(realm: Realm, name: string): boolean {
    return Object.hasOwn(this.#targets[realm], name)
  }

  hasInstanceMember(realm: Realm, owner: string, member: string): boolean {
    const members = this.#instanceMembers[realm][owner]
    return members !== undefined && Object.hasOwn(members, member)
  }

  addInstanceMember(realm: Realm, member: PlacedInstanceMember): void {
    const byOwner = this.#instanceMembers[realm]
    const members = (byOwner[member.owner] ??= Object.create(null) as Record<string, PlacedInstanceMember>)
    members[member.member] ??= member
  }

  addInstanceData(realm: Realm, owner: string, data: InstanceData): void {
    this.#instances[realm][owner] = data
  }

  /**
   * Adds an interface object, a constructor holder, as a property of the realm's global, or of its namespace for a
   * `[LegacyNamespace]` interface. The holder is named by the property's path: `XMLHttpRequest`, `WebAssembly.Module`,
   * and `Window.Window` for the realm's own `[Global]` interface, whose name is the global object's (§4). `parent` is
   * the holder name of the inherited interface's interface object; without one, the interface object's [[Prototype]] is
   * `%Function.prototype%`.
   */
  addInterfaceObject(
    realm: Realm,
    on: { name: string; holder: 'global' | 'namespace' },
    { definition, spec }: Declared,
    parent: string | undefined,
  ): void {
    const { name } = definition
    const holderName = on.holder === 'namespace' ? `${on.name}.${name}` : interfaceObjectName(name, on.name)
    this.addTarget(realm, `${on.name}.${name}`, {
      owner: on.name,
      member: name,
      holder: on.holder,
      kind: 'interface',
      spec,
      holds: holderName,
      descriptor: globalProperty,
    })
    this.addHolder(realm, holderName, { kind: 'constructor', owner: name, proto: parent ?? intrinsics.functionPrototype })
  }

  /**
   * Adds a property of the realm's global that holds an existing interface object: a `[LegacyWindowAlias]` name
   * (`Window.webkitURL` holds `URL`, §4).
   */
  addGlobalProperty(realm: Realm, global: string, name: string, { holds, spec }: { holds: string; spec: string }): void {
    if (this.hasTarget(realm, `${global}.${name}`)) throw new Error(`${global}.${name} is defined twice (${spec})`)
    this.addTarget(realm, `${global}.${name}`, {
      owner: global,
      member: name,
      holder: 'global',
      kind: 'interface',
      spec,
      holds,
      descriptor: globalProperty,
    })
  }

  /**
   * Adds a `[LegacyFactoryFunction]` (§4): a property of the realm's global holding a constructor holder of its own,
   * named by its name, with the interface as owner and `%Function.prototype%` as prototype. Its only target is its
   * `prototype`, which holds the interface prototype object (`Image.prototype` holds `HTMLImageElement.prototype`).
   */
  addLegacyFactoryFunction(
    realm: Realm,
    global: string,
    name: string,
    { owner, prototype, spec }: { owner: string; prototype: string; spec: string },
  ): void {
    this.addGlobalProperty(realm, global, name, { holds: name, spec })
    this.addHolder(realm, name, { kind: 'constructor', owner, proto: intrinsics.functionPrototype })
    this.addTarget(realm, `${name}.prototype`, {
      owner,
      member: 'prototype',
      holder: 'constructor',
      kind: 'value',
      spec,
      holds: prototype,
      descriptor: prototypeProperty,
    })
  }

  /**
   * Adds a namespace object, a namespace holder, as a property of the realm's global. One of `emptyPrototypes` has an
   * empty object of its own as its [[Prototype]]: a prototype holder named by its path from the global,
   * `console.[[Prototype]]` (§4), with no members.
   */
  addNamespaceObject(realm: Realm, global: string, { definition: { name }, spec }: Declared): void {
    this.addTarget(realm, `${global}.${name}`, {
      owner: global,
      member: name,
      holder: 'global',
      kind: 'namespace',
      spec,
      holds: name,
      descriptor: globalProperty,
    })
    const proto = emptyPrototypes.has(name) ? `${name}.[[Prototype]]` : intrinsics.objectPrototype
    if (proto !== intrinsics.objectPrototype) {
      this.addHolder(realm, proto, { kind: 'prototype', owner: name, proto: intrinsics.objectPrototype })
    }
    this.addHolder(realm, name, { kind: 'namespace', owner: name, proto })
  }

  sections(): PlacedSections {
    return {
      targets: this.#targets,
      holders: this.#holders,
      instanceMembers: this.#instanceMembers,
      instances: this.#instances,
    }
  }
}

/**
 * The descriptor of a property that holds an interface object, a namespace object or a legacy callback interface
 * object, on the global or on a `[LegacyNamespace]` namespace (Web IDL, ECMAScript binding).
 */
export const globalProperty: Descriptor = { type: 'data', writable: true, enumerable: false, configurable: true }

function perRealm<T>(): Record<Realm, T> {
  return Object.fromEntries(realms.map((realm) => [realm, Object.create(null)])) as Record<Realm, T>
}

/** A target's name and holder kind, or a per-instance member's kind. */
type Placement = { name: string; holder: Holder } | { instance: InstanceMember['kind'] }

/**
 * Where the Web IDL ECMAScript binding defines a member, in a realm (§4):
 * - a regular operation or attribute of the realm's `[Global]` interface: on the global object itself
 * - a `[LegacyUnforgeable]` one of any other interface: on each instance, so it is no target of its own
 * - other regular operations and attributes: on the interface prototype object
 * - statics: on the interface object
 * - constants: on the interface object and on the interface prototype object, or, for a callback interface, on its
 *   legacy callback interface object
 * - namespace members: on the namespace object
 *
 * Targets on the interface prototype object are named by the interface's qualified name
 * (`WebAssembly.Memory.prototype.grow`, §4), and those on the interface object by its holder's name, which is the same
 * but for the realm's `[Global]` interface: its statics and constants are named on `Window.Window`, since the global's
 * own properties are named `Window.<member>`.
 */
function place(
  owner: string,
  type: Container['type'],
  member: NamedProperty,
  spec: string,
  where: { realm: Realm; global: string; qualified: string; interfaceObject: boolean },
): Placement[] {
  const { name } = member
  const objectName = interfaceObjectName(where.qualified, where.global)
  const onObject = { name: `${objectName}.${name}`, holder: 'constructor' } as const
  const onPrototype = { name: `${where.qualified}.prototype.${name}`, holder: 'prototype' } as const
  if (type === 'namespace') return [{ name: `${owner}.${name}`, holder: 'namespace' }]
  // A callback interface's operations are implemented by user objects; only its constants are platform properties.
  if (type === 'callback interface') return member.type === 'const' ? [onObject] : []
  const label = `${owner}.${name} (${spec})`
  if (member.type === 'const' || member.special === 'static') {
    if (member.type !== 'const') {
      if (!where.interfaceObject) throw new Error(`${label} is static, but ${owner} has no interface object`)
      return [onObject]
    }
    return where.interfaceObject ? [onObject, onPrototype] : [onPrototype]
  }
  if (owner === where.global) return [{ name: `${owner}.${name}`, holder: 'global' }]
  if (member.extAttrs.some(({ name }) => name === 'LegacyUnforgeable')) return [{ instance: member.type }]
  return [onPrototype]
}

/** The interface a base interface definition inherits, which must be defined. */
function parentOf({ definition, spec }: Declared, bases: ReadonlyMap<string, Declared>): string | undefined {
  const parent = definition.type === 'interface' ? definition.inheritance : null
  if (!parent) return undefined
  if (bases.get(parent)?.definition.type !== 'interface') {
    throw new Error(`interface ${definition.name} (${spec}) inherits ${parent}, which is not an interface`)
  }
  return parent
}

/** Whether an interface or callback interface has an interface object (Web IDL). */
function hasInterfaceObject(definition: Container | undefined): boolean {
  if (definition?.type === 'callback interface') return definition.members.some(({ type }) => type === 'const')
  return definition?.type === 'interface' && !definition.extAttrs.some(({ name }) => name === 'LegacyNoInterfaceObject')
}

/** The namespace a `[LegacyNamespace]` interface's interface object is a member of, instead of the global. */
function legacyNamespaceOf(definition: Container): string | undefined {
  const rhs = definition.extAttrs.find(({ name }) => name === 'LegacyNamespace')?.rhs
  return rhs?.type === 'identifier' ? rhs.value : undefined
}

/**
 * The name an interface's holders are known by: its qualified path from its namespace for a `[LegacyNamespace]`
 * interface (`WebAssembly.Module`, §4), otherwise its identifier.
 */
function qualifiedName(name: string, bases: ReadonlyMap<string, Declared>): string {
  const definition = bases.get(name)?.definition
  const namespace = definition && legacyNamespaceOf(definition)
  return namespace ? `${namespace}.${name}` : name
}

/** The interfaces an interface inherits, nearest first. */
function ancestorsOf(name: string, bases: ReadonlyMap<string, Declared>): string[] {
  const ancestors: string[] = []
  for (let base = bases.get(name), parent; base && (parent = parentOf(base, bases)); base = bases.get(parent)) {
    ancestors.push(parent)
  }
  return ancestors
}

function isGlobal(definition: Container): boolean {
  return definition.extAttrs.some(({ name }) => name === 'Global')
}

/**
 * Whether an interface supports named properties: it, or an interface it inherits, has a named property getter.
 * A `[Global]` interface that does has a named properties object between its prototype and its parent's (Web IDL).
 */
function supportsNamedProperties(
  name: string,
  owners: ReadonlyMap<string, Owner>,
  bases: ReadonlyMap<string, Declared>,
): boolean {
  return [name, ...ancestorsOf(name, bases)].some((current) =>
    owners.get(current)?.members.some(({ member }) => {
      if (member.type !== 'operation' || member.special !== 'getter') return false
      return member.arguments[0]?.idlType.idlType === 'DOMString'
    }),
  )
}

/** An operation, attribute or constant with an identifier: an IDL member that defines a property of that name. */
type NamedProperty = Extract<Member, { type: 'operation' | 'attribute' | 'const' }> & { name: string }

function isNamedProperty(member: Member): member is NamedProperty {
  return (member.type === 'operation' || member.type === 'attribute' || member.type === 'const') && !!member.name
}

/**
 * A member's descriptor, as the Web IDL ECMAScript binding defines the property, and an attribute's assign kind (see
 * `assignOf`) (§4 Member data). Every member is enumerable. An operation is a writable, configurable data property,
 * and an attribute a configurable accessor, but a `[LegacyUnforgeable]` one is neither writable nor configurable. A
 * readonly attribute has no setter, unless `[PutForwards]`, `[Replaceable]` or `[LegacyLenientSetter]` gives it one. A
 * constant is a data property that is neither writable nor configurable.
 */
function memberData(member: NamedProperty, label: string): { descriptor: Descriptor; assign?: AssignKind } {
  const has = (name: string) => member.extAttrs.some((extAttr) => extAttr.name === name)
  const forgeable = !has('LegacyUnforgeable')
  if (member.type === 'operation') {
    return { descriptor: { type: 'data', writable: forgeable, enumerable: true, configurable: forgeable } }
  }
  if (member.type === 'attribute') {
    const assign = assignOf(member, has, label)
    return {
      descriptor: { type: 'accessor', setter: assign !== 'readonly', enumerable: true, configurable: forgeable },
      assign,
    }
  }
  return { descriptor: { type: 'data', writable: false, enumerable: true, configurable: false } }
}

/** The types of HTML's event handler IDL attributes. */
const eventHandlerTypes = new Set(['EventHandler', 'OnErrorEventHandler', 'OnBeforeUnloadEventHandler'])

/** The extended attributes that give a readonly attribute a setter, with the assign kind each gives it (Web IDL). */
const setterExtAttrs: readonly (readonly [string, AssignKind])[] = [
  ['PutForwards', 'put-forwards'],
  ['Replaceable', 'replaceable'],
  ['LegacyLenientSetter', 'lenient-setter'],
]

/**
 * What assigning an attribute does (§4 Member data). A readonly attribute's extended attribute decides it:
 * `[PutForwards]`, `[Replaceable]` or `[LegacyLenientSetter]`, and without one it is `readonly`. A writable attribute
 * is an `event-handler` when its type is one of HTML's event handler types, and a `setter` otherwise. Refuses an
 * attribute with two of those extended attributes, or a writable one with any of them, which Web IDL forbids.
 */
function assignOf(member: WebIDL2.AttributeMemberType, has: (name: string) => boolean, label: string): AssignKind {
  const declared = setterExtAttrs.filter(([name]) => has(name))
  const names = declared.map(([name]) => `[${name}]`)
  if (declared.length > 1) throw new Error(`${label} is both ${names.join(' and ')}`)
  if (!member.readonly) {
    if (declared.length) throw new Error(`${label} is ${names[0]}, which only a readonly attribute can be`)
    return eventHandlerTypes.has(String(member.idlType.idlType)) ? 'event-handler' : 'setter'
  }
  return declared[0]?.[1] ?? 'readonly'
}

function kindOf(member: NamedProperty): MemberKind {
  return member.type === 'const' ? 'constant' : member.type
}

function article(kind: MemberKind): string {
  return kind === 'constant' || kind === 'namespace' ? `a ${kind}` : `an ${kind}`
}

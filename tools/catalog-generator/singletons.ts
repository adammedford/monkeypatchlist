import { realms, type Realm, type Singleton } from '../../src/catalog.ts'
import type { AttributeTypes, PlacedSections, PlacedTarget } from './targets.ts'

/**
 * The curated overlay of platform singletons (§3, §4 Sources): the native instances IDL can't tell apart from ordinary
 * ones. Every entry is resolved against the IDL, per realm.
 */
export interface SingletonsOverlay {
  /** The names code reaches the realm's global object itself by (§5): `window`, `self`, `globalThis`. */
  globalNames: string[]
  /** Each singleton's canonical path from the global, without the global's prefix: `history`, `crypto.subtle`. */
  singletons: string[]
  /** Every other access path to a singleton, to its canonical path: `document.location` → `location`. */
  aliases: Record<string, string>
}

/** Each realm's singletons, by canonical path, and their alias groups (§19 Catalog as data). */
export interface SingletonSections {
  singletons: Record<Realm, Record<string, Singleton>>
  aliasGroups: Record<Realm, Record<string, string[]>>
}

/**
 * Adds each platform singleton, in every realm its canonical path resolves in (§4), and gathers its alias group. A
 * path's first member is a property of the realm's global, and each further member a property of the singleton the
 * rest of the path names, so a nested singleton needs its parent, and an alias with a parent extends a singleton too.
 * The singleton is:
 * - for a property whose IDL type is an interface: an `instance` holder named by the path, on that interface's
 *   prototype, whose own members, the per-instance members of the interface and those it inherits, are `instance`
 *   targets named by the path (`location.href`)
 * - for a property that holds a namespace object (`console`): that `namespace` holder, which the path must name
 *
 * `globals` names each realm's global object, its one `global` holder. Refuses an overlay entry that resolves in no
 * realm, or to anything else.
 */
export function placeSingletons(
  sections: PlacedSections,
  attributeTypes: AttributeTypes,
  overlay: SingletonsOverlay,
  globals: Readonly<Record<Realm, string>>,
): SingletonSections {
  const views = realms.map((realm) => new RealmView(realm, globals[realm], sections, attributeTypes))
  const listed = new Set(overlay.singletons)
  const singletons = perRealm<Record<string, Singleton>>()
  for (const path of [...listed].sort(byDepth)) {
    const { parent, member } = split(path)
    requireSingleton(parent, listed, `platform singleton ${path}`)
    let resolved = false
    for (const view of views) {
      const { realm } = view
      if (parent !== undefined && !singletons[realm][parent]) continue
      const found = view.valueAt(parent ?? view.global, member)
      if (!found) continue
      const { via, value } = found
      if (value && 'interface' in value) view.addInstance(path, value.interface)
      else if (value?.namespace !== path) {
        const holds = `holds no interface instance or namespace named ${path}`
        throw new Error(`platform singleton ${path} is ${via}, which ${holds}`)
      }
      singletons[realm][path] = { ...value, via }
      resolved = true
    }
    if (!resolved) throw new Error(`platform singleton ${path} resolves in no realm`)
  }
  const aliases = resolveAliases(views, overlay, singletons)
  return { singletons, aliasGroups: aliasGroupsOf(views, overlay.globalNames, singletons, aliases) }
}

/** The alias paths to each singleton, per realm: the overlay's aliases that resolve in that realm. */
type Aliases = Record<Realm, Record<string, string[]>>

/**
 * Resolves each alias, in every realm where the path it extends exists. Refuses an alias of something that is not a
 * singleton, one that is itself a singleton, one that resolves in no realm, and one that reaches another value there.
 */
function resolveAliases(
  views: readonly RealmView[],
  { singletons: listed, aliases }: SingletonsOverlay,
  singletons: Record<Realm, Record<string, Singleton>>,
): Aliases {
  const singletonPaths = new Set(listed)
  const resolved = perRealm<Record<string, string[]>>()
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (singletonPaths.has(alias)) throw new Error(`alias ${alias} is itself a platform singleton`)
    if (!singletonPaths.has(canonical)) {
      throw new Error(`alias ${alias} names ${canonical}, which is not a platform singleton`)
    }
    const { parent, member } = split(alias)
    requireSingleton(parent, singletonPaths, `alias ${alias}`)
    let found = false
    for (const view of views) {
      const { realm } = view
      if (parent !== undefined && !singletons[realm][parent]) continue
      const reached = view.valueAt(parent ?? view.global, member)
      if (!reached) continue
      const singleton = singletons[realm][canonical]
      if (!singleton || !reached.value || !sameValue(reached.value, singleton)) {
        const holds = `does not hold platform singleton ${canonical} in ${realm}`
        throw new Error(`alias ${alias} is ${reached.via}, which ${holds}`)
      }
      ;(resolved[realm][canonical] ??= []).push(alias)
      found = true
    }
    if (!found) throw new Error(`alias ${alias} resolves in no realm`)
  }
  return resolved
}

/**
 * Each singleton's alias group, per realm: every access path from the global that reaches it, both bare and after each
 * name of the global the realm has (`history`, `window.history`, `self.history`, `globalThis.history`), sorted. The
 * paths to a singleton are its canonical path and its aliases, each spelled through every path to the singleton it
 * extends. Refuses a name of the global that resolves in no realm, and aliases whose paths never end because they go
 * through the singleton they reach.
 */
function aliasGroupsOf(
  views: readonly RealmView[],
  globalNames: readonly string[],
  singletons: Record<Realm, Record<string, Singleton>>,
  aliases: Aliases,
): Record<Realm, Record<string, string[]>> {
  const groups = perRealm<Record<string, string[]>>()
  const unresolved = new Set(globalNames)
  for (const view of views) {
    const { realm } = view
    const names = globalNames.filter((name) => view.propertyOf(view.global, name))
    for (const name of names) unresolved.delete(name)
    const paths = new Map<string, string[]>()
    const pathsTo = (singleton: string, seen: readonly string[]): string[] => {
      const known = paths.get(singleton)
      if (known) return known
      if (seen.includes(singleton)) throw new Error(`the alias paths to ${singleton} go through ${singleton} itself`)
      const spelled = [singleton, ...(aliases[realm][singleton] ?? [])].flatMap((path) => {
        const { parent, member } = split(path)
        return parent === undefined ? [path] : pathsTo(parent, [...seen, singleton]).map((from) => `${from}.${member}`)
      })
      paths.set(singleton, spelled)
      return spelled
    }
    for (const singleton of Object.keys(singletons[realm])) {
      const all = pathsTo(singleton, []).flatMap((path) => [path, ...names.map((name) => `${name}.${path}`)])
      groups[realm][singleton] = [...new Set(all)].sort()
    }
  }
  for (const name of unresolved) throw new Error(`global name ${name} resolves in no realm`)
  return groups
}

/** Refuses a path that extends something other than a singleton: a nested path is reached through its parent. */
function requireSingleton(parent: string | undefined, singletons: ReadonlySet<string>, what: string): void {
  if (parent !== undefined && !singletons.has(parent)) {
    throw new Error(`${what} extends ${parent}, which is not a platform singleton`)
  }
}

/** What a property holds, when it holds a singleton's kind of value: an interface instance, or a namespace object. */
type Value = { interface: string } | { namespace: string }

function sameValue(a: Value, b: Value): boolean {
  if ('interface' in a) return 'interface' in b && a.interface === b.interface
  return 'namespace' in b && a.namespace === b.namespace
}

/** A path's last member, and the path before it, if any: `navigator.geolocation` → `navigator`, `geolocation`. */
function split(path: string): { parent?: string; member: string } {
  const dot = path.lastIndexOf('.')
  return dot < 0 ? { member: path } : { parent: path.slice(0, dot), member: path.slice(dot + 1) }
}

/** Orders paths so that each comes after the paths it extends. */
function byDepth(a: string, b: string): number {
  return a.split('.').length - b.split('.').length || (a < b ? -1 : a > b ? 1 : 0)
}

/**
 * The holders and targets of one realm, read as the objects code reaches. It reads `sections` live, so it sees the
 * singletons added through it.
 */
class RealmView {
  readonly realm: Realm
  /** The realm's global object: its one `global` holder. */
  readonly global: string
  readonly #sections: PlacedSections
  readonly #attributeTypes: AttributeTypes

  constructor(realm: Realm, global: string, sections: PlacedSections, attributeTypes: AttributeTypes) {
    this.realm = realm
    this.global = global
    this.#sections = sections
    this.#attributeTypes = attributeTypes
  }

  /**
   * The property `member` of the object `holder` (see `propertyOf`): its target's name, and the value it holds, if that
   * is an interface instance or a namespace object.
   */
  valueAt(holder: string, member: string): { via: string; value?: Value } | undefined {
    const property = this.propertyOf(holder, member)
    if (!property) return undefined
    const { name, target } = property
    const type = this.#attributeTypes.get(target.owner)?.get(target.member)
    if (target.kind === 'attribute' && type) return { via: name, value: { interface: type } }
    if (target.kind === 'namespace' && target.holds) return { via: name, value: { namespace: target.holds } }
    return { via: name }
  }

  /** The property `member` of the object `holder`, found along its prototype chain: its target and its name. */
  propertyOf(holder: string, member: string): { name: string; target: PlacedTarget } | undefined {
    const targets = this.#sections.targets[this.realm]
    for (const current of this.#chain(holder)) {
      const name = `${current}.${member}`
      const target = targets[name]
      if (target) return { name, target }
    }
    return undefined
  }

  /**
   * Adds an instance of `type` as the holder `name`, with the per-instance members of `type` and of the interfaces it
   * inherits as its targets, and the instance data of `type`. Refuses a `type` with no interface prototype object in
   * the realm, and a holder or target name that is taken.
   */
  addInstance(name: string, type: string): void {
    const realm = this.realm
    const holders = this.#sections.holders[realm]
    const targets = this.#sections.targets[realm]
    const proto = `${type}.prototype`
    if (holders[proto]?.kind !== 'prototype') {
      const missing = `has no interface prototype object in ${realm}`
      throw new Error(`platform singleton ${name} is an instance of ${type}, which ${missing}`)
    }
    if (holders[name]) {
      throw new Error(`platform singleton ${name} is already a ${holders[name].kind} holder in ${realm}`)
    }
    holders[name] = { kind: 'instance', owner: type, proto, ...this.#sections.instances[realm][type] }
    for (const prototype of this.#chain(proto)) {
      const owner = holders[prototype]?.owner
      for (const [member, record] of Object.entries((owner && this.#sections.instanceMembers[realm][owner]) ?? {})) {
        const target = `${name}.${member}`
        if (targets[target]) throw new Error(`${target} is already a target in ${realm}`)
        targets[target] = { ...record, holder: 'instance' }
      }
    }
  }

  /** `holder` and the holders on its prototype chain, nearest first. */
  *#chain(holder: string): Generator<string> {
    const holders = this.#sections.holders[this.realm]
    for (let current: string | null | undefined = holder; current; current = holders[current]?.proto) {
      yield current
    }
  }
}

function perRealm<T>(): Record<Realm, T> {
  return Object.fromEntries(realms.map((realm) => [realm, Object.create(null)])) as Record<Realm, T>
}

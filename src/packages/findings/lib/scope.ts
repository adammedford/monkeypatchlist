// The protected surface (§12 Matching): which targets the protected-surface list covers, in each realm.

import type { Realm, SerializedCatalog } from '../../../catalog.ts'

/** A target as the protected surface sees it: its realm, its name, and the member it shadows (ADR 0002). */
export interface ScopeTarget {
  realm: Realm
  name: string
  shadows?: string
  /**
   * For a wildcard narrowed to a candidate set (§5), the catalog targets it matches: it is covered when one of
   * them is.
   */
  matches?: readonly string[]
}

/** Whether the protected surface covers a target with this effect. */
export type IsProtected = (target: ScopeTarget, effect: string) => boolean

/** What the protected-surface list covers in one realm. */
interface Covered {
  /** The catalog targets its entries name (`ProtectedEntry.targets`). */
  targets: ReadonlySet<string>
  /** The holders those targets sit on: a wildcard over one's native members is covered. */
  holdersOfTargets: ReadonlySet<string>
  /** The constructor, prototype and namespace holders of the whole entries, which a named `add` is covered on. */
  addHolders: ReadonlySet<string>
  /**
   * The holders whose `prototype-change` is covered: the prototype and namespace holders of the whole entries (a
   * namespace plays both the constructor and the prototype role), and the covered singletons.
   */
  prototypeHolders: ReadonlySet<string>
  /** The platform singletons of the realm, by canonical path, and whether each is covered. */
  singletons: ReadonlyMap<string, boolean>
}

/** The suffix of a `prototype-change` target's name: `<holder>.[[Prototype]]`. */
const prototypeSuffix = '.[[Prototype]]'

/**
 * The protected surface of a catalog (§12 Matching). Entries are keyed on (interface, member), independent of realm
 * and holder. A target is covered when:
 * - it is a catalog target an entry names: a member entry's member, in every realm and on each interface that
 *   includes its mixin, and its worker-realm equivalent; a whole entry's global binding and the static, prototype and
 *   namespace members the catalog lists for it, without `onX`
 * - it shadows one of those, on whatever holder it lands (`history.pushState`, `XMLHttpRequest.prototype.toString`)
 * - it is an `add` of a named member, whatever its key, to a whole entry's constructor, prototype or namespace
 * - it is a `prototype-change` of a whole entry's prototype or namespace (never of its constructor), or of a covered
 *   singleton
 * - it is a wildcard over native members (`<holder>.*`) of a holder a covered target sits on, or of a covered singleton;
 *   one a candidate set narrows when a member it matches is a covered target
 *
 * A singleton is covered when its interface or namespace is a whole entry (`history`, `localStorage`, `crypto.subtle`,
 * `navigator.serviceWorker`), or when an entry names a member of its interface (`navigator`, through
 * `Navigator.sendBeacon`). A pattern wildcard of non-native adds (`<holder>.<prefix>*`) is never covered.
 */
export function protectedSurface(catalog: SerializedCatalog): IsProtected {
  const byRealm = new Map<Realm, Covered>()
  const coveredIn = (realm: Realm): Covered => {
    let covered = byRealm.get(realm)
    if (covered === undefined) {
      covered = cover(catalog, realm)
      byRealm.set(realm, covered)
    }
    return covered
  }
  return ({ realm, name, shadows, matches }, effect) => {
    const covered = coveredIn(realm)
    if (name.endsWith('*')) {
      if (!name.endsWith('.*')) return false
      if (matches !== undefined) return matches.some((match) => covered.targets.has(match))
      const holder = name.slice(0, -'.*'.length)
      return covered.singletons.get(holder) ?? covered.holdersOfTargets.has(holder)
    }
    if (covered.targets.has(name)) return true
    if (shadows !== undefined && covered.targets.has(shadows)) return true
    if (effect === 'add') {
      const holder = holderOf(name, catalog.holders[realm])
      return holder !== undefined && covered.addHolders.has(holder)
    }
    if (effect === 'prototype-change' && name.endsWith(prototypeSuffix)) {
      return covered.prototypeHolders.has(name.slice(0, -prototypeSuffix.length))
    }
    return false
  }
}

function cover(catalog: SerializedCatalog, realm: Realm): Covered {
  const targets = new Set<string>()
  const whole = new Set<string>()
  for (const entries of Object.values(catalog.protectedSurface)) {
    for (const entry of entries ?? []) {
      for (const target of entry.targets[realm]) targets.add(target)
      if (entry.member === undefined) whole.add(entry.interface)
    }
  }
  const holders = catalog.holders[realm]
  const catalogTargets = catalog.targets[realm]
  const holdersOfTargets = new Set<string>()
  const coveredOwners = new Set<string>()
  for (const target of targets) {
    const holder = holderOf(target, holders)
    if (holder !== undefined) holdersOfTargets.add(holder)
    coveredOwners.add(catalogTargets[target]!.owner)
  }
  const addHolders = new Set<string>()
  const prototypeHolders = new Set<string>()
  for (const [name, { kind, owner }] of Object.entries(holders)) {
    if (!whole.has(owner)) continue
    if (kind === 'constructor' || kind === 'prototype' || kind === 'namespace') addHolders.add(name)
    if (kind === 'prototype' || kind === 'namespace') prototypeHolders.add(name)
  }
  const singletons = new Map<string, boolean>()
  for (const [path, singleton] of Object.entries(catalog.singletons[realm])) {
    const owner = 'interface' in singleton ? singleton.interface : singleton.namespace
    const covered = whole.has(owner) || coveredOwners.has(owner)
    singletons.set(path, covered)
    if (covered) prototypeHolders.add(path)
  }
  return { targets, holdersOfTargets, addHolders, prototypeHolders, singletons }
}

/**
 * The holder a target is on (§4 Property keys): the part before a member written in JSON-quoted brackets
 * (`Array["prototype.map"]`), and otherwise the longest holder the name continues with a dot, since a canonical numeric
 * member keeps the dot form (`Array.prototype.1.5`).
 */
export function holderOf(name: string, holders: SerializedCatalog['holders'][Realm]): string | undefined {
  const bracket = name.indexOf('["')
  if (bracket >= 0) return Object.hasOwn(holders, name.slice(0, bracket)) ? name.slice(0, bracket) : undefined
  for (let dot = name.lastIndexOf('.'); dot > 0; dot = name.lastIndexOf('.', dot - 1)) {
    if (Object.hasOwn(holders, name.slice(0, dot))) return name.slice(0, dot)
  }
  return undefined
}

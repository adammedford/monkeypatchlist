import {
  realms,
  surfaces,
  type CatalogTarget,
  type InstanceMember,
  type Realm,
  type Surface,
  type SurfaceMap,
} from '../../src/catalog.ts'
import type { PlacedSections, PlacedTarget } from './targets.ts'

/** The owner → surface map overlay, which the merged catalog keeps as its `surfaceMap` section. */
export type SurfacesOverlay = SurfaceMap

/** The targets and per-instance members, each with its surface. */
export interface SurfacedSections {
  targets: Record<Realm, Record<string, CatalogTarget>>
  instanceMembers: Record<Realm, Record<string, Record<string, InstanceMember>>>
}

/**
 * Gives every target and per-instance member its surface (§12 Surfaces and data). The first that applies decides:
 * - an ECMAScript member is always `ECMAScript`; `ecmascript` names each realm's ECMAScript targets
 * - a per-member override keyed on the member's owner, and then one keyed on the mixin it came through
 * - a property that holds an interface or namespace object (`Window.XMLHttpRequest`) takes the surface of the
 *   object's owner
 * - the mixin the member came through, and then its owner, in the owner → surface map
 * - otherwise `other`
 *
 * Refuses a map entry that names no owner or member of the catalog, an ECMAScript owner or member, or a value that is
 * no surface or is `other`. An interface or namespace with no members of its own is an owner through the property that
 * holds it.
 */
export function assignSurfaces(
  sections: PlacedSections,
  overlay: SurfacesOverlay,
  ecmascript: Readonly<Record<Realm, ReadonlySet<string>>>,
): SurfacedSections {
  checkMap(overlay, declaredMembers(sections, ecmascript))
  const targets = perRealm<Record<string, CatalogTarget>>()
  const instanceMembers = perRealm<Record<string, Record<string, InstanceMember>>>()
  for (const realm of realms) {
    const holders = sections.holders[realm]
    const heldOwner = ({ holds }: Pick<PlacedTarget, 'holds'>) =>
      holds === undefined ? undefined : holders[holds]?.owner
    for (const [name, target] of Object.entries(sections.targets[realm])) {
      const surface = ecmascript[realm].has(name) ? 'ECMAScript' : surfaceOf(target, heldOwner(target), overlay)
      targets[realm][name] = { ...target, surface }
    }
    for (const [owner, members] of Object.entries(sections.instanceMembers[realm])) {
      const surfaced: Record<string, InstanceMember> = (instanceMembers[realm][owner] = Object.create(null))
      for (const [name, member] of Object.entries(members)) {
        surfaced[name] = { ...member, surface: surfaceOf(member, undefined, overlay) }
      }
    }
  }
  return { targets, instanceMembers }
}

/**
 * Whether each member is ECMAScript, by the interface, namespace, intrinsic or mixin that declares it (its owner, and
 * the mixin it came through), and then by member, over every realm. An interface or namespace that declares no member
 * but that a Web IDL property holds (`Window.Comment`) is there too, with no members: the map can still give it the
 * surface its binding takes.
 */
type DeclaredMembers = ReadonlyMap<string, ReadonlyMap<string, boolean>>

function declaredMembers(
  sections: PlacedSections,
  ecmascript: Readonly<Record<Realm, ReadonlySet<string>>>,
): DeclaredMembers {
  const declared = new Map<string, Map<string, boolean>>()
  const owner = (on: string) => {
    let members = declared.get(on)
    if (!members) declared.set(on, (members = new Map()))
    return members
  }
  const add = (on: string | undefined, member: string, isEcmascript: boolean) => {
    if (on === undefined) return
    const members = owner(on)
    members.set(member, (members.get(member) ?? true) && isEcmascript)
  }
  for (const realm of realms) {
    const holders = sections.holders[realm]
    for (const [name, target] of Object.entries(sections.targets[realm])) {
      const isEcmascript = ecmascript[realm].has(name)
      add(target.owner, target.member, isEcmascript)
      add(target.mixin, target.member, false)
      const held = target.holds === undefined ? undefined : holders[target.holds]?.owner
      if (held !== undefined && !isEcmascript) owner(held)
    }
    for (const members of Object.values(sections.instanceMembers[realm])) {
      for (const { owner, member, mixin } of Object.values(members)) {
        add(owner, member, false)
        add(mixin, member, false)
      }
    }
  }
  return declared
}

/**
 * Refuses a map entry that names no owner or member of the catalog, an ECMAScript owner or member, `other` or no
 * surface.
 */
function checkMap({ owners, members }: SurfacesOverlay, declared: DeclaredMembers): void {
  const refuse = (message: string) => {
    throw new Error(`surface map: ${message}`)
  }
  const checkSurface = (name: string, surface: string) => {
    if (surface === 'other') refuse(`${name} is other, which the map never says: other is an owner nobody has reviewed`)
    if (!surfaces.some((known) => known === surface)) refuse(`${name} is ${surface}, which is no surface`)
  }
  for (const [name, surface] of Object.entries(owners)) {
    checkSurface(name, surface)
    const owned = declared.get(name)
    if (!owned) refuse(`${name} owns no member of the catalog, and no property holds it`)
    else if (owned.size && [...owned.values()].every(Boolean)) {
      refuse(`${name} is an ECMAScript owner, whose members are always ECMAScript`)
    }
  }
  for (const [name, byMember] of Object.entries(members)) {
    for (const [member, surface] of Object.entries(byMember)) {
      checkSurface(`${name}.${member}`, surface)
      const isEcmascript = declared.get(name)?.get(member)
      if (isEcmascript === undefined) refuse(`${name}.${member} names no member of the catalog`)
      if (isEcmascript) refuse(`${name}.${member} is an ECMAScript member, which is always ECMAScript`)
    }
  }
}

/** A Web IDL member's surface, `held` being the owner of the object it holds, if any (see `assignSurfaces`). */
function surfaceOf(
  { owner, member, mixin }: Pick<PlacedTarget, 'owner' | 'member' | 'mixin'>,
  held: string | undefined,
  { owners, members }: SurfacesOverlay,
): Surface {
  const override = (declaredOn: string | undefined) => {
    const byMember = declaredOn === undefined ? undefined : own(members, declaredOn)
    return byMember && own(byMember, member)
  }
  const mapped = (name: string | undefined) => (name === undefined ? undefined : own(owners, name))
  return (
    override(owner) ??
    override(mixin) ??
    (held === undefined ? undefined : (mapped(held) ?? 'other')) ??
    mapped(mixin) ??
    mapped(owner) ??
    'other'
  )
}

/** A record's own entry, so that a member named `constructor` or `__proto__` never reads `Object.prototype`. */
function own<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined
}

/** A record per realm, each without a prototype, so a member named `__proto__` is an own entry like any other. */
function perRealm<T>(): Record<Realm, T> {
  return Object.fromEntries(realms.map((realm) => [realm, Object.create(null)])) as Record<Realm, T>
}

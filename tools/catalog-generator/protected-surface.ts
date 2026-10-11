import {
  realms,
  surfaces,
  type CatalogHolder,
  type CatalogTarget,
  type ProtectedEntry,
  type Realm,
  type Surface,
} from '../../src/catalog.ts'

/** The curated protected-surface list (§12 The list): its entries by surface, each keyed on (interface, member). */
export type ProtectedSurfaceOverlay = Partial<Record<Surface, Omit<ProtectedEntry, 'targets'>[]>>

/** The holder kinds a whole entry's own members sit on: static, prototype and namespace members. */
const ownedHolders = new Set<CatalogTarget['holder']>(['constructor', 'prototype', 'namespace'])

/**
 * Resolves each entry of the list to the catalog targets it names, in every realm (see `ProtectedEntry.targets`), and
 * sorts each surface's entries. Refuses an entry that resolves to no target, one that names a target of another
 * surface, an entry listed twice, and a surface that is `other` or no surface at all.
 */
export function resolveProtectedSurface(
  sections: {
    targets: Readonly<Record<Realm, Readonly<Record<string, CatalogTarget>>>>
    holders: Readonly<Record<Realm, Readonly<Record<string, CatalogHolder>>>>
  },
  overlay: ProtectedSurfaceOverlay,
): Partial<Record<Surface, ProtectedEntry[]>> {
  const refuse = (message: string) => {
    throw new Error(`protected surface: ${message}`)
  }
  const listed = new Set<string>()
  const resolved: Partial<Record<Surface, ProtectedEntry[]>> = {}
  for (const [surface, entries = []] of Object.entries(overlay) as [string, ProtectedSurfaceOverlay[Surface]][]) {
    if (surface === 'other' || !surfaces.some((known) => known === surface)) {
      refuse(`${surface} is no surface an entry can be listed under`)
    }
    const resolvedEntries = entries.map((entry) => {
      const name = entry.member === undefined ? entry.interface : `${entry.interface}.${entry.member}`
      if (listed.has(name)) refuse(`${name} is listed twice`)
      listed.add(name)
      const targets = Object.fromEntries(realms.map((realm) => [realm, [] as string[]])) as Record<Realm, string[]>
      for (const realm of realms) {
        const holders = sections.holders[realm]
        for (const [target, record] of Object.entries(sections.targets[realm])) {
          if (!names(entry, record, holders, realm)) continue
          if (record.surface !== surface) {
            refuse(`the ${surface} entry ${name} covers ${target} (${realm}), whose surface is ${record.surface}`)
          }
          targets[realm].push(target)
        }
        targets[realm].sort()
      }
      if (realms.every((realm) => targets[realm].length === 0)) {
        refuse(`the ${surface} entry ${name} resolves to no target`)
      }
      return { ...entry, targets }
    })
    resolved[surface as Surface] = resolvedEntries.sort(
      (a, b) => byCodeUnit(a.interface, b.interface) || byCodeUnit(a.member ?? '', b.member ?? ''),
    )
  }
  return resolved
}

/** Whether an entry names a target (see `ProtectedEntry.targets`). */
function names(
  entry: Omit<ProtectedEntry, 'targets'>,
  { owner, member, mixin, holder, holds, assign }: CatalogTarget,
  holders: Readonly<Record<string, CatalogHolder>>,
  realm: Realm,
): boolean {
  if (entry.member !== undefined) {
    if (member !== entry.member) return false
    const equivalent = realm !== 'window' && entry.workerEquivalent !== undefined && owner === entry.workerEquivalent
    return owner === entry.interface || mixin === entry.interface || equivalent
  }
  if (assign === 'event-handler') return false
  const holdsItsObject = holds !== undefined && holders[holds]?.owner === entry.interface
  return holdsItsObject || (owner === entry.interface && ownedHolders.has(holder))
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

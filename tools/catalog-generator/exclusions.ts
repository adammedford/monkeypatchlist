import { realms, type Exclusion } from '../../src/catalog.ts'
import type { PlacedSections } from './targets.ts'

/**
 * The curated overlay of exclusions (§4 Sources): definitions upstream publishes that the catalog leaves out, each by
 * the name of the interface, namespace or intrinsic that owns its targets, with the reason.
 */
export type ExclusionsOverlay = Record<string, string>

/**
 * Removes each excluded owner from every realm: its targets, its holders and the properties that hold them, and its
 * per-instance members and instance data. Returns the excluded targets, per entry and realm. Refuses an entry that
 * names nothing in the catalog, and one whose holders another holder inherits from.
 */
export function applyExclusions(sections: PlacedSections, overlay: ExclusionsOverlay): Record<string, Exclusion> {
  const exclusions: Record<string, Exclusion> = {}
  for (const [owner, reason] of Object.entries(overlay)) {
    const excluded = Object.fromEntries(realms.map((realm) => [realm, [] as string[]])) as Exclusion['targets']
    let found = false
    for (const realm of realms) {
      const { holders, targets, instanceMembers, instances } = sections
      const owned = new Set(Object.keys(holders[realm]).filter((name) => holders[realm][name]?.owner === owner))
      for (const [name, target] of Object.entries(targets[realm])) {
        if (target.owner === owner || (target.holds !== undefined && owned.has(target.holds))) {
          excluded[realm].push(name)
          delete targets[realm][name]
        }
      }
      for (const name of owned) delete holders[realm][name]
      for (const [name, { proto }] of Object.entries(holders[realm])) {
        if (proto !== null && owned.has(proto)) {
          throw new Error(`exclusion ${owner} removes ${proto}, which ${name} inherits from in ${realm}`)
        }
      }
      found ||= owned.size > 0 || excluded[realm].length > 0 || Object.hasOwn(instanceMembers[realm], owner)
      delete instanceMembers[realm][owner]
      delete instances[realm][owner]
      excluded[realm].sort()
    }
    if (!found) throw new Error(`exclusion ${owner} names nothing in the catalog`)
    exclusions[owner] = { reason, targets: excluded }
  }
  return exclusions
}

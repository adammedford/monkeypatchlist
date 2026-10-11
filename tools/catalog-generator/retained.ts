import {
  realms,
  type CatalogHolder,
  type CatalogTarget,
  type Drop,
  type Realm,
  type Retention,
  type SerializedCatalog,
} from '../../src/catalog.ts'
import { canonicalJson } from './canonical-json.ts'
import type { PlacedSections, PlacedTarget } from './targets.ts'

/** A retained target as the overlay records it: its record as the catalog last generated it, before its surface. */
export type RetainedTarget = Retention & { target: Omit<PlacedTarget, 'catalogStatus'> }

/** A holder upstream removed that the catalog keeps, as the catalog last generated it. */
export type RetainedHolder = Retention & { holder: CatalogHolder }

/**
 * The curated retained overlay (§4 Catalog versions), per realm, by name: the targets and holders upstream removed
 * that the catalog keeps, and the targets and holders deliberately dropped.
 */
export interface RetainedOverlay {
  targets: Partial<Record<Realm, Record<string, RetainedTarget>>>
  holders: Partial<Record<Realm, Record<string, RetainedHolder>>>
  dropped: Partial<Record<Realm, Record<string, Drop>>>
  /** Holders deliberately dropped. None when omitted. */
  droppedHolders?: Partial<Record<Realm, Record<string, Drop>>>
}

export type RetainedSection = SerializedCatalog['retained']

/**
 * Adds the retained holders and targets to the placed sections, each target flagged `catalogStatus: retained`, and
 * returns the `retained` section. Refuses:
 * - a retained target or holder that upstream has again, so that the overlay never hides a fresh generation
 * - a retained target that is not on a holder of its kind in its realm, or that holds a holder the realm lacks
 * - a retained target or holder whose owner an exclusion removes
 * - a drop of a target or holder the catalog has, retained ones included
 */
export function applyRetained(
  sections: Pick<PlacedSections, 'targets' | 'holders'>,
  overlay: RetainedOverlay,
  excludedOwners: ReadonlySet<string>,
): RetainedSection {
  const section: RetainedSection = { targets: perRealm(), holders: perRealm(), dropped: perRealm(), droppedHolders: perRealm() }
  for (const realm of realms) {
    const targets = sections.targets[realm]
    const holders = sections.holders[realm]
    for (const [name, { holder, ...retention }] of sorted(overlay.holders[realm])) {
      if (Object.hasOwn(holders, name)) {
        throw new Error(`${name} is a retained holder, but upstream has it again in ${realm}: remove its retained entry`)
      }
      if (excludedOwners.has(holder.owner)) {
        throw new Error(`${name} is a retained holder, but the exclusion of ${holder.owner} removes its owner`)
      }
      holders[name] = structuredClone(holder)
      section.holders[realm][name] = { ...retention }
    }
    for (const [name, { target, ...retention }] of sorted(overlay.targets[realm])) {
      const refuse = (problem: string) => {
        throw new Error(`the retained target ${name} ${problem}`)
      }
      if (Object.hasOwn(targets, name)) {
        throw new Error(`${name} is retained, but upstream has it again in ${realm}: remove its retained entry`)
      }
      if (excludedOwners.has(target.owner)) {
        throw new Error(`${name} is retained, but the exclusion of ${target.owner} removes its owner`)
      }
      if (!name.endsWith(`.${target.member}`)) refuse(`does not end in its member, ${target.member}`)
      const on = name.slice(0, -(target.member.length + 1))
      if (holders[on]?.kind !== target.holder) refuse(`is on ${on}, which is no ${target.holder} holder in ${realm}`)
      if (target.holds !== undefined && !Object.hasOwn(holders, target.holds)) {
        refuse(`holds ${target.holds}, which is no holder in ${realm}`)
      }
      targets[name] = { ...structuredClone(target), catalogStatus: 'retained' }
      section.targets[realm][name] = { ...retention }
    }
    for (const [name, drop] of sorted(overlay.dropped[realm])) {
      if (Object.hasOwn(targets, name)) {
        throw new Error(`${name} is dropped, but the catalog has it in ${realm}: remove its drop entry`)
      }
      section.dropped[realm][name] = { ...drop }
    }
    for (const [name, drop] of sorted(overlay.droppedHolders?.[realm])) {
      if (Object.hasOwn(holders, name)) {
        throw new Error(`the holder ${name} is dropped, but the catalog has it in ${realm}: remove its drop entry`)
      }
      section.droppedHolders[realm][name] = { ...drop }
    }
  }
  return section
}

/**
 * Refuses a generation that loses a target or a holder the previous catalog had in some realm (§4: the catalog is
 * monotonic, holders too), unless it is deliberately dropped or an exclusion removes it: a target the exclusion lists,
 * or a holder of an excluded owner. Targets and holders are compared by (realm, name), so a target whose holder kind
 * changes, or a holder whose kind changes, is not lost. The refusal lists what is lost, and gives retained entries to
 * start from: each target and holder as the previous catalog generated it, with the last upstream version that had it
 * and an empty reason. A previous catalog from before realms is not compared, and one from before holder placement has
 * no holders to lose.
 */
export function refuseLosses(
  previous: string,
  next: Pick<SerializedCatalog, 'targets' | 'holders' | 'exclusions' | 'retained'>,
): void {
  // An early catalog has no holders, and a later one may still have no catalog version or retained section.
  const before = JSON.parse(previous) as Partial<SerializedCatalog> & { targets: object }
  if (!realms.every((realm) => Object.hasOwn(before.targets, realm))) return
  const had = before as SerializedCatalog
  const hadHolders = (had.holders as Partial<SerializedCatalog['holders']> | undefined) ?? {}
  const exclusions = Object.values(next.exclusions)
  const excluded = realms.map((realm) => new Set(exclusions.flatMap(({ targets }) => targets[realm])))
  const byName = (a: { realm: Realm; name: string }, b: { realm: Realm; name: string }) =>
    byCodeUnit(a.name, b.name) || realms.indexOf(a.realm) - realms.indexOf(b.realm)
  const lostTargets = realms
    .flatMap((realm, index) =>
      Object.keys(had.targets[realm])
        .filter((name) => !Object.hasOwn(next.targets[realm], name))
        .filter((name) => !Object.hasOwn(next.retained.dropped[realm], name) && !excluded[index]!.has(name))
        .map((name) => ({ realm, name })),
    )
    .sort(byName)
  const lostHolders = realms
    .flatMap((realm) =>
      Object.entries(hadHolders[realm] ?? {})
        .filter(([name]) => !Object.hasOwn(next.holders[realm], name))
        .filter(([name, { owner }]) => !Object.hasOwn(next.retained.droppedHolders[realm], name) && !Object.hasOwn(next.exclusions, owner))
        .map(([name]) => ({ realm, name })),
    )
    .sort(byName)
  if (!lostTargets.length && !lostHolders.length) return

  const entries: Pick<RetainedOverlay, 'holders' | 'targets'> = { holders: {}, targets: {} }
  const biblios: Record<string, string> = { ecma262: '@tc39/ecma262-biblio', ecma402: '@tc39/ecma402-biblio' }
  const lastUpstream = (spec: string | undefined) => {
    const upstream = biblios[spec ?? ''] ?? '@webref/idl'
    return `${upstream} ${had.metadata.upstream[upstream] ?? 'unknown'}`
  }
  for (const { realm, name } of lostTargets) {
    const record = had.targets[realm][name]!
    const target: Partial<CatalogTarget> = { ...record }
    delete target.surface
    delete target.catalogStatus
    const entry = { lastUpstream: lastUpstream(record.spec), reason: '', target: target as RetainedTarget['target'] }
    ;(entries.targets[realm] ??= {})[name] = entry
  }
  for (const { realm, name } of lostHolders) {
    const holder = hadHolders[realm]![name]!
    // A holder has no spec of its own: it comes from the upstream of the targets its owner has.
    const spec = Object.values(had.targets[realm]).find(({ owner }) => owner === holder.owner)?.spec
    ;(entries.holders[realm] ??= {})[name] = { lastUpstream: lastUpstream(spec), reason: '', holder }
  }
  const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`
  const lost = [
    ...(lostTargets.length ? [counted(lostTargets.length, 'target')] : []),
    ...(lostHolders.length ? [counted(lostHolders.length, 'holder')] : []),
  ].join(' and ')
  throw new Error(
    [
      `upstream removed ${lost} the previous catalog had. The catalog is monotonic: keep each in the retained ` +
        'overlay, or drop it there with BCD evidence that no current engine ships it.',
      ...lostTargets.map(({ realm, name }) => `- \`${name}\` (${realm})`),
      ...lostHolders.map(({ realm, name }) => `- \`${name}\` (${realm}, ${hadHolders[realm]![name]!.kind} holder)`),
      'Retained entries to start from, each still needing a reason:',
      canonicalJson(entries),
    ].join('\n'),
  )
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sorted<T>(named: Record<string, T> | undefined): [string, T][] {
  return Object.entries(named ?? {}).sort(([a], [b]) => byCodeUnit(a, b))
}

function perRealm<T>(): Record<Realm, Record<string, T>> {
  return Object.fromEntries(realms.map((realm) => [realm, {}])) as Record<Realm, Record<string, T>>
}

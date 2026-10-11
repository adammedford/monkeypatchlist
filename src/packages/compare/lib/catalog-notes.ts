// What the catalog says about each compared finding (§4 Catalog versions): `catalogStatus` for a retained target, and
// `explainedBy`, the catalog changelog's records that could explain a delta.

import type { CatalogChangelog, ChangeRecord, Realm, SerializedCatalog } from '../../../catalog.ts'
import type { BaselineState } from '../../baseline/index.ts'
import { protectedSurface, type IsProtected } from '../../findings/index.ts'

/** A finding's target as the catalog notes read it. */
type Targeted = { target: { realm: Realm; name: string; shadows?: string } }

/**
 * Sets `catalogStatus: retained` on each finding whose target, or the member it shadows, is a retained target of the
 * catalog. It is information only.
 */
export function withCatalogStatus<F extends Targeted>(
  findings: readonly F[],
  catalog: SerializedCatalog,
): (F & { catalogStatus?: 'retained' })[] {
  return findings.map((finding) => {
    const { realm, name, shadows } = finding.target
    const retained = [name, shadows].some(
      (member) => member !== undefined && catalog.targets[realm][member]?.catalogStatus === 'retained',
    )
    return retained ? { ...finding, catalogStatus: 'retained' as const } : finding
  })
}

/** A change record as `explainedBy` carries it: with the catalog version that made the change. */
export type ExplainingRecord = ChangeRecord & { catalogVersion: number }

/** What `explainedBy` reads of a compared finding. */
export type Explainable = Targeted & {
  effect: string
  attribution: { key: string }
  baselineState: BaselineState | null
  changedReasons: readonly { reason: string; before: unknown; after: unknown }[]
  notes: readonly { kind: string; before?: unknown }[]
  occurrences: readonly { evidence: { pathRule?: string } }[]
}

/**
 * Sets `explainedBy` (§4 Catalog versions) on each delta that a change record between the baseline's catalog version
 * and the scan's could explain, with those records in changelog order. Only `added`, `removed` and `changed` findings,
 * and `existing` ones with a `rekeyed` note, are deltas: never `unconfirmed` or plain `existing`. A baseline from the
 * same or a newer catalog version gives none.
 *
 * A record is about a delta when it names the delta's target, the member the target shadows on the current side (its
 * `shadows`) or the baseline side (worked out from the current catalog, with the record's own targets, since a
 * `removed` entry stores none), or a wildcard's holder. Then, by the §4 table:
 * - `target` added / dropped: `added` / `removed`, and `changed` (`effect`) where the finding was or becomes an `add`
 * - `protected-entry` gained / lost: `added` / `removed` that the entry covers (§12 Matching), under `--surface protected`
 * - `member-data`: `added`, `removed`, and `changed` (`locks` or `effect`)
 * - `holder` added, dropped or re-chained: `added` / `removed` of targets named on it, shadowing through it, or reached
 *   through it (on the holder its prototype was or becomes)
 * - `immutable-prototype`: `added` / `removed` of its `prototype-change`
 * - `framework-path-rule`: `changed` (`attribution`), and a `rekeyed` pair, where an occurrence was named by the rule
 *   or either side's key is a package the rule names
 * - `url-normalization`: `changed` (`attribution`) between `url:` keys, and an `added` / `removed` pair: an `added` and
 *   a `removed` finding of the same target and effect, both with `url:` keys
 */
export function withExplainedBy<F extends Explainable>(
  findings: readonly F[],
  input: {
    catalog: SerializedCatalog
    changelog: CatalogChangelog
    /** The baseline's catalog version, or null without a baseline. */
    baselineCatalogVersion: number | null
    surface: 'protected' | 'all'
  },
): (F & { explainedBy?: ExplainingRecord[] })[] {
  const { catalog, changelog, baselineCatalogVersion: since } = input
  if (since === null) return [...findings]
  const current = catalog.metadata.catalogVersion
  const records = changelog.versions
    .filter(({ catalogVersion }) => catalogVersion > since && catalogVersion <= current)
    .flatMap(({ catalogVersion, changes }) => changes.map((change): ExplainingRecord => ({ catalogVersion, ...change })))
  if (records.length === 0) return [...findings]
  const context = explainContext(catalog, records, input.surface, findings)
  return findings.map((finding) => {
    const delta = deltaOf(finding)
    if (delta === undefined) return finding
    const explainedBy = records.filter((record) => explains(record, finding, delta, context))
    return explainedBy.length === 0 ? finding : { ...finding, explainedBy }
  })
}

/** How a finding differs from the baseline, when it is a delta. */
interface Delta {
  state: 'added' | 'removed' | 'changed' | 'existing'
  reasons: ReadonlySet<string>
  rekeyed: boolean
}

function deltaOf(finding: Explainable): Delta | undefined {
  const { baselineState: state } = finding
  const rekeyed = finding.notes.some(({ kind }) => kind === 'rekeyed')
  if (state === 'added' || state === 'removed' || state === 'changed' || (state === 'existing' && rekeyed)) {
    return { state, reasons: new Set(finding.changedReasons.map(({ reason }) => reason)), rekeyed }
  }
  return undefined
}

interface ExplainContext {
  catalog: SerializedCatalog
  /** Per realm, the target names the records add or drop, which a baseline-side shadow may be. */
  recordTargets: Map<Realm, Set<string>>
  /** Per realm, the holders the records drop, which a target may still be named on. */
  droppedHolders: Map<Realm, Set<string>>
  surface: 'protected' | 'all'
  /** The protected surface of each `protected-entry` record alone. */
  covers: Map<ExplainingRecord, IsProtected>
  /** The `pairKey` of each `added` or `removed` finding with a `url:` key, which a URL normalization pair is made of. */
  urlDeltas: Set<string>
}

/** A finding's realm, target, effect and baseline state, which an `added` / `removed` pair matches on. */
function pairKey({ target, effect }: Explainable, state: string): string {
  return JSON.stringify([target.realm, target.name, effect, state])
}

function explainContext(
  catalog: SerializedCatalog,
  records: readonly ExplainingRecord[],
  surface: 'protected' | 'all',
  findings: readonly Explainable[],
): ExplainContext {
  const recordTargets = new Map<Realm, Set<string>>()
  const droppedHolders = new Map<Realm, Set<string>>()
  const add = (map: Map<Realm, Set<string>>, realm: Realm, name: string) => {
    let names = map.get(realm)
    if (names === undefined) map.set(realm, (names = new Set()))
    names.add(name)
  }
  const covers = new Map<ExplainingRecord, IsProtected>()
  for (const record of records) {
    if (record.kind === 'target') add(recordTargets, record.realm, record.name)
    if (record.kind === 'holder' && record.change === 'dropped') add(droppedHolders, record.realm, record.holder)
    if (record.kind === 'protected-entry') {
      covers.set(record, protectedSurface({ ...catalog, protectedSurface: { [record.surface]: [record.entry] } }))
    }
  }
  const urlDeltas = new Set(
    findings
      .filter(({ baselineState: state, attribution }) => (state === 'added' || state === 'removed') && attribution.key.startsWith('url:'))
      .map((finding) => pairKey(finding, finding.baselineState!)),
  )
  return { catalog, recordTargets, droppedHolders, surface, covers, urlDeltas }
}

/** The holder a target name is on in the current catalog, or on a holder the records drop. */
function holderIn(name: string, realm: Realm, context: ExplainContext): string | undefined {
  const holders = context.catalog.holders[realm]
  const dropped = context.droppedHolders.get(realm)
  const known = (holder: string) => Object.hasOwn(holders, holder) || dropped?.has(holder) === true
  const bracket = name.indexOf('["')
  if (bracket >= 0) return known(name.slice(0, bracket)) ? name.slice(0, bracket) : undefined
  for (let dot = name.lastIndexOf('.'); dot > 0; dot = name.lastIndexOf('.', dot - 1)) {
    if (known(name.slice(0, dot))) return name.slice(0, dot)
  }
  return undefined
}

/**
 * The catalog members a finding's target is about: its name, its `shadows`, and the member it shadows worked out from
 * the current catalog: the first holder up its chain whose member of that key the catalog lists or a record adds or
 * drops. A wildcard is about no member.
 */
function membersOf({ realm, name, shadows }: Targeted['target'], context: ExplainContext): string[] {
  if (name.endsWith('*')) return []
  const members = [name, ...(shadows === undefined ? [] : [shadows])]
  const holder = holderIn(name, realm, context)
  if (holder === undefined) return members
  const key = name.slice(holder.length)
  const holders = context.catalog.holders[realm]
  const recorded = context.recordTargets.get(realm)
  for (let at = holders[holder]?.proto ?? null; at !== null; at = holders[at]?.proto ?? null) {
    const member = at + key
    if (recorded?.has(member) === true || Object.hasOwn(context.catalog.targets[realm], member)) {
      if (!members.includes(member)) members.push(member)
      break
    }
  }
  return members
}

/** The holder of a wildcard target (`<holder>.*`, `<holder>.<prefix>*`), or undefined for any other target. */
function wildcardHolder({ realm, name }: Targeted['target'], context: ExplainContext): string | undefined {
  return name.endsWith('*') ? holderIn(name, realm, context) : undefined
}

function explains(record: ExplainingRecord, finding: Explainable, delta: Delta, context: ExplainContext): boolean {
  const { state, reasons } = delta
  const addOrRemove = state === 'added' || state === 'removed'
  const { target } = finding
  switch (record.kind) {
    case 'target': {
      if (record.realm !== target.realm || !touches(record.name, finding, context)) return false
      if (state === (record.change === 'added' ? 'added' : 'removed')) return true
      const effect = finding.changedReasons.find(({ reason }) => reason === 'effect')
      return state === 'changed' && effect !== undefined && (effect.before === 'add' || effect.after === 'add')
    }
    case 'protected-entry': {
      if (context.surface !== 'protected' || state !== (record.change === 'gained' ? 'added' : 'removed')) return false
      const covers = context.covers.get(record)!
      const shadows = membersOf(target, context).slice(1)
      return [undefined, ...shadows].some((shadow) =>
        covers({ realm: target.realm, name: target.name, ...(shadow === undefined ? {} : { shadows: shadow }) }, finding.effect),
      )
    }
    case 'member-data':
      return (
        record.realm === target.realm &&
        touches(record.name, finding, context) &&
        (addOrRemove || (state === 'changed' && (reasons.has('locks') || reasons.has('effect'))))
      )
    case 'holder': {
      if (record.realm !== target.realm || !addOrRemove) return false
      const neighbours = [record.before?.proto, record.after?.proto].filter((proto) => typeof proto === 'string')
      const wildcard = wildcardHolder(target, context)
      if (wildcard !== undefined) return wildcard === record.holder
      const members = membersOf(target, context)
      const holders = members.map((member) => holderIn(member, target.realm, context))
      if (holders.some((holder) => holder === record.holder || neighbours.includes(holder!))) return true
      return throughChain(holders[0], holders.slice(1), record.holder, target.realm, context)
    }
    case 'immutable-prototype':
      return (
        record.realm === target.realm &&
        addOrRemove &&
        finding.effect === 'prototype-change' &&
        target.name === `${record.holder}.[[Prototype]]`
      )
    case 'framework-path-rule': {
      if (!((state === 'changed' && reasons.has('attribution')) || delta.rekeyed)) return false
      if (finding.occurrences.some(({ evidence }) => evidence.pathRule === record.id)) return true
      const packages = [record.before?.package, record.after?.package].filter((name) => name !== undefined)
      return keysOf(finding).some((key) => packages.some((name) => packagePattern(name).test(key)))
    }
    case 'url-normalization':
      if (addOrRemove) {
        const other = state === 'added' ? 'removed' : 'added'
        return finding.attribution.key.startsWith('url:') && context.urlDeltas.has(pairKey(finding, other))
      }
      return state === 'changed' && reasons.has('attribution') && keysOf(finding).some((key) => key.startsWith('url:'))
  }
}

/** Whether a record's target is one the finding is about, or a wildcard finding's holder is the target's holder. */
function touches(name: string, finding: Explainable, context: ExplainContext): boolean {
  const wildcard = wildcardHolder(finding.target, context)
  if (wildcard !== undefined) return holderIn(name, finding.target.realm, context) === wildcard
  return membersOf(finding.target, context).includes(name)
}

/** Whether `holder` is on the chain from `from` up to any of `to`, the holders of the members the target shadows. */
function throughChain(from: string | undefined, to: readonly (string | undefined)[], holder: string, realm: Realm, context: ExplainContext): boolean {
  if (from === undefined) return false
  const holders = context.catalog.holders[realm]
  for (let at = holders[from]?.proto ?? null; at !== null && !to.includes(at); at = holders[at]?.proto ?? null) {
    if (at === holder) return true
  }
  return false
}

/** The attribution keys a finding had and has: its own, a `changed` (`attribution`) before, and a `rekeyed` before. */
function keysOf(finding: Explainable): string[] {
  const keys = [finding.attribution.key]
  for (const { reason, before } of finding.changedReasons) if (reason === 'attribution') keys.push(String(before))
  for (const { kind, before } of finding.notes) if (kind === 'rekeyed' && Array.isArray(before)) keys.push(...before.map(String))
  return keys
}

/** The `pkg:` keys of the package a framework path rule names, where `<name>` stands for any captured value. */
function packagePattern(template: string): RegExp {
  const parts = template.split(/<[^>]+>/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^pkg:${parts.join('[^/]+')}$`)
}

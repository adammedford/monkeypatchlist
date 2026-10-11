// Compare (§19, module 7): matches findings against a baseline or previous report, giving baseline states,
// `changedReasons` and notes (§11). It knows nothing of the policy.

import {
  installContexts,
  reachabilities,
  type Effect,
  type InstallContext,
  type LimitationKind,
  type Reachability,
  type ReachabilityBasis,
} from '../analysis/index.ts'
import type { Baseline, BaselineEntry, BaselineState, PackageVersion, PreviousValues } from '../baseline/index.ts'
import type { Completeness } from '../completeness/index.ts'
import type { Confidence } from '../confidence/index.ts'
import { compareStrings, targetKey, type Finding } from '../findings/index.ts'
import type { ExplainingRecord } from './lib/catalog-notes.ts'

export { withCatalogStatus, withExplainedBy, type ExplainingRecord } from './lib/catalog-notes.ts'

/** How a finding compares with the baseline (§11). The baseline package defines it, since what it accepts depends on it. */
export type { BaselineState } from '../baseline/index.ts'

/** The matching pass that paired a finding with a baseline entry (§11 Baseline states and matching). */
export type MatchedBy = 'fingerprint' | 'effect' | 'target-key'

/**
 * Why a paired finding is `changed`, with the baseline entry's value before and the finding's after (§11 `changed`). An
 * `attribution` reason's values are attribution keys.
 */
export type ChangedReason =
  | { reason: 'attribution'; before: string; after: string }
  | { reason: 'effect'; before: Effect; after: Effect }
  | { reason: 'locks'; before: boolean; after: boolean }

/**
 * A note on a finding (§11, §15 Findings). `rekeyed`: the target-key pass paired it across `unknown`, from the paired
 * baseline entries' attribution keys (`before`) to its own (`after`). `shared-target-key`: it stays `added` or `removed`
 * because its target-key group is ambiguous, and `fingerprints` are the other side's known keys it could have paired
 * with. `previous-version`: its containing package has a strong version on both sides and they differ (§11
 * `previousVersion`), from the baseline's version (`before`) to the scan's (`after`). `reachability-change` and
 * `install-context-change`: its reachability or install context differs from the previous scan's value for the finding
 * it paired with (§11 Never `changed`), from that value (`before`) to its own (`after`). They never decide a state.
 */
export type FindingNote =
  | { kind: 'rekeyed'; before: string[]; after: string }
  | { kind: 'shared-target-key'; fingerprints: string[] }
  | { kind: 'previous-version'; package: string; before: string; after: string }
  | { kind: 'reachability-change'; before: Reachability; after: Reachability }
  | { kind: 'install-context-change'; before: InstallContext; after: InstallContext }

/**
 * A scanned finding with its baseline state, or a baseline entry the scan didn't find. That one has the entry's readable
 * context, no occurrences, and no confidence, which only occurrences give (§15 Findings).
 */
export interface ComparedFinding
  extends Omit<Finding, 'confidence' | 'reachability' | 'reachabilityBasis' | 'installContext'> {
  confidence: Confidence | null
  /** Null for a baseline entry the scan didn't find, which has no occurrences (§15 Findings). */
  reachability: Reachability | null
  /** Its basis (§7), null as `reachability` is. */
  reachabilityBasis: ReachabilityBasis | null
  /** Null for a baseline entry the scan didn't find, as `reachability` is (§15 Findings). */
  installContext: InstallContext | null
  /** Null when there is no readable baseline (§11 No baseline). */
  baselineState: BaselineState | null
  /** The pass that paired it with a baseline entry, or null when nothing did. */
  matchedBy: MatchedBy | null
  /** Before → after for each reason the finding is `changed`, in the §11 table's order. Empty unless it is `changed`. */
  changedReasons: ChangedReason[]
  /**
   * Notes on how it was matched (§11), `rekeyed` or `shared-target-key`, then its `previous-version`, then its
   * `reachability-change` and `install-context-change`.
   */
  notes: FindingNote[]
  /** Set when its target, or the member it shadows, is a retained target (§4 Catalog versions): information only. */
  catalogStatus?: 'retained'
  /**
   * The catalog changelog's records that could explain this delta (§4 Catalog versions), in changelog order. Absent when
   * none does, and never set on `unconfirmed` or on `existing` without a `rekeyed` note. Never baselined.
   */
  explainedBy?: ExplainingRecord[]
}

/**
 * The limitation kinds that say a scan skipped or refused a remote script (§13): `offline-skipped` in `offline` mode,
 * and `remote-refused` by the safety floor (§17). A remote baseline entry may be in the code the scan didn't see.
 */
const remoteGapKinds: ReadonlySet<LimitationKind> = new Set(['offline-skipped', 'remote-refused'])

/** How a finding and a baseline entry were paired: by which pass, and in the target-key pass, by which rule. */
type Pairing = { entry: BaselineEntry; by: 'fingerprint' | 'effect' | 'attribution' | 'rekeyed' }

/**
 * Compares findings with the baseline (§11 Baseline states and matching), in order:
 *
 * 1. By exact fingerprint.
 * 2. The effect pass: a finding and an entry left over with the same realm, target and attribution key but a different
 *    effect pair when each is the only one left in that group (1:1). A paired finding is `changed`, reason `effect`.
 * 3. The target-key pass, over the findings and entries left over by target key `(realm, target, effect)`, plus any
 *    `unknown` finding or entry the exact pass matched. A known key pairs with a known key 1:1 only: `changed`,
 *    reason `attribution`. An `unknown` finding pairs with every known entry left over in its group, and an `unknown`
 *    entry with every known finding left over, as a `rekeyed` pair; both rules apply in one group. The known
 *    findings and entries of a group with both but not 1:1 that nothing pairs stay `added` and `removed`, with a
 *    `shared-target-key` note.
 *
 * A paired finding whose `locks` went `true` ↔ `false` against any entry it pairs with is `changed`, reason `locks`,
 * once per such entry; `unknown` on either side is no change. A paired finding with no reason is `existing`, and a
 * finding nothing paired is `added`. An entry that matches no finding is `unconfirmed` when the scan could not have seen
 * it (§13 Effects on the baseline and the gate): it is `incomplete`, a link group exhausted its step budget, or the entry
 * is remote and a remote script was skipped. It is `removed` otherwise. Without a baseline, every finding's state is
 * null. The result is sorted by fingerprint.
 *
 * Whatever its state, a finding whose containing package has a strong version in both the scan's `packages` map and
 * the baseline's, and they differ, gets a `previous-version` note (§11 `previousVersion`). The version never decides a
 * state.
 *
 * With `previous`, the values of a previous scan, an `existing` or `changed` finding whose reachability or install
 * context differs from the previous value of a baseline entry it paired with gets a `reachability-change` or
 * `install-context-change` note, one per distinct previous value (§11 Never `changed`). The previous value is the
 * one under the entry's fingerprint, so it follows the pairing, a `rekeyed` one included. These notes never decide a
 * state, and need a baseline.
 */
export function compare(
  findings: readonly Finding[],
  baseline: Baseline | null,
  completeness: Pick<Completeness, 'level' | 'limitations' | 'counters'>,
  packages: Readonly<Record<string, PackageVersion>> = {},
  previous: PreviousValues | null = null,
): ComparedFinding[] {
  if (baseline === null) {
    return findings.map((finding) => ({
      ...finding,
      baselineState: null,
      matchedBy: null,
      changedReasons: [],
      notes: [],
    }))
  }
  return states(findings, baseline, completeness).map(([finding, paired]) => {
    const notes = [...finding.notes]
    const name = finding.attribution.package
    const [before, after] = name === undefined ? [] : [baseline.packages[name], packages[name]]
    if (name !== undefined && before !== undefined && after !== undefined && before.version !== after.version) {
      notes.push({ kind: 'previous-version', package: name, before: before.version, after: after.version })
    }
    if (previous !== null) notes.push(...previousNotes(finding, paired, previous))
    return notes.length === finding.notes.length ? finding : { ...finding, notes }
  })
}

/**
 * A paired finding's `reachability-change` and `install-context-change` notes (§11 Never `changed`): for each attribute,
 * one per distinct value that the previous scan gave a paired entry's fingerprint and that differs from the finding's
 * own, in the attribute's order.
 */
function previousNotes(finding: ComparedFinding, paired: readonly BaselineEntry[], previous: PreviousValues): FindingNote[] {
  const { reachability, installContext } = finding
  if (reachability === null || installContext === null) return []
  const values = paired.flatMap(({ fingerprint }) => previous.get(fingerprint) ?? [])
  const differing = <T>(order: readonly T[], before: T[], after: T) =>
    order.filter((value) => value !== after && before.includes(value))
  return [
    ...differing(
      reachabilities,
      values.map((value) => value.reachability),
      reachability,
    ).map((before): FindingNote => ({ kind: 'reachability-change', before, after: reachability })),
    ...differing(
      installContexts,
      values.map((value) => value.installContext),
      installContext,
    ).map((before): FindingNote => ({ kind: 'install-context-change', before, after: installContext })),
  ]
}

/**
 * Each finding's baseline state, how it was matched, its `changedReasons` and its matching notes (§11), with the
 * baseline entries it paired with (none for an `added` finding or an entry the scan didn't find).
 */
function states(
  findings: readonly Finding[],
  baseline: Baseline,
  completeness: Pick<Completeness, 'level' | 'limitations' | 'counters'>,
): [ComparedFinding, BaselineEntry[]][] {

  const entries = new Map(baseline.entries.map((entry) => [entry.fingerprint, entry]))
  const pairs = new Map<Finding, Pairing[]>()
  const pair = (finding: Finding, pairing: Pairing) => {
    const found = pairs.get(finding)
    if (found === undefined) pairs.set(finding, [pairing])
    else found.push(pairing)
  }
  // `unknown` findings and entries the exact or the effect pass paired still take part in the target-key pass.
  const rejoin = { findings: [] as Finding[], entries: [] as BaselineEntry[] }
  const rejoinUnknown = (finding: Finding, entry: BaselineEntry) => {
    if (finding.attribution.key === unknownKey) rejoin.findings.push(finding)
    if (entry.attribution.key === unknownKey) rejoin.entries.push(entry)
  }
  for (const finding of findings) {
    const entry = entries.get(finding.fingerprint)
    if (entry === undefined) continue
    pair(finding, { entry, by: 'fingerprint' })
    entries.delete(finding.fingerprint)
    rejoinUnknown(finding, entry)
  }
  for (const [finding, entry] of effectPairs(
    findings.filter((finding) => !pairs.has(finding)),
    [...entries.values()],
  )) {
    pair(finding, { entry, by: 'effect' })
    entries.delete(entry.fingerprint)
    rejoinUnknown(finding, entry)
  }
  const shared = new Map<Finding | BaselineEntry, string[]>()
  for (const [finding, pairing] of targetKeyPairs(
    [...findings.filter((finding) => !pairs.has(finding)), ...rejoin.findings],
    [...entries.values(), ...rejoin.entries],
    shared,
  )) {
    pair(finding, pairing)
    entries.delete(pairing.entry.fingerprint)
  }

  const scanned = findings.map((finding): [ComparedFinding, BaselineEntry[]] => {
    const notes = sharedNote(shared.get(finding))
    const pairings = pairs.get(finding)
    if (pairings === undefined) {
      return [{ ...finding, baselineState: 'added', matchedBy: null, changedReasons: [], notes }, []]
    }
    const changedReasons = pairings
      .flatMap(({ entry, by }) => reasons(entry, finding, by))
      .sort((a, b) => reasonOrder.indexOf(a.reason) - reasonOrder.indexOf(b.reason))
    const rekeyed = [...new Set(pairings.flatMap(({ entry, by }) => (by === 'rekeyed' ? [entry.attribution.key] : [])))]
    const compared: ComparedFinding = {
      ...finding,
      baselineState: changedReasons.length === 0 ? 'existing' : 'changed',
      matchedBy: matchedBy(pairings[0]!.by),
      changedReasons,
      notes:
        rekeyed.length === 0
          ? notes
          : [{ kind: 'rekeyed', before: rekeyed.sort(compareStrings), after: finding.attribution.key }, ...notes],
    }
    return [compared, pairings.map(({ entry }) => entry)]
  })
  // An incomplete scan failed to analyze something its configuration asks for, so it can't confirm that any entry is
  // gone, and nor can one in which any link group exhausted its step budget; a Principle 5 cap cut alone can. A
  // scan that skipped or refused a remote script can't confirm that a remote entry is.
  const incomplete = completeness.level === 'incomplete' || completeness.counters.statistics.budgetExhausted > 0
  const remoteGap = completeness.limitations.some(({ kind }) => remoteGapKinds.has(kind))
  const unseen = ({ attribution }: BaselineEntry) => incomplete || (remoteGap && attribution.provenance === 'remote')
  const missing = [...entries.values()].map((entry): [ComparedFinding, BaselineEntry[]] => [
    unmatched(entry, unseen(entry) ? 'unconfirmed' : 'removed', sharedNote(shared.get(entry))),
    [],
  ])
  return [...scanned, ...missing].sort(([a], [b]) => compareStrings(a.fingerprint, b.fingerprint))
}

/** The attribution key of code that can't be attributed (§11). */
const unknownKey = 'unknown'

/** The §11 table's order of `changed` reasons. */
const reasonOrder: readonly ChangedReason['reason'][] = ['attribution', 'effect', 'locks']

const matchedBy = (by: Pairing['by']): MatchedBy => (by === 'attribution' || by === 'rekeyed' ? 'target-key' : by)

const sharedNote = (fingerprints: string[] | undefined): FindingNote[] =>
  fingerprints === undefined ? [] : [{ kind: 'shared-target-key', fingerprints }]

/**
 * The target-key pass (§11 Baseline states and matching, step 3) over `findings` and `entries` grouped by target key.
 * In each group, a lone known finding and a lone known entry pair (`attribution`); an `unknown` finding pairs with every
 * known entry, and an `unknown` entry with every known finding (`rekeyed`). A group whose known findings and entries
 * aren't 1:1 is ambiguous: `shared` gets, for each of its known members nothing pairs, the other side's fingerprints.
 */
function targetKeyPairs(
  findings: readonly Finding[],
  entries: readonly BaselineEntry[],
  shared: Map<Finding | BaselineEntry, string[]>,
): [Finding, Pairing][] {
  type Group = { findings: Finding[]; entries: BaselineEntry[] }
  const groups = new Map<string, Group>()
  const group = (key: string) => {
    let found = groups.get(key)
    if (found === undefined) groups.set(key, (found = { findings: [], entries: [] }))
    return found
  }
  for (const finding of findings) group(targetKey(finding.target, finding.effect)).findings.push(finding)
  for (const entry of entries) group(targetKey(entry.target, entry.effect)).entries.push(entry)

  const pairs: [Finding, Pairing][] = []
  for (const { findings: groupFindings, entries: groupEntries } of groups.values()) {
    const knownFindings = groupFindings.filter(({ attribution }) => attribution.key !== unknownKey)
    const knownEntries = groupEntries.filter(({ attribution }) => attribution.key !== unknownKey)
    const unknownFinding = groupFindings.find(({ attribution }) => attribution.key === unknownKey)
    const unknownEntry = groupEntries.find(({ attribution }) => attribution.key === unknownKey)
    const paired = new Set<Finding | BaselineEntry>()
    const add = (finding: Finding, entry: BaselineEntry, by: Pairing['by']) => {
      pairs.push([finding, { entry, by }])
      paired.add(finding).add(entry)
    }
    const [knownFinding] = knownFindings
    const [knownEntry] = knownEntries
    if (knownFindings.length === 1 && knownEntries.length === 1) add(knownFinding!, knownEntry!, 'attribution')
    if (unknownFinding !== undefined) for (const entry of knownEntries) add(unknownFinding, entry, 'rekeyed')
    if (unknownEntry !== undefined) for (const finding of knownFindings) add(finding, unknownEntry, 'rekeyed')
    if (knownFinding === undefined || knownEntry === undefined) continue
    for (const finding of knownFindings) {
      if (!paired.has(finding)) shared.set(finding, knownEntries.map(({ fingerprint }) => fingerprint).sort(compareStrings))
    }
    for (const entry of knownEntries) {
      if (!paired.has(entry)) shared.set(entry, knownFindings.map(({ fingerprint }) => fingerprint).sort(compareStrings))
    }
  }
  return pairs
}

/** A finding's or entry's `(realm, target, attribution key)`: its fingerprint without the effect (§11). */
const effectGroup = ({ target, attribution }: Pick<Finding, 'target' | 'attribution'>) =>
  `${target.realm}|${target.name}|${attribution.key}`

/**
 * The effect pass (§11 Baseline states and matching, step 2): the findings and entries left over, grouped by `(realm,
 * target, attribution key)`, pair where a group holds exactly one of each. They differ in effect, since the exact
 * fingerprints didn't match. Any other group is ambiguous and pairs nothing here.
 */
function effectPairs(findings: readonly Finding[], entries: readonly BaselineEntry[]): [Finding, BaselineEntry][] {
  const groups = new Map<string, { findings: Finding[]; entries: BaselineEntry[] }>()
  const group = (key: string) => {
    let found = groups.get(key)
    if (found === undefined) groups.set(key, (found = { findings: [], entries: [] }))
    return found
  }
  for (const finding of findings) group(effectGroup(finding)).findings.push(finding)
  for (const entry of entries) group(effectGroup(entry)).entries.push(entry)
  return [...groups.values()].flatMap(({ findings: [finding, ...moreFindings], entries: [entry, ...moreEntries] }) =>
    finding !== undefined && entry !== undefined && moreFindings.length === 0 && moreEntries.length === 0
      ? [[finding, entry] as [Finding, BaselineEntry]]
      : [],
  )
}

/**
 * Why a finding paired with `entry` is `changed` (§11 `changed`), before → after, in the table's order. The comparison
 * is symmetric. Nothing else, such as mechanism, confidence or occurrences, makes a finding `changed`.
 */
function reasons(entry: BaselineEntry, finding: Finding, by: Pairing['by']): ChangedReason[] {
  const changed: ChangedReason[] = []
  if (by === 'attribution') {
    changed.push({ reason: 'attribution', before: entry.attribution.key, after: finding.attribution.key })
  }
  if (entry.effect !== finding.effect) changed.push({ reason: 'effect', before: entry.effect, after: finding.effect })
  // A derived `locks` difference is a change `true` ↔ `false` only: `unknown` ↔ known is not.
  const [before, after] = [entry.locks, finding.locks]
  if (typeof before === 'boolean' && typeof after === 'boolean' && before !== after) {
    changed.push({ reason: 'locks', before, after })
  }
  return changed
}

/**
 * A baseline entry no finding matched, `removed` or `unconfirmed`, reported with its readable context and no
 * occurrences (§15 Findings).
 */
function unmatched(
  { fingerprint, target, surface, effect, locks, attribution }: BaselineEntry,
  baselineState: 'removed' | 'unconfirmed',
  notes: FindingNote[],
): ComparedFinding {
  return {
    fingerprint,
    targetKey: targetKey(target, effect),
    target,
    surface,
    effect,
    locks,
    attribution,
    reachability: null,
    reachabilityBasis: null,
    installContext: null,
    confidence: null,
    occurrences: [],
    baselineState,
    matchedBy: null,
    changedReasons: [],
    notes,
  }
}

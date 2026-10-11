// The positive set of each library (§20 Scoring rules): runtime ground truth, plus runtime-confirmed variant runs,
// plus the hand labels, all restricted to catalog targets.

import type { SerializedCatalog } from '../../src/catalog.ts'
import { CorpusError } from './corpus-error.ts'

/** A mutation record, as the corpus harness writes it (corpus README, Mutation record). */
export interface GroundTruthMutation {
  target: string
  holder: string
  key: string
  effect: string
  shadows?: string
}

/** A hand label (`labels/unobserved.json`): a mutation in the code that no Chromium run executed. */
export interface HandLabel {
  target: string
  effect: string
  reachability: string
  /** Present when a rule corrected its reachability (corpus README): it beats a derived label (§20). */
  correction?: unknown
}

/** A target the library mutates, in the window realm: the only realm the corpus snapshots (§20). */
export interface Positive {
  /** The realm-free target name, as the catalog spells it: `Array.prototype.@@iterator`, `history.pushState`. */
  name: string
  /** The object written, named as the catalog names holders: `Array.prototype`, `history`. */
  holder: string
  key: string
  /** For a shadowing write, the inherited member it shadows. */
  shadows?: string
  effects: string[]
  /** Some Chromium run observed it. */
  observed: boolean
  /** A hand label names it. */
  handLabeled: boolean
  /**
   * It can only run where a native is missing: the only runs that observed it deleted natives first (native-absent),
   * and every hand label on it says `guarded-native-absence` (a rule-corrected `conditional` label lifts it). A finding
   * on it is a true positive only when tagged `guarded-native-absence` or `conditional` (§20 True positives).
   */
  absenceOnly: boolean
  /** The scoring group it belongs to, which is scored as one unit. */
  group?: 'zone-symbol-adds'
  /**
   * The reachability values a finding on it may have (§20 Reachability labels), or none when nothing labels it:
   * - a rule-corrected hand label's value, which beats a derived label
   * - observed in the base run: its reachability hand-sample label, when the sample has one; otherwise not
   *   `guarded-native-absence` (`unconditional` or `conditional`)
   * - observed with natives present only in the features-on or lazy-chunks runs: `conditional`
   * - observed only where natives were deleted: `guarded-native-absence`
   * - otherwise, its hand labels' values
   */
  reachabilityLabel?: string[]
  /** A Chromium run with every native present observed it: the base run, features-on or lazy-chunks (§20 rules). */
  observedWithNatives: boolean
}

/** The exercise variant that deletes natives before load (corpus README, Exercise variants). */
const nativeAbsent = 'native-absent'

export interface LibraryEvidence {
  library: string
  /** Every Chromium run of the library's builds: `base`, or the exercise variant it belongs to. */
  runs: readonly { run: string; mutations: readonly GroundTruthMutation[] }[]
  handLabels: readonly HandLabel[]
  /** The reachability hand sample's labels (§20): each settles a base-run positive's `unconditional` or `conditional`. */
  sample?: readonly { target: string; reachability: string }[]
}

export interface PositiveSet {
  /** By name. */
  positives: Map<string, Positive>
  /**
   * The names of mutations that are not catalog targets, sorted: a member Web IDL synthesizes, such as
   * `NodeList.prototype.forEach`, or a Web IDL structural property, such as `Request.prototype.constructor`.
   */
  excluded: string[]
}

export function positivesOf(catalog: SerializedCatalog, { library, runs, handLabels, sample = [] }: LibraryEvidence): PositiveSet {
  const targets = catalog.targets.window
  const holders = catalog.holders.window
  const positives = new Map<string, Positive>()
  const excluded = new Set<string>()
  const evidence = new Map<string, { runs: Set<string>; labels: string[]; corrected: string[] }>()
  const add = (
    mutation: GroundTruthMutation,
    source: 'observed' | 'handLabeled',
    absence: boolean,
    run: { run: string } | { label: HandLabel },
  ) => {
    const name = catalogSpelling(mutation.target)
    const holder = catalogSpelling(mutation.holder)
    const key = catalogSpelling(mutation.key)
    const shadows = mutation.shadows === undefined ? undefined : catalogSpelling(mutation.shadows)
    const onCatalog =
      positives.has(name) ||
      targets[name] !== undefined ||
      (shadows !== undefined && targets[shadows] !== undefined) ||
      ((mutation.effect === 'add' || mutation.effect === 'prototype-change') && holders[holder] !== undefined)
    if (!onCatalog) {
      excluded.add(name)
      return
    }
    const positive = positives.get(name) ?? {
      name,
      holder,
      key,
      ...(shadows === undefined ? {} : { shadows }),
      effects: [],
      observed: false,
      handLabeled: false,
      absenceOnly: true,
      observedWithNatives: false,
      // zone.js's `__zone_symbol__*` adds are one group (§20 Scoring unit).
      ...(library === 'zonejs' && mutation.effect === 'add' && key.startsWith('__zone_symbol__')
        ? { group: 'zone-symbol-adds' as const }
        : {}),
    }
    if (!positive.effects.includes(mutation.effect)) positive.effects.push(mutation.effect)
    positive[source] = true
    positive.absenceOnly &&= absence
    positives.set(name, positive)
    const seen = evidence.get(name) ?? { runs: new Set<string>(), labels: [], corrected: [] }
    if ('run' in run) seen.runs.add(run.run)
    else (run.label.correction === undefined ? seen.labels : seen.corrected).push(run.label.reachability)
    evidence.set(name, seen)
  }
  for (const { run, mutations } of runs) {
    for (const mutation of mutations) add(mutation, 'observed', run === nativeAbsent, { run })
  }
  for (const label of handLabels) {
    const target = catalogSpelling(label.target)
    const dot = target.lastIndexOf('.')
    const [holder, key] = [target.slice(0, dot), target.slice(dot + 1)]
    const shadows = inheritedMember(catalog, target, holder, key)
    const mutation = { target, holder, key, effect: label.effect, ...(shadows === undefined ? {} : { shadows }) }
    add(mutation, 'handLabeled', label.reachability === 'guarded-native-absence', { label })
  }
  for (const { target } of sample) {
    if (!evidence.get(catalogSpelling(target))?.runs.has('base')) {
      throw new CorpusError(`reachability sample: ${library} '${target}': names no positive the base run observed`)
    }
  }
  for (const [name, { runs, labels, corrected }] of evidence) {
    const positive = positives.get(name)!
    positive.observedWithNatives = [...runs].some((run) => run !== nativeAbsent)
    const sampled = sample.find((s) => catalogSpelling(s.target) === name)?.reachability
    const label = reachabilityLabel(runs, labels, corrected, sampled)
    if (label.length) positive.reachabilityLabel = label
  }
  return { positives, excluded: [...excluded].filter((name) => !positives.has(name)).sort() }
}

/** A positive's reachability label (§20 Reachability labels): the values a finding on it may have. */
function reachabilityLabel(
  runs: ReadonlySet<string>,
  labels: readonly string[],
  corrected: readonly string[],
  sampled: string | undefined,
): string[] {
  const sorted = (values: readonly string[]) => [...new Set(values)].sort()
  if (corrected.length) return sorted(corrected)
  if (runs.has('base')) return sampled === undefined ? ['conditional', 'unconditional'] : [sampled]
  if ([...runs].some((run) => run !== nativeAbsent)) return ['conditional']
  if (runs.has(nativeAbsent)) return ['guarded-native-absence']
  return sorted(labels)
}

/**
 * For a hand-labeled write that isn't itself a catalog target, the member it shadows: the first one named `key` along
 * its holder's prototype chain in the catalog (§4 Naming rules). A hand label names only the target; a Chromium run
 * records `shadows` itself, from what the object inherited when it was snapshotted.
 */
function inheritedMember(catalog: SerializedCatalog, name: string, holder: string, key: string): string | undefined {
  const targets = catalog.targets.window
  const holders = catalog.holders.window
  if (targets[name] !== undefined) return undefined
  for (let next = holders[holder]?.proto ?? null; next !== null; next = holders[next]?.proto ?? null) {
    if (targets[`${next}.${key}`] !== undefined) return `${next}.${key}`
  }
  return undefined
}

/** The corpus writes symbol keys as `[Symbol.iterator]`; the catalog, as ECMA-262 does, as `@@iterator` (§4). */
function catalogSpelling(name: string): string {
  return name.replace(/\[Symbol\.(\w+)\]/g, '@@$1')
}

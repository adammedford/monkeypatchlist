// Completeness (§13, §19 Failures are data): the one completeness aggregator. Every module reports what it could not
// analyze as limitation records in its return value; this module applies §13's table to all of them, gives the scan
// its level, and counts. No other module decides `incomplete`.

import type { Realm } from '../../catalog.ts'
import type { AnalyzeGroupOutput, Budget, GeneratedLocation, LimitationKind } from '../analysis/index.ts'
import type { Confidence } from '../confidence/index.ts'
import type { Introducers } from '../attribution/index.ts'
import { compareStrings } from '../findings/index.ts'

/** A scan's completeness levels (§13). */
export const levels = ['complete', 'complete-with-limitations', 'incomplete'] as const

export type Level = (typeof levels)[number]

/**
 * A limitation record (§13): `{kind, artifact (URL or path, plus hash if known), location (for in-code kinds),
 * detail}`. The resolver's records are these, with a URL and a hash; discovery's may lack the hash.
 */
export interface LimitationRecord {
  kind: LimitationKind
  artifact: { url?: string; path?: string; hash?: string }
  location?: GeneratedLocation
  detail: string
}

/**
 * The fixed level of each limitation kind (§13 Limitation kinds). There are no thresholds and nothing is
 * configurable, so the same records always give the same level.
 */
export const kindLevels: Record<LimitationKind, Exclude<Level, 'complete'>> = {
  'parse-failure': 'incomplete',
  unreadable: 'incomplete',
  'source-maps-unpaired': 'incomplete',
  'fetch-failed': 'incomplete',
  'sri-mismatch': 'incomplete',
  'remote-refused': 'complete-with-limitations',
  'offline-skipped': 'complete-with-limitations',
  'dynamic-code': 'complete-with-limitations',
  'unresolved-reference': 'complete-with-limitations',
  'realm-uncertain': 'complete-with-limitations',
  'unresolved-holder': 'complete-with-limitations',
  'unlinked-module-call': 'complete-with-limitations',
  'analysis-budget': 'complete-with-limitations',
}

/** The kinds that mean an artifact failed: it is known, but its code was never analyzed (§13 Counters). */
const failureKinds = ['parse-failure', 'unreadable', 'fetch-failed', 'sri-mismatch'] as const

/** The kinds of record that name an artifact whose bytes weren't read. */
const unreadKinds: ReadonlySet<LimitationKind> = new Set<LimitationKind>([
  'unreadable',
  'fetch-failed',
  'sri-mismatch',
  'offline-skipped',
  'remote-refused',
])

/**
 * Why an artifact failed (§13 Counters `failed` by reason): a failure record names it, or the crash guard fired before
 * the link group that would have analyzed it ran (`crash-guard`). The crash guard raises no record: it is not a
 * limitation kind.
 */
const failureReasons = [...failureKinds, 'crash-guard'] as const

export type FailureReason = (typeof failureReasons)[number]

/** The blind-spot counters (§13 Counters), and the kind each one counts. */
const blindSpotKinds = {
  dynamicCode: 'dynamic-code',
  unresolvedReference: 'unresolved-reference',
  realmUncertain: 'realm-uncertain',
  unresolvedHolder: 'unresolved-holder',
} as const satisfies Record<string, LimitationKind>

/**
 * An artifact of the scan: a URL in one realm (§2 Realm), run as one source type, since a file a page runs both as a
 * classic script and as a module is an artifact each way (§2 Files that don't run as referenced).
 */
export interface ArtifactKey {
  url: string
  realm: Realm
  sourceType: 'script' | 'module'
}

/** The artifact fields the aggregator reads: which records name it, what they may be missing, and how it was found. */
export interface CountedArtifact extends ArtifactKey {
  path: string | null
  hash: string | null
  discovery: 'reference' | 'injected' | 'sweep'
  sourceMap: SourceMapPairing
  /** How many candidate maps failed verification against it (§2 Source maps). */
  staleCandidates: number
  /** The maps a remote artifact names that weren't read (§17 Content types), by why. */
  unreadMaps: UnreadMaps
}

/**
 * The maps a remote artifact's `SourceMap` header or `sourceMappingURL` annotation names that weren't read (§17 Content
 * types), by why: the safety floor `refused` the fetch, it `failed`, or the map is a build file that
 * exists but can't be read (`unreadable`). They change these counters only, never completeness. A missing build file
 * is counted nowhere, as a local artifact's is (§2 Source maps).
 */
export interface UnreadMaps {
  refused: number
  failed: number
  unreadable: number
}

/**
 * The build files the sweep found and skipped (§2 Sweep, Content that isn't JavaScript): the JavaScript and WebAssembly
 * files no URL mapping serves (`excluded`), by build-relative path, and how many WebAssembly files a mapping serves
 * (`nonJs`). They are known, and counted as skipped. `otherFiles` counts the other files a mapping serves that no
 * reference found, which the sweep takes for neither JavaScript nor WebAssembly: informational, and not artifacts.
 */
export interface SweptFiles {
  excluded: readonly string[]
  nonJs: number
  otherFiles: number
}

/**
 * The methods that pair a source map with an artifact (§2 Source maps), in the order they are tried: in the build
 * directory, then in each source-map directory.
 */
export const pairingMethods = [
  'header',
  'annotation',
  'sidecar',
  'debug-id',
  'external-debug-id',
  'external-annotation',
  'external-sidecar',
] as const

export type PairingMethod = (typeof pairingMethods)[number]

/**
 * An artifact's source map (§2 Source maps, §15 Artifacts): the method that paired the first map that verified, and
 * the map's path: build-relative, or for a source-map directory's map, the directory as declared joined with its path
 * there (null for a `data:` URL or a fetched map). With none, the method is `none`, and the status says whether any
 * candidate was found: each failed verification (`stale`, with the first one's path), or none was (`none`).
 */
export type SourceMapPairing =
  | { method: PairingMethod; path: string | null; status: 'verified' }
  | { method: 'none'; path: string | null; status: 'stale' }
  | { method: 'none'; path: null; status: 'none' }

/**
 * The attribution block (§13): missing source maps are not a coverage limitation, so they are counted here. Every
 * artifact is counted once, with a map, without one, or with only broken (`stale`) ones, and each one with a map under
 * the method that paired it. `staleCandidates` counts every candidate map that failed verification (§2 Source maps),
 * once for each artifact it was tried for: those a later method's map replaced, and those of an artifact with only
 * broken maps. `unreadMaps` counts the maps remote artifacts name that weren't read, the same way (§17).
 * `cappedFindings` counts the findings whose attribution confidence is capped below `high` (§9), by the level it is
 * capped at.
 */
export interface AttributionBlock {
  artifacts: { withMap: number; withoutMap: number; withBrokenMap: number }
  pairings: Record<PairingMethod, number>
  staleCandidates: number
  unreadMaps: UnreadMaps
  /** Each source-map directory's maps, in the order the directories were declared (§2 Source maps). */
  sourceMapDirectories: SourceMapDirectoryCounts[]
  cappedFindings: { medium: number; low: number }
  /** Why introducers are unknown (§10 Unknown is not empty): null with a usable lockfile, and its evidence. */
  introducers: Introducers
}

/**
 * What became of the maps of one source-map directory (§13 Attribution block), named by its `path` as declared. Its
 * maps are its `.map` files, in any case, and any other file a mirrored annotation named. `found` counts them all,
 * `paired` those that verified against an artifact through an external method, even one an earlier map had already
 * paired (§2 Source maps), and `orphaned` the rest, which verified against no artifact: `orphanedMaps` lists their
 * paths, relative to the directory, sorted. `stale` counts the orphaned maps that failed verification against an
 * artifact a method paired them with. A directory that can't be read has none.
 */
export interface SourceMapDirectoryCounts {
  path: string
  found: number
  paired: number
  stale: number
  orphaned: number
  orphanedMaps: string[]
}

/** HTML content that is not analyzed (§13 Counters, §19 HTML rules): informational, like `nonJs`. */
export interface HtmlCounters {
  nomodule: number
  inlineHandlers: number
}

/** What the resolver seam reports of one link group's work (§19): its steps, its step budget, and its caps. */
export type GroupStatistics = AnalyzeGroupOutput['stats']

/**
 * Scan statistics (§13 Counters, §18): the steps of every link group analyzed, their step budgets and how many of them
 * ran out, each cap's hits summed over them, keyed in code-unit order, and the budget and caps the scan ran with.
 * Budgets and caps are deterministic, so these are too. `crashGuard` says whether the wall-clock crash guard fired,
 * which alone makes a scan `incomplete` without a record.
 */
export interface Statistics {
  steps: number
  stepBudget: number
  /** How many link groups exhausted their step budget (§18). Any makes a missing baseline entry `unconfirmed` (§11). */
  budgetExhausted: number
  caps: Record<string, number>
  /**
   * How many finding occurrences statically false catalog checks pruned (§7), plus the writes `catch` arms whose `try`
   * can't throw dropped (§5 Resolver capabilities 9), summed over the link groups.
   */
  pruned: number
  limits: Budget
  crashGuard: 'fired' | 'not-fired'
}

export interface Counters {
  artifacts: {
    /** Every artifact of the scan: the denominator. */
    known: number
    analyzed: number
    failed: Record<FailureReason, number>
    /**
     * Artifacts whose code was never analyzed, and that don't make the scan `incomplete`: skipped `offline` (§17
     * Modes), `refused` by the safety floor (§17 Safety floor), `excluded` or `nonJs` (§2).
     */
    skipped: { offline: number; refused: number; excluded: number; nonJs: number }
    sweepOnly: number
    /**
     * The files a mapping serves that no reference found, and that the sweep takes for neither JavaScript nor
     * WebAssembly (§2 Sweep). Informational: they are not artifacts, so not in `known`.
     */
    otherFiles: number
  }
  blindSpots: Record<keyof typeof blindSpotKinds, number>
  html: HtmlCounters
  statistics: Statistics
}

export interface Completeness {
  level: Level
  counters: Counters
  /** Sorted by artifact, location, kind and detail. */
  limitations: LimitationRecord[]
  /** The build files the sweep excluded because no URL mapping serves them (§2 Sweep), by path, sorted. */
  excluded: string[]
  attribution: AttributionBlock
}

/**
 * Applies §13 to every limitation record of a scan, each distinct record once. The level is the worst of the records'
 * fixed levels, and `incomplete` when the crash guard fired. An artifact counts as failed when a failure record names
 * it (all but a `parse-failure` one only when its bytes weren't read), as skipped offline when an `offline-skipped` record
 * does, as refused when a `remote-refused` one does and its bytes weren't read, as failed by the crash guard when the
 * guard stopped its link group, and as analyzed otherwise. The files the sweep excluded, and the WebAssembly files it
 * found, are known too, and counted as skipped, so that `known` is the sum of the others. `sweepOnly` counts the
 * artifacts only the sweep found. Each record that names a known artifact carries that artifact's path and hash.
 */
export function aggregate(input: {
  artifacts: readonly CountedArtifact[]
  limitations: readonly LimitationRecord[]
  html: HtmlCounters
  /** The stats of each link group analyzed, as the resolver seam returned them. */
  statistics: readonly GroupStatistics[]
  /** The step budget per source byte and the caps the link groups ran with (§18). */
  budget: Budget
  /** Whether the wall-clock crash guard fired (§13, §18), and the artifacts whose link groups it kept from running. */
  crashGuard: { fired: boolean; stopped: readonly ArtifactKey[] }
  swept: SweptFiles
  /** The scan's findings, whose attribution confidence the attribution block counts (§13). */
  findings: readonly { confidence: Pick<Confidence, 'attribution'> }[]
  /** Each source-map directory's counts, in the order the directories were declared. */
  sourceMapDirectories?: readonly SourceMapDirectoryCounts[]
  /** Why introducers are unknown (§10): `no-lockfile` when not given. */
  introducers?: Introducers
}): Completeness {
  const { artifacts, html, swept } = input
  // §13's kinds are a closed list. A record of any other kind is a bug in the module that returned it (§19).
  for (const { kind } of input.limitations) {
    if (!Object.hasOwn(kindLevels, kind)) throw new Error(`a limitation record has a kind outside §13: ${kind}`)
  }
  // A record names a URL, and one URL can be several artifacts: a record of bytes that weren't read carries the hash
  // of none of them, rather than that of another artifact of its URL whose bytes were (§11, §17 Integrity).
  const byUrl = new Map<string, { read?: CountedArtifact; unread?: CountedArtifact }>()
  for (const artifact of artifacts) {
    const known = byUrl.get(artifact.url) ?? {}
    byUrl.set(artifact.url, artifact.hash === null ? { ...known, unread: artifact } : { ...known, read: artifact })
  }
  const limitations = unique(input.limitations.map((record) => normalized(record, byUrl))).sort(compareRecords)

  const levels = new Set(limitations.map(({ kind }) => kindLevels[kind]))
  if (input.crashGuard.fired) levels.add('incomplete')
  const level: Level = levels.has('incomplete')
    ? 'incomplete'
    : levels.has('complete-with-limitations')
      ? 'complete-with-limitations'
      : 'complete'

  const failed = Object.fromEntries(failureReasons.map((reason) => [reason, 0])) as Counters['artifacts']['failed']
  const excluded = [...swept.excluded].sort(compareStrings)
  const skipped = { offline: 0, refused: 0, excluded: excluded.length, nonJs: swept.nonJs }
  const kindsByUrl = new Map<string, Set<LimitationKind>>()
  for (const { kind, artifact } of limitations) {
    if (artifact.url !== undefined) kindsByUrl.set(artifact.url, (kindsByUrl.get(artifact.url) ?? new Set()).add(kind))
  }
  const key = ({ url, realm, sourceType }: ArtifactKey) => JSON.stringify([realm, sourceType, url])
  const stopped = new Set(input.crashGuard.stopped.map(key))
  let analyzed = 0
  for (const artifact of artifacts) {
    const kinds = kindsByUrl.get(artifact.url) ?? new Set()
    // A record names a URL, and one URL can be several artifacts whose bytes weren't all withheld: an integrity value
    // belongs to a reference, and a URL fetched in another realm may carry none (§17 Integrity), and one key URL
    // reached through two fetched URLs is an artifact of each (§11). Only an artifact whose bytes weren't read is the
    // one that failed to be read. A parse failure is of bytes that were.
    const failure = failureKinds.find((kind) => kinds.has(kind) && (kind === 'parse-failure' || artifact.hash === null))
    if (failure !== undefined) failed[failure]++
    else if (kinds.has('offline-skipped')) skipped.offline++
    // A record names a URL, not a realm, and one URL can be refused as a worker's script or a module but read as a
    // classic script of the window (§17 Content types): only an artifact whose bytes weren't read is the refused one.
    else if (kinds.has('remote-refused') && artifact.hash === null) skipped.refused++
    else if (stopped.has(key(artifact))) failed['crash-guard']++
    else analyzed++
  }

  const count = (kind: LimitationKind) => limitations.filter((record) => record.kind === kind).length
  const blindSpots = Object.fromEntries(
    Object.entries(blindSpotKinds).map(([counter, kind]) => [counter, count(kind)]),
  ) as Counters['blindSpots']

  const known = artifacts.length + skipped.excluded + skipped.nonJs
  const sweepOnly = artifacts.filter(({ discovery }) => discovery === 'sweep').length
  return {
    level,
    counters: {
      artifacts: { known, analyzed, failed, skipped, sweepOnly, otherFiles: swept.otherFiles },
      blindSpots,
      html: { nomodule: html.nomodule, inlineHandlers: html.inlineHandlers },
      statistics: {
        ...statistics(input.statistics),
        limits: input.budget,
        crashGuard: input.crashGuard.fired ? 'fired' : 'not-fired',
      },
    },
    limitations,
    excluded,
    attribution: {
      ...attributionBlock(artifacts, input.findings),
      sourceMapDirectories: [...(input.sourceMapDirectories ?? [])],
      introducers: input.introducers ?? { reason: 'no-lockfile', evidence: null },
    },
  }
}

/** Sums the link groups' steps and step budgets, counts those that ran out, and sums each cap over the groups. */
function statistics(groups: readonly GroupStatistics[]): Omit<Statistics, 'limits' | 'crashGuard'> {
  const caps = new Map<string, number>()
  let steps = 0
  let stepBudget = 0
  let budgetExhausted = 0
  let pruned = 0
  for (const group of groups) {
    pruned += group.pruned ?? 0
    steps += group.steps
    stepBudget += group.budget
    if (group.exhausted) budgetExhausted++
    for (const [cap, count] of Object.entries(group.caps)) caps.set(cap, (caps.get(cap) ?? 0) + count)
  }
  const sorted = Object.fromEntries([...caps].sort(([a], [b]) => compareStrings(a, b)))
  return { steps, stepBudget, budgetExhausted, caps: sorted, pruned }
}

/**
 * Counts the artifacts with, without and with broken source maps, those with one by pairing method, the candidate maps
 * that failed verification, the maps of remote artifacts that weren't read (§17), and the findings whose attribution
 * confidence is capped (§13).
 */
function attributionBlock(
  artifacts: readonly CountedArtifact[],
  findings: readonly { confidence: Pick<Confidence, 'attribution'> }[],
): Omit<AttributionBlock, 'sourceMapDirectories' | 'introducers'> {
  const pairings = Object.fromEntries(pairingMethods.map((method) => [method, 0])) as AttributionBlock['pairings']
  const counts = { withMap: 0, withoutMap: 0, withBrokenMap: 0 }
  let staleCandidates = 0
  const unreadMaps: UnreadMaps = { refused: 0, failed: 0, unreadable: 0 }
  for (const { sourceMap, staleCandidates: stale, unreadMaps: unread } of artifacts) {
    if (sourceMap.status === 'verified') {
      counts.withMap++
      pairings[sourceMap.method]++
    } else if (sourceMap.status === 'stale') counts.withBrokenMap++
    else counts.withoutMap++
    staleCandidates += stale
    unreadMaps.refused += unread.refused
    unreadMaps.failed += unread.failed
    unreadMaps.unreadable += unread.unreadable
  }
  const capped = (level: 'medium' | 'low') =>
    findings.filter(({ confidence }) => confidence.attribution.level === level).length
  return {
    artifacts: counts,
    pairings,
    staleCandidates,
    unreadMaps,
    cappedFindings: { medium: capped('medium'), low: capped('low') },
  }
}

/** A record with its keys in a fixed order, and the path and hash of the artifact it names when they are known. */
function normalized(
  record: LimitationRecord,
  byUrl: ReadonlyMap<string, { read?: CountedArtifact; unread?: CountedArtifact }>,
): LimitationRecord {
  const both = record.artifact.url === undefined ? undefined : byUrl.get(record.artifact.url)
  const known = unreadKinds.has(record.kind) ? (both?.unread ?? both?.read) : (both?.read ?? both?.unread)
  const url = record.artifact.url
  const path = record.artifact.path ?? known?.path ?? undefined
  const hash = record.artifact.hash ?? known?.hash ?? undefined
  return {
    kind: record.kind,
    artifact: {
      ...(url === undefined ? {} : { url }),
      ...(path === undefined ? {} : { path }),
      ...(hash === undefined ? {} : { hash }),
    },
    ...(record.location === undefined ? {} : { location: location(record.location) }),
    detail: record.detail,
  }
}

function location({ start, end, line, column }: GeneratedLocation): GeneratedLocation {
  return { start, end, line, column }
}

/**
 * The normalized records, each once. Code analyzed more than once, as a script is in each realm that runs it (§2
 * Realm), reports the same limitation at the same place each time, and it is one blind spot.
 */
function unique(records: readonly LimitationRecord[]): LimitationRecord[] {
  const seen = new Set<string>()
  return records.filter((record) => {
    const key = JSON.stringify(record)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Records sort by artifact URL (or path), then location, kind and detail. Normalized records that tie on all of those
 * (they differ only in what is known of their artifact) sort by their JSON, so the order is total and never depends on
 * the order the modules returned them in.
 */
function compareRecords(a: LimitationRecord, b: LimitationRecord): number {
  return (
    compareStrings(a.artifact.url ?? a.artifact.path ?? '', b.artifact.url ?? b.artifact.path ?? '') ||
    (a.location?.start ?? -1) - (b.location?.start ?? -1) ||
    (a.location?.end ?? -1) - (b.location?.end ?? -1) ||
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.detail, b.detail) ||
    compareStrings(JSON.stringify(a), JSON.stringify(b))
  )
}

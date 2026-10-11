// Identity invariance (§20 Identity invariance): for each library, every pair of its bundled builds, the 4 bundlers ×
// maps/nomaps, is compared on the protected targets both find. Zero tolerance. Pure.

import type { Realm } from '../../src/catalog.ts'
import { buildBaseline } from '../../src/packages/baseline/index.ts'
import { compare, type ChangedReason } from '../../src/packages/compare/index.ts'
import { compareStrings, type Finding } from '../../src/packages/findings/index.ts'
import type { CorpusBuild } from './corpus.ts'
import { mostReaching, type ReportedFinding, type ScanReport } from './report.ts'

/** One identity-invariance failure: a pair of a library's builds, a protected target both find, and how they differ. */
export type IdentityFailure = {
  /** The two builds, in sorted order. The simulated diff takes the first as the baseline and scans the second. */
  pair: [string, string]
  realm: Realm
  target: string
} & (
  | {
      /** The `(effect, locks)` each build gives the target differ. */
      check: 'effect-locks'
      first: { effect: string; locks: boolean | 'unknown' }[]
      second: { effect: string; locks: boolean | 'unknown' }[]
    }
  | {
      /** Both builds have the same map status, and the target's fingerprints differ. */
      check: 'fingerprint'
      first: string[]
      second: string[]
    }
  | {
      /** The simulated baseline diff of the pair gives a `changed` finding on the target. */
      check: 'changed'
      changedReasons: ChangedReason[]
    }
)

export interface IdentityInvariance {
  /** The pairs compared. */
  pairs: number
  failures: number
  /** Each library's failures, by pair, then target, then check. Only libraries with failures are listed. */
  libraries: Record<string, IdentityFailure[]>
  /**
   * The differences §21 Attribution names as esbuild composed-map cases and exempts from the bar,
   * listed as `libraries` is and not counted in `failures`.
   */
  exempted: Record<string, IdentityFailure[]>
}

/**
 * The esbuild composed-map cases §21 Attribution names: in the library's esbuild `maps` build, a dependency's
 * composed source climbs into the app's `src/`, so a target is keyed `app` where the other bundlers key `pkg`.
 */
const composedMapCases = [
  { library: 'sentry-7', build: 'esbuild/sentry-7/maps', app: 'app:src/integrations/trycatch.ts', pkg: 'pkg:sentry-browser-7' },
] as const

/** The pairs of `builds` (one library's bundled base builds), each in sorted order. */
export function pairsOf(builds: readonly CorpusBuild[]): [CorpusBuild, CorpusBuild][] {
  const sorted = [...builds].sort((a, b) => compareStrings(a.id, b.id))
  return sorted.flatMap((first, i) => sorted.slice(i + 1).map((second) => [first, second] as [CorpusBuild, CorpusBuild]))
}

/** `maps` or `nomaps`: the last segment of a build's id (`webpack/otel/maps`). */
export function mapStatus(build: CorpusBuild): string {
  return build.id.slice(build.id.lastIndexOf('/') + 1)
}

/**
 * Checks every pair of each library's bundled builds (§20 Identity invariance). For every protected target both builds
 * find:
 * - the `(effect, locks)` each gives it are the same
 * - with the same map status, its fingerprints are the same, except that the attribution key may move `pkg:` ↔
 *   `unknown` (`existing` + `rekeyed` in the simulated diff)
 * - a simulated baseline diff of the pair, through the scanner's own baseline and compare modules, gives it no
 *   `changed` finding. So across maps and nomaps the attribution key may move `pkg:` ↔ `unknown` (`existing` +
 *   `rekeyed`), and a known key that moves to another known key fails (`changed`, `attribution`).
 *
 * A failure that is one of the esbuild composed-map cases §21 Attribution names is listed in `exempted`, not counted.
 */
export function identityInvariance(
  byLibrary: ReadonlyMap<string, readonly CorpusBuild[]>,
  reports: ReadonlyMap<string, ScanReport>,
  isProtected: (finding: ReportedFinding) => boolean,
): IdentityInvariance {
  let pairs = 0
  const libraries: Record<string, IdentityFailure[]> = {}
  const exempted: Record<string, IdentityFailure[]> = {}
  for (const [library, builds] of [...byLibrary].sort(([a], [b]) => compareStrings(a, b))) {
    const failures: IdentityFailure[] = []
    const exempt: IdentityFailure[] = []
    for (const [first, second] of pairsOf(builds)) {
      pairs += 1
      const [a, b] = [reports.get(first.id)!, reports.get(second.id)!]
      for (const failure of comparePair(first, second, a, b, isProtected)) {
        ;(isNamedComposedMapCase(library, failure, a, b, isProtected) ? exempt : failures).push(failure)
      }
    }
    if (failures.length) libraries[library] = failures
    if (exempt.length) exempted[library] = exempt
  }
  const failures = Object.values(libraries).reduce((n, list) => n + list.length, 0)
  return { pairs, failures, libraries, exempted }
}

/**
 * Whether a failure is one of the esbuild composed-map cases §21 names: the pair holds the named esbuild `maps`
 * build, and the target differs only by the named `app:` key there against the package's `pkg:` key (plus any `pkg:` ↔
 * `unknown` move). A `changed` failure must be `attribution` between those two keys only. An `effect-locks` failure is
 * never exempt.
 */
function isNamedComposedMapCase(
  library: string,
  failure: IdentityFailure,
  a: ScanReport,
  b: ScanReport,
  isProtected: (finding: ReportedFinding) => boolean,
): boolean {
  const named = composedMapCases.find((c) => c.library === library && failure.pair.includes(c.build))
  if (named === undefined) return false
  const pairKeys = new Set<string>([named.app, named.pkg])
  if (failure.check === 'effect-locks') return false
  if (failure.check === 'changed') {
    return failure.changedReasons.every(
      (r) => r.reason === 'attribution' && r.before !== r.after && pairKeys.has(r.before) && pairKeys.has(r.after),
    )
  }
  const key = `${failure.realm}|${failure.target}`
  const esbuildFirst = failure.pair[0] === named.build
  const [esbuildReport, otherReport] = esbuildFirst ? [a, b] : [b, a]
  const esbuildSide = byTarget(esbuildReport, isProtected).get(key) ?? []
  const otherSide = byTarget(otherReport, isProtected).get(key) ?? []
  const [esbuildPrints, otherPrints] = [new Set(fingerprints(esbuildSide)), new Set(fingerprints(otherSide))]
  const esbuildOnly = esbuildSide.filter((f) => !otherPrints.has(f.fingerprint)).map((f) => f.attribution.key)
  const otherOnly = otherSide.filter((f) => !esbuildPrints.has(f.fingerprint)).map((f) => f.attribution.key)
  return (
    esbuildOnly.includes(named.app) &&
    esbuildOnly.every((k) => k === named.app || rekeyable(k)) &&
    otherOnly.includes(named.pkg) &&
    otherOnly.every(rekeyable)
  )
}

const checkOrder = ['effect-locks', 'fingerprint', 'changed'] as const

function comparePair(
  first: CorpusBuild,
  second: CorpusBuild,
  a: ScanReport,
  b: ScanReport,
  isProtected: (finding: ReportedFinding) => boolean,
): IdentityFailure[] {
  const pair: [string, string] = [first.id, second.id]
  const [byTargetA, byTargetB] = [byTarget(a, isProtected), byTarget(b, isProtected)]
  const failures: IdentityFailure[] = []
  // The simulated baseline diff: the first build's findings accepted as a baseline, the second's compared with it.
  const diff = simulatedDiff(a, b)
  for (const [key, findingsA] of byTargetA) {
    const findingsB = byTargetB.get(key)
    if (findingsB === undefined) continue
    const { realm, name: target } = findingsA[0]!.target
    const [effectsA, effectsB] = [effectLocks(findingsA), effectLocks(findingsB)]
    if (JSON.stringify(effectsA) !== JSON.stringify(effectsB)) {
      failures.push({ pair, realm, target, check: 'effect-locks', first: effectsA, second: effectsB })
    }
    if (mapStatus(first) === mapStatus(second)) {
      const [printsA, printsB] = [fingerprints(findingsA), fingerprints(findingsB)]
      if (JSON.stringify(printsA) !== JSON.stringify(printsB) && !onlyRekeyed(findingsA, findingsB, diff)) {
        failures.push({ pair, realm, target, check: 'fingerprint', first: printsA, second: printsB })
      }
    }
  }
  for (const compared of diff) {
    if (compared.baselineState !== 'changed') continue
    const key = `${compared.target.realm}|${compared.target.name}`
    if (!byTargetA.has(key) || !byTargetB.has(key)) continue
    const { realm, name: target } = compared.target
    failures.push({ pair, realm, target, check: 'changed', changedReasons: compared.changedReasons })
  }
  return failures.sort(
    (x, y) =>
      compareStrings(`${x.realm}|${x.target}`, `${y.realm}|${y.target}`) ||
      checkOrder.indexOf(x.check) - checkOrder.indexOf(y.check),
  )
}

/** An attribution key that may move to another such key as `existing` + `rekeyed` (§20). */
const rekeyable = (key: string) => key === 'unknown' || key.startsWith('pkg:')

/**
 * Whether a target's fingerprints differ between two builds of the same map status only because its attribution key
 * moved `pkg:` ↔ `unknown` (§20): every finding only the second build has is `existing`
 * in the simulated diff with a `rekeyed` note between `pkg:` and `unknown` keys, and every entry only the first build
 * has is a `pkg:` or `unknown` one that something paired (not `removed`).
 */
function onlyRekeyed(
  findingsA: readonly ReportedFinding[],
  findingsB: readonly ReportedFinding[],
  diff: ReturnType<typeof compare>,
): boolean {
  const [printsA, printsB] = [new Set(fingerprints(findingsA)), new Set(fingerprints(findingsB))]
  const onTarget = diff.filter(
    (c) => c.target.realm === findingsA[0]!.target.realm && c.target.name === findingsA[0]!.target.name,
  )
  const secondOnly = onTarget.filter((c) => printsB.has(c.fingerprint) && !printsA.has(c.fingerprint))
  const secondRekeyed = secondOnly.every(
    (c) =>
      c.baselineState === 'existing' &&
      c.notes.some((n) => n.kind === 'rekeyed' && [...n.before, n.after].every(rekeyable)),
  )
  const firstOnly = findingsA.filter((f) => !printsB.has(f.fingerprint))
  const firstPaired = firstOnly.every(
    (f) =>
      rekeyable(f.attribution.key) &&
      !onTarget.some((c) => c.fingerprint === f.fingerprint && (c.baselineState === 'removed' || c.baselineState === 'unconfirmed')),
  )
  return secondRekeyed && firstPaired
}

/** A diff of `b` against a baseline accepting `a`'s findings, through the production baseline and compare modules. */
function simulatedDiff(a: ScanReport, b: ScanReport) {
  const baseline = buildBaseline({
    scanConfigId: 'identity-invariance',
    surface: 'all',
    tool: { ...a.tool },
    completeness: 'complete',
    findings: a.findings as unknown as Finding[],
    // Versions only give notes, never `changed` (§11).
    packages: {},
  })
  // A complete scan: completeness only decides `removed` against `unconfirmed`, never `changed`.
  const completeness = { level: 'complete', limitations: [], counters: { statistics: { budgetExhausted: 0 } } }
  return compare(b.findings as unknown as Finding[], baseline, completeness as unknown as Parameters<typeof compare>[2])
}

/** A report's protected findings, by `realm|target`. */
function byTarget(report: ScanReport, isProtected: (finding: ReportedFinding) => boolean): Map<string, ReportedFinding[]> {
  const found = new Map<string, ReportedFinding[]>()
  for (const finding of report.findings) {
    if (!isProtected(finding)) continue
    const key = `${finding.target.realm}|${finding.target.name}`
    found.set(key, [...(found.get(key) ?? []), finding])
  }
  return found
}

function effectLocks(findings: readonly ReportedFinding[]): { effect: string; locks: boolean | 'unknown' }[] {
  const pairs = [...new Set(findings.map((f) => JSON.stringify({ effect: f.effect, locks: f.locks })))].sort(compareStrings)
  return pairs.map((text) => JSON.parse(text) as { effect: string; locks: boolean | 'unknown' })
}

function fingerprints(findings: readonly ReportedFinding[]): string[] {
  return [...new Set(findings.map((f) => f.fingerprint))].sort(compareStrings)
}

/** Where a target one bundled build of a library finds is missed by another (§20 Set invariance). */
export interface SetDifference {
  foundBy: string[]
  missedBy: string[]
}

/** A library's set differences (§20 Set invariance): by target, and per bundler, the targets its builds miss. */
export interface LibrarySetInvariance {
  /** Each target some of its bundled builds find and others miss; outside the window realm, as `<realm>:<target>`. */
  targets: Record<string, SetDifference>
  /** Per bundler, the targets that some of its builds miss and another build of the library finds. */
  byBundler: Record<string, string[]>
}

/**
 * Set invariance (§20), with no bar: for each library, every target one of its bundled builds finds and another
 * misses. `found` gives each build's targets on the slice. Libraries whose builds all find the same set are left out.
 */
export function setInvariance(
  byLibrary: ReadonlyMap<string, readonly CorpusBuild[]>,
  found: (build: CorpusBuild) => readonly string[],
): Record<string, LibrarySetInvariance> {
  const result: Record<string, LibrarySetInvariance> = {}
  for (const [library, builds] of [...byLibrary].sort(([a], [b]) => compareStrings(a, b))) {
    const sorted = [...builds].sort((a, b) => compareStrings(a.id, b.id))
    const sets = new Map(sorted.map((build) => [build, new Set(found(build))]))
    const all = [...new Set(sorted.flatMap((build) => [...sets.get(build)!]))].sort(compareStrings)
    const targets: Record<string, SetDifference> = {}
    const byBundler: Record<string, string[]> = {}
    for (const target of all) {
      const missing = sorted.filter((build) => !sets.get(build)!.has(target))
      if (!missing.length) continue
      targets[target] = {
        foundBy: sorted.filter((build) => sets.get(build)!.has(target)).map((build) => build.id),
        missedBy: missing.map((build) => build.id),
      }
      for (const bundler of new Set(missing.map((build) => build.bundler))) (byBundler[bundler] ??= []).push(target)
    }
    if (Object.keys(targets).length) result[library] = { targets, byBundler: sortedRecord(byBundler) }
  }
  return result
}

/** A library's CDN ↔ bundled differences (§20 Identity invariance): its CDN site, and each target it disagrees on. */
export interface CdnDifferences {
  cdn: string
  /** Each target the CDN site finds and a bundled build misses, or misses and a bundled build finds, with every build. */
  targets: Record<string, SetDifference>
}

/**
 * The CDN ↔ bundled differences (§20: "CDN ↔ bundled differences are reported per library with set invariance"), with
 * no bar: for each library with a CDN site, every target the CDN site and some bundled build of the library disagree
 * on, with the builds that find it and those that miss it, the CDN site among them. Libraries whose CDN site agrees
 * with every bundled build are left out.
 */
export function cdnDifferences(
  byLibrary: ReadonlyMap<string, readonly CorpusBuild[]>,
  cdn: readonly CorpusBuild[],
  found: (build: CorpusBuild) => readonly string[],
): Record<string, CdnDifferences> {
  const result: Record<string, CdnDifferences> = {}
  for (const site of [...cdn].sort((a, b) => compareStrings(a.library, b.library) || compareStrings(a.id, b.id))) {
    const bundled = [...(byLibrary.get(site.library) ?? [])].sort((a, b) => compareStrings(a.id, b.id))
    if (bundled.length === 0) continue
    const sorted = [...bundled, site].sort((a, b) => compareStrings(a.id, b.id))
    const sets = new Map(sorted.map((build) => [build, new Set(found(build))]))
    const own = sets.get(site)!
    const all = [...new Set(sorted.flatMap((build) => [...sets.get(build)!]))].sort(compareStrings)
    const targets: Record<string, SetDifference> = {}
    for (const target of all) {
      if (bundled.every((build) => sets.get(build)!.has(target) === own.has(target))) continue
      targets[target] = {
        foundBy: sorted.filter((build) => sets.get(build)!.has(target)).map((build) => build.id),
        missedBy: sorted.filter((build) => !sets.get(build)!.has(target)).map((build) => build.id),
      }
    }
    if (Object.keys(targets).length) result[site.library] = { cdn: site.id, targets }
  }
  return result
}

function sortedRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => compareStrings(a, b)))
}

/** What a target's value was in each build that found it, for a dimension that varies: by build id. */
export type TargetVariance = Partial<Record<'reachability' | 'installContext' | 'reachabilityBasis', Record<string, string>>>

/**
 * Reachability and install-context variance, and basis moves (§20 Set invariance, §7 Limits), with no bar: for each
 * library, each target its bundled builds find with a reachability, install context or basis that differs between
 * them, and each build's value. A target's value in a build is rolled up over its findings as §7 rolls a finding's up
 * over its occurrences: the most-reaching reachability, with `call-path` when any finding giving it is `call-path`, and
 * `load` when any finding is `load`. Outside the window realm, a target is named `<realm>:<target>`.
 */
export function variance(
  byLibrary: ReadonlyMap<string, readonly CorpusBuild[]>,
  reports: ReadonlyMap<string, ScanReport>,
  inSlice: (finding: ReportedFinding) => boolean,
): Record<string, Record<string, TargetVariance>> {
  const result: Record<string, Record<string, TargetVariance>> = {}
  for (const [library, builds] of [...byLibrary].sort(([a], [b]) => compareStrings(a, b))) {
    const values = new Map<string, Map<string, Record<keyof TargetVariance, string | undefined>>>()
    for (const build of [...builds].sort((a, b) => compareStrings(a.id, b.id))) {
      const byName = new Map<string, ReportedFinding[]>()
      for (const finding of reports.get(build.id)!.findings.filter(inSlice)) {
        const { realm, name } = finding.target
        const key = realm === 'window' ? name : `${realm}:${name}`
        byName.set(key, [...(byName.get(key) ?? []), finding])
      }
      for (const [name, findings] of byName) {
        const target = values.get(name) ?? new Map()
        target.set(build.id, rollUp(findings))
        values.set(name, target)
      }
    }
    const targets: Record<string, TargetVariance> = {}
    for (const name of [...values.keys()].sort(compareStrings)) {
      const perBuild = values.get(name)!
      const entry: TargetVariance = {}
      for (const dimension of ['reachability', 'installContext', 'reachabilityBasis'] as const) {
        const known = [...perBuild].flatMap(([id, v]) => (v[dimension] === undefined ? [] : [[id, v[dimension]!] as const]))
        if (new Set(known.map(([, v]) => v)).size > 1) entry[dimension] = Object.fromEntries(known)
      }
      if (Object.keys(entry).length) targets[name] = entry
    }
    if (Object.keys(targets).length) result[library] = targets
  }
  return result
}

function rollUp(findings: readonly ReportedFinding[]): Record<keyof TargetVariance, string | undefined> {
  const reachability = mostReaching(findings.flatMap((f) => (f.reachability ? [f.reachability] : [])))
  const giving = findings.filter((f) => f.reachability === reachability)
  const bases = giving.flatMap((f) => (f.reachabilityBasis ? [f.reachabilityBasis] : []))
  const contexts = findings.flatMap((f) => (f.installContext ? [f.installContext] : []))
  return {
    reachability,
    reachabilityBasis: bases.length ? (bases.includes('call-path') ? 'call-path' : bases[0]) : undefined,
    installContext: contexts.length ? (contexts.includes('load') ? 'load' : contexts[0]) : undefined,
  }
}

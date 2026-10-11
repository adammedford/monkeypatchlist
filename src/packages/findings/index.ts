// Findings (§19, module 6): computes each occurrence's fingerprint and target key (§11), and merges occurrences into
// findings by fingerprint. It knows nothing of the baseline.

import { ecmascriptSpecs, surfaces, type SerializedCatalog, type Surface } from '../../catalog.ts'
import type {
  Effect,
  IneffectiveReason,
  InstallContext,
  Limitation,
  Locks,
  Reachability,
  ReachabilityBasis,
  Target,
} from '../analysis/index.ts'
import {
  strongVersionSources,
  versionSources,
  type AttributedIneffectiveWrite,
  type AttributedOccurrence,
  type Attribution,
  type PackageVersion,
} from '../attribution/index.ts'
import { rollUp, type Confidence } from '../confidence/index.ts'
import type { SurfaceScope } from '../config/index.ts'
import { holderOf, protectedSurface, type IsProtected, type ScopeTarget } from './lib/scope.ts'

export { protectedSurface, type IsProtected, type ScopeTarget }

/** The fingerprint scheme version (§11), recorded in the report's `tool` block and the baseline header. */
export const fingerprintScheme = 1

/** An occurrence of a finding: everything but the finding-level fields. */
export type Occurrence = Omit<AttributedOccurrence, 'target' | 'effect' | 'locks' | 'attribution'>

/** One platform mutation, identified by its fingerprint, with every site that makes it (§8). */
export interface Finding {
  /** `(realm, target, effect, attribution key)` as a readable string: `window|Window.fetch|wrap|pkg:@sentry/core`. */
  fingerprint: string
  /** `(realm, target, effect)`, written as the fingerprint is: `window|Window.fetch|wrap`. */
  targetKey: string
  target: Target
  surface: Surface
  effect: Effect
  /** The most-locking occurrence's (§8): `true` over `unknown` over `false`. */
  locks: Locks
  attribution: Attribution
  /**
   * The union of the occurrences' introducing dependencies (§10 Record), sorted: absent when none of them has any.
   * Evidence only: never in the fingerprint, the baseline or `changed`.
   */
  introducedBy?: string[]
  /** The most-reaching occurrence's (§7, §8): `unconditional` over `conditional` over `unknown` over absence. */
  reachability: Reachability
  /**
   * The basis of the occurrences that give its reachability (§7): `call-path` when any of them is `call-path`, else
   * `creation-site`.
   */
  reachabilityBasis: ReachabilityBasis
  /** `load` if any occurrence is `load`, else `deferred` (§7 Install context, §11). */
  installContext: InstallContext
  /** The highest level per dimension across the occurrences (§9). */
  confidence: Confidence
  occurrences: Occurrence[]
}

/**
 * The `packages` map (§10 Version, §11 Baseline): each containing package of a finding, by name in code-unit order,
 * with its strong version (store path or lockfile) and that version's source. Only the occurrences of findings keyed on
 * the package count. A name with no strong version gets no entry, and nor does one with more than one strong version in
 * the scan. One version from two strong sources takes the stronger.
 */
export function packageVersions(findings: readonly Pick<Finding, 'attribution' | 'occurrences'>[]): Record<string, PackageVersion> {
  const seen = new Map<string, PackageVersion[]>()
  for (const { attribution, occurrences } of findings) {
    const name = attribution.package
    if (name === undefined) continue
    let versions = seen.get(name)
    if (versions === undefined) seen.set(name, (versions = []))
    for (const { evidence } of occurrences) {
      if (evidence.version !== undefined && strongVersionSources.has(evidence.version.versionSource)) {
        versions.push(evidence.version)
      }
    }
  }
  const packages: [string, PackageVersion][] = []
  for (const [name, versions] of seen) {
    if (new Set(versions.map(({ version }) => version)).size !== 1) continue
    const strongest = versions.reduce((a, b) =>
      versionSources.indexOf(b.versionSource) < versionSources.indexOf(a.versionSource) ? b : a,
    )
    packages.push([name, { version: strongest.version, versionSource: strongest.versionSource }])
  }
  return Object.fromEntries(packages.sort(([a], [b]) => compareStrings(a, b)))
}

/**
 * Merges occurrences into findings by fingerprint, and rolls their confidence (§9), `locks` (§8), reachability and install context (§7)
 * up. Findings are sorted by fingerprint, and each finding's occurrences by artifact URL, then position, then artifact
 * hash: one key URL reached through two fetched URLs is an artifact of each (§11).
 */
export function buildFindings(occurrences: readonly AttributedOccurrence[], catalog: SerializedCatalog): Finding[] {
  const merged = new Map<string, Omit<Finding, 'confidence' | 'reachability' | 'reachabilityBasis' | 'installContext'>>()
  const surfaces = surfaceLookup(catalog)
  for (const { target, effect, locks, attribution, ...occurrence } of occurrences) {
    const key = targetKey(target, effect)
    const fingerprint = `${key}|${attribution.key}`
    let finding = merged.get(fingerprint)
    if (finding === undefined) {
      const surface = surfaces.of(target)
      finding = { fingerprint, targetKey: key, target, surface, effect, locks, attribution, occurrences: [] }
      merged.set(fingerprint, finding)
    }
    finding.locks = mostLocking(finding.locks, locks)
    finding.occurrences.push(occurrence)
  }
  const findings = [...merged.values()].map(({ occurrences, ...finding }): Finding => {
    occurrences.sort(byArtifactAndPosition)
    const reachability = occurrences.map((occurrence) => occurrence.reachability).reduce(mostReaching)
    const giving = occurrences.filter((occurrence) => occurrence.reachability === reachability)
    const reachabilityBasis = giving.some((occurrence) => occurrence.reachabilityBasis === 'call-path')
      ? 'call-path'
      : 'creation-site'
    const installContext = occurrences.some((occurrence) => occurrence.installContext === 'load') ? 'load' : 'deferred'
    const confidence = rollUp(occurrences.map((occurrence) => occurrence.confidence))
    const attribution = withWorkspace(withVendoredBy(finding.attribution, occurrences), occurrences)
    const introducers = occurrences.flatMap(({ introducedBy }) => (introducedBy === undefined ? [] : [introducedBy]))
    const introducedBy = introducers.length === 0 ? {} : { introducedBy: [...new Set(introducers.flat())].sort(compareStrings) }
    return { ...finding, attribution, ...introducedBy, reachability, reachabilityBasis, installContext, confidence, occurrences }
  })
  return findings.sort((a, b) => compareStrings(a.fingerprint, b.fingerprint))
}

/**
 * A finding's attribution, with `vendoredBy` when its code is vendored (§10 Provenance, §15): when every occurrence is
 * vendored by one package. A copy that isn't vendored, or two vendoring packages, leave it to the occurrences' evidence.
 * Evidence only: the fingerprint is computed before it, and neither the baseline nor `changed` reads it.
 */
function withVendoredBy(attribution: Attribution, occurrences: readonly Occurrence[]): Attribution {
  const by = new Set(occurrences.map(({ evidence }) => evidence.vendoredBy))
  const [only] = by
  return by.size === 1 && only !== undefined && attribution.provenance === 'bundled-dependency'
    ? { ...attribution, vendoredBy: only }
    : attribution
}

/**
 * A finding's attribution, with `workspace` when its first-party code is in one lockfile workspace (§10 Provenance,
 * §15): when every occurrence names that workspace. Evidence only, as `vendoredBy` is.
 */
function withWorkspace(attribution: Attribution, occurrences: readonly Occurrence[]): Attribution {
  const workspaces = new Set(occurrences.map(({ evidence }) => evidence.workspace))
  const [only] = workspaces
  return workspaces.size === 1 && only !== undefined && attribution.provenance === 'first-party'
    ? { ...attribution, workspace: only }
    : attribution
}

/** An occurrence of an ineffective write: everything but the record-level fields. */
export type IneffectiveOccurrence = Omit<AttributedIneffectiveWrite, 'target' | 'reason'>

/**
 * The ineffective writes to one target for one reason (§3 Record): never a finding, so no fingerprint, baseline state
 * or effect of its own. Each occurrence carries its intended effect, mechanism, strictness and `throws`.
 */
export interface IneffectiveWriteRecord {
  target: Target
  /** The target's surface, as a finding's (§12): records follow `--surface` as findings do. */
  surface: Surface
  reason: IneffectiveReason
  occurrences: IneffectiveOccurrence[]
}

/**
 * Groups the occurrences of ineffective writes per `(realm, target, reason)` (§3 Record). Records are sorted by realm,
 * target and reason, and each record's occurrences by artifact URL, then position, then artifact hash.
 */
export function buildIneffectiveWrites(
  writes: readonly AttributedIneffectiveWrite[],
  catalog: SerializedCatalog,
): IneffectiveWriteRecord[] {
  const grouped = new Map<string, IneffectiveWriteRecord>()
  const surfaces = surfaceLookup(catalog)
  for (const { target, reason, ...occurrence } of writes) {
    const key = `${target.realm}|${target.name}|${reason}`
    let record = grouped.get(key)
    if (record === undefined) {
      record = { target, surface: surfaces.of(target), reason, occurrences: [] }
      grouped.set(key, record)
    }
    record.occurrences.push(occurrence)
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => compareStrings(a, b))
    .map(([, record]) => {
      record.occurrences.sort(byArtifactAndPosition)
      return record
    })
}

/** The `locks` values from the least locking to the most. */
const lockingOrder: readonly Locks[] = [false, 'unknown', true]

/**
 * The more locking of two occurrences' `locks` (§8): `true` over `unknown` over `false`. One site that locks the target
 * locks it when it runs, and one the analyzer can't tell about leaves it unable to say the target stays unlocked.
 */
function mostLocking(a: Locks, b: Locks): Locks {
  return lockingOrder.indexOf(a) >= lockingOrder.indexOf(b) ? a : b
}

/** The reachability values from the least reaching to the most (§7 Combining guards, across alternatives). */
const reachingOrder: readonly Reachability[] = ['guarded-native-absence', 'unknown', 'conditional', 'unconditional']

/** The more reaching of two occurrences' reachability (§7): a finding reports the most-reaching over its occurrences. */
function mostReaching(a: Reachability, b: Reachability): Reachability {
  return reachingOrder.indexOf(a) >= reachingOrder.indexOf(b) ? a : b
}

/** The target key `(realm, target, effect)` (§11), written as the fingerprint is: `window|Window.fetch|wrap`. */
export function targetKey(target: Pick<Target, 'realm' | 'name'>, effect: Effect): string {
  return `${target.realm}|${target.name}|${effect}`
}

/**
 * A target's surface (§12 Surfaces and data): a catalog member's own, and for a shadowing target, which is derived and
 * not catalogued (ADR 0002), the member's it shadows. For a target the catalog doesn't list (an `add`, or a holder's
 * `prototype-change`), it is that of its holder's owner in the owner → surface map. An ECMAScript owner is always
 * `ECMAScript`, and an owner the map doesn't name is `other`.
 */
function surfaceLookup(catalog: SerializedCatalog): { of(target: Target): Surface } {
  // An ECMAScript owner is one whose every member ECMA-262, ECMA-402, an ES addition or an engine extension defines.
  // `Window` is not: it has Web IDL members as well as ECMAScript globals.
  const specs = ecmascriptSpecs(catalog)
  const ecmascriptOwners = new Map<string, ReadonlySet<string>>()
  const ecmascript = (realm: Target['realm']): ReadonlySet<string> => {
    let owners = ecmascriptOwners.get(realm)
    if (owners === undefined) {
      const idl = new Set<string>()
      const es = new Set<string>()
      for (const { owner, spec } of Object.values(catalog.targets[realm])) (specs.has(spec) ? es : idl).add(owner)
      owners = new Set([...es].filter((owner) => !idl.has(owner)))
      ecmascriptOwners.set(realm, owners)
    }
    return owners
  }
  return {
    of({ realm, name, shadows }) {
      const targets = catalog.targets[realm]
      const catalogued = shadows ?? name
      if (Object.hasOwn(targets, catalogued)) return targets[catalogued]!.surface
      if (shadows !== undefined) throw new Error(`an occurrence shadows ${shadows}, which the ${realm} catalog lacks`)
      const holders = catalog.holders[realm]
      const holderName = holderOf(name, holders)
      if (holderName === undefined) {
        throw new Error(`an occurrence names ${name}, which is on no holder of the ${realm} catalog`)
      }
      const { owner } = holders[holderName]!
      if (Object.hasOwn(catalog.surfaceMap.owners, owner)) return catalog.surfaceMap.owners[owner]!
      return ecmascript(realm).has(owner) ? 'ECMAScript' : 'other'
    },
  }
}

/** Orders strings by UTF-16 code unit, independent of locale. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** How many findings a `protected` scan leaves out, per surface (§12). Every surface is listed, in `surfaces` order. */
export type OutOfScopeBySurface = Record<Surface, number>

/**
 * A record that may name the targets it could be about (§5 Partially resolved writes): an `unresolved-holder` record's
 * candidate targets, which analysis returns as data for this stage to filter. Its `detail` ends with their names,
 * joined by `, `.
 */
export type ScopedLimitation<R extends Pick<Limitation, 'detail'>> = R & { candidates?: readonly ScopeTarget[] }

/**
 * Applies `--surface` (§12) to what a scan reports. `all` keeps everything. `protected` keeps:
 * - the findings the protected surface covers, and counts the others per surface
 * - the ineffective-write records it covers, matched as findings are, through `shadows` (§3 Record): a record is kept
 *   when its target is covered with the intended effect of any of its occurrences
 * - each record with candidate targets (`unresolved-holder`) when at least one candidate is covered, with its `detail`
 *   listing only the covered ones
 *
 * A record's `candidates` never cross into the output.
 */
export function applySurface<R extends Pick<Limitation, 'detail'>>(
  input: {
    findings: readonly Finding[]
    ineffectiveWrites: readonly IneffectiveWriteRecord[]
    limitations: readonly ScopedLimitation<R>[]
  },
  scope: SurfaceScope,
  catalog: SerializedCatalog,
): {
  findings: Finding[]
  outOfScopeBySurface: OutOfScopeBySurface
  ineffectiveWrites: IneffectiveWriteRecord[]
  limitations: R[]
} {
  const covers: IsProtected = scope === 'all' ? () => true : protectedSurface(catalog)
  const outOfScopeBySurface = Object.fromEntries(surfaces.map((surface) => [surface, 0])) as OutOfScopeBySurface
  const findings = input.findings.flatMap((finding) => {
    const covered = covers(narrowed(finding.target, finding.occurrences), finding.effect)
    if (!covered) outOfScopeBySurface[finding.surface]++
    return covered ? [withoutMatches(finding)] : []
  })
  const ineffectiveWrites = input.ineffectiveWrites.flatMap((record) =>
    record.occurrences.some(({ effect }) => covers(narrowed(record.target, record.occurrences), effect))
      ? [withoutMatches(record)]
      : [],
  )
  const limitations = input.limitations.flatMap(({ candidates, ...rest }) => {
    const record = rest as unknown as R
    if (candidates === undefined) return [record]
    const kept = candidates.filter((candidate) => covers(candidate, ''))
    if (kept.length === 0) return []
    if (kept.length === candidates.length) return [record]
    const listed = candidates.map(({ name }) => name).join(', ')
    if (!record.detail.endsWith(listed)) throw new Error(`a record's detail doesn't end with its candidates: ${record.detail}`)
    const detail = record.detail.slice(0, record.detail.length - listed.length) + kept.map(({ name }) => name).join(', ')
    return [{ ...record, detail }]
  })
  return { findings, outOfScopeBySurface, ineffectiveWrites, limitations }
}

/**
 * A target as the surface sees it (§12): a wildcard each of whose occurrences a candidate set narrows matches the
 * members they match, and any other the members its name gives.
 */
function narrowed(target: Target, occurrences: readonly { matches?: readonly string[] }[]): ScopeTarget {
  if (!target.name.endsWith('.*') || occurrences.length === 0) return target
  if (occurrences.some(({ matches }) => matches === undefined)) return target
  return { ...target, matches: [...new Set(occurrences.flatMap(({ matches }) => matches ?? []))] }
}

/** A finding or record whose occurrences carry no matched members, which never cross into the output. */
function withoutMatches<T extends { target: Target; occurrences: readonly { matches?: readonly string[] }[] }>(found: T): T {
  if (!found.target.name.endsWith('.*')) return found
  const occurrences = found.occurrences.map((occurrence) => {
    const copy = { ...occurrence }
    delete copy.matches
    return copy
  })
  return { ...found, occurrences }
}

/** Orders occurrences by artifact URL, then position, then artifact hash. */
function byArtifactAndPosition(
  a: { artifact: { url: string; hash: string }; generated: { start: number } },
  b: { artifact: { url: string; hash: string }; generated: { start: number } },
): number {
  return (
    compareStrings(a.artifact.url, b.artifact.url) ||
    a.generated.start - b.generated.start ||
    compareStrings(a.artifact.hash, b.artifact.hash)
  )
}

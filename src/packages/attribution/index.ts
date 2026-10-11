// Attribution (§19, module 5): adds where each occurrence's code came from (§10). It never changes the resolver's fields,
// and knows nothing of how a target was resolved. It never reads chunk names.

import type { RemoteUrlNormalization } from '../../catalog.ts'
import type { GeneratedLocation, IneffectiveWrite, Lookup, RawOccurrence, TraceStep } from '../analysis/index.ts'
import { attributionConfidence, type AttributionReason, type Confidence } from '../confidence/index.ts'
import { sourceKind, type SourceKind, type SourcePath } from './lib/containing-package.ts'
import { firstPartyRoots, type Classified, type MapDirectory } from './lib/first-party.ts'
import {
  importerOf,
  introducerReasons,
  nameAtVersion,
  readLockfile,
  workspaceOf,
  type IntroducerReason,
  type Lockfile,
  type LockfileNode,
  type Workspace,
} from './lib/lockfile.ts'
import { pathRuling, type PathRules } from './lib/path-rules.ts'
import { normalizeRemoteUrl } from './lib/remote-url.ts'
import {
  lineStarts,
  originalAt,
  position,
  readMap,
  tokenAppears,
  type LineReading,
  type ReadMap,
} from './lib/source-map.ts'

export type { PathRules } from './lib/path-rules.ts'
export { introducerReasons, type IntroducerReason }
export { lockfileManifests } from './lib/lockfile.ts'

/**
 * The lockfile a scan was given (§10 Introducing dependencies): its path as given, its text (null when it can't be
 * read), and the `lockfile.importer` setting, or null.
 */
export interface LockfileInput {
  path: string
  text: string | null
  importer: string | null
  /**
   * The `package.json` texts beside the lockfile (§2 Inputs), by folder relative to its directory (`''` for its
   * own), null for one that couldn't be read: its own, and the workspaces' it names. Absent for npm and Bun, which
   * record what they give.
   */
  manifests?: Readonly<Record<string, string | null>>
}

/**
 * Why introducers are unknown, for the attribution block (§10 Unknown is not empty, §13): null with a usable lockfile.
 * `evidence` says what made it so: the format version of a lockfile that isn't usable, the store path the
 * lockfile disagrees with, or why no importer was picked.
 */
export interface Introducers {
  reason: IntroducerReason | null
  evidence: string | null
  /**
   * How certain the introducers are, with a usable lockfile: `high` from `package-lock.json`, `bun.lock` and
   * `pnpm-lock.yaml`, and `medium` from `yarn.lock`, whose derived facts are capped there (§10 Formats).
   */
  confidence?: 'high' | 'medium'
}

/**
 * The catalog data attribution reads (§4 Catalog versions): the framework path rules and escape-only shapes (§10), and
 * the remote URL normalization rules (§11).
 */
export interface AttributionRules extends PathRules {
  remoteUrlNormalization: RemoteUrlNormalization
}

/** Where an artifact is served from (§8 Origin and provenance). */
export type Origin = 'local-build' | 'same-origin' | 'cross-origin' | 'inline'

/** How the code behind a finding got into its artifact (§10 Provenance). */
export const provenances = ['first-party', 'bundled-dependency', 'remote', 'inline', 'unknown'] as const

export type Provenance = (typeof provenances)[number]

/** The artifact fields attribution reads, and that occurrences carry: URL, hash and origin (§8). */
export interface ArtifactIdentity {
  url: string
  hash: string
  origin: Origin
}

/**
 * An artifact as attribution reads it: its identity, its text, and the source map that verified against it (§2), with
 * the method that paired it, the line reading that verified it and the build-relative path whose directory its
 * relative sources resolve against (null when it has none in the build), or null when none did.
 */
export interface MappedArtifact extends ArtifactIdentity {
  /**
   * The name occurrences give the artifact, when it isn't its URL: one key URL reached through two fetched URLs is an
   * artifact of each (§11).
   */
  id?: string
  text: string
  map: { raw: unknown; reading: LineReading; method: string; base: string | null } | null
}

/**
 * The attribution of an occurrence: its attribution key (§11), the provenance that follows from it, and for a `pkg:`
 * key the containing package's name (§10). A finding's also carries `vendoredBy` when its code is vendored (§10
 * Provenance, §15): evidence only, never in the fingerprint, the baseline or `changed`.
 */
export interface Attribution {
  key: string
  provenance: Provenance
  package?: string
  vendoredBy?: string
  workspace?: string
}

/** A position in an original source (§10): the raw `sources` entry, a 1-based line and a 0-based column. */
export interface OriginalLocation {
  source: string
  line: number
  column: number
}

/**
 * An occurrence's attribution evidence (§8, §10), each field present only when it applies:
 * - `source`: the raw `sources` entry of the synthetic or bundler-runtime source the lookup reached (null for a null
 *   entry), which counts as unmapped
 * - `rejected`: the lookup candidate a failed token check discarded
 * - `slug`: the lossy slug that names a scoped package under Yarn's pnpm linker
 * - `pathRule`: the id of the framework path rule that named the package of an escaped source
 * - `package`: the package a remote artifact's map names at the occurrence, which is evidence only: remote code keys
 *   `url:` (§9, §10 Provenance)
 * - `vendoredBy`: the vendoring package, `name@version`, when the containing package's path lies inside another
 *   package's store entry (a store-name mismatch), or inside an installed package when the lockfile says it isn't
 *   installed itself (§10 Provenance), which is evidence only
 * - `version`: the containing package's version, from its strongest source (§10 Version), which is evidence only
 * - `workspace`: the lockfile workspace (`name@version`) that holds first-party code, which only a lockfile gives
 *   (§10 Provenance; ADR 0006), evidence only
 */
export interface AttributionEvidence {
  source?: string | null
  rejected?: OriginalLocation
  slug?: string
  pathRule?: string
  package?: string
  vendoredBy?: string
  version?: PackageVersion
  workspace?: string
}

/**
 * Where a package's version came from (§10 Version), strongest first: a store path, a lockfile keyed by install path,
 * then the weak content signals: the package's `package.json` in `sourcesContent`, an in-package `VERSION`
 * constant, a banner.
 */
export const versionSources = ['store-path', 'lockfile', 'package-json', 'version-constant', 'banner'] as const

export type VersionSource = (typeof versionSources)[number]

/** The strong version sources, the only ones that feed `packages` and the `previousVersion` note (§10, §11). */
export const strongVersionSources: ReadonlySet<VersionSource> = new Set(['store-path', 'lockfile'])

/** A package's version and where it came from (§10 Version). */
export interface PackageVersion {
  version: string
  versionSource: VersionSource
}

/**
 * A `token-check` trace step (§14): the token check's result at the lookup point (§10), the token, and the lookup
 * candidate it checked: the mapped original position, kept when the check passes or doesn't apply, and discarded when
 * it fails.
 */
export interface TokenCheckStep {
  kind: 'token-check'
  result: 'passed' | 'failed' | 'n/a'
  token: string | null
  lookup: GeneratedLocation
  candidate: OriginalLocation
  text: string
}

/**
 * A `path-rule` trace step (§14): the framework path rule that named the package of an escaped source (§10), the
 * package it named, and the raw source it matched.
 */
export interface PathRuleStep {
  kind: 'path-rule'
  rule: string
  package: string
  source: string
  text: string
}

/** A trace step of an attributed occurrence: the resolver's, or one attribution adds (§14, §19 Attribution). */
export type AttributedTraceStep = TraceStep | TokenCheckStep | PathRuleStep

export interface AttributedOccurrence extends Omit<RawOccurrence, 'artifact' | 'confidence' | 'lookup' | 'trace'> {
  artifact: ArtifactIdentity
  attribution: Attribution
  /** The original location a source map resolves, when attribution kept one (§8). */
  original: OriginalLocation | null
  evidence: AttributionEvidence
  /**
   * The introducing dependencies (§10), `name@version`, sorted: present only for bundled-dependency code that a usable
   * lockfile places, and absent when they are unknown.
   */
  introducedBy?: string[]
  /** The resolver's target and mutation confidence, and attribution's own (§9). */
  confidence: Confidence
  /** The resolver's trace, then attribution's `token-check` and `path-rule` steps, if any. */
  trace: AttributedTraceStep[]
}

/**
 * Attributes each occurrence (§10):
 *
 * - Inline code is the entry document's (`inline`), and has high attribution confidence.
 * - Remote code keys `url:` with its URL normalized by the catalog's rules (§11 Remote URL normalization), provenance
 *   `remote`, and is `high` on that key (§9). A verified map still gives its occurrences original locations, looked up
 *   as for local code, and a package the map names is evidence only (`evidence.package`).
 * - Local code without a source map is `unknown`, with `no-map`.
 * - Local code with a verified map is looked up there at the occurrence's lookup point, with the line reading that
 *   verified the map. A position that is unmapped, or maps to a synthetic or bundler-runtime source, is `unknown` with
 *   `no-map`. Otherwise the token check runs, and a position that fails it is discarded: `unknown`, with
 *   `token-check-failed` and the rejected candidate. A kept position's source path names the containing package, which
 *   keys `pkg:<name>` with provenance `bundled-dependency`. A source with an unrecognized scheme is `unknown` with
 *   `foreign-scheme`, and a scoped package under Yarn's pnpm linker `unknown` with `yarn-slug`. A source under no
 *   `node_modules` segment inside its namespace's inferred root is first-party, keyed `app:<root-relative path>`
 *   (`first-party-inferred` when the root lies above the bundler base), unless its map's ignore list demotes it to
 *   `unknown` (`ignore-list-demoted`). One outside the root is escaped: `unknown` with `escaped-source`. Before the
 *   root decides, the catalog's framework path rules are tried, then its escape-only shapes: a source a rule
 *   matches keys the package the rule names (`bundled-dependency`, `framework-path-rule`, with a `path-rule` step),
 *   and one an escape-only shape matches is escaped, wherever the root is.
 */
export function attribute(
  occurrences: readonly RawOccurrence[],
  artifacts: readonly MappedArtifact[],
  rules: AttributionRules,
): AttributedOccurrence[] {
  return attribution(artifacts, rules, null).attribute(occurrences)
}

/**
 * An occurrence of an ineffective write (§3 Record), attributed as a finding's occurrence is: its location, attribution
 * and evidence, and the resolver's trace, then attribution's `token-check` step, if any.
 */
export interface AttributedIneffectiveWrite extends Omit<IneffectiveWrite, 'artifact' | 'lookup' | 'trace'> {
  artifact: ArtifactIdentity
  attribution: Attribution
  original: OriginalLocation | null
  evidence: AttributionEvidence
  trace: AttributedTraceStep[]
}

/** Attributes each occurrence of an ineffective write (§3 Record), as `attribute` attributes a finding's. */
export function attributeIneffective(
  writes: readonly IneffectiveWrite[],
  artifacts: readonly MappedArtifact[],
  rules: AttributionRules,
): AttributedIneffectiveWrite[] {
  return attribution(artifacts, rules, null).attributeIneffective(writes)
}

/** A scan's attribution: one inferred root per namespace, and the lockfile as the scan reads it. */
export interface ScanAttribution {
  /** Attributes each occurrence of a finding, as `attribute` does, with the lockfile's evidence and introducers. */
  attribute(occurrences: readonly RawOccurrence[]): AttributedOccurrence[]
  /** Attributes each occurrence of an ineffective write, as `attributeIneffective` does, with the lockfile's evidence. */
  attributeIneffective(writes: readonly IneffectiveWrite[]): AttributedIneffectiveWrite[]
  /** Why introducers are unknown, for the attribution block (§13). */
  introducers: Introducers
}

/**
 * The attribution of a scan over `artifacts` (§10), with the lockfile it was given, or null. The lockfile only adds
 * evidence, never a key (ADR 0006):
 *
 * - A lockfile that can't be read or parsed, or a format version R1 doesn't read (`package-lock.json` v1), gives
 *   `no-lockfile`, with the format version as evidence, as no lockfile does.
 * - A lockfile with no installed copy of a package at the version a store path in the scan's maps gives it is stale
 *   for the whole scan: `lockfile-stale`, and it derives nothing.
 * - Otherwise a package's install path gives it its lockfile version (§10 Version), and a package path the lockfile
 *   says isn't installed is vendored, in the installed package around it (§10 Provenance). First-party code gets its
 *   workspace as evidence.
 * - The importer is picked as `importerOf` says; with none, `importer-unresolved`, and no introducers.
 */
export function attribution(
  artifacts: readonly MappedArtifact[],
  rules: AttributionRules,
  lockfileInput: LockfileInput | null,
): ScanAttribution {
  const byId = new Map(artifacts.map((artifact) => [artifact.id ?? artifact.url, artifact]))
  const verified = new Map<string, VerifiedMap | null>()
  const verifiedMapOf = (artifact: MappedArtifact): VerifiedMap | null => {
    const id = artifact.id ?? artifact.url
    let map = verified.get(id)
    if (map === undefined) verified.set(id, (map = verifiedMap(artifact)))
    return map
  }
  // One root per bundler namespace, inferred from every local-build map in the scan (§10 Provenance).
  const local = artifacts.flatMap((artifact) => {
    const map = artifact.origin === 'local-build' ? verifiedMapOf(artifact) : null
    return map === null ? [] : [map]
  })
  const roots = firstPartyRoots(local)
  // The curated path data decides before the root does (§10 Escaped sources).
  const classify: Classify = (path, directory) => {
    const ruling = pathRuling(path, rules)
    if (ruling.kind === 'rule') return ruling
    if (ruling.kind === 'escaped') return { kind: 'outside' }
    return roots(path, directory)
  }
  const { lock, introducers } = lockState(lockfileInput, local, classify)
  const each = <T extends { artifact: string; lookup: Lookup; trace: TraceStep[] }>(write: T) => {
    const artifact = byId.get(write.artifact)
    if (artifact === undefined) throw new Error(`an occurrence names an unknown artifact ${write.artifact}`)
    const { url, hash, origin } = artifact
    const { lookup, trace, ...owned } = write
    // A helper write's lookup point may be a call in another artifact of the write's origin (§10): that artifact's
    // map is read there.
    const at = lookup.artifact === undefined ? artifact : byId.get(lookup.artifact)
    if (at === undefined) throw new Error(`an occurrence's lookup names an unknown artifact ${lookup.artifact}`)
    const found = attributionOf(artifact, lookup, verifiedMapOf, classify, rules.remoteUrlNormalization, lock, at)
    const attributed = {
      // `artifact` is replaced by the artifact's identity.
      ...(owned as Omit<T, 'artifact' | 'lookup' | 'trace'>),
      artifact: { url, hash, origin },
      attribution: found.attribution,
      original: found.original,
      evidence: found.evidence,
      // A token check at a lookup point in another artifact names it (§14).
      trace: [
        ...trace,
        ...found.trace.map((step) => (at === artifact || step.kind !== 'token-check' ? step : { ...step, artifact: at.url })),
      ] as AttributedTraceStep[],
    }
    return { attributed, found }
  }
  return {
    attribute: (occurrences) =>
      occurrences.map((occurrence) => {
        const { attributed, found } = each(occurrence)
        const { confidence, ...rest } = attributed
        // Introducers apply only to bundled-dependency code (§10 Record).
        const introducedBy = found.attribution.provenance === 'bundled-dependency' ? found.introducedBy : undefined
        return {
          ...rest,
          ...(introducedBy === undefined ? {} : { introducedBy }),
          confidence: { ...confidence, attribution: attributionConfidence(found.reasons) },
        }
      }),
    attributeIneffective: (writes) => writes.map((write) => each(write).attributed),
    introducers,
  }
}

/** The lockfile as a scan reads it (§10): usable and fresh, with the importer when one is picked, or not at all. */
interface LockState {
  lockfile: Lockfile
  importer: Workspace | null
}

/** The scan's lockfile state, and why introducers are unknown (§10 Unknown is not empty). */
function lockState(
  input: LockfileInput | null,
  maps: readonly VerifiedMap[],
  classify: Classify,
): { lock: LockState | null; introducers: Introducers } {
  const unknown = (reason: IntroducerReason, evidence: string | null) => ({ lock: null, introducers: { reason, evidence } })
  if (input === null) return unknown('no-lockfile', null)
  const read = readLockfile(input.path, input.text, input.manifests ?? {})
  if ('unusable' in read) return unknown('no-lockfile', read.unusable)
  const { lockfile } = read
  // Any disagreement with a store-path version makes the whole lockfile stale.
  const disagreements = new Set<string>()
  const firstParty = new Set<string>()
  for (const map of maps) {
    map.kinds.forEach((kind, i) => {
      if (kind.kind === 'package') {
        // A store path gives a version to its own package, or, for vendored code (a store-name mismatch), to the
        // vendoring package whose store entry holds it.
        const stored = [
          ...(kind.version === null || kind.vendoredBy !== null ? [] : [`${kind.name}@${kind.version}`]),
          ...(kind.vendoredBy === null ? [] : [kind.vendoredBy]),
        ]
        for (const each of stored) {
          const at = each.lastIndexOf('@')
          if (lockfile.named(each.slice(0, at), each.slice(at + 1)).length === 0) {
            disagreements.add(`a store path gives ${each}, which the lockfile doesn't install`)
          }
        }
      }
      if (kind.kind === 'other' && map.map.sources[i]?.ignored !== true) {
        const classified = classify(kind.path, map.directory)
        if (classified.kind === 'first-party') firstParty.add(classified.path)
      }
    })
  }
  if (disagreements.size > 0) return unknown('lockfile-stale', [...disagreements].sort(compareText)[0]!)
  // A missing or unreadable manifest leaves the direct dependencies unknown.
  if (lockfile.unresolved !== null) {
    return { lock: { lockfile, importer: null }, introducers: { reason: 'importer-unresolved', evidence: lockfile.unresolved } }
  }
  const importer = importerOf(lockfile, input.importer, [...firstParty])
  if (importer === null) {
    const why =
      input.importer !== null
        ? `the importer ${input.importer} is no workspace of the lockfile`
        : firstParty.size === 0
          ? 'no first-party source picks one of the lockfile\'s workspaces'
          : `the first-party sources lie in several workspaces: ${[
              ...new Set([...firstParty].map((path) => workspaceOf(lockfile, path)?.folder ?? '')),
            ]
              .map((folder) => (folder === '' ? '.' : folder))
              .sort(compareText)
              .join(', ')}`
    return { lock: { lockfile, importer: null }, introducers: { reason: 'importer-unresolved', evidence: why } }
  }
  return { lock: { lockfile, importer }, introducers: { reason: null, evidence: null, confidence: lockfile.confidence } }
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * An artifact's verified map as attribution reads it, with the artifact's line starts under the verified reading, what
 * each of its sources names, and the map's build-relative directory, which its relative sources resolve against.
 */
interface VerifiedMap {
  map: ReadMap
  starts: readonly number[]
  method: string
  /** Whether the artifact holds a raw U+2028 or U+2029, which can shift mapped positions (§9 `line-separator`). */
  lineSeparator: boolean
  kinds: SourceKind[]
  directory: MapDirectory
  /** Each package directory's weak version, once looked up, by namespace and directory. */
  weakVersions: Map<string, PackageVersion | null>
}

function verifiedMap({ text, map }: MappedArtifact): VerifiedMap | null {
  if (map === null) return null
  const read = readMap(map.raw)
  if (read === null) return null
  const lineSeparator = /[\u2028\u2029]/.test(text)
  const kinds = read.sources.map((source) => sourceKind(source.raw, source.sourceRoot))
  const directory = map.base === null ? null : map.base.split('/').slice(0, -1).filter((segment) => segment !== '')
  const starts = lineStarts(text, map.reading)
  return { map: read, starts, method: map.method, lineSeparator, kinds, directory, weakVersions: new Map() }
}

/**
 * How a source that names no package is attributed, given its map's directory (§10 Provenance): as the inferred root
 * classifies it, or named by a framework path rule.
 */
type Classify = (
  path: SourcePath,
  directory: MapDirectory,
) => Classified | { kind: 'rule'; rule: string; package: string }

interface Found {
  attribution: Attribution
  original: OriginalLocation | null
  evidence: AttributionEvidence
  reasons: AttributionReason[]
  trace: (TokenCheckStep | PathRuleStep)[]
  /** The introducers of bundled-dependency code a usable lockfile places (§10 Walk). */
  introducedBy?: string[]
}

const unknown: Attribution = { key: 'unknown', provenance: 'unknown' }

/** A found attribution with `reasons`, and no original location, evidence or trace step unless `more` gives them. */
function found(
  attribution: Attribution,
  reasons: AttributionReason[],
  more: Partial<Pick<Found, 'original' | 'evidence' | 'trace'>> = {},
): Found {
  return { attribution, original: null, evidence: {}, trace: [], reasons, ...more }
}

/** The attribution of an occurrence in `artifact`, looked up at `lookup` in `at` (§10). */
function attributionOf(
  artifact: MappedArtifact,
  lookup: Lookup,
  verifiedMapOf: (artifact: MappedArtifact) => VerifiedMap | null,
  classify: Classify,
  normalization: RemoteUrlNormalization,
  lock: LockState | null,
  at: MappedArtifact = artifact,
): Found {
  if (artifact.origin === 'inline') return found({ key: 'inline', provenance: 'inline' }, [])
  // The map of the artifact the lookup point is in: the write's own, or another of its origin's.
  const verified = verifiedMapOf(at)
  if (artifact.origin !== 'local-build') {
    // Remote code keys `url:` with its normalized URL, and is `high` on it (§9, §11).
    const remote: Attribution = { key: `url:${normalizeRemoteUrl(artifact.url, normalization)}`, provenance: 'remote' }
    if (verified === null) return found(remote, [])
    // Its verified map still gives original locations, and a package the map names is evidence only (§9). The
    // lockfile describes the scanned application's install, not remote code, so it adds nothing here (§10).
    const mapped = mappedAttribution(verified, lookup, classify, null)
    const named = mapped.attribution.package
    const evidence = named === undefined ? mapped.evidence : { ...mapped.evidence, package: named }
    return found(remote, [], { original: mapped.original, evidence, trace: mapped.trace })
  }
  if (verified === null) return found(unknown, ['no-map'])
  return mappedAttribution(verified, lookup, classify, lock)
}

/** The attribution of an occurrence looked up at `lookup` in an artifact's verified map (§10). */
function mappedAttribution(verified: VerifiedMap, lookup: Lookup, classify: Classify, lock: LockState | null): Found {
  // Raw U+2028/U+2029 can shift the positions a map gives (§5, §9).
  const shifted: AttributionReason[] = verified.lineSeparator ? ['line-separator'] : []
  const { line, column } = position(verified.starts, lookup.generated.start)
  const mapped = originalAt(verified.map, line, column)
  if (mapped === null) return found(unknown, [...shifted, 'no-map'])
  const { source } = mapped
  const kind = verified.kinds[mapped.index] ?? sourceKind(null, null)
  // A synthetic or bundler-runtime source counts as unmapped, and its raw source is kept as evidence (§10).
  if (kind.kind === 'synthetic') return found(unknown, [...shifted, 'no-map'], { evidence: { source: source.raw } })

  // Only a null or empty entry has no raw source, and both are synthetic.
  const candidate: OriginalLocation = { source: source.raw ?? '', line: mapped.line + 1, column: mapped.column }
  const result =
    lookup.token === null || source.content === null
      ? 'n/a'
      : tokenAppears(source.content, mapped.line, lookup.token)
        ? 'passed'
        : 'failed'
  const trace = [tokenCheckStep(result, lookup, candidate)]
  if (result === 'failed') {
    return found(unknown, [...shifted, 'token-check-failed'], { evidence: { rejected: candidate }, trace })
  }
  // Without the token check, the map's position is capped at medium, and a mirrored sidecar is too (§10).
  const unverified: AttributionReason[] =
    result === 'n/a'
      ? ['token-check-n/a', ...(verified.method === 'external-sidecar' ? ['sidecar-not-token-verified' as const] : [])]
      : []
  const kept = { original: candidate, trace }
  const reasons = [...unverified, ...shifted]
  switch (kind.kind) {
    case 'foreign-scheme':
      return found(unknown, [...reasons, 'foreign-scheme'], kept)
    case 'yarn-slug':
      return found(unknown, [...reasons, 'yarn-slug'], { ...kept, evidence: { slug: kind.slug } })
    // A composed path that climbs out of its package inside `node_modules` is escaped, wherever the root is.
    case 'escaped':
      return found(unknown, [...reasons, 'escaped-source'], kept)
    case 'package': {
      const { name, subpath } = kind
      // A package's `dist` file may hide vendored code (§9 `prebundled-dist`).
      const dist = subpath.slice(0, -1).includes('dist')
      const attribution: Attribution = { key: `pkg:${name}`, provenance: 'bundled-dependency', package: name }
      const installed = lock === null ? null : installedAs(lock.lockfile, kind)
      const vendoredBy = kind.vendoredBy ?? installed?.vendoredBy ?? null
      // Only a lockfile keyed by install path is a version source (§10 Version).
      const version = versionOf(verified, kind, lock?.lockfile.keyedByInstallPath === true ? (installed?.node ?? null) : null)
      // Vendored code, a store-name mismatch or a package the lockfile says isn't installed, still names the package
      // its path names (§10 Provenance; ADR 0006).
      const vendored = vendoredBy === null && installed?.vendored !== true ? [] : ['vendored' as const]
      const introducedBy =
        lock?.importer == null || installed === null || installed.from.length === 0
          ? undefined
          : lock.lockfile.introducers(installed.from, lock.importer)
      return {
        ...found(attribution, [...reasons, ...(dist ? ['prebundled-dist' as const] : []), ...vendored], {
          ...kept,
          evidence: { ...(vendoredBy === null ? {} : { vendoredBy }), ...(version === null ? {} : { version }) },
        }),
        ...(introducedBy === undefined ? {} : { introducedBy }),
      }
    }
    case 'other': {
      const classified = classify(kind.path, verified.directory)
      switch (classified.kind) {
        // A source outside the inferred root is escaped (§10 Escaped sources), and so is an absolute path that no
        // root prefixes.
        case 'outside':
          return found(unknown, [...reasons, 'escaped-source'], kept)
        // An escaped source a framework path rule matches is a file of the package the rule names, with no version,
        // and never `high` (§10 Framework path rules).
        case 'rule': {
          const attribution: Attribution = { key: `pkg:${classified.package}`, provenance: 'bundled-dependency', package: classified.package }
          const step: PathRuleStep = {
            kind: 'path-rule',
            rule: classified.rule,
            package: classified.package,
            source: candidate.source,
            text: `the framework path rule ${classified.rule} names ${classified.package} for the escaped source ${candidate.source}`,
          }
          return found(attribution, [...reasons, 'framework-path-rule'], {
            ...kept,
            evidence: { pathRule: classified.rule },
            trace: [...trace, step],
          })
        }
        // A fetched map's relative entry: remote code, keyed by its URL (§11), not by a root.
        case 'unplaced':
          return found(unknown, reasons, kept)
        case 'first-party': {
          // `ignoreList` only demotes: a listed first-party source is `unknown` (§10).
          if (source.ignored) return found(unknown, [...reasons, 'ignore-list-demoted'], kept)
          const attribution: Attribution = { key: `app:${classified.path}`, provenance: 'first-party' }
          // Its workspace is evidence, which only a lockfile gives (§10 Provenance; ADR 0006).
          const workspace = lock === null ? undefined : workspaceOf(lock.lockfile, classified.path)
          const named = workspace?.name == null ? null : workspace.version === null ? workspace.name : `${workspace.name}@${workspace.version}`
          return found(attribution, [...reasons, ...(classified.inferred ? ['first-party-inferred' as const] : [])], {
            ...kept,
            ...(named === null ? {} : { evidence: { workspace: named } }),
          })
        }
      }
    }
  }
}

/**
 * How a fresh lockfile installs a package source (§10): the node its install path matches, the nodes the walk starts
 * from, and whether it is vendored, with the vendoring package when the lockfile names one.
 *
 * - A store path's package is the lockfile's copies of it at the store version.
 * - Vendored code by a store-name mismatch walks from the vendoring package's copies (§10 Walk).
 * - Otherwise the install path is matched, by its longest suffix that is a lockfile key. A path the lockfile doesn't
 *   install is vendored: in the installed package whose directory holds it, which the walk starts from, or in none
 *   the lockfile names.
 */
function installedAs(
  lockfile: Lockfile,
  kind: Extract<SourceKind, { kind: 'package' }>,
): { node: LockfileNode | null; from: LockfileNode[]; vendored: boolean; vendoredBy: string | null } {
  if (kind.vendoredBy !== null) {
    const at = kind.vendoredBy.lastIndexOf('@')
    const from = lockfile.named(kind.vendoredBy.slice(0, at), kind.vendoredBy.slice(at + 1))
    return { node: null, from, vendored: true, vendoredBy: null }
  }
  if (kind.version !== null) return { node: null, from: lockfile.named(kind.name, kind.version), vendored: false, vendoredBy: null }
  const placed = lockfile.place(kind.directory)
  switch (placed.kind) {
    case 'installed':
      return { node: placed.nodes[0] ?? null, from: placed.nodes, vendored: false, vendoredBy: null }
    case 'vendored': {
      const [first] = placed.around
      return { node: null, from: placed.around, vendored: true, vendoredBy: first === undefined ? null : nameAtVersion(first) }
    }
    case 'unplaced':
      return { node: null, from: [], vendored: false, vendoredBy: null }
  }
}

/**
 * A package's version, from its strongest source (§10 Version): the store path it is read from, or else the version a
 * fresh lockfile installs at its install path, or else a weak content
 * signal among its own files in the map, the sources in the same package directory: its `package.json` naming it, then
 * an in-package `VERSION` constant, then a banner naming it. A signal is taken from the first source, in the map's
 * order, that gives one.
 */
function versionOf(
  verified: VerifiedMap,
  kind: Extract<SourceKind, { kind: 'package' }>,
  installed: LockfileNode | null,
): PackageVersion | null {
  if (kind.version !== null) return { version: kind.version, versionSource: 'store-path' }
  if (installed !== null && installed.version !== '') return { version: installed.version, versionSource: 'lockfile' }
  const key = `${kind.path.namespace}\0${kind.directory.join('/')}`
  let weak = verified.weakVersions.get(key)
  if (weak === undefined) verified.weakVersions.set(key, (weak = weakVersion(verified, kind, key)))
  return weak
}

const semver = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?`
const wholeSemver = new RegExp(`^${semver}$`)
/** An in-package `VERSION` constant: `VERSION`, `SDK_VERSION` … assigned or keyed a version string. */
const versionConstant = new RegExp(String.raw`\b(?:[A-Z][A-Z0-9]*_)*VERSION\s*[:=]\s*(['"\x60])(${semver})\1`)
/** A source's leading block comment, where a banner is. */
const leadingComment = /^\s*\/\*[\s\S]*?\*\//

/** The weak version of the package `kind`, from the content of its own files in the map (§10 Version), or null. */
function weakVersion(verified: VerifiedMap, kind: Extract<SourceKind, { kind: 'package' }>, key: string): PackageVersion | null {
  const own = verified.map.sources.flatMap((source, i) => {
    const each = verified.kinds[i]
    if (each?.kind !== 'package' || source.content === null || each.name !== kind.name) return []
    return `${each.path.namespace}\0${each.directory.join('/')}` === key ? [{ subpath: each.subpath, content: source.content }] : []
  })
  for (const { subpath, content } of own) {
    if (subpath.length !== 1 || subpath[0] !== 'package.json') continue
    let manifest: unknown
    try {
      manifest = JSON.parse(content)
    } catch {
      continue
    }
    if (typeof manifest !== 'object' || manifest === null) continue
    const { name, version } = manifest as { name?: unknown; version?: unknown }
    if (name === kind.name && typeof version === 'string' && wholeSemver.test(version)) {
      return { version, versionSource: 'package-json' }
    }
  }
  for (const { content } of own) {
    const found = versionConstant.exec(content)
    if (found !== null) return { version: found[2]!, versionSource: 'version-constant' }
  }
  const named = kind.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const banner = new RegExp(String.raw`(?:^|[\s*!])${named}(?:\s+|@)v?(${semver})(?![0-9A-Za-z.+-])`)
  for (const { content } of own) {
    const comment = leadingComment.exec(content)?.[0]
    const found = comment === undefined ? null : banner.exec(comment)
    if (found !== null && found !== undefined) return { version: found[1]!, versionSource: 'banner' }
  }
  return null
}

/** The `token-check` step for a check at `lookup` of `candidate` (§14). */
function tokenCheckStep(result: TokenCheckStep['result'], lookup: Lookup, candidate: OriginalLocation): TokenCheckStep {
  const { token } = lookup
  const at = `${candidate.source}:${candidate.line}:${candidate.column}`
  const text =
    result === 'passed'
      ? `\`${token}\` appears within one line of ${at}, where the map puts the write`
      : result === 'failed'
        ? `\`${token}\` does not appear within one line of ${at}, where the map puts the write, so that position is ` +
          'discarded'
        : token === null
          ? `the write has no token at its site, so the token check does not apply to ${at}`
          : `the map has no source content for ${candidate.source}, so the token check does not apply`
  return { kind: 'token-check', result, token, lookup: location(lookup.generated), candidate, text }
}

function location({ start, end, line, column }: GeneratedLocation): GeneratedLocation {
  return { start, end, line, column }
}

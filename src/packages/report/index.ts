// Report (§19, module 9): renders what the modules before it produced, as JSON and for the terminal (§15). Nothing
// is recomputed here.

import { realms, surfaces, type ChangeRecord, type Realm, type Surface } from '../../catalog.ts'
import type {
  Effect,
  GeneratedLocation,
  IneffectiveReason,
  InstallContext,
  Locks,
  Mechanism,
  Reachability,
  ReachabilityBasis,
  RealmInstance,
  Strictness,
  Target,
  Throws,
} from '../analysis/index.ts'
import type {
  ArtifactIdentity,
  Attribution,
  AttributedTraceStep,
  AttributionEvidence,
  OriginalLocation,
  PackageVersion,
} from '../attribution/index.ts'
import type { Caps } from '../analysis/index.ts'
import type { Baseline, BaselineNote, VersionPair } from '../baseline/index.ts'
import type { BaselineState, ChangedReason, ExplainingRecord, FindingNote, MatchedBy } from '../compare/index.ts'
import { pairingMethods, type Completeness, type SourceMapPairing } from '../completeness/index.ts'
import type { Confidence, Dimension } from '../confidence/index.ts'
import type { Entry, FailOnState, Mapping, Mode, SurfaceScope } from '../config/index.ts'
import { compareStrings, type IneffectiveWriteRecord, type OutOfScopeBySurface } from '../findings/index.ts'
import type { Gate, PolicedFinding, PolicySlot } from '../policy/index.ts'
import type { Retrieval, RunRetrieval } from '../source-store/index.ts'

/** The report format's version (§15). Removing, renaming or changing the meaning of a field bumps it. */
export const reportVersion = 1

export interface Tool {
  monkeypatchlistVersion: string
  catalogVersion: number
  analyzerVersion: string
  fingerprintScheme: number
}

/** The scanned application (§16 Application name). */
export interface Application {
  name: string
}

export interface ReportConfig {
  scanConfigId: string
  surface: SurfaceScope
  mode: Mode
  entries: Entry[]
  mappings: Mapping[]
  /** The source-map directories, as declared, in the order they were searched (§2 Source maps). */
  sourceMaps: string[]
  /** The lockfile as given, and the `lockfile.importer` setting, or null when none was given (§10, §16). */
  lockfile: { path: string; importer: string | null } | null
  failOn: FailOnState[]
}

/** The baseline a scan was compared with (§15): its path as given, its header, and scan-level notes. */
export interface ReportBaseline {
  path: string
  header: Omit<Baseline, 'entries'>
  /** Scan-level notes: version skew (§4). */
  notes: BaselineNote[]
}

export interface ReportArtifact {
  url: string
  path: string | null
  /** Null when the artifact's bytes were never read. */
  hash: string | null
  origin: ArtifactIdentity['origin']
  discovery: 'reference' | 'injected' | 'sweep'
  sourceType: 'script' | 'module'
  realm: Realm
  realmBasis: 'reference' | 'assumed'
  /** Null for an artifact only the sweep found. */
  parent: string | null
  sourceMap: SourceMapPairing
  retrieval: Retrieval
  /** The artifact's module linking (§6). */
  moduleLinking: { idioms: string[]; modules: number; unlinked: number; linkGroups: number }
}

export interface ReportOccurrence {
  artifact: ArtifactIdentity
  generated: GeneratedLocation
  /** The original location a source map resolves, or null (§8). */
  original: OriginalLocation | null
  mechanism: Mechanism
  /** Whether the mutation happens, judged by the guards on its path (§7). */
  reachability: Reachability
  /** How its reachability was judged (§7). */
  reachabilityBasis: ReachabilityBasis
  /** Whether it runs at load or later, and the install entry a `deferred` one waits on (§7 Install context). */
  installContext: InstallContext
  installEntry: string | null
  realmInstance: RealmInstance
  /** Its attribution evidence (§8, §10). */
  evidence: AttributionEvidence
  /** Its introducing dependencies (§10), only when a usable lockfile gives them. */
  introducedBy?: string[]
  confidence: Confidence
  trace: AttributedTraceStep[]
}

export interface ReportFinding {
  fingerprint: string
  targetKey: string
  target: Target
  surface: Surface
  effect: Effect
  locks: Locks
  attribution: Attribution
  /** The union of its occurrences' introducing dependencies (§10), sorted; absent when none has them. */
  introducedBy?: string[]
  /** The most-reaching occurrence's (§7). Null for a baseline entry the scan didn't find. */
  reachability: Reachability | null
  /** The basis of the occurrences that give its reachability, `call-path` winning (§7). Null as `reachability` is. */
  reachabilityBasis: ReachabilityBasis | null
  /** `load` if any occurrence is `load` (§7). Null for a baseline entry the scan didn't find. */
  installContext: InstallContext | null
  /** Null for a baseline entry the scan didn't find: only occurrences give confidence. */
  confidence: Confidence | null
  baselineState: BaselineState | null
  matchedBy: MatchedBy | null
  changedReasons: ChangedReason[]
  notes: FindingNote[]
  /** Set on a finding of a retained target (§4 Catalog versions). */
  catalogStatus?: 'retained'
  /** The catalog changes that could explain this delta (§4 Catalog versions); absent when none does. */
  explainedBy?: ExplainingRecord[]
  policy: PolicySlot
  occurrences: ReportOccurrence[]
}

/**
 * An occurrence of an ineffective write (§3 Record): where it is and where its code came from, as a finding's
 * occurrence, with the effect it intended, its mechanism, the strictness of its code and whether it throws.
 */
export interface ReportIneffectiveOccurrence {
  artifact: ArtifactIdentity
  generated: GeneratedLocation
  original: OriginalLocation | null
  effect: Effect
  mechanism: Mechanism
  reachability: Reachability
  reachabilityBasis: ReachabilityBasis
  installContext: InstallContext
  installEntry: string | null
  strictness: Strictness
  throws: Throws
  realmInstance: RealmInstance
  attribution: Attribution
  evidence: AttributionEvidence
  trace: AttributedTraceStep[]
}

/** The ineffective writes to one target for one reason (§3 Record). No fingerprint, baseline state or effect. */
export interface ReportIneffectiveWrite {
  target: Target
  surface: Surface
  reason: IneffectiveReason
  occurrences: ReportIneffectiveOccurrence[]
}

/**
 * How many findings are in each baseline state (§15), all 0 without a baseline, how many findings a `protected` scan
 * left out, per surface (§12), and how many ineffective-write records the scan has (§3).
 */
export type Summary = Record<BaselineState, number> & {
  outOfScopeBySurface: OutOfScopeBySurface
  ineffectiveWrites: number
}

/** All wall-clock data, and nothing else that varies between runs (§15). */
export interface Run {
  startedAt: string
  durationMs: number
  /** The wall-clock facts of each fetch, by requested URL (§17 What is recorded). */
  retrievals: Record<string, RunRetrieval>
}

export interface Report {
  reportVersion: typeof reportVersion
  tool: Tool
  application: Application
  config: ReportConfig
  summary: Summary
  gate: Gate
  completeness: Completeness
  baseline: ReportBaseline | null
  /** Name → strong version and its source, for each finding's containing package (§10 Version, §11): the baseline's map. */
  packages: Record<string, PackageVersion>
  findings: ReportFinding[]
  ineffectiveWrites: ReportIneffectiveWrite[]
  artifacts: ReportArtifact[]
  run: Run
}

export interface ReportInput {
  tool: Tool
  application: Application
  config: ReportConfig
  gate: Gate
  /** How many findings a `protected` scan left out, per surface (§12). */
  outOfScopeBySurface: OutOfScopeBySurface
  completeness: Completeness
  baseline: { path: string; baseline: Baseline; notes: readonly BaselineNote[] } | null
  packages: Readonly<Record<string, PackageVersion>>
  findings: readonly PolicedFinding[]
  ineffectiveWrites: readonly IneffectiveWriteRecord[]
  artifacts: readonly ReportArtifact[]
  run: Run
}

/**
 * Builds the JSON report with its keys in a fixed order (§15). Findings are sorted by fingerprint and artifacts by URL.
 */
export function buildReport(input: ReportInput): Report {
  const { tool, application, config, run } = input
  return {
    reportVersion,
    tool: {
      monkeypatchlistVersion: tool.monkeypatchlistVersion,
      catalogVersion: tool.catalogVersion,
      analyzerVersion: tool.analyzerVersion,
      fingerprintScheme: tool.fingerprintScheme,
    },
    application: { name: application.name },
    config: {
      scanConfigId: config.scanConfigId,
      surface: config.surface,
      mode: config.mode,
      entries: config.entries.map(({ file, url }) => ({ file, url })),
      mappings: config.mappings.map(({ url, dir }) => ({ url, dir })),
      sourceMaps: [...config.sourceMaps],
      lockfile: config.lockfile === null ? null : { path: config.lockfile.path, importer: config.lockfile.importer },
      failOn: [...config.failOn],
    },
    summary: summary(input.findings, input.outOfScopeBySurface, input.ineffectiveWrites),
    gate: { failOn: [...input.gate.failOn], result: input.gate.result, exitCode: input.gate.exitCode },
    completeness: completeness(input.completeness),
    baseline: input.baseline === null ? null : baseline(input.baseline),
    packages: packages(input.packages),
    findings: [...input.findings].sort((a, b) => compareStrings(a.fingerprint, b.fingerprint)).map(finding),
    ineffectiveWrites: input.ineffectiveWrites.map(ineffectiveWrite),
    // A URL referenced in two realms is an artifact in each (§2 Realm), listed in the order of `realms`, and one run
    // both as a classic script and as a module is an artifact each way, the classic one first.
    artifacts: [...input.artifacts]
      .sort(
        (a, b) =>
          compareStrings(a.url, b.url) ||
          realms.indexOf(a.realm) - realms.indexOf(b.realm) ||
          Number(a.sourceType === 'module') - Number(b.sourceType === 'module') ||
          // One key URL reached through two fetched URLs is an artifact of each (§11), by the URL it was fetched at.
          compareStrings(a.retrieval.requestedUrl ?? '', b.retrieval.requestedUrl ?? ''),
      )
      .map(artifact),
    run: { startedAt: run.startedAt, durationMs: run.durationMs, retrievals: retrievals(run.retrievals) },
  }
}

/** An ineffective-write record (§3 Record), with its keys, and its occurrences' keys, in a fixed order. */
function ineffectiveWrite(input: IneffectiveWriteRecord): ReportIneffectiveWrite {
  const { realm, holder, name, shadows } = input.target
  return {
    target: { realm, holder, name, ...(shadows === undefined ? {} : { shadows }) },
    surface: input.surface,
    reason: input.reason,
    occurrences: input.occurrences.map((occurrence) => ({
      artifact: { url: occurrence.artifact.url, hash: occurrence.artifact.hash, origin: occurrence.artifact.origin },
      generated: location(occurrence.generated),
      original: occurrence.original === null ? null : original(occurrence.original),
      effect: occurrence.effect,
      mechanism: occurrence.mechanism,
      reachability: occurrence.reachability,
      reachabilityBasis: occurrence.reachabilityBasis,
      installContext: occurrence.installContext,
      installEntry: occurrence.installEntry,
      strictness: occurrence.strictness,
      throws: occurrence.throws,
      realmInstance: occurrence.realmInstance,
      attribution: attribution(occurrence.attribution),
      evidence: evidence(occurrence.evidence),
      trace: occurrence.trace.map(traceStep),
    })),
  }
}

function location({ start, end, line, column }: GeneratedLocation): GeneratedLocation {
  return { start, end, line, column }
}

/** A trace step with `kind` first and `text` last (§14). */
function traceStep({ kind, text, ...fields }: AttributedTraceStep): AttributedTraceStep {
  return { kind, ...fields, text } as AttributedTraceStep
}

function finding(input: PolicedFinding): ReportFinding {
  const { realm, holder, name, shadows } = input.target
  return {
    fingerprint: input.fingerprint,
    targetKey: input.targetKey,
    target: { realm, holder, name, ...(shadows === undefined ? {} : { shadows }) },
    surface: input.surface,
    effect: input.effect,
    locks: input.locks,
    attribution: attribution(input.attribution),
    ...(input.introducedBy === undefined ? {} : { introducedBy: [...input.introducedBy] }),
    reachability: input.reachability,
    reachabilityBasis: input.reachabilityBasis,
    installContext: input.installContext,
    confidence: input.confidence === null ? null : confidence(input.confidence),
    baselineState: input.baselineState,
    matchedBy: input.matchedBy,
    changedReasons: input.changedReasons.map((reason) => ({ ...reason })),
    notes: input.notes.map(findingNote),
    ...(input.catalogStatus === undefined ? {} : { catalogStatus: input.catalogStatus }),
    ...(input.explainedBy === undefined ? {} : { explainedBy: input.explainedBy.map(explainingRecord) }),
    policy: input.policy,
    occurrences: input.occurrences.map((occurrence) => ({
      artifact: { url: occurrence.artifact.url, hash: occurrence.artifact.hash, origin: occurrence.artifact.origin },
      generated: location(occurrence.generated),
      original: occurrence.original === null ? null : original(occurrence.original),
      mechanism: occurrence.mechanism,
      reachability: occurrence.reachability,
      reachabilityBasis: occurrence.reachabilityBasis,
      installContext: occurrence.installContext,
      installEntry: occurrence.installEntry,
      realmInstance: occurrence.realmInstance,
      evidence: evidence(occurrence.evidence),
      ...(occurrence.introducedBy === undefined ? {} : { introducedBy: [...occurrence.introducedBy] }),
      confidence: confidence(occurrence.confidence),
      trace: occurrence.trace.map(traceStep),
    })),
  }
}

/** A change record with `catalogVersion`, `kind` and any `change` first. */
function explainingRecord({ catalogVersion, kind, ...record }: ExplainingRecord): ExplainingRecord {
  return structuredClone({ catalogVersion, kind, ...record }) as ExplainingRecord
}

/** A finding's note, with `kind` first and its fields in a fixed order (§15). */
function findingNote(input: FindingNote): FindingNote {
  switch (input.kind) {
    case 'rekeyed':
      return { kind: input.kind, before: [...input.before], after: input.after }
    case 'shared-target-key':
      return { kind: input.kind, fingerprints: [...input.fingerprints] }
    case 'previous-version':
      return { kind: input.kind, package: input.package, before: input.before, after: input.after }
    case 'reachability-change':
      return { kind: input.kind, before: input.before, after: input.after }
    case 'install-context-change':
      return { kind: input.kind, before: input.before, after: input.after }
  }
}

/**
 * A finding's attribution, with its keys in a fixed order: `package` only for a `pkg:` key, and `vendoredBy` only for
 * vendored code (§15).
 */
function attribution({ key, provenance, package: name, vendoredBy, workspace }: Attribution): Attribution {
  return {
    key,
    provenance,
    ...(name === undefined ? {} : { package: name }),
    ...(vendoredBy === undefined ? {} : { vendoredBy }),
    ...(workspace === undefined ? {} : { workspace }),
  }
}

function original({ source, line, column }: OriginalLocation): OriginalLocation {
  return { source, line, column }
}

/** An occurrence's attribution evidence, with its keys in a fixed order, each only when it applies. */
function evidence({
  source,
  rejected,
  slug,
  pathRule,
  package: named,
  vendoredBy,
  version,
  workspace,
}: AttributionEvidence): AttributionEvidence {
  return {
    ...(source === undefined ? {} : { source }),
    ...(rejected === undefined ? {} : { rejected: original(rejected) }),
    ...(slug === undefined ? {} : { slug }),
    ...(pathRule === undefined ? {} : { pathRule }),
    ...(named === undefined ? {} : { package: named }),
    ...(vendoredBy === undefined ? {} : { vendoredBy }),
    ...(version === undefined ? {} : { version: { version: version.version, versionSource: version.versionSource } }),
    ...(workspace === undefined ? {} : { workspace }),
  }
}

/** A `packages` map (§11), by name in code-unit order, each entry's keys in a fixed order. */
function packages<Version extends { version: string; versionSource: string }>(
  input: Readonly<Record<string, Version>>,
): Record<string, Version> {
  return Object.fromEntries(
    Object.entries(input)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([name, { version, versionSource }]) => [name, { version, versionSource } as Version]),
  )
}

/** The baseline block, with the header's keys in the order the file has them (§11). */
function baseline(input: { path: string; baseline: Baseline; notes: readonly BaselineNote[] }): ReportBaseline {
  const { path, baseline } = input
  const { formatVersion, scanConfigId, fingerprintScheme, catalogVersion, monkeypatchlistVersion } = baseline
  const { completeness, surface } = baseline
  return {
    path,
    header: {
      formatVersion,
      scanConfigId,
      fingerprintScheme,
      catalogVersion,
      monkeypatchlistVersion,
      completeness,
      surface,
      packages: packages(baseline.packages),
    },
    notes: input.notes.map(note),
  }
}

/** A scan-level note, with its keys in a fixed order. */
function note(input: BaselineNote): BaselineNote {
  const pair = <Version>({ baseline, scan }: VersionPair<Version>) => ({ baseline, scan })
  return {
    kind: input.kind,
    newer: input.newer,
    formatVersion: pair(input.formatVersion),
    fingerprintScheme: pair(input.fingerprintScheme),
    catalogVersion: pair(input.catalogVersion),
    monkeypatchlistVersion: pair(input.monkeypatchlistVersion),
  }
}

function summary(
  findings: readonly PolicedFinding[],
  outOfScope: OutOfScopeBySurface,
  ineffective: readonly IneffectiveWriteRecord[],
): Summary {
  const count = (state: BaselineState) => findings.filter((finding) => finding.baselineState === state).length
  return {
    added: count('added'),
    changed: count('changed'),
    existing: count('existing'),
    removed: count('removed'),
    unconfirmed: count('unconfirmed'),
    outOfScopeBySurface: Object.fromEntries(surfaces.map((surface) => [surface, outOfScope[surface]])) as OutOfScopeBySurface,
    ineffectiveWrites: ineffective.length,
  }
}

function confidence({ target, mutation, attribution }: Confidence): Confidence {
  const dimension = <Reason extends string>({ level, reasons }: Dimension<Reason>) => ({ level, reasons: [...reasons] })
  return { target: dimension(target), mutation: dimension(mutation), attribution: dimension(attribution) }
}

/** The completeness block (§13), with its keys in a fixed order. The aggregator has already sorted the records. */
function completeness({ level, counters, limitations, excluded, attribution }: Completeness): Completeness {
  const { artifacts, blindSpots, html, statistics } = counters
  return {
    level,
    counters: {
      artifacts: {
        known: artifacts.known,
        analyzed: artifacts.analyzed,
        failed: {
          'parse-failure': artifacts.failed['parse-failure'],
          unreadable: artifacts.failed.unreadable,
          'fetch-failed': artifacts.failed['fetch-failed'],
          'sri-mismatch': artifacts.failed['sri-mismatch'],
          'crash-guard': artifacts.failed['crash-guard'],
        },
        skipped: {
          offline: artifacts.skipped.offline,
          refused: artifacts.skipped.refused,
          excluded: artifacts.skipped.excluded,
          nonJs: artifacts.skipped.nonJs,
        },
        sweepOnly: artifacts.sweepOnly,
        otherFiles: artifacts.otherFiles,
      },
      blindSpots: {
        dynamicCode: blindSpots.dynamicCode,
        unresolvedReference: blindSpots.unresolvedReference,
        realmUncertain: blindSpots.realmUncertain,
        unresolvedHolder: blindSpots.unresolvedHolder,
      },
      html: { nomodule: html.nomodule, inlineHandlers: html.inlineHandlers },
      statistics: {
        steps: statistics.steps,
        stepBudget: statistics.stepBudget,
        budgetExhausted: statistics.budgetExhausted,
        caps: { ...statistics.caps },
        pruned: statistics.pruned,
        // The caps the scan ran with, keyed in code-unit order, as the hits are.
        limits: {
          stepsPerByte: statistics.limits.stepsPerByte,
          caps: Object.fromEntries(
            Object.entries(statistics.limits.caps).sort(([a], [b]) => compareStrings(a, b)),
          ) as Caps,
        },
        crashGuard: statistics.crashGuard,
      },
    },
    limitations: [...limitations],
    excluded: [...excluded],
    attribution: {
      artifacts: {
        withMap: attribution.artifacts.withMap,
        withoutMap: attribution.artifacts.withoutMap,
        withBrokenMap: attribution.artifacts.withBrokenMap,
      },
      pairings: Object.fromEntries(
        pairingMethods.map((method) => [method, attribution.pairings[method]]),
      ) as Completeness['attribution']['pairings'],
      staleCandidates: attribution.staleCandidates,
      unreadMaps: {
        refused: attribution.unreadMaps.refused,
        failed: attribution.unreadMaps.failed,
        unreadable: attribution.unreadMaps.unreadable,
      },
      sourceMapDirectories: attribution.sourceMapDirectories.map(
        ({ path, found, paired, stale, orphaned, orphanedMaps }) => ({
          path,
          found,
          paired,
          stale,
          orphaned,
          orphanedMaps: [...orphanedMaps],
        }),
      ),
      cappedFindings: { medium: attribution.cappedFindings.medium, low: attribution.cappedFindings.low },
      introducers: {
        reason: attribution.introducers.reason,
        evidence: attribution.introducers.evidence,
        ...(attribution.introducers.confidence === undefined ? {} : { confidence: attribution.introducers.confidence }),
      },
    },
  }
}

function artifact(input: ReportArtifact): ReportArtifact {
  const { url, path, hash, origin, discovery, sourceType, realm, realmBasis, parent } = input
  const sourceMap = { method: input.sourceMap.method, path: input.sourceMap.path, status: input.sourceMap.status }
  const { status, requestedUrl, finalUrl, contentType, sri } = input.retrieval
  // An integrity check's keys in a fixed order (§15 Determinism).
  const check = sri === 'none' ? sri : { result: sri.result, expected: [...sri.expected], actual: sri.actual }
  const retrieval = { status, requestedUrl, finalUrl, contentType, sri: check }
  return {
    url,
    path,
    hash,
    origin,
    discovery,
    sourceType,
    realm,
    realmBasis,
    parent,
    sourceMap: sourceMap as SourceMapPairing,
    retrieval,
    // Its keys in a fixed order, and its idioms in code-unit order (§15 Determinism).
    moduleLinking: {
      idioms: [...input.moduleLinking.idioms].sort(compareStrings),
      modules: input.moduleLinking.modules,
      unlinked: input.moduleLinking.unlinked,
      linkGroups: input.moduleLinking.linkGroups,
    },
  }
}

/** The run block's retrievals, by requested URL in code-unit order, with their keys in a fixed order. */
function retrievals(input: Readonly<Record<string, RunRetrieval>>): Record<string, RunRetrieval> {
  return Object.fromEntries(
    Object.entries(input)
      .sort(([a], [b]) => compareStrings(a, b))
      .map(([url, { fetchedAt, etag, lastModified }]) => [url, { fetchedAt, etag, lastModified }]),
  )
}

/** The JSON report: 2-space indent, LF line endings and a trailing newline. */
export function renderJson(report: Report): string {
  return `${JSON.stringify(report, null, 2)}\n`
}

/** A change record in a line of words (§4 Catalog versions), as `baseline update` prints it. */
export function describeChange(record: ChangeRecord): string {
  switch (record.kind) {
    case 'target':
      return `target ${record.change} ${record.name} (${record.realm})`
    case 'protected-entry': {
      const { interface: name, member } = record.entry
      return `protected entry ${record.change} ${member === undefined ? name : `${name}.${member}`} (${record.surface})`
    }
    case 'member-data':
      return `descriptor or assign kind changed on ${record.name} (${record.realm})`
    case 'holder': {
      const chain = (side: { proto: string | null } | undefined) => String(side?.proto ?? null)
      const step =
        record.change === 'rechained'
          ? `, prototype ${chain(record.before)} → ${chain(record.after)}`
          : `, prototype ${chain(record.after ?? record.before)}`
      return `holder ${record.change === 'rechained' ? 're-chained' : record.change} ${record.holder}${step} (${record.realm})`
    }
    case 'immutable-prototype':
      return `immutablePrototype ${record.before} → ${record.after} on ${record.holder} (${record.realm})`
    case 'framework-path-rule':
      return `framework path rule ${record.id} ${record.change}`
    case 'url-normalization':
      return `URL normalization rule ${record.id} ${record.change}`
  }
}

/** The baseline states `baseline update` accepts and prints, in the order it prints them (§11 Commands). */
const acceptedStates = ['added', 'changed', 'removed'] as const satisfies readonly BaselineState[]

/**
 * What `baseline update` accepts into the baseline at `path` (§11 Commands), from the report of its scan against that
 * baseline: the added, changed and removed findings, grouped by state, each with its count and fingerprints, and under
 * each fingerprint the `explainedBy` records it carries (§11 Commands). Existing findings are accepted unchanged, so
 * they aren't listed.
 */
export function renderAccepted(report: Report, path: string): string {
  const lines = [`Accepted into ${path}`]
  for (const state of acceptedStates) {
    const findings = report.findings.filter((finding) => finding.baselineState === state)
    lines.push(`  ${state[0]!.toUpperCase()}${state.slice(1)} ${findings.length}`)
    for (const finding of findings) {
      lines.push(`    ${finding.fingerprint}`)
      for (const record of finding.explainedBy ?? []) {
        lines.push(`      explained by catalog ${record.catalogVersion}: ${describeChange(record)}`)
      }
    }
  }
  return `${lines.join('\n')}\n`
}

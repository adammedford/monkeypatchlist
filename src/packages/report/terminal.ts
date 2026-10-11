// The terminal report (§15 Terminal): change first, then completeness, what each missing input costs (§2 Input tiers),
// what the surface left out, the ineffective writes and the gate. Every line reads a field the JSON report holds;
// nothing is recomputed. It is pure: whether to use color is the caller's to decide (a TTY, `NO_COLOR`, `--no-color`).

import { surfaces } from '../../catalog.ts'
import { limitationKinds } from '../analysis/index.ts'
import { strongVersionSources, type Provenance } from '../attribution/index.ts'
import type { BaselineNote } from '../baseline/index.ts'
import type { ChangedReason, FindingNote } from '../compare/index.ts'
import type { Confidence } from '../confidence/index.ts'
import { compareStrings } from '../findings/index.ts'
import type { Report, ReportFinding, ReportIneffectiveWrite, ReportOccurrence } from './index.ts'

export interface TerminalOptions {
  /** ANSI color: only on a TTY, never under `NO_COLOR` or `--no-color` (§15 Formatting). */
  color: boolean
  /** `--verbose`: existing findings get a card too, instead of only being counted (§16). */
  verbose: boolean
  /** `--list-ineffective`: each ineffective-write record is listed, instead of only being counted (§16). */
  listIneffective: boolean
}

const defaults: TerminalOptions = { color: false, verbose: false, listIneffective: false }

/** The SGR codes the report uses. */
const styles = { bold: 1, red: 31, green: 32, yellow: 33, dim: 2 } as const
type Style = keyof typeof styles
type Paint = (style: Style, text: string) => string

/** The terminal report for `report` (§15 Terminal). */
export function renderTerminal(report: Report, options: Partial<TerminalOptions> = {}): string {
  const { color, verbose, listIneffective } = { ...defaults, ...options }
  const paint: Paint = color ? (style, text) => `\u001b[${styles[style]}m${text}\u001b[0m` : (_, text) => text
  const lines = [title(report), '']
  lines.push(...changes(report, paint, verbose), '')
  lines.push(...completeness(report, paint))
  lines.push(...inputs(report))
  lines.push(outsideScope(report))
  lines.push(...ineffective(report, listIneffective))
  lines.push('', gateLine(report, paint))
  return `${lines.join('\n')}\n`
}

/** `monkeypatchlist <version> · catalog <n> · <name> · surface <surface> · <mode>`. */
function title({ tool, application, config }: Report): string {
  return [
    `monkeypatchlist ${tool.monkeypatchlistVersion}`,
    `catalog ${tool.catalogVersion}`,
    application.name,
    `surface ${config.surface}`,
    config.mode,
  ].join(' · ')
}

/**
 * The change since the baseline: the counts, a card per `added` and `changed` finding (and per `existing` one under
 * `--verbose`), a line per `removed` and `unconfirmed` entry, and the notes. Without a baseline no finding has a state,
 * so every finding gets a card.
 */
function changes(report: Report, paint: Paint, verbose: boolean): string[] {
  const { summary, findings } = report
  if (report.baseline === null) {
    if (findings.length === 0) return ['No platform mutations found.']
    return [
      `${paint('bold', 'Findings')} ${findings.length}   (no baseline: run with --baseline to see the change)`,
      ...findings.flatMap((finding) => card(report, finding)),
    ]
  }
  const lines = [
    paint('bold', 'Change since baseline'),
    `  Added ${summary.added}   Changed ${summary.changed}   Removed ${summary.removed}   ` +
      `Unconfirmed ${summary.unconfirmed}   Existing ${summary.existing}`,
  ]
  const inState = (state: string) => findings.filter((finding) => finding.baselineState === state)
  const section = (heading: string, style: Style, body: string[]) =>
    body.length === 0 ? [] : ['', paint(style, heading), ...body]
  lines.push(...section('Added', 'yellow', inState('added').flatMap((finding) => card(report, finding))))
  lines.push(...section('Changed', 'yellow', inState('changed').flatMap((finding) => card(report, finding))))
  lines.push(...section('Removed', 'bold', inState('removed').map(entryLine)))
  lines.push(...section('Unconfirmed', 'bold', inState('unconfirmed').map(entryLine)))
  if (verbose) lines.push(...section('Existing', 'bold', inState('existing').flatMap((finding) => card(report, finding))))
  const notes = [
    ...report.baseline.notes.map(skewLine),
    ...findings.flatMap((finding) => finding.notes.map((note) => noteLine(finding, note))),
  ]
  lines.push(...section('Notes', 'bold', notes))
  return lines
}

/** The width of a card's or an entry's target column. */
const targetWidth = 32

/** A finding's target as a card names it: its name, and its realm when that isn't `window`. */
function targetName({ target }: ReportFinding | ReportIneffectiveWrite): string {
  return target.realm === 'window' ? target.name : `${target.name} (${target.realm})`
}

/**
 * A finding's card (§15 Terminal): its target and effect, led for a `changed` one by its `changedReasons` before →
 * after, then Package (with its Previous version), Source (original, then generated), Provenance · install context · reachability, Confidence
 * (with its reasons below `high`) and Fingerprint.
 */
function card(report: Report, finding: ReportFinding): string[] {
  const reasons = finding.changedReasons.map(changedReason).join(' · ')
  const head = `  ${targetName(finding).padEnd(targetWidth)} ${finding.effect}${reasons === '' ? '' : `   ${reasons}`}`
  const [first] = finding.occurrences
  const more = finding.occurrences.length - 1
  const context = [provenanceLabels[finding.attribution.provenance]]
  if (finding.installContext !== null) context.push(finding.installContext)
  if (finding.reachability !== null) context.push(finding.reachability)
  return [
    head,
    field('Package', packageLine(report, finding)),
    ...finding.notes.flatMap((note) =>
      note.kind === 'previous-version' ? [field('Previous version', `${note.package}@${note.before}`)] : [],
    ),
    ...introducedByLine(report, finding),
    ...(first === undefined
      ? []
      : [field('Source', `${sourceOf(report, first)}${more > 0 ? ` (+${more} more ${more === 1 ? 'occurrence' : 'occurrences'})` : ''}`)]),
    field('Provenance', context.join(' · ')),
    ...(finding.confidence === null ? [] : [field('Confidence', confidenceOf(finding.confidence))]),
    field('Fingerprint', finding.fingerprint),
  ]
}

/**
 * The card's `Introduced by` (§10 Terminal wording), for bundled-dependency code the scan found: the introducers, unless
 * every one is the containing package itself, a direct dependency; `unknown (no lockfile)`, or the recorded reason,
 * when they are unknown.
 */
function introducedByLine(report: Report, finding: ReportFinding): string[] {
  if (finding.attribution.provenance !== 'bundled-dependency' || finding.occurrences.length === 0) return []
  const { introducedBy } = finding
  if (introducedBy !== undefined) {
    const own = finding.attribution.package
    const itself = introducedBy.every((each) => each.slice(0, each.lastIndexOf('@')) === own)
    // Yarn's introducers are capped at medium (§10 Formats).
    const capped = report.completeness.attribution.introducers.confidence === 'medium' ? ' (medium)' : ''
    return itself ? [] : [field('Introduced by', `${introducedBy.join(', ')}${capped}`)]
  }
  const { reason } = report.completeness.attribution.introducers
  const why = reason === null ? '' : ` (${reason === 'no-lockfile' ? 'no lockfile' : reason})`
  return [field('Introduced by', `unknown${why}`)]
}

function field(label: string, value: string): string {
  return `    ${label.padEnd(16)} ${value}`
}

/** How the card writes each provenance (§10 Provenance). */
const provenanceLabels: Record<Provenance, string> = {
  'first-party': 'first-party',
  'bundled-dependency': 'bundled dependency',
  remote: 'remote',
  inline: 'inline',
  unknown: 'unknown',
}

/**
 * The card's Package: the containing package's name, `unknown` when the code is bundled but no package is known, or
 * `none` with the provenance for code that has no package (§10).
 */
function packageOf({ attribution }: ReportFinding): string {
  if (attribution.package !== undefined) return attribution.package
  if (attribution.provenance === 'unknown' || attribution.provenance === 'bundled-dependency') return 'unknown'
  return `none (${provenanceLabels[attribution.provenance]})`
}

/**
 * The card's Package with its version (§10 Terminal wording): `name@version` for the strong version in `packages`;
 * every strong version the scan gives the package when it has several, counted over all the findings keyed on it,
 * as `packages` counts them; else the finding's weak version with its source; else the name alone. Vendored code
 * reads `tiny-helper (vendored in telemetry-agent@x)` with no version of its own: a vendored copy never gives one, and
 * a version in `packages` would be another, installed copy's.
 */
function packageLine(report: Report, finding: ReportFinding): string {
  const name = packageOf(finding)
  const { vendoredBy } = finding.attribution
  if (vendoredBy !== undefined) return `${name} (vendored in ${vendoredBy})`
  if (finding.attribution.package === undefined) return name
  const known = report.packages[name]
  if (known !== undefined) return `${name}@${known.version}`
  const strongVersions = [
    ...new Set(
      report.findings
        .filter(({ attribution }) => attribution.package === name)
        .flatMap(({ occurrences }) => occurrences)
        .flatMap(({ evidence }) =>
          evidence.version !== undefined && strongVersionSources.has(evidence.version.versionSource)
            ? [evidence.version.version]
            : [],
        ),
    ),
  ].sort(compareStrings)
  if (strongVersions.length > 1) return `${name} (versions ${strongVersions.join(', ')})`
  const weak = finding.occurrences.find(({ evidence }) => evidence.version !== undefined)?.evidence.version
  if (strongVersions.length === 0 && weak !== undefined) return `${name} (${weak.version} from ${weak.versionSource}, a weak signal)`
  return name
}

/** An attribution key as a change line shows it: a package key by its package name. */
function keyLabel(key: string): string {
  return key.startsWith('pkg:') ? key.slice('pkg:'.length) : key
}

function changedReason(reason: ChangedReason): string {
  if (reason.reason === 'attribution') return `attribution ${keyLabel(reason.before)} → ${keyLabel(reason.after)}`
  if (reason.reason === 'locks') return `locks ${reason.before ? 'yes' : 'no'} → ${reason.after ? 'yes' : 'no'}`
  return `effect ${reason.before} → ${reason.after}`
}

/** A `removed` or `unconfirmed` entry: its target, effect and attribution key. */
function entryLine(finding: ReportFinding): string {
  return `  ${targetName(finding).padEnd(targetWidth)} ${finding.effect}   ${finding.attribution.key}`
}

function noteLine(finding: ReportFinding, note: FindingNote): string {
  const name = targetName(finding).padEnd(targetWidth)
  if (note.kind === 'rekeyed') return `  ${name} rekeyed ${note.before.join(', ')} → ${note.after}`
  if (note.kind === 'previous-version') return `  ${name} ${note.package} ${note.before} → ${note.after}`
  if (note.kind === 'reachability-change') return `  ${name} reachability ${note.before} → ${note.after}`
  if (note.kind === 'install-context-change') return `  ${name} install context ${note.before} → ${note.after}`
  return `  ${name} shared target key: not paired with ${note.fingerprints.join(', ')}`
}

/** A version-skew note (§4) as one line: the versions on each side, and what the skew means for the comparison. */
function skewLine(note: BaselineNote): string {
  const side = (which: 'baseline' | 'scan') =>
    `monkeypatchlist ${note.monkeypatchlistVersion[which]} · catalog ${note.catalogVersion[which]} · format ` +
    `${note.formatVersion[which]} · fingerprint scheme ${note.fingerprintScheme[which]}`
  const meaning =
    note.newer === 'baseline'
      ? 'The baseline is newer, so no delta carries explainedBy'
      : 'A delta without explainedBy may come from analyzer changes'
  return `  Baseline written by ${side('baseline')} (this scan: ${side('scan')}). ${meaning}`
}

/** An occurrence's place: its original location when a map resolves one, then its generated location. */
function sourceOf(report: Report, occurrence: Pick<ReportOccurrence, 'artifact' | 'generated' | 'original'>): string {
  const path = report.artifacts.find((artifact) => artifact.url === occurrence.artifact.url)?.path
  const generated = `${path ?? occurrence.artifact.url}:${occurrence.generated.line}:${occurrence.generated.column}`
  const { original } = occurrence
  return original === null ? generated : `${original.source}:${original.line} (${generated})`
}

/** Each confidence dimension's level, with its reasons when it is below `high` (§9). */
function confidenceOf(confidence: Confidence): string {
  return (['target', 'mutation', 'attribution'] as const)
    .map((dimension) => {
      const { level, reasons } = confidence[dimension]
      return `${dimension} ${level}${reasons.length === 0 ? '' : ` (${reasons.join(', ')})`}`
    })
    .join(' · ')
}

/** Nonzero counts as `name n`, joined. */
function counts(entries: [string, number][]): string {
  return entries
    .filter(([, n]) => n > 0)
    .map(([name, n]) => `${name} ${n}`)
    .join(' · ')
}

/** The completeness block (§13): the level, the artifact counters and the limitation kinds. */
function completeness(report: Report, paint: Paint): string[] {
  const { level, counters, limitations } = report.completeness
  const { artifacts, statistics } = counters
  const style: Style = level === 'complete' ? 'green' : level === 'incomplete' ? 'red' : 'yellow'
  const sum = (record: Record<string, number>) => Object.values(record).reduce((a, b) => a + b, 0)
  const breakdown = (record: Record<string, number>) => {
    const listed = counts(Object.entries(record))
    return listed === '' ? '' : ` (${listed})`
  }
  const lines = [
    `Completeness   ${paint(style, level)}`,
    `  Known ${artifacts.known} · analyzed ${artifacts.analyzed} · failed ${sum(artifacts.failed)}${breakdown(artifacts.failed)}` +
      ` · skipped ${sum(artifacts.skipped)}${breakdown(artifacts.skipped)}` +
      (artifacts.sweepOnly > 0 ? ` · sweep-only ${artifacts.sweepOnly}` : ''),
  ]
  const kinds = counts(limitationKinds.map((kind) => [kind, limitations.filter((record) => record.kind === kind).length]))
  if (kinds !== '') lines.push(`  Limitations  ${kinds}`)
  if (statistics.budgetExhausted > 0) {
    const groups = statistics.budgetExhausted
    lines.push(`  Step budget  exhausted in ${groups} link ${groups === 1 ? 'group' : 'groups'}`)
  }
  if (statistics.crashGuard === 'fired') lines.push('  Crash guard  fired: the scan reports no findings')
  return lines
}

/**
 * The Inputs block (§15 Terminal): what each missing input costs, following the input tiers (§2). Without a source map,
 * bundled code has no containing package and no original locations; without a lockfile, there are no lockfile versions
 * and no introducing dependencies.
 */
function inputs(report: Report): string[] {
  const { withMap, withoutMap, withBrokenMap } = report.completeness.attribution.artifacts
  const total = withMap + withoutMap + withBrokenMap
  let maps = `${withMap} / ${total} artifacts`
  if (withBrokenMap > 0) maps += ` · ${withBrokenMap} with broken maps`
  if (withMap < total) maps += ' · without a map: Package unknown for bundled code, no original locations'
  // A mapped artifact can still leave lines unmapped, so the findings with no package are counted either way: the
  // current findings whose card reads `Package unknown`.
  const unknown = report.findings.filter(
    (finding) => finding.occurrences.length > 0 && packageOf(finding) === 'unknown',
  ).length
  if (unknown > 0) maps += ` · ${unknown} ${unknown === 1 ? 'finding has' : 'findings have'} Package unknown`
  return ['Inputs', `  Source maps  ${maps}`, `  Lockfile     ${lockfile(report)}`]
}

/**
 * The Inputs block's Lockfile (§10, §15): the lockfile as given, and when introducers are unknown, why, what that
 * costs, and the evidence.
 */
function lockfile(report: Report): string {
  const given = report.config.lockfile
  if (given === null) return 'not given · no lockfile versions; Introduced by unknown'
  const { reason, evidence, confidence } = report.completeness.attribution.introducers
  if (reason === null) return confidence === 'medium' ? `${given.path} · Introduced by medium` : given.path
  const why = `${reason}${evidence === null ? '' : `: ${evidence}`}`
  const cost = reason === 'importer-unresolved' ? 'Introduced by unknown' : 'no lockfile versions; Introduced by unknown'
  return `${given.path} · ${why} · ${cost}`
}

/** How many findings a `protected` scan left out, per surface (§12), with the flag that shows them. */
function outsideScope({ summary }: Report): string {
  const listed = counts(surfaces.map((surface) => [surface, summary.outOfScopeBySurface[surface]]))
  return listed === '' ? 'Outside scope  none' : `Outside scope  ${listed}   (run with --surface all)`
}

/** The ineffective writes (§3): a count, or under `--list-ineffective` a line per record and occurrence. */
function ineffective(report: Report, list: boolean): string[] {
  const count = report.summary.ineffectiveWrites
  if (count === 0) return ['Ineffective writes 0']
  if (!list) return [`Ineffective writes ${count}   (--list-ineffective)`]
  return [
    `Ineffective writes ${count}`,
    ...report.ineffectiveWrites.flatMap((record) => [
      `  ${targetName(record).padEnd(targetWidth)} ${record.reason}`,
      ...record.occurrences.map(
        (occurrence) =>
          `    ${occurrence.effect} · ${occurrence.mechanism} · throws ${occurrence.throws} · ` +
          `${sourceOf(report, occurrence)}`,
      ),
    ]),
  ]
}

/** The gate line (§15 Terminal): the states it fails on, its result and the exit code. */
function gateLine(report: Report, paint: Paint): string {
  const { gate } = report
  if (gate.result === 'not-run') return 'Gate  not run (no --fail-on)'
  const failed = report.findings.filter((finding) => finding.policy !== null).length
  const result =
    gate.result === 'fail'
      ? paint('red', `FAIL (${failed} ${failed === 1 ? 'finding' : 'findings'})`)
      : paint('green', 'pass')
  // Exit code 3 is the scan's, not the findings' (§16): the line says why.
  const incomplete = gate.exitCode === 3 ? ' · scan incomplete' : ''
  return `Gate  fail-on ${gate.failOn.join(',')} → ${result}${incomplete}   exit ${gate.exitCode}`
}

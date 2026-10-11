// `monkeypatchlist explain` (§14 Where traces appear, §15 Terminal, §16 Commands): one finding from a saved JSON report,
// rendered with every occurrence and its trace. Nothing is recomputed: every line reads a field the report holds.

import type { Confidence } from '../confidence/index.ts'
import type { Report, ReportFinding, ReportOccurrence } from './index.ts'

/** The findings a fingerprint or target names in a report. */
export type Explained =
  | { kind: 'found'; finding: ReportFinding }
  /** A target that names several findings: each is a candidate, in the report's fingerprint order. */
  | { kind: 'ambiguous'; candidates: ReportFinding[] }
  | { kind: 'unknown' }

/**
 * The finding `query` names in `report`. A fingerprint names its finding. Otherwise `query` is a target, written as
 * its target key (`window|Window.fetch|replace`), as realm and name (`window|Window.fetch`) or as its name alone
 * (`Window.fetch`), and it names every finding with that target.
 */
export function findExplained(report: Report, query: string): Explained {
  const byFingerprint = report.findings.find((finding) => finding.fingerprint === query)
  if (byFingerprint !== undefined) return { kind: 'found', finding: byFingerprint }
  const candidates = report.findings.filter(
    ({ targetKey, target }) => query === targetKey || query === target.name || query === `${target.realm}|${target.name}`,
  )
  if (candidates.length === 0) return { kind: 'unknown' }
  if (candidates.length === 1) return { kind: 'found', finding: candidates[0]! }
  return { kind: 'ambiguous', candidates }
}

/** One line per candidate a target names: its fingerprint, effect and attribution. */
export function renderCandidates(candidates: readonly ReportFinding[]): string {
  const width = Math.max(...candidates.map((finding) => finding.fingerprint.length))
  return candidates
    .map((finding) => `  ${finding.fingerprint.padEnd(width)}   ${finding.effect} · ${finding.attribution.key}`)
    .map((line) => `${line}\n`)
    .join('')
}

/**
 * A finding as `monkeypatchlist explain` renders it: its identity, attribution, baseline state and confidence, then each
 * occurrence with its location, mechanism, attribution evidence, confidence and the `text` of each trace step.
 */
export function renderExplanation(report: Report, finding: ReportFinding): string {
  const { target } = finding
  const lines = [
    `${target.name}   ${finding.effect}`,
    field('Fingerprint', finding.fingerprint),
    field('Target key', finding.targetKey),
    field(
      'Target',
      [`realm ${target.realm}`, `holder ${target.holder}`, ...(target.shadows === undefined ? [] : [`shadows ${target.shadows}`])].join(' · '),
    ),
    field('Surface', finding.surface),
    // `locks` is true, false or 'unknown' (§8): only a finding known not to lock leaves the line out.
    ...(finding.locks === false ? [] : [field('Locks', finding.locks === true ? 'yes' : 'unknown')]),
    field('Attribution', attributionOf(finding)),
    ...(finding.baselineState === null
      ? []
      : [field('Baseline', `${finding.baselineState}${finding.matchedBy === null ? '' : ` (matched by ${finding.matchedBy})`}`)]),
    ...(finding.confidence === null ? [] : [field('Confidence', confidenceOf(finding.confidence))]),
  ]
  const count = finding.occurrences.length
  if (count === 0) {
    lines.push('', 'No occurrences: the scan did not find this baseline entry.')
  }
  finding.occurrences.forEach((occurrence, i) => {
    lines.push('', `Occurrence ${i + 1} of ${count}`, ...occurrenceLines(report, occurrence))
  })
  return `${lines.join('\n')}\n`
}

function occurrenceLines(report: Report, occurrence: ReportOccurrence): string[] {
  const { artifact, generated, original, evidence } = occurrence
  const path = report.artifacts.find((candidate) => candidate.url === artifact.url)?.path ?? null
  const lines = [
    field('Location', `${path ?? artifact.url}:${generated.line}:${generated.column}`),
    ...(path === null ? [] : [field('Artifact', artifact.url)]),
    ...(original === null ? [] : [field('Source', `${original.source}:${original.line}:${original.column}`)]),
    field('Mechanism', `${occurrence.mechanism} · realm instance ${occurrence.realmInstance}`),
  ]
  const evidenceParts = [
    ...(evidence.source === undefined ? [] : [`unmapped source ${evidence.source ?? 'null'}`]),
    ...(evidence.rejected === undefined
      ? []
      : [`rejected ${evidence.rejected.source}:${evidence.rejected.line}:${evidence.rejected.column}`]),
    ...(evidence.slug === undefined ? [] : [`slug ${evidence.slug}`]),
    ...(evidence.vendoredBy === undefined ? [] : [`vendored in ${evidence.vendoredBy}`]),
    ...(evidence.version === undefined
      ? []
      : [`version ${evidence.version.version} (${evidence.version.versionSource})`]),
  ]
  if (evidenceParts.length > 0) lines.push(field('Evidence', evidenceParts.join(' · ')))
  lines.push(field('Confidence', confidenceOf(occurrence.confidence)), '  Trace')
  const width = Math.max(0, ...occurrence.trace.map((step) => step.kind.length))
  lines.push(...occurrence.trace.map((step) => `    ${step.kind.padEnd(width)}  ${step.text}`))
  return lines
}

function field(label: string, value: string): string {
  return `  ${label.padEnd(12)} ${value}`
}

function attributionOf({ attribution }: ReportFinding): string {
  const name = attribution.package === undefined ? [] : [`package ${attribution.package}`]
  const vendored = attribution.vendoredBy === undefined ? [] : [`vendored in ${attribution.vendoredBy}`]
  return [attribution.key, ...name, ...vendored, `provenance ${attribution.provenance}`].join(' · ')
}

/** Each confidence dimension's level, with its reasons when it has any (§9). */
function confidenceOf(confidence: Confidence): string {
  return (['target', 'mutation', 'attribution'] as const)
    .map((dimension) => {
      const { level, reasons } = confidence[dimension]
      return `${dimension} ${level}${reasons.length === 0 ? '' : ` (${reasons.join(', ')})`}`
    })
    .join(' · ')
}

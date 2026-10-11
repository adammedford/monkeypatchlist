// Comparing one fixture page's scan report with its expectation (spec §20 Fixture pages). Pure. Build-time only;
// never published.

import type { Expectation, RestoreRegion } from './pages.ts'

/** The parts of a `monkeypatchlist scan --json` report the comparison reads. */
export interface ScanReport {
  findings: readonly Finding[]
  /** Absent from reports made before the scanner records ineffective writes (§3 Record). */
  ineffectiveWrites?: readonly IneffectiveWrite[]
}

interface Target {
  realm: string
  name: string
}

interface Finding {
  target: Target
  effect: string
  occurrences: readonly Occurrence[]
}

interface Occurrence {
  artifact: { url: string }
  generated: { start: number; end: number; line: number; column: number }
  trace: readonly { kind: string }[]
}

interface IneffectiveWrite {
  target: Target
  reason: string
  occurrences: readonly { throws: string }[]
}

/** How the report differs from the expectation, one line per difference; none when the page passes. */
export function comparePage(
  expected: Expectation,
  restoreRegions: readonly RestoreRegion[],
  report: ScanReport,
): string[] {
  return [
    ...compareSets('finding', expected.findings, findingRows(report)),
    ...compareSets('ineffective write', expected.ineffective, ineffectiveRows(report)),
    ...compareSets('restore', expected.restores, restoreRows(report)),
    ...occurrencesInRestores(restoreRegions, report),
  ]
}

/**
 * The target of each finding with a `restore` step (§14) on an occurrence: the proven restores the report records.
 * §3 puts a proven restore's entry in the trace of the install occurrence in the same chain.
 */
function restoreRows(report: ScanReport): string[] {
  return report.findings
    .filter((f) => f.occurrences.some((o) => o.trace.some((step) => step.kind === 'restore')))
    .map((f) => targetName(f.target))
}

/**
 * A proven restore is never a finding or an occurrence (§3 Restores). Each finding occurrence inside a marked restore
 * write is a difference, named by its target, effect and position.
 */
function occurrencesInRestores(regions: readonly RestoreRegion[], report: ScanReport): string[] {
  const differences: string[] = []
  for (const f of report.findings) {
    for (const o of f.occurrences) {
      const inline = /#inline-(\d+)$/.exec(o.artifact.url)
      if (inline === null) continue
      const n = Number(inline[1])
      const inside = regions.some((r) => r.inline === n && o.generated.start >= r.start && o.generated.end <= r.end)
      if (!inside) continue
      const at = `${o.artifact.url} ${o.generated.line}:${o.generated.column}`
      differences.push(`restore gives an occurrence: ${targetName(f.target)}|${f.effect} at ${at}`)
    }
  }
  return differences.sort()
}

/** `target|effect` for each finding, named as the expectations name it. */
function findingRows(report: ScanReport): string[] {
  return report.findings.map((f) => `${targetName(f.target)}|${f.effect}`)
}

/**
 * `target|reason|throws` for each ineffective-write record and each `throws` among its occurrences, so `throws` is
 * compared on every row.
 */
function ineffectiveRows(report: ScanReport): string[] {
  return (report.ineffectiveWrites ?? []).flatMap((record) =>
    record.occurrences.map((o) => `${targetName(record.target)}|${record.reason}|${o.throws}`),
  )
}

/**
 * A target as the expectations spell it: its name. Fixture pages run only in a window, so a target in another realm
 * keeps its realm, and never matches.
 */
function targetName(target: { realm: string; name: string }): string {
  return target.realm === 'window' ? target.name : `${target.realm}:${target.name}`
}

/** `missing <what>: row` for each expected row the report lacks, `unexpected <what>: row` for each extra, sorted. */
function compareSets(what: string, expected: readonly string[], actual: readonly string[]): string[] {
  const want = new Set(expected)
  const got = new Set(actual)
  const missing = [...want].filter((row) => !got.has(row)).sort()
  const extra = [...got].filter((row) => !want.has(row)).sort()
  return [...missing.map((row) => `missing ${what}: ${row}`), ...extra.map((row) => `unexpected ${what}: ${row}`)]
}

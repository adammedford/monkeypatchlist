// Baseline (§11 Baseline, ADR 0001): the committed, deterministic JSON file of accepted findings that `baseline init`
// writes, `baseline update` rewrites and a scan is compared with. It holds one entry per finding, with the attributes that decide `changed` and
// readable context, and nothing that churns on a rebuild. It knows nothing of files: the CLI reads and writes the text.

import type { Level } from '../completeness/index.ts'
import type { SurfaceScope } from '../config/index.ts'
import { compareStrings } from '../findings/index.ts'
import { entry, formatVersion, type Baseline, type BaselineEntry, type PackageVersion } from './lib/format.ts'

export { formatVersion, type Baseline, type BaselineEntry, type PackageVersion } from './lib/format.ts'
export { migrations, type Migrations } from './lib/migrations.ts'
export type { ReportReading } from './lib/report.ts'
export { readPrevious, type PreviousValue, type PreviousValues, type ReadPrevious } from './lib/previous.ts'
export { BaselineError, readBaseline, writtenVersions, type ReadBaseline } from './lib/read.ts'
export {
  newerVersions,
  versionSkew,
  type BaselineNote,
  type NewerVersion,
  type VersionPair,
  type Versions,
  type VersionSkew,
} from './lib/skew.ts'

/**
 * How a finding compares with the baseline (§11 Baseline states and matching). The compare module gives it, and a
 * baseline accepts every finding except a `removed` one.
 */
export type BaselineState = 'added' | 'existing' | 'changed' | 'removed' | 'unconfirmed'

/**
 * A finding of a scan, as a baseline accepts it: its entry fields, and its baseline state when the scan was compared
 * with a baseline (§11 Baseline states and matching).
 */
export interface ScannedFinding extends BaselineEntry {
  baselineState?: BaselineState | null
}

/**
 * The baseline that accepts the whole current finding set of a scan (§11 Commands: `baseline init` and `baseline
 * update`). That is every finding except a `removed` one, which is a baseline entry the scan no longer finds. A paired
 * finding is accepted under its current fingerprint (ADR 0020).
 */
export function buildBaseline(input: {
  scanConfigId: string
  surface: SurfaceScope
  tool: { fingerprintScheme: number; catalogVersion: number; monkeypatchlistVersion: string }
  completeness: Level
  /** The scan's findings: an entry keeps only their entry fields. */
  findings: readonly ScannedFinding[]
  /** The scan's `packages` map: its findings' containing packages, strong versions only (§10, §11). */
  packages: Readonly<Record<string, PackageVersion>>
}): Baseline {
  const { tool } = input
  return {
    formatVersion,
    scanConfigId: input.scanConfigId,
    fingerprintScheme: tool.fingerprintScheme,
    catalogVersion: tool.catalogVersion,
    monkeypatchlistVersion: tool.monkeypatchlistVersion,
    completeness: input.completeness,
    surface: input.surface,
    packages: Object.fromEntries(
      Object.entries(input.packages)
        .sort(([a], [b]) => compareStrings(a, b))
        .map(([name, { version, versionSource }]) => [name, { version, versionSource }]),
    ),
    entries: input.findings
      .filter((finding) => finding.baselineState !== 'removed')
      .map(entry)
      .sort((a, b) => compareStrings(a.fingerprint, b.fingerprint)),
  }
}

/**
 * The baseline file's text (§11 Determinism): 2-space indent, LF line endings and a trailing newline. With the fixed
 * key order and sorted entries, an unchanged build rewrites it byte for byte.
 */
export function renderBaseline(baseline: Baseline): string {
  return `${JSON.stringify(baseline, null, 2)}\n`
}

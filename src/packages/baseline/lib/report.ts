// A full scan JSON report read as a baseline (§11 Baseline, ADR 0020): as if `baseline update` had just been run on
// that scan. This turns the report's value into the baseline value `update` would have written, which `readBaseline`
// then checks like a file's.

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { BaselineError, problem } from './error.ts'
import { formatVersion } from './format.ts'

/** How `scan --baseline` reads a report (§11 Baseline). */
export interface ReportReading {
  /** The `reportVersion` this monkeypatchlist writes: a newer one is a hard error, as a newer `formatVersion` is (§11). */
  reportVersion: number
  /**
   * `--allow-incomplete`: a report whose completeness is `incomplete` is a readable baseline only with it, and then
   * reads as `baseline update --allow-incomplete` would write it.
   */
  allowIncomplete: boolean
}

/**
 * The parts of a report this reads. The baseline value made from them is checked against the baseline schema, so this
 * checks only what it reads to make one.
 */
const schema = {
  type: 'object',
  required: ['reportVersion', 'tool', 'config', 'completeness', 'baseline', 'packages', 'findings'],
  properties: {
    reportVersion: { type: 'integer' },
    tool: {
      type: 'object',
      required: ['monkeypatchlistVersion', 'catalogVersion', 'fingerprintScheme'],
      properties: { monkeypatchlistVersion: {}, catalogVersion: {}, fingerprintScheme: {} },
    },
    config: { type: 'object', required: ['scanConfigId', 'surface'], properties: { scanConfigId: {}, surface: {} } },
    completeness: {
      type: 'object',
      required: ['level', 'counters'],
      properties: {
        level: {},
        counters: {
          type: 'object',
          required: ['statistics'],
          properties: { statistics: { type: 'object', required: ['crashGuard'], properties: { crashGuard: {} } } },
        },
      },
    },
    baseline: {
      oneOf: [{ type: 'null' }, { type: 'object', required: ['header'], properties: { header: { type: 'object' } } }],
    },
    packages: { type: 'object' },
    findings: { type: 'array', items: { type: 'object' } },
  },
}

let validate: ValidateFunction | undefined

/** What this reads of a report, once the schema has checked it. */
interface ReportValue {
  reportVersion: number
  tool: { monkeypatchlistVersion: unknown; catalogVersion: unknown; fingerprintScheme: unknown }
  config: { scanConfigId: unknown; surface: unknown }
  completeness: { level: unknown; counters: { statistics: { crashGuard: unknown } } }
  baseline: { header: Record<string, unknown> } | null
  packages: unknown
  findings: Record<string, unknown>[]
}

/** Whether a parsed JSON value is a scan report rather than a baseline file: only a report has a `reportVersion`. */
export function isReport(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'reportVersion' in value
}

/**
 * The baseline value `baseline update` would have written from the scan `value` reports (§11 Baseline, ADR 0020), or
 * a `BaselineError` that says why the report is no readable baseline:
 *
 * - Every finding except a `removed` one is an entry, `added` and `changed` included, under its current fingerprint,
 *   and `unconfirmed` entries carry forward. The header is the scan's: its scan-config id, surface, completeness level,
 *   versions and `packages` map.
 * - An `incomplete` report is refused without `--allow-incomplete`.
 * - A report whose crash guard fired holds no findings, so `update --allow-incomplete` would have left its baseline as
 *   it was (§13): it gives back that baseline, its header and its `unconfirmed` entries. One with no baseline of its own
 *   is refused even with the flag, as `baseline init` refuses its scan.
 */
export function baselineOfReport(value: unknown, reading: ReportReading): unknown {
  validate ??= new Ajv2020({ allErrors: true, strict: true }).compile(schema)
  if (!validate(value)) {
    const problems = (validate.errors ?? []).map(problem)
    throw new BaselineError(`it is not a scan report:\n${problems.map((line) => `  ${line}`).join('\n')}`)
  }
  const report = value as ReportValue
  if (report.reportVersion > reading.reportVersion) {
    throw new BaselineError(
      `it is a scan report in reportVersion ${report.reportVersion}, newer than this monkeypatchlist reads (${reading.reportVersion})`,
      { newerFormat: true },
    )
  }
  if (report.reportVersion < reading.reportVersion) {
    throw new BaselineError(
      `it is a scan report in reportVersion ${report.reportVersion}, older than this monkeypatchlist reads (${reading.reportVersion})`,
    )
  }
  const { level } = report.completeness
  const fired = report.completeness.counters.statistics.crashGuard === 'fired'
  if (fired && report.baseline === null) {
    throw new BaselineError(
      "it is the report of a scan whose crash guard fired, with no baseline of its own: it holds no findings, so it isn't " +
        'read as a baseline even under --allow-incomplete, as baseline init refuses such a scan',
    )
  }
  if (level === 'incomplete' && !reading.allowIncomplete) {
    throw new BaselineError(
      "it is the report of an incomplete scan (its completeness says what was not analyzed): pass --allow-incomplete to " +
        'read it as baseline update --allow-incomplete would write it',
    )
  }
  const entries = report.findings
    .filter((finding) => finding.baselineState !== 'removed')
    .map(({ fingerprint, target, surface, effect, locks, attribution }) => ({
      fingerprint,
      target,
      surface,
      effect,
      locks,
      attribution,
    }))
  if (fired) return { ...report.baseline!.header, formatVersion, entries }
  return {
    formatVersion,
    scanConfigId: report.config.scanConfigId,
    fingerprintScheme: report.tool.fingerprintScheme,
    catalogVersion: report.tool.catalogVersion,
    monkeypatchlistVersion: report.tool.monkeypatchlistVersion,
    completeness: level,
    surface: report.config.surface,
    packages: report.packages,
    entries,
  }
}

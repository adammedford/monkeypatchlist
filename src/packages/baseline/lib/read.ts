// Reading a baseline file's text (§11 Baseline, Format versions). The CLI reads the bytes; this checks them.

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { holders, realms, surfaces } from '../../../catalog.ts'
import { effects } from '../../analysis/index.ts'
import { provenances } from '../../attribution/index.ts'
import { levels } from '../../completeness/index.ts'
import type { SurfaceScope } from '../../config/index.ts'
import { fingerprintScheme } from '../../findings/index.ts'
import { BaselineError, problem } from './error.ts'
import { entry, formatVersion, type Baseline, type BaselineEntry } from './format.ts'
import { migrations as shipped, type Migrations } from './migrations.ts'
import { previousOfReport, type PreviousValues } from './previous.ts'
import { baselineOfReport, isReport, type ReportReading } from './report.ts'
import { semver, type Versions } from './skew.ts'

export { BaselineError } from './error.ts'

const scopes: SurfaceScope[] = ['protected', 'all']

/** The shape of a `formatVersion` 1 baseline. Keys it doesn't name are ignored. */
const schema = {
  type: 'object',
  required: [
    'formatVersion',
    'scanConfigId',
    'fingerprintScheme',
    'catalogVersion',
    'monkeypatchlistVersion',
    'completeness',
    'surface',
    'packages',
    'entries',
  ],
  properties: {
    formatVersion: { const: formatVersion },
    scanConfigId: { type: 'string' },
    fingerprintScheme: { type: 'integer' },
    catalogVersion: { type: 'integer', minimum: 1 },
    monkeypatchlistVersion: { type: 'string', format: 'semver' },
    completeness: { enum: levels },
    surface: { enum: scopes },
    packages: {
      type: 'object',
      additionalProperties: {
        type: 'object',
        required: ['version', 'versionSource'],
        properties: { version: { type: 'string' }, versionSource: { type: 'string' } },
      },
    },
    entries: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fingerprint', 'target', 'surface', 'effect', 'locks', 'attribution'],
        properties: {
          fingerprint: { type: 'string', minLength: 1 },
          target: {
            type: 'object',
            required: ['realm', 'holder', 'name'],
            properties: {
              realm: { enum: realms },
              holder: { enum: holders },
              name: { type: 'string', minLength: 1 },
              shadows: { type: 'string', minLength: 1 },
            },
          },
          surface: { enum: surfaces },
          effect: { enum: effects },
          locks: { enum: [true, false, 'unknown'] },
          attribution: {
            type: 'object',
            required: ['key', 'provenance'],
            properties: {
              key: { type: 'string', minLength: 1 },
              provenance: { enum: provenances },
              package: { type: 'string', minLength: 1 },
            },
          },
        },
      },
    },
  },
}

let validate: ValidateFunction | undefined

/** A baseline as this monkeypatchlist reads it, and the versions its file was written with (§4 Version skew). */
export interface ReadBaseline {
  baseline: Baseline
  written: Versions
  /**
   * The previous scan's values when the text is a full report (§11 Never `changed`, §16 `--previous`): a report used as
   * the baseline also supplies them. Null for a baseline file, which stores none (ADR 0014).
   */
  previous: PreviousValues | null
}

/**
 * The baseline in `text`, or a `BaselineError` that says why it isn't one. The baseline comes back with its keys in the
 * fixed order `baseline init` writes, without keys this monkeypatchlist doesn't read.
 *
 * - A `formatVersion` newer than this monkeypatchlist's is an error, and an older one is migrated in memory (§11 Format
 *   versions), by `migrations`. An older one that no migration reads is not a readable baseline.
 * - A fingerprint scheme older than this monkeypatchlist's is migrated in memory, by `migrations`. A scheme that can't be
 *   migrated (a newer one, or an older one that no migration reads) is not a readable baseline: a hard error under
 *   `--fail-on`, and a scan without a baseline otherwise (§4 Version skew, §11 No baseline).
 * - A fingerprint that two entries share is an error.
 * - With `options.report`, the text may be a full scan report instead, read as the baseline `baseline update` would
 *   have written from its scan (§11 Baseline, ADR 0020). Without it, a report is not a readable baseline.
 */
export function readBaseline(
  text: string,
  migrations: Migrations = shipped,
  options: { report?: ReportReading } = {},
): ReadBaseline {
  let value: unknown
  try {
    value = parseJson(text)
  } catch (error) {
    throw new BaselineError(`it is not valid JSON: ${(error as Error).message}`)
  }
  // `scan --baseline` also reads a full scan report, as the baseline `baseline update` would write from its scan (§11
  // Baseline, ADR 0020). Nothing else reads one as a baseline.
  let previous: PreviousValues | null = null
  if (isReport(value)) {
    if (options.report === undefined) throw new BaselineError('it is a scan report, not a baseline file')
    const report = value
    value = baselineOfReport(report, options.report)
    previous = previousOfReport(report, options.report.reportVersion).values
  }
  const version = (value as { formatVersion?: unknown } | null)?.formatVersion
  if (typeof version === 'number' && version > formatVersion) {
    throw new BaselineError(`its formatVersion ${version} is newer than this monkeypatchlist reads (${formatVersion})`, {
      newerFormat: true,
    })
  }
  if (typeof version === 'number' && Number.isInteger(version)) {
    for (let from = version; from < formatVersion; from++) {
      const migrate = migrations.format.get(from)
      if (migrate === undefined) {
        throw new BaselineError(
          `its formatVersion ${version} is older than this monkeypatchlist can migrate to the one it reads (${formatVersion})`,
        )
      }
      // A format migration reads the file before any schema check, so one that throws on it read a file that isn't a
      // baseline in that format.
      try {
        value = migrate(value)
      } catch (error) {
        throw new BaselineError(`it is not a baseline in formatVersion ${from}: ${(error as Error).message}`)
      }
    }
  }
  // `monkeypatchlistVersion` is checked as a named format, so a bad one is reported as not `semver`, not by the regex.
  validate ??= new Ajv2020({ allErrors: true, strict: true, formats: { semver } }).compile(schema)
  if (!validate(value)) {
    const problems = (validate.errors ?? []).map(problem)
    throw new BaselineError(`it is not a baseline:\n${problems.map((line) => `  ${line}`).join('\n')}`)
  }

  const baseline = value as Baseline
  const scheme = baseline.fingerprintScheme
  let migrated: readonly BaselineEntry[] = baseline.entries
  for (let from = scheme; from !== fingerprintScheme; from++) {
    const migrate = from < fingerprintScheme ? migrations.fingerprintScheme.get(from) : undefined
    if (migrate === undefined) {
      // A newer scheme comes from a newer monkeypatchlist: replacing it with this one is a downgrade (§4 Version skew).
      const [skew, remedy] =
        scheme > fingerprintScheme
          ? [
              'is newer than',
              'Upgrade monkeypatchlist, or write a new baseline with monkeypatchlist baseline init --allow-downgrade',
            ]
          : ["can't be migrated to", 'Write a new baseline with monkeypatchlist baseline init']
      throw new BaselineError(
        `its fingerprint scheme ${scheme} ${skew} this monkeypatchlist's (${fingerprintScheme}), so its fingerprints never ` +
          `match this scan's. ${remedy}`,
      )
    }
    migrated = migrate(migrated)
  }
  const entries = migrated.map(entry)
  const seen = new Set<string>()
  for (const { fingerprint } of entries) {
    if (seen.has(fingerprint)) throw new BaselineError(`it lists the fingerprint ${fingerprint} twice`)
    seen.add(fingerprint)
  }
  const { catalogVersion, monkeypatchlistVersion } = baseline
  return {
    baseline: {
      formatVersion,
      scanConfigId: baseline.scanConfigId,
      fingerprintScheme,
      catalogVersion,
      monkeypatchlistVersion,
      completeness: baseline.completeness,
      surface: baseline.surface,
      packages: Object.fromEntries(
        Object.entries(baseline.packages).map(([name, { version, versionSource }]) => [name, { version, versionSource }]),
      ),
      entries,
    },
    written: { formatVersion: version as number, fingerprintScheme: scheme, catalogVersion, monkeypatchlistVersion },
    previous,
  }
}

/**
 * The versions a baseline's text was written with (§4 Version skew), for `baseline init` to tell whether the file it
 * replaces came from a newer version. They are the versions `readBaseline` reads. A text that isn't a baseline this
 * monkeypatchlist reads (a newer format or fingerprint scheme, or a newer catalog's holder) gives each version its header
 * records in a well-formed value, and a text that isn't a JSON object gives none.
 */
export function writtenVersions(text: string, migrations: Migrations = shipped): Partial<Versions> {
  try {
    return readBaseline(text, migrations).written
  } catch (error) {
    if (!(error instanceof BaselineError)) throw error
  }
  let value: unknown
  try {
    value = parseJson(text)
  } catch {
    return {}
  }
  if (typeof value !== 'object' || value === null) return {}
  const header = value as Record<string, unknown>
  const written: Partial<Versions> = {}
  for (const name of ['formatVersion', 'fingerprintScheme', 'catalogVersion'] as const) {
    if (Number.isInteger(header[name])) written[name] = header[name] as number
  }
  const { monkeypatchlistVersion } = header
  if (typeof monkeypatchlistVersion === 'string' && semver.test(monkeypatchlistVersion)) written.monkeypatchlistVersion = monkeypatchlistVersion
  return written
}

/** The JSON value in a baseline file's `text`, with a leading UTF-8 byte order mark dropped. */
function parseJson(text: string): unknown {
  return JSON.parse(text.startsWith('﻿') ? text.slice(1) : text)
}

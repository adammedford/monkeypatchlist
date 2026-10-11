// A previous scan's values (§11 Never `changed`, §16 `--previous`): each finding's reachability and install context in
// a full JSON scan report, which the reachability-change and install-context-change notes compare with. A baseline
// stores neither (ADR 0014), so they come from `--previous`, or from `--baseline` when it is a full report.

import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import { installContexts, reachabilities, type InstallContext, type Reachability } from '../../analysis/index.ts'
import { BaselineError, problem } from './error.ts'
import { isReport } from './report.ts'

/** A finding's reachability and install context in the previous scan (§7). */
export interface PreviousValue {
  reachability: Reachability
  installContext: InstallContext
}

/**
 * The previous scan's values by fingerprint. A finding the previous scan reported with no occurrences (`removed` or
 * `unconfirmed`) has none.
 */
export type PreviousValues = ReadonlyMap<string, PreviousValue>

/** A previous report as `--previous` reads it: the scan-config id it must share with the scan, and its values. */
export interface ReadPrevious {
  scanConfigId: string
  values: PreviousValues
}

/** The parts of a report the previous values are read from. */
const schema = {
  type: 'object',
  required: ['reportVersion', 'config', 'findings'],
  properties: {
    reportVersion: { type: 'integer' },
    config: { type: 'object', required: ['scanConfigId'], properties: { scanConfigId: { type: 'string' } } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['fingerprint', 'reachability', 'installContext'],
        properties: {
          fingerprint: { type: 'string', minLength: 1 },
          reachability: { enum: [...reachabilities, null] },
          installContext: { enum: [...installContexts, null] },
        },
      },
    },
  },
}

let validate: ValidateFunction | undefined

interface PreviousReport {
  reportVersion: number
  config: { scanConfigId: string }
  findings: { fingerprint: string; reachability: Reachability | null; installContext: InstallContext | null }[]
}

/**
 * The previous values in a parsed report `value` (§11), or a `BaselineError` that says why it isn't a report they can
 * be read from.
 */
export function previousOfReport(value: unknown, reportVersion: number): ReadPrevious {
  if (!isReport(value)) throw new BaselineError('it is not a scan report')
  validate ??= new Ajv2020({ allErrors: true, strict: true }).compile(schema)
  if (!validate(value)) {
    const problems = (validate.errors ?? []).map(problem)
    throw new BaselineError(`it is not a scan report:\n${problems.map((line) => `  ${line}`).join('\n')}`)
  }
  const report = value as PreviousReport
  if (report.reportVersion !== reportVersion) {
    const relation = report.reportVersion > reportVersion ? 'newer' : 'older'
    throw new BaselineError(
      `it is a scan report in reportVersion ${report.reportVersion}, ${relation} than this monkeypatchlist reads (${reportVersion})`,
    )
  }
  const values = new Map<string, PreviousValue>()
  for (const { fingerprint, reachability, installContext } of report.findings) {
    if (reachability !== null && installContext !== null) values.set(fingerprint, { reachability, installContext })
  }
  return { scanConfigId: report.config.scanConfigId, values }
}

/** The previous report in `text` (§16 `--previous`), or a `BaselineError` that says why it can't be read. */
export function readPrevious(text: string, reportVersion: number): ReadPrevious {
  let value: unknown
  try {
    value = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text)
  } catch (error) {
    throw new BaselineError(`it is not valid JSON: ${(error as Error).message}`)
  }
  return previousOfReport(value, reportVersion)
}

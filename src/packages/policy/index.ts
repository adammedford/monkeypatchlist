// Policy (§19, module 8): decides the policy slot of each finding and the gate result (§15). It knows nothing of
// rendering.

import type { ComparedFinding } from '../compare/index.ts'
import type { Level } from '../completeness/index.ts'
import type { FailOnState } from '../config/index.ts'

/** A finding's policy slot (§15): in R1, `{ outcome: 'fail', by }` when it trips the gate, otherwise null. */
export type PolicySlot = { outcome: 'fail'; by: `fail-on:${FailOnState}` } | null

export interface PolicedFinding extends ComparedFinding {
  policy: PolicySlot
}

/**
 * The gate (§15): the states it fails on, whether it ran and passed, and the exit code it gives (§16). The result is
 * the findings' alone; an `incomplete` scan shows in the exit code, 3, and the completeness level.
 */
export interface Gate {
  failOn: FailOnState[]
  result: 'pass' | 'fail' | 'not-run'
  exitCode: 0 | 1 | 3
}

/**
 * Applies `--fail-on` (§11 The gate): a finding in a listed state trips the gate, and its policy slot says so. Every
 * other slot is null (not evaluated). The gate fails, with exit code 1, when a finding trips it. With no states listed
 * it does not run.
 *
 * When the gate runs over an `incomplete` scan, the exit code is 3 whether the gate passed or failed (§13, §16).
 * `allowIncomplete` downgrades that to a warning, which the CLI writes, and the exit code is the gate's own.
 */
export function applyPolicy(
  findings: readonly ComparedFinding[],
  options: { failOn: readonly FailOnState[]; level: Level; allowIncomplete: boolean },
): { findings: PolicedFinding[]; gate: Gate } {
  const { failOn } = options
  const policed = findings.map((finding): PolicedFinding => {
    const state = failOn.find((listed) => listed === finding.baselineState)
    return { ...finding, policy: state === undefined ? null : { outcome: 'fail', by: `fail-on:${state}` } }
  })
  if (failOn.length === 0) return { findings: policed, gate: { failOn: [], result: 'not-run', exitCode: 0 } }
  const failed = policed.some((finding) => finding.policy !== null)
  const exitCode = options.level === 'incomplete' && !options.allowIncomplete ? 3 : failed ? 1 : 0
  return { findings: policed, gate: { failOn: [...failOn], result: failed ? 'fail' : 'pass', exitCode } }
}

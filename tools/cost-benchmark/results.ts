// The cost benchmark's results (pure): each group's cost against §18's target, the worst artifact and link group, the
// budget-driven variance between a site's report and its raised-cap reruns, and the summary table.

import type { Budget } from '../../src/packages/analysis/index.ts'
import type { GroupCost } from './measure.ts'

/** §18 Target. */
export const target = {
  /** At most 10 s of cold-scan time per MB (10⁶ bytes) on every validation-corpus artifact. */
  secondsPerMB: 10,
  /** At most 400× peak heap per source byte per link group, so a 5 MB group fits in 2 GB. */
  heapPerByte: 400,
  /** No result a budget or cap changed, measured against the raised-cap reruns. */
  budgetVariance: 0,
} as const

/** The runner the target is set on (§18): 8 GB, 2 vCPU, the common hosted CI size. */
export const referenceMachine = { memoryBytes: 8 * 1024 ** 3, cpus: 2 } as const

/** A group's cost, with its time per MB and peak heap per source byte. */
export interface MeasuredGroup extends GroupCost {
  /** Seconds per 10⁶ bytes of the group's source; null for a group of no bytes. */
  secondsPerMB: number | null
  /** Peak heap per source byte; null for a group of no bytes. */
  heapPerByte: number | null
}

export function measured(cost: GroupCost): MeasuredGroup {
  const empty = cost.bytes === 0
  return {
    ...cost,
    secondsPerMB: empty ? null : cost.ms / 1000 / (cost.bytes / 1e6),
    heapPerByte: empty ? null : cost.peakHeapBytes / cost.bytes,
  }
}

/** What the step budget per byte is multiplied by in every rerun, so that it can't fire. */
export const rerunStepsFactor = 64

/** One raised-cap rerun: the caps it raises, and the budget it runs with. */
export interface Rerun {
  /** The cap it raises, or `depth+contexts` for the two together. */
  name: string
  budget: Budget
}

/**
 * The reruns budget-driven variance is measured against:
 * one per cap with that cap alone multiplied by `factor`, then one with `depth` and `contexts` together multiplied,
 * each with the step budget per byte ×64 so that it can't fire.
 */
export function reruns(budget: Budget, factor: number): Rerun[] {
  const raised = (names: readonly (keyof Budget['caps'])[]): Budget => {
    const caps = { ...budget.caps }
    for (const name of names) caps[name] = budget.caps[name] * factor
    return { stepsPerByte: budget.stepsPerByte * rerunStepsFactor, caps }
  }
  const names = Object.keys(budget.caps) as (keyof Budget['caps'])[]
  return [
    ...names.map((name) => ({ name, budget: raised([name]) })),
    { name: 'depth+contexts', budget: raised(['depth', 'contexts']) },
  ]
}

/** The parts of a report budget-driven variance is judged on. */
interface ComparedReport {
  findings: { fingerprint: string; effect: string; locks: unknown }[]
  completeness: { level: string }
}

/**
 * Every difference between a site's report and its raised-budget rerun's that counts as budget-driven variance:
 * a fingerprint only one of them has, a finding whose effect or `locks` differ, and a different completeness level.
 * None when the budget and caps changed nothing.
 */
export function budgetVariance(base: ComparedReport, raised: ComparedReport): string[] {
  const differences: string[] = []
  const byFingerprint = (report: ComparedReport) =>
    new Map(report.findings.map((finding) => [finding.fingerprint, finding]))
  const before = byFingerprint(base)
  const after = byFingerprint(raised)
  const fingerprints = [...new Set([...before.keys(), ...after.keys()])].sort()
  for (const fingerprint of fingerprints) {
    const was = before.get(fingerprint)
    const now = after.get(fingerprint)
    if (now === undefined) differences.push(`${fingerprint}: only without the raised budget`)
    else if (was === undefined) differences.push(`${fingerprint}: only with the raised budget`)
    else {
      if (was.effect !== now.effect) differences.push(`${fingerprint}: effect ${was.effect} → ${now.effect}`)
      if (JSON.stringify(was.locks) !== JSON.stringify(now.locks)) {
        differences.push(`${fingerprint}: locks ${JSON.stringify(was.locks)} → ${JSON.stringify(now.locks)}`)
      }
    }
  }
  if (base.completeness.level !== raised.completeness.level) {
    differences.push(`completeness level ${base.completeness.level} → ${raised.completeness.level}`)
  }
  return differences
}

/** One benchmarked site: a corpus site, or a scale-fixture build. */
export interface SiteResult {
  id: string
  kind: 'corpus' | 'scale'
  /** The whole cold scan's wall-clock time, in milliseconds: discovery, analysis, attribution and the report. */
  scanMs: number
  /** The bytes of source its link groups analyzed, each group counted once. */
  bytes: number
  level: string
  /** How many of its link groups exhausted their step budget. */
  budgetExhausted: number
  groups: MeasuredGroup[]
  /**
   * The budget-driven variance: every difference any rerun shows, once, in rerun order; null for the scale fixture, which isn't
   * rerun, and with `--no-rerun`.
   */
  variance: string[] | null
  /** Each rerun's own differences, in the order of `Results.reruns`; null when `variance` is. */
  reruns: { name: string; variance: string[] }[] | null
}

export interface Machine {
  platform: string
  release: string
  arch: string
  cpuModel: string
  cpus: number
  memoryBytes: number
  node: string
  heapLimitBytes: number
}

export interface Results {
  machine: Machine
  reference: typeof referenceMachine & { matches: boolean }
  target: typeof target
  analyzerVersion: string | null
  catalogVersion: string | null
  /** What each rerun multiplied its caps by; null with `--no-rerun`. */
  raisedBy: number | null
  /** The reruns each corpus site was rescanned with; null with `--no-rerun`. */
  reruns: Rerun[] | null
  sites: SiteResult[]
  /** Each scan that failed: `measured`, or the name of the rerun. */
  failures: { id: string; run: string; message: string }[]
  worst: {
    /** The group entry artifact with the most time per MB, and its site. */
    artifact: { site: string; artifact: string; members: string[]; bytes: number; ms: number; secondsPerMB: number } | null
    /** The link group with the most peak heap per source byte, and its site. */
    linkGroup: {
      site: string
      entry: string
      members: string[]
      bytes: number
      peakHeapBytes: number
      heapPerByte: number
    } | null
  }
  /** Budget-driven variance across the corpus, counted even when it is zero. */
  variance: { sites: number; sitesWithVariance: number; results: number }
}

export function machineMatchesReference(machine: Machine): boolean {
  // An 8 GB runner reports a little less than 8 GiB.
  return machine.cpus === referenceMachine.cpus && Math.abs(machine.memoryBytes - referenceMachine.memoryBytes) < 1024 ** 3
}

export function worstOf(sites: readonly SiteResult[]): Results['worst'] {
  let artifact: Results['worst']['artifact'] = null
  let linkGroup: Results['worst']['linkGroup'] = null
  for (const site of sites) {
    for (const group of site.groups) {
      const { secondsPerMB, heapPerByte } = group
      if (secondsPerMB !== null && (artifact === null || secondsPerMB > artifact.secondsPerMB)) {
        artifact = { site: site.id, artifact: group.entry, members: group.members, bytes: group.bytes, ms: group.ms, secondsPerMB }
      }
      if (heapPerByte !== null && (linkGroup === null || heapPerByte > linkGroup.heapPerByte)) {
        const { entry, members, bytes, peakHeapBytes } = group
        linkGroup = { site: site.id, entry, members, bytes, peakHeapBytes, heapPerByte }
      }
    }
  }
  return { artifact, linkGroup }
}

export function varianceOf(sites: readonly SiteResult[]): Results['variance'] {
  const rerun = sites.filter((site) => site.variance !== null)
  return {
    sites: rerun.length,
    sitesWithVariance: rerun.filter((site) => site.variance!.length > 0).length,
    results: rerun.reduce((count, site) => count + site.variance!.length, 0),
  }
}

const mb = (bytes: number) => (bytes / 1e6).toFixed(3)
const fixed = (value: number | null, digits: number) => (value === null ? '–' : value.toFixed(digits))
const verdict = (value: number | null, limit: number) => (value === null ? '' : value <= limit ? ' ok' : ' OVER')
const max = (values: (number | null)[]) =>
  values.reduce<number | null>((most, value) => (value !== null && (most === null || value > most) ? value : most), null)

/** The summary table, as Markdown. */
export function summaryTable(results: Results): string {
  const { machine, reference, worst, variance } = results
  const lines = [
    '# monkeypatchlist cost benchmark',
    '',
    `Analyzer ${results.analyzerVersion ?? 'unknown'}, catalog ${results.catalogVersion ?? 'unknown'}.`,
    `Machine: ${machine.cpus} CPUs (${machine.cpuModel}), ${(machine.memoryBytes / 1024 ** 3).toFixed(1)} GiB, ` +
      `${machine.platform} ${machine.release} ${machine.arch}, Node ${machine.node}. ` +
      `Reference runner: 8 GB, 2 vCPU (${reference.matches ? 'this is one' : 'this is not one'}).`,
    `Target (§18): ≤ ${target.secondsPerMB} s/MB on every artifact, ≤ ${target.heapPerByte}× peak heap per source byte ` +
      'per link group, zero budget-driven variance.',
    '',
    worst.artifact === null
      ? 'Worst artifact: none measured.'
      : `Worst artifact: ${worst.artifact.artifact} in ${worst.artifact.site}, ` +
        `${worst.artifact.secondsPerMB.toFixed(2)} s/MB (${worst.artifact.ms.toFixed(0)} ms over ${mb(worst.artifact.bytes)} MB)` +
        `${verdict(worst.artifact.secondsPerMB, target.secondsPerMB)}.`,
    worst.linkGroup === null
      ? 'Worst link group: none measured.'
      : `Worst link group: ${worst.linkGroup.entry} (${worst.linkGroup.members.length} members) in ${worst.linkGroup.site}, ` +
        `${worst.linkGroup.heapPerByte.toFixed(0)}× (${mb(worst.linkGroup.peakHeapBytes)} MB peak heap over ` +
        `${mb(worst.linkGroup.bytes)} MB)${verdict(worst.linkGroup.heapPerByte, target.heapPerByte)}.`,
    results.raisedBy === null
      ? 'Budget-driven variance: not measured (--no-rerun).'
      : `Budget-driven variance: ${variance.results} results in ${variance.sitesWithVariance} of ${variance.sites} corpus ` +
        `sites, against reruns with each cap ×${results.raisedBy} on its own and depth and contexts ×${results.raisedBy} ` +
        `together, each with the step budget ×${rerunStepsFactor}${verdict(variance.results, target.budgetVariance)}.`,
    ...(results.failures.length === 0
      ? []
      : [`Failed scans: ${results.failures.map(({ id, run }) => `${id} (${run})`).join(', ')}.`]),
    '',
    '| Site | MB | Groups | Scan s | Worst s/MB | Worst heap ×/byte | Level | Budget variance |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...results.sites.map((site) => {
      const seconds = max(site.groups.map((group) => group.secondsPerMB))
      const heap = max(site.groups.map((group) => group.heapPerByte))
      return (
        `| ${site.id} | ${mb(site.bytes)} | ${site.groups.length} | ${(site.scanMs / 1000).toFixed(2)} | ` +
        `${fixed(seconds, 2)}${verdict(seconds, target.secondsPerMB)} | ${fixed(heap, 0)}${verdict(heap, target.heapPerByte)} | ` +
        `${site.level} | ${site.variance === null ? 'not rerun' : site.variance.length} |`
      )
    }),
    ...varianceByRerun(results.sites),
  ]
  return `${lines.join('\n')}\n`
}

/** The reruns that differ from their site's report, as a table; nothing when none does. */
function varianceByRerun(sites: readonly SiteResult[]): string[] {
  const rows = sites.flatMap((site) =>
    (site.reruns ?? [])
      .filter((rerun) => rerun.variance.length > 0)
      .map((rerun) => `| ${site.id} | ${rerun.name} | ${rerun.variance.length} |`),
  )
  if (rows.length === 0) return []
  return ['', 'Variance by rerun (the reruns that differ):', '', '| Site | Rerun | Differing results |', '| --- | --- | --- |', ...rows]
}

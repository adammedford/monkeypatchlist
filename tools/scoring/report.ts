// The parts of a `monkeypatchlist scan --json` report the scorer reads (§15), and the reachability order it rolls them up by.

import type { Realm } from '../../src/catalog.ts'

/** A finding of a `monkeypatchlist scan --json` report, with the fields the scorer reads (§15 Findings). */
export interface ReportedFinding {
  fingerprint: string
  targetKey: string
  target: { realm: Realm; holder: string; name: string; shadows?: string }
  surface: string
  effect: string
  locks: boolean | 'unknown'
  attribution: { key: string; provenance: string; package?: string }
  /** Its reachability (§7, §15): null only for a baseline entry the scan didn't find, which a corpus scan has none of. */
  reachability?: string | null
  reachabilityBasis?: string | null
  installContext?: string | null
  occurrences: { reachability?: string; trace: { kind: string; class?: string; tested?: string; result?: string }[] }[]
}

/** The fields of a `monkeypatchlist scan --json` report the scorer reads. */
export interface ScanReport {
  tool: { monkeypatchlistVersion: string; catalogVersion: number; analyzerVersion: string; fingerprintScheme: number }
  findings: ReportedFinding[]
  /** Each artifact's module links (§6 Reporting): the idiom conformance summary reads them. */
  artifacts?: { moduleLinking: ModuleLinking }[]
}

/** An artifact's `moduleLinking` (§6 Reporting), less its link-group count. */
export interface ModuleLinking {
  idioms: string[]
  modules: number
  unlinked: number
}

/** The reachability order across alternatives (§7 Combining guards): the most-reaching first. */
export const reachabilityOrder = ['unconditional', 'conditional', 'unknown', 'guarded-native-absence']

/** The most-reaching of a target's findings' values (§7: a finding reports the most-reaching over its occurrences). */
export function mostReaching(values: readonly string[]): string | undefined {
  return [...values].sort((a, b) => reachabilityOrder.indexOf(a) - reachabilityOrder.indexOf(b))[0]
}

/**
 * A report cut down to the fields above (each artifact to its `moduleLinking`), and to the `guard` steps of each occurrence's trace (the scorer reads no other
 * step). The harness holds every build's report until it has scored them all, and a full report is many times the size
 * of what the scorer reads, so it keeps only these.
 */
export function trimReport(report: ScanReport): ScanReport {
  const { monkeypatchlistVersion, catalogVersion, analyzerVersion, fingerprintScheme } = report.tool
  return {
    tool: { monkeypatchlistVersion, catalogVersion, analyzerVersion, fingerprintScheme },
    findings: report.findings.map(trimFinding),
    artifacts: (report.artifacts ?? []).map(({ moduleLinking: { idioms, modules, unlinked } }) => ({
      moduleLinking: { idioms: [...idioms], modules, unlinked },
    })),
  }
}

function trimFinding(f: ReportedFinding): ReportedFinding {
  const { realm, holder, name, shadows } = f.target
  const { key, provenance, package: pkg } = f.attribution
  return {
    fingerprint: f.fingerprint,
    targetKey: f.targetKey,
    target: { realm, holder, name, ...(shadows === undefined ? {} : { shadows }) },
    surface: f.surface,
    effect: f.effect,
    locks: f.locks,
    attribution: { key, provenance, ...(pkg === undefined ? {} : { package: pkg }) },
    ...(f.reachability === undefined ? {} : { reachability: f.reachability }),
    ...(f.reachabilityBasis === undefined ? {} : { reachabilityBasis: f.reachabilityBasis }),
    ...(f.installContext === undefined ? {} : { installContext: f.installContext }),
    occurrences: f.occurrences.map((o) => ({
      ...(o.reachability === undefined ? {} : { reachability: o.reachability }),
      trace: o.trace
        .filter((step) => step.kind === 'guard')
        .map(({ kind, class: guardClass, tested, result }) => ({
          kind,
          ...(guardClass === undefined ? {} : { class: guardClass }),
          ...(tested === undefined ? {} : { tested }),
          ...(result === undefined ? {} : { result }),
        })),
    })),
  }
}

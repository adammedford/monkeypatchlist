// The baseline format (§11 Baseline): its header and entries, in the fixed key order `baseline init` writes.

import type { Surface } from '../../../catalog.ts'
import type { Effect, Locks, Target } from '../../analysis/index.ts'
import type { Attribution } from '../../attribution/index.ts'
import type { Level } from '../../completeness/index.ts'
import type { SurfaceScope } from '../../config/index.ts'

/** The baseline format's version (§11 Format versions). */
export const formatVersion = 1

/**
 * One accepted finding. The fingerprint, and the attributes that decide `changed` (attribution key, effect and
 * `locks`), with the readable context that reports it when it is `removed` (target and its realm, surface, provenance,
 * and for a `pkg:` key the containing package in `attribution`).
 */
export interface BaselineEntry {
  fingerprint: string
  target: Target
  surface: Surface
  effect: Effect
  locks: Locks
  attribution: Attribution
}

/** A package's strong version, and where it came from (§10 Version): `store-path` or `lockfile`. */
export interface PackageVersion {
  version: string
  versionSource: string
}

/** A baseline: its header, then its entries, sorted by fingerprint. */
export interface Baseline {
  formatVersion: typeof formatVersion
  /** The scan-config id of the scan it was written from (§16). */
  scanConfigId: string
  fingerprintScheme: number
  catalogVersion: number
  monkeypatchlistVersion: string
  /** The completeness level it was written under (§13: only the summary level is stored). */
  completeness: Level
  /** The surface scope it covers (§12): each scope has its own baseline. */
  surface: SurfaceScope
  /**
   * Name → version and version source, strong versions only (§10), for the containing packages of the scan's findings. A
   * name with more than one strong version in the scan has no entry.
   */
  packages: Record<string, PackageVersion>
  entries: BaselineEntry[]
}

/**
 * The entry of a finding, or of an entry read from a file, with its keys in a fixed order: the fingerprint first, then
 * the fields in the report's order. Nothing else is kept.
 */
export function entry({ fingerprint, target, surface, effect, locks, attribution }: BaselineEntry): BaselineEntry {
  const { realm, holder, name, shadows } = target
  return {
    fingerprint,
    target: { realm, holder, name, ...(shadows === undefined ? {} : { shadows }) },
    surface,
    effect,
    locks,
    attribution: {
      key: attribution.key,
      provenance: attribution.provenance,
      ...(attribution.package === undefined ? {} : { package: attribution.package }),
    },
  }
}

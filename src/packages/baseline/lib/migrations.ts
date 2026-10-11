// Migrations (§11 Format versions, §4 Version skew): how this monkeypatchlist reads a baseline written in an older format, or
// under an older fingerprint scheme. The baseline is migrated in memory, and `baseline update` rewrites it.

import type { BaselineEntry } from './format.ts'

export interface Migrations {
  /**
   * Format migrations, by the `formatVersion` each reads. Each turns a baseline file's parsed JSON in that format into
   * the next format's, `formatVersion` included. The JSON is unchecked: a migration that throws on it makes the file
   * not a readable baseline, and the schema check judges what the last one gives.
   */
  format: ReadonlyMap<number, (baseline: unknown) => unknown>
  /**
   * Fingerprint scheme migrations, by the scheme each reads (§4: a scheme bump ships one). Each gives the baseline's
   * entries under the next scheme.
   */
  fingerprintScheme: ReadonlyMap<number, (entries: readonly BaselineEntry[]) => BaselineEntry[]>
}

/**
 * The migrations this monkeypatchlist ships. There are none yet: `formatVersion` 1 and fingerprint scheme 1 are the first. A
 * scheme change that can't be migrated needs a major release (§4).
 */
export const migrations: Migrations = { format: new Map(), fingerprintScheme: new Map() }

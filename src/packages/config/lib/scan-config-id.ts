// The scan-config id (§16 Scan configuration identity, ADR 0017): a hash of the settings that decide which findings
// can exist, recorded in a baseline so that it is never compared with a scan of something else.

import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { realms } from '../../../catalog.ts'
import type { Entry, Mapping, SurfaceScope } from './types.ts'

/**
 * The fields the id is made of, in the order of its parts. The mode, the source-map directories and the lockfile are
 * not among them: remote gaps already become `unconfirmed`, and maps and lockfile are optional evidence (ADR 0006).
 */
export const scanConfigFields = ['entries', 'mappings', 'surface', 'realms'] as const

/**
 * The scan-config id: one 12-hex-digit part per field of `scanConfigFields`, joined with `.`, so that two ids name the
 * fields that differ (§16). Each part is the start of the SHA-256 of the field's canonical JSON:
 *
 * - entries: `[file, url]` pairs, sorted
 * - mappings: `[url, dir]` pairs, sorted
 * - surface: the scope
 * - realms: the realm set, sorted. R1 has no setting that narrows it, so every scan covers all four realms (§2).
 *
 * Only what decides the findings counts: the order of entries and mappings doesn't (the longest mapping prefix wins),
 * and a path is normalized, without a trailing `/`.
 */
export function scanConfigId(config: {
  entries: readonly Entry[]
  mappings: readonly Mapping[]
  surface: SurfaceScope
}): string {
  const fields: Record<(typeof scanConfigFields)[number], unknown> = {
    entries: config.entries.map(({ file, url }) => [path(file), url]).sort(comparePairs),
    mappings: config.mappings.map(({ url, dir }) => [url, path(dir)]).sort(comparePairs),
    surface: config.surface,
    realms: [...realms].sort(),
  }
  return scanConfigFields.map((field) => digest(fields[field])).join('.')
}

/**
 * The fields in which two scan-config ids differ, in the order of `scanConfigFields`: none when they are the same id.
 * An id that doesn't have one part per field can't be read part by part, so it differs in every field.
 */
export function differingScanConfigFields(a: string, b: string): (typeof scanConfigFields)[number][] {
  const [ours, theirs] = [a.split('.'), b.split('.')]
  const readable = ours.length === scanConfigFields.length && theirs.length === scanConfigFields.length
  return scanConfigFields.filter((_, i) => !readable || ours[i] !== theirs[i])
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12)
}

/** A relative path in one spelling: `./assets/` and `assets` are the same directory. */
function path(value: string): string {
  const normalized = posix.normalize(value)
  return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
}

function comparePairs(a: readonly string[], b: readonly string[]): number {
  return compare(a[0]!, b[0]!) || compare(a[1]!, b[1]!)
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

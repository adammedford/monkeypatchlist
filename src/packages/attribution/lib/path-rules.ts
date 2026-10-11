// Framework path rules and escape-only shapes (§10 Escaped sources, Framework path rules): curated catalog data (§4)
// matched against a source's normalized path.

import type { EscapeOnlyShape, FrameworkPathRule, PathShape } from '../../../catalog.ts'
import type { SourcePath } from './containing-package.ts'

/** The curated path data attribution reads from the catalog (§4 Catalog versions). */
export interface PathRules {
  frameworkPathRules: Readonly<Record<string, FrameworkPathRule>>
  escapeOnlyShapes: Readonly<Record<string, EscapeOnlyShape>>
}

/**
 * What the curated path data says of a source with no `node_modules` segment (§10 Escaped sources):
 * - `rule`: a framework path rule matched it, and names `package` (the rule with the lowest id when several match)
 * - `escaped`: no rule matched, but an escape-only shape did
 * - `none`: neither did, so the inferred root decides
 */
export type PathRuling = { kind: 'rule'; rule: string; package: string } | { kind: 'escaped'; shape: string } | { kind: 'none' }

/**
 * Tries the framework path rules first, then the escape-only shapes, against a source's normalized path (§10 Escaped
 * sources: "Framework path rules are tried first"). Each is tried in id order, so the answer never depends on the
 * catalog's key order.
 */
export function pathRuling(path: SourcePath, rules: PathRules): PathRuling {
  if (path.segments.includes('node_modules')) return { kind: 'none' }
  for (const id of sortedIds(rules.frameworkPathRules)) {
    const rule = rules.frameworkPathRules[id]!
    const captured = matches(rule, path)
    if (captured !== null) {
      return { kind: 'rule', rule: id, package: rule.package.replace(placeholder, (_, name: string) => captured[name]!) }
    }
  }
  for (const id of sortedIds(rules.escapeOnlyShapes)) {
    if (matches(rules.escapeOnlyShapes[id]!, path) !== null) return { kind: 'escaped', shape: id }
  }
  return { kind: 'none' }
}

const placeholder = /<([A-Za-z][A-Za-z0-9_-]*)>/g

function sortedIds(record: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * What a shape captures from a path it matches, or null when it doesn't match: the path is in the shape's namespace,
 * and its segments hold the shape's run of whole segments, with at least one segment after it, and each placeholder
 * captured a value the shape's `captures` allows. With `up`, the run comes right after the path's leading `..`
 * segments, of which there are at least `up`. Without it, the run may start at any segment, and the first place it
 * matches counts.
 */
function matches(shape: PathShape, path: SourcePath): Record<string, string> | null {
  if (shape.namespace !== undefined && shape.namespace !== path.namespace) return null
  const { segments } = path
  let leading = 0
  while (segments[leading] === '..') leading++
  const starts =
    shape.up === undefined
      ? segments.map((_, at) => at)
      : leading >= shape.up
        ? [leading]
        : []
  for (const start of starts) {
    if (start + shape.segments.length >= segments.length) continue
    const captured: Record<string, string> = {}
    const all = shape.segments.every((pattern, i) => segmentMatches(pattern, segments[start + i]!, captured))
    if (all && capturesAllowed(shape, captured)) return captured
  }
  return null
}

/** Whether every placeholder captured a value its shape's `captures` allows, when it limits that placeholder. */
function capturesAllowed({ captures }: PathShape, captured: Record<string, string>): boolean {
  if (captures === undefined) return true
  return Object.entries(captured).every(([name, value]) => captures[name]?.includes(value) ?? true)
}

/** Whether one path segment matches a segment pattern, adding what its placeholders capture to `captured`. */
function segmentMatches(pattern: string, segment: string, captured: Record<string, string>): boolean {
  const names: string[] = []
  const source = pattern
    .split(/(<[A-Za-z][A-Za-z0-9_-]*>|\*)/)
    .map((part) => {
      if (part === '*') return '.*'
      const name = /^<(.+)>$/.exec(part)?.[1]
      if (name !== undefined) {
        names.push(name)
        return '(.+)'
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    })
    .join('')
  const found = new RegExp(`^${source}$`, 's').exec(segment)
  if (found === null) return false
  names.forEach((name, i) => (captured[name] = found[i + 1]!))
  return true
}

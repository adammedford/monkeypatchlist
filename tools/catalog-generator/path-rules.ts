import type { EscapeOnlyShape, FrameworkPathRule, PathShape } from '../../src/catalog.ts'

/** The curated framework path rules overlay (§10 Framework path rules), by rule id. */
export type FrameworkPathRulesOverlay = Record<string, FrameworkPathRule>

/** The curated escape-only shapes overlay (§10 Escaped sources), by shape id. */
export type EscapeOnlyShapesOverlay = Record<string, EscapeOnlyShape>

/**
 * The hand-edited framework path rules overlay, refused unless each entry is a well-formed shape (`shapeProblem`) with
 * a `package` whose every `<name>` its segments capture.
 */
export function frameworkPathRulesOverlay(json: unknown, file: string): FrameworkPathRulesOverlay {
  return entries(json, file, (id, entry) => {
    const { package: named, ...shape } = entry
    const problem = shapeProblem(shape)
    if (problem !== undefined) return `${id} ${problem}`
    if (typeof named !== 'string' || named === '') return `${id} needs a package, the package the rule names`
    const captured = new Set((shape as unknown as PathShape).segments.flatMap(placeholders))
    const missing = placeholders(named).find((name) => !captured.has(name))
    if (missing !== undefined) return `${id} names its package by <${missing}>, which its segments don't capture`
    return undefined
  }) as FrameworkPathRulesOverlay
}

/** The hand-edited escape-only shapes overlay, refused unless each entry is a well-formed shape (`shapeProblem`). */
export function escapeOnlyShapesOverlay(json: unknown, file: string): EscapeOnlyShapesOverlay {
  return entries(json, file, (id, entry) => {
    const problem = shapeProblem(entry)
    return problem === undefined ? undefined : `${id} ${problem}`
  }) as EscapeOnlyShapesOverlay
}

/** An overlay's entries, each an object that `problem` finds nothing wrong with, sorted by id. */
function entries(
  json: unknown,
  file: string,
  problem: (id: string, entry: Record<string, unknown>) => string | undefined,
): Record<string, unknown> {
  if (!isObject(json)) throw new Error(`${file}: needs an object of entries by id`)
  for (const [id, entry] of Object.entries(json)) {
    const found = isObject(entry) ? problem(id, entry) : `${id} needs an object`
    if (found !== undefined) throw new Error(`${file}: ${found}`)
  }
  return Object.fromEntries(Object.entries(json).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/**
 * What is wrong with a path shape, or undefined: it needs a `source`, an optional `namespace` string, an optional `up`
 * that is a positive integer, and one or more `segments`, each a non-empty segment with no `/` or `\`, not `.` or `..`,
 * whose `<`s and `>`s only enclose placeholder names, optional `captures` that list one or more whole segments for
 * placeholders its segments capture, and no other field.
 */
function shapeProblem(shape: Record<string, unknown>): string | undefined {
  const { source, namespace, up, segments, captures, ...rest } = shape
  if (Object.keys(rest).length) return `has fields a shape doesn't: ${Object.keys(rest).join(', ')}`
  if (typeof source !== 'string' || source === '') return 'needs a source: where the shape was observed'
  if (namespace !== undefined && (typeof namespace !== 'string' || namespace === '')) return 'needs a string namespace'
  if (up !== undefined && (!Number.isSafeInteger(up) || (up as number) < 1)) return 'needs an up that is a positive integer'
  if (!Array.isArray(segments) || segments.length === 0) return 'needs one or more segments'
  for (const segment of segments) {
    const bad =
      typeof segment !== 'string' ||
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      /[/\\]/.test(segment) ||
      /[<>]/.test(segment.replace(/<[A-Za-z][A-Za-z0-9_-]*>/g, ''))
    if (bad) return `has a segment that isn't a path segment pattern: ${JSON.stringify(segment)}`
  }
  if (captures !== undefined) {
    if (!isObject(captures)) return 'needs captures that are an object of values by placeholder name'
    const named = new Set((segments as string[]).flatMap(placeholders))
    for (const [name, values] of Object.entries(captures)) {
      if (!named.has(name)) return `limits <${name}> in its captures, which its segments don't capture`
      const good =
        Array.isArray(values) &&
        values.length > 0 &&
        values.every((value) => typeof value === 'string' && value !== '' && value !== '.' && value !== '..' && !/[/\\]/.test(value))
      if (!good) return `needs <${name}>'s captures to be one or more whole path segments`
    }
  }
  return undefined
}

/** The placeholder names a pattern holds: `pkg` for `<pkg>`. */
function placeholders(pattern: string): string[] {
  return [...pattern.matchAll(/<([A-Za-z][A-Za-z0-9_-]*)>/g)].map((match) => match[1]!)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

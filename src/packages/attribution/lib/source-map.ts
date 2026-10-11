// Reading a verified source map for attribution (§10, §19 Discovery): positions are looked up with
// `@jridgewell/trace-mapping` (`FlattenMap`, which flattens a sectioned map), and the raw `sources`, `sourceRoot` and
// `sourcesContent` are read from the map's raw JSON, in `FlattenMap`'s section order.

import { FlattenMap, traceSegment, type TraceMap } from '@jridgewell/trace-mapping'
import { relativeSourceRoot } from './containing-package.ts'

/** How an artifact's text splits into lines: the reading that verified its map (§2 Verification). */
export type LineReading = 'ecmascript' | 'lf-cr'

/** A verified map, read: its flattened mappings, and each source's raw entry, relative `sourceRoot` and content. */
export interface ReadMap {
  trace: TraceMap
  sources: SourceEntry[]
}

/**
 * A `sources` entry: `raw` as the map writes it (null for a null entry), the relative `sourceRoot` of its map or
 * section, which §10 step 1 joins only to an entry with no scheme that isn't absolute (null when there is none), its
 * `sourcesContent` entry, null when the map has none for it, and whether its map or section's ignore list names it:
 * `ignoreList` when the map has one, and `x_google_ignoreList` only otherwise (§10).
 */
export interface SourceEntry {
  raw: string | null
  sourceRoot: string | null
  content: string | null
  ignored: boolean
}

/** Reads a map's raw JSON, which verification has already read with `FlattenMap` (§2), or null if it can't. */
export function readMap(raw: unknown): ReadMap | null {
  try {
    const trace = new FlattenMap(raw as Parameters<typeof FlattenMap>[0])
    return { trace, sources: flattenedSources(raw) }
  } catch {
    return null
  }
}

/**
 * The sources of a map in `FlattenMap`'s order: a sectioned map's sections in turn, each flattened the same way, and a
 * plain map's `sources` with its own `sourceRoot` and `sourcesContent`.
 */
function flattenedSources(raw: unknown): SourceEntry[] {
  const map = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw
  if (!isObject(map)) return []
  if (Array.isArray(map.sections)) {
    return map.sections.flatMap((section: unknown) => (isObject(section) ? flattenedSources(section.map) : []))
  }
  const sources: unknown[] = Array.isArray(map.sources) ? map.sources : []
  const contents: unknown[] = Array.isArray(map.sourcesContent) ? map.sourcesContent : []
  const sourceRoot = relativeSourceRoot(map.sourceRoot)
  const ignoreList: unknown[] = Array.isArray(map.ignoreList)
    ? map.ignoreList
    : Array.isArray(map.x_google_ignoreList)
      ? map.x_google_ignoreList
      : []
  return sources.map((source, index) => {
    const content = contents[index]
    return {
      raw: typeof source === 'string' ? source : null,
      sourceRoot,
      content: typeof content === 'string' ? content : null,
      ignored: ignoreList.includes(index),
    }
  })
}

/**
 * The mapped original position of a generated one (§10 lookup point): trace-mapping's greatest lower bound on the same
 * generated line (0-based line and column). A 1-field segment, or no segment at or before the column, is unmapped.
 */
export function originalAt(
  map: ReadMap,
  line: number,
  column: number,
): { source: SourceEntry; index: number; line: number; column: number } | null {
  const segment = traceSegment(map.trace, line, column)
  if (segment === null || segment.length === 1) return null
  const [, index, originalLine, originalColumn] = segment
  const source = map.sources[index] ?? { raw: null, sourceRoot: null, content: null, ignored: false }
  return { source, index, line: originalLine, column: originalColumn }
}

/**
 * How an original source's text may split into lines (§10 Token check): an artifact's two readings, or at LF only, as
 * tools such as magic-string number an original's lines.
 */
type OriginalLineReading = LineReading | 'lf'

/** The terminators of each line reading (§2 Verification, §10 Token check). */
const terminators: Readonly<Record<OriginalLineReading, (code: number) => boolean>> = {
  ecmascript: (code) => code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029,
  'lf-cr': (code) => code === 0x0a || code === 0x0d,
  lf: (code) => code === 0x0a,
}

/** The line readings the token check tries on an original, any of which passes it (§10 Token check). */
const originalReadings: readonly OriginalLineReading[] = ['ecmascript', 'lf-cr', 'lf']

/** Where each line of `text` starts, under a line reading: a CRLF ends one line. */
export function lineStarts(text: string, reading: OriginalLineReading): number[] {
  const ends = terminators[reading]
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++
    if (ends(code)) starts.push(i + 1)
  }
  return starts
}

/** The 0-based line and column of a UTF-16 offset, through a line-start table. */
export function position(starts: readonly number[], offset: number): { line: number; column: number } {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= offset) low = middle
    else high = middle - 1
  }
  return { line: low, column: offset - starts[low]! }
}

/**
 * The token check (§10): whether `token` appears as a whole identifier, case-sensitive, within ±1 line of the 0-based
 * original `line` in `content`, under any of three line readings of the original: at §5's terminators, at LF and CR,
 * or at LF only.
 */
export function tokenAppears(content: string, line: number, token: string): boolean {
  return originalReadings.some((reading) => appearsNear(content, lineStarts(content, reading), line, token))
}

/** Whether `token` appears as a whole identifier within ±1 line of `line`, through a line-start table. */
function appearsNear(content: string, starts: readonly number[], line: number, token: string): boolean {
  const from = starts[Math.max(0, line - 1)] ?? content.length
  const to = starts[line + 2] ?? content.length
  const window = content.slice(from, to)
  for (let at = window.indexOf(token); at >= 0; at = window.indexOf(token, at + 1)) {
    const before = window.charCodeAt(at - 1)
    const after = window.charCodeAt(at + token.length)
    if (!identifierPart(before) && !identifierPart(after)) return true
  }
  return false
}

const identifierPartPattern = /[$\u200c\u200d\p{ID_Continue}]/u

/** Whether a UTF-16 code unit is an identifier part (ECMA-262 IdentifierPartChar). NaN, past either end, is not. */
function identifierPart(code: number): boolean {
  if (Number.isNaN(code)) return false
  if (code < 0x80) {
    return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
      code === 0x24 || code === 0x5f
  }
  return identifierPartPattern.test(String.fromCharCode(code))
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

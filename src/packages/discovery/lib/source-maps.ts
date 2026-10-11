// Source-map syntax (§2 Source maps, §19 Discovery): the annotations at the end of an artifact, `data:` URLs, and
// the verification of a candidate map against the artifact it would pair with. Maps are read with
// `@jridgewell/trace-mapping` (`FlattenMap`, which flattens a sectioned map), and `debugId` from the raw JSON.

import { decodedMappings, FlattenMap } from '@jridgewell/trace-mapping'

/** What an artifact's trailing comments name: a source map URL and a debug ID, either possibly absent. */
export interface Annotations {
  sourceMappingURL: string | null
  debugId: string | null
}

/** The comment contents that name a source map URL or a debug ID (ECMA-426 § MatchSourceMapURL, and Debug IDs). */
const patterns = {
  sourceMappingURL: /^[@#]\s*sourceMappingURL=(\S*?)\s*$/,
  debugId: /^[@#]\s*debugId=(\S*?)\s*$/,
} as const

/** ECMAScript WhiteSpace: tab, vertical tab, form feed, ZWNBSP, and every space separator. */
const whiteSpace = /[\t\v\f\ufeff\p{Zs}]/u

/** The code points whose presence in a line comment's own text makes it count as code (ECMA-426, without parsing). */
const quotes = /["'`]/

/**
 * The annotations of an artifact, as ECMA-426 extracts a source map URL without parsing (§ Linking generated code, in
 * the current draft), with a line scan in place of a lexer: the last `//# sourceMappingURL=` (or `//@`) line comment
 * that only whitespace and line comments follow, and the same for `//# debugId=`. A line comment that names neither
 * leaves them. Code resets both, and so does a block comment, which ECMA-426 no longer reads an annotation from. An
 * empty value names nothing, and resets its annotation. A block comment that runs past its line counts as code.
 *
 * With no lexer, a `//` inside a string, a template or a regular expression reads as a comment. So a line comment whose
 * own text (after the `//`) holds a `"`, `'` or backtick counts as code, as the draft's check has it: it resets both,
 * whatever its form, and an annotation after it still names (§2 Source maps). An annotation inside a literal is reset,
 * because a later line closes the literal with a quote, and that line is code or a quoted comment.
 */
export function annotations(text: string): Annotations {
  const found: Annotations = { sourceMappingURL: null, debugId: null }
  /** What a comment names for `key`: its value, null for an empty one, or undefined when it doesn't name `key`. */
  const match = (comment: string, key: keyof Annotations) => {
    const value = patterns[key].exec(comment)?.[1]
    return value === undefined ? undefined : value || null
  }
  for (const line of text.split(/\r\n|[\n\r\u2028\u2029]/)) {
    let position = 0
    while (position < line.length) {
      const first = line[position++]!
      if (whiteSpace.test(first)) continue
      const second = line[position]
      if (first === '/' && second === '/') {
        const comment = line.slice(position + 1)
        if (quotes.test(comment)) {
          found.sourceMappingURL = null
          found.debugId = null
          break
        }
        const url = match(comment, 'sourceMappingURL')
        const debugId = match(comment, 'debugId')
        if (url !== undefined) found.sourceMappingURL = url
        if (debugId !== undefined) found.debugId = debugId
        break
      }
      if (first === '/' && second === '*') {
        found.sourceMappingURL = null
        found.debugId = null
        // Skipped whole, so that a `//` inside it is not read as a line comment.
        const end = line.indexOf('*/', position + 1)
        if (end === -1) break
        position = end + 2
        continue
      }
      found.sourceMappingURL = null
      found.debugId = null
      // Code up to the next `/` would only reset them again.
      const slash = line.indexOf('/', position)
      if (slash === -1) break
      position = slash
    }
  }
  return found
}

const decoder = new TextDecoder('utf-8')

/**
 * The text a `data:` URL holds, decoded as UTF-8 whatever its media type (§17: maps are read as JSON whatever their
 * type), or null when it is malformed (Fetch § data: URL processor).
 */
export function dataUrlText(url: URL): string | null {
  // The URL serialized without its fragment, even an empty one, which `url.hash` doesn't show: a serialized URL's first
  // `#` starts its fragment.
  const fragment = url.href.indexOf('#')
  const body = url.href.slice('data:'.length, fragment === -1 ? undefined : fragment)
  const comma = body.indexOf(',')
  if (comma === -1) return null
  const bytes = percentDecode(body.slice(comma + 1))
  if (!/;[\t\n\f\r ]*base64[\t\n\f\r ]*$/i.test(body.slice(0, comma))) return decoder.decode(bytes)
  try {
    // Base64 is ASCII: any other byte makes `atob` throw.
    const binary = atob(decoder.decode(bytes).replace(/[\t\n\f\r ]/g, ''))
    return decoder.decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
  } catch {
    return null
  }
}

/** The bytes of a URL component's percent-encoding (URL § percent-decode): an invalid escape is left as it is. */
function percentDecode(text: string): Uint8Array {
  const bytes = [...new TextEncoder().encode(text)]
  const out: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0)
    if (bytes[i] === 0x25 && /^[0-9a-f]{2}$/i.test(hex)) {
      out.push(Number.parseInt(hex, 16))
      i += 2
    } else out.push(bytes[i]!)
  }
  return Uint8Array.from(out)
}

/**
 * The raw JSON of a map's text, with a leading BOM and a `)]}'` first line stripped (ECMA-426 § Fetching source maps),
 * or undefined when it isn't JSON.
 */
export function rawMap(text: string): unknown {
  let json = text.startsWith('\ufeff') ? text.slice(1) : text
  if (json.startsWith(")]}'")) json = json.slice(json.search(/[\n\r]|$/))
  try {
    return JSON.parse(json)
  } catch {
    return undefined
  }
}

/** The `debugId` of a map's raw JSON, when it has one. */
export function mapDebugId(raw: unknown): string | null {
  return isObject(raw) && typeof raw.debugId === 'string' ? raw.debugId : null
}

/** What a debug ID is compared by: two are equal when they are equal ignoring ASCII case. */
export function debugIdKey(debugId: string): string {
  return asciiLowercase(debugId)
}

/**
 * How an artifact's text is split into lines for its map (§2 Verification): at §5's terminators (`ecmascript`: LF, CR,
 * CRLF, U+2028 and U+2029), or only at LF and CR (`lf-cr`), which some tools use when the artifact holds a raw U+2028
 * or U+2029.
 */
export type LineReading = 'ecmascript' | 'lf-cr'

/** The line terminators of each reading. */
const lineTerminators: Readonly<Record<LineReading, RegExp>> = {
  ecmascript: /\r\n|[\n\r\u2028\u2029]/,
  'lf-cr': /\r\n|[\n\r]/,
}

/**
 * The line reading under which a candidate map verifies against an artifact (§2 Source maps), whatever method found
 * it, or null when it doesn't verify:
 *
 * - the map is `version` 3, and reads as a map (`FlattenMap` flattens a sectioned one)
 * - every mapped generated line and column exists in the artifact: a column may be the end of its line
 * - the `debugId`s are equal, ignoring ASCII case, when both sides have one
 * - the token spot checks pass: no mapped position splits a token of the artifact, which it would when both the code
 *   units around it are identifier parts
 *
 * Lines end at an ECMAScript LineTerminatorSequence (§5 Positions). Tools that split lines only at LF and CR differ
 * when the artifact holds a raw U+2028 or U+2029, so such an artifact verifies when either reading holds. Attribution
 * (§10) looks positions up with the reading that verified, and with the LF/CR reading when both do.
 */
export function verification(artifact: { text: string; debugId: string | null }, raw: unknown): LineReading | null {
  if (!isObject(raw) || raw.version !== 3) return null
  if ('sections' in raw ? !Array.isArray(raw.sections) : typeof raw.mappings !== 'string') return null
  const debugId = mapDebugId(raw)
  if (debugId !== null && artifact.debugId !== null && debugIdKey(debugId) !== debugIdKey(artifact.debugId)) {
    return null
  }
  let mapped: Readonly<ReturnType<typeof decodedMappings>>
  try {
    mapped = decodedMappings(new FlattenMap(raw as Parameters<typeof FlattenMap>[0]))
  } catch {
    return null
  }
  const readings: LineReading[] = /[\u2028\u2029]/.test(artifact.text) ? ['lf-cr', 'ecmascript'] : ['ecmascript']
  return readings.find((reading) => positionsHold(artifact.text.split(lineTerminators[reading]), mapped)) ?? null
}

/** Whether every mapped generated position is in `lines`, and starts a token there. */
function positionsHold(lines: readonly string[], mapped: Readonly<ReturnType<typeof decodedMappings>>): boolean {
  for (const [index, segments] of mapped.entries()) {
    if (segments.length === 0) continue
    const line = lines[index]
    if (line === undefined) return false
    for (const [column] of segments) {
      if (!(column >= 0 && column <= line.length)) return false
      if (column > 0 && identifierPart(line.charCodeAt(column - 1)) && identifierPart(line.charCodeAt(column))) {
        return false
      }
    }
  }
  return true
}

const identifierPartPattern = /[$\u200c\u200d\p{ID_Continue}]/u

/** Whether a UTF-16 code unit is an identifier part (ECMA-262 IdentifierPartChar). NaN, past the end, is not. */
function identifierPart(code: number): boolean {
  if (Number.isNaN(code)) return false
  if (code < 0x80) {
    return (code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
      code === 0x24 || code === 0x5f
  }
  return identifierPartPattern.test(String.fromCharCode(code))
}

const asciiLowercase = (text: string) =>
  text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32))

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

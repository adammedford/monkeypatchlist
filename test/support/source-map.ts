// Source maps for fixture builds: decoded mappings encoded as a version 3 map's `mappings` (Base64 VLQ), and a small map
// that verifies against a one-line script that writes `window.fetch`.

/** A segment of a decoded mapping: generated column, then source index, original line and column, all 0-based. */
export type Segment = [number, number, number, number] | [number]

/** Encodes decoded mappings (one list of segments per generated line) as a source map's `mappings` (Base64 VLQ). */
export function mappings(lines: readonly (readonly Segment[])[]): string {
  const vlq = (value: number) => {
    let rest = value < 0 ? (-value << 1) | 1 : value << 1
    let out = ''
    do {
      let digit = rest & 31
      rest >>>= 5
      if (rest > 0) digit |= 32
      out += 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'[digit]
    } while (rest > 0)
    return out
  }
  const previous = [0, 0, 0, 0]
  return lines
    .map((segments) => {
      previous[0] = 0
      return segments
        .map((segment) =>
          segment
            .map((field, i) => {
              const delta = field - previous[i]!
              previous[i] = field
              return vlq(delta)
            })
            .join(''),
        )
        .join(',')
    })
    .join(';')
}

/**
 * A segment at every token start of `code`'s lines, each mapped to the same line and column of source 0: the map a
 * bundler that copies a module unchanged would write. Tokens are identifier and number runs, and each other
 * non-space character.
 */
export function identityMappings(code: string, source = 0): Segment[][] {
  return code.split(/\r\n|[\n\r\u2028\u2029]/).map((line, index) => {
    const segments: Segment[] = []
    for (const match of line.matchAll(/[\w$]+|[^\s\w$]/g)) segments.push([match.index, source, index, match.index])
    return segments
  })
}

/** A version 3 source map of one original source, as JSON text. */
export function sourceMap(lines: readonly (readonly Segment[])[], fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 3,
    sources: ['../src/app.js'],
    sourcesContent: ['window.fetch = wrapped\n'],
    names: [],
    mappings: mappings(lines),
    ...fields,
  })
}

/** `window.fetch = f` on line 1: `codeMap` has a segment at `window`, `fetch`, `=` and `f`. */
export const code = 'window.fetch = f'

/** A map of `code`, with `fields` besides. */
export const codeMap = (fields: Record<string, unknown> = {}) =>
  sourceMap(
    [
      [
        [0, 0, 0, 0],
        [7, 0, 0, 7],
        [13, 0, 0, 13],
        [15, 0, 0, 15],
      ],
    ],
    fields,
  )

/**
 * Code with other tokens than `code`, which `codeMap` doesn't verify against: its segment at column 7 splits
 * `window`, so the map is another build's.
 */
export const rebuilt = 'var a=window.fetch;window.fetch=function(){return a()}'

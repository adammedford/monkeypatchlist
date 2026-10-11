import type { ArtifactSource, GeneratedLocation } from './types.ts'

/**
 * An artifact's line-start table (§5): the UTF-16 offset where each line starts. Lines end at an ECMAScript
 * LineTerminatorSequence: LF, CR, CRLF, U+2028 or U+2029.
 */
export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) starts.push(i + 1)
  }
  return starts
}

/**
 * A member of a link group's text (§6 Link groups): the artifact whose code sits at `base` in the group's text, and its
 * own line-start table.
 */
export interface LinesMember {
  url: string
  hash: string
  origin?: ArtifactSource['origin']
  base: number
  length: number
  starts: readonly number[]
}

/**
 * The line-start tables of a link group's members, whose texts the group's text holds one after another. A location is
 * given in the coordinates of the artifact it is in, and the artifact each location was made for is remembered, so a
 * trace step can name the artifact its location is in.
 */
export class GroupLines {
  readonly members: readonly LinesMember[]
  readonly #artifacts = new WeakMap<GeneratedLocation, LinesMember>()
  readonly #located = new Map<number, Map<number, GeneratedLocation>>()

  constructor(members: readonly LinesMember[]) {
    this.members = members
  }

  /** The member whose text holds the group offset `offset`. */
  memberAt(offset: number): LinesMember {
    const { members } = this
    let low = 0
    let high = members.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (members[middle]!.base <= offset) low = middle
      else high = middle - 1
    }
    return members[low]!
  }

  /**
   * The location of the group range `[start, end)`. One range is located once: the analysis locates the same nodes
   * again and again, and each location it gives is one the table remembers the member of.
   */
  locate(start: number, end: number): GeneratedLocation {
    let byEnd = this.#located.get(start)
    if (byEnd === undefined) this.#located.set(start, (byEnd = new Map()))
    const known = byEnd.get(end)
    if (known !== undefined) return known
    const member = this.memberAt(start)
    const location = locateIn(member.starts, start - member.base, end - member.base)
    this.#artifacts.set(location, member)
    byEnd.set(end, location)
    return location
  }

  /** The member a location this table made is in. */
  artifactOf(location: GeneratedLocation): LinesMember | undefined {
    return this.#artifacts.get(location)
  }
}

/** A line-start table: an artifact's own, or a link group's (`GroupLines`). */
export type Starts = readonly number[] | GroupLines

/** The generated location of the UTF-16 range `[start, end)`: its start as a 1-based line and a 0-based column. */
export function locate(starts: Starts, start: number, end: number): GeneratedLocation {
  return starts instanceof GroupLines ? starts.locate(start, end) : locateIn(starts, start, end)
}

function locateIn(starts: readonly number[], start: number, end: number): GeneratedLocation {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= start) low = middle
    else high = middle - 1
  }
  return { start, end, line: low + 1, column: start - starts[low]! }
}

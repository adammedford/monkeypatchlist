// First-party code (§10 Provenance, §11 Attribution keys): the inferred root of each bundler namespace, and the
// root-relative path first-party code is named by.

import type { SourceKind, SourcePath } from './containing-package.ts'

/**
 * A location in a namespace's frame: `up` leading `..` segments above the namespace's frame (the build directory, for
 * relative sources, or the bundler's base), then the named segments `down`. An absolute path has `up` 0.
 */
interface Place {
  up: number
  down: readonly string[]
}

/** A source's path resolved into its namespace's frame. */
interface Resolved {
  namespace: string
  place: Place
}

/**
 * The frame of a map, for its relative sources: its build-relative directory's segments (§10), or null for a
 * fetched map, which has no place in the build. A relative entry is resolved against it.
 */
export type MapDirectory = readonly string[] | null

/**
 * A source's path resolved into its namespace's frame: a relative entry against its map's build-relative
 * directory, into the one namespace the relative-path maps of the build share, and any other path as it is. Null for
 * a relative entry of a map whose directory isn't known.
 */
function resolved(path: SourcePath, directory: MapDirectory): Resolved | null {
  const segments = path.namespace === 'relative' ? (directory === null ? null : [...directory, ...path.segments]) : path.segments
  if (segments === null) return null
  return { namespace: path.namespace, place: placeOf(collapsed(segments)) }
}

/** Segments with each `x/..` collapsed; leading `..` segments stay. */
function collapsed(segments: readonly string[]): string[] {
  const out: string[] = []
  for (const segment of segments) {
    if (segment === '..' && out.length > 0 && out.at(-1) !== '..') out.pop()
    else out.push(segment)
  }
  return out
}

function placeOf(segments: readonly string[]): Place {
  let up = 0
  while (segments[up] === '..') up++
  return { up, down: segments.slice(up) }
}

/**
 * The in-project package-source prefix of a package source (§10 Provenance): the place in front of its first
 * `node_modules` or `.yarn` segment. Null for a source in the pnpm or Bun global store or Yarn's global cache, which
 * don't count.
 */
function packagePrefix(place: Place): Place | null {
  const { down } = place
  if (globalStore(down)) return null
  const at = down.findIndex((segment) => segment === 'node_modules' || segment === '.yarn')
  if (at < 0) return null
  return { up: place.up, down: down.slice(0, at) }
}

/**
 * Whether a path lies in a global store: the pnpm global virtual store (`<store>/v<n>/links/…`), Bun's
 * (`.bun/install/cache/…`), or Yarn's global cache (`.yarn/berry/cache/…`).
 */
function globalStore(down: readonly string[]): boolean {
  return down.some(
    (segment, i) =>
      (segment === 'links' && /^v\d+$/.test(down[i - 1] ?? '')) ||
      (segment === '.bun' && down[i + 1] === 'install' && down[i + 2] === 'cache') ||
      (segment === '.yarn' && down[i + 1] === 'berry' && down[i + 2] === 'cache'),
  )
}

/**
 * A place as tokens in a frame `frame` levels above the namespace's: each level of the frame the place doesn't name is
 * a marker, which stands for the same unnamed directory in every place, and differs from every named segment.
 */
function tokens(place: Place, frame: number): string[] {
  return [...Array.from({ length: frame - place.up }, (_, level) => `\0${level}`), ...place.down]
}

/** The common ancestor of places in one namespace's frame (§10 Provenance). */
function commonAncestor(places: readonly Place[]): Place {
  const frame = Math.max(...places.map(({ up }) => up))
  const all = places.map((place) => tokens(place, frame))
  const [first = []] = all
  let length = 0
  while (length < first.length && all.every((each) => each[length] === first[length])) length++
  const common = first.slice(0, length)
  const markers = common.filter((token) => token.startsWith('\0')).length
  return { up: frame - markers, down: common.slice(markers) }
}

/**
 * The root-relative path of a place under `root` (§11 Root-relative paths), or null when the place lies outside
 * it. The root's prefix is stripped where the path has it, and a level of the frame the path climbs to without naming
 * it is dropped with its `../`.
 */
function rootRelative(place: Place, root: Place): string | null {
  const frame = Math.max(place.up, root.up)
  const path = tokens(place, frame)
  const prefix = tokens(root, frame)
  if (!prefix.every((token, i) => path[i] === token)) return null
  const rest = path.slice(prefix.length).filter((token) => !token.startsWith('\0'))
  return rest.length === 0 ? null : rest.join('/')
}

/** Whether `root` lies strictly above `base`: it is an ancestor of `base`, and not `base` itself (§9). */
function above(root: Place, base: Place): boolean {
  const frame = Math.max(root.up, base.up)
  const ancestor = tokens(root, frame)
  const of = tokens(base, frame)
  return ancestor.length < of.length && ancestor.every((token, i) => of[i] === token)
}

/**
 * The bundler namespaces whose base is the webpack context or the project root, the frame of their paths. `vite:` is
 * based like webpack (§10 Roots with no shared place).
 */
const basedNamespaces = /^(?:webpack:.*|webpack-internal|turbopack|vite)$/

/** A verified map of local-build code, as root inference reads it: its sources' kinds, and its directory. */
export interface MapSources {
  kinds: readonly SourceKind[]
  directory: MapDirectory
}

/**
 * How a source that names no package is attributed (§10 Provenance):
 * - `first-party`: inside its namespace's inferred root, named by its root-relative `path`, and `inferred` when that
 *   root lies above the bundler base (§9 `first-party-inferred`)
 * - `outside`: outside the root, or in a namespace with none, so it is escaped
 * - `unplaced`: a relative entry of a map with no place in the build, a fetched one, whose code is remote and keyed
 *   by its URL, not by a root
 */
export type Classified =
  | { kind: 'first-party'; path: string; inferred: boolean }
  | { kind: 'outside' }
  | { kind: 'unplaced' }

/**
 * Infers one root per bundler namespace across the scan (§10 Provenance): the common ancestor of every
 * in-project package-source prefix in it. A namespace with none takes the bundler's own base: the webpack context or
 * the project root for `webpack://`, `webpack-internal:///`, `turbopack:///[project]/` and `vite:` paths, and for
 * relative paths each map's own directory (§10 Roots with no shared place). Absolute paths, under every wrapper, share
 * one namespace with no base, so with no package source among them they have no root. Returns how each source
 * that names no package is attributed.
 */
export function firstPartyRoots(maps: readonly MapSources[]): (path: SourcePath, directory: MapDirectory) => Classified {
  const prefixes = new Map<string, Place[]>()
  for (const { kinds, directory } of maps) {
    for (const kind of kinds) {
      if (kind.kind === 'synthetic' || kind.kind === 'foreign-scheme' || kind.kind === 'other') continue
      const at = resolved(kind.path, directory)
      const prefix = at === null ? null : packagePrefix(at.place)
      if (at === null || prefix === null) continue
      prefixes.set(at.namespace, [...(prefixes.get(at.namespace) ?? []), prefix])
    }
  }
  const roots = new Map<string, Place | 'none' | 'own'>()
  const rootOf = (namespace: string) => {
    let root = roots.get(namespace)
    if (root !== undefined) return root
    const found = prefixes.get(namespace)
    if (found !== undefined) root = commonAncestor(found)
    else if (basedNamespaces.test(namespace)) root = { up: 0, down: [] }
    // Relative maps with no package source anywhere each take their own directory as root (§10 Roots with no shared
    // place).
    else if (namespace === 'relative') root = 'own'
    else root = 'none'
    roots.set(namespace, root)
    return root
  }
  return (path, directory) => {
    const at = resolved(path, directory)
    if (at === null) return { kind: 'unplaced' }
    // The bundler base: the map's directory for relative paths, the webpack context or project root otherwise. An
    // absolute path has none.
    const base = at.namespace === 'relative' ? placeOf(directory ?? []) : at.namespace === 'absolute' ? null : { up: 0, down: [] }
    const found = rootOf(at.namespace)
    const root = found === 'own' ? base : found
    const name = root === 'none' || root === null ? null : rootRelative(at.place, root)
    if (root === 'none' || root === null || name === null) return { kind: 'outside' }
    return { kind: 'first-party', path: name, inferred: base !== null && above(root, base) }
  }
}

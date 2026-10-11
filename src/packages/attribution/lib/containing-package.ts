// The containing package (§10 Containing package): read from a source map's raw `sources` entry alone, after
// normalizing it.

/**
 * What a raw `sources` entry names:
 * - `synthetic`: a synthetic or bundler-runtime source, which counts as unmapped (`no-map`)
 * - `foreign-scheme`: a source with a scheme §10 doesn't recognize, which keys `unknown` whether or not it names a
 *   package
 * - `package`: a file of the package `name`, with the path segments inside the package after it, the segments of the
 *   package's own directory (which hold its other files), the version its store path gives, or null (§10 Version), and
 *   the vendoring package (`name@version`) when the path lies inside another package's store entry, or null (§10
 *   Provenance, vendored code)
 * - `yarn-slug`: a scoped package under Yarn's pnpm linker, which names it only by the lossy `slug`
 * - `escaped`: a composed-map path that climbs out of its own package inside `node_modules` (`node_modules/@x/src/…`,
 *   `node_modules/src/…`, `node_modules/node_modules/…`), which is escaped wherever the inferred root is
 * - `other`: a path under no `node_modules` segment: first-party or escaped code
 *
 * Each but the first two carries the normalized `path` it was read from, which the inferred root is read from and
 * first-party code is named by (§10 Provenance, §11).
 */
export type SourceKind =
  | { kind: 'synthetic' }
  | { kind: 'foreign-scheme' }
  | {
      kind: 'package'
      name: string
      subpath: string[]
      path: SourcePath
      directory: string[]
      version: string | null
      vendoredBy: string | null
    }
  | { kind: 'yarn-slug'; slug: string; path: SourcePath }
  | { kind: 'escaped'; path: SourcePath }
  | { kind: 'other'; path: SourcePath }

/**
 * A source's normalized path (§10 Source schemes), with what it is relative to:
 * - `relative`: a path with no scheme, relative to its map's directory (a relative `sourceRoot` joined)
 * - `absolute`: a `file://`, absolute or drive-letter path, whose drive letter is its first segment
 * - `webpack:<ns>`, `webpack-internal`, `turbopack` or `vite`: a path relative to that bundler's base (the webpack
 *   context, or the project root), within the bundler namespace it names
 *
 * `segments` has `.` and `x/..` collapsed, and keeps leading `..` segments.
 */
export interface SourcePath {
  namespace: string
  segments: string[]
}

/**
 * The relative `sourceRoot` a map's entries may be joined to (§10 step 1), or null: a URL or an absolute or
 * drive-letter root is ignored, and so is an empty or non-string one.
 */
export function relativeSourceRoot(sourceRoot: unknown): string | null {
  if (typeof sourceRoot !== 'string' || sourceRoot === '') return null
  if (scheme.test(sourceRoot) || absolute(sourceRoot)) return null
  return sourceRoot
}

/** Whether a path is absolute: it starts with `/` or `\`, or with a drive letter. */
function absolute(path: string): boolean {
  return /^[/\\]/.test(path) || driveLetter.test(path)
}

/** A URL scheme at the start of a string. */
const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/
/** A drive letter at the start of a path, which is no scheme. */
const driveLetter = /^[A-Za-z]:(?:[/\\]|$)/

/**
 * The recognized schemes (§10 Source schemes), each with the prefix stripped before the path is read. A relative, an
 * absolute or a drive-letter path has none. `turbopack:///[turbopack]/…` is the bundler's runtime.
 */
const recognized: readonly [RegExp, (match: RegExpExecArray) => string][] = [
  [/^webpack:\/\/([^/]*)(?:\/|$)/, (match) => `webpack:${match[1]}`],
  [/^webpack-internal:\/\/\//, () => 'webpack-internal'],
  [/^turbopack:\/\/\/\[project\]\//, () => 'turbopack'],
  [/^vite:/, () => 'vite'],
  [/^file:\/\//, () => 'absolute'],
]

/** The synthetic and bundler-runtime sources, once the scheme is stripped (§10 step 1). */
const synthetic: readonly RegExp[] = [
  /^webpack\/runtime\//,
  /^webpack\/bootstrap/,
  /^<anon>$/,
  /^ignored\|/,
  /^external\s/,
]

/**
 * What a raw `sources` entry names, under a map's relative `sourceRoot` (§10 Containing package):
 *
 * 1. **Normalize.** A null or empty entry, or one holding `\0` (a Rollup virtual module), is synthetic. A BOM or a
 *    `)]}'` prefix is stripped, then a recognized scheme; any other scheme is foreign. A synthetic source is then
 *    recognized on the entry, before any root is joined: `webpack/runtime/*`, `webpack/bootstrap`, `<anon>`,
 *    `turbopack:///[turbopack]/…`, `ignored|…` and `external "x"`, and an entry whose resource path is empty.
 *    Only an entry that had no scheme and isn't absolute is joined to the root, as a string, with a `/` between them
 *    unless the root ends with one. Loader prefixes (up to the last `!`), a `?query` (webpack's `?hash`
 *    included) and `*` suffixes are stripped, so the resource path decides. The path is percent-decoded, `\` becomes
 *    `/`, and `.` and `x/..` segments collapse (leading `..` stay). A `file://`, absolute or drive-letter path is
 *    `absolute`, whatever scheme wraps it.
 * 2. **Read the name** from the segment after the last `node_modules` segment that a dot segment doesn't follow, or the
 *    two segments after it for a scoped package. Under Yarn's pnpm linker the package is in
 *    `node_modules/.store/<slug>-npm-<version>-<hash>/package/` (or `<slug>-virtual-<hash>`): an unscoped slug is its
 *    name, and a scoped one is lossy. A path that climbs out of its package inside `node_modules` names none.
 */
export function sourceKind(source: string | null, sourceRoot: string | null): SourceKind {
  if (source === null || source === '' || source.includes('\0')) return { kind: 'synthetic' }
  let path = source
  if (path.startsWith('\ufeff')) path = path.slice(1)
  if (path.startsWith(")]}'")) path = path.slice(4)
  if (/^turbopack:\/\/\/\[turbopack\]\//.test(path)) return { kind: 'synthetic' }
  const match = recognized.map(([pattern, name]) => [pattern.exec(path), name] as const).find(([found]) => found)
  let namespace = 'relative'
  if (match !== undefined) {
    const [found, name] = match
    namespace = name(found!)
    path = path.slice(found![0].length)
    // `file:///C:/x` names the drive-letter path `C:/x`.
    if (namespace === 'absolute' && /^\/[A-Za-z]:(?:[/\\]|$)/.test(path)) path = path.slice(1)
  } else if (scheme.test(path) && !driveLetter.test(path)) return { kind: 'foreign-scheme' }
  if (synthetic.some((pattern) => pattern.test(path))) return { kind: 'synthetic' }
  // An entry whose resource path is empty once the namespace, `./` and `?query` are stripped is synthetic too, such
  // as Next's context and hash stubs `webpack://_N_E/?6505`, whatever the root.
  if (segments(normalized(resourcePath(path))).length === 0) return { kind: 'synthetic' }
  if (absolute(path)) namespace = 'absolute'
  else if (namespace === 'relative' && sourceRoot !== null) {
    path = `${sourceRoot}${sourceRoot.endsWith('/') ? '' : '/'}${path}`
  }
  const read = segments(normalized(resourcePath(path)))
  return packageOf(read, { namespace, segments: read })
}

/** A path with its loader prefixes (up to the last `!`), `?query` (from the first `?`) and `*` suffixes stripped. */
function resourcePath(path: string): string {
  const resource = path.slice(path.lastIndexOf('!') + 1)
  const query = resource.indexOf('?')
  return (query >= 0 ? resource.slice(0, query) : resource).replace(/\*+$/, '')
}

/** A path percent-decoded, with POSIX separators. */
const normalized = (path: string) => percentDecoded(path).replaceAll('\\', '/')

/** The path's segments, with empty and `.` segments dropped and each `x/..` collapsed. Leading `..` segments stay. */
function segments(path: string): string[] {
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && out.length > 0 && out.at(-1) !== '..') out.pop()
    else out.push(segment)
  }
  return out
}

/** A Yarn pnpm-linker store entry's directory: `<slug>-npm-<version>-<hash>` or `<slug>-virtual-<hash>`. */
const yarnStoreEntry = /^(.+)-(?:npm-.+|virtual)-[0-9a-f]{10}$/

/** A Yarn pnpm-linker store entry's directory with a version: `<slug>-npm-<version>-<hash>`. */
const yarnStoreVersion = /^(.+)-npm-(.+)-[0-9a-f]{10}$/

/** A Yarn cache archive, local or global: `<slug>-npm-<version>-<hash>[-<hash>].zip`. */
const yarnArchive = /^(.+)-npm-(.+?)-[0-9a-f]{10}(?:-[0-9a-f]+)?\.zip$/

/**
 * A semver version at the start of a store entry's version part, and what may follow it: nothing, or pnpm's peer and
 * patch suffixes (`_react@18.2.0`, `(react@18.2.0)`).
 */
const storeVersion = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?:[_(].*)?$/

/** The version a store entry's version part gives, or null when it isn't a registry version (a git or file spec). */
function versionIn(part: string): string | null {
  return storeVersion.exec(part)?.[1] ?? null
}

/** Yarn's slug of a package name: a scoped name's `/` becomes `-`. */
const yarnSlug = (name: string) => name.replace('/', '-')

/**
 * The version a store path gives the package `name`, whose `node_modules` segment is at `at` (§10 Version): only when
 * the store entry right in front of that segment names the package itself, so a package inside another package's entry
 * (vendored code) gets none.
 *
 * - pnpm: `.pnpm/<name>@<version>/node_modules/<name>`, a scope's `/` written `+`
 * - Bun: `.bun/<name>@<version>/node_modules/<name>`, likewise
 * - Yarn: `<slug>-npm-<version>-<hash>.zip/node_modules/<name>`, in the project's cache or the global one
 * - pnpm's global virtual store: `<store>/v<n>/links/<name>/<version>/<hash>/node_modules/<name>`
 */
function storePathVersion(path: readonly string[], at: number, name: string): string | null {
  const entry = path[at - 1]
  if (entry === undefined) return null
  const store = path[at - 2]
  if (store === '.pnpm' || store === '.bun') {
    const prefix = `${name.replace('/', '+')}@`
    return entry.startsWith(prefix) ? versionIn(entry.slice(prefix.length)) : null
  }
  const archive = yarnArchive.exec(entry)
  if (archive !== null) return archive[1] === yarnSlug(name) ? versionIn(archive[2]!) : null
  const parts = name.split('/')
  const links = at - 3 - parts.length
  if (path[links] === 'links' && /^v\d+$/.test(path[links - 1] ?? '')) {
    const named = parts.every((part, k) => path[links + 1 + k] === part)
    return named ? versionIn(path[at - 2]!) : null
  }
  return null
}

/** A package named in a store entry, with the registry version the entry gives it. */
interface StoreOwner {
  name: string
  version: string
}

/**
 * The vendoring package of the package `name`, whose `node_modules` segment is at `at`, as `name@version` (§10
 * Provenance, vendored code; ADR 0006), or null: a **store-name mismatch**, where the nearest store entry the path lies
 * in names another package. Every store layout §10 Version reads counts:
 *
 * - pnpm `.pnpm/<n>@<v>` and Bun `.bun/<n>@<v>`, a scope's `/` written `+`
 * - Yarn's cache archives `<slug>-npm-<v>-<hash>.zip`, named by an unscoped slug, or for a scoped slug by the package
 *   directory inside the archive
 * - Yarn's pnpm-linker store `.store/<slug>-npm-<v>-<hash>`, named by an unscoped slug
 * - pnpm's global virtual store `v<n>/links/<name>/<v>/<hash>`
 *
 * So `.pnpm/telemetry-agent@1.2.0/node_modules/telemetry-agent/node_modules/tiny-helper/…` and the collapsed
 * `.pnpm/telemetry-agent@1.2.0/node_modules/tiny-helper/…`, which a hoisted build of telemetry-agent composes, are both
 * tiny-helper vendored in telemetry-agent@1.2.0. A store entry that gives no registry version (a git or file
 * dependency), or whose package can't be named (a lossy scoped slug), detects nothing.
 */
function vendoringPackage(path: readonly string[], at: number, name: string): string | null {
  for (let j = at - 1; j >= 0; j--) {
    const owner = storeOwner(path, j, at)
    if (owner === undefined) continue
    return owner === null || owner.name === name ? null : `${owner.name}@${owner.version}`
  }
  return null
}

/**
 * The package the store entry at `j` names, when `path[j]` is a store entry before the segment `at`: null when it is
 * one but can't be named with a registry version, undefined when it is none.
 */
function storeOwner(path: readonly string[], j: number, at: number): StoreOwner | null | undefined {
  const entry = path[j]!
  const store = path[j - 1]
  if ((store === '.pnpm' || store === '.bun') && path[j + 1] === 'node_modules') {
    const split = entry.indexOf('@', 1)
    if (split <= 0) return null
    const version = versionIn(entry.slice(split + 1))
    const named = entry.slice(0, split)
    const name = named.startsWith('@') ? named.replace('+', '/') : named
    return version === null ? null : { name, version }
  }
  const archive = yarnArchive.exec(entry)
  if (archive !== null && path[j + 1] === 'node_modules') {
    const version = versionIn(archive[2]!)
    if (version === null) return null
    if (!archive[1]!.startsWith('@')) return { name: archive[1]!, version }
    // A scoped slug is lossy: the package directory inside the archive names it, when the path passes through it.
    const scope = path[j + 2]
    const inner = path[j + 3]
    if (scope?.startsWith('@') !== true || inner === undefined || j + 3 >= at) return null
    const name = `${scope}/${inner}`
    return yarnSlug(name) === archive[1] ? { name, version } : null
  }
  if (store === '.store' && path[j - 2] === 'node_modules' && yarnStoreEntry.test(entry)) {
    const versioned = yarnStoreVersion.exec(entry)
    const version = versioned === null ? null : versionIn(versioned[2]!)
    if (versioned === null || version === null || versioned[1]!.startsWith('@')) return null
    return { name: versioned[1]!, version }
  }
  if (path[j + 1] === 'node_modules') {
    for (const parts of [1, 2]) {
      const links = j - 2 - parts
      if (path[links] !== 'links' || !/^v\d+$/.test(path[links - 1] ?? '')) continue
      const name = path.slice(links + 1, links + 1 + parts).join('/')
      if (parts === 2 && !name.startsWith('@')) continue
      const version = versionIn(path[j - 1]!)
      return version === null ? null : { name, version }
    }
  }
  return undefined
}

/**
 * Whether a normalized path climbs out of its own package inside `node_modules` (§10 Escaped sources): it holds,
 * as whole segments anywhere, `node_modules/src/`, `node_modules/@<scope>/src/` or `node_modules/node_modules/`, as
 * esbuild gives when it composes a dependency's own shipped maps (Sentry 7's `node_modules/@sentry/src/…`).
 */
function climbsOutOfPackage(path: readonly string[]): boolean {
  return path.some((segment, i) => {
    if (segment !== 'node_modules') return false
    const next = path[i + 1]
    if (next === 'node_modules' || next === 'src') return i + 2 < path.length
    return next?.startsWith('@') === true && path[i + 2] === 'src' && i + 3 < path.length
  })
}

/** The package a normalized path is in: the last `node_modules` segment that a dot segment doesn't follow decides. */
function packageOf(path: readonly string[], read: SourcePath): SourceKind {
  if (climbsOutOfPackage(path)) return { kind: 'escaped', path: read }
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i] !== 'node_modules') continue
    const next = path[i + 1]
    if (next === undefined) continue
    if (next.startsWith('.')) {
      const slug = next === '.store' && path[i + 3] === 'package' ? yarnStoreEntry.exec(path[i + 2] ?? '')?.[1] : undefined
      if (slug === undefined) continue
      if (slug.startsWith('@')) return { kind: 'yarn-slug', slug, path: read }
      const versioned = yarnStoreVersion.exec(path[i + 2]!)
      const version = versioned === null ? null : versionIn(versioned[2]!)
      const directory = path.slice(0, i + 4)
      const vendoredBy = vendoringPackage(path, i, slug)
      return { kind: 'package', name: slug, subpath: path.slice(i + 4), path: read, directory, version, vendoredBy }
    }
    const scoped = next.startsWith('@')
    if (scoped && path[i + 2] === undefined) continue
    const name = scoped ? `${next}/${path[i + 2]}` : next
    const end = i + (scoped ? 3 : 2)
    const version = storePathVersion(path, i, name)
    const vendoredBy = vendoringPackage(path, i, name)
    return { kind: 'package', name, subpath: path.slice(end), path: read, directory: path.slice(0, end), version, vendoredBy }
  }
  return { kind: 'other', path: read }
}

const decoder = new TextDecoder('utf-8')

/** A path percent-decoded as UTF-8 (URL § percent-decode): an invalid escape is left as it is. */
function percentDecoded(text: string): string {
  if (!text.includes('%')) return text
  const bytes = [...new TextEncoder().encode(text)]
  const out: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0)
    if (bytes[i] === 0x25 && /^[0-9a-f]{2}$/i.test(hex)) {
      out.push(Number.parseInt(hex, 16))
      i += 2
    } else out.push(bytes[i]!)
  }
  return decoder.decode(Uint8Array.from(out))
}

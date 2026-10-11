// Source store (§19, module 2): the only module that reads bytes. It reads local files through the URL→path mappings,
// and remote URLs through a `Fetcher`. It knows nothing of JavaScript semantics.

import type { Dirent, Stats } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, posix } from 'node:path'
import type { Mapping } from '../config/index.ts'
import { readDataUrl } from './lib/data-urls.ts'

/**
 * Whether an artifact's bytes were read (`ok`), or why not: a local file can't be read (`unreadable`), a remote one
 * isn't fetched offline (`offline-skipped`), the safety floor refused it (`remote-refused`), its fetch failed
 * (`fetch-failed`), or its bytes don't match their integrity value (`sri-mismatch`, §17 Outcomes).
 */
export type RetrievalStatus =
  | 'ok'
  | 'unreadable'
  | 'offline-skipped'
  | 'remote-refused'
  | 'fetch-failed'
  | 'sri-mismatch'

/**
 * The Subresource Integrity check of fetched bytes (§17 Integrity): `none` when no integrity value was checked, or
 * the check.
 */
export type Sri = 'none' | SriCheck

export { alternativeIntegrity } from './lib/integrity.ts'

/**
 * An integrity check: whether the bytes `match` their integrity value, and both digests. `expected` holds the value's
 * digests in the strongest algorithm it names, which is the one used, in its order, as `<algorithm>-<base64>`. `actual`
 * is the bytes' digest in that algorithm. For a value with alternatives that matches one, the check is that
 * alternative's; for one that matches none, `expected` holds every alternative's digests and `actual` is the bytes'
 * digest in the strongest algorithm any of them names.
 */
export interface SriCheck {
  result: 'match' | 'mismatch'
  expected: string[]
  actual: string
}

/**
 * What an artifact records of how its bytes were retrieved (§17 What is recorded). It holds no wall-clock data: that
 * goes in the report's `run` block (`RunRetrieval`).
 *
 * - `requestedUrl`: the URL the reference requested, which the artifact's URL, origin and attribution key come from,
 *   except for code a redirected script references: that is requested against the script's final URL, but its
 *   artifact's URL, origin and key come from the URL resolved against the script's own requested URL (§11, §17).
 *   Null for an inline script, which is part of its entry document and never requested.
 * - `finalUrl`: the URL the retrieval ended at, after any redirects. A build file's or a `data:` URL's is the requested
 *   URL. Null when nothing answered: offline, a fetch that got no response, and an inline script.
 * - `contentType`: the `Content-Type` of the response, as served, or a `data:` URL's MIME type. Null for a build file,
 *   an inline script, and a fetch with no response or no such header.
 * - `sri`: the Subresource Integrity check of the bytes (§17 Integrity). `none` when no integrity value was checked:
 *   the reference carries none, the bytes are a build file's or an inline script's, which are never fetched, or the
 *   check never ran: offline, a failed fetch, or a refusal before it. A refusal made after it passed, for a missing
 *   JavaScript MIME type, keeps the check (§17 Content types).
 */
export interface Retrieval {
  status: RetrievalStatus
  requestedUrl: string | null
  finalUrl: string | null
  contentType: string | null
  sri: Sri
}

/** The wall-clock facts of one fetch, which only the report's `run` block holds (§15, §17 What is recorded). */
export interface RunRetrieval {
  /** When the fetch finished, as an ISO 8601 UTC timestamp. */
  fetchedAt: string
  /** The final response's `ETag`, or null without one. */
  etag: string | null
  /** The final response's `Last-Modified`, or null without one. */
  lastModified: string | null
}

/**
 * The response a fetch ended with, after any redirects: its URL, the headers that are recorded, and the one that names
 * its source map: `SourceMap`, or else the deprecated `X-SourceMap` (§2 Source maps), or null without either.
 */
export interface FetchedResponse {
  finalUrl: string
  contentType: string | null
  etag: string | null
  lastModified: string | null
  sourceMap: string | null
}

/**
 * What a fetcher returns for a remote URL (§17 Outcomes): the bytes of a 2xx response, with their integrity check,
 * `offline-skipped`, or why there are none, with the response when there was one: `remote-refused` when the safety
 * floor refuses the fetch, `fetch-failed` when it fails, and `sri-mismatch` when the bytes don't match the request's
 * integrity value, with the check that failed. A refusal made after the bytes passed their integrity check, for a
 * content type that needs checking only then (§17 Content types), carries that check; `none` or left out otherwise. A
 * fetcher reports these as data; one that rejects is a bug (exit 4).
 */
export type FetchResult =
  | { status: 'offline-skipped' }
  | { status: 'ok'; response: FetchedResponse; bytes: Uint8Array; sri: Sri }
  | { status: 'remote-refused'; detail: string; response: FetchedResponse | null; sri?: Sri }
  | { status: 'fetch-failed'; detail: string; response: FetchedResponse | null }
  | { status: 'sri-mismatch'; detail: string; response: FetchedResponse; sri: SriCheck }

/**
 * How a reference asks for a remote URL, which the safety floor judges it by (§17):
 *
 * - `destination`: what the bytes are fetched as, which decides the MIME types a response may have (§17 Content
 *   types). `script` is a classic script of the window, from a `script` element or a `<link rel=preload as=script>`.
 *   `module` is a module script, however it is loaded: a module `script` element, a `modulepreload`, an import or a
 *   dynamic import. `worker` is a classic script of a worker: a worker's script, or one `importScripts` loads. `map` is
 *   a source map.
 * - `document`: the URL of the entry document the reference was made for. `http:` may be fetched only for an `http:`
 *   document (§17 Schemes).
 * - `integrity`: the integrity metadata the reference carries (§17 Integrity), which the bytes are checked against:
 *   an element's `integrity` attribute, or its URL's entry in an import map's `integrity` section. None when left out
 *   or empty.
 * - `imported`: whether `importScripts` loads the script, rather than it being a worker's own. A browser runs a script
 *   `importScripts` loads only with a JavaScript MIME type, whatever its URL's scheme, where a worker's own classic
 *   script from a URL that isn't HTTP(S), such as a `data:` URL, needs none (HTML § Fetch a classic worker-imported
 *   script, § Fetch a classic worker script). An HTTP(S) response is checked the same either way.
 */
export interface FetchRequest {
  destination: 'script' | 'module' | 'worker' | 'map'
  document: string
  integrity?: string
  imported?: boolean
}

/**
 * Reads remote URLs (§19 Source store and retrieval): the offline fetcher here, the fixture fetcher (`fixture.ts`) for
 * tests, and the resolve fetcher (`resolve.ts`), which enforces §17's safety floor.
 */
export interface Fetcher {
  fetch(url: string, request: FetchRequest): Promise<FetchResult>
}

/** The offline fetcher (§17): every call returns `offline-skipped`. */
export const offlineFetcher: Fetcher = {
  fetch: async () => ({ status: 'offline-skipped' }),
}

/**
 * The bytes of a URL or build file, or why there are none, and its retrieval record. `path` is build-relative and
 * POSIX, and null for a remote URL. `sourceMap` is the header of a fetched response that names its source map
 * (`FetchedResponse`), and null for a build file, which has no headers. A build file that can't be read says why in
 * `detail`: the error's code, or that its URL names no path in the build directory. Whether a file is there to read
 * is the listing's to say (`list()`), not the error's (§2 Source maps). A `data:` URL is `refused` when a browser
 * would not run the script it holds (§2 Other script URLs): it has no retrieval record, because nothing of it is an
 * artifact.
 */
export type ReadResult =
  | { status: 'ok'; url: string; path: string | null; bytes: Uint8Array; retrieval: Retrieval; sourceMap: string | null }
  | { status: 'unreadable'; url: string; path: string; detail: string; retrieval: Retrieval }
  | { status: 'offline-skipped'; url: string; retrieval: Retrieval }
  | { status: 'remote-refused' | 'fetch-failed' | 'sri-mismatch'; url: string; detail: string; retrieval: Retrieval }
  | { status: 'refused'; url: string; detail: string }

/**
 * The regular files of the build directory (§2 Sweep), sorted by path: each with the URL a mapping serves it at, or
 * null when none does. `directories` are the directories the sweep meets, sorted: the build directory (`.`) and
 * every directory under it, a link to one included, even one it doesn't list, as a loop or because it can't. A
 * directory that can't be listed, or a symbolic link whose target can't be reached (`link`), is named in `unreadable`,
 * with why, and whether a mapping serves its path or a path under it (`served`); the files under it are missing.
 */
export interface Listing {
  files: { path: string; url: string | null }[]
  directories: string[]
  unreadable: { path: string; detail: string; link: boolean; served: boolean }[]
}

export interface SourceStore {
  /**
   * Reads a URL: a local file when a mapping covers it (the longest prefix wins), otherwise through the fetcher, as
   * `request` asks for it. A `data:` URL holds its bytes, and is never fetched (§2 Other script URLs).
   */
  read(url: string, request: FetchRequest): Promise<ReadResult>
  /** Reads a build-relative file, such as an entry document, that has the URL `url`. */
  readFile(path: string, url: string): Promise<ReadResult>
  /** Whether a URL mapping covers a URL, so that `read` reads it from the build directory rather than the fetcher. */
  isMapped(url: string): boolean
  /** Whether a URL mapping's URL lies under a URL, as `https://app.example/static/` lies under `https://app.example/`. */
  mapsUnder(url: string): boolean
  /**
   * The build-relative path a URL mapping reads `url` from (the longest prefix wins), or null when no mapping covers it
   * or its path is malformed or lies outside the build directory.
   */
  buildPath(url: string): string | null
  /**
   * The wall-clock facts of every fetch so far, by requested URL: the report's `run.retrievals`. A URL the fetcher
   * skipped offline was never fetched, so it has none, and nor has one the safety floor refused before any response.
   * A URL read twice keeps the facts of its first fetch.
   */
  retrievals(): Record<string, RunRetrieval>
  /**
   * Lists every regular file in the build directory, with the URL a mapping serves it at. When several mappings serve
   * it, the one with the most specific directory wins, then the URL first in code-unit order. Symbolic links to files
   * and directories are followed, wherever they lead, and a file reached through one has the path of the link. A
   * directory whose real path is that of a directory it lies in is a loop, and is not listed again. A dangling link or
   * a link cycle leads to nothing, and gives nothing; a link whose target can't be reached is `unreadable` (§2 Sweep).
   * The directories it walks are listed too, since a directory at a source map's path is there (§2 Source maps).
   */
  list(): Promise<Listing>
  /**
   * Lists the source-map directory declared as `dir` (§2 Source maps), as `list()` lists the build directory: it
   * follows symbolic links to files and directories, with loop protection by real path, and a dangling link, a link
   * cycle, a directory it can't list and a link whose target it can't reach give nothing, so the files behind them are
   * missing. It is `unreadable` only when the directory itself can't be listed: it is missing, is no directory, or its
   * entries can't be read.
   */
  listSourceMaps(dir: string): Promise<SourceMapListing>
  /**
   * What the build-relative path `path` leads to, following symbolic links: its device and inode, which two spellings of
   * one file share (§2 Source maps), or null when nothing can be found there or it lies outside the build directory.
   */
  buildIdentity(path: string): Promise<string | null>
  /** Reads the file at `path`, relative to the source-map directory declared as `dir`. */
  readSourceMap(dir: string, path: string): Promise<SourceMapRead>
  /**
   * What the path `path`, relative to the source-map directory declared as `dir`, leads to, following symbolic links:
   * its device and inode, which two spellings of one file share (§2 Source maps), or null when nothing can be found
   * there.
   */
  sourceMapIdentity(dir: string, path: string): Promise<string | null>
}

/**
 * A source-map directory's regular files and its directories, by POSIX path relative to it, each sorted, or why it
 * can't be listed. The directories are the directory itself (`.`) and every one under it the listing meets, a link to
 * one included, even one it doesn't list as a loop, but not one it can't list.
 */
export type SourceMapListing =
  | { status: 'ok'; files: string[]; directories: string[] }
  | { status: 'unreadable'; detail: string }

/** The bytes of a file in a source-map directory, or why they can't be read. */
export type SourceMapRead = { status: 'ok'; bytes: Uint8Array } | { status: 'unreadable'; detail: string }

export function createSourceStore(options: {
  buildDir: string
  mappings: Mapping[]
  fetcher: Fetcher
  /** The wall clock, read when each fetch finishes. */
  now: () => Date
  /** The source-map directories (§2 Source maps): each one's absolute path, by its name as declared. */
  sourceMapDirs?: ReadonlyMap<string, string>
}): SourceStore {
  const { buildDir, mappings, fetcher, now, sourceMapDirs = new Map<string, string>() } = options
  // The longest matching prefix wins (§16). Config rejects two mappings for one prefix.
  const byLength = [...mappings].sort((a, b) => b.url.length - a.url.length)
  const fetches = new Map<string, RunRetrieval>()

  async function readBuildFile(path: string, url: string): Promise<ReadResult> {
    const normalized = posix.normalize(path)
    if (isOutside(normalized)) return unreadable(url, normalized, 'outside the build directory')
    try {
      const bytes = await readFile(join(buildDir, normalized))
      return { status: 'ok', url, path: normalized, bytes, retrieval: buildFileRetrieval(url, 'ok'), sourceMap: null }
    } catch (error) {
      return unreadable(url, normalized, errorCode(error))
    }
  }

  async function fetchRemote(url: string, request: FetchRequest): Promise<ReadResult> {
    const result = await fetcher.fetch(url, request)
    if (result.status === 'offline-skipped') {
      return { status: 'offline-skipped', url, retrieval: remoteRetrieval(url, result.status, null, 'none') }
    }
    const { response } = result
    if (!fetches.has(url) && (result.status !== 'remote-refused' || response !== null)) {
      fetches.set(url, {
        fetchedAt: now().toISOString(),
        etag: response?.etag ?? null,
        lastModified: response?.lastModified ?? null,
      })
    }
    const sri = result.status === 'fetch-failed' ? 'none' : (result.sri ?? 'none')
    const retrieval = remoteRetrieval(url, result.status, response, sri)
    if (result.status === 'ok') {
      return { status: 'ok', url, path: null, bytes: result.bytes, retrieval, sourceMap: result.response.sourceMap }
    }
    return { status: result.status, url, detail: result.detail, retrieval }
  }

  /** The URL without its query and fragment, and the mapping that covers it, if any. */
  function mapped(url: string): { bare: URL; mapping: Mapping | undefined } {
    const bare = new URL(url)
    bare.search = ''
    bare.hash = ''
    return { bare, mapping: byLength.find((candidate) => bare.href.startsWith(candidate.url)) }
  }

  return {
    readFile: readBuildFile,
    isMapped: (url) => mapped(url).mapping !== undefined,
    mapsUnder: (url) => mappings.some((mapping) => mapping.url.startsWith(url)),
    async read(url, request) {
      if (url.startsWith('data:')) return readDataUrl(url, request)
      const { mapping } = mapped(url)
      if (mapping === undefined) return fetchRemote(url, request)
      // The path `buildPath` gives, so that the path read is the path discovery judges.
      const path = pathOf(url)
      if (path === undefined) return unreadable(url, mapping.dir, 'malformed percent-encoding in the URL path')
      return readBuildFile(path, url)
    },
    retrievals: () => Object.fromEntries(fetches),
    buildPath(url) {
      const path = pathOf(url)
      return path === undefined || isOutside(path) ? null : path
    },
    async list() {
      const listing: Listing = { files: [], directories: ['.'], unreadable: [] }
      await walkTree(buildDir, {
        file: (path) => listing.files.push({ path, url: urlOf(path) }),
        directory: (path) => listing.directories.push(path),
        // A directory the sweep can't list, or a link whose target it can't reach. A link may lead to a file, so a
        // mapping that serves its own path serves it too.
        unreachable: (path, error, link) =>
          listing.unreadable.push({
            path,
            detail: errorCode(error),
            link,
            served: (link && urlOf(path) !== null) || servesUnder(path),
          }),
      })
      listing.files.sort(byPath)
      listing.directories.sort()
      listing.unreadable.sort(byPath)
      return listing
    },
    async listSourceMaps(dir) {
      const files: string[] = []
      const directories = new Set<string>(['.'])
      let failed: unknown = undefined
      await walkTree(sourceMapDirectory(dir), {
        file: (path) => files.push(path),
        directory: (path) => directories.add(path),
        // Only the directory itself failing to list makes it unreadable. What can't be reached under it gives nothing,
        // so the maps there don't pair, and a directory it can't list isn't held, as in the build directory (§2 Source
        // maps).
        unreachable: (path, error, link) => {
          if (path === '.') failed = error
          else if (!link) directories.delete(path)
        },
      })
      if (failed !== undefined) return { status: 'unreadable', detail: errorCode(failed) }
      const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
      return { status: 'ok', files: files.sort(order), directories: [...directories].sort(order) }
    },
    async readSourceMap(dir, path) {
      const normalized = posix.normalize(path)
      if (isOutside(normalized)) return { status: 'unreadable', detail: 'outside the source-map directory' }
      try {
        return { status: 'ok', bytes: await readFile(join(sourceMapDirectory(dir), normalized)) }
      } catch (error) {
        return { status: 'unreadable', detail: errorCode(error) }
      }
    },
    sourceMapIdentity: (dir, path) => identityUnder(sourceMapDirectory(dir), path),
    buildIdentity: (path) => identityUnder(buildDir, path),
  }

  /** The absolute path of the source-map directory declared as `dir`. */
  function sourceMapDirectory(dir: string): string {
    const path = sourceMapDirs.get(dir)
    if (path === undefined) throw new Error(`no source-map directory was declared as '${dir}'`)
    return path
  }

  /**
   * Whether a mapping serves a path under the build-relative directory `dir`: its own directory is under `dir`, or
   * `dir` is under it, and the URLs it gives the paths under the deeper of the two map back to them, which a longer
   * prefix may keep it from doing (§16). A longer prefix that claims only some names under the directory leaves the
   * others served.
   */
  function servesUnder(dir: string): boolean {
    return mappings.some((mapping) => {
      const own = directoryOf(mapping)
      const base = isWithin(dir, own) ? dir : isWithin(own, dir) ? own : undefined
      if (base === undefined) return false
      const rest = base === own ? '' : own === '.' ? `${base}/` : `${base.slice(own.length + 1)}/`
      const url = urlUnder(mapping, rest)
      const read = url === null ? undefined : pathOf(url.href)
      return read !== undefined && (posix.normalize(read).replace(/\/+$/, '') || '.') === base
    })
  }

  /**
   * The URL a build file is served at, or null when no mapping serves it. A mapping serves a file under its directory
   * when the URL it gives the file maps back to that file, which a longer prefix may keep it from doing (§16). When
   * several serve it, the one with the most specific directory wins, then the URL first in code-unit order, so that the
   * order of the mappings never matters.
   */
  function urlOf(path: string): string | null {
    const served: { url: string; depth: number }[] = []
    for (const mapping of mappings) {
      const dir = directoryOf(mapping)
      const rest = dir === '.' ? path : path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : undefined
      if (rest === undefined) continue
      const url = urlUnder(mapping, rest)
      if (url !== null && pathOf(url.href) === path) served.push({ url: url.href, depth: dir === '.' ? 0 : dir.length })
    }
    served.sort((a, b) => b.depth - a.depth || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    return served[0]?.url ?? null
  }

  /** The build-relative path a mapped URL reads, or undefined when no mapping covers it or its path is malformed. */
  function pathOf(url: string): string | undefined {
    const { bare, mapping } = mapped(url)
    if (mapping === undefined) return undefined
    try {
      return posix.normalize(posix.join(mapping.dir, decodeURIComponent(bare.href.slice(mapping.url.length))))
    } catch {
      return undefined
    }
  }
}

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

/** A mapping's build-relative directory, normalized, with no trailing slash: `.` for the build directory itself. */
const directoryOf = (mapping: Mapping) => posix.normalize(mapping.dir).replace(/\/+$/, '')

/** Whether the build-relative path `path` is the directory `dir` or lies under it. */
const isWithin = (path: string, dir: string) => dir === '.' || path === dir || path.startsWith(`${dir}/`)

/**
 * The URL `mapping` gives `rest`, a path under its directory, or null when that is no URL. What a URL would read as a
 * delimiter or a percent-encoding is escaped; the URL parser encodes the rest.
 */
function urlUnder(mapping: Mapping, rest: string): URL | null {
  const escaped = rest.replace(/[%?#\\]/g, (character) => encodeURIComponent(character))
  return URL.parse(`${mapping.url.endsWith('/') ? mapping.url : `${mapping.url}/`}${escaped}`)
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code ?? String(error)

/**
 * What a directory entry is: a regular file, a directory, or neither. A symbolic link is what it leads to (§2 Sweep),
 * and neither when it leads nowhere: its target is missing, or the links form a cycle. It throws when what the link
 * leads to can't be told, as when its target's directory can't be searched.
 */
async function kindOf(entry: Dirent, path: string): Promise<'file' | 'directory' | undefined> {
  if (!entry.isSymbolicLink()) return entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : undefined
  let target: Stats
  try {
    target = await stat(path)
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return undefined
    throw error
  }
  return target.isDirectory() ? 'directory' : target.isFile() ? 'file' : undefined
}

/** What `walkTree` reports: each regular file, each directory under the root, and what it can't reach. */
interface TreeVisitor {
  file(path: string): void
  /** A directory under the root, a link to one included, even one it doesn't list, as a loop or because it can't. */
  directory(path: string): void
  /** A directory that can't be listed (`.` for the root), or a symbolic link whose target can't be reached (`link`). */
  unreachable(path: string, error: unknown, link: boolean): void
}

/**
 * Walks the tree under the absolute directory `root`, as the sweep lists the build directory (§2 Sweep), naming each
 * entry by its POSIX path relative to `root`. Symbolic links to files and directories are followed, wherever they
 * lead, and an entry reached through one has the path of the link. A directory whose real path is that of a directory
 * it lies in is a loop, and is not listed again. A dangling link or a link cycle leads to nothing, and gives nothing.
 */
async function walkTree(root: string, visitor: TreeVisitor): Promise<void> {
  // Each directory to list, with the real paths of the directories it lies in, which a loop leads back to.
  const directories: { path: string; within: readonly string[] }[] = [{ path: '.', within: [] }]
  for (let directory = directories.pop(); directory !== undefined; directory = directories.pop()) {
    const { path: dir, within } = directory
    let real: string
    let entries: Dirent[]
    try {
      real = await realpath(join(root, dir))
      if (within.includes(real)) continue
      entries = await readdir(join(root, dir), { withFileTypes: true })
    } catch (error) {
      visitor.unreachable(dir, error, false)
      continue
    }
    for (const entry of entries) {
      const path = dir === '.' ? entry.name : `${dir}/${entry.name}`
      let kind: 'file' | 'directory' | undefined
      try {
        kind = await kindOf(entry, join(root, path))
      } catch (error) {
        visitor.unreachable(path, error, true)
        continue
      }
      if (kind === 'directory') {
        visitor.directory(path)
        directories.push({ path, within: [...within, real] })
      } else if (kind === 'file') visitor.file(path)
    }
  }
}

/**
 * What the path `path`, relative to the absolute directory `root`, leads to, following symbolic links: its device and
 * inode, or null when nothing can be found there or it lies outside `root`.
 */
async function identityUnder(root: string, path: string): Promise<string | null> {
  const normalized = posix.normalize(path)
  if (isOutside(normalized)) return null
  try {
    const { dev, ino } = await stat(join(root, normalized), { bigint: true })
    return `${dev}:${ino}`
  } catch {
    return null
  }
}

/** Whether a normalized build-relative path leads outside the build directory. */
const isOutside = (path: string) => isAbsolute(path) || path === '..' || path.startsWith('../')

/** A build file at `path`, for the URL `url`, that can't be read, and why. */
function unreadable(url: string, path: string, detail: string): ReadResult {
  return { status: 'unreadable', url, path, detail, retrieval: buildFileRetrieval(url, 'unreadable') }
}

/** The retrieval record of a build file: read through its URL mapping, with no redirects and no response headers. */
function buildFileRetrieval(url: string, status: 'ok' | 'unreadable'): Retrieval {
  return { status, requestedUrl: url, finalUrl: url, contentType: null, sri: 'none' }
}

/** The retrieval record of a remote URL, from what its fetch returned. */
function remoteRetrieval(url: string, status: RetrievalStatus, response: FetchedResponse | null, sri: Sri): Retrieval {
  const finalUrl = response?.finalUrl ?? null
  return { status, requestedUrl: url, finalUrl, contentType: response?.contentType ?? null, sri }
}

/**
 * A store that reads each thing once (§19 References only the resolver can see): a scan's rounds discover the artifact
 * graph again, and each round must see the bytes, fetches and listings the first one saw, so that a URL is fetched once
 * per scan and the rounds can't disagree.
 */
export function onceStore(store: SourceStore): SourceStore {
  const cache = new Map<string, Promise<unknown>>()
  const once = <T>(key: unknown[], read: () => Promise<T>): Promise<T> => {
    const id = JSON.stringify(key)
    let found = cache.get(id) as Promise<T> | undefined
    if (found === undefined) cache.set(id, (found = read()))
    return found
  }
  return {
    read: (url, request) => once(['read', url, request], () => store.read(url, request)),
    readFile: (path, url) => once(['readFile', path, url], () => store.readFile(path, url)),
    isMapped: (url) => store.isMapped(url),
    mapsUnder: (url) => store.mapsUnder(url),
    buildPath: (url) => store.buildPath(url),
    retrievals: () => store.retrievals(),
    list: () => once(['list'], () => store.list()),
    listSourceMaps: (dir) => once(['listSourceMaps', dir], () => store.listSourceMaps(dir)),
    buildIdentity: (path) => once(['buildIdentity', path], () => store.buildIdentity(path)),
    readSourceMap: (dir, path) => once(['readSourceMap', dir, path], () => store.readSourceMap(dir, path)),
    sourceMapIdentity: (dir, path) => once(['sourceMapIdentity', dir, path], () => store.sourceMapIdentity(dir, path)),
  }
}

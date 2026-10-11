// Discovery (§19, module 3): follows references from the entry documents, builds the artifact graph (§2) and pairs
// source maps. It parses syntax only, and reads bytes only through the source store it is given.

import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { html, parse, type DefaultTreeAdapterTypes } from 'parse5'
import type { Realm, SerializedCatalog } from '../../catalog.ts'
import type { GeneratedLocation } from '../analysis/index.ts'
import type {
  HtmlCounters,
  LimitationRecord,
  PairingMethod,
  SourceMapDirectoryCounts,
  SourceMapPairing,
  SweptFiles,
  UnreadMaps,
} from '../completeness/index.ts'
import type { Entry } from '../config/index.ts'
import { alternativeIntegrity, type FetchRequest, type Listing, type ReadResult, type Retrieval, type SourceStore } from '../source-store/index.ts'
import {
  emptyImportMap,
  mergeImportMaps,
  moduleIntegrity,
  parseImportMap,
  resolveSpecifier,
  type ImportMap,
  type ResolvedModule,
} from './lib/import-map.ts'
import { requests, type ModuleRequest, type Requests, type WorkerKind, type WorkerRequest } from './lib/requests.ts'
import { annotations, dataUrlText, debugIdKey, mapDebugId, rawMap, verification, type LineReading } from './lib/source-maps.ts'
import { sourceTypeBySyntax, sweptCode, workerMarkersAs, type WorkerMarker } from './lib/swept-code.ts'

/** A script artifact of the artifact graph (§2). */
export interface Artifact {
  url: string
  /** Build-relative POSIX path, for a local file; null for an inline script. */
  path: string | null
  /**
   * The content hash: `sha256:` and the hex digest of the artifact's bytes (an inline script's UTF-8 text); null when
   * its bytes could not be read, or were withheld because they don't match their integrity value (§17 Integrity).
   */
  hash: string | null
  /**
   * Where it is served from (§2): the build (`local-build`, through a URL mapping), the entry document itself
   * (`inline`), or elsewhere, on the entry document's origin (`same-origin`) or another (`cross-origin`).
   */
  origin: 'local-build' | 'same-origin' | 'cross-origin' | 'inline'
  /**
   * How it was found (§2): by following a reference, as a script the page's code injects (`injected`), or only by the
   * build-directory sweep.
   */
  discovery: 'reference' | 'injected' | 'sweep'
  /**
   * `module` for a module script: a `type=module` script, a `<link rel=modulepreload>`, what a module request (a
   * static or dynamic import, or a re-export) names, or a worker created with `type: "module"`. `script` for a classic
   * one. A file only a `<link rel=preload as=script>` names, or only preloads that disagree, and a worker created with
   * options that can't be read statically, are typed by their syntax, as a sweep-only file is (§2). A URL a page runs
   * both ways is an artifact each way.
   */
  sourceType: 'script' | 'module'
  /**
   * The realm it runs in, from how it was referenced (§2 Realm): `window` for what an entry document references, the
   * worker's realm for a worker script (`new Worker`, `new SharedWorker`, `navigator.serviceWorker.register`), and the
   * realm of the code that references it for an import or an `importScripts`. A URL referenced in two realms is an
   * artifact in each.
   */
  realm: Realm
  /**
   * How its realm is known (§2 Realm): from how it was referenced (`reference`), or assumed to be `window` because only
   * the sweep found it, only a `<link rel=preload as=script>` names it, or only the module requests of code whose realm
   * is assumed name it (`assumed`).
   */
  realmBasis: 'reference' | 'assumed'
  /**
   * The URL of what first references it in its realm (§2 parent or importer): the entry document whose element names
   * it, or the script or module that imports it or creates the worker. Null for an artifact only the sweep found.
   */
  parent: string | null
  /**
   * Its source map (§2 Source maps): the first candidate that verifies, found by the `SourceMap` header of a fetched
   * artifact, then its `sourceMappingURL` annotation, then a `<file>.map` sidecar, then a map in the build directory with
   * its `debugId`, then in each source-map directory, a map with its `debugId`, its annotation mirrored there, and its
   * sidecar mirrored there.
   */
  sourceMap: SourceMapPairing
  /**
   * The source map that verified, for attribution (§10), which reads it from its raw JSON: that JSON, and the line
   * reading of the artifact's text that verified it (§2 Verification). Null when none did. It isn't reported.
   */
  map: PairedMap | null
  /**
   * How many candidate maps failed verification against it (§2 Source maps), each counted `stale`: those before the
   * one that verified, or every one, when none did. A source-map directory's map verified only to count it, after one
   * already verified, is not counted.
   */
  staleCandidates: number
  /**
   * The maps it names, as a remote artifact, that weren't read (§17 Content types): refused by the safety floor, failed,
   * or a build file that exists but can't be read. They change counters only, never completeness.
   */
  unreadMaps: UnreadMaps
  /** How its bytes were retrieved (§17 What is recorded): whether they were read (`ok`), or why not. */
  retrieval: Retrieval
  /**
   * Whether a reference runs it. It does not when only preloads name it (`<link rel=preload as=script>` or `<link
   * rel=modulepreload>`), or module requests of files that don't run: a preload joins the artifact graph, but never
   * makes a file run (§19 HTML rules), and a module runs only when its importer does. Nor does it when only the sweep
   * found it.
   */
  runs: boolean
  /** The script's source text, when its bytes were read. */
  text: string | null
}

/**
 * A verified source map (§2 Source maps): its raw JSON, the line reading of the artifact that verified it, and `base`,
 * the build-relative path whose directory its relative sources resolve against (§10): the map's own path. A
 * source-map directory's map has its path inside the directory, as if the directory mirrored the build, however it
 * was paired, and a `data:` URL map has its script's path (§10 Roots with no shared place). Null for a fetched map,
 * which has no place in the build.
 */
export interface PairedMap {
  raw: unknown
  reading: LineReading
  base: string | null
}

export type { LineReading }

/** What discovery finds: the artifact graph, and what it could not follow (§13). */
export interface Discovered {
  /** Every artifact, in the order it was first found. */
  artifacts: Artifact[]
  limitations: LimitationRecord[]
  /** HTML content that is counted, not analyzed (§19 HTML rules). */
  html: HtmlCounters
  /** The build files the sweep found and did not analyze (§2 Sweep, §13 Counters), by path, sorted. */
  swept: SweptFiles
  /** What became of each source-map directory's maps (§13 Attribution block), in the order they were declared. */
  sourceMapDirectories: SourceMapDirectoryCounts[]
  /**
   * Each module request a script's code makes that resolves to a URL (§6 Module links): the realm and URL of the script
   * it is in, the entry document that followed it, whose import maps resolved it, its specifier, and the URL it names.
   * A sweep-only file's requests are recorded too, with no document, resolved against its URL with no import map: they
   * are followed (§2 Sweep), except that an import of another swept file leaves it the sweep's.
   */
  imports: ModuleImport[]
  /**
   * The artifacts that module requests name and no other reference runs, by realm and URL: no script element, worker
   * or other reference does, though a preload may name them. They are analyzed only as members of their importers' link
   * groups (§19 Link groups).
   */
  importedOnly: { realm: Realm; url: string }[]
  /**
   * The entry documents whose references other than module requests name each artifact, by realm and URL, in the order
   * of the entries: each runs it with its own import maps.
   */
  documents: { realm: Realm; url: string; documents: string[] }[]
  /**
   * Each remote chunk a loader's folded chunk URL names (§2, §19 References only the resolver can see): the realm, the
   * loader (its URL, and the URL it was fetched at when that isn't its URL) and the chunk's URL. A remote chunk joins
   * the link group of a loader that loads it, and no other group, through the registry it pushes into (§6 idiom 6).
   */
  remoteChunks: { realm: Realm; loader: { url: string; fetched?: string }; chunk: string }[]
}

/** A module request that resolves to a URL (`Discovered.imports`). */
export interface ModuleImport {
  realm: Realm
  document: string | null
  /** The importing script's URL, and the URL it was fetched at when that isn't its URL (§11). */
  from: { url: string; fetched?: string }
  specifier: string
  /** The module's URL, and the URL it is fetched at when that isn't its URL (§11). */
  to: { url: string; fetched?: string }
}

/** JavaScript MIME type essences (MIME Sniffing § JavaScript MIME type): a `script` of one of these types is classic. */
const javascriptTypes = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
])

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

/**
 * Finds the classic and module scripts each entry document runs, following the HTML rules of §19: its inline scripts,
 * and the files its `script[src]` elements name, resolved against the document's base URL. A file that only a
 * `<link rel=preload as=script>` or a `<link rel=modulepreload>` names joins the graph too, and does not run. It
 * counts the HTML content it does not analyze: classic `nomodule` scripts, inline event handlers and `javascript:`
 * URLs.
 *
 * Then it follows the module requests of every script it found, and of every module those name, in turn (§2): static
 * imports, re-exports and dynamic imports with a literal specifier, resolved through the document's import maps in
 * browser order (§2 Import maps). An inline module script's requests resolve through the maps before it in tree order,
 * and every other request through all of them. Each names a module, which runs when its importer does. A request with
 * an import attribute names no JavaScript module, and is not followed. A static import or re-export with an attribute a
 * browser doesn't support fails every module graph that contains it (§2 Import attributes): each root of such a graph
 * (a module script element, a dynamic import or a module worker) gives nothing, and nothing is followed through it
 * from a hint. A dynamic import whose specifier is not a literal, or whose options have a part that can't be read and
 * could decide whether it names a JavaScript module, and a specifier that doesn't resolve, such as a bare specifier no
 * import map maps, give an `unresolved-reference` record.
 *
 * It follows the worker scripts they load with a literal URL too (§2, §19 Discovery), where the realm has the function
 * that loads them: a `new Worker` is a dedicated worker, a `new SharedWorker` a shared worker, and a
 * `navigator.serviceWorker.register` a service worker, each in its own realm, and an `importScripts` loads a classic
 * script into its own worker. A service worker whose script falls outside every URL mapping, like a `<link
 * rel=modulepreload as=serviceworker>` outside every mapping, gives an `unresolved-reference` record instead. A
 * dedicated or shared worker's script on another origin than its creator's is not followed, as a browser won't run it,
 * and a `data:` worker's is code the page carries, as a `data:` script is.
 *
 * A file a `<link rel=preload as=script>` names that no running reference names, in any realm, is followed last, as the
 * syntax of the preload's own bytes says, in URL order. Its realm is assumed to be `window` when nothing else names it,
 * as it is for the modules it requests (§2 Files that don't run as referenced). One a running reference runs in another
 * realm has no window artifact. One whose code has worker markers gives a `realm-uncertain` record, as a file only the
 * sweep found does.
 *
 * A remote script is fetched with the integrity metadata its reference carries (§17 Integrity): a `script` or `link`
 * element's `integrity` attribute, or, for a module with none, its URL's entry in the document's import maps. A
 * fetched script's own references are fetched against the URL its bytes came from, after any redirects, though it
 * keeps the URL it was requested at. They are keyed, as artifacts, by the URL resolved against the script's own URL as
 * requested (its key URL), so a key doesn't change when a redirect target moves (§11 Remote URL normalization). One
 * fetched URL reached under two key URLs is an artifact of each, sharing the one fetch, and one key URL reached through
 * two fetched URLs is an artifact of each too, both analyzed, told apart by `retrieval.requestedUrl`.
 *
 * A `data:` URL is code the page carries (§2 Other script URLs): its script is an `inline` artifact of the referencing
 * realm, loaded as the reference loads it, unless a browser would refuse to run it, when it gives nothing, as a `data:`
 * service worker always does. A script URL with any other scheme but `http:` and `https:` (`javascript:`, `blob:`,
 * `file:`, `about:`, …) gives nothing wherever it appears.
 *
 * An entry document or a local script that can't be read gives an `unreadable` record, and a remote script that isn't
 * read gives an `offline-skipped`, `remote-refused`, `fetch-failed` or `sri-mismatch` one (§17 Outcomes); the script
 * is still an artifact. Each URL, and each inline script, is an artifact of its own, whatever bytes it shares with
 * another (§2 Artifacts): the scan analyzes identical bytes once, and gives each copy its findings.
 *
 * Last, it pairs each artifact with the first source map that verifies against it (§2 Source maps): one a fetched
 * artifact's `SourceMap` header names, then one its annotation names, then its sidecar in the build directory, then a
 * map there with its `debugId`. A map that fails verification is `stale`, and counted. A missing or broken map gives no
 * record: it is counted in the attribution block (§13), and never changes completeness. A map the annotation of a
 * local-build or inline artifact names, or its sidecar, that exists but can't be read gives an `unreadable` record. A
 * remote artifact's maps are fetched only here, after every script: each one the safety floor refuses, whose fetch
 * fails, or that is a build file that exists but can't be read, is only counted (§17, `unreadMaps`).
 * Then each source-map directory is searched, one at a time, in the order they were declared (`pairInDirectory`): one
 * that can't be listed gives an `unreadable` record, and one none of whose maps verifies against an artifact a
 * `source-maps-unpaired` record.
 */
export async function discover(input: {
  entries: readonly Entry[]
  store: SourceStore
  /**
   * The source-map directories (§2 Source maps), by their names as declared, in the order they are searched. The store
   * reads them.
   */
  sourceMaps?: readonly string[]
  /** The catalog, read for the names of event handlers and for the globals each realm has. */
  catalog: SerializedCatalog
  /**
   * The references only the resolver can see that earlier rounds found (§19 References only the resolver can see), in
   * URL order. Discovery follows them as it follows its own, so a round's artifact graph depends only on the set.
   */
  references?: readonly ResolvedReference[]
}): Promise<Discovered> {
  const graph: Graph = {
    store: input.store,
    catalog: input.catalog,
    eventHandlers: eventHandlers(input.catalog),
    byRealmUrl: new Map(),
    otherWay: new Map(),
    reads: new Map(),
    readLimitations: new Map(),
    integrities: new Map(),
    limitations: [],
    inlineCounts: new Map(),
    html: { nomodule: 0, inlineHandlers: 0 },
    noModuleElements: new Set(),
    visits: [],
    preloads: [],
    followed: new Set(),
    requests: new Map(),
    unresolved: new Set(),
    references: new Map(),
    markers: new Map(),
    fetched: new Map(),
    whole: new Set(),
    imports: new Map(),
    requested: new Set(),
    named: new Map(),
    ran: new Set(),
    pages: new Map(),
    pageOf: new Map(),
    importSites: new Map(),
    chunkSites: new Map(),
    workerSites: new Map(),
    remoteChunks: new Map(),
  }
  const resolved = new Set<ResolvedReference>()
  for (const reference of input.references ?? []) {
    // Each chunk load and worker URL the resolver found, by its site: discovery judges them where it finds the site.
    if (reference.kind === 'injected') continue
    const sites = reference.kind === 'worker' ? graph.workerSites : reference.load === 'import' ? graph.importSites : graph.chunkSites
    const site = importSite(reference.from, reference.location.start)
    const list = sites.get(site)
    if (list === undefined) sites.set(site, [reference])
    else list.push(reference)
    if (reference.kind === 'worker' || reference.load === 'import') resolved.add(reference)
  }
  for (const [index, entry] of input.entries.entries()) {
    const document = await input.store.readFile(entry.file, entry.url)
    if (document.status !== 'ok') {
      // A build file is never remote, so it is `ok` or `unreadable`.
      if (document.status === 'unreadable') graph.limitations.push(unreadable(document))
      continue
    }
    const tree = parse(decoder.decode(document.bytes))
    const fields = { entry, path: document.path, index, importMap: emptyImportMap, base: entry.url, resolved: [] }
    // A module graph fails or not as its requests resolve through all of the document's maps, which are known only
    // once its HTML has been walked, so a first walk merges them alone (§2 Import maps, Import attributes).
    const maps: Page = { ...fields, resolved: [], finalMap: emptyImportMap }
    await walk(graph, maps, tree, true)
    const page: Page = { ...fields, finalMap: maps.importMap }
    if (!graph.pages.has(entry.url)) graph.pages.set(entry.url, page)
    await walk(graph, page, tree)
  }
  // Every entry document's own references come first, then the modules they request, breadth first.
  let next = 0
  const followAll = async () => {
    while (next < graph.visits.length) await follow(graph, graph.visits[next++]!)
  }
  await followAll()
  // Then each file classic preloads name that no running reference names, in any realm, as its syntax says, and what
  // it requests, in URL order. Nothing a preload's visit requests runs, so the running references are all known now,
  // and the judgement doesn't depend on the order the preloads were found in, or the visits followed in.
  const running = runningUrls(graph)
  const preloadVisits: Visit[] = []
  for (const preload of graph.preloads) {
    const visit = await preloadVisit(graph, preload, running)
    if (visit !== undefined) preloadVisits.push(visit)
  }
  graph.visits.push(...preloadVisits.sort(byUrlAndPage))
  await followAll()
  // Then the references only the resolver can see whose code a reference found (§19), and what they reference, until
  // none is left whose code is known.
  const followResolved = async () => {
    while (await followReferences(graph, input.references ?? [], resolved)) await followAll()
  }
  await followResolved()
  dropRunElsewhere(graph, running)
  const swept = await sweep(graph)
  // Then each sweep-only file's own literal requests, as a preload-only file's are (§2 Sweep), and the resolver's
  // references from code they found. A swept file a reference has since given a realm is no standalone sweep.
  graph.visits.push(...sweepVisits(graph, input.entries.length))
  await followAll()
  await followResolved()
  dropSuperseded(graph)
  const { byRealmUrl, html } = graph
  // Why each artifact's bytes weren't read, as its latest read says: a reference may have read it again (`reference`).
  const unread = [...graph.readLimitations.values()].filter((record) => record !== null)
  const found = [...[...byRealmUrl].map(([key, artifact]) => asNamed(graph, key, artifact)), ...graph.otherWay.values()]
  const { artifacts, sourceMapDirectories } = await pairSourceMaps(graph, found, input.sourceMaps ?? [])
  const uncertain = artifacts.flatMap((artifact) => {
    const markers = assumedMarkers(graph, artifact)
    return markers.length > 0 ? [realmUncertain(graph, artifact, markers)] : []
  })
  sweptImports(graph)
  const importedOnly = [...graph.requested]
    .filter((key) => !graph.ran.has(key))
    .flatMap((key) => {
      const found = byRealmUrl.get(key)
      return found === undefined ? [] : [{ realm: found.realm, url: found.url }]
    })
  return {
    artifacts,
    limitations: [...graph.limitations, ...unread, ...uncertain],
    html,
    swept,
    sourceMapDirectories,
    imports: [...graph.imports.values()],
    importedOnly,
    documents: [...graph.named].flatMap(([key, documents]) => {
      const found = byRealmUrl.get(key)
      return found === undefined ? [] : [{ realm: found.realm, url: found.url, documents: [...documents] }]
    }),
    remoteChunks: [...graph.remoteChunks.values()],
  }
}

/**
 * A reference only the resolver can see (§19 References only the resolver can see), as a round found it: the realm of
 * the link group it was found in, the artifact whose code holds it (its URL, and the URL it was fetched at when that
 * isn't its URL), its kind, and its URL as the code builds it, unresolved.
 * - A `chunk` reference's `load` is how the load site loads it: a created script element's `src`, `importScripts` or
 *   `import()`. A `partial` record's URL is only the constant prefix of an alternative that doesn't fold ('' for none),
 *   which decides whether that chunk URL is local (§2).
 * - An `injected` reference is a script element's `src` (§2), with the element's `type` as it folds (absent when
 *   none is set, null when it doesn't fold) and its folded `integrity`, if any.
 * - A `worker` reference is a worker URL that isn't a literal, located at the call's URL argument.
 * A `partial` injected or worker record stands for one alternative that doesn't fold, located at `alternative`.
 */
export interface ResolvedReference {
  realm: Realm
  from: { url: string; fetched?: string }
  kind: 'chunk' | 'injected' | 'worker'
  url: string
  load?: 'element' | 'import-scripts' | 'import'
  partial?: true
  alternative?: GeneratedLocation
  /** For a `worker` site: its URL folds to no value, as when it throws (`new URL("x.js")`), so it loads nothing. */
  none?: true
  type?: string | null
  /** The integrity value code sets on the chunk's script element, when it folds (§17 Integrity). */
  integrity?: string
  /** For an `injected` reference: the constants its element's `integrity` may be, when each write folds. */
  integrityAlternatives?: string[]
  /** For an `injected` reference: its element's `noModule` is set (`yes`), or may be (`maybe`). */
  noModule?: 'yes' | 'maybe'
  location: GeneratedLocation
}

/** The key of an `import()` site: its artifact, and the start of its specifier. */
const importSite = (from: { url: string; fetched?: string }, start: number): string =>
  JSON.stringify([from.url, from.fetched ?? null, start])

/**
 * Whether the constant prefix `prefix` of a chunk URL that doesn't fold, resolved against `base`, is a local chunk URL
 * (§2): a prefix that resolves outside every mapping, with none under it, makes it remote; otherwise the loader's
 * origin decides, and an inline loader counts as local.
 */
function localChunk(graph: Graph, loader: Found, prefix: string, base: string): boolean {
  if (prefix !== '') {
    const parsed = URL.parse(prefix, base)
    if (parsed !== null && !graph.store.isMapped(parsed.href) && !graph.store.mapsUnder(parsed.href)) return false
  }
  return loader.origin === 'local-build' || loader.origin === 'inline'
}

/** The `unresolved-reference` (§13) of a chunk load site whose URL doesn't fold, in its loader's code. */
function unresolvedChunk(graph: Graph, loader: Found, { location }: ResolvedReference): void {
  const { url, path, hash } = loader
  addUnresolved(graph, {
    kind: 'unresolved-reference',
    artifact: { url, ...(path === null ? {} : { path }), ...(hash === null ? {} : { hash }) },
    location,
    detail: "a chunk loader's chunk URL that doesn't fold to a constant",
  })
}

/**
 * Follows each chunk reference the resolver found (§19) whose code's artifact is known, once: a created script
 * element's `src` in the window, resolved against the base URL of each entry document that names the loader, or the
 * loader's own URL when none does (§2), and an `importScripts` in a worker, against the loader's URL. A swept
 * loader's references are followed too, once the sweep has found it: swept artifacts that add references resume the
 * rounds (§19 The result doesn't depend on the rounds), and their chunks inherit its assumed basis. A chunk inside a
 * mapping is a classic script of the loader's realm, which only the loader's link group runs: no reference runs it on
 * its own. A swept file it names becomes its artifact. A remote chunk URL is followed the same way, fetched in `resolve`
 * mode with the integrity value the code sets on its element, if that folds (§17 Integrity), and `offline-skipped`
 * offline; it joins its loader's group (`Discovered.remoteChunks`). An alternative that doesn't fold is an
 * `unresolved-reference` at its load site, unless it is a local chunk URL (`localChunk`). A local chunk file the
 * build directory lacks gives no artifact and no record (`missingFile`). Whether any reference was followed.
 */
async function followReferences(
  graph: Graph,
  references: readonly ResolvedReference[],
  done: Set<ResolvedReference>,
): Promise<boolean> {
  let followed = false
  for (const resolved of references) {
    if (done.has(resolved)) continue
    const { realm, from, load } = resolved
    const key = at(realm, from.url, from.fetched)
    const loader = graph.byRealmUrl.get(key)
    if (loader === undefined) continue
    done.add(resolved)
    followed = true
    if (resolved.kind === 'injected') {
      await injectedReference(graph, resolved, key, loader)
      continue
    }
    // A worker URL is followed where discovery finds its call (`workerReference`).
    if (resolved.kind === 'worker') continue
    if ((load === 'element') !== (realm === 'window') || load === 'import') continue
    const own = graph.pageOf.get(key)
    const documents = load === 'element' ? [...(graph.named.get(key) ?? [])] : []
    const bases: [Page | undefined, string][] =
      documents.length > 0
        ? documents.map((document) => [graph.pages.get(document), graph.pages.get(document)?.base ?? document])
        : [[own, loader.retrieval.finalUrl ?? loader.url]]
    if (resolved.partial) {
      // An alternative that doesn't fold is an unresolved reference unless it is a local chunk URL, which the sweep
      // covers (§2).
      if (!bases.every(([, base]) => localChunk(graph, loader, resolved.url, base))) {
        unresolvedChunk(graph, loader, resolved)
      }
      continue
    }
    for (const [page, base] of bases) {
      const url = URL.parse(resolved.url, base)
      if (page === undefined || url === null || !scriptSchemes.has(url.protocol)) continue
      const chunk = at(realm, url.href)
      const how: How = {
        sourceType: 'script',
        runs: false,
        realm,
        ...(load === 'import-scripts' && { imported: true as const }),
        ...(loader.realmBasis === 'assumed' && { assumed: true as const }),
      }
      // A chunk file the build directory doesn't contain is a missing chunk (§6 Globals are not links), never
      // `unreadable`: the link group raises or counts it by the chunk's id. A file an element or an import names keeps its
      // record, since it reads through the same cache.
      if (await missingFile(graph, page, url, how)) continue
      if (graph.byRealmUrl.get(chunk)?.discovery === 'sweep') {
        graph.byRealmUrl.delete(chunk)
        graph.markers.delete(url.href)
      }
      const worker: WorkerScript | undefined =
        realm === 'window' ? undefined : { url: from.url, ...(from.fetched === undefined ? {} : { fetched: from.fetched }), sourceType: 'script' }
      await reference(graph, page, url, how, from.url, worker, resolved.integrity)
      if (!graph.store.isMapped(url.href) && graph.byRealmUrl.has(chunk)) {
        const record = { realm, loader: from, chunk: url.href }
        graph.remoteChunks.set(JSON.stringify(record), record)
      }
    }
  }
  return followed
}

/** Whether `url` is a local file the build directory doesn't contain (§13 `unreadable`). */
async function missingFile(graph: Graph, page: Page, url: URL, how: How): Promise<boolean> {
  if (!graph.store.isMapped(url.href)) return false
  const read = await readOnce(graph, page, url, how, '')
  return read?.limitation?.kind === 'unreadable' && ['ENOENT', 'ENOTDIR'].includes(read.limitation.detail)
}

/**
 * Follows an injected script the resolver found (§2 Injected scripts): a script element the window's code creates,
 * gives a `src` and inserts. Only the window has `document.createElement`, so a group of any other realm gives nothing,
 * and the script runs in the window with its realm known by reference, whatever its creator's basis. Its `src`
 * resolves against the base URL of each entry document that names or first followed its creator, or the creator's own
 * URL when none does, and the element's `type` decides how it loads, as an HTML element's does: one that doesn't
 * fold leaves it to the script's syntax, and one a browser doesn't run gives nothing. A folded `integrity` is
 * verified against each constant it may be (§17). A classic script whose `noModule` is set is not followed, as
 * HTML's `<script nomodule>` is: it is counted, and a local file it names is left to the sweep. One whose
 * `noModule` may be set, or whose type may be module, is followed and counted as possibly `nomodule`, and a
 * module script ignores the attribute. An alternative that doesn't fold is an `unresolved-reference` at that alternative. A swept
 * file it names becomes its artifact.
 */
async function injectedReference(graph: Graph, resolved: ResolvedReference, key: string, creator: Found): Promise<void> {
  if (resolved.realm !== 'window') return
  const typed = resolved.type === null ? null : typeOfScript(resolved.type, undefined)
  if (typed === undefined || typed === 'importmap') return
  if (resolved.noModule !== undefined && typed !== 'module') {
    // One count per element, whatever its sources and documents; a round may find it again.
    const element = JSON.stringify([resolved.from.url, resolved.from.fetched ?? null, resolved.location.start])
    if (!graph.noModuleElements.has(element)) {
      graph.noModuleElements.add(element)
      graph.html.nomodule++
    }
    if (resolved.noModule === 'yes' && typed === 'script') return
  }
  if (resolved.partial) {
    unresolvedReference(graph, creator, resolved.alternative ?? resolved.location, 'an injected script whose `src` is not a constant')
    return
  }
  const own = graph.pageOf.get(key)
  const documents = new Set(graph.named.get(key) ?? [])
  if (own !== undefined && graph.pages.get(own.entry.url) === own) documents.add(own.entry.url)
  const bases: [Page | undefined, string][] =
    documents.size > 0
      ? [...documents].map((document) => [graph.pages.get(document), graph.pages.get(document)?.base ?? document])
      : [[own, creator.retrieval.finalUrl ?? creator.url]]
  for (const [page, base] of bases) {
    const url = URL.parse(resolved.url, base)
    if (page === undefined || url === null || !scriptSchemes.has(url.protocol)) continue
    const at_ = at('window', url.href)
    if (graph.byRealmUrl.get(at_)?.discovery === 'sweep') {
      graph.byRealmUrl.delete(at_)
      graph.markers.delete(url.href)
    }
    const sourceType = typed ?? (await sourceTypeOf(graph, page, url, 'window', url))
    const how: How = { sourceType, runs: true, realm: 'window', injected: true }
    await reference(graph, page, url, how, resolved.from.url, undefined, injectedIntegrity(resolved))
  }
}

/** The integrity metadata an injected script is fetched with: each constant its `integrity` may be. */
function injectedIntegrity({ integrityAlternatives = [], integrity = '' }: ResolvedReference): string {
  return integrityAlternatives.length === 0 ? integrity : alternativeIntegrity(integrityAlternatives)
}

/**
 * A visit of each sweep-only file whose bytes were read, in URL order (§2 Sweep): its own literal requests are
 * followed as a preload-only file's are. Its imports inherit its assumed realm basis, and its worker URLs are ordinary
 * worker references. With no entry document, its own URL stands for one: its requests resolve against it, with no
 * import map, and it is the document a fetch is made for.
 */
function sweepVisits(graph: Graph, entries: number): Visit[] {
  const swept = [...graph.byRealmUrl.values()]
    .filter((found) => found.discovery === 'sweep' && found.text !== null)
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
  return swept.map(({ url, path, sourceType }, index) => {
    const page: Page = {
      entry: { file: path ?? url, url },
      path,
      index: entries + index,
      importMap: emptyImportMap,
      base: url,
      resolved: [],
      finalMap: emptyImportMap,
    }
    return { url, page, base: url, sourceType, runs: false, realm: 'window', assumed: true, swept: true }
  })
}

/** Whether only the sweep found the file at `url` (§2 Sweep). */
const isSwept = (graph: Graph, url: string): boolean => graph.byRealmUrl.get(at('window', url))?.discovery === 'sweep'

/**
 * Drops each swept file that a reference has since found, in any realm (§19 The result doesn't depend on the rounds):
 * a worker the sweep found as `window` is its worker artifact alone.
 */
function dropSuperseded(graph: Graph): void {
  const referenced = new Set<string>()
  for (const found of [...graph.byRealmUrl.values(), ...graph.otherWay.values()]) {
    if (found.discovery !== 'sweep' && found.path !== null) referenced.add(found.path)
  }
  for (const [key, found] of graph.byRealmUrl) {
    if (found.discovery !== 'sweep' || found.path === null || !referenced.has(found.path)) continue
    graph.byRealmUrl.delete(key)
    graph.markers.delete(found.url)
  }
}

/**
 * Records the module requests of each sweep-only file (§6 Module links): resolved against its URL with no import map,
 * since no document loads it. A swept file one names is linked into the file's group (§19).
 */
function sweptImports(graph: Graph): void {
  for (const found of graph.byRealmUrl.values()) {
    if (found.discovery !== 'sweep' || found.text === null) continue
    for (const request of followable(requestsOf(graph, found, found.sourceType).modules)) {
      const resolved = resolveSpecifier(emptyImportMap, request.specifier, found.url)
      if (!('error' in resolved)) {
        recordImport(graph, found.realm, null, { url: found.url }, request.specifier, { url: resolved.url.href })
      }
    }
  }
}

/**
 * Records a module request that resolves (`Discovered.imports`), unless the script's code already made it for that
 * document.
 */
function recordImport(
  graph: Graph,
  realm: Realm,
  document: string | null,
  from: ModuleImport['from'],
  specifier: string,
  to: ModuleImport['to'],
): void {
  const key = JSON.stringify([realm, document, from.url, from.fetched, specifier])
  if (!graph.imports.has(key)) graph.imports.set(key, { realm, document, from, specifier, to })
}

/** Records that a reference other than a module request names the artifact at `key` for `document`. */
function recordNamed(graph: Graph, key: string, document: string): void {
  const documents = graph.named.get(key)
  if (documents === undefined) graph.named.set(key, new Set([document]))
  else documents.add(document)
}

/**
 * The worker markers of an artifact whose realm is assumed (§2 Realm, §13 `realm-uncertain`): a sweep-only file's, read
 * as the sweep typed it, or those of a file only preloads, or code whose realm is assumed, name, in its code as it is
 * analyzed. None for an artifact whose realm a reference gives.
 */
function assumedMarkers(graph: Graph, { url, realmBasis, discovery, sourceType, text }: Artifact): WorkerMarker[] {
  if (realmBasis !== 'assumed' || text === null) return []
  return discovery === 'sweep' ? (graph.markers.get(url) ?? []) : workerMarkersAs(text, sourceType)
}

/**
 * An artifact as the references that name it make it (§2 Files that don't run as referenced). A file only `<link
 * rel=preload as=script>` names is analyzed like a sweep-only file: its source type comes from its syntax, and its realm
 * is assumed to be `window`. When only preloads name a file and they disagree, a classic one and a `modulepreload`, its
 * source type comes from its syntax too. A file only the module requests of code whose realm is assumed name, such as a
 * preload-only file's imports, inherits that realm basis. Any other reference decides as it found the file.
 */
function asNamed(graph: Graph, key: string, found: Found): Found {
  const kinds = graph.references.get(key)
  if (preloadsAlone(found, kinds)) {
    const sourceType = syntaxOf(found)
    return kinds.has('modulepreload') ? { ...found, sourceType } : { ...found, sourceType, realmBasis: 'assumed' }
  }
  return kinds !== undefined && assumedRealm(kinds) ? { ...found, realmBasis: 'assumed' } : found
}

/**
 * Whether preloads alone name a file (§2 Files that don't run as referenced): a classic preload names it, and so may a
 * `modulepreload`, but nothing runs it and no other reference names it. It decides the artifact's type and realm basis,
 * not whether the preload's syntax-typed visit happens (`preloadVisit`): an import that never runs
 * still makes the file a `module`.
 */
function preloadsAlone(found: Found, kinds: ReadonlySet<Naming> | undefined): kinds is Set<Hint> {
  return !found.runs && kinds !== undefined && kinds.has('preload') && !kinds.has('reference') && !kinds.has('assumed')
}

/**
 * Whether the references that name a file leave its realm assumed: only code whose realm is assumed requests it, and
 * perhaps a classic preload, which names no realm. No such reference runs a file.
 */
function assumedRealm(kinds: ReadonlySet<Naming>): boolean {
  return kinds.has('assumed') && !kinds.has('reference') && !kinds.has('modulepreload')
}

/** The source type of an artifact's code by its syntax (§2 Sweep): a `script` when its bytes weren't read. */
const syntaxOf = ({ text }: Pick<Found, 'text'>): 'script' | 'module' =>
  text === null ? 'script' : sourceTypeBySyntax(text)

/**
 * The syntax-typed visit that follows the file a classic preload names, when no running reference names it, in any
 * realm (§2 Files that don't run as referenced): even when a preload-only file imports it. It
 * reads the bytes of the preload's own fetch, whatever a module import of the same URL read, and its source type
 * comes from their syntax. Its module requests inherit the realm basis the file's artifact has: assumed, unless a
 * `modulepreload` or another reference whose realm is known names it. When a running reference runs the file, the
 * preload follows that reference and adds no visit of its own.
 */
async function preloadVisit(
  graph: Graph,
  preload: PreloadVisit,
  running: ReadonlySet<string>,
): Promise<Visit | undefined> {
  const key = at(preload.realm, preload.url, preload.fetched)
  const found = graph.byRealmUrl.get(key)
  const kinds = graph.references.get(key)
  if (found === undefined || kinds === undefined || running.has(preload.url)) return undefined
  const { preloadIntegrity, ...visit } = preload
  // The store read it once for the preload, so reading it again as the preload fetched it gives that read.
  const own = await readOnce(graph, visit.page, new URL(visit.fetched ?? visit.url), visit, preloadIntegrity)
  if (own === null) return undefined
  const { hash, text, retrieval, path, origin } = own
  const read = { hash, text, retrieval, path, origin }
  const sourceType = syntaxOf(own)
  const known = kinds.has('modulepreload') || kinds.has('reference')
  return { ...visit, sourceType, read, ...(!known && { assumed: true as const }) }
}

/** The URLs a running reference runs, in any realm (§2 Files that don't run as referenced). */
function runningUrls(graph: Graph): Set<string> {
  const artifacts = [...graph.byRealmUrl.values(), ...graph.otherWay.values()]
  return new Set(artifacts.flatMap(({ url, runs }) => (runs ? [url] : [])))
}

/** Orders visits by URL, then by entry document. */
function byUrlAndPage(a: Visit, b: Visit): number {
  return a.url < b.url ? -1 : a.url > b.url ? 1 : a.page.index - b.page.index
}

/**
 * Drops the window artifact of each file that only classic preloads name in the window, when a running reference runs
 * it in another realm (§2 Files that don't run as referenced): the preload follows that reference, and
 * adds no artifact or record of its own. A classically preloaded `/worker.js` that running code starts as a worker is
 * analyzed only as the worker.
 */
function dropRunElsewhere(graph: Graph, running: ReadonlySet<string>): void {
  for (const { realm, url, fetched } of graph.preloads) {
    const key = at(realm, url, fetched)
    const kinds = graph.references.get(key)
    if (!running.has(url) || graph.byRealmUrl.get(key)?.runs !== false) continue
    if (kinds === undefined || [...kinds].some((kind) => kind !== 'preload')) continue
    graph.byRealmUrl.delete(key)
    graph.readLimitations.delete(key)
    graph.references.delete(key)
  }
}

/**
 * A `realm-uncertain` record (§13) for an artifact whose realm is assumed to be `window` though its code has worker
 * markers (§2 Realm): one only the sweep found, or only preloads, or code whose realm is assumed, name. It is located at
 * the first marker, and its detail says why the realm is assumed, and names each kind of marker once, where it first
 * appears.
 */
function realmUncertain(graph: Graph, artifact: Artifact, markers: readonly WorkerMarker[]): LimitationRecord {
  const { url, path, hash, text } = artifact
  const first = new Map<WorkerMarker['marker'], WorkerMarker>()
  for (const marker of markers) if (!first.has(marker.marker)) first.set(marker.marker, marker)
  const named = [...first.values()].map(({ marker, start, end }) => {
    const { line, column } = locate(text ?? '', start, end)
    const what = marker === 'importScripts' ? 'top-level `importScripts`' : `\`self.addEventListener("${marker}")\``
    return `${what} at ${line}:${column}`
  })
  const [{ start, end }] = markers as [WorkerMarker]
  const because = assumedBecause(graph, artifact)
  return {
    kind: 'realm-uncertain',
    artifact: { url, ...(path === null ? {} : { path }), ...(hash === null ? {} : { hash }) },
    location: locate(text ?? '', start, end),
    detail: `${because}, so its realm is assumed to be window, but it has worker markers: ${named.join(', ')}`,
  }
}

/** Why an artifact's realm is assumed (§2): what alone found or names it. */
function assumedBecause(graph: Graph, { discovery, realm, url, retrieval }: Artifact): string {
  if (discovery === 'sweep') return 'only the sweep found it'
  return graph.references.get(at(realm, url, retrieval.requestedUrl ?? url))?.has('assumed')
    ? 'only code whose realm is assumed imports it'
    : 'only a `<link rel=preload as=script>` names it'
}

/**
 * Sweeps the build directory (§2 Sweep): every JavaScript file no reference found, in any realm, is an artifact too,
 * marked `sweep`, because chunk loaders compute URLs that discovery can't see. So is a file that only a script element
 * the browser doesn't run names (`nomodule`, an ignored `type`, or a `<script src>` in `<template>` or `<noscript>`).
 * It is found at the URL a mapping serves it at, and its realm is assumed to be `window`. A JavaScript or WebAssembly
 * file no mapping serves is excluded, which keeps server bundles out of the scan, and a WebAssembly file a mapping
 * serves is counted in `nonJs`. Every other file a mapping serves, and no reference found, is counted in `otherFiles`,
 * and not analyzed. Remote artifacts are never swept.
 */
async function sweep(graph: Graph): Promise<SweptFiles> {
  const { byRealmUrl, store } = graph
  const excluded: string[] = []
  let nonJs = 0
  const listing = await listed(graph)
  // A directory that can't be listed, or a link whose target can't be reached, may hold files the scan should analyze,
  // but only when a mapping serves its path or a path under it (§13 `unreadable`).
  for (const { path, detail, link, served } of listing.unreadable) {
    if (!served) continue
    const what = link ? "the sweep can't reach the link's target" : "the sweep can't list the directory"
    graph.limitations.push({ kind: 'unreadable', artifact: { path }, detail: `${what}: ${detail}` })
  }
  const found = new Set([...byRealmUrl.values()].flatMap(({ path }) => (path === null ? [] : [path])))
  let otherFiles = 0
  for (const { path, url } of listing.files) {
    if (found.has(path)) continue
    const kind = fileKind(path)
    if (kind === undefined) {
      if (url !== null) otherFiles++
    } else if (url === null) excluded.push(path)
    else if (kind === 'wasm') nonJs++
    else {
      const result = await store.readFile(path, url)
      const fields = { url, path, origin: 'local-build' as const, ...sweptFields }
      if (result.status === 'ok') {
        const text = decoder.decode(result.bytes)
        const { sourceType, markers } = sweptCode(text)
        byRealmUrl.set(at('window', url), { ...read(result.bytes, result.retrieval, text), ...fields, sourceType })
        if (markers.length > 0) graph.markers.set(url, markers)
      } else if (result.status === 'unreadable') {
        // A build file is `ok` or `unreadable`.
        byRealmUrl.set(at('window', url), { ...notRead(result), ...fields, sourceType: 'script' })
        graph.limitations.push(unreadable(result))
      }
    }
  }
  // The listing is sorted by path, so `excluded` is too.
  return { excluded, nonJs, otherFiles }
}

/** The fields of an artifact only the sweep found: it has no parent, no reference runs it, and its realm is assumed. */
const sweptFields = {
  discovery: 'sweep',
  realm: 'window',
  realmBasis: 'assumed',
  parent: null,
  runs: false,
} as const satisfies Partial<Artifact>

/**
 * What the sweep takes a build file for, by its extension, ignoring ASCII case: JavaScript (`.js`, `.mjs` or `.cjs`),
 * WebAssembly (`.wasm`), or neither.
 */
function fileKind(path: string): 'js' | 'wasm' | undefined {
  const extension = asciiLowercase(posix.extname(path))
  return extension === '.wasm' ? 'wasm' : ['.js', '.mjs', '.cjs'].includes(extension) ? 'js' : undefined
}

/** An artifact as discovery finds it, before its source map is paired. */
type Found = Omit<Artifact, 'sourceMap' | 'map' | 'staleCandidates' | 'unreadMaps'>

/**
 * How an artifact's source map paired: the pairing and the map, how many candidates failed verification, and the maps
 * it names that weren't read.
 */
type Paired = Pick<Artifact, 'sourceMap' | 'map' | 'staleCandidates' | 'unreadMaps'>

/** The artifact graph as discovery builds it. */
interface Graph {
  store: SourceStore
  /** The catalog, read for the globals each realm has. */
  catalog: SerializedCatalog
  /** The names of event handler content attributes. */
  eventHandlers: ReadonlySet<string>
  /** Every artifact found, by realm and URL (`at`), in the order it was first found. */
  byRealmUrl: Map<string, Found>
  /**
   * The artifacts of the files a page runs both as a classic script and as a module, in the way it runs them second (§2
   * Files that don't run as referenced), by realm and URL (`at`): the one in `byRealmUrl` is the other way.
   */
  otherWay: Map<string, Found>
  /**
   * What reading each URL gave, so that a URL referenced in several realms is read once: a local file by its URL, and a
   * remote URL by destination, integrity metadata and URL (as JSON), since the safety floor judges each destination
   * apart (§17 Content types), and each integrity value is checked apart (§17 Integrity).
   */
  reads: Map<string, Read | null>
  /**
   * The record of why each artifact's bytes weren't read, or null when they were, by realm and URL (`at`), and, for the
   * second way a page runs a URL (`otherWay`), by that key and its source type (as JSON).
   */
  readLimitations: Map<string, LimitationRecord | null>
  /** The integrity metadata each artifact's bytes were last read with, keyed as `readLimitations` is. */
  integrities: Map<string, string>
  limitations: LimitationRecord[]
  /**
   * How many inline `script` elements, whatever their type, the entry documents with each URL have had so far. They
   * number inline scripts together, so that two documents at one URL never name two scripts alike.
   */
  inlineCounts: Map<string, number>
  html: HtmlCounters
  /** The injected script elements already counted in `html.nomodule`, as the elements' sites. */
  noModuleElements: Set<string>
  /** The scripts whose module requests are to be followed, in the order they were found. */
  visits: Visit[]
  /**
   * What each `<link rel=preload as=script>` names, in the order found. Its file is followed only when no running
   * reference names it, in any realm (§2 Files that don't run as referenced), which is known once every running
   * reference is followed.
   */
  preloads: PreloadVisit[]
  /**
   * The visits already followed, by URL, entry document, source type, `runs`, realm basis, realm and worker, and
   * whether they parse a classic preload's own bytes.
   */
  followed: Set<string>
  /** The requests of each artifact's bytes, parsed with each source type, by `sourceType hash`. */
  requests: Map<string, Requests>
  /** The `unresolved-reference` records raised so far, as JSON. */
  unresolved: Set<string>
  /**
   * The kinds of reference that name each artifact, by realm and URL (`at`): a `hint` (§2 Files that don't run as
   * referenced), a module request of code whose realm is `assumed`, or any other `reference`.
   */
  references: Map<string, Set<Naming>>
  /** The worker markers in the code of each artifact only the sweep found, by URL, when it has any. */
  markers: Map<string, WorkerMarker[]>
  /**
   * Each fetched URL, by the URL it was requested at: the entry document it was first fetched for, which a fetch of its
   * source map is judged by too (§17 Schemes), and the response header that names its map, if any.
   */
  fetched: Map<string, { document: string; header: string | null }>
  /**
   * The modules, by the key `wholeKey` gives them, whose static module graph is known not to fail (§2 Import
   * attributes): no module in it has a static import with an unsupported attribute.
   */
  whole: Set<string>
  /** The module requests that resolve (`Discovered.imports`), by realm, document, script URL and specifier. */
  imports: Map<string, ModuleImport>
  /** The artifacts module requests name, by realm and URL (`at`). */
  requested: Set<string>
  /** The entry documents whose other references name each artifact, by realm and URL (`at`). */
  named: Map<string, Set<string>>
  /** The artifacts a reference other than a module request runs, by realm and URL (`at`). */
  ran: Set<string>
  /** Each entry document's page, by its URL: the first entry with that URL. */
  pages: Map<string, Page>
  /** The page of the first visit that followed each artifact, by realm and URL (`at`). */
  pageOf: Map<string, Page>
  /**
   * The chunk loads at `import()` expressions the resolver found (§19), by the artifact and the start of the import's
   * specifier (`importSite`): what decides whether a specifier that isn't a literal is a local chunk URL (§2).
   */
  importSites: Map<string, ResolvedReference[]>
  /** The other chunk loads the resolver found, by their site (`importSite`): a created element's or `importScripts`. */
  chunkSites: Map<string, ResolvedReference[]>
  /**
   * The worker URLs that aren't literals the resolver folded (§2 Computed URLs), by their site (`importSite`):
   * each constant alternative, and each alternative that doesn't fold (`partial`).
   */
  workerSites: Map<string, ResolvedReference[]>
  /** The remote chunks loaders' folded chunk URLs name (`Discovered.remoteChunks`), by the record as JSON. */
  remoteChunks: Map<string, Discovered['remoteChunks'][number]>
  /** The build directory's files (§2 Sweep), listed when first needed. */
  listing?: Promise<Listing>
  /**
   * What the paths the build directory's listing holds lead to (`buildIdentity`), found when a named map is first not
   * held as spelled (§2 Source maps).
   */
  heldIdentities?: Promise<Set<string>>
  /** The source maps of the build directory that have a `debugId`, by it in ASCII lowercase; listed when first needed. */
  debugIdMaps?: Promise<Map<string, Candidate[]>>
}

/**
 * An entry document, as discovery follows its references: its `--entry` and build-relative path, where it is among the
 * entries, its import maps, merged in tree order, its base URL, which the first `<base href>` sets, and the specifiers
 * its inline module scripts resolved while its HTML was walked (§2 Import maps). An inline module script's requests
 * resolve through the maps before it, when the walk reaches it. Every other module request of the document's window
 * resolves through all of its maps, once its HTML has been walked.
 */
interface Page {
  entry: Entry
  path: string | null
  index: number
  importMap: ImportMap
  base: string
  resolved: ResolvedModule[]
  /** All of the document's import maps, merged: its import map once its HTML has been walked. */
  finalMap: ImportMap
}

/**
 * A script to follow the requests of, as one entry document's reference found it: with the source type, `runs` and
 * realm of that reference, and the base URL its module specifiers resolve against when it has no response URL: for an
 * inline script, its document's base URL (a file's is the URL it was read from, after any redirects). In a worker
 * realm, `worker` is the worker's script: the URL its script was read from is the base URL the worker's own references
 * to workers and `importScripts` resolve against, and its type decides whether `importScripts` works.
 */
interface Visit extends How {
  url: string
  /** The URL the script was fetched at, when it isn't `url`, its key URL (§11). */
  fetched?: string
  page: Page
  base: string
  worker?: WorkerScript
  /**
   * The import map an inline module script's requests resolve through: its document's maps before it in tree order
   * (§2 Import maps). Every other script's requests resolve through all of the document's maps.
   */
  importMap?: ImportMap
  /**
   * The bytes a classic preload's syntax-typed visit parses: those of the preload's own fetch, whatever a module import
   * of the same URL read (§2 Files that don't run as referenced). Other visits parse their artifact's.
   */
  read?: Pick<Found, 'hash' | 'text' | 'retrieval' | 'path' | 'origin'>
  /** Whether it follows a sweep-only file's own requests (§2 Sweep). */
  swept?: true
}

/** What a `<link rel=preload as=script>` names, with the integrity metadata it fetched the file with. */
interface PreloadVisit extends Visit {
  preloadIntegrity: string
}

/**
 * A worker's script: its URL, the URL it was fetched at when that isn't its URL (its key URL, §11), and whether the
 * worker is a classic or a module worker.
 */
interface WorkerScript {
  url: string
  fetched?: string
  sourceType: 'script' | 'module'
}

/**
 * How a reference found a script: the source type it loads the script as, whether it runs it, and in which realm. A
 * `<link rel=preload as=script>` or a `<link rel=modulepreload>` is a `hint`: it only says how the browser would fetch
 * the file. A script `importScripts` loads is `imported`, which a browser fetches more strictly than a worker's own
 * script from a `data:` URL (`FetchRequest`). A module request of code whose realm is assumed to be `window` is
 * `assumed`, as the realm it names is (§2 Files that don't run as referenced).
 */
interface How {
  sourceType: 'script' | 'module'
  runs: boolean
  realm: Realm
  hint?: Hint
  imported?: true
  assumed?: true
  /** Whether a module request names the script (`Discovered.importedOnly`). */
  request?: true
  /** Whether the page's code injects the script (§2 Injected scripts): its artifact is discovered `injected`. */
  injected?: true
}

/** A preload that names a file (§2 Files that don't run as referenced): a classic `preload` or a `modulepreload`. */
type Hint = 'preload' | 'modulepreload'

/**
 * A kind of reference that names a file: a `hint`, a module request of code whose realm is `assumed`, or any other
 * `reference`.
 */
type Naming = Hint | 'assumed' | 'reference'

/**
 * An artifact's key in the graph: its realm and URL, and the URL it was fetched at when that isn't its URL. Code a
 * redirected script references is keyed by one URL and fetched at another (§11), and one key URL reached through two
 * fetched URLs is an artifact of each. A URL holds no space.
 */
const at = (realm: Realm, url: string, fetched = url): string =>
  fetched === url ? `${realm} ${url}` : `${realm} ${url} ${fetched}`

/**
 * The artifact at `key` (its realm and URL) that a reference loading it as `sourceType` found: the one the page runs
 * that way, when it runs it both ways, and otherwise the one there is.
 */
function artifactAs(graph: Graph, key: string, sourceType: 'script' | 'module'): Found | undefined {
  const other = graph.otherWay.get(key)
  return other !== undefined && other.sourceType === sourceType ? other : graph.byRealmUrl.get(key)
}

/**
 * Follows the requests of a script. Each module request names a module, which joins the graph in the script's realm,
 * with the script as its parent, and runs when the script does. Each worker request the realm can make loads a worker
 * script, the same way. A module request of code whose realm is assumed names a module whose realm is assumed too. A
 * script is followed once per entry document, source type, `runs`, realm basis, realm and worker.
 */
async function follow(graph: Graph, visit: Visit): Promise<void> {
  const { url, fetched, page, sourceType, runs, realm, worker, assumed } = visit
  const own = visit.read === undefined ? '' : 'preload'
  const followed = [url, fetched, page.index, sourceType, runs, assumed, realm, worker?.url, worker?.fetched]
  const key = [...followed, worker?.sourceType, own].join(' ')
  if (graph.followed.has(key)) return
  graph.followed.add(key)
  const found = artifactAs(graph, at(realm, url, fetched), sourceType)
  if (found === undefined) return
  if (!graph.pageOf.has(at(realm, url, fetched))) graph.pageOf.set(at(realm, url, fetched), page)
  // A classic preload's syntax-typed visit parses the bytes of the preload's own fetch.
  const artifact = visit.read === undefined ? found : { ...found, ...visit.read }
  const requested = requestsOf(graph, artifact, sourceType)
  const { modules, workers } = requested
  // A worker has its own import map, which no script element can add to, so it is always empty (HTML § Import maps).
  const importMap = realm === 'window' ? (visit.importMap ?? page.importMap) : emptyImportMap
  // A fetched script's base URL is its response's URL, after any redirects (HTML § Fetching scripts), though the
  // artifact keeps the URL it was requested at. An inline script's is its document's. What it references is fetched
  // against that base, but keyed by the URL resolved against the script's own key URL (`visit.base`), so a key doesn't
  // change when a redirect target moves (§11 Remote URL normalization, §17 What is recorded).
  const base = artifact.retrieval.finalUrl ?? visit.base
  const keyBase = visit.base
  // Nothing is followed through a module graph that fails (§2 Import attributes): a hint still names its own file.
  if (sourceType === 'module' && (await modulesFail(graph, page, realm, requested, importMap, base))) return
  for (const request of modules) {
    // A service worker rejects every dynamic import (HTML § HostLoadImportedModule).
    if (request.dynamic && realm === 'service-worker') continue
    // An ESM chunk loader's `import()` loads each chunk URL it folds to (§2, §6 idiom 6): each is followed as a
    // literal dynamic import of it would be.
    let specifiers: string[]
    const chunks = request.specifier === null
    if (request.specifier === null) {
      const loads = graph.importSites.get(importSite({ url, ...(fetched === undefined ? {} : { fetched }) }, request.start))
      if (loads === undefined) {
        unresolvedReference(graph, artifact, request, 'a dynamic import whose specifier is not a literal')
        continue
      }
      // An alternative that doesn't fold is an unresolved reference, unless it is a local chunk URL, which the sweep
      // covers (§2).
      if (loads.some(({ url: prefix, partial }) => partial && !localChunk(graph, artifact, prefix, base))) {
        unresolvedReference(graph, artifact, request, "a chunk loader's chunk URL that doesn't fold to a constant")
      }
      specifiers = loads.filter(({ partial }) => !partial).map((load) => load.url)
    } else specifiers = [request.specifier]
    // Import attributes that can't be read may name a module that is not JavaScript, so it is not fetched or parsed.
    // A branch that names a JavaScript module still follows the import, and the unreadable one is recorded.
    if (specifiers.length > 0 && !request.readableOptions) {
      unresolvedReference(graph, artifact, request, "a dynamic import whose options can't be read")
      if (!request.follow) continue
    }
    for (const specifier of specifiers) {
      const chunk = await followImport(request, specifier)
      // A remote chunk joins its loader's group (`Discovered.remoteChunks`).
      if (chunks && chunk !== undefined && !graph.store.isMapped(chunk) && graph.byRealmUrl.has(at(realm, chunk))) {
        const record = { realm, loader: { url, ...(fetched === undefined ? {} : { fetched }) }, chunk }
        graph.remoteChunks.set(JSON.stringify(record), record)
      }
    }
  }
  for (const request of workers) await workerReference(graph, visit, artifact, request)

  /** Follows a module request with `specifier`, and gives the URL of the module it names, if it names one. */
  async function followImport(request: ModuleRequest, specifier: string): Promise<string | undefined> {
    const resolved = resolveSpecifier(importMap, specifier, base)
    // A sweep-only file's import of another swept file links it in the file's group (§19): the module stays the
    // sweep's (`sweptImports`).
    if (visit.swept && !('error' in resolved) && isSwept(graph, resolved.url.href)) return undefined
    const keyed = keyBase === base ? resolved : resolveSpecifier(importMap, specifier, keyBase)
    // A module request names a module in the script's realm, which is assumed when the script's is.
    const how: How = { sourceType: 'module', runs, realm, ...(assumed && { assumed }) }
    if ('error' in resolved) {
      unresolvedReference(graph, artifact, request, resolved.error)
      return undefined
    }
    // An import is checked against the import map's integrity value for its URL (HTML § Descendant script fetch
    // options).
    const integrity = moduleIntegrity(importMap, resolved.url)
    // A dynamic import is the root of a module graph of its own, which gives nothing when it fails.
    if (request.dynamic && (await graphFails(graph, page, realm, [{ url: resolved.url, integrity }]))) return undefined
    const keyUrl = 'error' in keyed ? resolved.url : keyed.url
    const to = keyUrl.href === resolved.url.href ? { url: keyUrl.href } : { url: keyUrl.href, fetched: resolved.url.href }
    recordImport(graph, realm, page.entry.url, { url, ...(fetched === undefined ? {} : { fetched }) }, specifier, to)
    await reference(graph, page, resolved.url, { ...how, request: true }, url, worker, integrity, keyUrl)
    return keyUrl.href === resolved.url.href ? keyUrl.href : undefined
  }
}

/** The realm each kind of worker function creates a worker in. `importScripts` loads a script into its own worker. */
const workerRealms: Record<Exclude<WorkerKind, 'import-scripts'>, Realm> = {
  worker: 'dedicated-worker',
  'shared-worker': 'shared-worker',
  'service-worker': 'service-worker',
}

/**
 * Follows a worker request of a script, when the script's realm can make it (`realmHas`): its URL resolves against
 * the environment's base URL, the document's in the window and the worker script's in a worker (HTML § The Worker
 * constructor, § importScripts, and Service Workers § register). A new worker's script is referenced in the worker's
 * realm, and a script `importScripts` loads, in the script's own realm, as a classic script of its worker. A module
 * worker's `importScripts` throws, and so does a URL that doesn't parse. A service worker's script outside every
 * mapping gives an `unresolved-reference` record, and a `data:` one nothing. A dedicated or shared worker's script on
 * another origin than its creator's (`creatorOrigin`) gives nothing, unless it is a `data:` URL, which is followed in
 * the worker's realm (§2). A worker whose options can't be read statically is a module when its script's syntax says
 * so (`sourceTypeOf`).
 */
async function workerReference(graph: Graph, visit: Visit, script: Found, request: WorkerRequest): Promise<void> {
  const { realm, worker } = visit
  if (!callable(graph.catalog, realm, request)) return
  if (request.kind === 'import-scripts' && worker?.sourceType !== 'script') return
  if (request.url !== null) {
    await literalWorker(graph, visit, script, { ...request, url: request.url })
    return
  }
  // A URL that isn't a literal is each constant alternative the resolver folded it to, and each alternative that
  // doesn't fold is an `unresolved-reference` there (§2 Computed URLs). A chunk loader's `importScripts`
  // is followed as a chunk load instead (`followReferences`; §2). Until the resolver has folded it, the whole
  // URL is one alternative that doesn't fold.
  const from = { url: visit.url, ...(visit.fetched === undefined ? {} : { fetched: visit.fetched }) }
  if (request.kind === 'import-scripts' && graph.chunkSites.has(importSite(from, request.start))) return
  const folded = graph.workerSites.get(importSite(from, request.start))
  const detail = 'a worker URL that is not a constant'
  if (folded === undefined) {
    unresolvedReference(graph, script, request, detail)
    return
  }
  for (const alternative of folded) {
    if (alternative.none) continue
    if (alternative.partial) unresolvedReference(graph, script, alternative.alternative ?? request, detail)
    else await literalWorker(graph, visit, script, { ...request, url: alternative.url })
  }
}

/** Follows a worker request with a constant URL (`workerReference`). */
async function literalWorker(graph: Graph, visit: Visit, script: Found, request: WorkerRequest & { url: string }): Promise<void> {
  const { realm, page, worker } = visit
  // A worker's URL is its script's response URL, after any redirects (HTML § Run a worker). What it references is
  // fetched against that URL, and keyed by the URL resolved against its script's key URL (§11).
  const workerUrl =
    worker && (graph.byRealmUrl.get(at(realm, worker.url, worker.fetched))?.retrieval.finalUrl ?? worker.url)
  const url = URL.parse(request.url, workerUrl ?? page.base)
  const keyUrl = (worker && URL.parse(request.url, worker.url)) ?? url
  // A script URL whose scheme is not `http:`, `https:` or `data:` gives nothing wherever it appears (§2 Other script
  // URLs), not even an unresolved service worker.
  if (url === null || !scriptSchemes.has(url.protocol)) return
  if (request.kind === 'import-scripts') {
    const how = { sourceType: 'script' as const, runs: visit.runs, realm, imported: true as const }
    await reference(graph, page, url, how, visit.url, worker, '', keyUrl ?? url)
    return
  }
  // A browser refuses to register a `data:` service worker, so it gives nothing (§2).
  if (request.kind === 'service-worker' && url.protocol === 'data:') return
  // A service worker must be same-origin with the page, and a script outside every mapping is none of the build's.
  if (request.kind === 'service-worker' && !graph.store.isMapped(url.href)) {
    unresolvedReference(graph, script, request, 'a service worker whose script falls outside every URL mapping')
    return
  }
  // A browser refuses to run a dedicated or shared worker's script from another origin than its creator's, so it is not
  // followed, and nothing is missed (§2). A `data:` worker's script runs whatever its creator, and its code is the
  // page's (§2). A service worker's script is judged by the mappings alone, above.
  if (request.kind !== 'service-worker' && url.protocol !== 'data:' && url.origin !== creatorOrigin(visit)) return
  const workerRealm = workerRealms[request.kind]
  const sourceType = request.sourceType ?? (await sourceTypeOf(graph, page, url, workerRealm, keyUrl ?? url))
  // A module worker's script is the root of a module graph, which gives nothing when it fails (§2 Import attributes).
  if (sourceType === 'module' && (await graphFails(graph, page, workerRealm, [{ url, integrity: '' }]))) return
  const how = { sourceType, runs: visit.runs, realm: workerRealm }
  const keyed = (keyUrl ?? url).href
  const started: WorkerScript = { url: keyed, ...(keyed === url.href ? {} : { fetched: url.href }), sourceType }
  await reference(graph, page, url, how, visit.url, started, '', keyUrl ?? url)
}

/**
 * The origin of the code a visit follows, which creates its workers: the page's, in the window and in a worker whose
 * script is on the page's origin, as only those are followed, and none in a `data:` worker, whose origin is opaque
 * (HTML § The Worker constructor), so that no URL's origin is its.
 */
function creatorOrigin({ page, worker }: Visit): string | null {
  return worker !== undefined && worker.url.startsWith('data:') ? null : new URL(page.entry.url).origin
}

/**
 * The source type of a worker's script whose options can't be read statically: its syntax decides it, as a sweep-only
 * file's (§2). Its bytes are those of the artifact the realm has at its URL, if any, or else those it reads as a worker
 * script: a `data:` URL's own. A script whose bytes can't be read is a classic script, the default.
 */
async function sourceTypeOf(
  graph: Graph,
  page: Page,
  url: URL,
  realm: Realm,
  keyUrl: URL,
): Promise<'script' | 'module'> {
  const found = graph.byRealmUrl.get(at(realm, keyUrl.href, url.href))
  const read = found ?? (await readOnce(graph, page, url, { sourceType: 'script', realm }, ''))
  const text = read?.text ?? null
  return text === null ? 'script' : sourceTypeBySyntax(text)
}

/**
 * Whether a realm's global object has the function a worker request calls (§19: discovery reads the realm globals from
 * the catalog), and the global name it calls it through, if any: `Worker` in the window and in dedicated and shared
 * workers, `SharedWorker` in the window only, `importScripts` in workers only, and `navigator` with
 * `ServiceWorkerContainer.prototype.register` in every realm; `window` only in the window.
 */
function callable(catalog: SerializedCatalog, realm: Realm, { kind, through }: WorkerRequest): boolean {
  if (through !== undefined && !realmHas(catalog, realm, through)) return false
  switch (kind) {
    case 'worker':
      return realmHas(catalog, realm, 'Worker')
    case 'shared-worker':
      return realmHas(catalog, realm, 'SharedWorker')
    case 'import-scripts':
      return realmHas(catalog, realm, 'importScripts')
    case 'service-worker':
      return (
        realmHas(catalog, realm, 'navigator') &&
        Object.hasOwn(catalog.targets[realm], 'ServiceWorkerContainer.prototype.register')
      )
  }
}

/** Whether the realm's global object has the member `name`, its own or inherited, in the catalog (§4). */
function realmHas(catalog: SerializedCatalog, realm: Realm, name: string): boolean {
  const holders = catalog.holders[realm]
  const targets = catalog.targets[realm]
  let holder = Object.keys(holders).find((key) => holders[key]!.kind === 'global') ?? null
  for (; holder !== null; holder = holders[holder]?.proto ?? null) {
    if (Object.hasOwn(targets, `${holder}.${name}`)) return true
  }
  return false
}

/**
 * Records an `unresolved-reference` (§13) at a request of a script, once however many entry documents follow it. The
 * record names the script's own URL and path, which its requests resolve against, whatever other URL has its bytes.
 */
function unresolvedReference(
  graph: Graph,
  script: Found,
  { start, end }: { start: number; end: number },
  detail: string,
): void {
  const { url, path, hash, text } = script
  addUnresolved(graph, {
    kind: 'unresolved-reference',
    artifact: { url, ...(path === null ? {} : { path }), ...(hash === null ? {} : { hash }) },
    location: locate(text ?? '', start, end),
    detail,
  })
}

/** Records an `unresolved-reference` (§13) once, however many entry documents or scripts raise it. */
function addUnresolved(graph: Graph, record: LimitationRecord): void {
  const key = JSON.stringify(record)
  if (graph.unresolved.has(key)) return
  graph.unresolved.add(key)
  graph.limitations.push(record)
}

/**
 * The location of the UTF-16 range `[start, end)` of `text` (§5 Positions): its start as a 1-based line and a 0-based
 * column. Lines end at an ECMAScript LineTerminatorSequence: LF, CR, CRLF, U+2028 or U+2029.
 */
function locate(text: string, start: number, end: number): GeneratedLocation {
  let line = 1
  let lineStart = 0
  for (let i = 0; i < start; i++) {
    const code = text.charCodeAt(i)
    if (code === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) {
      line++
      lineStart = i + 1
    }
  }
  return { start, end, line, column: start - lineStart }
}

/** The module requests that resolve through import maps: those with a literal specifier and readable options. */
function followable(modules: readonly ModuleRequest[]): (ModuleRequest & { specifier: string })[] {
  return modules.filter(
    (request): request is ModuleRequest & { specifier: string } => request.specifier !== null && request.follow,
  )
}

/** The requests of an artifact's bytes, parsed once for each source type. None when they weren't read. */
function requestsOf(
  graph: Graph,
  { hash, text }: Pick<Found, 'hash' | 'text'>,
  sourceType: 'script' | 'module',
): Requests {
  if (hash === null || text === null) return { modules: [], workers: [], unsupported: false }
  const key = `${sourceType} ${hash}`
  let found = graph.requests.get(key)
  if (found === undefined) graph.requests.set(key, (found = requests(text, sourceType)))
  return found
}

/**
 * Follows an entry document's references, element by element in tree order, as the browser would on insertion. The
 * contents of a `<template>` are not its children, so they are never visited, and parse5 parses the contents of
 * `<noscript>` (with scripting enabled) and `<iframe>` as text. An `iframe srcdoc` is an attribute.
 */
async function walk(
  graph: Graph,
  page: Page,
  root: DefaultTreeAdapterTypes.ParentNode,
  mapsOnly = false,
): Promise<void> {
  const { entry } = page
  // The first `<base href>` sets the base URL (§19). A reference before it resolves against the document's URL: the
  // browser resolves a script's `src` when the parser inserts it, before a later `<base>` exists.
  let base: string | undefined
  for (const element of elements(root)) {
    if (mapsOnly) {
      if (isHtml(element, 'script')) mapScript(graph, page, element, base ?? entry.url)
    } else graph.html.inlineHandlers += inlineHandlers(graph, element, base ?? entry.url)
    if (isHtml(element, 'base') && base === undefined) {
      const href = attribute(element, 'href')
      if (href !== undefined) page.base = base = frozenBaseUrl(href, entry.url)
    } else if (mapsOnly) continue
    else if (isHtml(element, 'script')) await script(graph, page, element, base ?? entry.url)
    else if (isHtml(element, 'link')) await link(graph, page, element, base ?? entry.url)
  }
}

/**
 * What an inline `script` element adds to its document's import maps (§2 Import maps): an import map merges into them,
 * and each specifier an inline module script's requests resolve through the maps before it joins the document's
 * resolved module set, which later maps can't change, whether or not the module's graph later fails. A browser rejects
 * an external import map (`src`), and an invalid one.
 */
function mapScript(graph: Graph, page: Page, element: DefaultTreeAdapterTypes.Element, base: string): void {
  if (attribute(element, 'src') !== undefined) return
  const text = inlineText(element)
  if (text === '') return
  const sourceType = scriptType(element)
  if (sourceType === 'importmap') {
    const importMap = parseImportMap(text, base)
    if (importMap !== null) page.importMap = mergeImportMaps(page.importMap, importMap, page.resolved)
  } else if (sourceType === 'module') {
    for (const { specifier } of followable(inlineRequests(graph, text).modules)) {
      const resolved = resolveSpecifier(page.importMap, specifier, base)
      if ('record' in resolved) page.resolved.push(resolved.record)
    }
  }
}

/** The requests of an inline module script's text. */
function inlineRequests(graph: Graph, text: string): Requests {
  return requestsOf(graph, read(encoder.encode(text), inlineRetrieval, text), 'module')
}

/** An inline `script` element's text. */
const inlineText = (element: DefaultTreeAdapterTypes.Element): string =>
  element.childNodes.map((child) => ('value' in child ? child.value : '')).join('')

/**
 * Follows a `link` that preloads a script: `<link rel=preload as=script>` for a classic script, or `<link
 * rel=modulepreload>` for a module of the window or of a worker, whose `href` is resolved against `base`. Its file
 * joins the graph, but a preload never makes it run (§19 HTML rules). A service worker's module outside every URL
 * mapping gives an `unresolved-reference` record naming the entry document instead, as `register` does (§2).
 */
async function link(graph: Graph, page: Page, element: DefaultTreeAdapterTypes.Element, base: string): Promise<void> {
  const classic = { sourceType: 'script' as const, realm: 'window' as const }
  const preload = isScriptPreload(element) ? classic : modulePreload(element)
  if (preload === undefined) return
  const url = referenceUrl(attribute(element, 'href'), base)
  if (url === null) return
  const { sourceType, realm } = preload
  // A script URL whose scheme is not `http:`, `https:` or `data:` gives nothing wherever it appears (§2 Other script
  // URLs), not even an unresolved service worker.
  if (!scriptSchemes.has(url.protocol)) return
  // A browser refuses to register a `data:` service worker, so one preloaded for a service worker gives nothing (§2).
  if (realm === 'service-worker' && url.protocol === 'data:') return
  // A service worker's script outside every mapping is none of the build's, as for `register` (§2).
  if (realm === 'service-worker' && !graph.store.isMapped(url.href)) {
    const { path } = page
    addUnresolved(graph, {
      kind: 'unresolved-reference',
      artifact: { url: page.entry.url, ...(path === null ? {} : { path }) },
      detail: `a service worker module preload whose URL, ${url.href}, falls outside every URL mapping`,
    })
    return
  }
  // A module preloaded for a worker is taken for the worker's script.
  const worker = realm === 'window' ? undefined : { url: url.href, sourceType }
  const integrity = integrityOf(element, sourceType, page, url)
  const hint = sourceType === 'script' ? 'preload' : 'modulepreload'
  await reference(graph, page, url, { sourceType, runs: false, realm, hint }, page.entry.url, worker, integrity)
}

/**
 * The inline event-handler attributes and `javascript:` URLs of an element, which are counted and not analyzed (§19
 * HTML rules). An event handler is an attribute named for an event handler of an element interface. A `javascript:`
 * URL counts where a browser runs one: in a link, frame or form target.
 */
function inlineHandlers(graph: Graph, element: DefaultTreeAdapterTypes.Element, base: string): number {
  let count = 0
  for (const { name, value, prefix } of element.attrs) {
    if (prefix === undefined && graph.eventHandlers.has(name)) count++
    else if (runsJavascriptUrl(element, name) && URL.parse(value, base)?.protocol === 'javascript:') count++
  }
  return count
}

/** The HTML elements and attributes a browser navigates to, or submits a form to, so running a `javascript:` URL. */
const javascriptUrlAttributes: Record<string, readonly string[]> = {
  a: ['href'],
  area: ['href'],
  iframe: ['src'],
  frame: ['src'],
  form: ['action'],
  button: ['formaction'],
  input: ['formaction'],
}

/** Whether a browser runs a `javascript:` URL in the attribute `name` of `element`: a link, frame or form target. */
function runsJavascriptUrl(element: DefaultTreeAdapterTypes.Element, name: string): boolean {
  if (element.namespaceURI === html.NS.SVG) return element.tagName === 'a' && name === 'href'
  return element.namespaceURI === html.NS.HTML && (javascriptUrlAttributes[element.tagName]?.includes(name) ?? false)
}

/**
 * The names of event handler content attributes: the event handler attributes (§4 `assign: event-handler`) that the
 * catalog's element interfaces carry, whose prototype chains reach `Element.prototype`, such as `onclick` and, on
 * `<body>`, `onload`.
 */
function eventHandlers(catalog: SerializedCatalog): Set<string> {
  const { targets, holders } = catalog
  const isElement = (holder: string | null): boolean =>
    holder === 'Element.prototype' || (holder !== null && isElement(holders.window[holder]?.proto ?? null))
  const names = new Set<string>()
  for (const [name, target] of Object.entries(targets.window)) {
    const holder = name.slice(0, name.length - target.member.length - 1)
    if (target.assign === 'event-handler' && isElement(holder)) names.add(target.member)
  }
  return names
}

/**
 * A `<base>`'s frozen base URL (HTML § The base element): its `href` resolved against the document's URL, unless that
 * fails or gives a `data:` or `javascript:` URL, which leave the document's URL.
 */
function frozenBaseUrl(href: string, documentUrl: string): string {
  const url = URL.parse(href, documentUrl)
  return url === null || url.protocol === 'data:' || url.protocol === 'javascript:' ? documentUrl : url.href
}

/** Follows a `script` element: an inline script, or the file its `src` names, resolved against `base`. */
async function script(
  graph: Graph,
  page: Page,
  element: DefaultTreeAdapterTypes.Element,
  base: string,
): Promise<void> {
  const { entry } = page
  const src = attribute(element, 'src')
  const inline = src === undefined ? (graph.inlineCounts.get(entry.url) ?? 0) + 1 : 0
  if (src === undefined) graph.inlineCounts.set(entry.url, inline)
  const text = inlineText(element)
  // The browser's steps, in its order (HTML § Prepare the script element): an empty inline script does nothing.
  if (src === undefined && text === '') return
  const sourceType = scriptType(element)
  // Every type but classic, module and import map is ignored.
  if (sourceType === undefined) return
  if (sourceType === 'importmap') return mapScript(graph, page, element, base)
  // A classic `nomodule` script is counted, not analyzed (§19 HTML rules). A module script ignores the attribute.
  if (sourceType === 'script' && attribute(element, 'nomodule') !== undefined) {
    graph.html.nomodule++
    return
  }
  if (sourceType === 'script' && !legacyEventRuns(element)) return
  if (src === undefined) {
    const url = inlineUrl(entry.url, inline)
    const how = { sourceType, runs: true, realm: 'window' as const }
    const fields = { url, path: null, origin: 'inline' as const, parent: entry.url, ...how }
    const found = { ...fields, ...read(encoder.encode(text), inlineRetrieval, text) }
    if (sourceType === 'module') {
      // An inline module script's requests resolve through the import maps before it (§2 Import maps). Its graph fails
      // as they resolve, and then the script gives nothing (§2 Import attributes).
      const importMap = page.importMap
      mapScript(graph, page, element, base)
      if (await modulesFail(graph, page, 'window', inlineRequests(graph, text), importMap, base)) return
    }
    graph.byRealmUrl.set(at('window', url), found)
    recordNamed(graph, at('window', url), entry.url)
    graph.ran.add(at('window', url))
    graph.visits.push({ url, page, base, ...how, ...(sourceType === 'module' && { importMap: page.importMap }) })
    return
  }
  // A `src` that is empty or no URL makes the script fail, and its inline text never runs.
  const url = referenceUrl(src, base)
  if (url === null) return
  const integrity = integrityOf(element, sourceType, page, url)
  // A module script element is the root of a module graph, which gives nothing when it fails (§2 Import attributes).
  if (sourceType === 'module' && (await graphFails(graph, page, 'window', [{ url, integrity }]))) return
  await reference(graph, page, url, { sourceType, runs: true, realm: 'window' }, entry.url, undefined, integrity)
}

/**
 * Whether the module graph of a module fails, as its requests `requested` say, resolved through `importMap` against
 * `base` (§2 Import attributes, Principle 1): it has a static import with an unsupported attribute, or a module it
 * statically imports fails (`graphFails`).
 */
async function modulesFail(
  graph: Graph,
  page: Page,
  realm: Realm,
  requested: Requests,
  importMap: ImportMap,
  base: string,
): Promise<boolean> {
  if (requested.unsupported) return true
  return graphFails(graph, page, realm, staticImports(requested.modules, importMap, base))
}

/** The modules that static requests name, resolved through `importMap` against `base`, with their integrity values. */
function staticImports(modules: readonly ModuleRequest[], importMap: ImportMap, base: string): Root[] {
  return followable(modules)
    .filter(({ dynamic }) => !dynamic)
    .flatMap(({ specifier }) => {
      const resolved = resolveSpecifier(importMap, specifier, base)
      return 'error' in resolved ? [] : [{ url: resolved.url, integrity: moduleIntegrity(importMap, resolved.url) }]
    })
}

/** A module that starts a module graph, with the integrity metadata it is fetched with. */
interface Root {
  url: URL
  integrity: string
}

/**
 * Whether the module graph that `roots` start in `realm` fails (§2 Import attributes, Principle 1): a module in it,
 * found through static imports and re-exports resolved through all of the document's import maps (a worker's are
 * empty), has a static import with an unsupported attribute, which fails every graph that contains it, as Chromium
 * does. Local and `data:` modules are read before any remote one is fetched, one remote module at a time, so that no
 * remote module is fetched once a failure is found. A module whose bytes can't be read fails nothing. Reading records
 * nothing: the references that follow record what they read.
 */
async function graphFails(graph: Graph, page: Page, realm: Realm, roots: readonly Root[]): Promise<boolean> {
  const importMap = realm === 'window' ? page.finalMap : emptyImportMap
  const key = (url: URL) => wholeKey(page, realm, url)
  const seen = new Set<string>()
  const local: Root[] = []
  const remote: Root[] = []
  const add = (root: Root) => {
    if (!scriptSchemes.has(root.url.protocol) || seen.has(root.url.href) || graph.whole.has(key(root.url))) return
    seen.add(root.url.href)
    const isLocal = root.url.protocol === 'data:' || graph.store.isMapped(root.url.href)
    ;(isLocal ? local : remote).push(root)
  }
  roots.forEach(add)
  for (let next = local.shift() ?? remote.shift(); next !== undefined; next = local.shift() ?? remote.shift()) {
    const read = await readOnce(graph, page, next.url, { sourceType: 'module', realm }, next.integrity)
    if (read === null) continue
    const requested = requestsOf(graph, read, 'module')
    if (requested.unsupported) return true
    staticImports(requested.modules, importMap, read.retrieval.finalUrl ?? next.url.href).forEach(add)
  }
  for (const href of seen) graph.whole.add(key(new URL(href)))
  return false
}

/** A module's key in `whole`: its URL, and the import map its requests resolve through (its document's, or none). */
const wholeKey = (page: Page, realm: Realm, url: URL): string =>
  `${realm === 'window' ? page.index : 'worker'} ${url.href}`

/**
 * The integrity metadata a `script` or `link` element fetches `url` with (§17 Integrity): its `integrity` attribute,
 * even an empty one, or for a module script or a module preload with none, the value the document's import maps give
 * `url` so far (HTML § Prepare the script element, § Link type "modulepreload"). The empty string checks nothing.
 */
function integrityOf(
  element: DefaultTreeAdapterTypes.Element,
  sourceType: 'script' | 'module',
  page: Page,
  url: URL,
): string {
  const value = attribute(element, 'integrity')
  if (value !== undefined) return value
  return sourceType === 'module' ? moduleIntegrity(page.importMap, url) : ''
}

/** The URL an attribute references, resolved against `base`; null when it is missing, empty or no URL. */
function referenceUrl(value: string | undefined, base: string): URL | null {
  return value === undefined || value.trim() === '' ? null : URL.parse(value.trim(), base)
}

/** `<link rel=preload as=script>`: `rel` holds the token `preload`, and `as` is `script`, ignoring ASCII case. */
function isScriptPreload(element: DefaultTreeAdapterTypes.Element): boolean {
  return relTokens(element).includes('preload') && asciiLowercase(attribute(element, 'as') ?? '') === 'script'
}

/**
 * The keywords of a `link`'s `as` attribute (HTML § The link element): the preload destinations, and the module
 * preload destinations, which are `json`, `style`, `text` and the script-like destinations (Fetch § Requests). Any
 * other value, like a missing one, is in no state.
 */
const linkAsKeywords = new Set([
  ...['fetch', 'font', 'image', 'script', 'style', 'track'],
  ...['json', 'text', 'audioworklet', 'paintworklet', 'serviceworker', 'sharedworker', 'worker'],
])

/** The realm a module preload's worker destination (HTML § Link type "modulepreload") preloads a module for. */
const workerDestinations: Record<string, Realm> = {
  worker: 'dedicated-worker',
  sharedworker: 'shared-worker',
  serviceworker: 'service-worker',
}

/**
 * `<link rel=modulepreload>`, which preloads a module: `rel` holds the token `modulepreload`, and `as`, ignoring ASCII
 * case, gives the destination (HTML § Link type "modulepreload"). It is a module script of the window when `as` is
 * `script` or in no state (missing, empty or no keyword), which HTML maps to `script`, and of a worker's realm when it
 * is `worker`, `sharedworker` or `serviceworker`. A JSON, CSS or text module is not JavaScript, and any other
 * destination makes the preload fail.
 */
function modulePreload(element: DefaultTreeAdapterTypes.Element): { sourceType: 'module'; realm: Realm } | undefined {
  if (!relTokens(element).includes('modulepreload')) return undefined
  const as = asciiLowercase(attribute(element, 'as') ?? '')
  if (as === 'script' || !linkAsKeywords.has(as)) return { sourceType: 'module', realm: 'window' }
  const realm = Object.hasOwn(workerDestinations, as) ? workerDestinations[as] : undefined
  return realm === undefined ? undefined : { sourceType: 'module', realm }
}

/** The tokens of a `link`'s `rel`, in ASCII lowercase. */
function relTokens(element: DefaultTreeAdapterTypes.Element): string[] {
  return asciiLowercase(attribute(element, 'rel') ?? '').split(/[\t\n\f\r ]+/)
}

/**
 * Follows a reference to a script file from an entry document's element, or from a script's module or worker request:
 * a local file through the URL mappings, a `data:` URL's own bytes, or a remote `http:` or `https:` one through the
 * fetcher, with the integrity metadata the reference carries, if any (§17 Integrity). A URL with any other scheme gives
 * nothing, and so does a `data:` script a browser would refuse to run (§2 Other script URLs). A URL referenced before in
 * the same realm is the artifact found then, which a reference that runs it makes run. When that changes what it is
 * fetched as, such as a classic preload that a module import then names, it is read again as that (§17 Content types).
 * A reference that runs it the other way, as a module where it runs as a classic script or the reverse, makes it an
 * artifact that way too (§2 Files that don't run as referenced). The script its bytes hold is to be followed, as this
 * reference found it, in the worker `worker` when the realm is a worker's; a file a classic preload names is followed
 * only once every running reference has been (`preloadVisit`).
 */
async function reference(
  graph: Graph,
  page: Page,
  url: URL,
  { hint, imported, assumed, request, injected, ...how }: How,
  parent: string,
  worker?: WorkerScript,
  integrity = '',
  keyUrl: URL = url,
): Promise<void> {
  // A script URL whose scheme is not `http:`, `https:` or `data:` gives nothing wherever it appears (§2 Other script
  // URLs).
  if (!scriptSchemes.has(url.protocol)) return
  const { byRealmUrl } = graph
  const key = at(how.realm, keyUrl.href, url.href)
  // How this reference fetches the file. Whether `importScripts` loads it only changes what a `data:` URL may hold.
  const fetching: How = imported === undefined ? how : { ...how, imported }
  const found = byRealmUrl.get(key)
  if (found === undefined) {
    const fields = await readAs(graph, page, url, fetching, key, integrity, keyUrl)
    // A `data:` script a browser refuses to run gives no artifact, no record and no findings.
    if (fields === null) return
    byRealmUrl.set(key, { url: keyUrl.href, ...how, parent, ...fields, ...(injected && { discovery: 'injected' as const }) })
  } else if (!found.runs && (how.runs || how.sourceType === 'module')) {
    // A reference that runs the file gives it its source type, and so does a module reference when neither runs it: an
    // import or a `modulepreload` says how the browser loads it, where a classic preload is only a hint.
    const reread = fetchesAgain(graph, found, how, key, integrity)
      ? await readAs(graph, page, url, fetching, key, integrity, keyUrl)
      : {}
    if (reread === null) return
    byRealmUrl.set(key, { ...found, ...how, ...reread })
  } else if (found.runs && how.runs && how.sourceType !== found.sourceType && !graph.otherWay.has(key)) {
    // A file the page runs both as a classic script and as a module is analyzed both ways (§2): the second way is an
    // artifact of its own, read as that way fetches it.
    const fields = await readAs(graph, page, url, fetching, JSON.stringify([key, how.sourceType]), integrity, keyUrl)
    if (fields === null) return
    graph.otherWay.set(key, { url: keyUrl.href, ...how, parent, ...fields })
  }
  if (request !== undefined) graph.requested.add(key)
  else {
    recordNamed(graph, key, page.entry.url)
    if (how.runs) graph.ran.add(key)
  }
  const naming = hint ?? (assumed ? 'assumed' : 'reference')
  graph.references.set(key, (graph.references.get(key) ?? new Set<Naming>()).add(naming))
  const fetched = url.href === keyUrl.href ? {} : { fetched: url.href }
  const visit: Visit = { url: keyUrl.href, ...fetched, page, base: keyUrl.href, ...how, ...(assumed && { assumed }) }
  // A file a classic preload names is followed only once every running reference is (`preloadVisit`).
  if (hint === 'preload') graph.preloads.push({ ...visit, preloadIntegrity: integrity })
  else graph.visits.push(worker === undefined ? visit : { ...visit, worker })
}

/**
 * The schemes of the script URLs a page can load (§2 Other script URLs): a remote or local file's, or a `data:` URL's,
 * which is code the page carries. A script URL with any other scheme (`javascript:`, `blob:`, `file:`, `about:`, …)
 * gives nothing wherever it appears.
 */
const scriptSchemes = new Set(['http:', 'https:', 'data:'])

/**
 * Whether a reference that takes over an artifact a preload or an import found fetches it again: when it fetches it as
 * another destination (§17 Content types), or it is a classic script whose own integrity value differs from the one
 * the artifact was fetched with, which keeps it from taking the preload's response (HTML § Consume a preloaded
 * resource). A module is fetched once per realm, so a module reference always takes the module found before (HTML §
 * Fetch a single module script).
 */
function fetchesAgain(graph: Graph, found: Found, how: How, key: string, integrity: string): boolean {
  if (destination(found) !== destination(how)) return true
  return how.sourceType === 'script' && integrity !== '' && integrity !== graph.integrities.get(key)
}

/**
 * What a reference fetches a script as (§17 Content types): a classic script of the window, a module script, or a
 * classic script of a worker, which a browser checks as strictly as a module.
 */
function destination({ sourceType, realm }: Pick<How, 'sourceType' | 'realm'>): FetchRequest['destination'] {
  return sourceType === 'module' ? 'module' : realm === 'window' ? 'script' : 'worker'
}

/**
 * Reads `url` as `how` fetches it, with the integrity metadata `integrity`, for the artifact at `key` (its realm and
 * URL), and gives the artifact's fields. The record of why its bytes weren't read, if they weren't, is kept as the
 * artifact's. A URL read before, in another realm, is not read again: the store gives the same bytes, and records once.
 * A remote URL is read once for each destination it is fetched as, which the safety floor judges it by (§17 Content
 * types), and each integrity value its bytes are checked against (§17 Integrity), apart for a script `importScripts`
 * loads, which a `data:` URL may not give as it gives a worker's own script. A build file is never fetched, so no
 * integrity value is checked against it.
 */
async function readAs(
  graph: Graph,
  page: Page,
  url: URL,
  how: How,
  key: string,
  integrity: string,
  keyUrl: URL,
): Promise<Omit<Read, 'limitation'> | null> {
  const read = await readOnce(graph, page, url, how, integrity)
  if (read === null) return null
  const { limitation, ...fields } = read
  if (keyUrl.href === url.href) {
    graph.readLimitations.set(key, limitation)
    graph.integrities.set(key, integrity)
    return fields
  }
  // A URL fetched under another key URL (§11) is an artifact of that key, sharing the one fetch: its record names the
  // key URL, and its origin comes from it, as the requested URL's does (§17 What is recorded).
  const named = limitation && { ...limitation, artifact: { ...limitation.artifact, url: keyUrl.href } }
  graph.readLimitations.set(key, named)
  graph.integrities.set(key, integrity)
  const remote = fields.origin === 'same-origin' || fields.origin === 'cross-origin'
  return remote ? { ...fields, origin: originOf(keyUrl, page) } : fields
}

/** A remote URL's origin against the entry document's (§2): `same-origin` or `cross-origin`. */
function originOf(url: URL, page: Page): 'same-origin' | 'cross-origin' {
  return url.origin === new URL(page.entry.url).origin ? 'same-origin' : 'cross-origin'
}

/**
 * Reads `url` as `how` fetches it, with the integrity metadata `integrity`, once: a local file once, and a remote or
 * `data:` URL once for each destination, whether `importScripts` loads it, and integrity value. Null for a `data:`
 * script a browser refuses to run.
 */
async function readOnce(
  graph: Graph,
  page: Page,
  url: URL,
  how: Pick<How, 'sourceType' | 'realm' | 'imported'>,
  integrity: string,
): Promise<Read | null> {
  const imported = how.imported === true
  const request: FetchRequest = { destination: destination(how), document: page.entry.url, ...(imported && { imported }) }
  const mapped = graph.store.isMapped(url.href)
  const readKey = mapped ? url.href : JSON.stringify([request.destination, imported, integrity, url.href])
  let read = graph.reads.get(readKey)
  if (read === undefined) {
    const withIntegrity = mapped || integrity === '' ? request : { ...request, integrity }
    graph.reads.set(readKey, (read = await readReference(graph, page, url, withIntegrity)))
  }
  return read
}

/**
 * The fields of an artifact reading a URL gives: where it is served from, and its bytes, or why there are none, with
 * the record that says so (§13).
 */
type Read = Pick<Found, 'path' | 'origin' | 'hash' | 'text' | 'discovery' | 'realmBasis' | 'retrieval'> & {
  limitation: LimitationRecord | null
}

/**
 * Reads a referenced URL through the store, as `request` asks for it, and records why when its bytes can't be read. A
 * remote URL's origin is `same-origin` or `cross-origin` against the entry document, whatever the final URL after
 * redirects is (§17).
 */
async function readReference(graph: Graph, page: Page, url: URL, request: FetchRequest): Promise<Read | null> {
  const result = await graph.store.read(url.href, request)
  const remote = originOf(url, page)
  switch (result.status) {
    case 'ok': {
      const fields = { ...read(result.bytes, result.retrieval), limitation: null }
      if (result.path !== null) return { path: result.path, origin: 'local-build', ...fields }
      // A `data:` URL's code is the page's own (§2 Other script URLs).
      if (url.protocol === 'data:') return { path: null, origin: 'inline', ...fields }
      // An empty header names no map, as an empty annotation does: it would resolve to the script itself.
      const header = result.sourceMap === null || result.sourceMap.trim() === '' ? null : result.sourceMap
      if (!graph.fetched.has(url.href)) graph.fetched.set(url.href, { document: page.entry.url, header })
      return { path: null, origin: remote, ...fields }
    }
    case 'offline-skipped': {
      const detail = 'a remote script is not fetched offline'
      const limitation = { kind: result.status, artifact: { url: url.href }, detail }
      return { path: null, origin: remote, ...notRead(result), limitation }
    }
    case 'remote-refused':
    case 'fetch-failed':
    case 'sri-mismatch': {
      const limitation = { kind: result.status, artifact: { url: url.href }, detail: result.detail }
      return { path: null, origin: remote, ...notRead(result), limitation }
    }
    case 'unreadable':
      return { path: result.path, origin: 'local-build', ...notRead(result), limitation: unreadable(result) }
    case 'refused':
      return null
  }
}

/** An `unreadable` record (§13) for a local file. */
function unreadable(result: { url: string; path: string; detail: string }): LimitationRecord {
  return { kind: 'unreadable', artifact: { url: result.url, path: result.path }, detail: result.detail }
}

/** A candidate source map: what identifies it among an artifact's candidates, its build-relative path, and its JSON. */
interface Candidate {
  key: string
  /** Null for a map in a `data:` URL, or a fetched one. */
  path: string | null
  /** The map's raw JSON; undefined when it isn't JSON. */
  raw: unknown
}

/**
 * A map that a pairing method names for a local-build or inline artifact, that exists but can't be read, and the
 * `unreadable` record it gives (§2 Source maps, §13). It is no candidate, and, like one, is tried once.
 */
interface UnreadableMap {
  key: string
  unreadable: LimitationRecord
}

/**
 * A map that a remote artifact's header or annotation names, and that wasn't read (§17 Content types):
 * why, as the counter it goes in. It is no candidate, and, like one, is tried once.
 */
interface UnreadMap {
  key: string
  unread: keyof UnreadMaps
}

const noMap: Paired = {
  sourceMap: { method: 'none', path: null, status: 'none' },
  map: null,
  staleCandidates: 0,
  unreadMaps: { refused: 0, failed: 0, unreadable: 0 },
}

/**
 * The artifacts, each with its source map paired (§2 Source maps), and what became of each source-map directory's
 * maps. A URL in several realms is paired once for each bytes it was read as: one realm's read may have withheld them
 * (§17 Integrity) where another's gave them. The build directory's methods come first, then each source-map directory,
 * one at a time, in the order they were declared.
 */
async function pairSourceMaps(
  graph: Graph,
  found: readonly Found[],
  directories: readonly string[],
): Promise<{ artifacts: Artifact[]; sourceMapDirectories: SourceMapDirectoryCounts[] }> {
  const byUrlAndHash = new Map<string, Pairing>()
  const key = ({ url, hash }: Found) => JSON.stringify([url, hash])
  for (const artifact of found) {
    if (!byUrlAndHash.has(key(artifact))) {
      byUrlAndHash.set(key(artifact), { artifact, paired: await pairSourceMap(graph, artifact) })
    }
  }
  const sourceMapDirectories: SourceMapDirectoryCounts[] = []
  for (const dir of directories) sourceMapDirectories.push(await pairInDirectory(graph, dir, [...byUrlAndHash.values()]))
  const artifacts = found.map((artifact) => ({ ...artifact, ...byUrlAndHash.get(key(artifact))!.paired }))
  return { artifacts, sourceMapDirectories }
}

/** An artifact's bytes, and how their source map has paired so far. */
interface Pairing {
  artifact: Found
  paired: Paired
}

/** A map of a source-map directory, as the artifacts paired with it: whether it verified against one, or failed. */
interface MapOutcome {
  verified: boolean
  failed: boolean
}

/**
 * Pairs the artifacts with the maps of the source-map directory declared as `dir` (§2 Source maps), and counts what
 * became of its maps. Its maps pair by, in order: the artifact's `debugId` (any artifact), its annotation mirrored in
 * the directory, and its sidecar mirrored there (local-build artifacts only). Only a file the directory's listing
 * holds, under any spelling, is a candidate, named by its listed path, and only a `.map` file, in any case, has its
 * `debugId` read. Maps never pair by basename or by their `file` field.
 *
 * An artifact no earlier map paired takes the first candidate that verifies, and each one that fails before it is
 * `stale`. Every other candidate is verified only to count it, so that a directory counts as paired when any of its
 * maps verifies against an artifact, even one an earlier map already paired. A directory that can't be listed gives an
 * `unreadable` record, and one where nothing verifies a `source-maps-unpaired` record. A mirrored map that exists but
 * can't be read, a directory there included, gives an `unreadable` record while its artifact is being paired.
 */
async function pairInDirectory(
  graph: Graph,
  dir: string,
  pairings: readonly Pairing[],
): Promise<SourceMapDirectoryCounts> {
  const listing = await graph.store.listSourceMaps(dir)
  if (listing.status === 'unreadable') {
    graph.limitations.push({
      kind: 'unreadable',
      artifact: { path: dir },
      detail: `the source-map directory can't be read: ${listing.detail}`,
    })
    return { path: dir, found: 0, paired: 0, stale: 0, orphaned: 0, orphanedMaps: [] }
  }
  const files = new Set(listing.files)
  const directories = new Set(listing.directories)
  const outcomes = new Map<string, MapOutcome>()
  for (const path of listing.files) if (isMapName(path)) outcomes.set(path, { verified: false, failed: false })
  // What reading each file gave, read once: its raw JSON, or why it can't be read.
  const reads = new Map<string, { raw: unknown } | { detail: string }>()
  const readMap = async (path: string) => {
    let read = reads.get(path)
    if (read === undefined) {
      const result = await graph.store.readSourceMap(dir, path)
      read = result.status === 'ok' ? { raw: rawMap(decoder.decode(result.bytes)) } : { detail: result.detail }
      reads.set(path, read)
    }
    return read
  }
  // The `.map` files with a `debugId`, by it (`debugIdKey`), each in path order; read when an artifact first needs it.
  let byDebugId: Map<string, string[]> | undefined
  const debugIdCandidates = async (debugId: string) => {
    if (byDebugId === undefined) {
      byDebugId = new Map()
      for (const path of listing.files.filter(isMapName)) {
        const read = await readMap(path)
        const id = 'raw' in read ? mapDebugId(read.raw) : null
        if (id !== null) byDebugId.set(debugIdKey(id), [...(byDebugId.get(debugIdKey(id)) ?? []), path])
      }
    }
    return byDebugId.get(debugIdKey(debugId)) ?? []
  }
  // The listed files and directories, by what they lead to (`sourceMapIdentity`), the first in path order for each;
  // found when a named path is first not listed as spelled.
  let byIdentity: Map<string, string> | undefined
  /**
   * The listed path of what a pairing method names at `path`, when the directory's listing holds it (§2 Source maps):
   * a file listed as spelled, a directory listed as spelled with or without a trailing `/`, or either under another
   * spelling, as the same file by device and inode. Null when the listing doesn't hold it.
   */
  const held = async (path: string): Promise<string | null> => {
    const directory = path.replace(/\/+$/, '') || '.'
    if (directory === path && files.has(path)) return path
    if (directories.has(directory)) return directory
    const identity = await graph.store.sourceMapIdentity(dir, path)
    if (identity === null) return null
    if (byIdentity === undefined) {
      byIdentity = new Map()
      for (const listed of [...listing.files, ...listing.directories]) {
        const each = await graph.store.sourceMapIdentity(dir, listed)
        if (each !== null && !byIdentity.has(each)) byIdentity.set(each, listed)
      }
    }
    return byIdentity.get(identity) ?? null
  }
  for (const pairing of pairings) {
    const { url, path, origin, text, retrieval } = pairing.artifact
    if (text === null) continue
    const named = annotations(text)
    const local = origin === 'local-build' && path !== null
    const candidates: [PairingMethod, string, string | null][] = []
    if (named.debugId !== null) {
      for (const map of await debugIdCandidates(named.debugId)) candidates.push(['external-debug-id', map, null])
    }
    if (local && named.sourceMappingURL !== null) {
      // The annotation's URL, resolved against the artifact's, then through the URL→path mapping.
      const annotated = URL.parse(named.sourceMappingURL, retrieval.finalUrl ?? url)
      const mirrored = annotated === null ? null : graph.store.buildPath(annotated.href)
      const namedBy = `the source map the annotation of ${url} names, mirrored in ${dir},`
      if (mirrored !== null) candidates.push(['external-annotation', mirrored, namedBy])
    }
    if (local) {
      candidates.push(['external-sidecar', `${path}.map`, `the source map sidecar of ${url}, mirrored in ${dir},`])
    }
    const tried = new Set<string>()
    for (const [method, candidate, namedBy] of candidates) {
      // A map exists when the directory's listing holds it, and is named by its listed path.
      const map = await held(candidate)
      if (map === null || tried.has(map)) continue
      tried.add(map)
      const pairs = pairing.paired.sourceMap.status !== 'verified'
      const read = await readMap(map)
      if (!('raw' in read)) {
        if (pairs && namedBy !== null) {
          graph.limitations.push({
            kind: 'unreadable',
            artifact: { path: posix.join(dir, map) },
            detail: `${namedBy} can't be read: ${read.detail}`,
          })
        }
        if (files.has(map) && !outcomes.has(map)) outcomes.set(map, { verified: false, failed: false })
        continue
      }
      const outcome = outcomes.get(map) ?? { verified: false, failed: false }
      outcomes.set(map, outcome)
      const reading = verification({ text, debugId: named.debugId }, read.raw)
      if (reading !== null) outcome.verified = true
      else outcome.failed = true
      if (!pairs) continue
      const { sourceMap, staleCandidates, unreadMaps } = pairing.paired
      const joined = posix.join(dir, map)
      if (reading !== null) {
        const verified = { method, path: joined, status: 'verified' } as const
        pairing.paired = { sourceMap: verified, map: { raw: read.raw, reading, base: map }, staleCandidates, unreadMaps }
      } else {
        // An artifact whose every candidate failed is `stale`, with the first one's path.
        const first = sourceMap.status === 'stale' ? sourceMap.path : joined
        const stale = { method: 'none', path: first, status: 'stale' } as const
        pairing.paired = { sourceMap: stale, map: null, staleCandidates: staleCandidates + 1, unreadMaps }
      }
    }
  }
  const orphanedMaps = [...outcomes].filter(([, { verified }]) => !verified).map(([map]) => map)
  orphanedMaps.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const paired = outcomes.size - orphanedMaps.length
  if (paired === 0) {
    graph.limitations.push({
      kind: 'source-maps-unpaired',
      artifact: { path: dir },
      detail: `none of the source-map directory's ${count(outcomes.size, 'map')} verifies against an artifact`,
    })
  }
  const stale = orphanedMaps.filter((map) => outcomes.get(map)!.failed).length
  return { path: dir, found: outcomes.size, paired, stale, orphaned: orphanedMaps.length, orphanedMaps }
}

/** `n` and a noun, plural unless `n` is 1. */
const count = (n: number, noun: string) => `${n} ${n === 1 ? noun : `${noun}s`}`

/** Whether a file's name makes it a map (§2 Source maps): it ends in `.map`, ignoring ASCII case. */
const isMapName = (path: string) => asciiLowercase(path).endsWith('.map')

/**
 * Pairs an artifact with its source map (§2 Source maps). The methods are tried in order, each with the candidates it
 * finds: the `SourceMap` header of a fetched artifact, its `sourceMappingURL` annotation, the `<path>.map` sidecar of a
 * local-build artifact, and the build directory's maps with the artifact's `debugId`. The first candidate that verifies
 * is paired; one that fails is `stale`, and the next is tried. A candidate tried once isn't tried again, and maps are
 * never merged.
 *
 * A map the annotation of a local-build or inline artifact names, or its existing sidecar, that can't be read gives an
 * `unreadable` record, and the next method is tried (§2 Source maps). A remote artifact's map never changes
 * completeness: one that is refused, fails or can't be read is only counted (§17), and the next method is tried. Nor
 * does a map the `debugId` search meets, which isn't known to belong to the artifact.
 */
async function pairSourceMap(graph: Graph, artifact: Found): Promise<Paired> {
  const { url, path, origin, text, retrieval } = artifact
  if (text === null) return noMap
  const named = annotations(text)
  // A fetched artifact's header was recorded by the URL it was fetched at, which a key URL (§11) may differ from.
  const fetched = graph.fetched.get(retrieval.requestedUrl ?? url)
  // A map's URL resolves against the script's, which is the URL its bytes came from, after any redirects.
  const base = retrieval.finalUrl ?? url
  const header = fetched?.header ?? null
  // Only a local-build or inline artifact's annotation raises a record for a map that can't be read.
  const local = origin === 'local-build' || origin === 'inline'
  const namedBy = local ? `the source map the annotation of ${url} names` : undefined
  const annotated = (reference: string) => mapAt(graph, reference, base, fetched?.document, namedBy)
  const methods: [PairingMethod, () => Promise<(Candidate | UnreadableMap | UnreadMap)[]>][] = [
    ['header', async () => (header === null ? [] : mapAt(graph, header, base, fetched?.document))],
    ['annotation', async () => (named.sourceMappingURL === null ? [] : annotated(named.sourceMappingURL))],
    ['sidecar', async () => (origin === 'local-build' && path !== null ? sidecar(graph, url, path) : [])],
    ['debug-id', async () => (named.debugId === null ? [] : withDebugId(graph, named.debugId))],
  ]
  const tried = new Set<string>()
  const stale: Candidate[] = []
  const unreadMaps: UnreadMaps = { refused: 0, failed: 0, unreadable: 0 }
  for (const [method, candidates] of methods) {
    for (const candidate of await candidates()) {
      if (tried.has(candidate.key)) continue
      tried.add(candidate.key)
      if ('unreadable' in candidate) {
        graph.limitations.push(candidate.unreadable)
        continue
      }
      if ('unread' in candidate) {
        unreadMaps[candidate.unread]++
        continue
      }
      const reading = verification({ text, debugId: named.debugId }, candidate.raw)
      if (reading !== null) {
        const sourceMap = { method, path: candidate.path, status: 'verified' } as const
        // A `data:` URL map has no path of its own, and resolves against its script's (§10).
        const map = { raw: candidate.raw, reading, base: candidate.path ?? path }
        return { sourceMap, map, staleCandidates: stale.length, unreadMaps }
      }
      stale.push(candidate)
    }
  }
  const [first] = stale
  if (first === undefined) return { ...noMap, unreadMaps }
  const sourceMap = { method: 'none', path: first.path, status: 'stale' } as const
  return { sourceMap, map: null, staleCandidates: stale.length, unreadMaps }
}

/**
 * The map a header or an annotation names, by a URL resolved against the artifact's. A `data:` URL holds the map.
 * Otherwise it is read through the store, from the build directory when a mapping covers its URL. Only the map of an
 * artifact fetched for the entry document `document` is fetched, as that document's (§17 Remote source maps). A map
 * that can't be read is no candidate. When `namedBy` names it for the record, one in the build directory that exists
 * but can't be read is an `UnreadableMap`; a URL whose path is malformed names none. A fetched artifact's map that
 * isn't read is an `UnreadMap` (§17).
 */
async function mapAt(
  graph: Graph,
  reference: string,
  base: string,
  document?: string,
  namedBy?: string,
): Promise<(Candidate | UnreadableMap | UnreadMap)[]> {
  const url = URL.parse(reference, base)
  if (url === null) return []
  if (url.protocol === 'data:') {
    const text = dataUrlText(url)
    return [{ key: url.href, path: null, raw: text === null ? undefined : rawMap(text) }]
  }
  if (document === undefined && !graph.store.isMapped(url.href)) return []
  // A mapped URL is read from the build directory, which judges no request.
  const result = await graph.store.read(url.href, { destination: 'map', document: document ?? base })
  if (result.status === 'unreadable' && namedBy !== undefined) {
    return unreadableMap(graph, result, graph.store.buildPath(url.href), namedBy)
  }
  if (result.status !== 'ok') return document === undefined ? [] : unreadMap(graph, result, url.href)
  return [{ key: result.path ?? url.href, path: result.path, raw: rawMap(decoder.decode(result.bytes)) }]
}

/**
 * The `UnreadMap` a fetched artifact's map gives when it isn't read (§17 Content types): the safety
 * floor refused it, its fetch failed, or it is a build file that exists but can't be read. A build file that isn't
 * there, which the sweep's listing doesn't hold, gives nothing, as it does for a local artifact (§2 Source maps).
 */
async function unreadMap(
  graph: Graph,
  result: Exclude<ReadResult, { status: 'ok' }>,
  url: string,
): Promise<UnreadMap[]> {
  switch (result.status) {
    case 'remote-refused':
      return [{ key: result.url, unread: 'refused' }]
    case 'fetch-failed':
      return [{ key: result.url, unread: 'failed' }]
    case 'unreadable': {
      const path = graph.store.buildPath(url)
      return path === null || !(await held(graph, path)) ? [] : [{ key: result.path, unread: 'unreadable' }]
    }
    // A map is fetched with no integrity value, only in `resolve` mode, and never from a `data:` URL.
    case 'sri-mismatch':
    case 'offline-skipped':
    case 'refused':
      return []
  }
}

/**
 * The sidecar of a local-build artifact: `<path>.map` beside it in the build directory, if there is one. One that
 * exists but can't be read is an `UnreadableMap`.
 */
async function sidecar(graph: Graph, url: string, path: string): Promise<(Candidate | UnreadableMap)[]> {
  const mapUrl = new URL(url)
  mapUrl.search = ''
  mapUrl.hash = ''
  mapUrl.pathname += '.map'
  const result = await graph.store.readFile(`${path}.map`, mapUrl.href)
  if (result.status === 'unreadable') {
    return unreadableMap(graph, result, result.path, `the source map sidecar of ${url}`)
  }
  if (result.status !== 'ok' || result.path === null) return []
  return [{ key: result.path, path: result.path, raw: rawMap(decoder.decode(result.bytes)) }]
}

/**
 * The `UnreadableMap` a build file a pairing method names at `path` gives, when it exists but can't be read, whatever
 * the error (§2 Source maps), or nothing when nothing is there: a missing map is counted only in the attribution block
 * (§13). A map exists when the sweep's listing holds its path (`held`). A null `path`, from a URL that names no path
 * in the build directory, is never held. `namedBy` names the map in the record's detail.
 */
async function unreadableMap(
  graph: Graph,
  result: Extract<ReadResult, { status: 'unreadable' }>,
  path: string | null,
  namedBy: string,
): Promise<UnreadableMap[]> {
  if (path === null || !(await held(graph, path))) return []
  const { url, detail } = result
  const unreadable: LimitationRecord = {
    kind: 'unreadable',
    artifact: { url, path },
    detail: `${namedBy} can't be read: ${detail}`,
  }
  return [{ key: path, unreadable }]
}

/**
 * The build directory's maps whose `debugId` is the artifact's (`debugIdKey`), in path order: its files whose names end
 * in `.map`, ignoring ASCII case.
 */
async function withDebugId(graph: Graph, debugId: string): Promise<Candidate[]> {
  graph.debugIdMaps ??= (async () => {
    const maps = new Map<string, Candidate[]>()
    for (const { path, url } of (await listed(graph)).files) {
      if (!asciiLowercase(path).endsWith('.map')) continue
      // A file no mapping serves has no URL, so its path stands in for one.
      const result = await graph.store.readFile(path, url ?? path)
      if (result.status !== 'ok') continue
      const raw = rawMap(decoder.decode(result.bytes))
      const id = mapDebugId(raw)
      if (id !== null) maps.set(debugIdKey(id), [...(maps.get(debugIdKey(id)) ?? []), { key: path, path, raw }])
    }
    return maps
  })()
  return (await graph.debugIdMaps).get(debugIdKey(debugId)) ?? []
}

/** The build directory's files, listed once for the sweep, the `debugId` maps and whether a named map exists. */
function listed(graph: Graph): Promise<Listing> {
  return (graph.listing ??= graph.store.list())
}

/**
 * Whether the sweep's listing holds a normalized build path (§2 Source maps): as spelled (`heldAsSpelled`), or under
 * another spelling, when it leads to the same file or directory as a path held as spelled, by device and inode.
 * So a map named in another case on a case-insensitive file system, or through a loop link, is held.
 */
async function held(graph: Graph, path: string): Promise<boolean> {
  const listing = await listed(graph)
  if (heldAsSpelled(listing, path)) return true
  const identity = await graph.store.buildIdentity(path)
  if (identity === null) return false
  graph.heldIdentities ??= (async () => {
    const identities = new Set<string>()
    const paths = [...listing.files.map((file) => file.path), ...listing.directories]
    for (const each of paths.filter((listed) => heldAsSpelled(listing, listed))) {
      const found = await graph.store.buildIdentity(each)
      if (found !== null) identities.add(found)
    }
    return identities
  })()
  return (await graph.heldIdentities).has(identity)
}

/**
 * Whether the sweep's listing holds a normalized build path, as spelled (§2 Source maps): a file there, a directory it
 * meets there, a loop it stops at included, or, only where the sweep records it (a mapping serves its path or a path
 * under it), a directory there it can't list or a link there whose target it can't reach. A path
 * that ends in `/` names only a directory, or a link.
 */
function heldAsSpelled(listing: Listing, path: string): boolean {
  const directory = path.replace(/\/+$/, '') || '.'
  const unreachable = listing.unreadable.find((entry) => entry.path === directory)
  if (unreachable !== undefined) return unreachable.served
  return listing.files.some((file) => file.path === path) || listing.directories.includes(directory)
}

/** The URL of a document's `n`th inline script: the document's URL, with the fragment `inline-<n>`. */
function inlineUrl(documentUrl: string, n: number): string {
  const url = new URL(documentUrl)
  url.hash = `inline-${n}`
  return url.href
}

/**
 * The retrieval record of an inline script: part of its entry document, so never requested, and its bytes are the
 * document's.
 */
const inlineRetrieval: Retrieval = { status: 'ok', requestedUrl: null, finalUrl: null, contentType: null, sri: 'none' }

/** The fields of an artifact whose bytes were read: its content hash, text and retrieval record, and the defaults. */
function read(
  bytes: Uint8Array,
  retrieval: Retrieval,
  text = decoder.decode(bytes),
): Pick<Found, 'hash' | 'text' | 'discovery' | 'realmBasis' | 'retrieval'> {
  const hash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  return { hash, discovery: 'reference', realmBasis: 'reference', retrieval, text }
}

/** The fields of an artifact whose bytes could not be read: no hash or text, its retrieval record, and the defaults. */
function notRead({
  retrieval,
}: {
  retrieval: Retrieval
}): Pick<Found, 'hash' | 'text' | 'discovery' | 'realmBasis' | 'retrieval'> {
  return { hash: null, discovery: 'reference', realmBasis: 'reference', retrieval, text: null }
}

/**
 * The type a browser gives a `script` element (HTML § Prepare the script element): `script` for a classic script,
 * `module`, `importmap`, or undefined for every other type, which never runs. An element with no `type` and no
 * `language`, or an empty one, is classic; otherwise `type`, stripped, or else `text/` and the `language`, must match a
 * JavaScript MIME type essence, `module` or `importmap`, ignoring ASCII case.
 */
function scriptType(element: DefaultTreeAdapterTypes.Element): 'script' | 'module' | 'importmap' | undefined {
  return typeOfScript(attribute(element, 'type'), attribute(element, 'language'))
}

/** What a script element's `type` and `language` attributes make it (HTML § Prepare the script element). */
function typeOfScript(type: string | undefined, language: string | undefined): 'script' | 'module' | 'importmap' | undefined {
  if (type === '' || (type === undefined && (language === undefined || language === ''))) return 'script'
  const typeString = asciiLowercase(type === undefined ? `text/${language}` : stripAsciiWhitespace(type))
  if (javascriptTypes.has(typeString)) return 'script'
  if (typeString === 'module' || typeString === 'importmap') return typeString
  return undefined
}

/**
 * Whether a classic script with `for` and `event` attributes runs: only for the window's `load` event (HTML § Prepare
 * the script element).
 */
function legacyEventRuns(element: DefaultTreeAdapterTypes.Element): boolean {
  const target = attribute(element, 'for')
  const event = attribute(element, 'event')
  if (target === undefined || event === undefined) return true
  const handler = asciiLowercase(stripAsciiWhitespace(event))
  return asciiLowercase(stripAsciiWhitespace(target)) === 'window' && (handler === 'onload' || handler === 'onload()')
}

const stripAsciiWhitespace = (text: string) => text.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')
const asciiLowercase = (text: string) =>
  text.replace(/[A-Z]/g, (letter) => String.fromCharCode(letter.charCodeAt(0) + 32))

/** The elements under `root`, in tree order. The walk keeps its own stack, so no depth of nesting overflows it. */
function* elements(root: DefaultTreeAdapterTypes.ParentNode): Generator<DefaultTreeAdapterTypes.Element> {
  const stack = [...root.childNodes].reverse()
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (!('tagName' in node)) continue
    yield node
    for (let i = node.childNodes.length - 1; i >= 0; i--) stack.push(node.childNodes[i]!)
  }
}

/** Whether `element` is the HTML element `tagName`, rather than an SVG or MathML one. */
function isHtml(element: DefaultTreeAdapterTypes.Element, tagName: string): boolean {
  return element.tagName === tagName && element.namespaceURI === html.NS.HTML
}

function attribute(element: DefaultTreeAdapterTypes.Element, name: string): string | undefined {
  return element.attrs.find((attr) => attr.name === name)?.value
}

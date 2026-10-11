// The scan pipeline (§19): config → source store → discovery → analysis → attribution → findings → compare → policy →
// report. Only the source store reads bytes; every module after it is pure.

import { createHash } from 'node:crypto'
import { realms, type CatalogChangelog, type Realm, type SerializedCatalog } from './catalog.ts'
import {
  chunkRegistries,
  lexicalCollisions,
  type AnalyzeGroupOutput,
  type ArtifactSource,
  type Budget,
  type IneffectiveWrite,
  type ModuleLinking,
  type RealmDeclaration,
  type RealmOccurrence,
  type Resolver,
  type TraceStep,
} from './packages/analysis/index.ts'
import { groupJob } from './packages/analysis/job.ts'
import { attribution, type LockfileInput } from './packages/attribution/index.ts'
import type { Baseline, BaselineNote, PreviousValues } from './packages/baseline/index.ts'
import { compare, withCatalogStatus, withExplainedBy } from './packages/compare/index.ts'
import { aggregate, type ArtifactKey, type GroupStatistics, type LimitationRecord } from './packages/completeness/index.ts'
import type { ScanConfig } from './packages/config/index.ts'
import { discover, type Artifact, type Discovered, type ResolvedReference } from './packages/discovery/index.ts'
import {
  applySurface,
  buildFindings,
  buildIneffectiveWrites,
  compareStrings,
  fingerprintScheme,
  packageVersions,
  type ScopedLimitation,
} from './packages/findings/index.ts'
import { inProcessRunner, type GroupRunner } from './packages/parallel/index.ts'
import { applyPolicy } from './packages/policy/index.ts'
import type { ReportInput } from './packages/report/index.ts'
import { onceStore, type SourceStore } from './packages/source-store/index.ts'

export interface ScanDeps {
  store: SourceStore
  catalog: SerializedCatalog
  /** The catalog changelog shipped with the catalog, which `explainedBy` comes from (§4 Catalog versions). */
  changelog: CatalogChangelog
  resolver: Resolver
  monkeypatchlistVersion: string
  /**
   * The baseline to compare with (§11), its path as given, and scan-level notes on it such as version skew (§4), or null
   * for none. `previous` is the previous scan's values the reachability and install-context notes compare with (§11
   * Never `changed`): `--previous`'s, or the baseline's when it is a full report, or null for none.
   */
  baseline: { path: string; baseline: Baseline; notes: BaselineNote[]; previous: PreviousValues | null } | null
  crashGuard: CrashGuard
  /**
   * The step budget per source byte of a link group, and the caps (§18). Implementation detail, never a user flag: the
   * CLI passes the shipped constants, and the cost benchmark passes them multiplied for its raised-budget rerun.
   */
  budget: Budget
  /**
   * What runs the link groups (§18 Parallelism): by default the resolver in process, one group after another. Results
   * merge in group order whatever runs them, so a parallel runner prints the same report.
   */
  groups?: GroupRunner
  /**
   * The lockfile `--lockfile` names, read by the CLI (§10 Introducing dependencies), or null when none is given. It only
   * adds evidence: introducers, lockfile versions and workspaces (ADR 0006).
   */
  lockfile?: LockfileInput | null
}

/**
 * The wall-clock crash guard (§13, §18). The CLI reads the clock for it, so the pipeline stays free of wall-clock time.
 * It is asked before each link group, never inside one: once it has fired, no further group runs, and the scan is
 * `incomplete`. It never changes results: a scan whose guard fired reports no findings, whichever group it fired
 * before, so every baseline entry is `unconfirmed`.
 */
export interface CrashGuard {
  fired(): boolean
}

/** The order of an artifact's two source types, wherever a URL run both ways lists them. */
const sourceTypes = ['script', 'module'] as const

/**
 * Runs a scan, and returns everything the report needs except the `run` block.
 *
 * The scan runs in rounds (§19 References only the resolver can see): discover, analyze the link groups, take the
 * references only the resolver can see, and discover again with them, until a round's groups find no reference the
 * round didn't start from. Each round discovers and analyzes the whole artifact graph its references give, so the
 * result is the last round's: analyzing, over the final artifact set, every referenced entry's group, then each swept
 * artifact no group links, whatever rounds led there (The result doesn't depend on the rounds). A group whose job is
 * the same as in an earlier round isn't analyzed again: the resolver is a pure function of its job. `seed` gives the
 * first round's references.
 */
export async function scan(
  config: ScanConfig,
  deps: ScanDeps,
  seed: readonly ResolvedReference[] = [],
): Promise<Omit<ReportInput, 'run'>> {
  const store = onceStore(deps.store)
  const memo = new Map<string, AnalyzeGroupOutput>()
  const known = new Map(seed.map((reference) => [JSON.stringify(reference), reference]))
  let result: Round
  for (;;) {
    const references = [...known.values()].sort(byReferenceOrder)
    result = await round(config, deps, store, references, memo)
    const fresh = result.references.filter((reference) => !known.has(JSON.stringify(reference)))
    if (result.fired || fresh.length === 0) break
    for (const reference of fresh) known.set(JSON.stringify(reference), reference)
  }
  return finish(config, deps, result)
}

/** What one round gives (`round`). */
interface Round {
  discovered: Discovered
  found: RealmOccurrence[]
  declarations: RealmDeclaration[]
  ineffectiveWrites: IneffectiveWrite[]
  limitations: ScopedLimitation<LimitationRecord>[]
  statistics: GroupStatistics[]
  linking: Map<string, ModuleLinking>
  fired: boolean
  stopped: ArtifactKey[]
  /** The references only the resolver can see that its groups found, in URL order. */
  references: ResolvedReference[]
}

/** The order rounds process references in: by URL, then by the artifact they are in, its realm and where. */
function byReferenceOrder(a: ResolvedReference, b: ResolvedReference): number {
  return (
    compareStrings(a.url, b.url) ||
    compareStrings(a.from.url, b.from.url) ||
    compareStrings(a.from.fetched ?? '', b.from.fetched ?? '') ||
    realms.indexOf(a.realm) - realms.indexOf(b.realm) ||
    a.location.start - b.location.start ||
    compareStrings(a.kind, b.kind) ||
    compareStrings(a.load ?? '', b.load ?? '') ||
    Number(a.partial === true) - Number(b.partial === true) ||
    Number(a.none === true) - Number(b.none === true) ||
    (a.alternative?.start ?? -1) - (b.alternative?.start ?? -1) ||
    compareStrings(JSON.stringify(a.type ?? ''), JSON.stringify(b.type ?? '')) ||
    compareStrings(a.integrity ?? '', b.integrity ?? '') ||
    compareStrings(JSON.stringify(a.integrityAlternatives ?? ''), JSON.stringify(b.integrityAlternatives ?? '')) ||
    compareStrings(a.noModule ?? '', b.noModule ?? '')
  )
}

/**
 * One round (`scan`): discovers the artifact graph with `references`, and analyzes its link groups, taking a group's
 * analysis from `analyses` when an earlier round ran the same job, and adding each it runs.
 */
async function round(
  config: ScanConfig,
  deps: ScanDeps,
  store: SourceStore,
  references: readonly ResolvedReference[],
  memo: Map<string, AnalyzeGroupOutput>,
): Promise<Round> {
  const { catalog, resolver } = deps
  const discovered = await discover({ entries: config.entries, store, catalog, sourceMaps: config.sourceMaps, references })
  const { artifacts } = discovered

  // The artifacts the resolver can pull into a group, by realm: a URL in two realms is an artifact in each (§2 Realm).
  type Source = ArtifactSource & {
    id: string
    runs: boolean
    discovery: 'reference' | 'injected' | 'sweep'
    parent: string | null
    fetched?: string
  }
  const sources = new Map<Realm, Map<string, Source>>(realms.map((realm) => [realm, new Map()]))
  // The modules an import can name, by realm and artifact id (`artifactId`): a URL run both ways is imported as its
  // module.
  const modules = new Map<Realm, Map<string, Source>>(realms.map((realm) => [realm, new Map()]))
  const analyzable: Source[] = []
  for (const artifact of artifacts) {
    const { url, hash, sourceType, realm, realmBasis, text, runs, discovery, origin, parent } = artifact
    if (hash === null || text === null) continue
    const fetched = artifact.retrieval.requestedUrl
    const source: Source = {
      ...{ id: artifactId(artifact), url, hash, sourceType, realm, realmBasis, text, runs, discovery, origin, parent },
      ...(fetched === null || fetched === url ? {} : { fetched }),
    }
    analyzable.push(source)
    const inRealm = sources.get(realm)!
    if (!inRealm.has(url)) inRealm.set(url, source)
    const imported = modules.get(realm)!
    if (imported.get(source.id)?.sourceType !== 'module') imported.set(source.id, source)
  }

  // How discovery resolved each script's module requests (§6 Module links), by realm and entry document, whose import
  // maps resolve them, and as first resolved anywhere: a module that an unlinked swept file imports joins that file's
  // group in its assumed window realm (§19), so its own imports resolve as a reference elsewhere resolved them.
  // Scripts and modules are named by their artifact ids.
  const resolved = new Map<string, string>()
  const resolvedAnywhere = new Map<string, string>()
  const requestsFrom = new Map<string, string[]>()
  for (const { realm, document, from, specifier, to } of discovered.imports) {
    const importer = idOf(from)
    resolved.set(JSON.stringify([realm, document, importer, specifier]), idOf(to))
    if (!resolvedAnywhere.has(JSON.stringify([importer, specifier]))) {
      resolvedAnywhere.set(JSON.stringify([importer, specifier]), idOf(to))
      const list = requestsFrom.get(importer)
      if (list === undefined) requestsFrom.set(importer, [specifier])
      else list.push(specifier)
    }
  }
  const resolveIn = (realm: Realm, document: string | null) => (from: string, specifier: string) =>
    resolved.get(JSON.stringify([realm, document, from, specifier])) ?? resolvedAnywhere.get(JSON.stringify([from, specifier]))
  // The entry documents that run each artifact with references other than imports, each with its own import maps.
  const documents = new Map(
    discovered.documents.map(({ realm, url, documents }) => [JSON.stringify([realm, url]), documents] as const),
  )
  const documentsOf = ({ realm, url }: Source): (string | null)[] => documents.get(JSON.stringify([realm, url])) ?? [null]
  /** The module with id `id` an import in a group of `realm` names: the realm's own, or else another realm's. */
  const moduleIn = (realm: Realm, id: string): Source | undefined => {
    const own = modules.get(realm)!.get(id)
    if (own !== undefined) return own
    for (const other of realms) {
      const found = modules.get(other)!.get(id)
      if (found !== undefined) return found
    }
    return undefined
  }
  // The chunk registries each artifact's code pushes into and reads (§6 idiom 6), by artifact id, and the
  // build-directory artifacts that push each chunk id into each registry, by registry and id ('' for every id), in URL
  // order. A chunk is identified by its registry's name and its id, never by its URL.
  const registries = new Map<string, ReturnType<typeof chunkRegistries>>()
  const registryOf = (source: Source) => {
    let found = registries.get(source.id)
    if (found === undefined) registries.set(source.id, (found = chunkRegistries(source.text, source.sourceType)))
    return found
  }
  const pushers = new Map<string, Set<string>>()
  for (const source of [...analyzable].sort((a, b) => compareStrings(a.url, b.url) || compareStrings(a.id, b.id))) {
    if (source.origin !== 'local-build') continue
    for (const { registry, chunks } of registryOf(source).pushes) {
      for (const id of [...chunks, '']) {
        const key = JSON.stringify([registry, id])
        const list = pushers.get(key)
        if (list === undefined) pushers.set(key, new Set([source.id]))
        else list.add(source.id)
      }
    }
  }
  const chunksOf = (registry: string, id: string | null): string[] => [...(pushers.get(JSON.stringify([registry, id ?? ''])) ?? [])]
  // The remote chunks each loader's folded chunk URLs name (§2, §19), by realm and loader id: a remote chunk is no
  // build-directory pusher, so it joins only the groups of a loader that loads it.
  const remoteChunks = new Map<string, Source[]>()
  for (const { realm, loader, chunk } of discovered.remoteChunks) {
    const source = modules.get(realm)!.get(chunk)
    if (source === undefined) continue
    const key = JSON.stringify([realm, idOf(loader)])
    const list = remoteChunks.get(key)
    if (list === undefined) remoteChunks.set(key, [source])
    else if (!list.includes(source)) list.push(source)
  }
  /** The remote chunks `loader` loads that push the chunk id `id` (null: any) into `registry`, by artifact id. */
  const remoteChunksOf = (loader: Source, registry: string, id: string | null): string[] =>
    (remoteChunks.get(JSON.stringify([loader.realm, loader.id])) ?? [])
      .filter((chunk) => registryOf(chunk).pushes.some((push) => push.registry === registry && (id === null || push.chunks.includes(id))))
      .map((chunk) => chunk.id)
  /**
   * The chunks a source's loaders load: the build-directory pushers of each id their id tables map, and the remote
   * chunks the source loads that push one, by artifact id.
   */
  const loadedChunks = (source: Source): string[] =>
    registryOf(source).loads.flatMap(({ registry, ids }) =>
      (ids === null ? [null] : ids).flatMap((id) => [...chunksOf(registry, id), ...remoteChunksOf(source, registry, id)]),
    )

  // The classic scripts each entry document's script elements run (§6), in URL order: a page's initial chunks are
  // those that push into a registry a loader among them reads.
  const pageScripts = new Map<string, Source[]>()
  for (const source of [...analyzable].sort((a, b) => compareStrings(a.url, b.url) || compareStrings(a.id, b.id))) {
    if (source.realm !== 'window' || !source.runs || source.sourceType !== 'script' || source.parent === null) continue
    if (!documentsOf(source).includes(source.parent)) continue
    for (const document of documentsOf(source)) {
      const list = pageScripts.get(document ?? '')
      if (list === undefined) pageScripts.set(document ?? '', [source])
      else list.push(source)
    }
  }
  /** The other scripts of `document` that push into `registry`: the initial chunks of a loader there. */
  const initialChunksOf = (entry: Source, document: string | null, registry: string): Source[] =>
    (pageScripts.get(document ?? '') ?? []).filter(
      (script) => script !== entry && registryOf(script).pushes.some((push) => push.registry === registry),
    )
  /** The loaders among a document's scripts, by the registry they read: each registry's first loader in URL order. */
  const pageLoaders = (document: string | null): Map<string, Source> => {
    const loaders = new Map<string, Source>()
    for (const script of pageScripts.get(document ?? '') ?? []) {
      for (const { registry } of registryOf(script).loads) if (!loaders.has(registry)) loaders.set(registry, script)
    }
    return loaders
  }
  // The scripts a page's loader links as initial chunks, which are never analyzed on their own (§19).
  const initialChunks = new Set<Source>()
  for (const key of pageScripts.keys()) {
    const document = key === '' ? null : key
    const loaders = pageLoaders(document)
    for (const [registry, loader] of loaders) {
      for (const chunk of initialChunksOf(loader, document, registry)) if (loaders.get(registry) !== chunk) initialChunks.add(chunk)
    }
  }

  /**
   * The members a group's imports and chunk loaders reach from `entry`, as discovery resolved the imports, the entry
   * first (§6 Link groups).
   */
  const linkedFrom = (entry: Source, document: string | null = documentsOf(entry)[0]!): Source[] => {
    const seen = new Set<string>([entry.id])
    const queue = [entry]
    for (let next = 0; next < queue.length; next++) {
      const from = queue[next]!
      const imported = (requestsFrom.get(from.id) ?? []).map((specifier) => resolveIn(entry.realm, document)(from.id, specifier))
      const initial = registryOf(from).loads.flatMap(({ registry }) =>
        pageLoaders(document).get(registry) === entry ? initialChunksOf(entry, document, registry).map((chunk) => chunk.id) : [],
      )
      for (const id of [...imported, ...initial, ...loadedChunks(from)]) {
        const member = id === undefined || seen.has(id) ? undefined : moduleIn(entry.realm, id)
        if (member === undefined) continue
        seen.add(member.id)
        queue.push(member)
      }
    }
    return queue
  }

  // One group per analysis (§19 Link groups): first every artifact a reference other than an import runs, then each
  // one that only a preload names, then each one only the sweep found, each in URL order, a URL in several realms in
  // the order of `realms`, and one run both ways first as a classic script. A module only imports name is analyzed
  // only in its importers' groups. A preload-only or sweep-only artifact that a group links is never also analyzed on
  // its own, and of those that link each other, the first in group order is the entry of their group.
  const importedOnly = new Set(discovered.importedOnly.map(({ realm, url }) => JSON.stringify([realm, url])))
  const order = ({ runs, discovery }: Source) => (runs ? 0 : discovery !== 'sweep' ? 1 : 2)
  const byGroupOrder = (a: Source, b: Source) =>
    order(a) - order(b) ||
    compareStrings(a.url, b.url) ||
    compareStrings(a.id, b.id) ||
    realms.indexOf(a.realm) - realms.indexOf(b.realm) ||
    sourceTypes.indexOf(a.sourceType) - sourceTypes.indexOf(b.sourceType)
  const candidates = analyzable
    .filter((source) => !(source.sourceType === 'module' && importedOnly.has(JSON.stringify([source.realm, source.url]))))
    .sort(byGroupOrder)
  // An HTML-referenced script another entry's group links through a chunk registry is no group of its own.
  const entries = candidates.filter((source) => source.runs && !initialChunks.has(source))
  const linked = new Set(
    entries.flatMap((entry) => documentsOf(entry).flatMap((document) => linkedFrom(entry, document).slice(1))),
  )
  const unlinked = candidates.filter((source) => !source.runs && !linked.has(source))
  const reached = new Map(unlinked.map((source) => [source, new Set(linkedFrom(source).slice(1))]))
  const groupEntries = [
    ...entries,
    ...unlinked.filter((source) =>
      unlinked.every(
        (other) =>
          other === source ||
          !reached.get(other)!.has(source) ||
          (reached.get(source)!.has(other) && byGroupOrder(source, other) < 0),
      ),
    ),
  ]
  // Identical bytes with the same source type and realm are analyzed once (§2 Artifacts), and each copy of them, a URL
  // or an inline script, keeps its own record. So does the basis of the realm, which the resolver's output depends on
  // too (`realm-assumed`). The first copy in group order is the group's entry, and each other copy is given the
  // analysis's occurrences and records as its own. A group that links other artifacts is its entry's alone: its
  // imports resolve against its URL, through the import maps of the document that runs it: entry documents whose maps
  // link other members each have a group of their own.
  type Analysis = { entry: Source; copies: Source[]; members: Source[]; document: string | null }
  const analyses = new Map<string, Analysis>()
  const queue: Analysis[] = []
  const plan = (sources: readonly Source[], fresh = false) => {
    for (const source of sources) {
      for (const document of documentsOf(source)) {
        const members = linkedFrom(source, document)
        const identity = [source.hash, source.sourceType, source.realm, source.realmBasis]
        const linking = members.map(({ url }) => url)
        const key = JSON.stringify(members.length > 1 ? [...identity, source.id, linking] : identity)
        const analysis = fresh ? undefined : analyses.get(key)
        if (analysis === undefined) {
          const planned = { entry: source, copies: [source], members, document }
          analyses.set(key, planned)
          queue.push(planned)
        } else if (!analysis.copies.includes(source)) analysis.copies.push(source)
      }
    }
  }
  plan(groupEntries)
  // The artifacts a group was planned or ran for, as its entry, a copy of it, or a member, by realm, URL and source type.
  const covered = new Set<string>()
  const cover = (realm: Realm, url: string, sourceType: 'script' | 'module') =>
    covered.add(JSON.stringify([realm, url, sourceType]))
  const found: RealmOccurrence[] = []
  // Every classic script's top-level `let`, `const` and `class` declarations, for the scan-wide lexical-name check (§3).
  const declarations: RealmDeclaration[] = []
  const ineffectiveWrites: IneffectiveWrite[] = []
  const limitations: ScopedLimitation<LimitationRecord>[] = [...discovered.limitations]
  const statistics: GroupStatistics[] = []
  // Each analyzed artifact's module linking (§6), by its copy, realm and source type.
  const linking = new Map<string, ModuleLinking>()
  // A URL run both as a classic script and as a module is analyzed both ways (§2 Files that don't run as referenced).
  // A write both analyses find is one occurrence of it, at one place in one artifact.
  const occurrenceAnalyses = new Map<string, number>()
  const ineffectiveAnalyses = new Map<string, number>()
  // The crash guard is asked before each group, never inside one. Once it fires, no further group runs, and the
  // aggregator counts the artifacts it kept from being analyzed.
  let fired = false
  const stopped: ArtifactKey[] = []
  /**
   * Plans a group of its own for each artifact no group has covered once the planned groups have run, in group order:
   * a module whose only importer is no group's member, such as one only a classic preload's syntax-typed visit
   * imports. Whether any was planned.
   */
  const leftovers = (): boolean => {
    const left = analyzable
      .filter((source) => !covered.has(JSON.stringify([source.realm, source.id, source.sourceType])))
      .sort(byGroupOrder)
    if (left.length === 0) return false
    plan(left.slice(0, 1), true)
    return true
  }
  // A record of a member other than the entry is the member's own, whichever groups link it: it is kept once.
  const memberRecords = new Set<string>()
  // The artifacts the groups that ran linked, by realm and URL, so that each is stopped at most once.
  const reachedBy = new Set<string>()
  const groups = deps.groups ?? inProcessRunner(resolver, catalog, deps.budget)
  /** The group a planned analysis runs, as plain data that can cross a worker boundary (§19 Serializable seams). */
  const jobOf = ({ entry, document, members }: Analysis) => {
    const { url, hash, sourceType, realm, realmBasis } = entry
    const idOfName = (name: string) => (name === url ? entry.id : name)
    return groupJob({
      entry: { url, hash, sourceType, realm, realmBasis },
      // The entry is the copy analyzed, whatever other way its URL runs. Every other member is a module an import names,
      // named by its artifact id.
      artifact: (member) => {
        const source = member === url || member === entry.id ? entry : moduleIn(realm, member)
        if (source === undefined) return undefined
        const { hash, sourceType, realmBasis, text, origin } = source
        const named = source === entry ? url : source.id
        return { url: named, hash, sourceType, realm, realmBasis, text, ...(origin === undefined ? {} : { origin }) }
      },
      resolveImport: (from, specifier) => resolveIn(realm, document)(idOfName(from), specifier),
      requestsOf: (from) => requestsFrom.get(idOfName(from)) ?? [],
      chunks: (registry, id) =>
        [...new Set([...chunksOf(registry, id), ...members.flatMap((member) => remoteChunksOf(member, registry, id))])].filter(
          (chunk) => chunk !== entry.id,
        ),
      initialChunks: (registry) =>
        pageLoaders(document).get(registry) === entry ? initialChunksOf(entry, document, registry).map((chunk) => chunk.id) : [],
    })
  }
  // The planned groups run a batch at a time: those planned so far, then those `leftovers` plans once they have run.
  // Each batch's results merge in group order, whatever order they finish in (§18 Parallelism). The crash guard is
  // asked before each group starts, in group order.
  const results: (AnalyzeGroupOutput | undefined)[] = []
  // The references only the resolver can see the groups found, once each.
  const foundReferences: ResolvedReference[] = []
  const seen = new Set<string>()
  for (let index = 0; index < queue.length || leftovers(); index++) {
    if (index === results.length) {
      const batch = queue.slice(index)
      if (fired) results.push(...batch.map(() => undefined))
      else {
        // A job an earlier round ran gives the same analysis (§19 Purity), so only the others run.
        const jobs = batch.map(jobOf)
        const keys = jobs.map((job) => createHash('sha256').update(JSON.stringify(job)).digest('hex'))
        const fresh = jobs.filter((_, at) => !memo.has(keys[at]!))
        const ran = await groups.run(fresh, () => !(fired ||= deps.crashGuard.fired()))
        let next = 0
        for (const [at, key] of keys.entries()) {
          const known = memo.get(key)
          if (known !== undefined && !fresh.includes(jobs[at]!)) results.push(known)
          else {
            const output = ran[next++]
            if (output !== undefined) memo.set(key, output)
            results.push(output)
          }
        }
      }
    }
    const { entry, copies, members } = queue[index]!
    for (const copy of copies) cover(copy.realm, copy.id, copy.sourceType)
    const group = results[index]
    if (group === undefined) {
      stopped.push(...copies.map(({ url, realm, sourceType }) => ({ url, realm, sourceType })))
      for (const member of members.slice(1)) {
        cover(entry.realm, member.id, 'module')
        const key = JSON.stringify([member.realm, member.url, member.sourceType])
        if (reachedBy.has(key)) continue
        reachedBy.add(key)
        stopped.push({ url: member.url, realm: member.realm, sourceType: member.sourceType })
      }
      continue
    }
    for (const member of members.slice(1)) reachedBy.add(JSON.stringify([member.realm, member.url, member.sourceType]))
    const { url, sourceType, realm } = entry
    // A chunk a registry links is covered in the realm its own record is in too: a swept chunk a worker's group links
    // is no window sweep. A module an import links keeps its own realm's analysis.
    for (const member of group.members.slice(1)) {
      cover(realm, member.url, member.sourceType)
      const record = moduleIn(realm, member.url)
      if (record !== undefined && registryOf(record).pushes.length > 0) cover(record.realm, record.id, record.sourceType)
    }
    // Each member of the group other than its entry, by its artifact id, which the resolver names it by.
    for (const member of group.members.slice(1)) {
      const linked = group.moduleLinking[member.url]
      const record = moduleIn(realm, member.url)
      if (linked === undefined || record === undefined) continue
      const key = JSON.stringify([record.id, record.realm, record.sourceType])
      const before = linking.get(key)
      linking.set(key, before === undefined ? linked : { ...before, linkGroups: before.linkGroups + 1 })
    }
    for (const copy of copies) {
      /** The artifact id an occurrence's artifact names: the copy for the entry, and each other member's own. */
      const own = (artifact: string) => (artifact === url ? copy.id : artifact)
      /** The URL of an artifact a trace step names. */
      const urlOf = (artifact: string) => (artifact === url ? copy.url : (moduleIn(realm, artifact)?.url ?? artifact))
      const owned = <T extends { artifact: string; lookup: { artifact?: string }; trace: TraceStep[] }>(write: T): T => {
        const lookup = write.lookup.artifact === undefined ? write.lookup : { ...write.lookup, artifact: own(write.lookup.artifact) }
        const trace = write.trace.map((step) =>
          step.kind !== 'module-link' && 'artifact' in step && typeof step.artifact === 'string'
            ? { ...step, artifact: urlOf(step.artifact) }
            : step,
        )
        return { ...write, artifact: own(write.artifact), lookup, trace }
      }
      const linked = group.moduleLinking[url]
      if (linked !== undefined) linking.set(JSON.stringify([copy.id, realm, sourceType]), linked)
      // A reference only the resolver can see is in the member whose code holds it (§19).
      for (const { artifact: of, ...found } of group.references) {
        const holder = of === url ? copy : moduleIn(realm, of)
        if (holder === undefined || (found.kind === 'chunk') !== (found.load !== undefined)) continue
        const from = { url: holder.url, ...(holder.fetched === undefined ? {} : { fetched: holder.fetched }) }
        const record: ResolvedReference = { realm, from, ...found }
        const key = JSON.stringify(record)
        if (!seen.has(key)) {
          seen.add(key)
          foundReferences.push(record)
        }
      }
      for (const occurrence of group.occurrences) {
        const mine = owned(occurrence)
        const key = JSON.stringify(mine)
        if ((occurrenceAnalyses.get(key) ?? index) !== index) continue
        occurrenceAnalyses.set(key, index)
        found.push({ realm, occurrence: mine })
      }
      for (const declaration of group.lexicalDeclarations ?? []) {
        const mine = declaration.artifact === url ? { ...declaration, artifact: copy.url } : declaration
        declarations.push({ realm, id: mine.artifact === copy.url ? copy.id : mine.artifact, declaration: mine })
      }
      // An ineffective write is copied as an occurrence is (§3 Record).
      for (const write of group.ineffectiveWrites) {
        const mine = owned(write)
        const key = JSON.stringify(mine)
        if ((ineffectiveAnalyses.get(key) ?? index) !== index) continue
        ineffectiveAnalyses.set(key, index)
        ineffectiveWrites.push(mine)
      }
      // A record's candidate targets, in the group's realm, are data for the surface filter (§12), and don't cross
      // into the report.
      for (const { kind, artifact: of, location, detail, candidates } of group.limitations) {
        const artifact = { ...of, url: urlOf(of.url) }
        const record = {
          kind,
          artifact,
          ...(location === undefined ? {} : { location }),
          detail,
          ...(candidates === undefined ? {} : { candidates: candidates.map((name) => ({ realm, name })) }),
        }
        if (of.url !== url) {
          const key = JSON.stringify(record)
          if (memberRecords.has(key)) continue
          memberRecords.add(key)
        }
        limitations.push(record)
      }
    }
    statistics.push(group.stats)
  }
  return {
    found,
    declarations,
    ineffectiveWrites,
    limitations,
    statistics,
    linking,
    fired,
    stopped,
    discovered,
    references: foundReferences.sort(byReferenceOrder),
  }
}

/**
 * The scan after it, until the report: noting lexical collisions, attribution, findings, completeness, comparison and
 * the policy, over the last round's results.
 */
async function finish(config: ScanConfig, deps: ScanDeps, result: Round): Promise<Omit<ReportInput, 'run'>> {
  const { catalog, resolver } = deps
  const { found, declarations, ineffectiveWrites, limitations, statistics, linking, fired, stopped, discovered } = result
  const { artifacts } = discovered
  // A write that reads bare a name another classic script in its realm declares lexically is noted (§3).
  const occurrences = lexicalCollisions(found, declarations, catalog)

  // Each URL or inline copy of identical bytes is attributed through its own map (§2 Artifacts).
  const read = artifacts.flatMap((artifact) => {
    const { url, hash, origin, text, sourceMap, map } = artifact
    if (hash === null || text === null) return []
    return [{ id: artifactId(artifact), url, hash, origin, text, map: map && { ...map, method: sourceMap.method } }]
  })
  const attributed = attribution(read, catalog, deps.lockfile ?? null)
  // A scan whose crash guard fired reports no findings (§13): the groups that ran keep only their records and counts.
  const detected = fired ? [] : buildFindings(attributed.attribute(occurrences), catalog)
  const ineffective = fired ? [] : buildIneffectiveWrites(attributed.attributeIneffective(ineffectiveWrites), catalog)
  // `--surface` limits what the scan reports, baselines and gates (§12): findings, ineffective writes and the
  // `unresolved-holder` records.
  const scoped = applySurface({ findings: detected, ineffectiveWrites: ineffective, limitations }, config.surface, catalog)
  const { findings } = scoped
  const completeness = aggregate({
    artifacts,
    limitations: scoped.limitations,
    html: discovered.html,
    statistics,
    budget: deps.budget,
    crashGuard: { fired, stopped },
    swept: discovered.swept,
    findings,
    sourceMapDirectories: discovered.sourceMapDirectories,
    introducers: attributed.introducers,
  })
  // The strong versions of the findings' containing packages (§10 Version), which the report and baseline carry (§11).
  const packages = packageVersions(findings)
  const baseline = deps.baseline?.baseline ?? null
  // Each delta a catalog change since the baseline's catalog version could explain carries its change records, and
  // each finding of a retained target says so (§4 Catalog versions).
  const compared = withExplainedBy(
    withCatalogStatus(compare(findings, baseline, completeness, packages, deps.baseline?.previous ?? null), catalog),
    {
      catalog,
      changelog: deps.changelog,
      baselineCatalogVersion: baseline === null ? null : baseline.catalogVersion,
      surface: config.surface,
    },
  )
  const failOn = config.command === 'scan' ? config.failOn : []
  const policed = applyPolicy(compared, { failOn, level: completeness.level, allowIncomplete: config.allowIncomplete })
  return {
    tool: {
      monkeypatchlistVersion: deps.monkeypatchlistVersion,
      catalogVersion: catalog.metadata.catalogVersion,
      analyzerVersion: resolver.analyzerVersion,
      fingerprintScheme,
    },
    application: { name: config.name },
    config: {
      scanConfigId: config.scanConfigId,
      surface: config.surface,
      mode: config.mode,
      entries: config.entries,
      mappings: config.mappings,
      sourceMaps: config.sourceMaps,
      lockfile: config.lockfile,
      failOn,
    },
    gate: policed.gate,
    outOfScopeBySurface: scoped.outOfScopeBySurface,
    completeness,
    baseline: deps.baseline,
    packages,
    findings: policed.findings,
    ineffectiveWrites: scoped.ineffectiveWrites,
    // An artifact no group analyzed links nothing (§6).
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      moduleLinking: linking.get(JSON.stringify([artifactId(artifact), artifact.realm, artifact.sourceType])) ?? {
        idioms: [],
        modules: 0,
        unlinked: 0,
        linkGroups: 0,
      },
    })),
  }
}

/**
 * The name an artifact's occurrences give it: its URL, and the URL it was fetched at when that isn't its URL. One key
 * URL reached through two fetched URLs (§11) is an artifact record of each, both analyzed.
 */
function artifactId({ url, retrieval }: Pick<Artifact, 'url' | 'retrieval'>): string {
  return idOf({ url, ...(retrieval.requestedUrl === null ? {} : { fetched: retrieval.requestedUrl }) })
}

/** The id of the artifact at `url` fetched at `fetched` (`artifactId`). */
function idOf({ url, fetched }: { url: string; fetched?: string }): string {
  return fetched === undefined || fetched === url ? url : `${url} ${fetched}`
}

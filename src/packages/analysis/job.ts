// A link group as plain data (§18 Parallelism, §19 Serializable seams): the resolver seam's callbacks, `artifact`,
// `resolveImport`, `chunks` and `initialChunks`, written out as the tables they read, so that a group can cross a
// worker boundary as JSON and be analyzed there exactly as it would be in process.

import type { SerializedCatalog } from '../../catalog.ts'
import type { Budget } from './lib/budget.ts'
import { chunkRegistries } from './lib/chunk-registry.ts'
import type { AnalyzeGroupOutput, ArtifactRef, ArtifactSource, Resolver } from './lib/types.ts'

/** One link group's analysis, as plain JSON-serializable data. */
export interface GroupJob {
  entry: ArtifactRef
  /** Each name `artifact(name)` may be asked for, with what it returns, in the order they were found. */
  artifacts: [name: string, source: ArtifactSource][]
  /** Each module request `resolveImport(from, specifier)` resolves, with the name it resolves to. */
  imports: [from: string, specifier: string, to: string][]
  /** Each chunk lookup `chunks(registry, id)` answers (§6 idiom 6), with the names it returns; `null` is every id. */
  chunks?: [registry: string, id: string | null, names: string[]][]
  /** Each lookup `initialChunks(registry)` answers, with the names it returns. */
  initialChunks?: [registry: string, names: string[]][]
}

/**
 * Writes the group of `entry` out as a job: every artifact the seam's callbacks can reach from it, through the module
 * requests `requestsOf` lists for each importer and the chunk registries each one's loaders read, and what each request
 * and chunk lookup resolves to. A request `requestsOf` doesn't list resolves to nothing, as `resolveImport` must say
 * for it too.
 */
export function groupJob(input: {
  entry: ArtifactRef
  artifact(name: string): ArtifactSource | undefined
  resolveImport(from: string, specifier: string): string | undefined
  requestsOf(from: string): readonly string[]
  chunks?(registry: string, id: string | null): readonly string[]
  initialChunks?(registry: string): readonly string[]
}): GroupJob {
  const artifacts = new Map<string, ArtifactSource>()
  const imports: GroupJob['imports'] = []
  const chunks = new Map<string, [registry: string, id: string | null, names: string[]]>()
  const initialChunks = new Map<string, string[]>()
  const queue = [input.entry.url]
  const seen = new Set(queue)
  const reach = (to: string) => {
    if (seen.has(to)) return
    seen.add(to)
    queue.push(to)
  }
  for (let next = 0; next < queue.length; next++) {
    const name = queue[next]!
    const source = input.artifact(name)
    if (source === undefined) continue
    artifacts.set(name, source)
    for (const specifier of input.requestsOf(source.url)) {
      const to = input.resolveImport(source.url, specifier)
      if (to === undefined) continue
      imports.push([source.url, specifier, to])
      reach(to)
    }
    if (input.chunks === undefined && input.initialChunks === undefined) continue
    // The chunks the source's loaders link (§6 idiom 6), looked up as the link group looks them up.
    for (const { registry, ids } of chunkRegistries(source.text, source.sourceType).loads) {
      if (input.initialChunks !== undefined && !initialChunks.has(registry)) {
        const names = [...input.initialChunks(registry)]
        initialChunks.set(registry, names)
        names.forEach(reach)
      }
      if (input.chunks === undefined) continue
      for (const id of ids ?? [null]) {
        const key = JSON.stringify([registry, id])
        if (chunks.has(key)) continue
        const names = [...input.chunks(registry, id)]
        chunks.set(key, [registry, id, names])
        names.forEach(reach)
      }
    }
  }
  return {
    entry: input.entry,
    artifacts: [...artifacts],
    imports,
    ...(chunks.size === 0 ? {} : { chunks: [...chunks.values()] }),
    ...(initialChunks.size === 0 ? {} : { initialChunks: [...initialChunks] }),
  }
}

/** The UTF-8 bytes of a job's artifacts, which its step budget and its estimated peak heap scale with (§18). */
export function jobBytes(job: GroupJob): number {
  return job.artifacts.reduce((bytes, [, { text }]) => bytes + Buffer.byteLength(text, 'utf8'), 0)
}

/** Analyzes a job with `resolver`, answering the seam's callbacks from the job's tables. */
export function analyzeJob(
  resolver: Resolver,
  job: GroupJob,
  catalog: SerializedCatalog,
  budget: Budget,
): AnalyzeGroupOutput {
  const artifacts = new Map(job.artifacts)
  const imports = new Map(job.imports.map(([from, specifier, to]) => [JSON.stringify([from, specifier]), to]))
  const chunks = new Map((job.chunks ?? []).map(([registry, id, names]) => [JSON.stringify([registry, id]), names]))
  const initialChunks = new Map(job.initialChunks ?? [])
  return resolver.analyzeGroup({
    entry: job.entry,
    artifact: (name) => artifacts.get(name),
    resolveImport: (from, specifier) => imports.get(JSON.stringify([from, specifier])),
    chunks: (registry, id) => chunks.get(JSON.stringify([registry, id])) ?? [],
    initialChunks: (registry) => initialChunks.get(registry) ?? [],
    catalog,
    budget,
  })
}

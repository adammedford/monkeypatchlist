// The installed-package graph every lockfile format reads into (§10 Introducing dependencies), and the parts the
// formats share. Pure.

/** An installed package: its key in the lockfile, its name and version (`''` when the lockfile records none). */
export interface Node {
  key: string
  name: string
  version: string
}

/**
 * A workspace (importer): its folder relative to the lockfile's directory (`''` for the root), and its name and version
 * as the lockfile records them, which are evidence (§10 Provenance) and what `lockfile.importer` may name.
 */
export interface Workspace {
  folder: string
  name: string | null
  version: string | null
}

/**
 * Where a lockfile puts a package directory (§10 Walk, Vendored):
 * - `installed`: the nodes it is (several only for one version's peer variants)
 * - `vendored`: the lockfile says it isn't installed; `around` is the installed package whose directory holds it, if any
 * - `unplaced`: the lockfile can't say which copy it is
 */
export type Placed =
  | { kind: 'installed'; nodes: Node[] }
  | { kind: 'vendored'; around: Node[] }
  | { kind: 'unplaced' }

/** A lockfile read into an installed-package graph. */
export interface Lockfile {
  format: 'npm' | 'bun' | 'pnpm' | 'yarn'
  /** Whether it is keyed by install path, so a strong version source (§10 Version): `package-lock.json`, `bun.lock`. */
  keyedByInstallPath: boolean
  /** How certain what it derives is: `yarn.lock`'s facts are capped at `medium` (§10 Formats). */
  confidence: 'high' | 'medium'
  workspaces: Workspace[]
  /**
   * Why no importer can be picked, whatever the first-party paths are: a manifest that the importer's direct
   * dependencies needed and that is missing or unreadable. Null otherwise.
   */
  unresolved: string | null
  /** Where the lockfile puts a package's directory, as a map path gives it. */
  place(directory: readonly string[]): Placed
  /** The nodes of `name` at `version`, wherever installed. */
  named(name: string, version: string): Node[]
  /**
   * The introducers of the nodes `from` for the importer `workspace` (§10 Walk): its direct dependencies whose
   * installed tree includes one of them, as `name@version`, sorted. A direct dependency introduces itself.
   */
  introducers(from: readonly Node[], workspace: Workspace): string[]
}

/** A lockfile read, or why none is usable, with the format version as evidence. */
export type ReadLockfile = { lockfile: Lockfile } | { unusable: string }

/** A node's `name@version`, or its name alone when the lockfile records no version. */
export const nameAtVersion = ({ name, version }: Node): string => (version === '' ? name : `${name}@${version}`)

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A lockfile over `nodes`, whose dependency edges and workspaces' direct dependencies are resolved by the format. */
export function graph(parts: {
  format: Lockfile['format']
  keyedByInstallPath: boolean
  confidence: Lockfile['confidence']
  nodes: Iterable<Node>
  workspaces: Workspace[]
  unresolved?: string | null
  /** The nodes a node depends on: `dependencies`, `optionalDependencies` and resolved peers. */
  edges: (node: Node) => Node[]
  /** A workspace's direct dependencies, its dev dependencies included. */
  direct: (workspace: Workspace) => Node[]
  place: (directory: readonly string[]) => Placed
}): Lockfile {
  const nodes = [...parts.nodes]
  const { edges, direct } = parts
  let reverse: Map<Node, Node[]> | undefined
  const dependents = (): Map<Node, Node[]> => {
    if (reverse !== undefined) return reverse
    reverse = new Map()
    for (const node of nodes) {
      for (const target of edges(node)) {
        const list = reverse.get(target)
        if (list === undefined) reverse.set(target, [node])
        else if (!list.includes(node)) list.push(node)
      }
    }
    return reverse
  }
  return {
    format: parts.format,
    keyedByInstallPath: parts.keyedByInstallPath,
    confidence: parts.confidence,
    workspaces: parts.workspaces,
    unresolved: parts.unresolved ?? null,
    place: parts.place,
    named: (name, version) => nodes.filter((node) => node.name === name && node.version === version),
    introducers(from, workspace) {
      const directs = new Set(direct(workspace))
      const seen = new Set<Node>(from)
      const queue = [...from]
      for (let next = 0; next < queue.length; next++) {
        for (const dependent of dependents().get(queue[next]!) ?? []) {
          if (seen.has(dependent)) continue
          seen.add(dependent)
          queue.push(dependent)
        }
      }
      const found = [...seen].filter((node) => directs.has(node)).map(nameAtVersion)
      return [...new Set(found)].sort(compareText)
    },
  }
}

/** The package names of a `node_modules/<a>/node_modules/<b>` chain, or null when it is no such chain. */
export function installChain(segments: readonly string[]): string[] | null {
  const out: string[] = []
  for (let i = 0; i < segments.length; ) {
    if (segments[i] !== 'node_modules') return null
    const next = segments[i + 1]
    if (next === undefined || next.startsWith('.')) return null
    if (next.startsWith('@')) {
      if (segments[i + 2] === undefined) return null
      out.push(`${next}/${segments[i + 2]}`)
      i += 3
    } else {
      out.push(next)
      i += 2
    }
  }
  return out.length === 0 ? null : out
}

/** The nodes when they are all one version, or null: several versions leave the copy unknown. */
function oneVersion(nodes: readonly Node[]): Node[] | null {
  if (nodes.length === 0) return null
  return nodes.every((node) => node.version === nodes[0]!.version) ? [...new Set(nodes)] : null
}

/**
 * Where a lockfile that isn't keyed by install path (`pnpm-lock.yaml`, `yarn.lock`) puts a package directory: by the
 * names of its `node_modules` chain. The first name is the workspace's (the folder before the chain) or else the root's
 * direct dependency of that name, or else the lockfile's only version of it; each further name is what the package
 * before it depends on by that name. A name the lockfile doesn't install at all is vendored, in the package before it.
 * Anything else is unplaced: the lockfile doesn't record where its copies are installed.
 */
export function placeByName(
  directory: readonly string[],
  byName: ReadonlyMap<string, Node[]>,
  workspaces: readonly Workspace[],
  edges: (node: Node) => Node[],
  direct: (workspace: Workspace) => Node[],
): Placed {
  const top = (name: string, holders: (Workspace | undefined)[]): Node[] | null => {
    for (const holder of holders) {
      const one = holder === undefined ? null : oneVersion(direct(holder).filter((node) => node.name === name))
      if (one !== null) return one
    }
    return oneVersion(byName.get(name)!)
  }
  for (let i = 0; i < directory.length; i++) {
    if (directory[i] !== 'node_modules') continue
    const chain = installChain(directory.slice(i))
    if (chain === null) continue
    const before = directory.slice(0, i).join('/')
    const root = workspaces.find(({ folder }) => folder === '')
    const workspace = workspaces
      .filter(({ folder }) => folder !== '' && (before === folder || before.endsWith(`/${folder}`)))
      .sort((a, b) => b.folder.length - a.folder.length)[0]
    let current: Node[] = []
    for (let k = 0; k < chain.length; k++) {
      const name = chain[k]!
      if ((byName.get(name) ?? []).length === 0) return { kind: 'vendored', around: current }
      const candidates =
        k === 0
          ? top(name, [workspace, root])
          : oneVersion(current.flatMap(edges).filter((node) => node.name === name))
      if (candidates === null) return { kind: 'unplaced' }
      current = candidates
    }
    return { kind: 'installed', nodes: current }
  }
  return { kind: 'unplaced' }
}

/** A `package.json` manifest's dependency lists: only these are read from it. */
export interface Manifest {
  name: string | null
  version: string | null
  /** `dependencies`, `optionalDependencies` and `peerDependencies`, by name, with their ranges. */
  production: [string, string][]
  /** `devDependencies`, by name, with their ranges. */
  development: [string, string][]
}

/** A manifest's text read, or null when it is missing or isn't a manifest. */
export function readManifest(text: string | null | undefined): Manifest | null {
  if (text === null || text === undefined) return null
  let value: unknown
  try {
    value = JSON.parse(text.startsWith('﻿') ? text.slice(1) : text)
  } catch {
    return null
  }
  if (!isRecord(value)) return null
  const list = (field: unknown): [string, string][] =>
    isRecord(field) ? Object.entries(field).flatMap(([name, range]) => (typeof range === 'string' ? [[name, range] as [string, string]] : [])) : []
  return {
    name: typeof value.name === 'string' ? value.name : null,
    version: typeof value.version === 'string' ? value.version : null,
    production: [...list(value.dependencies), ...list(value.optionalDependencies), ...list(value.peerDependencies)],
    development: list(value.devDependencies),
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A folder relative to the lockfile's directory, normalized: `.` is `''`, and `./`, `x/..` and a trailing `/` go. */
export function normalizeFolder(folder: string): string {
  const out: string[] = []
  for (const segment of folder.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..' && out.length > 0 && out.at(-1) !== '..') out.pop()
    else out.push(segment)
  }
  return out.join('/')
}

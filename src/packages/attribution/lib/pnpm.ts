// `pnpm-lock.yaml` (§10 Introducing dependencies): `lockfileVersion` 6.0 and 9.x; any other version is unusable.
// It records each importer's direct dependencies, dev ones apart, and each package's resolved dependencies, peers
// included. It is keyed by name and version, not by install path, so it gives no version (§10 Version). Pure.

import {
  graph,
  isRecord,
  normalizeFolder,
  placeByName,
  readManifest,
  type Node,
  type ReadLockfile,
  type Workspace,
} from './lockfile-graph.ts'
import { readYaml } from './yaml.ts'

/** A package snapshot or an importer, with its dependency references: name → version or key. */
interface PnpmNode extends Node {
  /** `dependencies` and `optionalDependencies`: for a package, its resolved peers too. */
  production: [string, string][]
  /** An importer's `devDependencies`. */
  development: [string, string][]
  /** The importer's folder, for an importer. */
  folder?: string
}

/** A dependency map's references: a 9.0 or 6.0 package's `name: version`, or an importer's `name: { version }`. */
function references(value: unknown): [string, string][] {
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([name, each]) => {
    const version = isRecord(each) ? each.version : each
    return typeof version === 'string' ? [[name, version] as [string, string]] : []
  })
}

/** A package key's name and version: `name@1.0.0(peer@2.0.0)`, or 6.0's `/name@1.0.0(peer@2.0.0)`. */
function identOf(key: string): { name: string; version: string } | null {
  const bare = key.startsWith('/') ? key.slice(1) : key
  const split = bare.indexOf('@', 1)
  if (split <= 0) return null
  const rest = bare.slice(split + 1)
  const peers = rest.indexOf('(')
  return { name: bare.slice(0, split), version: peers < 0 ? rest : rest.slice(0, peers) }
}

export function readPnpm(text: string, file: string, manifests: Readonly<Record<string, string | null>>): ReadLockfile {
  const doc = readYaml(text)
  if (!isRecord(doc)) return { unusable: `${file} is not a pnpm lockfile` }
  const version = typeof doc.lockfileVersion === 'string' ? doc.lockfileVersion : null
  const v9 = version !== null && /^9\.\d+$/.test(version)
  if (!v9 && version !== '6.0') return { unusable: `${file} lockfileVersion ${version ?? 'null'}` }
  // A 6.0 lockfile of a project with no workspaces keeps its importer's lists at the top.
  const importers: Record<string, unknown> = isRecord(doc.importers) ? doc.importers : { '.': doc }
  const snapshots = v9 ? doc.snapshots : doc.packages
  const nodes = new Map<string, PnpmNode>()
  for (const [key, entry] of Object.entries(isRecord(snapshots) ? snapshots : {})) {
    const ident = identOf(key)
    if (ident === null) continue
    const own = isRecord(entry) ? entry : {}
    nodes.set(key, {
      key,
      ...ident,
      production: [...references(own.dependencies), ...references(own.optionalDependencies)],
      development: [],
    })
  }
  const workspaces: Workspace[] = []
  const importerNodes = new Map<string, PnpmNode>()
  for (const [path, entry] of Object.entries(importers)) {
    if (!isRecord(entry)) continue
    const folder = normalizeFolder(path)
    // pnpm records no importer's name or version: a linked workspace's come from its manifest, when it is readable.
    const manifest = readManifest(manifests[folder])
    workspaces.push({ folder, name: null, version: null })
    importerNodes.set(folder, {
      key: `importer:${folder}`,
      name: manifest?.name ?? '',
      version: manifest?.version ?? '',
      folder,
      production: [...references(entry.dependencies), ...references(entry.optionalDependencies)],
      development: references(entry.devDependencies),
    })
  }
  /** The node a reference from `from` names: a linked importer, a package key, or an alias's key. */
  const target = (from: PnpmNode, name: string, reference: string): PnpmNode[] => {
    if (reference.startsWith('link:')) {
      const linked = importerNodes.get(normalizeFolder(`${from.folder ?? ''}/${reference.slice('link:'.length)}`))
      return linked === undefined ? [] : [linked]
    }
    const keys = v9 ? [`${name}@${reference}`, reference] : [`/${name}@${reference}`, reference, `/${reference}`]
    for (const key of keys) {
      const found = nodes.get(key)
      if (found !== undefined) return [found]
    }
    return []
  }
  const edges = (node: Node): Node[] => {
    const own = node as PnpmNode
    return own.production.flatMap(([name, reference]) => target(own, name, reference))
  }
  const direct = (workspace: Workspace): Node[] => {
    const importer = importerNodes.get(workspace.folder)
    if (importer === undefined) return []
    return [...importer.production, ...importer.development].flatMap(([name, reference]) => target(importer, name, reference))
  }
  // Each importer is named by what refers to it when its manifest doesn't name it.
  for (const node of [...nodes.values(), ...importerNodes.values()]) {
    for (const [name, reference] of [...node.production, ...node.development]) {
      if (!reference.startsWith('link:')) continue
      const linked = importerNodes.get(normalizeFolder(`${node.folder ?? ''}/${reference.slice('link:'.length)}`))
      if (linked !== undefined && linked.name === '') linked.name = name
    }
  }
  const all = [...nodes.values(), ...[...importerNodes.values()].filter((node) => node.name !== '')]
  const byName = new Map<string, Node[]>()
  // A named workspace is installed too (linked into `node_modules`), so code under its name there is no vendored code.
  // The root is no package anything installs.
  for (const node of all) {
    if (node.folder === '' || node.name === '') continue
    const list = byName.get(node.name)
    if (list === undefined) byName.set(node.name, [node])
    else list.push(node)
  }
  return {
    lockfile: graph({
      format: 'pnpm',
      keyedByInstallPath: false,
      confidence: 'high',
      nodes: all,
      workspaces,
      edges,
      direct,
      place: (directory) => placeByName(directory, byName, workspaces, edges, direct),
    }),
  }
}

/** The importer folders a `pnpm-lock.yaml` names, besides its own directory, whose manifests name linked workspaces. */
export function pnpmFolders(text: string): string[] {
  const doc = readYaml(text)
  if (!isRecord(doc) || !isRecord(doc.importers)) return []
  return Object.keys(doc.importers).map(normalizeFolder).filter((folder) => folder !== '')
}

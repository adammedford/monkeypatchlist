// `yarn.lock` (§10 Introducing dependencies): Yarn v1, and Berry at every `__metadata.version`. It resolves each
// descriptor (`name@range`) to a package, but records neither the importer's direct dependencies nor the dev/prod
// split, so those come from the `package.json` manifests beside it: its own directory's, and the workspaces'
// (v1 through its `workspaces` globs, Berry through its workspace entries). A missing or unreadable one leaves the
// importer unresolved. It isn't keyed by install path, so it gives no version (§10 Version), and what it derives is
// capped at `medium`. Pure.

import {
  graph,
  isRecord,
  normalizeFolder,
  placeByName,
  readManifest,
  type Manifest,
  type Node,
  type ReadLockfile,
  type Workspace,
} from './lockfile-graph.ts'
import { readYaml } from './yaml.ts'

/** A package or workspace, with its dependencies and peers by name and range. */
interface YarnNode extends Node {
  /** `dependencies` and `optionalDependencies`; a workspace's from its manifest, without its dev dependencies. */
  production: [string, string][]
  peers: string[]
  /** The workspace's folder, for a workspace. */
  folder?: string
}

/** A lockfile entry: the descriptors its key lists, and its fields. */
interface Entry {
  descriptors: string[]
  fields: Record<string, unknown>
}

const v1Header = /^# yarn lockfile v1\s*$/m

/** A descriptor's package name: `name@range`, a scope's `@` kept. */
function nameOf(descriptor: string): string | null {
  const split = descriptor.indexOf('@', 1)
  return split <= 0 ? null : descriptor.slice(0, split)
}

/** A dependency map's `[name, range]` pairs. */
function ranges(value: unknown): [string, string][] {
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([name, range]) => (typeof range === 'string' ? [[name, range] as [string, string]] : []))
}

/** A key's descriptors: `a@1, "a@2"` lists several. */
function descriptorsOf(key: string): string[] {
  return key
    .split(/,\s*/)
    .map((part) => part.trim().replace(/^"(.*)"$/, '$1'))
    .filter((part) => part !== '')
}

/** The entries of a Yarn v1 lockfile, or null when it isn't one. */
function readV1(text: string): Entry[] | null {
  const entries: Entry[] = []
  /** The open maps, by indent: the entry's fields, then a dependency block. */
  let stack: { indent: number; map: Record<string, unknown> }[] = []
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trimStart().startsWith('#')) continue
    const indent = raw.length - raw.trimStart().length
    const line = raw.trim()
    if (indent === 0) {
      if (!line.endsWith(':')) return null
      const fields: Record<string, unknown> = {}
      entries.push({ descriptors: descriptorsOf(line.slice(0, -1)), fields })
      stack = [{ indent: 0, map: fields }]
      continue
    }
    while (stack.length > 1 && stack.at(-1)!.indent >= indent) stack.pop()
    const holder = stack.at(-1)
    if (holder === undefined) return null
    const pair = /^("(?:[^"\\]|\\.)*"|[^\s"]+)(?::$|\s+(.*)$)/.exec(line)
    if (pair === null) return null
    const key = unquote(pair[1]!)
    if (pair[2] === undefined) {
      const map: Record<string, unknown> = {}
      Object.defineProperty(holder.map, key, { value: map, enumerable: true, writable: true, configurable: true })
      stack.push({ indent, map })
    } else {
      Object.defineProperty(holder.map, key, { value: unquote(pair[2]), enumerable: true, writable: true, configurable: true })
    }
  }
  return entries
}

function unquote(text: string): string {
  if (!text.startsWith('"')) return text
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'string' ? value : text
  } catch {
    return text.slice(1, -1)
  }
}

/** The entries of a Yarn Berry lockfile and its `__metadata.version`, or null when it isn't one. */
function readBerry(text: string): Entry[] | null {
  const doc = readYaml(text)
  if (!isRecord(doc) || !isRecord(doc.__metadata) || typeof doc.__metadata.version !== 'string') return null
  return Object.entries(doc).flatMap(([key, fields]) =>
    key === '__metadata' || !isRecord(fields) ? [] : [{ descriptors: descriptorsOf(key), fields }],
  )
}

/** A Berry workspace entry's folder, from its resolution `name@workspace:<folder>`, or null for a package. */
function workspaceFolder(fields: Record<string, unknown>): string | null {
  const resolution = typeof fields.resolution === 'string' ? fields.resolution : null
  const name = resolution === null ? null : nameOf(resolution)
  if (resolution === null || name === null) return null
  const reference = resolution.slice(name.length + 1)
  return reference.startsWith('workspace:') ? normalizeFolder(reference.slice('workspace:'.length)) : null
}

/** The manifests a `yarn.lock` needs besides its own directory's: Berry's workspace folders, or v1's globs. */
export function yarnManifests(text: string, root: string | null): { folders: string[]; globs: string[] } {
  if (v1Header.test(text)) {
    let value: unknown
    try {
      value = root === null ? null : JSON.parse(root.startsWith('﻿') ? root.slice(1) : root)
    } catch {
      value = null
    }
    const declared = isRecord(value) ? value.workspaces : undefined
    const list = Array.isArray(declared) ? declared : isRecord(declared) && Array.isArray(declared.packages) ? declared.packages : []
    return { folders: [], globs: list.filter((each): each is string => typeof each === 'string') }
  }
  const entries = readBerry(text) ?? []
  const folders = entries.flatMap(({ fields }) => {
    const folder = workspaceFolder(fields)
    return folder === null || folder === '' ? [] : [folder]
  })
  return { folders, globs: [] }
}

export function readYarn(text: string, file: string, manifests: Readonly<Record<string, string | null>>): ReadLockfile {
  const v1 = v1Header.test(text)
  const entries = v1 ? readV1(text) : readBerry(text)
  if (entries === null) return { unusable: `${file} is no Yarn lockfile: it has neither the v1 header nor a __metadata version` }
  const byDescriptor = new Map<string, YarnNode>()
  const nodes: YarnNode[] = []
  /** Each workspace's folder, with its node, and its manifest when it could be read. */
  const workspaces = new Map<string, { node: YarnNode; name: string | null; manifest: Manifest | null }>()
  const unreadable: string[] = []
  const manifestAt = (folder: string): Manifest | null => {
    const manifest = readManifest(manifests[folder])
    if (manifest === null) unreadable.push(folder === '' ? 'package.json' : `${folder}/package.json`)
    return manifest
  }
  for (const { descriptors, fields } of entries) {
    const folder = v1 ? null : workspaceFolder(fields)
    const resolution = typeof fields.resolution === 'string' ? fields.resolution : null
    const name = (resolution === null || v1 ? null : nameOf(resolution)) ?? nameOf(descriptors[0] ?? '')
    if (name === null) continue
    const production = [...ranges(fields.dependencies), ...ranges(fields.optionalDependencies)]
    const peers = Object.keys(isRecord(fields.peerDependencies) ? fields.peerDependencies : {})
    let node: YarnNode
    if (folder !== null) {
      // A Berry workspace entry merges dev dependencies in: its manifest splits them.
      const manifest = manifestAt(folder)
      node = { key: `workspace:${folder}`, name, version: manifest?.version ?? '', production: manifest?.production ?? production, peers: [], folder }
      workspaces.set(folder, { node, name, manifest })
    } else {
      const version = typeof fields.version === 'string' ? fields.version : ''
      node = { key: resolution ?? descriptors.join(', '), name, version, production, peers }
    }
    nodes.push(node)
    for (const descriptor of descriptors) byDescriptor.set(descriptor, node)
  }
  if (v1) {
    // v1 records no workspace: the manifests the root's `workspaces` globs match are them, the root's own included.
    for (const folder of ['', ...Object.keys(manifests).filter((each) => each !== '')].sort()) {
      const manifest = manifestAt(folder)
      const node: YarnNode = {
        key: `workspace:${folder}`,
        name: manifest?.name ?? '',
        version: manifest?.version ?? '',
        production: manifest?.production ?? [],
        peers: [],
        folder,
      }
      workspaces.set(folder, { node, name: null, manifest })
      if (folder !== '' && node.name !== '') nodes.push(node)
    }
  } else if (!workspaces.has('')) {
    manifestAt('')
  }
  const byName = new Map<string, Node[]>()
  // A named workspace is installed too (linked into `node_modules`), so code under its name there is no vendored code.
  // The root is no package anything installs.
  for (const node of nodes) {
    if (node.folder === '' || node.name === '') continue
    const list = byName.get(node.name)
    if (list === undefined) byName.set(node.name, [node])
    else list.push(node)
  }
  const workspaceNamed = (name: string): YarnNode | undefined =>
    [...workspaces.values()].find(({ node }) => node.name === name)?.node
  /** What a dependency `name@range` resolves to: its descriptor's entry, or a workspace of that name. */
  const target = (name: string, range: string): YarnNode[] => {
    const found = byDescriptor.get(`${name}@${range}`) ?? (v1 ? undefined : byDescriptor.get(`${name}@npm:${range}`))
    if (found !== undefined) return [found]
    const workspace = v1 || range.startsWith('workspace:') ? workspaceNamed(name) : undefined
    return workspace === undefined ? [] : [workspace]
  }
  /** A peer resolves when the lockfile installs one version of it. */
  const peer = (name: string): Node[] => {
    const found = byName.get(name) ?? []
    return found.length > 0 && found.every((node) => node.version === found[0]!.version) ? found : []
  }
  const edges = (node: Node): Node[] => {
    const own = node as YarnNode
    return [...own.production.flatMap(([name, range]) => target(name, range)), ...own.peers.flatMap(peer)]
  }
  const direct = (workspace: Workspace): Node[] => {
    const manifest = workspaces.get(workspace.folder)?.manifest
    if (manifest === null || manifest === undefined) return []
    return [...manifest.production, ...manifest.development].flatMap(([name, range]) => target(name, range))
  }
  const listed: Workspace[] = [...workspaces.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    // Berry's entry names a workspace; its `0.0.0-use.local` version is none.
    .map(([folder, { name }]) => ({ folder, name, version: null }))
  const missing = [...new Set(unreadable)].sort()
  return {
    lockfile: graph({
      format: 'yarn',
      keyedByInstallPath: false,
      confidence: 'medium',
      nodes,
      workspaces: listed,
      unresolved: missing.length === 0 ? null : `the manifest ${missing[0]} beside the lockfile is missing or unreadable`,
      edges,
      direct,
      place: (directory) => placeByName(directory, byName, listed, edges, direct),
    }),
  }
}

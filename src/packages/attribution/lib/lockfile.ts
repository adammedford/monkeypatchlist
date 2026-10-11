// Lockfiles (§10 Introducing dependencies): `package-lock.json` v2/v3 and `bun.lock`, read into one installed-package
// graph keyed by install path. Pure: the CLI reads the file's text.

/** Why introducers are unknown (§10 Unknown is not empty, §13 Attribution block): a closed list of three. */
export const introducerReasons = ['no-lockfile', 'importer-unresolved', 'lockfile-stale'] as const

export type IntroducerReason = (typeof introducerReasons)[number]

import {
  graph,
  installChain,
  isRecord,
  nameAtVersion,
  type Lockfile,
  type Node,
  type Placed,
  type ReadLockfile,
  type Workspace,
} from './lockfile-graph.ts'
import { pnpmFolders, readPnpm } from './pnpm.ts'
import { readYarn, yarnManifests } from './yarn.ts'

export { nameAtVersion }
export type { Lockfile, Placed, ReadLockfile, Workspace }

/** An npm or Bun installed package, with the names it depends on (§10 Walk). */
interface NamedNode extends Node {
  /** `dependencies`, `optionalDependencies` and `peerDependencies`: a peer counts only when it resolves. */
  dependencies: string[]
}

/** An npm or Bun workspace, with the node its dependencies resolve from and the names of its direct dependencies. */
interface NamedWorkspace extends Workspace {
  key: string
  /** Its `dependencies`, `optionalDependencies`, resolved `peerDependencies` and `devDependencies`. */
  direct: string[]
}

export type { Node as LockfileNode }

/** A lockfile's format, by its file name, and for a `.lock` file by its text: Bun's is JSON, Yarn's isn't. */
export function lockfileFormat(path: string, text: string | null): Lockfile['format'] {
  const name = path.split(/[/\\]/).at(-1) ?? path
  if (/\.ya?ml$/.test(name)) return 'pnpm'
  if (name === 'yarn.lock') return 'yarn'
  if (name.endsWith('.lock')) return text !== null && !stripBom(text).trimStart().startsWith('{') ? 'yarn' : 'bun'
  return 'npm'
}

/**
 * Reads a lockfile's text by its format (`lockfileFormat`). Null text is a file that couldn't be read. `manifests`
 * holds the `package.json` texts beside it, by folder relative to its directory (`''` for its own), null for one that
 * couldn't be read: Yarn's direct dependencies come from them, and pnpm's linked workspaces' names and versions.
 */
export function readLockfile(
  path: string,
  text: string | null,
  manifests: Readonly<Record<string, string | null>> = {},
): ReadLockfile {
  if (text === null) return { unusable: `${path} can't be read` }
  const name = path.split(/[/\\]/).at(-1) ?? path
  const format = lockfileFormat(path, text)
  if (format === 'pnpm') return readPnpm(text, name, manifests)
  if (format === 'yarn') return readYarn(text, name, manifests)
  const bun = format === 'bun'
  let value: unknown
  try {
    value = JSON.parse(bun ? withoutJsonc(text) : stripBom(text))
  } catch {
    return { unusable: `${name} is not valid JSON` }
  }
  if (!isRecord(value)) return { unusable: `${name} is not a lockfile` }
  return bun ? readBun(value, name) : readNpm(value, name)
}

const stripBom = (text: string) => (text.startsWith('﻿') ? text.slice(1) : text)

/** JSON with comments and trailing commas (`bun.lock`), as plain JSON. */
function withoutJsonc(input: string): string {
  const text = stripBom(input)
  let out = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '"') {
      const start = i
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++
      out += text.slice(start, i + 1)
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end < 0 ? text.length : end + 1
    } else if (c === ',') {
      let j = i + 1
      while (j < text.length && /\s/.test(text[j]!)) j++
      if (text[j] !== '}' && text[j] !== ']') out += c
    } else out += c
  }
  return out
}

/** A record's string-keyed names: the keys of a dependency map. */
function names(value: unknown): string[] {
  return isRecord(value) ? Object.keys(value) : []
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null)

/** The package name an npm install key ends in: the segment after its last `node_modules`, two for a scope. */
function nameInKey(segments: readonly string[]): string | null {
  const at = segments.lastIndexOf('node_modules')
  if (at < 0) return null
  const next = segments[at + 1]
  if (next === undefined) return null
  return next.startsWith('@') ? (segments[at + 2] === undefined ? null : `${next}/${segments[at + 2]}`) : next
}

/** `package-lock.json` v2/v3: `packages` keyed by install path. v1 and anything else is unusable. */
function readNpm(value: Record<string, unknown>, file: string): ReadLockfile {
  const version = value.lockfileVersion
  if ((version !== 2 && version !== 3) || !isRecord(value.packages)) {
    return { unusable: `${file} lockfileVersion ${JSON.stringify(version ?? null)}` }
  }
  const entries = value.packages
  const nodes = new Map<string, NamedNode>()
  /** A link entry's target folder, by its key. */
  const links = new Map<string, string>()
  const workspaces: NamedWorkspace[] = []
  for (const [key, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) continue
    const segments = key === '' ? [] : key.split('/')
    if (entry.link === true && typeof entry.resolved === 'string') {
      links.set(key, entry.resolved)
      continue
    }
    const dependencies = [...names(entry.dependencies), ...names(entry.optionalDependencies), ...names(entry.peerDependencies)]
    const name = str(entry.name) ?? nameInKey(segments)
    const own = str(entry.version)
    if (!segments.includes('node_modules')) {
      workspaces.push({
        folder: key,
        name,
        version: own,
        key,
        direct: [...dependencies, ...names(entry.devDependencies)],
      })
    }
    if (name !== null && key !== '') nodes.set(key, { key, name, version: own ?? '', dependencies })
  }
  const lookup = (key: string): NamedNode | null => {
    const target = links.get(key)
    return nodes.get(target ?? key) ?? null
  }
  /** Node's resolution of `name` from the package at `key` (§10 Walk): up its directories' `node_modules`. */
  const resolve = (key: string, name: string): NamedNode | null => {
    const dir = key === '' ? [] : key.split('/')
    for (;;) {
      const found = lookup([...dir, 'node_modules', name].join('/'))
      if (found !== null) return found
      if (dir.length === 0) return null
      dir.pop()
      if (dir.at(-1) === 'node_modules') dir.pop()
    }
  }
  return {
    lockfile: namedGraph('npm', nodes, workspaces, resolve, (directory) => {
      for (let i = 0; i < directory.length; i++) {
        const found = lookup(directory.slice(i).join('/'))
        if (found !== null && !links.has(found.key)) return found
      }
      return null
    }),
  }
}

/** `bun.lock`: `packages` keyed by hoisted path (`a/b` is `node_modules/a/node_modules/b`), and `workspaces`. */
function readBun(value: Record<string, unknown>, file: string): ReadLockfile {
  const version = value.lockfileVersion
  if ((version !== 0 && version !== 1) || !isRecord(value.packages) || !isRecord(value.workspaces)) {
    return { unusable: `${file} lockfileVersion ${JSON.stringify(version ?? null)}` }
  }
  const declared = value.workspaces
  const workspaces: NamedWorkspace[] = []
  const byName = new Map<string, NamedWorkspace>()
  for (const [folder, entry] of Object.entries(declared)) {
    if (!isRecord(entry)) continue
    const name = str(entry.name)
    const workspace: NamedWorkspace = {
      folder,
      name,
      version: str(entry.version),
      // The root resolves from the top; another workspace from its own entry, where Bun nests what it doesn't hoist.
      key: folder === '' || name === null ? '' : name,
      direct: [
        ...names(entry.dependencies),
        ...names(entry.optionalDependencies),
        ...names(entry.peerDependencies),
        ...names(entry.devDependencies),
      ],
    }
    workspaces.push(workspace)
    if (name !== null) byName.set(name, workspace)
  }
  const nodes = new Map<string, NamedNode>()
  for (const [key, entry] of Object.entries(value.packages)) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string') continue
    const ident = entry[0]
    const split = ident.indexOf('@', 1)
    if (split <= 0) continue
    const name = ident.slice(0, split)
    let own = ident.slice(split + 1)
    let dependencies: string[]
    const info = entry.find((part, i) => i > 0 && isRecord(part)) as Record<string, unknown> | undefined
    if (own.startsWith('workspace:')) {
      // A workspace's dependencies are its `workspaces` entry's, without its dev dependencies.
      const workspace = workspaces.find(({ folder }) => folder === own.slice('workspace:'.length)) ?? byName.get(name)
      own = workspace?.version ?? own
      const entry = workspace === undefined ? undefined : declared[workspace.folder]
      dependencies = isRecord(entry)
        ? [...names(entry.dependencies), ...names(entry.optionalDependencies), ...names(entry.peerDependencies)]
        : []
    } else {
      dependencies = [
        ...names(info?.dependencies),
        ...names(info?.optionalDependencies),
        ...names(info?.peerDependencies),
      ]
    }
    nodes.set(key, { key, name, version: own, dependencies })
  }
  /** The package names of a hoisted key, a scope and its name together. */
  const parts = (key: string): string[] => {
    const out: string[] = []
    const segments = key === '' ? [] : key.split('/')
    for (let i = 0; i < segments.length; i++) {
      out.push(segments[i]!.startsWith('@') && i + 1 < segments.length ? `${segments[i]}/${segments[++i]}` : segments[i]!)
    }
    return out
  }
  const resolve = (key: string, name: string): NamedNode | null => {
    const path = parts(key)
    for (;;) {
      const found = nodes.get([...path, name].join('/'))
      if (found !== undefined) return found
      if (path.length === 0) return null
      path.pop()
    }
  }
  const folders = workspaces.filter(({ folder, name }) => folder !== '' && name !== null)
  return {
    lockfile: namedGraph('bun', nodes, workspaces, resolve, (directory) => {
      for (let i = 0; i < directory.length; i++) {
        if (directory[i] !== 'node_modules') continue
        const chain = installChain(directory.slice(i))
        if (chain === null) continue
        const before = directory.slice(0, i).join('/')
        // A workspace's own `node_modules` is keyed under the workspace's name.
        const workspace = folders.find(({ folder }) => before === folder || before.endsWith(`/${folder}`))
        const found =
          (workspace === undefined ? undefined : nodes.get([workspace.name, ...chain].join('/'))) ??
          nodes.get(chain.join('/'))
        if (found !== undefined) return found
      }
      return null
    }),
  }
}

/**
 * A lockfile keyed by install path (npm, Bun), over nodes whose dependencies `resolve` resolves by name. A package
 * directory is the node its install path is; a path the lockfile doesn't install is vendored, in the installed package
 * whose directory holds it (the directory before its package's `node_modules` segment), or in none the lockfile names.
 */
function namedGraph(
  format: 'npm' | 'bun',
  nodes: ReadonlyMap<string, NamedNode>,
  workspaces: NamedWorkspace[],
  resolve: (key: string, name: string) => NamedNode | null,
  atInstallPath: (directory: readonly string[]) => NamedNode | null,
): Lockfile {
  const byFolder = new Map(workspaces.map((workspace) => [workspace.folder, workspace]))
  return graph({
    format,
    keyedByInstallPath: true,
    confidence: 'high',
    nodes: nodes.values(),
    workspaces: workspaces.map(({ folder, name, version }) => ({ folder, name, version })),
    edges: (node) => (node as NamedNode).dependencies.flatMap((name) => resolve(node.key, name) ?? []),
    direct: (workspace) => {
      const named = byFolder.get(workspace.folder)
      return named === undefined ? [] : named.direct.flatMap((name) => resolve(named.key, name) ?? [])
    },
    place(directory) {
      const node = atInstallPath(directory)
      if (node !== null) return { kind: 'installed', nodes: [node] }
      const around = directory.slice(0, directory.lastIndexOf('node_modules'))
      const vendoring = around.includes('node_modules') ? atInstallPath(around) : null
      return { kind: 'vendored', around: vendoring === null ? [] : [vendoring] }
    },
  })
}

/**
 * The importer (§10 Importer): the `lockfile.importer` workspace, by folder (`.` for the root) or name; else the one
 * workspace that holds every first-party source path, taken relative to the lockfile's directory, each in its deepest
 * workspace. With no first-party path, a lockfile with only a root has the root. Null when none decides.
 */
export function importerOf(lockfile: Lockfile, configured: string | null, firstParty: readonly string[]): Workspace | null {
  const { workspaces } = lockfile
  if (configured !== null) {
    const folder = configured === '.' || configured === './' ? '' : configured.replace(/^\.\//, '').replace(/\/$/, '')
    return workspaces.find((each) => each.folder === folder) ?? workspaces.find((each) => each.name === configured) ?? null
  }
  if (firstParty.length === 0) return workspaces.length === 1 ? workspaces[0]! : null
  const holding = new Set(firstParty.map((path) => workspaceOf(lockfile, path)))
  const [only] = holding
  return holding.size === 1 && only !== undefined ? only : null
}

/** The deepest workspace whose folder holds `path`, relative to the lockfile's directory: the root if no other does. */
export function workspaceOf(lockfile: Lockfile, path: string): Workspace | undefined {
  let best: Workspace | undefined
  for (const workspace of lockfile.workspaces) {
    const { folder } = workspace
    if (folder !== '' && !path.startsWith(`${folder}/`)) continue
    if (best === undefined || folder.length > best.folder.length) best = workspace
  }
  return best
}

/**
 * The `package.json` manifests a lockfile needs beside it (§2 Inputs), besides the one in its own directory, which
 * pnpm and Yarn always read: the workspace folders it names (pnpm's importers, Yarn Berry's workspace entries), or for
 * Yarn v1 the `workspaces` globs of its own manifest (`root`), relative to its directory. Null for npm and Bun, which
 * read none.
 */
export function lockfileManifests(path: string, text: string | null, root: string | null): { folders: string[]; globs: string[] } | null {
  const format = lockfileFormat(path, text)
  if (format === 'npm' || format === 'bun') return null
  if (text === null) return { folders: [], globs: [] }
  return format === 'pnpm' ? { folders: pnpmFolders(text), globs: [] } : yarnManifests(text, root)
}

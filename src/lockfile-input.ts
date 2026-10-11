// Reads the lockfile a scan is given (§10 Introducing dependencies) and the `package.json` manifests beside it (§2
// Inputs), so that attribution stays pure: it gets their texts. A missing file is never a usage error: a missing
// lockfile gives `no-lockfile`, and a missing manifest `importer-unresolved`, and neither affects completeness.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { lockfileManifests, type LockfileInput } from './packages/attribution/index.ts'

/** A file's text, or null when it can't be read. */
function textAt(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/**
 * The lockfile input of `lockfile` (as given, relative to `cwd`): its text and, for pnpm and Yarn, the manifests in its
 * directory and in the workspace folders it names, or for Yarn v1 those its own manifest's `workspaces` globs match.
 */
export function readLockfileInput(cwd: string, lockfile: { path: string; importer: string | null }): LockfileInput {
  const full = resolve(cwd, lockfile.path)
  const text = textAt(full)
  const input: LockfileInput = { ...lockfile, text }
  if (lockfileManifests(full, text, null) === null) return input
  const directory = dirname(full)
  const root = textAt(join(directory, 'package.json'))
  const wanted = lockfileManifests(full, text, root) ?? { folders: [], globs: [] }
  const folders = [...new Set([...wanted.folders, ...matchingFolders(directory, wanted.globs)])].sort()
  const manifests: Record<string, string | null> = { '': root }
  for (const folder of folders) manifests[folder] = textAt(join(directory, folder, 'package.json'))
  return { ...input, manifests }
}

/**
 * The folders under `directory` that Yarn v1 `workspaces` globs name: those holding a `package.json` that a pattern
 * matches (`*` within a segment, `**` across any), less those a `!` pattern matches. `node_modules` and dot folders
 * are never entered.
 */
function matchingFolders(directory: string, globs: readonly string[]): string[] {
  if (globs.length === 0) return []
  const include = globs.filter((glob) => !glob.startsWith('!')).map(pattern)
  const exclude = globs.filter((glob) => glob.startsWith('!')).map((glob) => pattern(glob.slice(1)))
  const out: string[] = []
  const walk = (relative: string, depth: number) => {
    if (depth > 8) return
    let entries: string[]
    try {
      entries = readdirSync(join(directory, relative)).sort()
    } catch {
      return
    }
    for (const entry of entries) {
      if (entry === 'node_modules' || entry.startsWith('.')) continue
      const folder = relative === '' ? entry : `${relative}/${entry}`
      try {
        if (!statSync(join(directory, folder)).isDirectory()) continue
      } catch {
        continue
      }
      if (include.some((each) => each.test(folder)) && !exclude.some((each) => each.test(folder))) {
        try {
          if (statSync(join(directory, folder, 'package.json')).isFile()) out.push(folder)
        } catch {
          // No manifest: no workspace.
        }
      }
      walk(folder, depth + 1)
    }
  }
  walk('', 0)
  return out
}

/** A workspace glob as a regular expression over a folder relative to the lockfile's directory. */
function pattern(glob: string): RegExp {
  const segments = glob.replace(/^\.\//, '').replace(/\/+$/, '').split('/')
  const source = segments
    .map((segment) =>
      segment === '**'
        ? '(?:[^/]+/)*'
        : `${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}/`,
    )
    .join('')
  return new RegExp(`^${source.replace(/\/$/, '').replace(/\(\?:\[\^\/\]\+\/\)\*$/, '(?:[^/]+/)*[^/]+')}$`)
}

// The generated files as the working tree and the repository's history hold them, for the catalog CLI and the
// committed-catalog tests. Build-time only; never published.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import type { SerializedCatalog } from '../../src/catalog.ts'
import type { GeneratedFiles, SignOff } from './generate.ts'
import { fromHash, signOffLines } from './target-diff.ts'

const root = new URL('../../', import.meta.url)

export const paths = {
  catalog: 'catalog/catalog.json',
  targetDiff: 'catalog/target-diff.md',
  /** The cross-check of the catalog against SES `permits` and BCD (§4 Sources), which never changes the catalog. */
  crossCheck: 'catalog/cross-check.md',
  /** Who signed off each line of the target diff that needs it (§4 Bump review). Only a human reviewer adds to it. */
  signOff: 'catalog/sign-off.json',
  /** The catalog changelog (§4 Catalog versions), which ships in the package. */
  changelog: 'catalog/changelog.json',
}

/**
 * What the drift check reads: the committed files, the catalog the diff's From line names, the sign-offs, and the
 * committed cross-check report.
 */
export interface Committed {
  committed: GeneratedFiles
  base: string | undefined
  signOff: SignOff
  crossCheck: string | undefined
}

/**
 * Reads the generated files and the sign-offs from the working tree, and finds the catalog the target diff's From line
 * names in the repository's history. Throws when a file is missing, or when no commit has that catalog.
 */
export async function readCommitted(): Promise<Committed> {
  const [catalog, targetDiff] = await Promise.all([read(paths.catalog), read(paths.targetDiff)])
  if (catalog === undefined || targetDiff === undefined) {
    throw new Error(`${paths.catalog} or ${paths.targetDiff} is missing.`)
  }
  const hash = fromHash(targetDiff)
  if (hash === undefined) {
    throw new Error(`${paths.targetDiff} has no From line. Run \`npm run catalog\` and commit the result.`)
  }
  const base = hash === null ? undefined : catalogWithHash(hash)
  if (base === null) {
    throw new Error(
      `${paths.targetDiff} is the diff from a catalog (sha256 ${hash}) that no commit before HEAD has. Fetch the full ` +
        'history, or run `npm run catalog -- --base <ref>` and commit the result.',
    )
  }
  return {
    committed: { catalog, targetDiff },
    base,
    signOff: await readSignOff(),
    crossCheck: await read(paths.crossCheck),
  }
}

/**
 * Writes the generated files and the cross-check report, and removes from the sign-offs every line the new diff no
 * longer marks.
 */
export async function writeGenerated(generated: GeneratedFiles, crossCheck: string): Promise<void> {
  await writeFile(new URL(paths.catalog, root), generated.catalog)
  await writeFile(new URL(paths.targetDiff, root), generated.targetDiff)
  await writeFile(new URL(paths.crossCheck, root), crossCheck)
  if ((await read(paths.signOff)) === undefined) return
  const marked = new Set(signOffLines(generated.targetDiff))
  const signOff = await readSignOff()
  const kept = Object.fromEntries(Object.entries(signOff).filter(([line]) => marked.has(line)))
  if (Object.keys(kept).length !== Object.keys(signOff).length) {
    await writeFile(new URL(paths.signOff, root), `${JSON.stringify(kept, null, 2)}\n`)
  }
}

/**
 * The generated files as committed at `ref`. Diffing against a commit rather than the working tree means a bump that
 * is regenerated several times still lists every change since the commit.
 */
export function committedAt(ref: string): GeneratedFiles | undefined {
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
  } catch {
    throw new Error(`--base ${ref} does not name a commit`)
  }
  const catalog = show(ref, paths.catalog)
  const targetDiff = show(ref, paths.targetDiff)
  return catalog === undefined || targetDiff === undefined ? undefined : { catalog, targetDiff }
}

/**
 * The catalog whose sha256 is `hash`, as a commit reachable from HEAD has it: each version of the catalog is read once,
 * newest first. `null` when none has it, for example in a shallow clone.
 */
function catalogWithHash(hash: string): string | null {
  const seen = new Set<string>()
  for (const commit of git('log', '--format=%H', 'HEAD', '--', paths.catalog).split('\n').filter(Boolean)) {
    const blob = git('rev-parse', `${commit}:${paths.catalog}`).trim()
    if (seen.has(blob)) continue
    seen.add(blob)
    const text = git('cat-file', 'blob', blob)
    if (createHash('sha256').update(text).digest('hex') === hash) return text
  }
  return null
}

/** The committed changelog in the working tree, or undefined when there is none. */
export function readChangelog(): Promise<string | undefined> {
  return read(paths.changelog)
}

export async function writeChangelog(text: string): Promise<void> {
  await writeFile(new URL(paths.changelog, root), text)
}

/**
 * The last catalog of catalog version `version` that a commit reachable from HEAD has, parsed, newest first: the
 * catalog the changelog's records for the next version are from. Undefined when none has it, as in a shallow clone.
 */
export function lastCatalogOfVersion(version: number): SerializedCatalog | undefined {
  const seen = new Set<string>()
  for (const commit of git('log', '--format=%H', 'HEAD', '--', paths.catalog).split('\n').filter(Boolean)) {
    const blob = git('rev-parse', `${commit}:${paths.catalog}`).trim()
    if (seen.has(blob)) continue
    seen.add(blob)
    const catalog = JSON.parse(git('cat-file', 'blob', blob)) as SerializedCatalog
    if (catalog.metadata.catalogVersion === version) return catalog
  }
  return undefined
}

async function readSignOff(): Promise<SignOff> {
  const text = await read(paths.signOff)
  if (text === undefined) return {}
  const json: unknown = JSON.parse(text)
  const valid =
    typeof json === 'object' &&
    json !== null &&
    !Array.isArray(json) &&
    Object.values(json).every((who) => typeof who === 'string')
  if (!valid) throw new Error(`${paths.signOff}: needs, for each line of the target diff signed off, who signed it off`)
  return json as SignOff
}

async function read(path: string): Promise<string | undefined> {
  try {
    return await readFile(new URL(path, root), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function show(ref: string, path: string): string | undefined {
  try {
    git('cat-file', '-e', `${ref}:${path}`)
  } catch {
    return undefined
  }
  return git('show', `${ref}:${path}`)
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: 'pipe' })
}

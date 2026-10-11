// The sites of the validation corpus that the reproducibility check scans, and the check that its build directories are
// the corpus build byte for byte (corpus README, Layout). It only reads.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** A corpus the check can't use, or an argument it can't take. The command exits 2 and says why. */
export class CorpusError extends Error {}

/**
 * What differs between the corpus's build directories and the manifests the corpus build wrote beside them (`npm run
 * build` in the corpus): one message per file, in path order. The corpus root and each exercise variant with builds
 * of its own have a `manifest.json` with the sha256 of every file under their `dist/`. None when every file matches.
 * A manifest without its `dist/`, or a `dist/` without its manifest, is a `CorpusError`.
 */
export function verifyBuilds(root: string): string[] {
  const buildRoots = ['', ...subdirectories(join(root, 'variants')).map((variant) => `variants/${variant}/`)]
  return buildRoots.flatMap((buildRoot) => {
    const manifestPath = join(root, buildRoot, 'manifest.json')
    const dist = join(root, buildRoot, 'dist')
    const manifestName = `${buildRoot}manifest.json`
    if (!existsSync(manifestPath)) {
      if (existsSync(dist)) throw new CorpusError(`${buildRoot}dist/ has no manifest.json to verify it against`)
      return []
    }
    if (!existsSync(dist)) throw new CorpusError(`${manifestName} has no dist/: build the corpus first`)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: Record<string, string> }
    const expected = new Map(Object.entries(manifest.files))
    const actual = hashes(dist)
    const files = [...new Set([...expected.keys(), ...actual.keys()])].sort()
    return files.flatMap((file) => {
      const path = `${buildRoot}dist/${file}`
      if (!actual.has(file)) return [`${path}: missing, but listed in ${manifestName}`]
      if (!expected.has(file)) return [`${path}: not in ${manifestName}`]
      return actual.get(file) === expected.get(file) ? [] : [`${path}: differs from ${manifestName}`]
    })
  })
}

/** The sha256 of every file under `dir`, by POSIX path relative to it, as the corpus build's manifest records them. */
function hashes(dir: string): Map<string, string> {
  const result = new Map<string, string>()
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const file = join(entry.parentPath, entry.name)
    result.set(relative(dir, file).split(sep).join('/'), createHash('sha256').update(readFileSync(file)).digest('hex'))
  }
  return result
}

/** A directory `monkeypatchlist scan` runs over, named by its corpus-relative path (`dist/webpack/otel/maps`). */
export interface Site {
  id: string
  /** Its absolute path. */
  dir: string
}

/**
 * The corpus's sites, sorted by id: the whole validation corpus but the sealed holdout (§20).
 *
 * - the bundled build directories, `dist/<bundler>/<app>/<maps|nomaps>/`
 * - the static sites, `static-sites/<site>/`: the vendor CDN sites and the empty control
 * - each exercise variant's build directories, `variants/<variant>/dist/<bundler>/<app>/<maps|nomaps>/`
 * - the fixture pages, `fixtures/static-sites/<page>/`
 */
export function readSites(root: string): Site[] {
  const ids = [
    ...buildDirectories(root, 'dist'),
    ...subdirectories(join(root, 'static-sites')).map((name) => `static-sites/${name}`),
    ...subdirectories(join(root, 'variants')).flatMap((variant) => buildDirectories(root, `variants/${variant}/dist`)),
    ...subdirectories(join(root, 'fixtures', 'static-sites')).map((name) => `fixtures/static-sites/${name}`),
  ]
  return ids.sort().map((id) => ({ id, dir: join(root, id) }))
}

/** The build directories under `<root>/<dist>`: `<dist>/<bundler>/<app>/<maps|nomaps>`. */
function buildDirectories(root: string, dist: string): string[] {
  return subdirectories(join(root, dist)).flatMap((bundler) =>
    subdirectories(join(root, dist, bundler)).flatMap((app) =>
      subdirectories(join(root, dist, bundler, app)).map((name) => `${dist}/${bundler}/${app}/${name}`),
    ),
  )
}

/** The subdirectories of `dir`, sorted, without dot-directories; none when `dir` doesn't exist. */
function subdirectories(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.') && statSync(join(dir, name)).isDirectory())
    .sort()
}

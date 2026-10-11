// Reads the validation corpus (corpus README, Layout): its build directories and the ground truth the scorer needs.
// It only reads.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseAdjudications, type Adjudication } from './adjudications.ts'
import { CorpusError } from './corpus-error.ts'
import type { GroundTruthMutation, HandLabel } from './positives.ts'
import { parseReachabilitySample, type SampleLabel } from './reachability-sample.ts'

/** A build directory to scan. */
export interface CorpusBuild {
  /** `webpack/otel/maps`, or `features-on:webpack/datadog/maps` for a variant's build. */
  id: string
  /** `base`, or the exercise variant whose build it is (`features-on`, `lazy-chunks`). */
  set: string
  library: string
  bundler: string
  /** Its absolute path. */
  dir: string
  /**
   * For a vendor CDN site, the corpus's `vendor/` directory, whose pinned copies answer its remote URLs: the site is
   * scanned in `resolve` mode with the fixture fetcher serving them (corpus README, Serving).
   */
  vendor?: string
}

/** One ground-truth file: the mutations one Chromium run observed. */
export interface GroundTruthFile {
  /** The run: `webpack/otel/maps`, `features-on:webpack/datadog/maps`, `native-absent:webpack/core-js/maps.promise`. */
  id: string
  /** `base`, or the exercise variant the run belongs to. */
  run: string
  library: string
  mutations: GroundTruthMutation[]
}

export interface Corpus {
  builds: CorpusBuild[]
  groundTruth: GroundTruthFile[]
  /** `labels/unobserved.json`, by library. */
  handLabels: Record<string, HandLabel[]>
  /** `labels/adjudications.json`, by library; none until triage writes it. */
  adjudications: Record<string, Adjudication[]>
  /** `labels/reachability-sample.json`, by library; none until triage writes it. */
  reachabilitySample: Record<string, SampleLabel[]>
}

/**
 * Reads the corpus at `root`: the base build directories under `dist/`, the empty control, and the exercise variants
 * under `variants/`, with their ground truth and the labels. The sealed holdout and the fixture pages are other corpus
 * roots, and are never read.
 */
export function readCorpus(root: string): Corpus {
  const builds: CorpusBuild[] = []
  const groundTruth: GroundTruthFile[] = []
  for (const { bundler, app, name } of buildDirectories(join(root, 'dist'))) {
    const id = `${bundler}/${app}/${name}`
    builds.push({ id, set: 'base', library: libraryOf(app), bundler, dir: join(root, 'dist', id) })
    groundTruth.push({ id, run: 'base', library: libraryOf(app), mutations: groundTruthOf(root, id) })
  }
  // `ground-truth/static/` holds the control and the CDN sites, read next.
  requireBuilds(root, '', { skip: ['static'] })
  // The empty control page (§20 Negatives).
  const control = join(root, 'static-sites', 'control')
  if (existsSync(control)) {
    const id = 'static/control'
    builds.push({ id, set: 'base', library: 'control', bundler: 'static', dir: control })
    groundTruth.push({ id, run: 'base', library: 'control', mutations: groundTruthOf(root, id) })
  }
  // The vendor CDN sites (§20 Sites), each a site of its library, served from `vendor/`.
  for (const site of subdirectories(join(root, 'static-sites')).filter((name) => name !== 'control')) {
    const library = cdnLibraries[site]
    if (library === undefined) throw new CorpusError(`static-sites/${site} is no CDN site the harness knows`)
    const id = `static/${site}`
    builds.push({ id, set: 'base', library, bundler: 'cdn', dir: join(root, 'static-sites', site), vendor: join(root, 'vendor') })
    groundTruth.push({ id, run: 'base', library, mutations: groundTruthOf(root, id) })
  }
  // Exercise variants (corpus README, Exercise variants): each has its own ground truth, and builds of its own unless
  // it reruns the base builds (native-absent).
  for (const variant of subdirectories(join(root, 'variants'))) {
    const dir = join(root, 'variants', variant)
    for (const { bundler, app, name } of buildDirectories(join(dir, 'dist'))) {
      const path = `${bundler}/${app}/${name}`
      builds.push({ id: `${variant}:${path}`, set: variant, library: libraryOf(app), bundler, dir: join(dir, 'dist', path) })
    }
    // A variant with apps of its own is built from them; native-absent reruns the base builds and has none.
    if (existsSync(join(dir, 'apps'))) requireBuilds(root, `variants/${variant}/`)
    for (const bundler of subdirectories(join(dir, 'ground-truth'))) {
      for (const app of subdirectories(join(dir, 'ground-truth', bundler))) {
        for (const file of jsonFiles(join(dir, 'ground-truth', bundler, app))) {
          const id = `${variant}:${bundler}/${app}/${file.slice(0, -'.json'.length)}`
          const mutations = readMutations(join(dir, 'ground-truth', bundler, app, file))
          groundTruth.push({ id, run: variant, library: libraryOf(app), mutations })
        }
      }
    }
  }
  const adjudications = join(root, 'labels', 'adjudications.json')
  const sample = join(root, 'labels', 'reachability-sample.json')
  return {
    builds,
    groundTruth,
    handLabels: readHandLabels(join(root, 'labels', 'unobserved.json')),
    adjudications: existsSync(adjudications) ? parseAdjudications(JSON.parse(readFileSync(adjudications, 'utf8'))) : {},
    reachabilitySample: existsSync(sample) ? parseReachabilitySample(JSON.parse(readFileSync(sample, 'utf8'))) : {},
  }
}

/**
 * The library each vendor CDN site loads (corpus README, Layout): Sentry's CDN bundle is `@sentry/browser` 11.0.0 with
 * tracing and replay, the `sentry-11` app's library.
 */
const cdnLibraries: Record<string, string> = {
  'appinsights-cdn': 'appinsights',
  'datadog-cdn': 'datadog',
  'newrelic-cdn': 'newrelic',
  'sentry-cdn': 'sentry-11',
}

/**
 * The library an app builds. A variant app that only reconfigures its library is named `<library>--<what>`
 * (`core-js--members`).
 */
function libraryOf(app: string): string {
  return app.split('--')[0]!
}

/** The build directories under a `dist/` root: `<bundler>/<app>/<maps|nomaps>`. */
function buildDirectories(root: string): { bundler: string; app: string; name: string }[] {
  return subdirectories(root).flatMap((bundler) =>
    subdirectories(join(root, bundler)).flatMap((app) =>
      subdirectories(join(root, bundler, app)).map((name) => ({ bundler, app, name })),
    ),
  )
}

/**
 * Refuses ground truth whose build directory is missing: `<set>ground-truth/<bundler>/<app>/<name>.json` needs
 * `<set>dist/<bundler>/<app>/<name>/`. Build directories are git-ignored, so an unbuilt or partly built corpus would
 * otherwise be scored in part.
 */
function requireBuilds(root: string, set: string, { skip = [] }: { skip?: string[] } = {}): void {
  const truth = join(root, set, 'ground-truth')
  for (const bundler of subdirectories(truth).filter((name) => !skip.includes(name))) {
    for (const app of subdirectories(join(truth, bundler))) {
      for (const file of jsonFiles(join(truth, bundler, app))) {
        const path = `${bundler}/${app}/${file.slice(0, -'.json'.length)}`
        if (!existsSync(join(root, set, 'dist', path))) {
          throw new CorpusError(`${set}ground-truth/${path}.json has no build directory (${set}dist/${path}); build the corpus first`)
        }
      }
    }
  }
}

/** The ground truth of a base build directory, which every one must have. */
function groundTruthOf(root: string, id: string): GroundTruthMutation[] {
  const path = join(root, 'ground-truth', `${id}.json`)
  if (!existsSync(path)) throw new CorpusError(`the build directory ${id} has no ground truth (ground-truth/${id}.json)`)
  return readMutations(path)
}

function readMutations(path: string): GroundTruthMutation[] {
  return (JSON.parse(readFileSync(path, 'utf8')) as { mutations: GroundTruthMutation[] }).mutations
}

/** The hand labels by library, without the file's `$schema` note; none when the corpus has no such file. */
function readHandLabels(path: string): Record<string, HandLabel[]> {
  if (!existsSync(path)) return {}
  const byLibrary = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  return Object.fromEntries(Object.entries(byLibrary).filter(([key]) => key !== '$schema')) as Record<string, HandLabel[]>
}

/** The subdirectories of `dir`, sorted, without dot-directories; none when `dir` doesn't exist. */
function subdirectories(dir: string): string[] {
  return entries(dir).filter((name) => statSync(join(dir, name)).isDirectory())
}

/** The `.json` files in `dir`, sorted. */
function jsonFiles(dir: string): string[] {
  return entries(dir).filter((name) => name.endsWith('.json') && statSync(join(dir, name)).isFile())
}

function entries(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => !name.startsWith('.'))
    .sort()
}

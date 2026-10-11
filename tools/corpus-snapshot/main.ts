// The patch-release reproducibility check (§4 Catalog versions: release promise). A patch release reproduces
// byte-identical output on the whole validation corpus: this scans every corpus site with the production
// `monkeypatchlist scan --json`, and compares each report, without its `run` block, with the committed snapshot. Build-time
// only; never published. CONTRIBUTING.md says when the snapshot is refreshed.
//
//   npm run corpus:check      [-- [--corpus <dir>] [--snapshot <dir>] [--jobs <n>]]   fail on any byte difference
//   npm run corpus:check      -- --bindings typescript-eslint                         the binding seam's conformance (§19)
//   npm run corpus:snapshot   [-- [--corpus <dir>] [--snapshot <dir>] [--jobs <n>]]   refresh the snapshot (minor only)
//
// The corpus defaults to `corpus/` (tools/paths.ts), and the snapshot to `corpus-snapshot/`. Each
// site's report is `<snapshot>/<surface>/<site>.json`, for the surfaces `protected` (the default) and `all`.
//
// The scans run in a pool of `--jobs` worker processes (workers.ts), by default one per available CPU but one, and no
// more than the machine's memory holds at a whole Node heap each, or as many as MONKEYPATCHLIST_CORPUS_JOBS says. `--jobs 1`
// scans in process, one site after another.
// Reports are put back in site order before anything is written or compared, so the output is byte-identical
// whatever the number of jobs.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { availableParallelism, totalmem } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { getHeapStatistics } from 'node:v8'
import { loadCatalog, type SerializedCatalog } from '../../src/catalog.ts'
import { scanCorpusSite, type ReportedSurface } from '../corpus-scan.ts'
import { corpusDir, isInside } from '../paths.ts'
import { bindingPackages, isBindingName, resolverFor, type BindingName } from './bindings.ts'
import { CorpusError, readSites, verifyBuilds, type Site } from './corpus.ts'
import { processPool } from './workers.ts'
import { compareWithSnapshot, isPatchRelease, releaseLine, releaseLineOfSnapshot, snapshotOf } from './snapshot.ts'

export interface Io {
  stdout: { write(text: string): void }
  stderr: { write(text: string): void }
  /** `MONKEYPATCHLIST_CORPUS_JOBS` sets the number of scans in flight, unless `--jobs` does. */
  env?: Readonly<Record<string, string | undefined>>
}

/** The surfaces each site is scanned with (§12, §16 `--surface`): the default, and the whole catalog. */
const reportedSurfaces: readonly ReportedSurface[] = ['protected', 'all']

/** Scans one site with `monkeypatchlist scan --json -`, and returns the JSON text it printed. Throws when the scan fails. */
export type Scanner = (dir: string, surface: ReportedSurface) => Promise<string>

/** What the command plugs in. Tests may wrap the scanner, and describe another machine. */
export interface Deps {
  /** Scans one site. By default, a pool of scan worker processes, or the scan in process with one job. */
  scan: Scanner
  /** The machine the pool's default size is set from: by default, this one. */
  machine: () => Machine
  /** Hears the process id of each scan worker process the default scanner starts. */
  workerStarted: (pid: number) => void
}

/**
 * What sets how many scan workers run by default: the CPUs the command may use (`os.availableParallelism()`), the
 * machine's memory in bytes (`os.totalmem()`), and the most heap a Node process may grow to, in bytes (V8's
 * `heap_size_limit`), which a scan of a large site comes near.
 */
export interface Machine {
  cpus: number
  memory: number
  heapLimit: number
}

function thisMachine(): Machine {
  return { cpus: availableParallelism(), memory: totalmem(), heapLimit: getHeapStatistics().heap_size_limit }
}

/**
 * The default number of jobs: one per CPU but one, leaving one for the check itself and the rest of the machine, and
 * no more than the machine's memory holds at a whole heap each, since workers that swap make the check slower than
 * one job. At least one.
 */
function defaultJobs({ cpus, memory, heapLimit }: Machine): number {
  return Math.max(1, Math.min(cpus - 1, Math.floor(memory / heapLimit)))
}

const repository = fileURLToPath(new URL('../../', import.meta.url))
const defaults = {
  corpus: corpusDir,
  snapshot: join(repository, 'corpus-snapshot'),
}

const usage =
  'usage: node tools/corpus-snapshot/cli.ts [--update] [--corpus <dir>] [--snapshot <dir>] [--jobs <n>] [--bindings eslint-scope|typescript-eslint]'

/** How many differing reports a failed check lists. A new release line changes every one. */
const listedDifferences = 50

const promise =
  'A patch release reproduces the snapshot byte for byte (§4). Output that changes belongs in a minor release,\n' +
  'which refreshes the snapshot with `npm run corpus:snapshot` (CONTRIBUTING.md).\n'

/**
 * Runs the command. Returns the exit code:
 *
 * - 0: every report matches the snapshot, or `--update` wrote it
 * - 1: the corpus build differs from its manifests, a scan failed, or a report differs from the snapshot
 * - 2: a bad flag, a corpus it can't use, or `--update` in a patch release
 */
export async function main(argv: readonly string[], io: Io, deps: Partial<Deps> = {}): Promise<number> {
  try {
    const options = parseOptions(argv, io.env ?? {}, deps.machine ?? thisMachine)

    // The corpus is scanned only once its build directories are the corpus build, byte for byte.
    const unbuilt = verifyBuilds(options.corpus)
    if (unbuilt.length > 0) {
      io.stderr.write(`corpus-snapshot: the corpus build differs from its manifests in ${unbuilt.length} files\n`)
      for (const problem of unbuilt) io.stderr.write(`  ${problem}\n`)
      return 1
    }
    const sites = readSites(options.corpus)
    if (sites.length === 0) throw new CorpusError(`no site in the corpus at ${options.corpus}`)

    const scanned = await withScanner(options.jobs, options.bindings, deps, (scan) => scanSites(sites, scan, options.jobs))
    return options.update ? update(options.snapshot, scanned, io) : check(options.snapshot, scanned, options.bindings, io)
  } catch (error) {
    if (error instanceof CorpusError) {
      io.stderr.write(`corpus-snapshot: ${error.message}\n`)
      return 2
    }
    throw error
  }
}

/**
 * Runs `use` with the scanner: the one `deps` plugs in, or by default, with one job, the scan in process, and with
 * more, a pool of that many scan worker processes, stopped once `use` is done.
 */
async function withScanner<T>(
  jobs: number,
  bindings: BindingName,
  deps: Partial<Deps>,
  use: (scan: Scanner) => Promise<T>,
): Promise<T> {
  if (deps.scan !== undefined) return use(deps.scan)
  if (jobs === 1) return use(monkeypatchlistScanner(loadCatalog(), bindings))
  const workers = processPool(jobs, { bindings, ...(deps.workerStarted === undefined ? {} : { started: deps.workerStarted }) })
  try {
    return await use((dir, surface) => workers.scan(dir, surface))
  } finally {
    workers.close()
  }
}

function parseOptions(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  machine: () => Machine,
): { update: boolean; corpus: string; snapshot: string; jobs: number; bindings: BindingName } {
  let values: { update: boolean; corpus?: string; snapshot?: string; jobs?: string; bindings?: string }
  try {
    const options = {
      update: { type: 'boolean', default: false },
      corpus: { type: 'string' },
      snapshot: { type: 'string' },
      jobs: { type: 'string' },
      bindings: { type: 'string' },
    } as const
    values = parseArgs({ args: [...argv], options }).values
  } catch (error) {
    throw new CorpusError(`${(error as Error).message}\n${usage}`)
  }
  const corpus = resolve(values.corpus ?? defaults.corpus)
  const snapshot = resolve(values.snapshot ?? defaults.snapshot)
  if (!existsSync(corpus)) throw new CorpusError(`no corpus at ${corpus}`)
  if (isInside(snapshot, corpus)) throw new CorpusError(`the check writes nothing under the corpus: --snapshot ${snapshot}`)
  const jobs =
    values.jobs !== undefined
      ? parseJobs(values.jobs, '--jobs')
      : env.MONKEYPATCHLIST_CORPUS_JOBS !== undefined && env.MONKEYPATCHLIST_CORPUS_JOBS !== ''
        ? parseJobs(env.MONKEYPATCHLIST_CORPUS_JOBS, 'MONKEYPATCHLIST_CORPUS_JOBS')
        : defaultJobs(machine())
  const bindings = values.bindings ?? 'eslint-scope'
  if (!isBindingName(bindings)) throw new CorpusError(`--bindings takes eslint-scope or typescript-eslint, not ${JSON.stringify(bindings)}\n${usage}`)
  // The snapshot is the shipped implementation's output; another one behind the seam is only ever checked against it.
  if (values.update && bindings !== 'eslint-scope') {
    throw new CorpusError(`--update writes the snapshot with the shipped eslint-scope only; --bindings ${bindings} checks it\n${usage}`)
  }
  return { update: values.update, corpus, snapshot, jobs, bindings }
}

/** A number of scans in flight: a positive whole number. */
function parseJobs(text: string, name: string): number {
  if (!/^[1-9]\d*$/.test(text)) throw new CorpusError(`${name} takes a positive whole number of jobs, not ${JSON.stringify(text)}\n${usage}`)
  return Number(text)
}

interface Scanned {
  /** Each report in its snapshot form, by path (`all/dist/webpack/otel/maps.json`). */
  reports: Map<string, string>
  /** The monkeypatchlist versions the reports came from: one, unless the scanner is broken. */
  versions: Set<string>
  /** Why a scan failed, or why its report can't be compared byte for byte, by path. */
  failures: Map<string, string>
  /** How many scans ran: every site with every surface. */
  scans: number
}

async function scanSites(sites: readonly Site[], scan: Scanner, jobs: number): Promise<Scanned> {
  const scans = sites.flatMap((site) => reportedSurfaces.map((surface) => ({ site, surface })))
  // Scans finish in any order; each outcome keeps its scan's place, so the results are filled in site order.
  const outcomes = await pool(scans, jobs, async ({ site, surface }) => {
    try {
      return { ok: true as const, ...snapshotOf(await scan(site.dir, surface)) }
    } catch (error) {
      return { ok: false as const, message: (error as Error).message.trimEnd() }
    }
  })
  const scanned: Scanned = { reports: new Map(), versions: new Set(), failures: new Map(), scans: scans.length }
  scans.forEach(({ site, surface }, index) => {
    const path = `${surface}/${site.id}.json`
    const outcome = outcomes[index]!
    if (outcome.ok) {
      scanned.reports.set(path, outcome.text)
      scanned.versions.add(outcome.monkeypatchlistVersion)
    } else {
      scanned.failures.set(path, outcome.message)
    }
  })
  return scanned
}

/** Runs `task` on every item, at most `jobs` at a time, starting them in order; the results are in the items' order. */
async function pool<T, R>(items: readonly T[], jobs: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await task(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, lane))
  return results
}

/** Rewrites the snapshot: exactly the current sites' reports, so a site that is gone takes its reports with it. */
function update(snapshotDir: string, { reports, versions, failures, scans }: Scanned, io: Io): number {
  if (failures.size > 0) {
    io.stderr.write(`corpus-snapshot: ${failures.size} of ${scans} scans failed, so the snapshot is unchanged\n`)
    writeFailures(failures, io)
    return 1
  }
  // §4: only a minor release may change findings on unchanged code, so only a minor release refreshes the snapshot.
  const patch = [...versions].filter(isPatchRelease)
  if (patch.length > 0) {
    throw new CorpusError(
      `monkeypatchlist ${patch.join(', ')} is a patch release: the snapshot is refreshed only for minor releases (CONTRIBUTING.md)`,
    )
  }
  for (const surface of reportedSurfaces) rmSync(join(snapshotDir, surface), { recursive: true, force: true })
  for (const [path, text] of reports) {
    mkdirSync(dirname(join(snapshotDir, path)), { recursive: true })
    writeFileSync(join(snapshotDir, path), text)
  }
  io.stdout.write(`corpus-snapshot: wrote ${reports.size} reports to ${snapshotDir} (monkeypatchlist ${releaseLines(versions)})\n`)
  return 0
}

/** Compares every report with the snapshot, byte for byte. */
function check(snapshotDir: string, { reports, versions, failures, scans }: Scanned, bindings: BindingName, io: Io): number {
  const snapshot = readSnapshot(snapshotDir)
  // A failed scan is reported as such, not also as a site the snapshot has and the corpus lacks.
  const expected = new Map([...snapshot].filter(([path]) => !failures.has(path)))
  const differences = compareWithSnapshot(expected, reports)
  if (failures.size === 0 && differences.length === 0) {
    const seam = bindings === 'eslint-scope' ? '' : `, with ${bindingPackages[bindings]} behind the binding-resolution seam`
    io.stdout.write(`corpus-snapshot: all ${reports.size} reports match the snapshot (monkeypatchlist ${releaseLines(versions)})${seam}\n`)
    return 0
  }
  if (failures.size > 0) {
    io.stderr.write(`corpus-snapshot: ${failures.size} of ${scans} scans failed\n`)
    writeFailures(failures, io)
  }
  if (differences.length > 0) {
    io.stderr.write(`corpus-snapshot: ${differences.length} reports differ from the snapshot\n`)
    for (const difference of differences.slice(0, listedDifferences)) io.stderr.write(`  ${difference}\n`)
    if (differences.length > listedDifferences) {
      io.stderr.write(`  … and ${differences.length - listedDifferences} more\n`)
    }
  }
  const was = [...new Set([...snapshot.values()].map(releaseLineOfSnapshot).filter((line) => line !== null))].sort()
  const now = releaseLines(versions)
  if (was.length > 0 && now !== '' && was.join(', ') !== now) {
    io.stderr.write(`corpus-snapshot: the snapshot is for monkeypatchlist ${was.join(', ')}, and this is ${now}\n`)
  }
  io.stderr.write(promise)
  return 1
}

function writeFailures(failures: ReadonlyMap<string, string>, io: Io): void {
  for (const [path, message] of failures) io.stderr.write(`  ${path}: ${message}\n`)
}

/** The release lines of `versions`, for a message: `0.0`. */
function releaseLines(versions: ReadonlySet<string>): string {
  return [...new Set([...versions].map(releaseLine))].sort().join(', ')
}

/** The snapshot's reports by path (`all/dist/webpack/otel/maps.json`); none when it doesn't exist. */
function readSnapshot(dir: string): Map<string, string> {
  const reports = new Map<string, string>()
  for (const surface of reportedSurfaces) {
    const root = join(dir, surface)
    if (!existsSync(root)) continue
    for (const path of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      const file = join(root, path)
      if (path.endsWith('.json') && statSync(file).isFile()) {
        reports.set(`${surface}/${path.split(sep).join('/')}`, readFileSync(file, 'utf8'))
      }
    }
  }
  return reports
}

/**
 * The default scanner: `monkeypatchlist scan <dir> --map https://app.corpus.test/=. --config <file> --json -`, in process,
 * with the catalog loaded once (tools/corpus-scan.ts), and `bindings` behind the binding-resolution seam.
 */
export function monkeypatchlistScanner(catalog: SerializedCatalog, bindings: BindingName = 'eslint-scope'): Scanner {
  const resolver = resolverFor(bindings)
  return (dir, surface) => scanCorpusSite(dir, surface, catalog, resolver === undefined ? {} : { resolver })
}

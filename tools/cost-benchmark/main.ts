// The cost benchmark (§18 Target). It cold-scans every validation-corpus site, and the scale fixture's 1, 2.5 and 5 MB
// builds, with the production `monkeypatchlist scan --json`, measuring each link group's analysis time and peak heap. Then it
// rescans each corpus site once per cap with that cap alone multiplied, and once with `depth` and `contexts` together
// multiplied, each with the step budget ×64 so that it can't fire, injected through the scan's deps and never a user
// flag, and counts every difference in fingerprint set, effect, `locks` or completeness level as budget-driven
// variance. It is run on demand, and is not a CI gate. Build-time only; never published.
//
//   npm run benchmark [-- [--corpus <dir>] [--out <dir>] [--factor <n> | --no-rerun] [--only <site prefix>]]
//
// `--factor` is what each rerun multiplies its caps by (4 by default). `--no-rerun` measures time and heap alone,
// skipping the reruns, so variance is not measured.
//
// It writes `<out>/cost-benchmark.json` (machine-readable results) and `<out>/cost-benchmark.md` (the summary table,
// also printed). The corpus defaults to `corpus/` (tools/paths.ts), and the output to `benchmarks/`.

import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { arch, availableParallelism, cpus, platform, release, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import v8 from 'node:v8'
import { Worker } from 'node:worker_threads'
import { loadCatalog, type SerializedCatalog } from '../../src/catalog.ts'
import { defaultBudget, type Budget } from '../../src/packages/analysis/index.ts'
import { scanCorpusSite } from '../corpus-scan.ts'
import { CorpusError, readSites, verifyBuilds, type Site } from '../corpus-snapshot/corpus.ts'
import { corpusDir, isInside } from '../paths.ts'
import { meter, type Meter } from './measure.ts'
import {
  budgetVariance,
  machineMatchesReference,
  measured,
  referenceMachine,
  reruns,
  summaryTable,
  target,
  varianceOf,
  worstOf,
  type Machine,
  type Rerun,
  type Results,
  type SiteResult,
} from './results.ts'

export interface Io {
  stdout: { write(text: string): void }
  stderr: { write(text: string): void }
}

/** What the command plugs in. Tests may swap the budget the measured scans run with; the reruns raise it. */
export interface Deps {
  budget: Budget
}

const repository = fileURLToPath(new URL('../../', import.meta.url))
const defaults = {
  corpus: corpusDir,
  out: join(repository, 'benchmarks'),
  factor: 4,
}

const usage =
  'usage: node tools/cost-benchmark/cli.ts [--corpus <dir>] [--out <dir>] [--factor <n> | --no-rerun] [--only <site prefix>]'

/** The surface every scan reports: the whole catalog, so that a cap costing any target shows (§12). */
const surface = 'all'

/**
 * Runs the benchmark. Returns the exit code: 0 once the results are written, whether or not the target is met (it is
 * not a gate); 1 when a scan failed (the results are still written, and list it); 2 for a bad flag or a corpus it
 * can't use.
 */
export async function main(argv: readonly string[], io: Io, deps: Partial<Deps> = {}): Promise<number> {
  const budget = deps.budget ?? defaultBudget
  let options: Options
  let sites: BenchmarkSite[]
  try {
    options = parseOptions(argv)
    sites = benchmarkSites(options.corpus).filter((site) => options.only === null || site.id.startsWith(options.only))
    if (sites.length === 0) throw new CorpusError(`no site to benchmark in the corpus at ${options.corpus}`)
  } catch (error) {
    if (error instanceof CorpusError) {
      io.stderr.write(`cost-benchmark: ${error.message}\n`)
      return 2
    }
    throw error
  }

  const catalog = loadCatalog()
  const rerunsOf = options.rerun ? reruns(budget, options.factor) : null
  const measuring = meter(workerHeapMb())
  const results: SiteResult[] = []
  const failures: Results['failures'] = []
  let versions: { analyzerVersion: string; catalogVersion: string } | null = null
  try {
    for (const site of sites) {
      io.stderr.write(`cost-benchmark: ${site.id}\n`)
      const progress = (text: string) => io.stderr.write(text)
      const context = { catalog, budget, reruns: rerunsOf, progress, measuring, failures, heapMb: workerHeapMb() }
      const result = await benchmarkSite(site, context)
      if (result === null) continue
      results.push(result.site)
      versions ??= result.versions
    }
  } finally {
    await measuring.close()
  }

  const machine = thisMachine()
  const written: Results = {
    machine,
    reference: { ...referenceMachine, matches: machineMatchesReference(machine) },
    target,
    analyzerVersion: versions?.analyzerVersion ?? null,
    catalogVersion: versions?.catalogVersion ?? null,
    raisedBy: options.rerun ? options.factor : null,
    reruns: rerunsOf,
    sites: results,
    failures,
    worst: worstOf(results),
    variance: varianceOf(results),
  }
  const summary = summaryTable(written)
  mkdirSync(options.out, { recursive: true })
  writeFileSync(join(options.out, 'cost-benchmark.json'), `${JSON.stringify(written, null, 2)}\n`)
  writeFileSync(join(options.out, 'cost-benchmark.md'), summary)
  io.stdout.write(summary)
  io.stdout.write(`\ncost-benchmark: wrote ${join(options.out, 'cost-benchmark.json')} and cost-benchmark.md\n`)
  return failures.length === 0 ? 0 : 1
}

interface Options {
  corpus: string
  out: string
  factor: number
  /** False with `--no-rerun`: corpus sites are measured without their reruns. */
  rerun: boolean
  only: string | null
}

function parseOptions(argv: readonly string[]): Options {
  let values: { corpus?: string; out?: string; factor?: string; only?: string; 'no-rerun'?: boolean }
  try {
    const options = {
      corpus: { type: 'string' },
      out: { type: 'string' },
      factor: { type: 'string' },
      only: { type: 'string' },
      'no-rerun': { type: 'boolean' },
    } as const
    values = parseArgs({ args: [...argv], options }).values
  } catch (error) {
    throw new CorpusError(`${(error as Error).message}\n${usage}`)
  }
  const corpus = resolve(values.corpus ?? defaults.corpus)
  const out = resolve(values.out ?? defaults.out)
  const factor = values.factor === undefined ? defaults.factor : Number(values.factor)
  const rerun = values['no-rerun'] !== true
  if (!rerun && values.factor !== undefined) throw new CorpusError(`--factor has no use with --no-rerun\n${usage}`)
  if (!Number.isInteger(factor) || factor < 2) throw new CorpusError(`--factor must be an integer of 2 or more\n${usage}`)
  if (isInside(out, corpus)) throw new CorpusError(`the benchmark writes nothing under the corpus: --out ${out}`)
  // The corpus is benchmarked only once its build directories are the corpus build, byte for byte.
  const unbuilt = [...verifyBuilds(corpus), ...verifyBuilds(join(corpus, 'scale'))]
  if (unbuilt.length > 0) {
    const listed = unbuilt.slice(0, 20).map((problem) => `\n  ${problem}`)
    throw new CorpusError(`the corpus build differs from its manifests in ${unbuilt.length} files:${listed.join('')}`)
  }
  return { corpus, out, factor, rerun, only: values.only ?? null }
}

interface BenchmarkSite extends Site {
  kind: SiteResult['kind']
}

/**
 * The sites, in order: every validation-corpus site the reproducibility check scans (the holdout stays sealed), then
 * the scale fixture's builds by size, `scale/dist/webpack/<1mb|2.5mb|5mb>/nomaps`, whose `.js` bytes its sizes are
 * measured on (corpus README, Scale fixture).
 */
function benchmarkSites(corpus: string): BenchmarkSite[] {
  if (!isDirectory(corpus)) throw new CorpusError(`no corpus at ${corpus}`)
  const scale = ['1mb', '2.5mb', '5mb']
    .map((variant) => `scale/dist/webpack/${variant}/nomaps`)
    .filter((id) => isDirectory(join(corpus, id)))
  return [
    ...readSites(corpus).map((site) => ({ ...site, kind: 'corpus' as const })),
    ...scale.map((id) => ({ id, dir: join(corpus, id), kind: 'scale' as const })),
  ]
}

async function benchmarkSite(
  site: BenchmarkSite,
  context: {
    catalog: SerializedCatalog
    budget: Budget
    /** The reruns each corpus site gets; null with `--no-rerun`. */
    reruns: Rerun[] | null
    /** Where progress lines go. */
    progress: (text: string) => void
    measuring: Meter
    failures: Results['failures']
    heapMb: number
  },
): Promise<{ site: SiteResult; versions: { analyzerVersion: string; catalogVersion: string } } | null> {
  const { catalog, budget, measuring, failures } = context
  let report: Report
  const start = performance.now()
  try {
    measuring.take()
    report = JSON.parse(await scanCorpusSite(site.dir, surface, catalog, { budget, groups: measuring.groups })) as Report
  } catch (error) {
    failures.push({ id: site.id, run: 'measured', message: (error as Error).message.trimEnd() })
    return null
  }
  const scanMs = performance.now() - start
  const groups = measuring.take().map(measured)
  let variance: string[] | null = null
  let rerunVariance: SiteResult['reruns'] = null
  if (site.kind === 'corpus' && context.reruns !== null) {
    rerunVariance = []
    for (const { name, budget: raised } of context.reruns) {
      context.progress(`cost-benchmark: ${site.id} rerun ${name}\n`)
      try {
        const rerunReport = JSON.parse(await rerun(site.dir, raised, context.heapMb)) as Report
        rerunVariance.push({ name, variance: budgetVariance(report, rerunReport) })
      } catch (error) {
        failures.push({ id: site.id, run: name, message: (error as Error).message.trimEnd() })
      }
    }
    variance = [...new Set(rerunVariance.flatMap((each) => each.variance))]
  }
  return {
    site: {
      id: site.id,
      kind: site.kind,
      scanMs,
      bytes: groups.reduce((bytes, group) => bytes + group.bytes, 0),
      level: report.completeness.level,
      budgetExhausted: report.completeness.counters.statistics.budgetExhausted,
      groups,
      variance,
      reruns: rerunVariance,
    },
    versions: { analyzerVersion: report.tool.analyzerVersion, catalogVersion: report.tool.catalogVersion },
  }
}

/** The parts of a report the benchmark reads. */
interface Report {
  tool: { analyzerVersion: string; catalogVersion: string }
  findings: { fingerprint: string; effect: string; locks: unknown }[]
  completeness: { level: string; counters: { statistics: { budgetExhausted: number } } }
}

/**
 * The old-generation heap, in MiB, each worker thread may use: three quarters of this machine's memory. A raised-budget
 * rerun can need several times a cold scan's heap, and the main thread's default limit is too small for it.
 */
function workerHeapMb(): number {
  return Math.floor((totalmem() * 0.75) / 1024 ** 2)
}

/**
 * The JSON report `monkeypatchlist scan --json` prints for the site at `dir` with `budget`, scanned in a worker thread of its
 * own with `heapMb` of heap, so that a rerun that runs out of heap fails alone.
 */
function rerun(dir: string, budget: Budget, heapMb: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./rerun-worker.ts', import.meta.url), {
      workerData: { dir, surface, budget },
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
    })
    let answered = false
    worker.once('message', (reply: { report: string } | { error: string }) => {
      answered = true
      void worker.terminate()
      if ('report' in reply) resolve(reply.report)
      else reject(new Error(reply.error))
    })
    worker.once('error', (error) => {
      answered = true
      reject(error)
    })
    worker.once('exit', (code) => {
      if (!answered) reject(new Error(`the raised-budget rerun exited with code ${code}`))
    })
  })
}

function thisMachine(): Machine {
  return {
    platform: platform(),
    release: release(),
    arch: arch(),
    cpuModel: cpus()[0]?.model ?? 'unknown',
    cpus: availableParallelism(),
    memoryBytes: totalmem(),
    node: process.version,
    heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

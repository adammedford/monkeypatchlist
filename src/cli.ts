// The CLI's composition root: loads the configuration, wires the modules together, reads the clock for the report's
// `run` block, writes the output and chooses the exit code (§16).

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadCatalog, loadChangelog, type CatalogChangelog, type SerializedCatalog } from './catalog.ts'
import { defaultBudget, jsResolver, type Budget, type Resolver } from './packages/analysis/index.ts'
import {
  BaselineError,
  buildBaseline,
  formatVersion,
  migrations,
  newerVersions,
  readBaseline,
  readPrevious,
  renderBaseline,
  versionSkew,
  writtenVersions,
  type Baseline,
  type BaselineNote,
  type Migrations,
  type NewerVersion,
  type PreviousValues,
  type ReadBaseline,
  type Versions,
  type VersionSkew,
} from './packages/baseline/index.ts'
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js'
import {
  differingScanConfigFields,
  loadConfig,
  loadExplainConfig,
  usage as commandUsage,
  UsageError,
  type ScanConfig,
} from './packages/config/index.ts'
import { fingerprintScheme } from './packages/findings/index.ts'
import { findExplained, renderCandidates, renderExplanation } from './packages/report/explain.ts'
import { buildReport, renderAccepted, renderJson, reportVersion, type Report } from './packages/report/index.ts'
import { defaultMemoryBudget, workerRunner, type GroupRunner } from './packages/parallel/index.ts'
import { renderTerminal } from './packages/report/terminal.ts'
import { createSourceStore, offlineFetcher, type Fetcher } from './packages/source-store/index.ts'
import { resolveFetcher as makeResolveFetcher } from './packages/source-store/resolve.ts'
import { readLockfileInput } from './lockfile-input.ts'
import type { ResolvedReference } from './packages/discovery/index.ts'
import { scan } from './scan.ts'

/** Exit codes (§16). */
export const exitCodes = { success: 0, gateFailed: 1, usage: 2, incomplete: 3, internal: 4 } as const

/** The flags that print the versions (§16 Flags). */
const versionFlags = ['--version', '-v']

/** The CLI's usage text: the commands the config module reads, and `--version`, which the CLI answers itself. */
export const usage = `${commandUsage}\n       monkeypatchlist --version | -v`

/**
 * The wall-clock crash guard (§13, §18): a scan still analysing this long after it started runs no further link group,
 * and is `incomplete` with no findings. It guards against a runaway scan, far above the cost target (§18), and no
 * result depends on when it fired.
 */
export const crashGuardMs = 30 * 60 * 1000

export interface Io {
  /** `isTTY` is true when stdout is a terminal: only then is the terminal report colored (§15 Formatting). */
  stdout: { write(text: string): void; isTTY?: boolean }
  stderr: { write(text: string): void }
  /** The environment: `NO_COLOR` turns color off (§15 Formatting). */
  env?: Readonly<Record<string, string | undefined>>
  /** The working directory: relative paths, and the default `monkeypatchlist.config.json`, are found from it. */
  cwd(): string
}

/** What the CLI plugs into the pipeline. Tests may swap any of them. */
export interface Deps {
  resolver: Resolver
  loadCatalog: () => SerializedCatalog
  /** Reads the catalog changelog shipped with the catalog (§4 Catalog versions). */
  loadChangelog: () => CatalogChangelog
  /**
   * Makes the fetcher `--mode resolve` reads remote URLs through (§19 Source store and retrieval), once per scan, or is
   * null when this build has none. `offline` always uses the offline fetcher, and never calls this, so no command
   * touches the network unless `--mode resolve` is given (§16).
   */
  resolveFetcher: (() => Fetcher) | null
  /** A monotonic clock in milliseconds: the `run` block's duration and the crash guard read it. */
  clock: () => number
  /** The wall clock: the `run` block's `startedAt`, and when each fetch finished. */
  now: () => Date
  /** How a baseline in an older format or fingerprint scheme is read (§4 Version skew, §11 Format versions). */
  migrations: Migrations
  /**
   * The step budget per source byte of a link group, and the caps (§18): the shipped constants. They are never a flag;
   * the cost benchmark swaps in multiplied ones for its raised-budget rerun.
   */
  budget: Budget
  /**
   * How many link groups may be analyzed at once (§18 Parallelism), an internal setting and never a flag. At 1, the
   * default, they run one after another in process. Above 1, they run in worker threads with the shipped resolver, so
   * `resolver` must be it, while the groups' estimated peak heaps fit `memoryBudget`. Either way the report is the same.
   */
  workers: number
  /** The memory, in bytes, the estimated peak heaps of the groups running at once must fit in (§18 Parallelism). */
  memoryBudget: number
  /**
   * The references only the resolver can see that a scan's first round starts from (§19), never a flag: none by
   * default. A test seeds every one up front to show the report doesn't depend on the rounds.
   */
  seed: readonly ResolvedReference[]
  /**
   * Makes what runs a scan's link groups, given the catalog and budget it runs with, in place of the runner `workers`
   * chooses, or null for that runner. Internal and never a flag: the cost benchmark swaps in one that measures each
   * group's time and peak heap (§18 Target). Whatever runs the groups, the report is the same.
   */
  groups: ((setup: { catalog: SerializedCatalog; budget: Budget }) => GroupRunner) | null
}

const defaultDeps: Deps = {
  resolver: jsResolver,
  loadCatalog,
  loadChangelog,
  // A fresh fetcher for each scan, so that nothing it caches or counts outlives the scan (§17 Caching).
  resolveFetcher: () => makeResolveFetcher({ version: monkeypatchlistVersion(), env: process.env }),
  clock: () => performance.now(),
  now: () => new Date(),
  migrations,
  budget: defaultBudget,
  workers: 1,
  memoryBudget: defaultMemoryBudget,
  seed: [],
  groups: null,
}

/** Runs `monkeypatchlist <argv…>`. Returns the exit code. The terminal report goes to stdout, and diagnostics to stderr. */
export async function main(argv: readonly string[], io: Io, deps: Partial<Deps> = {}): Promise<number> {
  const {
    resolver,
    loadCatalog,
    loadChangelog,
    resolveFetcher,
    clock,
    now,
    migrations,
    budget,
    workers,
    memoryBudget,
    groups,
    seed,
  } = {
    ...defaultDeps,
    ...deps,
  }
  try {
    const cwd = io.cwd()
    // `--version` prints the versions and reads no config file or build directory (§16 Flags).
    if (versionFlags.includes(argv[0] ?? '')) return version(argv, io, { loadCatalog, resolver })
    // `explain` reads a saved report and never scans (§16 Commands).
    if (argv[0] === 'explain') return explain(argv.slice(1), io)
    const config = loadConfig(argv, { cwd })
    if (config.mode === 'resolve' && resolveFetcher === null) {
      throw new UsageError("--mode resolve isn't available: this build of monkeypatchlist has no resolve fetcher")
    }
    const buildDir = resolve(cwd, config.buildDir)
    if (!statSync(buildDir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new UsageError(`build directory '${config.buildDir}' is not a directory`)
    }
    const catalog = loadCatalog()
    const versions: Versions = {
      formatVersion,
      fingerprintScheme,
      catalogVersion: catalog.metadata.catalogVersion,
      monkeypatchlistVersion: monkeypatchlistVersion(),
    }
    const baseline = comparedBaseline({ cwd, config, versions, migrations }, io.stderr)
    const replaced = replacedNewer({ cwd, config, versions, migrations })

    const startedAt = now()
    const start = clock()
    const fetcher = config.mode === 'resolve' && resolveFetcher !== null ? resolveFetcher() : offlineFetcher
    // Each source-map directory is relative to the working directory, and is read under the name it was declared by.
    const sourceMapDirs = new Map(config.sourceMaps.map((dir) => [dir, resolve(cwd, dir)]))
    const store = createSourceStore({ buildDir, mappings: config.mappings, fetcher, now, sourceMapDirs })
    const result = await scan(config, {
      store,
      catalog,
      changelog: loadChangelog(),
      resolver,
      monkeypatchlistVersion: versions.monkeypatchlistVersion,
      baseline,
      crashGuard: { fired: () => clock() - start >= crashGuardMs },
      budget,
      lockfile: config.lockfile === null ? null : readLockfileInput(cwd, config.lockfile),
      ...(groups !== null
        ? { groups: groups({ catalog, budget }) }
        : workers > 1
          ? { groups: parallelGroups({ resolver, workers, memoryBudget, catalog, budget }) }
          : {}),
    }, seed)
    const report = buildReport({
      ...result,
      run: {
        startedAt: startedAt.toISOString(),
        durationMs: Math.round(clock() - start),
        retrievals: store.retrievals(),
      },
    })

    const json = renderJson(report)
    if (config.json === '-') io.stdout.write(json)
    else {
      // Color only on a TTY, and never under a non-empty `NO_COLOR` or `--no-color` (§15 Formatting, no-color.org).
      const noColor = io.env?.NO_COLOR
      const color = io.stdout.isTTY === true && (noColor === undefined || noColor === '') && config.color
      io.stdout.write(
        renderTerminal(report, { color, verbose: config.verbose, listIneffective: config.listIneffective }),
      )
      if (config.json !== null) writeFileSync(resolve(cwd, config.json), json)
    }

    // Under `--fail-on`, `--allow-incomplete` downgrades an `incomplete` scan's exit code 3 to a warning (§13, §16).
    const { level } = result.completeness
    if (config.command === 'scan' && config.failOn.length > 0 && config.allowIncomplete && level === 'incomplete') {
      io.stderr.write(
        'monkeypatchlist: warning: the scan is incomplete, so the gate saw only what it analyzed; --allow-incomplete ' +
          'downgrades exit code 3 to this warning\n',
      )
    }

    // `baseline init` and `baseline update` accept the whole current finding set (§11 Commands).
    if (config.command !== 'scan') {
      const fired = result.completeness.counters.statistics.crashGuard === 'fired'
      // `baseline init` refuses a scan whose crash guard fired (exit 3), even with `--allow-incomplete`, and writes
      // nothing (§13): such a scan reports no findings, and the guard never changes results.
      if (config.command === 'baseline init' && fired) {
        io.stderr.write(
          `monkeypatchlist: baseline init refuses a scan whose crash guard fired, even under --allow-incomplete, so ` +
            `${config.out} is left as it was: a scan whose guard fired reports no findings. Run it again\n`,
        )
        return exitCodes.incomplete
      }
      // `baseline init` and `baseline update` refuse an `incomplete` scan unless `--allow-incomplete` is given (§11
      // Commands, §13).
      if (level === 'incomplete' && !config.allowIncomplete) {
        io.stderr.write(
          `monkeypatchlist: ${config.command} refuses an incomplete scan, so ${config.out} is left as it was: the report's ` +
            'completeness says what was not analyzed. Pass --allow-incomplete to write it anyway\n',
        )
        return exitCodes.incomplete
      }
      // A scan whose crash guard fired reports no findings, so `baseline update --allow-incomplete` leaves the baseline
      // unchanged (§13): every entry is `unconfirmed`, and the header keeps the versions and level it was written
      // under.
      if (config.command === 'baseline update' && fired) {
        io.stderr.write(
          `monkeypatchlist: warning: the crash guard fired, so baseline update left ${config.out} as it was: a scan whose ` +
            'guard fired reports no findings, and every baseline entry is unconfirmed\n',
        )
        return report.gate.exitCode
      }
      const baseline = buildBaseline({
        scanConfigId: config.scanConfigId,
        surface: config.surface,
        tool: result.tool,
        completeness: level,
        findings: result.findings,
        packages: result.packages,
      })
      writeFileSync(resolve(cwd, config.out), renderBaseline(baseline))
      // Once the file is written, `baseline update` prints what it accepted (§11 Commands): after the terminal report,
      // or on stderr when stdout carries the JSON report instead.
      if (config.command === 'baseline update') {
        const accepted = renderAccepted(report, config.out)
        if (config.json === '-') io.stderr.write(accepted)
        else io.stdout.write(`\n${accepted}`)
      }
      // `baseline init` writes on an `incomplete` scan under `--allow-incomplete`, with a warning (§11 Commands, §13).
      if (config.command === 'baseline init' && level === 'incomplete') {
        io.stderr.write(
          "monkeypatchlist: warning: baseline init wrote a baseline from a scan that is incomplete (the report's " +
            'completeness says what was not analyzed), so it lacks whatever the scan could not analyze\n',
        )
      }
      // `baseline update` writes on a `complete-with-limitations` scan, and on an `incomplete` one under
      // `--allow-incomplete`, with a warning (§11 Commands, §13). The entries the scan couldn't confirm are carried
      // forward unchanged.
      if (config.command === 'baseline update' && level !== 'complete') {
        const unconfirmed = result.findings.filter((finding) => finding.baselineState === 'unconfirmed').length
        const entries = `${unconfirmed} unconfirmed ${unconfirmed === 1 ? 'entry' : 'entries'}`
        io.stderr.write(
          `monkeypatchlist: warning: baseline update wrote a baseline from a scan that is ${level} (the report's completeness ` +
            `says what was not analyzed), and carried ${entries} forward unchanged\n`,
        )
      }
      // Under `--allow-downgrade`, `baseline init` replaced a baseline a newer version wrote (§4 Version skew).
      if (replaced.length > 0) {
        io.stderr.write(
          `monkeypatchlist: warning: baseline init replaced '${config.out}', which a newer version wrote ` +
            `(${newerThan(replaced)}), with a baseline this one wrote\n`,
        )
      }
      const count = baseline.entries.length
      io.stderr.write(`monkeypatchlist: wrote ${config.out} (${count} ${count === 1 ? 'entry' : 'entries'})\n`)
    }
    return report.gate.exitCode
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`monkeypatchlist: ${error.message}\n${usage}\n`)
      return exitCodes.usage
    }
    io.stderr.write(`monkeypatchlist: internal error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return exitCodes.internal
  }
}

/**
 * `monkeypatchlist --version` (§16 Flags): one line on stdout, `monkeypatchlist <version> · catalog <n> · analyzer
 * <analyzerVersion>`, with the values a scan's report records in its `tool` block, read from the same places: the
 * package version, the catalog the CLI loads and the resolver it runs. Anything after the flag is a usage error.
 */
function version(
  argv: readonly string[],
  io: Io,
  { loadCatalog, resolver }: Pick<Deps, 'loadCatalog' | 'resolver'>,
): number {
  if (argv.length > 1) throw new UsageError(`${argv[0]} takes no other arguments`)
  const catalogVersion = loadCatalog().metadata.catalogVersion
  io.stdout.write(
    `monkeypatchlist ${monkeypatchlistVersion()} · catalog ${catalogVersion} · analyzer ${resolver.analyzerVersion}\n`,
  )
  return exitCodes.success
}

/**
 * `monkeypatchlist explain <fingerprint|target> --report <file>` (§16 Commands): renders one finding from a saved JSON report,
 * with every occurrence and its trace (§14). It reads only the report, never the build directory, and runs no scan. A
 * fingerprint or target the report doesn't hold is a usage error (exit 2), and so is a target that names several
 * findings, which lists them with their fingerprints.
 */
function explain(argv: readonly string[], io: Io): number {
  const config = loadExplainConfig(argv, { cwd: io.cwd() })
  const report = readReport(resolve(io.cwd(), config.report), config.report)
  const explained = findExplained(report, config.query)
  if (explained.kind === 'unknown') {
    io.stderr.write(`monkeypatchlist: no finding in '${config.report}' has the fingerprint or target '${config.query}'\n`)
    return exitCodes.usage
  }
  if (explained.kind === 'ambiguous') {
    const count = explained.candidates.length
    io.stderr.write(
      `monkeypatchlist: '${config.query}' names ${count} findings in '${config.report}'; explain one by its fingerprint:\n` +
        renderCandidates(explained.candidates),
    )
    return exitCodes.usage
  }
  io.stdout.write(renderExplanation(report, explained.finding))
  return exitCodes.success
}

let validateReport: ValidateFunction | undefined

/** Reads a saved JSON report (§15), or throws a `UsageError` when it can't be read or doesn't follow the report schema. */
function readReport(path: string, given: string): Report {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new UsageError(`report '${given}' can't be read: ${(error as NodeJS.ErrnoException).code ?? error}`)
  }
  let value: unknown
  try {
    value = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text)
  } catch (error) {
    throw new UsageError(`report '${given}' is not valid JSON: ${(error as Error).message}`)
  }
  validateReport ??= new Ajv2020({ allErrors: true, strict: true }).compile(
    JSON.parse(readFileSync(new URL('../schema/report.schema.json', import.meta.url), 'utf8')),
  )
  if (!validateReport(value)) {
    const [first] = validateReport.errors ?? []
    const where = first === undefined ? '' : `: ${first.instancePath || '(top level)'} ${first.message ?? ''}`
    throw new UsageError(`report '${given}' is not a monkeypatchlist JSON report this version reads${where}`)
  }
  return value as Report
}

/** What reading the baseline a command compares with depends on. */
interface BaselineContext {
  /** The working directory, which the baseline's path is relative to. */
  cwd: string
  config: ScanConfig
  /** This monkeypatchlist's versions, which a baseline's are compared with (§4 Version skew). */
  versions: Versions
  migrations: Migrations
}

/**
 * The baseline the scan compares with, its path as given, and its version-skew note if it has one (§4), or null for
 * none (§11):
 *
 * - `scan`'s `--baseline`. Without `--fail-on`, one that can't be used leaves the scan without a baseline, with a
 *   warning (§11 No baseline). Under `--fail-on` it is a usage error, so a mistyped path never passes CI.
 * - The file `baseline update` rewrites (`--out`), so that it can print what it accepts (§11 Commands). It must be a
 *   readable baseline: `baseline init` writes a new one.
 *
 * With it come the previous scan's values for the reachability and install-context notes (§11 Never `changed`): those
 * of `--previous`, which override a report baseline's, or those of a report baseline, or none.
 */
function comparedBaseline(
  context: BaselineContext,
  stderr: Io['stderr'],
): { path: string; baseline: Baseline; notes: BaselineNote[]; previous: PreviousValues | null } | null {
  const { config, versions } = context
  let path: string
  let read: ReadBaseline | null
  if (config.command === 'baseline update') {
    path = config.out
    read = loadBaseline(context, path, (problem) => {
      throw new UsageError(
        'baseline update needs a readable baseline to rewrite (after a merge conflict, check out either side and run ' +
          `it again, or write a new one with monkeypatchlist baseline init): ${problem}`,
      )
    })
  } else {
    if (config.command !== 'scan') return null
    if (config.baseline === null) {
      warnPreviousUnused(config, stderr)
      return null
    }
    const { failOn } = config
    path = config.baseline
    read = loadBaseline(context, path, (problem) => {
      if (failOn.length > 0) {
        throw new UsageError(
          `--fail-on needs a readable baseline (pass --baseline <path>, or write one with monkeypatchlist baseline init): ${problem}`,
        )
      }
      stderr.write(`monkeypatchlist: warning: scanning without a baseline, so findings have no baseline state: ${problem}\n`)
      return null
    })
  }
  if (read === null) {
    if (config.command === 'scan') warnPreviousUnused(config, stderr)
    return null
  }
  // A baseline written by another version scans with a note naming both versions (§4 Version skew).
  const skew = versionSkew(read.written, versions)
  if (skew !== null) heedSkew(skew, path, config, stderr)
  // An explicit `--previous` overrides a report baseline as the source of the previous values.
  const explicit = config.command === 'scan' && config.previous !== null ? loadPrevious(context, config.previous) : null
  return { path, baseline: read.baseline, notes: skew === null ? [] : [skew], previous: explicit ?? read.previous }
}

/** `--previous` without a baseline to compare with gives no notes, and a warning (§16). */
function warnPreviousUnused(config: ScanConfig & { command: 'scan' }, stderr: Io['stderr']): void {
  if (config.previous === null) return
  stderr.write(
    `monkeypatchlist: warning: --previous '${config.previous}' gives no reachability or install-context notes without a ` +
      'baseline: the notes follow the baseline pairing, so pass --baseline <path> as well\n',
  )
}

/**
 * The previous scan's values in the report `path` names (§16 `--previous`). A report that can't be read, isn't a scan
 * report this monkeypatchlist reads, or was written for another scan configuration is a usage error.
 */
function loadPrevious({ cwd, config }: BaselineContext, path: string): PreviousValues {
  let text: string
  try {
    text = readFileSync(resolve(cwd, path), 'utf8')
  } catch (error) {
    throw new UsageError(`previous report '${path}' can't be read: ${(error as NodeJS.ErrnoException).code ?? error}`)
  }
  let read
  try {
    read = readPrevious(text, reportVersion)
  } catch (error) {
    if (!(error instanceof BaselineError)) throw error
    throw new UsageError(`previous report '${path}' can't be used: ${error.message}`)
  }
  // A previous report is compared only with a scan of the configuration it was written from, as a baseline is.
  const differing = differingScanConfigFields(config.scanConfigId, read.scanConfigId)
  if (differing.length > 0) {
    throw new UsageError(
      `previous report '${path}' was written for another scan configuration: it differs from this scan in its ` +
        `${fieldList(differing)}. Pass a report of a scan with the same settings`,
    )
  }
  return read.values
}

/** Field names as `a`, `a and b` or `a, b and c`. */
function fieldList(fields: readonly string[]): string {
  return fields.length === 1 ? fields[0]! : `${fields.slice(0, -1).join(', ')} and ${fields.at(-1)}`
}

/**
 * What a baseline written by another version means for the command, beyond the note (§4 Version skew, §11 Format
 * versions, ADR 0008):
 *
 * - `baseline update` refuses to rewrite one written by a newer version unless `--allow-downgrade` is given.
 * - An older format or fingerprint scheme was migrated in memory, with a warning.
 * - One written by a newer version (a stale install) scans with a warning.
 */
function heedSkew(skew: VersionSkew, path: string, config: ScanConfig, stderr: Io['stderr']): void {
  const [baseline, scan] = [versionsOf(skew, 'baseline'), versionsOf(skew, 'scan')]
  if (skew.newer === 'baseline' && config.command === 'baseline update' && !config.allowDowngrade) {
    throw new UsageError(
      `baseline update won't rewrite '${path}': it was written by a newer version (${baseline}) than this one ` +
        `(${scan}). Upgrade monkeypatchlist, or pass --allow-downgrade to rewrite it with this one`,
    )
  }
  for (const version of ['formatVersion', 'fingerprintScheme'] as const) {
    const { baseline: written, scan: current } = skew[version]
    if (written < current) {
      stderr.write(
        `monkeypatchlist: warning: baseline '${path}' is in ${versionLabels[version]} ${written}, older than this ` +
          `monkeypatchlist's (${current}): it was migrated in memory, and baseline update rewrites it\n`,
      )
    }
  }
  if (skew.newer === 'baseline') {
    stderr.write(
      `monkeypatchlist: warning: baseline '${path}' was written by a newer version (${baseline}) than this one (${scan}): ` +
        "findings carry no explainedBy, and a delta may come from the newer version's catalog or analyzer. Upgrade " +
        'monkeypatchlist to compare like with like\n',
    )
  }
}

/**
 * The versions of the baseline `baseline init` replaces (`--out`) that are newer than this monkeypatchlist's (§4 Version
 * skew), or none for any other command. One with any was written by a newer monkeypatchlist or catalog, and `init` refuses to
 * replace it unless `--allow-downgrade` is given, before it scans. A file it can't read (a missing one, say) has none,
 * and so does a file that records no version it can read, such as one left with merge-conflict markers: both are
 * replaced, and a write that fails is an internal error.
 */
function replacedNewer({ cwd, config, versions, migrations }: BaselineContext): NewerVersion[] {
  if (config.command !== 'baseline init') return []
  let text: string
  try {
    text = readFileSync(resolve(cwd, config.out), 'utf8')
  } catch {
    return []
  }
  const newer = newerVersions(writtenVersions(text, migrations), versions)
  if (newer.length > 0 && !config.allowDowngrade) {
    throw new UsageError(
      `baseline init won't replace '${config.out}': it was written by a newer version (${newerThan(newer)}). ` +
        'Upgrade monkeypatchlist, or pass --allow-downgrade to replace it with a baseline this one writes',
    )
  }
  return newer
}

/** How a message names each version a baseline header records. */
const versionLabels: Record<keyof Versions, string> = {
  formatVersion: 'formatVersion',
  fingerprintScheme: 'fingerprint scheme',
  catalogVersion: 'catalog',
  monkeypatchlistVersion: 'monkeypatchlist',
}

/** Each newer version and this monkeypatchlist's, as `catalog 5, newer than this one's 4`. */
function newerThan(newer: readonly NewerVersion[]): string {
  return newer
    .map(({ name, baseline, scan }) => `${versionLabels[name]} ${baseline}, newer than this one's ${scan}`)
    .join('; ')
}

/** The monkeypatchlist and catalog versions on one side of a version skew, as `monkeypatchlist 1.2.0 · catalog 3`. */
function versionsOf(skew: VersionSkew, side: 'baseline' | 'scan'): string {
  return `monkeypatchlist ${skew.monkeypatchlistVersion[side]} · catalog ${skew.catalogVersion[side]}`
}

/**
 * Reads a baseline to compare with (§11), or null when there is none to compare with.
 *
 * - A file that can't be read, or isn't a baseline, is passed to `unreadable`, which says what that means for the
 *   command: a usage error, or a scan without a baseline (§11 No baseline).
 * - A baseline in a newer format, or written for another scan configuration, is a usage error either way (§11 Format
 *   versions, §16 Scan configuration identity).
 */
function loadBaseline(
  { cwd, config, migrations }: BaselineContext,
  path: string,
  unreadable: (problem: string) => null,
): ReadBaseline | null {
  let text: string
  try {
    text = readFileSync(resolve(cwd, path), 'utf8')
  } catch (error) {
    return unreadable(`baseline '${path}' can't be read: ${(error as NodeJS.ErrnoException).code ?? error}`)
  }
  let read: ReadBaseline
  try {
    // `scan --baseline` also reads a full scan report (§11 Baseline, ADR 0020); `baseline update` rewrites a baseline file.
    const report = config.command === 'scan' ? { reportVersion, allowIncomplete: config.allowIncomplete } : undefined
    read = readBaseline(text, migrations, report === undefined ? {} : { report })
  } catch (error) {
    if (!(error instanceof BaselineError)) throw error
    const problem = `baseline '${path}' can't be used: ${error.message}`
    if (error.newerFormat) throw new UsageError(problem)
    return unreadable(problem)
  }
  // A baseline is compared only with a scan of the configuration it was written from (§16, ADR 0017).
  const differing = differingScanConfigFields(config.scanConfigId, read.baseline.scanConfigId)
  if (differing.length > 0) {
    throw new UsageError(
      `baseline '${path}' was written for another scan configuration: it differs from this scan in its ${fieldList(differing)}. ` +
        'Scan with the settings it was written with, or write a new baseline with monkeypatchlist baseline init',
    )
  }
  return read
}

function monkeypatchlistVersion(): string {
  return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
}

/**
 * The worker-thread group runner (§18 Parallelism). Its workers run the shipped resolver, so a scan that swaps in
 * another one may not ask for workers.
 */
function parallelGroups(options: {
  resolver: Resolver
  workers: number
  memoryBudget: number
  catalog: SerializedCatalog
  budget: Budget
}): GroupRunner {
  if (options.resolver !== jsResolver) throw new Error('parallel link groups run only the shipped resolver')
  return workerRunner(options)
}

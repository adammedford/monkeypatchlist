// Config (§19, module 1): CLI flags and `monkeypatchlist.config.json` into a validated scan configuration. It knows nothing
// about artifacts.

import { basename, resolve } from 'node:path'
import { parseCommandLine, parseExplainCommandLine } from './lib/command-line.ts'
import { readConfigFile } from './lib/config-file.ts'
import { scanConfigId } from './lib/scan-config-id.ts'
import {
  failOnStates,
  UsageError,
  type BaselineCommand,
  type Entry,
  type FailOnState,
  type Mapping,
  type Mode,
  type SurfaceScope,
} from './lib/types.ts'

export { differingScanConfigFields } from './lib/scan-config-id.ts'
export {
  failOnStates,
  UsageError,
  type Entry,
  type FailOnState,
  type Mapping,
  type Mode,
  type SurfaceScope,
} from './lib/types.ts'

/**
 * The default baseline file (§16): the one `baseline init` writes and `baseline update` rewrites (`--out`), and the one
 * a scan compares with under `--fail-on` (`--baseline`). It is relative to the working directory.
 */
export const defaultBaselineFile = 'monkeypatchlist.baseline.json'

/**
 * A validated scan configuration: `scan`'s, which names the baseline it compares with, or a baseline command's, which
 * names the baseline file it writes. `baseline update` also compares with that file before it rewrites it.
 */
export type ScanConfig = CommonConfig &
  (
    | {
        command: 'scan'
        /**
         * `--baseline`: the baseline to compare with, relative to the working directory, or null for none (§11): a
         * baseline file, or a full JSON scan report (ADR 0020). Under `--fail-on` it defaults to `monkeypatchlist.baseline.json`.
         */
        baseline: string | null
        /**
         * `--previous`: a previous JSON scan report, relative to the working directory, or null for none (§16). Its
         * values feed the reachability and install-context notes, overriding a report baseline's; it needs a baseline.
         */
        previous: string | null
        /** `--fail-on`: the baseline states that fail the gate, in the order of `failOnStates`; none runs no gate. */
        failOn: FailOnState[]
      }
    | {
        command: BaselineCommand
        /** `--out`: the baseline file it writes, relative to the working directory. `baseline update` rewrites it. */
        out: string
        /**
         * `--allow-downgrade` (§4 Version skew, §16): `baseline init` replaces, and `baseline update` rewrites, a
         * baseline written by a newer catalog or monkeypatchlist version.
         */
        allowDowngrade: boolean
      }
  )

interface CommonConfig {
  /** The build directory, as given. */
  buildDir: string
  /** The application name (§16): the report header and the terminal title. It is not identity. */
  name: string
  entries: Entry[]
  mappings: Mapping[]
  /**
   * `--source-maps`: the source-map directories (§2 Source maps), relative to the working directory, in the order they
   * are searched: the flags' order, or the config array's when no flag is given. They are not in the scan-config id
   * (§16).
   */
  sourceMaps: string[]
  /** The surface the scan reports, baselines and gates (§12). The findings module applies it. */
  surface: SurfaceScope
  /** `--mode`: the remote retrieval mode (§17). Only `resolve` fetches remote references. */
  mode: Mode
  /**
   * `--lockfile` and `lockfile.importer` (§10 Introducing dependencies): the lockfile, relative to the working
   * directory, and the workspace of the scanned application in it, or null when the first-party source paths pick it.
   * Null when no lockfile is given. It isn't in the scan-config id (§16).
   */
  lockfile: { path: string; importer: string | null } | null
  /** `--json`: a path to write the JSON report to, `-` for stdout instead of the terminal report, or null. */
  json: string | null
  /** The scan-config id (§16): what the baseline records, to be compared only with scans of the same configuration. */
  scanConfigId: string
  /**
   * `--allow-incomplete` (§13, §16): an `incomplete` scan under `--fail-on` warns instead of exiting 3, and `baseline
   * init` and `baseline update` write one. After a fired crash guard, `baseline init` still refuses, and `baseline
   * update` leaves the baseline unchanged (§13). On `scan`, it also makes an `incomplete` report readable as the
   * baseline, read as `baseline update --allow-incomplete` would write it (§11).
   */
  allowIncomplete: boolean
  /** `--verbose` (§16): the terminal report cards existing findings too. Only `scan` takes the flag. */
  verbose: boolean
  /** `--list-ineffective` (§16): the terminal report lists the ineffective writes. Only `scan` takes the flag. */
  listIneffective: boolean
  /**
   * False under `--no-color` (§16). The terminal report is colored only when this is true, stdout is a TTY and
   * `NO_COLOR` is unset or empty (§15 Formatting); the CLI judges the last two.
   */
  color: boolean
}

const flags =
  '[--config <path>] [--map <urlPrefix>=<dir>]... [--entry <file>[@<url>]]... [--source-maps <dir>]... ' +
  '[--surface protected|all] [--mode offline|resolve] [--lockfile <path>] [--json <path|->] [--no-color]'
export const usage = [
  `usage: monkeypatchlist scan <buildDir> ${flags} [--baseline <path>] [--previous <report.json>] [--fail-on added,changed] [--allow-incomplete] [--verbose] [--list-ineffective]`,
  `       monkeypatchlist baseline init <buildDir> ${flags} [--out <path>] [--allow-incomplete] [--allow-downgrade]`,
  `       monkeypatchlist baseline update <buildDir> ${flags} [--out <path>] [--allow-incomplete] [--allow-downgrade]`,
  '       monkeypatchlist explain <fingerprint|target> --report <file> [--config <path>] [--no-color]',
].join('\n')

/**
 * The scan configuration for `monkeypatchlist <argv…>` run in `cwd`, or a `UsageError`. It reads the config file `--config`
 * names, or `monkeypatchlist.config.json` in `cwd` if there is one, and the flags override it field by field (§16). Its paths
 * are relative to `cwd`, except entry files and mapping directories, which are relative to the build directory.
 */
export function loadConfig(argv: readonly string[], options: { cwd: string }): ScanConfig {
  const { cwd } = options
  const commandLine = parseCommandLine(argv)
  const file = readConfigFile(commandLine.config, cwd) ?? {}
  const settings = { ...file, ...commandLine.settings }
  // `--lockfile` sets only the path: the file's importer stays (§16 Flags).
  const lockfile = { ...file.lockfile, ...commandLine.settings.lockfile }

  const { mappings = [] } = settings
  const [mapping] = mappings
  if (mapping === undefined) {
    throw new UsageError('no URL mapping given: pass --map <urlPrefix>=<dir>, or give mappings in the config file')
  }
  // An entry document's URL defaults to the first mapping's URL (§16).
  const entries = (settings.entries ?? [{ file: 'index.html' }]).map(({ file, url }) => ({
    file,
    url: url ?? mapping.url,
  }))
  entries.forEach(({ file, url }, i) => {
    if (entries.findIndex((other) => other.file === file && other.url === url) < i) {
      throw new UsageError(`entry document '${file}' at ${url} is given twice`)
    }
  })
  // The application name defaults to the build directory's basename (§16). A filesystem root has none.
  const buildDir = resolve(cwd, commandLine.buildDir)
  // The surface defaults to protected (§12).
  const surface = settings.surface ?? 'protected'

  const common: CommonConfig = {
    buildDir: commandLine.buildDir,
    name: settings.name ?? (basename(buildDir) || buildDir),
    entries,
    mappings,
    sourceMaps: settings.sourceMaps ?? [],
    surface,
    // The mode defaults to offline (§17): no command touches the network unless `--mode resolve` is given.
    mode: settings.mode ?? 'offline',
    lockfile: lockfile.path === undefined ? null : { path: lockfile.path, importer: lockfile.importer ?? null },
    json: settings.json ?? null,
    scanConfigId: scanConfigId({ entries, mappings, surface }),
    allowIncomplete: settings.allowIncomplete ?? false,
    // Only `scan` reads `verbose` and `listIneffective` (§16), from its flags or the file.
    verbose: commandLine.command === 'scan' && (settings.verbose ?? false),
    listIneffective: commandLine.command === 'scan' && (settings.listIneffective ?? false),
    color: !(settings.noColor ?? false),
  }
  if (commandLine.command !== 'scan') {
    const { command } = commandLine
    const allowDowngrade = settings.allowDowngrade ?? false
    return { command, ...common, out: settings.out ?? defaultBaselineFile, allowDowngrade }
  }
  const failOn = failOnStates.filter((state) => settings.failOn?.includes(state))
  // Under `--fail-on`, the baseline defaults to `monkeypatchlist.baseline.json` (§16): a gate never runs without one.
  const baseline = settings.baseline ?? (failOn.length > 0 ? defaultBaselineFile : null)
  return { command: 'scan', ...common, baseline, previous: settings.previous ?? null, failOn }
}

/** What `monkeypatchlist explain` reads (§16 Commands): the finding asked for, and the saved JSON report it is found in. */
export interface ExplainConfig {
  command: 'explain'
  /** The fingerprint or target, as given. */
  query: string
  /** The saved JSON report, relative to the working directory: `--report`, or the config file's `report`. */
  report: string
}

/**
 * The configuration for `monkeypatchlist explain <argv…>` run in `cwd` (the arguments after `explain`), or a `UsageError`.
 * Only `report` is read from the config file; explain reads no build directory, so the scan settings don't apply.
 */
export function loadExplainConfig(argv: readonly string[], options: { cwd: string }): ExplainConfig {
  const commandLine = parseExplainCommandLine(argv)
  // The config file is read and validated as for every command; the flag overrides its key (§16).
  const file = readConfigFile(commandLine.config, options.cwd)
  const report = commandLine.report ?? file?.report
  if (report === undefined) {
    throw new UsageError('explain needs the saved JSON report to read: pass --report <file>')
  }
  return { command: 'explain', query: commandLine.query, report }
}

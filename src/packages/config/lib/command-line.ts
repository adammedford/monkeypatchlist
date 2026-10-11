// The command line (§16 Commands, Flags).

import { parseArgs } from 'node:util'
import {
  failOnStates,
  UsageError,
  type Command,
  type FailOnState,
  type Mapping,
  type Mode,
  type Settings,
  type SurfaceScope,
} from './types.ts'
import { httpUrl } from './urls.ts'

export interface CommandLine {
  command: Command
  /** The build directory, as given. */
  buildDir: string
  /** `--config <path>`, as given. */
  config: string | undefined
  /** The settings the flags give. */
  settings: Settings
}

/** Parses `monkeypatchlist <argv…>`, or throws a `UsageError`. */
export function parseCommandLine(argv: readonly string[]): CommandLine {
  const { command, rest } = parseCommand(argv)

  let parsed
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', multiple: true },
        entry: { type: 'string', multiple: true },
        map: { type: 'string', multiple: true },
        'source-maps': { type: 'string', multiple: true },
        surface: { type: 'string', multiple: true },
        mode: { type: 'string', multiple: true },
        lockfile: { type: 'string', multiple: true },
        json: { type: 'string', multiple: true },
        out: { type: 'string', multiple: true },
        baseline: { type: 'string', multiple: true },
        previous: { type: 'string', multiple: true },
        'fail-on': { type: 'string', multiple: true },
        'allow-incomplete': { type: 'boolean' },
        'allow-downgrade': { type: 'boolean' },
        verbose: { type: 'boolean' },
        'list-ineffective': { type: 'boolean' },
        'no-color': { type: 'boolean' },
      },
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
  const { positionals, values } = parsed

  if (positionals.length !== 1) {
    throw new UsageError(positionals.length === 0 ? 'no build directory given' : `unexpected argument '${positionals[1]}'`)
  }

  const settings: Settings = {}
  if (values.map !== undefined) settings.mappings = mappings(values.map.map(parseMapping))
  if (values.entry !== undefined) settings.entries = values.entry.map(parseEntry)
  if (values['source-maps'] !== undefined) settings.sourceMaps = sourceMaps(values['source-maps'])
  const surface = one('--surface', values.surface)
  if (surface !== undefined) settings.surface = parseSurface(surface)
  const mode = one('--mode', values.mode)
  if (mode !== undefined) settings.mode = parseMode(mode)
  // `--lockfile` sets `lockfile.path`; the importer is only a config key (§16 Flags).
  const lockfile = one('--lockfile', values.lockfile)
  if (lockfile === '') throw new UsageError('--lockfile needs a path')
  if (lockfile !== undefined) settings.lockfile = { path: lockfile }
  const json = one('--json', values.json)
  if (json !== undefined) settings.json = json
  // `--out` names the file a baseline command writes.
  if (command === 'scan' && values.out !== undefined) {
    throw new UsageError("--out is a baseline flag: scan doesn't write a baseline")
  }
  const out = one('--out', values.out)
  if (out !== undefined) settings.out = out
  // `--baseline` names the baseline a scan compares with, `--previous` the previous report its notes compare with, and
  // `--fail-on` gates on the baseline.
  for (const flag of ['baseline', 'previous', 'fail-on'] as const) {
    if (command !== 'scan' && values[flag] !== undefined) {
      throw new UsageError(`--${flag} is a scan flag: ${command} accepts the whole finding set`)
    }
  }
  const baseline = one('--baseline', values.baseline)
  if (baseline !== undefined) settings.baseline = baseline
  const previous = one('--previous', values.previous)
  if (previous !== undefined) settings.previous = previous
  const failOn = one('--fail-on', values['fail-on'])
  if (failOn !== undefined) settings.failOn = parseFailOn(failOn)
  // `--allow-incomplete` downgrades exit code 3 to a warning, and lets `baseline init` and `baseline update` write
  // (§16), except after a fired crash guard (§13). On `scan` it also lets an incomplete report be the baseline (§11).
  if (values['allow-incomplete'] === true) settings.allowIncomplete = true
  // `--allow-downgrade` lets `baseline init` and `baseline update` replace a baseline written by a newer version (§4
  // Version skew, §16).
  if (values['allow-downgrade'] === true) {
    if (command === 'scan') throw new UsageError("--allow-downgrade is a baseline flag: scan writes no baseline")
    settings.allowDowngrade = true
  }
  // `--verbose` and `--list-ineffective` are scan flags (§16): what a baseline command accepts is the whole finding set.
  for (const flag of ['verbose', 'list-ineffective'] as const) {
    if (command !== 'scan' && values[flag] === true) throw new UsageError(`--${flag} is a scan flag`)
  }
  if (values.verbose === true) settings.verbose = true
  if (values['list-ineffective'] === true) settings.listIneffective = true
  if (values['no-color'] === true) settings.noColor = true

  return { command, buildDir: positionals[0]!, config: one('--config', values.config), settings }
}

/** The command (`scan`, `baseline init` or `baseline update`), and the arguments after it. */
function parseCommand(argv: readonly string[]): { command: Command; rest: readonly string[] } {
  const [command, ...rest] = argv
  if (command === 'scan') return { command, rest }
  if (command === 'baseline') {
    const [subcommand, ...after] = rest
    if (subcommand === 'init' || subcommand === 'update') return { command: `baseline ${subcommand}`, rest: after }
    throw new UsageError(
      subcommand === undefined ? 'no baseline command given' : `unknown command 'baseline ${subcommand}'`,
    )
  }
  throw new UsageError(command === undefined ? 'no command given' : `unknown command '${command}'`)
}

/** The one value of a flag that may be given once. */
function one(flag: string, values: string[] | undefined): string | undefined {
  if (values !== undefined && values.length > 1) throw new UsageError(`${flag} can be given only once`)
  return values?.[0]
}

/** Parses `added,changed`: a comma-separated list of the states the gate fails on, each named once. */
function parseFailOn(value: string): FailOnState[] {
  const states: FailOnState[] = []
  for (const state of value.split(',')) {
    if (state === 'removed' || state === 'unconfirmed') {
      throw new UsageError(`--fail-on can't gate on ${state}: only added and changed can`)
    }
    if (!isFailOnState(state)) {
      throw new UsageError(`--fail-on takes added and changed, separated by commas, got '${value}'`)
    }
    if (states.includes(state)) throw new UsageError(`--fail-on names ${state} twice`)
    states.push(state)
  }
  return states
}

function isFailOnState(state: string): state is FailOnState {
  return (failOnStates as readonly string[]).includes(state)
}

/** Parses `protected|all`. */
function parseSurface(value: string): SurfaceScope {
  if (value === 'protected' || value === 'all') return value
  throw new UsageError(`--surface must be protected or all, got '${value}'`)
}

/** Parses `offline|resolve`. */
function parseMode(value: string): Mode {
  if (value === 'offline' || value === 'resolve') return value
  throw new UsageError(`--mode must be offline or resolve, got '${value}'`)
}

/**
 * Parses `<file>[@<url>]`. The URL starts after the first `@` that begins an absolute URL, so a file name may hold an
 * `@` of its own. It must be an `http:` or `https:` URL.
 */
function parseEntry(value: string): { file: string; url?: string } {
  for (let at = value.indexOf('@'); at !== -1; at = value.indexOf('@', at + 1)) {
    if (URL.parse(value.slice(at + 1)) === null) continue
    const file = value.slice(0, at)
    if (file === '') throw new UsageError(`--entry needs a file before @<url>, got '${value}'`)
    const url = httpUrl(value.slice(at + 1))
    if ('problem' in url) throw new UsageError(`--entry URL ${url.problem}`)
    return { file, url: url.href }
  }
  if (value === '') throw new UsageError('--entry needs a file')
  return { file: value }
}

/** The `--map` flags, with no URL prefix mapped twice: under longest-prefix-wins, the second would never be used. */
function mappings(list: Mapping[]): Mapping[] {
  list.forEach(({ url }, i) => {
    if (list.findIndex((other) => other.url === url) < i) throw new UsageError(`--map maps '${url}' twice`)
  })
  return list
}

/**
 * The `--source-maps` flags, in the order given, which is the order the directories are searched in (§2 Source maps).
 * A directory given twice would only be searched again.
 */
function sourceMaps(list: string[]): string[] {
  list.forEach((dir, i) => {
    if (dir === '') throw new UsageError('--source-maps needs a directory')
    if (list.indexOf(dir) < i) throw new UsageError(`--source-maps names '${dir}' twice`)
  })
  return list
}

/** Parses `<urlPrefix>=<dir>`. The prefix is an absolute `http:` or `https:` URL. */
function parseMapping(value: string): Mapping {
  const split = value.indexOf('=')
  if (split <= 0 || split === value.length - 1) throw new UsageError(`--map needs <urlPrefix>=<dir>, got '${value}'`)
  const url = httpUrl(value.slice(0, split))
  if ('problem' in url) throw new UsageError(`--map URL prefix ${url.problem}`)
  return { url: url.href, dir: value.slice(split + 1) }
}

/** `monkeypatchlist explain <fingerprint|target> [--report <file>] [--config <path>]`, as given. */
export interface ExplainCommandLine {
  /** The fingerprint or target to explain. */
  query: string
  /** `--config <path>`, as given. */
  config: string | undefined
  /** `--report <file>`, as given, relative to the working directory. */
  report: string | undefined
}

/** Parses the arguments after `monkeypatchlist explain`, or throws a `UsageError`. */
export function parseExplainCommandLine(argv: readonly string[]): ExplainCommandLine {
  let parsed
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', multiple: true },
        report: { type: 'string', multiple: true },
        // Every command takes `--no-color` (§16); explain's output has no color to turn off.
        'no-color': { type: 'boolean' },
      },
    })
  } catch (error) {
    throw new UsageError((error as Error).message)
  }
  const { positionals, values } = parsed
  if (positionals.length !== 1) {
    throw new UsageError(
      positionals.length === 0 ? 'explain needs a fingerprint or target' : `unexpected argument '${positionals[1]}'`,
    )
  }
  const report = one('--report', values.report)
  if (report === '') throw new UsageError('--report needs a file')
  return { query: positionals[0]!, config: one('--config', values.config), report }
}

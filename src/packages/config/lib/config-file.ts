// The configuration file (§16): `monkeypatchlist.config.json`, or the file `--config` names. It is JSON, only ever parsed.

import { readFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { schemaProblems } from './schema.ts'
import { UsageError, type FailOnState, type Mapping, type Mode, type Settings, type SurfaceScope } from './types.ts'
import { httpUrl } from './urls.ts'

/** The file used when `--config` is not given, if it exists in the working directory. */
export const defaultConfigFile = 'monkeypatchlist.config.json'

/**
 * The keys of a valid config file that monkeypatchlist reads so far. The schema (`schema/config.schema.json`) accepts every
 * §16 key, and `out`; the tickets that build the behaviour behind the others read them here.
 */
interface ConfigFile {
  name?: string
  entries?: { file: string; url?: string }[]
  mappings?: Mapping[]
  sourceMaps?: string[]
  surface?: SurfaceScope
  mode?: Mode
  lockfile?: { path?: string; importer?: string }
  json?: string
  out?: string
  baseline?: string
  previous?: string
  failOn?: FailOnState[]
  allowIncomplete?: boolean
  allowDowngrade?: boolean
  report?: string
  verbose?: boolean
  listIneffective?: boolean
  noColor?: boolean
}

/**
 * Reads the config file: `path` relative to `cwd`, or `monkeypatchlist.config.json` in `cwd` if it exists. Returns its
 * settings, or undefined when there is no file. Throws a `UsageError` naming the failing path when the file is invalid.
 *
 * The file's own paths are relative to its directory, and come back relative to `cwd`, as a flag's are. Entry files and
 * mapping directories stay relative to the build directory.
 */
export function readConfigFile(path: string | undefined, cwd: string): Settings | undefined {
  const file = path ?? defaultConfigFile
  // A CI gate for platform integrity must not execute its own configuration, so a JS or TS config file is never
  // loaded. Only a `.json` file is read, and it is only ever parsed.
  if (extname(file).toLowerCase() !== '.json') {
    throw new UsageError(`config file '${file}' is not a .json file: monkeypatchlist never loads JS or TS configuration`)
  }

  let text: string
  try {
    text = readFileSync(resolve(cwd, file), 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Only a missing default file means "no config file". Any other failure is a config error (exit 2), not exit 4.
    if (path === undefined && code === 'ENOENT') return undefined
    throw new UsageError(`config file '${file}' can't be read: ${code ?? error}`)
  }
  let value: unknown
  try {
    // A leading UTF-8 byte order mark is dropped.
    value = JSON.parse(text.startsWith('\uFEFF') ? text.slice(1) : text)
  } catch (error) {
    throw new UsageError(`config file '${file}' is not valid JSON: ${(error as Error).message}`)
  }
  const problems = schemaProblems(value)
  if (problems.length > 0) throw invalid(file, problems)
  const config = value as ConfigFile

  // URLs are checked and canonicalized as the flags' are.
  const canonical = (url: string, pointer: string) => {
    const parsed = httpUrl(url)
    if ('problem' in parsed) throw invalid(file, [`${pointer}: ${parsed.problem}`])
    return parsed.href
  }
  const fromFile = (relative: string) => (isAbsolute(relative) ? relative : join(dirname(file), relative))

  const settings: Settings = {}
  if (config.name !== undefined) settings.name = config.name
  if (config.entries !== undefined) {
    settings.entries = config.entries.map((entry, i) =>
      entry.url === undefined ? { file: entry.file } : { file: entry.file, url: canonical(entry.url, `/entries/${i}/url`) },
    )
  }
  if (config.mappings !== undefined) {
    const mappings = config.mappings.map(({ url, dir }, i) => ({ url: canonical(url, `/mappings/${i}/url`), dir }))
    // The longest matching prefix wins, so two mappings for one prefix would leave one unused.
    mappings.forEach(({ url }, i) => {
      const first = mappings.findIndex((other) => other.url === url)
      if (first < i) throw invalid(file, [`/mappings/${i}/url: '${url}' is already mapped by /mappings/${first}`])
    })
    settings.mappings = mappings
  }
  if (config.sourceMaps !== undefined) {
    const sourceMaps = config.sourceMaps.map(fromFile)
    // Two entries that name one directory relative to the file (`maps`, `./maps`) would only search it again, as a
    // flag given twice would.
    sourceMaps.forEach((dir, i) => {
      const first = sourceMaps.indexOf(dir)
      if (first < i) throw invalid(file, [`/sourceMaps/${i}: '${dir}' is already declared by /sourceMaps/${first}`])
    })
    settings.sourceMaps = sourceMaps
  }
  if (config.surface !== undefined) settings.surface = config.surface
  if (config.mode !== undefined) settings.mode = config.mode
  if (config.lockfile !== undefined) {
    // The lockfile's path is relative to the file, as every path in it is; the importer is a workspace of the lockfile.
    const { path, importer } = config.lockfile
    settings.lockfile = {
      ...(path === undefined ? {} : { path: fromFile(path) }),
      ...(importer === undefined ? {} : { importer }),
    }
  }
  if (config.json !== undefined) settings.json = config.json === '-' ? '-' : fromFile(config.json)
  if (config.out !== undefined) settings.out = fromFile(config.out)
  if (config.baseline !== undefined) settings.baseline = fromFile(config.baseline)
  if (config.previous !== undefined) settings.previous = fromFile(config.previous)
  if (config.failOn !== undefined) settings.failOn = config.failOn
  if (config.allowIncomplete !== undefined) settings.allowIncomplete = config.allowIncomplete
  if (config.allowDowngrade !== undefined) settings.allowDowngrade = config.allowDowngrade
  if (config.report !== undefined) settings.report = fromFile(config.report)
  if (config.verbose !== undefined) settings.verbose = config.verbose
  if (config.listIneffective !== undefined) settings.listIneffective = config.listIneffective
  if (config.noColor !== undefined) settings.noColor = config.noColor
  return settings
}

function invalid(file: string, problems: string[]): UsageError {
  return new UsageError(`config file '${file}' is invalid:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
}

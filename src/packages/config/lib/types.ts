/** A URL→path mapping (§2): URLs under `url` are files under `dir`, relative to the build directory. */
export interface Mapping {
  url: string
  dir: string
}

/** An entry document (§2): its file, relative to the build directory, and its URL. */
export interface Entry {
  file: string
  url: string
}

/** The surface a scan reports, baselines and gates (§12, §16 `--surface`). */
export type SurfaceScope = 'protected' | 'all'

/** The remote retrieval mode (§17 Modes, §16 `--mode`): `offline` never fetches, and `resolve` does. */
export type Mode = 'offline' | 'resolve'

/** The baseline states the gate can fail on (§11 The gate, §16 `--fail-on`): `removed` and `unconfirmed` can't gate. */
export const failOnStates = ['added', 'changed'] as const

export type FailOnState = (typeof failOnStates)[number]

/** The commands (§16 Commands) built so far. */
export type Command = 'scan' | BaselineCommand

/** The baseline commands (§11 Commands): each writes the baseline `--out` names. */
export type BaselineCommand = 'baseline init' | 'baseline update'

/** Bad flags or configuration: exit code 2 (§16). */
export class UsageError extends Error {
  override name = 'UsageError'
}

/**
 * What the config file and the flags each give (§16): every field is optional, and a flag overrides the file field by
 * field. An entry's URL may be left out; it defaults to the first mapping's URL.
 */
export interface Settings {
  name?: string
  entries?: { file: string; url?: string }[]
  mappings?: Mapping[]
  sourceMaps?: string[]
  surface?: SurfaceScope
  mode?: Mode
  /**
   * The lockfile (§10 Introducing dependencies): `--lockfile` sets `path`, and the config key `lockfile.importer` names
   * the workspace of the scanned application.
   */
  lockfile?: { path?: string; importer?: string }
  json?: string
  out?: string
  baseline?: string
  /** `--previous`: a previous JSON scan report, for the reachability and install-context notes (§16). */
  previous?: string
  failOn?: FailOnState[]
  allowIncomplete?: boolean
  allowDowngrade?: boolean
  /** The saved JSON report `explain` reads (§16 `--report`). */
  report?: string
  /** `--verbose`: the terminal report cards existing findings too (§15 Terminal). */
  verbose?: boolean
  /** `--list-ineffective`: the terminal report lists the ineffective-write records (§3, §16). */
  listIneffective?: boolean
  /** `--no-color`: the terminal report is never colored (§15 Formatting). */
  noColor?: boolean
}

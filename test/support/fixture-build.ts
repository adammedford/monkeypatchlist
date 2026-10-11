// The end-to-end test pattern (README standing criteria): a small fixture build directory goes through
// `monkeypatchlist scan --json -`, and tests assert on report fields and trace kinds, never on rendered text.
//
//   const { report } = await scanBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': '…' })
//
// Every report a scan prints is validated against the shipped report JSON Schema before the test sees it. The CLI runs
// in a fresh, empty working directory, so it reads a `monkeypatchlist.config.json` only when a test writes one there
// (`workingDir()` and `runCli(argv, { cwd })`).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { afterAll } from 'vitest'
import { loadCatalog, type SerializedCatalog } from '../../src/catalog.ts'
import { main, type Deps } from '../../src/cli.ts'

/** The mapping `scanBuild` passes unless the test gives its own `--map`. */
export const defaultMap = 'https://app.example/=.'

const validateReport = new Ajv2020({ allErrors: true, strict: true }).compile(
  JSON.parse(readFileSync(new URL('../../schema/report.schema.json', import.meta.url), 'utf8')),
)

// Each test file that imports this module gets its own scratch directory, removed after its tests.
const scratch = mkdtempSync(join(tmpdir(), 'monkeypatchlist-builds-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/**
 * Writes `files` (build-relative path → contents) into a fresh temporary build directory and returns its path. The
 * directory's basename is `name`, so the application name a scan defaults to (§16) is the same for every copy.
 */
export function fixtureBuild(files: Record<string, string>, name = 'build'): string {
  const dir = join(mkdtempSync(join(scratch, 'build-')), name)
  mkdirSync(dir)
  return writeFiles(dir, files)
}

export interface CliRun {
  exitCode: number
  stdout: string
  stderr: string
}

/** A fresh, empty working directory, so no `monkeypatchlist.config.json` is picked up unless a test writes one. */
export function workingDir(files: Record<string, string> = {}): string {
  return writeFiles(mkdtempSync(join(scratch, 'cwd-')), files)
}

function writeFiles(dir: string, files: Record<string, string>): string {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

/** The terminal the CLI sees: whether stdout is a TTY, and the environment (`NO_COLOR`). Neither by default. */
export interface TerminalIo {
  tty: boolean
  env: Record<string, string>
}

export interface CliOptions {
  /** The terminal the CLI sees. */
  io?: Partial<TerminalIo>
  /** Modules to swap into the pipeline. */
  deps?: Partial<Deps>
  /** The working directory the CLI sees. Defaults to a fresh, empty one. */
  cwd?: string
}

/**
 * The shipped catalog, parsed once per test file and deep-frozen: parsing its 16 MB took most of a small scan's time,
 * and a scan that wrote to the shared copy would throw rather than leak into the next one.
 */
let sharedCatalog: SerializedCatalog | undefined
const sharedLoadCatalog = (): SerializedCatalog => (sharedCatalog ??= deepFreeze(loadCatalog()))

function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const each of Object.values(value)) deepFreeze(each)
  return value
}

/**
 * Runs the CLI in process, as `monkeypatchlist <argv…>` would, capturing its output. Unless `options.deps` swaps in a loader
 * of its own, the scan reads the shared, frozen catalog.
 */
export async function runCli(argv: string[], options: CliOptions = {}): Promise<CliRun> {
  let stdout = ''
  let stderr = ''
  const cwd = options.cwd ?? workingDir()
  const io = {
    stdout: { write: (text: string) => void (stdout += text), isTTY: options.io?.tty ?? false },
    stderr: { write: (text: string) => void (stderr += text) },
    cwd: () => cwd,
    env: options.io?.env ?? {},
  }
  const exitCode = await main(argv, io, { loadCatalog: sharedLoadCatalog, ...options.deps })
  return { exitCode, stdout, stderr }
}

/** Asserts that `report` validates against the shipped report JSON Schema. */
export function assertValidReport(report: unknown): void {
  if (!validateReport(report)) {
    throw new Error(`report fails its JSON Schema:\n${JSON.stringify(validateReport.errors, null, 2)}`)
  }
}

export interface ScanResult extends CliRun {
  /** The parsed JSON report, already validated against the report schema. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
  report: any
  /** The build directory that was scanned. */
  dir: string
}

/**
 * Scans a fixture build with `monkeypatchlist scan <dir> --map https://app.example/=. --surface all --json -` plus `args`,
 * and returns the validated report. `build` is a build directory, or the files of one to write first. `options` can
 * swap modules into the pipeline, such as a resolver built on another binding resolver.
 *
 * Most tests are about detection, which covers the whole catalog (§12), so the helper scans `--surface all` unless
 * `args` gives a `--surface` of its own. A test of the protected surface passes `--surface protected`, or calls
 * `runCli` to see the default.
 */
export async function scanBuild(
  build: string | Record<string, string>,
  args: string[] = [],
  options: CliOptions = {},
): Promise<ScanResult> {
  const dir = typeof build === 'string' ? build : fixtureBuild(build)
  const map = args.includes('--map') ? [] : ['--map', defaultMap]
  const surface = args.includes('--surface') ? [] : ['--surface', 'all']
  const run = await runCli(['scan', dir, ...map, ...surface, '--json', '-', ...args], options)
  if (run.exitCode !== 0) throw new Error(`scan exited ${run.exitCode}:\n${run.stderr}`)
  const report = JSON.parse(run.stdout)
  assertValidReport(report)
  return { ...run, report, dir }
}

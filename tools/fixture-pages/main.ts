// The fixture-page check (spec §20 Fixture pages and Bars). It scans every Chromium fixture page, for write outcomes
// and restores, with the production `monkeypatchlist scan --json --surface all`, compares the findings, ineffective-write
// records and restores with each page's expectation, and reports pass or fail per page. The fixture bar is judged on
// the whole catalog (§20 Slice). Build-time only; never published.
//
//   npm run fixtures:check [-- --root <dir>]
//
// The root defaults to the validation corpus's `fixtures/`. It reads the root and writes nothing.

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { loadCatalog, type SerializedCatalog } from '../../src/catalog.ts'
import { scanCorpusSite } from '../corpus-scan.ts'
import { corpusDir } from '../paths.ts'
import { comparePage, type ScanReport } from './compare.ts'
import { expectedToFail } from './expected-to-fail.ts'
import { FixturePagesError, readPages } from './pages.ts'

export interface Io {
  stdout: { write(text: string): void }
  stderr: { write(text: string): void }
}

/** Scans one page's build directory with `monkeypatchlist scan --json - --surface all`, and returns the JSON it printed. */
export type Scanner = (dir: string) => Promise<string>

/** What the command plugs in. Tests swap the scanner and the expected-to-fail markers. */
export interface Deps {
  scan: Scanner
  /** Page name → the ticket that implements what the page needs (`expected-to-fail.ts`). */
  expectedToFail: Readonly<Record<string, string>>
}

/**
 * One page's result. `differences` says how the report differs from the expectation. A page with an expected-to-fail
 * marker is `expected-fail` when it fails, and `unexpected-pass` when it passes; `marker` names its ticket.
 */
export interface PageResult {
  page: string
  status: 'pass' | 'fail' | 'expected-fail' | 'unexpected-pass'
  marker?: string
  differences: string[]
}

/** Whether a page's status fails the check. */
function failsCheck(result: PageResult): boolean {
  return result.status === 'fail' || result.status === 'unexpected-pass'
}

const defaultRoot = join(corpusDir, 'fixtures')

const usage = 'usage: node tools/fixture-pages/cli.ts [--root <dir>]'

/** The production scanner over `catalog`, with the whole catalog reported. */
export function monkeypatchlistScanner(catalog: SerializedCatalog): Scanner {
  return (dir) => scanCorpusSite(dir, 'all', catalog)
}

/**
 * Runs the command. Returns the exit code:
 *
 * - 0: every page passes, or fails with an expected-to-fail marker
 * - 1: a page fails with no marker, or passes with one
 * - 2: a bad flag, a root the check can't use, or a marker for a page the root doesn't have
 */
export async function main(argv: readonly string[], io: Io, deps: Partial<Deps> = {}): Promise<number> {
  let results: PageResult[]
  try {
    const root = parseOptions(argv)
    results = await checkFixturePages(root, deps)
  } catch (error) {
    if (error instanceof FixturePagesError) {
      io.stderr.write(`fixture-pages: ${error.message}\n`)
      return 2
    }
    throw error
  }
  for (const result of results) {
    io.stdout.write(`${headline(result)}\n`)
    for (const difference of result.differences) io.stdout.write(`        ${difference}\n`)
  }
  const passed = results.filter((r) => r.status === 'pass').length
  const expected = results.filter((r) => r.status === 'expected-fail').length
  const tail = expected === 0 ? '' : `, ${expected} expected to fail`
  io.stdout.write(`fixture-pages: ${passed} of ${results.length} pages pass${tail}\n`)
  return results.some(failsCheck) ? 1 : 0
}

function headline(result: PageResult): string {
  switch (result.status) {
    case 'pass':
      return `pass  ${result.page}`
    case 'fail':
      return `FAIL  ${result.page}`
    case 'expected-fail':
      return `xfail  ${result.page} (${result.marker})`
    case 'unexpected-pass':
      return `XPASS  ${result.page} (${result.marker}): remove its expected-to-fail marker`
  }
}

/** Scans and compares every page under `root`, in `expectations.json` order. A relative `root` is from the cwd. */
export async function checkFixturePages(root: string, deps: Partial<Deps> = {}): Promise<PageResult[]> {
  const pages = readPages(resolve(root))
  const markers = deps.expectedToFail ?? expectedToFail
  const stale = Object.keys(markers).filter((name) => !pages.some((page) => page.name === name))
  if (stale.length > 0) {
    throw new FixturePagesError(`expected-to-fail markers name pages the root doesn't have: ${stale.sort().join(', ')}`)
  }
  const scan = deps.scan ?? monkeypatchlistScanner(loadCatalog())
  const results: PageResult[] = []
  for (const page of pages) {
    const report = JSON.parse(await scan(page.dir)) as ScanReport
    const differences = comparePage(page.expected, page.restoreRegions, report)
    const marker = markers[page.name]
    const passes = differences.length === 0
    if (marker === undefined) results.push({ page: page.name, status: passes ? 'pass' : 'fail', differences })
    else results.push({ page: page.name, status: passes ? 'unexpected-pass' : 'expected-fail', marker, differences })
  }
  return results
}

function parseOptions(argv: readonly string[]): string {
  let values: { root?: string }
  try {
    values = parseArgs({ args: [...argv], options: { root: { type: 'string' } } }).values
  } catch (error) {
    throw new FixturePagesError(`${(error as Error).message}\n${usage}`)
  }
  const root = resolve(values.root ?? defaultRoot)
  if (!existsSync(root)) throw new FixturePagesError(`no fixture pages at ${root}`)
  return root
}

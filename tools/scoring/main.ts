// The accuracy scoring harness (§20 Scoring rules, Bars): runs the production `monkeypatchlist scan --json` over every build
// directory of the validation corpus, and scores the reports against the corpus's ground truth. It reads the corpus and
// writes nothing under it. Build-time only; never published.
//
//   npm run score [-- --corpus <dir>] [-- --out <dir>]
//
// It writes `<out>/scores.json` (machine-readable) and `<out>/scores.md` (the readable table, also printed), and exits 1
// when identity invariance (§20, zero tolerance) has any failure. The corpus defaults to
// `corpus/` (tools/paths.ts), and the output to `scores/`, both in the repository.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadCatalog, type SerializedCatalog } from '../../src/catalog.ts'
import { fixtureFetcher, type RecordedResponse } from '../../src/packages/source-store/fixture.ts'
import type { Fetcher } from '../../src/packages/source-store/index.ts'
import { scanCorpusSite } from '../corpus-scan.ts'
import { corpusDir, isInside } from '../paths.ts'
import { chromiumFromBcd, type ChromiumHas } from './chromium.ts'
import { CorpusError } from './corpus-error.ts'
import { readCorpus } from './corpus.ts'
import { trimReport } from './report.ts'
import { score, type ScanReport } from './score.ts'
import { renderTable } from './table.ts'

export interface Io {
  stdout: { write(text: string): void }
  stderr: { write(text: string): void }
}

/** What the harness plugs in. Tests may swap the scanner for canned reports. */
export interface Deps {
  /**
   * Scans one build directory with `monkeypatchlist scan --json`, and returns the parsed report. A vendor CDN site is given
   * the corpus's `vendor/` directory, whose pinned copies answer its remote URLs.
   */
  scan: (buildDir: string, catalog: SerializedCatalog, site?: { vendor: string }) => Promise<ScanReport>
  loadCatalog: () => SerializedCatalog
  /** Which natives Chromium has, for §20's Chromium rule. */
  chromiumHas: (catalog: SerializedCatalog) => ChromiumHas
}

const repository = fileURLToPath(new URL('../../', import.meta.url))
const defaults = { corpus: corpusDir, out: join(repository, 'scores') }

const defaultDeps: Deps = { scan: monkeypatchlistScan, loadCatalog, chromiumHas: chromiumFromBcd }

const usage = 'usage: npm run score -- [--corpus <dir>] [--out <dir>]'

/**
 * Runs the scoring command. Returns the exit code: 0 once scored, whatever the other bars say; 1 once scored with any
 * identity-invariance failure (§20: zero tolerance); 2 on bad input.
 */
export async function main(argv: readonly string[], io: Io, deps: Partial<Deps> = {}): Promise<number> {
  const { scan, loadCatalog, chromiumHas } = { ...defaultDeps, ...deps }
  try {
    let values: { corpus?: string; out?: string }
    try {
      values = parseArgs({ args: [...argv], options: { corpus: { type: 'string' }, out: { type: 'string' } } }).values
    } catch (error) {
      throw new CorpusError(`${(error as Error).message}\n${usage}`)
    }
    const corpusDir = resolve(values.corpus ?? defaults.corpus)
    const outDir = resolve(values.out ?? defaults.out)
    if (!existsSync(corpusDir)) throw new CorpusError(`no corpus at ${corpusDir}`)
    if (isInside(outDir, corpusDir)) throw new CorpusError(`the harness writes nothing under the corpus: --out ${outDir}`)

    const catalog = loadCatalog()
    const corpus = readCorpus(corpusDir)
    const reports = new Map<string, ScanReport>()
    for (const build of corpus.builds) {
      const site = build.vendor === undefined ? undefined : { vendor: build.vendor }
      // Only what the scorer reads is kept: all 200-odd full reports together outgrow the default heap.
      reports.set(build.id, trimReport(await scan(build.dir, catalog, site)))
    }

    const scores = score({ catalog, corpus, reports, chromiumHas: chromiumHas(catalog) })
    const table = renderTable(scores)
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'scores.json'), `${JSON.stringify(scores, null, 2)}\n`)
    writeFileSync(join(outDir, 'scores.md'), table)
    io.stdout.write(table)
    // Identity invariance is zero-tolerance (§20): any failure fails the run. No other bar sets the exit code.
    return scores.identityInvariance.failures > 0 ? 1 : 0
  } catch (error) {
    if (error instanceof CorpusError) {
      io.stderr.write(`score: ${error.message}\n`)
      return 2
    }
    throw error
  }
}

/**
 * Scans a build directory as `monkeypatchlist scan <dir> --map https://app.corpus.test/=. --json -` does, in process, with a
 * config that asks for the whole catalog (`surface: all`): the harness slices the protected surface itself. The config
 * sits in a temporary working directory, never in the corpus. The default scanner; tests wrap it to check each report
 * against the report schema.
 */
export async function monkeypatchlistScan(buildDir: string, catalog: SerializedCatalog, site?: { vendor: string }): Promise<ScanReport> {
  const fetcher = site === undefined ? undefined : vendorFetcher(site.vendor)
  return JSON.parse(await scanCorpusSite(buildDir, 'all', catalog, fetcher === undefined ? {} : { resolveFetcher: () => fetcher })) as ScanReport
}

/**
 * The fixture fetcher over the corpus's pinned CDN copies (corpus README, Serving): each URL `vendor/sources.json`
 * names answers with its file, as JavaScript, after a sha256 check, and every other URL fails, as the harness aborts it.
 */
export function vendorFetcher(vendor: string): Fetcher {
  const sources = JSON.parse(readFileSync(join(vendor, 'sources.json'), 'utf8')) as Record<string, { file: string; sha256: string }>
  const responses: Record<string, RecordedResponse> = {}
  for (const [url, { file, sha256 }] of Object.entries(sources)) {
    const body = readFileSync(join(vendor, file))
    const actual = createHash('sha256').update(body).digest('hex')
    if (actual !== sha256) throw new CorpusError(`vendor/${file} has sha256 ${actual}, but vendor/sources.json pins ${sha256}`)
    responses[url] = { headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }, body }
  }
  return fixtureFetcher(responses)
}

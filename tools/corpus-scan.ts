// Scanning a validation-corpus site in process, as the build-time tools that run over the corpus do (tools/scoring,
// tools/corpus-snapshot). Build-time only; never published.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SerializedCatalog } from '../src/catalog.ts'
import { main as monkeypatchlist, type Deps } from '../src/cli.ts'
import type { SurfaceScope } from '../src/packages/config/index.ts'

/** The URL prefix the corpus harness serves every site at (corpus README, Serving). */
export const corpusOrigin = 'https://app.corpus.test/'

/** The surface a scan reports, baselines and gates (§16 `--surface`, config key `surface`). */
export type ReportedSurface = SurfaceScope

/**
 * The JSON text `monkeypatchlist scan <dir> --map https://app.corpus.test/=. --config <file> --json -` prints, run in process
 * with `catalog`, and with whatever else of the CLI's deps `deps` swaps (the cost benchmark's budget and group runner).
 * The config names only the surface, and sits in a temporary working directory, never in the corpus. With a
 * `deps.resolveFetcher`, the scan runs in `--mode resolve` with it as the resolve fetcher. Throws when the scan exits
 * non-zero.
 */
export async function scanCorpusSite(
  dir: string,
  surface: ReportedSurface,
  catalog: SerializedCatalog,
  deps: Partial<Omit<Deps, 'loadCatalog'>> = {},
): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), 'monkeypatchlist-corpus-scan-'))
  try {
    const config = join(cwd, 'monkeypatchlist.config.json')
    writeFileSync(config, `${JSON.stringify({ surface })}\n`)
    let stdout = ''
    let stderr = ''
    const io = {
      stdout: { write: (text: string) => void (stdout += text) },
      stderr: { write: (text: string) => void (stderr += text) },
      cwd: () => cwd,
    }
    const argv = ['scan', dir, '--map', `${corpusOrigin}=.`, '--config', config, '--json', '-']
    if (typeof deps.resolveFetcher === 'function') argv.push('--mode', 'resolve')
    const exitCode = await monkeypatchlist(argv, io, { ...deps, loadCatalog: () => catalog })
    if (exitCode !== 0) throw new Error(`monkeypatchlist scan ${dir} exited ${exitCode}:\n${stderr}`)
    return stdout
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
}

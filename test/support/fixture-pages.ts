// Fixture-page corpora for the fixture-page check (tools/fixture-pages). A fixture-page root has the layout of the
// validation corpus's `fixtures/`: `expectations.json` and `static-sites/<page>/index.html`, with only the pages a test
// needs. The check runs over it as `npm run fixtures:check -- --root <dir>` would.
//
//   const root = fixturePages([page('control-replaceable-assign', 'control', 'window.length = 1;', { findings: […] })])
//   const run = await runCheck(root)

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll } from 'vitest'
import { checkFixturePages, main, monkeypatchlistScanner, type Deps, type PageResult } from '../../tools/fixture-pages/main.ts'
import { loadCatalog } from '../../src/catalog.ts'
import { assertValidReport } from './fixture-build.ts'

const scratch = mkdtempSync(join(tmpdir(), 'monkeypatchlist-fixture-pages-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** What the scanner is expected to report for a page, in the corpus's expectation spelling. */
export interface ResolverExpectation {
  /** `target|effect` */
  findings: string[]
  /** `target|reason|throws` */
  ineffective?: string[]
  /** `target` */
  restores?: string[]
}

export interface FixturePage {
  name: string
  kind: 'restore' | 'ineffective' | 'control'
  /** Each inline classic script's text, in document order. */
  scripts: string[]
  resolver: ResolverExpectation
}

/** A fixture page with the given inline script (or scripts) and resolver expectation. */
export function page(
  name: string,
  kind: FixturePage['kind'],
  scripts: string | string[],
  resolver: ResolverExpectation,
): FixturePage {
  return { name, kind, scripts: typeof scripts === 'string' ? [scripts] : scripts, resolver }
}

/** Writes the pages, as `fixtures/pages.mjs` would, into a fresh fixture-page root and returns its path. */
export function fixturePages(pages: FixturePage[], options: { extraSites?: string[] } = {}): string {
  const root = mkdtempSync(join(scratch, 'fixtures-'))
  const expectations = pages.map((p) => ({ name: p.name, kind: p.kind, runtime: { install: [] }, resolver: p.resolver }))
  writeFileSync(join(root, 'expectations.json'), `${JSON.stringify(expectations, null, 1)}\n`)
  for (const p of pages) writeSite(root, p.name, p.scripts)
  for (const name of options.extraSites ?? []) writeSite(root, name, [''])
  return root
}

function writeSite(root: string, name: string, scripts: string[]): void {
  const dir = join(root, 'static-sites', name)
  mkdirSync(dir, { recursive: true })
  const body = scripts.map((code) => `<script>\n${code}\n</script>\n`).join('')
  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>fixture: ${name}</title></head>\n<body>\n${body}</body>\n</html>\n`,
  )
}

/** The real scanner, with every report validated against the shipped report schema. */
function validatingScanner(): Deps['scan'] {
  const scan = monkeypatchlistScanner(loadCatalog())
  return async (dir) => {
    const text = await scan(dir)
    assertValidReport(JSON.parse(text))
    return text
  }
}

/** A canned finding: its target in the window realm, its effect, and each occurrence's location and trace kinds. */
export function finding(
  name: string,
  effect: string,
  occurrences: { artifact?: string; start: number; end: number; line: number; column: number; trace?: string[] }[] = [],
): object {
  return {
    target: { realm: 'window', holder: 'global', name },
    effect,
    occurrences: occurrences.map((o) => ({
      artifact: { url: o.artifact ?? 'https://app.corpus.test/#inline-1' },
      generated: { start: o.start, end: o.end, line: o.line, column: o.column },
      trace: (o.trace ?? ['binding']).map((kind) => ({ kind, text: kind })),
    })),
  }
}

/** A canned ineffective-write record (§3 Record): its target in the window realm, its reason, each occurrence's `throws`. */
export function ineffective(name: string, reason: string, throws: string[]): object {
  return {
    target: { realm: 'window', holder: 'global', name },
    reason,
    occurrences: throws.map((t) => ({ throws: t })),
  }
}

/** A canned report with the fields the check reads. */
export function report(fields: { findings?: object[]; ineffectiveWrites?: object[] }): object {
  return { findings: fields.findings ?? [], ineffectiveWrites: fields.ineffectiveWrites ?? [] }
}

/** A scanner that returns the canned report of each page, by page name. */
export function cannedScan(byPage: Record<string, object>): Deps['scan'] {
  return async (dir) => {
    const name = basename(dir)
    const canned = byPage[name]
    if (canned === undefined) throw new Error(`no canned report for ${name}`)
    return JSON.stringify(canned)
  }
}

export interface CheckRun {
  exitCode: number
  stdout: string
  stderr: string
  results: PageResult[]
}

/** Runs the check over `root`: its per-page results, and the command's exit code and output. */
export async function runCheck(root: string, deps: Partial<Deps> = {}, argv: string[] = []): Promise<CheckRun> {
  const given: Partial<Deps> = { scan: validatingScanner(), expectedToFail: {}, ...deps }
  // The command and `checkFixturePages` share one scan of each page.
  const scan = given.scan!
  const reports = new Map<string, Promise<string>>()
  const full: Partial<Deps> = {
    ...given,
    scan: (dir) => {
      if (!reports.has(dir)) reports.set(dir, scan(dir))
      return reports.get(dir)!
    },
  }
  let stdout = ''
  let stderr = ''
  const io = {
    stdout: { write: (text: string) => void (stdout += text) },
    stderr: { write: (text: string) => void (stderr += text) },
  }
  const exitCode = await main(['--root', root, ...argv], io, full)
  let results: PageResult[] = []
  if (exitCode !== 2) results = await checkFixturePages(root, full)
  return { exitCode, stdout, stderr, results }
}

// Fixture corpora for the accuracy scoring harness (tools/scoring). A fixture corpus has the validation corpus's layout
// (`dist/<bundler>/<app>/<maps|nomaps>/`, `ground-truth/…`, `labels/…`, `variants/…`, `static-sites/control/`), with
// only the files a test needs. The harness runs over it as `npm run score -- --corpus <dir> --out <dir>` would.
//
//   const corpus = fixtureCorpus({ 'dist/webpack/otel/maps/index.html': '…', ...groundTruth('webpack/otel/maps', […]) })
//   const { scores } = await scoreCorpus(corpus)

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll } from 'vitest'
import type { Realm } from '../../src/catalog.ts'
import { main, monkeypatchlistScan, type Deps } from '../../tools/scoring/main.ts'
import type { ScanReport } from '../../tools/scoring/score.ts'
import { assertValidReport } from './fixture-build.ts'

const scratch = mkdtempSync(join(tmpdir(), 'monkeypatchlist-corpora-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** Writes `files` (corpus-relative path → contents) into a fresh corpus directory and returns its path. */
export function fixtureCorpus(files: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, 'corpus-'))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  return dir
}

/** A fresh, empty directory outside any corpus. */
export function scratchDir(): string {
  return mkdtempSync(join(scratch, 'out-'))
}

/** A ground-truth mutation record, as the corpus harness writes one. Only the fields the scorer reads are required. */
export interface Mutation {
  target: string
  effect: string
  holder?: string
  key?: string
  holderKind?: string
  shadows?: string
}

/**
 * The ground-truth file of a base build (`webpack/otel/maps`), a variant build (`features-on:webpack/datadog/maps`) or
 * a native-absent run (`native-absent:webpack/core-js/maps.promise`), as a file for `fixtureCorpus`.
 */
export function groundTruth(site: string, mutations: Mutation[]): Record<string, string> {
  const [variant, path] = splitSite(site)
  const file = variant === null ? `ground-truth/${path}.json` : `variants/${variant}/ground-truth/${path}.json`
  const records = mutations.map((m) => {
    const dot = m.target.lastIndexOf('.')
    return {
      target: m.target,
      holder: m.holder ?? m.target.slice(0, dot),
      holderKind: m.holderKind ?? 'prototype',
      key: m.key ?? m.target.slice(dot + 1),
      effect: m.effect,
      ...(m.shadows === undefined ? {} : { shadows: m.shadows }),
    }
  })
  return { [file]: JSON.stringify({ site, mutations: records }, null, 1) }
}

/** `features-on:webpack/datadog/maps` → the variant and the build path; a base build has no variant. */
function splitSite(site: string): [string | null, string] {
  const colon = site.indexOf(':')
  return colon === -1 ? [null, site] : [site.slice(0, colon), site.slice(colon + 1)]
}

/** A hand label (`labels/unobserved.json`): a mutation in the code that no run executed. */
export interface HandLabel {
  target: string
  effect: string
  reachability: string
  /** A rule correction of its reachability (corpus README): the label it replaced, with a citation. */
  correction?: { from: string; citation: string }
}

/** `labels/unobserved.json`, by library, with the citation fields every label carries. */
export function handLabels(byLibrary: Record<string, HandLabel[]>): Record<string, string> {
  const labels = Object.fromEntries(
    Object.entries(byLibrary).map(([library, entries]) => [
      library,
      entries.map((e) => ({ ...e, reason: 'fixture', source: `${library}@0.0.0 index.js L1` })),
    ]),
  )
  return { 'labels/unobserved.json': JSON.stringify({ $schema: 'fixture hand labels', ...labels }, null, 1) }
}

/** An adjudication (`labels/adjudications.json`): the triage class of one disagreement (§20 Triage). */
export interface Adjudication {
  target: string
  disagreement: 'false-positive' | 'false-negative'
  class: string
}

/** `labels/adjudications.json`, by library, each entry with a citation. */
export function adjudications(byLibrary: Record<string, Adjudication[]>): Record<string, string> {
  const entries = Object.fromEntries(
    Object.entries(byLibrary).map(([library, list]) => [
      library,
      list.map((e) => ({ ...e, citation: `${library}@0.0.0 index.js L1` })),
    ]),
  )
  return { 'labels/adjudications.json': JSON.stringify({ $schema: 'fixture adjudications', ...entries }, null, 1) }
}

/** A reachability hand-sample entry (`labels/reachability-sample.json`, §20 Reachability labels). */
export interface SampleLabel {
  target: string
  reachability: string
}

/** `labels/reachability-sample.json`, by library, each entry with a citation. */
export function reachabilitySample(byLibrary: Record<string, SampleLabel[]>): Record<string, string> {
  const entries = Object.fromEntries(
    Object.entries(byLibrary).map(([library, list]) => [
      library,
      list.map((e) => ({ ...e, citation: `${library}@0.0.0 index.js L1` })),
    ]),
  )
  return { 'labels/reachability-sample.json': JSON.stringify({ $schema: 'fixture reachability sample', ...entries }, null, 1) }
}

/** A build directory whose one classic script is `code`, at `dist/<build>/` (or `variants/<v>/dist/…`). */
export function build(site: string, code: string): Record<string, string> {
  const [variant, path] = splitSite(site)
  const dir = variant === null ? `dist/${path}` : `variants/${variant}/dist/${path}`
  return { [`${dir}/index.html`]: '<!doctype html><script src="main.js"></script>', [`${dir}/main.js`]: code }
}

/** A finding of a canned report: the fields the scorer reads. */
export type CannedFinding = ScanReport['findings'][number]

/** What a canned finding may set beyond its target and effect. Every other report field takes a fixed default. */
export interface CannedExtra {
  shadows?: string
  reachability?: string
  realm?: Realm
  /** Its attribution key: `unknown` by default. */
  key?: string
  locks?: boolean | 'unknown'
  reachabilityBasis?: 'call-path' | 'creation-site'
  installContext?: 'load' | 'deferred'
  /** The `guard` steps of its one occurrence's trace: the native each tests, and its class. */
  guards?: { class: string; tested?: string; result: string }[]
}

/**
 * A canned finding on `name`, in the window realm unless `extra` says otherwise. Its fingerprint and target key are
 * spelled as the scanner spells them (§11): `realm|target|effect|attribution key`.
 */
export function finding(name: string, effect: string, extra: CannedExtra = {}): CannedFinding {
  const { shadows, reachability, realm = 'window', key = 'unknown', locks = false, guards = [] } = extra
  const targetKey = `${realm}|${name}|${effect}`
  const provenance = key === 'unknown' ? 'unknown' : key.startsWith('pkg:') ? 'bundled-dependency' : 'first-party'
  const trace = guards.map((guard) => ({ kind: 'guard', text: 'canned guard', expression: 'canned', ...guard }))
  return {
    fingerprint: `${targetKey}|${key}`,
    targetKey,
    target: { realm, holder: 'prototype', name, ...(shadows === undefined ? {} : { shadows }) },
    surface: 'other',
    effect,
    locks,
    attribution: { key, provenance, ...(key.startsWith('pkg:') ? { package: key.slice(4) } : {}) },
    ...(reachability === undefined ? {} : { reachability }),
    ...(extra.reachabilityBasis === undefined ? {} : { reachabilityBasis: extra.reachabilityBasis }),
    ...(extra.installContext === undefined ? {} : { installContext: extra.installContext }),
    occurrences: [{ ...(reachability === undefined ? {} : { reachability }), trace }],
  }
}

/**
 * A scanner that answers with canned reports, keyed by the build directory's corpus-relative path
 * (`dist/webpack/otel/maps`, `variants/features-on/dist/webpack/datadog/maps`). A build it has no report for has no
 * findings.
 */
export function cannedScan(byBuild: Record<string, CannedFinding[]>): Pick<Deps, 'scan'> {
  const tool = { monkeypatchlistVersion: '0.0.0', catalogVersion: 1, analyzerVersion: 'canned', fingerprintScheme: 1 }
  return {
    scan: async (dir) => {
      const key = Object.keys(byBuild).find((path) => dir.endsWith(`/${path}`))
      return { tool, findings: key === undefined ? [] : byBuild[key]! }
    },
  }
}

export interface ScoreRun {
  /** 0 once scored; 1 once scored with identity-invariance failures. */
  exitCode: number
  stdout: string
  stderr: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read score fields freely
  scores: any
  /** The readable table the run wrote. */
  table: string
  out: string
}

/** Scores `corpus` into a fresh output directory, and returns the parsed scores file and the table. */
export async function scoreCorpus(corpus: string, deps: Partial<Deps> = {}): Promise<ScoreRun> {
  const out = scratchDir()
  const run = await runScoring(['--corpus', corpus, '--out', out], deps)
  // 1: scored, with identity-invariance failures (§20), which the scores list.
  if (run.exitCode !== 0 && run.exitCode !== 1) throw new Error(`scoring exited ${run.exitCode}:\n${run.stderr}`)
  return {
    ...run,
    scores: JSON.parse(readFileSync(join(out, 'scores.json'), 'utf8')),
    table: readFileSync(join(out, 'scores.md'), 'utf8'),
    out,
  }
}

/**
 * Runs the scoring command in process, capturing its output. Unless a test swaps the scanner, every report the
 * production `monkeypatchlist scan --json` gives is validated against the shipped report JSON Schema (README standing
 * criteria).
 */
export async function runScoring(
  argv: string[],
  deps: Partial<Deps> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const io = { stdout: { write: (text: string) => void (stdout += text) }, stderr: { write: (text: string) => void (stderr += text) } }
  const exitCode = await main(argv, io, { scan: validatedScan, ...deps })
  return { exitCode, stdout, stderr }
}

const validatedScan: Deps['scan'] = async (dir, catalog, site) => {
  const report = await monkeypatchlistScan(dir, catalog, site)
  assertValidReport(report)
  return report
}

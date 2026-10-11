// `monkeypatchlist explain <fingerprint|target> --report <file>` (§14 Where traces appear, §16 Commands): renders one finding
// from a saved JSON report, with every occurrence, its location, attribution and the text of its trace steps. It never
// rescans. Explain is terminal output, so these tests read the rendered text (README standing criteria).

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { Resolver } from '../src/packages/analysis/index.ts'
import { defaultMap, fixtureBuild, runCli, workingDir } from './support/fixture-build.ts'

const lines = (...code: string[]) => code.join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** Scans a classic-script build and saves its JSON report as `report.json` in a fresh working directory. */
async function savedReport(code: string): Promise<{ cwd: string; report: Report }> {
  const dir = fixtureBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
  const cwd = workingDir()
  const run = await runCli(['scan', dir, '--map', defaultMap, '--surface', 'all', '--json', 'report.json'], { cwd })
  expect(run.exitCode, run.stderr).toBe(0)
  return { cwd, report: JSON.parse(readFileSync(join(cwd, 'report.json'), 'utf8')) }
}

const brief = lines(
  'const proto = EventTarget.prototype;',
  'const method = "add" + "EventListener";',
  '',
  'proto[method] = wrapper;',
)

describe('monkeypatchlist explain', () => {
  test("explaining the brief's proto[method] = wrapper shows its binding, alias and fold steps", async () => {
    const { cwd, report } = await savedReport(brief)
    const [finding] = report.findings
    expect(finding.fingerprint).toBe('window|EventTarget.prototype.addEventListener|replace|unknown')

    const run = await runCli(['explain', finding.fingerprint, '--report', 'report.json'], { cwd })

    expect(run.exitCode, run.stderr).toBe(0)
    const out = run.stdout
    expect(out).toContain('EventTarget.prototype.addEventListener')
    expect(out).toContain(finding.fingerprint)
    expect(out).toContain('main.js:4:0')
    const trace = finding.occurrences[0].trace
    expect(trace.map((step: { kind: string }) => step.kind)).toEqual(['binding', 'alias', 'fold'])
    // Each step appears, in order, as its kind and its rendered text.
    const stepLines = out.split('\n').filter((line) => trace.some((step: { text: string }) => line.endsWith(step.text)))
    expect(stepLines.map((line) => line.trim().split(/\s+/)[0])).toEqual(['binding', 'alias', 'fold'])
  })

  test("a finding whose locks is unknown says so, and one that doesn't lock has no Locks line", async () => {
    const { cwd, report } = await savedReport(brief)
    expect(report.findings[0].locks).toBe(false)
    const plain = await runCli(['explain', report.findings[0].fingerprint, '--report', 'report.json'], { cwd })
    expect(plain.exitCode, plain.stderr).toBe(0)
    expect(plain.stdout).not.toMatch(/^\s*Locks\b/m)

    report.findings[0].locks = 'unknown'
    writeFileSync(join(cwd, 'unknown.json'), JSON.stringify(report))
    const run = await runCli(['explain', report.findings[0].fingerprint, '--report', 'unknown.json'], { cwd })
    expect(run.exitCode, run.stderr).toBe(0)
    expect(run.stdout).toMatch(/^\s*Locks\s+unknown$/m)
  })

  test('a target that names one finding explains it', async () => {
    const { cwd, report } = await savedReport(brief)

    for (const target of ['EventTarget.prototype.addEventListener', 'window|EventTarget.prototype.addEventListener']) {
      const run = await runCli(['explain', target, '--report', 'report.json'], { cwd })
      expect(run.exitCode, run.stderr).toBe(0)
      expect(run.stdout).toContain(report.findings[0].fingerprint)
    }
    const byKey = await runCli(['explain', report.findings[0].targetKey, '--report', 'report.json'], { cwd })
    expect(byKey.exitCode).toBe(0)
  })

  test('an ambiguous target lists the candidates with their fingerprints, and explains none', async () => {
    const { cwd, report } = await savedReport(
      // The delete comes last: one the code always writes again gives no finding of its own (§3).
      lines('window.fetch = function () {};', 'Object.defineProperty(window, "fetch", { get() {} });', 'delete window.fetch;'),
    )
    expect(report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      'window|Window.fetch|delete|unknown',
      'window|Window.fetch|descriptor-change|unknown',
      'window|Window.fetch|replace|unknown',
    ])

    const run = await runCli(['explain', 'Window.fetch', '--report', 'report.json'], { cwd })

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    for (const finding of report.findings) expect(run.stderr).toContain(finding.fingerprint)

    // Any one of them is explained by its fingerprint.
    const one = await runCli(['explain', 'window|Window.fetch|delete|unknown', '--report', 'report.json'], { cwd })
    expect(one.exitCode, one.stderr).toBe(0)
    expect(one.stdout).toContain('delete')
  })

  test('an unknown fingerprint or target exits 2', async () => {
    const { cwd } = await savedReport(brief)

    for (const query of ['window|Window.fetch|replace|unknown', 'Window.fetch']) {
      const run = await runCli(['explain', query, '--report', 'report.json'], { cwd })
      expect(run.exitCode).toBe(2)
      expect(run.stdout).toBe('')
      expect(run.stderr).toContain(query)
    }
  })

  test("no scan runs, and the build directory isn't read", async () => {
    const dir = fixtureBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': brief })
    const cwd = workingDir()
    const scan = await runCli(['scan', dir, '--map', defaultMap, '--json', 'report.json'], { cwd })
    expect(scan.exitCode, scan.stderr).toBe(0)
    const report = JSON.parse(readFileSync(join(cwd, 'report.json'), 'utf8'))
    rmSync(dir, { recursive: true })

    const fail = () => {
      throw new Error('explain must not scan')
    }
    const run = await runCli(['explain', report.findings[0].fingerprint, '--report', 'report.json'], {
      cwd,
      deps: {
        loadCatalog: fail,
        resolveFetcher: fail,
        clock: fail,
        now: fail,
        resolver: new Proxy({} as Resolver, { get: fail }),
      },
    })

    expect(run.exitCode, run.stderr).toBe(0)
    expect(run.stdout).toContain('binding')
  })

  test.each([
    ['a missing report', [], 'missing.json'],
    ['a file that is not JSON', ['bad.json', '{'], 'bad.json'],
    ['JSON that is not a report', ['other.json', '{"findings": []}'], 'other.json'],
  ])('%s is a usage error', async (_, file, path) => {
    const cwd = workingDir(file.length === 0 ? {} : { [file[0]!]: file[1]! })

    const run = await runCli(['explain', 'Window.fetch', '--report', path], { cwd })

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain(path)
  })

  test.each([
    ['no fingerprint or target', ['--report', 'r.json']],
    ['no report', ['Window.fetch']],
    ['two queries', ['Window.fetch', 'Window.close', '--report', 'r.json']],
    ['a scan flag', ['Window.fetch', '--report', 'r.json', '--surface', 'all']],
  ])('%s is a usage error', async (_, argv) => {
    const run = await runCli(['explain', ...argv])

    expect(run.exitCode).toBe(2)
  })

  test("the config file's report key names the report, and --report overrides it", async () => {
    const { cwd, report } = await savedReport(brief)
    writeFileSync(join(cwd, 'monkeypatchlist.config.json'), JSON.stringify({ report: 'report.json' }))

    const run = await runCli(['explain', report.findings[0].fingerprint], { cwd })
    expect(run.exitCode, run.stderr).toBe(0)
    const overridden = await runCli(['explain', report.findings[0].fingerprint, '--report', 'nope.json'], { cwd })
    expect(overridden.exitCode).toBe(2)
  })
})

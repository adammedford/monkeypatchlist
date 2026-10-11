// `baseline init` has `baseline update`'s guards (§11 Commands, §13 Effects on the baseline and the gate,
// §4 Version skew, §16 Flags), and a fired crash guard reports no findings (§13). After a fired guard,
// `baseline init` refuses (exit 3) even with `--allow-incomplete`, and writes nothing (§13). Tests run
// `monkeypatchlist baseline init`, `monkeypatchlist baseline update` and `monkeypatchlist scan --json -` in process over fixture builds,
// in one working directory, and read the baseline file they leave.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { crashGuardMs, type Deps } from '../src/cli.ts'
import { jsResolver, type AnalyzeGroupInput } from '../src/packages/analysis/index.ts'
import { loadCatalog, type SerializedCatalog } from '../src/index.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, workingDir } from './support/fixture-build.ts'

const page = '<script src="main.js"></script>'
/** A page that also runs `broken.js`, which doesn't parse: a `parse-failure` makes the scan `incomplete` (§13). */
const incompletePage = '<script src="main.js"></script><script src="broken.js"></script>'
const broken = { 'broken.js': 'window.setTimeout = (' }

const before = 'window.fetch = a\nwindow.setTimeout = b\n'
const after = 'window.fetch = a\n'

const complete = () => fixtureBuild({ 'index.html': page, 'main.js': before })
const incomplete = () => fixtureBuild({ 'index.html': incompletePage, 'main.js': after, ...broken })

/** Runs `monkeypatchlist baseline init <dir> --map … <args…>` in `cwd`, which writes `monkeypatchlist.baseline.json` there. */
function baselineInit(cwd: string, dir: string, args: string[] = [], deps: Partial<Deps> = {}) {
  return runCli(['baseline', 'init', dir, '--map', defaultMap, ...args], { cwd, deps })
}

/** The text of `monkeypatchlist.baseline.json` in `cwd`. */
const baselineText = (cwd: string) => readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8')

describe('baseline init refuses an incomplete scan (§11 Commands, §13)', () => {
  test('it exits 3 and leaves the existing baseline untouched', async () => {
    const cwd = workingDir()
    expect((await baselineInit(cwd, complete())).exitCode).toBe(0)
    const text = baselineText(cwd)

    const run = await baselineInit(cwd, incomplete())

    expect(run.exitCode).toBe(3)
    expect(baselineText(cwd)).toBe(text)
    expect(run.stderr).toMatch(/^monkeypatchlist: baseline init refuses an incomplete scan.*--allow-incomplete/m)
    expect(run.stderr).not.toContain('wrote')
  })

  test('with no baseline there, it writes none', async () => {
    const cwd = workingDir()

    const run = await baselineInit(cwd, incomplete(), ['--json', '-'])

    expect(run.exitCode).toBe(3)
    expect(existsSync(join(cwd, 'monkeypatchlist.baseline.json'))).toBe(false)
    // The report of its scan still prints, and says what was not analyzed.
    const report = JSON.parse(run.stdout)
    assertValidReport(report)
    expect(report.completeness.level).toBe('incomplete')
    expect(report.gate).toEqual({ failOn: [], result: 'not-run', exitCode: 0 })
  })

  test('with --allow-incomplete it writes, with a warning, and the header records the level', async () => {
    const cwd = workingDir()
    await baselineInit(cwd, complete())

    const run = await baselineInit(cwd, incomplete(), ['--allow-incomplete'])

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toMatch(/^monkeypatchlist: warning: baseline init wrote a baseline from a scan that is incomplete/m)
    expect(run.stderr).toContain('monkeypatchlist: wrote monkeypatchlist.baseline.json (1 entry)')
    const written = JSON.parse(baselineText(cwd))
    expect(written.completeness).toBe('incomplete')
    // `init` accepts the whole current finding set: the entry the complete build had and this one lacks is gone.
    expect(written.entries.map((entry: { fingerprint: string }) => entry.fingerprint)).toEqual([
      'window|Window.fetch|replace|unknown',
    ])
  })

  test('the config key allowIncomplete does the same', async () => {
    const cwd = workingDir({ 'monkeypatchlist.config.json': JSON.stringify({ allowIncomplete: true }) })

    const run = await baselineInit(cwd, incomplete())

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toMatch(/^monkeypatchlist: warning: baseline init .*incomplete/m)
    expect(JSON.parse(baselineText(cwd)).completeness).toBe('incomplete')
  })

  test('it writes a complete-with-limitations or complete scan with no warning', async () => {
    const remotePage = '<script src="main.js"></script><script src="https://cdn.example/lib.js"></script>'
    const limited = fixtureBuild({ 'index.html': remotePage, 'main.js': before })
    const cwd = workingDir()

    const run = await baselineInit(cwd, limited)

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('monkeypatchlist: wrote monkeypatchlist.baseline.json (2 entries)\n')
    expect(JSON.parse(baselineText(cwd)).completeness).toBe('complete-with-limitations')
    expect((await baselineInit(workingDir(), complete())).stderr).not.toContain('warning')
  })
})

const catalog = loadCatalog()
const { catalogVersion } = catalog.metadata
const { version: monkeypatchlistVersion } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }

/** The committed catalog under another catalog version, as another monkeypatchlist release would ship it. */
function catalogAt(version: number): Partial<Deps> {
  const other: SerializedCatalog = { ...catalog, metadata: { ...catalog.metadata, catalogVersion: version } }
  return { loadCatalog: () => other }
}

/** Edits `monkeypatchlist.baseline.json` in `cwd`, as another monkeypatchlist version would have written it. */
function editBaseline(cwd: string, change: (baseline: Record<string, unknown>) => void): void {
  const path = join(cwd, 'monkeypatchlist.baseline.json')
  const baseline = JSON.parse(readFileSync(path, 'utf8'))
  change(baseline)
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`)
}

/** Writes, in `cwd`, the baseline this monkeypatchlist writes over the complete build, then lets `change` edit it. */
async function writtenBy(
  cwd: string,
  change: (baseline: Record<string, unknown>) => void,
  deps: Partial<Deps> = {},
): Promise<void> {
  expect((await baselineInit(cwd, complete(), [], deps)).exitCode).toBe(0)
  editBaseline(cwd, change)
}

/** The baseline a newer monkeypatchlist wrote in `cwd`: in each case, one of its versions is newer than this one's. */
const newer: [string, (cwd: string) => Promise<void>][] = [
  ['catalog', (cwd) => writtenBy(cwd, () => {}, catalogAt(catalogVersion + 1))],
  ['monkeypatchlist', (cwd) => writtenBy(cwd, (baseline) => (baseline.monkeypatchlistVersion = '999.0.0'))],
  ['formatVersion', (cwd) => writtenBy(cwd, (baseline) => (baseline.formatVersion = 2))],
  ['fingerprint scheme', (cwd) => writtenBy(cwd, (baseline) => (baseline.fingerprintScheme = 2))],
  [
    // A newer catalog can name a holder this one lacks, so the file isn't a baseline this monkeypatchlist reads.
    'catalog, with a holder this one lacks',
    (cwd) =>
      writtenBy(cwd, (baseline) => {
        baseline.catalogVersion = catalogVersion + 1
        ;(baseline.entries as { target: { holder: string } }[])[0]!.target.holder = 'FutureHolder'
      }),
  ],
]

describe('baseline init refuses to replace a baseline from a newer version (§4 Version skew, §16)', () => {
  test.each(newer)('over one with a newer %s, it exits 2 before scanning, and leaves the file', async (_, write) => {
    const cwd = workingDir()
    await write(cwd)
    const text = baselineText(cwd)

    const run = await baselineInit(cwd, complete())

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toMatch(/^monkeypatchlist: baseline init won't replace 'monkeypatchlist.baseline.json': .*newer/m)
    expect(run.stderr).toContain('--allow-downgrade')
    expect(baselineText(cwd)).toBe(text)
  })

  test.each(newer)('over one with a newer %s, --allow-downgrade replaces it, with a warning', async (_, write) => {
    const cwd = workingDir()
    await write(cwd)
    const fresh = workingDir()
    await baselineInit(fresh, complete())

    const run = await baselineInit(cwd, complete(), ['--allow-downgrade'])

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toMatch(/^monkeypatchlist: warning: baseline init replaced 'monkeypatchlist.baseline.json', .*newer/m)
    expect(baselineText(cwd)).toBe(baselineText(fresh))
  })

  test('the message names the newer version on both sides', async () => {
    const cwd = workingDir()
    await writtenBy(cwd, (baseline) => (baseline.monkeypatchlistVersion = '999.0.0'), catalogAt(catalogVersion + 1))

    const run = await baselineInit(cwd, complete())

    expect(run.stderr).toContain(`monkeypatchlist 999.0.0, newer than this one's ${monkeypatchlistVersion}`)
    expect(run.stderr).toContain(`catalog ${catalogVersion + 1}, newer than this one's ${catalogVersion}`)
  })

  test('the config key allowDowngrade does the same', async () => {
    const cwd = workingDir({ 'monkeypatchlist.config.json': JSON.stringify({ allowDowngrade: true }) })
    await writtenBy(cwd, () => {}, catalogAt(catalogVersion + 1))

    const run = await baselineInit(cwd, complete())

    expect(run.exitCode).toBe(0)
    expect(JSON.parse(baselineText(cwd)).catalogVersion).toBe(catalogVersion)
  })

  test('over a baseline from an older or the same version it needs no flag, and gives no warning', async () => {
    const olderCatalog = workingDir()
    await writtenBy(olderCatalog, (baseline) => (baseline.entries = []))
    const olderMonkeypatchlist = workingDir()
    // A prerelease ranks below its release.
    await writtenBy(olderMonkeypatchlist, (baseline) => (baseline.monkeypatchlistVersion = `${monkeypatchlistVersion}-older`))
    const same = workingDir()
    await writtenBy(same, (baseline) => (baseline.entries = []))

    const runs = [
      await baselineInit(olderCatalog, complete(), [], catalogAt(catalogVersion + 1)),
      await baselineInit(olderMonkeypatchlist, complete()),
      await baselineInit(same, complete()),
    ]

    expect(runs.map(({ exitCode }) => exitCode)).toEqual([0, 0, 0])
    const wrote = 'monkeypatchlist: wrote monkeypatchlist.baseline.json (2 entries)\n'
    expect(runs.map(({ stderr }) => stderr)).toEqual([wrote, wrote, wrote])
    expect(JSON.parse(baselineText(olderCatalog)).catalogVersion).toBe(catalogVersion + 1)
    expect(JSON.parse(baselineText(olderMonkeypatchlist)).monkeypatchlistVersion).toBe(monkeypatchlistVersion)
    expect(JSON.parse(baselineText(same)).entries).toHaveLength(2)
  })

  test('a file that records no version it can read is replaced: a merge conflict, or no baseline at all', async () => {
    const conflicted = workingDir({ 'monkeypatchlist.baseline.json': '<<<<<<< HEAD\n{}\n=======\n{}\n>>>>>>> theirs\n' })
    const other = workingDir({ 'monkeypatchlist.baseline.json': '{"monkeypatchlistVersion": "next", "catalogVersion": "9"}\n' })

    const runs = [await baselineInit(conflicted, complete()), await baselineInit(other, complete())]

    expect(runs.map(({ exitCode }) => exitCode)).toEqual([0, 0])
    expect(JSON.parse(baselineText(conflicted)).entries).toHaveLength(2)
    expect(JSON.parse(baselineText(other)).entries).toHaveLength(2)
  })

  test('baseline init --allow-downgrade over no baseline writes one, with no warning', async () => {
    const cwd = workingDir()

    const run = await baselineInit(cwd, complete(), ['--allow-downgrade'])

    expect(run.exitCode).toBe(0)
    expect(run.stderr).toBe('monkeypatchlist: wrote monkeypatchlist.baseline.json (2 entries)\n')
  })
})

test('a scan over a baseline in a newer fingerprint scheme points to baseline init --allow-downgrade', async () => {
  const cwd = workingDir()
  await writtenBy(cwd, (baseline) => (baseline.fingerprintScheme = 2))

  const run = await runCli(['scan', complete(), '--map', defaultMap, '--fail-on', 'added'], { cwd })

  expect(run.exitCode).toBe(2)
  expect(run.stderr).toContain(
    'Upgrade monkeypatchlist, or write a new baseline with monkeypatchlist baseline init --allow-downgrade',
  )
})

describe('a scan whose crash guard fired reports no findings (§13)', () => {
  // Link groups run in URL order: a.js, then b.js.
  const guarded = {
    'index.html': '<script src="b.js"></script><script src="a.js"></script>',
    'a.js': 'window.fetch = f',
    'b.js': 'window.clearInterval = g',
  }
  /** The same pages, where a.js adds a mutation and b.js changes its effect: unguarded, both would be deltas. */
  const changed = {
    ...guarded,
    'a.js': 'window.fetch = f\nwindow.open = o',
    'b.js': 'window.clearInterval = wrap(window.clearInterval)',
  }

  /**
   * The CLI's clock and resolver for a crash guard that fires before link group `group` (0 for the first) and not
   * before an earlier one: after the scan's start, the clock reads the guard's limit once `group` groups are analyzed.
   */
  function firesBefore(group: number): Partial<Deps> {
    let started = false
    let analyzed = 0
    return {
      clock: () => {
        if (!started) return (started = true), 0
        return analyzed >= group ? crashGuardMs : 0
      },
      resolver: {
        analyzerVersion: jsResolver.analyzerVersion,
        analyzeGroup(input: AnalyzeGroupInput) {
          const output = jsResolver.analyzeGroup(input)
          analyzed++
          return output
        },
      },
    }
  }

  /** Runs `monkeypatchlist scan <dir> --map … --json - <args…>` in `cwd`, and returns the validated report. */
  async function scan(cwd: string, dir: string, args: string[] = [], deps: Partial<Deps> = {}) {
    const run = await runCli(['scan', dir, '--map', defaultMap, '--json', '-', ...args], { cwd, deps })
    const report = JSON.parse(run.stdout)
    assertValidReport(report)
    return { ...run, report }
  }

  const states = (report: { findings: { fingerprint: string; baselineState: string | null }[] }) =>
    report.findings.map((finding) => [finding.fingerprint, finding.baselineState])

  test.each([0, 1])(
    'fired before link group %i: no findings, incomplete, and every baseline entry unconfirmed',
    async (group) => {
      const cwd = workingDir()
      expect((await baselineInit(cwd, fixtureBuild(guarded))).exitCode).toBe(0)

      const args = ['--fail-on', 'added,changed']
      const { exitCode, report } = await scan(cwd, fixtureBuild(changed), args, firesBefore(group))

      expect(report.completeness.counters.statistics.crashGuard).toBe('fired')
      expect(report.completeness.level).toBe('incomplete')
      expect(states(report)).toEqual([
        ['window|Window.clearInterval|replace|unknown', 'unconfirmed'],
        ['window|Window.fetch|replace|unknown', 'unconfirmed'],
      ])
      expect(report.findings.flatMap((finding: { occurrences: unknown[] }) => finding.occurrences)).toEqual([])
      expect(report.summary).toMatchObject({ added: 0, changed: 0, existing: 0, removed: 0, unconfirmed: 2, ineffectiveWrites: 0 })
      expect(report.gate).toEqual({ failOn: ['added', 'changed'], result: 'pass', exitCode: 3 })
      expect(exitCode).toBe(3)
    },
  )

  test.each([0, 1])('fired before link group %i, with no baseline: the report has no findings', async (group) => {
    const { report } = await scan(workingDir(), fixtureBuild(changed), [], firesBefore(group))

    expect(report.completeness.level).toBe('incomplete')
    // The groups that ran before the guard fired are counted, but what they found is not reported.
    const { artifacts } = report.completeness.counters
    expect(artifacts).toMatchObject({ analyzed: group, failed: { 'crash-guard': 2 - group } })
    expect(report.findings).toEqual([])
    expect(report.summary).toMatchObject({ added: 0, changed: 0, existing: 0, removed: 0, unconfirmed: 0, ineffectiveWrites: 0 })
  })

  test.each([0, 1])(
    'fired before link group %i, baseline update --allow-incomplete leaves the baseline byte-identical',
    async (group) => {
      const cwd = workingDir()
      expect((await baselineInit(cwd, fixtureBuild(guarded))).exitCode).toBe(0)
      const text = baselineText(cwd)
      const argv = ['baseline', 'update', fixtureBuild(changed), '--map', defaultMap, '--allow-incomplete']

      // Under a newer catalog, rewriting the baseline would change its header: byte-identical means left untouched.
      const run = await runCli(argv, { cwd, deps: { ...catalogAt(catalogVersion + 1), ...firesBefore(group) } })

      expect(run.exitCode).toBe(0)
      expect(baselineText(cwd)).toBe(text)
      expect(run.stdout).not.toContain('Accepted into')
      expect(run.stderr).toMatch(/^monkeypatchlist: warning: the crash guard fired, so baseline update left .* as it was/m)
      expect(run.stderr).not.toContain('wrote')
    },
  )

  test('without --allow-incomplete, baseline init refuses it: exit 3, and the baseline is left', async () => {
    const cwd = workingDir()
    expect((await baselineInit(cwd, fixtureBuild(guarded))).exitCode).toBe(0)
    const text = baselineText(cwd)

    const run = await baselineInit(cwd, fixtureBuild(changed), [], firesBefore(1))

    expect(run.exitCode).toBe(3)
    expect(baselineText(cwd)).toBe(text)
    // It gives the crash guard's refusal, not the one that suggests --allow-incomplete, which wouldn't make it write.
    expect(run.stderr).toMatch(/^monkeypatchlist: baseline init refuses a scan whose crash guard fired/m)
    expect(run.stderr).not.toContain('Pass --allow-incomplete')
  })

  // `baseline init` refuses a scan whose guard fired (exit 3) even with `--allow-incomplete` (§13).
  test.each([0, 1])(
    'fired before link group %i, baseline init --allow-incomplete exits 3 and leaves the baseline byte-identical',
    async (group) => {
      const cwd = workingDir()
      expect((await baselineInit(cwd, fixtureBuild(guarded))).exitCode).toBe(0)
      const text = baselineText(cwd)

      const run = await baselineInit(cwd, fixtureBuild(changed), ['--allow-incomplete'], firesBefore(group))

      expect(run.exitCode).toBe(3)
      expect(baselineText(cwd)).toBe(text)
      expect(run.stderr).toMatch(
        /^monkeypatchlist: baseline init refuses a scan whose crash guard fired, even under --allow-incomplete, so monkeypatchlist\.baseline\.json is left/m,
      )
      expect(run.stderr).not.toContain('wrote')
    },
  )

  test('the config key allowIncomplete does not make baseline init write it either', async () => {
    const cwd = workingDir({ 'monkeypatchlist.config.json': JSON.stringify({ allowIncomplete: true }) })
    expect((await baselineInit(cwd, fixtureBuild(guarded))).exitCode).toBe(0)
    const text = baselineText(cwd)

    const run = await baselineInit(cwd, fixtureBuild(changed), [], firesBefore(1))

    expect(run.exitCode).toBe(3)
    expect(baselineText(cwd)).toBe(text)
    expect(run.stderr).toMatch(/^monkeypatchlist: baseline init refuses a scan whose crash guard fired/m)
  })

  test('with no baseline there, baseline init --allow-incomplete writes none, and prints the report', async () => {
    const cwd = workingDir()

    const run = await baselineInit(cwd, fixtureBuild(changed), ['--allow-incomplete', '--json', '-'], firesBefore(1))

    expect(run.exitCode).toBe(3)
    expect(existsSync(join(cwd, 'monkeypatchlist.baseline.json'))).toBe(false)
    const report = JSON.parse(run.stdout)
    assertValidReport(report)
    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.counters.statistics.crashGuard).toBe('fired')
    expect(report.findings).toEqual([])
  })

  test("under --allow-downgrade, baseline init still leaves a newer version's baseline as it was", async () => {
    const cwd = workingDir()
    expect((await baselineInit(cwd, fixtureBuild(guarded), [], catalogAt(catalogVersion + 1))).exitCode).toBe(0)
    const text = baselineText(cwd)

    const argv = ['--allow-incomplete', '--allow-downgrade']
    const run = await baselineInit(cwd, fixtureBuild(changed), argv, firesBefore(1))

    expect(run.exitCode).toBe(3)
    expect(baselineText(cwd)).toBe(text)
    expect(run.stderr).not.toContain('replaced')
  })

  test('without --allow-incomplete, baseline update refuses it: exit 3, and the baseline is left', async () => {
    const cwd = workingDir()
    expect((await baselineInit(cwd, fixtureBuild(guarded))).exitCode).toBe(0)
    const text = baselineText(cwd)

    const run = await runCli(['baseline', 'update', fixtureBuild(changed), '--map', defaultMap], {
      cwd,
      deps: firesBefore(1),
    })

    expect(run.exitCode).toBe(3)
    expect(baselineText(cwd)).toBe(text)
  })
})

test('the usage text lists --allow-incomplete and --allow-downgrade for baseline init (§16 Flags)', async () => {
  const run = await runCli(['baseline', 'init'])

  expect(run.exitCode).toBe(2)
  const init = run.stderr.split('\n').find((line) => line.includes('monkeypatchlist baseline init'))
  expect(init).toContain('[--allow-incomplete]')
  expect(init).toContain('[--allow-downgrade]')
})

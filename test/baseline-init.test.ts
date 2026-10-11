// `monkeypatchlist baseline init <buildDir>` (§11 Baseline, §16 Commands, ADR 0001): it scans, and writes a committed,
// deterministic JSON baseline with the whole finding set. Tests run the CLI in process over fixture builds, and read
// the file it writes.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import {
  assertValidReport,
  defaultMap,
  fixtureBuild,
  runCli,
  scanBuild,
  workingDir,
  type CliOptions,
} from './support/fixture-build.ts'

const page = '<script src="main.js"></script>'

/**
 * Runs `monkeypatchlist baseline init <dir> --map https://app.example/=. <args…>` in `cwd` (a fresh working directory by
 * default), and returns the baseline it wrote to `out` (relative to `cwd`) as text and parsed. The `--map` is left out
 * when `args` has one, or when `map` is false.
 */
async function baselineInit(
  build: string | Record<string, string>,
  args: string[] = [],
  options: CliOptions & { out?: string; map?: boolean } = {},
) {
  const { out = 'monkeypatchlist.baseline.json', map: withMap = true, deps } = options
  const dir = typeof build === 'string' ? build : fixtureBuild(build)
  const cwd = options.cwd ?? workingDir()
  const map = args.includes('--map') || !withMap ? [] : ['--map', defaultMap]
  const run = await runCli(['baseline', 'init', dir, ...map, ...args], deps === undefined ? { cwd } : { cwd, deps })
  if (run.exitCode !== 0) throw new Error(`baseline init exited ${run.exitCode}:\n${run.stderr}`)
  const text = readFileSync(join(cwd, out), 'utf8')
  return { ...run, text, baseline: JSON.parse(text), dir, cwd }
}

describe('monkeypatchlist baseline init (§11, §16)', () => {
  test('writes monkeypatchlist.baseline.json in the working directory, with a header and an entry per finding', async () => {
    const { baseline } = await baselineInit({ 'index.html': page, 'main.js': 'window.fetch = function(){}' })

    expect(Object.keys(baseline)).toEqual([
      'formatVersion',
      'scanConfigId',
      'fingerprintScheme',
      'catalogVersion',
      'monkeypatchlistVersion',
      'completeness',
      'surface',
      'packages',
      'entries',
    ])
    expect(baseline.formatVersion).toBe(1)
    expect(baseline.scanConfigId).toMatch(/^[0-9a-f]{12}(\.[0-9a-f]{12}){3}$/)
    expect(baseline.fingerprintScheme).toBe(1)
    expect(baseline.catalogVersion).toBe(1)
    expect(baseline.monkeypatchlistVersion).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version)
    expect(baseline.completeness).toBe('complete')
    expect(baseline.surface).toBe('protected')
    expect(baseline.packages).toEqual({})
    expect(baseline.entries).toEqual([
      {
        fingerprint: 'window|Window.fetch|replace|unknown',
        target: { realm: 'window', holder: 'global', name: 'Window.fetch' },
        surface: 'networking',
        effect: 'replace',
        locks: false,
        attribution: { key: 'unknown', provenance: 'unknown' },
      },
    ])
  })
})

describe('baseline init output (§15 Channels)', () => {
  const files = { 'index.html': page, 'main.js': 'window.fetch = function(){}' }

  test('prints the terminal report to stdout, and where the baseline went to stderr', async () => {
    const { stdout, stderr } = await baselineInit(files)

    expect(stdout).not.toBe('')
    expect(() => JSON.parse(stdout)).toThrow()
    expect(stderr).toContain('monkeypatchlist.baseline.json')
  })

  test("--json - prints the scan's JSON report to stdout instead, and the baseline is still written", async () => {
    const dir = fixtureBuild(files)
    const { report } = await scanBuild(dir, ['--surface', 'protected'])
    const { stdout, baseline } = await baselineInit(dir, ['--json', '-'])

    const printed = JSON.parse(stdout)
    assertValidReport(printed)
    expect({ ...printed, run: null }).toEqual({ ...report, run: null })
    expect(baseline.entries.map((entry: { fingerprint: string }) => entry.fingerprint)).toEqual([
      'window|Window.fetch|replace|unknown',
    ])
  })

  test('a build with no findings gives a baseline with no entries', async () => {
    const { baseline } = await baselineInit({ 'index.html': '<p>static</p>' })

    expect(baseline.entries).toEqual([])
    expect(baseline.completeness).toBe('complete')
  })

  test('records the completeness level the scan had', async () => {
    const files = { 'index.html': page, 'main.js': 'window.fetch = (' }
    const { baseline } = await baselineInit(files, ['--allow-incomplete'])

    expect(baseline.completeness).toBe('incomplete')
  })
})

describe('the baseline is deterministic (§11 Determinism)', () => {
  const files = {
    'index.html': '<script src="main.js"></script><script>window.clearInterval = c</script>',
    'main.js': 'window.setTimeout = a\nwindow.fetch = b\n',
  }

  test('an unchanged build rewrites the baseline byte for byte, even from a copy in another directory', async () => {
    const first = await baselineInit(files)
    const again = await baselineInit(first.dir, [], { cwd: first.cwd })
    const copy = await baselineInit(files)

    expect(copy.dir).not.toBe(first.dir)
    expect(copy.cwd).not.toBe(first.cwd)
    expect(again.text).toBe(first.text)
    expect(copy.text).toBe(first.text)
  })

  test('entries are sorted by fingerprint, in 2-space-indented JSON with LF line endings and a trailing newline', async () => {
    const { text, baseline } = await baselineInit(files)

    expect(baseline.entries.map((entry: { fingerprint: string }) => entry.fingerprint)).toEqual([
      'window|Window.clearInterval|replace|inline',
      'window|Window.fetch|replace|unknown',
      'window|Window.setTimeout|replace|unknown',
    ])
    expect(text).toBe(`${JSON.stringify(baseline, null, 2)}\n`)
    expect(text).not.toContain('\r')
  })

  test('there are no timestamps, absolute paths, host information or git SHA', async () => {
    const { text, dir, cwd } = await baselineInit(files)

    expect(text).not.toContain(dir)
    expect(text).not.toContain(cwd)
    expect(text).not.toContain(hostname())
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}/)
    expect(text).not.toMatch(/[0-9a-f]{40}/)
    expect(text).not.toMatch(/https?:/)
  })
})

describe('baseline entries (§11 Baseline)', () => {
  const files = {
    'index.html': '<script src="main.js"></script><script>window.clearInterval = c</script>',
    'main.js': 'window.setTimeout = a\nwindow.fetch = b\nif (x) window.fetch = c\n',
  }

  test("hold only the fingerprint, the attributes that decide `changed`, and the finding's readable context", async () => {
    const dir = fixtureBuild(files)
    const { report } = await scanBuild(dir)
    const { baseline } = await baselineInit(dir)

    expect(baseline.entries).toEqual(
      report.findings.map(
        ({ fingerprint, target, surface, effect, locks, attribution }: Record<string, unknown>) => ({
          fingerprint,
          target,
          surface,
          effect,
          locks,
          attribution,
        }),
      ),
    )
    for (const entry of baseline.entries) {
      expect(Object.keys(entry)).toEqual(['fingerprint', 'target', 'surface', 'effect', 'locks', 'attribution'])
      expect(Object.keys(entry.attribution)).toEqual(['key', 'provenance'])
    }
  })

  test('hold no occurrences, hashes, paths, positions, reachability, install context or basis', async () => {
    const dir = fixtureBuild(files)
    const { report } = await scanBuild(dir)
    const { text } = await baselineInit(dir)

    expect(report.findings.flatMap((finding: { occurrences: unknown[] }) => finding.occurrences)).toHaveLength(4)
    const keys = [...text.matchAll(/"([^"]+)":/g)].map(([, key]) => key)
    for (const churn of ['occurrences', 'artifact', 'hash', 'path', 'generated', 'start', 'line', 'column']) {
      expect(keys).not.toContain(churn)
    }
    for (const churn of ['reachability', 'installContext', 'basis', 'reachabilityBasis', 'confidence', 'trace']) {
      expect(keys).not.toContain(churn)
    }
    for (const artifact of report.artifacts) {
      expect(text).not.toContain(artifact.hash)
      expect(text).not.toContain(artifact.url)
      if (artifact.path !== null) expect(text).not.toContain(artifact.path)
    }
  })
})

describe('--out <path> (§16)', () => {
  const files = { 'index.html': page, 'main.js': 'window.fetch = function(){}' }

  test('names the baseline file, relative to the working directory', async () => {
    const cwd = workingDir({ 'baselines/.keep': '' })

    const { baseline } = await baselineInit(files, ['--out', 'baselines/app.json'], { cwd, out: 'baselines/app.json' })

    expect(baseline.entries).toHaveLength(1)
    expect(existsSync(join(cwd, 'monkeypatchlist.baseline.json'))).toBe(false)
  })

  test("is the config file's `out`, relative to the file's directory, and the flag overrides it", async () => {
    const cwd = workingDir({ 'config/monkeypatchlist.json': JSON.stringify({ out: 'app.baseline.json' }) })

    await baselineInit(files, ['--config', 'config/monkeypatchlist.json'], { cwd, out: 'config/app.baseline.json' })
    await baselineInit(files, ['--config', 'config/monkeypatchlist.json', '--out', 'flag.json'], { cwd, out: 'flag.json' })
  })

  test('is a baseline flag only: scan exits 2 on it', async () => {
    const run = await runCli(['scan', fixtureBuild(files), '--map', defaultMap, '--out', 'x.json'])

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('--out')
  })

  test('may be given once', async () => {
    const run = await runCli(['baseline', 'init', fixtureBuild(files), '--map', defaultMap, '--out', 'a', '--out', 'b'])

    expect(run.exitCode).toBe(2)
  })
})

describe('the scan-config id (§16 Scan configuration identity, ADR 0017)', () => {
  const files = {
    'index.html': page,
    'other.html': page,
    'main.js': 'window.fetch = function(){}',
    'assets/lib.js': '',
  }
  const app = 'https://app.example/=.'
  const cdn = 'https://cdn.example/=assets'
  const index = 'index.html@https://app.example/'

  /**
   * The scan-config id `baseline init` records for `files` with `args`, and `config` as the working directory's config
   * file. The default `--map` is added only when there is no config file. Some of these configurations can't find the
   * entry document, and `baseline init` writes an `incomplete` scan's baseline only under `--allow-incomplete` (§11
   * Commands), which is no part of the id.
   */
  const idOf = async (args: string[], config?: unknown) => {
    const cwd = workingDir(config === undefined ? {} : { 'monkeypatchlist.config.json': JSON.stringify(config) })
    const allowed = [...args, '--allow-incomplete']
    return (await baselineInit(files, allowed, { cwd, map: config === undefined })).baseline.scanConfigId
  }
  /** The id's parts that differ from `base`'s, by the field each one hashes: entries, mappings, surface and realms. */
  const differing = (base: string, other: string) => {
    const [a, b] = [base.split('.'), other.split('.')]
    return ['entries', 'mappings', 'surface', 'realms'].filter((_, i) => a[i] !== b[i])
  }

  test('changes when an entry document changes: its file, its URL, or another entry', async () => {
    const base = await idOf(['--entry', index])

    expect(differing(base, await idOf(['--entry', 'other.html@https://app.example/']))).toEqual(['entries'])
    expect(differing(base, await idOf(['--entry', 'index.html@https://app.example/home']))).toEqual(['entries'])
    expect(differing(base, await idOf(['--entry', index, '--entry', 'other.html']))).toEqual(['entries'])
  })

  test('changes when a mapping changes: its URL prefix, its directory, or another mapping', async () => {
    const base = await idOf(['--map', app, '--entry', index])
    const withMaps = (...maps: string[]) => idOf([...maps.flatMap((map) => ['--map', map]), '--entry', index])

    expect(differing(base, await withMaps('https://app.example/=assets'))).toEqual(['mappings'])
    expect(differing(base, await withMaps('https://www.example/=.'))).toEqual(['mappings'])
    expect(differing(base, await withMaps(app, cdn))).toEqual(['mappings'])
  })

  test('changes when the surface changes, and the header records the surface scope', async () => {
    const cwd = workingDir()
    const protectedScope = await baselineInit(files, [], { cwd })
    const all = await baselineInit(files, ['--surface', 'all'], { cwd })
    const explicit = await baselineInit(files, ['--surface', 'protected'], { cwd })

    expect(protectedScope.baseline.surface).toBe('protected')
    expect(all.baseline.surface).toBe('all')
    expect(differing(protectedScope.baseline.scanConfigId, all.baseline.scanConfigId)).toEqual(['surface'])
    expect(explicit.baseline.scanConfigId).toBe(protectedScope.baseline.scanConfigId)
  })

  test("the surface comes from the config file's `surface`, and the --surface flag overrides it", async () => {
    const all = await idOf(['--map', app], { surface: 'all' })

    expect(await idOf(['--map', app, '--surface', 'all'])).toBe(all)
    expect(await idOf(['--map', app, '--surface', 'protected'], { surface: 'all' })).toBe(await idOf(['--map', app]))
  })

  test("doesn't change for the mode, the source-map directories or the lockfile", async () => {
    // Set through the config file: the lockfile flag arrives with the ticket that builds it (82). `resolve` mode reads
    // remote URLs through the fixture fetcher, which this build never asks.
    const lockfile = { name: 'portal', lockfileVersion: 3, requires: true, packages: { '': { name: 'portal' } } }
    const idWith = async (config: Record<string, unknown>) => {
      const cwd = workingDir({
        'monkeypatchlist.config.json': JSON.stringify({ mappings: [{ url: 'https://app.example/', dir: '.' }], ...config }),
        // A map that pairs `main.js`, so that the directory is not `source-maps-unpaired` (§13).
        'maps/main.js.map': JSON.stringify({ version: 3, sources: ['main.ts'], names: [], mappings: 'AAAA' }),
        'package-lock.json': JSON.stringify(lockfile),
      })
      const deps = { resolveFetcher: () => fixtureFetcher({}) }
      return (await baselineInit(files, [], { cwd, map: false, deps })).baseline.scanConfigId
    }
    const base = await idWith({})

    expect(base).toBe(await idOf(['--map', app]))
    expect(await idWith({ mode: 'offline' })).toBe(base)
    expect(await idWith({ mode: 'resolve' })).toBe(base)
    expect(await idWith({ sourceMaps: ['maps'] })).toBe(base)
    expect(await idWith({ lockfile: { path: 'package-lock.json' } })).toBe(base)
    expect(await idWith({ lockfile: { path: 'package-lock.json', importer: '.' } })).toBe(base)
    expect(await idWith({ mode: 'resolve', sourceMaps: ['maps'], lockfile: { path: 'package-lock.json' } })).toBe(base)
  })

  test('covers every realm: a build that adds a worker keeps its id', async () => {
    const base = await baselineInit(files)
    const worker = { 'main.js': 'new Worker("worker.js")', 'worker.js': 'self.fetch = f' }
    const withWorker = await baselineInit({ ...files, ...worker })

    expect(withWorker.baseline.entries.map((entry: { fingerprint: string }) => entry.fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown',
    ])
    expect(withWorker.baseline.scanConfigId).toBe(base.baseline.scanConfigId)
  })

  test("doesn't change with the order of entries or mappings, or with how a path is spelled", async () => {
    const other = 'other.html@https://app.example/other'
    const base = await idOf(['--map', app, '--map', cdn, '--entry', index, '--entry', other])

    expect(await idOf(['--map', cdn, '--map', app, '--entry', other, '--entry', index])).toBe(base)
    const spelled = ['--map', 'https://app.example/=./', '--map', 'https://cdn.example/=./assets/']
    expect(await idOf([...spelled, '--entry', './index.html@https://app.example/', '--entry', other])).toBe(base)
  })

  test("doesn't change with the application name, the JSON report, the baseline file or the build's location", async () => {
    const base = await idOf([])

    expect(await idOf(['--map', defaultMap], { name: 'Trading Portal' })).toBe(base)
    expect(await idOf(['--json', 'report.json'])).toBe(base)
    expect(await idOf(['--map', defaultMap, '--out', 'monkeypatchlist.baseline.json'], { out: 'elsewhere.json' })).toBe(base)
    expect(await idOf([])).toBe(base)
  })

  test('is the same for a config file and the flags that say the same', async () => {
    const flags = await idOf(['--map', app, '--map', cdn, '--entry', 'other.html@https://app.example/other'])
    const file = await idOf([], {
      mappings: [
        { url: 'https://app.example/', dir: '.' },
        { url: 'https://cdn.example/', dir: 'assets' },
      ],
      entries: [{ file: 'other.html', url: 'https://app.example/other' }],
    })

    expect(file).toBe(flags)
  })
})

describe('--surface protected|all (§16)', () => {
  const files = { 'index.html': page, 'main.js': 'window.fetch = function(){}' }

  test.each([
    ['a value outside protected|all', ['--surface', 'everything']],
    ['a --surface without a value', ['--surface']],
    ['a --surface given twice', ['--surface', 'all', '--surface', 'all']],
  ])('exits 2 on %s', async (_, args) => {
    for (const command of [['scan'], ['baseline', 'init']]) {
      const run = await runCli([...command, fixtureBuild(files), '--map', defaultMap, ...args])

      expect(run.exitCode).toBe(2)
      expect(run.stderr).toContain('--surface')
    }
  })

  test('scan takes it too', async () => {
    const { report } = await scanBuild(files, ['--surface', 'all'])

    expect(report.findings).toHaveLength(1)
  })
})

describe('no SQLite and no analysis cache (§11, ADR 0001)', () => {
  const files = { 'index.html': page, 'main.js': 'window.fetch = function(){}' }

  test('baseline init writes the baseline file and nothing else, twice over', async () => {
    const dir = fixtureBuild(files)
    const cwd = workingDir()
    const before = listFiles(dir)

    await baselineInit(dir, [], { cwd })
    await baselineInit(dir, [], { cwd })

    expect(listFiles(cwd)).toEqual(['monkeypatchlist.baseline.json'])
    expect(listFiles(dir)).toEqual(before)
  })

  test('no runtime dependency or source file brings in SQLite', () => {
    const { dependencies } = JSON.parse(readFileSync('package.json', 'utf8'))
    const sources = listFiles('src').filter((file) => file.endsWith('.ts'))

    expect(Object.keys(dependencies).filter((name) => /sqlite|sql\.js/i.test(name))).toEqual([])
    for (const file of sources) expect(readFileSync(join('src', file), 'utf8'), file).not.toMatch(/sqlite/i)
  })
})

/** Every file under `dir`, relative to it and sorted. */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort()
}

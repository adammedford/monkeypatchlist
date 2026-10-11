// The patch-release reproducibility check (tools/corpus-snapshot, spec §4 Catalog versions: release promise).
// Tests run the command over small fixture corpora, which it scans with the production `monkeypatchlist scan --json`.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, test } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { main, monkeypatchlistScanner, type Deps } from '../tools/corpus-snapshot/main.ts'
import { processPool } from '../tools/corpus-snapshot/workers.ts'
import { corpusDir } from '../tools/paths.ts'
import { fixtureCorpus, scratchDir } from './support/fixture-corpus.ts'
import { assertValidReport, runCli } from './support/fixture-build.ts'

/**
 * A built fixture corpus: `files` (corpus-relative path → contents), plus the `manifest.json` the corpus build writes
 * beside each `dist/` (the corpus root's, and each variant's), with the sha256 of every file under it.
 */
function builtCorpus(files: Record<string, string>): string {
  const manifests: Record<string, Record<string, string>> = {}
  for (const [path, text] of Object.entries(files)) {
    const match = /^((?:variants\/[^/]+\/)?)dist\/(.+)$/.exec(path)
    if (match === null) continue
    const [, root = '', file = ''] = match
    manifests[root] ??= {}
    manifests[root][file] = createHash('sha256').update(text).digest('hex')
  }
  const written = Object.fromEntries(
    Object.entries(manifests).map(([root, hashes]) => [
      `${root}manifest.json`,
      `${JSON.stringify({ node: 'v26.8.1', bundlers: {}, files: hashes }, null, 1)}\n`,
    ]),
  )
  return fixtureCorpus({ ...files, ...written })
}

/** A build directory's files: an `index.html` that loads `main.js`, and `main.js`. */
function site(path: string, code: string): Record<string, string> {
  return { [`${path}/index.html`]: '<script src="main.js"></script>', [`${path}/main.js`]: code }
}

interface Run {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * The production scanner, with every report it gives validated against the shipped report JSON Schema (README standing
 * criteria).
 */
function validatedScanner(): Deps['scan'] {
  const real = monkeypatchlistScanner(loadCatalog())
  return async (dir, surface) => {
    const text = await real(dir, surface)
    assertValidReport(JSON.parse(text))
    return text
  }
}

/**
 * Runs the command in process, capturing its output. Unless a test swaps the scanner, every report is validated; a test
 * that passes `scan: undefined` gets the command's default scanner.
 */
async function snapshotCommand(
  argv: string[],
  deps: { [K in keyof Deps]?: Deps[K] | undefined } = {},
  env: Record<string, string> = {},
): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const io = {
    stdout: { write: (text: string) => void (stdout += text) },
    stderr: { write: (text: string) => void (stderr += text) },
    env,
  }
  const plugged = Object.fromEntries(Object.entries({ scan: validatedScanner(), ...deps }).filter(([, dep]) => dep !== undefined))
  const exitCode = await main(argv, io, plugged)
  return { exitCode, stdout, stderr }
}

/** `monkeypatchlist scan <dir> --map https://app.corpus.test/=. --json -`, as a user runs it, with its stdout. */
async function scanDirectly(dir: string): Promise<string> {
  const run = await runCli(['scan', dir, '--map', 'https://app.corpus.test/=.', '--json', '-'])
  expect(run.exitCode).toBe(0)
  assertValidReport(JSON.parse(run.stdout))
  return run.stdout
}

/** The files under a snapshot directory, as sorted POSIX paths. */
function snapshotFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort()
}

describe('refreshing the snapshot', () => {
  test("--update writes each site's report without its run block, and the check then passes", async () => {
    const corpus = builtCorpus(site('dist/webpack/otel/maps', 'window.fetch = function () {}'))
    const snapshot = scratchDir()

    const update = await snapshotCommand(['--update', '--corpus', corpus, '--snapshot', snapshot])
    expect(update.exitCode, update.stderr).toBe(0)

    // The report a user gets, with its `run` block cut and the version cut to its release line, byte for byte.
    const direct = await scanDirectly(join(corpus, 'dist/webpack/otel/maps'))
    const expected = direct
      .replace(/,\n {2}"run": \{\n[\s\S]*\n {2}\}\n\}\n$/, '\n}\n')
      .replace('\n    "monkeypatchlistVersion": "0.0.0",\n', '\n    "monkeypatchlistVersion": "0.0",\n')
    expect(expected).not.toContain('"run"')
    expect(readFileSync(join(snapshot, 'protected/dist/webpack/otel/maps.json'), 'utf8')).toBe(expected)
    const all = JSON.parse(readFileSync(join(snapshot, 'all/dist/webpack/otel/maps.json'), 'utf8'))
    expect(all.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      'window|Window.fetch|replace|unknown',
    ])

    const check = await snapshotCommand(['--corpus', corpus, '--snapshot', snapshot])
    expect(check.exitCode, check.stderr).toBe(0)
  })

  test('--update drops the reports of sites that are gone', async () => {
    const snapshot = scratchDir()
    const before = builtCorpus(site('dist/webpack/otel/maps', 'var a = 1'))
    expect((await snapshotCommand(['--update', '--corpus', before, '--snapshot', snapshot])).exitCode).toBe(0)
    const after = builtCorpus(site('dist/webpack/otel/nomaps', 'var a = 1'))

    expect((await snapshotCommand(['--update', '--corpus', after, '--snapshot', snapshot])).exitCode).toBe(0)

    expect(snapshotFiles(snapshot)).toEqual(['all/dist/webpack/otel/nomaps.json', 'protected/dist/webpack/otel/nomaps.json'])
  })

  test('two refreshes, of two copies of the corpus in different places, write the same bytes', async () => {
    const files = site('dist/webpack/otel/maps', 'window.fetch = function () {}; history.pushState = function () {}')
    const [first, second] = [scratchDir(), scratchDir()]

    expect((await snapshotCommand(['--update', '--corpus', builtCorpus(files), '--snapshot', first])).exitCode).toBe(0)
    expect((await snapshotCommand(['--update', '--corpus', builtCorpus(files), '--snapshot', second])).exitCode).toBe(0)

    expect(snapshotFiles(second)).toEqual(snapshotFiles(first))
    for (const path of snapshotFiles(first)) {
      expect(readFileSync(join(second, path), 'utf8'), path).toBe(readFileSync(join(first, path), 'utf8'))
    }
  })

  test('nothing is written under the corpus: a snapshot directory inside it is refused (exit 2)', async () => {
    const corpus = builtCorpus(site('dist/webpack/otel/maps', 'var a = 1'))

    const update = await snapshotCommand(['--update', '--corpus', corpus, '--snapshot', join(corpus, 'snapshot')])

    expect(update.exitCode).toBe(2)
    expect(update.stderr).toContain('writes nothing under the corpus')
    expect(readdirSync(corpus).sort()).toEqual(['dist', 'manifest.json'])
  })

  test('a bad flag, or a corpus that is not there, is refused (exit 2)', async () => {
    const flag = await snapshotCommand(['--corpus', builtCorpus({}), '--snapshot', scratchDir(), '--force'])
    expect(flag.exitCode).toBe(2)
    expect(flag.stderr).toContain('usage:')

    const missing = await snapshotCommand(['--corpus', join(scratchDir(), 'no-corpus'), '--snapshot', scratchDir()])
    expect(missing.exitCode).toBe(2)
    expect(missing.stderr).toContain('no corpus at')
  })

  test('a corpus with no site is refused (exit 2)', async () => {
    const check = await snapshotCommand(['--corpus', fixtureCorpus({ 'README.md': '' }), '--snapshot', scratchDir()])

    expect(check.exitCode).toBe(2)
    expect(check.stderr).toContain('no site')
  })
})

describe('the sites', () => {
  test('every site of the corpus is scanned with each surface: builds, static sites, variant builds and fixture pages', async () => {
    const corpus = builtCorpus({
      ...site('dist/webpack/otel/maps', 'var a = 1'),
      ...site('dist/vite/otel/nomaps', 'var a = 1'),
      'static-sites/control/index.html': '<p>nothing</p>',
      'static-sites/sentry-cdn/index.html': '<script src="https://browser.sentry-cdn.com/11.0.0/bundle.min.js"></script>',
      ...site('variants/features-on/dist/esbuild/datadog/maps', 'var a = 1'),
      'variants/native-absent/natives.json': '{}',
      'fixtures/static-sites/restore-local-capture/index.html': '<script>var o = fetch; fetch = 1</script>',
      // Not sites: an app's sources, and ground truth.
      'apps/otel/index.html': '<script src="index.js"></script>',
      'apps/otel/index.js': 'window.fetch = function () {}',
      'ground-truth/webpack/otel/maps.json': '{"mutations": []}',
    })
    const snapshot = scratchDir()

    expect((await snapshotCommand(['--update', '--corpus', corpus, '--snapshot', snapshot])).exitCode).toBe(0)

    const sites = [
      'dist/vite/otel/nomaps',
      'dist/webpack/otel/maps',
      'fixtures/static-sites/restore-local-capture',
      'static-sites/control',
      'static-sites/sentry-cdn',
      'variants/features-on/dist/esbuild/datadog/maps',
    ]
    expect(snapshotFiles(snapshot)).toEqual(
      ['all', 'protected'].flatMap((surface) => sites.map((id) => `${surface}/${id}.json`)),
    )
    const fixture = JSON.parse(readFileSync(join(snapshot, 'all/fixtures/static-sites/restore-local-capture.json'), 'utf8'))
    expect(fixture.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      'window|Window.fetch|replace|inline',
    ])
  })
})

describe('the check', () => {
  test('fails when a scan gives other output than the snapshot, and names the report and the first line that differs', async () => {
    const snapshot = scratchDir()
    const before = builtCorpus(site('dist/webpack/otel/maps', 'window.fetch = function () {}; window.print = function () {}'))
    expect((await snapshotCommand(['--update', '--corpus', before, '--snapshot', snapshot])).exitCode).toBe(0)
    // The same site, where the scanner now finds another write. The code keeps its shape, and the findings their number
    // and confidence, so that the scan statistics and the attribution block, which the report lists before its
    // findings, stay the same.
    const after = builtCorpus(site('dist/webpack/otel/maps', 'window.fetch = function () {}; window.alert = function () {}'))

    const check = await snapshotCommand(['--corpus', after, '--snapshot', snapshot])

    expect(check.exitCode).toBe(1)
    expect(check.stderr).toContain('protected/dist/webpack/otel/maps.json')
    expect(check.stderr).toContain('all/dist/webpack/otel/maps.json')
    expect(check.stderr).toMatch(/line \d+/)
    expect(check.stderr).toContain('window|Window.alert|replace|unknown')
  })

  test('fails on a site the snapshot lacks, and on a snapshot report whose site is gone', async () => {
    const snapshot = scratchDir()
    const before = builtCorpus(site('dist/webpack/otel/maps', 'var a = 1'))
    expect((await snapshotCommand(['--update', '--corpus', before, '--snapshot', snapshot])).exitCode).toBe(0)
    const after = builtCorpus(site('dist/webpack/otel/nomaps', 'var a = 1'))

    const check = await snapshotCommand(['--corpus', after, '--snapshot', snapshot])

    expect(check.exitCode).toBe(1)
    expect(check.stderr).toMatch(/all\/dist\/webpack\/otel\/nomaps\.json: not in the snapshot/)
    expect(check.stderr).toMatch(/all\/dist\/webpack\/otel\/maps\.json: no such site/)
  })

  test('fails on a site that monkeypatchlist cannot scan, or whose report it cannot use, and names it', async () => {
    const corpus = builtCorpus({
      ...site('dist/webpack/otel/maps', 'var a = 1'),
      ...site('dist/webpack/otel/nomaps', 'var a = 1'),
      ...site('dist/webpack/zonejs/maps', 'var a = 1'),
    })
    const snapshot = scratchDir()
    expect((await snapshotCommand(['--update', '--corpus', corpus, '--snapshot', snapshot])).exitCode).toBe(0)
    const real = validatedScanner()
    const failing: Deps['scan'] = async (dir, surface) => {
      if (dir.endsWith('otel/nomaps')) throw new Error('monkeypatchlist scan exited 4: internal error')
      // Every byte counts, so a report in another form than `monkeypatchlist` prints JSON in can't be compared.
      if (dir.endsWith('zonejs/maps')) return JSON.stringify(JSON.parse(await real(dir, surface)))
      return real(dir, surface)
    }

    const check = await snapshotCommand(['--corpus', corpus, '--snapshot', snapshot], { scan: failing })

    expect(check.exitCode).toBe(1)
    expect(check.stderr).toContain('all/dist/webpack/otel/nomaps.json: monkeypatchlist scan exited 4: internal error')
    expect(check.stderr).toContain('all/dist/webpack/zonejs/maps.json: the report is not in the form monkeypatchlist prints')
    expect(check.stderr).not.toContain('otel/maps.json')
    const update = await snapshotCommand(['--update', '--corpus', corpus, '--snapshot', snapshot], { scan: failing })
    expect(update.exitCode).toBe(1)
    expect(snapshotFiles(snapshot)).toHaveLength(6)
  })

  test('fails on a difference of one byte', async () => {
    const corpus = builtCorpus(site('dist/webpack/otel/maps', 'window.fetch = function () {}'))
    const snapshot = scratchDir()
    expect((await snapshotCommand(['--update', '--corpus', corpus, '--snapshot', snapshot])).exitCode).toBe(0)
    const path = join(snapshot, 'all/dist/webpack/otel/maps.json')
    writeFileSync(path, readFileSync(path, 'utf8').replace('"reportVersion": 1', '"reportVersion":  1'))

    const check = await snapshotCommand(['--corpus', corpus, '--snapshot', snapshot])

    expect(check.exitCode).toBe(1)
    expect(check.stderr).toContain('all/dist/webpack/otel/maps.json')
    expect(check.stderr).not.toContain('protected/dist/webpack/otel/maps.json')
  })
})

describe('release lines', () => {
  /** The real scanner, with the report saying it came from monkeypatchlist `version`. */
  function scannerAt(version: string): Deps['scan'] {
    const real = validatedScanner()
    return async (dir, surface) =>
      (await real(dir, surface)).replace('"monkeypatchlistVersion": "0.0.0"', `"monkeypatchlistVersion": "${version}"`)
  }

  test('a patch release reproduces the snapshot of its minor release', async () => {
    const corpus = builtCorpus(site('dist/webpack/otel/maps', 'window.fetch = function () {}'))
    const snapshot = scratchDir()
    expect((await snapshotCommand(['--update', '--corpus', corpus, '--snapshot', snapshot])).exitCode).toBe(0)

    const check = await snapshotCommand(['--corpus', corpus, '--snapshot', snapshot], { scan: scannerAt('0.0.7') })

    expect(check.exitCode, check.stderr).toBe(0)
  })

  test('a minor release fails the check until it refreshes the snapshot', async () => {
    const corpus = builtCorpus(site('dist/webpack/otel/maps', 'window.fetch = function () {}'))
    const snapshot = scratchDir()
    expect((await snapshotCommand(['--update', '--corpus', corpus, '--snapshot', snapshot])).exitCode).toBe(0)

    const check = await snapshotCommand(['--corpus', corpus, '--snapshot', snapshot], { scan: scannerAt('0.1.0') })

    expect(check.exitCode).toBe(1)
    expect(check.stderr).toContain('"monkeypatchlistVersion": "0.1"')
    expect(check.stderr).toContain('the snapshot is for monkeypatchlist 0.0, and this is 0.1')
    const refresh = ['--update', '--corpus', corpus, '--snapshot', snapshot]
    expect((await snapshotCommand(refresh, { scan: scannerAt('0.1.0') })).exitCode).toBe(0)
    const again = await snapshotCommand(['--corpus', corpus, '--snapshot', snapshot], { scan: scannerAt('0.1.0') })
    expect(again.exitCode, again.stderr).toBe(0)
  })

  test('--update refuses to refresh the snapshot in a patch release, and writes nothing', async () => {
    const corpus = builtCorpus(site('dist/webpack/otel/maps', 'window.fetch = function () {}'))
    const snapshot = scratchDir()

    const update = await snapshotCommand(['--update', '--corpus', corpus, '--snapshot', snapshot], {
      scan: scannerAt('1.2.3'),
    })

    expect(update.exitCode).toBe(2)
    expect(update.stderr).toContain('monkeypatchlist 1.2.3 is a patch release')
    expect(snapshotFiles(snapshot)).toEqual([])
  })
})

describe('the corpus build', () => {
  test('is verified byte for byte against its manifests before anything is scanned', async () => {
    const corpus = builtCorpus({
      ...site('dist/webpack/otel/maps', 'var a = 1'),
      ...site('variants/features-on/dist/esbuild/datadog/maps', 'var a = 1'),
    })
    const snapshot = scratchDir()
    expect((await snapshotCommand(['--update', '--corpus', corpus, '--snapshot', snapshot])).exitCode).toBe(0)
    // A rebuilt file that differs, a file the build no longer writes, and one it newly writes.
    writeFileSync(join(corpus, 'dist/webpack/otel/maps/main.js'), 'var a = 2')
    rmSync(join(corpus, 'variants/features-on/dist/esbuild/datadog/maps/main.js'))
    writeFileSync(join(corpus, 'variants/features-on/dist/esbuild/datadog/maps/extra.js'), '')
    let scans = 0
    const counting: Deps['scan'] = async () => {
      scans++
      return ''
    }

    const check = await snapshotCommand(['--corpus', corpus, '--snapshot', snapshot], { scan: counting })

    expect(check.exitCode).toBe(1)
    expect(check.stderr).toContain('dist/webpack/otel/maps/main.js: differs from manifest.json')
    expect(check.stderr).toContain('variants/features-on/dist/esbuild/datadog/maps/main.js: missing')
    expect(check.stderr).toContain('variants/features-on/dist/esbuild/datadog/maps/extra.js: not in variants/features-on/manifest.json')
    expect(scans).toBe(0)
  })

  test('--update refuses a build that differs from its manifest, and writes nothing', async () => {
    const corpus = builtCorpus(site('dist/webpack/otel/maps', 'var a = 1'))
    writeFileSync(join(corpus, 'dist/webpack/otel/maps/main.js'), 'var a = 2')
    const snapshot = scratchDir()

    const update = await snapshotCommand(['--update', '--corpus', corpus, '--snapshot', snapshot])

    expect(update.exitCode).toBe(1)
    expect(update.stderr).toContain('dist/webpack/otel/maps/main.js: differs from manifest.json')
    expect(snapshotFiles(snapshot)).toEqual([])
  })

  test('a corpus that has a manifest but was never built is refused (exit 2)', async () => {
    const corpus = builtCorpus(site('variants/lazy-chunks/dist/webpack/newrelic/maps', 'var a = 1'))
    rmSync(join(corpus, 'variants/lazy-chunks/dist'), { recursive: true })

    const check = await snapshotCommand(['--corpus', corpus, '--snapshot', scratchDir()])

    expect(check.exitCode).toBe(2)
    expect(check.stderr).toContain('variants/lazy-chunks/manifest.json has no dist/: build the corpus first')
  })
})

describe('the committed snapshot', () => {
  test('git ignores none of it, the reports under dist/ included', () => {
    const repository = fileURLToPath(new URL('../', import.meta.url))
    const paths = snapshotFiles(join(repository, 'corpus-snapshot')).map((path) => `corpus-snapshot/${path}`)

    const ignored = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], { cwd: repository, input: paths.join('\n') })

    expect(paths).toContain('corpus-snapshot/all/dist/webpack/otel/maps.json')
    expect(ignored.stdout.toString()).toBe('')
  })
})

describe('in CI', () => {
  const repository = new URL('../', import.meta.url)
  const corpus = pathToFileURL(`${corpusDir}/`)
  // The validation corpus is absent from a checkout that hasn't fetched it (`npm run corpus:fetch`): there is nothing to
  // check the job against.
  test.skipIf(!existsSync(corpus))('a job builds the corpus with the Node its manifests record, verifies the build, then runs the check', () => {
    const workflow = readFileSync(new URL('.github/workflows/ci.yml', repository), 'utf8')
    const variants = readdirSync(new URL('variants/', corpus)).map((variant) => `variants/${variant}/manifest.json`)
    const manifests = ['manifest.json', ...variants].filter((path) => existsSync(new URL(path, corpus)))
    const nodes = new Set(manifests.map((path) => JSON.parse(readFileSync(new URL(path, corpus), 'utf8')).node))

    expect(manifests.length).toBeGreaterThan(1)
    expect([...nodes]).toHaveLength(1)
    expect(workflow).toContain(`node-version: ${[...nodes][0].replace(/^v/, '')}\n`)
    const build = workflow.indexOf('npm run build\n          for manifest in variants/*/manifest.json')
    // In the corpus's own checkout, so a corpus fetched into its place is still compared with its commit.
    const verify = workflow.indexOf('git -C "$CORPUS" diff --exit-code -- .')
    const check = workflow.indexOf('run: npm run corpus:check')
    expect(build).toBeGreaterThan(-1)
    expect(verify).toBeGreaterThan(build)
    expect(check).toBeGreaterThan(verify)
  })

  test('the check scans with the pool: one worker process per CPU but one, never pinned to a single job', () => {
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
    const job = workflow.slice(workflow.indexOf('\n  corpus-snapshot:'))

    expect(job).toContain('run: npm run corpus:check\n')
    const steps = job.split('\n').filter((line) => !line.trimStart().startsWith('#'))
    expect(steps.join('\n')).not.toMatch(/--jobs|MONKEYPATCHLIST_CORPUS_JOBS/)
    expect(job).toContain('worker processes')
  })
})

describe('the pool of scans', () => {
  /** A corpus of five build directories, each with its own writes. */
  function fiveSites(): string {
    const apps = ['datadog', 'newrelic', 'otel', 'sentry', 'zonejs']
    return builtCorpus(
      Object.assign({}, ...apps.map((app, index) => site(`dist/webpack/${app}/maps`, `window.fetch = ${index}`))),
    )
  }

  /**
   * The real scanner (or, for a test that only counts scans, one that answers a report it can't use), with each scan
   * finishing later the earlier its site sorts, and the most scans ever in flight.
   */
  function reversedScanner(real: Deps['scan'] = validatedScanner()): { scan: Deps['scan']; inFlight: () => number } {
    let running = 0
    let most = 0
    let started = 0
    return {
      inFlight: () => most,
      scan: async (dir, surface) => {
        running++
        most = Math.max(most, running)
        const delay = 100 - 10 * started++
        try {
          const text = await real(dir, surface)
          await new Promise((resolve) => setTimeout(resolve, delay))
          return text
        } finally {
          running--
        }
      },
    }
  }

  // Worker processes, or twenty real scans: slow on a busy machine.
  test('--jobs 4 writes and checks the same bytes as --jobs 1, with at most 4 scans in flight', { timeout: 120_000 }, async () => {
    const corpus = fiveSites()
    const [serial, pooled] = [scratchDir(), scratchDir()]
    const one = reversedScanner()
    const four = reversedScanner()

    const update1 = await snapshotCommand(['--update', '--jobs', '1', '--corpus', corpus, '--snapshot', serial], { scan: one.scan })
    const update4 = await snapshotCommand(['--update', '--jobs', '4', '--corpus', corpus, '--snapshot', pooled], { scan: four.scan })

    expect(update1.exitCode, update1.stderr).toBe(0)
    expect(update4.exitCode, update4.stderr).toBe(0)
    expect(one.inFlight()).toBe(1)
    expect(four.inFlight()).toBe(4)
    expect(snapshotFiles(pooled)).toEqual(snapshotFiles(serial))
    for (const path of snapshotFiles(serial)) {
      expect(readFileSync(join(pooled, path), 'utf8'), path).toBe(readFileSync(join(serial, path), 'utf8'))
    }
  })

  test('by default the pool has one scan per available CPU but one, and no more heaps than fit in memory; MONKEYPATCHLIST_CORPUS_JOBS and then --jobs override it', async () => {
    const corpus = fiveSites()
    const gib = 2 ** 30
    const inFlight = async (argv: string[], machine: { cpus: number; memory: number }, env: Record<string, string> = {}) => {
      const counted = reversedScanner(async () => '')
      const deps = { scan: counted.scan, machine: () => ({ ...machine, heapLimit: 4 * gib }) }
      const run = await snapshotCommand(['--corpus', corpus, '--snapshot', scratchDir(), ...argv], deps, env)
      expect(run.stderr).not.toContain('usage:')
      return counted.inFlight()
    }

    expect(await inFlight([], { cpus: 4, memory: 64 * gib })).toBe(3)
    expect(await inFlight([], { cpus: 1, memory: 64 * gib })).toBe(1)
    // 12 CPUs, but only room for 2 heaps of 4 GiB in 10 GiB, or for none in 2 GiB.
    expect(await inFlight([], { cpus: 12, memory: 10 * gib })).toBe(2)
    expect(await inFlight([], { cpus: 12, memory: 2 * gib })).toBe(1)
    expect(await inFlight([], { cpus: 4, memory: 64 * gib }, { MONKEYPATCHLIST_CORPUS_JOBS: '2' })).toBe(2)
    expect(await inFlight(['--jobs', '1'], { cpus: 4, memory: 64 * gib }, { MONKEYPATCHLIST_CORPUS_JOBS: '2' })).toBe(1)
  })

  test('a number of jobs that is not a positive whole number is refused (exit 2)', async () => {
    const corpus = fiveSites()
    for (const [argv, env] of [
      [['--jobs', '0'], {}],
      [['--jobs', 'many'], {}],
      [['--jobs', '1.5'], {}],
      [[], { MONKEYPATCHLIST_CORPUS_JOBS: '-1' }],
    ] as const) {
      const run = await snapshotCommand(['--corpus', corpus, '--snapshot', scratchDir(), ...argv], {}, { ...env })
      expect(run.exitCode, argv.join(' ')).toBe(2)
      expect(run.stderr).toContain('jobs')
    }
  })

  // Worker processes, or twenty real scans: slow on a busy machine.
  test('the default scanner runs the scans in worker processes, and writes the bytes the scan in process writes', { timeout: 120_000 }, async () => {
    const corpus = builtCorpus({
      ...site('dist/webpack/otel/maps', 'window.fetch = function () {}; history.pushState = function () {}'),
      ...site('dist/vite/sentry/nomaps', 'XMLHttpRequest.prototype.open = function () {}'),
      'static-sites/control/index.html': '<p>nothing</p>',
      'fixtures/static-sites/restore-local-capture/index.html': '<script>var o = fetch; fetch = 1</script>',
    })
    const [serial, pooled] = [scratchDir(), scratchDir()]
    const processes: number[] = []
    const watched = (pids: number) => void processes.push(pids)

    const update1 = await snapshotCommand(['--update', '--jobs', '1', '--corpus', corpus, '--snapshot', serial], { scan: undefined, workerStarted: watched })
    const update3 = await snapshotCommand(['--update', '--jobs', '3', '--corpus', corpus, '--snapshot', pooled], { scan: undefined, workerStarted: watched })

    expect(update1.exitCode, update1.stderr).toBe(0)
    expect(update3.exitCode, update3.stderr).toBe(0)
    expect(processes).toHaveLength(3)
    expect(new Set([process.pid, ...processes]).size).toBe(4)
    expect(snapshotFiles(pooled)).toEqual(snapshotFiles(serial))
    expect(snapshotFiles(serial)).toHaveLength(8)
    for (const path of snapshotFiles(serial)) {
      expect(readFileSync(join(pooled, path), 'utf8'), path).toBe(readFileSync(join(serial, path), 'utf8'))
    }
    const check = await snapshotCommand(['--jobs', '3', '--corpus', corpus, '--snapshot', serial], { scan: undefined })
    expect(check.exitCode, check.stderr).toBe(0)
  })

  // Worker processes, or twenty real scans: slow on a busy machine.
  test('a worker process that exits mid-scan fails that scan alone, and a new worker takes the next', { timeout: 120_000 }, async () => {
    const workers = processPool(2, { module: new URL('./support/crashing-scan-worker.ts', import.meta.url) })
    try {
      const dirs = ['/a', '/crash', '/b', '/throws', '/c', '/d']
      const outcomes = await Promise.allSettled(dirs.map((dir) => workers.scan(dir, 'all')))

      expect(outcomes.map((outcome) => (outcome.status === 'fulfilled' ? outcome.value : (outcome.reason as Error).message))).toEqual([
        '/a all',
        'the scan worker process exited (code 3) during the scan',
        '/b all',
        'cannot scan /throws',
        '/c all',
        '/d all',
      ])
    } finally {
      workers.close()
    }
  })
})

describe('binding-seam conformance (§19)', () => {
  /** Writes whose findings hang on scope: a shadowed `fetch`, a classic-script global `var`, and a block function. */
  function scopedSites(): string {
    return builtCorpus({
      ...site('dist/webpack/otel/maps', 'var fetch; fetch = w; function f(fetch) { fetch = 1 }\n{ function alert() {} }'),
      ...site('dist/vite/sentry/nomaps', 'let XMLHttpRequest = 1; window.XMLHttpRequest.prototype.open = function () {}'),
      'static-sites/control/index.html': '<p>nothing</p>',
    })
  }

  test('--bindings typescript-eslint checks the eslint-scope snapshot with the drop-in behind the seam, and it matches byte for byte', { timeout: 120_000 }, async () => {
    const corpus = scopedSites()
    const snapshot = scratchDir()
    const update = await snapshotCommand(['--update', '--jobs', '1', '--corpus', corpus, '--snapshot', snapshot], { scan: undefined })
    expect(update.exitCode, update.stderr).toBe(0)

    for (const jobs of ['1', '2']) {
      const check = await snapshotCommand(['--bindings', 'typescript-eslint', '--jobs', jobs, '--corpus', corpus, '--snapshot', snapshot], { scan: undefined })

      expect(check.exitCode, check.stderr).toBe(0)
      expect(check.stdout).toContain('all 6 reports match the snapshot')
      expect(check.stdout).toContain('@typescript-eslint/scope-manager behind the binding-resolution seam')
    }
  })

  test('the snapshot is always written with the shipped eslint-scope: --update with --bindings is refused (exit 2), and so is an unknown implementation', async () => {
    const corpus = scopedSites()
    const snapshot = scratchDir()

    const update = await snapshotCommand(['--update', '--bindings', 'typescript-eslint', '--corpus', corpus, '--snapshot', snapshot])
    const unknown = await snapshotCommand(['--bindings', 'acorn', '--corpus', corpus, '--snapshot', snapshot])

    expect(update.exitCode).toBe(2)
    expect(update.stderr).toMatch(/--bindings/)
    expect(existsSync(join(snapshot, 'protected'))).toBe(false)
    expect(unknown.exitCode).toBe(2)
    expect(unknown.stderr).toMatch(/--bindings/)
  })
})

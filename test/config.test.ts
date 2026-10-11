import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertValidReport, defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'

const page = '<script src="main.js"></script>'
const files = { 'index.html': page, 'main.js': 'window.fetch = function(){}' }

/** Runs `monkeypatchlist <argv…> --json -` in `cwd`, and returns the validated report. */
async function scanJson(argv: string[], cwd: string) {
  const run = await runCli([...argv, '--json', '-'], { cwd })
  if (run.exitCode !== 0) throw new Error(`scan exited ${run.exitCode}:\n${run.stderr}`)
  const report = JSON.parse(run.stdout)
  assertValidReport(report)
  return report
}

const mappings = [{ url: 'https://portal.example/', dir: '.' }]
const config = (value: unknown) => ({ 'monkeypatchlist.config.json': JSON.stringify(value, null, 2) })

describe('the configuration file (§16)', () => {
  test('without --config, monkeypatchlist.config.json in the working directory is picked up', async () => {
    const cwd = workingDir(config({ name: 'Trading Portal', mappings }))

    const report = await scanJson(['scan', fixtureBuild(files)], cwd)

    expect(report.application).toEqual({ name: 'Trading Portal' })
    expect(report.config.mappings).toEqual([{ url: 'https://portal.example/', dir: '.' }])
    expect(report.config.entries).toEqual([{ file: 'index.html', url: 'https://portal.example/' }])
    expect(report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      'window|Window.fetch|replace|unknown',
    ])
  })
})

describe('the config JSON Schema validates the file (§16)', () => {
  /** Scans with `value` as the working directory's monkeypatchlist.config.json. */
  const scanWith = (value: unknown, text = JSON.stringify(value)) =>
    runCli(['scan', fixtureBuild(files)], { cwd: workingDir({ 'monkeypatchlist.config.json': text }) })

  test('a config with every §16 key is accepted', async () => {
    const every = {
      name: 'Trading Portal',
      entries: [{ file: 'index.html', url: 'https://portal.example/' }],
      mappings,
      sourceMaps: ['maps'],
      surface: 'all',
      mode: 'offline',
      lockfile: { path: 'package-lock.json', importer: 'apps/portal' },
      baseline: 'monkeypatchlist.baseline.json',
      previous: 'previous-report.json',
      failOn: ['added', 'changed'],
      allowIncomplete: true,
      allowDowngrade: true,
      json: '-',
      out: 'monkeypatchlist.baseline.json',
      verbose: true,
    }

    // `baseline init` ignores the scan keys, and writes the baseline that `baseline` and `failOn` then gate on.
    const build = fixtureBuild(files)
    const cwd = workingDir({
      'monkeypatchlist.config.json': JSON.stringify(every),
      // A map that pairs `main.js`, so that the directory is not `source-maps-unpaired` (§13).
      'maps/main.js.map': JSON.stringify({ version: 3, sources: ['main.ts'], names: [], mappings: 'AAAA' }),
    })
    expect((await runCli(['baseline', 'init', build], { cwd })).exitCode).toBe(0)
    // The previous report `previous` names: a scan of the same configuration, without a previous report of its own.
    const { name, entries, sourceMaps, surface, mode, lockfile, json } = every
    const first = await runCli(['scan', build], {
      cwd: workingDir({
        'monkeypatchlist.config.json': JSON.stringify({ name, entries, mappings, sourceMaps, surface, mode, lockfile, json }),
        'maps/main.js.map': JSON.stringify({ version: 3, sources: ['main.ts'], names: [], mappings: 'AAAA' }),
      }),
    })
    expect(first.exitCode).toBe(0)
    writeFileSync(join(cwd, 'previous-report.json'), first.stdout)

    const run = await runCli(['scan', build], { cwd })

    expect(run.stderr).toBe('')
    expect(run.exitCode).toBe(0)
    const report = JSON.parse(run.stdout)
    expect(report.application).toEqual({ name: 'Trading Portal' })
    expect(report.gate).toEqual({ failOn: ['added', 'changed'], result: 'pass', exitCode: 0 })
  })

  test.each([
    ['a value of the wrong type', { mappings: [{ url: 'https://portal.example/', dir: 1 }] }, '/mappings/0/dir'],
    ['a value outside its enum', { mappings, surface: 'everything' }, '/surface'],
    ['a --fail-on state that cannot gate', { mappings, failOn: ['removed'] }, '/failOn/0'],
    ['a missing required field', { mappings: [{ url: 'https://portal.example/' }] }, '/mappings/0/dir'],
    ['an empty list', { mappings: [] }, '/mappings'],
    ['an empty name', { mappings, name: '' }, '/name'],
    ['a mapping URL that is not absolute', { mappings: [{ url: 'portal.example', dir: '.' }] }, '/mappings/0/url'],
    ['a mapping URL that is not http(s)', { mappings: [{ url: 'file:///srv/', dir: '.' }] }, '/mappings/0/url'],
    ['an entry URL that is not absolute', { mappings, entries: [{ file: 'index.html', url: '/home' }] }, '/entries/0/url'],
  ])('an invalid config exits 2 and names the failing path: %s', async (_, value, path) => {
    const run = await scanWith(value)

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('monkeypatchlist.config.json')
    expect(run.stderr).toContain(`${path}:`)
  })

  test.each([
    ['at the top level', { mappings, frobnicate: true }, '/frobnicate'],
    ['in a mapping', { mappings: [{ url: 'https://portal.example/', dir: '.', cdn: true }] }, '/mappings/0/cdn'],
    ['in an entry', { mappings, entries: [{ file: 'index.html', realm: 'window' }] }, '/entries/0/realm'],
    ['in the lockfile', { mappings, lockfile: { path: 'package-lock.json', format: 'npm' } }, '/lockfile/format'],
    ['for a flag with no key, such as --map', { mappings, map: 'https://portal.example/=.' }, '/map'],
  ])('unknown keys are rejected: %s', async (_, value, path) => {
    const run = await scanWith(value)

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain(`${path}:`)
  })

  test('the schema ships with a key for each §16 setting, and $schema for editors', () => {
    const schema = JSON.parse(readFileSync('schema/config.schema.json', 'utf8'))

    expect(schema.additionalProperties).toBe(false)
    expect(Object.keys(schema.properties)).toEqual([
      '$schema',
      'name',
      'entries',
      'mappings',
      'sourceMaps',
      'surface',
      'mode',
      'lockfile',
      'baseline',
      'previous',
      'failOn',
      'allowIncomplete',
      'allowDowngrade',
      'json',
      'out',
      'report',
      'verbose',
      'listIneffective',
      'noColor',
    ])
    expect(Object.keys(schema.properties.lockfile.properties)).toEqual(['path', 'importer'])
    expect(schema.properties.surface.enum).toEqual(['protected', 'all'])
    expect(schema.properties.mode.enum).toEqual(['offline', 'resolve'])
    expect(schema.properties.failOn.items.enum).toEqual(['added', 'changed'])
  })

  test('a $schema key is allowed, for editors', async () => {
    const run = await scanWith({ $schema: './node_modules/monkeypatchlist/schema/config.schema.json', mappings })

    expect(run.exitCode).toBe(0)
  })

  test('a file that starts with a UTF-8 byte order mark is read', async () => {
    const run = await scanWith(undefined, `\uFEFF${JSON.stringify({ mappings })}`)

    expect(run.exitCode).toBe(0)
  })

  test('a file that is not a JSON object exits 2', async () => {
    expect((await scanWith(undefined, '[]')).exitCode).toBe(2)
    expect((await scanWith(undefined, '{ "mappings": ')).exitCode).toBe(2)
  })

  test('a monkeypatchlist.config.json that exists but cannot be read exits 2, not 4', async () => {
    const cwd = workingDir()
    symlinkSync('monkeypatchlist.config.json', join(cwd, 'monkeypatchlist.config.json'))

    const run = await runCli(['scan', fixtureBuild(files), '--map', defaultMap], { cwd })

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('monkeypatchlist.config.json')
  })
})

describe("the file's mappings (§16 --map)", () => {
  test('the longest matching prefix wins', async () => {
    const build = fixtureBuild({ 'index.html': '<script src="assets/main.js"></script>', 'static/main.js': 'fetch = f' })
    const cwd = workingDir(
      config({
        mappings: [
          { url: 'https://portal.example/', dir: '.' },
          { url: 'https://portal.example/assets/', dir: 'static' },
        ],
      }),
    )

    const report = await scanJson(['scan', build], cwd)

    expect(report.artifacts.map(({ url, path }: { url: string; path: string }) => ({ url, path }))).toEqual([
      { url: 'https://portal.example/assets/main.js', path: 'static/main.js' },
    ])
  })

  test('two mappings for the same URL prefix exit 2 and name the second', async () => {
    const cwd = workingDir(
      config({
        mappings: [
          { url: 'https://portal.example/', dir: '.' },
          { url: 'https://PORTAL.example', dir: 'static' },
        ],
      }),
    )

    const run = await runCli(['scan', fixtureBuild(files)], { cwd })

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('/mappings/1/url:')
  })
})

describe('--config <path> (§16)', () => {
  test('names the config file, relative to the working directory', async () => {
    const cwd = workingDir({ 'ci/monkeypatchlist.json': JSON.stringify({ name: 'Trading Portal', mappings }) })

    const report = await scanJson(['scan', fixtureBuild(files), '--config', 'ci/monkeypatchlist.json'], cwd)

    expect(report.application).toEqual({ name: 'Trading Portal' })
  })

  test("is used instead of the working directory's monkeypatchlist.config.json", async () => {
    const cwd = workingDir({
      ...config({ name: 'Default', mappings }),
      'other.json': JSON.stringify({ name: 'Other', mappings }),
    })

    const report = await scanJson(['scan', fixtureBuild(files), '--config', 'other.json'], cwd)

    expect(report.application).toEqual({ name: 'Other' })
  })

  test("resolves the file's paths against the file's own directory", async () => {
    const cwd = workingDir({ 'ci/monkeypatchlist.json': JSON.stringify({ mappings, json: 'report.json' }) })

    const run = await runCli(['scan', fixtureBuild(files), '--config', 'ci/monkeypatchlist.json'], { cwd })

    expect(run.exitCode).toBe(0)
    const report = JSON.parse(readFileSync(join(cwd, 'ci/report.json'), 'utf8'))
    assertValidReport(report)
    expect(report.findings).toHaveLength(1)
  })

  test('that is missing exits 2', async () => {
    const run = await runCli(['scan', fixtureBuild(files), '--config', 'missing.json'])

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('missing.json')
  })
})

describe('JS and TS config files are never loaded (§16)', () => {
  const executes = {
    'monkeypatchlist.config.js': "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'executed'), '')",
    'monkeypatchlist.config.mjs':
      "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('executed', import.meta.url), '')",
    'monkeypatchlist.config.ts':
      "import { writeFileSync } from 'node:fs'\nwriteFileSync(new URL('executed', import.meta.url), '' as string)",
  }

  test.each(Object.keys(executes))('--config %s exits 2 without executing it', async (name) => {
    const cwd = workingDir(executes)

    const run = await runCli(['scan', fixtureBuild(files), '--map', defaultMap, '--config', name], { cwd })

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain(name)
    expect(existsSync(join(cwd, 'executed'))).toBe(false)
  })

  test('even when the file is also valid JSON', async () => {
    const cwd = workingDir({ 'monkeypatchlist.config.js': '{}' })

    const run = await runCli(['scan', fixtureBuild(files), '--map', defaultMap, '--config', 'monkeypatchlist.config.js'], {
      cwd,
    })

    expect(run.exitCode).toBe(2)
  })

  test('a monkeypatchlist.config.js in the working directory is not picked up', async () => {
    const cwd = workingDir({ 'monkeypatchlist.config.js': executes['monkeypatchlist.config.js'] })

    const report = await scanJson(['scan', fixtureBuild(files), '--map', defaultMap], cwd)

    expect(report.findings).toHaveLength(1)
    expect(existsSync(join(cwd, 'executed'))).toBe(false)
  })
})

describe('flags override the config file field by field (§16)', () => {
  const twoPages = { ...files, 'app/other.html': page.replace('main.js', '../main.js') }
  const file = {
    entries: [{ file: 'index.html', url: 'https://portal.example/home' }],
    mappings: [{ url: 'https://portal.example/', dir: '.' }],
  }

  test("a file's mappings combine with an --entry flag, which replaces the file's entries", async () => {
    const report = await scanJson(['scan', fixtureBuild(twoPages), '--entry', 'app/other.html'], workingDir(config(file)))

    expect(report.config.entries).toEqual([{ file: 'app/other.html', url: 'https://portal.example/' }])
    expect(report.config.mappings).toEqual(file.mappings)
    expect(report.artifacts.map((artifact: { url: string }) => artifact.url)).toEqual(['https://portal.example/main.js'])
  })

  test("a --map flag replaces the file's mappings, and the file's entries stay", async () => {
    const report = await scanJson(
      ['scan', fixtureBuild(twoPages), '--map', 'https://cdn.example/=.'],
      workingDir(config(file)),
    )

    expect(report.config.entries).toEqual(file.entries)
    expect(report.config.mappings).toEqual([{ url: 'https://cdn.example/', dir: '.' }])
  })

  test("a --json flag overrides the file's json", async () => {
    const cwd = workingDir(config({ ...file, json: 'report.json' }))

    const report = await scanJson(['scan', fixtureBuild(twoPages)], cwd)

    expect(report.config.mappings).toEqual(file.mappings)
    expect(existsSync(join(cwd, 'report.json'))).toBe(false)
  })
})

describe('the application name (§16 Application name)', () => {
  test("defaults to the build directory's basename, in the report's application.name", async () => {
    const { report } = await scanBuild(fixtureBuild(files, 'trading-portal'))

    expect(report.application).toEqual({ name: 'trading-portal' })
  })

  test('shows in the terminal title', async () => {
    const run = await runCli(['scan', fixtureBuild(files, 'trading-portal'), '--map', defaultMap])

    expect(run.exitCode).toBe(0)
    const [title] = run.stdout.split('\n')
    expect(title).toContain(' · trading-portal · ')
  })
})

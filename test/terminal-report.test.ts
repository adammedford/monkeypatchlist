// The terminal report (§15 Terminal, §2 Input tiers, §16 Flags). This is the one place tests assert on rendered text
// (README standing criteria): whole reports are compared with hand-written expected output. The header's versions are
// read from the package and the catalog, so that a catalog or version bump doesn't churn these tests.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { defaultMap, fixtureBuild, runCli, workingDir, type TerminalIo } from './support/fixture-build.ts'
import { mappings, type Segment } from './support/source-map.ts'

const monkeypatchlistVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const catalogVersion = loadCatalog().metadata.catalogVersion
const header = (surface: string) => `monkeypatchlist ${monkeypatchlistVersion} · catalog ${catalogVersion} · build · surface ${surface} · offline`

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })

describe('a clean report', () => {
  test('says no mutations were found, then completeness, inputs, scope and ineffective writes', async () => {
    const run = await runCli(['scan', fixtureBuild(classic('console.log(1)')), '--map', defaultMap])

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toBe(
      [
        header('protected'),
        '',
        'No platform mutations found.',
        '',
        'Completeness   complete',
        '  Known 1 · analyzed 1 · failed 0 · skipped 0',
        'Inputs',
        '  Source maps  0 / 1 artifacts · without a map: Package unknown for bundled code, no original locations',
        '  Lockfile     not given · no lockfile versions; Introduced by unknown',
        'Outside scope  none',
        'Ineffective writes 0',
        '',
        'Gate  not run (no --fail-on)',
        '',
      ].join('\n'),
    )
  })
})

/**
 * One line of `main.js`: its code, and the package it comes from (`node_modules/<package>/index.js` in the map), or null
 * for a line the map leaves unmapped, whose writes key `unknown`.
 */
type Line = [code: string, pkg: string | null]

/** A build whose `main.js` holds `lines`, with a sidecar map naming each mapped line's package file. */
function build(lines: readonly Line[]): string {
  const packages = [...new Set(lines.flatMap(([, pkg]) => (pkg === null ? [] : [pkg])))]
  const segments = lines.map(([code, pkg]): Segment[] => {
    if (pkg === null) return []
    const source = packages.indexOf(pkg)
    return [...code.matchAll(/[\w$]+|[^\s\w$]/g)].map((match) => [match.index, source, 0, match.index])
  })
  const map = {
    version: 3,
    sources: packages.map((pkg) => `webpack://app/./node_modules/${pkg}/index.js`),
    sourcesContent: packages.map((pkg) => lines.find(([, each]) => each === pkg)![0]),
    names: [],
    mappings: mappings(segments),
  }
  return fixtureBuild({
    'index.html': '<script src="main.js"></script>',
    'main.js': lines.map(([code]) => code).join('\n'),
    'main.js.map': JSON.stringify(map),
  })
}

const send = 'XMLHttpRequest.prototype.send = s'
const pushState = 'History.prototype.pushState = p'
const listen = 'EventTarget.prototype.addEventListener = l'
const fetch = 'window.fetch = g'

/** A working directory holding a baseline of `lines`, written by `monkeypatchlist baseline init`. */
async function withBaseline(lines: readonly Line[]): Promise<string> {
  const cwd = workingDir()
  const run = await runCli(['baseline', 'init', build(lines), '--map', defaultMap, '--surface', 'all'], { cwd })
  if (run.exitCode !== 0) throw new Error(`baseline init exited ${run.exitCode}:\n${run.stderr}`)
  return cwd
}

/** Scans the changed build against the baseline in `cwd`, gating on added and changed, with `args`. */
async function scanChanged(cwd: string, args: string[] = [], io: Partial<TerminalIo> = {}) {
  const lines: Line[] = [[send, 'b'], [listen, null], [fetch, 'c'], ['Math.PI = 3', null], ['window.alert = a', null]]
  const argv = ['scan', build(lines), '--map', defaultMap, '--surface', 'all', '--fail-on', 'added,changed', ...args]
  return runCli(argv, { cwd, io })
}

const baselineLines: Line[] = [[send, 'a'], [pushState, 'd'], [listen, 'f'], [fetch, 'c']]

/** The report up to the Existing section: what every run of `scanChanged` prints first. */
const changeLines = [
  header('all'),
  '',
  'Change since baseline',
  '  Added 1   Changed 1   Removed 1   Unconfirmed 0   Existing 2',
  '',
  'Added',
  '  Window.alert                     replace',
  '    Package          unknown',
  '    Source           main.js:5:0',
  '    Provenance       unknown · load · unconditional',
  '    Confidence       target high · mutation high · attribution low (no-map)',
  '    Fingerprint      window|Window.alert|replace|unknown',
  '',
  'Changed',
  '  XMLHttpRequest.prototype.send    replace   attribution a → b',
  '    Package          b',
  '    Introduced by    unknown (no lockfile)',
  '    Source           webpack://app/./node_modules/b/index.js:1 (main.js:1:0)',
  '    Provenance       bundled dependency · load · unconditional',
  '    Confidence       target high · mutation high · attribution high',
  '    Fingerprint      window|XMLHttpRequest.prototype.send|replace|pkg:b',
  '',
  'Removed',
  '  History.prototype.pushState      replace   pkg:d',
]

const tailLines = (ineffective: string[]) => [
  '',
  'Notes',
  '  EventTarget.prototype.addEventListener rekeyed pkg:f → unknown',
  '',
  'Completeness   complete',
  '  Known 1 · analyzed 1 · failed 0 · skipped 0',
  'Inputs',
  '  Source maps  1 / 1 artifacts · 2 findings have Package unknown',
  '  Lockfile     not given · no lockfile versions; Introduced by unknown',
  'Outside scope  none',
  ...ineffective,
  '',
  'Gate  fail-on added,changed → FAIL (2 findings)   exit 1',
  '',
]

describe('a report with added, changed, removed and notes', () => {
  test('cards the added and changed findings, lists removed entries and notes, and counts the rest', async () => {
    const cwd = await withBaseline(baselineLines)

    const run = await scanChanged(cwd)

    expect(run.exitCode).toBe(1)
    expect(run.stdout).toBe([...changeLines, ...tailLines(['Ineffective writes 1   (--list-ineffective)'])].join('\n'))
  })

  test('--verbose cards the existing findings too', async () => {
    const cwd = await withBaseline(baselineLines)

    const run = await scanChanged(cwd, ['--verbose'])

    expect(run.stdout).toBe(
      [
        ...changeLines,
        '',
        'Existing',
        '  EventTarget.prototype.addEventListener replace',
        '    Package          unknown',
        '    Source           main.js:2:0',
        '    Provenance       unknown · load · unconditional',
        '    Confidence       target high · mutation high · attribution low (no-map)',
        '    Fingerprint      window|EventTarget.prototype.addEventListener|replace|unknown',
        '  Window.fetch                     replace',
        '    Package          c',
        '    Introduced by    unknown (no lockfile)',
        '    Source           webpack://app/./node_modules/c/index.js:1 (main.js:3:0)',
        '    Provenance       bundled dependency · load · unconditional',
        '    Confidence       target high · mutation high · attribution high',
        '    Fingerprint      window|Window.fetch|replace|pkg:c',
        ...tailLines(['Ineffective writes 1   (--list-ineffective)']),
      ].join('\n'),
    )
  })

  test('--list-ineffective lists each ineffective write', async () => {
    const cwd = await withBaseline(baselineLines)

    const run = await scanChanged(cwd, ['--list-ineffective'])

    expect(run.stdout).toBe(
      [
        ...changeLines,
        ...tailLines([
          'Ineffective writes 1',
          '  Math.PI                          non-writable',
          '    replace · assign · throws strict-only · main.js:4:0',
        ]),
      ].join('\n'),
    )
  })
})

describe('previous-scan notes (§11 Never `changed`, §15)', () => {
  test('a reachability or install-context change against a previous report is listed under Notes, before → after', async () => {
    const cwd = workingDir()
    const before = fixtureBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': 'export function init() { if (window.c) { window.fetch = g } }',
    })
    const saved = await runCli(['scan', before, '--map', defaultMap, '--json', 'last.json'], { cwd })
    if (saved.exitCode !== 0) throw new Error(`scan exited ${saved.exitCode}:\n${saved.stderr}`)

    const run = await runCli(['scan', fixtureBuild(classic(fetch)), '--map', defaultMap, '--baseline', 'last.json'], { cwd })

    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain(
      [
        'Notes',
        '  Window.fetch                     reachability conditional → unconditional',
        '  Window.fetch                     install context deferred → load',
        '',
      ].join('\n'),
    )
  })
})

describe('formatting and channels (§15)', () => {
  const esc = '\u001b['

  test('color is used on a TTY', async () => {
    const run = await scanChanged(await withBaseline(baselineLines), [], { tty: true, env: {} })
    expect(run.stdout).toContain(`${esc}31mFAIL (2 findings)${esc}0m`)
  })

  test.each([
    ['without a TTY', [], { tty: false, env: {} }],
    ['under NO_COLOR', [], { tty: true, env: { NO_COLOR: '1' } }],
    ['under --no-color', ['--no-color'], { tty: true, env: {} }],
  ] as const)('color is off %s', async (_, args, io) => {
    const run = await scanChanged(await withBaseline(baselineLines), [...args], io)
    expect(run.stdout).not.toContain(esc)
    expect(run.stdout).toContain('FAIL (2 findings)')
  })

  test('an empty NO_COLOR leaves color on, as no-color.org says', async () => {
    const run = await scanChanged(await withBaseline(baselineLines), [], { tty: true, env: { NO_COLOR: '' } })
    expect(run.stdout).toContain(esc)
  })

  test('diagnostics go to stderr, never stdout', async () => {
    const run = await runCli(['scan', fixtureBuild(classic('console.log(1)')), '--map', defaultMap, '--baseline', 'missing.json'])
    expect(run.stderr).toContain('monkeypatchlist: warning: scanning without a baseline')
    expect(run.stdout).not.toContain('monkeypatchlist:')
    expect(run.stdout.startsWith(header('protected'))).toBe(true)
  })

  test('--json - replaces the terminal report', async () => {
    const run = await scanChanged(await withBaseline(baselineLines), ['--json', '-'], { tty: true, env: {} })
    expect(JSON.parse(run.stdout).summary.added).toBe(1)
    expect(run.stdout).not.toContain('Change since baseline')
  })

  test('--verbose and --list-ineffective are scan flags', async () => {
    for (const flag of ['--verbose', '--list-ineffective']) {
      const run = await runCli(['baseline', 'init', fixtureBuild(classic('')), '--map', defaultMap, flag])
      expect(run.exitCode).toBe(2)
    }
  })

  test('the config file key `verbose` cards existing findings', async () => {
    const cwd = await withBaseline(baselineLines)
    writeFileSync(join(cwd, 'monkeypatchlist.config.json'), JSON.stringify({ verbose: true }))
    const run = await scanChanged(cwd)
    expect(run.stdout).toContain('\nExisting\n')
  })
})

describe('outside scope (§12)', () => {
  test('a protected scan counts what it left out per surface, with a hint to run --surface all', async () => {
    const run = await runCli(['scan', fixtureBuild(classic('Element.prototype.appendChild = f\nwindow.fetch = g')), '--map', defaultMap])

    expect(run.stdout).toContain('\nOutside scope  DOM 1   (run with --surface all)\n')
    expect(run.stdout).toContain('\nFindings 1   (no baseline: run with --baseline to see the change)\n  Window.fetch ')
  })
})

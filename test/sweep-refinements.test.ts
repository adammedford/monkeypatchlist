// The sweep's refinements (§2 Sweep, §13 `unreadable`): it follows symbolic links, with
// loop protection by real path, counts the other files a mapping serves, and gives an unlistable directory `unreadable`
// only when a mapping serves a path under it. Of the links it can't resolve, a dangling
// link or a link cycle gives no record, and a link whose target can't be reached is `unreadable` when a mapping serves
// its path or a path under it. Every scenario goes through `monkeypatchlist scan --json`.

import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { fixtureBuild, scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** Writes `files` under `dir`, which is outside the build directory. */
function writeOutside(dir: string, files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
}

describe('symbolic links (§2 Sweep)', () => {
  test('a chunk reachable only through a symlinked directory is swept, at the URL of its path through the link', async () => {
    const dir = fixtureBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': 'window.alert = g' })
    writeOutside(join(dir, '../shared'), { 'lazy.js': 'window.fetch = f' })
    symlinkSync('../shared', join(dir, 'assets'))

    const { report } = await scanBuild(dir)

    expect(report.artifacts.map(({ url, path, discovery }: Json) => [url, path, discovery])).toEqual([
      ['https://app.example/assets/lazy.js', 'assets/lazy.js', 'sweep'],
      ['https://app.example/main.js', 'main.js', 'reference'],
    ])
    expect(report.findings.map((finding: Json) => finding.fingerprint)).toEqual([
      'window|Window.alert|replace|unknown',
      'window|Window.fetch|replace|unknown',
    ])
    expect(report.completeness.level).toBe('complete')
  })

  test('a symlink loop terminates: a directory whose real path is one it lies in is not listed again', async () => {
    const dir = fixtureBuild({ 'index.html': '', 'chunks/a.js': 'window.fetch = f' })
    symlinkSync('..', join(dir, 'chunks/up'))
    symlinkSync('.', join(dir, 'self'))

    const { report } = await scanBuild(dir)

    expect(report.artifacts.map(({ path }: Json) => path)).toEqual(['chunks/a.js'])
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.level).toBe('complete')
  })

  test('a file reached through a link has the path of the link, and each path a mapping serves is swept', async () => {
    const dir = fixtureBuild({
      'public/index.html': '',
      'lib/vendor.js': 'window.open = h',
      'lib/nested/chunk.js': 'window.print = p',
    })
    symlinkSync('../lib/vendor.js', join(dir, 'public/vendor.js'))
    symlinkSync('../lib/nested', join(dir, 'public/nested'))

    const { report } = await scanBuild(dir, ['--map', 'https://app.example/=public', '--entry', 'public/index.html'])

    expect(report.artifacts.map(({ url, path }: Json) => [url, path])).toEqual([
      ['https://app.example/nested/chunk.js', 'public/nested/chunk.js'],
      ['https://app.example/vendor.js', 'public/vendor.js'],
    ])
    // URL mappings still decide scope: the same files at their own paths are outside every mapping.
    expect(report.completeness.excluded).toEqual(['lib/nested/chunk.js', 'lib/vendor.js'])
  })

  test('a dangling link and a link cycle a mapping serves give no record: they lead to nothing to analyze', async () => {
    const dir = fixtureBuild({ 'index.html': '', 'app.js': 'window.fetch = f' })
    symlinkSync('gone.js', join(dir, 'chunk.js'))
    symlinkSync('missing', join(dir, 'assets'))
    symlinkSync('b.js', join(dir, 'a.js'))
    symlinkSync('a.js', join(dir, 'b.js'))

    const { report } = await scanBuild(dir)

    expect(report.artifacts.map(({ path }: Json) => path)).toEqual(['app.js'])
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.level).toBe('complete')
  })
})

describe('other files a mapping serves (§2 Sweep, §13 Counters)', () => {
  test('are counted in `otherFiles` and not analyzed; only `.wasm` counts in `nonJs`', async () => {
    const { report } = await scanBuild(
      {
        'public/index.html': '<script src="main"></script>',
        'public/main': 'window.alert = g',
        'public/chunks/lazy': 'window.fetch = f',
        'public/view.jsx': 'window.open = h',
        'public/styles.css': 'body {}',
        'public/codec.wasm': '\0asm',
        'server/page.jsx': 'globalThis.fetch = f',
        'server/notes.txt': '',
      },
      ['--map', 'https://app.example/=public', '--entry', 'public/index.html'],
    )

    // A reference reads a file whatever its extension; the sweep takes only `.js`, `.mjs` and `.cjs` for JavaScript.
    expect(report.artifacts.map(({ path, discovery }: Json) => [path, discovery])).toEqual([['public/main', 'reference']])
    expect(report.findings.map((finding: Json) => finding.fingerprint)).toEqual(['window|Window.alert|replace|unknown'])
    // `index.html`, `chunks/lazy`, `view.jsx` and `styles.css`: not what no mapping serves, nor what a reference found.
    expect(report.completeness.counters.artifacts).toMatchObject({
      known: 2,
      skipped: { offline: 0, refused: 0, excluded: 0, nonJs: 1 },
      otherFiles: 4,
    })
    expect(report.completeness.excluded).toEqual([])
    expect(report.completeness.level).toBe('complete')
  })
})

describe('a directory or link target the sweep cannot reach (§13 `unreadable`)', () => {
  const publicEntry = ['--entry', 'public/index.html']

  /** Scans `dir` with `locked` directories unlistable, and restores them after. */
  async function scanLocked(dir: string, locked: string[], args: string[]) {
    for (const path of locked) chmodSync(join(dir, path), 0o000)
    try {
      return (await scanBuild(dir, args)).report
    } finally {
      for (const path of locked) chmodSync(join(dir, path), 0o755)
    }
  }

  test('under a mapping gives `unreadable`, and the scan is `incomplete`', async () => {
    const dir = fixtureBuild({ 'public/index.html': '', 'public/locked/chunk.js': 'window.fetch = f' })

    const report = await scanLocked(dir, ['public/locked'], ['--map', 'https://app.example/=public', ...publicEntry])

    expect(report.completeness.limitations).toEqual([
      { kind: 'unreadable', artifact: { path: 'public/locked' }, detail: expect.stringContaining('EACCES') },
    ])
    expect(report.completeness.level).toBe('incomplete')
  })

  test('outside every mapping gives no record', async () => {
    const dir = fixtureBuild({
      'public/index.html': '',
      'public/app.js': 'window.fetch = f',
      'server/private/render.js': 'globalThis.fetch = f',
    })

    const report = await scanLocked(dir, ['server/private'], ['--map', 'https://app.example/=public', ...publicEntry])

    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.level).toBe('complete')
    expect(report.artifacts.map(({ path }: Json) => path)).toEqual(['public/app.js'])
  })

  test('that holds a mapping’s directory gives `unreadable`: the mapping serves the paths under it', async () => {
    const dir = fixtureBuild({ 'public/index.html': '', 'dist/client/assets/chunk.js': 'window.fetch = f' })

    const report = await scanLocked(dir, ['dist/client'], [
      ...['--map', 'https://app.example/=public', '--map', 'https://cdn.example/assets/=dist/client/assets'],
      ...publicEntry,
    ])

    expect(report.completeness.limitations).toEqual([
      { kind: 'unreadable', artifact: { path: 'dist/client' }, detail: expect.stringContaining('EACCES') },
    ])
    expect(report.completeness.level).toBe('incomplete')
  })

  test('a link whose target can’t be reached gives `unreadable` when a mapping serves its path or a path under it', async () => {
    const dir = fixtureBuild({ 'public/index.html': '', 'public/app.js': 'window.open = h', 'server/main.js': '' })
    writeOutside(join(dir, '../private'), {
      'assets/chunk.js': 'window.fetch = f',
      'vendor.js': 'window.print = p',
      'render.js': 'globalThis.fetch = f',
    })
    symlinkSync('../../private/assets', join(dir, 'public/assets'))
    symlinkSync('../../private/vendor.js', join(dir, 'public/vendor.js'))
    symlinkSync('../../private/render.js', join(dir, 'server/render.js'))

    // The target's directory can't be searched, so the sweep can't tell a file from a directory (EACCES).
    const report = await scanLocked(dir, ['../private'], ['--map', 'https://app.example/=public', ...publicEntry])

    const unreachable = "the sweep can't reach the link's target: EACCES"
    expect(report.completeness.limitations).toEqual([
      { kind: 'unreadable', artifact: { path: 'public/assets' }, detail: unreachable },
      { kind: 'unreadable', artifact: { path: 'public/vendor.js' }, detail: unreachable },
    ])
    expect(report.completeness.level).toBe('incomplete')
    expect(report.artifacts.map(({ path }: Json) => path)).toEqual(['public/app.js'])
  })

  test('a link whose target can’t be reached gives `unreadable` when a mapping serves only its own path', async () => {
    const dir = fixtureBuild({ 'public/index.html': '', 'public/app.js': 'window.open = h', 'cdn/notes.txt': '' })
    writeOutside(join(dir, '../private'), { 'vendor.js': 'window.fetch = f' })
    symlinkSync('../../private/vendor.js', join(dir, 'public/vendor.js'))

    // `https://app.example/vendor.js` reads `public/vendor.js`, but a longer prefix reads every URL under it from `cdn`.
    const report = await scanLocked(dir, ['../private'], [
      ...['--map', 'https://app.example/=public', '--map', 'https://app.example/vendor.js/=cdn'],
      ...publicEntry,
    ])

    expect(report.completeness.limitations).toEqual([
      { kind: 'unreadable', artifact: { path: 'public/vendor.js' }, detail: "the sweep can't reach the link's target: EACCES" },
    ])
    expect(report.completeness.level).toBe('incomplete')
  })

  test('whose every URL a longer prefix reads from elsewhere gives no record: no mapping serves a path under it', async () => {
    const dir = fixtureBuild({ 'index.html': '', 'static/old.js': 'window.fetch = f', 'cdn/new.js': 'window.open = h' })

    const report = await scanLocked(dir, ['static'], [
      ...['--map', 'https://app.example/=.', '--map', 'https://app.example/static/=cdn'],
    ])

    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.level).toBe('complete')
    expect(report.artifacts.map(({ url }: Json) => url)).toEqual(['https://app.example/static/new.js'])
  })
})

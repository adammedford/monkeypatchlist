// Source-map directories (§2 Source maps, §13 `unreadable`, `source-maps-unpaired` and the attribution
// block). Every test runs end to end through `monkeypatchlist scan --json`, with `--source-maps <dir>` relative to the working
// directory, which holds the build directory (`build/`) and the declared directories.

import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import { defaultMap, runCli, scanBuild, workingDir, type CliOptions } from './support/fixture-build.ts'
import { code, codeMap, rebuilt, sourceMap } from './support/source-map.ts'

const id = '85314830-023f-4cf1-a267-535f4e37bb17'
/**
 * Code with the same tokens as `code` that writes nothing, for fetched artifacts: their findings would need remote
 * attribution keys (§11), which other tests cover.
 */
const remoteCode = 'window.fetch + f'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** Whether the file system that holds scratch directories ignores case in names, as macOS's APFS does by default. */
function caseInsensitive(): boolean {
  const cwd = workingDir({ probe: '' })
  return existsSync(join(cwd, 'PROBE'))
}

/**
 * Scans the build `build` with each of `dirs` declared by `--source-maps <name>`, in the order given, plus `args`. The
 * working directory holds the build at `build/` and each declared directory at its name.
 */
async function scanWithMaps(
  build: Record<string, string>,
  dirs: Record<string, Record<string, string>>,
  args: string[] = [],
  options: Omit<CliOptions, 'cwd'> = {},
) {
  const files: Record<string, string> = {}
  for (const [path, text] of Object.entries(build)) files[`build/${path}`] = text
  for (const [dir, maps] of Object.entries(dirs)) {
    for (const [path, text] of Object.entries(maps)) files[`${dir}/${path}`] = text
  }
  const cwd = workingDir(files)
  const declared = Object.keys(dirs).flatMap((dir) => ['--source-maps', dir])
  return scanBuild(join(cwd, 'build'), [...declared, ...args], { ...options, cwd })
}

describe('pairing with a source-map directory (§2 Source maps)', () => {
  test('a mirrored sidecar, `<dir>/<build-relative path>.map`, pairs a local-build artifact', async () => {
    const { report } = await scanWithMaps(
      { 'index.html': '<script src="js/main.js"></script>', 'js/main.js': code },
      { maps: { 'js/main.js.map': codeMap() } },
    )

    expect(report.artifacts[0].sourceMap).toEqual({
      method: 'external-sidecar',
      path: 'maps/js/main.js.map',
      status: 'verified',
    })
  })

  test("a mirrored annotation pairs a local-build artifact: its URL, through the URL→path mapping, in the directory", async () => {
    const { report } = await scanWithMaps(
      {
        'index.html': '<script src="/assets/app.js"></script>',
        // The build keeps the annotation, and its map was stripped after upload.
        'static/app.js': `${code}\n//# sourceMappingURL=maps/app.js.map?v=2`,
      },
      // `https://app.example/assets/maps/app.js.map` is `static/maps/app.js.map` in the build.
      { maps: { 'static/maps/app.js.map': codeMap() } },
      ['--map', 'https://app.example/=.', '--map', 'https://app.example/assets/=static'],
    )

    expect(report.artifacts[0]).toMatchObject({
      url: 'https://app.example/assets/app.js',
      sourceMap: { method: 'external-annotation', path: 'maps/static/maps/app.js.map', status: 'verified' },
    })
  })

  test('a `debugId` pairs any artifact, remote and inline ones included, whatever the map is called', async () => {
    const fetcher = fixtureFetcher({
      'https://cdn.example/lib.js': {
        headers: { 'content-type': 'text/javascript' },
        body: `${remoteCode}\n//# debugId=${id.replace('8', '1')}`,
      },
    })
    const { report } = await scanWithMaps(
      {
        'index.html': [
          '<script src="main.js"></script>',
          '<script src="https://cdn.example/lib.js"></script>',
          `<script>${code};\n//# debugId=${id.replace('8', '2')}</script>`,
        ].join(''),
        'main.js': `${code}\n//# debugId=${id}`,
      },
      {
        maps: {
          'uploaded/3f2a.map': codeMap({ debugId: id.toUpperCase() }),
          'uploaded/lib.MAP': codeMap({ debugId: id.replace('8', '1') }),
          'deep/er/inline.map': codeMap({ debugId: id.replace('8', '2') }),
        },
      },
      ['--mode', 'resolve'],
      { deps: { resolveFetcher: () => fetcher } },
    )

    expect(report.artifacts.map(({ url, sourceMap }: Json) => [url, sourceMap.method, sourceMap.path])).toEqual([
      ['https://app.example/#inline-1', 'external-debug-id', 'maps/deep/er/inline.map'],
      ['https://app.example/main.js', 'external-debug-id', 'maps/uploaded/3f2a.map'],
      ['https://cdn.example/lib.js', 'external-debug-id', 'maps/uploaded/lib.MAP'],
    ])
    expect(report.completeness.attribution.artifacts).toEqual({ withMap: 3, withoutMap: 0, withBrokenMap: 0 })
  })

  test("a remote artifact's unread header map stays counted when a directory's `debugId` map pairs it (§17)", async () => {
    const fetcher = fixtureFetcher({
      'https://cdn.example/lib.js': {
        headers: { 'content-type': 'text/javascript', SourceMap: 'lib.js.map' },
        body: `${remoteCode}\n//# debugId=${id}`,
      },
      'https://cdn.example/lib.js.map': { status: 404 },
    })
    const { report } = await scanWithMaps(
      { 'index.html': '<script src="https://cdn.example/lib.js"></script>' },
      { maps: { 'uploaded/lib.map': codeMap({ debugId: id }) } },
      ['--mode', 'resolve'],
      { deps: { resolveFetcher: () => fetcher } },
    )

    expect(report.artifacts[0].sourceMap).toEqual({
      method: 'external-debug-id',
      path: 'maps/uploaded/lib.map',
      status: 'verified',
    })
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.attribution.unreadMaps).toEqual({ refused: 0, failed: 1, unreadable: 0 })
  })

  test("a map that matches only by basename, or by its `file` field, is not paired", async () => {
    const { report } = await scanWithMaps(
      { 'index.html': '<script src="js/main.js"></script>', 'js/main.js': `${code}\n//# sourceMappingURL=main.js.map` },
      {
        maps: {
          // The artifact's basename, but not its build-relative path.
          'main.js.map': codeMap(),
          'other/js/main.js.map': codeMap(),
          // Its `file` field names the artifact.
          'bundle.map': codeMap({ file: 'js/main.js' }),
        },
      },
    )

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: null, status: 'none' })
    expect(report.completeness.limitations.map(({ kind }: Json) => kind)).toEqual(['source-maps-unpaired'])
  })

  test('a remote artifact pairs only by `debugId`: its annotation and its path are mirrored nowhere', async () => {
    const fetcher = fixtureFetcher({
      'https://app.example/remote/lib.js': {
        headers: { 'content-type': 'text/javascript' },
        // The annotation names a URL a mapping serves, `lib.js.map` in the build.
        body: `${remoteCode}\n//# sourceMappingURL=/static/lib.js.map`,
      },
    })
    const { report } = await scanWithMaps(
      { 'index.html': '<script src="/remote/lib.js"></script>' },
      { maps: { 'lib.js.map': codeMap(), 'remote/lib.js.map': codeMap() } },
      // No mapping serves `/remote/`, so the script is fetched.
      ['--map', 'https://app.example/static/=.', '--entry', 'index.html@https://app.example/', '--mode', 'resolve'],
      { deps: { resolveFetcher: () => fetcher } },
    )

    expect(report.artifacts[0]).toMatchObject({
      origin: 'same-origin',
      retrieval: { status: 'ok' },
      sourceMap: { method: 'none', path: null, status: 'none' },
    })
  })

  test('a candidate that fails verification is `stale`, and the next method is tried', async () => {
    const { report } = await scanWithMaps(
      {
        'index.html': '<script src="main.js"></script><script src="old.js"></script>',
        'main.js': `${rebuilt}\n//# debugId=${id}`,
        'old.js': rebuilt,
      },
      {
        maps: {
          // The `debugId`'s map is an earlier build's, and the mirrored sidecar is this one's.
          'uploaded/a.map': codeMap({ debugId: id }),
          'main.js.map': sourceMap([[[0, 0, 0, 0], [6, 0, 0, 6], [19, 0, 0, 19]]]),
          'old.js.map': codeMap(),
        },
      },
    )

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'external-sidecar', path: 'maps/main.js.map', status: 'verified' },
      { method: 'none', path: 'maps/old.js.map', status: 'stale' },
    ])
    expect(report.completeness.attribution).toMatchObject({
      artifacts: { withMap: 1, withoutMap: 0, withBrokenMap: 1 },
      staleCandidates: 2,
    })
  })
})

describe("attribution through a directory's map (§10)", () => {
  /** A map of `code` whose one source is `source`, with `content` as its `sourcesContent`. */
  const packageMap = (source: string, content: string | null, fields: Record<string, unknown> = {}) =>
    JSON.stringify({ ...JSON.parse(codeMap(fields)), sources: [source], sourcesContent: [content] })

  test('a finding keys the package its external map names, capped where a mirrored sidecar is not token-verified', async () => {
    const { report } = await scanWithMaps(
      {
        'index.html': '<script src="a.js"></script><script src="b.js"></script>',
        'a.js': `${code}\n//# debugId=${id}`,
        'b.js': code.replace('fetch', 'close'),
      },
      {
        maps: {
          'uploaded/a.map': packageMap('webpack://app/./node_modules/otel-fetch/index.js', code, { debugId: id }),
          // Without `sourcesContent`, the token check doesn't apply.
          'b.js.map': packageMap('webpack://app/./node_modules/closer/index.js', null),
        },
      },
    )

    const attributed = report.findings.map(({ target, attribution, confidence }: Json) => [
      target.name,
      attribution.key,
      confidence.attribution,
    ])
    expect(attributed).toEqual([
      ['Window.close', 'pkg:closer', { level: 'medium', reasons: ['token-check-n/a', 'sidecar-not-token-verified'] }],
      ['Window.fetch', 'pkg:otel-fetch', { level: 'high', reasons: [] }],
    ])
  })
})

describe('completeness (§2 Source maps, §13)', () => {
  const build = { 'index.html': '<script src="main.js"></script>', 'main.js': code }

  test('a declared directory that is missing gives `unreadable`, and the scan is `incomplete`', async () => {
    const { report } = await scanWithMaps(build, { maps: { 'main.js.map': codeMap() }, missing: {} })

    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.limitations).toEqual([
      { kind: 'unreadable', artifact: { path: 'missing' }, detail: expect.stringContaining('ENOENT') },
    ])
    // The other directory still pairs.
    expect(report.artifacts[0].sourceMap.method).toBe('external-sidecar')
    // The script was read and analyzed.
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 1, analyzed: 1 })
  })

  test.each<[string, (cwd: string) => void, string]>([
    ['a file', (cwd) => writeFileSync(join(cwd, 'maps'), codeMap()), 'ENOTDIR'],
    ["a directory that can't be listed", (cwd) => mkdirSync(join(cwd, 'maps'), { mode: 0o000 }), 'EACCES'],
    ['a dangling link', (cwd) => symlinkSync('gone', join(cwd, 'maps')), 'ENOENT'],
  ])('a declared directory that is %s gives `unreadable`', async (_, prepare, code) => {
    const cwd = workingDir({ 'build/index.html': '<script src="main.js"></script>', 'build/main.js': 'window.x = 1' })
    prepare(cwd)
    try {
      const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'maps'], { cwd })

      expect(report.completeness.level).toBe('incomplete')
      expect(report.completeness.limitations).toEqual([
        { kind: 'unreadable', artifact: { path: 'maps' }, detail: expect.stringContaining(code) },
      ])
    } finally {
      // So that the scratch directory can be removed.
      if (lstatSync(join(cwd, 'maps')).isDirectory()) chmodSync(join(cwd, 'maps'), 0o755)
    }
  })

  test('a readable directory that pairs with nothing gives `source-maps-unpaired`, and the scan is `incomplete`', async () => {
    const { report } = await scanWithMaps(build, {
      maps: { 'other.js.map': codeMap(), 'main.js.map': codeMap({ version: 2 }) },
    })

    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.limitations).toEqual([
      { kind: 'source-maps-unpaired', artifact: { path: 'maps' }, detail: expect.any(String) },
    ])
    expect(report.artifacts[0].sourceMap).toEqual({ method: 'none', path: 'maps/main.js.map', status: 'stale' })
  })

  test('an empty directory pairs with nothing, and gives `source-maps-unpaired`', async () => {
    const cwd = workingDir({ 'build/index.html': '<script src="main.js"></script>', 'build/main.js': code })
    mkdirSync(join(cwd, 'maps'))
    const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'maps'], { cwd })

    expect(report.completeness.limitations.map(({ kind }: Json) => kind)).toEqual(['source-maps-unpaired'])
  })

  test('a directory where any map pairs is not unpaired, and partial pairing is only counted', async () => {
    const { report } = await scanWithMaps(
      { ...build, 'index.html': '<script src="main.js"></script><script src="bare.js"></script>', 'bare.js': code },
      { maps: { 'main.js.map': codeMap(), 'orphan.js.map': codeMap() } },
    )

    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.attribution.artifacts).toEqual({ withMap: 1, withoutMap: 1, withBrokenMap: 0 })
  })

  test('without a declared directory, nothing is unpaired', async () => {
    const { report } = await scanBuild(build)

    expect(report.completeness.level).toBe('complete')
    expect(report.config.sourceMaps).toEqual([])
    expect(report.completeness.attribution.sourceMapDirectories).toEqual([])
  })
})

describe('the order of pairing (§2 Source maps)', () => {
  test("the build directory's methods come first, then each directory in declared order", async () => {
    const { report } = await scanWithMaps(
      {
        'index.html': ['a', 'b', 'c'].map((name) => `<script src="${name}.js"></script>`).join(''),
        // In the build.
        'a.js': code,
        'a.js.map': codeMap(),
        'b.js': `${code};`,
        'c.js': `${code};;`,
      },
      {
        first: { 'a.js.map': codeMap(), 'b.js.map': codeMap() },
        second: { 'b.js.map': codeMap(), 'c.js.map': codeMap() },
      },
    )

    expect(report.config.sourceMaps).toEqual(['first', 'second'])
    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'sidecar', path: 'a.js.map', status: 'verified' },
      { method: 'external-sidecar', path: 'first/b.js.map', status: 'verified' },
      { method: 'external-sidecar', path: 'second/c.js.map', status: 'verified' },
    ])
    // Each directory's maps verified against an artifact, even where an earlier map had already paired it.
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.attribution.sourceMapDirectories.map(({ path, paired }: Json) => [path, paired])).toEqual([
      ['first', 2],
      ['second', 2],
    ])
  })

  test('the flag order decides, whatever order the config file gives', async () => {
    const cwd = workingDir({
      'build/index.html': '<script src="main.js"></script>',
      'build/main.js': code,
      'z/main.js.map': codeMap(),
      'a/main.js.map': codeMap(),
      'monkeypatchlist.config.json': JSON.stringify({ sourceMaps: ['a', 'z'] }),
    })
    const byFlags = await scanBuild(join(cwd, 'build'), ['--source-maps', 'z', '--source-maps', 'a'], { cwd })
    const byConfig = await scanBuild(join(cwd, 'build'), [], { cwd })

    expect(byFlags.report.config.sourceMaps).toEqual(['z', 'a'])
    expect(byFlags.report.artifacts[0].sourceMap.path).toBe('z/main.js.map')
    expect(byConfig.report.config.sourceMaps).toEqual(['a', 'z'])
    expect(byConfig.report.artifacts[0].sourceMap.path).toBe('a/main.js.map')
  })

  test('within a directory: `debugId`, mirrored annotation, then mirrored sidecar; one `debugId` in path order', async () => {
    const { report } = await scanWithMaps(
      {
        'index.html': ['a', 'b', 'c'].map((name) => `<script src="${name}.js"></script>`).join(''),
        'a.js': `${code}\n//# sourceMappingURL=maps/a.js.map\n//# debugId=${id}`,
        'b.js': `${code};\n//# sourceMappingURL=maps/b.js.map`,
        'c.js': `${code};;\n//# debugId=${id.replace('8', '9')}`,
      },
      {
        maps: {
          'x/by-id.map': codeMap({ debugId: id }),
          'maps/a.js.map': codeMap(),
          'a.js.map': codeMap(),
          'maps/b.js.map': codeMap(),
          'b.js.map': codeMap(),
          // Two maps carry `c.js`'s debug ID: the first in path order fails, and the next verifies.
          'y/1.map': codeMap({ debugId: id.replace('8', '9'), version: 2 }),
          'y/2.map': codeMap({ debugId: id.replace('8', '9') }),
          'y/3.map': codeMap({ debugId: id.replace('8', '9') }),
        },
      },
    )

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'external-debug-id', path: 'maps/x/by-id.map', status: 'verified' },
      { method: 'external-annotation', path: 'maps/maps/b.js.map', status: 'verified' },
      { method: 'external-debug-id', path: 'maps/y/2.map', status: 'verified' },
    ])
    expect(report.completeness.attribution.staleCandidates).toBe(1)
  })

  test('a directory nested in the build directory, whose maps the build already paired, is not unpaired', async () => {
    const cwd = workingDir({
      'build/index.html': '<script src="main.js"></script>',
      'build/main.js': `${code}\n//# sourceMappingURL=maps/main.js.map`,
      'build/maps/main.js.map': codeMap(),
    })
    const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'build/maps'], { cwd })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'annotation', path: 'maps/main.js.map', status: 'verified' })
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.attribution.pairings).toMatchObject({ annotation: 1, 'external-annotation': 0 })
    expect(report.completeness.attribution.sourceMapDirectories).toEqual([
      { path: 'build/maps', found: 1, paired: 1, stale: 0, orphaned: 0, orphanedMaps: [] },
    ])
  })
})

describe('the attribution block (§13)', () => {
  test('counts each directory\'s maps found, paired, `stale` and orphaned, and lists the orphaned ones', async () => {
    const { report } = await scanWithMaps(
      {
        'index.html': ['a', 'b', 'c'].map((name) => `<script src="js/${name}.js"></script>`).join(''),
        'js/a.js': code,
        'js/b.js': rebuilt,
        'js/c.js': `${code};\n//# sourceMappingURL=c.js.map.json`,
      },
      {
        maps: {
          'js/a.js.map': codeMap(),
          // An earlier build's map: stale, and orphaned.
          'js/b.js.map': codeMap(),
          // Named by the annotation, whatever its name.
          'js/c.js.map.json': codeMap(),
          // Named by no method.
          'js/z.js.MAP': codeMap(),
          'old/a.js.map': codeMap(),
          // Not a map.
          'README.md': '# maps',
        },
        empty: { 'README.md': '# no maps' },
      },
    )

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap.method)).toEqual([
      'external-sidecar',
      'none',
      'external-annotation',
    ])
    expect(report.completeness.attribution.sourceMapDirectories).toEqual([
      {
        path: 'maps',
        found: 5,
        paired: 2,
        stale: 1,
        orphaned: 3,
        orphanedMaps: ['js/b.js.map', 'js/z.js.MAP', 'old/a.js.map'],
      },
      { path: 'empty', found: 0, paired: 0, stale: 0, orphaned: 0, orphanedMaps: [] },
    ])
    expect(report.completeness.attribution.pairings).toMatchObject({
      'external-debug-id': 0,
      'external-annotation': 1,
      'external-sidecar': 1,
    })
  })

  test('a map verified only to count it is paired, and one that failed then is `stale`', async () => {
    const { report } = await scanWithMaps(
      {
        'index.html': '<script src="a.js"></script><script src="b.js"></script>',
        'a.js': `${code}\n//# sourceMappingURL=a.js.map`,
        'a.js.map': codeMap(),
        'b.js': `${rebuilt}\n//# sourceMappingURL=b.js.map`,
        'b.js.map': sourceMap([[[0, 0, 0, 0], [6, 0, 0, 6], [19, 0, 0, 19]]]),
      },
      { maps: { 'a.js.map': codeMap(), 'b.js.map': codeMap() } },
    )

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap.method)).toEqual(['annotation', 'annotation'])
    // Only candidates tried while an artifact was being paired count against it.
    expect(report.completeness.attribution.staleCandidates).toBe(0)
    expect(report.completeness.attribution.sourceMapDirectories).toEqual([
      { path: 'maps', found: 2, paired: 1, stale: 1, orphaned: 1, orphanedMaps: ['b.js.map'] },
    ])
  })
})

describe("listing a directory: the sweep's link rules (§2 Source maps)", () => {
  test('links to files and to directories are followed, and a link cycle is listed once', async () => {
    const cwd = workingDir({
      'build/index.html': '<script src="js/a.js"></script><script src="js/b.js"></script>',
      'build/js/a.js': code,
      'build/js/b.js': `${code};`,
      'shared/js/a.js.map': codeMap(),
      'elsewhere/b.map': codeMap(),
    })
    mkdirSync(join(cwd, 'maps'))
    // `maps/js` leads to a directory, and `maps/js/b.js.map` to a file, outside the declared directory.
    symlinkSync('../shared/js', join(cwd, 'maps/js'))
    symlinkSync('../../elsewhere/b.map', join(cwd, 'shared/js/b.js.map'))
    symlinkSync('..', join(cwd, 'shared/js/loop'))
    const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'maps'], { cwd })

    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'external-sidecar', path: 'maps/js/a.js.map', status: 'verified' },
      { method: 'external-sidecar', path: 'maps/js/b.js.map', status: 'verified' },
    ])
    expect(report.completeness.attribution.sourceMapDirectories[0]).toMatchObject({ found: 2, paired: 2 })
  })

  test("a dangling link, an unlistable subdirectory or an unreachable target gives no record, and no pairing", async () => {
    const cwd = workingDir({
      'build/index.html': ['js/a.js', 'lib/b.js', 'js/c.js', 'js/d.js']
        .map((src) => `<script src="${src}"></script>`)
        .join(''),
      'build/js/a.js': code,
      'build/lib/b.js': `${code};`,
      'build/js/c.js': `${code};;`,
      'build/js/d.js': `${code};;;`,
      'maps/js/a.js.map': codeMap(),
      // Its directory can be searched but not listed, so the map could be read, but the listing lacks it.
      'maps/lib/b.js.map': codeMap(),
      'hidden/c.js.map': codeMap(),
    })
    symlinkSync('../../hidden/c.js.map', join(cwd, 'maps/js/c.js.map'))
    symlinkSync('gone.map', join(cwd, 'maps/js/d.js.map'))
    chmodSync(join(cwd, 'maps/lib'), 0o100)
    chmodSync(join(cwd, 'hidden'), 0o000)
    try {
      const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'maps'], { cwd })

      expect(report.artifacts.map(({ url, sourceMap }: Json) => [url, sourceMap.method])).toEqual([
        ['https://app.example/js/a.js', 'external-sidecar'],
        ['https://app.example/js/c.js', 'none'],
        ['https://app.example/js/d.js', 'none'],
        ['https://app.example/lib/b.js', 'none'],
      ])
      expect(report.completeness.level).toBe('complete')
      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.attribution.sourceMapDirectories[0]).toMatchObject({ found: 1, paired: 1 })
    } finally {
      chmodSync(join(cwd, 'maps/lib'), 0o755)
      chmodSync(join(cwd, 'hidden'), 0o755)
    }
  })
})

describe("a mirrored map that exists but can't be read (§2 Source maps, §13 `unreadable`)", () => {
  test("a mirrored map the listing holds that can't be read gives `unreadable`, and the next method is tried", async () => {
    const cwd = workingDir({
      'build/index.html': '<script src="a.js"></script><script src="b.js"></script>',
      'build/a.js': code,
      'build/b.js': `${code};\n//# sourceMappingURL=maps/b.js.map`,
      'maps/a.js.map': codeMap(),
      'maps/maps/b.js.map': codeMap(),
      'maps/b.js.map': codeMap(),
    })
    chmodSync(join(cwd, 'maps/a.js.map'), 0o000)
    chmodSync(join(cwd, 'maps/maps/b.js.map'), 0o000)
    const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'maps'], { cwd })

    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.limitations).toEqual([
      { kind: 'unreadable', artifact: { path: 'maps/a.js.map' }, detail: expect.stringContaining('EACCES') },
      { kind: 'unreadable', artifact: { path: 'maps/maps/b.js.map' }, detail: expect.stringContaining('EACCES') },
    ])
    expect(report.artifacts.map(({ sourceMap }: Json) => sourceMap)).toEqual([
      { method: 'none', path: null, status: 'none' },
      { method: 'external-sidecar', path: 'maps/b.js.map', status: 'verified' },
    ])
    // The scripts were read and analyzed.
    expect(report.completeness.counters.artifacts.failed.unreadable).toBe(0)
    expect(report.completeness.attribution.sourceMapDirectories[0]).toMatchObject({
      found: 3,
      paired: 1,
      orphanedMaps: ['a.js.map', 'maps/b.js.map'],
    })
  })

  test('a mirrored map named through a loop link is the listed file: it pairs, or is `unreadable`, by its listed path', async () => {
    const build = {
      'build/index.html': '<script src="main.js"></script>',
      // The listing stops at `self`, a loop, but `self/app.map` is the same file as `app.map`.
      'build/main.js': `${code}\n//# sourceMappingURL=self/app.map`,
    }
    const readable = workingDir({ ...build, 'maps/app.map': codeMap() })
    const locked = workingDir({ ...build, 'maps/app.map': codeMap() })
    for (const cwd of [readable, locked]) symlinkSync('.', join(cwd, 'maps/self'))
    chmodSync(join(locked, 'maps/app.map'), 0o000)
    const pairs = await scanBuild(join(readable, 'build'), ['--source-maps', 'maps'], { cwd: readable })
    const fails = await scanBuild(join(locked, 'build'), ['--source-maps', 'maps'], { cwd: locked })

    expect(pairs.report.artifacts[0].sourceMap).toEqual({
      method: 'external-annotation',
      path: 'maps/app.map',
      status: 'verified',
    })
    expect(pairs.report.completeness.attribution.sourceMapDirectories[0]).toMatchObject({ found: 1, paired: 1 })
    expect(pairs.report.completeness.level).toBe('complete')
    expect(fails.report.completeness.limitations).toEqual([
      { kind: 'source-maps-unpaired', artifact: { path: 'maps' }, detail: expect.any(String) },
      { kind: 'unreadable', artifact: { path: 'maps/app.map' }, detail: expect.stringContaining('EACCES') },
    ])
  })

  test.runIf(caseInsensitive())(
    'on a case-insensitive file system, a mirrored map named in another case is the listed file',
    async () => {
      const { report } = await scanWithMaps(
        { 'index.html': '<script src="main.js"></script>', 'main.js': `${code}\n//# sourceMappingURL=App.map` },
        { maps: { 'app.map': codeMap() } },
      )

      expect(report.artifacts[0].sourceMap).toEqual({
        method: 'external-annotation',
        path: 'maps/app.map',
        status: 'verified',
      })
      expect(report.completeness.attribution.sourceMapDirectories[0]).toMatchObject({ found: 1, paired: 1 })
    },
  )

  test('a trailing `/` names only a directory: a listed file named so gives nothing, and a directory `unreadable`', async () => {
    const cwd = workingDir({
      'build/index.html': '<script src="a.js"></script><script src="b.js"></script>',
      'build/a.js': `${code}\n//# sourceMappingURL=a.map/`,
      'build/b.js': `${code};\n//# sourceMappingURL=b.map/`,
      'maps/a.map': codeMap(),
      'maps/other.map': codeMap(),
    })
    mkdirSync(join(cwd, 'maps/b.map'))
    const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'maps'], { cwd })

    expect(report.completeness.limitations).toEqual([
      { kind: 'source-maps-unpaired', artifact: { path: 'maps' }, detail: expect.any(String) },
      { kind: 'unreadable', artifact: { path: 'maps/b.map' }, detail: expect.stringContaining('EISDIR') },
    ])
  })

  test('a mirrored map the listing lacks gives no record', async () => {
    const { report } = await scanWithMaps(
      { 'index.html': '<script src="main.js"></script>', 'main.js': `${code}\n//# sourceMappingURL=main.js.map` },
      { maps: { 'other.js.map': codeMap() } },
    )

    expect(report.completeness.limitations.map(({ kind }: Json) => kind)).toEqual(['source-maps-unpaired'])
  })

  test("a directory at a mirrored map's path can't be read either", async () => {
    const cwd = workingDir({
      'build/index.html': '<script src="main.js"></script>',
      'build/main.js': code,
      'maps/other.js.map': codeMap(),
    })
    mkdirSync(join(cwd, 'maps/main.js.map'))
    const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'maps'], { cwd })

    expect(report.completeness.limitations).toEqual([
      { kind: 'source-maps-unpaired', artifact: { path: 'maps' }, detail: expect.any(String) },
      { kind: 'unreadable', artifact: { path: 'maps/main.js.map' }, detail: expect.stringContaining('EISDIR') },
    ])
  })

  test("a directory at a mirrored map's path that the listing can't list gives no record, as in the build directory", async () => {
    const cwd = workingDir({
      'build/index.html': '<script src="js/main.js"></script><script src="js/other.js"></script>',
      'build/js/main.js': code,
      'build/js/other.js': `${code};`,
      'maps/js/other.js.map': codeMap(),
    })
    mkdirSync(join(cwd, 'maps/js/main.js.map'), { recursive: true })
    chmodSync(join(cwd, 'maps/js/main.js.map'), 0o000)
    try {
      const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'maps'], { cwd })

      expect(report.artifacts.map(({ url, sourceMap }: Json) => [url, sourceMap.method])).toEqual([
        ['https://app.example/js/main.js', 'none'],
        ['https://app.example/js/other.js', 'external-sidecar'],
      ])
      expect(report.completeness.attribution.artifacts).toEqual({ withMap: 1, withoutMap: 1, withBrokenMap: 0 })
      expect(report.completeness.limitations).toEqual([])
      expect(report.completeness.level).toBe('complete')
    } finally {
      chmodSync(join(cwd, 'maps/js/main.js.map'), 0o755)
    }
  })

  test('an unreadable mirrored map of an artifact an earlier map paired gives no record: it is read only to count', async () => {
    const cwd = workingDir({
      'build/index.html': '<script src="a.js"></script><script src="b.js"></script>',
      'build/a.js': `${code}\n//# sourceMappingURL=a.js.map`,
      'build/a.js.map': codeMap(),
      'build/b.js': `${code};`,
      'maps/a.js.map': codeMap(),
      'maps/b.js.map': codeMap(),
    })
    chmodSync(join(cwd, 'maps/a.js.map'), 0o000)
    const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'maps'], { cwd })

    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
    expect(report.completeness.attribution.sourceMapDirectories[0]).toMatchObject({ found: 2, paired: 1, orphaned: 1 })
  })

  test("an unreadable `.map` that only the `debugId` search meets gives no record", async () => {
    const cwd = workingDir({
      'build/index.html': '<script src="main.js"></script>',
      'build/main.js': `${code}\n//# debugId=${id}`,
      'maps/a.map': codeMap({ debugId: id }),
      'maps/z.map': codeMap({ debugId: id }),
    })
    chmodSync(join(cwd, 'maps/a.map'), 0o000)
    const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'maps'], { cwd })

    expect(report.artifacts[0].sourceMap).toEqual({ method: 'external-debug-id', path: 'maps/z.map', status: 'verified' })
    expect(report.completeness.limitations).toEqual([])
  })
})

describe('declaring directories (§16)', () => {
  const build = { 'build/index.html': '<script src="main.js"></script>', 'build/main.js': code }

  test("the config file's `sourceMaps` are relative to its directory", async () => {
    const cwd = workingDir({
      ...build,
      'config/monkeypatchlist.config.json': JSON.stringify({
        mappings: [{ url: 'https://app.example/', dir: '.' }],
        sourceMaps: ['../maps'],
      }),
      'maps/main.js.map': codeMap(),
    })
    const run = await runCli(['scan', 'build', '--config', 'config/monkeypatchlist.config.json', '--json', '-'], { cwd })
    const report = JSON.parse(run.stdout)

    expect(run.exitCode).toBe(0)
    expect(report.config.sourceMaps).toEqual(['maps'])
    expect(report.artifacts[0].sourceMap).toEqual({
      method: 'external-sidecar',
      path: 'maps/main.js.map',
      status: 'verified',
    })
  })

  test('a directory declared twice is a usage error, by flag or in the config file', async () => {
    const cwd = workingDir({ ...build, 'maps/main.js.map': codeMap() })
    const twice = ['--source-maps', 'maps', '--source-maps', 'maps']
    const byFlags = await runCli(['scan', 'build', '--map', defaultMap, ...twice], { cwd })
    const inConfig = await runCli(['scan', 'build', '--map', defaultMap], {
      cwd: workingDir({ ...build, 'monkeypatchlist.config.json': JSON.stringify({ sourceMaps: ['maps', 'maps'] }) }),
    })
    // Distinct in the file, but one directory relative to it.
    const relative = await runCli(['scan', 'build', '--map', defaultMap], {
      cwd: workingDir({ ...build, 'monkeypatchlist.config.json': JSON.stringify({ sourceMaps: ['maps', './maps'] }) }),
    })

    expect(byFlags.exitCode).toBe(2)
    expect(byFlags.stderr).toContain("--source-maps names 'maps' twice")
    expect(inConfig.exitCode).toBe(2)
    expect(inConfig.stderr).toContain('/sourceMaps')
    expect(relative.exitCode).toBe(2)
    expect(relative.stderr).toContain("/sourceMaps/1: 'maps' is already declared by /sourceMaps/0")
  })

  test('`baseline init` takes source-map directories too, and they are not in the scan-config id', async () => {
    const cwd = workingDir({ ...build, 'maps/main.js.map': codeMap() })
    const init = await runCli(['baseline', 'init', 'build', '--map', defaultMap, '--surface', 'all', '--source-maps', 'maps'], { cwd })
    const { report } = await scanBuild(join(cwd, 'build'), ['--baseline', 'monkeypatchlist.baseline.json'], { cwd })

    expect(init.exitCode).toBe(0)
    // Scanning without the directory compares with the baseline it wrote.
    expect(report.baseline.header.scanConfigId).toBe(report.config.scanConfigId)
    expect(report.summary).toMatchObject({ added: 0, existing: 1 })
  })

  test('a directory is never analyzed as code: its scripts are no artifacts', async () => {
    const { report } = await scanWithMaps(
      { 'index.html': '<script src="main.js"></script>', 'main.js': code },
      { maps: { 'main.js.map': codeMap(), 'tool.js': 'window.fetch = f', 'tool.js.map': codeMap() } },
    )

    expect(report.artifacts.map(({ url }: Json) => url)).toEqual(['https://app.example/main.js'])
    expect(report.findings.map(({ occurrences }: Json) => occurrences.length)).toEqual([1])
  })
})

describe('determinism (§15)', () => {
  test('two scans of the same build and directories give byte-identical reports, except run', async () => {
    const dirs = {
      maps: { 'a.js.map': codeMap(), 'orphan/z.map': codeMap(), 'orphan/a.map': codeMap(), 'b.js.map': codeMap() },
      more: { 'c.map': codeMap({ debugId: id }) },
      missing: {},
    }
    const build = {
      'index.html': ['a', 'b', 'c'].map((name) => `<script src="${name}.js"></script>`).join(''),
      'a.js': code,
      'b.js': rebuilt,
      'c.js': `${code};\n//# debugId=${id}`,
    }

    const first = await scanWithMaps(build, dirs)
    const second = await scanWithMaps(build, dirs)

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
    expect(first.report.completeness.attribution.sourceMapDirectories).toEqual([
      {
        path: 'maps',
        found: 4,
        paired: 1,
        stale: 1,
        orphaned: 3,
        orphanedMaps: ['b.js.map', 'orphan/a.map', 'orphan/z.map'],
      },
      { path: 'more', found: 1, paired: 1, stale: 0, orphaned: 0, orphanedMaps: [] },
      { path: 'missing', found: 0, paired: 0, stale: 0, orphaned: 0, orphanedMaps: [] },
    ])
  })
})

export type { Json }

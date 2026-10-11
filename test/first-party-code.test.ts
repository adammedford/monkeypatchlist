// First-party code (§9 `first-party-inferred` and `ignore-list-demoted`, §10 Provenance and `ignoreList`,
// §11 Attribution keys; ADR 0006).

import { describe, expect, test } from 'vitest'
import { join } from 'node:path'
import { scanBuild, workingDir } from './support/fixture-build.ts'
import { identityMappings, mappings } from './support/source-map.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const code = 'window.fetch = w'

/**
 * A version 3 map whose every token of `code` maps to `sources[at]`, with `sources` all holding `code` as their
 * content, as JSON text.
 */
function mapOf(sources: (string | null)[], at = 0, fields: Record<string, unknown> = {}, text = code): string {
  return JSON.stringify({
    version: 3,
    sources,
    sourcesContent: sources.map(() => text),
    names: [],
    mappings: mappings(identityMappings(text, at)),
    ...fields,
  })
}

/** A build that runs `path`, which is `code`, with the map `map` beside it as `<path>.map`. */
function build(path: string, map: string, more: Record<string, string> = {}): Record<string, string> {
  return { 'index.html': `<script src="${path}"></script>`, [path]: code, [`${path}.map`]: map, ...more }
}

const fetchOf = (report: Json) => {
  const found = report.findings.filter((each: Json) => each.target.name === 'Window.fetch')
  expect(found).toHaveLength(1)
  return found[0]
}

describe('first-party code keys `app:<root-relative original path>` (§11 Attribution keys)', () => {
  test.each([
    ['webpack', 'main.js', ['webpack://app/./src/polyfills.ts', 'webpack://app/./node_modules/x/index.js'], 'high'],
    ['Vite', 'assets/index.js', ['../../src/polyfills.ts', '../../node_modules/x/index.js'], 'medium'],
    ['esbuild', 'main.js', ['../src/polyfills.ts', '../node_modules/x/index.js'], 'medium'],
  ])('%s gives `app:src/polyfills.ts`', async (_, path, sources, level) => {
    const { report } = await scanBuild(build(path, mapOf(sources)))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'app:src/polyfills.ts', provenance: 'first-party' })
    expect(fetch.confidence.attribution.level).toBe(level)
  })
})

describe('in a hoisted monorepo, all three bundlers name the same file the same way (§11 Root-relative paths)', () => {
  test.each([
    ['webpack', 'main.js', 'webpack://web/../../libs/telemetry/src/fetch-wrap.ts', 'webpack://web/../../node_modules/x/index.js'],
    ['Vite', 'assets/index.js', '../../../../libs/telemetry/src/fetch-wrap.ts', '../../../../node_modules/x/index.js'],
    ['esbuild', 'main.js', '../../../libs/telemetry/src/fetch-wrap.ts', '../../../node_modules/x/index.js'],
  ])('%s: `app:libs/telemetry/src/fetch-wrap.ts`, first-party only by root inference (medium)', async (_, path, lib, pkg) => {
    const { report } = await scanBuild(build(path, mapOf([lib, pkg])))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'app:libs/telemetry/src/fetch-wrap.ts', provenance: 'first-party' })
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['first-party-inferred'] })
  })

  test.each([
    ['webpack', 'main.js', 'webpack://web/./src/polyfills.ts', 'webpack://web/../../node_modules/x/index.js'],
    ['Vite', 'assets/index.js', '../../src/polyfills.ts', '../../../../node_modules/x/index.js'],
    ['esbuild', 'main.js', '../src/polyfills.ts', '../../../node_modules/x/index.js'],
  ])('%s: the app\'s own file below the root drops its leading `../`: `app:src/polyfills.ts`', async (_, path, own, pkg) => {
    const { report } = await scanBuild(build(path, mapOf([own, pkg])))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'app:src/polyfills.ts', provenance: 'first-party' })
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['first-party-inferred'] })
  })

  test('a Next-style composed map whose packages sit above the context gives `first-party-inferred`', async () => {
    const sources = ['webpack://_N_E/./app/client.js', 'webpack://_N_E/../../node_modules/react/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources)))

    const fetch = fetchOf(report)
    expect(fetch.attribution.key).toBe('app:app/client.js')
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['first-party-inferred'] })
  })

  test('a root at the webpack context is not inferred: high', async () => {
    const sources = ['webpack://web/./src/polyfills.ts', 'webpack://web/./node_modules/x/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources)))

    expect(fetchOf(report).confidence.attribution).toEqual({ level: 'high', reasons: [] })
  })
})

describe('a workspace package inside the root is first-party (§10 Provenance)', () => {
  test('`packages/telemetry` beside a hoisted `node_modules` keys `app:packages/telemetry/src/wrap.ts`', async () => {
    const sources = ['webpack://app/./packages/telemetry/src/wrap.ts', 'webpack://app/./node_modules/x/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources)))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'app:packages/telemetry/src/wrap.ts', provenance: 'first-party' })
    expect(fetch.confidence.attribution.level).toBe('high')
  })
})

describe('key normalization (§11 Attribution keys)', () => {
  test.each([
    ['a loader prefix and a `?query`', 'webpack://app/./node_modules/babel-loader/lib/index.js!./src/Polyfills.TS?abc'],
    ['a `webpack-internal:///` entry', 'webpack-internal:///./src/Polyfills.TS'],
    ['`turbopack:///[project]/`', 'turbopack:///[project]/src/Polyfills.TS'],
    ['`\\` separators', 'webpack://app/.\\src\\Polyfills.TS'],
  ])('%s: the resource path decides, with case and extension kept', async (_, entry) => {
    const { report } = await scanBuild(build('main.js', mapOf([entry])))

    expect(fetchOf(report).attribution).toEqual({ key: 'app:src/Polyfills.TS', provenance: 'first-party' })
  })

  test('a relative `sourceRoot` is joined before the path is named', async () => {
    const { report } = await scanBuild(build('main.js', mapOf(['polyfills.ts'], 0, { sourceRoot: 'src' })))

    expect(fetchOf(report).attribution.key).toBe('app:src/polyfills.ts')
  })
})

describe('a relative entry resolves against its map\'s build-relative directory, one root per namespace', () => {
  test('Rollup\'s lazy chunk with no package source keys `app:src/lazy.ts`, as it would beside the entry', async () => {
    const lazy = 'window.fetch = w'
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="assets/entry.js"></script>',
      'assets/entry.js': 'import("./chunks/lazy.js")',
      'assets/entry.js.map': mapOf(['../../src/main.ts', '../../node_modules/foo/x.js'], 0, {}, 'import("./chunks/lazy.js")'),
      'assets/chunks/lazy.js': lazy,
      'assets/chunks/lazy.js.map': mapOf(['../../../src/lazy.ts']),
    })

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'app:src/lazy.ts', provenance: 'first-party' })
    expect(fetch.occurrences[0].original.source).toBe('../../../src/lazy.ts')
  })
})

describe('an empty resource path is synthetic (§10 step 1)', () => {
  test.each(['webpack://_N_E/?6505', 'webpack://ns/./?abc'])('`%s`: `unknown` with `no-map`', async (entry) => {
    const sources = [entry, 'webpack://ns/./node_modules/x/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources)))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['no-map'] })
    expect(fetch.occurrences[0].original).toBeNull()
    expect(fetch.occurrences[0].evidence).toEqual({ source: entry })
  })
})

describe('an absolute first-party path is first-party only when an inferred root prefixes it (§10 Source schemes)', () => {
  const own = 'file:///home/ci/work/app/src/polyfills.ts'

  test('with no bundled dependency, `unknown` (low), with the raw source kept', async () => {
    const { report } = await scanBuild(build('main.js', mapOf([own])))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['escaped-source'] })
    expect(fetch.occurrences[0].original.source).toBe(own)
  })

  test('a dependency that makes a root appear moves it to `app:src/polyfills.ts`', async () => {
    const sources = [own, 'file:///home/ci/work/app/node_modules/dep/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources)))

    expect(fetchOf(report).attribution).toEqual({ key: 'app:src/polyfills.ts', provenance: 'first-party' })
  })

  test.each([
    ['an absolute path', '/home/ci/work/app/src/polyfills.ts', '/home/ci/work/app/node_modules/dep/index.js'],
    ['a drive-letter path', 'C:\\work\\app\\src\\polyfills.ts', 'C:\\work\\app\\node_modules\\dep\\index.js'],
    ['a `file://` drive-letter path', 'file:///C:/work/app/src/polyfills.ts', 'file:///C:/work/app/node_modules/dep/index.js'],
  ])('%s is named relative to the root', async (_, path, dep) => {
    const { report } = await scanBuild(build('main.js', mapOf([path, dep])))

    expect(fetchOf(report).attribution.key).toBe('app:src/polyfills.ts')
  })

  test('a path in a global store does not make a root', async () => {
    const store = '/home/ci/.local/share/pnpm/store/v11/links/@/dep/1.0.0/abc/node_modules/dep/index.js'
    const { report } = await scanBuild(build('main.js', mapOf([own, store])))

    expect(fetchOf(report).attribution.key).toBe('unknown')
  })
})

describe('a source outside the inferred root is escaped (§10 Escaped sources)', () => {
  test('`webpack://ns/../x/y.js` outside a root at the context: `unknown`, `escaped-source`', async () => {
    const sources = ['webpack://ns/../other/y.js', 'webpack://ns/./node_modules/x/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources)))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['escaped-source'] })
  })
})

describe('`ignoreList` only demotes (§10)', () => {
  test('a listed first-party source is `unknown` with `ignore-list-demoted` (low)', async () => {
    const sources = ['../src/wrap.ts', '../node_modules/x/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources, 0, { ignoreList: [0, 1] })))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution.reasons).toContain('ignore-list-demoted')
    expect(fetch.confidence.attribution.level).toBe('low')
  })

  test('a listed package source keeps its package', async () => {
    const sources = ['../node_modules/x/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources, 0, { ignoreList: [0] })))

    expect(fetchOf(report).attribution.key).toBe('pkg:x')
  })

  test('`ignoreList: []` decides over `x_google_ignoreList: [3]`: `app:src/wrap.ts` stays first-party', async () => {
    const sources = ['../../node_modules/a/a.js', '../../node_modules/b/b.js', '../../node_modules/c/c.js', '../../src/wrap.ts']
    const fields = { ignoreList: [], x_google_ignoreList: [3] }
    const { report } = await scanBuild(build('assets/main.js', mapOf(sources, 3, fields)))

    expect(fetchOf(report).attribution).toEqual({ key: 'app:src/wrap.ts', provenance: 'first-party' })
  })

  test('with no `ignoreList`, `x_google_ignoreList` demotes', async () => {
    const sources = ['../src/wrap.ts', '../node_modules/x/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources, 0, { x_google_ignoreList: [0] })))

    expect(fetchOf(report).confidence.attribution.reasons).toContain('ignore-list-demoted')
  })
})

test('reports are byte-identical across runs', async () => {
  const files = build('assets/index.js', mapOf(['../../src/polyfills.ts', '../../node_modules/x/index.js']))
  const first = await scanBuild(files)
  const second = await scanBuild(first.dir)
  const strip = (report: Json) => JSON.stringify({ ...report, run: null })

  expect(strip(second.report)).toBe(strip(first.report))
})

describe('relative maps with no package source anywhere take their map directory as the root (§10 Provenance)', () => {
  test('a map at the build root naming `src/app.js` keys `app:src/app.js` (high)', async () => {
    const { report } = await scanBuild(build('main.js', mapOf(['src/app.js'])))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'app:src/app.js', provenance: 'first-party' })
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
  })

  test('`../src/app.js` climbs out of that root: escaped', async () => {
    const { report } = await scanBuild(build('main.js', mapOf(['../src/app.js'])))

    expect(fetchOf(report).confidence.attribution).toEqual({ level: 'low', reasons: ['escaped-source'] })
  })
})

describe('roots with no shared place (§10 Roots with no shared place)', () => {
  test('relative maps in different directories with no package source each take their own directory as root', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="assets/index.js"></script>',
      'assets/index.js': 'import("./chunks/lazy.js")',
      'assets/index.js.map': mapOf(['src/main.ts'], 0, {}, 'import("./chunks/lazy.js")'),
      'assets/chunks/lazy.js': code,
      'assets/chunks/lazy.js.map': mapOf(['src/lazy.ts']),
    })

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'app:src/lazy.ts', provenance: 'first-party' })
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
  })

  test('`vite:` paths are their own namespace, based like webpack: with no package source, `app:src/polyfills.ts` (high)', async () => {
    const { report } = await scanBuild(build('assets/index.js', mapOf(['vite:src/polyfills.ts'])))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'app:src/polyfills.ts', provenance: 'first-party' })
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
  })

  test('a `data:` map resolves its relative entries against its script\'s directory', async () => {
    const map = mapOf(['../../src/polyfills.ts', '../../node_modules/x/index.js'])
    const annotation = `\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(map).toString('base64')}`
    const { report } = await scanBuild({
      'index.html': '<script src="assets/index.js"></script>',
      'assets/index.js': `${code}${annotation}`,
    })

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'app:src/polyfills.ts', provenance: 'first-party' })
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['first-party-inferred'] })
  })

  test('a `debugId`-paired map resolves against its path inside the declared directory, as if it mirrored the build', async () => {
    const id = '85314830-023f-4cf1-a267-535f4e37bb17'
    const map = mapOf(['../../src/polyfills.ts', '../../node_modules/x/index.js'], 0, { debugId: id })
    const cwd = workingDir({
      'build/index.html': '<script src="main.js"></script>',
      'build/main.js': `${code}\n//# debugId=${id}`,
      'maps/assets/uploaded.map': map,
    })
    const { report } = await scanBuild(join(cwd, 'build'), ['--source-maps', 'maps'], { cwd })

    expect(report.artifacts[0].sourceMap.method).toBe('external-debug-id')
    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'app:src/polyfills.ts', provenance: 'first-party' })
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['first-party-inferred'] })
  })

  test('absolute paths under every wrapper share one `absolute` namespace with no base: never `first-party-inferred`', async () => {
    const sources = ['webpack://app//home/ci/work/app/src/polyfills.ts', 'file:///home/ci/work/app/node_modules/dep/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources)))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'app:src/polyfills.ts', provenance: 'first-party' })
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
  })
})

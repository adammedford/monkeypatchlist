// Containing package and the token check (§10 Containing package, Provenance, Token check; §9 Attribution
// confidence; §19 Attribution). Each finding is attributed through its artifact's source map to the package whose file
// holds the code, read from the map's `sources` path alone.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { GeneratedLocation, RawOccurrence } from '../src/packages/analysis/index.ts'
import { loadCatalog } from '../src/catalog.ts'
import { attribute, type MappedArtifact } from '../src/packages/attribution/index.ts'
import { mutationConfidence, targetConfidence } from '../src/packages/confidence/index.ts'
import { defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'
import { identityMappings, mappings, type Segment } from './support/source-map.ts'

/** The catalog's rules: these cases name packages under `node_modules`, so its path rules never apply. */
const rules = loadCatalog()
/** No framework path rules or escape-only shapes, with the catalog's remote URL normalization (§11). */
const noPathRules = { ...rules, frameworkPathRules: {}, escapeOnlyShapes: {} }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** A version 3 source map with one source, `source`, whose content is `content`, as JSON text. */
function sourceMap(
  source: string | null,
  content: string | null,
  lines: Segment[][],
  fields: Record<string, unknown> = {},
): string {
  const map = { version: 3, sources: [source], sourcesContent: [content], names: [], mappings: mappings(lines) }
  return JSON.stringify({ ...map, ...fields })
}

/**
 * A build whose `main.js` is `code`, with a sidecar map that names `source` for every token and holds `code` as its
 * content: a module a bundler copied unchanged.
 */
function mapped(code: string, source: string, fields: Record<string, unknown> = {}): Record<string, string> {
  return {
    'index.html': '<script src="main.js"></script>',
    'main.js': code,
    'main.js.map': sourceMap(source, code, identityMappings(code), fields),
  }
}

const finding = (report: Json, target: string) => {
  const found = report.findings.filter((each: Json) => each.target.name === target)
  expect(found).toHaveLength(1)
  return found[0]
}

describe('the containing package (§10)', () => {
  test('a write in a package file keys `pkg:<name>`, with provenance `bundled-dependency` and its original location', async () => {
    const { report } = await scanBuild(mapped('window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js'))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|pkg:otel-fetch')
    expect(fetch.attribution).toEqual({ key: 'pkg:otel-fetch', provenance: 'bundled-dependency', package: 'otel-fetch' })
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
    const [occurrence] = fetch.occurrences
    // The lookup point is the member token `fetch`, at column 7.
    expect(occurrence.original).toEqual({ source: 'webpack://app/./node_modules/otel-fetch/index.js', line: 1, column: 7 })
    expect(occurrence.trace.at(-1)).toMatchObject({
      kind: 'token-check',
      result: 'passed',
      token: 'fetch',
      candidate: { source: 'webpack://app/./node_modules/otel-fetch/index.js', line: 1, column: 7 },
    })
  })

  // The raw `sources` entry is normalized before the package is read (§10 step 1).
  test.each([
    ['a webpack namespace and `?hash`', 'webpack://app/./node_modules/x/index.js?5f3c'],
    ['`*` suffixes', 'webpack://app/./node_modules/x/index.js**'],
    ['a `?query` that names a loader', 'webpack:///./node_modules/x/index.js?./node_modules/babel-loader/lib'],
    ['`webpack-internal:///`', 'webpack-internal:///(app-pages-browser)/./node_modules/x/index.js'],
    ['`turbopack:///[project]/`', 'turbopack:///[project]/node_modules/x/index.js'],
    ['`vite:`', 'vite:/node_modules/x/index.js'],
    ['`file://`', 'file:///home/dev/app/node_modules/x/index.js'],
    ['an absolute path', '/home/dev/app/node_modules/x/index.js'],
    ['a drive letter and backslashes', 'C:\\app\\node_modules\\x\\index.js'],
    ['a relative path', '../../node_modules/x/index.js'],
    ['a BOM', '\ufeffwebpack://app/./node_modules/x/index.js'],
    ["a `)]}'` prefix", ")]}'webpack://app/./node_modules/x/index.js"],
    ['percent-encoding', 'node_modules/x/%69ndex.js'],
  ])('%s is stripped: `pkg:x`', async (_, source) => {
    const { report } = await scanBuild(mapped('window.fetch = w', source))

    expect(finding(report, 'Window.fetch').attribution).toEqual({ key: 'pkg:x', provenance: 'bundled-dependency', package: 'x' })
  })

  test('loader prefixes are stripped, so the resource path decides', async () => {
    const { report } = await scanBuild(
      mapped('window.fetch = w', 'webpack://app/./node_modules/babel-loader/lib/index.js!./src/polyfills.js'),
    )

    // `src/polyfills.js` names no package. It is first-party code.
    expect(finding(report, 'Window.fetch').attribution).toEqual({ key: 'app:src/polyfills.js', provenance: 'first-party' })
  })

  // A synthetic or bundler-runtime source counts as unmapped, and its raw source is kept as evidence (§10).
  test.each([
    ['webpack/runtime/define property getters'],
    ['webpack:///webpack/runtime/make namespace object'],
    ['webpack:///webpack/bootstrap'],
    ['<anon>'],
    ['\u0000commonjsHelpers.js'],
    ['turbopack:///[turbopack]/browser/runtime/base/runtime-base.ts'],
    ['webpack://app/ignored|/home/dev/app/node_modules/x|./util'],
    ['webpack://app/external "react"'],
    [''],
    [null],
  ])('the synthetic source %j keys `unknown` with `no-map`', async (source) => {
    const { report } = await scanBuild(mapped('window.fetch = w', source as string))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['no-map'] })
    expect(fetch.occurrences[0].original).toBeNull()
    expect(fetch.occurrences[0].evidence).toEqual({ source })
    expect(fetch.occurrences[0].trace.map((step: Json) => step.kind)).not.toContain('token-check')
  })

  // Any scheme §10 doesn't recognize keys `unknown`, even when its path names a package.
  test.each([
    ['app:///node_modules/x/index.js'],
    ['https://cdn.example/npm/node_modules/x/index.js'],
    ['ng:///node_modules/x/index.js'],
  ])('the foreign-scheme source %j keys `unknown` with `foreign-scheme`', async (source) => {
    const { report } = await scanBuild(mapped('window.fetch = w', source))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['foreign-scheme'] })
    // The raw source stays as evidence, in the original location.
    expect(fetch.occurrences[0].original).toEqual({ source, line: 1, column: 7 })
  })
})

describe('reading the name (§10 step 2)', () => {
  // The package name a normalized path gives.
  test.each([
    ['nested `node_modules`: the last one', '../node_modules/query-string/node_modules/split-on-first/index.js', 'split-on-first'],
    [
      'a scoped package: two segments',
      'webpack://app/./node_modules/@opentelemetry/instrumentation-fetch/build/esm/fetch.js',
      '@opentelemetry/instrumentation-fetch',
    ],
    ['pnpm', 'node_modules/.pnpm/@sentry+core@8.0.0/node_modules/@sentry/core/build/esm/index.js', '@sentry/core'],
    ['Bun isolated', 'node_modules/.bun/zone.js@0.15.0/node_modules/zone.js/fesm2015/zone.js', 'zone.js'],
    ['Yarn PnP', '.yarn/cache/whatwg-fetch-npm-3.6.20-5f3c8b4e2a-0123456789.zip/node_modules/whatwg-fetch/fetch.js', 'whatwg-fetch'],
    ['a dot segment after the last `node_modules` is skipped', 'node_modules/core-js/node_modules/.cache/x/index.js', 'core-js'],
    ['`node_modules` only as a whole segment', 'node_modules/x/my_node_modules/y/index.js', 'x'],
    ['`x/..` segments collapse', 'node_modules/y/../x/index.js', 'x'],
    [
      "an unscoped slug under Yarn's pnpm linker is its name",
      'node_modules/.store/lodash-npm-4.17.21-6382451519/package/lodash.js',
      'lodash',
    ],
    ['a scoped name percent-encoded', 'node_modules/%40scope/x/index.js', '@scope/x'],
  ])('%s', async (_, source, name) => {
    const { report } = await scanBuild(mapped('window.fetch = w', source))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: `pkg:${name}`, provenance: 'bundled-dependency', package: name })
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
  })

  test("a scoped package under Yarn's pnpm linker keys `unknown` with its slug as evidence, `yarn-slug` (low)", async () => {
    const slug = '@sentry-internal-replay-canvas'
    const { report } = await scanBuild(
      mapped('window.fetch = w', `node_modules/.store/${slug}-npm-8.0.0-a1b2c3d4e5/package/build/index.js`),
    )

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['yarn-slug'] })
    expect(fetch.occurrences[0].evidence).toEqual({ slug })
  })

  test("a package's `dist` file gives `prebundled-dist` (medium): it may hide vendored code", async () => {
    const { report } = await scanBuild(mapped('window.fetch = w', 'webpack://app/./node_modules/whatwg-fetch/dist/fetch.umd.js'))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|pkg:whatwg-fetch')
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['prebundled-dist'] })
  })
})

describe('the token check (§10)', () => {
  const source = 'webpack://app/./node_modules/otel-fetch/index.js'
  /** A build whose `window.fetch = w` maps, at `fetch`, to line `line` (0-based) and column 0 of `content`. */
  const pointing = (content: string | null, line: number, fields: Record<string, unknown> = {}) => ({
    'index.html': '<script src="main.js"></script>',
    'main.js': 'window.fetch = w',
    'main.js.map': sourceMap(source, content, [[[0, 0, line, 0], [7, 0, line, 0], [12, 0, line, 0]]], fields),
  })

  test('a failed check discards the position: `unknown`, with `token-check-failed` and the rejected candidate', async () => {
    const { report } = await scanBuild(pointing('export const x = 1\nexport const y = 2\n', 0))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|unknown')
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['token-check-failed'] })
    const [occurrence] = fetch.occurrences
    expect(occurrence.original).toBeNull()
    expect(occurrence.evidence).toEqual({ rejected: { source, line: 1, column: 0 } })
    expect(occurrence.trace.at(-1)).toEqual({
      kind: 'token-check',
      result: 'failed',
      token: 'fetch',
      lookup: { start: 7, end: 12, line: 1, column: 7 },
      candidate: { source, line: 1, column: 0 },
      text: expect.any(String),
    })
  })

  test.each([
    ['on the line before', 'fetch()\nconst a = 1\n', 1],
    ['on the line after', 'const a = 1\nfetch()\n', 0],
    ['in a string', "window['fetch'] = w\n", 0],
  ])('the token passes within one line: %s', async (_, content, line) => {
    const { report } = await scanBuild(pointing(content, line))

    expect(finding(report, 'Window.fetch').attribution.key).toBe('pkg:otel-fetch')
  })

  test.each([
    ['two lines away', 'fetch()\n\nconst a = 1\n', 2],
    ['only inside a longer identifier', 'prefetch(); fetchAll()\n', 0],
    ['in another case', 'window.Fetch = w\n', 0],
  ])('the token fails: %s', async (_, content, line) => {
    const { report } = await scanBuild(pointing(content, line))

    expect(finding(report, 'Window.fetch').confidence.attribution.reasons).toEqual(['token-check-failed'])
  })

  test.each([
    ['the map has no `sourcesContent`', { sourcesContent: undefined }],
    ["the source's `sourcesContent` entry is null", { sourcesContent: [null] }],
  ])("the check doesn't apply when %s: `token-check-n/a` (medium)", async (_, fields) => {
    const { report } = await scanBuild(pointing('unrelated\n', 0, fields))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.key).toBe('pkg:otel-fetch')
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['token-check-n/a'] })
    expect(fetch.occurrences[0].original).toEqual({ source, line: 1, column: 0 })
    expect(fetch.occurrences[0].trace.at(-1)).toMatchObject({ kind: 'token-check', result: 'n/a', token: 'fetch' })
  })
})

describe('the lookup point (§10)', () => {
  const source = 'webpack://app/./node_modules/x/index.js'
  const check = (fetch: Json) => fetch.occurrences[0].trace.at(-1)

  test("a multi-line `Object.defineProperty(\\n window,\\n 'fetch', …)` looks up its `'fetch'` argument, and passes", async () => {
    const code = "Object.defineProperty(\n  window,\n  'fetch',\n  { value: w },\n)\n"
    const { report } = await scanBuild(mapped(code, source))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.key).toBe('pkg:x')
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
    // The occurrence keeps the whole call as its position.
    expect(fetch.occurrences[0].generated).toMatchObject({ line: 1, column: 0 })
    expect(fetch.occurrences[0].original).toEqual({ source, line: 3, column: 2 })
    expect(check(fetch)).toMatchObject({ result: 'passed', token: 'fetch', lookup: { line: 3, column: 2 } })
  })

  test.each([
    ['a key of `Object.defineProperties`', 'Object.defineProperties(window, {\n  fetch: { value: w },\n})', 2, 2],
    ['a string key of `Object.assign`', "Object.assign(window, {\n  'fetch': w,\n})", 2, 2],
    // A computed key written as a string is a string key, as `window['fetch']` is.
    ['a computed string key of `Object.assign`', "Object.assign(window, {\n  ['fetch']: w,\n})", 2, 3],
    ['a string member', "window['fetch'] = w", 1, 7],
    ['a bare global', 'fetch = w', 1, 0],
  ])('%s is the member token', async (_, code, line, column) => {
    const { report } = await scanBuild(mapped(code, source))

    const fetch = finding(report, 'Window.fetch')
    expect(check(fetch)).toMatchObject({ result: 'passed', token: 'fetch', lookup: { line, column } })
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
  })

  // A no-substitution template literal is a token too: test/attribution-line-readings.test.ts.
  test.each([
    ['a name', "const k = 'fetch'\nwindow[k] = w"],
    ['a template with a substitution', 'const k = 0\nwindow[`fe${"tch"}`] = w'],
  ])('a computed member (%s) has no token: its holder is looked up, and the check does not apply', async (_, code) => {
    const { report } = await scanBuild(mapped(code, source))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.key).toBe('pkg:x')
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['token-check-n/a'] })
    expect(check(fetch)).toMatchObject({ result: 'n/a', token: null, lookup: { line: 2, column: 0 } })
  })

  test.each([
    ['`Object.setPrototypeOf` of a literal property', 'Object.setPrototypeOf(window.history, p)', 'history', 22],
    ['`__proto__` of a free global', 'history.__proto__ = p', 'history', 0],
  ])('a write with no member looks up its holder argument: %s', async (_, code, token, column) => {
    const { report } = await scanBuild(mapped(code, source))

    const [changed] = report.findings
    expect(changed.effect).toBe('prototype-change')
    expect(changed.attribution.key).toBe('pkg:x')
    expect(check(changed)).toMatchObject({ result: 'passed', token, lookup: { line: 1, column } })
  })
})

describe('nested code (§10 Nested code)', () => {
  const source = 'webpack://app/./node_modules/x/index.js'

  test.each([
    ['a literal given to `eval`', 'eval("window.fetch = w")', { line: 1, column: 5 }, { line: 1, column: 6 }],
    [
      'a write on a later line of a multi-line template given to a string timer',
      'setTimeout(`\n  var a = 1\n  window.fetch = w\n`)',
      { line: 1, column: 11 },
      { line: 3, column: 2 },
    ],
    ['a `Function` body', 'new Function("a", "XMLHttpRequest.prototype.send = a")', { line: 1, column: 18 }, { line: 1, column: 19 }],
  ])(
    '%s is looked up at the start of its enclosing literal; the token check does not apply (medium)',
    async (_, code, literal, write) => {
      const { report } = await scanBuild(mapped(code, source))

      const [nested] = report.findings
      expect(nested.attribution.key).toBe('pkg:x')
      expect(nested.confidence.attribution).toEqual({ level: 'medium', reasons: ['token-check-n/a'] })
      const [occurrence] = nested.occurrences
      // The occurrence keeps the write's own position, and attribution looks up the literal's.
      expect(occurrence.generated).toMatchObject(write)
      expect(occurrence.original).toEqual({ source, ...literal })
      expect(occurrence.trace.at(-1)).toMatchObject({ kind: 'token-check', result: 'n/a', token: null, lookup: literal })
    },
  )

  test('code nested in nested code is looked up at the literal in the host artifact', async () => {
    const { report } = await scanBuild(mapped(`eval("eval('window.fetch = w')")`, source))

    const [occurrence] = finding(report, 'Window.fetch').occurrences
    expect(occurrence.original).toEqual({ source, line: 1, column: 5 })
  })
})

describe('raw U+2028 and U+2029 (§2 Verification, §9 `line-separator`)', () => {
  test('positions are looked up with the line reading that verified the map, and the finding has `line-separator` (medium)', async () => {
    const source = 'webpack://app/./node_modules/x/index.js'
    // A raw U+2028 in a string: a tool that splits lines only at LF and CR maps the write to its line 2.
    const code = 'var s = "a\u2028b"\nwindow.fetch = w'
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': code,
      'main.js.map': sourceMap(source, 'var s = "a\\u2028b"\nwindow.fetch = w\n', [
        [[0, 0, 0, 0]],
        [[0, 0, 1, 0], [6, 0, 1, 6], [7, 0, 1, 7], [13, 0, 1, 13], [15, 0, 1, 15]],
      ]),
    })

    const fetch = finding(report, 'Window.fetch')
    // The resolver's position reads U+2028 as a line terminator (§5).
    expect(fetch.occurrences[0].generated).toMatchObject({ line: 3, column: 0 })
    expect(fetch.attribution.key).toBe('pkg:x')
    expect(fetch.occurrences[0].original).toEqual({ source, line: 2, column: 7 })
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['line-separator'] })
  })
})

describe('the attribution block (§13)', () => {
  test('counts the findings whose attribution confidence is capped, by level', async () => {
    const source = 'webpack://app/./node_modules/x/index.js'
    const code = "window.fetch = w\nconst k = 'open'\nXMLHttpRequest.prototype[k] = o"
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script><script src="other.js"></script>',
      'main.js': code,
      'main.js.map': sourceMap(source, code, identityMappings(code)),
      'other.js': 'window.alert = a',
    })

    // `Window.fetch` is high, `XMLHttpRequest.prototype.open` medium (no token) and `Window.alert` low (no map).
    expect(report.findings.map((each: Json) => [each.target.name, each.confidence.attribution.level])).toEqual([
      ['Window.alert', 'low'],
      ['Window.fetch', 'high'],
      ['XMLHttpRequest.prototype.open', 'medium'],
    ])
    expect(report.completeness.attribution.cappedFindings).toEqual({ medium: 1, low: 1 })
  })
})

describe('copies of identical bytes (§2 Artifacts)', () => {
  test('each URL is attributed through its own map, and gets its own key', async () => {
    const code = 'window.fetch = w'
    const { report } = await scanBuild({
      'index.html': '<script src="a.js"></script><script src="b.js"></script>',
      'a.js': code,
      'a.js.map': sourceMap('../node_modules/pkg-a/index.js', code, identityMappings(code)),
      'b.js': code,
      'b.js.map': sourceMap('../node_modules/pkg-b/index.js', code, identityMappings(code)),
    })

    expect(
      report.findings.map((each: Json) => [each.fingerprint, each.occurrences.map((occurrence: Json) => occurrence.artifact.url)]),
    ).toEqual([
      ['window|Window.fetch|replace|pkg:pkg-a', ['https://app.example/a.js']],
      ['window|Window.fetch|replace|pkg:pkg-b', ['https://app.example/b.js']],
    ])
  })
})

describe('`sourceRoot` (§10 step 1)', () => {
  test('an empty `sources` entry stays synthetic under a relative `sourceRoot`', async () => {
    const { report } = await scanBuild(mapped('window.fetch = w', '', { sourceRoot: 'node_modules/x' }))

    expect(finding(report, 'Window.fetch').confidence.attribution).toEqual({ level: 'low', reasons: ['no-map'] })
  })

  test.each([
    ['a relative one is prepended', 'node_modules/x', 'pkg:x'],
    ['a relative one ending in `/` is prepended once', '../node_modules/x/', 'pkg:x'],
    // Ignored, the entry names no package: first-party code at the build directory, the root.
    ['a URL is ignored', 'https://cdn.example/node_modules/x/', 'app:lib/index.js'],
    ['an absolute path is ignored', '/home/dev/app/node_modules/x', 'app:lib/index.js'],
    ['a drive-letter path is ignored', 'C:\\app\\node_modules\\x', 'app:lib/index.js'],
  ])('%s', async (_, sourceRoot, key) => {
    const { report } = await scanBuild(mapped('window.fetch = w', 'lib/index.js', { sourceRoot }))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.key).toBe(key)
    // The original location keeps the raw `sources` entry.
    expect(fetch.occurrences[0].original.source).toBe('lib/index.js')
  })
})

describe('the lookup (§10)', () => {
  const source = 'webpack://app/./node_modules/x/index.js'
  const build = (code: string, map: string) => ({
    'index.html': '<script src="main.js"></script>',
    'main.js': code,
    'main.js.map': map,
  })

  test.each([
    ['a 1-field segment is the greatest lower bound', [[[0, 0, 0, 0], [7]]]],
    // The segment before it is on the line before.
    ['no segment is at or before the column on its line', [[[0, 0, 0, 0]], [[13, 0, 1, 0]]]],
  ] as [string, Segment[][]][])('the position is unmapped when %s: `no-map`', async (_, lines) => {
    const code = lines.length === 1 ? 'window.fetch = w' : 'var a = 1\nwindow.fetch = w'
    const { report } = await scanBuild(build(code, sourceMap(source, code, lines)))

    // The map pairs: it is the lookup that finds no position.
    expect(report.artifacts[0].sourceMap.status).toBe('verified')
    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['no-map'] })
    expect(fetch.occurrences[0].evidence).toEqual({})
  })

  test('the greatest lower bound on the same line is the segment at or before the column', async () => {
    const { report } = await scanBuild(build('window.fetch = w', sourceMap(source, 'window.fetch = w', [[[0, 0, 0, 0], [13, 0, 0, 13]]])))

    expect(finding(report, 'Window.fetch').occurrences[0].original).toEqual({ source, line: 1, column: 0 })
  })

  test("a sectioned map's sources are read in its sections' order", async () => {
    const code = 'var a = 1\nwindow.fetch = w'
    const section = (name: string, line: number, lines: Segment[][]) => ({
      offset: { line, column: 0 },
      map: { version: 3, sources: [`../node_modules/${name}/index.js`], sourcesContent: [code], names: [], mappings: mappings(lines) },
    })
    const { report } = await scanBuild(
      build(
        code,
        JSON.stringify({
          version: 3,
          sections: [section('first', 0, [[[0, 0, 0, 0]]]), section('second', 1, [[[0, 0, 1, 0], [7, 0, 1, 7]]])],
        }),
      ),
    )

    expect(finding(report, 'Window.fetch').attribution.key).toBe('pkg:second')
  })
})

// At the attribution seam (§19 Attribution): what the resolver hands over that no scan produces yet. Helper writes need
// function summaries, and mirrored sidecars need source-map directories.
describe('at the attribution seam', () => {
  /** The generated location of the first `find` in `text`, through its lines (1-based line, 0-based column). */
  const at = (text: string, find: string, from = 0): GeneratedLocation => {
    const start = text.indexOf(find, from)
    const before = text.slice(0, start).split('\n')
    return { start, end: start + find.length, line: before.length, column: before.at(-1)!.length }
  }
  const occurrence = (generated: GeneratedLocation, lookup: RawOccurrence['lookup']): RawOccurrence => ({
    artifact: 'https://app.example/main.js',
    generated,
    lookup,
    target: { realm: 'window', holder: 'prototype', name: 'History.prototype.pushState' },
    effect: 'wrap',
    mechanism: 'assign',
    reachability: 'unconditional',
    reachabilityBasis: 'call-path',
    installContext: 'load',
    installEntry: null,
    realmInstance: 'current',
    locks: false,
    confidence: { target: targetConfidence(), mutation: mutationConfidence() },
    trace: [],
  })
  const artifact = (text: string, map: object, method = 'annotation'): MappedArtifact => ({
    url: 'https://app.example/main.js',
    hash: 'sha256:0',
    origin: 'local-build',
    text,
    map: { raw: map, reading: 'ecmascript', method, base: 'main.js.map' },
  })

  // `fill` is @sentry/core's; its caller is @sentry/browser-utils'.
  const text = 'function fill(o,n,w){o[n]=w(o[n])}\nfill(WINDOW.history,"pushState",wrap)'
  const helperMap = {
    version: 3,
    sources: ['../node_modules/@sentry/core/build/esm/utils/object.js', '../node_modules/@sentry/browser-utils/build/esm/history.js'],
    sourcesContent: ['function fill(o, n, w) {\n  o[n] = w(o[n])\n}\n', 'fill(WINDOW.history, "pushState", wrap)\n'],
    names: [],
    mappings: mappings([[[0, 0, 0, 0], [21, 0, 1, 2]], [[0, 1, 0, 0], [20, 1, 0, 21]]]),
  }

  test('a write inside a helper looks up the call the resolver hands over, and keeps its own position', () => {
    const write = at(text, 'o[n]=w(o[n])')
    const [attributed] = attribute([occurrence(write, { generated: at(text, '"pushState"'), token: 'pushState' })], [
      artifact(text, helperMap),
    ], noPathRules)

    expect(attributed!.attribution).toEqual({
      key: 'pkg:@sentry/browser-utils',
      provenance: 'bundled-dependency',
      package: '@sentry/browser-utils',
    })
    expect(attributed!.generated).toEqual(write)
    expect(attributed!.original).toEqual({
      source: '../node_modules/@sentry/browser-utils/build/esm/history.js',
      line: 1,
      column: 21,
    })
  })

  test("when no call carries both holder and member, the helper's write is looked up", () => {
    const write = at(text, 'o[n]=w(o[n])')
    const [attributed] = attribute([occurrence(write, { generated: write, token: null })], [artifact(text, helperMap)], noPathRules)

    expect(attributed!.attribution.key).toBe('pkg:@sentry/core')
  })

  test.each([
    [
      'a mirrored sidecar is capped at medium when the check does not apply',
      'external-sidecar',
      null,
      ['token-check-n/a', 'sidecar-not-token-verified'],
    ],
    ['a mirrored sidecar is high when token-verified', 'external-sidecar', 'pushState', []],
    ['`debugId` can reach high', 'external-debug-id', 'pushState', []],
    ['the mirrored annotation can reach high', 'external-annotation', 'pushState', []],
  ])('pairing methods cap confidence (§10): %s', (_, method, token, reasons) => {
    const call = at(text, '"pushState"')
    const [attributed] = attribute([occurrence(call, { generated: call, token })], [artifact(text, helperMap, method)], noPathRules)

    expect(attributed!.confidence.attribution.reasons).toEqual(reasons)
  })
})

describe('the baseline (§11 Baseline entries)', () => {
  test("an entry keeps the containing package as readable context, and a removed finding reports it", async () => {
    const dir = fixtureBuild(mapped('window.fetch = w', 'webpack://app/./node_modules/otel-fetch/index.js'))
    const cwd = workingDir()
    expect((await runCli(['baseline', 'init', dir, '--map', defaultMap, '--surface', 'all'], { cwd })).exitCode).toBe(0)

    const baseline = JSON.parse(readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8'))
    expect(baseline.entries.map((entry: Json) => entry.attribution)).toEqual([
      { key: 'pkg:otel-fetch', provenance: 'bundled-dependency', package: 'otel-fetch' },
    ])

    writeFileSync(join(dir, 'main.js'), 'window.fetch + w')
    const { report } = await scanBuild(dir, ['--baseline', join(cwd, 'monkeypatchlist.baseline.json')])
    expect(report.findings.map((each: Json) => [each.baselineState, each.attribution])).toEqual([
      ['removed', { key: 'pkg:otel-fetch', provenance: 'bundled-dependency', package: 'otel-fetch' }],
    ])
  })
})

// On the validation corpus: the committed snapshot holds what `monkeypatchlist scan --json` gives for each build
// directory, and CI's corpus check keeps it so (tools/corpus-snapshot, CONTRIBUTING.md).
describe('a corpus library (zone.js), built by each bundler', () => {
  const snapshot = (path: string): Json =>
    JSON.parse(readFileSync(new URL(`../corpus-snapshot/protected/dist/${path}.json`, import.meta.url), 'utf8'))

  test.each(['webpack', 'esbuild', 'rollup', 'vite'])(
    '%s: the maps build keys its findings `pkg:zone.js`, and the nomaps build keys them `unknown` with `no-map`',
    (bundler) => {
      const maps = snapshot(`${bundler}/zonejs/maps`).findings
      const nomaps = snapshot(`${bundler}/zonejs/nomaps`).findings

      expect(maps.length).toBeGreaterThan(0)
      expect(maps.map((each: Json) => each.targetKey)).toEqual(nomaps.map((each: Json) => each.targetKey))
      for (const each of maps) {
        expect(each.attribution).toEqual({ key: 'pkg:zone.js', provenance: 'bundled-dependency', package: 'zone.js' })
      }
      for (const each of nomaps) {
        expect(each.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
        expect(each.confidence.attribution).toEqual({ level: 'low', reasons: ['no-map'] })
      }
    },
  )
})

describe('the map attribution reads is the one pairing verified (§2)', () => {
  const source = 'webpack://app/./node_modules/x/index.js'
  const code = 'window.fetch = w'
  const map = (fields: Record<string, unknown> = {}) => sourceMap(source, code, identityMappings(code), fields)

  test('a map paired by `debugId` attributes the artifact', async () => {
    const id = '85314830-023f-4cf1-a267-535f4e37bb17'
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${code}\n//# debugId=${id}\n`,
      'maps/3f2a.map': map({ debugId: id.toUpperCase() }),
    })

    expect(report.artifacts[0].sourceMap.method).toBe('debug-id')
    expect(finding(report, 'Window.fetch').attribution.key).toBe('pkg:x')
  })

  test('an annotation a quote cancels names no map, so the code has none: `no-map`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${code}\n//# sourceMappingURL=maps/main.js.map "\n`,
      'maps/main.js.map': map(),
    })

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.key).toBe('unknown')
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['no-map'] })
  })

  test('a named map that exists but cannot be read is `unreadable`, and the code has no map: `no-map`', async () => {
    const dir = fixtureBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': `${code}\n//# sourceMappingURL=main.js.map\n`,
    })
    mkdirSync(join(dir, 'main.js.map'))

    const { report } = await scanBuild(dir)

    expect(report.completeness.limitations.map((record: Json) => record.kind)).toEqual(['unreadable'])
    expect(finding(report, 'Window.fetch').confidence.attribution).toEqual({ level: 'low', reasons: ['no-map'] })
  })

  test('the report is byte-identical across runs', async () => {
    const dir = fixtureBuild(mapped("window.fetch = w\nconst k = 'open'\nXMLHttpRequest.prototype[k] = o", source))
    const first = await scanBuild(dir)
    const second = await scanBuild(dir)

    const withoutRun = (text: string) => ({ ...JSON.parse(text), run: null })
    expect(withoutRun(second.stdout)).toEqual(withoutRun(first.stdout))
    expect(JSON.stringify(withoutRun(second.stdout))).toBe(JSON.stringify(withoutRun(first.stdout)))
  })
})


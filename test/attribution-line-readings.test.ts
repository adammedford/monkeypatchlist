// Attribution line readings, sourceRoot scope and template-literal tokens (§2 Verification, §9
// `token-check-n/a`, §10 Containing package and Token check).

import { describe, expect, test } from 'vitest'
import { fixtureFetcher, type RecordedResponse } from '../src/packages/source-store/fixture.ts'
import { fixtureBuild, scanBuild } from './support/fixture-build.ts'
import { identityMappings, mappings, type Segment } from './support/source-map.ts'

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

/** A build whose `main.js` is `code`, with a sidecar map that names `source` for every token and holds `code`. */
function mapped(code: string, source: string | null, fields: Record<string, unknown> = {}): Record<string, string> {
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

const source = 'webpack://app/./node_modules/otel-fetch/index.js'

describe('the token check reads the original under three line readings (§10 Token check)', () => {
  /** A build whose `window.fetch = w` maps, at `fetch`, to line `line` (0-based) and column 0 of `content`. */
  const pointing = (content: string, line: number) => ({
    'index.html': '<script src="main.js"></script>',
    'main.js': 'window.fetch = w',
    'main.js.map': sourceMap(source, content, [[[0, 0, line, 0], [7, 0, line, 0], [12, 0, line, 0]]]),
  })

  test.each([
    // ECMAScript terminators put the write on line 3; a tool that numbers lines at LF only puts it on line 1.
    ['two raw U+2028', 'var a = "  "\nwindow.fetch = w\n'],
    // At LF and CR, or at ECMAScript terminators, the write is on line 3; at LF only, on line 1.
    ['two lone CRs', '/* a\rb\rc */\nwindow.fetch = w\n'],
  ])('%s before the write, from a tool that numbers lines at LF only: the check passes', async (_, content) => {
    const { report } = await scanBuild(pointing(content, 1))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.key).toBe('pkg:otel-fetch')
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
    expect(fetch.occurrences[0].trace.at(-1)).toMatchObject({ kind: 'token-check', result: 'passed' })
  })

  test('two raw U+2029 before the write, from a tool that numbers lines at LF and CR: the check passes', async () => {
    const { report } = await scanBuild(pointing('var a = "  "\r\rwindow.fetch = w\n', 2))

    expect(finding(report, 'Window.fetch').attribution.key).toBe('pkg:otel-fetch')
  })

  test('a token two lines away under every reading still fails', async () => {
    const { report } = await scanBuild(pointing('fetch()\n \r\nconst a = 1\n', 3))

    expect(finding(report, 'Window.fetch').confidence.attribution.reasons).toEqual(['token-check-failed'])
  })
})

describe('an artifact whose map verifies under both line readings is looked up at LF and CR (§2 Verification)', () => {
  test('a write after a raw U+2028 on the same LF line takes the segment before the separator: `pkg:<name>`', async () => {
    const pkg = 'webpack://app/./node_modules/x/index.js'
    // One LF line, with a raw U+2028 in a string. The map's only segments are before the separator, so every mapped
    // position exists under either reading, and the map verifies under both.
    const code = 'var s = "a b"; window.fetch = w'
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': code,
      'main.js.map': sourceMap(pkg, 'var s = "a\\u2028b"; window.fetch = w\n', [[[0, 0, 0, 0], [4, 0, 0, 4]]]),
    })

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.key).toBe('pkg:x')
    expect(fetch.occurrences[0].original).toEqual({ source: pkg, line: 1, column: 4 })
    expect(fetch.occurrences[0].trace.at(-1)).toMatchObject({ kind: 'token-check', result: 'passed', token: 'fetch' })
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['line-separator'] })
  })

  test('subject to the token check: a token that is not near the segment discards the position', async () => {
    const pkg = 'webpack://app/./node_modules/x/index.js'
    const code = 'var s = "a b"; window.fetch = w'
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': code,
      'main.js.map': sourceMap(pkg, 'var s = 1\n\n\nwindow.fetch = w\n', [[[0, 0, 0, 0], [4, 0, 0, 4]]]),
    })

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.key).toBe('unknown')
    expect(fetch.confidence.attribution.reasons).toEqual(['line-separator', 'token-check-failed'])
  })
})

describe('a relative `sourceRoot` is joined only to an entry with no scheme that is not absolute (§10 step 1)', () => {
  test.each([
    ['an `https:` entry', 'https://cdn.example/node_modules/foo/index.js'],
    ['an `app:` entry', 'app:///node_modules/foo/x.js'],
  ])('%s keeps its scheme: `unknown` with `foreign-scheme` (low)', async (_, entry) => {
    const { report } = await scanBuild(mapped('window.fetch = w', entry, { sourceRoot: 'src' }))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['foreign-scheme'] })
    expect(fetch.occurrences[0].original.source).toBe(entry)
  })

  test('a `webpack://` entry is stripped as usual: `pkg:foo`', async () => {
    const { report } = await scanBuild(mapped('window.fetch = w', 'webpack://ns/node_modules/foo/x.js', { sourceRoot: 'src' }))

    expect(finding(report, 'Window.fetch').attribution).toEqual({ key: 'pkg:foo', provenance: 'bundled-dependency', package: 'foo' })
  })

  test('a `webpack://` runtime entry is a synthetic source again: `unknown` with `no-map`', async () => {
    const entry = 'webpack://ns/webpack/runtime/x'
    const { report } = await scanBuild(mapped('window.fetch = w', entry, { sourceRoot: 'src' }))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['no-map'] })
    expect(fetch.occurrences[0].evidence).toEqual({ source: entry })
  })

  test.each([
    // Read as written: the root `node_modules/foo` would otherwise name a package.
    ['an absolute entry is read as written', '/abs/lib/x.js', 'node_modules/foo', 'unknown'],
    ['an absolute entry under `node_modules` keeps its own package', '/abs/node_modules/bar/x.js', 'node_modules/foo', 'pkg:bar'],
    ['a drive-letter entry is read as written', 'C:\\abs\\lib\\x.js', 'node_modules/foo', 'unknown'],
    ['a relative entry is joined', 'lib/x.js', 'node_modules/foo', 'pkg:foo'],
  ])('%s', async (_, entry, sourceRoot, key) => {
    const { report } = await scanBuild(mapped('window.fetch = w', entry, { sourceRoot }))

    expect(finding(report, 'Window.fetch').attribution.key).toBe(key)
  })
})

describe('synthetic sources are recognized on the raw entry, before a `sourceRoot` is joined (§10 step 1)', () => {
  test.each([['<anon>'], ['webpack/runtime/load script']])(
    'with `sourceRoot: "src"`, %j keys `unknown` with `no-map`, the raw source as evidence',
    async (entry) => {
      const { report } = await scanBuild(mapped('window.fetch = w', entry, { sourceRoot: 'src' }))

      const fetch = finding(report, 'Window.fetch')
      expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
      expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['no-map'] })
      expect(fetch.occurrences[0].original).toBeNull()
      expect(fetch.occurrences[0].evidence).toEqual({ source: entry })
    },
  )

  test('both sources of one map, each looked up by its own write', async () => {
    const code = 'window.fetch = w\nwindow.open = o'
    const lines = identityMappings(code).map((segments, line) =>
      segments.map(([column]) => [column, line, 0, column] as Segment),
    )
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': code,
      'main.js.map': JSON.stringify({
        version: 3,
        sourceRoot: 'src',
        sources: ['<anon>', 'webpack/runtime/load script'],
        sourcesContent: ['window.fetch = w\n', 'window.open = o\n'],
        names: [],
        mappings: mappings(lines),
      }),
    })

    expect(finding(report, 'Window.fetch').occurrences[0].evidence).toEqual({ source: '<anon>' })
    expect(finding(report, 'Window.open').occurrences[0].evidence).toEqual({ source: 'webpack/runtime/load script' })
  })

  test('a BOM-prefixed `https:` entry under a relative root keys `unknown` with `foreign-scheme`, not `pkg:foo`', async () => {
    const { report } = await scanBuild(
      mapped('window.fetch = w', '\ufeffhttps://cdn/node_modules/foo/x.js', { sourceRoot: 'src' }),
    )

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.key).toBe('unknown')
    expect(fetch.confidence.attribution.reasons).toEqual(['foreign-scheme'])
  })

  test.each([
    ['<anon>', 'unknown', ['no-map']],
    ['webpack/runtime/load script', 'unknown', ['no-map']],
    ['https://cdn/node_modules/foo/x.js', 'unknown', ['foreign-scheme']],
    ['webpack://ns/node_modules/foo/x.js', 'pkg:foo', []],
  ])('with no `sourceRoot`, %j is unchanged', async (entry, key, reasons) => {
    const { report } = await scanBuild(mapped('window.fetch = w', entry))

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution.key).toBe(key)
    expect(fetch.confidence.attribution.reasons).toEqual(reasons)
  })
})

describe('a no-substitution template literal key is a token; a number key is not (§10 Token check)', () => {
  const pkg = 'webpack://app/./node_modules/x/index.js'
  const check = (fetch: Json) => fetch.occurrences[0].trace.at(-1)

  test.each([
    ['a template member', 'const k = 0\nwindow[`fetch`] = w', 2, 7],
    ['a template key argument of `defineProperty`', 'const k = 0\nObject.defineProperty(window, `fetch`, d)', 2, 30],
    ['a computed template key of `Object.assign`', 'const k = 0\nObject.assign(window, { [`fetch`]: w })', 2, 25],
  ])('%s is looked up and checked as a token', async (_, code, line, column) => {
    const { report } = await scanBuild(mapped(code, pkg))

    const fetch = finding(report, 'Window.fetch')
    expect(check(fetch)).toMatchObject({ result: 'passed', token: 'fetch', lookup: { line, column } })
    expect(fetch.attribution.key).toBe('pkg:x')
    expect(fetch.confidence.attribution).toEqual({ level: 'high', reasons: [] })
  })

  test('a failed check of a template key discards the position: `unknown`, `token-check-failed` (low)', async () => {
    const code = 'window[`fetch`] = w'
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': code,
      'main.js.map': sourceMap(pkg, 'export const a = 1\n', identityMappings(code)),
    })

    const fetch = finding(report, 'Window.fetch')
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['token-check-failed'] })
    expect(check(fetch)).toMatchObject({ result: 'failed', token: 'fetch' })
  })

  test('a template key is matched as a whole identifier', async () => {
    const code = 'window[`fetch`] = w'
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': code,
      'main.js.map': sourceMap(pkg, 'prefetch(); fetchAll()\n', identityMappings(code)),
    })

    expect(finding(report, 'Window.fetch').confidence.attribution.reasons).toEqual(['token-check-failed'])
  })

  test.each([
    ['a number member', 'const k = 0\nArray.prototype[0] = w'],
    ['a number key in `Object.assign`', 'const k = 0\nObject.assign(Array.prototype, { 0: w })'],
    ['a number key in `Object.defineProperties`', 'const k = 0\nObject.defineProperties(Array.prototype, { 0: { value: w } })'],
  ])('%s has no token: `token-check-n/a`, capped at medium', async (_, code) => {
    const { report } = await scanBuild(mapped(code, pkg))

    const zero = finding(report, 'Array.prototype.0')
    expect(zero.attribution.key).toBe('pkg:x')
    expect(zero.confidence.attribution).toEqual({ level: 'medium', reasons: ['token-check-n/a'] })
    expect(check(zero)).toMatchObject({ result: 'n/a', token: null, lookup: { line: 2 } })
  })
})

describe("a remote artifact's verified map gives original locations (§10)", () => {
  const lib = 'https://cdn.example/lib.js'
  const pkg = 'webpack://app/./node_modules/x/index.js'
  const code = 'window.fetch = w'
  const js = (body: string): RecordedResponse => ({ headers: { 'content-type': 'text/javascript' }, body })
  const scanRemote = (responses: Record<string, RecordedResponse>) =>
    scanBuild({ 'index.html': `<script src="${lib}"></script>` }, ['--mode', 'resolve'], {
      deps: { resolveFetcher: () => fixtureFetcher(responses) },
    })

  test('its occurrences get original locations, and its attribution key does not change', async () => {
    const withMap = await scanRemote({
      [lib]: js(`${code}\n//# sourceMappingURL=lib.js.map`),
      'https://cdn.example/lib.js.map': { body: sourceMap(pkg, `${code}\n`, identityMappings(code)) },
    })
    const withoutMap = await scanRemote({ [lib]: js(`${code}\n`) })

    const mappedFetch = finding(withMap.report, 'Window.fetch')
    const unmappedFetch = finding(withoutMap.report, 'Window.fetch')
    expect(withMap.report.artifacts[0].sourceMap).toMatchObject({ status: 'verified' })
    expect(mappedFetch.occurrences[0].original).toEqual({ source: pkg, line: 1, column: 7 })
    expect(mappedFetch.occurrences[0].trace.at(-1)).toMatchObject({ kind: 'token-check', result: 'passed' })
    expect(mappedFetch.attribution).toEqual(unmappedFetch.attribution)
    expect(mappedFetch.fingerprint).toBe(unmappedFetch.fingerprint)
    expect(unmappedFetch.occurrences[0].original).toBeNull()
  })

  test('a position the token check discards gives no original location, and the key still does not change', async () => {
    const withMap = await scanRemote({
      [lib]: js(`${code}\n//# sourceMappingURL=lib.js.map`),
      'https://cdn.example/lib.js.map': { body: sourceMap(pkg, 'export const a = 1\n', identityMappings(code)) },
    })
    const withoutMap = await scanRemote({ [lib]: js(`${code}\n`) })

    const fetch = finding(withMap.report, 'Window.fetch')
    expect(fetch.occurrences[0].original).toBeNull()
    expect(fetch.occurrences[0].evidence).toEqual({ rejected: { source: pkg, line: 1, column: 7 } })
    expect(fetch.fingerprint).toBe(finding(withoutMap.report, 'Window.fetch').fingerprint)
  })
})

test('the report is byte-identical across runs', async () => {
  const code = 'var s = "a\u2028b"; window[`fetch`] = w\nObject.assign(Array.prototype, { 0: z })'
  const dir = fixtureBuild(mapped(code, 'lib/x.js', { sourceRoot: 'node_modules/foo' }))
  const first = await scanBuild(dir)
  const second = await scanBuild(dir)

  const withoutRun = (text: string) => JSON.stringify({ ...JSON.parse(text), run: null })
  expect(first.report.findings.map((each: Json) => each.attribution.key)).toContain('pkg:foo')
  expect(withoutRun(second.stdout)).toBe(withoutRun(first.stdout))
})

// Escaped composed paths inside node_modules (§10 Escaped sources). A
// composed-map source whose path climbs out of its own package inside `node_modules` is escaped: `unknown` with
// `escaped-source`, wherever the inferred root is.

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'
import { identityMappings, mappings } from './support/source-map.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const code = 'window.fetch = w'

/** A version 3 map whose every token of `code` maps to `sources[at]`, each source holding `code`, as JSON text. */
function mapOf(sources: string[], at = 0): string {
  return JSON.stringify({
    version: 3,
    sources,
    sourcesContent: sources.map(() => code),
    names: [],
    mappings: mappings(identityMappings(code, at)),
  })
}

/** A build that runs `path`, which is `code`, with the map `map` beside it as `<path>.map`. */
function build(path: string, map: string): Record<string, string> {
  return { 'index.html': `<script src="${path}"></script>`, [path]: code, [`${path}.map`]: map }
}

const fetchOf = (report: Json) => {
  const found = report.findings.filter((each: Json) => each.target.name === 'Window.fetch')
  expect(found).toHaveLength(1)
  return found[0]
}

describe('a source that climbs out of its package inside node_modules is escaped (§10 Escaped sources)', () => {
  test.each([
    ['a scope then `src` (Sentry 7 under esbuild)', '../../../../node_modules/@sentry/src/instrument/fetch.ts'],
    ['`src` right after `node_modules`', '../../../../node_modules/sentry-browser-7/node_modules/src/helpers.ts'],
    ['`node_modules` twice', '../../../../node_modules/node_modules/@sentry/rrweb/dist/rrweb.js'],
    ['`node_modules` twice, inside a package', '../../../../node_modules/sentry-browser-10/node_modules/node_modules/@sentry/rrweb/dist/rrweb.js'],
    ['a webpack path', 'webpack://app/./node_modules/@sentry/src/instrument/fetch.ts'],
    ['an unscoped `src` at the top', 'node_modules/src/index.ts'],
  ])('%s keys `unknown` with `escaped-source`, low, and keeps the raw path', async (_, source) => {
    const { report } = await scanBuild(build('main.js', mapOf([source])))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['escaped-source'] })
    expect(fetch.occurrences[0].original.source).toBe(source)
    expect(fetch.occurrences[0].evidence ?? {}).toEqual({})
  })
})

describe('near misses still name their package (§10 Containing package)', () => {
  test.each([
    ['a package\'s own `src`', '../../../../node_modules/@sentry/utils/src/instrument/fetch.ts', '@sentry/utils'],
    ['an unscoped package\'s own `src`', '../../../../node_modules/single-spa/src/navigation/navigation-events.js', 'single-spa'],
    ['a package whose name starts with `src`', 'node_modules/srcset/index.js', 'srcset'],
    ['a scoped package whose name starts with `src`', 'node_modules/@acme/src-utils/index.js', '@acme/src-utils'],
    ['a nested `node_modules`', 'node_modules/a/node_modules/b/index.js', 'b'],
    ['pnpm\'s hoisted store', 'node_modules/.pnpm/node_modules/b/index.js', 'b'],
  ])('%s keys `pkg:<name>`', async (_, source, name) => {
    const { report } = await scanBuild(build('main.js', mapOf([source])))

    expect(fetchOf(report).attribution).toEqual({ key: `pkg:${name}`, provenance: 'bundled-dependency', package: name })
  })
})

describe('an escaped package source still places the inferred root (§10 Provenance)', () => {
  test('beside Sentry 7\'s escaped sources, `../../../../src/main.ts` is `app:src/main.ts`', async () => {
    const sources = ['../../../../src/main.ts', '../../../../node_modules/@sentry/src/instrument/fetch.ts']
    const { report } = await scanBuild(build('main.js', mapOf(sources)))

    expect(fetchOf(report).attribution).toEqual({ key: 'app:src/main.ts', provenance: 'first-party' })
  })

  test('the report is byte-identical across runs', async () => {
    const files = build('main.js', mapOf(['../../../../node_modules/@sentry/src/instrument/fetch.ts']))
    const [first, second] = [await scanBuild(files), await scanBuild(files)]
    const strip = (report: Json) => JSON.stringify({ ...report, run: null })

    expect(strip(first.report)).toBe(strip(second.report))
  })
})

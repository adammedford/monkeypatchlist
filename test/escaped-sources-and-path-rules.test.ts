// Escaped sources and framework path rules (§9 `escaped-source`, `framework-path-rule`, `foreign-scheme`;
// §10 Provenance, Escaped sources, Framework path rules; §14 `path-rule`).

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

const pathRuleSteps = (finding: Json) =>
  finding.occurrences[0].trace.filter((step: Json) => step.kind === 'path-rule')

describe('a framework path rule names the package of an escaped source (§10 Framework path rules)', () => {
  test('Next: `webpack://_N_E/../../src/client/…` keys `pkg:next`, medium, with a `path-rule` step', async () => {
    const source = 'webpack://_N_E/../../src/client/components/app-router.tsx'
    const { report } = await scanBuild(build('main.js', mapOf([source])))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'pkg:next', provenance: 'bundled-dependency', package: 'next' })
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['framework-path-rule'] })
    expect(fetch.occurrences[0].evidence).toEqual({ pathRule: 'next-webpack-client' })
    expect(pathRuleSteps(fetch)).toEqual([
      expect.objectContaining({ kind: 'path-rule', rule: 'next-webpack-client', package: 'next' }),
    ])
  })

  test.each([
    ['a relative path with a real segment before the Bazel directory', 'apps/k8-fastbuild-ST-fdfa778d11ba/bin/packages/core/src/render3/listener.ts', 'core'],
    ['a webpack path under `bazel-out`', 'webpack:///../bazel-out/k8-fastbuild-ST-9f8e7d6c5b4a/bin/packages/core/src/render3/listener.ts', 'core'],
    ['another Bazel platform, composed from 19.2.14\'s shipped map', '../../../darwin_arm64-fastbuild-ST-2d99d9656325/bin/packages/common/http/src/xhr.ts', 'common'],
  ])('Angular: %s keys `pkg:@angular/<pkg>`, medium, with a `path-rule` step', async (_, source, pkg) => {
    const { report } = await scanBuild(build('main.js', mapOf([source])))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: `pkg:@angular/${pkg}`, provenance: 'bundled-dependency', package: `@angular/${pkg}` })
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['framework-path-rule'] })
    expect(pathRuleSteps(fetch)).toEqual([
      expect.objectContaining({ kind: 'path-rule', rule: 'angular-bazel', package: `@angular/${pkg}`, source }),
    ])
  })

  test('rules go first: inside a hoisted root, the Next rule still names `next`', async () => {
    const sources = ['webpack://_N_E/../../src/client/index.tsx', 'webpack://_N_E/../../node_modules/react/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources)))

    expect(fetchOf(report).attribution.key).toBe('pkg:next')
  })

  test('a rule gives no version and never lifts past medium, with other reasons kept', async () => {
    const source = 'webpack://_N_E/../../src/client/index.tsx'
    const map = JSON.parse(mapOf([source]))
    delete map.sourcesContent
    const { report } = await scanBuild(build('main.js', JSON.stringify(map)))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'pkg:next', provenance: 'bundled-dependency', package: 'next' })
    expect(fetch.confidence.attribution).toEqual({ level: 'medium', reasons: ['token-check-n/a', 'framework-path-rule'] })
  })

  test.each([
    ['one `../` only', 'webpack://_N_E/../src/client/index.tsx'],
    ['another namespace', 'webpack://app/../../src/client/index.tsx'],
    ['no file after `src/client/`', 'webpack://_N_E/../../src/client'],
    ['Angular 19.2.10 and earlier\'s shipped path', '../../packages/core/src/render3/listener.ts'],
    ['a Bazel run broken by another segment', 'k8-fastbuild-ST-1/bin/x/packages/core/y.ts'],
  ])('no rule matches %s', async (_, source) => {
    const { report } = await scanBuild(build('main.js', mapOf([source])))

    const fetch = fetchOf(report)
    expect(fetch.attribution.key).not.toMatch(/^pkg:/)
    expect(pathRuleSteps(fetch)).toEqual([])
  })

  test('a rule never names a package for a source under `node_modules`', async () => {
    const source = 'webpack://_N_E/../../node_modules/foo/src/client/x.js'
    const { report } = await scanBuild(build('main.js', mapOf([source])))

    expect(fetchOf(report).attribution.key).toBe('pkg:foo')
  })
})

describe('escaped sources are `unknown` with `escaped-source` (§10 Escaped sources)', () => {
  test('a composed path that climbs out of the root: `unknown`, low, the raw path kept', async () => {
    const source = 'webpack://_N_E/../../src/server/app-render.tsx'
    const { report } = await scanBuild(build('main.js', mapOf([source])))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['escaped-source'] })
    expect(fetch.occurrences[0].original.source).toBe(source)
  })

  test.each(['shared/lib/router/router.ts', 'lib/is-error.ts', 'build/webpack/loaders/x.ts'])(
    'escape-only shape: in a hoisted monorepo with root `../..`, `webpack://_N_E/../../src/%s` is escaped, not `app:`',
    async (rest) => {
      const source = `webpack://_N_E/../../src/${rest}`
      const sources = [source, 'webpack://_N_E/../../node_modules/react/index.js']
      const { report } = await scanBuild(build('main.js', mapOf(sources)))

      const fetch = fetchOf(report)
      expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
      expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['escaped-source'] })
      expect(fetch.occurrences[0].original.source).toBe(source)
      expect(pathRuleSteps(fetch)).toEqual([])
    },
  )

  test.each([
    ['webpack://_N_E/../../packages/core/src/render3/listener.ts', 'webpack://_N_E/../../node_modules/react/index.js'],
    ['../../../../packages/router/src/router.ts', '../../../../node_modules/react/index.js'],
    ['webpack:///../../packages/platform-browser-dynamic/src/x.ts', 'webpack:///../../node_modules/react/index.js'],
  ])(
    'escape-only shape: Angular 19.2.10 and earlier\'s %s is escaped in a hoisted root',
    async (source, hoisted) => {
      const { report } = await scanBuild(build('main.js', mapOf([source, hoisted])))

      const fetch = fetchOf(report)
      expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
      expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['escaped-source'] })
      expect(fetch.occurrences[0].original.source).toBe(source)
      expect(pathRuleSteps(fetch)).toEqual([])
    },
  )

  test.each([
    ['a package that is not Angular\'s', 'webpack://_N_E/../../packages/ui/src/button.tsx', 'app:packages/ui/src/button.tsx'],
    ['a package name that only starts like Angular\'s', 'webpack://_N_E/../../packages/core-utils/src/x.ts', 'app:packages/core-utils/src/x.ts'],
  ])('the Angular shape does not match %s: the hoisted root makes it first-party', async (_, source, key) => {
    const sources = [source, 'webpack://_N_E/../../node_modules/react/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources)))

    expect(fetchOf(report).attribution).toEqual({ key, provenance: 'first-party' })
  })

  test('without the shape, the same hoisted root makes `../../src/other/…` first-party', async () => {
    const sources = ['webpack://_N_E/../../src/other/x.ts', 'webpack://_N_E/../../node_modules/react/index.js']
    const { report } = await scanBuild(build('main.js', mapOf(sources)))

    expect(fetchOf(report).attribution).toEqual({ key: 'app:src/other/x.ts', provenance: 'first-party' })
  })
})

describe('a source with an unrecognized scheme is `foreign-scheme` (§10 Source schemes)', () => {
  test.each([
    'app:///src/wrap.ts',
    'https://cdn.example.com/node_modules/foo/index.js',
    'ng://@angular/core/src/render3/listener.ts',
    'data:text/javascript,window.fetch=w',
  ])('%s keys `unknown`, low, with the raw source kept', async (source) => {
    const { report } = await scanBuild(build('main.js', mapOf([source])))

    const fetch = fetchOf(report)
    expect(fetch.attribution).toEqual({ key: 'unknown', provenance: 'unknown' })
    expect(fetch.confidence.attribution).toEqual({ level: 'low', reasons: ['foreign-scheme'] })
    expect(fetch.occurrences[0].original.source).toBe(source)
  })
})

test('the report is byte-identical across runs, apart from its `run` block', async () => {
  const sources = ['webpack://_N_E/../../src/client/a.tsx', 'webpack://_N_E/../../src/shared/b.ts']
  const files = build('main.js', mapOf(sources))
  const [first, second] = [await scanBuild(files), await scanBuild(files)]
  const strip = (report: Json) => JSON.stringify({ ...report, run: null })

  expect(strip(first.report)).toBe(strip(second.report))
})

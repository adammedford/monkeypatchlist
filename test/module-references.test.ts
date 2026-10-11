// Module references (§2 Discovery, §5 Parser, §13 `unresolved-reference`, §19 Discovery).

import { describe, expect, test } from 'vitest'
import { jsResolver, type AnalyzeGroupInput, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** The JS resolver, recording the entry of each group it analyzes, in order. */
function spyResolver(): Resolver & { entries: string[] } {
  const entries: string[] = []
  return {
    entries,
    analyzerVersion: jsResolver.analyzerVersion,
    analyzeGroup(input: AnalyzeGroupInput) {
      entries.push(input.entry.url)
      return jsResolver.analyzeGroup(input)
    },
  }
}

const fingerprints = (report: Json) => report.findings.map((finding: Json) => finding.fingerprint)
const graph = (report: Json) =>
  report.artifacts.map(({ url, sourceType, parent }: Json) => [url, sourceType, parent])

describe('static imports and re-exports (§2 Discovery)', () => {
  test('are followed from a module script, however deep, each import a module whose parent is its importer', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="/js/main.js"></script>',
      'js/main.js': 'import { a } from "./a.js"; import "../lib/side.js"; a()',
      'js/a.js': 'export * from "./b.js"; export { c as a } from "./c.js"',
      'js/b.js': 'import "/lib/deep.js"; export const b = 1',
      'js/c.js': 'export function c() {}; window.fetch = c',
      'lib/side.js': 'window.alert = g',
      'lib/deep.js': 'window.open = h',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/js/a.js', 'module', 'https://app.example/js/main.js'],
      ['https://app.example/js/b.js', 'module', 'https://app.example/js/a.js'],
      ['https://app.example/js/c.js', 'module', 'https://app.example/js/a.js'],
      ['https://app.example/js/main.js', 'module', 'https://app.example/'],
      ['https://app.example/lib/deep.js', 'module', 'https://app.example/js/b.js'],
      ['https://app.example/lib/side.js', 'module', 'https://app.example/js/main.js'],
    ])
    expect(report.artifacts.map(({ path }: Json) => path)).toEqual([
      'js/a.js',
      'js/b.js',
      'js/c.js',
      'js/main.js',
      'lib/deep.js',
      'lib/side.js',
    ])
    expect(fingerprints(report)).toEqual([
      'window|Window.alert|replace|unknown',
      'window|Window.fetch|replace|unknown',
      'window|Window.open|replace|unknown',
    ])
    expect(report.completeness.level).toBe('complete')
  })

  test('that form a cycle are each followed once', async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(
      {
        'index.html': '<script type="module" src="a.js"></script><script type="module" src="a.js?v=2"></script>',
        'a.js': 'import "./b.js"; import "./a.js"; export const a = 1',
        'b.js': 'import { a } from "./a.js"; import("./b.js"); window.fetch = a',
      },
      [],
      { deps: { resolver } },
    )

    // `a.js?v=2` has the bytes of `a.js`: its own record, and their one analysis (§2 Artifacts).
    expect(graph(report)).toEqual([
      ['https://app.example/a.js', 'module', 'https://app.example/'],
      ['https://app.example/a.js?v=2', 'module', 'https://app.example/'],
      ['https://app.example/b.js', 'module', 'https://app.example/a.js'],
    ])
    // `b.js` only imports name, so it is analyzed only in the link groups that import it (§19 Link groups). Each URL
    // of `a.js` resolves its imports against itself, so each has a group of its own.
    expect(resolver.entries).toEqual(['https://app.example/a.js', 'https://app.example/a.js?v=2'])
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
  })
})

describe('dynamic imports (§2 Discovery, §13)', () => {
  test('with a literal specifier are followed from a classic or module script, and name a module', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script><script>if (x) import(`./inline.js`)</script>',
      'app.js': 'button.onclick = () => import("./lazy.js").then((m) => m.go())',
      'lazy.js': 'export function go() {}; import(\'./lazier.js\')',
      'lazier.js': 'window.fetch = f',
      'inline.js': 'window.alert = g',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/#inline-1', 'script', 'https://app.example/'],
      ['https://app.example/app.js', 'script', 'https://app.example/'],
      ['https://app.example/inline.js', 'module', 'https://app.example/#inline-1'],
      ['https://app.example/lazier.js', 'module', 'https://app.example/lazy.js'],
      ['https://app.example/lazy.js', 'module', 'https://app.example/app.js'],
    ])
    expect(fingerprints(report)).toEqual(['window|Window.alert|replace|unknown', 'window|Window.fetch|replace|unknown'])
    expect(report.completeness.limitations).toEqual([])
  })

  test('with a specifier that is not a literal give `unresolved-reference`, located in the importer', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': [
        'const page = location.hash.slice(1)',
        'import(`./pages/${page}.js`)',
        'import("./" + "x.js"); import(page)',
      ].join('\n'),
    })

    const main = report.artifacts[0]
    expect(report.completeness.limitations).toEqual([
      {
        kind: 'unresolved-reference',
        artifact: { url: 'https://app.example/main.js', path: 'main.js', hash: main.hash },
        location: { start: 43, end: 63, line: 2, column: 7 },
        detail: expect.any(String),
      },
      {
        kind: 'unresolved-reference',
        artifact: { url: 'https://app.example/main.js', path: 'main.js', hash: main.hash },
        location: { start: 72, end: 85, line: 3, column: 7 },
        detail: expect.any(String),
      },
      {
        kind: 'unresolved-reference',
        artifact: { url: 'https://app.example/main.js', path: 'main.js', hash: main.hash },
        location: { start: 95, end: 99, line: 3, column: 30 },
        detail: expect.any(String),
      },
    ])
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.completeness.counters.blindSpots).toMatchObject({ unresolvedReference: 3 })
    expect(report.artifacts).toHaveLength(1)
  })
})

describe('source types (§2 Artifacts, §5 Parser)', () => {
  test('a classic script with an import declaration requests nothing, as it fails to parse in a browser', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="classic.js"></script>',
      'classic.js': 'import "./a.js"; import("./b.js")',
      'a.js': 'window.fetch = f',
      'b.js': 'window.alert = g',
    })

    // Only the sweep finds the files it would import (§2 Sweep).
    expect(graph(report)).toEqual([
      ['https://app.example/a.js', 'script', null],
      ['https://app.example/b.js', 'script', null],
      ['https://app.example/classic.js', 'script', 'https://app.example/'],
    ])
    expect(report.completeness.limitations.map(({ kind }: Json) => kind)).toEqual(['parse-failure'])
  })

  test('everything a module script or a dynamic import names is a module, parsed as one', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script src="classic.js"></script>',
        '<script type="module">import "./inline-dep.js"; this.stop = e</script>',
      ].join(''),
      'classic.js': 'this.fetch = f; import("./lazy.js")',
      'lazy.js': 'import "./dep.js"; this.alert = g',
      'dep.js': 'this.print = h; window.open = i',
      'inline-dep.js': 'export var x = 1; this.close = j',
    })

    expect(report.artifacts.map(({ url, sourceType }: Json) => [url, sourceType])).toEqual([
      ['https://app.example/#inline-1', 'module'],
      ['https://app.example/classic.js', 'script'],
      ['https://app.example/dep.js', 'module'],
      ['https://app.example/inline-dep.js', 'module'],
      ['https://app.example/lazy.js', 'module'],
    ])
    // Top-level `this` is the global object in a classic script, and undefined in a module (§5 Global resolution).
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown', 'window|Window.open|replace|unknown'])
    expect(report.completeness.level).toBe('complete')
  })

  test('a file a preload names as a classic script is a module when an import names it', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<link rel="preload" as="script" href="run.js"><link rel="preload" as="script" href="hinted.js">',
        '<link rel="modulepreload" href="preloaded.js"><script type="module" src="main.js"></script>',
      ].join(''),
      'main.js': 'import "./run.js"',
      'preloaded.js': 'import "./hinted.js"',
      'run.js': 'export const x = 1; window.fetch = f',
      'hinted.js': 'export const y = 1; window.alert = g',
    })

    expect(report.artifacts.map(({ url, sourceType }: Json) => [url, sourceType])).toEqual([
      ['https://app.example/hinted.js', 'module'],
      ['https://app.example/main.js', 'module'],
      ['https://app.example/preloaded.js', 'module'],
      ['https://app.example/run.js', 'module'],
    ])
    expect(fingerprints(report)).toEqual(['window|Window.alert|replace|unknown', 'window|Window.fetch|replace|unknown'])
    expect(report.completeness.level).toBe('complete')
  })
})

describe('import maps (§2 Discovery)', () => {
  const importMap = (map: unknown) => `<script type="importmap">${JSON.stringify(map)}</script>`

  test('resolve a bare specifier, exactly or by a prefix key, against the base URL of the document', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<base href="/app/">',
        importMap({ imports: { sdk: './vendor/sdk.js', 'lib/': '/shared/lib/', './local.js': './remapped.js' } }),
        '<script type="module">import "sdk"; import "lib/deep/x.js"; import "./local.js"</script>',
      ].join(''),
      'app/vendor/sdk.js': 'window.fetch = f',
      'shared/lib/deep/x.js': 'window.alert = g',
      'app/remapped.js': 'window.open = h',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/#inline-2', 'module', 'https://app.example/'],
      ['https://app.example/app/remapped.js', 'module', 'https://app.example/#inline-2'],
      ['https://app.example/app/vendor/sdk.js', 'module', 'https://app.example/#inline-2'],
      ['https://app.example/shared/lib/deep/x.js', 'module', 'https://app.example/#inline-2'],
    ])
    expect(report.completeness.limitations).toEqual([])
  })

  test('scopes map a specifier for the modules under a prefix, or at one URL, before the top-level imports', async () => {
    const { report } = await scanBuild({
      'index.html': [
        importMap({
          imports: { dep: '/dep/v2.js' },
          scopes: { '/legacy/': { dep: '/dep/v1.js' }, '/legacy/old.js': { dep: '/dep/v0.js' } },
        }),
        '<script type="module" src="/main.js"></script>',
      ].join(''),
      'main.js': 'import "dep"; import "/legacy/a.js"; import "/legacy/old.js"',
      'legacy/a.js': 'import "dep"',
      'legacy/old.js': 'import "dep"',
      'dep/v0.js': 'window.print = a',
      'dep/v1.js': 'window.alert = b',
      'dep/v2.js': 'window.fetch = c',
    })

    const parents = Object.fromEntries(report.artifacts.map(({ url, parent }: Json) => [url, parent]))
    expect(parents).toMatchObject({
      'https://app.example/dep/v0.js': 'https://app.example/legacy/old.js',
      'https://app.example/dep/v1.js': 'https://app.example/legacy/a.js',
      'https://app.example/dep/v2.js': 'https://app.example/main.js',
    })
  })

  test('a bare specifier no import map resolves gives `unresolved-reference`, located in the importer', async () => {
    const { report } = await scanBuild({
      'index.html': `${importMap({ imports: { known: '/known.js' } })}<script type="module" src="main.js"></script>`,
      'main.js': 'import "known";\nimport { x } from "unknown"; export * from "@scope/pkg"',
      'known.js': 'window.fetch = f',
    })

    const records = report.completeness.limitations.map(({ kind, artifact, location }: Json) => [
      kind,
      artifact.url,
      location,
    ])
    expect(records).toEqual([
      ['unresolved-reference', 'https://app.example/main.js', { start: 34, end: 43, line: 2, column: 18 }],
      ['unresolved-reference', 'https://app.example/main.js', { start: 59, end: 71, line: 2, column: 43 }],
    ])
    expect(report.artifacts.map(({ url }: Json) => url)).toEqual([
      'https://app.example/known.js',
      'https://app.example/main.js',
    ])
  })

  test('an entry that is null, or whose address is no URL, blocks its specifier, and a prefix never backtracks', async () => {
    const { report } = await scanBuild({
      'index.html': [
        importMap({ imports: { blocked: null, bad: 'bare-address', 'pre/': '/p/', 'noslash/': '/n' } }),
        '<script type="module">import "blocked"; import "bad"; import "pre/../../x.js"; import "noslash/a.js"</script>',
      ].join(''),
    })

    expect(report.completeness.limitations.map(({ kind, location }: Json) => [kind, location.start])).toEqual([
      ['unresolved-reference', 7],
      ['unresolved-reference', 25],
      ['unresolved-reference', 39],
      ['unresolved-reference', 64],
    ])
    expect(report.artifacts).toHaveLength(1)
  })

  test('several import maps merge, the first to define a specifier or scope entry winning; invalid ones are ignored', async () => {
    const { report } = await scanBuild({
      'index.html': [
        importMap({ imports: { a: '/a1.js' }, scopes: { '/': { s: '/s1.js' } } }),
        '<script type="importmap">{ not json }</script>',
        importMap({ imports: 'not an object' }),
        importMap([]),
        importMap({ imports: { c: '/c.js' }, integrity: [] }),
        '<script type="importmap" src="external-map.json"></script>',
        importMap({ imports: { a: '/a2.js', b: '/b2.js' }, scopes: { '/': { s: '/s2.js', t: '/t2.js' } } }),
        '<script type="module">import "a"; import "b"; import "s"; import "t"; import "c"</script>',
      ].join(''),
      'external-map.json': JSON.stringify({ imports: { c: '/c.js' } }),
      'c.js': '// c',
      'a1.js': '// a1',
      'b2.js': '// b2',
      's1.js': '// s1',
      't2.js': '// t2',
    })

    const found = (how: string) =>
      report.artifacts.filter(({ discovery }: Json) => discovery === how).map(({ url }: Json) => url)
    expect(found('reference').slice(1)).toEqual(['a1', 'b2', 's1', 't2'].map((name) => `https://app.example/${name}.js`))
    // Only the sweep finds the file the rejected map would have mapped `c` to (§2 Sweep).
    expect(found('sweep')).toEqual(['https://app.example/c.js'])
    expect(report.completeness.limitations.map(({ kind }: Json) => kind)).toEqual(['unresolved-reference'])
  })

  test("each entry document resolves a shared module's bare specifiers through its own import maps", async () => {
    const { report } = await scanBuild(
      {
        'a.html': `${importMap({ imports: { lib: '/a/lib.js' } })}<script type="module" src="/shared.js"></script>`,
        'b.html': `${importMap({ imports: { lib: '/b/lib.js' } })}<script type="module" src="/shared.js"></script>`,
        'c.html': '<script type="module" src="/shared.js"></script>',
        'shared.js': 'import "lib"',
        'a/lib.js': 'window.fetch = f',
        'b/lib.js': 'window.alert = g',
      },
      ['--entry', 'a.html@https://app.example/a', '--entry', 'b.html@https://app.example/b', '--entry', 'c.html'],
    )

    expect(graph(report)).toEqual([
      ['https://app.example/a/lib.js', 'module', 'https://app.example/shared.js'],
      ['https://app.example/b/lib.js', 'module', 'https://app.example/shared.js'],
      ['https://app.example/shared.js', 'module', 'https://app.example/a'],
    ])
    expect(fingerprints(report)).toEqual(['window|Window.alert|replace|unknown', 'window|Window.fetch|replace|unknown'])
    // The third document resolves `lib` through no import map. Its record is raised once, whichever document found it.
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
      ['unresolved-reference', 'https://app.example/shared.js'],
    ])
  })
})

describe('<link rel=modulepreload> (§2 Discovery)', () => {
  test('joins the graph as a module, with its imports, resolved against the base URL; `as` must be script-like', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<base href="/assets/">',
        '<link rel="modulepreload" href="chunk.js">',
        '<link rel="ModulePreload" as="SCRIPT" href="/other.js">',
        // `as` in no state, as a value that is no keyword is, means `script` for a modulepreload.
        '<link rel="modulepreload" as="module" href="no-keyword.js">',
        // A worker destination preloads a worker's module (`test/worker-references.test.ts`).
        '<link rel="modulepreload" as="style" href="s.js">',
        '<link rel="modulepreload" as="image" href="image.js">',
      ].join(''),
      'assets/chunk.js': 'import "./dep.js"; export const x = 1',
      'assets/dep.js': 'window.fetch = f',
      'other.js': 'export let y',
      'assets/no-keyword.js': 'export let z',
      'assets/s.js': 'window.alert = g',
      'assets/image.js': 'window.print = h',
    })

    // Only the sweep finds the files preloaded for another destination (§2 Sweep), as classic scripts of the window.
    expect(graph(report)).toEqual([
      ['https://app.example/assets/chunk.js', 'module', 'https://app.example/'],
      ['https://app.example/assets/dep.js', 'module', 'https://app.example/assets/chunk.js'],
      ['https://app.example/assets/image.js', 'script', null],
      ['https://app.example/assets/no-keyword.js', 'module', 'https://app.example/'],
      ['https://app.example/assets/s.js', 'script', null],
      ['https://app.example/other.js', 'module', 'https://app.example/'],
    ])
    expect(report.findings.map(({ fingerprint, confidence }: Json) => [fingerprint, confidence.target.reasons])).toEqual([
      ['window|Window.alert|replace|unknown', ['realm-assumed']],
      ['window|Window.fetch|replace|unknown', []],
      ['window|Window.print|replace|unknown', ['realm-assumed']],
    ])
    expect(report.completeness.limitations).toEqual([])
  })

  test('never makes a module run: it is analyzed after every script that runs, unless a running module imports it', async () => {
    const resolver = spyResolver()

    await scanBuild(
      {
        'index.html': [
          '<link rel="modulepreload" href="a.js"><link rel="modulepreload" href="b.js">',
          '<script type="module" src="main.js"></script>',
        ].join(''),
        'a.js': 'import "./a-dep.js"',
        'a-dep.js': 'window.fetch = f',
        'b.js': 'import "./b-dep.js"',
        'b-dep.js': 'window.alert = g',
        'main.js': 'import "./b.js"',
      },
      [],
      { deps: { resolver } },
    )

    // A module only imports run is analyzed only in its importers' link groups (§19 Link groups).
    expect(resolver.entries).toEqual(['main.js', 'a.js'].map((name) => `https://app.example/${name}`))
  })
})

describe('remote module references (§2 Discovery, §17 Modes)', () => {
  test('are artifacts with a same-origin or cross-origin origin, skipped offline', async () => {
    const { report } = await scanBuild(
      {
        'index.html': [
          '<script type="importmap">{ "imports": { "react": "https://esm.example/react@19.js" } }</script>',
          '<script type="module" src="/static/main.js"></script>',
          '<link rel="modulepreload" href="https://cdn.example/pre.js">',
        ].join(''),
        'static/main.js': [
          'import "react"',
          'import "https://cdn.example/sdk.js"',
          'import "/api/config.js"',
          'import("//cdn.example/lazy.js")',
        ].join('; '),
      },
      ['--map', 'https://app.example/static/=static', '--entry', 'index.html@https://app.example/'],
    )

    const remote = (url: string, origin: string, parent: string) => ({
      url,
      path: null,
      hash: null,
      origin,
      discovery: 'reference',
      sourceType: 'module',
      realm: 'window',
      realmBasis: 'reference',
      parent,
      sourceMap: { method: 'none', path: null, status: 'none' },
      retrieval: { status: 'offline-skipped', requestedUrl: url, finalUrl: null, contentType: null, sri: 'none' },
      moduleLinking: { idioms: [], modules: 0, unlinked: 0, linkGroups: 0 },
    })
    const main = 'https://app.example/static/main.js'
    expect(report.artifacts).toEqual([
      remote('https://app.example/api/config.js', 'same-origin', main),
      expect.objectContaining({ url: main, origin: 'local-build', sourceType: 'module' }),
      remote('https://cdn.example/lazy.js', 'cross-origin', main),
      remote('https://cdn.example/pre.js', 'cross-origin', 'https://app.example/'),
      remote('https://cdn.example/sdk.js', 'cross-origin', main),
      remote('https://esm.example/react@19.js', 'cross-origin', main),
    ])
    expect(report.completeness.limitations.map(({ kind }: Json) => kind)).toEqual(Array(5).fill('offline-skipped'))
    expect(report.completeness.level).toBe('complete-with-limitations')
  })
})

describe('module requests that are not JavaScript (§2 Content that isn’t JavaScript)', () => {
  test('an import with a type attribute names a JSON or CSS module, which is not an artifact', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': [
        'import data from "./data.json" with { type: "json" }',
        'export { default as sheet } from "./style.css" with { type: "css" }',
        'import("./lazy.json", { with: { type: "json" } })',
      ].join('\n'),
      'data.json': '{}',
      'style.css': 'body {}',
      'lazy.json': '{}',
    })

    // Other attribute keys, and options that are not a literal: `test/import-maps-in-browser-order.test.ts` (104).
    expect(report.artifacts.map(({ url }: Json) => url)).toEqual(['https://app.example/main.js'])
    expect(report.completeness.level).toBe('complete')
  })
})

describe('module requests of content-addressed artifacts (§2 Artifacts)', () => {
  test('identical bytes at two URLs are two records of one analysis, and each URL resolves its requests against itself', async () => {
    const resolver = spyResolver()
    const sdk = 'import "./dep.js"; import(name)'

    const { report } = await scanBuild(
      {
        'index.html': '<script type="module" src="v1/sdk.js"></script><script type="module" src="v2/sdk.js"></script>',
        'v1/sdk.js': sdk,
        'v2/sdk.js': sdk,
        'v1/dep.js': 'window.fetch = f',
        'v2/dep.js': 'window.alert = g',
      },
      [],
      { deps: { resolver } },
    )

    expect(graph(report)).toEqual([
      ['https://app.example/v1/dep.js', 'module', 'https://app.example/v1/sdk.js'],
      ['https://app.example/v1/sdk.js', 'module', 'https://app.example/'],
      ['https://app.example/v2/dep.js', 'module', 'https://app.example/v2/sdk.js'],
      ['https://app.example/v2/sdk.js', 'module', 'https://app.example/'],
    ])
    // Each URL resolves its imports against itself, so each is the entry of a link group of its own (§19 Link groups).
    expect(resolver.entries).toEqual(['https://app.example/v1/sdk.js', 'https://app.example/v2/sdk.js'])
    // Each URL's request is a blind spot of its own, and its record names that URL, with its path and the bytes' hash.
    const { hash } = report.artifacts[1]
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact])).toEqual([
      ['unresolved-reference', { url: 'https://app.example/v1/sdk.js', path: 'v1/sdk.js', hash }],
      ['unresolved-reference', { url: 'https://app.example/v2/sdk.js', path: 'v2/sdk.js', hash }],
    ])
  })
})

describe('determinism (§15)', () => {
  test('two scans of copies of a build with module references give byte-identical reports, except run', async () => {
    const files = {
      'a.html': '<script type="importmap">{"imports":{"x":"/x.js"}}</script><script type="module" src="m.js"></script>',
      'b.html': '<link rel="modulepreload" href="z.js"><script type="module" src="m.js"></script>',
      'm.js': 'import "x"; import "./y.js"; import(y)',
      'x.js': 'window.fetch = f',
      'y.js': 'import("https://cdn.example/r.js")',
      'z.js': 'import "./y.js"',
    }
    const entries = ['--entry', 'b.html@https://app.example/b', '--entry', 'a.html']

    const first = await scanBuild(files, entries)
    const second = await scanBuild(files, entries)

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
    expect(first.report.artifacts).toHaveLength(5)
  })
})

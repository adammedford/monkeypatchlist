// Import maps in browser order and import attributes (§2 Discovery, Import maps; §13
// `unresolved-reference`).

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const importMap = (map: unknown) => `<script type="importmap">${JSON.stringify(map)}</script>`
const graph = (report: Json) =>
  report.artifacts.map(({ url, sourceType, parent, discovery }: Json) => [url, sourceType, parent, discovery])
const records = (report: Json) =>
  report.completeness.limitations.map(({ kind, artifact, location }: Json) => [kind, artifact.url, location])

describe('import maps in tree order (§2 Import maps)', () => {
  test("an inline module's requests resolve only through the maps before it; other requests through all of them", async () => {
    const { report } = await scanBuild({
      'index.html': [
        importMap({ imports: { early: '/early.js' } }),
        '<script type="module">import "early"; import "late"</script>',
        importMap({ imports: { late: '/late.js' } }),
        '<script type="module" src="/main.js"></script>',
      ].join(''),
      'main.js': 'import "late"; import "early"',
      'early.js': 'window.fetch = f',
      'late.js': 'window.alert = g',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/#inline-2', 'module', 'https://app.example/', 'reference'],
      ['https://app.example/early.js', 'module', 'https://app.example/#inline-2', 'reference'],
      ['https://app.example/late.js', 'module', 'https://app.example/main.js', 'reference'],
      ['https://app.example/main.js', 'module', 'https://app.example/', 'reference'],
    ])
    // The browser fails the inline module's `late`: the map that defines it comes after the module.
    expect(records(report)).toEqual([
      ['unresolved-reference', 'https://app.example/#inline-2', { start: 23, end: 29, line: 1, column: 23 }],
    ])
    expect(report.completeness.level).toBe('complete-with-limitations')
  })

  test("a classic inline script's dynamic import, like an external module's requests, resolves through every map", async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script>import("late")</script>',
        '<script type="module">import("late")</script>',
        importMap({ imports: { late: '/late.js' } }),
      ].join(''),
      'late.js': 'window.alert = g',
    })

    // Only an inline module script's requests are limited to the maps before it (§2 Import maps).
    expect(records(report)).toEqual([
      ['unresolved-reference', 'https://app.example/#inline-2', { start: 7, end: 13, line: 1, column: 7 }],
    ])
    expect(graph(report)).toEqual([
      ['https://app.example/#inline-1', 'script', 'https://app.example/', 'reference'],
      ['https://app.example/#inline-2', 'module', 'https://app.example/', 'reference'],
      ['https://app.example/late.js', 'module', 'https://app.example/#inline-1', 'reference'],
    ])
  })

  test("merge as the standard says, with no re-sort: an earlier map's shorter prefix or scope still comes first", async () => {
    const { report } = await scanBuild({
      'index.html': [
        importMap({ imports: { 'lib/': '/v1/lib/' }, scopes: { '/': { dep: '/dep/v1.js' } } }),
        importMap({ imports: { 'lib/deep/': '/v2/deep/' }, scopes: { '/js/': { dep: '/dep/v2.js' } } }),
        '<script type="module" src="/js/main.js"></script>',
      ].join(''),
      'js/main.js': 'import "lib/deep/x.js"; import "dep"',
      'v1/lib/deep/x.js': 'window.fetch = f',
      'v2/deep/x.js': 'window.alert = g',
      'dep/v1.js': 'window.open = h',
      'dep/v2.js': 'window.print = i',
    })

    // Only the sweep finds the files the later map's longer prefix and more specific scope name (§2 Sweep).
    expect(graph(report)).toEqual([
      ['https://app.example/dep/v1.js', 'module', 'https://app.example/js/main.js', 'reference'],
      ['https://app.example/dep/v2.js', 'script', null, 'sweep'],
      ['https://app.example/js/main.js', 'module', 'https://app.example/', 'reference'],
      ['https://app.example/v1/lib/deep/x.js', 'module', 'https://app.example/js/main.js', 'reference'],
      ['https://app.example/v2/deep/x.js', 'script', null, 'sweep'],
    ])
    expect(records(report)).toEqual([])
  })

  test('a later rule never changes a specifier an inline module before it already resolved', async () => {
    const { report } = await scanBuild({
      'index.html': [
        importMap({ imports: { dep: '/dep/v1.js' } }),
        '<script type="module">import "dep"; import "/x.js"</script>',
        // HTML § Merge existing and new import maps drops both rules: each would change an already resolved specifier.
        importMap({ imports: { '/x.js': '/y.js' }, scopes: { '/': { dep: '/dep/v2.js' } } }),
        '<script type="module" src="/main.js"></script>',
      ].join(''),
      'main.js': 'import "dep"; import "/x.js"',
      'dep/v1.js': 'window.fetch = f',
      'dep/v2.js': 'window.alert = g',
      'x.js': 'window.open = h',
      'y.js': 'window.print = i',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/#inline-2', 'module', 'https://app.example/', 'reference'],
      ['https://app.example/dep/v1.js', 'module', 'https://app.example/#inline-2', 'reference'],
      ['https://app.example/dep/v2.js', 'script', null, 'sweep'],
      ['https://app.example/main.js', 'module', 'https://app.example/', 'reference'],
      ['https://app.example/x.js', 'module', 'https://app.example/#inline-2', 'reference'],
      ['https://app.example/y.js', 'script', null, 'sweep'],
    ])
    expect(records(report)).toEqual([])
  })

  test('a later top-level key that only starts with an already resolved specifier still merges', async () => {
    const { report } = await scanBuild({
      'index.html': [
        importMap({ imports: { lodash: '/l/lodash.js' } }),
        '<script type="module">import "lodash"</script>',
        // `lodash/` is neither `lodash` nor a prefix of it, so it can't change how `lodash` resolves (§2 Import maps).
        importMap({ imports: { 'lodash/': '/l/', other: '/other.js' } }),
        '<script type="module" src="/main.js"></script>',
      ].join(''),
      'main.js': 'import "lodash/fp.js"; import "other"',
      'l/lodash.js': 'export default 1',
      'l/fp.js': 'window.fetch = f',
      'other.js': 'window.alert = g',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/#inline-2', 'module', 'https://app.example/', 'reference'],
      ['https://app.example/l/fp.js', 'module', 'https://app.example/main.js', 'reference'],
      ['https://app.example/l/lodash.js', 'module', 'https://app.example/#inline-2', 'reference'],
      ['https://app.example/main.js', 'module', 'https://app.example/', 'reference'],
      ['https://app.example/other.js', 'module', 'https://app.example/main.js', 'reference'],
    ])
    expect(records(report)).toEqual([])
  })

  test('a later top-level key that is a `/`-ending prefix of an already resolved specifier is dropped', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script type="module">import "/app/helper.js"</script>',
        // `/app/` would change `/app/helper.js`, which the inline module resolved as its URL, so the whole rule is
        // dropped, as in the HTML standard's example and Chromium (§2 Import maps). `other` still merges.
        importMap({ imports: { '/app/': '/other/', other: '/other.js' } }),
        '<script type="module" src="/main.js"></script>',
      ].join(''),
      'main.js': 'import "/app/helper.js"; import "/app/util.js"; import "other"',
      'app/helper.js': 'window.fetch = f',
      'app/util.js': 'window.alert = g',
      'other/helper.js': 'window.open = h',
      'other/util.js': 'window.print = i',
      'other.js': 'window.close = j',
    })

    // Only the sweep finds the files the dropped `/app/` rule would have named (§2 Sweep).
    expect(graph(report)).toEqual([
      ['https://app.example/#inline-1', 'module', 'https://app.example/', 'reference'],
      ['https://app.example/app/helper.js', 'module', 'https://app.example/#inline-1', 'reference'],
      ['https://app.example/app/util.js', 'module', 'https://app.example/main.js', 'reference'],
      ['https://app.example/main.js', 'module', 'https://app.example/', 'reference'],
      ['https://app.example/other.js', 'module', 'https://app.example/main.js', 'reference'],
      ['https://app.example/other/helper.js', 'script', null, 'sweep'],
      ['https://app.example/other/util.js', 'script', null, 'sweep'],
    ])
    expect(records(report)).toEqual([])
  })
})

describe('import attributes (§2 Import maps)', () => {
  test('a dynamic import with an attribute key other than `type` is not followed, and gives no record', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': [
        'import("./d.js", { with: { foo: "bar" } })',
        'import("./e.js", { with: {} })',
        'import("./f.js", {})',
      ].join('\n'),
      'd.js': 'window.open = h',
      'e.js': 'window.print = i',
      'f.js': 'window.close = j',
    })

    // Only the sweep finds the file the request with another key names (§2 Sweep). No attributes, or an empty `with`,
    // is a JavaScript module request. A static import with another key fails its importer's whole graph
    // (test/dynamic-import-options-and-failed-module-graphs.test.ts).
    expect(graph(report)).toEqual([
      ['https://app.example/d.js', 'script', null, 'sweep'],
      ['https://app.example/e.js', 'module', 'https://app.example/main.js', 'reference'],
      ['https://app.example/f.js', 'module', 'https://app.example/main.js', 'reference'],
      ['https://app.example/main.js', 'module', 'https://app.example/', 'reference'],
    ])
    expect(records(report)).toEqual([])
  })

  test("a dynamic import whose options can't be read gives `unresolved-reference`, and its target is never parsed", async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': [
        'const opts = { with: { type: "json" } }',
        'import("./x.json", opts)',
        'import("./a.js", { with: attrs }); import("./b.js", { ...opts })',
      ].join('\n'),
      'x.json': '{ "a": 1 }',
      'a.js': 'window.fetch = f',
      'b.js': 'window.alert = g',
    })

    // Only the sweep finds the JavaScript files (§2 Sweep); the JSON file is no artifact.
    expect(graph(report)).toEqual([
      ['https://app.example/a.js', 'script', null, 'sweep'],
      ['https://app.example/b.js', 'script', null, 'sweep'],
      ['https://app.example/main.js', 'module', 'https://app.example/', 'reference'],
    ])
    expect(records(report)).toEqual([
      ['unresolved-reference', 'https://app.example/main.js', { start: 47, end: 57, line: 2, column: 7 }],
      ['unresolved-reference', 'https://app.example/main.js', { start: 72, end: 80, line: 3, column: 7 }],
      ['unresolved-reference', 'https://app.example/main.js', { start: 107, end: 115, line: 3, column: 42 }],
    ])
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.completeness.counters.blindSpots).toMatchObject({ unresolvedReference: 3 })
  })

  test('literal options are read as the import reads them (a free `undefined` is read too)', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': [
        // A `with` its prototype gives it, and options or a `with` that are not an object: none names JavaScript.
        'import("./p.js", { __proto__: { with: { type: "json" } } })',
        'import("./q.js", "json"); import("./r.js", { with: null })',
        // A free `undefined` is read as undefined; a `type` names no JavaScript module whatever `t` is; `...{}` adds
        // nothing (§2 Import attributes).
        'import("./s.js", { other: 1, with: undefined })',
        'import("./t.js", { with: { type: t } }); import(`./u.js`, { "with": {}, ...{} })',
        'import("./v.js", { other: 1 })',
        // An array's `with` is `Array.prototype.with`, a function with no enumerable own property: no attributes.
        'import("./w.js", [1]); import("./x.js", { with: ["json"] }); import("./y.js", { with: /json/ })',
      ].join('\n'),
      ...Object.fromEntries(
        ['p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y'].map((name) => [`${name}.js`, `export const ${name} = 1`]),
      ),
    })

    const references = report.artifacts.filter(({ discovery }: Json) => discovery === 'reference')
    expect(references.map(({ url }: Json) => url)).toEqual(
      ['main', 's', 'u', 'v', 'w', 'y'].map((name) => `https://app.example/${name}.js`),
    )
    expect(records(report)).toEqual([])
  })
})

describe('import attributes: literal keys (§2 Import maps)', () => {
  test('options whose keys are literals of any kind are a literal', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': 'import("./k.js", { [true]: 1, [null]: 2, [/x/g]: 3, 1n: 4, [2n]: 5, 0x10: 6, with: {} })',
      'k.js': 'export const k = 1',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/k.js', 'module', 'https://app.example/main.js', 'reference'],
      ['https://app.example/main.js', 'module', 'https://app.example/', 'reference'],
    ])
    expect(records(report)).toEqual([])
  })
})

describe('determinism (§15)', () => {
  test('two scans of a page with maps around inline modules give byte-identical reports, except run', async () => {
    const files = {
      'index.html': [
        importMap({ imports: { a: '/a.js', 'p/': '/p/' }, scopes: { '/': { s: '/s1.js' } } }),
        '<script type="module">import "a"; import "p/x.js"; import "s"; import(b, opts)</script>',
        importMap({ imports: { b: '/b.js', 'p/x.js': '/px.js' }, scopes: { '/': { s: '/s2.js' }, '/m/': { a: '/a2.js' } } }),
        '<script type="module" src="/m/main.js"></script>',
      ].join(''),
      'm/main.js': 'import "a"; import "b"; import "p/x.js"; import "s"; import("./j.json", { with: { type: "json" } })',
      'a.js': 'window.fetch = f',
      'a2.js': 'window.stop = j',
      'b.js': 'window.alert = g',
      'p/x.js': 'window.open = h',
      's1.js': 'window.print = i',
    }

    const first = await scanBuild(files)
    const second = await scanBuild(files)

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
    // The later map's `/m/` scope applies to `/m/main.js`, which no record's base URL is under, so it merges.
    expect(first.report.artifacts.filter(({ discovery }: Json) => discovery === 'reference')).toHaveLength(7)
  })
})

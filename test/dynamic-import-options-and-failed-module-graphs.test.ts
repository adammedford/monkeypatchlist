// Dynamic-import options as the engine reads them (§2 Import attributes), and
// module graphs a static import with an unsupported attribute fails (Principle 1; §2 Import attributes).
// Scans run end to end through `monkeypatchlist scan --json -`; a recording fixture fetcher,
// swapped in through the CLI's `deps`, shows which remote modules are fetched.

import { describe, expect, test } from 'vitest'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import type { FetchRequest } from '../src/packages/source-store/index.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** Each artifact's URL, source type, realm basis and discovery method. */
const graph = (report: Json) =>
  report.artifacts.map(({ url, sourceType, realmBasis, discovery }: Json) =>
    [url.replace('https://app.example', ''), sourceType, realmBasis, discovery].join(' '),
  )
const records = (report: Json) =>
  report.completeness.limitations.map(({ kind, artifact, location }: Json) => [kind, artifact.url, location?.line])
const references = (report: Json) =>
  report.artifacts
    .filter(({ discovery }: Json) => discovery === 'reference')
    .map(({ url }: Json) => url.replace('https://app.example', ''))
const fingerprints = (report: Json) => report.findings.map(({ fingerprint }: Json) => fingerprint)

/** The fixture fetcher over `responses`, recording the URL of every fetch it is asked for. */
function recordingFetcher(responses: Parameters<typeof fixtureFetcher>[0] = {}) {
  const fetcher = fixtureFetcher(responses)
  const urls: string[] = []
  return {
    urls,
    fetch: (url: string, request: FetchRequest) => (urls.push(url), fetcher.fetch(url, request)),
  }
}

const js = (body: string) => ({ headers: { 'content-type': 'text/javascript' }, body })

/** One module file for each name, exporting it. */
const modules = (...names: string[]) =>
  Object.fromEntries(names.map((name) => [`${name}.js`, `export const ${name} = 1`]))

describe('dynamic-import options, read as EvaluateImportCall reads them (§2 Import attributes)', () => {
  test('a free `undefined`, a `with` that is `undefined` and keys other than `with` name a JavaScript module', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': [
        'import("./a.js", undefined)',
        'import("./b.js", { with: undefined })',
        'import("./c.js", { other: foo })',
      ].join('\n'),
      ...modules('a', 'b', 'c'),
    })

    expect(references(report)).toEqual(['/a.js', '/b.js', '/c.js', '/main.js'])
    expect(records(report)).toEqual([])
  })

  test("a part that can't be read and could decide gives `unresolved-reference`, and the target is not followed", async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': [
        'import("./a.js", opts)',
        'import("./b.js", f())',
        'import("./c.js", { ...o })',
        'import("./d.js", { [k]: v })',
        'import("./e.js", { with: w })',
        'import("./f.js", { with: { ...a } })',
        // A string whose text can't be read may be empty, or spread index keys into `with`.
        'import("./g.js", { with: { ...`${a}` } })',
        'import("./h.js", { with: [...typeof a] })',
      ].join('\n'),
      ...modules('a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'),
    })

    expect(references(report)).toEqual(['/main.js'])
    expect(records(report)).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((line) => ['unresolved-reference', 'https://app.example/main.js', line]),
    )
    expect(report.completeness.level).toBe('complete-with-limitations')
  })

  test("a part that can't be read but can't decide is no limitation", async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': [
        // A later `with` overrides what the spread or computed key may set; so does a spread of a literal.
        'import("./a.js", { ...o, [k]: v, with: {} })',
        'import("./b.js", { "with": {}, ...{} })',
        // Whatever `t` is, the `type` key names no JavaScript module, and neither does a spread's key.
        'import("./c.js", { with: { type: t } })',
        'import("./d.js", { with: { ...a, foo: "bar" } })',
        // A `with` method is a function, with no enumerable own property.
        'import("./e.js", { with() {} })',
        // A declared `undefined` is a name like any other.
        'function g(undefined) { import("./g.js", undefined) }',
        // A string's index keys are never `with`.
        'import("./h.js", { ...`${a}` })',
      ].join('\n'),
      ...modules('a', 'b', 'c', 'd', 'e', 'g', 'h'),
    })

    expect(references(report)).toEqual(['/a.js', '/b.js', '/e.js', '/h.js', '/main.js'])
    expect(records(report)).toEqual([['unresolved-reference', 'https://app.example/main.js', 6]])
  })
})

describe('a static import with an unsupported attribute fails every module graph that contains it (Principle 1)', () => {
  test('nothing is followed from the script element, and its local modules are swept', async () => {
    const fetcher = recordingFetcher({ 'https://cdn.example/r.js': js('window.open = o') })
    const { report } = await scanBuild(
      {
        'index.html': '<script type="module" src="main.js"></script>',
        'main.js': 'import "./a.js"; import "https://cdn.example/r.js"; window.fetch = f',
        'a.js': 'import x from "./y.js" with { foo: "bar" }; window.alert = g',
        'y.js': 'export default 1',
      },
      ['--mode', 'resolve'],
      { deps: { resolveFetcher: () => fetcher } },
    )

    expect(graph(report)).toEqual([
      '/a.js module assumed sweep',
      '/main.js module assumed sweep',
      '/y.js module assumed sweep',
    ])
    expect(fetcher.urls).toEqual([])
    expect(records(report)).toEqual([])
  })

  test('`with { type: "javascript" }` fails the graph too, and so does an importer a dynamic import or worker reaches', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script><script src="classic.js"></script>',
      'main.js': 'import("./lazy.js"); new Worker("./worker.js", { type: "module" }); export {}',
      'classic.js': 'import("./lazy.js")',
      'lazy.js': 'import "./bad.js"; window.fetch = f',
      'worker.js': 'import "./bad.js"; self.fetch = f',
      'bad.js': 'export { x } from "./x.js" with { type: "javascript" }',
      'x.js': 'export const x = 1',
    })

    expect(references(report)).toEqual(['/classic.js', '/main.js'])
    expect(graph(report)).toEqual(
      expect.arrayContaining(['/lazy.js module assumed sweep', '/worker.js module assumed sweep']),
    )
    expect(records(report)).toEqual([])
    expect(fingerprints(report)).not.toContain('dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown')
  })

  test('a module another graph without the importer reaches is still followed from that graph', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script><script type="module" src="other.js"></script>',
      'main.js': 'import "./shared.js"; import "./bad.js"',
      'other.js': 'import "./shared.js"',
      'shared.js': 'window.fetch = f',
      'bad.js': 'import c from "./c.json" with { type: "json", foo: "bar" }',
      'c.json': '{}',
    })

    expect(references(report)).toEqual(['/other.js', '/shared.js'])
    expect(report.artifacts.find(({ url }: Json) => url.endsWith('/shared.js')).parent).toBe(
      'https://app.example/other.js',
    )
  })

  test('`type: "json"` and `type: "css"` keep their rule: the request is not followed, and its importer runs', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="main.js"></script>',
      'main.js': [
        'import c from "./c.json" with { type: "json" }',
        'import s from "./s.css" with { "type": "css" }',
        'import "./a.js"',
      ].join('\n'),
      'c.json': '{}',
      's.css': '',
      'a.js': 'window.fetch = f',
    })

    expect(references(report)).toEqual(['/a.js', '/main.js'])
    expect(records(report)).toEqual([])
    expect(fingerprints(report)).toContain('window|Window.fetch|replace|unknown')
  })

  test('an inline module whose graph fails gives nothing', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module">import "./bad.js"; window.fetch = f</script>',
      'bad.js': 'import "./y.js" with { foo: "bar" }',
      'y.js': 'export {}',
    })

    expect(references(report)).toEqual([])
    expect(records(report)).toEqual([])
    expect(fingerprints(report)).toEqual([])
  })
})

describe('a hint names its own file, but nothing is followed through a failed graph from it', () => {
  const files = (links: string) => ({
    'index.html': `<script type="module" src="/app.js"></script>${links}`,
    'app.js': 'import "./vendor.js"; import "./other.js"',
    'vendor.js': [
      'import c from "./cfg.js" with { foo: "bar" }',
      'import "https://cdn.example/rum.js"',
      'fetch = wrap(fetch)',
    ].join('\n'),
    'cfg.js': 'export default 1',
    'other.js': 'export {}',
  })

  test.each([
    ['', 'window', 'window|Window.fetch|'],
    [' as="worker"', 'dedicated-worker', 'dedicated-worker|DedicatedWorkerGlobalScope.fetch|'],
  ])('a modulepreload%s keeps its module in its realm, and follows none of its requests', async (as, realm, target) => {
    const fetcher = recordingFetcher({ 'https://cdn.example/rum.js': js('window.open = o') })
    const { report } = await scanBuild(files(`<link rel="modulepreload" href="/vendor.js"${as}>`), ['--mode', 'resolve'], {
      deps: { resolveFetcher: () => fetcher },
    })

    const vendor = report.artifacts.filter(({ url }: Json) => url === 'https://app.example/vendor.js')
    expect(vendor).toMatchObject([{ sourceType: 'module', realm, realmBasis: 'reference', discovery: 'reference' }])
    expect(references(report)).toEqual(['/vendor.js'])
    expect(graph(report)).toEqual(
      expect.arrayContaining(['/app.js module assumed sweep', '/cfg.js module assumed sweep']),
    )
    expect(fetcher.urls).toEqual([])
    expect(records(report)).toEqual([])
    expect(fingerprints(report).filter((fingerprint: string) => fingerprint.startsWith(target))).toHaveLength(1)
  })

  test('offline, the remote module in the failed graph gives no record', async () => {
    const { report } = await scanBuild(files('<link rel="modulepreload" href="/vendor.js">'))

    expect(records(report)).toEqual([])
    expect(report.artifacts.map(({ url }: Json) => url)).not.toContain('https://cdn.example/rum.js')
  })

  test('a classic preload of the failed root makes it preload-only, and its imports are not followed', async () => {
    const { report } = await scanBuild(
      files('<link rel="modulepreload" href="/vendor.js"><link rel="preload" as="script" href="/app.js">'),
    )

    expect(report.artifacts.find(({ url }: Json) => url === 'https://app.example/app.js')).toMatchObject({
      sourceType: 'module',
      realm: 'window',
      realmBasis: 'assumed',
      discovery: 'reference',
    })
    expect(references(report)).toEqual(['/app.js', '/vendor.js'])
    expect(graph(report)).toEqual(expect.arrayContaining(['/other.js module assumed sweep']))
    expect(records(report)).toEqual([])
  })
})

describe('an inline module adds what it would follow to the resolved module set, whether or not its graph fails', () => {
  test("a later map's `/app/` rule is dropped even though /app/main.js's graph fails", async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script type="module">import "/app/main.js"; import("/app/lazy.js")</script>',
        '<script type="importmap">{"imports":{"/app/":"/v2/"}}</script>',
        '<script type="module" src="/ext.js"></script>',
      ].join(''),
      'app/main.js': 'import "./bad.js"',
      'app/bad.js': 'import "./y.js" with { foo: "bar" }',
      'app/y.js': 'export {}',
      'app/lazy.js': 'export {}',
      'app/util.js': 'window.fetch = f',
      'v2/util.js': 'window.alert = g',
      'ext.js': 'import "/app/util.js"',
    })

    expect(references(report)).toEqual(['/app/util.js', '/ext.js'])
    expect(records(report)).toEqual([])
  })
})

describe('determinism (§15)', () => {
  test('two scans of a page with a failed graph and a hint give byte-identical reports, except run', async () => {
    const files = {
      'index.html': '<script type="module" src="/app.js"></script><link rel="modulepreload" href="/vendor.js">',
      'app.js': 'import "./vendor.js"; import("./lazy.js", { with: undefined })',
      'vendor.js': 'import c from "./cfg.js" with { foo: "bar" }; fetch = wrap(fetch)',
      'cfg.js': 'export default 1',
      'lazy.js': 'import("./x.js", opts)',
    }

    const first = await scanBuild(files)
    const second = await scanBuild(files)

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
  })
})

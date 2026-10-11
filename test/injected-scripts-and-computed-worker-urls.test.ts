// Injected scripts and computed worker URLs (§2 Discovery, §6 Scripts of one page are not linked in R1, §13,
// §17 Integrity, §19 References only the resolver can see; ADR 0015).

import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { jsResolver, type AnalyzeGroupInput, type Resolver } from '../src/packages/analysis/index.ts'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** Each artifact: URL, how it was discovered, source type, realm, realm basis and parent. */
const artifacts = (report: Json) =>
  report.artifacts.map(({ url, discovery, sourceType, realm, realmBasis, parent }: Json) => [
    url,
    discovery,
    sourceType,
    realm,
    realmBasis,
    parent,
  ])

const fingerprints = (report: Json) => report.findings.map(({ fingerprint }: Json) => fingerprint)

/** The limitation records of one kind: artifact URL, location line and column. */
const records = (report: Json, kind: string) =>
  report.completeness.limitations
    .filter((record: Json) => record.kind === kind)
    .map(({ artifact, location }: Json) => [artifact.url, location?.line, location?.column])

describe('injected scripts (§2 Discovery: injected)', () => {
  test("a loader snippet's constant-src script is an injected reference, and the SDK's findings appear", async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/js/snippet.js"></script>',
      'js/snippet.js': [
        'var n = document.createElement("script");',
        'n.src = "/sdk/sdk.js";',
        'n.async = true;',
        'document.head.appendChild(n);',
      ].join('\n'),
      'sdk/sdk.js': 'window.fetch = function () {}',
    })

    expect(artifacts(report)).toEqual([
      ['https://app.example/js/snippet.js', 'reference', 'script', 'window', 'reference', 'https://app.example/'],
      ['https://app.example/sdk/sdk.js', 'injected', 'script', 'window', 'reference', 'https://app.example/js/snippet.js'],
    ])
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(report.completeness.level).toBe('complete')
  })
})

describe('computed worker URLs (§2 Computed URLs)', () => {
  test('`new Worker(new URL("./w.js", import.meta.url))` discovers the worker in its realm', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="/js/app.js"></script>',
      'js/app.js': 'const w = new Worker(new URL("./w.js", import.meta.url))',
      'js/w.js': 'self.fetch = function () {}',
    })

    expect(artifacts(report)).toEqual([
      ['https://app.example/js/app.js', 'reference', 'module', 'window', 'reference', 'https://app.example/'],
      ['https://app.example/js/w.js', 'reference', 'script', 'dedicated-worker', 'reference', 'https://app.example/js/app.js'],
    ])
    expect(fingerprints(report)).toEqual(['dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown'])
    expect(report.completeness.level).toBe('complete')
  })
})

describe('URLs that do not fold (§13 unresolved-reference)', () => {
  test('a non-literal injected `src` or worker URL gives `unresolved-reference` at the URL', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/js/app.js"></script>',
      'js/app.js': [
        'function load(u) { var s = document.createElement("script"); s.src = u; document.body.appendChild(s) }',
        'load(config.sdk)',
        'new Worker(config.worker)',
      ].join('\n'),
    })

    // The injected script's record is at its `src`, whose value comes from `load`'s caller.
    expect(records(report, 'unresolved-reference')).toEqual([
      ['https://app.example/js/app.js', 1, 69],
      ['https://app.example/js/app.js', 3, 11],
    ])
    expect(report.completeness.counters.blindSpots.unresolvedReference).toBe(2)
    expect(report.completeness.level).toBe('complete-with-limitations')
  })

  test('each constant alternative is a reference, and each unknown alternative one `unresolved-reference`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/js/app.js"></script>',
      'js/app.js': [
        'new Worker(legacy ? "/w-es5.js" : "/w.js")',
        'var s = document.createElement("script"); s.src = cdn ? "https://cdn.x/sdk.js" : "/sdk.js"; document.head.appendChild(s)',
        'var blob = new Blob(["self.fetch = f"]); new Worker(t.workerUrl || URL.createObjectURL(blob))',
      ].join('\n'),
      'w-es5.js': 'self.fetch = f',
      'w.js': 'self.fetch = g',
      'sdk.js': 'window.fetch = h',
    })

    expect(artifacts(report)).toEqual([
      ['https://app.example/js/app.js', 'reference', 'script', 'window', 'reference', 'https://app.example/'],
      ['https://app.example/sdk.js', 'injected', 'script', 'window', 'reference', 'https://app.example/js/app.js'],
      ['https://app.example/w-es5.js', 'reference', 'script', 'dedicated-worker', 'reference', 'https://app.example/js/app.js'],
      ['https://app.example/w.js', 'reference', 'script', 'dedicated-worker', 'reference', 'https://app.example/js/app.js'],
      ['https://cdn.x/sdk.js', 'injected', 'script', 'window', 'reference', 'https://app.example/js/app.js'],
    ])
    // The Datadog shape: one record for `t.workerUrl`, one for the blob URL, whose code is never analyzed.
    expect(records(report, 'unresolved-reference')).toEqual([
      ['https://app.example/js/app.js', 3, 52],
      ['https://app.example/js/app.js', 3, 67],
    ])
    expect(records(report, 'offline-skipped')).toEqual([['https://cdn.x/sdk.js', undefined, undefined]])
    expect(fingerprints(report)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown',
      'window|Window.fetch|replace|unknown',
    ])
  })

  test('either side of `&&` may be the URL, so an unknown left side is an unknown alternative', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/js/app.js"></script>',
      'js/app.js': 'new Worker(config.useWorker && "/w.js")',
      'w.js': '',
    })

    expect(artifacts(report)).toContainEqual([
      'https://app.example/w.js',
      'reference',
      'script',
      'dedicated-worker',
      'reference',
      'https://app.example/js/app.js',
    ])
    expect(records(report, 'unresolved-reference')).toEqual([['https://app.example/js/app.js', 1, 11]])
  })

  test('a `createObjectURL` worker URL gives one `unresolved-reference`, and the blob code is never analyzed', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/js/app.js"></script>',
      'js/app.js': 'var Gn = new Blob([Vn]); var t = (self.URL || self.webkitURL).createObjectURL(Gn); new Worker(t, { name: "r" })',
    })

    expect(records(report, 'unresolved-reference')).toEqual([['https://app.example/js/app.js', 1, 94]])
    expect(report.artifacts).toHaveLength(1)
    expect(report.findings).toEqual([])
    expect(report.completeness.level).toBe('complete-with-limitations')
  })
})

describe('worker URLs that fold to one constant', () => {
  test('folded strings, `new URL(x, base)` with any known base, `.href` and `toString()` are references', async () => {
    const { report } = await scanBuild({
      'index.html': '<base href="/app/"><script src="/js/app.js"></script>',
      'js/app.js': [
        'const b = "/js/"; new Worker(b + "a.js")',
        'new Worker(new URL("b.js", location.href))',
        'new SharedWorker(new URL("c.js", document.baseURI).href)',
        'new Worker(new URL("/js/d.js", "https://app.example/").toString())',
        'const u = new URL("e.js", self.location); new Worker(u.href)',
        'navigator.serviceWorker.register(`${b}sw.js`)',
        'new Worker(new URL("x.js"))',
      ].join('\n'),
      'js/a.js': 'importScripts(self.base + "lib.js")',
      'js/lib.js': '',
      'app/b.js': 'importScripts(new URL("f.js", location).href)',
      'app/f.js': '',
      'app/c.js': '',
      'js/d.js': '',
      'app/e.js': '',
      'js/sw.js': '',
    })

    expect(artifacts(report).filter(([, , , realm]: Json) => realm !== 'window')).toEqual([
      ['https://app.example/app/b.js', 'reference', 'script', 'dedicated-worker', 'reference', 'https://app.example/js/app.js'],
      ['https://app.example/app/c.js', 'reference', 'script', 'shared-worker', 'reference', 'https://app.example/js/app.js'],
      ['https://app.example/app/e.js', 'reference', 'script', 'dedicated-worker', 'reference', 'https://app.example/js/app.js'],
      // A worker's `location` is its own URL.
      ['https://app.example/app/f.js', 'reference', 'script', 'dedicated-worker', 'reference', 'https://app.example/app/b.js'],
      ['https://app.example/js/a.js', 'reference', 'script', 'dedicated-worker', 'reference', 'https://app.example/js/app.js'],
      ['https://app.example/js/d.js', 'reference', 'script', 'dedicated-worker', 'reference', 'https://app.example/js/app.js'],
      ['https://app.example/js/sw.js', 'reference', 'script', 'service-worker', 'reference', 'https://app.example/js/app.js'],
    ])
    // `self.base` doesn't fold, and `new URL("x.js")` throws, which gives nothing (Principle 1).
    expect(records(report, 'unresolved-reference')).toEqual([['https://app.example/js/a.js', 1, 14]])
  })

  test('`navigator.serviceWorker.register(new URL("./sw.js", import.meta.url))` is a service-worker reference', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="/js/app.js"></script>',
      'js/app.js': 'navigator.serviceWorker.register(new URL("./sw.js", import.meta.url), { type: "module" })',
      'js/sw.js': 'self.fetch = f; export {}',
    })

    expect(artifacts(report)).toContainEqual([
      'https://app.example/js/sw.js',
      'reference',
      'module',
      'service-worker',
      'reference',
      'https://app.example/js/app.js',
    ])
    expect(fingerprints(report)).toEqual(['service-worker|ServiceWorkerGlobalScope.fetch|replace|unknown'])
    expect(report.completeness.level).toBe('complete')
  })
  test("a worker URL built with a chunk loader's URL function is a worker reference (webpack 5's `new Worker(new URL(…))`)", async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/js/app.js"></script>',
      'js/app.js': [
        'var n = {}; (() => { n.p = "/js/" })(); n.u = (e) => "" + e + "." + { 123: "abc" }[e] + ".js";',
        '(() => { n.b = document.baseURI || self.location.href })();',
        'new Worker(new URL(n.p + n.u(123), n.b), { type: undefined });',
      ].join('\n'),
      'js/123.abc.js': 'self.fetch = function () {}',
    })

    expect(artifacts(report)).toContainEqual([
      'https://app.example/js/123.abc.js',
      'reference',
      'script',
      'dedicated-worker',
      'reference',
      'https://app.example/js/app.js',
    ])
    expect(fingerprints(report)).toEqual(['dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown'])
    expect(report.completeness.level).toBe('complete')
  })
})

describe('what inserts a script element and its type', () => {
  test('every insertion method on any receiver inserts it, with `src` set before or after', async () => {
    const insert = (name: string, call: string) =>
      `(function () { var s = document.createElement("script"); s.src = "/sdk/${name}.js"; ${call} })();`
    const { report } = await scanBuild({
      'index.html': '<script src="/js/app.js"></script>',
      'js/app.js': [
        // Clarity's and Segment's shapes.
        'var n = document.createElement("script"); n.src = "/sdk/clarity.js"; n.async = !0; document.head.appendChild(n);',
        '(function () { var o = window.document.createElement("script"); o.type = "text/javascript"; o.src = "/sdk/segment.js";',
        '  var d = document.querySelector("script"); d ? d.parentElement.insertBefore(o, d) : document.head.appendChild(o) })();',
        insert('append', 'parent.append("x", s)'),
        insert('prepend', 'unknown().prepend(s)'),
        insert('before', 'ref.before(s)'),
        insert('after', 'ref.after(s)'),
        insert('replace-with', 'old.replaceWith(s)'),
        insert('adjacent', 'ref.insertAdjacentElement("afterend", s)'),
        insert('replace-child', 'p.replaceChild(s, old)'),
        '(function () { var s = document.createElement("script"); document.head.appendChild(s); s.src = "/sdk/after.js" })();',
        // Never shown inserted, or not as a node argument.
        '(function () { var s = document.createElement("script"); s.src = "/sdk/kept.js"; keep(s) })();',
        '(function () { var s = document.createElement("script"); s.src = "/sdk/receiver.js"; s.appendChild(x) })();',
        '(function () { var s = document.createElement("script"); s.src = "/sdk/position.js"; p.insertAdjacentElement(s, x) })();',
      ].join('\n'),
      ...Object.fromEntries(
        ['clarity', 'segment', 'append', 'prepend', 'before', 'after', 'replace-with', 'adjacent', 'replace-child', 'kept', 'receiver', 'position'].map(
          (name) => [`sdk/${name}.js`, ''],
        ),
      ),
    })

    const injected = report.artifacts.filter(({ discovery }: Json) => discovery === 'injected').map(({ url }: Json) => url)
    expect(injected).toEqual(
      ['adjacent', 'after', 'append', 'before', 'clarity', 'prepend', 'replace-child', 'replace-with', 'segment'].map(
        (name) => `https://app.example/sdk/${name}.js`,
      ),
    )
  })

  test("the element's type decides its source type, and an attribute key that doesn't fold touches neither", async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/js/app.js"></script>',
      'js/app.js': [
        '(function () { var s = document.createElement("script"); s.type = "module"; s.src = "/m.js"; document.head.appendChild(s) })();',
        '(function () { var s = document.createElement("script"); s.setAttribute("TYPE", "text/plain"); s.src = "/ignored.js"; document.head.appendChild(s) })();',
        // A browser runs no script of an ignored type, so its `src` that doesn't fold is no `unresolved-reference`.
        '(function () { var s = document.createElement("script"); s.type = "text/template"; s.src = config.x; document.head.appendChild(s) })();',
        '(function (e) { var s = document.createElement("script"); s.src = "/c.js";',
        '  for (var k in e) s.setAttribute(k, e[k]); document.head.appendChild(s) })(opts);',
      ].join('\n'),
      // In a module, a top-level `var fetch` binds no property of the global object.
      'm.js': 'var fetch = function () {}; export {}',
      'ignored.js': 'window.fetch = f',
      'c.js': 'window.alert = f',
    })

    expect(artifacts(report).filter(([, discovery]: Json) => discovery !== 'sweep')).toEqual([
      ['https://app.example/c.js', 'injected', 'script', 'window', 'reference', 'https://app.example/js/app.js'],
      ['https://app.example/js/app.js', 'reference', 'script', 'window', 'reference', 'https://app.example/'],
      ['https://app.example/m.js', 'injected', 'module', 'window', 'reference', 'https://app.example/js/app.js'],
    ])
    expect(fingerprints(report)).toContain('window|Window.alert|replace|unknown')
    expect(report.completeness.limitations).toEqual([])
    expect(fingerprints(report).filter((print: string) => print.includes('fetch'))).toEqual(
      // The ignored script is still swept, as a file only the sweep finds.
      ['window|Window.fetch|replace|unknown'],
    )
  })
})

describe("an injected script's realm and base URL", () => {
  test('a swept creator injects a script with a `reference` basis, resolved against its own URL', async () => {
    const { report } = await scanBuild({
      'index.html': '<p>no scripts</p>',
      'js/loader.js': 'var s = document.createElement("script"); s.src = "sdk.js"; document.head.appendChild(s)',
      // Worker markers, which would raise `realm-uncertain` for an assumed realm.
      'js/sdk.js': 'importScripts; self.addEventListener("message", f); window.fetch = f',
    })

    expect(artifacts(report)).toEqual([
      ['https://app.example/js/loader.js', 'sweep', 'script', 'window', 'assumed', null],
      ['https://app.example/js/sdk.js', 'injected', 'script', 'window', 'reference', 'https://app.example/js/loader.js'],
    ])
    expect(records(report, 'realm-uncertain')).toEqual([])
    const [finding] = report.findings
    expect(finding.fingerprint).toBe('window|Window.fetch|replace|unknown')
    expect(finding.confidence.target.level).toBe('high')
  })

  test("a relative `src` resolves against each referencing document's base URL", async () => {
    const { report } = await scanBuild(
      {
        'a.html': '<base href="/a/"><script src="/js/loader.js"></script>',
        'b.html': '<base href="/b/"><script src="/js/loader.js"></script>',
        'js/loader.js': 'var s = document.createElement("script"); s.src = "sdk.js"; document.head.appendChild(s)',
        'a/sdk.js': '',
        'b/sdk.js': '',
      },
      ['--entry', 'a.html@https://app.example/a.html', '--entry', 'b.html@https://app.example/b.html'],
    )

    expect(report.artifacts.filter(({ discovery }: Json) => discovery === 'injected').map(({ url }: Json) => url)).toEqual([
      'https://app.example/a/sdk.js',
      'https://app.example/b/sdk.js',
    ])
  })
})

describe("an injected element's literal code", () => {
  test('literal text, once inserted, is global nested code located in the host artifact', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/js/app.js"></script>',
      'js/app.js': [
        'var s = document.createElement("script"); s.text = "window.fetch=w"; document.head.appendChild(s);',
        '(function () { var t = document.createElement("script"); t.textContent = "var alert = 1; alert = a"; document.body.append(t) })();',
        '(function () { var t = document.createElement("script"); t.appendChild(document.createTextNode("history.pushState = p")); document.body.appendChild(t) })();',
        // Never inserted: nothing runs.
        '(function () { var t = document.createElement("script"); t.innerText = "window.open = o" })();',
      ].join('\n'),
    })

    expect(fingerprints(report)).toEqual([
      'window|Window.alert|replace|unknown',
      'window|Window.fetch|replace|unknown',
      'window|history.pushState|replace|unknown',
    ])
    const fetch = report.findings.find(({ fingerprint }: Json) => fingerprint.includes('fetch'))
    const [occurrence] = fetch.occurrences
    expect(occurrence.artifact.url).toBe('https://app.example/js/app.js')
    expect(occurrence.generated.line).toBe(1)
    expect(occurrence.trace).toContainEqual(expect.objectContaining({ kind: 'note', about: 'nested-code', callee: 'script', scope: 'global' }))
    expect(report.completeness.level).toBe('complete')
  })

  test('non-literal text gives `dynamic-code`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/js/app.js"></script>',
      'js/app.js': 'var s = document.createElement("script"); s.text = code; document.head.appendChild(s)',
    })

    expect(records(report, 'dynamic-code')).toEqual([['https://app.example/js/app.js', 1, 51]])
    expect(report.completeness.level).toBe('complete-with-limitations')
  })
})

describe('separate programs (§6, ADR 0015)', () => {
  test('the snippet and the SDK it injects are separate link groups, with no global links', async () => {
    const groups: string[][] = []
    const resolver: Resolver = {
      analyzerVersion: jsResolver.analyzerVersion,
      analyzeGroup(input: AnalyzeGroupInput) {
        const output = jsResolver.analyzeGroup(input)
        groups.push(output.members.map(({ url }) => url))
        return output
      },
    }

    const { report } = await scanBuild(
      {
        'index.html': '<script src="/js/snippet.js"></script>',
        'js/snippet.js': 'var name = "fetch"; var s = document.createElement("script"); s.src = "/sdk.js"; document.head.appendChild(s)',
        // `name` is the snippet's global: only a global link would make this `Window.fetch`.
        'sdk.js': 'window[name] = f',
      },
      [],
      { deps: { resolver } },
    )

    expect(groups).toContainEqual(['https://app.example/js/snippet.js'])
    expect(groups).toContainEqual(['https://app.example/sdk.js'])
    expect(groups.every((members) => members.length === 1)).toBe(true)
    expect(fingerprints(report)).not.toContain('window|Window.fetch|replace|unknown')
  })
})

describe("a constant `integrity` code sets on an injected script (§17 Integrity)", () => {
  const sdk = 'window.fetch = f'
  const sha384 = `sha384-${createHash('sha384').update(sdk).digest('base64')}`
  const scanWith = (integrity: string) =>
    scanBuild(
      {
        'index.html': '<script src="/js/snippet.js"></script>',
        'js/snippet.js': [
          'var s = document.createElement("script"); s.src = "https://cdn.example/sdk.js";',
          `s.integrity = ${integrity}; document.head.appendChild(s)`,
        ].join('\n'),
      },
      ['--mode', 'resolve'],
      {
        deps: {
          resolveFetcher: () =>
            fixtureFetcher({ 'https://cdn.example/sdk.js': { headers: { 'content-type': 'text/javascript' }, body: sdk } }),
        },
      },
    )
  const sdkOf = (report: Json) => report.artifacts.find(({ url }: Json) => url === 'https://cdn.example/sdk.js')

  test('a matching value is verified, and the bytes are analyzed', async () => {
    const { report } = await scanWith(JSON.stringify(sha384))

    expect(sdkOf(report).retrieval.sri).toMatchObject({ result: 'match' })
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|url:https://cdn.example/sdk.js'])
    expect(report.completeness.level).toBe('complete')
  })

  test('a mismatch is `sri-mismatch`, with the bytes withheld and no findings', async () => {
    const { report } = await scanWith(JSON.stringify(sha384.replace(/^sha384-.{4}/, 'sha384-AAAA')))

    expect(sdkOf(report).retrieval.sri).toMatchObject({ result: 'mismatch' })
    expect(records(report, 'sri-mismatch')).toEqual([['https://cdn.example/sdk.js', undefined, undefined]])
    expect(report.findings).toEqual([])
    expect(report.completeness.level).toBe('incomplete')
  })

  test('a value that does not fold counts as none', async () => {
    const { report } = await scanWith('config.integrity')

    expect(sdkOf(report).retrieval.sri).toBe('none')
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|url:https://cdn.example/sdk.js'])
  })
})

describe("a chunk loader's script elements (§2)", () => {
  /** A webpack-style runtime whose script loader `n.l` takes the chunk URL as a parameter, with public path `p`. */
  const runtime = (p: string) =>
    [
      'var n = {};',
      `n.p = ${p};`,
      'n.u = function (e) { return "js/" + { 1: "lazy" }[e] + ".chunk.js" };',
      'n.l = function (r, done) { var s = document.createElement("script"); s.charset = "utf-8"; s.src = r; document.head.appendChild(s) };',
      'n.e = function (e) { n.l(n.p + n.u(e), function () {}) };',
      'self.webpackChunk = self.webpackChunk || [];',
    ].join('\n')

  test('a chunk URL a parameter carries is a chunk load, not an injected script', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/main.js"></script>',
      'main.js': runtime('"/"'),
      'js/lazy.chunk.js': '',
    })

    expect(artifacts(report)).toEqual([
      ['https://app.example/js/lazy.chunk.js', 'reference', 'script', 'window', 'reference', 'https://app.example/main.js'],
      ['https://app.example/main.js', 'reference', 'script', 'window', 'reference', 'https://app.example/'],
    ])
    expect(report.completeness.limitations).toEqual([])
  })

  test("a local loader's chunk URL that doesn't fold is exempt, and a remote prefix gives `unresolved-reference`", async () => {
    const local = await scanBuild({ 'index.html': '<script src="/main.js"></script>', 'main.js': runtime('config.publicPath') })
    expect(local.report.completeness.limitations).toEqual([])

    const remote = await scanBuild({
      'index.html': '<script src="/main.js"></script>',
      'main.js': runtime('"https://cdn.other/" + config.version + "/"'),
    })
    expect(records(remote.report, 'unresolved-reference')).toEqual([['https://app.example/main.js', 4, 98]])
  })
})

// Worker references: scope, types and origins (§2 Discovery, as the human answered live on 2026-09-27).

import { describe, expect, test } from 'vitest'
import type { Fetcher } from '../src/packages/source-store/index.ts'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** The artifacts references found: URL and realm. */
const referenced = (report: Json) =>
  report.artifacts
    .filter(({ discovery }: Json) => discovery === 'reference')
    .map(({ url, realm }: Json) => [url, realm])

/** The URLs of the artifacts only the build-directory sweep found (§2 Sweep). */
const swept = (report: Json) =>
  report.artifacts.filter(({ discovery }: Json) => discovery === 'sweep').map(({ url }: Json) => url)

/** Each artifact's path under `https://app.example/`, and its source type. */
const sourceTypes = (report: Json) =>
  report.artifacts.map(({ url, sourceType }: Json) => [url.slice('https://app.example/'.length), sourceType])

/** Distinct bytes for each named file, so that content addressing keeps each its own artifact. */
const files = (...names: string[]) => Object.fromEntries(names.map((name) => [`${name}.js`, `// ${name}`]))

describe('a worker call is dropped only when a declaration of its root name is in scope at the call (§2)', () => {
  test("`var self = this` in one function doesn't drop `new self.Worker` elsewhere; a `navigator` parameter drops the call inside its function", async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': [
        'function init() { var self = this; self.ready = true }',
        "new self.Worker('/w.js')",
        "function register(navigator) { navigator.serviceWorker.register('/sw.js') }",
        "navigator.serviceWorker.register('/sw-global.js')",
      ].join('\n'),
      ...files('w', 'sw', 'sw-global'),
    })

    expect(referenced(report)).toEqual([
      ['https://app.example/app.js', 'window'],
      ['https://app.example/sw-global.js', 'service-worker'],
      ['https://app.example/w.js', 'dedicated-worker'],
    ])
    expect(swept(report)).toEqual(['https://app.example/sw.js'])
  })

  test("in scope is ECMAScript's scoping: hoisted `var`s and functions, block-scoped `let`, catch parameters, own names, loop heads and imports", async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script><script type="module" src="mod.js"></script>',
      'app.js': [
        // A `var` belongs to its function, wherever in it; a `let` only to its block.
        'function a() { if (x) { var Worker = W } new Worker("a.js") }',
        'function b() { { let Worker = W } new Worker("b.js") }',
        // A catch clause's parameter is in scope in its block only.
        'function c() {',
        '  try {} catch (navigator) { navigator.serviceWorker.register("c.js") }',
        '  navigator.serviceWorker.register("c2.js")',
        '}',
        // A function expression's and a class's own name are in scope inside them.
        'var d = function self() { new self.Worker("d.js") }',
        'var e = class Worker { static w = new Worker("e.js") }',
        // A switch statement's discriminant is outside its case block; a loop's head is inside its scope.
        'switch (new Worker("f.js")) { case 1: let Worker }',
        'for (const Worker of []) new Worker("g.js")',
        // A function declaration is hoisted; in sloppy code, one in a block is also its function's (Annex B), but not
        // in strict code.
        'function h() { new Worker("h.js"); function Worker() {} }',
        'function i() { if (x) { function Worker() {} } new Worker("i.js") }',
        'function j() { "use strict"; if (x) { function Worker() {} } new Worker("j.js") }',
        // A function's parameter list sees its parameters, but not what its body declares.
        'function m(w = new Worker("m.js")) { var Worker = W }',
        'function n(Worker, w = new Worker("n.js")) {}',
      ].join('\n'),
      'mod.js': [
        'import { Worker } from "./lib.js"',
        'new Worker("k.js")',
        'export function l(navigator) { navigator.serviceWorker.register("l.js") }',
      ].join('\n'),
      'lib.js': 'export class Worker {}',
      ...files('a', 'b', 'c', 'c2', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n'),
    })

    expect(referenced(report)).toEqual([
      ['https://app.example/app.js', 'window'],
      ['https://app.example/b.js', 'dedicated-worker'],
      ['https://app.example/c2.js', 'service-worker'],
      ['https://app.example/f.js', 'dedicated-worker'],
      ['https://app.example/j.js', 'dedicated-worker'],
      ['https://app.example/lib.js', 'window'],
      ['https://app.example/m.js', 'dedicated-worker'],
      ['https://app.example/mod.js', 'window'],
    ])
    const dropped = ['a', 'c', 'd', 'e', 'g', 'h', 'i', 'k', 'l', 'n']
    expect(swept(report)).toEqual(dropped.map((name) => `https://app.example/${name}.js`))
  })
})

describe("a worker whose options can't be read statically takes its `sourceType` by syntax (§2)", () => {
  test('`new Worker(url, opts)` with a module-syntax script parses it as a module, with no `parse-failure`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': "new Worker('/w.js', opts); new Worker('/classic.js', opts)",
      'w.js': 'import "./dep.js"\nself.fetch = f',
      'dep.js': 'export {}',
      'classic.js': 'importScripts("lib.js")',
      'lib.js': 'self.setTimeout = g',
    })

    expect(report.artifacts.map(({ url, sourceType, realm }: Json) => [url, sourceType, realm])).toEqual([
      ['https://app.example/app.js', 'script', 'window'],
      ['https://app.example/classic.js', 'script', 'dedicated-worker'],
      ['https://app.example/dep.js', 'module', 'dedicated-worker'],
      ['https://app.example/lib.js', 'script', 'dedicated-worker'],
      ['https://app.example/w.js', 'module', 'dedicated-worker'],
    ])
    expect(report.completeness.limitations).toEqual([])
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown',
      'dedicated-worker|DedicatedWorkerGlobalScope.setTimeout|replace|unknown',
    ])
  })

  test('options can\'t be read when they are an expression, or when a spread, a computed key or `__proto__` may set `type`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': [
        "new Worker('/a.js', { ...opts }); new Worker('/b.js', { type })",
        "new Worker('/c.js', { type: 'module', ...opts }); new Worker('/d.js', { ...opts, type: 'module' })",
        "new Worker('/e.js', { [key]: v }); new Worker('/f.js', { __proto__: base })",
        "new SharedWorker('/g.js', name); new SharedWorker('/h.js', 'name')",
        "new Worker('/i.js', { __proto__: null, type: 'module' })",
      ].join('\n'),
      // Module syntax for the options that can't be read, and classic syntax where the options decide otherwise.
      'a.js': 'export const a = 1',
      'b.js': 'export const b = 1',
      'c.js': 'self.c = 1',
      'd.js': 'self.d = 1',
      'e.js': 'export const e = 1',
      'f.js': 'export const f = 1',
      'g.js': 'export const g = 1',
      'h.js': 'self.h = 1',
      'i.js': 'self.i = 1',
    })

    expect(sourceTypes(report)).toEqual([
      ['a.js', 'module'],
      ['app.js', 'script'],
      ['b.js', 'module'],
      ['c.js', 'script'],
      ['d.js', 'module'],
      ['e.js', 'module'],
      ['f.js', 'module'],
      ['g.js', 'module'],
      ['h.js', 'script'],
      ['i.js', 'module'],
    ])
    expect(report.completeness.limitations).toEqual([])
  })
})

describe('options that can be read keep their type (§2)', () => {
  test('`undefined`, `void 0` and literals give the default, a classic script, even over a prototype, but a declared `undefined` can be anything', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': [
        "new Worker('/a.js', undefined); new Worker('/b.js', void 0); new Worker('/c.js', { type: undefined })",
        "new SharedWorker('/d.js', `tab-${n}`); new Worker('/e.js', null)",
        "function f(undefined) { new Worker('/g.js', undefined) }",
        // An own `type` hides any the prototype has.
        "new Worker('/h.js', { __proto__: base, type: undefined })",
      ].join('\n'),
      // Module syntax throughout: a classic script that doesn't parse shows the options were read.
      ...Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e', 'g', 'h'].map((name) => [`${name}.js`, `export const ${name} = 1`]),
      ),
    })

    expect(sourceTypes(report)).toEqual([
      ['a.js', 'script'],
      ['app.js', 'script'],
      ['b.js', 'script'],
      ['c.js', 'script'],
      ['d.js', 'script'],
      ['e.js', 'script'],
      ['g.js', 'module'],
      ['h.js', 'script'],
    ])
  })
})

describe('worker URLs by origin (§2)', () => {
  test("a cross-origin dedicated or shared worker URL gives no artifact and no record; a same-origin one outside the mappings is a remote reference", async () => {
    const { report } = await scanBuild(
      {
        'index.html': '<script src="/static/app.js"></script>',
        'static/app.js': [
          "new Worker('https://other.example/w.js')",
          "new SharedWorker('https://other.example/s.js', { type: 'module' })",
          // A URL a mapping serves is still cross-origin when the page's origin isn't the URL's.
          "new Worker('https://cdn.example/cdn-worker.js')",
          "new Worker('/outside.js')",
        ].join('\n'),
        'cdn/cdn-worker.js': 'self.fetch = f',
      },
      [
        ...['--map', 'https://app.example/static/=static', '--map', 'https://cdn.example/=cdn'],
        ...['--entry', 'index.html@https://app.example/'],
      ],
    )

    expect(report.artifacts.map(({ url, realm, origin, discovery }: Json) => [url, realm, origin, discovery])).toEqual([
      ['https://app.example/outside.js', 'dedicated-worker', 'same-origin', 'reference'],
      ['https://app.example/static/app.js', 'window', 'local-build', 'reference'],
      // Only the sweep finds the build's file that no reference runs.
      ['https://cdn.example/cdn-worker.js', 'window', 'local-build', 'sweep'],
    ])
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
      ['offline-skipped', 'https://app.example/outside.js'],
    ])
  })

  test('a service worker is judged by the mappings alone: one on another origin that a mapping serves is still followed', async () => {
    const { report } = await scanBuild(
      {
        'index.html': '<script src="/static/app.js"></script>',
        'static/app.js': "navigator.serviceWorker.register('https://cdn.example/sw.js')",
        'cdn/sw.js': 'self.fetch = f',
      },
      [
        ...['--map', 'https://app.example/static/=static', '--map', 'https://cdn.example/=cdn'],
        ...['--entry', 'index.html@https://app.example/'],
      ],
    )

    expect(report.artifacts.map(({ url, realm, discovery }: Json) => [url, realm, discovery])).toEqual([
      ['https://app.example/static/app.js', 'window', 'reference'],
      ['https://cdn.example/sw.js', 'service-worker', 'reference'],
    ])
    expect(report.completeness.limitations).toEqual([])
  })
})

describe("a `data:` worker URL is decoded and analyzed in the worker's realm with origin `inline` (§2)", () => {
  test('dedicated and shared `data:` workers are inline artifacts of their realms, and their writes are findings there', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/app.js"></script>',
      'app.js': [
        "new Worker('data:text/javascript,self.fetch=f')",
        "new SharedWorker('data:text/javascript,self.close=c', { type: 'classic' })",
      ].join('\n'),
    })

    const artifacts = report.artifacts.map(({ url, realm, origin, discovery, parent }: Json) => [
      url,
      realm,
      origin,
      discovery,
      parent,
    ])
    expect(artifacts).toEqual([
      ['data:text/javascript,self.close=c', 'shared-worker', 'inline', 'reference', 'https://app.example/app.js'],
      ['data:text/javascript,self.fetch=f', 'dedicated-worker', 'inline', 'reference', 'https://app.example/app.js'],
      ['https://app.example/app.js', 'window', 'local-build', 'reference', 'https://app.example/'],
    ])
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|inline',
      'shared-worker|SharedWorkerGlobalScope.close|replace|inline',
    ])
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
  })

  test("with options that can't be read, a `data:` worker is typed by its syntax, and a module needs a JavaScript MIME type", async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/app.js"></script>',
      'app.js': [
        "new Worker('data:text/javascript,import.meta; self.fetch = f', options)",
        "new Worker('data:text/javascript,self.close = c', options)",
        // A module that isn't JavaScript is refused, and read as a classic script it doesn't parse: nothing of it runs.
        "new Worker('data:text/plain,export {}; self.postMessage = p', options)",
      ].join('\n'),
    })

    expect(report.artifacts.map(({ url, sourceType, realm }: Json) => [url, sourceType, realm])).toEqual([
      ['data:text/javascript,import.meta; self.fetch = f', 'module', 'dedicated-worker'],
      ['data:text/javascript,self.close = c', 'script', 'dedicated-worker'],
      ['https://app.example/app.js', 'script', 'window'],
    ])
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.close|replace|inline',
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|inline',
    ])
    expect(report.completeness.limitations).toEqual([])
  })

  test("a `data:` worker's origin is its own, so the workers it creates are followed only from `data:` URLs", async () => {
    // A `data:` worker runs with an opaque origin (HTML § The Worker constructor), which no `http:` or `https:` URL
    // shares, so a browser refuses every worker script it names but a `data:` one. `importScripts` has no such check.
    const inner = [
      'new Worker("https://app.example/static/nested.js")',
      'new Worker("data:text/javascript,self.close=c")',
      'importScripts("https://app.example/static/imported.js")',
    ].join(';')
    const { report } = await scanBuild(
      {
        'index.html': '<script src="/static/app.js"></script>',
        'static/app.js': `new Worker('data:text/javascript,${inner}')`,
        'static/nested.js': 'self.fetch = f',
        'static/imported.js': 'self.postMessage = p',
      },
      ['--map', 'https://app.example/static/=static', '--entry', 'index.html@https://app.example/'],
    )

    expect(report.artifacts.map(({ url, realm, discovery }: Json) => [url, realm, discovery])).toEqual([
      [`data:text/javascript,${inner}`, 'dedicated-worker', 'reference'],
      ['data:text/javascript,self.close=c', 'dedicated-worker', 'reference'],
      ['https://app.example/static/app.js', 'window', 'reference'],
      ['https://app.example/static/imported.js', 'dedicated-worker', 'reference'],
      // Only the sweep finds the build's file that no reference runs.
      ['https://app.example/static/nested.js', 'window', 'sweep'],
    ])
    expect(report.completeness.limitations).toEqual([])
  })
})

describe('`<link rel=modulepreload as=serviceworker>` outside every mapping (§2, §13)', () => {
  test("gives an `unresolved-reference` naming the entry document, like `register`, and no artifact", async () => {
    const { report } = await scanBuild(
      {
        'index.html': [
          '<link rel="modulepreload" as="serviceworker" href="/sw.js">',
          '<link rel="modulepreload" as="serviceworker" href="/static/sw.js">',
          // A dedicated worker's module outside the mappings is still a remote reference.
          '<link rel="modulepreload" as="worker" href="/w.js">',
        ].join(''),
        'static/sw.js': 'export {}',
      },
      ['--map', 'https://app.example/static/=static', '--entry', 'index.html@https://app.example/'],
    )

    expect(report.artifacts.map(({ url, realm, discovery }: Json) => [url, realm, discovery])).toEqual([
      ['https://app.example/static/sw.js', 'service-worker', 'reference'],
      ['https://app.example/w.js', 'dedicated-worker', 'reference'],
    ])
    expect(report.completeness.limitations).toEqual([
      {
        kind: 'unresolved-reference',
        artifact: { url: 'https://app.example/', path: 'index.html' },
        detail: expect.stringContaining('https://app.example/sw.js'),
      },
      { kind: 'offline-skipped', artifact: { url: 'https://app.example/w.js' }, detail: expect.any(String) },
    ])
    expect(report.completeness.counters.blindSpots).toMatchObject({ unresolvedReference: 1 })
  })
})

describe('in resolve mode (§17 What is fetched)', () => {
  test('a same-origin worker outside the mappings is fetched and typed by its syntax; a cross-origin one is never fetched', async () => {
    const fixture = fixtureFetcher({
      'https://app.example/remote/module-worker.js': {
        headers: { 'content-type': 'text/javascript' },
        body: 'import "./dep.js"',
      },
      'https://app.example/remote/dep.js': { headers: { 'content-type': 'text/javascript' }, body: 'self.fetch = f' },
      'https://other.example/w.js': { headers: { 'content-type': 'text/javascript' }, body: 'self.fetch = g' },
    })
    const requested: string[] = []
    const fetcher: Fetcher = { fetch: (url, request) => (requested.push(url), fixture.fetch(url, request)) }

    const { report } = await scanBuild(
      {
        'index.html': '<script src="/static/app.js"></script>',
        'static/app.js': "new Worker('/remote/module-worker.js', options); new Worker('https://other.example/w.js')",
      },
      [
        ...['--mode', 'resolve', '--map', 'https://app.example/static/=static'],
        ...['--entry', 'index.html@https://app.example/'],
      ],
      { deps: { resolveFetcher: () => fetcher } },
    )

    const artifacts = report.artifacts.map(({ url, sourceType, realm, retrieval }: Json) => [
      url,
      sourceType,
      realm,
      retrieval.status,
    ])
    expect(artifacts).toEqual([
      ['https://app.example/remote/dep.js', 'module', 'dedicated-worker', 'ok'],
      ['https://app.example/remote/module-worker.js', 'module', 'dedicated-worker', 'ok'],
      ['https://app.example/static/app.js', 'script', 'window', 'ok'],
    ])
    // The script is asked for as a worker's to learn its syntax, then as a module. The scan's own resolve fetcher
    // requests each URL once (§17 Caching); this stand-in doesn't cache, so only the distinct URLs are compared.
    expect([...new Set(requested)]).toEqual([
      'https://app.example/remote/module-worker.js',
      'https://app.example/remote/dep.js',
    ])
    expect(report.completeness.limitations).toEqual([])
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|url:https://app.example/remote/dep.js',
    ])
  })
})

describe('`data:` workers in resolve mode (§2, §17 What is fetched)', () => {
  test('a `data:` worker is read from its URL, never fetched, even to learn its syntax', async () => {
    const requested: string[] = []
    const fixture = fixtureFetcher({})
    const fetcher: Fetcher = { fetch: (url, request) => (requested.push(url), fixture.fetch(url, request)) }

    const { report } = await scanBuild(
      {
        'index.html': '<script src="/static/app.js"></script>',
        'static/app.js': "new Worker('data:text/javascript,import.meta; self.fetch = f', options)",
      },
      [
        ...['--mode', 'resolve', '--map', 'https://app.example/static/=static'],
        ...['--entry', 'index.html@https://app.example/'],
      ],
      { deps: { resolveFetcher: () => fetcher } },
    )

    expect(report.artifacts.map(({ url, sourceType, origin }: Json) => [url, sourceType, origin])).toEqual([
      ['data:text/javascript,import.meta; self.fetch = f', 'module', 'inline'],
      ['https://app.example/static/app.js', 'script', 'local-build'],
    ])
    expect(requested).toEqual([])
    expect(report.run.retrievals).toEqual({})
  })
})

describe('determinism (§15)', () => {
  test('two scans of copies of a build give byte-identical reports, except run', async () => {
    const files = {
      'index.html': '<link rel="modulepreload" as="serviceworker" href="/sw.js"><script src="/static/app.js"></script>',
      'static/app.js': [
        'function f(navigator) { navigator.serviceWorker.register("/static/a.js") }',
        'new Worker("/static/b.js", options); new Worker("https://other.example/c.js"); new Worker("/d.js")',
        'new Worker("data:text/javascript,import.meta; self.fetch = e", options)',
      ].join('\n'),
      'static/a.js': 'self.fetch = a',
      'static/b.js': 'export {}; self.fetch = b',
    }
    const args = ['--map', 'https://app.example/static/=static', '--entry', 'index.html@https://app.example/']

    const first = await scanBuild(files, args)
    const second = await scanBuild(files, args)

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
    expect(first.report.completeness.limitations.map(({ kind }: Json) => kind)).toEqual([
      'unresolved-reference',
      'offline-skipped',
    ])
  })
})

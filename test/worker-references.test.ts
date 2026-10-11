// Worker references and realms (§2 Discovery and Realm, §4 naming rules: worker globals, §19 Discovery).

import { describe, expect, test } from 'vitest'
import { jsResolver, type AnalyzeGroupInput, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** The JS resolver, recording the entry of each group it analyzes, with its realm, in order. */
function spyResolver(): Resolver & { entries: string[] } {
  const entries: string[] = []
  return {
    entries,
    analyzerVersion: jsResolver.analyzerVersion,
    analyzeGroup(input: AnalyzeGroupInput) {
      entries.push(`${input.entry.realm} ${input.entry.url}`)
      return jsResolver.analyzeGroup(input)
    },
  }
}

/** The artifacts references found, with how. */
const graph = (report: Json) =>
  report.artifacts
    .filter(({ discovery }: Json) => discovery === 'reference')
    .map(({ url, sourceType, realm, parent }: Json) => [url, sourceType, realm, parent])

/** The URLs of the artifacts only the build-directory sweep found (§2 Sweep), as window scripts. */
const swept = (report: Json) =>
  report.artifacts.filter(({ discovery }: Json) => discovery === 'sweep').map(({ url }: Json) => url)

describe('worker references (§2 Discovery, Realm)', () => {
  test('`new Worker` with a literal URL references a dedicated worker, a classic script unless its type is module', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/js/app.js"></script>',
      'js/app.js': 'const a = new Worker("/workers/a.js"); const b = new Worker(`/workers/b.js`, { type: "module" })',
      'workers/a.js': 'postMessage(1)',
      'workers/b.js': 'export {}',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/js/app.js', 'script', 'window', 'https://app.example/'],
      ['https://app.example/workers/a.js', 'script', 'dedicated-worker', 'https://app.example/js/app.js'],
      ['https://app.example/workers/b.js', 'module', 'dedicated-worker', 'https://app.example/js/app.js'],
    ])
    expect(report.completeness.level).toBe('complete')
  })

  test('`new SharedWorker` references a shared worker, and `navigator.serviceWorker.register` a service worker', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script type="module">',
        'new SharedWorker("/shared.js", "tabs"); new SharedWorker("/shared-module.js", { name: "m", type: "module" })',
        'if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" })',
        'navigator.serviceWorker?.register("/sw-module.js", { type: "module" })',
        '</script>',
      ].join('\n'),
      'shared.js': 'self.fetch = f',
      'shared-module.js': 'export {}',
      'sw.js': 'self.fetch = g',
      'sw-module.js': 'export {}',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/#inline-1', 'module', 'window', 'https://app.example/'],
      ['https://app.example/shared-module.js', 'module', 'shared-worker', 'https://app.example/#inline-1'],
      ['https://app.example/shared.js', 'script', 'shared-worker', 'https://app.example/#inline-1'],
      ['https://app.example/sw-module.js', 'module', 'service-worker', 'https://app.example/#inline-1'],
      ['https://app.example/sw.js', 'script', 'service-worker', 'https://app.example/#inline-1'],
    ])
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual([
      'service-worker|ServiceWorkerGlobalScope.fetch|replace|unknown',
      'shared-worker|SharedWorkerGlobalScope.fetch|replace|unknown',
    ])
    expect(report.completeness.level).toBe('complete')
  })

  test("`importScripts` loads classic scripts into its worker's realm, resolved against the worker script's URL", async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="/js/app.js"></script>',
      'js/app.js': 'new Worker("/workers/w.js"); navigator.serviceWorker.register("/sw.js"); importScripts("/window.js")',
      'workers/w.js': 'importScripts("lib/a.js", `lib/b.js`); self.importScripts("c.js")',
      // An imported script's own `importScripts` resolves against its worker's URL, not its own.
      'workers/lib/a.js': 'importScripts("d.js")',
      'workers/lib/b.js': 'self.fetch = f',
      'workers/c.js': '',
      'workers/d.js': 'self.setTimeout = g',
      'sw.js': 'importScripts("workers/lib/b.js")',
      'window.js': 'window.fetch = h',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/js/app.js', 'script', 'window', 'https://app.example/'],
      ['https://app.example/sw.js', 'script', 'service-worker', 'https://app.example/js/app.js'],
      ['https://app.example/workers/c.js', 'script', 'dedicated-worker', 'https://app.example/workers/w.js'],
      ['https://app.example/workers/d.js', 'script', 'dedicated-worker', 'https://app.example/workers/lib/a.js'],
      ['https://app.example/workers/lib/a.js', 'script', 'dedicated-worker', 'https://app.example/workers/w.js'],
      ['https://app.example/workers/lib/b.js', 'script', 'dedicated-worker', 'https://app.example/workers/w.js'],
      ['https://app.example/workers/lib/b.js', 'script', 'service-worker', 'https://app.example/sw.js'],
      ['https://app.example/workers/w.js', 'script', 'dedicated-worker', 'https://app.example/js/app.js'],
    ])
    // The window has no `importScripts`, so only the sweep finds the file it names.
    expect(swept(report)).toEqual(['https://app.example/window.js'])
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown',
      'dedicated-worker|DedicatedWorkerGlobalScope.setTimeout|replace|unknown',
      'service-worker|ServiceWorkerGlobalScope.fetch|replace|unknown',
      'window|Window.fetch|replace|unknown',
    ])
  })

  test('only a realm whose global has the function loads a worker script, and a module worker has no `importScripts`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script>new Worker("module.js", { type: "module" }); new Worker("classic.js")</script>',
      // A module worker's `importScripts` throws, and so does an invalid worker type.
      'module.js': 'importScripts("a.js"); new Worker("b.js", { type: "text/javascript" })',
      // Workers have no `SharedWorker` and no `window`, and a service worker no `Worker`.
      'classic.js': 'new SharedWorker("c.js"); new window.Worker("d.js"); navigator.serviceWorker.register("sw.js")',
      'sw.js': 'new Worker("e.js"); navigator.serviceWorker.register("f.js")',
      ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => [`${name}.js`, `self.fetch = ${name}`])),
    })

    expect(graph(report).map(([url, , realm]: Json) => [url, realm])).toEqual([
      ['https://app.example/#inline-1', 'window'],
      ['https://app.example/classic.js', 'dedicated-worker'],
      ['https://app.example/f.js', 'service-worker'],
      ['https://app.example/module.js', 'dedicated-worker'],
      ['https://app.example/sw.js', 'service-worker'],
    ])
    expect(swept(report)).toEqual(['a', 'b', 'c', 'd', 'e'].map((name) => `https://app.example/${name}.js`))
  })
})

describe('how code names the worker functions (§19 Discovery: syntax only)', () => {
  test('through a global name, a chain or a comma sequence; a URL that is not a literal folds, or is unresolved', async () => {
    const { report } = await scanBuild({
      'index.html': '<script type="module" src="app.js"></script>',
      'app.js': [
        'new window.Worker("a.js"); new globalThis["SharedWorker"]("b.js"); new self.Worker(`c.js`)',
        'window.navigator.serviceWorker.register("d.js"); self.navigator?.serviceWorker.register("e.js")',
        'new Worker(new URL("./x.js", import.meta.url)); new Worker("y" + ".js"); new Worker(url)',
        'Worker("z.js")',
      ].join('\n'),
      'a.js': '(0, self.importScripts)("f.js")',
      // Distinct bytes, so that content addressing keeps each file its own artifact.
      ...Object.fromEntries(['b', 'c', 'd', 'e', 'f', 'x', 'y', 'z'].map((name) => [`${name}.js`, `// ${name}`])),
    })

    expect(graph(report).map(([url, , realm]: Json) => [url, realm])).toEqual([
      ['https://app.example/a.js', 'dedicated-worker'],
      ['https://app.example/app.js', 'window'],
      ['https://app.example/b.js', 'shared-worker'],
      ['https://app.example/c.js', 'dedicated-worker'],
      ['https://app.example/d.js', 'service-worker'],
      ['https://app.example/e.js', 'service-worker'],
      ['https://app.example/f.js', 'dedicated-worker'],
      ['https://app.example/x.js', 'dedicated-worker'],
      ['https://app.example/y.js', 'dedicated-worker'],
    ])
    expect(swept(report)).toEqual(['https://app.example/z.js'])
    expect(report.completeness.limitations.map(({ kind, location }: Json) => [kind, location.line, location.column])).toEqual([
      ['unresolved-reference', 3, 84],
    ])
  })

  test('a name a declaration in scope at the call binds is not the native, so calls through it load nothing', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script><script src="other.js"></script>',
      'app.js': 'class Worker { constructor(job) {} }\nnew Worker("job-a"); navigator.serviceWorker.register("a.js")',
      'other.js': [
        'function f(navigator, { importScripts }, [SharedWorker]) {',
        '  navigator.serviceWorker.register("e.js"); new SharedWorker("f.js")',
        '}',
        'navigator.serviceWorker.register("b.js"); new SharedWorker("c.js"); new Worker("d.js")',
      ].join('\n'),
      ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map((name) => [`${name}.js`, `// ${name}`])),
    })

    expect(graph(report).map(([url, , realm]: Json) => [url, realm])).toEqual([
      ['https://app.example/a.js', 'service-worker'],
      ['https://app.example/app.js', 'window'],
      ['https://app.example/b.js', 'service-worker'],
      ['https://app.example/c.js', 'shared-worker'],
      ['https://app.example/d.js', 'dedicated-worker'],
      ['https://app.example/other.js', 'window'],
    ])
    expect(swept(report)).toEqual(['https://app.example/e.js', 'https://app.example/f.js'])
    expect(report.completeness.level).toBe('complete')
  })
})

describe("module workers' imports (§2 Discovery, Realm)", () => {
  test("are modules in the worker's realm, resolved with the worker's own import map, which is empty", async () => {
    const importMap = '<script type="importmap">{"imports":{"dep":"/dep.js"}}</script>'
    const { report } = await scanBuild({
      'index.html': `${importMap}<script type="module">import "dep"; new Worker("/w/main.js", { type: "module" })</script>`,
      'w/main.js': 'import "./util.js"; import "dep"; import("./lazy.js")',
      'w/util.js': 'self.fetch = f',
      'w/lazy.js': 'export {}',
      'dep.js': 'export {}',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/#inline-2', 'module', 'window', 'https://app.example/'],
      ['https://app.example/dep.js', 'module', 'window', 'https://app.example/#inline-2'],
      ['https://app.example/w/lazy.js', 'module', 'dedicated-worker', 'https://app.example/w/main.js'],
      ['https://app.example/w/main.js', 'module', 'dedicated-worker', 'https://app.example/#inline-2'],
      ['https://app.example/w/util.js', 'module', 'dedicated-worker', 'https://app.example/w/main.js'],
    ])
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
      ['unresolved-reference', 'https://app.example/w/main.js'],
    ])
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown',
    ])
  })

  test('a service worker never follows a dynamic import, which it rejects, but follows its static imports', async () => {
    const { report } = await scanBuild({
      'index.html': '<script>navigator.serviceWorker.register("sw.js", { type: "module" })</script>',
      'sw.js': 'import "./static.js"; import("./dynamic.js"); import(name)',
      'static.js': 'export {}',
      'dynamic.js': 'export {}',
    })

    expect(graph(report).map(([url, sourceType, realm]: Json) => [url, sourceType, realm])).toEqual([
      ['https://app.example/#inline-1', 'script', 'window'],
      ['https://app.example/static.js', 'module', 'service-worker'],
      ['https://app.example/sw.js', 'module', 'service-worker'],
    ])
    expect(swept(report)).toEqual(['https://app.example/dynamic.js'])
    expect(report.completeness.limitations).toEqual([])
  })

  test("`<link rel=modulepreload>` with a worker destination preloads a module in that worker's realm", async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<link rel="modulepreload" as="worker" href="w.js"><link rel="modulepreload" as="SharedWorker" href="s.js">',
        '<link rel="modulepreload" as="serviceworker" href="sw.js">',
      ].join(''),
      'w.js': 'import "./dep.js"',
      'dep.js': 'self.fetch = f',
      's.js': 'export {}',
      'sw.js': 'export {}',
    })

    expect(graph(report)).toEqual([
      ['https://app.example/dep.js', 'module', 'dedicated-worker', 'https://app.example/w.js'],
      ['https://app.example/s.js', 'module', 'shared-worker', 'https://app.example/'],
      ['https://app.example/sw.js', 'module', 'service-worker', 'https://app.example/'],
      ['https://app.example/w.js', 'module', 'dedicated-worker', 'https://app.example/'],
    ])
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown',
    ])
  })
})

describe('one realm per file (§2 Realm, §19 Discovery)', () => {
  test('a worker script in the build directory is analyzed once, as a worker, never also as a window script', async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(
      {
        'index.html': '<script src="app.js"></script>',
        'app.js': 'new Worker("worker.js"); new Worker("./worker.js")',
        'worker.js': 'self.fetch = f',
      },
      [],
      { deps: { resolver } },
    )

    expect(resolver.entries).toEqual(['window https://app.example/app.js', 'dedicated-worker https://app.example/worker.js'])
    expect(graph(report)).toEqual([
      ['https://app.example/app.js', 'script', 'window', 'https://app.example/'],
      ['https://app.example/worker.js', 'script', 'dedicated-worker', 'https://app.example/app.js'],
    ])
    // A file a reference found in any realm is not swept (§2 Sweep).
    expect(swept(report)).toEqual([])
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown',
    ])
  })

  test('a file referenced in two realms runs in each, so it is an artifact, analyzed, in each', async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(
      {
        'index.html': '<script src="shared.js"></script><script>new Worker("worker.js")</script>',
        'worker.js': 'importScripts("shared.js")',
        'shared.js': 'self.fetch = f',
      },
      [],
      { deps: { resolver } },
    )

    expect(resolver.entries).toEqual([
      'window https://app.example/#inline-1',
      'window https://app.example/shared.js',
      'dedicated-worker https://app.example/shared.js',
      'dedicated-worker https://app.example/worker.js',
    ])
    expect(graph(report)).toEqual([
      ['https://app.example/#inline-1', 'script', 'window', 'https://app.example/'],
      ['https://app.example/shared.js', 'script', 'window', 'https://app.example/'],
      ['https://app.example/shared.js', 'script', 'dedicated-worker', 'https://app.example/worker.js'],
      ['https://app.example/worker.js', 'script', 'dedicated-worker', 'https://app.example/#inline-1'],
    ])
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual([
      'dedicated-worker|DedicatedWorkerGlobalScope.fetch|replace|unknown',
      'window|Window.fetch|replace|unknown',
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 4, analyzed: 4 })
  })

  test('a blind spot in a file that runs in two realms is one limitation record (§13)', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="shared.js"></script><script>new Worker("worker.js")</script>',
      'worker.js': 'importScripts("shared.js")',
      'shared.js': 'eval(code)',
    })

    expect(report.artifacts.filter(({ url }: Json) => url === 'https://app.example/shared.js')).toHaveLength(2)
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
      ['dynamic-code', 'https://app.example/shared.js'],
    ])
    expect(report.completeness.counters.blindSpots).toMatchObject({ dynamicCode: 1 })
  })
})

describe('service workers outside the mappings (§2 Discovery, §13)', () => {
  test('a service worker whose script falls outside every URL mapping gives `unresolved-reference`, located at its URL', async () => {
    const { report } = await scanBuild(
      {
        'index.html': '<script src="/static/app.js"></script>',
        'static/app.js': 'navigator.serviceWorker.register("/sw.js")\nnew Worker("/worker.js")',
        'sw.js': 'self.fetch = f',
      },
      ['--map', 'https://app.example/static/=static', '--entry', 'index.html@https://app.example/'],
    )

    const app = report.artifacts.find(({ url }: Json) => url === 'https://app.example/static/app.js')
    const unresolved = report.completeness.limitations.filter(({ kind }: Json) => kind === 'unresolved-reference')
    expect(unresolved).toEqual([
      {
        kind: 'unresolved-reference',
        artifact: { url: 'https://app.example/static/app.js', path: 'static/app.js', hash: app.hash },
        location: { start: 33, end: 41, line: 1, column: 33 },
        detail: expect.any(String),
      },
    ])
    // A dedicated worker outside the mappings is a remote script, as a `script[src]` is.
    expect(graph(report)).toEqual([
      ['https://app.example/static/app.js', 'script', 'window', 'https://app.example/'],
      ['https://app.example/worker.js', 'script', 'dedicated-worker', 'https://app.example/static/app.js'],
    ])
    expect(report.artifacts[1]).toMatchObject({ origin: 'same-origin', retrieval: { status: 'offline-skipped' } })
    expect(report.completeness.counters.blindSpots).toMatchObject({ unresolvedReference: 1 })
    expect(report.findings).toEqual([])
  })
})

describe('worker-global targets (§4 naming rules: worker globals, §3 Shadowing writes)', () => {
  test('`self.fetch = w` in a dedicated worker is `DedicatedWorkerGlobalScope.fetch`, shadowing the inherited member', async () => {
    const { report } = await scanBuild({
      'index.html': '<script>new Worker("worker.js")</script>',
      'worker.js': 'const original = self.fetch; self.fetch = function (input, init) { return original(input, init) }',
    })

    expect(report.findings).toHaveLength(1)
    const [finding] = report.findings
    expect(finding.fingerprint).toBe('dedicated-worker|DedicatedWorkerGlobalScope.fetch|wrap|unknown')
    expect(finding.target).toEqual({
      realm: 'dedicated-worker',
      holder: 'global',
      name: 'DedicatedWorkerGlobalScope.fetch',
      shadows: 'WorkerGlobalScope.prototype.fetch',
    })
    expect(finding.surface).toBe('networking')
    expect(finding.occurrences.map(({ artifact }: Json) => artifact.url)).toEqual(['https://app.example/worker.js'])
    expect(finding.occurrences[0].trace[0]).toMatchObject({
      kind: 'binding',
      name: 'self',
      form: 'global-name',
      aliasOf: 'DedicatedWorkerGlobalScope',
      realm: 'dedicated-worker',
    })
  })

  test("a write onto the global object shadows only an inherited Web IDL member that it doesn't make API use", async () => {
    const { report } = await scanBuild({
      'index.html': '<script>new Worker("worker.js")</script>',
      'worker.js': [
        // A bare name assigns the global object's property, so it shadows too.
        'setTimeout = a',
        // The worker global's own members, and the inherited member on its own holder.
        'self.XMLHttpRequest = b; WorkerGlobalScope.prototype.importScripts = c',
        // An inherited event handler runs its setter, a delete through the global changes no native, and
        // `Object.prototype` is not on the global's IDL chain.
        'self.onerror = d; delete fetch; self.toString = e; self.hasOwnProperty = f',
      ].join('\n'),
    })

    expect(report.findings.map(({ target }: Json) => target)).toEqual([
      { realm: 'dedicated-worker', holder: 'global', name: 'DedicatedWorkerGlobalScope.XMLHttpRequest' },
      {
        realm: 'dedicated-worker',
        holder: 'global',
        name: 'DedicatedWorkerGlobalScope.setTimeout',
        shadows: 'WorkerGlobalScope.prototype.setTimeout',
      },
      { realm: 'dedicated-worker', holder: 'prototype', name: 'WorkerGlobalScope.prototype.importScripts' },
    ])
  })

  test('the window global shadows what it inherits from `EventTarget.prototype` the same way (ADR 0002)', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': 'window.addEventListener = a; removeEventListener = b; window.fetch = c',
    })

    expect(report.findings.map(({ target, surface }: Json) => [target, surface])).toEqual([
      [
        {
          realm: 'window',
          holder: 'global',
          name: 'Window.addEventListener',
          shadows: 'EventTarget.prototype.addEventListener',
        },
        'events',
      ],
      [{ realm: 'window', holder: 'global', name: 'Window.fetch' }, 'networking'],
      [
        {
          realm: 'window',
          holder: 'global',
          name: 'Window.removeEventListener',
          shadows: 'EventTarget.prototype.removeEventListener',
        },
        'events',
      ],
    ])
  })
})

describe('determinism (§15)', () => {
  test('two scans of copies of a build with workers give byte-identical reports, except run', async () => {
    const files = {
      'index.html': '<script src="app.js"></script><script>navigator.serviceWorker.register("/sw.js")</script>',
      'app.js': 'new Worker("w.js"); new SharedWorker("s.js", { type: "module" }); importScripts("never.js")',
      'w.js': 'importScripts("shared.js", "https://cdn.example/lib.js"); self.fetch = a',
      's.js': 'import "./shared-module.js"; self.setTimeout = b',
      'shared-module.js': 'self.fetch = c',
      'shared.js': 'self.addEventListener = d',
    }
    const args = ['--map', 'https://app.example/static/=.', '--entry', 'index.html@https://app.example/static/']

    const first = await scanBuild(files, args)
    const second = await scanBuild(files, args)

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
    expect(first.report.artifacts.map(({ url, realm }: Json) => [url, realm])).toEqual([
      ['https://app.example/static/#inline-1', 'window'],
      ['https://app.example/static/app.js', 'window'],
      ['https://app.example/static/s.js', 'shared-worker'],
      ['https://app.example/static/shared-module.js', 'shared-worker'],
      ['https://app.example/static/shared.js', 'dedicated-worker'],
      ['https://app.example/static/w.js', 'dedicated-worker'],
      ['https://cdn.example/lib.js', 'dedicated-worker'],
    ])
    expect(first.report.completeness.limitations.map(({ kind }: Json) => kind)).toEqual([
      'unresolved-reference',
      'offline-skipped',
    ])
  })
})

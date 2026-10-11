// Build-directory sweep (§2 Sweep, Realm, Content that isn't JavaScript; §9 `realm-assumed`; §13).

import { chmodSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { jsResolver, type AnalyzeGroupInput, type Resolver } from '../src/packages/analysis/index.ts'
import { fixtureBuild, scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const artifactOf = (report: Json, path: string) => report.artifacts.find((artifact: Json) => artifact.path === path)

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

describe('the sweep (§2 Sweep)', () => {
  test('finds a chunk no reference names, and marks it `sweep`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': 'var chunk = "chunks/" + id + ".js"',
      'chunks/lazy.js': 'window.fetch = f',
    })

    expect(artifactOf(report, 'chunks/lazy.js')).toMatchObject({
      url: 'https://app.example/chunks/lazy.js',
      origin: 'local-build',
      discovery: 'sweep',
      sourceType: 'script',
      realm: 'window',
      parent: null,
      retrieval: { status: 'ok' },
    })
    expect(artifactOf(report, 'main.js')).toMatchObject({ discovery: 'reference', parent: 'https://app.example/' })
    expect(report.findings.map((finding: Json) => finding.fingerprint)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(report.findings[0].occurrences[0].artifact.url).toBe('https://app.example/chunks/lazy.js')
  })
})

describe('the realm of a sweep-only artifact (§2 Realm, §9 `realm-assumed`)', () => {
  test('is assumed to be `window`, and its occurrences carry `realm-assumed` (medium), with its evidence', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script>',
      'main.js': 'window.alert = g',
      'chunks/lazy.js': 'window.fetch = f',
    })

    expect(artifactOf(report, 'chunks/lazy.js')).toMatchObject({ realm: 'window', realmBasis: 'assumed' })
    expect(artifactOf(report, 'main.js')).toMatchObject({ realm: 'window', realmBasis: 'reference' })
    const [alert, fetch] = report.findings
    expect(fetch.fingerprint).toBe('window|Window.fetch|replace|unknown')
    expect(fetch.confidence.target).toEqual({ level: 'medium', reasons: ['realm-assumed'] })
    const [occurrence] = fetch.occurrences
    expect(occurrence.confidence.target).toEqual({ level: 'medium', reasons: ['realm-assumed'] })
    expect(occurrence.trace.map(({ kind }: Json) => kind)).toEqual(['confidence-reason', 'binding'])
    expect(occurrence.trace[0]).toMatchObject({
      kind: 'confidence-reason',
      dimension: 'target',
      reason: 'realm-assumed',
      level: 'medium',
    })
    // A referenced artifact's realm comes from its reference.
    expect(alert.confidence.target).toEqual({ level: 'high', reasons: [] })
    expect(alert.occurrences[0].trace.map(({ kind }: Json) => kind)).toEqual(['binding'])
  })
})

describe('files outside every URL mapping (§2 Sweep)', () => {
  test('are excluded and listed, so server bundles stay out of the scan', async () => {
    const { report } = await scanBuild(
      {
        'public/index.html': '<script src="main.js"></script>',
        'public/main.js': 'window.alert = g',
        'public/chunks/lazy.mjs': 'window.open = h',
        'server/render.js': 'globalThis.fetch = f',
        'server/nested/pages.cjs': 'globalThis.fetch = f',
        'server/image.wasm': '\0asm',
        'README.md': '# not JavaScript',
        'server/styles.css': 'body {}',
      },
      ['--map', 'https://app.example/=public', '--entry', 'public/index.html'],
    )

    expect(report.artifacts.map(({ path, discovery }: Json) => [path, discovery])).toEqual([
      ['public/chunks/lazy.mjs', 'sweep'],
      ['public/main.js', 'reference'],
    ])
    expect(report.findings.map((finding: Json) => finding.fingerprint)).toEqual([
      'window|Window.alert|replace|unknown',
      'window|Window.open|replace|unknown',
    ])
    expect(report.completeness.excluded).toEqual(['server/image.wasm', 'server/nested/pages.cjs', 'server/render.js'])
    expect(report.completeness.counters.artifacts.skipped).toEqual({ offline: 0, refused: 0, excluded: 3, nonJs: 0 })
    expect(report.completeness.level).toBe('complete')
  })
})

describe('content that is not JavaScript (§2)', () => {
  test('a WebAssembly file is counted in `nonJs`, and its JavaScript glue is analyzed normally', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="glue.js"></script>',
      'glue.js': 'WebAssembly.instantiateStreaming(fetch("wasm/codec.wasm")); window.alert = g',
      'wasm/codec.wasm': '\0asm\x01\0\0\0',
      'wasm/other.WASM': '\0asm\x01\0\0\0',
      'styles.css': 'body {}',
      'logo.svg': '<svg><script>window.fetch = f</script></svg>',
      'data.json': '{}',
      'glue.js.map': '{"version":3}',
    })

    expect(report.artifacts.map(({ path }: Json) => path)).toEqual(['glue.js'])
    expect(report.findings.map((finding: Json) => finding.fingerprint)).toEqual(['window|Window.alert|replace|unknown'])
    expect(report.completeness.counters.artifacts.skipped).toEqual({ offline: 0, refused: 0, excluded: 0, nonJs: 2 })
    expect(report.completeness.level).toBe('complete')
  })
})

describe('the artifact counters (§13 Counters)', () => {
  test('add up: `known` is analyzed, failed and skipped together, and `sweepOnly` counts what only the sweep found', async () => {
    const dir = fixtureBuild({
      'public/index.html': '<script src="main.js"></script><script src="https://cdn.example/sdk.js"></script>',
      'public/main.js': 'window.alert = g',
      'public/chunks/a.js': 'window.fetch = f',
      'public/chunks/broken.js': 'var = ;',
      'public/chunks/locked.js': 'window.open = h',
      'public/codec.wasm': '\0asm',
      'server/render.js': 'globalThis.fetch = f',
    })
    chmodSync(join(dir, 'public/chunks/locked.js'), 0o000)

    const { report } = await scanBuild(dir, ['--map', 'https://app.example/=public', '--entry', 'public/index.html'])

    const { artifacts } = report.completeness.counters
    expect(artifacts).toEqual({
      known: 7,
      analyzed: 2,
      failed: { 'parse-failure': 1, unreadable: 1, 'fetch-failed': 0, 'sri-mismatch': 0, 'crash-guard': 0 },
      skipped: { offline: 1, refused: 0, excluded: 1, nonJs: 1 },
      sweepOnly: 3,
      // `public/index.html`: informational, and not an artifact.
      otherFiles: 1,
    })
    const failed = Object.values(artifacts.failed) as number[]
    const skipped = Object.values(artifacts.skipped) as number[]
    expect([artifacts.analyzed, ...failed, ...skipped].reduce((a, b) => a + b)).toBe(artifacts.known)
    expect(artifactOf(report, 'public/chunks/locked.js')).toMatchObject({
      discovery: 'sweep',
      hash: null,
      retrieval: { status: 'unreadable' },
    })
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.path])).toEqual([
      ['parse-failure', 'public/chunks/broken.js'],
      ['unreadable', 'public/chunks/locked.js'],
      ['offline-skipped', undefined],
    ])
    expect(report.completeness.level).toBe('incomplete')
  })
})

describe('the source type of a sweep-only artifact (§2 Artifacts, §5)', () => {
  test('is module when only a module parse accepts it, and script otherwise', async () => {
    const { report } = await scanBuild({
      'index.html': '',
      'esm.js': 'import { a } from "./shared.js"; window.fetch = a',
      'shared.mjs': 'export const a = 1',
      'meta.js': 'new Worker(new URL("w.js", import.meta.url)); window.open = h',
      'tla.js': 'const m = await import("./x.js"); window.alert = m.a',
      'classic.js': 'this.setTimeout = f',
      'sloppy.js': 'with (config) { window.print = p }',
      'broken.js': 'export default;',
    })

    expect(report.artifacts.map(({ path, sourceType }: Json) => [path, sourceType])).toEqual([
      ['broken.js', 'script'],
      ['classic.js', 'script'],
      ['esm.js', 'module'],
      ['meta.js', 'module'],
      // A sweep-only file's imports are followed: here they name files that aren't there.
      ['shared.js', 'module'],
      ['shared.mjs', 'module'],
      ['sloppy.js', 'script'],
      ['tla.js', 'module'],
      // A sweep-only file's worker URLs are worker references, folded where they aren't literals.
      ['w.js', 'script'],
      ['x.js', 'module'],
    ])
    expect(report.findings.map((finding: Json) => finding.fingerprint)).toEqual([
      'window|Window.alert|replace|unknown',
      'window|Window.fetch|replace|unknown',
      'window|Window.open|replace|unknown',
      'window|Window.print|replace|unknown',
      'window|Window.setTimeout|replace|unknown',
    ])
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.path])).toEqual([
      ['parse-failure', 'broken.js'],
      ['unreadable', 'shared.js'],
      ['unreadable', 'w.js'],
      ['unreadable', 'x.js'],
    ])
  })
})

describe('worker markers in a sweep-only artifact (§2 Realm, §13 `realm-uncertain`)', () => {
  test('raise `realm-uncertain`, located at the first marker; its realm stays assumed `window`', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="referenced.js"></script>',
      'referenced.js': 'importScripts("a.js")',
      'sw.js': 'if (!self.define) importScripts("workbox.js")\nself.addEventListener("install", (e) => self.skipWaiting())',
      'bundled-sw.js': '(function () {\n  self.addEventListener(`fetch`, function (event) {})\n})()',
      'worker.mjs': 'export {}\nself.addEventListener?.("message", onMessage)',
      'no-markers.js': [
        'function load() { importScripts("x.js") }',
        'self.addEventListener("click", f); window.addEventListener("message", f); self.addEventListener(type, f)',
        'self.addEventListener.call(self, "fetch", f); other.addEventListener("install", f)',
      ].join('\n'),
    })

    const hashOf = (path: string) => artifactOf(report, path).hash
    expect(report.completeness.limitations).toEqual([
      {
        kind: 'realm-uncertain',
        artifact: { url: 'https://app.example/bundled-sw.js', path: 'bundled-sw.js', hash: hashOf('bundled-sw.js') },
        location: { start: 17, end: 68, line: 2, column: 2 },
        detail: expect.stringContaining('self.addEventListener("fetch")'),
      },
      {
        kind: 'realm-uncertain',
        artifact: { url: 'https://app.example/sw.js', path: 'sw.js', hash: hashOf('sw.js') },
        location: { start: 18, end: 45, line: 1, column: 18 },
        detail: expect.stringMatching(/top-level `importScripts`.*self\.addEventListener\("install"\)/),
      },
      {
        kind: 'realm-uncertain',
        artifact: { url: 'https://app.example/worker.mjs', path: 'worker.mjs', hash: hashOf('worker.mjs') },
        location: { start: 10, end: 55, line: 2, column: 0 },
        detail: expect.stringContaining('self.addEventListener("message")'),
      },
    ])
    expect(report.completeness.counters.blindSpots.realmUncertain).toBe(3)
    expect(report.completeness.level).toBe('complete-with-limitations')
    for (const path of ['sw.js', 'bundled-sw.js', 'worker.mjs', 'no-markers.js']) {
      expect(artifactOf(report, path)).toMatchObject({ discovery: 'sweep', realm: 'window', realmBasis: 'assumed' })
    }
  })
})

describe('what the sweep leaves to references (§2 Sweep, Artifacts)', () => {
  test('a file a reference found, at any URL, is not swept again; identical bytes elsewhere keep their own records', async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(
      {
        'index.html': '<script src="main.js?v=2"></script><link rel="preload" as="script" href="hint.js">',
        'main.js': 'window.alert = g',
        'hint.js': 'window.print = p',
        'copy/main.js': 'window.alert = g',
        'chunks/b.js': 'window.fetch = f',
        'chunks/a.js': 'window.fetch = f',
      },
      [],
      { deps: { resolver } },
    )

    // Each URL of identical bytes keeps its own record (§2 Artifacts).
    expect(report.artifacts.map(({ url, discovery }: Json) => [url, discovery])).toEqual([
      ['https://app.example/chunks/a.js', 'sweep'],
      ['https://app.example/chunks/b.js', 'sweep'],
      ['https://app.example/copy/main.js', 'sweep'],
      ['https://app.example/hint.js', 'reference'],
      ['https://app.example/main.js?v=2', 'reference'],
    ])
    // Referenced entries run first, then preload-only ones, then what only the sweep found, each in URL order (§19).
    // Identical bytes with the same source type, realm and realm basis are analyzed once: `chunks/b.js` with
    // `chunks/a.js`. The sweep-only `copy/main.js` has an assumed realm, which `main.js` doesn't, so it has its own.
    expect(resolver.entries).toEqual([
      'https://app.example/main.js?v=2',
      'https://app.example/hint.js',
      'https://app.example/chunks/a.js',
      'https://app.example/copy/main.js',
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 5, analyzed: 5, sweepOnly: 3 })
  })
})

describe('the URL of a swept file (§2 Inputs, Sweep)', () => {
  test('is one a mapping gives it that maps back to it, under the longest prefix; else it is excluded', async () => {
    const { report } = await scanBuild(
      {
        'public/index.html': '',
        'public/app.js': 'window.alert = a',
        'public/a b#c%.js': 'window.blur = b',
        'public/static/shadowed.js': 'window.close = c',
        'public/static/cdn/chunk.js': 'window.focus = d',
        'other/page.js': 'window.open = e',
      },
      [
        ...['--map', 'https://app.example/=public', '--map', 'https://cdn.example/assets=public/static/cdn'],
        ...['--map', 'https://app.example/static/=other', '--entry', 'public/index.html'],
      ],
    )

    expect(report.artifacts.map(({ url, path }: Json) => [url, path])).toEqual([
      ['https://app.example/a%20b%23c%25.js', 'public/a b#c%.js'],
      ['https://app.example/app.js', 'public/app.js'],
      ['https://app.example/static/page.js', 'other/page.js'],
      ['https://cdn.example/assets/chunk.js', 'public/static/cdn/chunk.js'],
    ])
    expect(report.completeness.excluded).toEqual(['public/static/shadowed.js'])
    expect(report.findings).toHaveLength(4)
  })

  test('when several mappings serve it, the most specific directory wins, then the first URL, in any mapping order', async () => {
    const files = {
      'public/index.html': '',
      'public/static/chunk.js': 'window.fetch = f',
      'public/other.js': 'window.open = g',
    }
    const mappings = [
      ['--map', 'https://app.example/=public'],
      ['--map', 'https://cdn.example/assets/=public/static'],
      ['--map', 'https://www.example/=public'],
    ]
    const urls = async (order: string[][]) => {
      const { report } = await scanBuild(files, [...order.flat(), '--entry', 'public/index.html'])
      return report.artifacts.map(({ url, path }: Json) => [url, path])
    }

    const expected = [
      ['https://app.example/other.js', 'public/other.js'],
      ['https://cdn.example/assets/chunk.js', 'public/static/chunk.js'],
    ]
    expect(await urls(mappings)).toEqual(expected)
    expect(await urls([...mappings].reverse())).toEqual(expected)
  })
})

describe('a directory the sweep cannot list (§13 `unreadable`)', () => {
  test('gives an `unreadable` record, and the other files are still swept', async () => {
    const dir = fixtureBuild({ 'index.html': '', 'locked/chunk.js': 'window.fetch = f', 'open/chunk.js': 'window.open = h' })
    chmodSync(join(dir, 'locked'), 0o000)
    try {
      const { report } = await scanBuild(dir)

      expect(report.completeness.limitations).toEqual([
        { kind: 'unreadable', artifact: { path: 'locked' }, detail: expect.stringContaining('EACCES') },
      ])
      expect(report.completeness.level).toBe('incomplete')
      expect(report.artifacts.map(({ path }: Json) => path)).toEqual(['open/chunk.js'])
    } finally {
      chmodSync(join(dir, 'locked'), 0o755)
    }
  })
})

describe('determinism (§15)', () => {
  test('a scan with swept, excluded and non-JS files gives byte-identical reports, except the run block', async () => {
    const dir = fixtureBuild({
      'public/index.html': '<script src="main.js"></script>',
      'public/main.js': 'window.alert = g',
      'public/z/chunk.js': 'window.fetch = f',
      'public/a/sw.js': 'importScripts("x.js")',
      'public/m.wasm': '\0asm',
      'server/b.js': '',
      'server/a.js': '',
    })
    const args = ['--map', 'https://app.example/=public', '--entry', 'public/index.html']
    const withoutRun = ({ stdout }: { stdout: string }) => JSON.stringify({ ...JSON.parse(stdout), run: null })

    const first = await scanBuild(dir, args)
    const second = await scanBuild(dir, args)

    expect(withoutRun(second)).toBe(withoutRun(first))
    expect(first.report.completeness.excluded).toEqual(['server/a.js', 'server/b.js'])
  })
})

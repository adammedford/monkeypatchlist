// Link groups over imports (§6 Link groups, §19 Link groups, ADR 0010): an entry artifact and every artifact its static
// and dynamic imports reach are analyzed as one program, with one heap and one realm. Every scenario goes through
// `monkeypatchlist scan --json`.

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type AnalyzeGroupInput, type Resolver } from '../src/packages/analysis/index.ts'
import { fixtureFetcher, type RecordedResponse } from '../src/packages/source-store/fixture.ts'
import { corpusDir } from '../tools/paths.ts'
import { scanBuild } from './support/fixture-build.ts'
import { identityMappings, mappings } from './support/source-map.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

// The shipped resolver, with eslint-scope behind the binding-resolution seam, and the verified drop-in (§19).
const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const page = (src: string) => `<script type="module" src="${src}"></script>`

/** Each finding as `realm|name|effect`, sorted. */
const findings = (report: Report): string[] =>
  report.findings
    .map((finding: Report) => `${finding.target.realm}|${finding.target.name}|${finding.effect}`)
    .sort()

/** A finding's occurrences, each as the URL of its artifact, its install context and its reachability. */
const occurrences = (report: Report, name: string): Report[] =>
  report.findings
    .find((finding: Report) => finding.target.name === name)
    .occurrences.map((occurrence: Report) => ({
      artifact: occurrence.artifact.url,
      installContext: occurrence.installContext,
      reachability: occurrence.reachability,
    }))

const instrument = 'export function instrument(o, n) { o[n] = wrap(o[n]) }'

/** A recorded JavaScript response with `body`. */
const js = (body: string): RecordedResponse => ({ headers: { 'content-type': 'text/javascript' }, body })

const sdk = 'https://cdn.example.com/sdk@2/sdk.mjs'

/** A sidecar source map that names `source` for every token of `code`, with `code` as its content. */
const mapOf = (code: string, source: string) =>
  JSON.stringify({
    version: 3,
    sources: [source],
    sourcesContent: [code],
    names: [],
    mappings: mappings(identityMappings(code)),
  })

describe.each(resolvers)('link groups over imports, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = async (files: Record<string, string>, args: string[] = []) =>
    (await scanBuild(files, args, { deps: { resolver } })).report

  test("a static import links the importer's call to the helper's write, which the occurrence names", async () => {
    const report = await scan({
      'index.html': page('app.js'),
      'app.js': 'import { instrument } from "./lib.js"; instrument(window, "fetch")',
      'lib.js': instrument,
    })

    expect(findings(report)).toEqual(['window|Window.fetch|wrap'])
    expect(occurrences(report, 'Window.fetch')).toEqual([
      { artifact: 'https://app.example/lib.js', installContext: 'load', reachability: 'unconditional' },
    ])
  })

  test('code only a dynamic import reaches is `deferred`, even when the import runs at top level', async () => {
    const report = await scan({
      'index.html': page('app.js'),
      'app.js': 'import("./lazy.js")',
      'lazy.js': 'window.fetch = wrap(window.fetch)',
    })

    expect(findings(report)).toEqual(['window|Window.fetch|wrap'])
    expect(occurrences(report, 'Window.fetch')).toEqual([
      { artifact: 'https://app.example/lazy.js', installContext: 'deferred', reachability: 'unconditional' },
    ])
  })

  test('the guards on a dynamic import apply to the code it loads', async () => {
    const report = await scan({
      'index.html': page('app.js'),
      'app.js': 'if (!window.fetch) import("./polyfill.js"); if (config.trace) import("./trace.js")',
      'polyfill.js': 'window.fetch = function fetch() {}',
      'trace.js': 'import { instrument } from "./lib.js"; instrument(XMLHttpRequest.prototype, "send")',
      'lib.js': instrument,
    })

    expect(findings(report)).toEqual(['window|Window.fetch|replace', 'window|XMLHttpRequest.prototype.send|wrap'])
    expect(occurrences(report, 'Window.fetch')).toEqual([
      { artifact: 'https://app.example/polyfill.js', installContext: 'deferred', reachability: 'guarded-native-absence' },
    ])
    expect(occurrences(report, 'XMLHttpRequest.prototype.send')).toEqual([
      { artifact: 'https://app.example/lib.js', installContext: 'deferred', reachability: 'conditional' },
    ])
  })

  test('a chunk two groups share is analyzed in each, and their findings merge by fingerprint', async () => {
    const report = await scan({
      'index.html': `${page('a.js')}${page('b.js')}`,
      'a.js': 'import { instrument } from "./shared.js"; instrument(window, "fetch")',
      'b.js': 'import { instrument } from "./shared.js";\n\ninstrument(window, "fetch")',
      'shared.js': `${instrument}\nhistory.pushState = wrap(history.pushState)`,
    })

    expect(findings(report)).toEqual(['window|Window.fetch|wrap', 'window|history.pushState|wrap'])
    // The helper's write is called from each group's entry, so each group gives an occurrence with its own call step.
    const fetch = report.findings.find((finding: Report) => finding.target.name === 'Window.fetch')
    expect(fetch.occurrences.map((occurrence: Report) => occurrence.artifact.url)).toEqual([
      'https://app.example/shared.js',
      'https://app.example/shared.js',
    ])
    const calls = fetch.occurrences.map(
      (occurrence: Report) => occurrence.trace.find((step: Report) => step.kind === 'call').artifact,
    )
    expect(calls.sort()).toEqual(['https://app.example/a.js', 'https://app.example/b.js'])
    // The top-level write is the same occurrence in both groups.
    expect(occurrences(report, 'history.pushState')).toEqual([
      { artifact: 'https://app.example/shared.js', installContext: 'load', reachability: 'unconditional' },
    ])
    const shared = report.artifacts.find((artifact: Report) => artifact.url === 'https://app.example/shared.js')
    expect(shared.moduleLinking.linkGroups).toBe(2)
  })

  test('two classic scripts that share a global variable stay separate programs', async () => {
    const report = await scan({
      'index.html': '<script src="a.js"></script><script src="b.js"></script>',
      'a.js': 'var target = XMLHttpRequest.prototype',
      'b.js': 'target.send = wrap(target.send)',
    })

    expect(findings(report)).toEqual([])
    expect(report.artifacts.map((artifact: Report) => artifact.moduleLinking.linkGroups)).toEqual([1, 1])
  })

  describe('an import links any artifact of the realm the artifact graph resolves it to', () => {
    const app = (how: string) => ({
      'index.html': page('assets/app.js'),
      'assets/app.js': how,
    })
    const scanResolve = async (files: Record<string, string>) =>
      (
        await scanBuild(files, ['--mode', 'resolve'], {
          deps: { resolver, resolveFetcher: () => fixtureFetcher({ [sdk]: js(instrument) }) },
        })
      ).report

    test('a fetched remote module, in resolve mode, is analyzed in its importer\'s group, never standalone', async () => {
      const report = await scanResolve(app(`import { instrument } from "${sdk}"; instrument(window, "fetch")`))

      expect(findings(report)).toEqual(['window|Window.fetch|wrap'])
      expect(occurrences(report, 'Window.fetch')).toEqual([
        { artifact: sdk, installContext: 'load', reachability: 'unconditional' },
      ])
      const fetch = report.findings[0]
      expect(fetch.attribution.key).toBe('url:https://cdn.example.com/sdk@*/sdk.mjs')
      const remote = report.artifacts.find((artifact: Report) => artifact.url === sdk)
      expect(remote.moduleLinking.linkGroups).toBe(1)
    })

    test('a dynamically imported remote module is `deferred`', async () => {
      const lazy = 'https://cdn.example.com/sdk@2/lazy.mjs'
      const report = (
        await scanBuild(app(`import("${lazy}")`), ['--mode', 'resolve'], {
          deps: { resolver, resolveFetcher: () => fixtureFetcher({ [lazy]: js('window.fetch = wrap(window.fetch)') }) },
        })
      ).report

      expect(findings(report)).toEqual(['window|Window.fetch|wrap'])
      expect(occurrences(report, 'Window.fetch')).toEqual([
        { artifact: lazy, installContext: 'deferred', reachability: 'unconditional' },
      ])
    })

    test('offline, a skipped import is a broken link: `unlinked-module-call` only when a native flows into it', async () => {
      const carries = await scan(app(`import { instrument } from "${sdk}"; instrument(window, "fetch")`))
      expect(findings(carries)).toEqual([])
      expect(carries.completeness.limitations.map(({ kind }: Report) => kind).sort()).toEqual([
        'offline-skipped',
        'unlinked-module-call',
      ])
      const counted = await scan(app(`import { instrument } from "${sdk}"; instrument({}, "x")`))
      expect(counted.completeness.limitations.map(({ kind }: Report) => kind)).toEqual(['offline-skipped'])
      const local = counted.artifacts.find((artifact: Report) => artifact.url === 'https://app.example/assets/app.js')
      expect(local.moduleLinking.unlinked).toBe(1)
    })

    test('an inline module links a local module', async () => {
      const report = await scan({
        'index.html': '<script type="module">import { fill } from "/assets/vendor.js"; fill(history, "pushState", w)</script>',
        'assets/vendor.js': 'export function fill(o, n, w) { o[n] = w(o[n]) }',
      })

      expect(findings(report)).toEqual(['window|history.pushState|wrap'])
      expect(occurrences(report, 'history.pushState')).toEqual([
        { artifact: 'https://app.example/assets/vendor.js', installContext: 'load', reachability: 'unconditional' },
      ])
    })

    test('a `data:` module is a member of its importer\'s group', async () => {
      const data = `data:text/javascript,${encodeURIComponent(instrument)}`
      const report = await scan(app(`import { instrument } from "${data}"; instrument(window, "fetch")`))

      expect(findings(report)).toEqual(['window|Window.fetch|wrap'])
      expect(occurrences(report, 'Window.fetch')).toEqual([
        { artifact: data, installContext: 'load', reachability: 'unconditional' },
      ])
    })
  })

  describe("a helper write's lookup crosses artifacts only within the write artifact's origin", () => {
    const call = 'import { instrument } from "./vendor.js"; instrument(window, "fetch")'
    const key = (report: Report) => report.findings.map((finding: Report) => finding.attribution.key)

    test('local to local: the call in the importer keys the finding, as in a single-file build', async () => {
      const split = await scan({
        'index.html': page('app.js'),
        'app.js': call,
        'app.js.map': mapOf(call, '../node_modules/@acme/browser/index.js'),
        'vendor.js': instrument,
        'vendor.js.map': mapOf(instrument, '../node_modules/@acme/core/index.js'),
      })
      const single = `${instrument.replace('export ', '')}\ninstrument(window, "fetch")`
      const singleFile = await scan({
        'index.html': page('app.js'),
        'app.js': single,
        'app.js.map': JSON.stringify({
          version: 3,
          sources: ['../node_modules/@acme/core/index.js', '../node_modules/@acme/browser/index.js'],
          sourcesContent: [instrument.replace('export ', ''), 'instrument(window, "fetch")'],
          names: [],
          mappings: mappings([identityMappings(single)[0]!, identityMappings(single, 1)[1]!.map(([column]) => [column!, 1, 0, column!] as [number, number, number, number])]),
        }),
      })

      expect(key(split)).toEqual(['pkg:@acme/browser'])
      expect(key(singleFile)).toEqual(key(split))
      const [occurrence] = split.findings[0].occurrences
      expect(occurrence.artifact.url).toBe('https://app.example/vendor.js')
      const check = occurrence.trace.find((step: Report) => step.kind === 'token-check')
      expect(check).toMatchObject({ result: 'passed', artifact: 'https://app.example/app.js' })
    })

    test("an inline module's call into a local module stops in the local module, which keys it", async () => {
      const fill = 'export function fill(o, n, w) { o[n] = w(o[n]) }'
      const report = await scan({
        'index.html': '<script type="module">import { fill } from "/vendor.js"; fill(history, "pushState", w)</script>',
        'vendor.js': fill,
        'vendor.js.map': mapOf(fill, '../node_modules/@sentry/core/build/object.js'),
      })

      expect(key(report)).toEqual(['pkg:@sentry/core'])
    })

    test('a call that carries part of a folded key is bounded the same way: an inline module stops in the local module', async () => {
      const hook = "export function hook(p, n) { p['set' + n] = wrap(p['set' + n]) }"
      const report = await scan({
        'index.html': '<script type="module">import { hook } from "/vendor.js"; hook(XMLHttpRequest.prototype, "RequestHeader")</script>',
        'vendor.js': hook,
        'vendor.js.map': mapOf(hook, '../node_modules/@acme/core/index.js'),
      })

      expect(report.findings.map((finding: Report) => finding.target.name)).toEqual(['XMLHttpRequest.prototype.setRequestHeader'])
      expect(key(report)).toEqual(['pkg:@acme/core'])
    })

    test("a local module's call into a remote module stops in the remote one, which keys `url:`", async () => {
      const report = (
        await scanBuild(
          {
            'index.html': page('app.js'),
            'app.js': `import { instrument } from "${sdk}"; instrument(window, "fetch")`,
            'app.js.map': mapOf(`import { instrument } from "${sdk}"; instrument(window, "fetch")`, '../src/app.js'),
          },
          ['--mode', 'resolve'],
          { deps: { resolver, resolveFetcher: () => fixtureFetcher({ [sdk]: js(instrument) }) } },
        )
      ).report

      expect(key(report)).toEqual(['url:https://cdn.example.com/sdk@*/sdk.mjs'])
      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.trace.some((step: Report) => step.kind === 'token-check')).toBe(false)
    })
  })

  test("a module an unlinked swept file imports is analyzed in that file's assumed window group too", async () => {
    const report = await scan({
      'index.html': '<script>new Worker("/assets/worker-A.js", { type: "module" })</script>',
      'assets/worker-A.js': 'import "./shared-B.js"',
      'assets/orphan-C.js': 'import { patch } from "./shared-B.js"; patch(window, "fetch")',
      'assets/shared-B.js': 'self.fetch = wrap(self.fetch); export function patch(o, n) { o[n] = wrap(o[n]) }',
    })

    expect(findings(report)).toEqual(['dedicated-worker|DedicatedWorkerGlobalScope.fetch|wrap', 'window|Window.fetch|wrap'])
    const window = report.findings.find((finding: Report) => finding.target.realm === 'window')
    expect(window.confidence.target).toEqual({ level: 'medium', reasons: ['realm-assumed'] })
    // B's top-level write, and C's call into B's helper, both in B.
    expect(window.occurrences.map((occurrence: Report) => [occurrence.artifact.url, occurrence.generated.column])).toEqual([
      ['https://app.example/assets/shared-B.js', 0],
      ['https://app.example/assets/shared-B.js', 61],
    ])
    const swept = report.artifacts.find((artifact: Report) => artifact.url === 'https://app.example/assets/orphan-C.js')
    expect(swept).toMatchObject({ discovery: 'sweep', realmBasis: 'assumed', moduleLinking: { linkGroups: 1 } })
  })

  test('groups run for every referenced entry in URL order, then each swept artifact no group links; the seam returns members', async () => {
    const groups: [string, string[]][] = []
    const spy: Resolver = {
      analyzerVersion: resolver.analyzerVersion,
      analyzeGroup(input: AnalyzeGroupInput) {
        const output = resolver.analyzeGroup(input)
        groups.push([input.entry.url, output.members.map((member) => member.url)])
        return output
      },
    }
    const report = (
      await scanBuild(
        {
          'index.html': `${page('b.js')}${page('a.js')}`,
          'a.js': 'import "./lib.js"',
          'b.js': 'import("./lazy.js")',
          'lib.js': 'export const x = 1',
          'lazy.js': 'export const y = 1',
          // Only the sweep finds these: d.js and e.js import each other, and c.js imports d.js.
          'c.js': 'import "./d.js"',
          'd.js': 'import "./e.js"',
          'e.js': 'import "./d.js"',
          'f.js': 'export {}',
        },
        [],
        { deps: { resolver: spy } },
      )
    ).report

    const url = (name: string) => `https://app.example/${name}`
    expect(groups).toEqual([
      [url('a.js'), [url('a.js'), url('lib.js')]],
      [url('b.js'), [url('b.js'), url('lazy.js')]],
      [url('c.js'), [url('c.js'), url('e.js'), url('d.js')]],
      [url('f.js'), [url('f.js')]],
    ])
    const linkGroups = Object.fromEntries(
      report.artifacts.map((artifact: Report) => [artifact.url, artifact.moduleLinking.linkGroups]),
    )
    expect(linkGroups).toEqual(Object.fromEntries(['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js', 'lazy.js', 'lib.js'].map((name) => [url(name), 1])))
  })

  test("a member that doesn't parse fails every module graph that holds it (Principle 1), and is recorded", async () => {
    const report = await scan({
      'index.html': `${page('app.js')}${page('other.js')}`,
      'app.js': 'import "./broken.js"; window.fetch = wrap(window.fetch)',
      'other.js': 'if (x) import("./broken.js"); window.open = wrap(window.open)',
      'broken.js': 'export const = 1',
    })

    expect(findings(report)).toEqual(['window|Window.open|wrap'])
    expect(report.completeness.limitations.map(({ kind, artifact }: Report) => [kind, artifact.url])).toEqual([
      ['parse-failure', 'https://app.example/broken.js'],
    ])
  })

  test('two scans of a build with link groups give byte-identical reports, except run', async () => {
    const files = {
      'index.html': `${page('b.js')}${page('a.js')}`,
      'a.js': 'import { instrument } from "./shared.js"; instrument(window, "fetch"); import("./lazy.js")',
      'b.js': 'import { instrument } from "./shared.js"; if (x) instrument(XMLHttpRequest.prototype, "send")',
      'shared.js': instrument,
      'lazy.js': 'import { instrument } from "./shared.js"; instrument(history, "pushState")',
    }
    const first = await scan(files)
    const second = await scan(files)

    expect(findings(first)).toEqual([
      'window|Window.fetch|wrap',
      'window|XMLHttpRequest.prototype.send|wrap',
      'window|history.pushState|wrap',
    ])
    expect(JSON.stringify({ ...second, run: null })).toBe(JSON.stringify({ ...first, run: null }))
  })
})


// The validation corpus's Vite build of New Relic, whose loader core sits in a shared chunk the entry imports. The builds
// are git-ignored, so a checkout without them skips this.
const vite = resolve(corpusDir, 'dist/vite/newrelic/nomaps')
describe.skipIf(!existsSync(resolve(vite)))("New Relic's Vite build", () => {
  test('finds the targets its chunks miss when each is analyzed alone', { timeout: 300_000 }, async () => {
    const { report } = await scanBuild(resolve(vite), ['--map', 'https://app.corpus.test/=.'])

    // Analyzed alone, the chunks gave none of these: the entry writes through the global object its shared chunk
    // exports, and installs the wrappers through that chunk's helpers. Rollup's and webpack's builds give each one.
    const readers = ['arrayBuffer', 'blob', 'formData', 'json', 'text']
    expect(findings(report)).toEqual(
      expect.arrayContaining([
        'window|Window.WebSocket|replace',
        'window|Window.XMLHttpRequest|wrap',
        'window|Window.fetch|wrap',
        ...readers.map((name) => `window|Request.prototype.${name}|wrap`),
        ...readers.map((name) => `window|Response.prototype.${name}|wrap`),
      ]),
    )
  })
})


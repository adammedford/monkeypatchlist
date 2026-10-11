// HTML entry documents (§2 Inputs, Discovery and Artifacts; §13; §16 --entry and --map; §19 HTML rules).

import { describe, expect, test } from 'vitest'
import { defaultBudget, jsResolver, type AnalyzeGroupInput, type Resolver } from '../src/packages/analysis/index.ts'
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

const urlsAndPaths = (report: Json) => report.artifacts.map(({ url, path }: Json) => ({ url, path }))
const fingerprints = (report: Json) => report.findings.map((finding: Json) => finding.fingerprint)
const artifactAt = (report: Json, url: string) => report.artifacts.find((artifact: Json) => artifact.url === url)

describe('--entry <file>[@<url>] and --map <urlPrefix>=<dir> (§16)', () => {
  test('both repeat; @<url> is the document URL, and defaults to the first mapping URL', async () => {
    const { report } = await scanBuild(
      {
        'pages/a.html': '<script src="x.js"></script>',
        'b.html': '<script src="assets/lib.js"></script>',
        'a/x.js': 'window.fetch = f',
        'static/lib.js': 'window.alert = g',
      },
      [
        ...['--map', 'https://app.example/=.', '--map', 'https://app.example/assets/=static'],
        ...['--entry', 'pages/a.html@https://app.example/a/', '--entry', 'b.html'],
      ],
    )

    expect(report.config.entries).toEqual([
      { file: 'pages/a.html', url: 'https://app.example/a/' },
      { file: 'b.html', url: 'https://app.example/' },
    ])
    expect(report.config.mappings).toEqual([
      { url: 'https://app.example/', dir: '.' },
      { url: 'https://app.example/assets/', dir: 'static' },
    ])
    expect(urlsAndPaths(report)).toEqual([
      { url: 'https://app.example/a/x.js', path: 'a/x.js' },
      { url: 'https://app.example/assets/lib.js', path: 'static/lib.js' },
    ])
    expect(fingerprints(report)).toEqual(['window|Window.alert|replace|unknown', 'window|Window.fetch|replace|unknown'])
  })
})

describe('entry documents (§2 Inputs)', () => {
  test('an --entry file may hold an @ of its own', async () => {
    const { report } = await scanBuild(
      { '@scope/index.html': '<script src="/main.js"></script>', 'main.js': 'window.fetch = f' },
      ['--entry', '@scope/index.html'],
    )

    expect(report.config.entries).toEqual([{ file: '@scope/index.html', url: 'https://app.example/' }])
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
  })

  test('a captured SSR HTML file works like any other entry, at the URL it was captured from', async () => {
    const { report } = await scanBuild(
      {
        'captured/product.html': [
          '<script>self.__next_f = []</script>',
          '<script src="/_next/static/chunks/main.js" async></script>',
          '<script src="../_next/static/chunks/page.js"></script>',
        ].join(''),
        'site/_next/static/chunks/main.js': 'window.fetch = f',
        'site/_next/static/chunks/page.js': 'window.alert = g',
      },
      ['--map', 'https://shop.example/_next/=site/_next', '--entry', 'captured/product.html@https://shop.example/p/42'],
    )

    expect(urlsAndPaths(report)).toEqual([
      { url: 'https://shop.example/_next/static/chunks/main.js', path: 'site/_next/static/chunks/main.js' },
      { url: 'https://shop.example/_next/static/chunks/page.js', path: 'site/_next/static/chunks/page.js' },
      { url: 'https://shop.example/p/42#inline-1', path: null },
    ])
    expect(report.completeness.level).toBe('complete')
  })
})

describe('artifacts are content-addressed (§2 Artifacts)', () => {
  const pages = {
    'a.html': '<script src="/shared.js"></script>',
    'b.html': '<script src="../shared.js"></script>',
    'shared.js': 'window.fetch = f',
  }
  const entries = ['--entry', 'a.html', '--entry', 'b.html@https://app.example/b/']

  test('two entry documents that share a script analyze it once, and its occurrences name it', async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(pages, entries, { deps: { resolver } })

    expect(resolver.entries).toEqual(['https://app.example/shared.js'])
    expect(urlsAndPaths(report)).toEqual([{ url: 'https://app.example/shared.js', path: 'shared.js' }])
    expect(report.artifacts[0].parent).toBe('https://app.example/')
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].occurrences.map(({ artifact }: Json) => artifact.url)).toEqual([
      'https://app.example/shared.js',
    ])
  })

  test('the findings are those of either document on its own', async () => {
    const both = await scanBuild(pages, entries)
    const one = await scanBuild(pages, ['--entry', 'a.html'])

    expect(both.report.findings).toEqual(one.report.findings)
  })

  test('identical bytes at two URLs are two artifacts, analyzed once', async () => {
    const resolver = spyResolver()
    const inline = '<script>window.fetch = f</script>'

    const { report } = await scanBuild(
      {
        'a.html': `${inline}<script src="v1/sdk.js"></script>`,
        'b.html': `${inline}<script src="v2/sdk.js"></script>`,
        'v1/sdk.js': 'window.alert = g',
        'v2/sdk.js': 'window.alert = g',
      },
      ['--entry', 'a.html@https://app.example/a', '--entry', 'b.html@https://app.example/b'],
      { deps: { resolver } },
    )

    expect(urlsAndPaths(report)).toEqual([
      { url: 'https://app.example/a#inline-1', path: null },
      { url: 'https://app.example/b#inline-1', path: null },
      { url: 'https://app.example/v1/sdk.js', path: 'v1/sdk.js' },
      { url: 'https://app.example/v2/sdk.js', path: 'v2/sdk.js' },
    ])
    expect(resolver.entries).toEqual(['https://app.example/a#inline-1', 'https://app.example/v1/sdk.js'])
    expect(fingerprints(report)).toEqual(['window|Window.alert|replace|unknown', 'window|Window.fetch|replace|inline'])
    expect(report.findings.map(({ occurrences }: Json) => occurrences.length)).toEqual([2, 2])
  })

  test('the same bytes inline and in a file stay two artifacts, so their findings keep their own keys', async () => {
    const { report } = await scanBuild({
      'index.html': '<script>window.fetch = f</script><script src="main.js"></script>',
      'main.js': 'window.fetch = f',
    })

    expect(report.artifacts.map(({ origin }: Json) => origin)).toEqual(['inline', 'local-build'])
    expect(report.artifacts[0].hash).toBe(report.artifacts[1].hash)
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|inline', 'window|Window.fetch|replace|unknown'])
  })

  test("entry documents at one URL number their inline scripts together, so none takes another's URL", async () => {
    const { report } = await scanBuild(
      { 'a.html': '<script>window.fetch = f</script>', 'b.html': '<script>window.alert = g</script>' },
      ['--entry', 'a.html', '--entry', 'b.html'],
    )

    expect(urlsAndPaths(report)).toEqual([
      { url: 'https://app.example/#inline-1', path: null },
      { url: 'https://app.example/#inline-2', path: null },
    ])
    expect(fingerprints(report)).toEqual(['window|Window.alert|replace|inline', 'window|Window.fetch|replace|inline'])
  })
})

describe('artifacts that fail (§13)', () => {
  const noFailures = { 'parse-failure': 0, unreadable: 0, 'fetch-failed': 0, 'sri-mismatch': 0, 'crash-guard': 0 }
  const noneSkipped = { offline: 0, refused: 0, excluded: 0, nonJs: 0 }

  test('a script that cannot be read is an artifact, gives `unreadable`, and counts as failed', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="missing.js"></script><script src="main.js"></script>',
      'main.js': 'window.fetch = f',
    })

    expect(report.artifacts[1]).toEqual({
      url: 'https://app.example/missing.js',
      path: 'missing.js',
      hash: null,
      origin: 'local-build',
      discovery: 'reference',
      sourceType: 'script',
      realm: 'window',
      realmBasis: 'reference',
      parent: 'https://app.example/',
      sourceMap: { method: 'none', path: null, status: 'none' },
      retrieval: {
        status: 'unreadable',
        requestedUrl: 'https://app.example/missing.js',
        finalUrl: 'https://app.example/missing.js',
        contentType: null,
        sri: 'none',
      },
      moduleLinking: { idioms: [], modules: 0, unlinked: 0, linkGroups: 0 },
    })
    expect(report.artifacts[0].retrieval.status).toBe('ok')
    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.limitations).toEqual([
      { kind: 'unreadable', artifact: { url: 'https://app.example/missing.js', path: 'missing.js' }, detail: 'ENOENT' },
    ])
    expect(report.completeness.counters.artifacts).toEqual({
      known: 2,
      analyzed: 1,
      failed: { ...noFailures, unreadable: 1 },
      skipped: noneSkipped,
      sweepOnly: 0,
      // The entry document is a file a mapping serves that the sweep doesn't take for JavaScript (§2 Sweep).
      otherFiles: 1,
    })
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
  })

  test('an entry document that cannot be read gives `unreadable`, and the others are scanned', async () => {
    const { report } = await scanBuild({ 'b.html': '<script>window.fetch = f</script>' }, [
      ...['--entry', 'missing.html@https://app.example/a/', '--entry', 'b.html'],
    ])

    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.limitations).toEqual([
      { kind: 'unreadable', artifact: { url: 'https://app.example/a/', path: 'missing.html' }, detail: 'ENOENT' },
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 1, analyzed: 1, failed: noFailures })
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|inline'])
  })

  test('a scan with nothing it could not analyze is complete', async () => {
    const { report } = await scanBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': 'window.fetch = f' })

    expect(report.completeness).toEqual({
      level: 'complete',
      counters: {
        artifacts: { known: 1, analyzed: 1, failed: noFailures, skipped: noneSkipped, sweepOnly: 0, otherFiles: 1 },
        blindSpots: { dynamicCode: 0, unresolvedReference: 0, realmUncertain: 0, unresolvedHolder: 0 },
        html: { nomodule: 0, inlineHandlers: 0 },
        statistics: {
          steps: expect.any(Number),
          stepBudget: 16 * defaultBudget.stepsPerByte,
          budgetExhausted: 0,
          caps: {},
          pruned: 0,
          limits: defaultBudget,
          crashGuard: 'not-fired',
        },
      },
      limitations: [],
      excluded: [],
      attribution: {
        artifacts: { withMap: 0, withoutMap: 1, withBrokenMap: 0 },
        pairings: {
          header: 0,
          annotation: 0,
          sidecar: 0,
          'debug-id': 0,
          'external-debug-id': 0,
          'external-annotation': 0,
          'external-sidecar': 0,
        },
        staleCandidates: 0,
        unreadMaps: { refused: 0, failed: 0, unreadable: 0 },
        sourceMapDirectories: [],
        // The finding's code has no map (§9 `no-map`).
        cappedFindings: { medium: 0, low: 1 },
        introducers: { reason: 'no-lockfile', evidence: null },
      },
    })
  })

  test('a script that does not parse gives `parse-failure`, counts as failed, and gives no findings', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="broken.js"></script><script src="main.js"></script>',
      'broken.js': 'window.alert = g; window.fetch = (',
      'main.js': 'window.fetch = f',
    })

    const broken = report.artifacts.find(({ url }: Json) => url === 'https://app.example/broken.js')
    expect(broken).toMatchObject({ path: 'broken.js', retrieval: { status: 'ok' } })
    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.limitations).toEqual([
      {
        kind: 'parse-failure',
        artifact: { url: 'https://app.example/broken.js', path: 'broken.js', hash: broken.hash },
        detail: expect.any(String),
      },
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({
      known: 2,
      analyzed: 1,
      failed: { ...noFailures, 'parse-failure': 1 },
    })
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|unknown'])
  })

  test('a classic script with an import or export declaration gives `parse-failure`, as it fails in a browser', async () => {
    const { exitCode, report } = await scanBuild({
      'index.html': [
        '<script src="imports.js"></script><script src="exports.js"></script>',
        '<link rel="preload" as="script" href="chunk.js"><script type="module" src="module.js"></script>',
        '<script>eval("import x from \'y\'; window.open = x")</script>',
      ].join(''),
      'imports.js': 'import x from "./x.js"; window.fetch = x',
      'exports.js': 'window.alert = g; export {}',
      'chunk.js': 'export const x = 1; window.print = x',
      'module.js': 'import x from "./x.js"; window.stop = x; export {}',
      'x.js': 'export default 1',
    })

    expect(exitCode).toBe(0)
    const failures = report.completeness.limitations.map(({ kind, artifact, detail }: Json) => [kind, artifact.url, detail])
    expect(failures).toEqual([
      // Eval code is a script too, so its import declaration doesn't parse, and the eval is dynamic code.
      ['dynamic-code', 'https://app.example/#inline-1', expect.any(String)],
      ['parse-failure', 'https://app.example/exports.js', 'Cannot use export statement outside a module'],
      ['parse-failure', 'https://app.example/imports.js', 'Cannot use import statement outside a module'],
    ])
    const inline = 'eval("import x from \'y\'; window.open = x")'
    const literal = '"import x from \'y\'; window.open = x"'
    const [evalCode] = report.completeness.limitations
    expect(evalCode.location).toEqual({ start: 5, end: 5 + literal.length, line: 1, column: inline.indexOf(literal) })
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 6, analyzed: 4, failed: { 'parse-failure': 2 } })
    // A file only a preload names takes its source type from its syntax, so the preloaded chunk parses.
    expect(artifactAt(report, 'https://app.example/chunk.js')).toMatchObject({ sourceType: 'module', realmBasis: 'assumed' })
    expect(fingerprints(report)).toEqual(['window|Window.print|replace|unknown', 'window|Window.stop|replace|unknown'])
  })

  test("the resolver's in-code records reach the report, located, and count as blind spots", async () => {
    const { report } = await scanBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': 'eval(code)' })

    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.completeness.limitations).toEqual([
      {
        kind: 'dynamic-code',
        artifact: { url: 'https://app.example/main.js', path: 'main.js', hash: report.artifacts[0].hash },
        location: { start: 5, end: 9, line: 1, column: 5 },
        detail: expect.any(String),
      },
    ])
    expect(report.completeness.counters.blindSpots).toEqual({
      dynamicCode: 1,
      unresolvedReference: 0,
      realmUncertain: 0,
      unresolvedHolder: 0,
    })
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 1, analyzed: 1 })
  })
})

describe('origins (§2 Artifacts, §17 Modes)', () => {
  test('are local-build, inline, same-origin or cross-origin; remote scripts are skipped offline', async () => {
    const { report } = await scanBuild(
      {
        'index.html': [
          '<script src="app.js"></script>',
          '<script>window.alert = g</script>',
          '<script src="/other/x.js"></script>',
          '<script type="module" src="https://cdn.example/sdk.js"></script>',
          '<script src="http://app.example/static/insecure.js"></script>',
        ].join(''),
        'static/app.js': 'window.fetch = f',
      },
      ['--map', 'https://app.example/static/=static'],
    )

    const remote = (url: string, origin: string, sourceType = 'script') => ({
      url,
      path: null,
      hash: null,
      origin,
      discovery: 'reference',
      sourceType,
      realm: 'window',
      realmBasis: 'reference',
      parent: 'https://app.example/static/',
      sourceMap: { method: 'none', path: null, status: 'none' },
      retrieval: { status: 'offline-skipped', requestedUrl: url, finalUrl: null, contentType: null, sri: 'none' },
      moduleLinking: { idioms: [], modules: 0, unlinked: 0, linkGroups: 0 },
    })
    expect(report.artifacts).toEqual([
      remote('http://app.example/static/insecure.js', 'cross-origin'),
      remote('https://app.example/other/x.js', 'same-origin'),
      expect.objectContaining({ url: 'https://app.example/static/#inline-1', origin: 'inline' }),
      expect.objectContaining({ url: 'https://app.example/static/app.js', origin: 'local-build', path: 'static/app.js' }),
      remote('https://cdn.example/sdk.js', 'cross-origin', 'module'),
    ])
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => ({ kind, artifact }))).toEqual([
      { kind: 'offline-skipped', artifact: { url: 'http://app.example/static/insecure.js' } },
      { kind: 'offline-skipped', artifact: { url: 'https://app.example/other/x.js' } },
      { kind: 'offline-skipped', artifact: { url: 'https://cdn.example/sdk.js' } },
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({
      known: 5,
      analyzed: 2,
      skipped: { offline: 3, excluded: 0, nonJs: 0 },
    })
    const origins = report.findings.map(({ occurrences }: Json) => occurrences[0].artifact.origin)
    expect(origins).toEqual(['inline', 'local-build'])
  })

  test('a data: script src is inline code, and a javascript: one gives nothing', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="data:text/javascript,window.fetch=f"></script><script src="javascript:x()"></script>',
    })

    expect(report.artifacts.map(({ url, origin, retrieval }: Json) => [url, origin, retrieval.status])).toEqual([
      ['data:text/javascript,window.fetch=f', 'inline', 'ok'],
    ])
    expect(report.completeness.counters.html.inlineHandlers).toBe(0)
  })
})

describe('HTML rules (§19): <base href>', () => {
  test('the first <base href> sets the base URL that references resolve against', async () => {
    const { report } = await scanBuild(
      {
        'pages/index.html': [
          '<head><base target="_top"><template><base href="/t/"></template>',
          '<base href="../static/"><base href="/ignored/"></head>',
          '<script src="app.js"></script>',
        ].join(''),
        'static/app.js': 'window.fetch = f',
      },
      ['--entry', 'pages/index.html@https://app.example/pages/'],
    )

    expect(urlsAndPaths(report)).toEqual([{ url: 'https://app.example/static/app.js', path: 'static/app.js' }])
    expect(report.artifacts[0].parent).toBe('https://app.example/pages/')
  })

  test('a script before the <base> resolves against the document URL, as the browser inserts it first', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="a.js"></script><base href="/static/"><script src="b.js"></script>',
      'a.js': 'window.fetch = f',
      'static/b.js': 'window.alert = g',
    })

    expect(urlsAndPaths(report)).toEqual([
      { url: 'https://app.example/a.js', path: 'a.js' },
      { url: 'https://app.example/static/b.js', path: 'static/b.js' },
    ])
  })

  const failing = ['http://[bad/', 'javascript:void(0)/', 'data:text/html,x/']
  test.each(failing)('a <base href="%s"> leaves the document URL', async (href) => {
    const { report } = await scanBuild({
      'index.html': `<base href="${href}"><script src="a.js"></script>`,
      'a.js': 'window.fetch = f',
    })

    expect(urlsAndPaths(report)).toEqual([{ url: 'https://app.example/a.js', path: 'a.js' }])
  })
})

describe('HTML rules (§19): which scripts run', () => {
  test('a script runs with no type, a JavaScript MIME type or type=module, as the browser decides its type', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script type="importmap">{ "imports": { "x": "./x.js" } }</script>',
        '<script type="IMPORTMAP">window.fetch = a</script>',
        '<script type=" text/JavaScript ">window.setTimeout = b</script>',
        '<script type=" ">window.open = c</script>',
        '<script type="text/javascript; charset=utf-8">window.print = d</script>',
        '<script language="javascript">window.alert = e</script>',
        '<script language="vbscript">window.close = f</script>',
        '<script type="" language="vbscript">window.stop = g</script>',
        '<script language="">window.focus = h</script>',
        '<script for="window" event="onload()">window.blur = i</script>',
        '<script for="button" event="onclick">window.moveTo = j</script>',
        '<script></script>',
        '<script type="text/plain" src="a.js"></script>',
      ].join(''),
      'a.js': 'window.scroll = k',
    })

    // A file that only a script of an ignored type names is not followed; the sweep finds it (§2 Sweep).
    expect(fingerprints(report)).toEqual([
      'window|Window.alert|replace|inline',
      'window|Window.blur|replace|inline',
      'window|Window.focus|replace|inline',
      'window|Window.scroll|replace|unknown',
      'window|Window.setTimeout|replace|inline',
      'window|Window.stop|replace|inline',
    ])
    // Inline scripts are numbered among all the document's inline scripts; an empty one runs nothing, so is none.
    // Artifacts sort by URL.
    expect(report.artifacts.map(({ url, discovery }: Json) => [url, discovery])).toEqual([
      ...[10, 3, 6, 8, 9].map((n) => [`https://app.example/#inline-${n}`, 'reference']),
      ['https://app.example/a.js', 'sweep'],
    ])
    expect(report.completeness.limitations).toEqual([])
  })
})

describe('HTML rules (§19): HTML content that is counted, not analyzed', () => {
  test('a classic <script nomodule> is counted (`nomodule`) and not analyzed', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script nomodule>window.open = b</script>',
        '<script nomodule src="legacy.js"></script>',
        '<script type="module" nomodule>window.alert = c</script>',
        '<script nomodule></script>',
        '<script type="text/plain" nomodule>window.fetch = d</script>',
      ].join(''),
      'legacy.js': 'window.print = e',
    })

    expect(report.completeness.counters.html).toEqual({ nomodule: 2, inlineHandlers: 0 })
    // The file a `nomodule` script names is not followed, but the sweep still finds it (§2 Sweep): its realm is
    // assumed, and its finding carries `realm-assumed`.
    expect(report.findings.map(({ fingerprint, confidence }: Json) => [fingerprint, confidence.target.reasons])).toEqual([
      ['window|Window.alert|replace|inline', []],
      ['window|Window.print|replace|unknown', ['realm-assumed']],
    ])
    expect(report.artifacts.map(({ url, discovery, realmBasis, parent }: Json) => [url, discovery, realmBasis, parent]))
      .toEqual([
        ['https://app.example/#inline-2', 'reference', 'reference', 'https://app.example/'],
        ['https://app.example/legacy.js', 'sweep', 'assumed', null],
      ])
    expect(report.completeness.level).toBe('complete')
  })

  test('inline event handlers and javascript: URLs are counted (`inlineHandlers`), not analyzed', async () => {
    const { report } = await scanBuild({
      'index.html': [
        // Counted: 8.
        '<body onload="window.fetch = a">',
        '<img src="x.png" ONERROR="window.stop = d">',
        '<a href="javascript:window.print()">x</a><a href=" Java&#x0A;Script:void(0)">y</a>',
        '<form action="javascript:go()"><button formaction="javascript:x()">b</button></form>',
        '<svg><a href="javascript:z()"><circle onclick="w()"/></a></svg>',
        // Not counted: no event handler, no javascript: URL, or where no browser runs one.
        '<div one="1" onfoo="x()" data-onclick="x()" title="javascript:tip">t</div>',
        '<a href="/page">ok</a><img src="javascript:x()"><link rel="icon" href="javascript:x()">',
      ].join(''),
    })

    expect(report.completeness.counters.html).toEqual({ nomodule: 0, inlineHandlers: 8 })
    expect(report.findings).toEqual([])
    expect(report.artifacts).toEqual([])
    expect(report.completeness.level).toBe('complete')
  })

  test('the contents of <template>, <noscript> and iframe srcdoc are ignored', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<head><noscript><script>window.fetch = a</script></noscript></head>',
        '<template><script>window.alert = b</script><script nomodule>c</script><img onerror="x()"></template>',
        '<noscript><script src="n.js"></script><a href="javascript:x()"></a></noscript>',
        '<iframe srcdoc="<script>window.open = c</script><img onerror=x()>"></iframe>',
        '<template><base href="/elsewhere/"></template><script src="main.js"></script>',
      ].join(''),
      'n.js': 'window.print = d',
      'main.js': 'window.stop = e',
    })

    // The file a `<script src>` in `<noscript>` names is not followed, but the sweep still finds it (§2 Sweep).
    expect(fingerprints(report)).toEqual(['window|Window.print|replace|unknown', 'window|Window.stop|replace|unknown'])
    expect(report.artifacts.map(({ path, discovery }: Json) => [path, discovery])).toEqual([
      ['main.js', 'reference'],
      ['n.js', 'sweep'],
    ])
    expect(report.completeness.counters.html).toEqual({ nomodule: 0, inlineHandlers: 0 })
  })
})

describe('HTML rules (§19): <link rel=preload as=script>', () => {
  test('joins the artifact graph, resolved against the base URL', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<base href="/static/">',
        '<link rel="preload" as="script" href="chunk.js">',
        '<link rel="Preload  stylesheet" as="SCRIPT" href="/c2.js">',
        '<link rel="preload" as="style" href="s.js"><link rel="prefetch" as="script" href="p.js">',
        '<link rel="preload" as="script" href="https://cdn.example/x.js">',
      ].join(''),
      'static/chunk.js': 'window.fetch = a',
      'c2.js': 'window.alert = b',
      'static/s.js': 'window.open = c',
      'static/p.js': 'window.print = d',
    })

    expect(report.artifacts).toEqual([
      expect.objectContaining({ url: 'https://app.example/c2.js', path: 'c2.js' }),
      {
        url: 'https://app.example/static/chunk.js',
        path: 'static/chunk.js',
        hash: expect.any(String),
        origin: 'local-build',
        discovery: 'reference',
        // A file only a preload names is analyzed like a sweep-only file (§2 Files that don't run as
        // referenced): its source type comes from its syntax, and its realm is assumed.
        sourceType: 'script',
        realm: 'window',
        realmBasis: 'assumed',
        parent: 'https://app.example/',
        sourceMap: { method: 'none', path: null, status: 'none' },
        retrieval: {
          status: 'ok',
          requestedUrl: 'https://app.example/static/chunk.js',
          finalUrl: 'https://app.example/static/chunk.js',
          contentType: null,
          sri: 'none',
        },
        moduleLinking: { idioms: [], modules: 0, unlinked: 0, linkGroups: 1 },
      },
      // Only the sweep finds the files no script preload names (§2 Sweep).
      expect.objectContaining({ url: 'https://app.example/static/p.js', discovery: 'sweep', parent: null }),
      expect.objectContaining({ url: 'https://app.example/static/s.js', discovery: 'sweep', parent: null }),
      expect.objectContaining({
        url: 'https://cdn.example/x.js',
        origin: 'cross-origin',
        retrieval: expect.objectContaining({ status: 'offline-skipped' }),
      }),
    ])
    expect(report.completeness.limitations.map(({ kind }: Json) => kind)).toEqual(['offline-skipped'])
  })

  test('never makes the file run: it is analyzed after every script that runs, as a group of its own', async () => {
    const resolver = spyResolver()

    const { report } = await scanBuild(
      {
        'index.html': [
          '<link rel="preload" as="script" href="a.js"><link rel="preload" as="script" href="b.js">',
          '<script src="z.js"></script><script type="module" src="b.js"></script>',
        ].join(''),
        'a.js': 'window.fetch = a',
        'b.js': 'window.alert = b',
        'z.js': 'window.open = c',
      },
      [],
      { deps: { resolver } },
    )

    expect(resolver.entries).toEqual([
      'https://app.example/b.js',
      'https://app.example/z.js',
      'https://app.example/a.js',
    ])
    // A script that also names a preloaded file runs it, as its type says.
    expect(report.artifacts.map(({ url, sourceType }: Json) => [url, sourceType])).toEqual([
      ['https://app.example/a.js', 'script'],
      ['https://app.example/b.js', 'module'],
      ['https://app.example/z.js', 'script'],
    ])
    expect(fingerprints(report)).toEqual([
      'window|Window.alert|replace|unknown',
      'window|Window.fetch|replace|unknown',
      'window|Window.open|replace|unknown',
    ])
  })
})

describe('completeness records (§13, §15 Determinism)', () => {
  const files = {
    'index.html': [
      '<script src="z.js"></script><script src="https://cdn.example/sdk.js"></script>',
      '<script src="broken.js"></script><script src="missing.js"></script><script>eval(a); eval(b)</script>',
    ].join(''),
    'z.js': 'window.fetch = f; eval(x)',
    'broken.js': 'window.alert = (',
  }

  test('are sorted by artifact, then location, whatever order the modules raised them in', async () => {
    const { report } = await scanBuild(files)

    const records = report.completeness.limitations.map(({ kind, artifact, location }: Json) => [
      kind,
      artifact.url,
      location?.start,
    ])
    expect(records).toEqual([
      ['dynamic-code', 'https://app.example/#inline-1', 5],
      ['dynamic-code', 'https://app.example/#inline-1', 14],
      ['parse-failure', 'https://app.example/broken.js', undefined],
      ['unreadable', 'https://app.example/missing.js', undefined],
      ['dynamic-code', 'https://app.example/z.js', 23],
      ['offline-skipped', 'https://cdn.example/sdk.js', undefined],
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({
      known: 5,
      analyzed: 2,
      failed: { 'parse-failure': 1, unreadable: 1 },
      skipped: { offline: 1 },
    })
  })

  test('two scans of copies of the build give byte-identical reports, except run', async () => {
    const first = await scanBuild(files)
    const second = await scanBuild(files)

    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
  })
})

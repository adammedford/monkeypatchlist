import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { assertValidReport, defaultMap, fixtureBuild, runCli, scanBuild } from './support/fixture-build.ts'

const page = '<!doctype html><script src="main.js"></script>'

describe('monkeypatchlist scan: output channels (§15)', () => {
  test('--json <path> writes the JSON report to the file, and the terminal report to stdout', async () => {
    const dir = fixtureBuild({ 'index.html': page, 'main.js': 'window.fetch = function(){}' })
    const out = join(fixtureBuild({}), 'report.json')

    const run = await runCli(['scan', dir, '--map', defaultMap, '--json', out])

    expect(run.exitCode).toBe(0)
    const report = JSON.parse(readFileSync(out, 'utf8'))
    assertValidReport(report)
    expect(report.findings).toHaveLength(1)
    expect(run.stdout).not.toBe('')
    expect(() => JSON.parse(run.stdout)).toThrow()
    expect(run.stderr).toBe('')
  })

  test('--json - writes the JSON report to stdout instead of the terminal report', async () => {
    const { stdout, stderr, report } = await scanBuild({ 'index.html': page, 'main.js': 'window.fetch = function(){}' })

    expect(JSON.parse(stdout)).toEqual(report)
    expect(stdout.endsWith('}\n')).toBe(true)
    expect(stderr).toBe('')
  })

  test('without --json, only the terminal report is written', async () => {
    const dir = fixtureBuild({ 'index.html': page, 'main.js': 'window.fetch = function(){}' })

    const run = await runCli(['scan', dir, '--map', defaultMap])

    expect(run.exitCode).toBe(0)
    expect(run.stdout).not.toBe('')
    expect(() => JSON.parse(run.stdout)).toThrow()
  })
})

describe('monkeypatchlist scan: determinism (§15)', () => {
  const files = {
    'index.html': '<script src="main.js"></script><script>window.alert = c</script>',
    'main.js': 'window.setTimeout = a\nwindow.fetch = b\n',
  }

  test('two runs, even over copies of the build in different directories, are byte-identical except run', async () => {
    const first = await scanBuild(files)
    const second = await scanBuild(files)

    expect(first.dir).not.toBe(second.dir)
    const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))
    expect(beforeRun(first.stdout)).toBe(beforeRun(second.stdout))
    expect(beforeRun(first.stdout).length).toBeGreaterThan(0)
    expect({ ...first.report, run: null }).toEqual({ ...second.report, run: null })
  })

  test('findings are sorted by fingerprint', async () => {
    const { report } = await scanBuild(files)

    expect(report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      'window|Window.alert|replace|inline',
      'window|Window.fetch|replace|unknown',
      'window|Window.setTimeout|replace|unknown',
    ])
  })
})

describe('monkeypatchlist scan: occurrences (§8, §5 Positions, §14)', () => {
  test('carry the generated location as a UTF-16 range, a 1-based line and a 0-based column', async () => {
    const { report } = await scanBuild({
      'index.html': page,
      // Lines end at CRLF, U+2028, CR and LF. "é😀" is three UTF-16 code units.
      'main.js': 'const s = "é😀";\r\nwindow.fetch = function(){} x;\rfetch = 1;\n  self.fetch = 2',
    })

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].occurrences.map((occurrence: { generated: unknown }) => occurrence.generated)).toEqual([
      { start: 18, end: 45, line: 2, column: 0 },
      { start: 49, end: 58, line: 4, column: 0 },
      { start: 62, end: 76, line: 5, column: 2 },
    ])
  })

  test('carry their artifact, mechanism, realm instance, confidence and a binding trace', async () => {
    const { report } = await scanBuild({ 'index.html': page, 'main.js': 'window.fetch = f\nfetch = g\n' })

    const [viaWindow, bare] = report.findings[0].occurrences
    expect(Object.keys(viaWindow)).toEqual([
      'artifact',
      'generated',
      'original',
      'mechanism',
      'reachability',
      'reachabilityBasis',
      'installContext',
      'installEntry',
      'realmInstance',
      'evidence',
      'confidence',
      'trace',
    ])
    // With no source map, there is no original location, and no attribution evidence (§10).
    expect(viaWindow.original).toBeNull()
    expect(viaWindow.evidence).toEqual({})
    expect(viaWindow.artifact).toEqual({
      url: 'https://app.example/main.js',
      hash: report.artifacts[0].hash,
      origin: 'local-build',
    })
    expect(viaWindow.mechanism).toBe('assign')
    expect(viaWindow.realmInstance).toBe('current')
    expect(viaWindow.trace).toEqual([
      expect.objectContaining({
        kind: 'binding',
        name: 'window',
        resolution: 'alias',
        aliasOf: 'Window',
        realm: 'window',
        realmInstance: 'current',
      }),
    ])
    expect(bare.trace).toEqual([
      expect.objectContaining({
        kind: 'binding',
        name: 'fetch',
        resolution: 'global',
        realm: 'window',
        realmInstance: 'current',
      }),
    ])
  })
})

describe('monkeypatchlist scan: the JSON report (§15)', () => {
  test('has reportVersion 1, tool, application, config, summary, gate, completeness, baseline, packages, findings, ineffectiveWrites, artifacts and run, in that order', async () => {
    const { report } = await scanBuild({ 'index.html': page, 'main.js': 'window.fetch = function(){}' }, ['--surface', 'protected'])

    expect(Object.keys(report)).toEqual([
      'reportVersion',
      'tool',
      'application',
      'config',
      'summary',
      'gate',
      'completeness',
      'baseline',
      'packages',
      'findings',
      'ineffectiveWrites',
      'artifacts',
      'run',
    ])
    expect(report.reportVersion).toBe(1)
    expect(Object.keys(report.tool)).toEqual(['monkeypatchlistVersion', 'catalogVersion', 'analyzerVersion', 'fingerprintScheme'])
    expect(report.tool.monkeypatchlistVersion).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version)
    expect(report.tool.catalogVersion).toBe(JSON.parse(readFileSync('catalog/catalog.json', 'utf8')).metadata.catalogVersion)
    expect(report.tool.fingerprintScheme).toBe(1)
    expect(report.config).toEqual({
      scanConfigId: expect.stringMatching(/^[0-9a-f]{12}(\.[0-9a-f]{12}){3}$/),
      surface: 'protected',
      mode: 'offline',
      entries: [{ file: 'index.html', url: 'https://app.example/' }],
      mappings: [{ url: 'https://app.example/', dir: '.' }],
      sourceMaps: [],
      lockfile: null,
      failOn: [],
    })
    expect(Object.keys(report.run)).toEqual(['startedAt', 'durationMs', 'retrievals'])
  })

  test('a finding carries its target, target key, surface, effect, attribution, confidence, and a null baseline state, match and policy', async () => {
    const { report } = await scanBuild({ 'index.html': page, 'main.js': 'window.fetch = function(){}' })

    const [finding] = report.findings
    expect(Object.keys(finding)).toEqual([
      'fingerprint',
      'targetKey',
      'target',
      'surface',
      'effect',
      'locks',
      'attribution',
      'reachability',
      'reachabilityBasis',
      'installContext',
      'confidence',
      'baselineState',
      'matchedBy',
      'changedReasons',
      'notes',
      'policy',
      'occurrences',
    ])
    expect(finding).toMatchObject({
      fingerprint: 'window|Window.fetch|replace|unknown',
      targetKey: 'window|Window.fetch|replace',
      target: { realm: 'window', holder: 'global', name: 'Window.fetch' },
      surface: 'networking',
      effect: 'replace',
      locks: false,
      attribution: { key: 'unknown', provenance: 'unknown' },
      baselineState: null,
      matchedBy: null,
      changedReasons: [],
      notes: [],
      policy: null,
    })
  })

  test('lists the analyzed artifacts, sorted by URL', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="z.js"></script><script>1</script><script src="a.js"></script>',
      'z.js': '2',
      'a.js': '',
    })

    expect(report.artifacts.map((artifact: { url: string }) => artifact.url)).toEqual([
      'https://app.example/#inline-1',
      'https://app.example/a.js',
      'https://app.example/z.js',
    ])
    expect(report.artifacts[1]).toEqual({
      url: 'https://app.example/a.js',
      path: 'a.js',
      // sha256 of the empty string
      hash: 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      origin: 'local-build',
      discovery: 'reference',
      sourceType: 'script',
      realm: 'window',
      realmBasis: 'reference',
      parent: 'https://app.example/',
      sourceMap: { method: 'none', path: null, status: 'none' },
      retrieval: {
        status: 'ok',
        requestedUrl: 'https://app.example/a.js',
        finalUrl: 'https://app.example/a.js',
        contentType: null,
        sri: 'none',
      },
      moduleLinking: { idioms: [], modules: 0, unlinked: 0, linkGroups: 1 },
    })
    expect(report.artifacts[0]).toMatchObject({ path: null, origin: 'inline', parent: 'https://app.example/' })
  })

  test('scripts the browser would not run as classic scripts are not analyzed', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script type="text/template">window.fetch = a</script>',
        '<script type="text/javascript">window.setTimeout = b</script>',
        '<template><script>window.alert = c</script></template>',
        // §19 HTML rules: `<script nomodule>` is not analyzed, though the sweep finds a local file it names (§2).
        '<script nomodule>window.open = d</script>',
        '<script nomodule src="legacy.js"></script>',
      ].join(''),
      'legacy.js': 'window.print = e',
    })

    expect(report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      'window|Window.print|replace|unknown',
      'window|Window.setTimeout|replace|inline',
    ])
    // Inline scripts are numbered among all the document's inline scripts, whatever their type.
    expect(report.artifacts.map(({ url, discovery }: { url: string; discovery: string }) => [url, discovery])).toEqual([
      ['https://app.example/#inline-2', 'reference'],
      ['https://app.example/legacy.js', 'sweep'],
    ])
  })

  test('a type=module script is analyzed as a module, and ignores nomodule (§19 HTML rules)', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script type="module">window.fetch = a</script>',
        '<script type=" Module " nomodule src="app.js"></script>',
      ].join(''),
      'app.js': 'window.setTimeout = b',
    })

    expect(report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      'window|Window.fetch|replace|inline',
      'window|Window.setTimeout|replace|unknown',
    ])
    expect(report.artifacts.map(({ url, sourceType }: { url: string; sourceType: string }) => [url, sourceType])).toEqual([
      ['https://app.example/#inline-1', 'module'],
      ['https://app.example/app.js', 'module'],
    ])
  })
})

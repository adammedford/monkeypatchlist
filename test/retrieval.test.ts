// Fixture fetcher and retrieval records (§17 Modes, What is recorded; §19 Source store and retrieval; §15
// `run`). Remote artifacts are served through the fixture fetcher, swapped in as the CLI's resolve fetcher.

import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { exitCodes } from '../src/cli.ts'
import type { Fetcher } from '../src/packages/source-store/index.ts'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, scanBuild, workingDir } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const sha256 = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const resolve = ['--mode', 'resolve']

describe('modes (§17 Modes, §16 `--mode`)', () => {
  const files = {
    'index.html': '<script src="main.js"></script><script type="module" src="https://cdn.example/sdk.js"></script>',
    'main.js': 'import("https://cdn.example/lazy.js"); window.alert = g',
  }
  const served = fixtureFetcher({
    'https://cdn.example/sdk.js': { headers: { 'content-type': 'text/javascript' }, body: 'window.fetch = f' },
    'https://cdn.example/lazy.js': { headers: { 'content-type': 'text/javascript' }, body: 'window.open = h' },
  })
  /** The fixture fetcher, recording each URL it is asked for. */
  function spy(): Fetcher & { urls: string[] } {
    const urls: string[] = []
    return { urls, fetch: (url, request) => (urls.push(url), served.fetch(url, request)) }
  }
  const config = (value: unknown) => workingDir({ 'monkeypatchlist.config.json': JSON.stringify(value) })

  test('offline, the default, never asks the resolve fetcher, and each remote reference is `offline-skipped`', async () => {
    const resolveFetcher = spy()

    const { report } = await scanBuild(files, [], { deps: { resolveFetcher: () => resolveFetcher } })

    expect(resolveFetcher.urls).toEqual([])
    expect(report.config.mode).toBe('offline')
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
      ['offline-skipped', 'https://cdn.example/lazy.js'],
      ['offline-skipped', 'https://cdn.example/sdk.js'],
    ])
    expect(report.artifacts.map(({ url, retrieval }: Json) => [url, retrieval.status])).toEqual([
      ['https://app.example/main.js', 'ok'],
      ['https://cdn.example/lazy.js', 'offline-skipped'],
      ['https://cdn.example/sdk.js', 'offline-skipped'],
    ])
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 3, analyzed: 1, skipped: { offline: 2 } })
  })

  test('`--mode offline` and `baseline init` without `--mode resolve` never ask the resolve fetcher either', async () => {
    const resolveFetcher = spy()
    const build = fixtureBuild(files)

    const scan = await runCli(['scan', build, '--map', defaultMap, '--mode', 'offline'], { deps: { resolveFetcher: () => resolveFetcher } })
    const init = await runCli(['baseline', 'init', build, '--map', defaultMap], { deps: { resolveFetcher: () => resolveFetcher } })

    expect([scan.exitCode, init.exitCode]).toEqual([0, 0])
    expect(resolveFetcher.urls).toEqual([])
  })

  test('`--mode resolve` fetches each remote reference through the resolve fetcher, in scan and baseline commands', async () => {
    const resolveFetcher = spy()
    const build = fixtureBuild(files)

    const { report } = await scanBuild(build, resolve, { deps: { resolveFetcher: () => resolveFetcher } })
    const init = await runCli(['baseline', 'init', build, '--map', defaultMap, ...resolve], {
      deps: { resolveFetcher: () => resolveFetcher },
    })

    expect(init.exitCode).toBe(0)
    expect(resolveFetcher.urls.sort()).toEqual([
      'https://cdn.example/lazy.js',
      'https://cdn.example/lazy.js',
      'https://cdn.example/sdk.js',
      'https://cdn.example/sdk.js',
    ])
    expect(report.completeness.limitations).toEqual([])
    expect(report.findings.map(({ targetKey }: Json) => targetKey)).toEqual([
      'window|Window.alert|replace',
      'window|Window.fetch|replace',
      'window|Window.open|replace',
    ])
  })

  test('the config key `mode` selects the fetcher, and `--mode` overrides it', async () => {
    const resolveFetcher = spy()
    const build = fixtureBuild(files)
    const cwd = config({ mappings: [{ url: 'https://app.example/', dir: '.' }], mode: 'resolve' })

    const fromFile = await runCli(['scan', build, '--json', '-'], { cwd, deps: { resolveFetcher: () => resolveFetcher } })
    const fetched = resolveFetcher.urls.length
    const overridden = await runCli(['scan', build, '--mode', 'offline', '--json', '-'], {
      cwd,
      deps: { resolveFetcher: () => resolveFetcher },
    })

    const [fromFileReport, overriddenReport] = [fromFile, overridden].map(({ stdout }) => JSON.parse(stdout) as Json)
    assertValidReport(fromFileReport)
    assertValidReport(overriddenReport)
    expect(fromFileReport.config.mode).toBe('resolve')
    expect(fetched).toBe(2)
    expect(overriddenReport.config.mode).toBe('offline')
    expect(resolveFetcher.urls).toHaveLength(2)
  })

  test('`--mode resolve` without a resolve fetcher is a usage error, before any baseline is read, and nothing is scanned', async () => {
    const build = fixtureBuild(files)
    const deps = { resolveFetcher: null }

    const run = await runCli(['scan', build, '--map', defaultMap, ...resolve, '--json', '-'], { deps })
    // `baseline update` first reads the baseline it rewrites, and this working directory has none.
    const update = await runCli(['baseline', 'update', build, '--map', defaultMap, ...resolve], { deps })

    expect(run.exitCode).toBe(exitCodes.usage)
    expect(run.stderr).toContain('--mode resolve')
    expect(run.stdout).toBe('')
    expect(update.exitCode).toBe(exitCodes.usage)
    expect(update.stderr).toContain('--mode resolve')
    expect(update.stderr).not.toContain('readable baseline')
  })

  test.each([
    ['a mode that does not exist', ['--mode', 'online']],
    ['--mode given twice', ['--mode', 'offline', '--mode', 'resolve']],
  ])('%s is a usage error', async (_, args) => {
    const run = await runCli(['scan', fixtureBuild(files), '--map', defaultMap, ...args])

    expect(run.exitCode).toBe(exitCodes.usage)
    expect(run.stderr).toContain('--mode')
  })

  test('the mode is not part of the scan-config id (§16)', async () => {
    const build = fixtureBuild(files)
    const offline = await scanBuild(build)
    const resolved = await scanBuild(build, resolve, { deps: { resolveFetcher: () => served } })

    expect(resolved.report.config.scanConfigId).toBe(offline.report.config.scanConfigId)
  })
})

describe('retrieval records (§17 What is recorded, §15 Artifacts)', () => {
  test('every artifact records its status, requested and final URL, content type and SRI check', async () => {
    const { report } = await scanBuild({
      'index.html': [
        '<script src="app.js?v=1"></script>',
        '<script>window.alert = g</script>',
        '<script src="missing.js"></script>',
        '<script src="https://cdn.example/sdk.js"></script>',
      ].join(''),
      'app.js': 'window.fetch = f',
    })

    expect(report.artifacts.map(({ url, retrieval }: Json) => [url, retrieval])).toEqual([
      [
        'https://app.example/#inline-1',
        { status: 'ok', requestedUrl: null, finalUrl: null, contentType: null, sri: 'none' },
      ],
      [
        'https://app.example/app.js?v=1',
        {
          status: 'ok',
          requestedUrl: 'https://app.example/app.js?v=1',
          finalUrl: 'https://app.example/app.js?v=1',
          contentType: null,
          sri: 'none',
        },
      ],
      [
        'https://app.example/missing.js',
        {
          status: 'unreadable',
          requestedUrl: 'https://app.example/missing.js',
          finalUrl: 'https://app.example/missing.js',
          contentType: null,
          sri: 'none',
        },
      ],
      [
        'https://cdn.example/sdk.js',
        {
          status: 'offline-skipped',
          requestedUrl: 'https://cdn.example/sdk.js',
          finalUrl: null,
          contentType: null,
          sri: 'none',
        },
      ],
    ])
  })
})

describe('the run block (§15, §17 What is recorded)', () => {
  const scripts = ['sdk', 'moved', 'gone', 'missing'].map((name) => `<script src="https://cdn.example/${name}.js">`)
  const files = { 'index.html': scripts.map((script) => `${script}</script>`).join('') }
  /** The fixture a run fetches through: the same bytes and content types each time, with the ETags `version` gives. */
  const served = (version: number, lastModified: string) =>
    fixtureFetcher({
      'https://cdn.example/sdk.js': {
        headers: { 'content-type': 'text/javascript', ETag: `"sdk-${version}"`, 'Last-Modified': lastModified },
        body: 'window.fetch = f',
      },
      'https://cdn.example/moved.js': {
        status: 302,
        headers: { location: '/v2/moved.js', etag: '"redirect"', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
      },
      'https://cdn.example/v2/moved.js': {
        headers: { 'content-type': 'text/javascript', etag: `"moved-${version}"` },
        body: 'window.alert = g',
      },
      'https://cdn.example/gone.js': { status: 410, headers: { 'Last-Modified': lastModified } },
    })
  const clock = (iso: string) => () => new Date(iso)
  const beforeRun = (stdout: string) => stdout.slice(0, stdout.indexOf('\n  "run": {'))

  test('holds when each fetch finished, and the final response’s ETag and Last-Modified, by requested URL', async () => {
    const { report } = await scanBuild(files, resolve, {
      deps: { resolveFetcher: () => served(1, 'Tue, 02 Jan 2024 00:00:00 GMT'), now: clock('2026-09-27T10:00:00.000Z') },
    })

    expect(report.run.startedAt).toBe('2026-09-27T10:00:00.000Z')
    expect(report.run.retrievals).toEqual({
      'https://cdn.example/gone.js': {
        fetchedAt: '2026-09-27T10:00:00.000Z',
        etag: null,
        lastModified: 'Tue, 02 Jan 2024 00:00:00 GMT',
      },
      'https://cdn.example/missing.js': { fetchedAt: '2026-09-27T10:00:00.000Z', etag: null, lastModified: null },
      'https://cdn.example/moved.js': { fetchedAt: '2026-09-27T10:00:00.000Z', etag: '"moved-1"', lastModified: null },
      'https://cdn.example/sdk.js': {
        fetchedAt: '2026-09-27T10:00:00.000Z',
        etag: '"sdk-1"',
        lastModified: 'Tue, 02 Jan 2024 00:00:00 GMT',
      },
    })
  })

  test('two runs with different fetch times, ETags and Last-Modified give byte-identical reports outside run', async () => {
    const first = await scanBuild(files, resolve, {
      deps: { resolveFetcher: () => served(1, 'Tue, 02 Jan 2024 00:00:00 GMT'), now: clock('2026-09-27T10:00:00.000Z') },
    })
    const second = await scanBuild(files, resolve, {
      deps: { resolveFetcher: () => served(2, 'Wed, 03 Jan 2024 00:00:00 GMT'), now: clock('2027-03-01T08:30:00.000Z') },
    })

    expect(second.report.run.retrievals).not.toEqual(first.report.run.retrievals)
    expect(beforeRun(first.stdout).length).toBeGreaterThan(0)
    expect(beforeRun(second.stdout)).toBe(beforeRun(first.stdout))
    expect({ ...second.report, run: null }).toEqual({ ...first.report, run: null })
    expect(first.report.findings).toHaveLength(2)
  })

  test('offline, nothing is fetched, so there are no retrievals', async () => {
    const { report } = await scanBuild(files)

    expect(report.run.retrievals).toEqual({})
  })
})

describe('the fixture fetcher (§19 Source store and retrieval)', () => {
  test('serves a remote script in resolve mode, which is then analyzed like any other artifact', async () => {
    const resolveFetcher = fixtureFetcher({
      'https://cdn.example/sdk.js': { headers: { 'Content-Type': 'text/javascript' }, body: 'window.fetch = f' },
    })

    const { report } = await scanBuild(
      { 'index.html': '<script src="https://cdn.example/sdk.js"></script>' },
      resolve,
      { deps: { resolveFetcher: () => resolveFetcher } },
    )

    expect(report.config.mode).toBe('resolve')
    expect(report.artifacts).toEqual([
      {
        url: 'https://cdn.example/sdk.js',
        path: null,
        hash: sha256('window.fetch = f'),
        origin: 'cross-origin',
        discovery: 'reference',
        sourceType: 'script',
        realm: 'window',
        realmBasis: 'reference',
        parent: 'https://app.example/',
        sourceMap: { method: 'none', path: null, status: 'none' },
        retrieval: {
          status: 'ok',
          requestedUrl: 'https://cdn.example/sdk.js',
          finalUrl: 'https://cdn.example/sdk.js',
          contentType: 'text/javascript',
          sri: 'none',
        },
        moduleLinking: { idioms: [], modules: 0, unlinked: 0, linkGroups: 1 },
      },
    ])
    const found = report.findings.map(({ targetKey, occurrences }: Json) => [targetKey, occurrences[0].artifact.url])
    expect(found).toEqual([['window|Window.fetch|replace', 'https://cdn.example/sdk.js']])
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 1, analyzed: 1 })
  })

  test('follows recorded redirects: the final URL is recorded, and the URL and origin stay the requested ones', async () => {
    const resolveFetcher = fixtureFetcher({
      'https://app.example/vendor/sdk.js': { status: 301, headers: { Location: 'https://cdn.example/v2/sdk.js' } },
      'https://cdn.example/v2/sdk.js': { status: 302, headers: { location: '../v3/sdk.js' } },
      'https://cdn.example/v3/sdk.js': {
        headers: { 'content-type': 'application/javascript; charset=utf-8' },
        body: 'window.alert = g',
      },
    })

    const { report } = await scanBuild(
      { 'index.html': '<script src="/vendor/sdk.js#main"></script>', 'static/app.js': '' },
      [...resolve, '--map', 'https://app.example/static/=static', '--entry', 'index.html@https://app.example/'],
      { deps: { resolveFetcher: () => resolveFetcher } },
    )

    expect(report.artifacts).toEqual([
      // The build's own file, which only the sweep finds (§2 Sweep).
      expect.objectContaining({ url: 'https://app.example/static/app.js', discovery: 'sweep' }),
      expect.objectContaining({
        url: 'https://app.example/vendor/sdk.js#main',
        origin: 'same-origin',
        hash: sha256('window.alert = g'),
        retrieval: {
          status: 'ok',
          requestedUrl: 'https://app.example/vendor/sdk.js#main',
          finalUrl: 'https://cdn.example/v3/sdk.js',
          contentType: 'application/javascript; charset=utf-8',
          sri: 'none',
        },
      }),
    ])
    expect(report.findings.map(({ occurrences }: Json) => occurrences[0].artifact)).toEqual([
      { url: 'https://app.example/vendor/sdk.js#main', hash: sha256('window.alert = g'), origin: 'same-origin' },
    ])
  })

  test('a non-2xx response and a URL with no recorded response are `fetch-failed` (§17 Outcomes)', async () => {
    const resolveFetcher = fixtureFetcher({
      'https://cdn.example/gone.js': { status: 404, headers: { 'content-type': 'text/html' }, body: '<h1>Gone</h1>' },
      'https://cdn.example/moved.js': { status: 307, headers: { location: 'https://cdn.example/gone.js' } },
      'https://cdn.example/ok.js': { body: 'window.fetch = f' },
    })
    const names = ['gone', 'moved', 'missing', 'ok']
    const page = names.map((name) => `<script src="https://cdn.example/${name}.js"></script>`).join('')

    const { report } = await scanBuild({ 'index.html': page }, resolve, { deps: { resolveFetcher: () => resolveFetcher } })

    const failed = (url: string, finalUrl: string | null, contentType: string | null) => ({
      url,
      path: null,
      hash: null,
      origin: 'cross-origin',
      discovery: 'reference',
      sourceType: 'script',
      realm: 'window',
      realmBasis: 'reference',
      parent: 'https://app.example/',
      sourceMap: { method: 'none', path: null, status: 'none' },
      retrieval: { status: 'fetch-failed', requestedUrl: url, finalUrl, contentType, sri: 'none' },
      moduleLinking: { idioms: [], modules: 0, unlinked: 0, linkGroups: 0 },
    })
    expect(report.artifacts).toEqual([
      failed('https://cdn.example/gone.js', 'https://cdn.example/gone.js', 'text/html'),
      failed('https://cdn.example/missing.js', null, null),
      failed('https://cdn.example/moved.js', 'https://cdn.example/gone.js', 'text/html'),
      expect.objectContaining({
        url: 'https://cdn.example/ok.js',
        retrieval: expect.objectContaining({ status: 'ok' }),
      }),
    ])
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
      ['fetch-failed', 'https://cdn.example/gone.js'],
      ['fetch-failed', 'https://cdn.example/missing.js'],
      ['fetch-failed', 'https://cdn.example/moved.js'],
    ])
    expect(report.completeness.limitations[0].detail).toContain('404')
    expect(report.completeness.level).toBe('incomplete')
    expect(report.completeness.counters.artifacts).toMatchObject({
      known: 4,
      analyzed: 1,
      failed: { 'fetch-failed': 3 },
    })
    expect(report.findings.map(({ targetKey }: Json) => targetKey)).toEqual(['window|Window.fetch|replace'])
  })

  // The fixture fetcher follows redirects as the floor does.
  test('follows at most 5 redirects: a sixth, and a loop, are `remote-refused` (§17 Safety floor, Outcomes)', async () => {
    /** `/<name>0.js` redirects to `/<name>1.js`, and so on to `/<name><last>.js`, which serves a script. */
    const chain = (name: string, last: number) =>
      Object.fromEntries(
        Array.from({ length: last + 1 }, (_, n) => [
          `https://cdn.example/${name}${n}.js`,
          n < last ? { status: 302, headers: { location: `/${name}${n + 1}.js` } } : { body: `window.${name} = f` },
        ]),
      )
    const resolveFetcher = fixtureFetcher({
      ...chain('five', 5),
      ...chain('six', 6),
      'https://cdn.example/a.js': { status: 302, headers: { location: '/b.js' } },
      'https://cdn.example/b.js': { status: 302, headers: { location: '/a.js' } },
    })
    const page = ['five0', 'six0', 'a'].map((name) => `<script src="https://cdn.example/${name}.js"></script>`).join('')

    const { report } = await scanBuild({ 'index.html': page }, resolve, { deps: { resolveFetcher: () => resolveFetcher } })

    expect(report.artifacts.map(({ url, retrieval }: Json) => [url, retrieval.status, retrieval.finalUrl])).toEqual([
      ['https://cdn.example/a.js', 'remote-refused', null],
      ['https://cdn.example/five0.js', 'ok', 'https://cdn.example/five5.js'],
      ['https://cdn.example/six0.js', 'remote-refused', null],
    ])
    expect(report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])).toEqual([
      ['remote-refused', 'https://cdn.example/a.js'],
      ['remote-refused', 'https://cdn.example/six0.js'],
    ])
    expect(report.completeness.limitations[0].detail).toContain('5 redirects')
    expect(report.completeness.level).toBe('complete-with-limitations')
    expect(report.completeness.counters.artifacts).toMatchObject({ known: 3, analyzed: 1, skipped: { refused: 2 } })
  })
})

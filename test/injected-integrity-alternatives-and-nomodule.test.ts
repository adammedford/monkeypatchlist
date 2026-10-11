// Injected scripts: integrity alternatives and `noModule` (§2 Injected scripts; §13 Counters; §17 Integrity;
// §21 `nomodule`).

import { createHash } from 'node:crypto'
import { describe, expect, test } from 'vitest'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

const fingerprints = (report: Json) => report.findings.map(({ fingerprint }: Json) => fingerprint)
const kinds = (report: Json, kind: string) => report.completeness.limitations.filter((record: Json) => record.kind === kind)

describe('integrity alternatives of an injected script (§17 Integrity)', () => {
  const sdk = 'window.fetch = f'
  const digest = (algorithm: 'sha256' | 'sha384' | 'sha512', bytes = sdk) => `${algorithm}-${createHash(algorithm).update(bytes).digest('base64')}`
  const scanWith = (code: string) =>
    scanBuild(
      {
        'index.html': '<script src="/js/snippet.js"></script>',
        'js/snippet.js': [
          'var legacy = location.search, s = document.createElement("script"); s.src = "https://cdn.example/sdk.js";',
          `${code}; document.head.appendChild(s)`,
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
  const pick = (a: string, b: string) => `s.integrity = legacy ? ${JSON.stringify(a)} : ${JSON.stringify(b)}`

  test('bytes that match one alternative are analyzed, and the check records that alternative', async () => {
    const { report } = await scanWith(pick('sha384-AAAA', digest('sha384')))

    expect(sdkOf(report).retrieval.sri).toEqual({ result: 'match', expected: [digest('sha384')], actual: digest('sha384') })
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|url:https://cdn.example/sdk.js'])
    expect(report.completeness.level).toBe('complete')
  })

  test('alternatives in different algorithms are each checked', async () => {
    // The strongest algorithm alone (sha512) would reject the bytes; the sha256 alternative matches.
    const { report } = await scanWith(pick(digest('sha256'), 'sha512-AAAA'))

    expect(sdkOf(report).retrieval.sri).toMatchObject({ result: 'match', actual: digest('sha256') })
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|url:https://cdn.example/sdk.js'])
  })

  test('separate writes are alternatives too', async () => {
    const { report } = await scanWith(`s.integrity = "sha384-AAAA"; if (legacy) s.integrity = ${JSON.stringify(digest('sha384'))}`)

    expect(sdkOf(report).retrieval.sri).toMatchObject({ result: 'match' })
    expect(report.completeness.level).toBe('complete')
  })

  test('bytes that match none give `sri-mismatch`, are withheld, and the scan is incomplete', async () => {
    const { report } = await scanWith(pick('sha384-AAAA', 'sha256-BBBB'))

    expect(sdkOf(report).retrieval.sri).toMatchObject({ result: 'mismatch' })
    expect(kinds(report, 'sri-mismatch').map(({ artifact }: Json) => artifact.url)).toEqual(['https://cdn.example/sdk.js'])
    expect(report.findings).toEqual([])
    expect(report.completeness.level).toBe('incomplete')
  })

  test('a set with an alternative that does not fold counts as none', async () => {
    const { report } = await scanWith(`s.integrity = legacy ? "sha384-AAAA" : config.integrity`)

    expect(sdkOf(report).retrieval.sri).toBe('none')
    expect(fingerprints(report)).toEqual(['window|Window.fetch|replace|url:https://cdn.example/sdk.js'])
  })
})

describe('an injected script with `noModule` (§2 Injected scripts)', () => {
  const snippet = (code: string, src = '/legacy.js') =>
    [`var s = document.createElement("script"); ${code}; s.src = ${JSON.stringify(src)}; document.head.appendChild(s)`].join('\n')
  const scan = (code: string, extra: Record<string, string> = {}, src?: string) =>
    scanBuild(
      { 'index.html': '<script src="/js/snippet.js"></script>', 'js/snippet.js': snippet(code, src), ...extra },
      ['--mode', 'resolve'],
      {
        deps: {
          resolveFetcher: () =>
            fixtureFetcher({ 'https://cdn.example/legacy.js': { headers: { 'content-type': 'text/javascript' }, body: 'window.fetch = f' } }),
        },
      },
    )
  const artifactsOf = (report: Json) => report.artifacts.map(({ url, discovery, realm, realmBasis }: Json) => [url, discovery, realm, realmBasis])

  test('a local file is not followed but is counted and swept, realm assumed `window`', async () => {
    const { report } = await scan('s.noModule = true', { 'legacy.js': 'window.print = e' })

    expect(artifactsOf(report)).toEqual([
      ['https://app.example/js/snippet.js', 'reference', 'window', 'reference'],
      ['https://app.example/legacy.js', 'sweep', 'window', 'assumed'],
    ])
    expect(fingerprints(report)).toEqual(['window|Window.print|replace|unknown'])
    expect(report.completeness.counters.html).toEqual({ nomodule: 1, inlineHandlers: 0 })
    expect(report.completeness.level).toBe('complete')
  })

  test('a remote file is not fetched, and is counted', async () => {
    const { report } = await scan('s.noModule = true', {}, 'https://cdn.example/legacy.js')

    expect(artifactsOf(report)).toEqual([['https://app.example/js/snippet.js', 'reference', 'window', 'reference']])
    expect(report.findings).toEqual([])
    expect(report.completeness.counters.html.nomodule).toBe(1)
  })

  test('`setAttribute("nomodule", …)` sets it, whatever the value', async () => {
    const { report } = await scan('s.setAttribute("nomodule", "false")', { 'legacy.js': '' })

    expect(artifactsOf(report).map(([url, discovery]: string[]) => [url, discovery])).toContainEqual(['https://app.example/legacy.js', 'sweep'])
    expect(report.completeness.counters.html.nomodule).toBe(1)
  })

  test('a falsy `noModule` is an ordinary injected script', async () => {
    const { report } = await scan('s.noModule = false', { 'legacy.js': '' })

    expect(artifactsOf(report)).toContainEqual(['https://app.example/legacy.js', 'injected', 'window', 'reference'])
    expect(report.completeness.counters.html.nomodule).toBe(0)
  })

  test('a module script ignores it, as HTML does', async () => {
    const { report } = await scan('s.type = "module"; s.noModule = true', { 'legacy.js': '' })

    expect(artifactsOf(report)).toContainEqual(['https://app.example/legacy.js', 'injected', 'window', 'reference'])
    expect(report.completeness.counters.html.nomodule).toBe(0)
  })

  test('a value that does not fold is both alternatives: followed, and counted in the same counter', async () => {
    const { report } = await scan('s.noModule = config.legacy', { 'legacy.js': 'window.print = e' })

    expect(artifactsOf(report)).toContainEqual(['https://app.example/legacy.js', 'injected', 'window', 'reference'])
    expect(fingerprints(report)).toEqual(['window|Window.print|replace|unknown'])
    expect(report.completeness.counters.html.nomodule).toBe(1)
  })

  test('writes of both values are both alternatives', async () => {
    const { report } = await scan('s.noModule = true; if (x) s.noModule = false', { 'legacy.js': '' })

    expect(artifactsOf(report)).toContainEqual(['https://app.example/legacy.js', 'injected', 'window', 'reference'])
    expect(report.completeness.counters.html.nomodule).toBe(1)
  })

  test('an element with two sources is counted once', async () => {
    const { report } = await scan('s.noModule = true', { 'a.js': '', 'b.js': '' }, '/a.js')
    expect(report.completeness.counters.html.nomodule).toBe(1)
    const two = await scanBuild({
      'index.html': '<script src="/js/snippet.js"></script>',
      'js/snippet.js': 'var s = document.createElement("script"); s.noModule = true; s.src = x ? "/a.js" : "/b.js"; document.head.appendChild(s)',
      'a.js': '',
      'b.js': '',
    })
    expect(two.report.completeness.counters.html.nomodule).toBe(1)
  })
})

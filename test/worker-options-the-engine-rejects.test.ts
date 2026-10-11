// Worker options the engine rejects (Principle 1, §2 Discovery).

import { describe, expect, test } from 'vitest'
import type { Fetcher } from '../src/packages/source-store/index.ts'
import { fixtureFetcher } from '../src/packages/source-store/fixture.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** Each artifact's URL, realm, discovery method and realm basis. */
const artifacts = (report: Json) =>
  report.artifacts.map(({ url, realm, discovery, realmBasis }: Json) => [url, realm, discovery, realmBasis])

/** Each limitation's kind and the URL of its artifact. */
const limitations = (report: Json) =>
  report.completeness.limitations.map(({ kind, artifact }: Json) => [kind, artifact.url])

describe('a primitive other than `null` or `undefined` passed to `Worker` gives nothing (Principle 1, §2)', () => {
  test('a string, number, boolean, BigInt or template literal: the mapped script is only swept, in the window', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': [
        "new Worker('/a.js', 'name')",
        "new Worker('/b.js', 5)",
        "new Worker('/c.js', true)",
        "new Worker('/d.js', 1n)",
        'new Worker("/e.js", `x`)',
      ].join('\n'),
      // a.js has a worker marker; the others don't.
      'a.js': 'importScripts("lib.js"); self.fetch = f',
      'b.js': 'self.fetch = g',
      'c.js': '// c',
      'd.js': '// d',
      'e.js': '// e',
      'lib.js': '// lib',
    })

    expect(artifacts(report)).toEqual([
      ['https://app.example/a.js', 'window', 'sweep', 'assumed'],
      ['https://app.example/app.js', 'window', 'reference', 'reference'],
      ['https://app.example/b.js', 'window', 'sweep', 'assumed'],
      ['https://app.example/c.js', 'window', 'sweep', 'assumed'],
      ['https://app.example/d.js', 'window', 'sweep', 'assumed'],
      ['https://app.example/e.js', 'window', 'sweep', 'assumed'],
      ['https://app.example/lib.js', 'window', 'sweep', 'assumed'],
    ])
    expect(limitations(report)).toEqual([['realm-uncertain', 'https://app.example/a.js']])
    // Their writes are the window's, with the realm assumed.
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual(['window|Window.fetch|replace|unknown'])
    expect(report.findings[0].occurrences.map(({ artifact, confidence }: Json) => [artifact.url, confidence.target.reasons])).toEqual([
      ['https://app.example/a.js', ['realm-assumed']],
      ['https://app.example/b.js', ['realm-assumed']],
    ])
  })

  test('a remote or unmapped script gives no artifact and no record, offline', async () => {
    const { report } = await scanBuild(
      {
        'index.html': '<script src="/static/app.js"></script>',
        'static/app.js': "new Worker('/remote/w.js', 'name'); new Worker('/static/missing.js', 7)",
      },
      [...['--map', 'https://app.example/static/=static'], ...['--entry', 'index.html@https://app.example/']],
    )

    expect(artifacts(report)).toEqual([['https://app.example/static/app.js', 'window', 'reference', 'reference']])
    expect(report.completeness.limitations).toEqual([])
  })

  test('in resolve mode, the remote script is never fetched', async () => {
    const requested: string[] = []
    const fixture = fixtureFetcher({
      'https://app.example/remote/w.js': { headers: { 'content-type': 'text/javascript' }, body: 'self.fetch = f' },
    })
    const fetcher: Fetcher = { fetch: (url, request) => (requested.push(url), fixture.fetch(url, request)) }

    const { report } = await scanBuild(
      {
        'index.html': '<script src="/static/app.js"></script>',
        'static/app.js': "new Worker('/remote/w.js', 'name'); new Worker('/remote/w.js', false)",
      },
      [
        ...['--mode', 'resolve', '--map', 'https://app.example/static/=static'],
        ...['--entry', 'index.html@https://app.example/'],
      ],
      { deps: { resolveFetcher: () => fetcher } },
    )

    expect(artifacts(report)).toEqual([['https://app.example/static/app.js', 'window', 'reference', 'reference']])
    expect(report.completeness.limitations).toEqual([])
    expect(requested).toEqual([])
    expect(report.run.retrievals).toEqual({})
  })
})

describe("a `type` literal other than `'classic'`, `'module'` or `undefined` gives nothing, on `Worker` and `SharedWorker` (Principle 1, §2)", () => {
  test('`null`, a number, a boolean or a regular expression converts to a string that is no worker type', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': [
        "new Worker('/a.js', { type: null })",
        "new Worker('/b.js', { type: 5 })",
        "new Worker('/c.js', { type: true })",
        "new SharedWorker('/d.js', { type: null })",
        "new SharedWorker('/e.js', { name: 'x', type: /module/ })",
        "new Worker('/f.js', { type: 'foo' })",
        // The last `type` decides, as a dictionary reads the object.
        "new Worker('/g.js', { type: 'module', type: 0 })",
      ].join('\n'),
      'a.js': 'self.fetch = f',
      ...Object.fromEntries(['b', 'c', 'd', 'e', 'f', 'g'].map((name) => [`${name}.js`, `// ${name}`])),
    })

    expect(artifacts(report)).toEqual([
      ['https://app.example/a.js', 'window', 'sweep', 'assumed'],
      ['https://app.example/app.js', 'window', 'reference', 'reference'],
      ...['b', 'c', 'd', 'e', 'f', 'g'].map((name) => [`https://app.example/${name}.js`, 'window', 'sweep', 'assumed']),
    ])
    expect(report.completeness.limitations).toEqual([])
    expect(report.findings.map(({ fingerprint }: Json) => fingerprint)).toEqual(['window|Window.fetch|replace|unknown'])
  })
})

describe('options the engine accepts keep a classic worker (§2)', () => {
  test("`SharedWorker` takes any primitive as its name; `null`, `undefined`, and object or regular-expression literals with no bad `type` are the default", async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': [
        "new SharedWorker('/a.js', 'name'); new SharedWorker('/b.js', 5); new SharedWorker('/c.js', true)",
        "new SharedWorker('/d.js', 1n); new SharedWorker('/e.js', `tab`); new SharedWorker('/f.js', null)",
        "new Worker('/g.js', null); new Worker('/h.js', undefined); new Worker('/i.js', {})",
        "new Worker('/j.js', /re/); new SharedWorker('/k.js', /re/); new Worker('/l.js', { type: 'classic' })",
        "new SharedWorker('/m.js', { type: undefined, name: 'n' })",
      ].join('\n'),
      // Module syntax throughout: a classic script that doesn't parse shows the options were read.
      ...Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'].map((name) => [
          `${name}.js`,
          `export const ${name} = 1`,
        ]),
      ),
    })

    const shared = ['a', 'b', 'c', 'd', 'e', 'f', 'k', 'm']
    expect(report.artifacts.map(({ url, realm, sourceType, discovery }: Json) => [url, realm, sourceType, discovery])).toEqual(
      ['a', 'app', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm'].map((name) => [
        `https://app.example/${name}.js`,
        name === 'app' ? 'window' : shared.includes(name) ? 'shared-worker' : 'dedicated-worker',
        'script',
        'reference',
      ]),
    )
  })
})

describe('`navigator.serviceWorker.register` with options it rejects (Principle 1)', () => {
  test('a primitive other than `null` or `undefined`, or a bad `type`, registers nothing', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': [
        "navigator.serviceWorker.register('/a.js', 'name')",
        "navigator.serviceWorker.register('/b.js', { type: null })",
        "navigator.serviceWorker.register('/c.js', null)",
      ].join('\n'),
      ...Object.fromEntries(['a', 'b', 'c'].map((name) => [`${name}.js`, `// ${name}`])),
    })

    expect(artifacts(report)).toEqual([
      ['https://app.example/a.js', 'window', 'sweep', 'assumed'],
      ['https://app.example/app.js', 'window', 'reference', 'reference'],
      ['https://app.example/b.js', 'window', 'sweep', 'assumed'],
      ['https://app.example/c.js', 'service-worker', 'reference', 'reference'],
    ])
  })
})

describe('`SharedWorker` exists only in the window (Principle 1)', () => {
  test('`new SharedWorker` inside a dedicated, shared, service or nested `data:` worker gives nothing', async () => {
    const nested = "new SharedWorker('/from-data.js')"
    const { report } = await scanBuild({
      'index.html': '<script src="app.js"></script>',
      'app.js': [
        "new Worker('/dedicated.js'); new SharedWorker('/shared.js')",
        "navigator.serviceWorker.register('/sw.js')",
        `new Worker("data:text/javascript,${encodeURIComponent(nested)}")`,
      ].join('\n'),
      'dedicated.js': "new SharedWorker('/from-dedicated.js'); new self.SharedWorker('/from-self.js')",
      'shared.js': "new SharedWorker('/from-shared.js')",
      'sw.js': "new SharedWorker('/from-sw.js')",
      ...Object.fromEntries(
        ['from-dedicated', 'from-self', 'from-shared', 'from-sw', 'from-data'].map((name) => [`${name}.js`, `// ${name}`]),
      ),
    })

    expect(report.artifacts.map(({ url, realm, discovery }: Json) => [url, realm, discovery])).toEqual([
      [`data:text/javascript,${encodeURIComponent(nested)}`, 'dedicated-worker', 'reference'],
      ['https://app.example/app.js', 'window', 'reference'],
      ['https://app.example/dedicated.js', 'dedicated-worker', 'reference'],
      ['https://app.example/from-data.js', 'window', 'sweep'],
      ['https://app.example/from-dedicated.js', 'window', 'sweep'],
      ['https://app.example/from-self.js', 'window', 'sweep'],
      ['https://app.example/from-shared.js', 'window', 'sweep'],
      ['https://app.example/from-sw.js', 'window', 'sweep'],
      ['https://app.example/shared.js', 'shared-worker', 'reference'],
      ['https://app.example/sw.js', 'service-worker', 'reference'],
    ])
    expect(report.completeness.limitations).toEqual([])
  })
})

describe('determinism (§15)', () => {
  test('two scans of the same build give byte-identical reports, except run', async () => {
    const files = {
      'index.html': '<script src="app.js"></script>',
      'app.js': "new Worker('/a.js', 'name'); new SharedWorker('/b.js', 'name'); new Worker('/c.js', { type: null })",
      'a.js': 'importScripts("x.js"); self.fetch = f',
      'b.js': 'self.fetch = g',
      'c.js': '// c',
      'x.js': '// x',
    }
    const first = await scanBuild(files)
    const second = await scanBuild(files)

    expect(JSON.stringify({ ...second.report, run: null })).toBe(JSON.stringify({ ...first.report, run: null }))
    expect(first.report.completeness.limitations.map(({ kind }: Json) => kind)).toEqual(['realm-uncertain'])
  })
})

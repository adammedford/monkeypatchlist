// The fixture-page check (tools/fixture-pages, spec §20 Fixture pages and Bars). Tests run the command over
// small fixture-page corpora, laid out as the validation corpus's `fixtures/` root: `expectations.json` and
// `static-sites/<page>/index.html`. The end-to-end tests scan the pages with the production `monkeypatchlist scan --json`;
// the rule tests swap in canned reports, so they can show restore steps the resolver can't produce yet.

import { existsSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { expectedToFail } from '../tools/fixture-pages/expected-to-fail.ts'
import { monkeypatchlistScanner } from '../tools/fixture-pages/main.ts'
import { corpusDir } from '../tools/paths.ts'
import { cannedScan, finding, fixturePages, ineffective, page, report, runCheck } from './support/fixture-pages.ts'

describe('end to end, through monkeypatchlist scan --json --surface all', () => {
  test('a page whose findings match its expectation passes', async () => {
    const root = fixturePages([
      page('control-replaceable-assign', 'control', 'window.length = 1;', { findings: ['Window.length|replace'] }),
    ])

    const run = await runCheck(root)

    expect(run.exitCode).toBe(0)
    expect(run.results).toEqual([{ page: 'control-replaceable-assign', status: 'pass', differences: [] }])
  })

  test('findings are compared by target and effect, and a failing page is listed with what differed', async () => {
    const root = fixturePages([
      page('restore-closure-capture', 'restore', 'window.fetch = function () {};', { findings: ['Window.fetch|wrap'] }),
      page('control-idl-setter', 'control', 'window.onerror = function () {};', { findings: [] }),
      page('control-new-global', 'control', 'window.alert = 1;', { findings: [] }),
    ])

    const run = await runCheck(root)

    expect(run.exitCode).toBe(1)
    expect(run.results).toEqual([
      {
        page: 'restore-closure-capture',
        status: 'fail',
        differences: ['missing finding: Window.fetch|wrap', 'unexpected finding: Window.fetch|replace'],
      },
      { page: 'control-idl-setter', status: 'pass', differences: [] },
      { page: 'control-new-global', status: 'fail', differences: ['unexpected finding: Window.alert|replace'] },
    ])
    expect(run.stdout).toContain('FAIL  restore-closure-capture\n')
    expect(run.stdout).toContain('missing finding: Window.fetch|wrap\n')
    expect(run.stdout).toContain('fixture-pages: 1 of 3 pages pass\n')
  })

  test('ineffective-write records are compared by target, reason and throws, end to end', async () => {
    const root = fixturePages([
      page('ineffective-non-writable-assign', 'ineffective', 'Math.PI = 3;', {
        findings: [],
        ineffective: ['Math.PI|non-writable|strict-only'],
      }),
      page('ineffective-non-configurable-define', 'ineffective', "Object.defineProperty(Math, 'PI', { value: 3 });", {
        findings: [],
        ineffective: ['Math.PI|non-configurable|strict-only'],
      }),
    ])

    const run = await runCheck(root)

    expect(run.results).toEqual([
      { page: 'ineffective-non-writable-assign', status: 'pass', differences: [] },
      {
        page: 'ineffective-non-configurable-define',
        status: 'fail',
        differences: [
          'missing ineffective write: Math.PI|non-configurable|strict-only',
          'unexpected ineffective write: Math.PI|non-configurable|always',
        ],
      },
    ])
  })

  test('a restore the scan doesn’t prove fails twice: no restore step, and the restore gives an occurrence', async () => {
    // The corpus marks each page's restore write with /*R{*/ … /*}R*/.
    const code = [
      'var o = XMLHttpRequest.prototype.open;',
      'XMLHttpRequest.prototype.open = function () { return o.apply(this, arguments); };',
      // The reset makes the restore unproven: a second teardown writes `undefined`.
      'function teardown() { /*R{*/XMLHttpRequest.prototype.open = o;/*}R*/ o = undefined; }',
      'window.__corpusTeardown = teardown;',
    ].join('\n')
    const root = fixturePages([
      page('restore-local-capture', 'restore', code, {
        findings: ['XMLHttpRequest.prototype.open|wrap'],
        restores: ['XMLHttpRequest.prototype.open'],
      }),
    ])

    const run = await runCheck(root)

    // The install is a wrap; the unproven restore joins its finding as one more occurrence.
    expect(run.results[0]!.differences).toEqual([
      'missing restore: XMLHttpRequest.prototype.open',
      'restore gives an occurrence: XMLHttpRequest.prototype.open|wrap at https://app.corpus.test/#inline-1 4:28',
    ])
  })
})

describe('expected-to-fail markers', () => {
  const pages = () =>
    fixturePages([
      page('control-replaceable-assign', 'control', 'window.length = 1;', { findings: ['Window.length|replace'] }),
      page('control-declare-configurable-global', 'control', 'window.fetch = 1;', { findings: ['Window.fetch|wrap'] }),
    ])

  test('a marked page that fails is expected, and the check passes', async () => {
    const run = await runCheck(pages(), { expectedToFail: { 'control-declare-configurable-global': 'ticket 36' } })

    expect(run.exitCode).toBe(0)
    expect(run.results[1]).toEqual({
      page: 'control-declare-configurable-global',
      status: 'expected-fail',
      marker: 'ticket 36',
      differences: ['missing finding: Window.fetch|wrap', 'unexpected finding: Window.fetch|replace'],
    })
    expect(run.stdout).toContain('xfail  control-declare-configurable-global (ticket 36)\n')
    expect(run.stdout).toContain('fixture-pages: 1 of 2 pages pass, 1 expected to fail\n')
  })

  test('a marked page that passes fails the check, so the ticket that implements its feature removes the marker', async () => {
    const run = await runCheck(pages(), { expectedToFail: { 'control-replaceable-assign': 'ticket 35' } })

    expect(run.exitCode).toBe(1)
    expect(run.results[0]).toEqual({
      page: 'control-replaceable-assign',
      status: 'unexpected-pass',
      marker: 'ticket 35',
      differences: [],
    })
    expect(run.stdout).toContain('XPASS  control-replaceable-assign (ticket 35): remove its expected-to-fail marker\n')
  })

  test('a marker for a page the root doesn’t have is refused', async () => {
    const run = await runCheck(pages(), { expectedToFail: { 'restore-gone': 'ticket 44' } })

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('restore-gone')
  })
})

describe('the comparison rules, over canned reports', () => {
  test('ineffective-write records are compared by target, reason and the throws of every occurrence', async () => {
    const root = fixturePages([
      page('ineffective-non-writable-assign', 'ineffective', '', {
        findings: [],
        ineffective: ['Math.PI|non-writable|strict-only', 'Node.ELEMENT_NODE|non-writable|strict-only'],
      }),
      page('ineffective-non-configurable-define', 'ineffective', '', {
        findings: [],
        ineffective: ['Math.PI|non-configurable|always'],
      }),
      page('ineffective-lenient-setter-assign', 'ineffective', '', {
        findings: [],
        ineffective: ['document.fullscreen|lenient-setter|never'],
      }),
    ])
    const scan = cannedScan({
      'ineffective-non-writable-assign': report({
        ineffectiveWrites: [
          ineffective('Math.PI', 'non-writable', ['strict-only', 'strict-only']),
          ineffective('Node.ELEMENT_NODE', 'non-writable', ['strict-only']),
        ],
      }),
      // `throws` is compared on every row: `always` is not `strict-only`.
      'ineffective-non-configurable-define': report({
        ineffectiveWrites: [ineffective('Math.PI', 'non-configurable', ['always', 'strict-only'])],
      }),
      // An ineffective write under another reason, and one more record than expected.
      'ineffective-lenient-setter-assign': report({
        ineffectiveWrites: [
          ineffective('document.fullscreen', 'readonly', ['never']),
          ineffective('document.fullscreenEnabled', 'lenient-setter', ['never']),
        ],
      }),
    })

    const run = await runCheck(root, { scan })

    expect(run.results).toEqual([
      { page: 'ineffective-non-writable-assign', status: 'pass', differences: [] },
      {
        page: 'ineffective-non-configurable-define',
        status: 'fail',
        differences: ['unexpected ineffective write: Math.PI|non-configurable|strict-only'],
      },
      {
        page: 'ineffective-lenient-setter-assign',
        status: 'fail',
        differences: [
          'missing ineffective write: document.fullscreen|lenient-setter|never',
          'unexpected ineffective write: document.fullscreenEnabled|lenient-setter|never',
          'unexpected ineffective write: document.fullscreen|readonly|never',
        ],
      },
    ])
  })

  test('a proven restore is a restore step on its install’s finding, and no occurrence of its own', async () => {
    // Script 1's text is "\n" + the code + "\n": the install is [1, 17) at 2:0, the marked region [34, 63), and the
    // restore write in it [40, 56) at 3:21.
    const code = 'window.fetch = w;\nfunction t() { /*R{*/window.fetch = o;/*}R*/ }'
    const pages = [
      page('restore-proven', 'restore', code, { findings: ['Window.fetch|wrap'], restores: ['Window.fetch'] }),
      page('restore-unproven', 'restore', code, { findings: ['Window.fetch|wrap'], restores: ['Window.fetch'] }),
      page('control-no-restore', 'control', 'window.fetch = w;', { findings: ['Window.fetch|wrap'] }),
    ]
    const scan = cannedScan({
      'restore-proven': report({ findings: [finding('Window.fetch', 'wrap', [{ start: 1, end: 17, line: 2, column: 0, trace: ['binding', 'restore'] }])] }),
      // The restore write is one more occurrence of the install's finding, in a second artifact position.
      'restore-unproven': report({
        findings: [
          finding('Window.fetch', 'wrap', [
            { start: 1, end: 17, line: 2, column: 0 },
            { start: 40, end: 56, line: 3, column: 21 },
          ]),
        ],
      }),
      // A restore step where the page expects none.
      'control-no-restore': report({ findings: [finding('Window.fetch', 'wrap', [{ start: 1, end: 17, line: 2, column: 0, trace: ['restore'] }])] }),
    })

    const run = await runCheck(fixturePages(pages), { scan })

    expect(run.results).toEqual([
      { page: 'restore-proven', status: 'pass', differences: [] },
      {
        page: 'restore-unproven',
        status: 'fail',
        differences: [
          'missing restore: Window.fetch',
          'restore gives an occurrence: Window.fetch|wrap at https://app.corpus.test/#inline-1 3:21',
        ],
      },
      { page: 'control-no-restore', status: 'fail', differences: ['unexpected restore: Window.fetch'] },
    ])
  })
})

describe('the fixture-page root', () => {
  test('a build directory expectations.json doesn’t list is refused, so every page is scanned', async () => {
    const root = fixturePages([page('control-idl-setter', 'control', 'window.onerror = null;', { findings: [] })], {
      extraSites: ['control-unlisted'],
    })

    const run = await runCheck(root)

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('control-unlisted')
  })

  test('a page that expects a restore but marks no restore write is refused', async () => {
    const root = fixturePages([
      page('restore-unmarked', 'restore', 'window.fetch = w; window.fetch = o;', {
        findings: ['Window.fetch|wrap'],
        restores: ['Window.fetch'],
      }),
    ])

    const run = await runCheck(root)

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('restore-unmarked')
  })
})

describe('the validation corpus’s fixture pages', () => {
  const root = join(corpusDir, 'fixtures')

  // Skipped in a checkout that hasn't fetched the validation corpus (`npm run corpus:fetch`).
  test.skipIf(!existsSync(root))('every page is scanned with the production scanner, and every page passes or fails as its marker says', async () => {
    const expectations = JSON.parse(readFileSync(join(root, 'expectations.json'), 'utf8')) as { name: string }[]
    const scanned: string[] = []
    const scan = monkeypatchlistScanner(loadCatalog())

    const run = await runCheck(root, {
      expectedToFail,
      scan: async (dir) => {
        scanned.push(basename(dir))
        return scan(dir)
      },
    })

    expect(run.stderr).toBe('')
    expect(run.exitCode).toBe(0)
    expect(expectations).toHaveLength(34)
    expect(scanned).toEqual(expectations.map((p) => p.name))
    expect(run.results.map((r) => r.status)).not.toContain('fail')
  })
})

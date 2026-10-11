// The completeness aggregator (§13, §19 Failures are data), at its entry point. End-to-end behaviour through
// `monkeypatchlist scan --json` is in test/completeness-report.test.ts.

import { describe, expect, test } from 'vitest'
import { defaultBudget, limitationKinds, type LimitationKind } from '../src/packages/analysis/index.ts'
import { aggregate, type LimitationRecord } from '../src/packages/completeness/index.ts'

/** §13 Limitation kinds, row by row: each kind's fixed level, including kinds no ticket raises yet. */
const table: [LimitationKind, 'incomplete' | 'complete-with-limitations'][] = [
  ['parse-failure', 'incomplete'],
  ['unreadable', 'incomplete'],
  ['source-maps-unpaired', 'incomplete'],
  ['fetch-failed', 'incomplete'],
  ['sri-mismatch', 'incomplete'],
  ['remote-refused', 'complete-with-limitations'],
  ['offline-skipped', 'complete-with-limitations'],
  ['dynamic-code', 'complete-with-limitations'],
  ['unresolved-reference', 'complete-with-limitations'],
  ['realm-uncertain', 'complete-with-limitations'],
  ['unresolved-holder', 'complete-with-limitations'],
  ['unlinked-module-call', 'complete-with-limitations'],
  ['analysis-budget', 'complete-with-limitations'],
]

const artifact = {
  url: 'https://app.example/main.js',
  realm: 'window' as const,
  sourceType: 'script' as const,
  path: 'main.js',
  hash: 'sha256:1',
  discovery: 'reference' as const,
  sourceMap: { method: 'none' as const, path: null, status: 'none' as const },
  staleCandidates: 0,
  unreadMaps: { refused: 0, failed: 0, unreadable: 0 },
}

function record(kind: LimitationKind, detail = 'd'): LimitationRecord {
  return { kind, artifact: { url: artifact.url }, detail }
}

const noHtml = { nomodule: 0, inlineHandlers: 0 }

/** Aggregates `limitations` for a scan of one artifact that analyzed it, unless `input` says otherwise. */
function aggregated(limitations: LimitationRecord[], input: Partial<Parameters<typeof aggregate>[0]> = {}) {
  const crashGuard = { fired: false, stopped: [] }
  const swept = { excluded: [], nonJs: 0, otherFiles: 0 }
  return aggregate({
    artifacts: [artifact],
    limitations,
    html: noHtml,
    statistics: [],
    budget: defaultBudget,
    crashGuard,
    swept,
    findings: [],
    ...input,
  })
}

describe('the level (§13 Limitation kinds)', () => {
  test('the table has a row for every limitation kind in §13', () => {
    expect(table.map(([kind]) => kind)).toEqual([...limitationKinds])
  })

  test.each(table)('a %s record makes the scan %s', (kind, level) => {
    expect(aggregated([record(kind)]).level).toBe(level)
  })

  test('a scan with no records is complete, whatever HTML content it counted', () => {
    expect(aggregated([], { html: { nomodule: 2, inlineHandlers: 5 } }).level).toBe('complete')
  })

  test('a record of a kind outside §13 is an internal error, never a limitation', () => {
    const unknown = { ...record('dynamic-code'), kind: 'timeout' } as unknown as LimitationRecord

    expect(() => aggregated([unknown])).toThrow(/timeout/)
  })

  test.each([[[]], [[record('dynamic-code')]]])(
    'a crash guard that fired makes the scan incomplete, with no record of its own (records: %j)',
    (limitations) => {
      const completeness = aggregated(limitations, { crashGuard: { fired: true, stopped: [] } })

      expect(completeness.level).toBe('incomplete')
      expect(completeness.limitations).toHaveLength(limitations.length)
    },
  )

  test('the worst level among the records wins, in any order', () => {
    const limitations = [record('dynamic-code'), record('sri-mismatch'), record('offline-skipped')]

    expect(aggregated(limitations).level).toBe('incomplete')
    expect(aggregated(limitations.reverse()).level).toBe('incomplete')
  })
})

describe('limitation records (§13)', () => {
  const at = (start: number) => ({ start, end: start + 1, line: 1, column: start })
  const records: LimitationRecord[] = [
    { kind: 'dynamic-code', artifact: { url: 'https://app.example/main.js' }, location: at(40), detail: 'b' },
    { kind: 'unresolved-reference', artifact: { url: 'https://app.example/main.js' }, location: at(9), detail: 'x' },
    { kind: 'dynamic-code', artifact: { url: 'https://app.example/main.js' }, location: at(40), detail: 'a' },
    { kind: 'unreadable', artifact: { url: 'https://app.example/a.js', path: 'a.js' }, detail: 'ENOENT' },
    { kind: 'unresolved-reference', artifact: { url: 'https://app.example/main.js' }, detail: 'no location' },
    { kind: 'source-maps-unpaired', artifact: { path: '../maps' }, detail: 'pairs with nothing' },
    // Two records that differ only in what is known of their artifact.
    { kind: 'unreadable', artifact: { path: 'https://cdn.example/x.js' }, detail: 'd' },
    { kind: 'unreadable', artifact: { url: 'https://cdn.example/x.js' }, detail: 'd' },
    { kind: 'dynamic-code', artifact: { url: 'https://app.example/main.js' }, location: at(9), detail: 'x' },
  ]
  const sorted = (limitations: LimitationRecord[]) =>
    aggregated(limitations).limitations.map(({ kind, artifact, location, detail }) => [
      artifact.url ?? artifact.path,
      location?.start ?? null,
      kind,
      detail,
    ])

  test('sort by artifact URL (or path), then location, kind and detail', () => {
    expect(sorted(records).slice(0, 5)).toEqual([
      ['../maps', null, 'source-maps-unpaired', 'pairs with nothing'],
      ['https://app.example/a.js', null, 'unreadable', 'ENOENT'],
      ['https://app.example/main.js', null, 'unresolved-reference', 'no location'],
      ['https://app.example/main.js', 9, 'dynamic-code', 'x'],
      ['https://app.example/main.js', 9, 'unresolved-reference', 'x'],
    ])
  })

  test('are in the same order whatever order the modules returned them in', () => {
    const expected = aggregated(records).limitations

    for (let shift = 1; shift < records.length; shift++) {
      const rotated = [...records.slice(shift), ...records.slice(0, shift)]
      expect(aggregated(rotated).limitations).toEqual(expected)
      expect(aggregated(rotated.reverse()).limitations).toEqual(expected)
    }
  })
})

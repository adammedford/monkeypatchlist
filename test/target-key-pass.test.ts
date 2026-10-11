// The target-key pass and rekeyed attribution (§11 Baseline states and matching, step 3; ADR 0007). Tests write a
// baseline with `monkeypatchlist baseline init` over one fixture build, then scan another with `monkeypatchlist scan --json -` in
// the same working directory, and assert on report fields.

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, test } from 'vitest'
import { corpusDir } from '../tools/paths.ts'
import { assertValidReport, defaultMap, fixtureBuild, runCli, workingDir } from './support/fixture-build.ts'
import { mappings, type Segment } from './support/source-map.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/**
 * One line of `main.js`: its code, and the package it comes from (`node_modules/<package>/index.js` in the map), or a
 * `file://` source, or null for a line the map leaves unmapped, whose writes key `unknown`.
 */
type Line = [code: string, pkg: string | null]

/**
 * A build whose `main.js` holds `lines`, with a sidecar map naming each mapped line's package file, whose content is
 * that line: a bundler that copied each package's module unchanged.
 */
function build(lines: readonly Line[]): string {
  const packages = [...new Set(lines.flatMap(([, pkg]) => (pkg === null ? [] : [pkg])))]
  const segments = lines.map(([code, pkg]): Segment[] => {
    if (pkg === null) return []
    const source = packages.indexOf(pkg)
    return [...code.matchAll(/[\w$]+|[^\s\w$]/g)].map((match) => [match.index, source, 0, match.index])
  })
  const map = {
    version: 3,
    sources: packages.map((pkg) => (pkg.startsWith('file://') ? pkg : `webpack://app/./node_modules/${pkg}/index.js`)),
    sourcesContent: packages.map((pkg) => lines.find(([, each]) => each === pkg)![0]),
    names: [],
    mappings: mappings(segments),
  }
  return fixtureBuild({
    'index.html': '<script src="main.js"></script>',
    'main.js': lines.map(([code]) => code).join('\n'),
    'main.js.map': JSON.stringify(map),
  })
}

/** Runs `monkeypatchlist baseline <command> <build>` in `cwd`, and fails unless it exits 0. */
async function baseline(command: 'init' | 'update', cwd: string, lines: readonly Line[]): Promise<void> {
  const run = await runCli(['baseline', command, build(lines), '--map', defaultMap, '--surface', 'all'], { cwd })
  if (run.exitCode !== 0) throw new Error(`baseline ${command} exited ${run.exitCode}:\n${run.stderr}`)
}

/** Runs `monkeypatchlist scan <build> --baseline monkeypatchlist.baseline.json --json - <args…>` in `cwd`. */
async function scan(cwd: string, lines: readonly Line[], args: string[] = []) {
  const run = await runCli(
    ['scan', build(lines), '--map', defaultMap, '--surface', 'all', '--baseline', 'monkeypatchlist.baseline.json', '--json', '-', ...args],
    { cwd },
  )
  const report: Json = JSON.parse(run.stdout)
  assertValidReport(report)
  return { exitCode: run.exitCode, report }
}

/** The fingerprints of the baseline file in `cwd`. */
const baselineFingerprints = (cwd: string): string[] =>
  JSON.parse(readFileSync(join(cwd, 'monkeypatchlist.baseline.json'), 'utf8')).entries.map((entry: Json) => entry.fingerprint)

/** Each finding as `[fingerprint, baselineState, matchedBy, changedReasons, notes]`. */
const states = (report: Json) =>
  report.findings.map((finding: Json) => [
    finding.fingerprint,
    finding.baselineState,
    finding.matchedBy,
    finding.changedReasons,
    finding.notes,
  ])

const send = 'XMLHttpRequest.prototype.send = s'
const key = (attribution: string) => `window|XMLHttpRequest.prototype.send|replace|${attribution}`

describe('known key ↔ known key (§11 step 3)', () => {
  test('a 1:1 pair is changed (attribution), matched by target key', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [[send, 'a']])

    const { report } = await scan(cwd, [[send, 'b']])

    expect(states(report)).toEqual([
      [key('pkg:b'), 'changed', 'target-key', [{ reason: 'attribution', before: 'pkg:a', after: 'pkg:b' }], []],
    ])
    expect(report.summary).toMatchObject({ added: 0, changed: 1, existing: 0, removed: 0 })
  })
})

describe('pairs across `unknown` (§11 step 3)', () => {
  test('a nomaps scan against a maps baseline is existing with a rekeyed note, never changed', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [[send, 'a']])

    const { report } = await scan(cwd, [[send, null]])

    expect(states(report)).toEqual([
      [key('unknown'), 'existing', 'target-key', [], [{ kind: 'rekeyed', before: ['pkg:a'], after: 'unknown' }]],
    ])
    expect(report.summary).toMatchObject({ added: 0, changed: 0, existing: 1, removed: 0 })
  })

  test('a maps scan against a nomaps baseline mirrors it', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [[send, null]])

    const { report } = await scan(cwd, [[send, 'a']])

    expect(states(report)).toEqual([
      [key('pkg:a'), 'existing', 'target-key', [], [{ kind: 'rekeyed', before: ['unknown'], after: 'pkg:a' }]],
    ])
  })

  test('`unknown` pairs N:1 with every known entry left over, and update collapses them into its key', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [
      [send, 'a'],
      [send, 'b'],
    ])

    const { report } = await scan(cwd, [[send, null]])

    expect(states(report)).toEqual([
      [key('unknown'), 'existing', 'target-key', [], [{ kind: 'rekeyed', before: ['pkg:a', 'pkg:b'], after: 'unknown' }]],
    ])
    await baseline('update', cwd, [[send, null]])
    expect(baselineFingerprints(cwd)).toEqual([key('unknown')])
  })
})

describe('ambiguous groups (§11 step 3)', () => {
  test('a 2:2 known group stays added and removed, each with a shared-target-key note', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [
      [send, 'a'],
      [send, 'b'],
    ])

    const { report } = await scan(cwd, [
      [send, 'c'],
      [send, 'd'],
    ])

    const scanned = { kind: 'shared-target-key', fingerprints: [key('pkg:c'), key('pkg:d')] }
    const baselined = { kind: 'shared-target-key', fingerprints: [key('pkg:a'), key('pkg:b')] }
    expect(states(report)).toEqual([
      [key('pkg:a'), 'removed', null, [], [scanned]],
      [key('pkg:b'), 'removed', null, [], [scanned]],
      [key('pkg:c'), 'added', null, [], [baselined]],
      [key('pkg:d'), 'added', null, [], [baselined]],
    ])
  })

  test('a known 1:2 group beside an `unknown` entry: `unknown` takes both findings, and the known entry is removed', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [
      [send, 'a'],
      [send, null],
    ])

    const { report } = await scan(cwd, [
      [send, 'b'],
      [send, 'c'],
    ])

    const rekeyed = (after: string) => [{ kind: 'rekeyed', before: ['unknown'], after }]
    expect(states(report)).toEqual([
      [key('pkg:a'), 'removed', null, [], [{ kind: 'shared-target-key', fingerprints: [key('pkg:b'), key('pkg:c')] }]],
      [key('pkg:b'), 'existing', 'target-key', [], rekeyed('pkg:b')],
      [key('pkg:c'), 'existing', 'target-key', [], rekeyed('pkg:c')],
    ])
  })

  test('a lone added finding with nothing on the other side has no note', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [['window.fetch = f', 'a']])

    const { report } = await scan(cwd, [[send, 'b']])

    expect(states(report)).toEqual([
      ['window|Window.fetch|replace|pkg:a', 'removed', null, [], []],
      [key('pkg:b'), 'added', null, [], []],
    ])
  })
})

describe('known keys and `unknown` in one group', () => {
  test('`pkg:b` pairs with `pkg:a` (attribution) and with the `unknown` entry (rekeyed); update collapses both', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [
      [send, 'a'],
      [send, null],
    ])

    const { report } = await scan(cwd, [[send, 'b']])

    expect(states(report)).toEqual([
      [
        key('pkg:b'),
        'changed',
        'target-key',
        [{ reason: 'attribution', before: 'pkg:a', after: 'pkg:b' }],
        [{ kind: 'rekeyed', before: ['unknown'], after: 'pkg:b' }],
      ],
    ])
    expect(report.summary).toMatchObject({ added: 0, changed: 1, existing: 0, removed: 0 })
    await baseline('update', cwd, [[send, 'b']])
    expect(baselineFingerprints(cwd)).toEqual([key('pkg:b')])
  })
})

describe('`unknown` after an exact match', () => {
  test('a leftover known entry pairs with the exactly matched `unknown` finding, and update drops it', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [
      [send, 'a'],
      [send, null],
    ])

    const { report } = await scan(cwd, [[send, null]])

    expect(states(report)).toEqual([
      [key('unknown'), 'existing', 'fingerprint', [], [{ kind: 'rekeyed', before: ['pkg:a'], after: 'unknown' }]],
    ])
    await baseline('update', cwd, [[send, null]])
    expect(baselineFingerprints(cwd)).toEqual([key('unknown')])
  })

  test('the mirror: a new known finding pairs with the exactly matched `unknown` entry, and update writes it', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [[send, null]])

    const { report } = await scan(cwd, [
      [send, 'a'],
      [send, null],
    ])

    expect(states(report)).toEqual([
      [key('pkg:a'), 'existing', 'target-key', [], [{ kind: 'rekeyed', before: ['unknown'], after: 'pkg:a' }]],
      [key('unknown'), 'existing', 'fingerprint', [], []],
    ])
    await baseline('update', cwd, [
      [send, 'a'],
      [send, null],
    ])
    expect(baselineFingerprints(cwd)).toEqual([key('pkg:a'), key('unknown')])
  })
})

const replaceFetch = 'window.fetch = f'
const wrapFetch = 'const o = window.fetch; window.fetch = function(){ return o.apply(this, arguments) }'
const fetchKey = (effect: string, attribution: string) => `window|Window.fetch|${effect}|${attribution}`

describe('`unknown` after the effect pass', () => {
  test('an effect-paired `unknown` finding rejoins and pairs with the leftover known entry; update collapses both', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [
      [replaceFetch, null],
      [wrapFetch, 'a'],
    ])

    const { report } = await scan(cwd, [[wrapFetch, null]])

    expect(states(report)).toEqual([
      [
        fetchKey('wrap', 'unknown'),
        'changed',
        'effect',
        [{ reason: 'effect', before: 'replace', after: 'wrap' }],
        [{ kind: 'rekeyed', before: ['pkg:a'], after: 'unknown' }],
      ],
    ])
    expect(report.summary).toMatchObject({ added: 0, changed: 1, existing: 0, removed: 0 })
    await baseline('update', cwd, [[wrapFetch, null]])
    expect(baselineFingerprints(cwd)).toEqual([fetchKey('wrap', 'unknown')])
  })

  test('the mirror: an effect-paired `unknown` entry rejoins and pairs with a new known finding; nothing is added', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [[replaceFetch, null]])

    const { exitCode, report } = await scan(
      cwd,
      [
        [wrapFetch, null],
        [replaceFetch, 'a'],
      ],
      ['--fail-on', 'added'],
    )

    expect(states(report)).toEqual([
      [fetchKey('replace', 'pkg:a'), 'existing', 'target-key', [], [{ kind: 'rekeyed', before: ['unknown'], after: 'pkg:a' }]],
      [fetchKey('wrap', 'unknown'), 'changed', 'effect', [{ reason: 'effect', before: 'replace', after: 'wrap' }], []],
    ])
    expect(report.summary).toMatchObject({ added: 0, removed: 0 })
    expect(exitCode).toBe(0)
  })

  test('a `locks` difference against the rejoined known side adds one `locks` reason', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [["Object.defineProperty(window, 'fetch', { value: f })", null]])

    const { report } = await scan(cwd, [
      [wrapFetch, null],
      ["Object.defineProperty(window, 'fetch', { value: f, configurable: false })", 'a'],
    ])

    const finding = report.findings.find((each: Json) => each.fingerprint === fetchKey('replace', 'pkg:a'))
    expect(finding.baselineState).toBe('changed')
    expect(finding.changedReasons).toEqual([{ reason: 'locks', before: false, after: true }])
    expect(finding.notes).toEqual([{ kind: 'rekeyed', before: ['unknown'], after: 'pkg:a' }])
  })
})

const lockedSend = "Object.defineProperty(XMLHttpRequest.prototype, 'send', { value: s, configurable: false })"
const unlockedSend = "Object.defineProperty(XMLHttpRequest.prototype, 'send', { value: s })"

describe('`locks` across a target-key pair (§11 `changed`)', () => {
  test('`unknown` pairing N:1 is changed (locks) once per differing entry, keeps its note, and trips the gate', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [
      [lockedSend, 'a'],
      [unlockedSend, 'b'],
    ])

    const { exitCode, report } = await scan(cwd, [[lockedSend, null]], ['--fail-on', 'changed'])

    expect(states(report)).toEqual([
      [
        key('unknown'),
        'changed',
        'target-key',
        [{ reason: 'locks', before: false, after: true }],
        [{ kind: 'rekeyed', before: ['pkg:a', 'pkg:b'], after: 'unknown' }],
      ],
    ])
    expect(report.gate.result).toBe('fail')
    expect(exitCode).toBe(1)
  })

  test('a known ↔ known pair that also differs in locks records attribution, then locks', async () => {
    const cwd = workingDir()
    await baseline('init', cwd, [[unlockedSend, 'a']])

    const { report } = await scan(cwd, [[lockedSend, 'b']])

    expect(states(report)[0][3]).toEqual([
      { reason: 'attribution', before: 'pkg:a', after: 'pkg:b' },
      { reason: 'locks', before: false, after: true },
    ])
  })
})

describe('`--fail-on changed` trips on each reason (§11 The gate)', () => {
  test.each([
    ['attribution', [[send, 'a']], [[send, 'b']]],
    ['effect', [['const o = XMLHttpRequest.prototype.send; XMLHttpRequest.prototype.send = function(){ return o.apply(this, arguments) }', 'a']], [[send, 'a']]],
    ['locks', [[unlockedSend, 'a']], [[lockedSend, 'a']]],
  ] as [string, Line[], Line[]][])('%s', async (reason, before, after) => {
    const cwd = workingDir()
    await baseline('init', cwd, before)

    const { exitCode, report } = await scan(cwd, after, ['--fail-on', 'changed'])

    expect(report.findings.map((finding: Json) => finding.changedReasons.map((each: Json) => each.reason))).toEqual([[reason]])
    expect(report.findings[0].policy).toEqual({ outcome: 'fail', by: 'fail-on:changed' })
    expect(report.gate.result).toBe('fail')
    expect(exitCode).toBe(1)
  })
})

describe('a first-party write that moves `unknown` → `app:` (§10 Source schemes)', () => {
  test('is existing with a rekeyed note against a baseline taken before the root appeared', async () => {
    const own = 'file:///home/ci/work/app/src/polyfills.ts'
    const cwd = workingDir()
    await baseline('init', cwd, [['window.fetch = f', own]])

    // A dependency added later makes the root `/home/ci/work/app/` appear.
    const { report } = await scan(cwd, [
      ['window.fetch = f', own],
      ['dep()', 'file:///home/ci/work/app/node_modules/dep/index.js'],
    ])

    expect(states(report)).toEqual([
      [
        'window|Window.fetch|replace|app:src/polyfills.ts',
        'existing',
        'target-key',
        [],
        [{ kind: 'rekeyed', before: ['unknown'], after: 'app:src/polyfills.ts' }],
      ],
    ])
  })
})

// The validation corpus's Sentry builds. The builds are git-ignored, so a checkout without them skips these.
const dist = resolve(corpusDir, 'dist')
const bundlers = ['esbuild', 'rollup', 'vite', 'webpack']

// Each case scans two corpus builds, which takes seconds.
describe.skipIf(!existsSync(dist))('the corpus Sentry builds (§11 step 3; §21 identity invariance)', { timeout: 60_000 }, () => {
  /** Writes a baseline of corpus build `from` in a fresh working directory, then scans corpus build `to` against it. */
  async function diff(from: string, to: string) {
    const cwd = workingDir()
    const map = ['--map', 'https://app.corpus.test/=.']
    const init = await runCli(['baseline', 'init', join(dist, from), ...map], { cwd })
    expect(init.exitCode).toBe(0)
    const run = await runCli(['scan', join(dist, to), ...map, '--baseline', 'monkeypatchlist.baseline.json', '--json', '-'], { cwd })
    const report: Json = JSON.parse(run.stdout)
    assertValidReport(report)
    return { cwd, report, update: () => runCli(['baseline', 'update', join(dist, to), ...map], { cwd }) }
  }

  test.each(bundlers)('%s: Sentry 10 → 11 changes nothing but the alias-directory rekeys', async (bundler) => {
    const { report } = await diff(`${bundler}/sentry-10/maps`, `${bundler}/sentry-11/maps`)

    const moved = report.findings.filter((finding: Json) => finding.baselineState !== 'existing')
    expect(moved.length).toBeGreaterThan(0)
    for (const finding of moved) {
      expect([finding.fingerprint, finding.baselineState, finding.changedReasons]).toEqual([
        finding.fingerprint,
        'changed',
        [{ reason: 'attribution', before: 'pkg:sentry-browser-10', after: 'pkg:@sentry/browser' }],
      ])
    }
  })

  test.each(bundlers)(
    '%s: Sentry 7 → 10 is changed (attribution) for 1:1 moves, shared-target-key for 2:2 groups, and otherwise only new or gone targets',
    async (bundler) => {
      const { report } = await diff(`${bundler}/sentry-7/maps`, `${bundler}/sentry-10/maps`)

      /** A target key's `realm|target`, without its effect. */
      const targetOf = (targetKey: string) => targetKey.split('|').slice(0, 2).join('|')
      const byTarget = (state: string) =>
        new Set(report.findings.filter((each: Json) => each.baselineState === state).map((each: Json) => targetOf(each.targetKey)))
      const byTargetKey = (state: string) =>
        new Set(report.findings.filter((each: Json) => each.baselineState === state).map((each: Json) => each.targetKey))
      const [added, removed] = [byTargetKey('added'), byTargetKey('removed')]
      const [addedTargets, removedTargets] = [byTarget('added'), byTarget('removed')]
      for (const finding of report.findings) {
        const { baselineState: state, changedReasons, notes } = finding
        if (state === 'changed') expect(changedReasons.map(({ reason }: Json) => reason)).toEqual(['attribution'])
        if (state !== 'added' && state !== 'removed') continue
        // An `added` or `removed` finding either shares its target key with the other side (and says so), or its
        // target is new or gone: no finding keeps its target and changes only its effect.
        const [otherSide, otherTargets] = state === 'added' ? [removed, removedTargets] : [added, addedTargets]
        // Under esbuild, Sentry 7's escaped `unknown` entry pairs with every XHR `send` finding, so the
        // known entry left `removed` shares its target key with `existing` findings.
        const pairedByRekey = bundler === 'esbuild' && state === 'removed' && byTargetKey('existing').has(finding.targetKey)
        const shared = otherSide.has(finding.targetKey) || pairedByRekey
        expect([finding.targetKey, notes.map(({ kind }: Json) => kind)]).toEqual([
          finding.targetKey,
          shared ? ['shared-target-key'] : [],
        ])
        if (!shared) expect([finding.targetKey, otherTargets.has(targetOf(finding.targetKey))]).toEqual([finding.targetKey, false])
      }
      // XHR `open` moved 1:1 between packages as a wrap on both sides. Under esbuild, Sentry 7's side is escaped
      // (`unknown`), so the pair is `existing` with a `rekeyed` note.
      const open = report.findings.filter((each: Json) => targetOf(each.targetKey) === 'window|XMLHttpRequest.prototype.open')
      expect(
        open.map((each: Json) => [
          each.effect,
          each.baselineState,
          each.changedReasons.map(({ reason }: Json) => reason),
          each.notes.map(({ kind }: Json) => kind),
        ]),
      ).toEqual([bundler === 'esbuild' ? ['wrap', 'existing', [], ['rekeyed']] : ['wrap', 'changed', ['attribution'], []]])
      const send = report.findings.filter((each: Json) => targetOf(each.targetKey) === 'window|XMLHttpRequest.prototype.send')
      const sendStates = send.map((each: Json) => [each.effect, each.baselineState, each.notes.map(({ kind }: Json) => kind)]).sort()
      if (bundler === 'esbuild') {
        // Sentry 7's esbuild `node_modules/@sentry/src/…` source is escaped, so its entries are the `unknown` one
        // and `app:src/integrations/trycatch.ts`. The `unknown` entry pairs with both known findings (`rekeyed`), and the
        // known entry, 1:2 with the known findings, is ambiguous: `removed`, sharing the target key (§11 step 3).
        expect(sendStates).toEqual([
          ['wrap', 'existing', ['rekeyed']],
          ['wrap', 'existing', ['rekeyed']],
          ['wrap', 'removed', ['shared-target-key']],
        ])
      } else {
        // The XHR `send` group is 2:2: two known entries and two known findings, all `wrap`.
        expect(sendStates).toEqual([
          ['wrap', 'added', ['shared-target-key']],
          ['wrap', 'added', ['shared-target-key']],
          ['wrap', 'removed', ['shared-target-key']],
          ['wrap', 'removed', ['shared-target-key']],
        ])
      }
      expect(report.summary.changed).toBeGreaterThan(0)
    },
  )

  test.each([
    ['maps', 'nomaps'],
    ['nomaps', 'maps'],
  ])('esbuild Sentry 7 %s → %s: nothing added, removed or changed, and update writes the scan’s keys', async (from, to) => {
    const { cwd, report, update } = await diff(`esbuild/sentry-7/${from}`, `esbuild/sentry-7/${to}`)

    expect(report.summary).toMatchObject({ added: 0, changed: 0, removed: 0 })
    const rekeyed = report.findings.filter((each: Json) => each.notes.some(({ kind }: Json) => kind === 'rekeyed'))
    expect(rekeyed.length).toBeGreaterThan(0)
    expect(rekeyed.every((each: Json) => each.baselineState === 'existing')).toBe(true)
    expect((await update()).exitCode).toBe(0)
    expect(baselineFingerprints(cwd)).toEqual(report.findings.map((each: Json) => each.fingerprint))
  })
})

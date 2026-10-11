// Every cap hit is counted (§18 Context policy): `candidateRuns`, `testReads`, `throwDepth`, `flagDepth`,
// `aliasDepth`, `heapDepth` (the heap's write-back depth limit) and `nesting` count their hits in `statistics.caps`, as
// the other caps do. A `candidateRuns` cut of a write's candidate sites raises `analysis-budget` naming the artifact when
// they carry the global object, a native holder or a native member (Principle 5), and is otherwise only counted. Every
// scenario lowers the cap through the injected budget and goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { defaultBudget, type Budget } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join('\n')
const withCaps = (caps: Partial<Budget['caps']>): Budget => ({ ...defaultBudget, caps: { ...defaultBudget.caps, ...caps } })
const scan = async (code: string, caps: Partial<Budget['caps']> = {}): Promise<Report> =>
  (await scanBuild(classic(code), [], { deps: { budget: withCaps(caps) } })).report
const fingerprints = (report: Report): string[] => report.findings.map((finding: Report) => finding.fingerprint)
const kinds = (report: Report): string[] => report.completeness.limitations.map((record: Report) => record.kind)
const hits = (report: Report): Record<string, number> => report.completeness.counters.statistics.caps

describe('a candidateRuns cut (Principle 5)', () => {
  // One run can't decide the key's two alternatives, so the write's candidate sites are cut.
  const nativeWrite = lines("var k = Math.random() > 0.5 ? 'fetch' : 'open'", 'window[k] = function () {}', 'history.pushState = w')

  test('of a write whose candidate sites are native targets raises one analysis-budget naming the artifact, and keeps the other work', async () => {
    const shipped = await scan(nativeWrite)
    expect(fingerprints(shipped)).toContain('window|Window.fetch|replace|unknown')
    expect(shipped.completeness.level).toBe('complete')
    expect(hits(shipped).candidateRuns).toBeUndefined()

    const cut = await scan(nativeWrite, { candidateRuns: 1 })
    expect(fingerprints(cut)).toEqual(['window|history.pushState|replace|unknown'])
    expect(cut.completeness.level).toBe('complete-with-limitations')
    expect(kinds(cut)).toEqual(['analysis-budget'])
    const [record] = cut.completeness.limitations
    expect(record.artifact.url).toMatch(/main\.js$/)
    expect(record.location.line).toBe(2)
    expect(hits(cut).candidateRuns).toBe(1)
  })

  test('of a write on objects of the code’s own is only counted', async () => {
    const code = lines("var k = Math.random() > 0.5 ? 'fetch' : 'open'", 'var o = {}', 'o[k] = function () {}')
    const cut = await scan(code, { candidateRuns: 1 })
    expect(cut.completeness.level).toBe('complete')
    expect(kinds(cut)).toEqual([])
    expect(hits(cut).candidateRuns).toBe(1)
  })
})

describe('every other cap counts its hits', () => {
  test('testReads: a guard test with more reads than the cap is counted, once for the test', async () => {
    const code = lines('if (cfg.x + cfg.y + window.fetch) window.fetch = w')
    expect(hits(await scan(code)).testReads).toBeUndefined()
    expect(hits(await scan(code, { testReads: 1 })).testReads).toBe(1)
  })

  test('throwDepth: a call too deep to follow when judging a try is counted, once for the function', async () => {
    const code = lines(
      'function a() { b() }',
      'function b() { return 1 }',
      'try { a() } catch (e) { window.fetch = w }',
    )
    expect(hits(await scan(code)).throwDepth).toBeUndefined()
    expect(hits(await scan(code, { throwDepth: 1 })).throwDepth).toBe(1)
  })

  test('flagDepth: a once-flag assignment too deep to follow is counted', async () => {
    const code = lines(
      'var done = false',
      'function set() { done = true }',
      'function mark() { set() }',
      'function install() { if (done) return; mark(); window.fetch = w }',
      'install()',
    )
    expect(hits(await scan(code)).flagDepth).toBeUndefined()
    expect(hits(await scan(code, { flagDepth: 1 })).flagDepth).toBeGreaterThan(0)
  })

  test('aliasDepth: an alias chain too long to follow to its root is counted', async () => {
    const code = lines(
      'function f(o) { var a = o; var b = a; var c = b; var orig = c.fetch; c.fetch = function () { return orig() } }',
      'f(thing())',
    )
    expect(hits(await scan(code)).aliasDepth).toBeUndefined()
    expect(hits(await scan(code, { aliasDepth: 1 })).aliasDepth).toBeGreaterThan(0)
  })

  test('heapDepth: a write-back followed through heap fields deeper than the cap is counted', async () => {
    const code = lines('const s = {}', 'const t = {}', 't.x = window.fetch', 's.orig = t.x', 'window.fetch = s.orig')
    expect(hits(await scan(code)).heapDepth).toBeUndefined()
    expect(hits(await scan(code, { heapDepth: 1 })).heapDepth).toBe(1)
  })

  test('nesting: a constant read too deep within others is counted', async () => {
    const code = lines("const a1 = 'fe'", "const a2 = a1 + 't'", "const a3 = a2 + 'c'", "const a4 = a3 + 'h'", 'window[a4] = w')
    const shipped = await scan(code)
    expect(hits(shipped).nesting).toBeUndefined()
    const lowered = await scan(code, { nesting: 2 })
    expect(hits(lowered).nesting).toBeGreaterThan(0)
    expect(fingerprints(lowered)).toEqual(fingerprints(shipped))
  })
})

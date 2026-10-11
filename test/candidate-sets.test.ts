// Candidate sets (§5 Candidate sets, §9 Target confidence, ADR 0019): a write whose holder or member comes from a
// branch that neither constant folding nor the catalog can settle has a candidate set. Up to 4 candidates give one
// finding each, with `holder-alternatives` or `member-alternatives`; above 4 the site is partially resolved. Every
// scenario goes through `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** The report's findings, as `target|effect`, sorted. */
const found = (report: Report): string[] =>
  report.findings.map((finding: Report) => `${finding.target.name}|${finding.effect}`).sort()

/** The report's ineffective-write records, as `target|reason`, sorted. */
const records = (report: Report): string[] =>
  report.ineffectiveWrites.map((record: Report) => `${record.target.name}|${record.reason}`).sort()

/** The report's limitations of one kind. */
const limitations = (report: Report, kind: string): Report[] =>
  report.completeness.limitations.filter((limitation: Report) => limitation.kind === kind)

/** A finding's target-confidence reasons. */
const targetReasons = (finding: Report): string[] => finding.confidence.target.reasons

/** The target `confidence-reason` steps of a finding's first occurrence. */
const reasonSteps = (finding: Report): Report[] =>
  finding.occurrences[0].trace.filter((step: Report) => step.kind === 'confidence-reason' && step.dimension === 'target')

describe.each(resolvers)('candidate sets, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>, args: string[] = []) => scanBuild(files, args, { deps: { resolver } })

  test('XMLHttpRequest.prototype[flag ? "open" : "send"] = w gives two findings, each with member-alternatives', async () => {
    const { report } = await scan(classic('XMLHttpRequest.prototype[flag ? "open" : "send"] = w'))

    expect(found(report)).toEqual(['XMLHttpRequest.prototype.open|replace', 'XMLHttpRequest.prototype.send|replace'])
    for (const finding of report.findings) {
      expect(finding.confidence.target).toEqual({ level: 'medium', reasons: ['member-alternatives'] })
      // The trace records the branch and the other candidates.
      const [step] = reasonSteps(finding)
      expect(step).toMatchObject({ reason: 'member-alternatives', level: 'medium' })
      expect(step.sites).toEqual([expect.objectContaining({ line: 1, column: 25 })])
      const other = finding.target.name.endsWith('open') ? 'XMLHttpRequest.prototype.send' : 'XMLHttpRequest.prototype.open'
      expect(step.alternatives).toEqual([other])
    }
    expect(report.findings[0].fingerprint).not.toBe(report.findings[1].fingerprint)
  })

  test('a two-holder branch gives two findings with holder-alternatives: (c ? window : history).pushState = w', async () => {
    const { report } = await scan(classic('(c ? XMLHttpRequest.prototype : WebSocket.prototype).send = w'))

    expect(found(report)).toEqual(['WebSocket.prototype.send|replace', 'XMLHttpRequest.prototype.send|replace'])
    for (const finding of report.findings) {
      expect(finding.confidence.target).toEqual({ level: 'medium', reasons: ['holder-alternatives'] })
      const [step] = reasonSteps(finding)
      expect(step).toMatchObject({ reason: 'holder-alternatives', sites: [expect.objectContaining({ line: 1, column: 1 })] })
      expect(step.alternatives).toHaveLength(1)
    }
  })

  test('a heap-read constant never decides a test, so both members are candidates', async () => {
    const { report } = await scan(classic("const c = { on: true }; XMLHttpRequest.prototype[c.on ? 'open' : 'send'] = w"))

    expect(found(report)).toEqual(['XMLHttpRequest.prototype.open|replace', 'XMLHttpRequest.prototype.send|replace'])
    for (const finding of report.findings) expect(targetReasons(finding)).toEqual(['member-alternatives'])
  })

  test('an ineffective candidate is an ineffective write: Math[c ? "PI" : "max"] = w', async () => {
    const { report } = await scan(classic('Math[c ? "PI" : "max"] = w'), ['--surface', 'all'])

    expect(found(report)).toEqual(['Math.max|replace'])
    expect(records(report)).toEqual(['Math.PI|non-writable'])
    expect(targetReasons(report.findings[0])).toEqual(['member-alternatives'])
  })

  test('holder and member both undecided give the cross product, up to 4 distinct targets', async () => {
    const { report } = await scan(
      classic('(c ? XMLHttpRequest.prototype : WebSocket.prototype)[d ? "send" : "close"] = w'),
      ['--surface', 'all'],
    )

    expect(found(report)).toEqual([
      'WebSocket.prototype.close|replace',
      'WebSocket.prototype.send|replace',
      'XMLHttpRequest.prototype.close|add',
      'XMLHttpRequest.prototype.send|replace',
    ])
    for (const finding of report.findings) {
      expect(targetReasons(finding)).toEqual(['holder-alternatives', 'member-alternatives'])
      for (const step of reasonSteps(finding)) expect(step.alternatives).toHaveLength(3)
    }
  })

  test('3 holders x 2 members gives no findings', async () => {
    const { report } = await scan(
      classic('(c ? XMLHttpRequest.prototype : e ? WebSocket.prototype : EventSource.prototype)[d ? "send" : "close"] = w'),
      ['--surface', 'all'],
    )

    expect(found(report)).toEqual([])
    expect(records(report)).toEqual([])
    expect(limitations(report, 'unresolved-holder')).toEqual([])
  })

  describe('more than 4 candidates', () => {
    const fiveHolders =
      '(a ? XMLHttpRequest.prototype : b ? WebSocket.prototype : c ? EventSource.prototype : d ? Worker.prototype : MessagePort.prototype)'

    test('a five-candidate holder set gives unresolved-holder when patch-shaped, never a finding', async () => {
      const { report } = await scan(classic(`var h = ${fiveHolders}; var o = h.close; h.close = function(){ return o.apply(this, arguments) }`), [
        '--surface',
        'all',
      ])

      expect(found(report)).toEqual([])
      const [record, ...rest] = limitations(report, 'unresolved-holder')
      expect(rest).toEqual([])
      expect(record.detail).toMatch(/could write .*WebSocket\.prototype\.close/)
      expect(record.detail).toMatch(/EventSource\.prototype\.close/)
      expect(report.completeness.level).toBe('complete-with-limitations')
    })

    test('a five-candidate holder set that is not patch-shaped gives nothing: (5-way holder).close = w', async () => {
      const { report } = await scan(classic(`${fiveHolders}.close = w`), ['--surface', 'all'])

      expect(found(report)).toEqual([])
      expect(limitations(report, 'unresolved-holder')).toEqual([])
    })

    test('a five-member set on a known holder follows the wildcard rule, and gives nothing without key reuse', async () => {
      const members = '(a ? "open" : b ? "send" : c ? "abort" : d ? "setRequestHeader" : "overrideMimeType")'
      const reused = await scan(classic(`var k = ${members}; XMLHttpRequest.prototype[k] = wrap(XMLHttpRequest.prototype[k])`))
      expect(found(reused.report)).toEqual(['XMLHttpRequest.prototype.*|wrap'])
      expect(targetReasons(reused.report.findings[0])).toEqual([])

      const fresh = await scan(classic(`var k = ${members}; XMLHttpRequest.prototype[k] = w`))
      expect(found(fresh.report)).toEqual([])
    })

    test('Math[k] = wrap(Math[k]) over five non-writable constants is an ineffective-write record Math.*', async () => {
      const code = 'var k = a ? "PI" : b ? "E" : c ? "LN2" : d ? "LN10" : "SQRT2"; Math[k] = wrap(Math[k])'
      const { report } = await scan(classic(code), ['--surface', 'all'])

      expect(found(report)).toEqual([])
      expect(records(report)).toEqual(['Math.*|non-writable'])
    })

    test('navigator[k] = wrap(navigator[k]) over five uncovered members is out of protected scope', async () => {
      const code =
        'var k = a ? "vibrate" : b ? "javaEnabled" : c ? "getGamepads" : d ? "requestMIDIAccess" : "canShare"; navigator[k] = wrap(navigator[k])'
      const all = await scan(classic(code), ['--surface', 'all'])
      expect(found(all.report)).toEqual(['navigator.*|wrap'])
      // Narrowed to its candidates, the wildcard has no mixed outcome.
      expect(all.report.findings[0].confidence.mutation.reasons).toEqual([])

      const scoped = await scan(classic(code), ['--surface', 'protected'])
      expect(found(scoped.report)).toEqual([])
      expect(Object.values(scoped.report.summary.outOfScopeBySurface).reduce((a: number, b: unknown) => a + (b as number), 0)).toBe(1)

      // The unnarrowed wildcard is in protected scope through `Navigator.sendBeacon`.
      const unnarrowed = await scan(classic('function f(k){ navigator[k] = wrap(navigator[k]) }'), ['--surface', 'protected'])
      expect(found(unnarrowed.report)).toEqual(['navigator.*|wrap'])
    })

    test('above 4 targets with at most 4 holders and a reused key gives a wildcard per holder', async () => {
      const code = [
        'var h = c ? XMLHttpRequest.prototype : WebSocket.prototype',
        'var k = a ? "send" : b ? "close" : "open"',
        'h[k] = wrap(h[k])',
      ]
      const { report } = await scan(classic(lines(...code)), ['--surface', 'all'])

      expect(found(report)).toEqual(['WebSocket.prototype.*|wrap', 'XMLHttpRequest.prototype.*|wrap'])
      for (const finding of report.findings) expect(targetReasons(finding)).toEqual(['holder-alternatives'])
    })
  })

  describe('the catalog narrows the holder set first when the member does not fold', () => {
    const walk = 'function patch(o, n){ let p = o; while (p && !Object.hasOwn(p, n)) p = Object.getPrototypeOf(p); p[n] = wrap(p[n]) }'

    test('a runtime choice after a read of the same key gives History.prototype.* alone, at high confidence', async () => {
      const reused = lines(
        'function f(cfg){',
        '  var target = hasOwnProperty.call(history, cfg.name) ? history : History.prototype',
        '  target[cfg.name] = wrap(target[cfg.name])',
        '}',
      )
      const { report } = await scan(classic(reused))

      expect(found(report)).toEqual(['History.prototype.*|wrap'])
      expect(report.findings[0].confidence.target).toEqual({ level: 'high', reasons: [] })
    })

    test('patch(XMLHttpRequest.prototype, cfg.name) gives four wildcards, each medium with holder-alternatives', async () => {
      const { report } = await scan(classic(lines(walk, 'patch(XMLHttpRequest.prototype, cfg.name)')))

      expect(found(report)).toEqual([
        'EventTarget.prototype.*|wrap',
        'Object.prototype.*|wrap',
        'XMLHttpRequest.prototype.*|wrap',
        'XMLHttpRequestEventTarget.prototype.*|wrap',
      ])
      for (const finding of report.findings) {
        expect(finding.confidence.target).toEqual({ level: 'medium', reasons: ['holder-alternatives'] })
        expect(reasonSteps(finding)[0].alternatives).toHaveLength(3)
      }
    })

    test('patch(window, cfg.name) gives EventTarget.prototype.* and Object.prototype.*, none on the global object', async () => {
      const { report } = await scan(classic(lines(walk, 'patch(window, cfg.name)')))

      expect(found(report)).toEqual(['EventTarget.prototype.*|wrap', 'Object.prototype.*|wrap'])
      for (const finding of report.findings) expect(targetReasons(finding)).toEqual(['holder-alternatives'])
    })

    test.each([
      ['HTMLElement.prototype', ['HTMLElement.prototype.*', 'Element.prototype.*', 'Node.prototype.*', 'EventTarget.prototype.*', 'Object.prototype.*']],
      ['document', ['document.*', 'Document.prototype.*', 'Node.prototype.*', 'EventTarget.prototype.*', 'Object.prototype.*']],
      [
        'HTMLDivElement.prototype',
        ['HTMLDivElement.prototype.*', 'HTMLElement.prototype.*', 'Element.prototype.*', 'Node.prototype.*', 'EventTarget.prototype.*', 'Object.prototype.*'],
      ],
    ])('patch(%s, cfg.name) narrows to more than 4 holders: an unresolved-holder record listing wildcards', async (start, names) => {
      const { report } = await scan(classic(lines(walk, `patch(${start}, cfg.name)`)))

      expect(found(report)).toEqual([])
      const [record, ...rest] = limitations(report, 'unresolved-holder')
      expect(rest).toEqual([])
      for (const name of names) expect(record.detail).toContain(name)
      expect(report.completeness.level).toBe('complete-with-limitations')
      expect(report.completeness.counters.blindSpots.unresolvedHolder).toBe(1)
    })

    test('the unresolved-holder record follows --surface', async () => {
      const { report } = await scan(classic(lines(walk, 'patch(HTMLElement.prototype, cfg.name)')), ['--surface', 'protected'])
      const [record] = limitations(report, 'unresolved-holder')
      // `EventTarget.prototype.*` is covered through `addEventListener`; `HTMLElement.prototype.*` isn't.
      expect(record.detail).toContain('EventTarget.prototype.*')
      expect(record.detail).not.toContain('HTMLElement.prototype.*')
    })

    test('a walk with a key that is not reused gives nothing', async () => {
      const noReuse = 'function patch(o, n){ let p = o; while (p && !Object.hasOwn(p, n)) p = Object.getPrototypeOf(p); p[n] = w }'
      const { report } = await scan(classic(lines(noReuse, 'patch(HTMLElement.prototype, cfg.name)', 'patch(XMLHttpRequest.prototype, cfg.name)')))

      expect(found(report)).toEqual([])
      expect(limitations(report, 'unresolved-holder')).toEqual([])
    })
  })

  describe('a key whose alternatives mix constants and unknown values', () => {
    test.each([
      ['XMLHttpRequest.prototype[k || "send"] = w', 'replace'],
      ['XMLHttpRequest.prototype[k || "send"] = wrap(XMLHttpRequest.prototype[k || "send"])', 'wrap'],
      ['var m = k || "send"; var o = XMLHttpRequest.prototype[m]; XMLHttpRequest.prototype[m] = function () { return o.apply(this, arguments) }', 'wrap'],
    ])('the one constant alternative is a candidate with member-alternatives, and the unknown part gives no wildcard: %s', async (code, effect) => {
      const { report } = await scan(classic(code))

      // A read of the same key reads the candidate's original, so a wrap of it is a `wrap`.
      expect(found(report)).toEqual([`XMLHttpRequest.prototype.send|${effect}`])
      const [finding] = report.findings
      expect(finding.confidence.target).toEqual({ level: 'medium', reasons: ['member-alternatives'] })
      const [step] = reasonSteps(finding)
      expect(step).toMatchObject({ reason: 'member-alternatives', alternatives: [] })
      expect(limitations(report, 'unresolved-holder')).toEqual([])
    })

    test.each([
      ['Object.defineProperty(XMLHttpRequest.prototype, k || "send", { value: w, writable: true, configurable: true })'],
      ['Reflect.set(XMLHttpRequest.prototype, k ?? "send", w)'],
    ])('every write mechanism takes it: %s', async (code) => {
      const { report } = await scan(classic(code))

      expect(report.findings.map((finding: Report) => finding.target.name)).toEqual(['XMLHttpRequest.prototype.send'])
      expect(targetReasons(report.findings[0])).toEqual(['member-alternatives'])
    })

    test('each constant alternative is a candidate: k || (c ? "open" : "send")', async () => {
      const { report } = await scan(classic('XMLHttpRequest.prototype[k || (c ? "open" : "send")] = w'))

      expect(found(report)).toEqual(['XMLHttpRequest.prototype.open|replace', 'XMLHttpRequest.prototype.send|replace'])
      for (const finding of report.findings) expect(targetReasons(finding)).toEqual(['member-alternatives'])
    })

    test('more than 4 constant alternatives beside an unknown one follow the wildcard rule only with key reuse', async () => {
      const members = 'k || (a ? "log" : b ? "warn" : c ? "error" : d ? "info" : "debug")'
      const fresh = await scan(classic(`console[${members}] = w`))
      expect(found(fresh.report)).toEqual([])

      const reused = await scan(classic(`var m = ${members}; console[m] = wrap(console[m])`))
      expect(found(reused.report)).toEqual(['console.*|wrap'])
      expect(targetReasons(reused.report.findings[0])).toEqual([])
    })
  })

  test.each([
    ['Object.defineProperty(c ? XMLHttpRequest.prototype : WebSocket.prototype, "send", { value: w, writable: true, configurable: true })'],
    ['Reflect.set(c ? XMLHttpRequest.prototype : WebSocket.prototype, "send", w)'],
    ['Object.assign(c ? XMLHttpRequest.prototype : WebSocket.prototype, { send: w })'],
  ])('every write mechanism takes a candidate set: %s', async (code) => {
    const { report } = await scan(classic(code))

    expect(report.findings.map((finding: Report) => finding.target.name).sort()).toEqual([
      'WebSocket.prototype.send',
      'XMLHttpRequest.prototype.send',
    ])
    for (const finding of report.findings) expect(targetReasons(finding)).toEqual(['holder-alternatives'])
  })
})


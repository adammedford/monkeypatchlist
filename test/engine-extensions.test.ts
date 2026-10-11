// Engine extensions (§4 Sources): the own properties V8 defines on ECMAScript intrinsics outside ECMA-262,
// `Error.stackTraceLimit` and `Error.captureStackTrace`, are native members like any other, in every realm. So a write
// to one is a `replace`, not an `add`. `Error.prepareStackTrace` is none: V8 doesn't define it, so writing it adds a
// member. Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join('\n')

/** Each finding's fingerprint, with the mechanism of each of its occurrences, in report order. */
const mechanisms = (report: { findings: Finding[] }): [string, string[]][] =>
  report.findings.map((finding) => [
    finding.fingerprint,
    finding.occurrences.map((occurrence: { mechanism: string }) => occurrence.mechanism),
  ])

describe('engine extensions are native members', () => {
  test('Error.stackTraceLimit = 50 gives a replace of Error.stackTraceLimit', async () => {
    const { report } = await scanBuild(classic('Error.stackTraceLimit = 50'))

    expect(report.findings.map(({ target, effect, surface }: Finding) => ({ target, effect, surface }))).toEqual([
      {
        target: { realm: 'window', holder: 'constructor', name: 'Error.stackTraceLimit' },
        effect: 'replace',
        surface: 'ECMAScript',
      },
    ])
  })

  test('Error.captureStackTrace is one too, whatever the mechanism', async () => {
    const { report } = await scanBuild(
      classic(
        lines(
          'Error.captureStackTrace = f',
          "Object.defineProperty(Error, 'stackTraceLimit', { value: 100 })",
          'delete Error.captureStackTrace',
        ),
      ),
    )

    expect(mechanisms(report)).toEqual([
      ['window|Error.captureStackTrace|delete|unknown', ['delete']],
      ['window|Error.captureStackTrace|replace|unknown', ['assign']],
      ['window|Error.stackTraceLimit|replace|unknown', ['define-property']],
    ])
  })

  test('V8 makes Error.stackTraceLimit enumerable, so only making it non-enumerable changes its descriptor', async () => {
    const { report } = await scanBuild(
      classic(
        lines(
          "Object.defineProperty(Error, 'stackTraceLimit', { enumerable: true, configurable: true })",
          "Object.defineProperty(Error, 'captureStackTrace', { enumerable: true })",
          "Object.defineProperty(Error, 'stackTraceLimit', { enumerable: false })",
        ),
      ),
    )

    expect(mechanisms(report)).toEqual([
      ['window|Error.captureStackTrace|descriptor-change|unknown', ['define-property']],
      ['window|Error.stackTraceLimit|descriptor-change|unknown', ['define-property']],
    ])
    expect(report.findings[1].occurrences).toHaveLength(1)
  })

  test('Error.prepareStackTrace, which V8 does not define, is an add on the Error constructor', async () => {
    const { report } = await scanBuild(classic('Error.prepareStackTrace = function (error, frames) { return frames }'))

    expect(report.findings.map(({ target, effect, surface }: Finding) => ({ target, effect, surface }))).toEqual([
      {
        target: { realm: 'window', holder: 'constructor', name: 'Error.prepareStackTrace' },
        effect: 'add',
        surface: 'ECMAScript',
      },
    ])
  })

  test('in a worker realm too', async () => {
    const { report } = await scanBuild({
      'index.html': '<script>new Worker("worker.js")</script>',
      'worker.js': 'self.Error.stackTraceLimit = 50',
    })

    expect(report.findings.map(({ targetKey }: Finding) => targetKey)).toEqual([
      'dedicated-worker|Error.stackTraceLimit|replace',
    ])
  })
})

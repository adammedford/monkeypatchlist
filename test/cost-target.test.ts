// Meeting the cost target (§18 If the target is missed, step 1). Optimizing in JavaScript must be
// semantics-preserving: a call keeps its own context when any of its arguments flows into the holder, key, value or
// descriptor of a write that reaches the global object. Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const scan = async (code: string) => (await scanBuild(classic(code))).report

describe('a call whose argument names a native write keeps its own context', () => {
  test('patch over a closed-over window gives Window.fetch, Window.open and Window.close, each from its own call', async () => {
    const report = await scan(
      [
        'function patch(n) {',
        '  const o = window[n]',
        '  window[n] = function () { return o.apply(this, arguments) }',
        '}',
        "patch('fetch'); patch('open'); patch('close');",
      ].join('\n'),
    )

    expect(report.findings.map((finding: Report) => finding.target.name).sort()).toEqual([
      'Window.close',
      'Window.fetch',
      'Window.open',
    ])
    expect(report.findings.map((finding: Report) => finding.fingerprint).sort()).toEqual([
      'window|Window.close|wrap|unknown',
      'window|Window.fetch|wrap|unknown',
      'window|Window.open|wrap|unknown',
    ])
    expect(report.completeness.level).toBe('complete')
    // Each finding's key comes from its own call: the trace names the call that passed it.
    for (const finding of report.findings) {
      const calls = finding.occurrences[0].trace.filter((step: Report) => step.kind === 'call')
      expect(calls).toHaveLength(1)
    }
  })
})

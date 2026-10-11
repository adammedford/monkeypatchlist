import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

const page = '<!doctype html><html><head><script src="main.js"></script></head><body></body></html>'

describe('monkeypatchlist scan: a direct write of a global member', () => {
  test('window.fetch = function(){} in a local classic script is one Window.fetch replace, keyed unknown', async () => {
    const { report } = await scanBuild({ 'index.html': page, 'main.js': 'window.fetch = function(){}\n' })

    expect(report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      'window|Window.fetch|replace|unknown',
    ])
  })

  test('the same write in an inline script is keyed inline', async () => {
    const { report } = await scanBuild({ 'index.html': '<script>window.fetch = function(){}</script>' })

    expect(report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      'window|Window.fetch|replace|inline',
    ])
    expect(report.findings[0].attribution).toEqual({ key: 'inline', provenance: 'inline' })
  })

  test('a bare global write at top level is a finding, and one to a parameter of the same name is not', async () => {
    const { report } = await scanBuild({
      'index.html': page,
      'main.js': 'function f(fetch){ fetch = w }\nfunction g(){ var setTimeout; setTimeout = w }\nfetch = x\n',
    })

    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].occurrences).toHaveLength(1)
    expect(report.findings[0].occurrences[0].generated.line).toBe(3)
  })

  test('self and globalThis are the global object too, unless a declaration shadows them', async () => {
    const { report } = await scanBuild({
      'index.html': page,
      'main.js': [
        'self.setTimeout = a',
        'globalThis.queueMicrotask = b',
        'function f(self){ self.setInterval = c }',
        'function g(){ let globalThis = {}; globalThis.clearTimeout = d }',
      ].join('\n'),
    })

    expect(report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      'window|Window.queueMicrotask|replace|unknown',
      'window|Window.setTimeout|replace|unknown',
    ])
  })

  test('a write to a name that is no catalog global, or to a global the write cannot replace, is not a finding yet', async () => {
    const { report } = await scanBuild({
      'index.html': page,
      // A new non-native global, an event-handler attribute (API use, §3) and a readonly attribute (an ineffective
      // write).
      'main.js': 'window.jQuery = a\nwindow.onerror = b\nwindow.closed = c\n',
    })

    expect(report.findings).toEqual([])
  })
})

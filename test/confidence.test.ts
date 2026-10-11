// Confidence (§9): each occurrence carries `{ level, reasons[] }` for target, mutation and attribution, and a finding
// takes the highest level per dimension across its occurrences (§15 Findings).

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

const high = { level: 'high', reasons: [] }

describe('monkeypatchlist scan: confidence (§9)', () => {
  test('occurrences and findings carry the three dimensions, in the report order of §15', async () => {
    const { report } = await scanBuild({
      'index.html': '<script src="main.js"></script><script>window.fetch = a</script>',
      'main.js': 'window.fetch = b',
    })

    const [inline, local] = report.findings
    expect(Object.keys(inline)).toEqual([
      'fingerprint',
      'targetKey',
      'target',
      'surface',
      'effect',
      'locks',
      'attribution',
      'reachability',
      'reachabilityBasis',
      'installContext',
      'confidence',
      'baselineState',
      'matchedBy',
      'changedReasons',
      'notes',
      'policy',
      'occurrences',
    ])
    expect(Object.keys(inline.occurrences[0])).toEqual([
      'artifact',
      'generated',
      'original',
      'mechanism',
      'reachability',
      'reachabilityBasis',
      'installContext',
      'installEntry',
      'realmInstance',
      'evidence',
      'confidence',
      'trace',
    ])
    // Inline code is high on attribution. Local code with no source map is low, with `no-map` (§9 Attribution).
    expect(inline.occurrences[0].confidence).toEqual({ target: high, mutation: high, attribution: high })
    expect(local.occurrences[0].confidence).toEqual({
      target: high,
      mutation: high,
      attribution: { level: 'low', reasons: ['no-map'] },
    })
    expect(inline.confidence).toEqual(inline.occurrences[0].confidence)
    expect(local.confidence).toEqual(local.occurrences[0].confidence)
  })

  describe('a finding takes the highest level per dimension across its occurrences', () => {
    const targets = async (code: string) => {
      const { report } = await scanBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
      expect(report.findings).toHaveLength(1)
      const [finding] = report.findings
      return {
        occurrences: finding.occurrences.map((occurrence: { confidence: { target: unknown } }) => occurrence.confidence.target),
        finding: finding.confidence.target,
      }
    }

    test('one certain site makes the finding high, whatever the others say', async () => {
      expect(await targets('with (o) { fetch = a }\nfetch = b')).toEqual({
        occurrences: [{ level: 'low', reasons: ['with-scope'] }, high],
        finding: high,
      })
    })

    test('below high, the finding keeps the reasons of the occurrences at its level', async () => {
      expect(await targets('function g(){ eval(s); fetch = a }\nwith (o) { fetch = b }')).toEqual({
        occurrences: [
          { level: 'medium', reasons: ['direct-eval-scope'] },
          { level: 'low', reasons: ['with-scope'] },
        ],
        finding: { level: 'medium', reasons: ['direct-eval-scope'] },
      })
      expect(await targets('with (o) { fetch = a }\nwith (p) { fetch = b }\nfunction g(){ eval(s); with (o) { fetch = c } }')).toEqual({
        occurrences: [
          { level: 'low', reasons: ['with-scope'] },
          { level: 'low', reasons: ['with-scope'] },
          { level: 'low', reasons: ['direct-eval-scope', 'with-scope'] },
        ],
        finding: { level: 'low', reasons: ['direct-eval-scope', 'with-scope'] },
      })
    })
  })
})

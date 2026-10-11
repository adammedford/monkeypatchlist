// The scoring harness keeps only the fields of each report it reads (tools/scoring/report.ts), so the
// reports of the whole corpus fit in the default heap.

import { describe, expect, test } from 'vitest'
import { trimReport, type ScanReport } from '../tools/scoring/report.ts'

const tool = { monkeypatchlistVersion: '0.0.0', catalogVersion: 1, analyzerVersion: 'a', fingerprintScheme: 1 }

describe('trimReport', () => {
  test('keeps the fields the scorer reads, only the guard steps of each trace, and only each artifact\'s module links', () => {
    const full = {
      tool: { ...tool, extra: 'x' },
      run: { startedAt: 'now' },
      limitations: [{ kind: 'k' }],
      artifacts: [
        { url: 'u', hash: 'h', moduleLinking: { idioms: ['lazy-thunk'], modules: 2, unlinked: 1, linkGroups: 1 } },
      ],
      findings: [
        {
          fingerprint: 'f',
          targetKey: 'window|fetch',
          target: { realm: 'window', holder: 'Window', name: 'fetch', shadows: 's', note: 'n' },
          surface: 'protected',
          effect: 'wrap',
          locks: false,
          attribution: { key: 'pkg:a', provenance: 'map', package: 'a', evidence: ['e'] },
          reachability: 'guarded-native-absence',
          reachabilityBasis: 'call-path',
          installContext: 'load',
          message: 'long text',
          occurrences: [
            {
              reachability: 'guarded-native-absence',
              location: { file: 'a.js', line: 1 },
              trace: [
                { kind: 'call', detail: 'x' },
                { kind: 'guard', class: 'absence', tested: 'Promise', result: 'absent', detail: 'y' },
              ],
            },
          ],
        },
      ],
    }
    expect(trimReport(full as unknown as ScanReport)).toEqual({
      tool,
      findings: [
        {
          fingerprint: 'f',
          targetKey: 'window|fetch',
          target: { realm: 'window', holder: 'Window', name: 'fetch', shadows: 's' },
          surface: 'protected',
          effect: 'wrap',
          locks: false,
          attribution: { key: 'pkg:a', provenance: 'map', package: 'a' },
          reachability: 'guarded-native-absence',
          reachabilityBasis: 'call-path',
          installContext: 'load',
          occurrences: [
            {
              reachability: 'guarded-native-absence',
              trace: [{ kind: 'guard', class: 'absence', tested: 'Promise', result: 'absent' }],
            },
          ],
        },
      ],
      artifacts: [{ moduleLinking: { idioms: ['lazy-thunk'], modules: 2, unlinked: 1 } }],
    })
  })

  test('leaves out the optional fields a finding does not have', () => {
    const finding = {
      fingerprint: 'f',
      targetKey: 't',
      target: { realm: 'window', holder: 'Window', name: 'fetch' },
      surface: 'protected',
      effect: 'wrap',
      locks: 'unknown',
      attribution: { key: 'unknown', provenance: 'none' },
      occurrences: [{ trace: [] }],
    }
    expect(trimReport({ tool, findings: [finding] } as unknown as ScanReport)).toEqual({ tool, findings: [finding], artifacts: [] })
  })
})

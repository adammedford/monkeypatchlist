// The reachability hand sample, `labels/reachability-sample.json` (§20 Reachability labels): about 5 observed true
// positives per library, each hand-labeled `unconditional` or `conditional` with a code citation. A positive the base
// run observed is derived only as "not `guarded-native-absence`"; the sample settles which of the two it is. Triage
// writes it; the scorer reads it.
//
//   {
//     "$schema": "<a note on the file>",
//     "<library>": [
//       { "target": "Window.fetch", "reachability": "conditional", "citation": "pkg@1.0.0 src/fetch.js L12-20" }
//     ]
//   }

import { CorpusError } from './corpus-error.ts'

/** The values the sample settles between (§20). */
const sampleValues = ['unconditional', 'conditional'] as const

export interface SampleLabel {
  /** The positive's target name, as the catalog spells it (window realm). */
  target: string
  reachability: (typeof sampleValues)[number]
  citation: string
}

/** Checks the file's entries, by library: one value of the two each, a citation each, no target twice. */
export function parseReachabilitySample(file: Record<string, unknown>): Record<string, SampleLabel[]> {
  const byLibrary: Record<string, SampleLabel[]> = {}
  for (const [library, entries] of Object.entries(file)) {
    if (library === '$schema') continue
    if (!Array.isArray(entries)) throw new CorpusError(`reachability sample: ${library} is not a list`)
    const seen = new Set<string>()
    byLibrary[library] = entries.map((entry: Partial<SampleLabel>) => {
      const where = `reachability sample: ${library} '${entry.target}'`
      if (typeof entry.target !== 'string' || entry.target === '') {
        throw new CorpusError(`reachability sample: ${library}: an entry has no target`)
      }
      if (!sampleValues.includes(entry.reachability as SampleLabel['reachability'])) {
        throw new CorpusError(`${where}: reachability must be 'unconditional' or 'conditional'`)
      }
      if (typeof entry.citation !== 'string' || entry.citation.trim() === '') {
        throw new CorpusError(`${where}: a sample label needs a citation`)
      }
      if (seen.has(entry.target)) throw new CorpusError(`${where}: labeled twice`)
      seen.add(entry.target)
      return { target: entry.target, reachability: entry.reachability!, citation: entry.citation }
    })
  }
  return byLibrary
}

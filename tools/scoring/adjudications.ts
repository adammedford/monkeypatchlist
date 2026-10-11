// The adjudications file, `labels/adjudications.json` (§20 Triage): the triage class of each disagreement between the
// scanner and the positive set, with a code citation. Triage writes it; the scorer reads it for the counted relabels,
// and shows each disagreement's class beside it. A false positive names the finding's target (`console.*` for a
// wildcard); a false negative names the positive's target, or `zone-symbol-adds` for zone.js's group.
//
//   {
//     "$schema": "<a note on the file>",
//     "<library>": [
//       { "target": "Array.prototype.at", "disagreement": "false-positive", "class": "unobserved-real",
//         "citation": "core-js@3.50.0 modules/es.array.at.js L12" }
//     ]
//   }

import { CorpusError } from './corpus-error.ts'

/** The triage classes (§20 Triage). */
const triageClasses = ['resolver-defect', 'ground-truth-error', 'unobserved-real', 'beyond-model', 'boundary'] as const
export type TriageClass = (typeof triageClasses)[number]

/**
 * The classes that say a false positive is real, so that adjudicating one relabels it a true positive: code no variant
 * can reach (`unobserved-real`), or a harness or label that missed it (`ground-truth-error`).
 */
const relabelClasses: readonly TriageClass[] = ['unobserved-real', 'ground-truth-error']

export interface Adjudication {
  /** The finding's or positive's target name, as the report and the catalog spell it (window realm). */
  target: string
  /** A finding with no positive, or a positive no finding recalls. */
  disagreement: 'false-positive' | 'false-negative'
  class: TriageClass
  citation: string
}

/** Checks the file's entries, by library: known fields, one class each, a citation each. */
export function parseAdjudications(file: Record<string, unknown>): Record<string, Adjudication[]> {
  const byLibrary: Record<string, Adjudication[]> = {}
  for (const [library, entries] of Object.entries(file)) {
    if (library === '$schema') continue
    if (!Array.isArray(entries)) throw new CorpusError(`adjudications: ${library} is not a list`)
    const seen = new Set<string>()
    byLibrary[library] = entries.map((entry: Partial<Adjudication>) => {
      const where = `adjudications: ${library} '${entry.target}'`
      if (typeof entry.target !== 'string' || entry.target === '') {
        throw new CorpusError(`adjudications: ${library}: an entry has no target`)
      }
      if (entry.disagreement !== 'false-positive' && entry.disagreement !== 'false-negative') {
        throw new CorpusError(`${where}: disagreement must be 'false-positive' or 'false-negative'`)
      }
      if (!triageClasses.includes(entry.class as TriageClass)) throw new CorpusError(`${where}: unknown class '${entry.class}'`)
      if (typeof entry.citation !== 'string' || entry.citation.trim() === '') {
        throw new CorpusError(`${where}: an adjudication needs a citation`)
      }
      const key = `${entry.disagreement} ${entry.target}`
      if (seen.has(key)) throw new CorpusError(`${where}: ${entry.disagreement} is adjudicated twice`)
      seen.add(key)
      return { target: entry.target, disagreement: entry.disagreement, class: entry.class as TriageClass, citation: entry.citation }
    })
  }
  return byLibrary
}

/** Whether an adjudication relabels a false positive a true positive. */
export function isRelabel(adjudication: Adjudication): boolean {
  return adjudication.disagreement === 'false-positive' && relabelClasses.includes(adjudication.class)
}

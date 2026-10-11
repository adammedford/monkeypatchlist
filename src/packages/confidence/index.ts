// Confidence (§9): analytical certainty about a finding, never a measure of risk. It is recorded for three dimensions:
// target (is the named target the one written?), mutation (does the write take effect as stated?) and attribution (are
// the containing package and the original location right?). The resolver gives target and mutation reasons,
// attribution gives attribution reasons, and findings rolls occurrences up into their finding.

/** The levels, highest first. */
export const levels = ['high', 'medium', 'low'] as const
export type Level = (typeof levels)[number]

type Reasons = Readonly<Record<string, Exclude<Level, 'high'>>>

/** The closed list of target-confidence reasons, with the level each gives (§9 Target confidence). */
export const targetReasons = {
  'realm-assumed': 'medium',
  'holder-alternatives': 'medium',
  'member-alternatives': 'medium',
  'direct-eval-scope': 'medium',
  'with-scope': 'low',
} as const satisfies Reasons
export type TargetReason = keyof typeof targetReasons

/** The closed list of mutation-confidence reasons, with the level each gives (§9 Mutation confidence). */
export const mutationReasons = {
  'outcome-undecidable': 'medium',
  'wildcard-outcome-mixed': 'medium',
  'const-collision': 'low',
} as const satisfies Reasons
export type MutationReason = keyof typeof mutationReasons

/** The closed list of attribution-confidence reasons, with the level each gives (§9 Attribution confidence). */
export const attributionReasons = {
  'token-check-n/a': 'medium',
  'sidecar-not-token-verified': 'medium',
  'framework-path-rule': 'medium',
  'first-party-inferred': 'medium',
  'prebundled-dist': 'medium',
  'yarn-slug': 'low',
  'line-separator': 'medium',
  'no-map': 'low',
  'escaped-source': 'low',
  'token-check-failed': 'low',
  vendored: 'low',
  'foreign-scheme': 'low',
  'ignore-list-demoted': 'low',
} as const satisfies Reasons
export type AttributionReason = keyof typeof attributionReasons

/** One dimension's confidence: its level, and the reasons that hold it below `high` (none at `high`). */
export interface Dimension<Reason extends string> {
  level: Level
  reasons: Reason[]
}

export interface Confidence {
  target: Dimension<TargetReason>
  mutation: Dimension<MutationReason>
  attribution: Dimension<AttributionReason>
}

export const targetConfidence = (reasons: Iterable<TargetReason> = []) => dimension(targetReasons, reasons)
export const mutationConfidence = (reasons: Iterable<MutationReason> = []) => dimension(mutationReasons, reasons)
export const attributionConfidence = (reasons: Iterable<AttributionReason> = []) => dimension(attributionReasons, reasons)

/**
 * A dimension from its reasons: its level is the lowest level among them, and `high` when there are none. Each reason
 * is listed once, in the order of §9's table.
 */
function dimension<Reason extends string>(table: Readonly<Record<Reason, Level>>, reasons: Iterable<Reason>): Dimension<Reason> {
  const given = new Set(reasons)
  const listed = (Object.keys(table) as Reason[]).filter((reason) => given.has(reason))
  if (listed.length !== given.size) throw new Error(`not a confidence reason of this dimension: ${[...given].join(', ')}`)
  return { level: lowest(listed.map((reason) => table[reason])), reasons: listed }
}

/**
 * A finding's confidence from its occurrences' (§9 Occurrences): per dimension, the highest level among them, because
 * one certain site proves the mutation exists. The finding carries the reasons of the occurrences at that level.
 */
export function rollUp(occurrences: readonly Confidence[]): Confidence {
  return {
    target: highest(occurrences.map((confidence) => confidence.target), targetReasons),
    mutation: highest(occurrences.map((confidence) => confidence.mutation), mutationReasons),
    attribution: highest(occurrences.map((confidence) => confidence.attribution), attributionReasons),
  }
}

function highest<Reason extends string>(
  dimensions: readonly Dimension<Reason>[],
  table: Readonly<Record<Reason, Level>>,
): Dimension<Reason> {
  if (dimensions.length === 0) throw new Error('a finding has at least one occurrence')
  const level = levels[Math.min(...dimensions.map((dimension) => levels.indexOf(dimension.level)))]!
  const reasons = dimensions.filter((dimension) => dimension.level === level).flatMap((dimension) => dimension.reasons)
  return dimension(table, reasons)
}

function lowest(given: readonly Level[]): Level {
  return levels[Math.max(0, ...given.map((level) => levels.indexOf(level)))]!
}

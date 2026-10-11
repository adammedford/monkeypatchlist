// Scores scan reports against the corpus's positive sets (§20 Scoring rules, Bars). Pure apart from the `chromiumHas` it
// is given, which may read the pinned BCD on first use: the same input always gives the same scores, in the same key
// order.

import type { SerializedCatalog } from '../../src/catalog.ts'
import { isRelabel, type Adjudication } from './adjudications.ts'
import type { ChromiumHas } from './chromium.ts'
import { mostReaching, type ReportedFinding, type ScanReport } from './report.ts'
import type { Corpus, CorpusBuild } from './corpus.ts'
import { positivesOf, type Positive } from './positives.ts'
import { cdnDifferences, identityInvariance, setInvariance, variance, type IdentityInvariance } from './invariance.ts'
import { protectedSlice, type SliceTarget } from './protected-slice.ts'

export interface ScoreInput {
  catalog: SerializedCatalog
  corpus: Corpus
  /** Each build's report, by build id. */
  reports: ReadonlyMap<string, ScanReport>
  /** Which natives Chromium has (§20: the Chromium rule). */
  chromiumHas: ChromiumHas
}

/** The findings of one build on one target: a target is scored once, whatever its effects and attribution keys. */
interface FoundTarget extends SliceTarget {
  effects: string[]
  /** Its findings' reachability values (§7). */
  reachability: string[]
  /** The natives the `absence` guards of its `guarded-native-absence` occurrences test (§14 `guard`). */
  absenceTested: string[]
}

/** Which findings and positives a slice keeps. */
interface Slice {
  finding: (target: FoundTarget) => boolean
  positive: (positive: Positive) => boolean
}

/** The negatives (§20): builds that must give no protected finding. They are scored apart from the libraries. */
const negatives = ['control', 'otel-document-load', 'segment']

/**
 * The headline set (§20 Bars): each item is a target and its shadowing form. An item counts in a build when the
 * library's positive set has it.
 */
const headlineSet = [
  ['Window.fetch'],
  ['XMLHttpRequest.prototype.open'],
  ['XMLHttpRequest.prototype.send'],
  ['History.prototype.pushState', 'history.pushState'],
  ['History.prototype.replaceState', 'history.replaceState'],
]

/**
 * The libraries the headline set is scored for: Sentry, Datadog and OTel. Application Insights is not one of them, so
 * its `fetch` and `history` stay out of the headline set, as §20 requires.
 */
const headlineLibraries = ['datadog', 'otel', 'sentry-10', 'sentry-11', 'sentry-11-no-replay', 'sentry-7']

/** The bars of §20 this harness judges with a threshold, on the protected slice. */
export const bars = {
  precision: { macro: 0.95, library: 0.9 },
  observedRecall: 0.8,
  handLabeledRecall: 0.95,
  headline: 1,
  effectAccuracy: 0.9,
  reachabilityAccuracy: 0.9,
} as const

/** The counts one build gives on one slice. */
interface Counts {
  /** Targets its findings name. */
  findings: number
  /** Runtime-confirmed true positives: a Chromium run, the base run or an exercise variant, observed the positive. */
  truePositives: number
  /**
   * Counted relabels (§20 Precision): true positives that rest on a hand label alone, and false positives an
   * adjudication relabels true positives.
   */
  relabeled: number
  /** Recall units: a target, or a whole scoring group. */
  observedPositives: number
  observedHits: number
  handLabeledPositives: number
  handLabeledHits: number
  /** True positives that name their target, and those whose effects are right. */
  effectScored: number
  effectCorrect: number
  headlineItems: number
  headlineHits: number
  /** True positives that name a target with a reachability label, and those whose reachability the label allows. */
  reachabilityScored: number
  reachabilityCorrect: number
  /** Targets that break the Chromium rule (§20). */
  chromiumRuleViolations: number
}

/** One build on one slice: its counts, and what it got wrong. */
interface BuildScore {
  build: CorpusBuild
  counts: Counts
  /** The targets its findings name. */
  found: string[]
  /**
   * The targets its findings in the slice name outside the window realm, as `<realm>:<target>`. Nothing scores them,
   * but a negative counts them (§20 Negatives).
   */
  foundInOtherRealms: string[]
  falsePositives: string[]
  relabeled: string[]
  observedMisses: string[]
  handLabeledMisses: string[]
  effectErrors: { target: string; found: string[]; expected: string[] }[]
  /** True positives whose reachability the label doesn't allow: the value found, and the values the label allows. */
  reachabilityErrors: { target: string; found: string[]; expected: string[] }[]
  /** The targets that break the Chromium rule (§20), with the natives Chromium has that their guards test. */
  chromiumRuleViolations: { target: string; tested: string[] }[]
  /** The headline items it misses, by their first spelling. */
  headlineMisses: string[]
}

export function score({ catalog, corpus, reports, chromiumHas }: ScoreInput) {
  const isProtected = protectedSlice(catalog)
  const protectedOnly: Slice = {
    finding: isProtected,
    // zone.js's group is outside the protected surface (§20 Scoring unit), though §12 would cover the named adds in it.
    positive: (p) => p.group === undefined && isProtected(windowTarget(p)),
  }
  const whole: Slice = { finding: () => true, positive: () => true }

  const positives = new Map<string, Map<string, Positive>>()
  const excludedPositives: Record<string, string[]> = {}
  for (const library of librariesOf(corpus.builds)) {
    const runs = corpus.groundTruth.filter((t) => t.library === library)
    const set = positivesOf(catalog, {
      library,
      runs,
      handLabels: corpus.handLabels[library] ?? [],
      sample: corpus.reachabilitySample[library] ?? [],
    })
    positives.set(library, set.positives)
    if (set.excluded.length) excludedPositives[library] = set.excluded
  }

  // Every build is scored once on each slice, then aggregated by set: the base builds (with the bars) and each exercise
  // variant's builds (no bar).
  const scoreAll = (slice: Slice) =>
    corpus.builds.map((build) => {
      const adjudicated = corpus.adjudications[build.library] ?? []
      return scoreBuild(build, reports.get(build.id)!, positives.get(build.library)!, slice, adjudicated, chromiumHas)
    })
  const scored = { protected: scoreAll(protectedOnly), all: scoreAll(whole) }
  const sliceScores = (set: string, slice: keyof typeof scored) =>
    aggregate(
      scored[slice].filter((r) => r.build.set === set),
      corpus.adjudications,
    )

  const protectedScores = sliceScores('base', 'protected')
  const isProtectedFinding = (f: ReportedFinding) =>
    isProtected({ realm: f.target.realm, name: f.target.name, ...(f.target.shadows === undefined ? {} : { shadows: f.target.shadows }), effects: [f.effect] })
  const bundled = bundledBuilds(corpus.builds)
  const cdn = corpus.builds.filter((build) => build.set === 'base' && build.bundler === 'cdn')
  const invariance = identityInvariance(bundled, reports, isProtectedFinding)
  const foundOn = (slice: keyof typeof scored) => {
    const byBuild = new Map(scored[slice].map((r) => [r.build, [...r.found, ...r.foundInOtherRealms]]))
    return (build: CorpusBuild) => byBuild.get(build)!
  }
  const variants = [...new Set(corpus.builds.map((b) => b.set))].filter((set) => set !== 'base').sort()
  return {
    scoresVersion: 1,
    tool: toolOf(corpus.builds.map((b) => reports.get(b.id)!)),
    bars: judge(protectedScores, invariance),
    idioms: idiomSummary(corpus.builds.filter((build) => build.set === 'base' && !negatives.includes(build.library)), reports),
    identityInvariance: invariance,
    setInvariance: {
      protected: setInvariance(bundled, foundOn('protected')),
      all: setInvariance(bundled, foundOn('all')),
      cdn: { protected: cdnDifferences(bundled, cdn, foundOn('protected')), all: cdnDifferences(bundled, cdn, foundOn('all')) },
    },
    variance: { protected: variance(bundled, reports, isProtectedFinding), all: variance(bundled, reports, () => true) },
    protected: protectedScores,
    all: sliceScores('base', 'all'),
    variants: Object.fromEntries(
      variants.map((variant) => [
        variant,
        { protected: sliceScores(variant, 'protected'), all: sliceScores(variant, 'all') },
      ]),
    ),
    excludedPositives,
    perBuild: corpus.builds.map((build, i) => ({
      build: build.id,
      set: build.set,
      library: build.library,
      bundler: build.bundler,
      // The corpus snapshots the window realm only (§20), so findings in another realm are counted, not scored.
      unscoredFindings: reports.get(build.id)!.findings.filter((f) => f.target.realm !== 'window').length,
      protected: buildSummary(scored.protected[i]!),
      all: buildSummary(scored.all[i]!),
    })),
  }
}

export type Scores = ReturnType<typeof score>

/** How one bundler's builds, or one CDN bundle, link their modules (§6 conformance). */
interface IdiomUse {
  builds: number
  /** Each idiom, with the number of builds that link through it in any artifact. */
  idioms: Record<string, number>
  modules: number
  unlinked: number
}

/**
 * The idiom conformance summary (§6: conformance is tested against the pinned bundlers and the vendor CDN bundles): per
 * bundler, and per CDN bundle as `cdn/<library>`, which idioms the base builds' artifacts link through, with their
 * modules and unlinked calls summed. Keys are sorted, so the summary is deterministic.
 */
function idiomSummary(builds: readonly CorpusBuild[], reports: ReadonlyMap<string, ScanReport>): Record<string, IdiomUse> {
  const uses = new Map<string, IdiomUse>()
  for (const build of builds) {
    const key = build.bundler === 'cdn' ? `cdn/${build.library}` : build.bundler
    const use = uses.get(key) ?? { builds: 0, idioms: {}, modules: 0, unlinked: 0 }
    uses.set(key, use)
    use.builds++
    const idioms = new Set<string>()
    for (const { moduleLinking } of reports.get(build.id)!.artifacts ?? []) {
      for (const idiom of moduleLinking.idioms) idioms.add(idiom)
      use.modules += moduleLinking.modules
      use.unlinked += moduleLinking.unlinked
    }
    for (const idiom of idioms) use.idioms[idiom] = (use.idioms[idiom] ?? 0) + 1
  }
  const sorted = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  return sorted(Object.fromEntries([...uses].map(([key, use]) => [key, { ...use, idioms: sorted(use.idioms) }])))
}

function scoreBuild(
  build: CorpusBuild,
  report: ScanReport,
  positiveSet: Map<string, Positive>,
  slice: Slice,
  adjudications: readonly Adjudication[],
  chromiumHas: ChromiumHas,
): BuildScore {
  const libraryPositives = [...positiveSet.values()]
  const allRealms = [...foundTargets(report).values()]
  // The corpus snapshots the window realm only (§20): findings in a worker realm have no ground truth to score against.
  const found = allRealms.filter((f) => f.realm === 'window' && slice.finding(f))
  const foundInOtherRealms = allRealms.filter((f) => f.realm !== 'window' && slice.finding(f))
  // A finding in the slice is a true positive when it matches any positive of its library, in the slice or not: a
  // named add §12 protects can match zone.js's group, which §20 keeps out of the protected slice.
  const truePositives = found.filter((f) => libraryPositives.some((p) => matches(f, p)))
  const falsePositives = found.filter((f) => !truePositives.includes(f)).map((f) => f.name)
  // Precision is reported twice (§20): runtime-confirmed only, and including counted relabels. A true positive whose
  // only evidence is a hand label is a relabel, and so is a false positive an adjudication says
  // is real.
  const runtimeConfirmed = truePositives.filter((f) => libraryPositives.some((p) => p.observed && matches(f, p)))
  const relabeled = [
    ...truePositives.filter((f) => !runtimeConfirmed.includes(f)).map((f) => f.name),
    ...falsePositives.filter((name) => adjudications.some((a) => a.target === name && isRelabel(a))),
  ]

  // Recall is judged on the slice's findings too: a positive the slice keeps is recalled only by a finding it keeps.
  const recall = (positives: readonly Positive[]) => {
    const units = unitsOf(positives)
    const misses = units.filter((unit) => !isRecalled(unit, found)).map((unit) => unit[0]!.group ?? unit[0]!.name)
    return { units: units.length, misses: misses.sort() }
  }
  const positives = libraryPositives.filter(slice.positive)
  const observed = recall(positives.filter((p) => p.observed))
  const handLabeled = recall(positives.filter((p) => p.handLabeled))

  // Effect accuracy is scored on the true positives that name their target: every effect found on it must be one the
  // positive has.
  const named = truePositives.filter((f) => !isWildcard(f.name))
  const effectErrors = named.flatMap((f) => {
    const expected = [...new Set(libraryPositives.filter((p) => matches(f, p)).flatMap((p) => p.effects))].sort()
    const right = f.effects.every((effect) => expected.includes(effect))
    return right ? [] : [{ target: f.name, found: [...f.effects].sort(), expected }]
  })

  // Reachability accuracy is scored on the true positives that name their target and whose positives carry a label
  // (§20 Reachability labels): the finding's value, the most-reaching over its findings (§7), must be one it allows.
  const reachabilityErrors: { target: string; found: string[]; expected: string[] }[] = []
  let reachabilityScored = 0
  for (const f of named) {
    const labels = libraryPositives.filter((p) => matches(f, p) && p.reachabilityLabel !== undefined)
    if (!labels.length) continue
    reachabilityScored += 1
    const expected = [...new Set(labels.flatMap((p) => p.reachabilityLabel!))].sort()
    const value = mostReaching(f.reachability)
    if (value === undefined || !expected.includes(value)) {
      reachabilityErrors.push({ target: f.name, found: value === undefined ? [] : [value], expected })
    }
  }

  // The Chromium rule (§20): a mutation a Chromium run with every native present observed is never
  // `guarded-native-absence` for a guard on a feature Chromium has. A finding that records no tested native breaks it too.
  const chromiumRuleViolations = named.flatMap((f) => {
    if (mostReaching(f.reachability) !== 'guarded-native-absence') return []
    if (!libraryPositives.some((p) => p.observedWithNatives && matches(f, p))) return []
    const had = f.absenceTested.filter((name) => chromiumHas(f.realm, name))
    return had.length || !f.absenceTested.length ? [{ target: f.name, tested: had }] : []
  })

  const headlineItems = headlineLibraries.includes(build.library)
    ? headlineSet.filter((item) => item.some((name) => positiveSet.has(name)))
    : []
  const headlineMisses = headlineItems.filter((item) => !named.some((f) => item.includes(f.name))).map((item) => item[0]!)

  return {
    build,
    counts: {
      findings: found.length,
      truePositives: runtimeConfirmed.length,
      relabeled: relabeled.length,
      observedPositives: observed.units,
      observedHits: observed.units - observed.misses.length,
      handLabeledPositives: handLabeled.units,
      handLabeledHits: handLabeled.units - handLabeled.misses.length,
      effectScored: named.length,
      effectCorrect: named.length - effectErrors.length,
      headlineItems: headlineItems.length,
      headlineHits: headlineItems.length - headlineMisses.length,
      reachabilityScored,
      reachabilityCorrect: reachabilityScored - reachabilityErrors.length,
      chromiumRuleViolations: chromiumRuleViolations.length,
    },
    found: found.map((f) => f.name).sort(),
    foundInOtherRealms: foundInOtherRealms.map((f) => `${f.realm}:${f.name}`).sort(),
    falsePositives: falsePositives.sort(),
    relabeled: relabeled.sort(),
    observedMisses: observed.misses,
    handLabeledMisses: handLabeled.misses,
    effectErrors,
    reachabilityErrors,
    chromiumRuleViolations,
    headlineMisses,
  }
}

/**
 * Whether a finding is a true positive for a positive (§20 True positives):
 * - its target matches, realm and holder included (the name says both, §4)
 * - a wildcard matches every positive on its holder whose key starts with its prefix
 * - a positive that can only run where a native is missing matches only a finding tagged `guarded-native-absence` or
 *   `conditional`
 */
function matches(finding: FoundTarget, positive: Positive): boolean {
  if (positive.absenceOnly && !finding.reachability.some((r) => r === 'guarded-native-absence' || r === 'conditional')) {
    return false
  }
  if (isWildcard(finding.name)) {
    const { holder, prefix } = wildcardParts(finding.name)
    return positive.holder === holder && positive.key.startsWith(prefix)
  }
  if (finding.name === positive.name) return true
  // The spec doesn't name a `prototype-change` target, and the corpus names it `<holder>.[[Prototype]]`. The holder's
  // own name is accepted too.
  return (
    finding.effects.includes('prototype-change') &&
    positive.effects.includes('prototype-change') &&
    finding.name === positive.holder
  )
}

function isWildcard(name: string): boolean {
  return name.endsWith('*')
}

/**
 * A wildcard's holder and the prefix the keys it matches start with (§5): `console.*` (no prefix),
 * `EventTarget.prototype.__zone_symbol__*`, or a prefix in JSON-quoted brackets with the star outside,
 * `Object.prototype["__core.hidden."]*`.
 */
function wildcardParts(name: string): { holder: string; prefix: string } {
  if (name.endsWith('"]*')) {
    const bracket = name.indexOf('["')
    return { holder: name.slice(0, bracket), prefix: JSON.parse(name.slice(bracket + 1, -2)) as string }
  }
  const dot = name.lastIndexOf('.')
  return { holder: name.slice(0, dot), prefix: name.slice(dot + 1, -1) }
}

/** The recall units: each scoring group is one unit, and every other positive its own. */
function unitsOf(positives: readonly Positive[]): Positive[][] {
  const units = new Map<string, Positive[]>()
  for (const positive of positives) {
    const key = positive.group ?? `target:${positive.name}`
    units.set(key, [...(units.get(key) ?? []), positive])
  }
  return [...units.values()]
}

/**
 * A positive is recalled by a finding on its own target. A wildcard earns recall only for a scoring group it covers in
 * full, with the other findings (§20 True positives).
 */
function isRecalled(unit: readonly Positive[], findings: readonly FoundTarget[]): boolean {
  if (unit[0]!.group !== undefined) return unit.every((p) => findings.some((f) => matches(f, p)))
  return findings.some((f) => !isWildcard(f.name) && matches(f, unit[0]!))
}

/** A report's findings, by realm and target name. */
function foundTargets(report: ScanReport): Map<string, FoundTarget> {
  const found = new Map<string, FoundTarget>()
  for (const { target, effect, reachability, occurrences } of report.findings) {
    const key = `${target.realm}|${target.name}`
    const entry = found.get(key) ?? {
      realm: target.realm,
      name: target.name,
      ...(target.shadows === undefined ? {} : { shadows: target.shadows }),
      effects: [],
      reachability: [],
      absenceTested: [],
    }
    for (const occurrence of occurrences) {
      if (occurrence.reachability !== 'guarded-native-absence') continue
      for (const step of occurrence.trace) {
        if (step.kind === 'guard' && step.class === 'absence' && step.tested !== undefined) entry.absenceTested.push(step.tested)
      }
    }
    entry.absenceTested = [...new Set(entry.absenceTested)].sort()
    if (!entry.effects.includes(effect)) entry.effects.push(effect)
    if (reachability !== undefined && reachability !== null && !entry.reachability.includes(reachability)) entry.reachability.push(reachability)
    found.set(key, entry)
  }
  return found
}

function aggregate(all: readonly BuildScore[], adjudications: Record<string, Adjudication[]>) {
  const rows = all.filter((r) => !negatives.includes(r.build.library))
  const bundlers = [...new Set(rows.map((r) => r.build.bundler))].sort()
  const libraries: Record<string, LibraryScore> = {}
  for (const library of librariesOf(rows.map((r) => r.build))) {
    libraries[library] = libraryScore(rows.filter((r) => r.build.library === library), bundlers, adjudications[library] ?? [])
  }
  const negativeScores: Record<string, NegativeScore> = {}
  for (const library of librariesOf(all.map((r) => r.build)).filter((l) => negatives.includes(l))) {
    negativeScores[library] = negativeScore(all.filter((r) => r.build.library === library))
  }
  const scored = Object.values(libraries)
  return {
    macro: {
      precision: mean(scored.map((l) => l.precision)),
      precisionWithRelabels: mean(scored.map((l) => l.precisionWithRelabels)),
      minLibraryPrecisionWithRelabels: minimum(scored.map((l) => l.precisionWithRelabels)),
      relabels: scored.reduce((n, l) => n + l.relabels.length, 0),
      observedRecall: mean(scored.map((l) => l.observedRecall)),
      observedRecallByBundler: macroByBundler(scored, bundlers, 'observedRecallByBundler'),
      handLabeledRecall: mean(scored.map((l) => l.handLabeledRecall)),
      handLabeledRecallByBundler: macroByBundler(scored, bundlers, 'handLabeledRecallByBundler'),
      headline: mean(scored.map((l) => l.headline)),
      effectAccuracy: mean(scored.map((l) => l.effectAccuracy)),
      reachabilityAccuracy: mean(scored.map((l) => l.reachabilityAccuracy)),
    },
    micro: micro(rows.map((r) => r.counts)),
    libraries,
    negatives: negativeScores,
  }
}

type SliceScores = ReturnType<typeof aggregate>

type LibraryScore = ReturnType<typeof libraryScore>

function libraryScore(rows: readonly BuildScore[], bundlers: readonly string[], adjudications: readonly Adjudication[]) {
  const rate = (row: BuildScore, metric: keyof typeof rates) => rates[metric](row.counts)
  const byBundler = (metric: 'observedRecall' | 'handLabeledRecall') => {
    const means: Record<string, number | null> = {}
    for (const bundler of bundlers) {
      const own = rows.filter((r) => r.build.bundler === bundler)
      if (own.length) means[bundler] = mean(own.map((r) => rate(r, metric)))
    }
    return means
  }
  return {
    builds: rows.length,
    precision: mean(rows.map((r) => rate(r, 'precision'))),
    precisionWithRelabels: mean(rows.map((r) => rate(r, 'precisionWithRelabels'))),
    /**
     * The targets counted as relabels in some build, each once: true positives on a hand label alone, and adjudicated
     * false positives (these are also under `falsePositives`, with their class).
     */
    relabels: [...new Set(rows.flatMap((r) => r.relabeled))].sort(),
    observedRecall: mean(rows.map((r) => rate(r, 'observedRecall'))),
    observedRecallByBundler: byBundler('observedRecall'),
    handLabeledRecall: mean(rows.map((r) => rate(r, 'handLabeledRecall'))),
    handLabeledRecallByBundler: byBundler('handLabeledRecall'),
    headline: mean(rows.map((r) => rate(r, 'headline'))),
    effectAccuracy: mean(rows.map((r) => rate(r, 'effectAccuracy'))),
    reachabilityAccuracy: mean(rows.map((r) => rate(r, 'reachabilityAccuracy'))),
    falsePositives: disagreements(rows.flatMap((r) => r.falsePositives), adjudications, 'false-positive'),
    observedMisses: disagreements(rows.flatMap((r) => r.observedMisses), adjudications, 'false-negative'),
    handLabeledMisses: disagreements(rows.flatMap((r) => r.handLabeledMisses), adjudications, 'false-negative'),
    headlineMisses: countBy(rows.flatMap((r) => r.headlineMisses)),
    effectErrors: errorsOf(rows.map((r) => r.effectErrors)),
    reachabilityErrors: errorsOf(rows.map((r) => r.reachabilityErrors)),
    chromiumRuleViolations: violationsOf(rows),
  }
}

/** The rates of one build, from its counts. A rate is `null` when it has nothing to divide by. */
const rates = {
  precision: (c: Counts) => ratio(c.truePositives, c.findings),
  precisionWithRelabels: (c: Counts) => ratio(c.truePositives + c.relabeled, c.findings),
  observedRecall: (c: Counts) => ratio(c.observedHits, c.observedPositives),
  handLabeledRecall: (c: Counts) => ratio(c.handLabeledHits, c.handLabeledPositives),
  effectAccuracy: (c: Counts) => ratio(c.effectCorrect, c.effectScored),
  headline: (c: Counts) => ratio(c.headlineHits, c.headlineItems),
  reachabilityAccuracy: (c: Counts) => ratio(c.reachabilityCorrect, c.reachabilityScored),
}

/** Totals over every build of the libraries, for information (§20 Scoring unit). */
function micro(counts: readonly Counts[]) {
  const sum = (key: keyof Counts) => counts.reduce((n, c) => n + c[key], 0)
  const total = {
    findings: sum('findings'),
    truePositives: sum('truePositives'),
    relabeled: sum('relabeled'),
    observedPositives: sum('observedPositives'),
    observedHits: sum('observedHits'),
    handLabeledPositives: sum('handLabeledPositives'),
    handLabeledHits: sum('handLabeledHits'),
    effectScored: sum('effectScored'),
    effectCorrect: sum('effectCorrect'),
    headlineItems: sum('headlineItems'),
    headlineHits: sum('headlineHits'),
    reachabilityScored: sum('reachabilityScored'),
    reachabilityCorrect: sum('reachabilityCorrect'),
    chromiumRuleViolations: sum('chromiumRuleViolations'),
  }
  return {
    findings: total.findings,
    truePositives: total.truePositives,
    truePositivesWithRelabels: total.truePositives + total.relabeled,
    precision: rates.precision(total),
    precisionWithRelabels: rates.precisionWithRelabels(total),
    observedPositives: total.observedPositives,
    observedHits: total.observedHits,
    observedRecall: rates.observedRecall(total),
    handLabeledPositives: total.handLabeledPositives,
    handLabeledHits: total.handLabeledHits,
    handLabeledRecall: rates.handLabeledRecall(total),
    effectScored: total.effectScored,
    effectCorrect: total.effectCorrect,
    effectAccuracy: rates.effectAccuracy(total),
    reachabilityScored: total.reachabilityScored,
    reachabilityCorrect: total.reachabilityCorrect,
    reachabilityAccuracy: rates.reachabilityAccuracy(total),
    chromiumRuleViolations: total.chromiumRuleViolations,
  }
}

interface NegativeScore {
  builds: number
  /** Findings summed over its builds, counted by target. */
  findings: number
  /** Each target found, with the number of builds that find it; outside the window realm, as `<realm>:<target>`. */
  targets: Record<string, number>
}

/** A negative needs no ground truth, so its findings count in every realm (§20 Negatives: 0 protected findings). */
function negativeScore(rows: readonly BuildScore[]): NegativeScore {
  const found = rows.flatMap((r) => [...r.found, ...r.foundInOtherRealms])
  return { builds: rows.length, findings: found.length, targets: countBy(found) }
}

/**
 * The bars of §20, judged on the protected slice of the base builds. `met` is `null` when there is nothing to judge,
 * such as a precision with no findings.
 */
function judge(scores: SliceScores, invariance: IdentityInvariance) {
  const { macro } = scores
  const atLeast = (value: number | null, bar: number) => (value === null ? null : value >= bar)
  // The bar is judged in each bundler's builds (§20 Bars): a CDN site is no bundler's build, and its recall has no bar.
  const byBundler = Object.entries(macro.observedRecallByBundler)
    .filter(([bundler]) => bundler !== 'cdn')
    .map(([, v]) => v)
    .filter((v): v is number => v !== null)
  const negativeBuilds = Object.values(scores.negatives)
  const negativeFindings = negativeBuilds.reduce((n, l) => n + l.findings, 0)
  return {
    precision: {
      value: macro.precisionWithRelabels,
      minLibrary: macro.minLibraryPrecisionWithRelabels,
      met:
        macro.precisionWithRelabels === null
          ? null
          : macro.precisionWithRelabels >= bars.precision.macro &&
            (macro.minLibraryPrecisionWithRelabels ?? 1) >= bars.precision.library,
    },
    observedRecall: {
      byBundler: macro.observedRecallByBundler,
      met: byBundler.length ? byBundler.every((v) => v >= bars.observedRecall) : null,
    },
    handLabeledRecall: { value: macro.handLabeledRecall, met: atLeast(macro.handLabeledRecall, bars.handLabeledRecall) },
    headline: { value: macro.headline, met: atLeast(macro.headline, bars.headline) },
    effectAccuracy: { value: macro.effectAccuracy, met: atLeast(macro.effectAccuracy, bars.effectAccuracy) },
    reachabilityAccuracy: {
      value: macro.reachabilityAccuracy,
      met: atLeast(macro.reachabilityAccuracy, bars.reachabilityAccuracy),
    },
    negatives: { findings: negativeFindings, met: negativeBuilds.length ? negativeFindings === 0 : null },
    chromiumRule: { violations: scores.micro.chromiumRuleViolations, met: scores.micro.chromiumRuleViolations === 0 },
    identityInvariance: { failures: invariance.failures, met: invariance.pairs ? invariance.failures === 0 : null },
  }
}

/** A build's counts and rates on one slice. */
function buildSummary({ counts }: BuildScore) {
  return {
    ...counts,
    precision: rates.precision(counts),
    precisionWithRelabels: rates.precisionWithRelabels(counts),
    observedRecall: rates.observedRecall(counts),
    handLabeledRecall: rates.handLabeledRecall(counts),
    effectAccuracy: rates.effectAccuracy(counts),
    headline: rates.headline(counts),
    reachabilityAccuracy: rates.reachabilityAccuracy(counts),
  }
}

/** The scanner that made the reports. Every report must come from the same one. */
function toolOf(reports: readonly ScanReport[]): ScanReport['tool'] | null {
  const tools = [...new Set(reports.map((r) => JSON.stringify(r.tool)))]
  if (tools.length > 1) throw new Error(`the reports come from different scanners: ${tools.join(', ')}`)
  return reports[0]?.tool ?? null
}

interface TargetErrors {
  builds: number
  found: string[]
  expected: string[]
}

/** Each target with a wrong value: the builds that have it, the values they found, and the values expected. */
function errorsOf(perBuild: readonly (readonly { target: string; found: string[]; expected: string[] }[])[]): Record<string, TargetErrors> {
  const errors = perBuild.flat().sort((a, b) => compareStrings(a.target, b.target))
  const result: Record<string, TargetErrors> = {}
  for (const { target, found, expected } of errors) {
    const entry = result[target] ?? { builds: 0, found: [], expected }
    entry.builds += 1
    entry.found = [...new Set([...entry.found, ...found])].sort()
    entry.expected = [...new Set([...entry.expected, ...expected])].sort()
    result[target] = entry
  }
  return result
}

/** Each target that breaks the Chromium rule (§20): the builds that have it, and the natives its guards test. */
function violationsOf(rows: readonly BuildScore[]): Record<string, { builds: number; tested: string[] }> {
  const result: Record<string, { builds: number; tested: string[] }> = {}
  const violations = rows.flatMap((r) => r.chromiumRuleViolations).sort((a, b) => compareStrings(a.target, b.target))
  for (const { target, tested } of violations) {
    const entry = result[target] ?? { builds: 0, tested: [] }
    entry.builds += 1
    entry.tested = [...new Set([...entry.tested, ...tested])].sort()
    result[target] = entry
  }
  return result
}

/** Each disagreement's target, with the number of builds that have it and its triage class, if adjudicated. */
function disagreements(
  targets: readonly string[],
  adjudications: readonly Adjudication[],
  disagreement: Adjudication['disagreement'],
): Record<string, { builds: number; class: string | null }> {
  return Object.fromEntries(
    Object.entries(countBy(targets)).map(([target, builds]) => {
      const adjudication = adjudications.find((a) => a.target === target && a.disagreement === disagreement)
      return [target, { builds, class: adjudication?.class ?? null }]
    }),
  )
}

/** Per bundler, the mean over the libraries that have builds from it. */
function macroByBundler(
  libraries: readonly LibraryScore[],
  bundlers: readonly string[],
  metric: 'observedRecallByBundler' | 'handLabeledRecallByBundler',
): Record<string, number | null> {
  return Object.fromEntries(bundlers.map((bundler) => [bundler, mean(libraries.map((l) => l[metric][bundler] ?? null))]))
}

/**
 * Each library's bundled base builds (§20 Identity invariance): the 4 bundlers × maps/nomaps. CDN sites, variant builds
 * and the negatives are not in the pairs.
 */
function bundledBuilds(builds: readonly CorpusBuild[]): Map<string, CorpusBuild[]> {
  const byLibrary = new Map<string, CorpusBuild[]>()
  for (const build of builds) {
    if (build.set !== 'base' || build.bundler === 'static' || build.bundler === 'cdn' || negatives.includes(build.library)) continue
    byLibrary.set(build.library, [...(byLibrary.get(build.library) ?? []), build])
  }
  return byLibrary
}

function librariesOf(builds: readonly CorpusBuild[]): string[] {
  return [...new Set(builds.map((b) => b.library))].sort()
}

/** The corpus snapshots the window realm only (§20). */
function windowTarget({ name, shadows, effects }: Positive): SliceTarget {
  return { realm: 'window', name, ...(shadows === undefined ? {} : { shadows }), effects }
}

/** How often each value occurs, keyed in sorted order. */
function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of [...values].sort()) counts[value] = (counts[value] ?? 0) + 1
  return counts
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole
}

function mean(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null)
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null
}

function minimum(values: readonly (number | null)[]): number | null {
  const present = values.filter((v): v is number => v !== null)
  return present.length ? Math.min(...present) : null
}

export type { ReportedFinding, ScanReport } from './report.ts'

// The readable table of a scoring run, in Markdown. It shows the rates of the scores file, never anything else.

import { bars, type Scores } from './score.ts'

type SliceScores = Scores['protected']

export function renderTable(scores: Scores): string {
  const { tool } = scores
  const lines = [
    '# Accuracy scores',
    '',
    tool === null
      ? 'No builds scored.'
      : `monkeypatchlist ${tool.monkeypatchlistVersion} · catalog ${tool.catalogVersion} · analyzer ${tool.analyzerVersion} · ` +
        `fingerprint scheme ${tool.fingerprintScheme}`,
    '',
    '## Bars (protected surface, §20)',
    '',
    ...barsTable(scores),
    '',
    'Not scored here: holdout precision, the fixture pages and cost. Precision without relabels counts only ' +
      'runtime-confirmed true positives.',
    '',
    ...identityTable(scores),
    '',
    ...setInvarianceTable(scores),
    '',
    ...cdnTable(scores),
    '',
    ...varianceTable(scores),
    '',
    ...idiomTable(scores),
    '',
    '## Protected surface',
    '',
    ...sliceTables(scores.protected),
    '',
    '## Whole catalog (no bar)',
    '',
    ...sliceTables(scores.all),
  ]
  for (const [variant, slices] of Object.entries(scores.variants)) {
    lines.push('', `## Variant builds: ${variant} (no bar)`, '', '### Protected surface', '', ...sliceTables(slices.protected))
    lines.push('', '### Whole catalog', '', ...sliceTables(slices.all))
  }
  const excluded = Object.entries(scores.excludedPositives)
  if (excluded.length) {
    lines.push('', '## Mutations that are not catalog targets (not scored)', '')
    for (const [library, names] of excluded) lines.push(`- ${library}: ${names.map((n) => `\`${n}\``).join(', ')}`)
  }
  return `${lines.join('\n')}\n`
}

/** The idiom conformance summary (§6): which idioms each bundler's base builds and each CDN bundle link through. */
function idiomTable({ idioms }: Scores): string[] {
  return [
    '## Module-linking idioms (§6 conformance, no bar)',
    '',
    'Each idiom with the number of base builds whose artifacts link through it.',
    '',
    '| Bundler or CDN bundle | Builds | Idioms | Modules | Unlinked |',
    '|---|---|---|---|---|',
    ...Object.entries(idioms).map(([key, use]) => {
      const named = Object.entries(use.idioms).map(([idiom, builds]) => `${idiom} ${builds}`).join(' · ')
      return `| ${key} | ${use.builds} | ${named === '' ? 'none' : named} | ${use.modules} | ${use.unlinked} |`
    }),
  ]
}

function barsTable({ bars: judged }: Scores): string[] {
  const byBundler = Object.entries(judged.observedRecall.byBundler)
    .map(([bundler, value]) => `${bundler} ${rate(value)}`)
    .join(' · ')
  return [
    '| Metric | Bar | Value | Met |',
    '|---|---|---|---|',
    row(
      'Precision, macro, with relabels',
      `≥ ${bars.precision.macro}, no library below ${bars.precision.library}`,
      `${rate(judged.precision.value)} (lowest library ${rate(judged.precision.minLibrary)})`,
      met(judged.precision.met),
    ),
    row('Observed recall, macro', `≥ ${bars.observedRecall} in each bundler`, byBundler || '–', met(judged.observedRecall.met)),
    row(
      'Hand-labeled recall, macro',
      `≥ ${bars.handLabeledRecall}`,
      rate(judged.handLabeledRecall.value),
      met(judged.handLabeledRecall.met),
    ),
    row('Headline set', '100%', rate(judged.headline.value), met(judged.headline.met)),
    row(
      'Effect accuracy on true positives',
      `≥ ${bars.effectAccuracy}`,
      rate(judged.effectAccuracy.value),
      met(judged.effectAccuracy.met),
    ),
    row(
      'Reachability accuracy on true positives, per build',
      `≥ ${bars.reachabilityAccuracy}`,
      rate(judged.reachabilityAccuracy.value),
      met(judged.reachabilityAccuracy.met),
    ),
    row('Negatives', '0 protected findings', String(judged.negatives.findings), met(judged.negatives.met)),
    row('Chromium rule', 'no violation', String(judged.chromiumRule.violations), met(judged.chromiumRule.met)),
    row('Identity invariance', 'zero failures', String(judged.identityInvariance.failures), met(judged.identityInvariance.met)),
  ]
}

/** Every identity-invariance failure (§20), by library, pair and target, then the exempted cases §21 names. */
function identityTable({ identityInvariance: invariance }: Scores): string[] {
  const lines = ['## Identity invariance (protected surface, zero tolerance)', '']
  const exempted = Object.entries(invariance.exempted)
  const exemptedCount = exempted.reduce((n, [, list]) => n + list.length, 0)
  const note = exemptedCount ? `; ${exemptedCount} exempted as esbuild composed-map cases (§21 Attribution)` : ''
  lines.push(`${invariance.pairs} pairs of bundled builds compared; ${invariance.failures} failures${note}.`)
  const listed = (libraries: [string, Scores['identityInvariance']['libraries'][string]][]) => {
    lines.push('', '| Library | Pair | Target | Failure |', '|---|---|---|---|')
    for (const [library, failures] of libraries) {
      for (const failure of failures) {
        const target = failure.realm === 'window' ? failure.target : `${failure.realm}:${failure.target}`
        lines.push(row(library, failure.pair.join(' ↔ '), `\`${target}\``, described(failure)))
      }
    }
  }
  const libraries = Object.entries(invariance.libraries)
  if (libraries.length) listed(libraries)
  if (exempted.length) {
    lines.push('', '### Exempted: esbuild composed-map cases (§21 Attribution)')
    listed(exempted)
  }
  return lines
}

function described(failure: Scores['identityInvariance']['libraries'][string][number]): string {
  const code = (value: unknown) => `\`${String(value)}\``
  switch (failure.check) {
    case 'effect-locks': {
      const pairs = (list: typeof failure.first) => list.map((p) => `${p.effect}, locks ${String(p.locks)}`).join('; ')
      return `effect-locks: ${pairs(failure.first)} → ${pairs(failure.second)}`
    }
    case 'fingerprint':
      return `fingerprint: ${failure.first.map(code).join(', ')} → ${failure.second.map(code).join(', ')}`
    case 'changed':
      return `changed: ${failure.changedReasons.map((r) => `${r.reason} ${code(r.before)} → ${code(r.after)}`).join('; ')}`
  }
}

/** Set invariance on the protected surface (§20), with no bar: each target some bundled builds find and others miss. */
function setInvarianceTable({ setInvariance }: Scores): string[] {
  const lines = ['## Set invariance (protected surface, no bar)', '']
  const libraries = Object.entries(setInvariance.protected)
  if (!libraries.length) return [...lines, 'Every bundled build of each library finds the same targets.']
  lines.push('| Library | Target | Found by | Missed by |', '|---|---|---|---|')
  for (const [library, { targets }] of libraries) {
    for (const [target, { foundBy, missedBy }] of Object.entries(targets)) {
      lines.push(row(library, `\`${target}\``, foundBy.join(', '), missedBy.join(', ')))
    }
  }
  lines.push('', '| Library | Bundler | Targets its builds miss |', '|---|---|---|')
  for (const [library, { byBundler }] of libraries) {
    for (const [bundler, targets] of Object.entries(byBundler)) {
      lines.push(row(library, bundler, targets.map((t) => `\`${t}\``).join(', ')))
    }
  }
  return lines
}

/** The CDN ↔ bundled differences on the protected surface (§20), with no bar: each target a CDN site disagrees on. */
function cdnTable({ setInvariance }: Scores): string[] {
  const lines = ['## CDN ↔ bundled differences (protected surface, no bar)', '']
  const libraries = Object.entries(setInvariance.cdn.protected)
  if (!libraries.length) return [...lines, 'Each CDN site finds the same targets as every bundled build of its library.']
  lines.push('| Library | Target | Found by | Missed by |', '|---|---|---|---|')
  for (const [library, { targets }] of libraries) {
    for (const [target, { foundBy, missedBy }] of Object.entries(targets)) {
      lines.push(row(library, `\`${target}\``, foundBy.join(', '), missedBy.join(', ')))
    }
  }
  return lines
}

/** Reachability and install-context variance and basis moves on the protected surface (§20), with no bar. */
function varianceTable({ variance }: Scores): string[] {
  const lines = ['## Reachability and install-context variance, basis moves (protected surface, no bar)', '']
  const libraries = Object.entries(variance.protected)
  if (!libraries.length) return [...lines, 'No target varies between the bundled builds of its library.']
  lines.push('| Library | Target | Varies | Per build |', '|---|---|---|---|')
  for (const [library, targets] of libraries) {
    for (const [target, dimensions] of Object.entries(targets)) {
      for (const [dimension, perBuild] of Object.entries(dimensions)) {
        const values = Object.entries(perBuild).map(([build, value]) => `${build} ${value}`)
        lines.push(row(library, `\`${target}\``, dimension, values.join(', ')))
      }
    }
  }
  return lines
}

function sliceTables(scores: SliceScores): string[] {
  const bundlers = Object.keys(scores.macro.observedRecallByBundler)
  const header = ['Library', 'Builds', 'Precision', 'With relabels', 'Relabels', 'Observed recall', ...bundlers]
  header.push('Hand-labeled recall', 'Headline', 'Effect accuracy', 'Reachability accuracy')
  const lines = [row(...header), row('---', ...header.slice(1).map(() => '---:'))]
  for (const [library, l] of Object.entries(scores.libraries)) {
    lines.push(
      row(
        library,
        String(l.builds),
        rate(l.precision),
        rate(l.precisionWithRelabels),
        String(l.relabels.length),
        rate(l.observedRecall),
        ...bundlers.map((b) => rate(l.observedRecallByBundler[b] ?? null)),
        rate(l.handLabeledRecall),
        rate(l.headline),
        rate(l.effectAccuracy),
        rate(l.reachabilityAccuracy),
      ),
    )
  }
  const { macro, micro } = scores
  lines.push(
    row(
      '**macro**',
      '',
      rate(macro.precision),
      rate(macro.precisionWithRelabels),
      String(macro.relabels),
      rate(macro.observedRecall),
      ...bundlers.map((b) => rate(macro.observedRecallByBundler[b] ?? null)),
      rate(macro.handLabeledRecall),
      rate(macro.headline),
      rate(macro.effectAccuracy),
      rate(macro.reachabilityAccuracy),
    ),
    row(
      'micro (information)',
      '',
      rate(micro.precision),
      rate(micro.precisionWithRelabels),
      '',
      rate(micro.observedRecall),
      ...bundlers.map(() => ''),
      rate(micro.handLabeledRecall),
      '',
      rate(micro.effectAccuracy),
      rate(micro.reachabilityAccuracy),
    ),
  )
  const negatives = Object.entries(scores.negatives)
  if (negatives.length) {
    lines.push('', '| Negative | Builds | Findings | Targets |', '|---|---:|---:|---|')
    for (const [library, n] of negatives) {
      const targets = Object.entries(n.targets).map(([target, builds]) => `\`${target}\` ×${builds}`)
      lines.push(row(library, String(n.builds), String(n.findings), targets.join(', ')))
    }
  }
  return lines
}

function row(...cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

function rate(value: number | null): string {
  return value === null ? '–' : value.toFixed(3)
}

function met(value: boolean | null): string {
  return value === null ? 'n/a' : value ? 'yes' : '**no**'
}

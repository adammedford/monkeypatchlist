// Builds the public spec (docs/spec.md) from the working spec. Build-time only; never published.
//
// The working spec keeps the project's process record: provenance tags on each decision, links into the private
// issue tracker, ticket and pre-flight references and an amendment log. The public spec keeps every decision and drops
// that record. Rewrites that target one passage must match exactly once, so a change to the working spec that moves
// such a passage fails generation instead of leaking it; `leaks` then checks the result for anything left behind.

/** The inputs: the working spec's text and the file names under docs/adr/. */
export interface SpecInput {
  readonly source: string
  readonly adrFiles: readonly string[]
}

const banner = '<!-- Generated from the working spec by `npm run spec` (tools/spec-generator). Do not edit by hand. -->'

const intro = [
  'This is the design specification for monkeypatchlist Release 1 (R1): what a platform mutation is, how the scan finds,',
  'names, attributes and compares findings, what it reports it could not see, and the contracts of its output, CLI and',
  'modules. The domain vocabulary is in [CONTEXT.md](../CONTEXT.md). Decisions with lasting trade-offs are recorded as',
  '[architecture decision records](adr/), which the sections below link where they apply. A `§` reference names a',
  'section of this document.',
].join(' ')

/** One rewrite of a passage that appears exactly once in the working spec. */
interface Passage {
  readonly find: string
  readonly replace: string
}

// Passages that only the project's process record explains.
const passages: readonly Passage[] = [
  {
    find: 'The human set Principles 1–4 live on 2026-09-28, and Principle 5 in the second pre-flight ([pre-flight 2](../patchline-r1/preflight-2026-09-28.md#pre-flight-2)). ',
    replace: '',
  },
  { find: "or put to the human.", replace: 'or put to the maintainers.' },
  { find: ' (neither decides a test; once-flag added by the human, live, 2026-10-03)', replace: ' (neither decides a test)' },
  { find: ' An alias holds the same interface object (ticket 100).', replace: ' An alias holds the same interface object.' },
  { find: ' adds a `locks` reason as X65 says', replace: ' adds a `locks` reason' },
  { find: "`preservesOriginal` from the brief is folded into `wrap`.", replace: "The product brief's `preservesOriginal` is folded into `wrap`." },
  { find: "The brief's example shows", replace: "The product brief's example shows" },
  { find: "the brief's case", replace: "the product brief's case" },
  { find: "follow the brief's rule", replace: "follow the product brief's rule" },
  {
    find: 'the full list of finding diffs go to the human, who decides before',
    replace: 'the full list of finding diffs go to the maintainers, who decide before',
  },
  {
    find: ' The prototype resolver in the map\'s `prototypes/` is evidence only.',
    replace: ' The prototype resolver this spec was drafted against is evidence only.',
  },
  { find: ' It lives under `.scratch/platform-integrity-scanner/corpus/`.', replace: '' },
  {
    find: 'goes to the human live, with the findings it removes',
    replace: 'goes to the maintainers, with the findings it removes',
  },
  {
    find: 'goes to the human live, with the libraries it costs and the targets lost per bundler, and the human accepts it or reclassifies it',
    replace: 'goes to the maintainers, with the libraries it costs and the targets lost per bundler, and they accept it or reclassify it',
  },
  { find: 'The human freezes the resolver', replace: 'The maintainers freeze the resolver' },
]

/** The public spec for `input`. Throws when a passage rewrite no longer matches the working spec. */
export function publicSpec(input: SpecInput): string {
  const { source, adrFiles } = input
  const start = source.indexOf('\n## North star\n')
  if (!source.startsWith('# ') || start < 0) throw new Error('The working spec no longer starts with a title and ## North star.')
  const title = source.slice(0, source.indexOf('\n'))
  const preamble = source.slice(title.length, start)
  let body = source.slice(start + 1)

  for (const { find, replace } of passages) {
    const count = body.split(find).length - 1
    if (count !== 1) throw new Error(`A spec-generator rewrite matches ${count} times, not once: ${JSON.stringify(find)}`)
    body = body.replace(find, () => replace)
  }

  body = body
    // Provenance tags: `(human, live, <date>[, <question or ticket>])`.
    .replace(/ \([^()]*\bhuman, live, \d{4}-\d{2}-\d{2}[^()]*\)/g, '')
    // A bare question reference from the pre-flights: `(X61)`, `(X63–X65)`.
    .replace(/ \([XWQD]\d+(?:[–-][XWQD]?\d+)?\)/g, '')
    // A question reference beside a section reference: `(§21 Attribution, X133)`.
    .replace(/, [XWQD]\d+(?:[–-][XWQD]?\d+)?(?=\))/g, '')
    // ADRs sit next to the public spec.
    .replace(/\]\(\.\.\/\.\.\/docs\/adr\//g, '](adr/')

  return `${title}\n\n${banner}\n\n${intro}\n\n${sectionTable(preamble, body, adrFiles)}\n\n${body}`
}

/**
 * The working spec's status table as section → decision records, without its status and ticket columns. A section's
 * records are the ADRs its status row names and the ones its text links.
 */
function sectionTable(preamble: string, body: string, adrFiles: readonly string[]): string {
  const linked = new Map<string, string[]>()
  for (const section of body.split(/\n(?=## )/)) {
    const number = /^## (\d+)\./.exec(section)?.[1]
    if (number !== undefined) linked.set(number, [...section.matchAll(/\]\(adr\/(\d{4})-/g)].map((match) => match[1] ?? ''))
  }
  const rows = preamble.split('\n').filter((line) => /^\| \d+ \|/.test(line))
  if (rows.length === 0) throw new Error("The working spec's status table has no section rows.")
  const lines = ['| § | Section | Decision records |', '|---|---|---|']
  for (const row of rows) {
    const [number, section, , draftedFrom] = row.split('|').slice(1).map((cell) => cell.trim())
    if (number === undefined || section === undefined || draftedFrom === undefined)
      throw new Error(`Unexpected status-table row: ${row}`)
    const adrs = [...draftedFrom.matchAll(/ADRs? ((?:\d{4}(?:, | and )?)+)/g)].flatMap((match) =>
      (match[1] ?? '').split(/, | and /).filter(Boolean),
    )
    const ids = [...new Set([...adrs, ...(linked.get(number) ?? [])])].sort()
    const links = ids.map((id) => {
      const file = adrFiles.find((name) => name.startsWith(`${id}-`))
      if (file === undefined) throw new Error(`§${number} cites ADR ${id}, which docs/adr/ does not have.`)
      return `[${id}](adr/${file})`
    })
    lines.push(`| ${number} | ${section} | ${links.join(', ') || '—'} |`)
  }
  return lines.join('\n')
}

/**
 * What a public design document still carries from the private process record: links into `.scratch/` or
 * `docs/agents/`, provenance tags and, with `strict`, ticket, pre-flight, wayfinder-map and question references.
 * Links inside inline code are not links; every other check reads inline code too, since a private path or tag in
 * backticks leaks as surely as in prose. `adrFiles`, when given, also checks that every `adr/` link names an existing
 * record.
 */
export function leaks(text: string, options: { strict: boolean; adrFiles?: readonly string[] }): string[] {
  const problems: string[] = []
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const at = `line ${index + 1}`
    for (const match of line.replace(/`[^`]*`/g, '``').matchAll(/\]\(([^)\s]*)\)/g)) {
      const target = match[1] ?? ''
      if (/\.scratch\/|docs\/agents\/|(?:^|\/)AGENTS\.md|patchline-r1\/|(?:^|\/)issues\//.test(target))
        problems.push(`${at}: links into the private process record: ${target}`)
      const adr = /^(?:(?:\.\.\/)*(?:docs\/)?adr\/)?(\d{4}-[^#/]+\.md)/.exec(target)
      if (adr && options.adrFiles && !options.adrFiles.includes(adr[1] ?? ''))
        problems.push(`${at}: links to a missing decision record: ${target}`)
    }
    if (/\(human, (?:live|delegated)\b/.test(line)) problems.push(`${at}: carries a provenance tag`)
    if (options.strict) {
      const reference =
        /\b[Tt]ickets? \d+|\bpre-?flight|\bwayfinder\b|\bdrift[- ]check|\b[XWQD]\d+\b|\.scratch\b|\bthe human\b/.exec(
          line,
        )
      if (reference) problems.push(`${at}: refers to the private process record: "${reference[0]}"`)
    }
  })
  return problems
}

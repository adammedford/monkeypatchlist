// The snapshot form of a report (pure): the report `monkeypatchlist scan --json` prints, without its `run` block, and with
// `tool.monkeypatchlistVersion` cut to its release line, so that a patch release reproduces it byte for byte (§4).

/** A report the scanner printed that the check can't use. */
export class SnapshotError extends Error {}

/** A report in its snapshot form, and the monkeypatchlist version it came from. */
export interface Snapshot {
  text: string
  monkeypatchlistVersion: string
}

/**
 * The snapshot form of a report's JSON text. Every byte but the `run` block and the patch part of
 * `tool.monkeypatchlistVersion` is kept: the report must be in the form `monkeypatchlist` prints JSON in (2-space indent, trailing
 * newline), so that rendering it again changes nothing else.
 */
export function snapshotOf(reportText: string): Snapshot {
  const report = parse(reportText)
  if (render(report) !== reportText) throw new SnapshotError('the report is not in the form monkeypatchlist prints JSON in')
  const monkeypatchlistVersion = (report.tool as { monkeypatchlistVersion?: unknown } | undefined)?.monkeypatchlistVersion
  const line = releaseLine(monkeypatchlistVersion)
  // The report's own key order: `tool` keeps its place, and `monkeypatchlistVersion` its place within it.
  const entries = Object.entries(report)
    .filter(([key]) => key !== 'run')
    .map(([key, value]) => (key === 'tool' ? [key, { ...(value as object), monkeypatchlistVersion: line }] : [key, value]))
  return { text: render(Object.fromEntries(entries)), monkeypatchlistVersion: monkeypatchlistVersion as string }
}

/**
 * What differs between the committed snapshot and the reports a scan gave, both by path, as one message per path in
 * path order: a report that differs (from its first differing line), one the snapshot lacks, and a snapshot report
 * whose site is gone. None when every byte is the same.
 */
export function compareWithSnapshot(snapshot: ReadonlyMap<string, string>, reports: ReadonlyMap<string, string>): string[] {
  const paths = [...new Set([...snapshot.keys(), ...reports.keys()])].sort()
  return paths.flatMap((path) => {
    const expected = snapshot.get(path)
    const actual = reports.get(path)
    if (expected === undefined) return [`${path}: not in the snapshot`]
    if (actual === undefined) return [`${path}: no such site in the corpus`]
    const difference = firstDifference(expected, actual)
    if (difference === null) return []
    return [
      `${path}: differs from line ${difference.line}\n` +
        `      snapshot: ${quoteLine(difference.expected)}\n` +
        `      scan:     ${quoteLine(difference.actual)}`,
    ]
  })
}

/** A line of a report for a message: trimmed, and cut short. */
function quoteLine(line: string | null): string {
  if (line === null) return '(end of file)'
  const text = line.trim()
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/** Where two texts first differ: a 1-based line number, and that line in each (null past the end of one). */
export interface Difference {
  line: number
  expected: string | null
  actual: string | null
}

/** The first line on which `expected` and `actual` differ, or null when they are the same text. */
export function firstDifference(expected: string, actual: string): Difference | null {
  if (expected === actual) return null
  const want = expected.split('\n')
  const got = actual.split('\n')
  let index = 0
  while (index < want.length && index < got.length && want[index] === got[index]) index++
  return { line: index + 1, expected: want[index] ?? null, actual: got[index] ?? null }
}

/** `1.2` for monkeypatchlist `1.2.3` or `1.2.0-rc.1`: the minor release a patch release belongs to. */
export function releaseLine(monkeypatchlistVersion: unknown): string {
  const { major, minor } = semver(monkeypatchlistVersion)
  return `${major}.${minor}`
}

/** Whether monkeypatchlist `monkeypatchlistVersion` is a patch release: `1.2.3`, but not `1.2.0` or `1.2.0-rc.1`. */
export function isPatchRelease(monkeypatchlistVersion: string): boolean {
  return semver(monkeypatchlistVersion).patch !== '0'
}

/** The release line a snapshot report records in `tool.monkeypatchlistVersion`, or null when it records none. */
export function releaseLineOfSnapshot(text: string): string | null {
  try {
    const line = (JSON.parse(text) as { tool?: { monkeypatchlistVersion?: unknown } }).tool?.monkeypatchlistVersion
    return typeof line === 'string' ? line : null
  } catch {
    return null
  }
}

function semver(text: unknown): { major: string; minor: string; patch: string } {
  const match = typeof text === 'string' ? /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(text) : null
  if (match === null) throw new SnapshotError(`tool.monkeypatchlistVersion is not a semver version: ${JSON.stringify(text)}`)
  const [, major = '', minor = '', patch = ''] = match
  return { major, minor, patch }
}

function parse(text: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new SnapshotError(`the report is not JSON: ${(error as Error).message}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SnapshotError('the report is not a JSON object')
  }
  return value as Record<string, unknown>
}

function render(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

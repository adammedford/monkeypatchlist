// Version skew (§4 Version skew, ADR 0008): a baseline written by another monkeypatchlist version than the one scanning.

/** The versions a baseline's header records (§11 Baseline), or that a scan runs with (§15 `tool`). */
export interface Versions {
  formatVersion: number
  fingerprintScheme: number
  catalogVersion: number
  monkeypatchlistVersion: string
}

/** A version on each side: the baseline's, as its file was written, and the scan's. */
export interface VersionPair<Version> {
  baseline: Version
  scan: Version
}

/**
 * The scan-level note that the baseline was written by another version (§4 Version skew, §15 `baseline.notes`). It
 * names each version on both sides.
 */
export interface VersionSkew {
  kind: 'version-skew'
  /**
   * The side written by the newer version. `baseline` when any of the baseline's versions is newer than the scan's: a
   * stale install, which scans with a warning and no `explainedBy`, and which `baseline update` refuses to rewrite
   * without `--allow-downgrade`. Otherwise `scan`: an upgrade, where a delta without `explainedBy` may come from analyzer
   * changes.
   */
  newer: 'baseline' | 'scan'
  formatVersion: VersionPair<number>
  fingerprintScheme: VersionPair<number>
  catalogVersion: VersionPair<number>
  monkeypatchlistVersion: VersionPair<string>
}

/** A scan-level note on the baseline (§15 `baseline.notes`). */
export type BaselineNote = VersionSkew

/**
 * The version-skew note for a baseline written with the versions `baseline` and scanned with `scan`, or null when they
 * are all the same.
 */
export function versionSkew(baseline: Versions, scan: Versions): VersionSkew | null {
  const order = versionNames.map((name) => compare(name, baseline, scan))
  if (order.every((sign) => sign === 0)) return null
  return {
    kind: 'version-skew',
    newer: order.some((sign) => sign > 0) ? 'baseline' : 'scan',
    formatVersion: { baseline: baseline.formatVersion, scan: scan.formatVersion },
    fingerprintScheme: { baseline: baseline.fingerprintScheme, scan: scan.fingerprintScheme },
    catalogVersion: { baseline: baseline.catalogVersion, scan: scan.catalogVersion },
    monkeypatchlistVersion: { baseline: baseline.monkeypatchlistVersion, scan: scan.monkeypatchlistVersion },
  }
}

/** A version a baseline was written with that is newer than this monkeypatchlist's, with the version on each side. */
export type NewerVersion = {
  [Name in keyof Versions]: { name: Name } & VersionPair<Versions[Name]>
}[keyof Versions]

/**
 * The versions of `baseline`'s that are newer than this monkeypatchlist's (`scan`), in the order of the baseline header (§4
 * Version skew). A baseline with any was written by a newer monkeypatchlist or catalog: `baseline init` and `baseline update`
 * refuse to replace it unless `--allow-downgrade` is given. A version `baseline` lacks is not compared.
 */
export function newerVersions(baseline: Partial<Versions>, scan: Versions): NewerVersion[] {
  return versionNames.flatMap((name) => {
    if (baseline[name] === undefined || compare(name, baseline as Versions, scan) <= 0) return []
    return [{ name, baseline: baseline[name], scan: scan[name] } as NewerVersion]
  })
}

/** The versions, in the order of the baseline header (§11 Baseline). */
const versionNames = ['formatVersion', 'fingerprintScheme', 'catalogVersion', 'monkeypatchlistVersion'] as const

/** Orders one version of `a` against the same version of `b`: negative when `a`'s is older, positive when newer. */
function compare(name: keyof Versions, a: Versions, b: Versions): number {
  return name === 'monkeypatchlistVersion'
    ? compareVersions(a.monkeypatchlistVersion, b.monkeypatchlistVersion)
    : Math.sign(a[name] - b[name])
}

/** A semantic version: `major.minor.patch`, an optional `-prerelease` and optional `+build` metadata. */
export const semver =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

/**
 * Orders two monkeypatchlist versions by semantic-version precedence: negative when `a` is older, positive when it is newer,
 * 0 when they rank the same. Build metadata is ignored, and a prerelease ranks below its release.
 */
function compareVersions(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return Math.sign(x.core[i]! - y.core[i]!)
  // A release ranks above its prereleases.
  if (x.prerelease.length === 0 || y.prerelease.length === 0) {
    return Math.sign(y.prerelease.length) - Math.sign(x.prerelease.length)
  }
  for (let i = 0; i < Math.min(x.prerelease.length, y.prerelease.length); i++) {
    const order = compareIdentifiers(x.prerelease[i]!, y.prerelease[i]!)
    if (order !== 0) return order
  }
  return Math.sign(x.prerelease.length - y.prerelease.length)
}

function parse(version: string): { core: number[]; prerelease: string[] } {
  const match = semver.exec(version)
  if (match === null) throw new Error(`'${version}' is not a semantic version`)
  return { core: match.slice(1, 4).map(Number), prerelease: match[4]?.split('.') ?? [] }
}

/** Numeric identifiers rank by value and below alphanumeric ones, which rank by ASCII order. */
function compareIdentifiers(a: string, b: string): number {
  const numeric = (identifier: string) => /^\d+$/.test(identifier)
  if (numeric(a) && numeric(b)) return Math.sign(Number(a) - Number(b))
  if (numeric(a) !== numeric(b)) return numeric(a) ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

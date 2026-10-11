// Subresource Integrity (§17 Integrity): fetched bytes are checked against the integrity metadata their reference
// carries, as the SRI spec does it, and bytes that don't match are withheld.

import { createHash } from 'node:crypto'
import type { FetchedResponse, FetchResult, Sri, SriCheck } from '../index.ts'

/** The hash algorithms SRI supports (SRI § Cryptographic hash functions), from the weakest to the strongest. */
const algorithms = ['sha256', 'sha384', 'sha512'] as const

type Algorithm = (typeof algorithms)[number]

/**
 * The result of fetching `bytes` with the integrity metadata `integrity` (the empty string for none): `ok` with the
 * check, or `sri-mismatch` with it, and without the bytes, which are never analyzed (§17 Integrity).
 */
export function verified(bytes: Uint8Array, response: FetchedResponse, integrity: string): FetchResult {
  const sri = checkIntegrity(integrity, bytes)
  if (sri === 'none' || sri.result === 'match') return { status: 'ok', response, bytes, sri }
  const expected = sri.expected.join(' or ')
  const detail = `the fetched bytes' digest is ${sri.actual}, and the integrity value expects ${expected}`
  return { status: 'sri-mismatch', detail, response, sri }
}

/** Separates the alternatives of an integrity value (`alternativeIntegrity`): not ASCII whitespace, which separates tokens. */
const separator = '\u001f'

/**
 * One integrity value that stands for several (§17 Integrity): code sets an element's `integrity` to one of
 * several constants, and the bytes pass when they match any. A single value is returned as it is.
 */
export function alternativeIntegrity(values: readonly string[]): string {
  return values.join(separator)
}

/**
 * Checks `bytes` against an integrity value, which is integrity metadata or alternatives of it
 * (`alternativeIntegrity`). The bytes match when they match any alternative, and the check is that alternative's. When
 * none does, the check expects every alternative's digests, and `actual` is the bytes' digest in the strongest
 * algorithm any of them names. An alternative that checks nothing makes the value check nothing (`none`), as in a
 * browser.
 */
export function checkIntegrity(integrity: string, bytes: Uint8Array): Sri {
  const checks: SriCheck[] = []
  for (const alternative of integrity.split(separator)) {
    const check = checkMetadata(alternative, bytes)
    if (check === 'none') return 'none'
    if (check.result === 'match') return check
    checks.push(check)
  }
  if (checks.length === 1) return checks[0]!
  const algorithm = algorithms.findLast((candidate) => checks.some(({ actual }) => actual.startsWith(`${candidate}-`)))!
  const actual = checks.find((check) => check.actual.startsWith(`${algorithm}-`))!.actual
  return { result: 'mismatch', expected: checks.flatMap(({ expected }) => expected), actual }
}

/**
 * Checks `bytes` against integrity metadata (SRI § Does response match metadataList?). Only the digests in the
 * strongest algorithm the metadata names are compared, and the bytes match when any of them is their digest in that
 * algorithm, base64-encoded. Metadata that names no supported algorithm, the empty string included, checks nothing
 * (`none`), as in a browser.
 */
function checkMetadata(integrity: string, bytes: Uint8Array): Sri {
  const metadata = parseMetadata(integrity)
  if (metadata.length === 0) return 'none'
  // The strongest algorithm named (SRI § Get the strongest metadata). Spreading the metadata into `Math.max` would
  // overflow the stack on a long enough integrity value, which a page supplies.
  const named = new Set(metadata.map((item) => item.algorithm))
  const algorithm = algorithms.findLast((candidate) => named.has(candidate))!
  const strongest = metadata.filter((item) => item.algorithm === algorithm)
  const digest = createHash(algorithm).update(bytes).digest('base64')
  return {
    result: strongest.some(({ value }) => value === digest) ? 'match' : 'mismatch',
    expected: strongest.map(({ value }) => `${algorithm}-${value}`),
    actual: `${algorithm}-${digest}`,
  }
}

/**
 * Parses integrity metadata (SRI § Parse metadata): each token separated by ASCII whitespace is an algorithm and a
 * base64 value, joined by `-`, optionally followed by `?` and options, which are ignored. A token whose algorithm is
 * not a supported one, ignoring ASCII case, is skipped.
 */
function parseMetadata(integrity: string): { algorithm: Algorithm; value: string }[] {
  const metadata: { algorithm: Algorithm; value: string }[] = []
  for (const token of integrity.split(/[\t\n\f\r ]+/)) {
    const [name = '', value = ''] = token.split('?')[0]!.split('-')
    const algorithm = algorithms.find((supported) => supported === name.replace(/[A-Z]/g, (c) => c.toLowerCase()))
    if (algorithm !== undefined) metadata.push({ algorithm, value })
  }
  return metadata
}

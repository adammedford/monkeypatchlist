import type { RemoteUrlNormalization } from '../../src/catalog.ts'

/**
 * The remote URL normalization overlay (§11 Remote URL normalization) as the catalog carries it. Refuses one that is
 * malformed, or whose path patterns don't compile, so a broken rule fails generation rather than a scan.
 */
export function remoteUrlNormalizationOverlay(json: unknown, file: string): RemoteUrlNormalization {
  const fail = (why: string): never => {
    throw new Error(
      `${file}: ${why}. It needs scheme { from: [scheme], to: scheme }, host "lowercase", drop (some of ` +
        '"default-port", "query", "fragment") and path: [{ id, step (3 or 4), pattern, replacement }]',
    )
  }
  const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
  const text = (value: unknown): value is string => typeof value === 'string' && value !== ''
  if (!isObject(json)) return fail('it is not an object')
  const { scheme, host, drop, path, ...rest } = json
  if (Object.keys(rest).length) fail(`it has unknown keys ${Object.keys(rest).join(', ')}`)
  if (!isObject(scheme) || !Array.isArray(scheme.from) || !scheme.from.every(text) || !text(scheme.to)) {
    fail('its scheme is malformed')
  }
  if (host !== 'lowercase') fail('its host is not "lowercase"')
  const drops = ['default-port', 'query', 'fragment']
  if (!Array.isArray(drop) || !drop.every((each) => drops.includes(each))) fail('its drop is malformed')
  if (!Array.isArray(path)) return fail('its path is not a list')
  for (const rule of path) {
    if (!isObject(rule)) return fail('a path rule is not an object')
    const { id, step, pattern, replacement, ...more } = rule
    if (!text(id) || (step !== 3 && step !== 4) || !text(pattern) || typeof replacement !== 'string') {
      fail(`path rule ${String(id)} is malformed`)
    }
    if (Object.keys(more).length) fail(`path rule ${String(id)} has unknown keys`)
    try {
      new RegExp(pattern as string, 'gu')
    } catch (error) {
      fail(`path rule ${String(id)}'s pattern doesn't compile: ${(error as Error).message}`)
    }
  }
  return structuredClone(json) as unknown as RemoteUrlNormalization
}

/** No rules: a generation without the overlay leaves every remote URL as it is. */
export const noNormalization: RemoteUrlNormalization = { scheme: { from: [], to: 'https:' }, host: 'lowercase', drop: [], path: [] }

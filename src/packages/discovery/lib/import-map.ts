// Import maps (HTML § Import maps): parsing, merging, module specifier resolution and module integrity metadata, as a
// current browser does them.

/**
 * A specifier map: each specifier key with the URL it maps to, or null when the entry is invalid and blocks the
 * specifier, in the order resolution tries them. One import map's keys are sorted in descending code unit order, so
 * that a longer prefix key is tried before a shorter one. A merge appends a later map's keys without sorting again.
 */
type SpecifierMap = [key: string, address: URL | null][]

/**
 * An import map: its top-level `imports`, its `scopes`, each a scope prefix URL with its specifier map, and its
 * `integrity`, the integrity metadata of each module URL it names (§17 Integrity).
 */
export interface ImportMap {
  imports: SpecifierMap
  scopes: [prefix: string, imports: SpecifierMap][]
  integrity: ReadonlyMap<string, string>
}

/**
 * A specifier resolution record (HTML § Resolved module set): a module specifier that resolved through a document's
 * import maps, from a script whose base URL is `base` (serialized), as `specifier` (the specifier's URL, serialized,
 * when it is URL-like) and `asUrl` (that URL, or null for a bare specifier). A later import map's rules that would
 * change its resolution are dropped when they merge (`mergeImportMaps`).
 */
export interface ResolvedModule {
  base: string
  specifier: string
  asUrl: URL | null
}

/** The empty import map a document starts with. */
export const emptyImportMap: ImportMap = { imports: [], scopes: [], integrity: new Map() }

/**
 * Parses the text of a `<script type=importmap>` (HTML § Parse an import map string), with addresses and scope
 * prefixes resolved against `base`, the document's base URL. Null when the browser rejects the whole map: text that is
 * not JSON, a map that is not a JSON object, or `imports`, `scopes` (or a scope's map) or `integrity` that is not one.
 */
export function parseImportMap(text: string, base: string): ImportMap | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!isObject(parsed)) return null
  const { imports = {}, scopes = {}, integrity = {} } = parsed
  if (!isObject(imports) || !isObject(scopes) || !Object.values(scopes).every(isObject)) return null
  if (!isObject(integrity)) return null
  const normalizedScopes: ImportMap['scopes'] = []
  for (const [prefix, map] of Object.entries(scopes)) {
    const url = URL.parse(prefix, base)
    if (url !== null) normalizedScopes.push([url.href, specifierMap(map as Record<string, unknown>, base)])
  }
  const normalizedIntegrity = integrityMap(integrity, base)
  return { imports: specifierMap(imports, base), scopes: sorted(normalizedScopes), integrity: normalizedIntegrity }
}

/**
 * HTML § Normalize a module integrity map: each key is a URL-like specifier, resolved against `base`, whose value is a
 * string. A bare key, and a value that is not a string, are dropped.
 */
function integrityMap(map: Record<string, unknown>, base: string): Map<string, string> {
  const normalized = new Map<string, string>()
  for (const [key, value] of Object.entries(map)) {
    const url = resolveUrlLike(key, base)
    if (url !== null && typeof value === 'string') normalized.set(url.href, value)
  }
  return normalized
}

/**
 * The integrity metadata an import map gives the module at `url` (HTML § Resolve a module integrity metadata), or the
 * empty string when it gives none.
 */
export function moduleIntegrity(map: ImportMap, url: URL): string {
  return map.integrity.get(url.href) ?? ''
}

/**
 * Merges a document's next import map into the one it has (HTML § Merge existing and new import maps), given the
 * specifiers the document has resolved so far (`resolved`):
 *
 * - A rule of the new map that could change an already resolved specifier is dropped: a key equal to the specifier, or
 *   a prefix key of it (`impacts`). In a scope, only the records whose base URL the scope applies to count. At the top
 *   level every record counts, as in the standard's example and Chromium, rather than the standard's step, which drops
 *   a key that starts with the specifier (§2 Import maps).
 * - An entry for a specifier key the existing map already has, at the top level or in the same scope, is dropped, and
 *   so is an integrity entry for a URL it already has, so the first definition wins.
 * - The new map's other keys, and its new scopes, come after the existing ones, and nothing is sorted again: an
 *   earlier map's shorter prefix key, or its less specific scope, is still tried before a later map's longer one.
 */
export function mergeImportMaps(
  existing: ImportMap,
  next: ImportMap,
  resolved: readonly ResolvedModule[],
): ImportMap {
  const scopes = new Map(existing.scopes)
  for (const [prefix, map] of next.scopes) {
    const applies = resolved.filter(({ base }) => scopeApplies(prefix, base))
    const imports = map.filter(([key]) => !applies.some((record) => impacts(key, record)))
    scopes.set(prefix, merged(scopes.get(prefix) ?? [], imports))
  }
  const integrity = new Map([...next.integrity, ...existing.integrity])
  const imports = next.imports.filter(([key]) => !resolved.some((record) => impacts(key, record)))
  return { imports: merged(existing.imports, imports), scopes: [...scopes], integrity }
}

/**
 * Whether a specifier key would change how a resolved specifier resolves (HTML § Merge existing and new import maps,
 * the scope step's test): it is the specifier, or a prefix key of it.
 */
function impacts(key: string, { specifier, asUrl }: ResolvedModule): boolean {
  return key === specifier || isPrefixKeyOf(key, specifier, asUrl)
}

/**
 * Whether `key` is a prefix key that matches the normalized specifier (HTML § Resolve an imports match): it ends in
 * `/`, the specifier starts with it, and the specifier is bare or a URL with a special scheme.
 */
function isPrefixKeyOf(key: string, normalized: string, asUrl: URL | null): boolean {
  return key.endsWith('/') && normalized.startsWith(key) && (asUrl === null || isSpecial(asUrl))
}

/** Whether a scope applies to a script whose base URL is `base`: its prefix is `base`, or a path prefix of it. */
function scopeApplies(prefix: string, base: string): boolean {
  return prefix === base || (prefix.endsWith('/') && base.startsWith(prefix))
}

/**
 * Resolves a module specifier through an import map (HTML § Resolve a module specifier), for a script whose base URL
 * is `base`: its own URL, or for an inline script, its document's. Scopes whose prefix is `base`, or a path prefix of
 * it, are tried in the map's order, then the top-level imports, and a URL-like specifier no entry maps is its URL. The
 * resolution's record is what the document adds to its resolved module set (HTML § Add module to resolved module set).
 * Otherwise the browser throws a TypeError, and this gives why: a bare specifier no entry maps, an entry that blocks
 * it, or a prefix entry the rest of the specifier would climb out of.
 */
export function resolveSpecifier(
  map: ImportMap,
  specifier: string,
  base: string,
): { url: URL; record: ResolvedModule } | { error: string } {
  const asUrl = resolveUrlLike(specifier, base)
  const normalized = asUrl?.href ?? specifier
  const record = { base, specifier: normalized, asUrl }
  let match: { url: URL } | { error: string } | null = null
  for (const [prefix, imports] of map.scopes) {
    if (scopeApplies(prefix, base)) {
      match = importsMatch(normalized, asUrl, imports)
      if (match !== null) break
    }
  }
  match ??= importsMatch(normalized, asUrl, map.imports) ?? (asUrl === null ? null : { url: asUrl })
  if (match === null) return { error: `the bare specifier ${JSON.stringify(specifier)} is mapped by no import map` }
  return 'error' in match ? match : { url: match.url, record }
}

/** HTML § Resolve an imports match: an exact key, or a prefix key ending in `/`. Null when no key matches. */
function importsMatch(
  normalized: string,
  asUrl: URL | null,
  imports: SpecifierMap,
): { url: URL } | { error: string } | null {
  const blocked = { error: `an import map entry blocks the specifier ${JSON.stringify(normalized)}` }
  for (const [key, address] of imports) {
    if (key === normalized) return address === null ? blocked : { url: address }
    if (isPrefixKeyOf(key, normalized, asUrl)) {
      if (address === null) return blocked
      const url = URL.parse(normalized.slice(key.length), address.href)
      if (url === null || !url.href.startsWith(address.href)) {
        return { error: `the specifier ${JSON.stringify(normalized)} leaves the prefix its import map entry maps` }
      }
      return { url }
    }
  }
  return null
}

/**
 * HTML § Resolve a URL-like module specifier: one that starts with `/`, `./` or `../` is relative to `base`, and any
 * other must be an absolute URL. Null for a bare specifier.
 */
function resolveUrlLike(specifier: string, base: string): URL | null {
  if (specifier.startsWith('/') || specifier.startsWith('./') || specifier.startsWith('../')) {
    return URL.parse(specifier, base)
  }
  return URL.parse(specifier)
}

/**
 * HTML § Sort and normalize a module specifier map. An empty key is dropped, and a URL-like key becomes its URL. An
 * entry is null when its address is not a string, not URL-like, or doesn't end in `/` when its key does.
 */
function specifierMap(map: Record<string, unknown>, base: string): SpecifierMap {
  const entries = new Map<string, URL | null>()
  for (const [key, value] of Object.entries(map)) {
    if (key === '') continue
    const normalizedKey = resolveUrlLike(key, base)?.href ?? key
    const address = typeof value === 'string' ? resolveUrlLike(value, base) : null
    entries.set(normalizedKey, address !== null && key.endsWith('/') && !address.href.endsWith('/') ? null : address)
  }
  return sorted([...entries])
}

/** HTML § Merge module specifier maps: the existing map, then each new key it doesn't have, in the new map's order. */
function merged(existing: SpecifierMap, next: SpecifierMap): SpecifierMap {
  const keys = new Set(existing.map(([key]) => key))
  return [...existing, ...next.filter(([key]) => !keys.has(key))]
}

/** Entries in descending code unit order of their keys. */
function sorted<Value>(entries: [string, Value][]): [string, Value][] {
  return entries.sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
}

/** Whether a URL's scheme is special (URL Standard): `ftp`, `file`, `http`, `https`, `ws` or `wss`. */
function isSpecial(url: URL): boolean {
  return ['ftp:', 'file:', 'http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)
}

/** A JSON object: what the import map algorithms call an ordered map. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

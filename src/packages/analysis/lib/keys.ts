// Property keys (§4 Property keys): what a constant key names, as ECMA-262 ToPropertyKey converts it, and how a target
// name spells a member.
//
// - A number, boolean, null or undefined key names its string, so `0` and `"0"` both name `Array.prototype.0`, and a
//   numeric member uses its canonical string (`1e21` names `1e+21`).
// - A well-known symbol (`Symbol.iterator`) is a constant of its own, and names the catalog's `@@` member
//   (`Array.prototype.@@iterator`). The analyzer knows no other symbol.
// - A string key never spells another target's name: one that could is written in JSON-quoted brackets
//   (`X.prototype["@@toStringTag"]`, `Array["prototype.map"]`, `console["*"]`).

/**
 * A property key the analyzer knows: a string, or one of the well-known symbols, which are real symbols here so that
 * they compare, convert and test as JavaScript's own do (`typeof`, `===`, truthiness).
 */
export type Key = string | symbol

/** The well-known symbols, one per name, so that the same symbol is the same value wherever it is read. */
const symbols = new Map<string, symbol>()
/** Each well-known symbol's member spelling in the catalog: `@@iterator`. */
const spellings = new Map<symbol, string>()

/** The well-known symbol ECMA-262 names `Symbol.<name>` (`%Symbol.iterator%`), e.g. `iterator`. */
export function wellKnownSymbol(name: string): symbol {
  let symbol = symbols.get(name)
  if (symbol === undefined) {
    symbol = Symbol(`Symbol.${name}`)
    symbols.set(name, symbol)
    spellings.set(symbol, `@@${name}`)
  }
  return symbol
}

/** How the catalog spells a well-known symbol as a member: `@@iterator`. */
export function symbolMember(symbol: symbol): string {
  const spelling = spellings.get(symbol)
  if (spelling === undefined) throw new Error(`${String(symbol)} is no well-known symbol`)
  return spelling
}

/** ECMA-262 ToPropertyKey of a primitive constant: a well-known symbol is itself, and anything else its string. */
export function toPropertyKey(value: string | number | bigint | boolean | null | undefined | symbol): Key {
  return typeof value === 'symbol' ? value : String(value)
}

/**
 * The key a literal property name gives in an object literal or pattern (`{ "a": x }`, `{ 1e21: x }`, `{ 1n: x }`), as
 * ECMA-262 PropertyDefinitionEvaluation converts it: a string, or a number's or BigInt's string. Undefined for any
 * other node.
 */
export function literalKey(node: { type: string; [field: string]: unknown }): string | undefined {
  if (node.type !== 'Literal') return undefined
  if (typeof node['bigint'] === 'string') return String(BigInt(node['bigint']))
  const value = node['value']
  return typeof value === 'string' || typeof value === 'number' ? String(value) : undefined
}

/**
 * The name of the member `key` of `holder`: `Array.prototype.map`, `Array.prototype.0`, `Array.prototype.@@iterator`,
 * `Array["prototype.map"]`.
 */
export function memberName(holder: string, key: Key): string {
  if (typeof key === 'symbol') return `${holder}.${symbolMember(key)}`
  return escaped(key) ? `${holder}[${JSON.stringify(key)}]` : `${holder}.${key}`
}

/**
 * Whether a string key is written in brackets (§4): one that starts with `@@` (a symbol member's spelling), contains
 * `.`, `[`, `]`, `"`, `\` or a control character (Unicode's `Cc`), or ends with `*` (a wildcard's spelling). A
 * canonical numeric key keeps the dot form (`Array.prototype.1.5`), and so do the catalog's names, none of which is one
 * of these.
 */
function escaped(key: string): boolean {
  if (isCanonicalNumeric(key)) return false
  return key.startsWith('@@') || key.endsWith('*') || /[.[\]"\\\p{Cc}]/u.test(key)
}

/** ECMA-262 CanonicalNumericIndexString: a key that is the string of a number, as `"1.5"` is and `"1.50"` is not. */
function isCanonicalNumeric(key: string): boolean {
  return key === '-0' || String(Number(key)) === key
}

/**
 * The name of a pattern wildcard (§5 Pattern wildcards): the members of `holder` whose key starts with `prefix`,
 * `EventTarget.prototype.__zone_symbol__*`. A prefix holding a character §4 writes in brackets (`.`, `[`, `]`, `"`,
 * `\`, a control character, a leading `@@`, or a `*` anywhere) is JSON-quoted in brackets with the star outside,
 * `Object.prototype["__core.hidden."]*`, so it never spells a named member (`Object.prototype["__core.hidden.*"]`) or a
 * nested name.
 */
export function patternName(holder: string, prefix: string): string {
  const bracketed = prefix.startsWith('@@') || prefix.includes('*') || /[.[\]"\\\p{Cc}]/u.test(prefix)
  return bracketed ? `${holder}[${JSON.stringify(prefix)}]*` : `${holder}.${prefix}*`
}

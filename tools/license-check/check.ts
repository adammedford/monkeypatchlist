// The dependency-license check. It reads package-lock.json and judges the license of every package a
// production install brings in (every lockfile entry not marked `dev`), against the licenses compatible with shipping
// monkeypatchlist under Apache-2.0. Build-time only; never published.

/** The SPDX licenses a runtime dependency may carry: permissive, and compatible with Apache-2.0. */
export const compatibleLicenses: ReadonlySet<string> = new Set([
  '0BSD',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'CC0-1.0',
  'ISC',
  'MIT',
  'Unlicense',
])

/** The parts of a package-lock.json (lockfileVersion 2 or 3) the check reads. */
export interface Lockfile {
  packages: Readonly<Record<string, { version?: string; license?: string; dev?: boolean }>>
}

export interface PackageLicense {
  name: string
  version: string
  license: string
  compatible: boolean
}

/**
 * Every runtime package in the lockfile with its license, sorted by name. The root entry is left out. An SPDX `OR`
 * expression is compatible when any of its choices is, an `AND` expression when all of its parts are.
 */
export function runtimeLicenses(lock: Lockfile): PackageLicense[] {
  const found: PackageLicense[] = []
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (path === '' || entry.dev === true) continue
    const license = entry.license ?? 'UNKNOWN'
    found.push({
      name: path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length),
      version: entry.version ?? '?',
      license,
      compatible: isCompatible(license),
    })
  }
  return found.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

function isCompatible(expression: string): boolean {
  const bare = stripOuterParens(expression.trim())
  const choices = splitTopLevel(bare, ' OR ')
  if (choices.length > 1) return choices.some(isCompatible)
  const parts = splitTopLevel(bare, ' AND ')
  if (parts.length > 1) return parts.every(isCompatible)
  return compatibleLicenses.has(bare)
}

/** Drops one pair of parentheses that wraps the whole expression, and only such a pair. */
function stripOuterParens(expression: string): string {
  if (!expression.startsWith('(') || !expression.endsWith(')')) return expression
  let depth = 0
  for (let i = 0; i < expression.length - 1; i++) {
    if (expression[i] === '(') depth++
    else if (expression[i] === ')') depth--
    if (depth === 0) return expression
  }
  return stripOuterParens(expression.slice(1, -1).trim())
}

/** Splits on `operator` outside parentheses, so `(A OR B) AND C` splits on AND only. */
function splitTopLevel(expression: string, operator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === '(') depth++
    else if (expression[i] === ')') depth--
    else if (depth === 0 && expression.startsWith(operator, i)) {
      parts.push(expression.slice(start, i))
      start = i + operator.length
    }
  }
  parts.push(expression.slice(start))
  return parts
}

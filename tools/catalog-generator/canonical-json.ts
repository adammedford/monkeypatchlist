/**
 * Serializes JSON data with every object's keys in UTF-16 code-unit order, two-space indentation and a final
 * newline, so the same data always gives the same bytes. It writes keys itself rather than trusting property
 * enumeration order, which puts integer-like keys first.
 */
export function canonicalJson(value: unknown): string {
  return write(value, '') + '\n'
}

function write(value: unknown, indent: string): string {
  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    return `[\n${value.map((item) => inner + write(item ?? null, inner)).join(',\n')}\n${indent}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    if (entries.length === 0) return '{}'
    return `{\n${entries.map(([key, item]) => `${inner}${JSON.stringify(key)}: ${write(item, inner)}`).join(',\n')}\n${indent}}`
  }
  return JSON.stringify(value)
}

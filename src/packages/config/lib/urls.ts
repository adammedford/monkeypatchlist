/** The canonical form of an absolute `http:` or `https:` URL, or why `value` is not one. */
export function httpUrl(value: string): { href: string } | { problem: string } {
  const url = URL.parse(value)
  if (url === null) return { problem: `'${value}' is not an absolute URL` }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { problem: `'${value}' is not an http: or https: URL` }
  return { href: url.href }
}

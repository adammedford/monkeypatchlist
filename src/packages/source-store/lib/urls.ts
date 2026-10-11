// The parts of a URL a request is made from.

/** The URL's host, without the brackets of an IPv6 literal. */
export function hostOf(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1')
}

/** The URL's port, or its scheme's default. */
export function portOf(url: URL): number {
  return url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
}

/** The URL without its fragment, which is never part of a request. */
export function withoutFragment(url: URL): URL {
  const copy = new URL(url)
  copy.hash = ''
  return copy
}

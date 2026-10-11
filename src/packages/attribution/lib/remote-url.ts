import type { RemoteUrlNormalization } from '../../../catalog.ts'

/** The default port of each scheme a remote script is fetched over (URL § Special schemes). */
const defaultPorts: Readonly<Record<string, string>> = { 'http:': '80', 'https:': '443' }

/**
 * Normalizes a remote artifact's URL, as referenced, by the catalog's rules (§11 Remote URL normalization): its scheme
 * (step 1), then its host, port, query and fragment (step 2), then each rewrite of its path, in order (steps 3 and 4).
 * The path rules see the path only, so hosts are kept.
 */
export function normalizeRemoteUrl(href: string, rules: RemoteUrlNormalization): string {
  const url = new URL(href)
  if (rules.scheme.from.includes(url.protocol)) url.protocol = rules.scheme.to
  url.hostname = url.hostname.toLowerCase()
  if (rules.drop.includes('default-port') && url.port === defaultPorts[url.protocol]) url.port = ''
  if (rules.drop.includes('query')) url.search = ''
  if (rules.drop.includes('fragment')) url.hash = ''
  const { pathname, search, hash } = url
  const origin = url.href.slice(0, url.href.length - pathname.length - search.length - hash.length)
  // The path is rewritten as a string: the URL setters would percent-encode the `#` a hex run becomes.
  const path = rules.path.reduce(
    (rewritten, { pattern, replacement }) => rewritten.replace(new RegExp(pattern, 'gu'), replacement),
    pathname,
  )
  return `${origin}${path}${search}${hash}`
}

// The proxy the floor honours (§17 Safety floor: Proxies): `HTTPS_PROXY`, except for the hosts `NO_PROXY` names.

import { Failure } from './outcomes.ts'
import { hostOf, portOf } from './urls.ts'

/** A proxy to tunnel a request through: its URL, and the `Proxy-Authorization` its credentials give. */
export interface Proxy {
  url: URL
  authorization: string | null
}

/**
 * The proxy for `url`, from the environment, or null to connect directly. Only `https:` is proxied, through
 * `HTTPS_PROXY` (or `https_proxy`), and not to a host `NO_PROXY` (or `no_proxy`) names. The credentials sent to it are
 * the ones in its URL, and no others.
 */
export function proxyFor(url: URL, env: Readonly<Record<string, string | undefined>>): Proxy | null {
  if (url.protocol !== 'https:') return null
  const setting = (env.HTTPS_PROXY ?? env.https_proxy ?? '').trim()
  if (setting === '' || bypasses(url, env.NO_PROXY ?? env.no_proxy ?? '')) return null
  const proxy = URL.parse(/^[a-z][a-z\d+.-]*:\/\//i.test(setting) ? setting : `http://${setting}`)
  if (proxy === null || (proxy.protocol !== 'http:' && proxy.protocol !== 'https:')) {
    throw new Failure(`HTTPS_PROXY is not an http: or https: proxy URL: ${setting}`)
  }
  if (proxy.username === '') return { url: proxy, authorization: null }
  let credentials: string
  try {
    credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
  } catch {
    throw new Failure("HTTPS_PROXY's credentials are not well-formed percent-encoding")
  }
  return { url: proxy, authorization: `Basic ${Buffer.from(credentials).toString('base64')}` }
}

/**
 * Whether `NO_PROXY` names the URL's host: `*`, the host itself, or a domain it is in (`example.com` or `.example.com`
 * for `cdn.example.com`), with or without a port, ignoring case.
 */
function bypasses(url: URL, noProxy: string): boolean {
  const host = hostOf(url).toLowerCase()
  const port = portOf(url)
  return noProxy
    .split(/[\s,]+/)
    .filter((entry) => entry !== '')
    .some((entry) => {
      if (entry === '*') return true
      const lower = entry.toLowerCase()
      // A host, `[IPv6]` or an IPv6 address, then an optional port.
      const bracketed = /^\[(.*)\](?::(\d+))?$/.exec(lower)
      const parts = lower.split(':')
      const [named = '', entryPort] = bracketed !== null ? bracketed.slice(1) : parts.length === 2 ? parts : [lower]
      if (entryPort !== undefined && Number(entryPort) !== port) return false
      const name = named.replace(/^\*?\./, '')
      return name !== '' && (host === name || host.endsWith(`.${name}`))
    })
}

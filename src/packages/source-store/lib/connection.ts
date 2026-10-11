// Opening the connection for one request (§17 Safety floor): the address check, the proxy tunnel, and verified TLS.

import { request as httpRequest } from 'node:http'
import { isIP, isIPv6 } from 'node:net'
import type { Duplex } from 'node:stream'
import { connect as tlsConnect } from 'node:tls'
import type { ResolvedAddress } from '../resolve.ts'
import { refusedAddress } from './addresses.ts'
import type { Sockets } from './deadline.ts'
import { Failure, reason, Refusal } from './outcomes.ts'
import { proxyFor } from './proxy.ts'
import type { SessionOptions } from './session.ts'
import { hostOf, portOf } from './urls.ts'

type ConnectionOptions = Pick<SessionOptions, 'lookup' | 'connect' | 'ca' | 'env'>

/**
 * Opens a connection to the URL's host: a TCP connection, with verified TLS over it for `https:`. The host's addresses
 * are resolved once, here, and checked (§17 Addresses): the floor refuses a host when any of them is refused, and
 * connects only to an address it has checked, so a second answer from DNS never reaches a connection (DNS rebinding).
 *
 * Through a proxy (§17 Proxies), the proxy connects to the host, and resolves it. The floor still refuses an IP-literal
 * host in a refused range, and a host that resolves here to a refused address; a host that doesn't resolve here is
 * left to the proxy. TLS runs to the host itself, through the tunnel, and is verified as without one.
 */
export async function open(url: URL, options: ConnectionOptions, sockets: Sockets): Promise<Duplex> {
  const host = hostOf(url)
  const port = portOf(url)
  const proxy = proxyFor(url, options.env)
  if (proxy === null) {
    const addresses = checked(host, await addressesOf(host, options))
    const socket = await connectToAny(host, addresses, port, options, sockets)
    return url.protocol === 'https:' ? secure(socket, host, options, sockets) : socket
  }
  if (isIP(host) === 0) {
    const here = await addressesOf(host, options).catch(() => null)
    if (here !== null) checked(host, here)
  } else checked(host, [{ address: host, family: isIP(host) as 4 | 6 }])
  const proxyHost = hostOf(proxy.url)
  let socket = await connectToAny(proxyHost, await addressesOf(proxyHost, options), portOf(proxy.url), options, sockets)
  if (proxy.url.protocol === 'https:') socket = await secure(socket, proxyHost, options, sockets)
  const tunnel = await tunnelThrough(socket, `${isIPv6(host) ? `[${host}]` : host}:${port}`, proxy.authorization)
  return secure(sockets.add(tunnel), host, options, sockets)
}

/** The addresses of a host: an IP literal's own, or what the DNS hook resolves its name to. */
async function addressesOf(host: string, options: ConnectionOptions): Promise<ResolvedAddress[]> {
  return isIP(host) === 0 ? resolve(host, options) : [{ address: host, family: isIP(host) as 4 | 6 }]
}

/** The host's addresses, when the floor refuses none of them (§17 Addresses). */
function checked(host: string, addresses: ResolvedAddress[]): ResolvedAddress[] {
  for (const { address } of addresses) {
    const refused = refusedAddress(address)
    if (refused !== null) {
      const resolved = address === host ? host : `${host} resolves to ${address}`
      throw new Refusal(`the safety floor refuses the address: ${resolved} (${refused})`)
    }
  }
  return addresses
}

/**
 * A tunnel to `target` (`host:port`) through the proxy connected to over `socket`: an HTTP `CONNECT`, with the
 * credentials of the proxy's URL, if any.
 */
function tunnelThrough(socket: Duplex, target: string, authorization: string | null): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      createConnection: () => socket,
      method: 'CONNECT',
      path: target,
      setHost: false,
      headers: { Host: target, ...(authorization === null ? {} : { 'Proxy-Authorization': authorization }) },
    })
    const refused = (status: number | undefined) => new Failure(`the proxy answered ${status} to CONNECT ${target}`)
    request.once('connect', (response, tunnel: Duplex, head: Buffer) => {
      if (response.statusCode !== 200) {
        tunnel.destroy()
        reject(refused(response.statusCode))
        return
      }
      if (head.length > 0) tunnel.unshift(head)
      resolve(tunnel)
    })
    request.once('response', (response) => {
      socket.destroy()
      reject(refused(response.statusCode))
    })
    request.on('error', (error) => reject(new Failure(`the proxy's tunnel to ${target} failed: ${reason(error)}`)))
    request.end()
  })
}

/**
 * Connects to the first of `addresses` that accepts a connection, in order. Once the request has ended, because a time
 * limit ran out, the connection being opened is given up, and no other address is tried.
 */
async function connectToAny(
  host: string,
  addresses: readonly ResolvedAddress[],
  port: number,
  { connect }: ConnectionOptions,
  sockets: Sockets,
): Promise<Duplex> {
  const { signal } = sockets
  let last: unknown
  for (const { address, family } of addresses) {
    if (signal.aborted) break
    try {
      return sockets.add(await connect({ address, family, port, signal }))
    } catch (error) {
      last = error
    }
  }
  throw new Failure(`can't connect to ${host}: ${reason(last)}`)
}

async function resolve(host: string, options: ConnectionOptions): Promise<ResolvedAddress[]> {
  try {
    const addresses = await options.lookup(host)
    if (addresses.length === 0) throw new Error('no addresses')
    return addresses
  } catch (error) {
    throw new Failure(`DNS lookup of ${host} failed: ${reason(error)}`)
  }
}

/** Verified TLS over `socket` to `host`. Verification is never turned off, whatever the environment says. */
function secure(socket: Duplex, host: string, { ca }: ConnectionOptions, sockets: Sockets): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const tls = sockets.add(
      tlsConnect({
        socket,
        ...(isIP(host) === 0 ? { servername: host } : { host }),
        rejectUnauthorized: true,
        ALPNProtocols: ['http/1.1'],
        ...(ca === null ? {} : { ca }),
      }),
    )
    tls.once('secureConnect', () => {
      tls.off('error', fail)
      resolve(tls)
    })
    const fail = (error: Error) => reject(new Failure(`TLS with ${host} failed: ${reason(error)}`))
    tls.once('error', fail)
  })
}

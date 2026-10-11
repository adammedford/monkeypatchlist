// An in-process network for the resolve fetcher (§17 Safety floor). The fetcher's DNS and connect hooks are
// pointed at it, so tests exercise the whole floor without a port or the internet: DNS answers come from a table (or a
// function, for rebinding), and each connection is a duplex pair whose other end is handed to an in-process HTTP or
// HTTPS server, as if it had been accepted.
//
//   const network = fakeNetwork({ 'cdn.example': '203.0.113.10' })
//   network.serve('203.0.113.10', (request, response) => response.end('window.fetch = f'))
//   await scanBuild(files, ['--mode', 'resolve'], { deps: { resolveFetcher: network.fetcher() } })

import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import https from 'node:https'
import { isIP } from 'node:net'
import { duplexPair, type Duplex } from 'node:stream'
import type { Fetcher } from '../../src/packages/source-store/index.ts'
import { resolveFetcher, type Limits, type ResolveFetcherOptions } from '../../src/packages/source-store/resolve.ts'

/**
 * A test certificate authority, and a certificate it issued for `cdn.example`, `app.example`, `static.example` and
 * `203.0.113.10`, valid until 2126. The key is for these tests only: it guards nothing.
 */
const testCa = `-----BEGIN CERTIFICATE-----
MIIBczCCARmgAwIBAgIJAIxpBVpinEp7MAoGCCqGSM49BAMCMBwxGjAYBgNVBAMM
EVBhdGNobGluZSBUZXN0IENBMCAXDTI2MDkyNzIxNTc0M1oYDzIxMjYwOTAzMjE1
NzQzWjAcMRowGAYDVQQDDBFQYXRjaGxpbmUgVGVzdCBDQTBZMBMGByqGSM49AgEG
CCqGSM49AwEHA0IABJSLwSEVsEy1bZ0zC/praOWxokpfaY4Xz6e5AHxyy+LZ1m3A
sJTG6lNw975LBs+vll/JYO467P+mxzmkLWAO0QajQjBAMA8GA1UdEwEB/wQFMAMB
Af8wDgYDVR0PAQH/BAQDAgEGMB0GA1UdDgQWBBRGvfoW9y1ys5tOQpSeBkgjuGX6
SDAKBggqhkjOPQQDAgNIADBFAiB6IoLIMuoOoARUgl9TZwUXHG6sf4EVpElEbKJk
J9697QIhAJlcwKpkajrQebKHxHTEQyHx/OGSzGztUBIZ1c+odQX8
-----END CERTIFICATE-----
`

const testCertificate = `-----BEGIN CERTIFICATE-----
MIIBujCCAWGgAwIBAgIJALfUBDqGGq92MAoGCCqGSM49BAMCMBwxGjAYBgNVBAMM
EVBhdGNobGluZSBUZXN0IENBMCAXDTI2MDkyNzIxNTc0M1oYDzIxMjYwOTAzMjE1
NzQzWjAWMRQwEgYDVQQDDAtjZG4uZXhhbXBsZTBZMBMGByqGSM49AgEGCCqGSM49
AwEHA0IABFyIP6ZDBMHaEPyaORk4sCP9ZBh1NAjDOU51fle33YKel+AuJI+gcABn
Sedru6qB0Ckqwk99zhuDCgmgqlbF+3yjgY8wgYwwOQYDVR0RBDIwMIILY2RuLmV4
YW1wbGWCC2FwcC5leGFtcGxlgg5zdGF0aWMuZXhhbXBsZYcEywBxCjAJBgNVHRME
AjAAMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDATAfBgNVHSME
GDAWgBRGvfoW9y1ys5tOQpSeBkgjuGX6SDAKBggqhkjOPQQDAgNHADBEAiAmrWTD
toXRhmSXEPdiAx258RBGAPm+19Odr8ZtO95ctwIgRj8Wjc+uKPBiPYtdosBNjIA0
ph2wNf+ucqz/a7Pd+sw=
-----END CERTIFICATE-----
`

const testKey = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIPJDBCjLViqokLaJQUaglB7wU7orTOqYTWaMiOyYBJR3oAoGCCqGSM49
AwEHoUQDQgAEXIg/pkMEwdoQ/Jo5GTiwI/1kGHU0CMM5TnV+V7fdgp6X4C4kj6Bw
AGdJ52u7qoHQKSrCT33OG4MKCaCqVsX7fA==
-----END EC PRIVATE KEY-----
`

export type Handler = (request: IncomingMessage, response: ServerResponse) => void

/** A request a server of the network received. */
export interface ReceivedRequest {
  /** `http://` or `https://`, the Host header and the request target. */
  url: string
  method: string
  headers: IncomingHttpHeaders
}

/** A CONNECT request a proxy of the network received. */
export interface ProxiedConnect {
  target: string
  proxyAuthorization: string | undefined
}

export interface FakeNetwork {
  /** Serves `handler` over HTTP on port 80 and HTTPS on port 443 of `address` (with the test certificate). */
  serve(address: string, handler: Handler): void
  /** Serves `handler` over HTTP or HTTPS on another port of `address`. */
  serveOn(address: string, port: number, protocol: 'http' | 'https', handler: Handler): void
  /**
   * Runs an HTTP proxy on `address:port` that records each CONNECT request, and tunnels it to the server of the network
   * its target resolves to in the proxy's own `zone` (the network's by default), or answers `status` when it is given.
   */
  proxy(address: string, port: number, options?: { zone?: Zone; status?: number }): ProxiedConnect[]
  /** Makes connections to `address:port` hang: they are never accepted, until the fetcher gives them up. */
  blackhole(address: string, port: number): void
  /** Every name the fetcher asked the DNS hook for, in order. */
  lookups: string[]
  /** Every `address:port` the fetcher asked the connect hook for, in order. */
  connects: string[]
  /** Every `address:port` whose hanging connection the fetcher gave up, through the connect hook's signal, in order. */
  abandoned: string[]
  /** Every request the servers received, in order. */
  requests: ReceivedRequest[]
  /**
   * The CLI's `resolveFetcher` dependency: it makes a resolve fetcher for each scan, whose DNS and connect hooks are
   * this network's, and which trusts the test certificate authority unless `trusted` is false.
   */
  fetcher(options?: FetcherOptions): () => Fetcher
}

export interface FetcherOptions {
  env?: Record<string, string>
  limits?: Partial<Limits>
  trusted?: boolean
  clock?: () => number
}

/** DNS answers: each name's addresses, or a function that gives them on each lookup. */
export type Zone = Record<string, string | string[] | (() => string | string[])>

export function fakeNetwork(zone: Zone = {}): FakeNetwork {
  const listeners = new Map<string, (socket: Duplex) => void>()
  const blackholes = new Set<string>()
  const lookups: string[] = []
  const connects: string[] = []
  const abandoned: string[] = []
  const requests: ReceivedRequest[] = []

  function server(protocol: 'http' | 'https', handler: Handler): http.Server {
    const record: Handler = (request, response) => {
      requests.push({
        url: `${protocol}://${request.headers.host}${request.url}`,
        method: request.method ?? '',
        headers: request.headers,
      })
      handler(request, response)
    }
    return protocol === 'https'
      ? https.createServer({ cert: testCertificate, key: testKey }, record)
      : http.createServer(record)
  }

  function listen(address: string, port: number, accept: (socket: Duplex) => void): void {
    listeners.set(`${address}:${port}`, accept)
  }

  /** Connects to `address:port` inside the network, as the connect hook does. */
  function open(address: string, port: number): Promise<Duplex> {
    const accept = listeners.get(`${address}:${port}`)
    if (accept === undefined) {
      const refused = Object.assign(new Error(`connect ECONNREFUSED ${address}:${port}`), { code: 'ECONNREFUSED' })
      return Promise.reject(refused)
    }
    const [client, served] = duplexPair()
    accept(served)
    return Promise.resolve(client)
  }

  function answer(name: string, from: Zone = zone): string[] {
    const found = from[name]
    if (found === undefined) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${name}`), { code: 'ENOTFOUND' })
    const addresses = typeof found === 'function' ? found() : found
    return typeof addresses === 'string' ? [addresses] : addresses
  }

  const network: FakeNetwork = {
    lookups,
    connects,
    abandoned,
    requests,
    serve(address, handler) {
      network.serveOn(address, 80, 'http', handler)
      network.serveOn(address, 443, 'https', handler)
    },
    serveOn(address, port, protocol, handler) {
      const accepting = server(protocol, handler)
      listen(address, port, (socket) => accepting.emit('connection', socket))
    },
    proxy(address, port, { zone: proxyZone = zone, status } = {}) {
      const connected: ProxiedConnect[] = []
      const proxy = http.createServer((_, response) => response.writeHead(405).end())
      proxy.on('connect', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
        const target = request.url ?? ''
        connected.push({ target, proxyAuthorization: request.headers['proxy-authorization'] })
        if (status !== undefined) {
          socket.end(`HTTP/1.1 ${status} Refused\r\n\r\n`)
          return
        }
        const at = target.lastIndexOf(':')
        const [host, targetPort] = [target.slice(0, at).replace(/^\[|\]$/g, ''), Number(target.slice(at + 1))]
        let address: string
        try {
          address = isIP(host) === 0 ? answer(host, proxyZone)[0]! : host
        } catch {
          socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          return
        }
        open(address, targetPort).then(
          (upstream) => {
            // Either end of the tunnel may be torn down first, as the fetcher closes its connection.
            for (const end of [socket, upstream]) end.on('error', () => {})
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
            if (head.length > 0) upstream.write(head)
            socket.pipe(upstream).pipe(socket)
          },
          () => socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'),
        )
      })
      listen(address, port, (socket) => proxy.emit('connection', socket))
      return connected
    },
    blackhole(address, port) {
      blackholes.add(`${address}:${port}`)
    },
    fetcher(options = {}) {
      const hooks: ResolveFetcherOptions = {
        version: '0.0.0-test',
        env: options.env ?? {},
        lookup: async (name) => {
          lookups.push(name)
          return answer(name).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
        },
        connect: ({ address, port, signal }) => {
          const target = `${address}:${port}`
          connects.push(target)
          if (!blackholes.has(target)) return open(address, port)
          // A blackholed address accepts nothing and never answers: the connection hangs until the fetcher gives it up.
          return new Promise<Duplex>((_, reject) => {
            const giveUp = () => {
              abandoned.push(target)
              reject(signal.reason)
            }
            if (signal.aborted) giveUp()
            else signal.addEventListener('abort', giveUp, { once: true })
          })
        },
        ...(options.trusted === false ? {} : { ca: testCa }),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        ...(options.clock === undefined ? {} : { clock: options.clock }),
      }
      return () => resolveFetcher(hooks)
    },
  }
  return network
}

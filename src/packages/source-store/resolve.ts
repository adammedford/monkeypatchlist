// The resolve fetcher (§17, §19 Source store and retrieval): fetches remote URLs under §17's fixed safety floor, which
// it enforces entirely inside itself, and checks their bytes against the integrity value each request carries (§17
// Integrity). It is made for one scan, and caches nothing beyond it.

import { lookup as systemLookup } from 'node:dns/promises'
import { connect as netConnect } from 'node:net'
import type { Duplex } from 'node:stream'
import type { Fetcher } from './index.ts'
import { createSession } from './lib/session.ts'

/** The floor's limits (§17 Safety floor). The defaults are §17's; Release 2 makes them configurable (§22). */
export interface Limits {
  /** The most redirects one fetch follows. */
  redirects: number
  /** The most bytes one response may have, decompressed. */
  responseBytes: number
  /** The most bytes all the responses of a scan may have, decompressed. */
  scanBytes: number
  /** How long a connection may take to open: the lookup, the connect, and any proxy tunnel and TLS handshake. */
  connectMs: number
  /** How long one request may take, from opening its connection to the end of its body. */
  requestMs: number
  /** How long all the fetches of a scan may take together. */
  scanMs: number
  /** The most remote artifacts a scan fetches. */
  artifacts: number
}

export const defaultLimits: Readonly<Limits> = {
  redirects: 5,
  responseBytes: 20 * 1024 * 1024,
  scanBytes: 100 * 1024 * 1024,
  connectMs: 10_000,
  requestMs: 30_000,
  scanMs: 5 * 60_000,
  artifacts: 500,
}

/** An address a host name resolves to. */
export interface ResolvedAddress {
  address: string
  family: 4 | 6
}

/** The DNS hook: every address a host name resolves to. */
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>

/**
 * The connect hook: opens a TCP connection to an address the floor has checked, resolving once it is connected. When
 * `signal` aborts first, because a time limit ran out, it stops connecting and rejects.
 */
export type Connect = (target: ResolvedAddress & { port: number; signal: AbortSignal }) => Promise<Duplex>

export interface ResolveFetcherOptions {
  /** monkeypatchlist's version, which the `User-Agent` names. */
  version: string
  /** The environment, which `HTTPS_PROXY` and `NO_PROXY` are read from. */
  env: Readonly<Record<string, string | undefined>>
  /** The DNS hook. The system resolver by default. */
  lookup?: Lookup
  /** The connect hook. A `net` socket by default. */
  connect?: Connect
  /**
   * Certificate authorities to trust instead of Node's, for tests. TLS is verified whatever this is: nothing turns
   * verification off.
   */
  ca?: string | string[]
  /** The floor's limits; §17's by default. */
  limits?: Partial<Limits>
  /** A monotonic clock in milliseconds, for the scan-wide time limit. */
  clock?: () => number
}

/**
 * A resolve fetcher for one scan. Each URL is requested at most once however often it is asked for, and the scan-wide
 * limits (bytes, time and artifacts) count everything it fetches. Nothing it holds outlives it.
 */
export function resolveFetcher(options: ResolveFetcherOptions): Fetcher {
  return createSession({
    version: options.version,
    env: options.env,
    lookup: options.lookup ?? systemLookupAll,
    connect: options.connect ?? tcpConnect,
    ca: options.ca ?? null,
    limits: { ...defaultLimits, ...options.limits },
    clock: options.clock ?? (() => performance.now()),
  })
}

async function systemLookupAll(hostname: string): Promise<ResolvedAddress[]> {
  const addresses = await systemLookup(hostname, { all: true, order: 'verbatim' })
  return addresses.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }))
}

function tcpConnect({ address, port, signal }: Parameters<Connect>[0]): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    // An abort destroys the socket, which then rejects, however far it has got.
    const socket = netConnect({ host: address, port, signal })
    socket.once('connect', () => {
      socket.off('error', reject)
      resolve(socket)
    })
    socket.once('error', reject)
  })
}

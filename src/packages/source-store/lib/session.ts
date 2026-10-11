// One scan's resolve fetcher: the floor's per-fetch rules, and the state its scan-wide limits and its cache keep.

import type { FetchedResponse, Fetcher, FetchRequest, FetchResult, Sri } from '../index.ts'
import type { Connect, Limits, Lookup } from '../resolve.ts'
import { open } from './connection.ts'
import { blockedTypeRefusal, javascriptTypeRefusal } from './content-types.ts'
import { Sockets, within } from './deadline.ts'
import { exchange, type Answer } from './exchange.ts'
import { verified } from './integrity.ts'
import { Failure, Refusal } from './outcomes.ts'
import { hostOf, withoutFragment } from './urls.ts'

export interface SessionOptions {
  version: string
  env: Readonly<Record<string, string | undefined>>
  lookup: Lookup
  connect: Connect
  ca: string | string[] | null
  limits: Limits
  clock: () => number
}

/** What requesting one URL once gave: a response, or why there is none. */
type Hop =
  | ({ kind: 'response' } & Answer)
  | { kind: 'refused'; detail: string; response: FetchedResponse | null }
  | { kind: 'failed'; detail: string }

export function createSession(options: SessionOptions): Fetcher {
  /** What requesting each URL gave, by URL without its fragment: each URL is requested once per scan (§17 Caching). */
  const hops = new Map<string, Promise<Hop>>()
  /** The bytes of every response body read so far, decompressed (§17 Size). */
  let scanned = 0
  /** How long the scan's requests have taken so far, in all (§17 Time). */
  let spent = 0
  /** The remote URLs the scan has fetched, without their fragments (§17 Count). A redirect's target isn't one. */
  const fetched = new Set<string>()

  function hop(url: URL): Promise<Hop> {
    let found = hops.get(url.href)
    if (found === undefined) hops.set(url.href, (found = request(url)))
    return found
  }

  /**
   * Requests `url` once: its connection may take the connect limit, and the whole request the request limit, or what
   * is left of the scan's (§17 Time). Once the scan's is spent, nothing more is requested.
   */
  async function request(url: URL): Promise<Hop> {
    const { connectMs, requestMs, scanMs, responseBytes, scanBytes } = options.limits
    const left = scanMs - spent
    const outOfTime = () => new Failure(`the scan's fetches took longer than the safety floor's ${scanMs} ms in all`)
    if (left <= 0) return failed(outOfTime())
    const sockets = new Sockets()
    const start = options.clock()
    try {
      const connecting = open(url, options, sockets)
      const connection = await within(connecting, Math.min(connectMs, left), () =>
        connectMs <= left
          ? new Failure(`connecting to ${hostOf(url)} took longer than the safety floor's ${connectMs} ms`)
          : outOfTime(),
      )
      const exchanging = exchange(url, connection, options, { responseBytes, scanBytes, scanned })
      const answer = await within(exchanging, Math.min(requestMs, left) - (options.clock() - start), () =>
        requestMs <= left
          ? new Failure(`the request for ${url.href} took longer than the safety floor's ${requestMs} ms`)
          : outOfTime(),
      )
      scanned += answer.bytes?.length ?? 0
      return { kind: 'response', ...answer }
    } catch (error) {
      if (error instanceof Refusal) return { kind: 'refused', detail: error.message, response: error.response }
      if (error instanceof Failure) return failed(error)
      throw error
    } finally {
      sockets.close()
      spent += options.clock() - start
    }
  }

  return {
    /**
     * Fetches `requested` as `request` asks for it, following redirects. Every hop is checked against the whole floor
     * (§17 Redirects): its scheme here, its address when it is connected to. A fragment is never requested. The bytes
     * are checked against the request's integrity value, if any (§17 Integrity).
     */
    async fetch(requested: string, { destination, document, integrity = '' }: FetchRequest): Promise<FetchResult> {
      let url = withoutFragment(new URL(requested))
      const scheme = schemeRefusal(url, document)
      if (scheme !== null) return refused(scheme)
      const { artifacts } = options.limits
      if (!fetched.has(url.href)) {
        if (fetched.size >= artifacts) return refused(`the safety floor fetches at most ${artifacts} remote artifacts`)
        fetched.add(url.href)
      }
      // There is no separate loop check: a loop is refused when it reaches the sixth redirect, as any chain is. Each
      // URL in it is still requested once, since a hop's outcome is cached.
      for (let redirects = 0; ; redirects++) {
        const outcome = await hop(url)
        if (outcome.kind === 'failed') return failure(outcome.detail)
        if (outcome.kind === 'refused') return refused(outcome.detail, outcome.response)
        const { response, status, location, nosniff, bytes } = outcome
        if (redirectStatuses.has(status) && location !== null) {
          const next = URL.parse(location, url.href)
          if (next === null) return failure(`a redirect to ${location}, which isn't a URL`, response)
          url = withoutFragment(next)
          if (redirects === options.limits.redirects) {
            return refused(`the safety floor follows at most ${options.limits.redirects} redirects`)
          }
          const hopScheme = schemeRefusal(url, document)
          if (hopScheme !== null) return refused(`${hopScheme}, in a redirect to ${url.href}`)
          continue
        }
        if (status < 200 || status > 299 || bytes === null) return failure(`HTTP ${status}`, response)
        // The body was read whatever the destination, so a URL fetched as another is still requested once. The checks
        // run in the browser's order (§17 Content types): blocked types and `nosniff`, integrity, then the JavaScript
        // MIME type that modules and workers need.
        const blocked = blockedTypeRefusal(destination, response.contentType, nosniff)
        if (blocked !== null) return refused(blocked, response)
        const checked = verified(bytes, response, integrity)
        if (checked.status !== 'ok') return checked
        const type = javascriptTypeRefusal(destination, response.contentType)
        return type === null ? checked : refused(type, response, checked.sri)
      }
    },
  }
}

function failed(error: Failure): Hop {
  return { kind: 'failed', detail: error.message }
}

/** The statuses a browser follows a `Location` for (Fetch § HTTP-redirect fetch). */
const redirectStatuses = new Set([301, 302, 303, 307, 308])

function refused(detail: string, response: FetchedResponse | null = null, sri: Sri = 'none'): FetchResult {
  return { status: 'remote-refused', detail, response, sri }
}

function failure(detail: string, response: FetchedResponse | null = null): FetchResult {
  return { status: 'fetch-failed', detail, response }
}

/**
 * Why the floor refuses to fetch `url` for the entry document `document`, or null when it doesn't (§17 Schemes):
 * `https:` is fetched for any document, and `http:` only for an `http:` one.
 */
function schemeRefusal(url: URL, document: string): string | null {
  if (url.protocol === 'https:') return null
  const from = new URL(document).protocol
  if (url.protocol === 'http:' && from === 'http:') return null
  const allowed = from === 'http:' ? '`https:` and `http:`' : '`https:`'
  return `the safety floor fetches only ${allowed} for an \`${from}\` document, not \`${url.protocol}\``
}

// The fixture fetcher (§19 Source store and retrieval): serves recorded responses, for tests and build-time tools. It
// never touches the network.

import type { Fetcher, FetchRequest, FetchResult } from './index.ts'
import { verified } from './lib/integrity.ts'
import { defaultLimits } from './resolve.ts'

/**
 * A recorded HTTP response: its status (200 when left out), its headers (names in any case) and its body. A 3xx
 * response with a `Location` header redirects to that URL, resolved against the one requested.
 */
export interface RecordedResponse {
  status?: number
  headers?: Record<string, string>
  body?: string | Uint8Array
}

const encoder = new TextEncoder()

/**
 * A fetcher that serves `responses`, by URL. A fragment is never part of a request, so it is dropped before the lookup.
 * It follows recorded redirects, and gives:
 *
 * - `ok`, with the bytes and the final response, for a 2xx response, or `sri-mismatch` when its bytes don't match the
 *   request's integrity value (§17 Integrity)
 * - `fetch-failed` with the response, for any other status (§17 Outcomes)
 * - `fetch-failed` with no response, for a URL with no recorded response, as for a host that doesn't answer
 * - `remote-refused` with no response, for a sixth redirect, as the safety floor gives (§17 Safety floor). A redirect
 *   loop is refused so too: there is no separate loop check.
 */
export function fixtureFetcher(responses: Readonly<Record<string, RecordedResponse>>): Fetcher {
  const recorded = new Map(Object.entries(responses).map(([url, response]) => [withoutFragment(url), response]))
  return {
    async fetch(url: string, { integrity = '' }: FetchRequest): Promise<FetchResult> {
      const { redirects: most } = defaultLimits
      for (let current = withoutFragment(url), redirects = 0; ; redirects++) {
        const response = recorded.get(current)
        if (response === undefined) {
          return { status: 'fetch-failed', detail: `no recorded response for ${current}`, response: null }
        }
        const status = response.status ?? 200
        const headers = new Map(
          Object.entries(response.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value]),
        )
        const location = headers.get('location')
        if (status >= 300 && status < 400 && location !== undefined) {
          if (redirects === most) {
            const detail = `the safety floor follows at most ${most} redirects`
            return { status: 'remote-refused', detail, response: null }
          }
          current = withoutFragment(new URL(location, current).href)
          continue
        }
        const fetched = {
          finalUrl: current,
          contentType: headers.get('content-type') ?? null,
          etag: headers.get('etag') ?? null,
          lastModified: headers.get('last-modified') ?? null,
          sourceMap: headers.get('sourcemap') ?? headers.get('x-sourcemap') ?? null,
        }
        if (status < 200 || status > 299) return { status: 'fetch-failed', detail: `HTTP ${status}`, response: fetched }
        const body = response.body ?? ''
        return verified(typeof body === 'string' ? encoder.encode(body) : body, fetched, integrity)
      }
    },
  }
}

/** The URL without its fragment. */
function withoutFragment(url: string): string {
  const parsed = new URL(url)
  parsed.hash = ''
  return parsed.href
}

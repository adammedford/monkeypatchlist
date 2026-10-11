// `data:` URLs (§2 Other script URLs): code a page carries in the reference itself. The store reads one as the Fetch
// standard's data: URL processor does, with no fetcher, and refuses it where a browser would refuse to run the
// script: then nothing of it is an artifact.

import type { FetchRequest, ReadResult } from '../index.ts'
import { blockedTypeRefusal, javascriptTypeRefusal } from './content-types.ts'
import { checkIntegrity } from './integrity.ts'

/**
 * Reads the `data:` URL `url` as `request` asks for it (§2 Other script URLs). Its body is the script, and its MIME
 * type the response's `Content-Type`. It is `refused` when a browser would not run it: a malformed base64 body, a MIME
 * type a browser blocks for any script (`image/*`, `audio/*`, `video/*`, `text/csv`), bytes that don't match the
 * request's integrity value, or a module or a script `importScripts` loads whose MIME type isn't JavaScript's, checked
 * in the browser's order (§17 Content types). A classic script of the window needs no JavaScript MIME type, and nor
 * does a worker's own classic script, whose URL isn't HTTP(S) (HTML § Fetch a classic worker script).
 */
export function readDataUrl(url: string, request: FetchRequest): ReadResult {
  const processed = processDataUrl(url)
  if (processed === null) return refused(url, 'its base64 body is malformed')
  const { contentType, body } = processed
  if (blockedTypeRefusal(request.destination, contentType, null) !== null) {
    return refused(url, `a browser blocks a script of the MIME type ${contentType}`)
  }
  const sri = checkIntegrity(request.integrity ?? '', body)
  if (sri !== 'none' && sri.result === 'mismatch') {
    return refused(url, `its digest is ${sri.actual}, and the integrity value expects ${sri.expected.join(' or ')}`)
  }
  const ownWorkerScript = request.destination === 'worker' && request.imported !== true
  if (!ownWorkerScript && javascriptTypeRefusal(request.destination, contentType) !== null) {
    return refused(url, `it needs a JavaScript MIME type, and it has ${contentType}`)
  }
  const retrieval = { status: 'ok' as const, requestedUrl: url, finalUrl: url, contentType, sri }
  return { status: 'ok', url, path: null, bytes: body, retrieval, sourceMap: null }
}

function refused(url: string, why: string): ReadResult {
  return { status: 'refused', url, detail: `a browser refuses to run the data: script: ${why}` }
}

/**
 * The MIME type and body of a `data:` URL (Fetch § data: URL processor), or null when its body is malformed base64. A
 * MIME type that doesn't parse, an empty one included, is `text/plain;charset=US-ASCII`.
 */
function processDataUrl(url: string): { contentType: string; body: Uint8Array } | null {
  // The URL serialized without its fragment: its first `#` starts the fragment.
  const fragment = url.indexOf('#')
  const input = url.slice('data:'.length, fragment === -1 ? undefined : fragment)
  const comma = input.indexOf(',')
  if (comma === -1) return null
  let mimeType = input.slice(0, comma).replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '')
  let body = percentDecode(input.slice(comma + 1))
  const base64 = /; *base64$/i.exec(mimeType)
  if (base64 !== null) {
    try {
      // Forgiving-base64 decode, of the body's isomorphic decoding.
      body = Uint8Array.from(atob(Buffer.from(body).toString('latin1')), (character) => character.charCodeAt(0))
    } catch {
      return null
    }
    mimeType = mimeType.slice(0, base64.index)
  }
  if (mimeType.startsWith(';')) mimeType = `text/plain${mimeType}`
  return { contentType: parsesAsMimeType(mimeType) ? mimeType : 'text/plain;charset=US-ASCII', body }
}

/**
 * Whether `text` parses as a MIME type (MIME Sniffing § parse a MIME type): a token type and subtype, then any
 * parameters.
 */
function parsesAsMimeType(text: string): boolean {
  return /^[\t\n\r ]*[!#$%&'*+.^_`|~\dA-Za-z-]+\/[!#$%&'*+.^_`|~\dA-Za-z-]+[\t\n\r ]*(?:;|$)/.test(text)
}

/** The bytes of a URL's percent-encoding (URL § percent-decode): an invalid escape is left as it is. */
function percentDecode(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text)
  const out: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0)
    if (bytes[i] === 0x25 && /^[\dA-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16))
      i += 2
    } else out.push(bytes[i]!)
  }
  return Uint8Array.from(out)
}

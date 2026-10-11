// The MIME types the floor fetches each destination with (§17 Content types): what a browser would execute. The
// checks come in two parts, which a fetch runs in the browser's order for each destination: `blockedTypeRefusal`
// first, then the integrity check, then `javascriptTypeRefusal`. A source map is read as JSON whatever its type, so
// neither part refuses one.

import type { FetchRequest } from '../index.ts'

/** JavaScript MIME type essences (MIME Sniffing § JavaScript MIME type). */
const javascriptTypes = new Set([
  'application/ecmascript',
  'application/javascript',
  'application/x-ecmascript',
  'application/x-javascript',
  'text/ecmascript',
  'text/javascript',
  'text/javascript1.0',
  'text/javascript1.1',
  'text/javascript1.2',
  'text/javascript1.3',
  'text/javascript1.4',
  'text/javascript1.5',
  'text/jscript',
  'text/livescript',
  'text/x-ecmascript',
  'text/x-javascript',
])

type Destination = FetchRequest['destination']

/**
 * Why a browser blocks a response of `contentType` for `destination` before it checks integrity, or null when it
 * doesn't (Fetch § main fetch: § Should response to request be blocked due to its MIME type? and § due to nosniff?).
 * Every script destination is blocked for an `image/*`, `audio/*`, `video/*` or `text/csv` type, or for a type that
 * isn't JavaScript's with `X-Content-Type-Options: nosniff`.
 */
export function blockedTypeRefusal(
  destination: Destination,
  contentType: string | null,
  nosniff: string | null,
): string | null {
  if (destination === 'map') return null
  const essence = mimeEssence(contentType)
  if (essence !== null && (/^(image|audio|video)\//.test(essence) || essence === 'text/csv')) {
    return `the safety floor refuses ${named[destination]} served with ${served(contentType)}, which a browser blocks`
  }
  if (!isJavascript(essence) && isNosniff(nosniff)) {
    const what = `${named[destination]} served with ${served(contentType)}`
    return `the safety floor refuses ${what} and X-Content-Type-Options: nosniff`
  }
  return null
}

/**
 * Why a browser refuses a response of `contentType` for `destination` once its integrity is checked, or null when it
 * doesn't (HTML § Fetching scripts): a module script, a worker's script and a script `importScripts` loads need a
 * JavaScript MIME type. A classic script of the window doesn't.
 */
export function javascriptTypeRefusal(destination: Destination, contentType: string | null): string | null {
  if (destination === 'map' || destination === 'script' || isJavascript(mimeEssence(contentType))) return null
  const what = `${named[destination]} served with ${served(contentType)}`
  return `the safety floor refuses ${what}: it needs a JavaScript MIME type`
}

const named: Record<Exclude<Destination, 'map'>, string> = {
  script: 'a classic script',
  module: 'a module script',
  worker: "a worker's script",
}

function served(contentType: string | null): string {
  return contentType === null ? 'no Content-Type' : `Content-Type ${contentType}`
}

function isJavascript(essence: string | null): boolean {
  return essence !== null && javascriptTypes.has(essence)
}

/** The essence of a `Content-Type` (`type/subtype`, in ASCII lowercase), or null when it has none that parses. */
function mimeEssence(contentType: string | null): string | null {
  if (contentType === null) return null
  const essence = contentType.split(';')[0]!.trim().toLowerCase()
  return /^[!#$%&'*+.^_`|~\da-z-]+\/[!#$%&'*+.^_`|~\da-z-]+$/.test(essence) ? essence : null
}

/** Whether `X-Content-Type-Options` says `nosniff` (Fetch § determine nosniff): its first value, ignoring case. */
function isNosniff(value: string | null): boolean {
  return value !== null && value.split(',')[0]!.trim().toLowerCase() === 'nosniff'
}

// A fake CDN for a child process that downloads with the global `fetch`, such as the corpus's vendor step.
// Loaded with `node --import <this file> …`, it replaces `fetch` with one that answers from a table instead of the
// network, so tests need neither a port nor the internet (as test/support/fake-network.ts does for the resolve fetcher):
//
//   MONKEYPATCHLIST_FAKE_CDN      JSON of URL → body. Those URLs answer 200 with that body; any other answers 404.
//   MONKEYPATCHLIST_FAKE_CDN_LOG  A file each requested URL is appended to, one per line.

import { appendFileSync } from 'node:fs'

const bodies = JSON.parse(process.env.MONKEYPATCHLIST_FAKE_CDN ?? '{}') as Record<string, string>
const log = process.env.MONKEYPATCHLIST_FAKE_CDN_LOG

globalThis.fetch = (input: string | URL | Request): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input)
  if (log !== undefined) appendFileSync(log, `${url}\n`)
  const body = bodies[url]
  return Promise.resolve(body === undefined ? new Response(null, { status: 404 }) : new Response(body))
}

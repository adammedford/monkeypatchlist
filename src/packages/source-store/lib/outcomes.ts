// How the resolve fetcher's steps report the two ways a fetch can end without bytes (§17 Outcomes). They are thrown
// inside the fetcher and returned from it as data.

import type { FetchedResponse } from '../index.ts'

/** The safety floor refuses the fetch: a scheme, address, size, count, redirect or content-type refusal. */
export class Refusal extends Error {
  /** The response the refusal was made on, if there was one. */
  readonly response: FetchedResponse | null

  constructor(detail: string, response: FetchedResponse | null = null) {
    super(detail)
    this.response = response
  }
}

/** The fetch failed: a timeout, a DNS, connection or TLS error, or a response that can't be read. */
export class Failure extends Error {}

/** An error's code, or its message. */
export function reason(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === undefined || error.message.includes(code) ? error.message : `${code}: ${error.message}`
  }
  return String(error)
}

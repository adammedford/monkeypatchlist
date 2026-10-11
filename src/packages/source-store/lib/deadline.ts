// Time limits for the resolve fetcher's steps (§17 Safety floor: Time), and the sockets a step leaves open when one
// runs out.

import type { Duplex } from 'node:stream'

/**
 * The sockets one request opens: all of them are closed when it ends, however it ends. A connection still being opened
 * then is given up through `signal`, so that it neither goes on connecting nor keeps the process alive.
 */
export class Sockets {
  #open: Duplex[] = []
  #ended = new AbortController()

  /** Aborts when the request ends: a connect hook given it stops connecting, and rejects. */
  get signal(): AbortSignal {
    return this.#ended.signal
  }

  /**
   * Keeps `socket` to close with the rest, or closes it now when the request has already ended. An error on it between
   * two steps of the request, when no step is listening, is left for the next step to find: it never crashes the scan.
   */
  add<T extends Duplex>(socket: T): T {
    socket.on('error', () => {})
    if (this.signal.aborted) socket.destroy()
    else this.#open.push(socket)
    return socket
  }

  close(): void {
    this.#ended.abort()
    for (const socket of this.#open) socket.destroy()
  }
}

/** Settles as `work` does, or rejects with `failure()` once `ms` have passed without it settling. */
export function within<T>(work: Promise<T>, ms: number, failure: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(failure()), ms)
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

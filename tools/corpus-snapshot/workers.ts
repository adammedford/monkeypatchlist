// The pool of scan worker processes the corpus check scans with when it runs more than one job. Each
// worker scans one site at a time; the check puts the reports back in site order, so the pool changes only how long
// the check takes, never a byte of what it writes or reports. Build-time only; never published.

import { fork, type ChildProcess } from 'node:child_process'
import type { ReportedSurface } from '../corpus-scan.ts'
import type { BindingName } from './bindings.ts'

/** A scan the parent sends a worker. */
export interface ScanRequest {
  id: number
  dir: string
  surface: ReportedSurface
}

/** A worker's answer: the JSON text the scan printed, or the message of the error it threw. */
export type ScanReply = { id: number; report: string } | { id: number; error: string }

/** A scanner backed by worker processes, and how to stop them. */
export interface ProcessPool {
  scan(dir: string, surface: ReportedSurface): Promise<string>
  close(): void
}

interface Worker {
  child: ChildProcess
  /** The scan it is running, if any. */
  pending: { id: number; resolve: (text: string) => void; reject: (error: Error) => void } | null
  /** Whether it has exited or failed; it takes no more scans. */
  gone: boolean
}

/**
 * A pool of at most `size` worker processes running `module` (by default, scan-worker.ts). A scan waits for an idle
 * worker, starting one while there are fewer than `size`. A worker that exits mid-scan fails that scan alone, and the
 * next scan starts a new one. `started` hears each new worker's process id. Each worker scans with `bindings` behind
 * the binding-resolution seam: by default, the shipped eslint-scope.
 */
export function processPool(
  size: number,
  options: { module?: URL; started?: (pid: number) => void; bindings?: BindingName } = {},
): ProcessPool {
  const module = options.module ?? new URL('./scan-worker.ts', import.meta.url)
  const workers = new Set<Worker>()
  const idle: Worker[] = []
  const waiting: Array<(worker: Worker) => void> = []
  let nextId = 0

  const release = (worker: Worker) => {
    const next = waiting.shift()
    if (next !== undefined) next(worker)
    else idle.push(worker)
  }

  const start = (): Worker => {
    // Only the scan's own output is captured; the worker's stdout and stderr go to the check's.
    const child = fork(module, [options.bindings ?? 'eslint-scope'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
    const worker: Worker = { child, pending: null, gone: false }
    workers.add(worker)
    if (child.pid !== undefined) options.started?.(child.pid)
    child.on('message', (reply: ScanReply) => {
      const pending = worker.pending
      if (pending === null || pending.id !== reply.id) return
      worker.pending = null
      if ('report' in reply) pending.resolve(reply.report)
      else pending.reject(new Error(reply.error))
      release(worker)
    })
    // A worker that exits, or that cannot be started or sent to, is gone: it fails its scan alone, and a scan waiting
    // for a worker gets a new one in its place.
    const fail = (reason: string) => {
      if (worker.gone) return
      worker.gone = true
      workers.delete(worker)
      const at = idle.indexOf(worker)
      if (at >= 0) idle.splice(at, 1)
      const pending = worker.pending
      worker.pending = null
      pending?.reject(new Error(reason))
      if (waiting.length > 0) release(start())
    }
    child.on('exit', (code, signal) => fail(`the scan worker process exited (${signal ?? `code ${code}`}) during the scan`))
    child.on('error', (error) => {
      fail(`the scan worker process failed: ${error.message}`)
      child.kill()
    })
    return worker
  }

  const acquire = (): Promise<Worker> => {
    const worker = idle.pop()
    if (worker !== undefined) return Promise.resolve(worker)
    if (workers.size < size) return Promise.resolve(start())
    return new Promise((resolve) => waiting.push(resolve))
  }

  return {
    async scan(dir, surface) {
      // A worker can be gone by the time a waiting scan gets it; that scan then waits for another.
      let worker = await acquire()
      while (worker.gone) worker = await acquire()
      return new Promise<string>((resolve, reject) => {
        const id = nextId++
        worker.pending = { id, resolve, reject }
        worker.child.send({ id, dir, surface } satisfies ScanRequest)
      })
    },
    close() {
      for (const worker of workers) if (worker.child.connected) worker.child.disconnect()
    },
  }
}

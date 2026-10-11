// Group runners (§18 Parallelism): in process, one group after another, or in worker threads under the memory budget.

import { Worker } from 'node:worker_threads'
import type { SerializedCatalog } from '../../../catalog.ts'
import type { AnalyzeGroupOutput, Budget, Resolver } from '../../analysis/index.ts'
import { analyzeJob, jobBytes, type GroupJob } from '../../analysis/job.ts'
import { schedule } from './schedule.ts'
import type { Reply, Request, Setup } from './protocol.ts'

/**
 * Runs a scan's link groups. `proceed()` is asked before each group starts, in group order: once it says no, no
 * further group runs, and each group not run gives `undefined`. Results come back in group order.
 */
export interface GroupRunner {
  run(jobs: readonly GroupJob[], proceed: () => boolean): Promise<(AnalyzeGroupOutput | undefined)[]>
}

/**
 * The estimated peak heap per source byte of a link group (§18 Target: at most 400× per source byte, so that a 5 MB
 * group fits in 2 GB).
 */
export const heapPerSourceByte = 400

/**
 * The memory budget a parallel run's estimated peak heaps share by default, in bytes: half of the 8 GB runner the cost
 * target is set on (§18), which leaves room for the main thread's own heap, the source store and the catalog copies.
 */
export const defaultMemoryBudget = 4 * 1024 ** 3

/** Runs the groups in process, one after another, with `resolver`. */
export function inProcessRunner(resolver: Resolver, catalog: SerializedCatalog, budget: Budget): GroupRunner {
  return {
    async run(jobs, proceed) {
      const results: (AnalyzeGroupOutput | undefined)[] = []
      for (const job of jobs) {
        if (!proceed()) break
        results.push(analyzeJob(resolver, job, catalog, budget))
      }
      return jobs.map((_, index) => results[index])
    },
  }
}

export interface WorkerRunnerOptions {
  /** How many worker threads may analyze groups at once. */
  workers: number
  /** The memory, in bytes, the estimated peak heaps of the groups running must fit in. */
  memoryBudget: number
  catalog: SerializedCatalog
  budget: Budget
}

/**
 * Runs the groups in up to `workers` worker threads, each with the shipped JS resolver, while their estimated peak heaps
 * fit `memoryBudget`. Each job and each result crosses the boundary as JSON text. Workers start when a run needs them,
 * and stop when it ends.
 */
export function workerRunner({ workers, memoryBudget, catalog, budget }: WorkerRunnerOptions): GroupRunner {
  return {
    async run(jobs, proceed) {
      const setup: Setup = { catalog: JSON.stringify(catalog), budget: JSON.stringify(budget) }
      const idle: Worker[] = []
      const all: Worker[] = []
      const take = (): Worker => {
        const worker = idle.pop()
        if (worker !== undefined) return worker
        const started = new Worker(workerUrl(), { workerData: setup })
        // A worker that exits while idle is never handed another job, which would never be answered.
        started.on('exit', () => {
          const at = idle.indexOf(started)
          if (at !== -1) idle.splice(at, 1)
        })
        all.push(started)
        return started
      }
      const analyze = (index: number) =>
        new Promise<AnalyzeGroupOutput>((resolve, reject) => {
          const worker = take()
          const done = () => {
            worker.off('message', message)
            worker.off('error', error)
            worker.off('exit', exit)
          }
          const message = (reply: Reply) => {
            done()
            idle.push(worker)
            if ('error' in reply) reject(new Error(`link group ${jobs[index]!.entry.url} failed: ${reply.error}`))
            else resolve(JSON.parse(reply.output) as AnalyzeGroupOutput)
          }
          const error = (cause: unknown) => {
            done()
            reject(cause instanceof Error ? cause : new Error(String(cause)))
          }
          const exit = (code: number) => {
            done()
            reject(new Error(`a link-group worker exited with code ${code}`))
          }
          worker.on('message', message)
          worker.on('error', error)
          worker.on('exit', exit)
          const request: Request = { job: JSON.stringify(jobs[index]) }
          worker.postMessage(request)
        })
      try {
        const tasks = jobs.map((job) => ({ heap: heapPerSourceByte * jobBytes(job) }))
        return await schedule(tasks, { workers, memoryBudget }, analyze, proceed)
      } finally {
        await Promise.all(all.map((worker) => worker.terminate()))
      }
    },
  }
}

/** The worker's module: its TypeScript source when this module runs from source, and its build output otherwise. */
function workerUrl(): URL {
  return new URL(import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js', import.meta.url)
}

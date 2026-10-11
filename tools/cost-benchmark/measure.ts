// The cost benchmark's group runner (§18 Target): runs a scan's link groups one after another, as the default runner
// does, but in a measurement worker whose heap the main thread samples while each group is analyzed. It records each
// group's analysis time and peak heap. Build-time only; never published.

import { Worker } from 'node:worker_threads'
import type { SerializedCatalog } from '../../src/catalog.ts'
import type { AnalyzeGroupOutput, Budget } from '../../src/packages/analysis/index.ts'
import { jobBytes, type GroupJob } from '../../src/packages/analysis/job.ts'
import type { GroupRunner } from '../../src/packages/parallel/index.ts'
import type { MeasureReply, MeasureRequest } from './protocol.ts'

/** One link group's cost, as one cold scan measured it. */
export interface GroupCost {
  /** The group's entry artifact. */
  entry: string
  /** Its members, the entry first, in the order the group reached them. */
  members: string[]
  /** The UTF-8 bytes of its members' source, which its step budget scales with. */
  bytes: number
  /** The analysis time, in milliseconds. */
  ms: number
  /**
   * The peak heap the analysis used, in bytes: the most the sampled heap rose above the worker's heap after the garbage
   * collection that precedes the group, which holds the catalog and nothing of the group.
   */
  peakHeapBytes: number
  /** The steps the group took, and whether it exhausted its step budget. */
  steps: number
  exhausted: boolean
}

/** How often the main thread samples the worker's heap while a group runs, in milliseconds. */
const sampleEveryMs = 2

/** A measuring group runner, one worker for the whole benchmark, and what it has measured. */
export interface Meter {
  /** Makes the runner a scan's deps take (`src/cli.ts` `groups`). */
  groups(setup: { catalog: SerializedCatalog; budget: Budget }): GroupRunner
  /** Takes the costs of the groups measured since the last call, in the order they ran. */
  take(): GroupCost[]
  /** Stops the worker. */
  close(): Promise<void>
}

/** A meter whose worker may use `heapMb` MiB of old-generation heap. */
export function meter(heapMb: number): Meter {
  let worker: Worker | null = null
  let measured: GroupCost[] = []
  const start = (catalog: SerializedCatalog): Worker => {
    worker ??= new Worker(new URL('./worker.ts', import.meta.url), {
      workerData: JSON.stringify(catalog),
      resourceLimits: { maxOldGenerationSizeMb: heapMb },
    })
    return worker
  }
  const analyze = (running: Worker, job: GroupJob, budget: Budget) =>
    new Promise<AnalyzeGroupOutput>((resolve, reject) => {
      let peak = 0
      let sampling: NodeJS.Timeout | null = null
      let timing: { ms: number; baseline: number; after: number } | null = null
      const stopSampling = () => {
        if (sampling !== null) clearInterval(sampling)
        sampling = null
      }
      const done = () => {
        stopSampling()
        running.off('message', message)
        running.off('error', error)
        running.off('exit', exit)
      }
      const message = (reply: MeasureReply) => {
        if (reply.phase === 'started') {
          sampling = setInterval(() => {
            void running.getHeapStatistics().then(
              (statistics) => {
                // A sample answered after the analysis returned may hold the result's serialization: it is dropped.
                if (timing === null) peak = Math.max(peak, statistics.used_heap_size)
              },
              () => {},
            )
          }, sampleEveryMs)
        } else if (reply.phase === 'analyzed') {
          stopSampling()
          timing = { ms: reply.ms, baseline: reply.baseline, after: reply.after }
        } else if (reply.phase === 'done') {
          done()
          const output = JSON.parse(reply.output) as AnalyzeGroupOutput
          const { ms, baseline, after } = timing!
          measured.push({
            entry: job.entry.url,
            members: job.artifacts.map(([name]) => name),
            bytes: jobBytes(job),
            ms,
            peakHeapBytes: Math.max(0, Math.max(peak, after) - baseline),
            steps: output.stats.steps,
            exhausted: output.stats.exhausted,
          })
          resolve(output)
        } else {
          done()
          reject(new Error(`link group ${job.entry.url} failed: ${reply.error}`))
        }
      }
      const error = (cause: unknown) => {
        done()
        // A worker that errored (out of heap, say) exits: the next group starts a fresh one rather than waiting on it.
        if (worker === running) worker = null
        void running.terminate()
        reject(cause instanceof Error ? cause : new Error(String(cause)))
      }
      const exit = (code: number) => {
        done()
        if (worker === running) worker = null
        reject(new Error(`the measurement worker exited with code ${code}`))
      }
      running.on('message', message)
      running.on('error', error)
      running.on('exit', exit)
      const request: MeasureRequest = { job: JSON.stringify(job), budget: JSON.stringify(budget) }
      running.postMessage(request)
    })
  return {
    groups: ({ catalog, budget }) => ({
      async run(jobs, proceed) {
        const results: (AnalyzeGroupOutput | undefined)[] = []
        for (const job of jobs) {
          if (!proceed()) break
          results.push(await analyze(start(catalog), job, budget))
        }
        return jobs.map((_, index) => results[index])
      },
    }),
    take() {
      const taken = measured
      measured = []
      return taken
    },
    async close() {
      const running = worker
      worker = null
      if (running !== null) await running.terminate()
    },
  }
}

// The cost benchmark's measurement worker (§18 Target): analyzes one link group at a time with the shipped JS
// resolver, in a thread of its own, so the main thread can sample its heap while it runs. Before each group it collects
// garbage and takes its heap as the group's baseline. Build-time only; never published.

import { performance } from 'node:perf_hooks'
import v8 from 'node:v8'
import vm from 'node:vm'
import { parentPort, workerData } from 'node:worker_threads'
import type { SerializedCatalog } from '../../src/catalog.ts'
import { jsResolver, type Budget } from '../../src/packages/analysis/index.ts'
import { analyzeJob, type GroupJob } from '../../src/packages/analysis/job.ts'
import type { MeasureReply, MeasureRequest } from './protocol.ts'

v8.setFlagsFromString('--expose-gc')
const gc = vm.runInNewContext('gc') as () => void
const catalog = JSON.parse(workerData as string) as SerializedCatalog

const heapUsed = () => v8.getHeapStatistics().used_heap_size
const reply = (message: MeasureReply) => parentPort!.postMessage(message)

parentPort!.on('message', ({ job, budget }: MeasureRequest) => {
  try {
    const parsed = JSON.parse(job) as GroupJob
    const parsedBudget = JSON.parse(budget) as Budget
    gc()
    const baseline = heapUsed()
    reply({ phase: 'started' })
    const start = performance.now()
    const output = analyzeJob(jsResolver, parsed, catalog, parsedBudget)
    const ms = performance.now() - start
    reply({ phase: 'analyzed', ms, baseline, after: heapUsed() })
    reply({ phase: 'done', output: JSON.stringify(output) })
  } catch (error) {
    reply({ phase: 'failed', error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
  }
})

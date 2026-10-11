// A link-group worker (§18 Parallelism): analyzes one job at a time with the shipped JS resolver. Jobs and results
// cross the boundary as JSON text (§19 Serializable seams).

import { parentPort, workerData } from 'node:worker_threads'
import type { SerializedCatalog } from '../../../catalog.ts'
import { jsResolver, type Budget } from '../../analysis/index.ts'
import { analyzeJob, type GroupJob } from '../../analysis/job.ts'
import type { Reply, Request, Setup } from './protocol.ts'

const setup = workerData as Setup
const catalog = JSON.parse(setup.catalog) as SerializedCatalog
const budget = JSON.parse(setup.budget) as Budget

parentPort!.on('message', ({ job }: Request) => {
  let reply: Reply
  try {
    reply = { output: JSON.stringify(analyzeJob(jsResolver, JSON.parse(job) as GroupJob, catalog, budget)) }
  } catch (error) {
    reply = { error: error instanceof Error ? (error.stack ?? error.message) : String(error) }
  }
  parentPort!.postMessage(reply)
})

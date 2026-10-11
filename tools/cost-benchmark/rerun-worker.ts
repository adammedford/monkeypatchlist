// One of the cost benchmark's raised-cap reruns, in a worker thread of its own: with a cap and the step
// budget multiplied, a site can need far more heap than the main thread has, and a rerun that runs out of it must fail
// alone. Build-time
// only; never published.

import { parentPort, workerData } from 'node:worker_threads'
import { loadCatalog } from '../../src/catalog.ts'
import type { Budget } from '../../src/packages/analysis/index.ts'
import { scanCorpusSite, type ReportedSurface } from '../corpus-scan.ts'

const { dir, surface, budget } = workerData as { dir: string; surface: ReportedSurface; budget: Budget }

try {
  parentPort!.postMessage({ report: await scanCorpusSite(dir, surface, loadCatalog(), { budget }) })
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) })
}

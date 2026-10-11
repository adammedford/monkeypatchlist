// Parallel link groups (§18 Parallelism): link groups run one after another by default, and an internal worker-count
// setting lets them run in worker threads, each only while the estimated peak heaps of the groups running fit the
// memory budget. Results merge in group order. Everything that crosses a worker boundary is plain JSON (§19).

export {
  defaultMemoryBudget,
  inProcessRunner,
  workerRunner,
  type GroupRunner,
  type WorkerRunnerOptions,
} from './lib/runner.ts'
export { schedule, type ScheduleOptions } from './lib/schedule.ts'

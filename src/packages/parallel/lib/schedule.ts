// The link-group schedule (§18 Parallelism): which group starts when, and the order results come back in.

/** How many groups may run at once, and the memory their estimated peak heaps must fit in, in bytes. */
export interface ScheduleOptions {
  workers: number
  memoryBudget: number
}

/**
 * Runs `run(index)` for each task, in task order, at most `workers` at once. A task starts only once every task before
 * it has started, and only while its estimated peak heap (`heap`) and those of the tasks running fit `memoryBudget`, or
 * when no task is running, so a group whose estimate alone exceeds the budget waits until it can run alone.
 * `proceed()` is asked before each task starts: once it says no, no further task starts, and each task not started
 * gives `undefined`. The results come back in task order, whatever order the tasks finish in, so merging them never
 * depends on completion order. A task that throws rejects the whole schedule once the tasks running have finished.
 */
export function schedule<T>(
  tasks: readonly { heap: number }[],
  { workers, memoryBudget }: ScheduleOptions,
  run: (index: number) => Promise<T>,
  proceed: () => boolean = () => true,
): Promise<(T | undefined)[]> {
  const results: (T | undefined)[] = tasks.map(() => undefined)
  return new Promise((resolve, reject) => {
    let next = 0
    let running = 0
    let heap = 0
    let stopped = false
    let failure: { error: unknown } | undefined
    const pump = () => {
      while (!stopped && failure === undefined && next < tasks.length && running < Math.max(1, workers)) {
        const task = tasks[next]!
        if (running > 0 && heap + task.heap > memoryBudget) break
        if (!proceed()) {
          stopped = true
          break
        }
        const index = next++
        running++
        heap += task.heap
        run(index).then(
          (result) => {
            results[index] = result
            finished(task)
          },
          (error: unknown) => {
            failure ??= { error }
            finished(task)
          },
        )
      }
      if (running > 0) return
      if (failure !== undefined) reject(failure.error)
      else resolve(results)
    }
    const finished = (task: { heap: number }) => {
      running--
      heap -= task.heap
      pump()
    }
    pump()
  })
}

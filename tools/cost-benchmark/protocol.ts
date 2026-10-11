// What crosses the cost benchmark's measurement-worker boundary: JSON text and numbers only.

/** One link group to analyze: a `GroupJob` and the `Budget` to run it with, each as JSON. */
export interface MeasureRequest {
  job: string
  budget: string
}

/**
 * The worker's answers to one request, in order: `started` once it has collected garbage and taken its baseline heap,
 * `analyzed` once the analysis returned (with its time, and the heap before and right after it), then `done` with the
 * group's `AnalyzeGroupOutput` as JSON. `failed` replaces whichever was due when the analysis threw.
 */
export type MeasureReply =
  | { phase: 'started' }
  | { phase: 'analyzed'; ms: number; baseline: number; after: number }
  | { phase: 'done'; output: string }
  | { phase: 'failed'; error: string }

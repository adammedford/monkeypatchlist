// What crosses the worker boundary (§19 Serializable seams): JSON text only.

/** A worker's setup: the catalog and the budget, each as JSON. */
export interface Setup {
  catalog: string
  budget: string
}

/** A job for a worker: one `GroupJob`, as JSON. */
export interface Request {
  job: string
}

/** A worker's answer: the group's `AnalyzeGroupOutput` as JSON, or the message of the error analysing it threw. */
export type Reply = { output: string } | { error: string }

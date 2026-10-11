// Budgets and caps (§18 Budgets are deterministic, Context policy). Each link group has a step budget, scaled with its
// size: `stepsPerByte` steps per source byte of its members. The caps bound single pieces of work. All of them
// are implementation detail, tuned on the corpus, and never a user flag: the scan's deps can replace them, so the cost
// benchmark can rerun the corpus with each one multiplied on its own.

/** The caps (§18 Context policy), each a count. A cap hit is counted in the scan statistics, whatever it cuts. */
export interface Caps {
  /**
   * The `alternatives` cap: more alternatives than this in one value collapse into unknown, all but its native holders.
   * Chains of the global object's names have a handful.
   */
  alternatives: number
  /**
   * The `fold-length` cap: a string fold longer than this, in UTF-16 code units, is unknown. No member is named by
   * anything near it, and it keeps doubling folds (`const b = a + a, c = b + b, …`) from exhausting memory.
   */
  foldLength: number
  /**
   * How many frames a chain holds before the next call widens: deep enough for helper chains 2–4 deep (§5), and for
   * the chains of calls carrying no native that core-js's install helpers make.
   */
  depth: number
  /**
   * How many frames of one function a write is instantiated in before the rest merge: enough for the per-element calls
   * of iteration natives' callbacks (§5 Resolver capabilities 4) over the corpus's constant lists.
   * A frame that carries a native function (the original `window.fetch`) is kept apart before the others.
   */
  contexts: number
  /**
   * The iteration cap: how many iterations one loop, or one iteration native's callback, is unrolled for in one frame
   * of the code around it (§5 Resolver capabilities 4). A loop that runs past it is cut there (Principle 5).
   */
  iterations: number
  /**
   * How many constants are evaluated one within another before the next one read waits for them to stop: deep enough
   * for any constant a person writes, and shallow enough for the stack (§5 Resolver capabilities 1).
   */
  nesting: number
  /**
   * How many rounds the dynamic-call index is built in, each with the frames the last one found. Each round reaches one
   * call further along a chain of calls the syntax doesn't name. Rounds that run out are a cap hit, counted on the
   * calls of the frames the last round found whose code calls on, and raised as `analysis-budget` when one of them
   * carries a native (Principle 5).
   */
  indexRounds: number
  /** How many aliases deep a patch-shaped write's original is followed (§5 Partially resolved writes). */
  aliasDepth: number
  /** How deep a write-back is followed through heap fields whose values are heap fields (§3). */
  heapDepth: number
  /**
   * The descriptor-alternatives cap: how many combinations of maybe-absent fields one descriptor object is expanded
   * into.
   */
  descriptorAlternatives: number
  /**
   * The candidate-runs cap: how many runs of `writesOf`, one per combination of alternatives, a node's candidate sets
   * are worked out in (§5 Candidate sets). Past it, the node's candidate sites give nothing: counted, and raised as
   * `analysis-budget` when a holder they write can be the global object or a native holder (Principle 5).
   */
  candidateRuns: number
  /** The test-reads cap: how many reads of a guard's test the classifier evaluates to find a native read in it (§7). */
  testReads: number
  /** The throw-depth cap: how many calls into the code's own functions are followed to judge that a `try` can't throw. */
  throwDepth: number
  /** The flag-depth cap: how many calls deep a once-flag's assignment is followed from the path its test lets through. */
  flagDepth: number
}

/** What bounds one link group's analysis. */
export interface Budget {
  /**
   * The step budget per source byte (UTF-8) of a link group's members: a group of `n` bytes has `n *
   * stepsPerByte` steps, rounded down. Set with margin over the validation corpus, the scale fixture and the test
   * fixtures, so that it never fires on them (§18).
   */
  stepsPerByte: number
  caps: Caps
}

/**
 * The budget monkeypatchlist ships. The costliest group per byte measured on 2026-09-29 took 162 steps per byte on the
 * validation corpus (a 4 KB zone.js-style sweep), 130 on the scale fixture (react-dom) and 45 in the test fixtures, so
 * 1024 left about a sixfold margin. At `depth` 24 / `contexts` 256, webpack promise-polyfill takes about 3,150
 * steps per byte (its recursion found provisionally once per heap instance), so R1 raises the budget to 4096, where it
 * fires on no corpus site, rather than lose results to it.
 */
export const defaultBudget: Budget = {
  stepsPerByte: 4096,
  caps: {
    alternatives: 16,
    foldLength: 1 << 20,
    // Where the corpus results converge: raising both ×4 again changes nothing more.
    depth: 24,
    contexts: 256,
    iterations: 256,
    nesting: 64,
    indexRounds: 3,
    aliasDepth: 8,
    heapDepth: 8,
    descriptorAlternatives: 64,
    candidateRuns: 256,
    testReads: 64,
    throwDepth: 4,
    flagDepth: 4,
  },
}

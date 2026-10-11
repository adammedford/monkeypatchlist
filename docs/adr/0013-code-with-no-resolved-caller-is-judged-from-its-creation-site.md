# Code with no resolved caller is judged from where it was created, and a basis move is not a change

Some functions have no call the analyzer can resolve: callbacks kept on the heap, observable subscribers, returned `stop()` closures, exports nothing in the scan calls. Before this decision they ran as their own install entries, so their writes read `unconditional` and lost every config guard on the real call path. Datadog's `trackWebSockets` wrappers read `unconditional` on 7 of 9 builds, although the code is gated on config. And whether a caller resolved depends on the bundler, so reachability also differed between builds of the same app. The rule for what makes a finding `changed` requires reachability to be the same on every build.

We decided two things:

- **Creation site.** A function can only run after its value has been created. So code reached only through a function with no resolved caller is judged from the function's **creation site**: the reachability of the code that created it, the guards in force where it was created, and then the function's own guards. Its install context is `deferred`. A top-level declaration is created unconditionally at load, so it keeps its old result. A function whose creation the analyzer never evaluated is `unknown`.
- **Reachability basis.** Every occurrence records its **reachability basis**: `call-path` or `creation-site`. Reachability and install context feed `changed` only when both sides have the same basis. A different value with a different basis is `existing`, with a basis note that shows before → after.

## Considered options

- **`unknown` for all caller-less code.** Rejected. It loses Datadog's config guard just as `unconditional` does. On the prototype corpus, reachability accuracy falls from 94.0 to 84.1, and variance across bundlers rises from 53 to 68 targets.
- **`unconditional` with an `entry: unresolved` note.** Rejected. This was the old behaviour. The note does not fix the value, and the variance remains.
- **The most-reaching value over every possible caller.** Rejected. The call was unresolved, so any unknown call site could be a caller. In practice that gives `unconditional` again.
- **Drop reachability and install context from `changed`,** the fallback considered when `changed` was defined. Rejected. Reviewers would lose the signal when a guard is removed, on every finding, to fix a problem that only affects findings whose basis moved.
- **Also AND the creation site into chains whose callers resolved.** Rejected. It would change resolved findings for little gain, because the creation path is usually a prefix of the resolved call path.

## Consequences

- On the prototype corpus (a scratch driver, with the resolver unchanged), accuracy against the hand labels is 100 (from 94.0). Datadog's WebSocket targets read `conditional` on all 9 builds. Targets whose reachability varies across bundlers drop from 54 to 37. Under the basis rule, 8 would still be `changed`, all of them resolver differences.
- A code change that moves a guard and, at the same time, moves whether a caller resolves shows up as `existing` with a basis note, not as `changed`. So `--fail-on changed` does not trip on it. We accept this trade-off. The note stays visible, and gating on notes belongs to Release 2 policy.
- Baseline entries store the basis next to `reachability` and `installContext`.
- R0 checks invariance by diffing every pair of builds of a library as if one were the other's baseline. That diff must give zero `changed`.

## Amendment (2026-09-26)

[ADR 0014](0014-reachability-and-install-context-do-not-feed-changed-in-r1.md) takes reachability and install context out of `changed` in R1. The creation-site rule and the reachability basis still decide the reported reachability. The basis clause of `changed`, the baseline's stored basis and the pairwise zero-`changed` check on these attributes are dormant in R1.

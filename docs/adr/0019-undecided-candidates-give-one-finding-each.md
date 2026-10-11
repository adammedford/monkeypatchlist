# Undecided candidates give one finding each

A write's holder or member can come from a branch that neither constant folding nor the catalog can settle, e.g. `(cond ? window : history).pushState = w`. The confidence rules listed `holder-alternatives` and `member-alternatives` as confidence reasons, which implied one finding per candidate, but nothing decided that, and §4 said a runtime-chosen holder gives one target. The rule: a **candidate set** of up to 4 resolved holders or members gives one finding per candidate, each with its own fingerprint, and each occurrence carries the matching `*-alternatives` target-confidence reason. Above 4, the site is treated as partially resolved: a holder set becomes an `unresolved-holder` limitation listing the candidates, and a member set follows the wildcard rule ([ADR 0004](0004-wildcard-targets-are-findings.md)). A holder the catalog *can* choose still gives one target (§4). Decided by the maintainer, 2026-09-26.

## Considered options

- **One finding on a synthetic "either" target.** Rejected. It isn't a catalog name, so the protected surface, the baseline and the policy can't reason about it, and it churns whenever the set changes.
- **Only an `unresolved-holder` limitation.** Rejected. It hides real mutations of protected targets (`History.prototype.pushState`) behind a counter, even when every candidate is known.
- **No cap.** Rejected. Wide sets come from imprecision, not from real code, and would flood the baseline with findings that appear and vanish as the analysis changes.

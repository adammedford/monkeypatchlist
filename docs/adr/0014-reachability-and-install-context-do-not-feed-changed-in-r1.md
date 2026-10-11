# Reachability and install context do not make a finding `changed` in R1

This reverses the option [ADR 0013](0013-code-with-no-resolved-caller-is-judged-from-its-creation-site.md) rejected, and amends the rule for what makes a finding `changed`. Decided by the maintainer on 2026-09-26.

In R1, `changedReasons` are `attribution`, `effect` and `locks` only. Reachability and install context are still computed and reported on every finding, but a difference in either is `existing` with an informational note that shows before → after. So `--fail-on changed` does not trip on it. The baseline doesn't store them, because baseline entries are limited (spec §11) to the attributes that decide `changed`. The note compares against a previous scan's JSON when one is supplied, and is otherwise omitted.

Reachability and install context are the attributes that vary most between builds of the same code. On the protected surface of the prototype corpus, 36 targets vary in reachability and 16 in install context, and the basis rule doesn't excuse them. They also describe the guard, not the mutation, so a gate should act on them least. Keeping them in `changed` would have kept a prototype task on the spec's critical path for an attribute R1 can report without gating on it.

## Considered options

- **Keep them, with ADR 0013's basis rule.** Rejected for R1. The variance is resolver behaviour that production code must first show is gone.
- **Drop reachability altogether.** Rejected. The brief distinguishes guarded polyfills from replacements, and reviewers need that distinction.

## Consequences

- ADR 0013's creation-site rule and reachability basis still decide the *reported* reachability. Its `changed` clause is dormant in R1.
- Making them `changed` reasons again is a baseline format bump, done once implementation shows identity invariance for these attributes.
- A removed guard is visible as a note, not as a gate failure. Gating on notes belongs to Release 2 policy.

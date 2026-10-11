# The R0 bar is an implementation acceptance criterion, gated on the protected surface

This amends the earlier R0 precision bar. Decided by the maintainer on 2026-09-26.

Passing the R0 bar was a precondition of writing the R1 spec. The prototype resolver, the corpus and the variants kept growing to meet it, and after 51 resolved investigations no spec section was drafted. The prototypes had already shown what the spec needs: the semantic model reaches observed recall 0.94 and the full headline set. What remained was resolver quality, which production code will close better than a throwaway prototype.

We decided:

- **Where it sits.** The spec states the bar in §20 as an acceptance criterion of the implementation phase. Evidence work on the map stopped on 2026-09-26. Freezing, holdout scoring and per-disagreement triage run against the production resolver.
- **What is gated.** Precision, recall and invariance are judged on the protected surface. The whole catalog is reported for information, with no bar. The gate fires only on `added`/`changed` within the protected surface by default, so an unprotected false positive never fails a pipeline.
- **Which variance blocks.** **Identity invariance** is zero-tolerance: a protected target found by two builds of a library has the same realm, target, effect and locking, and the same fingerprint when both builds have the same map status. A simulated baseline diff between any two builds gives zero `changed`. **Set invariance**, where one build finds a target another misses, is reported per library and per bundler as a named known limitation. Recall is barred per bundler, so that one weak bundler cannot hide in an average.

## Considered options

- **Keep "R0 passes, then spec".** Rejected: it made evidence the critical path.
- **Zero tolerance for finding-set differences, everywhere or on the protected surface.** Rejected. A set difference is a coverage fact that a user only meets when switching bundler. Identity variance is what creates false `changed` and `added` findings in a pipeline.
- **Gate the whole catalog.** Rejected. Code outside the protected surface only reaches users under `--surface all`, which they opt into knowingly.

## Amendment (2026-09-26)

Decided by the maintainer: CDN builds are not in the identity-invariance pairs. A CDN script keys `url:` and a bundled build `pkg:`, so the pair is correctly `changed` (`attribution`). CDN ↔ bundled differences are reported per library with set invariance. Every bar blocks acceptance except recall, whose miss may instead become a named limitation.

## Amendment (2026-10-09)

Decided by the maintainer: two differences between builds with the same map status no longer fail identity invariance. An attribution key that moves between `pkg:` and `unknown` counts as `existing` with a `rekeyed` note, as it already does across maps and nomaps. And the cases where esbuild composes a dependency's source maps differently are exempt and named as a known limitation: a helper call mapped to its start rather than to the member, which fails the token check, and a dependency's composed source that climbs into the application's `src/`, which keys `app:`. The rest of the decision stands. Realm, target, effect and locking must still match, and any other fingerprint difference or `changed` between two builds blocks acceptance.

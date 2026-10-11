# Findings claim static capability; the runtime diff is not the precision oracle for code that never ran

A finding claims that the scanned code mutates its target when it runs. It does not claim that the mutation happened in a particular page load. Reachability says how likely the code is to run. So R0 precision asks "is this real mutating code?", not "did one Chromium run observe it?" The runtime diff is the oracle for code that ran. Code that did not run (lazy chunks, config-gated paths, polyfill and feature-detection branches) is confirmed first by **exercise variants** of the corpus: features-on configs, loaded lazy chunks, and a native-absent run whose deleted natives come from a hand-curated list with citations, independent of the resolver. Whatever no variant reaches is confirmed by hand triage with a citation.

## Considered options

- **Runtime behaviour: a finding claims the mutation happens on a normal load.** Rejected. It would make every `conditional` and `guarded-native-absence` finding a false positive by definition. It would push R1 to suppress real code, such as New Relic's replay chunk or core-js's forced branches, that a change-governance reviewer needs to see. And it would make findings depend on one browser and one configuration.
- **Hand triage alone.** Rejected as the first line. About 600 citations, mostly rrweb canvas members and core-js, is a lot of judgement to put behind a precision bar. Variants give reproducible evidence instead.
- **A native-absent list derived from the resolver's own findings.** Rejected. The resolver would be choosing its own oracle.

## Consequences

- Precision is reported twice: runtime-confirmed only (base run plus variants), and including counted hand relabels. The bar is judged on the second, and only if every relabel has a citation.
- Findings that can only run where a native is missing are true positives if they are tagged `guarded-native-absence` or `conditional`. Tagged `unconditional`, they are reachability defects.
- The sealed holdout needs the same variants, built in a sealed session, before it is scored.

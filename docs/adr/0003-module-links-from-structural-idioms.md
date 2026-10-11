---
status: partly superseded by ADR-0010 (links across the chunks of one build)
---

# Module links come from structural idioms, not bundler recognition

monkeypatchlist follows calls between bundled modules inside one artifact (webpack factory tables, esbuild and Rolldown lazy `{exports}` thunks, Rollup memoized `requireX` getters). It does this by matching a small set of structural module-linking idioms, never by identifying the bundler or its version. The brief requires the scanner to stay independent of webpack, Vite, Rollup and similar tools. The R0 bar also requires identical findings across bundlers. Minified runtime names (`n`, `o`, `e`) carry no signal, while the shapes are stable, and several bundlers emit the same shape: esbuild `__commonJS` and Rolldown `__commonJSMin` are one idiom. A new bundler that emits these shapes works without changes.

## Considered options

- **Named runtimes** (matching `__webpack_require__`, `__commonJS` per bundler version) were rejected. They tie the analyzer to bundler release cycles and contradict the brief's independence rule.
- **Purely generic semantics** (summaries strong enough that any runtime falls out) were rejected. They need constant-key heap and object reasoning that R1 otherwise places beyond scope.

## Consequences

- An unrecognized runtime is indistinguishable from ordinary code, so it degrades silently. Only breaks in a recognized link can be reported (`unlinked-module-call`).
- Output reports the idioms that matched, never a bundler name.
- Module and chunk ids are build-local. They appear in the resolution trace but never in a fingerprint or the baseline.
- Links stay inside one artifact. Linking across chunks of one build is Release 3.

## Amendment (2026-09-26)

Decided by the maintainer. The resolver prototype found that all six idioms fall out of the general call and heap semantics R1 needs anyway, with no idiom-specific code. The rejection of "purely generic semantics" above no longer holds as an implementation rule. The six idioms stay as R1's **conformance statement**: what is promised and tested (spec §6), and the implementation may get the links either way. Output still reports matched idioms and never a bundler name.

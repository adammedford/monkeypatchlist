# Fingerprints have no callsite component; moved attribution is paired by target key

A finding's fingerprint is `(realm, target, effect, attribution key)`, written as a readable string (`window|Window.fetch|wrap|pkg:@sentry/core`). It has no callsite component, so every site that makes the same mutation under one attribution key is one finding with several occurrences. When the attribution key moves while the mutation stays the same, such as Sentry 7→10 moving its instrumentation from `@sentry/utils` to `@sentry/core` and `@sentry/browser-utils`, or source maps appearing or disappearing, a second matching pass on the **target key** `(realm, target, effect)` pairs the baseline entry with the scan finding instead of reporting removed plus added. The reason is baseline stability. Every candidate callsite component churns on changes that aren't changes to the platform: ordinals shift when a site is added earlier in the file, AST shapes shift with the minifier and with wrap forms (`fill` → `Proxy`), and names from the source map's `names` are missing without maps. What the baseline governs is the state of the platform ("Sentry wraps `fetch`"), not how many sites produce it.

## Considered options

- **Ordinal per target within the attribution key**: rejected because it shifts whenever a site is added earlier in the file.
- **Normalized AST shape**: rejected because it changes with the minifier and would break the Sentry 7→10→11 no-change pair.
- **Enclosing function name from the source map's `names`**: rejected because it is missing without maps and changes on renames.
- **Curated package families** (`@sentry/*` → `sentry`): rejected because it is data to maintain, and changing it re-keys findings. The target-key pass covers the same cases with no data.

## Consequences

- If a package adds a second site that makes an existing mutation (a second `fetch` wrapper), it is only a new occurrence and never `added`.
- A target-key pair between two known keys is `changed` (reason `attribution`). A pair where either side is `unknown` is `existing` with a `rekeyed` note. Known keys pair only 1:1. `unknown` pairs with every unmatched entry on the other side.
- SARIF `partialFingerprints` carries both keys: `monkeypatchlist/v1` (the fingerprint) and `monkeypatchlistTarget/v1` (the target key).

## Amendments

From the rule for what makes a finding `changed` (2026-09-24): a pass keyed on `(realm, target, attribution key)` now runs **before** the target-key pass. Among entries left unmatched by the exact fingerprint, it pairs 1:1 on that key, and the pair is `changed` with reason `effect`. The order matters. If the baseline has `pkg:a` wrapping `fetch`, and the scan has `pkg:a` replacing `fetch` plus a new `pkg:b` wrapping it, running the target-key pass first would present `b` as a rename of `a`. A package keeping its name is stronger evidence than an effect staying the same. The full order is: exact fingerprint → same attribution key with a different effect (1:1) → target key → `unconfirmed`/`removed`.

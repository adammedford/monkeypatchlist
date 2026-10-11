# Unknown members become wildcard findings; unknown holders become limitations

A write where only one of holder or member resolves is handled asymmetrically. When the holder is known but the member isn't (Datadog's `console[api]` from config, zone.js's `proto[zoneSymbol(name)]`), monkeypatchlist reports a **wildcard target** such as `console.*` or `EventTarget.prototype.__zone_symbol__*`, which is a finding that is fingerprinted, baselined and gated like any other. When the member is known but the holder isn't (App Insights' ts-utils accessors, a patch-shaped `g.fetch = wrap(g.fetch)` through an alias carried across scripts), monkeypatchlist records an `unresolved-holder` coverage limitation and never a finding. The difference is what can be claimed with certainty. "Something on `console` is wrapped" is true and matters to change governance: a new SDK that wraps console members must not slip past `--fail-on`. "Something named `pushState` is wrapped" says nothing reliable, because the same name is common on objects that aren't native, and matching it would sink the R0 precision bar.

## Considered options

- **One finding per plausible member** (every `console` member for `console[k]`) was rejected. It turns five real targets into about twenty findings, hurts precision, and fills the baseline with noise.
- **A limitation for unknown members as well** was rejected. It hides a real, attributable mutation from the gate.
- **Catalog-name findings for unknown holders**, whether low-confidence or only for unique names, were rejected. Short names like `open`, `send` and `log` are everywhere on non-native objects. Under [ADR 0002](0002-shadowing-writes-name-the-written-object.md), even a unique name maps to more than one target (`history.pushState` vs `History.prototype.pushState`).

## Consequences

- A wildcard is emitted only when the holder's key is reused (the original is read or its descriptor fetched before the write), or when a constant prefix proves a non-native `add`. This keeps JSONP callbacks and bundler chunk globals silent.
- A wildcard and a resolved member on the same holder are separate findings. An analyzer or catalog upgrade that later resolves the member shows up in the baseline as `console.*` removed and `console.log` added.
- Wildcards don't lower target confidence, because they claim only what is known. In R0 they count as precision true positives but earn recall only for scoring groups they cover in full.

---
status: superseded by ADR-0015
---

# Scripts of one entry document link through the global names they share

This narrows [ADR 0010](0010-module-links-cross-the-chunks-of-one-build.md)'s statement that plain global sharing between classic scripts is not a link. The rule that script evaluation order is not modelled stands.

CDN-installed SDKs are started by another script on the same page: an inline loader snippet calls the SDK's global (`new Microsoft.ApplicationInsights.ApplicationInsights({...}).loadAppInsights()`, `window.DD_RUM.init({...})`, `Sentry.init({...})`), or it writes a config global that the SDK reads when it loads (`NREUM.init = {...}`). If each script is analysed alone, the SDK's install code has no resolved caller and none of the page's config. App Insights' CDN build then resolves none of its 7 observed targets. Sentry's and Datadog's CDN builds fall back to caller-less entries, so their install context and reachability differ from the same SDK bundled with the same init call. The R0 bar requires every build of a library, the CDN build included, to give the same findings and the same `changed` attributes.

R1 therefore adds a **global link**. When a script that an entry document loads reads a non-native global name, it links to the scripts of the same document that write that name. The link groups on both sides merge and are analysed as one program. No evaluation order is modelled: a read sees every writer in the group as maybe-absent, the same way the heap treats a property written after allocation. Native names keep resolving against the unmutated catalog and never form a global link.

## Considered options

- **A documented R1 limitation, with CDN sites scored on caller-less install entries only.** Rejected. It breaks bundler invariance for every CDN-installed SDK, and App Insights' CDN build finds nothing. Enterprise pages often load SDKs through vendor CDN snippets, so this is not a corner case.
- **One program per entry document (every script on the page).** Rejected. Unrelated third-party tags would share one heap and one step budget, and link groups would grow past the link-group size target (spec §18) for no gain in recall.
- **Scan-wide global links per realm, as the lexical-name check of spec §3 does.** Rejected. Pages that don't share a global would be merged through common names such as `config` or `dataLayer`, and sweep-only scripts have no page to share a global with.
- **Evaluation-order modelling from document order.** Rejected for the reasons the no-evaluation-order rule rests on: `async` and injected scripts have no fixed order, and globals are looked up when code runs, not when a script loads.

## Consequences

- A loader snippet's call is an ordinary resolved call. The install entry can sit in another artifact than the write it leads to. Config values from the snippet decide guards by the same rules as in a bundled app.
- Attribution and fingerprints still come from the write site. The snippet only appears as install-entry evidence and as a hop in the resolution trace.
- An SDK loaded by several entry documents is analysed once per document group. Findings merge by fingerprint, and each occurrence takes its most-reaching result.
- A script element that the page creates with a constant `src` becomes a reference, so async loader snippets bring their SDK into the scan. A non-constant `src` is an `unresolved-reference` limitation.
- Links now come in two kinds (module links and global links), and one link group can mix them.

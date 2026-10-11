# Global links are deferred to Release 3

This supersedes [ADR 0012](0012-scripts-of-one-entry-document-link-through-shared-global-names.md) and restores [ADR 0010](0010-module-links-cross-the-chunks-of-one-build.md) as written: plain global sharing between classic scripts is not a link. Decided by the maintainer on 2026-09-26.

ADR 0012 added global links so that a vendor's CDN build, started by a loader snippet, would give the same findings and `changed` attributes as the same SDK bundled into an app. That parity came from the corpus's invariance bar, not from the brief. An R1 user scans their own build, and the brief puts deeper inter-file resolution in Release 3. Global links were also the least-measured branch: they needed their own prototype, loader-snippet corpus sites and a CDN lazy-chunks page.

R1 keeps two parts of ADR 0012, because they are resource discovery, not linking. A script element created with a constant `src` becomes a reference (discovery `injected`), so an async loader snippet still brings its SDK into the scan. A loader snippet is an ordinary install entry for its own writes.

## Consequences

- An SDK started only from another script has no resolved caller for its install code. Its code is still found, and it is judged from its creation sites ([ADR 0013](0013-code-with-no-resolved-caller-is-judged-from-its-creation-site.md)). Its reachability and install context may differ from the same SDK bundled with its init call. That is a named known limitation, and under [ADR 0014](0014-reachability-and-install-context-do-not-feed-changed-in-r1.md) it cannot cause `changed`.
- Findings that need the snippet's config or call to resolve at all are lost. Application Insights' CDN build is the known case: 7 observed targets. Also a named limitation.
- Link groups are built from module links only.

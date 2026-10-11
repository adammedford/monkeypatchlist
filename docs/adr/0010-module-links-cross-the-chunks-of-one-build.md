# Module links cross the chunks of one build; a link group is analysed as one program

This partly supersedes [ADR 0003](0003-module-links-from-structural-idioms.md)'s single-artifact scope. The structural-idiom rule itself stands.

The resolver prototype showed that lazy chunks call helpers exported by the entry chunk. Datadog's recorder chunk wraps CSS rules, input setters and canvas through the entry's `instrumentMethod`. Only esbuild's single-file build found those targets, so single-artifact linking broke bundler invariance on ordinary Rollup, Vite and webpack builds. Under [ADR 0009](0009-findings-claim-static-capability.md) that code is real, so the gap is a recall failure.

R1 therefore follows module links **between artifacts that the artifact graph of one scan connects**: local-build, inline, `data:` and fetched remote artifacts of the realm. The links are static and dynamic imports, chunk-loader URLs, and webpack chunk-registry pushes. It analyses each **link group** (an entry plus everything linked from it) as one program with one heap and one realm. Plain global sharing between classic scripts is still not a link; see spec §6.

## Considered options

- **Keep single-artifact links and compare invariance over the same modules.** Rejected. It would leave R1 blind to the lazy features of most modern builds, since Rollup and Vite split into ESM chunks by default, and session replay and profilers live in those chunks.
- **Per-artifact export summaries composed at link time.** Deferred. It is cheaper and incremental, but it is a second analysis design with unmeasured precision. It stays the fallback if the resolver cost budget (spec §18) rules out whole-group analysis.

## Consequences

- A chunk reachable from several entries is analysed once per link group. Findings merge by fingerprint, and occurrences name the chunk's artifact.
- Code reached only through a dynamic load has install context `deferred`. Its reachability follows the load call's guards.
- A broken cross-artifact link raises `unlinked-module-call` when a native holder and member flow into it.
- The corpus vendors the lazy chunks that CDN loaders fetch, so CDN sites and app builds contain the same code.

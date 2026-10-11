# Limitations

monkeypatchlist is a static scanner: it reads deployed code and never runs it. This page lists what that costs, and what this release leaves out. Where a gap can hide a mutation, the scan reports it as a [limitation](concepts.md#completeness) in its completeness block, so you can tell "no mutations found" from "no mutations found, but two scripts were not analyzed".

## Scope

monkeypatchlist is not:

- a runtime monitor. It reports what the code can do when it runs, not what happened in a page load.
- a crawler. It scans a build directory. For an app rendered on the server, capture the HTML and pass it with `--entry`.
- a security scanner. It doesn't look for malware, data exfiltration, prototype-pollution exploits, fingerprinting or CSP problems.

Not yet available: SARIF output, policy files with per-finding exceptions, runtime profiles for a chosen set of browsers, and configurable limits for remote retrieval. HTML reports are not planned: the terminal and JSON reports are the output.

## Performance

Release 1's analyzer is slow, and its time and memory grow faster than the code it scans. These are measured worst cases on an Apple M4 Pro (12 CPUs, 24 GiB), with Node 26.8.1:

| Input | Time | Peak memory |
| --- | --- | --- |
| SDK and polyfill builds in the validation corpus (10–100 KB) | up to 860 s per MB: 60 s for a 70 KB core-js build | up to about 33,000× the source size: 2.3 GB for a 70 KB core-js build |
| A synthetic 1 MB bundle of every corpus SDK | about 6 minutes (341 s per MB) | 4.5 GB |
| The same bundle at 2.5 MB (an earlier build of the analyzer) | about 10 hours | not recorded |
| The same bundle at 5 MB | not measured: stopped after an hour | not measured |

A small hosted CI runner (2 vCPUs, 8 GB) is slower, and can run out of memory on bundles of a megabyte or more. Try monkeypatchlist on your own build before you gate CI on it. Results don't depend on the machine: a slower machine gives the same report, later. A faster analyzer is planned for a later release.

## Catalog

- **APIs missing from the Web IDL sources aren't catalogued.** About 48 interfaces that some browser ships but the standard Web IDL data lacks (such as `SharedStorage`, `WebSocketStream`, `ReportBody`, `FeaturePolicy`, `StyleMedia`, and some Firefox- or Safari-only ones) have no targets, so writes to them give nothing.
- **Iterator prototypes aren't catalogued.** The per-interface iterator prototypes that Web IDL `iterable` declarations create (such as the `Headers` iterator's `next`) are reached only through instances, so writes to them give nothing.
- **core-js's well-known-symbol store isn't resolved.** core-js's `@@iterator` and `@@unscopables` writes, made through its `wellKnownSymbol(name)` helper, give no findings.

## Discovery and linking

- **Scripts of one page aren't linked to each other.** An SDK started by a loader snippet or an inline `init()` call is judged without the snippet's configuration, so its reachability and install context can differ from the same SDK bundled with its `init()` call, and writes that resolve only through the snippet's call are missed. Application Insights' CDN build is a known case.
- **No evaluation order between classic scripts.** A write through an alias carried from one classic script to another (`var g = window` in one, `g.fetch = wrap(g.fetch)` in another) becomes an `unresolved-holder` limitation, and a plain replace through such an alias (`g.fetch = w`) is missed.
- **Unrecognized module runtimes degrade silently.** monkeypatchlist recovers module links from six structural idioms that bundlers use, and is tested against webpack, Vite, Rollup and esbuild. A bundler with an unrecognized runtime can leave modules unlinked.
- **URLs computed at runtime are never guessed.** A non-literal dynamic import, worker URL or injected script `src` is an `unresolved-reference` limitation.
- **`document.write` and `createContextualFragment` aren't followed.** Only a script element that code creates and inserts counts as an injected script.
- **Some HTML isn't analyzed.** Inline event-handler attributes and `javascript:` URLs are counted, not analyzed. `<template>`, `<noscript>` and `iframe srcdoc` contents are ignored, although a local file a `<script src>` there names is still scanned.
- **`<script nomodule>` isn't followed**, nor is an injected script whose `noModule` is set. A remote legacy bundle only older browsers run is counted, not scanned. A local one is still found by scanning the build directory. An injected script whose `noModule` can't be read is followed and also counted.
- **Scripts found only by scanning the build directory are assumed to run in the window**, unless they show worker markers, in which case the scan raises `realm-uncertain`.
- **A failed inline module's dynamic imports stay resolved.** Chromium never resolves them, because the module never runs.
- **CORS isn't modelled.** A cross-origin `<script integrity>` without `crossorigin` is analyzed when its digest matches, although a browser would block it.
- **One read per realm and URL.** When one reference to a URL fails its integrity check, the bytes are withheld for every reference to that URL in that realm.
- **Worker realms** are analyzed, but their accuracy has been validated less than the window's.

## Detection

- **An unknown holder with a known member is never a finding.** Code that patches through accessor helpers, API objects stored on the heap, or prototype walks from an object monkeypatchlist can't resolve gives an `unresolved-holder` limitation naming the members it could have changed.
- **Members under a wildcard aren't named individually.** `console.*` covers whatever the loop touches.
- **Writes where neither the holder nor the member resolves give nothing**, and aren't counted.
- **A prototype change on an unresolved object is missed**, including Babel's `_inherits` and `_setPrototypeOf` helpers.
- **Freezing a native object isn't reported.** `Object.freeze`, `Object.seal` and `Object.preventExtensions` of a native object, as SES `lockdown()` does, give nothing.
- **A write that always throws doesn't prune the code after it**, so a script that fails while loading can be over-reported.
- **An index write on `Array.prototype` gives one finding.** Writing an index at or past `Array.prototype`'s length also changes its `length`; that is part of the `add` finding, not a separate one.
- **Firefox and WebKit behaviour isn't checked.** monkeypatchlist follows Chromium where engines differ, such as for shadowing writes on `Storage` and `WindowProperties`.
- **Different bundlers can find different sets.** The same library bundled by two bundlers can give a target in one build that the other misses. A finding both builds report has the same identity in both, when both have source maps or both lack them.

## Reachability

- **Reachability and install context can differ between builds** of the same code, when a call resolves in one build and not in the other. This is reported as a note, never as `changed`.
- **Configuration SDKs fetch at runtime isn't modelled**, such as Application Insights' remote config.

## Attribution

- **Without source maps, bundled code is attributed to `unknown`.** Package versions need versioned paths or `--lockfile`, and introducing dependencies need `--lockfile`.
- **Escaped sources are `unknown`.** Composed source maps (Next.js, Angular with Bazel) can name a package's file with a path that has lost its `node_modules/<name>` part. monkeypatchlist recognizes two framework shapes; Next.js's `src/shared/`, `src/lib/` and `src/build/` sources, and Angular 19.2.10 and earlier, stay `unknown`.
- **Sources with an unrecognized scheme** (`app:`, `http(s):`, `data:`, `ng:`) are `unknown`, even when the path names a package.
- **Vendored code** is attributed to the package its path names, which may not be installed.
- **Scoped packages under Yarn's pnpm linker are `unknown`**, because their folder names can't be mapped back to package names.
- **Raw U+2028 and U+2029 characters** in a script can shift mapped positions.

## Remote retrieval

- **A resolve-mode scan is only as deterministic as the remote scripts.** A vendor URL that serves new code gives ordinary `added` or `changed` findings.
- **The retrieval limits are fixed.** References beyond the per-scan count, size or time limits are `remote-refused` or `fetch-failed`.
- **Remote source maps are evidence only.** A remote script keeps its `url:` key, even when its source map names a package.

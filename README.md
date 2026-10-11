# monkeypatchlist

monkeypatchlist is a CI gate for the browser platform. It scans your deployed JavaScript statically, finds the code that changes native browser and ECMAScript APIs, says which package or source file that code came from, and tells you what changed since the baseline you last accepted:

> What changed the browser platform, who introduced it, and is that change new?

**Release 1 is an early release.** It models Chromium's behaviour, it is slow on large bundles (see [Performance](#performance)), and it has rough edges. Please [report what you find](https://github.com/adammedford/monkeypatchlist/issues).

## Why

Monitoring SDKs, polyfills, zone libraries and your own code all reach into the platform the rest of the page shares. They wrap `fetch`, replace `history.pushState`, patch `XMLHttpRequest.prototype.open` and add methods to `Array.prototype`. Each change is usually deliberate, but it is rarely reviewed. A dependency upgrade can start wrapping a new API without a line of your code changing, and when something breaks in production, nobody knows which bundled package hooks `fetch`.

monkeypatchlist turns those changes into reviewed changes. You commit a baseline of the platform mutations your app makes today, and CI fails when a build adds a new one or changes an existing one. It names every mutation the same way on every build, so a rebuild, a renamed chunk or a new minifier never shows up as a change, and it reports what it couldn't analyze instead of passing silently.

## Install

```sh
npm i -D monkeypatchlist
```

monkeypatchlist needs Node.js 24 or later. It runs offline by default and executes none of the code it scans.

## Performance

Release 1's analyzer is slow, and scan time grows faster than bundle size. On an Apple M4 Pro, the SDK and polyfill builds in the validation corpus each scan in seconds to a few minutes. A synthetic 1 MB bundle took about 6 minutes, and a 2.5 MB bundle took about 10 hours. Try it on your own build before you add it to CI. A faster analyzer is planned. [Limitations](docs/limitations.md) has the measured numbers.

## Quickstart

**1. Scan your build.** monkeypatchlist scans build output, not source. Point it at the directory you deploy, and tell it the URL that directory is served from with `--map`, so the references in your HTML resolve to files:

```sh
npx monkeypatchlist scan dist --map https://shop.example/=.
```

The report lists each platform mutation the build makes. Without source maps every finding's package is `unknown`, so the next step adds them.

**2. Save your settings.** Put the mapping, your source-map directory and your lockfile in `monkeypatchlist.config.json`, so every command picks them up. Source maps name the package behind each finding, and the lockfile adds its version:

<!-- docs-test: file monkeypatchlist.config.json -->
```json
{
  "name": "Storefront",
  "mappings": [{ "url": "https://shop.example/", "dir": "." }],
  "sourceMaps": ["maps"],
  "lockfile": { "path": "package-lock.json" }
}
```

**3. Accept what's there today.** Write a baseline of the current findings, and commit it next to your code:

```sh
npx monkeypatchlist baseline init dist
git add monkeypatchlist.config.json monkeypatchlist.baseline.json
```

**4. Gate CI.** Run the scan with `--fail-on added,changed` after your build. It passes while the build makes only the mutations the baseline accepted:

```sh
npx monkeypatchlist scan dist --fail-on added,changed
```

When a dependency upgrade starts wrapping `XMLHttpRequest.prototype.open`, the same command fails the build and names the package, its previous version and the line that does it:

<!-- docs-test: build v2 -->
```sh
npx monkeypatchlist scan dist --fail-on added,changed   # exits 1
```

<!-- docs-test: output -->
```text
monkeypatchlist 0.1.0 · catalog 1 · Storefront · surface protected · offline

Change since baseline
  Added 1   Changed 0   Removed 0   Unconfirmed 0   Existing 2

Added
  XMLHttpRequest.prototype.open    wrap
    Package          @example/telemetry@2.0.0
    Previous version @example/telemetry@1.4.0
    Source           ../../node_modules/@example/telemetry/index.js:17 (assets/main-RFTVJBC6.js:1:317)
    Provenance       bundled dependency · load · unconditional
    Confidence       target high · mutation high · attribution high
    Fingerprint      window|XMLHttpRequest.prototype.open|wrap|pkg:@example/telemetry

Notes
  Window.fetch                     @example/telemetry 1.4.0 → 2.0.0
  XMLHttpRequest.prototype.open    @example/telemetry 1.4.0 → 2.0.0

Completeness   complete
  Known 1 · analyzed 1 · failed 0 · skipped 0
Inputs
  Source maps  1 / 1 artifacts
  Lockfile     package-lock.json
Outside scope  none
Ineffective writes 0

Gate  fail-on added,changed → FAIL (1 finding)   exit 1
```

**5. Accept a change on purpose.** If the new mutation is intended, accept it into the baseline and commit the baseline with the upgrade, so the change is reviewed in the same pull request:

```sh
npx monkeypatchlist baseline update dist
```

The quickstart's build is the example in [docs/examples/storefront](docs/examples/storefront/).

## A real scan

This is monkeypatchlist's report for a Vite build of an app that imports the [`whatwg-fetch`](https://github.com/JakeChampion/fetch) polyfill, from the validation corpus monkeypatchlist is tested against. The polyfill installs `fetch`, `Headers`, `Request` and `Response` only where the browser lacks them, which the scan reports as `guarded-native-absence`:

<!-- docs-test: corpus dist/vite/whatwg-fetch/maps -->
```sh
npx monkeypatchlist scan dist/vite/whatwg-fetch/maps --map https://app.corpus.test/=.
```

<!-- docs-test: output -->
```text
monkeypatchlist 0.1.0 · catalog 1 · maps · surface protected · offline

Findings 4   (no baseline: run with --baseline to see the change)
  Window.Headers                   replace
    Package          whatwg-fetch
    Introduced by    unknown (no lockfile)
    Source           ../../../../../node_modules/whatwg-fetch/fetch.js:639 (assets/index-9dL12JRx.js:2:3031)
    Provenance       bundled dependency · load · guarded-native-absence
    Confidence       target high · mutation high · attribution high
    Fingerprint      window|Window.Headers|replace|pkg:whatwg-fetch
  Window.Request                   replace
    Package          whatwg-fetch
    Introduced by    unknown (no lockfile)
    Source           ../../../../../node_modules/whatwg-fetch/fetch.js:640 (assets/index-9dL12JRx.js:2:3043)
    Provenance       bundled dependency · load · guarded-native-absence
    Confidence       target high · mutation high · attribution high
    Fingerprint      window|Window.Request|replace|pkg:whatwg-fetch
  Window.Response                  replace
    Package          whatwg-fetch
    Introduced by    unknown (no lockfile)
    Source           ../../../../../node_modules/whatwg-fetch/fetch.js:641 (assets/index-9dL12JRx.js:2:3055)
    Provenance       bundled dependency · load · guarded-native-absence
    Confidence       target high · mutation high · attribution high
    Fingerprint      window|Window.Response|replace|pkg:whatwg-fetch
  Window.fetch                     replace
    Package          whatwg-fetch
    Introduced by    unknown (no lockfile)
    Source           ../../../../../node_modules/whatwg-fetch/fetch.js:638 (assets/index-9dL12JRx.js:2:3021)
    Provenance       bundled dependency · load · guarded-native-absence
    Confidence       target high · mutation high · attribution high
    Fingerprint      window|Window.fetch|replace|pkg:whatwg-fetch

Completeness   complete
  Known 1 · analyzed 1 · failed 0 · skipped 0
Inputs
  Source maps  1 / 1 artifacts
  Lockfile     not given · no lockfile versions; Introduced by unknown
Outside scope  other 1   (run with --surface all)
Ineffective writes 0

Gate  not run (no --fail-on)
```

## What it covers

- **Tested on webpack, Vite, Rollup and esbuild.** monkeypatchlist reads build output, not bundler metadata, and recovers module structure from the code itself. Builds from other bundlers may scan with some modules left unlinked (see [Limitations](docs/limitations.md)).
- **Real mutations only.** Assigning a writable attribute such as `location.href` is API use, not a mutation, and a write the browser rejects is recorded as ineffective, never as a finding.
- **The APIs that matter by default.** Scans report the [protected surface](docs/concepts.md#protected-surface): networking, events, timers, navigation, storage, crypto, workers, `console` and the core ECMAScript built-ins. `--surface all` reports the whole native catalog.
- **Honest coverage.** Every report says whether the scan was `complete`, and lists what it could not analyze.

It does not run your code, crawl live sites, or look for malware. [Limitations](docs/limitations.md) lists what it can't see.

## Documentation

- [Getting started](docs/getting-started.md): inputs, a first scan, reading the report, adopting monkeypatchlist on an existing app
- [CI recipes](docs/ci.md): GitHub Actions and any other CI
- [Configuration and CLI reference](docs/configuration.md): every command, flag and config key, and the exit codes
- [Report format](docs/report-format.md): the JSON report
- [Concepts](docs/concepts.md): findings, fingerprints, attribution, baseline states, completeness and the protected surface
- [Limitations](docs/limitations.md)

Design decisions are recorded in [docs/adr](docs/adr/), and the vocabulary in [CONTEXT.md](CONTEXT.md). To work on monkeypatchlist, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE)

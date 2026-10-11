# Getting started

This guide takes an app from its first scan to a gate in CI. The examples use the storefront build in [examples/storefront](examples/storefront/): a small app bundled with esbuild, whose `@example/telemetry` dependency wraps `fetch`, and whose own route tracking wraps `history.pushState`. Every command here is run against it by monkeypatchlist's test suite.

## What monkeypatchlist needs

A scan reads what you deploy, not your source tree:

- **A build directory.** The output your bundler writes, for example `dist/`.
- **Entry documents.** The HTML files the scan starts from. The default is `index.html` in the build directory. An app rendered on the server has no static HTML, so capture a rendered page and pass it with `--entry`.
- **A URL mapping.** The URL each directory is served from, so that `<script src="/assets/main.js">` and the imports in your code resolve to files. Give one with `--map <urlPrefix>=<dir>`. When assets are served from a CDN, give a mapping for each prefix; the longest matching prefix wins.

Two inputs are optional, and each one adds to what a finding can say:

| You give | Each finding gets |
|---|---|
| the build directory | its target, effect, reachability and provenance. Bundled code has package `unknown` |
| + source maps | the containing package, the original file and line, and a version where the path carries one |
| + source maps and a lockfile | package versions, and the direct dependency that introduced each package |

Source maps can sit next to the scripts, or in a separate directory that you pass with `--source-maps`. Many teams keep maps out of the deployed directory; monkeypatchlist pairs them by debug ID or by the script's path, and checks that each map matches the code it is paired with. The lockfile is an npm, pnpm or Yarn lockfile, passed with `--lockfile`.

## A first scan

```sh
npx monkeypatchlist scan dist --map https://shop.example/=.
```

<!-- docs-test: output -->
```text
monkeypatchlist 0.0.0 · catalog 1 · dist · surface protected · offline

Findings 2   (no baseline: run with --baseline to see the change)
  Window.fetch                     wrap
    Package          unknown
    Source           assets/main-JLMSIHKU.js:1:159
    Provenance       unknown · load · unconditional
    Confidence       target high · mutation high · attribution low (no-map)
    Fingerprint      window|Window.fetch|wrap|unknown
  history.pushState                wrap
    Package          unknown
    Source           assets/main-JLMSIHKU.js:1:318
    Provenance       unknown · load · unconditional
    Confidence       target high · mutation high · attribution low (no-map)
    Fingerprint      window|history.pushState|wrap|unknown

Completeness   complete
  Known 1 · analyzed 1 · failed 0 · skipped 0
Inputs
  Source maps  0 / 1 artifacts · without a map: Package unknown for bundled code, no original locations · 2 findings have Package unknown
  Lockfile     not given · no lockfile versions; Introduced by unknown
Outside scope  none
Ineffective writes 0

Gate  not run (no --fail-on)
```

Each finding is one platform mutation: a **target** (`Window.fetch`, the `fetch` member of the global object) and an **effect** (`wrap`: the new value calls the original). Without source maps, monkeypatchlist can't tell whose code it is, and the `Inputs` block says what the missing maps cost.

Add the source maps and the lockfile:

```sh
npx monkeypatchlist scan dist --map https://shop.example/=. --source-maps maps --lockfile package-lock.json
```

<!-- docs-test: output -->
```text
monkeypatchlist 0.0.0 · catalog 1 · dist · surface protected · offline

Findings 2   (no baseline: run with --baseline to see the change)
  Window.fetch                     wrap
    Package          @example/telemetry@1.4.0
    Source           ../../node_modules/@example/telemetry/index.js:11 (assets/main-JLMSIHKU.js:1:159)
    Provenance       bundled dependency · load · unconditional
    Confidence       target high · mutation high · attribution high
    Fingerprint      window|Window.fetch|wrap|pkg:@example/telemetry
  history.pushState                wrap
    Package          none (first-party)
    Source           ../../src/route-tracking.js:4 (assets/main-JLMSIHKU.js:1:318)
    Provenance       first-party · load · unconditional
    Confidence       target high · mutation high · attribution medium (first-party-inferred)
    Fingerprint      window|history.pushState|wrap|app:src/route-tracking.js

Completeness   complete
  Known 1 · analyzed 1 · failed 0 · skipped 0
Inputs
  Source maps  1 / 1 artifacts
  Lockfile     package-lock.json
Outside scope  none
Ineffective writes 0

Gate  not run (no --fail-on)
```

Now `fetch` is wrapped by `@example/telemetry` 1.4.0, and `history.pushState` by the app's own `src/route-tracking.js`.

## Reading the report

The terminal report puts change first:

- **The title line**: the monkeypatchlist and catalog versions, the application name, the surface and the retrieval mode.
- **Findings, or the change since the baseline.** Without a baseline, every finding gets a card. With one, the report counts each [baseline state](concepts.md#baseline-states), and gives a card to each `added` and `changed` finding. Existing findings are only counted unless you pass `--verbose`.
- **A finding card**:
  - `Package`: the package whose code makes the mutation, with its version when monkeypatchlist knows it
  - `Introduced by`: the direct dependency that brought that package in, when a lockfile is given and it isn't the package itself
  - `Source`: the original file and line, then the position in the deployed script
  - `Provenance`: where the code came from (`bundled dependency`, `first-party`, `remote`, `inline` or `unknown`), whether the mutation runs at `load` or only when a function is called later (`deferred`), and how sure it is to run (`unconditional`, `guarded-native-absence`, `conditional` or `unknown`)
  - `Confidence`: how certain the analysis is of the target, the mutation and the attribution, with the reason for anything below `high`. It is not a risk score.
  - `Fingerprint`: the finding's identity in the baseline
- **Completeness**: `complete`, `complete-with-limitations` or `incomplete`, with what the scan could not analyze. See [Concepts](concepts.md#completeness).
- **Inputs**: what each missing input costs.
- **Outside scope**: how many findings outside the [protected surface](concepts.md#protected-surface) the scan left out, by surface.
- **Ineffective writes**: writes that try to change a native API but can't, such as assigning a read-only attribute. They are never findings. `--list-ineffective` lists them.
- **Gate**: the `--fail-on` result and the exit code.

To see why monkeypatchlist reported a finding, save the JSON report and ask `explain` for the finding, by fingerprint or by target. It prints every occurrence with the reasoning that connects the code to the target:

```sh
npx monkeypatchlist scan dist --map https://shop.example/=. --source-maps maps --json report.json
npx monkeypatchlist explain Window.fetch --report report.json
```

<!-- docs-test: output -->
```text
Window.fetch   wrap
  Fingerprint  window|Window.fetch|wrap|pkg:@example/telemetry
  Target key   window|Window.fetch|wrap
  Target       realm window · holder global
  Surface      networking
  Attribution  pkg:@example/telemetry · package @example/telemetry · provenance bundled-dependency
  Confidence   target high · mutation high · attribution high

Occurrence 1 of 1
  Location     assets/main-JLMSIHKU.js:1:159
  Artifact     https://shop.example/assets/main-JLMSIHKU.js
  Source       ../../node_modules/@example/telemetry/index.js:11:9
  Mechanism    assign · realm instance current
  Confidence   target high · mutation high · attribution high
  Trace
    binding      `window` resolves to no declaration, so it is the global object Window (window realm, current instance)
    token-check  `fetch` appears within one line of ../../node_modules/@example/telemetry/index.js:11:9, where the map puts the write
```

## A config file

Rather than repeat flags, put them in `monkeypatchlist.config.json` in the directory you run monkeypatchlist from. Every flag has a key, and a flag on the command line overrides its key. See [Configuration](configuration.md) for every key.

<!-- docs-test: file monkeypatchlist.config.json -->
```json
{
  "name": "Storefront",
  "mappings": [{ "url": "https://shop.example/", "dir": "." }],
  "sourceMaps": ["maps"],
  "lockfile": { "path": "package-lock.json" }
}
```

```sh
npx monkeypatchlist scan dist
```

monkeypatchlist never loads JavaScript or TypeScript config files: a gate for platform integrity must not run code to configure itself.

## Adopting monkeypatchlist on an existing app

Most apps already carry platform mutations: an error-tracking SDK, a polyfill, a framework's zone library. monkeypatchlist doesn't ask you to remove them. It asks you to accept them once, and then reviews every change.

1. Write the baseline from the current build, and commit it:

   ```sh
   npx monkeypatchlist baseline init dist
   ```

   It writes `monkeypatchlist.baseline.json`. The file holds one entry per finding, sorted, with nothing that changes between builds of the same code (no paths, hashes, line numbers or timestamps), so it diffs cleanly in review.

2. Gate every build in CI. See [CI recipes](ci.md).

   ```sh
   npx monkeypatchlist scan dist --fail-on added,changed
   ```

3. When the gate fails, read the `Added` and `Changed` cards. If the change is unintended, fix the dependency or the code. If it is intended, accept it with `baseline update`, which prints what it accepts, and commit the baseline with the change. The gate passes again:

   <!-- docs-test: build v2 -->
   ```sh
   npx monkeypatchlist scan dist --fail-on added,changed   # exits 1
   npx monkeypatchlist baseline update dist
   npx monkeypatchlist scan dist --fail-on added,changed
   ```

There is no way to accept one finding and not another: `baseline update` accepts the whole current set. Reviewing the baseline's diff in the pull request is the approval.

## Next steps

- [CI recipes](ci.md)
- [Concepts](concepts.md), to understand what `changed` means and why a rebuild never changes a fingerprint
- [Limitations](limitations.md), to know what a scan can't see

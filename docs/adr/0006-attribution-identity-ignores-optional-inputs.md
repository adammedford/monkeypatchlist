# Attribution identity never depends on optional inputs

What a finding is attributed to is read from the source-map path alone. A lockfile (`--lockfile`) and the package manager's install layout can only add evidence; they never change the containing package, and so never the fingerprint. Two cases make this visible. **Vendored code**: when a composed map names `node_modules/tiny-helper/index.js` but `tiny-helper` was never installed, because `telemetry-agent` bundles it, the containing package is still `tiny-helper`. The **vendoring package** `telemetry-agent` is recorded as `vendoredBy` evidence, and attribution confidence is `low`. **Workspace packages**: first-party code, including a workspace package such as `libs/telemetry`, is attributed to the scanned application. Its workspace `name@version`, which only a lockfile can supply, is evidence. The reason is baseline stability, which [ADR 0005](0005-fingerprints-key-on-the-containing-package.md) also relies on. Vendoring is detectable only through a pnpm/Bun store-name mismatch or a lockfile, so if identity followed detection, switching from npm to pnpm, or passing or dropping `--lockfile`, would re-key findings in unchanged code and churn the committed baseline.

## Considered options

- **Name the vendoring package when vendoring is detected.** This is closer to where the bytes live, but it was rejected: the same build would be keyed differently depending on the package manager and on whether a lockfile was passed.
- **Name the workspace package when a lockfile maps the directory.** Rejected for the same reason. The root-relative path already tells a reader which workspace the code is in.

## Consequences

- The report can name a package that isn't in the dependency tree. The terminal says so (`tiny-helper (vendored in telemetry-agent@x)`), and `introducedBy[]` for vendored code is walked from the vendoring package's lockfile entry.
- A bundler switching composition on or off (such as Angular `vendor: true`) can still change attribution. That is a change to the build's configuration, not to an optional monkeypatchlist input, and it is out of this rule's reach.
- The same principle bounds **framework path rules**: they are versioned data, and changing one is handled like a catalog change, not silently.

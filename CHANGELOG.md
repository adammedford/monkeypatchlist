# Changelog

Every release of monkeypatchlist is listed here, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

**Versioning.** monkeypatchlist follows semantic versioning with one extra promise about findings ([spec §4](docs/spec.md#catalog-versions)):

- A release that can change findings on unchanged code, such as a catalog bump or an analyzer change, is a **minor** release. Upgrade monkeypatchlist in its own pull request and run `monkeypatchlist baseline update` there: the changes appear as ordinary `added`, `removed` or `changed` findings, and a catalog change carries the `explainedBy` records that explain it.
- A **patch** release reproduces byte-identical output on the whole validation corpus, and CI enforces it. Pin monkeypatchlist with `~` to get fixes without finding churn.
- A change to the JSON report that removes, renames or changes the meaning of a field, or a fingerprint scheme change that can't be migrated, needs a **major** release.

The catalog has its own version (`tool.catalogVersion` in the report), separate from the monkeypatchlist version. Its changes are listed in `catalog/changelog.json`, which ships in the package.

## [Unreleased]

Release 1, the first public release.

Renamed from Patchline before the first release.

### What monkeypatchlist does

monkeypatchlist is a static scanner for deployed JavaScript. It finds code that can change the browser's native platform (browser and ECMAScript APIs), says where that code came from, and reports what changed since an accepted baseline:

> What changed the browser platform, who introduced it, and is that change new?

Release 1 includes:

- **The artifact graph.** A scan starts from a build directory and its entry documents (`index.html` by default), follows script, module, worker and import-map references the way Chromium does, and sweeps the directory for scripts no reference names.
- **Semantic mutation analysis against a native catalog.** An abstract interpreter over each build's module link groups finds writes, definitions, wraps and prototype changes on native targets, through aliases, constant folding, helpers and bundler module runtimes. The catalog is generated from `@webref/idl`, the ECMAScript specification and browser-compat-data, and ships in the package. Writes that can't take effect in Chromium are reported separately as ineffective writes, and restores are recognized.
- **The protected surface.** By default a scan reports the native targets whose change most often breaks applications (`--surface protected`); `--surface all` reports every catalogued target.
- **Attribution.** Each finding names its containing package, from source maps and package store paths, with versions and introducing dependencies when a lockfile is given (`--lockfile`).
- **Stable fingerprints and baselines.** `monkeypatchlist baseline init` records the accepted findings in a committed JSON baseline. Later scans classify each finding as `added`, `changed`, `existing`, `removed` or `unconfirmed`, and `monkeypatchlist baseline update` accepts the changes.
- **Scan completeness.** Every report says whether the scan is `complete`, and records what it couldn't see: unparseable code, unresolved holders, dynamic code, budget limits, and references it couldn't follow.
- **A CI gate.** `monkeypatchlist scan --baseline <path> --fail-on added,changed` exits 1 when a finding is new or changed, and 3 when the scan is incomplete (unless `--allow-incomplete`).
- **Offline by default.** No command touches the network unless `--mode resolve` is given, and then only within a fixed safety floor of caps.
- **Output.** A terminal summary, `monkeypatchlist explain` for one finding's occurrences and resolution trace, and a JSON report (`--json`) validated by `schema/report.schema.json`, byte-identical for the same inputs except for its `run` block.
- **Configuration.** `monkeypatchlist.config.json`, validated by `schema/config.schema.json`. JS and TS config files are never loaded.

### Known limitations

Release 1 has known limits on what it catalogues, links, detects and attributes. Some kinds of native work are missed or reported only as a limitation. They are listed in [docs/limitations.md](docs/limitations.md).

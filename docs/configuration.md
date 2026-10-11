# Configuration and CLI reference

## Commands

| Command | Does |
|---|---|
| `monkeypatchlist scan <buildDir>` | scans the build, and optionally compares it with a baseline and gates |
| `monkeypatchlist baseline init <buildDir>` | scans, and writes a new baseline holding every finding |
| `monkeypatchlist baseline update <buildDir>` | scans, prints the added, changed and removed findings it accepts, and rewrites the baseline |
| `monkeypatchlist explain <fingerprint\|target> --report <file>` | prints one finding from a saved JSON report, with every occurrence and the reasoning behind it |

No command touches the network unless you pass `--mode resolve`.

## Flags

| Flag | Commands | Config key | Notes |
|---|---|---|---|
| `<buildDir>` | scan, baseline | | the directory you deploy |
| `--config <path>` | all | | the config file. Defaults to `monkeypatchlist.config.json` in the working directory, if it exists |
| `--entry <file>[@<url>]` | scan, baseline | `entries` | an HTML entry document, relative to the build directory, and optionally the URL it is served at. Repeatable. Defaults to `index.html`, served at the first mapping's URL |
| `--map <urlPrefix>=<dir>` | scan, baseline | `mappings` | URLs under the prefix are files under the directory, relative to the build directory. Repeatable; the longest matching prefix wins. At least one mapping is required |
| `--source-maps <dir>` | scan, baseline | `sourceMaps` | a directory of source maps kept outside the build directory. Repeatable; searched in the order given |
| `--lockfile <path>` | scan, baseline | `lockfile.path` | an npm, pnpm or Yarn lockfile, for package versions and introducing dependencies |
| `--surface protected\|all` | scan, baseline | `surface` | what is reported, baselined and gated. Defaults to `protected` |
| `--mode offline\|resolve` | scan, baseline | `mode` | whether remote scripts are fetched. Defaults to `offline` |
| `--json <path\|->` | scan, baseline | `json` | also writes the JSON report to the path; `-` writes it to stdout instead of the terminal report |
| `--no-color` | all | `noColor` | never colors the terminal report. Color is used only on a terminal, and never when `NO_COLOR` is set |
| `--baseline <path>` | scan | `baseline` | the baseline to compare with. Defaults to `monkeypatchlist.baseline.json` when `--fail-on` is given and that file exists. A full JSON report is accepted too |
| `--previous <report.json>` | scan | `previous` | a previous JSON report, for notes when a finding's reachability or install context changed. Needs a baseline, and must come from the same scan configuration |
| `--fail-on added,changed` | scan | `failOn` | the baseline states that fail the gate. `removed` and `unconfirmed` can't gate |
| `--allow-incomplete` | scan, baseline | `allowIncomplete` | turns exit code 3 into a warning, lets `baseline init` and `baseline update` write from an incomplete scan, and lets an incomplete report serve as `--baseline` |
| `--verbose` | scan | `verbose` | gives existing findings a card too, instead of only counting them |
| `--list-ineffective` | scan | `listIneffective` | lists the ineffective writes, instead of only counting them |
| `--out <path>` | baseline | `out` | the baseline file to write. Defaults to `monkeypatchlist.baseline.json` |
| `--allow-downgrade` | baseline | `allowDowngrade` | lets `baseline init` replace, and `baseline update` rewrite, a baseline written by a newer monkeypatchlist or catalog version |
| `--report <file>` | explain | `report` | the saved JSON report to read |
| `--version`, `-v` | alone | | prints `monkeypatchlist <version> · catalog <n> · analyzer <analyzerVersion>` on one line and exits 0: the versions a JSON report's `tool` block records. Reads no config file or build directory |

Flags override the config file field by field.

## The config file

`monkeypatchlist.config.json` is a JSON file validated by [`schema/config.schema.json`](../schema/config.schema.json), which ships in the package as `monkeypatchlist/config.schema.json`. Point an editor at it with `$schema` for completion. JavaScript and TypeScript config files are never loaded: a gate for platform integrity must not run code to configure itself.

<!-- docs-test: file monkeypatchlist.config.json -->
```json
{
  "$schema": "./node_modules/monkeypatchlist/schema/config.schema.json",
  "name": "Storefront",
  "entries": [{ "file": "index.html", "url": "https://shop.example/" }],
  "mappings": [{ "url": "https://shop.example/", "dir": "." }],
  "sourceMaps": ["maps"],
  "lockfile": { "path": "package-lock.json" },
  "surface": "protected",
  "mode": "offline"
}
```

| Key | Type | Meaning |
|---|---|---|
| `$schema` | string | the JSON Schema the file follows, for editors. monkeypatchlist ignores it |
| `name` | string | the application name in the report and the terminal title. Defaults to the build directory's name. It has no flag, and it doesn't affect identity |
| `entries` | array of `{ file, url? }` | `--entry` |
| `mappings` | array of `{ url, dir }` | `--map` |
| `sourceMaps` | array of strings | `--source-maps` |
| `surface` | `"protected"` or `"all"` | `--surface` |
| `mode` | `"offline"` or `"resolve"` | `--mode` |
| `lockfile` | `{ path?, importer? }` | `path` is `--lockfile`. `importer` names the workspace of the scanned app in a monorepo lockfile, when the app's source paths don't identify it |
| `baseline` | string | `--baseline` |
| `previous` | string | `--previous` |
| `failOn` | array of `"added"`, `"changed"` | `--fail-on` |
| `allowIncomplete` | boolean | `--allow-incomplete` |
| `allowDowngrade` | boolean | `--allow-downgrade` |
| `json` | string | `--json` |
| `out` | string | `--out` |
| `report` | string | `--report` |
| `verbose` | boolean | `--verbose` |
| `listIneffective` | boolean | `--list-ineffective` |
| `noColor` | boolean | `--no-color` |

**Paths.** A path in the config file is relative to the file's own directory. A path given as a flag is relative to the working directory. Entry files and mapping directories are always relative to the build directory.

## Scan configuration identity

A baseline records a **scan-config id**: a hash of the settings that decide which findings can exist. It covers the entry documents (file and URL), the URL mappings, the surface and the realms. It doesn't cover the mode, the source-map directories, the lockfile or the name, so adding source maps or a lockfile never invalidates a baseline.

Scanning against a baseline with a different id exits 2 and names the settings that differ. Keep one baseline per configuration, and one per surface.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | success: no gate was asked for, or it passed |
| 1 | the gate failed: a finding is in a `--fail-on` state |
| 2 | a usage or configuration error: bad flags or config, `--fail-on` without a readable baseline, a baseline or `--previous` report from another scan configuration, a baseline from a newer format than this monkeypatchlist reads, or `baseline update` over a baseline from a newer version without `--allow-downgrade` |
| 3 | an `incomplete` scan, without `--allow-incomplete`: under `--fail-on` for `scan`, and always for `baseline init` and `baseline update`, which then leave the baseline as it was |
| 4 | an internal error |

When the scan is incomplete and the gate also fails, the code is 3.

## Examples

Print the versions of monkeypatchlist, its catalog and its analyzer, for a bug report or a CI log:

```sh
npx monkeypatchlist --version
```

<!-- docs-test: output -->
```text
monkeypatchlist 0.1.0 · catalog 1 · analyzer js-98
```

Name the entry document and its URL, and scan the whole native catalog rather than the protected surface:

```sh
npx monkeypatchlist scan dist --entry index.html@https://shop.example/ --surface all --no-color
```

A baseline for `--surface all` is a separate file, since each surface has its own:

```sh
npx monkeypatchlist baseline init dist --surface all --out monkeypatchlist.all.baseline.json
npx monkeypatchlist scan dist --surface all --baseline monkeypatchlist.all.baseline.json --verbose --list-ineffective
```

Write the default baseline and a report to compare later scans with. A later scan given `--previous` notes each finding whose reachability or install context changed, without failing the gate:

```sh
npx monkeypatchlist baseline init dist --allow-downgrade
npx monkeypatchlist scan dist --json previous-report.json
npx monkeypatchlist scan dist --baseline monkeypatchlist.baseline.json --previous previous-report.json
```

Write the JSON report to stdout, for a pipe, and accept an incomplete scan with a warning:

```sh
npx monkeypatchlist scan dist --json - --allow-incomplete
```

Accept a change into the baseline, even when it was written by a newer monkeypatchlist:

<!-- docs-test: build v2 -->
```sh
npx monkeypatchlist scan dist --fail-on added,changed   # exits 1
npx monkeypatchlist baseline update dist --allow-downgrade
```

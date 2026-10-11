# CI recipes

monkeypatchlist gates a build by its exit code. Run it after your build step, against the directory you deploy, with a committed baseline and `--fail-on added,changed`.

These recipes assume a `monkeypatchlist.config.json` at the repository root, so the commands stay short:

<!-- docs-test: file monkeypatchlist.config.json -->
```json
{
  "name": "Storefront",
  "mappings": [{ "url": "https://shop.example/", "dir": "." }],
  "sourceMaps": ["maps"],
  "lockfile": { "path": "package-lock.json" },
  "failOn": ["added", "changed"]
}
```

With `failOn` in the config, every `scan` gates; the recipes pass `--fail-on` too, so each step reads on its own. They also need a committed baseline, written once:

```sh
npx monkeypatchlist baseline init dist
```

## GitHub Actions

```yaml
name: Platform mutations

on:
  pull_request:
  push:
    branches: [main]

jobs:
  monkeypatchlist:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: lts/*
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npx monkeypatchlist scan dist --fail-on added,changed --json monkeypatchlist-report.json
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: monkeypatchlist-report
          path: monkeypatchlist-report.json
```

The terminal report goes to the job log. The JSON report is uploaded even when the gate fails, so a reviewer can run `explain` on it locally:

```sh
npx monkeypatchlist explain Window.fetch --report monkeypatchlist-report.json
```

## Any other CI

monkeypatchlist needs only Node.js 24 or later and the build output. The step is the same everywhere:

```sh
npm ci
npm run build
npx monkeypatchlist scan dist --fail-on added,changed --json monkeypatchlist-report.json
```

Fail the job on any non-zero exit code. The codes tell the failures apart:

| Code | Meaning | What to do |
|---|---|---|
| 0 | the gate passed, or no gate was asked for | nothing |
| 1 | a finding is `added` or `changed` | read the cards; fix the change, or accept it with `baseline update` |
| 2 | a usage or configuration error, including `--fail-on` with no readable baseline, and a baseline written for another scan configuration | fix the command, the config or the baseline path |
| 3 | the scan was `incomplete`: something it was asked to analyze failed | read the `Completeness` block; fix the input, or pass `--allow-incomplete` to downgrade it to a warning |
| 4 | an internal error | report a bug |

When the scan is incomplete and the gate also fails, the code is 3, and the report shows both.

A missing or mistyped baseline path never passes: under `--fail-on`, a scan without a readable baseline exits 2.

## Accepting changes in a pull request

When a change is intended, such as an SDK upgrade that now wraps `XMLHttpRequest`, the author runs `baseline update` locally and commits the new baseline with the upgrade:

<!-- docs-test: build v2 -->
```sh
npx monkeypatchlist scan dist   # exits 1
npx monkeypatchlist baseline update dist
git add monkeypatchlist.baseline.json
```

The baseline diff is then reviewed like code. Each entry is one finding's fingerprint and the attributes that decide `changed`, so the diff reads as a list of accepted platform changes.

If two branches both update the baseline, resolve the conflict by running `baseline update` again on the merged build, not by merging the JSON by hand.

## Monorepos and several apps

Keep one baseline per app, and one config file per app. Pass each app's config with `--config`, and each baseline with `--out` and `--baseline`. A config file's paths are relative to the config file, and its entry and mapping directories to the build directory:

<!-- docs-test: file storefront.config.json -->
```json
{
  "name": "Storefront",
  "mappings": [{ "url": "https://shop.example/", "dir": "." }],
  "sourceMaps": ["maps"]
}
```

```sh
npx monkeypatchlist baseline init dist --config storefront.config.json --out storefront.baseline.json
npx monkeypatchlist scan dist --config storefront.config.json --baseline storefront.baseline.json --fail-on added,changed
```

A baseline records the settings that decide which findings can exist (entry documents, URL mappings and surface), so it is never compared against a scan of something else: a scan whose settings differ from its baseline's exits 2 and names what differs.

## Remote scripts

By default monkeypatchlist is offline: it scans only the files you give it, and each script the page loads from another origin is listed as `offline-skipped`, which makes the scan `complete-with-limitations` but never fails the gate. To scan third-party scripts too, pass `--mode resolve`:

```sh
npx monkeypatchlist scan dist --mode resolve --fail-on added,changed
```

Resolve mode fetches what a browser would execute, over HTTPS (HTTP only for a page served over HTTP), under fixed limits: no private or loopback addresses, at most 5 redirects, 20 MB per response, 100 MB and 500 fetches per scan, and 5 minutes for all fetches. It honours `HTTPS_PROXY` and `NO_PROXY`. A fetch that fails makes the scan `incomplete`.

A vendor script served from a floating URL can change without a deploy of yours, and a resolve scan then reports its new mutations as ordinary `added` or `changed` findings. That is the change the gate exists to catch, but it means a resolve scan can fail on a build you didn't change. Many teams run resolve mode on a schedule, and the offline gate on every pull request.

## Upgrading monkeypatchlist

Pin monkeypatchlist with `~` (for example `"monkeypatchlist": "~1.2.0"`). A patch release reproduces byte-identical findings on unchanged code. A minor release can change findings, for example when the native catalog grows; those show up as ordinary `added` or `changed` findings with an `explainedBy` note, and you accept them with `baseline update` like any other change.

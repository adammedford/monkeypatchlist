# Report format

`--json <path>` writes the full report as JSON, beside the terminal report. `--json -` writes it to stdout instead of the terminal report. Diagnostics always go to stderr.

```sh
npx monkeypatchlist scan dist --map https://shop.example/=. --source-maps maps --lockfile package-lock.json --json report.json
```

The report's JSON Schema is [`schema/report.schema.json`](../schema/report.schema.json). It ships in the package, as `monkeypatchlist/report.schema.json`, so you can validate reports against the version of monkeypatchlist that wrote them. The schema describes every field; this page is an overview.

## Stability

- **`reportVersion`** is an integer. Adding a field doesn't change it. Removing or renaming a field, or changing what one means, increments it, and only happens in a major release of monkeypatchlist.
- **Determinism.** The same inputs give a byte-identical report, except for the `run` block, which holds all wall-clock data. Keys are in a fixed order, findings are sorted by fingerprint, and artifacts by URL.
- **A report is a baseline.** A full report can be passed as `--baseline` or `--previous`. As a baseline, it reads as if `baseline update` had just been run on that scan.

## Top level

| Field | Holds |
|---|---|
| `reportVersion` | the report format version |
| `tool` | `monkeypatchlistVersion`, `catalogVersion`, `analyzerVersion` and `fingerprintScheme` |
| `application` | the application `name` (not identity) |
| `config` | the settings the scan ran with: `scanConfigId`, `surface`, `mode`, `entries`, `mappings`, `sourceMaps`, `lockfile`, `failOn` |
| `summary` | counts per baseline state (`added`, `changed`, `existing`, `removed`, `unconfirmed`), findings outside the surface per surface (`outOfScopeBySurface`), and `ineffectiveWrites` |
| `gate` | `failOn`, `result` (`pass`, `fail` or `not-run`) and `exitCode` |
| `completeness` | the `level`, `counters`, `limitations` records and the `attribution` block. See [Concepts](concepts.md#completeness) |
| `baseline` | the baseline's `path` and `header`, and scan-level `notes` such as catalog-version skew |
| `packages` | package name → `version` and `versionSource`, for packages with a reliable version |
| `findings` | one entry per finding, below |
| `ineffectiveWrites` | writes that try to change a native API but can't, with their reason and occurrences |
| `artifacts` | every HTML document, script, module and worker the scan knows of |
| `run` | wall-clock data only: `startedAt`, `durationMs`, and per-URL retrieval times and cache headers |

## Findings

`findings` is one list. Baseline entries that are `removed` or `unconfirmed` appear in it too, with their `baselineState`, the readable context the baseline kept, and no occurrences.

A finding from the scan above, with some fields left out:

<!-- docs-test: subset report.json -->
```json
{
  "findings": [
    {
      "fingerprint": "window|Window.fetch|wrap|pkg:@example/telemetry",
      "targetKey": "window|Window.fetch|wrap",
      "target": { "realm": "window", "holder": "global", "name": "Window.fetch" },
      "surface": "networking",
      "effect": "wrap",
      "locks": false,
      "attribution": {
        "key": "pkg:@example/telemetry",
        "provenance": "bundled-dependency",
        "package": "@example/telemetry"
      },
      "introducedBy": ["@example/telemetry@1.4.0"],
      "reachability": "unconditional",
      "reachabilityBasis": "call-path",
      "installContext": "load",
      "confidence": {
        "target": { "level": "high", "reasons": [] },
        "mutation": { "level": "high", "reasons": [] },
        "attribution": { "level": "high", "reasons": [] }
      },
      "baselineState": null,
      "policy": null,
      "occurrences": [
        {
          "artifact": { "url": "https://shop.example/assets/main-JLMSIHKU.js", "origin": "local-build" },
          "generated": { "line": 1, "column": 159 },
          "original": { "source": "../../node_modules/@example/telemetry/index.js", "line": 11, "column": 9 },
          "mechanism": "assign",
          "trace": [{ "kind": "binding" }, { "kind": "token-check", "result": "passed" }]
        }
      ]
    }
  ]
}
```

Each finding carries:

- **Identity**: `fingerprint`, `targetKey`, and `target` (`realm`, `holder`, `name`, and `shadows` when the write shadows an inherited member). See [Concepts](concepts.md#fingerprints).
- **What it does**: `surface`, `effect`, and `locks` (whether it leaves the member non-writable or non-configurable).
- **Whose code it is**: `attribution` (`key`, `provenance`, and `package`, `vendoredBy` or `workspace` when known), and `introducedBy`, the direct dependencies that bring the package in.
- **Whether it runs**: `reachability`, `reachabilityBasis` and `installContext`.
- **How certain the analysis is**: `confidence`, with a `level` and `reasons` for each of `target`, `mutation` and `attribution`.
- **The comparison**: `baselineState`, `matchedBy` (`fingerprint`, `effect` or `target-key`), `changedReasons` (each `{ reason, before, after }`), and `notes` (`rekeyed`, `shared-target-key`, `previous-version`, `reachability-change`, `install-context-change`). Without a baseline, `baselineState` is `null`.
- **Catalog changes**: `explainedBy` and `catalogStatus`, when a catalog update explains the finding.
- **The gate**: `policy` is `{ "outcome": "fail", "by": "fail-on:<state>" }` when the finding fails the gate, and `null` otherwise.
- **`occurrences`**: each location that makes the mutation, with its artifact, generated and original positions, `mechanism`, reachability, install context, confidence, attribution evidence, and its `trace`: the steps that connect the code to the target. Test against a trace step's `kind` and fields; its `text` is for people and may be reworded.

## Artifacts

Each artifact records its `url`, `path` (for local files) and `hash`; its `origin` (`local-build`, `same-origin`, `cross-origin` or `inline`); how it was found (`discovery`: `reference`, `injected` or `sweep`); its `sourceType` and `realm`; its source-map pairing (`sourceMap`); its `retrieval` record; and how its modules were linked (`moduleLinking`).

## SARIF

SARIF output is planned for a later release. Fingerprints are already stable and readable, so they can serve as SARIF `partialFingerprints`.

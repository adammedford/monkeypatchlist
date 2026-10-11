# Contributing

Thanks for helping with monkeypatchlist. This guide covers how to set up, the checks every change passes, the validation corpus, and how releases keep findings stable.

By taking part you agree to follow the [code of conduct](CODE_OF_CONDUCT.md). Report security vulnerabilities privately, as [SECURITY.md](SECURITY.md) describes, never in an issue or pull request.

## Before you start

- **Bugs and accuracy reports** go through the issue templates. A false positive or a missed mutation is most useful with the smallest code that shows it and the `monkeypatchlist explain` output.
- **Larger changes**, such as a new flag, a report field or a change to how findings are named, start with an issue. monkeypatchlist's design is in [docs/spec.md](docs/spec.md), its vocabulary in [CONTEXT.md](CONTEXT.md), and its settled decisions in [docs/adr/](docs/adr/). A change to finding identity (targets, effects, fingerprints) or to baseline semantics changes what users' baselines mean, so it needs agreement in an issue first.
- **Setup.** Node 24 or later, then `npm ci`.

## Checks

Every change passes the gate that CI's `check` job runs:

```sh
npm run typecheck && npm run lint && npm run lint:boundaries && npm run build && npm test && npm run catalog:check && npm run fixtures:check
```

`npm run fixtures:check` and `npm run corpus:check` need the validation corpus, below. Fill in the pull request template's checklist when you open a pull request.

## The validation corpus

The validation corpus is the evidence monkeypatchlist's accuracy is measured on: small apps that use real SDKs and polyfills, built by webpack, esbuild, Rollup and Vite with and without source maps, vendor CDN pages, Chromium fixture pages, and the runtime ground truth for each ([spec §20](docs/spec.md#validation-corpus)). It lives in its own repository, apart from the scanner. This repository pins the corpus at one commit, and CI fetches that commit before the jobs that need it; fetch it locally the same way, as the corpus steps in [.github/workflows/ci.yml](.github/workflows/ci.yml) do. A change that needs a corpus change lands in the corpus repository first, and then a pull request here moves the pin.

**Holdout material is never accepted.** Accuracy is also scored on a sealed holdout: libraries that are in neither the corpus nor this repository, kept private so that the analyzer can't be tuned to them. A pull request that contains holdout material, such as its apps, builds, ground truth or scores, or code written from it, is closed without review. The corpus is kept clear of the holdout's libraries too, so a corpus change that adds one may be declined.

## Fixture pages

`npm run fixtures:check` is the §20 fixture bar ([spec §20](docs/spec.md#bars)). It scans every Chromium fixture page for write outcomes and restores (the corpus's `fixtures/static-sites/`) with `monkeypatchlist scan --json` and `surface: all`, and compares each report with the page's expectation in `fixtures/expectations.json`:

- findings, by target and effect
- ineffective-write records, by target, reason and the `throws` of every occurrence
- restores: a `restore` trace step on the install's finding, and no finding occurrence inside the restore write the page marks with `/*R{*/ … /*}R*/`
- controls, which give only the findings they expect

It prints `pass`, `FAIL`, `xfail` or `XPASS` per page, with each difference, and exits 1 when a page fails. A page whose feature isn't implemented yet is listed in `tools/fixture-pages/expected-to-fail.ts` with the issue that implements it. A listed page that passes fails the check (`XPASS`), so the change that implements it removes the page's line.

CI's `corpus-snapshot` job also runs the patch-release reproducibility check, below.

## Releases and the corpus snapshot

**The release promise** ([spec §4](docs/spec.md#catalog-versions), [ADR 0008](docs/adr/0008-tool-upgrades-use-ordinary-baseline-states.md)). A release that can change findings on unchanged code, such as a catalog bump or an analyzer change, is a minor release. A patch release reproduces byte-identical output on the whole validation corpus, so users who pin monkeypatchlist with `~` get no finding churn.

**The snapshot.** `corpus-snapshot/` holds the report `monkeypatchlist scan --json` gives for every site of the validation corpus:

- the bundled build directories (`dist/`)
- the vendor CDN sites and the empty control (`static-sites/`)
- the exercise variants' build directories (`variants/*/dist/`)
- the fixture pages (`fixtures/static-sites/`)

Each site is scanned twice, with `surface: protected` (the default) and with `surface: all`, as `corpus-snapshot/<surface>/<site>.json`. Each report is stored without its `run` block, and with `tool.monkeypatchlistVersion` cut to its release line (`1.2` for `1.2.3`), so every patch release of a minor release shares that release's snapshot.

**The check.** CI's `corpus-snapshot` job:

1. builds the corpus with the Node its manifests record, and checks that the build rewrote every `manifest.json` byte for byte, so the corpus build itself is reproducible
2. runs `npm run corpus:check`. It checks every build directory against its manifest again, scans every site, and fails on any byte difference from the snapshot. It names each report that differs and the first line where it does.

Both commands scan sites in a pool of worker processes: one per available CPU but one, and no more than the machine's memory holds at a whole Node heap each (about 4 GB), since a worker that swaps slows the check down. Set another number with `--jobs <n>` (`npm run corpus:check -- --jobs 4`) or the `MONKEYPATCHLIST_CORPUS_JOBS` environment variable; `--jobs 1` scans one site after another in a single process. Reports are put back in site order before they are written or compared, so the output is the same, byte for byte, whatever the number of jobs.

`npm run corpus:check -- --bindings typescript-eslint` is the binding-resolution seam's conformance test (spec §19): it checks the same snapshot with `@typescript-eslint/scope-manager` behind the seam in place of the shipped `eslint-scope`, and passes only when every report is byte-identical. The snapshot itself is only ever written with `eslint-scope`, so `--update` refuses `--bindings`.

To run it locally, fetch the corpus at its pinned commit, build it in the corpus checkout, then run the check:

```sh
# in the corpus checkout
npm ci && npm run build &&
  for manifest in variants/*/manifest.json; do node scripts/build.mjs --root "$(dirname "$manifest")"; done
# back in this repository
npm run corpus:check
```

### Refreshing the snapshot: minor releases only

`npm run corpus:snapshot` rewrites the snapshot from a fresh scan. **Run it only for a minor release:**

- **In a change bound for a minor release** that changes corpus output on purpose, such as a catalog bump, an analyzer change or a corpus change. Refreshing the snapshot marks the change as minor-release material: the next release that contains it is a minor release. Review the snapshot's diff as the finding churn users will see.
- **When a minor release is cut.** Its release line is new, so every report's `tool.monkeypatchlistVersion` changes, and the check fails until the snapshot is refreshed.

**Never in a patch release.** `npm run corpus:snapshot` refuses while `package.json` has a patch version (`1.2.3`). If a fix changes the snapshot, it changes findings on unchanged code, so it ships in the next minor release instead.

## The cost benchmark

`npm run benchmark` measures cold-scan cost against the §18 target ([spec §18](docs/spec.md#18-performance-budget-and-analysis-cost)): at most 10 s/MB on every corpus artifact, at most 400× peak heap per source byte per link group, and zero budget-driven variance. It is run on demand and is not a CI gate. The reference machine is an 8 GB, 2 vCPU runner, and the results record the machine they were taken on.

- It scans every corpus site that `corpus:check` scans, then the scale fixture's `scale/dist/webpack/<1mb|2.5mb|5mb>/nomaps`, with `monkeypatchlist scan --json` and `surface: all`. A measurement worker analyzes each link group, and the main thread samples its heap. Time and peak heap (above the worker's heap after a garbage collection just before the group) are per link group, named by its entry artifact.
- It rescans each corpus site once per cap with that cap alone multiplied (`--factor`, 4 by default), and once with `depth` and `contexts` together multiplied, each with the step budget ×64 so that it can't fire, all injected through the scan's deps. Any difference in fingerprint set, effect, `locks` or completeness level from the measured scan counts as budget-driven variance. The total is reported even when it is zero, and the results list each rerun's differences, so the summary names the cap behind any variance. Each rerun runs in a worker thread with three quarters of the machine's memory, because raised caps need much more heap. `--no-rerun` skips the reruns.
- It writes `benchmarks/cost-benchmark.json` (machine-readable) and `benchmarks/cost-benchmark.md` (the summary table, also printed), or into `--out <dir>`. `--only <site prefix>` limits it to some sites. It exits 1 when a scan failed, and lists the scan in the results.

The whole run takes hours.

## Changelog

List each user-facing change under `[Unreleased]` in [CHANGELOG.md](CHANGELOG.md), and say when it can change findings on unchanged code.

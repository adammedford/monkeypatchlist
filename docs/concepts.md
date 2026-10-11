# Concepts

monkeypatchlist is a change-governance tool backed by static analysis. It answers three questions about deployed JavaScript: what changed the browser platform, who introduced it, and is that change new. When those goals conflict, it ranks them:

1. **A finding is a real platform change, named the same way every time**, so `added` and `changed` mean something.
2. **The scan never silently misses native work**, and says what it couldn't see.
3. **It runs within a CI budget.**
4. **It says who introduced each change.**

This page explains the terms the reports use. [CONTEXT.md](../CONTEXT.md) is the complete glossary.

## Platform mutations

The **platform** is the native browser and ECMAScript API state that every script in a page shares: `fetch`, `history`, `EventTarget.prototype.addEventListener`, `Promise`, `Array.prototype`, `console` and so on.

A **platform mutation** is code that replaces, wraps, deletes, redefines the descriptor of, or changes the prototype of a native API member, or adds a member to a native object. Assigning a writable Web IDL attribute, such as `location.href = url` or `element.onclick = f`, is ordinary API use, not a mutation.

- An **ineffective write** tries to mutate a native member but can't: assigning a read-only attribute, redefining a non-configurable member. monkeypatchlist records it, but it is never a finding.
- A **restore** puts back the original native value, such as an SDK's `stop()` writing back the `fetch` it saved. It undoes a mutation and is not one itself.

monkeypatchlist judges what a write does the way Chromium does: when the browser throws on or refuses a write, it changes nothing, so it gives no finding.

## Targets

A **target** is the native member a mutation acts on, named by the object the write lands on: `Window.fetch`, `EventTarget.prototype.addEventListener`, `history.pushState`.

- The **holder** is the kind of object it lives on: `global`, `constructor`, `prototype`, `instance` (a platform singleton such as `history` or `navigator`) or `namespace` (such as `console`, `JSON` or `Math`).
- A **shadowing write** creates an own property over a member the object only inherits. `history.pushState = w` targets `history.pushState`, and records that it shadows `History.prototype.pushState`.
- A **wildcard target** names a holder whose member monkeypatchlist couldn't pin down: `console.*` when code loops over console methods, or `EventTarget.prototype.__zone_symbol__*` for keys with a known prefix.
- A **candidate set** is the few targets one write could land on, such as `(cond ? window : history).pushState = w`. Each candidate is its own finding.

Targets are resolved against the **native catalog**, monkeypatchlist's versioned inventory of browser APIs (from Web IDL) and ECMAScript built-ins. Each target belongs to a **surface**: `networking`, `events`, `scheduling`, `navigation`, `storage`, `crypto`, `DOM`, `ECMAScript`, `diagnostics`, `workers` or `other`.

## Effects and mechanisms

The **effect** is what a mutation does to its target, judged by what the member holds afterwards:

| Effect | What happened |
|---|---|
| `replace` | the member holds a new value that doesn't call the original |
| `wrap` | the member holds a new function that calls the original |
| `add` | the object has a member it didn't have |
| `delete` | the member was deleted |
| `descriptor-change` | the member has a new getter and setter, or the same value with changed attributes |
| `prototype-change` | the object's prototype was replaced |

A mutation **locks** its target when it leaves it non-writable or non-configurable, so later code can't change it.

The **mechanism** is the syntax used: `assign`, `define-property`, `define-properties`, `reflect-define`, `bulk-assign` (such as `Object.assign`), `delete`, `set-prototype`, or `declare` (a top-level declaration in a classic script, such as `function fetch() {}`). The mechanism is evidence only: switching from `Object.defineProperty` to an assignment changes nothing that matters.

## Findings and occurrences

A **finding** is one platform mutation. It claims that the scanned code mutates the target when it runs, not that it did in any particular page load. A finding has one or more **occurrences**: the locations in the deployed scripts where the mutation appears. Two copies of the same package in one bundle, or two sites in one package that wrap `fetch`, are one finding with several occurrences.

### Reachability and install context

**Reachability** says how likely a mutation is to run, from the guards between where its code is entered and the write:

- `unconditional`: nothing guards it
- `guarded-native-absence`: it only runs when some native API is missing, as a polyfill does
- `conditional`: a guard that can't be decided statically, such as a config flag or sampling
- `unknown`: control flow the analysis couldn't follow

**Install context** says when: `load` if the mutation runs when the script loads, `deferred` if only when a function such as an SDK's `init()` is called later.

Neither one decides a finding's identity or its baseline state. A build where a guard changes is reported with a note, not as a change.

## Attribution

**Attribution** links a finding to the code that produced it.

- **Provenance** is how the code got into its script: `first-party` (your code, including workspace packages), `bundled-dependency`, `remote` (a script loaded from another origin), `inline` (a script in the HTML) or `unknown` (bundled code that can't be attributed, usually for want of a source map).
- The **containing package** is the package whose file holds the code, read from the source map's path. It is the package a finding is attributed to.
- An **introducing dependency** is the direct dependency of your app whose installed tree contains that package. Finding it needs `--lockfile`.

Without source maps, bundled code is attributed to `unknown`. Adding maps later doesn't fail the gate: each `unknown` baseline entry pairs with the findings that now have a package, as `existing` with a `rekeyed` note.

## Fingerprints

A finding's **fingerprint** is its identity: realm, target, effect and **attribution key**, as a readable string:

```text
window|Window.fetch|wrap|pkg:@example/telemetry
```

The attribution key is one of:

| Key | For |
|---|---|
| `pkg:<name>` | bundled dependency code: the containing package's name, without its version |
| `app:<path>` | first-party code: the original source path, relative to the app's root |
| `url:<normalized URL>` | a remote script: its URL with versions and hashes replaced, so `sdk-1.2.3.min.js` and `sdk-1.2.4.min.js` share a key |
| `inline` | scripts in the HTML |
| `unknown` | local code that can't be attributed |

A fingerprint has no line numbers, chunk names, module ids, file hashes or mechanism, so a rebuild, a new minifier, renamed chunks or moved code never changes it. Upgrading a package doesn't either: the version is not in the key.

The **target key** is the fingerprint without the attribution key. It is used to pair a finding with a baseline entry when only the attribution moved.

## Baselines

A **baseline** is the set of findings you accepted, committed as `monkeypatchlist.baseline.json` beside your code and reviewed in pull requests like code. It is deterministic: entries are sorted, with fixed key order and no timestamps, paths or hashes, so an unchanged build rewrites it byte for byte. `baseline init` writes it, and `baseline update` accepts the current findings into it.

### Baseline states

Each finding of a scan with a baseline gets a state:

| State | Meaning | Gates with `--fail-on` |
|---|---|---|
| `added` | a mutation the baseline doesn't have | yes |
| `changed` | the same mutation as a baseline entry, but the platform now behaves differently or it is now someone else's code | yes |
| `existing` | the same as a baseline entry | no |
| `removed` | a baseline entry the scan no longer finds | no |
| `unconfirmed` | a baseline entry the scan could not have seen, because the scan was incomplete, ran out of analysis budget, or skipped remote scripts | no |

A finding is `changed` for one of three reasons, each recorded with its before and after values:

- `attribution`: the same target and effect, now under another known attribution key, such as code that moved from `@sentry/utils` to `@sentry/core`
- `effect`: the same target and package, with a different effect, such as `wrap` becoming `replace`
- `locks`: the mutation now locks its target, or no longer does

Mechanism, confidence, occurrence counts, package versions, reachability and install context never make a finding `changed`. A package upgrade that keeps the same mutations is `existing`, with a `previous-version` note.

## Completeness

Every scan reports what it did not analyze, and gets one of three levels:

- `complete`: nothing was left out.
- `complete-with-limitations`: the only gaps are ones the configuration accepts, such as remote scripts skipped in offline mode, or blind spots inside analyzed code, such as `eval` of a computed string.
- `incomplete`: something the configuration asked for couldn't be analyzed: a script that doesn't parse, a file that can't be read, a source-map directory that pairs with nothing, or, in resolve mode, a failed fetch or an integrity mismatch.

Each gap is a **limitation** record naming its kind, the script, and the location where there is one. The levels have no thresholds, so the same configuration over the same files always gives the same level.

Under `--fail-on`, an `incomplete` scan exits 3 even when nothing changed, because a gate that passes on a scan that couldn't see the code isn't a pass. `--allow-incomplete` turns that into a warning. An incomplete scan never reports a baseline entry as `removed`; it reports it as `unconfirmed`.

## Protected surface

monkeypatchlist detects mutations across the whole native catalog, but by default it reports, baselines and gates only the **protected surface**: the APIs that most often matter to an app's behaviour.

| Surface | Covered |
|---|---|
| networking | `fetch`, `navigator.sendBeacon`; all of `XMLHttpRequest`, `WebSocket`, `EventSource`, `Request`, `Response`, `Headers` |
| events | `addEventListener`, `removeEventListener`, `dispatchEvent` |
| scheduling | `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `requestAnimationFrame`, `cancelAnimationFrame`, `requestIdleCallback`, `cancelIdleCallback`, `queueMicrotask` |
| navigation | `window.open`; all of `History` |
| storage | `localStorage`, `sessionStorage`; all of `Storage` |
| crypto | all of `Crypto` and `SubtleCrypto` |
| ECMAScript | all of `Promise`, `Function`, `Object`, `Array`, `Map`, `Set`, `JSON` |
| diagnostics | all of `console` |
| workers | `navigator.serviceWorker`; all of `Worker`, `SharedWorker`, `ServiceWorkerContainer` |

"All of" an interface covers its native members, the global constructor, wildcards over its members, prototype changes, and named members added to it, such as a library's `Array.prototype.last`. A write that shadows a covered member is covered too: `history.pushState = w` falls under `History`, and `window.addEventListener = w` under `EventTarget`.

The terminal report counts the findings outside the surface, by surface. Run with `--surface all` to report everything; each surface needs its own baseline.

## Catalog versions

The native catalog and monkeypatchlist's other curated data share one **catalog version**, and each monkeypatchlist release bundles exactly one. A newer catalog can add targets, so a finding that was invisible before can appear. It shows up as an ordinary `added` finding, with an `explainedBy` note that names the catalog change, and you accept it with `baseline update`. Patch releases of monkeypatchlist never change findings on unchanged code.

# monkeypatchlist

monkeypatchlist is a static scanner that finds code in deployed JavaScript that changes the browser's native platform, says where that code came from, and reports what changed since the previous release.

## Language

### Artifacts

**Build directory**:
The deployment output a scan runs over, together with the mapping from served URLs to paths inside it.
_Avoid_: dist, source tree

**Entry document**:
An HTML file a scan starts discovery from.
_Avoid_: index, entry point

**Artifact**:
One executable or supporting resource (HTML, script, module, worker, source map), identified by its content hash.
_Avoid_: resource, asset, file, chunk

**Artifact graph**:
The artifacts of a scan and the references between them (parent/importer), rooted at the entry documents.
_Avoid_: dependency graph, module graph

**Module link**:
A connection from a use of a bundled module's export to the module that defines it, inside one artifact or between artifacts that the artifact graph of one scan connects: local-build, inline, `data:` and fetched remote artifacts of the realm (imports, dynamic imports, chunk loads, chunk-registry pushes). It is recovered from the module-linking idioms and import syntax in the code, never from knowing which bundler produced it.
_Avoid_: bundler detection, webpack support

**Module-linking idiom**:
A structural code shape through which bundled modules reach each other, such as a table of module factories read by a require function, or a lazy thunk that fills an `exports` object.
_Avoid_: bundler runtime, bundler signature

**Link group**:
An entry artifact plus every artifact reachable from it through module links, analysed as one program in one realm. Global variables shared between classic scripts don't join a link group.
_Avoid_: bundle, chunk graph

**Global link**:
A connection from a script's read of a non-native global name, such as `Microsoft`, `DD_RUM` or `NREUM`, to the scripts of the same entry document that write that name. It is how a loader snippet reaches the SDK it configures or starts. It assumes no evaluation order between the scripts, and names of native APIs never form one. Deferred to Release 3; R1 does not follow global links.
_Avoid_: global alias, cross-script link

**Loader snippet**:
A small script on a page that configures, loads or starts an SDK through the SDK's global name, such as an inline `Sentry.init({...})` or an async stub that queues calls until the SDK arrives.
_Avoid_: tag, embed code, install snippet

**Source-map directory**:
A directory of source maps supplied alongside the build directory, used only to attribute artifacts in the scan and never analyzed as code.
_Avoid_: maps input, sourcemap folder

**Orphaned map**:
A source map that verified against no artifact in the scan.
_Avoid_: unused map, stale map (a stale map failed verification against the artifact it was paired with)

**Sweep**:
Discovery of a local artifact by scanning the build directory rather than by following a reference.

**Origin**:
Where an artifact is served from: `local-build`, `same-origin`, `cross-origin`, or `inline`.
_Avoid_: source, provenance

**Provenance**:
How the code behind a finding got into its artifact: `first-party`, `bundled-dependency`, `remote`, `inline`, or `unknown` (local code that can't be attributed: no source map, an escaped source, or a mapping that failed its check). Code in a workspace package of the scanned repository is `first-party`.
_Avoid_: origin

**Realm**:
The kind of global environment an artifact executes in: `window`, `dedicated-worker`, `shared-worker`, or `service-worker`. Whether a write reaches the artifact's own global or another window (an iframe, `opener`) is recorded per occurrence, not in the realm.
_Avoid_: context, scope

### Platform

**Platform**:
The shared native browser and ECMAScript API state of a realm.
_Avoid_: runtime, environment

**Native catalog**:
The versioned inventory of native APIs monkeypatchlist resolves against: a browser catalog derived from Web IDL and an ECMAScript intrinsics catalog.
_Avoid_: API list, allowlist

**Catalog version**:
The single version covering monkeypatchlist's curated data: the native catalog with its overlays (protected flags, surfaces), the framework path rules and the remote URL normalization rules. It is separate from the monkeypatchlist version, and every monkeypatchlist release bundles exactly one catalog version.
_Avoid_: webref version, data version

**Retained target**:
A target kept in the native catalog after its upstream source dropped it, because browsers still ship it (e.g. `Window.sharedStorage` after its spec was discontinued). It resolves like any other target. It leaves the catalog only through a deliberate removal.
_Avoid_: tombstone, deprecated target

**Target**:
The native API member a mutation acts on, named by the object the write lands on and qualified by realm, e.g. `Window.fetch`, `EventTarget.prototype.addEventListener`, `history.pushState`. A top-level declaration of a native name in a classic script (`var`, `function`, `let`, `const`, `class`) counts as landing on the global object's member, even when it creates a lexical binding that hides the member rather than changing it.
_Avoid_: API (alone), runtime target

**Wildcard target**:
A target whose holder is known but whose member is not, named `<holder>.*` (e.g. `console.*`), or `<holder>.<prefix>*` when only a prefix of the member is known and no native member starts with it (e.g. `EventTarget.prototype.__zone_symbol__*`). It stands for the whole set of matching members on that holder and is a target like any other.
_Avoid_: unknown target, partial target

**Candidate set**:
The few targets a single write could land on when its holder or member comes from a branch nothing can settle, such as `(cond ? window : history).pushState = w`. Each candidate is its own finding. A set too large to name is treated like an unknown holder or member instead.
_Avoid_: alternatives (alone), either-target

**Shadowing write**:
A write that creates an own property on a native object (a platform singleton, the global object, or a prototype such as WindowProperties) for a member that object only inherits, such as `history.pushState = w` over `History.prototype.pushState`, or `localStorage.setItem = f` over `Storage.prototype.setItem`. Its target is the written object's member, and it records the inherited member it shadows.
_Avoid_: override

**Holder**:
The kind of object a target lives on: `global`, `constructor`, `prototype`, `instance` (a platform singleton), or `namespace` (a namespace object such as `console`, `CSS`, `Math`, `JSON`, `Reflect`, whose members are its own properties).
_Avoid_: scope

**Platform singleton**:
A native instance reachable from the global object and shared by the whole realm, such as `history`, `navigator`, `document`, `console`.
_Avoid_: global instance

**Surface**:
The functional category of a target: `networking`, `events`, `scheduling`, `navigation`, `storage`, `crypto`, `DOM`, `ECMAScript`, `diagnostics`, `workers`, or `other` (an owner nobody has reviewed yet).

**Protected surface**:
The subset of targets a scan reports, baselines and gates on by default. An entry naming a whole interface covers that interface's native members, wildcards over them, and named members added to it, but not pattern wildcards of library-private keys (`__zone_symbol__*`). Detection still covers the whole native catalog.
_Avoid_: default catalog

**Runtime profile**:
The set of browsers a scan treats as the runtime, which decides whether a target counts as native there.
_Avoid_: target, browser target

### Mutations and findings

**Platform mutation**:
Code that replaces, wraps, deletes, redefines the descriptor of, or changes the prototype of a target, or adds a member to a native holder. Assigning to a writable Web IDL attribute is API use, not a platform mutation.
_Avoid_: patch, monkey-patch, override

**Ineffective write**:
Code that tries to mutate a target but cannot change it, such as assigning to a readonly attribute, redefining a non-configurable member, changing an immutable prototype, or a top-level `var` whose initializer assigns a readonly global (`var closed = 1`). It is recorded, but it is not a platform mutation and never a finding.
_Avoid_: attempted mutation, failed patch

**Restore**:
A write that puts back the unmutated native value or descriptor of the same member, such as an SDK's `stop()` writing the saved original back, however the value travelled (locals, closures or heap fields). It undoes a platform mutation and is not one itself.
_Avoid_: unpatch, unwrap, revert

**Effect**:
What a platform mutation does to its target: `replace`, `wrap`, `add`, `delete`, `descriptor-change`, or `prototype-change`. It follows what the member holds afterwards: a new data value is `replace` or `wrap` whatever attributes change with it, and `descriptor-change` is a new getter/setter pair or changed attributes alone.
_Avoid_: mutation type, behavior

**Locking mutation**:
A platform mutation that leaves its target non-configurable or non-writable, so later code can no longer replace or wrap it.
_Avoid_: freeze, seal

**Mechanism**:
The syntactic means a platform mutation uses: `assign`, `define-property`, `define-properties`, `reflect-define`, `bulk-assign`, `delete`, `set-prototype` (including a `__proto__` assignment), or `declare` (a top-level declaration in a classic script).

**Reachability**:
Whether a platform mutation happens, judged by the guards between its install entry and the write: `unconditional`, `guarded-native-absence` (only runs when some native, not necessarily the target, is missing), `conditional` (a guard that can't be decided statically), or `unknown` (control flow the analyzer couldn't follow). Guards that only make a write safe or idempotent don't count. Code that nothing resolvably calls is judged from its function's creation site.
_Avoid_: guardedness, conditionality

**Creation site**:
Where a function value is created, together with the guards in force there. A function can only run after it has been created, so when nothing resolvably calls it (a callback kept for later, an observable subscriber, a returned closure), its reachability is judged from its creation site instead.
_Avoid_: definition site, declaration

**Reachability basis**:
How an occurrence's reachability and install context were judged: `call-path` (along calls that all resolved) or `creation-site` (through a function with no resolved caller, judged from its creation site). It is evidence, not identity.
_Avoid_: confidence, resolution quality

**Install entry**:
The outermost function whose call leads to a platform mutation, such as an SDK's `init()`; top-level code when the mutation runs at load. It can sit in another artifact of the same link group than the mutation.

**Install context**:
Whether a platform mutation runs at load (`load`) or only when its install entry is called later (`deferred`). Code reached only through a function with no resolved caller is `deferred`. Kept separate from reachability.

**Finding**:
One platform mutation, identified by its fingerprint, with one or more occurrences. It claims that the scanned code mutates the target when it runs, not that the mutation happened in any particular page load; reachability says how likely it is to run.
_Avoid_: alert, issue, violation

**Occurrence**:
One location in one artifact where a finding's platform mutation appears.
_Avoid_: instance, hit

**Fingerprint**:
The identity of a finding: its realm, target, effect and attribution key, written as a readable string. It survives rebuild churn such as renamed chunks, minifier changes and moved lines, and it never tells apart several sites that make the same mutation under one attribution key.
_Avoid_: ID, hash

**Attribution key**:
The part of a fingerprint that says whose code a finding is: a containing package name (`pkg:`), a first-party original path (`app:`), a normalized remote URL (`url:`), `inline`, or `unknown`.
_Avoid_: owner key, package key

**Target key**:
A finding's realm, target and effect without the attribution key. It is used only to pair baseline entries and findings whose attribution key moved, such as a package restructure or source maps appearing or disappearing.
_Avoid_: coarse fingerprint

**Confidence**:
Analytical certainty about a finding, recorded separately for target, mutation, and attribution as `high`, `medium` or `low`; never a measure of risk.
_Avoid_: risk, severity, score

**Confidence reason**:
A named assumption or weakness, from a closed list, that holds one confidence dimension below `high`, such as `realm-assumed` or `token-check-failed`.
_Avoid_: caveat, warning

**Resolution trace**:
The recorded reasoning that connects a finding's syntax to its target and effect.
_Avoid_: explanation, proof

**Attribution**:
The link from a finding to the original source location and containing package that produced it.
_Avoid_: ownership, blame

**Containing package**:
The package whose file contains the code behind an occurrence, read from the source-map path. It is the package a finding is attributed to. First-party code, including workspace packages, has none: it is attributed to the scanned application.
_Avoid_: owner, owning package, source package

**Escaped source**:
A source-map source path that has climbed out of the package it came from and lost its `node_modules/<name>` segment, typically because a bundler composed a published package's own map. It is never first-party.
_Avoid_: first-party path, relative source

**Framework path rule**:
A curated rule that recognizes a known framework's escaped-source shape and names the package it came from, such as Next's `_N_E` namespace followed by two or more `../` segments and `src/client/`. A rule can only name a package; it never makes code first-party.
_Avoid_: heuristic, path hack

**Vendoring package**:
The installed package whose file actually holds code that a composed source map names as another, uninstalled package. The containing package stays the one the path names; the vendoring package is evidence.
_Avoid_: container package, real owner

**Introducing dependency**:
A direct dependency of the scanned application whose installed dependency tree includes a containing package. A direct dependency introduces itself.
_Avoid_: owner, parent package

### Change governance

**Scan**:
One run of monkeypatchlist over a build directory, producing findings and a completeness report.

**Baseline**:
The accepted findings of an earlier scan, recorded alongside the code under review, that a new scan is compared against. Accepting findings into it is itself a reviewed change.
_Avoid_: snapshot, allowlist

**Scan-config id**:
A hash of the scan settings that decide which findings can exist (entry documents, URL mappings, surface, realms), recorded in a baseline so that it is never compared against a scan of something else.
_Avoid_: config hash, profile

**Baseline state**:
How a finding compares with the baseline: `added`, `existing`, `changed` (the same platform mutation as a baseline entry, but now under a different attribution key or effect, or with different locking; a different reachability or install context is only a note), `removed`, or `unconfirmed` (a baseline finding not seen in a scan that could not have seen it).

**Completeness**:
The report of what a scan did not analyze, summarized as `complete`, `complete-with-limitations`, or `incomplete`.
_Avoid_: coverage

**Coverage limitation**:
A known artifact, reference, or code site the scan could not analyze, such as an artifact that failed to parse, a remote script skipped offline, a non-literal `eval` string, or a patch whose holder could not be resolved.
_Avoid_: gap, miss

**Identity invariance**:
Two builds of the same code that both find a target agree on everything that decides its baseline state: realm, target, effect and locking, and the fingerprint when both have source maps or both lack them. Breaking it creates false `changed` or `added` findings.
_Avoid_: bundler invariance (ambiguous)

**Set invariance**:
Two builds of the same code find the same set of targets. A target one build finds and another misses is a coverage difference, reported as a known limitation.
_Avoid_: bundler invariance (ambiguous)

**Footprint**:
The findings of one package or artifact, aggregated for reporting.
_Avoid_: summary

**Policy**:
Rules, kept separate from detection, that decide whether a finding is allowed, warned, failed, or baselined.
_Avoid_: ruleset (for enforcement)

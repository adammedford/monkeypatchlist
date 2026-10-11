# monkeypatchlist Release 1 specification

<!-- Generated from the working spec by `npm run spec` (tools/spec-generator). Do not edit by hand. -->

This is the design specification for monkeypatchlist Release 1 (R1): what a platform mutation is, how the scan finds, names, attributes and compares findings, what it reports it could not see, and the contracts of its output, CLI and modules. The domain vocabulary is in [CONTEXT.md](../CONTEXT.md). Decisions with lasting trade-offs are recorded as [architecture decision records](adr/), which the sections below link where they apply. A `§` reference names a section of this document.

| § | Section | Decision records |
|---|---|---|
| 1 | Purpose, users and scope boundary | — |
| 2 | Inputs and discovery | [0015](adr/0015-global-links-are-deferred-to-r3.md) |
| 3 | Platform mutation boundary and write outcomes | [0011](adr/0011-effect-follows-the-value-not-the-attributes.md) |
| 4 | Native catalog and catalog versions | [0002](adr/0002-shadowing-writes-name-the-written-object.md), [0008](adr/0008-tool-upgrades-use-ordinary-baseline-states.md) |
| 5 | Analysis: parsing, scope, resolver capabilities | [0004](adr/0004-wildcard-targets-are-findings.md), [0011](adr/0011-effect-follows-the-value-not-the-attributes.md), [0019](adr/0019-undecided-candidates-give-one-finding-each.md) |
| 6 | Module links and link groups | [0003](adr/0003-module-links-from-structural-idioms.md), [0010](adr/0010-module-links-cross-the-chunks-of-one-build.md), [0015](adr/0015-global-links-are-deferred-to-r3.md) |
| 7 | Reachability and install context | [0013](adr/0013-code-with-no-resolved-caller-is-judged-from-its-creation-site.md), [0014](adr/0014-reachability-and-install-context-do-not-feed-changed-in-r1.md) |
| 8 | Finding model: target, effect, mechanism, occurrence | [0009](adr/0009-findings-claim-static-capability.md), [0011](adr/0011-effect-follows-the-value-not-the-attributes.md) |
| 9 | Confidence | — |
| 10 | Attribution: provenance, packages, introducers, versions | [0005](adr/0005-fingerprints-key-on-the-containing-package.md), [0006](adr/0006-attribution-identity-ignores-optional-inputs.md) |
| 11 | Fingerprints, baseline and `changed` | [0001](adr/0001-committed-json-baseline-no-sqlite.md), [0005](adr/0005-fingerprints-key-on-the-containing-package.md), [0007](adr/0007-fingerprints-have-no-callsite-component.md), [0008](adr/0008-tool-upgrades-use-ordinary-baseline-states.md), [0013](adr/0013-code-with-no-resolved-caller-is-judged-from-its-creation-site.md), [0014](adr/0014-reachability-and-install-context-do-not-feed-changed-in-r1.md), [0020](adr/0020-a-report-used-as-a-baseline-reads-as-if-updated.md) |
| 12 | Protected surface | [0002](adr/0002-shadowing-writes-name-the-written-object.md) |
| 13 | Completeness and coverage limitations | — |
| 14 | Resolution trace (explainability) | — |
| 15 | Output contracts: JSON schema, terminal, SARIF seam | — |
| 16 | CLI, configuration and exit codes | [0006](adr/0006-attribution-identity-ignores-optional-inputs.md) |
| 17 | Remote retrieval (`resolve` mode, safety floor) | — |
| 18 | Performance budget and analysis cost | [0001](adr/0001-committed-json-baseline-no-sqlite.md), [0010](adr/0010-module-links-cross-the-chunks-of-one-build.md) |
| 19 | Module interfaces | [0018](adr/0018-one-resolver-implementation-per-release.md) |
| 20 | R0 acceptance criteria and validation corpus | [0009](adr/0009-findings-claim-static-capability.md), [0011](adr/0011-effect-follows-the-value-not-the-attributes.md), [0016](adr/0016-r0-bar-is-an-implementation-acceptance-criterion.md) |
| 21 | Known limitations | [0015](adr/0015-global-links-are-deferred-to-r3.md) |
| 22 | Release 2 seams | — |

## North star

monkeypatchlist is a CI gate teams can trust. When goals conflict, they rank in this order:

1. **A finding is a real platform change, named the same way every time**, so `added` and `changed` mean something.
2. **The scan never silently misses native work**, and says what it couldn't see.
3. **It runs within a CI budget** (§18).
4. **It says who introduced each change** (§10).

A lower goal never buys a loss on a higher one. So the cost target may be met by giving up attribution precision, but never by changing which findings exist, how they are named, or what the scan reports it couldn't see.

## Principles

They settle every case they cover. A case they don't cover is still decided in its own section, or put to the maintainers.

1. **The engine decides.** When Chromium throws on or refuses a write, call or reference before it takes effect, the scan gives nothing: no finding and no record, except literal code that doesn't parse, which §2 records, and the ineffective-write records §3 lists. Examples: `new eval(s)`, `new Worker(u, 'name')`, `import("./q.js", "json")`, a static import with an unsupported attribute key, a `data:` script the browser refuses.
2. **Values follow ECMA-262.** Constant folding and property keys follow ECMA-262's own semantics for every operator and literal form the analyzer evaluates: unary `-` and `~`, binary arithmetic, BigInt, templates with no substitutions, `ToString` of a number body passed to `Function`, and so on. The analyzer never uses a partial rule of its own for these. Anything it can't evaluate stays unknown.
3. **Any alternative counts.** When a callee, holder or key has several possible values and at least one of them reaches a native (`(c ? eval : f).call(null, s)`, `window[c ? "self" : "frames"][i]`), that alternative is treated as reached. It raises what it would raise on its own (`dynamic-code`, a child window, a finding), and §5's candidate-set rule applies when the targets differ.
4. **"Ships" means released.** For the catalog's drop gate and cross-check (§4), only released browser versions in BCD count. A removal recorded only in a preview means the feature still ships. Support added in a version that isn't released yet doesn't ship.
5. **A cap never silently drops native work.** When any cap (value, fold, BigInt size, recursion, context, loop iteration, enumeration) cuts analysis of something that carries the global object, a native holder or a native member, the scan raises `analysis-budget` naming the artifact, and work done before the cut stays. Any other cap hit is only counted. Enumerating a native holder's catalog keys isn't capped, since the catalog bounds it. A call carries a native when it passes the global object, a native holder or a native function; a string argument that names a catalog member carries it only when the same call also passes a native holder whose chain has that member.

## 1. Purpose, users and scope boundary

monkeypatchlist is a static scanner for deployed JavaScript. It finds code that can change the browser's native platform (browser and ECMAScript APIs), says where that code came from, and reports what changed since an accepted baseline. It answers:

> What changed the browser platform, who introduced it, and is that change new?

It is a change-governance tool backed by static analysis. A scan emphasizes `added` and `changed` findings, so a team can adopt it on an application that already carries platform mutations without first removing them.

**Users.** Enterprise platform and application teams, running monkeypatchlist in CI and during incident diagnosis. It is distributed as an open-source CLI on npm, runs on Node LTS, and needs no network access in its default mode.

**Use cases.**

- Block new platform mutations during delivery (`--fail-on added,changed`).
- Find mutations that a dependency upgrade introduced.
- Inventory what third-party SDKs do to the platform.
- Support incident diagnosis: which code wraps `fetch`, and from which package.
- Track the removal of legacy patches and polyfills.

**Release 1 includes:**

- the artifact graph
- semantic mutation analysis against a native catalog
- the protected surface
- source-map and package attribution
- stable fingerprints and baseline/diff
- scan completeness
- `offline` and `resolve` modes with a fixed safety floor
- a `--fail-on` gate
- terminal and JSON output

It leaves the seams Release 2 needs (§22) without specifying Release 2.

**Out of scope for R1:**

- **Release 2:** SARIF output, runtime profiles backed by browser compatibility data, policy files and expiring exceptions, footprints, ownership enrichment, and configurable remote-retrieval policy.
- **Release 3:** broader Web API coverage beyond the catalog's defaults, inter-file resolution beyond the link groups of one build (including global links between the scripts of one page), additional bundler metadata, SBOM correlation, and enterprise aggregation.
- A runtime companion (Playwright execution, runtime snapshots). The static scanner stays independently useful, deterministic and suitable for CI.
- Crawling live sites and rendering SSR pages. Users supply captured HTML instead.
- HTML reports.
- General supply-chain security, malware detection, exfiltration analysis, CSP analysis, fingerprinting detection, prototype-pollution exploitation, and generic JavaScript quality analysis.

## 2. Inputs and discovery

### Inputs

A scan takes:

- **A build directory**: the deployed output, not framework source.
- **One or more HTML entry documents.** An SSR app with no static HTML supplies a captured HTML file.
- **A URL→path mapping** (site origin, public path, CDN prefix → directory), so that references in HTML and code resolve to files.
- **Optionally, source-map directories**, separate from the build directory.
- **Optionally, `--lockfile`**, used only to find introducing dependencies (§10), and the `package.json` manifests next to it: the one in the lockfile's directory and the workspace manifests the lockfile names, read only for the direct dependency lists and the dev/prod split.

No bundler metadata is required, and none is used for detection. monkeypatchlist must work the same on webpack, Vite, Rollup, esbuild, Angular, Next.js, Nx and equivalent output.

**Input tiers.** What a scan can say depends on what it is given, and the output says what each missing input costs (§15):

| Tier | Gives |
|---|---|
| Build directory only | targets, effects, reachability, provenance; package `unknown` for bundled code |
| + source maps | containing package, original locations, a version where the path carries one |
| + source maps + `--lockfile` | package versions, and the introducing dependencies ("Introduced by") |

### Discovery

References are followed from each entry document:

- `script[src]`, inline scripts and `type=module`
- import maps and `modulepreload`
- static imports and re-exports
- dynamic imports with a literal specifier
- statically visible worker URLs (`new Worker`, `new SharedWorker`, service-worker registration) and literal `importScripts`
- a script element the page creates, gives a constant `src` and inserts: an **injected** reference, loaded as a classic script in the same entry document unless its `type` makes it a module (below)
- remote scripts that discovered artifacts reference directly

**Computed URLs.** A worker URL or `importScripts` URL is statically visible when it folds to one constant URL under ECMA-262 and the URL Standard: a folded string (`const b = '/js/'; new Worker(b + 'w.js')`), `new URL(x, b)` for a folded `x` and any base the scan knows (`import.meta.url` is the artifact's URL; `location` and `document.baseURI` are the document's base URL in a window, and the worker's own URL in a worker), and the `.href` or `toString()` of such a URL. It is a reference in its worker's realm. A URL with several possible values gives one reference per constant alternative, and any unknown alternative adds one `unresolved-reference`: `new Worker(legacy ? '/w-es5.js' : '/w.js')` gives both workers, and a chunk loader whose public path config can override at run time gives its constant chunk URL plus one `unresolved-reference` per load site. A worker URL from `URL.createObjectURL` is non-literal: it gives one `unresolved-reference` at the URL argument, and the blob's worker code is never analyzed.

**Injected scripts.** Every Node or Element insertion method (`appendChild`, `insertBefore`, `append`, `prepend`, `before`, `after`, `replaceWith`, `insertAdjacentElement`, `replaceChild`), called on any receiver, known or not, with the script element as a node argument, inserts it. `src` counts whether it is set before or after insertion, as HTML's prepare-the-script-element does. An element never shown inserted gives nothing. `document.write` and `createContextualFragment` are not followed in R1 (§21). The element's `type` decides its `sourceType`: `s.type = 'module'` gives a `module` artifact, and an attribute write under a key that doesn't fold (`o.setAttribute(k, v)`) is taken as not touching `src` or `type`. An injected script always runs in `window` with `realmBasis: reference`, whatever its creator's basis, because only the window has `document.createElement`, so it never raises `realm-uncertain`. A relative `src` resolves against each referencing document's base URL, so one `src` can give two artifacts; a creator with no entry document resolves it against its own URL. Literal code an injected element carries (`s.text`, `.textContent`, `.innerText`, or an appended `document.createTextNode(code)`) is analyzed as global nested code, located in the host artifact, and non-literal text is a `dynamic-code` limitation. An injected script whose `type` is set to a value that doesn't fold is parsed by its syntax, as a worker whose options can't be read is. An injected script whose `noModule` is set (`s.noModule = true`) is treated as HTML's `<script nomodule>`: it is not followed, it is counted, a local file it names is still swept (realm assumed `window`, `realm-assumed`), and a remote one is not scanned (§13, §21). A `noModule` value that doesn't fold is both alternatives (Principle 3): the script is followed as an injected reference, and it is also counted as possibly `nomodule`, in the same counter.

A service worker whose script falls outside every URL mapping is an `unresolved-reference`, and so is a `modulepreload as=serviceworker` outside every mapping. A dedicated or shared worker URL on another origin than its creator's is not followed and gives no record, because browsers refuse to run it. A same-origin one outside the mappings is a remote reference. So inside a `data:` worker, whose origin is opaque, only nested `data:` workers are followed. A worker call is dropped only when a declaration of its root name (`self`, `navigator`, `Worker`, …) is in scope at the call, within its own script. A worker whose options can't be read statically takes its `sourceType` by syntax, as a sweep-only file does. Options held in a binding (`const o = {type:'module'}; new Worker(u, o)`) count as unreadable in R1. Literal options Chromium rejects give nothing (Principle 1): a primitive other than `null` or `undefined` passed to `Worker` (`new Worker(u, 'name')`, `5`, `1n`), or a `type` that is any literal other than `'classic'`, `'module'` or `undefined` (`{type: null}`, `{type: 5}`), for `Worker` and `SharedWorker` alike. `SharedWorker` takes any primitive as its name, so `new SharedWorker(u, 'name')` stays a classic worker. A worker URL a mapping serves on another origin is not followed either. A `data:` worker URL is decoded and analyzed in the worker's realm with origin `inline`. A `data:` service-worker URL (`register("data:…")`, `modulepreload as=serviceworker`) gives nothing, because browsers refuse to register one.

**Import maps** apply in browser order. An inline module script's requests resolve only through the maps before it in tree order. Other requests resolve through all of the document's maps. Maps merge as Chromium and the HTML standard's example do, with no re-sort: a new top-level key that is an already resolved specifier, or a `/`-ending prefix of one, is dropped (the scope step's test). The resolved set records every request an inline module would follow, static and dynamic, and nothing else. They are added when the HTML walk reaches the module, whether or not its graph later fails (below): after `<script type=module>import "/app/main.js"; import("/app/lazy.js")</script>`, a later map's `/app/` key is dropped even when `/app/main.js`'s graph fails.

**Import attributes.** A dynamic import's options are read as EvaluateImportCall reads them, with a free `undefined` folded (§5). The import is an `unresolved-reference` only when a part the analyzer can't read could decide whether it names a JavaScript module: options that are a name or a call, a non-literal spread or computed key that could supply `with`, a `with` that is a name, or a non-literal spread or key inside `with`. A conditional or logical expression (`?:`, `&&`, `||`, `??`) as the options or as `with` is read branch by branch, each branch an alternative (Principle 3): the specifier is followed as a JavaScript module when any branch names one, and the import is an `unresolved-reference` only when a branch that could decide is itself unreadable. So `import(s, c ? { with: { type: 'json' } } : undefined)` follows `s`. Classes and accessors stay unreadable. An unreadable branch that could change `with` still raises the `unresolved-reference` when another branch follows `s`: `import(s, c ? undefined : o)` follows `s` and raises the record, so the scan is `complete-with-limitations`. In the options, the left operand of `&&` counts only as its falsy value (Principles 1 and 2): a falsy options value is either `undefined`, which loads the specifier as JavaScript, or a value the import rejects, which gives nothing. So `import(s, c && { with: { type: 'json' } })` follows `s` as a JavaScript module and raises no record. The left operands of `||` and `??` are unchanged: they stay unknown truthy or non-nullish values. So `import(s, undefined)`, `import(s, { with: undefined })` and `import(s, { other: foo })` are followed. `import(s, { with: { type: t } })` names no JavaScript module whatever `t` is, so it is not followed and gives no record. `with` is read as ECMA-262 reads it: own properties first, then the prototype a non-computed `__proto__:` sets. An array's or a regular expression's `with` has no attributes, so `import(s, [1])` and `{ with: [] }` are followed, while `{ with: ["json"] }` has the key `"0"`. Options the import rejects give nothing (Principle 1): options that aren't an object, a `with` that isn't an object, or a `with` entry whose key isn't `type` or whose value isn't a string (`{ with: ["json"] }`). A static import or re-export with an attribute key other than `type`, or a `type` other than `"json"` or `"css"` (`with { type: "javascript" }`), fails every module graph that contains it (Principle 1). Each root of such a graph (a module script element, or a dynamic import or module worker) gives nothing: nothing is followed from it, a remote module in the graph isn't fetched, and there is no record and no `parse-failure`. A module that a graph without the importer reaches is still followed from that graph, and a local file reached only through failed graphs is swept. A hint (a `modulepreload`, or a classic preload of a preload-only file) still names its own file, but nothing is followed through a failed graph from it. So with `<link rel=modulepreload href=/vendor.js>`, where vendor.js holds `import c from "./cfg.js" with { foo: "bar" }` and `import "https://cdn.example/rum.js"`, vendor.js stays a module reference in the preload's realm (`dedicated-worker` under `as=worker`), none of its requests is followed, and rum.js is not fetched and gives no record. A preload-only file whose graph fails is still analyzed as preload-only, but its imports aren't followed into the failed graph. A `type: "json"` or `type: "css"` request is not followed and gives no record, and its importer runs normally. The same reading applies to `&&` that gives the `with` value inside the options: in `import(s, { with: c && { type: 'json' } })`, `c` counts only as its falsy value, so `s` is followed as JavaScript with no record.

**Other script URLs.** A `data:` script `src` is decoded and analyzed as code the page carries, with origin `inline`. So is every other `data:` reference (a static or dynamic import, `modulepreload`, `preload as=script`, `importScripts`), in the referencing realm and with the reference's `sourceType`. A `data:` script the browser refuses to run (for example, a module without a JavaScript MIME type, a blocked classic type, malformed base64, a failed integrity check) gives no artifact, no record and no findings, like a script type the browser ignores. A script URL whose scheme is not `http:`, `https:` or `data:` (`javascript:`, `blob:`, `file:`, `about:`) gives nothing wherever it appears: no artifact and no record. A `javascript:` `src` gives no artifact and no record. Neither is a remote reference.

**Files that don't run as referenced.** A file named only by `<link rel=preload as=script>` is analyzed like a sweep-only file: `sourceType` by syntax and realm assumed `window` (`realm-assumed`), after the reference groups. A remote one is still fetched in `resolve` mode. When only such hints name a file and they disagree, its `sourceType` also comes from syntax. A preload-only file's own imports are followed and inherit its assumed realm basis, and so do their imports, all the way down. Its worker URLs are followed as ordinary worker references, in the worker's realm (`realmBasis: reference`). A syntax-typed visit happens only when preloads alone name a file, judged against running references in any realm and in no order: every classically preloaded file that no running reference names gets its syntax-typed visit, even when a preload-only file also imports it. The judgement is made again in each round (§19). The visit follows the requests the file's classic parse finds, and it parses the bytes of the preload's own fetch, whatever a module import of the same URL reads: a remote file accepted as a classic script but `remote-refused` as a module is still visited, while its own artifact keeps the refused read. The visit doesn't type the artifact. An import that never runs still makes the file a `module` artifact: with `<link rel=preload as=script href=a.mjs><link rel=preload as=script href=b.js>` and a.mjs importing `./b.js`, b.js is one `module` artifact (realm basis `assumed`) and also gets the visit. When a running reference in any realm runs the file, the preload follows that reference and adds no visit, artifact or record of its own: a classically preloaded `/worker.js` that running code starts with `new Worker('/worker.js')` is analyzed only as the worker, with no window artifact and no `realm-uncertain`. A file a page runs both as a classic script and as a module is analyzed both ways. A file referenced in two realms is analyzed in each, and a classic preload alone doesn't add a realm. A URL computed at runtime is never guessed. A non-literal reference is an `unresolved-reference` limitation (§13). The exception is a non-literal chunk URL inside a bundler chunk loader whose chunks are local, because the sweep covers those chunks. Whether they are local is decided by the URL's folded constant prefix first: a prefix that folds to an origin or path outside every mapping makes it a remote chunk URL. Otherwise the loader's origin decides, and an inline loader counts as local. A remote loader's chunk URLs that fold to constants are references, fetched in `resolve` mode (§17) and linked into the loader's group (§19). So are an ESM chunk loader's `import()` URLs (§6), with `sourceType` `module`. Any other remote chunk URL is an `unresolved-reference`.

**Sweep.** Every JavaScript file in the build directory is also analyzed, because chunk loaders compute lazy-chunk URLs that reference discovery can't see. An artifact found only this way is marked `discovery: sweep`. A swept file outside every URL mapping is excluded and listed, which keeps server bundles out of the scan. Remote artifacts are reached only by reference, never by the sweep. The sweep also finds a local file that the HTML names only through a script element the browser doesn't run (`nomodule`, an ignored `type`, or a `<script src>` inside `<template>` or `<noscript>`). The element is not followed as a reference (§19), and the file is analyzed like any other sweep-only file. The sweep follows symbolic links to files and directories, with loop protection by real path. A dangling link or a link cycle gives no record. A link whose target can't be reached is `unreadable` when a mapping serves its path or a path under it. Every pairing method's search of the build directory uses this same listing. It takes `.js`, `.mjs` and `.cjs` files (any case) as JavaScript. Only `.wasm` counts in `nonJs`, and other unreferenced files a mapping serves are counted in an informational counter. A sweep-only file is parsed as a `module` when it parses only as one (an `import` or `export` declaration, `import.meta` or a top-level `await`), and as a `script` otherwise. A sweep-only file's own literal requests are followed as a preload-only file's are: its worker URLs are ordinary worker references (`realmBasis: reference`), its imports inherit its assumed basis, and a remote import is fetched in `resolve` mode or gives `offline-skipped` offline. A worker file the sweep analyzed as `window` becomes its worker artifact and is dropped as a standalone sweep.

**Artifacts.** Every artifact records:

- URL, and path where local
- content hash
- parent or importer
- discovery method (`reference`, `injected`, `sweep`)
- origin (`local-build`, `same-origin`, `cross-origin`, `inline`)
- resource type, and `sourceType` (script or module)
- realm
- source-map reference and pairing method
- retrieval status

Artifacts are content-addressed: identical bytes with the same `sourceType` and realm are analyzed once. Each URL or inline copy of them keeps its own artifact record, with its own origin, source-map pairing and attribution key, so no copy's findings are lost.

**Realm.** Each artifact records the realm it runs in: `window`, `dedicated-worker`, `shared-worker` or `service-worker`. The realm comes from how the artifact was referenced. A sweep-only artifact inherits its realm from a linked module runtime when it has one. Otherwise it is assumed to be `window` (`realmBasis: assumed`). It is a `realm-uncertain` limitation only when worker markers are present (top-level `importScripts`, or `self.addEventListener` for `install`/`fetch`/`message`).

**Content that isn't JavaScript.** Script types the browser does not execute are ignored. WASM is counted in an informational `nonJs` counter, and its JavaScript glue is analyzed normally. `eval`, `new Function` and string timers whose code is a string literal are parsed and analyzed as nested code, located inside their host artifact. A number, boolean or `null` literal given to `Function`, as a parameter or as the body, is literal code converted with ToString (Principle 2), so `Function("a = window.fetch = f", 1)` is analyzed. A non-literal code string is a `dynamic-code` limitation. So is literal code that doesn't parse (`Function(1, "x")`, `Function("return 1; }")`), one record each, and a call that reaches the native `eval`, `Function` or a string timer indirectly (`.call`, `.apply`, `Reflect.apply`, `Reflect.construct`, a computed key such as `window["eval"]`, or `(function(){}).constructor`). The code of an indirect call is not analyzed. Any route shown to reach these natives counts, including `.bind` and `.constructor` of any known function (`[]["constructor"]["constructor"](s)`). So does any route to `%AsyncFunction%`, `%GeneratorFunction%` or `%AsyncGeneratorFunction%`, which also compile code from strings. Shown routes include a catalog reader given the global object and a constant key (`Reflect.get(window, "eval")`, `Object.getOwnPropertyDescriptor(window, "eval").value`), and `.constructor` of a class literal whose statics don't write `constructor`, of a locally declared function that is never reassigned, or of any function-valued catalog member (`[]['filter']['constructor']`, `alert.constructor`), through `.call`, `.apply` and `.bind` too. A class declaration counts as a class literal, and a named function expression called by its own name counts as a locally declared function, with the same stop rules: `class C {}; C.constructor(s)` and `(function g(){ g.constructor(s) })()` each give one `dynamic-code` record. A `const` alias of a class or function (`const K = class {}; K.constructor(s)`) is not followed in R1 (§21). An unknown base (`class extends B`, `({...o})`) shows nothing. A class or function base stops being shown when a static key is or may be `constructor` (`static constructor(){}`, an unfolded `static [k]`), when the function's name is written, or when any code the analyzer sees gives it its own `constructor` or a new prototype (`static { this.constructor = g }`, `f.constructor = g`, `defineProperty(f, 'constructor', …)`, `setPrototypeOf(f, …)`). Code the analyzer doesn't see stops nothing, so `(class { static x = init(this) }).constructor(s)` is still shown. A call that throws before the native runs gives nothing (Principle 1): `new eval(s)`, `Reflect.construct(eval, [s])`, or an argument list that CreateListFromArrayLike refuses (`eval.apply(null, "s")`).

### Source maps

Maps in the build directory are found by, in order:

1. the `SourceMap` header
2. the `sourceMappingURL` annotation
3. a `<file>.map` sidecar
4. `debugId`

Then the declared **source-map directories** are searched one at a time, in declared order: CLI flag order, or the config array's order when no flag is given. Each is searched recursively. Its listing follows the sweep's link rules: links to files and directories are followed, with loop protection by real path, and a dangling link, a cycle, an unlistable subdirectory or an unreachable link target gives no record, so maps behind it don't pair. Within a directory, maps pair to artifacts by, in order:

1. **`debugId`**: the artifact's `//# debugId=` equals the map's, ignoring ASCII case. This works for any artifact, remote ones included. Maps with the same `debugId` are tried in path order.
2. **Mirrored annotation**: the artifact's `sourceMappingURL`, resolved through the URL→path mapping, exists at the same relative path in the directory. Local-build artifacts only.
3. **Mirrored sidecar**: `<dir>/<artifact's build-relative path>.map`. Local-build artifacts only.

Maps are never paired by basename or by the map's `file` field. A map a pairing method names in a declared directory (a mirrored annotation or sidecar) that exists but can't be read is still `unreadable`, and so is a directory at that path that the listing holds (EISDIR), such as a loop link. A declared directory's listing holds the same paths the build directory's does: a directory at that path which the listing can't list gives no record, and the artifact counts as `withoutMap`. A mirrored annotation names whatever file is at its path, whatever its extension.

**Verification.** Every pairing is verified, wherever the map came from:

- the map is `version` 3
- every mapped generated line and column exists in the artifact. Lines end at §5's terminators, or only at LF and CR when the artifact holds a raw U+2028/U+2029 and the map fits that reading. A column may equal its line's length. Attribution (§10) looks positions up with the reading that verified, and with the LF/CR reading when both verify.
- the `debugId`s are equal when both sides have one
- token spot checks pass: no mapped generated position splits an identifier name or a number in the artifact (the code units on both sides of it are never both identifier parts)

A candidate that fails is counted as `stale`, and discovery moves on to the next method. The first verified map wins, and maps are never merged. Maps in a source-map directory are used only for attribution, never analyzed as code.

**Reading annotations** follows the current ECMA-426 draft. Only the last `//#` or `//@` line comment names a map, and only when nothing but whitespace and line comments follows it. Code or a block comment after it cancels it, block comments are never read, and an empty value names nothing. A quoted line comment, one whose own text contains `"`, `'` or a backtick, counts as code, as the draft's check without parsing has it: it cancels both the `sourceMappingURL` and the `debugId` before it, and an annotation after it still names a map (`code;` / `// don't edit` / `//# sourceMappingURL=a.map` names `a.map`). An annotation on the same line as code (`}).call(this,"x");//# sourceMappingURL=…`) is read, since its own text holds no quote. The `//# debugId=` comment is read the same way. `debugId` candidates, in the build directory and in each declared directory, are `.map` files in any case. When several carry the artifact's `debugId`, they are tried in path order and the first that verifies wins. For a local-build or inline artifact, a map a pairing method names (an annotation's target or an existing sidecar) that exists but can't be read is `unreadable`. A map exists when the sweep's listing holds it: a named map the listing holds is `unreadable` whatever the read error, and one the listing lacks gives no record. "Holds" means the same file: a named path is held when it resolves to a file or directory the listing holds under any spelling, compared by device and inode or by real path. So `//# sourceMappingURL=App.js.map` on a case-insensitive file system whose listing holds `app.js.map`, and `self/app.js.map` through a link `self -> .`, are held. The listing holds the directories it walks, so a directory at a named map's path is `unreadable` (EISDIR). A loop link the sweep stops at (`maps -> .`) is held the same way (EISDIR, `unreadable`). A directory the sweep can't list is held only where the sweep records it, and a link whose target the sweep can't reach is held only when a mapping serves its path. Any other unreadable map file gives no record. A remote artifact's map never changes completeness: any failure to fetch or read it only changes counters (§17).

Each artifact records its pairing method: `header`, `annotation`, `sidecar`, `debug-id`, `external-debug-id`, `external-annotation`, `external-sidecar` or `none`.

Completeness:

- A declared directory that is missing or unreadable makes the scan `incomplete` (`unreadable`).
- A directory where nothing pairs also makes it `incomplete` (`source-maps-unpaired`), because it almost always means the wrong directory or a different build. A directory counts as paired when any of its maps verifies against an artifact through an external method, even where an earlier map already won. Discovery verifies such candidates only to count them, and the map each artifact records doesn't change. A candidate read only to count it gives no record when it can't be read. So a redundant or nested directory is not unpaired.
- Partial pairing is normal and reported only in counters (§13).

## 3. Platform mutation boundary and write outcomes

### What is a platform mutation

A **platform mutation** is code that does any of these to a **target** (a member of a native holder in the catalog, §4):

- replaces or wraps it
- deletes it
- redefines its descriptor
- changes a holder's prototype
- adds a member to a native prototype, constructor or namespace

These count:

- replacing or deleting an operation, a constructor, or a readonly or `[Replaceable]` attribute
- redefining a property descriptor
- `Object.setPrototypeOf`, `Reflect.setPrototypeOf` and `__proto__` assignment on a native holder
- adding a member to a native prototype, constructor or namespace
- mutating a **platform singleton**, a native instance reachable from the global object: `history`, `navigator`, `navigator.serviceWorker`, `navigator.geolocation`, `document`, `location`, `localStorage`/`sessionStorage`, `console`, `performance`, `crypto` and `crypto.subtle`, plus `customElements`, `document.fonts`, `navigator.clipboard`, `navigator.storage`, `navigator.mediaDevices`, `navigator.permissions`, `navigator.locks` and `navigator.userActivation` (the corpus harness's list). The overlay lists every singleton (§4). For example, `history.pushState = wrap`.

These don't:

- **Assigning a writable Web IDL attribute** is API use: `window.onerror = f`, `document.title = t`, `location.href = u`, `el.onclick = f`. So is anything else whose `assign` kind is `setter`, `put-forwards` or `event-handler`, and an assign to an ECMAScript accessor whose descriptor has a setter (other than `Object.prototype.__proto__`, below). `Window.opener` splits on the value, because HTML's setter redefines it as an own data property for any value but `null`, as a `[Replaceable]` setter does. `window.opener = null` is API use. A value shown to be non-null gives `Window.opener` `replace`, and so does `var opener = w` under `declare`. An unresolved value gives a `replace` with `outcome-undecidable`, and so does writing back what its getter returns (below).
- **Ordinary instances** (`xhr.onreadystatechange = f`, `headers.set(...)`, an element's `dataset`) are never targets.
- **New non-native globals** (`window.jQuery = …`, `self.webpackChunkapp = …`) are not findings. `add` applies only to native holders.
- **Storage data**: `localStorage.foo = 'bar'`, for a name that isn't visible on `Storage.prototype`, is API use.
- **A delete through an object that only inherits the member** (`delete localStorage.setItem`, `delete history.pushState`) changes no native, so nothing is recorded.
- **A proven restore** (below).

**Shadowing writes.** An own-property write that shadows an inherited member is named after the object written, with a derived `shadows` naming the inherited member (§4). For example:

- `localStorage.setItem = f` is `localStorage.setItem`, shadowing `Storage.prototype.setItem`.
- `self.fetch = w` in a worker is `DedicatedWorkerGlobalScope.fetch`.

**Mechanisms.** A mutation is made by one of these mechanisms:

- `assign`
- `define-property`
- `define-properties`
- `reflect-define`
- `bulk-assign` (`Object.assign(window, …)`)
- `delete`
- `set-prototype` (including a `__proto__` assignment that reaches `Object.prototype.__proto__`'s setter)
- `declare`

`Reflect.set` is an `assign`, with the same [[Set]] rules. `Reflect.deleteProperty` is a `delete`. `__defineGetter__` and `__defineSetter__` are a `define-property` of an enumerable, configurable accessor. `Object.freeze`, `Object.seal` and `Object.preventExtensions` of a native holder are not recognized in R1 (§21).

The mechanism is evidence, not identity (§8).

**Declarations in classic scripts.** A top-level `var`, `function`, `let`, `const` or `class` of a native name in a classic script is a mutation of the global object's member (`Window.fetch`, or `DedicatedWorkerGlobalScope.fetch` in a classic worker script). Its mechanism is `declare`. The rules by kind:

- **`var x = v`** is an assignment of `v` and follows the `assign` row of the outcome table. `var name = 'x'` and `var onload = f` are API use, and `var length = 5` (`[Replaceable]`) is a `replace`. A bare `var x;` of a name the global object has as its own is not recorded. For a name the global object only inherits, `var` follows ECMA-262's CreateGlobalVarBinding, an own define first and then [[Set]]: a bare `var addEventListener;` gives `Window.addEventListener` `replace`, shadowing `EventTarget.prototype.addEventListener`, and `var __proto__ = x` gives nothing.
- **`function x(){}`** over a configurable global is `replace` or `wrap`, and it is also a locking mutation.
- **`let`, `const` and `class`** leave the property alone but hide it from every bare-name caller in the realm. They are a finding on the global member. The effect follows the binding's value, as for an assign: `replace`, or `wrap` with wrap evidence, for any value that isn't a read of the same slot, a bare `let fetch;` and `class Request {}` included, and nothing for `const fetch = window.fetch` or `const { fetch } = window`, as for a write-back. `let name = 'x'` and `const onload = f` are `replace` although a `var` of them is API use, because the property's setter never runs. `locks` is `false`.
- **Module scripts.** Top-level declarations in a module are never global.
- **Annex B block functions and direct eval** follow ECMA-262 per form. A block function follows the `assign` row where its block runs: `if (!window.fetch) { function fetch(){} }` is `Window.fetch` `replace` with `locks: false`, `{ function onload(){} }` is API use, and a block `function top(){}` is a sloppy `readonly` ineffective write with `throws: never`. Top-level direct-eval `var` and `function` give `replace` with `locks: false`, and eval `let`, `const` and `class` give nothing. String-timer code is a classic script, so the rules above apply to it in full.

There is no evaluation-order modelling between scripts. Instead, a scan-wide check per realm collects the top-level `let`/`const`/`class` names of every classic script. A bare-identifier write in another script that matches one of those names is handled like this:

- It keeps its finding, with a trace note naming the declaring artifact.
- If the name is a `const`, the write throws, so its outcome can't be decided and its mutation confidence is lowered (§9).

A member write whose holder chain starts at a colliding bare name (`Node.prototype.foo = f` or `Promise.prototype.finally = g` after another script's `class Node {}` or `const Promise = MyPromise`) also keeps its finding and gets the same `note`. It gets no `const-collision`, because reading a `const` doesn't throw.

Redeclarations across scripts are ignored.

### Ineffective writes

A write that cannot change its target is an **ineffective write**. It is never a finding, and it is never baselined, gated or counted toward completeness. The outcome is decided per occurrence from an **outcome table**, using ECMAScript's descriptor-validation rules. The table's inputs are:

- the member's catalog descriptor (data or accessor, `writable`, `configurable`) and its `assign` kind (§4)
- the mechanism
- the written object's `immutablePrototype` flag

The outcome is judged against the **unmutated** catalog. A `=` that only works because an earlier `defineProperty` made the member writable is still ineffective, and the earlier write is already a finding.

An ineffective write has one of these reasons:

| Reason | Examples |
|---|---|
| `readonly` | `navigator.userAgent = x`; `localStorage.length = 5`; `var closed = 1` |
| `lenient-setter` | an assign to a `[LegacyLenientSetter]` attribute |
| `non-writable` | `Math.PI = 3`; `var NaN = 1` |
| `non-configurable` | redefining a constant or `[LegacyUnforgeable]` member; `function top(){}`; `let document` |
| `immutable-prototype` | `setPrototypeOf(window \| Object.prototype \| EventTarget.prototype \| WindowProperties, …)`; `window.__proto__ = x` |

These cases are real mutations, not ineffective writes:

- `Object.defineProperty(navigator, 'userAgent', …)` is a `descriptor-change`, because the property is configurable.
- `setPrototypeOf(localStorage, X)` is a `prototype-change` on the singleton, with target `localStorage.[[Prototype]]` (§4).
- An assign or define of a name visible on the chain, made on WindowProperties, is a shadowing write named `WindowProperties.<member>`.

A write that changes nothing is neither a mutation nor an ineffective write, and gives no finding: a define whose attributes all equal the unmutated catalog's (`{ configurable: true }` on `Window.fetch`), `setPrototypeOf` to the prototype the holder already has, a prototype value that is not an object or `null`, and writing a member's own value back (`window.fetch = window.fetch`). "Own value" means a read of the same slot, not a value the catalog knows is identical: `NodeList.prototype.forEach = Array.prototype.forEach` and `Array.prototype[Symbol.iterator] = Array.prototype.values` are `replace`s, although Web IDL and ECMA-262 make each value the same function. An assign or define on WindowProperties of a name its chain doesn't have (`Object.getPrototypeOf(Window.prototype).zz = 1`) gives no finding and no record, because the engine refuses it.

**A delete that is always rewritten.** A delete that the same function follows, on every path, with a define or assign of the same slot gives no finding of its own. The same slot means the same holder value and member key, in §5's sense of the same (holder, member). The later write's finding stands, judged against the unmutated catalog, and the delete leaves only a trace `note`. So core-js's `defineBuiltIn(Array.prototype, wellKnownSymbol('iterator'), …)` gives one `Array.prototype.@@iterator` `replace`. A delete that isn't always rewritten stays a `delete` finding.

Each ineffective occurrence records `throws`:

- `always`: throws in sloppy and strict code alike, whether at parse or instantiation, before the script runs (a TypeError or SyntaxError, as for `function top`, `let document` and `const location`), or when the write runs (`Object.defineProperty(Math, 'PI', …)`, `Object.setPrototypeOf(window, x)`, `window.__proto__ = x`)
- `strict-only`
- `never`

A throwing write does **not** make the code after it unreachable. Over-reporting is visible in review, while under-reporting would hide a finding. A declaration that fails GlobalDeclarationInstantiation stops the whole script in Chromium, but it still gives its ineffective-write record (`Window.top`, `non-configurable`, `always`), and the script's other writes, before it and after it, keep their findings.

**No-op or ineffective.** A write whose every outcome either changes nothing or is ineffective, depending on a value the analyzer can't see (`Object.defineProperty(Math, 'PI', d)` or `Object.setPrototypeOf(window, p)` with `d` or `p` unresolved), is recorded as ineffective: one record under the member's reason (`non-configurable`, `immutable-prototype`), with the `throws` of the path that changes something (`always` for `defineProperty`, `setPrototypeOf` and `__proto__`, `never` for the `Reflect` forms), and an `outcome` step saying it could also be a no-op. It is not a finding, and `summary.ineffectiveWrites` counts it.

**Undecidable outcomes stay findings.** An ambiguous written object, a partly resolved mechanism, or an unresolved descriptor where the outcome depends on it keeps the finding, with lowered mutation confidence and a trace note (§9). Only a write the analyzer can *show* has no effect is dropped. A define of a catalog member whose descriptor the analyzer can't see (an unresolved `d`, a spread of a value the heap doesn't hold, a `__proto__` field whose value is neither a primitive nor a catalog holder) is a `descriptor-change`, with `outcome-undecidable` where the outcome depends on the descriptor and `locks: unknown`. A `__proto__:` field whose value is a catalog holder is read through as ECMA-262 reads it, against the unmutated catalog. `Object.prototype` supplies no descriptor fields, so `{ __proto__: Object.prototype, value: f }` equals `{ value: f }`, and `{ __proto__: Object.prototype }` alone changes nothing. A holder that supplies a callable `get` or `set` (`Map.prototype`) beside an own data field makes ToPropertyDescriptor throw, so the define gives nothing (Principle 1). A define whose descriptor is several seen heap objects with different effects gives one finding per effect, each with `outcome-undecidable` and its own `locks`, as §5's candidate sets do for holders and members: `let d = { value: w }; if (lazy) d = { get: () => w }; Object.defineProperty(window, 'fetch', d)` gives `Window.fetch` `replace` and `Window.fetch` `descriptor-change`. A descriptor whose alternatives are a seen heap object and a value the analyzer can't see also gives one finding per effect (Principle 3): the seen object's own effect, with its own `locks`, plus a `descriptor-change` with `locks: unknown` for the unseen alternative, each with `outcome-undecidable`. So `var d = window.__cfg || { value: w, configurable: true }; Object.defineProperty(window, 'fetch', d)` gives `Window.fetch` `replace` and `Window.fetch` `descriptor-change`. A primitive alternative of a descriptor reads as `refused`, because ECMA-262's ToPropertyDescriptor throws on a non-object, so it gives nothing (Principles 1 and 3): `Object.defineProperty(window, 'fetch', c ? undefined : { value: w, configurable: true })` gives only the seen object's `Window.fetch` `replace`, with `outcome-undecidable` and `locks: false`. A `__proto__:` field with several candidate values splits the same way, one descriptor per candidate, only when every candidate is a catalog holder: `{ __proto__: c ? Map.prototype : Object.prototype, value: f }` gives nothing on the `Map.prototype` branch (ToPropertyDescriptor throws) and `Window.fetch` `replace` with `outcome-undecidable` on the `Object.prototype` branch. A candidate set that includes an unknown value stays unseen, and is read as a lone unresolved `__proto__:` value is: a `replace` with `outcome-undecidable` and `locks: unknown` when an own `value` comes after every unseen part (`{ __proto__: c ? Object.prototype : x, value: f }`, like `{ __proto__: p, value: f }`), and a `descriptor-change` with `outcome-undecidable` and `locks: unknown` otherwise (`{ __proto__: c ? Object.prototype : x }`). A descriptor passed to a call the analyzer can't resolve keeps only the field writes the analyzer sees (§5): `const d = { value: w, configurable: true }; track(d); Object.defineProperty(window, 'fetch', d)` is a `replace` with `locks: false`. A define over an inherited member with an unseen descriptor (`defineProperty(document, 'cookie', d)`) is a `descriptor-change` on the shadowing target (`document.cookie`), with `locks: unknown` and no `outcome-undecidable`. A write-back is shown to change nothing when both sides reach the same member through the same window expression (`parent.fetch = parent.fetch`, `frames[0].fetch = frames[0].fetch`). `document.defaultView` and `frames[i].parent` count as this window, with realm instance `current`, for write-backs, prototype no-ops and identity comparisons alike. Holders reached through one window expression compare equal, and a prototype set through one window expression, with nothing between the reads that could change it, changes nothing. Any other define of a member the catalog doesn't list, with an unseen descriptor, is an `add` with `locks: unknown`. A descriptor whose own `value` comes after every spread or key that doesn't fold, and doesn't read the same slot (`{ ...desc, value: patched }`), is a `replace` with `outcome-undecidable` and `locks: unknown`. A key that doesn't fold after the `value` (`{ value: f, [k]: v }`) may override it, so the define stays a `descriptor-change` with `outcome-undecidable` and `locks: unknown`. A spread or `Object.assign` copy of a heap object the analyzer sees copies its seen fields as ECMA-262 CopyDataProperties does, and a maybe-absent field stays maybe-absent: `const base = { value: w }; Object.defineProperty(window, 'fetch', { configurable: true, ...base })` is `Window.fetch` `replace` with `locks: false` and no `outcome-undecidable`, and `{ ...base }` with `base = { configurable: true }` changes nothing. An object a native returns, chiefly `Object.getOwnPropertyDescriptor`'s result, is an allocation site with unseen base fields plus the field writes the analyzer sees, read as `{ ...gOPD(…), <written fields> }`: `const d = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'send'); d.value = w; Object.defineProperty(XMLHttpRequest.prototype, 'send', d)` is a `replace` with `outcome-undecidable` and `locks: unknown`, sharing its fingerprint with `{ ...desc, value: w }`. Unseen parts never disappear, so `delete d.value; d.get = g` gives a `descriptor-change` with `outcome-undecidable`. `Object.create(null)` is treated like `{}`. A restore still sees the unmodified `getOwnPropertyDescriptor` value. `Reflect.set(T, k, v, R)` follows [[Set]]: it writes `R`, and an unresolved `R` gives nothing. When `R` resolves to a native holder and `T` doesn't (`Reflect.set(o, 'fetch', f, window)`), the write on `R` is worked out as if `T`'s chain lacked the member: `R`'s own writable data property gives a `replace`, an inherited Web IDL member on a global or prototype holder a shadowing `replace`, and a member an addable holder lacks an `add`. Each has `outcome-undecidable`, a `confidence-reason` step sited at `T`, and `locks: false`. `R`'s own accessor or non-writable member gives nothing. A `T` that is a known non-object (`Reflect.set(undefined, 'fetch', f, window)`) throws and gives nothing (Principle 1). A `__proto__` key splits by `T`. When `T` is known to be an ordinary object whose chain reaches `Object.prototype` (`{}`, an array or function literal), `Object.prototype.__proto__`'s setter runs on `R`: `Reflect.set({}, '__proto__', p, Math)` is a `set-prototype` giving `Math.[[Prototype]]` `prototype-change`, with no `outcome-undecidable`, and on window it is the `immutable-prototype` ineffective write that `window.__proto__ = x` is. When `T` is unresolved, the rule above applies as written, so a `__proto__` key gives nothing. An assign to a `[Replaceable]` attribute on an object that isn't an instance of its interface (`WorkerGlobalScope.prototype.performance = p`) throws before writing and gives nothing. Writing back what a `[Replaceable]` getter returns (`window.length = window.length`) is a `replace`, because it turns the accessor into a data snapshot. Writing back what `opener`'s getter returns (`window.opener = window.opener`, `Object.assign(window, { opener })`, `var opener = window.opener` in a classic script) is a `replace` with `outcome-undecidable`, because the getter may return `null`.

For a wildcard target (§5), the outcome is evaluated over every catalog member that matches:

- all effective: a finding
- all ineffective: an ineffective-write record under the wildcard name
- mixed: a finding with lowered mutation confidence

A wildcard matches its holder's own catalog members. A singleton or instance holder matches its interface's members (`History.prototype` for `history`, `Storage.prototype` for `localStorage`, `Navigator.prototype` and its mixins for `navigator`), not shared ancestors. API-use members are left out of the evaluation, so `location.*` is all ineffective: a record, not a finding. When partial knowledge of the key narrows it, the matched set is narrowed to the members that start with a folded prefix, or to a member candidate set's candidates, and the name stays `<holder>.*`: `Math[k] = wrap(Math[k])`, with `k` one of five non-writable constants, is an ineffective-write record `Math.*`.

**Record.** Ineffective writes are listed in a scan-level `ineffectiveWrites[]`, grouped per `(realm, target, reason)`. Each record carries:

- the target
- the reason
- occurrences, each with the location, attribution and reachability a finding's occurrence has, plus its intended effect, mechanism, strictness and `throws`

Effect and mechanism live on each occurrence, and a record has no effect of its own, so one group can hold both `delete Math.PI` and `Object.defineProperty(Math, 'PI', { value: 3 })`.

Records have no fingerprint and no baseline state. They follow `--surface` exactly as findings do, matching through `shadows`.

### Restores

A write that puts back the unmutated native value, or descriptor, of the same object and member is a **restore**: for example an SDK's `stop()` that writes the saved original back. A proven restore is not a platform mutation. It is never a finding or an occurrence, and it never raises a finding's reachability.

A restore is **proven** when, on every path, the value written is the unmutated native of the same written object and member, however it travelled: locals, parameters, closures or heap fields. For a define-property restore, the written value is the descriptor from `getOwnPropertyDescriptor` on the same slot. The same slot includes the inherited one: a `getOwnPropertyDescriptor` of the holder the unmutated catalog resolves the member from, along the written object's chain, counts, so `Object.defineProperty(history, 'pushState', Object.getOwnPropertyDescriptor(History.prototype, 'pushState'))` after `history.pushState = w` is proven, with `leavesOwnShadow: true`. A fresh descriptor literal whose `value` is the saved native counts too, with any attributes on an own shadow the install created: every shimmer unwrap (`Object.defineProperty(t, e, { configurable: true, enumerable: r, writable: true, value: n })`) is proven, and on `history.*` it records `leavesOwnShadow: true`. Two further rules:

- A `||`/`??` fallback after that read is dead code when the unmutated catalog defines the member directly on that holder in every catalog version.
- A union that contains any non-native value is not proven.

Guards on the restore (`if (current === ours)`) never make a proof fail. A guard that tests the saved value narrows it: `if (orig)`, `if (orig != null)` and `typeof orig === 'function'` remove the nullish or non-function alternatives, so `if (orig) { window.fetch = orig; orig = null }` is proven, with `guard: none`. `window.fetch = orig; orig = undefined` stays unproven, because a second `stop()` writes `undefined`.

A proven restore leaves an entry in the resolution trace of the install occurrence in the same chain (§14):

- its location
- `guard: identity | none`
- `leavesOwnShadow`, which is true when the restore writes the native back into an own property that the install created, as `patch(history, 'pushState')` does

The entry is not identity, doesn't decide `changed`, and is not baselined. A restore with no install occurrence in its chain is dropped. An unproven restore whose chain has an install occurrence of the same target becomes one more occurrence of that install's finding and takes its effect, and so its fingerprint (`wrap`, for example). It can raise that finding's reachability, but it never adds a fingerprint. This is the one case where the effect doesn't follow the written value ([ADR 0011](adr/0011-effect-follows-the-value-not-the-attributes.md)). An unproven restore with no install in its chain follows the ordinary rules. The chain is the instantiated call chain the saved native was read in: an install is an occurrence of the same target that sets a value (`replace`, `wrap` or `descriptor-change`) and whose write shares a function with that read, or whose function reaches the read's function, or is reached from it, along resolved calls (a caller-less function along its creation site, §7). A `delete` is never an install, so a write after a delete follows the ordinary rules. When the chain holds several installs, the restore joins the first in document order, and it takes that install's attribution lookup as well as its effect, so it never adds a fingerprint.

## 4. Native catalog and catalog versions

### Sources

- **Browser APIs** are generated from an exact-pinned `@webref/idl`. The generator:
  - merges partials and mixins
  - runs the Web IDL exposure-set algorithm (`Window`, `DedicatedWorker`, `SharedWorker` and `ServiceWorker` map to realms)
  - places each member on its holder: `[Global]` members are own properties of the global, `[LegacyUnforgeable]` members are per-instance, and statics sit on the interface object
- **ECMAScript intrinsics** are generated from ECMA-262, pinned to an edition tag or `@tc39/ecma262-biblio`, plus ECMA-402 for `Intl`. Each realm has its own intrinsics.
- **Curated overlays** add:
  - the platform singletons (§3), and their alias groups
  - own members that HTML defines in prose rather than IDL: `location.valueOf` and `location.@@toPrimitive`, with their real (non-writable, non-configurable) descriptors
  - the four ECMA-262 own properties that have no clause of their own: `Function.prototype.caller` and `.arguments`, `Array.prototype.length` and `String.prototype.length`, with ECMA-262's descriptors
  - the owner → surface map
  - the protected-surface list (§12)
  - exclusions
  - retained targets
  - small ES additions such as `Temporal`
  - the members the Web IDL binding synthesizes rather than declares: stringifier `toString` (`URL.prototype.toString`), the methods of `iterable`, `maplike`, `setlike` and `async_iterable` declarations (`Headers.prototype.entries`, `Headers.prototype.@@iterator`, `RTCStatsReport.prototype.get`, `FontFaceSet.prototype.add`; a readonly `maplike` or `setlike` has no `set`, `add`, `delete` or `clear`), the `@@iterator` (`%Array.prototype.values%`) that Web IDL's "define the iteration methods" gives every interface with an indexed property getter, whether or not it declares `iterable` (`HTMLCollection.prototype.@@iterator`, `FileList.prototype.@@iterator`), and the structural properties `X.prototype`, `X.prototype.constructor`, `@@toStringTag` and `@@unscopables` for `[Unscopable]` members. As for ECMAScript intrinsics, an interface object's or operation's `length` and `name` are not targets
  - engine extensions: own properties V8 defines on ES intrinsics outside ECMA-262 (`Error.stackTraceLimit`, `Error.captureStackTrace`). They are native members like any other, so a write to one is a `replace`, not an `add`.
  - `HTMLDocument`, as every engine ships it although `@webref/idl` and the HTML Standard don't: a `constructor` holder `HTMLDocument` held by the `global` target `Window.HTMLDocument`, whose `.prototype` is the `prototype` holder `HTMLDocument.prototype` between `document` and `Document.prototype`. `HTMLDocument.prototype` has its own `constructor` (the `HTMLDocument` interface object) and `@@toStringTag` (`"HTMLDocument"`, non-writable, configurable), as other interface prototypes do. No other interface that `@webref/idl` lacks is added in R1 (§21).
- **SES `permits` and BCD** are cross-checks in CI, never sources.

### Targets and holders

A **target** is `{ realm, holder, name, shadows? }`.

- `name` is the realm-free catalog id, e.g. `Window.fetch`, `EventTarget.prototype.addEventListener`, `history.pushState`, `console.log`, `Array.prototype.@@iterator`.
- `realm` is `window`, `dedicated-worker`, `shared-worker` or `service-worker`. `Window.fetch` and `WorkerGlobalScope.prototype.fetch` are different targets.
- `holder` follows from `name`:
  - `global`
  - `constructor`
  - `prototype`
  - `instance` (a platform singleton)
  - `namespace`: the IDL namespaces (including `WebAssembly`); `Math`, `JSON`, `Reflect`, `Atomics`, `Intl`, `Temporal` and `Temporal.Now`. The property that holds a `[LegacyNamespace]` interface object (`WebAssembly.Module`) is a `namespace` target. The interface object itself is a `constructor` holder, like any other.
- `shadows` is derived from the catalog and is not identity.

**Naming rules:**

- **Shadowing writes name the object written** ([ADR 0002](adr/0002-shadowing-writes-name-the-written-object.md)):
  - `window.addEventListener = w` → `Window.addEventListener` (`shadows: EventTarget.prototype.addEventListener`)
  - `history.pushState = w` → `history.pushState`
  - `defineProperty(document, 'cookie', …)` → `document.cookie`
  - A shadowing target is valid only when the member resolves along the written object's IDL chain. Otherwise the key is an expando and nothing is reported.
- **Worker globals** use the realm's global interface: `self.fetch = w` in a dedicated worker → `DedicatedWorkerGlobalScope.fetch`.
- **Global properties** are `global` targets named on the realm's global interface. This covers interface objects, namespace objects, legacy callback interface objects and ECMAScript globals: `Window.XMLHttpRequest`, `Window.console`, `Window.NodeFilter`, `Window.Promise`, `DedicatedWorkerGlobalScope.NaN`.
- **Prototype changes** are named `<holder>.[[Prototype]]`: `Storage.prototype.[[Prototype]]`, `XMLHttpRequest.[[Prototype]]`, `localStorage.[[Prototype]]`. The target's `holder` is the kind of the holder whose prototype changes.
- **A realm global interface's own interface object** (`Window` read as a value, `window.Window`) is a `constructor` holder named by its path from the global: `Window.Window`, `DedicatedWorkerGlobalScope.DedicatedWorkerGlobalScope`. `Window.foo = f` → `Window.Window.foo`, and `Object.setPrototypeOf(Window, X)` → `Window.Window.[[Prototype]]`. Its `.prototype` is the existing `Window.prototype` holder.
- **Web IDL chains end in the realm's intrinsics**, as the binding does: interface prototype objects and namespaces reach `Object.prototype`, interface objects `Function.prototype`, and `DOMException.prototype` reaches `Error.prototype`. `console`'s own empty prototype object is a `prototype` holder named `console.[[Prototype]]`, by its path from the global. A member that only this ES tail supplies is shadowed by a write on a Web IDL prototype, constructor or namespace (`XMLHttpRequest.prototype.toString = f` → `XMLHttpRequest.prototype.toString`, shadowing `Object.prototype.toString`). On a singleton or the global, the same write is an expando and gives nothing. `console`, a singleton and a namespace, follows the namespace rule: `console.toString = f` is `console.toString` (holder `namespace`), shadowing `Object.prototype.toString`, and a new name stays an `add`.
- **`[LegacyWindowAlias]` and `[LegacyFactoryFunction]` names** are `global` targets (`Window.webkitURL`, `Window.Image`). An alias holds the same interface object. A legacy factory function (`Image`, `Audio`, `Option`) is its own `constructor` holder, named by its name, with the element interface as owner and `Function.prototype` as its prototype. `Window.Image` holds `Image`. Its only target is its `prototype`: `Image.prototype`, which holds `HTMLImageElement.prototype`. Its `length` and `name` are not targets. So `Image.prototype.decode = w` gives `HTMLImageElement.prototype.decode` `replace`, `Image.foo = 1` gives `Image.foo` `add`, and `Object.setPrototypeOf(Image, P)` gives `Image.[[Prototype]]`.
- **Property keys** follow ECMA-262 ToPropertyKey. A number, BigInt, boolean or null constant key names `String(value)`, so `0`, `"0"` and `0n` all name `Array.prototype.0`, and `-1` and `"-1"` both name `Array.prototype.-1`. A key expression that throws (`1n + 1`) folds to no value, and its write gives nothing (Principles 1 and 2). Numeric members use their canonical string (`1e21` names `1e+21`). A well-known symbol key read as `Symbol.<name>` through the free `Symbol` global names `<holder>.@@<name>`. `Symbol()` and `Symbol.for()` keys stay unknown. A well-known symbol is a constant value, however the real `Symbol` holder is reached (the free name, `window.Symbol`, `globalThis.Symbol`, another window's), and it flows like other constants. A string key never names an `@@` member, and no string key can spell another target's name: a key that starts with `@@`, contains `.`, `[`, `]`, `"`, `\` or a control character (Unicode `Cc`: U+0000–U+001F and U+007F–U+009F), or ends with `*` is written in JSON-quoted brackets (`X.prototype["@@toStringTag"]`, `Array["prototype.map"]`, `console["*"]`). Canonical numeric keys and catalog names keep the dot form.
- **Constants** are targets on both the interface object and the interface prototype object, as Web IDL defines them: `Node.ELEMENT_NODE` and `Node.prototype.ELEMENT_NODE`.
- **Per-instance members** (`[LegacyUnforgeable]` on an interface that isn't a realm's global) are not targets of their own. Only platform singletons have `instance` targets (§3).
- **Namespaced constructors** use their qualified path from the namespace. This covers `[LegacyNamespace]` interfaces and ECMA-402 constructors: `WebAssembly.Module.exports` (holder `constructor`), `WebAssembly.Memory.prototype.grow` (holder `prototype`), `Intl.DateTimeFormat.prototype.format`.
- **Intrinsics that no global property reaches** use their ECMA-262 or ECMA-402 `%name%`: `%TypedArray%.prototype.map`, `%ArrayIteratorPrototype%.next`, `%GeneratorPrototype%.next`, `%IntlSegmentsPrototype%.containing`. They are holders on the chains that reach them, so `Uint8Array.prototype.at = f` shadows `%TypedArray%.prototype.at`. `%AsyncFromSyncIteratorPrototype%` is not catalogued, because code can never reach it.
- **ECMAScript structural properties** are targets when ECMA-262 or ECMA-402 gives them their own clause: `X.prototype`, `X.prototype.constructor`, `@@toStringTag`, `Array.prototype.@@unscopables`. A function's `length` and `name` are not. The Web IDL equivalents are targets too, under the same rule (Sources).
- **Temporal** comes from a curated overlay of the whole Stage 4 API, including `Date.prototype.toTemporalInstant`.
- **Singletons** use their canonical path from the global, without the global prefix: `navigator.geolocation.getCurrentPosition`, `crypto.subtle.digest`. Alias groups map every access path (`window.history`, `self.history`, `document.location`) to the canonical one.
- **`HTMLDocument.prototype`** sits on `document`'s chain: `document` → `HTMLDocument.prototype` → `Document.prototype`. Its own members are `constructor` and `@@toStringTag` (Sources), so `delete Object.getPrototypeOf(document)[Symbol.toStringTag]` and `Object.getPrototypeOf(document).constructor = X` give findings on them. A write through `Object.getPrototypeOf(document)` is named on it: `.x = y` is an `add` of `HTMLDocument.prototype.x`, and `.createElement = w` is `HTMLDocument.prototype.createElement`, shadowing `Document.prototype.createElement`. `setPrototypeOf` on it gives `HTMLDocument.prototype.[[Prototype]]`. `document.createElement = w` is unchanged.
- **WindowProperties** (the window's named properties object) sits on the global's chain: `Window.prototype` → `WindowProperties` → `EventTarget.prototype`. It has no own members. Writes onto it of a name visible on its chain are named `WindowProperties.<member>`, with holder `prototype`, in the window realm only. Other names give nothing (§3). Worker globals have none.
- **A holder chosen at runtime** (`hasOwnProperty.call(history, m) ? history : History.prototype`, or a prototype walk to the first owner) gives one target. The holder is decided against the unmutated catalog, and the trace records that the catalog chose it. The catalog decides an own-property test and a prototype step by every ECMA-262 route with the same meaning: `hasOwnProperty` by any route or `Object.hasOwn`, and `Object.getPrototypeOf`, `Reflect.getPrototypeOf` or a `__proto__` read that reaches `Object.prototype.__proto__`'s getter. So zone.js's walk `for(;o&&!Object.hasOwn(o,t);)o=f(o)`, with `f` an alias of `Object.getPrototypeOf`, gives `XMLHttpRequest.prototype.open` from `XMLHttpRequest.prototype` and `Window.fetch` from `window`, and `window.__proto__.__proto__.addEventListener = w` gives `WindowProperties.addEventListener`. When the member doesn't fold, the catalog narrows the holders first: a holder can be a first owner only if it owns at least one catalog member other than the structural `constructor`, `@@toStringTag` and `prototype`. So `(hasOwnProperty.call(history, cfg.name) ? history : History.prototype)[cfg.name] = wrap(…)`, after a read of the same key, gives `History.prototype.*` alone, and a walk from `window` for `cfg.name` leaves `Window`, `EventTarget.prototype` and `Object.prototype` (`Window.prototype` owns only structural members, and WindowProperties none). No wildcard lands on the global object (§5), so after a read of the same key it gives two wildcard findings, `EventTarget.prototype.*` and `Object.prototype.*`, each `medium` with `holder-alternatives`. When the catalog can't settle the choice, the candidate-set rule in §5 applies, and then its wildcard rule for a member that doesn't fold.
- **Other windows** (`frames[i]`, `window[i]`, `contentWindow`, `parent`, `top`, `opener`, `defaultView`) keep realm `window`. Each occurrence records its realm instance, `current | other | unknown`, as evidence rather than identity.

### Member data

Every member carries:

- its descriptor: data or accessor, `writable`, `enumerable`, `configurable`
- for attributes, an **`assign` kind** generated from IDL: `setter`, `put-forwards`, `event-handler`, `replaceable`, `lenient-setter` or `readonly`. A runtime descriptor can't tell these apart, so the kind must come from IDL. `Window.opener` keeps its IDL kind `setter`, and the analyzer special-cases its non-null assign as §3 says.
- its surface

Each holder carries an **`immutablePrototype`** flag, set per realm on:

- the interface prototype objects of a `[Global]` interface and its ancestors
- WindowProperties
- the global object
- `Location` instances
- `Object.prototype`

The serialized catalog must keep a member named `__proto__`.

### Catalog versions

All curated data ships in the monkeypatchlist npm package under one **catalog version**, separate from `monkeypatchlistVersion`. That covers the catalog, its overlays, the framework path rules and escape-only shapes (§10) and the URL normalization rules (§11). The catalog diff lists escape-only shapes too. The catalog metadata records every upstream pin. R1 has no catalog override.

- **The catalog is monotonic.** When upstream removes a target, the target becomes **retained**: an overlay entry recording the last webref version that had it and why it left. A retained target resolves like any other. Its findings carry `catalogStatus: retained`, which is information only. It is dropped only by a deliberate overlay edit, backed by BCD evidence that no current engine ships it. `catalog:check` fails on a drop whose BCD feature shows Chrome, Firefox, Safari, Chrome Android, Safari iOS or Firefox Android shipping it (unprefixed, unflagged, not removed). A partial implementation counts as shipping. A preview release or an alternative name does not. Only released versions count (Principle 4): a version whose `bcd.browsers[engine].releases` status is `current`, `esr` or `retired`, or a `version_added` of `true`. Support added in a beta, nightly or planned version doesn't ship, and a removal in one, or a `version_removed` of `"preview"`, doesn't stop the feature shipping. A path BCD doesn't have is accepted. Holders are monotonic too: a lost holder must be retained or dropped the same way, and the target diff lists holder removals. An exclusion that removes a target the previous catalog had needs no BCD evidence, but its Removed line is marked `[sign-off: excluded]`, and CI fails until a person signs off.
- **Upgrades use the ordinary baseline states** ([ADR 0008](adr/0008-tool-upgrades-use-ordinary-baseline-states.md)). A delta caused by a catalog or analyzer upgrade is `added`, `removed` or `changed`, and trips the gate like any other. There is no "newly recognized" state. The documented path is to upgrade monkeypatchlist in its own PR and run `baseline update` there.
- **`explainedBy[]`.** A delta whose target, the target it shadows on the current or the baseline side, or a wildcard's holder appears in the catalog diff between the baseline's `catalogVersion` and the current one carries the change records that could explain it. These come from a **catalog changelog** shipped in the package:

  | Catalog change | Explains |
  |---|---|
  | target added / deliberately dropped | `added` / `removed` |
  | target added / deliberately dropped, where the finding was or becomes an `add` | `changed` (`effect`) |
  | protected entry gained / lost | `added` / `removed` under `--surface protected` |
  | descriptor or `assign` kind | `added` (was ineffective) / `removed` (became ineffective) / `changed` (`locks`, `effect`) |
  | holder added, removed or re-chained | `added` / `removed` of targets named on it or shadowing through it |
  | a holder's `immutablePrototype` | `added` / `removed` of its `prototype-change`, as the descriptor row does |
  | member enters or leaves a holder's enumeration | `added` / `removed` of wildcard-expanded targets |
  | framework path rule | `changed` (`attribution`); the rule id on `existing` + `rekeyed` |
  | URL normalization rule | `changed` (`attribution`), or an `added`/`removed` pair |
  | surface reassignment | nothing (surface is context only) |

  A `removed` entry has no stored `shadows`, so its shadowed target is worked out from the current catalog. So `HTMLDivElement.prototype.setHTMLUnsafe` `changed` (`effect`) carries the record for an added `Element.prototype.setHTMLUnsafe`. The changelog records holders and their chains, and an exclusion counts as a deliberate drop.

  `explainedBy` is never baselined, and never set on `unconfirmed`, or on `existing` except for `rekeyed`.
- **Version skew:**
  - A baseline from an older version scans normally, with a note naming both versions.
  - A baseline from a newer version scans with a warning and no `explainedBy`.
  - `baseline init` and `baseline update` refuse a downgrade unless `--allow-downgrade` is given.
  - A fingerprint scheme bump ships an in-memory migration. A scheme change that can't be migrated needs a major release, and it is a hard error under `--fail-on`. Without `--fail-on`, such a baseline is treated as no baseline, with a warning. `baseline update` refuses it (exit 2) even with `--allow-downgrade`, and only `baseline init` replaces it.
- **Release promise.** A release that can change findings on unchanged code is a minor release. A patch release reproduces byte-identical output on the whole validation corpus, and CI enforces this.
- **Bump review.** The generator emits a committed, readable target diff. CI fails if the generated catalog differs from the committed one. Changes to protected targets and new retained targets need explicit sign-off. There is one bump per monkeypatchlist minor release.

## 5. Analysis: parsing, scope and resolver capabilities

### Parsing and scope

- **Parser.** `oxc-parser`, configured with:
  - `sourceType` always explicit, taken from the artifact graph
  - `range: true`
  - `preserveParens: false`
  - raw transfer where it is supported

  The parse also yields imports, exports and dynamic imports, so no separate module lexer is used.
- **Scope analysis.** `eslint-scope` (`optimistic: true`, `ecmaVersion` ≥ 2015), behind a monkeypatchlist **binding-resolution seam**. `@typescript-eslint/scope-manager` is a verified drop-in.
- **Post-passes that monkeypatchlist owns:**
  1. In a classic script, global-scope `var`/`function` bind properties of the global object, and `let`/`const`/`class` do not.
  2. Annex B block-function hoisting.
  3. `with` and direct-`eval` taint lower target confidence (§9).
  4. An unqualified `delete x` is a global delete.
- **Positions.** Offsets are UTF-16. A per-artifact line-start table converts them to a 1-based line and a 0-based column for source-map lookups. Raw U+2028/U+2029 is an attribution-confidence caveat.
- **Cost.** Parsing plus scope analysis is about 0.4 s for 9 MB.

### Global resolution

Only bindings that resolve to no declaration, and that correspond to catalog globals, can produce findings as bare names. `fetch = w` at top level may mutate the platform. `function f(fetch){ fetch = w }` does not. A global expando is another matter: within a link group, free names, a classic script's top-level `var`/`function`, and the member forms on the global object (`window.`, `self.`, `globalThis.`, top-level `this.`) share one heap cell for it (capability 5). So `window.__cfg = { h: history }; __cfg.h.pushState = w` gives `history.pushState`, and the loader shape `window.SDK || (SDK = {}); SDK.o = { XHR: window.XMLHttpRequest }; SDK.o.XHR.prototype.open = w` gives `XMLHttpRequest.prototype.open`. Module-scope declarations never touch the cell.

**The global object** is recognized through:

- free `window`, `self` and `globalThis`, and a `typeof`-guarded `global`: under an enclosing `if`, `?:` or `&&`/`||` test, or after an earlier `return` or `throw` under the opposite test that dominates the read. Such a return or throw guards every later read in the rest of its statement list, nested blocks and functions created there included, and a script's or module's top-level body counts like a function body. So `(function(){ if (typeof global === "undefined") return; function patch(){ global.fetch = wrap(global.fetch) } patch() })()` and a module's top-level `if (typeof global === "undefined") throw new Error("needs global"); global.fetch = w` both write `Window.fetch`, while `function f(a){ if (a) { if (typeof global === "undefined") return } global.fetch = w }` doesn't
- bare singletons and constructors
- `||` and `?:` `typeof` chains, in every minified spelling
- IIFEs that return the global, `Function('return this')()` and sloppy `(function(){ return this })()`
- top-level and UMD `this`
- bundler global helpers (`__webpack_require__.g`) and callback-supplied globals

Native holders are reached only from the global object, never through a user object's prototype chain.

**Reassigned globals.** A bare `self`, `frames` or `globalThis` that the script assigns (`var frames = []`, `var self = {}`, `globalThis = x`) follows its value. A read the walk orders after the assignment has the assigned value. A read it can't order sees only the values the artifact assigns, as if the script's assignments have run. The global object counts only where the walk shows no assignment has run yet, so `var self = self || this` keeps the window. `window` and `top` stay the window, and worker realms follow the same rule. Every other catalog name whose assignment takes effect follows its value the same way: writable data properties (`XMLHttpRequest`, `Promise`, `console`), `[Replaceable]` names (`performance`, `parent`) and `opener`. Names that can't be reassigned (`document`, `location`, `history`) stay native. `var Promise = window.Promise || Shim; Promise.prototype.finally = f` still patches the native where `Promise` is the native.

**Other windows.** `.defaultView` and `.contentWindow` on any object in the window realm resolve to a Window, with realm instance `unknown`. `parent`, `top`, `opener` and `frames` need a resolved window base. `frames` is that same window. A constant array index read on a resolved window (`window[0]`, `parent["1"]`) is a child window. An unresolved key is a child window only when the window is spelled as the frames collection (`frames[i]`, `window.frames[i]`, `parent.frames[i]`). That spelling is a mark on the value: a window read as `frames` (bare, `.frames`, or a constant `["frames"]`) keeps it through aliases, destructuring and parameters, and reading any other member drops it.

### Resolver capabilities

The resolver is an abstract interpreter over each link group (§6). It needs every capability below. The prototype showed each layer from summaries to catalog enumeration is essential to the recall bars and the headline set.

1. **Lexical binding, constant propagation, string folding and computed-property resolution.** `proto[method] = w` with `const method = "add" + "EventListener"` resolves to `EventTarget.prototype.addEventListener`. Practical destructuring is included. A free `undefined`, `NaN` or `Infinity` that resolves to no declaration folds to its ECMA-262 value, and a `with` block or sloppy direct eval on the path keeps its taint. `const` chains are evaluated without a depth limit. A BigInt that an operator produces, as a result or an intermediate, whose decimal string would pass the `fold-length` cap is unknown and counts as a `fold-length` hit (§13). Its size is judged from bit lengths before it is computed, so `Array.prototype[10n ** 2000000n] = f` and `Array.prototype[(1n << 900000000n) % 7n] = f` raise `analysis-budget` (Principle 5), while `o[10n ** 2000000n] = 1` is only counted. A BigInt literal is bounded by its source and isn't capped. A result over V8's own limit (2^30 bits, `1n << 2000000000n`) makes Chromium throw, so it folds to no value (Principle 1).
2. **Scope-wide aliasing**, plus **reaching definitions** within a function that follow `if` arms and comma sequences. Flow-insensitive aliasing alone gives both false positives and false negatives. Details:
   - The `undefined` an uninitialized `var` or `let` starts with counts only where the walk shows it reaches the read. A read the walk can't order sees only assigned values, so New Relic's hoisted `rc` is `"addEventListener"`.
   - An assignment in a nested function joins a read only where a call, `new`, `await` or `yield` lies between the reaching definition and the read. A loop, `try` or `switch` the walk doesn't follow falls back to the union.
   - Aliases of native functions are followed. An aliased writer (`Ae = Object.defineProperty; Ae(h, k, d)`, `const { defineProperty } = Object`) gives its mechanism's findings. An aliased `eval` or string timer with literal code is analyzed as global nested code, like `(0, eval)(…)`, and a non-literal argument raises `dynamic-code`.
3. **Function summaries**, instantiated per call site with constant arguments. They compose through helper chains 2–4 deep, bind IIFE parameters, fold strings through parameters, follow `this` and class-field dispatch and callback invocation, and analyze escaping closures with the bindings of the call site that created them. A function with no resolved call still has a `this`. Class members run with `this` = every analyzed instance of the class or a subclass, or, when no `new` of it was analyzed, a generic instance built from its field initializers and its constructor run with unknown arguments. Static members run with the class, ES5 constructor-prototype methods with the instances of `new F`, and object-literal methods with the literal that holds them. More generally, a caller-less function's `this` is every object it is shown to be held on, plus the instances of `new F` when that object is `F.prototype`, however it got there: a literal, an expando, `Object.assign`, `defineProperty` or a replaced `F.prototype`. So `Instr.prototype = { constructor: Instr, enable: function(){ this.target.send = w } }; new Instr()` writes the instance's target at high target confidence. Any other caller-less function has an unknown `this`. In a plain function, `this` follows ECMA-262's this-binding only for calls the resolver evaluates: `(function(){ return this })()`, `f()`, `f.call(null)`, top-level `f.call(this)`, and a sloppy callback that a user function or an unrolled iteration native calls without a thisArg give the global object. A plain function with no resolved call, and a host callback such as a timer or a listener, keep `this` unknown, so `this.fetch = wrap(this.fetch)` there gives an `unresolved-holder` limitation and `this.fetch = w` gives nothing. Summaries are instantiated per function object: every analyzed receiver and every created closure is instantiated, whether or not a call on it resolves, and one that no resolved call reaches is judged from its creation site (§7), with its `this` or creation bindings in a `creation-site` step and no confidence reason. The ECMA-262 call natives are followed like `.call` and `.apply`: `Reflect.apply`, `Reflect.construct`, and `Function.prototype.bind` with its bound `this` and arguments, each with a `call` step. Host- and Promise-invoked callbacks (`setTimeout(install, 0, …)`, `.then(g => …)`) run caller-less, with unknown parameters. So an instrumentation class whose constructor stores `this.original = window.fetch` and whose `enable()` installs a `window.fetch` that calls `this.original` gives `Window.fetch` `wrap` whether or not a call to `enable()` resolves. Target confidence stays `high`: the assumed receiver shows only in the `creation-site` or `call` trace step.
4. **Constant loops.** The resolver iterates constant arrays, `split` lists and an object literal's own enumerable keys, and simulates counted loops whose counter is bumped in the body. Details: A later write makes a heap-carried literal non-constant only when it reaches the literal through a binding, a field path, a call argument or `Object.assign`; a write whose object is the literal only through a caller-less function's assumed `this` doesn't count, since at run time it writes an instance.
   - An object literal's own enumerable keys are iterated by `for…in`, `Object.keys`, `Object.values` and `Object.entries`, in ECMA-262 order: `var impl = { open: o, send: s }; for (var k in impl) XMLHttpRequest.prototype[k] = impl[k]` gives `XMLHttpRequest.prototype.open` and `.send`. A literal the heap carries is iterated the same way (core-js's `for (key in source)` in its export helper).
   - Every native that ECMA-262 defines to visit a constant array's elements unrolls, in ECMA-262's order and with its early exits: `forEach`, `map`, `filter`, `some`, `every`, `find`, `findIndex`, `findLast`, `findLastIndex`, `flatMap`, `reduce`, `reduceRight`, `Array.from` with a map function, spread, and `entries`/`keys`/`values` iteration. A callback result that can't be decided keeps the iteration going, as an `if` arm does. So `["open", "send"].map(m => fill(XMLHttpRequest.prototype, m, w))` gives both targets.
   - A counted loop whose bound can't be decided is unrolled only when every path exits within the iteration cap. Otherwise its counter stays unknown, which is not a cap hit: `for (var i = 0; i < n; i++) XMLHttpRequest.prototype[names[i]] = w`, with `n` unknown, unrolls nothing and invents no `.undefined` target. An element read with the unknown index is unknown too, so it gives no `.open` or `.send` either: the write has a known holder and an unknown member, and with the key reused (`= wrap(XMLHttpRequest.prototype[names[i]])`) it gives the wildcard `XMLHttpRequest.prototype.*`. A loop with a decided bound unrolls every iteration that may run.
   - The collections this capability iterates are constants. The length and elements of an array or `split` list seen directly, and the keys an object literal's `for…in`, `Object.keys` and `Object.entries` produce, decide loop bounds, early exits and `if` tests: with `var names = ['open', 'send']`, `for (var i = 0; i < names.length; i++) XMLHttpRequest.prototype[names[i]] = w` gives `.open` and `.send`. An object literal's field values stay under capability 5's rule. An array literal reached through the alternatives of `?:`, `&&`, `||` or `??`, or through a resolved call's return (a method called through `this` included), is iterated too, each alternative as its own collection (Principle 3): `targets = c ? [EventTarget.prototype] : [Node.prototype, Window.prototype]; targets.forEach(t => wrap(t, 'addEventListener'))` gives `EventTarget.prototype.addEventListener` and the `Node.prototype` and `Window.prototype` alternatives. An array read from a heap field is still not iterated.
   - An array, like an object literal, is constant only when it is inline, or bound with no later writes. Any later write the analyzer sees makes it non-constant: an index or `length` write, or a mutating method (`push`, `pop`, `shift`, `unshift`, `splice`, `sort`, `reverse`, `fill`, `copyWithin`). A non-constant array isn't unrolled and gives no finding. Passing the array to a call the analyzer can't resolve doesn't make it non-constant.
   - When the iteration cap cuts a loop, the iterations done keep their findings, and a loop that writes or guards the global object, a native holder or a native member raises `analysis-budget` (Principle 5): `for (var i = 0; i < 1e6; i++) Array.prototype["x" + i] = f`. Any other cut is only counted.
5. **A flow-insensitive heap**, with allocation sites. It carries module links, class fields, expandos on native holders and global expandos (one cell per link group, above), and treats descriptors as heap objects. Details:
   - An allocation site is a syntactic site (a literal or `new`) per summary instantiation and per unrolled loop iteration, and a method is instantiated once per receiver object. So `function spec(h, m){ return { h, m } }` called as `install(spec(XMLHttpRequest.prototype, 'send')); install(spec(WebSocket.prototype, 'close'))` gives exactly those two targets, with no cross product, and so does one literal built in each iteration of an unrolled loop. When a context cap merges calls, their objects merge too (§18).
   - A property written after allocation may be absent. That touches presence only: a presence test of it (`'orig' in s`, `if (s.orig)`, `s.orig || p`) stays undecided, and a read of it returns only the values the code writes, with no `undefined` added. So `const m = {}; m.name = 'send'; XMLHttpRequest.prototype[m.name] = w` gives only `XMLHttpRequest.prototype.send`, and `const s = {}; s.orig = window.fetch; window.fetch = s.orig` is a write-back.
   - An object passed to a call the analyzer can't resolve keeps only the field writes the analyzer sees. The call is not assumed to write its fields.
   - Heap-read constants and presence never decide a test, in statement arms or in `?:`, `&&`, `||` and `??` selection: `const c = { on: true }; XMLHttpRequest.prototype[c.on ? 'open' : 'send'] = w` gives both candidates. This covers an object literal's field values (`c.on`, and core-js's `DOMIterables[NAME]`, whose test stays undecided, so both arms stay reachable) and anything the heap carries, but not capability 4's constant collections. One exception: when an object literal is passed directly as a call argument and nothing writes to it afterwards, a property read on it inside that call's summary instance (capability 3) decides tests, and a property the literal lacks reads `undefined`. So core-js's export helper, called as `$({ target: 'Array', proto: true }, { at })`, takes only its `proto` arm: `options.global` and `options.stat` read `undefined`, and its `GLOBAL` and `STATIC` arms are not reached. Module-level tables, such as core-js's `DOMIterables`, keep their undecided tests. Each write this rule drops, because an arm it rules out is the only way to reach it, leaves a counted, traced `prune`, as a catch-arm drop does (capability 9), so a dropped write is never silent. A native holder read from the heap is still that holder for §7's catalog checks.
6. **Once-flags are transparent**: lazy init (`x || (x = …)`) and memoized getters. Details:
   - A once-flag is recognized by use. A variable or parameter that doesn't read a catalog native is a flag when a function tests it (`if`, `?:`, `&&`, `||`, `!`, an early return) and then assigns it on the path that test lets through, directly or in a call on that path, whatever value it assigns. A flag's tests are never decided as constants. So Rollup's `if(Ki)return Xi;Ki=1` and `ge||(ge=1,…)`, esbuild's runtime `t&&(e=t(t=0))`, and `var st; function start(){ if (st) return; st = "on"; window.fetch = w }` are flags, and `Window.fetch` is kept. esbuild's init-thunk constants (`rc="addEventListener"`, `Nl=4`), never tested where they are set, stay constants. A native test such as `Promise || (Promise = Shim)` stays a §7 absence guard.
   - Lazy init narrows. After a lazy-init statement, the variable holds what the lazy init assigned plus only the entry values that fail its test: the truthy ones for `if (!k)`, the non-nullish ones for `if (k == null)`. So `var k = null; function key(){ if (!k) k = "add" + "EventListener"; return k } EventTarget.prototype[key()] = w` gives only `EventTarget.prototype.addEventListener`.
7. **Catalog guards** (§7). `hasOwnProperty` (by any route, or `Object.hasOwn`), `in` and `typeof` guards on constant names are decided against the catalog, whether the holder is read directly or from the heap, and **absence tags travel on values**, so a holder chosen on a native-absent branch keeps `guarded-native-absence`.
8. **Holders chosen at runtime.** Prototype walks are simulated per start value against the unmutated catalog, through every own-property test and prototype step §4 names. A member that doesn't fold narrows the holders by the catalog first (§4).
9. **Catalog enumeration.** A member sweep over a native holder's keys expands against the catalog, including enumerability, with constant-prefix, length and exclusion-list filters. Details: A `typeof` of a catalog member read off a native holder is decided from its catalog kind (an operation is `'function'`, a constant `'number'`, an attribute by its type where the catalog fixes it), so `typeof proto[k] === 'function'` keeps only operations. A write in a `catch` arm counts only when its `try` block may throw, judged against the unmutated catalog: a `try` whose statements are reads and calls the catalog shows can't throw for the members swept (a function member's descriptor read, a define of a configurable member) never reaches its `catch`. The rule covers every `catch` arm in analyzed code, not only `try` blocks over swept members. Besides catalog facts, a `try` is judged unable to throw from ECMA-262 operators and literals (`typeof`), `push` on an array the code made, an assignment to a declared non-`const` name, and a call to a code function whose body can't throw, followed up to the `throwDepth` cap. Each write the rule drops leaves a counted, traced `prune`, so a dropped write is never silent.
   - It covers every ECMA-262 key enumeration: `for…in`, `Object.keys`, `Object.getOwnPropertyNames`, `Object.entries`, the keys of `Object.getOwnPropertyDescriptors`, `Reflect.ownKeys` and `Object.getOwnPropertySymbols`. Symbol keys name `@@` members (`console.@@toStringTag`).
   - `for…in` follows ECMA-262: the holder's own enumerable keys plus the enumerable keys of its catalog chain, with shadowed names removed. The others are own-key enumerations. Each inherited key is a shadowing write named by ADR 0002: `for (k in history) history[k] = wrap(history[k])` gives `history.pushState` and the other `History.prototype` members, and a sweep of `XMLHttpRequest.prototype` also gives `XMLHttpRequest.prototype.addEventListener`.
   - The key list isn't capped, and only the link group's step budget bounds it (Principle 5): zone.js's `Object.getOwnPropertyNames(window).filter(n => n.startsWith('on') && n.length > 2)` runs its filter once per own name of `Window`.
   - The analyzer evaluates each filter on each swept key: every ECMA-262 string native applied to a constant key (`startsWith`, `endsWith`, `indexOf`/`lastIndexOf`, `includes`, `slice`/`substring`/`substr`, `charAt`/`at`/indexing, `length`, comparisons), array `includes`/`indexOf` against constant lists, and regular-expression literals with constant source and flags, run with the host's ECMA-262 `RegExp`. So `/^on/.test(k)` over `window` decides. A pattern that doesn't compile stays undecided.
   - A filter that can't be decided (a page-set ignore list, `cfg.shouldPatch(k)`, `new RegExp(userInput)`, a pattern that doesn't compile) expands every member it might keep, each its own finding at high target confidence, and each such member stays a constant through later loops. The undecided filter makes reachability `conditional`.
   - A list whose elements all come from catalog enumerations, through `filter`, `map`, `slice`, `concat` or the maybe-kept output of an undecided filter, is catalog-bounded. Loops over it are uncapped and unroll every element that may be present, even when its length is undecided, and only the step budget bounds them: zone.js's `for (let i = 0; i < properties.length; i++)` over its filtered sweep gives all 132 `Window.on*` findings with no `analysis-budget`. A list that mixes in code-built elements falls back under the iteration cap.
10. **Wrap evidence.** A factory that receives the original, a `Proxy` over it, or a captured original that the new value calls makes the effect `wrap`. Details:
   - Every ECMA-262 route that invokes the original counts: a direct call, `.call`, `.apply`, `Reflect.apply`, `new`, `Reflect.construct`, `super()` in a class whose heritage is the original, and a call through a bound copy. The call can sit in the new value's body, in closures it creates, or in a helper the summaries resolve. So constructor and `class extends` instrumentation is a `wrap`.
   - A factory that receives the original is a call whose callee is unresolved or a user function, with the original among its arguments at any depth: `pick(window.fetch, poly)` and `instrument({ orig: window.fetch })` are `wrap`, whatever a resolved summary does with them. A catalog native counts only where ECMA-262 makes its result call the argument (`Function.prototype.bind`), so `Object.freeze(window.Promise)` is a `replace`.
   - A rebind of the original with `.bind` (`window.fetch = window.fetch.bind(window)`) is a `wrap`, because a bound function calls its target.
   - The original is any read that reaches the native function the target held before the write, judged against the unmutated catalog. That includes the inherited member a shadowing write shadows (`navigator.sendBeacon = function(){ return Navigator.prototype.sendBeacon.apply(navigator, arguments) }`) and a read made at call time through a path the write doesn't change. Another window's copy doesn't count, so a clean iframe's `fetch` gives `replace`.
   - A written value whose alternatives differ in wrap evidence gives one finding per effect: `window.fetch = supported ? wrap(window.fetch) : polyfillFetch` gives `Window.fetch` `wrap` and `Window.fetch` `replace`, each at normal mutation confidence.
11. **Restore proofs** (§3).
12. **Deterministic budgets** (§18).

Whole-program symbolic execution beyond this is out of scope.

### Candidate sets

Sometimes a write's holder or member comes from a branch that neither constant folding nor the catalog can settle: `(cond ? window : history).pushState = w`, or `proto[flag ? "open" : "send"] = w`. Then the site has a **candidate set** of resolved holders or members ([ADR 0019](adr/0019-undecided-candidates-give-one-finding-each.md)).

A key whose alternatives mix constants and unknown values (`XMLHttpRequest.prototype[k || 'send'] = w`) gives each constant alternative as a candidate under the 4-candidate rule, each with `member-alternatives` even when only one is left; the unknown part gives nothing and no `<holder>.*`, as for a configurable prefix. A boolean, `null` or `undefined` taken from a heap-read or once-flag test operand (neither decides a test) (`c.on && 'open'`, `c.on || 'send'`, `c.off || 'send'`, `c.none ?? 'send'` with a heap-read `c`) is never a candidate key, whichever operator gives it, so these give `XMLHttpRequest.prototype.open` or `.send` alone, with `member-alternatives` because the key had other values, and never `.true`, `.false` or `.null`.

- **Up to 4 candidates.** Each candidate is its own finding, with its own fingerprint, and its occurrence carries the target-confidence reason `holder-alternatives` or `member-alternatives` (§9). The trace records the branch and the other candidates.
- **More than 4 candidates.** The site is treated as partially resolved (below). A holder set becomes an `unresolved-holder` limitation listing the candidates. A member set on a known holder follows the wildcard rule, and gives nothing if the key isn't reused. When the member doesn't fold either, as after a first-owner walk that the catalog narrows to more than 4 holders, the site gives an `unresolved-holder` limitation only when the key is reused (patch-shaped), and its `detail` lists the narrowed `<holder>.*` wildcard names rather than member targets. It is never a finding, and it follows `--surface`. A constant member on a site that isn't patch-shaped still gives nothing.
- **Holder and member both undecided.** The candidate set is the cross product, capped on distinct targets. Up to 4 targets gives one finding per target, carrying `holder-alternatives` and `member-alternatives` where both apply. Above 4, the site is partially resolved: a wildcard per holder when the holder set has at most 4 members and the key is reused, otherwise nothing.
- A candidate the write-outcome table (§3) makes ineffective is an ineffective write, as for any single target.

### Partially resolved writes

These rules cover a write site (assign, define, delete or set-prototype) where **exactly one** of holder or member resolves. A site where neither resolves produces nothing. A set-prototype site, a `__proto__` assign included, has no member, so an unknown holder there gives nothing: prototype changes on unknown objects give no record, and Babel's `_inherits` and `_setPrototypeOf` helpers stay silent (§21).

- **Unknown holder, known member.** This is an `unresolved-holder` coverage limitation, never a finding. It is raised only when both hold:
  - the member is a constant naming a member of some target in the realm's catalog, and §3's outcome table could make the write a mutation of that target: not API use, not a constant member, not a define that changes nothing
  - the site is patch-shaped: it keeps the original of the same (holder, member). An assign keeps it when the original it reads is called, `.call`/`.apply`/`.bind`-ed, passed to a call other than a catalog native, stored, or kept when present (`o.m = o.m || p`, `if (!o.m) o.m = p`). A define counts when it defines `get`/`set`, or follows such a read or a `getOwnPropertyDescriptor` of the same slot. A delete counts only after the original was captured. The same (holder, member) means the same root variable, parameter or `this`, through the same constant property chain after aliases, in the same function, with no redefinition of the root in between.

  Its `detail` lists the candidate targets that pass the first test. It covers accessor helpers, heap-stored API objects, prototype walks from an unresolved object, and aliases carried between classic scripts. These follow the same patch-shape rule: `var g = window` in one script and `g.fetch = w` in another give nothing, and `g.fetch = wrap(g.fetch)` gives `unresolved-holder`. `--surface` filters these records (§12).

  When the holder has several possible values and only some are unknown, `unresolved-holder` is raised only when no alternative gives a finding or an ineffective write, and at least one is unknown. So `var o = window.NREUM || {}; o.fetch = wrap(o.fetch)` raises it, while `function p(o){ o.fetch = wrap(o.fetch) } p(window); p(api)` gives only the `Window.fetch` finding. A site gives findings or a record, never both.
- **Known holder, unknown member.** This is a **wildcard target** ([ADR 0004](adr/0004-wildcard-targets-are-findings.md)) when the same unresolved key is reused: read from the same holder before the write, or its descriptor fetched from the same holder. A read inside a summarized callee whose parameter is bound to the same key binding counts (`const o = getOrig(console, k); console[k] = wrap(o)` gives `console.*` `wrap`), while separate loops over one unknown list don't share a key. That rule keeps JSONP `window[cb] = fn` and chunk globals silent. No `<holder>.*` lands on the global object (`Window`, the worker global scopes): jQuery's JSONP, `w[l] = w[l] || []` and chunk globals give nothing, and so does a real unknown-key wrap of a global function. Singleton, prototype, constructor and namespace holders keep their wildcards.
  - **Name:** `<holder>.*`, e.g. `console.*`, `EventTarget.prototype.*`.
  - **Effect**, from the value written, as for a named member ([ADR 0011](adr/0011-effect-follows-the-value-not-the-attributes.md)):
    - wrap evidence: `wrap`
    - a value that equals the read when present (`o[k] || p`, `if (!o[k]) o[k] = p`): `add`, on prototype, constructor and namespace holders only. On global and instance holders such a site gives no finding or record
    - any other value: `replace`
    - a define that gives `get` or `set`, or no `value`: `descriptor-change`
    - a delete: `delete`

    So `console[k] = console[k] || noop` is `console.*` `add`, and a define of `{ ...d, value: function(){ return d.value.apply(this, arguments) } }` after `d = Object.getOwnPropertyDescriptor(P, k)` is `P.*` `wrap`.
  - **Pattern wildcards.** A key that folds to a constant prefix no catalog member of the holder or its catalog prototype chain starts with is a non-native `add`. So `Node.prototype["add" + k] = f` is not one, because `EventTarget.prototype.addEventListener` is on the chain, and it falls to the reuse rule above. It gives `<holder>.<prefix>*` (e.g. `EventTarget.prototype.__zone_symbol__*`), on prototype, constructor and namespace holders only. A prefix holding a character §4 writes in brackets is JSON-quoted in brackets, with the star outside: `Object.prototype["__core.hidden."]*`. A configurable prefix is any selection (`||`, `??`, `?:`, a parameter or destructuring default) whose alternatives are string literals plus unresolved values. Each literal alternative, including one the link group writes (`window.__Zone_symbol_prefix = '__ng_'`), gives its own pattern wildcard under the candidate-set rule, with `member-alternatives`. The unresolved alternatives are dropped, an `enumeration` step records that the prefix is configurable and names its default, and no `<holder>.*` comes from the configurable part.
  - **As findings.** Wildcards are fingerprinted and baselined like any finding, with no subsumption: `console.*` and `console.log` coexist. They don't lower target confidence. Their write outcome is evaluated over every matching member (§3).

## 6. Module links and link groups

**Module links.** A **module link** connects a use of a bundled module's export to the module that defines it. It can be inside one artifact, or between artifacts that the artifact graph of one scan connects: local-build, inline, `data:` and fetched remote artifacts of that realm:

- static and dynamic imports
- chunk-loader URLs
- chunk-registry pushes

Links are recovered from structure, never from knowing which bundler produced the code ([ADR 0003](adr/0003-module-links-from-structural-idioms.md)). No bundler name or version is detected or reported.

**Module-linking idioms.** R1 promises to link these six idioms:

1. **Memoized getter**: Rollup commonjs `requireX`.
2. **Lazy module thunk**: a thunk that calls a factory with a fresh `{exports}` and returns `.exports`, as in esbuild `__commonJS` and Rolldown `__commonJSMin`. esbuild's `__esm` is the variant that only runs init.
3. **Factory table + require**: an object or array literal of factories keyed by constant id, read by a require function (webpack 5 object tables, webpack 4-style arrays).
4. **Getter export definer**: `n.d(e, {x: () => l})`, its array form, and esbuild `__export`.
5. **Interop wrappers**: `__toESM`, `n.n`, `.cw` and `getDefaultExportFromCjs`, with `.default` mapping.
6. **Chunk loader**: a function that maps constant chunk ids to URLs through a table or constant concatenation, and whose chunks push into a global array read by a factory table. A loader that loads its chunks with `import()`, whose chunks export their module table (webpack's ESM chunk format), is a chunk loader too. Its folded URLs are `chunk` references with `sourceType` `module`, fetched in `resolve` mode and linked into the loader's group as `deferred`, and a local build of this form gets §2's local-chunk exemption.

The list is a **conformance statement**. An implementation may get these links from general call and heap semantics rather than pattern code, as the prototype did. Conformance is tested against webpack 5, esbuild, Rollup 4, Vite (Rolldown), the webpack 4-style array form and the vendor CDN bundles in the validation corpus. Other bundlers work to the extent that they emit these shapes.

**Link groups** ([ADR 0010](adr/0010-module-links-cross-the-chunks-of-one-build.md)). A **link group** is an entry artifact plus every artifact reachable from it through module links. It is analysed as one program, with one heap and one realm.

- A chunk that belongs to several groups is analysed in each. Findings merge by fingerprint, and the occurrences name the chunk's artifact.
- Code reached only through a dynamic load has install context `deferred`, even when the load is triggered at top level. Its reachability follows the guards on the load call.
- Per-artifact export summaries, composed at link time, are the fallback if the cost target (§18) rules out whole-group analysis.
- A remote module that an import links is analyzed only inside its importer's group, `deferred` when it is dynamically imported, and never standalone. Offline, the skipped import is a broken link (Degradation).

**Globals are not links.** Global variables shared between classic scripts don't join a link group. The declaration rules and the scan-wide lexical-name check in §3 cover them. A chunk registry is a global array, but it counts as a module link through the chunk-loader idiom. A chunk joins a group through the registry only when the group's loader reads the same constant registry name and its id table (`n.u`'s constant keys, which fold even when `n.p` doesn't) maps an id the chunk pushes. It then takes that group's realm and install context `deferred`. The URL is checked only when it folds. A stale copy pushing the same id also joins, as an alternative (Principle 3). A chunk is missing when no build-directory artifact pushes that id, and a chunk no group maps stays a standalone sweep. A chunk URL a loader folds to a local file the build directory doesn't contain is a missing chunk too, never `unreadable`: it raises `unlinked-module-call` when a global, holder or target flows into the call, and is otherwise only counted, so a constant and an `auto` public path give the same result. A recognized chunk registry is a known non-native array, so overriding its `push` (`r.push = e.bind(null, r.push.bind(r))`) gives nothing.

**Scripts of one page are not linked in R1.** Global links between scripts of one entry document are deferred to Release 3 ([ADR 0015](adr/0015-global-links-are-deferred-to-r3.md)). Chunk-registry links are module links, not global links: HTML-referenced classic scripts linked through a registry (a `runtime.js`, `polyfills.js` and `main.js` from Angular, CRA or Next) form one link group, whose entry is the first script in URL order that links the others, and a linked HTML-referenced script is never analyzed on its own (§19). The effects:

- **What still works.** An SDK that a loader snippet starts is still found:
  - an injected constant-`src` script is a reference (§2)
  - its install code, with no resolved caller, is judged from its creation sites (§7)
  - the snippet is an ordinary install entry for its own writes
- **What is lost.** The snippet's config never decides the SDK's guards. An SDK whose writes only resolve through the snippet's call is missed, as Application Insights' CDN build is. Both are named in §21.

**Degradation.**

- An unrecognized module runtime looks like ordinary code, so it degrades silently. That is a named limitation.
- A broken recognized link can take several forms: a non-constant id, an id missing from every group member, a missing chunk, or a remote chunk or import skipped offline. It raises `unlinked-module-call` only when a global, holder or target flows into the unlinked call. Any other break is only counted.

**Reporting.**

- Each artifact carries `moduleLinking: { idioms, modules, unlinked, linkGroups }`.
- The resolution trace shows each link hop, e.g. "via module 9616 export `V`".
- Module and chunk ids are build-local, so they never enter a fingerprint or the baseline.

## 7. Reachability and install context

**Reachability** says whether a platform mutation happens, judged by the guards between its install entry and the write. It is reported on every occurrence and finding. It is not identity, and in R1 it does not make a finding `changed` (§11, [ADR 0014](adr/0014-reachability-and-install-context-do-not-feed-changed-in-r1.md)).

### Values

| Value | Meaning |
|---|---|
| `unconditional` | no guard that matters |
| `guarded-native-absence` | runs only when some native, not necessarily the target, is missing |
| `conditional` | a recognized guard that can't be decided statically |
| `unknown` | control flow the analyzer couldn't model |

**`guarded-native-absence`** covers `if (!x)`, `typeof x === 'undefined'` and `!== 'function'`, `!('x' in o)`, `x = x || p`, `x || (x = p)`, `??=`, `||=`, ternaries, early returns with the opposite test, and the minified forms of all of these. The tested native may differ from the written one: whatwg-fetch's one `!g.fetch` guards four targets. The evidence records which native was tested.

A native holder read as a property of the global object (`window.X`, `self.X`, `globalThis.X`) may be absent, so a `?:`, `&&`, `||` or `??` that tests one takes both arms, and the arm where it is missing is `guarded-native-absence`: with `targets = window.EventTarget ? [EventTarget.prototype] : [Node.prototype, Window.prototype]`, the `Node.prototype` and `Window.prototype` writes are `guarded-native-absence`. The global object itself, bare global names (reading a missing one throws) and prototypes are always present.

**`conditional`** covers:

- guards that decide a native is *broken* rather than missing: core-js `FORCED`, brand checks such as `[object Promise]`, and `isNativeFunction`. These can replace a native that exists, so they are never `guarded-native-absence`.
- config and option flags
- presence tests on a different target
- any other recognized guard that can't be evaluated statically, whose `guard` step has class `undecided` (§14)

**`unknown`** covers a path through an unresolved call, `eval`/`with` taint, and a guard expression the analyzer doesn't recognize.

**Transparent guards** leave a mutation `unconditional`:

- checks that the written target already exists (`if (!WINDOW.XMLHttpRequest) return`, `typeof original !== 'function'`)
- once-flags
- `try/catch` around the write
- writability checks (`isReadOnly`, `isPropertyWritable`)

**Combining guards.**

- **Along one path** (AND): `guarded-native-absence` > `unknown` > `conditional` > `unconditional`. So `config.polyfill && !window.fetch` is `guarded-native-absence`.
- **Across alternatives or paths** (OR): take the most-reaching, `unconditional` > `conditional` > `unknown` > `guarded-native-absence`. So `!window.fetch || force` is `conditional`.
- **A finding** reports the most-reaching value over its occurrences.

**Checking guards against the catalog.** A `hasOwnProperty` (by any route, or `Object.hasOwn`), `in` or `typeof` guard whose object resolves to a native holder and whose name is a constant is decided against the catalog. That includes names unrolled from constant arrays, and a native holder read from the heap (§5): `const t = { h: history }; if (Object.prototype.hasOwnProperty.call(t.h, 'pushState')) t.h.pushState = w` is pruned like the direct form.

- **Statically false**: a catalog name tested where no catalog version places it: no catalog version has the member directly on that holder (`in` also follows the modelled prototype chain), as for `hasOwn(history, 'pushState')` or `'document' in self` in a worker. A name the catalog has on no holder in any realm (an expando, or a vendor-prefixed or engine-only name such as `webkitRequestAnimationFrame`) is never statically false: it classifies as `conditional`, and both arms are analyzed. A function's own `length` and `name` are always present, as ECMA-262 gives every function both: the presence arm is transparent and the absence arm is pruned, so `if (typeof Promise.name === 'string') Promise.prototype.finally = f` keeps its finding. Only a name the catalog places on no holder in any realm (an engine-only name, such as IE's `window.attachEvent`) is never statically false: it classifies as `conditional`, and both arms are analyzed. A name the catalog places on another realm's holder stays statically false, so `'document' in self` in a worker still prunes. So does a name the catalog places on another holder in the same realm: the catalog has `ClipboardEvent.prototype.clipboardData`, so `'clipboardData' in window` is statically false and prunes. Only finding occurrences are pruned, and the prune is counted and traced. Limitation records, blind-spot counters, wildcard findings and discovered references in the pruned branch stay, so a dead branch can still make a scan `complete-with-limitations` or `incomplete`. A bare-name `typeof` test on a name no catalog version has on the realm's global (`global`, `process`, `module`, `exports`, or `window` in a worker) is never statically false, because page code can define such globals. It classifies as `conditional`.
- **Statically true**: the guard is transparent.
- **Depends on the browser, or unresolved**: `conditional`.

A runtime profile (Release 2) can tighten this check.

### Where reachability is judged from

- **Install entry.** Reachability is judged from the **install entry**: the outermost function on the resolved call chain within the link group that has no resolved caller. Guards anywhere along the chain count, including guards inside helper summaries.
- **Several callers** take the most-reaching result.
- **Creation site** ([ADR 0013](adr/0013-code-with-no-resolved-caller-is-judged-from-its-creation-site.md)). A function that nothing resolvably calls, but that analysed code created (a heap-stored callback, an observable subscriber, a returned `stop()` closure), is not an install entry. It is judged from its **creation site**:
  1. the reachability of the code that created it
  2. AND the guards in force where it was created
  3. then its own guards on the way to the write

  Chains whose callers resolved are not ANDed with the creation site.

  Creation-site guards prune like path guards: a statically false catalog check in force where the function was created prunes its writes, traced as a `prune` step next to the `creation-site` step. A function with several creation sites is pruned only when every one is statically false.
- **Top-level declarations and exports** are created unconditionally at load, so their own guards decide.
- **A function whose creation was never evaluated** is `unknown`.

Each occurrence records its **reachability basis**: `call-path` or `creation-site`. The finding takes the basis of the occurrences that give its value, and `call-path` wins if any of them is `call-path`. The basis is evidence, and it decides nothing in R1.

### Install context

**Install context** records whether a mutation runs at load or later. It is judged separately from reachability.

- `load`: any resolved synchronous chain reaches top-level code.
- `deferred`: only a later call reaches it. The install entry's name is recorded, e.g. `init`.

Code reached only through a function with no resolved caller is `deferred`. So is code reached only through a dynamic chunk load, even when the load is triggered at top level. A finding is `load` if any occurrence is `load`.

### Limits

Snippet-driven installs are a known limitation (§6, §21): an SDK started by another script on the page is judged from its creation sites, without the snippet's config. Reachability and install context can differ between builds of the same code. In R1 that variance is reported, not gated (§20).

## 8. Finding model

### What a finding claims

A **finding** claims that the scanned code mutates its target *when it runs*. It does not claim that the mutation happened on some particular page load ([ADR 0009](adr/0009-findings-claim-static-capability.md)). Reachability (§7) says under what conditions it runs.

So shipped code that no observed configuration enables is still a finding. So are lazy chunks, config-gated paths and polyfill branches. The New Relic rrweb canvas recording is an example, although it sits outside the protected surface.

### Shape

One finding per fingerprint (§11). Every site that makes the same mutation is an **occurrence** of it.

| Field | Level | Identity? | Notes |
|---|---|---|---|
| `target` `{realm, holder, name, shadows?}` | finding | realm + name | §4 |
| `surface` | finding | no | from the owner → surface map |
| `effect` | finding | yes | see below |
| `locks` | finding | no; feeds `changed` | the mutation leaves the target non-configurable, or a non-writable data property; a configurable accessor with no setter doesn't lock. When occurrences disagree, the most-locking wins: `true` over `unknown` over `false` |
| attribution key | finding | yes | §10, §11 |
| `package`, `provenance`, `introducedBy[]` | finding / occurrence | no | §10 |
| `reachability`, `installContext` | finding | no | the most-reaching over occurrences (§7) |
| `confidence` `{target, mutation, attribution}` | finding | no | §9 |
| `baselineState`, `changedReasons[]` | finding | no | §11 |
| `catalogStatus`, `explainedBy[]` | finding | no | §4 |
| `occurrences[]` | finding | no | below |

Each occurrence records:

- its artifact (URL, hash, origin)
- the generated location, and the original location when a map resolves it
- the mechanism
- its own reachability, install context and reachability basis
- the realm instance
- its attribution evidence
- its resolution trace (§14)

### Effect and mechanism

The **effect** is what the mutation does to the target, and it is part of identity:

| Effect | Meaning |
|---|---|
| `replace` | the member now holds a new data value that is not the native's |
| `wrap` | as `replace`, and the new value is shown to call the original |
| `add` | a member added to a native prototype, constructor or namespace |
| `delete` | the member is removed |
| `descriptor-change` | a new getter/setter pair, data → accessor, or changed attributes with the same value |
| `prototype-change` | the holder's prototype is replaced (target `<holder>.[[Prototype]]`, §4) |

**The effect follows the new value, not the attributes that change with it** ([ADR 0011](adr/0011-effect-follows-the-value-not-the-attributes.md)). So these are all `replace`:

- `function fetch(){}`
- `[Replaceable]` `window.length = 5`
- a polyfill's `window.Promise = P` over a deleted native

Whether the result leaves the target locked is recorded separately, in `locks`. The one exception to the rule is an unproven restore, which takes its install's effect (§3). The product brief's `preservesOriginal` is folded into `wrap`.

The **mechanism** (§3) is evidence only. A library that switches from `=` to `defineProperty` doesn't change its fingerprint.

### Origin and provenance

These are two different things:

- **Origin** is where the artifact is served from: `local-build`, `same-origin`, `cross-origin` or `inline`.
- **Provenance** is how the code got into the artifact: `first-party`, `bundled-dependency`, `remote`, `inline` or `unknown` (§10).

## 9. Confidence

**Confidence** is analytical certainty about a finding. It is never a measure of risk. It is recorded separately for three dimensions:

- **target**: is the named target the one written?
- **mutation**: does the write take effect as stated?
- **attribution**: are the containing package and the original location right?

Each dimension takes one of `high`, `medium` or `low`.

**What a level promises.**

- `high`: every step was decided by a rule, with no assumption.
- `medium`: decided, but relying on a named assumption that a reviewer can check.
- `low`: a best reading, which a reviewer should verify.

A level below `high` always carries one or more **confidence reasons** from the closed lists below. A dimension's level is the lowest level among its reasons, and `high` means it carries none. The resolution trace (§14) shows the evidence behind each reason.

**Occurrences.** Each occurrence keeps its own confidences and reasons. A finding takes the **highest** level per dimension across its occurrences, because one certain site proves the mutation exists.

**Use.** Confidence is reported only. It never feeds `changed`, is not stored in the baseline, is not used by `--fail-on`, and is not scored by the acceptance bars (§20). Release 2 policy may use it.

**What does not lower confidence.**

- Budget exhaustion is a completeness limitation (§13).
- A `creation-site` reachability basis affects reachability only (§7).

### Target confidence

| Reason | Level | When |
|---|---|---|
| `realm-assumed` | medium | an artifact whose realm is assumed `window`: sweep-only, preload-only, or imported by a preload-only file at any depth (§2) |
| `holder-alternatives` | medium | an undecided branch that the catalog can't settle gives several candidate holders; each candidate is reported with this reason |
| `member-alternatives` | medium | as above, for several candidate members |
| `direct-eval-scope` | medium | a direct `eval` in a sloppy scope on the resolution path could add a shadowing `var` |
| `with-scope` | low | a `with` block on the resolution path could redirect the name to an object property |

These leave target confidence at `high`: wildcard targets (they claim exactly what is known), holders chosen at runtime by the catalog, catalog enumeration of member sweeps (a filter that can't be decided included), a `this` assumed for a function with no resolved call (§5), and an unknown realm instance.

### Mutation confidence

| Reason | Level | When |
|---|---|---|
| `outcome-undecidable` | medium | the outcome table (§3) can't decide the write: an ambiguous written object, a partly resolved mechanism, an unresolved descriptor where the outcome depends on it, or seen descriptors whose effects differ (one finding per effect, §3) |
| `wildcard-outcome-mixed` | medium | a wildcard's matching members are partly effective and partly ineffective |
| `const-collision` | low | another classic script in the realm declares the name with `const`, so the write most likely throws (§3) |

The effect is decided by rule, never marked uncertain: `wrap` only with wrap evidence, `replace` otherwise (§5, §8).

### Attribution confidence

Attribution confidence is about the containing package and the original location only. How certain the **version** is, is shown by its source (store path, lockfile or content signal), not by this dimension. Certainty about **introducers** stays on `introducedBy` (§10).

| Reason | Level | When |
|---|---|---|
| `token-check-n/a` | medium | no `sourcesContent`, a null `sourcesContent` entry for the mapped source, or no token at the site (a computed, wildcard or number member, §10) |
| `sidecar-not-token-verified` | medium | a map paired by mirrored sidecar (`external-sidecar`, §2) that passed pairing verification but wasn't token-verified (§10) |
| `framework-path-rule` | medium | the package was named by a framework path rule |
| `first-party-inferred` | medium | first-party only by root inference, where the inferred root lies above the bundler base (the map's directory, or the webpack context), under any bundler |
| `prebundled-dist` | medium | the original is a package's `dist` file, which may hide vendored code |
| `yarn-slug` | low | Yarn's pnpm linker gives only a lossy name; a scoped package's slug keys `unknown`, with the slug as evidence (§10) |
| `line-separator` | medium | the artifact contains raw U+2028/U+2029 |
| `no-map` | low | the artifact has no map, the position is unmapped, or it maps to a synthetic or bundler-runtime source (§10) |
| `escaped-source` | low | a composed map path leaves the package |
| `token-check-failed` | low | the looked-up position was discarded |
| `vendored` | low | a store-name mismatch, or a package the lockfile says isn't installed |
| `foreign-scheme` | low | a source with an unrecognized scheme, which keys `unknown` (§10) |
| `ignore-list-demoted` | low | `ignoreList` demoted a source from first-party |

Remote code is `high` on its `url:` key. A package named by a remote map is evidence only. Inline code is `high`.

## 10. Attribution

Attribution says where a finding's code came from. **Its identity is read from the source-map path alone.** A lockfile and the install layout only add evidence ([ADR 0006](adr/0006-attribution-identity-ignores-optional-inputs.md)), so passing or dropping `--lockfile`, or switching package manager, never re-keys a finding. Package ownership is never inferred from chunk names.

### Containing package

The **containing package** is the package whose file holds the code behind an occurrence. It is read from the normalized raw `sources` entry of the occurrence's mapped original position.

1. **Normalize.** Use the raw `sources`, not `resolvedSources`. First strip a BOM or `)]}'` prefix, and recognize a synthetic source (below) on that raw entry, before any `sourceRoot` is joined. Then prepend a relative `sourceRoot` (no scheme, not absolute) as a string, only to an entry that has no scheme and isn't absolute, and ignore a URL or absolute `sourceRoot`. So with root `src`, `<anon>` and `webpack/runtime/load script` stay synthetic, an `https:` or `app:` entry keeps its scheme and keys `unknown` (`foreign-scheme`), a BOM-prefixed `https://cdn/node_modules/foo/x.js` included, a `webpack://` entry is stripped as usual, and an absolute path is read as written. Adding or removing a `sourceRoot` never changes whether an entry is synthetic. Strip a recognized scheme (below), loader prefixes (`…!`), and any `?query` (webpack's `?hash` included) and `*` suffixes. The resource path decides, so `webpack://app/./node_modules/babel-loader/lib/index.js!./src/polyfills.js` is the first-party `src/polyfills.js`, not the package `babel-loader`. A synthetic or bundler-runtime source (`webpack/runtime/*`, `webpack/bootstrap`, `<anon>`, a `\0` virtual module, `turbopack:///[turbopack]/…`, `ignored|…`, `external "x"`, a null or empty entry) counts as unmapped: `unknown` with `no-map`, and the raw source is kept as evidence. So does an entry whose resource path is empty once the namespace, `./` and `?query` are stripped, such as Next's context and hash stubs `webpack://_N_E/?6505`.
2. **Read the name** from the segment or segments after the **last** `node_modules/`. Scoped packages take two segments. The path is percent-decoded and `\` becomes `/`. `node_modules` counts only as a whole segment, and a dot segment right after it (`.store`) is skipped. Under Yarn's pnpm linker a scoped package appears only as a lossy slug (`@sentry-internal-replay-canvas-npm-8.0.0-…`): it keys `unknown`, with the slug as evidence (`yarn-slug`), so switching linkers gives `existing` with a `rekeyed` note, never `changed`. An unscoped package's slug gives its real name.

**Source schemes.** These are recognized: relative paths, `webpack://<ns>/`, `webpack-internal:///`, `turbopack:///[project]/`, `vite:`, and `file://`, absolute or drive-letter paths, which are named relative to the inferred root. Such a path is first-party only when the inferred root prefixes it. Otherwise it keys `unknown` (low), with the raw source as evidence, so the key stays the same across machines. Any other scheme (`app:`, `http(s):`, `data:`, `ng:` …) gives key `unknown`, provenance `unknown` and `foreign-scheme` (low), with the raw source as evidence, whether or not the path names a package.

A finding is attributed to its containing package. The fingerprint keys on that package's **name only**, with no version ([ADR 0005](adr/0005-fingerprints-key-on-the-containing-package.md)).

**Version.** The version is evidence only. The sources, strongest first:

- a store path: pnpm `.pnpm/<n>@<v>`, Bun `.bun/<n>@<v>`, Yarn `-npm-<v>-<hash>.zip`, or the global stores
- a lockfile keyed by install path (`package-lock.json` v2/v3 or `bun.lock` `packages`)
- weaker content signals: `package.json` in `sourcesContent`, in-package `VERSION` constants, banners

Only strong versions (store path or lockfile) feed the baseline's `packages` map and the `previousVersion` note (§11).

### Provenance

| Case | Finding names | Provenance | Attribution confidence |
|---|---|---|---|
| A path under `node_modules` | the containing package | `bundled-dependency` | up to `high` |
| First-party code, including a workspace package inside the inferred root | the scanned application, with the root-relative path; the workspace `name@version` as evidence only with `--lockfile` | `first-party` | per §9 |
| A remote artifact | its normalized URL; a package where a map names one | `remote` | per §9 |
| An inline script | the entry document | `inline` | per §9 |
| **Escaped source**: a composed map path that leaves the package (`webpack://_N_E/../../src/shared/…`) | unknown, with the raw path as evidence | `unknown` | `low` |
| An escaped source matched by a **framework path rule** | the package the rule names, with no version and the rule id as evidence | `bundled-dependency` | `medium` at most |
| **Vendored code**: a store-name mismatch, or a package the lockfile says isn't installed | the package the path names, with `vendoredBy: <vendoring package>` as evidence | `bundled-dependency` | `low` |
| No map, a failed token check, a synthetic or bundler-runtime source, or an unrecognized scheme | unknown, with the raw source or "no map" and any rejected lookup candidate | `unknown` | `low` |

- **The inferred root** is the common ancestor of every in-project package-source prefix, per bundler namespace. The pnpm and Bun global stores and Yarn's global cache don't count. A relative `sources` entry is first resolved against its map's build-relative directory, and one root is then inferred per namespace across the scan, with the relative-path maps of one build sharing one namespace. A map with no package sources uses its namespace's root. So a lazy chunk's `../../../src/lazy.ts` from `dist/assets/chunks/` keys `app:src/lazy.ts`, as it would beside the entry, and keys don't depend on chunk directory depth. With no in-project package source anywhere, the root is the bundler's own base, such as the webpack context. First-party code under a root that lies above the bundler base (the map's directory, or the webpack context) is `first-party-inferred` (medium) under any bundler, so esbuild's composed Sentry `src/integrations/…` sources and a monorepo's `libs/…` code are medium.
- **Escaped sources.** Framework path rules are tried first: any source with no `node_modules/` segment that a rule matches is an escaped source named by the rule (`medium`, `framework-path-rule`), wherever the root is. Any other source with no `node_modules/` segment is escaped when it lies outside the inferred root, or when it matches an **escape-only shape**. These are curated catalog data (§4) that name no package: under `_N_E`, two or more `../` segments then `src/shared/`, `src/lib/` or `src/build/`, and Angular 19.2.10 and earlier, whose fesm maps name `../…/packages/<pkg>/src/…` with no Bazel directory: two or more leading `../` segments, then `packages/<pkg>/`, where `<pkg>` is one of Angular's package names (`core`, `common`, `compiler`, `router`, `forms`, `platform-browser`, `platform-browser-dynamic`, `platform-server`, `animations`, `elements`, `service-worker`, `localize`, `upgrade`). Such a path that collapses inside the root isn't caught, and a real hoisted monorepo's `../../packages/core/…` is escaped too. A source matching one is always escaped (`unknown`, `escaped-source`, low), wherever the root is, so these keys never depend on hoisting. A composed-map source whose path climbs out of its own package inside `node_modules` (`node_modules/@x/src/…`, `node_modules/src/…`, `node_modules/node_modules/…`, as esbuild composing Sentry 7's own maps gives) is escaped too: `unknown` with `escaped-source`. The shape may sit anywhere in the path, and nothing after it is trusted: `node_modules/node_modules/a/node_modules/b/x.js` is `unknown` with `escaped-source`, not `pkg:b`.
- **Framework path rules** are curated, versioned data (§4). A rule may only name a package. It never makes code first-party, never gives `high`, and never supplies a version. R1 ships two rules:
  - Next webpack: the `_N_E` namespace, then two or more `../` segments, then `src/client/` → `next`. `src/shared/`, `src/lib/` and `src/build/` stay `unknown`.
  - Angular: `<platform>-fastbuild-ST-*/bin/packages/<pkg>/` on any Bazel platform (`k8`, `darwin_arm64`, …) → `@angular/<pkg>`, matched anywhere in the normalized path as a run of whole segments (`apps/k8-fastbuild-ST-…/bin/packages/core/…`, `../bazel-out/k8-fastbuild-ST-…/bin/packages/core/…`). Angular 19.2.0 and earlier stay `unknown`.
- **Token check.** It is required whenever `sourcesContent` exists. Only a member written at the site is a token: an identifier, a string key, a no-substitution template literal key (`` window[`fetch`] = w ``) or an object-literal key. A computed or wildcard member (`e[t]=n`) has no token, and neither has a number key (`h[0]`, `{ 0: w }`). A write with no member (`setPrototypeOf`, `__proto__`) uses its holder argument as the token only when it is written as a free global or a literal property name (`window`, `history`), never as a local binding. The token must appear as a whole identifier, case-sensitive, within ±1 line of the mapped original position under any of three line readings of the original: at ECMAScript terminators, at LF and CR, or at LF only. A failed check discards the position, and the occurrence falls to `unknown`. Without `sourcesContent`, with a null `sourcesContent` entry for the mapped source, or without a token, the check doesn't apply and confidence is capped at `medium`.
- **The lookup point** is the write's member token: `fetch` in `window.fetch = w`, the `'fetch'` argument of `defineProperty`, a key in `defineProperties` or `Object.assign`. A write with no member token (`setPrototypeOf`, `__proto__`) looks up its holder argument. The occurrence keeps the whole write as its reported position. A write inside a helper looks up the outermost call on the chain whose arguments carry both the holder and the member: `fill(WINDOW.history, "pushState", …)`, called from @sentry/browser-utils, keys `pkg:@sentry/browser-utils` although `fill` is in @sentry/core. An argument carries what it contains: the array or split-list elements a loop takes out of it, and the values held in an object argument's heap fields, at any depth. So `wrapAll(XMLHttpRequest.prototype, ["open", "send"], w)` in `src/instrument.js`, whose library loops `fill(proto, n, w)` over the names, keys `app:src/instrument.js`, and @acme/sdk's `installPatch({ target: XMLHttpRequest.prototype, method: 'send' })` keys `pkg:@acme/sdk`. When a heap field supplies the member, the lookup is at the string literal that supplies it inside the call's arguments, with that literal as the token (`'send'`), so the key doesn't depend on how the call is laid out. When the key isn't written in the call (`const s = {…}; installPatch(s)`), the lookup is at the call's start with no token. An argument that carries part of a folded key carries the member too. When a helper builds the key from a parameter and a literal (`function hook(p, n){ p['set' + n] = wrap(p['set' + n]) }`), the lookup is at the outermost call whose arguments carry the holder and any part of the key, at the call's start with no token, as for a key not written in the call. So @acme/browser's `hook(XMLHttpRequest.prototype, 'RequestHeader')`, with `hook` in @acme/core, keys `pkg:@acme/browser`. The call that bound the holder and member counts too: a closure's creation call, or the `new` or constructor call that stored the `this` fields, whose arguments carry both. So @acme/browser's `makePatch(window, 'fetch')` and `new Patcher(XMLHttpRequest.prototype, 'send')`, whose closure and `enable()` in @acme/core write, both key `pkg:@acme/browser`. When no call carries both (a table of `{ target, method }` objects that the helper loops over itself), it looks up the helper's write. Either way the reported position stays the helper's write. The lookup crosses artifacts only within the write artifact's origin (local-build to local-build). Otherwise it stops at the outermost carrying call in an artifact of that origin, or at the write itself: a remote `sdk.mjs` write that local `app.js` calls keys `url:https://cdn.example.com/sdk@*/sdk.mjs`, and an inline module's call into local `vendor.js`'s `fill` keys the package vendor.js's map gives. The lookup is trace-mapping's greatest lower bound on the same generated line. A 1-field segment, or no segment at or before the column, is unmapped (`no-map`).
- **Nested code** (§2) is attributed at the start of its outermost enclosing literal, the one in the host artifact's code, however deep the nesting (``eval(`eval('window.fetch = w')`)`` looks up the outer literal). Attribution looks up the literal's generated position, and the occurrence keeps the write's own position. A nested write has no literal token at the generated site, so the token check doesn't apply and confidence is capped at `medium`.
- **`ignoreList` / `x_google_ignoreList`** only demotes. A listed source with no `node_modules` segment moves from `first-party` to `unknown`. A map's `ignoreList` is used when present, and its `x_google_ignoreList` only otherwise.

Source-map discovery and pairing are in §2. A map's pairing method caps confidence:

- `debugId` and the mirrored annotation can reach `high`.
- A mirrored sidecar is `high` only when token-verified, otherwise `medium`.

### Introducing dependencies

The **introducing dependency** is a direct dependency of the scanned application whose installed tree includes the containing package. A direct dependency introduces itself. It comes only from an explicit `--lockfile <path>` (also settable in config), and it is never discovered automatically.

- **Formats:**
  - `package-lock.json` v2/v3 and `bun.lock`, which are exact
  - `pnpm-lock.yaml`
  - `yarn.lock` (Berry and v1), whose derived facts are capped at `medium`

  R1 reads `pnpm-lock.yaml` `lockfileVersion` 6.0 and 9.x, every Berry `__metadata.version`, and Yarn v1. Any other format version reports `no-lockfile` (no usable lockfile), with the format version as evidence. For the importer's direct dependencies and the dev/prod split, which `yarn.lock` doesn't record, the `package.json` manifests next to the lockfile are read (§2): the one in its directory, and the workspace manifests it names (v1 through its `workspaces` globs, Berry through its workspace entries). A missing or unreadable manifest gives `importer-unresolved`.
- **Importer.** The first-party source paths are taken relative to the lockfile's directory, and the workspace that contains them is the scanned application. The `lockfile.importer` config setting overrides this.
- **Walk.** Match the occurrence's install or store path to its lockfile entry. Then walk reverse edges (`dependencies`, `optionalDependencies`, resolved peers, and the root's `devDependencies`) up to the importer's direct dependencies. For vendored code, walk from the vendoring package.
- **Record.** Each occurrence carries `introducedBy[]` (`name@version`, sorted), and a finding shows the union. It applies only to `bundled-dependency` code.
- **Unknown is not empty.** With no usable lockfile, `introducedBy` is absent, and the attribution block records the reason: `no-lockfile`, `importer-unresolved` or `lockfile-stale`. A lockfile that disagrees with any store-path version is stale for the whole scan: `introducedBy` is absent everywhere, with reason `lockfile-stale`, versions taken from the lockfile are dropped from `packages` and `previousVersion`, leaving only store-path versions, and lockfile-based vendored detection is off. The baseline header then matches a scan run without `--lockfile`. A missing lockfile never affects completeness.
- **Never derived from paths.** The npm nesting chain may appear in the trace as raw evidence only.
- **Never identity.** Introducers are never baselined and never feed `changed`.

### Terminal wording

```
Package         otel-fetch@0.57.0
Introduced by   @acme/telemetry@8.0.0      ← only when it differs from Package
```

- `Introduced by` is omitted when the containing package is itself a direct dependency.
- It reads `unknown (no lockfile)`, or the recorded reason, when introducers are unknown.
- Vendored code reads `Package  tiny-helper (vendored in telemetry-agent@x)`.

The input tiers in §2 state what each missing input costs.

**Roots with no shared place**. Relative maps in different directories with no package source each take their own directory as root, so `assets/index.js.map`'s `src/main.ts` and `assets/chunks/lazy.js.map`'s `src/lazy.ts` key `app:src/main.ts` and `app:src/lazy.ts`. A `data:` map resolves relative entries against its script's directory, and a `debugId`-paired map against its path inside the declared directory, as if the directory mirrored the build. `vite:` paths are their own namespace, based like webpack. Absolute paths under every wrapper (`file://`, bare `/`, drive letters, `webpack://ns//abs/`) form one `absolute` namespace with no base, so `first-party-inferred` never applies to them. So a dependency-free Vite or esbuild app's `../../src/main.ts` from `dist/assets/` is escaped, and Vite, Rollup and esbuild first-party sources are `first-party-inferred` whenever the root comes from `../…/node_modules`.

## 11. Fingerprints, baseline and `changed`

### Fingerprint

A finding's **fingerprint** is `(realm, target, effect, attribution key)`, written as a readable canonical string with no hash: `window|Window.fetch|wrap|pkg:@sentry/core`.

- **No callsite component** ([ADR 0007](adr/0007-fingerprints-have-no-callsite-component.md)). Every site making the same mutation under one attribution key is one finding with several occurrences, including duplicate copies of a package in one bundle. A package adding a second site for an existing mutation adds an occurrence, never an `added` finding.
- **Never in the fingerprint:** mechanism, surface, holder, module ids, artifact paths and positions.
- **Scheme version.** It is recorded in the baseline header and in the SARIF key name, not in the string.

**Attribution keys**, from which the provenance follows:

| Kind | Key | Provenance |
|---|---|---|
| Bundled dependency | `pkg:<containing package name>`, with no version or inner path | `bundled-dependency` |
| First-party | `app:<root-relative original path>`: recognized schemes (§10), namespaces, `./`, loader prefixes (`…!`) and `?query` stripped; POSIX separators; case and extension kept | `first-party` |
| Remote | `url:<normalized URL>` | `remote` |
| Inline | `inline`: one key for every entry document, with the documents as occurrences | `inline` |
| Unattributed | `unknown`: one key for all local code that can't be attributed | `unknown` |

**Root-relative paths.** A first-party path is named by stripping the inferred root's prefix (§10) where the path has it, and otherwise by dropping leading `../`. So in a hoisted monorepo, webpack, Vite and esbuild all give `app:src/polyfills.ts` and `app:libs/telemetry/src/fetch-wrap.ts`, and renaming the app directory or re-hoisting rekeys nothing.

**Remote URL normalization** uses the URL as referenced, not after redirects. Code a redirected script references (its imports, `importScripts` and workers) is fetched against the final URL, as the browser does, but keyed by the URL resolved against the referencing script's requested URL. So keys don't change when a redirect target moves or varies by region. The rules are versioned data (§4). The steps:

1. Make protocol-relative and `http:` URLs `https:`.
2. Lowercase the host, and drop default ports, the query and the fragment.
3. Replace version tokens with `*`: `v\d+`; semver as a whole segment; a version run in a filename after `-`, `_`, `@` or `.` (below); and `@<semver>` after a package name.
4. Replace hex runs of 8 or more characters with `#`.

So `…/11.0.0/bundle.tracing.replay.min.js` normalizes to `…/*/bundle.tracing.replay.min.js`, and `nr-loader-spa-1.322.0.min.js` to `nr-loader-spa-*.min.js`. `ai.3.gbl.min.js` is kept as it is. A region switch (`us1` → `eu1`) is a new URL.

Steps 3 and 4 apply to the path only, and only to whole tokens bounded by `/`, `.`, `-`, `_`, `@` or the ends. Hex matches in either case. So `datadog-rum-v4.js` becomes `datadog-rum-*.js` and `d3.v7.min.js` becomes `d3.*.min.js`, while `tv4`, partial hashes and hosts are kept. Semver as a whole segment is 2 or 3 numeric parts, with an optional `v`. In a filename the version run is maximal: an optional `v` plus 2 or more dot-separated numeric parts, any number of them, is one version. Its pre-release or build part (after `-` or `+`) takes one identifier and then only numeric dot parts, so it stops before the trailing extension chain (`.min.js`, `.js`, `.umd.min.js`, `.gbl.min.js`, `.mjs`, `.cjs`). So `ai.clck.2.8.18.min.js` → `ai.clck.*.min.js`, `lib.v1.2.3.js` → `lib.*.js`, `lib-1.2.3.4.min.js` → `lib-*.min.js`, `sdk-2.0.0-rc.1.umd.min.js` and `sdk-2.0.0.umd.min.js` → `sdk-*.umd.min.js`, and `lib-1.2.3-beta.mjs` → `lib-*.mjs`. After a package name, `@` plus any numeric version, even major-only, is a version, and the `@` stays: `react@18/…` → `react@*/…`, `vue@3.4/…` → `vue@*/…`, `repo@v1.2.3/…` → `repo@*/…`, `sdk-2.0.0-rc.1.min.js` → `sdk-*.min.js`.

One fetched URL can have two key URLs: a redirected loader's `import "./rum.js"` is keyed from the loader's requested URL, and a direct `<script src>` of the same fetched URL is keyed from its own. Each key URL then gets its own artifact record, sharing the single fetch and analysis, as §2 does for identical bytes. That gives one finding per key, whatever the reference order.

The **target key** is `(realm, target, effect)`.

**Finding-level values over occurrences:**

- reachability: the most-reaching occurrence
- install context: `load` if any occurrence is `load`
- each confidence: the highest over occurrences, while each occurrence keeps its own
- provenance: follows from the key

### Baseline

The **baseline** is a committed, deterministic JSON file, reviewed in PRs like code ([ADR 0001](adr/0001-committed-json-baseline-no-sqlite.md)). There is one per scan configuration, covering every entry document and realm, and one per `--surface` scope. A monorepo has one per app. `--baseline` also accepts a full scan JSON report ([ADR 0020](adr/0020-a-report-used-as-a-baseline-reads-as-if-updated.md)). It is read as if `baseline update` had just been run on that scan: every finding except `removed` is an accepted entry (`added` and `changed` included, under their current fingerprints), `unconfirmed` entries carry forward, and its `scanConfigId` must match like a baseline file's. The report's `packages` map serves as the baseline's. A report whose `completeness.level` is `incomplete` is a readable baseline only with `--allow-incomplete`, and it then reads as `baseline update --allow-incomplete` would write it: a report whose crash guard fired gives back its own baseline through its `unconfirmed` entries. A guard-fired report with no baseline of its own is refused even with the flag, as `init` refuses it. A refused report is no readable baseline: under `--fail-on` the scan exits 2, and without it the scan warns and findings have null baseline states.

**Header:**

- `formatVersion`
- the **scan-config id** (§16)
- fingerprint scheme version
- `catalogVersion`
- `monkeypatchlistVersion`
- the completeness the baseline was written under
- the surface scope
- the **`packages`** map: name → version and version source, for packages with at least one entry, strong versions only (§10). A name with more than one strong version in the scan gets no entry, so its findings get no `previousVersion` note on either side

**Entries.** One per finding, holding only:

- the fingerprint
- the attributes that decide `changed`: attribution key, effect and `locks`
- readable context to report a `removed` finding: target, effect, surface, package, provenance, realm

Entries store nothing that churns on a rebuild: no occurrences, hashes, paths, positions, reachability, install context or reachability basis ([ADR 0014](adr/0014-reachability-and-install-context-do-not-feed-changed-in-r1.md)).

**Determinism.** Entries are sorted by fingerprint, with fixed key order, 2-space indent, LF line endings and a trailing newline. There are no timestamps, absolute paths, host information or git SHA. An unchanged build rewrites the file byte for byte. Concurrent-update conflicts are resolved by re-running `update`, not by merging by hand.

**Format versions.** A newer `formatVersion` than this monkeypatchlist understands is a hard error. An older one is migrated in memory with a warning and rewritten on `update`. Catalog and scheme skew are handled in §4.

**Commands.**

- `baseline init` and `baseline update` accept the whole current finding set. `update` prints what it accepts: added, changed and removed findings, with any `explainedBy`.
- There is no selective accept by fingerprint. That would be a policy exception, and policy is Release 2.
- `init` and `update` refuse on an `incomplete` scan unless `--allow-incomplete` is given. `update` carries `unconfirmed` entries forward unchanged.
- `update` writes on a `complete-with-limitations` scan, with a warning.
- `update` writes each paired entry's current `locks`, `unknown` included, so every baseline stays a projection of the latest scan, and `true` → `unknown` → `false` across two updates never gives `changed` (`locks`).

**No baseline.** Without a readable baseline, findings have a null baseline state. `--fail-on` without one is a usage error with its own exit code, so a mistyped path never passes CI.

**No analysis cache and no SQLite in R1.** Per-artifact analysis is a pure function of (artifact bytes, catalog version, analyzer version), so a cache can be added later without changing an interface.

### Baseline states and matching

Findings are matched against the baseline in order:

1. **Exact fingerprint.**
2. **Same `(realm, target, attribution key)`, different effect**, 1:1 only: `changed`, reason `effect`.
3. **Target key.**
   - Known key ↔ known key, 1:1 only: `changed`, reason `attribution`. This covers a package restructure (Sentry 7 → 10), a vendor URL move or a file rename.
   - A pair where either side is `unknown`: `existing` with a `rekeyed` note. `unknown` pairs with every unmatched entry on the other side (N:1 or 1:N), which is what stripping or adding maps does.
   - When a group holds both known keys and `unknown`, both pairings apply: a known scan finding pairs 1:1 with a known entry (`changed`, `attribution`) and also with the `unknown` entry, keeping the `rekeyed` note. Nothing is `removed`, and `update` collapses both entries into the scan's key.
   - An `unknown` finding or entry takes part in this pass even after an exact-fingerprint match: a leftover `pkg:@sentry/src` entry pairs with the already-matched `unknown` finding, which stays `existing` and gains a `rekeyed` note, and nothing is `added` or `removed`.
   - So does an `unknown` finding or entry the effect pass paired, with every rule of this pass: baseline {`window|Window.fetch|replace|unknown`, `window|Window.fetch|wrap|pkg:a`} against scan {`window|Window.fetch|wrap|unknown`} gives one `changed` (`effect`) finding that also has a `rekeyed` note (before: `pkg:a`), nothing is `removed`, and a `locks` difference against `pkg:a` adds a `locks` reason.
   - Any other ambiguous group stays `added`/`removed`, with a note that the entries share a target key.
4. **Baseline entries still unmatched:**
   - `unconfirmed` when the scan is `incomplete`, when any link group exhausted its step budget (a Principle 5 cap cut alone doesn't count), or when the entry's provenance is `remote` and the scan skipped or refused any remote script
   - otherwise `removed`

The effect pass runs before the target-key pass. A package keeping its name is stronger evidence than an effect staying the same. `baseline update` rewrites every paired entry under its new fingerprint. Each finding records `matchedBy` (`fingerprint`, `effect` or `target-key`).

**`changed`** means the platform behaves differently, or the mutation is now someone else's code. `changedReasons[]` records before → after for each reason:

| Reason | Trigger |
|---|---|
| `attribution` | a known ↔ known target-key pair |
| `effect` | a 1:1 pair on the same attribution key with a different effect |
| `locks` | the derived `locks` value differs, `true` ↔ `false` only (`unknown` ↔ known is not a change) |

A `rekeyed` pair with a `locks` difference is `changed`, and keeps the note. When `unknown` pairs N:1 and any of the pairs differs in `locks`, the finding is `changed` (`locks`), keeps the note, and gets one `changedReasons` entry per differing baseline entry. The comparison is symmetric: narrowing is `changed` just as widening is.

**Never `changed`:**

- mechanism
- confidence
- origin
- occurrences and artifacts, and their counts
- package version
- `introducedBy`, `vendoredBy`
- restore entries
- **reachability and install context**: a difference in either is `existing`, with a before → after note that does not trip the gate. The note needs the previous values, so it appears only when `--baseline` is a full scan report, or a previous report is supplied (§16). The previous value comes through the baseline pairing, a `rekeyed` pair included, and the note appears on `existing` and on `changed` findings, beside any `changedReasons`. The note needs a baseline: without `--baseline`, `--previous` gives no notes and a warning. An explicit `--previous` overrides a report baseline as the source of the previous values, and its `scanConfigId` must match, as a baseline's must. The creation-site basis rule for this note is kept dormant for when these attributes return to `changed` ([ADR 0013](adr/0013-code-with-no-resolved-caller-is-judged-from-its-creation-site.md)).

**`previousVersion`.** When a finding's containing package has a strong version on both sides (the scan and the baseline's `packages` map) and the versions differ, the finding carries a `previousVersion` note, in any state. It is always the **containing package's** previous version. The product brief's example shows the introducer's previous version; R1 does not store introducers in the baseline ([ADR 0005](adr/0005-fingerprints-key-on-the-containing-package.md)), so it never reports that form.

**The gate.** `--fail-on added,changed` trips on every `changed` reason. Gating by reason or direction is Release 2 policy. When `--fail-on` is set, an `incomplete` scan exits with its own code even if nothing matched, and `--allow-incomplete` downgrades that to a warning (§13, §16).

**Redirects and keys**. A redirected script's bare import that resolves only through the import-map scope matching its final URL is keyed by the fetched URL resolved against the final URL; when both resolutions succeed, the key follows the requested URL. One key URL reached through two fetch URLs gives an artifact record per (key URL, fetched URL): both are analyzed and land in one finding under the one key, told apart by `retrieval.requestedUrl`. A pre-release or build part belongs to a semver segment and an `@` package version (`vue@3.4.0-beta.1/` → `vue@*/`). Step 2 runs after step 1 (`http://x:443/` → `https://x/`, while `https://x:80/` keeps its port). A keyed child's `origin` comes from its key URL.

## 12. Protected surface

**Detect everywhere, report the protected surface.** The resolver detects across the whole native catalog. The **protected surface** limits what a scan reports, baselines and gates.

- **Scope flag.** `--surface protected` is the default. `--surface all` reports the whole catalog. Each scope has its own baseline. R1 has no per-surface or per-target selection, because that is policy (Release 2).
- **Out-of-scope findings.** A `protected` scan leaves them out of the finding list and the baseline, and gives them no baseline state. It reports their count per surface, so the reader knows when `--surface all` is worth running.
- **Ineffective writes** follow the same scope (§3).
- **`unresolved-holder` records** (§5) follow it too. A `protected` scan keeps a record only when at least one of its candidates is in scope, matched through `shadows`, and its `detail` lists only the in-scope candidates. `--surface all` keeps every record.

### Matching

Entries are keyed on **(interface, member)**, independent of realm and holder. An entry matches:

- the prototype, static or global member itself
- any write that shadows it, on whatever holder it lands, matched through `shadows` ([ADR 0002](adr/0002-shadowing-writes-name-the-written-object.md)): `history.pushState = w`, `window.addEventListener = w`, `localStorage.setItem = f`, `WindowProperties.addEventListener`, `Window.prototype.addEventListener = w`. An ES-tail shadow on a Web IDL holder (`XMLHttpRequest.prototype.toString = f`) is protected under the `Object` or `Function` entry.
- its worker-realm equivalent: `WorkerGlobalScope.prototype.fetch`, `self.fetch = w`. `WorkerNavigator.prototype.serviceWorker` is the `Navigator.serviceWorker` entry's equivalent in all three worker realms.

There are two kinds of entry:

- **Whole interface or namespace.** It covers:
  - the global constructor binding (`Window.XMLHttpRequest`)
  - every static and prototype member **that the native catalog lists for the interface**
  - wildcards over those members (`console.*`)
  - a `prototype-change` of the prototype

  - an `add` of a **named** member to the constructor or prototype, whether or not the catalog lists it and whatever its key: a polyfill installing a missing `Promise.allSettled`, a library adding `Array.prototype.last`, or zone.js adding `XMLHttpRequest.prototype.__zone_symbol__open`

  A namespace entry's object plays both the constructor and the prototype role. So named adds on `console`, on `JSON` and on `console.[[Prototype]]` are covered, and so are the prototype changes `console.[[Prototype]]` and `JSON.[[Prototype]]`. Every prototype-kind holder a whole entry owns has its prototype change covered, so `console.[[Prototype]].[[Prototype]]` is in scope, with surface `diagnostics`. A constructor's own `[[Prototype]]` (`XMLHttpRequest.[[Prototype]]`) is not.

  It does **not** cover **pattern wildcards** of non-native adds, such as zone.js `__zone_symbol__*` or core-js `Symbol(…)_*` uid keys. Those appear only under `--surface all`.

  Event-handler attributes (`onX`) are excluded.
- **Member.** It covers only that member.

A wildcard over native members (`<holder>.*`) is in scope when any catalog member of its holder that it matches (§3) is covered. A singleton's wildcard is in scope when the singleton's interface is a whole-interface entry (`history.*`, `localStorage.*`, `sessionStorage.*`, `crypto.*`, `crypto.subtle.*`, `navigator.serviceWorker.*`), or through its covered members (`navigator.*`). `document.*` and `performance.*` are not. A pattern wildcard of non-native adds (`<holder>.<prefix>*`) never is. A singleton's `prototype-change` follows the singleton-wildcard rule: `localStorage.[[Prototype]]`, `history.[[Prototype]]` and `navigator.[[Prototype]]` are in scope, and `document`, `performance` and `navigator.geolocation` prototype changes are not.

### The list

| Surface | Entries |
|---|---|
| networking | `fetch` (member) · `XMLHttpRequest`, `WebSocket`, `EventSource`, `Request`, `Response`, `Headers` (whole) · `Navigator.sendBeacon` (member) |
| events | `EventTarget.addEventListener`, `.removeEventListener`, `.dispatchEvent` (members) |
| scheduling | `setTimeout`, `setInterval`, `clearTimeout`, `clearInterval`, `requestAnimationFrame`, `cancelAnimationFrame`, `requestIdleCallback`, `cancelIdleCallback`, `queueMicrotask` (members) |
| navigation | `History` (whole) · `Window.open` (member) |
| storage | `Storage` (whole) · `Window.localStorage`, `Window.sessionStorage` (members) |
| crypto | `Crypto`, `SubtleCrypto` (whole) |
| ECMAScript | `Promise`, `Function`, `Object`, `Array`, `Map`, `Set`, `JSON` (whole) |
| diagnostics | `console` (whole) |
| workers | `Worker`, `SharedWorker`, `ServiceWorkerContainer` (whole) · `Navigator.serviceWorker` (member) |

Session-replay DOM hooks and the observer constructors are deliberately left out: `CustomElementRegistry.define`, `Element.attachShadow`, the `CSSStyleSheet` rule methods and input value setters.

### Surfaces and data

- **Surfaces** are `networking`, `events`, `scheduling`, `navigation`, `storage`, `crypto`, `DOM`, `ECMAScript`, `diagnostics`, `workers` and `other` (an owner nobody has reviewed yet).
- **Assignment.** Surfaces come from a curated owner → surface map with per-member overrides. The map was seeded once from spec shortname and HTML section page, and is committed. ECMAScript owners always get `ECMAScript`. New owners appear as `other` in the generator's review diff.
- **Where the list lives.** The protected list ships **as data** in the catalog overlay, versioned with the catalog (§4). The generator checks that every entry resolves to existing catalog targets.
- **Changing the list.** Growth shows up as ordinary `added` findings, with `explainedBy`.

## 13. Completeness and coverage limitations

Every scan reports what it did not analyze. It gets one of three levels:

- `complete`
- `complete-with-limitations`
- `incomplete`

**The level is judged against the scan configuration.**

- `incomplete`: the scan failed to analyze something its configuration asks for.
- `complete-with-limitations`: its only gaps are blind spots the configuration declares, or blind spots inside analyzed code.

Each limitation kind has a fixed level. There are no thresholds and nothing is configurable. The same configuration over the same bytes always gives the same level.

### Limitation kinds

| Kind | Level | Raised when |
|---|---|---|
| `parse-failure` | incomplete | an artifact doesn't parse; it is treated as unanalyzed, and a partially recovered AST is never used |
| `unreadable` | incomplete | a local artifact, a declared source-map directory, a build subdirectory or link target under a URL mapping that the sweep can't reach, or a source map a pairing method names for a local-build or inline artifact, can't be read |
| `source-maps-unpaired` | incomplete | a readable source-map directory pairs with nothing: none of its maps verifies against any artifact through an external method (§2) |
| `fetch-failed` | incomplete | in `resolve` mode: timeout, DNS, TLS or non-2xx |
| `sri-mismatch` | incomplete | fetched bytes don't match their SRI; they are not analyzed, and both digests are recorded |
| `remote-refused` | limitation | the fixed safety floor refuses the fetch: a scheme, address, size, count, redirect (more than 5, or a loop) or content-type refusal (§17) |
| `offline-skipped` | limitation | a remote script in `offline` mode |
| `dynamic-code` | limitation | a non-literal `eval`, `new Function` or string timer; literal code given to one that doesn't parse; or an indirect call that reaches one (§2); or the non-literal text of an injected script element |
| `unresolved-reference` | limitation | a non-literal dynamic import, worker URL or injected `src`, a dynamic import whose options can't be read where they decide the module (§2), or a remote chunk URL that doesn't fold to a constant. Local chunk URLs a chunk loader builds are exempt, because the sweep covers them; §2 decides what is local |
| `realm-uncertain` | limitation | an artifact whose realm is assumed (sweep-only, preload-only, or imported by a preload-only file at any depth), with worker markers |
| `unresolved-holder` | limitation | a patch-shaped write whose member names a catalog member it could mutate but whose holder doesn't resolve (§5); `detail` lists the candidate targets, or the narrowed `<holder>.*` names (§5), only the in-scope ones in a `protected` scan (§12) |
| `unlinked-module-call` | limitation | a broken module link (non-constant id, missing id or missing chunk) receives a global, holder or target (§6) |
| `analysis-budget` | limitation | a link group's step budget ran out, or a cap cut analysis of something that carries the global object, a native holder or a native member (Principle 5): a folded string or BigInt passed the `fold-length` cap as the key, holder or descriptor of a write or guard that resolves to one of these, any alternative counting (`Array.prototype[huge] = f`, `window[huge] = f`, `frames[huge].fetch = f`; not `userObject[huge] = 1`, nor `window[huge].x = f`, whose holder resolves to nothing); a recursion or context cap widened or merged a call that carries one; or the iteration cap cut a loop that writes or guards one (§5). Any other cap hit is only counted. Findings from completed work are reported (§18) |
| sweep-only with assumed `window`; excluded outside a mapping; non-JS; missing maps | none | counters only |

A wall-clock crash guard that fires fails the scan as `incomplete`. It never changes results: a scan whose guard fired reports no findings, and `baseline init` refuses it (exit 3) even with `--allow-incomplete`. Every baseline entry is `unconfirmed`, nothing is `added` or `changed`, and `baseline update --allow-incomplete` leaves the baseline unchanged.

Each record holds `{kind, artifact (URL or path, plus hash if known), location (for in-code kinds), detail}`. Records are sorted deterministically.

### Counters

- **Artifacts:** `known` (the denominator), `analyzed`, `failed` by reason, `skipped` by reason (`offline`, `excluded`, `nonJs`) and `sweepOnly`.
- **Blind spots**, as absolute counts: `dynamicCode`, `unresolvedReference`, `realmUncertain` and `unresolvedHolder`.
- **HTML content not followed or analyzed** (§19): `nomodule` script elements (a local file one names is still swept, §2) and injected scripts with `noModule` set, in `nomodule` or a counter of their own (the implementer's choice, delegated), and in the same counter, injected scripts whose `noModule` doesn't fold, which are also followed, and `inlineHandlers` (inline event-handler attributes and `javascript:` URLs). Like `nonJs`, these are informational and don't change the level.
- **Module linking.** Each artifact carries `moduleLinking: { idioms, modules, unlinked, linkGroups }` (§6).
- **Scan statistics:** budget caps and step counts.
- **No percentages** and no overall coverage figure, because unseen references have no denominator.

A clean result must tell "0 mutations found" apart from "0 mutations found, 2 known resources unresolved".

**Attribution block.** Missing source maps are not a coverage limitation. They are reported in a separate block with:

- artifacts with, without, and with broken maps
- per-method pairing counts
- per source-map directory: maps found, paired, `stale` and orphaned (verified against no artifact), plus a sorted list of orphaned map paths
- findings whose attribution confidence is capped
- the reason introducers are unknown (§10)

### Effects on the baseline and the gate

- A missing baseline finding is `unconfirmed`, not `removed`, when the scan is `incomplete`, or when any link group exhausted its step budget. The same applies when the finding is `remote` and any remote script was skipped or refused (§11).
- Only the summary level goes into the baseline.
- Under `--fail-on`, an `incomplete` scan exits with code 3 even when no finding matched (§16). `--allow-incomplete` downgrades that to a warning.
- `complete-with-limitations` never fails the gate on its own.
- `baseline init` and `baseline update` refuse an `incomplete` scan unless `--allow-incomplete` is given.

## 14. Resolution trace

Every occurrence carries a **resolution trace**. It gives enough reasoning for an engineer to check the finding without reverse-engineering the bundle.

**Shape.** `trace: [{ kind, …, text }]` is an ordered list of steps. `kind` comes from a closed list, each step carries the fields for its kind, and `text` is a rendered sentence. Tests assert on kinds and fields, never on `text`.

| Kind | Records | From |
|---|---|---|
| `binding` | how a name resolved: global, singleton alias, declaration; realm and realm instance | §5 |
| `alias` | an alias or reaching definition followed, with its location | §5 |
| `fold` | a constant or string fold (`"add" + "EventListener"` → `"addEventListener"`) | §5 |
| `call` | a summarized call: callee, call site, argument bindings | §5 |
| `module-link` | a module-link hop: idiom, module or chunk id, export name, artifact | §6 |
| `catalog-holder` | a holder chosen against the unmutated catalog (a runtime choice or a prototype walk) | §4 |
| `enumeration` | a member sweep expanded by the catalog, with its filter; a configurable wildcard prefix and its default | §5 |
| `guard` | a guard on the path: its expression, its class (transparent, absence, broken-native, config, other-target, unknown, undecided), the tested native, and the resulting reachability. `undecided` is a recognized guard that can't be decided (sampling, `document.readyState`, `typeof global`), with result `conditional` | §7 |
| `prune` | occurrences pruned by statically false catalog checks, with a count and the guard. Writes dropped from an arm that a call argument's object-literal field rules out (§5 capability 5) are pruned the same way, counted with the catalog-check prunes and traced with the test that ruled the arm out | §7 |
| `creation-site` | a caller-less function judged from where it was created | §7 |
| `outcome` | the outcome-table decision, or why it was undecidable | §3 |
| `restore` | a proven restore in the same chain: location, `guard: identity \| none`, `leavesOwnShadow` | §3 |
| `token-check` | the token-check result, and any rejected lookup candidate | §10 |
| `path-rule` | the framework path rule id that named a package | §10 |
| `confidence-reason` | the evidence behind each confidence reason the occurrence carries | §9 |
| `note` | anything else a rule requires the trace to say, e.g. a `const` declared by another script | §3 |

For example, the product brief's case `proto[method] = wrapper` gives:

```
binding  proto → EventTarget.prototype (alias at main.js:1:880)
fold     method → "add" + "EventListener" → "addEventListener"
outcome  assign on a writable, configurable data property → effective
```

**Where traces appear.** The JSON report always includes traces. The terminal shows them only through `monkeypatchlist explain` (§16). Module and chunk ids appear in traces but never in identity.

## 15. Output contracts

### Channels

- **Terminal.** The terminal report always goes to stdout, and diagnostics go to stderr.
- **JSON.** `--json <path>` also writes the full JSON report. `--json -` writes JSON to stdout **instead of** the terminal report.
- **Other formats.** SARIF is Release 2 (§22). HTML reports are out of scope.

### JSON report

**Versioning.**

- The report carries `reportVersion`, an integer, and its JSON Schema ships in the package.
- Adding a field doesn't bump the version. Removing, renaming or changing the meaning of a field bumps it, and that needs a monkeypatchlist major release.

**Determinism.**

- For the same inputs, the report is byte-identical, except for the `run` block.
- Keys are in a fixed order. Findings are sorted by fingerprint and artifacts by URL.
- A full report can serve as `--baseline` or `--previous`.

**Top level:**

```jsonc
{
  "reportVersion": 1,
  "tool": { "monkeypatchlistVersion", "catalogVersion", "analyzerVersion", "fingerprintScheme" },
  "application": { "name" },
  "config": { "scanConfigId", "surface", "mode", "entries", "mappings",
              "sourceMaps", "lockfile", "failOn" },
  "summary": { "added", "changed", "existing", "removed", "unconfirmed",
               "outOfScopeBySurface": { "<surface>": 0 }, "ineffectiveWrites": 0 },
  "gate": { "failOn": ["added", "changed"], "result": "pass | fail | not-run", "exitCode" },
  "completeness": { "level", "counters", "limitations": [], "attribution": {} },
  "baseline": { "path", "header", "notes": [] },
  "packages": { "<name>": { "version", "versionSource" } },
  "findings": [],
  "ineffectiveWrites": [],
  "artifacts": [],
  "run": { "startedAt", "durationMs", "retrievals": { "<url>": { "fetchedAt", "etag", "lastModified" } } }
}
```

- **`completeness`** is defined in §13: counters, limitation records and the attribution block.
- **`ineffectiveWrites[]`** is defined in §3.
- **`packages`** is the same map the baseline stores (§11).
- **`run`** holds all wall-clock data, and nothing else is non-deterministic.

**Findings.** There is one `findings[]` list. `removed` and `unconfirmed` baseline entries appear in it with their `baselineState`, the readable context from the baseline, and no occurrences. Each finding carries:

- `fingerprint`, `targetKey`, and `target { realm, holder, name, shadows? }`
- `surface`, `effect`, `locks`
- `attribution { key, provenance, package?, vendoredBy?, workspace? }`, and the union of `introducedBy[]`
- `reachability` and its basis, and `installContext`
- `confidence { target, mutation, attribution }`, each `{ level, reasons[] }` (§9)
- `baselineState`, `matchedBy` (`fingerprint | effect | target-key`), `changedReasons: [{ reason, before, after }]`
- `notes: [{ kind, … }]`, where `kind` is one of `rekeyed`, `shared-target-key`, `previous-version`, `reachability-change` or `install-context-change`. Version skew (§4) is scan-level and goes in `baseline.notes`
- `explainedBy[]` and `catalogStatus` (§4)
- `policy`: in R1, `{ outcome: "fail", by: "fail-on:<state>" }` when the finding trips the gate, otherwise `null` (not evaluated). Release 2 adds `allow`, `warn` and `baseline`, with rule ids.
- `occurrences[]`, each with:
  - its artifact and generated location, and its original location when a map resolves one
  - its mechanism, reachability, install context and basis, and realm instance
  - its own confidence, attribution evidence and `introducedBy[]`
  - its `trace[]` (§14)

**Artifacts.** Each artifact record carries:

- `url`, `path`, `hash`
- `origin`, `discovery` (`reference | injected | sweep`), `sourceType`
- `realm`, `realmBasis`, `parent`
- `sourceMap { method, path, status }`, where `method` is one of the pairing methods in §2
- `retrieval { status, requestedUrl, finalUrl, contentType, sri }` (§17)
- `moduleLinking { idioms, modules, unlinked, linkGroups }`

### Terminal

The terminal report puts change first:

```
monkeypatchlist 1.0.0 · catalog 2026.10 · Trading Portal · surface protected · offline

Change since baseline
  Added 1   Changed 1   Removed 1   Unconfirmed 0   Existing 14

Added
  Window.fetch                     wrap
    Package          telemetry-agent@8.0.0
    Previous version telemetry-agent@7.3.0
    Source           instrumentation/network.ts:118 (main.35c98.js:1:184920)
    Provenance       bundled dependency · load · unconditional
    Confidence       target high · mutation high · attribution high
    Fingerprint      window|Window.fetch|wrap|pkg:telemetry-agent

Changed
  History.prototype.pushState      wrap   attribution @sentry/utils → @sentry/core
Removed
  XMLHttpRequest.prototype.send    wrap   pkg:legacy-polyfill
Notes
  EventTarget.prototype.addEventListener  reachability conditional → unconditional

Completeness   complete-with-limitations
  Known 43 · analyzed 41 · failed 0 · skipped 2 (offline)
  Limitations  unresolved-reference 1 · offline-skipped 2
Inputs
  Source maps  32 / 41 artifacts · 6 findings have Package unknown
  Lockfile     not given · versions from store paths only; Introduced by unknown
Outside scope  DOM 412 · other 9   (run with --surface all)
Ineffective writes 3               (--list-ineffective)

Gate  fail-on added,changed → FAIL (2 findings)   exit 1
```

- **Added and changed findings** get a card. `changed` cards lead with their `changedReasons` before → after. A confidence below `high` shows its reasons.
- **Introduced by** appears under the rules in §10.
- **Existing findings** are only counted, unless `--verbose` is given.
- **The Inputs block** states what each missing input costs, following the input tiers in §2.
- **Formatting.** Color is used only on a TTY, and `NO_COLOR` is honoured. No progress output is written when stdout isn't a TTY.

`monkeypatchlist explain` renders one finding: all its occurrences, each with its trace (§14).

## 16. CLI, configuration and exit codes

### Commands

| Command | Does |
|---|---|
| `monkeypatchlist scan <buildDir>` | analyzes the build, and optionally compares against a baseline and gates |
| `monkeypatchlist baseline init <buildDir>` | scans, and writes a new baseline with the whole finding set |
| `monkeypatchlist baseline update <buildDir>` | scans, prints the added, changed and removed entries it accepts (with `explainedBy`), and rewrites the baseline (§11) |
| `monkeypatchlist explain <fingerprint\|target> --report <file>` | renders one finding from a saved JSON report, with every occurrence and its trace |

No command touches the network unless `--mode resolve` is given.

### Flags

| Flag | Commands | Notes |
|---|---|---|
| `<buildDir>` | scan, baseline | positional |
| `--entry <file>[@<url>]` | scan, baseline | repeatable; defaults to `index.html` in the build directory. `@<url>` is the document's URL; it defaults to the first mapping's URL |
| `--map <urlPrefix>=<dir>` | scan, baseline | repeatable; the longest matching prefix wins |
| `--config <path>` | all | defaults to `monkeypatchlist.config.json` if present |
| `--surface protected\|all` | scan, baseline | defaults to `protected` |
| `--mode offline\|resolve` | scan, baseline | defaults to `offline` (§17) |
| `--source-maps <dir>` | scan, baseline | repeatable (§2) |
| `--lockfile <path>` | scan, baseline | sets `lockfile.path`; the importer is the config key `lockfile.importer` (§10) |
| `--baseline <path>` | scan | defaults to `monkeypatchlist.baseline.json` when `--fail-on` is given and that file exists |
| `--previous <report.json>` | scan | enables the reachability and install-context notes (§11). Used automatically when `--baseline` is a full report. Needs `--baseline`, and otherwise warns and gives no notes. Overrides a report baseline's previous values |
| `--fail-on added,changed` | scan | `removed` and `unconfirmed` can't gate |
| `--allow-incomplete` | scan, baseline | downgrades exit code 3 to a warning; lets `baseline init` and `baseline update` write; on `scan`, lets an incomplete report be read as `--baseline` (§11) |
| `--allow-downgrade` | baseline init, baseline update | |
| `--out <path>` | baseline | defaults to `monkeypatchlist.baseline.json` |
| `--json <path\|->` | scan, baseline | §15 |
| `--list-ineffective` | scan | lists ineffective-write records in the terminal |
| `--verbose` | scan | lists existing findings |
| `--no-color` | all | |
| `--version`, `-v` | alone | prints one line on stdout, `monkeypatchlist <version> · catalog <n> · analyzer <analyzerVersion>`, with the values the report's `tool` block records (§15), and exits 0. It reads no config file or build directory, and anything after it is a usage error |

### Configuration file

`monkeypatchlist.config.json` is validated by a JSON Schema that ships in the package.

- Every flag has a key: `entries` (`--entry`), `mappings` (`--map`), `sourceMaps` (`--source-maps`), `surface`, `mode`, `lockfile` (`{ path, importer }`; `--lockfile` sets `path`), `baseline`, `previous`, `failOn`, `allowIncomplete`, `json` and `verbose`. `name` has no flag.
- CLI flags override it field by field.
- JS and TS config files are never loaded: a CI gate for platform integrity must not execute its own configuration.

```json
{
  "name": "Trading Portal",
  "entries": [{ "file": "index.html", "url": "https://app.example.com/" }],
  "mappings": [
    { "url": "https://app.example.com/", "dir": "." },
    { "url": "https://cdn.example.com/assets/", "dir": "assets/" }
  ],
  "sourceMaps": ["../maps"],
  "failOn": ["added", "changed"]
}
```

**Application name.** `name` defaults to the build directory's basename. It appears in the report header and the terminal title. It is not identity.

### Scan configuration identity

The baseline header records a **scan-config id**: a hash of the fields that decide which findings can exist.

- **Included:** the entry documents (file and URL), the URL→path mappings, `--surface`, and the realm set.
- **Excluded:** the mode, source-map directories and `--lockfile`. Remote gaps already become `unconfirmed`, and those inputs are optional evidence ([ADR 0006](adr/0006-attribution-identity-ignores-optional-inputs.md)).

Scanning against a baseline with a different id is a usage error (exit 2), and it names the fields that differ.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | success: no gate, or the gate passed |
| 1 | the gate failed: a finding is in a `--fail-on` state |
| 2 | a usage or configuration error: bad flags or config, `--fail-on` without a readable baseline, a scan-config mismatch, a baseline `formatVersion` newer than this monkeypatchlist (§11), a fingerprint scheme that can't be migrated under `--fail-on` (§4), or `baseline update` over a baseline from a newer version without `--allow-downgrade`, an incomplete report as `--baseline` under `--fail-on` without `--allow-incomplete`, or a `--previous` report whose scan-config id differs. A scan against a newer baseline only warns (§4) |
| 3 | an `incomplete` scan under `--fail-on`, without `--allow-incomplete` |
| 4 | internal error |

When the scan is incomplete *and* the gate fails, the exit code is 3. The report shows both results. The wall-clock crash guard (§18) has no code of its own: it makes the scan `incomplete`.

## 17. Remote retrieval

### Modes

- **`offline`** (the default) analyzes only the supplied artifacts. Each remote reference is an `offline-skipped` limitation.
- **`resolve`** fetches remote references under the fixed safety floor below. Release 2 makes the floor configurable (§22).

### What is fetched

In `resolve` mode, monkeypatchlist fetches every remote reference that the discovery rules (§2) find, from any artifact, local or already fetched:

- cross-origin `script[src]` and `type=module`
- absolute-URL imports and literal dynamic imports
- `modulepreload` and import-map targets
- worker URLs
- injected constant `src` values
- chunk URLs that a chunk loader builds from constants

Fetched artifacts are discovered in turn, but never swept.

- **Remote source maps** referenced by a remote artifact's header or annotation are fetched under the same floor. A failure only affects counters (§13). Attribution stays on the `url:` key, and a package the map names is evidence only.
- **Data that SDKs fetch at runtime**, such as a vendor's remote config, is never fetched. That is a named limitation (§21).

**Caching.** Each URL is fetched once per scan, without its fragment. Identical bytes are analyzed once per `sourceType` and realm, and each URL keeps its own artifact record (§2). Nothing is cached across scans in R1.

### Safety floor

| Limit | Value |
|---|---|
| Schemes | `https:`; `http:` only where the referencing document is itself `http:` |
| TLS | verified, with no override |
| Addresses | refused: loopback, private, link-local, ULA, CGNAT, multicast, cloud-metadata, and IPv4-mapped equivalents. The check runs on the resolved IP at connect time, which stops DNS rebinding |
| Redirects | at most 5, and every hop is re-checked against the whole floor. A sixth redirect, or a loop, is refused |
| Size | 20 MB per response and 100 MB per scan, decompressed |
| Time | 10 s to connect, 30 s per request, and 5 min for all fetches in a scan |
| Requests | `GET` only, with `User-Agent: monkeypatchlist/<version>`; no cookies, auth headers or conditional requests; `gzip` and `br` accepted |
| Proxies | `HTTPS_PROXY` and `NO_PROXY` are honoured; credentials only in the proxy URL the user set |
| Count | at most 500 remote fetches per scan (distinct URLs, without their fragment) |

**Content types.** monkeypatchlist fetches what the browser would execute:

- Module scripts, HTTP(S) worker scripts and dynamic imports need a JavaScript MIME type.
- Classic scripts are accepted unless the browser would block them: an `image/*`, `audio/*`, `video/*` or `text/csv` type, or a non-JS type with `X-Content-Type-Options: nosniff`.
- Maps are read as JSON whatever their type. They are fetched only after every script fetch, and count toward the caps and budgets, but never displace a script. A remote script's map that is refused, fails, or can't be read changes counters only, never completeness.

The checks run in the browser's order for each destination: blocked types and `nosniff` first, then integrity, then the JavaScript MIME requirement for modules, workers and dynamic imports.

**Outcomes** (§13):

| Outcome | Kind | Level |
|---|---|---|
| A scheme, address, size, count, redirect or content-type refusal | `remote-refused` | limitation |
| A timeout (per request or scan-wide), DNS or TLS error, or a non-2xx response | `fetch-failed` | incomplete |
| An integrity mismatch | `sri-mismatch` | incomplete |

A baseline finding with `remote` provenance that is missing from a scan which skipped or refused any remote script is `unconfirmed`, not `removed` (§11).

### Integrity

An `integrity` value, on the element or in an import map's `integrity` section, is verified against the fetched bytes. That includes a value code sets on a chunk's or injected script's element (`o.integrity = u[a]`, with `u` a constant table) when it folds to a constant: the reference carries it, and a mismatch gives `sri-mismatch`, with that chunk's bytes withheld. A value that doesn't fold counts as none. A value that folds to several constants (`s.integrity = legacy ? 'sha384-A' : 'sha384-B'`) is checked against each (Principle 3): the bytes pass when they match any alternative, and give `sri-mismatch`, with the bytes withheld, when they match none. `sha256`, `sha384` and `sha512` are supported, and the strongest algorithm present is used, per the SRI spec. On a mismatch, the bytes are not analyzed and both digests are recorded. With no integrity value, the report records `sri: none`. CORS is not modelled: a cross-origin script with `integrity` is checked and analyzed even without `crossorigin`, although a browser would block it (§21). A URL is read once per realm, so when one reference fails its integrity check, the bytes are withheld for every reference to it in that realm (§21).

### What is recorded

- **Per artifact:** `retrieval { status, requestedUrl, finalUrl, contentType, sri }` and the content hash (§15).
- **In the `run` block:** retrieval time, ETag and Last-Modified. They are wall-clock facts, kept out of the deterministic report.

The attribution key and the origin come from the **requested** URL, not the final one after redirects. Code that a redirected script references is keyed from the referencing script's requested URL (§11).

A `resolve` scan is deterministic only when the remote bytes are. A floating vendor URL that serves new code shows up as ordinary `added` or `changed` findings, which is the change governance the gate exists for.

## 18. Performance budget and analysis cost

**R1 ships with its measured cost**. Step 1 below gained only 1.1–1.5×, leaving R1 about 30× over the time target and 11× over the heap target, and step 2 applies only to a miss under 2×. So R1 publishes the cost it measures (the benchmark's worst case per MB and heap per source byte, recorded here and in the docs' limitations) instead of meeting the target below, and the native analyzer (step 3) is the next release's route to it. No result changes to save cost (North star).

**Measured cost, R1.** Analyzer js-98 (the frozen resolver), catalog 1, measured on an Apple M4 Pro (12 CPUs, 24 GiB, Node 26.8.1) with the machine otherwise idle, not on the reference runner below.
- **Worst time per MB, corpus artifacts over 10 KB:** 860 s/MB (`variants/features-on/dist/webpack/core-js--members/nomaps`, 60 s for 70 KB). Over all corpus artifacts the worst is 1,907 s/MB (`dist/webpack/promise-polyfill/nomaps`, 8.7 s for 4.6 KB); below about 10 KB, per-scan overhead dominates.
- **Worst heap per source byte, corpus link groups over 10 KB:** 32,603× (`variants/features-on/dist/vite/core-js/maps`, 2.3 GB peak). Over all SDK link groups the worst is 59,756× (`dist/webpack/promise-polyfill/nomaps`, 272 MB peak). The inline fixture pages of under 100 bytes read up to 92,879× (2 MB over 21 bytes), which is per-scan overhead, not analysis cost.
- **Scale fixture:** 1 MB (40 members, 1.043 MB), 341 s/MB (356 s) and 4,316× (4.5 GB peak). The larger builds date from analyzer js-73 and were not rerun. 2.5 MB, about 9.7 h (roughly 14,000 s/MB; heap not recorded). 5 MB, not measured: the run was stopped after about 1 h.
- The step budget never fired on the corpus or the 1 MB build. The closest link group, `dist/webpack/promise-polyfill/nomaps`, used 77% of its budget (14.4 million of 18.7 million steps); every other used under 19%. Budget variance is measured separately.

**Target.** 10 MB of uncompressed JavaScript per scan, with link groups up to 5 MB, on an 8 GB, 2 vCPU runner (the common hosted CI size). Concretely:

- ≤ 10 s/MB on every validation-corpus artifact, the worst case included
- ≤ 400× peak heap per source byte per link group, so a 5 MB group fits in 2 GB
- zero variance caused by budgets across the corpus: no result a budget or cap changed, measured against raised-cap reruns. Each corpus site is rescanned once per cap with that cap alone ×4, and once with `depth` and `contexts` together ×4, each rerun with the step budget ×64 so that it can't fire, all injected through the scan's deps and never a user flag. Any difference in fingerprint set, effect, `locks` or completeness level from the shipped scan is variance, and the bar stays zero. So the step budget may never fire on the corpus, and no cap constant may be lowered below the point where it changes a corpus result Where a cap's ×4 rerun can't run within the measuring machine's memory, a ×2 rerun of that cap with zero variance counts, and the benchmark report names each such rerun.

The target is measured on cold scans, at 1, 2.5 and 5 MB, on a synthetic scale fixture: one app shell that bundles all the corpus SDKs, split into chunks. It is an **acceptance criterion of the implementation phase** (§20). It is not met by the prototype, which is about 880× on heap and 4–27× over on time for its worst library, so it is a **named risk**. Handing off the spec with this risk open is accepted: the fallback order below and the permitted native analyzer are the plan.

**Budgets are deterministic.**

- Each link group has a step budget, scaled with the group's size: steps per source byte of its members, times a constant set with margin over the corpus and the scale fixture. It depends only on bytes, so it stays deterministic. Exhausting it reports the findings from completed work, raises `analysis-budget` naming the artifacts, and makes the scan `complete-with-limitations`. Completed work is counted by write: the budget is checked between writes in walk order, and a write is reported only if its resolution finished inside the budget, so every reported occurrence (target, effect, confidence, trace, lookup) is byte-identical to the unbudgeted run's.
- No wall-clock limit may change results. A wall clock is only a crash guard.

**Context policy, stated as requirements.** The constants are implementation detail, tuned on the corpus. The requirements are:

- Results are independent of visit order and wall-clock time.
- A call that carries a native holder or member is never merged into another call's context before any other call is.
- Depth limits defer calls, never drop them. A call that carries the global object, a native holder or a native function, judged in its real caller frames, is exempt from the depth cap: it keeps being instantiated past it, after the other work, and only the step budget bounds it. Recursion still widens, and a recursive call that carries a native raises `analysis-budget`; a native that arrives only through the recursion is judged by the carrying check and not reached, so the write gives an `unresolved-holder` record or no finding.
- R1 ships the `depth` cap at 24 (was 6) and the `contexts` cap at 256 (was 64). The corpus results converge there: raising both ×4 again (×16 in all) changes nothing more, at a cost of about +5% time on core-js. Below these values a call widened past depth 6 or a merged context changed about 130 core-js results per bundler. The raise lands only after the resolver defect that gives `add` findings on `.undefined` targets (`Array.prototype.undefined`) in frames past depth 6 is fixed: they are false positives. Raised together, the two caps make the analysis of some corpus sites (webpack New Relic, promise-polyfill) grow 22–68× and exhaust the step budget, so a performance fix for that interaction lands first, timeboxed to about a day. If it doesn't land in time, R1 raises `stepsPerByte` instead, so no result is lost to the budget, at the cost of much slower scans of those sites. The performance fix landed in time: webpack New Relic fell from 572 s to 65 s at 24/256, with results identical to the step budget ×64 run. webpack promise-polyfill still exhausted its step budget at 24/256 for a separate reason (the frames of one recursion are found again, provisionally, for each heap instance), so R1 also takes the fallback: `stepsPerByte` is 4096 (was 1024), and the step budget fires on no corpus site. promise-polyfill uses about 77% of its budget and scans in about 8 s instead of 3 s, and no corpus result changes.
- Caps are deterministic and reported in scan statistics. Every cap hit is counted. That includes `candidateRuns`, `testReads`, `throwDepth`, `flagDepth`, `aliasDepth`, `heapDepth`, `nesting` and the heap's write-back depth limit, each counted in `statistics.caps`. A `candidateRuns` cut of a write's candidate sites raises `analysis-budget` when they carry the global object, a native holder or a native member (Principle 5), and is otherwise counted. No value cap drops a native holder: a capped value keeps its native holders and collapses only other values.
- A cap never silently drops native work (Principle 5). Any cap (value, fold, BigInt size, recursion, context, loop iteration, enumeration) that cuts analysis of something carrying the global object, a native holder or a native member raises `analysis-budget` naming the artifact (§13), and the work done before the cut stays. So does a recursion or context cap that widens or merges a call carrying one. A frame carries a native function when it passes the original native function value (`window.fetch` read and passed on), directly or as a member value, so a widened or merged frame that passes one raises `analysis-budget`; the same test decides which frames a context merge keeps apart. This lands with the `depth` and `contexts` raise above. Any other cut is only counted.
- Enumerating a native holder's catalog keys isn't capped, because the catalog bounds it (§5 capability 9). Loops over lists the code builds keep the iteration cap, except catalog-bounded lists (§5 capability 9).

Identity invariance across bundlers (§20) is the hard test of the policy.

**Parallelism.** Link groups run one after another by default. Workers run only while their estimated peak heaps fit the memory budget, and results merge in a fixed order. A 1-worker and a 4-worker run must produce byte-identical output.

**If the target is missed**, the options are tried in order:

1. Optimise in JavaScript: context sensitivity only where arguments carry natives, compact values, and releasing a pass's contexts. Here a call keeps its own context when any of its arguments flows, in the callee's summary, into the holder, key, value or descriptor of a write or guard that reaches the global object or a native holder, so `patch('fetch'); patch('open')` over a closed-over `window` keeps its exact findings. Principle 5's "carries" is unchanged. This step must be semantics-preserving: every corpus report and the scale fixture keep the same findings, fingerprints, attribution keys, confidence, reachability and completeness level, and only statistics and `analyzerVersion` may differ.
2. If the miss is under 2×, per-artifact export summaries composed at link time (the fallback in [ADR 0010](adr/0010-module-links-cross-the-chunks-of-one-build.md)). They are prototyped and measured first, and the cost and the full list of finding diffs go to the maintainers, who decide before R1's resolver switches to them. Here the scores must not drop.
3. Otherwise, a native analyzer. It is **permitted** as a prebuilt napi module behind the resolver seam (§19), still installed from npm. The TypeScript/Node lock covers the CLI, orchestration and distribution.

**No analysis cache in R1** ([ADR 0001](adr/0001-committed-json-baseline-no-sqlite.md)). Per-artifact analysis is a pure function of (artifact bytes, catalog version, analyzer version), so a cache can be added in a later release.

## 19. Module interfaces

These modules follow the product brief's rule that parsing, resource resolution, catalog generation, attribution, fingerprinting and policy stay separate. This section states each module's contract, what it produces and what it must not know. The two swappable seams, resolver and binding resolution, also get typed sketches. Every other signature is implementation detail.

### Pipeline

| # | Module | Consumes | Produces | Must not know |
|---|---|---|---|---|
| 1 | **config** | CLI flags, `monkeypatchlist.config.json` | a validated `ScanConfig` and the scan-config id (§16) | anything about artifacts |
| 2 | **source store** | local files; the `Fetcher` | artifact bytes by URL, retrieval records, `run`-block timings | JavaScript semantics |
| 3 | **discovery** | entry documents, mappings, source store | the artifact graph (§2) and map pairings | resolver semantics; it parses syntax only |
| 4 | **analysis** | link groups, the catalog, a budget | occurrences, ineffective writes, limitations, `references[]` | source maps, packages, the baseline, `--surface` |
| 5 | **attribution** | occurrences, paired maps, `--lockfile` | attributed occurrences (§10) | how a target was resolved |
| 6 | **findings** | attributed occurrences, the catalog | findings with fingerprints and target keys (§11), the confidence roll-up (§9), the `--surface` filter (§12) | the baseline |
| 7 | **compare** | findings, a baseline or previous report | baseline states, `changedReasons`, notes (§11) | the policy |
| 8 | **policy** | compared findings, `--fail-on` | the policy slot and the gate result (§15) | rendering |
| 9 | **report** | everything above | JSON, terminal and `explain` output (§15, §16) | nothing is recomputed here |

The **catalog** is not a stage. It is read-only data that discovery (realm globals), analysis and findings (surfaces) read. The **catalog generator** is a build-time tool in the repository. It is never published, and the runtime never reads `@webref/idl` or ECMA-262.

### Invariants

- **Purity.** Every module after the source store is a pure function of its inputs. None reads the clock, the environment, the filesystem or the network. Wall-clock data reaches only the report's `run` block, from the source store and the CLI. This is what the determinism promise (§15), 1- vs 4-worker identity (§18) and a later analysis cache (§22) rest on.
- **Failures are data.** A module reports parse, fetch, pairing, SRI and budget failures as §13 limitation records in its return value. No module decides `incomplete` itself: one **completeness aggregator** applies the §13 rules to every record. An exception means an internal error (exit 4).
- **Serializable seams.** Everything that crosses the analysis seam is plain JSON-serializable data, so it can cross a worker boundary (§18) or a napi boundary.

### Source store and retrieval

The source store is the only module that reads bytes. It reads local files through the URL→path mappings, and remote URLs through a **`Fetcher`**:

| Fetcher | Behaviour |
|---|---|
| offline | every call returns `offline-skipped` (§17) |
| resolve | the §17 safety floor, entirely inside this fetcher: schemes, address checks, redirects, caps, content types, SRI |
| fixture | serves recorded responses, for tests |

The Release 2 configurable floor (§22) changes only the resolve fetcher's construction.

### Discovery

Discovery parses HTML with **parse5** and JavaScript with `oxc-parser`, for syntax only. It finds literal references: script elements, import maps, `modulepreload`, static and literal dynamic imports, literal worker URLs and literal `importScripts`. It then sweeps and pairs source maps (§2). Map pairing and token checks read maps with **`@jridgewell/trace-mapping`** (`FlattenMap` for sectioned maps). `debugId` and `sourcesContent` are read from the map's raw JSON.

**HTML rules.** They follow what a current browser executes:

- The first `<base href>` sets the base URL for resolving references.
- A `script` is analyzed when it has no `type`, a JavaScript MIME type, or `type=module`. `type=importmap` is read as an import map. Every other type is ignored.
- `<script nomodule>` is not followed as a reference. It is counted (`nomodule`) and is a named limitation (§21). A local file it names is still swept (§2). Whether it runs is a runtime-profile question for Release 2.
- Inline event-handler attributes (`onload="…"`) and `javascript:` URLs are not analyzed. They are counted (`inlineHandlers`) and are a named limitation (§21).
- The contents of `<template>`, `<noscript>` and `iframe srcdoc` are ignored.
- `<link rel=preload as=script>` is a reference hint: the file joins the artifact graph, but a preload alone never makes it execute.

**References only the resolver can see.** An injected `script.src`, a worker URL built with `new URL(x, import.meta.url)` from a folded `x`, and chunk URLs a chunk loader builds from constants all need constant propagation. The resolver returns them as `references[]` records (URL, kind `injected | worker | chunk`, source location). The scan runs in **rounds**: discover, analyze the new link groups, take the new references, discover (and in `resolve` mode fetch) them, analyze again. It stops when a round adds no artifact. Each round is processed in URL order. The §17 caps bound the loop in `resolve` mode. A worker's realm comes from its reference (§2).

**The result doesn't depend on the rounds.** The output equals analysing, over the final artifact set, every referenced entry's group, and then each swept artifact that no group links. So:

- a group is re-analysed when a round adds an artifact it links, fetched remote chunks included, and only its last analysis counts
- swept artifacts that no group linked are analysed only after the reference rounds reach a fixpoint. If they add references, rounds resume, and a swept artifact that has since been linked or given a realm by a reference is dropped as a standalone group. A file therefore never gives findings both as a standalone assumed-`window` sweep and as a worker. A module that a standalone swept file imports is still analyzed in that file's group, in its assumed `window` realm with `realm-assumed`, even when a reference gives the module another realm

### Analysis: the resolver seam

The **resolver seam** sits at bytes, not at the AST, so that a native analyzer (§18) replaces one module and nothing else. The JS resolver parses and scopes internally. Discovery's syntax-only parse is a second parse, which costs about 0.4 s per 9 MB, and only in the JS implementation.

```ts
interface Resolver {
  readonly analyzerVersion: string
  analyzeGroup(input: {
    entry: ArtifactRef                     // url, hash, sourceType, realm
    artifact(url: string): ArtifactSource | undefined   // synchronous; the build's artifacts and fetched remote artifacts in this realm
    catalog: SerializedCatalog             // the catalog JSON
    budget: { steps: number }
  }): {
    members: ArtifactRef[]                 // the group's actual members (§6)
    occurrences: RawOccurrence[]
    ineffectiveWrites: IneffectiveWrite[]  // §3
    limitations: Limitation[]              // §13
    references: DiscoveredReference[]      // injected | worker | chunk
    moduleLinking: Record<url, ModuleLinking>
    stats: { steps: number, caps: Record<string, number> }
  }
}
```

**Link groups.** Discovery hands the resolver one group entry at a time. The resolver pulls in what it links and reports the group's members. Groups run in this order:

1. every HTML-referenced entry, in URL order, except an HTML-referenced script that another entry's group links through a chunk registry (§6)
2. then each swept artifact that no group linked, as its own group

A swept chunk, or an HTML-referenced initial chunk, that some group linked is **never also analysed on its own**. On its own, its factories have no caller, so it would be judged from creation sites and could report different reachability for the same fingerprints. A chunk linked by several groups is analysed in each, and findings merge by fingerprint (§6).

**Raw occurrences.** The resolver owns these fields, and no later module changes them:

- generated location: artifact, UTF-16 range, line and column (§5)
- for a write inside a helper, the location of the call that attribution looks up (§10)
- target, effect, mechanism, `locks`
- reachability and its basis, install context, and realm instance
- target and mutation confidence reasons (§9)
- trace steps (§14), except `token-check` and `path-rule`

Code from a literal `eval`, `new Function` or string timer is analysed inside the resolver and located in its host artifact.

**One resolver per release** ([ADR 0018](adr/0018-one-resolver-implementation-per-release.md)). Each monkeypatchlist release ships exactly one resolver implementation, and the report records `tool.analyzerVersion`. There is no fallback between a native and a JS resolver. A missing platform binary is an internal error (exit 4) that names the supported platforms. Changing the implementation is at least a minor release, and it must meet identity invariance on the corpus (§20).

### Binding-resolution seam

This seam sits inside the JS resolver, between parsing and monkeypatchlist's own scope rules:

```ts
interface BindingResolver {
  resolve(program: OxcProgram, sourceType: 'script' | 'module'): {
    reference(id: IdentifierNode): { declaration: DeclarationNode, scopeKind: ScopeKind } | 'unresolved'
  }
}
```

`eslint-scope` (`optimistic: true`) is the implementation. `@typescript-eslint/scope-manager` is a verified drop-in. The four post-passes in §5 (script-global `var`/`function`, Annex B, `with`/eval taint, unqualified `delete`) run **above** the seam, so swapping implementations never touches them. Conformance: both implementations give identical findings on the validation corpus.

### Attribution

Attribution adds these fields to each occurrence, and never changes the resolver's:

- original location
- attribution key, provenance, containing package, `vendoredBy`, `workspace`
- `introducedBy[]` (with `--lockfile`)
- attribution confidence reasons
- `token-check` and `path-rule` trace steps

### Findings

Findings computes the fingerprint and target key (§11), merges occurrences by fingerprint across link groups, and rolls confidence up (§9). It applies `--surface` (§12) to findings, to `ineffectiveWrites[]`, to `unresolved-holder` records and to the out-of-scope counts. Analysis returns an `unresolved-holder` record's candidates as data, and this stage filters them. The fingerprint is computed here because this is where occurrences merge.

### Catalog as data

The runtime catalog is **one merged JSON file per catalog version**. The generator produces it from the pinned upstreams and the overlays, it is committed, and CI checks it for drift (§4). A JSON Schema ships with it. The overlays exist only as generator inputs. The merged file keeps them as **named sections**, so a diff shows what changed in each:

- targets and member data, per realm
- platform singletons and alias groups
- surfaces, the owner → surface map and the **protected-surface list** (§12)
- exclusions
- retained targets
- catalog metadata: every upstream pin

JSON crosses the napi seam without a separate format.

### Packaging

- One published npm package, `monkeypatchlist`: the CLI, every module, the catalog JSON, and the JSON Schemas for the report, config and catalog.
- The catalog generator is in the repository and never published.
- A native analyzer, if one ships, comes as per-platform packages in `optionalDependencies` (the esbuild and Oxc pattern).
- `parse5`, `@jridgewell/trace-mapping`, `oxc-parser` and `eslint-scope` are exact-pinned, because patch releases must reproduce corpus output byte for byte (§4).


## 20. R0 acceptance criteria and validation corpus

The R0 bar is the **acceptance criterion of the implementation phase** ([ADR 0016](adr/0016-r0-bar-is-an-implementation-acceptance-criterion.md)). The production resolver is accepted when, frozen, it meets every bar below on the validation corpus, and the holdout-precision bar (≥ 0.90) on the sealed holdout, where recall is reported with no bar. The prototype resolver this spec was drafted against is evidence only.

### Validation corpus

The corpus is public, reproducible byte for byte (`npm run verify`), and ground-truthed at runtime.

- **Sites.** 17 apps are built by webpack 5, esbuild (IIFE), Rollup 4 (ESM) and Vite 8 (Rolldown), each with and without source maps: 136 build directories. Add 4 vendor CDN sites (Sentry, Datadog, New Relic and Application Insights, with the lazy chunks their loaders fetch vendored and hash-pinned) and 1 empty control, for 141 sites in all.
- **Libraries.** Sentry 7, 10 and 11, and Sentry 11 without Replay; Datadog RUM and logs; New Relic; OpenTelemetry; Application Insights; zone.js; core-js; whatwg-fetch, promise-polyfill and es6-promise; single-spa; Clarity.
- **Negatives.** Segment, OTel document-load and the control.
- **Ground truth.**
  - A Chromium harness diffs a pristine snapshot of the window realm's native holders against the state after load, one interaction and teardown.
  - Each library's (target, effect) set is identical across its bundlers and its CDN build.
  - Mutations the runtime can't observe (polyfill branches, config-gated paths) are hand-labeled with citations.
- **Exercise variants** ([ADR 0009](adr/0009-findings-claim-static-capability.md)) confirm code the base run never executes:
  - **features-on**: off-by-default options enabled
  - **lazy-chunks**: lazy chunks loaded
  - **native-absent**: a hand-curated, cited list of natives deleted before load

  A finding observed in any variant is runtime-confirmed. What no variant reaches is hand-triaged `unobserved-real`, with a citation.
- **Version pairs.**
  - Sentry 7 → 10 → 11 has identical (target, effect) sets: a no-change pair, with only attribution moving from 7 to 10.
  - Sentry 11 without → with Replay adds 20 targets.
- **Fixture pages.** One Chromium page for each cell of the write-outcome table (§3) and each restore idiom, snapshotted after install and after teardown.
- **Sealed holdout.** `@bugsnag/browser` 9.0.0, `@elastic/apm-rum` 5.17.5 and `@openreplay/tracker` 18.2.0 are built by the same 4 bundlers × maps/nomaps. None of them is in the corpus or the idiom survey. They are encrypted at rest with a recorded root hash.
- **Worker realms** are not covered.

### Scoring rules

- **Scoring unit.** Scores are macro-averaged per library, with equal weight. Each library's set is scored per build directory, then averaged. zone.js's `__zone_symbol__*` pattern wildcard is one group; it is outside the protected surface (§12), so the rule only applies to the whole-catalog report. zone.js's named adds on whole entries (`XMLHttpRequest.prototype.__zone_symbol__open`) are protected, like any named add. Micro totals are reported for information.
- **Slice.** Every bar is judged on the **protected surface** (§12). The whole catalog is reported, with no bar. The fixture-page bar is the exception: each page is scanned with `--surface all` and every expected row is compared, so that bar is judged on the whole catalog.
- **Positive set.** Runtime ground truth, plus runtime-confirmed variant findings, plus the hand labels, all restricted to catalog targets.
- **True positives.**
  - A finding is a true positive when its **target** matches, realm and holder included.
  - A wildcard is a true positive when it matches at least one positive of its library. It earns recall only for a group it covers in full.
  - A finding that can only run where a native is missing is a true positive when it is tagged `guarded-native-absence` or `conditional`.
- **Precision** is reported twice: runtime-confirmed only, and including counted relabels. The bar is judged on the second. Every relabel that turns a false positive into a true positive needs a source citation.
- **Triage.** Every disagreement on the protected surface gets exactly one class, with a code citation, recorded in `corpus/labels/adjudications.json`:
  - `resolver-defect`
  - `ground-truth-error`
  - `unobserved-real`: code no variant can reach
  - `beyond-model`: a named known limitation in §21
  - `boundary`
- **Reachability labels** come from the variants. A finding observed only in the native-absent run is `guarded-native-absence`. One observed only with features on or lazy chunks is `conditional`. A hand sample of about 5 observed true positives per library settles `unconditional` versus `conditional`. A rule-corrected hand label with a citation beats a derived label.

### Bars

| Metric | Bar (protected surface) |
|---|---|
| Precision, macro | ≥ 0.95, and no library below 0.90 |
| Observed recall, macro | ≥ 0.80 **in each bundler's builds separately** |
| Hand-labeled recall | ≥ 0.95 |
| Headline set: `Window.fetch`, `XMLHttpRequest.prototype.open/send`, `History.prototype.pushState/replaceState` (or their shadowing forms) for Sentry, Datadog and OTel | 100% |
| Effect accuracy on true positives | ≥ 0.90 |
| Reachability accuracy on true positives, scored per build | ≥ 0.90 |
| Negatives | 0 protected findings |
| Holdout precision | ≥ 0.90 (recall reported, no bar) |
| Identity invariance | zero variance (below) |
| Fixture pages (write outcomes, restores) | every page passes, on the whole catalog (Slice) |
| Cost | R1 ships with its measured cost, published in §18 and the docs' limitations; the target in §18 is not an R1 bar |

Three more rules apply:

- A mutation observed in Chromium must never be `guarded-native-absence` for a guard on a feature Chromium has.
- Application Insights' `fetch` and `history` are excluded from the headline set.
- Application Insights' CDN misses that need its loader snippet are a named limitation.

**Identity invariance** is zero-tolerance. For each library, every pair of its bundled builds is compared: the 4 bundlers × maps/nomaps. **CDN builds are not in these pairs**: a CDN script keys `url:` and a bundled build keys `pkg:`, so switching between them really is a change of attribution and is correctly `changed` (`attribution`). CDN ↔ bundled differences are reported per library with set invariance.

- A protected target found by both builds of a pair has the same `(realm, target, effect, locks)`.
- When both builds have the same map status, it also has the same fingerprint, except that the attribution key may move `pkg:` ↔ `unknown` (`existing` + `rekeyed`), and except the esbuild composed-map cases §21 names.
- A simulated baseline diff of the pair gives zero `changed`.
- Across maps and nomaps, the attribution key may move `pkg:` ↔ `unknown` (`existing` + `rekeyed`).

**Set invariance** is reported per library and per bundler, with no bar. Every target that one build finds and another misses is named in §21. Reachability and install-context variance, and basis moves, are also reported with no bar.

**A miss.** Every bar in the table blocks acceptance, except recall and, in R1, cost:

- A precision or identity-invariance miss blocks acceptance. The fix is in the resolver, or the false-positive source is suppressed. The builder fixes the resolver where the spec already covers the case. Any suppression rule (a pattern, package, guard shape or target class whose findings stop being reported) goes to the maintainers, with the findings it removes across the corpus and the libraries it affects.
- A recall miss either adds a capability, or narrows the claim with a named limitation in §21 that lists the libraries it costs. A capability is tried first. A new §21 limitation, for a recall miss or for a `beyond-model` class no existing entry covers, goes to the maintainers, with the libraries it costs and the targets lost per bundler, and they accept it or reclassify it `resolver-defect`.
- R1 ships with its measured cost (§18), so a cost miss doesn't block R1's acceptance. The order in §18 is the route to the target after R1.
- A miss on any other bar (headline set, effect or reachability accuracy, negatives, holdout precision, fixtures) blocks acceptance until fixed in the resolver or the oracle.

### Procedure

1. **Oracle.** Regenerate all ground truth once with the harness's effect rule ([ADR 0011](adr/0011-effect-follows-the-value-not-the-attributes.md)) and the WindowProperties snapshot. Revise the fixture table to the outcome table in §3.
2. **Holdout variants.** Build the holdout's exercise variants in a session that never touches the resolver, then re-seal.
3. **Score and triage.** Score the corpus and triage every protected disagreement, with citations.
4. **Freeze.** The maintainers freeze the resolver, and the freeze is recorded as a hash.
5. **Holdout.** Unseal, regenerate the holdout's ground truth with the step-1 harness, and score. Nothing is tuned after unsealing.

## 21. Known limitations

Collected from every section. The **acceptance slot** at the end is filled during implementation, when acceptance (§20) names each set-invariance difference and `beyond-model` class.

**Catalog**

- **Interfaces `@webref/idl` lacks aren't catalogued**, except `HTMLDocument`. About 48 interfaces that some engine ships (`SharedStorage`, `WebSocketStream`, `ReportBody`, `FeaturePolicy`, `StyleMedia`, and Firefox- or Safari-only ones) have no targets, so writes to them give nothing. A curated overlay can add them in a later release. (§4)

- **core-js's well-known-symbol store isn't resolved.** core-js's `wellKnownSymbol(name)` and its DOM-collections `@@iterator` loop give no `@@iterator` or `@@unscopables` findings in R1. Chromium makes none of those writes, and resolving them would cost analysis caps and add pattern-wildcard false positives. (§5)

**Discovery and linking**

- **Scripts of one page are not linked** ([ADR 0015](adr/0015-global-links-are-deferred-to-r3.md)). An SDK started by a loader snippet or inline call is judged from its creation sites, without the snippet's config. Its reachability and install context can differ from the same SDK bundled with its init call. Writes that resolve only through the snippet's call are missed. Application Insights' CDN build (7 targets) is the known case. (§6)
- **Unrecognized module runtimes degrade silently.** Only the six idioms are promised, and conformance is tested against the pinned corpus bundlers. (§6)
- **No evaluation-order modelling** between classic scripts. Patch-shaped writes through an alias carried from one classic script to another (`var g = window` / `g.fetch = wrap(g.fetch)`) become `unresolved-holder`. A plain replace through such an alias (`g.fetch = w`) is missed. (§3, §5)
- **URLs computed at runtime are never guessed.** Non-literal references, worker URLs and injected `src`s are limitations. (§2)
- **Scripts written by `document.write` or `createContextualFragment` are not followed.** Only a created script element that an insertion method inserts is an injected reference. (§2)
- **Sweep-only artifacts are assumed to run in `window`** unless worker markers are present. (§2)
- **`<script nomodule>` and injected `noModule` scripts are not followed**, so a remote legacy bundle that only older browsers run is counted, not scanned. A local one is found by the sweep and scanned as a sweep-only artifact with an assumed realm. An injected script element whose `noModule` is set is handled the same way. (§2, §19)
- **`.constructor` through a `const` alias is not shown.** `const K = class {}; K.constructor(s)` raises no `dynamic-code`, so a scan whose only string-compiling route is such an alias reads `complete`. Following the alias needs value tracking after R1. (§2)
- **Inline event-handler attributes and `javascript:` URLs are not analyzed**, only counted. The contents of `<template>`, `<noscript>` and `iframe srcdoc` are ignored, though the sweep still finds a local file that a `<script src>` there names. (§2, §19)
- **Web IDL iterator prototype objects are not catalogued.** The per-interface iterator prototypes that `iterable` declarations create (the "Headers Iterator" prototype and its `next`) are reached only through ordinary instances, so writes to them give nothing. (§4)
- **A failed inline module's dynamic imports stay in the resolved module set.** Chromium never resolves them, because the module never runs, so a later import map could remap them there but not here. (§2)
- **Freezing a native holder is not recognized.** `Object.freeze`, `Object.seal` and `Object.preventExtensions` of a native holder (as SES `lockdown()` does) give nothing in R1. Reporting them needs a holder-level effect, a Release 2 seam. (§3)
- **CORS is not modelled.** A cross-origin `<script integrity>` without `crossorigin` is analyzed when its digest matches, although a browser blocks it. (§17)
- **One read per realm and URL.** When one reference to a URL fails its integrity check and another reference the browser still runs doesn't, the bytes are withheld for both, and the scan is `incomplete` with an `sri-mismatch` record. (§17)
- **Worker realms** are specified, but their recall is not validated: the corpus snapshots only the window realm. (§20)

**Detection**

- **Unknown holder, known member** is never a finding, only an `unresolved-holder` limitation. Examples: accessor helpers (Application Insights ts-utils), heap-stored API objects (New Relic and zone.js `api.*`), prototype walks from an unresolved object. (§5)
- **Members under a wildcard** aren't named individually. (§5)
- **Writes where neither holder nor member resolves** produce nothing, and are not counted. (§5)
- **A closure passed to a helper by name doesn't keep its creation bindings.** A closure written inline as the argument (`helper(() => {…})`) runs in the frames of the function that made it. One passed by name (`const cb = () => {…}; helper(cb)`) is analyzed without them, so a write that depends on those bindings can stay a wildcard.
- **A folded test inside a summary doesn't drop its arm.** Reaching definitions keep an `if` arm whose test folds to a constant for some call, and a summary's returns are united across its `return`s. So core-js's V8 define-bug branch (`"prototype" === key`) stays live in Rollup builds, and its 16 targets carry an extra `descriptor-change`.
- **Unnamed callees outside module-linking artifacts aren't followed.** Outside an artifact that links modules, a call whose callee the syntax doesn't name (`obj[k](…)`, `f()(…)`) is followed only when the callee is a parameter of the function around it, read by name (§5 capability 3, callback invocation). Any other such call's result stays unknown. So zone.js's `__zone_symbol__*` writes, whose keys its `__symbol__` helper builds through such calls, give pattern wildcard `replace` findings (`XMLHttpRequest.prototype.*` and `EventTarget.prototype.*` on the protected surface, plus `Event.prototype.*` and `customElements.*` under `--surface all`) rather than named `add`s. A later release that follows these calls turns the wildcards into named `add`s, which show as removed plus added against a baseline. (§5)
- **A prototype change on an unresolved object is missed.** A set-prototype site, `__proto__` assigns included, has no member, so a patch that swaps in a prototype on an object the analyzer can't resolve gives no finding and no record, and Babel's `_inherits`/`_setPrototypeOf` helpers stay silent. (§5)
- **Guards that compare two resolved values don't narrow alternatives.** A test such as `CurrentIteratorPrototype !== Object.prototype`, or one that a property's value isn't the native, is never decided, so the arm it would exclude stays reachable and its writes are reported. core-js gives two such targets in all four bundlers: `Object.prototype.*` (`internals/iterator-define.js`, whose `!== Object.prototype` test excludes the `Object.prototype` that `getPrototypeOf`'s shim alternative returns) and `Promise.sham` (`internals/export.js`, whose sham line runs only when the target property is missing or forced and the source property isn't the native). (§5, §7)
- **A write that always throws doesn't prune the code around it**, so findings after it, and before a failing declaration, in a script that fails to load can be over-reported. (§3)
- **An index write on `Array.prototype` gives one finding.** In Chromium, an array-index write at or past `Array.prototype`'s length (`Array.prototype[1n] = f`, `defineProperty(Array.prototype, 0, { value: f })`) also sets `Array.prototype.length` to the index plus one. That change counts as part of the `add` of `Array.prototype.<n>`, and there is no separate `Array.prototype.length` finding. (§3, §4)
- **Firefox and WebKit behaviour** for Storage and WindowProperties shadowing writes is unverified. The rule follows Chromium, which takes the write. (§3)

**Reachability**

- **Reachability and install context can vary between builds** of the same code, when a caller resolves in one build but not another. In R1 this is a reported note, never `changed`. (§7, §11)
- **Config that SDKs fetch at runtime** (such as Application Insights' remote config) is not modelled. (§7, §17)

**Attribution**

- **esbuild composes dependency maps differently.** In esbuild `maps` builds, a helper call can be mapped to its start rather than to the member literal, which fails the ±1-line token check, and a dependency's composed source can climb into the app's `src/`. So esbuild can key `unknown` or `app:` where other bundlers key the package. The `pkg:` ↔ `unknown` moves count as `existing` + `rekeyed`. Sentry 7's timer targets and `XMLHttpRequest.prototype.send`, keyed `app:src/integrations/trycatch.ts` under esbuild, but `pkg:sentry-browser-7` elsewhere, are a known identity difference.
- **Without source maps, bundled code is `Package unknown`.** Package versions need store paths or `--lockfile`, and introducing dependencies need `--lockfile`. (§2, §10)
- **Escaped sources** in composed maps (Next, Angular Bazel) are `unknown`, except where one of the two shipped framework path rules applies. Next's `src/shared/`, `src/lib/` and `src/build/` sources and Angular 19.2.10 and earlier stay `unknown`. (§10)
- **Sources with an unrecognized scheme** (`app:`, `http(s):`, `data:`, `ng:`) are `unknown`, even when the path names a package. (§10)
- **Vendored code** is named by the package its path names, which may not be installed. (§10)
- **Scoped packages under Yarn's pnpm linker** are `unknown`, because their slug is lossy. (§10)
- **Raw U+2028/U+2029** in an artifact can shift mapped positions. (§5)

**Remote retrieval**

- **A `resolve` scan is only as deterministic as the remote bytes.** A floating vendor URL that serves new code gives ordinary `added` or `changed` findings. (§17)
- **The safety floor's caps are fixed.** References beyond the per-scan count, size or time caps are `remote-refused` or `fetch-failed`. (§17)
- **Remote source maps are evidence only.** A remote artifact keeps its `url:` key, even when its map names a package. (§17)

**Acceptance slot** (filled 2026-10-09, analyzer js-94)

- **Set-invariance differences** between bundlers, per library. (§20)
  - Protected surface: none. Datadog's webpack-only `console.*` wildcard was fixed before the freeze.
  - Whole catalog only: New Relic and Sentry 7 `document.adoptedStyleSheets` and `document.fonts.add` are found only under webpack. New Relic `Window.close` is found in every bundled build but not the CDN build.
- **`beyond-model` classes** found in triage. (§20)
  - "Unknown holder, known member": Application Insights `Window.fetch`, `History.prototype.pushState`, `History.prototype.replaceState`. 3 targets, all builds.
  - "core-js's well-known-symbol store isn't resolved": core-js `Array.prototype.@@iterator`, `Array.prototype.@@unscopables`. 2 targets, all 4 bundlers.
  - "Guards that compare two resolved values don't narrow alternatives": core-js `Object.prototype.*` and `Promise.sham`. 2 targets, all 4 bundlers.
- **Identity-invariance exemptions: esbuild composed-map cases** (§21 Attribution). 21 exempted failures, all in `sentry-7`, each from `esbuild/sentry-7/maps` paired with the Rollup, Vite and webpack `maps` builds (7 per pair):
  - `Window.setTimeout`, `Window.setInterval`, `Window.requestAnimationFrame`: keyed `app:src/integrations/trycatch.ts` under esbuild, `pkg:sentry-browser-7` elsewhere. Each has a fingerprint failure and a `changed` (`attribution`) failure per pair: 18.
  - `XMLHttpRequest.prototype.send`: under esbuild it is keyed `app:src/integrations/trycatch.ts` and `unknown`; elsewhere `pkg:sentry-browser-7` and `pkg:@sentry/utils`. One fingerprint failure per pair: 3.
  - Also allowed, not exempted: 72 same-map `pkg:` ↔ `unknown` moves in esbuild `maps` builds now count as `existing` + `rekeyed` (§20). They are 21 token-check misses (Datadog `Window.WebSocket`, `WebSocket.prototype.constructor`/`send`, `XMLHttpRequest.prototype.send`; OTel `EventTarget`/`Node`/`Window.prototype.removeEventListener`) and 51 escaped composed paths (Sentry 7 fetch/open/XHR/history/console/`addEventListener`/`Function.prototype.toString`; Sentry 10/11 `Array.from`).

## 22. Release 2 seams

R1 specifies none of Release 2, but it leaves these seams so that Release 2 needs no breaking change:

- **SARIF.** Fingerprints are stable, readable and SARIF-ready. `partialFingerprints` will carry `monkeypatchlist/v1` (the fingerprint) and `monkeypatchlistTarget/v1` (the target key, §11). The resolution trace (§14) is structured so that it maps to SARIF code flows, and each occurrence has generated and original locations.
- **Policy.** Detection and enforcement stay separate. The finding model has a **policy-outcome slot** (`allow | warn | fail | baseline`). In R1 it is `fail` on findings that trip `--fail-on`, and `null` otherwise (§15). Release 2 policy files, owners, reasons and expiring exceptions fill it from rules over the finding's observable dimensions: target, surface, effect, holder, package, provenance, `changedReasons`.
- **Runtime profiles.** The catalog records per-realm targets and keeps retained targets. A later runtime profile backed by BCD can decide which targets are native for a configured browser set, and tighten the reachability catalog check, without changing target names.
- **Footprints.** Findings carry the containing package and artifact, so aggregation by package or artifact is a pure projection of the finding list.
- **Remote retrieval policy.** The safety floor (§17) is fixed in R1. Release 2 makes it configurable.
- **Analysis cache.** Per-artifact analysis is a pure function of its inputs (§18).
- **Gating on notes.** The reachability and install-context notes (§11) are structured before → after records, so that Release 2 policy can gate on them.

import { readFileSync } from 'node:fs'

/** The kinds of global environment a target can live in (§4). */
export const realms = ['window', 'dedicated-worker', 'shared-worker', 'service-worker'] as const

export type Realm = (typeof realms)[number]

/** Where a target's property lives (§4 Targets and holders). */
export const holders = ['global', 'constructor', 'prototype', 'instance', 'namespace'] as const

export type Holder = (typeof holders)[number]

/**
 * The functional categories of targets (§12): `other` is the surface of an owner nobody has reviewed yet. Every member
 * carries one (§4 Member data). A surface is context, not identity: reassigning one explains no delta (§4).
 */
export const surfaces = [
  'networking',
  'events',
  'scheduling',
  'navigation',
  'storage',
  'crypto',
  'DOM',
  'ECMAScript',
  'diagnostics',
  'workers',
  'other',
] as const

export type Surface = (typeof surfaces)[number]

/**
 * What a target's property is:
 * - a Web IDL member: an `operation`, `attribute` or `constant`
 * - the property of a global or namespace that holds an interface object (`interface`) or a namespace object
 *   (`namespace`), whether Web IDL or ECMAScript defines it: `Window.XMLHttpRequest`, `Window.console`, `Window.Math`
 * - any other ECMAScript intrinsic's property: it holds a built-in `function`, another `value`, or is an `accessor`
 */
export type MemberKind = 'operation' | 'attribute' | 'constant' | 'interface' | 'namespace' | PropertyKind

/**
 * The kinds of an ECMAScript property, which each entry of a curated overlay of single properties gives (§4 Sources):
 * it holds a built-in `function`, holds another `value`, or is an `accessor`.
 */
export const propertyKinds = ['function', 'value', 'accessor'] as const

export type PropertyKind = (typeof propertyKinds)[number]

/**
 * A native API member. The catalog keys it by realm, then by its realm-free name, e.g. `Node.prototype.normalize`:
 * the same name in two realms is two targets.
 */
export interface CatalogTarget {
  /**
   * The interface, namespace or intrinsic whose holder the target is on. For Web IDL, its IDL identifier: `Window`
   * for `Window.fetch`, `Memory` for `WebAssembly.Memory.prototype.grow`, and for a platform singleton's own member,
   * the interface that declares it: `Location` for `location.href`. For ECMAScript, the intrinsic's path: `Array` for
   * `Array.prototype.map`, `Intl.DateTimeFormat` for `Intl.DateTimeFormat.prototype.format`.
   */
  owner: string
  member: string
  holder: Holder
  kind: MemberKind
  /**
   * The spec shortname whose IDL declares the member, or, for a Web IDL `interface` and `namespace`, the definition;
   * `ecma262` or `ecma402` for an ECMAScript intrinsic; for an ES addition, the spec its overlay entry names; for an
   * engine extension, the engine its overlay entry names (`v8`).
   */
  spec: string
  /** The interface mixin the member reached its owner through. */
  mixin?: string
  /**
   * For a data property whose value is itself a holder, that holder: `Window.XMLHttpRequest` holds the
   * `XMLHttpRequest` interface object, `Window.Window` the `Window.Window` one, `WebAssembly.Module` the
   * `WebAssembly.Module` one, `Window.console` the `console` namespace, `Window.Promise` the `Promise` constructor, and
   * `Array.prototype.constructor` holds `Array`. An attribute never holds one: a platform singleton an attribute returns
   * names that attribute as its `via` (`Window.history` for `history`).
   */
  holds?: string
  /** The property's descriptor in the unmutated platform (§4 Member data). */
  descriptor: Descriptor
  /** For a Web IDL attribute, and only for one, what an assignment to it does (§4 Member data). */
  assign?: AssignKind
  /** Its functional category, from the owner → surface map (§12 Surfaces and data). */
  surface: Surface
  /**
   * Set on a **retained target** (§4 Catalog versions): one upstream removed, which the retained overlay keeps as it
   * was last generated. It resolves like any other target, and its findings carry `catalogStatus: retained`, which is
   * information only. The `retained` section records why it left.
   */
  catalogStatus?: 'retained'
}

/**
 * What assigning a Web IDL attribute does, which its runtime descriptor can't tell (§4 Member data):
 * - `setter`: runs the attribute's setter
 * - `put-forwards`: forwards the value to an attribute of the object it returns (`[PutForwards]`, e.g. `location`)
 * - `event-handler`: sets an event handler (an `EventHandler`, `OnErrorEventHandler` or `OnBeforeUnloadEventHandler`)
 * - `replaceable`: replaces the attribute with an own data property (`[Replaceable]`, e.g. `length`)
 * - `lenient-setter`: does nothing (`[LegacyLenientSetter]`)
 * - `readonly`: does nothing, and throws in strict mode
 */
export type AssignKind = 'setter' | 'put-forwards' | 'event-handler' | 'replaceable' | 'lenient-setter' | 'readonly'

/** A property descriptor, as the outcome table reads it (§3): data or accessor, and its attributes. */
export type Descriptor =
  | { type: 'data'; writable: boolean; enumerable: boolean; configurable: boolean }
  | {
      type: 'accessor'
      /** Whether the accessor has a setter. Without one, an assignment through it changes nothing. */
      setter: boolean
      enumerable: boolean
      configurable: boolean
    }

/**
 * An object that targets live on, named as the targets on it are prefixed: `Window` (the window realm's global),
 * `EventTarget.prototype`, `XMLHttpRequest` (an interface object), `console`, `Array.prototype`, `Math`,
 * `Intl.DateTimeFormat`, `%TypedArray%.prototype`. A `[LegacyNamespace]` interface's holders take its qualified name:
 * `WebAssembly.Module`, `WebAssembly.Memory.prototype`. A platform singleton's holder takes its canonical path:
 * `history`, `navigator.geolocation`. So do two objects named by their path from the global (§4): the realm global
 * interface's own interface object, `Window.Window`, whose `prototype` is `Window.prototype`, and `console`'s empty
 * prototype object, `console.[[Prototype]]`. An engine prototype takes its name in the engine (§4 Sources):
 * `HTMLDocument.prototype`.
 */
export interface CatalogHolder {
  kind: Holder
  /**
   * The interface, namespace or intrinsic the holder belongs to. For Web IDL, its IDL identifier: `Memory` for
   * `WebAssembly.Memory`, and `History` for the `history` singleton, a `History` instance. For ECMAScript, the
   * intrinsic's path: `Array` for `Array.prototype`.
   */
  owner: string
  /**
   * The next holder on its prototype chain, in the same realm; `null` where the chain ends, at `Object.prototype`.
   * Web IDL chains end in the ECMAScript intrinsics: `EventTarget.prototype` → `Object.prototype`.
   */
  proto: string | null
  /** Set when the holder is an immutable prototype exotic object, so its prototype cannot change (§4 Member data). */
  immutablePrototype?: true
}

/**
 * The name of the named properties object holder of a `[Global]` interface that supports named properties (§4):
 * `WindowProperties` for `Window`. It is a `prototype` holder owned by the interface, between its interface prototype
 * object and the prototype it inherits.
 */
export function namedPropertiesObject(global: string): string {
  return `${global}Properties`
}

/**
 * A member defined on each instance of its interface rather than on the prototype: a `[LegacyUnforgeable]` member
 * (§4), or one a spec defines in prose on each instance (`Location`'s `valueOf`, §4 Sources). It is no target of its
 * own. Ordinary instances are never targets (§3), but a platform singleton's own members are `instance` targets named
 * by its canonical path (§4): `location.href`, `document.location`, `location.valueOf`.
 */
export type InstanceMember = Omit<CatalogTarget, 'holder' | 'holds' | 'kind' | 'catalogStatus'> & {
  /**
   * `[LegacyUnforgeable]` applies only to regular operations and attributes. A prose member is a `function`, a `value`
   * or an `accessor`, as an ECMAScript property is.
   */
  kind: 'operation' | 'attribute' | PropertyKind
}

/**
 * An entry of the curated overlay of own members a spec defines in prose on each instance of an interface, rather than
 * in IDL (§4 Sources): HTML's Location object setup steps give every `Location` object its own `valueOf` and
 * `@@toPrimitive`, non-writable and non-configurable. Each joins its interface's per-instance members.
 */
export interface ProseMember {
  /** The spec whose prose defines it, credited on its member: `html`. */
  spec: string
  /** Where the entry was curated from: the spec's section, and what its prose says. */
  source: string
  /** What the property is: it holds a built-in `function`, holds another `value`, or is an `accessor`. */
  kind: PropertyKind
  /** Its descriptor, as the spec's prose gives it. */
  descriptor: Descriptor
}

/**
 * What each instance of a Web IDL interface carries itself. The platform singletons (§3) that are its instances carry
 * it on their holders: the `location` holder, a `Location` instance, has `immutablePrototype`.
 */
export interface InstanceData {
  /** Set when every instance is an immutable prototype exotic object, as `Location` instances are (§4 Member data). */
  immutablePrototype?: true
}

/**
 * An entry of the curated ES additions overlay (§4 Sources): an addition ECMA-262 and ECMA-402 do not define yet, such
 * as `Temporal`, described as the clause titles its spec gives its properties.
 */
export interface EsAddition {
  /** The spec that defines it, credited on its targets. */
  spec: string
  /** Where the entry was curated from: the spec's URL and version. */
  source: string
  /** The objects it adds that are namespaces, e.g. `Temporal`, `Temporal.Now`. */
  namespaces: string[]
  /**
   * Its properties, as ECMA-262 titles clauses: `Temporal.PlainDate.from ( item [ , options ] )`, `get
   * Temporal.PlainDate.prototype.year`. A single name, `Temporal`, is a property of the global object.
   */
  properties: string[]
}

/**
 * An entry of the curated engine-extensions overlay (§4 Sources), by the path of the property it describes
 * (`Error.stackTraceLimit`): an own property an engine defines on an ECMAScript intrinsic outside ECMA-262. It is a
 * native member like any other, in every realm, so a write to it is a `replace`, not an `add`.
 */
export interface EngineExtension {
  /** The engine that defines it, credited on its targets as their `spec`: `v8`. */
  engine: string
  /** Where the entry was curated from: the engine's version, and how its descriptor was read. */
  source: string
  /** What the property is: it holds a built-in `function`, holds another `value`, or is an `accessor`. */
  kind: PropertyKind
  /** Its descriptor in the engine, as the engine defines it. */
  descriptor: Descriptor
}

/**
 * An entry of the curated engine-prototypes overlay (§4 Sources), by the name of the holder it adds: a prototype object
 * an engine puts on a platform singleton's chain where Web IDL has none. `HTMLDocument.prototype` sits between
 * `document` and `Document.prototype`, as every engine has it, although `@webref/idl` has no `HTMLDocument`. It is a
 * `prototype` holder whose only own members are `constructor` and `@@toStringTag`, and its interface object is a
 * `constructor` holder named by `owner`, held by a `global` target of each realm it is in (`Window.HTMLDocument`), with
 * the `prototype` that holds it (§4 Sources, Targets and holders).
 */
export interface EnginePrototype {
  /** The engine whose chain it follows: `blink`. */
  engine: string
  /** Where the entry was curated from: the engine, and how its chain was read. */
  source: string
  /** The realms it is in, each a realm where every holder in `prototypeOf` is. */
  realms: Realm[]
  /** The interface it belongs to in the engine: `HTMLDocument`. It is the holder's `owner`. */
  owner: string
  /** The holder it inherits from, the one each holder in `prototypeOf` had as its prototype: `Document.prototype`. */
  proto: string
  /** The holders whose prototype it becomes: `document`. */
  prototypeOf: string[]
  /** Its interface object, the `constructor` holder named by `owner`: `proto` is the holder it inherits from, `Document`. */
  interfaceObject: { proto: string }
}

/**
 * An entry of the curated overlay of ECMA-262 own properties that have no clause of their own (§4 Sources), by the
 * path of the property it describes: `Function.prototype.caller` and `.arguments`, which AddRestrictedFunctionProperties
 * defines, and `Array.prototype.length` and `String.prototype.length`, which the prose of their prototype objects'
 * clauses defines. A biblio lists no clause title for them, so the generator can't read them from ECMA-262. Each is an
 * ECMA-262 member like any other, in every realm, credited to `ecma262`.
 */
export interface EsProseProperty {
  /** Where ECMA-262 defines it: the clause, and what its prose says. */
  source: string
  /** What the property is: it holds a built-in `function`, holds another `value`, or is an `accessor`. */
  kind: PropertyKind
  /** Its descriptor, as ECMA-262 gives it. */
  descriptor: Descriptor
}

/**
 * A curated shape of a normalized source path (§10 Escaped sources), which a framework path rule or an escape-only
 * shape matches. It is matched against a source with no `node_modules` segment, on its normalized path: the scheme and
 * namespace stripped, a relative `sourceRoot` joined, `.` and `x/..` segments collapsed, leading `..` segments kept.
 */
export interface PathShape {
  /** Where the shape was observed, and why it is curated. */
  source: string
  /**
   * The bundler namespace the source must be in, as attribution names it: `webpack:<ns>` for `webpack://<ns>/`
   * (`webpack:_N_E`). Absent, a source in any namespace matches.
   */
  namespace?: string
  /**
   * The fewest leading `..` segments the path must start with, with `segments` right after them. Absent, the run of
   * `segments` may start at any segment of the path.
   */
  up?: number
  /**
   * The run of whole segments to match, at least one of them. In a segment, `*` matches any characters, possibly none,
   * and `<name>` matches one or more characters, which the shape captures as `name`. The path has at least one segment
   * after the run.
   */
  segments: string[]
  /**
   * The whole values a placeholder may capture, by placeholder name: `{ pkg: ['core', 'common', …] }` limits `<pkg>` to
   * those. Absent, or for a placeholder it doesn't list, a placeholder captures any value.
   */
  captures?: Record<string, string[]>
}

/**
 * A framework path rule (§10 Framework path rules), by its id: a shape whose escaped source is named as a file of
 * `package`. It only names a package: never first-party, never `high` (§9 `framework-path-rule`), never a version.
 */
export interface FrameworkPathRule extends PathShape {
  /** The package it names, where `<name>` stands for what the shape captured as `name`: `next`, `@angular/<pkg>`. */
  package: string
}

/**
 * An escape-only shape (§10 Escaped sources), by its id: a shape that names no package. A source that matches one is
 * always escaped (`unknown`, `escaped-source`), wherever the inferred root is.
 */
export type EscapeOnlyShape = PathShape

/**
 * A platform singleton (§3) in a realm: a native instance reachable from the global object and shared by the whole
 * realm. The catalog keys it by its canonical path from the global, without the global's prefix (`history`,
 * `navigator.geolocation`, `crypto.subtle`), which is also the name of its holder and the prefix of its targets.
 */
export type Singleton = {
  /**
   * The property its value is read from, as a target of the same realm: a property of the global (`Window.history`)
   * or of the singleton its path extends (`Navigator.prototype.geolocation`).
   */
  via: string
} & (
  | {
      /** The interface it is an instance of: its holder is an `instance` holder on that interface's prototype. */
      interface: string
    }
  | {
      /** The namespace it is, for `console`: its holder is that namespace's `namespace` holder. */
      namespace: string
    }
)

/**
 * An entry of the curated exclusions overlay (§4 Sources): an interface, namespace or intrinsic upstream publishes that
 * the catalog leaves out, such as a test-only API.
 */
export interface Exclusion {
  /** Why it is left out. */
  reason: string
  /** The targets it would have had, per realm, by name, sorted. None of them is in `targets`. */
  targets: Record<Realm, string[]>
}

/**
 * The curated owner → surface map (§12 Surfaces and data), with per-member overrides. It was seeded once from spec
 * shortname and HTML section page, and its protected owners were reviewed by hand. It never says `other`: a member it
 * says nothing about is `other`, the surface of an owner nobody has reviewed. ECMAScript members are always
 * `ECMAScript`, and are not in it.
 */
export interface SurfaceMap {
  /**
   * The surface of each interface or namespace, by name, and of an interface mixin, whose members take its surface on
   * every interface that includes it.
   */
  owners: Record<string, Surface>
  /** The surface of single members, by the interface, namespace or mixin that declares them, and then by member. */
  members: Record<string, Record<string, Surface>>
}

/**
 * An entry of the protected-surface list (§12 The list), keyed on (interface, member) and independent of realm and
 * holder. Without a `member`, it is a whole-interface or namespace entry.
 */
export interface ProtectedEntry {
  /** An interface, namespace or intrinsic; for a member entry, also an interface mixin (`WindowOrWorkerGlobalScope`). */
  interface: string
  member?: string
  /**
   * For a member entry, the interface that declares the member's worker-realm equivalent (§12 Matching): the entry also
   * names that interface's member of the same name in each worker realm. `WorkerNavigator.prototype.serviceWorker` is
   * the `Navigator.serviceWorker` entry's.
   */
  workerEquivalent?: string
  /**
   * The catalog targets the entry names, per realm, by name, sorted. A member entry names that member on its owner, or
   * on each interface that includes its mixin, and in the worker realms on its `workerEquivalent`. A whole entry names
   * the properties that hold its interface or namespace object (`Window.XMLHttpRequest`) and the members it owns on its
   * constructor, prototype or namespace holders, but no event-handler attribute (`onX`). The shadowing writes and other forms an entry matches in a scan (§12 Matching) are
   * no catalog targets, so they are not listed.
   */
  targets: Record<Realm, string[]>
}

/**
 * Why a retained target or holder (§4 Catalog versions) is in the catalog although upstream removed it: the last
 * upstream version that had it, and why it left.
 */
export interface Retention {
  /** The last upstream package and version that had it, e.g. `@webref/idl 3.84.0`. */
  lastUpstream: string
  /** Why upstream removed it, and why it stays, e.g. that its spec was discontinued but an engine still ships it. */
  reason: string
}

/**
 * A deliberate drop (§4 Catalog versions): a target or holder upstream removed that the catalog lets go, backed by BCD
 * evidence that no current engine ships it.
 */
export interface Drop {
  /** The BCD feature the evidence is about, e.g. `api.Navigator.joinAdInterestGroup`. */
  bcd: string
  /** What BCD, at a version it names, shows. */
  evidence: string
}

/**
 * The remote URL normalization rules (§11 Remote URL normalization): versioned data, so a change to them shows in the
 * catalog diff. A remote artifact's attribution key is `url:` and its URL normalized by them, in order:
 * 1. `scheme`: a URL whose scheme is one of `from` takes `to` (`http:` → `https:`). A protocol-relative reference has
 *    already resolved to its page's scheme.
 * 2. `host` is lowercased, and `drop` names what is dropped: the default port, the query and the fragment.
 * 3. and 4. `path`: rewrites of the path only, in order. Each replaces every match of its `pattern`, a JavaScript
 *    regular expression (with the `u` flag), with its `replacement`: version tokens with `*` (step 3) and hex runs of 8
 *    or more characters with `#` (step 4), as whole tokens bounded by `/`, `.`, `-`, `_`, `@` or the ends.
 */
export interface RemoteUrlNormalization {
  scheme: { from: string[]; to: string }
  host: 'lowercase'
  drop: ('default-port' | 'query' | 'fragment')[]
  path: PathRule[]
}

/** A rewrite of a remote URL's path (§11 Remote URL normalization, steps 3 and 4). */
export interface PathRule {
  id: string
  step: 3 | 4
  pattern: string
  replacement: string
}

/** The runtime catalog, as committed in `catalog/catalog.json` (§19 Catalog as data). */
export interface SerializedCatalog {
  metadata: {
    /**
     * The catalog version (§4 Catalog versions): one version for all of monkeypatchlist's curated data, separate from the
     * monkeypatchlist version. It only ever grows, one bump per monkeypatchlist minor release, so two versions compare as integers.
     */
    catalogVersion: number
    /** Exact pins of the upstream packages the catalog was generated from. */
    upstream: Record<string, string>
    /** A pin of each curated overlay the catalog was generated from: the sha256 of the file's bytes, by file name. */
    overlays: Record<string, string>
  }
  /** Targets and their member data, per realm: each realm lists the targets exposed in it. */
  targets: Record<Realm, Record<string, CatalogTarget>>
  /** The objects targets live on, per realm, by name, with their prototype chains. */
  holders: Record<Realm, Record<string, CatalogHolder>>
  /**
   * Per-instance members, per realm, by interface and then member name. The `[LegacyUnforgeable]` members of a realm's
   * `[Global]` interface are not listed: the global is that interface's only instance, so they are its own targets.
   */
  instanceMembers: Record<Realm, Record<string, Record<string, InstanceMember>>>
  /** What each instance of an interface carries itself, per realm, by interface, for the interfaces that carry any. */
  instances: Record<Realm, Record<string, InstanceData>>
  /** The ES additions overlay, as the generator read it. */
  esAdditions: Record<string, EsAddition>
  /** The engine-extensions overlay, as the generator read it, by the path of each property. */
  engineExtensions: Record<string, EngineExtension>
  /** The overlay of ECMA-262 own properties without a clause of their own, as the generator read it, by path. */
  esProseProperties: Record<string, EsProseProperty>
  /** The engine-prototypes overlay, as the generator read it, by the name of each holder it adds. */
  enginePrototypes: Record<string, EnginePrototype>
  /**
   * The overlay of own members a spec defines in prose on each instance of an interface, as the generator read it, by
   * interface and then member. Each is also in `instanceMembers`.
   */
  proseMembers: Record<string, Record<string, ProseMember>>
  /** The platform singletons overlay, resolved against the IDL: each realm's singletons, by canonical path. */
  singletons: Record<Realm, Record<string, Singleton>>
  /**
   * Each singleton's alias group, per realm, by canonical path: every access path from the global that reaches it,
   * including the canonical path itself, sorted. `window.history`, `self.history` and `document.location` are paths to
   * `history` and `location` (§4).
   */
  aliasGroups: Record<Realm, Record<string, string[]>>
  /** The exclusions overlay, by the owner it excludes, with the targets each leaves out. */
  exclusions: Record<string, Exclusion>
  /** The owner → surface map every member's `surface` comes from. */
  surfaceMap: SurfaceMap
  /**
   * The protected-surface list (§12), by surface: the entries a `--surface protected` scan reports, baselines and gates
   * on. Every target an entry names has the entry's surface.
   */
  protectedSurface: Partial<Record<Surface, ProtectedEntry[]>>
  /**
   * The retained overlay (§4 Catalog versions), per realm, by name. The catalog is monotonic, holders too: a target or
   * holder upstream removes stays, as it was last generated, until a deliberate drop.
   */
  retained: {
    /** The retained targets, each also in `targets`, flagged `catalogStatus: retained`. */
    targets: Record<Realm, Record<string, Retention>>
    /** The holders upstream removed that the catalog keeps, each also in `holders`. */
    holders: Record<Realm, Record<string, Retention>>
    /** The targets deliberately dropped, none of them in `targets`. */
    dropped: Record<Realm, Record<string, Drop>>
    /** The holders deliberately dropped (holders are monotonic too), none of them in `holders`. */
    droppedHolders: Record<Realm, Record<string, Drop>>
  }
  /** The remote URL normalization rules (§11), as the generator read them. */
  remoteUrlNormalization: RemoteUrlNormalization
  /** The framework path rules (§10), as the generator read them, by id. */
  frameworkPathRules: Record<string, FrameworkPathRule>
  /** The escape-only shapes (§10), as the generator read them, by id. */
  escapeOnlyShapes: Record<string, EscapeOnlyShape>
}

/**
 * The `spec`s of a catalog's ECMAScript targets: `ecma262`, `ecma402`, each ES addition's spec and each engine
 * extension's engine. A catalog written before either overlay has none of its specs.
 */
export function ecmascriptSpecs(catalog: {
  esAdditions?: Readonly<Record<string, Pick<EsAddition, 'spec'>>> | undefined
  engineExtensions?: Readonly<Record<string, Pick<EngineExtension, 'engine'>>> | undefined
}): Set<string> {
  const additions = Object.values(catalog.esAdditions ?? {}).map(({ spec }) => spec)
  const engines = Object.values(catalog.engineExtensions ?? {}).map(({ engine }) => engine)
  return new Set(['ecma262', 'ecma402', ...additions, ...engines])
}

/**
 * Reads the catalog that ships with this package. Only the CLI's composition root calls this; the pipeline modules
 * receive the catalog as data (§19 Invariants).
 */
export function loadCatalog(): SerializedCatalog {
  return JSON.parse(readFileSync(new URL('../catalog/catalog.json', import.meta.url), 'utf8'))
}

/**
 * A change record of the catalog changelog (§4 Catalog versions): one change between a catalog version and the one
 * before it, which `explainedBy` offers as what could explain a delta. Surface reassignments explain nothing (surface
 * is context only), so the changelog has none.
 * - `target`: a target `added`, or `dropped` (a deliberate drop, or an exclusion, which counts as one)
 * - `protected-entry`: a protected-surface entry `gained` or `lost` (§12), with the targets it named in its catalog
 * - `member-data`: a target's descriptor or `assign` kind changed (§4 Member data)
 * - `holder`: a holder `added`, `dropped` or `rechained`, with its prototype on each side it has
 * - `immutable-prototype`: a holder's `immutablePrototype` flag flipped
 * - `framework-path-rule`: a framework path rule (§10) `added`, `removed` or `changed`, by id
 * - `url-normalization`: a remote URL normalization rule (§11) `added`, `removed` or `changed`: a path rule by its id,
 *   or the `scheme`, `host` or `drop` step
 *
 * A member entering or leaving a holder's enumeration is a `target` record (the member is added or dropped) or a
 * `member-data` record (its `enumerable` flips).
 */
export type ChangeRecord =
  | { kind: 'target'; change: 'added' | 'dropped'; realm: Realm; name: string }
  | { kind: 'protected-entry'; change: 'gained' | 'lost'; surface: Surface; entry: ProtectedEntry }
  | { kind: 'member-data'; realm: Realm; name: string; before: MemberData; after: MemberData }
  | {
      kind: 'holder'
      change: 'added' | 'dropped' | 'rechained'
      realm: Realm
      holder: string
      /** Its prototype in the earlier catalog; absent for an added holder. */
      before?: { proto: string | null }
      /** Its prototype in the later catalog; absent for a dropped holder. */
      after?: { proto: string | null }
    }
  | { kind: 'immutable-prototype'; realm: Realm; holder: string; before: boolean; after: boolean }
  | {
      kind: 'framework-path-rule'
      change: 'added' | 'removed' | 'changed'
      id: string
      before?: FrameworkPathRule
      after?: FrameworkPathRule
    }
  | { kind: 'url-normalization'; change: 'added' | 'removed' | 'changed'; id: string; before?: unknown; after?: unknown }

/** The member data a `member-data` change record compares: the descriptor and, for an attribute, its `assign` kind. */
export interface MemberData {
  descriptor: Descriptor
  assign?: AssignKind
}

/**
 * The catalog changelog (§4 Catalog versions), shipped in the package as `catalog/changelog.json`: for each catalog
 * version after the first, ascending, the change records from the version before it.
 */
export interface CatalogChangelog {
  versions: { catalogVersion: number; changes: ChangeRecord[] }[]
}

/**
 * Reads the catalog changelog that ships with this package. Only the CLI's composition root calls this; the pipeline
 * modules receive it as data (§19 Invariants).
 */
export function loadChangelog(): CatalogChangelog {
  return JSON.parse(readFileSync(new URL('../catalog/changelog.json', import.meta.url), 'utf8'))
}

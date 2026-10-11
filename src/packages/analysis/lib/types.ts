// The data that crosses the resolver seam (§19). Everything here is plain JSON-serializable data.

import type { Holder, Realm, SerializedCatalog } from '../../../catalog.ts'
import type { Dimension, Level, MutationReason, TargetReason } from '../../confidence/index.ts'
import type { Budget } from './budget.ts'

/** What a mutation does to its target (§8). It is part of identity. */
export const effects = ['replace', 'wrap', 'add', 'delete', 'descriptor-change', 'prototype-change'] as const
export type Effect = (typeof effects)[number]

/** The syntactic means of a mutation (§3). It is evidence, not identity. */
export const mechanisms = [
  'assign',
  'define-property',
  'define-properties',
  'reflect-define',
  'bulk-assign',
  'delete',
  'set-prototype',
  'declare',
] as const
export type Mechanism = (typeof mechanisms)[number]

/** The closed list of resolution-trace step kinds (§14). A new kind needs a spec change. */
export const traceStepKinds = [
  'binding',
  'alias',
  'fold',
  'call',
  'module-link',
  'catalog-holder',
  'enumeration',
  'guard',
  'prune',
  'creation-site',
  'outcome',
  'restore',
  'token-check',
  'path-rule',
  'confidence-reason',
  'note',
] as const
export type TraceStepKind = (typeof traceStepKinds)[number]

/** The closed list of limitation kinds (§13). A new kind needs a spec change. */
export const limitationKinds = [
  'parse-failure',
  'unreadable',
  'source-maps-unpaired',
  'fetch-failed',
  'sri-mismatch',
  'remote-refused',
  'offline-skipped',
  'dynamic-code',
  'unresolved-reference',
  'realm-uncertain',
  'unresolved-holder',
  'unlinked-module-call',
  'analysis-budget',
] as const
export type LimitationKind = (typeof limitationKinds)[number]

/**
 * Whether a mutation leaves its target non-configurable or non-writable (§8): `unknown` when the resolver can't tell,
 * as for a define whose descriptor it can't see (§3).
 */
export type Locks = boolean | 'unknown'

/** Whether a write reaches the artifact's own global, another window's, or one the analyzer can't tell (§4). */
export type RealmInstance = 'current' | 'other' | 'unknown'

/**
 * The declarations that bind a property of the global object (§5): a classic script's top-level `var` or `function`,
 * or a block-level function Annex B hoists to the global object (`block-function`). A classic script's top-level `let`,
 * `const` or `class` binds no property, but hides the global object's from bare-name callers (§3 Declarations in
 * classic scripts): a write it makes names it as its declaration.
 */
export type GlobalDeclarationKind = 'var' | 'function' | 'block-function' | 'let' | 'const' | 'class'

/**
 * The syntactic forms a write reaches the global object through without a call (§5 Global resolution):
 * - `global-property`: a free name that is the global object's property, as a bare global (`fetch` in `fetch = w`) or
 *   a bare constructor or namespace (`XMLHttpRequest` in `XMLHttpRequest.prototype.send = w`)
 * - `global-name`: a free `window`, `self` or `globalThis`, the realm's names for its global object, and in the window
 *   realm a free `frames`, which is the window itself (§5 Other windows)
 * - `guarded-global`: a free `global` under a `typeof global` guard
 * - `top-level-this`: `this` at the top level of a classic script, as UMD wrappers pass it
 * - `function-return-this`: `Function('return this')()`
 * - `sloppy-this`: `this` in a sloppy function that a call the resolver evaluates calls without a `this`, or with `null`
 *   or `undefined` as its `thisArg`: `(function(){ return this })()`, `f()`, `f.call(null)`, an iteration
 *   native's callback with no `thisArg`
 * - `other-window`: a window reached from another value: through `parent`, `top` or `opener` from a window, as a child
 *   window through a constant index read on a window (`window[0]`, named `[0]`) or any index read on a window spelled
 *   as the frames collection (`frames[i]`, named `[i]`), or through `defaultView` or `contentWindow` on any object
 *   (§5 Other windows). This window's `document.defaultView`, and a child's `parent` of this window, are this window.
 * - `singleton`: a platform singleton, read from a window or another singleton through an access path in its alias
 *   group (§4): `localStorage` in `window.localStorage`, `location` in `document.location`
 */
export const globalForms = [
  'global-property',
  'global-name',
  'guarded-global',
  'top-level-this',
  'function-return-this',
  'sloppy-this',
  'other-window',
  'singleton',
] as const
export type GlobalForm = (typeof globalForms)[number]

/**
 * A `binding` trace step (§14): how a name resolved, the form the global object was recognized in, and its realm and
 * realm instance.
 * - `global`: to no declaration, so the name is the global object's property of that name (`fetch` in `fetch = w`).
 *   When that property's value is a native holder, `holds` names it: the catalog's holder (`XMLHttpRequest`), or a
 *   platform singleton (`localStorage`).
 * - `alias`: to no declaration, and the name is an alias of a holder, named in `aliasOf`: `window`, `self`,
 *   `globalThis`, a guarded `global`, a top-level `this`, `Function('return this')()` and another window are aliases
 *   of the global object (`Window`). A member read through an access path in a singleton's alias group is an alias of
 *   the singleton, and `path` is that access path (`location` in `document.location`).
 * - `declaration`: to a declaration that binds the global object's property, recorded in `declaration`. It is an alias
 *   too when the name is one (`var self; self.fetch = w`).
 *
 * A step from a value (`parent` in `window.parent`, `location` in `document.location`) follows the steps of the value
 * it is read from. `realmInstance` is the window the name's value belongs to (§4 Other windows). `chain` locates the
 * outermost `?:`, `||`, `&&` or `??` chain the name was selected through, as in
 * `("undefined" != typeof globalThis ? globalThis : …).fetch = w`.
 */
export interface BindingStep {
  kind: 'binding'
  name: string
  resolution: 'global' | 'alias' | 'declaration'
  form: GlobalForm
  aliasOf?: string
  holds?: string
  path?: string
  declaration?: { kind: GlobalDeclarationKind; generated: GeneratedLocation }
  chain?: GeneratedLocation
  realm: Realm
  realmInstance: RealmInstance
  text: string
}

/**
 * A `confidence-reason` trace step (§14): the evidence behind a target or mutation confidence reason the occurrence
 * carries (§9). For `with-scope` and `direct-eval-scope`, it names the name whose resolution path the evidence is on,
 * and the `with` statements or direct `eval` calls there, in document order. For `outcome-undecidable`, `sites` locates
 * what the outcome depends on and the analyzer can't see or decide (§3 Undecidable outcomes): the parts of a define's
 * descriptor, or the object a `Reflect.set` looks its member up on.
 */
export interface ConfidenceReasonStep {
  kind: 'confidence-reason'
  dimension: 'target' | 'mutation'
  reason: TargetReason | MutationReason
  level: Exclude<Level, 'high'>
  name?: string
  sites?: GeneratedLocation[]
  /** For `holder-alternatives` and `member-alternatives`, the site's other candidate targets (§5 Candidate sets). */
  alternatives?: string[]
  text: string
}

/**
 * The natives that compile code from strings (§2 Content that isn't JavaScript): `eval`, the `Function` constructor
 * (called or constructed), and string timers.
 */
export const codeCallees = ['eval', 'Function', 'setTimeout', 'setInterval'] as const
export type CodeCallee = (typeof codeCallees)[number]

/**
 * A `note` trace step (§14) that says the write is in nested code (§2): code the native `callee` compiles from a string
 * literal in the call at `call`, or, for `script`, the literal text of a script element the code creates and inserts
 * with the call at `call`, which runs as a classic script. `scope` says where its names resolve: in the caller's
 * scope (a direct eval), or in the global scope (an indirect eval, a string timer, a function the `Function`
 * constructor makes, or a script). Code nested in nested code gives a note per level, outermost first.
 */
export interface NestedCodeStep {
  kind: 'note'
  about: 'nested-code'
  callee: CodeCallee | 'script'
  scope: 'caller' | 'global'
  call: GeneratedLocation
  text: string
}

/**
 * A `note` trace step (§14) that says a delete of the same slot came first (§3 A delete that is always rewritten): the
 * delete at `delete`, which the same function follows on every path with this write, so it gives no finding of its own.
 */
export interface RewrittenDeleteStep {
  kind: 'note'
  about: 'rewritten-delete'
  delete: GeneratedLocation
  text: string
}

/**
 * A `note` trace step (§14) that says another classic script in the realm declares a name the write reads bare at the
 * top level with `let`, `const` or `class` (§3 Declarations in classic scripts): the scan-wide lexical-name check. At
 * runtime that name reaches the other script's lexical binding, not the global object's property, when both load.
 * `name` is the bare name: the one written (`fetch = w`), or the one the holder chain starts at (`Node` in
 * `Node.prototype.foo = f`). `artifact` is the declaring script's URL, and `generated` locates the bound
 * identifier there. The finding is kept, since there is no evaluation-order modelling between scripts.
 */
export interface LexicalCollisionStep {
  kind: 'note'
  about: 'lexical-collision'
  name: string
  declaration: 'let' | 'const' | 'class'
  artifact: string
  generated: GeneratedLocation
  text: string
}

/**
 * A top-level `let`, `const` or `class` declaration of a classic script (§3 Declarations in classic scripts), which
 * the scan-wide lexical-name check collects per realm: the declaring artifact's URL, the bound name, and where the
 * identifier is.
 */
export interface LexicalDeclaration {
  artifact: string
  name: string
  kind: 'let' | 'const' | 'class'
  generated: GeneratedLocation
}

/**
 * A `fold` trace step (§14): an expression folded to a constant, such as `"add" + "EventListener"` to
 * `"addEventListener"`. For a `const` read through its name, `name` is the name, and the expression is the one its value
 * comes from: its initializer, the element or property it destructures, or its default. `expression` is printed from
 * the syntax and cut at 120 characters, and `generated` locates it. The constant is its `value`, or for a well-known
 * symbol read from `Symbol` (§4 Property keys), `symbol`: the symbol's member spelling in the catalog, `@@iterator`.
 */
export type FoldStep = {
  kind: 'fold'
  name?: string
  expression: string
  generated: GeneratedLocation
  text: string
} & ({ value: string | number | boolean | null } | { symbol: string })

/**
 * An `alias` trace step (§14): the value was read through the variable `name`, from its definition that reaches the
 * read (§5 Resolver capabilities 2): a declarator, an assignment, an update or a loop head. `expression` is the
 * definition, printed from the syntax and cut at 120 characters, and `generated` locates it.
 */
export interface AliasStep {
  kind: 'alias'
  name: string
  expression: string
  generated: GeneratedLocation
  text: string
}

/**
 * A `catalog-holder` trace step (§14): a holder the unmutated catalog chose (§4). `expression` is printed from the
 * syntax and cut at 120 characters, and `generated` locates it. It is one of:
 * - a prototype step: `Object.getPrototypeOf(h)` (or `h.__proto__`) of the native holder `prototypeOf` is `holder`, its
 *   prototype in the unmutated catalog: `Object.getPrototypeOf(console)` is `console.[[Prototype]]`
 * - an own-property test: whether the native holder `tested` `owns` the catalog `member`, which chose the holder the
 *   runtime choice takes (`hasOwnProperty.call(history, m) ? history : History.prototype`). With no `member`, the key
 *   didn't fold, and `tested` owns only structural members, so it owns none that counts
 * - a prototype walk to the first owner: the holders `walk` visits from its start value, in order, and `holder`, the
 *   first that owns `member`. With no `member`, the key didn't fold, and `holder` is one holder that may own it
 */
export type CatalogHolderStep = {
  kind: 'catalog-holder'
  expression: string
  generated: GeneratedLocation
  text: string
} & (
  | { prototypeOf: string; holder: string }
  | { tested: string; member?: string; owns: boolean }
  | { walk: string[]; member?: string; holder: string }
)

/**
 * An `enumeration` trace step (§14), in one of two shapes:
 * - a member sweep the catalog expanded (§5 Resolver capabilities 9). The enumeration `expression` at `generated` (the
 *   call, or a `for…in` loop's object), printed from the syntax and cut at 120 characters, swept the native `holder` by
 *   `enumeration`, and gave the catalog `member`. `filters` are the filters the key went through, in order, each `kept`
 *   when it keeps the member and `undecided` when the analyzer can't tell, which makes reachability `conditional`.
 * - a configurable wildcard prefix (§5 Pattern wildcards): the key `expression` at `generated`, written on
 *   `holder`, starts with a prefix whose other alternatives the analyzer can't resolve, which give nothing, and
 *   `prefix` is its default, the literal alternative this wildcard comes from.
 */
export type EnumerationStep = {
  kind: 'enumeration'
  expression: string
  generated: GeneratedLocation
  holder: string
  text: string
} & (
  | {
      enumeration:
        | 'for-in'
        | 'Object.keys'
        | 'Object.getOwnPropertyNames'
        | 'Object.entries'
        | 'Object.getOwnPropertyDescriptors'
        | 'Reflect.ownKeys'
        | 'Object.getOwnPropertySymbols'
      member: string
      filters: { expression: string; generated: GeneratedLocation; result: 'kept' | 'undecided' }[]
    }
  | { prefix: string; configurable: true }
)

/**
 * A `call` trace step (§14): a summarized call (§5 Resolver capabilities 3). A value came into the function at
 * `function` through the call at `generated`, whose `callee` is printed from the syntax, as a parameter bound to an
 * argument, as its `this`, or as what the function returns. `bindings` pairs each parameter, printed, with the argument
 * the call passes it, printed, or null when it passes none. `this` is the receiver the call dispatches through, printed:
 * the object a method is read from, or a `thisArg`; a `new`'s is the instance it makes. Printed expressions are cut at
 * 120 characters.
 */
export interface CallStep {
  kind: 'call'
  callee: string
  generated: GeneratedLocation
  function: GeneratedLocation
  bindings: { parameter: string; argument: string | null }[]
  this?: string
  text: string
}

/**
 * A `creation-site` trace step (§14): the write is in a function object that no resolved call reaches, judged from
 * where it was created (§5 Resolver capabilities 3, §7). `function` locates the function, and `generated` where the
 * object was made: the function or class itself, or for a method assumed to run with an object it is held on, that
 * object's allocation site, which `this` prints. Its creation bindings are in the `call` steps of the calls that made
 * it.
 */
export interface CreationSiteStep {
  kind: 'creation-site'
  function: GeneratedLocation
  generated: GeneratedLocation
  this?: string
  text: string
}

/**
 * A `module-link` trace step (§6, §14): a module-link hop the value came through. `idiom` is the module-linking idiom:
 * `factory-table` for a require call that runs a module's factory, `lazy-thunk` and `memoized-getter` for a call of a
 * module's thunk or getter that runs it, `interop` for an interop wrapper's call over one, and `getter-export` for an
 * export a getter export definer defines. `module` is the module's build-local id or name, `export` the export's name,
 * `artifact` the artifact the module is in, and `generated` where the hop is: the call, or the export's getter or value.
 */
export interface ModuleLinkStep {
  kind: 'module-link'
  idiom: 'factory-table' | 'getter-export' | 'interop' | 'lazy-thunk' | 'memoized-getter'
  module: string
  export?: string
  artifact: string
  generated: GeneratedLocation
  text: string
}

/**
 * Whether a platform mutation happens (§7 Values), judged by the guards on its path:
 * - `unconditional`: no guard that matters
 * - `guarded-native-absence`: it runs only when some native, not necessarily the target, is missing
 * - `conditional`: a recognized guard that can't be decided statically
 * - `unknown`: control flow the analyzer couldn't model
 *
 * It is not identity, and in R1 it doesn't make a finding `changed` (§11, ADR 0014).
 */
export const reachabilities = ['unconditional', 'guarded-native-absence', 'conditional', 'unknown'] as const
export type Reachability = (typeof reachabilities)[number]

/**
 * How an occurrence's reachability was judged (§7 Where reachability is judged from): `call-path`, along resolved calls
 * out to its install entry, or `creation-site`, from where a function no resolved call reaches was created. Evidence,
 * never identity: it decides nothing in R1.
 */
export type ReachabilityBasis = 'call-path' | 'creation-site'

/**
 * Whether a mutation runs at load or later (§7 Install context): `load` when a resolved synchronous chain reaches
 * top-level code, `deferred` when only a later call of its install entry reaches it. Evidence, never identity: it
 * doesn't make a finding `changed` in R1 (§11, ADR 0014).
 */
export const installContexts = ['load', 'deferred'] as const
export type InstallContext = (typeof installContexts)[number]

/**
 * The class of a guard (§14 `guard`): `transparent` (it leaves the mutation `unconditional`: the written target's own
 * presence, a once-flag, a writability check, a test decided as a constant), `absence` (a native is missing),
 * `broken-native` (a native is judged broken rather than missing), `config` (a config or option flag),
 * `other-target` (the presence of a native other than the target), `unknown` (a guard the analyzer doesn't recognize,
 * an unresolved call, or `with` or direct-`eval` taint) and `undecided` (a recognized guard that can't be decided).
 */
export const guardClasses = [
  'transparent',
  'absence',
  'broken-native',
  'config',
  'other-target',
  'unknown',
  'undecided',
] as const
export type GuardClass = (typeof guardClasses)[number]

/**
 * A `guard` trace step (§14): a guard on the write's path, the `expression` at `generated`, printed from the syntax and
 * cut at 120 characters; its class; the native it tests, by target name (`Window.fetch` for `!g.fetch`), when it tests
 * one; and the reachability it gives on its own.
 */
export interface GuardStep {
  kind: 'guard'
  expression: string
  generated: GeneratedLocation
  class: GuardClass
  tested?: string
  result: Reachability
  text: string
}

/**
 * A `prune` trace step (§7, §14): the finding occurrences a statically false catalog check pruned, `count` of them,
 * and the guard: the test `expression` at `generated`, printed from the syntax and cut at 120 characters. It follows
 * that guard's `guard` step on each surviving occurrence the same guard is on. With `judgement`, it is instead the writes
 * a `catch` arm whose `try` can't throw dropped (§5 Resolver capabilities 9), or those an arm a call argument
 * literal's field rules out alone reaches (§5 Resolver capabilities 5).
 */
export interface PruneStep {
  kind: 'prune'
  count: number
  expression: string
  generated: GeneratedLocation
  /**
   * Set when a `catch` arm's `try` judged unable to throw dropped the writes (§5 Resolver capabilities 9): then
   * `expression` and `generated` are the `try`'s, and `count` the writes in the arm it dropped. Set to `argument-literal`
   * when a call argument literal's field settled the test `expression` at `generated`: `count` is then the writes
   * the arm it rules out alone reaches.
   */
  judgement?: 'try-cannot-throw' | 'argument-literal'
  /**
   * With `judgement` `argument-literal` (§5 Resolver capabilities 5): the call argument object literal whose
   * field settled the test `expression` at `generated`, printed and cut at 120 characters, and where it is. `count` is
   * the writes the arm the test rules out alone reaches.
   */
  literal?: { expression: string; generated: GeneratedLocation }
  text: string
}

/**
 * A `restore` trace step (§3 Restores, §14): a proven restore in the install occurrence's chain, which writes the
 * unmutated native of the same object and member back at `generated`. `guard` is `identity` when the restore runs only
 * if the slot still holds the code's own value (`if (window.fetch === ours)`), and `none` when it writes whatever is
 * there. `leavesOwnShadow` is true when it writes the native back into an own property the install created, which
 * shadows the inherited member (`history.pushState`). It is evidence, never identity.
 */
export interface RestoreStep {
  kind: 'restore'
  generated: GeneratedLocation
  guard: 'identity' | 'none'
  leavesOwnShadow: boolean
  text: string
}

/** One step of an occurrence's resolution trace (§14). Tests assert on `kind` and fields, never on `text`. */
export type TraceStep =
  | AliasStep
  | BindingStep
  | CallStep
  | CatalogHolderStep
  | ConfidenceReasonStep
  | CreationSiteStep
  | EnumerationStep
  | FoldStep
  | GuardStep
  | LexicalCollisionStep
  | ModuleLinkStep
  | NestedCodeStep
  | OutcomeStep
  | PruneStep
  | RestoreStep
  | RewrittenDeleteStep

/**
 * An artifact as the resolver sees it: its URL, content hash, `sourceType` and realm (§19), and how the realm is known
 * (§2 Realm): from how the artifact was referenced, or assumed to be `window` because only the sweep found it. The
 * occurrences of a group whose realm is assumed carry the target-confidence reason `realm-assumed` (§9).
 */
export interface ArtifactRef {
  url: string
  hash: string
  sourceType: 'script' | 'module'
  realm: Realm
  realmBasis: 'reference' | 'assumed'
}

/**
 * An artifact's source text, as the resolver pulls it through `artifact(url)`, and where it is served from (§8 Origin),
 * which bounds how far a helper write's lookup crosses artifacts (§10).
 */
export interface ArtifactSource extends ArtifactRef {
  text: string
  origin?: 'local-build' | 'same-origin' | 'cross-origin' | 'inline'
}

/**
 * A position in an artifact's generated code (§5): a UTF-16 range, and its start as a 1-based line and a 0-based
 * column, through the artifact's line-start table.
 */
export interface GeneratedLocation {
  start: number
  end: number
  line: number
  column: number
}

/** A target (§4): `{ realm, holder, name, shadows? }`. Realm and name are identity. */
export interface Target {
  realm: Realm
  holder: Holder
  name: string
  shadows?: string
}

/**
 * Where attribution looks a write up in its artifact's source map (§10 lookup point), and the token the token check
 * looks for there. `token` is null when the site has none, and the check doesn't apply.
 * - The write's member token, written at the site as an identifier, a string or a template with no substitutions:
 *   `fetch` in `window.fetch = w`, `window["fetch"] = w` or ``window[`fetch`] = w``, the `'fetch'` argument of
 *   `Object.defineProperty`, a key in `Object.defineProperties` or `Object.assign`.
 * - Otherwise its holder argument: for a write with no member (`setPrototypeOf`, `__proto__`), or a member that isn't
 *   written at the site as a token (`window[k] = w`, `h[0] = w`). Its token is its name only when it is written as a
 *   free global (`window`) or a literal property name (`history` in `window.history`), never as a local binding.
 * - A write in nested code (§2): the start of its enclosing literal in the host artifact's own code, with no token.
 * - A write inside a helper: the outermost call on the chain whose arguments carry both the holder and the member
 *   (§10): the holder came through one of them, and one of them is the member's key. Its token is that key when it is
 *   written at the call as a string or a template with no substitutions. The occurrence keeps the helper's write as its
 *   position.
 */
export interface Lookup {
  /**
   * The URL of the artifact the lookup point is in, when it isn't the write's: a call in another artifact of the link
   * group with the write's origin (§10).
   */
  artifact?: string
  generated: GeneratedLocation
  token: string | null
}

/** The fields the resolver owns on an occurrence (§19 Raw occurrences). No later module changes them. */
export interface RawOccurrence {
  /** The URL of the artifact the write is in. */
  artifact: string
  generated: GeneratedLocation
  /** Where attribution looks the write up (§10), which may differ from where the write is. */
  lookup: Lookup
  target: Target
  effect: Effect
  mechanism: Mechanism
  /**
   * Whether the write reaches the artifact's own global object, another window's, or one the analyzer can't tell (§4
   * Other windows). It is evidence, never identity.
   */
  realmInstance: RealmInstance
  /** Whether the mutation leaves the target non-configurable or non-writable (§8). */
  locks: Locks
  /** Whether the mutation happens, judged by the guards on its path (§7). */
  reachability: Reachability
  /** How its reachability was judged (§7). */
  reachabilityBasis: ReachabilityBasis
  /** Whether it runs at load or later (§7 Install context). */
  installContext: InstallContext
  /**
   * The name of the install entry a `deferred` mutation waits on (`init`), or null: for a `load` one, or an entry that
   * has no name (an anonymous callback).
   */
  installEntry: string | null
  /** The confidence dimensions the resolver owns (§9, §19 Raw occurrences). Attribution adds the third. */
  confidence: { target: Dimension<TargetReason>; mutation: Dimension<MutationReason> }
  trace: TraceStep[]
  /**
   * For a wildcard whose matched set a candidate set narrows (§5), the catalog targets it matches, by name, as data
   * for `--surface` (§12). It never crosses into the report.
   */
  matches?: string[]
}

/** A coverage limitation record (§13): `{ kind, artifact, location, detail }`. */
export interface Limitation {
  kind: LimitationKind
  artifact: { url: string; hash: string }
  location?: GeneratedLocation
  detail: string
  /**
   * For an `unresolved-holder` record, the candidate targets its `detail` lists, in the artifact's realm, as data for
   * the surface filter (§12): `detail` ends with them, joined by `, `, so the findings stage can list only the ones it
   * keeps. They don't cross into the report.
   */
  candidates?: string[]
}

/** The per-artifact module-linking summary (§6). */
export interface ModuleLinking {
  idioms: string[]
  modules: number
  unlinked: number
  linkGroups: number
}

/**
 * A reference only the resolver can see (§19 Discovery): its URL as the code builds it, unresolved, its kind, and where
 * it is: the group member it is in, as the group names it, and its location there. A `chunk` reference also says how
 * its load site loads it (`load`): a created script element's `src`, `importScripts` or `import()`. When some
 * alternative of the URL doesn't fold to a constant, the record is `partial`: a chunk's `url` is then only the constant
 * prefix that alternative starts with ('' for none), which decides whether a chunk URL that doesn't fold is local
 * (§2), and an injected script's or worker's is '', with `alternative` locating the alternative that doesn't fold. An
 * `injected` reference also carries its element's `type` as it folds (absent when none is set, null when it doesn't
 * fold), its `integrity` constants when they fold (§17) and whether its `noModule` is set. A `worker` reference's
 * location is the worker URL argument of the call that discovery recognizes as a worker call.
 */
export interface DiscoveredReference {
  url: string
  kind: 'injected' | 'worker' | 'chunk'
  artifact: string
  location: GeneratedLocation
  load?: 'element' | 'import-scripts' | 'import'
  partial?: true
  alternative?: GeneratedLocation
  /** For a `worker` site: its URL folds to no value, as when it throws (`new URL("x.js")`), so it loads nothing. */
  none?: true
  type?: string | null
  /** The integrity value code sets on a chunk's script element, when it folds to a constant (§17 Integrity). */
  integrity?: string
  /** For an `injected` reference: the constants its element's `integrity` may be, when each write folds. */
  integrityAlternatives?: string[]
  /** For an `injected` reference: its element's `noModule` is set (`yes`), or may be (`maybe`). */
  noModule?: 'yes' | 'maybe'
}

/** Why a write can't change its target (§3 Ineffective writes). */
export const ineffectiveReasons = [
  'readonly',
  'lenient-setter',
  'non-writable',
  'non-configurable',
  'immutable-prototype',
] as const
export type IneffectiveReason = (typeof ineffectiveReasons)[number]

/**
 * Whether an ineffective write throws (§3): `always` in sloppy and strict code alike, at parse or instantiation or when
 * the write runs; `strict-only`; or `never`, as the `Reflect` forms return false.
 */
export const throwsValues = ['always', 'strict-only', 'never'] as const
export type Throws = (typeof throwsValues)[number]

/** Whether the code a write is in is sloppy or strict mode code. */
export type Strictness = 'sloppy' | 'strict'

/**
 * An `outcome` trace step (§14): the outcome table's decision on an ineffective write (§3). `mayChangeNothing` says
 * the write's every other outcome, on a value the analyzer can't see, changes nothing (§3 No-op or ineffective).
 */
export interface OutcomeStep {
  kind: 'outcome'
  result: 'ineffective'
  reason: IneffectiveReason
  throws: Throws
  mayChangeNothing: boolean
  text: string
}

/**
 * An occurrence of a write that cannot change its target (§3 Ineffective writes): where it is, the target it would
 * have changed, its intended effect and mechanism, why it can't, whether it throws, and the strictness of its code. It
 * is never a finding, and has no `locks` or confidence of its own.
 */
export interface IneffectiveWrite extends Omit<RawOccurrence, 'locks' | 'confidence'> {
  reason: IneffectiveReason
  throws: Throws
  strictness: Strictness
}

export interface AnalyzeGroupInput {
  /** The group's entry artifact. */
  entry: ArtifactRef
  /** Synchronous: the build's artifacts and fetched remote artifacts in this realm. */
  artifact(url: string): ArtifactSource | undefined
  /**
   * Synchronous: the URL a module request in the code of the artifact at `from` names (§6 Module links), as discovery
   * resolved it, or undefined when it resolves to none.
   */
  resolveImport?(from: string, specifier: string): string | undefined
  /**
   * Synchronous: the build-directory artifacts in this realm whose code pushes chunk `id` (any chunk, for `null`) into
   * the chunk registry named `registry` (§6 idiom 6), named as `artifact` names them, in URL order.
   */
  chunks?(registry: string, id: string | null): readonly string[]
  /**
   * Synchronous: the other classic scripts the entry's document references that push into the chunk registry named
   * `registry` (§6): the initial chunks a loader there links, which run at load. In URL order.
   */
  initialChunks?(registry: string): readonly string[]
  catalog: SerializedCatalog
  /** The step budget per source byte, and the caps (§18). */
  budget: Budget
}

export interface AnalyzeGroupOutput {
  /** The group's actual members (§6). */
  members: ArtifactRef[]
  occurrences: RawOccurrence[]
  ineffectiveWrites: IneffectiveWrite[]
  limitations: Limitation[]
  references: DiscoveredReference[]
  moduleLinking: Record<string, ModuleLinking>
  /**
   * The top-level `let`, `const` and `class` declarations of the group's classic scripts, in document order, for the
   * scan-wide lexical-name check (§3). None when the group has none, or is modules only.
   */
  lexicalDeclarations?: LexicalDeclaration[]
  /**
   * The group's work (§13 Scan statistics, §18): the steps it took, its step budget, whether it exhausted that budget,
   * each cap's hits, and how many finding occurrences statically false catalog checks pruned (§7) plus writes `catch`
   * arms whose `try` can't throw dropped, when any did.
   */
  stats: { steps: number; budget: number; exhausted: boolean; caps: Record<string, number>; pruned?: number }
}

/** The resolver seam (§19). Each release ships exactly one implementation (ADR 0018). */
export interface Resolver {
  readonly analyzerVersion: string
  analyzeGroup(input: AnalyzeGroupInput): AnalyzeGroupOutput
}

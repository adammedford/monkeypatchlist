// Writes (§3 Mechanisms): the native members a node writes, by which mechanism, and what the syntax says about the new
// value. Whether a write is a platform mutation, and its effect, is for the catalog to decide (`effect.ts`).
//
// - `assign`: `h.m = v`, `h["m"] = v`, a bare global `m = v`, and `Reflect.set(h, "m", v)`, whose receiver, when it is
//   given, is the object written: `Reflect.set(h, "m", v, r)` is a [[Set]] of r through h's chain
// - `define-property`, `reflect-define` and `define-properties`: `Object.defineProperty(h, "m", d)`,
//   `Reflect.defineProperty(h, "m", d)` and `Object.defineProperties(h, { m: d, … })`. `h.__defineGetter__("m", g)` and
//   `h.__defineSetter__("m", s)` are a `define-property` of an enumerable, configurable accessor. A descriptor keeps the
//   parts the syntax doesn't show, for the outcome to weigh (§3 Undecidable outcomes).
// - `bulk-assign`: `Object.assign(h, { m: v, … }, …)`. A source's own `__proto__` key calls h's `__proto__` setter, as
//   `h.__proto__ = p` does, so it is a `set-prototype`.
// - `delete`: `delete h.m`, `Reflect.deleteProperty(h, "m")`, and an unqualified `delete m` of a global (§5 post-pass 4)
// - `set-prototype`: `Object.setPrototypeOf(h, p)`, `Reflect.setPrototypeOf(h, p)`, and `h.__proto__ = p` (or
//   `Reflect.set(h, "__proto__", p)`), which calls `Object.prototype.__proto__`'s setter
//
// `h` is an expression that denotes exactly one native holder (§5 Global resolution). A key is a name, or a key that
// folds to a constant (§5 Resolver capabilities 1): `h["add" + "EventListener"]`, `h[method]` with a `const method`,
// `h[0]`, `h[Symbol.iterator]`, converted as ToPropertyKey converts it (§4 Property keys). The native functions a call
// mechanism uses are recognized through the same global resolution: `window.Object.defineProperty(…)` is one too. Each
// write keeps the folds its holder, key and descriptor come from.

import { calleeExpression, setsLiteralPrototype, walkTree, type AstNode } from './ast.ts'
import type { Fold, GlobalResolution, HolderValue, Leaf, ObjectPart, Position, Value } from './global-object.ts'
import { inDocumentOrder, instanceOf, mergedFolds, opaque, sameWindow, truthiness } from './global-object.ts'
import { literalKey, memberName, patternName, toPropertyKey, type Key as MemberKey } from './keys.ts'
import { boundNames, type Declared, type ScopeRules } from './scope.ts'
import type { Caps } from './budget.ts'
import type { Mechanism, RealmInstance } from './types.ts'

/** A native member written, and how: the syntax's reading of the change, before the catalog decides its effect. */
export interface Write {
  /** The write site: the assignment, the `delete`, the call, or for a bulk mechanism the property of its object. */
  site: AstNode
  /** The native holder written, e.g. `Window` or `Array.prototype`. */
  holder: string
  /** The leaves the holder, and the native function a call mechanism uses, were reached from, in document order. */
  leaves: Leaf[]
  /** The window the holder written belongs to (§4 Other windows), from the leaves it was reached from. */
  realmInstance: RealmInstance
  mechanism: Mechanism
  /**
   * The native function that makes the write, by catalog name (`Object.defineProperty`, `Reflect.set`), or its legacy
   * method name (`__defineGetter__`); absent for syntax (`=`, `delete`). It decides whether a write that can't change
   * its target throws (§3 Ineffective writes).
   */
  writer?: string
  change: Change
  /**
   * The folds (§14) the native writer function, the holder, the member and the descriptor's fields come from, in that
   * order, each after the folds it folds.
   */
  folds: Fold[]
  /**
   * The folds the holder written and the member come from, apart: a write inside a helper is looked up at the outermost
   * call whose arguments carry both (§10).
   */
  parts: Parts
  /** Where attribution looks the write up, and its token (§10 lookup point). */
  lookup: WriteLookup
  /** For mechanism `declare`, the declaration that makes the write (§3 Declarations in classic scripts). */
  declaration?: Declaration
  /** For one candidate of a site's candidate set (§5 Candidate sets), the set and the branches it comes from. */
  alternatives?: Alternatives
}

/**
 * A write site's candidate set (§5 Candidate sets, ADR 0019): the holders or members a branch that neither folding nor
 * the catalog settles gives, and the targets they make, each of which is its own finding.
 */
export interface Alternatives {
  /** When the candidates are several holders, the expression whose branches give them, and the holders. */
  holders?: { node: AstNode; names: string[] }
  /**
   * When the candidates are several members, or come from a key whose other alternatives the analyzer can't resolve,
   * the key whose branches give them, the members, the prefixes of its pattern wildcards (§5 Pattern wildcards), and
   * whether it had such other alternatives (`unresolved`) or a heap-read or once-flag boolean, `null` or `undefined` an
   * undecided test gave back, which is never a key (`tested`).
   */
  members?: { node: AstNode; keys: MemberKey[]; prefixes?: string[]; unresolved?: true; tested?: true }
  /** The site's candidate targets, by name: `<holder>.<member>`, or `<holder>.*` for wildcards, in source order. */
  targets: string[]
}

/** The most candidates a site's candidate set gives findings for (§5 Candidate sets, ADR 0019). */
export const maxCandidates = 4

/**
 * A write site whose candidate set has more than `maxCandidates` targets, holders only (§5 Candidate sets): with one
 * member that folds, the candidate `writes` and the `open` write site the patch-shape test reads; with a member that
 * doesn't, the candidate wildcard writes, one per holder. Either gives an `unresolved-holder` limitation at most.
 */
export type WideSite = { site: AstNode; open: OpenWrite; writes: Write[] } | { site: AstNode; wild: WildWrite[] }

/**
 * A declaration that writes a global object's member (§3): how it binds the name (`Declared`), and for a `var`,
 * whether it only binds it, with no initializer and no loop to assign it (`var x;`).
 */
export type Declaration = Declared & { bare?: true }

/**
 * A write site whose member folds to a constant but whose holder may be an object the analyzer can't resolve: one
 * alternative of it, at least, is unknown (§5 Partially resolved writes). Whether it is an `unresolved-holder`
 * limitation is for the site's patch shape and the catalog to decide (`partial.ts`).
 */
export interface OpenWrite {
  /** The write site, as a `Write` of it would give it. */
  site: AstNode
  /** The expression that gives the holder written. */
  holder: AstNode
  mechanism: Mechanism
  change: Exclude<Change, { kind: 'prototype' }>
  /** For an assign, the value written. */
  value?: AstNode
  /** For an assign, the member expression written, which is no read of the original. */
  target?: AstNode
  /** Whether the write is a logical assignment that keeps the member when present (`o.m ||= p`, `o.m ??= p`). */
  keepsPresent?: boolean
}

/**
 * The member of a wildcard write (§5 Partially resolved writes): a key the analyzer can't fold. It names no member, so
 * each member the wildcard matches takes its place when the outcome is judged (`effect.ts`).
 */
export const unknownMember: unique symbol = Symbol('unknown member')

/**
 * A write site whose holder resolves to one native holder but whose key folds to nothing the analyzer knows (§5
 * Partially resolved writes): a wildcard target `<holder>.*` when the same key is reused (`partial.ts`). Its change
 * has `unknownMember` for its member.
 */
export interface WildWrite extends Write {
  /** The expression that gives the key. */
  key: AstNode
  /** The expression that gives the holder written. */
  object: AstNode
  /** For an assign or a delete, the member expression written, which is no read of the original. */
  target?: AstNode
  /** For an assign, the value written. */
  value?: AstNode
  /** Whether the write is a logical assignment that keeps the member when present (`o[k] ||= p`, `o[k] ??= p`). */
  keepsPresent?: boolean
  /**
   * When the key is a candidate set of more than `maxCandidates` members, the members the wildcard's matched set is
   * narrowed to (§5).
   */
  members?: MemberKey[]
  /**
   * When the key folds to a constant prefix that no catalog member of the holder or its catalog prototype chain starts
   * with, the prefix: the write is a pattern wildcard `<holder>.<prefix>*`, a non-native `add` (§5 Pattern wildcards).
   */
  pattern?: string
  /**
   * When the key folds to constant prefixes some catalog member of the holder or its chain starts with, the prefixes:
   * the write is `<holder>.*` under the reuse rule, its matched set narrowed to the members that start with one of
   * them, together with `members` when both are set. Several prefixes at one site give one `<holder>.*`, whose
   * matched set is the members that start with any of them (Principle 3).
   */
  prefixes?: string[]
  /**
   * Whether the prefix is configurable: the key's other alternatives are values the analyzer can't resolve, which give
   * nothing.
   */
  configurable?: true
}

/** The folds the holder written and the member come from. */
export interface Parts {
  holder: readonly Fold[]
  member: readonly Fold[]
}

/**
 * Where attribution looks a write up (§10): the member token written at the site, or else the holder argument, with the
 * token the token check looks for, or null when there is none.
 */
export interface WriteLookup {
  node: AstNode
  token: string | null
}

/**
 * The change a write makes:
 * - `set`: a [[Set]] of a value (`assign`, `bulk-assign`). `same` says the value is a read of the same slot, which
 *   writes back what is there. `through` is the object the member is looked up on when it isn't the one written, as
 *   `Reflect.set(t, k, v, r)` looks k up on t and writes its receiver r (§3).
 * - `define`: a [[DefineOwnProperty]] with a descriptor, as far as the syntax shows it. `via` names the method of the
 *   holder that makes it (`__defineGetter__`), which must be the one `Object.prototype` gives.
 * - `delete`
 * - `prototype`: a new [[Prototype]], with the values it can be. `setter` says it is set through `__proto__`, whose
 *   setter must be the one the prototype chain reaches: `through`'s, when the holder is a `Reflect.set` receiver.
 *   `sameWindow` says the new prototype is one native holder, reached through the same window expression as the holder
 *   written, with nothing between the reads that could change which window that is (§3 Undecidable outcomes): the two
 *   belong to one window.
 */
export type Change =
  | {
      kind: 'set'
      member: MemberKey
      same: boolean
      /**
       * Set when `same` holds only because a heap field carries the read of the slot (`s.orig = window.fetch;
       * window.fetch = s.orig`): the value may be the native saved before an install, so the write is judged as a restore
       * too (§3 Restores).
       */
      throughHeap?: true
      through?: Through | undefined
      value?: WrittenValue
      /** The expression the new value comes from, where it is evaluated, for wrap evidence (§5 capability 10). */
      sources?: Source[]
    }
  | {
      kind: 'define'
      member: MemberKey
      descriptor: DescriptorLiteral
      /**
       * When the descriptor can be several objects the heap holds, or has fields that may be absent (§3, §5 Resolver
       * capabilities 5), every descriptor it can be, the first of which is `descriptor`: `refused` for one that
       * ToPropertyDescriptor refuses, so that nothing is written.
       */
      alternatives?: (DescriptorLiteral | 'refused')[]
      via?: AccessorDefiner
      /** The expression that gives the descriptor, where it is evaluated, for descriptor restores (§3 Restores). */
      source?: Source
    }
  | { kind: 'delete'; member: MemberKey }
  | { kind: 'prototype'; proto: Value[]; setter: boolean; sameWindow: boolean; through?: string | undefined }

/** An expression that gives a written value, and where it is evaluated. */
export interface Source {
  node: AstNode
  at: Position
}

/**
 * What the syntax shows of the value a [[Set]] writes, where its outcome follows the value: `opener`, whose setter
 * redefines it as an own data property for any value but `null` (§3). `isNull` says whether the value is `null`, or
 * `unknown` when the analyzer can't decide it, as for a write-back of what the getter returns, which may be `null`.
 * `site` is the value, or the getter or missing argument that gives it.
 */
export interface WrittenValue {
  isNull: Attribute
  site: AstNode
}

/**
 * The object a `Reflect.set` looks its member up on when it isn't the receiver written (§3): a native holder, or
 * `unresolved`, the argument that denotes no native holder and may be any object.
 */
export type Through = { holder: string } | { unresolved: AstNode }

/** An attribute's value in a descriptor: a boolean, or `unknown` when it can't be decided. */
export type Attribute = boolean | 'unknown'

/**
 * A descriptor as the syntax shows it: the fields an object literal gives it (ECMA-262 ToPropertyDescriptor), and the
 * parts the analyzer can't see (§3 Undecidable outcomes). `value.same` says the value is a read of the slot being
 * defined, and `value.fresh` that it is a new object. `get` and `set` say the literal has the field, whatever value a later part gives it. It never shows both
 * accessor and data fields, which ToPropertyDescriptor refuses.
 */
export interface DescriptorLiteral {
  /**
   * `fresh` says every value it can be is an object or function the code creates, which differs from any value the
   * member holds already.
   */
  value?: { same: boolean; fresh: boolean; sources?: Source[]; throughHeap?: true }
  get: boolean
  set: boolean
  writable?: Attribute
  enumerable?: Attribute
  configurable?: Attribute
  /**
   * The parts that may give the descriptor any field it doesn't have itself, in source order: the descriptor, when it is
   * no object the heap holds; an object's unseen base fields (a `new`, or a native's result such as
   * `getOwnPropertyDescriptor`'s); a spread or a key that doesn't fold, which may also replace the values of the fields before it,
   * so those values are not kept; and a `__proto__: p` field, whose object ToPropertyDescriptor reads for the fields
   * the literal lacks. Empty when every field is seen.
   */
  unseen: AstNode[]
  /** The fields whose attribute can't be decided (`{ enumerable: flag }`, `{ get configurable(){…} }`), in source order. */
  undecided: AstNode[]
  /**
   * For one of several descriptors a define can have, what makes it one: the objects the descriptor can be, when it can
   * be several, and the writes of the fields that may be absent (§3).
   */
  evidence?: AstNode[]
}

/** The native functions that write a member, by catalog name, with their mechanism. */
const nativeWriters: Readonly<Record<string, Mechanism>> = {
  'Object.defineProperty': 'define-property',
  'Reflect.defineProperty': 'reflect-define',
  'Object.defineProperties': 'define-properties',
  'Object.assign': 'bulk-assign',
  'Object.setPrototypeOf': 'set-prototype',
  'Reflect.setPrototypeOf': 'set-prototype',
  'Reflect.set': 'assign',
  'Reflect.deleteProperty': 'delete',
}

/** The legacy methods that define an accessor on their `this` (§3), with the accessor field each gives. */
const accessorDefiners = { __defineGetter__: 'get', __defineSetter__: 'set' } as const
export type AccessorDefiner = keyof typeof accessorDefiners

/** The member names of the native writer functions. */
const writerMembers: ReadonlySet<string> = new Set(
  Object.keys(nativeWriters).map((name) => name.slice(name.indexOf('.') + 1)),
)

/**
 * A native member written: its holder, its name, the window the holder belongs to, and the leaves the holder was reached
 * from, which give its window expression (§3).
 */
interface Slot {
  holder: string
  member: MemberKey
  realmInstance: RealmInstance
  leaves: Leaf[]
  /** The folds the holder and the member come from. */
  folds: Fold[]
}

/** A called method: the member expression a call takes its function from, its string key, and the key's folds. */
interface Method {
  expression: AstNode
  member: string
  folds: Fold[]
}

/** The one native holder an expression denotes, with the leaves it was reached from and the folds it comes from. */
interface Reached {
  holder: string
  leaves: Leaf[]
  folds: Fold[]
}

/** A native function a call uses, by catalog name, with its holder's leaves and the folds its holder and key come from. */
interface NativeFunction {
  name: string
  leaves: Leaf[]
  folds: Fold[]
}

/** A key that folds to a constant, as ToPropertyKey converts it (§4 Property keys), with the folds it comes from. */
interface Key {
  member: MemberKey
  folds: Fold[]
}

export interface WriteContext {
  scope: ScopeRules
  resolution: GlobalResolution
  /** The realm's global holder, e.g. `Window`. */
  global: string
  /** The window whose global object the code's free names are properties of (§4 Other windows). */
  instance: RealmInstance
  /**
   * Raises `analysis-budget` for folds that passed the `fold-length` cap in the key, holder or descriptor of a write
   * that reaches the global object or a native holder, any alternative counting (Principle 5, §13).
   */
  budget(folds: readonly AstNode[]): void
  /**
   * Counts the descriptor-alternatives cap for defines whose descriptor objects have more combinations of maybe-absent
   * fields than it allows, so those fields were read as parts the analyzer can't see, and raises `analysis-budget` when
   * the write reaches the global object or a native holder (Principle 5, §18).
   */
  descriptorsCut(sites: readonly AstNode[], native: boolean): void
  /**
   * Counts the `candidateRuns` cap for a node whose candidate sites it cut, so they give nothing, and raises
   * `analysis-budget` when a holder they write can be the global object or a native holder, any alternative counting
   * (Principle 5, §18).
   */
  candidatesCut(node: AstNode, native: boolean): void
  /**
   * The descriptor fields a native holder supplies as a descriptor's prototype, read through its chain in the unmutated
   * catalog (§3 Undecidable outcomes); undefined when the analyzer can't read them.
   */
  descriptorFields(holder: string): DescriptorFields | undefined
  /** The caps (§18): `heapDepth`, `descriptorAlternatives` and `candidateRuns` here. */
  caps: Pick<Caps, 'heapDepth' | 'descriptorAlternatives' | 'candidateRuns'>
  /** Counts a hit of the `heapDepth` cap at the heap field read it keeps a write-back from being followed through. */
  capHit(name: 'heapDepth', node: AstNode): void
  /**
   * Whether a write of `holder` whose key starts with `prefix` is a pattern wildcard: no catalog member of the holder or
   * its catalog prototype chain starts with it, so it can name or shadow none (§5 Pattern wildcards).
   */
  patternPrefix(holder: string, prefix: string): boolean
}

/**
 * The native members `node` writes directly, in source order. When a fold in the key, holder or descriptor of the write
 * passed the `fold-length` cap, and its holder can be the global object or a native holder, it goes to `budget`, whether
 * or not the write resolves (Principle 5, §13): the value written, and a call's native function, are no part of it.
 */
export function writesAt(node: AstNode, at: Position, context: WriteContext): Write[] {
  return sitesAt(node, at, context).writes
}

/**
 * The native members `node` writes directly, as `writesAt` gives them, and the write sites in it whose member folds
 * but whose holder may be an object the analyzer can't resolve (§5 Partially resolved writes).
 */
export function sitesAt(node: AstNode, where: Position, context: WriteContext): Sites {
  // Whether a holder written can be a native holder: one alternative of it is enough (Principle 3).
  let native = false
  const cuts: AstNode[] = []
  const run: RunWrites = (choice, wildKeys) => {
    const open: OpenWrite[] = []
    const wild: WildWrite[] = []
    const splits = new Map<AstNode, Split>()
    const chooser = { choice, wildKeys, splits }
    const writes = writesOf(node, where, context, (reached) => (native ||= reached), open, cuts, wild, chooser)
    return { writes, open, wild, splits }
  }
  let cut = false
  const { value: sites, capped } = context.resolution.tracked(() => {
    const first = run(new Map(), new Set())
    if (first.splits.size === 0) return { ...first, wide: [] }
    return candidateSites(first, run, context.caps.candidateRuns, () => (cut = true))
  })
  if (cut) context.candidatesCut(node, native)
  if (native && capped.length > 0) context.budget(capped)
  if (cuts.length > 0) context.descriptorsCut([...new Set(cuts)], native)
  return sites
}

/** The write sites at a node (`sitesAt`). */
export interface Sites {
  writes: Write[]
  open: OpenWrite[]
  wild: WildWrite[]
  wide: WideSite[]
}

/**
 * One alternative of a branch a site's holder or key comes from: a native holder, a key that folds, or, for a key whose
 * candidates are taken as a wildcard's, none.
 */
type Chosen =
  | { kind: 'holder'; reached: Reached }
  | { kind: 'key'; key: Key; unresolved: boolean; tested: boolean }
  | { kind: 'prefix'; prefix: string; unresolved: boolean; tested: boolean }

/**
 * A holder or key with several candidates, which a run of `writesOf` meets (§5 Candidate sets). A key whose
 * alternatives mix constants and values the analyzer can't resolve (`unresolved`) has its constants as candidates,
 * even only one. A key that folds to a constant prefix has the prefix as a
 * candidate too (§5 Pattern wildcards). A key that lost a heap-read or once-flag boolean, `null` or `undefined` an
 * undecided test gave back (`tested`) keeps its constants as candidates in the same way.
 */
type Split =
  | { kind: 'holder'; holders: Reached[] }
  | { kind: 'key'; keys: Key[]; prefixes: string[]; unresolved: boolean; tested: boolean }

/**
 * How a run of `writesOf` takes the branches of a site's holders and keys: the alternative `choice` takes for each
 * one met before, the keys `wildKeys` takes as unknown, and the branches it meets that `choice` doesn't decide, in the
 * order it meets them, each of which it takes as its first alternative.
 */
interface Chooser {
  choice: ReadonlyMap<AstNode, Chosen>
  wildKeys: ReadonlySet<AstNode>
  splits: Map<AstNode, Split>
}

interface Run {
  writes: Write[]
  open: OpenWrite[]
  wild: WildWrite[]
  splits: Map<AstNode, Split>
}

type RunWrites = (choice: ReadonlyMap<AstNode, Chosen>, wildKeys: ReadonlySet<AstNode>) => Run

/**
 * Every run of `writesOf` that decides each branch it meets, one per combination of alternatives, in source order.
 * Undefined past `maxRuns` runs (the `candidateRuns` cap).
 */
function enumerated(
  first: Run,
  run: RunWrites,
  wildKeys: ReadonlySet<AstNode>,
  maxRuns: number,
): { run: Run; choice: ReadonlyMap<AstNode, Chosen> }[] | undefined {
  const done: { run: Run; choice: ReadonlyMap<AstNode, Chosen> }[] = []
  const stack: [ReadonlyMap<AstNode, Chosen>, Run | undefined][] = [[new Map(), first]]
  let runs = 0
  while (stack.length > 0) {
    const [choice, given] = stack.pop()!
    if (++runs > maxRuns) return undefined
    const result = given ?? run(choice, wildKeys)
    const fresh = [...result.splits].find(([node]) => !choice.has(node))
    if (fresh === undefined) {
      done.push({ run: result, choice })
      continue
    }
    const [node, split] = fresh
    const alternatives: Chosen[] =
      split.kind === 'holder'
        ? split.holders.map((reached) => ({ kind: 'holder', reached }))
        : [
            ...split.keys.map((key): Chosen => ({ kind: 'key', key, unresolved: split.unresolved, tested: split.tested })),
            ...split.prefixes.map(
              (prefix): Chosen => ({ kind: 'prefix', prefix, unresolved: split.unresolved, tested: split.tested }),
            ),
          ]
    for (const chosen of alternatives.reverse()) stack.push([new Map([...choice, [node, chosen]]), undefined])
  }
  return done
}

/** The name of the target a write names, before the catalog decides its outcome. */
export function candidateName(write: Write): string {
  const { change } = write
  if (change.kind === 'prototype') return `${write.holder}.[[Prototype]]`
  const { pattern } = write as Partial<WildWrite>
  if (pattern !== undefined) return patternName(write.holder, pattern)
  return change.member === unknownMember ? `${write.holder}.*` : memberName(write.holder, change.member)
}

/** The member a write names, as a candidate: a key, or the prototype. */
const candidateMember = (write: Write): MemberKey | typeof unknownMember =>
  write.change.kind === 'prototype' ? '[[Prototype]]' : write.change.member

/**
 * The write sites at a node whose holder or key has several candidates (§5 Candidate sets, ADR 0019): every
 * combination of alternatives is a run of `writesOf`, and each site's candidate set is the targets those runs give it,
 * the cross product of its holders and members, capped on distinct targets:
 * - up to `maxCandidates` targets give one write each, which carries its candidate set
 * - more, with one member that folds, are a `WideSite`, an `unresolved-holder` limitation at most (§5)
 * - more, with several members and at most `maxCandidates` holders, give a wildcard per holder, its matched set
 *   narrowed to the members; with more holders, nothing
 * - wildcard writes, whose key doesn't fold, on up to `maxCandidates` holders give one each, and on more a `WideSite`
 * Past `maxRuns` runs (the `candidateRuns` cap), the sites the runs decide give nothing, and `cut` hears it.
 */
function candidateSites(first: Run, run: RunWrites, maxRuns: number, cut: () => void): Sites {
  const complete = enumerated(first, run, new Set(), maxRuns)
  if (complete === undefined) {
    cut()
    return { writes: [], open: [], wild: [], wide: [] }
  }
  type Candidate<W> = { write: W; choice: ReadonlyMap<AstNode, Chosen> }
  const sites = new Map<AstNode, { named: Candidate<Write>[]; wild: Candidate<WildWrite>[]; open: OpenWrite[] }>()
  const siteOf = (site: AstNode) => {
    let found = sites.get(site)
    if (found === undefined) sites.set(site, (found = { named: [], wild: [], open: [] }))
    return found
  }
  for (const { run: each, choice } of complete) {
    for (const write of each.writes) siteOf(write.site).named.push({ write, choice })
    for (const write of each.wild) siteOf(write.site).wild.push({ write, choice })
    for (const write of each.open) {
      const { open } = siteOf(write.site)
      if (!open.some((other) => other.change.member === write.change.member)) open.push(write)
    }
  }

  /**
   * The branch a candidate's holder or member comes from: the first branch of its kind whose choice gives it. A pattern
   * wildcard's member comes from the branch that gives its prefix.
   */
  const branchOf = (
    choice: ReadonlyMap<AstNode, Chosen>,
    holder: string | undefined,
    member?: MemberKey,
    prefix?: string,
  ): AstNode | undefined => {
    for (const [node, chosen] of choice) {
      if (holder !== undefined && chosen.kind === 'holder' && chosen.reached.holder === holder) return node
      if (member !== undefined && chosen.kind === 'key' && chosen.key.member === member) return node
      if (prefix !== undefined && chosen.kind === 'prefix' && chosen.prefix === prefix) return node
    }
    return undefined
  }
  /**
   * The candidates of a site, one per target, the first run's that gives it. The `<holder>.*` of several prefixes some
   * catalog member starts with is one target, narrowed to the members that start with any of them (Principle 3).
   */
  const byTarget = <W extends Write>(candidates: readonly Candidate<W>[]): Map<string, Candidate<W>> => {
    const out = new Map<string, Candidate<W>>()
    for (const candidate of candidates) {
      const name = candidateName(candidate.write)
      const first = out.get(name)
      if (first === undefined) out.set(name, candidate)
      else {
        const prefixes = (first.write as Partial<WildWrite>).prefixes
        const more = (candidate.write as Partial<WildWrite>).prefixes
        if (prefixes === undefined || more === undefined) continue
        const merged = [...new Set([...prefixes, ...more])]
        if (merged.length > prefixes.length) out.set(name, { ...first, write: { ...first.write, prefixes: merged } })
      }
    }
    return out
  }
  /** The prefix of a candidate that is a pattern wildcard (§5 Pattern wildcards). */
  const patternOf = (write: Write): string | undefined => (write as Partial<WildWrite>).pattern
  /**
   * The prefix a candidate's member comes from: a pattern wildcard's, or the first of a `<holder>.*` narrowed to the
   * members that start with its prefixes (§5 Pattern wildcards).
   */
  const prefixOf = (write: Write): string | undefined =>
    patternOf(write) ?? (write as Partial<WildWrite>).prefixes?.[0]
  /** The key alternative a candidate's member comes from, if any. */
  const keyChosen = (choice: ReadonlyMap<AstNode, Chosen>, write: Write): Extract<Chosen, { kind: 'key' | 'prefix' }> | undefined => {
    const member = candidateMember(write)
    const prefix = prefixOf(write)
    return [...choice.values()].find(
      (chosen): chosen is Extract<Chosen, { kind: 'key' | 'prefix' }> =>
        (chosen.kind === 'key' && prefix === undefined && chosen.key.member === member) ||
        (chosen.kind === 'prefix' && chosen.prefix === prefix),
    )
  }
  /** Whether a candidate's member comes from a key that also has alternatives the analyzer can't resolve. */
  const unresolvedKey = (choice: ReadonlyMap<AstNode, Chosen>, write: Write): boolean =>
    keyChosen(choice, write)?.unresolved === true
  /**
   * Whether a candidate's member comes from a key that lost a heap-read or once-flag boolean, `null` or `undefined` an
   * undecided test gave back.
   */
  const testedKey = (choice: ReadonlyMap<AstNode, Chosen>, write: Write): boolean => keyChosen(choice, write)?.tested === true
  /**
   * The candidates of a site, named and wildcard together: their targets, the members they name, and the prefixes
   * their wildcards come from (§5 Pattern wildcards).
   */
  type Together = { targets: string[]; keys: MemberKey[]; prefixes: string[] }
  const together = (...groups: Map<string, Candidate<Write>>[]): Together => {
    const candidates = groups.flatMap((group) => [...group.values()])
    const keys = new Set<MemberKey>()
    const prefixes = new Set<string>()
    for (const { write } of candidates) {
      const pattern = patternOf(write)
      const member = candidateMember(write)
      if (pattern !== undefined) prefixes.add(pattern)
      else if (member !== unknownMember) keys.add(member)
      for (const prefix of (write as Partial<WildWrite>).prefixes ?? []) prefixes.add(prefix)
    }
    return { targets: groups.flatMap((group) => [...group.keys()]), keys: [...keys], prefixes: [...prefixes] }
  }
  /**
   * The candidates with their candidate set, when the site has more than one, or when a member comes from a key with
   * alternatives the analyzer can't resolve, which keeps `member-alternatives` even alone, as a
   * configurable prefix does.
   */
  const tagged = <W extends Write>(targets: Map<string, Candidate<W>>, site: Together, members?: MemberKey[]): W[] => {
    const candidates = [...targets.values()]
    const holders = [...new Set(candidates.map(({ write }) => write.holder))]
    const keys = members ?? site.keys
    const prefixes = members === undefined ? site.prefixes : []
    const mixed =
      members === undefined && candidates.some(({ write, choice }) => unresolvedKey(choice, write) || testedKey(choice, write))
    if (site.targets.length < 2 && !mixed) return candidates.map(({ write }) => write)
    return candidates.map(({ write, choice }) => {
      const holderNode = holders.length > 1 ? branchOf(choice, write.holder) : undefined
      const member = candidateMember(write)
      const prefix = prefixOf(write)
      const unresolved = members === undefined && unresolvedKey(choice, write)
      const tested = members === undefined && testedKey(choice, write)
      const memberNode =
        members === undefined && (keys.length + prefixes.length > 1 || unresolved || tested)
          ? prefix !== undefined
            ? branchOf(choice, undefined, undefined, prefix)
            : member !== unknownMember
              ? branchOf(choice, undefined, member)
              : undefined
          : undefined
      const alternatives: Alternatives = {
        ...(holderNode === undefined ? {} : { holders: { node: holderNode, names: holders } }),
        ...(memberNode === undefined
          ? {}
          : {
              members: {
                node: memberNode,
                keys: [...keys],
                ...(prefixes.length === 0 ? {} : { prefixes }),
                ...(unresolved ? { unresolved: true as const } : {}),
                ...(tested ? { tested: true as const } : {}),
              },
            }),
        targets: site.targets,
      }
      return { ...write, alternatives }
    })
  }

  const writes: Write[] = []
  const open: OpenWrite[] = []
  const wild: WildWrite[] = []
  const wide: WideSite[] = []
  // The sites whose candidates are taken as a wildcard per holder, with the members each is narrowed to, and the
  // prefixes some catalog member starts with whose members it is narrowed to as well.
  const narrowed = new Map<AstNode, { members: MemberKey[]; prefixes: string[] }>()
  for (const [site, { named, wild: wilds, open: opens }] of sites) {
    let keepOpen = true
    const namedTargets = byTarget(named)
    const wildTargets = byTarget(wilds)
    if (
      wilds.some(({ write }) => write.pattern !== undefined || write.prefixes !== undefined) &&
      namedTargets.size + [...wildTargets.values()].reduce((sum, { write }) => sum + (write.prefixes?.length ?? 1), 0) > maxCandidates
    ) {
      // More than 4 constants and prefixes follow the wildcard rule, narrowed to the candidates (§5 Candidate sets):
      // to the constants and the members that start with a prefix, which a pattern's prefix narrows to none.
      const holders = new Set([...named, ...wilds].map(({ write }) => write.holder))
      const members = [...new Set(named.map(({ write }) => candidateMember(write)))] as MemberKey[]
      const prefixes = [...new Set(wilds.flatMap(({ write }) => write.prefixes ?? []))]
      if (members.length + prefixes.length > 0 && holders.size <= maxCandidates) narrowed.set(site, { members, prefixes })
      continue
    }
    // A key whose alternatives are constants and prefixes gives both: one candidate set (§5 Pattern wildcards).
    const candidateSet = together(
      ...(namedTargets.size <= maxCandidates ? [namedTargets] : []),
      ...(wildTargets.size <= maxCandidates ? [wildTargets] : []),
    )
    if (named.length > 0) {
      const targets = namedTargets
      const holders = new Set(named.map(({ write }) => write.holder))
      const members = [...new Set(named.map(({ write }) => candidateMember(write)))] as MemberKey[]
      if (targets.size <= maxCandidates) writes.push(...tagged(targets, candidateSet))
      else if (members.length === 1) {
        // One member on more holders than the cap: an `unresolved-holder` limitation at most (§5).
        const [first] = opens
        if (first !== undefined) wide.push({ site, open: first, writes: [...targets.values()].map(({ write }) => write) })
        keepOpen = false
      } else {
        if (holders.size <= maxCandidates) narrowed.set(site, { members, prefixes: [] })
        keepOpen = false
      }
    }
    if (wilds.length > 0) {
      const targets = wildTargets
      if (targets.size <= maxCandidates) wild.push(...tagged(targets, candidateSet))
      else wide.push({ site, wild: [...targets.values()].map(({ write }) => write) })
    }
    if (keepOpen) open.push(...opens)
  }
  if (narrowed.size > 0) {
    // The same runs, with each key that has several candidates taken as unknown, give the wildcards.
    const keys = new Set(
      complete.flatMap(({ choice }) => [...choice].flatMap(([node, chosen]) => (chosen.kind === 'holder' ? [] : [node]))),
    )
    const wildRuns = enumerated(run(new Map(), keys), run, keys, maxRuns)
    if (wildRuns === undefined) cut()
    const found = new Map<AstNode, Candidate<WildWrite>[]>()
    for (const { run: each, choice } of wildRuns ?? []) {
      for (const write of each.wild) {
        if (!narrowed.has(write.site)) continue
        const list = found.get(write.site)
        if (list === undefined) found.set(write.site, [{ write, choice }])
        else list.push({ write, choice })
      }
    }
    for (const [site, candidates] of found) {
      const { members, prefixes } = narrowed.get(site)!
      const narrowing = prefixes.length === 0 ? { members } : { members, prefixes }
      const targets = byTarget(candidates.map(({ write, choice }) => ({ write: { ...write, ...narrowing }, choice })))
      wild.push(...tagged(targets, together(targets), members))
    }
  }
  return { writes, open, wild, wide }
}

/**
 * The writes `node` makes. `reachesNative` hears whether each holder a write is made on (not a value, nor a call's
 * native function) can be a native holder.
 */
function writesOf(
  node: AstNode,
  where: Position,
  context: WriteContext,
  reachesNative: (reached: boolean) => void,
  open: OpenWrite[],
  cuts: AstNode[],
  wild: WildWrite[],
  chooser: Chooser,
): Write[] {
  const { scope, global } = context
  // Where the write's parts are evaluated: at the write, or where a heap field's value is (`evaluatedAt`).
  let at = where
  const evaluatedAt = <T>(position: Position, run: () => T): T => {
    const saved = at
    at = position
    try {
      return run()
    } finally {
      at = saved
    }
  }

  /**
   * An evaluation that is no part of the write's key, holder or descriptor: the value written, or the native function a
   * call uses. The folds it finds too long are only counted.
   */
  let apartDepth = 0
  const apart = <T>(run: () => T): T => {
    apartDepth++
    try {
      return context.resolution.tracked(run, true).value
    } finally {
      apartDepth--
    }
  }

  /**
   * The one native holder an expression denotes, with its leaves and folds. Several are a candidate set (§5): the
   * alternative the run's choice takes, or else the first, the branch going to the chooser. A value or a call's native
   * function (`apart`) has none. `single` takes several as none, as for the object a `Reflect.set` looks its member up
   * on when it writes another.
   */
  const holderOf = (expression: AstNode, unresolved?: () => void, single = false): Reached | undefined => {
    const values = context.resolution.evaluate(expression, at)
    const holders = values.filter((value): value is HolderValue => value.kind === 'holder')
    if (apartDepth === 0) reachesNative(holders.length > 0)
    // An alternative the analyzer can't resolve may be any object (§5 Partially resolved writes).
    const unknown = values.some(opaque)
    if (unresolved !== undefined && unknown) unresolved()
    const reached = ({ holder, leaves, folds = [] }: HolderValue): Reached => ({ holder, leaves: inDocumentOrder(leaves), folds })
    if (holders.length === 1) return reached(holders[0]!)
    if (holders.length === 0 || apartDepth > 0 || single) return undefined
    const chosen = chooser.choice.get(expression)
    if (chosen?.kind === 'holder') {
      // More holders than the cap with one member are an open write site too (§5 Candidate sets).
      if (unresolved !== undefined && !unknown && holders.length > maxCandidates) unresolved()
      return chosen.reached
    }
    if (!chooser.splits.has(expression)) chooser.splits.set(expression, { kind: 'holder', holders: holders.map(reached) })
    return reached(holders[0]!)
  }

  /**
   * A key that folds to a constant: a literal, a template literal, a `+`, a `const`, converted as ECMA-262
   * ToPropertyKey converts it (§4 Property keys): `0` and `"0"` are the same key. Several constants are a candidate
   * set (§5), taken as `holderOf` takes several holders; a value or a call's native function (`apart`) takes only one.
   * A key whose alternatives mix constants and values the analyzer can't resolve has its constants as candidates, even
   * one alone, and the unknown part gives nothing.
   */
  const constantKey = (key: AstNode): Key | undefined => {
    const values = keyValues(key)
    if (apartDepth > 0) {
      const [value] = values
      if (values.length !== 1 || value?.kind !== 'constant') return undefined
      return { member: toPropertyKey(value.value), folds: value.folds ?? [] }
    }
    if (chooser.wildKeys.has(key)) return undefined
    const chosen = keyChoice(key)
    return chosen?.kind === 'key' ? chosen.key : undefined
  }

  /**
   * The alternative of a key a run takes: a constant (`constantKey`), or a constant prefix a string the analyzer can't
   * fold whole starts with (§5 Pattern wildcards); undefined when the key has neither, or is no key at all (an object).
   * Several are a candidate set, and so is one beside values the analyzer can't resolve, which give nothing.
   */
  const keyChoice = (key: AstNode): Extract<Chosen, { kind: 'key' | 'prefix' }> | undefined => {
    const values = keyValues(key)
    const tested = testedKeys.has(key)
    const keys: Key[] = []
    const prefixes: string[] = []
    let unresolved = false
    for (const value of values) {
      if (value.kind === 'unknown' && value.prefix !== undefined) {
        if (!prefixes.includes(value.prefix)) prefixes.push(value.prefix)
        continue
      }
      if (opaque(value)) {
        unresolved = true
        continue
      }
      if (value.kind !== 'constant') return undefined
      const member = toPropertyKey(value.value)
      if (!keys.some((each) => each.member === member)) keys.push({ member, folds: value.folds ?? [] })
    }
    // With no constant, a key the analyzer can't resolve is a wildcard's (§5 Partially resolved writes).
    if (keys.length + prefixes.length === 0) return undefined
    const first = (): Extract<Chosen, { kind: 'key' | 'prefix' }> =>
      keys.length > 0
        ? { kind: 'key', key: keys[0]!, unresolved, tested }
        : { kind: 'prefix', prefix: prefixes[0]!, unresolved, tested }
    if (keys.length + prefixes.length === 1 && !unresolved && !tested) return first()
    const chosen = chooser.choice.get(key)
    if (chosen?.kind === 'key' || chosen?.kind === 'prefix') return chosen
    if (!chooser.splits.has(key)) chooser.splits.set(key, { kind: 'key', keys, prefixes, unresolved, tested })
    return first()
  }

  /**
   * The values a key can have, evaluated once where the write is, so that a key read again to tell whether it is
   * unknown counts no cap twice (§18).
   */
  let lastKey: { node: AstNode; at: Position; values: Value[] } | undefined
  // The keys that lost such a value, whose other constants keep `member-alternatives`.
  const testedKeys = new Set<AstNode>()
  const keyValues = (key: AstNode): Value[] => {
    if (lastKey?.node === key && lastKey.at === at) return lastKey.values
    // A heap-read or once-flag boolean, `null` or `undefined` an undecided test gives back is never a key (§5 Candidate
    // sets).
    const evaluated = context.resolution.evaluate(key, at)
    const values = evaluated.filter((value) => value.kind !== 'constant' || value.tested !== true)
    if (values.length < evaluated.length) testedKeys.add(key)
    lastKey = { node: key, at, values }
    return values
  }

  /** Whether a key folds to nothing the analyzer knows: every value it can have is unknown (§5 Partially resolved writes). */
  const unknownKey = (key: AstNode): boolean => {
    if (chooser.wildKeys.has(key)) return true
    const chosen = keyChoice(key)
    if (chosen !== undefined) return chosen.kind === 'prefix'
    const values = keyValues(key)
    return values.length > 0 && values.every(opaque)
  }

  /** A wildcard write of `holder`'s member `key`, as the write `site` makes it, with what the syntax shows of it. */
  const wildWrite = (
    site: AstNode,
    reached: Reached,
    object: AstNode,
    key: AstNode,
    mechanism: Mechanism,
    change: Change,
    lookup: WriteLookup,
    extra: Pick<WildWrite, 'writer' | 'target' | 'value' | 'keepsPresent'> & { leaves?: Leaf[]; folds?: Fold[] } = {},
  ): void => {
    const { leaves = reached.leaves, folds = [], ...rest } = extra
    // A key that folds to a constant prefix (§5 Pattern wildcards): a pattern wildcard when no catalog member of the
    // holder or its chain starts with it, otherwise `<holder>.*` narrowed to the members that do.
    const chosen = chooser.wildKeys.has(key) ? undefined : keyChoice(key)
    const prefixed =
      chosen?.kind !== 'prefix'
        ? {}
        : {
            ...(context.patternPrefix(reached.holder, chosen.prefix) ? { pattern: chosen.prefix } : { prefixes: [chosen.prefix] }),
            ...(chosen.unresolved ? { configurable: true as const } : {}),
          }
    wild.push({
      site,
      holder: reached.holder,
      leaves,
      realmInstance: instanceOf(reached.leaves),
      mechanism,
      change,
      folds: [...folds, ...reached.folds],
      parts: { holder: reached.folds, member: [] },
      lookup,
      key,
      object,
      ...prefixed,
      ...rest,
    })
  }

  /** The member a member expression names: `h.m`, or `h[k]` with a key that folds to a constant. */
  const memberKey = (member: AstNode): Key | undefined => {
    const property = member['property'] as AstNode
    if (member['computed'] === true) return constantKey(property)
    return property.type === 'Identifier' ? { member: property['name'] as string, folds: [] } : undefined
  }

  /** A property's key in an object literal: a name, a string or number literal, or a computed key that folds. */
  const propertyKey = (property: AstNode): Key | undefined => {
    const key = property['key'] as AstNode
    if (property['computed'] === true) return constantKey(key)
    if (key.type === 'Identifier') return { member: key['name'] as string, folds: [] }
    const member = literalKey(key)
    return member === undefined ? undefined : { member, folds: [] }
  }

  /**
   * The native member an assignment target or a `delete` operand denotes: a bare global, or a holder's member, with the
   * leaves its holder was reached from.
   */
  const memberOf = (
    target: AstNode,
    unresolved?: (object: AstNode, key: Key) => void,
    wildcard?: (object: AstNode, key: AstNode, reached: Reached) => void,
  ): (Slot & { parts: Parts; lookup: WriteLookup }) | undefined => {
    if (target.type === 'Identifier') {
      const leaf = bareGlobal(target, scope, context.instance)
      if (leaf === undefined) return undefined
      const lookup = { node: target, token: leaf.name }
      const parts = { holder: [], member: [] }
      return { holder: global, member: leaf.name, realmInstance: leaf.instance, leaves: [leaf], folds: [], parts, lookup }
    }
    if (target.type !== 'MemberExpression' || (target['object'] as AstNode).type === 'Super') return undefined
    const { value: key, capped } = context.resolution.tracked(() => memberKey(target))
    const object = target['object'] as AstNode
    // A key the analyzer knows nothing of, on one native holder, may be a wildcard write (§5).
    if (key === undefined && capped.length === 0 && wildcard !== undefined && target['computed'] === true) {
      const property = target['property'] as AstNode
      if (!unknownKey(property)) return undefined
      const reached = holderOf(object)
      if (reached !== undefined) wildcard(object, property, reached)
      return undefined
    }
    // A key too long to fold still cuts the write when its holder is native (Principle 5).
    const reached =
      key === undefined && capped.length === 0
        ? undefined
        : holderOf(object, key === undefined || unresolved === undefined ? undefined : () => unresolved(object, key))
    if (reached === undefined || key === undefined) return undefined
    const { holder, leaves } = reached
    const folds = [...reached.folds, ...key.folds]
    // A write with no member, `h.__proto__ = p`, looks up its holder.
    const lookup = key.member === '__proto__' ? holderLookup(object) : memberLookup(target, object)
    const parts = { holder: reached.folds, member: key.folds }
    return { holder, member: key.member, realmInstance: instanceOf(leaves), leaves, folds, parts, lookup }
  }

  /**
   * The lookup of a member expression's write: its member token when the member is written at the site, as a name
   * (`h.m`), a string (`h["m"]`) or a template with no substitutions. A computed member (`h[k]`) or a number
   * (`h[0]`) has no token, and its holder is looked up.
   */
  const memberLookup = (member: AstNode, object: AstNode): WriteLookup => {
    const property = member['property'] as AstNode
    if (member['computed'] !== true) return { node: property, token: property['name'] as string }
    const written = writtenString(property)
    return written === undefined ? { node: object, token: null } : { node: property, token: written }
  }

  /**
   * The lookup of a write at its holder argument (§10): its token is its name only when it is written as a free global
   * (`window`) or a literal property name (`history` in `window.history`), never as a local binding.
   */
  const holderLookup = (holder: AstNode): WriteLookup => {
    const expression = holder.type === 'ChainExpression' ? (holder['expression'] as AstNode) : holder
    if (expression.type === 'Identifier') {
      return { node: holder, token: scope.resolve(expression) === 'local' ? null : (expression['name'] as string) }
    }
    if (expression.type !== 'MemberExpression') return { node: holder, token: null }
    const property = expression['property'] as AstNode
    const token = expression['computed'] === true ? writtenString(property) : (property['name'] as string)
    return { node: holder, token: token ?? null }
  }

  /**
   * The lookup of an object literal's property in a bulk mechanism: its key when written as a name or a string
   * (`fetch: w`, `'fetch': w`, `['fetch']: w`, or a template with no substitutions, as `h['fetch']` is for a member).
   * Any other key, a number included, has no token, and the holder argument is looked up.
   */
  const propertyLookup = (property: AstNode, object: AstNode): WriteLookup => {
    const key = property['key'] as AstNode
    if (property['computed'] !== true && key.type === 'Identifier') return { node: key, token: key['name'] as string }
    const written = writtenString(key)
    return written === undefined ? { node: object, token: null } : { node: key, token: written }
  }

  /**
   * The lookup of a call's key argument (`defineProperty(h, 'fetch', d)`, `Reflect.set(h, 'fetch', v)`): the key when
   * it is written at the site as a string or a template with no substitutions. Any other key has no token, and the
   * holder argument `object` is looked up.
   */
  const keyLookup = (key: AstNode, object: AstNode): WriteLookup => {
    const written = writtenString(key)
    return written === undefined ? { node: object, token: null } : { node: key, token: written }
  }

  /**
   * Whether `value` reads the slot being written: `h.m` of the same holder and member, or the bare global `m`. The same
   * member of two windows is two slots, so the read must reach the member through the same window expression as the
   * write (§3 Undecidable outcomes), with nothing in `evaluated`, the expressions the write evaluates, changing which
   * window that is.
   */
  const readsSlot = (value: AstNode, written: Slot, evaluated: readonly AstNode[], depth = 0): boolean => {
    const read = value.type === 'ChainExpression' ? (value['expression'] as AstNode) : value
    const slot = read.type === 'Identifier' || read.type === 'MemberExpression' ? apart(() => memberOf(read)) : undefined
    if (slot === undefined) {
      // A field of objects the heap holds reads the slot when every value written to it does (§5 Resolver
      // capabilities 5): `s.orig = window.fetch; window.fetch = s.orig` writes back.
      if (read.type !== 'MemberExpression') return false
      if (depth >= context.caps.heapDepth) {
        context.capHit('heapDepth', read)
        return false
      }
      const sources = apart(() => context.resolution.fieldSources(read, at))
      return (
        sources !== undefined &&
        sources.every((source) =>
          evaluatedAt(source.at, () => readsSlot(source.node, written, [...evaluated, source.node], depth + 1)),
        )
      )
    }
    return slot.holder === written.holder && slot.member === written.member && sameWindow(slot.leaves, written.leaves, evaluated)
  }

  /** Whether a value that reads the slot reads it through a heap field, not as `h.m` or the bare global (`readsSlot`). */
  const throughHeap = (value: AstNode): boolean => {
    const read = value.type === 'ChainExpression' ? (value['expression'] as AstNode) : value
    return read.type === 'MemberExpression' && apart(() => memberOf(read)) === undefined
  }

  /**
   * What the syntax shows of the value a [[Set]] of `member` writes, for the one member whose outcome follows it
   * (`opener`, §3): whether it is `null`. `value` is the expression written, `getter` when a getter gives the value, or
   * `primitive` when the write computes a new primitive or writes a missing argument's `undefined`, neither ever
   * `null`. A write-back of the slot may be `null` whatever the resolver finds, since the getter may return `null`.
   */
  const writtenValue = (
    member: MemberKey,
    value: AstNode | 'getter' | 'primitive',
    site: AstNode,
    same: boolean,
  ): { value?: WrittenValue } => {
    if (member !== 'opener') return {}
    if (value === 'primitive') return { value: { isNull: false, site } }
    if (value === 'getter' || same) return { value: { isNull: 'unknown', site } }
    const values = apart(() => context.resolution.evaluate(value, at))
    const isNull = (each: Value): boolean => each.kind === 'constant' && each.value === null
    const known = values.length > 0 && values.every((each) => !opaque(each))
    const decided = known && values.every(isNull) ? true : known && !values.some(isNull) ? false : 'unknown'
    return { value: { isNull: decided, site } }
  }

  /** Whether `node` is plainly a primitive: every value it can have is a constant. */
  const primitive = (node: AstNode): boolean =>
    context.resolution.evaluate(node, at).every((value) => value.kind === 'constant')

  /**
   * The descriptors `node` gives, as far as the analyzer sees them (§3 Undecidable outcomes): for each object the heap
   * holds that it can be (§5 Resolver capabilities 5), its parts, with every field that may be absent present and
   * absent in turn, and the parts the analyzer can't see. Anything else is one descriptor with no field seen.
   * Undefined when ECMA-262 ToPropertyDescriptor refuses every one with a TypeError, so nothing is written (Principle
   * 1): a primitive, a literal with both accessor and data fields, or one whose `get` or `set` is a primitive other
   * than `undefined`. `slot` is the slot defined, when its key folds. The folds the fields' keys and attributes come
   * from go to `folds`.
   */
  const descriptorOf = (
    node: AstNode,
    slot: Slot | undefined,
    evaluated: readonly AstNode[],
    folds: Fold[],
  ): { descriptor: DescriptorLiteral; alternatives?: (DescriptorLiteral | 'refused')[] } | undefined => {
    const { objects, primitive: mayBePrimitive, unseen } = context.resolution.descriptorValues(node, at)
    if (objects.length === 0) return unseen ? { descriptor: unseenDescriptor(node) } : undefined
    // Every value the descriptor can be is an alternative (Principle 3): each object the heap holds, a value the
    // analyzer can't see, which is one unseen descriptor, and a primitive, which ToPropertyDescriptor refuses.
    const several = objects.length > 1 || unseen || mayBePrimitive
    const alternatives: (DescriptorLiteral | 'refused')[] = []
    const found: Fold[] = []
    for (const { node: object, parts } of objects) {
      const shown = presentOrAbsent(parts, context.caps.descriptorAlternatives)
      // Past the cap, the fields that may be absent are taken as parts the analyzer can't see (Principle 5).
      if (shown === undefined && !cuts.includes(node)) cuts.push(node)
      const each = shown ?? [parts.map((part): ObjectPart => (isMaybe(part) ? { kind: 'unseen', node: part.maybe } : part))]
      const evidence = [
        ...(several ? [object] : []),
        ...(shown === undefined ? [] : parts.filter(isMaybe).map((part) => part.maybe)),
      ]
      for (const [alternative, split] of each.flatMap(byPrototype)) {
        const descriptor = fromParts(alternative, slot, evaluated, found)
        const all = split === undefined ? evidence : [...evidence, split]
        alternatives.push(descriptor === undefined ? 'refused' : all.length === 0 ? descriptor : { ...descriptor, evidence: all })
      }
    }
    if (unseen) alternatives.push({ ...unseenDescriptor(node), evidence: [node] })
    if (mayBePrimitive) alternatives.push('refused')
    const [descriptor] = alternatives.filter((each): each is DescriptorLiteral => each !== 'refused')
    if (descriptor === undefined) return undefined
    folds.push(...mergedFolds([], found))
    return alternatives.length === 1 ? { descriptor } : { descriptor, alternatives }
  }

  /**
   * The parts of one descriptor per candidate of its `__proto__:` field, when the field has several candidates and every
   * one is a catalog holder, each with the field as what makes it one (§3, §5 Candidate sets). Otherwise the parts
   * as they are: a candidate set with any other value stays unseen.
   */
  const byPrototype = (parts: ObjectPart[]): [ObjectPart[], AstNode | undefined][] => {
    const index = parts.findIndex((part) => part.kind === 'proto')
    const proto = parts[index]
    if (proto?.kind !== 'proto' || !proto.values.every((value) => value.kind === 'holder')) return [[parts, undefined]]
    const candidates = new Map<string, Value>()
    for (const value of proto.values) if (value.kind === 'holder' && !candidates.has(value.holder)) candidates.set(value.holder, value)
    if (candidates.size < 2) return [[parts.with(index, { ...proto, values: [...candidates.values()] }), undefined]]
    return [...candidates.values()].map((value) => [parts.with(index, { ...proto, values: [value] }), proto.site])
  }

  /** A descriptor as `parts` give it, or undefined when ToPropertyDescriptor refuses it (`descriptorOf`). */
  const fromParts = (
    parts: readonly ObjectPart[],
    slot: Slot | undefined,
    evaluated: readonly AstNode[],
    folds: Fold[],
  ): DescriptorLiteral | undefined => {
    let descriptor = unseenDescriptor()
    // The fields whose attribute can't be decided, the folds of the fields read, and the accessor fields that are plainly
    // not callable, since the last spread.
    let undecided = new Map<string, AstNode>()
    let found: Fold[] = []
    let uncallable = new Set<string>()
    // The fields the literal has. A later spread or key that doesn't fold may give a field another value, but never
    // takes it away.
    const has = new Set<string>()
    // The folds that show what a `__proto__` field's value is, which no later part undoes, and the fields that value
    // supplies where the literal has none of its own.
    const prototypeFolds: Fold[] = []
    let prototypeFields: DescriptorFields = { functions: new Set(), throwing: new Set() }
    // The getter a field may have (ECMA-262 PropertyDefinitionEvaluation): the last `get` of it since its last value,
    // or any `get` whose key doesn't fold. A setter after it joins it, and a setter alone leaves the field `undefined`.
    const getters = new Map<string, AstNode>()
    let anyGetter: AstNode | undefined
    for (const part of parts) {
      if (part.kind === 'unseen') {
        // A spread, a key that doesn't fold, or an object's unseen base, may give any field, over the fields before it.
        descriptor = unseenDescriptor(...descriptor.unseen, part.node)
        undecided = new Map()
        found = []
        uncallable = new Set()
        if (part.node.type === 'Property' && part.node['kind'] === 'get') anyGetter = part.node
        continue
      }
      // `__proto__: p` gives the literal a prototype, whose fields ToPropertyDescriptor reads where the literal has
      // none of its own. `null`, or a primitive, which sets no prototype, gives none.
      // A catalog holder is read through, against the unmutated catalog.
      if (part.kind === 'proto') {
        const proto = part.values
        const [only] = proto
        const inherited = proto.length === 1 && only?.kind === 'holder' ? context.descriptorFields(only.holder) : undefined
        if (proto.every((value) => value.kind === 'constant')) {
          prototypeFolds.push(...proto.flatMap((value) => (value.kind === 'constant' ? (value.folds ?? []) : [])))
        } else if (inherited !== undefined) {
          prototypeFields = inherited
          prototypeFolds.push(...(only?.kind === 'holder' ? (only.folds ?? []) : []))
        } else descriptor.unseen.push(part.site)
        continue
      }
      const member = part.key
      // A symbol-keyed property is no field.
      if (typeof member === 'symbol' || !descriptorFields.has(member)) continue
      has.add(member)
      found.push(...part.folds)
      undecided.delete(member)
      const kind = part.accessor ?? 'init'
      if (kind === 'get') getters.set(member, part.site)
      else if (kind === 'init') getters.delete(member)
      switch (member) {
        case 'value': {
          // A getter gives the value whatever it returns, and a setter alone gives `undefined`: a new value either way.
          // A fresh object or function differs from every value a member holds already (§3 No-op or ineffective): every
          // value the field's writes can give is one.
          const init = kind === 'init' && part.sources.length > 0
          const same =
            init &&
            slot !== undefined &&
            part.sources.every((source) => evaluatedAt(source.at, () => readsSlot(source.node, slot, evaluated)))
          descriptor.value = {
            same,
            fresh: init && part.values.length > 0 && part.values.every((each) => each.kind === 'object'),
            ...(init ? { sources: part.sources } : {}),
            // Read through a heap field, the value may be the native saved before an install (§3 Restores).
            ...(same && part.sources.some((source) => throughHeap(source.node)) ? { throughHeap: true as const } : {}),
          }
          break
        }
        case 'get':
        case 'set': {
          // An accessor field must be callable or `undefined`.
          const values = kind === 'init' ? part.values : []
          const refused = values.length > 0 && values.every((each) => each.kind === 'constant' && each.value !== undefined)
          if (refused) uncallable.add(member)
          else uncallable.delete(member)
          break
        }
        default: {
          const field = member as 'writable' | 'enumerable' | 'configurable'
          if (kind !== 'init') {
            // A getter gives the attribute whatever it returns. A setter with no getter gives it `undefined`, which
            // ToBoolean makes false.
            const getter = getters.get(member) ?? anyGetter
            descriptor[field] = getter === undefined ? false : 'unknown'
            if (getter !== undefined) undecided.set(member, getter)
            break
          }
          const values = part.values
          const attribute = truthiness(values)
          descriptor[field] = attribute ?? 'unknown'
          if (attribute === undefined) undecided.set(member, part.site)
          else {
            found.push(...values.flatMap((each) => (each.kind === 'constant' || each.kind === 'holder' ? (each.folds ?? []) : [])))
          }
        }
      }
    }
    // A field the prototype supplies as a Web IDL attribute throws when read, unless the literal has its own (Principle
    // 1). A spread or a key that doesn't fold may give it one, so the descriptor then stays unseen.
    for (const field of prototypeFields.throwing) {
      if (has.has(field)) continue
      if (descriptor.unseen.length === 0) return undefined
      has.add(field)
    }
    // The fields the prototype supplies as a function, which is callable and truthy. A spread or a key that doesn't fold
    // may give such a field another value, but the literal still has it.
    for (const field of prototypeFields.functions) {
      if (has.has(field)) continue
      has.add(field)
      if (descriptor.unseen.length > 0) continue
      if (field === 'value') descriptor.value = { same: false, fresh: false }
      else if (field === 'writable' || field === 'enumerable' || field === 'configurable') descriptor[field] = true
    }
    // A literal with an accessor field is an accessor descriptor, whatever a later part gives the field.
    descriptor.get = has.has('get')
    descriptor.set = has.has('set')
    const data = has.has('value') || has.has('writable')
    if (((descriptor.get || descriptor.set) && data) || uncallable.size > 0) return undefined
    descriptor.undecided = [...undecided.values()].sort((a, b) => a.start - b.start)
    folds.push(...prototypeFolds, ...found)
    return descriptor
  }

  switch (node.type) {
    case 'AssignmentExpression': {
      const left = node['left'] as AstNode
      const operator = node['operator'] as string
      const target = memberOf(left, (object, { member }) => {
        // A `__proto__` write has no member: on an unknown object it gives nothing (§5).
        if (member === '__proto__') return
        const value = node['right'] as AstNode
        const keepsPresent = operator === '||=' || operator === '??='
        const change: Change = { kind: 'set', member, same: false }
        open.push({ site: node, holder: object, mechanism: 'assign', change, value, target: left, keepsPresent })
      }, (object, key, reached) => {
        const value = node['right'] as AstNode
        const keepsPresent = operator === '||=' || operator === '??='
        const sources = writeBackOperators.has(operator) ? { sources: [{ node: value, at }] } : {}
        const change: Change = { kind: 'set', member: unknownMember, same: false, ...sources }
        const lookup = memberLookup(left, object)
        wildWrite(node, reached, object, key, 'assign', change, lookup, { target: left, value, keepsPresent })
      })
      if (target === undefined) return []
      const { holder, member, leaves, realmInstance, folds, parts, lookup } = target
      const value = node['right'] as AstNode
      // `h.__proto__ = p` calls `Object.prototype.__proto__`'s setter, which sets h's prototype (§3).
      if (member === '__proto__') {
        const change = prototypeChange(value, true, leaves, [node['left'] as AstNode, value])
        return [{ site: node, holder, leaves, realmInstance, mechanism: 'set-prototype', change, folds, parts, lookup }]
      }
      // `h.m += h.m` writes a new value, so only `=` and the logical assignments can write back what is there (§3).
      const writesBack = writeBackOperators.has(node['operator'] as string)
      const same = writesBack && readsSlot(value, target, [node['left'] as AstNode, value])
      // Any other operator writes a new primitive, which is never `null`.
      const written = writtenValue(member, writesBack ? value : 'primitive', value, same)
      const heap = same && throughHeap(value) ? { throughHeap: true as const } : {}
      const change: Change = { kind: 'set', member, same, ...heap, ...written, ...(writesBack ? { sources: [{ node: value, at }] } : {}) }
      return [{ site: node, holder, leaves, realmInstance, mechanism: 'assign', change, folds, parts, lookup }]
    }
    case 'UnaryExpression': {
      if (node['operator'] !== 'delete') return []
      let operand = node['argument'] as AstNode
      if (operand.type === 'ChainExpression') operand = operand['expression'] as AstNode
      // Post-pass 4 (§5): an unqualified delete of a name bound on the global object deletes the global object's
      // property. In strict code it is a SyntaxError, so the script never runs.
      if (operand.type === 'Identifier' && scope.isStrict(node.start)) return []
      const target = memberOf(operand, (object, { member }) => {
        open.push({ site: node, holder: object, mechanism: 'delete', change: { kind: 'delete', member }, target: operand })
      }, (object, key, reached) => {
        const change: Change = { kind: 'delete', member: unknownMember }
        wildWrite(node, reached, object, key, 'delete', change, memberLookup(operand, object), { target: operand })
      })
      if (target === undefined) return []
      const { holder, member, leaves, realmInstance, folds, parts, lookup } = target
      const change: Change = { kind: 'delete', member }
      return [{ site: node, holder, leaves, realmInstance, mechanism: 'delete', change, folds, parts, lookup }]
    }
    case 'CallExpression': {
      // A method read from an object can write, `h.m(…)`, `(0, h.m)(…)`, and so can a name that aliases a writer
      // (`Ae = Object.defineProperty; Ae(h, k, d)`, §5 Resolver capabilities 2).
      const callee = calleeExpression(node['callee'] as AstNode)
      if (callee.type === 'Identifier') {
        return apart(() => aliasedWriters(callee)).flatMap((writer) => callWrites(node, writer))
      }
      if (callee.type !== 'MemberExpression' || (callee['object'] as AstNode).type === 'Super') return []
      const method = apart(() => memberKey(callee))
      if (method === undefined || typeof method.member !== 'string') return []
      const named = { expression: callee, member: method.member, folds: method.folds }
      if (!Object.hasOwn(accessorDefiners, named.member)) return callWrites(node, named)
      // `(0, h.__defineGetter__)(…)` calls it with no `this`, which ToObject refuses (Principle 1).
      return callee === node['callee'] ? definerWrites(node, named) : []
    }
    case 'VariableDeclaration':
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      return declarationWrites(node)
    default:
      return []
  }

  /**
   * The global object's members a declaration writes (§3 Declarations in classic scripts), with mechanism `declare`:
   * one per name it binds, as the change a [[Set]] of the name's value makes. Whether that is a mutation, and how, is
   * for the declaration's form and the catalog to decide (`effect.ts`). A binding's value is its initializer, a
   * function or class, `undefined` when it has none, or a value the analyzer doesn't take apart (a loop's, or a pattern
   * element's), except that `{ m } = h` reads `h.m`.
   */
  function declarationWrites(declaration: AstNode): Write[] {
    const declared = scope.declared(declaration)
    if (declared === undefined) return []
    type Bound = { id: AstNode; value: AstNode | 'function' | 'undefined' | 'unknown' | { holder: AstNode; key: string } }
    const bound: Bound[] = []
    if (declaration.type !== 'VariableDeclaration') {
      bound.push({ id: declaration['id'] as AstNode, value: 'function' })
    } else {
      for (const declarator of declaration['declarations'] as AstNode[]) {
        const id = declarator['id'] as AstNode
        const init = declarator['init'] as AstNode | null
        if (id.type === 'Identifier') {
          bound.push({ id, value: declared.loop === true ? 'unknown' : (init ?? 'undefined') })
          continue
        }
        for (const name of patternIdentifiers(id)) {
          const key = init === null || declared.loop === true ? undefined : readKey(id, name)
          bound.push({ id: name, value: key === undefined ? 'unknown' : { holder: init!, key } })
        }
      }
    }
    return bound.map(({ id, value }) => {
      const name = id['name'] as string
      const leaf: Leaf = {
        form: 'global-property',
        node: id,
        name,
        binding: { withs: [], evals: [], declaration: { kind: declared.kind, node: declaration } },
        instance: context.instance,
      }
      const slot: Slot = { holder: global, member: name, realmInstance: context.instance, leaves: [leaf], folds: [] }
      let same = false
      let written: { value?: WrittenValue }
      let sources: Source[] = []
      let heap: { throughHeap?: true } = {}
      if (typeof value === 'string') {
        // A function, a class or `undefined` is never `null`; a value not taken apart may be.
        const site = value === 'function' ? declaration : id
        written = value === 'unknown' ? writtenValue(name, id, id, true) : writtenValue(name, 'primitive', site, false)
        if (value === 'function') sources = [{ node: declaration, at }]
      } else if ('type' in value) {
        same = readsSlot(value, slot, [value])
        if (same && throughHeap(value)) heap = { throughHeap: true }
        written = writtenValue(name, value, value, same)
        sources = [{ node: value, at }]
      } else {
        const reached = apart(() => holderOf(value.holder))
        same = reached !== undefined && reached.holder === global && value.key === name && sameWindow(reached.leaves, [leaf], [value.holder])
        written = writtenValue(name, id, id, true)
      }
      const bare = declared.kind === 'var' && value === 'undefined'
      const change: Change = { kind: 'set', member: name, same, ...heap, ...written, ...(sources.length > 0 ? { sources } : {}) }
      return {
        site: id,
        holder: global,
        leaves: [leaf],
        realmInstance: context.instance,
        mechanism: 'declare',
        change,
        folds: [],
        parts: { holder: [], member: [] },
        lookup: { node: id, token: name },
        declaration: bare ? { ...declared, bare } : declared,
      }
    })
  }

  /**
   * The key a name bound by a pattern reads from the value destructured, when the pattern is an object pattern whose
   * property binds the name directly, with no default: `m` in `{ m }` or `{ m: x }`, and `"m"` in `{ "m": x }` or
   * `{ ["m"]: x }`.
   */
  function readKey(pattern: AstNode, id: AstNode): string | undefined {
    if (pattern.type !== 'ObjectPattern') return undefined
    const property = (pattern['properties'] as AstNode[]).find((each) => each['value'] === id)
    if (property === undefined) return undefined
    const key = property['key'] as AstNode
    if (key.type === 'Identifier' && property['computed'] !== true) return key['name'] as string
    const literal = literalKey(key)
    return typeof literal === 'string' ? literal : undefined
  }

  /**
   * The write `h.__defineGetter__(k, g)` or `h.__defineSetter__(k, s)` makes (ECMA-262 B.2.2.2, B.2.2.3): a define of
   * an enumerable, configurable accessor on h, its `this` (§3), through the method h inherits from `Object.prototype`.
   * A bare call, or one through a comma sequence, has no `this`, so ToObject throws, and is never one.
   */
  function definerWrites(call: AstNode, method: Method): Write[] {
    const via = method.member as AccessorDefiner
    const object = method.expression['object'] as AstNode
    let unresolved = false
    const reached = holderOf(object, () => (unresolved = true))
    const [name, accessor] = call['arguments'] as AstNode[]
    if (unresolved && name !== undefined && name.type !== 'SpreadElement' && accessor !== undefined) {
      const key = accessor.type === 'SpreadElement' || primitive(accessor) ? undefined : constantKey(name)
      if (key !== undefined && key.member !== '__proto__') {
        const field = accessorDefiners[via]
        const descriptor = { ...unseenDescriptor(), get: field === 'get', set: field === 'set', enumerable: true, configurable: true }
        open.push({ site: call, holder: object, mechanism: 'define-property', change: { kind: 'define', member: key.member, descriptor } })
      }
    }
    if (reached === undefined || name === undefined || accessor === undefined) return []
    if (name.type === 'SpreadElement' || accessor.type === 'SpreadElement') return []
    // The accessor must be callable: a primitive is a TypeError.
    if (primitive(accessor)) return []
    const key = constantKey(name)
    if (key === undefined) {
      // A key the analyzer knows nothing of may be a wildcard define (§5 Partially resolved writes).
      if (unknownKey(name)) {
        const field = accessorDefiners[via]
        const descriptor = { ...unseenDescriptor(), get: field === 'get', set: field === 'set', enumerable: true, configurable: true }
        const change: Change = { kind: 'define', member: unknownMember, descriptor, via }
        wildWrite(call, reached, object, name, 'define-property', change, keyLookup(name, object), { writer: via, folds: method.folds })
      }
      return []
    }
    const { holder, leaves } = reached
    const field = accessorDefiners[via]
    const descriptor: DescriptorLiteral = {
      ...unseenDescriptor(),
      get: field === 'get',
      set: field === 'set',
      enumerable: true,
      configurable: true,
    }
    const change: Change = { kind: 'define', member: key.member, descriptor, via }
    const folds = [...reached.folds, ...method.folds, ...key.folds]
    const lookup = keyLookup(name, object)
    const realmInstance = instanceOf(leaves)
    const parts = { holder: reached.folds, member: key.folds }
    return [{ site: call, holder, leaves, realmInstance, mechanism: 'define-property', writer: via, change, folds, parts, lookup }]
  }

  /**
   * A change to the prototype `value` gives of the holder reached from `leaves`: unknown when a getter gives it.
   * `evaluated` is what the write evaluates, which could change the window a window expression reaches.
   */
  function prototypeChange(
    value: AstNode | undefined,
    setter: boolean,
    leaves: readonly Leaf[],
    evaluated: readonly AstNode[],
  ): Extract<Change, { kind: 'prototype' }> {
    const proto: Value[] = value === undefined ? [{ kind: 'unknown' }] : apart(() => context.resolution.evaluate(value, at))
    const [only] = proto
    const same = proto.length === 1 && only?.kind === 'holder' && sameWindow(only.leaves, leaves, evaluated)
    return { kind: 'prototype', proto, setter, sameWindow: same }
  }

  /** The writes a call to one of the native writer functions makes. */
  function callWrites(call: AstNode, method: Method | NativeFunction): Write[] {
    const callee = 'expression' in method ? apart(() => nativeFunction(method)) : method
    if (callee === undefined || !Object.hasOwn(nativeWriters, callee.name)) return []
    const mechanism = nativeWriters[callee.name]!
    const args = call['arguments'] as AstNode[]
    const [object, second, third] = args
    if (object === undefined || object.type === 'SpreadElement') return []
    let unresolved = false
    // `Reflect.set(t, k, v, r)` writes r: several holders t may be are no candidate set of what is written.
    const lookupOnly = callee.name === 'Reflect.set' && args.length > 3
    const reached = holderOf(object, () => (unresolved = true), lookupOnly)
    if (callee.name === 'Reflect.set') {
      openReflectSet(call, mechanism, unresolved)
      return reflectSetWrites(call, callee, reached)
    }
    if (unresolved) openCallWrites(call, mechanism, callee.name, object)
    if (reached === undefined) return []
    const { holder } = reached
    const leaves = inDocumentOrder([...reached.leaves, ...callee.leaves])
    // The native writer function may be another window's: the holder written decides the realm instance.
    const realmInstance = instanceOf(reached.leaves)
    const slot = ({ member, folds }: Key): Slot => ({
      holder,
      member,
      realmInstance,
      leaves: reached.leaves,
      folds: [...reached.folds, ...folds],
    })
    const write = (
      site: AstNode,
      change: Change,
      folds: readonly Fold[],
      lookup: WriteLookup,
      member: readonly Fold[],
      as: Mechanism = mechanism,
    ): Write => ({
      site,
      holder,
      leaves,
      realmInstance,
      mechanism: as,
      writer: callee.name,
      change,
      folds: [...callee.folds, ...reached.folds, ...folds],
      parts: { holder: reached.folds, member },
      lookup,
    })

    switch (callee.name) {
      case 'Object.defineProperty':
      case 'Reflect.defineProperty': {
        if ([second, third].some((arg) => arg === undefined || arg.type === 'SpreadElement')) return []
        const key = constantKey(second!)
        if (key === undefined) {
          if (unknownKey(second!)) {
            const described = descriptorOf(third!, undefined, args, [])
            const change: Change | undefined = described && { kind: 'define', member: unknownMember, ...described }
            if (change !== undefined) {
              const extra = { writer: callee.name, leaves, folds: callee.folds }
              wildWrite(call, reached, object, second!, mechanism, change, keyLookup(second!, object), extra)
            }
          }
          return []
        }
        const folds = [...key.folds]
        const lookup = keyLookup(second!, object)
        const described = descriptorOf(third!, slot(key), args, folds)
        if (described === undefined) return []
        const source = { node: third!, at }
        return [write(call, { kind: 'define', member: key.member, ...described, source }, folds, lookup, key.folds)]
      }
      case 'Object.defineProperties': {
        if (second?.type !== 'ObjectExpression') return []
        // ObjectDefineProperties converts every descriptor before it defines any, so one that ToPropertyDescriptor
        // refuses, whatever its key, throws before anything is written (Principle 1).
        const writes: Write[] = []
        const wildDefines: { property: AstNode; computed: AstNode; described: NonNullable<ReturnType<typeof descriptorOf>> }[] = []
        for (const property of second['properties'] as AstNode[]) {
          if (property.type !== 'Property') continue
          const key = propertyKey(property)
          if (key !== undefined && typeof key.member === 'string' && setsLiteralPrototype(property, key.member)) continue
          const folds = [...(key?.folds ?? [])]
          // A getter in the literal gives a descriptor the syntax doesn't show.
          const described =
            property['kind'] === 'init'
              ? descriptorOf(property['value'] as AstNode, key && slot(key), args, folds)
              : { descriptor: unseenDescriptor(property) }
          if (described === undefined) return []
          if (key === undefined) {
            // A computed key the analyzer knows nothing of may be a wildcard define (§5 Partially resolved writes).
            const computed = property['key'] as AstNode
            if (property['computed'] === true && unknownKey(computed)) wildDefines.push({ property, computed, described })
            continue
          }
          const lookup = propertyLookup(property, object)
          const source = property['kind'] === 'init' ? { source: { node: property['value'] as AstNode, at } } : {}
          writes.push(write(property, { kind: 'define', member: key.member, ...described, ...source }, folds, lookup, key.folds))
        }
        for (const { property, computed, described } of wildDefines) {
          const change: Change = { kind: 'define', member: unknownMember, ...described }
          const extra = { writer: callee.name, leaves, folds: callee.folds }
          wildWrite(property, reached, object, computed, mechanism, change, propertyLookup(property, object), extra)
        }
        return writes
      }
      case 'Object.assign': {
        // Each source's own enumerable properties are [[Set]] on the target in turn. A source that isn't an object
        // literal has keys the syntax doesn't show.
        const literals = args.slice(1).filter((source) => source.type === 'ObjectExpression')
        // A computed key the analyzer knows nothing of may be a wildcard assign (§5 Partially resolved writes).
        for (const source of literals) {
          for (const property of source['properties'] as AstNode[]) {
            if (property.type !== 'Property' || property['computed'] !== true) continue
            const computed = property['key'] as AstNode
            if (constantKey(computed) !== undefined || !unknownKey(computed)) continue
            const value = property['kind'] === 'init' ? (property['value'] as AstNode) : undefined
            const written = value === undefined ? {} : { sources: [{ node: value, at }] }
            const change: Change = { kind: 'set', member: unknownMember, same: false, ...written }
            const extra = { writer: callee.name, leaves, folds: callee.folds, ...(value === undefined ? {} : { value }) }
            wildWrite(property, reached, object, computed, mechanism, change, propertyLookup(property, object), extra)
          }
        }
        return literals
          .flatMap((source) =>
            properties(source).map(({ property, key }) => {
              // A getter in the literal gives whatever it returns.
              const value = property['kind'] === 'init' ? (property['value'] as AstNode) : undefined
              // An own `__proto__` key (computed, shorthand or a method) is [[Set]] through the target's setter. Such a
              // write has no member, so it looks up its holder.
              if (key.member === '__proto__') {
                const change = prototypeChange(value, true, reached.leaves, args)
                return write(property, change, key.folds, holderLookup(object), [], 'set-prototype')
              }
              const lookup = propertyLookup(property, object)
              const same = value !== undefined && readsSlot(value, slot(key), args)
              const written = writtenValue(key.member, value ?? 'getter', value ?? property, same)
              const sources = value === undefined ? {} : { sources: [{ node: value, at }] }
              const heap = same && throughHeap(value!) ? { throughHeap: true as const } : {}
              return write(property, { kind: 'set', member: key.member, same, ...heap, ...written, ...sources }, key.folds, lookup, key.folds)
            }),
          )
      }
      case 'Reflect.deleteProperty': {
        // `delete h[k]` (§3): a missing key would be `"undefined"`, which no holder has as a configurable member.
        if (second === undefined || second.type === 'SpreadElement') return []
        const key = constantKey(second)
        if (key === undefined) {
          if (unknownKey(second)) {
            const extra = { writer: callee.name, leaves, folds: callee.folds }
            const change: Change = { kind: 'delete', member: unknownMember }
            wildWrite(call, reached, object, second, mechanism, change, keyLookup(second, object), extra)
          }
          return []
        }
        return [write(call, { kind: 'delete', member: key.member }, key.folds, keyLookup(second, object), key.folds)]
      }
      default:
        // Object.setPrototypeOf and Reflect.setPrototypeOf.
        if (second === undefined || second.type === 'SpreadElement') return []
        return [write(call, prototypeChange(second, false, reached.leaves, args), [], holderLookup(object), [])]
    }
  }

  /**
   * The write sites of a call to a native writer function whose holder argument `object` may be an object the analyzer
   * can't resolve (§5 Partially resolved writes): a define or delete of a key that folds, and each property of a bulk
   * mechanism's object literal whose key folds. A prototype change has no member, so it has none.
   */
  function openCallWrites(call: AstNode, mechanism: Mechanism, name: string, object: AstNode): void {
    const args = call['arguments'] as AstNode[]
    const [, second, third] = args
    const push = (site: AstNode, change: OpenWrite['change'], value?: AstNode) => {
      if (change.member === '__proto__') return
      open.push({ site, holder: object, mechanism, change, ...(value === undefined ? {} : { value }) })
    }
    switch (name) {
      case 'Object.defineProperty':
      case 'Reflect.defineProperty': {
        if ([second, third].some((arg) => arg === undefined || arg.type === 'SpreadElement')) return
        const key = constantKey(second!)
        const described = key && descriptorOf(third!, undefined, args, [])
        if (key !== undefined && described !== undefined) push(call, { kind: 'define', member: key.member, ...described })
        return
      }
      case 'Object.defineProperties':
        if (second?.type !== 'ObjectExpression') return
        for (const { property, key } of properties(second)) {
          const described =
            property['kind'] === 'init' ? descriptorOf(property['value'] as AstNode, undefined, args, []) : { descriptor: unseenDescriptor(property) }
          if (described !== undefined) push(property, { kind: 'define', member: key.member, ...described })
        }
        return
      case 'Object.assign':
        for (const source of args.slice(1)) {
          if (source.type !== 'ObjectExpression') continue
          for (const { property, key } of properties(source)) {
            const value = property['kind'] === 'init' ? (property['value'] as AstNode) : undefined
            push(property, { kind: 'set', member: key.member, same: false }, value)
          }
        }
        return
      case 'Reflect.deleteProperty': {
        if (second === undefined || second.type === 'SpreadElement') return
        const key = constantKey(second)
        if (key !== undefined) push(call, { kind: 'delete', member: key.member })
        return
      }
      default:
    }
  }

  /**
   * The write site of `Reflect.set(t, k, v, r)`, an assign (§3), when its receiver (r, or t when not given) may be an
   * object the analyzer can't resolve and k folds (§5 Partially resolved writes). `tUnresolved` says t may be. A
   * `__proto__` key has no member.
   */
  function openReflectSet(call: AstNode, mechanism: Mechanism, tUnresolved: boolean): void {
    const args = call['arguments'] as AstNode[]
    const [object, second, third, fourth] = args
    if (object === undefined || second === undefined || args.slice(1).some((arg) => arg.type === 'SpreadElement')) return
    const receiver = fourth ?? object
    const unresolved =
      fourth === undefined ? tUnresolved : context.resolution.evaluate(fourth, at).some(opaque)
    if (!unresolved) return
    const key = constantKey(second)
    if (key === undefined || key.member === '__proto__') return
    const change: OpenWrite['change'] = { kind: 'set', member: key.member, same: false }
    open.push({ site: call, holder: receiver, mechanism, change, ...(third === undefined ? {} : { value: third }) })
  }

  /**
   * The write `Reflect.set(t, k, v, r)` makes (§3): a [[Set]] that looks k up on t's chain and writes its receiver r, t
   * when not given (ECMA-262 OrdinarySet). A receiver that is t's holder is `r[k] = v`. Another native holder is written
   * as [[Set]] decides from what t's chain gives and r's own property, or, when t denotes no native holder, as if t's
   * chain lacked k. A receiver that doesn't resolve, as a spread may give, gives nothing.
   */
  function reflectSetWrites(call: AstNode, callee: NativeFunction, reached: Reached | undefined): Write[] {
    const args = call['arguments'] as AstNode[]
    const [object, second, third, fourth] = args as [AstNode, ...(AstNode | undefined)[]]
    if (second === undefined || args.slice(1).some((arg) => arg.type === 'SpreadElement')) return []
    const key = constantKey(second)
    const receiver = fourth === undefined ? reached : holderOf(fourth)
    // `Reflect.set(h, k, v)` with a key the analyzer knows nothing of is `h[k] = v` (§3).
    if (key === undefined && fourth === undefined && reached !== undefined && unknownKey(second)) {
      const sources = third === undefined || third.type === 'SpreadElement' ? {} : { sources: [{ node: third, at }] }
      const change: Change = { kind: 'set', member: unknownMember, same: false, ...sources }
      const extra = { writer: callee.name, leaves: inDocumentOrder([...reached.leaves, ...callee.leaves]), folds: callee.folds }
      wildWrite(call, reached, object, second, 'assign', change, keyLookup(second, object), {
        ...extra,
        ...(third === undefined ? {} : { value: third }),
      })
    }
    if (key === undefined || receiver === undefined) return []
    // What k is looked up on, when it isn't the holder written. A t that denotes no native holder may be any object,
    // unless it is plainly no object, which throws before any write (Principle 1). One that may be several native
    // holders is a candidate set (§5). Neither of those is written.
    let through: Through | undefined
    // A t known to be an ordinary object whose chain reaches `Object.prototype` gives the `__proto__` setter there
    // (§3): its chain, from the prototype its literal has, decides the write.
    const ordinary = reached === undefined && key.member === '__proto__' ? ordinaryPrototype(object) : undefined
    if (ordinary !== undefined) through = { holder: ordinary }
    else if (reached === undefined) {
      const values = context.resolution.evaluate(object, at)
      if (values.every((value) => value.kind === 'constant') || values.some((value) => value.kind === 'holder')) return []
      through = { unresolved: object }
    } else if (reached.holder !== receiver.holder) through = { holder: reached.holder }
    const own = receiver === reached
    const realmInstance = instanceOf(receiver.leaves)
    const written: Slot = { holder: receiver.holder, member: key.member, realmInstance, leaves: receiver.leaves, folds: [] }
    const write = (change: Change, as: Mechanism, lookup: WriteLookup): Write => ({
      site: call,
      holder: receiver.holder,
      leaves: inDocumentOrder([...(reached?.leaves ?? []), ...callee.leaves, ...(own ? [] : receiver.leaves)]),
      realmInstance,
      mechanism: as,
      writer: callee.name,
      change,
      folds: [...callee.folds, ...(reached?.folds ?? []), ...key.folds, ...(own ? [] : receiver.folds)],
      parts: { holder: receiver.folds, member: as === 'set-prototype' ? [] : key.folds },
      lookup,
    })
    // The object written: r, or t when not given.
    const target = fourth ?? object
    // `r.__proto__ = p` calls the setter t's chain gives, `Object.prototype.__proto__`'s, which ignores a missing
    // (undefined) value. Such a write has no member, so it looks up the object written.
    if (key.member === '__proto__' && (through === undefined || 'holder' in through)) {
      if (third === undefined) return []
      const change = { ...prototypeChange(third, true, receiver.leaves, args), through: through?.holder }
      return [write(change, 'set-prototype', holderLookup(target))]
    }
    // A missing value sets `undefined`, a new value.
    const same = third !== undefined && readsSlot(third, written, args)
    const value = writtenValue(key.member, third ?? 'primitive', third ?? call, same)
    const sources = third === undefined || third.type === 'SpreadElement' ? {} : { sources: [{ node: third, at }] }
    return [write({ kind: 'set', member: key.member, same, through, ...value, ...sources }, 'assign', keyLookup(second, target))]
  }

  /**
   * The prototype holder of an object that `node` is known to create with no own `__proto__`: an object literal with
   * no own `__proto__`, and no spread or key that doesn't fold, which could give it one (`Object.prototype`, or the
   * native holder its `__proto__:` field gives); an array literal (`Array.prototype`); or a function literal
   * (`Function.prototype`).
   */
  function ordinaryPrototype(node: AstNode): string | undefined {
    switch (node.type) {
      case 'ArrayExpression':
        return 'Array.prototype'
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return 'Function.prototype'
      case 'ObjectExpression': {
        let prototype: string | undefined = 'Object.prototype'
        for (const property of node['properties'] as AstNode[]) {
          if (property.type !== 'Property') return undefined
          const key = propertyKey(property)
          if (key === undefined) return undefined
          if (key.member !== '__proto__') continue
          if (!setsLiteralPrototype(property, key.member)) return undefined
          // `__proto__: p` gives the literal p as its prototype: a native holder, or `null`, where the chain ends. Any
          // other primitive sets none.
          const values = context.resolution.evaluate(property['value'] as AstNode, at)
          const [only] = values
          if (values.length !== 1 || only === undefined) return undefined
          if (only.kind === 'holder') prototype = only.holder
          else if (only.kind !== 'constant' || only.value === null) return undefined
        }
        return prototype
      }
      default:
        return undefined
    }
  }

  /**
   * An object literal's own properties with keys that fold to constants, in source order. Spread properties are left
   * out, and so is `__proto__: p`, which gives the literal a prototype rather than an own property.
   */
  function properties(literal: AstNode): { property: AstNode; key: Key }[] {
    return (literal['properties'] as AstNode[]).flatMap((property) => {
      if (property.type !== 'Property') return []
      const key = propertyKey(property)
      if (key === undefined || (typeof key.member === 'string' && setsLiteralPrototype(property, key.member))) return []
      return [{ property, key }]
    })
  }

  /** The native writer functions a name aliases: each alternative that is one counts (Principle 3). */
  function aliasedWriters(id: AstNode): NativeFunction[] {
    return context.resolution.aliasCallee(id, at).flatMap((value) =>
      value.kind === 'native' && Object.hasOwn(nativeWriters, value.name)
        ? [{ name: value.name, leaves: inDocumentOrder(value.leaves), folds: value.folds ?? [] }]
        : [],
    )
  }

  /**
   * The native function a called method denotes, by catalog name (`Object.defineProperty`), with its holder's leaves,
   * and the folds its holder and key come from.
   */
  function nativeFunction({ expression, member, folds }: Method): NativeFunction | undefined {
    // Most calls are to other functions: only a writer's name is worth resolving the holder for.
    if (!writerMembers.has(member)) return undefined
    const reached = holderOf(expression['object'] as AstNode)
    return reached && { name: `${reached.holder}.${member}`, leaves: reached.leaves, folds: [...reached.folds, ...folds] }
  }
}

/** The fields ECMA-262 ToPropertyDescriptor reads. */
export const descriptorFields: ReadonlySet<string> = new Set(['value', 'get', 'set', 'writable', 'enumerable', 'configurable'])

/**
 * The descriptor fields a native holder supplies as a descriptor's prototype (§3 Undecidable outcomes): `functions`, whose
 * value is a function, and `throwing`, whose getter throws when ToPropertyDescriptor reads it.
 */
export interface DescriptorFields {
  readonly functions: ReadonlySet<string>
  readonly throwing: ReadonlySet<string>
}

/** A descriptor with no field the syntax shows, and `unseen` the parts that may give it any. */
function unseenDescriptor(...unseen: AstNode[]): DescriptorLiteral {
  return { get: false, set: false, unseen, undecided: [] }
}

/**
 * The name a key is written as at the site when it is a string key: a string literal, or a template literal with no
 * substitutions, by its cooked value (§10 Token check). A number, a template with substitutions, or any other
 * expression is no token.
 */
function writtenString(key: AstNode): string | undefined {
  if (key.type === 'Literal') return typeof key['value'] === 'string' ? key['value'] : undefined
  if (key.type !== 'TemplateLiteral' || (key['expressions'] as AstNode[]).length > 0) return undefined
  const cooked = ((key['quasis'] as AstNode[])[0]?.['value'] as { cooked?: unknown } | undefined)?.cooked
  return typeof cooked === 'string' ? cooked : undefined
}

/**
 * The assignment operators whose value is the right side as read: `=`, and the logical assignments, which write it only
 * when they write at all. The others (`+=`, `|=`, `**=`) write a new value computed from both sides.
 */
const writeBackOperators: ReadonlySet<string> = new Set(['=', '||=', '&&=', '??='])

/** The identifiers a binding pattern binds, as `boundNames` names them. */
function patternIdentifiers(pattern: AstNode): AstNode[] {
  const found: AstNode[] = []
  walkTree(pattern, {
    enter(node, parent) {
      // A default value, or a computed key, is an expression, whose identifiers are read, not bound.
      if (parent?.type === 'AssignmentPattern' && parent['right'] === node) return false
      if (parent?.type === 'Property' && parent['key'] === node) return false
      if (node.type === 'Identifier') found.push(node)
      return undefined
    },
  })
  const names = new Set(boundNames(pattern))
  return found.filter((id) => names.has(id['name'] as string))
}

/** A bare name bound on the global object: the global object's property of that name (§5), in the window `instance`. */
function bareGlobal(id: AstNode, scope: ScopeRules, instance: RealmInstance): Leaf | undefined {
  const binding = scope.resolve(id)
  if (binding === 'local') return undefined
  return { form: 'global-property', node: id, name: id['name'] as string, binding, instance }
}

/** A field that may be absent. */
type MaybeField = Extract<ObjectPart, { kind: 'field' }> & { maybe: AstNode }
const isMaybe = (part: ObjectPart): part is MaybeField => part.kind === 'field' && part.maybe !== undefined

/**
 * Every way an object's fields that may be absent can be present or absent, as the parts each gives, or undefined
 * past the descriptor-alternatives cap, `maxDescriptorAlternatives`. Only the last present write of a field decides it,
 * so each field is absent, or has exactly one of its maybe-absent writes: the product of one more than each field's
 * writes.
 */
function presentOrAbsent(parts: readonly ObjectPart[], maxDescriptorAlternatives: number): ObjectPart[][] | undefined {
  const byKey = new Map<MemberKey, MaybeField[]>()
  for (const part of parts) {
    if (!isMaybe(part)) continue
    const same = byKey.get(part.key)
    if (same === undefined) byKey.set(part.key, [part])
    else same.push(part)
  }
  let count = 1
  for (const writes of byKey.values()) count *= writes.length + 1
  if (count > maxDescriptorAlternatives) return undefined
  let chosen: Set<ObjectPart>[] = [new Set()]
  for (const writes of byKey.values()) {
    chosen = chosen.flatMap((set) => [set, ...writes.map((write) => new Set([...set, write]))])
  }
  return chosen.map((set) => parts.filter((part) => !isMaybe(part) || set.has(part)))
}

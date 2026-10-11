// Effects (§8 Effect and mechanism, ADR 0011): what a write does to its target, decided against the unmutated catalog.
// The effect follows the member's new value, not the attributes that change with it.
//
// Writes that are API use give nothing (§3): a [[Set]] follows the member's `assign` kind. A write that can't change
// its target is an ineffective write (§3 Ineffective writes), with its reason and whether it throws. A define whose
// descriptor the analyzer can't see (§3 Undecidable outcomes) is a `descriptor-change` or `replace` of a catalog
// member, with `outcome-undecidable` and `locks: unknown`, or an `add`. A `Reflect.set` whose receiver resolves and
// whose lookup object doesn't is worked out as if that object lacked the member, with `outcome-undecidable` and
// `locks: false`. A write of a member the holder only inherits is a shadowing write (§3, §4, ADR 0002), named on the
// object written, or an expando that gives nothing.

import {
  ecmascriptSpecs,
  namedPropertiesObject,
  type CatalogHolder,
  type CatalogTarget,
  type Descriptor,
  type Holder,
  type Realm,
  type SerializedCatalog,
} from '../../../catalog.ts'
import type { AstNode } from './ast.ts'
import { opaque, type Value } from './global-object.ts'
import { memberName, wellKnownSymbol, type Key as MemberKey } from './keys.ts'
import type { Effect, IneffectiveReason, Locks, Throws } from './types.ts'
import {
  descriptorFields,
  type Change,
  type Declaration,
  type DescriptorFields,
  type DescriptorLiteral,
  type Write,
} from './writes.ts'

/** A write that is a platform mutation: the target it names, its effect, and what the outcome table decides of it. */
export interface Mutation extends Outcome {
  /** The target's name, e.g. `Window.fetch`. */
  name: string
  /** The kind of holder the target is on. */
  holder: Holder
  /** For a shadowing write, the inherited member it shadows (§4): derived, and not identity. */
  shadows?: string
}

/**
 * A write that can't change its target (§3 Ineffective writes): the target it would have changed, the effect it
 * intended, why it can't, and whether it throws. `mayChangeNothing` says that on a value the analyzer can't see the
 * write could instead change nothing (§3 No-op or ineffective).
 */
export interface Ineffective {
  name: string
  holder: Holder
  shadows?: string
  effect: Effect
  reason: IneffectiveReason
  throws: Throws
  mayChangeNothing: boolean
}

/** Whether an outcome is an ineffective write. */
export const isIneffective = (outcome: Mutation | Ineffective): outcome is Ineffective => 'reason' in outcome

/**
 * An ineffective outcome as the outcome table decides it for a member, before the write's native function says whether
 * it throws (`throwsOf`).
 */
interface Refused {
  effect: Effect
  reason: IneffectiveReason
  mayChangeNothing: boolean
  /** Set when the write never throws whatever makes it: a `[LegacyLenientSetter]` setter returns quietly. */
  quiet?: true
}

/**
 * Whether a write that can't change its target throws (§3): a `[LegacyLenientSetter]` setter never does. Otherwise it
 * follows what makes the write. The `Reflect` functions return false, and never throw, except that `Reflect.set`
 * of `__proto__` runs `Object.prototype.__proto__`'s setter, which throws. `Object.defineProperty`,
 * `Object.defineProperties`, `__defineGetter__`, `__defineSetter__`, `Object.setPrototypeOf` and `Object.assign`, and
 * the `__proto__` setter, always throw. The `=` and `delete` operators throw only in strict code.
 */
function throwsOf(write: Write, refused: Refused): Throws {
  if (refused.quiet === true) return 'never'
  // A function or lexical declaration that can't bind its name fails GlobalDeclarationInstantiation, with a TypeError or
  // SyntaxError, before the script runs (§3). An Annex B block function sets its binding with S false, which never
  // throws. A `var` initializer's [[Set]] throws as `=` does.
  const declared = write.declaration?.kind
  if (declared === 'block-function') return 'never'
  if (declared !== undefined && declared !== 'var') return 'always'
  if (write.change.kind === 'prototype' && write.change.setter) return 'always'
  if (write.writer === undefined) return 'strict-only'
  return write.writer.startsWith('Reflect.') ? 'never' : 'always'
}

/** What a write does to a member it plainly mutates. */
interface Outcome {
  effect: Effect
  /**
   * Whether the mutation leaves the target non-configurable or non-writable (§8): `unknown` when that depends on what
   * the analyzer can't see or decide.
   */
  locks: Locks
  /**
   * When the outcome table can't decide whether the write takes effect (§3 Undecidable outcomes), what the outcome
   * depends on and the analyzer can't see or decide, in source order: the evidence for the mutation-confidence reason
   * `outcome-undecidable` (§9). For a `descriptor`, the parts of a define's descriptor. For a `lookup`, the object a
   * `Reflect.set` looks its member up on, which denotes no native holder. For a `value`, the value an assign of
   * `Window.opener` writes, which may be `null`.
   */
  undecidable?: { on: 'descriptor' | 'lookup' | 'value'; sites: AstNode[] }
}

/**
 * The name of the target a `prototype-change` of a holder names: `<holder>.[[Prototype]]`, as the validation corpus
 * names it.
 */
function prototypeTarget(holder: string): string {
  return `${holder}.[[Prototype]]`
}

/** The kinds of data property whose value is a function: callable, and an object, so truthy. */
const callableKinds: ReadonlySet<CatalogTarget['kind']> = new Set(['function', 'operation', 'interface'])

/**
 * The descriptor fields (`value`, `get`, `set`, `writable`, `enumerable`, `configurable`) a native holder supplies when
 * it is a descriptor's prototype, as ECMA-262 ToPropertyDescriptor reads them through its chain in the unmutated catalog
 * (§3 Undecidable outcomes). `functions` are the fields whose value is a function. `throwing` are the fields that are a
 * Web IDL attribute: its getter runs on the descriptor, which implements no interface, so it throws a TypeError.
 * `Object.prototype` supplies none. Undefined when the analyzer can't read them: a field that is any other accessor, or
 * a data property that isn't a function.
 */
export function descriptorFieldsOf(holder: string, catalog: SerializedCatalog, realm: Realm): DescriptorFields | undefined {
  const holders = catalog.holders[realm]
  const targets = catalog.targets[realm]
  const functions = new Set<string>()
  const throwing = new Set<string>()
  for (let at: string | null = holder; at !== null; at = holders[at]!.proto) {
    if (!Object.hasOwn(holders, at)) return undefined
    for (const field of descriptorFields) {
      const name = memberName(at, field)
      if (functions.has(field) || throwing.has(field) || !Object.hasOwn(targets, name)) continue
      const target = targets[name]!
      if (target.descriptor.type === 'data' && callableKinds.has(target.kind)) functions.add(field)
      else if (target.descriptor.type === 'accessor' && target.kind === 'attribute') throwing.add(field)
      else return undefined
    }
  }
  return { functions, throwing }
}

/**
 * The outcomes of a write (§3): the platform mutations it makes, or the ineffective writes it is. A define whose
 * descriptor can be several descriptors (several objects the heap holds, or fields that may be absent, §5 Resolver
 * capabilities 5) is judged per descriptor:
 * - When some can change the target, the write can, so it is no ineffective write (§3): it gives one mutation per
 *   effect they give. When they don't all give the same effect, or some give none or are ineffective, each has
 *   `outcome-undecidable`, with what the outcome depends on as its evidence, and `locks` from the descriptors that give
 *   its effect.
 * - When none can, and some are ineffective, the write is ineffective (§3 No-op or ineffective): one ineffective
 *   outcome per effect they intend, which may change nothing when any descriptor changes nothing.
 */
export function outcomesOf(write: Write, catalog: SerializedCatalog, realm: Realm): (Mutation | Ineffective)[] {
  const { change } = write
  if (change.kind !== 'define' || change.alternatives === undefined) {
    const outcome = mutationOf(write, catalog, realm)
    return outcome === undefined ? [] : [outcome]
  }
  const { alternatives, ...single } = change
  // A descriptor ToPropertyDescriptor refuses throws before the define runs, so it gives nothing (Principle 1).
  const outcomes = alternatives.map((descriptor) =>
    descriptor === 'refused' ? 'refused' : mutationOf({ ...write, change: { ...single, descriptor } }, catalog, realm),
  )
  const effective = outcomes.filter((outcome): outcome is Mutation => typeof outcome === 'object' && !isIneffective(outcome))
  if (effective.length === 0) {
    const refused = outcomes.filter((outcome): outcome is Ineffective => typeof outcome === 'object')
    const noOp = outcomes.some((outcome) => outcome === undefined) || refused.some((each) => each.mayChangeNothing)
    return [...byEffect(refused).values()].map(([first]) => ({ ...first!, mayChangeNothing: noOp }))
  }
  const effects = byEffect(effective)
  const decided = effects.size === 1 && effective.length === outcomes.length
  const evidence = alternatives.flatMap((descriptor) => (descriptor === 'refused' ? [] : (descriptor.evidence ?? [])))
  return [...effects.values()].map((group) => {
    const [first] = group as [Mutation, ...Mutation[]]
    // When the descriptors that give the effect disagree, the most-locking wins, as for occurrences (§8).
    const locks = mostLocking(group.map((each) => each.locks))
    const own = group.flatMap((each) => each.undecidable?.sites ?? [])
    const sites = [...new Set([...(decided ? [] : evidence), ...own])].sort((a, b) => a.start - b.start)
    const mutation: Mutation = { ...first, locks }
    delete mutation.undecidable
    const on = group.find((each) => each.undecidable !== undefined)?.undecidable?.on ?? 'descriptor'
    return decided && own.length === 0 ? mutation : { ...mutation, undecidable: { on, sites } }
  })
}

/** Outcomes grouped by their effect, in the order the effects first appear. */
function byEffect<T extends { effect: Effect }>(outcomes: readonly T[]): Map<Effect, T[]> {
  const effects = new Map<Effect, T[]>()
  for (const outcome of outcomes) {
    const same = effects.get(outcome.effect)
    if (same === undefined) effects.set(outcome.effect, [outcome])
    else same.push(outcome)
  }
  return effects
}

/** The most-locking of several `locks`: `true` over `unknown` over `false` (§8). */
function mostLocking(all: readonly Locks[]): Locks {
  return all.includes(true) ? true : all.includes('unknown') ? 'unknown' : false
}

/**
 * The outcome of a write with one descriptor (§3): the platform mutation it makes, if §3 plainly makes it one, or the
 * ineffective write it is, when it can't change its target. Undefined when it is neither.
 */
export function mutationOf(write: Write, catalog: SerializedCatalog, realm: Realm): Mutation | Ineffective | undefined {
  const outcome = decided(write, catalog, realm)
  if (outcome === undefined || !('reason' in outcome)) return outcome
  const { name, holder, shadows, effect, reason, mayChangeNothing } = outcome
  const named = { name, holder, ...(shadows === undefined ? {} : { shadows }) }
  return { ...named, effect, reason, throws: throwsOf(write, outcome), mayChangeNothing }
}

/** A named ineffective outcome, before `throwsOf` says whether it throws. */
type Named<T> = T & { name: string; holder: Holder; shadows?: string }

function decided(write: Write, catalog: SerializedCatalog, realm: Realm): Mutation | Named<Refused> | undefined {
  const { holder, change } = write
  const holders = catalog.holders[realm]
  const targets = catalog.targets[realm]
  const record = Object.hasOwn(holders, holder) ? holders[holder] : undefined
  if (record === undefined) return undefined

  /** The holders on the prototype chain of `start`, starting from it, as the unmutated catalog has them. */
  const chainOf = (start: string): string[] => {
    const chain: string[] = []
    for (let at: string | null = start; at !== null; at = Object.hasOwn(holders, at) ? holders[at]!.proto : null) {
      chain.push(at)
    }
    return chain
  }
  const chain = chainOf(holder)
  const target = (name: string): CatalogTarget | undefined => (Object.hasOwn(targets, name) ? targets[name] : undefined)
  const webIdl = webIdlOf(catalog)

  if (change.kind === 'prototype') {
    // `h.__proto__ = p` changes h's prototype only through the setter `Object.prototype.__proto__`, the first
    // `__proto__` on h's chain, or on the chain of the holder a `Reflect.set` receiver's [[Set]] looks it up on.
    if (change.setter) {
      const lookup = change.through === undefined ? chain : chainOf(change.through)
      const accessor = lookup.map((at) => `${at}.__proto__`).find((name) => target(name) !== undefined)
      if (accessor !== 'Object.prototype.__proto__' || target(accessor)!.descriptor.type !== 'accessor') return undefined
    }
    return prototypeChange(holder, record, change)
  }
  if (change.kind === 'set' && change.through !== undefined) {
    const { through } = change
    if ('holder' in through) return receiverSet(change, { holder, record, chain }, chainOf(through.holder), target, webIdl)
    // A lookup object that denotes no native holder: R is written as if its chain lacked the member (§3).
    const mutation = receiverSet(change, { holder, record, chain }, [], target, webIdl, true)
    return mutation && { ...mutation, undecidable: { on: 'lookup', sites: [through.unresolved] } }
  }
  // `h.__defineGetter__(k, g)` defines only through the method `Object.prototype` gives, the first on h's chain.
  if (change.kind === 'define' && change.via !== undefined) {
    const method = chain.map((at) => memberName(at, change.via!)).find((name) => target(name) !== undefined)
    if (method !== memberName('Object.prototype', change.via)) return undefined
  }

  if (write.declaration !== undefined && change.kind === 'set') {
    const named = memberName(holder, change.member)
    const own = target(named)
    if (own !== undefined) {
      const outcome = declaredEffect(write.declaration, change, own)
      return outcome && { name: named, holder: own.holder, ...outcome }
    }
    const shadows = inheritedMember(chain, change.member, target)
    if (shadows === undefined || !shadowable(record.kind, target(shadows)!, webIdl)) return undefined
    const outcome = declaredOverInherited(write.declaration, change)
    return outcome && { name: named, holder: record.kind, shadows, ...outcome }
  }

  const name = memberName(holder, change.member)
  const member = target(name)
  if (member !== undefined) {
    // The object written is the holder itself: a platform object only when it is the global or a singleton.
    const outcome = memberEffect(change, member, platformObjects.has(member.holder))
    return outcome && { name, holder: member.holder, ...outcome }
  }
  // A member the catalog doesn't list on the holder. A delete of one it only inherits changes no native (§3).
  if (change.kind === 'delete') return undefined
  if (typeof change.member === 'string' && structural[record.kind]?.has(change.member)) return undefined
  // One it inherits makes the write a shadowing write, or an expando that gives nothing (§3, §4).
  const shadows = inheritedMember(chain, change.member, target)
  if (shadows !== undefined) return shadowingWrite(change, name, record.kind, shadows, target(shadows)!, webIdl)
  // Otherwise an add, on a holder that takes one. Every define it takes adds the member, whatever the descriptor gives,
  // so an unseen one leaves only `locks` unknown.
  if (!addable.has(record.kind) || namedProperties(holder, record)) return undefined
  return { name, holder: record.kind, effect: 'add', locks: change.kind === 'define' ? locksOf(change.descriptor, created) : false }
}

/**
 * The outcome of a declaration of a name the global object has as its own member (§3 Declarations in classic scripts),
 * as ECMA-262's declaration instantiation gives it:
 * - A `var`, or an Annex B block function, leaves the property as it is and [[Set]]s its value: the `assign` row. A
 *   bare `var x;` sets nothing.
 * - A function needs CanDeclareGlobalFunction: a configurable property, or a writable, enumerable data property. It then
 *   defines a data property holding the function, writable, enumerable and configurable only in eval code: a `replace`
 *   that locks in a script. Any other property makes the script throw a TypeError: `non-configurable`.
 * - A `let`, `const` or `class` leaves the property alone and hides it from bare-name callers: a `replace` unless its
 *   value reads the same slot, with `locks: false`. A non-configurable property makes the script throw a
 *   SyntaxError (HasRestrictedGlobalProperty): `non-configurable`.
 */
function declaredEffect(
  declaration: Declaration,
  change: Extract<Change, { kind: 'set' }>,
  member: CatalogTarget,
): Outcome | Refused | undefined {
  const { descriptor } = member
  switch (declaration.kind) {
    case 'var':
    case 'block-function':
      return declaration.bare === true ? undefined : setEffect(change, member, true)
    case 'function': {
      if (descriptor.configurable) return { effect: 'replace', locks: !declaration.configurable }
      if (descriptor.type === 'data' && descriptor.writable && descriptor.enumerable) return { effect: 'replace', locks: true }
      return { effect: 'replace', reason: 'non-configurable', mayChangeNothing: false }
    }
    default:
      if (!descriptor.configurable) return { effect: 'replace', reason: 'non-configurable', mayChangeNothing: false }
      return change.same ? undefined : { effect: 'replace', locks: false }
  }
}

/**
 * The outcome of a declaration of a name the global object only inherits (§3), which it can shadow: a shadowing
 * `replace`. A `var` or block function defines an own data property first (CreateGlobalVarBinding), holding `undefined`
 * until its value is set, and a function one holding the function (CreateGlobalFunctionBinding): each is writable and
 * enumerable, and configurable only in eval code, so it locks in a script. A `let`, `const` or `class` hides the member
 * from bare-name callers, with `locks: false`, unless its value reads the same slot.
 */
function declaredOverInherited(declaration: Declaration, change: Extract<Change, { kind: 'set' }>): Outcome | undefined {
  if (declaration.kind === 'let' || declaration.kind === 'const' || declaration.kind === 'class') {
    return change.same ? undefined : { effect: 'replace', locks: false }
  }
  return { effect: 'replace', locks: !declaration.configurable }
}

/** The first member up the chain from the holder (`chain[0]`) that the unmutated catalog lists, by its name. */
function inheritedMember(
  chain: readonly string[],
  member: MemberKey,
  target: (name: string) => CatalogTarget | undefined,
): string | undefined {
  return chain
    .slice(1)
    .map((at) => memberName(at, member))
    .find((inherited) => target(inherited) !== undefined)
}

/**
 * Whether a holder of this kind can shadow this inherited member (§3 Shadowing writes, §4 naming rules): a
 * shadowing target is valid only when the member resolves along the written object's IDL chain. The global object and
 * the platform singletons shadow only a Web IDL member: a name only the realm's ECMAScript tail supplies
 * (`Object.prototype.toString`) is an expando on them. A prototype, constructor or namespace shadows any member its
 * chain has, the ES tail's among them (`XMLHttpRequest.prototype.toString = f`, `Uint8Array.prototype.at = f`), and so
 * does `console`, a singleton whose holder is a namespace.
 */
function shadowable(holder: Holder, inherited: CatalogTarget, webIdl: (member: CatalogTarget) => boolean): boolean {
  return !platformObjects.has(holder) || webIdl(inherited)
}

/**
 * Whether a holder is a `[Global]` interface's named properties object (`WindowProperties`), the prototype holder the
 * catalog names by `namedPropertiesObject`. It takes a define only of a name visible on its chain: Chromium refuses any
 * other ("Named property setter is not supported"), so such a write changes nothing and is no `add` (§3). A write of a
 * name visible on its chain is a shadowing write like any other (§3, §4).
 */
function namedProperties(holder: string, record: CatalogHolder): boolean {
  return record.kind === 'prototype' && holder === namedPropertiesObject(record.owner)
}

/**
 * A write on a holder of a member it only inherits (§3 Shadowing writes, ADR 0002), named on the object written, with
 * `shadows` naming the inherited member: the first one up the chain in the unmutated catalog. `self.fetch = w` in a
 * dedicated worker writes `DedicatedWorkerGlobalScope.fetch`, shadowing `WorkerGlobalScope.prototype.fetch`,
 * `history.pushState = w` writes `history.pushState`, shadowing `History.prototype.pushState`, and
 * `Window.prototype.addEventListener = w` writes `Window.prototype.addEventListener`, shadowing
 * `EventTarget.prototype.addEventListener`.
 * - A [[Set]] creates an own data property when the inherited member is a writable data property, and on the global
 *   object or a singleton, which implement the interfaces on their chain, when it is a `[Replaceable]` attribute,
 *   whose setter defines the property on the object written. Any other inherited accessor's setter runs (API use, as
 *   `document.title = t` is), or throws on an object that doesn't implement its interface.
 * - A define always creates the own property, as each object written is extensible (`shadowingDefine`).
 */
function shadowingWrite(
  change: Exclude<Change, { kind: 'prototype' | 'delete' }>,
  name: string,
  holder: Holder,
  shadows: string,
  inherited: CatalogTarget,
  webIdl: (member: CatalogTarget) => boolean,
): Mutation | Named<Refused> | undefined {
  if (!shadowable(holder, inherited, webIdl)) return undefined
  const outcome =
    change.kind === 'set'
      ? setEffect(change, inherited, platformObjects.has(holder))
      : shadowingDefine(change.descriptor, inherited.descriptor)
  return outcome && { name, holder, shadows, ...outcome }
}

/**
 * The outcome of a define that creates an own property over an inherited member whose descriptor in the unmutated
 * catalog is `inherited`. The effect follows the new property's value (ADR 0011): a getter or setter gives a
 * `descriptor-change`; a data property holding anything but the inherited member's value, `undefined` when the
 * descriptor gives no `value`, a `replace`; and one holding the inherited data value a `descriptor-change` when an
 * attribute differs, a field the descriptor lacks being `false` on a new property. A descriptor the analyzer can't see
 * wholly is a `descriptor-change`, or a `replace` when a new `value` comes after every part it can't see, with `locks:
 * unknown` and no `outcome-undecidable`, as the define can't be refused (§3 Undecidable outcomes).
 */
function shadowingDefine(defined: DescriptorLiteral, inherited: Descriptor): Outcome | undefined {
  if (defined.unseen.length > 0) {
    return { effect: defined.value !== undefined && !defined.value.same ? 'replace' : 'descriptor-change', locks: 'unknown' }
  }
  const locks = locksOf(defined, created)
  if (isAccessor(defined)) return { effect: 'descriptor-change', locks }
  if (defined.value === undefined || !defined.value.same || inherited.type === 'accessor') return { effect: 'replace', locks }
  const { writable = false, enumerable = false, configurable = false } = defined
  return attributesChange({ ...defined, writable, enumerable, configurable }, inherited, locks)
}

/**
 * A [[Set]] that looks the member up on one holder's chain (`lookup`) and writes another, its receiver
 * (`Reflect.set(T, k, v, R)`, ECMA-262 OrdinarySetWithOwnDescriptor). What T's chain gives decides whether R is
 * written: a non-writable data property writes nothing, and an accessor's setter runs with R as `this`, which writes R
 * only for a `[Replaceable]` attribute of an interface R implements. A writable data property, or none, writes R's own
 * property: its own data property's value when it is writable, and otherwise a new own data property, when it has none.
 * The mutation is named on R: a replace of its own member, a shadowing write, or an add. An empty `lookup` is a chain
 * without the member, as §3 works out the write when T denotes no native holder.
 */
function receiverSet(
  change: Extract<Change, { kind: 'set' }>,
  written: { holder: string; record: CatalogHolder; chain: readonly string[] },
  lookup: readonly string[],
  target: (name: string) => CatalogTarget | undefined,
  webIdl: (member: CatalogTarget) => boolean,
  unresolvedLookup = false,
): Mutation | undefined {
  const { holder, record, chain } = written
  const name = memberName(holder, change.member)
  const own = target(name)
  const at = lookup.find((each) => target(memberName(each, change.member)) !== undefined)
  const found = at === undefined ? undefined : target(memberName(at, change.member))!
  let create = false
  if (found?.descriptor.type === 'accessor') {
    // The [Replaceable] setter checks that `this` implements the interface, then defines an own data property on it.
    const implemented = platformObjects.has(record.kind) && chain.includes(at!)
    if (found.assign !== 'replaceable' || !implemented) return undefined
    create = true
  } else if (found?.descriptor.writable === false) return undefined
  if (own !== undefined) {
    const { descriptor } = own
    // A define replaces a configurable own property, and a [[Set]] only a writable data property's value.
    const writable = create ? descriptor.configurable : descriptor.type === 'data' && descriptor.writable
    return writable && !change.same ? { name, holder: own.holder, effect: 'replace', locks: false } : undefined
  }
  // A new own data property holding the new value: over a member R inherits, a shadowing write when R can shadow it
  // (§4), and otherwise an add. When T denotes no native holder, §3 names only an inherited Web IDL member on a global
  // or prototype holder a shadowing write.
  const shadows = inheritedMember(chain, change.member, target)
  if (shadows !== undefined) {
    const inherited = target(shadows)!
    const shadowing = unresolvedLookup
      ? (record.kind === 'global' || record.kind === 'prototype') && webIdl(inherited)
      : shadowable(record.kind, inherited, webIdl)
    return shadowing ? { name, holder: record.kind, shadows, effect: 'replace', locks: false } : undefined
  }
  if (record.kind === 'global') return undefined
  const structuralMember = typeof change.member === 'string' && structural[record.kind]?.has(change.member)
  if (!addable.has(record.kind) || structuralMember || namedProperties(holder, record)) return undefined
  return { name, holder: record.kind, effect: 'add', locks: false }
}

/**
 * Whether a catalog member is a Web IDL member: one that IDL declares, or that the Web IDL binding synthesizes (§4
 * Sources: a prototype's `constructor`, a stringifier's `toString`, `@@iterator`), and not one of the ECMAScript
 * intrinsics a Web IDL chain ends in (`Object.prototype.toString`), which are no part of its IDL chain.
 */
function webIdlOf(catalog: SerializedCatalog): (member: CatalogTarget) => boolean {
  let specs = ecmascriptSpecsOf.get(catalog)
  if (specs === undefined) ecmascriptSpecsOf.set(catalog, (specs = ecmascriptSpecs(catalog)))
  const ecmascript = specs
  return (member) => !ecmascript.has(member.spec)
}

const ecmascriptSpecsOf = new WeakMap<SerializedCatalog, ReadonlySet<string>>()

/**
 * A change of the prototype of `holder`. One that sets the prototype the holder already has, or a value that is neither
 * an object nor `null` (a TypeError, or ignored by the `__proto__` setter), changes nothing. The same holder in two
 * windows is two objects, so a holder's prototype is known to be the one given only when both are reached through one
 * window expression (§3 Undecidable outcomes, §4 Other windows). Any other on an immutable prototype exotic object is
 * an ineffective write (§3), which may instead change nothing when the value may be the prototype it has (§3 No-op or
 * ineffective).
 */
function prototypeChange(
  holder: string,
  record: CatalogHolder,
  { proto, sameWindow }: Extract<Change, { kind: 'prototype' }>,
): Mutation | Named<Refused> | undefined {
  const [only] = proto
  const isCurrent = (value: Value) =>
    value.kind === 'constant' ? value.value === null && record.proto === null : value.kind === 'holder' && value.holder === record.proto
  if (proto.length === 1 && only !== undefined && isCurrent(only) && (only.kind === 'constant' || sameWindow)) return undefined
  if (proto.every((value) => value.kind === 'constant' && value.value !== null)) return undefined
  const name = prototypeTarget(holder)
  if (record.immutablePrototype === true) {
    // What may be the prototype the holder has: a value the analyzer can't see, or its prototype, maybe another window's.
    const mayChangeNothing = proto.some((value) => opaque(value) || isCurrent(value))
    return { name, holder: record.kind, effect: 'prototype-change', reason: 'immutable-prototype', mayChangeNothing }
  }
  return { name, holder: record.kind, effect: 'prototype-change', locks: false }
}

/** The holders a member can be added to (§3): native prototypes, constructors and namespaces. */
const addable: ReadonlySet<Holder> = new Set(['prototype', 'constructor', 'namespace'])

/**
 * Members every constructor or prototype has natively, although the catalog doesn't list them as targets there (§4):
 * a function's `length` and `name`, and a `prototype` and `constructor` where the catalog has none (a legacy callback
 * interface object, a prototype without an interface object, `HTMLDocument.prototype`). Where Web IDL or ECMA-262
 * defines them, `X.prototype` and `X.prototype.constructor` are targets, which a write finds first.
 */
const structural: Readonly<Partial<Record<Holder, ReadonlySet<string>>>> = {
  constructor: new Set(['length', 'name', 'prototype']),
  prototype: new Set(['constructor']),
}

/**
 * The holders that are platform objects implementing the interfaces of the attributes on them: the global object, and
 * the platform singletons. Interface prototype objects, interface objects and namespaces implement none.
 */
const platformObjects: ReadonlySet<Holder> = new Set(['global', 'instance'])

/**
 * The outcome of a write to a catalog member, or undefined when it has none that is plainly a mutation. `implemented`
 * says the object written implements the interface of the member, as a Web IDL attribute's setter checks.
 */
function memberEffect(
  change: Exclude<Change, { kind: 'prototype' }>,
  member: CatalogTarget,
  implemented: boolean,
): Outcome | Refused | undefined {
  const { descriptor } = member
  switch (change.kind) {
    case 'set':
      return setEffect(change, member, implemented)
    case 'delete':
      if (descriptor.configurable) return { effect: 'delete', locks: false }
      return { effect: 'delete', reason: 'non-configurable', mayChangeNothing: false }
    case 'define':
      return defineEffect(change.descriptor, descriptor)
  }
}

/** The outcome of a define of a catalog member whose descriptor in the unmutated catalog is `current`. */
function defineEffect(defined: DescriptorLiteral, current: Descriptor): Outcome | Refused | undefined {
  if (defined.unseen.length > 0) {
    // §3 Undecidable outcomes: what the analyzer can't see may make the define throw, change nothing or change the
    // member. A replace when an own `value` comes after every spread or key that doesn't fold, and doesn't read the
    // same slot, and a descriptor-change otherwise. The evidence is every part it can't see or decide.
    const effect = defined.value !== undefined && !defined.value.same ? 'replace' : 'descriptor-change'
    // A non-configurable member it can't change: it is ineffective, or changes nothing (§3 No-op or ineffective).
    if (!current.configurable && !redefinable(defined, current)) {
      return { effect, reason: 'non-configurable', mayChangeNothing: true }
    }
    // A getter whose key doesn't fold is unseen, and may also be what an attribute's setter joins.
    const sites = [...new Set([...defined.unseen, ...defined.undecided])].sort((a, b) => a.start - b.start)
    return { effect, locks: 'unknown', undecidable: { on: 'descriptor', sites } }
  }
  if (!current.configurable) return refusedDefine(defined, current)
  const locks = locksOf(defined, current)
  // A new getter/setter pair, or a data property turned into an accessor.
  if (isAccessor(defined)) return { effect: 'descriptor-change', locks }
  // A data descriptor over an accessor turns it into a data property, whose value is new (ADR 0011).
  if (current.type === 'accessor' && isData(defined)) return { effect: 'replace', locks }
  if (defined.value !== undefined && !defined.value.same) return { effect: 'replace', locks }
  return attributesChange(defined, current, locks)
}

/**
 * A seen define of a non-configurable member (ECMA-262 ValidateAndApplyPropertyDescriptor): it is refused, an
 * ineffective write, when it makes the member configurable, gives another `enumerable`, turns data into an accessor or
 * back, gives an accessor a getter or setter, or gives a non-writable data property `writable: true` or a new value.
 * When only fields the analyzer can't decide, or a value that may be the member's own, refuse it, it may instead change
 * nothing (§3 No-op or ineffective). A define it doesn't refuse gives nothing here: that leaves out only a define that
 * changes the one non-configurable writable data property, `Array.prototype.length`, as before this ticket.
 */
function refusedDefine(defined: DescriptorLiteral, current: Descriptor): Refused | undefined {
  const differs = (given: boolean | 'unknown' | undefined, native: boolean): boolean | 'unknown' =>
    given === undefined ? false : given === 'unknown' ? 'unknown' : given !== native
  const refusals: (boolean | 'unknown')[] = [differs(defined.configurable, false), differs(defined.enumerable, current.enumerable)]
  if (current.type === 'accessor') refusals.push(isData(defined) || defined.get || defined.set)
  else {
    refusals.push(isAccessor(defined))
    if (!current.writable) {
      refusals.push(differs(defined.writable, false))
      if (defined.value !== undefined && !defined.value.same) refusals.push(defined.value.fresh || 'unknown')
    }
  }
  if (!refusals.some((refused) => refused !== false)) return undefined
  // The effect it intended, as `defineEffect` gives it for a configurable member (ADR 0011): a new value is a replace,
  // a getter or setter, or attributes alone, a descriptor-change.
  const newValue = (current.type === 'accessor' && isData(defined)) || (defined.value !== undefined && !defined.value.same)
  const effect = !isAccessor(defined) && newValue ? 'replace' : 'descriptor-change'
  return { effect, reason: 'non-configurable', mayChangeNothing: !refusals.includes(true) }
}

/**
 * Whether a define whose descriptor is partly unseen can change a non-configurable member (ECMA-262
 * ValidateAndApplyPropertyDescriptor): only a writable data property can, and only when the fields the define shows
 * don't make it throw (`configurable: true`, another `enumerable`, an accessor). Every other define of it throws or
 * changes nothing: an ineffective write.
 */
function redefinable(defined: DescriptorLiteral, current: Descriptor): boolean {
  if (current.type !== 'data' || !current.writable || isAccessor(defined) || defined.configurable === true) return false
  return defined.enumerable === undefined || defined.enumerable === 'unknown' || defined.enumerable === current.enumerable
}

/**
 * The attributes a property a define creates starts from (ECMA-262 ValidateAndApplyPropertyDescriptor): a field the
 * descriptor lacks is `false` on a new property, which is a data property unless the descriptor gives `get` or `set`.
 */
const created: Descriptor = { type: 'data', writable: false, enumerable: false, configurable: false }

/**
 * Whether a define leaves its target locked (§8): non-configurable, or a data property that is non-writable, once
 * the define applies its descriptor over `base`, the member's descriptor in the unmutated catalog (or `created` for a
 * new property). A field the descriptor lacks keeps `base`'s attribute. A configurable accessor never locks, with or
 * without a setter. `unknown` when the descriptor has parts the analyzer can't see, or when an attribute that decides it
 * can't be decided.
 */
function locksOf(defined: DescriptorLiteral, base: Descriptor): Locks {
  if (defined.unseen.length > 0) return 'unknown'
  const configurable = defined.configurable ?? base.configurable
  const data = isAccessor(defined) ? false : isData(defined) || base.type === 'data'
  const writable = data ? (defined.writable ?? (base.type === 'data' ? base.writable : false)) : true
  if (configurable === false || writable === false) return true
  return configurable === 'unknown' || writable === 'unknown' ? 'unknown' : false
}

/**
 * The effect of a [[Set]] (`assign`, `bulk-assign`) of a catalog member (§3 What is a platform mutation):
 * - A writable data property is replaced, unless the write puts back the value the member holds, which changes
 *   nothing.
 * - A Web IDL attribute follows its `assign` kind (§4 Member data). A `[Replaceable]` setter replaces the attribute
 *   with an own data property of the object written, holding the new value, so it is a `replace` (ADR 0011). It first
 *   checks that the object written implements the interface, and throws a TypeError before writing when it doesn't: on
 *   an interface prototype object (`WorkerGlobalScope.prototype.performance = p`), it changes nothing. `setter`,
 *   `put-forwards` and `event-handler` run the attribute's setter: API use, and no mutation.
 *   `Window.opener`'s setter (IDL kind `setter`) redefines it as an own data property holding the value for any value
 *   but `null`, as a `[Replaceable]` setter does (§3): `null` is API use, a value shown to be non-null a
 *   `replace`, and a value that may be `null`, a write-back of what its getter returns among them, a `replace` whose
 *   outcome can't be decided.
 * - An ECMAScript accessor with a setter is API use too (other than `Object.prototype.__proto__`, whose setter is a
 *   `set-prototype`, `writes.ts`).
 * - A non-writable data property, a `readonly` or `lenient-setter` attribute, and an ECMAScript accessor without a
 *   setter can't change: ineffective writes (§3), `non-writable`, `lenient-setter` and `readonly`. A lenient setter
 *   first checks that the object written implements its interface, and throws before writing when it doesn't.
 */
function setEffect(
  change: Extract<Change, { kind: 'set' }>,
  member: CatalogTarget,
  implemented: boolean,
): Outcome | Refused | undefined {
  const { descriptor } = member
  const replace: Outcome = { effect: 'replace', locks: false }
  if (descriptor.type === 'data') {
    if (!descriptor.writable) return { effect: 'replace', reason: 'non-writable', mayChangeNothing: false }
    return change.same ? undefined : replace
  }
  if (member.assign === 'replaceable') return implemented ? replace : undefined
  if (isOpener(member) && implemented && change.value !== undefined && change.value.isNull !== true) {
    const { isNull, site } = change.value
    return isNull === false ? replace : { ...replace, undecidable: { on: 'value', sites: [site] } }
  }
  // A `[LegacyLenientSetter]` setter does nothing, once it has checked that the object written implements its interface.
  if (member.assign === 'lenient-setter') {
    return implemented ? { effect: 'replace', reason: 'lenient-setter', mayChangeNothing: false, quiet: true } : undefined
  }
  // An accessor without a setter: a readonly attribute, or an ECMAScript getter.
  if (!descriptor.setter) return { effect: 'replace', reason: 'readonly', mayChangeNothing: false }
  return undefined
}

/** Whether a member is `Window.opener`, the one Web IDL attribute whose [[Set]] outcome follows the value (§3, §4). */
const isOpener = (member: CatalogTarget): boolean =>
  member.owner === 'Window' && member.member === 'opener' && member.kind === 'attribute'

/**
 * ECMA-262 IsAccessorDescriptor and IsDataDescriptor. A descriptor never shows both (`writes.ts`): ToPropertyDescriptor
 * refuses it.
 */
const isAccessor = (defined: DescriptorLiteral): boolean => defined.get || defined.set
const isData = (defined: DescriptorLiteral): boolean => defined.value !== undefined || defined.writable !== undefined

/**
 * The outcome of a define that keeps the member's value: a `descriptor-change` when an attribute it gives differs from
 * the member's. When none plainly does, but one can't be decided, it is a `descriptor-change` whose outcome can't be
 * decided (§3 Undecidable outcomes). One that changes nothing is no mutation.
 */
function attributesChange(defined: DescriptorLiteral, descriptor: Descriptor, locks: Locks): Outcome | undefined {
  const attributes = [
    [defined.enumerable, descriptor.enumerable],
    [defined.configurable, descriptor.configurable],
    ...(descriptor.type === 'data' ? [[defined.writable, descriptor.writable] as const] : []),
  ] as const
  if (attributes.some(([given, native]) => given !== undefined && given !== 'unknown' && given !== native)) {
    return { effect: 'descriptor-change', locks }
  }
  if (attributes.some(([given]) => given === 'unknown')) {
    return { effect: 'descriptor-change', locks, undecidable: { on: 'descriptor', sites: defined.undecided } }
  }
  return undefined
}

/**
 * The catalog targets a write of a member on an object the analyzer can't resolve could mutate (§5 Partially resolved
 * writes): every target of the realm with that member whose outcome §3's table could make a mutation, taking the object
 * written to be one that implements the member's interface. API use, a constant member, a define that changes
 * nothing and an ineffective write are left out. Sorted by name.
 */
export function candidateTargets(
  change: Exclude<Change, { kind: 'prototype' }>,
  catalog: SerializedCatalog,
  realm: Realm,
): string[] {
  const spelling = typeof change.member === 'symbol' ? memberSpelling(change.member) : change.member
  // A define whose descriptor can be several could make the write a mutation through any of them.
  const changes =
    change.kind === 'define' && change.alternatives !== undefined
      ? change.alternatives.flatMap((descriptor) => (descriptor === 'refused' ? [] : [{ ...change, descriptor }]))
      : [change]
  return (targetsByMember(catalog, realm).get(spelling) ?? [])
    .filter(([, target]) =>
      // An ineffective write (§3) can't change its target, so it is no candidate either.
      changes.some((each) => {
        const outcome = memberEffect(each, target, true)
        return outcome !== undefined && !('reason' in outcome)
      }),
    )
    .map(([name]) => name)
}

/** How the catalog spells a member key: its string, or a well-known symbol's `@@` name. */
const memberSpelling = (key: symbol): string => memberName('', key).slice(1)

/** A realm's targets, by the member they name, each list in name order. */
function targetsByMember(catalog: SerializedCatalog, realm: Realm): ReadonlyMap<string, [string, CatalogTarget][]> {
  let realms = targetIndexes.get(catalog)
  if (realms === undefined) targetIndexes.set(catalog, (realms = new Map()))
  let index = realms.get(realm)
  if (index === undefined) {
    const built = new Map<string, [string, CatalogTarget][]>()
    const targets = catalog.targets[realm]
    for (const name of Object.keys(targets).sort()) {
      const target = targets[name]!
      const list = built.get(target.member)
      if (list === undefined) built.set(target.member, [[name, target]])
      else list.push([name, target])
    }
    realms.set(realm, (index = built))
  }
  return index
}

const targetIndexes = new WeakMap<SerializedCatalog, Map<Realm, ReadonlyMap<string, [string, CatalogTarget][]>>>()

/**
 * The outcome of a wildcard write (§3, §5 Partially resolved writes) with the effect its value gives, judged
 * over every catalog member it matches (`wildcardMembers`) as a write of that member would be:
 * - `finding`: some member it matches is changed. `mixed` says others are ineffective (`wildcard-outcome-mixed`, §9).
 *   An `add` changes only members the holder lacks, so it is one whenever the holder takes an add.
 * - `ineffective`: every member it matches that the write could change is ineffective, one outcome per reason.
 *
 * Undefined when the write changes none: every member is API use, or changes nothing (a delete through an object that
 * only inherits it), or an `add` on a holder that takes none.
 */
export type WildcardOutcome =
  | { kind: 'finding'; holder: Holder; locks: Locks; mixed: boolean; undecidable?: Mutation['undecidable'] }
  | { kind: 'ineffective'; holder: Holder; refused: Ineffective[] }

export function wildcardOutcome(
  write: Write,
  effect: Effect,
  catalog: SerializedCatalog,
  realm: Realm,
  members?: readonly MemberKey[],
  prefixes?: readonly string[],
): WildcardOutcome | undefined {
  const holders = catalog.holders[realm]
  const record = Object.hasOwn(holders, write.holder) ? holders[write.holder] : undefined
  // No wildcard lands on the global object.
  if (record === undefined || record.kind === 'global') return undefined
  if (effect === 'add') {
    // An add on the global object or a singleton gives nothing.
    if (!addable.has(record.kind) || namedProperties(write.holder, record)) return undefined
    const locks = write.change.kind === 'define' ? locksOf(write.change.descriptor, created) : false
    return { kind: 'finding', holder: record.kind, locks, mixed: false }
  }
  const { change } = write
  if (change.kind === 'prototype') return undefined
  const effective: Mutation[] = []
  const refused: Ineffective[] = []
  // A candidate set of members narrows the matched set to its candidates, and prefixes to the members of the holder and
  // its chain that start with one of them (§5).
  const matched =
    members === undefined && prefixes === undefined
      ? wildcardMembers(write.holder, catalog, realm)
      : narrowedMatches(write.holder, members, prefixes ?? [], catalog, realm).map(({ member }) => member)
  for (const member of matched) {
    for (const outcome of outcomesOf({ ...write, change: { ...change, member } }, catalog, realm)) {
      if (isIneffective(outcome)) refused.push(outcome)
      else effective.push(outcome)
    }
  }
  if (effective.length > 0) {
    const locks = mostLocking(effective.map((each) => each.locks))
    const undecidable = effective.find((each) => each.undecidable !== undefined)?.undecidable
    const mixed = refused.length > 0
    return { kind: 'finding', holder: record.kind, locks, mixed, ...(undecidable === undefined ? {} : { undecidable }) }
  }
  if (refused.length === 0) return undefined
  const byReason = new Map<IneffectiveReason, Ineffective>()
  for (const each of refused) {
    const first = byReason.get(each.reason)
    byReason.set(each.reason, first === undefined ? each : { ...first, mayChangeNothing: first.mayChangeNothing || each.mayChangeNothing })
  }
  return { kind: 'ineffective', holder: record.kind, refused: [...byReason.values()] }
}

/**
 * The catalog members a wildcard over `holder` matches (§3): the holder's own members. A singleton instance also
 * matches its interface's members, those of its interface prototype object (`History.prototype` for `history`,
 * `Storage.prototype` for `localStorage`, `Navigator.prototype` with its mixins for `navigator`), without the structural
 * `constructor` and `@@toStringTag`, which are no members of the interface, and not those of shared ancestors.
 */
export function wildcardMembers(holder: string, catalog: SerializedCatalog, realm: Realm): MemberKey[] {
  const own = ownMembers(holder, catalog, realm)
  const record = catalog.holders[realm][holder]
  const singleton = Object.hasOwn(catalog.singletons[realm], holder) ? catalog.singletons[realm][holder] : undefined
  if (record?.kind !== 'instance' || singleton === undefined || !('interface' in singleton)) return own
  const inherited = ownMembers(`${singleton.interface}.prototype`, catalog, realm).filter(
    (member) => member !== 'constructor' && member !== wellKnownSymbol('toStringTag'),
  )
  return [...own, ...inherited.filter((member) => !own.includes(member))]
}

/**
 * The catalog targets a wildcard over `holder` matches among `members` (§5), by name: the holder's own, and for a
 * singleton instance, its interface prototype's.
 */
export function wildcardTargets(holder: string, members: readonly MemberKey[], catalog: SerializedCatalog, realm: Realm): string[] {
  const targets = catalog.targets[realm]
  const singleton = Object.hasOwn(catalog.singletons[realm], holder) ? catalog.singletons[realm][holder] : undefined
  const prototype = singleton !== undefined && 'interface' in singleton ? `${singleton.interface}.prototype` : undefined
  return wildcardMembers(holder, catalog, realm)
    .filter((member) => members.includes(member))
    .map((member) => {
      const own = memberName(holder, member)
      return Object.hasOwn(targets, own) || prototype === undefined ? own : memberName(prototype, member)
    })
}

/**
 * The catalog members a wildcard over `holder` narrowed to a candidate set matches (§5), each once with its
 * target: those among `members` (`wildcardTargets`), and those of the holder and its chain that start with one of
 * `prefixes` (`prefixMembers`).
 */
export function narrowedMatches(
  holder: string,
  members: readonly MemberKey[] | undefined,
  prefixes: readonly string[],
  catalog: SerializedCatalog,
  realm: Realm,
): { member: MemberKey; target: string }[] {
  const out = new Map<MemberKey, string>()
  if (members !== undefined) {
    const keys = wildcardMembers(holder, catalog, realm).filter((member) => members.includes(member))
    const targets = wildcardTargets(holder, members, catalog, realm)
    keys.forEach((member, index) => out.set(member, targets[index]!))
  }
  for (const prefix of prefixes) {
    for (const { member, target } of prefixMembers(holder, prefix, catalog, realm)) if (!out.has(member)) out.set(member, target)
  }
  return [...out].map(([member, target]) => ({ member, target }))
}

/**
 * The catalog members of `holder` and its catalog prototype chain whose key is a string that starts with `prefix`, each
 * once, on its nearest owner, with the target that owner has: what a write there whose key starts with the prefix could
 * name or shadow (§5 Pattern wildcards, ADR 0002). A well-known symbol member starts with no string.
 */
export function prefixMembers(
  holder: string,
  prefix: string,
  catalog: SerializedCatalog,
  realm: Realm,
): { member: string; target: string }[] {
  const holders = catalog.holders[realm]
  const out: { member: string; target: string }[] = []
  const seen = new Set<string>()
  for (let at: string | null = holder; at !== null && Object.hasOwn(holders, at); at = holders[at]!.proto) {
    for (const member of ownMembers(at, catalog, realm)) {
      if (typeof member !== 'string' || !member.startsWith(prefix) || seen.has(member)) continue
      seen.add(member)
      out.push({ member, target: memberName(at, member) })
    }
  }
  return out
}

/** The members the catalog lists on a holder itself, as keys, in name order. */
function ownMembers(holder: string, catalog: SerializedCatalog, realm: Realm): MemberKey[] {
  let realms = ownMemberIndexes.get(catalog)
  if (realms === undefined) ownMemberIndexes.set(catalog, (realms = new Map()))
  let index = realms.get(realm)
  if (index === undefined) realms.set(realm, (index = new Map()))
  let members = index.get(holder)
  if (members === undefined) {
    const targets = catalog.targets[realm]
    members = []
    for (const name of Object.keys(targets).sort()) {
      const spelling = targets[name]!.member
      const key = spelling.startsWith('@@') ? wellKnownSymbol(spelling.slice(2)) : spelling
      if (memberName(holder, key) === name) members.push(key)
    }
    index.set(holder, members)
  }
  return members
}

const ownMemberIndexes = new WeakMap<SerializedCatalog, Map<Realm, Map<string, MemberKey[]>>>()

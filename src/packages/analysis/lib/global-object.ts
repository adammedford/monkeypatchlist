// Global resolution (§5): which native holder an expression denotes, for the syntactic forms that need no call
// evaluation. The global object is recognized through:
//
// - a free `window`, `self` or `globalThis` (the realm's names for its global object), and a `typeof`-guarded `global`
// - `||`, `&&`, `??` and `?:` chains of those, in any spelling: a `typeof` test of one of the realm's names for its
//   global object folds to a constant against the catalog, so a chain keeps only the arms it can take
// - `Function('return this')()`, whose sloppy function returns the global object whatever the caller's strictness
// - `this` at the top level of a classic script, as UMD wrappers pass it
//
// Other native holders are reached only from the global object, through properties whose value the catalog says is a
// holder (`XMLHttpRequest`, `Math`, `Intl.DateTimeFormat`, and `Window.Window`, the global interface's own interface
// object), interface objects' `prototype`, and `Object.getPrototypeOf` of a native holder, whose prototype the unmutated
// catalog gives (`console.[[Prototype]]`). A user object never reaches one, whatever its prototype chain:
// `Object.create(XMLHttpRequest.prototype)` is a user object. Platform singletons are holders under their canonical path
// (§4), reached through every access path in the realm's alias groups: `localStorage`, `window.localStorage`,
// `document.location`, `clientInformation.geolocation`.
//
// Other windows (§5) are windows too, in the window realm, with the same holders: `parent`, `top` and `opener` of a
// resolved window, a child window, and `defaultView` and `contentWindow` on any object. A window's `frames` is that same
// window, spelled as the frames collection. A constant array index read on any window is a child window (`window[0]`,
// `parent["1"]`), and so is an unresolved key read on a window spelled as the frames collection (`frames[i]`,
// `parent.frames[i]`). Each leaf records the realm instance its value belongs to: the artifact's own window (`current`),
// another (`other`), or either (`unknown`). This window's `document.defaultView`, and the `parent` of its child windows,
// are this window. Code that another window's `eval`, `Function` or timer compiles has that window's global object.
//
// Constants (§5 Resolver capabilities 1): a `const`, destructured or not, whose value is a primitive constant has that
// value wherever it is read, however long the chain of constants it comes through. `+`, template literals and every
// numeric operator fold constant operands as ECMA-262 does (Principle 2, `numeric.ts`), and an operation that throws
// gives no value at all (Principle 1). A BigInt literal is a constant, and so is a free `undefined`, `NaN` or
// `Infinity`, and a well-known symbol read from the real `Symbol` holder (`Symbol.iterator`, §4 Property keys). A
// computed key that folds to a constant names the member it names, as ToPropertyKey converts it, as the dot form does.
// Each fold a value comes from travels on it (`Fold`), for the trace (§14).
//
// Aliases (§5 Resolver capabilities 2): any other variable's value is the union of the values of its definitions that
// reach the read (`definitions.ts`), each after an alias fold that the trace records as an `alias` step. Destructuring
// reads the members of any value as a member expression does (`const { prototype: p } = XMLHttpRequest`). A free name,
// or a classic script's top-level `var`, whose assignment takes effect follows its value the same way once the code
// assigns it, the global object's own value counting only where the walk shows no assignment has run (§5 Reassigned
// globals). A value can also be a native writer function or a global compiler (`native`), so that an alias of one
// (`Ae = Object.defineProperty`, `e = eval`) is followed.
//
// The heap (§5 Resolver capabilities 5): an object literal, an array literal, a `new` expression and the objects some
// natives return are objects with an allocation site, per summary instantiation and unrolled loop iteration. A field
// read gives what the literal and every write the analyzer sees give the field, and never decides a test. Expandos on
// native holders and on the global object are heap cells too. Descriptors are read from the heap (`objectParts`).
//
// Functions, `this` and dispatch (§5 Resolver capabilities 3): a function or class is a heap object made in the frame
// it closes over, with its `prototype`, its static members and its instances' fields and methods. `this` is a frame's
// receiver. A call the syntax doesn't name is resolved from its callee's values, and a function object no resolved call
// reaches runs in a `creation` frame with the `this` it is held on.

import type { Realm, SerializedCatalog } from '../../../catalog.ts'
import { calleeExpression, setsLiteralPrototype, walkTree, type AstNode } from './ast.ts'
import { literalKey, memberName, toPropertyKey, wellKnownSymbol, type Key } from './keys.ts'
import { bindsOwn, compoundOf, identifiersOf, passes, shadowedNameOf, type Definition, type Definitions, type Reaching, type VariableKey } from './definitions.ts'
import type { ModuleLink, ModuleLinks } from './module-links.ts'
import { earlyExits as exitGuards, exitsBefore, statementLists } from './early-exits.ts'
import { onceFlags } from './once-flags.ts'
import { binaryOperation, numericBinary, numericUnary, unaryOperation, type Outcome } from './numeric.ts'
import { boundNames, type GlobalBinding, type ScopeRules, type Taint } from './scope.ts'
import {
  callFrame,
  frameOf,
  constructorOf,
  framesInDocumentOrder,
  isClass,
  isFunction,
  isLoop,
  mergedFrame,
  frameId,
  onChain,
  widenedFrame,
  type Binding,
  type CallGraph,
  type CallSite,
  type Frame,
} from './summaries.ts'
import type { Caps } from './budget.ts'
import type { GlobalForm, RealmInstance } from './types.ts'

/**
 * The names a realm's global object has for itself (HTML: `Window` and `WorkerGlobalScope`; ECMA-262 `globalThis`). A
 * window's `frames` returns the window itself, as `window` and `self` do (§5 Other windows).
 */
const windowNames: ReadonlySet<string> = new Set(['window', 'self', 'globalThis', 'frames'])
const workerNames: ReadonlySet<string> = new Set(['self', 'globalThis'])

/**
 * The value properties of the global object (ECMA-262 19.1) that hold a primitive: a free name that resolves to no
 * declaration has that value in every realm (§5 Resolver capabilities 1).
 */
const globalValues: Readonly<Record<string, undefined | number>> = { undefined, NaN, Infinity }

/**
 * A window's members whose value is another window (HTML): its parent, its top-level window and its opener. Only
 * `opener` is commonly null. An index read on a window is a child window (`childWindow`).
 */
const windowMembers: ReadonlyMap<string, { nullable: boolean }> = new Map([
  ['parent', { nullable: false }],
  ['top', { nullable: false }],
  ['opener', { nullable: true }],
])
/** Members that are a window, or null, on any object (§5 Other windows): a document's, or an iframe's. */
const anyObjectWindows: ReadonlySet<string> = new Set(['defaultView', 'contentWindow'])

/**
 * How an expression reached a native holder (§14): where the global object was recognized, and in which form, or the
 * step from another value that reached it (a singleton, or another window), after that value's own leaves.
 */
export interface Leaf {
  /**
   * How the holder was reached: one of the global forms (§5), or `prototype-of`, `Object.getPrototypeOf(h)` of a native
   * holder, which the unmutated catalog decides (§4).
   */
  form: GlobalForm | 'prototype-of'
  /** The node recognized: an identifier, a `this`, or the `Function('return this')()` call. */
  node: AstNode
  /** The name the form starts from: `window`, `global`, `this`, `Function`, `XMLHttpRequest`; `[0]` for an index read. */
  name: string
  /** For a name, how it resolved: to no declaration, or to one that binds the global object's property (§5). */
  binding?: GlobalBinding
  /** For a global property, the holder the catalog says its value is; for a singleton, the singleton. */
  holds?: string
  /** For a singleton, the access path from the global object its alias group lists (`document.location`). */
  path?: string
  /** For a `typeof`-guarded `global`, the test that guards it. */
  guard?: AstNode
  /** The outermost `?:`, `||`, `&&` or `??` chain the leaf was selected through. */
  chain?: AstNode
  /** The window the value belongs to: the artifact's own (`current`), another (`other`), or either (`unknown`). */
  instance: RealmInstance
  /** For a step from another value (`window.parent`), the leaves that value was reached from. */
  base?: Leaf[]
  /**
   * For another window, the window expression it is (§3 Undecidable outcomes), as a key: `~.parent`, `~[0]`,
   * `(#x).contentWindow`. It is undefined when the analyzer can't show that two reads of it reach one window.
   */
  window?: string
  /** For a child window (an index read on a window), the window expression of the window it is a child of. */
  childOf?: string
  /**
   * Whether the window was read as the frames collection (§5 Other windows): a bare `frames`, `.frames`, or a constant
   * `["frames"]`. The mark travels with the value, and reading any other member drops it. Only a window spelled so takes
   * an unresolved key as a child window.
   */
  frames?: true
  /**
   * For `Object.getPrototypeOf(h)`, the holder `h` whose prototype it is. Its `holds` is that prototype, and `base` the
   * leaves `h` was reached from.
   */
  prototypeOf?: string
  /** For `Object.getPrototypeOf(h)`, the leaves the native `Object` it calls was reached from. */
  callee?: Leaf[]
}

/**
 * The window expression of the code's own global object (§3): the window whose global object its free names are
 * properties of. Its names (`window`, `self`, `frames`, a top-level `this`), its `document.defaultView` and its
 * `frames[i].parent` are all this window, with the code's realm instance (§5): `current` in the artifact's own code.
 */
const thisWindow = '~'

/**
 * The window expression a value was reached through (§3 Undecidable outcomes): the window it belongs to, as a key that
 * two reads of the same window expression share. It is undefined when its leaves disagree, or one reaches a window the
 * analyzer can't name.
 */
export function windowOf(leaves: readonly Leaf[]): string | undefined {
  const [first, ...rest] = leaves.map(leafWindow)
  return first !== undefined && rest.every((window) => window === first) ? first : undefined
}

function leafWindow(leaf: Leaf): string | undefined {
  switch (leaf.form) {
    case 'other-window':
      return leaf.window
    case 'singleton':
    case 'prototype-of':
      return windowOf(leaf.base ?? [])
    case 'function-return-this':
      // Through another window's `Function`, that window's global object.
      return leaf.base === undefined ? thisWindow : windowOf(leaf.base)
    default:
      return thisWindow
  }
}

/**
 * Whether two values were reached through the same window (§3 Undecidable outcomes): the same window expression, which
 * the analyzer can show reaches one window both times. Only this window stays the same whatever the code does. Another
 * window expression can reach another window once the program's state changes (`x`, `i` or the frames in
 * `x.contentWindow` or `frames[i]`, or a replaced `parent`), so it is the same only when nothing `evaluated` around the
 * two reads can change that state.
 */
export function sameWindow(a: readonly Leaf[], b: readonly Leaf[], evaluated: readonly AstNode[]): boolean {
  const window = windowOf(a)
  if (window === undefined || window !== windowOf(b)) return false
  return window === thisWindow || evaluated.every(withoutEffects)
}

/** What a key starts a name or a `this` with, so that no name's key is a constant's or a window expression's. */
const variable = '#'

/** Nodes whose evaluation can change the program's state: assignments, updates, calls, and code that runs or iterates. */
const effects: ReadonlySet<string> = new Set([
  'AssignmentExpression',
  'UpdateExpression',
  'CallExpression',
  'NewExpression',
  'TaggedTemplateExpression',
  'AwaitExpression',
  'YieldExpression',
  'ImportExpression',
  'ClassExpression',
  // Spreading an iterable calls its iterator.
  'SpreadElement',
])

/** Whether evaluating an expression can't change the program's state: it has no assignment, call or `delete` in it. */
function withoutEffects(expression: AstNode): boolean {
  let pure = true
  walkTree(expression, {
    enter(node) {
      if (effects.has(node.type) || (node.type === 'UnaryExpression' && node['operator'] === 'delete')) pure = false
      return pure ? undefined : false
    },
  })
  return pure
}

/** The name of the realm's global object holder, e.g. `Window`. */
export function globalHolder(catalog: SerializedCatalog, realm: Realm): string {
  for (const [name, holder] of Object.entries(catalog.holders[realm])) if (holder.kind === 'global') return name
  throw new Error(`the catalog has no global holder in the ${realm} realm`)
}

/** Leaves in document order, as a trace lists their binding steps. */
export const inDocumentOrder = (leaves: readonly Leaf[]): Leaf[] => [...leaves].sort((a, b) => a.node.start - b.node.start)

/** A primitive constant the analyzer knows: a well-known symbol is one too (§4 Property keys, `keys.ts`). */
export type Primitive = string | number | bigint | boolean | null | undefined | symbol

/**
 * A fold (§14): an expression the analyzer folded to a constant. It is a `+` or a template literal with constant parts,
 * or a `const` read through its `name`, whose value comes from `node`: its initializer, the element or property it
 * destructures, or a default. `taint` is what lies between the name and its declaration (§5 post-pass 3). The trace
 * records a fold only when JSON can carry its value, but it records a fold's taint whatever the value.
 */
export interface Fold {
  node: AstNode
  name?: string
  value: Primitive
  taint?: Taint
  /** For a well-known symbol, the leaves of the `Symbol` holder it was read from, whose steps come before the fold's. */
  via?: Leaf[]
  /**
   * For an alias (§5 Resolver capabilities 2): the value was read through the variable `name`, from its definition
   * `node` (a declarator, an assignment, an update or a loop head). Its `value` is undefined, and the trace records it as
   * an `alias` step.
   */
  alias?: true
  /**
   * For a summarized call (§5 Resolver capabilities 3): the value was bound to a parameter, or returned, by the call
   * `node`, whose site and frame this is. Its `name` is `()` and its `value` undefined, and the trace records it as a
   * `call` step.
   */
  call?: Binding
  /** For a summarized call's parameter, the index of the argument the value came in through. */
  argument?: number
  /** For a summarized call, that the value is the call's `this`: the receiver of a method, a `new`'s instance. */
  receiver?: true
  /**
   * For a value read from the heap (§5 Resolver capabilities 5): `node` is the expression that gave the field its value
   * (a literal's property value, or the value a write assigns). A value that carries one never decides a test. Its
   * `name` is `.` and its `value` undefined, and the trace records no step for it.
   */
  heap?: true
  /**
   * For a heap fold: the value is a field of an object literal passed directly as a call argument, read inside that
   * call's summary instance (§5 Resolver capabilities 5): the literal, `decides`, whose
   * field it is. Such a value still decides no test until a test settles it (`settled`): an arm's test, or a `?:`,
   * `&&`, `||` or `??` selection, once nothing writes to the literal.
   */
  decides?: Allocation
  /** For a heap fold with `decides`: a test settled it, so the value decides that test. */
  settled?: true
  /**
   * For a value read through a once-flag (§5 Resolver capabilities 6): `node` is the read. A value that carries one never
   * decides a test. Its `name` is `?` and its `value` undefined, and the trace records no step for it.
   */
  flag?: true
  /**
   * For an own-property test the unmutated catalog decided (§4 A holder chosen at runtime, §5 Resolver capabilities 8):
   * `node` is the test, and `value` whether the holder owns the member. The trace records it as a `catalog-holder` step.
   */
  catalog?: OwnTest
  /**
   * For a prototype walk the unmutated catalog simulated (§4 A holder chosen at runtime): `node` is the loop, and the
   * walk's holders, in order, end in the one the value is. The trace records it as a `catalog-holder` step.
   */
  walked?: WalkChoice
  /**
   * For a module link (§6): the value came through a require call or a module's export, which `node` is. Its `name` is
   * `module-link` and its `value` undefined, and the trace records it as a `module-link` step.
   */
  link?: ModuleLink
  /**
   * For a key a member sweep gave (§5 Resolver capabilities 9): `node` is the enumeration (the call, or the `for…in`
   * loop's object), and the sweep says which holder, how, which member, and the filters the key went through. Its
   * `name` is `#` and its `value` the key, and the trace records it as an `enumeration` step.
   */
  sweep?: Sweep
}

/** How a member sweep enumerates a native holder's keys (§5 Resolver capabilities 9). */
export const sweepForms = [
  'for-in',
  'Object.keys',
  'Object.getOwnPropertyNames',
  'Object.entries',
  'Object.getOwnPropertyDescriptors',
  'Reflect.ownKeys',
  'Object.getOwnPropertySymbols',
] as const
export type SweepForm = (typeof sweepForms)[number]

/**
 * A key a member sweep gave (§5 Resolver capabilities 9): the native `holder` swept, the enumeration `form`, the
 * catalog `member` the key is, as the catalog spells it, and each filter the key went through, in order: `kept` when
 * the filter keeps it, `undecided` when the analyzer can't tell, which makes reachability `conditional`.
 */
export interface Sweep {
  holder: string
  form: SweepForm
  member: string
  filters: readonly { node: AstNode; result: 'kept' | 'undecided' }[]
}

/** The sweeps a value's key came from (§5 Resolver capabilities 9). */
export function sweepsOf(value: Value): Sweep[] {
  if (!('folds' in value) || value.folds === undefined) return []
  return value.folds.flatMap((fold) => (fold.sweep === undefined ? [] : [fold.sweep]))
}

/** Whether a value carries a key a member sweep gave. */
export const isSwept = (value: Value): boolean => sweepsOf(value).length > 0

/** A prototype walk's holders from its start value, in order, the `holder` it stops at, and the `member` it looks for. */
export interface WalkChoice {
  walk: string[]
  holder: string
  member?: string
}

/**
 * An own-property test the unmutated catalog decided (§4): whether the native holder `tested` owns `member`, a catalog
 * member spelt as the catalog spells it (`pushState`, `@@iterator`). With no `member`, the key didn't fold, and the
 * holder owns no catalog member other than the structural `constructor`, `@@toStringTag` and `prototype`, so it owns
 * none that counts.
 */
export interface OwnTest {
  tested: string
  member?: string
  owns: boolean
}

/**
 * An abstract value: a native holder reached from the global object, with every leaf it was reached from; a primitive
 * constant; an object the analyzer knows is no native holder (a literal, a function, an instance); or unknown. A holder
 * or constant carries the folds it comes from, in the order they were made: each after those it folds. A value a
 * constant decided, such as the branch a `?:` with a constant test takes, carries that constant's folds too.
 */
export type Value =
  /**
   * `absent`: a native holder read as a property of the global object (`window.EventTarget`, `self.document`), which
   * may be missing, so a test on it may be falsy (§7). The global object, a bare global
   * name and a holder read from any other holder are always present.
   */
  | { kind: 'holder'; holder: string; leaves: Leaf[]; folds?: Fold[]; absent?: true }
  /**
   * `tested`: a heap-read or once-flag boolean, `null` or `undefined` that `&&`, `||` or `??` gives back from its
   * undecided test operand. It is never a key (§5 Candidate sets).
   */
  | { kind: 'constant'; value: Primitive; folds?: Fold[]; tested?: true }
  | { kind: 'native'; name: NativeName; leaves: Leaf[]; folds?: Fold[]; sites?: AstNode[] }
  /**
   * `assumed`: an object that is only a caller-less function's assumed `this` (§5 Resolver capabilities 3), the object
   * it is held on, and whatever reached it only from there. A write through it makes no literal non-constant (§5
   * Resolver capabilities 4).
   */
  | { kind: 'object'; heap?: Allocation; folds?: Fold[]; assumed?: true }
  | { kind: 'member'; target: string; holder: string; sites: AstNode[]; leaves: Leaf[]; folds?: Fold[] }
  /**
   * `prefix`: a string the analyzer can't fold whole, but whose start a `+` or a template folds to this non-empty
   * constant (`'__zone_symbol__' + name`). Everything but a write's key takes it as unknown (§5 Pattern wildcards).
   */
  | { kind: 'unknown'; prefix?: string }

export type HolderValue = Extract<Value, { kind: 'holder' }>
/**
 * A catalog function read from a native holder (§5 Resolver capabilities 10): `window.fetch`, a bare `fetch`,
 * `EventTarget.prototype.addEventListener`, as the unmutated catalog has it. `target` is the catalog target the read
 * reaches on `holder`'s chain, and `sites` the reads that gave it. Only wrap evidence tells it from an unknown value:
 * everything else treats it as unknown (`opaque`), so it never decides a test.
 */
export type MemberValue = Extract<Value, { kind: 'member' }>

/** Whether a value is one the analyzer treats as unknown: unknown, or a catalog function (`MemberValue`). */
export const opaque = (value: Value): boolean => value.kind === 'unknown' || value.kind === 'member'
export type ObjectValue = Extract<Value, { kind: 'object' }>
export type HeapValue = ObjectValue & { heap: Allocation }

/**
 * An allocation site (§5 Resolver capabilities 5): a syntactic site that makes an object, in one summary instantiation
 * or unrolled loop iteration, `frame`. Its fields are evaluated where it is, at `at`.
 * - `literal`: an object literal, or `Object.create(null)`, which is treated like `{}`
 * - `array`: an array literal, whose elements are capability 4's (§5), so only its expandos are heap fields
 * - `instance`: a `new` expression, whose constructor may give it fields the analyzer doesn't see
 * - `returned`: an object a native returns (`Object.getOwnPropertyDescriptor`), with unseen base fields
 * - `copy`: `Object.assign(literal, …sources)`, which copies each source's seen fields into the literal as a spread does
 * - `function`: a function or class, created in the frame `at.frame`, whose free variables it reads there (its closure)
 * - `prototype`: the object a function's or class's `prototype` holds, made with it
 * - `bound`: what `f.bind(t, …args)` returns
 *
 * An `instance` whose node is a class is the class's generic instance: the one its members run with when no `new` of it
 * was analyzed (§5 Resolver capabilities 3).
 */
export interface Allocation {
  id: string
  node: AstNode
  at: Position
  frame: string | undefined
  kind: 'literal' | 'array' | 'instance' | 'returned' | 'copy' | 'function' | 'prototype' | 'bound'
}

/** Whether a value is an object the heap holds. */
export const isHeap = (value: Value): value is HeapValue => value.kind === 'object' && value.heap !== undefined

/**
 * Whether a fold keeps its value from deciding a test: a heap read (§5 Resolver capabilities 5), except a call
 * argument literal's field a test settled, or a read through a once-flag (capability 6).
 */
const undecidedFold = (fold: Fold): boolean => (fold.heap === true && fold.settled !== true) || fold.flag === true

/**
 * Whether a value never decides a test: it was read from the heap (§5 Resolver capabilities 5) or through a once-flag
 * (capability 6).
 */
const undecided = (value: Value): boolean => carriesFolds(value) && (value.folds?.some(undecidedFold) ?? false)

/**
 * A part of an object as a descriptor reads it (§3 Undecidable outcomes, §5 Resolver capabilities 5), in the order
 * ToPropertyDescriptor's view of it is built:
 * - `field`: a field the object has, with its key, the property or write that gives it, and whether that is a getter or
 *   setter. `sources` are the expressions that give its value, each where it is evaluated. `maybe` is the write that
 *   gives a field written after allocation, which may be absent.
 * - `unseen`: a part that may give any field: a spread or key that doesn't fold, an object's unseen base fields.
 * - `proto`: a literal's `__proto__: p`, whose object supplies the fields the literal lacks.
 */
export type ObjectPart =
  | {
      kind: 'field'
      key: Key
      site: AstNode
      accessor?: 'get' | 'set'
      sources: { node: AstNode; at: Position }[]
      values: Value[]
      folds: Fold[]
      maybe?: AstNode
    }
  | { kind: 'unseen'; node: AstNode }
  | { kind: 'proto'; site: AstNode; values: Value[] }

/** One object a descriptor can be: its allocation site and its parts. */
export interface ObjectParts {
  node: AstNode
  parts: ObjectPart[]
}
export type NativeValue = Extract<Value, { kind: 'native' }>

/**
 * The native functions a value can be, so that an alias of one is followed (§5 Resolver capabilities 2): the writer
 * functions (by catalog name, `Object.defineProperty`); the functions a route to a native that compiles code goes
 * through (`Function.prototype.call`, `Reflect.apply`, `Object.getOwnPropertyDescriptor`, `code-routes.ts`), of which
 * `Object.getPrototypeOf` also chooses a holder against the catalog; and the global object's functions that compile
 * code from strings (`eval`, `setTimeout`, `setInterval`). The `Function` constructor is a holder.
 */
const nativeReaderNames = [
  'Object.hasOwn',
  'Object.prototype.hasOwnProperty',
  'Object.getPrototypeOf',
  'Reflect.getPrototypeOf',
  'Reflect.get',
  'Object.getOwnPropertyDescriptor',
  'Reflect.getOwnPropertyDescriptor',
  'Reflect.apply',
  'Reflect.construct',
  'Function.prototype.call',
  'Function.prototype.apply',
  'Function.prototype.bind',
] as const
export const nativeWriterNames = [
  'Object.defineProperty',
  'Reflect.defineProperty',
  'Object.defineProperties',
  'Object.assign',
  'Object.setPrototypeOf',
  'Reflect.setPrototypeOf',
  'Reflect.set',
  'Reflect.deleteProperty',
] as const
const nativeCompilerNames = ['eval', 'setTimeout', 'setInterval'] as const
export type NativeName =
  | (typeof nativeWriterNames)[number]
  | (typeof nativeCompilerNames)[number]
  | (typeof nativeReaderNames)[number]
const memberNatives: ReadonlySet<string> = new Set([...nativeWriterNames, ...nativeReaderNames])
const compilerNames: ReadonlySet<string> = new Set(nativeCompilerNames)

/**
 * The string natives a filter on a swept key is evaluated with (§5 Resolver capabilities 9): ECMA-262's
 * `String.prototype` methods that take no callback and no pattern, and whose result is bounded by their inputs.
 */
const stringNatives: ReadonlySet<string> = new Set([
  'at',
  'charAt',
  'charCodeAt',
  'codePointAt',
  'endsWith',
  'includes',
  'indexOf',
  'lastIndexOf',
  'slice',
  'startsWith',
  'substr',
  'substring',
  'toLowerCase',
  'toUpperCase',
  'trim',
  'trimStart',
  'trimEnd',
])
/** The `RegExp.prototype` methods a regular-expression literal filter on a swept key is run with. */
const regexNatives: ReadonlySet<string> = new Set(['test', 'exec'])
/** No element: a list element the analyzer can't fold. */
const unknownMember: unique symbol = Symbol('unknown element')

/** The methods a key enumeration is called by (§5 Resolver capabilities 9). */
const sweepMethods: ReadonlySet<string> = new Set(['keys', 'getOwnPropertyNames', 'entries', 'getOwnPropertyDescriptors', 'ownKeys', 'getOwnPropertySymbols'])

/**
 * The expressions whose value may be another's: a name, a member read, a call, whose resolved functions may return a
 * native (core-js's `setPrototypeOf = require('object-set-prototype-of')`), or a choice or sequence that ends in one.
 */
const aliasing: ReadonlySet<string> = new Set([
  'Identifier',
  'CallExpression',
  'MemberExpression',
  'ChainExpression',
  'LogicalExpression',
  'ConditionalExpression',
  'SequenceExpression',
  'AssignmentExpression',
])

/** Whether a definition may give its variable another value's alias: it reads a name or a member, calls, or destructures. */
const mayAlias = (definition: Definition): boolean =>
  definition.source !== undefined && (definition.pattern.type !== 'Identifier' || aliasing.has(definition.source.type))

/** Whether a value carries the folds it comes from: a holder, a constant, or a native function. */
const carriesFolds = (value: Value): value is Exclude<Value, { kind: 'unknown' }> =>
  value.kind === 'holder' ||
  value.kind === 'constant' ||
  value.kind === 'native' ||
  value.kind === 'member' ||
  (value.kind === 'object' && (value.heap !== undefined || value.folds !== undefined))
type ConstantValue = Extract<Value, { kind: 'constant' }>

/** The realm instance of a value reached from several leaves: theirs when they agree, otherwise `unknown`. */
export function instanceOf(leaves: readonly Leaf[]): RealmInstance {
  const [first, ...rest] = leaves
  return first !== undefined && rest.every((leaf) => leaf.instance === first.instance) ? first.instance : 'unknown'
}

/** The realm instance of a window reached from a window: another, unless the window it is reached from is unknown. */
const hop = (from: RealmInstance): RealmInstance => (from === 'unknown' ? 'unknown' : 'other')

/** What is known at a position in the program. */
export interface Position {
  /** The `typeof` test around the position that shows the free name is defined, if there is one. */
  guard(name: string): AstNode | undefined
  /** Whether `this` at the position is the script's top-level `this` (no function, field or static block around it). */
  topLevel: boolean
  /**
   * The instantiation of the function the position is in (§5 Resolver capabilities 3): its parameters take the
   * arguments of the frame's calls. None when the function runs with unknown arguments.
   */
  frame?: Frame | undefined
}

export interface GlobalResolution {
  /** The values an expression can have at a position. */
  evaluate(node: AstNode, at: Position): Value[]
  /**
   * The object and key of an own-property test call, by any route (§4 A holder chosen at runtime): `Object.hasOwn(h,
   * k)`, `h.hasOwnProperty(k)`, through `.call`, `.apply` or `Reflect.apply`. The key is `null` when the call passes
   * none. Undefined for a call that is no such test.
   */
  ownTestParts(call: AstNode, at: Position): { object: AstNode; key: AstNode | null } | undefined
  /**
   * Finds the calls whose callees the syntax doesn't name (§5 Resolver capabilities 3), before any other evaluation,
   * so that it starts with nothing else on the stack.
   */
  prepare(): void
  /**
   * The values a called name can have when it may be an alias of a native function or holder (§5 Resolver capabilities
   * 2): a variable one of whose definitions reads a name or a member, or destructures one. None for any other name, so
   * that the many calls of local functions cost nothing.
   */
  aliasCallee(id: AstNode, at: Position): Value[]
  /**
   * The free names a `typeof` guard shows are defined when control enters `child` of `parent`, each with the `typeof`
   * test that shows it: in the consequent or alternate of an `if` or `?:`, or the right side of `&&` or `||`.
   */
  guards(parent: AstNode, child: AstNode): Guards
  /**
   * Runs `run`, and gives with its result the folds that passed the `fold-length` cap in what it evaluated (§13
   * `analysis-budget`), each once: those it hit, and those of the constants it read, whether their hits were counted
   * then or before. They count for any `tracked` run around this one too, unless this one is `apart`.
   */
  tracked<T>(run: () => T, apart?: boolean): { value: T; capped: AstNode[] }
  /**
   * Runs `run`, and gives with its result the functions whose parameters it read with no frame to bind them (§5
   * Resolver capabilities 3): a write that reads them is instantiated in each frame of its function.
   */
  contextual<T>(run: () => T): { value: T; functions: ReadonlySet<AstNode> }
  /**
   * The frames a function is instantiated in for the writes in it (§5 Resolver capabilities 3), out along its calls:
   * none when no call of it is known.
   */
  framesOf(fn: AstNode, deep?: boolean): Frame[]
  /**
   * The resolved calls of a function (§7 Where reachability is judged from), each with the frame of its caller when the
   * resolver has one: the calls the syntax names, in document order, then those it doesn't (methods, callbacks,
   * closures, the call natives), as the dynamic-call index found them. A module's factory is called by the require calls
   * that link its module (§6). Finding them counts no cap hit: it reads only what the resolver has found.
   */
  callersOf(fn: AstNode): Binding[]
  /**
   * Whether a call argument literal may decide a test in `fn`'s own code (§5 Resolver capabilities 5): some call
   * passes `fn` an object literal directly, and the test reads a field of one of `fn`'s parameters. Only such a test is
   * evaluated in a call's frame for it.
   */
  argumentTest(test: AstNode, fn: AstNode): boolean
  /** A test's values, with each call argument literal's field that nothing writes to settled, to decide it. */
  settled(values: Value[]): Value[]
  /**
   * Runs `run`, and gives with its result the tests a call argument literal's field decided in what it evaluated,
   * each with that literal, once: those it settled, and those settled while finding the values it read.
   */
  decided<T>(run: () => T): { value: T; decisions: Decision[] }
  /**
   * Runs `run` as the evaluation would be without some of the argument-literal rule's decisions: no test
   * `unsettles` holds for is settled. What it evaluates is memoized apart, under `variant`, and its steps and cap hits
   * count as any evaluation's do, so a caller that only compares results undoes them.
   */
  counterfactual<T>(variant: string, unsettles: (decision: Decision) => boolean, run: () => T): T
  /** The node a node is a child of. */
  parentOf(node: AstNode): AstNode | undefined
  /** Whether a member sweep has given keys yet (§5 Resolver capabilities 9): no value is a swept key before one has. */
  swept(): boolean
  /**
   * Whether a read names a once-flag by use (§5 Resolver capabilities 6): a variable or parameter some function tests and
   * then assigns on the path the test lets through, whatever it reads.
   */
  onceFlag(id: AstNode): boolean
  /**
   * The frame a function or class runs in with no call known: the closure it was made in, with unknown parameters
   * and no `this` of its own. A function object's body is read in it for wrap evidence (§5 Resolver capabilities 10).
   */
  closureFrame(fn: AstNode, closure: Frame | undefined): Frame
  /**
   * The argument values a call site passes, evaluated in `caller`, one list per argument bound to a parameter (for the
   * lookup of a write inside a helper, §10).
   */
  argumentValues(binding: Binding): Value[][]
  /**
   * Whether the argument `index` of a call carries the member `key` that came in through it (§10): it is the key,
   * or holds it as an element of a constant collection, or is a string the helper splits into it (`member` has that
   * split's fold), or an object the member was read out of through heap fields (`member` has a heap fold).
   */
  argumentCarries(binding: Binding, index: number, key: Key, member: readonly Fold[]): boolean
  /**
   * The objects a descriptor expression can be, each with its parts as ToPropertyDescriptor reads them (§3, §5 Resolver
   * capabilities 5): undefined unless every value it can have is an object the heap holds.
   */
  objectParts(node: AstNode, at: Position): ObjectParts[] | undefined
  /**
   * The values a descriptor expression can be, as alternatives (§3 Undecidable outcomes, Principle 3): the
   * objects the heap holds, each with its parts as ToPropertyDescriptor reads them; whether it can be a primitive,
   * which ToPropertyDescriptor refuses; and whether it can be anything else, which the analyzer can't see.
   */
  descriptorValues(node: AstNode, at: Position): { objects: ObjectParts[]; primitive: boolean; unseen: boolean }
  /**
   * The expressions that give a member read's value when it reads a field of objects the heap holds, each where it is
   * evaluated: undefined unless every value comes from one, with no part the analyzer can't see.
   */
  fieldSources(member: AstNode, at: Position): { node: AstNode; at: Position }[] | undefined
  /**
   * The expression an iteration native's callback is passed as its parameter `index` by `binding` (§5 Resolver
   * capabilities 4), where it is evaluated: an array literal's element. Undefined for any other binding or parameter.
   */
  givenSource(binding: Binding, index: number): { node: AstNode; at: Position } | undefined
}

const unknown: Value = { kind: 'unknown' }
const object: Value = { kind: 'object' }
const constant = (value: Primitive): Value => ({ kind: 'constant', value })
/** Free names a `typeof` test shows are defined, each with the test. */
export type Guards = ReadonlyMap<string, AstNode>
const none: Guards = new Map()

/** The parts of an own-property test: the object tested, its key (`null` when none is passed), and the function. */
interface OwnTestParts {
  object: AstNode
  key: AstNode | null
  callee: Value
}

/**
 * A prototype walk to the first owner (§4 A holder chosen at runtime): its loop, what one run of its body does in order
 * (the loop's test, an `if (…) break`, a prototype step), the definitions that are its steps, and which identifiers read
 * its variable.
 */
interface Walk {
  loop: AstNode
  actions: WalkAction[]
  steps: AstNode[]
  isVariable: (node: AstNode) => boolean
}
type WalkAction = { kind: 'test' | 'break'; test: AstNode } | { kind: 'step'; node: AstNode }

/**
 * A comparison of a walk's variable with `null` or `undefined`: `o != null`, `null !== o`, `o === undefined`. Its
 * `operator` is `==` or `!=` and `strict` says whether it is `===` or `!==`.
 */
function nullTest(
  node: AstNode,
  isVariable: (node: AstNode) => boolean,
): { operator: '==' | '!='; strict: boolean; against: null | undefined } | undefined {
  const operator = node['operator'] as string
  if (!['==', '!=', '===', '!=='].includes(operator)) return undefined
  const left = node['left'] as AstNode
  const right = node['right'] as AstNode
  const other = isVariable(left) ? right : isVariable(right) ? left : undefined
  if (other === undefined) return undefined
  const against =
    other.type === 'Literal' && other['value'] === null && other['regex'] === undefined
      ? null
      : other.type === 'Identifier' && other['name'] === 'undefined'
        ? undefined
        : other.type === 'UnaryExpression' && other['operator'] === 'void'
          ? undefined
          : 'other'
  if (against === 'other') return undefined
  return { operator: operator.startsWith('!') ? '!=' : '==', strict: operator.length === 3, against }
}

/**
 * A comparison of a walk variable's `typeof` with a string literal: `typeof o === 'object'`, `"object" != typeof o`.
 * `typeof` gives a string, so `==` and `===` agree (ECMA-262 7.2.14), and `operator` is `==` or `!=`.
 */
function typeofTest(
  node: AstNode,
  isVariable: (node: AstNode) => boolean,
): { operator: '==' | '!='; against: string } | undefined {
  const operator = node['operator'] as string
  if (!['==', '!=', '===', '!=='].includes(operator)) return undefined
  const isTypeof = (side: AstNode) =>
    side.type === 'UnaryExpression' && side['operator'] === 'typeof' && isVariable(side['argument'] as AstNode)
  const left = node['left'] as AstNode
  const right = node['right'] as AstNode
  const other = isTypeof(left) ? right : isTypeof(right) ? left : undefined
  if (other === undefined) return undefined
  const against = stringLiteral(other)
  if (against === undefined) return undefined
  return { operator: operator.startsWith('!') ? '!=' : '==', against }
}

/** A string literal's value, or a template literal's with no substitutions. */
function stringLiteral(node: AstNode): string | undefined {
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value']
  if (node.type !== 'TemplateLiteral' || (node['expressions'] as AstNode[]).length > 0) return undefined
  const [quasi] = node['quasis'] as AstNode[]
  const cooked = (quasi?.['value'] as { cooked?: string | null } | undefined)?.cooked
  return typeof cooked === 'string' ? cooked : undefined
}

/** The key a member expression's syntax names: its identifier, or a literal computed key. */
function memberKeyName(member: AstNode): string | undefined {
  const property = member['property'] as AstNode
  if (member['computed'] === true) return staticKey(property)
  return property.type === 'Identifier' ? (property['name'] as string) : undefined
}

/** The structural members, which don't count toward first ownership (§4). */
const structural: ReadonlySet<string> = new Set(['constructor', '@@toStringTag', 'prototype'])

/**
 * Where a constant's initializer is evaluated: with no `typeof` guard known, and not at the top level. That knows less
 * than the declaration's own position may, so a value is never wrongly constant.
 */
const nowhere: Position = { guard: () => undefined, topLevel: false }
/** Where a definition at the top level of a classic script is evaluated: with no `typeof` guard known. */
const topLevelNowhere: Position = { guard: () => undefined, topLevel: true }

export function globalResolution(context: {
  /** The program analyzed, whose loops may be unrolled (§5 Resolver capabilities 4). */
  program: AstNode
  catalog: SerializedCatalog
  realm: Realm
  /** The realm's global holder, e.g. `Window`. */
  global: string
  sourceType: 'script' | 'module'
  scope: ScopeRules
  /** The definitions of the program's variables, and those that reach each read (§5 Resolver capabilities 2). */
  definitions: Definitions
  /**
   * The window whose global object the code's free names are properties of: the artifact's own, or, for code another
   * window's `eval`, `Function` or timer compiles, that window.
   */
  instance: RealmInstance
  /**
   * Counts a cap that changed a value at `node` (§18 Context policy): `alternatives`, or `fold-length`. Whether a
   * `fold-length` hit also raises `analysis-budget` depends on what it cuts (§13, `tracked`).
   */
  cap(name: CapHit['name'], node: AstNode): void
  /**
   * Counts a hit of a cap that bounds no value, once for the node where it cut (§18): `flagDepth`, at a function
   * a once-flag's assignment isn't followed into, and `nesting`, at a constant read too deep within others.
   */
  capHit(name: 'flagDepth' | 'nesting', node: AstNode): void
  /** The calls of the program's functions (§5 Resolver capabilities 3). */
  calls: CallGraph
  /**
   * Raises `analysis-budget` for the call `site`, which a recursion or context cap widened or merged while it carries
   * the global object, a native holder or a native member (Principle 5).
   */
  budget(site: AstNode, cap: 'recursion' | 'contexts'): void
  /** The caps (§18 Context policy). */
  caps: Caps
  /**
   * Counts one step of the link group's step budget (§18): each value evaluated. It throws once the budget is
   * exhausted, which abandons the group's analysis where it is.
   */
  step(): void
  /** The artifact's module links (§6): the definer's modeled defines, and the require calls. */
  links: ModuleLinks
}): GlobalResolution {
  const { program, catalog, realm, global, sourceType, scope, definitions, instance: codeInstance, calls } = context
  const flags = onceFlags(program, definitions, calls, context.caps.flagDepth, (fn) => context.capHit('flagDepth', fn))
  /**
   * Whether the artifact links modules through a factory table's idioms (§6), where calls and heap reads are followed
   * further. The other idioms' calls are followed alone (`summarized`).
   */
  const linking = context.links.tables
  const {
    alternatives: maxAlternatives,
    foldLength: maxFoldLength,
    depth: maxDepth,
    contexts: maxContexts,
    iterations: maxIterations,
    nesting: maxNesting,
    indexRounds: maxIndexRounds,
  } = context.caps
  const targets = catalog.targets[realm]
  const holders = catalog.holders[realm]
  const globalNames = realm === 'window' ? windowNames : workerNames

  /** A free name: one that resolves to no declaration, or to one that binds the global object's property. */
  const free = (id: AstNode): GlobalBinding | undefined => {
    const binding = scope.resolve(id)
    return binding === 'local' ? undefined : binding
  }

  const holder = (name: string, leaf: Leaf, absent = false): HolderValue =>
    markedAbsent({ kind: 'holder', holder: name, leaves: [leaf] }, absent)

  /**
   * The platform singleton each access path reaches, by the path from the global object without a name of the global
   * object (`localStorage`, `document.location`, `clientInformation.geolocation`): the realm's alias groups (§4). A
   * path through a name of the global object (`window.history`) is one of these read from the global object.
   */
  const singletons = new Map<string, string>()
  for (const [canonical, paths] of Object.entries(catalog.aliasGroups[realm])) {
    for (const path of paths) if (!globalNames.has(path.split('.')[0]!)) singletons.set(path, canonical)
  }

  /**
   * Whether `Symbol.<key>` is one of the catalog's well-known symbols: a value property of `Symbol` that holds no holder
   * (`Symbol.prototype` does).
   */
  const isWellKnownSymbol = (key: string): boolean => {
    const name = memberName('Symbol', key)
    const target = Object.hasOwn(targets, name) ? targets[name]! : undefined
    return target !== undefined && target.kind === 'value' && target.holds === undefined
  }

  /** The holder the catalog says `owner.key`'s value is, if that property is a target that holds one. */
  const holdsAt = (owner: string, key: string): string | undefined => {
    const name = memberName(owner, key)
    return Object.hasOwn(targets, name) ? targets[name]!.holds : undefined
  }

  /**
   * The values an expression can have at a position. More than `maxAlternatives` of them is a cap hit: the value keeps
   * its native holders, and its other values collapse into one unknown (§18 Context policy).
   */
  function evaluate(node: AstNode, at: Position): Value[] {
    context.step()
    let values = alternatives(node, at)
    if (values.length <= maxAlternatives) return values
    // Prefixes are given up before the cap is (§5 Pattern wildcards): they never cost a value.
    values = unprefixed(values)
    if (values.length <= maxAlternatives) return values
    hit('alternatives', node)
    return [...values.filter((value) => value.kind === 'holder'), unknown]
  }

  function alternatives(node: AstNode, at: Position): Value[] {
    switch (node.type) {
      case 'Identifier':
        return identifier(node, at)
      case 'ThisExpression':
        return thisValues(node, at)
      case 'MemberExpression':
        return memberRead(node, at)
      case 'ChainExpression':
        return evaluate(node['expression'] as AstNode, at)
      case 'Literal':
        return [literal(node)]
      case 'TemplateLiteral':
        return template(node, at)
      case 'UnaryExpression':
        return unary(node, at)
      case 'BinaryExpression':
        return binary(node, at)
      case 'LogicalExpression':
        return logical(node, at)
      case 'ConditionalExpression': {
        const test = node['test'] as AstNode
        const tested = settled(evaluate(test, at), test)
        const truthy = tested.some(maybeTruthy)
        const falsy = tested.some(maybeFalsy)
        const values = [
          ...(truthy ? evaluate(node['consequent'] as AstNode, guarded(at, test, true)) : []),
          ...(falsy ? evaluate(node['alternate'] as AstNode, guarded(at, test, false)) : []),
        ]
        // A test that decides the branch decides the value, so the value comes from its folds too.
        return selected(node, truthy && falsy ? values : decidedBy(values, testFolds(tested)))
      }
      case 'SequenceExpression':
        return evaluate((node['expressions'] as AstNode[]).at(-1)!, at)
      case 'CallExpression':
        return sweptCall(node, at) ?? namespaceObject(node, at) ?? prototypeOf(node, at) ?? ownProperty(node, at) ?? nativeObject(node, at) ?? summarized(node, at)
      case 'AssignmentExpression': {
        // `(g = window).fetch = w` writes through the value assigned, and `w[s += x]` through what `s + x` folds to.
        if (node['operator'] === '=') return evaluate(node['right'] as AstNode, at)
        const operation = compoundOf(node)
        return operation === undefined ? [unknown] : evaluate(operation, at)
      }
      case 'ObjectExpression':
        return [allocated(node, at, 'literal')]
      case 'ArrayExpression':
        return [allocated(node, at, 'array')]
      case 'NewExpression':
        return [allocated(node, at, 'instance')]
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ClassExpression': {
        // A fresh function, made in the frame it is evaluated in: never a native holder, and always truthy.
        const made = functionValue(node, at.frame)
        // An arrow that reads its enclosing function's `this` reads that function's frame (ECMA-262: an arrow's `this`
        // is lexical), so a call it is passed to runs in that function's frames.
        const owner = lexicalThisOf(node)
        if (owner !== undefined && frameOf(at.frame, owner) === undefined) readers.at(-1)?.add(owner)
        return [made]
      }
      default:
        return [unknown]
    }
  }

  /**
   * What `run` gives on each of `values`, when every one is a constant string a member sweep gave (§5 Resolver
   * capabilities 9), each result after that key's folds. Undefined otherwise.
   */
  function sweptString(values: readonly Value[], run: (string: string) => Value[]): Value[] | undefined {
    if (values.length === 0 || !values.every((value) => value.kind === 'constant' && typeof value.value === 'string' && isSwept(value))) {
      return undefined
    }
    return union(values.flatMap((value) => carried(run((value as ConstantValue).value as string), value as ConstantValue)))
  }

  /**
   * The values of an expression a filter on a swept key reads (§5 Resolver capabilities 9), when the program has a key
   * enumeration at all. The contexts the evaluation reads count only when the values are swept keys: an expression
   * that holds none is no read of what it holds.
   */
  function sweptValues(node: AstNode, at: Position): Value[] {
    if (!keysSwept) return []
    const { value, functions } = contextual(() => evaluate(node, at))
    if (value.some(isSwept)) for (const context of functions) readers.at(-1)?.add(context)
    return value
  }

  /**
   * A filter's call on a swept key, evaluated as ECMA-262 does (§5 Resolver capabilities 9): a string native on
   * the key with constant arguments (`k.startsWith('on')`, `k.slice(0, 2)`), a regular-expression literal with constant
   * source and flags run on it with the host's `RegExp` (`/^on/.test(k)`), or `includes` or `indexOf` of a constant
   * list with it. A native that throws gives no value (Principle 1), and a pattern that doesn't compile stays unknown.
   * Undefined for any other call.
   */
  function sweptCall(call: AstNode, at: Position): Value[] | undefined {
    const callee = calleeExpression(call['callee'] as AstNode)
    const args = call['arguments'] as AstNode[]
    if (callee.type !== 'MemberExpression' || callee['computed'] === true || args.some((arg) => arg.type === 'SpreadElement')) {
      return undefined
    }
    const receiver = callee['object'] as AstNode
    if (receiver.type === 'Super') return undefined
    const method = (callee['property'] as AstNode)['name'] as string
    // A regular-expression literal run on a swept key.
    const regex = receiver.type === 'Literal' ? (receiver['regex'] as { pattern: string; flags: string } | null | undefined) : undefined
    if (regex !== undefined && regex !== null) {
      if (!regexNatives.has(method) || args.length < 1) return undefined
      const [subject] = args
      const swept = sweptString(sweptValues(subject!, at), (string) => {
        let pattern: RegExp
        try {
          pattern = new RegExp(regex.pattern, regex.flags)
        } catch {
          return [unknown]
        }
        return method === 'test' ? [constant(pattern.test(string))] : pattern.exec(string) === null ? [constant(null)] : [object]
      })
      return swept
    }
    // A string native of a swept key, with constant arguments.
    const receiverValues = stringNatives.has(method) ? sweptValues(receiver, at) : []
    if (receiverValues.some(isSwept)) {
      const argValues = args.map((arg) => evaluate(arg, at))
      const constants = argValues.map((values) =>
        values.length === 1 && values[0]!.kind === 'constant' && typeof values[0]!.value !== 'symbol' ? values[0]! : undefined,
      )
      const swept = sweptString(receiverValues, (string) => {
        if (constants.some((value) => value === undefined)) return [unknown]
        let result: unknown
        try {
          const native = String.prototype[method as keyof string] as (...a: unknown[]) => unknown
          result = native.apply(string, constants.map((value) => (value as ConstantValue).value))
        } catch {
          return []
        }
        if (typeof result === 'string' && result.length > maxFoldLength) {
          hit('fold-length', call)
          return [unknown]
        }
        return typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean'
          ? [withFolds(constant(result), foldsOf(constants as Value[]))]
          : [unknown]
      })
      if (swept !== undefined) return swept
    }
    // `includes` or `indexOf` of a constant list with a swept key.
    if ((method === 'includes' || method === 'indexOf' || method === 'lastIndexOf') && args.length === 1) {
      const keys = evaluate(args[0]!, at)
      if (keys.length === 0 || !keys.every((key) => key.kind === 'constant' && isSwept(key))) return undefined
      const lists = collectionsOf(receiver, at)
      if (lists === undefined) return undefined
      const results: Value[] = []
      for (const { elements } of lists) {
        const items = elements.map((element) => {
          const [only, ...more] = element.values
          return only?.kind === 'constant' && more.length === 0 ? only.value : unknownMember
        })
        for (const key of keys as ConstantValue[]) {
          const value = key.value
          if (items.includes(unknownMember)) {
            results.push(unknown)
            continue
          }
          const result =
            method === 'includes' ? items.includes(value) : method === 'indexOf' ? items.indexOf(value) : items.lastIndexOf(value)
          results.push(withFolds(constant(result), foldsOf([key])))
        }
      }
      return union(results)
    }
    return undefined
  }

  /**
   * `Function('return this')()`: a function the `Function` constructor makes is sloppy and global-scoped whatever the
   * code around it, so calling it without a `this` returns the global object. `new Function(…)` is the same.
   */
  function functionReturnThis(call: AstNode, at: Position): Value | undefined {
    if ((call['arguments'] as AstNode[]).some((argument) => argument.type === 'SpreadElement')) return undefined
    const made = call['callee'] as AstNode
    if (made.type !== 'CallExpression' && made.type !== 'NewExpression') return undefined
    const body = (made['arguments'] as AstNode[]).at(-1)
    if (body === undefined || body.type === 'SpreadElement') return undefined
    const [text, ...more] = evaluate(body, at)
    if (more.length > 0 || text?.kind !== 'constant' || typeof text.value !== 'string' || !returnThis.test(text.value)) {
      return undefined
    }
    // A computed key that reaches `Function` makes the call an indirect one, whose code is not analyzed (§2).
    const reached = calleeExpression(made['callee'] as AstNode)
    if (reached.type === 'MemberExpression' && reached['computed'] === true) return undefined
    const constructors = evaluate(made['callee'] as AstNode, at)
    const [constructor] = constructors
    if (constructors.length !== 1 || constructor?.kind !== 'holder' || constructor.holder !== 'Function') return undefined
    const folds = foldsOf([constructor, text])
    return {
      kind: 'holder',
      holder: global,
      ...(folds.length === 0 ? {} : { folds }),
      // The function is made in the realm of the `Function` called, so it returns that window's global object.
      leaves: constructor.leaves.map((leaf): Leaf => {
        const { name, binding, instance, base } = leaf
        // Another window's `Function` (`parent.Function`) keeps the step that reached that window, and this one follows.
        if (leaf.form === 'other-window') {
          return { form: 'function-return-this', node: call, name: 'Function', instance, base: [leaf] }
        }
        return {
          form: 'function-return-this',
          node: call,
          name,
          ...(binding === undefined ? {} : { binding }),
          instance,
          ...(base === undefined ? {} : { base }),
        }
      }),
    }
  }

  /**
   * `Object.getPrototypeOf(h)` (§5 Resolver capabilities 8): the prototype the unmutated catalog gives each native
   * holder `h` can be (§4), a holder or `null`, in the window `h` belongs to. `Object` is the native constructor however
   * it is reached, and a key that folds to `"getPrototypeOf"` names the function as the dot form does. Anything else
   * `h` can be gives an unknown prototype. The holder's leaf records that the catalog chose it (§14 `catalog-holder`).
   */
  function prototypeOf(call: AstNode, at: Position): Value[] | undefined {
    const [argument] = call['arguments'] as AstNode[]
    if (argument === undefined || argument.type === 'SpreadElement') return undefined
    const found = getPrototypeOf(calleeExpression(call['callee'] as AstNode), at)
    if (found === undefined) return undefined
    const { key, object } = found
    const values = evaluate(argument, at).map((value): Value => {
      const proto = value.kind === 'holder' && Object.hasOwn(holders, value.holder) ? holders[value.holder]!.proto : undefined
      if (value.kind !== 'holder' || proto === undefined) return unknown
      const folds = foldsOf([key, object, value])
      if (proto === null) return withFolds(constant(null), folds)
      const leaf: Leaf = {
        form: 'prototype-of',
        node: call,
        name: 'getPrototypeOf',
        holds: proto,
        prototypeOf: value.holder,
        instance: instanceOf(value.leaves),
        base: value.leaves,
        callee: object.leaves,
      }
      return { kind: 'holder', holder: proto, leaves: [leaf], ...(folds.length === 0 ? {} : { folds }) }
    })
    return union(values)
  }

  /**
   * `h.__proto__` read from the native holder `h`: when the first `__proto__` on its chain in the unmutated catalog is
   * `Object.prototype`'s accessor, its getter returns `h`'s prototype, as `Object.getPrototypeOf(h)` does (§4).
   */
  function protoGetter(node: AstNode, value: HolderValue): Value | undefined {
    const owner = firstOwner(value.holder, '__proto__')
    const name = owner === undefined ? undefined : memberName(owner, '__proto__')
    if (name !== 'Object.prototype.__proto__' || targets[name]!.descriptor.type !== 'accessor') return undefined
    const proto = Object.hasOwn(holders, value.holder) ? holders[value.holder]!.proto : undefined
    if (proto === undefined) return undefined
    if (proto === null) return withFolds(constant(null), foldsOf([value]))
    const leaf: Leaf = {
      form: 'prototype-of',
      node,
      name: '__proto__',
      holds: proto,
      prototypeOf: value.holder,
      instance: instanceOf(value.leaves),
      base: value.leaves,
    }
    const folds = value.folds === undefined ? {} : { folds: value.folds }
    return { kind: 'holder', holder: proto, leaves: [leaf], ...folds }
  }

  /**
   * An own-property test (§4 A holder chosen at runtime), by any ECMA-262 route with its meaning: `Object.hasOwn(h,
   * k)`, and `Object.prototype.hasOwnProperty` however it is reached, called as `h.hasOwnProperty(k)`, through `.call`
   * or `.apply`, or through `Reflect.apply`. The unmutated catalog decides it for a native holder `h` and a key that
   * folds (`ownTest`). Undefined for a call that is no such test.
   */
  function ownProperty(call: AstNode, at: Position): Value[] | undefined {
    const tested = ownTestParts(call, at)
    if (tested === undefined) return undefined
    const { object, key, callee } = tested
    const keys = key === null ? [constant(undefined)] : evaluate(key, at)
    const objects = evaluate(object, at)
    if (keys.length * objects.length > maxAlternatives) return tooMany(call)
    return union(
      objects.flatMap((value) =>
        keys.flatMap((each): Value[] => {
          // ToObject of null or undefined throws (Principle 1).
          if (value.kind === 'constant' && (value.value === null || value.value === undefined)) return []
          if (value.kind !== 'holder') return [unknown]
          const decided = ownTest(value.holder, each)
          if (decided === undefined) return [unknown]
          const folds = [...foldsOf([callee, each]), { node: call, value: decided.owns, catalog: decided }]
          return [{ kind: 'constant', value: decided.owns, folds }]
        }),
      ),
    )
  }

  /**
   * Whether the native holder `holder` owns the member `key` in the unmutated catalog (§4). A key that doesn't
   * fold is decided only for a holder that owns no catalog member other than the structural ones, which owns none that
   * counts toward first ownership.
   */
  function ownTest(holder: string, key: Value): OwnTest | undefined {
    if (key.kind === 'constant') {
      const member = toPropertyKey(key.value)
      const name = memberName(holder, member)
      return { tested: holder, member: name.slice(holder.length).replace(/^\./, ''), owns: Object.hasOwn(targets, name) }
    }
    return ownsOnlyStructural(holder) ? { tested: holder, owns: false } : undefined
  }

  /** Whether a holder owns no catalog member other than `constructor`, `@@toStringTag` and `prototype`. */
  function ownsOnlyStructural(holder: string): boolean {
    return !(ownMembers().get(holder)?.some((member) => !structural.has(member)) ?? false)
  }

  /** Each holder's own catalog members, by the holder's name. */
  function ownMembers(): ReadonlyMap<string, readonly string[]> {
    if (ownIndex !== undefined) return ownIndex
    const index = new Map<string, string[]>()
    for (const [name, target] of Object.entries(targets)) {
      // A symbol member is spelt `@@name` in its target's name (§4 Property keys).
      const suffix = target.member.startsWith('@@') ? `.${target.member}` : memberName('', target.member)
      if (!name.endsWith(suffix)) continue
      const holder = name.slice(0, name.length - suffix.length)
      let members = index.get(holder)
      if (members === undefined) index.set(holder, (members = []))
      members.push(target.member)
    }
    return (ownIndex = index)
  }
  let ownIndex: Map<string, string[]> | undefined

  /**
   * The parts of an own-property test: the object tested, the key expression (`null` when the call passes none, which
   * is `undefined`), and the value of the function it calls, whose folds the result carries.
   */
  function ownTestParts(call: AstNode, at: Position): OwnTestParts | undefined {
    const args = call['arguments'] as AstNode[]
    if (args.some((argument) => argument.type === 'SpreadElement')) return undefined
    const callee = calleeExpression(call['callee'] as AstNode)
    const only = (values: Value[]): Value | undefined => (values.length === 1 ? values[0] : undefined)
    const isNative = (value: Value | undefined, name: NativeName): boolean =>
      value?.kind === 'native' && value.name === name
    const listed = (list: AstNode | undefined): AstNode | null | undefined => {
      if (list === undefined || list.type !== 'ArrayExpression') return undefined
      const [first] = list['elements'] as (AstNode | null)[]
      if (first?.type === 'SpreadElement') return undefined
      return first ?? null
    }
    // Only the names these routes end with are evaluated, so that other calls cost nothing here.
    const member = callee.type === 'MemberExpression' && (callee['object'] as AstNode).type !== 'Super'
    const name = member ? memberKeyName(callee) : undefined
    // `f.call(h, k)` and `f.apply(h, [k])`, where `f` is `Object.prototype.hasOwnProperty`.
    if (name === 'call' || name === 'apply') {
      const fn = only(evaluate(callee['object'] as AstNode, at))
      if (isNative(fn, 'Object.prototype.hasOwnProperty') || emptyLiteralMethod(callee['object'] as AstNode)) {
        if (args[0] === undefined) return undefined
        const key = name === 'call' ? (args[1] ?? null) : listed(args[1])
        return key === undefined ? undefined : { object: args[0], key, callee: fn ?? unknown }
      }
    }
    const named = name === 'hasOwn' || name === 'hasOwnProperty' || name === 'apply'
    if (!named && callee.type !== 'Identifier') return undefined
    const fn = only(callee.type === 'Identifier' ? aliasCallee(callee, at) : evaluate(call['callee'] as AstNode, at))
    if (fn === undefined || args[0] === undefined) return undefined
    if (isNative(fn, 'Object.hasOwn')) return { object: args[0], key: args[1] ?? null, callee: fn }
    // `h.hasOwnProperty(k)`: the method called on the holder it is read from.
    if (isNative(fn, 'Object.prototype.hasOwnProperty') && member) {
      return { object: callee['object'] as AstNode, key: args[0], callee: fn }
    }
    // `Reflect.apply(f, h, [k])`.
    if (isNative(fn, 'Reflect.apply') && args[1] !== undefined) {
      if (!isNative(only(evaluate(args[0], at)), 'Object.prototype.hasOwnProperty')) return undefined
      const key = listed(args[2])
      return key === undefined ? undefined : { object: args[1], key, callee: fn }
    }
    return undefined
  }

  /**
   * `{}.hasOwnProperty`: an empty object literal inherits `Object.prototype.hasOwnProperty`, whatever the code does
   * elsewhere, since the literal is made where it is read.
   */
  function emptyLiteralMethod(node: AstNode): boolean {
    if (node.type !== 'MemberExpression') return false
    const literal = node['object'] as AstNode
    if (literal.type !== 'ObjectExpression' || (literal['properties'] as AstNode[]).length > 0) return false
    const property = node['property'] as AstNode
    if (node['computed'] !== true) return property.type === 'Identifier' && property['name'] === 'hasOwnProperty'
    const [key, ...more] = evaluate(property, nowhere)
    return more.length === 0 && key?.kind === 'constant' && key.value === 'hasOwnProperty'
  }

  /**
   * `Object.getPrototypeOf` as a callee denotes it: its key's value and the `Object` holder it is read from, however
   * `Object` is reached, or an alias of the function (§5 Resolver capabilities 2), whose value stands for both.
   */
  function getPrototypeOf(callee: AstNode, at: Position): { key: Value; object: HolderValue } | undefined {
    if (callee.type === 'Identifier') {
      const values = aliasCallee(callee, at)
      const [only] = values
      if (values.length !== 1 || only?.kind !== 'native') return undefined
      if (only.name !== 'Object.getPrototypeOf' && only.name !== 'Reflect.getPrototypeOf') return undefined
      const holder = only.name === 'Object.getPrototypeOf' ? 'Object' : 'Reflect'
      const folds = only.folds ? { folds: only.folds } : {}
      const object: HolderValue = { kind: 'holder', holder, leaves: only.leaves, ...folds }
      return { key: constant('getPrototypeOf'), object }
    }
    if (callee.type !== 'MemberExpression' || (callee['object'] as AstNode).type === 'Super') return undefined
    const property = callee['property'] as AstNode
    const keys =
      callee['computed'] === true
        ? evaluate(property, at)
        : property.type === 'Identifier'
          ? [constant(property['name'] as string)]
          : [unknown]
    const [key] = keys
    if (keys.length !== 1 || key?.kind !== 'constant' || key.value !== 'getPrototypeOf') return undefined
    const functions = evaluate(callee['object'] as AstNode, at)
    const [object] = functions
    if (functions.length !== 1 || object?.kind !== 'holder') return undefined
    if (object.holder !== 'Object' && object.holder !== 'Reflect') return undefined
    return { key, object }
  }

  function literal(node: AstNode): Value {
    if (node['regex'] !== undefined && node['regex'] !== null) return object
    // A BigInt literal is bounded by its source, so it is never capped (§5 Resolver capabilities 1).
    if (typeof node['bigint'] === 'string') return constant(BigInt(node['bigint']))
    const value = node['value']
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      return constant(value as string | number | boolean | null)
    }
    return unknown
  }

  /**
   * `typeof x`, `!x` and `void x`, which is all a chain's tests need, and the numeric `-x`, `+x` and `~x`, which fold as
   * ECMA-262 defines them (Principle 2). The result carries the operand's folds. An operand the operator throws on
   * gives no value (Principle 1).
   */
  function unary(node: AstNode, at: Position): Value[] {
    const operator = node['operator'] as string
    if (operator === 'void') return [constant(undefined)]
    const numeric = numericUnary.has(operator)
    if (operator !== 'typeof' && operator !== '!' && !numeric) return [unknown]
    if (operator === 'typeof') {
      const types = sweptMemberTypes(node['argument'] as AstNode, at)
      if (types !== undefined) return types
    }
    return union(
      evaluate(node['argument'] as AstNode, at).flatMap((value): Value[] => {
        const folds = foldsOf([value])
        if (numeric) {
          if (value.kind !== 'constant') return [unknown]
          return outcomeOf(unaryOperation(operator, value.value, maxFoldLength), folds, node)
        }
        if (operator === '!') {
          return carried([...(maybeTruthy(value) ? [constant(false)] : []), ...(maybeFalsy(value) ? [constant(true)] : [])], {
            folds,
          })
        }
        // A member a sweep gave exists (§5 Resolver capabilities 9), so the catalog decides its type: a function, or
        // a holder, which is a function when it is a constructor. An accessor's value stays unknown.
        if (isSwept(value) && (value.kind === 'member' || value.kind === 'holder')) {
          const type = value.kind === 'member' || holders[value.holder]?.kind === 'constructor' ? 'function' : 'object'
          return [withFolds(constant(type), folds)]
        }
        // The global object is an object in every realm (§4). Other holders' presence is for catalog guards (§7).
        if (value.kind === 'holder') return [value.holder === global ? withFolds(constant('object'), folds) : unknown]
        if (value.kind === 'constant') return [withFolds(constant(value.value === null ? 'object' : typeof value.value), folds)]
        return [unknown]
      }),
    )
  }

  /**
   * `typeof holder[k]` with a key a member sweep gave (§5 Resolver capabilities 9):
   * the catalog kind of the member each key names on each holder decides it, so `typeof proto[k] === 'function'` keeps
   * only the operations. Undefined unless every object is a native holder, every key a swept constant, and the catalog
   * decides every member's type: an accessor, whose getter runs, stays undecided.
   */
  function sweptMemberTypes(argument: AstNode, at: Position): Value[] | undefined {
    if (argument.type !== 'MemberExpression' || argument['computed'] !== true) return undefined
    const keys = evaluate(argument['property'] as AstNode, at)
    if (keys.length === 0 || !keys.every((key): key is ConstantValue => key.kind === 'constant' && isSwept(key))) return undefined
    const objects = evaluate(argument['object'] as AstNode, at)
    if (objects.length === 0 || !objects.every((value): value is HolderValue => value.kind === 'holder')) return undefined
    const types: Value[] = []
    for (const object of objects) {
      for (const key of keys) {
        const type = catalogType(object.holder, toPropertyKey((key as ConstantValue).value))
        if (type === undefined) return undefined
        // The type carries the key's folds only: a native holder read from the heap is still that holder for the
        // catalog (§5 Resolver capabilities 5).
        types.push(withFolds(constant(type), (key as ConstantValue).folds ?? []))
      }
    }
    return union(types)
  }

  /**
   * The `typeof` of the member `key` on `holder`'s chain in the unmutated catalog, from its kind: an operation or
   * built-in function is `'function'`, a Web IDL constant `'number'`, a member that holds a holder `'function'` for a
   * constructor and `'object'` otherwise, and a member the chain doesn't have `'undefined'`. Undefined for an accessor
   * or a member the catalog doesn't type.
   */
  function catalogType(holder: string, key: Key): string | undefined {
    for (let at: string | null = holder; at !== null; at = Object.hasOwn(holders, at) ? holders[at]!.proto : null) {
      const name = memberName(at, key)
      if (!Object.hasOwn(targets, name)) continue
      const { descriptor, kind, holds } = targets[name]!
      if (descriptor.type !== 'data') return undefined
      if (holds !== undefined) return holders[holds]?.kind === 'constructor' ? 'function' : 'object'
      if (kind === 'operation' || kind === 'function') return 'function'
      if (kind === 'constant') return 'number'
      return undefined
    }
    return 'undefined'
  }

  /**
   * The value an operation on constants gives, with `folds`: none when it throws (Principle 1), and unknown when it
   * passes the `fold-length` cap at `node`, which is a cap hit.
   */
  function outcomeOf(outcome: Outcome, folds: Fold[], node: AstNode): Value[] {
    if (outcome === 'throws') return []
    if (outcome === 'too-long') {
      hit('fold-length', node)
      return [unknown]
    }
    return [capped(outcome.value, folds, node)]
  }

  /**
   * A comparison: of two constants, of two native holders, or of a holder with a constant by identity, which carries
   * the folds of both. Or a `+` chain, or another numeric operator (Principle 2), which folds.
   */
  function binary(node: AstNode, at: Position): Value[] {
    const operator = node['operator'] as string
    if (operator === '+') return sum(node, at)
    const leftNode = node['left'] as AstNode
    const numeric = numericBinary.has(operator)
    if ((!comparisons.has(operator) && !numeric) || leftNode.type === 'PrivateIdentifier') return [unknown]
    const left = evaluate(leftNode, at)
    const right = evaluate(node['right'] as AstNode, at)
    if (left.length * right.length > maxAlternatives) return tooMany(node)
    if (numeric) {
      return union(
        left.flatMap((a) =>
          right.flatMap((b): Value[] => {
            if (a.kind !== 'constant' || b.kind !== 'constant') return [unknown]
            const outcome = binaryOperation(operator, a.value, b.value, maxFoldLength)
            return outcomeOf(outcome, foldsOf([a, b]), node).map((value) => folded(node, value))
          }),
        ),
      )
    }
    const evaluated = [leftNode, node['right'] as AstNode]
    return union(left.flatMap((a) => right.map((b) => withFolds(compared(operator, a, b, evaluated), foldsOf([a, b])))))
  }

  /**
   * A `+` chain: its operands added left to right, as JavaScript adds them (`"a" + 1 + 2` is `"a12"`), in one fold after
   * the folds of its operands. The chain is walked as a list rather than by recursion, because minified code builds
   * long ones.
   */
  function sum(node: AstNode, at: Position): Value[] {
    const operands: AstNode[] = []
    let first = node
    while (first.type === 'BinaryExpression' && first['operator'] === '+') {
      operands.push(first['right'] as AstNode)
      first = first['left'] as AstNode
    }
    let sums = evaluate(first, at).map((value) => partOf(value, first))
    for (const operand of operands.reverse()) {
      let values = evaluate(operand, at)
      // A sum the analyzer can't fold stays what it is, whatever is added to it: its prefix, if any, is kept.
      if (sums.every((sum) => sum.kind === 'unknown') && !values.some((value) => value.kind === 'constant' && typeof value.value === 'symbol')) continue
      if (sums.length * values.length > maxAlternatives) {
        // Prefixes are given up before the cap is.
        sums = unprefixed(sums)
        values = unprefixed(values)
      }
      if (sums.length * values.length > maxAlternatives) return tooMany(node)
      sums = union(sums.flatMap((a) => values.flatMap((b) => plus(a, partOf(b, operand), node))))
    }
    return union(sums.map((value) => folded(node, value)))
  }

  /**
   * `a + b` in the `+` chain `node`: the sum of two constants as ECMA-262 adds them, after the folds of both, or
   * unknown. A sum that throws (a symbol, or a BigInt and a Number) has no value (Principle 1).
   */
  function plus(a: Value, b: Value, node: AstNode): Value[] {
    // A string whose start folds keeps it (§5 Pattern wildcards): a string constant, or such a string, then anything.
    // Adding a symbol throws (Principle 1).
    if (b.kind === 'constant' && typeof b.value === 'symbol' && (a.kind === 'constant' || (a.kind === 'unknown' && a.prefix !== undefined))) {
      return []
    }
    if (a.kind === 'unknown' && a.prefix !== undefined) return [a]
    // A constant then a prefixed string: the constant's string, then the prefix (`"a" + ("b" + k)` starts with "ab").
    if (a.kind === 'constant' && b.kind === 'unknown' && b.prefix !== undefined) {
      return typeof a.value === 'symbol' ? [] : [prefixed(`${String(a.value)}${b.prefix}`, node)]
    }
    if (a.kind === 'constant' && typeof a.value === 'string' && b.kind !== 'constant') return [prefixed(a.value, node)]
    if (a.kind !== 'constant' || b.kind !== 'constant') return [unknown]
    const outcome = binaryOperation('+', a.value, b.value, maxFoldLength)
    return outcomeOf(outcome, [...(a.folds ?? []), ...(b.folds ?? [])], node)
  }

  /**
   * A string that starts with `prefix` and that the analyzer can't fold further (§5 Pattern wildcards), or unknown when
   * the prefix is empty, or longer than the `fold-length` cap, which the fold `node` passed.
   */
  function prefixed(prefix: string, node: AstNode): Value {
    if (prefix === '') return unknown
    if (prefix.length > maxFoldLength) {
      hit('fold-length', node)
      return unknown
    }
    return { kind: 'unknown', prefix }
  }

  /** A template literal: a fold of its constant parts, each converted to a string. */
  function template(node: AstNode, at: Position): Value[] {
    const quasis = (node['quasis'] as AstNode[]).map((quasi) => (quasi['value'] as { cooked: string | null }).cooked)
    if (quasis.some((cooked) => cooked === null)) return [unknown]
    const expressions = node['expressions'] as AstNode[]
    if (expressions.length === 0) return [constant(quasis[0]!)]
    // Every combination of the parts' alternatives, in order. A combination stops folding at its first part that
    // doesn't fold (`prefix`): the text before that part, and the start of a string it may be, is a prefix (§5 Pattern
    // wildcards). The other combinations fold on, so `${c ? "op" : k}en` is "open" or a string that starts with nothing.
    let texts: { text: string; folds: Fold[]; prefix?: true }[] = [{ text: quasis[0]!, folds: [] }]
    for (const [index, expression] of expressions.entries()) {
      if (texts.every((each) => each.prefix !== undefined)) break
      const values = evaluate(expression, at)
      // A symbol in a template throws a TypeError.
      if (values.some((value) => value.kind === 'constant' && typeof value.value === 'symbol')) return [unknown]
      const open = texts.filter((each) => each.prefix === undefined)
      const stopped = texts.filter((each) => each.prefix !== undefined)
      if (open.length * values.length > maxAlternatives) {
        // Prefixes are given up before the cap is, and a part that doesn't fold makes the whole unknown, as before.
        return values.some((value) => value.kind !== 'constant') || stopped.length > 0 ? [unknown] : tooMany(node)
      }
      texts = [
        ...stopped,
        ...open.flatMap(({ text, folds }) =>
          values.map((value) => {
            if (value.kind !== 'constant') {
              const start = value.kind === 'unknown' ? (value.prefix ?? '') : ''
              return { text: `${text}${start}`, folds: [], prefix: true as const }
            }
            const part = partOf(value, expression) as ConstantValue
            return { text: `${text}${String(part.value)}${quasis[index + 1]!}`, folds: [...folds, ...(part.folds ?? [])] }
          }),
        ),
      ]
    }
    return union(
      texts.map(({ text, folds, prefix }) => (prefix === true ? prefixed(text, node) : folded(node, capped(text, folds, node)))),
    )
  }

  /**
   * A constant with the folds it comes from, or unknown for a string longer than the `fold-length` cap, which the fold
   * `node` passed.
   */
  function capped(value: Primitive, folds: Fold[], node: AstNode): Value {
    if (typeof value === 'string' && value.length > maxFoldLength) {
      hit('fold-length', node)
      return unknown
    }
    return folds.length === 0 ? constant(value) : { kind: 'constant', value, folds }
  }

  /**
   * `a && b`, `a || b` and `a ?? b`: the values of `a` that end the chain, and those of `b` when `a` can go on to it.
   * A `typeof` test on the left guards the right side.
   */
  function logical(node: AstNode, at: Position): Value[] {
    const operator = node['operator'] as '&&' | '||' | '??'
    const leftNode = node['left'] as AstNode
    const rightNode = node['right'] as AstNode
    const left = settled(evaluate(leftNode, at), leftNode)
    const ends = operator === '&&' ? maybeFalsy : operator === '||' ? maybeTruthy : maybeNotNullish
    const goesOn = operator === '&&' ? maybeTruthy : operator === '||' ? maybeFalsy : maybeNullish
    // A once-flag's value still ends the chain only where it is what ends it: `k || (k = …)` gives only its truthy
    // values (§5 Resolver capabilities 6).
    const kept = left
      .filter((value) => ends(unflagged(value)))
      .map((value) => (testedOnly(value) ? { ...value, tested: true as const } : value))
      // A holder that may be missing ends `&&` only when it is, which reads `undefined`, and ends `||` or `??` only
      // when it is there (§7).
      .map((value) =>
        !mayBeMissing(value)
          ? value
          : operator === '&&'
            ? withFolds(constant(undefined), foldsOf([value]))
            : markedAbsent(value as HolderValue, false),
      )
    const going = left.filter(goesOn)
    const right =
      going.length > 0 ? evaluate(rightNode, operator === '??' ? at : guarded(at, leftNode, operator === '&&')) : []
    // When `a` is known, the values that go on decide that `b` is reached, so its values come from their folds too.
    const decided = !left.some(opaque)
    return selected(node, [...kept, ...(decided ? decidedBy(right, testFolds(going)) : right)])
  }

  function identifier(id: AstNode, at: Position): Value[] {
    const looped = loopRead(id, at)
    if (looped !== undefined) return looped
    const binding = free(id)
    if (binding === undefined) return scope.constant(id) === undefined ? variableRead(id, at) : constantRead(id, at)
    // A top-level function declaration puts the function in the global object's property before the script runs
    // (ECMA-262 CreateGlobalFunctionBinding), so the name is that function. A `var` leaves the property alone.
    if (binding.declaration?.kind === 'function') return [functionValue(binding.declaration.node, at.frame)]
    const name = id['name'] as string
    // The global object's non-writable, non-configurable value properties (ECMA-262 19.1) always hold their values. A
    // `with` block or sloppy direct eval on the path keeps its taint, on a fold that JSON can't carry, so it has no step.
    if (binding.declaration === undefined && Object.hasOwn(globalValues, name)) {
      const value = globalValues[name]
      const taint = taintOf(binding)
      return [taint === undefined ? constant(value) : { kind: 'constant', value, folds: [{ node: id, name, value, taint }] }]
    }
    const native = () => nativeRead(id, name, binding, at)
    // A name whose assignment takes effect follows its value once the code assigns it (§5 Reassigned globals): the
    // global's own value counts only where the walk shows no assignment has run.
    if (!followsValue(name)) return native()
    const key = { scope: 'global' as const, name }
    // A global expando's member-form writes share its heap cell with the free name (§5 Global resolution).
    const cell = codeInstance === 'current' && isExpando(global, name) ? memberFormValues(name) : []
    if (definitions.of(key).length === 0) return cell.length === 0 ? native() : cell
    return union([...reachingValues(id, key, native, taintOf(binding), at.frame), ...cell])
  }

  /**
   * Whether an assignment to the global object's property `name` takes effect, so that the bare name follows the value
   * assigned (§5 Reassigned globals): a name the catalog doesn't list on the global object's chain, a writable data
   * property (`XMLHttpRequest`, `Promise`, `console`, `globalThis`), a `[Replaceable]` attribute (`self`, `frames`,
   * `performance`, `parent`), or `opener`, whose setter replaces it. The rest (`window`, `top`, `document`, `location`,
   * `history`) stay native.
   */
  function followsValue(name: string): boolean {
    for (let at: string | null = global; at !== null; at = Object.hasOwn(holders, at) ? holders[at]!.proto : null) {
      const member = memberName(at, name)
      if (!Object.hasOwn(targets, member)) continue
      const { descriptor, assign, owner, kind } = targets[member]!
      if (descriptor.type === 'data') return descriptor.writable
      return assign === 'replaceable' || (owner === 'Window' && name === 'opener' && kind === 'attribute')
    }
    return true
  }

  /** The value of a free name before the code assigns it: the global object's property of that name (§5). */
  function nativeRead(id: AstNode, name: string, binding: GlobalBinding, at: Position): Value[] {
    const instance = codeInstance
    if (globalNames.has(name)) {
      const spelled = name === 'frames' ? { frames: true as const } : {}
      return [holder(global, { form: 'global-name', node: id, name, binding, instance, ...spelled })]
    }
    // Bundles written for Node and browsers test for Node's `global` before using it (§5).
    const guard = name === 'global' && binding.declaration === undefined ? at.guard(name) : undefined
    if (guard !== undefined) return [holder(global, { form: 'guarded-global', node: id, name, binding, guard, instance })]
    if (realm === 'window') {
      // The global object's own `parent`, `top` and `opener` (§5 Other windows).
      const member = windowMembers.get(name)
      if (member !== undefined) {
        const window = `${thisWindow}.${name}`
        return windowValue(id, name, { nullable: member.nullable, base: [], instance: hop(instance), window, binding })
      }
    }
    const holds = holdsAt(global, name) ?? singletons.get(name)
    if (holds === undefined) {
      // The global object's `eval` and string timers are native functions whose aliases are followed.
      const native = binding.declaration === undefined ? nativeMember(global, name) : undefined
      const leaves: Leaf[] = [{ form: 'global-property', node: id, name, binding, instance }]
      if (native !== undefined) return [{ kind: 'native', name: native, leaves, sites: [id] }]
      const fn = binding.declaration === undefined ? functionTarget(global, name) : undefined
      return fn === undefined ? [unknown] : [{ kind: 'member', target: fn, holder: global, sites: [id], leaves }]
    }
    return [holder(holds, { form: 'global-property', node: id, name, binding, holds, instance })]
  }

  /**
   * A window reached as another window (§5): the global holder, with a leaf that keeps the name's binding when it is a
   * bare name, and the leaves of the value it is read from otherwise, its window expression (§3), and for a child
   * window the window expression of its parent. A nullable one can also be null.
   */
  function windowValue(
    node: AstNode,
    name: string,
    how: {
      nullable: boolean
      base: Leaf[]
      instance: RealmInstance
      window: string | undefined
      binding?: GlobalBinding
      childOf?: string | undefined
    },
  ): Value[] {
    const { nullable, base, instance, window, binding, childOf } = how
    const leaf: Leaf = {
      form: 'other-window',
      node,
      name,
      ...(binding === undefined ? {} : { binding }),
      instance,
      ...(base.length === 0 ? {} : { base }),
      ...(window === undefined ? {} : { window }),
      ...(childOf === undefined ? {} : { childOf }),
    }
    return [holder(global, leaf), ...(nullable ? [constant(null)] : [])]
  }

  /**
   * `object.key`, and `object[key]` with a key that folds to a constant (§5 computed-property resolution), which reads
   * the member the constant names. An index read on a window is a child window.
   */
  function memberRead(node: AstNode, at: Position): Value[] {
    const object = node['object'] as AstNode
    const property = node['property'] as AstNode
    if (object.type === 'Super') return [unknown]
    if (node['computed'] !== true) {
      return property.type === 'Identifier' ? namedRead(node, property['name'] as string, at) : [unknown]
    }
    const keys = evaluate(property, at)
    // A key that throws throws before the read (Principle 1).
    if (keys.length === 0) return []
    // The object, once evaluated: evaluating it per key would be exponential in a chain of them.
    let objects: Value[] | undefined
    if (keys.every(isArrayIndex)) {
      // An element of a constant collection (§5 Resolver capabilities 4), read with a constant index.
      const elements = elementRead(object, keys, at)
      if (elements !== undefined) return elements
      // A character of a swept key (§5 Resolver capabilities 9): `k[0]`. A window realm's read evaluates the object
      // anyway, for a child window.
      if (realm === 'window' && keysSwept) objects = evaluate(object, at)
      const characters = sweptString(objects ?? sweptValues(object, at), (string) =>
        union(keys.map((key) => withFolds(constant(string[Number((key as ConstantValue).value)]), foldsOf([key])))),
      )
      if (characters !== undefined) return characters
    }
    if (keys.every(isIndex)) {
      // A constant index into objects the heap holds reads their fields, as a module cache's `e[8104]` does (§6).
      if (linking && keys.every(isArrayIndex)) {
        const fields = heapIndexRead(node, keys as ConstantValue[], at, objects)
        if (fields !== undefined) return fields
      }
      return childWindow(node, keys, at, objects)
    }
    // A key that may be an index, or may not be constant, reads a member the analyzer can't name.
    const names = keys.filter((key): key is ConstantValue => key.kind === 'constant')
    if (keys.some(isArrayIndex)) return [unknown]
    const objectValues = () => (objects ??= evaluate(object, at))
    if (names.length < keys.length) {
      // A key that mixes constants and values the analyzer can't resolve reads, beside a member it can't name, the
      // catalog functions its constants name, so that a write to the same key, whose constants are its candidates,
      // finds the original read (§5 Candidate sets, Resolver capabilities 10). Anything else
      // those constants read stays unknown, so no holder comes from such a key.
      if (names.length === 0 || !keys.every((key) => key.kind === 'constant' || opaque(key))) return [unknown]
      const members = names.flatMap((key) => {
        const name = toPropertyKey(key.value)
        if (typeof name === 'symbol') return []
        return carried(namedRead(node, name, at, objectValues), key).filter((value) => value.kind === 'member')
      })
      return union([...members, unknown])
    }
    return union(
      names.flatMap((key) => {
        const name = toPropertyKey(key.value)
        // No catalog member keyed by a symbol holds a native holder or a well-known symbol.
        return typeof name === 'symbol' ? [unknown] : carried(namedRead(node, name, at, objectValues), key)
      }),
    )
  }

  /**
   * The member `key` read from `node`'s object, whose values `objectValues` gives: a member of a native holder that is
   * itself one (§4 `holds`), or an interface object's prototype; a window's `parent`, `top` or `opener`, or its
   * `frames`, which is itself; or any object's `defaultView` or `contentWindow` (§5 Other windows). A holder read from a
   * holder keeps its folds.
   */
  function namedRead(
    node: AstNode,
    key: string,
    at: Position,
    objectsOf = () => evaluate(node['object'] as AstNode, at),
  ): Value[] {
    const object = node['object'] as AstNode
    let objects: Value[] | undefined
    const objectValues = () => (objects ??= objectsOf())
    if (key === 'length' && object.type !== 'Super') {
      // The length of a constant collection (§5 Resolver capabilities 4).
      const collections = collectionsOf(object, at)
      if (collections !== undefined) return union(collections.map((collection) => lengthOf(collection)))
      // The length of a swept key (§5 Resolver capabilities 9).
      const length = keysSwept ? sweptString(objectValues(), (string) => [constant(string.length)]) : undefined
      if (length !== undefined) return length
    }
    if (realm === 'window' && anyObjectWindows.has(key)) {
      // This window's `document.defaultView` is this window (§3, §5 Other windows), after the steps to the document.
      const document = key === 'defaultView' ? ownDocument(object, at) : undefined
      if (document !== undefined) {
        const how = { nullable: false, base: document.leaves, instance: codeInstance, window: thisWindow }
        return carried(windowValue(node, key, how), document)
      }
      // On any other object, whatever it is: which window is unknown.
      const window = anyObjectWindow(object, key, at)
      return windowValue(node, key, { nullable: true, base: [], instance: 'unknown', window })
    }
    const values = objectValues().flatMap((value): Value[] => {
      // Reading a member of null or undefined throws, so a nullable window's null gives no value.
      if (value.kind === 'constant' && (value.value === null || value.value === undefined)) return []
      // A field of an object the heap holds (§5 Resolver capabilities 5).
      if (isHeap(value)) return argumentRead(value, key, node, at) ?? fieldRead(value, key, node)
      if (value.kind !== 'holder') return [unknown]
      if (realm === 'window' && value.holder === global) {
        const instance = instanceOf(value.leaves)
        const member = windowMembers.get(key)
        if (member !== undefined) {
          // A child window's parent is the window it is a child of: this one, for this window's children (§3, §5).
          const child = key === 'parent' && value.leaves.every((leaf) => leaf.childOf === thisWindow)
          const from = windowOf(value.leaves)
          const window = child ? thisWindow : from === undefined ? undefined : `${from}.${key}`
          const how = { nullable: member.nullable, base: value.leaves, instance: child ? codeInstance : hop(instance), window }
          return carried(windowValue(node, key, how), value)
        }
      }
      // A platform singleton, through its alias group (§4). An access path is a chain of names, so a key with a dot in
      // it is one member's name, never a path.
      const path = value.holder === global ? key : `${value.holder}.${key}`
      const singleton = key.includes('.') ? undefined : singletons.get(path)
      if (singleton !== undefined) {
        const instance = instanceOf(value.leaves)
        const leaf: Leaf = { form: 'singleton', node, name: key, holds: singleton, path, instance, base: value.leaves }
        return carried([holder(singleton, leaf, value.holder === global)], value)
      }
      // A well-known symbol, read from the real `Symbol` holder however it was reached (§4 Property keys).
      if (value.holder === 'Symbol' && isWellKnownSymbol(key)) {
        const symbol = wellKnownSymbol(key)
        const fold: Fold = { node, value: symbol, via: value.leaves }
        return [{ kind: 'constant', value: symbol, folds: [...(value.folds ?? []), fold] }]
      }
      // `h.__proto__` runs `Object.prototype.__proto__`'s getter, a prototype step the catalog decides (§4).
      if (key === '__proto__') {
        const step = protoGetter(node, value)
        if (step !== undefined) return [step]
      }
      // A native function whose aliases are followed (§5 Resolver capabilities 2): a writer, or a global compiler.
      const native = nativeMember(value.holder, key)
      const folds = value.folds ? { folds: value.folds } : {}
      if (native !== undefined) return [{ kind: 'native', name: native, leaves: value.leaves, sites: [node], ...folds }]
      const reached = memberHolder(value.holder, key)
      const fn = reached === undefined ? functionTarget(value.holder, key) : undefined
      if (fn !== undefined) return [{ kind: 'member', target: fn, holder: value.holder, sites: [node], leaves: value.leaves, ...folds }]
      // An expando on a native holder, or on the global object, is a heap cell (§5 Global resolution).
      if (reached === undefined) return expandoRead(value, key)
      // A window read as `frames` is spelled as the frames collection, and reading any other member drops that.
      const spelled = realm === 'window' && value.holder === global && key === 'frames'
      const leaves = spelled ? asFrames(value.leaves) : unspelled(value.leaves)
      return [markedAbsent({ ...value, holder: reached, leaves }, value.holder === global && reached !== global)]
    })
    // Code that always throws there can have any value.
    return values.length === 0 ? [unknown] : union(values)
  }

  /**
   * `o[0]` with constant array indexes, when every object it can read is one the heap holds: the fields the indexes
   * name. Undefined for any other object.
   */
  function heapIndexRead(node: AstNode, keys: readonly ConstantValue[], at: Position, known?: Value[]): Value[] | undefined {
    const objects = known ?? evaluate(node['object'] as AstNode, at)
    if (objects.length === 0 || !objects.every(isHeap)) return undefined
    return union(
      keys.flatMap((key) =>
        carried(objects.flatMap((object) => fieldRead(object, String(key.value), node)), key),
      ),
    )
  }

  /**
   * `window[i]`: a child window of the window read (§5 Other windows), for an `index` that is a constant array index or
   * unresolved. A constant array index reads a child window on any window (`window[0]`, `parent["1"]`). An unresolved
   * key reads one only on a window spelled as the frames collection (`frames[i]`, `parent.frames[i]`); on any other
   * spelling (`window[ns]`) it reads a member the analyzer can't name. A constant that names something else
   * (`frames["fetch"]`) is that window's property.
   */
  function childWindow(node: AstNode, index: readonly Value[], at: Position, known?: Value[]): Value[] {
    if (realm !== 'window') return [unknown]
    const windows = known ?? evaluate(node['object'] as AstNode, at)
    if (!windows.some(isWindow)) return [unknown]
    const property = node['property'] as AstNode
    const indexes = index.filter(isArrayIndex)
    const unresolved = indexes.length < index.length
    /** The child window of `value`, read through `leaves` with the index `values`. */
    const child = (value: HolderValue, leaves: Leaf[], values: readonly Value[]): Value[] => {
      const parent = windowOf(leaves)
      const key = indexKey(property, values, at)
      const window = parent === undefined || key === undefined ? undefined : `${parent}[${key}]`
      const instance = hop(instanceOf(leaves))
      const name = `[${indexName(property, values)}]`
      const read = windowValue(node, name, { nullable: false, base: leaves, instance, window, childOf: parent })
      return carried(carried(read, value), { folds: foldsOf(values) })
    }
    return union(
      windows.flatMap((value): Value[] => {
        if (!isWindow(value)) return [unknown]
        // The leaves through which every key the index can be reads a child window: the frames spelling's, for an
        // unresolved key.
        const through = unresolved ? value.leaves.filter((leaf) => leaf.frames === true) : value.leaves
        if (through.length === value.leaves.length) return child(value, through, index)
        if (through.length > 0) return [...child(value, through, index), unknown]
        // Through any other spelling, only the constant indexes read a child window.
        return indexes.length > 0 ? [...child(value, value.leaves, indexes), unknown] : [unknown]
      }),
    )
  }

  /**
   * A `const`'s value where `id` reads it (§5 Resolver capabilities 1 and 2): the values its declaration gives it. A
   * primitive constant comes after the fold that reads it through its name, which carries the taint on the name's path,
   * and a native holder after the alias that reads it (§14).
   */
  function constantRead(id: AstNode, at: Position): Value[] {
    const binding = scope.constant(id)
    if (binding === undefined) return [unknown]
    const name = scope.nameOf(id)
    const found = declared(binding.declaration, name, at.frame)
    const { values, node, declarator } = found
    noted(found)
    const taint = taintOf(binding)
    return values.map((value): Value => {
      if ((value.kind === 'holder' || value.kind === 'native') && declarator !== undefined) {
        return aliased(value, declarator, name, taint)
      }
      if (value.kind !== 'constant') return value
      // A well-known symbol read from `Symbol` in the initializer itself keeps the steps that reached `Symbol`.
      const via = value.folds?.find((fold) => fold.node === node && fold.name === undefined)?.via
      const fold: Fold = {
        node,
        name,
        value: value.value,
        ...(taint === undefined ? {} : { taint }),
        ...(via === undefined ? {} : { via }),
      }
      return { ...value, folds: [...partFolds(value, node), fold] }
    })
  }

  /**
   * A variable's value where `id` reads it, other than a `const`'s (§5 Resolver capabilities 2): the values of the
   * definitions that reach the read, each after the alias that reads it, and its start value where that reaches it.
   */
  function variableRead(id: AstNode, at: Position): Value[] {
    const key = definitions.keyOf(id)
    if (key === undefined || key.scope === 'global') return [unknown]
    const declaration = key.scope
    return reachingValues(id, key, () => startValues(declaration, key.name, at.frame), undefined, at.frame)
  }

  /**
   * The value a local variable has before any definition: `undefined` for a `var` or `let`, a function for a function
   * declaration's name, a class for a class's, none for a `const` (a read before it throws), and unknown for a parameter,
   * a catch parameter, an import or `arguments`.
   */
  function startValues(declaration: AstNode, name: string, frame: Frame | undefined): Value[] {
    // A function declaration's name that a parameter of it shadows.
    const named = shadowedNameOf(declaration)
    if (named !== undefined) return [functionValue(named, frame)]
    if (isFunction(declaration)) {
      const params = (declaration['params'] as AstNode[]).flatMap(boundNames)
      if (params.includes(name)) {
        const own = frameOf(frame, declaration) ?? moduleScope(declaration)
        if (own !== undefined) return parameterValues(declaration, name, own)
        readers.at(-1)?.add(declaration)
        return [unknown]
      }
    }
    switch (declaration.type) {
      case 'VariableDeclaration':
        return declaration['kind'] === 'var' || declaration['kind'] === 'let' ? [constant(undefined)] : []
      case 'FunctionDeclaration':
      case 'FunctionExpression': {
        const params = (declaration['params'] as AstNode[]).flatMap(boundNames)
        return params.includes(name) || name === 'arguments' ? [unknown] : [functionValue(declaration, frame)]
      }
      case 'ClassDeclaration':
      case 'ClassExpression':
        return [functionValue(declaration, frame)]
      default:
        return [unknown]
    }
  }

  /**
   * The values the definitions of `key` that reach the read `id` give it, each after its alias (§14), with `start`'s
   * values where the start value reaches it. `taint` is what lies on the read name's resolution path.
   */
  function reachingValues(
    id: AstNode,
    key: VariableKey,
    start: () => Value[],
    taint: Taint | undefined,
    frame: Frame | undefined,
  ): Value[] {
    const reaching = definitions.reaching(id, key)
    const walked = walkedValues(id, key, reaching, start, taint, frame)
    if (walked !== undefined) return walked
    // Past a lazy init that didn't assign, only the entry values that pass its test remain (§5 Resolver capabilities 6).
    const narrowed = (item: Definition | 'start', values: readonly Value[]): readonly Value[] => {
      const narrowings = reaching.narrowed?.get(item)
      if (narrowings === undefined) return values
      return values.flatMap((value): Value[] => {
        // A holder that may be missing is an object where it is there, and `undefined` where it isn't (§7).
        if (mayBeMissing(value)) {
          const there = narrowings.every((each) => passes(each, {}))
          const missing = narrowings.every((each) => passes(each, undefined))
          if (there && missing) return [value]
          if (there) return [markedAbsent(value as HolderValue, false)]
          return missing ? [withFolds(constant(undefined), foldsOf([value]))] : []
        }
        const kept = value.kind !== 'constant' || undecided(value) || narrowings.every((each) => passes(each, value.value))
        return kept ? [value] : []
      })
    }
    const values: Value[] = reaching.start ? [...narrowed('start', start())] : []
    for (const definition of reaching.definitions) {
      // A definition in an arm a call argument literal's field rules out is not reached in this frame. With no
      // frame, a read that some frame narrows so reads its function's parameters, so that its writes are instantiated.
      if (frame !== undefined && armRuledOut(definition.site, definition.owner, positionOf(definition, frame))) continue
      if (frame === undefined && ruledOutSomewhere(definition)) readers.at(-1)?.add(definition.owner)
      const found = definitionValues(definition, frame)
      noted(found)
      for (const value of narrowed(definition, found.values)) {
        values.push(aliased(value, definition.site, definition.name, taint))
      }
    }
    // A once-flag's tests are never decided as constants (§5 Resolver capabilities 6), unless it reads a catalog native,
    // whose test stays a §7 guard.
    const native = values.some((value) => value.kind === 'holder' || value.kind === 'native')
    if (!native && flags.isFlag(key)) return union(values.map((value) => flagValue(value, id)))
    return union(values)
  }

  /**
   * A read after a prototype walk to the first owner (§4 A holder chosen at runtime, §5 Resolver capabilities 8): the
   * walk is simulated per start value against the unmutated catalog, and the read has the holders it stops at, each
   * with the walk's `catalog-holder` step. The start values are those the definitions before the loop, or the
   * variable's start value, give it. Undefined when no walk loop's step reaches the read.
   */
  function walkedValues(
    id: AstNode,
    key: VariableKey,
    reaching: Reaching,
    start: () => Value[],
    taint: Taint | undefined,
    frame: Frame | undefined,
  ): Value[] | undefined {
    const fn = calls.functionOf(id)
    const walk = reaching.definitions
      .map((definition) => walkLoopAround(definition, key))
      .find(
        (each) =>
          each !== undefined && each.loop.end <= id.start && calls.functionOf(each.loop) === fn && runsBefore(each.loop, id),
      )
    if (walk === undefined) return undefined
    const node = walk.loop
    const entering = (definition: Definition) =>
      definition.site.end <= node.start && calls.functionOf(definition.site) === fn
    const values: Value[] = []
    const entries: Value[] = reaching.start ? [...start()] : []
    const later: Definition[] = []
    for (const definition of reaching.definitions) {
      if (within(node, definition.site)) continue
      if (!entering(definition)) {
        later.push(definition)
        continue
      }
      const found = definitionValues(definition, frame)
      noted(found)
      entries.push(...found.values.map((value) => aliased(value, definition.site, definition.name, taint)))
    }
    const at: Position = { ...nowhere, ...(frame === undefined ? {} : { frame }) }
    const results = union(union(entries).flatMap((entry) => walked(walk, entry, at)))
    values.push(...results)
    for (const definition of later) {
      if (guardedOut(definition, walk, key, results, entering, at)) continue
      const found = definitionValues(definition, frame)
      noted(found)
      values.push(...found.values.map((value) => aliased(value, definition.site, definition.name, taint)))
    }
    return union(values)
  }

  /**
   * Whether a definition after a walk never runs because a test of the walk's result guards it, and ECMA-262 decides
   * that test against every value the walk ends with (§4 A holder chosen at runtime, Principle 2): zone.js's
   * `!proto && obj[k] && (proto = obj)` never re-adds `obj` when the catalog chose a native holder for `proto`. The
   * guards are the `&&`, `||`, `?:` and `if` tests on the definition's path, in the walk's function, that read only the
   * walk's result: the walk runs before them, and no other definition of the variable reaches them.
   */
  function guardedOut(
    definition: Definition,
    walk: Walk,
    key: VariableKey,
    results: readonly Value[],
    entering: (definition: Definition) => boolean,
    at: Position,
  ): boolean {
    const { loop } = walk
    if (results.length === 0 || definition.site.start < loop.end) return false
    const fn = calls.functionOf(loop)
    if (calls.functionOf(definition.site) !== fn) return false
    // Whether the test's reads of the variable see only the walk's result.
    const readsResult = (test: AstNode): boolean => {
      if (!runsBefore(loop, test)) return false
      let reads = true
      walkTree(test, {
        enter(each) {
          if (!reads || !walk.isVariable(each)) return undefined
          const reaching = definitions.reaching(each, key)
          reads = reaching.definitions.every((one) => within(loop, one.site) || entering(one))
          return false
        },
      })
      return reads
    }
    // Whether `test` can have the outcome `needed` with the variable holding one of the walk's results.
    const possible = (test: AstNode, needed: boolean): boolean => {
      if (test.type === 'LogicalExpression' && test['operator'] === (needed ? '&&' : '||')) {
        return possible(test['left'] as AstNode, needed) && possible(test['right'] as AstNode, needed)
      }
      if (test.type === 'UnaryExpression' && test['operator'] === '!') return possible(test['argument'] as AstNode, !needed)
      if (!walkTestOf(test, walk.isVariable) || !readsResult(test)) return true
      return results.some((value) => walkTest(walk, test, value, at).has(needed))
    }
    let child = definition.site
    for (let node = parentOf(child); node !== undefined && node !== fn && !within(node, loop); child = node, node = parentOf(node)) {
      if (isFunction(node)) return false
      const test = node['test'] as AstNode | undefined
      if (node.type === 'LogicalExpression' && child === node['right'] && node['operator'] !== '??') {
        if (!possible(node['left'] as AstNode, node['operator'] === '&&')) return true
      } else if ((node.type === 'IfStatement' || node.type === 'ConditionalExpression') && test !== undefined && child !== test) {
        if (!possible(test, child === node['consequent'])) return true
      }
    }
    return false
  }

  /**
   * Whether every path to `read` runs the statement `loop` first: `loop` sits, through blocks only, in the statement list
   * that holds `read`, before it. Otherwise a start value could reach the read without the walk (or a value from another
   * branch could be walked that never enters it), so the walk isn't simulated and the read keeps the union of values.
   */
  function runsBefore(loop: AstNode, read: AstNode): boolean {
    let child = loop
    for (let node = parentOf(loop); node !== undefined; child = node, node = parentOf(node)) {
      if (within(node, read)) {
        const list =
          node.type === 'BlockStatement' || node.type === 'Program' || node.type === 'StaticBlock'
            ? (node['body'] as AstNode[])
            : node.type === 'SwitchCase'
              ? (node['consequent'] as AstNode[])
              : undefined
        return list !== undefined && list.includes(child) && child.end <= read.start
      }
      if (node.type !== 'BlockStatement') return false
    }
    return false
  }

  /** The walk loop whose prototype step is `definition`, if it is one. */
  function walkLoopAround(definition: Definition, key: VariableKey): Walk | undefined {
    // Only `o = f(o)` and `o = o.__proto__` can be a walk's step.
    const { site } = definition
    if (site.type !== 'AssignmentExpression' || site['operator'] !== '=') return undefined
    const right = (site['right'] as AstNode).type
    if (right !== 'CallExpression' && right !== 'MemberExpression') return undefined
    for (let node = parentOf(definition.site); node !== undefined; node = parentOf(node)) {
      if (isFunction(node)) return undefined
      if (!isLoop(node)) continue
      const walk = walkOf(node, key)
      if (walk === undefined || !walk.steps.includes(definition.site)) return undefined
      return walk
    }
    return undefined
  }

  /**
   * A prototype walk to the first owner (§4): a `while`, `do…while` or `for` loop over the variable `key`, whose test and
   * `if (…) break` statements are made of the variable's truthiness, its comparisons with `null` and `undefined`, its
   * `typeof` compared with a string, and own-property tests of it, joined by `!`, `&&` and `||`, and whose other
   * statements are prototype steps of it (`o = Object.getPrototypeOf(o)`, `o = o.__proto__`). Memoized per loop and
   * variable.
   */
  function walkOf(loop: AstNode, key: VariableKey): Walk | undefined {
    let byScope = walks.get(loop)
    if (byScope === undefined) walks.set(loop, (byScope = new Map()))
    let byName = byScope.get(key.scope)
    if (byName === undefined) byScope.set(key.scope, (byName = new Map()))
    if (byName.has(key.name)) return byName.get(key.name) ?? undefined
    const found = findWalk(loop, key)
    byName.set(key.name, found ?? null)
    return found
  }
  const walks = new WeakMap<AstNode, Map<AstNode | 'global', Map<string, Walk | null>>>()

  function findWalk(loop: AstNode, key: VariableKey): Walk | undefined {
    const isVariable = (node: AstNode | null | undefined): boolean => {
      if (node?.type !== 'Identifier') return false
      const read = definitions.keyOf(node)
      return read !== undefined && read.scope === key.scope && read.name === key.name
    }
    const isStep = (node: AstNode): boolean => {
      if (node.type !== 'AssignmentExpression' || node['operator'] !== '=') return false
      if (!isVariable(node['left'] as AstNode)) return false
      const right = node['right'] as AstNode
      if (right.type === 'MemberExpression') {
        return memberKeyName(right) === '__proto__' && isVariable(right['object'] as AstNode)
      }
      if (right.type !== 'CallExpression') return false
      const [argument] = right['arguments'] as AstNode[]
      return isVariable(argument) && getPrototypeOf(calleeExpression(right['callee'] as AstNode), nowhere) !== undefined
    }
    const isTest = (node: AstNode): boolean => {
      switch (node.type) {
        case 'UnaryExpression':
          return node['operator'] === '!' && isTest(node['argument'] as AstNode)
        case 'LogicalExpression':
          return node['operator'] !== '??' && isTest(node['left'] as AstNode) && isTest(node['right'] as AstNode)
        default:
          return walkTestOf(node, isVariable)
      }
    }
    const statementsOf = (node: AstNode | null | undefined): AstNode[] | undefined => {
      if (node === null || node === undefined || node.type === 'EmptyStatement') return []
      if (node.type === 'BlockStatement') {
        const list = (node['body'] as AstNode[]).map(statementsOf)
        return list.some((each) => each === undefined) ? undefined : list.flat() as AstNode[]
      }
      return [node]
    }
    const actions: WalkAction[] = []
    const steps: AstNode[] = []
    const addStatement = (statement: AstNode): boolean => {
      if (statement.type === 'ExpressionStatement') return addExpression(statement['expression'] as AstNode)
      if (statement.type === 'IfStatement' && statement['alternate'] === null) {
        const [only, ...more] = statementsOf(statement['consequent'] as AstNode) ?? [undefined]
        if (only?.type !== 'BreakStatement' || only['label'] !== null || more.length > 0) return false
        const test = statement['test'] as AstNode
        if (!isTest(test)) return false
        actions.push({ kind: 'break', test })
        return true
      }
      return false
    }
    const addExpression = (expression: AstNode): boolean => {
      if (!isStep(expression)) return false
      actions.push({ kind: 'step', node: expression['right'] as AstNode })
      steps.push(expression)
      return true
    }
    const test = loop['test'] as AstNode | null | undefined
    if (loop.type === 'ForInStatement' || loop.type === 'ForOfStatement') return undefined
    if (test !== null && test !== undefined && !isTest(test)) return undefined
    const head = test === null || test === undefined ? [] : [{ kind: 'test' as const, test }]
    if (loop.type === 'ForStatement' && loop['init'] !== null) return undefined
    const body = statementsOf(loop['body'] as AstNode)
    if (body === undefined) return undefined
    if (loop.type !== 'DoWhileStatement') actions.push(...head)
    for (const statement of body) if (!addStatement(statement)) return undefined
    const update = loop['update'] as AstNode | null | undefined
    if (update !== null && update !== undefined && !addExpression(update)) return undefined
    if (loop.type === 'DoWhileStatement') actions.push(...head)
    if (steps.length === 0) return undefined
    // Every other definition of the variable in the loop would change what the walk visits.
    const inLoop = definitions.of(key).filter((definition) => within(loop, definition.site))
    if (inLoop.some((definition) => !steps.includes(definition.site))) return undefined
    return { loop, actions, steps, isVariable }
  }

  /**
   * The values a walk ends with from the start value `entry`: it runs its actions on the unmutated catalog, stopping at
   * a test that fails or a `break` whose test holds. A test that can't be decided both stops and goes on (Principle 3).
   * A step from a value the catalog doesn't give a prototype for ends in unknown, and one that throws ends in nothing.
   * Every run of the actions takes a step, and every chain in the catalog ends in null, so the walk ends.
   */
  function walked(walk: Walk, entry: Value, at: Position): Value[] {
    const results: Value[] = []
    const member = walkMember(walk, at)
    type State = { value: Value; path: string[]; next: number }
    const pending: State[] = [{ value: entry, path: entry.kind === 'holder' ? [entry.holder] : [], next: 0 }]
    const end = (state: State) => {
      const { value, path } = state
      if (value.kind !== 'holder') {
        results.push(value)
        return
      }
      const choice: WalkChoice = { walk: path, holder: value.holder, ...(member === undefined ? {} : { member }) }
      const fold: Fold = { node: walk.loop, value: undefined, walked: choice }
      results.push({ ...value, folds: [...(value.folds ?? []), fold] })
    }
    // Each run of the loop's actions takes at least one prototype step, and a chain in the catalog ends in null, so
    // the catalog bounds every walk, as it bounds a catalog enumeration (Principle 5).
    while (pending.length > 0) {
      const state = pending.pop()!
      // The loop runs again after its last action.
      const action = walk.actions[state.next % walk.actions.length]!
      const next = state.next + 1
      if (action.kind === 'step') {
        const stepped = protoStepOf(state.value)
        if (stepped === undefined) continue
        if (stepped.kind === 'unknown') {
          results.push(unknown)
          continue
        }
        const path = stepped.kind === 'holder' ? [...state.path, stepped.holder] : state.path
        pending.push({ value: stepped, path, next })
        continue
      }
      // A loop's test ends the walk when it fails, and an `if (…) break` when its test holds.
      const outcomes = walkTest(walk, action.test, state.value, at)
      const stops = action.kind === 'break'
      if (outcomes.has(stops)) end(state)
      if (outcomes.has(!stops)) pending.push({ ...state, next })
    }
    return union(results)
  }

  /** The member a walk looks for: its own-property tests' key when they all fold to one constant. */
  function walkMember(walk: Walk, at: Position): string | undefined {
    const members = new Set<string>()
    for (const action of walk.actions) {
      if (action.kind === 'step') continue
      walkTree(action.test, {
        enter(node) {
          if (node.type !== 'CallExpression') return undefined
          const test = walkOwnTest(node, walk.isVariable)
          if (test === undefined) return undefined
          const keys = test.key === null ? [constant(undefined)] : evaluate(test.key, at)
          for (const key of keys) members.add(key.kind === 'constant' ? catalogSpelling(toPropertyKey(key.value)) : '*')
          return false
        },
      })
    }
    const [only, ...more] = members
    return only === undefined || only === '*' || more.length > 0 ? undefined : only
  }

  /** A member's spelling as the catalog spells it: `pushState`, `@@iterator`, `["a.b"]`. */
  const catalogSpelling = (key: Key): string => memberName('', key).replace(/^\./, '')

  /** The prototype a walk's step gives: the catalog's for a native holder, nothing for null, unknown otherwise. */
  function protoStepOf(value: Value): Value | undefined {
    if (value.kind === 'constant') return value.value === null || value.value === undefined ? undefined : unknown
    if (value.kind !== 'holder' || !Object.hasOwn(holders, value.holder)) return unknown
    const proto = holders[value.holder]!.proto
    return proto === null ? withFolds(constant(null), value.folds ?? []) : markedAbsent({ ...value, holder: proto }, false)
  }

  /**
   * The outcomes a walk's test can have with its variable holding `value`: true, false, or `throws` when an own-property
   * test runs on null or undefined. A test that can't be decided has both true and false.
   */
  function walkTest(walk: Walk, test: AstNode, value: Value, at: Position): Set<boolean | 'throws'> {
    const both = new Set<boolean | 'throws'>([true, false])
    const one = (outcome: boolean | undefined) => (outcome === undefined ? both : new Set<boolean | 'throws'>([outcome]))
    switch (test.type) {
      case 'Identifier':
        return one(truthiness([value]))
      case 'UnaryExpression': {
        const inner = walkTest(walk, test['argument'] as AstNode, value, at)
        return new Set([...inner].map((each) => (each === 'throws' ? each : !each)))
      }
      case 'LogicalExpression': {
        const left = walkTest(walk, test['left'] as AstNode, value, at)
        const goesOn = test['operator'] === '&&'
        const outcomes = new Set([...left].filter((each) => each !== goesOn))
        if (left.has(goesOn)) for (const each of walkTest(walk, test['right'] as AstNode, value, at)) outcomes.add(each)
        return outcomes
      }
      case 'BinaryExpression': {
        const typed = typeofTest(test, walk.isVariable)
        if (typed !== undefined) {
          const type = typeofOf(value)
          return type === undefined ? both : one((type === typed.against) === (typed.operator === '=='))
        }
        const { operator, strict, against } = nullTest(test, walk.isVariable)!
        if (value.kind === 'holder') return one(operator === '!=')
        if (value.kind !== 'constant') return both
        const equal = strict ? value.value === against : value.value === null || value.value === undefined
        return one(operator === '==' ? equal : !equal)
      }
      default: {
        const own = walkOwnTest(test, walk.isVariable)!
        if (value.kind === 'constant' && (value.value === null || value.value === undefined)) return new Set(['throws'])
        if (value.kind !== 'holder') return both
        if (own.method && firstOwner(value.holder, 'hasOwnProperty') !== 'Object.prototype') return both
        const keys = own.key === null ? [constant(undefined)] : evaluate(own.key, at)
        const results = new Set(keys.map((key) => ownTest(value.holder, key)?.owns))
        return results.has(undefined) ? both : (results as Set<boolean>)
      }
    }
  }

  /**
   * What ECMA-262's `typeof` gives a walk's value (Principle 2): a constant's type (`'object'` for null), and for a
   * native holder `'function'` when it is callable, an interface object, legacy factory function or constructor, or
   * `Function.prototype`, and `'object'` otherwise. Undefined when it can't be decided.
   */
  function typeofOf(value: Value): string | undefined {
    if (value.kind === 'constant') return value.value === null ? 'object' : typeof value.value
    if (value.kind !== 'holder' || !Object.hasOwn(holders, value.holder)) return undefined
    return holders[value.holder]!.kind === 'constructor' || value.holder === 'Function.prototype' ? 'function' : 'object'
  }

  /**
   * Whether `test` is one test a walk's simulation decides on its variable alone: its truthiness, a comparison with
   * `null` or `undefined`, a `typeof` comparison, or an own-property test.
   */
  function walkTestOf(test: AstNode, isVariable: (node: AstNode) => boolean): boolean {
    if (test.type === 'Identifier') return isVariable(test)
    if (test.type === 'BinaryExpression') return nullTest(test, isVariable) !== undefined || typeofTest(test, isVariable) !== undefined
    return test.type === 'CallExpression' && walkOwnTest(test, isVariable) !== undefined
  }

  /**
   * An own-property test of a walk's variable: `h.hasOwnProperty(k)` read from the variable itself, or any other route
   * `ownTestParts` knows with the variable as the object tested.
   */
  function walkOwnTest(
    call: AstNode,
    isVariable: (node: AstNode) => boolean,
  ): { key: AstNode | null; method: boolean } | undefined {
    const args = call['arguments'] as AstNode[]
    const callee = calleeExpression(call['callee'] as AstNode)
    if (callee.type === 'MemberExpression' && isVariable(callee['object'] as AstNode)) {
      if (memberKeyName(callee) !== 'hasOwnProperty' || args.some((argument) => argument.type === 'SpreadElement')) return undefined
      return { key: args[0] ?? null, method: true }
    }
    const parts = ownTestParts(call, nowhere)
    return parts !== undefined && isVariable(parts.object) ? { key: parts.key, method: false } : undefined
  }

  /** A value read through the variable `name` from its definition `site`: a holder or constant after its alias. */
  function aliased(value: Value, site: AstNode, name: string, taint: Taint | undefined): Value {
    if (!carriesFolds(value)) return value
    const fold: Fold = { node: site, name, value: undefined, alias: true, ...(taint === undefined ? {} : { taint }) }
    return { ...value, folds: [...(value.folds ?? []), fold] }
  }

  /**
   * The values a definition gives its variable, memoized (§5 Resolver capabilities 2: alias chains have no depth limit):
   * what its pattern destructures from its source, or unknown when the syntax doesn't show it.
   */
  function definitionValues(definition: Definition, frame: Frame | undefined): Declared {
    const { site, name, pattern, source, compound } = definition
    if (source === undefined && compound === undefined) return { values: [unknown], node: site }
    const at = positionOf(definition, frame)
    return memoized({
      key: site,
      name: at.frame === undefined ? name : `${name}@${at.frame.id}`,
      fallback: site,
      // A compound assignment gives its variable what `x = x op e` would (ECMA-262 13.15.2).
      compute: () =>
        source === undefined
          ? { values: evaluate(compound!, at), node: compound! }
          : (destructured(pattern, source, name, at) ?? { values: [unknown], node: site }),
    })
  }

  /**
   * Whether code at `site`, in the own code of `owner`, sits in an arm (of an `if`, a `?:`, or the right of `&&` or
   * `||`) whose test, evaluated at `at`, a call argument literal's field decides the other way (§5 Resolver
   * capabilities 5): that arm is not reached there.
   */
  function armRuledOut(site: AstNode, owner: AstNode, at: Position): boolean {
    const tests = armTests(site, owner)
    if (tests.length === 0 || !literalCalled(at.frame)) return false
    for (const { test, outcome } of tests) {
      // A test that needs the value being found, as a once-flag's does, is not decided by it.
      const key = `${test.start}:${test.end}@${at.frame!.id}`
      if (testing.has(key)) continue
      testing.add(key)
      let taken: boolean | undefined
      try {
        taken = argumentDecided(settled(evaluate(test, at), test))
      } finally {
        testing.delete(key)
      }
      if (taken !== undefined && taken !== outcome) return true
    }
    return false
  }

  /** The arm tests around each definition site that a call argument literal may decide (`armTests`), found once. */
  const sitesArmTests = new Map<AstNode, { test: AstNode; outcome: boolean }[]>()

  /**
   * The tests of the arms (of an `if`, a `?:`, or the right of `&&` or `||`) that code at `site` sits in, out to
   * `owner`, with the outcome each needs, when a call argument literal may decide them (`readsParameterField`).
   */
  function armTests(site: AstNode, owner: AstNode): { test: AstNode; outcome: boolean }[] {
    const known = sitesArmTests.get(site)
    if (known !== undefined) return known
    const found: { test: AstNode; outcome: boolean }[] = []
    if (isFunction(owner)) {
      for (let child = site, parent = parentOf(child); parent !== undefined && child !== owner; child = parent, parent = parentOf(parent)) {
        let test: AstNode | undefined
        let outcome = true
        if (parent.type === 'IfStatement' || parent.type === 'ConditionalExpression') {
          if (child === parent['consequent']) test = parent['test'] as AstNode
          else if (child === parent['alternate']) [test, outcome] = [parent['test'] as AstNode, false]
        } else if (parent.type === 'LogicalExpression' && child === parent['right'] && parent['operator'] !== '??') {
          ;[test, outcome] = [parent['left'] as AstNode, parent['operator'] === '&&']
        }
        if (test !== undefined && readsParameterField(test, owner, 0)) found.push({ test, outcome })
      }
    }
    sitesArmTests.set(site, found)
    return found
  }

  /**
   * Whether a test can read a field of one of `owner`'s parameters, the only reads a call argument literal can
   * decide: `options.global`, `!options.stat`, or a variable of `owner` defined only from such reads (`GLOBAL`), with
   * no call in between. Tests of any other form are not evaluated for the argument-literal rule, which keeps its cost
   * to the tests it can decide.
   */
  function readsParameterField(node: AstNode, owner: AstNode, depth: number): boolean {
    switch (node.type) {
      case 'MemberExpression': {
        let object = node['object'] as AstNode
        while (object.type === 'MemberExpression') object = object['object'] as AstNode
        if (object.type !== 'Identifier') return false
        const key = definitions.keyOf(object)
        return key !== undefined && key.scope === owner && (owner['params'] as AstNode[]).flatMap(boundNames).includes(key.name)
      }
      case 'Identifier': {
        const key = definitions.keyOf(node)
        if (key === undefined || key.scope === 'global' || depth >= 4) return false
        const all = definitions.of(key)
        return (
          all.length > 0 &&
          all.every((each) => each.owner === owner && each.source !== undefined && readsParameterField(each.source, owner, depth + 1))
        )
      }
      case 'UnaryExpression':
        return node['operator'] === '!' && readsParameterField(node['argument'] as AstNode, owner, depth)
      case 'LogicalExpression':
      case 'BinaryExpression':
        return readsParameterField(node['left'] as AstNode, owner, depth) || readsParameterField(node['right'] as AstNode, owner, depth)
      default:
        return false
    }
  }

  /** The arm tests being evaluated by `armRuledOut`, by test and frame. */
  const testing = new Set<string>()

  /** Whether a frame is, or runs within, an instance of a call that passes an object literal directly. */
  function literalCalled(frame: Frame | undefined): boolean {
    return withinCall(frame, (binding) => passesLiteral(binding.site.args))
  }

  /**
   * For each definition site, by its node: false when no frame of its function can rule out an arm it is in, true once
   * one is found to. A site some frame was not yet seen to rule out is looked at again, since a value its test
   * needs may still be being found.
   */
  const ruledOut = new Map<AstNode, boolean>()

  /**
   * Whether some frame of the function that owns a definition rules out an arm it is in. Only a function some
   * call passes an object literal to directly can have one.
   */
  function ruledOutSomewhere(definition: Definition): boolean {
    const { site, owner } = definition
    const known = ruledOut.get(site)
    if (known !== undefined) return known
    const literal = isFunction(owner) && calls.callsOf(owner).some((call) => passesLiteral(call.args))
    if (!literal || armTests(site, owner).length === 0) {
      ruledOut.set(site, false)
      return false
    }
    // While it is looked at, no arm counts as ruled out, so a test that needs the definition finds it in no arm.
    ruledOut.set(site, false)
    const found = framesOf(owner).some((frame) => armRuledOut(site, owner, positionOf(definition, frame)))
    if (found) ruledOut.set(site, true)
    else ruledOut.delete(site)
    return found
  }

  /**
   * Where a definition's source is evaluated: with no `typeof` guard known, at the top level where it is, and in
   * `frame` when that instantiates the function whose own code holds the definition.
   */
  const positionOf = (definition: Definition, frame?: Frame): Position => {
    const base = definition.topLevel ? topLevelNowhere : nowhere
    const own = frameAt(frame, definition.site, definition.owner)
    return own !== undefined ? { ...base, frame: own } : base
  }

  /**
   * The frame code at `site`, in the own code of `owner`, runs in: the innermost iteration, out from `frame`, of a loop
   * around it, or the frame of `owner` itself.
   */
  function frameAt(frame: Frame | undefined, site: AstNode, owner: AstNode): Frame | undefined {
    for (let at = frame; at !== undefined; at = at.outer) {
      if (at.fn === owner) return at
      if (at.iteration !== undefined && at.fn.start <= site.start && site.end <= at.fn.end) return at
    }
    return moduleScope(owner)
  }

  /** Each linked module's one factory frame, found once. */
  const moduleScopes = new Map<AstNode, Frame | undefined>()

  /**
   * The frame a linked module's factory runs in, when `fn` is one (§6). A module runs once, so code that reads its
   * factory's bindings reads them there, however it was reached: a callback, a closure or an export.
   */
  function moduleScope(fn: AstNode): Frame | undefined {
    if (!context.links.factories.has(fn)) return undefined
    if (moduleScopes.has(fn)) return moduleScopes.get(fn)
    moduleScopes.set(fn, undefined)
    const frames = factoryFrames(fn)
    const found = frames?.length === 1 ? frames[0] : undefined
    moduleScopes.set(fn, found)
    return found
  }

  /**
   * The values a `const` declaration gives `name`, memoized, with the expression they come from and its declarator (§5
   * Resolver capabilities 1: `const` chains have no depth limit).
   */
  function declared(declaration: AstNode, name: string, frame?: Frame): Declared & { declarator?: AstNode } {
    const declarator = (declaration['declarations'] as AstNode[]).find((candidate) =>
      boundNames(candidate['id'] as AstNode).includes(name),
    )
    // A `for…in` or `for…of` head declares its constant without an initializer: each iteration's binding is a fresh one.
    const init = declarator?.['init'] as AstNode | null | undefined
    if (declarator === undefined || init === null || init === undefined) return { values: [unknown], node: declaration }
    const definition = definitions.of({ scope: declaration, name }).find((each) => each.site === declarator)
    const at = definition === undefined ? nowhere : positionOf(definition, frame)
    const found = memoized({
      key: declarator,
      name: at.frame === undefined ? name : `${name}@${at.frame.id}`,
      fallback: declaration,
      compute: () => destructured(declarator['id'] as AstNode, init, name, at) ?? { values: [unknown], node: declaration },
    })
    return { ...found, declarator }
  }

  /**
   * A value memoized by its key and name. One read while others are evaluated is evaluated within them, up to
   * `maxNesting` deep. Past that, it stops the whole nest, and `chain` evaluates it first. One that reads itself,
   * directly or through others, is unknown.
   */
  function memoized(given: Pending): Declared {
    // A counterfactual run's values are its own.
    const pending = counterfactualRun === undefined ? given : { ...given, name: `${given.name}${counterfactualRun.variant}` }
    const found = memoizedValue(pending)
    passDecided(found)
    return found
  }

  /** Passes on the tests a call argument literal's field decided while a memoized value was found. */
  function passDecided(found: Declared): void {
    const into = deciding.at(-1)
    if (into === undefined || found.decided === undefined) return
    for (const decision of found.decided) into.set(`${decision.test.start}:${decision.test.end}@${decision.literal.start}`, decision)
  }

  function memoizedValue(pending: Pending): Declared {
    if (unsettling()) {
      // A value kept apart, unsettled, is what finding where writes land reads, and it leaves its reader unsettled too.
      const apart = stored(pending.key, `${pending.name}${unsettled}`)
      if (apart !== undefined && apart !== 'pending') {
        taintUnsettled()
        noted(apart)
        return apart
      }
    }
    const known = stored(pending.key, pending.name)
    if (known === 'pending') {
      spoiled()
      // A value that reads itself is unknown there, so what is found within it meanwhile is provisional on it.
      const finding = evaluating.get(pending.key)?.get(pending.name)
      if (finding !== undefined) cutShort(finding)
      return { values: [unknown], node: pending.fallback }
    }
    if (known !== undefined) return known
    const kept = provisional.size === 0 ? undefined : provisionalValue(pending.key, pending.name)
    if (kept !== undefined) return kept
    if (nesting.length === 0) return chain(pending)
    if (nesting.length >= maxNesting) {
      // A hit of the nesting cap, counted once for the value it defers (§18).
      context.capHit('nesting', pending.key)
      throw new Needed(pending)
    }
    return evaluated(pending)
  }

  /**
   * Evaluates `first` without a depth limit. The values that wait on another are a stack, each below the one it reads:
   * each is evaluated until one it reads, however deep, is too deep to evaluate within it. That one, and the ones
   * between, go on top, and each is evaluated again once the one above it has its value. So the stack is the chain of
   * reads that led to its top, and a value that reads one on it reads itself. Each value below the top is a finding
   * kept open until it has its value, so what is found from reading it meanwhile is found again once it does.
   */
  function chain(first: Pending): Declared {
    const stack: { pending: Pending; waiting?: Finding }[] = [{ pending: first }]
    let found: Declared | undefined
    const base = open.length
    try {
      while (stack.length > 0) {
        const top = stack.at(-1)!
        try {
          // Only a value on the stack reads one below it, and that read finds it pending, so each is evaluated here.
          const value = evaluated(top.pending, top.waiting)
          if (top.pending === first) found = value
          stack.pop()
          if (top.waiting !== undefined) closeWaiting(top.pending, top.waiting)
        } catch (error) {
          if (!(error instanceof Needed)) throw error
          top.waiting ??= openWaiting(top.pending)
          const above = [...error.waiting.slice(1), error.constant]
          above.forEach((pending, index) => stack.push(index < above.length - 1 ? { pending, waiting: openWaiting(pending) } : { pending }))
        }
      }
    } finally {
      // Stopped by anything else, the values still waiting are no longer found.
      for (const { pending, waiting } of stack.reverse()) if (waiting !== undefined) closeWaiting(pending, waiting)
      while (open.length > base) closeOpen()
    }
    return found!
  }

  /** Opens the finding of a value that waits on the chain for one above it. */
  function openWaiting({ key, name }: Pending): Finding {
    const finding: Finding = { at: open.length }
    open.push(undefined)
    let mine = evaluating.get(key)
    if (mine === undefined) evaluating.set(key, (mine = new Map()))
    mine.set(name, finding)
    return finding
  }

  /** Closes the finding of a value that waited on the chain, once it has its value. */
  function closeWaiting({ key, name }: Pending, finding: Finding): void {
    if (open.length === finding.at + 1) closeOpen()
    if (evaluating.get(key)?.get(name) === finding) evaluating.get(key)!.delete(name)
    provisional.delete(finding)
  }

  /** A memoized value: the code's, or while the dynamic-call index is built, one of the build's own. */
  function stored(key: AstNode, name: string): Declared | 'pending' | undefined {
    const own = constants.get(key)?.get(name)
    if (own !== undefined || building === undefined) return own
    const built = building.constants.get(key)?.get(name)
    if (built !== undefined) spoiled()
    return built
  }

  /**
   * For each memoized value being evaluated, innermost last: null when the code's own evaluation began it, else whether
   * a test it read went unsettled because it was begun while finding where writes land (`settled`). Such a value
   * is kept apart, for that finding only: the code's own evaluation finds it again, settling what it can.
   */
  const unsettledValues: (boolean | null)[] = []
  /** The mark of the name an unsettled value is kept under, apart from the code's own (`unsettledValues`). */
  const unsettled = '~unsettled'

  /** Marks every value being evaluated that was begun while finding where writes land as unsettled. */
  function taintUnsettled(): void {
    for (let index = 0; index < unsettledValues.length; index++) if (unsettledValues[index] !== null) unsettledValues[index] = true
  }

  /**
   * Evaluates a memoized value, and memoizes it. The caps its evaluation hits, and the `analysis-budget` cuts it makes,
   * count once it has its values. When it
   * stops, because one it reads is too deep to evaluate within it, it stays pending, and is added to the chain of those
   * waiting for that one.
   */
  function evaluated(pending: Pending, waiting?: Finding): Declared {
    const { key, name } = pending
    // While the dynamic-call index is built, a value is the code's only when nothing it read depends on the part of the
    // index built so far (`spoiled`); otherwise it is the build's alone.
    const store = building === undefined ? constants : building.constants
    let byName = store.get(key)
    if (byName === undefined) store.set(key, (byName = new Map()))
    byName.set(name, 'pending')
    // A value that waited on the chain is found within the finding it kept open meanwhile, which the chain closes.
    const self: Finding = waiting ?? { at: open.length }
    let mine = evaluating.get(key)
    if (mine === undefined) evaluating.set(key, (mine = new Map()))
    mine.set(name, self)
    if (waiting === undefined) open.push(undefined)
    building?.spoiled.push(false)
    const hits: CapHit[] = []
    nesting.push(hits)
    const cuts: Cut[] = []
    cutting.push(cuts)
    const capped = new Set<AstNode>()
    collectors.push(capped)
    const read = new Set<AstNode>()
    readers.push(read)
    unsettledValues.push(unsettling() ? false : null)
    const decided = new Map<string, Decision>()
    deciding.push(decided)
    // A memoized value counts its own hits once, however it came to be evaluated.
    const wasQuiet = quiet
    const wasImmediate = immediate
    quiet = 0
    immediate = 0
    try {
      const found = pending.compute()
      noted(found)
      const result: Declared = {
        values: union(found.values),
        node: found.node,
        ...(found.presence === undefined ? {} : { presence: found.presence }),
        ...(capped.size === 0 ? {} : { capped: [...capped] }),
        ...(read.size === 0 ? {} : { reads: [...read] }),
        ...(decided.size === 0 ? {} : { decided: [...decided.values()] }),
      }
      if (unsettledValues.at(-1) === true) {
        // Kept apart, for finding where writes land only: the code's own evaluation finds it again, settling what it can.
        // Its hits are the code's only when that evaluation makes them.
        byName.delete(name)
        byName.set(`${name}${unsettled}`, result)
        return result
      }
      const root = open.at(-1)
      if (root !== undefined) {
        // Found while a write's instances it read were being found: found again once they are.
        byName.delete(name)
        const constants = provisionalOf(root).constants
        let own = constants.get(key)
        if (own === undefined) constants.set(key, (own = new Map()))
        own.set(name, result)
        return result
      }
      if (building !== undefined && building.spoiled.at(-1) !== true) {
        byName.delete(name)
        let own = constants.get(key)
        if (own === undefined) constants.set(key, (own = new Map()))
        own.set(name, result)
      } else byName.set(name, result)
      if (building === undefined || building.spoiled.at(-1) !== true) {
        for (const { name: cap, node } of hits) context.cap(cap, node)
        for (const { site, why } of cuts) context.budget(site, why)
      }
      return result
    } catch (error) {
      if (error instanceof Needed) error.waiting.unshift(pending)
      throw error
    } finally {
      if (waiting === undefined) {
        closeOpen()
        mine.delete(name)
        provisional.delete(self)
      }
      building?.spoiled.pop()
      quiet = wasQuiet
      immediate = wasImmediate
      nesting.pop()
      cutting.pop()
      collectors.pop()
      readers.pop()
      unsettledValues.pop()
      deciding.pop()
    }
  }

  /**
   * What `pattern` binds `name` to when it destructures `source`, evaluated at `at`: an expression, a value that is
   * plainly `undefined` (`absent`), one the syntax doesn't show (`unknown`), or the values a member read gives (`read`).
   * Undefined when the pattern doesn't bind `name`.
   */
  function destructured(pattern: AstNode, source: Source, name: string, at: Position = nowhere): Declared | undefined {
    switch (pattern.type) {
      case 'Identifier':
        return pattern['name'] === name ? sourceValues(source, pattern, at) : undefined
      case 'AssignmentPattern': {
        const left = pattern['left'] as AstNode
        const fallback = pattern['right'] as AstNode
        if (!boundNames(left).includes(name)) return undefined
        // The default applies when the value is undefined.
        const given = sourceValues(source, pattern, at).values
        if (!given.some(maybeUndefined)) return destructured(left, source, name, at)
        if (given.every(isUndefined)) return destructured(left, fallback, name, at)
        if (left.type !== 'Identifier') return destructured(left, 'unknown', name, at)
        const values = [...given.filter((value) => !isUndefined(value)), ...evaluate(fallback, at)]
        return { values: union(values), node: pattern }
      }
      case 'ArrayPattern': {
        const elements = pattern['elements'] as (AstNode | null)[]
        const index = elements.findIndex((element) => element !== null && boundNames(element).includes(name))
        if (index < 0) return undefined
        const element = elements[index]!
        if (element.type === 'RestElement') return destructured(element['argument'] as AstNode, 'unknown', name, at)
        return destructured(element, elementOf(source, index), name, at)
      }
      case 'ObjectPattern':
        for (const property of pattern['properties'] as AstNode[]) {
          if (property.type === 'RestElement') {
            if (boundNames(property).includes(name)) return destructured(property['argument'] as AstNode, 'unknown', name, at)
            continue
          }
          const value = property['value'] as AstNode
          if (!boundNames(value).includes(name)) continue
          const key = propertyKey(property)
          return destructured(value, key === undefined ? 'unknown' : propertyOf(source, key, property, at), name, at)
        }
        return undefined
      default:
        return undefined
    }
  }

  function sourceValues(source: Source, pattern: AstNode, at: Position): Declared {
    if (source === 'absent') return { values: [constant(undefined)], node: pattern }
    if (source === 'unknown') return { values: [unknown], node: pattern }
    if (isRead(source)) return { values: source.read, node: source.node }
    return { values: evaluate(source, at), node: source }
  }

  /**
   * The element at `index` of an array literal: absent past its end or at a hole, and unknown after a spread, or when
   * the source isn't an array literal.
   */
  function elementOf(source: Source, index: number): Source {
    if (source !== 'absent' && source !== 'unknown' && isRead(source)) {
      if (source.parts === undefined) return 'unknown'
      const part = source.parts[index]
      return part === undefined ? 'absent' : elementSource(part, source.node)
    }
    if (source === 'absent' || source === 'unknown' || isRead(source) || source.type !== 'ArrayExpression') return 'unknown'
    const elements = source['elements'] as (AstNode | null)[]
    if (elements.slice(0, index + 1).some((element) => element?.type === 'SpreadElement')) return 'unknown'
    return elements[index] ?? 'absent'
  }

  /**
   * The own property `key` of an object literal: its last definition, unknown after a spread, a key that doesn't fold
   * or a getter, and absent when the literal doesn't define it and no object inherits it (`toString`). Of any other
   * source, the member `key` read from each value it can have, as `source.key` reads it, at the pattern's `property`
   * (`const { prototype: p } = XMLHttpRequest`).
   */
  function propertyOf(source: Source, key: Key, property: AstNode, at: Position): Source {
    if (source === 'absent' || source === 'unknown') return 'unknown'
    if (isRead(source)) return { read: memberOf(source.read, key, property, source.node, at), node: property }
    if (source.type !== 'ObjectExpression') {
      return { read: memberOf(evaluate(source, at), key, property, source, at), node: property }
    }
    const properties = source['properties'] as AstNode[]
    let prototype = false
    for (const defining of properties.toReversed()) {
      if (defining.type !== 'Property') return 'unknown'
      const defined = propertyKey(defining)
      if (defined === undefined) return 'unknown'
      if (typeof defined === 'string' && setsLiteralPrototype(defining, defined)) {
        prototype = true
        continue
      }
      if (defined !== key) continue
      return defining['kind'] === 'init' ? (defining['value'] as AstNode) : 'unknown'
    }
    const inherited = prototype || key === '__proto__' || Object.hasOwn(targets, memberName('Object.prototype', key))
    return inherited ? 'unknown' : 'absent'
  }

  /**
   * The member `key` of `values`, read by the destructuring pattern's `property` from `object`, as a member expression
   * reads it: the node that reads it is the pattern's property (§14).
   */
  function memberOf(values: Value[], key: Key, property: AstNode, object: AstNode, at: Position): Value[] {
    if (typeof key === 'symbol') return [unknown]
    let read = patternReads.get(property)
    if (read === undefined) {
      read = { type: 'MemberExpression', object, property: property['key'], computed: false, start: property.start, end: property.end }
      patternReads.set(property, read)
    }
    return namedRead(read, key, at, () => values)
  }

  /**
   * A property's key in an object literal or pattern: a name, a literal, or a computed key that folds to a constant, as
   * ToPropertyKey converts it.
   */
  function propertyKey(property: AstNode): Key | undefined {
    const key = property['key'] as AstNode
    if (property['computed'] !== true) {
      if (key.type === 'Identifier') return key['name'] as string
      return literalKey(key)
    }
    const values = evaluate(key, nowhere)
    const [only] = values
    return values.length === 1 && only?.kind === 'constant' ? toPropertyKey(only.value) : undefined
  }

  /** `object` when it is this window's `document`, whose `defaultView` is this window (§3, §5 Other windows). */
  function ownDocument(object: AstNode, at: Position): HolderValue | undefined {
    if (object.type === 'Super') return undefined
    const values = evaluate(object, at)
    const [only] = values
    const document = values.length === 1 && only?.kind === 'holder' && only.holder === 'document' ? only : undefined
    return document !== undefined && windowOf(document.leaves) === thisWindow ? document : undefined
  }

  /**
   * The window expression of `defaultView` or `contentWindow` read from `object` (§3), other than this window's
   * `document.defaultView`: that of the object's expression.
   */
  function anyObjectWindow(object: AstNode, key: string, at: Position): string | undefined {
    if (object.type === 'Super') return undefined
    const reached = expressionKey(object, at)
    return reached === undefined ? undefined : `(${reached}).${key}`
  }

  /** An index's part of a child window's expression: the index itself when it is a constant, else its expression's. */
  function indexKey(property: AstNode, values: readonly Value[], at: Position): string | undefined {
    const [only] = values
    if (values.length !== 1 || only === undefined) return undefined
    return only.kind === 'constant' ? String(only.value) : expressionKey(property, at)
  }

  /**
   * A key for what an expression denotes, that two evaluations of the same expression share: a constant, a native
   * holder under its window expression, or a name, a `this` and the member reads on them. An expression that makes a
   * value (a literal object, a call) has none.
   */
  function expressionKey(node: AstNode, at: Position): string | undefined {
    const values = evaluate(node, at)
    const [only] = values
    if (values.length !== 1 || only === undefined) return undefined
    switch (only.kind) {
      case 'constant':
        return `${typeof only.value}:${String(only.value)}`
      case 'holder': {
        const window = windowOf(only.leaves)
        return window === undefined || only.holder === global ? window : `${window}/${only.holder}`
      }
      case 'object':
      case 'native':
        return undefined
      case 'unknown':
      case 'member':
        break
    }
    switch (node.type) {
      case 'Identifier':
        return `${variable}${node['name'] as string}`
      case 'ThisExpression':
        return `${variable}this`
      case 'ChainExpression':
        return expressionKey(node['expression'] as AstNode, at)
      case 'MemberExpression': {
        const object = node['object'] as AstNode
        const property = node['property'] as AstNode
        if (object.type === 'Super') return undefined
        const base = expressionKey(object, at)
        if (base === undefined) return undefined
        if (node['computed'] === true) {
          const key = expressionKey(property, at)
          return key === undefined ? undefined : `${base}[${key}]`
        }
        return `${base}.${property.type === 'PrivateIdentifier' ? '#' : ''}${property['name'] as string}`
      }
      default:
        return undefined
    }
  }

  const isWindow = (value: Value): value is HolderValue => value.kind === 'holder' && value.holder === global

  /** The native function whose aliases are followed that `holder.key` is in the unmutated catalog, if it is one. */
  function nativeMember(holder: string, key: string): NativeName | undefined {
    // `hasOwnProperty` is inherited from `Object.prototype` by every holder whose chain reaches it (§4).
    if (key === 'hasOwnProperty') {
      return firstOwner(holder, key) === 'Object.prototype' ? 'Object.prototype.hasOwnProperty' : undefined
    }
    const name = holder === global ? key : `${holder}.${key}`
    const listed = holder === global ? compilerNames.has(key) : memberNatives.has(name)
    if (!listed) return undefined
    for (let at: string | null = holder; at !== null; at = Object.hasOwn(holders, at) ? holders[at]!.proto : null) {
      if (Object.hasOwn(targets, memberName(at, key))) return name as NativeName
    }
    return undefined
  }

  /**
   * The catalog function `holder.key` reads in the unmutated catalog (§5 Resolver capabilities 10): the first target of
   * that member up the holder's chain, when it is a data property holding a function that is no holder.
   */
  function functionTarget(holder: string, key: string): string | undefined {
    for (let at: string | null = holder; at !== null; at = Object.hasOwn(holders, at) ? holders[at]!.proto : null) {
      const name = memberName(at, key)
      if (!Object.hasOwn(targets, name)) continue
      const { descriptor, kind, holds } = targets[name]!
      return descriptor.type === 'data' && holds === undefined && (kind === 'function' || kind === 'operation') ? name : undefined
    }
    return undefined
  }

  /** The first holder on `holder`'s chain in the unmutated catalog that owns `key`, if one does. */
  function firstOwner(holder: string, key: Key): string | undefined {
    for (let at: string | null = holder; at !== null; at = Object.hasOwn(holders, at) ? holders[at]!.proto : null) {
      if (Object.hasOwn(targets, memberName(at, key))) return at
    }
    return undefined
  }

  function memberHolder(name: string, key: string): string | undefined {
    if (name === global && globalNames.has(key)) return global
    // A constructor's `prototype` is a target that holds its prototype object, as a Web IDL interface object's is
    // (`Window.Window.prototype` holds `Window.prototype`, `Image.prototype` holds `HTMLImageElement.prototype`, §4).
    return holdsAt(name, key)
  }

  /** The position inside a branch taken when `test` is `outcome`: with the names its `typeof` tests show defined. */
  function guarded(at: Position, test: AstNode, outcome: boolean): Position {
    const guards = definedWhen(test, outcome)
    if (guards.size === 0) return at
    return { guard: (name) => guards.get(name) ?? at.guard(name), topLevel: at.topLevel, frame: at.frame }
  }

  /**
   * The free names that `test` being `outcome` shows are defined: those of a `typeof name` comparison with a constant
   * string that would come out the other way for `"undefined"`, in any spelling (`typeof x !== "undefined"`,
   * `"undefined" != typeof x`, `typeof x < "u"`, `"object" == typeof x`), through `!`, `&&` and `||`.
   */
  function definedWhen(test: AstNode, outcome: boolean): Guards {
    switch (test.type) {
      case 'UnaryExpression':
        return test['operator'] === '!' ? definedWhen(test['argument'] as AstNode, !outcome) : none
      case 'SequenceExpression':
        return definedWhen((test['expressions'] as AstNode[]).at(-1)!, outcome)
      case 'LogicalExpression': {
        const left = definedWhen(test['left'] as AstNode, outcome)
        const right = definedWhen(test['right'] as AstNode, outcome)
        // `a && b` is true only when both are, and `a || b` is false only when both are. Otherwise either may have
        // decided it, so only what both show holds.
        const both = test['operator'] === '&&' ? outcome : test['operator'] === '||' ? !outcome : undefined
        if (both === undefined) return none
        return both ? new Map([...right, ...left]) : new Map([...left].filter(([name]) => right.has(name)))
      }
      case 'BinaryExpression': {
        const operator = test['operator'] as string
        if (!comparisons.has(operator)) return none
        const left = test['left'] as AstNode
        const right = test['right'] as AstNode
        const name = typeofOperand(left) ?? typeofOperand(right)
        const other = typeofOperand(left) === undefined ? left : right
        const string = constantString(other)
        if (name === undefined || string === undefined) return none
        const [a, b] = other === right ? ['undefined', string] : [string, 'undefined']
        const whenUndefined = compared(operator, constant(a), constant(b), [])
        return whenUndefined.kind === 'constant' && whenUndefined.value !== outcome ? new Map([[name, test]]) : none
      }
      default:
        return none
    }
  }

  /** `name` for `typeof name` of a free name with no declaration. */
  function typeofOperand(node: AstNode): string | undefined {
    if (node.type !== 'UnaryExpression' || node['operator'] !== 'typeof') return undefined
    const argument = node['argument'] as AstNode
    if (argument.type !== 'Identifier') return undefined
    const binding = free(argument)
    return binding === undefined || binding.declaration !== undefined ? undefined : (argument['name'] as string)
  }

  /** The member expressions that stand for a destructuring pattern's properties when they read a member. */
  const patternReads = new Map<AstNode, AstNode>()

  /**
   * The values each `const` declarator and each definition's site gives each name it binds, or `pending` while they are
   * being found.
   */
  const constants = new Map<AstNode, Map<string, Declared | 'pending'>>()

  /**
   * The constants being evaluated, one within another, each with the caps its own evaluation has hit so far. They
   * count only once it has its values: an evaluation that stops is done again.
   */
  let nesting: CapHit[][] = []
  /**
   * The calls each constant being evaluated while the dynamic-call index is built cut while carrying a native, beside
   * its `nesting` hits: a value that stays the code's raises them once it has its values, as it counts its hits.
   */
  let cutting: Cut[][] = []

  /**
   * A finding that what is found within it may read before it is done: a write's instances, or the objects it writes
   * through. Read while it is being found, it gives nothing, so whatever is found within it meanwhile is provisional.
   */
  interface Finding {
    /** Its place in `open`, while it is being found. */
    at: number
  }

  /**
   * The memoized values and write findings being found, one within another, innermost last, each marked with the
   * outermost finding it read before that was done: it is kept only until that one is (`provisional`).
   */
  const open: (Finding | undefined)[] = []

  /** The memoized values being found, by key and name, each with its finding. */
  const evaluating = new Map<AstNode, Map<string, Finding>>()

  /** What was found while a finding it read was being found, by that finding: dropped once it is done. */
  const provisional = new Map<Finding, Provisional>()

  /** What was found while one finding was being found. */
  interface Provisional {
    constants: Map<AstNode, Map<string, Declared>>
    instances: Map<FieldWrite, WriteInstance[]>
    places: Map<FieldWrite, WriteInstance[]>
    frames: { deep: Map<AstNode, Frame[]>; shallow: Map<AstNode, Frame[]> }
    written: Map<string, boolean>
    /** The instance index, and the round of building the dynamic-call index it was found in, if any. */
    index?: { building: typeof building; instances: Instances }
  }

  /**
   * Marks every finding opened after `finding` as provisional on it, or on an outer one it already is. Only the innermost
   * is marked at once: each passes its mark on to the one it was opened within when it closes (`closeOpen`), so a mark
   * costs the same however deep the findings are (§18 step 1).
   */
  function cutShort(finding: Finding): void {
    const top = open.length - 1
    if (top <= finding.at) return
    const root = open[top]
    if (root === undefined || root.at > finding.at) open[top] = finding
  }

  /** Closes the innermost finding, passing its mark on to the one it was opened within when that is after the mark. */
  function closeOpen(): void {
    const root = open.pop()
    const top = open.length - 1
    if (root === undefined || top <= root.at) return
    const below = open[top]
    if (below === undefined || below.at > root.at) open[top] = root
  }

  /** A provisional value memoized while a finding it read was being found, which makes its reader provisional too. */
  function provisionalValue(key: AstNode, name: string): Declared | undefined {
    for (const [root, found] of provisional) {
      const value = found.constants.get(key)?.get(name)
      if (value === undefined) continue
      cutShort(root)
      return value
    }
    return undefined
  }

  /** Runs a finding: provisional on whatever it read before that was done, and given to `keep` otherwise. */
  function finding<K, T>(
    being: Map<K, Finding>,
    write: K,
    kept: (found: Provisional) => Map<K, T>,
    keep: (found: T) => void,
    find: () => T,
    none: T,
  ): T {
    const outer = being.get(write)
    if (outer !== undefined) {
      // Frames asked for while they are being found (`frameless`).
      if (being === framing.deep || being === framing.shallow) for (const each of reentries) each.add(write as AstNode)
      cutShort(outer)
      return none
    }
    for (const [root, found] of provisional) {
      const value = kept(found).get(write)
      if (value === undefined) continue
      cutShort(root)
      return value
    }
    const self: Finding = { at: open.length }
    being.set(write, self)
    open.push(undefined)
    try {
      const found = find()
      const root = open.at(-1)
      if (root === undefined) keep(found)
      else kept(provisionalOf(root)).set(write, found)
      return found
    } finally {
      closeOpen()
      being.delete(write)
      provisional.delete(self)
    }
  }

  /** Keeps a provisional finding until the finding it depends on is done. */
  function provisionalOf(root: Finding): Provisional {
    let found = provisional.get(root)
    if (found === undefined) provisional.set(root, (found = { constants: new Map(), instances: new Map(), places: new Map(), frames: { deep: new Map(), shallow: new Map() }, written: new Map() }))
    return found
  }

  /**
   * The folds that passed the `fold-length` cap in each evaluation being tracked, innermost last: each `tracked` run's,
   * and each constant's while it is evaluated.
   */
  const collectors: Set<AstNode>[] = []

  /**
   * The functions whose parameters each evaluation being tracked read with no frame to bind them, innermost last: each
   * `contextual` run's, and each memoized value's while it is evaluated.
   */
  const readers: Set<AstNode>[] = []

  /**
   * How deep the heap is in evaluations it makes only to find where fields are written. The caps they hit are not
   * counted, since the walk counts those of the code it analyzes, though a fold too long still reaches `tracked`.
   */
  let quiet = 0
  /** How deep the evaluation is in finding frames, whose cap hits count at once (`framesOf`). */
  let immediate = 0
  function quietly<T>(run: () => T): T {
    quiet++
    try {
      return run()
    } finally {
      quiet--
    }
  }

  /** Passes on what finding a memoized value met: the folds that passed the `fold-length` cap, and unbound parameters. */
  function noted(found: Declared): void {
    if (found.capped !== undefined) for (const fold of found.capped) collectors.at(-1)?.add(fold)
    if (found.reads !== undefined) for (const fn of found.reads) readers.at(-1)?.add(fn)
  }

  /**
   * The value of a sum, template or comparison of more combinations of its operands' alternatives than
   * `maxAlternatives`: unknown, which is a cap hit. Its alternatives would all be constants, never native holders.
   */
  function tooMany(node: AstNode): Value[] {
    hit('alternatives', node)
    return [unknown]
  }

  /** Counts a cap hit, or holds it until the constant being evaluated has its values. */
  function hit(name: CapHit['name'], node: AstNode): void {
    if (name === 'fold-length') collectors.at(-1)?.add(node)
    // What the heap evaluates only to find where a field is written is no hit of the code's own (`quietly`).
    if (quiet > 0) return
    const hits = nesting.at(-1)
    // Frames are found once, whatever evaluation first asks for them, so their hits count at once. While the dynamic-call
    // index is built, only a memoized value that stays the code's counts its hits: the rest is evaluated again.
    if (hits === undefined || immediate > 0) {
      if (building === undefined) context.cap(name, node)
    }
    else hits.push({ name, node })
  }

  /**
   * A call's value: `Function('return this')()`'s global object, or what the functions it calls return, each in the
   * frame of this call (§5 Resolver capabilities 3), after the call's `call` step. Unknown when the callee may be
   * anything else too.
   */
  function summarized(call: AstNode, at: Position): Value[] {
    const global = functionReturnThis(call, at)
    if (global !== undefined) return [global]
    const sites = calls.sitesOf(call)
    // A call the syntax names no function for gives what its callee's values return where the artifact links modules
    // (§6), whose exports are all read so: `(0, o.H7)(…)`, `n(8104)` in a factory, and a call of a module's lazy thunk or
    // memoized getter, or an interop wrapper's over one: `require_x()`. So does the call of a callback a function is
    // given (§5 Resolver capabilities 3, callback invocation): a factory a helper is passed, `patchMethod(o, k, d =>
    // function(){ … })` calling `patchFn(delegate, …)`. Any other such call stays unknown, which keeps
    // the cost and the merged contexts of following every computed call (`n[e]()`) out of the analysis.
    const followed = linking || context.links.idioms.size > 0 || callsParameter(call)
    if (sites.length === 0 && (!followed || !calls.open(call))) return [unknown]
    // A call the syntax names no function for is found once per frame: a chain of them (`f.bind(a).bind(b)…`) reads
    // each callee's object in several ways, which would otherwise multiply along the chain.
    if (sites.length === 0) {
      const found = memoized({
        key: call,
        name: `dynamic@${at.frame?.id ?? ''}`,
        fallback: call,
        compute: () => ({ values: calledValues(call, sites, at), node: call }),
      })
      noted(found)
      return found.values
    }
    return calledValues(call, sites, at)
  }

  /** Whether a call's callee is a parameter of the function around it, read by name: a callback it was given. */
  function callsParameter(call: AstNode): boolean {
    const callee = call['callee'] as AstNode
    if (callee.type !== 'Identifier') return false
    const key = definitions.keyOf(callee)
    if (key === undefined || key.scope === 'global' || !isFunction(key.scope)) return false
    return (key.scope['params'] as AstNode[]).flatMap(boundNames).includes(key.name)
  }

  /** What the functions a call calls return (`summarized`). */
  function calledValues(call: AstNode, sites: readonly CallSite[], at: Position): Value[] {
    const values: Value[] = []
    // A require call that links a module runs it the same wherever it is: its only argument is the module's constant
    // id (§6). So it runs in its module's one frame (`moduleFrame`), and a module's requires of other modules never
    // recurse. What it returns came through the module link, whose fold stands for the call's.
    const link = context.links.links.get(call)
    const caller = link === undefined ? at.frame : undefined
    // A call of a module's thunk or memoized getter, or of an interop wrapper over one, is a module-link hop after the
    // call (§6).
    const hop = context.links.moduleCalls.get(call)
    const linked = (value: Value, fold: Fold) =>
      link !== undefined
        ? withFolds(value, [{ node: call, name: 'module-link', value: undefined, link }])
        : hop !== undefined
          ? withFolds(value, [fold, { node: call, name: 'module-link', value: undefined, link: hop }])
          : withFolds(value, [fold])
    for (const site of sites) {
      const frame = instantiated(site, caller)
      const found = memoized({
        key: site.fn,
        name: `return@${frame.id}`,
        fallback: call,
        compute: () => ({ values: returnValues(site.fn, frame), node: call }),
      })
      noted(found)
      const fold = callFold({ site, caller })
      for (const value of found.values) values.push(linked(value, fold))
    }
    if (calls.open(call)) {
      // A callee the syntax doesn't name: the functions its values are (§5 Resolver capabilities 3).
      const dynamic = dynamicTargets(call, at)
      for (const target of dynamic.targets) {
        const frame = targetFrame(target, caller)
        if (frame === undefined) {
          values.push(unknown)
          continue
        }
        const found = memoized({
          key: target.site.fn,
          name: `return@${frame.id}`,
          fallback: call,
          compute: () => ({ values: returnValues(target.site.fn, frame), node: call }),
        })
        noted(found)
        const fold = callFold(frame.bindings[0]!)
        for (const value of found.values) values.push(linked(value, fold))
      }
      if (dynamic.open || dynamic.targets.length === 0) values.push(unknown)
    }
    return union(values)
  }

  /** Each linked module's call site of the require function, which every require call of the module runs as. */
  const moduleSites = new Map<string, CallSite>()

  /**
   * The frame a require call that links a module runs in (§6): its module's one frame of the require, whoever requires
   * it (`requireFrame`), so each module's factory runs once. Undefined for any other call.
   */
  function moduleFrame(site: CallSite): Frame | undefined {
    const link = context.links.links.get(site.call)
    return link === undefined ? undefined : requireFrame(link.module, site.fn)
  }

  /**
   * The one frame the require function `fn` runs `module` in: at the module's first require call, with no caller, and
   * closing over the one frame of the code around the require, when it has one (webpack 4's IIFE over its table).
   */
  function requireFrame(module: string, fn: AstNode): Frame {
    const owner = lexicalOwner(fn)
    const closures = owner === undefined ? [] : framesOf(owner)
    return callFrame(requireSite(module, fn), undefined, closures.length === 1 ? closures[0] : undefined)
  }

  /** Whether a frame is a require function's one frame of a module it links (`requireFrame`) (§6). */
  function isRequireFrame(frame: Frame): boolean {
    const binding = frame.bindings.length === 1 ? frame.bindings[0] : undefined
    if (frame.how !== 'call' || binding === undefined || binding.caller !== undefined) return false
    const link = context.links.links.get(binding.site.call)
    return link !== undefined && context.links.firsts.get(frame.fn)?.get(link.module) === binding.site.call
  }

  /** The call site every require of `module` by the require function `fn` runs as: the module's first require call. */
  function requireSite(module: string, fn: AstNode): CallSite {
    const key = `${module}:${fn.start}`
    let found = moduleSites.get(key)
    if (found === undefined) {
      const call = context.links.firsts.get(fn)!.get(module)!
      const info = calls.infoOf(call)!
      const args = call['arguments'] as AstNode[]
      found = { call, fn, args, topLevel: info.topLevel, guards: info.guards, within: info.within, contexts: info.contexts }
      moduleSites.set(key, found)
    }
    return found
  }

  /**
   * The frame a linked module's factory runs in (§6): its one require's frame runs the table call, whatever requires
   * it, so it is found from the table, never waiting on the dynamic-call index, however deep the module is required.
   * Undefined for a factory no require call links.
   */
  function factoryFrames(fn: AstNode): Frame[] | undefined {
    const factory = context.links.factories.get(fn)
    if (factory === undefined || !context.links.firsts.get(factory.require)?.has(factory.module)) return undefined
    const caller = requireFrame(factory.module, factory.require)
    const info = calls.infoOf(factory.call)!
    const at: Position = { guard: (name) => info.guards.get(name), topLevel: info.topLevel, frame: caller }
    const { targets } = dynamicTargets(factory.call, at)
    return targets.filter((target) => target.site.fn === fn).map((target) => instance(target, caller))
  }

  /**
   * A lazy module thunk's module (§6) whose thunk variable is defined once, by a call of a thunk maker with its factory
   * (`var x = maker(factory)`).
   */
  interface ThunkModule {
    /** The thunk's variable (`thunkVariable`). */
    variable: string
    /** The thunk maker's call that makes the module (`maker(factory)`). */
    make: AstNode
    maker: AstNode
    thunk: AstNode
    /** The thunk's call of its factory. */
    call: AstNode
    factory: AstNode
  }

  /** The lazy module thunks' modules, by each function they give frames for: their thunks and factories. Found once. */
  let thunkModules: Map<AstNode, ThunkModule[]> | undefined

  /** The frames of each lazy module thunk's module, by its variable, found once; while the index is built, the build's. */
  const codeThunkFrames = new Map<string, { thunk: Frame; factory: Frame[] } | null>()

  /**
   * The frames a lazy module thunk runs in, one per module, or the one frame its module's factory runs in (§6): found
   * from the module links, as a linked factory's are (`factoryFrames`), never waiting on the dynamic-call index,
   * however deep the module is required. Undefined for any other function, or a module whose maker's call runs in
   * other than one frame.
   */
  function thunkModuleFrames(fn: AstNode): Frame[] | undefined {
    if (context.links.factoryCalls.size === 0) return undefined
    const modules = (thunkModules ??= findThunkModules()).get(fn)
    if (modules === undefined) return undefined
    const frames: Frame[] = []
    for (const module of modules) {
      const found = moduleFramesOf(module)
      if (found === null) return undefined
      frames.push(...(module.thunk === fn ? [found.thunk] : found.factory))
    }
    return framesInDocumentOrder(frames)
  }

  /** A lazy module thunk's module's frames (`thunkModuleFrames`), or null when its maker's call runs in other than one. */
  function moduleFramesOf(module: ThunkModule): { thunk: Frame; factory: Frame[] } | null {
    const all = building === undefined ? codeThunkFrames : (building.thunkFrames ??= new Map())
    const known = all.get(module.variable)
    if (known !== undefined) return known
    // Found while it is being found, it is none.
    all.set(module.variable, null)
    const makers = framesOf(module.maker).filter((frame) => frame.bindings.some((binding) => binding.site.call === module.make))
    let found: { thunk: Frame; factory: Frame[] } | null = null
    if (makers.length === 1) {
      const first = firstThunkCalls().get(module.variable)!
      const thunk = callFrame(dynamicSite(first, module.thunk, 'plain', [], 'none'), undefined, makers[0])
      const info = calls.infoOf(module.call)!
      const at: Position = { guard: (name) => info.guards.get(name), topLevel: info.topLevel, frame: thunk }
      const { targets } = dynamicTargets(module.call, at)
      const factory = targets.filter((target) => target.site.fn === module.factory).map((target) => instance(target, thunk))
      found = { thunk, factory }
    }
    all.set(module.variable, found)
    return found
  }

  /**
   * The calls of a thunk maker set on an object (`R.cw(factory)`, §6), which the module links name as the syntax names
   * a function's calls, by maker, found once: each runs in a frame of the code it is in, as a named call does, with no
   * round of the dynamic-call index.
   */
  let linkedMakes: Map<AstNode, CallSite[]> | undefined
  function makeSites(fn: AstNode): readonly CallSite[] {
    if (linkedMakes === undefined) {
      linkedMakes = new Map()
      for (const [make, maker] of context.links.makes) {
        if (calls.sitesOf(make).some((site) => site.fn === maker)) continue
        const info = calls.infoOf(make)!
        const callee = calleeExpression(make['callee'] as AstNode)
        const site: CallSite = {
          call: make,
          fn: maker,
          args: make['arguments'] as AstNode[],
          topLevel: info.topLevel,
          guards: info.guards,
          within: info.within,
          contexts: info.contexts,
          receiver: callee['object'] as AstNode,
        }
        const list = linkedMakes.get(maker)
        if (list === undefined) linkedMakes.set(maker, [site])
        else list.push(site)
      }
    }
    return linkedMakes.get(fn) ?? []
  }

  /** Whether the dynamic-call index found a frame for a thunk maker's call the module links name (`makeSites`). */
  const madeByLink = (frame: Frame): boolean =>
    frame.bindings.some((binding) => makeSites(frame.fn).some((site) => site.call === binding.site.call))

  /** The lazy module thunks' modules (`ThunkModule`), by each of their thunks and factories. */
  function findThunkModules(): Map<AstNode, ThunkModule[]> {
    const found = new Map<AstNode, ThunkModule[]>()
    const makers = new Map<AstNode, { thunk: AstNode; call: AstNode }>()
    for (const { call, thunk, maker } of thunkOwners()) if (maker !== undefined) makers.set(maker, { thunk, call })
    for (const [variable, first] of firstThunkCalls()) {
      const key = definitions.keyOf(calleeExpression(first['callee'] as AstNode))
      const defined = key === undefined ? [] : definitions.of(key)
      const make = defined.length === 1 ? defined[0]!.source : undefined
      if (make?.type !== 'CallExpression') continue
      const factory = (make['arguments'] as AstNode[])[0]
      // A maker set on an object (`R.cw(factory)`) is no call the syntax names: the module links name it.
      const linked = context.links.makes.get(make)
      const sites = calls.sitesOf(make).filter((site) => makers.has(site.fn))
      const maker = sites.length === 1 ? sites[0]!.fn : sites.length === 0 && linked !== undefined && makers.has(linked) ? linked : undefined
      if (factory === undefined || !isFunction(factory) || maker === undefined) continue
      const module: ThunkModule = { variable, make, maker, factory, ...makers.get(maker)! }
      for (const fn of [module.thunk, factory]) {
        const list = found.get(fn)
        if (list === undefined) found.set(fn, [module])
        else list.push(module)
      }
    }
    return found
  }

  /** The resolved calls of a function, with their callers' frames when the resolver has them (`callersOf` above). */
  function callersOf(fn: AstNode): Binding[] {
    buildIndex()
    // Once the index is built, a function's resolved calls are fixed: they are found once (§18 step 1).
    if (dynamicIndex === undefined || indexing !== undefined) return callersFound(fn)
    let found = knownCallers.get(fn)
    if (found === undefined) knownCallers.set(fn, (found = callersFound(fn)))
    return found
  }

  /** Each function's resolved calls, once the dynamic-call index is built. */
  const knownCallers = new Map<AstNode, Binding[]>()

  function callersFound(fn: AstNode): Binding[] {
    const factory = context.links.factories.get(fn)
    const requires =
      factory === undefined
        ? []
        : [...context.links.links]
            .filter(([call, link]) => link.module === factory.module && calls.sitesOf(call).some((site) => site.fn === factory.require))
            .flatMap(([call]) => calls.sitesOf(call).filter((site) => site.fn === factory.require))
    // A chunk's pushed callback starts its entry modules through the require it is given (§6 idiom 6).
    for (const [call, require] of context.links.starts) {
      if (factory === undefined || require !== factory.require || context.links.links.get(call)?.module !== factory.module) continue
      if (requires.some((site) => site.call === call)) continue
      const info = calls.infoOf(call)!
      const args = call['arguments'] as AstNode[]
      requires.push({ call, fn: require, args, topLevel: info.topLevel, guards: info.guards, within: info.within, contexts: info.contexts })
    }
    const named = [...calls.callsOf(fn), ...makeSites(fn)].map((site): Binding => ({ site, caller: undefined }))
    const dynamic = (dynamicIndex ?? new Map<AstNode, Frame[]>()).get(fn) ?? []
    const found = [...requires.map((site): Binding => ({ site, caller: undefined })), ...named]
    for (const frame of dynamic) {
      if (madeByLink(frame)) continue
      for (const binding of frame.bindings) {
        if (factory !== undefined && binding.site.call === factory.call) continue
        found.push(binding)
      }
    }
    return found
  }

  /** The `call` fold of a binding (§14): the value came through the call at its site. */
  const callFold = (binding: Binding): Fold => ({ node: binding.site.call, name: '()', value: undefined, call: binding })

  /**
   * The frame a call of a function runs in when its value is read in `caller`: the frame of that call, or, past the
   * depth cap or on a recursion, the function's widened frame (§18), which is a cap hit and raises `analysis-budget`
   * when the call carries a native (Principle 5).
   */
  function instantiated(site: CallSite, caller: Frame | undefined): Frame {
    if (!onChain(caller, site.fn)) {
      // Past the depth cap, a call that carries a native in its real caller frame keeps its frame.
      const module = moduleFrame(site)
      if (module !== undefined) return module
      if ((caller?.depth ?? 0) < maxDepth || carries({ site, caller })) return callFrame(site, caller)
    }
    hit('recursion', site.call)
    if (carries({ site, caller })) budgetCall(site.call, 'recursion')
    return widenedFrame(site.fn, calls.callsOf(site.fn))
  }

  /** What a function returns in a frame: its `return`s' values, and `undefined` when control can reach its end. */
  function returnValues(fn: AstNode, frame: Frame): Value[] {
    // An async function returns a promise, and a generator a generator object.
    if (fn['async'] === true || fn['generator'] === true) return [object]
    const exports = thunkExports(fn, frame)
    if (exports !== undefined) return exports
    const at: Position = { ...nowhere, frame }
    const body = fn['body'] as AstNode
    if (body.type !== 'BlockStatement') return evaluate(body, at)
    const values: Value[] = []
    for (const statement of returnsOf(fn)) {
      const argument = statement['argument'] as AstNode | null
      values.push(...(argument === null ? [constant(undefined)] : evaluate(argument, at)))
    }
    if (fallsThrough(body)) values.push(constant(undefined))
    return union(values)
  }

  /** The `return` statements of a function's own code, not those of the functions in it. */
  function returnsOf(fn: AstNode): AstNode[] {
    let found = returns.get(fn)
    if (found !== undefined) return found
    const list: AstNode[] = []
    walkTree(fn['body'] as AstNode, {
      enter(node) {
        if (isFunction(node) || node.type === 'ClassBody') return false
        if (node.type === 'ReturnStatement') list.push(node)
        return undefined
      },
    })
    returns.set(fn, (found = list))
    return found
  }
  const returns = new Map<AstNode, AstNode[]>()

  /**
   * The values a parameter `name` of `fn` takes in `frame`: what its pattern destructures from the argument each of the
   * frame's calls passes, evaluated in that call's own frame, each after the call's `call` fold. A missing argument is
   * `undefined`, so a default applies, and one after a spread is unknown.
   */
  function parameterValues(fn: AstNode, name: string, frame: Frame): Value[] {
    const params = fn['params'] as AstNode[]
    const index = params.findIndex((param) => boundNames(param).includes(name))
    const pattern = params[index]!
    const at: Position = { ...nowhere, frame }
    const values: Value[] = []
    for (const binding of frame.bindings) {
      const { site, caller } = binding
      const given = givens.get(binding)
      let source: Source
      if (given !== undefined) {
        const element = given[index]
        source = element === undefined ? 'absent' : elementSource(element, site.call)
      } else if (site.unlisted !== undefined && index >= site.unlisted) source = 'unknown'
      else if (index >= site.args.length) source = 'absent'
      else {
        const arg = site.args[index]!
        source = arg.type === 'SpreadElement' ? 'unknown' : { read: evaluate(arg, callerAt(site, caller)), node: arg }
      }
      const found = pattern.type === 'RestElement' ? undefined : destructured(pattern, source, name, at)
      if (found !== undefined) noted(found)
      const fold: Fold = { ...callFold(binding), argument: index }
      for (const value of found?.values ?? [unknown]) values.push(withFolds(value, [fold]))
    }
    return union(values)
  }

  /** Where a call's arguments are evaluated: at the call, in the frame of the function around it, if any. */
  const callerAt = (site: CallSite, caller: Frame | undefined): Position => ({
    guard: (name) => site.guards.get(name),
    topLevel: site.topLevel,
    frame: caller,
  })

  /** The argument values a call passes, evaluated in its caller's frame, up to the first it can't list. */
  function argumentValues({ site, caller }: Binding): Value[][] {
    const listed = site.unlisted === undefined ? site.args : site.args.slice(0, site.unlisted)
    return listed.map((arg) => (arg.type === 'SpreadElement' ? [unknown] : evaluate(arg, callerAt(site, caller))))
  }

  /**
   * Whether a call carries the global object, a native holder or a native member (Principle 5): it passes the global
   * object, a native holder or a native function. A string that names a catalog member carries it only when the same
   * call also passes a native holder whose chain has that member, and such a call carries a native through the holder
   * already, so a string never decides it.
   */
  function carries(binding: Binding): boolean {
    // A catalog function read from a native holder (`MemberValue`) is a native function too.
    const carried = (value: Value) => value.kind === 'holder' || value.kind === 'native' || value.kind === 'member'
    // An iteration native's callback is passed the element it visits (§5 Resolver capabilities 4).
    const given = givens.get(binding)
    if (given !== undefined) {
      return given.some((element) => element.values.some(carried))
    }
    return argumentValues(binding).some((values) => values.some(carried))
  }

  function argumentCarries(binding: Binding, index: number, key: Key, member: readonly Fold[]): boolean {
    const { site, caller } = binding
    const arg = binding.element === undefined ? site.args[index] : undefined
    if (arg === undefined || arg.type === 'SpreadElement') return false
    const at = callerAt(site, caller)
    const values = evaluate(arg, at)
    const isKey = (value: Value) => value.kind === 'constant' && toPropertyKey(value.value) === key
    if (values.some(isKey)) return true
    const holds = (elements: readonly Element[]): boolean =>
      elements.some((element) => element.values.some(isKey) || (element.parts !== undefined && holds(element.parts)))
    if (collectionsOf(arg, at)?.some(({ elements }) => holds(elements))) return true
    // An object argument carries the values its heap fields hold, at any depth: the member was read out of the
    // heap after it came in through the argument.
    if (values.some(isHeap) && member.some((fold) => fold.heap === true)) return true
    const split = member.some((fold) => splits(fold.node) && fold.value === key)
    const holdsKey = (value: Value) =>
      value.kind === 'constant' && typeof value.value === 'string' && typeof key === 'string' && value.value.includes(key)
    if (split && values.some(holdsKey)) return true
    // An argument that carries part of a folded key carries the member: the key concatenates a string the
    // argument passes with literals (`o['set' + n]`).
    const folded = member.some((fold) => concatenates(fold.node) && fold.value === key)
    return folded && typeof key === 'string' && values.some((value) => isPart(value, key))
  }

  /** Runs `run`, with the functions whose parameters it read with no frame (`GlobalResolution.contextual`). */
  function contextual<T>(run: () => T): { value: T; functions: ReadonlySet<AstNode> } {
    const read = new Set<AstNode>()
    readers.push(read)
    try {
      return { value: run(), functions: read }
    } finally {
      readers.pop()
    }
  }

  /**
   * The frames of each function or loop for the writes in it, found once: `deep` ones, whose iterations and callbacks
   * run within the frames of the code around them, and the others, which do only when their heads read that code.
   */
  const codeFrames = { deep: new Map<AstNode, Frame[]>(), shallow: new Map<AstNode, Frame[]>() }

  /** The contexts whose frames are being found, whose frames a context inside them can't wait for. */
  const framing = { deep: new Map<AstNode, Finding>(), shallow: new Map<AstNode, Finding>() }

  /**
   * The frames of a function or loop. `deep` asks that a loop's iterations, and an iteration native's callbacks, run
   * within the frames of the code around them, because what is evaluated in them reads that code's parameters.
   */
  function framesOf(context: AstNode, deep = false): Frame[] {
    const kind = deep ? 'deep' : 'shallow'
    // A function's frames depend on the dynamic-call index, so while it is built they are the build's alone.
    spoiled()
    const frames = building === undefined ? codeFrames : building.frames
    const known = frames[kind].get(context)
    if (known !== undefined) return known
    // A function or loop whose frames are found through themselves has none there, so what is found within is
    // provisional.
    return finding(
      framing[kind],
      context,
      (found) => found.frames[kind],
      (found) => frames[kind].set(context, found),
      () => {
        // Frames are found once, so the caps they hit count however they came to be found.
        const wasQuiet = quiet
        quiet = 0
        immediate++
        try {
          return isLoop(context) ? loopFrames(context, deep) : framesFrom(context, [context], deep)
        } finally {
          immediate--
          quiet = wasQuiet
        }
      },
      [],
    )
  }

  /**
   * The frames of `fn`, out along its calls, whose functions are `chain`. A call whose arguments read no parameter of
   * the function around it needs no frame of that function. One past the depth cap, or that recurses, has its
   * arguments evaluated in the widened frame of the function around it (§18).
   */
  function framesFrom(fn: AstNode, chain: readonly AstNode[], deep = false): Frame[] {
    const factory = factoryFrames(fn) ?? thunkModuleFrames(fn)
    if (factory !== undefined) return factory
    const found: Frame[] = []
    // An iteration native's calls are iterations, which the iteration cap bounds, not the context cap (§18).
    const iterated: Frame[] = []
    // The frames past the depth cap of calls that carry a native, which come after the others.
    const deferred: Frame[] = []
    // A function nested in other code closes over that code's frames, so a call of it by name runs in a frame of the
    // code the call is in, whose closure is the frame of its lexical owner there (§5 Resolver capabilities 3).
    const nested = lexicalOwner(fn) !== undefined
    for (const site of [...calls.callsOf(fn), ...makeSites(fn)]) {
      if (site.iterates !== undefined) {
        iterated.push(...iterationFrames(site, deep))
        continue
      }
      // The innermost loop or function around the call whose parameters or iterations its arguments or receiver read,
      // and whether they read the code around that too.
      let passed: Value[][] = []
      const read = new Set(
        contextual(() => {
          passed = argumentValues({ site, caller: undefined })
          if (site.receiver !== undefined && site.receiver !== 'new' && site.receiver !== 'none') evaluate(site.receiver, callerAt(site, undefined))
        }).functions,
      )
      // A closure the call passes, made where no frame of the function around it is known, that reads a variable of that
      // function's (`closesOver`): the call runs in that function's frames, so the closure keeps the bindings of the
      // call that made it (§5 Resolver capabilities 3).
      for (const value of passed.flat()) {
        if (!isFunctionValue(value) || value.heap.frame !== undefined) continue
        const owner = lexicalOwner(value.heap.node)
        if (owner !== undefined && site.contexts.includes(owner) && closesOver(value.heap.node, owner)) read.add(owner)
      }
      // Only a write that reads what the function closes over needs its frames per closure (`deep`).
      if (deep && nested && site.within !== undefined) read.add(site.within)
      // A call in a function no resolved call reaches, named or dynamic, whose arguments read the code around that
      // function (its closure), is evaluated in the function's creation frames, which hold that closure (§3 Restores, §7): shimmer's
      // `__unwrap` closure calls its define helper with the saved original. Only the calls of the function whose frames
      // are asked for are framed so, which keeps the chain short; a closure inside a function on the chain would call
      // back into it, a recursion, so it keeps the frame of no caller.
      const within = site.within
      const closed =
        within !== undefined &&
        chain.length === 1 &&
        calls.callsOf(within).length === 0 &&
        dynamicFramesOf(within).length === 0 &&
        !chain.some((each) => each.start <= within.start && within.end <= each.end) &&
        [...read].some((context) => !site.contexts.includes(context))
      const around = site.contexts.find((context) => read.has(context)) ?? (closed ? site.within : undefined)
      const frameIn = (caller: Frame | undefined) =>
        moduleFrame(site) ?? callFrame(site, caller, deep && nested ? closureOf(fn, caller) : undefined)
      if (around === undefined) {
        found.push(frameIn(undefined))
        continue
      }
      const further = [...read].some((context) => context !== around)
      if (isLoop(around)) {
        const callers = framesOf(around, further)
        if (callers.length === 0) found.push(frameIn(undefined))
        else for (const caller of callers) found.push(frameIn(caller))
        continue
      }
      const recursive = chain.includes(around)
      if (recursive || chain.length >= maxDepth) {
        // Past the depth cap, a call that carries a native in a real frame of its caller is deferred, never dropped: it
        // keeps that frame, after the other work, and only the step budget bounds it (§18). A recursion widens.
        // Its caller's real frames are found once for each function, as the code's own are, so a long chain costs
        // each function's frames once.
        const callers = recursive ? [] : framesOf(around, further)
        const exempt = callers.filter((caller) => carries({ site, caller }))
        for (const caller of exempt) deferred.push(frameIn(caller))
        if (exempt.length > 0 && exempt.length === callers.length) continue
        hit('recursion', site.call)
        const widened = widenedFrame(around, calls.callsOf(around))
        // Whether a recursive call carries a native is judged in the real frames of its caller, so a native that
        // arrives only through the recursion (`r(o[k[0]], …)` in `r(window, ['document'])`) is a cut too.
        const carrying = recursive && realFrames(around).some((caller) => carries({ site, caller }))
        if (carrying || carries({ site, caller: widened })) budgetCall(site.call, 'recursion')
        found.push(callFrame(site, widened))
        continue
      }
      const callers = framesFrom(around, [...chain, around], further)
      if (callers.length === 0) found.push(frameIn(undefined))
      else for (const caller of callers) found.push(frameIn(caller))
    }
    // The calls the syntax doesn't name: methods, callbacks, closures and the call natives. Each kind of frame is in
    // document order, whatever order the calls were visited in (§18 Context policy).
    const ordered = [
      // A module's require calls run in its one frame (`moduleFrame`), so its frame is listed once.
      ...framesInDocumentOrder([...new Map(found.map((frame) => [frame.id, frame])).values()]),
      ...framesInDocumentOrder(dynamicFramesOf(fn).filter((frame) => !madeByLink(frame))),
      ...framesInDocumentOrder(deferred),
    ]
    const resolved = merged(fn, ordered)
    return [...resolved, ...callerLessFrames(fn, resolved, deep), ...framesInDocumentOrder(iterated)]
  }

  /**
   * Whether a function made in `owner` reads a variable `owner` declares, a parameter or a local of its own code, where
   * `owner` has parameters, whose arguments its frames bind.
   */
  function closesOver(fn: AstNode, owner: AstNode): boolean {
    if ((owner['params'] as AstNode[]).length === 0) return false
    let found = closures.get(fn)
    if (found !== undefined) return found
    found = false
    walkTree(fn, {
      enter(node) {
        if (found) return false
        if (node.type !== 'Identifier') return undefined
        const scope = referenceKey(node)?.scope
        if (scope === undefined || scope === 'global' || scope === fn || (fn.start <= scope.start && scope.end <= fn.end)) {
          return undefined
        }
        if (scope === owner ? bindsOwn(owner, node['name'] as string) : owner.start <= scope.start && scope.end <= owner.end) {
          found = true
        }
        return undefined
      },
    })
    closures.set(fn, found)
    return found
  }
  const closures = new Map<AstNode, boolean>()

  /** The functions whose real frames `realFrames` is finding, which a recursion inside them can't wait for. */
  const judging = new Set<AstNode>()

  /**
   * The frames of `fn` out along its calls, found afresh for judging whether a recursive call in it carries a
   * native: its recursive calls in turn are widened. Its cap hits are counted where its frames are found for the code.
   */
  function realFrames(fn: AstNode): Frame[] {
    const frames = building === undefined ? judged : building.judged
    const known = frames.get(fn)
    if (known !== undefined) return known
    if (judging.has(fn)) return []
    judging.add(fn)
    try {
      const found = quietly(() => framesFrom(fn, [fn]))
      frames.set(fn, found)
      return found
    } finally {
      judging.delete(fn)
    }
  }
  /** The real frames `realFrames` found, by function. */
  const judged = new Map<AstNode, Frame[]>()

  /**
   * Frames of one function past the context cap (§18): the first frames stay, those that carry a native before any
   * other, and the rest merge into one, which is a cap hit. A merged frame that carries a native raises
   * `analysis-budget` (Principle 5).
   */
  function merged(fn: AstNode, all: Frame[]): Frame[] {
    // The frames of calls made in the iterations of a catalog-bounded list aren't capped (§5 Resolver capabilities 9):
    // only the step budget bounds them.
    // Nor are a lazy module thunk's frames, one per module (`thunkSite`), or its thunk maker's, or a require function's,
    // one per module it links (`requireFrame`) (§6).
    const found = all.filter((frame) => !inBounded(frame) && !isThunkFrame(frame) && !isRequireFrame(frame))
    if (found.length <= maxContexts) return all
    const carrying = new Set(found.filter((frame) => frame.bindings.some(carries)))
    const order = [...found.filter((frame) => carrying.has(frame)), ...found.filter((frame) => !carrying.has(frame))]
    const kept = new Set(order.slice(0, maxContexts - 1))
    const rest = found.filter((frame) => !kept.has(frame))
    for (const frame of rest) {
      hit('contexts', frame.bindings[0]!.site.call)
      if (carrying.has(frame)) for (const binding of frame.bindings) budgetCall(binding.site.call, 'contexts')
    }
    return [...all.filter((frame) => kept.has(frame) || !found.includes(frame)), mergedFrame(fn, rest)]
  }

  /** Whether a frame runs within an iteration over a catalog-bounded list, or is called from one, at any depth. */
  function inBounded(frame: Frame): boolean {
    const known = boundedFrames.get(frame)
    if (known !== undefined) return known
    boundedFrames.set(frame, false)
    const found =
      frame.bounded === true ||
      (frame.outer !== undefined && inBounded(frame.outer)) ||
      frame.bindings.some((binding) => binding.caller !== undefined && inBounded(binding.caller))
    boundedFrames.set(frame, found)
    return found
  }
  const boundedFrames = new WeakMap<Frame, boolean>()

  // Constant loops (§5 Resolver capabilities 4). A loop the resolver can unroll has a plan: what each iteration binds.
  // Its iterations are frames of the loop (`summaries.ts`), each run within a frame of the code around the loop, and an
  // iteration native's callback runs in a frame per element, within the frame of the code that calls the native. What
  // each iteration binds is kept beside its frame.

  /** What each iteration of a loop, or each call of an iteration native's callback, binds. */
  const iterations = new WeakMap<Frame, { element?: Element; counter?: { before: Value[]; after: Value[] } }>()
  /** The arguments an iteration native passes its callback, by the binding of each call. */
  const givens = new WeakMap<Binding, Element[]>()

  /** The program's loops, in document order, and the names their heads and counters may bind, found once. */
  let loopIndex: { loops: AstNode[]; names: Set<string> } | undefined
  function loops(): NonNullable<typeof loopIndex> {
    if (loopIndex !== undefined) return loopIndex
    const found: AstNode[] = []
    const names = new Set<string>()
    walkTree(program, {
      enter(node) {
        if (!isLoop(node)) return
        found.push(node)
        if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
          for (const id of identifiersOf(headPattern(node) ?? node)) names.add(id['name'] as string)
        }
        for (const bump of bumpsOf(node)) names.add(bump.id['name'] as string)
      },
    })
    return (loopIndex = { loops: found, names })
  }

  const plans = new Map<AstNode, Plan | null>()

  /** What a loop binds per iteration, or undefined when it can't be unrolled. */
  function planOf(loop: AstNode): Plan | undefined {
    let plan = plans.get(loop)
    if (plan === undefined) plans.set(loop, (plan = findPlan(loop) ?? null))
    return plan ?? undefined
  }

  function findPlan(loop: AstNode): Plan | undefined {
    if (loop.type === 'ForInStatement' || loop.type === 'ForOfStatement') {
      const pattern = headPattern(loop)
      if (pattern === undefined) return undefined
      const keys: VariableKey[] = []
      for (const id of identifiersOf(pattern)) {
        const key = definitions.keyOf(id)
        if (key === undefined) return undefined
        // A loop variable the body assigns is no longer the element.
        if (definitions.of(key).some((definition) => definition.site !== loop && within(loop, definition.site))) return undefined
        keys.push(key)
      }
      return { kind: 'each', loop, forIn: loop.type === 'ForInStatement', pattern, keys }
    }
    // A counted loop: one counter, bumped once per iteration by a constant step, in the update or the body.
    const [bump, ...more] = bumpsOf(loop)
    if (bump === undefined || more.length > 0) return undefined
    const key = definitions.keyOf(bump.id)
    if (key === undefined) return undefined
    const all = definitions.of(key)
    const init = loop.type === 'ForStatement' ? (loop['init'] as AstNode | null) : null
    const initial = all.filter((definition) => init !== null && within(init, definition.site))
    const inside = all.filter((definition) => within(loop, definition.site) && !initial.includes(definition))
    if (inside.length !== 1 || inside[0]!.site !== bump.node || initial.length > 1) return undefined
    // A write to the counter in another function may run during the loop, through a call in its body.
    const fn = calls.functionOf(loop)
    if (all.some((definition) => !within(loop, definition.site) && calls.functionOf(definition.site) !== fn)) return undefined
    let start = initial[0]
    if (start === undefined) {
      const before = all.filter((definition) => !within(loop, definition.site))
      if (before.length !== 1 || before[0]!.site.end > loop.start) return undefined
      start = before[0]!
    }
    if (start.source === undefined || start.logical || start.pattern.type !== 'Identifier') return undefined
    return { kind: 'counted', loop, key, start, bump }
  }

  /** Whether a read `id` of `key` is one that `plan`'s iterations bind: in the loop's body, test or update. */
  function binds(plan: Plan, key: VariableKey, id: AstNode): boolean {
    const { loop } = plan
    if (plan.kind === 'each') {
      return plan.keys.some((each) => each.scope === key.scope && each.name === key.name) && within(loop['body'] as AstNode, id)
    }
    if (plan.key.scope !== key.scope || plan.key.name !== key.name || !within(loop, id)) return false
    const init = loop['init'] as AstNode | null | undefined
    return init === null || init === undefined || !within(init, id)
  }

  /**
   * The loop whose iterations bind the read `id`, innermost first, in the function the read is in, and the iteration
   * of it that `at` runs in, if any.
   */
  function loopOf(id: AstNode, at: Position): { plan: Plan; frame: Frame | undefined } | undefined {
    let plan = loopPlans.get(id)
    if (plan === undefined) loopPlans.set(id, (plan = findLoopOf(id) ?? null))
    return plan === null ? undefined : { plan, frame: frameOf(at.frame, plan.loop) }
  }
  /** The plan of the loop whose iterations bind each read asked about, or null for none. */
  const loopPlans = new WeakMap<AstNode, Plan | null>()

  function findLoopOf(id: AstNode): Plan | undefined {
    const { loops: list, names } = loops()
    if (!names.has(id['name'] as string)) return undefined
    const key = definitions.keyOf(id)
    if (key === undefined) return undefined
    const fn = calls.functionOf(id)
    // The last loop that starts at or before the read, found by bisection: the loops are in document order.
    let low = 0
    let high = list.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (list[middle]!.start <= id.start) low = middle + 1
      else high = middle
    }
    for (let at_ = low - 1; at_ >= 0; at_--) {
      const loop = list[at_]!
      if (fn !== undefined && loop.start < fn.start) break
      if (loop.end < id.end || calls.functionOf(loop) !== fn) continue
      const plan = planOf(loop)
      if (plan === undefined || !binds(plan, key, id)) continue
      return plan
    }
    return undefined
  }

  /**
   * A read of a variable an iteration binds: the element, destructured as the loop head's pattern destructures it, after
   * the alias of the head, or the counter's value. With no iteration to read it in, the loop is a context the read
   * needs (`contextual`), and the read is left to the variable's definitions.
   */
  function loopRead(id: AstNode, at: Position): Value[] | undefined {
    const found = loopOf(id, at)
    if (found === undefined) return undefined
    const { plan, frame } = found
    if (frame === undefined) {
      readers.at(-1)?.add(plan.loop)
      return undefined
    }
    const bound = iterations.get(frame)
    const name = id['name'] as string
    if (plan.kind === 'counted') {
      const counter = bound?.counter
      if (counter === undefined) return [unknown]
      // A read after the body's bump sees the counter bumped.
      return plan.bump.inBody && id.start >= plan.bump.statement.end ? counter.after : counter.before
    }
    if (bound?.element === undefined) return [unknown]
    const at_: Position = { ...nowhere, frame }
    const values = destructured(plan.pattern, elementSource(bound.element, plan.loop), name, at_)?.values ?? [unknown]
    return values.map((value) => aliased(value, plan.loop, name, undefined))
  }

  /** The loop or function whose code holds a loop, out to the function it is in. */
  function enclosing(loop: AstNode): AstNode | undefined {
    const fn = calls.functionOf(loop)
    const list = loops().loops
    for (let at_ = list.indexOf(loop) - 1; at_ >= 0; at_--) {
      const other = list[at_]!
      if (fn !== undefined && other.start < fn.start) break
      if (other.end >= loop.end && calls.functionOf(other) === fn) return other
    }
    return fn
  }

  /** Where a loop's head is evaluated, in the frame `outer` of the code around it. */
  const loopPosition = (loop: AstNode, outer: Frame | undefined): Position => ({
    guard: () => undefined,
    topLevel: calls.functionOf(loop) === undefined,
    frame: outer,
  })

  /**
   * The iterations of a loop, in each frame of the code around it: one per element of a constant collection, or per
   * counter value. None when it can't be unrolled.
   */
  function loopFrames(loop: AstNode, deep: boolean): Frame[] {
    const plan = planOf(loop)
    if (plan === undefined) return []
    const around = enclosing(loop)
    const outers = around === undefined || !(deep || headReadsAround(plan)) ? [] : framesOf(around, true)
    return (outers.length === 0 ? [undefined] : outers).flatMap((outer) =>
      plan.kind === 'each' ? eachFrames(plan, outer) : countedFrames(plan, outer),
    )
  }

  /** Whether a loop's head reads the parameters or iterations of the code around the loop. */
  function headReadsAround(plan: Plan): boolean {
    const { loop } = plan
    const at = loopPosition(loop, undefined)
    const { functions: read } = contextual(() => {
      if (plan.kind === 'each') {
        const right = loop['right'] as AstNode
        return plan.forIn ? forInKeys(right, at) : collectionsOf(right, at)
      }
      evaluate(plan.start.source!, positionOf(plan.start, undefined))
      const test = loop['test'] as AstNode | null | undefined
      if (test !== null && test !== undefined) evaluate(test, at)
      if (plan.bump.amount !== 1) evaluate(plan.bump.amount, at)
      return undefined
    })
    return [...read].some((context) => context !== loop && within(context, loop))
  }

  /** A frame of the loop's iteration `index`, run within `outer`, binding `bound`. */
  function iterationFrame(loop: AstNode, id: string, outer: Frame | undefined, index: number): Frame {
    return {
      fn: loop,
      bindings: [],
      id: frameId(`L${loop.start}#${id}${outer === undefined ? '' : `<${outer.id}`}`),
      depth: outer?.depth ?? 0,
      how: 'call',
      outer,
      iteration: index,
    }
  }

  /** The iterations of a `for…of` or `for…in` loop over a constant collection or object literal. */
  function eachFrames(plan: Extract<Plan, { kind: 'each' }>, outer: Frame | undefined): Frame[] {
    const { loop } = plan
    const right = loop['right'] as AstNode
    const at = loopPosition(loop, outer)
    const lists = plan.forIn ? forInKeys(right, at) : collectionsOf(right, at)
    if (lists === undefined) return []
    const frames: Frame[] = []
    for (const [alternative, { elements, bounded }] of lists.entries()) {
      for (const [index, element] of elements.entries()) {
        // A catalog-bounded list isn't capped: only the step budget bounds it (Principle 5).
        if (frames.length >= maxIterations && bounded !== true) return cutFrames(loop, frames)
        const frame = iterationFrame(loop, `${alternative}.${index}`, outer, index)
        if (bounded) frame.bounded = true
        iterations.set(frame, { element })
        frames.push(frame)
        if (exits(loop['body'] as AstNode, { ...at, frame }) === 'yes') break
      }
    }
    return frames
  }

  /**
   * The iterations of a counted loop, simulated from the counter's start value. A loop whose test can't be decided is
   * unrolled only when every path exits within the iteration cap; otherwise it isn't, which is no cap hit. A loop that
   * runs past the cap is cut there.
   */
  function countedFrames(plan: Extract<Plan, { kind: 'counted' }>, outer: Frame | undefined): Frame[] {
    const { loop, start, bump } = plan
    const at = loopPosition(loop, outer)
    const [first, ...more] = evaluate(start.source!, positionOf(start, outer))
    if (first?.kind !== 'constant' || more.length > 0 || (typeof first.value !== 'number' && typeof first.value !== 'bigint')) {
      return []
    }
    const test = (loop['test'] as AstNode | null | undefined) ?? null
    // A test against the length of a catalog-bounded list: the loop unrolls every element that may be present, even
    // when the length is undecided, uncapped.
    const limit = test === null ? undefined : boundedLength(test, plan.key, at)
    const frames: Frame[] = []
    let value: Primitive = first.value
    let undecided = test === null
    for (let index = 0; ; index++) {
      const frame = iterationFrame(loop, String(index), outer, index)
      if (limit !== undefined) frame.bounded = true
      const before = [constant(value)]
      iterations.set(frame, { counter: { before, after: [unknown] } })
      const inside: Position = { ...at, frame }
      if (test !== null && (loop.type !== 'DoWhileStatement' || index > 0)) {
        const taken = truthiness(evaluate(test, inside))
        if (taken === false) return frames
        if (taken === undefined) {
          if (limit === undefined) undecided = true
          else if (typeof value !== 'number' || value >= limit) return frames
        }
      }
      if (frames.length >= maxIterations && limit === undefined) return undecided ? [] : cutFrames(loop, frames)
      const amount = bump.amount === 1 ? [constant(typeof value === 'bigint' ? 1n : 1)] : evaluate(bump.amount, inside)
      const [step, ...others] = amount
      if (step?.kind !== 'constant' || others.length > 0) return []
      const next = binaryOperation(bump.operator, value, step.value, maxFoldLength)
      if (next === 'throws' || next === 'too-long') return []
      iterations.set(frame, { counter: { before, after: [constant(next.value)] } })
      frames.push(frame)
      const exit = exits(loop['body'] as AstNode, inside)
      if (exit === 'yes') return frames
      if (exit === 'maybe') undecided = true
      value = next.value
    }
  }

  /**
   * The most elements a counted loop's test `i < list.length` lets it visit when `list` is catalog-bounded (§5
   * Resolver capabilities 9): the longest list it can be, counting the elements a filter may have dropped. The
   * test is a `<` of the counter and the length, either way round. Undefined for any other test.
   */
  function boundedLength(test: AstNode, counter: VariableKey, at: Position): number | undefined {
    if (test.type !== 'BinaryExpression') return undefined
    const operator = test['operator'] as string
    const left = test['left'] as AstNode
    const right = test['right'] as AstNode
    const [index, length] = operator === '<' ? [left, right] : operator === '>' ? [right, left] : []
    if (index?.type !== 'Identifier' || length?.type !== 'MemberExpression' || length['computed'] === true) return undefined
    const key = definitions.keyOf(index)
    if (key?.scope !== counter.scope || key.name !== counter.name) return undefined
    if (((length['property'] as AstNode)['name'] as string) !== 'length') return undefined
    const lists = collectionsOf(length['object'] as AstNode, at)
    if (lists === undefined || lists.length === 0 || !lists.every((list) => list.bounded)) return undefined
    return Math.max(...lists.map((list) => list.elements.length))
  }

  /** The iterations done when the iteration cap cut a loop (Principle 5): counted, and marked as cut. */
  function cutFrames(loop: AstNode, frames: Frame[]): Frame[] {
    hit('iterations', loop)
    for (const frame of frames) frame.cut = loop
    return frames
  }

  /**
   * Whether running `statement` in an iteration leaves the loop: `yes` on every path (a `break`, `return` or `throw`
   * that the tests decided are reached), `maybe` on some, `no` on none, or `next` when a `continue` ends the iteration
   * first. A test that can't be decided keeps the iteration going on its other arm.
   */
  function exits(statement: AstNode, at: Position): 'yes' | 'maybe' | 'no' | 'next' {
    switch (statement.type) {
      case 'BreakStatement':
      case 'ReturnStatement':
      case 'ThrowStatement':
        return 'yes'
      case 'ContinueStatement':
        return 'next'
      case 'BlockStatement': {
        let maybe = false
        for (const each of statement['body'] as AstNode[]) {
          const result = exits(each, at)
          if (result === 'yes') return 'yes'
          if (result === 'next') return maybe ? 'maybe' : 'next'
          if (result === 'maybe') maybe = true
        }
        return maybe ? 'maybe' : 'no'
      }
      case 'IfStatement': {
        const taken = truthiness(evaluate(statement['test'] as AstNode, at))
        const consequent = statement['consequent'] as AstNode
        const alternate = statement['alternate'] as AstNode | null
        if (taken === true) return exits(consequent, at)
        if (taken === false) return alternate === null ? 'no' : exits(alternate, at)
        const a = exits(consequent, at)
        const b = alternate === null ? 'no' : exits(alternate, at)
        if (a === 'yes' && b === 'yes') return 'yes'
        return a === 'yes' || a === 'maybe' || b === 'yes' || b === 'maybe' ? 'maybe' : 'no'
      }
      default:
        return 'no'
    }
  }

  /**
   * The calls of an iteration native's callback (§5 Resolver capabilities 4), one per element of the constant
   * collection it visits, in ECMA-262's order and with its early exits, in each frame of the code that calls it. A
   * callback result that can't be decided keeps the iteration going.
   */
  function iterationFrames(site: CallSite, deep: boolean): Frame[] {
    const { native, collection } = site.iterates!
    const context = site.contexts[0]
    const needs =
      context !== undefined &&
      (deep || contextual(() => collectionsOf(collection, callerAt(site, undefined))).functions.size > 0)
    const callers = needs ? framesOf(context, true) : []
    const frames: Frame[] = []
    for (const caller of callers.length === 0 ? [undefined] : callers) {
      const at = callerAt(site, caller)
      if (native === 'from') {
        const callee = calleeExpression(site.call['callee'] as AstNode)
        const [array, ...others] = evaluate(callee['object'] as AstNode, at)
        if (array?.kind !== 'holder' || array.holder !== 'Array' || others.length > 0) continue
      }
      const collections = collectionsOf(collection, at)
      if (collections === undefined) continue
      const reversed = native === 'reduceRight' || native === 'findLast' || native === 'findLastIndex'
      const seeded = (site.call['arguments'] as AstNode[]).length >= 2
      const inside = caller !== undefined && caller.fn.start <= site.fn.start && site.fn.end <= caller.fn.end
      let count = 0
      for (const [alternative, { elements, bounded }] of collections.entries()) {
        let indexes = [...elements.keys()]
        if (reversed) indexes.reverse()
        // `reduce` with no initial value starts from the first element as its accumulator.
        if ((native === 'reduce' || native === 'reduceRight') && !seeded) indexes = indexes.slice(1)
        for (const index of indexes) {
          // A catalog-bounded list isn't capped: only the step budget bounds it (Principle 5).
          if (count >= maxIterations && bounded !== true) {
            hit('iterations', site.call)
            for (const frame of frames) frame.cut = site.call
            return frames
          }
          const binding: Binding = { site, caller, element: index }
          const element = elements[index]!
          const position: Element = { values: [constant(index)] }
          const array: Element = { values: [object], parts: elements }
          givens.set(binding, native === 'reduce' || native === 'reduceRight' ? [{ values: [unknown] }, element, position, array] : [element, position, array])
          const frame: Frame = {
            fn: site.fn,
            bindings: [binding],
            id: frameId(`${site.call.start}:${site.fn.start}#${alternative}.${index}${caller === undefined ? '' : `<${caller.id}`}`),
            depth: (caller?.depth ?? 0) + 1,
            how: 'call',
            ...(inside ? { outer: caller } : {}),
            ...(bounded ? { bounded } : {}),
          }
          frames.push(frame)
          count++
          const stopsOn = earlyExits.get(native)
          if (stopsOn !== undefined && truthiness(returnValues(site.fn, frame)) === stopsOn) break
        }
      }
    }
    return frames
  }

  /** A pattern source for an element, with the elements it holds when it is a collection itself. */
  const elementSource = (element: Element, node: AstNode): ReadSource => ({
    read: element.values,
    node,
    ...(element.parts === undefined ? {} : { parts: element.parts }),
  })

  /** The collections an expression can be, each constant (§5 Resolver capabilities 4), or undefined. */
  const collecting = new Set<AstNode>()
  function collectionsOf(node: AstNode, at: Position): Collection[] | undefined {
    if (collecting.has(node)) return undefined
    // Before any sweep has given keys, no list is catalog-bounded.
    if (!keysSwept && !sweeping()) {
      collecting.add(node)
      try {
        return collected(node, at)
      } finally {
        collecting.delete(node)
      }
    }
    // A catalog-bounded list is found once per frame: a loop over it reads it once per iteration, and each
    // reading runs its filters over the holder's every key. The contexts its finding read are read again.
    const key = `${node.start}:${node.end}@${at.frame?.id ?? ''}`
    // A round of building the dynamic-call index finds its own, as it does its frames.
    const store = building === undefined ? boundedLists : (building.lists ??= new Map())
    const known = store.get(key)
    if (known !== undefined) {
      for (const context of known.reads) readers.at(-1)?.add(context)
      return known.lists
    }
    collecting.add(node)
    try {
      const { value: lists, functions: reads } = contextual(() => collected(node, at))
      for (const context of reads) readers.at(-1)?.add(context)
      if (lists !== undefined && lists.some((list) => list.bounded)) {
        store.set(key, { lists, reads })
      }
      return lists
    } finally {
      collecting.delete(node)
    }
  }
  const boundedLists = new Map<string, { lists: Collection[]; reads: ReadonlySet<AstNode> }>()

  function collected(node: AstNode, at: Position): Collection[] | undefined {
    switch (node.type) {
      case 'ChainExpression':
        return collectionsOf(node['expression'] as AstNode, at)
      case 'SequenceExpression':
        return collectionsOf((node['expressions'] as AstNode[]).at(-1)!, at)
      case 'ArrayExpression': {
        const elements: Element[] = []
        for (const element of node['elements'] as (AstNode | null)[]) {
          if (element === null) elements.push({ values: [constant(undefined)] })
          else if (element.type === 'SpreadElement') {
            // Spreading a constant collection visits its elements (ECMA-262 ArrayAccumulation).
            const spread = collectionsOf(element['argument'] as AstNode, at)
            if (spread === undefined || spread.length !== 1) return undefined
            elements.push(...spread[0]!.elements)
          } else {
            const parts = element.type === 'ArrayExpression' ? collectionsOf(element, at) : undefined
            const values = evaluate(element, at)
            const source = { node: element, at }
            elements.push(parts?.length === 1 ? { values, parts: parts[0]!.elements, source } : { values, source })
          }
        }
        return [{ elements }]
      }
      case 'ConditionalExpression':
      case 'LogicalExpression':
        return alternativeCollections(node, at)
      case 'Identifier':
        return variableCollections(node, at)
      case 'CallExpression':
        return (
          callCollections(node, at) ??
          (lookedFor('returned', node, at, () => returnedLists(node, at) !== undefined) ? returnedLists(node, at) : undefined) ??
          returnedCollections(node, at)
        )
      default:
        return undefined
    }
  }

  /**
   * The collections a `?:` or a `&&`, `||` or `??` can be (§5 Resolver capabilities 4): each alternative that may
   * be the value is its own collection (Principle 3), and an alternative its test decides against is none. Undefined
   * when an alternative that may be the value isn't a constant collection.
   */
  function alternativeCollections(node: AstNode, at: Position): Collection[] | undefined {
    const join = (...arms: [AstNode, Position][]): Collection[] | undefined => {
      const found: Collection[] = []
      for (const [arm, position] of arms) {
        const each = collectionsOf(arm, position)
        if (each === undefined) return undefined
        found.push(...each)
      }
      return found
    }
    // The arms a test may take, as `evaluate` takes them.
    if (node.type === 'ConditionalExpression') {
      const test = node['test'] as AstNode
      const tested = settled(evaluate(test, at), test)
      const arms: [AstNode, Position][] = []
      if (tested.some(maybeTruthy)) arms.push([node['consequent'] as AstNode, guarded(at, test, true)])
      if (tested.some(maybeFalsy)) arms.push([node['alternate'] as AstNode, guarded(at, test, false)])
      return join(...arms)
    }
    const operator = node['operator'] as '&&' | '||' | '??'
    const leftNode = node['left'] as AstNode
    const rightNode = node['right'] as AstNode
    const goesOn = operator === '&&' ? maybeTruthy : operator === '||' ? maybeFalsy : maybeNullish
    const right = (): [AstNode, Position] => [rightNode, operator === '??' ? at : guarded(at, leftNode, operator === '&&')]
    // `a && [B]`: a falsy `a` is no collection, so what a native can iterate is the right's.
    if (operator === '&&') return settled(evaluate(leftNode, at), leftNode).some(goesOn) ? join(right()) : []
    // `a || [B]` and `a ?? [B]`: an array is truthy and not nullish, so a left that is a constant collection is the
    // value. Otherwise the left must be skipped for the right to be the value.
    const lists = collectionsOf(leftNode, at)
    if (lists !== undefined) return lists
    const left = settled(evaluate(leftNode, at), leftNode)
    const ends = operator === '||' ? maybeTruthy : maybeNotNullish
    if (left.some(ends)) return undefined
    return left.some(goesOn) ? join(right()) : []
  }

  /**
   * The catalog-bounded lists a call of user functions returns (§5 Resolver capabilities 9): what each `return`
   * that may run gives, in the call's frame. A `return` that runs only under a test the analyzer can't decide may not be
   * the one that runs, so it gives its elements as kept by an undecided filter, its test. Undefined unless every
   * `return` of every function the call calls gives catalog-bounded lists.
   */
  function returnedLists(call: AstNode, at: Position): Collection[] | undefined {
    const sites = calls.sitesOf(call)
    if (sites.length === 0 || calls.open(call)) return undefined
    const lists: Collection[] = []
    for (const site of sites) {
      const fn = site.fn
      const body = fn['body'] as AstNode
      if (fn['async'] === true || fn['generator'] === true) return undefined
      const frame = instantiated(site, at.frame)
      const inside: Position = { ...nowhere, frame }
      const fold = callFold({ site, caller: at.frame })
      if (body.type !== 'BlockStatement') {
        const found = collectionsOf(body, inside)
        if (found === undefined || !found.every((list) => list.bounded)) return undefined
        lists.push(...found.map((list) => foldedCollection(list, [fold])))
        continue
      }
      if (fallsThrough(body)) return undefined
      for (const statement of returnsOf(fn)) {
        const argument = statement['argument'] as AstNode | null
        if (argument === null) return undefined
        const tests = returnTests(fn, statement, inside)
        if (tests === 'dead') continue
        const found = collectionsOf(argument, inside)
        if (found === undefined || !found.every((list) => list.bounded)) return undefined
        for (const list of found) {
          let elements = list.elements
          for (const test of tests) elements = elements.map((element) => filtered(element, test, 'undecided'))
          lists.push(foldedCollection({ elements, bounded: true }, [fold]))
        }
      }
    }
    return lists.length === 0 ? undefined : lists
  }

  /**
   * The constant collections a resolved call returns (§5 Resolver capabilities 4): each `return` that may run, of
   * each function the call reaches, by name or through its callee's values (a method through `this` included), gives
   * its collections as alternatives of their own (Principle 3). Undefined when the call may reach code the analyzer
   * doesn't know, or when a `return` that may run, or the end of a function, gives anything else.
   */
  function returnedCollections(call: AstNode, at: Position): Collection[] | undefined {
    const reached: { fn: AstNode; frame: Frame; fold: Fold }[] = []
    for (const site of calls.sitesOf(call)) {
      reached.push({ fn: site.fn, frame: instantiated(site, at.frame), fold: callFold({ site, caller: at.frame }) })
    }
    if (calls.open(call)) {
      const dynamic = dynamicTargets(call, at)
      if (dynamic.open) return undefined
      for (const target of dynamic.targets) {
        const frame = targetFrame(target, at.frame)
        if (frame === undefined) return undefined
        reached.push({ fn: target.site.fn, frame, fold: callFold(frame.bindings[0]!) })
      }
    }
    if (reached.length === 0) return undefined
    const lists: Collection[] = []
    for (const { fn, frame, fold } of reached) {
      if (fn['async'] === true || fn['generator'] === true) return undefined
      const inside: Position = { ...nowhere, frame }
      const body = fn['body'] as AstNode
      const returned: AstNode[] = []
      if (body.type !== 'BlockStatement') returned.push(body)
      else {
        if (fallsThrough(body)) return undefined
        for (const statement of returnsOf(fn)) {
          const argument = statement['argument'] as AstNode | null
          if (argument === null) return undefined
          if (returnTests(fn, statement, inside) !== 'dead') returned.push(argument)
        }
      }
      for (const argument of returned) {
        const found = collectionsOf(argument, inside)
        if (found === undefined) return undefined
        lists.push(...found.map((list) => foldedCollection(list, [fold])))
      }
    }
    return lists
  }

  /**
   * The tests a `return` runs under, out to its function's body (the arms it sits in, and the early exits before it in
   * each statement list), evaluated in the function's frame: `dead` when one decides it never runs, otherwise the
   * tests the analyzer can't decide.
   */
  function returnTests(fn: AstNode, statement: AstNode, at: Position): AstNode[] | 'dead' {
    const guards: { test: AstNode; outcome: boolean }[] = []
    for (let child = statement, parent = parentOf(child); parent !== undefined && child !== fn; child = parent, parent = parentOf(parent)) {
      if (parent.type === 'IfStatement' || parent.type === 'ConditionalExpression') {
        if (child === parent['consequent']) guards.push({ test: parent['test'] as AstNode, outcome: true })
        if (child === parent['alternate']) guards.push({ test: parent['test'] as AstNode, outcome: false })
      } else if (parent.type === 'LogicalExpression' && child === parent['right']) {
        guards.push({ test: parent['left'] as AstNode, outcome: parent['operator'] === '&&' })
      } else if (statementLists[parent.type] !== undefined) {
        const list = parent[statementLists[parent.type]!] as AstNode[]
        const index = list.indexOf(child)
        for (const exit of exitGuards(parent)) if (exit.index < index) guards.push(exit.guard)
      }
    }
    const undecided: AstNode[] = []
    for (const { test, outcome } of guards) {
      const taken = truthiness(evaluate(test, at))
      if (taken === undefined) undecided.push(test)
      else if (taken !== outcome) return 'dead'
    }
    return undecided
  }

  /**
   * The collections a variable holds: a loop variable's element, a parameter's argument in each call of its frame, or
   * the one value a variable nothing writes to later is bound to (§5 Resolver capabilities 4).
   */
  function variableCollections(id: AstNode, at: Position): Collection[] | undefined {
    const looped = loopOf(id, at)
    if (looped !== undefined) {
      if (looped.frame === undefined) {
        readers.at(-1)?.add(looped.plan.loop)
        return undefined
      }
      if (looped.plan.kind !== 'each' || looped.plan.pattern.type !== 'Identifier') return undefined
      const parts = iterations.get(looped.frame)?.element?.parts
      return parts === undefined ? undefined : [{ elements: parts }]
    }
    const key = definitions.keyOf(id)
    if (key === undefined) return undefined
    const name = key.name
    if (key.scope !== 'global' && isFunction(key.scope)) {
      const fn = key.scope
      const params = fn['params'] as AstNode[]
      const index = params.findIndex((param) => param.type === 'Identifier' && param['name'] === name)
      if (index >= 0) {
        const frame = frameOf(at.frame, fn) ?? moduleScope(fn)
        if (frame === undefined) {
          readers.at(-1)?.add(fn)
          return undefined
        }
        if (mutated(key)) return undefined
        const found: Collection[] = []
        for (const binding of frame.bindings) {
          const { site, caller } = binding
          const given = givens.get(binding)
          let each: Collection[] | undefined
          if (given !== undefined) {
            const parts = given[index]?.parts
            each = parts === undefined ? undefined : [{ elements: parts }]
          } else if (site.unlisted === undefined || index < site.unlisted) {
            const arg = site.args[index]
            each = arg === undefined || arg.type === 'SpreadElement' ? undefined : collectionsOf(arg, callerAt(site, caller))
          }
          if (each === undefined) return undefined
          const fold: Fold = { ...callFold(binding), argument: index }
          found.push(...each.map((collection) => foldedCollection(collection, [fold])))
        }
        return found
      }
    }
    if (key.scope === 'global' && free(id)?.declaration === undefined) return undefined
    const all = definitions.of(key)
    const [definition] = all
    if (all.length !== 1 || definition === undefined || definition.source === undefined || definition.logical) return undefined
    if (definition.pattern.type !== 'Identifier' || mutated(key)) return undefined
    const found = collectionsOf(definition.source, positionOf(definition, at.frame))
    const fold: Fold = { node: definition.site, name, value: undefined, alias: true }
    return found?.map((collection) => foldedCollection(collection, [fold]))
  }

  /**
   * The collections a call makes that the resolver knows: a `split` list of a constant string, the keys, values or
   * entries of an object literal (`Object.keys(o)`) or of a constant array (`a.entries()`), and `Array.from(a)`.
   */
  function callCollections(call: AstNode, at: Position): Collection[] | undefined {
    const callee = calleeExpression(call['callee'] as AstNode)
    const args = call['arguments'] as AstNode[]
    if (callee.type !== 'MemberExpression' || callee['computed'] === true || args.some((arg) => arg.type === 'SpreadElement')) {
      return undefined
    }
    const receiver = callee['object'] as AstNode
    if (receiver.type === 'Super') return undefined
    const name = (callee['property'] as AstNode)['name'] as string
    const isHolder = (holder: string) => {
      const values = evaluate(receiver, at)
      return values.length === 1 && values[0]!.kind === 'holder' && values[0]!.holder === holder
    }
    // A member sweep of a native holder (§5 Resolver capabilities 9), expanded against the catalog.
    if (lookedFor('sweep', call, at, () => sweepCall(call, at) !== undefined, true)) return sweepCall(call, at)
    // A catalog-bounded list through `filter`, `map`, `slice` or `concat` stays one.
    if (name === 'filter' || name === 'map' || name === 'slice' || name === 'concat') {
      const bounded = (found: Collection[] | undefined) => found !== undefined && found.every((list) => list.bounded)
      if (!lookedFor('bounded', receiver, at, () => bounded(collectionsOf(receiver, at)), true)) return undefined
      const lists = collectionsOf(receiver, at)
      if (lists === undefined || !bounded(lists)) return undefined
      if (name === 'slice') return slicedLists(call, lists, args, at)
      if (name === 'concat') return concatenated(lists, args, at)
      return calledBack(call, name, lists, at)
    }
    switch (name) {
      case 'split':
        return splitList(call, receiver, args, at)
      case 'keys':
      case 'values':
      case 'entries': {
        if (args.length === 1 && isHolder('Object')) {
          const entries = ownEntries(args[0]!, at, false)
          if (entries !== undefined) return [{ elements: entries.map((entry) => entryElement(entry, name)) }]
          return heapEntries(args[0]!, at, name, false)?.map((elements) => ({ elements }))
        }
        if (args.length > 0) return undefined
        const arrays = collectionsOf(receiver, at)
        return arrays?.map(({ elements }) => ({
          elements: elements.map((element, index) =>
            name === 'values'
              ? element
              : name === 'keys'
                ? { values: [constant(index)] }
                : { values: [object], parts: [{ values: [constant(index)] }, element] },
          ),
        }))
      }
      case 'from':
        return args.length === 1 && isHolder('Array') ? collectionsOf(args[0]!, at) : undefined
      default:
        return undefined
    }
  }

  /**
   * Whether `look` finds a member sweep, a catalog-bounded list or a swept key (§5 Resolver capabilities 9), looked for
   * apart (`sandboxed`), so that looking where there is none leaves the code's own evaluation as it was: its memos,
   * frames, cap hits and the contexts it reads. Only a program that enumerates some holder's keys can have one.
   */
  function lookedFor(kind: string, node: AstNode, at: Position, look: () => boolean, apart = false): boolean {
    if (!sweeping()) return false
    // Each is looked for once per frame, as a frame's lists are found once.
    const key = `${kind}:${node.start}:${node.end}@${at.frame?.id ?? ''}`
    const store = building === undefined ? looks : (building.looks ??= new Map())
    let found = store.get(key)
    if (found === undefined) store.set(key, (found = apart && building === undefined && framing.deep.size + framing.shallow.size > 0 ? sandboxed(look, lookups) : contextual(look).value))
    return found
  }
  const looks = new Map<string, boolean>()
  /** Whether a sweep has given keys yet: no value is a swept key before one has. */
  let keysSwept = false
  /**
   * The memos looking for sweeps apart from the code's evaluation keeps (`lookedFor`): its own frames and values, kept
   * across lookups, as one round of building the dynamic-call index keeps its own.
   */
  const lookups: NonNullable<typeof building> = {
    constants: new Map(),
    frames: { deep: new Map(), shallow: new Map() },
    judged: new Map(),
    writeInstances: new Map(),
    spoiled: [],
  }

  /** Whether the program has a key enumeration a member sweep can start from: a `for…in`, or a call of one by name. */
  function sweeping(): boolean {
    if (sweepSources !== undefined) return sweepSources
    let found = false
    walkTree(program, {
      enter(node) {
        if (found) return false
        if (node.type === 'ForInStatement') found = true
        else if (node.type === 'MemberExpression' && node['computed'] !== true) {
          const name = (node['property'] as AstNode)['name']
          if (typeof name === 'string' && sweepMethods.has(name)) found = true
        }
        return undefined
      },
    })
    return (sweepSources = found)
  }
  let sweepSources: boolean | undefined

  /**
   * `filter` or `map` of catalog-bounded lists (§5 Resolver capabilities 9), the callback run once per element in
   * a frame of its own, as an iteration native's callback is. `filter` keeps an element its callback keeps, drops one it
   * drops, and keeps one it may keep with the filter recorded as undecided on the element's keys. `map` gives
   * each element what the callback returns for it. Undefined when the callback isn't a function the analyzer knows.
   */
  function calledBack(call: AstNode, native: 'filter' | 'map', lists: readonly Collection[], at: Position): Collection[] | undefined {
    const [callback] = call['arguments'] as AstNode[]
    if (callback === undefined) return undefined
    const fns = evaluate(callback, at)
    if (fns.length === 0 || !fns.every(isFunctionValue)) return undefined
    const sites = (fns as HeapValue[]).flatMap((fn) =>
      calls.callsOf(fn.heap.node).filter((site) => site.call === call && site.iterates !== undefined),
    )
    if (sites.length === 0) return undefined
    const caller = at.frame
    return lists.map((list, alternative) => {
      const elements: Element[] = []
      for (const [index, element] of list.elements.entries()) {
        const returned = union(
          sites.flatMap((site) => {
            const binding: Binding = { site, caller, element: index }
            givens.set(binding, [element, { values: [constant(index)] }, { values: [object], parts: list.elements }])
            const inside = caller !== undefined && caller.fn.start <= site.fn.start && site.fn.end <= caller.fn.end
            const frame: Frame = {
              fn: site.fn,
              bindings: [binding],
              id: frameId(`${site.call.start}:${site.fn.start}#${alternative}.${index}${caller === undefined ? '' : `<${caller.id}`}`),
              depth: (caller?.depth ?? 0) + 1,
              how: 'call',
              ...(inside ? { outer: caller } : {}),
              bounded: true,
            }
            return returnValues(site.fn, frame)
          }),
        )
        if (native === 'map') {
          elements.push({ values: returned })
          continue
        }
        const kept = truthiness(returned)
        if (kept === false) continue
        elements.push(filtered(element, call, kept === true ? 'kept' : 'undecided'))
      }
      return { elements, bounded: true }
    })
  }

  /** An element after a filter at `node` that keeps it, or may: each of its keys' sweeps records the filter. */
  function filtered(element: Element, node: AstNode, result: 'kept' | 'undecided'): Element {
    const values = element.values.map((value): Value => {
      if (!carriesFolds(value) || value.folds === undefined) return value
      const folds = value.folds.map((fold) =>
        fold.sweep === undefined ? fold : { ...fold, sweep: { ...fold.sweep, filters: [...fold.sweep.filters, { node, result }] } },
      )
      return { ...value, folds } as Value
    })
    return { ...element, values, ...(element.parts === undefined ? {} : { parts: element.parts.map((part) => filtered(part, node, result)) }) }
  }

  /** Whether an element may be absent from its list: a filter may have dropped it. */
  const mayBeAbsent = (element: Element): boolean =>
    element.values.some((value) => sweepsOf(value).some((sweep) => sweep.filters.some((filter) => filter.result === 'undecided')))

  /**
   * `slice(start, end)` of catalog-bounded lists, with constant bounds. A list some of whose elements may be absent
   * has positions the analyzer can't tell, so every element may be in the slice, as the undecided filter it is.
   */
  function slicedLists(call: AstNode, lists: readonly Collection[], args: readonly AstNode[], at: Position): Collection[] | undefined {
    const bounds: (number | undefined)[] = []
    for (const arg of args.slice(0, 2)) {
      const [value, ...more] = evaluate(arg, at)
      if (value?.kind !== 'constant' || more.length > 0) return undefined
      if (value.value !== undefined && typeof value.value !== 'number') return undefined
      bounds.push(value.value)
    }
    return lists.map(({ elements }) => {
      if (!elements.some(mayBeAbsent)) return { elements: elements.slice(bounds[0], bounds[1]), bounded: true }
      return { elements: elements.map((element) => filtered(element, call, 'undecided')), bounded: true }
    })
  }

  /** `concat(…lists)` of a catalog-bounded list: bounded only when every list it adds is too. */
  function concatenated(lists: readonly Collection[], args: readonly AstNode[], at: Position): Collection[] | undefined {
    let out: Collection[] = lists.map((list) => ({ ...list }))
    for (const arg of args) {
      const added = collectionsOf(arg, at)
      if (added === undefined) return undefined
      out = out.flatMap((list) =>
        added.map((more) => ({
          elements: [...list.elements, ...more.elements],
          ...(list.bounded && more.bounded ? { bounded: true as const } : {}),
        })),
      )
    }
    return out
  }

  /**
   * The enumeration a call makes of a native holder's keys (§5 Resolver capabilities 9): `Object.keys(h)`,
   * `Object.getOwnPropertyNames(h)`, `Object.entries(h)`, `Reflect.ownKeys(h)`, `Object.getOwnPropertySymbols(h)`, and
   * the keys of `Object.getOwnPropertyDescriptors(h)` as `Object.keys`, `Object.entries` and `Reflect.ownKeys` read
   * them. One catalog-bounded collection per holder `h` can be. Undefined for any other call, or when `h` may be
   * something other than a native holder.
   */
  function sweepCall(call: AstNode, at: Position): Collection[] | undefined {
    const parts = sweepParts(call, at)
    if (parts === undefined) return undefined
    const [argument] = call['arguments'] as AstNode[]
    const { callee, form } = parts
    // The keys of `Object.getOwnPropertyDescriptors(h)`: every own key of `h`, each an enumerable data property.
    const descriptors = argument === undefined ? undefined : sweepParts(argument, at)
    if (descriptors?.form === 'Object.getOwnPropertyDescriptors' && callee !== 'Object.getOwnPropertySymbols') {
      const inner = (argument!['arguments'] as AstNode[])[0]
      if (inner === undefined) return undefined
      const keys = callee === 'Reflect.ownKeys' ? 'all' : 'strings'
      return holderSweeps(inner, at, argument!, 'Object.getOwnPropertyDescriptors', { keys, enumerable: false }, callee === 'Object.entries')
    }
    if (argument === undefined || form === 'Object.getOwnPropertyDescriptors') return undefined
    const keys = form === 'Reflect.ownKeys' ? 'all' : form === 'Object.getOwnPropertySymbols' ? 'symbols' : 'strings'
    const enumerable = form === 'Object.keys' || form === 'Object.entries'
    return holderSweeps(argument, at, call, form, { keys, enumerable }, form === 'Object.entries')
  }

  /** The enumeration native a call calls, by its catalog name, when it is one of a sweep's (§5 capability 9). */
  function sweepParts(call: AstNode, at: Position): { callee: string; form: SweepForm } | undefined {
    if (call.type !== 'CallExpression') return undefined
    const callee = calleeExpression(call['callee'] as AstNode)
    const args = call['arguments'] as AstNode[]
    if (callee.type !== 'MemberExpression' || callee['computed'] === true || args.length !== 1) return undefined
    if (args[0]!.type === 'SpreadElement') return undefined
    const method = (callee['property'] as AstNode)['name'] as string
    const owner = method === 'ownKeys' ? 'Reflect' : 'Object'
    const name = `${owner}.${method}`
    if (!(sweepForms as readonly string[]).includes(name)) return undefined
    const values = evaluate(callee['object'] as AstNode, at)
    if (values.length !== 1 || values[0]!.kind !== 'holder' || values[0]!.holder !== owner) return undefined
    return { callee: name, form: name as SweepForm }
  }

  /**
   * The keys a sweep of `node` gives, one catalog-bounded collection per native holder it can be (§5 Resolver
   * capabilities 9), each key a constant with its `sweep` fold. With `entries`, each element is a `[key, value]` pair
   * whose value is the member as a read of it gives it. Undefined unless every value `node` has is a native holder.
   */
  function holderSweeps(
    node: AstNode,
    at: Position,
    enumeration: AstNode,
    form: SweepForm,
    which: { keys: 'strings' | 'symbols' | 'all'; enumerable: boolean },
    entries: boolean,
  ): Collection[] | undefined {
    const values = evaluate(node, at)
    if (values.length === 0 || !values.every((value) => value.kind === 'holder')) return undefined
    keysSwept = true
    return (values as HolderValue[]).map((value) => {
      const elements = sweptKeys(value.holder, form === 'for-in' ? 'chain' : 'own', which).map((member): Element => {
        const key: Element = { values: [sweptKey(enumeration, { holder: value.holder, form, member, filters: [] })] }
        if (!entries) return key
        return { values: [object], parts: [key, { values: sweptMember(value, member, enumeration, key.values[0]!) }] }
      })
      return { elements, bounded: true }
    })
  }

  /** A key a sweep gave: the constant the catalog member `member` is keyed by, with the sweep's fold. */
  function sweptKey(node: AstNode, sweep: Sweep): Value {
    const { member } = sweep
    const key: Primitive = member.startsWith('@@') ? wellKnownSymbol(member.slice(2)) : member
    return { kind: 'constant', value: key, folds: [{ node, name: '#', value: key, sweep }] }
  }

  /**
   * The value the member `member` of a swept holder has in the unmutated catalog, as a read of it gives it: a holder it
   * holds, a catalog function, or unknown. It carries the key's folds.
   */
  function sweptMember(value: HolderValue, member: string, node: AstNode, key: Value): Value[] {
    const folds = foldsOf([key])
    const path = value.holder === global ? member : `${value.holder}.${member}`
    const singleton = member.includes('.') ? undefined : singletons.get(path)
    if (singleton !== undefined) {
      const leaf: Leaf = { form: 'singleton', node, name: member, holds: singleton, path, instance: instanceOf(value.leaves), base: value.leaves }
      return [{ ...holder(singleton, leaf), folds }]
    }
    const reached = member.startsWith('@@') ? undefined : memberHolder(value.holder, member)
    // A member a sweep of a holder found is there.
    if (reached !== undefined) return [markedAbsent({ ...value, holder: reached, leaves: unspelled(value.leaves), folds }, false)]
    const fn = member.startsWith('@@') ? undefined : functionTarget(value.holder, member)
    if (fn !== undefined) return [{ kind: 'member', target: fn, holder: value.holder, sites: [node], leaves: value.leaves, folds }]
    return [unknown]
  }

  /**
   * The catalog members a sweep of `holder` visits, as the catalog spells them, in ECMA-262's order (integer indices
   * ascending, then strings, then symbols; each group in catalog order). `own` lists the holder's own members; `chain`
   * is `for…in`'s EnumerateObjectProperties: the own members, then each prototype's along the catalog chain, a name
   * visited once, so a shadowed one is left out. `enumerable` keeps only enumerable members, as `for…in` does.
   */
  function sweptKeys(
    holder: string,
    walk: 'own' | 'chain',
    { keys, enumerable }: { keys: 'strings' | 'symbols' | 'all'; enumerable: boolean },
  ): string[] {
    const visited = new Set<string>()
    const out: string[] = []
    const seen = new Set<string>()
    for (let at: string | null = holder; at !== null && !seen.has(at); at = walk === 'chain' && Object.hasOwn(holders, at) ? holders[at]!.proto : null) {
      seen.add(at)
      const members = ownMembers().get(at) ?? []
      const symbols = members.filter((member) => member.startsWith('@@'))
      const strings = members.filter((member) => !member.startsWith('@@'))
      const ordered = [
        ...(keys === 'symbols' ? [] : [...strings.filter(isIndexKey).sort((a, b) => Number(a) - Number(b)), ...strings.filter((member) => !isIndexKey(member))]),
        ...(keys === 'strings' ? [] : symbols),
      ]
      for (const member of ordered) {
        if (visited.has(member)) continue
        visited.add(member)
        const target = targets[memberName(at, member.startsWith('@@') ? wellKnownSymbol(member.slice(2)) : member)]
        if (enumerable && target?.descriptor.enumerable !== true) continue
        out.push(member)
      }
    }
    return out
  }

  /** `s.split(separator, limit)` of a constant string, split as ECMA-262 splits it: each piece a fold of the call. */
  function splitList(call: AstNode, object: AstNode, args: readonly AstNode[], at: Position): Collection[] | undefined {
    const [string, ...others] = evaluate(object, at)
    if (string?.kind !== 'constant' || typeof string.value !== 'string' || others.length > 0) return undefined
    const [separatorNode, limitNode] = args
    let separator: string | RegExp | undefined
    if (separatorNode !== undefined) {
      const regex = separatorNode['regex'] as { pattern: string; flags: string } | null | undefined
      if (separatorNode.type === 'Literal' && regex !== undefined && regex !== null) {
        try {
          separator = new RegExp(regex.pattern, regex.flags)
        } catch {
          return undefined
        }
      } else {
        const [value, ...rest] = evaluate(separatorNode, at)
        if (value?.kind !== 'constant' || rest.length > 0) return undefined
        if (value.value !== undefined && typeof value.value !== 'string') return undefined
        separator = value.value
      }
    }
    let limit: number | undefined
    if (limitNode !== undefined) {
      const [value, ...rest] = evaluate(limitNode, at)
      if (value?.kind !== 'constant' || rest.length > 0 || (value.value !== undefined && typeof value.value !== 'number')) {
        return undefined
      }
      limit = value.value
    }
    const pieces = separator === undefined ? [string.value] : string.value.split(separator as string, limit)
    const folds = string.folds ?? []
    return [
      {
        elements: pieces.map((piece): Element => ({
          values: [{ kind: 'constant', value: piece, folds: [...folds, { node: call, value: piece }] }],
        })),
      },
    ]
  }

  /**
   * An object literal's own enumerable string keys, in ECMA-262 order (integer indices ascending, then the others in
   * the order they were created), each with the node of its value (none for an accessor). `for…in` also needs the
   * literal's prototype to be `Object.prototype`, so a `__proto__: p` field gives none. Undefined unless the literal is
   * seen directly: inline, or bound to a variable nothing writes to later (§5 Resolver capabilities 4).
   */
  function ownEntries(node: AstNode, at: Position, forIn: boolean): Entry[] | undefined {
    const literal = literalOf(node, at)
    if (literal === undefined) return undefined
    const order: string[] = []
    const values = new Map<string, AstNode | undefined>()
    for (const property of literal.node['properties'] as AstNode[]) {
      if (property.type !== 'Property') return undefined
      const key = propertyKey(property)
      if (key === undefined) return undefined
      if (typeof key === 'symbol') continue
      if (setsLiteralPrototype(property, key)) {
        if (forIn) return undefined
        continue
      }
      if (!values.has(key)) order.push(key)
      values.set(key, property['kind'] === 'init' ? (property['value'] as AstNode) : undefined)
    }
    const indices = order.filter(isIndexKey).sort((a, b) => Number(a) - Number(b))
    const keys = [...indices, ...order.filter((key) => !isIndexKey(key))]
    return keys.map((key) => ({ key, value: values.get(key), at: literal.at, folds: literal.folds }))
  }

  /** The object literal an expression is, seen directly, with where its values are evaluated. */
  function literalOf(node: AstNode, at: Position): { node: AstNode; at: Position; folds: Fold[] } | undefined {
    if (node.type === 'ObjectExpression') return { node, at, folds: [] }
    if (node.type !== 'Identifier') return undefined
    const key = definitions.keyOf(node)
    if (key === undefined || (key.scope === 'global' && free(node)?.declaration === undefined)) return undefined
    const all = definitions.of(key)
    const [definition] = all
    if (all.length !== 1 || definition?.source?.type !== 'ObjectExpression' || definition.logical) return undefined
    if (definition.pattern.type !== 'Identifier' || mutated(key)) return undefined
    const fold: Fold = { node: definition.site, name: key.name, value: undefined, alias: true }
    return { node: definition.source, at: positionOf(definition, at.frame), folds: [fold] }
  }

  /** An object entry as `Object.keys`, `Object.values` or `Object.entries` gives it. */
  function entryElement(entry: Entry, kind: 'keys' | 'values' | 'entries'): Element {
    const key: Element = { values: [{ kind: 'constant', value: entry.key, ...(entry.folds.length === 0 ? {} : { folds: entry.folds }) }] }
    if (kind === 'keys') return key
    // The field's value stays a heap value (§5 Resolver capabilities 5): it never decides a test.
    const value: Element = {
      values: entry.value === undefined ? [unknown] : evaluate(entry.value, entry.at).map((each) => heapValue(each, entry.value!)),
    }
    return kind === 'values' ? value : { values: [object], parts: [key, value] }
  }

  /**
   * The keys `for…in` visits: an object literal's, a constant array's indices, as strings, or a native holder's catalog
   * keys along its chain (§5 Resolver capabilities 9), and those of `Object.getOwnPropertyDescriptors(h)`, which are
   * all of `h`'s own string keys.
   */
  function forInKeys(node: AstNode, at: Position): Collection[] | undefined {
    const entries = ownEntries(node, at, true)
    if (entries !== undefined) return [{ elements: entries.map((entry) => entryElement(entry, 'keys')) }]
    const descriptors = lookedFor('descriptors', node, at, () => sweepParts(node, at) !== undefined, true) ? sweepParts(node, at) : undefined
    if (descriptors?.form === 'Object.getOwnPropertyDescriptors') {
      const holder = (node['arguments'] as AstNode[])[0]!
      return holderSweeps(holder, at, node, 'Object.getOwnPropertyDescriptors', { keys: 'strings', enumerable: false }, false)
    }
    const sweep = () => holderSweeps(node, at, node, 'for-in', { keys: 'strings', enumerable: true }, false)
    if (lookedFor('for-in', node, at, () => sweep() !== undefined, true)) return sweep()
    const collections = collectionsOf(node, at)
    if (collections !== undefined) {
      return collections.map(({ elements }) => ({ elements: elements.map((_, index) => ({ values: [constant(String(index))] })) }))
    }
    return heapEntries(node, at, 'keys', true)?.map((elements) => ({ elements }))
  }

  /**
   * The entries `for…in`, `Object.keys`, `Object.values` and `Object.entries` give on object literals the heap carries
   * (§5 Resolver capabilities 4), a module's exported literal among them: each literal's own enumerable entries,
   * as `kind` gives them for a literal seen directly, one list per literal the expression can be. `forIn` also refuses a
   * literal whose `__proto__` field sets its prototype. Undefined unless every value is such a literal.
   */
  function heapEntries(node: AstNode, at: Position, kind: 'keys' | 'values' | 'entries', forIn: boolean): Element[][] | undefined {
    if (node.type !== 'Identifier' && node.type !== 'MemberExpression') return undefined
    const values = evaluate(node, at)
    if (values.length === 0 || !values.every((value) => isHeap(value) && value.heap.kind === 'literal' && value.heap.node.type === 'ObjectExpression')) {
      return undefined
    }
    const lists: Element[][] = []
    for (const value of values as HeapValue[]) {
      // A literal written after it is made is no constant (§5 Resolver capabilities 4). A variable's literal its code
      // writes is refused as `literalOf` refuses it, before `writtenAfter`, whose writes may iterate it.
      if (variableWritten(value.heap.node) || writtenAfter(value.heap)) return undefined
      const entries = ownEntries(value.heap.node, value.heap.at, forIn)
      if (entries === undefined) return undefined
      lists.push(entries.map((entry) => entryElement({ ...entry, folds: [...entry.folds, ...(value.folds ?? [])] }, kind)))
    }
    return lists
  }

  /**
   * Whether a literal is the value a variable declares and the code mutates the variable (`l.x = …`): the syntactic
   * test `literalOf` makes. It needs no evaluation, so it holds while the writes that would show it are being found.
   */
  function variableWritten(literal: AstNode): boolean {
    const declarator = parentOf(literal)
    if (declarator?.type !== 'VariableDeclarator' || declarator['init'] !== literal) return false
    const id = declarator['id'] as AstNode
    const key = id.type === 'Identifier' ? referenceKey(id) : undefined
    return key !== undefined && mutated(key)
  }

  /** Whether some field write or copy of the code may write each allocation, by its id, found once each. */
  const writtenAllocations = new Map<string, boolean>()
  /** The allocations, by id, whether the code writes which is being found. */
  const writing = new Map<string, Finding>()

  /** Whether some field write or copy of the code may write the allocation, in any frame of it. */
  function writtenAfter(allocation: Allocation): boolean {
    spoiled()
    const known = building === undefined ? writtenAllocations.get(allocation.id) : undefined
    if (known !== undefined) return known
    return finding(
      writing,
      allocation.id,
      (found) => found.written,
      (found) => {
        if (building === undefined) writtenAllocations.set(allocation.id, found)
      },
      () => {
        const { byKey, dynamic, copies } = fieldWrites()
        const writes = [...[...byKey.values()].flat(), ...dynamic, ...copies]
        // A write through a caller-less function's assumed `this` only writes an instance at run time.
        return writes.some((write) =>
          placesOf(write).some((place) => place.objects.some((value) => isAllocation(value, allocation) && !isAssumed(value))),
        )
      },
      false,
    )
  }

  /** Whether an object is only a caller-less function's assumed `this` (§5 Resolver capabilities 3 and 4). */
  const isAssumed = (value: Value): boolean => value.kind === 'object' && value.assumed === true

  /** An element of a constant collection read with constant indexes; undefined when the object is no collection. */
  function elementRead(object: AstNode, keys: readonly Value[], at: Position): Value[] | undefined {
    if (object.type === 'Super') return undefined
    const collections = collectionsOf(object, at)
    if (collections === undefined) return undefined
    return union(
      collections.flatMap(({ elements }) =>
        keys.flatMap((key) => {
          const index = Number(String((key as ConstantValue).value))
          const element = elements[index]
          return carried(element === undefined ? [constant(undefined)] : element.values, key as ConstantValue)
        }),
      ),
    )
  }

  /** A constant collection's length: unknown when a filter may have dropped one of its elements. */
  const lengthOf = ({ elements }: Collection): Value => (elements.some(mayBeAbsent) ? unknown : constant(elements.length))

  /** A collection with `folds` after its elements' own. */
  function foldedCollection(collection: Collection, folds: readonly Fold[]): Collection {
    const element = (each: Element): Element => ({
      values: each.values.map((value) => withFolds(value, folds)),
      ...(each.parts === undefined ? {} : { parts: each.parts.map(element) }),
      ...(each.source === undefined ? {} : { source: each.source }),
    })
    return { elements: collection.elements.map(element), ...(collection.bounded ? { bounded: true as const } : {}) }
  }

  /**
   * The references of each name, with the two nodes around each, found once: what `mutated` looks through. Property
   * names and keys are no references.
   */
  let referenceIndex: Map<string, { id: AstNode; parent: AstNode | null; grand: AstNode | null }[]> | undefined
  function referencesOf(name: string): readonly { id: AstNode; parent: AstNode | null; grand: AstNode | null }[] {
    if (referenceIndex === undefined) {
      const index = new Map<string, { id: AstNode; parent: AstNode | null; grand: AstNode | null }[]>()
      const stack: AstNode[] = []
      walkTree(program, {
        enter(node, parent) {
          stack.push(node)
          if (node.type !== 'Identifier' || parent === null) return
          if (parent.type === 'MemberExpression' && parent['property'] === node && parent['computed'] !== true) return
          const each = { id: node, parent, grand: stack.at(-3) ?? null }
          const list = index.get(node['name'] as string)
          if (list === undefined) index.set(node['name'] as string, [each])
          else list.push(each)
        },
        leave() {
          stack.pop()
        },
      })
      referenceIndex = index
    }
    return referenceIndex.get(name) ?? []
  }

  const mutations = new Map<AstNode | 'global', Map<string, boolean>>()

  /**
   * Whether the analyzer sees a later write to the collection or object a variable holds (§5 Resolver capabilities 4):
   * an index, `length` or member write, a `delete`, a mutating method (`push`, `sort`, …), or a native writer given it
   * (`Object.assign(o, …)`), through the variable or through an alias of it, a parameter of a known call included.
   * Passing it to a call the analyzer can't resolve is no write.
   */
  function mutated(key: VariableKey): boolean {
    let byName = mutations.get(key.scope)
    if (byName === undefined) mutations.set(key.scope, (byName = new Map()))
    const known = byName.get(key.name)
    if (known !== undefined) return known
    // A variable that reads itself back through an alias is not mutated by that.
    byName.set(key.name, false)
    const result = referencesOf(key.name).some((reference) => {
      const found = referenceKey(reference.id)
      return found !== undefined && found.scope === key.scope && found.name === key.name && mutates(reference)
    })
    byName.set(key.name, result)
    return result
  }

  /** The variable an identifier refers to, a parameter declared by it included. */
  function referenceKey(id: AstNode): VariableKey | undefined {
    try {
      return definitions.keyOf(id)
    } catch {
      return undefined
    }
  }

  function mutates({ id, parent, grand }: { id: AstNode; parent: AstNode | null; grand: AstNode | null }): boolean {
    if (parent === null) return false
    if (parent.type === 'MemberExpression' && parent['object'] === id) {
      if (grand === null) return false
      switch (grand.type) {
        case 'AssignmentExpression':
          return grand['left'] === parent
        case 'UpdateExpression':
          return true
        case 'UnaryExpression':
          return grand['operator'] === 'delete'
        case 'ForInStatement':
        case 'ForOfStatement':
          return grand['left'] === parent
        case 'CallExpression': {
          const property = parent['property'] as AstNode
          return grand['callee'] === parent && parent['computed'] !== true && mutators.has(property['name'] as string)
        }
        default:
          return false
      }
    }
    if (parent.type === 'CallExpression') {
      const args = parent['arguments'] as AstNode[]
      const index = args.indexOf(id)
      if (index < 0) return false
      const callee = calleeExpression(parent['callee'] as AstNode)
      if (index === 0 && callee.type === 'MemberExpression' && callee['computed'] !== true) {
        if (objectWriters.has((callee['property'] as AstNode)['name'] as string)) return true
      }
      // Passed to a function the analyzer knows: a write to its parameter is a write to it.
      return calls.sitesOf(parent).some((site) => {
        const at = site.args.indexOf(id)
        const param = at < 0 ? undefined : (site.fn['params'] as AstNode[])[at]
        return param?.type === 'Identifier' && mutated({ scope: site.fn, name: param['name'] as string })
      })
    }
    // An alias of it: a write through the alias is a write to it.
    const alias =
      parent.type === 'VariableDeclarator' && parent['init'] === id
        ? (parent['id'] as AstNode)
        : parent.type === 'AssignmentExpression' && parent['right'] === id
          ? (parent['left'] as AstNode)
          : undefined
    if (alias?.type !== 'Identifier') return false
    const key = referenceKey(alias)
    return key !== undefined && mutated(key)
  }

  // Functions, `this` and dispatch (§5 Resolver capabilities 3). A function or class is a value the heap holds, made in
  // the frame of the code around it, which is its closure: a call of it runs in a frame whose `outer` is that closure,
  // so it reads the bindings of the call that created it. `this` is a frame's receiver: the object a method is read
  // from, the instance a `new` makes, or a `thisArg`. A call whose callee the syntax doesn't name is resolved from the
  // callee's values, forward when its value is read, and backward, for the frames of a function, through an index of
  // every such call. A function object that no resolved call reaches runs in a `creation` frame: its closure, and the
  // `this` it is shown to be held on.

  const budgetCall = (site: AstNode, why: Cut['why']) => {
    if (building === undefined) context.budget(site, why)
    // While the index is built, a cut is the code's only within a memoized value that stays the code's (`evaluated`).
    else if (immediate === 0) cutting.at(-1)?.push({ site, why })
  }

  let parents: WeakMap<AstNode, AstNode> | undefined
  /** The node a node is a child of. */
  function parentOf(node: AstNode): AstNode | undefined {
    if (parents === undefined) {
      const map = new WeakMap<AstNode, AstNode>()
      walkTree(program, {
        enter(child, parent) {
          if (parent !== null) map.set(child, parent)
        },
      })
      parents = map
    }
    return parents.get(node)
  }

  /** The class a class member is in. */
  const classOfMember = (member: AstNode): AstNode => parentOf(parentOf(member)!)!

  /** Whether `child` is the initializer of the class field `member`. */
  const initializes = (member: AstNode, child: AstNode): boolean =>
    (member.type === 'PropertyDefinition' || member.type === 'AccessorProperty') && member['value'] === child

  /**
   * The code whose frames hold the bindings a node reads from around it: the innermost function around it, or for an
   * instance field's initializer, the constructor of its class, which runs it. Undefined at the top level.
   */
  function lexicalOwner(node: AstNode): AstNode | undefined {
    let child = node
    for (let at = parentOf(node); at !== undefined; child = at, at = parentOf(at)) {
      if (isFunction(at)) return at
      if (initializes(at, child) && at['static'] !== true) return constructorOf(classOfMember(at))
    }
    return undefined
  }

  /**
   * Whose `this` a `this` is: a non-arrow function's, or for an instance field's initializer, its class's constructor's,
   * or for a static field or static block, the class itself. Undefined at the top level.
   */
  function thisOwner(node: AstNode): { fn: AstNode } | { cls: AstNode } | undefined {
    let child = node
    for (let at = parentOf(node); at !== undefined; child = at, at = parentOf(at)) {
      if (at.type === 'FunctionDeclaration' || at.type === 'FunctionExpression') return { fn: at }
      if (initializes(at, child)) {
        const cls = classOfMember(at)
        return at['static'] === true ? { cls } : { fn: constructorOf(cls) }
      }
      if (at.type === 'StaticBlock') return { cls: classOfMember(at) }
    }
    return undefined
  }

  const lexicalThis = new WeakMap<AstNode, AstNode | undefined>()
  /** The function whose `this` an arrow function reads, when its own code (nested arrows included) reads one. */
  function lexicalThisOf(node: AstNode): AstNode | undefined {
    if (node.type !== 'ArrowFunctionExpression') return undefined
    if (lexicalThis.has(node)) return lexicalThis.get(node)
    let read: AstNode | undefined
    walkTree(node['body'] as AstNode, {
      enter(child) {
        if (read !== undefined || child.type === 'FunctionDeclaration' || child.type === 'FunctionExpression' || isClass(child)) return false
        if (child.type === 'ThisExpression') read = child
      },
    })
    const owner = read === undefined ? undefined : thisOwner(read)
    const fn = owner !== undefined && 'fn' in owner ? owner.fn : undefined
    lexicalThis.set(node, fn)
    return fn
  }

  /** The frame, out from `frame`, that a function or class made at `node` closes over: its lexical owner's. */
  function closureOf(node: AstNode, frame: Frame | undefined): Frame | undefined {
    const owner = lexicalOwner(node)
    return owner === undefined ? undefined : frameAt(frame, node, owner)
  }

  /** The function or class made at `node`, where `frame` runs: one per closure. */
  function functionValue(node: AstNode, frame: Frame | undefined): HeapValue {
    const closure = closureOf(node, frame)
    return allocated(node, closure === undefined ? nowhere : { ...nowhere, frame: closure }, 'function')
  }

  const isFunctionValue = (value: Value): value is HeapValue => isHeap(value) && value.heap.kind === 'function'
  const isCallable = (value: Value): value is HeapValue =>
    isHeap(value) && (value.heap.kind === 'function' || value.heap.kind === 'bound')

  /** The value of `this` at `node`. */
  function thisValues(node: AstNode, at: Position): Value[] {
    const owner = thisOwner(node)
    if (owner === undefined) {
      if (!at.topLevel) return [unknown]
      // A module's top-level `this` is undefined.
      if (sourceType === 'module') return [constant(undefined)]
      return [holder(global, { form: 'top-level-this', node, name: 'this', instance: codeInstance })]
    }
    if ('cls' in owner) return [functionValue(owner.cls, at.frame)]
    const frame = frameOf(at.frame, owner.fn)
    if (frame === undefined) {
      readers.at(-1)?.add(owner.fn)
      return [unknown]
    }
    return receiverValues(frame, node)
  }

  /** The receivers precomputed for a binding: a method's object, a bound function's `this`. */
  const receivers = new WeakMap<Binding, Value[]>()

  /**
   * The `this` of a frame, each value after the `call` fold of the call that passed it: what each of its calls passes,
   * or for a `creation` frame, the object its function is held on. A call that passes no `this`, or `null` or
   * `undefined` as its `thisArg`, binds ECMA-262's `this` (OrdinaryCallBindThis): the global object in a sloppy
   * function, read at `node`, and the value passed in a strict one. A call whose `this` is unknown passes unknown.
   */
  function receiverValues(frame: Frame, node?: AstNode): Value[] {
    if (frame.how === 'creation') {
      const assumed = frame.receiver as HeapValue | undefined
      return assumed === undefined ? [unknown] : [{ ...assumed, assumed: true }]
    }
    const strict = scope.isStrict(frame.fn.start)
    const bind = (value: Value): Value => {
      if (!isNullish(value)) return value
      if (strict) return value
      return holder(global, { form: 'sloppy-this', node: node ?? frame.fn, name: 'this', instance: codeInstance })
    }
    const values: Value[] = []
    for (const binding of frame.bindings) {
      const { site, caller } = binding
      let found = receivers.get(binding)
      if (found === undefined) {
        const receiver = site.receiver
        if (receiver === undefined) found = [unknown]
        else if (receiver === 'new') found = [allocated(site.call, callerAt(site, caller), 'instance')]
        else if (receiver === 'none') found = [constant(undefined)]
        else found = evaluate(receiver, callerAt(site, caller))
      }
      const fold: Fold = { ...callFold(binding), receiver: true }
      for (const value of found) values.push(withFolds(bind(value), [fold]))
    }
    return union(values)
  }

  /** The values the constructor of an instance can be: what its `new` or `Reflect.construct` calls, or its class. */
  function constructorsOf(allocation: Allocation): Value[] {
    const { node, at } = allocation
    if (isClass(node)) return [functionValue(node, at.frame)]
    // A constructor found through a field of the instance itself (`new o.C()` where `o` is it) is unknown.
    if (constructing.has(allocation.id)) return [unknown]
    constructing.add(allocation.id)
    try {
      if (node.type === 'NewExpression') return evaluate(node['callee'] as AstNode, at)
      const [target] = node['arguments'] as AstNode[]
      return target === undefined || target.type === 'SpreadElement' ? [unknown] : evaluate(target, at)
    } finally {
      constructing.delete(allocation.id)
    }
  }
  const constructing = new Set<string>()

  /** The classes a class value extends, as its heritage evaluates where the class is made. */
  function superclassesOf(value: HeapValue): Value[] {
    const node = value.heap.node
    if (!isClass(node)) return []
    const heritage = node['superClass'] as AstNode | null
    return heritage === null ? [] : evaluate(heritage, value.heap.at)
  }

  /** A class value and the classes it extends, nearest first. */
  function classChain(value: HeapValue): HeapValue[] {
    const chain: HeapValue[] = []
    const pending: HeapValue[] = [value]
    const seen = new Set<string>()
    while (pending.length > 0 && chain.length < maxNesting) {
      const next = pending.shift()!
      if (seen.has(next.heap.id)) continue
      seen.add(next.heap.id)
      chain.push(next)
      for (const parent of superclassesOf(next)) if (isFunctionValue(parent)) pending.push(parent)
    }
    // Classes past the nesting cap are a hit of it, counted once for the class (§18).
    if (pending.some((next) => !seen.has(next.heap.id))) context.capHit('nesting', value.heap.node)
    return chain
  }

  /** The code a function value runs when it is called, or constructed: a class runs its constructor. */
  function codeOf(value: HeapValue, construct: boolean): AstNode | undefined {
    const node = value.heap.node
    if (isClass(node)) return construct ? constructorOf(node) : undefined
    if (construct && node.type === 'ArrowFunctionExpression') return undefined
    return node
  }

  /** The class whose constructor code `fn` is, if it is one. */
  function classOfConstructor(fn: AstNode): AstNode | undefined {
    if (isClass(fn)) return fn
    const method = parentOf(fn)
    return method?.type === 'MethodDefinition' && method['kind'] === 'constructor' ? classOfMember(method) : undefined
  }

  /** A property key a class member or literal property writes: a name, a literal, or a computed key that folds. */
  function memberKey(member: AstNode, at: Position): string | undefined {
    const key = member['key'] as AstNode
    if (key.type === 'PrivateIdentifier') return undefined
    if (member['computed'] !== true) return key.type === 'Identifier' ? (key['name'] as string) : literalKey(key)
    const values = evaluate(key, at)
    const [only] = values
    return values.length === 1 && only?.kind === 'constant' && typeof only.value !== 'symbol' ? String(only.value) : undefined
  }

  /** A class's members, last first, so the one that defines a key last is found first. */
  const membersOf = (cls: AstNode): AstNode[] => ((cls['body'] as AstNode)['body'] as AstNode[]).toReversed()

  /** What a function value gives the field `key` before any write: its `prototype`, or a class's static member. */
  function functionField(allocation: Allocation, key: string): { values: Value[]; presence: 'yes' | 'maybe' | 'no' } {
    const { node, at } = allocation
    const method = parentOf(node)?.type === 'MethodDefinition'
    if (key === 'prototype') {
      if (node.type === 'ArrowFunctionExpression' || method || node['async'] === true || node['generator'] === true) {
        return { values: [], presence: 'no' }
      }
      return { values: [allocated(node, at, 'prototype')], presence: 'yes' }
    }
    if (!isClass(node)) return { values: [], presence: 'no' }
    return classMember(node, key, true, at)
  }

  /** What a prototype object gives the field `key` before any write: its `constructor`, or a class's method. */
  function prototypeField(allocation: Allocation, key: string): { values: Value[]; presence: 'yes' | 'maybe' | 'no' } {
    const { node, at } = allocation
    if (key === 'constructor') return { values: [allocated(node, at, 'function')], presence: 'yes' }
    if (!isClass(node)) return { values: [], presence: 'no' }
    return classMember(node, key, false, at)
  }

  /**
   * A class's own member `key`: a static one (`statics`), the class's field, or else a method of its prototype. A
   * method is a function made in the class's closure, `at`. An accessor gives whatever it returns.
   */
  function classMember(
    cls: AstNode,
    key: string,
    statics: boolean,
    at: Position,
  ): { values: Value[]; presence: 'yes' | 'maybe' | 'no' } {
    for (const member of membersOf(cls)) {
      if ((member['static'] === true) !== statics) continue
      if (member.type === 'MethodDefinition') {
        if (member['kind'] === 'constructor' || memberKey(member, at) !== key) continue
        const value = member['value'] as AstNode
        if (member['kind'] !== 'method') return { values: [unknown], presence: 'yes' }
        return { values: [heapValue(functionValue(value, at.frame), value)], presence: 'yes' }
      }
      if (statics && (member.type === 'PropertyDefinition' || member.type === 'AccessorProperty')) {
        if (memberKey(member, at) !== key) continue
        const value = member['value'] as AstNode | null
        if (value === null) return { values: [constant(undefined)], presence: 'yes' }
        return { values: evaluate(value, at).map((each) => heapValue(each, value)), presence: 'yes' }
      }
    }
    return { values: [], presence: 'no' }
  }

  /**
   * What an instance gives the field `key` before any write: the field initializers of its class and the classes it
   * extends, each run in the frame of the construction that made it. An instance of anything but a user function may
   * have any field.
   */
  function instanceField(allocation: Allocation, key: string): { values: Value[]; presence: 'yes' | 'maybe' | 'no' } {
    const ctors = constructorsOf(allocation)
    if (ctors.length === 0 || !ctors.every(isFunctionValue)) {
      return constructorMayDefine(allocation.node, key) ? { values: [unknown], presence: 'maybe' } : { values: [], presence: 'no' }
    }
    const values: Value[] = []
    let presence: 'yes' | 'maybe' | 'no' = 'no'
    for (const ctor of ctors) {
      let defined = false
      for (const cls of classChain(ctor)) {
        if (!isClass(cls.heap.node) || defined) continue
        for (const member of membersOf(cls.heap.node)) {
          if (member.type !== 'PropertyDefinition' && member.type !== 'AccessorProperty') continue
          if (member['static'] === true) continue
          const frame = constructionFrame(allocation, cls)
          const at: Position = frame === undefined ? nowhere : { ...nowhere, frame }
          if (memberKey(member, at) !== key) continue
          const value = member['value'] as AstNode | null
          if (value === null) values.push(constant(undefined))
          else for (const each of evaluate(value, at)) values.push(heapValue(each, value))
          defined = true
          break
        }
      }
      if (defined) presence = presence === 'no' && ctor === ctors[0] ? 'yes' : presence === 'yes' ? 'yes' : 'maybe'
      else if (presence === 'yes') presence = 'maybe'
    }
    return { values, presence }
  }

  /** The objects a heap object inherits from, nearest first: an instance's prototypes, a class's superclass's. */
  function prototypesOf(allocation: Allocation): Value[] {
    switch (allocation.kind) {
      case 'instance':
        return constructorsOf(allocation).flatMap((ctor) => (isFunctionValue(ctor) ? ownField(ctor.heap, 'prototype') : []))
      case 'prototype': {
        const fn = allocated(allocation.node, allocation.at, 'function')
        return superclassesOf(fn).flatMap((parent) => (isFunctionValue(parent) ? ownField(parent.heap, 'prototype') : []))
      }
      case 'function':
        return superclassesOf({ kind: 'object', heap: allocation })
      default:
        return []
    }
  }

  /** The values an object's own field `key` holds, when it may have it. */
  function ownField(allocation: Allocation, key: string): Value[] {
    const found = field(allocation, key, allocation.node)
    return found.presence === 'no' ? [] : found.values
  }

  /** The field `key` of an object, own or inherited through the objects it inherits from. */
  function lookup(allocation: Allocation, key: string, node: AstNode, seen: Set<string>): Value[] {
    seen.add(allocation.id)
    const found = field(allocation, key, node)
    const values = found.presence === 'no' ? [] : [...found.values]
    if (found.presence === 'yes') return values
    for (const proto of prototypesOf(allocation)) {
      if (isHeap(proto)) {
        if (!seen.has(proto.heap.id)) values.push(...lookup(proto.heap, key, node, seen))
      } else if (opaque(proto)) values.push(unknown)
    }
    return values
  }

  /** Dynamic call sites, one per call, function and form, as the syntax's call graph gives its own. */
  const dynamicSites = new Map<string, CallSite>()

  /** A call site of `fn` at `call` that the syntax doesn't name, with its arguments and receiver. */
  function dynamicSite(
    call: AstNode,
    fn: AstNode,
    form: string,
    args: readonly AstNode[],
    receiver: CallSite['receiver'],
    unlisted?: number,
  ): CallSite {
    const key = `${call.start}:${fn.start}:${form}`
    let site = dynamicSites.get(key)
    if (site === undefined) {
      const info = calls.infoOf(call)!
      site = {
        call,
        fn,
        args,
        ...(unlisted === undefined ? {} : { unlisted }),
        topLevel: info.topLevel,
        guards: info.guards,
        within: info.within,
        contexts: info.contexts,
        ...(receiver === undefined ? {} : { receiver }),
      }
      dynamicSites.set(key, site)
    }
    return site
  }

  /** The call site a construction runs its constructor code `fn` through: its `new`, or its `Reflect.construct`. */
  function constructionSite(call: AstNode, fn: AstNode): CallSite | undefined {
    const known = calls.sitesOf(call).find((site) => site.fn === fn)
    if (known !== undefined) return known
    if (call.type === 'NewExpression') {
      const args = call['arguments'] as AstNode[]
      const spread = args.findIndex((arg) => arg.type === 'SpreadElement')
      return dynamicSite(call, fn, 'new', args, 'new', spread < 0 ? undefined : spread)
    }
    const list = listOf((call['arguments'] as AstNode[])[1])
    return dynamicSite(call, fn, 'construct', list.args, 'new', list.unlisted)
  }

  /** The frame an instance's constructor code runs in when the instance is made, with the instance as its `this`. */
  function constructionFrame(instance: Allocation, cls: HeapValue): Frame | undefined {
    const fn = constructorOf(cls.heap.node)
    if (isClass(instance.node)) return creationFrame(fn, cls.heap.at.frame, { kind: 'object', heap: instance }, instance.node)
    const site = constructionSite(instance.node, fn)
    return site === undefined ? undefined : callFrame(site, instance.at.frame, cls.heap.at.frame)
  }

  /** `creation` frames by id, each made once. */
  const creations = new Map<string, Frame>()

  /**
   * The frame of a function object that no resolved call reaches: its closure, with unknown parameters, and
   * `this` the object it is held on, if any. `created` is where it was made, or its receiver was.
   */
  function creationFrame(fn: AstNode, closure: Frame | undefined, receiver: HeapValue | undefined, created: AstNode): Frame {
    const id = frameId(`c${fn.start}${receiver === undefined ? '' : `/${receiver.heap.id}`}${closure === undefined ? '' : `^${closure.id}`}`)
    let frame = creations.get(id)
    if (frame === undefined) {
      frame = {
        fn,
        bindings: [],
        id,
        depth: (closure?.depth ?? 0) + 1,
        how: 'creation',
        ...(closure === undefined ? {} : { outer: closure }),
        created,
        ...(receiver === undefined ? {} : { receiver, receiverNode: receiver.heap.node }),
      }
      creations.set(id, frame)
    }
    return frame
  }

  /** The arguments an array literal lists for `.apply` or `Reflect.apply`, up to a hole or spread. */
  function listOf(list: AstNode | undefined): { args: AstNode[]; unlisted?: number } {
    if (list === undefined) return { args: [] }
    if (list.type !== 'ArrayExpression') return { args: [], unlisted: 0 }
    const elements = list['elements'] as (AstNode | null)[]
    const hole = elements.findIndex((element) => element === null || element.type === 'SpreadElement')
    if (hole < 0) return { args: elements as AstNode[] }
    return { args: elements.slice(0, hole) as AstNode[], unlisted: hole }
  }

  /** A function a call calls that the syntax doesn't name, with how the call binds it. */
  interface Target {
    site: CallSite
    closure: Frame | undefined
    receiver?: Value[]
    receiverKey?: string
    givens?: Element[]
  }

  /**
   * The user functions a call reaches through its callee's values (§5 Resolver capabilities 3), where `at` runs:
   * a method read from each object (`o.m()`), once per receiver object; a function value called by name; `.call`,
   * `.apply` and `Function.prototype.bind`'s bound functions; `Reflect.apply` and `Reflect.construct`; and a `new` of a
   * class or function value. `open` says it may call something else too.
   */
  function dynamicTargets(call: AstNode, at: Position): { targets: Target[]; open: boolean } {
    const construct = call.type === 'NewExpression'
    const callee = calleeExpression(call['callee'] as AstNode)
    const args = call['arguments'] as AstNode[]
    const targets: Target[] = []
    let open = false
    const spread = args.findIndex((arg) => arg.type === 'SpreadElement')
    const plain = { args, unlisted: spread < 0 ? undefined : spread }

    /** Adds the targets a function value `value` gives, bound as `form` says. */
    const add = (
      value: Value,
      form: string,
      list: { args: readonly AstNode[]; unlisted?: number | undefined },
      receiver: { node?: CallSite['receiver']; values?: Value[]; key?: string },
      creates: boolean,
    ) => {
      if (!isCallable(value)) {
        open = true
        return
      }
      if (value.heap.kind === 'bound') {
        bound(value, form, list, creates)
        return
      }
      const fn = codeOf(value, creates)
      if (fn === undefined) {
        open = true
        return
      }
      const site = dynamicSite(call, fn, form, list.args, receiver.node, list.unlisted)
      // The module links the callee came through (§6).
      for (const fold of value.folds ?? []) {
        if (fold.link === undefined) continue
        site.links ??= []
        if (!site.links.some((each) => each.node === fold.node)) site.links.push({ node: fold.node, link: fold.link })
      }
      targets.push({
        site,
        closure: value.heap.at.frame,
        ...(receiver.values === undefined ? {} : { receiver: receiver.values }),
        ...(receiver.key === undefined ? {} : { receiverKey: receiver.key }),
      })
    }

    /** A bound function called: its target, with the bound `this` and the bound arguments before the call's. */
    const bound = (
      value: HeapValue,
      form: string,
      list: { args: readonly AstNode[]; unlisted?: number | undefined },
      creates: boolean,
    ) => {
      const bind = value.heap.node
      const bindAt = value.heap.at
      const bindArgs = bind['arguments'] as AstNode[]
      const [thisArg, ...boundArgs] = bindArgs
      const boundThis = creates || thisArg === undefined || thisArg.type === 'SpreadElement' ? undefined : evaluate(thisArg, bindAt)
      const listed = list.unlisted === undefined ? list.args : list.args.slice(0, list.unlisted)
      const givenArgs: Element[] = [
        ...boundArgs.map((arg): Element => ({ values: arg.type === 'SpreadElement' ? [unknown] : evaluate(arg, bindAt) })),
        ...listed.map((arg): Element => ({ values: evaluate(arg, at) })),
      ]
      const callee = calleeExpression(bind['callee'] as AstNode)
      for (const inner of evaluate(callee['object'] as AstNode, bindAt)) {
        if (!isFunctionValue(inner)) {
          open = true
          continue
        }
        const fn = codeOf(inner, creates)
        if (fn === undefined) {
          open = true
          continue
        }
        const boundReceiver = creates ? 'new' : thisArg === undefined ? 'none' : thisArg.type === 'SpreadElement' ? undefined : thisArg
        const site = dynamicSite(call, fn, `${form}~${bind.start}`, [...boundArgs, ...list.args], boundReceiver)
        targets.push({
          site,
          closure: inner.heap.at.frame,
          ...(boundThis === undefined ? {} : { receiver: boundThis }),
          // Arguments past a spread the call can't list are unknown.
          givens: list.unlisted === undefined ? givenArgs : [...givenArgs, ...Array.from({ length: 64 }, () => ({ values: [unknown] }))],
        })
      }
    }

    if (callee.type === 'Super') return { targets, open: true }
    if (callee.type === 'MemberExpression' && (callee['object'] as AstNode).type !== 'Super') {
      const object = callee['object'] as AstNode
      const key = propertyNameOf(callee, at)
      if (key === undefined) return { targets, open: true }
      if (!construct && (key === 'call' || key === 'apply' || key === 'construct')) {
        const natives = evaluate(callee, at)
        if (natives.some((value) => value.kind === 'native' && (value.name === 'Reflect.apply' || value.name === 'Reflect.construct'))) {
          const creates = key === 'construct'
          const [fnArg, second, third] = args
          if (fnArg === undefined || fnArg.type === 'SpreadElement') return { targets, open: true }
          const list = listOf(creates ? second : third)
          const thisNode = creates ? 'new' : second === undefined ? 'none' : second.type === 'SpreadElement' ? undefined : second
          for (const value of evaluate(fnArg, at)) {
            add(value, creates ? 'construct' : 'reflect', list, { ...(thisNode === undefined ? {} : { node: thisNode }) }, creates)
          }
          return { targets, open }
        }
        const functions = evaluate(object, at)
        if (key !== 'construct' && functions.some(isCallable)) {
          const [thisArg] = args
          const list = key === 'call' ? { args: args.slice(1), unlisted: spread < 0 ? undefined : Math.max(0, spread - 1) } : listOf(args[1])
          const receiver = thisArg === undefined ? { node: 'none' as const } : thisArg.type === 'SpreadElement' ? {} : { node: thisArg }
          for (const value of functions) add(value, key, list, receiver, false)
          return { targets, open }
        }
      }
      // A method read inside a sequence (`(0, o.m)()`) is called with no `this` (ECMA-262 EvaluateCall: the callee is
      // a value, not a reference), so it is a plain call of each method, once per method.
      const indirect = !construct && (call['callee'] as AstNode).type === 'SequenceExpression'
      const called = new Set<unknown>()
      for (const value of evaluate(object, at)) {
        if (isNullish(value)) continue
        if (opaque(value) || value.kind === 'constant') {
          open = true
          continue
        }
        const receiverKey = isHeap(value) ? value.heap.id : value.kind === 'holder' ? `h:${value.holder}` : undefined
        for (const method of namedRead(callee, key, at, () => [value])) {
          if (indirect) {
            const id = isHeap(method) ? method.heap.id : method
            if (!called.has(id)) add(method, 'plain', plain, { node: 'none' }, false)
            called.add(id)
            continue
          }
          add(method, construct ? 'new' : 'method', plain, construct ? { node: 'new' } : { node: object, values: [value], ...(receiverKey === undefined ? {} : { key: receiverKey }) }, construct)
        }
      }
      return { targets, open }
    }
    for (const value of evaluate(callee, at)) add(value, construct ? 'new' : 'plain', plain, { node: construct ? 'new' : 'none' }, construct)
    return { targets, open }
  }

  /** A member expression's key, when it is a name or a key that folds to a string. */
  function propertyNameOf(member: AstNode, at: Position): string | undefined {
    const property = member['property'] as AstNode
    if (member['computed'] !== true) return property.type === 'Identifier' ? (property['name'] as string) : undefined
    const values = evaluate(property, at)
    const [only] = values
    return values.length === 1 && only?.kind === 'constant' && typeof only.value !== 'symbol' ? String(only.value) : undefined
  }

  /**
   * The frame a target runs in when the call is in `caller`, or undefined past the depth cap or on a recursion, which
   * is a cap hit (§18), and raises `analysis-budget` when the call carries a native (Principle 5).
   */
  function targetFrame(target: Target, caller: Frame | undefined): Frame | undefined {
    const { site } = target
    // A lazy module thunk's call runs its module once, whoever calls it (§6): no chain or recursion is cut there.
    const thunk = thunkSite(site)
    if (thunk !== undefined) return callFrame(thunk, undefined, target.closure)
    // A thunk maker's call the module links name runs in the frame its site has (`makeSites`), however it is reached.
    const make = makeSites(site.fn).find((each) => each.call === site.call)
    if (make !== undefined) return callFrame(make, undefined)
    const recursive = onChain(caller, site.fn)
    if (recursive || (caller?.depth ?? 0) >= maxDepth) {
      const binding: Binding = { site, caller }
      if (target.givens !== undefined) givens.set(binding, target.givens)
      // Past the depth cap, a call that carries a native in its real caller frame keeps its frame.
      if (!recursive && carries(binding)) return instance(target, caller)
      hit('recursion', site.call)
      // While the index is built, the cut is counted, and raised, once the index is done.
      if (indexCuts !== undefined) cut(indexCuts, binding)
      else if (carries(binding)) budgetCall(site.call, 'recursion')
      return undefined
    }
    return instance(target, caller)
  }

  /** The first call of each lazy module thunk in document order, by its thunk's variable (`thunkVariable`) (§6). */
  let thunkCalls: Map<string, AstNode> | undefined

  /** The variable a lazy module thunk's call calls, by scope and name: one per module, even where names repeat. */
  const thunkVariable = (call: AstNode): string => {
    const key = definitions.keyOf(calleeExpression(call['callee'] as AstNode))
    return key === undefined ? '' : `${key.scope === 'global' ? 'global' : key.scope.start}:${key.name}`
  }

  /**
   * The call site every call of a lazy module thunk runs as (§6): its module's first thunk call in document order, so
   * the module's factory runs once, in one frame, whoever calls the thunk, as a require's linked module does
   * (`moduleFrame`). Undefined for any other call.
   */
  function thunkSite(site: CallSite): CallSite | undefined {
    if (context.links.moduleCalls.get(site.call)?.idiom !== 'lazy-thunk') return undefined
    return dynamicSite(firstThunkCalls().get(thunkVariable(site.call))!, site.fn, 'plain', [], 'none')
  }

  /** The first call of each lazy module thunk in document order (`thunkCalls`). */
  function firstThunkCalls(): Map<string, AstNode> {
    if (thunkCalls !== undefined) return thunkCalls
    const found = new Map<string, AstNode>()
    for (const [call, link] of context.links.moduleCalls) {
      if (link.idiom !== 'lazy-thunk') continue
      const variable = thunkVariable(call)
      const first = found.get(variable)
      if (first === undefined || call.start < first.start) found.set(variable, call)
    }
    return (thunkCalls = found)
  }

  /**
   * Whether a frame is one a lazy module thunk's module has one of (§6): its thunk's (`thunkSite`), or its call of the
   * thunk maker, whose thunk closes over its module object and factory.
   */
  const isThunkFrame = (frame: Frame): boolean => frame.how === 'call' && thunkFunctions().has(frame.fn)

  /** The lazy module thunks and their makers: the functions around each thunk's call of its factory, found once. */
  let thunkFns: Set<AstNode> | undefined
  function thunkFunctions(): Set<AstNode> {
    if (thunkFns !== undefined) return thunkFns
    thunkFns = new Set()
    for (const { thunk, maker } of thunkOwners()) {
      thunkFns.add(thunk)
      if (maker !== undefined) thunkFns.add(maker)
    }
    return thunkFns
  }

  /** Each lazy module thunk's call of its factory, with the thunk around it and the thunk maker around that, found once. */
  let thunkOwnerList: { call: AstNode; thunk: AstNode; maker: AstNode | undefined }[] | undefined
  function thunkOwners(): { call: AstNode; thunk: AstNode; maker: AstNode | undefined }[] {
    if (thunkOwnerList !== undefined) return thunkOwnerList
    thunkOwnerList = []
    for (const call of context.links.factoryCalls.keys()) {
      const thunk = lexicalOwner(call)
      if (thunk !== undefined) thunkOwnerList.push({ call, thunk, maker: lexicalOwner(thunk) })
    }
    return thunkOwnerList
  }

  /** The frame of a target's call in `caller`. */
  function instance(target: Target, caller: Frame | undefined): Frame {
    const module = moduleFrame(target.site)
    if (module !== undefined) return module
    const { site, closure } = target
    const frame = callFrame(site, caller, closure, target.receiverKey)
    const binding = frame.bindings[0]!
    if (target.receiver !== undefined) receivers.set(binding, target.receiver)
    if (target.givens !== undefined) givens.set(binding, target.givens)
    return frame
  }

  /** While a round of the index is built, the calls it cut, each with the bindings it cut. */
  let indexCuts: Map<AstNode, Binding[]> | undefined

  const cut = (cuts: Map<AstNode, Binding[]>, binding: Binding) => {
    const list = cuts.get(binding.site.call)
    if (list === undefined) cuts.set(binding.site.call, [binding])
    else list.push(binding)
  }

  /** Calls in document order. */
  const inDocumentPosition = (list: readonly AstNode[]): AstNode[] => [...list].sort((a, b) => a.start - b.start)

  /** Whether the code of `fn`, or of a function in it, makes any call. */
  const callsOn = (fn: AstNode): boolean => calls.allCalls().some((call) => fn.start <= call.start && call.end <= fn.end)

  let dynamicIndex: Map<AstNode, Frame[]> | undefined
  /** While the index is built, the last round's, which the frames found meanwhile use. */
  let indexing: Map<AstNode, Frame[]> | undefined

  /** The frames of `fn` from calls the syntax doesn't name (above). */
  function dynamicFramesOf(fn: AstNode): Frame[] {
    buildIndex()
    if (dynamicIndex === undefined) {
      spoiled()
      return indexing?.get(fn) ?? []
    }
    return dynamicIndex.get(fn) ?? []
  }

  /**
   * Builds the dynamic-call index, once: in rounds, each finding the frames of the calls the syntax doesn't name with
   * the frames the round before found, until a round finds no others or the rounds run out.
   */
  function buildIndex(): void {
    if (dynamicIndex === undefined && indexing === undefined) {
      let previous = new Map<AstNode, Frame[]>()
      // The calls whose frames no round's index changes, with them.
      const settled = new Map<AstNode, Frame[]>()
      let cuts = new Map<AstNode, Binding[]>()
      let same = false
      for (let round = 0; !same; round++) {
        indexing = previous
        indexCuts = new Map()
        let next: Map<AstNode, Frame[]>
        try {
          next = sandboxed(() => dynamicRound(settled))
        } finally {
          indexing = undefined
          cuts = indexCuts
          indexCuts = undefined
        }
        same = sameIndex(previous, next)
        if (same || round < maxIndexRounds - 1) {
          previous = next
          continue
        }
        // Rounds that run out cut the calls of the frames the last one found whose code calls on, which a further round
        // would follow. Depth limits defer calls, never drop them: while one of those frames carries a native in its
        // real caller frame, the rounds go on following those frames alone, and only the step budget bounds them
        // (§18). The others stay in the index, and their calls are cut.
        const known = new Set([...previous.values()].flat().map((frame) => frame.id))
        const further = [...next.values()].flat().filter((frame) => !known.has(frame.id) && callsOn(frame.fn))
        indexing = next
        let carrying: Set<Frame>
        try {
          carrying = sandboxed(() => {
            // Its instances are found first, as a round's are.
            instances()
            return new Set(further.filter((frame) => frame.bindings.some(carries)))
          })
        } finally {
          indexing = undefined
        }
        for (const frame of further) if (!carrying.has(frame)) cut(cuts, frame.bindings[0]!)
        if (carrying.size === 0) {
          previous = next
          break
        }
        const unfollowed = new Set(further.filter((frame) => !carrying.has(frame)))
        previous = new Map(
          [...next].map(([fn, frames]) => [fn, frames.filter((frame) => !unfollowed.has(frame))] as const),
        )
      }
      dynamicIndex = previous
      // Once the index is built, and before any value of the code's is read, the writes whose key the syntax doesn't name
      // are placed by the objects they write (§6). A write's object may read a module's export, which reads the heap and
      // so the placement itself: placed in a sandbox, what that cycle cuts is never memoized as the code's.
      if (linking) {
        let placed: typeof codeBuckets
        sandboxed(() => {
          // Its instances are found first, as a round's are.
          instances()
          writesInto(program)
          placed = building!.buckets
        })
        codeBuckets = placed
      }
      // The code's instances, found within no other finding when the index is built first, so they are found once.
      instances()
      // The index's cuts count as the code's own, and a cut call that carries a native raises `analysis-budget`
      // (Principle 5).
      for (const [call, bindings] of cuts) {
        context.cap('recursion', call)
        if (bindings.some(carries)) context.budget(call, 'recursion')
      }
    }
  }

  /** One round of the dynamic-call index: every call the syntax leaves open, in each frame of the code it is in. */
  function dynamicRound(settled: Map<AstNode, Frame[]>): Map<AstNode, Frame[]> {
    const index = new Map<AstNode, Frame[]>()
    const add = (fn: AstNode, frame: Frame) => {
      const list = index.get(fn)
      if (list === undefined) index.set(fn, [frame])
      else if (!list.some((each) => each.id === frame.id)) list.push(frame)
    }
    // The round's instances are found first, within no other finding when the index is built first, so they are found once.
    instances()
    // In document order, whatever order the calls are visited in: a round's frames read only the round before's, but
    // what it evaluates on the way, and so its steps, follow the order it works in (§18 Context policy).
    for (const call of inDocumentPosition(calls.allCalls())) {
      if (!calls.open(call)) continue
      // A call whose frames depended on nothing the index gives is found the same in every round.
      const known = settled.get(call)
      if (known !== undefined) {
        for (const frame of known) add(frame.fn, frame)
        continue
      }
      const info = calls.infoOf(call)!
      const base: Position = { guard: (name) => info.guards.get(name), topLevel: info.topLevel }
      building!.spoiled.push(false)
      const frames: Frame[] = []
      try {
        // The call runs in the frames of the code whose parameters its callee or its arguments read.
        const first = contextual(() => {
          const found = dynamicTargets(call, base)
          if (found.targets.length > 0) {
            for (const arg of call['arguments'] as AstNode[]) evaluate(arg.type === 'SpreadElement' ? (arg['argument'] as AstNode) : arg, base)
          }
          return found
        })
        if (first.value.targets.length === 0 && first.functions.size === 0) continue
        // A closure the call makes in its arguments (`new Observable((o) => { … api … })`), that reads a variable of a
        // function around the call (`closesOver`), keeps the bindings of the call that made it (§5 Resolver capabilities
        // 3): the call runs in that function's frames, as the calls `framesFrom` frames do.
        const read = new Set(first.functions)
        if (first.value.targets.length > 0) {
          for (const arg of call['arguments'] as AstNode[]) {
            if (!isFunction(arg)) continue
            const owner = lexicalOwner(arg)
            if (owner !== undefined && info.contexts.includes(owner) && closesOver(arg, owner)) read.add(owner)
          }
        }
        // Where the artifact links modules (§6), a call that reads only the code its function closes over runs in the
        // frames of its function, whose closures hold that code's: a `.cw` wrapper's factory, called in its thunk, and a
        // lazy module thunk's factory.
        // Elsewhere too, a call whose callee or arguments read only the parameters of IIFEs around its function (as
        // tslib's `_super.call(this)` reads the class IIFE's `_super`) runs in its function's frames, whose closures bind
        // them (§5 Resolver capabilities 3: IIFE parameters are bound).
        const closed =
          linking ||
          context.links.factoryCalls.has(call) ||
          (read.size > 0 &&
            [...read].every((each) => !info.contexts.includes(each) && invokedInPlace(each)))
        // A call in an arrow that reads the `this` of the function around it runs in the arrow's frames, whose closures
        // hold that function's (ECMA-262: an arrow function's `this` is its enclosing function's).
        const lexical = info.within === undefined ? undefined : lexicalThisOf(info.within)
        const outer = lexical !== undefined && read.has(lexical)
        const around =
          info.contexts.find((each) => read.has(each)) ??
          ((closed && read.size > 0) || outer ? info.within : undefined)
        const further = [...read].some((each) => each !== around)
        const callers = around === undefined ? [] : framesOf(around, further)
        const found =
          callers.length === 0
            ? [{ caller: undefined, targets: first.value.targets }]
            : callers.map((caller) => ({ caller, targets: dynamicTargets(call, { ...base, frame: caller }).targets }))
        // A require call that links a module has its call's frame alone (`summarized`).
        const unframed = context.links.links.has(call)
        for (const { caller, targets } of found) {
          for (const target of targets) {
            const frame = targetFrame(target, unframed ? undefined : caller)
            if (frame === undefined) continue
            frames.push(frame)
            add(target.site.fn, frame)
          }
        }
      } finally {
        if (building!.spoiled.pop() !== true) settled.set(call, frames)
      }
    }
    return index
  }

  /** Whether a function is called where it is made: `(function(_super){ … })(Base)`. */
  function invokedInPlace(fn: AstNode): boolean {
    const parent = parentOf(fn)
    return parent !== undefined && (parent.type === 'CallExpression' || parent.type === 'NewExpression') && parent['callee'] === fn
  }

  /** Whether two rounds of the index found the same frames. */
  function sameIndex(a: ReadonlyMap<AstNode, Frame[]>, b: ReadonlyMap<AstNode, Frame[]>): boolean {
    if (a.size !== b.size) return false
    for (const [fn, frames] of b) {
      const other = a.get(fn)
      if (other === undefined || other.length !== frames.length) return false
      const ids = new Set(other.map((frame) => frame.id))
      if (!frames.every((frame) => ids.has(frame.id))) return false
    }
    return true
  }

  /**
   * While the dynamic-call index is built: the frames, field-write instances and memoized values that depend on the part
   * of it built so far, which are the build's alone, and for each value being evaluated, whether it read one of them.
   */
  let building:
    | {
        constants: Map<AstNode, Map<string, Declared | 'pending'>>
        frames: { deep: Map<AstNode, Frame[]>; shallow: Map<AstNode, Frame[]> }
        judged: Map<AstNode, Frame[]>
        writeInstances: Map<FieldWrite, WriteInstance[]>
        writePlaces?: Map<FieldWrite, WriteInstance[]>
        thunkFrames?: Map<string, { thunk: Frame; factory: Frame[] } | null>
        instances?: Instances
        lists?: Map<string, { lists: Collection[]; reads: ReadonlySet<AstNode> }>
        looks?: Map<string, boolean>
        keyed?: Map<string, Keyed>
        buckets?: Map<AstNode | string, { dynamic: { write: FieldWrite; instance: WriteInstance }[]; copies: { write: FieldWrite; instance: WriteInstance }[] }>
        spoiled: boolean[]
      }
    | undefined

  /** Marks every value being evaluated as read from the part of the index built so far. */
  function spoiled(): void {
    if (building !== undefined) building.spoiled.fill(true)
  }

  /**
   * Runs one round of building the index, with its own memos for what depends on it, and no limitation raised: the
   * code's own evaluation raises them. A memoized value the round keeps as the code's raises its own (`evaluated`).
   */
  function sandboxed<T>(run: () => T, apart?: NonNullable<typeof building>): T {
    const saved = { nesting, cutting, quiet, immediate, building }
    nesting = []
    cutting = []
    building = apart ?? { constants: new Map(), frames: { deep: new Map(), shallow: new Map() }, judged: new Map(), writeInstances: new Map(), spoiled: [] }
    collectors.push(new Set())
    readers.push(new Set())
    try {
      return run()
    } finally {
      collectors.pop()
      readers.pop()
      ;({ nesting, cutting, quiet, immediate, building } = saved)
    }
  }

  /** A function object: the closure it was made in, and the object it is held on, if its `this` is one. */
  interface FunctionObject {
    closure: Frame | undefined
    receiver?: HeapValue
    created: AstNode
  }

  /** The closures a function or class made at `node` is made in: one per frame of its lexical owner. */
  function creationFrames(node: AstNode): (Frame | undefined)[] {
    const owner = lexicalOwner(node)
    if (owner === undefined) return [undefined]
    const found = framesOf(owner)
    return found.length === 0 ? [undefined] : found.map((frame) => frameAt(frame, node, owner))
  }

  /**
   * The function objects of `fn`: each closure it is made in, and for a function with a `this` of its own,
   * each object it is shown to be held on. A class member runs with every analyzed instance of its class or a subclass,
   * or the class's generic instance when no `new` of it was analyzed, and a static member with the class. Any other
   * function runs with each object it is held on, plus the instances of `new F` when that object is `F.prototype`.
   * A function held on nothing has an unknown `this`.
   */
  function functionObjects(fn: AstNode, deep: boolean): FunctionObject[] {
    const cls = classOfConstructor(fn)
    if (cls !== undefined) {
      // A constructor runs for the instances its `new`s make, which are resolved calls: only a class that no `new`
      // reaches has an object of its own, its generic instance.
      if (instancesOfClass(cls).length > 0) return []
      return creationFrames(cls).map((closure) => ({ closure, receiver: genericInstance(cls, closure), created: cls }))
    }
    // A function with no `this` of its own has an object per closure, which only a `deep` write needs.
    const closures = (): FunctionObject[] => (deep ? creationFrames(fn).map((closure) => ({ closure, created: fn })) : [])
    if (fn.type === 'ArrowFunctionExpression') return closures()
    const parent = parentOf(fn)
    if (parent?.type === 'MethodDefinition' && parent['value'] === fn) return memberObjects(classOfMember(parent), parent['static'] === true, fn)
    if (parent !== undefined && initializes(parent, fn)) {
      if (parent['static'] === true) return memberObjects(classOfMember(parent), true, fn)
      return creationFrames(fn).flatMap((closure) =>
        (closure === undefined ? [] : receiverValues(closure)).flatMap((value) =>
          isHeap(value) ? [{ closure, receiver: value, created: fn }] : [],
        ),
      )
    }
    const held = heldObjects(fn, deep)
    return held.length === 0 ? closures() : held
  }

  /** The objects a class member runs with (above). */
  function memberObjects(cls: AstNode, statics: boolean, fn: AstNode): FunctionObject[] {
    if (statics) return creationFrames(cls).map((closure) => ({ closure, receiver: functionValue(cls, closure), created: fn }))
    const found: FunctionObject[] = []
    for (const { instance, classes } of instancesOfClass(cls)) {
      for (const value of classes) found.push({ closure: value.heap.at.frame, receiver: instance, created: instance.heap.node })
    }
    if (found.length > 0) return found
    return creationFrames(cls).map((closure) => ({ closure, receiver: genericInstance(cls, closure), created: cls }))
  }

  /** A class's generic instance in a closure: built from its field initializers and constructor with unknown arguments. */
  const genericInstance = (cls: AstNode, closure: Frame | undefined): HeapValue =>
    allocated(cls, closure === undefined ? nowhere : { ...nowhere, frame: closure }, 'instance')

  /** Every analyzed instance of a user function or class: each `new` and `Reflect.construct`, where each runs. */
  let instanceIndex: Instances | undefined
  /**
   * The instance index being found: read meanwhile, it has none, so what is found within it then is provisional. Found
   * within another finding it read before that was done, it is provisional too, and found again once that one is, so
   * each round of building the dynamic-call index, and the code once it is built, finds it first (`buildIndex`).
   */
  let indexingInstances: Finding | undefined
  function instances(): Instances {
    spoiled()
    if (building !== undefined && building.instances !== undefined) return building.instances
    if (building === undefined && instanceIndex !== undefined) return instanceIndex
    if (indexingInstances !== undefined) {
      cutShort(indexingInstances)
      return []
    }
    for (const [root, found] of provisional) {
      if (found.index === undefined || found.index.building !== building) continue
      cutShort(root)
      return found.index.instances
    }
    const self: Finding = { at: open.length }
    indexingInstances = self
    open.push(undefined)
    try {
      const found: Instances = []
      // In document order, whatever order the calls are visited in (§18 Context policy).
      for (const call of inDocumentPosition(calls.allCalls())) {
        if (call.type !== 'NewExpression' && !constructs(call)) continue
        const info = calls.infoOf(call)!
        const owner = lexicalOwner(call)
        const frames = owner === undefined ? [] : framesOf(owner)
        for (const frame of frames.length === 0 ? [undefined] : frames) {
          const at: Position = { guard: (name) => info.guards.get(name), topLevel: info.topLevel, frame }
          const instance = allocated(call, at, 'instance')
          const ctors = constructorsOf(instance.heap).filter(isFunctionValue)
          if (ctors.length > 0) found.push({ instance, ctors })
        }
      }
      // Found while a finding it read was being found: found again once that one is.
      const root = open.at(-1)
      if (root !== undefined) provisionalOf(root).index = { building, instances: found }
      else if (building !== undefined) building.instances = found
      else instanceIndex = found
      return found
    } finally {
      closeOpen()
      indexingInstances = undefined
      provisional.delete(self)
    }
  }

  /** Whether a call is `Reflect.construct(…)`, by its spelling. */
  function constructs(call: AstNode): boolean {
    const callee = calleeExpression(call['callee'] as AstNode)
    return callee.type === 'MemberExpression' && callee['computed'] !== true && (callee['property'] as AstNode)['name'] === 'construct'
  }

  /** The analyzed instances of a class or a subclass, each with the values of that class in its chain. */
  function instancesOfClass(cls: AstNode): { instance: HeapValue; classes: HeapValue[] }[] {
    const found: { instance: HeapValue; classes: HeapValue[] }[] = []
    for (const { instance, ctors } of instances()) {
      const classes = ctors.flatMap((ctor) => classChain(ctor).filter((value) => value.heap.node === cls))
      if (classes.length > 0) found.push({ instance, classes })
    }
    return found
  }

  /** The analyzed instances of `new F` for a function value `F`. */
  function instancesOfFunction(fn: HeapValue): HeapValue[] {
    return instances().flatMap(({ instance, ctors }) =>
      ctors.some((ctor) => classChain(ctor).some((value) => isAllocation(value, fn.heap))) ? [instance] : [],
    )
  }

  /**
   * The objects a plain function is held on, each with the closure it is made in: a literal whose property it
   * is and the objects that literal is copied into, the object an assignment stores it on, or the object a
   * `defineProperty` gives it to as its `value`, directly or through a variable that holds it. An object that is
   * `F.prototype` adds the instances of `new F`. A native holder isn't one here: what a function stored on one runs
   * with is left open.
   */
  function heldObjects(fn: AstNode, deep: boolean): FunctionObject[] {
    const found: FunctionObject[] = []
    const seen = new Set<string>()
    const push = (closure: Frame | undefined, receiver: HeapValue) => {
      const key = `${closure?.id ?? ''}/${receiver.heap.id}`
      if (seen.has(key)) return
      seen.add(key)
      found.push({ closure, receiver, created: receiver.heap.node })
    }
    for (const node of standsFor(fn)) {
      for (const expression of holderExpressions(node)) {
        const owner = lexicalOwner(fn)
        const same = lexicalOwner(expression) === owner
        // Without `deep`, the object is judged in the frames of the code that stores it, with no closure.
        const closures = deep ? creationFrames(fn) : [undefined]
        for (const closure of closures) {
          const frames = deep && same ? [closure] : creationFramesOfCode(expression)
          for (const frame of frames) {
            const at: Position = { ...nowhere, topLevel: thisOwner(expression) === undefined, ...(frame === undefined ? {} : { frame }) }
            for (const value of evaluate(expression, at)) {
              // A native holder isn't one (see above).
              if (!isHeap(value)) continue
              push(closure, value)
              for (const ctor of prototypeOwners(value, expression, at)) for (const instance of instancesOfFunction(ctor)) push(closure, instance)
            }
          }
        }
      }
    }
    return found
  }

  /** The frames code at `node` runs in: its lexical owner's, or none. */
  function creationFramesOfCode(node: AstNode): (Frame | undefined)[] {
    return creationFrames(node)
  }

  /** The nodes that stand for a function where it is stored: itself, and each read of a name bound to it alone. */
  function standsFor(fn: AstNode): AstNode[] {
    const nodes = [fn]
    const parent = parentOf(fn)
    const id =
      fn.type === 'FunctionDeclaration'
        ? (fn['id'] as AstNode | null)
        : parent?.type === 'VariableDeclarator' && parent['init'] === fn && (parent['id'] as AstNode).type === 'Identifier'
          ? (parent['id'] as AstNode)
          : null
    if (id === null || id === undefined) return nodes
    const key = referenceKey(id)
    if (key === undefined) return nodes
    for (const { id: reference } of referencesOf(key.name)) {
      if (reference === id) continue
      const found = referenceKey(reference)
      if (found !== undefined && found.scope === key.scope && found.name === key.name) nodes.push(reference)
    }
    return nodes
  }

  /** The expressions whose objects hold what `node` gives, where it is stored (above). */
  function holderExpressions(node: AstNode): AstNode[] {
    const parent = parentOf(node)
    if (parent === undefined) return []
    if (parent.type === 'AssignmentExpression' && parent['right'] === node) {
      const left = parent['left'] as AstNode
      return left.type === 'MemberExpression' && (left['object'] as AstNode).type !== 'Super' ? [left['object'] as AstNode] : []
    }
    if (parent.type !== 'Property' || parent['value'] !== node || parent['kind'] !== 'init') return []
    const literal = parentOf(parent)!
    const around = parentOf(literal)
    // A descriptor's `value`: `Object.defineProperty(o, k, { value: f })`, `Object.defineProperties(o, { k: { value: f } })`.
    const key = memberKey(parent, nowhere)
    if (key === 'value' && around?.type === 'CallExpression' && (around['arguments'] as AstNode[])[2] === literal && calledAs(around, 'defineProperty')) {
      return [(around['arguments'] as AstNode[])[0]!]
    }
    if (key === 'value' && around?.type === 'Property' && around['value'] === literal) {
      const map = parentOf(around)!
      const call = parentOf(map)
      if (call?.type === 'CallExpression' && (call['arguments'] as AstNode[])[1] === map && calledAs(call, 'defineProperties')) {
        return [(call['arguments'] as AstNode[])[0]!]
      }
    }
    // A mixin: `Object.assign(target, …, { m(){} })` copies the literal's fields into the target.
    if (around?.type === 'CallExpression' && calledAs(around, 'assign')) {
      const args = around['arguments'] as AstNode[]
      const index = args.indexOf(literal)
      if (index > 0) return [literal, args[0]!]
    }
    return [literal]
  }

  /** Whether a call's callee is spelled as a method `name`. */
  function calledAs(call: AstNode, name: string): boolean {
    const callee = calleeExpression(call['callee'] as AstNode)
    return callee.type === 'MemberExpression' && callee['computed'] !== true && (callee['property'] as AstNode)['name'] === name
  }

  /**
   * The functions `F` whose `F.prototype` an object is: the prototype a function is made with, or a literal assigned as
   * one (`F.prototype = { … }`).
   */
  function prototypeOwners(value: HeapValue, expression: AstNode, at: Position): HeapValue[] {
    if (value.heap.kind === 'prototype') return [allocated(value.heap.node, value.heap.at, 'function')]
    const parent = parentOf(expression)
    if (parent?.type !== 'AssignmentExpression' || parent['right'] !== expression) return []
    const left = parent['left'] as AstNode
    if (left.type !== 'MemberExpression' || propertyNameOf(left, at) !== 'prototype') return []
    return evaluate(left['object'] as AstNode, at).filter(isFunctionValue)
  }

  /**
   * The `creation` frames of `fn`: its function objects that no resolved frame reaches. One made at the top
   * level with no `this` of its own is the function run with no frame at all, so it has none.
   */
  function callerLessFrames(fn: AstNode, resolved: readonly Frame[], deep: boolean): Frame[] {
    const out: Frame[] = []
    const seen = new Set<string>()
    for (const object of functionObjects(fn, deep)) {
      // Only a write that reads what the function closes over needs a frame per closure (`deep`).
      const closure = deep ? object.closure : undefined
      const { receiver, created } = object
      if (closure === undefined && receiver === undefined) continue
      const key = `${closure?.id ?? ''}/${receiver?.heap.id ?? ''}`
      if (seen.has(key)) continue
      seen.add(key)
      const covered = resolved.some(
        (frame) =>
          (!deep || frame.outer?.id === closure?.id) &&
          (receiver === undefined || receiverValues(frame).some((value) => isHeap(value) && value.heap.id === receiver.heap.id)),
      )
      if (!covered) out.push(creationFrame(fn, closure, receiver, created))
    }
    return out
  }


  // The heap (§5 Resolver capabilities 5): a flow-insensitive heap keyed by allocation site. An object literal, an array
  // literal, a `new` expression and the objects some natives return are allocation sites, one per summary
  // instantiation and unrolled loop iteration: the frame the site is evaluated in. A field's values are those its
  // literal gives it and those the code writes to it anywhere, through any expression that may denote the object. A
  // field written after allocation may be absent, which touches presence only: a read returns only the values written.
  // Every value read from the heap carries a heap fold, so it never decides a test. An expando on a native holder, and
  // on the global object, is a heap cell too, and the global object's is shared by free names and the member forms on
  // the global object (§5 Global resolution).

  const allocations = new Map<string, Allocation>()

  /**
   * The namespace object an interop wrapper's call makes of a CommonJS module (§6, `__toESM(m)`), whose fields
   * `baseField` gives, after the call's module-link hop when its argument runs a module. Undefined for any other call.
   */
  function namespaceObject(call: AstNode, at: Position): Value[] | undefined {
    if (!context.links.namespaces.has(call)) return undefined
    const value = allocated(call, at, 'literal')
    const hop = context.links.moduleCalls.get(call)
    return [hop === undefined ? value : withFolds(value, [{ node: call, name: 'module-link', value: undefined, link: hop }])]
  }

  /** The object an allocation site makes where it is evaluated, the same object for the same site and frame. */
  function allocated(node: AstNode, at: Position, kind: Allocation['kind']): HeapValue {
    const frame = at.frame?.id
    // A class node is a function, its prototype and its generic instance, so those kinds tell them apart.
    const tagged = kind === 'function' || kind === 'prototype' || (kind === 'instance' && isClass(node))
    const id = `${node.start}:${node.end}${tagged ? `#${kind}` : ''}@${frame ?? ''}`
    let allocation = allocations.get(id)
    if (allocation === undefined) allocations.set(id, (allocation = { id, node, at, frame, kind }))
    return { kind: 'object', heap: allocation }
  }

  /**
   * A value read from the heap, where `node` gave it: after the heap fold that marks it (§14 records no step). With
   * `decides`, the call argument literal it is a field of.
   */
  function heapValue(value: Value, node: AstNode, decides?: Allocation): Value {
    if (value.kind === 'unknown') return value
    const fold: Fold = { node, name: '.', value: undefined, heap: true, ...(decides ? { decides } : {}) }
    return { ...value, folds: mergedFolds(carriesFolds(value) ? (value.folds ?? []) : [], [fold]) } as Value
  }

  /** A value read through the once-flag `id`: after the fold that marks it, so it never decides a test (§14: no step). */
  function flagValue(value: Value, id: AstNode): Value {
    if (!carriesFolds(value)) return value
    const fold: Fold = { node: id, name: '?', value: undefined, flag: true }
    return { ...value, folds: mergedFolds(value.folds ?? [], [fold]) } as Value
  }

  /** A value without the folds that mark it read through a once-flag: what it is, rather than whether it decides. */
  function unflagged(value: Value): Value {
    if (!carriesFolds(value) || !(value.folds?.some((fold) => fold.flag === true) ?? false)) return value
    return { ...value, folds: value.folds!.filter((fold) => fold.flag !== true) } as Value
  }

  /** A value read through an object, after the folds the object comes from. */
  function through(value: Value, folds: readonly Fold[] | undefined): Value {
    if (folds === undefined || folds.length === 0 || value.kind === 'unknown') return value
    return { ...value, folds: mergedFolds(folds, carriesFolds(value) ? (value.folds ?? []) : []) } as Value
  }

  /**
   * The objects some natives return, as allocation sites: `Object.getOwnPropertyDescriptor`'s descriptor, whose base
   * fields are unseen; `Object.assign(literal, …sources)`, a copy, or the target it returns; and
   * `Object.create(null)`, which is treated like `{}`. Undefined for any other call.
   */
  function nativeObject(call: AstNode, at: Position): Value[] | undefined {
    const callee = calleeExpression(call['callee'] as AstNode)
    const args = call['arguments'] as AstNode[]
    if (args.some((arg) => arg.type === 'SpreadElement')) return undefined
    if (callee.type === 'MemberExpression' && callee['computed'] !== true && (callee['object'] as AstNode).type !== 'Super') {
      const name = (callee['property'] as AstNode)['name']
      // `f.bind(t, …args)` of a function value is a bound function (§5 Resolver capabilities 3).
      if (name === 'bind') {
        const functions = evaluate(callee['object'] as AstNode, at)
        return functions.length > 0 && functions.every(isCallable) ? [allocated(call, at, 'bound')] : undefined
      }
      if (name === 'create') {
        const [proto] = args
        if (args.length !== 1 || proto?.type !== 'Literal' || proto['value'] !== null) return undefined
        const [only, ...more] = evaluate(callee['object'] as AstNode, at)
        return more.length === 0 && only?.kind === 'holder' && only.holder === 'Object' ? [allocated(call, at, 'literal')] : undefined
      }
      if (name !== 'getOwnPropertyDescriptor' && name !== 'assign' && name !== 'construct') return undefined
    } else if (callee.type !== 'Identifier') return undefined
    const natives = callee.type === 'Identifier' ? aliasCallee(callee, at) : evaluate(callee, at)
    const [native, ...others] = natives
    if (native?.kind !== 'native' || others.length > 0) return undefined
    switch (native.name) {
      case 'Object.getOwnPropertyDescriptor':
      case 'Reflect.getOwnPropertyDescriptor':
        return [allocated(call, at, 'returned')]
      // `Reflect.construct(F, args)` makes an instance of F, as `new F(...args)` does.
      case 'Reflect.construct':
        return [allocated(call, at, 'instance')]
      case 'Object.assign': {
        const [target] = args
        if (target === undefined) return undefined
        return target.type === 'ObjectExpression' ? [allocated(call, at, 'copy')] : evaluate(target, at)
      }
      default:
        return undefined
    }
  }

  /**
   * A write to a field the heap may hold: an assignment or update of a member (`o.k = v`, `o[k] ||= v`, `o.k++`), a
   * define of one (`Object.defineProperty(o, k, d)`), or an `Object.assign(o, …sources)` into an object that isn't a
   * fresh literal. `key` is the member when the syntax names it, and `keyNode` the expression that gives it otherwise.
   * `value` is the expression whose value is written, or undefined when the syntax doesn't show it.
   */
  interface FieldWrite {
    site: AstNode
    object: AstNode
    key?: string
    keyNode?: AstNode
    value?: AstNode
    /** For an export the module-linking definer defines (§6): the expression whose value is its getter. */
    getter?: AstNode
    /** For an export the definer defines in a module, the module and the export's name. */
    link?: ModuleLink
    sources?: AstNode[]
    topLevel: boolean
  }

  /** Where a field write is evaluated, with what its object is there. */
  interface WriteInstance {
    at: Position
    objects: Value[]
  }

  let fieldWriteIndex: { byKey: Map<string, FieldWrite[]>; dynamic: FieldWrite[]; copies: FieldWrite[] } | undefined
  /** The program's field writes, found once: by the key the syntax names, those whose key it doesn't, and copies. */
  function fieldWrites(): NonNullable<typeof fieldWriteIndex> {
    if (fieldWriteIndex !== undefined) return fieldWriteIndex
    const byKey = new Map<string, FieldWrite[]>()
    const dynamic: FieldWrite[] = []
    const copies: FieldWrite[] = []
    let boundaries = 0
    const opened: AstNode[] = []
    const add = (write: Omit<FieldWrite, 'topLevel' | 'key' | 'keyNode'>, property: AstNode, computed: boolean) => {
      const key = computed ? staticKey(property) : property.type === 'Identifier' ? (property['name'] as string) : undefined
      const each: FieldWrite = { ...write, topLevel: boundaries === 0, ...(key === undefined ? { keyNode: property } : { key }) }
      if (key === undefined) {
        if (computed) dynamic.push(each)
        return
      }
      const list = byKey.get(key)
      if (list === undefined) byKey.set(key, [each])
      else list.push(each)
    }
    walkTree(program, {
      enter(node, parent) {
        // The module-linking definer's own defines, which its modeled defines stand for (§6).
        if (context.links.definers.has(node)) return false
        if (
          node.type === 'FunctionDeclaration' ||
          node.type === 'FunctionExpression' ||
          node.type === 'StaticBlock' ||
          ((parent?.type === 'PropertyDefinition' || parent?.type === 'AccessorProperty') && parent['value'] === node)
        ) {
          boundaries++
          opened.push(node)
        }
        const member = (target: AstNode) =>
          target.type === 'MemberExpression' && (target['object'] as AstNode).type !== 'Super' ? target : undefined
        if (node.type === 'AssignmentExpression') {
          const target = member(node['left'] as AstNode)
          if (target === undefined) return
          const kept = writeBackOperators.has(node['operator'] as string)
          const write = { site: node, object: target['object'] as AstNode, ...(kept ? { value: node['right'] as AstNode } : {}) }
          add(write, target['property'] as AstNode, target['computed'] === true)
        } else if (node.type === 'UpdateExpression') {
          const target = member(node['argument'] as AstNode)
          if (target !== undefined) add({ site: node, object: target['object'] as AstNode }, target['property'] as AstNode, target['computed'] === true)
        } else if (node.type === 'CallExpression') {
          const callee = calleeExpression(node['callee'] as AstNode)
          if (callee.type !== 'MemberExpression' || callee['computed'] === true) return
          const name = (callee['property'] as AstNode)['name']
          const args = node['arguments'] as AstNode[]
          if (args.some((arg) => arg.type === 'SpreadElement')) return
          if (name === 'defineProperty' && args.length >= 3) {
            const value = args[2]!.type === 'ObjectExpression' ? literalValue(args[2]!) : undefined
            add({ site: node, object: args[0]!, ...(value === undefined ? {} : { value }) }, args[1]!, true)
          } else if (name === 'assign' && args.length >= 2 && args[0]!.type !== 'ObjectExpression') {
            copies.push({ site: node, object: args[0]!, sources: args.slice(1), topLevel: boundaries === 0 })
          }
        }
      },
      leave(node) {
        if (opened.at(-1) === node) {
          opened.pop()
          boundaries--
        }
      },
    })
    // The defines of the module-linking definer's calls (§6), each a write of its export's getter or value.
    for (const { site, object, key, getter, value, link } of context.links.defines) {
      const write: FieldWrite = {
        site,
        object,
        key,
        ...(getter === undefined ? {} : { getter }),
        ...(value === undefined ? {} : { value }),
        ...(link === undefined ? {} : { link }),
        topLevel: false,
      }
      const list = byKey.get(key)
      if (list === undefined) byKey.set(key, [write])
      else list.push(write)
    }
    return (fieldWriteIndex = { byKey, dynamic, copies })
  }

  const codeWriteInstances = new Map<FieldWrite, WriteInstance[]>()
  /** The writes whose instances are being found. */
  const instancing = new Map<FieldWrite, Finding>()

  /**
   * Where a field write runs, each with what its object is there: once, or in each frame of the innermost function or
   * loop around it whose parameters or iterations its object, key or value read (§5 Resolver capabilities 3 and 4).
   */
  function instancesOf(write: FieldWrite): WriteInstance[] {
    // Where a write runs depends on frames, so while the dynamic-call index is built it is the build's alone.
    spoiled()
    const writeInstances = building === undefined ? codeWriteInstances : building.writeInstances
    const known = writeInstances.get(write)
    if (known !== undefined) return known
    // A write whose object is found through itself adds nothing to it, so what is found within is provisional.
    return finding(
      instancing,
      write,
      (found) => found.instances,
      (found) => writeInstances.set(write, found),
      () => {
        const asked = new Set<AstNode>()
        reentries.push(asked)
        try {
          const found = instancesFound(write)
          if ([...asked].some((context) => within(context, write.site))) frameless.add(found)
          return found
        } finally {
          reentries.pop()
        }
      },
      [],
    )
  }

  /** A write's instances, found (`instancesOf`). */
  function instancesFound(write: FieldWrite): WriteInstance[] {
    return quietly(() => {
      const base: Position = { guard: () => undefined, topLevel: write.topLevel }
      const first = contextual(() => evaluate(write.object, base))
      const read = new Set(first.functions)
      // Only an object the heap may write through is worth the frames its key and value read.
      if (first.value.some((value) => isHeap(value) || value.kind === 'holder')) {
        const parts = [write.keyNode, write.value, write.getter].filter((part) => part !== undefined)
        for (const fn of contextual(() => parts.forEach((part) => evaluate(part, base))).functions) read.add(fn)
      }
      return framed(write, base, first.value, read)
    })
  }

  /** The functions and loops whose frames were asked for while they were being found, one set per write instancing. */
  const reentries: Set<AstNode>[] = []
  /**
   * Instances found while the frames of a function or loop around their write were being found: `f(t, t.x)` finds the
   * frames of `f` by reading `t.x`, which finds where `f`'s `t.x =` runs, in `f`'s frames. They are provisional on
   * those frames (`finding`), and lack them.
   */
  const frameless = new WeakSet<WriteInstance[]>()

  /**
   * A write's instances: one in each frame of the innermost function around it whose parameters `read` has, or else
   * one where it is, writing through `objects`.
   */
  function framed(write: FieldWrite, base: Position, objects: Value[], read: ReadonlySet<AstNode>): WriteInstance[] {
    let context: AstNode | undefined
    for (const fn of read) if (within(fn, write.site) && (context === undefined || within(context, fn))) context = fn
    if (context !== undefined) {
      const frames = framesOf(context, [...read].some((fn) => fn !== context))
      if (frames.length > 0) return frames.map((frame) => ({ at: { ...base, frame }, objects: evaluate(write.object, { ...base, frame }) }))
    }
    return [{ at: base, objects }]
  }

  const codeWritePlaces = new Map<FieldWrite, WriteInstance[]>()
  /** The writes whose objects are being found. */
  const placing = new Map<FieldWrite, Finding>()

  /**
   * Where a write may run, with the objects it writes through there, in each frame its object reads (`instancesOf`
   * without the frames its key and value read, which reads none of what it writes).
   */
  function placesOf(write: FieldWrite): WriteInstance[] {
    spoiled()
    const writePlaces = building === undefined ? codeWritePlaces : (building.writePlaces ??= new Map())
    // A write's instances, once found, give its objects in every frame it runs in.
    const known = writePlaces.get(write) ?? (building === undefined ? codeWriteInstances : building.writeInstances).get(write)
    if (known !== undefined) return known
    return finding(
      placing,
      write,
      (found) => found.places,
      (found) => writePlaces.set(write, found),
      () =>
        quietly(() => {
          const base: Position = { guard: () => undefined, topLevel: write.topLevel }
          const first = contextual(() => evaluate(write.object, base))
          return framed(write, base, first.value, first.functions)
        }),
      [],
    )
  }

  const instanceKeys = new WeakMap<WriteInstance, Value[]>()
  /** The keys a dynamic write's instance may write, evaluated once. */
  function keysAt(write: FieldWrite, instance: WriteInstance): Value[] | undefined {
    if (write.keyNode === undefined) return undefined
    let keys = instanceKeys.get(instance)
    if (keys === undefined) instanceKeys.set(instance, (keys = quietly(() => evaluate(write.keyNode!, instance.at))))
    return keys
  }

  /** Whether a value written through may be the allocation: the same site, in the same frame or in either's any. */
  const isAllocation = (value: Value, allocation: Allocation): boolean =>
    isHeap(value) &&
    value.heap.node === allocation.node &&
    value.heap.kind === allocation.kind &&
    (value.heap.frame === undefined || allocation.frame === undefined || value.heap.frame === allocation.frame)

  /** Whether a dynamic key written may be `key`: it may be unknown, or folds to it. */
  const mayBe = (keys: readonly Value[], key: string): boolean =>
    keys.some((each) => each.kind !== 'constant' || (typeof each.value !== 'symbol' && String(each.value) === key))

  /**
   * The values written to the field `key` of the objects `matches` accepts, anywhere in the program, each after the heap
   * fold of the expression that gives it: by assignments, updates and defines, and copied by `Object.assign`.
   */
  function writtenValues(key: string, matches: (value: Value) => boolean, bucket: AstNode | string): Value[] {
    const { byKey, dynamic, copies } = fieldWrites()
    const values: Value[] = []
    const bucketed = writesInto(bucket)
    const keyed = keyedInto(key, bucket)
    const each = [
      ...(keyed ?? (byKey.get(key) ?? []).flatMap((write) => instancesOf(write).map((instance) => ({ write, instance })))),
      ...(bucketed === undefined
        ? dynamic.flatMap((write) => instancesOf(write).map((instance) => ({ write, instance })))
        : bucketed.dynamic),
    ]
    for (const { write, instance } of each) {
      {
        if (!instance.objects.some(matches)) continue
        const keys = keysAt(write, instance)
        if (keys !== undefined && !mayBe(keys, key)) continue
        if (write.getter !== undefined) {
          values.push(...getterValues(write, instance))
          continue
        }
        const known = write.value !== undefined && (keys === undefined || keys.every((each) => each.kind === 'constant'))
        const written = known ? quietly(() => evaluate(write.value!, instance.at)) : [unknown]
        for (const value of written) {
          const read = heapValue(value, write.value ?? write.site)
          values.push(write.link === undefined ? read : linked(read, write.value!, write.link))
        }
      }
    }
    const copied =
      bucketed === undefined ? copies.flatMap((write) => instancesOf(write).map((instance) => ({ write, instance }))) : bucketed.copies
    for (const { write, instance } of copied) {
      if (!instance.objects.some(matches)) continue
      for (const source of write.sources!) values.push(...copiedValues(quietly(() => evaluate(source, instance.at)), key))
    }
    return values
  }

  /**
   * What reading an export the module-linking definer defines with a getter gives (§6): what the getter returns, run
   * with no call around it in the frame it was made in, after the export's `module-link` fold.
   */
  function getterValues(write: FieldWrite, instance: WriteInstance): Value[] {
    const values: Value[] = []
    for (const getter of quietly(() => evaluate(write.getter!, instance.at))) {
      if (!isFunctionValue(getter) || getter.heap.node['async'] === true || getter.heap.node['generator'] === true) {
        values.push(unknown)
        continue
      }
      const fn = getter.heap.node
      const frame = creationFrame(fn, getter.heap.at.frame, undefined, write.getter!)
      const found = memoized({
        key: fn,
        name: `return@${frame.id}`,
        fallback: write.getter!,
        compute: () => ({ values: returnValues(fn, frame), node: write.getter! }),
      })
      noted(found)
      for (const value of found.values) {
        const read = heapValue(value, write.getter!)
        values.push(write.link === undefined ? read : linked(read, write.getter!, write.link))
      }
    }
    return values
  }

  /** A value that came through a module link at `node` (§6), after the link's fold. */
  function linked(value: Value, node: AstNode, link: ModuleLink): Value {
    if (!carriesFolds(value)) return value
    const fold: Fold = { node, name: 'module-link', value: undefined, link }
    return { ...value, folds: mergedFolds(value.folds ?? [], [fold]) } as Value
  }

  /** A write whose key the syntax doesn't name, or a copy, where it runs. */
  type Placed = { write: FieldWrite; instance: WriteInstance }
  type Buckets = Map<AstNode | string, { dynamic: Placed[]; copies: Placed[] }>
  let codeBuckets: Buckets | undefined
  let bucketing = false

  /**
   * The writes whose key the syntax names, by key, placed by the objects they write: those made at one allocation site
   * (by its node), or a native holder (`h:<holder>`), in document order, found once per key. Undefined while they are
   * being placed, when every write is looked at. A write whose instances lack the frames of the function around it
   * (`frameless`) is pending: while the finding they wait on is open, they are read as they are, and afterwards the
   * write is placed again, until its instances are found for good. So `f(t, t.x)` keeps the field `f` writes, whichever
   * is visited first. While the dynamic-call index is built, each round places a write once, as it finds it.
   */
  let codeKeyed: Map<string, Keyed> | undefined
  /** A key's placed writes, its pending writes with the instances last placed, and each write's document order. */
  interface Keyed {
    buckets: Map<AstNode | string, Placed[]>
    pending: Map<FieldWrite, WriteInstance[]>
    order: Map<FieldWrite, number>
  }
  /** The keys whose writes are being placed. */
  const keying = new Set<string>()

  /** The writes whose key the syntax names as `key` that may write objects of one kind (above). */
  function keyedInto(key: string, bucket: AstNode | string): Placed[] | undefined {
    if (keying.has(key)) return undefined
    let all = building === undefined ? codeKeyed : building.keyed
    if (all === undefined) {
      all = new Map()
      if (building === undefined) codeKeyed = all
      else building.keyed = all
    }
    spoiled()
    const known = all.get(key)
    if (known !== undefined && known.pending.size === 0) return known.buckets.get(bucket) ?? []
    const writes = known === undefined ? (fieldWrites().byKey.get(key) ?? []) : [...known.pending.keys()]
    const order = known?.order ?? new Map(writes.map((write, index) => [write, index]))
    const keyed: Keyed = known ?? { buckets: new Map(), pending: new Map(), order }
    // Stopped by a value past the nesting cap (`chain`), nothing of this placing is kept.
    const settled: { at: AstNode | string; placed: Placed }[] = []
    const tentative: Placed[] = []
    const pending = new Map<FieldWrite, WriteInstance[]>()
    keying.add(key)
    try {
      for (const write of writes) {
        const stale = known?.pending.get(write)
        const instances = stale !== undefined && stillProvisional(write, stale) ? stale : instancesOf(write)
        // Instances kept for good are found, even if frames they asked for were being found within their own finding.
        const found = building !== undefined || !frameless.has(instances) || codeWriteInstances.get(write) === instances
        if (!found) pending.set(write, instances)
        for (const instance of instances) {
          const seen = new Set<AstNode | string>()
          for (const object of instance.objects) {
            const at = isHeap(object) ? object.heap.node : object.kind === 'holder' ? `h:${object.holder}` : undefined
            if (at === undefined || seen.has(at)) continue
            seen.add(at)
            if (found) settled.push({ at, placed: { write, instance } })
            else if (at === bucket) tentative.push({ write, instance })
          }
        }
      }
    } finally {
      keying.delete(key)
    }
    for (const { at, placed } of settled) {
      const list = keyed.buckets.get(at)
      if (list === undefined) keyed.buckets.set(at, [placed])
      else insertInOrder(list, placed, keyed.order)
    }
    keyed.pending = pending
    if (known === undefined) all.set(key, keyed)
    const placed = keyed.buckets.get(bucket) ?? []
    if (tentative.length === 0) return placed
    return [...placed, ...tentative].sort((a, b) => keyed.order.get(a.write)! - keyed.order.get(b.write)!)
  }

  /** Whether a write's instances are still provisional on a finding not yet done. */
  function stillProvisional(write: FieldWrite, instances: WriteInstance[]): boolean {
    for (const found of provisional.values()) if (found.instances.get(write) === instances) return true
    return false
  }

  /** Adds a placed write to a bucket after every write before it in document order, and its own earlier instances. */
  function insertInOrder(list: Placed[], placed: Placed, order: Map<FieldWrite, number>): void {
    const at = order.get(placed.write)!
    let index = list.length
    while (index > 0 && order.get(list[index - 1]!.write)! > at) index--
    list.splice(index, 0, placed)
  }

  /**
   * The writes whose key the syntax doesn't name, and the copies, that may write objects of one kind (`keyedInto`),
   * found once. Undefined while they are being found, when every write is looked at.
   */
  function writesInto(bucket: AstNode | string): { dynamic: Placed[]; copies: Placed[] } | undefined {
    if (bucketing) return undefined
    const current = building === undefined ? codeBuckets : building.buckets
    if (current !== undefined) {
      spoiled()
      return current.get(bucket) ?? { dynamic: [], copies: [] }
    }
    const { dynamic, copies } = fieldWrites()
    const buckets: Buckets = new Map()
    bucketing = true
    try {
      const place = (list: readonly FieldWrite[], kind: 'dynamic' | 'copies') => {
        for (const write of list) {
          for (const instance of instancesOf(write)) {
            const seen = new Set<AstNode | string>()
            for (const object of instance.objects) {
              const key = isHeap(object) ? object.heap.node : object.kind === 'holder' ? `h:${object.holder}` : undefined
              if (key === undefined || seen.has(key)) continue
              seen.add(key)
              let entry = buckets.get(key)
              if (entry === undefined) buckets.set(key, (entry = { dynamic: [], copies: [] }))
              entry[kind].push({ write, instance })
            }
          }
        }
      }
      place(dynamic, 'dynamic')
      place(copies, 'copies')
    } finally {
      bucketing = false
    }
    if (building === undefined) codeBuckets = buckets
    else building.buckets = buckets
    return buckets.get(bucket) ?? { dynamic: [], copies: [] }
  }

  /** The values a copy of `sources` (a spread, `Object.assign`) gives the field `key`, with whether it surely does. */
  function copiedField(sources: readonly Value[], key: string): { values: Value[]; surely: boolean } {
    // Spreading `null` or `undefined` copies nothing.
    const copied = sources.filter((value) => !(value.kind === 'constant' && (value.value === null || value.value === undefined)))
    if (!copied.every(isHeap)) return { values: [unknown], surely: false }
    const values: Value[] = []
    let surely = copied.length > 0
    for (const value of copied as HeapValue[]) {
      const found = field(value.heap, key, value.heap.node)
      if (found.presence !== 'yes') surely = false
      if (found.presence !== 'no') values.push(...found.values.map((each) => through(each, value.folds)))
    }
    return { values, surely }
  }

  const copiedValues = (sources: readonly Value[], key: string): Value[] => copiedField(sources, key).values

  /** The field `key` of an allocation, memoized: its values and whether the object has it. */
  function field(allocation: Allocation, key: string, node: AstNode): Declared {
    const found = memoized({
      key: allocation.node,
      name: `.${key}#${allocation.kind}@${allocation.frame ?? ''}`,
      fallback: node,
      compute: () => {
        const exported = moduleExports(allocation, key)
        // A module object's `exports` that its factory surely assigns holds what it assigns (§6).
        const base = exported?.surely === true ? { values: [], presence: 'yes' as const } : baseField(allocation, key)
        const written = exported?.values ?? writtenValues(key, (value) => isAllocation(value, allocation), allocation.node)
        // An object a native returns reads as `{ ...native, <written fields> }`: a written field has the values written.
        const values = allocation.kind === 'returned' && written.length > 0 ? written : [...base.values, ...written]
        const presence = base.presence === 'yes' ? 'yes' : written.length > 0 || base.presence === 'maybe' ? 'maybe' : 'no'
        return { values, node, presence }
      },
    })
    noted(found)
    return found
  }

  /**
   * The literals of the module objects lazy module thunks make (`(mod = { exports: {} })`, §6), each with the thunk's
   * call of its factory, found once.
   */
  let moduleObjects: Map<AstNode, AstNode> | undefined
  /**
   * For each factory of a lazy module thunk, its module parameter's `module.exports = v` writes, and whether one of
   * them surely runs; null when the factory uses its module parameter any other way.
   */
  const factoryExports = new Map<AstNode, { writes: AstNode[]; surely: boolean } | null>()

  /**
   * The values of the field `exports` of a lazy module thunk's module object (§6): what its module's factory assigns to
   * `module.exports`, in the factory's frame that the thunk's frame calls, and whether it surely assigns. Each module's
   * factory writes its own module object, so no other write is looked at. Undefined for any other field or object, or
   * a factory that uses its module parameter in any other way.
   */
  function moduleExports(allocation: Allocation, key: string): { values: Value[]; surely: boolean } | undefined {
    if (key !== 'exports' || allocation.kind !== 'literal') return undefined
    const call = moduleObjectsOf().get(allocation.node)
    const thunk = allocation.at.frame
    const maker = thunk?.outer
    if (call === undefined || thunk === undefined || maker === undefined) return undefined
    const factory = maker.bindings[0]?.site.args[0]
    if (factory === undefined || !isFunction(factory)) return undefined
    const exports = exportsWrites(factory, context.links.factoryCalls.get(call)?.module)
    if (exports === null) return undefined
    const frames = framesOf(factory).filter((frame) => frame.bindings.some((binding) => binding.caller?.id === thunk.id))
    if (frames.length === 0) return undefined
    const values: Value[] = []
    for (const frame of frames) {
      const at: Position = { guard: () => undefined, topLevel: false, frame }
      // What a module exports comes through its module link, whose fold the thunk's call adds (§6), never through the
      // heap.
      for (const write of exports.writes) values.push(...quietly(() => evaluate(write['right'] as AstNode, at)))
    }
    return { values, surely: exports.surely }
  }

  /** The module objects' literals (`moduleObjects`), found once. */
  function moduleObjectsOf(): Map<AstNode, AstNode> {
    if (moduleObjects !== undefined) return moduleObjects
    const found = new Map<AstNode, AstNode>()
    for (const [call, { object }] of context.links.factoryCalls) if (object !== undefined) found.set(object, call)
    return (moduleObjects = found)
  }

  /**
   * What a lazy module thunk returns in its module's frame (§6): its module object's `exports`, whichever way the thunk
   * reaches it. Undefined for any other function or frame.
   */
  function thunkExports(fn: AstNode, frame: Frame): Value[] | undefined {
    if (frame.how !== 'call' || context.links.moduleCalls.get(frame.bindings[0]!.site.call)?.idiom !== 'lazy-thunk') return undefined
    for (const [literal, call] of moduleObjectsOf()) {
      if (call.start < fn.start || fn.end < call.end) continue
      return fieldRead(allocated(literal, { ...nowhere, frame }, 'literal'), 'exports', literal)
    }
    return undefined
  }

  /**
   * A lazy module thunk factory's `module.exports = v` writes (`factoryExports`), and whether one surely runs: it is a
   * statement of the factory's body that no `return` comes before, or the body itself.
   */
  function exportsWrites(factory: AstNode, index: number | undefined): { writes: AstNode[]; surely: boolean } | null {
    const known = factoryExports.get(factory)
    if (known !== undefined) return known
    // The factory's module parameter: `(exports, module)` in esbuild's form, `(module, exports)` in webpack's.
    const param = index === undefined ? undefined : (factory['params'] as AstNode[])[index]
    const body = factory['body'] as AstNode
    let writes: AstNode[] | null = []
    if (param !== undefined && param.type !== 'Identifier') writes = null
    else if (param !== undefined) {
      const name = param['name'] as string
      walkTree(body, {
        enter(node, parent) {
          if (writes === null || node.type !== 'Identifier' || node['name'] !== name) return undefined
          if (definitions.keyOf(node)?.scope !== factory) return undefined
          // `module.exports = v`, or a read of `module.exports`: any other use may write the object some other way.
          const exports =
            parent?.type === 'MemberExpression' &&
            parent['object'] === node &&
            parent['computed'] !== true &&
            (parent['property'] as AstNode)['name'] === 'exports'
          if (!exports) {
            writes = null
            return undefined
          }
          const assignment = parentOf(parent)
          if (assignment?.type === 'AssignmentExpression' && assignment['left'] === parent) {
            if (assignment['operator'] !== '=') writes = null
            else writes.push(assignment)
          }
          return undefined
        },
      })
    }
    let found: { writes: AstNode[]; surely: boolean } | null = null
    if (writes !== null) {
      const assigned = writes
      let surely = assigned.includes(body)
      if (body.type === 'BlockStatement') {
        for (const statement of body['body'] as AstNode[]) {
          if (statement.type === 'ExpressionStatement' && assigned.includes(statement['expression'] as AstNode)) {
            surely = true
            break
          }
          if (holdsReturn(statement)) break
        }
      }
      found = { writes: assigned, surely }
    }
    factoryExports.set(factory, found)
    return found
  }

  /** Whether a statement holds a `return` of its function. */
  function holdsReturn(statement: AstNode): boolean {
    let found = false
    walkTree(statement, {
      enter(node) {
        if (found || isFunction(node)) return false
        if (node.type === 'ReturnStatement') found = true
        return undefined
      },
    })
    return found
  }

  /** What an allocation gives the field `key` before any write: its literal's, a copy's sources', or its base's. */
  function baseField(allocation: Allocation, key: string): { values: Value[]; presence: 'yes' | 'maybe' | 'no' } {
    const { node, at } = allocation
    switch (allocation.kind) {
      case 'literal': {
        // An interop wrapper's namespace object of a CommonJS module (§6): its `default` is the module's exports, and
        // its other keys are theirs.
        const exports = context.links.namespaces.get(node)
        if (exports !== undefined) {
          const values = evaluate(exports, at)
          if (key === 'default') return { values, presence: 'yes' }
          const copied = copiedField(values, key)
          return { values: copied.values, presence: copied.surely ? 'yes' : 'maybe' }
        }
        const own = node.type === 'ObjectExpression' ? literalField(node['properties'] as AstNode[], key, at) : undefined
        // A factory table also holds the factories chunks push into the registry its loader reads (§6 idiom 6), each
        // an alternative (Principle 3).
        const pushed = context.links.chunkFactories.get(node)?.get(key)
        if (pushed !== undefined) {
          const values = [...(own?.values ?? []), ...pushed.flatMap((factory) => evaluate(factory, nowhere))]
          return { values, presence: 'yes' }
        }
        return own ?? { values: [], presence: 'no' }
      }
      case 'copy': {
        const [target, ...sources] = node['arguments'] as AstNode[]
        const values: Value[] = []
        for (const source of sources.toReversed()) {
          const copied = copiedField(evaluate(source, at), key)
          values.push(...copied.values)
          if (copied.surely) return { values, presence: 'yes' }
        }
        const literal = literalField(target!['properties'] as AstNode[], key, at)
        return { values: [...values, ...literal.values], presence: literal.presence === 'yes' ? 'yes' : values.length > 0 ? 'maybe' : literal.presence }
      }
      case 'array':
        // An array's elements and length are capability 4's constant collections, or unknown.
        return /^(?:0|[1-9][0-9]*)$/.test(key) || key === 'length' ? { values: [unknown], presence: 'maybe' } : { values: [], presence: 'no' }
      case 'instance':
        return instanceField(allocation, key)
      case 'returned':
        return { values: [unknown], presence: 'maybe' }
      case 'function':
        return functionField(allocation, key)
      case 'prototype':
        return prototypeField(allocation, key)
      case 'bound':
        return { values: [], presence: 'no' }
    }
  }

  /**
   * What an object literal's properties give the field `key`: the last one that defines it, and the spreads and keys
   * that don't fold after it, which may define it too.
   */
  function literalField(properties: readonly AstNode[], key: string, at: Position): { values: Value[]; presence: 'yes' | 'maybe' | 'no' } {
    const values: Value[] = []
    for (const property of properties.toReversed()) {
      if (property.type === 'SpreadElement') {
        const copied = copiedField(evaluate(property['argument'] as AstNode, at), key)
        values.push(...copied.values)
        if (copied.surely) return { values, presence: 'yes' }
        continue
      }
      const defined = fieldKey(property, at)
      if (defined === undefined) {
        values.push(unknown)
        continue
      }
      if (defined !== key || setsLiteralPrototype(property, defined)) continue
      const value = property['value'] as AstNode
      // A getter gives whatever it returns.
      if (property['kind'] !== 'init') values.push(unknown)
      else for (const each of evaluate(value, at)) values.push(heapValue(each, value))
      return { values, presence: 'yes' }
    }
    return { values, presence: values.length > 0 ? 'maybe' : 'no' }
  }

  /** A literal property's key, evaluated where the literal is: a string, or undefined when it doesn't fold to one. */
  function fieldKey(property: AstNode, at: Position): string | undefined {
    if (property.type !== 'Property') return undefined
    const key = property['key'] as AstNode
    if (property['computed'] !== true) return key.type === 'Identifier' ? (key['name'] as string) : literalKey(key)
    const values = evaluate(key, at)
    const [only] = values
    if (values.length !== 1 || only?.kind !== 'constant' || typeof only.value === 'symbol') return undefined
    return String(only.value)
  }

  /**
   * Whether the constructor a `new` calls may give its instance the field `key`: when it isn't known, or its body
   * writes `this.<key>` or `this[…]`.
   */
  function constructorMayDefine(call: AstNode, key: string): boolean {
    const sites = calls.sitesOf(call)
    if (sites.length === 0 || calls.open(call)) return true
    return sites.some(({ fn }) => {
      let defines = false
      walkTree(fn['body'] as AstNode, {
        enter(node) {
          if (defines) return false
          if (node.type !== 'MemberExpression' || (node['object'] as AstNode).type !== 'ThisExpression') return undefined
          const property = node['property'] as AstNode
          defines = node['computed'] === true || property['name'] === key
          return undefined
        },
      })
      return defines
    })
  }

  /**
   * A field read of an object literal passed directly as a call argument, inside that call's summary instance (§5
   * Resolver capabilities 5): the property's value, or `undefined` for a property the
   * literal lacks, marked as the literal's, so that a test settles it once nothing writes to the literal (`settled`).
   * Undefined for any other read, which stays a heap read: a literal with a spread, a key that doesn't fold or a
   * `__proto__`, an accessor, a key the code writes, a key `Object.prototype` gives (Principle 2), or a read outside
   * the call, as a module-level table's is.
   */
  function argumentRead(value: HeapValue, key: string, node: AstNode, at: Position): Value[] | undefined {
    const { heap } = value
    if (heap.kind !== 'literal' || heap.node.type !== 'ObjectExpression' || !insideCall(heap, at.frame)) return undefined
    if (context.links.namespaces.has(heap.node) || context.links.chunkFactories.has(heap.node)) return undefined
    const properties = heap.node['properties'] as AstNode[]
    if (properties.some((property) => property.type === 'Property' && propertyKey(property) === '__proto__' && setsLiteralPrototype(property, '__proto__'))) {
      return undefined
    }
    const entries = ownEntries(heap.node, heap.at, false)
    if (entries === undefined) return undefined
    // A key the code writes holds what it writes too, so its read is the heap's, which decides nothing.
    if (writtenField(heap, key, node).length > 0) return undefined
    const entry = entries.findLast((each) => each.key === key)
    if (entry === undefined) {
      // A key `Object.prototype` has reads its member (ECMA-262 OrdinaryGet, Principle 2).
      if (firstOwner('Object.prototype', key) !== undefined) return undefined
      return [through(heapValue(constant(undefined), heap.node, heap), value.folds)]
    }
    if (entry.value === undefined) return undefined
    return argumentField(heap, key, entry.value, entry.at).map((each) => through(each, value.folds))
  }

  /** What the code writes to the field `key` of the call argument literal `heap`, memoized per literal and key. */
  function writtenField(heap: Allocation, key: string, node: AstNode): Value[] {
    const found = memoized({
      key: heap.node,
      name: `x120-written.${key}#${heap.id}`,
      fallback: node,
      compute: () => ({ values: writtenValues(key, (each) => isAllocation(each, heap), heap.node), node }),
    })
    noted(found)
    return found.values
  }

  /**
   * The values of a call argument literal's property `key`, whose value `node` is evaluated at `at`, each marked as
   * the literal's, memoized per literal and key.
   */
  function argumentField(heap: Allocation, key: string, node: AstNode, at: Position): Value[] {
    const found = memoized({
      key: node,
      name: `x120.${key}#${heap.id}`,
      fallback: node,
      compute: () => ({ values: evaluate(node, at).map((each) => heapValue(each, node, heap)), node }),
    })
    noted(found)
    return found.values
  }

  /**
   * Whether some field write or copy of the code may write the literal `heap`, as `writtenAfter` finds, through
   * the writes the code places by key and by the kind of object they write (`keyedInto`, `writesInto`). A write whose
   * places are still being found may write it.
   *
   * While the dynamic-call index is built, no write is placed yet (`buildIndex`), so the literal may be written, and
   * whatever met the test is the build's alone (`spoiled`): the code's own evaluation finds it again, settling it.
   * Placing writes from inside a round would place them with the part of the index built so far.
   */
  function literalWritten(heap: Allocation): boolean {
    if (dynamicIndex === undefined && building !== undefined) {
      spoiled()
      return true
    }
    const known = building === undefined ? literalsWritten.get(heap.id) : undefined
    if (known !== undefined) return known
    let settledAll = true
    const lands = (placed: readonly Placed[] | undefined) => {
      if (placed === undefined) settledAll = false
      return placed === undefined || placed.some(({ instance }) => instance.objects.some((object) => isAllocation(object, heap) && !isAssumed(object)))
    }
    let found = false
    for (const key of fieldWrites().byKey.keys()) {
      if (lands(keyedInto(key, heap.node))) {
        found = true
        break
      }
    }
    if (!found) {
      const into = writesInto(heap.node)
      found = into === undefined || lands(into.dynamic) || lands(into.copies)
    }
    // Once every write it looked at was placed in full, the answer holds for the rest of the code's evaluation.
    if (building === undefined && settledAll && open.length === 0) literalsWritten.set(heap.id, found)
    return found
  }

  /** Whether the code writes each call argument literal (`literalWritten`), by allocation, once found in full. */
  const literalsWritten = new Map<string, boolean>()

  /** Whether the evaluation finds where writes land, which settles no test. */
  const unsettling = (): boolean => placing.size > 0 || writing.size > 0 || keying.size > 0 || bucketing

  /**
   * Values a test reads, settled: a call argument literal's field (`argumentRead`) decides the test once nothing
   * writes to the literal. Every other value is left as it is.
   */
  function settled(values: Value[], test?: AstNode): Value[] {
    if (!values.some((value) => carriesFolds(value) && (value.folds?.some((fold) => fold.decides !== undefined && fold.settled !== true) ?? false))) {
      if (test !== undefined) recordDecided(test, values)
      return values
    }
    // Finding where writes land settles nothing: whether a literal is written is what it finds (`literalWritten`). What
    // it evaluates meanwhile is found again afterwards, when a test can be settled.
    if (unsettling()) {
      taintUnsettled()
      return values
    }
    const counter = counterfactualRun
    const found = values.map((value) => {
      if (!carriesFolds(value) || value.folds === undefined) return value
      const folds = value.folds.map((fold) =>
        fold.decides === undefined ||
        fold.settled === true ||
        (counter !== undefined && test !== undefined && counter.unsettles({ test, literal: fold.decides.node })) ||
        literalWritten(fold.decides)
          ? fold
          : { ...fold, settled: true as const },
      )
      return { ...value, folds } as Value
    })
    if (test !== undefined) recordDecided(test, found)
    return found
  }

  /** Records a test that a call argument literal's field decided for each `decided` run around it. */
  function recordDecided(test: AstNode, values: Value[]): void {
    const found = deciding.at(-1)
    if (found === undefined || argumentDecided(values) === undefined) return
    for (const literal of settlingLiterals(values)) found.set(`${test.start}:${test.end}@${literal.start}`, { test, literal })
  }

  /** The tests a call argument literal's field decided, for each `decided` run and memoized value being found. */
  const deciding: Map<string, Decision>[] = []

  /**
   * While a `counterfactual` run is made: the tests it leaves unsettled, and the mark of the names its memoized values
   * are kept under, apart from the code's own.
   */
  let counterfactualRun: { variant: string; unsettles: (decision: Decision) => boolean } | undefined

  /**
   * Whether the frame `frame` is, or runs within, an instance of a call whose arguments hold the literal `heap` as made
   * in the call's own frame.
   */
  function insideCall(heap: Allocation, frame: Frame | undefined): boolean {
    return withinCall(frame, (binding) => binding.site.args.includes(heap.node) && binding.caller?.id === heap.frame)
  }

  /**
   * Whether the frame `frame`, or a frame it runs within (the frame of a closure's creation, or an outer frame), has a
   * call binding that meets `test`.
   */
  function withinCall(frame: Frame | undefined, test: (binding: Binding) => boolean): boolean {
    const seen = new Set<Frame>()
    const pending = frame === undefined ? [] : [frame]
    while (pending.length > 0) {
      const next = pending.pop()!
      if (seen.has(next)) continue
      seen.add(next)
      for (const binding of next.bindings) {
        if (test(binding)) return true
        if (binding.closure !== undefined) pending.push(binding.closure)
      }
      if (next.outer !== undefined) pending.push(next.outer)
    }
    return false
  }

  /** A field read of an object the heap holds, after the object's folds: unknown when it has no value there. */
  function fieldRead(value: HeapValue, key: Key, node: AstNode): Value[] {
    if (typeof key === 'symbol') return [unknown]
    const found = lookup(value.heap, key, node, new Set())
    const values = found.length === 0 ? [unknown] : found
    return values.map((each) => through(each, value.folds))
  }

  /** Keys every holder has natively, which are never expandos. */
  const nativeKeys: ReadonlySet<string> = new Set(['prototype', 'constructor', '__proto__', 'length', 'name'])

  /**
   * Whether `key` is an expando on the native holder `holder`: no member of it, or of its chain, in the catalog, and on
   * the global object, none of the names its members or singletons have (§5 Global resolution).
   */
  function isExpando(holder: string, key: string): boolean {
    if (nativeKeys.has(key)) return false
    for (let at: string | null = holder; at !== null; at = Object.hasOwn(holders, at) ? holders[at]!.proto : null) {
      if (Object.hasOwn(targets, memberName(at, key))) return false
    }
    if (holder !== global) return true
    return !globalNames.has(key) && !singletons.has(key) && !windowMembers.has(key) && !anyObjectWindows.has(key) && !Object.hasOwn(globalValues, key)
  }

  /**
   * An expando read from a native holder in this window (§5 Global resolution): the heap cell of the holder's member,
   * after the holder's folds. On the global object the cell is shared by the free name and every member form. Unknown
   * when nothing writes it.
   */
  function expandoRead(value: HolderValue, key: string): Value[] {
    if (!isExpando(value.holder, key) || windowOf(value.leaves) !== thisWindow) return [unknown]
    // A recognized chunk registry is a known non-native array (§6): its own fields, `push` among them, are no
    // platform's.
    if (value.holder === global && context.links.registries.has(key)) return [registryArray]
    const values = cellValues(value.holder, key, value.holder === global)
    return values.length === 0 ? [unknown] : values.map((each) => through(each, value.folds))
  }

  /** A chunk registry's array (§6): an object the analyzer knows is no native holder. */
  const registryArray: Value = { kind: 'object' }

  /** The member-form writes of a global expando, which a free name of it reads too. */
  const memberFormValues = (name: string): Value[] => cellValues(global, name, false)

  /**
   * The values the heap cell of `holder`'s expando `key` holds, memoized: what the code writes through any expression
   * that denotes the holder in this window, and for the global object with `names`, the free name's definitions.
   */
  function cellValues(holder: string, key: string, names: boolean): Value[] {
    const found = memoized({
      key: program,
      name: `cell:${holder}.${key}${names ? '+names' : ''}`,
      fallback: program,
      compute: () => {
        const values = writtenValues(
          key,
          (value) => value.kind === 'holder' && value.holder === holder && windowOf(value.leaves) === thisWindow,
          `h:${holder}`,
        )
        if (names) {
          for (const definition of definitions.of({ scope: 'global', name: key })) {
            const defined = definitionValues(definition, undefined)
            noted(defined)
            for (const value of defined.values) values.push(heapValue(value, definition.site))
          }
        }
        return { values, node: program }
      },
    })
    noted(found)
    return found.values
  }

  /**
   * The objects a descriptor expression can be, each with its parts as ToPropertyDescriptor reads them (§3 Undecidable
   * outcomes): undefined unless every value it can have is an object the heap holds.
   */
  function objectParts(node: AstNode, at: Position): ObjectParts[] | undefined {
    const values = evaluate(node, at)
    if (values.length === 0 || !values.every(isHeap)) return undefined
    return (values as HeapValue[]).map((value) => ({ node: value.heap.node, parts: partsOf(value.heap, descriptorKeys, new Set()) }))
  }

  function descriptorValues(node: AstNode, at: Position): { objects: ObjectParts[]; primitive: boolean; unseen: boolean } {
    const values = evaluate(node, at)
    const objects = values.filter(isHeap).map((value) => ({ node: value.heap.node, parts: partsOf(value.heap, descriptorKeys, new Set()) }))
    const primitive = values.some((value) => value.kind === 'constant')
    const unseen = values.some((value) => !isHeap(value) && value.kind !== 'constant')
    return { objects, primitive, unseen }
  }

  /** The fields ECMA-262 ToPropertyDescriptor reads. */
  const descriptorKeys: readonly string[] = ['value', 'get', 'set', 'writable', 'enumerable', 'configurable']

  /**
   * An allocation's parts, in order: its literal's, a copy's sources', or its unseen base; then the fields `keys` that
   * the code writes after allocation, which may be absent, except on an object a native returns, which reads as
   * `{ ...native, <written fields> }`.
   */
  function partsOf(allocation: Allocation, keys: readonly string[], seen: Set<string>): ObjectPart[] {
    const { node, at } = allocation
    if (seen.has(allocation.id)) return [{ kind: 'unseen', node }]
    seen.add(allocation.id)
    const parts: ObjectPart[] = []
    switch (allocation.kind) {
      case 'literal':
        if (node.type === 'ObjectExpression') parts.push(...literalParts(node['properties'] as AstNode[], at, keys, seen))
        break
      case 'copy': {
        const [target, ...sources] = node['arguments'] as AstNode[]
        parts.push(...literalParts(target!['properties'] as AstNode[], at, keys, seen))
        for (const source of sources) parts.push(...spreadParts(source, evaluate(source, at), keys, seen))
        break
      }
      default:
        parts.push({ kind: 'unseen', node })
    }
    parts.push(...writtenParts(allocation, keys, allocation.kind !== 'returned', seen))
    seen.delete(allocation.id)
    return parts
  }

  /** The parts of an object literal's properties, evaluated where the literal is. */
  function literalParts(properties: readonly AstNode[], at: Position, keys: readonly string[], seen: Set<string>): ObjectPart[] {
    const parts: ObjectPart[] = []
    for (const property of properties) {
      if (property.type === 'SpreadElement') {
        const argument = property['argument'] as AstNode
        parts.push(...spreadParts(property, evaluate(argument, at), keys, seen))
        continue
      }
      const keyNode = property['key'] as AstNode
      let key: Key | undefined
      let folds: Fold[] = []
      if (property['computed'] !== true) key = keyNode.type === 'Identifier' ? (keyNode['name'] as string) : literalKey(keyNode)
      else {
        const values = evaluate(keyNode, at)
        const [only] = values
        if (values.length === 1 && only?.kind === 'constant') {
          key = toPropertyKey(only.value)
          folds = only.folds ?? []
        }
      }
      if (key === undefined) {
        parts.push({ kind: 'unseen', node: property })
        continue
      }
      const value = property['value'] as AstNode
      if (typeof key === 'string' && setsLiteralPrototype(property, key)) {
        parts.push({ kind: 'proto', site: property, values: evaluate(value, at) })
        continue
      }
      const kind = property['kind'] as 'init' | 'get' | 'set'
      if (kind === 'init') {
        parts.push({ kind: 'field', key, site: property, sources: [{ node: value, at }], values: evaluate(value, at), folds })
      } else parts.push({ kind: 'field', key, site: property, accessor: kind, sources: [], values: [], folds })
    }
    return parts
  }

  /**
   * The parts a spread or copy of `values` gives: the parts of the one object the heap holds that it is, as data fields
   * (CopyDataProperties reads each getter), nothing for `null` or `undefined`, and an unseen part otherwise.
   */
  function spreadParts(site: AstNode, values: readonly Value[], keys: readonly string[], seen: Set<string>): ObjectPart[] {
    if (values.every((value) => value.kind === 'constant' && (value.value === null || value.value === undefined))) return []
    const [only] = values
    if (values.length !== 1 || only === undefined || !isHeap(only)) return [{ kind: 'unseen', node: site }]
    return partsOf(only.heap, keys, seen).flatMap((part): ObjectPart[] => {
      if (part.kind === 'proto') return []
      // An object's unseen base is unseen where it is spread.
      if (part.kind === 'unseen' && part.node === only.heap.node) return [{ kind: 'unseen', node: site }]
      if (part.kind !== 'field' || part.accessor === undefined) return [part]
      // A getter's copy holds whatever it returns.
      const { accessor, ...copied } = part
      return accessor === 'get' ? [{ ...copied, values: [unknown] }] : [{ ...copied, values: [constant(undefined)] }]
    })
  }

  /** The fields `keys` the code writes to an allocation, one part per write, `maybe` absent when `maybe`. */
  function writtenParts(allocation: Allocation, keys: readonly string[], maybe: boolean, seen: Set<string>): ObjectPart[] {
    const { byKey, dynamic, copies } = fieldWrites()
    const parts: ObjectPart[] = []
    const writes = [...keys.flatMap((key) => byKey.get(key) ?? []), ...dynamic, ...copies].sort((a, b) => a.site.start - b.site.start)
    for (const write of writes) {
      const instances = instancesOf(write).filter((instance) => instance.objects.some((value) => isAllocation(value, allocation)))
      if (instances.length === 0) continue
      if (write.sources !== undefined) {
        for (const instance of instances) {
          for (const source of write.sources) {
            for (const part of spreadParts(source, quietly(() => evaluate(source, instance.at)), keys, seen)) {
              parts.push(part.kind === 'field' && maybe ? { ...part, maybe: write.site } : part)
            }
          }
        }
        continue
      }
      const key = write.key ?? singleKey(write, instances)
      if (key === undefined) {
        if (instances.some((instance) => keys.some((each) => mayBe(keysAt(write, instance)!, each)))) {
          parts.push({ kind: 'unseen', node: write.site })
        }
        continue
      }
      if (!keys.includes(key)) continue
      const sources = write.value === undefined ? [] : instances.map((instance) => ({ node: write.value!, at: instance.at }))
      const values = sources.length === 0 ? [unknown] : quietly(() => sources.flatMap((source) => evaluate(source.node, source.at)))
      parts.push({ kind: 'field', key, site: write.site, sources, values, folds: [], ...(maybe ? { maybe: write.site } : {}) })
    }
    return parts
  }

  /** The one key a dynamic write's instances all fold to, if they do. */
  function singleKey(write: FieldWrite, instances: readonly WriteInstance[]): string | undefined {
    const found = new Set<string>()
    for (const instance of instances) {
      for (const key of keysAt(write, instance) ?? [unknown]) {
        if (key.kind !== 'constant' || typeof key.value === 'symbol') return undefined
        found.add(String(key.value))
      }
    }
    return found.size === 1 ? [...found][0] : undefined
  }

  /**
   * The expressions that give a member read's value when it reads a field of objects the heap holds (for a write-back,
   * §3): each where it is evaluated. Undefined unless every value comes from one, with no part the analyzer can't see.
   */
  function fieldSources(member: AstNode, at: Position): { node: AstNode; at: Position }[] | undefined {
    if (member.type !== 'MemberExpression' || (member['object'] as AstNode).type === 'Super') return undefined
    const property = member['property'] as AstNode
    let key: string | undefined
    if (member['computed'] !== true) key = property.type === 'Identifier' ? (property['name'] as string) : undefined
    else {
      const values = evaluate(property, at)
      const [only] = values
      if (values.length === 1 && only?.kind === 'constant' && typeof only.value !== 'symbol') key = String(only.value)
    }
    if (key === undefined) return undefined
    const objects = evaluate(member['object'] as AstNode, at)
    if (objects.length === 0 || !objects.every(isHeap)) return undefined
    const sources: { node: AstNode; at: Position }[] = []
    for (const object of objects as HeapValue[]) {
      const parts = partsOf(object.heap, [key], new Set())
      if (parts.some((part) => part.kind === 'unseen')) return undefined
      let base: { node: AstNode; at: Position }[] = []
      for (const part of parts) {
        if (part.kind !== 'field' || part.key !== key) continue
        if (part.accessor !== undefined || part.sources.length === 0) return undefined
        if (part.maybe === undefined) base = part.sources
        else sources.push(...part.sources)
      }
      sources.push(...base)
    }
    return sources.length === 0 ? undefined : sources
  }

  function aliasCallee(id: AstNode, at: Position): Value[] {
    const key = definitions.keyOf(id)
    if (key === undefined || (key.scope === 'global' && !followsValue(key.name))) return []
    return definitions.of(key).some(mayAlias) ? evaluate(id, at) : []
  }

  return {
    evaluate,
    ownTestParts,
    prepare: buildIndex,
    aliasCallee,
    contextual,
    framesOf,
    callersOf,
    settled: (values) => settled(values),
    decided(run) {
      const found = new Map<string, Decision>()
      deciding.push(found)
      try {
        return { value: run(), decisions: [...found.values()] }
      } finally {
        deciding.pop()
      }
    },
    counterfactual(variant, unsettles, run) {
      const outer = counterfactualRun
      counterfactualRun = { variant: `~cf${variant}`, unsettles }
      try {
        return run()
      } finally {
        counterfactualRun = outer
      }
    },
    argumentTest: (test, fn) =>
      isFunction(fn) &&
      calls.callsOf(fn).some((call) => passesLiteral(call.args)) &&
      readsParameterField(test, fn, 0),
    parentOf,
    swept: () => keysSwept,
    onceFlag: (id) => {
      const key = id.type === 'Identifier' ? definitions.keyOf(id) : undefined
      return key !== undefined && key.scope !== 'global' && flags.isFlag(key)
    },
    closureFrame: (fn, closure) => creationFrame(fn, closure, undefined, fn),
    argumentValues,
    argumentCarries,
    objectParts,
    descriptorValues,
    fieldSources,
    givenSource: (binding: Binding, index: number) => givens.get(binding)?.[index]?.source,
    tracked(run, apart = false) {
      const capped = new Set<AstNode>()
      collectors.push(capped)
      let value
      try {
        value = run()
      } finally {
        collectors.pop()
      }
      if (!apart) for (const fold of capped) collectors.at(-1)?.add(fold)
      return { value, capped: [...capped] }
    },
    guards(parent, child) {
      switch (parent.type) {
        case 'IfStatement':
        case 'ConditionalExpression':
          if (child === parent['consequent']) return definedWhen(parent['test'] as AstNode, true)
          if (child === parent['alternate']) return definedWhen(parent['test'] as AstNode, false)
          return none
        case 'LogicalExpression':
          if (child !== parent['right'] || parent['operator'] === '??') return none
          return definedWhen(parent['left'] as AstNode, parent['operator'] === '&&')
        default: {
          // An earlier `return` or `throw` under the opposite test guards the rest of its statement list (§5).
          let found = none
          for (const { test, outcome } of exitsBefore(parent, child)) {
            const defined = definedWhen(test, outcome)
            if (defined.size > 0) found = new Map([...found, ...defined])
          }
          return found
        }
      }
    },
  }
}

/**
 * The values a `const` gives a name, with the expression they come from, for its fold (§14), and the folds that passed
 * the `fold-length` cap while they were found.
 */
/** A test a call argument literal's field decided, with that literal. */
export interface Decision {
  test: AstNode
  literal: AstNode
}

interface Declared {
  values: Value[]
  node: AstNode
  capped?: AstNode[]
  /** The tests a call argument literal's field decided while it was found. */
  decided?: Decision[]
  /** The functions whose parameters were read with no frame to bind them while they were found. */
  reads?: AstNode[]
  /**
   * For a heap field (§5 Resolver capabilities 5), whether the object has it: surely (`yes`), when a literal defines it;
   * perhaps (`maybe`), when it is written after allocation or may come from a part the analyzer can't see; or `no`.
   */
  presence?: 'yes' | 'maybe' | 'no'
}

/**
 * A cap that changed a value (§18), at the node where it applied: `alternatives`, a value with too many alternatives,
 * or `fold-length`, a string fold too long.
 */
export interface CapHit {
  name: 'alternatives' | 'fold-length' | 'recursion' | 'contexts' | 'iterations'
  node: AstNode
}

/** A call a recursion or context cap widened or merged while it carries a native (`analysis-budget`, Principle 5). */
interface Cut {
  site: AstNode
  why: 'recursion' | 'contexts'
}

/** An element of a constant collection: its values, and its own elements when it is a collection too. */
interface Element {
  values: Value[]
  parts?: Element[]
  /** The expression an array literal's element is, where it is evaluated: what absence tags follow (§5 capability 7). */
  source?: { node: AstNode; at: Position }
}

/** A constant collection (§5 Resolver capabilities 4): an array or `split` list whose elements the resolver knows. */
interface Collection {
  elements: Element[]
  /**
   * Whether every element comes from catalog enumerations (§5 Resolver capabilities 9): loops over it are
   * uncapped, and only the step budget bounds them.
   */
  bounded?: true
}

/** An object literal's own enumerable key, with the node of its value and where that is evaluated. */
interface Entry {
  key: string
  value: AstNode | undefined
  at: Position
  folds: Fold[]
}

/**
 * What a loop binds per iteration: a `for…of` or `for…in` head's variables, from each element or key, or a counted
 * loop's counter, from its start value, bumped by `bump` once per iteration.
 */
type Plan =
  | { kind: 'each'; loop: AstNode; forIn: boolean; pattern: AstNode; keys: VariableKey[] }
  | { kind: 'counted'; loop: AstNode; key: VariableKey; start: Definition; bump: Bump }

/**
 * A counter's bump: `i++`, `i -= 2`, `i = i + 1`. `statement` is the loop's update, or the body statement it is, and
 * `inBody` says which: a read in the body after that statement sees the counter bumped.
 */
interface Bump {
  node: AstNode
  id: AstNode
  operator: '+' | '-'
  amount: 1 | AstNode
  statement: AstNode
  inBody: boolean
}

/** A loop's head pattern: what `for (const [k, v] of …)` or `for (k in …)` binds, unless it assigns a member. */
function headPattern(loop: AstNode): AstNode | undefined {
  const left = loop['left'] as AstNode
  const pattern = left.type === 'VariableDeclaration' ? ((left['declarations'] as AstNode[])[0]!['id'] as AstNode) : left
  return pattern.type === 'MemberExpression' ? undefined : pattern
}

/** A loop's counter bumps: its update's, or else those that are statements of its body. */
function bumpsOf(loop: AstNode): Bump[] {
  if (loop.type === 'ForInStatement' || loop.type === 'ForOfStatement') return []
  const update = loop.type === 'ForStatement' ? (loop['update'] as AstNode | null) : null
  if (update !== null) {
    const bump = bumpOf(update, update, false)
    return bump === undefined ? [] : [bump]
  }
  const body = loop['body'] as AstNode
  const statements = body.type === 'BlockStatement' ? (body['body'] as AstNode[]) : [body]
  return statements.flatMap((statement) => {
    if (statement.type !== 'ExpressionStatement') return []
    const bump = bumpOf(statement['expression'] as AstNode, statement, true)
    return bump === undefined ? [] : [bump]
  })
}

function bumpOf(expression: AstNode, statement: AstNode, inBody: boolean): Bump | undefined {
  if (expression.type === 'UpdateExpression') {
    const id = expression['argument'] as AstNode
    if (id.type !== 'Identifier') return undefined
    return { node: expression, id, operator: expression['operator'] === '++' ? '+' : '-', amount: 1, statement, inBody }
  }
  if (expression.type !== 'AssignmentExpression') return undefined
  const id = expression['left'] as AstNode
  const right = expression['right'] as AstNode
  if (id.type !== 'Identifier') return undefined
  const operator = expression['operator'] as string
  if (operator === '+=' || operator === '-=') {
    return { node: expression, id, operator: operator === '+=' ? '+' : '-', amount: right, statement, inBody }
  }
  if (operator !== '=' || right.type !== 'BinaryExpression') return undefined
  const sum = right['operator'] as string
  const left = right['left'] as AstNode
  if ((sum !== '+' && sum !== '-') || left.type !== 'Identifier' || left['name'] !== id['name']) return undefined
  return { node: expression, id, operator: sum, amount: right['right'] as AstNode, statement, inBody }
}

/** Whether a value is a non-empty string or number that a key contains, as part of it. */
function isPart(value: Value, key: string): boolean {
  if (value.kind !== 'constant' || (typeof value.value !== 'string' && typeof value.value !== 'number')) return false
  const part = String(value.value)
  return part !== '' && key.includes(part)
}

/** Whether a node builds a string from parts: a `+` or a template with substitutions. */
function concatenates(node: AstNode): boolean {
  if (node.type === 'BinaryExpression') return node['operator'] === '+'
  return node.type === 'TemplateLiteral' && (node['expressions'] as AstNode[]).length > 0
}

/** Whether a node is a `split` call, whose pieces are folds of it. */
function splits(node: AstNode): boolean {
  if (node.type !== 'CallExpression') return false
  const callee = calleeExpression(node['callee'] as AstNode)
  return callee.type === 'MemberExpression' && (callee['property'] as AstNode)['name'] === 'split'
}

/** Whether `inner` lies within `outer`. */
const within = (outer: AstNode, inner: AstNode): boolean => outer.start <= inner.start && inner.end <= outer.end

/** An integer index key, which ECMA-262 OrdinaryOwnPropertyKeys orders first, ascending. */
const isIndexKey = (key: string): boolean => /^(?:0|[1-9][0-9]*)$/.test(key) && Number(key) < 2 ** 32 - 1

/** The array methods that write the array they are called on (§5 Resolver capabilities 4). */
const mutators: ReadonlySet<string> = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin'])

/** The natives that write the object passed first, by method name. */
const objectWriters: ReadonlySet<string> = new Set([
  'assign',
  'defineProperty',
  'defineProperties',
  'setPrototypeOf',
  'set',
  'deleteProperty',
])

/** The iteration natives that stop early, with the callback result that stops them. */
const earlyExits: ReadonlyMap<string, boolean> = new Map([
  ['some', true],
  ['find', true],
  ['findIndex', true],
  ['findLast', true],
  ['findLastIndex', true],
  ['every', false],
])

/** A `const` whose initializer is to be evaluated for `name`. */
interface Pending {
  /** The node the value is memoized under, with `name`: a declarator, or a definition's site. */
  key: AstNode
  name: string
  /** The node a value that reads itself comes from. */
  fallback: AstNode
  compute(): Declared
}

/** The analyzed instances of user functions and classes, each with the functions that construct it. */
type Instances = { instance: HeapValue; ctors: HeapValue[] }[]

/**
 * Thrown out of the constants being evaluated when one reads a constant too deep to evaluate within them, which
 * `chain` evaluates first. `waiting` gathers the constants it stopped, outermost first.
 */
class Needed {
  readonly constant: Pending
  readonly waiting: Pending[] = []
  constructor(constant: Pending) {
    this.constant = constant
  }
}

/**
 * What a pattern destructures: an expression, a value that is plainly `undefined`, one the syntax doesn't show, or the
 * values a member read gives, with the node that reads them.
 */
type Source = AstNode | 'absent' | 'unknown' | ReadSource
interface ReadSource {
  read: Value[]
  node: AstNode
  /** For an element that is a collection itself (an entry `[key, value]`), its elements. */
  parts?: Element[]
}
const isRead = (source: AstNode | ReadSource): source is ReadSource => !('type' in source)

/** Whether a fold's value can be recorded in the trace, which is JSON: a string, a finite number, a boolean or `null`. */
export const recordable = (value: Primitive): value is string | number | boolean | null =>
  value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value)

/**
 * The folds a part of a fold carries, without the part's own fold when the fold made from it takes its place: a
 * `"a" + "b" + "c"` is one fold, and so is a constant whose initializer is a `+`.
 */
function partFolds(part: ConstantValue, node: AstNode): Fold[] {
  return (part.folds ?? []).filter((fold) => fold.node !== node || fold.name !== undefined)
}

/**
 * The taint on a name's resolution path (§5 Parsing and scope, §9): its `with` blocks and sloppy direct evals, or
 * undefined when it has none. It is copied, so a fold carries only the taint.
 */
function taintOf({ withs, evals }: Taint): Taint | undefined {
  return withs.length > 0 || evals.length > 0 ? { withs, evals } : undefined
}

/** A value as the part `node` of a fold: a constant keeps the folds of `partFolds`. */
function partOf(value: Value, node: AstNode): Value {
  return value.kind === 'constant' ? { ...value, folds: partFolds(value, node) } : value
}

/** `value`, when it is a constant, as folded from `node`: after the folds of its parts, with a fold of its own. */
function folded(node: AstNode, value: Value): Value {
  return value.kind === 'constant' ? withFolds(value, [{ node, value: value.value }]) : value
}

/** `values`, each with `from`'s folds after its own (`withFolds`). */
function carried(values: readonly Value[], from: { folds?: Fold[] }): Value[] {
  const folds = from.folds ?? []
  return folds.length === 0 ? [...values] : values.map((value) => withFolds(value, folds))
}

/** A holder or constant with `folds` after its own, each once. Other values have no folds, and are unchanged. */
function withFolds(value: Value, folds: readonly Fold[]): Value {
  if (folds.length === 0 || !carriesFolds(value)) return value
  return { ...value, folds: mergedFolds(value.folds ?? [], folds) }
}

/**
 * `values`, which a test decided (the branch of a `?:`, the right side of `&&`), each after the test's `folds`, which
 * come before its own as the test comes before it in the source.
 */
function decidedBy(values: readonly Value[], folds: readonly Fold[]): Value[] {
  if (folds.length === 0) return [...values]
  return values.map((value) =>
    carriesFolds(value) ? { ...value, folds: mergedFolds(folds, value.folds ?? []) } : value,
  )
}

/**
 * The folds a decided test passes on to the values it selects: its own, but a heap read's, which a test decides only
 * as a call argument literal's settled field, and which records no step (§14). The selected values are no
 * heap reads of their own.
 */
const testFolds = (values: readonly Value[]): Fold[] => foldsOf(values).filter((fold) => fold.heap !== true)

/** Whether a call's arguments include an object literal passed directly, whose fields may decide tests. */
export const passesLiteral = (args: readonly AstNode[]): boolean => args.some((arg) => arg.type === 'ObjectExpression')

/** The folds of `values`, each once, in order. */
function foldsOf(values: readonly Value[]): Fold[] {
  return values.reduce<Fold[]>(
    (folds, value) => (carriesFolds(value) ? mergedFolds(folds, value.folds ?? []) : folds),
    [],
  )
}

/**
 * Two lists of folds, each fold once, in order. A call's folds stay apart by what came through the call: each argument,
 * its `this`, and what it returns, so that a lookup finds the argument a member came in through (§10).
 */
export function mergedFolds(a: readonly Fold[], b: readonly Fold[]): Fold[] {
  const out = [...a]
  const nameOf = (fold: Fold): string | undefined =>
    fold.call === undefined ? fold.name : `${fold.name}${fold.argument ?? ''}${fold.receiver === true ? 'this' : ''}`
  const same = (fold: Fold) => (other: Fold) => other.node === fold.node && nameOf(other) === nameOf(fold)
  // A fold or two is looked for in the list, and a longer list is merged in linear time.
  if (b.length <= 2) {
    for (const fold of b) if (!out.some(same(fold))) out.push(fold)
    return out
  }
  // The names each node was folded under.
  const seen = new Map<AstNode, Set<string | undefined>>()
  const add = (fold: Fold): boolean => {
    let names = seen.get(fold.node)
    if (names === undefined) seen.set(fold.node, (names = new Set()))
    const name = nameOf(fold)
    if (names.has(name)) return false
    names.add(name)
    return true
  }
  for (const fold of a) add(fold)
  for (const fold of b) if (add(fold)) out.push(fold)
  return out
}

/**
 * Whether control can reach the end of a statement without a `return` or `throw`: a statement list reaches it unless
 * one of its statements can't, an `if` unless both arms can't. Any other statement is taken to reach it.
 */
function fallsThrough(statement: AstNode): boolean {
  switch (statement.type) {
    case 'ReturnStatement':
    case 'ThrowStatement':
      return false
    case 'BlockStatement':
      return (statement['body'] as AstNode[]).every(fallsThrough)
    case 'IfStatement': {
      const alternate = statement['alternate'] as AstNode | null
      return alternate === null || fallsThrough(statement['consequent'] as AstNode) || fallsThrough(alternate)
    }
    default:
      return true
  }
}

/** Whether a value is `null` or `undefined`, and not read from the heap. */
const isNullish = (value: Value): boolean =>
  value.kind === 'constant' && (value.value === null || value.value === undefined) && !undecided(value)
const isUndefined = (value: Value): boolean => value.kind === 'constant' && value.value === undefined
const maybeUndefined = (value: Value): boolean => opaque(value) || isUndefined(value)

/** A function body that returns `this` and nothing else. A `"use strict"` directive would make its `this` undefined. */
const returnThis = /^\s*return\s+this\s*;?\s*$/

const comparisons: ReadonlySet<string> = new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>='])
const equalities: ReadonlySet<string> = new Set(['==', '!=', '===', '!=='])

/** A string literal, or a template literal without substitutions. */
function constantString(node: AstNode): string | undefined {
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value']
  if (node.type !== 'TemplateLiteral' || (node['expressions'] as AstNode[]).length > 0) return undefined
  return (((node['quasis'] as AstNode[])[0]!['value'] as { cooked: string | null }).cooked ?? undefined)
}

/**
 * A comparison of two values: two constants compare as JavaScript compares them, two native holders are the same
 * object exactly when they are the same holder, and a holder is never strictly equal to a constant or loosely equal to
 * `null` or `undefined`. `evaluated` is what the comparison evaluates, which could change the window a window
 * expression reaches: a caller that compares holders must pass it, so that none is decided without that check.
 */
function compared(operator: string, a: Value, b: Value, evaluated: readonly AstNode[]): Value {
  if (a.kind === 'constant' && b.kind === 'constant') {
    // A relational comparison of a symbol throws a TypeError, so it has no value.
    const throws = !equalities.has(operator) && (typeof a.value === 'symbol' || typeof b.value === 'symbol')
    return throws ? unknown : constant(compare(operator, a.value, b.value))
  }
  const identity = operator === '===' || operator === '==' ? true : operator === '!==' || operator === '!=' ? false : undefined
  if (identity === undefined) return unknown
  if (a.kind === 'holder' && b.kind === 'holder') {
    // The same holder in two windows is two objects, so the same holder is the same object only when both are reached
    // through one window expression (§3 Undecidable outcomes).
    if (a.holder !== b.holder) return constant(!identity)
    return sameWindow(a.leaves, b.leaves, evaluated) ? constant(identity) : unknown
  }
  const [holder, other] = a.kind === 'holder' ? [a, b] : [b, a]
  if (holder.kind !== 'holder' || other.kind !== 'constant') return unknown
  if (operator.length === 3 || other.value === null || other.value === undefined) return constant(!identity)
  return unknown
}

function compare(operator: string, a: unknown, b: unknown): boolean {
  switch (operator) {
    case '==':
      return a == b
    case '!=':
      return a != b
    case '===':
      return a === b
    case '!==':
      return a !== b
    case '<':
      return (a as number) < (b as number)
    case '>':
      return (a as number) > (b as number)
    case '<=':
      return (a as number) <= (b as number)
    default:
      return (a as number) >= (b as number)
  }
}

/**
 * Whether `&&`, `||` or `??` gives back `value` as a heap-read or once-flag boolean, `null` or `undefined` from its
 * undecided test operand, which is never a candidate key whichever operator gives it (§5 Candidate sets).
 */
function testedOnly(value: Value): boolean {
  if (value.kind !== 'constant' || !undecided(value)) return false
  const { value: primitive } = value
  return typeof primitive === 'boolean' || primitive === null || primitive === undefined
}

/**
 * How a test whose values a call argument literal's field decides comes out (§5 Resolver capabilities 5): every
 * value a constant that decides, at least one read through such a field. Undefined for any other test, which this
 * rule leaves as it was.
 */
export function argumentDecided(values: readonly Value[]): boolean | undefined {
  if (values.length === 0 || !values.every((value) => value.kind === 'constant' && !undecided(value))) return undefined
  const read = values.some((value) => carriesFolds(value) && (value.folds?.some((fold) => fold.settled === true) ?? false))
  return read ? truthiness(values) : undefined
}

/**
 * The call argument literals whose fields settled a test's values, in document order: what a `prune` step names
 * as having settled the test.
 */
export function settlingLiterals(values: readonly Value[]): AstNode[] {
  const found = new Set<AstNode>()
  for (const value of values) {
    if (!carriesFolds(value)) continue
    for (const fold of value.folds ?? []) if (fold.settled === true && fold.decides !== undefined) found.add(fold.decides.node)
  }
  return [...found].sort((a, b) => a.start - b.start)
}

/** Whether a value is truthy whichever of `values` it is: `true` or `false` when every one agrees, else undefined. */
export function truthiness(values: readonly Value[]): boolean | undefined {
  const truthy = values.some(maybeTruthy)
  const falsy = values.some(maybeFalsy)
  return truthy === falsy ? undefined : truthy
}

// A value read from the heap may be either, whatever it is: heap-read constants and presence never decide a test (§5
// Resolver capabilities 5).
const maybeTruthy = (value: Value): boolean => value.kind !== 'constant' || Boolean(value.value) || undecided(value)
const maybeFalsy = (value: Value): boolean =>
  opaque(value) || (value.kind === 'constant' && !value.value) || undecided(value) || mayBeMissing(value)
const maybeNullish = (value: Value): boolean =>
  opaque(value) ||
  mayBeMissing(value) ||
  (value.kind === 'constant' && (value.value === null || value.value === undefined)) ||
  undecided(value)
const maybeNotNullish = (value: Value): boolean =>
  value.kind !== 'constant' || (value.value !== null && value.value !== undefined) || undecided(value)

/** A native holder that may be missing, which reads as `undefined` (§7). */
const mayBeMissing = (value: Value): boolean => value.kind === 'holder' && value.absent === true

/** `value` marked as a holder that may be missing, or as one that is always present. */
function markedAbsent(value: HolderValue, absent: boolean): HolderValue {
  if (absent) return { ...value, absent: true }
  if (value.absent === undefined) return value
  const present = { ...value }
  delete present.absent
  return present
}

/** An array index as a property key, or a key that may be one. */
const isIndex = (value: Value): boolean => opaque(value) || isArrayIndex(value)

/** A constant array index as a property key: `0`, `"1"`, `2n`. */
const isArrayIndex = (value: Value): boolean => {
  if (value.kind !== 'constant') return false
  const key = value.value
  if (typeof key === 'number') return Number.isInteger(key) && key >= 0
  if (typeof key === 'bigint') return key >= 0n
  return typeof key === 'string' && /^(?:0|[1-9][0-9]*)$/.test(key)
}

/** Leaves marked as read as the frames collection (§5 Other windows), one per node. */
const asFrames = (leaves: readonly Leaf[]): Leaf[] =>
  onePerNode(leaves.map((leaf): Leaf => (leaf.frames === true ? leaf : { ...leaf, frames: true })))

/** Leaves without the frames mark, one per node, the same list when none has it. */
function unspelled(leaves: Leaf[]): Leaf[] {
  if (!leaves.some((leaf) => leaf.frames === true)) return leaves
  return onePerNode(
    leaves.map((leaf): Leaf => {
      if (leaf.frames !== true) return leaf
      const read = { ...leaf }
      delete read.frames
      return read
    }),
  )
}

/**
 * The leaves without a twin: a leaf of the same node as an earlier one, that differs from it only in the frames mark. A
 * marked and an unmarked read of one node stay two leaves only while the mark tells them apart (`union`); once both
 * carry it or neither does, or once a trace lists their steps, they are one read.
 */
export const onePerNode = (leaves: readonly Leaf[]): Leaf[] =>
  leaves.filter((leaf, at) => !leaves.slice(0, at).some((earlier) => twins(earlier, leaf)))

/** Whether two leaves differ only in the frames mark. */
function twins(a: Leaf, b: Leaf): boolean {
  const keys = (leaf: Leaf) => Object.keys(leaf).filter((key) => key !== 'frames')
  const [ak, bk] = [keys(a), keys(b)]
  return ak.length === bk.length && ak.every((key) => a[key as keyof Leaf] === b[key as keyof Leaf])
}

/**
 * How a trace names an index read on a window (§14): by its constant index (`[0]`), by the name that gives an unknown
 * one (`[i]`), or as `[?]`.
 */
function indexName(property: AstNode, values: readonly Value[]): string {
  const [only] = values
  if (values.length === 1 && only?.kind === 'constant') return String(only.value)
  return property.type === 'Identifier' ? (property['name'] as string) : '?'
}

/** The values a chain selects, with the chain recorded on every leaf of their holders: the outermost chain wins. */
function selected(chain: AstNode, values: readonly Value[]): Value[] {
  return union(values).map((value) =>
    value.kind === 'holder' ? { ...value, leaves: value.leaves.map((leaf) => ({ ...leaf, chain })) } : value,
  )
}

/**
 * The alternatives of several values, with the leaves of each holder merged, in a fixed order: one leaf per node and
 * frames mark (§5 Other windows). `evaluate` caps how many there are.
 */
function union(values: readonly Value[]): Value[] {
  const out: Value[] = []
  for (const value of values) {
    if (value.kind === 'holder') {
      const same = out.find((other): other is HolderValue => other.kind === 'holder' && other.holder === value.holder)
      if (same === undefined) out.push({ ...value, leaves: [...value.leaves] })
      else {
        for (const leaf of value.leaves) {
          // A read of a node as `frames` and a read of it as another member stay apart (§5 Other windows, Principle
          // 3): each alternative takes an unresolved index as it would on its own.
          const marked = leaf.frames === true
          if (!same.leaves.some((other) => other.node === leaf.node && (other.frames === true) === marked)) {
            same.leaves.push(leaf)
          }
        }
        if (value.folds !== undefined) same.folds = mergedFolds(same.folds ?? [], value.folds)
        // Either alternative may be the value, so it may be missing when one may be.
        if (value.absent === true) same.absent = true
      }
    } else if (value.kind === 'native') {
      const same = out.find((other): other is NativeValue => other.kind === 'native' && other.name === value.name)
      if (same === undefined) out.push({ ...value, leaves: [...value.leaves], ...(value.sites ? { sites: [...value.sites] } : {}) })
      else {
        for (const leaf of value.leaves) if (!same.leaves.some((other) => other.node === leaf.node)) same.leaves.push(leaf)
        if (value.folds !== undefined) same.folds = mergedFolds(same.folds ?? [], value.folds)
        for (const site of value.sites ?? []) if (!(same.sites ??= []).includes(site)) same.sites.push(site)
      }
    } else if (value.kind === 'member') {
      const same = out.find(
        (other): other is MemberValue => other.kind === 'member' && other.target === value.target && other.holder === value.holder,
      )
      if (same === undefined) out.push({ ...value, leaves: [...value.leaves], sites: [...value.sites] })
      else {
        for (const leaf of value.leaves) if (!same.leaves.some((other) => other.node === leaf.node)) same.leaves.push(leaf)
        if (value.folds !== undefined) same.folds = mergedFolds(same.folds ?? [], value.folds)
        for (const site of value.sites) if (!same.sites.includes(site)) same.sites.push(site)
      }
    } else if (value.kind === 'constant') {
      const at = out.findIndex((other) => other.kind === 'constant' && Object.is(other.value, value.value))
      if (at < 0) out.push(value)
      else {
        // A value read from the heap keeps its mark, which a test reads, when it is also another value's.
        if (undecided(value) && !undecided(out[at]!)) out[at] = withFolds(out[at]!, heapFolds(value))
        // A value that is a key some other way than through an undecided test stays one.
        const same = out[at] as ConstantValue
        if (same.tested === true && value.tested !== true) {
          out[at] = { kind: 'constant', value: same.value, ...(same.folds === undefined ? {} : { folds: same.folds }) }
        }
      }
    } else if (value.kind === 'object') {
      // Objects the heap holds stay apart by allocation site; any other objects are one.
      const at = out.findIndex((other) => other.kind === 'object' && other.heap?.id === value.heap?.id)
      if (at < 0) out.push(value)
      else {
        let same = out[at] as ObjectValue
        // An object that is reached some other way than through an assumed `this` is no longer only that.
        if (same.assumed === true && value.assumed !== true) {
          same = { kind: 'object', ...(same.heap === undefined ? {} : { heap: same.heap }), ...(same.folds === undefined ? {} : { folds: same.folds }) }
        }
        out[at] = value.folds === undefined ? same : { ...same, folds: mergedFolds(same.folds ?? [], value.folds) }
      }
    } else if (!out.some((other) => other.kind === 'unknown' && other.prefix === value.prefix)) {
      // A string whose start folds stays apart from another prefix, and from a value the analyzer knows nothing of.
      out.push(value)
    }
  }
  return out
}

/** Values with every prefix given up (§5 Pattern wildcards): each string the analyzer can't fold whole is unknown. */
function unprefixed(values: readonly Value[]): Value[] {
  return values.some((value) => value.kind === 'unknown' && value.prefix !== undefined)
    ? union(values.map((value) => (value.kind === 'unknown' ? unknown : value)))
    : [...values]
}

/** The heap folds a value carries. */
const heapFolds = (value: Value): Fold[] => (carriesFolds(value) ? (value.folds ?? []).filter(undecidedFold) : [])

/**
 * The assignment operators whose value is the right side as read: `=`, and the logical assignments, which write it only
 * when they write at all. The others (`+=`, `|=`) write a new value computed from both sides.
 */
const writeBackOperators: ReadonlySet<string> = new Set(['=', '||=', '&&=', '??='])

/** A computed key the syntax names: a string or number literal, or a template literal with no substitutions. */
function staticKey(node: AstNode): string | undefined {
  return literalKey(node) ?? constantString(node)
}

/** The node of an object literal's own `value` field, when it has one, as a descriptor literal gives a define's value. */
function literalValue(literal: AstNode): AstNode | undefined {
  let value: AstNode | undefined
  for (const property of literal['properties'] as AstNode[]) {
    if (property.type !== 'Property') return undefined
    const key = property['key'] as AstNode
    const name = property['computed'] === true ? undefined : key.type === 'Identifier' ? key['name'] : literalKey(key)
    if (name === 'value') value = property['kind'] === 'init' ? (property['value'] as AstNode) : undefined
  }
  return value
}

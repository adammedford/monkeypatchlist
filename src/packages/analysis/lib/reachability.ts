// Guard classification and reachability values (§7 Values, §14 `guard`). A write's reachability is judged from the
// guards between it and the start of the function it is in: the tests of the `if`, `?:`, `&&`, `||` and `??` arms it
// sits in, the early `return`s and `throw`s before it in each statement list on its way, and its own `||=`, `??=`,
// `x = x || p` and `x = x ? x : p` forms. Each guard is classified and gives a value of its own; values combine along a
// path (AND) and across alternatives (OR).
//
// Along call chains (§7 Where reachability is judged from), the function a write is in is reached through its resolved
// calls, out to the **install entry**: the outermost function on the chain with no resolved caller, or the top-level
// code. The guards between each call and the start of the function it is in count along the path, judged in the
// caller's frame when the resolver has one, so a guard inside a helper summary counts too. Several callers are
// alternatives, and the most-reaching wins.

import type { CatalogHolder, Realm, SerializedCatalog } from '../../../catalog.ts'
import { walkTree, type AstNode } from './ast.ts'
import type { Caps } from './budget.ts'
import { mayThrow } from './catch-arms.ts'
import {
  argumentDecided,
  isSwept,
  passesLiteral,
  settlingLiterals,
  truthiness,
  type GlobalResolution,
  type Position,
  type Value,
} from './global-object.ts'
import { memberName, symbolMember, toPropertyKey, type Key } from './keys.ts'
import { reachedAfter, type Condition } from './early-exits.ts'
import { locate, type Starts } from './line-starts.ts'
import { printed } from './print.ts'
import { boundIdentifiers, type ScopeRules } from './scope.ts'
import { frameOf, isFunction, type Binding, type Frame } from './summaries.ts'
import type {
  CreationSiteStep,
  GeneratedLocation,
  GuardClass,
  GuardStep,
  Reachability,
  ReachabilityBasis,
} from './types.ts'

/** The order along one path (AND), the strongest last: `guarded-native-absence` > `unknown` > `conditional` > none. */
const alongOrder: readonly Reachability[] = ['unconditional', 'conditional', 'unknown', 'guarded-native-absence']
/** The order across alternatives (OR), the most-reaching last: `unconditional` > `conditional` > `unknown` > absence. */
const acrossOrder: readonly Reachability[] = ['guarded-native-absence', 'unknown', 'conditional', 'unconditional']

/** Two guards on one path (AND): `config.polyfill && !window.fetch` is `guarded-native-absence` (§7). */
export function along(a: Reachability, b: Reachability): Reachability {
  return alongOrder.indexOf(a) >= alongOrder.indexOf(b) ? a : b
}

/** Two alternatives (OR): the most-reaching, so `!window.fetch || force` is `conditional` (§7). */
export function across(a: Reachability, b: Reachability): Reachability {
  return acrossOrder.indexOf(a) >= acrossOrder.indexOf(b) ? a : b
}

/** The value each class of guard gives on its own (§7, §14). */
const results: Readonly<Record<GuardClass, Reachability>> = {
  transparent: 'unconditional',
  absence: 'guarded-native-absence',
  'broken-native': 'conditional',
  config: 'conditional',
  'other-target': 'conditional',
  undecided: 'conditional',
  unknown: 'unknown',
}

export interface GuardContext {
  resolution: GlobalResolution
  scope: ScopeRules
  catalog: SerializedCatalog
  realm: Realm
  /** The realm's global holder, e.g. `Window`. */
  global: string
  /** The host artifact's text and line-start table. */
  text: string
  starts: Starts
  /** The node a node is a child of, to judge a test that reads a parameter with the arguments of its call. */
  parentOf?: (node: AstNode) => AstNode | undefined
  /**
   * The resolved call the function the path is in is judged under, when it has no frame: a test of one of its
   * parameters is judged as the argument this call passes (§7).
   */
  call?: Binding | undefined
  /** The caps (§18): `testReads` and `throwDepth` here. */
  caps: Pick<Caps, 'testReads' | 'throwDepth'>
  /** Counts a hit of one of them, at the node where it cut (§18). */
  capHit(name: 'testReads' | 'throwDepth', node: AstNode): void
}

/**
 * The write a reachability is judged for: its site, its target, and the `with` statements and direct `eval` calls on
 * the resolution paths of its names (§5 post-pass 3), whose taint makes it `unknown` (§7).
 */
export interface Judged {
  site: AstNode
  target: { name: string; shadows?: string }
  taints: readonly GeneratedLocation[]
}

/**
 * A write's reachability, and the `guard` steps (§14) of the guards on its path, outermost first, with a `creation-site`
 * step where the path goes out through where a caller-less function was created. `tests` maps each test a guard step
 * was made for to its step. `dead` is set when a statically false catalog check on the path means the write never runs
 * (§7 Checking guards against the catalog): the test that decides it. `basis` is how it was judged (§7), `call-path`
 * when left out.
 */
export interface Judgement {
  reachability: Reachability
  steps: (GuardStep | CreationSiteStep)[]
  tests: ReadonlyMap<AstNode, GuardStep>
  dead?: AstNode
  /** For a `dead` test a call argument literal's field settled: that literal, which a `prune` step names. */
  by?: AstNode
  /**
   * The install entry the write waits on when it is `deferred` (§7 Install context): the function with no resolved
   * caller that every live chain out from the write ends at. Absent when a chain reaches top-level code (`load`).
   */
  entry?: AstNode
  basis?: ReachabilityBasis
}

/**
 * A classified test: its value, the steps of the guards in it with the test each was made for, and, when the test can
 * never hold as the path needs, the statically false catalog check that decides so.
 */
interface Classified {
  result: Reachability
  steps: GuardStep[]
  tests: AstNode[]
  dead?: AstNode
  /** For a `dead` test a call argument literal's field settled: that literal. */
  by?: AstNode
}

const unconditional: Judgement = { reachability: 'unconditional', steps: [], tests: new Map() }

/**
 * The reachability of a write, judged from the guards between it and the start of its function (§7). `path` is the
 * walk's ancestors of the node that makes the write, outermost first, ending with that node.
 */
export function judge(path: readonly AstNode[], write: Judged, at: Position, context: GuardContext): Judgement {
  const guards: Condition[] = []
  let from = 0
  // The site itself, which is a function when it is where a function was created, opens no function of its own.
  for (let index = path.length - 2; index >= 0; index--) {
    if (isFunction(path[index]!)) {
      from = index
      break
    }
  }
  // A `catch` arm on the path whose `try` block can't throw is never reached (§5 Resolver capabilities 9).
  let unreachedArm: AstNode | undefined
  for (let index = from + 1; index < path.length; index++) {
    const parent = path[index - 1]!
    const child = path[index]!
    guards.push(...edgeGuards(parent, child))
    if (unreachedArm === undefined && parent.type === 'TryStatement' && child === parent['handler']) {
      if (!mayThrow(parent['block'] as AstNode, throwContext(at, context))) unreachedArm = child
    }
  }
  guards.push(...ownGuards(write, context))

  const classifier = classifierOf(write, at, context)
  let reachability: Reachability = 'unconditional'
  const steps: GuardStep[] = []
  const tests = new Map<AstNode, GuardStep>()
  let dead: AstNode | undefined = unreachedArm
  let by: AstNode | undefined
  if (unreachedArm !== undefined) unreachedArms.add(unreachedArm)
  // `with` and direct-`eval` taint on the write's own names (§5 post-pass 3).
  for (const site of write.taints) {
    steps.push(classifier.taintStep(site))
    reachability = along(reachability, 'unknown')
  }
  for (const guard of guards) {
    const classified = classifier.condition(guard)
    reachability = along(reachability, classified.result)
    steps.push(...classified.steps)
    classified.tests.forEach((test, index) => tests.set(test, classified.steps[index]!))
    if (dead === undefined && classified.dead !== undefined) ({ dead, by } = classified)
  }
  if (steps.length === 0 && dead === undefined) return unconditional
  return { reachability, steps, tests, ...(dead === undefined ? {} : { dead }), ...(by === undefined ? {} : { by }) }
}

/** Two tests on one path (AND): it is dead when either is. */
function bothOf(a: Classified, b: Classified): Classified {
  const { dead, by } = a.dead !== undefined ? a : b
  return {
    result: along(a.result, b.result),
    steps: [...a.steps, ...b.steps],
    tests: [...a.tests, ...b.tests],
    ...(dead === undefined ? {} : { dead }),
    ...(by === undefined ? {} : { by }),
  }
}

/** Two alternatives (OR): a dead one never holds, so the other decides; it is dead only when both are. */
function eitherOf(a: Classified, b: Classified): Classified {
  const steps = [...a.steps, ...b.steps]
  const tests = [...a.tests, ...b.tests]
  if (a.dead !== undefined && b.dead !== undefined) {
    return { result: a.result, steps, tests, dead: a.dead, ...(a.by === undefined ? {} : { by: a.by }) }
  }
  const result = a.dead !== undefined ? b.result : b.dead !== undefined ? a.result : across(a.result, b.result)
  return { result, steps, tests }
}

/**
 * The guards an edge of the path adds: an arm's test, or for a statement in a list, the condition under which every
 * statement before it fell through (the early `return`s and `throw`s before it).
 */
function edgeGuards(parent: AstNode, child: AstNode): Condition[] {
  switch (parent.type) {
    case 'IfStatement':
    case 'ConditionalExpression':
      if (child === parent['consequent']) return [{ test: parent['test'] as AstNode, outcome: true }]
      if (child === parent['alternate']) return [{ test: parent['test'] as AstNode, outcome: false }]
      return []
    case 'LogicalExpression':
      if (child !== parent['right']) return []
      return [{ test: parent['left'] as AstNode, outcome: parent['operator'] === '&&' }]
    default: {
      const reached = reachedAfter(parent, child)
      return reached === true || reached === false ? [] : [reached]
    }
  }
}

/**
 * The guards a write's own form adds: `x ||= p` and `x ??= p` run when `x` is missing and `x &&= p` when it is there,
 * and `x = x || p`, `x = x ?? p` and `x = c ? x : p` change `x` only on the arm that doesn't keep it (§7).
 */
function ownGuards({ site }: Judged, { text }: GuardContext): Condition[] {
  if (site.type !== 'AssignmentExpression') return []
  const left = site['left'] as AstNode
  switch (site['operator']) {
    case '||=':
    case '??=':
      return [{ test: left, outcome: false }]
    case '&&=':
      return [{ test: left, outcome: true }]
    case '=':
      break
    default:
      return []
  }
  const same = (node: AstNode) => sourceOf(node, text) === sourceOf(left, text)
  let right = site['right'] as AstNode
  while (right.type === 'SequenceExpression') right = (right['expressions'] as AstNode[]).at(-1)!
  if (right.type === 'LogicalExpression' && right['operator'] !== '&&' && same(right['left'] as AstNode)) {
    return [{ test: right['left'] as AstNode, outcome: false }]
  }
  if (right.type === 'ConditionalExpression') {
    const test = right['test'] as AstNode
    if (same(right['consequent'] as AstNode)) return [{ test, outcome: false }]
    if (same(right['alternate'] as AstNode)) return [{ test, outcome: true }]
  }
  return []
}

/** An expression's source text, without its whitespace. */
const sourceOf = (node: AstNode, text: string): string => text.slice(node.start, node.end).replace(/\s+/g, '')

/** The comparison operators a `typeof` or `null` test is written with. */
const equalities: ReadonlySet<string> = new Set(['==', '!=', '===', '!=='])
const comparisons: ReadonlySet<string> = new Set([...equalities, '<', '>', '<=', '>='])

/** How a test reads: the native it tests the presence of, and whether `outcome` means present or missing. */
interface Presence {
  tested: string
  present: boolean
}

/** Names whose source marks a test that judges a native broken rather than missing (§7): core-js, `isNative…`. */
const brokenNames = /\bFORCED\b|\bisForced\b|\bisNative\w*|native code/

/** Names whose source marks a writability check (§7): `isReadOnly`, `isPropertyWritable`, a descriptor's `writable`. */
const writabilityNames = /\bis\w*(?:Writable|ReadOnly)\b|\.writable\b/i

function classifierOf(write: Judged, at: Position, context: GuardContext) {
  const { resolution, scope, catalog, realm, global, text, starts } = context
  // The most reads of a test the classifier evaluates to find a native read in it.
  const maxReads = context.caps.testReads
  const targets = catalog.targets[realm]
  const holders = catalog.holders[realm]
  const instanceMembers = catalog.instanceMembers[realm]
  const dropped = catalog.retained.dropped[realm]
  const evaluated = new Map<AstNode, Value[]>()
  const evaluate = (node: AstNode): Value[] => {
    let values = evaluated.get(node)
    if (values === undefined) evaluated.set(node, (values = resolution.evaluate(node, at)))
    return values
  }

  /** The step of a `with` statement or direct `eval` call on a name's resolution path: `unknown` (§7). */
  const taintStep = (generated: GeneratedLocation): GuardStep => {
    const expression = text.startsWith('with', generated.start) ? 'with (…)' : 'eval(…)'
    return {
      kind: 'guard',
      expression,
      generated,
      class: 'unknown',
      result: 'unknown',
      text:
        `\`${expression}\` at ${generated.line}:${generated.column} lies on the resolution path of the write's names, ` +
        'so where the write lands is control flow the analyzer does not model: unknown',
    }
  }
  const step = (node: AstNode, cls: GuardClass, tested: string | undefined): GuardStep => {
    const generated = locate(starts, node.start, node.end)
    const expression = printed(node)
    const result = results[cls]
    const what = tested === undefined ? '' : ` on \`${tested}\``
    return {
      kind: 'guard',
      expression,
      generated,
      class: cls,
      ...(tested === undefined ? {} : { tested }),
      result,
      text: `the guard \`${expression}\` at ${generated.line}:${generated.column} is ${wording[cls]}${what}, so it gives ${result}`,
    }
  }
  const leaf = (node: AstNode, cls: GuardClass, tested?: string): Classified => ({
    result: results[cls],
    steps: [step(node, cls, tested)],
    tests: [node],
  })

  /** The catalog name of the native a value is, if it is one: a target (`Window.fetch`) or a holder. */
  const nativeName = (values: readonly Value[]): string | undefined => {
    for (const value of values) {
      if (value.kind === 'member') return value.target
      if (value.kind === 'native') return value.name
      if (value.kind === 'holder') {
        if (value.holder === global) return global
        const name = memberName(global, value.holder)
        return Object.hasOwn(targets, name) ? name : value.holder
      }
    }
    return undefined
  }
  /** `typeof` of a native, as its catalog entry says: a constructor or function is a function. */
  const nativeType = (values: readonly Value[]): string => {
    for (const value of values) {
      if (value.kind === 'member' || value.kind === 'native') return 'function'
      if (value.kind === 'holder') return holders[value.holder]?.kind === 'constructor' ? 'function' : 'object'
    }
    return 'object'
  }
  const flagged = (values: readonly Value[]) =>
    values.some((value) => 'folds' in value && (value.folds?.some((fold) => fold.flag === true) ?? false))
  /** Whether a test's values are a once-flag's: each read through the flag, but those the analyzer can't know at all. */
  const flagTest = (values: readonly Value[]) =>
    flagged(values) && values.every((value) => value.kind === 'unknown' || flagged([value]))
  const heapRead = (values: readonly Value[]) =>
    values.some((value) => 'folds' in value && (value.folds?.some((fold) => fold.heap === true && fold.settled !== true) ?? false))
  const decided = (values: readonly Value[]) =>
    values.length > 0 && values.every((value) => value.kind === 'constant') && !heapRead(values) && !flagged(values)
  /** Whether a test's values are all objects the code made, which are truthy whatever their fields (ECMA-262 ToBoolean). */
  const objects = (values: readonly Value[]) =>
    values.length > 0 && values.every((value) => value.kind === 'object') && !heapRead(values) && !flagged(values)

  /** Whether the tested native is the written target, or a holder on its way: its own presence is transparent. */
  const ownsTarget = (tested: string): boolean => {
    if (tested === global) return true
    const bare = tested.startsWith(`${global}.`) ? tested.slice(global.length + 1) : tested
    return [write.target.name, write.target.shadows].some(
      (name) =>
        name !== undefined &&
        (name === tested || name === bare || name.startsWith(`${tested}.`) || name.startsWith(`${bare}.`)),
    )
  }
  const presence = (node: AstNode, { tested, present }: Presence): Classified =>
    present
      ? leaf(node, ownsTarget(tested) ? 'transparent' : 'other-target', tested)
      : leaf(node, 'absence', tested)

  /** Whether an identifier read in a test resolves through a `with` or a direct `eval` (§5 post-pass 3). */
  const tainted = (node: AstNode): boolean => {
    let found = false
    walkReads(node, (read) => {
      if (read.type !== 'Identifier') return
      const binding = scope.resolve(read)
      if (binding !== 'local' && (binding.withs.length > 0 || binding.evals.length > 0)) found = true
    })
    return found
  }
  /** Whether a test reads a native: a holder, a native function or a catalog member, anywhere in it. */
  const readsNative = (node: AstNode): boolean => {
    let found = false
    let count = 0
    walkReads(node, (read) => {
      if (found) return
      if (count++ >= maxReads) return context.capHit('testReads', node)
      if (read.type === 'Identifier' || read.type === 'MemberExpression' || read.type === 'ThisExpression') {
        if (nativeName(evaluate(read)) !== undefined) found = true
      }
    })
    return found
  }
  /** Whether a test calls something the analyzer can't resolve: no native and no function it knows. */
  const unresolvedCall = (node: AstNode): boolean => {
    let found = false
    walkReads(node, (read) => {
      if (found || (read.type !== 'CallExpression' && read.type !== 'NewExpression')) return
      const callee = evaluate(read['callee'] as AstNode)
      if (!callee.some((value) => value.kind !== 'unknown')) found = true
    })
    return found
  }
  /**
   * Whether a test calls a catalog method of a native constructor's prototype on an object the code made with `new` of
   * that constructor (`done.has(level)` with `done = new Set()`): a native call whose answer the analyzer doesn't model,
   * a recognized guard it can't decide (§7 `conditional`).
   */
  const nativeMethodCall = (node: AstNode): boolean => {
    if (node.type !== 'CallExpression') return false
    const read = memberRead(node['callee'] as AstNode)
    if (read === undefined) return false
    const keys = read.key === undefined ? [] : evaluate(read.key)
    const member = read.name ?? (keys.length === 1 && keys[0]!.kind === 'constant' && !heapRead(keys) ? keys[0]!.value : null)
    if (member === null) return false
    const objects = evaluate(read.object)
    return (
      objects.length > 0 &&
      objects.every((value) => {
        if (value.kind !== 'object' || value.heap?.kind !== 'instance' || value.heap.node.type !== 'NewExpression') return false
        const made = resolution.evaluate(value.heap.node['callee'] as AstNode, value.heap.at)
        return (
          made.length > 0 &&
          made.every((ctor) => {
            if (ctor.kind !== 'holder' || holders[ctor.holder]?.kind !== 'constructor') return false
            const proto = `${ctor.holder}.prototype`
            return Object.hasOwn(holders, proto) && catalogCheck([{ kind: 'holder', holder: proto, leaves: [] }], toPropertyKey(member), true) === 'catalogued'
          })
        )
      })
    )
  }

  /**
   * Whether a test reads anything at all: a name, a member or `this`, as a config or option flag does, or calls a function
   * the code made in place (Rollup's inlined `!function(){ … }()`), as it would call it by name.
   */
  const readsAnything = (node: AstNode): boolean => {
    let found = false
    walkReads(node, (read) => {
      if (read.type === 'Identifier' || read.type === 'MemberExpression' || read.type === 'ThisExpression') found = true
      else if (read.type === 'CallExpression' && calledSources(read).length > 0) found = true
    })
    return found
  }

  /** The free name `typeof name` tests, when the realm's catalog has no global of that name (§7). */
  const uncatalogued = (operand: AstNode): string | undefined => {
    if (operand.type !== 'Identifier') return undefined
    const binding = scope.resolve(operand)
    if (binding === 'local' || binding.declaration !== undefined) return undefined
    const name = operand['name'] as string
    return Object.hasOwn(targets, memberName(global, name)) ? undefined : name
  }

  /** `typeof x <op> "s"` in any spelling: the native `x` tested, or undefined when it is no such test. */
  const typeofTest = (node: AstNode, outcome: boolean, shown: AstNode): Classified | undefined => {
    if (node.type !== 'BinaryExpression' || !comparisons.has(node['operator'] as string)) return undefined
    const left = node['left'] as AstNode
    const right = node['right'] as AstNode
    const operand = typeofOperand(left) ?? typeofOperand(right)
    if (operand === undefined) return undefined
    const other = typeofOperand(left) === undefined ? left : right
    const [string] = evaluate(other)
    if (string?.kind !== 'constant' || typeof string.value !== 'string') return undefined
    if (uncatalogued(operand) !== undefined) return leaf(shown, 'undecided')
    const constant = string.value
    const holds = (type: string) =>
      other === right
        ? compareStrings(node['operator'] as string, type, constant)
        : compareStrings(node['operator'] as string, constant, type)
    const whenMissing = holds('undefined')
    // `typeof h.m` of a native holder `h` and a constant `m`, checked against the catalog along `h`'s chain (§7).
    const read = memberRead(operand)
    if (read !== undefined) {
      const objects = evaluate(read.object)
      const holder = objects.find((value) => value.kind === 'holder')
      const keys = read.key === undefined ? [] : evaluate(read.key)
      const member = read.name ?? (keys.length === 1 && keys[0]!.kind === 'constant' && !heapRead(keys) ? keys[0]!.value : null)
      if (holder?.kind === 'holder' && member !== null) {
        const key = toPropertyKey(member)
        const tested = memberName(holder.holder, key)
        const checked = catalogCheck(objects, key, true)
        if (checked === 'uncatalogued') return leaf(shown, 'undecided', tested)
        if (checked === 'never') return never(node, shown, tested, whenMissing !== outcome)
        if (checked === 'always') return always(node, shown, tested, holds(key === 'length' ? 'number' : 'string') === outcome)
      }
    }
    const values = evaluate(operand)
    const tested = nativeName(values)
    if (tested === undefined) return undefined
    const whenPresent = holds(nativeType(values))
    if (whenMissing === whenPresent) return leaf(shown, 'transparent', tested)
    return presence(shown, { tested, present: whenPresent === outcome })
  }

  /** `x == null`, `x === undefined`, `void 0 === x`: the native `x` tested, or undefined when it is no such test. */
  const nullTest = (node: AstNode, outcome: boolean, shown: AstNode): Classified | undefined => {
    if (node.type !== 'BinaryExpression' || !equalities.has(node['operator'] as string)) return undefined
    const left = node['left'] as AstNode
    const right = node['right'] as AstNode
    const operand = isNullish(right) ? left : isNullish(left) ? right : undefined
    if (operand === undefined) return undefined
    const values = evaluate(operand)
    const tested = nativeName(values)
    if (tested === undefined) return undefined
    const equal = (node['operator'] as string).startsWith('=')
    const present = equal !== outcome
    if (!present && resolution.onceFlag(operand)) {
      // A once-flag that saves the native (Clarity's `if (original === null) { original = history[method]; … }`) holds
      // its own nullish value until it does, which takes the arm whether or not the native exists: that alternative is
      // the flag's test, transparent (§5 Resolver capabilities 6, §7), and the most-reaching wins (§7 OR, Principle 3).
      // The native alternative stays the absence test it is. A heap-read nullish value can't be decided.
      const literal = operand === left ? right : left
      const strict = (node['operator'] as string).length === 3
      const matches = (value: unknown) =>
        strict ? value === (literal.type === 'Literal' ? null : undefined) : value === null || value === undefined
      const own = values.filter((value) => value.kind === 'constant' && matches(value.value))
      if (own.length > 0) return leaf(shown, own.some((value) => !heapRead([value])) ? 'transparent' : 'config', tested)
    }
    return presence(shown, { tested, present })
  }

  /** `"k" in o`, `o.hasOwnProperty("k")`, `Object.hasOwn(o, "k")` on a native holder: the member tested. */
  const memberTest = (node: AstNode, outcome: boolean, shown: AstNode): Classified | undefined => {
    let object: AstNode | undefined
    let key: AstNode | undefined
    if (node.type === 'BinaryExpression' && node['operator'] === 'in') {
      object = node['right'] as AstNode
      key = node['left'] as AstNode
    } else if (node.type === 'CallExpression') {
      const parts = resolution.ownTestParts(node, at)
      if (parts === undefined) return undefined
      object = parts.object
      key = parts.key ?? undefined
    }
    if (object === undefined) return undefined
    const objects = evaluate(object)
    const holder = objects.find((value) => value.kind === 'holder')
    if (holder?.kind !== 'holder') return undefined
    const keys: Value[] = key === undefined ? [{ kind: 'constant', value: undefined }] : evaluate(key)
    const [constant] = keys
    if (keys.length !== 1 || constant?.kind !== 'constant' || heapRead(keys)) return leaf(shown, 'undecided')
    const member = toPropertyKey(constant.value)
    const tested = memberName(holder.holder, member)
    const checked = catalogCheck(objects, member, node.type === 'BinaryExpression')
    if (checked === 'uncatalogued') return leaf(shown, 'undecided', tested)
    if (checked === 'never') return never(node, shown, tested, outcome)
    if (checked === 'always') return always(node, shown, tested, outcome)
    return presence(shown, { tested, present: outcome })
  }

  /**
   * A test whose member no catalog version places where it looks (§7): the arm where it is missing always runs, so the
   * test is transparent there, and the arm where it is present never does, so it is dead. Its step is the presence test
   * it reads as.
   */
  const never = (node: AstNode, shown: AstNode, tested: string, present: boolean): Classified =>
    present ? { ...presence(shown, { tested, present }), dead: node } : leaf(shown, 'transparent', tested)

  /**
   * A test of a member every holder it can be has, a function's own `length` or `name` (§7): the arm where it is
   * present always runs, so the test is transparent there, and the arm where it is missing never does, so it is dead.
   * Its step is the absence test it reads as. `holds` is whether the arm holds when the member is present.
   */
  const always = (node: AstNode, shown: AstNode, tested: string, holds: boolean): Classified =>
    holds ? leaf(shown, 'transparent', tested) : { ...presence(shown, { tested, present: false }), dead: node }

  /**
   * What the catalog says of `member` on the holders a tested object can be (§7 Checking guards against the catalog):
   * `always` for a function's own `length` or `name` when every holder it can be is a function, as ECMA-262 gives every
   * function both; `uncatalogued` when no holder in any realm has a member of that name, `never` when no catalog
   * version has it on any of them (directly, or for `in` and `typeof` along the modelled prototype chain), and
   * otherwise `catalogued`.
   */
  const catalogCheck = (
    objects: readonly Value[],
    member: Key,
    chain: boolean,
  ): 'always' | 'uncatalogued' | 'never' | 'catalogued' => {
    if (
      (member === 'length' || member === 'name') &&
      objects.length > 0 &&
      objects.every((value) => value.kind === 'holder' && isFunctionHolder(value.holder))
    ) {
      return 'always'
    }
    if (!names(catalog).has(typeof member === 'symbol' ? symbolMember(member) : member)) return 'uncatalogued'
    if (objects.length === 0) return 'catalogued'
    for (const value of objects) {
      // Looking a member up on `null` or `undefined` throws (ECMA-262 ToObject), so the test never holds for it: a
      // native holder that may be missing (§7).
      const nullish = value.kind === 'constant' && (value.value === null || value.value === undefined)
      if (nullish && !heapRead([value]) && !flagged([value])) continue
      // An object that may be no native holder can't be checked.
      if (value.kind !== 'holder') return 'catalogued'
      let holder: string | null = value.holder
      const seen = new Set<string>()
      while (holder !== null && !seen.has(holder)) {
        seen.add(holder)
        const entry: CatalogHolder | undefined = holders[holder]
        // A holder the catalog doesn't model can't be checked.
        if (entry === undefined) return 'catalogued'
        // A target a later version dropped was still placed there by an earlier one.
        const name = memberName(holder, member)
        if (Object.hasOwn(targets, name) || Object.hasOwn(dropped, name)) return 'catalogued'
        const own = instanceMembers[entry.owner]
        if (entry.kind === 'instance' && own !== undefined && typeof member === 'string' && Object.hasOwn(own, member)) {
          return 'catalogued'
        }
        holder = chain ? entry.proto : null
      }
    }
    return 'never'
  }

  /** Whether a holder is a function: an interface object or constructor, or `Function.prototype` (ECMA-262 20.2.3). */
  const isFunctionHolder = (holder: string): boolean =>
    holder === 'Function.prototype' || (Object.hasOwn(holders, holder) && holders[holder]!.kind === 'constructor')

  /** The source of the functions a call may run that the analyzer knows: the user functions its callee can be. */
  const calledSources = (node: AstNode): string[] =>
    node.type !== 'CallExpression'
      ? []
      : evaluate(node['callee'] as AstNode).flatMap((value) =>
          value.kind === 'object' && value.heap?.kind === 'function'
            ? [text.slice(value.heap.node.start, value.heap.node.end)]
            : [],
        )

  /**
   * A writability check (`isReadOnly`, `isPropertyWritable`, a descriptor's `writable`): transparent (§7). It is named
   * so, or it calls a function that reads a descriptor's `writable`.
   */
  const writabilityTest = (node: AstNode, shown: AstNode): Classified | undefined => {
    const writability =
      writabilityNames.test(text.slice(node.start, node.end)) ||
      calledSources(node).some((source) => /getOwnPropertyDescriptor/.test(source) && /\.writable\b/.test(source))
    return writability ? leaf(shown, 'transparent') : undefined
  }

  /** A brand check (`[object Promise]`) or a native-code check: the native judged, when one is passed. */
  const brokenTest = (node: AstNode, shown: AstNode): Classified | undefined => {
    const source = text.slice(node.start, node.end)
    let broken = brokenNames.test(source) || /["'`]\[object /.test(source)
    if (!broken) broken = calledSources(node).some((source) => /native code/.test(source))
    if (!broken) return undefined
    let tested: string | undefined
    walkReads(node, (read) => {
      if (tested !== undefined || read.type !== 'CallExpression') return
      for (const argument of read['arguments'] as AstNode[]) {
        tested ??= nativeName(evaluate(argument))
      }
    })
    return leaf(shown, 'broken-native', tested)
  }

  /** Whether a test reads a key a member sweep gave (§5 Resolver capabilities 9), anywhere in it. */
  const readsSwept = (node: AstNode): boolean => {
    let found = false
    let count = 0
    walkReads(node, (read) => {
      if (found) return
      if (count++ >= maxReads) return context.capHit('testReads', node)
      if (read.type === 'Identifier' || read.type === 'MemberExpression') {
        if (evaluate(read).some(isSwept)) found = true
      }
    })
    return found
  }

  /**
   * A filter on a swept key (§5 Resolver capabilities 9): a test the analyzer evaluates on the key. Decided, it
   * keeps the member (transparent) or drops it, so the write never happens for that key and gives nothing. Undecided
   * (`cfg.shouldPatch(k)`), it keeps every member, and the guard is `undecided`.
   */
  const sweepFilter = (node: AstNode, outcome: boolean, shown: AstNode): Classified | undefined => {
    if (!resolution.swept()) return undefined
    const found = sweepTest(node, outcome, shown)
    if (found !== undefined) sweepTests.add(node)
    return found
  }
  const sweepTest = (node: AstNode, outcome: boolean, shown: AstNode): Classified | undefined => {
    const values = evaluate(node)
    if (decided(values) && values.some(isSwept)) {
      const taken = truthiness(values)
      if (taken === undefined) return leaf(shown, 'undecided')
      if (taken === outcome) return leaf(shown, 'transparent')
      sweepFilters.add(node)
      return { ...leaf(shown, 'transparent'), dead: node }
    }
    return readsSwept(node) ? leaf(shown, 'undecided') : undefined
  }

  /** A test's classification, made for the test itself however it is negated: the guard a `prune` step names. */
  const atom = (node: AstNode, outcome: boolean, shown: AstNode): Classified => ({
    ...atomOf(node, outcome, shown),
    tests: [node],
  })
  const atomOf = (node: AstNode, outcome: boolean, shown: AstNode): Classified => {
    if (tainted(node)) return leaf(shown, 'unknown')
    const filter = sweepFilter(node, outcome, shown)
    if (filter !== undefined) return filter
    // A test a call argument literal's field decides: the arm it rules out is never reached, and on the arm it
    // lets through the test is transparent. A recognized test of a native (`void 0 !== o.win.WebGLRenderingContext`)
    // is the native's presence, which no literal decides (§7): it keeps its own classification and tested native on
    // both arms, so an absence arm's polyfill stays a finding. Any other recognized test keeps its classification on
    // the arm the literal lets through.
    const taken = argumentTaken(node)
    const recognized =
      typeofTest(node, outcome, shown) ??
      nullTest(node, outcome, shown) ??
      memberTest(node, outcome, shown) ??
      writabilityTest(node, shown) ??
      brokenTest(node, shown)
    const native = recognized?.steps.some((each) => each.tested !== undefined) ?? false
    if (taken !== undefined && taken.taken !== outcome && !native) {
      ruledOutTests.add(node)
      return { ...leaf(shown, 'transparent'), dead: node, ...(taken.by === undefined ? {} : { by: taken.by }) }
    }
    if (recognized !== undefined) return recognized
    if (taken !== undefined) {
      const through = leaf(shown, 'transparent')
      for (const step of through.steps) argumentGuards.set(step, { test: node, literal: taken.by })
      return through
    }
    const values = evaluate(node)
    // A once-flag's test is transparent (§5 Resolver capabilities 6), and so is a test decided as a constant, or as an
    // object, which is always truthy. A value that mixes a flag's constant with anything else (Clarity's `check()`:
    // `status === false && typeof Promise !== "undefined" && …`) is no flag's test, and constants that differ in
    // truthiness (`!!cfg.disable`) decide nothing (§7 `conditional`).
    if (flagTest(values) || (decided(values) && truthiness(values) !== undefined) || objects(values)) {
      return leaf(shown, 'transparent')
    }
    if (node.type !== 'BinaryExpression') {
      const tested = nativeName(values)
      if (tested !== undefined) return presence(shown, { tested, present: outcome })
    }
    if (readsNative(node) || nativeMethodCall(node)) return leaf(shown, 'undecided')
    if (unresolvedCall(node)) return leaf(shown, 'unknown')
    if (readsAnything(node)) return leaf(shown, 'config')
    return leaf(shown, 'unknown')
  }

  /**
   * How a test comes out when a call argument literal's field decides it (§5 Resolver capabilities 5): in the
   * write's frame, or, for a path judged under a call with no frame, in that call's frame.
   * Undefined for any other test.
   */
  const argumentTaken = (node: AstNode): { taken: boolean; by: AstNode | undefined } | undefined => {
    const decided = (values: Value[]) => {
      const taken = argumentDecided(values)
      return taken === undefined ? undefined : { taken, by: settlingLiterals(values)[0] }
    }
    const here = decided(resolution.settled(evaluate(node)))
    if (here !== undefined) return here
    const call = context.call
    const fn = context.parentOf === undefined ? undefined : enclosingFunction(node, context.parentOf)
    if (call === undefined || fn === undefined || call.site.fn !== fn || frameOf(at.frame, fn) !== undefined) return undefined
    if (!passesLiteral(call.site.args) || !resolution.argumentTest(node, fn)) return undefined
    const frame = resolution
      .framesOf(fn)
      .find((each) => each.bindings.some((binding) => binding.site.call === call.site.call && binding.caller?.id === call.caller?.id))
    return frame === undefined ? undefined : decided(resolution.settled(resolution.evaluate(node, { ...at, frame })))
  }

  /**
   * The argument a test that reads a parameter of the frame's function takes, where the call is: a guard inside a helper
   * summary is judged with the arguments of the call (§7). Undefined unless the frame is one call's that lists it.
   */
  const argumentOf = (node: AstNode): { node: AstNode; at: Position } | undefined => {
    const fn = context.parentOf === undefined ? undefined : enclosingFunction(node, context.parentOf)
    if (fn === undefined) return undefined
    const frame = frameOf(at.frame, fn)
    const [binding, ...others] =
      frame === undefined ? (context.call?.site.fn === fn ? [context.call] : []) : frame.how === 'call' ? frame.bindings : []
    if (binding === undefined || others.length > 0) return undefined
    const index = (fn['params'] as AstNode[]).findIndex((param) => param.type === 'Identifier' && param['name'] === node['name'])
    // Only the parameter itself, never reassigned in the function: otherwise its value is not the argument's.
    if (index < 0 || declarationOf(node, context.scope) !== fn || reassigned(fn, node['name'] as string, context.scope)) {
      return undefined
    }
    const { site } = binding
    const argument = site.args[index]
    if (argument === undefined || argument.type === 'SpreadElement') return undefined
    if (site.unlisted !== undefined && index >= site.unlisted) return undefined
    return { node: argument, at: positionOf(binding) }
  }

  const classify = (node: AstNode, outcome: boolean, shown: AstNode = node): Classified => {
    switch (node.type) {
      case 'Identifier': {
        const argument = argumentOf(node)
        if (argument !== undefined) {
          return classifierOf(write, argument.at, { ...context, call: undefined }).classify(argument.node, outcome)
        }
        break
      }
      case 'UnaryExpression':
        if (node['operator'] === '!') return classify(node['argument'] as AstNode, !outcome, shown)
        break
      case 'SequenceExpression':
        return classify((node['expressions'] as AstNode[]).at(-1)!, outcome, shown)
      case 'ChainExpression':
        return classify(node['expression'] as AstNode, outcome, shown)
      case 'LogicalExpression': {
        const operator = node['operator'] as string
        if (operator === '??') break
        const left = classify(node['left'] as AstNode, outcome)
        const right = classify(node['right'] as AstNode, outcome)
        // `a && b` holds when both do, and `a || b` fails when both do: one path. Otherwise either decides it.
        const both = (operator === '&&') === outcome
        return both ? bothOf(left, right) : eitherOf(left, right)
      }
    }
    return atom(node, outcome, shown)
  }

  /** A condition's value: its tests along one path (all), or across alternatives (any). */
  const condition = (when: Condition): Classified => {
    if (typeof when === 'boolean') return { result: 'unconditional', steps: [], tests: [] }
    if ('test' in when) return classify(when.test, when.outcome)
    const parts = ('all' in when ? when.all : when.any).map(condition)
    return parts.reduce('all' in when ? bothOf : eitherOf)
  }

  return { classify, condition, taintStep }
}

/**
 * The `catch` arms whose `try` block can't throw (§5 Resolver capabilities 9): a
 * write only such an arm reaches never happens, so it gives nothing, but the resolver counts it as a `prune`.
 */
export const unreachedArms = new WeakSet<AstNode>()

/** What judging a `try` block where a write's path enters its `catch` needs, at the write's position. */
function throwContext(at: Position, { resolution, scope, catalog, realm, caps, capHit }: GuardContext) {
  const targets = catalog.targets[realm]
  const holders = catalog.holders[realm]
  return {
    evaluate: (node: AstNode) => resolution.evaluate(node, at),
    declaration: (id: AstNode) => scope.declaration(id),
    maxDepth: caps.throwDepth,
    depthCut: (fn: AstNode) => capHit('throwDepth', fn),
    target: (holder: string, key: Key) => {
      for (let on: string | null = holder; on !== null; on = Object.hasOwn(holders, on) ? holders[on]!.proto : null) {
        const name = memberName(on, key)
        if (Object.hasOwn(targets, name)) return targets[name]
      }
      return undefined
    },
  }
}

/**
 * The tests that are filters on a swept key (§5 Resolver capabilities 9): a write such a test drops is no write of
 * that key at all, so it gives nothing, and no `prune` counts it.
 */
export const sweepFilters = new WeakSet<AstNode>()
/**
 * The tests a call argument literal's field decides against the path (§5 Resolver capabilities 5): the arm they
 * rule out is not reached, so a write there gives nothing, but the resolver counts it as a `prune`.
 */
export const ruledOutTests = new WeakSet<AstNode>()
/**
 * The `guard` steps of tests a call argument literal's field settled the way the path needs, each with the test
 * and that literal: a write that only the arm the test rules out reaches leaves a `prune` step after it.
 */
export const argumentGuards = new WeakMap<GuardStep, { test: AstNode; literal: AstNode | undefined }>()
/** The tests that are filters on a swept key, which the sweep's `enumeration` step records (§14). */
export const sweepTests = new WeakSet<AstNode>()

/** Every member name the catalog has on any holder in any realm, per catalog. */
const catalogNames = new WeakMap<SerializedCatalog, ReadonlySet<string>>()

function names(catalog: SerializedCatalog): ReadonlySet<string> {
  let found = catalogNames.get(catalog)
  if (found === undefined) {
    const all = new Set<string>()
    for (const realm of Object.values(catalog.targets)) {
      for (const target of Object.values(realm)) all.add(target.member)
    }
    for (const realm of Object.values(catalog.instanceMembers)) {
      for (const members of Object.values(realm)) for (const member of Object.keys(members)) all.add(member)
    }
    catalogNames.set(catalog, (found = all))
  }
  return found
}

/** How each class reads in a step's text. */
const wording: Readonly<Record<GuardClass, string>> = {
  transparent: 'transparent',
  absence: 'an absence test',
  'broken-native': 'a broken-native check',
  config: 'a config or option flag',
  'other-target': 'a presence test of another native',
  unknown: 'a guard the analyzer does not recognize',
  undecided: 'a guard that cannot be decided statically',
}

/** The object and key of a member read `o.m` or `o[k]`: the name `m`, or the key expression `k`. */
function memberRead(node: AstNode): { object: AstNode; name?: string; key?: AstNode } | undefined {
  if (node.type !== 'MemberExpression' || (node['object'] as AstNode).type === 'Super') return undefined
  const object = node['object'] as AstNode
  const property = node['property'] as AstNode
  if (node['computed'] === true) return { object, key: property }
  return property.type === 'Identifier' ? { object, name: property['name'] as string } : undefined
}

/** Where a call on a chain is: its guards, whether it is top-level, and its caller's frame. */
function positionOf({ site, caller }: Binding): Position {
  return { guard: (name) => site.guards.get(name), topLevel: site.topLevel, frame: caller }
}

/** The declaration a reference resolves to, or none: a name the seam recorded no reference for. */
function declarationOf(id: AstNode, scope: ScopeRules): AstNode | undefined {
  try {
    return scope.declaration(id)
  } catch {
    return undefined
  }
}

/** Per function, the names of its parameters that code in it assigns (`reassigned`). */
const assignedParameters = new WeakMap<AstNode, Set<string>>()

/** Whether code in `fn` assigns its parameter `name`: by `=` and its compound forms, `++`/`--`, or a `for`-`in`/`of` head. */
function reassigned(fn: AstNode, name: string, scope: ScopeRules): boolean {
  let names = assignedParameters.get(fn)
  if (names === undefined) {
    const found = new Set<string>()
    const targets = (pattern: AstNode) => {
      const ids = pattern.type === 'Identifier' ? [pattern] : pattern.type.endsWith('Pattern') ? boundIdentifiers(pattern) : []
      for (const id of ids) if (declarationOf(id, scope) === fn) found.add(id['name'] as string)
    }
    walkTree(fn['body'] as AstNode, {
      enter(node) {
        if (node.type === 'AssignmentExpression') targets(node['left'] as AstNode)
        else if (node.type === 'UpdateExpression') targets(node['argument'] as AstNode)
        else if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node['left'] !== undefined) {
          targets(node['left'] as AstNode)
        }
      },
    })
    assignedParameters.set(fn, (names = found))
  }
  return names.has(name)
}

/** The path from the top of the function a node is in down to the node, outermost first. */
export function functionPath(node: AstNode, parentOf: (node: AstNode) => AstNode | undefined): AstNode[] {
  const path = [node]
  for (let at = parentOf(node); at !== undefined; at = parentOf(at)) {
    path.push(at)
    if (isFunction(at)) break
  }
  return path.reverse()
}

/** The innermost function around a node. */
function enclosingFunction(node: AstNode, parentOf: (node: AstNode) => AstNode | undefined): AstNode | undefined {
  for (let at = parentOf(node); at !== undefined; at = parentOf(at)) if (isFunction(at)) return at
  return undefined
}

/** `x` for `typeof x`. */
function typeofOperand(node: AstNode): AstNode | undefined {
  return node.type === 'UnaryExpression' && node['operator'] === 'typeof' ? (node['argument'] as AstNode) : undefined
}

/** `null`, `undefined` or `void …`. */
function isNullish(node: AstNode): boolean {
  if (node.type === 'Literal') return node['value'] === null && node['regex'] === undefined && node['raw'] === 'null'
  if (node.type === 'Identifier') return node['name'] === 'undefined'
  return node.type === 'UnaryExpression' && node['operator'] === 'void'
}

/** A comparison of two strings, as ECMA-262 compares them. */
function compareStrings(operator: string, a: string, b: string): boolean {
  switch (operator) {
    case '==':
    case '===':
      return a === b
    case '!=':
    case '!==':
      return a !== b
    case '<':
      return a < b
    case '>':
      return a > b
    case '<=':
      return a <= b
    default:
      return a >= b
  }
}

/**
 * Visits a test's nodes, without entering the functions it creates, and without the names that are no reads: a
 * member's or property's key written as a name.
 */
function walkReads(node: AstNode, visit: (read: AstNode) => void): void {
  let reads = testReads.get(node)
  if (reads === undefined) {
    const found: AstNode[] = []
    walkTree(node, {
      enter(each, parent) {
        if (each !== node && isFunction(each)) return false
        if (parent !== null && each.type === 'Identifier' && isKeyName(each, parent)) return false
        found.push(each)
      },
    })
    testReads.set(node, (reads = found))
  }
  for (const read of reads) visit(read)
}

/** The nodes `walkReads` visits in each test, in its order, found once: the syntax doesn't change (§18 step 1). */
const testReads = new WeakMap<AstNode, readonly AstNode[]>()

function isKeyName(id: AstNode, parent: AstNode): boolean {
  if (parent.type === 'MemberExpression') return parent['property'] === id && parent['computed'] !== true
  if (parent.type === 'Property') return parent['key'] === id && parent['computed'] !== true && parent['shorthand'] !== true
  return false
}

/**
 * The guards on a path from the top of the function it is in, judged under a resolved call of that function, or in
 * `frame`, one of its creation frames, when the path's own position has no frame.
 */
type Inside = (call: Binding | undefined, frame?: Frame) => Judgement

/** What judging along call chains needs besides the guards' context: the resolved calls of a function. */
export interface ChainContext extends GuardContext {
  /** The resolved calls of a function, each with its caller's frame when the resolver has one. */
  callers(fn: AstNode): readonly Binding[]
  parentOf(node: AstNode): AstNode | undefined
  /** For the function a direct eval's code is grafted in as, the eval call that runs it where the call is (§2). */
  runBy?(fn: AstNode): AstNode | undefined
  /**
   * For the function a link group's member runs in, the dynamic imports that load it, when only they do (§6 Link
   * groups): the code runs where an import is, after its guards, but never at load.
   */
  loadedBy?(fn: AstNode): readonly AstNode[] | undefined
  /**
   * For a factory a lazy chunk pushes into a chunk registry, the function its chunk runs in (§6 idiom 6): code reached
   * only through a chunk load waits on it, even when its module is required at top level.
   */
  chunkOf?(fn: AstNode): AstNode | undefined
}

/** A call being judged, by its memo key, or a function whose creation is. */
type Opened = string | AstNode

/** A walk out from a call being judged: its place among the open, what open before it it met, and what it opened. */
interface Walk {
  at: number
  met: Map<Opened, number>
  opened: Set<Opened>
}

/** A walk's result that isn't memoized (it met something open, or found nothing), with what it met and opened. */
interface Walked {
  found: Judgement | undefined
  /** Whether it met anything open, its own call or what it opened included. */
  cyclic: boolean
  met: readonly Opened[]
  opened: ReadonlySet<Opened>
}

/**
 * Judges writes along their call chains (§7): the guards on a write's path in the function it is in, AND the chain out
 * from there, with the `guard` steps of the alternative that gives it, outermost first. The chain ends at top-level
 * code, the install entry, with basis `call-path`.
 *
 * A function with no resolved caller, or one reached only through itself, is no install entry: it is judged from its
 * **creation site** (ADR 0013), the reachability of the code that created it AND the guards in force where it was
 * created, then its own guards, with basis `creation-site` and a `creation-site` step after the creation path's guards.
 * A creation that no code reaches (after an unconditional `return` or `throw`), or that only the function itself
 * creates, was never evaluated, and gives `unknown`.
 *
 * The guards in a function are judged in its frame when the write is instantiated in one. Otherwise each resolved call
 * of the function is an alternative of its own, and a test of a parameter is judged as the argument that call passes.
 */
export function chainJudge(
  context: ChainContext,
): (path: readonly AstNode[], write: Judged, at: Position, fn: AstNode | undefined) => Judgement {
  // The chain out from each call, by call, caller frame and target, when its walk met nothing being judged.
  const memo = new Map<string, Judgement>()
  // What is being judged, each with its place, outermost first: the calls (by memo key), whose alternatives through
  // themselves (a recursion) add nothing, and the functions whose creation is being judged, whose creation through
  // themselves is never evaluated.
  const open = new Map<Opened, number>()
  // How many judgements met an open one, whose result then holds only for walks that meet the same.
  let cycles = 0
  // The walks of the calls being judged, innermost last.
  const walks: Walk[] = []
  // The chain out from each call whose walk met something being judged (a cycle), by memo key: a walk's result holds
  // wherever the same things it met are open and none it opened is, since it then takes the same way.
  // Without it, every way into a recursion judged the recursion again, exponentially in its size.
  const walked = new Map<string, Walked[]>()

  const pathTo = (node: AstNode): AstNode[] => functionPath(node, context.parentOf)

  /**
   * The most-reaching of alternatives, with the steps of the first that gives it; none when there are none. A dead
   * alternative drops out, and the result is dead only when every alternative is. A `call-path` alternative is taken
   * before a `creation-site` one that gives the same value.
   */
  const best = (alternatives: readonly Judgement[]): Judgement | undefined => {
    if (alternatives.length === 0) return undefined
    const live = alternatives.filter((each) => each.dead === undefined)
    const from = live.length === 0 ? alternatives : live
    const reachability = from.map((each) => each.reachability).reduce(across)
    const giving = from.filter((each) => each.reachability === reachability)
    const found = giving.find((each) => each.basis !== 'creation-site') ?? giving[0]!
    // `load` when any of them reaches top-level code, else `deferred` from the first one's install entry (§7).
    if (!from.some((each) => each.entry === undefined)) return { ...found, entry: from[0]!.entry! }
    if (found.entry === undefined) return found
    const { reachability: value, steps, tests, dead, by, basis } = found
    return {
      reachability: value,
      steps,
      tests,
      ...(dead === undefined ? {} : { dead }),
      ...(by === undefined ? {} : { by }),
      ...(basis === undefined ? {} : { basis }),
    }
  }

  /** Two parts of one path (AND): the chain out, then the guards after it. The install entry is the chain out's. */
  const then = (out: Judgement, guards: Judgement, step?: CreationSiteStep): Judgement => {
    const { dead, by } = out.dead !== undefined ? out : guards
    const basis = out.basis ?? guards.basis
    return {
      reachability: along(out.reachability, guards.reachability),
      steps: [...out.steps, ...(step === undefined ? [] : [step]), ...guards.steps],
      tests: new Map([...out.tests, ...guards.tests]),
      ...(dead === undefined ? {} : { dead }),
      ...(by === undefined ? {} : { by }),
      ...(out.entry === undefined ? {} : { entry: out.entry }),
      ...(basis === undefined ? {} : { basis }),
    }
  }

  /**
   * The guards on a path in `fn`, from its start (`inside`, given the call `fn` is judged under), after the chain out
   * from `fn`: its calls in `frame` when there is one, else every resolved call of it, else its creation site.
   * Undefined when every way out comes back through code being judged.
   */
  const within = (
    fn: AstNode | undefined,
    frame: Frame | undefined,
    inside: Inside,
  ): Judgement | undefined => {
    if (fn === undefined) return inside(undefined)
    // A direct eval's code runs at its call, in its caller's frame: the call's guards and the chain out from it count.
    const call = context.runBy?.(fn)
    if (call !== undefined) {
      const out = reaching(pathTo(call), frame)
      return out === undefined ? undefined : then(out, inside(undefined))
    }
    // Code a dynamic import loads runs where an import is, guards and all, and waits on it: its install entry is the
    // import's own, or, for an import at load, the code's (§6, §7 Install context).
    const loads = context.loadedBy?.(fn)
    if (loads !== undefined) {
      const alternatives = loads.flatMap((load) => {
        const out = reaching(pathTo(load), undefined)
        return out === undefined ? [] : [{ ...then(out, inside(undefined)), entry: out.entry ?? fn }]
      })
      return best(alternatives)
    }
    const own = frameOf(frame, fn)
    if (own?.how === 'creation') return created(fn, own, inside)
    const bindings = own === undefined ? context.callers(fn) : own.bindings
    const alternatives = bindings.flatMap((binding) => {
      const out = outOf(binding)
      return out === undefined ? [] : [then(out, inside(binding))]
    })
    // A function no resolved call reaches, or reached only through itself, is judged from where it was created.
    const found = best(alternatives) ?? created(fn, own, inside)
    // A lazy chunk's code waits on its chunk's load (§6, §7 Install context).
    const chunk = context.chunkOf?.(fn)
    return chunk !== undefined && found !== undefined && found.entry === undefined ? { ...found, entry: chunk } : found
  }

  /**
   * A caller-less function judged from its creation site (§7, ADR 0013): the chain out from the code that created it,
   * the guards in force there, then its own. A function declaration is created when its scope is entered, before any
   * statement of it runs. Undefined while the function's own creation is being judged.
   */
  const created = (
    fn: AstNode,
    frame: Frame | undefined,
    inside: Inside,
  ): Judgement | undefined => {
    if (frame === undefined) {
      const framed = inCreationFrames(fn, inside)
      if (framed !== undefined) return framed
    }
    if (open.has(fn)) {
      meet(fn)
      return undefined
    }
    opened(fn)
    try {
      const made = frame?.created ?? fn
      const where = made.type === 'FunctionDeclaration' ? (context.parentOf(made) ?? made) : made
      const path = pathTo(where)
      const guards = inside(undefined)
      const step = creationStep(fn, made, frame?.receiverNode)
      const out = unreached(path) ? undefined : reaching(path, frame?.outer)
      // A creation no code reaches was never evaluated: there is no creation path to judge from.
      // Either way it is the install entry its writes wait on: no resolved call reaches it (§7 Install context).
      if (out === undefined) {
        return { ...guards, reachability: 'unknown', steps: [step(false), ...guards.steps], entry: fn, basis: 'creation-site' }
      }
      return { ...then({ ...out, basis: 'creation-site' }, guards, step(true)), entry: fn }
    } finally {
      open.delete(fn)
    }
  }

  /**
   * A caller-less function whose own guards read what only a frame binds (its parameters, `this`, or the variables of
   * the code around it) judged in each of its creation frames (§5 Resolver capabilities 3: a closure is analyzed with
   * the bindings of the code that made it; §7 Creation site), the most-reaching of them. Undefined when its guards read
   * nothing so, or it has no creation frame.
   */
  const inCreationFrames = (fn: AstNode, inside: Inside): Judgement | undefined => {
    const { functions } = context.resolution.contextual(() => inside(undefined))
    if (functions.size === 0) return undefined
    const frames = context.resolution.framesOf(fn, true).filter((frame) => frame.how === 'creation' && frame.fn === fn)
    return best(
      frames.flatMap((frame) => {
        const found = created(fn, frame, (call) => inside(call, frame))
        return found === undefined ? [] : [found]
      }),
    )
  }

  /**
   * The reachability of the point a path from the top of its function ends at (a direct eval's call, or where a function
   * was created): the guards on the path in that function, after the chain out from it, judged in `frame` when given.
   * Undefined when every way out comes back through code being judged.
   */
  const reaching = (path: readonly AstNode[], frame: Frame | undefined): Judgement | undefined => {
    const site = path.at(-1)!
    const owner = path.length > 1 && isFunction(path[0]!) ? path[0] : undefined
    return within(owner, frame, (call, own) => {
      const framed = frame ?? own
      return judge(
        path,
        { site, target: target!.target, taints: [] },
        { guard: () => undefined, topLevel: owner === undefined, ...(framed === undefined ? {} : { frame: framed }) },
        { ...context, call },
      )
    })
  }

  /** Whether a path goes through a statement that no code reaches: one after an unconditional `return` or `throw`. */
  const unreached = (path: readonly AstNode[]): boolean =>
    path.some((node, index) => index > 0 && reachedAfter(path[index - 1]!, node) === false)

  /** The `creation-site` step (§14) of a function judged from where `made` created it (or the object it is held on). */
  const creationStep =
    (fn: AstNode, made: AstNode, receiver: AstNode | undefined) =>
    (evaluated: boolean): CreationSiteStep => {
      const { starts } = context
      const at = locate(starts, fn.start, fn.end)
      const generated = locate(starts, made.start, made.end)
      const shown = receiver === undefined ? undefined : printed(receiver)
      return {
        kind: 'creation-site',
        function: at,
        generated,
        ...(shown === undefined ? {} : { this: shown }),
        text:
          `no resolved call reaches the function at ${at.line}:${at.column} made at ${generated.line}:${generated.column}, ` +
          (evaluated
            ? 'so it is judged from where it was made'
            : 'and no code that runs makes it, so its creation was never evaluated: unknown') +
          (shown === undefined ? '' : `, with \`this\` = \`${shown}\`, the object it is held on`),
      }
    }

  /** The chain out from a call, the guards around the call included: undefined for a cycle. */
  const outOf = (binding: Binding): Judgement | undefined => {
    const { site, caller } = binding
    const key = `${site.call.start}:${site.fn.start}<${caller?.id ?? ''}|${target!.key}`
    const known = memo.get(key)
    if (known !== undefined) return known
    if (open.has(key)) {
      meet(key)
      return undefined
    }
    const again = rewalked(key)
    if (again !== undefined) return again.found
    const walk: Walk = { at: opened(key), met: new Map(), opened: new Set() }
    walks.push(walk)
    const before = cycles
    let found: Judgement | undefined
    try {
      const path = pathTo(site.call)
      found = within(site.within, caller, (call, own) => {
        const at = positionOf(binding)
        const framed = at.frame === undefined && own !== undefined ? { ...at, frame: own } : at
        return judge(path, { site: site.call, target: target!.target, taints: [] }, framed, { ...context, call })
      })
    } finally {
      open.delete(key)
      walks.pop()
    }
    if (cycles === before && found !== undefined) {
      memo.set(key, found)
      // A call once judged only within a cycle may now be judged without one, so a walk that judged it there would no
      // longer take the same way.
      if (walked.has(key)) walked.clear()
      return found
    }
    walk.opened.add(key)
    const result: Walked = { found, cyclic: cycles !== before, met: [...walk.met.keys()], opened: walk.opened }
    const results = walked.get(key)
    if (results === undefined) walked.set(key, [result])
    else results.push(result)
    passOn(result)
    return found
  }

  /** Opens a call or creation for judging, as part of the walk around it, and gives its place. */
  const opened = (judged: Opened): number => {
    const at = open.size
    open.set(judged, at)
    walks.at(-1)?.opened.add(judged)
    return at
  }

  /** A walk met `judged`, which is open: a cycle, which the walks opened since it was can't be kept apart from. */
  const meet = (judged: Opened): void => {
    cycles++
    const walk = walks.at(-1)
    const at = open.get(judged)!
    if (walk !== undefined && at < walk.at) walk.met.set(judged, at)
  }

  /** Passes what a walk met and opened on to the walk it was taken in. */
  const passOn = (result: Walked): void => {
    const walk = walks.at(-1)
    if (walk === undefined) return
    for (const judged of result.opened) walk.opened.add(judged)
    for (const judged of result.met) {
      const at = open.get(judged)!
      if (at < walk.at) walk.met.set(judged, at)
    }
  }

  /** An earlier walk of the call `key` that would take the same way now: everything it met is open, nothing it opened is. */
  const rewalked = (key: string): Walked | undefined => {
    for (const result of walked.get(key) ?? []) {
      if (!result.met.every((judged) => open.has(judged))) continue
      if ([...open.keys()].some((judged) => result.opened.has(judged))) continue
      // Taken again, it meets what it met, as the walk around it does.
      if (result.cyclic) cycles++
      passOn(result)
      return result
    }
    return undefined
  }

  // The target of the write being judged, whose own presence a guard on the chain may test, and its memo key.
  let target: { target: Judged['target']; key: string } | undefined

  return (path, write, at, fn) => {
    target = { target: write.target, key: `${write.target.name}/${write.target.shadows ?? ''}` }
    const inside: Inside = (call, own) =>
      judge(path, write, at.frame === undefined && own !== undefined ? { ...at, frame: own } : at, { ...context, call })
    // Every way out coming back through itself leaves the function as its own install entry (§7 Install context).
    return within(fn, at.frame, inside) ?? { ...inside(undefined), ...(fn === undefined ? {} : { entry: fn }) }
  }
}

/**
 * The name of an install entry (§7 Install context): the function's own name, else the name it is bound to where it is
 * created (a variable, an assigned member, an object's property or a class's method), else null.
 */
export function entryName(fn: AstNode, parentOf: (node: AstNode) => AstNode | undefined): string | null {
  const own = fn['id'] as AstNode | null | undefined
  if (own?.type === 'Identifier') return own['name'] as string
  const parent = parentOf(fn)
  if (parent === undefined) return null
  switch (parent.type) {
    case 'VariableDeclarator':
      return parent['init'] === fn ? nameOf(parent['id'] as AstNode, false) : null
    case 'AssignmentExpression':
      return parent['right'] === fn ? nameOf(parent['left'] as AstNode, false) : null
    case 'Property':
    case 'MethodDefinition':
    case 'PropertyDefinition':
      return parent['value'] === fn ? nameOf(parent['key'] as AstNode, parent['computed'] === true) : null
    case 'ExportDefaultDeclaration':
      return 'default'
    default:
      return null
  }
}

/** A binding's name: an identifier, a member's property, or a constant key. */
function nameOf(node: AstNode, computed: boolean): string | null {
  if (node.type === 'MemberExpression') return nameOf(node['property'] as AstNode, node['computed'] === true)
  if (node.type === 'Identifier' && !computed) return node['name'] as string
  if (node.type === 'PrivateIdentifier') return `#${node['name'] as string}`
  if (node.type === 'Literal' && (typeof node['value'] === 'string' || typeof node['value'] === 'number')) {
    return String(node['value'])
  }
  return null
}

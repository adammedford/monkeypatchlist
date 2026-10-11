// Function summaries (§5 Resolver capabilities 3): a function is instantiated per call site with the values of the
// arguments there. A **frame** is one instantiation: the function, the call site (or, when a cap merges or widens
// calls, the sites) its parameters take their arguments from, and for each site the frame the arguments are evaluated
// in. So a write in `c` of the chain `a → b → c` is evaluated in the frame of `c` at its call in `b`, whose arguments
// are evaluated in the frame of `b` at its call in `a`, and so on out to a call that no function around it needs.
//
// Which function a call calls is read from the syntax here: a function or arrow expression called directly (an IIFE),
// a name whose declaration or definitions are functions, either of those through `.call` or `.apply`, a `new` of a
// class, which runs its constructor, and the callback an iteration native calls once per element of a constant
// collection (§5 Resolver capabilities 4): `names.forEach(n => fill(proto, n, w))`. A call whose callee the syntax
// doesn't name (a method, a callback, a closure, a bound function, `Reflect.apply`) is resolved from its callee's values
// (`global-object.ts`). A frame's `outer` is the frame of the code a function closes over, and its calls' receivers are
// its `this`.
//
// Loops (§5 Resolver capabilities 4): a loop statement is a context too. An **iteration** is a frame of the loop, one per
// element or counter value it unrolls, that runs within a frame of the code around the loop (`outer`). So is the frame
// of an iteration native's callback, which runs within the frame of the code that calls the native.
//
// Caps (§18 Context policy): a chain deeper than the `depth` cap's frames, or one that reaches a function already on
// it (recursion), widens: the call's function runs in its widened frame, whose parameters take the arguments of every
// call of it, evaluated with no frame around them. More than the `contexts` cap's frames of one function merge: the
// calls that carry no native are merged first. A widened or merged call that carries the global object, a native
// holder or a native member raises `analysis-budget` (Principle 5). Every cut is counted.

import { createHash } from 'node:crypto'
import { calleeExpression, walkTree, type AstNode } from './ast.ts'
import type { Definitions } from './definitions.ts'
import type { ModuleLink } from './module-links.ts'
import type { ScopeRules } from './scope.ts'

/** Free names a `typeof` test shows are defined, each with the test. */
type Guards = ReadonlyMap<string, AstNode>

/** A call of a known function, where its arguments are. */
export interface CallSite {
  /** The call or `new` expression. */
  call: AstNode
  /** The function called. */
  fn: AstNode
  /** The arguments, from the first one bound to the first parameter (after `.call`'s or `.apply`'s `this`). */
  args: readonly AstNode[]
  /** The index from which the arguments can't be listed: a spread, or `.apply` of anything but an array literal. */
  unlisted?: number
  /** Whether `this` at the call is the script's top-level `this`. */
  topLevel: boolean
  /** The `typeof` guards around the call, which show a free name is defined there. */
  guards: Guards
  /** The function whose own code holds the call, if any. */
  within: AstNode | undefined
  /** The loops and the function around the call, innermost first, out to the function whose own code holds it. */
  contexts: readonly AstNode[]
  /**
   * For a callback an iteration native calls (§5 Resolver capabilities 4), the native and the collection it visits:
   * `names` in `names.forEach(cb)`, `names` in `Array.from(names, cb)`. Its arguments are the elements' (`Binding`).
   */
  iterates?: { native: string; collection: AstNode }
  /**
   * What `this` is in the call (§5 Resolver capabilities 3): the instance a `new` makes (`new`), or an expression
   * evaluated where the call is: the object a method is read from (`o` in `o.m()`), or a `thisArg` (`f.call(t)`), or
   * `none` for a call that passes no `this`: a plain call `f()`, `f.call()`, or an iteration native's callback with no
   * `thisArg`. ECMA-262 binds the global object as a sloppy function's `this` there, and `undefined` as a strict
   * one's. Left out when the call's `this` is unknown, as a spread `thisArg` is.
   */
  receiver?: 'new' | 'none' | AstNode
  /**
   * For a call the syntax doesn't name, the module links its callee's value came through (§6): `(0, o.H7)(…)` calls
   * module 8974's export `H7`. The trace records each as a `module-link` step before the call's.
   */
  links?: { node: AstNode; link: ModuleLink }[]
}

/** Where a call is: what a call site needs, whichever function it turns out to call. */
export interface CallInfo {
  topLevel: boolean
  guards: Guards
  within: AstNode | undefined
  contexts: readonly AstNode[]
}

/** A call site, with the frame its arguments are evaluated in: none for a call no function around it needs. */
export interface Binding {
  site: CallSite
  caller: Frame | undefined
  /** For an iteration native's callback, the index of the element this call visits. */
  element?: number
  /**
   * For a call of a function value (§5 Resolver capabilities 3), the frame the function was created in: its closure,
   * whose bindings the function reads. For a call by name, the frame of the code the call is in that holds the function.
   */
  closure?: Frame | undefined
  /** A key for the receiver when the binding has a precomputed one, so that two receivers make two frames. */
  receiverKey?: string
}

/** An instantiation of a function (above). */
export interface Frame {
  fn: AstNode
  bindings: readonly Binding[]
  /** A key that two instantiations of the same function in the same context share. */
  id: string
  /** How many frames the chain out from this one holds. */
  depth: number
  /**
   * How the frame came about: one call, several merged by the context cap, every call, widened, or none: a function
   * object that no resolved call reaches, judged from where it was created (`creation`, §5, §7).
   */
  how: 'call' | 'merged' | 'widened' | 'creation'
  /**
   * For a loop's iteration, or an iteration native's callback, the frame of the code it runs within: the function or
   * loop around the loop, or the code that calls the native. Its parameters and loop variables are read through it.
   */
  outer?: Frame | undefined
  /** For a loop's iteration, its index. */
  iteration?: number
  /** The loop or call whose iterations the iteration cap cut, when this frame is one of the iterations done. */
  cut?: AstNode
  /**
   * For an iteration over a catalog-bounded list (§5 Resolver capabilities 9): no cap bounds its iterations, nor
   * the frames of the calls made in them, and only the step budget bounds them.
   */
  bounded?: true
  /** For a `creation` frame, the node its function object was created or assumed to be held at, for the trace. */
  created?: AstNode
  /**
   * For a `creation` frame whose function has a `this` of its own, the object it is shown to be held on (a value of the
   * resolution's), and the node that made that object.
   */
  receiver?: unknown
  receiverNode?: AstNode
}

export interface CallGraph {
  /** The calls of known functions a call expression is: one per function its callee can be. */
  sitesOf(call: AstNode): readonly CallSite[]
  /** Whether the callee of a call can be something other than the functions `sitesOf` lists. */
  open(call: AstNode): boolean
  /** Every call of a function, in document order. */
  callsOf(fn: AstNode): readonly CallSite[]
  /** The function whose own code holds `node`, if any. */
  functionOf(node: AstNode): AstNode | undefined
  /** Where a call or `new` expression is. */
  infoOf(call: AstNode): CallInfo | undefined
  /** Every call and `new` expression of the program, in document order. */
  allCalls(): readonly AstNode[]
}

const functionTypes: ReadonlySet<string> = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
export const isFunction = (node: AstNode): boolean => functionTypes.has(node.type)

const loopTypes: ReadonlySet<string> = new Set([
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
  'WhileStatement',
  'DoWhileStatement',
])
/** A loop statement, which may be unrolled (§5 Resolver capabilities 4). */
export const isLoop = (node: AstNode): boolean => loopTypes.has(node.type)

/**
 * The natives that call a callback once per element of an array (ECMA-262), by method name, with the index of the
 * callback's parameter that takes the element. `from` is `Array.from(items, mapfn)`.
 */
export const iterationNatives: ReadonlyMap<string, { element: number }> = new Map([
  ['forEach', { element: 0 }],
  ['map', { element: 0 }],
  ['filter', { element: 0 }],
  ['some', { element: 0 }],
  ['every', { element: 0 }],
  ['find', { element: 0 }],
  ['findIndex', { element: 0 }],
  ['findLast', { element: 0 }],
  ['findLastIndex', { element: 0 }],
  ['flatMap', { element: 0 }],
  ['reduce', { element: 1 }],
  ['reduceRight', { element: 1 }],
  ['from', { element: 0 }],
])

/**
 * The calls in a program, and the functions they call. `guardsAt(parent, child)` gives the `typeof` guards a branch
 * adds, as the resolver's walk takes them.
 */
export function callGraph(
  program: AstNode,
  scope: ScopeRules,
  definitions: Definitions,
  guardsAt: (parent: AstNode, child: AstNode) => Guards,
): CallGraph {
  let index:
    | {
        sites: Map<AstNode, CallSite[]>
        open: Set<AstNode>
        calls: Map<AstNode, CallSite[]>
        functions: AstNode[]
        info: Map<AstNode, CallInfo>
        all: AstNode[]
      }
    | undefined

  /**
   * The functions a callee can be, and whether it can be something else too. A class is its constructor (`constructorOf`),
   * and only a `new` (`construct`) calls it: calling a class throws.
   */
  function functionsOf(callee: AstNode, construct = false): { fns: AstNode[]; open: boolean } {
    const expression = calleeExpression(callee)
    if (isFunction(expression)) return { fns: [expression], open: false }
    if (isClass(expression)) return construct ? { fns: [constructorOf(expression)], open: false } : { fns: [], open: true }
    if (expression.type !== 'Identifier') return { fns: [], open: true }
    const key = definitions.keyOf(expression)
    if (key === undefined) return { fns: [], open: true }
    // An import binding of a link group names the variable it is by that variable's own name (§6).
    const name = key.name
    const fns: AstNode[] = []
    let open = false
    if (key.scope === 'global') {
      const binding = scope.resolve(expression)
      const declaration = binding === 'local' ? undefined : binding.declaration
      if (declaration !== undefined && declaration.kind !== 'var' && isFunction(declaration.node)) fns.push(declaration.node)
      else open = true
    } else if (isFunction(key.scope)) {
      const id = key.scope['id'] as AstNode | null | undefined
      // The function's own name, or a parameter or `arguments`, which the call binds.
      if (id?.['name'] === name && key.scope.type !== 'ArrowFunctionExpression') fns.push(key.scope)
      else open = true
    } else if (isClass(key.scope)) {
      const id = key.scope['id'] as AstNode | null | undefined
      if (id?.['name'] === name && construct) fns.push(constructorOf(key.scope))
      else open = true
    }
    for (const definition of definitions.of(key)) {
      const source = definition.source
      if (source !== undefined && definition.pattern.type === 'Identifier' && isFunction(source)) fns.push(source)
      else if (source !== undefined && definition.pattern.type === 'Identifier' && isClass(source) && construct) {
        fns.push(constructorOf(source))
      } else open = true
    }
    // A `var` or `let` that nothing defines, or a declaration with no function, is no known function.
    if (fns.length === 0) open = true
    return { fns: [...new Set(fns)], open }
  }

  function built(): NonNullable<typeof index> {
    if (index !== undefined) return index
    const sites = new Map<AstNode, CallSite[]>()
    const open = new Set<AstNode>()
    const calls = new Map<AstNode, CallSite[]>()
    const functions: AstNode[] = []
    const info = new Map<AstNode, CallInfo>()
    const all: AstNode[] = []
    // The functions around the walk, and the code whose `this` is open, and the guards, as the resolver keeps them.
    const around: AstNode[] = []
    // The loops and functions around the walk, innermost last.
    const contexts: AstNode[] = []
    let boundaries = 0
    const frames: { node: AstNode; guards: Guards; boundary: boolean }[] = []
    const guards = new Map<string, AstNode[]>()
    walkTree(program, {
      enter(node, parent) {
        if (parent !== null) {
          const guarded = guardsAt(parent, node)
          const boundary =
            node.type === 'FunctionDeclaration' ||
            node.type === 'FunctionExpression' ||
            node.type === 'StaticBlock' ||
            ((parent.type === 'PropertyDefinition' || parent.type === 'AccessorProperty') && parent['value'] === node)
          if (guarded.size > 0 || boundary) {
            frames.push({ node, guards: guarded, boundary })
            for (const [name, test] of guarded) {
              const tests = guards.get(name)
              if (tests === undefined) guards.set(name, [test])
              else tests.push(test)
            }
            if (boundary) boundaries++
          }
        }
        if (isFunction(node)) {
          functions.push(node)
          around.push(node)
        }
        if (isFunction(node) || isLoop(node)) contexts.push(node)
        if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return
        const within = around.at(-1)
        const own = contextsOf(contexts, within)
        info.set(node, { topLevel: boundaries === 0, guards: currentGuards(), within, contexts: own })
        all.push(node)
        for (const target of iterationsIn(node)) {
          const site: CallSite = {
            call: node,
            fn: target.fn,
            args: [],
            unlisted: 0,
            topLevel: boundaries === 0,
            guards: currentGuards(),
            within,
            contexts: own,
            iterates: target.iterates,
            ...(target.receiver === undefined ? {} : { receiver: target.receiver }),
          }
          const of = calls.get(target.fn)
          if (of === undefined) calls.set(target.fn, [site])
          else of.push(site)
        }
        const found = callsIn(node)
        if (found.open) open.add(node)
        if (found.targets.length === 0) return
        const current = currentGuards()
        const list: CallSite[] = []
        for (const target of found.targets) {
          const site: CallSite = {
            call: node,
            fn: target.fn,
            args: target.args,
            ...(target.unlisted === undefined ? {} : { unlisted: target.unlisted }),
            topLevel: boundaries === 0,
            guards: current,
            within,
            contexts: own,
            ...(target.receiver === undefined ? {} : { receiver: target.receiver }),
          }
          list.push(site)
          const of = calls.get(target.fn)
          if (of === undefined) calls.set(target.fn, [site])
          else of.push(site)
        }
        sites.set(node, list)
      },
      leave(node) {
        if (around.at(-1) === node) around.pop()
        if (contexts.at(-1) === node) contexts.pop()
        if (frames.at(-1)?.node !== node) return
        const frame = frames.pop()!
        for (const name of frame.guards.keys()) guards.get(name)!.pop()
        if (frame.boundary) boundaries--
      },
    })
    functions.sort((a, b) => a.start - b.start)
    return (index = { sites, open, calls, functions, info, all })

    function currentGuards(): Guards {
      if (guards.size === 0) return new Map()
      return new Map([...guards].flatMap(([name, tests]) => (tests.length > 0 ? [[name, tests.at(-1)!]] : [])))
    }
  }

  /**
   * The callbacks a call of an iteration native calls once per element (§5 Resolver capabilities 4): `c.forEach(cb)`
   * and the other array methods, and `Array.from(c, cb)`. Whether the collection is constant is judged when the call's
   * frames are made.
   */
  function iterationsIn(call: AstNode): { fn: AstNode; iterates: NonNullable<CallSite['iterates']>; receiver?: CallSite['receiver'] }[] {
    if (call.type !== 'CallExpression') return []
    const callee = calleeExpression(call['callee'] as AstNode)
    if (callee.type !== 'MemberExpression' || callee['computed'] === true) return []
    const native = (callee['property'] as AstNode)['name'] as string
    if (!iterationNatives.has(native)) return []
    const args = call['arguments'] as AstNode[]
    const object = callee['object'] as AstNode
    const from = native === 'from'
    if (from && !(object.type === 'Identifier' && object['name'] === 'Array')) return []
    const [collection, callback] = from ? [args[0], args[1]] : [object, args[0]]
    if (collection === undefined || callback === undefined) return []
    if (collection.type === 'SpreadElement' || callback.type === 'SpreadElement' || object.type === 'Super') return []
    const expression = calleeExpression(callback)
    const fns = isFunction(expression) ? [expression] : expression.type === 'Identifier' ? functionsOf(expression).fns : []
    // The callback's `this` is the native's `thisArg`, which `reduce` and `reduceRight` don't take (ECMA-262).
    const thisArg = native === 'reduce' || native === 'reduceRight' ? undefined : args[from ? 2 : 1]
    const receiver: CallSite['receiver'] = thisArg === undefined ? 'none' : thisArg.type === 'SpreadElement' ? undefined : thisArg
    return fns.map((fn) => ({ fn, iterates: { native, collection }, ...(receiver === undefined ? {} : { receiver }) }))
  }

  /** The functions a call calls, with the arguments bound to their parameters. */
  function callsIn(call: AstNode): {
    targets: { fn: AstNode; args: AstNode[]; unlisted?: number; receiver?: CallSite['receiver'] }[]
    open: boolean
  } {
    const callee = call['callee'] as AstNode
    const args = call['arguments'] as AstNode[]
    const spread = args.findIndex((arg) => arg.type === 'SpreadElement')
    const listed = (list: AstNode[], from: number) => ({ args: list, ...(from < 0 ? {} : { unlisted: from }) })
    // `f.call(t, …args)` and `f.apply(t, [ …args ])` call f with those arguments.
    const expression = calleeExpression(callee)
    if (
      call.type === 'CallExpression' &&
      expression.type === 'MemberExpression' &&
      expression['computed'] !== true &&
      ((expression['property'] as AstNode)['name'] === 'call' || (expression['property'] as AstNode)['name'] === 'apply')
    ) {
      const object = expression['object'] as AstNode
      if (object.type !== 'Identifier' && !isFunction(calleeExpression(object))) return { targets: [], open: true }
      const { fns, open } = functionsOf(object)
      let bound: { args: AstNode[]; unlisted?: number }
      if ((expression['property'] as AstNode)['name'] === 'call') {
        bound = listed(args.slice(1), spread < 0 ? -1 : Math.max(0, spread - 1))
      } else {
        const array = args[1]
        if (spread >= 0 && spread <= 1) bound = { args: [], unlisted: 0 }
        else if (array === undefined) bound = { args: [] }
        else if (array.type !== 'ArrayExpression') bound = { args: [], unlisted: 0 }
        else {
          const elements = array['elements'] as (AstNode | null)[]
          const hole = elements.findIndex((element) => element === null || element.type === 'SpreadElement')
          bound = listed(
            elements.slice(0, hole < 0 ? elements.length : hole) as AstNode[],
            hole < 0 ? -1 : elements[hole] === null ? -1 : hole,
          )
          // A hole is `undefined`, as a missing argument is, only when nothing follows it: otherwise unlisted.
          if (hole >= 0 && elements[hole] === null && hole < elements.length - 1) bound = { args: bound.args, unlisted: hole }
        }
      }
      // A `thisArg` written at the call is the function's `this`, and none passes no `this`.
      const thisArg = args[0]
      const receiver = thisArg === undefined ? { receiver: 'none' as const } : thisArg.type === 'SpreadElement' ? {} : { receiver: thisArg }
      return { targets: fns.map((fn) => ({ fn, ...bound, ...receiver })), open }
    }
    const construct = call.type === 'NewExpression'
    const { fns, open } = functionsOf(callee, construct)
    const receiver = construct ? { receiver: 'new' as const } : { receiver: 'none' as const }
    return { targets: fns.map((fn) => ({ fn, ...listed(args, spread), ...receiver })), open }
  }

  /** The function whose own code holds each node asked about, or null for none. */
  const owners = new WeakMap<AstNode, AstNode | null>()

  return {
    sitesOf: (call) => built().sites.get(call) ?? [],
    open: (call) => built().open.has(call) || !built().sites.has(call),
    callsOf: (fn) => built().calls.get(fn) ?? [],
    infoOf: (call) => built().info.get(call),
    allCalls: () => built().all,
    functionOf(node) {
      const known = owners.get(node)
      if (known !== undefined) return known ?? undefined
      const { functions } = built()
      let found: AstNode | undefined
      // The innermost function that holds the node, other than the node itself.
      for (const fn of functions) {
        if (fn.start > node.start) break
        if (fn !== node && fn.start <= node.start && node.end <= fn.end) found = fn
      }
      owners.set(node, found ?? null)
      return found
    },
  }
}

const classTypes: ReadonlySet<string> = new Set(['ClassDeclaration', 'ClassExpression'])
export const isClass = (node: AstNode): boolean => classTypes.has(node.type)

/**
 * The code a `new` of a class runs as its constructor: its `constructor` method's function, or the class itself when it
 * has none. Its frames are the class's constructions, whose `this` is the instance made.
 */
export function constructorOf(cls: AstNode): AstNode {
  const members = (cls['body'] as AstNode)['body'] as AstNode[]
  const method = members.find((member) => member.type === 'MethodDefinition' && member['kind'] === 'constructor')
  return method === undefined ? cls : (method['value'] as AstNode)
}

/** The loops around a node, innermost first, out to the function whose own code holds it, and that function. */
function contextsOf(contexts: readonly AstNode[], within: AstNode | undefined): AstNode[] {
  const out: AstNode[] = []
  for (let at = contexts.length - 1; at >= 0; at--) {
    out.push(contexts[at]!)
    if (contexts[at] === within) break
  }
  return out
}

/**
 * The longest frame id kept as it is, in characters: a longer one stands for itself as a digest. An id names the calls
 * out along its frame's chain, so ids are long (up to a few hundred KB on the corpus's New Relic builds at the shipped
 * caps), and the order the resolver works through frames in breaks ties by them (`framesInDocumentOrder`), so none the
 * shipped caps make may change. This is past those, and far under the string length a join can't exceed (about 5 × 10^8).
 */
const maxFrameIdLength = 1 << 20

/**
 * A frame id that stays bounded. A merged frame's id names every frame it merges, and a call's names its caller and
 * closure, so under raised caps ids grew geometrically with the depth of the chain, until a join exceeded the maximum
 * string length and threw `RangeError: Invalid string length`. Past `maxFrameIdLength` an id is replaced
 * by its leading characters and a digest of the whole, which is as deterministic as the id, and tells frames apart as
 * well (128 bits).
 */
export function frameId(id: string): string {
  if (id.length <= maxFrameIdLength) return id
  return `${id.slice(0, 32)}~${createHash('sha256').update(id).digest('base64url').slice(0, 22)}`
}

/**
 * A frame for one call of `site.fn`, with the frame its arguments are evaluated in. `closure` is the frame the function
 * was created in, which it reads its free variables through (`outer`), and `receiverKey` tells apart the frames of one
 * call whose receivers differ: a method is instantiated once per receiver object (§5 Resolver capabilities 5).
 */
export function callFrame(site: CallSite, caller: Frame | undefined, closure?: Frame, receiverKey?: string): Frame {
  const binding: Binding = {
    site,
    caller,
    ...(closure === undefined ? {} : { closure }),
    ...(receiverKey === undefined ? {} : { receiverKey }),
  }
  const id = frameId(
    `${site.call.start}:${site.fn.start}` +
      (receiverKey === undefined ? '' : `/${receiverKey}`) +
      (closure === undefined ? '' : `^${closure.id}`) +
      (caller === undefined ? '' : `<${caller.id}`),
  )
  return {
    fn: site.fn,
    bindings: [binding],
    id,
    depth: Math.max(caller?.depth ?? 0, closure?.depth ?? 0) + 1,
    how: 'call',
    ...(closure === undefined ? {} : { outer: closure }),
  }
}

/**
 * Frames in document order: by where their first call is, then the function called, then their ids, which name the
 * positions of the calls out along their chains. Whatever order the resolver found them in, the order it works through
 * them in is this one, so results are independent of visit order (§18 Context policy).
 */
export function framesInDocumentOrder<T extends Frame>(frames: readonly T[]): T[] {
  const key = (frame: Frame) => frame.bindings[0]?.site.call.start ?? -1
  return [...frames].sort((a, b) => key(a) - key(b) || a.fn.start - b.fn.start || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** Call sites in document order: by where the call is, then the function called. */
export const sitesInDocumentOrder = (sites: readonly CallSite[]): CallSite[] =>
  [...sites].sort((a, b) => a.call.start - b.call.start || a.fn.start - b.fn.start)

/** The widened frame of a function: every call of it, with the arguments evaluated in no frame (above). */
export function widenedFrame(fn: AstNode, calls: readonly CallSite[]): Frame {
  const bindings = sitesInDocumentOrder(calls).map((site) => ({ site, caller: undefined }))
  return { fn, bindings, id: `w${fn.start}`, depth: 1, how: 'widened' }
}

/** Frames of one function merged into one, whose parameters take the arguments of every one of their calls. */
export function mergedFrame(fn: AstNode, unordered: readonly Frame[]): Frame {
  const frames = framesInDocumentOrder(unordered)
  const bindings = frames.flatMap((frame) => frame.bindings)
  // The frames share a closure only when every one was created in the same frame.
  const [first, ...rest] = frames.map((frame) => frame.outer)
  const outer = rest.every((each) => each === first) ? first : undefined
  return {
    fn,
    bindings,
    id: mergedId(fn, frames),
    depth: Math.max(...frames.map((frame) => frame.depth)),
    how: 'merged',
    ...(outer === undefined ? {} : { outer }),
  }
}

/** The id of the frame merging `frames`: theirs in order, or a digest of them when they are too long to join (`frameId`). */
function mergedId(fn: AstNode, frames: readonly Frame[]): string {
  const head = `m${fn.start}(`
  let length = head.length + 1
  for (const frame of frames) length += frame.id.length + 1
  if (length <= maxFrameIdLength) return `${head}${frames.map((frame) => frame.id).join(',')})`
  const digest = createHash('sha256').update(head)
  for (const frame of frames) digest.update(frame.id).update(',')
  return `${head.slice(0, 32)}~${digest.digest('base64url').slice(0, 22)}`
}

/** Whether `fn` is instantiated in `frame` or a frame out from it. */
export function onChain(frame: Frame | undefined, fn: AstNode): boolean {
  const seen = new Set<Frame>()
  const pending: Frame[] = frame === undefined ? [] : [frame]
  while (pending.length > 0) {
    const next = pending.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    if (next.fn === fn) return true
    for (const { caller } of next.bindings) if (caller !== undefined) pending.push(caller)
    if (next.outer !== undefined) pending.push(next.outer)
  }
  return false
}

/**
 * The frame `frame` runs `code` in: `frame` itself or one it runs within (`outer`), out through loops and iteration
 * natives' callbacks. Undefined when none of them instantiates `code`.
 */
export function frameOf(frame: Frame | undefined, code: AstNode): Frame | undefined {
  for (let at = frame; at !== undefined; at = at.outer) if (at.fn === code) return at
  return undefined
}

/** The loop or call whose iterations the iteration cap cut, when `frame` is one of the iterations done, or runs in one. */
export function cutIn(frame: Frame | undefined): AstNode | undefined {
  const seen = new Set<Frame>()
  const pending: Frame[] = frame === undefined ? [] : [frame]
  while (pending.length > 0) {
    const next = pending.pop()!
    if (seen.has(next)) continue
    seen.add(next)
    if (next.cut !== undefined) return next.cut
    for (const { caller } of next.bindings) if (caller !== undefined) pending.push(caller)
    if (next.outer !== undefined) pending.push(next.outer)
  }
  return undefined
}

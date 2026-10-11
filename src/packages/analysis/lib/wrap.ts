// Wrap evidence (§5 Resolver capabilities 10, §8 Effect and mechanism): a replacement is a `wrap` when the new value is
// shown to call the original, the native function the target held before the write, and a `replace` otherwise. The
// effect is decided by rule, never marked uncertain.
//
// The evidence:
// - a factory that receives the original: a call whose callee is unresolved or a user function, with the
//   original among its arguments at any depth, whatever a resolved summary does with it. A catalog native counts only
//   where ECMA-262 makes its result call the argument: `Function.prototype.bind`, so a `.bind` rebind is a wrap
// - a `Proxy` over the original
// - a function or class that invokes the original by any ECMA-262 route: a direct call, `.call`, `.apply`,
//   `Reflect.apply`, `new`, `Reflect.construct`, `super()` of a class whose heritage is the original, or a call through
//   a bound copy, in its body, in closures it creates, or in a helper the summaries resolve
//
// The original is any read that reaches the target's native function (or, for a shadowing write, the inherited member
// it shadows) in the unmutated catalog, through the same window. A read made when the new value runs counts only when
// its path doesn't go through the object written, which then holds the new value: `EventTarget.prototype.
// addEventListener.call(this, …)` in a new `window.addEventListener` does, `window.fetch(…)` in a new `window.fetch`
// doesn't.
//
// A written value whose alternatives (`?:`, `||`, the definitions of a variable, the values the resolution gives)
// differ in wrap evidence gives one finding per effect.

import type { CatalogTarget, SerializedCatalog, Realm } from '../../../catalog.ts'
import { calleeExpression, walkTree, type AstNode } from './ast.ts'
import type { Definitions } from './definitions.ts'
import { windowOf, type GlobalResolution, type HeapValue, type Leaf, type Position, type Value } from './global-object.ts'
import { parameterArguments } from './parameter-arguments.ts'
import { memberName } from './keys.ts'
import type { Frame } from './summaries.ts'
import type { Source } from './writes.ts'

export interface WrapContext {
  resolution: GlobalResolution
  definitions: Definitions
  catalog: SerializedCatalog
  realm: Realm
  /** The realm's global holder, e.g. `Window`. */
  global: string
  /** Whether a callee is a catalog native: a native function or holder, or a catalog member read from one. */
  isCatalogNative(callee: AstNode, at: Position): boolean
}

/** The slot a write replaces: the object written, the native it held, and the window it belongs to. */
export interface Replaced {
  /** The native holder written, e.g. `Window`, `navigator`, `XMLHttpRequest.prototype`. */
  holder: string
  /** The catalog target whose native the slot held: the target, or the inherited member a shadowing write shadows. */
  original: string
  /** The leaves the holder written was reached from. */
  leaves: readonly Leaf[]
  /**
   * For a wildcard write, whose member the analyzer doesn't know (§5 Partially resolved writes), whether an expression
   * gives the original: a read of the same (holder, key) before the write, as the key reuse found it.
   */
  isOriginal?: (node: AstNode) => boolean
}

/** Functions and classes, whose bodies run when they are called. */
const functionTypes: ReadonlySet<string> = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassDeclaration',
  'ClassExpression',
])

/**
 * Wrap evidence over one program: for a write's value sources and the slot it replaces, whether each alternative of
 * the value carries wrap evidence, as the set of answers the alternatives give.
 */
export function wrapEvidence(context: WrapContext): (sources: readonly Source[], replaced: Replaced) => Set<boolean> {
  const { resolution, definitions } = context
  const holders = context.catalog.holders[context.realm]
  const targets = context.catalog.targets[context.realm]
  const target = (name: string): CatalogTarget | undefined => (Object.hasOwn(targets, name) ? targets[name] : undefined)

  /** The holders on a holder's chain in the unmutated catalog, from it. */
  const chainOf = (start: string): string[] => {
    const chain: string[] = []
    for (let at: string | null = start; at !== null; at = Object.hasOwn(holders, at) ? holders[at]!.proto : null) chain.push(at)
    return chain
  }

  /** The catalog target a native function value's name reads: the first on the chain of the holder it is read from. */
  const nativeTarget = (name: string): { holder: string; target: string } | undefined => {
    const dot = name.lastIndexOf('.')
    const holder = dot < 0 ? context.global : name.slice(0, dot)
    const key = dot < 0 ? name : name.slice(dot + 1)
    const found = chainOf(holder)
      .map((at) => memberName(at, key))
      .find((each) => target(each) !== undefined)
    return found === undefined ? undefined : { holder, target: found }
  }

  /** A position with no frame and no `typeof` guard, as a definition or function body is evaluated with no call. */
  const nowhere: Position = { guard: () => undefined, topLevel: false }
  const inFrame = (frame: Frame | undefined): Position => ({ guard: () => undefined, topLevel: false, frame })

  return (sources, replaced) => {
    const window = windowOf(replaced.leaves)
    const original = target(replaced.original)
    // The functions whose code runs when the alternative of the new value being read is called: a read in them is made
    // at call time. `alternative` empties it for each alternative.
    const running: AstNode[] = []
    const atCallTime = (site: AstNode) => running.some((fn) => site.start >= fn.start && site.end <= fn.end)
    /** Whether a read from `holder` at call time goes through the object written, which then holds the new value. */
    const throughWritten = (holder: string) => chainOf(holder).includes(replaced.holder)

    /** Whether a value is the original, read as the rule above counts it. */
    const isOriginal = (value: Value): boolean => {
      if (window === undefined || original === undefined) return false
      switch (value.kind) {
        case 'holder':
          // A constructor the target holds (`Window.XMLHttpRequest`): read at call time through the global object, it
          // is the new value.
          return (
            original.holds === value.holder &&
            windowOf(value.leaves) === window &&
            !value.leaves.some((leaf) => atCallTime(leaf.node))
          )
        case 'member':
          return (
            value.target === replaced.original &&
            windowOf(value.leaves) === window &&
            value.sites.some((site) => !atCallTime(site) || !throughWritten(value.holder))
          )
        case 'native': {
          const read = nativeTarget(value.name)
          if (read?.target !== replaced.original || windowOf(value.leaves) !== window) return false
          return (value.sites ?? []).some((site) => !atCallTime(site) || !throughWritten(read.holder))
        }
        default:
          return false
      }
    }

    /** The expressions an expression's value comes from, past parentheses, choices, sequences and assignments. */
    const branches = (node: AstNode): AstNode[] => {
      switch (node.type) {
        case 'ParenthesizedExpression':
        case 'ChainExpression':
        case 'TSAsExpression':
        case 'TSNonNullExpression':
          return branches(node['expression'] as AstNode)
        case 'ConditionalExpression':
          return [...branches(node['consequent'] as AstNode), ...branches(node['alternate'] as AstNode)]
        case 'LogicalExpression':
          return [...branches(node['left'] as AstNode), ...branches(node['right'] as AstNode)]
        case 'SequenceExpression':
          return branches((node['expressions'] as AstNode[]).at(-1)!)
        case 'AssignmentExpression':
          return node['operator'] === '=' ? branches(node['right'] as AstNode) : [node]
        default:
          return [node]
      }
    }

    /**
     * The sources of the definitions of a variable that reach `id`, when it is a variable the program defines, each with
     * the position it is evaluated at: the frame of `at`, when the definition is in that frame's function's own code
     * (`const original = source[name]` in a fill-style helper instantiated with its call's arguments), and otherwise no
     * frame.
     */
    const definitionSources = (id: AstNode, at: Position): { node: AstNode; at: Position }[] | undefined => {
      const key = definitions.keyOf(id)
      if (key === undefined) return undefined
      const reaching = definitions.reaching(id, key)
      const found = reaching.definitions.flatMap((definition) =>
        definition.pattern.type === 'Identifier' && definition.source !== undefined && !definition.logical
          ? [{ node: definition.source, at: framed(definition.owner, at) }]
          : [],
      )
      return found.length > 0 && found.length === reaching.definitions.length ? found : undefined
    }

    /** The position code owned by `owner` is evaluated at: in the frame of `at`, or one around it, that instantiates it. */
    const framed = (owner: AstNode, at: Position): Position => {
      for (let frame = at.frame; frame !== undefined; frame = frame.outer) if (frame.fn === owner) return inFrame(frame)
      return nowhere
    }

    /**
     * Whether an expression may be the original, or a bound copy of it. Definitions and bound copies are followed with
     * no depth cap, so the effect never depends on how far they go: `followed` holds the definition sources already
     * read, which only ends a cycle.
     */
    const reaches = (node: AstNode, at: Position, followed = new Set<AstNode>()): boolean => {
      if (replaced.isOriginal?.(node) === true) return true
      if (resolution.evaluate(node, at).some(isOriginal)) return true
      return branches(node).some((branch) => {
        if (branch.type === 'CallExpression') return boundCopy(branch, at, followed)
        if (branch.type !== 'Identifier') return false
        return (definitionSources(branch, at) ?? []).some((source) => {
          if (followed.has(source.node)) return false
          followed.add(source.node)
          return reaches(source.node, source.at, followed)
        })
      })
    }

    /** Whether a call makes a bound copy of the original: `o.bind(t)`, `Function.prototype.bind.call(o, t)`. */
    const boundCopy = (call: AstNode, at: Position, followed = new Set<AstNode>()): boolean => {
      const callee = calleeExpression(call['callee'] as AstNode)
      if (callee.type !== 'MemberExpression') return false
      const key = keyOf(callee)
      const object = callee['object'] as AstNode
      if (key === 'bind') return reaches(object, at, followed)
      if (key !== 'call' && key !== 'apply') return false
      const binds = resolution.evaluate(object, at).some((value) => value.kind === 'native' && value.name === 'Function.prototype.bind')
      const [first] = call['arguments'] as AstNode[]
      if (!binds || first === undefined) return false
      const fn = key === 'call' ? first : firstElement(first)
      return fn !== undefined && reaches(fn, at, followed)
    }

    /**
     * Whether the original is among a call's arguments at any depth: an argument, or a value in the objects and arrays
     * an argument holds. A function's code is no part of its value, so reads in it are not walked.
     */
    const passes = (call: AstNode, at: Position): boolean => {
      // The object and array literals already walked through a variable that holds them, which only ends a cycle.
      const walked = new Set<AstNode>()
      const holds = (value: AstNode, at: Position): boolean => {
        let found = false
        walkTree(value, {
          enter(node, parent) {
            if (found || functionTypes.has(node.type)) return false
            if (node.type !== 'Identifier' && node.type !== 'MemberExpression' && node.type !== 'ThisExpression') return
            // A property's name, and a literal's key, are no reads.
            if (parent?.type === 'MemberExpression' && parent['property'] === node && parent['computed'] !== true) return
            if (parent?.type === 'Property' && parent['key'] === node && parent['computed'] !== true && parent['shorthand'] !== true) return
            if (reaches(node, at) || (node.type === 'Identifier' && literalHolds(node, at))) found = true
            return found ? false : undefined
          },
        })
        return found
      }
      // A variable an argument reads holds the values of the object and array literals assigned to it, as a literal
      // written in the call does (`i = { f: original }; make(i)`).
      const literalHolds = (id: AstNode, at: Position): boolean =>
        (definitionSources(id, at) ?? []).some(({ node, at: where }) =>
          branches(node).some((branch) => {
            if (branch.type !== 'ObjectExpression' && branch.type !== 'ArrayExpression') return false
            if (walked.has(branch)) return false
            walked.add(branch)
            return holds(branch, where)
          }),
        )
      return (call['arguments'] as AstNode[]).some((arg) => holds(arg, at))
    }

    /** Whether a call or `new` in the new value's code invokes the original. */
    const invokes = (call: AstNode, at: Position, seen: Seen): boolean => {
      const callee = calleeExpression(call['callee'] as AstNode)
      const args = call['arguments'] as AstNode[]
      if (callee.type === 'Super') return false
      if (reaches(callee, at)) return true
      if (call.type === 'CallExpression' && callee.type === 'MemberExpression') {
        const key = keyOf(callee)
        if ((key === 'call' || key === 'apply') && reaches(callee['object'] as AstNode, at)) return true
      }
      const [first] = args
      const natives = resolution.evaluate(callee, at)
      const reflects = natives.some((value) => value.kind === 'native' && (value.name === 'Reflect.apply' || value.name === 'Reflect.construct'))
      if (reflects && first !== undefined && first.type !== 'SpreadElement' && reaches(first, at)) return true
      // A helper the summaries resolve: run with the frames its calls give it when it is passed the original, and
      // otherwise with no call, since only what it reads itself can be the original then. `seen` ends a cycle.
      const helpers = natives.filter(isCallable)
      if (helpers.length === 0) return false
      const framed = args.some((arg) => arg.type !== 'SpreadElement' && reaches(arg, at))
      return helpers.some((value) => calls(value.heap.node, value.heap.at.frame, seen, framed))
    }

    /**
     * Whether a function or class, or a bound function, calls the original when it runs. Its code is read in the frame
     * of its function object, made in `closure`, and each function nested in it in a frame made in the frame around it:
     * the closures it reads. The value itself, and a helper passed the original, are also read in the frames the
     * summaries give them (`framed`).
     */
    const calls = (fn: AstNode, closure: Frame | undefined, seen: Seen, framed = false): boolean => {
      // A function read with its frames covers a read without them, but not the other way round: a helper first reached
      // in a frame that doesn't pass it the original is read again when a later frame does.
      if (seen.get(fn) === 'framed' || (seen.has(fn) && !framed)) return false
      seen.set(fn, framed ? 'framed' : 'plain')
      if (fn.type === 'CallExpression') {
        // A bound function calls its target.
        const callee = calleeExpression(fn['callee'] as AstNode)
        if (callee.type !== 'MemberExpression') return false
        const target = callee['object'] as AstNode
        const at = inFrame(closure)
        if (reaches(target, at)) return true
        return resolution
          .evaluate(target, at)
          .some((value) => isCallable(value) && calls(value.heap.node, value.heap.at.frame, seen, framed))
      }
      if (!functionTypes.has(fn.type)) return false
      running.push(fn)
      const own = [resolution.closureFrame(fn, closure), ...(framed ? resolution.framesOf(fn, true) : [])]
      if (fn.type === 'ClassDeclaration' || fn.type === 'ClassExpression') {
        const heritage = fn['superClass'] as AstNode | null
        if (heritage != null && reaches(heritage, inFrame(closure)) && callsSuper(fn)) return true
      }
      let found = false
      // The functions the walk is in, innermost last, each with the frames its code is read in.
      const owners: { fn: AstNode; frames: Frame[] }[] = [{ fn, frames: own }]
      walkTree(fn, {
        enter(node) {
          if (found) return false
          if (node !== fn && functionTypes.has(node.type)) {
            running.push(node)
            while (!within(node, owners.at(-1)!.fn)) owners.pop()
            const outer = owners.at(-1)!.frames
            owners.push({ fn: node, frames: outer.map((frame) => resolution.closureFrame(node, frame)) })
          }
          if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return
          while (!within(node, owners.at(-1)!.fn)) owners.pop()
          found = owners.at(-1)!.frames.some((frame) => invokes(node, inFrame(frame), seen))
          return found ? false : undefined
        },
      })
      return found
    }

    /** Whether one alternative of the value carries wrap evidence. */
    const alternative = (node: AstNode, at: Position, followed: Set<AstNode>): boolean[] => {
      // Each alternative is its own new value: the code an earlier one runs doesn't run when this one is called.
      running.length = 0
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        const callee = calleeExpression(node['callee'] as AstNode)
        const args = node['arguments'] as AstNode[]
        const [first] = args
        // `new Proxy(original, handler)`.
        if (node.type === 'NewExpression' && first !== undefined && first.type !== 'SpreadElement') {
          const proxy = resolution.evaluate(callee, at).some((value) => value.kind === 'holder' && value.holder === 'Proxy')
          if (proxy && reaches(first, at)) return [true]
        }
        if (node.type === 'CallExpression' && boundCopy(node, at)) return [true]
        // A factory that receives the original, whatever a resolved summary returns. The spec names `new` apart from a
        // call, so a factory is a call.
        const factory = node.type === 'CallExpression' && callee.type !== 'Super' && !context.isCatalogNative(callee, at)
        if (factory && passes(node, at)) return [true]
      }
      if (node.type === 'Identifier') {
        const found = definitionSources(node, at)
        if (found !== undefined) {
          // A definition already followed (a cycle) adds no alternative of its own.
          const fresh = found.filter((source) => !followed.has(source.node))
          for (const source of fresh) followed.add(source.node)
          return fresh.flatMap((source) => branches(source.node).flatMap((each) => alternative(each, source.at, followed)))
        }
        // A helper's parameter holds what its calls pass. The values the resolution gives it are read first, since they
        // keep what the call's frame knows (a loop's key); the arguments add only what the values can't show: that every
        // one is a factory's result given the original, whatever the factory returns.
        const passed = parameterArguments(definitions, node, at)
        if (passed !== undefined) {
          const own = valueAnswers(node, at)
          if (own.every(Boolean)) return own
          const fresh = passed.filter((source) => !followed.has(source.node))
          for (const source of fresh) followed.add(source.node)
          const answers = fresh.flatMap((source) => branches(source.node).flatMap((each) => alternative(each, source.at, followed)))
          return answers.length > 0 && answers.every(Boolean) ? [true] : own
        }
      }
      return valueAnswers(node, at)
    }

    /** Whether each value the resolution gives an expression carries wrap evidence. */
    const valueAnswers = (node: AstNode, at: Position): boolean[] => {
      const values = resolution.evaluate(node, at)
      if (values.length === 0) return [false]
      // The value's own function objects are also those its frames give it: an instance's method, a closure made in a
      // frame of the function around it, whether or not the write was instantiated in that frame.
      return values.map((value) => {
        running.length = 0
        return isCallable(value) && calls(value.heap.node, value.heap.at.frame, new Map(), true)
      })
    }

    const answers = new Set<boolean>()
    for (const { node, at } of sources) {
      for (const branch of branches(node)) for (const answer of alternative(branch, at, new Set())) answers.add(answer)
    }
    return answers
  }
}

/** The functions a walk has read, and whether with the frames the summaries give them. */
type Seen = Map<AstNode, 'plain' | 'framed'>

/** Whether a value is a function the code makes: a function or class, or a bound function. */
const isCallable = (value: Value): value is HeapValue =>
  value.kind === 'object' && value.heap !== undefined && (value.heap.kind === 'function' || value.heap.kind === 'bound')

/** Whether a derived class calls `super()`: its constructor does, or it has none, and the default one does. */
function callsSuper(cls: AstNode): boolean {
  const body = (cls['body'] as AstNode)['body'] as AstNode[]
  const ctor = body.find((member) => member.type === 'MethodDefinition' && member['kind'] === 'constructor')
  if (ctor === undefined) return true
  let found = false
  walkTree(ctor, {
    enter(node) {
      if (found) return false
      if (node.type === 'CallExpression' && (node['callee'] as AstNode).type === 'Super') found = true
    },
  })
  return found
}

/** Whether `node` lies within `outer`. */
const within = (node: AstNode, outer: AstNode): boolean => node.start >= outer.start && node.end <= outer.end

/** The name a member expression reads, when it is a plain name or a string. */
function keyOf(member: AstNode): string | undefined {
  const property = member['property'] as AstNode
  if (member['computed'] !== true) return property.type === 'Identifier' ? (property['name'] as string) : undefined
  return property.type === 'Literal' && typeof property['value'] === 'string' ? (property['value'] as string) : undefined
}

/** The first element of an array literal, as `.apply` passes it. */
function firstElement(list: AstNode): AstNode | undefined {
  if (list.type !== 'ArrayExpression') return undefined
  const [first] = list['elements'] as (AstNode | null)[]
  return first === null || first === undefined || first.type === 'SpreadElement' ? undefined : first
}

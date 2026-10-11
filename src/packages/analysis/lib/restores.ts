// Restores (§3 Restores): a write that puts back the unmutated native of the same written object and member. It is
// proven when, on every path, the value written is that native, however it travelled: locals, parameters, closures or
// heap fields. A define's descriptor is the native when it is `getOwnPropertyDescriptor` of the slot, or of the holder
// the catalog resolves it from, or a fresh literal carrying the saved native as `value`. A union containing
// any non-native value is not proven, except that a guard on the restore that tests the saved value narrows it:
// `if (orig)`, `if (orig != null)` and `typeof orig === 'function'` remove the nullish or non-function alternatives.
// Guards never make a proof fail.
//
// §3's dead-fallback rule is for a `||`/`??` after a `getOwnPropertyDescriptor` read of a member the catalog defines
// directly on the holder read. A fallback after a value read is a live alternative: `window.fetch = window.fetch || p`
// stays the polyfill §7 judges.
//
// Only this window's slots are restored: the same member of another window expression may be another window's by the
// time the restore runs (§3 Undecidable outcomes).
//
// A proven restore is never a finding or an occurrence: it leaves a `restore` step on the install occurrence in its
// chain, or nothing when there is none. An unproven restore whose chain has an install occurrence of the same target
// joins that install's finding, taking its effect. An install sets a value (`replace`, `wrap`,
// `descriptor-change`); a `delete` never is one. The chain is the instantiated call chain the
// native was read in: an install is in it when its write and the native read are in the same function, or one's
// function is reached from the other's along resolved calls, or, for a function no resolved call reaches, from where it
// was created (§7).

import type { CatalogTarget, Realm, SerializedCatalog } from '../../../catalog.ts'
import type { AstNode } from './ast.ts'
import type { Definitions } from './definitions.ts'
import {
  isHeap,
  sameWindow,
  windowOf,
  type Allocation,
  type GlobalResolution,
  type Leaf,
  type Position,
  type Value,
} from './global-object.ts'
import { parameterArguments } from './parameter-arguments.ts'
import { memberName, toPropertyKey } from './keys.ts'
import type { Frame } from './summaries.ts'
import type { Write } from './writes.ts'

export interface RestoreContext {
  resolution: GlobalResolution
  definitions: Definitions
  catalog: SerializedCatalog
  realm: Realm
  /** The realm's global holder, e.g. `Window`. */
  global: string
  /** The source text, to compare a guard's operand with the slot the restore writes. */
  text: string
}

/**
 * A write that puts back the native of its slot on some path. `proven` says it does on every path. `reads` are the
 * native reads its value came from, which locate its chain. `guard` and `leavesOwnShadow` are its `restore` step's.
 */
export interface Restore {
  proven: boolean
  reads: AstNode[]
  guard: 'identity' | 'none'
  leavesOwnShadow: boolean
}

/** The slot a restore writes: the holder written, its target, and the inherited member a shadowing write shadows. */
export interface RestoredSlot {
  name: string
  shadows?: string | undefined
}

/**
 * One alternative of a written value or descriptor: the native of the slot, with the reads that give it, or any other
 * value. `defined` marks a `getOwnPropertyDescriptor` of a member the unmutated catalog defines directly on the holder
 * read, which is always an object, so a `||`/`??` fallback after it is dead code (§3 Restores).
 */
type Alternative = ({ native: true; reads: AstNode[] } | { native: false; value: Value }) & { defined?: true }

/** The native functions that read a property descriptor. */
const descriptorReaders: ReadonlySet<string> = new Set(['Object.getOwnPropertyDescriptor', 'Reflect.getOwnPropertyDescriptor'])

/** The attributes of a data descriptor. */
const attributes: ReadonlySet<string> = new Set(['writable', 'enumerable', 'configurable'])

/** How a guard on the restore narrows the saved value. */
type Narrowing = 'truthy' | 'non-null' | 'non-undefined' | 'non-nullish' | 'function'

const functionTypes: ReadonlySet<string> = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
  'ClassDeclaration',
  'ClassExpression',
])

/**
 * Judges restores over one program: for a write of a value and the slot it writes, the restore it is, or undefined when
 * no alternative of its value is the slot's native. `ancestors` are the nodes the write is in, outermost first.
 */
export function restoreJudge(
  context: RestoreContext,
): (write: Write, frame: Frame | undefined, slot: RestoredSlot, ancestors: readonly AstNode[]) => Restore | undefined {
  const { resolution, definitions } = context
  const holders = context.catalog.holders[context.realm]
  const targets = context.catalog.targets[context.realm]
  const target = (name: string): CatalogTarget | undefined => (Object.hasOwn(targets, name) ? targets[name] : undefined)
  const chainOf = (start: string): string[] => {
    const chain: string[] = []
    for (let at: string | null = start; at !== null; at = Object.hasOwn(holders, at) ? holders[at]!.proto : null) chain.push(at)
    return chain
  }
  /** The catalog target a native function value's name reads: the first on the chain of the holder it is read from. */
  const nativeTarget = (name: string): string | undefined => {
    const dot = name.lastIndexOf('.')
    const holder = dot < 0 ? context.global : name.slice(0, dot)
    const key = dot < 0 ? name : name.slice(dot + 1)
    return chainOf(holder)
      .map((at) => memberName(at, key))
      .find((each) => target(each) !== undefined)
  }
  const nowhere: Position = { guard: () => undefined, topLevel: false }
  const inFrame = (frame: Frame): Position => ({ guard: () => undefined, topLevel: false, frame })
  /** The position code owned by `owner` is evaluated at: in the frame of `at`, or one around it, that instantiates it. */
  const framed = (owner: AstNode, at: Position): Position => {
    for (let frame = at.frame; frame !== undefined; frame = frame.outer) if (frame.fn === owner) return inFrame(frame)
    return nowhere
  }

  return (write, frame, slot, ancestors) => {
    const { change } = write
    const source =
      change.kind === 'set'
        ? change.same || change.sources?.length !== 1
          ? undefined
          : change.sources[0]
        : change.kind === 'define'
          ? change.source
          : undefined
    if (source === undefined) return undefined
    // A define of the slot's own value, read where it is written, writes back what is there (§3): no restore.
    if (change.kind === 'define' && change.descriptor.value?.same === true && change.descriptor.value.throughHeap !== true) {
      return undefined
    }
    const original = slot.shadows ?? slot.name
    const window = windowOf(write.leaves)
    if (window === undefined || target(original) === undefined) return undefined

    /**
     * The reads that give a value when it is the slot's native, read through the same window, or undefined. A holder
     * value (`window.XMLHttpRequest`) doesn't say which slot it was read from, and a value the catalog knows is the same
     * isn't a read of the same slot (§3: `window.URL = window.URL || window.webkitURL`), so it is never the native.
     */
    const nativeReads = (value: Value): AstNode[] | undefined => {
      // The write itself has effects, so only this window is shown the same around it.
      switch (value.kind) {
        case 'member':
          return value.target === original && same(value.leaves) ? value.sites : undefined
        case 'native':
          return nativeTarget(value.name) === original && same(value.leaves) ? (value.sites ?? []) : undefined
        default:
          return undefined
      }
    }

    /** The definitions that reach a read of a variable, each where it is evaluated, when every one has a source. */
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

    /** The alternatives of an expression's value. `followed` ends a cycle of definitions. */
    const alternatives = (node: AstNode, at: Position, followed: Set<AstNode>): Alternative[] => {
      switch (node.type) {
        case 'ParenthesizedExpression':
        case 'ChainExpression':
        case 'TSAsExpression':
        case 'TSNonNullExpression':
          return alternatives(node['expression'] as AstNode, at, followed)
        case 'ConditionalExpression':
          return [
            ...alternatives(node['consequent'] as AstNode, at, followed),
            ...alternatives(node['alternate'] as AstNode, at, followed),
          ]
        case 'LogicalExpression':
          return [
            ...alternatives(node['left'] as AstNode, at, followed),
            ...alternatives(node['right'] as AstNode, at, followed),
          ]
        case 'SequenceExpression':
          return alternatives((node['expressions'] as AstNode[]).at(-1)!, at, followed)
        case 'AssignmentExpression':
          if (node['operator'] === '=') return alternatives(node['right'] as AstNode, at, followed)
          break
        case 'Identifier': {
          const found = definitionSources(node, at)
          if (found !== undefined) {
            const fresh = found.filter((each) => !followed.has(each.node))
            for (const each of fresh) followed.add(each.node)
            return fresh.flatMap((each) => alternatives(each.node, each.at, followed))
          }
          // A helper's parameter holds what its calls pass. Its values are read first; the arguments are read when they
          // show a native the values can't: a holder value doesn't say the slot it was read from (`wa(t, e, n, s)` after
          // `n = t[e]`), and the read in the caller does.
          const own = evaluated(node, at)
          if (own.every((each) => each.native)) return own
          const passed = parameterArguments(definitions, node, at)
          if (passed === undefined) return own
          const fresh = passed.filter((each) => !followed.has(each.node))
          for (const each of fresh) followed.add(each.node)
          const viaArguments = fresh.flatMap((each) => alternatives(each.node, each.at, followed))
          return viaArguments.some((each) => each.native) ? viaArguments : own
        }
      }
      return evaluated(node, at)
    }

    const evaluated = (node: AstNode, at: Position): Alternative[] => {
      const values = resolution.evaluate(node, at)
      if (values.length === 0) return [{ native: false, value: { kind: 'unknown' } }]
      return values.map((value) => {
        const reads = value.kind === 'holder' ? slotReads(node, at, value) : nativeReads(value)
        return reads === undefined ? { native: false, value } : { native: true, reads }
      })
    }

    /**
     * The read that gives a constructor or other holder value when it reads the slot itself, through the same window: a
     * bare global name, or a member read whose object and key the resolution decides (`t[e]` with `t` the global object
     * and `e` "WebSocket", `n.prototype.constructor`). A holder value doesn't say which slot it was read from, so the
     * read's own syntax must: one the catalog knows holds the same object is another slot (§3, `window.webkitURL`).
     */
    const slotReads = (node: AstNode, at: Position, value: Extract<Value, { kind: 'holder' }>): AstNode[] | undefined => {
      if (target(original)?.holds !== value.holder || !same(value.leaves)) return undefined
      if (node.type === 'Identifier') {
        const named = value.leaves.length === 1 && value.leaves[0]!.node === node && value.leaves[0]!.form === 'global-property'
        return named && nativeTarget(node['name'] as string) === original ? [node] : undefined
      }
      if (node.type !== 'MemberExpression') return undefined
      const property = node['property'] as AstNode
      const keys =
        node['computed'] === true
          ? resolution.evaluate(property, at)
          : property.type === 'Identifier'
            ? [{ kind: 'constant' as const, value: property['name'] as string }]
            : []
      // Only a holder the object may be gives a holder value: an unknown alternative of it gives values of its own.
      const objects = resolution.evaluate(node['object'] as AstNode, at).filter((object) => object.kind === 'holder')
      if (keys.length === 0 || objects.length === 0) return undefined
      const reads = objects.every(
        (object) =>
          keys.every(
            (key) =>
              key.kind === 'constant' &&
              typeof key.value !== 'object' &&
              chainOf(object.holder)
                .map((each) => memberName(each, toPropertyKey(key.value)))
                .find((each) => target(each) !== undefined) === original,
          ),
      )
      return reads ? [node] : undefined
    }

    // The same window as the write's, with nothing in the write that could change which window that is.
    const same = (leaves: readonly Leaf[]) => sameWindow(leaves, write.leaves, [write.site])
    const unknownValue: Alternative = { native: false, value: { kind: 'unknown' } }

    /**
     * The alternatives of a descriptor (§3 Restores): `getOwnPropertyDescriptor` of the slot, or of the holder the
     * unmutated catalog resolves the member from along the written object's chain, with no field written to it; or a
     * fresh literal whose `value` is the slot's native, whose decided attributes equal the unmutated catalog's, or any
     * attributes on an own shadow. They are followed through locals, parameters, closures and heap fields.
     */
    const descriptors = (node: AstNode, at: Position, followed: Set<AstNode>): Alternative[] => {
      switch (node.type) {
        case 'ParenthesizedExpression':
        case 'TSAsExpression':
        case 'TSNonNullExpression':
          return descriptors(node['expression'] as AstNode, at, followed)
        case 'ConditionalExpression':
          return [
            ...descriptors(node['consequent'] as AstNode, at, followed),
            ...descriptors(node['alternate'] as AstNode, at, followed),
          ]
        case 'LogicalExpression': {
          const left = descriptors(node['left'] as AstNode, at, followed)
          // A fallback after a descriptor read the catalog always defines is dead code.
          const dead = node['operator'] !== '&&' && left.length > 0 && left.every((each) => each.defined === true)
          return dead ? left : [...left, ...descriptors(node['right'] as AstNode, at, followed)]
        }
        case 'SequenceExpression':
          return descriptors((node['expressions'] as AstNode[]).at(-1)!, at, followed)
        case 'AssignmentExpression':
          if (node['operator'] === '=') return descriptors(node['right'] as AstNode, at, followed)
          break
        case 'Identifier': {
          const found = definitionSources(node, at)
          if (found !== undefined) return followedTo(found, followed, descriptors)
          break
        }
        case 'MemberExpression': {
          const found = resolution.fieldSources(node, at)
          if (found !== undefined && found.length > 0) {
            return followedTo(found.map((each) => ({ node: each.node, at: each.at })), followed, descriptors)
          }
          break
        }
      }
      const values = resolution.evaluate(node, at)
      if (values.length === 0) return [unknownValue]
      return values.map((value): Alternative => {
        if (!isHeap(value)) return { native: false, value }
        if (value.heap.kind === 'returned') return described(value.heap) ?? { native: false, value }
        if (value.heap.kind !== 'literal') return { native: false, value }
        const reads = literalReads(value.heap)
        return reads === undefined ? { native: false, value } : { native: true, reads }
      })
    }
    /** Follows each expression a definition or field write gives, once. */
    const followedTo = (
      found: readonly { node: AstNode; at: Position }[],
      followed: Set<AstNode>,
      next: (node: AstNode, at: Position, followed: Set<AstNode>) => Alternative[],
    ): Alternative[] => {
      const fresh = found.filter((each) => !followed.has(each.node))
      for (const each of fresh) followed.add(each.node)
      return fresh.flatMap((each) => next(each.node, each.at, followed))
    }
    /** A `getOwnPropertyDescriptor` result as an alternative, or undefined when it is no such call. */
    const described = (heap: Allocation): Alternative | undefined => {
      const call = heap.node
      if (call.type !== 'CallExpression') return undefined
      const callees = resolution.evaluate(call['callee'] as AstNode, heap.at)
      if (callees.length === 0 || !callees.every((each) => each.kind === 'native' && descriptorReaders.has(each.name))) {
        return undefined
      }
      const [object, key] = call['arguments'] as AstNode[]
      if (object === undefined || key === undefined || object.type === 'SpreadElement' || key.type === 'SpreadElement') return undefined
      const holders = resolution.evaluate(object, heap.at)
      const keys = resolution.evaluate(key, heap.at)
      const [holder] = holders
      const [only] = keys
      if (holders.length !== 1 || holder?.kind !== 'holder' || keys.length !== 1 || only?.kind !== 'constant') return undefined
      const name = memberName(holder.holder, toPropertyKey(only.value))
      const defined = target(name) !== undefined ? { defined: true as const } : {}
      // A field written to the result makes it another descriptor than the native's.
      const unmodified = resolution.objectParts(call, heap.at)?.every(({ parts }) => parts.every((part) => part.kind === 'unseen'))
      const native = name === original && same(holder.leaves) && unmodified === true
      return native ? { native: true, reads: [call], ...defined } : { native: false, value: { kind: 'object', heap }, ...defined }
    }
    /** The fields of a fresh literal, the last of each key, when every part of it is seen; undefined otherwise. */
    const fieldsOf = (heap: Allocation) => {
      const objects = resolution.objectParts(heap.node, heap.at)
      if (objects?.length !== 1) return undefined
      const fields = new Map<string, Extract<(typeof objects)[number]['parts'][number], { kind: 'field' }>>()
      for (const part of objects[0]!.parts) {
        if (part.kind !== 'field' || part.maybe !== undefined) return undefined
        if (typeof part.key === 'string') fields.set(part.key, part)
      }
      return fields
    }
    /**
     * The reads of the slot's native that a fresh literal carries as `value`, when its attributes are ones a restore may
     * give; undefined when it is no such literal.
     */
    const literalReads = (heap: Allocation): AstNode[] | undefined => {
      const fields = fieldsOf(heap)
      const value = fields?.get('value')
      if (fields === undefined || value === undefined || value.accessor !== undefined || value.sources.length === 0) return undefined
      if (fields.has('get') || fields.has('set')) return undefined
      const natives = value.sources.flatMap((each) => alternatives(each.node, each.at, new Set()))
      if (natives.length === 0 || natives.some((each) => !each.native)) return undefined
      const reads = natives.flatMap((each) => (each.native ? each.reads : []))
      // On an own shadow the install created, any attributes; otherwise none the analyzer decides may differ.
      if (slot.shadows !== undefined) return reads
      const catalogDescriptor = target(original)!.descriptor
      if (catalogDescriptor.type !== 'data') return undefined
      const kept = [...fields].every(([key, part]) => {
        if (!attributes.has(key)) return true
        if (part.accessor !== undefined || part.values.length === 0) return true
        const truthy = part.values.map((each) => (each.kind === 'constant' && each.tested !== true ? Boolean(each.value) : undefined))
        if (truthy.some((each) => each === undefined) || new Set(truthy).size !== 1) return true
        return truthy[0] === catalogDescriptor[key as 'writable' | 'enumerable' | 'configurable']
      })
      return kept ? reads : undefined
    }

    const found = change.kind === 'define' ? descriptors(source.node, source.at, new Set()) : alternatives(source.node, source.at, new Set())
    const natives = found.flatMap((each) => (each.native ? [each.reads] : []))
    if (natives.length === 0) return undefined

    // The guards on the restore, between it and the start of its function.
    const tests: AstNode[] = []
    for (let index = ancestors.length - 1; index > 0; index--) {
      const child = ancestors[index]!
      const parent = ancestors[index - 1]!
      if (functionTypes.has(child.type)) break
      if (parent.type === 'IfStatement' && parent['consequent'] === child) tests.push(parent['test'] as AstNode)
      else if (parent.type === 'ConditionalExpression' && parent['consequent'] === child) tests.push(parent['test'] as AstNode)
      else if (parent.type === 'LogicalExpression' && parent['operator'] === '&&' && parent['right'] === child) {
        tests.push(parent['left'] as AstNode)
      }
    }
    const conjuncts = tests.flatMap(conjunctsOf)
    const value = unwrapped(source.node)
    const narrowings = value.type === 'Identifier' ? conjuncts.flatMap((test) => narrowingOf(test, value, definitions)) : []
    const others = found.filter((each) => !each.native && !narrowings.some((narrowing) => removes(narrowing, each.value)))

    // An identity guard compares what the slot holds now with a value that isn't its native.
    const written = write.site.type === 'AssignmentExpression' ? (write.site['left'] as AstNode) : undefined
    const atWrite: Position = { guard: () => undefined, topLevel: false, frame }
    const slotRead = (side: AstNode): boolean =>
      (written !== undefined && squeezed(context.text, side) === squeezed(context.text, written)) ||
      (resolution.evaluate(side, atWrite).length > 0 &&
        resolution.evaluate(side, atWrite).every((each) => nativeReads(each) !== undefined))
    const identity = conjuncts.some((test) => {
      if (test.type !== 'BinaryExpression' || (test['operator'] !== '===' && test['operator'] !== '==')) return false
      const left = test['left'] as AstNode
      const right = test['right'] as AstNode
      return (slotRead(left) && !slotRead(right)) || (slotRead(right) && !slotRead(left))
    })

    return {
      proven: others.length === 0,
      reads: natives.flat(),
      guard: identity ? 'identity' : 'none',
      leavesOwnShadow: slot.shadows !== undefined,
    }
  }
}

/** An expression past parentheses and type assertions. */
function unwrapped(node: AstNode): AstNode {
  let at = node
  while (at.type === 'ParenthesizedExpression' || at.type === 'TSAsExpression' || at.type === 'TSNonNullExpression') {
    at = at['expression'] as AstNode
  }
  return at
}

/** The tests an `&&` chain makes, each of which holds when the chain does. */
function conjunctsOf(test: AstNode): AstNode[] {
  const node = unwrapped(test)
  if (node.type === 'LogicalExpression' && node['operator'] === '&&') {
    return [...conjunctsOf(node['left'] as AstNode), ...conjunctsOf(node['right'] as AstNode)]
  }
  return [node]
}

/** How a test narrows the variable `id` reads: `id`, `id != null`, `id !== undefined`, `typeof id === 'function'`. */
function narrowingOf(test: AstNode, id: AstNode, definitions: Definitions): Narrowing[] {
  const key = definitions.keyOf(id)
  const isId = (node: AstNode): boolean => {
    const each = unwrapped(node)
    return (
      each.type === 'Identifier' &&
      each['name'] === id['name'] &&
      definitions.keyOf(each)?.scope === key?.scope
    )
  }
  if (isId(test)) return ['truthy']
  if (test.type !== 'BinaryExpression') return []
  const operator = test['operator'] as string
  const left = unwrapped(test['left'] as AstNode)
  const right = unwrapped(test['right'] as AstNode)
  if (operator === '===' || operator === '==') {
    const typeofId = (node: AstNode) => node.type === 'UnaryExpression' && node['operator'] === 'typeof' && isId(node['argument'] as AstNode)
    const fn = (node: AstNode) => node.type === 'Literal' && node['value'] === 'function'
    return (typeofId(left) && fn(right)) || (typeofId(right) && fn(left)) ? ['function'] : []
  }
  if (operator !== '!==' && operator !== '!=') return []
  const other = isId(left) ? right : isId(right) ? left : undefined
  if (other === undefined) return []
  const isNull = other.type === 'Literal' && other['value'] === null && other['regex'] === undefined
  const isUndefined =
    (other.type === 'Identifier' && other['name'] === 'undefined') ||
    (other.type === 'UnaryExpression' && other['operator'] === 'void')
  if (operator === '!=') return isNull || isUndefined ? ['non-nullish'] : []
  return isNull ? ['non-null'] : isUndefined ? ['non-undefined'] : []
}

/** Whether a narrowing removes a value from the saved variable's alternatives. */
function removes(narrowing: Narrowing, value: Value): boolean {
  switch (narrowing) {
    case 'truthy':
      return value.kind === 'constant' && !value.value
    case 'non-nullish':
      return value.kind === 'constant' && value.value == null
    case 'non-null':
      return value.kind === 'constant' && value.value === null
    case 'non-undefined':
      return value.kind === 'constant' && value.value === undefined
    case 'function':
      return (
        value.kind === 'constant' ||
        (value.kind === 'object' && value.heap !== undefined && value.heap.kind !== 'function' && value.heap.kind !== 'bound')
      )
  }
}

/** An expression's source text with no whitespace, to compare two spellings of one slot. */
function squeezed(text: string, node: AstNode): string {
  return text.slice(node.start, node.end).replace(/\s+/g, '')
}

/**
 * Whether two code positions are in one instantiated call chain (§3 Restores): their functions (undefined at the top
 * level) are the same, or one is reached from the other along resolved calls, or, for a function no resolved call
 * reaches, from where it was created.
 */
export function sameChain(
  a: AstNode | undefined,
  b: AstNode | undefined,
  outward: (fn: AstNode) => (AstNode | undefined)[],
): boolean {
  const reach = (from: AstNode | undefined): Set<AstNode | undefined> => {
    const seen = new Set<AstNode | undefined>([from])
    const queue = [from]
    while (queue.length > 0) {
      const fn = queue.pop()
      if (fn === undefined) continue
      for (const next of outward(fn)) {
        if (seen.has(next)) continue
        seen.add(next)
        queue.push(next)
      }
    }
    return seen
  }
  return reach(a).has(b) || reach(b).has(a)
}

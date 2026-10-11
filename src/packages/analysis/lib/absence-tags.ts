// Absence tags on values (§5 Resolver capabilities 7, §7): a holder or value chosen on a branch where a native is
// absent keeps `guarded-native-absence` wherever it is later written, whether it travelled through variables,
// parameters or heap fields. The absence of any native counts, not only the target's.
//
// A write's holder and its written value are followed back, through the same routes the resolver evaluates them by, to
// the expressions they are chosen from: the arms of `?:`, `||`, `&&` and `??`, the reaching definitions of a variable,
// the arguments a parameter takes at each resolved call, and the expressions a heap field is given. Each expression on a
// route is judged as a write there would be (§7: the guards between it and its install entry), and a route is tagged
// when the guards along it, together, give `guarded-native-absence`. The alternatives that give the write combine by the
// OR rule: the write keeps the tag only when every one of them is tagged.

import type { CatalogTarget, Realm, SerializedCatalog } from '../../../catalog.ts'
import { calleeExpression, type AstNode } from './ast.ts'
import type { Definitions } from './definitions.ts'
import { truthiness, windowOf, type GlobalResolution, type Leaf, type Position, type Value } from './global-object.ts'
import { memberName } from './keys.ts'
import { along, type Judged, type Judgement } from './reachability.ts'
import { frameOf, isFunction, type Binding, type Frame } from './summaries.ts'
import type { Replaced } from './wrap.ts'
import type { Source, Write } from './writes.ts'
import type { Effect, GuardStep } from './types.ts'

export interface TagContext {
  resolution: GlobalResolution
  definitions: Definitions
  catalog: SerializedCatalog
  realm: Realm
  /** The realm's global holder, e.g. `Window`. */
  global: string
  /** The function whose own code holds a node, if any. */
  functionOf(node: AstNode): AstNode | undefined
  /** The judgement of a write at `site` reached at `at`, along its call chain to its install entry (§7). */
  judge(site: AstNode, at: Position, target: Judged['target']): Judgement
  /** Wrap evidence (§5 Resolver capabilities 10): whether each alternative of a value calls the original. */
  evidence(sources: readonly Source[], replaced: Replaced): Set<boolean>
}

/** The outcome a write gives: its target, and the effect the alternatives of its value must give to count. */
export interface Tagged {
  name: string
  holder: string
  shadows?: string | undefined
  effect: Effect
}

/** An expression a holder or value is chosen from, where it is evaluated, and the expressions on the route to it. */
interface Alternative {
  node: AstNode
  at: Position
  hops: readonly { node: AstNode; at: Position; site: AstNode }[]
  /** The start value of a variable whose definitions don't all reach the read: `undefined`, which is no native. */
  start?: true
  /** Whether the route went from a member read to its object: the alternative is what the holder is read from. */
  descended?: true
}

const absent = 'guarded-native-absence'

/**
 * The absence tags of writes over one program: for a write, the outcome it gives and where it is, the `guard` steps of
 * the absence tests that tag it, or undefined when it keeps no tag.
 */
export function absenceTags(context: TagContext): (write: Write, outcome: Tagged, at: Position) => GuardStep[] | undefined {
  const { resolution, definitions } = context
  const targets = context.catalog.targets[context.realm]
  const target = (name: string): CatalogTarget | undefined => (Object.hasOwn(targets, name) ? targets[name] : undefined)

  /** The position code owned by `owner` is evaluated at: in the frame of `at`, or one around it, that instantiates it. */
  const framed = (owner: AstNode, at: Position): Position => {
    for (let frame = at.frame; frame !== undefined; frame = frame.outer) {
      if (frame.fn === owner) return { guard: () => undefined, topLevel: false, frame }
    }
    return { guard: () => undefined, topLevel: false }
  }

  /** Where a call is: its `typeof` guards, whether it is top-level, and its caller's frame. */
  const positionOf = ({ site, caller }: Binding): Position => ({
    guard: (name) => site.guards.get(name),
    topLevel: site.topLevel,
    frame: caller,
  })

  /** The resolved calls a function's parameters take their arguments from: its frame's, or every resolved call of it. */
  const bindingsOf = (fn: AstNode, frame: Frame | undefined): readonly Binding[] => {
    const own = frameOf(frame, fn)
    if (own === undefined) return resolution.callersOf(fn)
    return own.how === 'creation' ? [] : own.bindings
  }

  /** The index of the parameter an identifier reads, when it is a plain parameter of the function it is in. */
  const parameterOf = (id: AstNode): { fn: AstNode; index: number } | undefined => {
    const fn = context.functionOf(id)
    if (fn === undefined || !isFunction(fn)) return undefined
    const key = definitions.keyOf(id)
    if (key === undefined || definitions.of(key).length > 0) return undefined
    const index = (fn['params'] as AstNode[]).findIndex((param) => param.type === 'Identifier' && param['name'] === id['name'])
    return index < 0 ? undefined : { fn, index }
  }

  /**
   * The expressions a holder or value is chosen from. `object` follows a member read's object when the heap doesn't
   * give the read and the object is a native, as a holder written through a chain (`h.prototype`) is chosen where `h`
   * is. `followed` ends a cycle.
   */
  const alternatives = (
    node: AstNode,
    at: Position,
    hops: Alternative['hops'],
    object: boolean,
    followed: Set<string>,
  ): Alternative[] => {
    const seen = `${node.start}:${node.end}@${at.frame?.id ?? ''}`
    if (followed.has(seen)) return []
    followed.add(seen)
    const route = [...hops, { node, at, site: node }]
    switch (node.type) {
      case 'ParenthesizedExpression':
      case 'ChainExpression':
      case 'TSAsExpression':
      case 'TSNonNullExpression':
        return alternatives(node['expression'] as AstNode, at, hops, object, followed)
      case 'ConditionalExpression':
        return [
          ...alternatives(node['consequent'] as AstNode, at, hops, object, followed),
          ...alternatives(node['alternate'] as AstNode, at, hops, object, followed),
        ]
      case 'LogicalExpression': {
        // A literal left side that can't be the result (a falsy one of `||`, a truthy one of `&&`, a nullish one of
        // `??`) is no alternative: the right side's value is.
        const operator = node['operator'] as string
        const kept = (alternative: Alternative): boolean => {
          if (alternative.start === true) return operator === '&&'
          if (!literal(alternative.node)) return true
          const values = resolution.evaluate(alternative.node, alternative.at)
          if (operator === '??') {
            return !values.every((value) => value.kind === 'constant' && (value.value === null || value.value === undefined))
          }
          const truthy = values.length === 0 ? undefined : truthiness(values)
          return truthy === undefined || truthy === (operator === '||')
        }
        return [
          ...alternatives(node['left'] as AstNode, at, hops, object, followed).filter(kept),
          ...alternatives(node['right'] as AstNode, at, hops, object, followed),
        ]
      }
      case 'SequenceExpression':
        return alternatives((node['expressions'] as AstNode[]).at(-1)!, at, hops, object, followed)
      case 'AssignmentExpression':
        if (node['operator'] !== '=') break
        return alternatives(node['right'] as AstNode, at, hops, object, followed)
      case 'Identifier': {
        const parameter = parameterOf(node)
        if (parameter !== undefined) {
          const bindings = bindingsOf(parameter.fn, at.frame)
          if (bindings.length === 0) break
          return bindings.flatMap((binding) => {
            // An iteration native's callback is passed the element it visits (§5 Resolver capabilities 4).
            if (binding.element !== undefined) {
              const given = resolution.givenSource(binding, parameter.index)
              if (given === undefined) return [{ node, at, hops: route }]
              return alternatives(given.node, given.at, route, object, followed)
            }
            const argument = binding.site.args[parameter.index]
            const listed = binding.site.unlisted === undefined || parameter.index < binding.site.unlisted
            if (argument === undefined || argument.type === 'SpreadElement' || !listed) return [{ node, at, hops: route }]
            return alternatives(argument, positionOf(binding), route, object, followed)
          })
        }
        const key = definitions.keyOf(node)
        if (key === undefined) break
        const reaching = definitions.reaching(node, key)
        if (reaching.definitions.length === 0) break
        const found: Alternative[] = reaching.start ? [{ node, at, hops: route, start: true }] : []
        for (const definition of reaching.definitions) {
          const where = framed(definition.owner, at)
          if (definition.pattern.type !== 'Identifier' || definition.source === undefined) {
            found.push({ node, at, hops: route })
            continue
          }
          // A logical assignment (`x ||= p`) chooses its source on its own test, and keeps the value it had otherwise.
          const hop = definition.logical ? [...route, { node: definition.source, at: where, site: definition.site }] : route
          found.push(...alternatives(definition.source, where, hop, object, followed))
          if (definition.logical) found.push(...alternatives(definition.pattern, where, route, object, followed))
        }
        return found
      }
      case 'MemberExpression': {
        const sources = resolution.fieldSources(node, at)
        if (sources !== undefined) {
          return sources.flatMap((source) => alternatives(source.node, source.at, route, object, followed))
        }
        // A read in a function the position has no frame of is read in each frame the function is instantiated in.
        const fn = context.functionOf(node)
        if (fn !== undefined && frameOf(at.frame, fn) === undefined) {
          const frames = resolution.framesOf(fn)
          if (frames.length > 0) {
            followed.delete(seen)
            return frames.flatMap((frame) => alternatives(node, { ...at, frame }, hops, object, followed))
          }
        }
        // A member of a native read from it: the holder is chosen where the object it is read from is.
        const from = node['object'] as AstNode
        const native = (value: Value) => value.kind === 'holder' || value.kind === 'native' || value.kind === 'member'
        if (object && from.type !== 'Super' && resolution.evaluate(from, at).some(native)) {
          return alternatives(from, at, route, object, followed).map((alternative) => ({
            ...alternative,
            descended: true as const,
          }))
        }
        break
      }
    }
    return [{ node, at, hops: route }]
  }

  /** The `guard` steps that tag a route, or undefined when the guards along it don't give `guarded-native-absence`. */
  const tagOf = (alternative: Alternative, tested: Judged['target']): GuardStep[] | undefined => {
    let reachability: Judgement['reachability'] = 'unconditional'
    const steps: GuardStep[] = []
    for (const hop of alternative.hops) {
      const judged = context.judge(hop.site, hop.at, tested)
      reachability = along(reachability, judged.reachability)
      steps.push(...judged.steps.filter((step): step is GuardStep => step.kind === 'guard' && step.result === absent))
    }
    return reachability === absent ? steps : undefined
  }

  /**
   * Whether a value is the native the target holds before the write, read through the window written, which writing
   * back changes nothing. Another window's copy is no write-back.
   */
  const isOriginal = (value: Value, original: string, window: string | undefined): boolean => {
    if (window === undefined || !('leaves' in value) || windowOf(value.leaves) !== window) return false
    switch (value.kind) {
      case 'member':
        return value.target === original
      case 'native':
        return value.name === original || memberName(context.global, value.name) === original
      case 'holder':
        return target(original)?.holds === value.holder
      default:
        return false
    }
  }

  /**
   * Whether a holder's alternative can give the holder written: it holds a leaf the holder was reached from, or it may
   * be a native, and, unless the holder is read from it, it may be that holder.
   */
  const givesHolder = (alternative: Alternative, write: Write): boolean => {
    if (alternative.start === true) return false
    if (write.leaves.some((leaf: Leaf) => within(leaf.node, alternative.node))) return true
    const values = resolution.evaluate(alternative.node, alternative.at)
    if (values.length > 0 && values.every((value) => value.kind === 'object' || value.kind === 'constant')) return false
    if (alternative.descended === true) return false
    return !(values.length > 0 && values.every((value) => value.kind === 'holder' && value.holder !== write.holder))
  }

  /** The tag every alternative carries, with the steps of the first; undefined when some alternative has none. */
  const everyTagged = (found: readonly Alternative[], tested: Judged['target']): GuardStep[] | undefined => {
    if (found.length === 0) return undefined
    let first: GuardStep[] | undefined
    for (const alternative of found) {
      if (alternative.start === true) return undefined
      const steps = tagOf(alternative, tested)
      if (steps === undefined) return undefined
      first ??= steps
    }
    return first
  }

  return (write, outcome, at) => {
    const tested = { name: outcome.name, ...(outcome.shadows === undefined ? {} : { shadows: outcome.shadows }) }
    const original = outcome.shadows ?? outcome.name

    const window = windowOf(write.leaves)

    // The holder: the alternatives that can give the holder written.
    const holder = holderExpression(write.site, resolution)
    if (holder !== undefined) {
      const found = alternatives(holder, at, [], true, new Set()).filter((alternative) => givesHolder(alternative, write))
      const steps = everyTagged(found, tested)
      if (steps !== undefined) return steps
    }

    // The value: the alternatives that change the target (no write-back of the original) and give the outcome's effect.
    const sources = valueSources(write)
    if (sources.length === 0) return undefined
    const found = sources
      .flatMap((source) => alternatives(source.node, source.at, [], false, new Set()))
      .filter((alternative) => {
        if (alternative.start === true) return true
        const values = resolution.evaluate(alternative.node, alternative.at)
        return values.length === 0 || !values.every((value) => isOriginal(value, original, window))
      })
    // Only an alternative that is tagged can tag the write, so the effect of each is judged only when one is.
    if (!found.some((alternative) => alternative.start !== true && tagOf(alternative, tested) !== undefined)) return undefined
    const replaced: Replaced = { holder: write.holder, original, leaves: write.leaves }
    const giving =
      outcome.effect === 'wrap' || outcome.effect === 'replace'
        ? found.filter((alternative) => {
            if (alternative.start === true) return outcome.effect === 'replace'
            const answers = context.evidence([{ node: alternative.node, at: alternative.at }], replaced)
            return answers.has(outcome.effect === 'wrap')
          })
        : found
    return everyTagged(giving, tested)
  }
}

/** The expressions a write's new value comes from: an assigned value, or a defined descriptor's `value`. */
function valueSources(write: Write): Source[] {
  const { change } = write
  if (change.kind === 'set') return change.sources ?? []
  if (change.kind !== 'define') return []
  const descriptors = change.alternatives ?? [change.descriptor]
  return descriptors.flatMap((descriptor) => (descriptor === 'refused' ? [] : (descriptor.value?.sources ?? [])))
}

/**
 * The expression that gives the object a write writes: the object of the member an assignment, update or `delete`
 * writes, the object a legacy accessor method is called on, or the first argument of a writer call (`Object.
 * defineProperty(h, …)`, `Reflect.set(h, …)`, `Object.assign(h, …)`). Undefined for a write that names none.
 */
function holderExpression(site: AstNode, resolution: GlobalResolution): AstNode | undefined {
  const objectOf = (member: AstNode): AstNode | undefined => {
    let node = member
    while (node.type === 'ChainExpression' || node.type === 'ParenthesizedExpression') node = node['expression'] as AstNode
    return node.type === 'MemberExpression' ? (node['object'] as AstNode) : undefined
  }
  switch (site.type) {
    case 'AssignmentExpression':
      return objectOf(site['left'] as AstNode)
    case 'UpdateExpression':
    case 'UnaryExpression':
      return objectOf(site['argument'] as AstNode)
    case 'CallExpression': {
      const callee = calleeExpression(site['callee'] as AstNode)
      const key = callee.type === 'MemberExpression' && callee['computed'] !== true ? (callee['property'] as AstNode)['name'] : undefined
      if (typeof key === 'string' && key.startsWith('__')) return callee['object'] as AstNode
      const [first] = site['arguments'] as AstNode[]
      return first === undefined || first.type === 'SpreadElement' ? undefined : first
    }
    case 'Property': {
      // A bulk mechanism's property: the object it is in is a call's argument, and the holder the call's first.
      const literal = resolution.parentOf(site)
      const call = literal === undefined ? undefined : resolution.parentOf(literal)
      if (call?.type !== 'CallExpression') return undefined
      const [first] = call['arguments'] as AstNode[]
      return first === undefined || first === literal || first.type === 'SpreadElement' ? undefined : first
    }
    default:
      return undefined
  }
}

/** Whether `node` lies within `outer`. */
const within = (node: AstNode, outer: AstNode): boolean => node.start >= outer.start && node.end <= outer.end

/** Whether an expression is a literal value: a literal, `undefined`, `void …`, or `!` of one. */
function literal(node: AstNode): boolean {
  switch (node.type) {
    case 'Literal':
      return true
    case 'Identifier':
      return node['name'] === 'undefined'
    case 'TemplateLiteral':
      return (node['expressions'] as AstNode[]).length === 0
    case 'UnaryExpression':
      return node['operator'] === 'void' || (node['operator'] === '!' && literal(node['argument'] as AstNode))
    default:
      return false
  }
}

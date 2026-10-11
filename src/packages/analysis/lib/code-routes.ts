// Indirect code routes (§2 Content that isn't JavaScript): the calls that reach a native that compiles code from strings
// by any route other than the direct forms whose literal code is analyzed as nested code. A native `eval`, `Function`,
// string timer, `%AsyncFunction%`, `%GeneratorFunction%` or `%AsyncGeneratorFunction%` reached through `.call`,
// `.apply`, `.bind`, `Reflect.apply`, `Reflect.construct`, a computed key (`window["eval"]`), a catalog reader
// (`Reflect.get(window, "eval")`, `Object.getOwnPropertyDescriptor(window, "eval").value`), `.constructor` of a known
// function or object (`(function(){}).constructor`, `[]["filter"]["constructor"]`, `alert.constructor`) or a tagged
// template (``Function`…` ``) compiles code the analyzer doesn't read, so the resolver raises `dynamic-code` for it
// (§13).
//
// A route is followed only as far as the analyzer can show where it leads. A value here is a function or object whose
// members the unmutated catalog gives (§4), as prototype walks are simulated elsewhere: a native holder, a native
// function the catalog lists, `Function.prototype`'s `call`, `apply` and `bind`, `Reflect.apply`, `Reflect.construct`,
// `Reflect.get`, the two `getPrototypeOf`s and `getOwnPropertyDescriptor`s, a bound function, a property descriptor, or
// an object the code makes (a function, class, array, object or primitive literal, or a function or class declaration
// or a named function expression read by its own name, never written), whose prototype its syntax shows. These values
// only tell which native a call reaches. They never make a holder for a write: native holders are reached only from the
// global object (§5 Global resolution).
//
// Any alternative counts (Principle 3): an expression with several possible values (`c ? eval : f`, a computed key
// that folds to several strings) is each of them, and a call reaches every native any of them reaches.

import type { Realm, SerializedCatalog } from '../../../catalog.ts'
import { calleeExpression, walkTree, type AstNode } from './ast.ts'
import { opaque, truthiness, type GlobalResolution, type Position } from './global-object.ts'
import { literalKey, memberName, toPropertyKey } from './keys.ts'
import type { ScopeRules } from './scope.ts'

/** The natives that compile code from strings (§2). */
export type Compiler =
  | 'eval'
  | 'setTimeout'
  | 'setInterval'
  | 'Function'
  | '%AsyncFunction%'
  | '%GeneratorFunction%'
  | '%AsyncGeneratorFunction%'

/** The functions the global object holds that compile code from strings, which are no holders. */
export const isGlobalCompiler = (name: unknown): name is 'eval' | 'setTimeout' | 'setInterval' =>
  name === 'eval' || name === 'setTimeout' || name === 'setInterval'

/** The native holders that compile code from strings: `Function` and the constructors of its other kinds. */
const functionConstructors: ReadonlySet<string> = new Set([
  'Function',
  '%AsyncFunction%',
  '%GeneratorFunction%',
  '%AsyncGeneratorFunction%',
])

/**
 * The arguments a call passes: those the analyzer can list, in order (`null` for a hole, which is `undefined`), then
 * the expression whose value gives any further ones, which it can't list (a spread, or an array that is no literal).
 */
export interface Args {
  items: (AstNode | null)[]
  rest?: AstNode
}

/** A call that reaches a native that compiles code from strings, the arguments it passes it, and the route it took. */
export interface IndirectCall {
  compiler: Compiler
  args: Args
  /**
   * Each step of the route that made the call indirect, once: those that reached the native (`a computed key`,
   * `.constructor`, `.bind`), then those that called it (`.call`, `Reflect.apply`).
   */
  via: string[]
}

/** The natives that call, bind or construct another function, or read an object's prototype or property. */
type NativeFunction =
  | 'call'
  | 'apply'
  | 'bind'
  | 'reflect-apply'
  | 'reflect-construct'
  | 'get-prototype-of'
  | 'reflect-get'
  | 'get-own-property-descriptor'

/**
 * A function or object whose members the analyzer knows, with the steps of the route that reached it. `proto` is the
 * holder its members are inherited from, `own` the object literal whose own properties come first, and `primitive`
 * marks a primitive literal, which is no object. A bound function keeps the `this` and the arguments it was bound to.
 * A descriptor is what `getOwnPropertyDescriptor` returns for a data property, whose `value` is known.
 */
type Known = (
  | { kind: 'holder'; holder: string }
  | { kind: 'compiler'; name: 'eval' | 'setTimeout' | 'setInterval' }
  | { kind: NativeFunction; name: string }
  | { kind: 'bound'; target: Known; thisArg: AstNode | null | undefined; args: Args }
  | { kind: 'object'; proto: string; own?: AstNode; primitive?: true }
  | { kind: 'descriptor'; value: Known[] }
) & { via: string[] }

/** The `this` a call passes, each value it may be, found only when a route needs it. */
type This = () => Known[]
const none: This = () => []

/** What a call does that matters here: the natives it compiles code with, and the functions it may return. */
interface Outcome {
  compiles: IndirectCall[]
  returns: Known[]
}
const nothing: Outcome = { compiles: [], returns: [] }

/**
 * The keys a callee's route can end with. Other member calls are not evaluated. `getPrototypeOf`, `get` and
 * `getOwnPropertyDescriptor` end a route whose call returns a function (`Object.getPrototypeOf(AsyncFunction)` is
 * `Function`), and `value` one that reads a descriptor.
 */
const routeKeys: ReadonlySet<string> = new Set([
  'call',
  'apply',
  'bind',
  'construct',
  'getPrototypeOf',
  'get',
  'getOwnPropertyDescriptor',
  'value',
  'constructor',
  'eval',
  'setTimeout',
  'setInterval',
  'Function',
])

export interface CodeRoutes {
  /**
   * The natives that compile code a call, `new` expression or tagged template reaches, one for each native, and how.
   * The direct forms are not told apart here: the resolver tries them first.
   */
  reached(node: AstNode, at: Position): IndirectCall[]
  /**
   * The expressions a callee may be (Principle 3): each branch of a conditional or logical expression that its test
   * doesn't rule out, in source order, or the callee itself.
   */
  alternatives(expression: AstNode, at: Position): AstNode[]
}

export function codeRoutes(context: {
  catalog: SerializedCatalog
  realm: Realm
  /** The realm's global holder, e.g. `Window`. */
  global: string
  program: AstNode
  scope: ScopeRules
  resolution: GlobalResolution
}): CodeRoutes {
  const { catalog, realm, global, program, scope, resolution } = context
  const targets = catalog.targets[realm]
  const holders = catalog.holders[realm]

  /**
   * What each expression is, for the call being followed: a route can reach an expression more than once (as a callee,
   * then as the `this` it passes), and each time it is the same value.
   */
  let values = new Map<AstNode, Known[]>()

  function reached(node: AstNode, at: Position): IndirectCall[] {
    // A tagged template calls its tag with the template's strings array, then its substitutions.
    const tagged = node.type === 'TaggedTemplateExpression'
    const callee = (tagged ? node['tag'] : node['callee']) as AstNode
    if (!tagged && !mayReach(callee)) return []
    values = new Map()
    const reach = known(callee, at)
    if (reach.length === 0) return []
    const args = tagged ? templateArgs(node['quasi'] as AstNode) : argsOf(node['arguments'] as AstNode[])
    const construct = node.type === 'NewExpression'
    const outcome = merged(reach.map((target) => invoke(target, () => thisOf(callee, at), args, construct, at)))
    const { compiles } = tagged ? routed(outcome, 'a tagged template') : outcome
    // One for each native reached, by the first route that reaches it.
    const first = new Map<Compiler, IndirectCall>()
    for (const call of compiles) if (!first.has(call.compiler)) first.set(call.compiler, { ...call, via: [...new Set(call.via)] })
    return [...first.values()]
  }

  /** What calling `target` with a `this` and `args` does, or constructing it with `new`. */
  function invoke(target: Known, self: This, args: Args, construct: boolean, at: Position): Outcome {
    switch (target.kind) {
      case 'compiler':
        // `eval` and the timers are no constructors, so `new` throws.
        return construct ? nothing : { compiles: [{ compiler: target.name, args, via: target.via }], returns: [] }
      case 'holder': {
        if (!functionConstructors.has(target.holder)) return nothing
        const compiler = target.holder as Compiler
        // It returns a function of its kind, whose prototype is the constructor's `prototype`.
        return {
          compiles: [{ compiler, args, via: target.via }],
          returns: [{ kind: 'object', proto: `${target.holder}.prototype`, via: [] }],
        }
      }
      case 'call':
      case 'apply': {
        // `f.call(t, ...args)` and `f.apply(t, args)` call `f`, their own `this`.
        if (construct) return nothing
        const [thisArg] = args.items
        const passed = target.kind === 'call' ? after(args, 1) : spread(args.items[1], args.rest, 'empty')
        if (passed === undefined) return nothing
        return merged(
          self().map((called) =>
            routed(invoke(called, () => knownArg(thisArg, at), passed, false, at), `.${target.kind}`),
          ),
        )
      }
      case 'bind': {
        // `f.bind(t, ...args)` returns `f` bound to `t` and those arguments.
        if (construct) return nothing
        const [thisArg] = args.items
        const bound = after(args, 1)
        return {
          compiles: [],
          returns: self().map((of): Known => ({ kind: 'bound', target: of, thisArg, args: bound, via: ['.bind'] })),
        }
      }
      case 'reflect-apply': {
        if (construct) return nothing
        const [called, thisArg, list] = args.items
        const passed = spread(list, args.rest, 'throws')
        if (passed === undefined) return nothing
        return merged(
          knownArg(called, at).map((reach) =>
            routed(invoke(reach, () => knownArg(thisArg, at), passed, false, at), 'Reflect.apply'),
          ),
        )
      }
      case 'reflect-construct': {
        if (construct) return nothing
        const [constructed, list] = args.items
        const passed = spread(list, args.rest, 'throws')
        if (passed === undefined) return nothing
        return merged(
          knownArg(constructed, at).map((reach) => routed(invoke(reach, none, passed, true, at), 'Reflect.construct')),
        )
      }
      case 'get-prototype-of': {
        // `Object.getPrototypeOf(o)` and `Reflect.getPrototypeOf(o)` of an object whose prototype is known.
        if (construct) return nothing
        const returns = knownArg(args.items[0], at).flatMap((of): Known[] => {
          const proto = prototypeOf(of)
          return proto === undefined ? [] : [{ kind: 'holder', holder: proto, via: of.via }]
        })
        return { compiles: [], returns }
      }
      case 'reflect-get': {
        // `Reflect.get(o, key)` reads the member `key` of an object, as `o[key]` does. A primitive makes it throw.
        if (construct) return nothing
        const [object, key] = args.items
        const keys = constantKeys(key, at)
        const returns = knownArg(object, at)
          .filter((of) => !(of.kind === 'object' && of.primitive === true))
          .flatMap((of) => keys.flatMap((name) => stepped(memberOrValue(of, name), [...of.via, target.name, ...keyStep(name)])))
        return { compiles: [], returns }
      }
      case 'get-own-property-descriptor': {
        // The descriptor of a native holder's own data member, whose `value` is that member.
        if (construct) return nothing
        const [object, key] = args.items
        const keys = constantKeys(key, at)
        const returns = knownArg(object, at).flatMap((of): Known[] => {
          if (of.kind !== 'holder') return []
          const value = keys.flatMap((name) =>
            stepped(optional(ownMember(of.holder, name)), [...of.via, target.name, ...keyStep(name)]),
          )
          return value.length === 0 ? [] : [{ kind: 'descriptor', value, via: [] }]
        })
        return { compiles: [], returns }
      }
      case 'bound': {
        // A bound function calls its target with its bound `this`, and its bound arguments first (ECMA-262
        // BoundFunctionCall). `new` constructs its target, with no `this` (BoundFunctionConstruct).
        const passed = joined(target.args, args)
        const boundThis: This = construct ? none : () => knownArg(target.thisArg, at)
        return routed(invoke(target.target, boundThis, passed, construct, at), ...target.via)
      }
      case 'object':
      case 'descriptor':
        return nothing
    }
  }

  /** Each function or object an expression may be, when the analyzer knows its members. */
  function known(expression: AstNode, at: Position): Known[] {
    const node = unwrapped(expression)
    const seen = values.get(node)
    if (seen !== undefined) return seen
    // A route that comes back to an expression it is still evaluating shows nothing more there.
    values.set(node, [])
    const value = distinct(valueOf(node, at))
    values.set(node, value)
    return value
  }

  function valueOf(node: AstNode, at: Position): Known[] {
    switch (node.type) {
      case 'Identifier':
        return identifier(node, at)
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return [{ kind: 'object', proto: functionPrototype(node), via: [] }]
      case 'ClassExpression':
        return shownClass(node, at) ? [{ kind: 'object', proto: 'Function.prototype', via: [] }] : []
      case 'ArrayExpression':
        return [{ kind: 'object', proto: 'Array.prototype', via: [] }]
      case 'ObjectExpression':
        return [{ kind: 'object', proto: 'Object.prototype', own: node, via: [] }]
      case 'TemplateLiteral':
        return [{ kind: 'object', proto: 'String.prototype', primitive: true, via: [] }]
      case 'Literal': {
        const proto = literalPrototype(node)
        if (proto === undefined) return []
        const regex = node['regex'] !== undefined && node['regex'] !== null
        return [{ kind: 'object', proto, ...(regex ? {} : { primitive: true as const }), via: [] }]
      }
      case 'MemberExpression':
        return member(node, at)
      case 'ConditionalExpression':
      case 'LogicalExpression':
        return alternatives(node, at).flatMap((branch) => known(branch, at))
      case 'CallExpression':
      case 'NewExpression': {
        // What the call returns: a bound function, a prototype, a member or descriptor a reader gives, or a function a
        // constructor makes.
        const callee = node['callee'] as AstNode
        const args = argsOf(node['arguments'] as AstNode[])
        const construct = node.type === 'NewExpression'
        const returned = known(callee, at).flatMap(
          (reach) => invoke(reach, () => thisOf(callee, at), args, construct, at).returns,
        )
        return returned.length > 0 || construct ? returned : holderAt(node, at)
      }
      case 'AssignmentExpression':
        return node['operator'] === '=' ? known(node['right'] as AstNode, at) : []
      default:
        return holderAt(node, at)
    }
  }

  /** A name: a function or class declaration never written, a native the global object holds, or a native holder. */
  function identifier(node: AstNode, at: Position): Known[] {
    const name = node['name'] as string
    const binding = scope.resolve(node)
    // A function declaration, local or at the top level of a classic script (where it puts the function in the global
    // object's property before the script runs), or a named function expression read by its own name, is that function
    // while nothing the analyzer sees writes its name, gives it its own `constructor` or gives it a new prototype. A
    // class declaration is its class literal under the same rules, once it is initialized.
    const declaration =
      binding === 'local' ? scope.declaration(node) : binding.declaration?.kind === 'function' ? binding.declaration.node : undefined
    if (
      (declaration?.type === 'FunctionDeclaration' || declaration?.type === 'FunctionExpression') &&
      namesFunction(node, declaration)
    ) {
      return shownFunction(declaration) ? [{ kind: 'object', proto: functionPrototype(declaration), via: [] }] : []
    }
    if (declaration?.type === 'ClassDeclaration' && namesClass(node, declaration)) {
      const shown = !uninitialized(node, declaration) && shownClass(declaration, at) && shownFunction(declaration)
      return shown ? [{ kind: 'object', proto: 'Function.prototype', via: [] }] : []
    }
    // A local name is the native it aliases (§5 Resolver capabilities 2), and otherwise no native. A name that resolves
    // to a declaration of another kind is no native.
    if (binding === 'local') return aliasOf(node, at)
    if (binding.declaration?.kind === 'function') return []
    if (isGlobalCompiler(name)) return optional(inherited(global, name))
    // A name the code assigns follows its value (§5 Reassigned globals).
    const aliased = aliasOf(node, at)
    if (aliased.length > 0) return aliased
    const found = holderAt(node, at)
    if (found.length > 0 || binding.declaration !== undefined) return found
    // Any other name is the global object's member, if it has one (`alert`).
    return optional(inherited(global, name))
  }

  /**
   * `object.key` or `object[key]`: a holder the global resolution reaches in its own right (`window.Function`,
   * `Function.prototype`), or the member `key` of a known function or object, read through the unmutated catalog. A
   * computed key is each string it may fold to.
   */
  function member(node: AstNode, at: Position): Known[] {
    const object = node['object'] as AstNode
    const property = node['property'] as AstNode
    if (object.type === 'Super') return []
    const computed = node['computed'] === true
    const named = property.type === 'Identifier' ? (property['name'] as string) : undefined
    const keys = computed ? constantKeys(property, at) : named === undefined ? [] : [named]
    if (keys.length === 0) return []
    const computedStep = computed ? ['a computed key'] : []
    const found = holderAt(node, at)
    if (found.length > 0 && keys.length === 1) {
      const steps = [...computedStep, ...keyStep(keys[0]!)]
      return found.map((holder) => ({ ...holder, via: [...holder.via, ...steps] }))
    }
    const bases = known(object, at)
    const read = bases.flatMap((base) =>
      keys.flatMap((key) => stepped(memberOrValue(base, key), [...base.via, ...computedStep, ...keyStep(key)])),
    )
    return [...found.map((holder) => ({ ...holder, via: [...holder.via, ...computedStep] })), ...read]
  }

  /** The member `key` of a known value, from its own members and then its prototype's, as the catalog gives them. */
  function memberOf(value: Known, key: string): Known | undefined {
    if (value.kind === 'holder') return inherited(value.holder, key)
    if (value.kind === 'descriptor') return undefined
    if (value.kind === 'object' && value.own !== undefined && !lacksOwn(value.own, key)) return undefined
    const proto = prototypeOf(value)
    return proto === undefined ? undefined : inherited(proto, key)
  }

  /** A descriptor's `value`, the only member of one that a route reads. */
  function descriptorValue(value: Known, key: string): Known[] {
    return value.kind === 'descriptor' && key === 'value' ? value.value : []
  }

  /**
   * The member `key` that `holder` has or inherits, in the unmutated catalog: a holder, a native function that compiles
   * code, one of the functions that call, bind or construct another, or read a prototype or property, or any other
   * native function, whose prototype is `Function.prototype`.
   */
  function inherited(holder: string, key: string): Known | undefined {
    for (let at: string | null | undefined = holder; typeof at === 'string'; at = holders[at]?.proto) {
      const found = memberAt(at, key, holder === global)
      if (found !== null) return found
    }
    return undefined
  }

  /** The member `key` of `holder` itself, in the unmutated catalog. */
  function ownMember(holder: string, key: string): Known | undefined {
    return memberAt(holder, key, holder === global) ?? undefined
  }

  /** The member `key` that `holder` itself has: null when it has none, undefined when it is no value a route knows. */
  function memberAt(holder: string, key: string, onGlobal: boolean): Known | undefined | null {
    const name = memberName(holder, key)
    if (!Object.hasOwn(targets, name)) return null
    const target = targets[name]!
    if (target.holds !== undefined) return { kind: 'holder', holder: target.holds, via: [] }
    const native = nativeFunctions.get(name)
    if (native !== undefined) return { kind: native, name, via: [] }
    if (onGlobal && isGlobalCompiler(key)) return { kind: 'compiler', name: key, via: [] }
    if (target.kind === 'function' || target.kind === 'operation') {
      return { kind: 'object', proto: 'Function.prototype', via: [] }
    }
    return undefined
  }

  /** The holder a known value inherits its members from. */
  function prototypeOf(value: Known): string | undefined {
    switch (value.kind) {
      case 'holder':
        return holders[value.holder]?.proto ?? undefined
      case 'object':
        return value.proto
      case 'descriptor':
        return 'Object.prototype'
      case 'bound':
        // A bound function's prototype is its target's (ECMA-262 BoundFunctionCreate).
        return prototypeOf(value.target)
      default:
        return 'Function.prototype'
    }
  }

  /**
   * The holders, code-compiling natives, and natives that call, bind or read another function that a name aliases (§5
   * Resolver capabilities 2).
   */
  function aliasOf(node: AstNode, at: Position): Known[] {
    const via = [`a variable \`${node['name'] as string}\``]
    return resolution.aliasCallee(node, at).flatMap((value): Known[] => {
      if (value.kind === 'holder') return [{ kind: 'holder', holder: value.holder, via }]
      if (value.kind !== 'native') return []
      if (isGlobalCompiler(value.name)) return [{ kind: 'compiler', name: value.name, via }]
      const native = nativeFunctions.get(value.name)
      return native === undefined ? [] : [{ kind: native, name: value.name, via }]
    })
  }

  /** The native holders the global resolution shows an expression may be, and nothing else. */
  function holderAt(node: AstNode, at: Position): Known[] {
    return resolution
      .evaluate(node, at)
      .flatMap((value): Known[] => (value.kind === 'holder' ? [{ kind: 'holder', holder: value.holder, via: [] }] : []))
  }

  /** The strings a computed key or key argument may fold to: none for a missing argument. */
  function constantKeys(property: AstNode | null | undefined, at: Position): string[] {
    if (property === null || property === undefined) return []
    const keys = resolution.evaluate(property, at).flatMap((value) => {
      if (value.kind !== 'constant') return []
      const key = toPropertyKey(value.value)
      return typeof key === 'string' ? [key] : []
    })
    return [...new Set(keys)]
  }

  /** The `this` a callee passes: the object of a member call, when the analyzer knows it. */
  function thisOf(callee: AstNode, at: Position): Known[] {
    const node = callee.type === 'ChainExpression' ? (callee['expression'] as AstNode) : callee
    return node.type === 'MemberExpression' && (node['object'] as AstNode).type !== 'Super'
      ? known(node['object'] as AstNode, at)
      : []
  }

  /** An argument's value, when the analyzer knows it. A hole or a missing argument is `undefined`. */
  function knownArg(arg: AstNode | null | undefined, at: Position): Known[] {
    return arg === null || arg === undefined ? [] : known(arg, at)
  }

  /** The member `key` of a value, or a descriptor's `value`. */
  function memberOrValue(value: Known, key: string): Known[] {
    return [...optional(memberOf(value, key)), ...descriptorValue(value, key)]
  }

  function alternatives(expression: AstNode, at: Position): AstNode[] {
    const node = unwrapped(expression)
    if (node.type === 'ConditionalExpression') {
      const decided = truthiness(resolution.evaluate(node['test'] as AstNode, at))
      const branches = [node['consequent'], node['alternate']] as AstNode[]
      const kept = decided === undefined ? branches : [decided ? branches[0]! : branches[1]!]
      return kept.flatMap((branch) => alternatives(branch, at))
    }
    if (node.type === 'LogicalExpression') {
      const left = node['left'] as AstNode
      const right = node['right'] as AstNode
      const values = resolution.evaluate(left, at)
      // Whether the right side is surely taken (true), surely not (false), or may be.
      let decided: boolean | undefined
      if (node['operator'] === '??') {
        const nullish = values.map((value) =>
          opaque(value) ? undefined : value.kind === 'constant' && (value.value === null || value.value === undefined),
        )
        decided = nullish.every((each) => each === true) ? true : nullish.every((each) => each === false) ? false : undefined
      } else {
        const truthy = truthiness(values)
        decided = truthy === undefined ? undefined : node['operator'] === '||' ? !truthy : truthy
      }
      const kept = decided === undefined ? [left, right] : [decided ? right : left]
      return kept.flatMap((branch) => alternatives(branch, at))
    }
    return [expression]
  }

  // Which bases stop being shown (§2): a class whose statics may give it its own `constructor`, or a function whose
  // name is written, and either when code the analyzer sees gives it its own `constructor` or a new prototype.

  const functions = new Map<AstNode, boolean>()
  let index: WriteIndex | undefined

  /** Whether nothing the analyzer sees writes a function's or class declaration's name or changes what it names. */
  function shownFunction(declaration: AstNode): boolean {
    const shown = functions.get(declaration)
    if (shown !== undefined) return shown
    index ??= writeIndex(program, resolution)
    const name = (declaration['id'] as AstNode | null)?.['name']
    const names = declaration.type === 'ClassDeclaration' ? namesClass : namesFunction
    const resolvesHere = (id: AstNode) => {
      if (id['name'] !== name) return false
      try {
        return scope.declaration(id) === declaration && names(id, declaration)
      } catch {
        // A name the seam recorded no reference for is taken to be this one.
        return true
      }
    }
    const result =
      !index.redeclared.has(declaration) && !index.written.some(resolvesHere) && !index.changed.some(resolvesHere)
    functions.set(declaration, result)
    return result
  }

  let functionNodes: AstNode[] | undefined

  /**
   * Whether a read of a class declaration's name surely throws because its binding is not yet initialized (Principle
   * 1): the read comes before the class body and runs as the code around the declaration runs, in no function between
   * the two. Its heritage and its members' computed keys run before the binding is set, its static members after.
   */
  function uninitialized(id: AstNode, declaration: AstNode): boolean {
    const body = declaration['body'] as AstNode
    const within = (node: AstNode) => node.start <= id.start && id.end <= node.end
    const inKey = (body['body'] as AstNode[]).some((member) => member['computed'] === true && within(member['key'] as AstNode))
    if (id.start >= body.start && !inKey) return false
    functionNodes ??= collectFunctions(program)
    const holds = (outer: AstNode, inner: AstNode) => outer.start <= inner.start && inner.end <= outer.end
    return !functionNodes.some((fn) => holds(fn, id) && !holds(fn, declaration))
  }

  function shownClass(node: AstNode, at: Position): boolean {
    if (node['superClass'] !== null) return false
    const body = node['body'] as AstNode
    const members = body['body'] as AstNode[]
    for (const member of members) {
      if (member['static'] !== true || member.type === 'StaticBlock') continue
      // A static member whose key is or may be `constructor` gives the class its own.
      const key = member['key'] as AstNode
      if (key.type === 'PrivateIdentifier') continue
      if (member['computed'] === true) {
        const values = resolution.evaluate(key, at)
        if (values.some((value) => value.kind !== 'constant' || toPropertyKey(value.value) === 'constructor')) return false
      } else if ((key.type === 'Identifier' ? key['name'] : literalKey(key)) === 'constructor') {
        return false
      }
    }
    // Code in its static members, where `this` is the class, and any code in it that names the class.
    const statics = members.flatMap((member): AstNode[] => {
      if (member.type === 'StaticBlock') return [member]
      if (member['static'] !== true) return []
      const value = member['value'] as AstNode | null | undefined
      if (value === null || value === undefined) return []
      return member.type === 'MethodDefinition' ? [value['body'] as AstNode] : [value]
    })
    if (changedIn(statics, resolution).some((subject) => subject.type === 'ThisExpression')) return false
    const name = (node['id'] as AstNode | null)?.['name']
    if (name === undefined) return true
    return !changedIn([body], resolution).some(
      (subject) => subject.type === 'Identifier' && subject['name'] === name && scope.declaration(subject) === node,
    )
  }

  return { reached, alternatives }
}

/** The natives that call, bind or construct another function, or read a prototype or property, by their target names. */
const nativeFunctions: ReadonlyMap<string, NativeFunction> = new Map([
  ['Function.prototype.call', 'call'],
  ['Function.prototype.apply', 'apply'],
  ['Function.prototype.bind', 'bind'],
  ['Reflect.apply', 'reflect-apply'],
  ['Reflect.construct', 'reflect-construct'],
  ['Reflect.getPrototypeOf', 'get-prototype-of'],
  ['Object.getPrototypeOf', 'get-prototype-of'],
  ['Reflect.get', 'reflect-get'],
  ['Reflect.getOwnPropertyDescriptor', 'get-own-property-descriptor'],
  ['Object.getOwnPropertyDescriptor', 'get-own-property-descriptor'],
])

/**
 * Whether a callee can end a route to a native that compiles code: a member read whose key is a constant it could be,
 * or computed, a call that returns a function (`f.bind(t)`), or a name, which may alias one of the natives a route
 * goes through. A name that aliases a native that compiles code is a direct form's native, which the resolver tries
 * first.
 */
function mayReach(callee: AstNode): boolean {
  const node = unwrapped(callee)
  if (node.type === 'MemberExpression') {
    const property = node['property'] as AstNode
    return node['computed'] === true || (property.type === 'Identifier' && routeKeys.has(property['name'] as string))
  }
  // A name may alias a native that calls another function (`const { apply } = Reflect`, §5 Resolver capabilities 2).
  if (node.type === 'Identifier') return true
  return node.type === 'CallExpression' && mayReach(node['callee'] as AstNode)
}

/** An expression past the comma sequences and optional chains that don't change its value. */
function unwrapped(expression: AstNode): AstNode {
  let node = calleeExpression(expression)
  while (node.type === 'ChainExpression') node = calleeExpression(node['expression'] as AstNode)
  return node
}

/** The holder a function literal or declaration inherits from, by its kind. */
function functionPrototype(node: AstNode): string {
  const async = node['async'] === true
  const generator = node['generator'] === true
  if (async && generator) return '%AsyncGeneratorFunction%.prototype'
  if (async) return '%AsyncFunction%.prototype'
  if (generator) return '%GeneratorFunction%.prototype'
  return 'Function.prototype'
}

/** The prototype a primitive or regular expression literal's value inherits from, or none for `null`. */
function literalPrototype(node: AstNode): string | undefined {
  if (node['regex'] !== undefined && node['regex'] !== null) return 'RegExp.prototype'
  if (node['bigint'] !== undefined && node['bigint'] !== null) return 'BigInt.prototype'
  switch (typeof node['value']) {
    case 'string':
      return 'String.prototype'
    case 'number':
      return 'Number.prototype'
    case 'boolean':
      return 'Boolean.prototype'
    default:
      return undefined
  }
}

/**
 * Whether an object literal plainly has no own property `key`: every property is a plain one with a key written out
 * that is another, and none sets the literal's prototype.
 */
function lacksOwn(literal: AstNode, key: string): boolean {
  return (literal['properties'] as AstNode[]).every((property) => {
    if (property.type !== 'Property' || property['computed'] === true) return false
    const written = property['key'] as AstNode
    const name = written.type === 'Identifier' ? written['name'] : written['value']
    if (typeof name !== 'string' && typeof name !== 'number') return false
    return String(name) !== key && String(name) !== '__proto__'
  })
}

/** A call's own arguments: each up to the first spread, which gives the rest. */
function argsOf(nodes: readonly AstNode[]): Args {
  const spreadAt = nodes.findIndex((node) => node.type === 'SpreadElement')
  return spreadAt < 0 ? { items: [...nodes] } : { items: nodes.slice(0, spreadAt), rest: nodes[spreadAt]! }
}

/** The arguments after the first `count`. Arguments the rest gives stay unknown. */
function after(args: Args, count: number): Args {
  if (args.items.length >= count) return { items: args.items.slice(count), ...(args.rest ? { rest: args.rest } : {}) }
  return args.rest === undefined ? { items: [] } : { items: [], rest: args.rest }
}

/**
 * The arguments an array-like passes when spread (`f.apply(t, list)`, `Reflect.apply(f, t, list)`): an array literal's
 * elements, and otherwise ones the analyzer can't list. `rest` is the spread that may hold the list. A missing,
 * `undefined` or `null` list passes none to `.apply`, and makes `Reflect.apply` and `Reflect.construct` throw
 * (`nullish`), and so does a primitive list to all three (ECMA-262 CreateListFromArrayLike): undefined when it throws.
 */
function spread(list: AstNode | null | undefined, rest: AstNode | undefined, nullish: 'empty' | 'throws'): Args | undefined {
  if (list === undefined && rest !== undefined) return { items: [], rest }
  if (list === undefined || list === null || isNullLiteral(list)) return nullish === 'empty' ? { items: [] } : undefined
  if (list.type === 'ArrayExpression') {
    const elements = list['elements'] as (AstNode | null)[]
    const spreadAt = elements.findIndex((element) => element?.type === 'SpreadElement')
    return spreadAt < 0 ? { items: [...elements] } : { items: elements.slice(0, spreadAt), rest: elements[spreadAt]! }
  }
  if (isPrimitive(list)) return undefined
  return { items: [], rest: list }
}

/** A literal whose `value` alone doesn't say what it is: a regular expression or a bigint, whose value can be `null`. */
const isRegexOrBigint = (node: AstNode) => (node['regex'] ?? node['bigint'] ?? null) !== null

const isNullLiteral = (node: AstNode) => node.type === 'Literal' && node['value'] === null && !isRegexOrBigint(node)

/** A string, number, boolean or bigint literal, or a template literal: a primitive that is no array-like object. */
function isPrimitive(node: AstNode): boolean {
  if (node.type === 'TemplateLiteral') return true
  if (node.type !== 'Literal') return false
  if (node['regex'] !== undefined && node['regex'] !== null) return false
  return node['value'] !== null || isRegexOrBigint(node)
}

/**
 * The type of the node that stands for a tagged template's strings array: an array, which a string conversion joins
 * into the template's text, located at the template.
 */
export const templateStrings = 'TemplateStrings'

/** The arguments a tagged template passes its tag: its strings array, then its substitutions. */
function templateArgs(quasi: AstNode): Args {
  const strings: AstNode = { type: templateStrings, start: quasi.start, end: quasi.end }
  return { items: [strings, ...(quasi['expressions'] as AstNode[])] }
}

/** Arguments bound first, then those a call passes. */
function joined(first: Args, then: Args): Args {
  if (first.rest !== undefined) return first
  return { items: [...first.items, ...then.items], ...(then.rest ? { rest: then.rest } : {}) }
}

/** The step a route took, added to each native that the call it leads to compiles code with. */
function routed(outcome: Outcome, ...steps: string[]): Outcome {
  if (outcome.compiles.length === 0) return outcome
  const compiles = outcome.compiles.map((call) => ({ ...call, via: [...new Set([...call.via, ...steps])] }))
  return { ...outcome, compiles }
}

/** What any of several calls may do. */
function merged(outcomes: readonly Outcome[]): Outcome {
  if (outcomes.length === 1) return outcomes[0]!
  return { compiles: outcomes.flatMap((each) => each.compiles), returns: distinct(outcomes.flatMap((each) => each.returns)) }
}

/** Values a route read, with the steps that reached them. */
const stepped = (found: readonly Known[], via: readonly string[]): Known[] =>
  found.map((value) => ({ ...value, via: [...value.via, ...via] }))

const optional = <T>(value: T | undefined): T[] => (value === undefined ? [] : [value])

/** The step a member read adds for its key. */
const keyStep = (key: string): string[] => (key === 'constructor' ? ['.constructor'] : [])

/** Values with the same meaning once, the first route to each kept. */
function distinct(values: readonly Known[]): Known[] {
  if (values.length < 2) return [...values]
  const seen = new Map<string, Known>()
  for (const value of values) {
    const key = keyOf(value)
    if (!seen.has(key)) seen.set(key, value)
  }
  return [...seen.values()]
}

function keyOf(value: Known): string {
  const at = (node: AstNode | null | undefined) => (node === null || node === undefined ? '-' : `${node.start}:${node.end}`)
  switch (value.kind) {
    case 'holder':
      return `holder ${value.holder}`
    case 'compiler':
      return `compiler ${value.name}`
    case 'object':
      return `object ${value.proto} ${at(value.own)} ${value.primitive === true}`
    case 'descriptor':
      return `descriptor [${value.value.map(keyOf).join(', ')}]`
    case 'bound':
      return `bound ${keyOf(value.target)} ${at(value.thisArg)} ${value.args.items.map(at).join(',')} ${at(value.args.rest)}`
    default:
      return `${value.kind} ${value.name}`
  }
}

/**
 * Where the code a program holds writes a name (§2): each identifier it assigns, updates or declares with a value, and
 * each it gives its own `constructor` or a new prototype. `redeclared` holds the function declarations that another of
 * the same name in the same statement list replaces.
 */
interface WriteIndex {
  written: AstNode[]
  changed: AstNode[]
  redeclared: Set<AstNode>
}

function writeIndex(program: AstNode, resolution: GlobalResolution): WriteIndex {
  const written: AstNode[] = []
  const changed: AstNode[] = []
  const redeclared = new Set<AstNode>()
  const declared = new Map<AstNode, Map<string, AstNode[]>>()
  walkTree(program, {
    enter(node, parent) {
      switch (node.type) {
        case 'AssignmentExpression':
          written.push(...patternNames(node['left'] as AstNode))
          break
        case 'UpdateExpression':
          written.push(...patternNames(node['argument'] as AstNode))
          break
        case 'ForInStatement':
        case 'ForOfStatement': {
          const left = node['left'] as AstNode
          if (left.type !== 'VariableDeclaration') written.push(...patternNames(left))
          else for (const declarator of left['declarations'] as AstNode[]) written.push(...patternNames(declarator['id'] as AstNode))
          break
        }
        case 'VariableDeclarator':
          if (node['init'] !== null && node['init'] !== undefined) written.push(...patternNames(node['id'] as AstNode))
          break
        case 'FunctionDeclaration': {
          const name = (node['id'] as AstNode | null)?.['name'] as string | undefined
          if (parent === null || name === undefined) break
          const byName = declared.get(parent) ?? new Map<string, AstNode[]>()
          declared.set(parent, byName)
          byName.set(name, [...(byName.get(name) ?? []), node])
          break
        }
      }
      const subject = changeAt(node, resolution)
      if (subject?.type === 'Identifier') changed.push(subject)
    },
  })
  for (const byName of declared.values()) {
    for (const same of byName.values()) if (same.length > 1) for (const node of same) redeclared.add(node)
  }
  return { written, changed, redeclared }
}

/**
 * Whether a name that resolves to a function declaration or a named function expression is the function's own name.
 * The seam gives the function for its parameters and its `arguments` too (§19), so a name inside it that one of its
 * parameters binds, or `arguments`, is no function.
 */
function namesFunction(id: AstNode, declaration: AstNode): boolean {
  const name = id['name']
  if ((declaration['id'] as AstNode | null)?.['name'] !== name) return false
  if (id.start < declaration.start || id.end > declaration.end) return true
  // Inside the function, `arguments` is its arguments object, whatever the function is called.
  if (name === 'arguments') return false
  return !(declaration['params'] as AstNode[]).some((param) => patternNames(param).some((bound) => bound['name'] === name))
}

/** Whether a name that resolves to a class declaration is the class's own name. */
function namesClass(id: AstNode, declaration: AstNode): boolean {
  return (declaration['id'] as AstNode | null)?.['name'] === id['name']
}

/** Every function in a program, whose code runs when it is called rather than where it is written. */
function collectFunctions(program: AstNode): AstNode[] {
  const found: AstNode[] = []
  walkTree(program, {
    enter(node) {
      if (isFunction(node)) found.push(node)
    },
  })
  return found
}

/** The names a pattern or assignment target binds: none for a member. */
function patternNames(pattern: AstNode | null | undefined): AstNode[] {
  if (pattern === null || pattern === undefined) return []
  switch (pattern.type) {
    case 'Identifier':
      return [pattern]
    case 'ObjectPattern':
      return (pattern['properties'] as AstNode[]).flatMap((property) =>
        patternNames((property.type === 'RestElement' ? property['argument'] : property['value']) as AstNode),
      )
    case 'ArrayPattern':
      return (pattern['elements'] as (AstNode | null)[]).flatMap((element) => patternNames(element))
    case 'AssignmentPattern':
      return patternNames(pattern['left'] as AstNode)
    case 'RestElement':
      return patternNames(pattern['argument'] as AstNode)
    default:
      return []
  }
}

/**
 * The subjects code in `roots` gives its own `constructor` or a new prototype, where `this` is kept only when it is the
 * `this` of the roots themselves (outside any function or class in them other than an arrow function).
 */
function changedIn(roots: readonly AstNode[], resolution: GlobalResolution): AstNode[] {
  const found: AstNode[] = []
  for (const root of roots) {
    let depth = 0
    const ownThis = (node: AstNode) => isClassNode(node) || (isFunction(node) && node.type !== 'ArrowFunctionExpression')
    walkTree(root, {
      enter(node) {
        const subject = changeAt(node, resolution)
        if (subject !== undefined && (subject.type !== 'ThisExpression' || depth === 0)) found.push(subject)
        if (ownThis(node)) depth++
      },
      leave(node) {
        if (ownThis(node)) depth--
      },
    })
  }
  return found
}

const isFunction = (node: AstNode) =>
  node.type === 'FunctionExpression' || node.type === 'FunctionDeclaration' || node.type === 'ArrowFunctionExpression'
const isClassNode = (node: AstNode) => node.type === 'ClassExpression' || node.type === 'ClassDeclaration'

/** A position that knows no guards, for code read away from where it runs. */
const nowhere: Position = { guard: () => undefined, topLevel: false }

/** The methods that give an object its own `constructor` or a new prototype, on `Object` and on `Reflect`. */
const changers: Readonly<Record<string, ReadonlySet<string>>> = {
  Object: new Set(['defineProperty', 'defineProperties', 'assign', 'setPrototypeOf']),
  Reflect: new Set(['defineProperty', 'set', 'setPrototypeOf']),
}

/**
 * The object a node surely gives its own `constructor` or a new prototype (§2), if it does: `o.constructor = g`,
 * `o.__proto__ = p`, `Object.defineProperty(o, "constructor", d)`, `Reflect.set(o, "constructor", g)`,
 * `Object.defineProperties(o, { constructor: d })`, `Object.assign(o, { constructor: g })` or `setPrototypeOf(o, p)`.
 * A key that may be another gives the other alternative, whose `constructor` stays inherited (Principle 3).
 */
function changeAt(node: AstNode, resolution: GlobalResolution): AstNode | undefined {
  if (node.type === 'AssignmentExpression') {
    const left = node['left'] as AstNode
    if (left.type !== 'MemberExpression') return undefined
    return surelyKey(left, ['constructor', '__proto__'], resolution) ? (left['object'] as AstNode) : undefined
  }
  if (node.type !== 'CallExpression') return undefined
  const callee = unwrapped(node['callee'] as AstNode)
  if (callee.type !== 'MemberExpression' || callee['computed'] === true) return undefined
  const method = (callee['property'] as AstNode)['name'] as string
  const on = resolution
    .evaluate(callee['object'] as AstNode, nowhere)
    .find((value) => value.kind === 'holder' && changers[value.holder]?.has(method) === true)
  if (on === undefined) return undefined
  const [subject, key, ...rest] = node['arguments'] as (AstNode | undefined)[]
  if (subject === undefined || subject.type === 'SpreadElement') return undefined
  const object = unwrapped(subject)
  switch (method) {
    case 'setPrototypeOf':
      return object
    case 'defineProperty':
    case 'set':
      return key !== undefined && surelyConstructor(key, resolution) ? object : undefined
    default: {
      // `defineProperties(o, props)` and `assign(o, ...sources)`: an object literal with a `constructor` key.
      const sources = method === 'defineProperties' ? [key] : [key, ...rest]
      const gives = sources.some(
        (source) =>
          source?.type === 'ObjectExpression' &&
          (source['properties'] as AstNode[]).some((property) => {
            if (property.type !== 'Property') return false
            const written = property['key'] as AstNode
            if (property['computed'] === true) return surelyConstructor(written, resolution)
            return (written.type === 'Identifier' ? written['name'] : literalKey(written)) === 'constructor'
          }),
      )
      return gives ? object : undefined
    }
  }
}

/** Whether a member expression's key is surely one of `names`. */
function surelyKey(member: AstNode, names: readonly string[], resolution: GlobalResolution): boolean {
  const property = member['property'] as AstNode
  if (member['computed'] !== true) return property.type === 'Identifier' && names.includes(property['name'] as string)
  return surely(property, names, resolution)
}

const surelyConstructor = (key: AstNode, resolution: GlobalResolution) => surely(key, ['constructor'], resolution)

/** Whether every value an expression may have is a key among `names`. */
function surely(node: AstNode, names: readonly string[], resolution: GlobalResolution): boolean {
  const values = resolution.evaluate(node, nowhere)
  return (
    values.length > 0 &&
    values.every((value) => {
      if (value.kind !== 'constant') return false
      const key = toPropertyKey(value.value)
      return typeof key === 'string' && names.includes(key)
    })
  )
}

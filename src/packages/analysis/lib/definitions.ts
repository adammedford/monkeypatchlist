// Definitions and reaching definitions (§5 Resolver capabilities 2). A variable's value is the union of its
// definitions across its whole scope. Within one function, the walk orders a read after the definitions that reach it
// through statement lists, `if` arms, `?:`, `&&`/`||`/`??` and comma sequences, so a later definition kills an earlier
// one. Details:
//
// - A variable declared in the function the read is in starts with its start value (the `undefined` of a `var` or
//   `let`, the native value of a global name), which counts only where the walk shows it reaches the read.
// - A read the walk can't order sees only the values the code assigns: a read in a nested function of a variable
//   declared outside it, a read inside a loop, `try`, `switch` or other statement the walk doesn't follow, and a read
//   past the walk's reach. Only a variable nothing assigns keeps its start value there.
// - A definition in another function (a closure, or the function around the read's) joins the read only where a call,
//   `new`, tagged template, `await` or `yield` lies between the reaching definition and the read.
// - A statement the walk doesn't follow (a loop, `try`, `switch`, a labelled statement) adds the definitions in it to
//   those that reach past it, and a closure's definitions when a call lies in it.
// - A class's static blocks and static field initializers run when the class is evaluated (ECMA-262
//   ClassDefinitionEvaluation), so the walk follows them there, after the class's heritage and computed keys. Methods
//   and instance field initializers are functions of their own.
//
// A variable is a declared name, keyed by the declaration it resolves to after the scope post-passes, or a name bound
// on the global object (§5 Global resolution): a free name or a classic script's top-level `var`, keyed by its name.

import { walkTree, type AstNode } from './ast.ts'
import { alwaysExits } from './early-exits.ts'
import { boundNames, type ScopeRules } from './scope.ts'

/** A variable: a local declaration's name, or a name bound on the global object (`global`). */
export interface VariableKey {
  scope: AstNode | 'global'
  name: string
}

/**
 * A definition of a variable: a declarator with an initializer, an assignment, an update, or a `for…in`/`for…of`
 * head. `pattern` destructures `source` to give the variable its value. A definition with no `source` gives a value the
 * syntax doesn't show (`x += 1`, `x++`, a loop head). A logical assignment (`x ||= e`) may keep the value before it.
 */
export interface Definition {
  /** The declarator, assignment, update or loop head that defines the variable. */
  site: AstNode
  name: string
  pattern: AstNode
  source?: AstNode
  logical: boolean
  /**
   * For a compound assignment of an identifier (`x += e`, `x **= e`, but not `||=`, `&&=` or `??=`), the binary
   * expression ECMA-262 evaluates it as: `x op e`, with the assignment's own `x` and `e` as operands.
   */
  compound?: AstNode
  /**
   * The function, program or instance field initializer whose own code the definition is in, where the walk orders it:
   * a class's static blocks and static field initializers are the code of the function the class is evaluated in.
   */
  owner: AstNode
  /** Whether `this` at the definition is the script's top-level `this`: no non-arrow function or class code around it. */
  topLevel: boolean
}

/**
 * The definitions that reach a read: `start` when the variable's start value does, and the definitions whose values it
 * may have. `ordered` says whether the walk ordered the read.
 */
export interface Reaching {
  start: boolean
  definitions: readonly Definition[]
  ordered: boolean
  /**
   * The start value and definitions that reach the read only past a lazy init that didn't assign (§5 Resolver
   * capabilities 6), each with the tests their values passed there: only its values that pass every one remain.
   */
  narrowed?: ReadonlyMap<Definition | 'start', readonly Narrowing[]>
}

/**
 * What a lazy init's test lets past without assigning (§5 Resolver capabilities 6): after `if (!k) k = …` only the
 * truthy entry values remain, after `if (k == null) k = …` only the non-nullish ones.
 */
export type Narrowing = 'truthy' | 'falsy' | 'nullish' | 'notNullish' | 'null' | 'notNull' | 'undefined' | 'notUndefined'

/** Whether a primitive passes a narrowing's test. */
export function passes(narrowing: Narrowing, value: unknown): boolean {
  switch (narrowing) {
    case 'truthy':
      return Boolean(value)
    case 'falsy':
      return !value
    case 'nullish':
      return value === null || value === undefined
    case 'notNullish':
      return value !== null && value !== undefined
    case 'null':
      return value === null
    case 'notNull':
      return value !== null
    case 'undefined':
      return value === undefined
    default:
      return value !== undefined
  }
}

/** The narrowing that holds where a test fails, from the one that holds where it passes. */
const opposite: Readonly<Record<Narrowing, Narrowing>> = {
  truthy: 'falsy',
  falsy: 'truthy',
  nullish: 'notNullish',
  notNullish: 'nullish',
  null: 'notNull',
  notNull: 'null',
  undefined: 'notUndefined',
  notUndefined: 'undefined',
}

export interface Definitions {
  /** The variable an identifier reads or writes, or none when the seam has no declaration for a local name. */
  keyOf(id: AstNode): VariableKey | undefined
  /** Every definition of a variable in the program, in document order. */
  of(key: VariableKey): readonly Definition[]
  /** The definitions of `key` that reach the read `id`. */
  reaching(id: AstNode, key: VariableKey): Reaching
}

/** Whether an assignment operator is a compound one that reads its target and folds (`+=`, `**=`), not `=` or a logical one. */
export const compoundOperator = (operator: string): boolean =>
  operator !== '=' && operator !== '||=' && operator !== '&&=' && operator !== '??='

const compoundOperations = new WeakMap<AstNode, AstNode>()

/**
 * The binary expression a compound assignment of an identifier, `x op= e`, evaluates (ECMA-262 13.15.2): `x op e`,
 * spanning the assignment, with its own operand nodes. One per assignment, so it is a stable node to memoize and trace
 * by. Undefined for any other node.
 */
export function compoundOf(site: AstNode): AstNode | undefined {
  if (site.type !== 'AssignmentExpression' || !compoundOperator(site['operator'] as string)) return undefined
  const left = site['left'] as AstNode
  if (left.type !== 'Identifier') return undefined
  let found = compoundOperations.get(site)
  if (found === undefined) {
    const operator = (site['operator'] as string).slice(0, -1)
    found = { type: 'BinaryExpression', operator, left, right: site['right'], start: site.start, end: site.end } as AstNode
    compoundOperations.set(site, found)
  }
  return found
}

/**
 * The function declarations whose own name a parameter (or `arguments`) shadows, by their `id`: `function n(t, n){…}`.
 * The seam gives both of its bindings `n` the declaration, so the name, read outside the function, is keyed by the
 * declaration's `id` instead.
 */
const shadowedNames = new WeakMap<AstNode, AstNode>()

/** The function declaration a variable is the name of, when its key is the `id` of one a parameter shadows. */
export const shadowedNameOf = (scope: AstNode | 'global'): AstNode | undefined =>
  scope === 'global' ? undefined : shadowedNames.get(scope)

/** Whether a function binds `name` in itself, as a parameter or `arguments`. */
export const bindsOwn = (fn: AstNode, name: string): boolean =>
  name === 'arguments' || (fn['params'] as AstNode[]).flatMap(boundNames).includes(name)

/** Functions, which run as code of their own. */
const functionTypes: ReadonlySet<string> = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/** Nodes whose evaluation can run code the read's function doesn't show: a call, `new`, `await` or `yield`. */
const runsCode: ReadonlySet<string> = new Set([
  'CallExpression',
  'NewExpression',
  'TaggedTemplateExpression',
  'AwaitExpression',
  'YieldExpression',
])

/** The statements the walk follows in order. Any other statement is walked as a whole (`opaque`). */
const followed: ReadonlySet<string> = new Set([
  'ExpressionStatement',
  'VariableDeclaration',
  'IfStatement',
  'BlockStatement',
  'ReturnStatement',
  'ThrowStatement',
  'EmptyStatement',
  'DebuggerStatement',
  'FunctionDeclaration',
  'ClassDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
])

interface Owner {
  node: AstNode
  start: number
  end: number
  parent: Owner | null
  /** The starts of the calls, `new` expressions, tagged templates, `await`s and `yield`s in its own code, in order. */
  effects: number[]
  /** The starts of the identifiers in its own code, by name, in order: the reads a walk may meet. */
  names: Map<string, number[]>
  /** The reads each walk of a variable here ordered, by the variable's scope and name. */
  walks: Map<AstNode | 'global', Map<string, Map<AstNode, Reaching>>>
}

/**
 * The definitions that reach a point of the walk, and `start` for the start value, each with the narrowings its values
 * passed on the way (none for most); `null` past a `return` or `throw`.
 */
type State = Map<Definition | 'start', readonly Narrowing[]> | null

export function definitionsOf(program: AstNode, scope: ScopeRules): Definitions {
  let index: { byKey: Map<AstNode | 'global', Map<string, Definition[]>>; owners: Owner[] } | undefined

  // Each identifier's key, found once: the scope rules don't change while the program is analyzed (§18 step 1).
  const keys = new WeakMap<AstNode, VariableKey | null>()
  const keyOf = (id: AstNode): VariableKey | undefined => {
    let key = keys.get(id)
    if (key === undefined) keys.set(id, (key = keyFound(id) ?? null))
    return key ?? undefined
  }

  const keyFound = (id: AstNode): VariableKey | undefined => {
    let name = id['name'] as string
    let binding
    try {
      binding = scope.resolve(id)
    } catch {
      // A name the seam recorded no reference for.
      return undefined
    }
    if (binding !== 'local') return { scope: 'global', name }
    const declaration = scope.declaration(id)
    if (declaration === undefined) return undefined
    name = scope.nameOf(id)
    // Outside a function declaration, its name is the function, even where a parameter of it shares the name.
    if (declaration.type === 'FunctionDeclaration' && (id.start < declaration.start || id.start >= declaration.end)) {
      const own = declaration['id'] as AstNode | null
      if (own !== null && bindsOwn(declaration, name)) {
        shadowedNames.set(own, declaration)
        return { scope: own, name }
      }
    }
    return { scope: declaration, name }
  }

  function built(): NonNullable<typeof index> {
    if (index !== undefined) return index
    const byKey = new Map<AstNode | 'global', Map<string, Definition[]>>()
    const owners: Owner[] = []
    const open: Owner[] = []
    /** The code whose `this` is open: the program, functions, static blocks and field initializers. */
    const thisCode: AstNode[] = []
    const define = (id: AstNode, definition: Omit<Definition, 'name' | 'owner' | 'topLevel'>) => {
      const key = keyOf(id)
      if (key === undefined) return
      const owner = open.at(-1)!
      let names = byKey.get(key.scope)
      if (names === undefined) byKey.set(key.scope, (names = new Map()))
      let list = names.get(key.name)
      if (list === undefined) names.set(key.name, (list = []))
      const topLevel = thisCode.slice(1).every((code) => code.type === 'ArrowFunctionExpression')
      list.push({ ...definition, name: key.name, owner: owner.node, topLevel })
    }
    walkTree(program, {
      enter(node, parent) {
        const field =
          parent !== null &&
          (parent.type === 'PropertyDefinition' || parent.type === 'AccessorProperty') &&
          parent['value'] === node
        if (node.type === 'Program' || functionTypes.has(node.type) || node.type === 'StaticBlock' || field) {
          thisCode.push(node)
        }
        // A static block or static field initializer runs when its class is evaluated: its code is its function's.
        if (node.type === 'Program' || functionTypes.has(node.type) || (field && parent!['static'] !== true)) {
          const owner: Owner = {
            node,
            start: node.start,
            end: node.end,
            parent: open.at(-1) ?? null,
            effects: [],
            names: new Map(),
            walks: new Map(),
          }
          owners.push(owner)
          open.push(owner)
        }
        if (runsCode.has(node.type)) open.at(-1)!.effects.push(node.start)
        if (node.type === 'Identifier') {
          const { names } = open.at(-1)!
          const name = node['name'] as string
          const starts = names.get(name)
          if (starts === undefined) names.set(name, [node.start])
          else starts.push(node.start)
        }
        switch (node.type) {
          case 'VariableDeclarator': {
            const init = node['init'] as AstNode | null
            if (init === null) break
            const pattern = node['id'] as AstNode
            for (const id of identifiersOf(pattern)) define(id, { site: node, pattern, source: init, logical: false })
            break
          }
          case 'AssignmentExpression': {
            const left = node['left'] as AstNode
            const operator = node['operator'] as string
            const right = node['right'] as AstNode
            const logical = operator === '||=' || operator === '&&=' || operator === '??='
            const source = operator === '=' || logical ? { source: right } : {}
            const operation = compoundOf(node)
            const compound = operation === undefined ? {} : { compound: operation }
            if (left.type === 'Identifier') define(left, { site: node, pattern: left, ...source, ...compound, logical })
            else if (left.type === 'ObjectPattern' || left.type === 'ArrayPattern') {
              for (const id of identifiersOf(left)) define(id, { site: node, pattern: left, source: right, logical: false })
            }
            break
          }
          case 'UpdateExpression': {
            const argument = node['argument'] as AstNode
            if (argument.type === 'Identifier') define(argument, { site: node, pattern: argument, logical: false })
            break
          }
          case 'ForInStatement':
          case 'ForOfStatement': {
            const left = node['left'] as AstNode
            const patterns =
              left.type === 'VariableDeclaration'
                ? (left['declarations'] as AstNode[]).map((declarator) => declarator['id'] as AstNode)
                : [left]
            for (const pattern of patterns) {
              for (const id of identifiersOf(pattern)) define(id, { site: node, pattern: id, logical: false })
            }
            break
          }
        }
      },
      leave(node) {
        if (open.at(-1)?.node === node) open.pop()
        if (thisCode.at(-1) === node) thisCode.pop()
      },
    })
    return (index = { byKey, owners })
  }

  const of = (key: VariableKey): readonly Definition[] => built().byKey.get(key.scope)?.get(key.name) ?? []

  /** The innermost owner whose own code holds `node`, other than `node` itself. */
  function ownerOf(node: AstNode): Owner {
    const { owners } = built()
    let low = 0
    let high = owners.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (owners[middle]!.start <= node.start) low = middle
      else high = middle - 1
    }
    let owner: Owner | null = owners[low]!
    while (owner !== null && !(owner.node !== node && owner.start <= node.start && node.end <= owner.end)) {
      owner = owner.parent
    }
    return owner ?? owners[0]!
  }

  /** Whether a variable is declared in the own scope of `owner`, so it starts with its start value there. */
  function declaredIn(key: VariableKey, owner: Owner): boolean {
    if (key.scope === 'global') return owner.parent === null
    // A shadowed function name (`shadowedNameOf`) is declared around its function.
    const named = shadowedNameOf(key.scope)
    if (named !== undefined) return ownerOf(named).node === owner.node
    const declaration = key.scope
    if (functionTypes.has(declaration.type)) {
      // A function declares its parameters and `arguments` in itself, and its name around it (or in itself, for a
      // function expression's name).
      const params = (declaration['params'] as AstNode[]).flatMap(boundNames)
      const own = params.includes(key.name) || key.name === 'arguments' || declaration.type === 'FunctionExpression'
      if (own) return declaration === owner.node
    }
    return ownerOf(declaration).node === owner.node
  }

  function reaching(id: AstNode, key: VariableKey): Reaching {
    const owner = ownerOf(id)
    let byName = owner.walks.get(key.scope)
    if (byName === undefined) owner.walks.set(key.scope, (byName = new Map()))
    let reads = byName.get(key.name)
    if (reads === undefined) byName.set(key.name, (reads = walked(owner, key)))
    return reads.get(id) ?? unorderedOf(of(key), isParameter(key))
  }

  /**
   * What a read the walk can't order sees: the values the code assigns, or the start value when it assigns none. A
   * parameter's start value is its argument, which it holds until the code assigns it, so that is seen too: a once-flag
   * over a factory, `e => () => { if (e) { var n = e; e = 0; n() } }` (webpack's `.cw`, §6), reads its argument.
   */
  const unorderedOf = (all: readonly Definition[], parameter = false): Reaching =>
    all.length === 0 || parameter ? { start: true, definitions: all, ordered: false } : { start: false, definitions: all, ordered: false }

  /** Whether a variable is a function's parameter. */
  const isParameter = (key: VariableKey): boolean =>
    key.scope !== 'global' &&
    functionTypes.has(key.scope.type) &&
    (key.scope['params'] as AstNode[]).flatMap(boundNames).includes(key.name)

  /**
   * Walks the own code of `owner` once for the variable `key`, and gives the definitions that reach each read of it the
   * walk orders.
   */
  function walked(owner: Owner, key: VariableKey): Map<AstNode, Reaching> {
    const readsOrdered = new Map<AstNode, Reaching>()
    const all = of(key)
    const unordered = unorderedOf(all, isParameter(key))
    const own = all.filter((definition) => definition.owner === owner.node)
    const foreign = all.filter((definition) => definition.owner !== owner.node)
    const ownAt = new Map(own.map((definition) => [definition.site, definition]))
    const entry: State = new Map<Definition | 'start', readonly Narrowing[]>(
      (declaredIn(key, owner) || (unordered.start && all.length === 0) ? ['start' as const] : unordered.start ? ['start' as const, ...all] : all).map(
        (item) => [item, []],
      ),
    )
    const candidates = owner.names.get(key.name) ?? []

    /** Whether any of `list` (sorted starts) lies in `node`. */
    const within = (list: readonly number[], node: AstNode): boolean => {
      let low = 0
      let high = list.length
      while (low < high) {
        const middle = (low + high) >> 1
        if (list[middle]! < node.start) low = middle + 1
        else high = middle
      }
      return low < list.length && list[low]! < node.end
    }
    /** Where the walk must look: the reads it may meet and the own definitions, in order. */
    const interesting = [...candidates, ...own.map((definition) => definition.site.start)].sort((a, b) => a - b)
    const effects = foreign.length === 0 ? [] : owner.effects
    /** Whether walking `node` can change what reaches a read other than through a call, or holds a read. */
    const matters = (node: AstNode): boolean => within(interesting, node)
    /** Whether a call, `new`, `await` or `yield` lies in `start`..`end`, where a closure's definitions join. */
    const runsBetween = (start: number, end: number): boolean => within(effects, { start, end } as AstNode)
    /** Passes over code that holds no read and no own definition: only a closure's definitions can join there. */
    const skip = (start: number, end: number) => {
      if (effects.length > 0 && runsBetween(start, end)) add(foreign)
    }

    /**
     * Walks a list of statements or expressions in order, visiting only those that matter, found by binary search, so
     * that one walk costs what its reads and definitions need rather than the length of the list.
     */
    const inOrder = (nodes: readonly AstNode[], visit: (node: AstNode) => void) => {
      let next = 0
      while (next < nodes.length) {
        const from = nodes[next]!
        const at = firstFrom(interesting, from.start)
        const last = nodes.at(-1)!
        if (at === undefined || at >= last.end) {
          skip(from.start, last.end)
          return
        }
        // The node the interesting position is in: the last one that starts at or before it.
        let low = next
        let high = nodes.length - 1
        while (low < high) {
          const middle = (low + high + 1) >> 1
          if (nodes[middle]!.start <= at) low = middle
          else high = middle - 1
        }
        const node = nodes[low]!
        if (low > next) skip(from.start, node.start)
        if (at < node.end) visit(node)
        else skip(node.start, node.end)
        next = low + 1
      }
    }

    let state: State = entry
    const add = (definitions: Iterable<Definition>) => {
      if (state === null) return
      for (const definition of definitions) state.set(definition, [])
    }
    /** Where either path may come from: an item narrowed on both keeps only the narrowings both paths passed. */
    const join = (a: State, b: State): State => {
      if (a === null) return b
      if (b === null) return a
      const out = new Map(a)
      for (const [item, narrowings] of b) {
        const other = out.get(item)
        out.set(item, other === undefined ? narrowings : other.filter((each) => narrowings.includes(each)))
      }
      return out
    }
    const copy = (a: State): State => (a === null ? null : new Map(a))
    /** `a` with every item narrowed by `narrowing` too. */
    const narrow = (a: State, narrowing: Narrowing | undefined): State => {
      if (a === null || narrowing === undefined) return a
      return new Map([...a].map(([item, narrowings]) => [item, [...narrowings, narrowing]]))
    }
    /** Whether every path through `node` that reaches its end assigns the variable in it: no item from before it is left. */
    const assignsIn = (after: State, node: AstNode): after is NonNullable<State> =>
      after !== null &&
      [...after.keys()].every((item) => item !== 'start' && node.start <= item.site.start && item.site.end <= node.end)
    const defineAt = (site: AstNode) => {
      const definition = ownAt.get(site)
      if (definition === undefined || state === null) return
      if (definition.logical) state.set(definition, [])
      else state = new Map([[definition, []]])
    }
    /**
     * What a test of the variable shows where it passes (§5 Resolver capabilities 6): `k`, `!k`, `k == null`,
     * `k === undefined`, `typeof k === "undefined"` and their negations. Any other test shows nothing.
     */
    const tested = (test: AstNode): Narrowing | undefined => {
      if (test.type === 'Identifier') return reads(test) ? 'truthy' : undefined
      if (test.type === 'UnaryExpression' && test['operator'] === '!') {
        const inner = tested(test['argument'] as AstNode)
        return inner === undefined ? undefined : opposite[inner]
      }
      if (test.type !== 'BinaryExpression') return undefined
      const operator = test['operator'] as string
      if (!['==', '!=', '===', '!=='].includes(operator)) return undefined
      const left = test['left'] as AstNode
      const right = test['right'] as AstNode
      const narrowing = comparedTo(left, right, operator.length === 3) ?? comparedTo(right, left, operator.length === 3)
      if (narrowing === undefined) return undefined
      return operator.startsWith('!') ? opposite[narrowing] : narrowing
    }
    /** What `side == other` (or `===`, when `strict`) shows about the variable where it holds. */
    const comparedTo = (side: AstNode, other: AstNode, strict: boolean): Narrowing | undefined => {
      const typeOf = side.type === 'UnaryExpression' && side['operator'] === 'typeof'
      const read = typeOf ? (side['argument'] as AstNode) : side
      if (read.type !== 'Identifier' || !reads(read)) return undefined
      if (typeOf) return other.type === 'Literal' && other['value'] === 'undefined' ? 'undefined' : undefined
      const isNull = other.type === 'Literal' && other['value'] === null && other['raw'] === 'null'
      const isUndefined =
        (other.type === 'Identifier' && other['name'] === 'undefined' && keyOf(other)?.scope === 'global') ||
        (other.type === 'UnaryExpression' && other['operator'] === 'void' && (other['argument'] as AstNode).type === 'Literal')
      if (!strict) return isNull || isUndefined ? 'nullish' : undefined
      return isNull ? 'null' : isUndefined ? 'undefined' : undefined
    }
    /**
     * A lazy init by an `if` or `?:` (§5 Resolver capabilities 6): when one arm assigns the variable on every path that
     * reaches its end, what reaches past the other arm from before the test passed the test that arm is taken on.
     */
    const lazily = (
      test: AstNode,
      consequent: AstNode,
      alternate: AstNode | null,
      taken: State,
      other: State,
      set: (taken: State, other: State) => void,
    ) => {
      const shown = tested(test)
      if (shown === undefined) return
      if (assignsIn(taken, consequent)) set(taken, narrow(other, opposite[shown]))
      else if (alternate !== null && assignsIn(other, alternate)) set(narrow(taken, shown), other)
    }
    /** Whether an identifier reads the variable this walk is for. */
    const reads = (id: AstNode): boolean => {
      const read = keyOf(id)
      return read !== undefined && read.scope === key.scope && read.name === key.name
    }

    function statement(node: AstNode): void {
      if (!matters(node)) {
        skip(node.start, node.end)
        // A `return` or `throw` that holds no read still ends the path it is on.
        if (alwaysExits(node)) state = null
        return
      }
      if (!followed.has(node.type)) {
        // A loop, `try`, `switch` or labelled statement: a read in it falls back to the union, and past it the
        // definitions in it may reach.
        add(own.filter((definition) => node.start <= definition.site.start && definition.site.end <= node.end))
        skip(node.start, node.end)
        return
      }
      switch (node.type) {
        case 'ExpressionStatement':
          expression(node['expression'] as AstNode)
          return
        case 'VariableDeclaration':
          inOrder(node['declarations'] as AstNode[], (declarator) => {
            const init = declarator['init'] as AstNode | null
            if (init !== null) expression(init)
            expression(declarator['id'] as AstNode)
            defineAt(declarator)
          })
          return
        case 'IfStatement': {
          const test = node['test'] as AstNode
          const [whenTrue, whenFalse] = branches(test)
          state = whenTrue
          const consequent = node['consequent'] as AstNode
          statement(consequent)
          let taken = state
          state = whenFalse
          const alternate = node['alternate'] as AstNode | null
          if (alternate !== null) statement(alternate)
          lazily(test, consequent, alternate, taken, state, (a, b) => ((taken = a), (state = b)))
          state = join(taken, state)
          return
        }
        case 'BlockStatement':
          inOrder(node['body'] as AstNode[], statement)
          return
        case 'ReturnStatement':
        case 'ThrowStatement': {
          const argument = node['argument'] as AstNode | null
          if (argument !== null) expression(argument)
          state = null
          return
        }
        case 'ExportNamedDeclaration':
        case 'ExportDefaultDeclaration': {
          const declaration = node['declaration'] as AstNode | null
          if (declaration === null) return
          if (followed.has(declaration.type)) statement(declaration)
          else expression(declaration)
          return
        }
        case 'ClassDeclaration':
          classEvaluation(node)
          return
        default:
          // A function declaration runs no code of its own here.
          return
      }
    }

    /**
     * A class's evaluation (ECMA-262 ClassDefinitionEvaluation): its heritage, its computed keys in order, then its
     * static field initializers and static blocks in order.
     */
    function classEvaluation(node: AstNode): void {
      const heritage = node['superClass'] as AstNode | null
      if (heritage !== null) expression(heritage)
      const elements = (node['body'] as AstNode)['body'] as AstNode[]
      for (const element of elements) {
        if (element['computed'] === true) expression(element['key'] as AstNode)
      }
      for (const element of elements) {
        if (element.type === 'StaticBlock') inOrder(element['body'] as AstNode[], statement)
        else if (element['static'] === true && element.type !== 'MethodDefinition') {
          const value = element['value'] as AstNode | null
          if (value !== null) expression(value)
        }
      }
    }

    function expression(node: AstNode): void {
      if (!matters(node)) {
        skip(node.start, node.end)
        return
      }
      if (node.type === 'Identifier') {
        const read = keyOf(node)
        if (state !== null && read !== undefined && read.scope === key.scope && read.name === key.name) {
          const definitions = [...state.keys()].filter((each): each is Definition => each !== 'start')
          const narrowed = new Map([...state].filter(([, narrowings]) => narrowings.length > 0))
          readsOrdered.set(node, {
            start: state.has('start'),
            definitions,
            ordered: true,
            ...(narrowed.size === 0 ? {} : { narrowed }),
          })
        }
        return
      }
      switch (node.type) {
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
          return
        case 'ClassExpression':
          classEvaluation(node)
          return
        case 'SequenceExpression':
          inOrder(node['expressions'] as AstNode[], expression)
          return
        case 'AssignmentExpression': {
          const left = node['left'] as AstNode
          if (left.type === 'Identifier') {
            // A compound assignment reads its variable before its right side (ECMA-262 13.15.2).
            if (compoundOperator(node['operator'] as string)) expression(left)
            expression(node['right'] as AstNode)
          } else if (left.type === 'ObjectPattern' || left.type === 'ArrayPattern') {
            expression(node['right'] as AstNode)
            expression(left)
          } else {
            expression(left)
            expression(node['right'] as AstNode)
          }
          const operator = node['operator'] as string
          if (operator === '||=' || operator === '&&=' || operator === '??=') {
            const before = copy(state)
            // `k ||= …` is a lazy init of `k`: where it assigns, `k` holds what it assigns, and elsewhere only the entry
            // values that skip the assignment.
            const definition = left.type === 'Identifier' && reads(left) ? ownAt.get(node) : undefined
            if (definition === undefined || state === null) {
              defineAt(node)
              state = join(before, state)
            } else {
              const skipped = operator === '||=' ? 'truthy' : operator === '&&=' ? 'falsy' : 'notNullish'
              state = join(narrow(before, skipped), new Map([[definition, []]]))
            }
          } else defineAt(node)
          return
        }
        case 'UpdateExpression':
          defineAt(node)
          return
        case 'ConditionalExpression': {
          const test = node['test'] as AstNode
          const [whenTrue, whenFalse] = branches(test)
          state = whenTrue
          const consequent = node['consequent'] as AstNode
          expression(consequent)
          let taken = state
          state = whenFalse
          const alternate = node['alternate'] as AstNode
          expression(alternate)
          lazily(test, consequent, alternate, taken, state, (a, b) => ((taken = a), (state = b)))
          state = join(taken, state)
          return
        }
        case 'LogicalExpression': {
          const left = node['left'] as AstNode
          expression(left)
          let before = copy(state)
          const right = node['right'] as AstNode
          expression(right)
          // A lazy init (`k || (k = …)`): past it, the entry values that skipped the assignment passed the test.
          if (assignsIn(state, right)) {
            const operator = node['operator'] as string
            const shown = tested(left)
            const skipped =
              operator === '||'
                ? shown
                : operator === '&&'
                  ? shown === undefined
                    ? undefined
                    : opposite[shown]
                  : left.type === 'Identifier' && reads(left)
                    ? 'notNullish'
                    : undefined
            before = narrow(before, skipped)
          }
          state = join(before, state)
          return
        }
        default:
          children(node)
          if (runsCode.has(node.type) && foreign.length > 0) add(foreign)
      }
    }

    /**
     * Walks a test, and gives what reaches the code it lets through when it is true and when it is false (ECMA-262
     * 13.13.1): `a && b` is true only where `b` ran and was true, so a definition in every operand reaches the arm it
     * guards, and `a || b` is false only where `b` ran and was false. `!` swaps the two. Any other test gives what
     * reaches past it for both.
     */
    function branches(test: AstNode): [State, State] {
      if (matters(test) && test.type === 'UnaryExpression' && test['operator'] === '!') {
        const [whenTrue, whenFalse] = branches(test['argument'] as AstNode)
        return [whenFalse, whenTrue]
      }
      const operator = test['operator'] as string
      if (!matters(test) || test.type !== 'LogicalExpression' || (operator !== '&&' && operator !== '||')) {
        expression(test)
        return [state, copy(state)]
      }
      const left = test['left'] as AstNode
      const right = test['right'] as AstNode
      const [leftTrue, leftFalse] = branches(left)
      const and = operator === '&&'
      // The right side runs only where the left lets it through; elsewhere the left decides the test.
      let decided = and ? leftFalse : leftTrue
      state = and ? leftTrue : leftFalse
      const [rightTrue, rightFalse] = branches(right)
      // A lazy init in the right side (`k || (k = …)`): where the left decided, the entry values passed its test.
      if (assignsIn(join(copy(rightTrue), rightFalse), right)) {
        const shown = tested(left)
        decided = narrow(decided, and ? (shown === undefined ? undefined : opposite[shown]) : shown)
      }
      return and ? [rightTrue, join(decided, rightFalse)] : [join(decided, rightTrue), rightFalse]
    }

    /** A node's children, in the order of its visitor keys, which is the order they are evaluated in. */
    function children(node: AstNode): void {
      const nodes: AstNode[] = []
      walkTree(node, {
        enter(child) {
          if (child === node) return
          nodes.push(child)
          return false
        },
      })
      for (const child of nodes) expression(child)
    }

    const body = owner.node['body'] as AstNode | AstNode[] | undefined
    if (owner.node.type === 'Program') {
      inOrder(body as AstNode[], statement)
    } else if (functionTypes.has(owner.node.type)) {
      const block = body as AstNode
      if (block.type === 'BlockStatement') statement(block)
      else expression(block)
    } else expression(owner.node)
    return readsOrdered
  }

  return { keyOf, of, reaching }
}

/** The first of `list` (sorted) at or after `start`. */
function firstFrom(list: readonly number[], start: number): number | undefined {
  let low = 0
  let high = list.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (list[middle]! < start) low = middle + 1
    else high = middle
  }
  return list[low]
}

/** The identifiers a binding or assignment pattern binds, in source order. */
export function identifiersOf(pattern: AstNode): AstNode[] {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern]
    case 'ObjectPattern':
      return (pattern['properties'] as AstNode[]).flatMap((property) =>
        identifiersOf((property.type === 'RestElement' ? property['argument'] : property['value']) as AstNode),
      )
    case 'ArrayPattern':
      return (pattern['elements'] as (AstNode | null)[]).flatMap((element) => (element === null ? [] : identifiersOf(element)))
    case 'AssignmentPattern':
      return identifiersOf(pattern['left'] as AstNode)
    case 'RestElement':
      return identifiersOf(pattern['argument'] as AstNode)
    default:
      return []
  }
}

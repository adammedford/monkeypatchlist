// Module links inside one artifact (§6, ADR 0003): the webpack shapes of the module-linking idioms, and, in
// `hoistedLinks` below, the shapes esbuild, Rollup and Rolldown emit (memoized getters, lazy module thunks, their getter
// export definers and interop wrappers).
//
// - **Factory table + require**: an object or array literal of factories keyed by constant id (webpack 5 object
//   tables, webpack 4-style arrays), read by a require function, a function whose own code calls `T[id](…)` or
//   `T[id].call(…)` with its first parameter as the key and passes itself on. The require is that function, and the
//   parameter each factory takes it as (its third).
// - **Getter export definer**: `R.d(exports, { x: () => l })`, its array form `R.d(exports, ["x", () => l, "y", 0, v])`
//   (a `0` marks a value), and the older `R.d(exports, "x", () => l)`, where `R` is the require.
// - **Interop wrappers**: `R.n(m)` and `R.cw(factory)`. `R.cw`'s thunk is also a lazy module thunk, which `hoistedLinks`
//   recognizes by its shape (below), so each `var x = R.cw(factory)` is a module.
//
// Links are recovered from structure, never from knowing which bundler produced the code. The require and the table are
// followed by the evaluator's general call and heap semantics: a require call runs its factory through the table's
// computed read. The definer is modeled here: each of its calls defines its exports' fields, getters or values, and
// the defines the definer's own body makes are left to the model. What comes through a definer's export carries a
// `module-link` fold (§14), with its module's id and the export's name. Module ids are build-local, so they appear only
// in the trace, never in identity (§6).
//
// A require call whose id isn't a constant, or names no factory in the table, is a broken link (§6 Degradation). A call
// through what a broken link returns (`R(id)(…)`, `R(id).x(…)`, `m.x(…)` with `m = R(id)`) is an unlinked module call.
// An unrecognized runtime looks like ordinary code, and gives nothing here.

import { calleeExpression, walkTree, type AstNode } from './ast.ts'
import { shadowedNameOf, type Definitions, type VariableKey } from './definitions.ts'
import { registriesOf } from './chunk-registry.ts'
import { literalKey } from './keys.ts'

/** The idioms R1 promises to link (§6), as the report names them. */
export type Idiom = 'chunk-loader' | 'factory-table' | 'getter-export' | 'interop' | 'lazy-thunk' | 'memoized-getter'

/** Where a value came through a module link: the idiom, the module's id, and the export's name. */
export interface ModuleLink {
  idiom: Exclude<Idiom, 'chunk-loader'>
  module: string
  export?: string
}

/**
 * A field of a module's exports the definer defines (above): its getter, an expression whose value is the getter
 * function, or its value. `site` is the definer's call, `object` the exports expression, and `node` the expression
 * that gives the field.
 */
export interface ExportDefine {
  site: AstNode
  object: AstNode
  key: string
  getter?: AstNode
  value?: AstNode
  /** The module the define is in, with the export's name, when the define is in a factory. */
  link?: ModuleLink
}

/**
 * A broken link: a require call whose id isn't a constant, or names no factory, or an import whose module isn't in the
 * link group (§6 Degradation), whose `call` is its import declaration.
 */
export interface BrokenLink {
  call: AstNode
  why: 'non-constant' | 'missing' | 'import'
}

/**
 * A lazy module thunk's call of its factory: the module object literal it makes (`{ exports: {} }`), and the index of
 * the factory's parameter that takes that object. An init-only thunk (`__esm`) makes none.
 */
export interface FactoryCall {
  object?: AstNode
  module?: number
}

export interface ModuleLinks {
  /** The idioms the artifact uses. */
  idioms: ReadonlySet<Idiom>
  /**
   * Whether the artifact links modules through a factory table's idioms, whose exports are all read through calls the
   * syntax names no function for, and computed heap reads: there the evaluator follows calls and heap reads further.
   */
  tables: boolean
  /** How many factories the artifact's tables hold. */
  modules: number
  /** The definer's calls' defines, in document order. */
  defines: readonly ExportDefine[]
  /** The definer functions, whose own defines the model stands for. */
  definers: ReadonlySet<AstNode>
  /** The require calls that link, each with the module it links. */
  links: ReadonlyMap<AstNode, ModuleLink>
  /**
   * Each require function's linked modules, each with its first require call in document order, which stands for every
   * require of it by that require function. Keyed by require first, since two runtimes in one artifact may reuse ids.
   */
  firsts: ReadonlyMap<AstNode, ReadonlyMap<string, AstNode>>
  /**
   * Each factory in a table: its module's id, the require function that runs it, and the require's call of the table
   * (`t[r](…)`, `e[r].call(…)`) that runs it.
   */
  factories: ReadonlyMap<AstNode, { module: string; require: AstNode; call: AstNode }>
  /** The broken links. */
  broken: readonly BrokenLink[]
  /** The calls through what a broken link returns, each with the broken link. */
  unlinkedCalls: ReadonlyMap<AstNode, BrokenLink>
  /**
   * The calls that run a module and give its exports, other than a require's: a lazy module thunk's or a memoized
   * getter's call (`require_x()`, `requireX()`), and an interop wrapper's call over one (`__toESM(require_x())`), each
   * with the module it links.
   */
  moduleCalls: ReadonlyMap<AstNode, ModuleLink>
  /**
   * The interop wrappers' calls that make a namespace object of a CommonJS module (`__toESM(m)`), each with the
   * expression whose value is the module's exports: the namespace's `default` is that value, and its other keys are
   * that value's own.
   */
  namespaces: ReadonlyMap<AstNode, AstNode>
  /**
   * The lazy module thunks' calls of their factories (`cb(…)`, `r.call(…)` in a thunk), which read only what the thunk
   * closes over, each with the module object the thunk makes, if any.
   */
  factoryCalls: ReadonlyMap<AstNode, FactoryCall>
  /** The thunk makers' calls that make a module (`maker(factory)`, `R.cw(factory)`), each with its thunk maker. */
  makes: ReadonlyMap<AstNode, AstNode>
  /**
   * The factories chunks push into a chunk registry that a loader of the program reads (§6 idiom 6), by the literal of
   * the table its require reads and module id: the table holds them as well as its own. Several chunks can push the same
   * id, and each is an alternative (Principle 3).
   */
  chunkFactories: ReadonlyMap<AstNode, ReadonlyMap<string, readonly AstNode[]>>
  /**
   * The callbacks chunks push with their factories, each with its push: the loader calls one with its require where the
   * chunk pushes it (§6 idiom 6), which starts the chunk's entry modules.
   */
  pushCallbacks: ReadonlyMap<AstNode, AstNode>
  /**
   * The require calls a pushed callback makes through its require parameter, which start a chunk's entry modules
   * (`t => t(t.s = 4429)`), each with the require function: each is a resolved call of its module's factory.
   */
  starts: ReadonlyMap<AstNode, AstNode>
  /** The constant names of the chunk registries the program reads or pushes into, each a known non-native array (§6). */
  registries: ReadonlySet<string>
  /** For the report alone: how many factories the program's own chunk pushes hold, and whether it has a loader. */
  pushed: number
  loader: boolean
}

const none: ModuleLinks = {
  idioms: new Set(),
  tables: false,
  modules: 0,
  defines: [],
  definers: new Set(),
  links: new Map(),
  firsts: new Map(),
  factories: new Map(),
  broken: [],
  unlinkedCalls: new Map(),
  moduleCalls: new Map(),
  namespaces: new Map(),
  factoryCalls: new Map(),
  makes: new Map(),
  chunkFactories: new Map(),
  pushCallbacks: new Map(),
  starts: new Map(),
  registries: new Set(),
  pushed: 0,
  loader: false,
}

/** A factory table: its literal, and its factories by id. */
interface Table {
  literal: AstNode
  factories: Map<string, AstNode>
  /** The require's call of the table, once a require reads it. */
  call?: AstNode
}

const functionTypes: ReadonlySet<string> = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const isFunction = (node: AstNode): boolean => functionTypes.has(node.type)

const sameKey = (a: VariableKey | undefined, b: VariableKey | undefined): boolean =>
  a !== undefined && b !== undefined && a.scope === b.scope && a.name === b.name

/** The module-linking idioms of a program (above). */
export function moduleLinks(program: AstNode, definitions: Definitions): ModuleLinks {
  const tables = tableLinks(program, definitions)
  const hoisted = hoistedLinks(program, definitions)
  if (hoisted.idioms.size === 0) return tables
  return {
    ...tables,
    idioms: new Set([...tables.idioms, ...hoisted.idioms]),
    modules: tables.modules + hoisted.modules,
    defines: [...tables.defines, ...hoisted.defines].sort((a, b) => a.site.start - b.site.start),
    definers: new Set([...tables.definers, ...hoisted.definers]),
    moduleCalls: hoisted.moduleCalls,
    namespaces: hoisted.namespaces,
    factoryCalls: hoisted.factoryCalls,
    makes: hoisted.makes,
  }
}

/** The factory tables' idioms: a table and its require, the require's definer, and its interop wrappers (above). */
function tableLinks(program: AstNode, definitions: Definitions): ModuleLinks {
  const parents = new Map<AstNode, AstNode>()
  const functions: AstNode[] = []
  walkTree(program, {
    enter(node, parent) {
      if (parent !== null) parents.set(node, parent)
      if (isFunction(node)) functions.push(node)
    },
  })

  // The chunk registries (§6 idiom 6): what the program pushes into them, and its loaders' reads of them. A loader's
  // table can start empty, as a runtime chunk's does (`var e = {}`): its chunks push all its factories.
  const { pushes, loads } = registriesOf(program)
  const empty = loads.length > 0

  // The require functions, each with its table.
  const requires: { fn: AstNode; key: VariableKey; table: Table }[] = []
  for (const fn of functions) {
    if (fn.type !== 'FunctionDeclaration') continue
    const id = fn['id'] as AstNode | null
    const [param] = fn['params'] as AstNode[]
    if (id === null || param?.type !== 'Identifier') continue
    const table = tableRead(fn, param['name'] as string, id['name'] as string)
    if (table === undefined) continue
    const key = referenceKey(fn, id['name'] as string)
    if (key !== undefined) requires.push({ fn, key, table })
  }
  const registry = {
    registries: new Set([...pushes.map((push) => push.registry), ...loads.map((load) => load.registry)]),
    pushed: pushes.reduce((sum, push) => sum + push.factories.length, 0),
    loader: loads.length > 0,
  }
  if (requires.length === 0) {
    // A `.cw` wrapper with no table, over a concatenated CommonJS module: `r.cw(function (t, e) { … })`.
    const idioms = new Set<Idiom>(wraps() ? ['interop'] : [])
    if (registry.loader) idioms.add('chunk-loader')
    return { ...none, ...registry, idioms, tables: idioms.has('interop') }
  }

  // Each factory's module id, and the key its require parameter has.
  const factoryIds = new Map<AstNode, string>()
  const factories = new Map<AstNode, { module: string; require: AstNode; call: AstNode }>()
  const requireKeys: { key: VariableKey; fn: AstNode; table: Table; callback?: true }[] = requires.map(({ fn, key, table }) => ({
    key,
    fn,
    table,
  }))
  let modules = 0
  for (const { fn, table } of requires) {
    for (const [id, factory] of table.factories) {
      modules++
      factoryIds.set(factory, id)
      factories.set(factory, { module: id, require: fn, call: table.call! })
      const param = (factory['params'] as AstNode[])[2]
      if (param?.type !== 'Identifier') continue
      const key = referenceKey(factory, param['name'] as string)
      if (key !== undefined) requireKeys.push({ key, fn, table })
    }
  }
  // The factories chunks push into a registry a loader reads, joined to the table of the require around the loader: the
  // innermost require whose enclosing code holds the loader's read of the registry.
  const chunkFactories = new Map<AstNode, Map<string, AstNode[]>>()
  const pushCallbacks = new Map<AstNode, AstNode>()
  const chunked = new Map<Table, Map<string, AstNode[]>>()
  for (const push of pushes) {
    const load = loads.find((each) => each.registry === push.registry)
    if (load === undefined) continue
    let found: { fn: AstNode; table: Table; owner: AstNode } | undefined
    for (const { fn, table } of requires) {
      let owner: AstNode = program
      for (let at = parents.get(fn); at !== undefined; at = parents.get(at)) {
        if (isFunction(at)) {
          owner = at
          break
        }
      }
      if (owner.start > load.read.start || load.read.end > owner.end) continue
      if (found === undefined || owner.start > found.owner.start) found = { fn, table, owner }
    }
    if (found === undefined) continue
    let byId = chunked.get(found.table)
    if (byId === undefined) {
      chunked.set(found.table, (byId = new Map()))
      chunkFactories.set(found.table.literal, byId)
    }
    // The callback's first parameter is the require: `t => t(t.s = 4429)`.
    const callback = push.callback
    const first = callback === undefined ? undefined : (callback['params'] as AstNode[])[0]
    if (callback !== undefined && first?.type === 'Identifier') {
      pushCallbacks.set(callback, push.call)
      const key = referenceKey(callback, first['name'] as string)
      if (key !== undefined) requireKeys.push({ key, fn: found.fn, table: found.table, callback: true })
    }
    for (const { id, factory } of push.factories) {
      const list = byId.get(id)
      if (list === undefined) byId.set(id, [factory])
      else list.push(factory)
      factoryIds.set(factory, id)
      factories.set(factory, { module: id, require: found.fn, call: found.table.call! })
      const param = (factory['params'] as AstNode[])[2]
      if (param?.type !== 'Identifier') continue
      const key = referenceKey(factory, param['name'] as string)
      if (key !== undefined) requireKeys.push({ key, fn: found.fn, table: found.table })
    }
  }
  /** Whether a require's table, or a chunk pushed into it, has a factory of module `id`. */
  const linksTo = (table: Table, id: string): boolean => table.factories.has(id) || (chunked.get(table)?.has(id) ?? false)

  /** The require function a name is, with its table. */
  const requireOf = (node: AstNode): { fn: AstNode; table: Table; callback?: true } | undefined => {
    if (node.type !== 'Identifier') return undefined
    const key = definitions.keyOf(node)
    return requireKeys.find((each) => sameKey(each.key, key))
  }
  /** The module a node is in: the id of the factory around it. */
  const moduleOf = (node: AstNode): string | undefined => {
    for (let at: AstNode | undefined = node; at !== undefined; at = parents.get(at)) {
      const id = factoryIds.get(at)
      if (id !== undefined) return id
    }
    return undefined
  }

  const idioms = new Set<Idiom>()
  const defines: ExportDefine[] = []
  const definers = new Set<AstNode>()
  const links = new Map<AstNode, ModuleLink>()
  const firsts = new Map<AstNode, Map<string, AstNode>>()
  const broken: BrokenLink[] = []
  const brokenCalls = new Map<AstNode, BrokenLink>()
  const brokenBinds = new Map<AstNode, BrokenLink>()
  const starts = new Map<AstNode, AstNode>()
  walkTree(program, {
    enter(node) {
      if (node.type === 'AssignmentExpression' && node['operator'] === '=') {
        // The definer: `R.d = function…`.
        const left = node['left'] as AstNode
        const right = node['right'] as AstNode
        if (member(left, 'd') && requireOf(left['object'] as AstNode) !== undefined && isFunction(right)) definers.add(right)
        return
      }
      if (node.type !== 'CallExpression') return
      const callee = calleeExpression(node['callee'] as AstNode)
      const args = node['arguments'] as AstNode[]
      const require = requireOf(callee)
      if (require !== undefined) {
        const { fn, table } = require
        // A require call.
        // webpack 4's entry passes its id through an assignment: `n(n.s = 5)`.
        let [arg] = args
        while (arg?.type === 'AssignmentExpression' && arg['operator'] === '=') arg = arg['right'] as AstNode
        const id = arg === undefined ? undefined : literalKey(arg)
        if (id === undefined) {
          const link: BrokenLink = { call: node, why: 'non-constant' }
          broken.push(link)
          brokenCalls.set(node, link)
        } else if (!linksTo(table, id)) {
          const link: BrokenLink = { call: node, why: 'missing' }
          broken.push(link)
          brokenCalls.set(node, link)
        } else {
          idioms.add('factory-table')
          links.set(node, { idiom: 'factory-table', module: id })
          if (require.callback === true) starts.set(node, fn)
          let own = firsts.get(fn)
          if (own === undefined) firsts.set(fn, (own = new Map()))
          if (!own.has(id)) own.set(id, node)
        }
        return
      }
      if (callee.type !== 'MemberExpression' || requireOf(callee['object'] as AstNode) === undefined) return
      // A require bound to a module's id, which a loader's promise runs: `n.bind(n, 6954)`.
      if (member(callee, 'bind') && args.length === 2) {
        const id = literalKey(args[1]!)
        const { table } = requireOf(callee['object'] as AstNode)!
        if (id === undefined || !linksTo(table, id)) {
          const link: BrokenLink = { call: node, why: id === undefined ? 'non-constant' : 'missing' }
          broken.push(link)
          brokenBinds.set(node, link)
        }
        return
      }
      if (member(callee, 'n') || member(callee, 'cw')) {
        idioms.add('interop')
        return
      }
      if (!member(callee, 'd') || args.some((arg) => arg.type === 'SpreadElement')) return
      const [object, list, getter] = args
      if (object === undefined || list === undefined) return
      const module = moduleOf(node)
      const add = (key: string | undefined, part: { getter: AstNode } | { value: AstNode }) => {
        if (key === undefined) return
        idioms.add('getter-export')
        const link: ModuleLink | undefined = module === undefined ? undefined : { idiom: 'getter-export', module, export: key }
        defines.push({ site: node, object, key, ...part, ...(link === undefined ? {} : { link }) })
      }
      if (list.type === 'ObjectExpression') {
        for (const property of list['properties'] as AstNode[]) {
          if (property.type !== 'Property' || property['kind'] !== 'init') continue
          const key = property['key'] as AstNode
          const name = property['computed'] === true ? literalKey(key) : key.type === 'Identifier' ? (key['name'] as string) : literalKey(key)
          add(name, { getter: property['value'] as AstNode })
        }
      } else if (list.type === 'ArrayExpression') {
        const elements = list['elements'] as (AstNode | null)[]
        for (let at = 0; at + 1 < elements.length; ) {
          const name = elements[at] === null ? undefined : literalKey(elements[at]!)
          const second = elements[at + 1]
          if (name === undefined || second === null || second === undefined || second.type === 'SpreadElement') break
          if (second.type === 'Literal' && second['value'] === 0) {
            const value = elements[at + 2]
            if (value === null || value === undefined || value.type === 'SpreadElement') break
            add(name, { value })
            at += 3
          } else {
            add(name, { getter: second })
            at += 2
          }
        }
      } else if (getter !== undefined && getter.type !== 'SpreadElement') {
        add(literalKey(list), { getter })
      }
    },
  })

  // The calls through what a broken link returns.
  const unlinkedCalls = new Map<AstNode, BrokenLink>()
  if (brokenCalls.size > 0 || brokenBinds.size > 0) {
    // What a broken link gives flows through a loader's promise (§6 idiom 6): `n.e(5).then(n.bind(n, 6954))` and
    // `n.e(5).then(() => n(6954))` are promises of the module, which `.then(m => …)` passes on as `m`, and `await`
    // unwraps.
    const promised = new Map<AstNode, BrokenLink>()
    // The identifiers whose definitions are being followed. Declared before the first walk, which follows them too.
    const following = new Set<AstNode>()
    walkTree(program, {
      enter(node) {
        if (node.type !== 'CallExpression') return
        const callee = calleeExpression(node['callee'] as AstNode)
        const [handler] = node['arguments'] as AstNode[]
        if (!member(callee, 'then') || handler === undefined) return
        const link = brokenFunction(handler)
        if (link !== undefined) promised.set(node, link)
      },
    })
    /** The broken link a promise is of. */
    function brokenPromise(node: AstNode): BrokenLink | undefined {
      const found = promised.get(node)
      if (found !== undefined) return found
      if (node.type !== 'Identifier') return undefined
      return defined(node, brokenPromise)
    }
    /** The broken link a function gives: a bound require, or a function that returns a broken module. */
    function brokenFunction(node: AstNode): BrokenLink | undefined {
      const bound = brokenBinds.get(node)
      if (bound !== undefined) return bound
      if (node.type !== 'ArrowFunctionExpression' || node['expression'] !== true) return undefined
      return brokenValue(node['body'] as AstNode)
    }
    /** The broken link whose module a value is. */
    function brokenValue(node: AstNode): BrokenLink | undefined {
      const found = brokenCalls.get(node)
      if (found !== undefined) return found
      if (node.type === 'AwaitExpression') return brokenPromise(node['argument'] as AstNode)
      if (node.type !== 'Identifier') return undefined
      const key = definitions.keyOf(node)
      if (key === undefined) return undefined
      // A parameter of a handler that a broken module's promise passes it to: `.then(m => …)`.
      const fn = key.scope === 'global' ? undefined : key.scope
      if (fn !== undefined && isFunction(fn)) {
        const [first] = fn['params'] as AstNode[]
        const call = parents.get(fn)
        if (first?.type === 'Identifier' && first['name'] === key.name && call?.type === 'CallExpression') {
          const callee = calleeExpression(call['callee'] as AstNode)
          if ((call['arguments'] as AstNode[])[0] === fn && member(callee, 'then')) {
            const link = brokenPromise(callee['object'] as AstNode)
            if (link !== undefined) return link
          }
        }
      }
      return defined(node, brokenValue)
    }
    /** The broken link of the value an identifier's definitions give, as `of` finds it. */
    function defined(id: AstNode, of: (node: AstNode) => BrokenLink | undefined): BrokenLink | undefined {
      const key = definitions.keyOf(id)
      // A variable defined through itself gives nothing more.
      if (key === undefined || following.has(id)) return undefined
      following.add(id)
      try {
        for (const definition of definitions.of(key)) {
          const source = definition.source
          if (source !== undefined && definition.pattern.type === 'Identifier') {
            const link = of(source)
            if (link !== undefined) return link
          }
        }
        return undefined
      } finally {
        following.delete(id)
      }
    }
    walkTree(program, {
      enter(node) {
        if (node.type !== 'CallExpression') return
        let callee = calleeExpression(node['callee'] as AstNode)
        if (callee.type === 'MemberExpression') callee = callee['object'] as AstNode
        const link = brokenValue(callee)
        if (link !== undefined && link.call !== node) unlinkedCalls.set(node, link)
      },
    })
  }

  const tables = idioms.size > 0
  if (registry.loader) idioms.add('chunk-loader')
  return {
    ...none,
    ...registry,
    idioms,
    tables,
    modules,
    defines,
    definers,
    links,
    firsts,
    factories,
    broken,
    unlinkedCalls,
    chunkFactories,
    pushCallbacks,
    starts,
  }

  /** Whether the program calls a `.cw` wrapper on a CommonJS factory: `x.cw(function (t, e) { … })`. */
  function wraps(): boolean {
    let found = false
    walkTree(program, {
      enter(node) {
        if (found) return false
        if (node.type !== 'CallExpression') return undefined
        const [factory, ...rest] = node['arguments'] as AstNode[]
        if (!member(calleeExpression(node['callee'] as AstNode), 'cw') || rest.length > 0 || factory === undefined) return undefined
        found = isFunction(factory) && (factory['params'] as AstNode[]).length >= 1
        return undefined
      },
    })
    return found
  }

  /**
   * The table a function reads with its parameter `param` as the key in a call that passes the function `self` on:
   * `T[param](…, self)` or `T[param].call(…, self)`.
   */
  function tableRead(fn: AstNode, param: string, self: string): Table | undefined {
    let found: Table | undefined
    walkTree(fn['body'] as AstNode, {
      enter(node) {
        if (found !== undefined || isFunction(node)) return false
        if (node.type !== 'CallExpression') return undefined
        const args = node['arguments'] as AstNode[]
        if (!args.some((arg) => arg.type === 'Identifier' && arg['name'] === self)) return undefined
        let callee = node['callee'] as AstNode
        if (member(callee, 'call')) callee = callee['object'] as AstNode
        if (callee.type !== 'MemberExpression' || callee['computed'] !== true) return undefined
        const key = callee['property'] as AstNode
        const object = callee['object'] as AstNode
        if (key.type !== 'Identifier' || key['name'] !== param || object.type !== 'Identifier') return undefined
        found = tableOf(object)
        if (found !== undefined) found = { ...found, call: node }
        return undefined
      },
    })
    return found
  }

  /** The factory table a name holds: a declarator's literal, or the literal an IIFE passes the parameter it is. */
  function tableOf(id: AstNode): Table | undefined {
    const key = definitions.keyOf(id)
    if (key === undefined) return undefined
    for (const definition of definitions.of(key)) {
      if (definition.source !== undefined && definition.pattern.type === 'Identifier') {
        const table = factoryTable(definition.source, empty)
        if (table !== undefined) return table
      }
    }
    // A parameter of a function called at once with the table: webpack 4's `!function(e){…}([…])`.
    const fn = key.scope === 'global' ? undefined : key.scope
    if (fn === undefined || !isFunction(fn)) return undefined
    const index = (fn['params'] as AstNode[]).findIndex((param) => param.type === 'Identifier' && param['name'] === key.name)
    let call = parents.get(fn)
    while (call?.type === 'ParenthesizedExpression') call = parents.get(call)
    if (index < 0 || call?.type !== 'CallExpression' || calleeExpression(call['callee'] as AstNode) !== fn) return undefined
    const arg = (call['arguments'] as AstNode[])[index]
    return arg === undefined ? undefined : factoryTable(arg, empty)
  }

  /** The key a name has in the scope of `fn`, from a reference to it in `fn`'s own code. */
  function referenceKey(fn: AstNode, name: string): VariableKey | undefined {
    let key: VariableKey | undefined
    walkTree(fn['body'] as AstNode, {
      enter(node, parent) {
        if (key !== undefined) return false
        if (node.type !== 'Identifier' || node['name'] !== name) return undefined
        // Not a property name.
        if (parent?.type === 'MemberExpression' && parent['property'] === node && parent['computed'] !== true) return undefined
        if (parent?.type === 'Property' && parent['key'] === node && parent['shorthand'] !== true) return undefined
        const found = definitions.keyOf(node)
        if (found !== undefined && (found.scope === fn || fn.type === 'FunctionDeclaration')) key = found
        return undefined
      },
    })
    return key
  }
}

/**
 * A factory table (above): an object literal whose values are all functions, or an array literal of functions. It is
 * empty only when `empty` allows, for a loader's table.
 */
function factoryTable(literal: AstNode, empty = false): Table | undefined {
  const factories = new Map<string, AstNode>()
  if (literal.type === 'ObjectExpression') {
    for (const property of literal['properties'] as AstNode[]) {
      if (property.type !== 'Property' || property['kind'] !== 'init' || property['computed'] === true) return undefined
      const key = property['key'] as AstNode
      const id = key.type === 'Identifier' ? (key['name'] as string) : literalKey(key)
      const value = property['value'] as AstNode
      if (id === undefined || !isFunction(value)) return undefined
      factories.set(id, value)
    }
  } else if (literal.type === 'ArrayExpression') {
    for (const [index, element] of (literal['elements'] as (AstNode | null)[]).entries()) {
      if (element === null) continue
      if (!isFunction(element)) return undefined
      factories.set(String(index), element)
    }
  } else return undefined
  return factories.size === 0 && !empty ? undefined : { literal, factories }
}

/** Whether a node is `o.name`, spelled with a dot. */
function member(node: AstNode, name: string): boolean {
  if (node.type !== 'MemberExpression' || node['computed'] === true) return false
  const property = node['property'] as AstNode
  return property.type === 'Identifier' && property['name'] === name
}

/**
 * The idioms of code whose modules are hoisted into one scope, each module run by a function of its own (§6):
 *
 * - **Lazy module thunk**: a maker `(cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports)`,
 *   whose thunk calls its factory with a fresh `{ exports }`, as esbuild's `__commonJS` and Rolldown's `__commonJSMin`
 *   are, or `(fn, res) => () => (fn && (res = fn((fn = 0))), res)`, the variant that only runs init, as esbuild's
 *   `__esm` is. A `try` around the call, or other code beside it, changes nothing. Each call of the maker with a factory
 *   is a module, named by the variable its thunk goes to, and each call of that thunk runs it. The module object can
 *   be a variable the maker declares rather than a parameter, and the thunk can call its factory through a variable
 *   that holds it, with `.call`: webpack's `R.cw = t => { var e; return () => { if (t) { var r = t; t = 0, e = {
 *   exports: {} }, r.call(e.exports, e, e.exports) } return e.exports } }`, whose factories take `(module, exports)`. A
 *   maker can be set on an object a variable holds (`R.cw = …`, `{ cw: … }`), and is then called through it.
 * - **Memoized getter**: a function with no parameters that first tests a flag declared outside it, returning a value
 *   when it is set, and sets the flag to `1` or `true` (Rollup commonjs's `requireX`: `if (f) return x; f = 1; …`, `return f ? x : ((f = 1), (x = …))`). It is a
 *   module, named by its name, and each call of it runs it.
 * - **Getter export definer**: a function whose own code runs `for (k in all) define(target, k, { get: all[k] })`
 *   over its parameter `all`, where `target` is its other parameter (esbuild's `__export(target, all)`), or a fresh
 *   object it returns (Rolldown's `__exportAll(all)`). Each call with an object literal of getters defines its exports,
 *   of a module named by the target's variable, or by the variable the returned object goes to.
 * - **Interop wrappers**: a function that reads its first parameter's `__esModule`, and either defines `"default"` with
 *   that parameter as its value (`__toESM`, which makes a namespace object of a CommonJS module) or reads its `default`
 *   (`getDefaultExportFromCjs`). A call of one counts, and links when its argument is a call that runs a module.
 *
 * A module's name is build-local, like a module id: it appears in the trace, never in identity.
 */
function hoistedLinks(program: AstNode, definitions: Definitions): ModuleLinks {
  const parents = new Map<AstNode, AstNode>()
  const functions: AstNode[] = []
  const calls: AstNode[] = []
  walkTree(program, {
    enter(node, parent) {
      if (parent !== null) parents.set(node, parent)
      if (isFunction(node)) functions.push(node)
      else if (node.type === 'CallExpression') calls.push(node)
    },
  })

  /** Whether `node` is a reference to the parameter `name` of `fn`. */
  const isParam = (node: AstNode | undefined, fn: AstNode, name: string): boolean =>
    node?.type === 'Identifier' && node['name'] === name && definitions.keyOf(node)?.scope === fn
  const paramNames = (fn: AstNode): (string | undefined)[] =>
    (fn['params'] as AstNode[]).map((param) => (param.type === 'Identifier' ? (param['name'] as string) : undefined))

  /** The variable a value goes to: a declarator's, or a plain assignment's. */
  const bindingOf = (value: AstNode): AstNode | undefined => {
    const parent = parents.get(value)
    if (parent?.type === 'VariableDeclarator' && parent['init'] === value) {
      const id = parent['id'] as AstNode
      return id.type === 'Identifier' ? id : undefined
    }
    if (parent?.type === 'AssignmentExpression' && parent['right'] === value && parent['operator'] === '=') {
      const left = parent['left'] as AstNode
      return left.type === 'Identifier' ? left : undefined
    }
    return undefined
  }
  /** The name a function is called by, with a test of whether a callee's variable is that name. */
  const nameOf = (fn: AstNode): { name: string; is: (key: VariableKey | undefined) => boolean } | undefined => {
    if (fn.type === 'FunctionDeclaration') {
      const id = fn['id'] as AstNode | null
      if (id === null) return undefined
      const name = id['name'] as string
      // A function declaration's calls resolve to the declaration itself, or, at a classic script's top level, to the
      // global object's property it binds.
      const topLevel = [...ancestors(fn)].every((each) => !isFunction(each))
      // Where a parameter shadows the name, a call outside the function is keyed by its `id` (`shadowedNameOf`).
      return {
        name,
        is: (key) =>
          key?.name === name &&
          (key.scope === fn || shadowedNameOf(key.scope) === fn || (key.scope === 'global' && topLevel)),
      }
    }
    const id = bindingOf(fn)
    if (id === undefined) return undefined
    const own = definitions.keyOf(id)
    return own === undefined ? undefined : { name: id['name'] as string, is: (key) => sameKey(key, own) }
  }
  function* ancestors(node: AstNode): Generator<AstNode> {
    for (let at = parents.get(node); at !== undefined; at = parents.get(at)) yield at
  }
  /** The calls whose callee is a variable `is` accepts, past `(0, f)`. */
  const callsOf = (is: (key: VariableKey | undefined) => boolean): AstNode[] =>
    calls.filter((call) => {
      const callee = calleeExpression(call['callee'] as AstNode)
      return callee.type === 'Identifier' && is(definitions.keyOf(callee))
    })

  /**
   * The calls of a function set as a property of an object a variable holds, through that variable: `R.cw(…)` after
   * `R.cw = fn`, or after `const R = { cw: fn }`.
   */
  const memberCallsOf = (fn: AstNode): AstNode[] | undefined => {
    const parent = parents.get(fn)
    let holder: AstNode | undefined
    let name: string | undefined
    if (parent?.type === 'AssignmentExpression' && parent['right'] === fn && parent['operator'] === '=') {
      const left = parent['left'] as AstNode
      const object = left['object'] as AstNode | undefined
      if (left.type !== 'MemberExpression' || left['computed'] === true || object?.type !== 'Identifier') return undefined
      holder = object
      name = (left['property'] as AstNode)['name'] as string
    } else if (parent?.type === 'Property' && parent['value'] === fn && parent['kind'] === 'init' && parent['computed'] !== true) {
      const literal = parents.get(parent)
      holder = literal === undefined ? undefined : bindingOf(literal)
      name = propertyName(parent)
    }
    const key = holder === undefined ? undefined : definitions.keyOf(holder)
    if (key === undefined || name === undefined) return undefined
    return calls.filter((call) => {
      const callee = calleeExpression(call['callee'] as AstNode)
      if (!member(callee, name)) return false
      const object = callee['object'] as AstNode
      return object.type === 'Identifier' && sameKey(definitions.keyOf(object), key)
    })
  }

  const idioms = new Set<Idiom>()
  const moduleCalls = new Map<AstNode, ModuleLink>()
  const defines: ExportDefine[] = []
  const definers = new Set<AstNode>()
  const namespaces = new Map<AstNode, AstNode>()
  const factoryCalls = new Map<AstNode, FactoryCall>()
  const makes = new Map<AstNode, AstNode>()
  let modules = 0

  for (const fn of functions) {
    const maker = thunkMaker(fn)
    const kind = maker === undefined ? (memoizedGetter(fn) ? 'getter' : undefined) : 'thunk'
    if (kind === undefined) continue
    const named = nameOf(fn)
    // A thunk maker can be set on an object instead (`R.cw = t => …`), and called through it (`R.cw(factory)`).
    const made = named !== undefined ? callsOf(named.is) : maker !== undefined ? memberCallsOf(fn) : undefined
    if (made === undefined) continue
    if (maker !== undefined) factoryCalls.set(maker.call, maker.factoryCall)
    if (kind === 'getter') {
      if (named === undefined) continue
      // A memoized getter is itself the module.
      modules++
      idioms.add('memoized-getter')
      for (const call of callsOf(named.is)) {
        if ((call['arguments'] as AstNode[]).length === 0) moduleCalls.set(call, { idiom: 'memoized-getter', module: named.name })
      }
      continue
    }
    // Each call of a thunk maker with a factory is a module, whose thunk runs it.
    for (const make of made) {
      const [factory] = make['arguments'] as AstNode[]
      if (factory === undefined || !isFunction(factory)) continue
      const thunk = bindingOf(make)
      const key = thunk === undefined ? undefined : definitions.keyOf(thunk)
      if (key === undefined) continue
      makes.set(make, fn)
      modules++
      idioms.add('lazy-thunk')
      const module = thunk!['name'] as string
      for (const call of callsOf((each) => sameKey(each, key))) {
        if ((call['arguments'] as AstNode[]).length === 0) moduleCalls.set(call, { idiom: 'lazy-thunk', module })
      }
    }
  }

  for (const fn of functions) {
    const definer = exportDefiner(fn)
    if (definer === undefined) continue
    const named = nameOf(fn)
    if (named === undefined) continue
    definers.add(fn)
    for (const call of callsOf(named.is)) {
      const args = call['arguments'] as AstNode[]
      const list = args[definer.list]
      const object = definer.target === undefined ? call : args[definer.target]
      if (list?.type !== 'ObjectExpression' || object === undefined || object.type === 'SpreadElement') continue
      const holder = definer.target === undefined ? bindingOf(call) : object.type === 'Identifier' ? object : undefined
      const module = holder === undefined ? undefined : (holder['name'] as string)
      for (const property of list['properties'] as AstNode[]) {
        if (property.type !== 'Property' || property['kind'] !== 'init') continue
        const key = property['key'] as AstNode
        const name = property['computed'] === true ? literalKey(key) : key.type === 'Identifier' ? (key['name'] as string) : literalKey(key)
        if (name === undefined) continue
        idioms.add('getter-export')
        const link: ModuleLink | undefined = module === undefined ? undefined : { idiom: 'getter-export', module, export: name }
        defines.push({ site: call, object, key: name, getter: property['value'] as AstNode, ...(link === undefined ? {} : { link }) })
      }
    }
  }

  for (const fn of functions) {
    const wrapper = interopWrapper(fn)
    if (wrapper === undefined) continue
    const named = nameOf(fn)
    if (named === undefined) continue
    if (wrapper === 'namespace') definers.add(fn)
    for (const call of callsOf(named.is)) {
      const [arg] = call['arguments'] as AstNode[]
      if (arg === undefined || arg.type === 'SpreadElement') continue
      idioms.add('interop')
      if (wrapper === 'namespace') namespaces.set(call, arg)
      const inner = moduleCalls.get(arg)
      if (inner !== undefined) moduleCalls.set(call, { idiom: 'interop', module: inner.module })
    }
  }

  return { ...none, idioms, modules, defines, definers, moduleCalls, namespaces, factoryCalls, makes }

  /** Whether a variable is declared in a function's code: its parameters', its body's, or a nested scope's there. */
  function within(key: VariableKey, fn: AstNode): boolean {
    return key.scope !== 'global' && fn.start <= key.scope.start && key.scope.end <= fn.end
  }

  /** Whether a function is a lazy module thunk maker (above), and which, with its thunk's call of its factory. */
  function thunkMaker(fn: AstNode): { kind: 'commonjs' | 'init'; call: AstNode; factoryCall: FactoryCall } | undefined {
    const [cb] = paramNames(fn)
    if (cb === undefined) return undefined
    const inner = returnedFunction(fn)
    if (inner === undefined) return undefined
    const body = inner['body'] as AstNode
    // The module object: a variable of the maker's own, a parameter or one it declares, that the thunk sets to a fresh
    // `{ exports }`.
    let mod: VariableKey | undefined
    let object: AstNode | undefined
    walkTree(body, {
      enter(node) {
        if (mod !== undefined || isFunction(node)) return false
        if (node.type !== 'AssignmentExpression' || node['operator'] !== '=') return undefined
        const left = node['left'] as AstNode
        const right = node['right'] as AstNode
        const key = left.type === 'Identifier' ? definitions.keyOf(left) : undefined
        if (key === undefined || !within(key, fn) || within(key, inner) || key.name === cb || right.type !== 'ObjectExpression') return undefined
        if ((right['properties'] as AstNode[]).some((each) => propertyName(each) === 'exports')) {
          mod = key
          object = right
        }
        return undefined
      },
    })
    // The factory: `cb`, or a variable of the thunk's that only ever holds it (`var r = t; t = 0`).
    const isFactory = (node: AstNode): boolean => {
      if (isParam(node, fn, cb)) return true
      const key = node.type === 'Identifier' ? definitions.keyOf(node) : undefined
      if (key === undefined || !within(key, inner)) return false
      const defined = definitions.of(key)
      return defined.length > 0 && defined.every((each) => each.source !== undefined && isParam(each.source, fn, cb))
    }
    let found: { kind: 'commonjs' | 'init'; call: AstNode; factoryCall: FactoryCall } | undefined
    walkTree(body, {
      enter(node) {
        if (found !== undefined || isFunction(node)) return false
        if (node.type !== 'CallExpression') return undefined
        const callee = node['callee'] as AstNode
        // `cb(…)`, or `cb.call(this, …)`.
        const through = member(callee, 'call')
        if (!isFactory(through ? (callee['object'] as AstNode) : callee)) return undefined
        const args = (node['arguments'] as AstNode[]).slice(through ? 1 : 0)
        const [first] = args
        // `cb(cb = 0)`: init only.
        if (first?.type === 'AssignmentExpression' && isParam(first['left'] as AstNode, fn, cb)) {
          const right = first['right'] as AstNode
          if (right.type === 'Literal' && right['value'] === 0) found = { kind: 'init', call: node, factoryCall: {} }
          return undefined
        }
        // `cb((mod = { exports: {} }).exports, mod)`, `r.call(mod.exports, mod, mod.exports)`.
        if (mod === undefined) return undefined
        const module = args.findIndex((arg) => arg.type === 'Identifier' && sameKey(definitions.keyOf(arg), mod))
        found = { kind: 'commonjs', call: node, factoryCall: { object: object!, ...(module < 0 ? {} : { module }) } }
        return undefined
      },
    })
    return found
  }

  /** Whether a function is a memoized getter (above). */
  function memoizedGetter(fn: AstNode): boolean {
    if ((fn['params'] as AstNode[]).length > 0 || fn['async'] === true || fn['generator'] === true) return false
    const body = fn['body'] as AstNode
    if (body.type !== 'BlockStatement') return false
    const [first] = body['body'] as AstNode[]
    // The flag the getter tests first: `if (f) return x`, `return f ? … : …`, `return f || (…), x`. The early return
    // gives the memoized value: a run-once guard (`if (done) return; done = true; …`) is not a module.
    let test: AstNode | undefined
    if (first?.type === 'IfStatement' && returnsValue(first['consequent'] as AstNode)) test = first['test'] as AstNode
    else if (first?.type === 'ReturnStatement' && first['argument'] !== null) {
      let argument = first['argument'] as AstNode
      if (argument.type === 'SequenceExpression') argument = (argument['expressions'] as AstNode[])[0]!
      if (argument.type === 'ConditionalExpression') test = argument['test'] as AstNode
      else if (argument.type === 'LogicalExpression') test = argument['left'] as AstNode
    }
    if (test?.type !== 'Identifier') return false
    const flag = definitions.keyOf(test)
    if (flag === undefined || flag.scope === fn) return false
    let sets = false
    walkTree(body, {
      enter(node) {
        if (sets || isFunction(node)) return false
        if (node.type !== 'AssignmentExpression' || node['operator'] !== '=') return undefined
        const left = node['left'] as AstNode
        const right = node['right'] as AstNode
        const truthy =
          (right.type === 'Literal' && (right['value'] === 1 || right['value'] === true)) ||
          (right.type === 'UnaryExpression' && right['operator'] === '!' && (right['argument'] as AstNode).type === 'Literal' && (right['argument'] as AstNode)['value'] === 0)
        if (left.type === 'Identifier' && truthy && sameKey(definitions.keyOf(left), flag)) sets = true
        return undefined
      },
    })
    return sets
  }

  /** Whether a statement is `return x`, alone or as a block's only statement. */
  function returnsValue(statement: AstNode): boolean {
    const [only, ...rest] = statement.type === 'BlockStatement' ? (statement['body'] as AstNode[]) : [statement]
    return rest.length === 0 && only?.type === 'ReturnStatement' && only['argument'] !== null
  }

  /**
   * Whether a function is a getter export definer (above): the index of its parameter whose getters it defines, and of
   * the one it defines them on, or none when it defines them on a fresh object it returns.
   */
  function exportDefiner(fn: AstNode): { list: number; target?: number } | undefined {
    const names = paramNames(fn)
    let found: { list: number; target?: number } | undefined
    walkTree(fn['body'] as AstNode, {
      enter(node) {
        if (found !== undefined || isFunction(node)) return false
        if (node.type !== 'ForInStatement') return undefined
        const right = node['right'] as AstNode
        const list = names.findIndex((name) => name !== undefined && isParam(right, fn, name))
        const left = node['left'] as AstNode
        const variable = left.type === 'VariableDeclaration' ? ((left['declarations'] as AstNode[])[0]!['id'] as AstNode) : left
        if (list < 0 || variable.type !== 'Identifier') return undefined
        // `define(target, k, { get: all[k], … })`
        walkTree(node['body'] as AstNode, {
          enter(part) {
            if (found !== undefined || isFunction(part)) return false
            if (part.type !== 'CallExpression') return undefined
            const [target, key, descriptor] = part['arguments'] as AstNode[]
            if (target?.type !== 'Identifier' || key?.type !== 'Identifier' || key['name'] !== variable['name']) return undefined
            if (descriptor?.type !== 'ObjectExpression') return undefined
            const getter = (descriptor['properties'] as AstNode[]).find((each) => propertyName(each) === 'get')?.['value'] as AstNode | undefined
            if (getter?.type !== 'MemberExpression' || getter['computed'] !== true || !isParam(getter['object'] as AstNode, fn, names[list]!)) return undefined
            const index = names.findIndex((name) => name !== undefined && isParam(target, fn, name))
            if (index >= 0) found = { list, target: index }
            else if (definitions.keyOf(target)?.scope !== 'global' && returns(fn, target['name'] as string)) found = { list }
            return undefined
          },
        })
        return undefined
      },
    })
    return found
  }

  /** Whether a function is an interop wrapper (above), and which. */
  function interopWrapper(fn: AstNode): 'namespace' | 'default' | undefined {
    const [param] = paramNames(fn)
    if (param === undefined) return undefined
    let esModule = false
    let namespace = false
    let reads = false
    walkTree(fn['body'] as AstNode, {
      enter(node) {
        if (isFunction(node)) return false
        if (node.type === 'MemberExpression' && isParam(node['object'] as AstNode, fn, param)) {
          const property = node['property'] as AstNode
          const name = node['computed'] === true ? stringKey(property) : (property['name'] as string | undefined)
          if (name === '__esModule') esModule = true
          if (name === 'default') reads = true
        } else if (node.type === 'CallExpression') {
          // `define(ns, "default", { value: m, … })`
          const [, key, descriptor] = node['arguments'] as AstNode[]
          if (key !== undefined && stringKey(key) === 'default' && descriptor?.type === 'ObjectExpression') {
            const value = (descriptor['properties'] as AstNode[]).find((each) => propertyName(each) === 'value')?.['value'] as AstNode | undefined
            if (isParam(value, fn, param)) namespace = true
          }
        }
        return undefined
      },
    })
    return !esModule ? undefined : namespace ? 'namespace' : reads ? 'default' : undefined
  }

  /** The function a function returns: its arrow's body, or its only `return`'s. */
  function returnedFunction(fn: AstNode): AstNode | undefined {
    const body = fn['body'] as AstNode
    if (isFunction(body)) return body
    if (body.type !== 'BlockStatement') return undefined
    const statements = body['body'] as AstNode[]
    const last = statements.at(-1)
    const argument = last?.type === 'ReturnStatement' ? (last['argument'] as AstNode | null) : null
    return argument !== null && isFunction(argument) ? argument : undefined
  }

  /** Whether a function's own code returns the variable `name`, alone or last in a sequence. */
  function returns(fn: AstNode, name: string): boolean {
    let found = false
    walkTree(fn['body'] as AstNode, {
      enter(node) {
        if (found || isFunction(node)) return false
        if (node.type !== 'ReturnStatement' || node['argument'] === null) return undefined
        const argument = calleeExpression(node['argument'] as AstNode)
        found = argument.type === 'Identifier' && argument['name'] === name
        return undefined
      },
    })
    return found
  }
}

/** The name a property's key gives it: an identifier or a literal, spelled plainly or computed. */
function propertyName(property: AstNode): string | undefined {
  const key = property['key'] as AstNode | undefined
  if (key === undefined) return undefined
  if (property['computed'] === true) return stringKey(key)
  return key.type === 'Identifier' ? (key['name'] as string) : literalKey(key)
}

/** A literal's key, or a template literal's with no substitutions (Rolldown quotes its strings so). */
function stringKey(node: AstNode): string | undefined {
  if (node.type !== 'TemplateLiteral' || (node['expressions'] as AstNode[]).length > 0) return literalKey(node)
  const [quasi] = node['quasis'] as AstNode[]
  return (quasi?.['value'] as { cooked?: string } | undefined)?.cooked ?? undefined
}

// Chunk registries (§6 Module-linking idiom 6, Globals are not links): the global array a chunk loader's chunks push
// into, recognized from structure alone.
//
// - A **registry** is a global object's member with a constant name, read as `G.R = G.R || []` or `G.R ||= []` (and
//   `G["R"]`), where `G` is `self`, `window`, `globalThis` or `this`.
// - A **push** is `registry.push([[ids…], modules, callback?])`, where `ids` are constant chunk ids and `modules` an
//   object literal of factories keyed by constant module id, or an array literal of factories indexed by it.
// - A **loader** reads a registry into a variable whose `push` it overrides (`l.push = …`), so that it reads every push.
//   Its **id table** is the ids its URL function maps: a function of one parameter that builds a script URL by string
//   concatenation (a string literal naming a `.js`, `.mjs` or `.cjs` file), such as `n.u = e => ({581: "recorder"}[e] +
//   "." + {581: "27e3"}[e] + ".js")`. Each object literal it indexes with the parameter maps only its constant keys, so
//   the function maps the ids every such literal has. A literal with a fallback (`{…}[e] || e`) and the parameter itself
//   (`e => e + ".js"`) map every id. When no function builds a script URL, every concatenating function counts, and one
//   with a table outweighs one that maps every id: an unrelated `e => "\\" + e` never widens a loader's table.
//
// - An **ESM chunk** (webpack's ESM chunk format) doesn't push: the module exports its chunk ids and its module
//   table, `export const __webpack_esm_ids__ = [ids…]` and `export const __webpack_esm_modules__ = {factories}`. It
//   counts as a push into the registry `esmRegistry`, which no global names. Its **loader** loads it with `import()`
//   and destructures the module's `__webpack_esm_modules__` (`let {__webpack_esm_modules__: o} = e`) to install them,
//   which counts as a read of that registry, with the id table of its URL function.
//
// Registry names and chunk ids are build-local: they decide links, never identity (§6 Reporting).

import { walkTree, type AstNode } from './ast.ts'
import { literalKey } from './keys.ts'
import { parse } from './parse.ts'

/** A push into a registry: its call, the chunk ids it pushes, and its factories by module id. */
export interface RegistryPush {
  registry: string
  call: AstNode
  chunks: string[]
  /** The factories it pushes, each with its module id, in document order. */
  factories: { id: string; factory: AstNode }[]
  /** The callback it pushes, which the loader calls with its require. */
  callback?: AstNode
}

/** A loader's read of a registry: the registry's name, the read, and the ids its id table maps ('any' for every id). */
export interface RegistryLoad {
  registry: string
  read: AstNode
  ids: ReadonlySet<string> | 'any'
}

export interface Registries {
  pushes: RegistryPush[]
  loads: RegistryLoad[]
}

/**
 * The registry an ESM chunk's export of its module table counts as a push into (above). A global's name can't be it: a
 * registry read never names it.
 */
export const esmRegistry = '\u0000webpack-esm'

/** The names an ESM chunk exports its chunk ids and its module table under. */
const esmIds = '__webpack_esm_ids__'
const esmModules = '__webpack_esm_modules__'

/** The chunk registries a program pushes into and reads (above). */
export function registriesOf(program: AstNode): Registries {
  const pushes: RegistryPush[] = []
  // The ESM chunk exports of each statement list, by the node that holds it.
  const exported = new Map<AstNode, { ids?: string[]; modules?: AstNode; declaration?: AstNode }>()
  const esmReads: AstNode[] = []
  // The variables registry reads are stored in, by name, with the registry and the read: `l = self.R = self.R || []`.
  const stored: { name: string; registry: string; read: AstNode }[] = []
  const hooked = new Set<string>()
  const tables: { ids: Set<string> | 'any'; script: boolean }[] = []
  walkTree(program, {
    enter(node, parent) {
      if (node.type === 'CallExpression') {
        const push = pushOf(node)
        if (push !== undefined) pushes.push(push)
        return
      }
      if (node.type === 'VariableDeclarator') {
        const id = node['id'] as AstNode
        const init = node['init'] as AstNode | null
        const registry = init === null ? undefined : registryRead(init)
        if (registry !== undefined && id.type === 'Identifier') stored.push({ name: id['name'] as string, registry, read: init! })
        return
      }
      if (node.type === 'AssignmentExpression' && node['operator'] === '=') {
        const left = node['left'] as AstNode
        const right = node['right'] as AstNode
        const registry = registryRead(right)
        if (registry !== undefined && left.type === 'Identifier') stored.push({ name: left['name'] as string, registry, read: right })
        // `l.push = …`: the loader reads every push.
        const object = left.type === 'MemberExpression' ? (left['object'] as AstNode) : undefined
        if (object?.type === 'Identifier' && memberName(left) === 'push') hooked.add(object['name'] as string)
        return
      }
      if (node.type === 'ExportNamedDeclaration' && parent !== null) {
        const declaration = node['declaration'] as AstNode | null
        if (declaration?.type !== 'VariableDeclaration') return
        for (const declarator of declaration['declarations'] as AstNode[]) {
          const id = declarator['id'] as AstNode
          const init = declarator['init'] as AstNode | null
          if (id.type !== 'Identifier' || init === null) continue
          const entry = exported.get(parent) ?? {}
          if (id['name'] === esmIds && init.type === 'ArrayExpression') {
            const ids = (init['elements'] as (AstNode | null)[]).map((element) => (element === null ? undefined : literalKey(element)))
            if (ids.every((each) => each !== undefined)) entry.ids = ids as string[]
          } else if (id['name'] === esmModules && init.type === 'ObjectExpression') {
            entry.modules = init
            entry.declaration = node
          }
          exported.set(parent, entry)
        }
        return
      }
      if (node.type === 'ObjectPattern') {
        const reads = (node['properties'] as AstNode[]).some(
          (property) => property.type === 'Property' && property['computed'] !== true && keyName(property['key'] as AstNode) === esmModules,
        )
        if (reads) esmReads.push(node)
        return
      }
      if (isFunction(node)) {
        const table = idTable(node)
        if (table !== undefined) tables.push(table)
      }
    },
  })
  for (const { ids, modules, declaration } of exported.values()) {
    if (ids === undefined || modules === undefined || declaration === undefined) continue
    const factories = objectFactories(modules)
    if (factories !== undefined) pushes.push({ registry: esmRegistry, call: declaration, chunks: ids, factories })
  }
  const ids = mappedIds(tables)
  const loads: RegistryLoad[] = []
  for (const { name, registry, read } of stored) {
    if (!hooked.has(name) || loads.some((load) => load.read === read)) continue
    loads.push({ registry, read, ids })
  }
  for (const read of esmReads) loads.push({ registry: esmRegistry, read, ids })
  return { pushes, loads }
}

/**
 * The chunk registries an artifact's code pushes into and reads, as data: each push's registry and chunk ids, and each
 * loader's registry and the ids its id table maps (`null` for every id). None when the code doesn't parse.
 */
export function chunkRegistries(
  text: string,
  sourceType: 'script' | 'module',
): { pushes: { registry: string; chunks: string[] }[]; loads: { registry: string; ids: string[] | null }[] } {
  // A cheap test first: code that never names `push` neither pushes nor hooks one, unless it is an ESM chunk or loader.
  if (!text.includes('push') && !text.includes(esmModules)) return { pushes: [], loads: [] }
  const parsed = parse(text, sourceType)
  if ('error' in parsed) return { pushes: [], loads: [] }
  const { pushes, loads } = registriesOf(parsed.program)
  return {
    pushes: pushes.map(({ registry, chunks }) => ({ registry, chunks })),
    loads: loads.map(({ registry, ids }) => ({ registry, ids: ids === 'any' ? null : [...ids].sort() })),
  }
}

const globalNames: ReadonlySet<string> = new Set(['self', 'window', 'globalThis'])

/** The registry an expression reads, `G.R = G.R || []` or `G.R ||= []`, by its name. */
function registryRead(node: AstNode): string | undefined {
  if (node.type !== 'AssignmentExpression') return undefined
  const left = node['left'] as AstNode
  const right = node['right'] as AstNode
  const name = globalMember(left)
  if (name === undefined || name === esmRegistry) return undefined
  if (node['operator'] === '||=' || node['operator'] === '??=') return emptyArray(right) ? name : undefined
  if (node['operator'] !== '=' || right.type !== 'LogicalExpression' || right['operator'] !== '||') return undefined
  return globalMember(right['left'] as AstNode) === name && emptyArray(right['right'] as AstNode) ? name : undefined
}

/** `G.R` or `G["R"]` with `G` a name of the global object, or `this`: the member's name. */
function globalMember(node: AstNode): string | undefined {
  if (node.type !== 'MemberExpression') return undefined
  const object = node['object'] as AstNode
  const global = object.type === 'ThisExpression' || (object.type === 'Identifier' && globalNames.has(object['name'] as string))
  return global ? memberName(node) : undefined
}

/** A member expression's constant name: `o.x` or `o["x"]`. */
function memberName(node: AstNode): string | undefined {
  if (node.type !== 'MemberExpression') return undefined
  const property = node['property'] as AstNode
  if (node['computed'] !== true) return property.type === 'Identifier' ? (property['name'] as string) : undefined
  return property.type === 'Literal' && typeof property['value'] === 'string' ? property['value'] : undefined
}

const emptyArray = (node: AstNode): boolean => node.type === 'ArrayExpression' && (node['elements'] as unknown[]).length === 0

/** A push into a registry (above), or undefined for any other call. */
function pushOf(call: AstNode): RegistryPush | undefined {
  const callee = call['callee'] as AstNode
  if (callee.type !== 'MemberExpression' || memberName(callee) !== 'push') return undefined
  const object = callee['object'] as AstNode
  const registry = registryRead(object) ?? globalMember(object)
  if (registry === undefined) return undefined
  const [only, ...rest] = call['arguments'] as AstNode[]
  if (only?.type !== 'ArrayExpression' || rest.length > 0) return undefined
  const [list, modules, callback] = only['elements'] as (AstNode | null)[]
  if (list?.type !== 'ArrayExpression' || modules === null || modules === undefined) return undefined
  const chunks: string[] = []
  for (const element of list['elements'] as (AstNode | null)[]) {
    const id = element === null ? undefined : literalKey(element)
    if (id === undefined) return undefined
    chunks.push(id)
  }
  let factories: { id: string; factory: AstNode }[] = []
  if (modules.type === 'ObjectExpression') {
    const found = objectFactories(modules)
    if (found === undefined) return undefined
    factories = found
  } else if (modules.type === 'ArrayExpression') {
    for (const [index, element] of (modules['elements'] as (AstNode | null)[]).entries()) {
      if (element === null) continue
      if (!isFunction(element)) return undefined
      factories.push({ id: String(index), factory: element })
    }
  } else return undefined
  const push: RegistryPush = { registry, call, chunks, factories }
  if (callback !== null && callback !== undefined && isFunction(callback)) push.callback = callback
  return push
}

/** An object literal of factories keyed by constant module id, or undefined when it is anything else. */
function objectFactories(modules: AstNode): { id: string; factory: AstNode }[] | undefined {
  const factories: { id: string; factory: AstNode }[] = []
  for (const property of modules['properties'] as AstNode[]) {
    if (property.type !== 'Property' || property['kind'] !== 'init' || property['computed'] === true) return undefined
    const id = keyName(property['key'] as AstNode)
    const value = property['value'] as AstNode
    if (id === undefined || !isFunction(value)) return undefined
    factories.push({ id, factory: value })
  }
  return factories
}

/** A non-computed property key's name. */
const keyName = (key: AstNode): string | undefined => (key.type === 'Identifier' ? (key['name'] as string) : literalKey(key))

const functionTypes: ReadonlySet<string> = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])
const isFunction = (node: AstNode): boolean => functionTypes.has(node.type)

/**
 * The ids a program's URL functions map (above): those of the functions that build a script URL when there are any,
 * else of every concatenating function, a table outweighing 'any'.
 */
function mappedIds(tables: { ids: Set<string> | 'any'; script: boolean }[]): ReadonlySet<string> | 'any' {
  const scripts = tables.filter((table) => table.script)
  const counted = scripts.length > 0 ? scripts : tables.filter((table) => table.ids !== 'any')
  if (counted.some((table) => table.ids === 'any')) return 'any'
  if (counted.length === 0) return tables.length > 0 ? 'any' : new Set()
  return new Set(counted.flatMap((table) => [...table.ids]))
}

const scriptUrl = /\.[cm]?js(?:$|[?#])/i

/**
 * A function's id table (above): the ids it maps, 'any' when it maps every id, and whether it builds a script URL, or
 * undefined when it concatenates no use of its one parameter.
 */
function idTable(fn: AstNode): { ids: Set<string> | 'any'; script: boolean } | undefined {
  const params = fn['params'] as AstNode[]
  if (params.length !== 1 || params[0]!.type !== 'Identifier') return undefined
  const param = params[0]!['name'] as string
  const isParam = (node: AstNode) => node.type === 'Identifier' && node['name'] === param
  // The key sets of the tables it indexes with no fallback: an id must be in each.
  const constraints: string[][] = []
  let used = false
  let script = false
  walkTree(fn['body'] as AstNode, {
    enter(node) {
      if (node !== fn['body'] && isFunction(node)) return false
      if (node.type !== 'BinaryExpression' || node['operator'] !== '+') return undefined
      if (!concatenation(node)) return undefined
      for (const side of [node['left'], node['right']] as AstNode[]) {
        if (side.type === 'Literal' && typeof side['value'] === 'string' && scriptUrl.test(side['value'])) script = true
        if (isParam(side)) used = true
        // `{…}[e] || e` keeps a table's id, or the id itself: every id.
        if (side.type === 'LogicalExpression') {
          const operands = [side['left'] as AstNode, side['right'] as AstNode]
          if (operands.some((operand) => isParam(operand) || tableKeys(operand, isParam) !== undefined)) used = true
          continue
        }
        const keys = tableKeys(side, isParam)
        if (keys !== undefined) {
          used = true
          constraints.push(keys)
        }
      }
      return undefined
    },
  })
  if (!used) return undefined
  if (constraints.length === 0) return { ids: 'any', script }
  const [first, ...rest] = constraints
  return { ids: new Set(first!.filter((id) => rest.every((keys) => keys.includes(id)))), script }
}
/** Whether a `+` builds a string: one of its operands, down its left spine, is a string literal. */
function concatenation(node: AstNode): boolean {
  for (let at: AstNode = node; at.type === 'BinaryExpression' && at['operator'] === '+'; at = at['left'] as AstNode) {
    const right = at['right'] as AstNode
    const left = at['left'] as AstNode
    if (right.type === 'Literal' && typeof right['value'] === 'string') return true
    if (left.type === 'Literal' && typeof left['value'] === 'string') return true
  }
  return false
}

/** `{k: v, …}[p]`: the literal's constant keys. */
function tableKeys(node: AstNode, isParam: (node: AstNode) => boolean): string[] | undefined {
  if (node.type !== 'MemberExpression' || node['computed'] !== true || !isParam(node['property'] as AstNode)) return undefined
  const object = node['object'] as AstNode
  if (object.type !== 'ObjectExpression') return undefined
  const keys: string[] = []
  for (const property of object['properties'] as AstNode[]) {
    if (property.type !== 'Property' || property['computed'] === true) return undefined
    const key = property['key'] as AstNode
    const id = key.type === 'Identifier' ? (key['name'] as string) : literalKey(key)
    if (id === undefined) return undefined
    keys.push(id)
  }
  return keys
}

// Chunk loads (§2 Discovery, §6 idiom 6, §19 References only the resolver can see): the chunk URLs a chunk loader
// builds, folded from constants where they fold.
//
// - A **URL function** is a function of one parameter that builds a script URL by string concatenation (webpack's
//   `n.u`): its id table gives the chunk ids it maps.
// - A **load site** hands a URL expression that calls a URL function to the browser: a created script element's `src`
//   (`a.src = s`, a JSONP loader), `importScripts(…)` (a worker's loader) or `import(…)` (an ESM chunk loader).
// - Its URL is folded once per chunk id the URL function maps, under ECMA-262's `+` for strings and numbers (Principle
//   2). A name folds to the values its reaching definitions give, and a member `o.p` to the values every plain
//   assignment `o.p = v` to the same variable `o` gives. A plain parameter folds to the arguments every call of its
//   function the code shows passes it, so a URL handed to webpack's script-loading helper (`n.l(url, done, key, id)`)
//   folds at its callers. Anything else is unknown. Each constant alternative is a chunk URL, and an unknown alternative
//   leaves only the URL's folded constant prefix, which decides whether a URL that doesn't fold is local (§2).
// - A created script element's **integrity** (`o.integrity = u[a]`, `u` a constant table) is folded for each chunk id
//   as its URL is, the variable the URL function was given standing for the id: a value that folds to one constant is
//   the chunk reference's integrity, and any other is none (§17 Integrity).
//
// Chunk ids are build-local: they decide which URLs are references, never identity (§6 Reporting).

import { walkTree, type AstNode } from './ast.ts'
import type { BindingResolver } from './binding.ts'
import { definitionsOf, shadowedNameOf, type Definitions, type VariableKey } from './definitions.ts'
import { literalKey } from './keys.ts'
import { lineStarts, locate } from './line-starts.ts'
import { parse } from './parse.ts'
import { scopeRules } from './scope.ts'
import type { GeneratedLocation } from './types.ts'

/** How a load site loads a chunk's URL. */
export type ChunkLoad = 'element' | 'import-scripts' | 'import'

/**
 * A chunk load site: how it loads, where its URL expression is, the URLs it folds to, one per constant alternative, and,
 * when some alternative doesn't fold, the constant prefix every such alternative starts with ('' for none).
 */
export interface ChunkLoadSite {
  load: ChunkLoad
  location: GeneratedLocation
  urls: string[]
  prefix?: string
  /**
   * The integrity value the code sets on the chunk's script element for each URL, when it folds to one constant for
   * that URL (§17 Integrity): `o.integrity = u[a]`, with `u` a constant table by chunk id. A URL without one has
   * none.
   */
  integrity?: Record<string, string>
}

/** How many alternatives a URL may fold to before it counts as unknown. */
const maxAlternatives = 64

/** The chunk load sites of an artifact's code (above). None when it doesn't parse, or has no URL function. */
export function chunkLoadSites(text: string, sourceType: 'script' | 'module', bindings: BindingResolver): ChunkLoadSite[] {
  if (!mayLoadChunks(text)) return []
  const parsed = parse(text, sourceType)
  if ('error' in parsed) return []
  const { program } = parsed
  const candidates = chunkCandidates(program)
  if (candidates.functions.size === 0 || candidates.sites.length === 0) return []
  const definitions = definitionsOf(program, scopeRules(program, sourceType, bindings))
  return foldChunkSites(candidates, new Folder(program, definitions, candidates.functions), lineStarts(text))
}

/** A cheap test first: a URL function concatenates a script URL, and a load site names one of these. */
export const mayLoadChunks = (text: string): boolean => /\.[cm]?js/i.test(text) && /\.src\b|importScripts|import\s*\(/.test(text)

/** A program's URL functions and the load sites that may call one (`chunkCandidates`). */
export interface ChunkCandidates {
  functions: Map<AstNode, ReadonlySet<string> | 'any'>
  sites: { load: ChunkLoad; url: AstNode; object?: AstNode }[]
}

/** A program's URL functions, and the load sites whose URL expressions may call one. */
export function chunkCandidates(program: AstNode): ChunkCandidates {
  const functions = new Map<AstNode, ReadonlySet<string> | 'any'>()
  const sites: { load: ChunkLoad; url: AstNode; object?: AstNode }[] = []
  walkTree(program, {
    enter(node) {
      if (functionTypes.has(node.type)) {
        const table = urlFunctionIds(node)
        if (table !== undefined) functions.set(node, table)
      } else if (node.type === 'ImportExpression') {
        const source = node['source'] as AstNode
        if (!isLiteral(source)) sites.push({ load: 'import', url: source })
      } else if (node.type === 'CallExpression') {
        const callee = node['callee'] as AstNode
        const [first] = node['arguments'] as AstNode[]
        const named =
          (callee.type === 'Identifier' && callee['name'] === 'importScripts') ||
          (callee.type === 'MemberExpression' && propertyName(callee) === 'importScripts')
        if (named && first !== undefined && first.type !== 'SpreadElement' && !isLiteral(first)) {
          sites.push({ load: 'import-scripts', url: first })
        }
      } else if (node.type === 'AssignmentExpression' && node['operator'] === '=') {
        const left = node['left'] as AstNode
        if (left.type === 'MemberExpression' && propertyName(left) === 'src') {
          sites.push({ load: 'element', url: node['right'] as AstNode, object: left['object'] as AstNode })
        }
      }
    },
  })
  return { functions, sites }
}

/** The chunk load sites among a program's candidates, folded with `folder`, located through `starts`. */
export function foldChunkSites({ functions, sites }: ChunkCandidates, folder: Folder, starts: readonly number[]): ChunkLoadSite[] {
  if (functions.size === 0) return []
  const found: ChunkLoadSite[] = []
  for (const { load, url, object } of sites) {
    if (object !== undefined && !folder.isScriptElement(object)) continue
    const folded = folder.chunkUrls(url, object)
    if (folded === undefined) continue
    found.push({
      load,
      location: locate(starts, url.start, url.end),
      urls: folded.urls,
      ...(folded.prefix === undefined ? {} : { prefix: folded.prefix }),
      ...(folded.integrity === undefined ? {} : { integrity: folded.integrity }),
    })
  }
  return found
}

const functionTypes: ReadonlySet<string> = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/** Whether a call creates a script element: `X.createElement("script")`, the tag name in any ASCII case. */
export function isScriptCreation(call: AstNode): boolean {
  const callee = call['callee'] as AstNode
  const [tag] = call['arguments'] as AstNode[]
  return (
    callee.type === 'MemberExpression' &&
    propertyName(callee) === 'createElement' &&
    tag?.type === 'Literal' &&
    typeof tag['value'] === 'string' &&
    tag['value'].toLowerCase() === 'script'
  )
}

const isLiteral = (node: AstNode): boolean =>
  (node.type === 'Literal' && typeof node['value'] === 'string') ||
  (node.type === 'TemplateLiteral' && (node['expressions'] as AstNode[]).length === 0)

/** A member expression's constant name: `o.x` or `o["x"]`. */
export function propertyName(node: AstNode): string | undefined {
  const property = node['property'] as AstNode
  if (node['computed'] !== true) return property.type === 'Identifier' ? (property['name'] as string) : undefined
  return property.type === 'Literal' && typeof property['value'] === 'string' ? property['value'] : undefined
}

/** The names code calls the global object by. */
const globalNames: ReadonlySet<string> = new Set(['window', 'self', 'globalThis'])

const scriptUrl = /\.[cm]?js(?:$|[?#])/i

/**
 * The ids a URL function maps, 'any' when it maps every id, or undefined when the function is none: it has one plain
 * parameter, and its body concatenates a string literal naming a `.js`, `.mjs` or `.cjs` file and a use of that
 * parameter. Each object literal it indexes with the parameter and no fallback maps only its constant keys.
 */
function urlFunctionIds(fn: AstNode): ReadonlySet<string> | 'any' | undefined {
  const params = fn['params'] as AstNode[]
  if (params.length !== 1 || params[0]!.type !== 'Identifier') return undefined
  const param = params[0]!['name'] as string
  let script = false
  let used = false
  const constraints: string[][] = []
  walkTree(fn['body'] as AstNode, {
    enter(node, parent) {
      if (node !== fn['body'] && functionTypes.has(node.type)) return false
      if (node.type === 'Literal' && typeof node['value'] === 'string' && scriptUrl.test(node['value'])) script = true
      if (node.type === 'Identifier' && node['name'] === param && !(parent?.type === 'MemberExpression' && parent['property'] === node && parent['computed'] !== true)) {
        used = true
      }
      if (node.type === 'MemberExpression' && node['computed'] === true) {
        const property = node['property'] as AstNode
        const object = node['object'] as AstNode
        const fallback = parent?.type === 'LogicalExpression' && parent['left'] === node
        if (property.type === 'Identifier' && property['name'] === param && object.type === 'ObjectExpression' && !fallback) {
          const keys = objectKeys(object)
          if (keys !== undefined) constraints.push(keys)
        }
      }
      return undefined
    },
  })
  if (!script || !used) return undefined
  if (constraints.length === 0) return 'any'
  const [first, ...rest] = constraints
  return new Set(first!.filter((id) => rest.every((keys) => keys.includes(id))))
}

/** An object literal's constant keys, or undefined when one isn't constant. */
function objectKeys(object: AstNode): string[] | undefined {
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

/** A folded value: the primitives it may be, and whether it may be something unknown too. */
interface Folded {
  values: (string | number)[]
  unknown: boolean
}

const unknown: Folded = { values: [], unknown: true }

/** How deep a fold follows names, members and URL functions. */
const maxDepth = 12

/**
 * Folds URL expressions in one artifact's program (above), and the URLs code builds for the browser to load (§2 Computed
 * URLs): besides string concatenation, templates, `new URL(x, base)` for a folded `x` and a base the scan knows,
 * with its `.href` and `toString()`, and `import.meta.url`, the artifact's own URL. A base of `location` or
 * `document.baseURI` is the environment's base URL, which the browser resolves a relative URL against anyway, so `x`
 * folds to itself there. A parameter folds to the arguments every call the program shows passes it, when the
 * function is called by a name or member it is bound to, or where it is written.
 */
export class Folder {
  /** The plain assignments to each member name, by the object's variable. */
  private members?: Map<string, { key: VariableKey; right: AstNode | undefined }[]>
  /** While a URL is folded, the variables a URL function is given, which hold the chunk id. */
  private idKeys: VariableKey[] | undefined
  /** While an integrity value is folded, the variables that hold the chunk id. */
  private ids: VariableKey[] | undefined
  /** Each node's parent. */
  private parents?: Map<AstNode, AstNode>
  /** The calls of the program, by the name or member name their callee names. */
  private calls?: Map<string, AstNode[]>
  /** The function declarations of the program, by name. */
  private declarations?: Map<string, AstNode[]>

  private readonly program: AstNode
  private readonly definitions: Definitions
  private readonly functions: ReadonlyMap<AstNode, ReadonlySet<string> | 'any'>
  private readonly url: string

  constructor(
    program: AstNode,
    definitions: Definitions,
    functions: ReadonlyMap<AstNode, ReadonlySet<string> | 'any'>,
    url = '',
  ) {
    this.program = program
    this.definitions = definitions
    this.functions = functions
    this.url = url
  }

  /**
   * What a URL expression folds to outside any chunk loader: its constant string alternatives, and whether some
   * alternative is unknown. A chunk id never takes a value here.
   */
  strings(node: AstNode): { values: string[]; unknown: boolean; chunk: boolean } {
    const called = new Set<AstNode>()
    const folded = this.fold(node, null, 0, called)
    const values = [...new Set(folded.values.map(String))].sort()
    return { values, unknown: folded.unknown, chunk: called.size > 0 }
  }

  /** The variable an identifier names, when it is a free name of the global object that no code assigns. */
  private freeGlobal(node: AstNode): string | undefined {
    if (node.type !== 'Identifier') return undefined
    const key = this.definitions.keyOf(node)
    if (key === undefined || key.scope !== 'global' || this.definitions.of(key).length > 0) return undefined
    return key.name
  }

  /**
   * Whether an expression is the environment's base URL as a base of `new URL` (§2 Computed URLs): `location`,
   * its `href`, or `document.baseURI`, through the global object's names.
   */
  private isEnvironmentBase(node: AstNode): boolean {
    const path: string[] = []
    let at = node
    while (at.type === 'MemberExpression') {
      const name = propertyName(at)
      if (name === undefined) return false
      path.unshift(name)
      at = at['object'] as AstNode
    }
    const root = this.freeGlobal(at)
    if (root === undefined) return false
    const names = [root, ...path]
    while (names.length > 1 && globalNames.has(names[0]!)) names.shift()
    const spelt = names.join('.')
    return (
      spelt === 'location' ||
      spelt === 'location.href' ||
      spelt === 'document.baseURI' ||
      spelt === 'document.location' ||
      spelt === 'document.location.href'
    )
  }

  /**
   * Whether a base is the environment's base URL (`isEnvironmentBase`), also through the one value a name or member is
   * given, or as the left side of `||`, which is never empty there (webpack's `n.b = document.baseURI || …`).
   */
  private isBase(node: AstNode, depth = 0): boolean {
    if (this.isEnvironmentBase(node)) return true
    if (depth > maxDepth) return false
    if (node.type === 'LogicalExpression' && node['operator'] === '||') return this.isBase(node['left'] as AstNode, depth + 1)
    const one = this.resolveMember(this.resolveName(node))
    return one !== node && this.isBase(one, depth + 1)
  }

  /** Whether an expression is a URL object: `new URL(…)`, or a name whose one definition is one. */
  private isUrlObject(node: AstNode): boolean {
    const resolved = this.resolveName(node)
    return resolved.type === 'NewExpression' && this.freeGlobal(resolved['callee'] as AstNode) === 'URL'
  }

  /** `new URL(x, base)` (URL Standard § URL constructor): each alternative of `x` against each of `base`. */
  private newUrl(node: AstNode, id: string | null, depth: number, called: Set<AstNode>, param?: { name: string; id: string | null }): Folded {
    const [input, base] = node['arguments'] as AstNode[]
    if (input === undefined || input.type === 'SpreadElement' || base?.type === 'SpreadElement') return unknown
    const x = this.fold(input, id, depth + 1, called, param)
    const strings = x.values.map(String)
    if (base === undefined || (base.type === 'Identifier' && base['name'] === 'undefined' && this.freeGlobal(base) !== undefined)) {
      // With no base, a relative URL throws, which gives nothing.
      return { values: strings.flatMap((value) => URL.parse(value)?.href ?? []), unknown: x.unknown }
    }
    if (this.isBase(base)) {
      return { values: strings.map((value) => URL.parse(value)?.href ?? value), unknown: x.unknown }
    }
    const bases = this.fold(base, id, depth + 1, called, param)
    const values = new Set<string>()
    for (const b of bases.values) for (const value of strings) {
      const href = URL.parse(value, String(b))?.href
      if (href !== undefined) values.add(href)
    }
    if (values.size > maxAlternatives) return unknown
    return { values: [...values], unknown: x.unknown || bases.unknown }
  }

  /**
   * The arguments the calls of a parameter's function pass it, or undefined when the parameter is none, or no call is
   * shown, or one spreads before it or passes none (`callsOf`).
   */
  private parameterArguments(key: VariableKey): AstNode[] | undefined {
    const fn = key.scope
    if (fn === 'global' || !functionTypes.has(fn.type)) return undefined
    const index = (fn['params'] as AstNode[]).findIndex((param) => param.type === 'Identifier' && param['name'] === key.name)
    if (index < 0) return undefined
    const calls = this.callsOf(fn)
    if (calls.length === 0) return undefined
    const args: AstNode[] = []
    for (const call of calls) {
      const passed = (call['arguments'] as AstNode[]).slice(0, index + 1)
      if (passed.some((arg) => arg.type === 'SpreadElement')) return undefined
      const arg = passed[index]
      if (arg === undefined) return undefined
      args.push(arg)
    }
    return args
  }

  /**
   * The chunk URLs a load site's URL expression folds to, and the folded prefix of its unknown alternatives, or
   * undefined when it calls no URL function, so that it is no chunk load.
   */
  chunkUrls(url: AstNode, element?: AstNode): { urls: string[]; prefix?: string; integrity?: Record<string, string> } | undefined {
    const called = new Set<AstNode>()
    this.fold(url, null, 0, called)
    if (called.size === 0) return undefined
    const ids = new Set<string>()
    let every = false
    for (const fn of called) {
      const table = this.functions.get(fn)!
      if (table === 'any') every = true
      else for (const id of table) ids.add(id)
    }
    const urls = new Set<string>()
    let open = every
    // Each URL's integrity value, or null when two chunk ids give it different ones, or one doesn't fold.
    const integrity = new Map<string, string | null>()
    const integrities = element === undefined ? [] : this.integrityWrites(element)
    for (const id of [...ids].sort()) {
      const idKeys: VariableKey[] = []
      this.idKeys = idKeys
      const folded = this.fold(url, id, 0, new Set())
      this.idKeys = undefined
      for (const value of folded.values) if (typeof value === 'string') urls.add(value)
      if (folded.unknown || folded.values.some((value) => typeof value !== 'string')) open = true
      if (integrities.length === 0) continue
      // The chunk id the URL function was given is the id here: `u[a]` reads the table at it.
      this.ids = idKeys
      const value = union(integrities.map((right) => this.fold(right, id, 0, new Set())))
      this.ids = undefined
      const one = !value.unknown && value.values.length === 1 && typeof value.values[0] === 'string' ? value.values[0] : null
      for (const each of folded.values) {
        if (typeof each !== 'string' || (value.values.length === 0 && !value.unknown)) continue
        const before = integrity.get(each)
        integrity.set(each, before === undefined || before === one ? one : null)
      }
    }
    const result: { urls: string[]; prefix?: string; integrity?: Record<string, string> } = { urls: [...urls].sort() }
    if (open || ids.size === 0) result.prefix = this.prefix(url)
    const set = [...integrity].filter((entry): entry is [string, string] => entry[1] !== null).sort(([a], [b]) => (a < b ? -1 : 1))
    if (set.length > 0) result.integrity = Object.fromEntries(set)
    return result
  }

  /** What each plain `element.integrity = v` assignment to the same variable as `element` assigns. */
  private integrityWrites(element: AstNode): AstNode[] {
    return (this.assigned(element, 'integrity') ?? []).filter((right): right is AstNode => right !== undefined)
  }

  /** Whether `object` is a script element the code creates: `document.createElement("script")`. */
  isScriptElement(object: AstNode): boolean {
    return this.elementsOf(object).size > 0
  }

  /**
   * The script elements the code creates (`X.createElement("script")`, each by its call) that an expression may be:
   * the call itself, or a name whose reaching definitions are, through other names, parentheses, comma sequences and
   * assignments.
   */
  elementsOf(node: AstNode, depth = 0): Set<AstNode> {
    const found = new Set<AstNode>()
    if (depth > maxDepth) return found
    switch (node.type) {
      case 'ParenthesizedExpression':
        return this.elementsOf(node['expression'] as AstNode, depth + 1)
      case 'SequenceExpression':
        return this.elementsOf((node['expressions'] as AstNode[]).at(-1)!, depth + 1)
      case 'AssignmentExpression':
        return node['operator'] === '=' ? this.elementsOf(node['right'] as AstNode, depth + 1) : found
      case 'CallExpression':
        if (isScriptCreation(node)) found.add(node)
        return found
      case 'Identifier': {
        const key = this.definitions.keyOf(node)
        if (key === undefined) return found
        for (const { source, pattern } of this.definitions.reaching(node, key).definitions) {
          if (source === undefined || pattern.type !== 'Identifier') continue
          for (const element of this.elementsOf(source, depth + 1)) found.add(element)
        }
        return found
      }
      default:
        return found
    }
  }

  /** The constant prefix of a URL expression: its leading `+` operands that fold to one string, joined. */
  private prefix(url: AstNode, depth = 0): string {
    let prefix = ''
    for (const operand of operands(this.resolveName(url))) {
      const folded = this.fold(operand, null, 0, new Set())
      if (folded.unknown || folded.values.length !== 1 || typeof folded.values[0] !== 'string') {
        // The operand's own constant prefix, through the one expression a name or member is given.
        const one = this.resolveMember(this.resolveName(operand))
        if (depth < maxDepth && one !== operand) prefix += this.prefix(one, depth + 1)
        break
      }
      prefix += folded.values[0]
    }
    return prefix
  }

  /** A member `o.p` that one plain assignment gives a value, followed to it. */
  private resolveMember(node: AstNode): AstNode {
    if (node.type !== 'MemberExpression') return node
    const name = propertyName(node)
    const assigned = name === undefined ? undefined : this.assigned(node['object'] as AstNode, name)
    return assigned?.length === 1 && assigned[0] !== undefined ? assigned[0] : node
  }

  /** A name whose one reaching definition is an expression, followed to it: `s` in `var s = n.p + n.u(t)`. */
  private resolveName(node: AstNode, depth = 0): AstNode {
    if (node.type !== 'Identifier' || depth > maxDepth) return node
    const key = this.definitions.keyOf(node)
    if (key === undefined) return node
    const reaching = this.definitions.reaching(node, key)
    const [only] = reaching.definitions
    if (reaching.start && reaching.definitions.length === 0) {
      const args = this.parameterArguments(key)
      return args?.length === 1 ? this.resolveName(args[0]!, depth + 1) : node
    }
    if (reaching.start || reaching.definitions.length !== 1 || only!.source === undefined || only!.pattern.type !== 'Identifier') {
      return node
    }
    return this.resolveName(only!.source, depth + 1)
  }

  /**
   * What `node` folds to with the URL functions it calls given the chunk id `id` (none: unknown), adding every URL
   * function it calls to `called`.
   */
  private fold(node: AstNode, id: string | null, depth: number, called: Set<AstNode>, param?: { name: string; id: string | null }): Folded {
    if (depth > maxDepth) return unknown
    switch (node.type) {
      case 'Literal':
        return typeof node['value'] === 'string' || typeof node['value'] === 'number'
          ? { values: [node['value']], unknown: false }
          : unknown
      case 'TemplateLiteral': {
        // Each substitution is converted with ToString, so a template is the concatenation of its parts.
        const quasis = node['quasis'] as AstNode[]
        const expressions = node['expressions'] as AstNode[]
        let folded: Folded = { values: [''], unknown: false }
        for (const [index, quasi] of quasis.entries()) {
          const cooked = (quasi['value'] as { cooked: string | null }).cooked
          if (cooked === null) return unknown
          folded = { values: folded.values.map((value) => String(value) + cooked), unknown: folded.unknown }
          const expression = expressions[index]
          if (expression === undefined) continue
          const part = this.fold(expression, id, depth + 1, called, param)
          const values = new Set<string>()
          for (const a of folded.values) for (const b of part.values) values.add(String(a) + String(b))
          if (values.size > maxAlternatives) return unknown
          folded = { values: [...values], unknown: folded.unknown || part.unknown }
        }
        return folded
      }
      case 'NewExpression':
        return this.freeGlobal(node['callee'] as AstNode) === 'URL' ? this.newUrl(node, id, depth, called, param) : unknown
      case 'ParenthesizedExpression':
        return this.fold(node['expression'] as AstNode, id, depth + 1, called, param)
      case 'BinaryExpression': {
        if (node['operator'] !== '+') return unknown
        const left = this.fold(node['left'] as AstNode, id, depth + 1, called, param)
        const right = this.fold(node['right'] as AstNode, id, depth + 1, called, param)
        const values = new Set<string | number>()
        for (const a of left.values) for (const b of right.values) values.add(add(a, b))
        if (values.size > maxAlternatives) return unknown
        return { values: [...values], unknown: left.unknown || right.unknown }
      }
      case 'ConditionalExpression': {
        const consequent = this.fold(node['consequent'] as AstNode, id, depth + 1, called, param)
        const alternate = this.fold(node['alternate'] as AstNode, id, depth + 1, called, param)
        return union([consequent, alternate])
      }
      case 'LogicalExpression': {
        // Inside a URL function, a table lookup with a fallback for the id: the left value when it is truthy.
        if (node['operator'] !== '||' || param === undefined) return unknown
        const left = this.fold(node['left'] as AstNode, id, depth + 1, called, param)
        if (left.unknown) return unknown
        if (left.values.length > 0 && left.values.every(Boolean)) return left
        const right = this.fold(node['right'] as AstNode, id, depth + 1, called, param)
        return union([{ values: left.values.filter(Boolean), unknown: false }, right])
      }
      case 'Identifier': {
        if (param !== undefined && node['name'] === param.name) {
          return param.id === null ? unknown : { values: [param.id], unknown: false }
        }
        const key = this.definitions.keyOf(node)
        if (key === undefined) return unknown
        if (id !== null && this.ids?.some((each) => each.scope === key.scope && each.name === key.name)) {
          return { values: [id], unknown: false }
        }
        const reaching = this.definitions.reaching(node, key)
        const parts = reaching.definitions.map(({ source, pattern, logical }) =>
          source === undefined || pattern.type !== 'Identifier' || logical
            ? unknown
            : this.fold(source, id, depth + 1, called, param),
        )
        // A parameter starts with the argument each call of its function the code shows passes it.
        return union(reaching.start ? [...parts, this.argument(key, id, depth, called)] : parts)
      }
      case 'MemberExpression': {
        const object = node['object'] as AstNode
        if (param !== undefined && object.type === 'ObjectExpression' && node['computed'] === true) {
          return this.lookup(object, node['property'] as AstNode, param)
        }
        if (node['computed'] === true && this.ids !== undefined) return this.tableRead(object, node['property'] as AstNode, id, depth, called)
        const name = propertyName(node)
        if (name === undefined) return unknown
        if (object.type === 'MetaProperty' && name === 'url' && this.url !== '') return { values: [this.url], unknown: false }
        if (name === 'href' && this.isUrlObject(object)) return this.fold(object, id, depth + 1, called, param)
        const assigned = this.assigned(object, name)
        if (assigned === undefined || assigned.length === 0) return unknown
        return union(assigned.map((right) => (right === undefined ? unknown : this.fold(right, id, depth + 1, called, param))))
      }
      case 'CallExpression': {
        const callee = node['callee'] as AstNode
        if (callee.type === 'MemberExpression' && propertyName(callee) === 'toString' && (node['arguments'] as AstNode[]).length === 0) {
          const object = this.fold(callee['object'] as AstNode, id, depth + 1, called, param)
          return { values: object.values.map(String), unknown: object.unknown }
        }
        const fn = this.urlFunction(callee)
        const [argument] = node['arguments'] as AstNode[]
        if (fn === undefined || argument === undefined) return unknown
        called.add(fn)
        if (argument.type === 'Identifier') {
          const key = this.definitions.keyOf(argument)
          if (key !== undefined) this.idKeys?.push(key)
        }
        // Outside a chunk id's fold, a call whose argument folds to one constant folds at it (`n.u(5)`).
        let given = id
        if (given === null && this.ids === undefined && this.idKeys === undefined && argument.type !== 'SpreadElement') {
          const folded = this.fold(argument, null, depth + 1, called, param)
          if (!folded.unknown && folded.values.length === 1) given = String(folded.values[0])
        }
        if (given === null) return unknown
        const name = ((fn['params'] as AstNode[])[0]!)['name'] as string
        const body = fn['body'] as AstNode
        const returned = body.type === 'BlockStatement' ? onlyReturn(body) : body
        if (returned === undefined) return unknown
        return this.fold(returned, given, depth + 1, called, { name, id: given })
      }
      default:
        return unknown
    }
  }

  /**
   * `t[k]`, where `t` is a variable whose only definition is an object literal of constant keys and `k` folds to one
   * key: the value the literal has there, or `undefined` (no value) when it has none.
   */
  private tableRead(object: AstNode, property: AstNode, id: string | null, depth: number, called: Set<AstNode>): Folded {
    if (object.type !== 'Identifier') return unknown
    const key = this.definitions.keyOf(object)
    if (key === undefined) return unknown
    const reaching = this.definitions.reaching(object, key)
    const [only] = reaching.definitions
    if (reaching.start || reaching.definitions.length !== 1 || only!.source?.type !== 'ObjectExpression') return unknown
    const folded = this.fold(property, id, depth + 1, called)
    if (folded.unknown || folded.values.length !== 1) return unknown
    const name = String(folded.values[0])
    for (const entry of only!.source['properties'] as AstNode[]) {
      if (entry.type !== 'Property' || entry['computed'] === true || entry['kind'] !== 'init') return unknown
      const at = entry['key'] as AstNode
      if ((at.type === 'Identifier' ? (at['name'] as string) : literalKey(at)) !== name) continue
      const value = entry['value'] as AstNode
      return value.type === 'Literal' && typeof value['value'] === 'string' ? { values: [value['value']], unknown: false } : unknown
    }
    return { values: [], unknown: false }
  }

  /** `{k: v, …}[param]` in a URL function, for the chunk id the parameter holds. */
  private lookup(object: AstNode, property: AstNode, param: { name: string; id: string | null }): Folded {
    if (property.type !== 'Identifier' || property['name'] !== param.name || param.id === null) return unknown
    for (const entry of object['properties'] as AstNode[]) {
      if (entry.type !== 'Property' || entry['computed'] === true) return unknown
      const key = entry['key'] as AstNode
      const id = key.type === 'Identifier' ? (key['name'] as string) : literalKey(key)
      if (id !== param.id) continue
      const value = entry['value'] as AstNode
      return value.type === 'Literal' && (typeof value['value'] === 'string' || typeof value['value'] === 'number')
        ? { values: [value['value']], unknown: false }
        : unknown
    }
    // A missing key reads `undefined`, which only a fallback can turn into a URL.
    return { values: [], unknown: false }
  }

  /**
   * The start value of the variable `key` when it is a plain parameter of its function: the union of the arguments the
   * function's calls pass it (`n.l(s, …, t)`, webpack's script-loading helper). Unknown for any other variable, a
   * function with no call the code shows, or a call that spreads before it.
   */
  private argument(key: VariableKey, id: string | null, depth: number, called: Set<AstNode>): Folded {
    const fn = key.scope
    if (fn === 'global' || !functionTypes.has(fn.type)) return unknown
    const index = (fn['params'] as AstNode[]).findIndex((param) => param.type === 'Identifier' && param['name'] === key.name)
    if (index < 0) return unknown
    const calls = this.callsOf(fn)
    if (calls.length === 0) return unknown
    return union(
      calls.map((call) => {
        const args = call['arguments'] as AstNode[]
        if (args.slice(0, index + 1).some((arg) => arg.type === 'SpreadElement')) return unknown
        const arg = args[index]
        return arg === undefined ? unknown : this.fold(arg, id, depth + 1, called)
      }),
    )
  }

  /**
   * The calls of a function the code shows: an immediate call of it, or a call of the name or member it is bound to
   * (`n.l = (…) => {…}`, `var f = …`, `function f(…) {…}`) that names it alone.
   */
  private callsOf(fn: AstNode): AstNode[] {
    this.parents ??= parentsOf(this.program)
    let at: AstNode = fn
    let parent = this.parents.get(at)
    while (parent?.type === 'ParenthesizedExpression') parent = this.parents.get((at = parent))
    if (parent === undefined) return []
    if (parent.type === 'CallExpression' && parent['callee'] === at) return [parent]
    let name: string | undefined
    if (fn.type === 'FunctionDeclaration') name = ((fn['id'] as AstNode | null)?.['name'] as string | undefined)
    else if (parent.type === 'VariableDeclarator' && parent['init'] === at) {
      const id = parent['id'] as AstNode
      if (id.type === 'Identifier') name = id['name'] as string
    } else if (parent.type === 'AssignmentExpression' && parent['right'] === at) {
      const left = parent['left'] as AstNode
      name = left.type === 'Identifier' ? (left['name'] as string) : left.type === 'MemberExpression' ? propertyName(left) : undefined
    }
    if (name === undefined) return []
    this.calls ??= callsByName(this.program)
    return (this.calls.get(name) ?? []).filter((call) => this.bound(call['callee'] as AstNode) === fn)
  }

  /** The URL function a callee names: a function bound to a name, or plainly assigned to a member, and nothing else. */
  private urlFunction(callee: AstNode): AstNode | undefined {
    const fn = this.bound(callee)
    return fn !== undefined && this.functions.has(fn) ? fn : undefined
  }

  /** The function a callee names: a function bound to a name, or plainly assigned to a member, and nothing else. */
  private bound(callee: AstNode): AstNode | undefined {
    let sources: (AstNode | undefined)[]
    if (callee.type === 'Identifier') {
      const key = this.definitions.keyOf(callee)
      if (key === undefined) return undefined
      const reaching = this.definitions.reaching(callee, key)
      if (reaching.start && reaching.definitions.length === 0) {
        // A function declaration's binding starts with the function.
        return this.declared(callee['name'] as string, key)
      }
      sources = reaching.definitions.map(({ source }) => source)
    } else if (callee.type === 'MemberExpression') {
      const name = propertyName(callee)
      sources = (name === undefined ? undefined : this.assigned(callee['object'] as AstNode, name)) ?? []
    } else return undefined
    if (sources.length !== 1) return undefined
    const [only] = sources
    return only !== undefined && functionTypes.has(only.type) ? only : undefined
  }

  /** The function declaration that declares the variable `key`, named `name`, if one does. */
  private declared(name: string, key: VariableKey): AstNode | undefined {
    const shadowed = shadowedNameOf(key.scope)
    if (shadowed !== undefined) return this.functions.has(shadowed) ? shadowed : undefined
    if (key.scope !== 'global' && this.functions.has(key.scope)) return key.scope
    this.declarations ??= functionDeclarations(this.program)
    return (this.declarations.get(name) ?? []).find((fn) => {
      const declared = this.definitions.keyOf(fn['id'] as AstNode)
      return declared !== undefined && declared.scope === key.scope && declared.name === key.name
    })
  }

  /**
   * What each assignment to `object.name` assigns, when `object` is a variable: undefined for a write that isn't a plain
   * `=`, or undefined for the whole when the object is no variable.
   */
  private assigned(object: AstNode, name: string): (AstNode | undefined)[] | undefined {
    if (object.type !== 'Identifier') return undefined
    const key = this.definitions.keyOf(object)
    if (key === undefined) return undefined
    this.members ??= this.indexMembers()
    return (this.members.get(name) ?? [])
      .filter((write) => write.key.scope === key.scope && write.key.name === key.name)
      .map(({ right }) => right)
  }

  private indexMembers(): Map<string, { key: VariableKey; right: AstNode | undefined }[]> {
    const members = new Map<string, { key: VariableKey; right: AstNode | undefined }[]>()
    const record = (target: AstNode, right: AstNode | undefined) => {
      if (target.type !== 'MemberExpression') return
      const object = target['object'] as AstNode
      const name = propertyName(target)
      if (object.type !== 'Identifier' || name === undefined) return
      const key = this.definitions.keyOf(object)
      if (key === undefined) return
      const list = members.get(name)
      if (list === undefined) members.set(name, [{ key, right }])
      else list.push({ key, right })
    }
    walkTree(this.program, {
      enter(node) {
        if (node.type === 'AssignmentExpression') {
          record(node['left'] as AstNode, node['operator'] === '=' ? (node['right'] as AstNode) : undefined)
        } else if (node.type === 'UpdateExpression') record(node['argument'] as AstNode, undefined)
      },
    })
    return members
  }
}

/** ECMA-262's `+` on two primitives that are strings or numbers. */
const add = (a: string | number, b: string | number): string | number =>
  typeof a === 'number' && typeof b === 'number' ? a + b : String(a) + String(b)

function union(parts: Folded[]): Folded {
  const values = new Set<string | number>()
  let open = false
  for (const part of parts) {
    open ||= part.unknown
    for (const value of part.values) values.add(value)
  }
  if (values.size > maxAlternatives) return unknown
  return { values: [...values], unknown: open }
}

/** The operands of a `+` chain, left to right. */
function operands(node: AstNode): AstNode[] {
  if (node.type === 'ParenthesizedExpression') return operands(node['expression'] as AstNode)
  if (node.type !== 'BinaryExpression' || node['operator'] !== '+') return [node]
  return [...operands(node['left'] as AstNode), ...operands(node['right'] as AstNode)]
}

/** The expression a block's only statement returns. */
function onlyReturn(body: AstNode): AstNode | undefined {
  const statements = body['body'] as AstNode[]
  if (statements.length !== 1 || statements[0]!.type !== 'ReturnStatement') return undefined
  return (statements[0]!['argument'] as AstNode | null) ?? undefined
}

/** Each node's parent in `program`. */
function parentsOf(program: AstNode): Map<AstNode, AstNode> {
  const parents = new Map<AstNode, AstNode>()
  walkTree(program, {
    enter(node, parent) {
      if (parent !== null) parents.set(node, parent)
    },
  })
  return parents
}

/** The calls of `program` whose callee is a name or a member with a constant name, by that name. */
function callsByName(program: AstNode): Map<string, AstNode[]> {
  const calls = new Map<string, AstNode[]>()
  walkTree(program, {
    enter(node) {
      if (node.type !== 'CallExpression') return
      const callee = node['callee'] as AstNode
      const name =
        callee.type === 'Identifier' ? (callee['name'] as string) : callee.type === 'MemberExpression' ? propertyName(callee) : undefined
      if (name === undefined) return
      const list = calls.get(name)
      if (list === undefined) calls.set(name, [node])
      else list.push(node)
    },
  })
  return calls
}

/** The function declarations of `program`, by name. */
function functionDeclarations(program: AstNode): Map<string, AstNode[]> {
  const found = new Map<string, AstNode[]>()
  walkTree(program, {
    enter(node) {
      if (node.type !== 'FunctionDeclaration') return
      const id = node['id'] as AstNode | null
      if (id === null) return
      const name = id['name'] as string
      const list = found.get(name)
      if (list === undefined) found.set(name, [node])
      else list.push(node)
    },
  })
  return found
}

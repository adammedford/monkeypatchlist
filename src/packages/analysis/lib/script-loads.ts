// Script loads only the resolver can see (§2 Discovery, §19 References only the resolver can see): the chunk URLs a
// chunk loader builds (`chunk-loads.ts`), the scripts code injects, and worker URLs that aren't literals.
//
// - An **injected script** is a script element the code creates (`X.createElement("script")`), gives a `src` and
//   inserts: any Node or Element insertion method, on any receiver, with the element as a node argument, inserts
//   it, and `src` counts whether it is set before or after. Writes are followed flow-insensitively, per element: every
//   `src` write is an alternative, as is every `type`. A `setAttribute` whose key doesn't fold touches neither.
// - Its `src` alternatives that fold are its URLs, each unresolved: discovery resolves them against each document's
//   base URL. An alternative that doesn't fold is one `unresolved-reference`. Its `type` is passed on as
//   folded, for discovery to judge as it judges an element's; an `integrity` that folds is carried, with each
//   constant it may be, for verification (§17). Its `noModule` is passed on as `no`, `yes` or, when the
//   writes differ or one doesn't fold, `maybe`: discovery judges what it does to a classic script.
// - **Literal code** an injected element carries, with no `src` (`s.text`, `.textContent`, `.innerText`, or an
//   appended `X.createTextNode(code)`), is nested code, compiled where the element is inserted.
// - A **worker URL** that isn't a literal (`new Worker`, `new SharedWorker`, `navigator.serviceWorker.register`,
//   `importScripts`) folds as `Folder` folds it; each constant alternative is a reference, and each alternative
//   that doesn't fold is one `unresolved-reference` at that alternative. Discovery owns what a worker call
//   is: which realm can make it, and whether its callee is the native.
//
// A URL expression that calls a chunk loader's URL function is a chunk load, not one of these.

import { walkTree, type AstNode } from './ast.ts'
import type { BindingResolver } from './binding.ts'
import {
  chunkCandidates,
  Folder,
  foldChunkSites,
  isScriptCreation,
  mayLoadChunks,
  propertyName,
  type ChunkLoadSite,
} from './chunk-loads.ts'
import { definitionsOf } from './definitions.ts'
import { lineStarts, locate } from './line-starts.ts'
import { parse } from './parse.ts'
import { scopeRules } from './scope.ts'
import type { GeneratedLocation } from './types.ts'

/**
 * An injected script's `src` write (above): where its value is, the URLs it folds to, where each alternative that
 * doesn't fold is, and the element's `type` alternatives (undefined: no `type` is set; null: one that doesn't fold)
 * the constants its `integrity` may be (none when it has no write, or one that doesn't fold), and whether its
 * `noModule` is set: every write is truthy, or every one is falsy or there is none, or the writes differ or one doesn't
 * fold.
 */
export interface InjectedSite {
  location: GeneratedLocation
  urls: string[]
  unknown: GeneratedLocation[]
  types: (string | null | undefined)[]
  integrity: string[]
  noModule: 'no' | 'yes' | 'maybe'
}

/** A worker URL that isn't a literal: where it is, the URLs it folds to, and where each unknown alternative is. */
export interface WorkerSite {
  location: GeneratedLocation
  urls: string[]
  unknown: GeneratedLocation[]
}

/** What an artifact's code loads that only the resolver can see. */
export interface ScriptLoads {
  chunks: ChunkLoadSite[]
  injected: InjectedSite[]
  workers: WorkerSite[]
}

const none: ScriptLoads = { chunks: [], injected: [], workers: [] }

/**
 * The script loads of an artifact's code at `url` (its own URL, for `import.meta.url`). None when it doesn't parse.
 */
export function scriptLoads(text: string, sourceType: 'script' | 'module', bindings: BindingResolver, url: string): ScriptLoads {
  const chunks = mayLoadChunks(text)
  const elements = /createElement/.test(text)
  const workers = /Worker|importScripts/.test(text)
  if (!chunks && !elements && !workers) return none
  const parsed = parse(text, sourceType)
  if ('error' in parsed) return none
  const { program } = parsed
  const candidates = chunkCandidates(program)
  const loadsChunks = chunks && candidates.functions.size > 0 && candidates.sites.length > 0
  // Only code that creates a script element, or calls a worker function with a URL that isn't a literal, needs folding.
  const needed = syntaxNeeds(program, elements, workers)
  if (!loadsChunks && !needed.elements && !needed.workers) return none
  const definitions = definitionsOf(program, scopeRules(program, sourceType, bindings))
  const folder = new Folder(program, definitions, candidates.functions, url)
  const starts = lineStarts(text)
  const at = (node: AstNode) => locate(starts, node.start, node.end)
  return {
    chunks: loadsChunks ? foldChunkSites(candidates, folder, starts) : [],
    injected: needed.elements ? injectedSites(program, folder, at) : [],
    workers: needed.workers ? workerSites(program, folder, at) : [],
  }
}

/** Whether a program creates a script element, and calls a worker function with a URL that isn't a literal. */
function syntaxNeeds(program: AstNode, elements: boolean, workers: boolean): { elements: boolean; workers: boolean } {
  const found = { elements: false, workers: false }
  if (!elements && !workers) return found
  walkTree(program, {
    enter(node) {
      if (found.elements === elements && found.workers === workers) return false
      if (elements && node.type === 'CallExpression' && isScriptCreation(node)) found.elements = true
      if (workers && (node.type === 'NewExpression' || node.type === 'CallExpression') && isWorkerCall(node)) {
        if ((node['arguments'] as AstNode[]).some((arg) => arg.type !== 'SpreadElement' && !isLiteral(arg))) found.workers = true
      }
      return undefined
    },
  })
  return found
}

/** The insertion methods of Node and Element, and which of their arguments are nodes: all, or one index. */
const insertions: ReadonlyMap<string, number | 'all'> = new Map<string, number | 'all'>([
  ['appendChild', 0],
  ['insertBefore', 0],
  ['replaceChild', 0],
  ['insertAdjacentElement', 1],
  ['append', 'all'],
  ['prepend', 'all'],
  ['before', 'all'],
  ['after', 'all'],
  ['replaceWith', 'all'],
])

/** The members that set a script element's code, as text. */
const textMembers: ReadonlySet<string> = new Set(['text', 'textContent', 'innerText'])

/** What code does to one script element it creates. */
interface Element {
  src: AstNode[]
  type: AstNode[]
  integrity: AstNode[]
  /** Each `noModule` write: the value assigned, or whether `setAttribute` sets it (any value) or `removeAttribute` clears it. */
  noModule: (AstNode | boolean)[]
  text: AstNode[]
  inserts: AstNode[]
}

/**
 * The script elements a program creates, each by its creation call, with what the program sets on them and the
 * insertion calls that insert them, in document order.
 */
export function scriptElements(program: AstNode, folder: Folder): Map<AstNode, Element> {
  const elements = new Map<AstNode, Element>()
  if (!syntaxNeeds(program, true, false).elements) return elements
  const of = (node: AstNode): Element[] =>
    [...folder.elementsOf(node)].map((call) => {
      let element = elements.get(call)
      if (element === undefined) elements.set(call, (element = { src: [], type: [], integrity: [], noModule: [], text: [], inserts: [] }))
      return element
    })
  walkTree(program, {
    enter(node) {
      if (node.type === 'AssignmentExpression' && node['operator'] === '=') {
        const left = node['left'] as AstNode
        if (left.type !== 'MemberExpression') return
        const name = propertyName(left)
        const value = node['right'] as AstNode
        if (name === 'src' || name === 'type' || name === 'integrity') for (const element of of(left['object'] as AstNode)) element[name].push(value)
        else if (name === 'noModule') for (const element of of(left['object'] as AstNode)) element.noModule.push(value)
        else if (name !== undefined && textMembers.has(name)) for (const element of of(left['object'] as AstNode)) element.text.push(value)
        return
      }
      if (node.type !== 'CallExpression') return
      const callee = node['callee'] as AstNode
      if (callee.type !== 'MemberExpression') return
      const method = propertyName(callee)
      if (method === undefined) return
      const args = node['arguments'] as AstNode[]
      const receiver = callee['object'] as AstNode
      if (method === 'removeAttribute' && args.length >= 1 && args[0]!.type !== 'SpreadElement') {
        const key = folder.strings(args[0]!)
        if (!key.unknown && key.values.length === 1 && key.values[0]!.toLowerCase() === 'nomodule') for (const element of of(receiver)) element.noModule.push(false)
        return
      }
      if (method === 'setAttribute' && args.length >= 2 && args[0]!.type !== 'SpreadElement') {
        // An attribute name is lowercased on an HTML element. A name that doesn't fold touches neither.
        const key = folder.strings(args[0]!)
        if (key.unknown || key.values.length !== 1) return
        const name = key.values[0]!.toLowerCase()
        if (name === 'src' || name === 'type' || name === 'integrity') for (const element of of(receiver)) element[name].push(args[1]!)
        // A boolean attribute is set whatever its value (HTML § Boolean attributes).
        else if (name === 'nomodule') for (const element of of(receiver)) element.noModule.push(true)
        return
      }
      const nodes = insertions.get(method)
      if (nodes === undefined) return
      const inserted = nodes === 'all' ? args : args.slice(nodes, nodes + 1)
      for (const arg of inserted) {
        if (arg.type === 'SpreadElement') continue
        for (const element of of(arg)) element.inserts.push(node)
        // A text node appended to a script element is its code.
        const text = textNodeCode(arg)
        if (text !== undefined && (method === 'appendChild' || method === 'append')) for (const element of of(receiver)) element.text.push(text)
      }
    },
  })
  return elements
}

/** The code of `X.createTextNode(code)`. */
function textNodeCode(node: AstNode): AstNode | undefined {
  if (node.type !== 'CallExpression') return undefined
  const callee = node['callee'] as AstNode
  const [code] = node['arguments'] as AstNode[]
  if (callee.type !== 'MemberExpression' || propertyName(callee) !== 'createTextNode' || code === undefined) return undefined
  return code.type === 'SpreadElement' ? undefined : code
}

/**
 * The code an injected element with no `src` carries, by the call that first inserts it: the expressions its
 * text is set to.
 */
export function scriptTexts(program: AstNode, folder: Folder): Map<AstNode, AstNode[]> {
  const texts = new Map<AstNode, AstNode[]>()
  for (const element of scriptElements(program, folder).values()) {
    if (element.src.length > 0 || element.text.length === 0) continue
    const [insert] = element.inserts
    if (insert === undefined) continue
    texts.set(insert, [...(texts.get(insert) ?? []), ...element.text])
  }
  return texts
}

/** The injected scripts of a program (above), by `src` write, in document order. */
function injectedSites(
  program: AstNode,
  folder: Folder,
  at: (node: AstNode) => GeneratedLocation,
): InjectedSite[] {
  const sites: InjectedSite[] = []
  for (const element of scriptElements(program, folder).values()) {
    if (element.inserts.length === 0 || element.src.length === 0) continue
    const types: (string | null | undefined)[] = []
    if (element.type.length === 0) types.push(undefined)
    for (const type of element.type) {
      const folded = folder.strings(type)
      types.push(...folded.values)
      if (folded.unknown) types.push(null)
    }
    const integrities = element.integrity.map((value) => folder.strings(value))
    // Every write's constants are the alternatives; a write that doesn't fold makes the value none.
    const integrity = integrities.some((each) => each.unknown) ? [] : [...new Set(integrities.flatMap((each) => each.values))].sort()
    const noModule = noModuleOf(element.noModule)
    for (const src of element.src) {
      const folded = alternatives(src, folder, at)
      if (folded === undefined) continue
      sites.push({ location: at(src), ...folded, types: [...new Set(types)], integrity, noModule })
    }
  }
  return sites.sort((a, b) => a.location.start - b.location.start)
}

/** Whether an expression is truthy, when it is a constant: a literal, `!`, `void` or `undefined`. */
function truthiness(node: AstNode): boolean | undefined {
  switch (node.type) {
    case 'Literal':
      return Boolean(node['value'])
    case 'ParenthesizedExpression':
      return truthiness(node['expression'] as AstNode)
    case 'Identifier':
      return node['name'] === 'undefined' ? false : undefined
    case 'UnaryExpression': {
      if (node['operator'] === 'void') return false
      const argument = node['operator'] === '!' ? truthiness(node['argument'] as AstNode) : undefined
      return argument === undefined ? undefined : !argument
    }
    default:
      return undefined
  }
}

/**
 * Whether an element's `noModule` is set: every write is an alternative, as `src`'s are. `yes` when each is
 * truthy, `no` when each is falsy or there is none, and `maybe` when they differ or one doesn't fold.
 */
function noModuleOf(writes: (AstNode | boolean)[]): 'no' | 'yes' | 'maybe' {
  const values = new Set<boolean | undefined>()
  for (const write of writes) {
    if (typeof write === 'boolean') values.add(write)
    else for (const alternative of branches(write)) values.add(truthiness(alternative))
  }
  if (values.size === 0 || (values.size === 1 && values.has(false))) return 'no'
  return values.size === 1 && values.has(true) ? 'yes' : 'maybe'
}

/** The worker functions a callee path names (`new` or a call), without the global object's names before it. */
function isWorkerCall(node: AstNode): boolean {
  const path: string[] = []
  let at = node['callee'] as AstNode
  for (;;) {
    if (at.type === 'ChainExpression' || at.type === 'ParenthesizedExpression') at = at['expression'] as AstNode
    else if (at.type === 'SequenceExpression') at = (at['expressions'] as AstNode[]).at(-1)!
    else break
  }
  while (at.type === 'MemberExpression') {
    const name = propertyName(at)
    if (name === undefined) return false
    path.unshift(name)
    at = at['object'] as AstNode
  }
  if (at.type !== 'Identifier') return false
  path.unshift(at['name'] as string)
  while (path.length > 1 && ['window', 'self', 'globalThis'].includes(path[0]!)) path.shift()
  const spelt = path.join('.')
  if (node.type === 'NewExpression') return spelt === 'Worker' || spelt === 'SharedWorker'
  return spelt === 'navigator.serviceWorker.register' || spelt === 'importScripts'
}

/** The worker URLs of a program that aren't literals (above), in document order. */
function workerSites(program: AstNode, folder: Folder, at: (node: AstNode) => GeneratedLocation): WorkerSite[] {
  const sites: WorkerSite[] = []
  walkTree(program, {
    enter(node) {
      if ((node.type !== 'NewExpression' && node.type !== 'CallExpression') || !isWorkerCall(node)) return
      const args = node['arguments'] as AstNode[]
      const importScripts = node.type === 'CallExpression' && !/register$/.test(calleeName(node))
      for (const url of importScripts ? args : args.slice(0, 1)) {
        if (url.type === 'SpreadElement' || isLiteral(url)) continue
        // Only `importScripts` loads chunks: another worker call's URL is its worker's however it is built.
        const folded = alternatives(url, folder, at, importScripts)
        if (folded !== undefined) sites.push({ location: at(url), ...folded })
      }
    },
  })
  return sites
}

/** The last name a callee spells. */
function calleeName(call: AstNode): string {
  let at = call['callee'] as AstNode
  while (at.type === 'ChainExpression' || at.type === 'ParenthesizedExpression') at = at['expression'] as AstNode
  if (at.type === 'SequenceExpression') at = (at['expressions'] as AstNode[]).at(-1)!
  if (at.type === 'Identifier') return at['name'] as string
  return at.type === 'MemberExpression' ? (propertyName(at) ?? '') : ''
}

const isLiteral = (node: AstNode): boolean =>
  (node.type === 'Literal' && typeof node['value'] === 'string') ||
  (node.type === 'TemplateLiteral' && (node['expressions'] as AstNode[]).length === 0)

/**
 * A URL expression's alternatives: the branches of a conditional and both sides of `||`, `??` and `&&`, each
 * folded. The URLs they fold to, and where each alternative that doesn't is. Undefined, when the site `loadsChunks`,
 * if it calls a chunk loader's URL function, which makes it a chunk load.
 */
function alternatives(
  node: AstNode,
  folder: Folder,
  at: (node: AstNode) => GeneratedLocation,
  loadsChunks = true,
): { urls: string[]; unknown: GeneratedLocation[] } | undefined {
  const urls = new Set<string>()
  const unknown: GeneratedLocation[] = []
  for (const alternative of branches(node)) {
    const folded = folder.strings(alternative)
    if (folded.chunk && loadsChunks) return undefined
    for (const value of folded.values) urls.add(value)
    if (folded.unknown) unknown.push(at(alternative))
  }
  return { urls: [...urls].sort(), unknown }
}

function branches(node: AstNode): AstNode[] {
  switch (node.type) {
    case 'ParenthesizedExpression':
      return branches(node['expression'] as AstNode)
    case 'ConditionalExpression':
      return [...branches(node['consequent'] as AstNode), ...branches(node['alternate'] as AstNode)]
    case 'LogicalExpression':
      // Either side may be the value: the left one when it decides the operator, the right one otherwise.
      return [...branches(node['left'] as AstNode), ...branches(node['right'] as AstNode)]
    default:
      return [node]
  }
}

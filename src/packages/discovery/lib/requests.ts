// The references a script or module makes in its code, taken from one oxc parse (§5, §19 Discovery): the parse yields
// imports, exports and dynamic imports, so no separate module lexer is used, and its tree holds the worker URLs and
// `importScripts` calls. Syntax only: which realm has which global is for discovery to say.

import { visitorKeys } from 'oxc-parser'
import { scopeCheck } from './scopes.ts'
import { isNode, parseCode, type Node } from './syntax.ts'

/**
 * A module request in an artifact's code: the specifier it names, or null for a dynamic import whose specifier is not
 * a literal, the UTF-16 range of the specifier's expression, and whether it is a dynamic import. `readableOptions` is
 * false for a dynamic import whose options have a part the analyzer can't read that could decide whether it names a
 * JavaScript module (§2 Import attributes). `follow` is whether any readable branch of the options names one: false
 * for a request with attributes, true for the rest, and for an unreadable one only when another branch names one.
 */
export interface ModuleRequest {
  specifier: string | null
  start: number
  end: number
  dynamic: boolean
  readableOptions: boolean
  follow: boolean
}

/**
 * How code loads a worker script (§2 Discovery): `new Worker`, `new SharedWorker`, `navigator.serviceWorker.register`,
 * or `importScripts`, which loads a classic script into the worker that calls it.
 */
export type WorkerKind = 'worker' | 'shared-worker' | 'service-worker' | 'import-scripts'

/**
 * A worker script that code loads: `url` is its literal URL (a string literal, or a template literal with no
 * substitutions), or null when the URL argument isn't a literal, which only the resolver can fold (§2 Computed URLs).
 * `sourceType` is `module` when the options' `type` is `"module"`, and null when the options can't be read statically,
 * so that the script's syntax decides it (§2). `through` is the global name the call reaches its function through
 * (`self` in `self.importScripts(…)`), if any, and `start` and `end` the UTF-16 range of the URL.
 */
export interface WorkerRequest {
  kind: WorkerKind
  url: string | null
  sourceType: 'script' | 'module' | null
  through?: string
  start: number
  end: number
}

/**
 * The references of a script or module, each list in source order. `unsupported` is true when a static import or
 * re-export has an import attribute a browser doesn't support: a key other than `type`, or a `type` other than `"json"`
 * or `"css"`. That fails every module graph that contains the module (§2 Import attributes, Principle 1).
 */
export interface Requests {
  modules: ModuleRequest[]
  workers: WorkerRequest[]
  unsupported: boolean
}

/** The declarations that can name a module: static imports and re-exports. */
const declarations = new Set(['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration'])

const none: Requests = { modules: [], workers: [], unsupported: false }

/**
 * The references in `text`, parsed with `sourceType`. None when the code doesn't parse, as nothing of it runs: that
 * includes a classic script with an `import` or `export` declaration, which oxc reports only among the semantic errors
 * §5's options leave out.
 *
 * - **Modules:** its static imports and re-exports, and its dynamic imports, except those with an import attribute
 *   (§2 Import maps): a `type` names a module that is not JavaScript, and a browser supports no other key. A dynamic
 *   import's specifier is a literal when it is a string literal, or a template literal with no substitutions. One
 *   whose options have a part that can't be read (`importAttributes`) is a request whose attributes can't be read
 *   (`readableOptions: false`), and is followed only when another branch names a JavaScript module (`follow`).
 * - **Workers:** the worker scripts it loads, with a literal URL or not (see `workerRequests`).
 */
export function requests(text: string, sourceType: 'script' | 'module'): Requests {
  // A keyword is never written with escapes, so code without the word `import` or `export` requests no module. Code
  // without `Worker` (in `Worker`, `SharedWorker` and `serviceWorker`) or `importScripts` loads no worker script.
  const modules = /\b(?:import|export)\b/.test(text)
  const workers = /Worker|importScripts/.test(text)
  if (!modules && !workers) return none
  const parsed = parseCode(text, sourceType)
  if (parsed === undefined) return none
  const { program } = parsed
  return {
    modules: modules ? moduleRequests(program, parsed.module.dynamicImports, sourceType) : [],
    workers: workers ? workerRequests(program, sourceType) : [],
    unsupported: modules && unsupportedAttributes(program),
  }
}

/** The module types a browser supports besides JavaScript (HTML § HostGetSupportedImportAttributes, module type). */
const supportedTypes: ReadonlySet<string> = new Set(['json', 'css'])

/**
 * Whether a static import or re-export of the program has an import attribute a browser doesn't support: a key other
 * than `type`, or a `type` that names no supported module type (`"javascript"`), which fails the module's graph.
 */
function unsupportedAttributes(program: Node): boolean {
  return (program['body'] as Node[]).some(
    (statement) =>
      declarations.has(statement.type) &&
      ((statement['attributes'] as Node[] | undefined) ?? []).some((attribute) => {
        const key = attribute['key'] as Node
        const name = key.type === 'Identifier' ? key['name'] : key['value']
        return name !== 'type' || !supportedTypes.has((attribute['value'] as Node)['value'] as string)
      }),
  )
}

function moduleRequests(
  program: Node,
  dynamicImports: readonly { start: number }[],
  sourceType: 'script' | 'module',
): ModuleRequest[] {
  const requests: ModuleRequest[] = []
  for (const statement of program['body'] as Node[]) {
    if (!declarations.has(statement.type)) continue
    const source = statement['source'] as Node | null
    // A static import's attributes are always literals, and any key keeps it from naming a JavaScript module: a
    // supported `type` names a module that is not JavaScript, and anything else fails the module (`unsupported`).
    if (source === null || ((statement['attributes'] as Node[] | undefined) ?? []).length > 0) continue
    const { start, end } = source
    requests.push({ specifier: source['value'] as string, start, end, dynamic: false, readableOptions: true, follow: true })
  }
  let declared: ReturnType<typeof scopeCheck> | undefined
  for (const { start } of dynamicImports) {
    const expression = nodeAt(program, start, 'ImportExpression')
    if (expression === undefined) continue
    // `undefined` is the native value unless a declaration in scope at the import binds the name.
    const isUndefined = (node: Node) =>
      (node.type === 'UnaryExpression' && node['operator'] === 'void') ||
      (node.type === 'Identifier' && node['name'] === 'undefined' && !(declared ??= scopeCheck(sourceType))(pathTo(program, expression), 'undefined'))
    const attributes = importAttributes(expression['options'] as Node | null | undefined, isUndefined)
    const follow = attributes.has('none')
    const readableOptions = !attributes.has('unreadable')
    if (!follow && readableOptions) continue
    const source = expression['source'] as Node
    requests.push({ specifier: literal(source), start: source.start, end: source.end, dynamic: true, readableOptions, follow })
  }
  return requests.sort((a, b) => a.start - b.start)
}

/**
 * The import attributes a dynamic import's options give (ECMAScript § EvaluateImportCall, HTML §
 * HostLoadImportedModule), as the set of outcomes of its branches (`outcomes`): `none`, so it names a JavaScript module;
 * `some`, so it names none, because a `type` names a module that is not JavaScript, a browser supports no other key,
 * and options, or a `with`, that are not an object make the import throw; or `unreadable`, when a part of the options
 * the analyzer can't read could decide which (§2 Import attributes). A conditional or logical expression gives the
 * outcomes of each of its branches, except that the left operand of an `&&` that gives the options, or their `with`,
 * counts only as its falsy value (`evaluateOptions`). The options' `with` is read as the import reads it,
 * from their own properties, then from the object a non-computed `__proto__:` gives them, and its attributes are its
 * own enumerable string-keyed properties.
 */
function importAttributes(options: Node | null | undefined, isUndefined: (node: Node) => boolean): Set<Attributes> {
  if (options === null || options === undefined) return new Set(['none'])
  return outcomes(evaluateOptions(options, isUndefined), (object) => outcomes(lookupWith(object), attributesOf))
}

/**
 * The value of the options, as `evaluate` reads them (`options`), except that the left operand of an `&&` whose result
 * is the options counts only as its falsy value (`branches`).
 */
function evaluateOptions(node: Node, isUndefined: (node: Node) => boolean): Value {
  return branches(node, isUndefined, (leaf) => evaluate(leaf, isUndefined, true))
}

/**
 * The value of an expression that gives the options or their `with`, branch by branch: each branch of a `?:`, and both
 * operands of a logical expression, are alternatives, each read by `leaf`, except that the left operand of an `&&`
 * counts only as its falsy value (`falsy`): `c && X` yields `c` only when `c` is falsy (§2 Import attributes).
 * The left operands of `||` and `??` stay what `leaf` reads, as does an `&&` anywhere else.
 */
function branches(node: Node, isUndefined: (node: Node) => boolean, leaf: (node: Node) => Value): Value {
  switch (node.type) {
    case 'ParenthesizedExpression':
      return branches(node['expression'] as Node, isUndefined, leaf)
    case 'ConditionalExpression':
      return { any: [branches(node['consequent'] as Node, isUndefined, leaf), branches(node['alternate'] as Node, isUndefined, leaf)] }
    case 'LogicalExpression': {
      const left = node['left'] as Node
      return { any: [node['operator'] === '&&' ? falsy(evaluate(left, isUndefined)) : leaf(left), branches(node['right'] as Node, isUndefined, leaf)] }
    }
    default:
      return leaf(node)
  }
}

/**
 * The falsy values a value may be (ECMAScript § ToBoolean): `undefined` itself; another primitive, for one that may be
 * `null`, `false`, `0`, `NaN` or `""`; both, for a value the analyzer can't read; and none for an object, or a string
 * whose text isn't empty.
 */
function falsy(value: Value): Value {
  if (value === 'undefined' || value === 'primitive') return value
  if (value === 'unknown') return { any: ['undefined', 'primitive'] }
  if (isAlternatives(value)) return { any: value.any.map(falsy) }
  if ('string' in value) return value.string === null || value.string === '' ? 'primitive' : { any: [] }
  return { any: [] }
}

/** The outcomes of the options value, or of a branch of it: an object's by `inObject`, an alternative's by each branch. */
function outcomes(value: Value, inObject: (object: ValueObject) => Set<Attributes>): Set<Attributes> {
  if (isAlternatives(value)) return new Set(value.any.flatMap((branch) => [...outcomes(branch, inObject)]))
  if (value === 'unknown') return new Set(['unreadable'])
  if (value === 'undefined') return new Set(['none'])
  if (isPrimitive(value)) return new Set(['some'])
  return inObject(value)
}

/** The outcome of a `with` that is an object: its own enumerable string keys are the attributes. */
function attributesOf(attributes: ValueObject): Set<Attributes> {
  const keys = hasKeys(attributes)
  return new Set([keys === 'maybe' ? 'unreadable' : keys === 'yes' ? 'some' : 'none'])
}

/** Whether a value is a primitive other than `undefined`. */
function isPrimitive(value: Value): value is 'primitive' | StringValue {
  return value === 'primitive' || (typeof value === 'object' && 'string' in value)
}

function isAlternatives(value: Value): value is Alternatives {
  return typeof value === 'object' && 'any' in value
}

type Attributes = 'none' | 'some' | 'unreadable'

/**
 * A value as import attributes read it: `undefined`, another primitive, an object, or `unknown` when the analyzer
 * can't read it. A string primitive is kept apart, as spreading it gives its indices as keys.
 */
type Value = 'undefined' | 'primitive' | 'unknown' | ValueObject | StringValue | Alternatives

/** A conditional or logical expression: each branch is an alternative (§2 Import attributes). */
interface Alternatives {
  any: readonly Value[]
}

/** A string primitive, with its text, or null when the analyzer can't read it. */
interface StringValue {
  string: string | null
}

/**
 * An object a literal gives: its own enumerable properties by key, each with its value, or `unknown` when a later part
 * the analyzer can't read may have set it again; whether such a part (`wild`) may have added any other key; and its
 * prototype, as far as it can give a `with`: null when it gives none, or `unknown`. An array's own keys are indices,
 * so never `with`.
 */
interface ValueObject {
  own: Map<string, Value>
  wild: boolean
  /** A spread of a string the analyzer can't read may have added index keys, none of them `with`. */
  indices?: true
  proto: ValueObject | 'unknown' | null
  array?: true
}

/**
 * `Array.prototype`, as import attributes read it: its `with` is a method, a function that has no enumerable own
 * property (ECMAScript § Array.prototype.with).
 */
const functionValue = (): ValueObject => ({ own: new Map(), wild: false, proto: null })
const arrayPrototype: ValueObject = { own: new Map([['with', functionValue()]]), wild: false, proto: null }

/**
 * The value of an expression, as far as import attributes read it: a free `undefined` or a `void` is `undefined`; a
 * literal, another unary operation or a template literal a primitive, a string kept apart (`StringValue`); a regular
 * expression or a function an object with no enumerable own property and no `with`; an array or object literal its
 * own keys, as `evaluateArray` and `evaluateObject` read them. Anything else is `unknown`. When the value may be the
 * options (`options`), so may each of its branches, and an object literal's `with` is read as `evaluateObject` says.
 */
function evaluate(node: Node, isUndefined: (node: Node) => boolean, options = false): Value {
  switch (node.type) {
    case 'ParenthesizedExpression':
      return evaluate(node['expression'] as Node, isUndefined, options)
    case 'Literal':
      if (node['regex'] !== undefined && node['regex'] !== null) return functionValue()
      return typeof node['value'] === 'string' ? { string: node['value'] } : 'primitive'
    case 'TemplateLiteral':
      // A template literal with substitutions is a string whose text isn't read.
      return { string: literal(node) }
    case 'Identifier':
    case 'UnaryExpression':
      if (isUndefined(node)) return 'undefined'
      if (node.type === 'Identifier') return 'unknown'
      // `typeof` gives a string; every other unary operator a number, a BigInt or a boolean.
      return node['operator'] === 'typeof' ? { string: null } : 'primitive'
    case 'ConditionalExpression':
      return { any: [evaluate(node['consequent'] as Node, isUndefined, options), evaluate(node['alternate'] as Node, isUndefined, options)] }
    case 'LogicalExpression':
      return { any: [evaluate(node['left'] as Node, isUndefined, options), evaluate(node['right'] as Node, isUndefined, options)] }
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      return functionValue()
    case 'ArrayExpression':
      return evaluateArray(node['elements'] as (Node | null)[], isUndefined)
    case 'ObjectExpression':
      return evaluateObject(node['properties'] as Node[], isUndefined, options)
    default:
      return 'unknown'
  }
}

/** An array literal's value: a key for each element, and those its spreads give (`spreadInto`), with `Array.prototype`. */
function evaluateArray(elements: readonly (Node | null)[], isUndefined: (node: Node) => boolean): ValueObject {
  const array: ValueObject = { own: new Map(), wild: false, proto: arrayPrototype, array: true }
  for (const element of elements) {
    if (element === null) continue
    if (element.type === 'SpreadElement') spreadInto(array, evaluate(element['argument'] as Node, isUndefined), true)
    else array.own.set(String(array.own.size), 'unknown')
  }
  return array
}

/**
 * An object literal's value, property by property in order: a key the analyzer reads sets that key; a computed key it
 * can't read, or a spread of something it can't read, may set any key (`wild`), so every key set before it may have
 * changed; a non-computed `__proto__:` sets the prototype (ECMAScript § PropertyDefinitionEvaluation). When the object may
 * be the options (`options`), what its spreads and prototype give may be too, and the value of its `with` is read
 * branch by branch (`branches`).
 */
function evaluateObject(properties: readonly Node[], isUndefined: (node: Node) => boolean, options = false): ValueObject {
  const object: ValueObject = { own: new Map(), wild: false, proto: null }
  for (const property of properties) {
    if (property.type === 'SpreadElement') {
      spreadInto(object, evaluate(property['argument'] as Node, isUndefined, options), false)
      continue
    }
    const name = propertyName(property)
    if (name === undefined) {
      makeWild(object)
      continue
    }
    const plain = property['kind'] === 'init' && property['method'] !== true && property['shorthand'] !== true
    const isProto = name === '__proto__' && property['computed'] !== true && plain
    const node = property['value'] as Node
    const value =
      property['kind'] !== 'init'
        ? 'unknown'
        : options && name === 'with'
          ? branches(node, isUndefined, (leaf) => evaluate(leaf, isUndefined))
          : evaluate(node, isUndefined, options && isProto)
    if (isProto) {
      // Only an object or null sets the prototype.
      // A prototype that is one of several alternatives is not read.
      if (value === 'unknown' || isAlternatives(value)) object.proto = 'unknown'
      else if (typeof value === 'object' && !isPrimitive(value)) object.proto = value
      else if (value === 'primitive' && isNull(node)) object.proto = null
    } else {
      object.own.delete(name)
      object.own.set(name, value)
    }
  }
  return object
}

/**
 * Copies what spreading `value` gives into `target`: an object's own keys, a known string's indices, index keys it
 * can't count for a string it can't read (`indices`), nothing for another primitive, and for a value the analyzer
 * can't read, any key (`wild`). Into an array, each key is an element.
 */
function spreadInto(target: ValueObject, value: Value, array: boolean): void {
  if (value === 'undefined' || value === 'primitive') return
  // A spread of one of several alternatives is not read.
  if (value === 'unknown' || isAlternatives(value)) return makeWild(target)
  if ('string' in value && value.string === null) {
    target.indices = true
    return
  }
  const keys = 'string' in value ? [...(value.string ?? '')].map((_, i) => [String(i), 'primitive' as Value] as const) : value.own
  if (!('string' in value) && value.indices === true) target.indices = true
  for (const [key, entry] of keys) {
    const name = array ? String(target.own.size) : key
    target.own.delete(name)
    target.own.set(name, entry)
  }
  if (!('string' in value) && value.wild) makeWild(target)
}

/** A part the analyzer can't read may set any key of `object`, and so change any it has. */
function makeWild(object: ValueObject): void {
  object.wild = true
  for (const key of object.own.keys()) object.own.set(key, 'unknown')
}

/** The value of an object's `with`, as `Get` reads it: its own, then its prototype's, `undefined` when none has one. */
function lookupWith(object: ValueObject): Value {
  if (object.array !== true) {
    const own = object.own.get('with')
    if (own !== undefined) return own
    if (object.wild) return 'unknown'
  }
  if (object.proto === 'unknown') return 'unknown'
  return object.proto === null ? 'undefined' : lookupWith(object.proto)
}

/**
 * Whether an object has an own enumerable string key: `maybe` when only a part the analyzer can't read may add one,
 * such as a spread of a string whose text it can't read (a template literal with substitutions, or a `typeof`).
 */
function hasKeys(object: ValueObject): 'yes' | 'no' | 'maybe' {
  return object.own.size > 0 ? 'yes' : object.wild || object.indices === true ? 'maybe' : 'no'
}

/**
 * The key a property names with a literal: an identifier, or any literal, computed or not, as ECMAScript §
 * ToPropertyKey names it. Only whether it is `with` or `__proto__` matters.
 */
function propertyName(property: Node): string | undefined {
  const key = property['key'] as Node
  if (key.type === 'Identifier' && property['computed'] !== true) return key['name'] as string
  if (key.type === 'Literal') return literalText(key)
  return key.type === 'TemplateLiteral' ? (literal(key) ?? undefined) : undefined
}

/** The names code calls the global object by, which may lead the path to a worker function. */
const globalNames: ReadonlySet<string> = new Set(['window', 'self', 'globalThis'])

/**
 * The worker scripts a program loads with a literal URL, in source order:
 * - `new Worker(url, options)` and `new SharedWorker(url, options)`, where the options may be a `SharedWorker`'s name
 * - `navigator.serviceWorker.register(url, options)`
 * - `importScripts(url, …)`, one request for each URL
 *
 * The function may be reached through a global name: `new self.Worker(…)`, `window.navigator.serviceWorker.register(…)`.
 * A worker's `sourceType` comes from its options (`workerType`).
 *
 * This is syntax: a call whose first name (`Worker`, `self`, `navigator`, …) a declaration in scope at the call binds
 * (`class Worker {}`, a `navigator` parameter, `var self = this` in its function) is not a native's, so it loads
 * nothing (§2). A URL argument that is not a literal is a request with no URL, which the resolver folds (§2 Computed
 * URLs).
 */
function workerRequests(program: Node, sourceType: 'script' | 'module'): WorkerRequest[] {
  const calls: { call: Node; kind: WorkerKind; path: string[]; through: string | undefined }[] = []
  walk(program, (node) => {
    if (node.type !== 'NewExpression' && node.type !== 'CallExpression') return
    const path = calleePath(node['callee'] as Node)
    if (path === undefined) return
    const through = path.length > 1 && globalNames.has(path[0]!) ? path[0] : undefined
    const kind = workerKind(node.type === 'NewExpression', through === undefined ? path : path.slice(1))
    if (kind !== undefined) calls.push({ call: node, kind, path, through })
  })
  const declared = scopeCheck(sourceType)
  const requests: WorkerRequest[] = []
  for (const { call, kind, path, through } of calls) {
    const ancestry = pathTo(program, call)
    if (declared(ancestry, path[0]!)) continue
    const args = call['arguments'] as Node[]
    const urls = kind === 'import-scripts' ? args : args.slice(0, 1)
    // `undefined` is the native value unless a declaration in scope at the call binds the name.
    const isUndefined = (node: Node) =>
      (node.type === 'UnaryExpression' && node['operator'] === 'void') ||
      (node.type === 'Identifier' && node['name'] === 'undefined' && !declared(ancestry, 'undefined'))
    const type = kind === 'import-scripts' ? 'script' : workerType(kind, args[1], isUndefined)
    if (type === undefined) continue
    for (const argument of urls) {
      if (argument.type === 'SpreadElement') continue
      const url = literal(argument)
      const { start, end } = argument
      requests.push({ kind, url, sourceType: type, ...(through === undefined ? {} : { through }), start, end })
    }
  }
  return requests.sort((a, b) => a.start - b.start)
}

/**
 * The nodes from `root` down to `target`, each the parent of the next, found by descending through the children that
 * contain it, without walking the rest of the tree.
 */
function pathTo(root: Node, target: Node): Node[] {
  const path = [root]
  for (let node = root; node !== target; ) {
    const child = childContaining(node, target.start, target.end)
    if (child === undefined) throw new Error(`no path to the ${target.type} at ${target.start}`)
    path.push((node = child))
  }
  return path
}

/** The first child of `node` whose range holds the UTF-16 range from `start` to `end`, if any. */
function childContaining(node: Node, start: number, end: number): Node | undefined {
  for (const key of visitorKeys[node.type] ?? []) {
    const value = node[key]
    for (const child of Array.isArray(value) ? value : [value]) {
      if (isNode(child) && child.start <= start && end <= child.end) return child
    }
  }
  return undefined
}

/** Visits every node under `root`, in tree order. The walk keeps its own stack, so no depth of nesting overflows it. */
function walk(root: Node, visit: (node: Node) => void): void {
  const stack: Node[] = [root]
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    visit(node)
    const keys = visitorKeys[node.type] ?? []
    for (let k = keys.length - 1; k >= 0; k--) {
      const value = node[keys[k]!]
      if (Array.isArray(value)) {
        for (let i = value.length - 1; i >= 0; i--) if (isNode(value[i])) stack.push(value[i])
      } else if (isNode(value)) stack.push(value)
    }
  }
}

/** The kind of worker function a callee path names, as `new` or a call reaches it, without its global name. */
function workerKind(constructs: boolean, path: readonly string[]): WorkerKind | undefined {
  const spelt = path.join('.')
  if (constructs) return spelt === 'Worker' ? 'worker' : spelt === 'SharedWorker' ? 'shared-worker' : undefined
  if (spelt === 'navigator.serviceWorker.register') return 'service-worker'
  return spelt === 'importScripts' ? 'import-scripts' : undefined
}

/**
 * The source type of a worker from its options (Web IDL `WorkerOptions`): the `type` of an object literal, `"classic"`
 * or `"module"`. A classic script, the default, when there are none, when they are `undefined` (`isUndefined`) or
 * `null`, a regular-expression literal, or a `SharedWorker`'s name (any other primitive literal), or when the object
 * literal sets no `type` and nothing in it could, or sets it to `undefined`. Undefined when the call throws or rejects
 * before any worker starts, so it loads nothing (Principle 1): `Worker` or `register` given a primitive literal other
 * than `null`, which isn't a dictionary, or a `type` literal whose string isn't `"classic"` or `"module"` (Web IDL
 * `WorkerType`; `null`, `5` and `true` give `"null"`, `"5"` and `"true"`). Null when the options can't be read
 * statically: they are another expression, or the object literal's `type` is, or could come from a spread, a computed
 * key, an accessor or a `__proto__` (§2: the script's syntax then decides).
 */
function workerType(
  kind: 'worker' | 'shared-worker' | 'service-worker',
  options: Node | undefined,
  isUndefined: (node: Node) => boolean,
): 'script' | 'module' | null | undefined {
  if (options === undefined || isUndefined(options) || isNull(options)) return 'script'
  if (isPrimitiveLiteral(options)) return kind === 'shared-worker' ? 'script' : undefined
  if (options.type === 'Literal') return 'script'
  if (options.type !== 'ObjectExpression') return null
  const type = typeOption(options['properties'] as Node[], isUndefined)
  if (type === null) return null
  return type === undefined || type === 'classic' ? 'script' : type === 'module' ? 'module' : undefined
}

/** Whether a node is a literal whose value is a primitive other than `null`: not a regular expression. */
function isPrimitiveLiteral(node: Node): boolean {
  if (node.type === 'TemplateLiteral') return true
  return node.type === 'Literal' && node['regex'] === undefined && !isNull(node)
}

/**
 * The `type` an object literal's properties give it, as a dictionary member reads it: the string the last property
 * that can set it gives (another literal's as ToString spells it), undefined when none can or it is `undefined`, or
 * null when it can't be read statically.
 */
function typeOption(properties: readonly Node[], isUndefined: (node: Node) => boolean): string | null | undefined {
  let type: string | null | undefined
  // A prototype the literal sets supplies the `type` it doesn't set itself. An own `type`, even `undefined`, hides it.
  let prototype = false
  let own = false
  for (const property of properties) {
    // A spread may copy a `type` or not.
    if (property.type !== 'Property') {
      type = null
      continue
    }
    const keyNode = property['key'] as Node
    const name = property['computed'] === true ? computedKey(keyNode) : key(keyNode)
    if (name === null) type = null
    else if (setsPrototype(property, name)) prototype = !isNull(property['value'] as Node)
    else if (name === 'type') {
      type = typeValue(property, isUndefined)
      own = true
    }
  }
  return type === undefined && prototype && !own ? null : type
}

/**
 * The `type` a property of that name gives: the string of a string literal, or of another literal as ToString spells
 * it (`null`, `5`, `true`, `/x/`), none of which is a valid type; undefined for `undefined`; or null when its value
 * can't be read statically, as an accessor's or a method's can't.
 */
function typeValue(property: Node, isUndefined: (node: Node) => boolean): string | null | undefined {
  if (property['kind'] !== 'init' || property['method'] === true) return null
  const value = property['value'] as Node
  const text = literal(value)
  if (text !== null) return text
  if (isUndefined(value)) return undefined
  return value.type === 'Literal' ? literalText(value) : null
}

/** A literal's value as ECMAScript ToString spells it: `null`, `5`, `true`, `1` for `1n`, `/x/g`. */
function literalText(node: Node): string {
  if (typeof node['bigint'] === 'string') return node['bigint']
  const regex = node['regex'] as { pattern: string; flags: string } | null | undefined
  return regex === null || regex === undefined ? String(node['value']) : `/${regex.pattern}/${regex.flags}`
}

/** Whether an object literal's property sets its prototype: `__proto__: value`, not computed, shorthand or a method. */
function setsPrototype(property: Node, name: string | undefined): boolean {
  const plain = property['kind'] === 'init' && property['method'] !== true && property['shorthand'] !== true
  return name === '__proto__' && property['computed'] !== true && plain
}

/** The name a computed key spells when it is a literal, or null when it can't be read statically. */
function computedKey(node: Node): string | null {
  if (node.type === 'Literal') return String(node['value'])
  return literal(node)
}

/** Whether a node is the literal `null`. */
function isNull(node: Node): boolean {
  return node.type === 'Literal' && node['value'] === null && node['raw'] === 'null'
}

/**
 * The names a callee spells, as a path of identifiers and literal keys: `navigator.serviceWorker.register`. A chain
 * (`a?.b`) and a comma sequence (`(0, self.importScripts)`) call their last expression. Anything else spells nothing.
 */
function calleePath(node: Node): string[] | undefined {
  switch (node.type) {
    case 'Identifier':
      return [node['name'] as string]
    case 'ChainExpression':
      return calleePath(node['expression'] as Node)
    case 'SequenceExpression':
      return calleePath((node['expressions'] as Node[]).at(-1)!)
    case 'MemberExpression': {
      const property = node['property'] as Node
      const name =
        node['computed'] === true
          ? literal(property)
          : property.type === 'Identifier'
            ? (property['name'] as string)
            : null
      const object = calleePath(node['object'] as Node)
      return name === null || object === undefined ? undefined : [...object, name]
    }
    default:
      return undefined
  }
}

/** The name an identifier or string literal key spells. */
function key(node: Node): string | undefined {
  if (node.type === 'Identifier') return node['name'] as string
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value']
  return undefined
}

/** The string a literal names: a string literal, or a template literal with no substitutions. */
function literal(node: Node): string | null {
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value']
  if (node.type === 'TemplateLiteral' && (node['expressions'] as Node[]).length === 0) {
    return ((node['quasis'] as Node[])[0]!['value'] as { cooked: string | null }).cooked
  }
  return null
}

/**
 * The node of `type` that starts at `start`, found by descending from `root` through the children that contain it,
 * without walking the rest of the tree.
 */
function nodeAt(root: Node, start: number, type: string): Node | undefined {
  let node: Node | undefined = root
  while (node !== undefined && (node.type !== type || node.start !== start)) {
    node = childContaining(node, start, start + 1)
  }
  return node
}

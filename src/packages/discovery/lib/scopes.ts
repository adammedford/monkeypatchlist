// Whether code declares a name in scope at a node (§2 Discovery: a worker call is dropped only when a declaration of
// its root name is in scope at the call). A syntactic scope walk up the node's ancestors, by ECMAScript's scoping rules:
// `var` and top-level functions belong to the nearest function, static block or program; `let`, `const`, `class` and
// block-level functions to their block; parameters, a catch clause's parameter, a function expression's and a class's
// own name to what they enclose. A function's parameter list doesn't see what its body declares. In sloppy code, a
// block-level function also declares its name in the nearest function or program, as Annex B's block-function hoisting
// does (§5 post-pass 2). Syntax only.

import type { Node } from './syntax.ts'

/**
 * A check of whether a declaration of a name is in scope at a node of one program, given `path`, the chain of nodes
 * from the program down to it, each the parent of the next. The names each scope declares are gathered once.
 */
export function scopeCheck(sourceType: 'script' | 'module'): (path: readonly Node[], name: string) => boolean {
  const declared = new Map<Node, ReadonlySet<string>>()
  return (path, name) => {
    // Module code is strict, and so is code under a `"use strict"` directive or in a class.
    let strict = sourceType === 'module'
    for (let i = 0; i < path.length - 1; i++) {
      const scope = path[i]!
      const child = path[i + 1]!
      strict ||= becomesStrict(scope, child)
      const names = namesFor(declared, scope, child, strict)
      if (names?.has(name)) return true
    }
    return false
  }
}

/** Whether the code under `child` of `node` is strict code though the code around `node` isn't. */
function becomesStrict(node: Node, child: Node): boolean {
  switch (node.type) {
    case 'Program':
      return hasUseStrict(node['body'] as Node[])
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const body = node['body'] as Node
      return child !== node['id'] && body.type === 'BlockStatement' && hasUseStrict(body['body'] as Node[])
    }
    case 'ClassDeclaration':
    case 'ClassExpression':
      return child !== node['id']
    default:
      return false
  }
}

/** Whether a program's or function body's directive prologue holds `"use strict"`. */
function hasUseStrict(statements: readonly Node[]): boolean {
  for (const statement of statements) {
    if (typeof statement['directive'] !== 'string') return false
    if (statement['directive'] === 'use strict') return true
  }
  return false
}

/**
 * The names `scope` declares for the code under its child `child`, or undefined when it declares none there. What a
 * scope declares for the code it encloses is gathered once.
 */
function namesFor(
  cache: Map<Node, ReadonlySet<string>>,
  scope: Node,
  child: Node,
  strict: boolean,
): ReadonlySet<string> | undefined {
  // A function's or class's name, and a switch statement's discriminant, are outside the scope the node makes.
  if (child === scope['id'] || child === scope['discriminant']) return undefined
  // Code in a function's parameter list sees its parameters and a function expression's own name, but not what its body
  // declares, which gets an environment of its own (ECMAScript FunctionDeclarationInstantiation).
  if (isFunction(scope) && child !== scope['body']) return new Set(parameterNames(scope))
  let names = cache.get(scope)
  if (names === undefined) {
    const declared = declaredFor(scope, strict)
    if (declared === undefined) return undefined
    cache.set(scope, (names = new Set(declared)))
  }
  return names
}

/**
 * The names a node declares for the code it encloses, if it makes a scope: a function's for its body (its parameter
 * list sees only `parameterNames`, and a function declaration's own name is its enclosing scope's), a switch
 * statement's for its case block, a class's for its heritage and body (a class declaration's name is its enclosing
 * scope's too).
 */
function declaredFor(scope: Node, strict: boolean): string[] | undefined {
  switch (scope.type) {
    case 'Program':
      return varScoped(scope['body'] as Node[], strict)
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const body = scope['body'] as Node
      return [
        ...parameterNames(scope),
        ...(body.type === 'BlockStatement' ? varScoped(body['body'] as Node[], strict) : []),
      ]
    }
    case 'StaticBlock':
      return varScoped(scope['body'] as Node[], true)
    case 'BlockStatement':
      return lexicallyDeclared(scope['body'] as Node[])
    case 'SwitchStatement':
      return lexicallyDeclared((scope['cases'] as Node[]).flatMap((node) => node['consequent'] as Node[]))
    case 'ForStatement':
      return lexicalDeclaration(scope['init'] as Node | null)
    case 'ForInStatement':
    case 'ForOfStatement':
      // The loop's `let` or `const` names are in scope, in their temporal dead zone, while its object is evaluated.
      return lexicalDeclaration(scope['left'] as Node)
    case 'CatchClause':
      return patternNames(scope['param'] as Node | null)
    case 'ClassDeclaration':
    case 'ClassExpression':
      return patternNames(scope['id'] as Node | null)
    default:
      return undefined
  }
}

/** Whether a node is a function, which makes a scope for its parameters and body. */
function isFunction(node: Node): boolean {
  return (
    node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
  )
}

/** The names a function's parameter list and body both see: its parameters, and a function expression's own name. */
function parameterNames(fn: Node): string[] {
  return [
    ...(fn.type === 'FunctionExpression' ? patternNames(fn['id'] as Node | null) : []),
    ...(fn['params'] as Node[]).flatMap(patternNames),
  ]
}

/** The names a variable declaration binds. */
function declaredNames(declaration: Node): string[] {
  return (declaration['declarations'] as Node[]).flatMap((declarator) => patternNames(declarator['id'] as Node))
}

/** The names a `let`, `const` or `using` declaration binds, or none for a `var` declaration or anything else. */
function lexicalDeclaration(node: Node | null): string[] {
  if (node?.type !== 'VariableDeclaration' || node['kind'] === 'var') return []
  return declaredNames(node)
}

/**
 * The names a statement list declares lexically, as a block's or a case block's does: its `let`, `const` and `using`
 * declarations, classes and functions, a labelled function included.
 */
function lexicallyDeclared(statements: readonly Node[]): string[] {
  return statements.flatMap((statement) => {
    const node = unlabelled(statement)
    if (node.type === 'VariableDeclaration') return lexicalDeclaration(node)
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      return patternNames(node['id'] as Node | null)
    }
    return []
  })
}

/** The statement a chain of labels labels. */
function unlabelled(statement: Node): Node {
  let node = statement
  while (node.type === 'LabeledStatement') node = node['body'] as Node
  return node
}

/**
 * A statement to gather `var` names from, under a var scope's top level: the lexical names of each block, case block,
 * loop head and destructuring catch parameter between it and the var scope, outermost first, and whether it sits
 * directly in the statement list of the innermost of them.
 */
interface Nested {
  node: Node
  enclosing: readonly (readonly string[])[]
  direct: boolean
}

/**
 * The names a function body's, static block's or program's statements declare in its var scope: every declaration at
 * its top level (a program's imports and exports included), each `var` below it outside nested functions and classes,
 * and, in sloppy code, each plain function declared in a block below it (Annex B.3.3), unless a `let`, `const`, class
 * or function of that name in a block between them would clash with a `var` of it.
 */
function varScoped(statements: readonly Node[], strict: boolean): string[] {
  const names: string[] = []
  const stack: Nested[] = []
  for (const statement of statements) {
    const node = unlabelled(exported(statement))
    switch (node.type) {
      case 'ImportDeclaration':
        for (const specifier of node['specifiers'] as Node[]) names.push(...patternNames(specifier['local'] as Node))
        break
      case 'VariableDeclaration':
        names.push(...declaredNames(node))
        break
      case 'FunctionDeclaration':
      case 'ClassDeclaration':
        names.push(...patternNames(node['id'] as Node | null))
        break
      default:
        stack.push({ node, enclosing: [], direct: false })
    }
  }
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, enclosing, direct } = item
    const push = (child: Node | null | undefined, scope?: readonly string[], inList = false) => {
      if (child === null || child === undefined) return
      const inside = scope === undefined ? enclosing : [...enclosing, scope]
      stack.push({ node: unlabelled(child), enclosing: inside, direct: inList })
    }
    switch (node.type) {
      case 'VariableDeclaration':
        if (node['kind'] === 'var') {
          names.push(...declaredNames(node))
        }
        break
      case 'FunctionDeclaration': {
        if (strict || node['generator'] === true || node['async'] === true) break
        const [name] = patternNames(node['id'] as Node | null)
        // The block the function is declared in declares it lexically; only the blocks outside that one can clash.
        const between = direct ? enclosing.slice(0, -1) : enclosing
        if (name !== undefined && !between.some((scope) => scope.includes(name))) names.push(name)
        break
      }
      case 'BlockStatement': {
        const body = node['body'] as Node[]
        const scope = lexicallyDeclared(body)
        for (const child of body) push(child, scope, true)
        break
      }
      case 'IfStatement':
        push(node['consequent'] as Node)
        push(node['alternate'] as Node | null)
        break
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement': {
        const head = (node.type === 'ForStatement' ? node['init'] : node['left']) as Node | null
        const scope = lexicalDeclaration(head)
        if (head?.type === 'VariableDeclaration') push(head)
        push(node['body'] as Node, scope)
        break
      }
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'WithStatement':
        push(node['body'] as Node)
        break
      case 'TryStatement': {
        push(node['block'] as Node)
        const handler = node['handler'] as Node | null
        if (handler !== null) {
          // A `var` may redeclare a catch clause's plain parameter, but not a destructured one's names (Annex B.3.4).
          const param = handler['param'] as Node | null
          push(handler['body'] as Node, param === null || param.type === 'Identifier' ? undefined : patternNames(param))
        }
        push(node['finalizer'] as Node | null)
        break
      }
      case 'SwitchStatement': {
        const consequents = (node['cases'] as Node[]).flatMap((node) => node['consequent'] as Node[])
        const scope = lexicallyDeclared(consequents)
        for (const child of consequents) push(child, scope, true)
        break
      }
      default:
        break
    }
  }
  return names
}

/** The declaration an `export` statement exports, or the statement itself. */
function exported(statement: Node): Node {
  if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration') {
    const declaration = statement['declaration'] as Node | null
    if (declaration !== null) return declaration
  }
  return statement
}

/** The names a binding pattern binds. */
function patternNames(node: Node | null | undefined): string[] {
  switch (node?.type) {
    case 'Identifier':
      return [node['name'] as string]
    case 'ObjectPattern':
      return (node['properties'] as Node[]).flatMap((property) =>
        patternNames((property.type === 'RestElement' ? property['argument'] : property['value']) as Node),
      )
    case 'ArrayPattern':
      return (node['elements'] as (Node | null)[]).flatMap(patternNames)
    case 'AssignmentPattern':
      return patternNames(node['left'] as Node)
    case 'RestElement':
      return patternNames(node['argument'] as Node)
    default:
      return []
  }
}

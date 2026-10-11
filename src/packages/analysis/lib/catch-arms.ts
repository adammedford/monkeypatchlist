// Catch arms (§5 Resolver capabilities 9): a write in a `catch` arm counts only
// when its `try` block may throw, judged against the unmutated catalog. A `try` whose statements are reads and calls
// the catalog shows can't throw for the members swept never reaches its `catch`: rrweb's canvas observers read
// `typeof proto[k]`, which throws only for an accessor, whose getter runs on the prototype, and call `patch`, which
// catches internally, so its `catch` redefines only the accessors.
//
// The judgement is conservative: a statement or expression throws unless a rule below shows it can't, so any code the
// analyzer can't see through keeps its `catch` reachable, as before.

import type { CatalogTarget } from '../../../catalog.ts'
import type { AstNode } from './ast.ts'
import { isHeap, type Value } from './global-object.ts'
import { toPropertyKey, type Key } from './keys.ts'
import { isFunction } from './summaries.ts'

/** What judging a `try` block needs: values where it is, the catalog, and the declarations names resolve to. */
export interface ThrowContext {
  /** The values an expression can have where the `try` is. */
  evaluate(node: AstNode): Value[]
  /** The catalog target `key` names on `holder`'s chain in the unmutated catalog, if one does. */
  target(holder: string, key: Key): CatalogTarget | undefined
  /** The declaration a name resolves to, or none for a free name. */
  declaration(id: AstNode): AstNode | undefined
  /** How deep calls into the code's own functions are followed (the `throwDepth` cap, §18). */
  maxDepth: number
  /** Counts a hit of the `throwDepth` cap at the function it kept from being followed (§18). */
  depthCut(fn: AstNode): void
}

/** Whether a `try` block may throw where it is: false only when every statement in it is shown not to. */
export function mayThrow(block: AstNode, context: ThrowContext): boolean {
  const judge = judgeOf(context)
  return !judge.statement(block, 0)
}

function judgeOf(context: ThrowContext) {
  // The functions being followed, whose calls through themselves are taken to throw.
  const active = new Set<AstNode>()

  /** Whether a statement can't throw. */
  const statement = (node: AstNode, depth: number): boolean => {
    switch (node.type) {
      case 'EmptyStatement':
      case 'ContinueStatement':
      case 'BreakStatement':
      case 'FunctionDeclaration':
        return true
      case 'BlockStatement':
        return (node['body'] as AstNode[]).every((each) => statement(each, depth))
      case 'ReturnStatement': {
        const argument = node['argument'] as AstNode | null
        return argument === null || expression(argument, depth)
      }
      case 'ExpressionStatement':
        return expression(node['expression'] as AstNode, depth)
      case 'IfStatement': {
        const alternate = node['alternate'] as AstNode | null
        return (
          expression(node['test'] as AstNode, depth) &&
          statement(node['consequent'] as AstNode, depth) &&
          (alternate === null || statement(alternate, depth))
        )
      }
      case 'VariableDeclaration':
        return (node['declarations'] as AstNode[]).every((declarator) => {
          const init = declarator['init'] as AstNode | null
          return (declarator['id'] as AstNode).type === 'Identifier' && (init === null || expression(init, depth))
        })
      case 'TryStatement': {
        // A `try` throws only when its block throws and its `catch` does too, or its `finally` does.
        const handler = node['handler'] as AstNode | null
        const finalizer = node['finalizer'] as AstNode | null
        const block = statement(node['block'] as AstNode, depth)
        // A destructuring catch parameter throws on a thrown value it can't destructure.
        const param = handler === null ? null : (handler['param'] as AstNode | null)
        const catches = handler !== null && (param === null || param.type === 'Identifier') && statement(handler['body'] as AstNode, depth)
        const caught = handler === null ? block : block || catches
        return caught && (finalizer === null || statement(finalizer, depth))
      }
      default:
        return false
    }
  }

  /** Whether an expression can't throw. */
  const expression = (node: AstNode, depth: number): boolean => {
    switch (node.type) {
      case 'Literal':
      case 'ThisExpression':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return true
      case 'TemplateLiteral':
        return (node['expressions'] as AstNode[]).length === 0
      case 'Identifier':
        return readable(node)
      case 'ChainExpression':
        return expression(node['expression'] as AstNode, depth)
      case 'SequenceExpression':
        return (node['expressions'] as AstNode[]).every((each) => expression(each, depth))
      case 'LogicalExpression':
        return expression(node['left'] as AstNode, depth) && expression(node['right'] as AstNode, depth)
      case 'ConditionalExpression':
        return ['test', 'consequent', 'alternate'].every((key) => expression(node[key] as AstNode, depth))
      case 'UnaryExpression': {
        const argument = node['argument'] as AstNode
        const operator = node['operator'] as string
        // `typeof` of a free name never throws.
        if (operator === 'typeof' && argument.type === 'Identifier') return true
        return (operator === 'typeof' || operator === '!' || operator === 'void') && expression(argument, depth)
      }
      case 'BinaryExpression': {
        const operator = node['operator'] as string
        const left = node['left'] as AstNode
        const right = node['right'] as AstNode
        if (!expression(left, depth) || !expression(right, depth)) return false
        // Strict equality never converts its operands, loose equality between primitives doesn't either, and `in`
        // throws only on a right side that is no object.
        if (operator === '===' || operator === '!==') return true
        if (operator === '==' || operator === '!=') return primitive(left) && primitive(right)
        // `in` converts its left side to a key, which can throw for an object: only constants are shown not to.
        if (operator === 'in') return constants(context.evaluate(left)) && objects(context.evaluate(right))
        return false
      }
      case 'ArrayExpression':
        return (node['elements'] as (AstNode | null)[]).every(
          (element) => element === null || (element.type !== 'SpreadElement' && expression(element, depth)),
        )
      case 'ObjectExpression':
        return (node['properties'] as AstNode[]).every(
          (property) =>
            property.type === 'Property' &&
            (property['computed'] !== true || expression(property['key'] as AstNode, depth)) &&
            expression(property['value'] as AstNode, depth),
        )
      case 'MemberExpression':
        return memberRead(node, depth)
      case 'AssignmentExpression':
        return node['operator'] === '=' && assigned(node['left'] as AstNode, depth) && expression(node['right'] as AstNode, depth)
      case 'CallExpression':
        return call(node, depth)
      default:
        return false
    }
  }

  /** Whether reading a name can't throw: a declaration it resolves to, or a free name the catalog has. */
  const readable = (id: AstNode): boolean => {
    if (id['name'] === 'undefined') return true
    const declaration = context.declaration(id)
    // A `let`, `const` or `class` read before its declaration throws.
    if (declaration !== undefined) return isFunction(declaration) || declaration.start <= id.start
    const values = context.evaluate(id)
    return values.length > 0 && values.every((value) => value.kind === 'holder' || value.kind === 'native' || value.kind === 'member')
  }

  /** The constant keys a member expression reads, or undefined when one isn't constant. */
  const keysOf = (node: AstNode, depth: number): Key[] | undefined => {
    const property = node['property'] as AstNode
    if (node['computed'] !== true) return property.type === 'Identifier' ? [property['name'] as string] : undefined
    if (!expression(property, depth)) return undefined
    const keys = context.evaluate(property)
    if (keys.length === 0 || !keys.every((key) => key.kind === 'constant')) return undefined
    return keys.map((key) => toPropertyKey((key as Extract<Value, { kind: 'constant' }>).value))
  }

  /**
   * Whether reading a member can't throw: a data member, or none, of a native holder in the unmutated catalog (an
   * accessor's getter runs, and throws on a prototype), or any member of an array or function the code made.
   */
  const memberRead = (node: AstNode, depth: number): boolean => {
    const object = node['object'] as AstNode
    if (object.type === 'Super' || !expression(object, depth)) return false
    const keys = keysOf(node, depth)
    if (keys === undefined) return false
    const values = context.evaluate(object)
    if (values.length === 0) return false
    return values.every((value) => {
      if (made(value)) return keys.every((key) => !poisoned(value, key))
      if (value.kind !== 'holder') return false
      return keys.every((key) => context.target(value.holder, key)?.descriptor.type !== 'accessor')
    })
  }

  /**
   * Whether an assignment target can't throw: a declared variable, a writable data member of a native holder (an
   * accessor's setter runs, and throws on a prototype), or any member of an array or function the code made.
   */
  const assigned = (left: AstNode, depth: number): boolean => {
    if (left.type === 'Identifier') {
      const declaration = context.declaration(left)
      return declaration !== undefined && declaration.start <= left.start && mutable(left, declaration)
    }
    if (left.type !== 'MemberExpression') return false
    const object = left['object'] as AstNode
    if (object.type === 'Super' || !expression(object, depth)) return false
    const keys = keysOf(left, depth)
    if (keys === undefined) return false
    const values = context.evaluate(object)
    if (values.length === 0) return false
    return values.every((value) => {
      if (made(value)) return keys.every((key) => !poisoned(value, key) && !fixed(value, key))
      if (value.kind !== 'holder') return false
      return keys.every((key) => {
        const descriptor = context.target(value.holder, key)?.descriptor
        return descriptor !== undefined && descriptor.type === 'data' && descriptor.writable
      })
    })
  }

  /**
   * Whether a call can't throw: its arguments can't, and it calls a function the code made whose body can't throw
   * (one that catches internally), `push` on an array the code made, or a descriptor read or a define of a configurable
   * member on a native holder.
   */
  const call = (node: AstNode, depth: number): boolean => {
    const args = node['arguments'] as AstNode[]
    if (args.some((arg) => arg.type === 'SpreadElement' || !expression(arg, depth))) return false
    const callee = node['callee'] as AstNode
    if (callee.type === 'MemberExpression' && callee['computed'] !== true) {
      const name = (callee['property'] as AstNode)['name']
      if (name === 'push' && expression(callee['object'] as AstNode, depth)) {
        const values = context.evaluate(callee['object'] as AstNode)
        if (values.length > 0 && values.every((value) => isHeap(value) && value.heap.kind === 'array')) return true
      }
    }
    if (callee.type !== 'Identifier' && !expression(callee, depth)) return false
    if (callee.type === 'Identifier' && !readable(callee)) return false
    const values = context.evaluate(callee)
    if (values.length === 0) return false
    return values.every((value) => {
      if (value.kind === 'native') return nativeCall(value.name, args)
      if (!isHeap(value) || value.heap.kind !== 'function') return false
      return body(value.heap.node, depth)
    })
  }

  /** Whether a native call can't throw on a native holder's member, as the unmutated catalog has it. */
  const nativeCall = (name: string, args: readonly AstNode[]): boolean => {
    if (name !== 'Object.getOwnPropertyDescriptor' && name !== 'Object.defineProperty' && name !== 'Reflect.defineProperty') {
      return false
    }
    const [object, key, descriptor] = args
    if (object === undefined || key === undefined) return false
    const holders = context.evaluate(object)
    if (holders.length === 0 || !holders.every((value) => value.kind === 'holder')) return false
    // Both convert the key, which can throw for an object: only constants are shown not to.
    const keys = context.evaluate(key)
    if (!constants(keys)) return false
    if (name === 'Object.getOwnPropertyDescriptor') return true
    // A define throws when its descriptor is no object or mixes accessor and data fields, and `Object.defineProperty`
    // when the member is there and can't be configured.
    if (descriptor === undefined || descriptor.type !== 'ObjectExpression') return false
    // Each field a plain one, named by an identifier: an accessor field's getter would run, and can throw.
    const properties = descriptor['properties'] as AstNode[]
    const fields = properties.map((property) =>
      property.type === 'Property' && property['computed'] !== true && property['kind'] === 'init'
        ? (property['key'] as AstNode)['name']
        : undefined,
    )
    if (fields.includes(undefined)) return false
    // A getter or setter that is neither a function nor `undefined` throws.
    const callable = (value: AstNode) =>
      isFunction(value) || (value.type === 'Identifier' && value['name'] === 'undefined')
    if (properties.some((property, index) => (fields[index] === 'get' || fields[index] === 'set') && !callable(property['value'] as AstNode))) {
      return false
    }
    if (fields.some((field) => field === 'get' || field === 'set') && fields.some((field) => field === 'value' || field === 'writable')) {
      return false
    }
    if (name === 'Reflect.defineProperty') return true
    return holders.every((value) =>
      keys.every((each) => {
        const target = context.target(
          (value as Extract<Value, { kind: 'holder' }>).holder,
          toPropertyKey((each as Extract<Value, { kind: 'constant' }>).value),
        )
        return target === undefined || target.descriptor.configurable
      }),
    )
  }

  /** Whether calling a function the code made can't throw: simple parameters, and a body that can't. */
  const body = (fn: AstNode, depth: number): boolean => {
    if (active.has(fn) || !isFunction(fn)) return false
    if (depth >= context.maxDepth) {
      context.depthCut(fn)
      return false
    }
    if (fn['async'] === true || fn['generator'] === true) return false
    if (!(fn['params'] as AstNode[]).every((param) => param.type === 'Identifier' || param.type === 'RestElement')) {
      return false
    }
    active.add(fn)
    try {
      const inside = fn['body'] as AstNode
      return inside.type === 'BlockStatement' ? statement(inside, depth + 1) : expression(inside, depth + 1)
    } finally {
      active.delete(fn)
    }
  }

  return { statement, expression }
}

/** Whether an expression is a primitive by its form: a literal other than a regular expression, or a `typeof`. */
function primitive(node: AstNode): boolean {
  if (node.type === 'Literal') return node['regex'] === undefined
  return node.type === 'UnaryExpression' && node['operator'] === 'typeof'
}

/** Whether every value is a constant, which converting to a property key never throws on. */
function constants(values: readonly Value[]): boolean {
  return values.length > 0 && values.every((value) => value.kind === 'constant')
}

/**
 * Whether assigning a name can't throw for what declares it: not a `const` (or `using`), an import, a class's name or
 * a function expression's own name, which strict code can't assign.
 */
function mutable(id: AstNode, declaration: AstNode): boolean {
  switch (declaration.type) {
    case 'VariableDeclaration':
      return declaration['kind'] === 'var' || declaration['kind'] === 'let'
    case 'ImportDeclaration':
    case 'ClassDeclaration':
    case 'ClassExpression':
      return false
    case 'FunctionExpression': {
      // The seam gives the function for its parameters too: a parameter of that name is assignable.
      if ((declaration['id'] as AstNode | null)?.['name'] !== id['name']) return true
      return (declaration['params'] as AstNode[]).some((param) => param.type === 'Identifier' && param['name'] === id['name'])
    }
    default:
      return true
  }
}

/** Whether reading `key` off a function the code made can throw: a strict function's `caller` and `arguments`. */
function poisoned(value: Value, key: Key): boolean {
  return isHeap(value) && value.heap.kind === 'function' && (key === 'caller' || key === 'arguments')
}

/**
 * Whether writing `key` on an array or function the code made can throw: a function's non-writable `name` and
 * `length` in strict code, and an array's `length`, which throws on a value that is no valid length.
 */
function fixed(value: Value, key: Key): boolean {
  if (!isHeap(value)) return true
  return key === 'length' || (value.heap.kind === 'function' && key === 'name')
}

/** Whether every value is an object, which `in` never throws on: a native holder, or one the code made. */
function objects(values: readonly Value[]): boolean {
  return values.length > 0 && values.every((value) => value.kind === 'holder' || isHeap(value))
}

/** Whether a value is an array or a function the code made, whose own members have no accessors it doesn't show. */
function made(value: Value): boolean {
  return isHeap(value) && (value.heap.kind === 'array' || value.heap.kind === 'function')
}

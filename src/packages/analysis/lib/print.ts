// Expressions as a trace shows them (§14): printed from the syntax, so code nested in a string literal (§2) prints as
// the code it is, and cut to a short line.

import type { AstNode } from './ast.ts'

/** How long a printed expression may be. A longer one is cut, and ends in an ellipsis. */
const maxLength = 120

/** An expression printed from its syntax, cut at 120 characters. */
export function printed(node: AstNode): string {
  const text = print(node)
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text
}

/** Operators written as words, which need a space before their operand. */
const wordOperators: ReadonlySet<string> = new Set(['typeof', 'void', 'delete'])

/** Expressions that bind less tightly than any operand, so an operand of one of them is parenthesized. */
const loose: ReadonlySet<string> = new Set([
  'LogicalExpression',
  'ConditionalExpression',
  'SequenceExpression',
  'AssignmentExpression',
  'ArrowFunctionExpression',
  'YieldExpression',
])

function print(node: AstNode): string {
  switch (node.type) {
    case 'Literal':
      return literal(node)
    case 'TemplateLiteral': {
      const quasis = (node['quasis'] as AstNode[]).map((quasi) => (quasi['value'] as { raw: string }).raw)
      const expressions = node['expressions'] as AstNode[]
      return `\`${quasis.map((quasi, index) => (index < expressions.length ? `${quasi}\${${print(expressions[index]!)}}` : quasi)).join('')}\``
    }
    case 'Identifier':
      return node['name'] as string
    case 'PrivateIdentifier':
      return `#${node['name'] as string}`
    case 'ThisExpression':
      return 'this'
    case 'Super':
      return 'super'
    case 'BinaryExpression':
    case 'LogicalExpression': {
      // A left operand with the same operator groups the way it is written: `"a" + "b" + "c"`. The chain is printed from
      // a list rather than by recursion, because minified code builds long ones, and only up to a trace line.
      const operator = node['operator'] as string
      const rights: AstNode[] = []
      let left = node
      while (left.type === node.type && left['operator'] === operator) {
        rights.push(left['right'] as AstNode)
        left = left['left'] as AstNode
      }
      let text = operand(left, false)
      for (const right of rights.reverse()) {
        if (text.length > maxLength) break
        text += ` ${operator} ${operand(right, false)}`
      }
      return text
    }
    case 'UnaryExpression': {
      const operator = node['operator'] as string
      const argument = operand(node['argument'] as AstNode, false)
      return wordOperators.has(operator) ? `${operator} ${argument}` : `${operator}${argument}`
    }
    case 'ConditionalExpression':
      return `${operand(node['test'] as AstNode, false)} ? ${print(node['consequent'] as AstNode)} : ${print(node['alternate'] as AstNode)}`
    case 'SequenceExpression':
      return `(${list(node['expressions'] as AstNode[])})`
    case 'AssignmentExpression':
      return `${print(node['left'] as AstNode)} ${node['operator'] as string} ${print(node['right'] as AstNode)}`
    case 'AssignmentPattern':
      return `${print(node['left'] as AstNode)} = ${print(node['right'] as AstNode)}`
    case 'MemberExpression': {
      const object = operand(node['object'] as AstNode, false)
      const property = node['property'] as AstNode
      const optional = node['optional'] === true ? '?.' : ''
      if (node['computed'] === true) return `${object}${optional}[${print(property)}]`
      return `${object}${optional === '' ? '.' : optional}${print(property)}`
    }
    case 'ChainExpression':
      return print(node['expression'] as AstNode)
    case 'CallExpression':
      return `${operand(node['callee'] as AstNode, false)}(${list(node['arguments'] as AstNode[])})`
    case 'NewExpression':
      return `new ${operand(node['callee'] as AstNode, false)}(${list(node['arguments'] as AstNode[])})`
    case 'ArrayExpression':
      return `[${list(node['elements'] as (AstNode | null)[])}]`
    case 'ObjectExpression':
      return (node['properties'] as AstNode[]).length === 0 ? '{}' : '{…}'
    case 'SpreadElement':
    case 'RestElement':
      return `...${print(node['argument'] as AstNode)}`
    case 'VariableDeclarator': {
      // A definition (§14 `alias`): the declarator's pattern and its initializer.
      const init = node['init'] as AstNode | null
      return init === null ? print(node['id'] as AstNode) : `${print(node['id'] as AstNode)} = ${print(init)}`
    }
    case 'VariableDeclaration':
      return `${node['kind'] as string} ${list(node['declarations'] as AstNode[])}`
    case 'UpdateExpression': {
      const argument = print(node['argument'] as AstNode)
      const operator = node['operator'] as string
      return node['prefix'] === true ? `${operator}${argument}` : `${argument}${operator}`
    }
    case 'ForInStatement':
    case 'ForOfStatement':
      return `for (${print(node['left'] as AstNode)} ${node.type === 'ForInStatement' ? 'in' : 'of'} ${print(node['right'] as AstNode)})`
    case 'ObjectPattern':
      return `{ ${list(node['properties'] as AstNode[])} }`
    case 'ArrayPattern':
      return `[${list(node['elements'] as (AstNode | null)[])}]`
    case 'Property': {
      const key = node['key'] as AstNode
      const value = print(node['value'] as AstNode)
      if (node['shorthand'] === true) return value
      return `${node['computed'] === true ? `[${print(key)}]` : print(key)}: ${value}`
    }
    default:
      return '…'
  }
}

/** An operand, parenthesized when it binds less tightly than the expression it is in. */
function operand(node: AstNode, tight: boolean): string {
  const text = print(node)
  const parenthesized = loose.has(node.type) || (!tight && node.type === 'BinaryExpression')
  return parenthesized ? `(${text})` : text
}

/** A comma-separated list, with holes left empty, that stops once it is longer than a trace line. */
function list(nodes: readonly (AstNode | null)[]): string {
  let text = ''
  for (const [index, node] of nodes.entries()) {
    if (index > 0) text += ', '
    if (text.length > maxLength) return `${text}…`
    if (node !== null) text += print(node)
  }
  return text
}

function literal(node: AstNode): string {
  const regex = node['regex'] as { pattern: string; flags: string } | null | undefined
  if (regex !== null && regex !== undefined) return `/${regex.pattern}/${regex.flags}`
  const bigint = node['bigint'] as string | null | undefined
  if (bigint !== null && bigint !== undefined) return `${bigint}n`
  const value = node['value']
  // A long string is cut before it is quoted, so a trace never copies a huge literal.
  return typeof value === 'string' ? JSON.stringify(value.length > maxLength ? value.slice(0, maxLength) : value) : String(value)
}

// oxc's ESTree nodes, walked generically through its visitor keys.

import { visitorKeys } from 'oxc-parser'

export interface AstNode {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

/**
 * Visits every node in document order, without recursion: `enter` before a node's children, with its parent, and
 * `leave` after them. When `enter` returns `false`, the node's children are skipped and `leave` is not called for it.
 */
export function walkTree(
  root: AstNode,
  visitor: { enter(node: AstNode, parent: AstNode | null): void | false; leave?(node: AstNode): void },
): void {
  const stack: { node: AstNode; parent: AstNode | null; leaving: boolean }[] = [{ node: root, parent: null, leaving: false }]
  while (stack.length > 0) {
    const { node, parent, leaving } = stack.pop()!
    if (leaving) {
      visitor.leave?.(node)
      continue
    }
    if (visitor.enter(node, parent) === false) continue
    if (visitor.leave !== undefined) stack.push({ node, parent, leaving: true })
    const keys = visitorKeys[node.type] ?? []
    for (let k = keys.length - 1; k >= 0; k--) {
      const child = node[keys[k]!]
      if (Array.isArray(child)) {
        for (let c = child.length - 1; c >= 0; c--) {
          if (isNode(child[c])) stack.push({ node: child[c], parent: node, leaving: false })
        }
      } else if (isNode(child)) stack.push({ node: child, parent: node, leaving: false })
    }
  }
}

export function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

/** The expression a callee takes its function from: past the discarded operands of comma sequences, as in `(0, a.b)`. */
export function calleeExpression(callee: AstNode): AstNode {
  let expression = callee
  while (expression.type === 'SequenceExpression') expression = (expression['expressions'] as AstNode[]).at(-1)!
  return expression
}

/**
 * A call that is a direct eval when its `eval` is the global one (ECMA-262 PerformEval): `eval(…)` through the plain
 * name, parenthesized or not. An optional call (`eval?.(s)`) and a sequence (`(0, eval)(s)`) are indirect.
 */
export function isEvalCall(node: AstNode): boolean {
  if (node.type !== 'CallExpression' || node['optional'] === true) return false
  const callee = node['callee'] as AstNode
  return callee.type === 'Identifier' && callee['name'] === 'eval'
}

/**
 * Whether an object literal's property with key `key` is `__proto__: p`, which sets the literal's prototype rather than
 * defining an own property (ECMA-262 PropertyDefinitionEvaluation). A computed key, a shorthand, a method or an
 * accessor named `__proto__` defines an own property like any other.
 */
export function setsLiteralPrototype(property: AstNode, key: string): boolean {
  return (
    key === '__proto__' &&
    property['kind'] === 'init' &&
    property['computed'] !== true &&
    property['shorthand'] !== true &&
    property['method'] !== true
  )
}

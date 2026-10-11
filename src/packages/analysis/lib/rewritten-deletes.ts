// A delete that is always rewritten (§3). A delete that the same function follows, on every path, with a define or
// assign of the same slot gives no finding of its own: the later write's finding stands, and the delete leaves only a
// trace `note`. So core-js's `defineBuiltIn(Array.prototype, wellKnownSymbol('iterator'), …)`, which runs
// `try { if (!options.unsafe) delete O[key] } catch {}` and then `O[key] = value` or `definePropertyModule.f(O, key, …)`,
// gives one `Array.prototype.@@iterator` `replace`. A delete that isn't always rewritten stays a `delete` finding.
//
// This module decides "on every path", from the syntax of the function the delete is in: which nodes write the slot
// (an assignment, or a call whose instantiation writes it) is the caller's to say.

import { walkTree, type AstNode } from './ast.ts'
import { isFunction } from './summaries.ts'


/** Statements that may leave the code after them: control leaves before it runs. */
const leaving: ReadonlySet<string> = new Set(['ReturnStatement', 'ThrowStatement', 'BreakStatement', 'ContinueStatement'])

/**
 * Whether every path from the delete `site` to the end of its function, `fn`, runs one of the nodes `writes` accepts,
 * in `fn`'s own code, before control can leave. `parentOf` gives each node's parent.
 */
export function alwaysRewritten(
  site: AstNode,
  fn: AstNode,
  writes: (node: AstNode) => boolean,
  parentOf: (node: AstNode) => AstNode | undefined,
): boolean {
  /** Whether evaluating `expression` always runs a write, before anything that could skip it. */
  const expressionWrites = (expression: AstNode): boolean => {
    if (writes(expression)) return true
    switch (expression.type) {
      case 'SequenceExpression':
        return (expression['expressions'] as AstNode[]).some(expressionWrites)
      case 'ConditionalExpression':
        return (
          expressionWrites(expression['test'] as AstNode) ||
          (expressionWrites(expression['consequent'] as AstNode) && expressionWrites(expression['alternate'] as AstNode))
        )
      case 'LogicalExpression':
        return expressionWrites(expression['left'] as AstNode)
      case 'AssignmentExpression':
        return expression['operator'] === '=' && expressionWrites(expression['right'] as AstNode)
      case 'ParenthesizedExpression':
      case 'ChainExpression':
        return expressionWrites(expression['expression'] as AstNode)
      default:
        return false
    }
  }

  /** Whether running `statement` always runs a write before control can leave it. */
  const statementWrites = (statement: AstNode): boolean => {
    switch (statement.type) {
      case 'ExpressionStatement':
        return expressionWrites(statement['expression'] as AstNode)
      case 'ReturnStatement':
      case 'ThrowStatement': {
        const argument = statement['argument'] as AstNode | null
        return argument !== null && expressionWrites(argument)
      }
      case 'VariableDeclaration':
        return (statement['declarations'] as AstNode[]).some((declarator) => {
          const init = declarator['init'] as AstNode | null
          return init !== null && expressionWrites(init)
        })
      case 'BlockStatement':
        return listWrites(statement['body'] as AstNode[], 0)
      case 'IfStatement': {
        const alternate = statement['alternate'] as AstNode | null
        return (
          expressionWrites(statement['test'] as AstNode) ||
          (alternate !== null && statementWrites(statement['consequent'] as AstNode) && statementWrites(alternate))
        )
      }
      case 'TryStatement': {
        // A write that throws writes nothing, so the handler must write too; a finalizer that writes always does.
        const handler = statement['handler'] as AstNode | null
        const finalizer = statement['finalizer'] as AstNode | null
        if (finalizer !== null && statementWrites(finalizer)) return true
        const block = statementWrites(statement['block'] as AstNode)
        return block && (handler === null || statementWrites(handler['body'] as AstNode))
      }
      default:
        return false
    }
  }

  /** Whether running `list` from `from` always runs a write before control can leave it. */
  const listWrites = (list: readonly AstNode[], from: number): boolean => {
    for (let index = from; index < list.length; index++) {
      const statement = list[index]!
      if (statementWrites(statement)) return true
      if (mayLeave(statement)) return false
    }
    return false
  }

  // Out from the delete: what runs after each node around it, until the function's end.
  for (let child = site, parent = parentOf(site); parent !== undefined; child = parent, parent = parentOf(parent)) {
    if (child === fn || isFunction(child)) return false
    switch (parent.type) {
      case 'SequenceExpression': {
        const expressions = parent['expressions'] as AstNode[]
        if (expressions.slice(expressions.indexOf(child) + 1).some(expressionWrites)) return true
        break
      }
      case 'BlockStatement':
      case 'StaticBlock':
      case 'Program': {
        const list = parent['body'] as AstNode[]
        if (listWrites(list, list.indexOf(child) + 1)) return true
        break
      }
      case 'SwitchCase':
      case 'SwitchStatement':
      case 'LabeledStatement':
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
        // What runs after these the walk doesn't follow.
        return false
      case 'TryStatement':
        // A delete in the `try` block that throws goes to the handler, which must not leave; one in the finalizer or
        // handler goes on after the statement.
        if (child === parent['block']) {
          const handler = parent['handler'] as AstNode | null
          if (handler !== null && mayLeave(handler['body'] as AstNode)) return false
        }
        break
      default:
        if (isFunction(parent)) return false
    }
  }
  return false
}

/** Whether control may leave a statement other than by reaching its end: a `return`, `throw`, `break` or `continue`. */
function mayLeave(statement: AstNode): boolean {
  let found = false
  walkTree(statement, {
    enter(node) {
      if (found || (node !== statement && isFunction(node))) return false
      if (leaving.has(node.type)) found = true
    },
  })
  return found
}

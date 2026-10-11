// Once-flags (§5 Resolver capabilities 6). A once-flag is recognized by use: a variable or parameter is a flag when a
// function tests it (`if`, `?:`, `&&`, `||`, `!`, an early return) and then assigns it on the path that test lets
// through, directly or in a call on that path, whatever value it assigns. A flag's tests are never decided as
// constants, so Rollup's `if (Ki) return Xi; Ki = 1`, `ge || (ge = 1, …)` and esbuild's `t && (e = t(t = 0))` keep the
// code after them. A variable that no function tests before assigning it (esbuild's init-thunk constants, `Nl = 4`) is
// no flag, and its tests still decide. Whether the variable reads a catalog native, which keeps its test a §7 guard, is
// the evaluator's to judge from its values.

import { walkTree, type AstNode } from './ast.ts'
import type { Definitions, VariableKey } from './definitions.ts'
import { isFunction, type CallGraph } from './summaries.ts'

export interface OnceFlags {
  /** Whether a variable is a once-flag: some function tests it and then assigns it on the path the test lets through. */
  isFlag(key: VariableKey): boolean
}


/**
 * `maxCallDepth` is how many calls deep an assignment is followed from the path a test lets through (`flagDepth`, §18),
 * and `depthCut` hears each function it keeps from being followed, a hit of that cap.
 */
export function onceFlags(
  program: AstNode,
  definitions: Definitions,
  calls: CallGraph,
  maxCallDepth: number,
  depthCut: (fn: AstNode) => void = () => {},
): OnceFlags {
  /** The nodes that test a name (an `if`, a `?:`, a `&&`/`||`, a `||=`/`&&=`), by the names they test. */
  let testers: Map<string, AstNode[]> | undefined
  /** Each statement's list and index in it, for the statements after an early return. */
  const lists = new Map<AstNode, { list: readonly AstNode[]; at: number }>()
  const memo = new Map<AstNode | 'global', Map<string, boolean>>()

  function indexed(): Map<string, AstNode[]> {
    if (testers !== undefined) return testers
    const found = new Map<string, AstNode[]>()
    const add = (tester: AstNode, test: AstNode) => {
      for (const id of testedNames(test)) {
        const name = id['name'] as string
        const list = found.get(name)
        if (list === undefined) found.set(name, [tester])
        else if (list.at(-1) !== tester) list.push(tester)
      }
    }
    walkTree(program, {
      enter(node) {
        for (const key of ['body', 'consequent'] as const) {
          const list = node[key]
          if (Array.isArray(list)) list.forEach((statement, at) => lists.set(statement as AstNode, { list: list as AstNode[], at }))
        }
        switch (node.type) {
          case 'IfStatement':
          case 'ConditionalExpression':
            add(node, node['test'] as AstNode)
            break
          case 'LogicalExpression':
            if (node['operator'] !== '??') add(node, node['left'] as AstNode)
            break
          case 'AssignmentExpression':
            if (node['operator'] === '||=' || node['operator'] === '&&=') add(node, node['left'] as AstNode)
            break
        }
      },
    })
    return (testers = found)
  }

  /** Whether a test reads the variable `key` as a test does: itself, under `!`, `typeof` or a comparison. */
  const tests = (test: AstNode, key: VariableKey): boolean =>
    testedNames(test).some((id) => {
      const read = definitions.keyOf(id)
      return read !== undefined && read.scope === key.scope && read.name === key.name
    })

  /** The code a test lets through: its arms, the right side, and the statements after an arm that always leaves. */
  function letThrough(tester: AstNode): AstNode[] {
    switch (tester.type) {
      case 'IfStatement': {
        const consequent = tester['consequent'] as AstNode
        const alternate = tester['alternate'] as AstNode | null
        const arms = alternate === null ? [consequent] : [consequent, alternate]
        const place = lists.get(tester)
        const early = place !== undefined && arms.some(leaves)
        return early ? [...arms, ...place.list.slice(place.at + 1)] : arms
      }
      case 'ConditionalExpression':
        return [tester['consequent'] as AstNode, tester['alternate'] as AstNode]
      case 'LogicalExpression':
        return [tester['right'] as AstNode]
      default:
        // `k ||= …` assigns what it tests.
        return [tester]
    }
  }

  function isFlag(key: VariableKey): boolean {
    let byName = memo.get(key.scope)
    if (byName === undefined) memo.set(key.scope, (byName = new Map()))
    let flag = byName.get(key.name)
    if (flag === undefined) byName.set(key.name, (flag = recognized(key)))
    return flag
  }

  function recognized(key: VariableKey): boolean {
    const candidates = indexed().get(key.name)
    if (candidates === undefined) return false
    const all = definitions.of(key)
    if (all.length === 0) return false
    /** The functions whose own code assigns the variable. */
    const owners = new Set(all.map((definition) => calls.functionOf(definition.site) ?? program))
    const assigning = new Map<AstNode, boolean>()
    /** Whether a call of `fn` assigns the variable, in `fn`'s own code or in a call it makes, `depth` calls deep. */
    const assigns = (fn: AstNode, depth: number): boolean => {
      if (owners.has(fn)) return true
      if (depth >= maxCallDepth) {
        depthCut(fn)
        return false
      }
      const known = assigning.get(fn)
      if (known !== undefined) return known
      assigning.set(fn, false)
      const body = fn['body'] as AstNode
      const result = callsIn(body, fn).some((call) => calls.sitesOf(call).some((site) => assigns(site.fn, depth + 1)))
      assigning.set(fn, result)
      return result
    }
    for (const tester of candidates) {
      if (!tests(tester.type === 'IfStatement' || tester.type === 'ConditionalExpression' ? (tester['test'] as AstNode) : (tester['left'] as AstNode), key)) {
        continue
      }
      const fn = calls.functionOf(tester) ?? program
      for (const region of letThrough(tester)) {
        // An assignment in the tester's own code on that path.
        const direct = all.some(
          (definition) =>
            region.start <= definition.site.start &&
            definition.site.end <= region.end &&
            (calls.functionOf(definition.site) ?? program) === fn,
        )
        if (direct) return true
        // Or in a call made on that path.
        if (callsIn(region, fn).some((call) => calls.sitesOf(call).some((site) => assigns(site.fn, 1)))) return true
      }
    }
    return false
  }

  return { isFlag }
}

/** The calls and `new`s in `node` that are the own code of `fn`: not in a function nested in it. */
function callsIn(node: AstNode, fn: AstNode): AstNode[] {
  const found: AstNode[] = []
  walkTree(node, {
    enter(child) {
      if (child !== node && child !== fn && isFunction(child)) return false
      if (child.type === 'CallExpression' || child.type === 'NewExpression') found.push(child)
    },
  })
  return found
}

/** The identifiers a test reads as a test does: the test itself, under `!` or `typeof`, compared, or in `&&`/`||`. */
function testedNames(test: AstNode): AstNode[] {
  switch (test.type) {
    case 'Identifier':
      return [test]
    case 'UnaryExpression':
      return test['operator'] === '!' || test['operator'] === 'typeof' ? testedNames(test['argument'] as AstNode) : []
    case 'BinaryExpression':
      return ['==', '!=', '===', '!==', '<', '>', '<=', '>='].includes(test['operator'] as string)
        ? [...testedNames(test['left'] as AstNode), ...testedNames(test['right'] as AstNode)].filter(
            (id) => !isLiteralName(id),
          )
        : []
    case 'LogicalExpression':
      return [...testedNames(test['left'] as AstNode), ...testedNames(test['right'] as AstNode)]
    case 'SequenceExpression':
      return testedNames((test['expressions'] as AstNode[]).at(-1)!)
    default:
      return []
  }
}

/** `undefined`, `NaN` and `Infinity`, which a comparison reads as values rather than tests. */
const isLiteralName = (id: AstNode): boolean => ['undefined', 'NaN', 'Infinity'].includes(id['name'] as string)

/** Whether a statement always leaves the code after it: a `return` or `throw`, or a block or `if` that always does. */
function leaves(statement: AstNode): boolean {
  switch (statement.type) {
    case 'ReturnStatement':
    case 'ThrowStatement':
      return true
    case 'BlockStatement':
      return (statement['body'] as AstNode[]).some(leaves)
    case 'IfStatement': {
      const alternate = statement['alternate'] as AstNode | null
      return alternate !== null && leaves(statement['consequent'] as AstNode) && leaves(alternate)
    }
    default:
      return false
  }
}

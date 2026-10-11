// Early exits (§5 Global resolution, §7): an `if` whose one arm always returns or throws guards every statement after
// it in its statement list, nested blocks and the functions created there included, with its test's other outcome. A
// script's or module's top-level body counts like a function body.

import type { AstNode } from './ast.ts'

/** A guard an early exit makes: the code after it runs when `test` is `outcome`. */
export interface ExitGuard {
  test: AstNode
  outcome: boolean
}

/** The statement lists whose earlier `if (…) return` or `throw` guards the statements after it (§5, §7). */
export const statementLists: Readonly<Record<string, string>> = {
  Program: 'body',
  BlockStatement: 'body',
  StaticBlock: 'body',
  SwitchCase: 'consequent',
}

/**
 * The early exits of each statement list, by the index of the statement they guard from: an `if` whose one arm always
 * returns or throws guards every statement after it in its list with its test's other outcome (§7 early returns).
 */
const exitsOf = new WeakMap<AstNode, { index: number; guard: ExitGuard }[]>()

export function earlyExits(list: AstNode): { index: number; guard: ExitGuard }[] {
  let found = exitsOf.get(list)
  if (found !== undefined) return found
  found = []
  const key = statementLists[list.type]
  const body = key === undefined ? [] : ((list[key] as AstNode[] | undefined) ?? [])
  body.forEach((statement, index) => {
    if (statement.type !== 'IfStatement') return
    const consequent = statement['consequent'] as AstNode
    const alternate = statement['alternate'] as AstNode | null
    const test = statement['test'] as AstNode
    if (alwaysExits(consequent) && (alternate === null || !alwaysExits(alternate))) {
      found!.push({ index, guard: { test, outcome: false } })
    } else if (alternate !== null && alwaysExits(alternate) && !alwaysExits(consequent)) {
      found!.push({ index, guard: { test, outcome: true } })
    }
  })
  exitsOf.set(list, found)
  return found
}

/** Whether a statement always leaves its function: a `return` or `throw`, a block with one, or an `if` both arms do. */
export function alwaysExits(statement: AstNode): boolean {
  switch (statement.type) {
    case 'ReturnStatement':
    case 'ThrowStatement':
      return true
    case 'BlockStatement':
      return (statement['body'] as AstNode[]).some(alwaysExits)
    case 'IfStatement': {
      const alternate = statement['alternate'] as AstNode | null
      return alternate !== null && alwaysExits(statement['consequent'] as AstNode) && alwaysExits(alternate)
    }
    default:
      return false
  }
}

/** The positions of each statement list's statements, for `exitsBefore` and `reachedAfter`. */
const positionsOf = new WeakMap<AstNode, Map<AstNode, number>>()

/** The index of `child` in the statement list `list[key]`, or undefined when it is not one of its statements. */
function positionIn(list: AstNode, key: string, child: AstNode): number | undefined {
  let positions = positionsOf.get(list)
  if (positions === undefined) {
    positions = new Map(((list[key] as AstNode[] | undefined) ?? []).map((statement, index) => [statement, index]))
    positionsOf.set(list, positions)
  }
  return positions.get(child)
}

/** The guards of the early exits before `child` in the statement list `list`, first first. None for any other edge. */
export function exitsBefore(list: AstNode, child: AstNode): ExitGuard[] {
  const key = statementLists[list.type]
  if (key === undefined) return []
  const exits = earlyExits(list)
  if (exits.length === 0) return []
  const index = positionIn(list, key, child)
  if (index === undefined) return []
  return exits.filter((exit) => exit.index < index).map((exit) => exit.guard)
}

/**
 * A condition on a statement's tests, under which control reaches a point: `true`, `false` (it never does), a test
 * with the outcome it takes, or all or any of several conditions.
 */
export type Condition = boolean | ExitGuard | { all: Condition[] } | { any: Condition[] }

function all(conditions: readonly Condition[]): Condition {
  const kept: Condition[] = []
  for (const each of conditions) {
    if (each === false) return false
    if (each !== true) kept.push(each)
  }
  return kept.length === 0 ? true : kept.length === 1 ? kept[0]! : { all: kept }
}

function any(conditions: readonly Condition[]): Condition {
  const kept: Condition[] = []
  for (const each of conditions) {
    if (each === true) return true
    if (each !== false) kept.push(each)
  }
  return kept.length === 0 ? false : kept.length === 1 ? kept[0]! : { any: kept }
}

const fallsThroughWhen = new WeakMap<AstNode, Condition>()

/**
 * When control leaves a statement at its end rather than by a `return` or `throw` in it (§7 early returns): `if (t)
 * return` falls through when `t` is false, and `if (p) { …; if (q) return }` when `p` is false or `q` is. A `continue`
 * leaves too: it ends its loop's iteration, and the loop holds every statement list this walks into, so `if (typeof
 * proto[k] !== 'function') continue` filters a swept key (§5 Resolver capabilities 9). Loops,
 * `switch`, `try` and labelled statements are taken to fall through, and the functions a statement creates are not
 * entered.
 */
export function fallsThrough(statement: AstNode): Condition {
  let found = fallsThroughWhen.get(statement)
  if (found !== undefined) return found
  switch (statement.type) {
    case 'ReturnStatement':
    case 'ThrowStatement':
    case 'ContinueStatement':
      found = false
      break
    case 'BlockStatement':
      found = all((statement['body'] as AstNode[]).map(fallsThrough))
      break
    case 'IfStatement': {
      const test = statement['test'] as AstNode
      const alternate = statement['alternate'] as AstNode | null
      const consequent = fallsThrough(statement['consequent'] as AstNode)
      const otherwise = alternate === null ? true : fallsThrough(alternate)
      // When both arms fall through, the test decides nothing: `t || !t` always holds.
      found =
        consequent === true && otherwise === true
          ? true
          : any([all([{ test, outcome: true }, consequent]), all([{ test, outcome: false }, otherwise])])
      break
    }
    default:
      found = true
  }
  fallsThroughWhen.set(statement, found)
  return found
}

/** The conditions under which each statement of a list is reached from the list's start, by index. */
const reachedWhen = new WeakMap<AstNode, Condition[]>()

/**
 * The condition under which control reaches `child` from the start of the statement list `list`: every statement before
 * it fell through. `true` for any other edge.
 */
export function reachedAfter(list: AstNode, child: AstNode): Condition {
  const key = statementLists[list.type]
  if (key === undefined) return true
  let conditions = reachedWhen.get(list)
  if (conditions === undefined) {
    conditions = []
    let sofar: Condition = true
    for (const statement of (list[key] as AstNode[] | undefined) ?? []) {
      conditions.push(sofar)
      sofar = all([sofar, fallsThrough(statement)])
    }
    reachedWhen.set(list, conditions)
  }
  const index = positionIn(list, key, child)
  return index === undefined ? true : conditions[index]!
}

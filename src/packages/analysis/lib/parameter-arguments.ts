// The arguments a helper's parameter takes (§5 Resolver capabilities 3): a parameter of a function instantiated from
// listed calls holds what each call passes, evaluated where the call is. Wrap evidence and restore proofs (§3)
// read them where the values alone can't say what they need: that a value is a factory's result given the original, or
// the slot a constructor was read from.

import type { AstNode } from './ast.ts'
import type { Definitions } from './definitions.ts'
import type { Position } from './global-object.ts'

/**
 * The arguments a parameter `id` takes, each where its call evaluates it, when `id` reads a plain parameter of a function
 * that a frame of `at` instantiates from listed calls, and nothing in the function reassigns it. Undefined otherwise: a
 * function judged from its creation site, a destructured or reassigned parameter, a spread or unlisted argument.
 */
export function parameterArguments(definitions: Definitions, id: AstNode, at: Position): { node: AstNode; at: Position }[] | undefined {
  const key = definitions.keyOf(id)
  if (key === undefined || key.scope === 'global') return undefined
  const fn = key.scope
  const index = ((fn['params'] as AstNode[] | undefined) ?? []).findIndex(
    (param) => param.type === 'Identifier' && param['name'] === key.name,
  )
  if (index < 0 || definitions.of(key).length > 0) return undefined
  let frame = at.frame
  while (frame !== undefined && frame.fn !== fn) frame = frame.outer
  if (frame === undefined || frame.how === 'creation' || frame.bindings.length === 0) return undefined
  const found: { node: AstNode; at: Position }[] = []
  for (const { site, caller, element } of frame.bindings) {
    // An iteration native's callback is passed the element it visits, which no argument expression gives.
    const argument = element === undefined ? site.args[index] : undefined
    if (argument === undefined || argument.type === 'SpreadElement') return undefined
    if (site.unlisted !== undefined && index >= site.unlisted) return undefined
    found.push({ node: argument, at: { guard: (name) => site.guards.get(name), topLevel: site.topLevel, frame: caller } })
  }
  return found
}

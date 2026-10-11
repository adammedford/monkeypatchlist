// What discovery reads from the code of a file only the sweep found (§2 Sweep, Realm): no reference says how it is
// loaded or where it runs, so its source type, and the worker markers that make its assumed `window` realm uncertain,
// come from its syntax. A file only a `<link rel=preload as=script>` names, or only preloads that disagree, and a
// worker's script whose options can't be read statically take their source type the same way, and any file whose
// realm is assumed has its worker markers read (§2 Discovery, Files that don't run as referenced, §13
// `realm-uncertain`). Syntax only.

import { visitorKeys } from 'oxc-parser'
import { isNode, parseCode, type Node } from './syntax.ts'

/**
 * A worker marker (§2 Realm): a top-level `importScripts` call, or a `self.addEventListener` call for an `install`,
 * `fetch` or `message` event, with the call's UTF-16 range.
 */
export interface WorkerMarker {
  marker: 'importScripts' | 'install' | 'fetch' | 'message'
  start: number
  end: number
}

/** The events whose listeners on `self` mark a worker: a service worker's `install` and `fetch`, and `message`. */
const workerEvents = new Set(['install', 'fetch', 'message'])

/** The words every worker marker holds: code without them has none, and needs no parse to say so. */
const markerWords = /\b(?:importScripts|addEventListener)\b/

/**
 * The source type of a file no reference loads, and its worker markers in source order. Its source type comes from its
 * syntax (`bySyntax`), and code that parses as neither has no markers.
 */
export function sweptCode(text: string): { sourceType: 'script' | 'module'; markers: WorkerMarker[] } {
  const mayHaveMarkers = markerWords.test(text)
  const { sourceType, program } = bySyntax(text, mayHaveMarkers)
  return { sourceType, markers: program === undefined ? [] : workerMarkers(program) }
}

/**
 * The worker markers in code of the source type `sourceType`, in source order: none when it doesn't parse as that type.
 */
export function workerMarkersAs(text: string, sourceType: 'script' | 'module'): WorkerMarker[] {
  if (!markerWords.test(text)) return []
  const parsed = parseCode(text, sourceType)
  return parsed === undefined ? [] : workerMarkers(parsed.program)
}

/**
 * The source type of code no reference says how to load, as a sweep-only file's (§2 Sweep): a `module` when it parses
 * only as a module, because it holds an `import` or `export` declaration, `import.meta` or a top-level `await`, and a
 * `script` otherwise. Code that parses as neither is a `script`, which the resolver reports as a `parse-failure`.
 */
export function sourceTypeBySyntax(text: string): 'script' | 'module' {
  return bySyntax(text, false).sourceType
}

/** The source type of code by its syntax, and its program as that type when `withProgram` asks for it and it parses. */
function bySyntax(text: string, withProgram: boolean): { sourceType: 'script' | 'module'; program?: Node } {
  // Only these words let a module parse accept what a script parse refuses; every other difference goes the other way.
  const mayBeModule = /\b(?:import|export|await)\b/.test(text)
  if (!mayBeModule && !withProgram) return { sourceType: 'script' }
  const script = parseCode(text, 'script')
  const module = script === undefined && mayBeModule ? parseCode(text, 'module') : undefined
  const parsed = script?.program ?? module?.program
  const sourceType = module === undefined ? 'script' : 'module'
  return withProgram && parsed !== undefined ? { sourceType, program: parsed } : { sourceType }
}

/**
 * The worker markers in a program, in source order. `importScripts` counts only in top-level code, outside every
 * function and class body; a listener on `self` counts anywhere, when its event is named by a literal.
 */
function workerMarkers(program: Node): WorkerMarker[] {
  const markers: WorkerMarker[] = []
  const stack: { node: Node; topLevel: boolean }[] = [{ node: program, topLevel: true }]
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, topLevel } = item
    if (node.type === 'CallExpression') {
      const marker = markerOf(node, topLevel)
      if (marker !== undefined) markers.push({ marker, start: node.start, end: node.end })
    }
    const nested = topLevel && !scopes.has(node.type)
    for (const key of visitorKeys[node.type] ?? []) {
      const value = node[key]
      for (const child of Array.isArray(value) ? value : [value]) {
        if (isNode(child)) stack.push({ node: child, topLevel: nested })
      }
    }
  }
  return markers.sort((a, b) => a.start - b.start)
}

/** The nodes whose code does not run at the top level: functions, and class bodies. */
const scopes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassBody'])

/** The worker marker a call is, if any. */
function markerOf(call: Node, topLevel: boolean): WorkerMarker['marker'] | undefined {
  const callee = call['callee'] as Node
  if (callee.type === 'Identifier') return topLevel && callee['name'] === 'importScripts' ? 'importScripts' : undefined
  if (callee.type !== 'MemberExpression') return undefined
  const object = callee['object'] as Node
  if (object.type !== 'Identifier' || object['name'] !== 'self') return undefined
  if (literal(callee['property'] as Node, callee['computed'] === true) !== 'addEventListener') return undefined
  const [event] = call['arguments'] as Node[]
  const name = event === undefined ? undefined : literal(event, true)
  return name !== undefined && workerEvents.has(name) ? (name as WorkerMarker['marker']) : undefined
}

/**
 * The string a property key or an argument spells: an identifier's name, when it is not computed, or a string literal
 * or template literal without substitutions.
 */
function literal(node: Node, computed: boolean): string | undefined {
  if (!computed) return node.type === 'Identifier' ? (node['name'] as string) : undefined
  if (node.type === 'Literal' && typeof node['value'] === 'string') return node['value']
  if (node.type === 'TemplateLiteral' && (node['expressions'] as Node[]).length === 0) {
    return ((node['quasis'] as Node[])[0]!['value'] as { cooked: string | null }).cooked ?? undefined
  }
  return undefined
}

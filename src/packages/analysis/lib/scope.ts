// monkeypatchlist's scope post-passes (§5 Parsing and scope), which run above the binding-resolution seam (§19). The seam
// resolves names under standard ES2015+ block scoping; these passes correct it for how browsers run the code:
//
// 1. In a classic script, global-scope `var` and `function` declarations bind properties of the global object, and
//    `let`, `const` and `class` do not.
// 2. Annex B block-function hoisting: in sloppy code, a plain function declared in a block also gets a var binding in
//    its function, or in a classic script's global object (ECMA-262 B.3.2).
// 3. `with` and direct-`eval` taint: a `with` block on a name's resolution path could redirect it to an object
//    property, and a direct `eval` in a sloppy function on it could declare a shadowing `var`. Both lower target
//    confidence (§9) rather than change the resolution.
// 4. An unqualified `delete x` of a name these rules bind on the global object is a global delete. The resolver reports
//    it, and `isStrict` rules out strict code, where it is a SyntaxError.
//
// For constant propagation (§5 Resolver capabilities 1), `constant` gives the `const` declaration a local name resolves
// to after these passes, with the taint between the two.
//
// They also place the declarations of nested code (§2): a literal direct eval's code, grafted in place of its literal
// as an arrow function (`ScopeOptions.directEvals`), declares its top-level `var`s and functions in its caller's var
// scope when it is sloppy, and in a var scope of its own when it is strict. Global code resolves a name the host
// script declares lexically at its top level to that declaration (`ScopeOptions.lexicalGlobals`), and strict eval code
// keeps its top-level `var`s to itself (`ScopeOptions.evalCode`).

import { isEvalCall, walkTree, type AstNode } from './ast.ts'
import type { BindingResolver, IdentifierNode, OxcProgram, Resolution } from './binding.ts'
import type { GlobalDeclarationKind } from './types.ts'

/** A declaration that binds a property of the global object (§5). */
export interface GlobalDeclaration {
  kind: GlobalDeclarationKind
  node: AstNode
}

/** What lies on a name's resolution path that could make it resolve elsewhere (§5 post-pass 3). */
export interface Taint {
  /** The `with` statements on the resolution path, in document order. */
  withs: AstNode[]
  /** The direct `eval` calls in sloppy functions on the resolution path, in document order. */
  evals: AstNode[]
}

/**
 * A name that resolves to a property of the global object (§5 Global resolution): either to no declaration at all, or
 * to a declaration that binds the global object's property.
 */
export interface GlobalBinding extends Taint {
  declaration?: GlobalDeclaration
}

/** A name that resolves to a `const` declaration (§5 Resolver capabilities 1), with the taint between the two. */
export interface ConstantBinding extends Taint {
  /** The `const` declaration: a `VariableDeclaration` whose `kind` is `const`. */
  declaration: AstNode
}

/** How the program relates to the code around it, when it is nested code (§2) or holds some. */
export interface ScopeOptions {
  /** The arrow functions grafted in place of literal direct-eval code, whose code runs in its caller's scope. */
  directEvals?: ReadonlySet<AstNode>
  /** For global code: the names the host classic script declares with `let`, `const` or `class` at its top level. */
  lexicalGlobals?: ReadonlySet<string>
  /** Whether the program is eval code, whose top-level `var`s and functions stay its own when it is strict. */
  evalCode?: boolean
  /**
   * For a link group's program (§6 Link groups): the variable an import binding is, by the declaration the seam gives
   * the binding and its name. A reference to a linked import resolves to that variable.
   */
  imports?: (declaration: AstNode, name: string) => { declaration: AstNode; name: string } | undefined
}

export interface ScopeRules {
  /** What a reference resolves to after the post-passes: a property of the global object, or else a local binding. */
  resolve(id: AstNode): GlobalBinding | 'local'
  /**
   * The `const` declaration a reference resolves to after the post-passes, if it resolves to one, with the `with`
   * statements and the direct evals in sloppy functions between the reference and the declaration (post-pass 3).
   */
  constant(id: AstNode): ConstantBinding | undefined
  /**
   * The declaration a reference resolves to after the post-passes, as the seam gives it (§19), or none: a free name, a
   * name global code sees among the host's top-level lexical declarations, or a name an Annex B var binding hides.
   */
  declaration(id: AstNode): AstNode | undefined
  /**
   * The name of the variable a reference resolves to: its own, or for an import binding of a link group, the name the
   * variable it is has where it is declared (§6 Link groups).
   */
  nameOf(id: AstNode): string
  /** Whether the code at a UTF-16 offset is strict mode code. */
  isStrict(offset: number): boolean
  /**
   * For a `VariableDeclaration`, `FunctionDeclaration` or `ClassDeclaration`, how it declares the global object's
   * members (§3 Declarations in classic scripts), if it does: see `Declared`.
   */
  declared(node: AstNode): Declared | undefined
}

/**
 * How a declaration binds a name of the global object's (§3 Declarations in classic scripts), as ECMA-262's global and
 * eval declaration instantiation give it:
 * - `var`: a `var` whose binding is the global object's property, in a classic script or in eval code (direct or
 *   indirect) that declares its vars there
 * - `function`: a function declared at the top level of such code
 * - `block-function`: a block-level function that Annex B gives such a var binding (B.3.2.2, B.3.2.3)
 * - `let`, `const` and `class`: a lexical declaration at the top level of a classic script, which hides the global
 *   object's property from bare-name callers. Eval code's are its own.
 *
 * `configurable` is the `D` those steps pass: true for eval code, whose bindings can be deleted, and false for a
 * script. `loop` says a `var` is the head of a `for`-`in` or `for`-`of` loop, which assigns it each iteration.
 */
export interface Declared {
  kind: GlobalDeclarationKind
  configurable: boolean
  loop?: boolean
}

/**
 * A region of the program: the program or a function, each a var scope; a class, whose code is all strict; the body
 * of a `with` statement; or grafted direct-eval code (`eval`), a var scope for the names in it. Its code shares a var
 * scope and strictness with the region around it unless it is a var scope.
 */
interface Region {
  kind: 'program' | 'function' | 'class' | 'with' | 'eval'
  /** The node the region spans: for a `with` region, the statement's body. */
  node: AstNode
  /** For a `with` region, the `with` statement. */
  site?: AstNode
  start: number
  end: number
  parent: Region | null
  strict: boolean
  /** A function's parameter names. */
  params: Set<string>
  /** The block-level functions Annex B gives a var binding here, by name: the first one declared. */
  annexB: Map<string, AstNode>
  /** Calls `eval(…)` in sloppy code whose vars land in this var scope: direct evals, if `eval` is the global one. */
  evals: AstNode[]
}

export function scopeRules(
  program: AstNode,
  sourceType: 'script' | 'module',
  bindings: BindingResolver,
  options: ScopeOptions = {},
): ScopeRules {
  const { directEvals = new Set(), lexicalGlobals = new Set(), evalCode = false, imports } = options
  const resolution = bindings.resolve(program as unknown as OxcProgram, sourceType)
  const regions = collectRegions(program, sourceType, directEvals)
  let declarations: Map<AstNode, Declared> | undefined

  /**
   * Whether a region's top-level `var`s and functions bind the global object's properties: a classic script's, unless
   * it is strict eval code, and sloppy direct-eval code's whose caller's var scope does.
   */
  const bindsGlobals = (region: Region): boolean => {
    if (region.kind === 'eval') return !region.strict && bindsGlobals(varScopeAround(region))
    return region.kind === 'program' && sourceType === 'script' && !(evalCode && region.strict)
  }

  /**
   * Post-pass 2: an Annex B var binding in a function the reference sits in hides whatever the seam found outside it.
   * Returns the var scope with that binding, if there is one, or else the var scope the seam's declaration is in.
   */
  const varScopeOf = (id: AstNode, resolved: Resolution): { hoisted: AstNode; region: Region } | { scope?: Region } => {
    const name = id['name'] as string
    for (let region: Region | null = innermost(regions, id.start); region !== null; region = region.parent) {
      if (!isVarScope(region)) continue
      if (resolved !== 'unresolved' && declaredWithin(resolved, region)) return { scope: region }
      const hoisted = region.annexB.get(name)
      if (hoisted !== undefined) return { hoisted, region }
    }
    return {}
  }

  /** What a reference resolves to: a declaration that binds the global object's property, none at all, or a local. */
  const bind = (id: AstNode): GlobalDeclaration | undefined | 'local' => {
    const name = id['name'] as string
    const resolved = resolution.reference(id as unknown as IdentifierNode)
    const found = varScopeOf(id, resolved)
    if ('hoisted' in found) return bindsGlobals(found.region) ? { kind: 'block-function', node: found.hoisted } : 'local'
    const { scope } = found
    // Global code sees the host script's top-level lexical declarations before the global object's properties.
    if (resolved === 'unresolved') return lexicalGlobals.has(name) ? 'local' : undefined
    const declaration = resolved.declaration as unknown as AstNode
    const kind = declaration.type === 'FunctionDeclaration' ? 'function' : 'var'
    const varScoped = kind === 'function' || (declaration.type === 'VariableDeclaration' && declaration['kind'] === 'var')
    // A top-level var or function of direct-eval code is declared in the var scope that code's declarations go to.
    if (scope?.kind === 'eval' && resolved.scopeKind === 'function' && varScoped && declaration !== scope.node) {
      return bindsGlobals(scope) ? { kind, node: declaration } : 'local'
    }
    // Post-pass 1: a classic script's global-scope var and function bind the global object's property.
    if (resolved.scopeKind !== 'global' || !varScoped || !bindsGlobals(regions[0]!)) return 'local'
    return { kind, node: declaration }
  }

  /**
   * Post-pass 3: the `with` blocks and the functions around a reference, out to the first region that holds `until`,
   * are on its resolution path. A `with` block could redirect the name to an object property, and a direct eval in one
   * of those functions, in sloppy code, could declare a `var` there that shadows it.
   */
  const taintOf = (id: AstNode, until?: AstNode): Taint => {
    const withs: AstNode[] = []
    const evals: AstNode[] = []
    for (let region: Region | null = innermost(regions, id.start); region !== null; region = region.parent) {
      if (until !== undefined && region.start <= until.start && until.end <= region.end) break
      if (region.kind === 'with') withs.unshift(region.site!)
      if (region.kind === 'function') evals.push(...region.evals.filter((call) => bind(call['callee'] as AstNode) !== 'local'))
    }
    evals.sort((a, b) => a.start - b.start)
    return { withs, evals }
  }

  /** The variable an import binding of a link group is, when `id` reads one (`ScopeOptions.imports`). */
  const linked = (id: AstNode, resolved: Resolution): { declaration: AstNode; name: string } | undefined => {
    if (imports === undefined || resolved === 'unresolved') return undefined
    return imports(resolved.declaration as unknown as AstNode, id['name'] as string)
  }

  return {
    resolve(id) {
      const declaration = bind(id)
      if (declaration === 'local') return 'local'
      // A name bound on the global object has the whole scope chain on its path. At the top of a classic script, a var
      // a direct eval declares is the global object's property itself.
      return { ...(declaration === undefined ? {} : { declaration }), ...taintOf(id) }
    },
    constant(id) {
      const resolved = resolution.reference(id as unknown as IdentifierNode)
      if (resolved === 'unresolved') return undefined
      const import_ = linked(id, resolved)
      const declaration = import_?.declaration ?? (resolved.declaration as unknown as AstNode)
      if (declaration.type !== 'VariableDeclaration' || declaration['kind'] !== 'const') return undefined
      // An import's variable is in another module: nothing between the two can shadow it.
      if (import_ !== undefined) return { declaration, withs: [], evals: [] }
      if ('hoisted' in varScopeOf(id, resolved)) return undefined
      // A constant's path ends at the region it is declared in. A direct eval in the constant's own var scope can't
      // shadow it: its `var` would clash with the `const`, a SyntaxError.
      return { declaration, ...taintOf(id, declaration) }
    },
    declaration(id) {
      const resolved = resolution.reference(id as unknown as IdentifierNode)
      if (resolved === 'unresolved' || 'hoisted' in varScopeOf(id, resolved)) return undefined
      return linked(id, resolved)?.declaration ?? (resolved.declaration as unknown as AstNode)
    },
    nameOf(id) {
      if (imports === undefined) return id['name'] as string
      const resolved = resolution.reference(id as unknown as IdentifierNode)
      return linked(id, resolved)?.name ?? (id['name'] as string)
    },
    isStrict: (offset) => innermost(regions, offset).strict,
    declared: (node) => (declarations ??= globalDeclarations()).get(node),
  }

  /** The declarations that bind names of the global object's, by node (`declared`). */
  function globalDeclarations(): Map<AstNode, Declared> {
    const found = new Map<AstNode, Declared>()
    const regionOf = new Map(regions.map((region) => [region.node, region]))
    // The var scopes the walk is in: the program, and the direct-eval code grafted in it. It never enters a function.
    const scopes: Region[] = []
    const lexical = sourceType === 'script' && !evalCode
    const configurableIn = (region: Region) => region.kind === 'eval' || evalCode
    walkTree(program, {
      enter(node, parent) {
        const region = regionOf.get(node)
        const opens = region !== undefined && (region.kind === 'program' || region.kind === 'eval')
        if (!opens && (functionTypes.has(node.type) || node.type === 'StaticBlock' || node.type === 'ClassExpression')) {
          if (node.type === 'FunctionDeclaration') functionDeclaration(node, parent)
          return false
        }
        if (node.type === 'ClassDeclaration') {
          if (lexical && parent === program) found.set(node, { kind: 'class', configurable: false })
          return false
        }
        if (opens) scopes.push(region)
        if (node.type === 'VariableDeclaration') {
          const scope = scopes.at(-1)!
          if (node['kind'] === 'var') {
            const loop =
              (parent?.type === 'ForInStatement' || parent?.type === 'ForOfStatement') && parent['left'] === node
            if (bindsGlobals(scope)) found.set(node, { kind: 'var', configurable: configurableIn(scope), ...(loop ? { loop } : {}) })
          } else if (lexical && parent === program && (node['kind'] === 'let' || node['kind'] === 'const')) {
            found.set(node, { kind: node['kind'], configurable: false })
          }
        }
      },
      leave(node) {
        if (scopes.at(-1)?.node === node) scopes.pop()
      },
    })
    return found

    /** A function declaration: at the top level of the var scope, or a block-level one Annex B hoists there. */
    function functionDeclaration(node: AstNode, parent: AstNode | null) {
      const scope = scopes.at(-1)!
      const name = (node['id'] as AstNode | null)?.['name'] as string | undefined
      if (name === undefined || !bindsGlobals(scope)) return
      // The top level of eval code is the body of the arrow function grafted in place of its literal.
      const topLevel = scope.kind === 'eval' ? parent === (scope.node['body'] as AstNode) : parent === program
      if (topLevel) found.set(node, { kind: 'function', configurable: configurableIn(scope) })
      else if (scope.annexB.get(name) === node) found.set(node, { kind: 'block-function', configurable: configurableIn(scope) })
    }
  }
}

/**
 * The names a classic script declares lexically at its top level (`let`, `const`, `using`, `class`). They are global
 * bindings that are not properties of the global object, and global code sees them. A module's are its own.
 */
export function globalLexicalNames(program: AstNode, sourceType: 'script' | 'module'): ReadonlySet<string> {
  return sourceType === 'module' ? new Set() : lexicallyDeclared(program['body'] as AstNode[], true)
}

interface LexicalGlobal {
  name: string
  kind: 'let' | 'const' | 'class'
  id: AstNode
}

/**
 * A classic script's top-level `let`, `const` and `class` declarations, in document order, each with the identifier it
 * binds: the names the scan-wide lexical-name check collects (§3 Declarations in classic scripts). A module's are its
 * own, so it has none.
 */
export function globalLexicalDeclarations(
  program: AstNode,
  sourceType: 'script' | 'module',
): LexicalGlobal[] {
  if (sourceType === 'module') return []
  return (program['body'] as AstNode[]).flatMap((statement): LexicalGlobal[] => {
    if (statement.type === 'ClassDeclaration') {
      const id = statement['id'] as AstNode | null
      return id === null ? [] : [{ name: id['name'] as string, kind: 'class', id }]
    }
    if (statement.type !== 'VariableDeclaration') return []
    const kind = statement['kind']
    if (kind !== 'let' && kind !== 'const') return []
    return (statement['declarations'] as AstNode[]).flatMap((declarator) =>
      boundIdentifiers(declarator['id'] as AstNode).map((id) => ({ name: id['name'] as string, kind, id })),
    )
  })
}

/** Whether a region is a var scope for the names in it: the program, a function, or grafted direct-eval code. */
const isVarScope = (region: Region): boolean => region.kind === 'program' || region.kind === 'function' || region.kind === 'eval'

/**
 * Whether a region is the var scope its code's `var`s and direct evals go to: sloppy direct-eval code declares them
 * in its caller's var scope (ECMA-262 EvalDeclarationInstantiation), and strict eval code in its own.
 */
const declaresVars = (region: Region): boolean => isVarScope(region) && !(region.kind === 'eval' && !region.strict)

/** The var scope that code in `region`, but outside any var scope in it, declares its `var`s in. */
function varScopeAround(region: Region): Region {
  let around = region.parent!
  while (!declaresVars(around)) around = around.parent!
  return around
}

/**
 * Whether the seam's declaration lies in `region`'s var scope or a scope inside it. A function's parameters and its
 * `arguments` are declared by the function node in its own `function` scope; its name is declared outside it.
 */
function declaredWithin(resolved: Exclude<Resolution, 'unresolved'>, region: Region): boolean {
  const declaration = resolved.declaration as unknown as AstNode
  if (declaration === region.node) return resolved.scopeKind === 'function'
  return region.start <= declaration.start && declaration.end <= region.end
}

/** The innermost region that contains `offset`. Regions are in document order, each after the regions around it. */
function innermost(regions: readonly Region[], offset: number): Region {
  let low = 0
  let high = regions.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (regions[middle]!.start <= offset) low = middle
    else high = middle - 1
  }
  let region: Region | null = regions[low]!
  while (region !== null && !(region.start <= offset && offset < region.end)) region = region.parent
  return region ?? regions[0]!
}

const functionTypes = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/**
 * Walks the program once, and returns its regions in document order, with their strictness, parameters and Annex B
 * bindings.
 */
function collectRegions(
  program: AstNode,
  sourceType: 'script' | 'module',
  directEvals: ReadonlySet<AstNode>,
): Region[] {
  const regions: Region[] = []
  const open: Region[] = []
  // The names each enclosing block-like scope declares lexically, with the node that opened it. A function or the
  // program opens a var scope's entry: the names at its top level.
  const lexical: { owner: AstNode; names: Set<string>; varScope: boolean }[] = []

  const openRegion = (
    kind: Region['kind'],
    node: AstNode,
    strict: boolean,
    params: Set<string> = new Set(),
    site?: AstNode,
  ) => {
    const region: Region = {
      kind,
      node,
      ...(site === undefined ? {} : { site }),
      start: node.start,
      end: node.end,
      parent: open.at(-1) ?? null,
      strict,
      params,
      annexB: new Map(),
      evals: [],
    }
    regions.push(region)
    open.push(region)
  }
  const strict = () => open.at(-1)!.strict

  walkTree(program, {
    enter(node, parent) {
      if (parent?.type === 'WithStatement' && parent['body'] === node) openRegion('with', node, strict(), new Set(), parent)
      if (node.type === 'Program') {
        const body = node['body'] as AstNode[]
        openRegion('program', node, sourceType === 'module' || hasUseStrict(body))
        lexical.push({ owner: node, names: lexicallyDeclared(body, true), varScope: true })
      } else if (functionTypes.has(node.type)) {
        const body = node['body'] as AstNode
        const statements = body.type === 'BlockStatement' ? (body['body'] as AstNode[]) : []
        const params = new Set((node['params'] as AstNode[]).flatMap(boundNames))
        openRegion(directEvals.has(node) ? 'eval' : 'function', node, strict() || hasUseStrict(statements), params)
        lexical.push({ owner: node, names: lexicallyDeclared(statements, true), varScope: true })
      } else if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
        openRegion('class', node, true)
      } else if (node.type === 'BlockStatement' && !(parent !== null && functionTypes.has(parent.type))) {
        // A function's body is a BlockStatement too, but it belongs to the function's var scope.
        const statements = node['body'] as AstNode[]
        lexical.push({ owner: node, names: lexicallyDeclared(statements, false), varScope: false })
        hoistBlockFunctions(statements)
      } else if (node.type === 'SwitchStatement') {
        const statements = (node['cases'] as AstNode[]).flatMap((clause) => clause['consequent'] as AstNode[])
        lexical.push({ owner: node, names: lexicallyDeclared(statements, false), varScope: false })
        hoistBlockFunctions(statements)
      } else if (isEvalCall(node)) {
        if (!strict()) open.findLast(declaresVars)!.evals.push(node)
      } else {
        const names = lexicalHead(node)
        if (names.length > 0) lexical.push({ owner: node, names: new Set(names), varScope: false })
      }
    },
    leave(node) {
      if (open.at(-1)?.node === node) open.pop()
      if (lexical.at(-1)?.owner === node) lexical.pop()
    },
  })
  return regions

  /**
   * Annex B (B.3.2.1, B.3.2.2): in sloppy code, each plain function declared directly in a block or case clause gets a
   * var binding in its var scope, unless its name is a parameter, or declaring `var` of it there would clash with a
   * lexical declaration in an enclosing block or at the top of the var scope.
   */
  function hoistBlockFunctions(statements: readonly AstNode[]) {
    if (strict()) return
    const region = open.findLast(isVarScope)!
    for (const statement of statements) {
      if (statement.type !== 'FunctionDeclaration' || statement['async'] === true || statement['generator'] === true) {
        continue
      }
      const name = (statement['id'] as AstNode)['name'] as string
      if (region.params.has(name) || clashes(name)) continue
      if (!region.annexB.has(name)) region.annexB.set(name, statement)
    }
  }

  /** Whether an enclosing block, below the one just entered, or the var scope's top level declares `name` lexically. */
  function clashes(name: string): boolean {
    for (let i = lexical.length - 2; i >= 0; i--) {
      if (lexical[i]!.names.has(name)) return true
      if (lexical[i]!.varScope) return false
    }
    return false
  }
}

/**
 * The names a `for` head declares lexically, or a catch clause whose parameter is a pattern. A catch parameter that is
 * a plain identifier doesn't clash with a `var` of its name in the clause (B.3.4).
 */
function lexicalHead(node: AstNode): string[] {
  if (node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
    const head = (node.type === 'ForStatement' ? node['init'] : node['left']) as AstNode | null
    if (head?.type !== 'VariableDeclaration' || head['kind'] === 'var') return []
    return (head['declarations'] as AstNode[]).flatMap((declarator) => boundNames(declarator['id'] as AstNode))
  }
  if (node.type === 'CatchClause') {
    const param = node['param'] as AstNode | null
    return param === null || param.type === 'Identifier' ? [] : boundNames(param)
  }
  return []
}

/**
 * The names a statement list declares lexically: `let`, `const`, `using` and `class`, and in a block (not at the top of
 * a function or script, where they are var-scoped) function declarations.
 */
function lexicallyDeclared(statements: readonly AstNode[], topLevel: boolean): Set<string> {
  const names = new Set<string>()
  for (const statement of statements) {
    if (statement.type === 'VariableDeclaration' && statement['kind'] !== 'var') {
      for (const declarator of statement['declarations'] as AstNode[]) {
        for (const name of boundNames(declarator['id'] as AstNode)) names.add(name)
      }
    } else if (statement.type === 'ClassDeclaration' || (!topLevel && statement.type === 'FunctionDeclaration')) {
      const id = statement['id'] as AstNode | null
      if (id !== null) names.add(id['name'] as string)
    }
  }
  return names
}

/** The names a binding pattern binds. */
export function boundNames(pattern: AstNode): string[] {
  return boundIdentifiers(pattern).map((id) => id['name'] as string)
}

/** The identifiers a binding pattern binds, in document order. */
export function boundIdentifiers(pattern: AstNode): AstNode[] {
  switch (pattern.type) {
    case 'Identifier':
      return [pattern]
    case 'ObjectPattern':
      return (pattern['properties'] as AstNode[]).flatMap((property) =>
        boundIdentifiers((property.type === 'RestElement' ? property['argument'] : property['value']) as AstNode),
      )
    case 'ArrayPattern':
      return (pattern['elements'] as (AstNode | null)[]).flatMap((element) => (element === null ? [] : boundIdentifiers(element)))
    case 'AssignmentPattern':
      return boundIdentifiers(pattern['left'] as AstNode)
    case 'RestElement':
      return boundIdentifiers(pattern['argument'] as AstNode)
    default:
      return []
  }
}

/** Whether a directive prologue holds a Use Strict Directive: exactly `"use strict"` or `'use strict'`. */
function hasUseStrict(statements: readonly AstNode[]): boolean {
  for (const statement of statements) {
    if (typeof statement['directive'] !== 'string') return false
    if (statement['directive'] === 'use strict') return true
  }
  return false
}

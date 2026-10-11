// The binding-resolution seam (§19): it sits inside the JS resolver, between parsing and monkeypatchlist's own scope rules.
// An implementation answers one question, what an identifier reference resolves to, under standard ES2015+ scoping.
// monkeypatchlist's four post-passes (§5) run above it, so swapping implementations never touches them.

import { analyze, type Definition, type Reference, type Variable } from 'eslint-scope'
import {
  visitorKeys,
  type ArrowFunctionExpression,
  type CatchClause,
  type Class,
  type Function as FunctionNode,
  type IdentifierReference,
  type ImportDeclaration,
  type Program,
  type VariableDeclaration,
} from 'oxc-parser'

/** A program as `oxc-parser` returns it, parsed with the options §5 fixes. */
export type OxcProgram = Program

/** An identifier in a reference position: `fetch` in `fetch = w`, `window` in `window.fetch = w`. */
export type IdentifierNode = IdentifierReference

/**
 * The node that declares a name:
 * - a `var`, `let`, `const` or `using` declaration: its `VariableDeclaration`, whose `kind` says which
 * - a function's name: its `FunctionDeclaration` (declared in the enclosing scope) or `FunctionExpression` (declared in
 *   a `function-expression-name` scope)
 * - a parameter, or a function's implicit `arguments`: the function, declared in its `function` scope
 * - a class's name: its class
 * - a catch parameter: its `CatchClause`
 * - an import binding: its `ImportDeclaration`
 */
export type DeclarationNode =
  | VariableDeclaration
  | FunctionNode
  | ArrowFunctionExpression
  | Class
  | CatchClause
  | ImportDeclaration

/** The kind of scope a name is declared in, as ES2015+ scoping gives it. */
export const scopeKinds = [
  'global',
  'module',
  'function',
  'function-expression-name',
  'block',
  'switch',
  'for',
  'catch',
  'with',
  'class',
  'class-field-initializer',
  'class-static-block',
] as const
export type ScopeKind = (typeof scopeKinds)[number]

/** What a reference resolves to: a declaration and the kind of scope it is in, or no declaration at all. */
export type Resolution = { declaration: DeclarationNode; scopeKind: ScopeKind } | 'unresolved'

/**
 * The binding-resolution seam (§19). `resolve` scopes one program with its `sourceType`, and `reference` answers for
 * any identifier reference in it. It knows nothing of monkeypatchlist's rules: a classic script's global `var` is simply a
 * declaration in the `global` scope, and a block-level function is block-scoped (no Annex B).
 */
export interface BindingResolver {
  resolve(
    program: OxcProgram,
    sourceType: 'script' | 'module',
  ): {
    reference(id: IdentifierNode): Resolution
  }
}

/** `eslint-scope`, the implementation §5 names: `optimistic: true`, and `ecmaVersion` ≥ 2015 for block scoping. */
export const eslintScopeBindings: BindingResolver = {
  resolve(program, sourceType) {
    const manager = analyze(program as never, {
      ecmaVersion: 2025,
      sourceType,
      optimistic: true,
      childVisitorKeys: visitorKeys,
      fallback: 'iteration',
    })
    const references = new Map<unknown, Reference>()
    for (const scope of manager.scopes) {
      for (const reference of scope.references) references.set(reference.identifier, reference)
    }
    return {
      reference(id) {
        const reference = references.get(id)
        if (reference === undefined) throw new Error(`eslint-scope recorded no reference for \`${id.name}\` at ${id.start}`)
        const variable = reference.resolved
        if (variable === null) return 'unresolved'
        return { declaration: declarationOf(variable), scopeKind: variable.scope.type as ScopeKind }
      },
    }
  },
}

/** The node that declares a variable: its first definition's, or for `arguments`, the function's. */
function declarationOf(variable: Variable): DeclarationNode {
  const [definition] = variable.defs as (Definition | undefined)[]
  if (definition === undefined) return variable.scope.block as unknown as DeclarationNode
  switch (definition.type) {
    case 'Variable':
    case 'ImportBinding':
      return definition.parent as unknown as DeclarationNode
    case 'FunctionName':
    case 'ClassName':
    case 'Parameter':
    case 'CatchClause':
      return definition.node as unknown as DeclarationNode
    case 'ImplicitGlobalVariable':
      throw new Error(`eslint-scope resolved \`${variable.name}\` to an implicit global`)
  }
}

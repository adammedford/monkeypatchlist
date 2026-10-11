// `@typescript-eslint/scope-manager` behind the binding-resolution seam (§19), the verified drop-in for eslint-scope.
// Tests swap it in to show monkeypatchlist's post-passes run above the seam, and the corpus check swaps it in for the
// seam's conformance on the validation corpus (`--bindings typescript-eslint`). Build-time only; never published.

import { analyze, type Definition, type Reference, type Variable } from '@typescript-eslint/scope-manager'
import { visitorKeys } from 'oxc-parser'
import {
  scopeKinds,
  type BindingResolver,
  type DeclarationNode,
  type ScopeKind,
} from '../src/packages/analysis/binding.ts'

interface Node {
  type: string
  [key: string]: unknown
}

export const typescriptEslintBindings: BindingResolver = {
  resolve(program, sourceType) {
    addTypeScriptFields(program as unknown as Node)
    // `lib: []` leaves every global unresolved, as eslint-scope does.
    const manager = analyze(program as never, { sourceType, lib: [] })
    const references = new Map<unknown, Reference>()
    for (const scope of manager.scopes) {
      for (const reference of scope.references) references.set(reference.identifier, reference)
    }
    return {
      reference(id) {
        const reference = references.get(id)
        if (reference === undefined) throw new Error(`the scope manager recorded no reference for \`${id.name}\` at ${id.start}`)
        const variable = reference.resolved
        if (variable === null) return 'unresolved'
        return { declaration: declarationOf(variable), scopeKind: scopeKind(variable.scope.type) }
      },
    }
  },
}

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
    default:
      throw new Error(`the scope manager resolved \`${variable.name}\` to a ${definition.type} definition`)
  }
}

function scopeKind(type: string): ScopeKind {
  if (!(scopeKinds as readonly string[]).includes(type)) throw new Error(`a JavaScript program has no ${type} scope`)
  return type as ScopeKind
}

/**
 * The scope manager reads TS-ESTree fields that oxc's JavaScript AST leaves out: `decorators` on classes, class members
 * and parameters, and `implements` on classes. This fills them in empty, which changes no JavaScript semantics.
 */
function addTypeScriptFields(root: Node): void {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()!
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      node['decorators'] ??= []
      node['implements'] ??= []
    }
    if (node.type === 'MethodDefinition' || node.type === 'PropertyDefinition' || node.type === 'AccessorProperty') {
      node['decorators'] ??= []
    }
    if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression') {
      for (const param of node['params'] as Node[]) param['decorators'] ??= []
    }
    for (const key of visitorKeys[node.type] ?? []) {
      const child = node[key]
      for (const item of Array.isArray(child) ? child : [child]) {
        if (typeof item === 'object' && item !== null && typeof (item as Node).type === 'string') stack.push(item as Node)
      }
    }
  }
}

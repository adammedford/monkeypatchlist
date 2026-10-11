// The binding-resolution seam (§19): what an identifier reference resolves to under standard ES2015+ scoping, before
// monkeypatchlist's post-passes. Both implementations answer alike at the seam.

import { parseSync, visitorKeys, type IdentifierReference } from 'oxc-parser'
import { describe, expect, expectTypeOf, test } from 'vitest'
import {
  eslintScopeBindings,
  type BindingResolver,
  type DeclarationNode,
  type IdentifierNode,
  type OxcProgram,
  type ScopeKind,
} from '../src/packages/analysis/binding.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

test("the seam matches §19's BindingResolver", () => {
  expectTypeOf<BindingResolver>().toEqualTypeOf<{
    resolve(
      program: OxcProgram,
      sourceType: 'script' | 'module',
    ): {
      reference(id: IdentifierNode): { declaration: DeclarationNode; scopeKind: ScopeKind } | 'unresolved'
    }
  }>()
  expectTypeOf(eslintScopeBindings).toEqualTypeOf<BindingResolver>()
})

/** Resolves the `occurrence`th identifier named `name` in `code`, and describes the answer. */
function resolve(bindings: BindingResolver, code: string, name: string, sourceType: 'script' | 'module' = 'script', occurrence = 0) {
  const { program, errors } = parseSync('a.js', code, { lang: 'js', sourceType, range: true, preserveParens: false })
  expect(errors).toEqual([])
  const id = identifiers(program).filter((node) => node.name === name)[occurrence]!
  const resolved = bindings.resolve(program, sourceType).reference(id)
  if (resolved === 'unresolved') return resolved
  const { declaration, scopeKind } = resolved
  return { declaration: `${declaration.type}${'kind' in declaration ? `:${declaration.kind}` : ''}`, scopeKind }
}

function identifiers(root: object): IdentifierReference[] {
  const found: IdentifierReference[] = []
  const visit = (node: { type: string; [key: string]: unknown }) => {
    if (node.type === 'Identifier') found.push(node as unknown as IdentifierReference)
    for (const key of visitorKeys[node.type] ?? []) {
      for (const child of [node[key]].flat()) if (typeof child === 'object' && child !== null && 'type' in child) visit(child as never)
    }
  }
  visit(root as never)
  return found.sort((a, b) => a.start - b.start)
}

describe.each([
  ['eslint-scope', eslintScopeBindings],
  ['@typescript-eslint/scope-manager', typescriptEslintBindings],
])('%s behind the seam', (_, bindings) => {
  test('a name with no declaration is unresolved', () => {
    expect(resolve(bindings, 'fetch = w', 'fetch')).toBe('unresolved')
  })

  test("a top-level var is a declaration in the global scope in a script, and in the module's scope in a module", () => {
    expect(resolve(bindings, 'var fetch; fetch = w', 'fetch', 'script', 1)).toEqual({
      declaration: 'VariableDeclaration:var',
      scopeKind: 'global',
    })
    expect(resolve(bindings, 'var fetch; fetch = w', 'fetch', 'module', 1)).toEqual({
      declaration: 'VariableDeclaration:var',
      scopeKind: 'module',
    })
  })

  test('parameters, function names, catch parameters and implicit arguments name their declaring node', () => {
    expect(resolve(bindings, 'function f(fetch){ fetch = w }', 'fetch', 'script', 1)).toEqual({
      declaration: 'FunctionDeclaration',
      scopeKind: 'function',
    })
    expect(resolve(bindings, 'function fetch(){} fetch = w', 'fetch', 'script', 1)).toEqual({
      declaration: 'FunctionDeclaration',
      scopeKind: 'global',
    })
    expect(resolve(bindings, '(function fetch(){ fetch = w })', 'fetch', 'script', 1)).toEqual({
      declaration: 'FunctionExpression',
      scopeKind: 'function-expression-name',
    })
    expect(resolve(bindings, 'try {} catch (fetch) { fetch = w }', 'fetch', 'script', 1)).toEqual({
      declaration: 'CatchClause',
      scopeKind: 'catch',
    })
    expect(resolve(bindings, 'function f(){ arguments = w }', 'arguments')).toEqual({
      declaration: 'FunctionDeclaration',
      scopeKind: 'function',
    })
  })

  test('below the seam a block-level function is block-scoped: Annex B is a post-pass', () => {
    expect(resolve(bindings, 'function g(){ if (c) { function fetch(){} } fetch = w }', 'fetch', 'script', 1)).toBe('unresolved')
    expect(resolve(bindings, '{ function fetch(){} fetch = w }', 'fetch', 'script', 1)).toEqual({
      declaration: 'FunctionDeclaration',
      scopeKind: 'block',
    })
  })

  test('with and eval leave static resolution alone: their taint is a post-pass', () => {
    expect(resolve(bindings, 'var fetch; with (o) { fetch = w }', 'fetch', 'script', 1)).toEqual({
      declaration: 'VariableDeclaration:var',
      scopeKind: 'global',
    })
    expect(resolve(bindings, 'function f(fetch){ eval(s); fetch = w }', 'fetch', 'script', 1)).toEqual({
      declaration: 'FunctionDeclaration',
      scopeKind: 'function',
    })
  })
})

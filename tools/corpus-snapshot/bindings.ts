// The implementations the corpus check can put behind the binding-resolution seam (§19). The snapshot is always written
// with the shipped `eslint-scope`; checking it with `--bindings typescript-eslint` is the seam's conformance test: both
// implementations give identical findings on the validation corpus. Build-time only; never published.

import { createJsResolver } from '../../src/packages/analysis/binding.ts'
import type { Resolver } from '../../src/packages/analysis/index.ts'
import { typescriptEslintBindings } from '../typescript-eslint-bindings.ts'

export const bindingNames = ['eslint-scope', 'typescript-eslint'] as const
export type BindingName = (typeof bindingNames)[number]

/** How a message names each implementation: its npm package. */
export const bindingPackages: Record<BindingName, string> = {
  'eslint-scope': 'eslint-scope',
  'typescript-eslint': '@typescript-eslint/scope-manager',
}

export function isBindingName(name: string): name is BindingName {
  return (bindingNames as readonly string[]).includes(name)
}

/** The resolver a scan swaps in for `name`, or none for the shipped one. */
export function resolverFor(name: BindingName): Resolver | undefined {
  return name === 'eslint-scope' ? undefined : createJsResolver(typescriptEslintBindings)
}

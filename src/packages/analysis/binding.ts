// The binding-resolution seam (§19): it sits inside the JS resolver, between parsing and monkeypatchlist's own scope rules.
// `eslint-scope` is the implementation monkeypatchlist ships; `@typescript-eslint/scope-manager` is a verified drop-in.
// monkeypatchlist's four post-passes (§5) run above the seam, so swapping implementations never touches them.

export {
  eslintScopeBindings,
  scopeKinds,
  type BindingResolver,
  type DeclarationNode,
  type IdentifierNode,
  type OxcProgram,
  type Resolution,
  type ScopeKind,
} from './lib/binding.ts'
export { createJsResolver } from './lib/resolver.ts'

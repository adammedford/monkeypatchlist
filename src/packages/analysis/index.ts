// Analysis (§19, module 4): the resolver seam. It takes link groups, the catalog and a budget, and returns raw
// occurrences, ineffective writes, limitations and discovered references. Everything that crosses it is plain
// JSON-serializable data, so that a native analyzer (§18) can replace this module and nothing else.

export {
  codeCallees,
  effects,
  guardClasses,
  globalForms,
  ineffectiveReasons,
  installContexts,
  limitationKinds,
  mechanisms,
  reachabilities,
  throwsValues,
  traceStepKinds,
  type AliasStep,
  type AnalyzeGroupInput,
  type AnalyzeGroupOutput,
  type ArtifactRef,
  type ArtifactSource,
  type BindingStep,
  type CallStep,
  type CodeCallee,
  type ConfidenceReasonStep,
  type CreationSiteStep,
  type DiscoveredReference,
  type Effect,
  type FoldStep,
  type GeneratedLocation,
  type GuardClass,
  type GuardStep,
  type GlobalDeclarationKind,
  type GlobalForm,
  type IneffectiveReason,
  type IneffectiveWrite,
  type LexicalCollisionStep,
  type LexicalDeclaration,
  type Limitation,
  type LimitationKind,
  type InstallContext,
  type Locks,
  type Lookup,
  type Mechanism,
  type ModuleLinking,
  type ModuleLinkStep,
  type NestedCodeStep,
  type RestoreStep,
  type RewrittenDeleteStep,
  type OutcomeStep,
  type RawOccurrence,
  type Reachability,
  type ReachabilityBasis,
  type RealmInstance,
  type Resolver,
  type Strictness,
  type Target,
  type TraceStep,
  type TraceStepKind,
  type Throws,
} from './lib/types.ts'
export { defaultBudget, type Budget, type Caps } from './lib/budget.ts'
export { chunkRegistries } from './lib/chunk-registry.ts'
export { lexicalCollisions, type RealmDeclaration, type RealmOccurrence } from './lib/collisions.ts'
import type { Resolver } from './lib/types.ts'
import { createJsResolver } from './lib/resolver.ts'

/**
 * The JavaScript resolver: `oxc-parser` with an explicit `sourceType`, `eslint-scope` behind the binding-resolution
 * seam, and monkeypatchlist's scope post-passes above it (§5). `binding.ts` builds one with another binding resolver.
 */
export const jsResolver: Resolver = createJsResolver()

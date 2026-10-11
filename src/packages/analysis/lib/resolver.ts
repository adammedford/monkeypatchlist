import type { Realm, SerializedCatalog } from '../../../catalog.ts'
import {
  mutationConfidence,
  mutationReasons,
  targetConfidence,
  targetReasons,
  type MutationReason,
  type TargetReason,
} from '../../confidence/index.ts'
import { absenceTags } from './absence-tags.ts'
import { calleeExpression, isEvalCall, walkTree, type AstNode } from './ast.ts'
import { eslintScopeBindings, type BindingResolver } from './binding.ts'
import { Folder } from './chunk-loads.ts'
import { scriptLoads, scriptTexts as injectedTexts } from './script-loads.ts'
import { codeRoutes, isGlobalCompiler, templateStrings, type CodeRoutes, type IndirectCall } from './code-routes.ts'
import { bindsOwn, definitionsOf, type VariableKey } from './definitions.ts'
import {
  candidateTargets,
  descriptorFieldsOf,
  isIneffective,
  outcomesOf,
  prefixMembers,
  wildcardOutcome,
  narrowedMatches,
  type Ineffective,
  type Mutation,
} from './effect.ts'
import {
  globalResolution,
  inDocumentOrder,
  instanceOf,
  mergedFolds,
  onePerNode,
  opaque,
  recordable,
  type CapHit,
  type Decision,
  type Fold,
  type GlobalResolution,
  type Guards,
  type HolderValue,
  type Leaf,
  type OwnTest,
  type Sweep,
  type WalkChoice,
  type Position,
  type Value,
  globalHolder,
} from './global-object.ts'
import { memberName, patternName, symbolMember, toPropertyKey } from './keys.ts'
import { moduleLinks, type BrokenLink, type ModuleLink, type ModuleLinks } from './module-links.ts'
import { GroupLines, locate, type LinesMember, type Starts } from './line-starts.ts'
import { linkGroup, type LinkGroup } from './link-group.ts'
import { isCodeLiteral, nestedCode, type Graft, type NestedCode } from './nested-code.ts'
import { parse } from './parse.ts'
import { printed } from './print.ts'
import {
  along,
  argumentGuards,
  chainJudge,
  entryName,
  functionPath,
  ruledOutTests,
  sweepFilters,
  sweepTests,
  unreachedArms,
} from './reachability.ts'
import { boundNames, globalLexicalDeclarations, globalLexicalNames, scopeRules, type ScopeRules, type Taint } from './scope.ts'
import { callGraph, cutIn, isFunction, isLoop, type Binding, type CallGraph, type CallSite, type Frame } from './summaries.ts'
import { patchShapes, slotSignatures, type Shapes, type Slots } from './partial.ts'
import { alwaysRewritten } from './rewritten-deletes.ts'
import { restoreJudge, sameChain, type Restore } from './restores.ts'
import { wrapEvidence } from './wrap.ts'
import {
  candidateName,
  sitesAt,
  type OpenWrite,
  type Sites,
  type Source,
  type WideSite,
  type WildWrite,
  type Write,
} from './writes.ts'
import type { Caps } from './budget.ts'
import {
  codeCallees,
  type AliasStep,
  type AnalyzeGroupInput,
  type AnalyzeGroupOutput,
  type ArtifactSource,
  type BindingStep,
  type CallStep,
  type CatalogHolderStep,
  type CodeCallee,
  type ConfidenceReasonStep,
  type CreationSiteStep,
  type EnumerationStep,
  type Effect,
  type FoldStep,
  type GeneratedLocation,
  type GlobalDeclarationKind,
  type GlobalForm,
  type GuardStep,
  type IneffectiveWrite,
  type Mechanism,
  type ModuleLinkStep,
  type NestedCodeStep,
  type OutcomeStep,
  type PruneStep,
  type RawOccurrence,
  type RealmInstance,
  type Resolver,
  type RestoreStep,
  type RewrittenDeleteStep,
  type TraceStep,
} from './types.ts'

/**
 * The resolver's version, recorded as `tool.analyzerVersion` (§19, ADR 0018). Bump it whenever a change to this
 * resolver can change what it returns for the same bytes and catalog.
 */
const analyzerVersion = 'js-98'

/**
 * The JS resolver, with `bindings` behind the binding-resolution seam (§19). `eslint-scope` is the implementation
 * monkeypatchlist ships.
 */
export function createJsResolver(bindings: BindingResolver = eslintScopeBindings, visit?: VisitOrder): Resolver {
  return { analyzerVersion, analyzeGroup: (input) => analyzeGroup(input, bindings, visit) }
}

/**
 * An order to visit a list the resolver works through in: the calls of a function, and the calls of a program. The
 * resolver visits them in document order; results never depend on it (§18 Context policy), which a permutation test
 * shows by passing a shuffle here. It is called once per list, and must return the same items.
 */
export type VisitOrder = <T>(items: readonly T[]) => readonly T[]

/** The call graph with its lists visited in `visit`'s order, each list permuted once. */
function visited(graph: CallGraph, visit: VisitOrder | undefined): CallGraph {
  if (visit === undefined) return graph
  const callsOf = new Map<AstNode, readonly CallSite[]>()
  let all: readonly AstNode[] | undefined
  return {
    ...graph,
    callsOf(fn) {
      let found = callsOf.get(fn)
      if (found === undefined) callsOf.set(fn, (found = visit(graph.callsOf(fn))))
      return found
    },
    allCalls: () => (all ??= visit(graph.allCalls())),
  }
}

/**
 * Analyzes one link group (§6, §19): the entry and every artifact its imports reach, joined into one program
 * (`linkGroup`), with one heap and one realm, the entry's.
 */
function analyzeGroup(input: AnalyzeGroupInput, bindings: BindingResolver, visit: VisitOrder | undefined): AnalyzeGroupOutput {
  const { entry, artifact, catalog, budget } = input
  const output: AnalyzeGroupOutput = {
    members: [
      { url: entry.url, hash: entry.hash, sourceType: entry.sourceType, realm: entry.realm, realmBasis: entry.realmBasis },
    ],
    occurrences: [],
    ineffectiveWrites: [],
    limitations: [],
    references: [],
    moduleLinking: {},
    stats: { steps: 0, budget: 0, exhausted: false, caps: {} },
  }
  const entrySource = artifact(entry.url)
  if (entrySource === undefined) throw new Error(`the resolver was given no source for its group entry ${entry.url}`)
  // The resolver analyzes the entry as its group's entry: in the group's realm, as the group's reference runs it.
  const source: ArtifactSource = { ...entrySource, sourceType: entry.sourceType, realm: entry.realm, realmBasis: entry.realmBasis }
  // The group's step budget scales with the source bytes of its members, and depends on nothing else (§18).
  let bytes = Buffer.byteLength(source.text)
  output.stats.budget = Math.floor(bytes * budget.stepsPerByte)

  const { group, failures, pulled } = linkGroup(source, input)
  for (const failure of failures) {
    // A partially recovered AST is never used (§13).
    const { url, hash } = failure.source
    output.limitations.push({ kind: 'parse-failure', artifact: { url, hash }, detail: failure.error })
  }
  // A group whose entry's module graph fails gives nothing, but every module it pulled in is its member.
  output.members = (group?.members ?? pulled).map(({ url, hash, sourceType }) => ({
    url,
    hash,
    sourceType,
    realm: entry.realm,
    realmBasis: entry.realmBasis,
  }))
  if (group === undefined) return output
  bytes = group.members.reduce((sum, member) => sum + Buffer.byteLength(member.text), 0)
  const steps = Math.floor(bytes * budget.stepsPerByte)
  output.stats.budget = steps

  // The scripts each member's code loads that only the resolver can see (§19 References only the resolver can see), in
  // member order: the chunk URLs its loaders build, the scripts it injects and its worker URLs that aren't literals.
  for (const member of group.members) {
    const loads = scriptLoads(member.text, member.sourceType, bindings, member.url)
    const artifact = member.url
    for (const { load, location, urls, prefix, integrity } of loads.chunks) {
      for (const url of urls) {
        const sri = integrity?.[url]
        output.references.push({ url, kind: 'chunk', artifact, location, load, ...(sri === undefined ? {} : { integrity: sri }) })
      }
      if (prefix !== undefined) output.references.push({ url: prefix, kind: 'chunk', artifact, location, load, partial: true })
    }
    for (const { location, urls, unknown, types, integrity, noModule } of loads.injected) {
      const carried = {
        ...(integrity.length === 0 ? {} : { integrityAlternatives: integrity }),
        ...(noModule === 'no' ? {} : { noModule }),
      }
      for (const url of urls) {
        for (const type of types) {
          output.references.push({ url, kind: 'injected', artifact, location, ...(type === undefined ? {} : { type }), ...carried })
        }
      }
      // An unknown alternative carries each `type`, since an element of a type a browser doesn't run loads nothing.
      for (const alternative of unknown) {
        for (const type of types) {
          output.references.push({
            url: '',
            kind: 'injected',
            artifact,
            location,
            partial: true,
            alternative,
            ...(type === undefined ? {} : { type }),
            ...(noModule === 'no' ? {} : { noModule }),
          })
        }
      }
    }
    for (const { location, urls, unknown } of loads.workers) {
      for (const url of urls) output.references.push({ url, kind: 'worker', artifact, location })
      for (const alternative of unknown) output.references.push({ url: '', kind: 'worker', artifact, location, partial: true, alternative })
      // A URL with no value at all throws before any worker starts (`new URL("x.js")`), which gives nothing (Principle 1):
      // the site is still recorded, so that discovery knows it was folded.
      if (urls.length === 0 && unknown.length === 0) output.references.push({ url: '', kind: 'worker', artifact, location, none: true })
    }
  }

  const { program } = group
  const nested = nestedCode(group.text)
  const grafts = new Map<AstNode, Graft>()
  if (evalName.test(group.text)) nested.graftDirectEvals(program, grafts)

  const global = globalHolder(catalog, source.realm)
  const starts = group.lines
  // The scan-wide lexical-name check (§3) needs every classic script's top-level lexical names, whatever the budget.
  const declared = globalLexicalDeclarations(program, source.sourceType)
  if (declared.length > 0) {
    output.lexicalDeclarations = declared.map(({ name, kind, id }) => ({
      artifact: source.url,
      name,
      kind,
      generated: locate(starts, id.start, id.end),
    }))
  }
  const analysis: Analysis = {
    source,
    text: group.text,
    group,
    catalog,
    targets: catalog.targets[source.realm],
    global,
    starts,
    bindings,
    visit,
    nested,
    lexicalGlobals: globalLexicalNames(program, source.sourceType),
    output,
    caps: budget.caps,
    steps: 0,
    budget: steps,
    foldsTooLong: new Set(),
    callsCut: new Set(),
    holdersUnresolved: new Set(),
    loopsCut: new Set(),
    descriptorsCut: new Map(),
    candidatesCut: new Map(),
    capsHit: new Map(),
    requireLinks: new Map(),
  }
  try {
    analyzeCode(analysis, {
      program,
      sourceType: source.sourceType,
      grafts,
      globalCode: false,
      evalCode: false,
      around: realmOf(entry),
      instance: 'current',
    })
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error
    // The writes whose resolution finished inside the budget, in walk order, are the ones reported, each as the
    // unbudgeted run reports it: the analysis stopped inside the next one, which is dropped with everything after it
    // (§18). Each member of the group is named.
    output.stats.exhausted = true
    for (const member of output.members) {
      output.limitations.push({
        kind: 'analysis-budget',
        artifact: { url: member.url, hash: member.hash },
        detail:
          `the link group's step budget of ${steps} steps, ${budget.stepsPerByte} per source byte of its ${bytes} ` +
          'bytes, ran out, so the writes after the last one it finished are not analyzed',
      })
    }
  }
  // A record located in the group's text names the member its location is in.
  for (const limitation of output.limitations) {
    const member = limitation.location === undefined ? undefined : starts.artifactOf(limitation.location)
    if (member !== undefined) limitation.artifact = { url: member.url, hash: member.hash }
  }
  output.stats.steps = analysis.steps
  return output
}

/**
 * A member's module-linking idioms (§6), as its own code uses them. A member whose code doesn't parse is in no group's
 * program, so this is never asked of one.
 */
function memberLinks(member: ArtifactSource, bindings: BindingResolver): ModuleLinks {
  const parsed = parse(member.text, member.sourceType)
  if ('error' in parsed) throw new Error(`a link group's member ${member.url} doesn't parse`)
  const scope = scopeRules(parsed.program, member.sourceType, bindings)
  return moduleLinks(parsed.program, definitionsOf(parsed.program, scope))
}

/**
 * A trace whose steps each name the artifact their location is in, when that isn't the occurrence's own: a step in
 * another member of the link group (§6, §14).
 */
function elsewhere(trace: TraceStep[], artifact: string, starts: GroupLines): TraceStep[] {
  return trace.map((step) => {
    if (step.kind === 'module-link' || !('generated' in step)) return step
    const at = starts.artifactOf(step.generated as GeneratedLocation)
    return at === undefined || at.url === artifact ? step : { ...step, artifact: at.url }
  })
}

/** Thrown when a link group's step budget runs out, wherever the analysis is: it abandons the group's analysis. */
class BudgetExhausted extends Error {}

/**
 * Counts one step of the group's step budget (§18): each node below a program's root the walk enters, and each value
 * evaluated. Once the budget is spent, it throws `BudgetExhausted` instead. Steps count work, never time, so where the
 * budget runs out depends only on the group's bytes.
 */
function step(analysis: Analysis): void {
  if (analysis.steps >= analysis.budget) throw new BudgetExhausted('the step budget ran out')
  analysis.steps++
}

/** The name `eval`, spelt out or with Unicode escapes, as a direct eval's callee must be written. */
const evalName = /(?:e|\\u(?:0065|\{0*65\}))(?:v|\\u(?:0076|\{0*76\}))(?:a|\\u(?:0061|\{0*61\}))(?:l|\\u(?:006[cC]|\{0*6[cC]\}))/

/** What the analysis of one artifact shares between its host code and the code nested in it. */
interface Analysis {
  /** The group's entry. */
  source: ArtifactSource
  /** The group's text, which its program's offsets index. */
  text: string
  group: LinkGroup
  catalog: SerializedCatalog
  targets: SerializedCatalog['targets'][Realm]
  /** The realm's global holder, e.g. `Window`. */
  global: string
  /** The group's line-start tables. Nested code is located in its host. */
  starts: GroupLines
  bindings: BindingResolver
  /** The order the resolver visits its call lists in (`VisitOrder`): document order when undefined. */
  visit: VisitOrder | undefined
  nested: NestedCode
  /** The names the host classic script declares lexically at its top level, which global code sees. */
  lexicalGlobals: ReadonlySet<string>
  output: AnalyzeGroupOutput
  /** The caps (§18). */
  caps: Caps
  /** The steps taken so far, and the group's step budget (§18). */
  steps: number
  budget: number
  /** The folds that passed the `fold-length` cap, each with its `analysis-budget` limitation. */
  foldsTooLong: Set<AstNode>
  /** The calls a recursion or context cap widened or merged while they carry a native, each with its limitation. */
  callsCut: Set<AstNode>
  /** The write sites given an `unresolved-holder` limitation. */
  holdersUnresolved: Set<AstNode>
  /** The loops the iteration cap cut while they write a native, each with its limitation. */
  loopsCut: Set<AstNode>
  /** The descriptors the descriptor-alternatives cap cut, each with whether it has its limitation. */
  descriptorsCut: Map<AstNode, boolean>
  /** The nodes whose candidate sites the candidate-runs cap cut, each with whether it has its limitation. */
  candidatesCut: Map<AstNode, boolean>
  /** The nodes each cap counted outside the value evaluation's own counting (`capHit`), by cap. */
  capsHit: Map<keyof Caps, Set<AstNode>>
  /** The require calls that link a module (§6), in the host program and the code nested in it. */
  requireLinks: Map<AstNode, ModuleLink>
}

/** Code to analyze: the host's program, or a program of nested global code (§2), with its direct-eval grafts. */
interface Code {
  program: AstNode
  sourceType: 'script' | 'module'
  grafts: ReadonlyMap<AstNode, Graft>
  /** Whether the program is nested global code, which sees the host script's top-level lexical declarations. */
  globalCode: boolean
  /** Whether the program is eval code. */
  evalCode: boolean
  /**
   * What every write in the program carries before its own steps: the assumed realm of the group (`realmOf`), and the
   * nested code the program is in, if any.
   */
  around: Nesting
  /**
   * The window whose global object the program's free names are properties of: the artifact's own, or the window whose
   * `eval`, `Function` or timer compiled it (§4 Other windows).
   */
  instance: RealmInstance
  /**
   * For nested code, whether it runs only later (§7 Install context): compiled where only a later call reaches, or by a
   * timer. Every write in it is then `deferred`, waiting on that install entry. It is judged once, and only when a write
   * in the code needs it, so nested code with no writes costs no steps.
   */
  deferral?: () => Deferral | undefined
}

/** The install entry nested code waits on (§7 Install context): its name, or null when it has none (a timer's code). */
interface Deferral {
  entry: string | null
}

/** The trace steps and target-confidence reasons that nested code adds to every write in it, outermost first. */
interface Nesting {
  steps: TraceStep[]
  reasons: TargetReason[]
  /**
   * For nested code, the code literals of the outermost call that compiles it, which are in the host artifact's own
   * code. A write in nested code is looked up at the start of the one it is in (§10 Nested code).
   */
  literals?: readonly AstNode[]
}
const none: Nesting = { steps: [], reasons: [] }

/** Walks one program, reporting the writes in it and in the code nested in it. */
function analyzeCode(analysis: Analysis, code: Code): void {
  const { source, catalog, global, starts, bindings, output } = analysis
  const { program, sourceType, grafts } = code
  const { group } = analysis
  // The group's own program, whose imports are bindings of the variables they name (§6 Link groups).
  const host = program === group.program
  const scope = scopeRules(program, sourceType, bindings, {
    directEvals: new Set(grafts.keys()),
    ...(code.globalCode ? { lexicalGlobals: analysis.lexicalGlobals } : {}),
    evalCode: code.evalCode,
    ...(host ? { imports: group.bound } : {}),
  })
  const { instance } = code
  const { caps } = output.stats
  // Every cap hit is counted (§18). A `fold-length` hit raises `analysis-budget` only when a write's key, holder or
  // descriptor passed it and the write reaches a native holder (Principle 5, §13): `budget`.
  const cap = (name: CapHit['name']) => {
    caps[name] = (caps[name] ?? 0) + 1
  }
  const budget = (folds: readonly AstNode[]) => {
    for (const fold of folds) foldTooLong(analysis, fold)
  }
  // The descriptor fields a holder supplies as a descriptor's prototype (§3 Undecidable outcomes).
  const descriptorFields = (holder: string) => descriptorFieldsOf(holder, catalog, source.realm)
  const definitions = definitionsOf(program, scope)
  // The call graph takes each call's `typeof` guards from the resolution, which takes its calls from the graph.
  let guardsOf: GlobalResolution['guards'] = () => new Map()
  const calls = visited(
    callGraph(program, scope, definitions, (parent, child) => guardsOf(parent, child)),
    analysis.visit,
  )
  // The module-linking idioms (§6). Only the host program's are the artifacts' summaries: each member's own, with the
  // imports of its code that name no member of the group.
  const links = moduleLinks(program, definitions)
  for (const [call, link] of links.links) analysis.requireLinks.set(call, link)
  if (host) {
    for (const member of group.members) {
      const own = group.members.length === 1 ? links : memberLinks(member, bindings)
      // A require call in the member's code links through its group's tables, which chunks a loader links add to
      // (§6 idiom 6): what the member's code alone can't link may link in its group.
      const inMember = (node: AstNode) => starts.artifactOf(locate(starts, node.start, node.end))?.url === member.url
      const idioms = new Set(own.idioms)
      const linked = [...links.factories].some(([fn, { require, module }]) => inMember(fn) && links.firsts.get(require)?.has(module))
      if (linked || [...links.links.keys()].some(inMember)) idioms.add('factory-table')
      if (own.pushed > 0) idioms.add('factory-table')
      output.moduleLinking[member.url] = {
        idioms: [...idioms].sort(),
        modules: own.modules + own.pushed,
        unlinked: links.broken.filter((broken) => inMember(broken.call)).length + (group.unlinked.get(member.url) ?? 0),
        linkGroups: 1,
      }
    }
  }
  const resolution = globalResolution({
    links,
    program,
    catalog,
    realm: source.realm,
    global,
    sourceType,
    scope,
    definitions,
    instance,
    cap,
    capHit: (name, node) => capHit(analysis, name, node),
    calls,
    budget: (site, why) => callCut(analysis, site, why),
    caps: analysis.caps,
    step: () => step(analysis),
  })
  guardsOf = resolution.guards
  resolution.prepare()
  const routes = codeRoutes({ catalog, realm: source.realm, global, program, scope, resolution })
  const context: SiteContext = {
    analysis,
    scope,
    resolution,
    routes,
    grafts,
    instance,
    deferralAt: (node, timer) => deferralAt(node, timer),
  }

  // What is known where the walk is: the names `typeof` guards around it show are defined, and whether `this` there is
  // the script's top-level `this`. Each frame is the node that opened it.
  const frames: { node: AstNode; guards: Guards; boundary: boolean }[] = []
  const guards = new Map<string, AstNode[]>()
  let boundaries = 0
  const at: Position = {
    guard: (name) => guards.get(name)?.at(-1),
    get topLevel() {
      return boundaries === 0
    },
  }
  // The direct-eval code the walk is in, innermost last, each with the nesting it adds.
  const evals: { node: AstNode; nesting: Nesting }[] = []
  // The functions and loops the walk is in, innermost last.
  const contexts: AstNode[] = []
  // The nodes the walk is in, outermost first, for the guards on a write's path (§7).
  const ancestors: AstNode[] = []
  const guardContext = {
    resolution,
    scope,
    catalog,
    realm: source.realm,
    global,
    text: analysis.text,
    starts,
    parentOf: (node: AstNode) => resolution.parentOf(node),
    caps: analysis.caps,
    capHit: (name: 'testReads' | 'throwDepth', node: AstNode) => capHit(analysis, name, node),
  }
  // The factories lazy chunks push, each with the function its chunk runs in (§6 idiom 6).
  const chunkWrappers = new Map<AstNode, AstNode>()
  if (host && group.chunks.size > 0) {
    const chunks = [...group.wrappers].filter(([, member]) => group.chunks.has(member.url)).map(([wrapper]) => wrapper)
    for (const pushed of links.chunkFactories.values()) {
      for (const factory of [...pushed.values()].flat()) {
        const wrapper = chunks.find((each) => each.start <= factory.start && factory.end <= each.end)
        if (wrapper !== undefined) chunkWrappers.set(factory, wrapper)
      }
    }
  }
  // The chains out from the functions writes are in to their install entries (§7).
  const judgeChain = chainJudge({
    ...guardContext,
    callers: (fn) => resolution.callersOf(fn),
    // A chunk's pushed callback runs where it is pushed, called by the loader that reads the push (§6 idiom 6).
    runBy: (fn) => grafts.get(fn)?.call ?? links.pushCallbacks.get(fn),
    loadedBy: (fn) => analysis.group.loadedBy.get(fn),
    chunkOf: (fn) => chunkWrappers.get(fn),
  })
  /**
   * Whether code a call at `node` compiles runs only later (§7 Install context): when this program does, when only a
   * later call reaches the call, or when a timer runs the code. The outermost install entry is the one recorded.
   */
  const deferralAt = (node: AstNode, timer: boolean): (() => Deferral | undefined) => {
    // Only the chain's install entry is wanted, so the call is judged as a write of no target, on its own path.
    const path = ancestors.slice(0, ancestors.lastIndexOf(node) + 1)
    const position = { guard: at.guard, topLevel: at.topLevel }
    let judged: { deferral: Deferral | undefined } | undefined
    const judge = (): Deferral | undefined => {
      const outer = code.deferral?.()
      if (outer !== undefined) return outer
      const fn = calls.functionOf(node)
      const site = { site: node, target: { name: '' }, taints: [] }
      const chain = fn === undefined ? undefined : judgeChain(path, site, position, fn)
      return deferralOf(chain?.entry) ?? (timer ? { entry: null } : undefined)
    }
    return () => (judged ??= { deferral: judge() }).deferral
  }
  /**
   * The install entry a chain ends at, unless it reaches top-level code (§7 Install context). A direct eval runs its
   * grafted code where it stands, so code that ends at a graft waits on whatever the eval call waits on.
   */
  const deferralOf = (entry: AstNode | undefined): Deferral | undefined => {
    const outer = code.deferral?.()
    if (outer !== undefined) return outer
    if (entry === undefined) return undefined
    const graft = grafts.get(entry)
    if (graft !== undefined) return deferralAt(graft.call, false)()
    // A link group's member that only dynamic imports load waits on an import at load, which has no name.
    if (analysis.group.wrappers.has(entry)) return { entry: null }
    return { entry: entryName(entry, (each) => resolution.parentOf(each)) }
  }
  // The occurrences instantiated in frames, which two frames give alike when the write doesn't depend on them.
  const instantiated = new Map<string, RawOccurrence | undefined>()
  // Each occurrence given, with the write and frame of each instantiation of it, for rewritten deletes (§3).
  const placed: Placed[] = []
  // The occurrences each statically false catalog check pruned, by their JSON, and the tests on each occurrence given
  // with their `guard` steps, for the `prune` steps (§7, §14).
  const prunedBy = new Map<AstNode, Set<string>>()
  const guarded: { occurrence: RawOccurrence; tests: ReadonlyMap<AstNode, GuardStep> }[] = []
  // The writes each `try` that can't throw kept its `catch` arm from making, by their records' JSON, and each occurrence
  // given in a `try` block, with where its `prune` steps go (§5 Resolver capabilities 9).
  const armPrunes: ArmPrunes = { prunedBy: new Map(), tried: [] }
  const dropArm = (arm: AstNode, record: unknown) => {
    const statement = resolution.parentOf(arm)!
    const pruned = armPrunes.prunedBy.get(statement)
    if (pruned === undefined) armPrunes.prunedBy.set(statement, new Set([JSON.stringify(record)]))
    else pruned.add(JSON.stringify(record))
  }
  // The writes the argument-literal rule dropped, by the test that ruled out their arm and the literal that settled
  // it, and each occurrence given with the tests and literals that decided its write, with where its `prune` steps go.
  const argumentPrunes: ArgumentPrunes = { prunedBy: new Map(), traced: [] }
  const dropRuledOut = (test: AstNode, literal: AstNode | undefined, record: unknown) => {
    const key = decisionKey(test, literal)
    let pruned = argumentPrunes.prunedBy.get(key)
    if (pruned === undefined) argumentPrunes.prunedBy.set(key, (pruned = { test, literal, records: new Set() }))
    pruned.records.add(JSON.stringify(record))
  }
  // The frames whose writes a call argument literal's field decided, each with what it gave, at the walk's place.
  const undecided: Undecided[] = []
  // An occurrence's `prune` steps for the tests a call argument literal settled on its path go after their `guard`
  // steps, and those for the tests that decided its write's values after all its guards, at `at`.
  const argumentTraced = (occurrence: RawOccurrence, tests: ReadonlyMap<AstNode, GuardStep>) => {
    for (const guard of tests.values()) {
      const settled = argumentGuards.get(guard)
      if (settled !== undefined) argumentPrunes.traced.push({ occurrence, key: decisionKey(settled.test, settled.literal), after: guard })
    }
  }
  const descriptorsCut = (sites: readonly AstNode[], native: boolean) => {
    for (const site of sites) descriptorCut(analysis, site, native)
  }
  const writeContext = {
    scope,
    resolution,
    global,
    instance,
    budget,
    descriptorsCut,
    candidatesCut: (node: AstNode, native: boolean) => candidatesCut(analysis, node, native),
    capHit: (name: 'heapDepth', node: AstNode) => capHit(analysis, name, node),
    descriptorFields,
    caps: analysis.caps,
    patternPrefix: (holder: string, prefix: string) => prefixMembers(holder, prefix, catalog, source.realm).length === 0,
  }

  /**
   * The writes a node makes, each with the frame it was instantiated in (§5 Resolver capabilities 3): in each frame of
   * the function it is in, when they read that function's parameters and a call of it is known.
   */
  const writesOf = (
    node: AstNode,
  ): {
    writes: { write: Write; frame?: Frame }[]
    open: OpenWrite[]
    wild: { write: WildWrite; frame?: Frame }[]
    wide: WideSite[]
    /** The tests a call argument literal's field decided in each frame's writes, for their prunes. */
    decided: ReadonlyMap<Frame, readonly Decision[]>
  } => {
    const bare = (sites: Sites) => ({
      writes: sites.writes.map((write) => ({ write })),
      open: sites.open,
      wild: sites.wild.map((write) => ({ write })),
      wide: sites.wide,
      decided: new Map<Frame, readonly Decision[]>(),
    })
    if (contexts.length === 0) return bare(sitesAt(node, at, writeContext))
    const { value, functions: read } = resolution.contextual(() => sitesAt(node, at, writeContext))
    // The innermost loop, or the function the write is in, whose parameters, `this` or iterations the write reads. A
    // write that reads the bindings of code around its function, which the function closes over, or the `this` of a
    // constructor it runs in (a field initializer's), is instantiated in the frames of its function, whose closures
    // hold them (§5 Resolver capabilities 3).
    let context: AstNode | undefined
    let fn: AstNode | undefined
    for (let index = contexts.length - 1; index >= 0; index--) {
      const each = contexts[index]!
      if (read.has(each)) {
        context = fn ?? each
        break
      }
      if (isFunction(each)) fn ??= each
    }
    if (context === undefined && read.size > 0) context = fn ?? [...read].find((each) => !isLoop(each))
    if (context === undefined) return bare(value)
    // Iterations and callbacks run within the frames of the code around them when the write reads that code too. A
    // read the write makes only once an iteration binds its key (`p[m]` reads `p` once `m` folds) shows up only in
    // the iterations, which are then made again within those frames.
    const { guard, topLevel } = at
    const instantiate = (deep: boolean) =>
      resolution.framesOf(context, deep).map((frame) => {
        const { value: found, decisions } = resolution.decided(() =>
          resolution.contextual(() => sitesAt(node, { guard, topLevel, frame }, writeContext)),
        )
        return { frame, sites: found.value, reads: found.functions, decisions }
      })
    const deep = [...read].some((each) => each !== context)
    let instances = instantiate(deep)
    if (!deep && instances.some(({ reads }) => contexts.some((each) => each !== context && reads.has(each)))) {
      instances = instantiate(true)
    }
    if (instances.length === 0) return bare(value)
    return {
      writes: instances.flatMap(({ frame, sites }) => sites.writes.map((write) => ({ write, frame }))),
      open: instances.flatMap(({ sites }) => sites.open),
      wild: instances.flatMap(({ frame, sites }) => sites.wild.map((write) => ({ write, frame }))),
      wide: instances.flatMap(({ sites }) => sites.wide),
      decided: new Map(instances.filter(({ decisions }) => decisions.length > 0).map(({ frame, decisions }) => [frame, decisions])),
    }
  }
  const foldKey = (key: AstNode) => {
    const values = resolution.evaluate(key, at)
    const [value] = values
    return values.length === 1 && value?.kind === 'constant' ? toPropertyKey(value.value) : undefined
  }
  // Whether a write site whose holder the analyzer can't resolve keeps the original of its slot (§5).
  const shapes = patchShapes({
    program,
    definitions,
    fold: foldKey,
    isCatalogNative: (callee) => catalogNative(callee, resolution, at, catalog, source.realm),
    isDescriptorReader: (callee) =>
      resolution
        .evaluate(callee, at)
        .some((value) => value.kind === 'native' && descriptorReaders.has(value.name)),
    aliasDepth: analysis.caps.aliasDepth,
    aliasCut: (id) => capHit(analysis, 'aliasDepth', id),
    calleeFunctions: (callee) =>
      resolution
        .evaluate(callee, at)
        .flatMap((value) =>
          value.kind === 'object' && value.heap?.kind === 'function' && isFunction(value.heap.node) ? [value.heap.node] : [],
        ),
  })
  // Whether a replacement is shown to call the original (§5 Resolver capabilities 10).
  const evidence = wrapEvidence({
    resolution,
    definitions,
    catalog,
    realm: source.realm,
    global,
    isCatalogNative: (callee, where) => catalogNative(callee, resolution, where, catalog, source.realm),
  })
  // Whether a write puts back the native of its slot (§3 Restores).
  const judgeRestore = restoreJudge({ resolution, definitions, catalog, realm: source.realm, global, text: source.text })
  // The proven restores, which give no occurrence, and the occurrences of unproven ones, for their installs (§3).
  const provenRestores: { restore: Restore; target: RawOccurrence['target']; generated: GeneratedLocation }[] = []
  const unprovenRestores: { restore: Restore; occurrence: RawOccurrence }[] = []
  // The absence tags a write's holder or value carries (§5 Resolver capabilities 7, §7).
  const tagsOf = absenceTags({
    resolution,
    definitions,
    catalog,
    realm: source.realm,
    global,
    functionOf: (node) => calls.functionOf(node),
    judge: (site, where, target) =>
      judgeChain(
        functionPath(site, (node) => resolution.parentOf(node)),
        { site, target, taints: [] },
        where,
        calls.functionOf(site),
      ),
    evidence,
  })
  const nesting = (): Nesting =>
    evals.length === 0 ? code.around : joined(code.around, ...evals.map((level) => level.nesting))
  // The literal code of the script elements the program inserts, by the call that inserts each. Only the window
  // has `document.createElement`.
  const scriptTexts =
    source.realm === 'window' && /createElement/.test(analysis.text)
      ? injectedTexts(program, new Folder(program, definitions, new Map()))
      : undefined

  walkTree(program, {
    enter(node, parent) {
      // A program's root is no work of its own, so an empty artifact, whose step budget is 0, takes no step.
      if (parent !== null) step(analysis)
      const graft = grafts.get(node)
      if (graft !== undefined) {
        // Direct-eval code is analyzed only when the call's `eval` is the global one; otherwise it is just a string.
        const callee = nativeCallee(graft.call, context, at)
        if (callee?.name !== 'eval') return false
        evals.push({ node, nesting: nestingOf('eval', 'caller', graft.call, callee.leaves, analysis, [node]) })
      }
      if (parent !== null) {
        const guarded = resolution.guards(parent, node)
        const boundary = isThisBoundary(node, parent)
        if (guarded.size > 0 || boundary) {
          frames.push({ node, guards: guarded, boundary })
          for (const [name, test] of guarded) {
            const tests = guards.get(name)
            if (tests === undefined) guards.set(name, [test])
            else tests.push(test)
          }
          if (boundary) boundaries++
        }
      }

      ancestors.push(node)
      if (node.type === 'CallExpression' || node.type === 'NewExpression') codeSite(node, context, at, nesting())
      else if (node.type === 'TaggedTemplateExpression') indirectSite(node, context, at)
      const texts = scriptTexts?.get(node)
      if (texts !== undefined) scriptTextSite(node, texts, context, nesting())
      if (isFunction(node) || isLoop(node)) contexts.push(node)

      const { writes, open, wild, wide, decided: decidedIn } = writesOf(node)
      // Each frame's outcomes, by `outcomeKey`, which a frame's writes give without the argument-literal rule's
      // decisions are compared with.
      const given = new Map<Frame, Set<string>>()
      const giving = (write: Write | WildWrite, frame: Frame | undefined, decided: Mutation | Ineffective) => {
        if (frame === undefined || !decidedIn.has(frame)) return
        let keys = given.get(frame)
        if (keys === undefined) given.set(frame, (keys = new Set()))
        keys.add(outcomeKey(write, decided))
      }
      // The sites at this node that give a finding: a site gives findings or a record, never both (§5).
      const found = new Set<AstNode>()
      // An occurrence whose write's values a call argument literal's field decided in its frame gets a `prune` step
      // for each such test that dropped writes, after its guards.
      const decidedTraced = (occurrence: RawOccurrence, frame: Frame | undefined, outcomes: number) => {
        const decisions = frame === undefined ? undefined : decidedIn.get(frame)
        if (decisions === undefined) return
        const index = occurrence.trace.length - outcomes - 1
        const after = index < 0 ? 0 : occurrence.trace[index]!
        const ordered = [...decisions].sort((a, b) => a.test.start - b.test.start || a.literal.start - b.literal.start)
        for (const { test, literal } of ordered) argumentPrunes.traced.push({ occurrence, key: decisionKey(test, literal), after })
      }
      /**
       * Reports one outcome of a write: an occurrence, or an ineffective write. `extra` are the confidence-reason steps
       * the outcome carries beyond `outcome-undecidable`.
       */
      const emit = (
        write: Write,
        frame: Frame | undefined,
        decided: Mutation | Ineffective,
        extra: MutationStep[] = [],
        restore?: Restore,
      ): void => {
        found.add(write.site)
        // A wildcard names no member, so no rewritten delete judges it, nor rewrites one.
        const wildcard = 'key' in write

        // Whether the group's realm is assumed, the nested code the write is in, then each leaf's binding step, and
        // each fold the write comes from, each followed by the evidence for the taint on its name's resolution path
        // (§9, §14). Last, the evidence that the outcome can't be decided, or the outcome of an ineffective write.
        const around = nesting()
        const { steps: made, reasons } = joined(
          around,
          creationSteps(frame, starts),
          stepsOf(write.leaves, analysis),
          foldSteps(write.folds, analysis),
          prefixSteps(write, starts),
          candidateSteps(write, starts),
        )
        const { name, holder, shadows, effect } = decided
        // The guards between the write and the start of its function (§7), evaluated in the write's frame, and the
        // `with` and direct-`eval` taint its confidence-reason steps show.
        const judgedWrite = {
          site: write.site,
          target: { name, ...(shadows === undefined ? {} : { shadows }) },
          taints: taintSites(made),
        }
        // With the guards along the call chain out to its install entry, which come first in the trace (§7).
        const position: Position = { guard: at.guard, topLevel: at.topLevel, frame }
        let judged = judgeChain(ancestors, judgedWrite, position, functionAround(ancestors, write.site))
        // A filter on a swept key that drops it: the sweep never writes that key (§5 Resolver capabilities 9).
        if (judged.dead !== undefined && sweepFilters.has(judged.dead)) return
        // An arm a call argument literal's field rules out is not reached there (§5 Resolver capabilities 5), but
        // each write it drops leaves a counted, traced `prune`, counted as a `catch` arm's are.
        if (judged.dead !== undefined && ruledOutTests.has(judged.dead)) {
          const { start, end } = write.site
          return dropRuledOut(judged.dead, judged.by, { start, end, holder, name, shadows, effect, mechanism: write.mechanism })
        }
        // A `catch` arm whose `try` can't throw never runs, so its writes give nothing, but each leaves a counted,
        // traced `prune` (§5 Resolver capabilities 9).
        // It is dropped before any more work, so the arm spends no more of the step budget than before (Principle 5),
        // and counted once per write site, target and effect, however many frames reach it.
        if (judged.dead !== undefined && unreachedArms.has(judged.dead)) {
          const { start, end } = write.site
          return dropArm(judged.dead, { start, end, holder, name, shadows, effect, mechanism: write.mechanism })
        }
        // A filter that may have dropped a swept key makes the write `conditional`, along the path.
        const undecided = undecidedFilterSteps(write.folds, starts)
        if (undecided.length > 0) {
          judged = { ...judged, reachability: along(judged.reachability, 'conditional'), steps: [...judged.steps, ...undecided] }
        }
        // A holder or value chosen on a native-absent branch keeps `guarded-native-absence` (§5 capability 7).
        if (judged.reachability !== 'guarded-native-absence') {
          const tagged = tagsOf(write, decided, position)
          if (tagged !== undefined) {
            const steps = [...judged.steps, ...unique(tagged, judged.steps)]
            judged = { ...judged, reachability: 'guarded-native-absence', steps }
          }
        }
        // Nested code that runs only later waits on its compile site's install entry, the outermost one (§7).
        const deferral = deferralOf(judged.entry)
        // A function object the chain is judged from the creation site of shows its `creation-site` step there, after
        // the guards in force where it was made, and not again among the binding steps.
        const shown = new Set(judged.steps.flatMap((step) => (step.kind === 'creation-site' ? [creationKey(step)] : [])))
        const steps = made.filter((step) => step.kind !== 'creation-site' || !shown.has(creationKey(step)))
        // The filters on the path that test a swept key are the sweep's too: its `enumeration` step records them.
        const traced = withPathFilters(steps, judged.tests, starts)
        const generated = locate(starts, write.site.start, write.site.end)
        const where = starts.artifactOf(generated)!
        // A wildcard narrowed to a candidate set matches only those candidates, for `--surface` too.
        const { members, prefixes } = wildcard ? (write as WildWrite) : {}
        const matches =
          members === undefined && prefixes === undefined
            ? {}
            : { matches: narrowedMatches(write.holder, members, prefixes ?? [], catalog, source.realm).map(({ target }) => target) }
        const written = {
          artifact: where.url,
          generated,
          lookup: lookupOf(write, around, starts, resolution, where),
          target: { realm: source.realm, holder, name, ...(shadows === undefined ? {} : { shadows }) },
          effect,
          mechanism: write.mechanism,
          reachability: judged.reachability,
          reachabilityBasis: judged.basis ?? 'call-path',
          installContext: deferral === undefined ? ('load' as const) : ('deferred' as const),
          installEntry: deferral?.entry ?? null,
          realmInstance: write.realmInstance,
          ...matches,
        }
        if (isIneffective(decided)) {
          // A write that can't change its target is never a finding (§3), and a throwing one prunes nothing after it.
          const { reason, throws } = decided
          const ineffective: IneffectiveWrite = {
            ...written,
            trace: elsewhere([...traced, ...judged.steps, outcomeStep(decided)], where.url, starts),
            reason,
            throws,
            strictness: scope.isStrict(write.site.start) ? 'strict' : 'sloppy',
          }
          if (frame !== undefined) {
            const key = JSON.stringify(ineffective)
            if (instantiated.has(key)) return
            instantiated.set(key, undefined)
          }
          output.ineffectiveWrites.push(ineffective)
          return
        }
        // A proven restore is never a finding or an occurrence: it is a step on its install's trace, if any (§3).
        if (restore?.proven === true) {
          provenRestores.push({ restore, target: written.target, generated: written.generated })
          return
        }
        const { locks, undecidable } = decided
        const outcome = [...(undecidable === undefined ? [] : [undecidableStep(name, undecidable, starts)]), ...extra]
        const occurrence: RawOccurrence = {
          ...written,
          locks,
          confidence: {
            target: targetConfidence(reasons),
            mutation: mutationConfidence(outcome.map((step) => step.reason)),
          },
          trace: elsewhere([...traced, ...judged.steps, ...outcome], where.url, starts),
        }
        // A write only a statically false catalog check reaches gives no occurrence, but a wildcard finding stays
        // (§7). The prune is counted once per occurrence it would have given.
        if (judged.dead !== undefined && !wildcard) {
          const pruned = prunedBy.get(judged.dead)
          if (pruned === undefined) prunedBy.set(judged.dead, new Set([JSON.stringify(occurrence)]))
          else pruned.add(JSON.stringify(occurrence))
          return
        }
        if (frame !== undefined) {
          const key = JSON.stringify(occurrence)
          const same = instantiated.get(key)
          if (same !== undefined) {
            decidedTraced(same, frame, outcome.length)
            // One occurrence for alike instantiations, each of which a rewritten delete judges apart.
            if (!wildcard) placed.push({ occurrence: same, write, frame })
            if (restore !== undefined) unprovenRestores.push({ restore, occurrence: same })
            return
          }
          instantiated.set(key, occurrence)
        }
        if (!wildcard) placed.push({ occurrence, write, frame })
        if (restore !== undefined) unprovenRestores.push({ restore, occurrence })
        if (judged.tests.size > 0) guarded.push({ occurrence, tests: judged.tests })
        const tries = triesAround(ancestors, write.site)
        if (tries.length > 0) armPrunes.tried.push({ occurrence, tries, at: occurrence.trace.length - outcome.length })
        argumentTraced(occurrence, judged.tests)
        decidedTraced(occurrence, frame, outcome.length)
        output.occurrences.push(occurrence)
      }
      for (const { write, frame } of writes) {
        // A write of a native in an iteration the iteration cap cut raises `analysis-budget` (Principle 5).
        const cut = cutIn(frame)
        if (cut !== undefined) loopCut(analysis, cut)
        for (const decided of withWrapEvidence(write, outcomesOf(write, catalog, source.realm), evidence)) {
          // A value restore replaces, and a descriptor restore may also redefine the attributes (§3 Restores).
          const restores =
            !isIneffective(decided) &&
            (decided.effect === 'replace' || (write.change.kind === 'define' && decided.effect === 'descriptor-change'))
          giving(write, frame, decided)
          emit(write, frame, decided, [], restores ? judgeRestore(write, frame, decided, ancestors) : undefined)
        }
        // A write-back through a heap field changes nothing, but its field may carry the native saved before an install,
        // so a proven one is a restore and leaves its entry on that install (§3 Restores).
        if (write.change.kind === 'set' && write.change.throughHeap === true) {
          const fresh = { ...write, change: { ...write.change, same: false } }
          for (const decided of outcomesOf(fresh, catalog, source.realm)) {
            if (isIneffective(decided) || decided.effect !== 'replace') continue
            const restore = judgeRestore(fresh, frame, decided, ancestors)
            if (restore?.proven === true) emit(fresh, frame, decided, [], restore)
          }
        }
      }
      for (const { write, frame } of wild) {
        const cut = cutIn(frame)
        if (cut !== undefined) loopCut(analysis, cut)
        for (const { decided, extra } of wildcardOutcomes(write, shapes, evidence, catalog, source.realm, starts)) {
          giving(write, frame, decided)
          emit(write, frame, decided, extra)
        }
      }
      for (const write of open) {
        if (found.has(write.site)) continue
        unresolvedHolder(analysis, write, shapes.patchShaped)
      }
      for (const site of wide) {
        if (found.has(site.site)) continue
        wideHolders(analysis, site, shapes)
      }
      // The frames whose writes a call argument literal's field decided are found again without those decisions once
      // the walk is done: what they write then and not now, the argument-literal rule dropped.
      if (decidedIn.size > 0) {
        const shown = new Map([...guards].map(([name, tests]) => [name, tests.at(-1)]))
        const position = { guard: (name: string) => shown.get(name), topLevel: at.topLevel }
        for (const [frame, decisions] of decidedIn) {
          undecided.push({ node, frame, decisions, position: { ...position, frame }, ancestors: [...ancestors], given: given.get(frame) ?? new Set() })
        }
      }
    },
    leave(node) {
      if (ancestors.at(-1) === node) ancestors.pop()
      if (contexts.at(-1) === node) contexts.pop()
      if (evals.at(-1)?.node === node) evals.pop()
      if (frames.at(-1)?.node !== node) return
      const frame = frames.pop()!
      for (const name of frame.guards.keys()) guards.get(name)!.pop()
      if (frame.boundary) boundaries--
    },
  })

  unlinkedModuleCalls(analysis, host ? new Map([...links.unlinkedCalls, ...importCalls(analysis, program, scope)]) : links.unlinkedCalls, resolution, calls)
  armPruneSteps(analysis, armPrunes)
  pruneSteps(analysis, prunedBy, guarded)
  installRestores(placed, provenRestores, unprovenRestores, (read, install) =>
    sameChain(calls.functionOf(read), calls.functionOf(install), (fn) => {
      const callers = resolution.callersOf(fn)
      return callers.length > 0 ? callers.map((binding) => binding.site.within) : [calls.functionOf(fn)]
    }),
  )

  dropRewrittenDeletes(analysis, placed, {
    program,
    calls,
    slots: slotSignatures({
      definitions,
      fold: foldKey,
      aliasDepth: analysis.caps.aliasDepth,
      aliasCut: (id) => capHit(analysis, 'aliasDepth', id),
    }),
  })

  // Last, as nothing else then reads the resolution: the writes the argument-literal rule dropped through the values
  // it decided, found by giving each decided frame's writes again without those decisions. That work leaves no trace
  // of its own: its steps, cap hits and limitations are undone, and it is cut short, not the analysis, when it runs
  // past a budget of its own as large as the group's.
  const undone = sideEffects(analysis)
  try {
    for (const each of undecided) {
      const outcomesWithout = (variant: string, unsettles: (decision: Decision) => boolean): Map<string, unknown> => {
        const sites = resolution.counterfactual(variant, unsettles, () => sitesAt(each.node, each.position, writeContext))
        const found = new Map<string, unknown>()
        const add = (write: Write | WildWrite, decided: Mutation | Ineffective) => {
          const key = outcomeKey(write, decided)
          if (each.given.has(key) || found.has(key)) return
          const { name, holder, shadows, effect } = decided
          const target = { name, ...(shadows === undefined ? {} : { shadows }) }
          const judged = judgeChain(each.ancestors, { site: write.site, target, taints: [] }, each.position, functionAround(each.ancestors, write.site))
          // A write another rule drops anyway is that rule's.
          if (judged.dead !== undefined && !ruledOutTests.has(judged.dead)) return
          const { start, end } = write.site
          found.set(key, { start, end, holder, name, shadows, effect, mechanism: write.mechanism })
        }
        for (const write of sites.writes) {
          for (const decided of withWrapEvidence(write, outcomesOf(write, catalog, source.realm), evidence)) add(write, decided)
        }
        for (const write of sites.wild) {
          for (const { decided } of wildcardOutcomes(write, shapes, evidence, catalog, source.realm, starts)) add(write, decided)
        }
        return found
      }
      const dropped = outcomesWithout('', () => true)
      if (dropped.size === 0) continue
      // Each dropped write is put with the test whose decision alone drops it, or, when none does alone, with each.
      const alone = new Set<string>()
      if (each.decisions.length > 1) {
        for (const decision of each.decisions) {
          const key = decisionKey(decision.test, decision.literal)
          const one = outcomesWithout(key, (other) => decisionKey(other.test, other.literal) === key)
          for (const [outcome, record] of one) {
            if (!dropped.has(outcome)) continue
            alone.add(outcome)
            dropRuledOut(decision.test, decision.literal, record)
          }
        }
      }
      for (const [outcome, record] of dropped) {
        if (alone.has(outcome)) continue
        for (const { test, literal } of each.decisions) dropRuledOut(test, literal, record)
      }
    }
  } catch (error) {
    if (!(error instanceof BudgetExhausted)) throw error
  } finally {
    undone()
  }
  argumentPruneSteps(analysis, argumentPrunes)
}

/**
 * A write's outcome, as the frames of one write are compared with and without the argument-literal rule's decisions.
 */
function outcomeKey(write: Write | WildWrite, { holder, name, shadows, effect }: Mutation | Ineffective): string {
  return JSON.stringify([write.site.start, write.site.end, holder, name, shadows ?? null, effect, write.mechanism])
}

/** A frame whose writes a call argument literal's field decided, where the walk found it, and what it gave. */
interface Undecided {
  node: AstNode
  frame: Frame
  decisions: readonly Decision[]
  position: Position
  ancestors: readonly AstNode[]
  given: ReadonlySet<string>
}

/**
 * Saves what the analysis has counted and raised, and gives back what undoes whatever is counted or raised after it,
 * with a fresh step budget as large as the group's meanwhile: for work whose results only find prunes.
 */
function sideEffects(analysis: Analysis): () => void {
  const { output } = analysis
  const { steps, budget } = analysis
  const caps = { ...output.stats.caps }
  const limitations = output.limitations.length
  const sets = [analysis.foldsTooLong, analysis.callsCut, analysis.holdersUnresolved, analysis.loopsCut].map((set) => [set, new Set(set)] as const)
  const maps = [analysis.descriptorsCut, analysis.candidatesCut].map((map) => [map, new Map(map)] as const)
  const hit = new Map([...analysis.capsHit].map(([name, nodes]) => [name, new Set(nodes)]))
  analysis.budget = steps + budget
  return () => {
    analysis.steps = steps
    analysis.budget = budget
    for (const name of Object.keys(output.stats.caps)) delete output.stats.caps[name]
    Object.assign(output.stats.caps, caps)
    output.limitations.length = limitations
    for (const [set, saved] of sets) {
      set.clear()
      for (const each of saved) set.add(each)
    }
    for (const [map, saved] of maps) {
      map.clear()
      for (const [key, value] of saved) map.set(key, value)
    }
    analysis.capsHit.clear()
    for (const [name, nodes] of hit) analysis.capsHit.set(name, nodes)
  }
}

/**
 * A broken module link (§6 Degradation) raises `unlinked-module-call` only when a global, a holder or a target flows into
 * a call through what it returns: an argument can be the global object, a native holder or a native function, in any
 * frame of the code the call is in. Any other broken link is only counted, in `moduleLinking.unlinked`.
 */
function unlinkedModuleCalls(
  analysis: Analysis,
  unlinkedCalls: ReadonlyMap<AstNode, BrokenLink>,
  resolution: GlobalResolution,
  calls: CallGraph,
): void {
  const { source, starts, output } = analysis
  const carries = (values: readonly Value[]) => values.some((value) => value.kind === 'holder' || value.kind === 'native')
  for (const [call, broken] of [...unlinkedCalls].sort(([a], [b]) => a.start - b.start)) {
    const info = calls.infoOf(call)
    const base: Position = { guard: (name) => info?.guards.get(name), topLevel: info?.topLevel ?? false }
    const args = (call['arguments'] as AstNode[]).map((arg) => (arg.type === 'SpreadElement' ? (arg['argument'] as AstNode) : arg))
    const flows = args.some((arg) => {
      const { value, functions } = resolution.contextual(() => resolution.evaluate(arg, base))
      if (carries(value)) return true
      // In the frames of the innermost function whose bindings the argument reads.
      const around = info?.contexts.find((context) => functions.has(context))
      if (around === undefined) return false
      return resolution.framesOf(around, true).some((frame) => carries(resolution.evaluate(arg, { ...base, frame })))
    })
    if (!flows) continue
    const location = locate(starts, call.start, call.end)
    const link = locate(starts, broken.call.start, broken.call.end)
    const through =
      broken.why === 'import'
        ? `the import of \`${String((broken.call['source'] as AstNode)['value'])}\` at ${link.line}:${link.column}, whose ` +
          "module isn't in the link group"
        : `the module link \`${printed(broken.call)}\` at ${link.line}:${link.column}, whose ` +
          (broken.why === 'missing' ? 'module id names no factory in its table' : "module id isn't a constant")
    output.limitations.push({
      kind: 'unlinked-module-call',
      artifact: { url: source.url, hash: source.hash },
      location,
      detail:
        `the call \`${printed(call['callee'] as AstNode)}(…)\` at ${location.line}:${location.column} passes a global, ` +
        `holder or target through ${through}`,
    })
  }
}

/**
 * The calls through an import binding whose module isn't in the link group (§6 Degradation): `f(…)`, `ns.f(…)` or
 * `new F(…)` where `f`, `ns` or `F` is that binding, each with the broken link.
 */
function importCalls(analysis: Analysis, program: AstNode, scope: ScopeRules): Map<AstNode, BrokenLink> {
  const { unlinkedBindings } = analysis.group
  const found = new Map<AstNode, BrokenLink>()
  if (unlinkedBindings.size === 0) return found
  walkTree(program, {
    enter(node) {
      if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return
      let base = calleeExpression(node['callee'] as AstNode)
      while (base.type === 'MemberExpression') base = base['object'] as AstNode
      if (base.type !== 'Identifier') return
      let declaration: AstNode | undefined
      try {
        declaration = scope.declaration(base)
      } catch {
        return
      }
      const broken = declaration === undefined ? undefined : unlinkedBindings.get(declaration)?.get(scope.nameOf(base))
      if (broken !== undefined) found.set(node, { call: broken, why: 'import' })
    },
  })
  return found
}

/**
 * Counts the occurrences statically false catalog checks pruned (§7), and gives each surviving occurrence a check is on
 * a `prune` step after that check's `guard` step: the count it pruned, and the guard (§14).
 */
function pruneSteps(
  { output, starts }: Analysis,
  prunedBy: ReadonlyMap<AstNode, ReadonlySet<string>>,
  guarded: readonly { occurrence: RawOccurrence; tests: ReadonlyMap<AstNode, GuardStep> }[],
): void {
  if (prunedBy.size === 0) return
  let total = 0
  for (const pruned of prunedBy.values()) total += pruned.size
  output.stats.pruned = (output.stats.pruned ?? 0) + total
  for (const { occurrence, tests } of guarded) {
    for (const [test, guard] of tests) {
      const count = prunedBy.get(test)?.size
      if (count === undefined) continue
      const generated = locate(starts, test.start, test.end)
      const expression = printed(test)
      const prune: PruneStep = {
        kind: 'prune',
        count,
        expression,
        generated,
        text:
          `the guard \`${expression}\` at ${generated.line}:${generated.column} is statically false against the catalog, ` +
          `so ${count} finding ${count === 1 ? 'occurrence' : 'occurrences'} it alone reaches ${count === 1 ? 'was' : 'were'} pruned`,
      }
      occurrence.trace.splice(occurrence.trace.indexOf(guard) + 1, 0, prune)
    }
  }
}

/** The writes `catch` arms whose `try` can't throw dropped, by `try` statement, and the occurrences given in `try` blocks. */
interface ArmPrunes {
  prunedBy: Map<AstNode, Set<string>>
  /** Each occurrence given in a `try` block, the `try` statements around it, and the trace index its steps go at. */
  tried: { occurrence: RawOccurrence; tries: readonly AstNode[]; at: number }[]
}

/**
 * The `try` statements whose block a write is in, in the function it is in, outermost first: what runs a `catch` arm
 * that one of them judged unreachable would have run instead.
 */
function triesAround(ancestors: readonly AstNode[], site: AstNode): AstNode[] {
  const end = ancestors.indexOf(site) === -1 ? ancestors.length : ancestors.indexOf(site) + 1
  let from = 0
  for (let index = end - 2; index >= 0; index--) {
    if (isFunction(ancestors[index]!)) {
      from = index
      break
    }
  }
  const tries: AstNode[] = []
  for (let index = from + 1; index < end; index++) {
    const parent = ancestors[index - 1]!
    if (parent.type === 'TryStatement' && ancestors[index] === parent['block']) tries.push(parent)
  }
  return tries
}

/** A `try` statement as a `prune` step shows it: its block's statements, printed, cut at 120 characters. */
function printedTry(statement: AstNode): string {
  const body = ((statement['block'] as AstNode)['body'] as AstNode[]).map((each) =>
    each.type === 'ExpressionStatement' ? printed(each['expression'] as AstNode) : '…',
  )
  const text = body.length === 0 ? 'try {}' : `try { ${body.join('; ')} }`
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

/**
 * Counts the writes `catch` arms whose `try` can't throw dropped (§5 Resolver capabilities 9), where the
 * statically false catalog checks' prunes are counted (§7), and gives each surviving occurrence in such a `try` block a
 * `prune` step after its guards: the `try`, the count it dropped, and the judgement that dropped them (§14).
 */
function armPruneSteps({ output, starts }: Analysis, { prunedBy, tried }: ArmPrunes): void {
  if (prunedBy.size === 0) return
  let total = 0
  for (const pruned of prunedBy.values()) total += pruned.size
  output.stats.pruned = (output.stats.pruned ?? 0) + total
  for (const { occurrence, tries, at } of tried) {
    const steps = tries.flatMap((statement): PruneStep[] => {
      const count = prunedBy.get(statement)?.size
      if (count === undefined) return []
      const generated = locate(starts, statement.start, statement.end)
      return [
        {
          kind: 'prune',
          count,
          expression: printedTry(statement),
          generated,
          judgement: 'try-cannot-throw',
          text:
            `the \`try\` block at ${generated.line}:${generated.column} can't throw, so its ` +
            `\`catch\` arm never runs and the ${count} ${count === 1 ? 'write' : 'writes'} in it ` +
            `${count === 1 ? 'was' : 'were'} pruned`,
        },
      ]
    })
    occurrence.trace.splice(at, 0, ...steps)
  }
}

/** The key of a test a call argument literal settled, with that literal. */
const decisionKey = (test: AstNode, literal: AstNode | undefined): string =>
  `${test.start}:${test.end}@${literal === undefined ? '' : `${literal.start}:${literal.end}`}`

/**
 * The writes the argument-literal rule dropped, by the test that ruled out their arm and the literal that settled it
 * (by `decisionKey`), and the occurrences given with the tests and literals that decided their writes.
 */
interface ArgumentPrunes {
  prunedBy: Map<string, { test: AstNode; literal: AstNode | undefined; records: Set<string> }>
  /**
   * Each occurrence a settled test decided, by the test's key, with where its step goes: after that test's `guard` step,
   * or at a trace index.
   */
  traced: { occurrence: RawOccurrence; key: string; after: TraceStep | number }[]
}

/**
 * A call argument literal as a `prune` step shows it: its properties printed one level deep, a method or accessor as
 * `…`, and cut at 120 characters.
 */
function printedLiteral(literal: AstNode): string {
  const properties = (literal['properties'] as AstNode[]).map((property) => {
    if (property.type !== 'Property') return printed(property)
    const key = property['key'] as AstNode
    const name = property['computed'] === true ? `[${printed(key)}]` : printed(key)
    if (property['kind'] !== 'init' || property['method'] === true) return `${name}…`
    return property['shorthand'] === true ? name : `${name}: ${printed(property['value'] as AstNode)}`
  })
  const text = properties.length === 0 ? '{}' : `{ ${properties.join(', ')} }`
  return text.length > 120 ? `${text.slice(0, 119)}…` : text
}

/**
 * Counts the writes the argument-literal rule dropped (§5 Resolver capabilities 5), where the statically false catalog
 * checks' prunes are counted (§7), once per write site, target, effect and mechanism. Each surviving occurrence whose
 * write a test settled that way gets a `prune` step after its guards for each such test that dropped writes: the test,
 * the count of writes it dropped, and the literal that settled it (§14).
 */
function argumentPruneSteps({ output, starts }: Analysis, { prunedBy, traced }: ArgumentPrunes): void {
  if (prunedBy.size === 0) return
  const all = new Set<string>()
  for (const { records } of prunedBy.values()) for (const record of records) all.add(record)
  output.stats.pruned = (output.stats.pruned ?? 0) + all.size
  const added = new Map<RawOccurrence, Set<string>>()
  // Steps that go at one place are put there last first, so that they end up in the order they were given.
  for (const { occurrence, key, after } of [...traced].reverse()) {
    const pruned = prunedBy.get(key)
    if (pruned === undefined) continue
    // One step per test and literal on each occurrence, however many ways it was decided.
    let keys = added.get(occurrence)
    if (keys === undefined) added.set(occurrence, (keys = new Set()))
    if (keys.has(key)) continue
    keys.add(key)
    const { test, literal, records } = pruned
    const count = records.size
    const generated = locate(starts, test.start, test.end)
    const expression = printed(test)
    const settled = literal === undefined ? undefined : { expression: printedLiteral(literal), generated: locate(starts, literal.start, literal.end) }
    const step: PruneStep = {
      kind: 'prune',
      count,
      expression,
      generated,
      judgement: 'argument-literal',
      ...(settled === undefined ? {} : { literal: settled }),
      text:
        `the test \`${expression}\` at ${generated.line}:${generated.column} is settled by ` +
        (settled === undefined
          ? 'a call argument literal'
          : `the call argument literal \`${settled.expression}\` at ${settled.generated.line}:${settled.generated.column}`) +
        `, so the arm it rules out never runs and the ${count} ${count === 1 ? 'write' : 'writes'} only that arm reaches ` +
        `${count === 1 ? 'was' : 'were'} pruned`,
    }
    // A trace index is where the step goes, even the start; a step it goes after must still be on the trace.
    const at = typeof after === 'number' ? after : occurrence.trace.indexOf(after) + 1
    if (typeof after === 'number' || at > 0) occurrence.trace.splice(at, 0, step)
  }
}

/** An occurrence given, with the write and frame of one instantiation of it. */
interface Placed {
  occurrence: RawOccurrence
  write: Write
  frame: Frame | undefined
}

/** The mechanisms that write a slot again after a delete (§3): a define or an assign. */
const rewriting: ReadonlySet<Mechanism> = new Set(['assign', 'bulk-assign', 'define-property', 'define-properties', 'reflect-define'])

/** The effects of an install: a write that sets a value (§3 Restores). */
const installEffects: ReadonlySet<Effect> = new Set<Effect>(['replace', 'wrap', 'descriptor-change'])

/**
 * Puts each restore with the install occurrences in its chain (§3 Restores): an install is an occurrence of the same
 * target, other than a restore's, whose write is in one chain with a native read the restore's value came from. A
 * proven restore leaves a `restore` step on each install's trace, or nothing when it has none. An unproven restore with
 * an install joins the first install's finding, in document order, by taking its effect and its attribution
 * lookup.
 */
function installRestores(
  placed: readonly Placed[],
  proven: readonly { restore: Restore; target: RawOccurrence['target']; generated: GeneratedLocation }[],
  unproven: readonly { restore: Restore; occurrence: RawOccurrence }[],
  sameChain: (read: AstNode, install: AstNode) => boolean,
): void {
  if (proven.length === 0 && unproven.length === 0) return
  const restores = new Set(unproven.map(({ occurrence }) => occurrence))
  const installsOf = (target: RawOccurrence['target'], restore: Restore): RawOccurrence[] => {
    const found = new Set<RawOccurrence>()
    for (const { occurrence, write } of placed) {
      if (restores.has(occurrence) || found.has(occurrence)) continue
      if (occurrence.target.realm !== target.realm || occurrence.target.name !== target.name) continue
      // Only a write that sets a value is an install; a `delete` never is (§3).
      if (!installEffects.has(occurrence.effect)) continue
      if (restore.reads.some((read) => sameChain(read, write.site))) found.add(occurrence)
    }
    return [...found].sort((a, b) => a.generated.start - b.generated.start)
  }
  for (const { restore, target, generated } of proven) {
    const step: RestoreStep = {
      kind: 'restore',
      generated,
      guard: restore.guard,
      leavesOwnShadow: restore.leavesOwnShadow,
      text:
        `the restore at ${generated.line}:${generated.column} writes the native back` +
        (restore.guard === 'identity' ? ' only while the slot still holds this code’s value' : '') +
        (restore.leavesOwnShadow ? ', and leaves the own property the install created' : ''),
    }
    for (const install of installsOf(target, restore)) {
      const has = install.trace.some((each) => each.kind === 'restore' && each.generated.start === generated.start)
      if (!has) install.trace.push(step)
    }
  }
  for (const { restore, occurrence } of unproven) {
    const [install] = installsOf(occurrence.target, restore)
    if (install === undefined) continue
    // It takes the install's attribution lookup as well as its effect, so it never adds a fingerprint (§3).
    // A lookup point in the install's own artifact is named when that isn't the restore's.
    occurrence.effect = install.effect
    const artifact = install.lookup.artifact ?? install.artifact
    const point = { generated: install.lookup.generated, token: install.lookup.token }
    occurrence.lookup = artifact === occurrence.artifact ? point : { ...point, artifact }
  }
}

/**
 * A delete that the same function always follows with a define or assign of the same slot gives no finding of its own
 * (§3): its occurrences are dropped when every instantiation of it is rewritten, and each write that rewrites it gets
 * a `note` naming the delete. The same slot is the same holder expression (the same root through the same constant
 * chain, with no redefinition of the root between), the same target and the same instantiation of the function: the
 * write is in its own code, or in a call made there.
 */
function dropRewrittenDeletes(
  analysis: Analysis,
  placed: readonly Placed[],
  { program, calls, slots }: { program: AstNode; calls: CallGraph; slots: Slots },
): void {
  const deletes = placed.filter(({ write }) => write.mechanism === 'delete')
  if (deletes.length === 0) return
  const parents = new Map<AstNode, AstNode>()
  walkTree(program, {
    enter(node, parent) {
      if (parent !== null) parents.set(node, parent)
    },
  })
  const parentOf = (node: AstNode) => parents.get(node)
  const sameTarget = (a: RawOccurrence, b: RawOccurrence) =>
    a.target.realm === b.target.realm && a.target.name === b.target.name && a.realmInstance === b.realmInstance
  /**
   * The expression a write site gives its holder with, and the node that runs the write: `h` in `h[k] = v`,
   * `delete h[k]` or `define(h, k, d)`, and for a bulk mechanism's property, `h` in `Object.assign(h, { k: v })`.
   */
  const holderOf = (site: AstNode): { holder: AstNode; runs: AstNode } | undefined => {
    if (site.type === 'AssignmentExpression' || site.type === 'UnaryExpression') {
      const member = (site.type === 'AssignmentExpression' ? site['left'] : site['argument']) as AstNode
      return member.type === 'MemberExpression' ? { holder: member['object'] as AstNode, runs: site } : undefined
    }
    if (site.type === 'Property') {
      const call = parentOf(parentOf(site) ?? site)
      const holder = call?.type === 'CallExpression' ? (call['arguments'] as AstNode[])[0] : undefined
      return holder === undefined ? undefined : { holder, runs: call! }
    }
    const holder = site.type === 'CallExpression' ? (site['arguments'] as AstNode[])[0] : undefined
    return holder === undefined ? undefined : { holder, runs: site }
  }
  /** The calls, out from `frame`, that instantiated code through, each with the frame it was made in. */
  const callsOut = (frame: Frame | undefined, depth = 0): { call: AstNode; within: AstNode | undefined; caller: Frame | undefined }[] => {
    if (frame === undefined || depth > 8) return []
    const out = frame.bindings.flatMap((binding) => [
      { call: binding.site.call, within: binding.site.within, caller: binding.caller },
      ...callsOut(binding.caller, depth + 1),
    ])
    return [...out, ...callsOut(frame.outer, depth + 1)]
  }

  // Judged by the delete's site: every instantiation of it, whichever occurrence each gave, must be rewritten. The notes
  // each rewritten instantiation leaves on its writes are added only then, so no write says a delete gives no finding
  // while another instantiation of it keeps one.
  //
  // A node of the delete's function that rewrites the slot in one instantiation rewrites it in each: the slot is the
  // same syntactic (holder, key), and the node the same code. So the nodes are gathered over every instantiation of the
  // site first, and each is judged with all of them. An instantiation whose rewrite gives no occurrence of its own (a
  // write-back of what the slot holds, which changes nothing, or a call the context cap merged) is still rewritten.
  const rewritten = new Set<AstNode>()
  const kept = new Set<AstNode>()
  const notes: { site: AstNode; note: RewrittenDeleteStep; on: Set<RawOccurrence> }[] = []
  const judged: { removal: Placed; code: AstNode; byNode: Map<AstNode, RawOccurrence[]> }[] = []
  const rewritesOf = new Map<AstNode, Set<AstNode>>()
  for (const removal of deletes) {
    const site = removal.write.site
    const fn = calls.functionOf(site)
    const code = fn ?? program
    const holder = holderOf(site)?.holder
    const roots: VariableKey[] = []
    const signature = holder === undefined ? undefined : slots.signature(holder, roots)
    /** The writes that rewrite the slot, by the node in the delete's function that runs each. */
    const byNode = new Map<AstNode, RawOccurrence[]>()
    if (signature !== undefined) {
      for (const { occurrence, write, frame } of placed) {
        if (!rewriting.has(write.mechanism) || !sameTarget(occurrence, removal.occurrence)) continue
        const nodes: AstNode[] = []
        // A write in the delete's own code, in the same instantiation.
        if (calls.functionOf(write.site) === fn && frame?.id === removal.frame?.id) {
          const written = holderOf(write.site)
          if (written !== undefined && slots.signature(written.holder, []) === signature) nodes.push(written.runs)
        }
        // A write in a call made there, in the same instantiation, that passes the same holder.
        for (const { call, within, caller } of callsOut(frame)) {
          if (within !== fn || caller?.id !== removal.frame?.id) continue
          const args = (call['arguments'] as AstNode[] | undefined) ?? []
          if (args.some((arg) => slots.signature(arg, []) === signature)) nodes.push(call)
        }
        for (const node of nodes) {
          if (node.start < site.end || slots.redefined(roots, site.end, node.start)) continue
          const list = byNode.get(node)
          if (list === undefined) byNode.set(node, [occurrence])
          else if (!list.includes(occurrence)) list.push(occurrence)
        }
      }
    }
    judged.push({ removal, code, byNode })
    const rewrites = rewritesOf.get(site) ?? new Set<AstNode>()
    for (const node of byNode.keys()) rewrites.add(node)
    rewritesOf.set(site, rewrites)
  }
  for (const { removal, code, byNode } of judged) {
    const site = removal.write.site
    // Another instantiation's rewrite counts only when it is the same code with the same callee: a write in the delete's
    // own code, or a call whose callee doesn't read a binding of the delete's function, which each call may bind to a
    // different function (`function d(O, k, r){ delete O[k]; r(O, k) }`).
    const shared = [...rewritesOf.get(site)!].filter((node) => byNode.has(node) || !variesByCall(node, code))
    if (shared.length === 0 || !alwaysRewritten(site, code, (node) => shared.includes(node), parentOf)) {
      kept.add(site)
      continue
    }
    rewritten.add(site)
    const at = locate(analysis.starts, site.start, site.end)
    const note: RewrittenDeleteStep = {
      kind: 'note',
      about: 'rewritten-delete',
      delete: at,
      text: `the delete of the same slot at ${at.line}:${at.column}, which this write always follows, gives no finding of its own`,
    }
    notes.push({ site, note, on: new Set([...byNode.values()].flat()) })
  }
  for (const { site, note, on } of notes) {
    if (kept.has(site)) continue
    for (const occurrence of on) {
      const has = occurrence.trace.some(
        (step) => step.kind === 'note' && step.about === 'rewritten-delete' && step.delete.start === note.delete.start,
      )
      if (!has) occurrence.trace.push(note)
    }
  }
  const output = analysis.output
  const dropped = new Set(
    deletes.filter(({ write }) => rewritten.has(write.site) && !kept.has(write.site)).map(({ occurrence }) => occurrence),
  )
  output.occurrences = output.occurrences.filter((occurrence) => !dropped.has(occurrence))
}

/**
 * Whether a call node's callee may be a different function in each instantiation of `fn`: its root is `this`, or a name
 * that `fn` binds itself, as a parameter, `arguments` or a declaration in its own code. A node that is no call never is.
 */
function variesByCall(node: AstNode, fn: AstNode): boolean {
  if (node.type !== 'CallExpression' && node.type !== 'NewExpression') return false
  let root = calleeExpression(node['callee'] as AstNode)
  while (root.type === 'MemberExpression') root = root['object'] as AstNode
  if (root.type === 'ThisExpression') return true
  if (root.type !== 'Identifier') return true
  const name = root['name'] as string
  if (fn.type === 'Program') return false
  if (bindsOwn(fn, name)) return true
  let declared = false
  walkTree(fn['body'] as AstNode, {
    enter(child) {
      if (declared || isFunction(child)) {
        if (child.type === 'FunctionDeclaration' && (child['id'] as AstNode | null)?.['name'] === name) declared = true
        return false
      }
      if (child.type === 'VariableDeclarator' && boundNames(child['id'] as AstNode).includes(name)) declared = true
      if (child.type === 'ClassDeclaration' && (child['id'] as AstNode | null)?.['name'] === name) declared = true
      return undefined
    },
  })
  return declared
}

/**
 * A write's outcomes with wrap evidence weighed (§5 Resolver capabilities 10, §8): a `replace` whose new value is shown
 * to call the original is a `wrap`. When the value's alternatives differ in wrap evidence, the write gives one outcome
 * per effect, each as decided as the `replace` was.
 */
function withWrapEvidence<T extends Mutation | Ineffective>(
  write: Write,
  outcomes: readonly T[],
  evidence: ReturnType<typeof wrapEvidence>,
): T[] {
  const sources = valueSources(write)
  if (sources.length === 0) return [...outcomes]
  return outcomes.flatMap((outcome) => {
    if (outcome.effect !== 'replace') return [outcome]
    const replaced = { holder: write.holder, original: outcome.shadows ?? outcome.name, leaves: write.leaves }
    const answers = evidence(sources, replaced)
    return [...(answers.has(true) ? [{ ...outcome, effect: 'wrap' as const }] : []), ...(answers.has(false) ? [outcome] : [])]
  })
}

/** A `confidence-reason` step (§14) for a mutation-confidence reason (§9). */
type MutationStep = ConfidenceReasonStep & { reason: MutationReason }

/**
 * The outcomes of a wildcard write (§5 Partially resolved writes, ADR 0004): none unless the same key is reused. The
 * effect follows the value written, as for a named member: a delete is a `delete`, a define that gives `get` or
 * `set`, or no `value`, a `descriptor-change`, a value that equals the read when present an `add`, a value with wrap
 * evidence a `wrap`, and any other a `replace`, one outcome per effect when the value's alternatives differ. The
 * outcome is judged over the members the wildcard matches (§3): a finding, with `wildcard-outcome-mixed` when some are
 * ineffective (§9), or ineffective writes under the wildcard's name.
 */
function wildcardOutcomes(
  write: WildWrite,
  shapes: Shapes,
  evidence: ReturnType<typeof wrapEvidence>,
  catalog: SerializedCatalog,
  realm: Realm,
  starts: Starts,
): { decided: Mutation | Ineffective; extra: MutationStep[] }[] {
  if (write.pattern !== undefined) return patternOutcomes(write, catalog, realm)
  const reuse = shapes.reuse(write)
  if (reuse === undefined || reuse.writesBack) return []
  const name = `${write.holder}.*`
  const { change } = write
  let effects: Effect[]
  if (change.kind === 'delete') effects = ['delete']
  else if (change.kind === 'define' && (change.descriptor.get || change.descriptor.set || change.descriptor.value === undefined)) {
    effects = ['descriptor-change']
  } else if (reuse.keptWhenPresent) effects = ['add']
  else {
    const sources = valueSources(write)
    const answers = sources.length === 0 ? new Set([false]) : evidence(sources, { holder: write.holder, original: name, leaves: write.leaves, isOriginal: reuse.isOriginal })
    effects = [...(answers.has(true) ? ['wrap' as const] : []), ...(answers.has(false) ? ['replace' as const] : [])]
  }
  return effects.flatMap((effect): { decided: Mutation | Ineffective; extra: MutationStep[] }[] => {
    const outcome = wildcardOutcome(write, effect, catalog, realm, write.members, write.prefixes)
    if (outcome === undefined) return []
    if (outcome.kind === 'ineffective') {
      return outcome.refused.map((refused) => ({
        decided: { ...refused, name, holder: outcome.holder, effect } satisfies Ineffective,
        extra: [],
      }))
    }
    const { locks, mixed, undecidable } = outcome
    const decided: Mutation = { name, holder: outcome.holder, effect, locks, ...(undecidable === undefined ? {} : { undecidable }) }
    return [{ decided, extra: mixed ? [mixedStep(name, write, starts)] : [] }]
  })
}

/**
 * The outcome of a pattern wildcard (§5 Pattern wildcards): a non-native `add` of `<holder>.<prefix>*`, whether or not
 * the key is reused, on prototype, constructor and namespace holders only. A delete of a member no catalog member's key
 * starts with changes no native, as a named one doesn't (§3).
 */
function patternOutcomes(write: WildWrite, catalog: SerializedCatalog, realm: Realm): { decided: Mutation; extra: MutationStep[] }[] {
  if (write.change.kind === 'delete' || write.change.kind === 'prototype') return []
  const outcome = wildcardOutcome(write, 'add', catalog, realm)
  if (outcome?.kind !== 'finding') return []
  const name = patternName(write.holder, write.pattern!)
  return [{ decided: { name, holder: outcome.holder, effect: 'add', locks: outcome.locks }, extra: [] }]
}

/**
 * The `confidence-reason` step (§14) for `wildcard-outcome-mixed` (§9): some members the wildcard matches would be
 * changed and others not.
 */
function mixedStep(name: string, write: Write, starts: Starts): MutationStep {
  return {
    kind: 'confidence-reason',
    dimension: 'mutation',
    reason: 'wildcard-outcome-mixed',
    level: mutationReasons['wildcard-outcome-mixed'],
    sites: [locate(starts, write.site.start, write.site.end)],
    text: `the members \`${name}\` matches are partly ones the write changes and partly ones it can't change`,
  }
}

/** The expressions a write's new value comes from: an assignment's value, or every `value` its descriptors give. */
function valueSources(write: Write): Source[] {
  const { change } = write
  if (change.kind === 'set') return change.sources ?? []
  if (change.kind !== 'define') return []
  const descriptors = change.alternatives ?? [change.descriptor]
  return descriptors.flatMap((descriptor) => (descriptor === 'refused' ? [] : (descriptor.value?.sources ?? [])))
}

/** What a code site's analysis needs from the program it is in. */
interface SiteContext {
  analysis: Analysis
  scope: ScopeRules
  resolution: GlobalResolution
  routes: CodeRoutes
  grafts: ReadonlyMap<AstNode, Graft>
  /** The window whose global object the program's free names are properties of. */
  instance: RealmInstance
  /** Whether the code a call at `node` compiles runs only later, and the install entry it waits on (§7), judged lazily. */
  deferralAt(node: AstNode, timer: boolean): () => Deferral | undefined
}

/**
 * A call that compiles code from strings (§2): a literal code string is analyzed as nested code located in the host,
 * and a code string that may not be a literal, or literal code that doesn't parse, is a `dynamic-code` limitation
 * (§13). A direct eval's literal code was grafted in place of its literal, and the walk analyzes it where it stands. A
 * call that reaches such a native by any other route is a `dynamic-code` limitation when it passes code, and its code is
 * not analyzed.
 */
function codeSite(node: AstNode, context: SiteContext, at: Position, around: Nesting): void {
  // A conditional or logical callee, even one whose test leaves a single branch (`(true ? eval : f)(s)`), is each of its
  // alternatives.
  const branches = context.routes.alternatives(node['callee'] as AstNode, at)
  if (branches.length !== 1 || branches[0] !== node['callee']) {
    alternativeSites(node, branches, context, at, around)
    return
  }
  const callee = nativeCallee(node, context, at)
  if (callee === undefined) indirectSite(node, context, at)
  else nativeSite(node, callee, context, at, around)
}

/**
 * A call whose callee has alternatives (`(c ? eval : f)(s)`), each counted (Principle 3): an alternative that
 * is a direct form's native raises what that native's single-value form raises, analyzed once for each native, and one
 * that reaches a native by another route raises `dynamic-code` for each native that no other alternative reached.
 */
function alternativeSites(node: AstNode, branches: readonly AstNode[], context: SiteContext, at: Position, around: Nesting): void {
  const reached = new Set<string>()
  const indirect: IndirectCall[] = []
  for (const branch of branches) {
    const call = { ...node, callee: branch }
    const callee = nativeCallee(call, context, at)
    if (callee === undefined) indirect.push(...context.routes.reached(call, at))
    else if (!reached.has(callee.name)) {
      reached.add(callee.name)
      // No alternative of several is a direct eval, whose callee is the plain name.
      nativeSite(node, { ...callee, direct: false }, context, at, around)
    }
  }
  for (const call of indirect) {
    if (reached.has(call.compiler)) continue
    reached.add(call.compiler)
    const code = indirectCodeAt(call, node, context.resolution, at)
    if (code !== undefined) indirectCode(context.analysis, call, node, code)
  }
}

/** A call whose callee is a native that compiles code from strings, reached as a direct form. */
function nativeSite(node: AstNode, callee: NativeCallee, context: SiteContext, at: Position, around: Nesting): void {
  const { analysis, resolution, grafts } = context
  const args = node['arguments'] as AstNode[]
  const [first] = args
  const code = (literal: AstNode) => analysis.nested.code(literal)
  const nestedIn = (scope: NestedCodeStep['scope'], literals: readonly AstNode[]) =>
    joined(around, nestingOf(callee.name, scope, node, callee.leaves, analysis, literals, callee.folds))
  // Global code runs in the window of the native that compiles it.
  const compiledIn = instanceOf(callee.leaves)

  switch (callee.name) {
    case 'eval': {
      // `eval` returns anything but a string unchanged, so only a string can be code.
      if (first === undefined || grafts.has(first)) return
      if (isCodeLiteral(first)) {
        // A direct eval's literal that parses was grafted, so this one doesn't parse.
        const program = callee.direct ? undefined : analysis.nested.program(code(first))
        if (program === undefined) dynamicCode(analysis, callee.name, node, first, 'unparsed')
        else nestedGlobalCode(analysis, program, true, nestedIn('global', [first]), compiledIn, context.deferralAt(node, false))
      } else if (first.type === 'SpreadElement' || resolution.evaluate(first, at).some(maybeString)) {
        dynamicCode(analysis, callee.name, node, first, 'not-literal')
      }
      return
    }
    case 'setTimeout':
    case 'setInterval': {
      // A handler that is not callable is converted to a string and compiled as a classic script (HTML timer
      // initialization steps). Only a handler that is plainly a string is taken for one: most are functions.
      if (first === undefined || first.type === 'SpreadElement') return
      if (isCodeLiteral(first)) {
        const program = analysis.nested.program(code(first))
        if (program === undefined) dynamicCode(analysis, callee.name, node, first, 'unparsed')
        // A timer runs its code only later (§7 Install context).
        else nestedGlobalCode(analysis, program, false, nestedIn('global', [first]), compiledIn, context.deferralAt(node, true))
      } else if (stringValued(first) || resolution.evaluate(first, at).some(isString)) {
        dynamicCode(analysis, callee.name, node, first, 'not-literal')
      }
      return
    }
    case 'Function': {
      // Every argument is converted to a string: the parameters, then the body.
      const dynamic = args.find((arg) => !isCodeLiteral(arg) && !isPrimitiveLiteral(arg) && !isBigIntLiteral(arg))
      if (dynamic !== undefined) {
        dynamicCode(analysis, callee.name, node, dynamic, 'not-literal')
        return
      }
      // A number, bigint, boolean or null among them is literal code too, converted with ToString (Principle 2).
      if (args.length === 0) return
      const parts = args.map((arg) => (isCodeLiteral(arg) ? code(arg) : analysis.nested.converted(arg)))
      const program = analysis.nested.functionProgram(parts)
      if (program === undefined) dynamicCode(analysis, callee.name, node, spanned(args), 'unparsed')
      else nestedGlobalCode(analysis, program, false, nestedIn('global', args), compiledIn, context.deferralAt(node, false))
    }
  }
}

/**
 * A call that inserts a script element the code created with no `src`: the literal text it carries is global
 * nested code, compiled as a classic script where the call inserts it, and located in the host. Text that may not be a
 * literal, or literal text that doesn't parse, is a `dynamic-code` limitation (§13).
 */
function scriptTextSite(node: AstNode, texts: readonly AstNode[], context: SiteContext, around: Nesting): void {
  const { analysis } = context
  const site = locate(analysis.starts, node.start, node.end)
  for (const text of texts) {
    if (!isCodeLiteral(text)) {
      dynamicCodeRecord(analysis, text, `the script element inserted at ${site.line}:${site.column} carries text that is not a string literal`)
      continue
    }
    const program = analysis.nested.program(analysis.nested.code(text))
    if (program === undefined) {
      dynamicCodeRecord(analysis, text, `the script element inserted at ${site.line}:${site.column} carries literal code that does not parse`)
      continue
    }
    const nesting = joined(around, nestingOf('script', 'global', node, [], analysis, [text]))
    nestedGlobalCode(analysis, program, false, nesting, context.instance, context.deferralAt(node, false))
  }
}

/**
 * Analyzes nested global code: its own program, whose free names are the properties of the global object of the window
 * `instance` (§5).
 */
function nestedGlobalCode(
  analysis: Analysis,
  program: AstNode,
  evalCode: boolean,
  around: Nesting,
  instance: RealmInstance,
  deferral: () => Deferral | undefined,
): void {
  const grafts = new Map<AstNode, Graft>()
  analysis.nested.graftDirectEvals(program, grafts)
  analyzeCode(analysis, {
    program,
    sourceType: 'script',
    grafts,
    globalCode: true,
    evalCode,
    around,
    instance,
    deferral,
  })
}

/**
 * A `dynamic-code` limitation (§13), located at `code`: a native that compiles code, given a code string that may not be
 * a literal, or literal code that doesn't parse (§2).
 */
function dynamicCode(
  analysis: Analysis,
  callee: CodeCallee,
  call: AstNode,
  code: { start: number; end: number },
  why: 'not-literal' | 'unparsed',
): void {
  const site = locate(analysis.starts, call.start, call.end)
  const compiles = callee === 'eval' ? 'runs' : 'compiles'
  const what = why === 'not-literal' ? 'code that is not a string literal' : 'literal code that does not parse'
  dynamicCodeRecord(analysis, code, `\`${callee}\` at ${site.line}:${site.column} ${compiles} ${what}`)
}

/** A `dynamic-code` limitation record (§13) in the artifact being analyzed, located at `code`. */
function dynamicCodeRecord(analysis: Analysis, code: { start: number; end: number }, detail: string): void {
  const { source, starts } = analysis
  analysis.output.limitations.push({
    kind: 'dynamic-code',
    artifact: { url: source.url, hash: source.hash },
    location: locate(starts, code.start, code.end),
    detail,
  })
}

/**
 * A call, `new` expression or tagged template that reaches a native that compiles code by a route other than a direct
 * form (§2): a `dynamic-code` limitation (§13), whose code is not analyzed.
 */
function indirectSite(node: AstNode, { analysis, resolution, routes }: SiteContext, at: Position): void {
  for (const reached of routes.reached(node, at)) {
    const code = indirectCodeAt(reached, node, resolution, at)
    if (code !== undefined) indirectCode(analysis, reached, node, code)
  }
}

/**
 * Where an indirect call is dynamic code (§2), or undefined when it isn't. Every call that reaches `eval` or a function
 * constructor is, located at the code it passes: its first code argument, or the arguments the analyzer can't list, or
 * the call when it passes none. A timer is only when it is a string timer, whose handler is plainly a string (a handler
 * that isn't callable, such as a tagged template's strings array, is converted to one).
 */
function indirectCodeAt(
  { compiler, args }: IndirectCall,
  call: AstNode,
  resolution: GlobalResolution,
  at: Position,
): AstNode | undefined {
  const [first] = args.items
  switch (compiler) {
    case 'setTimeout':
    case 'setInterval':
      if (first === undefined || first === null) return undefined
      if (first.type === templateStrings) return first
      return stringValued(first) || resolution.evaluate(first, at).some(isString) ? first : undefined
    case 'eval':
      return first ?? args.rest ?? call
    default:
      return args.items.find((arg): arg is AstNode => arg !== null && !isPrimitiveLiteral(arg)) ?? args.rest ?? first ?? call
  }
}

/** A `dynamic-code` limitation (§13) for an indirect call that passes code, located at `code`, whose code isn't read. */
function indirectCode(analysis: Analysis, { compiler, via }: IndirectCall, call: AstNode, code: AstNode): void {
  const site = locate(analysis.starts, call.start, call.end)
  const route = via.map((step) => (step.startsWith('a ') ? step : `\`${step}\``)).join(', ')
  const compiles = compiler === 'eval' ? 'runs' : 'compiles'
  dynamicCodeRecord(
    analysis,
    code,
    `the call at ${site.line}:${site.column} reaches the native \`${compiler}\` indirectly` +
      `${route === '' ? '' : ` through ${route}`}, so the code it ${compiles} is not analyzed`,
  )
}

/** The range from the start of the first node to the end of the last. */
const spanned = (nodes: readonly AstNode[]) => ({ start: nodes[0]!.start, end: nodes.at(-1)!.end })

/**
 * An `analysis-budget` limitation (§13, §18) for a fold that passed the `fold-length` cap, so its value is unknown, in the
 * key, holder or descriptor of a write that reaches a native holder: one for each fold, however often it is evaluated.
 */
function foldTooLong(analysis: Analysis, node: AstNode): void {
  const { source, starts, foldsTooLong } = analysis
  if (foldsTooLong.has(node)) return
  foldsTooLong.add(node)
  const location = locate(starts, node.start, node.end)
  analysis.output.limitations.push({
    kind: 'analysis-budget',
    artifact: { url: source.url, hash: source.hash },
    location,
    detail:
      `\`${printed(node)}\` at ${location.line}:${location.column} folds to a string, or a BigInt whose decimal ` +
      `string, longer than ${analysis.caps.foldLength} UTF-16 code units, the fold-length cap, so its value is unknown`,
  })
}

/**
 * A descriptor the descriptor-alternatives cap cut (§18): counted once, and when its define reaches the global object or
 * a native holder, an `analysis-budget` limitation (§13, Principle 5): one for each descriptor.
 */
function descriptorCut(analysis: Analysis, site: AstNode, native: boolean): void {
  const { source, starts, descriptorsCut, output } = analysis
  const limited = descriptorsCut.get(site)
  if (limited === undefined) output.stats.caps['descriptors'] = (output.stats.caps['descriptors'] ?? 0) + 1
  if (limited === true || !native) {
    if (limited === undefined) descriptorsCut.set(site, false)
    return
  }
  descriptorsCut.set(site, true)
  const location = locate(starts, site.start, site.end)
  output.limitations.push({
    kind: 'analysis-budget',
    artifact: { url: source.url, hash: source.hash },
    location,
    detail:
      `the descriptor \`${printed(site)}\` at ${location.line}:${location.column} has more combinations of fields that ` +
      `may be absent than the descriptor-alternatives cap of ${analysis.caps.descriptorAlternatives}, so they are read ` +
      'as unseen',
  })
}

/**
 * A hit of a cap whose cut the value evaluation doesn't count itself (§18): `candidateRuns`, `testReads`,
 * `throwDepth`, `flagDepth`, `aliasDepth`, `heapDepth` (the heap's write-back depth) and `nesting`. Each is counted once
 * for each node where it cut, however often that node is judged, so the count doesn't depend on the order or the number
 * of times the analysis asks.
 */
function capHit(analysis: Pick<Analysis, 'capsHit' | 'output'>, name: keyof Caps, node: AstNode): void {
  let nodes = analysis.capsHit.get(name)
  if (nodes === undefined) analysis.capsHit.set(name, (nodes = new Set()))
  if (nodes.has(node)) return
  nodes.add(node)
  const { caps } = analysis.output.stats
  caps[name] = (caps[name] ?? 0) + 1
}

/**
 * A node whose candidate sites the candidate-runs cap cut, so they give nothing (§5 Candidate sets, §18): counted
 * once, and when a holder they write can be the global object or a native holder, an `analysis-budget` limitation
 * (§13, Principle 5): one for each node. The work done before the cut, every other write, stays.
 */
function candidatesCut(analysis: Analysis, node: AstNode, native: boolean): void {
  const { source, starts, output } = analysis
  const limited = analysis.candidatesCut.get(node)
  if (limited === undefined) capHit(analysis, 'candidateRuns', node)
  if (limited === true || !native) {
    if (limited === undefined) analysis.candidatesCut.set(node, false)
    return
  }
  analysis.candidatesCut.set(node, true)
  const location = locate(starts, node.start, node.end)
  output.limitations.push({
    kind: 'analysis-budget',
    artifact: { url: source.url, hash: source.hash },
    location,
    detail:
      `the write \`${printed(node)}\` at ${location.line}:${location.column} has more combinations of candidate holders and ` +
      `keys than the candidate-runs cap of ${analysis.caps.candidateRuns} runs, so its candidate sites are not analyzed`,
  })
}

/** The natives that read a property's descriptor, which captures its original (§5 Partially resolved writes). */
const descriptorReaders: ReadonlySet<string> = new Set(['Object.getOwnPropertyDescriptor', 'Reflect.getOwnPropertyDescriptor'])

/**
 * Whether a callee is a catalog native: a native function or holder, or a catalog member read from a native holder or
 * as a bare global. Passing the original to one doesn't keep it (§5 Partially resolved writes).
 */
function catalogNative(
  callee: AstNode,
  resolution: GlobalResolution,
  at: Position,
  catalog: SerializedCatalog,
  realm: Realm,
): boolean {
  const values = resolution.evaluate(callee, at)
  if (values.length > 0 && values.every((value) => value.kind === 'native' || value.kind === 'holder' || value.kind === 'member')) return true
  const expression = calleeExpression(callee)
  if (expression.type !== 'MemberExpression') return false
  const property = expression['property'] as AstNode
  const key =
    expression['computed'] === true
      ? resolution.evaluate(property, at)
      : property.type === 'Identifier'
        ? [{ kind: 'constant' as const, value: property['name'] as string }]
        : []
  const [only] = key
  if (key.length !== 1 || only?.kind !== 'constant') return false
  const member = toPropertyKey(only.value)
  const holders = resolution.evaluate(expression['object'] as AstNode, at)
  const targets = catalog.targets[realm]
  const holdersChain = catalog.holders[realm]
  return (
    holders.length > 0 &&
    holders.every((value) => {
      if (value.kind !== 'holder') return false
      for (let at: string | null = value.holder; at !== null; at = holdersChain[at]?.proto ?? null) {
        if (Object.hasOwn(targets, memberName(at, member))) return true
      }
      return false
    })
  )
}

/**
 * An `unresolved-holder` limitation (§5 Partially resolved writes, §13) for a write site whose member folds but whose
 * holder may be an object the analyzer can't resolve, when the site is patch-shaped and the member names a catalog
 * member it could mutate: one per site, however often it is instantiated. `detail` lists the candidate targets.
 */
function unresolvedHolder(analysis: Analysis, write: OpenWrite, patchShaped: (write: OpenWrite) => boolean): void {
  const { source, starts, catalog, holdersUnresolved } = analysis
  if (holdersUnresolved.has(write.site)) return
  const candidates = candidateTargets(write.change, catalog, source.realm)
  if (candidates.length === 0 || !patchShaped(write)) return
  holdersUnresolved.add(write.site)
  const location = locate(starts, write.site.start, write.site.end)
  analysis.output.limitations.push({
    kind: 'unresolved-holder',
    artifact: { url: source.url, hash: source.hash },
    location,
    detail:
      `\`${printed(write.holder)}\` at ${location.line}:${location.column} doesn't resolve, and the patch-shaped ` +
      `${write.mechanism} there could write ${candidates.join(', ')}`,
    candidates,
  })
}

/**
 * A write site whose candidate set passes the cap on holders alone (§5 Candidate sets): an `unresolved-holder`
 * limitation when it is patch-shaped, whose `detail` lists the candidates. With a member that folds, the site must keep
 * the original of its slot, and the candidates are the targets §3's outcome table could make it mutate. With one that
 * doesn't, the key must be reused, and the candidates are the `<holder>.*` wildcards, none on the global object.
 * Never a finding.
 */
function wideHolders(analysis: Analysis, site: WideSite, shapes: Shapes): void {
  const { source, starts, catalog, holdersUnresolved } = analysis
  if (holdersUnresolved.has(site.site)) return
  let candidates: string[]
  let holder: AstNode
  let mechanism: Mechanism
  if ('open' in site) {
    if (!shapes.patchShaped(site.open)) return
    const names = new Set<string>()
    for (const write of site.writes) {
      for (const outcome of outcomesOf(write, catalog, source.realm)) if (!isIneffective(outcome)) names.add(outcome.name)
    }
    candidates = [...names]
    ;({ holder, mechanism } = site.open)
  } else {
    const [first] = site.wild
    const reuse = first === undefined ? undefined : shapes.reuse(first)
    if (first === undefined || reuse === undefined || reuse.writesBack) return
    const holders = catalog.holders[source.realm]
    candidates = site.wild
      .filter((write) => Object.hasOwn(holders, write.holder) && holders[write.holder]!.kind !== 'global')
      .map((write) => `${write.holder}.*`)
    holder = first.object
    mechanism = first.mechanism
  }
  if (candidates.length === 0) return
  holdersUnresolved.add(site.site)
  const location = locate(starts, site.site.start, site.site.end)
  analysis.output.limitations.push({
    kind: 'unresolved-holder',
    artifact: { url: source.url, hash: source.hash },
    location,
    detail:
      `\`${printed(holder)}\` at ${location.line}:${location.column} can be more holders than a candidate set takes, ` +
      `and the patch-shaped ${mechanism} there could write ${candidates.join(', ')}`,
    candidates,
  })
}

/**
 * The `confidence-reason` steps (§14) of a write that is one candidate of its site's candidate set (§5 Candidate
 * sets, §9): `holder-alternatives` for several holders and `member-alternatives` for several members, each at the
 * branch that gives them, with the site's other candidates.
 */
function candidateSteps(write: Write, starts: Starts): Nesting {
  const { alternatives } = write
  if (alternatives === undefined) return none
  const own = candidateName(write)
  const others = alternatives.targets.filter((name) => name !== own)
  const steps: ConfidenceReasonStep[] = []
  const reasons: TargetReason[] = []
  const step = (reason: TargetReason, node: AstNode, what: string) => {
    const beside = others.length === 0 ? '' : `, beside ${others.map((name) => `\`${name}\``).join(', ')}`
    reasons.push(reason)
    steps.push({
      kind: 'confidence-reason',
      dimension: 'target',
      reason,
      level: targetReasons[reason] as ConfidenceReasonStep['level'],
      sites: [locate(starts, node.start, node.end)],
      alternatives: others,
      text:
        `\`${printed(node)}\` can be ${what}, which neither folding nor the catalog settles, so \`${own}\` is one ` +
        `candidate${beside}`,
    })
  }
  if (alternatives.holders !== undefined) step('holder-alternatives', alternatives.holders.node, alternatives.holders.names.join(', '))
  if (alternatives.members !== undefined) {
    const keys = [
      ...alternatives.members.keys.map((key) => (typeof key === 'symbol' ? symbolMember(key) : JSON.stringify(key))),
      // A prefix a pattern wildcard comes from (§5 Pattern wildcards).
      ...(alternatives.members.prefixes ?? []).map((prefix) => `a string that starts with ${JSON.stringify(prefix)}`),
    ]
    const unresolved = alternatives.members.unresolved === true ? ' or a value the analyzer can\'t resolve, which gives nothing' : ''
    const tested =
      alternatives.members.tested === true
        ? ' or a heap-read or once-flag boolean, null or undefined that is never a key'
        : ''
    step('member-alternatives', alternatives.members.node, `${keys.join(', ')}${unresolved}${tested}`)
  }
  return { steps, reasons }
}

/** A native that compiles code from strings, as a call's callee denotes it, with the leaves it was reached from. */
interface NativeCallee {
  name: CodeCallee
  leaves: Leaf[]
  /** For a native reached through an alias, the folds its value comes from: its `alias` steps (§14). */
  folds?: Fold[]
  /** Whether the call is a direct eval (ECMA-262 PerformEval): `eval(…)` through the plain name, not optional. */
  direct: boolean
}

/**
 * The native a call or `new` expression calls, when it compiles code from strings: the global object's `eval`,
 * `setTimeout` or `setInterval`, by name or read from the global object, or the `Function` constructor however it is
 * reached (§5 Global resolution). A name that resolves to a local, or to a top-level function declaration, is no native.
 */
function nativeCallee(
  node: AstNode,
  { analysis, scope, resolution, instance }: SiteContext,
  at: Position,
): NativeCallee | undefined {
  const { global } = analysis
  const call = node.type === 'CallExpression'
  const callee = calleeExpression(node['callee'] as AstNode)
  // Only a callee spelt with one of the natives' names can denote one, so no other call is evaluated.
  const named =
    callee.type === 'Identifier' ? callee : callee.type === 'MemberExpression' ? (callee['property'] as AstNode) : undefined
  if (named === undefined || !(codeCallees as readonly unknown[]).includes(named['name'])) {
    return callee.type === 'Identifier' ? aliasedCallee(node, callee, resolution, at) : undefined
  }

  const holders = resolution.evaluate(callee, at).filter((value): value is HolderValue => value.kind === 'holder')
  if (holders.length === 1 && holders[0]!.holder === 'Function') {
    return { name: 'Function', leaves: inDocumentOrder(holders[0]!.leaves), direct: false }
  }
  if (!call) return undefined
  if (callee.type === 'Identifier') {
    const name = callee['name'] as string
    if (!isGlobalCompiler(name) || !globalHas(analysis, name)) return undefined
    const binding = scope.resolve(callee)
    if (binding === 'local' || binding.declaration?.kind === 'function') return undefined
    const leaf: Leaf = { form: 'global-property', node: callee, name, binding, instance }
    return { name, leaves: [leaf], direct: isEvalCall(node) }
  }
  if (callee.type !== 'MemberExpression' || callee['computed'] === true) return undefined
  const property = callee['property'] as AstNode
  const name = property['name'] as string
  const object = callee['object'] as AstNode
  if (property.type !== 'Identifier' || object.type === 'Super' || !isGlobalCompiler(name) || !globalHas(analysis, name)) {
    return undefined
  }
  const bases = resolution.evaluate(object, at).filter((value): value is HolderValue => value.kind === 'holder')
  if (bases.length !== 1 || bases[0]!.holder !== global) return undefined
  return { name, leaves: inDocumentOrder(bases[0]!.leaves), direct: false }
}

/**
 * The native that compiles code a name aliases (§5 Resolver capabilities 2): `var e = eval; e(s)` is an indirect eval,
 * whose literal code is global nested code, like `(0, eval)(s)`. So is an aliased string timer, and the `Function`
 * constructor. Each alternative that is one counts (Principle 3), the first in source order when there are several.
 */
function aliasedCallee(node: AstNode, id: AstNode, resolution: GlobalResolution, at: Position): NativeCallee | undefined {
  const construct = node.type === 'NewExpression'
  for (const value of resolution.aliasCallee(id, at)) {
    if (value.kind !== 'holder' && value.kind !== 'native') continue
    const leaves = inDocumentOrder(value.leaves)
    const folds = value.folds ?? []
    if (value.kind === 'holder' && value.holder === 'Function') return { name: 'Function', leaves, folds, direct: false }
    // `eval` and the timers are no constructors, so `new` throws.
    if (value.kind === 'native' && !construct && isGlobalCompiler(value.name)) {
      return { name: value.name, leaves, folds, direct: false }
    }
  }
  return undefined
}

/** Whether the realm's global object has the member `name`, its own or inherited, in the unmutated catalog (§4). */
function globalHas({ catalog, targets, global, source }: Analysis, name: string): boolean {
  const holders = catalog.holders[source.realm]
  for (let holder: string | undefined = global; holder !== undefined; holder = holders[holder]?.proto ?? undefined) {
    if (Object.hasOwn(targets, `${holder}.${name}`)) return true
  }
  return false
}

/**
 * The nesting a call that compiles code adds: its note, then how its native callee was reached (§14), and the code
 * `literals` it compiles.
 */
function nestingOf(
  callee: NestedCodeStep['callee'],
  scope: NestedCodeStep['scope'],
  call: AstNode,
  leaves: readonly Leaf[],
  analysis: Analysis,
  literals: readonly AstNode[],
  folds: readonly Fold[] = [],
): Nesting {
  const site = locate(analysis.starts, call.start, call.end)
  const runs =
    scope === 'caller'
      ? `runs in the scope of its caller`
      : callee === 'Function'
        ? `compiles into a function in the global scope`
        : callee === 'eval'
          ? `runs in the global scope`
          : callee === 'script'
            ? `inserts as a script element's text, which runs as a classic script`
            : `compiles as a classic script`
  const note: NestedCodeStep = {
    kind: 'note',
    about: 'nested-code',
    callee,
    scope,
    call: site,
    text:
      callee === 'script'
        ? `the write is in code from a string literal that the call at ${site.line}:${site.column} ${runs}`
        : `the write is in code from a string literal that \`${callee}\` at ${site.line}:${site.column} ${runs}`,
  }
  return joined({ steps: [note], reasons: [], literals }, stepsOf(leaves, analysis), foldSteps(folds, analysis))
}

/**
 * Each leaf's binding step, after those of the leaves it was reached from, and followed by the evidence for the taint on
 * its name's resolution path (§9, §14).
 */
function stepsOf(leaves: readonly Leaf[], { global, source, starts }: Analysis): Nesting {
  const steps = onePerNode(leaves.flatMap(withBase)).map((leaf) => ({
    step: isBindingLeaf(leaf) ? bindingStep(leaf, { global, realm: source.realm, starts }) : catalogHolderStep(leaf, starts),
    taints: leaf.binding === undefined ? [] : taintSteps(leaf.name, leaf.binding, starts),
  }))
  return {
    steps: steps.flatMap(({ step, taints }) => [step, ...taints]),
    reasons: steps.flatMap(({ taints }) => taints.map((step) => step.reason)),
  }
}

/** A leaf of one of the global forms (§5), which a `binding` step records. */
type BindingLeaf = Leaf & { form: GlobalForm }

const isBindingLeaf = (leaf: Leaf): leaf is BindingLeaf => leaf.form !== 'prototype-of'

/** The `catalog-holder` step (§14) of `Object.getPrototypeOf(h)`: the prototype the unmutated catalog gives `h`. */
function catalogHolderStep(leaf: Leaf, starts: Starts): CatalogHolderStep {
  const { node, prototypeOf, holds } = leaf
  const generated = locate(starts, node.start, node.end)
  const expression = printed(node)
  return {
    kind: 'catalog-holder',
    expression,
    generated,
    prototypeOf: prototypeOf!,
    holder: holds!,
    text:
      `\`${expression}\` at ${generated.line}:${generated.column} is the prototype of \`${prototypeOf}\` in the ` +
      `unmutated catalog, \`${holds}\``,
  }
}

/** The `catalog-holder` step (§14) of an own-property test the unmutated catalog decided (§4). */
function ownTestStep(node: AstNode, { tested, member, owns }: OwnTest, starts: Starts): CatalogHolderStep {
  const generated = locate(starts, node.start, node.end)
  const expression = printed(node)
  const at = `${generated.line}:${generated.column}`
  return {
    kind: 'catalog-holder',
    expression,
    generated,
    tested,
    ...(member === undefined ? {} : { member }),
    owns,
    text:
      member === undefined
        ? `\`${expression}\` at ${at} is false in the unmutated catalog: \`${tested}\` owns only structural members`
        : `\`${expression}\` at ${at} is ${String(owns)} in the unmutated catalog: \`${tested}\` ` +
          `${owns ? 'owns' : "doesn't own"} \`${member}\``,
  }
}

/** The `enumeration` step (§14) of a key a member sweep gave (§5 Resolver capabilities 9), with its filters. */
function enumerationStep(node: AstNode, { holder, form, member, filters }: Sweep, starts: Starts): EnumerationStep {
  const generated = locate(starts, node.start, node.end)
  const expression = printed(node)
  const shown = filters.map((filter) => {
    const where = locate(starts, filter.node.start, filter.node.end)
    return { expression: printed(filter.node), generated: where, result: filter.result }
  })
  const through = shown.map(
    ({ expression, generated, result }) =>
      `, ${result === 'kept' ? 'kept by' : 'perhaps kept by'} \`${expression}\` at ${generated.line}:${generated.column}`,
  )
  return {
    kind: 'enumeration',
    expression,
    generated,
    holder,
    enumeration: form,
    member,
    filters: shown,
    text:
      `\`${expression}\` at ${generated.line}:${generated.column} sweeps \`${holder}\` (${form}), and the catalog ` +
      `gives its member \`${member}\`${through.join('')}`,
  }
}

/**
 * The `enumeration` step (§14) of a wildcard whose key starts with a configurable prefix (§5 Pattern wildcards):
 * the key's other alternatives are values the analyzer can't resolve, which give nothing, and the prefix is the
 * literal default the wildcard comes from. None for any other write.
 */
function prefixSteps(write: Write, starts: Starts): Nesting {
  const { pattern, prefixes, configurable, key, holder } = write as Partial<WildWrite> & Write
  const literal = pattern ?? prefixes?.[0]
  if (configurable !== true || literal === undefined || key === undefined) return none
  const generated = locate(starts, key.start, key.end)
  const expression = printed(key)
  const step: EnumerationStep = {
    kind: 'enumeration',
    expression,
    generated,
    holder,
    prefix: literal,
    configurable: true,
    text:
      `\`${expression}\` at ${generated.line}:${generated.column} starts with a configurable prefix whose default is ` +
      `${JSON.stringify(literal)}: its alternatives the analyzer can't resolve give nothing`,
  }
  return { steps: [step], reasons: [] }
}

/**
 * A write's steps with the filters on its path that test a swept key (§5 Resolver capabilities 9) added to each of its
 * `enumeration` steps, after the filters its keys' lists went through: `kept` for a filter the analyzer decided keeps
 * the key, `undecided` for one it can't decide.
 */
function withPathFilters(steps: readonly TraceStep[], tests: ReadonlyMap<AstNode, GuardStep>, starts: Starts): TraceStep[] {
  const filters = [...tests]
    .filter(([test]) => sweepTests.has(test))
    .map(([test, step]) => ({
      expression: printed(test),
      generated: locate(starts, test.start, test.end),
      result: step.class === 'transparent' ? ('kept' as const) : ('undecided' as const),
    }))
  if (filters.length === 0) return [...steps]
  return steps.map((step) => {
    if (step.kind !== 'enumeration' || !('filters' in step)) return step
    const added = filters.map(
      ({ expression, generated, result }) =>
        `, ${result === 'kept' ? 'kept by' : 'perhaps kept by'} \`${expression}\` at ${generated.line}:${generated.column}`,
    )
    return { ...step, filters: [...step.filters, ...filters], text: `${step.text}${added.join('')}` }
  })
}

/**
 * The `guard` steps (§14) of the filters a write's swept keys went through that may have dropped them (§5 Resolver
 * capabilities 9): each `undecided`, so `conditional`, once per filter.
 */
function undecidedFilterSteps(folds: readonly Fold[], starts: Starts): GuardStep[] {
  const nodes = new Set<AstNode>()
  for (const fold of folds) {
    for (const filter of fold.sweep?.filters ?? []) if (filter.result === 'undecided') nodes.add(filter.node)
  }
  return [...nodes].map((node) => {
    const generated = locate(starts, node.start, node.end)
    const expression = printed(node)
    return {
      kind: 'guard',
      expression,
      generated,
      class: 'undecided',
      result: 'conditional',
      text:
        `the sweep filter \`${expression}\` at ${generated.line}:${generated.column} can't be decided on the swept ` +
        'key, so it may keep it: conditional',
    }
  })
}

/** The `catalog-holder` step (§14) of a prototype walk to the first owner the unmutated catalog simulated (§4). */
function walkStep(node: AstNode, { walk, holder, member }: WalkChoice, starts: Starts): CatalogHolderStep {
  const generated = locate(starts, node.start, node.end)
  const expression = printed(node)
  const at = `${generated.line}:${generated.column}`
  const visits = walk.map((each) => `\`${each}\``).join(', ')
  return {
    kind: 'catalog-holder',
    expression,
    generated,
    walk,
    ...(member === undefined ? {} : { member }),
    holder,
    text:
      `the prototype walk at ${at}, simulated on the unmutated catalog, visits ${visits} ` +
      (member === undefined
        ? `and may stop at \`${holder}\`, which may own the member`
        : `and stops at \`${holder}\`, the first that owns \`${member}\``),
  }
}

/**
 * Each fold's `fold` step (§14), once, in the order the write's folds were made, followed by the evidence for the taint
 * on its name's resolution path (§9). A well-known symbol's fold comes after the steps that reached `Symbol`. A fold
 * whose value JSON can't carry (`undefined`, `NaN`) has no step, but its taint still lowers target confidence.
 */
function foldSteps(folds: readonly Fold[], analysis: Analysis): Nesting {
  const { starts } = analysis
  // A call's folds stay apart by what came through it, and its step is one.
  const called = new Set<string>()
  const steps = mergedFolds([], folds).map(({ node, name, value, taint, via, alias, call, catalog, walked, link, sweep }) => {
    if (sweep !== undefined) return { steps: [enumerationStep(node, sweep, starts)], reasons: [] }
    if (catalog !== undefined) return { steps: [ownTestStep(node, catalog, starts)], reasons: [] }
    if (walked !== undefined) return { steps: [walkStep(node, walked, starts)], reasons: [] }
    if (link !== undefined) return { steps: [moduleLinkStep(node, link, analysis)], reasons: [] }
    if (call !== undefined) {
      const key = `${call.site.call.start}:${call.site.fn.start}`
      if (called.has(key)) return { steps: [], reasons: [] }
      called.add(key)
      // A require call that links a module is a module-link hop, whose `module-link` fold stands for it (§6).
      if (analysis.requireLinks.has(call.site.call)) return { steps: [], reasons: [] }
      // The module links the callee came through come before the call (§6).
      const callee = (call.site.links ?? []).map((each) => moduleLinkStep(each.node, each.link, analysis))
      return { steps: [...callee, callStep(call, starts)], reasons: [] }
    }
    const reached = via === undefined ? { steps: [], reasons: [] } : stepsOf(via, analysis)
    const taints = name === undefined || taint === undefined ? [] : taintSteps(name, taint, starts)
    const fold =
      alias === true
        ? [aliasStep(node, name!, starts)]
        : typeof value === 'symbol' || recordable(value)
          ? [foldStep(node, name, value, starts)]
          : []
    return {
      steps: [...reached.steps, ...fold, ...taints],
      reasons: [...reached.reasons, ...taints.map((step) => step.reason)],
    }
  })
  return joined(...steps)
}

/**
 * The innermost function around a write in the walk's tree, out from its site: grafted nested code shares its literal's
 * position, so a position lookup could name a function inside it. The walk can be at a node inside the site, or at a
 * function declaration whose name is the site, which its enclosing scope declares.
 */
function functionAround(ancestors: readonly AstNode[], site: AstNode): AstNode | undefined {
  const at = ancestors.lastIndexOf(site)
  return (at < 0 ? ancestors : ancestors.slice(0, at)).findLast((each) => isFunction(each) && each['id'] !== site)
}

/** What identifies a `creation-site` step: the function, and where its object was made. */
const creationKey = (step: CreationSiteStep): string => `${step.function.start}:${step.generated.start}`

/**
 * The `creation-site` steps (§14) of the function objects a write is instantiated in that no resolved call reaches
 * (§5 Resolver capabilities 3), outermost first: where each was made, and the `this` it was assumed to run with.
 */
function creationSteps(frame: Frame | undefined, starts: Starts): Nesting {
  const found: Frame[] = []
  const seen = new Set<Frame>()
  const pending: Frame[] = frame === undefined ? [] : [frame]
  while (pending.length > 0) {
    const next = pending.shift()!
    if (seen.has(next)) continue
    seen.add(next)
    if (next.how === 'creation') found.push(next)
    if (next.outer !== undefined) pending.push(next.outer)
    for (const { caller } of next.bindings) if (caller !== undefined) pending.push(caller)
  }
  const steps = found.toReversed().map((each): CreationSiteStep => {
    const fn = locate(starts, each.fn.start, each.fn.end)
    const created = each.created ?? each.fn
    const generated = locate(starts, created.start, created.end)
    const receiver = each.receiverNode === undefined ? undefined : printed(each.receiverNode)
    return {
      kind: 'creation-site',
      function: fn,
      generated,
      ...(receiver === undefined ? {} : { this: receiver }),
      text:
        `no resolved call reaches the function at ${fn.line}:${fn.column} made at ${generated.line}:${generated.column}, ` +
        `so it is judged from where it was made` +
        (receiver === undefined ? '' : `, with \`this\` = \`${receiver}\`, the object it is held on`),
    }
  })
  return { steps, reasons: [] }
}

/**
 * The `call` step (§14) of a summarized call: the call, the function it calls, its argument bindings, and the receiver
 * it dispatches through, if it passes one. A class with no constructor of its own takes no parameters.
 */
function callStep({ site, element }: Binding, starts: Starts): CallStep {
  const generated = locate(starts, site.call.start, site.call.end)
  const fn = site.fn
  const callee = printed(site.call['callee'] as AstNode)
  const bindings = ((fn['params'] as AstNode[] | undefined) ?? []).map((param, index) => {
    if (site.iterates !== undefined) return { parameter: printed(param), argument: iteratedArgument(site, element, index) }
    if (site.unlisted === undefined || index < site.unlisted) {
      const arg = site.args[index]
      return { parameter: printed(param), argument: arg === undefined ? null : printed(arg) }
    }
    return { parameter: printed(param), argument: unlistedArgument(site) }
  })
  const receiver = site.receiver === undefined || site.receiver === 'new' || site.receiver === 'none' ? undefined : printed(site.receiver)
  const at = `${generated.line}:${generated.column}`
  const passes = bindings.map(({ parameter, argument }) => `\`${parameter}\` = ${argument === null ? 'nothing' : `\`${argument}\``}`)
  return {
    kind: 'call',
    callee,
    generated,
    function: locate(starts, fn.start, fn.end),
    bindings,
    ...(receiver === undefined ? {} : { this: receiver }),
    text:
      `the call \`${callee}(…)\` at ${at} runs the function with ` +
      (receiver === undefined ? 'its arguments' : `\`this\` = \`${receiver}\`${passes.length === 0 ? '' : ', and its arguments'}`) +
      (passes.length === 0 ? '' : ` bound as ${passes.join(', ')}`),
  }
}

/**
 * What an iteration native passes its callback's parameter `index` in the call that visits `element` (§5 Resolver
 * capabilities 4): the element, printed as the collection indexed, its index, or the collection. `reduce` passes its
 * accumulator first, which is unknown.
 */
function iteratedArgument(site: CallSite, element: number | undefined, index: number): string | null {
  const { native, collection } = site.iterates!
  const reduces = native === 'reduce' || native === 'reduceRight'
  const position = reduces ? index - 1 : index
  const list = printed(collection)
  if (position < 0) return 'accumulator'
  if (element === undefined) return '…'
  return [`${list}[${element}]`, String(element), list][position] ?? null
}

/**
 * What a call passes to a parameter at or past the first argument it can't list: the spread there, in the call or in
 * `.apply`'s array, or else `.apply`'s argument list spread (`...args`). Never null: the call may pass something there.
 */
function unlistedArgument(site: CallSite): string {
  const at = site.args[site.unlisted!]
  if (at !== undefined) return printed(at)
  const list = (site.call['arguments'] as AstNode[]).at(-1)
  if (list === undefined) return '…'
  const element = list.type === 'ArrayExpression' ? (list['elements'] as (AstNode | null)[])[site.unlisted!] : undefined
  if (element !== undefined && element !== null) return printed(element)
  return list.type === 'SpreadElement' ? printed(list) : `...${printed(list)}`
}

/**
 * The `module-link` step (§6, §14) of a module-link hop at `node`: a require call, a module's thunk, getter or interop
 * wrapper call, or an export's getter or value.
 */
function moduleLinkStep(node: AstNode, link: ModuleLink, { source, starts }: Analysis): ModuleLinkStep {
  const generated = locate(starts, node.start, node.end)
  const at = `${generated.line}:${generated.column}`
  return {
    kind: 'module-link',
    idiom: link.idiom,
    module: link.module,
    ...(link.export === undefined ? {} : { export: link.export }),
    artifact: source.url,
    generated,
    text:
      link.export === undefined
        ? `via module ${link.module}, which the ${link.idiom === 'factory-table' ? 'require call' : 'call'} at ${at} runs (${link.idiom})`
        : `via module ${link.module} export \`${link.export}\` at ${at} (${link.idiom})`,
  }
}

/** The `alias` step (§14) of a value read through the variable `name`, from its definition `site`. */
function aliasStep(site: AstNode, name: string, starts: Starts): AliasStep {
  const generated = locate(starts, site.start, site.end)
  const expression = printed(site)
  return {
    kind: 'alias',
    name,
    expression,
    generated,
    text: `\`${name}\` is read from its definition \`${expression}\` at ${generated.line}:${generated.column}`,
  }
}

function foldStep(
  node: AstNode,
  name: string | undefined,
  value: string | number | boolean | null | symbol,
  starts: Starts,
): FoldStep {
  const generated = locate(starts, node.start, node.end)
  const expression = printed(node)
  const at = `${generated.line}:${generated.column}`
  const constant =
    typeof value === 'symbol'
      ? `the well-known symbol ${symbolMember(value)}`
      : typeof value === 'string'
        ? JSON.stringify(value)
        : String(value)
  const text =
    name === undefined
      ? `\`${expression}\` at ${at} folds to ${constant}`
      : `\`${name}\` is a \`const\` whose value \`${expression}\` at ${at} folds to ${constant}`
  const folded = typeof value === 'symbol' ? { symbol: symbolMember(value) } : { value }
  return { kind: 'fold', ...(name === undefined ? {} : { name }), expression, generated, ...folded, text }
}

/**
 * A leaf, after the leaves the value it steps from was reached from (`window` before `window.parent`), and for
 * `Object.getPrototypeOf(h)`, after the leaves of `Object` and then of `h`.
 */
function withBase(leaf: Leaf): Leaf[] {
  return [...(leaf.callee ?? []).flatMap(withBase), ...(leaf.base ?? []).flatMap(withBase), leaf]
}

function joined(...nestings: Nesting[]): Nesting {
  const literals = nestings.find((nesting) => nesting.literals !== undefined)?.literals
  return {
    steps: nestings.flatMap((nesting) => nesting.steps),
    reasons: nestings.flatMap((nesting) => nesting.reasons),
    ...(literals === undefined ? {} : { literals }),
  }
}

/**
 * Where attribution looks a write up (§10 lookup point): its member token or holder argument, or for a write in nested
 * code, the start of the code literal in the host artifact's own code that it is in, with no token: the host's map
 * maps the literal as one token.
 */
function lookupOf(
  write: Write,
  { literals }: Nesting,
  starts: GroupLines,
  resolution: GlobalResolution,
  artifact: LinesMember,
): RawOccurrence['lookup'] {
  if (literals === undefined) {
    const helper = helperLookup(write, starts, resolution, artifact)
    if (helper !== undefined) return helper
    const { node, token } = write.lookup
    return { generated: locate(starts, node.start, node.end), token }
  }
  const { start } = write.site
  const literal = literals.find((each) => each.start <= start && start < each.end) ?? literals[0]!
  return { generated: locate(starts, literal.start, literal.end), token: null }
}

/**
 * For a write inside a helper, the outermost call on the chain whose arguments carry both the holder and the member
 * (§10): the holder written came through the call, and the member is the key one of its arguments is, which came
 * through it too, or the key folds part of it (`o['set' + n]`), looked up at the call with no token. A write with
 * no member needs only the holder. Its token is the member's key when the call writes it
 * as a string or a template with no substitutions. Undefined when no call carries both, so the write itself is looked
 * up. The calls a value came through are its `call` folds, outermost first.
 */
function helperLookup(
  write: Write,
  starts: GroupLines,
  resolution: GlobalResolution,
  artifact: LinesMember,
): RawOccurrence['lookup'] | undefined {
  const { holder, member } = write.parts
  // The lookup crosses artifacts only within the write artifact's origin: a call in another member of the group
  // counts when that member has the write's origin, and the lookup then names it.
  const lookup = (node: AstNode, token: string | null): RawOccurrence['lookup'] => {
    const generated = locate(starts, node.start, node.end)
    const at = starts.artifactOf(generated)!
    return at.url === artifact.url ? { generated, token } : { artifact: at.url, generated, token }
  }
  const sameOrigin = (node: AstNode) => {
    const at = starts.memberAt(node.start)
    return at.url === artifact.url || (at.origin !== undefined && at.origin === artifact.origin)
  }
  // The argument each call passed the member in through.
  const through = new Map(member.flatMap((fold) => (fold.call === undefined ? [] : [[fold.node, fold.argument] as const])))
  const key = write.change.kind === 'prototype' ? undefined : write.change.member
  for (const fold of holder) {
    if (fold.call === undefined) continue
    const { site } = fold.call
    if (!sameOrigin(site.call)) continue
    let token: string | null = null
    if (key !== undefined) {
      const index = through.get(site.call)
      if (index === undefined || !resolution.argumentCarries(fold.call, index, key, member)) continue
      // A member read through heap fields is looked up at the string literal in the call's arguments that supplies it,
      // with that token, and at the call with no token when the call doesn't write it.
      const arg = site.args[index]!
      const literal = member.find(
        (each) => each.heap === true && arg.start <= each.node.start && each.node.end <= arg.end && writtenKey(each.node) === key,
      )
      if (literal !== undefined) return lookup(literal.node, key as string)
      token = typeof key === 'string' && writtenIn(arg, key) ? key : null
    }
    return lookup(site.call, token)
  }
  return undefined
}

/**
 * Whether the member's key is written in an argument as a string or a template with no substitutions: the argument
 * itself, or an element of an array literal it is.
 */
function writtenIn(arg: AstNode, key: string): boolean {
  if (writtenKey(arg) === key) return true
  if (arg.type !== 'ArrayExpression') return false
  return (arg['elements'] as (AstNode | null)[]).some((element) => element !== null && writtenIn(element, key))
}

/** A key written as a string literal or a template literal with no substitutions. */
function writtenKey(node: AstNode): string | undefined {
  if (node.type === 'Literal') return typeof node['value'] === 'string' ? node['value'] : undefined
  if (node.type !== 'TemplateLiteral' || (node['expressions'] as AstNode[]).length > 0) return undefined
  return ((node['quasis'] as AstNode[])[0]!['value'] as { cooked: string | null }).cooked ?? undefined
}

/**
 * An `analysis-budget` limitation (§13, §18) for a call that a recursion or context cap widened or merged while it
 * carries the global object, a native holder or a native member (Principle 5): one for each call.
 */
function callCut(analysis: Analysis, site: AstNode, why: 'recursion' | 'contexts'): void {
  const { source, starts, callsCut } = analysis
  if (callsCut.has(site)) return
  callsCut.add(site)
  const location = locate(starts, site.start, site.end)
  const cap =
    why === 'recursion'
      ? 'it recurses or lies past the call-depth cap, so its function ran in a widened frame'
      : 'the context cap merged it with other calls of its function'
  analysis.output.limitations.push({
    kind: 'analysis-budget',
    artifact: { url: source.url, hash: source.hash },
    location,
    detail: `the call \`${printed(site['callee'] as AstNode)}(…)\` at ${location.line}:${location.column} carries a native, and ${cap}`,
  })
}

/**
 * An `analysis-budget` limitation (§13, §18) for a loop, or an iteration native's call, that the iteration cap cut while
 * it writes the global object or a native holder (Principle 5): one for each loop. The iterations done keep their
 * findings.
 */
function loopCut(analysis: Analysis, loop: AstNode): void {
  const { source, starts, loopsCut } = analysis
  if (loopsCut.has(loop)) return
  loopsCut.add(loop)
  const location = locate(starts, loop.start, loop.end)
  const what = isLoop(loop) ? 'the loop' : `the call \`${printed(loop['callee'] as AstNode)}(…)\``
  analysis.output.limitations.push({
    kind: 'analysis-budget',
    artifact: { url: source.url, hash: source.hash },
    location,
    detail:
      `${what} at ${location.line}:${location.column} writes a native, and runs past the iteration cap of ` +
      `${analysis.caps.iterations} iterations, so the iterations after it are not analyzed`,
  })
}

/** Whether a value could be a string: unknown, or a string constant. */
const maybeString = (value: Value): boolean => opaque(value) || isString(value)
const isString = (value: Value): boolean => value.kind === 'constant' && typeof value.value === 'string'

/** Whether an expression plainly makes a string: a template literal, or a `+` with a string operand. */
function stringValued(node: AstNode): boolean {
  if (node.type === 'TemplateLiteral') return true
  if (node.type === 'Literal') return typeof node['value'] === 'string'
  if (node.type !== 'BinaryExpression' || node['operator'] !== '+') return false
  return stringValued(node['left'] as AstNode) || stringValued(node['right'] as AstNode)
}

/** A bigint literal, whose value ToString converts to its decimal digits. */
const isBigIntLiteral = (node: AstNode): boolean => node.type === 'Literal' && typeof node['value'] === 'bigint'

/** A number, boolean or null literal. */
function isPrimitiveLiteral(node: AstNode): boolean {
  if (node.type !== 'Literal') return false
  const value = node['value']
  return value === null || typeof value === 'number' || typeof value === 'boolean'
}

/**
 * Whether `node`, a child of `parent`, gets its own `this`: a non-arrow function, a class field's initializer or a
 * static block. A class's `extends` clause and computed keys, and arrow functions, see the `this` around them.
 */
function isThisBoundary(node: AstNode, parent: AstNode): boolean {
  if (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'StaticBlock') return true
  return (parent.type === 'PropertyDefinition' || parent.type === 'AccessorProperty') && parent['value'] === node
}

/** The `binding` trace step (§14) for a leaf a write reached its holder from: how its name resolved, and its form. */
function bindingStep(leaf: BindingLeaf, context: { global: string; realm: Realm; starts: Starts }): BindingStep {
  const { global, realm, starts } = context
  const { name, form, holds, path } = leaf
  const alias = form !== 'global-property'
  // A singleton step is an alias of the singleton; the other alias forms are aliases of the global object.
  const aliasOf = form === 'singleton' ? holds : global
  const declared = leaf.binding?.declaration
  const declaration = declared && { kind: declared.kind, generated: locate(starts, declared.node.start, declared.node.end) }
  const chain = leaf.chain && locate(starts, leaf.chain.start, leaf.chain.end)
  const selected =
    chain === undefined ? '' : `, selected through the \`${chainOperator(leaf.chain!)}\` chain at ${chain.line}:${chain.column}`
  return {
    kind: 'binding',
    name,
    resolution: declaration !== undefined ? 'declaration' : alias ? 'alias' : 'global',
    form,
    ...(alias ? { aliasOf } : {}),
    ...(holds === undefined || alias ? {} : { holds }),
    ...(path === undefined ? {} : { path }),
    ...(declaration === undefined ? {} : { declaration }),
    ...(chain === undefined ? {} : { chain }),
    realm,
    realmInstance: leaf.instance,
    text: `${recognized(leaf, global, declaration, starts)}${selected} (${realm} realm, ${leaf.instance} instance)`,
  }
}

/** How a leaf's form reaches its holder, as a sentence without the realm. */
function recognized(
  leaf: BindingLeaf,
  global: string,
  declaration: BindingStep['declaration'],
  starts: Starts,
): string {
  const { name } = leaf
  const resolves =
    declaration === undefined
      ? `\`${name}\` resolves to no declaration`
      : `\`${name}\` resolves to the ${declarationKinds[declaration.kind]} at ${declaration.generated.line}:` +
        `${declaration.generated.column}, which ${lexicalKinds.has(declaration.kind) ? "hides the global object's property from bare-name callers" : "binds the global object's property"}`
  const globalObject = `the global object ${global}`
  switch (leaf.form) {
    case 'global-property': {
      const holds = leaf.holds === undefined ? '' : `, which holds the native \`${leaf.holds}\``
      return `${resolves}, so it is the global property ${global}.${name}${holds}`
    }
    case 'global-name':
      return `${resolves}, so it is ${globalObject}`
    case 'guarded-global': {
      const guard = locate(starts, leaf.guard!.start, leaf.guard!.end)
      const at = `${guard.line}:${guard.column}`
      return `${resolves} and the \`typeof global\` test at ${at} shows it is defined, so it is ${globalObject}`
    }
    case 'top-level-this':
      return `\`this\` at the top level of a classic script is ${globalObject}`
    case 'sloppy-this':
      return `\`this\` in a sloppy function called without a \`this\`, or with \`null\` or \`undefined\`, is ${globalObject}`
    case 'function-return-this':
      // Through another window's `Function`, after the steps that reached that window.
      if (leaf.base !== undefined) {
        return (
          `\`Function('return this')()\` through that window's \`Function\` calls a new sloppy function without a ` +
          `\`this\`, which returns that window's global object ${global}`
        )
      }
      return (
        `${resolves}, and \`Function('return this')()\` through it calls a new sloppy function without a \`this\`, ` +
        `which returns ${globalObject}`
      )
    case 'singleton': {
      const through = leaf.path === leaf.holds ? '' : ` through the alias \`${leaf.path}\``
      return `\`.${name}\` of that object is the platform singleton \`${leaf.holds}\`${through}`
    }
    case 'other-window': {
      const window = otherWindows[leaf.instance]
      if (leaf.binding !== undefined) return `${resolves}, so it is the global property ${global}.${name}, which is ${window}`
      if (leaf.base === undefined) return `\`.${name}\` on any object is a window, and which window is unknown`
      // The code's own `document.defaultView` is its own window.
      if (name === 'defaultView') return `\`.${name}\` of that document is the window it belongs to, ${window}`
      // An index read (`[0]`) on a window is a child window.
      if (name.startsWith('[')) return `the index read \`${name}\` on that window is a child window, ${window}`
      return `\`.${name}\` of that window is ${window}`
    }
  }
}

/** The operator of a chain: `?:`, `||`, `&&` or `??`. */
function chainOperator(chain: AstNode): string {
  return chain.type === 'ConditionalExpression' ? '?:' : (chain['operator'] as string)
}

/** The `with` statements and direct `eval` calls the taint steps of a trace locate, each once, in document order. */
function taintSites(steps: readonly TraceStep[]): GeneratedLocation[] {
  const sites = new Map<number, GeneratedLocation>()
  for (const step of steps) {
    if (step.kind !== 'confidence-reason' || (step.reason !== 'with-scope' && step.reason !== 'direct-eval-scope')) continue
    for (const site of step.sites ?? []) sites.set(site.start, site)
  }
  return [...sites.values()].sort((a, b) => a.start - b.start)
}

/**
 * The `confidence-reason` steps (§14) for the taint on a name's resolution path (§5 post-pass 3), in §9's order:
 * `direct-eval-scope` when a direct `eval` could declare a `var` that shadows the name, and `with-scope` when a `with`
 * block could redirect it to an object property.
 */
function taintSteps(
  name: string,
  taint: Taint,
  starts: Starts,
): (ConfidenceReasonStep & { reason: 'direct-eval-scope' | 'with-scope' })[] {
  const taints = [
    {
      reason: 'direct-eval-scope' as const,
      nodes: taint.evals,
      what: 'a direct `eval` in sloppy code',
      could: 'declare a `var` that shadows it',
    },
    { reason: 'with-scope' as const, nodes: taint.withs, what: 'a `with` block', could: 'redirect it to an object property' },
  ]
  return taints
    .filter(({ nodes }) => nodes.length > 0)
    .map(({ reason, nodes, what, could }) => {
      const sites = nodes.map((site) => locate(starts, site.start, site.end))
      const at = sites.map(({ line, column }) => `${line}:${column}`).join(', ')
      return {
        kind: 'confidence-reason',
        dimension: 'target',
        reason,
        level: targetReasons[reason],
        name,
        sites,
        text: `${what} on the resolution path of \`${name}\` (at ${at}) could ${could}`,
      }
    })
}

/** The `outcome` step (§14) of an ineffective write (§3): why it can't change its target, and whether it throws. */
function outcomeStep({ name, reason, throws, mayChangeNothing }: Ineffective): OutcomeStep {
  const why = ineffectiveWording[reason]
  const throwing = throwsWording[throws]
  const noOp = mayChangeNothing ? `, or it changes nothing, on a value the analyzer can't see` : ''
  return {
    kind: 'outcome',
    result: 'ineffective',
    reason,
    throws,
    mayChangeNothing,
    text: `the write can't change ${name}, ${why}${noOp}: an ineffective write, which ${throwing}`,
  }
}

const ineffectiveWording: Readonly<Record<Ineffective['reason'], string>> = {
  readonly: 'an accessor without a setter',
  'lenient-setter': 'whose [LegacyLenientSetter] setter does nothing',
  'non-writable': 'a non-writable data property',
  'non-configurable': 'a non-configurable property',
  'immutable-prototype': 'whose object is an immutable prototype exotic object',
}

const throwsWording: Readonly<Record<Ineffective['throws'], string>> = {
  always: 'throws in sloppy and strict code alike',
  'strict-only': 'throws only in strict code',
  never: 'never throws',
}

/**
 * The `confidence-reason` step (§14) for `outcome-undecidable` (§9): what the outcome depends on and the analyzer can't
 * see or decide (§3 Undecidable outcomes), in source order. That is the parts of a define's descriptor, the object a
 * `Reflect.set` looks its member up on, or the value an assign of `Window.opener` writes, which may be `null`.
 */
function undecidableStep(
  name: string,
  { on, sites: parts }: NonNullable<Mutation['undecidable']>,
  starts: Starts,
): ConfidenceReasonStep & { reason: 'outcome-undecidable' } {
  const sites = parts.map((part) => locate(starts, part.start, part.end))
  const at = sites.map(({ line, column }) => `${line}:${column}`).join(', ')
  const why = {
    descriptor: `the define's descriptor has parts the analyzer can't see or decide (at ${at})`,
    lookup: `the object \`Reflect.set\` looks the member up on doesn't resolve (at ${at})`,
    value: `the value written may be \`null\`, which the setter doesn't replace the member with (at ${at})`,
  }[on]
  return {
    kind: 'confidence-reason',
    dimension: 'mutation',
    reason: 'outcome-undecidable',
    level: mutationReasons['outcome-undecidable'],
    sites,
    text: `${why}, so whether it changes \`${name}\` can't be decided`,
  }
}

/** The window another window's step reaches, by its realm instance. */
const otherWindows: Record<RealmInstance, string> = {
  current: 'this window',
  other: 'another window',
  unknown: 'a window, and which window is unknown',
}

/** The declarations that bind no property of the global object, but hide it from bare-name callers (§3). */
const lexicalKinds: ReadonlySet<GlobalDeclarationKind> = new Set(['let', 'const', 'class'])

const declarationKinds: Record<GlobalDeclarationKind, string> = {
  var: "classic script's top-level `var`",
  function: "classic script's top-level function declaration",
  'block-function': 'block-level function that Annex B hoists to the global object',
  let: "classic script's top-level `let`",
  const: "classic script's top-level `const`",
  class: "classic script's top-level class declaration",
}

/**
 * What a group's realm adds to every write in it (§9, §14): nothing when the realm comes from how the group's entry was
 * referenced, and `realm-assumed` with its evidence when only the sweep found the entry, so its realm is assumed (§2).
 */
function realmOf({ realm, realmBasis }: AnalyzeGroupInput['entry']): Nesting {
  if (realmBasis === 'reference') return none
  const step: ConfidenceReasonStep = {
    kind: 'confidence-reason',
    dimension: 'target',
    reason: 'realm-assumed',
    level: targetReasons['realm-assumed'],
    text: `only the build-directory sweep found the artifact, so its realm is assumed to be ${realm}`,
  }
  return { steps: [step], reasons: ['realm-assumed'] }
}

/** The `guard` steps of `steps` that `shown` doesn't already show, each once: the same guard at the same place. */
function unique(steps: readonly GuardStep[], shown: readonly (GuardStep | CreationSiteStep)[]): GuardStep[] {
  const out: GuardStep[] = []
  const key = (step: GuardStep) => `${step.generated.start}:${step.generated.end}:${step.class}`
  const seen = new Set(shown.flatMap((step) => (step.kind === 'guard' ? [key(step)] : [])))
  for (const step of steps) {
    if (seen.has(key(step))) continue
    seen.add(key(step))
    out.push(step)
  }
  return out
}

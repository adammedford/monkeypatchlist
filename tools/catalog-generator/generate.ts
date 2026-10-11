import {
  ecmascriptSpecs,
  realms,
  type Realm,
  type RemoteUrlNormalization,
  type SerializedCatalog,
  type Singleton,
} from '../../src/catalog.ts'
import { canonicalJson } from './canonical-json.ts'
import { applyEnginePrototypes, refuseEnginePrototypeMembers, type EnginePrototypesOverlay } from './engine-prototypes.ts'
import { applyExclusions, type ExclusionsOverlay } from './exclusions.ts'
import { applyProseMembers, type ProseMembersOverlay } from './prose-members.ts'
import { resolveProtectedSurface, type ProtectedSurfaceOverlay } from './protected-surface.ts'
import { buildIntrinsics, type EcmascriptSources } from './intrinsics.ts'
import { noNormalization } from './remote-url-normalization.ts'
import type { EscapeOnlyShapesOverlay, FrameworkPathRulesOverlay } from './path-rules.ts'
import { applyRetained, refuseLosses, type RetainedOverlay } from './retained.ts'
import { placeSingletons, type SingletonsOverlay } from './singletons.ts'
import { assignSurfaces, type SurfacesOverlay } from './surfaces.ts'
import { buildCatalog } from './targets.ts'
import { signOffLines, targetDiff } from './target-diff.ts'

/** The upstream packages the catalog is generated from. Each is exact-pinned, and the catalog metadata records it. */
export const upstreamPackages = ['@webref/idl', 'webidl2', '@tc39/ecma262-biblio', '@tc39/ecma402-biblio'] as const

/** The exact version of each upstream package a generation read. */
export type Upstream = Partial<Record<(typeof upstreamPackages)[number], string>>

/** The pinned inputs a generation reads. */
export interface Sources {
  /** IDL text by spec shortname, as `@webref/idl` lists it. */
  idl: Readonly<Record<string, string>>
  /** The ECMAScript intrinsics' sources. A generation without them has Web IDL targets only. */
  ecmascript?: EcmascriptSources | undefined
  /** The platform singletons overlay. A generation without it has no singletons. */
  singletons?: SingletonsOverlay | undefined
  /**
   * The engine-prototypes overlay: prototype holders an engine puts on a singleton's chain where Web IDL has none. A
   * generation without it has none.
   */
  enginePrototypes?: EnginePrototypesOverlay | undefined
  /** The overlay of members a spec defines in prose on each instance. A generation without it has none. */
  proseMembers?: ProseMembersOverlay | undefined
  /** The exclusions overlay. A generation without it excludes nothing. */
  exclusions?: ExclusionsOverlay | undefined
  /** The owner → surface map. A generation without it gives every member but the ECMAScript ones surface `other`. */
  surfaces?: SurfacesOverlay | undefined
  /** The protected-surface list. A generation without it protects nothing. */
  protectedSurface?: ProtectedSurfaceOverlay | undefined
  /** The retained overlay: targets upstream removed that the catalog keeps, and deliberate drops. */
  retained?: RetainedOverlay | undefined
  /** The remote URL normalization rules (§11). A generation without them leaves remote URLs as they are. */
  remoteUrlNormalization?: RemoteUrlNormalization | undefined
  /** The framework path rules (§10). A generation without them has none. */
  frameworkPathRules?: FrameworkPathRulesOverlay | undefined
  /** The escape-only shapes (§10). A generation without them has none. */
  escapeOnlyShapes?: EscapeOnlyShapesOverlay | undefined
  upstream: Upstream
  /** The catalog version (§4 Catalog versions), which the metadata records. */
  catalogVersion?: number | undefined
  /** A pin of each overlay file the generation read: the sha256 of its bytes, by file name. */
  overlays?: Readonly<Record<string, string>> | undefined
}

export interface GeneratedFiles {
  /** `catalog/catalog.json` */
  catalog: string
  /** `catalog/target-diff.md` */
  targetDiff: string
}

/**
 * Generates the catalog and its target diff. `previous` is the last committed generation: the diff lists the targets
 * added and removed since it, and an unchanged catalog keeps its diff, so a rerun writes the same bytes. Refuses a
 * generation that loses a target `previous` had, unless the retained overlay drops it or an exclusion removes it.
 */
export function generate(input: Sources & { previous?: GeneratedFiles | undefined }): GeneratedFiles {
  const { catalogVersion, upstream, overlays, previous } = input
  const metadata = { catalogVersion, upstream: { ...upstream }, overlays: { ...overlays } }
  const sections = buildNative(input)
  if (previous) refuseLosses(previous.catalog, sections)
  const text = canonicalJson({ metadata, ...sections })
  if (previous?.catalog === text) return { catalog: text, targetDiff: previous.targetDiff }
  return { catalog: text, targetDiff: targetDiff(previous?.catalog, text) }
}

/**
 * The Web IDL sections and, from their sources, the ECMAScript intrinsics and their holders, per realm; with the
 * members specs define in prose on each instance of an interface; less the exclusions; then the platform singletons
 * and their alias groups; then the engine prototypes on their chains; then the retained targets and holders upstream
 * removed; then every member's surface, from the owner → surface map; and last the protected-surface list, resolved to
 * the targets it names. The framework path rules and escape-only shapes are copied as they are. The Web IDL prototype chains end in the intrinsics (`EventTarget.prototype` →
 * `Object.prototype`), so with the intrinsics every `proto` names a holder of the same realm. A retained target whose
 * spec is ECMA-262, ECMA-402, an ES addition's or an engine extension's is an ECMAScript target like any other.
 */
function buildNative(sources: Sources): Omit<SerializedCatalog, 'metadata'> {
  const { idl, ecmascript, singletons: overlay, exclusions: excluded = {} } = sources
  const { surfaces: surfaceMap = { owners: {}, members: {} }, protectedSurface: list = {} } = sources
  const { attributeTypes, ...sections } = buildCatalog(idl)
  const { targets, holders } = sections
  const ecmascriptTargets = Object.fromEntries(realms.map((realm) => [realm, new Set<string>()])) as Record<
    Realm,
    Set<string>
  >
  if (ecmascript) {
    const intrinsics = buildIntrinsics(ecmascript, globalsOf(holders))
    for (const realm of realms) {
      for (const [name, target] of Object.entries(intrinsics.targets[realm])) {
        ecmascriptTargets[realm].add(name)
        if (Object.hasOwn(targets[realm], name)) {
          throw new Error(`${name} is both a Web IDL target and an ECMAScript intrinsic (${realm})`)
        }
        targets[realm][name] = target
      }
      for (const [name, holder] of Object.entries(intrinsics.holders[realm])) {
        if (Object.hasOwn(holders[realm], name)) {
          throw new Error(`${name} is both a Web IDL holder and an ECMAScript intrinsic (${realm})`)
        }
        holders[realm][name] = holder
      }
    }
  }
  const proseMembers = structuredClone({ ...sources.proseMembers })
  applyProseMembers(sections, proseMembers)
  const exclusions = applyExclusions(sections, excluded)
  const { singletons, aliasGroups } = overlay
    ? placeSingletons(sections, attributeTypes, overlay, globalsOf(holders))
    : { singletons: emptyPerRealm<Singleton>(), aliasGroups: emptyPerRealm<string[]>() }
  const enginePrototypes = structuredClone({ ...sources.enginePrototypes })
  applyEnginePrototypes(sections, enginePrototypes, globalsOf(holders))
  const retained = applyRetained(sections, sources.retained ?? noneRetained, new Set(Object.keys(exclusions)))
  refuseEnginePrototypeMembers(sections, enginePrototypes, globalsOf(holders))
  const specs = ecmascriptSpecs({ esAdditions: ecmascript?.additions, engineExtensions: ecmascript?.engineExtensions })
  for (const realm of realms) {
    for (const name of Object.keys(retained.targets[realm])) {
      if (specs.has(targets[realm][name]?.spec ?? '')) ecmascriptTargets[realm].add(name)
    }
  }
  if (ecmascript) {
    for (const realm of realms) {
      for (const [name, { proto }] of Object.entries(holders[realm])) {
        if (proto !== null && !Object.hasOwn(holders[realm], proto)) {
          throw new Error(`the prototype of ${name}, ${proto}, is not a holder in ${realm}`)
        }
      }
    }
  }
  const surfaced = assignSurfaces(sections, surfaceMap, ecmascriptTargets)
  const protectedSurface = resolveProtectedSurface({ ...surfaced, holders }, list)
  const esAdditions = structuredClone({ ...ecmascript?.additions })
  const engineExtensions = structuredClone({ ...ecmascript?.engineExtensions })
  const esProseProperties = structuredClone({ ...ecmascript?.proseProperties })
  return {
    ...sections,
    ...surfaced,
    esAdditions,
    engineExtensions,
    esProseProperties,
    enginePrototypes,
    proseMembers,
    singletons,
    aliasGroups,
    exclusions,
    surfaceMap: structuredClone(surfaceMap),
    protectedSurface,
    retained,
    remoteUrlNormalization: structuredClone(sources.remoteUrlNormalization ?? noNormalization),
    frameworkPathRules: structuredClone({ ...sources.frameworkPathRules }),
    escapeOnlyShapes: structuredClone({ ...sources.escapeOnlyShapes }),
  }
}

const noneRetained: RetainedOverlay = { targets: {}, holders: {}, dropped: {} }

function emptyPerRealm<T>(): Record<Realm, Record<string, T>> {
  return Object.fromEntries(realms.map((realm) => [realm, {}])) as Record<Realm, Record<string, T>>
}

/** The name of each realm's global object: its one `global` holder, e.g. `Window`, `DedicatedWorkerGlobalScope`. */
function globalsOf(holders: SerializedCatalog['holders']): Record<Realm, string> {
  return Object.fromEntries(
    realms.map((realm) => {
      const globals = Object.keys(holders[realm]).filter((name) => holders[realm][name]?.kind === 'global')
      if (globals.length !== 1) throw new Error(`the ${realm} realm has ${globals.length} global objects, not one`)
      return [realm, globals[0]]
    }),
  ) as Record<Realm, string>
}

/** Who signed off each line of the target diff that needs it (§4 Bump review), by the line as the diff marks it. */
export type SignOff = Readonly<Record<string, string>>

/**
 * The CI drift check (§4 Bump review). `base` is the catalog the committed diff's From line names, or undefined when
 * it names none. Returns one message per problem:
 * - the committed catalog must equal a fresh generation, and lose no target or holder `base` had (the catalog is
 *   monotonic, holders too)
 * - the committed target diff must be exactly the diff from `base` to the committed catalog, so a hand-edited list fails
 * - each line the diff marks for sign-off needs a signer in `signOff`, and `signOff` signs off no other line
 */
export function check(
  input: Sources & { committed: GeneratedFiles; base: string | undefined; signOff?: SignOff | undefined },
): string[] {
  const { committed, base, signOff = {} } = input
  const problems: string[] = []
  const rerun = 'Run `npm run catalog` and commit the result.'
  try {
    const fresh = generate({ ...input, previous: base === undefined ? undefined : { catalog: base, targetDiff: '' } })
    if (fresh.catalog !== committed.catalog) {
      problems.push(`catalog/catalog.json differs from a fresh generation. ${rerun}`)
    }
  } catch (error) {
    problems.push((error as Error).message)
  }
  const diff = targetDiff(base, committed.catalog)
  if (diff !== committed.targetDiff) {
    problems.push(`catalog/target-diff.md is not the diff from the catalog it names to catalog/catalog.json. ${rerun}`)
  }
  const marked = signOffLines(diff)
  const unsigned = marked.filter((line) => !signOff[line]?.trim())
  if (unsigned.length) {
    const lines = unsigned.length === 1 ? '1 line' : `${unsigned.length} lines`
    const need = unsigned.length === 1 ? 'needs' : 'need'
    const entries = JSON.stringify(Object.fromEntries(unsigned.map((line) => [line, ''])), null, 2)
    problems.push(
      `${lines} of catalog/target-diff.md ${need} explicit sign-off (§4 Bump review). A reviewer adds each to ` +
        `catalog/sign-off.json with their name:\n${entries}`,
    )
  }
  for (const line of Object.keys(signOff).filter((line) => !marked.includes(line))) {
    problems.push(
      `catalog/sign-off.json signs off a line catalog/target-diff.md does not mark: ${line}. Remove it; ` +
        '`npm run catalog` removes such lines.',
    )
  }
  return problems
}

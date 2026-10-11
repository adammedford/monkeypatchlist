import type * as WebIDL2 from 'webidl2'
import { realms, type Realm } from '../../src/catalog.ts'

/** The global name each realm's global interface declares in `[Global]` (§4). */
const realmGlobalNames: Record<Realm, string> = {
  window: 'Window',
  'dedicated-worker': 'DedicatedWorker',
  'shared-worker': 'SharedWorker',
  'service-worker': 'ServiceWorker',
}

/** A Web IDL exposure set: global names, or `*` for every global. */
type ExposureSet = '*' | ReadonlySet<string>

interface Construct {
  extAttrs: WebIDL2.ExtendedAttribute[]
}

/** An interface, interface mixin, namespace or callback interface, or a partial of one, with the spec declaring it. */
export interface Definition {
  definition: Construct & {
    type: string
    name: string
    partial: boolean
    members: (Construct & { name?: string | null })[]
  }
  spec: string
}

/** Where a member is declared, which is what its exposure set depends on. */
export interface Declaration {
  member: Construct
  /** The definition the member appears in: an interface, mixin or namespace, or a partial of one. */
  declaredOn: Construct & { name: string; partial: boolean }
  /** For a mixin member, the interface that includes the mixin. */
  host?: Construct | undefined
}

/**
 * Runs the Web IDL exposure-set algorithm and maps exposure sets to the four realms (§4). A realm is in an exposure set
 * when the set names one of the global names of the realm's global interface, so `Worker` reaches every worker realm.
 * Globals that map to no realm, such as worklets, expose nothing to the catalog.
 */
export class Exposure {
  readonly #realmGlobalNames: ReadonlyMap<Realm, ReadonlySet<string>>
  readonly #realmGlobals: ReadonlyMap<Realm, string>
  /** The original (non-partial) definitions, by name, that a partial's members fall back to. */
  readonly #originals: ReadonlyMap<string, Construct>

  /**
   * Reads the global names that the `[Global]` interfaces declare. Refuses IDL that declares no global for one of the
   * four realms, or an `[Exposed]` that names no global.
   */
  constructor(definitions: readonly Definition[]) {
    const globals = definitions.flatMap(({ definition }) => {
      const global = definition.extAttrs.find(({ name }) => name === 'Global')
      const set = global && names(global)
      return set && set !== '*' ? [{ interfaceName: definition.name, set }] : []
    })
    const realmGlobalNamesFound = new Map<Realm, ReadonlySet<string>>()
    const realmGlobals = new Map<Realm, string>()
    for (const realm of realms) {
      const found = globals.find(({ set }) => set.has(realmGlobalNames[realm]))
      if (!found) {
        throw new Error(`no interface declares [Global=${realmGlobalNames[realm]}], so the ${realm} realm has no global`)
      }
      realmGlobalNamesFound.set(realm, found.set)
      realmGlobals.set(realm, found.interfaceName)
    }
    this.#realmGlobalNames = realmGlobalNamesFound
    this.#realmGlobals = realmGlobals
    this.#originals = new Map(
      definitions.filter(({ definition }) => !definition.partial).map(({ definition }) => [definition.name, definition]),
    )

    const declared = new Set(globals.flatMap(({ set }) => [...set]))
    for (const { definition, spec } of definitions) {
      const label = `${definition.partial ? 'partial ' : ''}${definition.type} ${definition.name} (${spec})`
      checkExposed(definition, label, declared)
      for (const member of definition.members) {
        checkExposed(member, `${definition.name}.${member.name ?? ''} (${spec})`, declared)
      }
    }
  }

  /**
   * The realms an interface, namespace or callback interface is exposed in. A callback interface without `[Exposed]`
   * has no interface object, so it is in none; any other definition without `[Exposed]` is refused.
   */
  ofDefinition({ definition, spec }: Definition): Realm[] {
    const set = ownExposureSet(definition)
    if (set) return this.#realmsOf(set)
    if (definition.type === 'callback interface') return []
    throw new Error(`${definition.type} ${definition.name} (${spec}) has no [Exposed]`)
  }

  /**
   * The realms a member is exposed in. Its exposure set is the first `[Exposed]` found on the member, the partial it
   * is declared on, or its original definition; a mixin member's is intersected with its host's, and a mixin with no
   * `[Exposed]` takes its host's.
   */
  ofMember({ member, declaredOn, host }: Declaration): Realm[] {
    const original = this.#originals.get(declaredOn.name) ?? declaredOn
    const own =
      ownExposureSet(member) ?? (declaredOn.partial ? ownExposureSet(declaredOn) : undefined) ?? ownExposureSet(original)
    return this.#realmsOf(host ? intersection(own, ownExposureSet(host)) : (own ?? new Set()))
  }

  /** The interface whose instance is the realm's global object: the one declaring the realm's `[Global]` name. */
  globalOf(realm: Realm): string {
    const name = this.#realmGlobals.get(realm)
    if (name === undefined) throw new Error(`the ${realm} realm has no global`)
    return name
  }

  #realmsOf(set: ExposureSet): Realm[] {
    return realms.filter((realm) => {
      const globalNames = this.#realmGlobalNames.get(realm)
      return globalNames && (set === '*' || [...set].some((name) => globalNames.has(name)))
    })
  }
}

/** Web IDL's exposure set intersection: of global names, where `*` yields to the other side. */
function intersection(own: ExposureSet | undefined, host: ExposureSet | undefined): ExposureSet {
  if (!own || own === '*') return host ?? new Set()
  if (!host || host === '*') return own
  return new Set([...own].filter((name) => host.has(name)))
}

function ownExposureSet({ extAttrs }: Construct): ExposureSet | undefined {
  const exposed = extAttrs.find(({ name }) => name === 'Exposed')
  return exposed && names(exposed)
}

function checkExposed(construct: Construct, label: string, declared: ReadonlySet<string>): void {
  const exposed = construct.extAttrs.find(({ name }) => name === 'Exposed')
  if (!exposed) return
  const set = names(exposed)
  if (!set) throw new Error(`${label}: [Exposed] must name globals or *`)
  if (set === '*') return
  for (const name of set) {
    if (!declared.has(name)) throw new Error(`${label}: [Exposed] names ${name}, which no [Global] interface declares`)
  }
}

/** The names an `[Exposed]` or `[Global]` takes, or `undefined` when it takes neither identifiers nor `*`. */
function names({ rhs }: WebIDL2.ExtendedAttribute): ExposureSet | undefined {
  // webidl2 parses `[Exposed=*]` as a `*` right-hand side, which @types/webidl2 does not list.
  if ((rhs?.type as string | undefined) === '*') return '*'
  if (rhs?.type === 'identifier') return new Set([rhs.value])
  if (rhs?.type === 'identifier-list') return new Set(rhs.value.map(({ value }) => value))
  return undefined
}

// The catalog changelog (§4 Catalog versions): the change records between two catalogs, which a scan's `explainedBy`
// offers for a delta. Build-time only; the runtime reads `catalog/changelog.json`.
import { isDeepStrictEqual } from 'node:util'
import {
  realms,
  type CatalogChangelog,
  type CatalogTarget,
  type ChangeRecord,
  type MemberData,
  type ProtectedEntry,
  type SerializedCatalog,
  type Surface,
} from '../../src/catalog.ts'
import { canonicalJson } from './canonical-json.ts'

/** The fields of a catalog the changelog compares. */
export type Compared = Pick<
  SerializedCatalog,
  'targets' | 'holders' | 'protectedSurface' | 'frameworkPathRules' | 'remoteUrlNormalization'
>

/**
 * The change records from catalog `from` to catalog `to`, in the §4 table's order, then by realm and name:
 * - targets added, and dropped (deliberately, or by an exclusion: the generation refuses any other loss)
 * - protected-surface entries gained or lost, keyed on (interface, member) whatever their surface, each with the
 *   targets it names in the catalog that has it
 * - targets in both whose descriptor or `assign` kind changed
 * - holders added, dropped or re-chained (their `proto` changed), and holders in both whose `immutablePrototype` flipped
 * - framework path rules added, removed or changed, by id
 * - remote URL normalization rules added, removed or changed: each path rule by id, and the `scheme`, `host` and `drop`
 *   steps
 *
 * A surface reassignment gives no record: surface is context only, and explains nothing.
 */
export function changeRecords(from: Compared, to: Compared): ChangeRecord[] {
  const records: ChangeRecord[] = []
  for (const realm of realms) {
    const [before, after] = [from.targets[realm], to.targets[realm]]
    for (const name of sorted(after)) if (!Object.hasOwn(before, name)) records.push({ kind: 'target', change: 'added', realm, name })
    for (const name of sorted(before)) {
      if (!Object.hasOwn(after, name)) records.push({ kind: 'target', change: 'dropped', realm, name })
    }
  }
  const [entriesBefore, entriesAfter] = [entries(from), entries(to)]
  for (const [key, { surface, entry }] of entriesAfter) {
    if (!entriesBefore.has(key)) records.push({ kind: 'protected-entry', change: 'gained', surface, entry })
  }
  for (const [key, { surface, entry }] of entriesBefore) {
    if (!entriesAfter.has(key)) records.push({ kind: 'protected-entry', change: 'lost', surface, entry })
  }
  for (const realm of realms) {
    const [before, after] = [from.targets[realm], to.targets[realm]]
    for (const name of sorted(after)) {
      if (!Object.hasOwn(before, name)) continue
      const [was, is] = [memberData(before[name]!), memberData(after[name]!)]
      if (!isDeepStrictEqual(was, is)) records.push({ kind: 'member-data', realm, name, before: was, after: is })
    }
  }
  for (const realm of realms) {
    const [before, after] = [from.holders[realm], to.holders[realm]]
    for (const holder of sorted({ ...before, ...after })) {
      const [was, is] = [before[holder], after[holder]]
      if (was === undefined) records.push({ kind: 'holder', change: 'added', realm, holder, after: { proto: is!.proto } })
      else if (is === undefined) {
        records.push({ kind: 'holder', change: 'dropped', realm, holder, before: { proto: was.proto } })
      } else if (was.proto !== is.proto) {
        records.push({ kind: 'holder', change: 'rechained', realm, holder, before: { proto: was.proto }, after: { proto: is.proto } })
      }
    }
    for (const holder of sorted(after)) {
      const [was, is] = [before[holder], after[holder]!]
      if (was !== undefined && (was.immutablePrototype === true) !== (is.immutablePrototype === true)) {
        const flags = { before: was.immutablePrototype === true, after: is.immutablePrototype === true }
        records.push({ kind: 'immutable-prototype', realm, holder, ...flags })
      }
    }
  }
  records.push(
    ...byId(from.frameworkPathRules, to.frameworkPathRules).map(
      ([id, before, after]): ChangeRecord => ({ kind: 'framework-path-rule', ...change(before, after), id, ...sides(before, after) }),
    ),
  )
  const [rulesBefore, rulesAfter] = [from.remoteUrlNormalization, to.remoteUrlNormalization]
  const steps = (normalization: SerializedCatalog['remoteUrlNormalization']) => ({
    scheme: normalization.scheme,
    host: normalization.host,
    drop: normalization.drop,
    ...Object.fromEntries(normalization.path.map((rule) => [rule.id, rule])),
  })
  records.push(
    ...byId(steps(rulesBefore), steps(rulesAfter)).map(
      ([id, before, after]): ChangeRecord => ({ kind: 'url-normalization', ...change(before, after), id, ...sides(before, after) }),
    ),
  )
  return records
}

/**
 * The changelog the generator writes (§4 Catalog versions): `committed`'s records for the versions before `catalog`'s,
 * and for `catalog`'s own version, the records from `previous`, the last catalog of the version before it. The first
 * catalog version has no records. Throws when `catalog`'s version needs `previous` and it isn't given.
 */
export function changelog(input: {
  catalog: Compared & Pick<SerializedCatalog, 'metadata'>
  previous: Compared | undefined
  committed: CatalogChangelog | undefined
}): string {
  const { catalogVersion } = input.catalog.metadata
  const kept = (input.committed?.versions ?? []).filter((version) => version.catalogVersion < catalogVersion)
  if (catalogVersion <= 1) return canonicalJson({ versions: kept })
  if (input.previous === undefined) {
    throw new Error(`the changelog for catalog version ${catalogVersion} needs the last catalog of version ${catalogVersion - 1}`)
  }
  return canonicalJson({ versions: [...kept, { catalogVersion, changes: changeRecords(input.previous, input.catalog) }] })
}

function memberData({ descriptor, assign }: CatalogTarget): MemberData {
  return assign === undefined ? { descriptor } : { descriptor, assign }
}

function entries(catalog: Compared): Map<string, { surface: Surface; entry: ProtectedEntry }> {
  const found = new Map<string, { surface: Surface; entry: ProtectedEntry }>()
  for (const surface of Object.keys(catalog.protectedSurface).sort() as Surface[]) {
    for (const entry of catalog.protectedSurface[surface] ?? []) {
      found.set(JSON.stringify([entry.interface, entry.member ?? null]), { surface, entry })
    }
  }
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}

/** The ids in either map whose values differ, sorted, each with its value before and after. */
function byId<T>(before: Readonly<Record<string, T>>, after: Readonly<Record<string, T>>): [string, T | undefined, T | undefined][] {
  return sorted({ ...before, ...after })
    .map((id): [string, T | undefined, T | undefined] => [id, before[id], after[id]])
    .filter(([, was, is]) => !isDeepStrictEqual(was, is))
}

const change = (before: unknown, after: unknown) =>
  ({ change: before === undefined ? 'added' : after === undefined ? 'removed' : 'changed' }) as const

function sides<T>(before: T | undefined, after: T | undefined): { before?: T; after?: T } {
  return { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) }
}

function sorted(record: Readonly<Record<string, unknown>>): string[] {
  return Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

/**
 * The CI check of the committed changelog (§4 Catalog versions): it must be what the generator writes for `catalog`,
 * from `previous`, the last catalog of the version before it, and the versions the committed changelog records before
 * `catalog`'s. Returns one message per problem.
 */
export function changelogProblems(input: {
  catalog: Compared & Pick<SerializedCatalog, 'metadata'>
  previous: Compared | undefined
  committed: string | undefined
}): string[] {
  const rerun = 'Run `npm run catalog` and commit the result.'
  if (input.committed === undefined) return [`catalog/changelog.json is missing. ${rerun}`]
  try {
    const fresh = changelog({ ...input, committed: JSON.parse(input.committed) as CatalogChangelog })
    if (fresh === input.committed) return []
    return [`catalog/changelog.json is not the changelog from the last catalog of the previous version. ${rerun}`]
  } catch (error) {
    return [(error as Error).message]
  }
}

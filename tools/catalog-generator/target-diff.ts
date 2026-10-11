import { createHash } from 'node:crypto'
import {
  realms,
  surfaces,
  type CatalogHolder,
  type CatalogTarget,
  type Descriptor,
  type Drop,
  type FrameworkPathRule,
  type PathShape,
  type Retention,
  type SerializedCatalog,
  type Surface,
} from '../../src/catalog.ts'

const title = '# Catalog target diff'

/**
 * A target as the diff reads it. One written before member data may have no descriptor, and one written
 * before surfaces no surface.
 */
type ReadTarget = Pick<CatalogTarget, 'holder' | 'assign' | 'owner' | 'holds'> & {
  descriptor?: Descriptor
  surface?: Surface
}

/**
 * A catalog as the diff reads it. One written before targets had realms keys its targets by name, one
 * written before holder placement has no holders, and earlier versions of the format may lack
 * exclusions, a protected-surface list, a catalog version, a retained section, dropped holders, framework path rules
 * or escape-only shapes.
 */
type ReadCatalog = {
  metadata: Pick<SerializedCatalog['metadata'], 'upstream'> & { catalogVersion?: number }
  targets: Record<string, ReadTarget | Record<string, ReadTarget>>
  holders?: Record<string, Record<string, Pick<CatalogHolder, 'kind' | 'owner'>>>
  instanceMembers?: Record<string, Record<string, Record<string, Pick<ReadTarget, 'owner' | 'surface'>>>>
  exclusions?: Record<string, { reason: string; targets: Record<string, string[]> }>
  protectedSurface?: Record<string, { targets: Record<string, string[]> }[]>
  retained?: {
    targets: Record<string, Record<string, Retention>>
    holders?: Record<string, Record<string, Retention>>
    dropped: Record<string, Record<string, Drop>>
    droppedHolders?: Record<string, Record<string, Drop>>
  }
  frameworkPathRules?: Record<string, FrameworkPathRule>
  escapeOnlyShapes?: Record<string, PathShape>
}

/** A target of one side of the diff: its diff line, its realm (none before realms) and name, and its record. */
interface Entry {
  line: string
  realm: string | undefined
  name: string
  target: ReadTarget
}

/**
 * The committed, readable diff a catalog bump is reviewed against (§4 Bump review), between two catalog texts:
 * - the targets added and removed, one line per target with its realm and holder kind, and for a removed one, why it
 *   left: a deliberate drop with its BCD evidence, or an exclusion with its reason
 * - the holders added and removed, compared by realm and name (holders are monotonic too), with why each removed one
 *   left
 * - the targets and holders newly retained, with the last upstream version that had them and why they stay
 * - the targets on both sides whose descriptor, assign kind, surface or protection changed, with both sides' data
 * - the owners only the new side has, with the surfaces of their members: an owner nobody has reviewed shows as
 *   `other` (§12)
 * - the framework path rules and escape-only shapes (§10) added, removed or changed, by id (§4 Catalog versions)
 * - the catalog version, upstream pins and a hash of each side
 *
 * A target whose holder kind changes is removed under one and added under the other. Each line that touches a target
 * protected on either side, each newly retained target or holder, and each removal an exclusion causes is marked
 * `[sign-off: …]`: it needs explicit sign-off.
 */
export function targetDiff(previous: string | undefined, next: string): string {
  const before = previous === undefined ? undefined : (JSON.parse(previous) as ReadCatalog)
  const after = JSON.parse(next) as ReadCatalog
  const had = targetEntries(before)
  const has = targetEntries(after)
  const [wasProtected, isProtected] = [protectedTargets(before), protectedTargets(after)]
  const hadByLine = new Map(had.map((entry) => [entry.line, entry]))
  const hasLines = new Set(has.map(({ line }) => line))
  const added = has
    .filter(({ line }) => !hadByLine.has(line))
    .map((entry) => marked(entry.line, [isProtected.has(keyOf(entry)) && 'protected']))
  const removed = had
    .filter(({ line }) => !hasLines.has(line))
    .map((entry) => {
      const why = whyRemoved(entry, after)
      return marked(entry.line, [wasProtected.has(keyOf(entry)) && 'protected', why?.excluded === true && 'excluded'], why?.text)
    })
  const hadHolders = new Set(holderEntries(before).map(({ line }) => line))
  const addedHolders = holderEntries(after)
    .filter(({ line }) => !hadHolders.has(line))
    .map(({ line }) => line)
  const removedHolders = holderEntries(before)
    .filter(({ realm, name }) => after.holders?.[realm]?.[name] === undefined)
    .map((entry) => {
      const why = whyHolderRemoved(entry, after)
      return marked(entry.line, [why?.excluded === true && 'excluded'], why?.text)
    })
  const lastIn = (retention: Retention) => `last in ${retention.lastUpstream}; ${retention.reason}`
  const retainedTargets = has.flatMap((entry) => {
    const retention = retainedIn(after, entry)
    if (!retention || retainedIn(before, entry)) return []
    return [{ ...entry, line: marked(entry.line, [isProtected.has(keyOf(entry)) && 'protected', 'retained'], lastIn(retention)) }]
  })
  const retainedHolders = holderEntries(after).flatMap((entry) => {
    const retention = after.retained?.holders?.[entry.realm]?.[entry.name]
    if (!retention || before?.retained?.holders?.[entry.realm]?.[entry.name]) return []
    return [{ ...entry, line: marked(entry.line, ['retained'], lastIn(retention)) }]
  })
  const retained = [...retainedTargets, ...retainedHolders]
    .sort(byNameThenRealm)
    .map(({ line }) => line)
  const changed = has.flatMap((entry) => {
    const earlier = hadByLine.get(entry.line)
    if (!earlier) return []
    const [was, is] = [wasProtected.has(keyOf(earlier)), isProtected.has(keyOf(entry))]
    const changes = memberDataChanges(earlier.target, entry.target)
    if (was !== is) changes.push(`protected ${was ? 'yes' : 'no'} → ${is ? 'yes' : 'no'}`)
    return changes.length ? [marked(entry.line, [(was || is) && 'protected'], changes.join('; '))] : []
  })
  const side = (catalog: ReadCatalog, text: string) => {
    const version = catalog.metadata.catalogVersion
    const versioned = version === undefined ? '' : `catalog version ${version}, `
    return `${versioned}${pins(catalog)} (catalog sha256 \`${sha256(text)}\`)`
  }

  const from =
    before && previous !== undefined
      ? `${side(before, previous)}${realmKeyed(before) ? '' : ', whose targets have no realm'}`
      : 'no previous catalog'
  const known = new Set(ownerSurfaces(before).keys())
  const newOwners = [...ownerSurfaces(after)]
    .filter(([owner]) => !known.has(owner))
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([owner, owned]) => `\`${owner}\`: ${owned.join(', ')}`)
  const header = [
    title,
    '',
    'Generated by `npm run catalog`. Do not edit. It lists the targets added, removed and newly retained by the last ' +
      'catalog change, the holders it added, removed or newly retained, the targets whose descriptor, assign kind, ' +
      'surface or protection it changed, the owners it added, with the surfaces of their members: an owner nobody has ' +
      'reviewed shows as other, and the framework path rules and escape-only shapes it added, removed or changed. A line ' +
      `marked ${signOffMark} changes a protected target, retains a target or holder, ` +
      'or removes one through an exclusion, and CI fails until `catalog/sign-off.json` records who signed it off.',
    '',
    `- From: ${from}`,
    `- To: ${side(after, next)}`,
  ].join('\n')
  const sections = [
    section('Added', added),
    section('Removed', removed),
    section('Added holders', addedHolders),
    section('Removed holders', removedHolders),
    section('Retained', retained),
    section('Changed', changed),
    section('New owners', newOwners),
    section('Framework path rules', shapeChanges(before?.frameworkPathRules, after.frameworkPathRules)),
    section('Escape-only shapes', shapeChanges(before?.escapeOnlyShapes, after.escapeOnlyShapes)),
  ]
  return [header, ...sections].join('\n\n') + '\n'
}

const signOffMark = '[sign-off]'

/**
 * The framework path rules or escape-only shapes added, removed or changed between two catalogs, one line per id, in id
 * order: `` `id` added: <shape> ``, `` `id` removed: <shape> `` or `` `id` changed: <was>; now <is> ``. A change only to
 * a shape's `source` reads `source changed`.
 */
function shapeChanges(
  before: Record<string, PathShape & { package?: string }> | undefined,
  after: Record<string, PathShape & { package?: string }> | undefined,
): string[] {
  const [had, has] = [before ?? {}, after ?? {}]
  const ids = [...new Set([...Object.keys(had), ...Object.keys(has)])].sort(byCodeUnit)
  return ids.flatMap((id) => {
    const [was, is] = [had[id], has[id]]
    if (was === undefined) return [`\`${id}\` added: ${inWordsShape(is!)}`]
    if (is === undefined) return [`\`${id}\` removed: ${inWordsShape(was)}`]
    if (JSON.stringify(sortedKeys(was)) === JSON.stringify(sortedKeys(is))) return []
    const [from, to] = [inWordsShape(was), inWordsShape(is)]
    return [`\`${id}\` changed: ${from === to ? 'source changed' : `${from}; now ${to}`}`]
  })
}

/**
 * A path shape in words: `` in `webpack:_N_E`, 2 or more leading `../`, then `src/client/` → `next` ``, or
 * `` anywhere, `<platform>-fastbuild-ST-*` … → `@angular/<pkg>` ``.
 */
function inWordsShape({ namespace, up, segments, captures, package: named }: PathShape & { package?: string }): string {
  const where = [
    ...(namespace === undefined ? [] : [`in \`${namespace}\``]),
    ...(up === undefined ? ['anywhere,'] : [`${up} or more leading \`../\`, then`]),
  ].join(', ')
  const limits = Object.entries(captures ?? {})
    .sort(([a], [b]) => byCodeUnit(a, b))
    .map(([name, values]) => `, where \`<${name}>\` is one of ${values.map((value) => `\`${value}\``).join(', ')}`)
  return `${where} \`${segments.join('/')}/\`${limits.join('')}${named === undefined ? '' : ` → \`${named}\``}`
}

function sortedKeys(value: object): [string, unknown][] {
  return Object.entries(value).sort(([a], [b]) => byCodeUnit(a, b))
}

/**
 * The lines of a target diff that need explicit sign-off (§4 Bump review): each marked `[sign-off: …]`, as it reads
 * after its list marker.
 */
export function signOffLines(diff: string): string[] {
  return diff
    .split('\n')
    .filter((line) => line.startsWith('- `') && / \[sign-off: [a-z, ]+\](:|$)/.test(line))
    .map((line) => line.slice(2))
}

/** A diff line with its sign-off mark, when any reason applies, and its details. */
function marked(line: string, reasons: (string | false)[], details?: string): string {
  const applying = reasons.filter((reason) => reason !== false)
  const mark = applying.length ? ` [sign-off: ${applying.join(', ')}]` : ''
  return `${line}${mark}${details === undefined ? '' : `: ${details}`}`
}

/** Why a target or holder left the catalog, and whether an exclusion removed it. */
interface Why {
  text: string
  excluded: boolean
}

/**
 * Why a target left the catalog, when the new side says: excluded with a reason, or dropped with BCD evidence. An
 * exclusion that lists the target removed it from this generation, so it wins over a drop entry for the same target:
 * its line still needs sign-off.
 */
function whyRemoved({ realm, name }: Entry, after: ReadCatalog): Why | undefined {
  if (realm === undefined) return undefined
  const exclusion = Object.values(after.exclusions ?? {}).find(({ targets }) => targets[realm]?.includes(name))
  if (exclusion) return { text: `excluded: ${exclusion.reason}`, excluded: true }
  const drop = after.retained?.dropped[realm]?.[name]
  return drop && { text: `dropped: ${drop.bcd}: ${drop.evidence}`, excluded: false }
}

/**
 * Why a holder left the catalog: excluded with its owner, or dropped with BCD evidence. An exclusion removes every
 * holder of its owner, so it wins over a drop entry, as for targets.
 */
function whyHolderRemoved({ realm, name, owner }: HolderEntry, after: ReadCatalog): Why | undefined {
  const exclusion = after.exclusions && Object.hasOwn(after.exclusions, owner) ? after.exclusions[owner] : undefined
  if (exclusion) return { text: `excluded: ${exclusion.reason}`, excluded: true }
  const drop = after.retained?.droppedHolders?.[realm]?.[name]
  return drop && { text: `dropped: ${drop.bcd}: ${drop.evidence}`, excluded: false }
}

/** A holder of one side of the diff: its diff line, its realm and name, and its owner. */
interface HolderEntry {
  line: string
  realm: string
  name: string
  owner: string
}

/** A catalog's holders with their diff lines, `` `name` (realm, kind holder) ``, sorted by name and then realm. */
function holderEntries(catalog: ReadCatalog | undefined): HolderEntry[] {
  if (!catalog || !realmKeyed(catalog)) return []
  return Object.entries(catalog.holders ?? {})
    .flatMap(([realm, named]) => Object.entries(named).map(([name, holder]) => ({ realm, name, holder })))
    .sort(byNameThenRealm)
    .map(({ realm, name, holder }) => ({ line: `\`${name}\` (${realm}, ${holder.kind} holder)`, realm, name, owner: holder.owner }))
}

function retainedIn(catalog: ReadCatalog | undefined, { realm, name }: Entry): Retention | undefined {
  return realm === undefined ? undefined : catalog?.retained?.targets[realm]?.[name]
}

/** The targets a catalog's protected-surface list names, by `keyOf`. */
function protectedTargets(catalog: ReadCatalog | undefined): Set<string> {
  const entries = Object.values(catalog?.protectedSurface ?? {}).flat()
  return new Set(
    entries.flatMap(({ targets }) =>
      Object.entries(targets).flatMap(([realm, names]) => names.map((name) => `${realm} ${name}`)),
    ),
  )
}

function keyOf({ realm, name }: Entry): string {
  return `${realm} ${name}`
}

/**
 * The sha256 of the catalog a target diff's From line names: `null` when it names no previous catalog, and undefined
 * when the diff has no From line this generator writes.
 */
export function fromHash(diff: string): string | null | undefined {
  if (!diff.startsWith(title)) return undefined
  if (/^- From: no previous catalog$/m.test(diff)) return null
  return /^- From: .*\(catalog sha256 `([0-9a-f]{64})`\)(, whose targets have no realm)?$/m.exec(diff)?.[1]
}

/**
 * A catalog's targets with their diff lines, `` `name` (realm, holder) ``, sorted by name and then in realm order. A
 * catalog from before realms gives `` `name` (holder) ``.
 */
function targetEntries(catalog: ReadCatalog | undefined): Entry[] {
  if (!catalog) return []
  if (!realmKeyed(catalog)) {
    const named = catalog.targets as Record<string, ReadTarget>
    return Object.entries(named)
      .sort(([a], [b]) => byCodeUnit(a, b))
      .map(([name, target]) => ({ line: `\`${name}\` (${target.holder})`, realm: undefined, name, target }))
  }
  const perRealm = catalog.targets as Record<string, Record<string, ReadTarget>>
  return Object.entries(perRealm)
    .flatMap(([realm, named]) => Object.entries(named).map(([name, target]) => ({ name, realm, target })))
    .sort(byNameThenRealm)
    .map(({ name, realm, target }) => ({ line: `\`${name}\` (${realm}, ${target.holder})`, realm, name, target }))
}

/** How a target's descriptor, assign kind and surface differ between two catalogs, one phrase for each that does. */
function memberDataChanges(before: ReadTarget, after: ReadTarget): string[] {
  const changes: string[] = []
  const [was, is] = [inWords(before.descriptor), inWords(after.descriptor)]
  if (was !== is) changes.push(`descriptor ${was} → ${is}`)
  if (before.assign !== after.assign) changes.push(`assign ${before.assign ?? 'none'} → ${after.assign ?? 'none'}`)
  if (before.surface !== after.surface) changes.push(`surface ${before.surface ?? 'none'} → ${after.surface ?? 'none'}`)
  return changes
}

/**
 * Each owner of a target or per-instance member, in any realm, with the surfaces of the members it owns, in the
 * order of `surfaces`. An interface or namespace a property holds is an owner too, even with no members of its own
 * (`Window.Comment` holds `Comment`), and the surface of that property counts as one of its members'. A catalog from
 * before surfaces gives its owners none.
 */
function ownerSurfaces(catalog: ReadCatalog | undefined): Map<string, Surface[]> {
  const owned = new Map<string, Set<Surface>>()
  const add = (owner: string, surface: Surface | undefined) => {
    let found = owned.get(owner)
    if (!found) owned.set(owner, (found = new Set()))
    if (surface !== undefined) found.add(surface)
  }
  for (const { target } of targetEntries(catalog)) add(target.owner, target.surface)
  if (catalog && realmKeyed(catalog)) {
    for (const [realm, named] of Object.entries(catalog.targets as Record<string, Record<string, ReadTarget>>)) {
      for (const { holds, surface } of Object.values(named)) {
        const held = holds === undefined ? undefined : catalog.holders?.[realm]?.[holds]?.owner
        if (held !== undefined) add(held, surface)
      }
    }
  }
  for (const byOwner of Object.values(catalog?.instanceMembers ?? {})) {
    for (const members of Object.values(byOwner)) {
      for (const member of Object.values(members)) add(member.owner, member.surface)
    }
  }
  return new Map([...owned].map(([owner, found]) => [owner, surfaces.filter((surface) => found.has(surface))]))
}

/** A descriptor in words: `data (writable, enumerable, configurable)`, `accessor without setter (…)`. */
function inWords(descriptor: Descriptor | undefined): string {
  if (!descriptor) return 'none'
  const flag = (set: boolean, name: string) => (set ? name : `non-${name}`)
  const attributes = [flag(descriptor.enumerable, 'enumerable'), flag(descriptor.configurable, 'configurable')]
  if (descriptor.type === 'data') return `data (${[flag(descriptor.writable, 'writable'), ...attributes].join(', ')})`
  return `accessor ${descriptor.setter ? 'with' : 'without'} setter (${attributes.join(', ')})`
}

function realmKeyed(catalog: ReadCatalog): boolean {
  return Object.keys(catalog.targets).every((key) => realms.some((realm) => realm === key))
}

function realmOrder(realm: string): number {
  return realms.findIndex((known) => known === realm)
}

/** A target or holder as the diff sorts it: its name, and its realm (none before realms). */
type Named = { name: string; realm?: string | undefined }

/** The diff's order for targets and holders: by name, then in realm order. */
function byNameThenRealm(a: Named, b: Named): number {
  return byCodeUnit(a.name, b.name) || realmOrder(a.realm ?? '') - realmOrder(b.realm ?? '')
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function section(heading: string, lines: string[]): string {
  return [`## ${heading} (${lines.length})`, ...(lines.length ? ['', ...lines.map((line) => `- ${line}`)] : [])].join(
    '\n',
  )
}

function pins(catalog: ReadCatalog): string {
  return Object.keys(catalog.metadata.upstream)
    .sort()
    .map((name) => `\`${name}\` ${catalog.metadata.upstream[name]}`)
    .join(', ')
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

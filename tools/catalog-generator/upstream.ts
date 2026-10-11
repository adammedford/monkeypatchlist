import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { listAll } from '@webref/idl'
import {
  propertyKinds,
  realms,
  type Descriptor,
  type EngineExtension,
  type EnginePrototype,
  type EsAddition,
  type EsProseProperty,
  type PropertyKind,
  type ProseMember,
} from '../../src/catalog.ts'
import { upstreamPackages, type Sources, type Upstream } from './generate.ts'
import type { EnginePrototypesOverlay } from './engine-prototypes.ts'
import type { ExclusionsOverlay } from './exclusions.ts'
import type { Biblio } from './intrinsics.ts'
import type { ProseMembersOverlay } from './prose-members.ts'
import type { ProtectedSurfaceOverlay } from './protected-surface.ts'
import { escapeOnlyShapesOverlay, frameworkPathRulesOverlay } from './path-rules.ts'
import type { RetainedOverlay } from './retained.ts'
import { remoteUrlNormalizationOverlay } from './remote-url-normalization.ts'
import type { SingletonsOverlay } from './singletons.ts'
import type { SurfacesOverlay } from './surfaces.ts'

const root = new URL('../../', import.meta.url)

/**
 * The curated overlays (§4 Sources): small ES additions, engine extensions, the ECMA-262 own properties without a clause
 * of their own, the members specs define in prose on each instance of an interface, platform singletons and their
 * aliases, the prototypes an engine puts on a singleton's chain, exclusions, the owner → surface map, the
 * protected-surface list, retained targets, the remote URL normalization rules, and the framework path rules and
 * escape-only shapes (§10).
 */
const overlays = {
  esAdditions: new URL('tools/catalog-generator/overlays/es-additions.json', root),
  engineExtensions: new URL('tools/catalog-generator/overlays/engine-extensions.json', root),
  esProseProperties: new URL('tools/catalog-generator/overlays/es-prose-properties.json', root),
  proseMembers: new URL('tools/catalog-generator/overlays/prose-members.json', root),
  singletons: new URL('tools/catalog-generator/overlays/singletons.json', root),
  enginePrototypes: new URL('tools/catalog-generator/overlays/engine-prototypes.json', root),
  exclusions: new URL('tools/catalog-generator/overlays/exclusions.json', root),
  surfaces: new URL('tools/catalog-generator/overlays/surfaces.json', root),
  protectedSurface: new URL('tools/catalog-generator/overlays/protected-surface.json', root),
  retained: new URL('tools/catalog-generator/overlays/retained.json', root),
  remoteUrlNormalization: new URL('tools/catalog-generator/overlays/remote-url-normalization.json', root),
  frameworkPathRules: new URL('tools/catalog-generator/overlays/framework-path-rules.json', root),
  escapeOnlyShapes: new URL('tools/catalog-generator/overlays/escape-only-shapes.json', root),
}

/** The catalog version (§4 Catalog versions), which a catalog bump raises by hand, once per monkeypatchlist minor release. */
const catalogVersionFile = new URL('tools/catalog-generator/catalog-version.json', root)

/**
 * Reads the pinned upstream inputs: every IDL file of `@webref/idl`, the ECMA-262 and ECMA-402 biblios, the curated
 * overlays with a sha256 pin of each, the catalog version, and the exact version of each upstream package. Refuses a
 * range pin, or an installed version that differs from the pin.
 */
export async function loadUpstream(): Promise<Sources> {
  const upstream: Upstream = {}
  for (const name of upstreamPackages) upstream[name] = await exactPin(name)

  const idl: Record<string, string> = {}
  for (const [shortname, file] of Object.entries(await listAll())) idl[shortname] = await file.text()
  const ecmascript = {
    ecma262: (await readJson(new URL('node_modules/@tc39/ecma262-biblio/biblio.json', root))) as Biblio,
    ecma402: (await readJson(new URL('node_modules/@tc39/ecma402-biblio/biblio.json', root))) as Biblio,
    additions: esAdditions(await readJson(overlays.esAdditions)),
    engineExtensions: engineExtensions(await readJson(overlays.engineExtensions)),
    proseProperties: esProseProperties(await readJson(overlays.esProseProperties)),
  }
  const proseMembers = proseMembersOverlay(await readJson(overlays.proseMembers))
  const singletons = singletonsOverlay(await readJson(overlays.singletons))
  const enginePrototypes = enginePrototypesOverlay(await readJson(overlays.enginePrototypes))
  const exclusions = exclusionsOverlay(await readJson(overlays.exclusions))
  const surfaces = surfacesOverlay(await readJson(overlays.surfaces))
  const protectedSurface = protectedSurfaceOverlay(await readJson(overlays.protectedSurface))
  const retained = retainedOverlay(await readJson(overlays.retained))
  const remoteUrlNormalization = remoteUrlNormalizationOverlay(
    await readJson(overlays.remoteUrlNormalization),
    overlays.remoteUrlNormalization.pathname,
  )
  const frameworkPathRules = frameworkPathRulesOverlay(
    await readJson(overlays.frameworkPathRules),
    overlays.frameworkPathRules.pathname,
  )
  const escapeOnlyShapes = escapeOnlyShapesOverlay(await readJson(overlays.escapeOnlyShapes), overlays.escapeOnlyShapes.pathname)
  const pins: Record<string, string> = {}
  for (const url of Object.values(overlays)) {
    pins[url.pathname.slice(url.pathname.lastIndexOf('/') + 1)] = createHash('sha256')
      .update(await readFile(url))
      .digest('hex')
  }
  const catalogVersion = catalogVersionOf(await readJson(catalogVersionFile))
  return {
    idl,
    ecmascript,
    proseMembers,
    singletons,
    enginePrototypes,
    exclusions,
    surfaces,
    protectedSurface,
    retained,
    remoteUrlNormalization,
    frameworkPathRules,
    escapeOnlyShapes,
    upstream,
    catalogVersion,
    overlays: pins,
  }
}

/**
 * The exact version package.json pins a devDependency to. Refuses a range pin, or an installed version that differs
 * from the pin.
 */
export async function exactPin(name: string): Promise<string> {
  const pin = (await readJson(new URL('package.json', root))).devDependencies?.[name]
  if (!pin || !/^\d+\.\d+\.\d+$/.test(pin)) throw new Error(`${name} must be exact-pinned in package.json, not "${pin}"`)
  const installed = (await readJson(new URL(`node_modules/${name}/package.json`, root))).version
  if (installed !== pin) throw new Error(`${name} ${installed} is installed, but package.json pins ${pin}. Run npm ci.`)
  return pin
}

/** The hand-edited catalog version, refused unless it is a positive integer. */
function catalogVersionOf(json: unknown): number {
  const { catalogVersion, ...rest } = json as { catalogVersion?: unknown }
  if (!Number.isSafeInteger(catalogVersion) || (catalogVersion as number) < 1 || Object.keys(rest).length) {
    throw new Error(`${catalogVersionFile.pathname}: needs catalogVersion only, a positive integer`)
  }
  return catalogVersion as number
}

async function readJson(url: URL): Promise<{ version?: string; devDependencies?: Record<string, string> }> {
  return JSON.parse(await readFile(url, 'utf8'))
}

const isStrings = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === 'string')

const isStringRecord = (value: unknown) =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && isStrings(Object.values(value))

/** The hand-edited overlay, refused unless each entry has the shape of an `EsAddition`. */
function esAdditions(json: unknown): Record<string, EsAddition> {
  for (const [name, entry] of Object.entries(json as Record<string, Partial<EsAddition>>)) {
    const { spec, source, namespaces, properties, ...rest } = entry
    const described = typeof spec === 'string' && typeof source === 'string'
    const valid = described && isStrings(namespaces) && isStrings(properties)
    if (!valid || Object.keys(rest).length) {
      throw new Error(`${overlays.esAdditions.pathname}: ${name} needs spec, source, namespaces and properties only`)
    }
  }
  return json as Record<string, EsAddition>
}

/**
 * The hand-edited engine-extensions overlay, refused unless each entry has the shape of an `EngineExtension`: the
 * engine, where it was curated from, a kind and a descriptor. The generator checks the entries against the intrinsics.
 */
function engineExtensions(json: unknown): Record<string, EngineExtension> {
  for (const [name, entry] of Object.entries(json as Record<string, Partial<EngineExtension>>)) {
    const { engine, source, kind, descriptor, ...rest } = entry
    const described = typeof engine === 'string' && engine !== '' && typeof source === 'string' && source !== ''
    if (!described || !isPropertyKind(kind) || !isDescriptor(descriptor) || Object.keys(rest).length) {
      const needs = 'needs engine, source, kind (function, value or accessor) and a data or accessor descriptor only'
      throw new Error(`${overlays.engineExtensions.pathname}: ${name} ${needs}`)
    }
  }
  return json as Record<string, EngineExtension>
}

/**
 * The hand-edited overlay of ECMA-262 own properties without a clause of their own, refused unless each entry has the
 * shape of an `EsProseProperty`: where ECMA-262 defines it, a kind and a descriptor. The generator checks the entries
 * against the intrinsics.
 */
function esProseProperties(json: unknown): Record<string, EsProseProperty> {
  for (const [name, entry] of Object.entries(json as Record<string, Partial<EsProseProperty>>)) {
    const { source, kind, descriptor, ...rest } = entry
    const described = typeof source === 'string' && source !== ''
    if (!described || !isPropertyKind(kind) || !isDescriptor(descriptor) || Object.keys(rest).length) {
      const needs = 'needs source, kind (function, value or accessor) and a data or accessor descriptor only'
      throw new Error(`${overlays.esProseProperties.pathname}: ${name} ${needs}`)
    }
  }
  return json as Record<string, EsProseProperty>
}

/**
 * The hand-edited overlay of members specs define in prose on each instance, refused unless it maps each interface to
 * members with the shape of a `ProseMember`: the spec, where it was curated from, a kind and a descriptor. The generator
 * checks the entries against the IDL.
 */
function proseMembersOverlay(json: unknown): ProseMembersOverlay {
  const isMember = (value: unknown) => {
    const { spec, source, kind, descriptor, ...rest } = value as Partial<ProseMember>
    const described = typeof spec === 'string' && spec !== '' && typeof source === 'string' && source !== ''
    return described && isPropertyKind(kind) && isDescriptor(descriptor) && !Object.keys(rest).length
  }
  if (!isRecordOf(json, (members) => isRecordOf(members, isMember))) {
    const needs =
      'needs, for each interface, members with spec, source, kind (function, value or accessor) and a descriptor only'
    throw new Error(`${overlays.proseMembers.pathname}: ${needs}`)
  }
  return json as ProseMembersOverlay
}

/**
 * The hand-edited engine-prototypes overlay, refused unless each entry has the shape of an `EnginePrototype`: the
 * engine, where it was curated from, its realms, owner and prototype, the holders it goes under, and the prototype of
 * its interface object. The generator checks the entries against the holders.
 */
function enginePrototypesOverlay(json: unknown): EnginePrototypesOverlay {
  const isText = (field: unknown) => typeof field === 'string' && field !== ''
  const isInterfaceObject = (value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const { proto, ...rest } = value as Partial<EnginePrototype['interfaceObject']>
    return isText(proto) && !Object.keys(rest).length
  }
  const isEntry = (value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
    const { engine, source, realms: listed, owner, proto, prototypeOf, interfaceObject, ...rest } =
      value as Partial<EnginePrototype>
    const named = [engine, source, owner, proto].every(isText)
    const shaped = isStrings(listed) && isStrings(prototypeOf) && isInterfaceObject(interfaceObject)
    return named && shaped && !Object.keys(rest).length
  }
  if (!isRecordOf(json, isEntry)) {
    const needs = 'needs, for each holder, engine, source, realms, owner, proto, prototypeOf and interfaceObject { proto } only'
    throw new Error(`${overlays.enginePrototypes.pathname}: ${needs}`)
  }
  return json as EnginePrototypesOverlay
}

/** Whether `value` is a curated property's kind: `function`, `value` or `accessor`. */
function isPropertyKind(value: unknown): value is PropertyKind {
  return (propertyKinds as readonly unknown[]).includes(value)
}

/** Whether `value` is a data descriptor or an accessor descriptor, with its boolean attributes and nothing else. */
function isDescriptor(value: unknown): value is Descriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { type, enumerable, configurable, ...rest } = value as Record<string, unknown>
  const fields = type === 'data' ? ['writable'] : type === 'accessor' ? ['setter'] : undefined
  const attributes = [enumerable, configurable, ...(fields ?? []).map((field) => rest[field])]
  const extra = Object.keys(rest).filter((key) => !fields?.includes(key))
  return fields !== undefined && attributes.every((flag) => typeof flag === 'boolean') && extra.length === 0
}

/** The hand-edited singletons overlay, refused unless it has the shape of a `SingletonsOverlay`. */
function singletonsOverlay(json: unknown): SingletonsOverlay {
  const { globalNames, singletons, aliases, ...rest } = json as Partial<SingletonsOverlay>
  if (!isStrings(globalNames) || !isStrings(singletons) || !isStringRecord(aliases) || Object.keys(rest).length) {
    throw new Error(`${overlays.singletons.pathname}: needs globalNames, singletons and aliases only`)
  }
  return json as SingletonsOverlay
}

/** The hand-edited exclusions overlay, refused unless it maps each excluded owner to a reason. */
function exclusionsOverlay(json: unknown): ExclusionsOverlay {
  if (!isStringRecord(json)) throw new Error(`${overlays.exclusions.pathname}: needs a reason for each excluded owner`)
  return json as ExclusionsOverlay
}

/** The hand-edited owner → surface map, refused unless it has the shape of a `SurfacesOverlay`. */
function surfacesOverlay(json: unknown): SurfacesOverlay {
  const { owners, members, ...rest } = json as Partial<SurfacesOverlay>
  const valid = isStringRecord(owners) && isRecordOf(members, isStringRecord) && !Object.keys(rest).length
  if (!valid) throw new Error(`${overlays.surfaces.pathname}: needs owners and members only`)
  return json as SurfacesOverlay
}

/**
 * The hand-edited protected-surface list, refused unless each surface lists entries of an interface and, for a member
 * entry, a member and optionally the interface of its worker-realm equivalent.
 */
function protectedSurfaceOverlay(json: unknown): ProtectedSurfaceOverlay {
  const isEntry = (entry: unknown) => {
    const { interface: name, member, workerEquivalent, ...rest } = entry as Record<string, unknown>
    const equivalent = workerEquivalent === undefined || (typeof workerEquivalent === 'string' && member !== undefined)
    const valid = typeof name === 'string' && (member === undefined || typeof member === 'string') && equivalent
    return valid && !Object.keys(rest).length
  }
  if (!isRecordOf(json, (entries) => Array.isArray(entries) && entries.every(isEntry))) {
    const needs =
      'needs, for each surface, entries of an interface and, for a member entry, a member and optionally a workerEquivalent'
    throw new Error(`${overlays.protectedSurface.pathname}: ${needs}`)
  }
  return json as ProtectedSurfaceOverlay
}

/**
 * The hand-edited retained overlay, refused unless it has the shape of a `RetainedOverlay`: per realm, retained
 * targets and holders with the last upstream version that had them, a reason and their record, and drops of targets
 * and of holders with the BCD feature and evidence. The generator checks the records themselves against the catalog,
 * and `catalog:check` the drops against BCD.
 */
function retainedOverlay(json: unknown): RetainedOverlay {
  const text = (value: unknown) => typeof value === 'string' && value.trim() !== ''
  const isObject = (value: unknown) => typeof value === 'object' && value !== null && !Array.isArray(value)
  const entry = (record: string) => (value: unknown) => {
    const { lastUpstream, reason, [record]: data, ...rest } = value as Record<string, unknown>
    const pinned = typeof lastUpstream === 'string' && /^\S+ \d+\.\d+\.\d+$/.test(lastUpstream)
    return pinned && text(reason) && isObject(data) && !Object.keys(rest).length
  }
  const drop = (value: unknown) => {
    const { bcd, evidence, ...rest } = value as Record<string, unknown>
    return text(bcd) && text(evidence) && !Object.keys(rest).length
  }
  const perRealm = (isEntry: (value: unknown) => boolean) => (value: unknown) =>
    isRecordOf(value, (named) => isRecordOf(named, isEntry)) &&
    Object.keys(value as object).every((realm) => realms.some((known) => known === realm))
  const { targets, holders, dropped, droppedHolders, ...rest } = json as Record<string, unknown>
  const valid =
    perRealm(entry('target'))(targets) &&
    perRealm(entry('holder'))(holders) &&
    perRealm(drop)(dropped) &&
    perRealm(drop)(droppedHolders)
  if (!valid || Object.keys(rest).length) {
    const needs =
      'needs targets, holders, dropped and droppedHolders, each by realm and name: a target or holder with ' +
      'lastUpstream ("<package> <version>"), a reason and its record; a drop of a target or holder with bcd and evidence'
    throw new Error(`${overlays.retained.pathname}: ${needs}`)
  }
  return json as RetainedOverlay
}

function isRecordOf(value: unknown, isValue: (item: unknown) => boolean): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.values(value).every(isValue)
}

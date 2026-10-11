import { realms, type EnginePrototype, type Realm } from '../../src/catalog.ts'
import { constructorProperty, prototypeProperty, tag } from './synthesized.ts'
import { globalProperty, type PlacedSections, type PlacedTarget } from './targets.ts'

/**
 * The curated engine-prototypes overlay (§4 Sources), by the name of the holder each entry adds: a prototype object an
 * engine puts on a platform singleton's chain where Web IDL has none (`HTMLDocument.prototype`).
 */
export type EnginePrototypesOverlay = Record<string, EnginePrototype>

/**
 * Adds each engine prototype, in each realm its entry lists, as a `prototype` holder owned by its entry's `owner` and
 * inheriting from its `proto`, and makes it the prototype of each holder in its `prototypeOf`. Its interface object is
 * a `constructor` holder named by `owner`, inheriting from the entry's `interfaceObject.proto`, and held by the
 * `global` target `<global>.<owner>` (`Window.HTMLDocument`, §4). Their targets are the binding's structural ones: the
 * interface object's `prototype`, and the prototype's `constructor` and `@@toStringTag`, credited to the entry's
 * `engine`. Refuses an entry whose name or `owner` is already a holder, that lists no realm or an unknown one, or no
 * holder to be the prototype of, whose `proto` is no holder of a realm it lists, or whose `interfaceObject.proto` is no
 * constructor holder of one, whose global target is taken, and one whose `prototypeOf` names a holder the realm lacks or
 * one whose prototype isn't the entry's `proto`, since the entry goes in between.
 */
export function applyEnginePrototypes(
  sections: PlacedSections,
  overlay: EnginePrototypesOverlay,
  globals: Readonly<Record<Realm, string>>,
): void {
  for (const name of Object.keys(overlay).sort()) {
    const { realms: listed, owner, proto, prototypeOf, interfaceObject } = overlay[name] as EnginePrototype
    const refuse = (why: string) => new Error(`the engine prototype ${name} ${why}`)
    if (!listed.length) throw refuse('lists no realm')
    if (!prototypeOf.length) throw refuse('is the prototype of no holder')
    for (const realm of listed) {
      if (!realms.includes(realm)) throw refuse(`lists ${realm}, which is no realm`)
      const holders = sections.holders[realm]
      const targets = sections.targets[realm]
      if (Object.hasOwn(holders, name)) throw refuse(`is already a ${holders[name]!.kind} holder in ${realm}`)
      if (Object.hasOwn(holders, owner)) throw refuse(`has the interface object ${owner}, which is already a holder in ${realm}`)
      if (!Object.hasOwn(holders, proto)) throw refuse(`inherits from ${proto}, which is no holder in ${realm}`)
      if (holders[interfaceObject.proto]?.kind !== 'constructor') {
        throw refuse(`has an interface object inheriting from ${interfaceObject.proto}, which is no constructor holder in ${realm}`)
      }
      for (const below of prototypeOf) {
        const record = Object.hasOwn(holders, below) ? holders[below] : undefined
        if (record === undefined) throw refuse(`is the prototype of ${below}, which is no holder in ${realm}`)
        if (record.proto !== proto) {
          throw refuse(`goes between ${below} and ${proto}, but the prototype of ${below} is ${record.proto} in ${realm}`)
        }
      }
      const added = structuralTargets(name, overlay[name]!, globals[realm])
      for (const target of Object.keys(added)) {
        if (Object.hasOwn(targets, target)) throw refuse(`adds the target ${target}, which ${realm} already has`)
      }
      holders[name] = { kind: 'prototype', owner, proto }
      holders[owner] = { kind: 'constructor', owner, proto: interfaceObject.proto }
      for (const below of prototypeOf) holders[below] = { ...holders[below]!, proto: name }
      Object.assign(targets, added)
    }
  }
}

/**
 * The targets an engine prototype's entry adds in a realm whose global is `global`: the `global` target holding its
 * interface object, that object's `prototype`, and the prototype's own `constructor` and `@@toStringTag`.
 */
function structuralTargets(name: string, entry: EnginePrototype, global: string): Record<string, PlacedTarget> {
  const { engine: spec, owner } = entry
  return {
    [`${global}.${owner}`]: {
      owner: global,
      member: owner,
      holder: 'global',
      kind: 'interface',
      spec,
      holds: owner,
      descriptor: globalProperty,
    },
    [`${owner}.prototype`]: {
      owner,
      member: 'prototype',
      holder: 'constructor',
      kind: 'value',
      spec,
      holds: name,
      descriptor: prototypeProperty,
    },
    [`${name}.constructor`]: {
      owner,
      member: 'constructor',
      holder: 'prototype',
      kind: 'function',
      spec,
      holds: owner,
      descriptor: constructorProperty,
    },
    [`${name}.@@toStringTag`]: { owner, member: '@@toStringTag', holder: 'prototype', kind: 'value', spec, descriptor: tag },
  }
}

/**
 * Refuses a target on an engine prototype or its interface object other than the structural ones its entry adds (§4):
 * the prototype's own members are `constructor` and `@@toStringTag`, and the interface object's only one is
 * `prototype`.
 */
export function refuseEnginePrototypeMembers(
  sections: PlacedSections,
  overlay: EnginePrototypesOverlay,
  globals: Readonly<Record<Realm, string>>,
): void {
  for (const name of Object.keys(overlay).sort()) {
    const entry = overlay[name]!
    for (const realm of entry.realms as Realm[]) {
      const allowed = new Set(Object.keys(structuralTargets(name, entry, globals[realm])))
      const on = (holder: string, target: string) => target.startsWith(`${holder}.`) || target.startsWith(`${holder}["`)
      const member = Object.keys(sections.targets[realm]).find(
        (target) => !allowed.has(target) && (on(name, target) || on(entry.owner, target)),
      )
      if (member !== undefined) {
        throw new Error(
          `the engine prototype ${name} has only constructor and @@toStringTag, but ${member} is a target in ${realm}`,
        )
      }
    }
  }
}

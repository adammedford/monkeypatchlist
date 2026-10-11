import { realms, type ProseMember } from '../../src/catalog.ts'
import type { PlacedSections } from './targets.ts'

/**
 * The curated overlay of own members a spec defines in prose on each instance of an interface, rather than in IDL
 * (§4 Sources), by interface and then member: HTML's Location object setup steps give every `Location` object its own
 * `valueOf` and `@@toPrimitive`.
 */
export type ProseMembersOverlay = Record<string, Record<string, ProseMember>>

/**
 * Adds each prose member to its interface's per-instance members, in every realm that exposes the interface, so a
 * platform singleton of that interface owns it as an `instance` target (`location.valueOf`). Refuses a member of an
 * interface no realm exposes, one its IDL already defines on the interface's prototype or instances, and one whose kind
 * and descriptor disagree.
 */
export function applyProseMembers(sections: PlacedSections, overlay: ProseMembersOverlay): void {
  for (const owner of Object.keys(overlay).sort()) {
    const members = overlay[owner] ?? {}
    let exposed = false
    for (const realm of realms) {
      const { holders, targets, instanceMembers } = sections
      // The interface's prototype object, named by its qualified name (`WebAssembly.Memory.prototype`).
      const prototype = Object.keys(holders[realm]).find((name) => {
        const holder = holders[realm][name]
        return holder?.kind === 'prototype' && holder.owner === owner && name.endsWith('.prototype')
      })
      if (prototype === undefined) continue
      exposed = true
      for (const member of Object.keys(members).sort()) {
        const { spec, kind, descriptor } = members[member] as ProseMember
        const refuse = (why: string) => new Error(`the prose member ${owner}.${member} ${why}`)
        const perInstance = instanceMembers[realm][owner] ?? {}
        if (Object.hasOwn(targets[realm], `${prototype}.${member}`) || Object.hasOwn(perInstance, member)) {
          throw refuse(`is already defined by the IDL of ${owner}`)
        }
        if ((kind === 'accessor') !== (descriptor.type === 'accessor')) {
          throw refuse(`has kind ${kind}, but ${descriptor.type === 'accessor' ? 'an accessor' : 'a data'} descriptor`)
        }
        const record = { owner, member, kind, spec, descriptor: { ...descriptor } }
        ;(instanceMembers[realm][owner] ??= Object.create(null) as Record<string, typeof record>)[member] = record
      }
    }
    if (!exposed) {
      const [member] = Object.keys(members).sort()
      throw new Error(`the prose member ${owner}.${member ?? '*'} is on ${owner}, which no realm exposes`)
    }
  }
}

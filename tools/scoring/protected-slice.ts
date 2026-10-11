// The protected slice (§12 Matching), taken from the catalog's protected-surface list. Every bar is judged on it (§20).
//
// It is the protected surface a `--surface protected` scan reports, from the findings module, so the bars and the scan
// never disagree: catalog targets an entry names, shadowing writes through `shadows`, named adds and prototype changes
// on whole entries, and wildcards over native members, a singleton's through its own entry or covered members. It
// never matches a pattern wildcard of non-native adds (`<holder>.<prefix>*`). One thing is the slice's own: a canned
// report or label may spell a `prototype-change` target as the prototype's own name, which it reads as
// `<prototype>.[[Prototype]]`.

import type { Realm, SerializedCatalog } from '../../src/catalog.ts'
import { protectedSurface } from '../../src/packages/findings/index.ts'

/** A target as the slice sees it: a finding's, or a positive's. */
export interface SliceTarget {
  realm: Realm
  name: string
  shadows?: string
  /** The effects it has. */
  effects: readonly string[]
}

export type IsProtected = (target: SliceTarget) => boolean

export function protectedSlice(catalog: SerializedCatalog): IsProtected {
  const covers = protectedSurface(catalog)
  return ({ realm, name, shadows, effects }) => {
    const target = { realm, name, ...(shadows === undefined ? {} : { shadows }) }
    if ((effects.length ? effects : ['']).some((effect) => covers(target, effect))) return true
    const prototypeSpelling = effects.includes('prototype-change') && !name.endsWith('.[[Prototype]]')
    return prototypeSpelling && covers({ realm, name: `${name}.[[Prototype]]` }, 'prototype-change')
  }
}

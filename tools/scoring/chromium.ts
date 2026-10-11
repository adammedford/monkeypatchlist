// Which natives Chromium has, for §20's rule that a mutation observed in Chromium is never `guarded-native-absence`
// for a guard on a feature Chromium has. Build-time only; never published.

import { readFileSync } from 'node:fs'
import type { Realm, SerializedCatalog } from '../../src/catalog.ts'
import { bcdShipping, type Bcd } from '../catalog-generator/cross-check.ts'

/** Whether Chromium has a catalog target. */
export type ChromiumHas = (realm: Realm, name: string) => boolean

/**
 * Chromium has a catalog target when BCD shows Chrome shipping the feature the catalog cross-check maps it to (§4
 * Sources: a released version, without a prefix or flag), and also when BCD has no feature for it: the catalog lists
 * only what a released engine ships, and the rule should flag, not excuse, a guard it can't place. BCD is the pinned
 * devDependency, read once, on first use.
 */
export function chromiumFromBcd(catalog: SerializedCatalog): ChromiumHas {
  let shipping: ((realm: Realm, name: string) => string[] | undefined) | undefined
  return (realm, name) => {
    if (shipping === undefined) {
      const bcd = JSON.parse(
        readFileSync(new URL('../../node_modules/@mdn/browser-compat-data/data.json', import.meta.url), 'utf8'),
      ) as Bcd
      shipping = bcdShipping(catalog, bcd)
    }
    return shipping(realm, name)?.includes('chrome') ?? true
  }
}

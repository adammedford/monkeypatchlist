// Visit order (§18 Context policy): results are independent of the order the resolver visits its work in. A shuffled
// resolver visits the calls of each function, and of each program, in a seeded pseudo-random order, so a permutation
// test can show that a scan's report stays byte-identical. It is for tests only; the CLI ships `jsResolver`.

import type { Resolver } from './lib/types.ts'
import { createJsResolver } from './lib/resolver.ts'

/** The JS resolver, visiting its call lists in an order `seed` shuffles (Fisher–Yates over a mulberry32 stream). */
export function shuffledResolver(seed: number): Resolver {
  let state = seed >>> 0
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return createJsResolver(undefined, (items) => {
    const out = [...items]
    for (let index = out.length - 1; index > 0; index--) {
      const other = Math.floor(next() * (index + 1))
      ;[out[index], out[other]] = [out[other]!, out[index]!]
    }
    return out
  })
}

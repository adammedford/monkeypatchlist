// Path helpers the build-time tools share. Build-time only; never published.

import { existsSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The validation corpus the tools and tests read by default: `corpus/` at the repository root, where `npm run
 * corpus:fetch` checks out the commit `corpus.lock.json` pins. Where `corpus` is a symbolic link, the directory it
 * links to; where it is missing, the path the fetch creates.
 */
export const corpusDir: string = (() => {
  const path = fileURLToPath(new URL('../corpus', import.meta.url))
  return existsSync(path) ? realpathSync(path) : path
})()

/** Whether `path` is `dir` or inside it, following the symbolic links of whatever part of each exists. */
export function isInside(path: string, dir: string): boolean {
  const from = realPath(dir)
  const to = realPath(path)
  const rel = relative(from, to)
  // `..cache` is inside `dir`; only `..` itself, or a path through it, leaves it.
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function realPath(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  return parent === path ? path : join(realPath(parent), basename(path))
}

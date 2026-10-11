// The corpus fetch. The validation corpus lives in its own repository, and `corpus.lock.json` pins the commit of it that
// this repository's tools and CI use. This puts that commit at the corpus path the tools read. Build-time only; never
// published.
//
//   npm run corpus:fetch [-- --lock <file>] [-- --dest <dir>]
//
// The lock defaults to `corpus.lock.json` at the repository root, and the destination to `corpus/` there
// (tools/paths.ts). Each outcome:
//
// - A destination that is a checkout is moved to the pinned commit; one already there is left alone, build output
//   included.
// - A missing destination is cloned at the pinned commit.
// - A destination that is not a checkout is never replaced: it is the corpus tracked in this repository.
// - A lock with no commit means the corpus has not moved out yet: the corpus in this repository is used, and a missing
//   one is an error.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { corpusDir } from '../paths.ts'

export interface Io {
  stdout: { write(text: string): void }
  stderr: { write(text: string): void }
}

const repository = fileURLToPath(new URL('../../', import.meta.url))
const defaults = {
  lock: join(repository, 'corpus.lock.json'),
  dest: corpusDir,
}

const usage = 'usage: node tools/corpus-fetch/cli.ts [--lock <file>] [--dest <dir>]'

class UsageError extends Error {}
class FetchError extends Error {}

/**
 * Runs the command. Returns the exit code:
 *
 * - 0: the destination holds the pinned commit, or the corpus is in this repository and no commit is pinned
 * - 1: no corpus to use, a destination that isn't a checkout, or git failed
 * - 2: a bad flag, or a lock that isn't usable
 */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { lock: { type: 'string' }, dest: { type: 'string' } },
      strict: true,
    })
    const dest = resolve(values.dest ?? defaults.dest)
    const { repository: remote, commit } = readLock(resolve(values.lock ?? defaults.lock))

    if (commit === '') {
      if (!existsSync(dest)) throw new FetchError(`corpus.lock.json pins no commit and ${dest} does not exist`)
      io.stdout.write('corpus-fetch: no commit pinned; using the corpus in this repository\n')
      return 0
    }
    fetchCorpus(remote, commit, dest)
    io.stdout.write(`corpus-fetch: ${dest} is at ${commit}\n`)
    return 0
  } catch (error) {
    if (error instanceof UsageError || (error instanceof TypeError && 'code' in error)) {
      io.stderr.write(`corpus-fetch: ${error.message}\n${usage}\n`)
      return 2
    }
    if (error instanceof FetchError) {
      io.stderr.write(`corpus-fetch: ${error.message}\n`)
      return 1
    }
    throw error
  }
}

function readLock(path: string): { repository: string; commit: string } {
  let lock: unknown
  try {
    lock = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new UsageError(`can't read the lock ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const { repository: remote, commit } = (lock ?? {}) as Record<string, unknown>
  if (typeof remote !== 'string' || remote === '') throw new UsageError(`${path} has no "repository"`)
  if (typeof commit !== 'string' || (commit !== '' && !/^[0-9a-f]{40}$/.test(commit))) {
    throw new UsageError(`${path}: "commit" must be a full 40-character commit hash (or "" before the corpus moves)`)
  }
  return { repository: remote, commit }
}

function git(cwd: string, ...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  } catch (error) {
    const stderr = (error as { stderr?: unknown }).stderr
    throw new FetchError(`git ${args.join(' ')} failed: ${typeof stderr === 'string' ? stderr.trim() : String(error)}`)
  }
}

function fetchCorpus(remote: string, commit: string, dest: string): void {
  if (existsSync(dest)) {
    if (!existsSync(join(dest, '.git'))) {
      throw new FetchError(`${dest} is not a checkout, so it is not replaced; remove it to fetch the corpus`)
    }
    if (head(dest) === commit) return
  } else {
    git(repository, 'init', '-q', dest)
  }
  // A pinned commit is fetched by hash, so a branch that moves, or is rewritten, can't change what CI builds.
  git(dest, 'fetch', '-q', '--depth', '1', remote, commit)
  git(dest, 'checkout', '-q', '--detach', commit)
  if (head(dest) !== commit) throw new FetchError(`${dest} is not at ${commit} after the checkout`)
}

function head(dir: string): string {
  try {
    return git(dir, 'rev-parse', 'HEAD')
  } catch {
    return ''
  }
}

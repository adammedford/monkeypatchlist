// The corpus fetch (tools/corpus-fetch): the validation corpus lives in its own repository, and the
// scanner repository pins the commit of it that its tools and CI use in `corpus.lock.json`.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { main } from '../tools/corpus-fetch/main.ts'
import { fixtureCorpus, scratchDir } from './support/fixture-corpus.ts'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8' }).trim()
}

/** A repository standing in for the corpus repository, with two commits. Returns its path and both commits. */
function corpusRepository(): { path: string; first: string; second: string } {
  const path = fixtureCorpus({ 'manifest.json': 'one\n', 'vendor/sources.json': '{}\n' })
  git(path, 'init', '-q')
  git(path, 'add', '.')
  git(path, 'commit', '-q', '-m', 'one')
  const first = git(path, 'rev-parse', 'HEAD')
  writeFileSync(join(path, 'manifest.json'), 'two\n')
  git(path, 'commit', '-q', '-am', 'two')
  return { path, first, second: git(path, 'rev-parse', 'HEAD') }
}

function lock(repository: string, commit: string): string {
  const file = join(scratchDir(), 'corpus.lock.json')
  writeFileSync(file, `${JSON.stringify({ repository, commit })}\n`)
  return file
}

async function run(...argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = ''
  let stderr = ''
  const code = await main(argv, { stdout: { write: (t) => void (stdout += t) }, stderr: { write: (t) => void (stderr += t) } })
  return { code, stdout, stderr }
}

describe('corpus:fetch', () => {
  test('clones the pinned commit into the destination, not the repository’s newest', async () => {
    const remote = corpusRepository()
    const dest = join(scratchDir(), 'corpus')

    const result = await run('--lock', lock(remote.path, remote.first), '--dest', dest)

    expect(result.code).toBe(0)
    expect(readFileSync(join(dest, 'manifest.json'), 'utf8')).toBe('one\n')
    expect(git(dest, 'rev-parse', 'HEAD')).toBe(remote.first)
  })

  test('moves an earlier checkout to a newly pinned commit', async () => {
    const remote = corpusRepository()
    const dest = join(scratchDir(), 'corpus')
    await run('--lock', lock(remote.path, remote.first), '--dest', dest)

    const result = await run('--lock', lock(remote.path, remote.second), '--dest', dest)

    expect(result.code).toBe(0)
    expect(readFileSync(join(dest, 'manifest.json'), 'utf8')).toBe('two\n')
  })

  test('leaves a checkout that is already at the pin alone, including files the build wrote', async () => {
    const remote = corpusRepository()
    const dest = join(scratchDir(), 'corpus')
    await run('--lock', lock(remote.path, remote.first), '--dest', dest)
    mkdirSync(join(dest, 'dist'))
    writeFileSync(join(dest, 'dist/built.js'), 'built')

    expect((await run('--lock', lock(remote.path, remote.first), '--dest', dest)).code).toBe(0)

    expect(existsSync(join(dest, 'dist/built.js'))).toBe(true)
  })

  test('refuses to replace a directory that is not a checkout', async () => {
    const remote = corpusRepository()
    const dest = fixtureCorpus({ 'manifest.json': 'in the scanner repository\n' })

    const result = await run('--lock', lock(remote.path, remote.first), '--dest', dest)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('not a checkout')
    expect(readFileSync(join(dest, 'manifest.json'), 'utf8')).toBe('in the scanner repository\n')
  })

  test('with no commit pinned, uses the corpus that is in this repository and fetches nothing', async () => {
    const dest = fixtureCorpus({ 'manifest.json': 'in tree\n' })

    const result = await run('--lock', lock('https://example.invalid/corpus.git', ''), '--dest', dest)

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('in this repository')
  })

  test('with no commit pinned and no corpus, fails', async () => {
    const result = await run('--lock', lock('https://example.invalid/corpus.git', ''), '--dest', join(scratchDir(), 'none'))

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no commit')
  })

  test('rejects a pin that is not a full commit hash, so a branch name can never move it', async () => {
    const remote = corpusRepository()

    const result = await run('--lock', lock(remote.path, 'main'), '--dest', join(scratchDir(), 'corpus'))

    expect(result.code).toBe(2)
    expect(result.stderr).toContain('40')
  })

  test('fails when the commit is not in the repository', async () => {
    const remote = corpusRepository()
    const dest = join(scratchDir(), 'corpus')

    const result = await run('--lock', lock(remote.path, 'f'.repeat(40)), '--dest', dest)

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('corpus-fetch')
  })
})

describe('in CI', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const jobs = workflow.split(/\n {2}(?=[a-z-]+:\n {4}runs-on)/).slice(1)

  test('every job fetches the pinned corpus before it uses it', () => {
    expect(jobs).toHaveLength(2)
    for (const job of jobs) {
      const fetch = job.indexOf('run: npm run corpus:fetch\n')
      const first = Math.min(...['npm run fixtures:check', 'npm ci\n        working-directory', 'npm run build\n'].map((use) => job.indexOf(use)).filter((at) => at >= 0))
      expect(fetch).toBeGreaterThan(-1)
      expect(fetch).toBeLessThan(first)
    }
  })

  test('the corpus job fills vendor/ after installing the corpus’s packages and before it builds and scans', () => {
    const job = jobs.find((candidate) => candidate.includes('corpus:check')) ?? ''
    const install = job.indexOf('npm ci\n        working-directory')
    const vendor = job.indexOf('npm run vendor\n')
    expect(vendor).toBeGreaterThan(install)
    expect(vendor).toBeLessThan(job.indexOf('npm run build\n          for manifest'))
  })

  test('the lock names a repository and pins either nothing or a full commit hash', () => {
    const lock = JSON.parse(readFileSync(new URL('../corpus.lock.json', import.meta.url), 'utf8')) as Record<string, string>
    expect(lock.repository).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\.git$/)
    expect(lock.commit).toMatch(/^([0-9a-f]{40})?$/)
  })
})

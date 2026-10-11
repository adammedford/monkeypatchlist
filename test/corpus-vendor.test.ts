// The corpus's vendor step (corpus/scripts/vendor.mjs): fills `vendor/` from `sources.json`, a CDN
// download or an npm package file for each entry, and checks every file against its sha256.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { corpusDir } from '../tools/paths.ts'
import { fixtureCorpus } from './support/fixture-corpus.ts'

const script = join(corpusDir, 'scripts/vendor.mjs')
const hook = fileURLToPath(new URL('./support/fake-cdn-hook.ts', import.meta.url))
const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

// The CDN is served in the child itself: a hook loaded with `--import` replaces its global `fetch` with one that answers
// from this table and logs each URL it is asked for. No port is bound and nothing leaves the machine.
const origin = 'https://cdn.example'
const cdn: Record<string, string> = {
  [`${origin}/cdn.js`]: 'cdn body',
  [`${origin}/changed.js`]: 'not what was pinned',
}
let requests: string[] = []

/** A corpus root with a `node_modules/pkg/dist/lib.js` and a `vendor/sources.json` of the given entries. */
function corpus(entries: Record<string, Record<string, string>>): string {
  const root = fixtureCorpus({ 'node_modules/pkg/dist/lib.js': 'npm body' })
  mkdirSync(join(root, 'vendor'), { recursive: true })
  writeFileSync(join(root, 'vendor/sources.json'), JSON.stringify(entries))
  return root
}

/** Runs the script with the fake CDN, and records the URLs it fetched in `requests`. */
function run(root: string): { status: number | null; stderr: string } {
  const log = join(root, 'fetched.log')
  const child = spawnSync(process.execPath, ['--import', hook, script, '--root', root], {
    env: { ...process.env, MONKEYPATCHLIST_FAKE_CDN: JSON.stringify(cdn), MONKEYPATCHLIST_FAKE_CDN_LOG: log },
    encoding: 'utf8',
  })
  requests = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter((line) => line !== '') : []
  return { status: child.status, stderr: child.stderr }
}

// The script is the corpus's, so a checkout that hasn't fetched the corpus (`npm run corpus:fetch`) skips these.
describe.skipIf(!existsSync(script))('vendor.mjs', () => {
  test('downloads a CDN entry and takes an npm entry from node_modules, both pinned by sha256', () => {
    const root = corpus({
      [`${origin}/cdn.js`]: { file: 'cdn.js', sha256: sha('cdn body') },
      'https://floating.example/floating.js': { file: 'lib.js', sha256: sha('npm body'), npm: 'pkg/dist/lib.js' },
    })
    expect(run(root).status).toBe(0)
    expect(readFileSync(join(root, 'vendor/cdn.js'), 'utf8')).toBe('cdn body')
    expect(readFileSync(join(root, 'vendor/lib.js'), 'utf8')).toBe('npm body')
    // The npm entry's CDN URL is only the key the pages load; it is never fetched.
    expect(requests).toEqual([`${origin}/cdn.js`])
  })

  test('refuses a CDN body that differs from the pinned sha256 and writes nothing', () => {
    const root = corpus({ [`${origin}/changed.js`]: { file: 'changed.js', sha256: sha('what was pinned') } })
    const { status, stderr } = run(root)
    expect(status).toBe(1)
    expect(stderr).toContain('changed.js')
    expect(stderr).toContain('sha256')
    expect(() => readFileSync(join(root, 'vendor/changed.js'))).toThrow()
  })

  test('refuses an npm file that differs from the pinned sha256', () => {
    const root = corpus({ 'https://floating.example/x.js': { file: 'lib.js', sha256: sha('other'), npm: 'pkg/dist/lib.js' } })
    expect(run(root).status).toBe(1)
    expect(() => readFileSync(join(root, 'vendor/lib.js'))).toThrow()
  })

  test('leaves a file that already matches its sha256 alone and downloads nothing', () => {
    const root = corpus({ [`${origin}/cdn.js`]: { file: 'cdn.js', sha256: sha('cdn body') } })
    writeFileSync(join(root, 'vendor/cdn.js'), 'cdn body')
    expect(run(root).status).toBe(0)
    expect(requests).toEqual([])
  })

  test('replaces a file that no longer matches its sha256', () => {
    const root = corpus({ [`${origin}/cdn.js`]: { file: 'cdn.js', sha256: sha('cdn body') } })
    writeFileSync(join(root, 'vendor/cdn.js'), 'stale')
    expect(run(root).status).toBe(0)
    expect(readFileSync(join(root, 'vendor/cdn.js'), 'utf8')).toBe('cdn body')
  })

  test('rejects an npm path that leaves node_modules', () => {
    const root = corpus({ 'https://floating.example/x.js': { file: 'x.js', sha256: sha('x'), npm: '../vendor/sources.json' } })
    expect(run(root).status).toBe(1)
  })
})


// The public spec generator (tools/spec-generator): docs/spec.md is the working spec without its process record. The
// generation tests need the working spec, which only the private repository has; the leak checks run everywhere.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { leaks, publicSpec } from '../tools/spec-generator/generate.ts'

const root = join(import.meta.dirname, '..')
const sourcePath = join(root, '.scratch', 'platform-integrity-scanner', 'spec.md')
const adrFiles = readdirSync(join(root, 'docs', 'adr')).filter((name) => name.endsWith('.md'))
const hasSource = existsSync(sourcePath)

describe('publicSpec', () => {
  const source = hasSource ? readFileSync(sourcePath, 'utf8') : ''

  test.skipIf(!hasSource)('drops provenance tags, process links and ticket references, and keeps every section', () => {
    const spec = publicSpec({ source, adrFiles })
    expect(leaks(spec, { strict: true, adrFiles })).toEqual([])
    expect(spec).not.toMatch(/human, live|\.scratch|\(X\d+\)|ticket \d/)
    const headings = (text: string) => text.split('\n').filter((line) => /^##+ /.test(line))
    expect(headings(spec)).toEqual(headings(source).filter((line) => line !== '## Status'))
    expect(spec).toContain('| 11 | Fingerprints, baseline and `changed` | [0001](adr/0001-committed-json-baseline-no-sqlite.md)')
    expect(spec).toContain('([ADR 0005](adr/0005-fingerprints-key-on-the-containing-package.md))')
  })

  test.skipIf(!hasSource)('refuses a working spec where a targeted passage moved', () => {
    const moved = source.replace(' An alias holds the same interface object (ticket 100).', ' (ticket 100) An alias.')
    expect(() => publicSpec({ source: moved, adrFiles })).toThrow(/matches 0 times/)
  })

  test.skipIf(!hasSource)('refuses a status row citing an ADR that docs/adr/ lacks', () => {
    expect(() => publicSpec({ source, adrFiles: adrFiles.filter((name) => !name.startsWith('0016-')) })).toThrow(
      /ADR 0016/,
    )
  })

  test.skipIf(!hasSource)('docs/spec.md is the fresh generation', () => {
    expect(readFileSync(join(root, 'docs', 'spec.md'), 'utf8')).toBe(publicSpec({ source, adrFiles }))
  })
})

describe('leaks', () => {
  test('finds process links, provenance tags and, when strict, ticket, pre-flight and question references', () => {
    const text = [
      'See [Re-scope](../../.scratch/platform-integrity-scanner/issues/61-re-scope-the-r0-bar.md).',
      'Decided (human, live, 2026-09-29, X42).',
      'As ticket 100 found, and the second pre-flight.',
      'Agents read [the guide](../docs/agents/domain.md).',
      'A missing record: [ADR 0099](adr/0099-nothing.md).',
      'A link in code is not a link: `[x](../.scratch/a.md)`.',
      'Code is still read: `.scratch/b` and `(human, live, x)`.',
    ].join('\n')
    expect(leaks(text, { strict: false, adrFiles })).toEqual([
      'line 1: links into the private process record: ../../.scratch/platform-integrity-scanner/issues/61-re-scope-the-r0-bar.md',
      'line 2: carries a provenance tag',
      'line 4: links into the private process record: ../docs/agents/domain.md',
      'line 5: links to a missing decision record: adr/0099-nothing.md',
      'line 7: carries a provenance tag',
    ])
    expect(leaks(text, { strict: true }).filter((problem) => problem.includes('refers to'))).toEqual([
      'line 1: refers to the private process record: ".scratch"',
      'line 2: refers to the private process record: "X42"',
      'line 3: refers to the private process record: "ticket 100"',
      'line 6: refers to the private process record: ".scratch"',
      'line 7: refers to the private process record: ".scratch"',
    ])
  })

  test('the committed public design docs carry none', () => {
    const read = (path: string) => readFileSync(join(root, path), 'utf8')
    expect(leaks(read('docs/spec.md'), { strict: true, adrFiles })).toEqual([])
    expect(leaks(read('CONTEXT.md'), { strict: false, adrFiles })).toEqual([])
    for (const name of adrFiles) expect(leaks(read(`docs/adr/${name}`), { strict: false, adrFiles })).toEqual([])
  })
})

describe('npm run spec:check', () => {
  test('passes where the working spec is absent, as in the public repository, checking the docs for leaks only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'monkeypatchlist-spec-check-'))
    try {
      for (const path of ['package.json', 'tools/spec-generator', 'docs/spec.md', 'docs/adr', 'CONTEXT.md'])
        cpSync(join(root, path), join(dir, path), { recursive: true })
      const run = spawnSync(process.execPath, ['tools/spec-generator/cli.ts', '--check'], { cwd: dir, encoding: 'utf8' })
      expect(run.stderr).toBe('')
      expect(run.stdout).toBe('The working spec is absent; docs/spec.md was checked for leaks only.\n')
      expect(run.status).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

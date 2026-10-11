// `monkeypatchlist --version` (§16 Flags): one line on stdout, with the versions a report's `tool` block records.

import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { exitCodes } from '../src/cli.ts'
import { jsResolver } from '../src/packages/analysis/index.ts'
import { runCli, scanBuild, workingDir } from './support/fixture-build.ts'

const packageVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version

describe('monkeypatchlist --version (§16 Flags)', () => {
  test.each(['--version', '-v'])(
    '%s prints exactly one line, `monkeypatchlist <version> · catalog <n> · analyzer <analyzerVersion>`, and exits 0',
    async (flag) => {
      const run = await runCli([flag])

      expect(run).toEqual({
        exitCode: exitCodes.success,
        stdout:
          `monkeypatchlist ${packageVersion} · catalog ${loadCatalog().metadata.catalogVersion} · ` +
          `analyzer ${jsResolver.analyzerVersion}\n`,
        stderr: '',
      })
      expect(run.stdout).toMatch(/^monkeypatchlist \S+ · catalog \d+ · analyzer \S+\n$/)
    },
  )

  test("prints the values a scan's report records in its tool block", async () => {
    const { report } = await scanBuild({ 'index.html': '<script>window.fetch = f</script>' })
    const { tool } = report

    expect((await runCli(['--version'])).stdout).toBe(
      `monkeypatchlist ${tool.monkeypatchlistVersion} · catalog ${tool.catalogVersion} · analyzer ${tool.analyzerVersion}\n`,
    )
  })

  test('reads the catalog and resolver the CLI runs with, not fixed values', async () => {
    const catalog = loadCatalog()
    const run = await runCli(['--version'], {
      deps: {
        loadCatalog: () => ({ ...catalog, metadata: { ...catalog.metadata, catalogVersion: 7 } }),
        resolver: { ...jsResolver, analyzerVersion: 'js-test' },
      },
    })

    expect(run.stdout).toBe(`monkeypatchlist ${packageVersion} · catalog 7 · analyzer js-test\n`)
  })

  test('reads no config file and no build directory', async () => {
    const cwd = workingDir({ 'monkeypatchlist.config.json': '{ not json' })

    expect(await runCli(['--version'], { cwd })).toMatchObject({ exitCode: exitCodes.success, stderr: '' })
  })

  test.each([
    ['--version', 'scan'],
    ['-v', '--json', '-'],
    ['--version', '--version'],
  ])('%s followed by anything is a usage error (exit 2), and prints no version', async (...argv) => {
    const run = await runCli(argv)

    expect(run.exitCode).toBe(exitCodes.usage)
    expect(run.stdout).toBe('')
    expect(run.stderr.split('\n')[0]).toBe(`monkeypatchlist: ${argv[0]} takes no other arguments`)
  })

  test('is a usage error after a command, which takes no such flag', async () => {
    const run = await runCli(['scan', '.', '--version'])

    expect(run.exitCode).toBe(exitCodes.usage)
    expect(run.stdout).toBe('')
  })

  test('the usage text lists it', async () => {
    const run = await runCli([])

    expect(run.exitCode).toBe(exitCodes.usage)
    expect(run.stderr.split('\n')).toContain('       monkeypatchlist --version | -v')
  })
})

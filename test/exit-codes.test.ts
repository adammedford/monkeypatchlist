import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { jsResolver } from '../src/packages/analysis/index.ts'
import { defaultMap, fixtureBuild, runCli, workingDir } from './support/fixture-build.ts'

const build = () => fixtureBuild({ 'index.html': '<script>window.fetch = f</script>' })

describe('monkeypatchlist exit codes (§16)', () => {
  test('0 on success', async () => {
    expect((await runCli(['scan', build(), '--map', defaultMap])).exitCode).toBe(0)
  })

  test.each([
    ['no command', []],
    ['an unknown command', ['frobnicate']],
    ['baseline with no baseline command', ['baseline']],
    ['an unknown baseline command', ['baseline', 'frobnicate', '<build>', '--map', defaultMap]],
    ['baseline init with no build directory', ['baseline', 'init', '--map', defaultMap]],
    ['baseline update with no build directory', ['baseline', 'update', '--map', defaultMap]],
    ['no build directory', ['scan', '--map', defaultMap]],
    ['an unknown flag', ['scan', '<build>', '--map', defaultMap, '--frobnicate']],
    ['no --map', ['scan', '<build>']],
    ['a --map without =', ['scan', '<build>', '--map', 'https://app.example/']],
    ['a --map whose prefix is no URL', ['scan', '<build>', '--map', 'app.example=.']],
    ['a --map whose prefix is not http(s)', ['scan', '<build>', '--map', 'file:///srv/=.']],
    ['a --map prefix given twice', ['scan', '<build>', '--map', defaultMap, '--map', 'https://APP.example=static']],
    ['an --entry with @<url> and no file', ['scan', '<build>', '--map', defaultMap, '--entry', '@https://app.example/']],
    ['an --entry whose @<url> is not http(s)', ['scan', '<build>', '--map', defaultMap, '--entry', 'a.html@file:///a']],
    ['an empty --entry', ['scan', '<build>', '--map', defaultMap, '--entry', '']],
    [
      'the same entry document twice',
      ['scan', '<build>', '--map', defaultMap, '--entry', 'index.html', '--entry', 'index.html@https://app.example/'],
    ],
    ['--json without a value', ['scan', '<build>', '--map', defaultMap, '--json']],
    ['a build directory that does not exist', ['scan', '<missing>', '--map', defaultMap]],
    ['a second positional argument', ['scan', '<build>', 'extra', '--map', defaultMap]],
    ['--config without a value', ['scan', '<build>', '--map', defaultMap, '--config']],
    ['--config given twice', ['scan', '<build>', '--map', defaultMap, '--config', 'a.json', '--config', 'b.json']],
    ['--config naming a directory', ['scan', '<build>', '--map', defaultMap, '--config', '<build>.json']],
    ['--baseline without a value', ['scan', '<build>', '--map', defaultMap, '--baseline']],
    ['--baseline given twice', ['scan', '<build>', '--map', defaultMap, '--baseline', 'a.json', '--baseline', 'b.json']],
    ['--baseline on baseline init', ['baseline', 'init', '<build>', '--map', defaultMap, '--baseline', 'a.json']],
    ['--fail-on without a value', ['scan', '<build>', '--map', defaultMap, '--fail-on']],
    ['--fail-on removed, which cannot gate', ['scan', '<build>', '--map', defaultMap, '--fail-on', 'added,removed']],
    ['--fail-on unconfirmed, which cannot gate', ['scan', '<build>', '--map', defaultMap, '--fail-on', 'unconfirmed']],
    ['--fail-on existing', ['scan', '<build>', '--map', defaultMap, '--fail-on', 'existing']],
    ['--fail-on naming a state twice', ['scan', '<build>', '--map', defaultMap, '--fail-on', 'added,added']],
    ['--fail-on with an empty state', ['scan', '<build>', '--map', defaultMap, '--fail-on', 'added,']],
    ['--fail-on given twice', ['scan', '<build>', '--map', defaultMap, '--fail-on', 'added', '--fail-on', 'changed']],
    ['--fail-on on baseline init', ['baseline', 'init', '<build>', '--map', defaultMap, '--fail-on', 'added']],
    ['--baseline on baseline update', ['baseline', 'update', '<build>', '--map', defaultMap, '--baseline', 'a.json']],
    ['--fail-on on baseline update', ['baseline', 'update', '<build>', '--map', defaultMap, '--fail-on', 'added']],
    ['--allow-incomplete with a value', ['scan', '<build>', '--map', defaultMap, '--allow-incomplete=yes']],
    ['--allow-downgrade on scan', ['scan', '<build>', '--map', defaultMap, '--allow-downgrade']],
    [
      '--allow-downgrade with a value',
      ['baseline', 'update', '<build>', '--map', defaultMap, '--allow-downgrade=yes'],
    ],
    [
      '--allow-downgrade with a value on baseline init',
      ['baseline', 'init', '<build>', '--map', defaultMap, '--allow-downgrade=1'],
    ],
  ])('2 on bad flags: %s', async (_, argv) => {
    const dir = build()
    mkdirSync(`${dir}.json`)
    const args = argv.map((arg) =>
      arg.startsWith('<build>') ? dir + arg.slice('<build>'.length) : arg === '<missing>' ? join(dir, 'missing') : arg,
    )

    const run = await runCli(args)

    expect(run.exitCode).toBe(2)
    expect(run.stdout).toBe('')
    expect(run.stderr).not.toBe('')
  })

  test('3 on an incomplete scan under --fail-on', async () => {
    const dir = fixtureBuild({ 'index.html': '<script src="missing.js"></script>' })
    const cwd = workingDir()
    const init = await runCli(['baseline', 'init', dir, '--map', defaultMap, '--allow-incomplete'], { cwd })
    expect(init.exitCode).toBe(0)

    const run = await runCli(['scan', dir, '--map', defaultMap, '--fail-on', 'added'], { cwd })

    expect(run.exitCode).toBe(3)
  })

  test('3 when baseline init or baseline update refuses an incomplete scan', async () => {
    const dir = fixtureBuild({ 'index.html': '<script src="missing.js"></script>' })
    const cwd = workingDir()

    const init = await runCli(['baseline', 'init', dir, '--map', defaultMap], { cwd })
    const allowed = await runCli(['baseline', 'init', dir, '--map', defaultMap, '--allow-incomplete'], { cwd })
    const update = await runCli(['baseline', 'update', dir, '--map', defaultMap], { cwd })

    expect([init.exitCode, allowed.exitCode, update.exitCode]).toEqual([3, 0, 3])
  })

  test('4 on an internal error: an exception inside a module', async () => {
    const failing = {
      analyzerVersion: jsResolver.analyzerVersion,
      analyzeGroup: () => {
        throw new Error('boom')
      },
    }

    const run = await runCli(['scan', build(), '--map', defaultMap, '--json', '-'], { deps: { resolver: failing } })

    expect(run.exitCode).toBe(4)
    expect(run.stdout).toBe('')
    expect(run.stderr).toContain('boom')
  })
})

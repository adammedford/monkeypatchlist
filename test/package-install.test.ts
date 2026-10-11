import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, onTestFinished, test } from 'vitest'
import { assertValidReport, defaultMap, fixtureBuild } from './support/fixture-build.ts'

const root = fileURLToPath(new URL('../', import.meta.url))

describe('published package', () => {
  test('the npm pack tarball installs into a clean directory and runs monkeypatchlist scan on a fixture', () => {
    const work = mkdtempSync(join(tmpdir(), 'monkeypatchlist-pack-'))
    onTestFinished(() => rmSync(work, { recursive: true, force: true }))
    // `prepack` builds dist/ first, so the tarball holds the current sources.
    execFileSync('npm', ['pack', '--pack-destination', work], { cwd: root, stdio: 'pipe' })
    const [tarball] = readdirSync(work).filter((name) => name.endsWith('.tgz'))
    expect(tarball).toBeDefined()

    const app = join(work, 'app')
    mkdirSync(app)
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'monkeypatchlist-install-check', private: true }))
    execFileSync('npm', ['install', '--prefer-offline', '--no-audit', '--no-fund', join(work, tarball!)], {
      cwd: app,
      stdio: 'pipe',
    })

    const bin = join(app, 'node_modules', '.bin', 'monkeypatchlist')
    const build = fixtureBuild({ 'index.html': '<script src="main.js"></script>', 'main.js': 'window.fetch = function(){}' })
    const report = JSON.parse(
      execFileSync(bin, ['scan', build, '--map', defaultMap, '--json', '-'], { cwd: app, encoding: 'utf8' }),
    )
    assertValidReport(report)
    expect(report.findings.map((finding: { fingerprint: string }) => finding.fingerprint)).toEqual([
      'window|Window.fetch|replace|unknown',
    ])

    // The installed binary's `--version` prints the versions its report's tool block records.
    const { tool } = report
    expect(execFileSync(bin, ['--version'], { cwd: app, encoding: 'utf8' })).toBe(
      `monkeypatchlist ${tool.monkeypatchlistVersion} · catalog ${tool.catalogVersion} · analyzer ${tool.analyzerVersion}\n`,
    )

    // The report schema ships, exported as `monkeypatchlist/report.schema.json`.
    const schema = execFileSync(
      'node',
      ['--input-type=module', '-e', "process.stdout.write(import.meta.resolve('monkeypatchlist/report.schema.json'))"],
      { cwd: app, encoding: 'utf8' },
    )
    expect(readFileSync(fileURLToPath(schema), 'utf8')).toBe(readFileSync(join(root, 'schema/report.schema.json'), 'utf8'))

    const usage = spawnSync(bin, ['scan', build], { cwd: app, encoding: 'utf8' })
    expect(usage.status).toBe(2)
    expect(usage.stdout).toBe('')

    // The config schema ships, exported as `monkeypatchlist/config.schema.json`, and the installed binary validates a
    // monkeypatchlist.config.json in its working directory against it.
    const configSchema = execFileSync(
      'node',
      ['--input-type=module', '-e', "process.stdout.write(import.meta.resolve('monkeypatchlist/config.schema.json'))"],
      { cwd: app, encoding: 'utf8' },
    )
    expect(readFileSync(fileURLToPath(configSchema), 'utf8')).toBe(
      readFileSync(join(root, 'schema/config.schema.json'), 'utf8'),
    )
    const mappings = [{ url: 'https://app.example/', dir: '.' }]
    writeFileSync(join(app, 'monkeypatchlist.config.json'), JSON.stringify({ name: 'Installed', mappings }))
    const configured = JSON.parse(execFileSync(bin, ['scan', build, '--json', '-'], { cwd: app, encoding: 'utf8' }))
    expect(configured.application).toEqual({ name: 'Installed' })
    writeFileSync(join(app, 'monkeypatchlist.config.json'), JSON.stringify({ mappings: [], frobnicate: true }))
    const invalid = spawnSync(bin, ['scan', build], { cwd: app, encoding: 'utf8' })
    expect(invalid.status).toBe(2)
    expect(invalid.stderr).toContain('/frobnicate: unknown key')
  }, 180_000)
})

// The cost benchmark (tools/cost-benchmark, spec §18 Target). It scans every corpus site cold, and the scale
// fixture at 1, 2.5 and 5 MB, with the production `monkeypatchlist scan`, measuring each link group's time and peak heap,
// then rescans each corpus site with every step budget and cap raised to count budget-driven variance. It is run
// on demand and is not a gate. Tests run it over small fixture corpora.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { defaultBudget, type Budget } from '../src/packages/analysis/index.ts'
import { main, type Deps } from '../tools/cost-benchmark/main.ts'
import { fixtureCorpus, scratchDir } from './support/fixture-corpus.ts'

/**
 * A built fixture corpus: `files` (corpus-relative path → contents), plus the `manifest.json` the corpus build writes
 * beside each `dist/` (the corpus root's, each variant's and the scale fixture's), with the sha256 of every file under it.
 */
function builtCorpus(files: Record<string, string>): string {
  const manifests: Record<string, Record<string, string>> = {}
  for (const [path, text] of Object.entries(files)) {
    const match = /^((?:variants\/[^/]+\/|scale\/)?)dist\/(.+)$/.exec(path)
    if (match === null) continue
    const [, root = '', file = ''] = match
    manifests[root] ??= {}
    manifests[root][file] = createHash('sha256').update(text).digest('hex')
  }
  const written = Object.fromEntries(
    Object.entries(manifests).map(([root, hashes]) => [
      `${root}manifest.json`,
      `${JSON.stringify({ node: 'v26.8.1', bundlers: {}, files: hashes }, null, 1)}\n`,
    ]),
  )
  return fixtureCorpus({ ...files, ...written })
}

/** A build directory's files: an `index.html` that loads `main.js`, and `main.js`. */
function site(path: string, code: string): Record<string, string> {
  return { [`${path}/index.html`]: '<script src="main.js"></script>', [`${path}/main.js`]: code }
}

interface Run {
  exitCode: number
  stdout: string
  stderr: string
}

async function benchmark(argv: string[], deps: Partial<Deps> = {}): Promise<Run> {
  let stdout = ''
  let stderr = ''
  const io = {
    stdout: { write: (text: string) => void (stdout += text) },
    stderr: { write: (text: string) => void (stderr += text) },
  }
  const exitCode = await main(argv, io, deps)
  return { exitCode, stdout, stderr }
}

/** The results file the benchmark wrote into `out`. */
function results(out: string) {
  return JSON.parse(readFileSync(join(out, 'cost-benchmark.json'), 'utf8'))
}

/** A site's 15 reruns each start a worker thread that loads the catalog, so a test that runs them takes seconds. */
const reruns = 120_000

const patch = 'window.fetch = function () {}; history.pushState = function () {}\n'
const bigger = `${patch}${'var filler = [1, 2, 3].map(function (n) { return n * 2 });\n'.repeat(200)}`

describe('one command runs the benchmark', () => {
  test('it writes machine-readable results and a summary table, measuring every link group', async () => {
    const corpus = builtCorpus({
      ...site('dist/webpack/otel/maps', patch),
      ...site('dist/webpack/otel/nomaps', bigger),
      'static-sites/control/index.html': '<p>nothing</p>',
    })
    const out = scratchDir()

    const run = await benchmark(['--corpus', corpus, '--out', out, '--no-rerun'])

    expect(run.exitCode, run.stderr).toBe(0)
    const written = results(out)
    expect(written.sites.map((s: { id: string }) => s.id)).toEqual([
      'dist/webpack/otel/maps',
      'dist/webpack/otel/nomaps',
      'static-sites/control',
    ])
    const [maps, nomaps, control] = written.sites
    expect(maps.groups).toHaveLength(1)
    expect(maps.groups[0]).toMatchObject({
      entry: 'https://app.corpus.test/main.js',
      members: ['https://app.corpus.test/main.js'],
      bytes: Buffer.byteLength(patch),
    })
    expect(maps.groups[0].ms).toBeGreaterThan(0)
    expect(maps.groups[0].peakHeapBytes).toBeGreaterThan(0)
    expect(maps.groups[0].secondsPerMB).toBeCloseTo(maps.groups[0].ms / 1000 / (Buffer.byteLength(patch) / 1e6))
    expect(maps.groups[0].heapPerByte).toBeCloseTo(maps.groups[0].peakHeapBytes / Buffer.byteLength(patch))
    expect(nomaps.groups[0].bytes).toBe(Buffer.byteLength(bigger))
    expect(control.groups).toEqual([])
    const summary = readFileSync(join(out, 'cost-benchmark.md'), 'utf8')
    expect(summary).toContain('| dist/webpack/otel/nomaps |')
    expect(run.stdout).toContain(summary)
  })
})

describe('what the results name', { timeout: reruns }, () => {
  test('the worst artifact by time per MB and the worst link group by peak heap per byte, with their sites', async () => {
    const corpus = builtCorpus({
      ...site('dist/webpack/otel/maps', patch),
      ...site('dist/webpack/otel/nomaps', bigger),
    })
    const out = scratchDir()

    expect((await benchmark(['--corpus', corpus, '--out', out, '--no-rerun'])).exitCode).toBe(0)

    const { sites, worst } = results(out)
    const groups = sites.flatMap((s: { id: string; groups: object[] }) => s.groups.map((group) => ({ site: s.id, ...group })))
    const slowest = groups.reduce((a: { secondsPerMB: number }, b: { secondsPerMB: number }) =>
      b.secondsPerMB > a.secondsPerMB ? b : a,
    )
    const heaviest = groups.reduce((a: { heapPerByte: number }, b: { heapPerByte: number }) =>
      b.heapPerByte > a.heapPerByte ? b : a,
    )
    expect(worst.artifact).toMatchObject({ site: slowest.site, artifact: slowest.entry, secondsPerMB: slowest.secondsPerMB })
    expect(worst.linkGroup).toMatchObject({ site: heaviest.site, entry: heaviest.entry, heapPerByte: heaviest.heapPerByte })
    const summary = readFileSync(join(out, 'cost-benchmark.md'), 'utf8')
    expect(summary).toContain(`Worst artifact: ${slowest.entry} in ${slowest.site}`)
    expect(summary).toContain(`Worst link group: ${heaviest.entry} (1 members) in ${heaviest.site}`)
  })

  test('the machine it ran on, beside the 8 GB, 2 vCPU reference runner', async () => {
    const out = scratchDir()

    await benchmark(['--corpus', builtCorpus(site('dist/webpack/otel/maps', patch)), '--out', out])

    const { machine, reference, target } = results(out)
    expect(machine.cpus).toBeGreaterThan(0)
    expect(machine.memoryBytes).toBeGreaterThan(0)
    expect(machine.node).toBe(process.version)
    expect(reference).toMatchObject({ memoryBytes: 8 * 1024 ** 3, cpus: 2 })
    expect(typeof reference.matches).toBe('boolean')
    expect(target).toEqual({ secondsPerMB: 10, heapPerByte: 400, budgetVariance: 0 })
    expect(readFileSync(join(out, 'cost-benchmark.md'), 'utf8')).toContain('Reference runner: 8 GB, 2 vCPU')
  })
})

describe('budget-driven variance', { timeout: reruns }, () => {
  test('reruns each cap ×4 on its own, and depth and contexts together, each with the step budget ×64', async () => {
    const out = scratchDir()

    await benchmark(['--corpus', builtCorpus(site('dist/webpack/otel/maps', patch)), '--out', out])

    const written = results(out)
    const caps = Object.keys(defaultBudget.caps)
    expect(written.reruns.map((rerun: { name: string }) => rerun.name)).toEqual([...caps, 'depth+contexts'])
    for (const rerun of written.reruns) {
      const raised = rerun.name === 'depth+contexts' ? ['depth', 'contexts'] : [rerun.name]
      expect(rerun.budget.stepsPerByte).toBe(defaultBudget.stepsPerByte * 64)
      for (const cap of caps) {
        const factor = raised.includes(cap) ? 4 : 1
        expect(rerun.budget.caps[cap], `${rerun.name}: ${cap}`).toBe(defaultBudget.caps[cap as keyof Budget['caps']] * factor)
      }
    }
    expect(written.sites[0].reruns.map((rerun: { name: string; variance: string[] }) => [rerun.name, rerun.variance])).toEqual(
      [...caps, 'depth+contexts'].map((name) => [name, []]),
    )
  })

  test('is counted and reported when it is zero', async () => {
    const out = scratchDir()

    await benchmark(['--corpus', builtCorpus(site('dist/webpack/otel/maps', patch)), '--out', out])

    const written = results(out)
    expect(written.raisedBy).toBe(4)
    expect(written.sites[0].variance).toEqual([])
    expect(written.variance).toEqual({ sites: 1, sitesWithVariance: 0, results: 0 })
    expect(readFileSync(join(out, 'cost-benchmark.md'), 'utf8')).toContain(
      'Budget-driven variance: 0 results in 0 of 1 corpus sites, against reruns with each cap ×4 on its own and depth ' +
        'and contexts ×4 together, each with the step budget ×64 ok.',
    )
  })

  test('counts each fingerprint and completeness level a budget changed, against every rerun, once', async () => {
    const out = scratchDir()
    // A step budget so small the measured scan exhausts it, which every rerun, with it ×64, doesn't.
    const budget = { ...defaultBudget, stepsPerByte: 0.1 }

    const run = await benchmark(['--corpus', builtCorpus(site('dist/webpack/otel/maps', patch)), '--out', out], { budget })

    expect(run.exitCode, run.stderr).toBe(0)
    const written = results(out)
    expect(written.sites[0].budgetExhausted).toBe(1)
    const differences = [
      'window|Window.fetch|replace|unknown: only with the raised budget',
      'window|history.pushState|replace|unknown: only with the raised budget',
      'completeness level complete-with-limitations → complete',
    ]
    expect(written.sites[0].variance).toEqual(differences)
    expect(written.sites[0].reruns.every((rerun: { variance: string[] }) => rerun.variance.length === 3)).toBe(true)
    expect(written.variance).toEqual({ sites: 1, sitesWithVariance: 1, results: 3 })
  })

  test('names the cap whose rerun changes a finding', async () => {
    const out = scratchDir()
    // An iteration cap of one cuts the loop after its first name; four times it doesn't.
    const budget = { ...defaultBudget, caps: { ...defaultBudget.caps, iterations: 1 } }
    const code = "['fetch', 'open'].forEach(function (name) { window[name] = function () {} })\n"

    await benchmark(['--corpus', builtCorpus(site('dist/webpack/otel/maps', code)), '--out', out], { budget })

    const written = results(out)
    expect(written.sites[0].variance).toContain('window|Window.open|replace|unknown: only with the raised budget')
    const differing = written.sites[0].reruns.filter((rerun: { variance: string[] }) => rerun.variance.length > 0)
    expect(differing.map((rerun: { name: string }) => rerun.name)).toEqual(['iterations'])
    const summary = readFileSync(join(out, 'cost-benchmark.md'), 'utf8')
    expect(summary).toContain('| dist/webpack/otel/maps | iterations |')
  })

  test('raises the candidate-runs cap too, which decides whether a write with several candidates gives findings', async () => {
    const out = scratchDir()
    // One run can't decide the key's two alternatives, so the write gives nothing and raises analysis-budget;
    // four runs can.
    const budget = { ...defaultBudget, caps: { ...defaultBudget.caps, candidateRuns: 1 } }
    const code = "var k = Math.random() > 0.5 ? 'fetch' : 'open'; window[k] = function () {}\n"

    await benchmark(['--corpus', builtCorpus(site('dist/webpack/otel/maps', code)), '--out', out], { budget })

    const written = results(out)
    const variance: string[] = written.sites[0].variance
    expect(variance).toContain('completeness level complete-with-limitations → complete')
    const findings = variance.filter((line) => !line.startsWith('completeness level'))
    expect(findings.length).toBeGreaterThan(0)
    expect(findings.every((line) => line.includes('only with the raised budget'))).toBe(true)
  })
})

describe('measuring cost alone', () => {
  test('--no-rerun measures time and heap without the raised rerun, and says variance was not measured', async () => {
    const out = scratchDir()
    // A budget the measured scan exhausts: a rerun would show variance, so none shown means none was run.
    const budget = { ...defaultBudget, stepsPerByte: 0.1 }

    const run = await benchmark(
      ['--corpus', builtCorpus(site('dist/webpack/otel/maps', patch)), '--out', out, '--no-rerun'],
      { budget },
    )

    expect(run.exitCode, run.stderr).toBe(0)
    const written = results(out)
    expect(written.raisedBy).toBeNull()
    expect(written.sites[0].variance).toBeNull()
    expect(written.sites[0].reruns).toBeNull()
    expect(written.reruns).toBeNull()
    expect(written.sites[0].groups).toHaveLength(1)
    expect(written.variance).toEqual({ sites: 0, sitesWithVariance: 0, results: 0 })
    const summary = readFileSync(join(out, 'cost-benchmark.md'), 'utf8')
    expect(summary).toContain('Budget-driven variance: not measured (--no-rerun).')
    expect(summary).toContain('| not rerun |')
  })
})

describe('the scale fixture', { timeout: reruns }, () => {
  test('each built size is measured as its own site, and not rerun', async () => {
    const corpus = builtCorpus({
      ...site('dist/webpack/otel/maps', patch),
      ...site('scale/dist/webpack/1mb/nomaps', bigger),
      ...site('scale/dist/webpack/2.5mb/nomaps', bigger),
      ...site('scale/dist/webpack/5mb/nomaps', bigger),
      ...site('scale/dist/webpack/5mb/maps', bigger),
    })
    const out = scratchDir()

    expect((await benchmark(['--corpus', corpus, '--out', out])).exitCode).toBe(0)

    const { sites } = results(out)
    expect(sites.map((s: { id: string; kind: string }) => [s.id, s.kind])).toEqual([
      ['dist/webpack/otel/maps', 'corpus'],
      ['scale/dist/webpack/1mb/nomaps', 'scale'],
      ['scale/dist/webpack/2.5mb/nomaps', 'scale'],
      ['scale/dist/webpack/5mb/nomaps', 'scale'],
    ])
    expect(sites[1].variance).toBeNull()
    expect(sites[1].groups[0].bytes).toBe(Buffer.byteLength(bigger))
    expect(readFileSync(join(out, 'cost-benchmark.md'), 'utf8')).toContain('| scale/dist/webpack/5mb/nomaps |')
  })
})

describe('refusals', () => {
  test('nothing is written under the corpus, and a bad flag is refused (exit 2)', async () => {
    const corpus = builtCorpus(site('dist/webpack/otel/maps', patch))

    const inside = await benchmark(['--corpus', corpus, '--out', join(corpus, 'out')])
    expect(inside.exitCode).toBe(2)
    expect(inside.stderr).toContain('writes nothing under the corpus')

    const flag = await benchmark(['--corpus', corpus, '--out', scratchDir(), '--fast'])
    expect(flag.exitCode).toBe(2)
    expect(flag.stderr).toContain('usage:')
  })

  test('a corpus whose build differs from its manifests is refused (exit 2)', async () => {
    const corpus = builtCorpus(site('dist/webpack/otel/maps', patch))
    writeFileSync(join(corpus, 'dist/webpack/otel/maps/main.js'), 'changed')

    const run = await benchmark(['--corpus', corpus, '--out', scratchDir()])

    expect(run.exitCode).toBe(2)
    expect(run.stderr).toContain('dist/webpack/otel/maps/main.js: differs from manifest.json')
  })
})

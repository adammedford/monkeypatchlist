// The scan-wide lexical-name check (§3 Declarations in classic scripts, §9 Mutation confidence). Per realm,
// the top-level `let`/`const`/`class` names of every classic script are collected. A bare-identifier write in another
// script that matches one keeps its finding and gains a `note` naming the declaring artifact; for a `const`, it also
// gets the mutation-confidence reason `const-collision`. A write whose holder chain starts at a colliding bare name
// gets the note only. Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

const page = (...scripts: string[]) => scripts.map((script) => `<script ${script}></script>`).join('')

/** The occurrences in `artifact` (a path under the app), each as its target, notes, and mutation confidence. */
const occurrencesIn = (report: Report, artifact: string) =>
  report.findings.flatMap((finding: Report) =>
    finding.occurrences
      .filter((occurrence: Report) => occurrence.artifact.url === `https://app.example/${artifact}`)
      .map((occurrence: Report) => ({
        target: `${finding.target.name}|${finding.effect}`,
        notes: occurrence.trace
          .filter((step: Report) => step.kind === 'note' && step.about === 'lexical-collision')
          .map((step: Report) => `${step.name}|${step.declaration}|${step.artifact}`),
        mutation: occurrence.confidence.mutation,
        reasonSteps: occurrence.trace
          .filter((step: Report) => step.kind === 'confidence-reason')
          .map((step: Report) => `${step.reason}|${step.name}`),
      })),
  )

describe.each(resolvers)('the scan-wide lexical-name check, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (files: Record<string, string>) => scanBuild(files, [], { deps: { resolver } })

  test("a bare write of another classic script's let keeps its finding and gains a note naming the declaring script", async () => {
    const { report } = await scan({
      'index.html': page('src="a.js"', 'src="b.js"'),
      'a.js': 'let fetch = f',
      'b.js': 'fetch = w',
    })

    expect(occurrencesIn(report, 'b.js')).toEqual([
      {
        target: 'Window.fetch|replace',
        notes: ['fetch|let|https://app.example/a.js'],
        mutation: { level: 'high', reasons: [] },
        reasonSteps: [],
      },
    ])
  })

  test("a bare write of another classic script's const also gets const-collision, which lowers mutation confidence to low", async () => {
    const { report } = await scan({
      'index.html': page('src="a.js"', 'src="b.js"'),
      'a.js': 'const fetch = f',
      'b.js': 'fetch = w',
    })

    expect(occurrencesIn(report, 'b.js')).toEqual([
      {
        target: 'Window.fetch|replace',
        notes: ['fetch|const|https://app.example/a.js'],
        mutation: { level: 'low', reasons: ['const-collision'] },
        reasonSteps: ['const-collision|fetch'],
      },
    ])
    // The finding is kept, and takes its occurrences' highest level: a.js's own declaration is certain.
    expect(report.findings.map((finding: Report) => finding.target.name)).toEqual(['Window.fetch'])
    expect(report.findings[0].confidence.mutation).toEqual({ level: 'high', reasons: [] })
  })
  test('scripts in different realms do not interact', async () => {
    const { report } = await scan({
      'index.html': page('src="a.js"', 'src="main.js"'),
      'a.js': 'const fetch = f',
      'main.js': 'new Worker("/worker.js")',
      'worker.js': 'fetch = w',
    })
    const worker = await scan({
      'index.html': page('src="main.js"', 'src="b.js"'),
      'main.js': 'new Worker("/worker.js")',
      'worker.js': 'const fetch = f',
      'b.js': 'fetch = w',
    })

    expect(occurrencesIn(report, 'worker.js').filter(({ target }: Report) => target.startsWith('DedicatedWorkerGlobalScope.fetch'))).toEqual([
      { target: 'DedicatedWorkerGlobalScope.fetch|replace', notes: [], mutation: { level: 'high', reasons: [] }, reasonSteps: [] },
    ])
    expect(occurrencesIn(worker.report, 'b.js')).toEqual([
      { target: 'Window.fetch|replace', notes: [], mutation: { level: 'high', reasons: [] }, reasonSteps: [] },
    ])
  })

  test("a module script's top-level declarations are its own, so they collide with nothing", async () => {
    const { report } = await scan({
      'index.html': page('type="module" src="a.js"', 'src="b.js"'),
      'a.js': 'const fetch = f; let Request = R; class Response {}',
      'b.js': 'fetch = w; Request = r; Response.prototype.json = j',
    })

    expect(occurrencesIn(report, 'b.js').map(({ notes, mutation }: Report) => [notes, mutation.level])).toEqual([
      [[], 'high'],
      [[], 'high'],
      [[], 'high'],
    ])
  })

  test('the result does not depend on the order in which artifacts are listed', async () => {
    const files = (order: string[]) => ({
      'index.html': page(...order.map((name) => `src="${name}"`)),
      'a.js': 'let fetch = f',
      'c.js': 'const fetch = g; class Node {}',
      'b.js': 'fetch = w; Node.prototype.foo = f',
    })
    const reports = await Promise.all(
      [
        ['a.js', 'b.js', 'c.js'],
        ['c.js', 'b.js', 'a.js'],
        ['b.js', 'c.js', 'a.js'],
      ].map(async (order) => (await scan(files(order))).report),
    )

    expect(occurrencesIn(reports[0], 'b.js')).toEqual([
      {
        target: 'Node.prototype.foo|add',
        notes: ['Node|class|https://app.example/c.js'],
        mutation: { level: 'high', reasons: [] },
        reasonSteps: [],
      },
      {
        target: 'Window.fetch|replace',
        notes: ['fetch|let|https://app.example/a.js', 'fetch|const|https://app.example/c.js'],
        mutation: { level: 'low', reasons: ['const-collision'] },
        reasonSteps: ['const-collision|fetch'],
      },
    ])
    for (const report of reports.slice(1)) {
      expect(JSON.stringify(report.findings)).toBe(JSON.stringify(reports[0].findings))
    }
  })
  test('a write whose holder chain starts at a colliding bare name keeps its finding and gets the note, never const-collision', async () => {
    const { report } = await scan({
      'index.html': page('src="a.js"', 'src="b.js"'),
      'a.js': 'class Node {}\nconst Promise = MyPromise',
      'b.js': 'Node.prototype.foo = f\nPromise.prototype.finally = g\nvar P = Promise\nP.prototype.then = h',
    })

    expect(occurrencesIn(report, 'b.js')).toEqual([
      {
        target: 'Node.prototype.foo|add',
        notes: ['Node|class|https://app.example/a.js'],
        mutation: { level: 'high', reasons: [] },
        reasonSteps: [],
      },
      {
        target: 'Promise.prototype.finally|replace',
        notes: ['Promise|const|https://app.example/a.js'],
        mutation: { level: 'high', reasons: [] },
        reasonSteps: [],
      },
      {
        target: 'Promise.prototype.then|replace',
        notes: ['Promise|const|https://app.example/a.js'],
        mutation: { level: 'high', reasons: [] },
        reasonSteps: [],
      },
    ])
  })

  test('the note sits right after the binding step of the colliding name, and locates the declaration', async () => {
    const { report } = await scan({
      'index.html': page('src="a.js"', 'src="b.js"'),
      'a.js': 'var x = 1\nlet [, fetch] = xs',
      'b.js': 'fetch = w',
    })
    const [occurrence] = report.findings
      .flatMap((finding: Report) => finding.occurrences)
      .filter((each: Report) => each.artifact.url === 'https://app.example/b.js')

    expect(occurrence.trace.map((step: Report) => step.kind)).toEqual(['binding', 'note'])
    expect(occurrence.trace[1]).toMatchObject({
      about: 'lexical-collision',
      name: 'fetch',
      declaration: 'let',
      artifact: 'https://app.example/a.js',
      generated: { line: 2, column: 7 },
    })
  })

  test('a redeclaration across scripts is ignored, and a delete of the name is noted but does not throw', async () => {
    const { report } = await scan({
      'index.html': page('src="a.js"', 'src="b.js"'),
      'a.js': 'const fetch = f; const Request = R',
      'b.js': 'var fetch = w; delete Request',
    })

    expect(occurrencesIn(report, 'b.js')).toEqual([
      {
        target: 'Window.Request|delete',
        notes: ['Request|const|https://app.example/a.js'],
        mutation: { level: 'high', reasons: [] },
        reasonSteps: [],
      },
      {
        target: 'Window.fetch|replace',
        notes: [],
        mutation: { level: 'high', reasons: [] },
        reasonSteps: [],
      },
    ])
  })

  test("a script's own lexical names never collide with its own writes", async () => {
    const { report } = await scan({
      'index.html': page('src="a.js"', 'src="b.js"'),
      'a.js': 'let fetch = f; setTimeout("fetch = w")',
      'b.js': 'Request = r',
    })

    expect(report.findings.flatMap((finding: Report) => finding.occurrences).flatMap((each: Report) => each.trace))
      .not.toContainEqual(expect.objectContaining({ about: 'lexical-collision' }))
  })
  test("a module's bare write reaches a classic script's global lexical binding too, so it is checked", async () => {
    const { report } = await scan({
      'index.html': page('src="a.js"', 'type="module" src="b.js"'),
      'a.js': 'const fetch = f',
      'b.js': 'fetch = w',
    })

    expect(occurrencesIn(report, 'b.js')).toEqual([
      {
        target: 'Window.fetch|replace',
        notes: ['fetch|const|https://app.example/a.js'],
        mutation: { level: 'low', reasons: ['const-collision'] },
        reasonSteps: ['const-collision|fetch'],
      },
    ])
  })
})

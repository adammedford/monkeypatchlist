// Generates the public spec from the working spec. Build-time only; never published.
//
//   npm run spec         write docs/spec.md from .scratch/platform-integrity-scanner/spec.md
//   npm run spec:check   fail if docs/spec.md differs from a fresh generation (skipped where the working spec is absent,
//                        as in the public repository), or if docs/spec.md, CONTEXT.md or an ADR links into the private
//                        process record or carries a provenance tag; docs/spec.md also may not name a ticket or
//                        pre-flight
import { existsSync } from 'node:fs'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { leaks, publicSpec } from './generate.ts'

const root = join(import.meta.dirname, '..', '..')
const paths = {
  source: join(root, '.scratch', 'platform-integrity-scanner', 'spec.md'),
  spec: join(root, 'docs', 'spec.md'),
  context: join(root, 'CONTEXT.md'),
  adr: join(root, 'docs', 'adr'),
}

const { values: options } = parseArgs({ options: { check: { type: 'boolean', default: false } } })

const adrFiles = (await readdir(paths.adr)).filter((name) => name.endsWith('.md')).sort()
const hasSource = existsSync(paths.source)
const generated = hasSource ? publicSpec({ source: await readFile(paths.source, 'utf8'), adrFiles }) : undefined

if (options.check) {
  const problems: string[] = []
  const committed = existsSync(paths.spec) ? await readFile(paths.spec, 'utf8') : undefined
  if (committed === undefined) problems.push('docs/spec.md is missing: run `npm run spec`.')
  else {
    if (generated !== undefined && generated !== committed)
      problems.push('docs/spec.md is stale: run `npm run spec` and commit the result.')
    for (const problem of leaks(committed, { strict: true, adrFiles })) problems.push(`docs/spec.md ${problem}`)
  }
  for (const problem of leaks(await readFile(paths.context, 'utf8'), { strict: false, adrFiles }))
    problems.push(`CONTEXT.md ${problem}`)
  for (const name of adrFiles) {
    const text = await readFile(join(paths.adr, name), 'utf8')
    for (const problem of leaks(text, { strict: false, adrFiles }))
      problems.push(`docs/adr/${name} ${problem}`)
  }
  if (!hasSource) console.log('The working spec is absent; docs/spec.md was checked for leaks only.')
  for (const problem of problems) console.error(problem)
  process.exitCode = problems.length ? 1 : 0
} else {
  if (generated === undefined) throw new Error(`The working spec is absent: ${paths.source}`)
  await writeFile(paths.spec, generated)
  console.log(`Wrote docs/spec.md from the working spec.`)
}

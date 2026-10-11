// Generates the runtime catalog from the pinned upstreams (§4, §19). Build-time only; never published.
//
//   npm run catalog [-- --base <ref>]   write catalog/catalog.json, catalog/target-diff.md, catalog/changelog.json
//                                       and catalog/cross-check.md;
//                                       the diff lists the changes since the catalog at <ref> (default HEAD), and the
//                                       generation is refused if it loses a target or holder that catalog had (the
//                                       catalog is monotonic); the cross-check compares the catalog with SES and BCD
//   npm run catalog:check               fail if the committed files differ from a fresh generation, if the diff is
//                                       not the one from the catalog it names, if a line it marks lacks a sign-off,
//                                       if the changelog is not the one from the last catalog of the previous version,
//                                       if the cross-check report is stale, or if a drop cites a BCD feature that
//                                       Chrome, Firefox or Safari ships, on desktop or mobile
import { parseArgs } from 'node:util'
import type { SerializedCatalog } from '../../src/catalog.ts'
import { changelog, changelogProblems } from './changelog.ts'
import {
  committedAt,
  lastCatalogOfVersion,
  paths,
  readChangelog,
  readCommitted,
  writeChangelog,
  writeGenerated,
} from './committed.ts'
import { crossCheck, crossCheckProblems } from './cross-check.ts'
import { loadCrossCheckSources } from './cross-check-sources.ts'
import { check, generate } from './generate.ts'
import { loadUpstream } from './upstream.ts'

const { values: options } = parseArgs({
  options: { check: { type: 'boolean', default: false }, base: { type: 'string', default: 'HEAD' } },
})

const input = await loadUpstream()
const crossCheckSources = await loadCrossCheckSources()

if (options.check) {
  let problems: string[]
  try {
    const committed = await readCommitted()
    const catalog = JSON.parse(committed.committed.catalog) as SerializedCatalog
    problems = [
      ...check({ ...input, ...committed }),
      ...changelogProblems({ catalog, previous: previousVersion(catalog), committed: await readChangelog() }),
      ...crossCheckProblems(committed.committed.catalog, committed.crossCheck, crossCheckSources),
    ]
  } catch (error) {
    problems = [(error as Error).message]
  }
  for (const problem of problems) console.error(problem)
  process.exitCode = problems.length ? 1 : 0
} else {
  const generated = generate({ ...input, previous: committedAt(options.base) })
  await writeGenerated(generated, crossCheck(generated.catalog, crossCheckSources))
  const catalog = JSON.parse(generated.catalog) as SerializedCatalog
  const committedChangelog = await readChangelog()
  await writeChangelog(
    changelog({
      catalog,
      previous: previousVersion(catalog),
      committed: committedChangelog === undefined ? undefined : JSON.parse(committedChangelog),
    }),
  )
  const { targets } = catalog
  const counts = Object.entries(targets).map(([realm, named]) => `${realm} ${Object.keys(named).length}`)
  const written = `${paths.catalog} (targets per realm: ${counts.join(', ')}), ${paths.targetDiff}, ${paths.changelog} and ${paths.crossCheck}`
  console.log(`Wrote ${written}.`)
}

/** The last catalog of the version before `catalog`'s, which its changelog records are from; none for version 1. */
function previousVersion(catalog: SerializedCatalog): SerializedCatalog | undefined {
  const { catalogVersion } = catalog.metadata
  return catalogVersion > 1 ? lastCatalogOfVersion(catalogVersion - 1) : undefined
}

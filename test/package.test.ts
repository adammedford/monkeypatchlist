import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, test } from 'vitest'
import { loadCatalog } from '../src/index.ts'

const root = new URL('../', import.meta.url)

describe('published package', () => {
  test('ships the runtime, the catalog, its schema and changelog, the license and notice, and never the generator', () => {
    const [pack] = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8' }),
    )
    const paths: string[] = pack.files.map((file: { path: string }) => file.path)

    expect(paths).toEqual(
      expect.arrayContaining([
        'package.json',
        'README.md',
        'LICENSE',
        'NOTICE',
        'catalog/catalog.json',
        'catalog/catalog.schema.json',
        'catalog/changelog.json',
        'schema/report.schema.json',
        'schema/config.schema.json',
        'dist/bin/monkeypatchlist.js',
      ]),
    )
    for (const path of paths) {
      expect(path).toMatch(
        /^(package\.json|README\.md|LICENSE|NOTICE|catalog\/(catalog|catalog\.schema|changelog)\.json|schema\/(report|config)\.schema\.json|dist\/.+)$/,
      )
    }
  })

  test('exact-pins its runtime dependencies, so a patch release reproduces its output (§19 Packaging)', () => {
    const { dependencies } = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

    expect(Object.keys(dependencies).sort()).toEqual([
      '@jridgewell/trace-mapping',
      'ajv',
      'eslint-scope',
      'oxc-parser',
      'parse5',
    ])
    for (const [name, version] of Object.entries(dependencies)) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/)
  })

  test('runtime code never imports @webref/idl, webidl2, the ECMAScript biblios, SES, BCD or the build-time tools', () => {
    const sources = readdirSync(new URL('src/', root), { recursive: true, encoding: 'utf8' }).filter((path) =>
      path.endsWith('.ts'),
    )
    const imports = sources.flatMap((path) =>
      ts.preProcessFile(readFileSync(new URL(`src/${path}`, root), 'utf8')).importedFiles.map((file) => file.fileName),
    )

    expect(sources.length).toBeGreaterThan(0)
    for (const specifier of imports) {
      expect(specifier).not.toMatch(
        /^(@webref\/idl|webidl2|@tc39\/ecma262-biblio|@tc39\/ecma402-biblio|ses|@mdn\/browser-compat-data)(\/|$)|(^|\/)tools\//,
      )
    }
  })

  test('has no flag, environment variable or config key that swaps in another catalog (R1 has no catalog override)', () => {
    // A tripwire: the runtime loads the one catalog it ships. A flag, environment variable or option named for another
    // catalog fails here, and so does a `catalog` key in a JSON Schema other than the catalog's own, such as the config
    // schema.
    const option = /--catalog\b|\bMONKEYPATCHLIST_CATALOG\b|\bcatalog(Path|File|Dir|Url|Override)\b/i
    const schemaKey = /"catalog"\s*:/
    const sources = readdirSync(new URL('src/', root), { recursive: true, encoding: 'utf8' })
      .filter((path) => /\.(ts|json)$/.test(path))
      .map((path) => `src/${path}`)
    const schemas = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', '*.schema.json'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((path) => path && path !== 'catalog/catalog.schema.json' && !path.startsWith('.scratch/'))

    expect(loadCatalog.length).toBe(0)
    for (const path of sources) expect(readFileSync(new URL(path, root), 'utf8'), path).not.toMatch(option)
    for (const path of schemas) {
      const text = readFileSync(new URL(path, root), 'utf8')
      expect(text, path).not.toMatch(option)
      expect(text, path).not.toMatch(schemaKey)
    }
  })
})

import { existsSync } from 'node:fs'
import { ESLint } from 'eslint'
import { describe, expect, test } from 'vitest'

// §19 Invariants: every module after the source store is a pure function of its inputs. None reads the clock, the
// environment, the filesystem or the network. A lint rule enforces it; this test shows the rule covers each module, and
// the confidence model (§9) they share.
const pureModules = [
  'discovery',
  'analysis',
  'attribution',
  'confidence',
  'findings',
  'compare',
  'policy',
  'completeness',
  'baseline',
  'report',
]

const impure = {
  'the filesystem': "import { readFileSync } from 'node:fs'\nexport const x = readFileSync",
  'the filesystem, without the node: prefix': "import { readFile } from 'fs/promises'\nexport const x = readFile",
  'a dynamic import': "export const x = import('node:fs')",
  'the network': "import { get } from 'node:https'\nexport const x = get",
  'global fetch': "export const x = fetch('https://example.com/')",
  'the clock': 'export const x = Date.now()',
  'the high-resolution clock': 'export const x = performance.now()',
  'the environment': 'export const x = process.env.HOME',
  'the operating system': "import { hostname } from 'node:os'\nexport const x = hostname",
  'random numbers': 'export const x = Math.random()',
  'random bytes': "import { randomBytes } from 'node:crypto'\nexport const x = randomBytes",
  'the module loader': "import { createRequire } from 'node:module'\nexport const x = createRequire",
  'a built-in only the node: prefix names': "import { DatabaseSync } from 'node:sqlite'\nexport const x = DatabaseSync",
  'the catalog loader': "import { loadCatalog } from '../../../catalog.ts'\nexport const x = loadCatalog()",
  'the source store': "import { createSourceStore } from '../../source-store/index.ts'\nexport const x = createSourceStore",
  'the config loader': "import { loadConfig } from '../../config/index.ts'\nexport const x = loadConfig",
  'the module location': 'export const x = import.meta.url',
  'the locale, through Intl': 'export const x = new Intl.Collator().compare',
  'the locale, through a string method': "export const x = ['b', 'a'].sort((a, b) => a.localeCompare(b))",
  'the host, through navigator': 'export const x = navigator.hardwareConcurrency',
}

const eslint = new ESLint()

async function errors(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath })
  return result!.messages.filter((message) => message.severity === 2).map((message) => message.ruleId ?? message.message)
}

describe('modules after the source store are pure (§19 Invariants)', () => {
  test('each pure module is a package', () => {
    for (const name of pureModules) expect(existsSync(`src/packages/${name}/index.ts`), name).toBe(true)
  })

  for (const name of pureModules) {
    test.each(Object.entries(impure))(`${name} may not read %s`, async (_, code) => {
      expect(await errors(code, `src/packages/${name}/lib/probe.ts`)).not.toEqual([])
    })
  }

  test('pure code, content hashing, path arithmetic and the types of the impure modules pass', async () => {
    const code = [
      "import { createHash } from 'node:crypto'",
      "import { posix } from 'node:path'",
      "import { realms, type SerializedCatalog } from '../../../catalog.ts'",
      "import type { SourceStore } from '../../source-store/index.ts'",
      "import { UsageError, type Entry } from '../../config/index.ts'",
      "export const hash = (text: string) => createHash('sha256').update(text).digest('hex')",
      "export const join = (a: string, b: string) => posix.join(a, b)",
      'export const first = (catalog: SerializedCatalog, store: SourceStore, entry: Entry) => [catalog, store, entry]',
      'export const error = (message: string) => [new UsageError(message), realms[0]]',
    ].join('\n')

    for (const name of pureModules) expect(await errors(code, `src/packages/${name}/lib/probe.ts`), name).toEqual([])
  })

  test('the source store and the CLI may read bytes and the clock', async () => {
    const code = "import { readFileSync } from 'node:fs'\nexport const x = [readFileSync, Date.now()]"

    expect(await errors(code, 'src/packages/source-store/lib/probe.ts')).toEqual([])
    expect(await errors(code, 'src/cli.ts')).toEqual([])
  })
})

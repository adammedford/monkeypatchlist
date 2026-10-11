import { describe, expect, expectTypeOf, test } from 'vitest'
import { loadCatalog } from '../src/index.ts'
import {
  defaultBudget,
  jsResolver,
  type AnalyzeGroupInput,
  type ArtifactRef,
  type ArtifactSource,
  type Budget,
  type Resolver,
} from '../src/packages/analysis/index.ts'

const catalog = loadCatalog()

function analyze(text: string, sourceType: ArtifactRef['sourceType'] = 'script') {
  const entry: ArtifactRef = {
    url: 'https://app.example/main.js',
    hash: 'sha256:test',
    sourceType,
    realm: 'window',
    realmBasis: 'reference',
  }
  const pulled: string[] = []
  const output = jsResolver.analyzeGroup({
    entry,
    artifact: (url) => {
      pulled.push(url)
      return url === entry.url ? { ...entry, text } : undefined
    },
    catalog,
    budget: defaultBudget,
  })
  return { entry, output, pulled }
}

/** Fails unless `value` is plain JSON data: null, booleans, finite numbers, strings, arrays and plain objects. */
function expectPlainJson(value: unknown, path = '$'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    expect(Number.isFinite(value), path).toBe(true)
    return
  }
  expect(typeof value, path).toBe('object')
  if (Array.isArray(value)) {
    value.forEach((item, index) => expectPlainJson(item, `${path}[${index}]`))
    return
  }
  expect([Object.prototype, null], path).toContain(Object.getPrototypeOf(value))
  for (const [key, item] of Object.entries(value as object)) {
    expect(item, `${path}.${key}`).not.toBeUndefined()
    expectPlainJson(item, `${path}.${key}`)
  }
}

describe('the resolver seam (§19 Analysis)', () => {
  test("matches §19's interface", () => {
    expectTypeOf(jsResolver).toEqualTypeOf<Resolver>()
    expectTypeOf<AnalyzeGroupInput>().toEqualTypeOf<{
      entry: ArtifactRef
      artifact(url: string): ArtifactSource | undefined
      // How discovery resolved a member's module requests, which the resolver follows to pull in its link group (§6).
      resolveImport?(from: string, specifier: string): string | undefined
      // The build-directory artifacts that push a chunk id into a chunk registry, which a loader links (§6 idiom 6).
      chunks?(registry: string, id: string | null): readonly string[]
      // The page's other classic scripts that push into a registry, its initial chunks (§6).
      initialChunks?(registry: string): readonly string[]
      catalog: typeof catalog
      budget: Budget
    }>()
    expectTypeOf<ArtifactRef>().toEqualTypeOf<{
      url: string
      hash: string
      sourceType: 'script' | 'module'
      realm: 'window' | 'dedicated-worker' | 'shared-worker' | 'service-worker'
      realmBasis: 'reference' | 'assumed'
    }>()
    expect(typeof jsResolver.analyzerVersion).toBe('string')

    const { output } = analyze('window.fetch = f')
    expect(Object.keys(output).sort()).toEqual([
      'ineffectiveWrites',
      'limitations',
      'members',
      'moduleLinking',
      'occurrences',
      'references',
      'stats',
    ])
    expect(Object.keys(output.stats).sort()).toEqual(['budget', 'caps', 'exhausted', 'steps'])
  })

  test('pulls its group entry by URL, and reports it as the group\'s one member', () => {
    const { entry, output, pulled } = analyze('window.fetch = f')

    expect(pulled).toEqual([entry.url])
    expect(output.members).toEqual([entry])
  })

  test('everything it returns is plain JSON-serializable data', () => {
    const { output } = analyze('window.fetch = f\nfetch = g\nwindow.setTimeout = h')

    expect(output.occurrences).toHaveLength(3)
    expectPlainJson(output)
    expect(JSON.parse(JSON.stringify(output))).toEqual(output)
  })

  test('raw occurrences carry the fields the resolver owns', () => {
    const { output } = analyze('window.fetch = f')

    expect(output.occurrences).toEqual([
      {
        artifact: 'https://app.example/main.js',
        generated: { start: 0, end: 16, line: 1, column: 0 },
        // Attribution looks the write up at its member token (§10).
        lookup: { generated: { start: 7, end: 12, line: 1, column: 7 }, token: 'fetch' },
        target: { realm: 'window', holder: 'global', name: 'Window.fetch' },
        effect: 'replace',
        mechanism: 'assign',
        reachability: 'unconditional',
        reachabilityBasis: 'call-path',
        installContext: 'load',
        installEntry: null,
        realmInstance: 'current',
        locks: false,
        confidence: { target: { level: 'high', reasons: [] }, mutation: { level: 'high', reasons: [] } },
        trace: [expect.objectContaining({ kind: 'binding', name: 'window' })],
      },
    ])
  })

  test('parses with the artifact\'s sourceType', () => {
    // An HTML-like comment (Annex B) is allowed in a classic script and a syntax error in a module.
    const code = '<!-- a comment\nwindow.fetch = f'

    expect(analyze(code, 'script').output.occurrences).toHaveLength(1)
    expect(analyze(code, 'module').output.limitations.map((limitation) => limitation.kind)).toEqual(['parse-failure'])
  })

  test('an artifact that does not parse is a parse-failure limitation, and its partial AST is never used', () => {
    const { output } = analyze('window.fetch = f\nvar = ;')

    expect(output.occurrences).toEqual([])
    expect(output.limitations).toEqual([
      {
        kind: 'parse-failure',
        artifact: { url: 'https://app.example/main.js', hash: 'sha256:test' },
        detail: expect.any(String),
      },
    ])
  })
})

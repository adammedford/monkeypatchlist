// The oxc parse discovery reads syntax from (§5 Parsing and scope, §19 Discovery): the references in a script or module
// (`requests.ts`), and the source type and worker markers of a file only the sweep found (`swept-code.ts`). Syntax only.

import { parseSync, rawTransferSupported, type ParserOptions } from 'oxc-parser'

export interface Node {
  type: string
  start: number
  end: number
  [key: string]: unknown
}

/** Raw transfer where the platform supports it (§5 Parsing and scope). The option is not in oxc's typings. */
const rawTransfer = rawTransferSupported()

/** The parser options §5 fixes, with the `sourceType` always explicit, as the resolver parses. */
const parserOptions = (sourceType: 'script' | 'module'): ParserOptions & { experimentalRawTransfer: boolean } => ({
  lang: 'js',
  sourceType,
  range: true,
  preserveParens: false,
  experimentalRawTransfer: rawTransfer,
})

/** The import and export declarations, which a classic script cannot hold. */
const moduleDeclarations = new Set([
  'ImportDeclaration',
  'ExportAllDeclaration',
  'ExportNamedDeclaration',
  'ExportDefaultDeclaration',
])

/**
 * Parses `text` with `sourceType`: its program and module record, or undefined when it doesn't parse, as then nothing
 * of it runs. That includes a classic script with an `import` or `export` declaration, which oxc reports only among the
 * semantic errors §5's options leave out.
 */
export function parseCode(
  text: string,
  sourceType: 'script' | 'module',
): { program: Node; module: ReturnType<typeof parseSync>['module'] } | undefined {
  const parsed = parseSync('artifact.js', text, parserOptions(sourceType))
  if (parsed.errors.length > 0) return undefined
  const program = parsed.program as unknown as Node
  // Import and export declarations can only be top-level statements.
  if (sourceType === 'script' && (program['body'] as Node[]).some(({ type }) => moduleDeclarations.has(type))) {
    return undefined
  }
  return { program, module: parsed.module }
}

export function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

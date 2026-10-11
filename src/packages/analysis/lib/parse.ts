import { parseSync, rawTransferSupported, type ParserOptions } from 'oxc-parser'
import type { AstNode } from './ast.ts'

/** Raw transfer where the platform supports it (§5 Parsing and scope). The option is not in oxc's typings. */
const rawTransfer = rawTransferSupported()

/** The parser options §5 fixes, with the `sourceType` always explicit. */
const parserOptions = (sourceType: 'script' | 'module'): ParserOptions & { experimentalRawTransfer: boolean } => ({
  lang: 'js',
  sourceType,
  range: true,
  preserveParens: false,
  experimentalRawTransfer: rawTransfer,
})

/**
 * The early error for an `import` or `export` declaration in a script, by declaration type. The ECMAScript Script goal
 * has no such declarations, but oxc reports them only among its semantic errors, which §5's options leave out.
 */
const moduleDeclarations = new Map([
  ['ImportDeclaration', 'Cannot use import statement outside a module'],
  ['ExportNamedDeclaration', 'Cannot use export statement outside a module'],
  ['ExportDefaultDeclaration', 'Cannot use export statement outside a module'],
  ['ExportAllDeclaration', 'Cannot use export statement outside a module'],
])

/**
 * Parses code with `oxc-parser`: its program, or the first error. A partially recovered AST is never returned (§13). A
 * script with an `import` or `export` declaration doesn't parse, as in a browser.
 */
export function parse(text: string, sourceType: 'script' | 'module'): { program: AstNode } | { error: string } {
  const parsed = parseSync('artifact.js', text, parserOptions(sourceType))
  const [error] = parsed.errors
  if (error !== undefined) return { error: error.message }
  const program = parsed.program as unknown as AstNode
  if (sourceType === 'script') {
    // Import and export declarations can only be top-level statements, so the program's body holds any there are.
    const declaration = (program['body'] as AstNode[]).find(({ type }) => moduleDeclarations.has(type))
    if (declaration !== undefined) return { error: moduleDeclarations.get(declaration.type)! }
  }
  return { program }
}

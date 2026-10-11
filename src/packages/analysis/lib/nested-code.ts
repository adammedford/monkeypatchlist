// Nested code (§2 Content that isn't JavaScript, §19 Raw occurrences): the code a literal `eval`, `new Function` or
// string timer compiles is parsed and analyzed inside the resolver, and located inside its host artifact.
//
// Every nested program is re-based into its host artifact's offsets: each UTF-16 offset of the code a literal holds is
// mapped through the literal's escapes to where that character is written in the host. So a nested node's range lies
// inside its literal, its line and column come from the host's line-start table, and code nested in nested code maps
// through each literal in turn.
//
// A direct eval's code runs in its caller's scope, so it is grafted into the host's AST in place of its literal, as an
// arrow function the scope rules treat as eval code (`Graft`). Its names then resolve through the binding-resolution
// seam exactly as the caller's would. Other nested code is global code, analyzed as a program of its own.

import { isEvalCall, walkTree, type AstNode } from './ast.ts'
import { parse } from './parse.ts'

/** A piece of code, and where each of its UTF-16 offsets lies in the host artifact. */
export interface CodeText {
  text: string
  /** The host artifact's offset for an offset in `text`, from 0 to `text.length`. It never decreases. */
  host(offset: number): number
}

/** Direct-eval code grafted into the host's AST in place of its literal, with the eval call it is the code of. */
export interface Graft {
  call: AstNode
}

/** A literal's source text, delimiters included, and the host offset of each of its UTF-16 offsets. */
interface LiteralSource {
  raw: string
  host(offset: number): number
}

export interface NestedCode {
  /** The code a code literal holds, located in the host artifact. */
  code(literal: AstNode): CodeText
  /**
   * The code a number, bigint, boolean or `null` literal given to `Function` stands for: its value converted with ToString
   * (ECMA-262 CreateDynamicFunction, Principle 2), every offset of it located at the literal.
   */
  converted(literal: AstNode): CodeText
  /** The program nested code parses to as a script, re-based into the host artifact, or none when it doesn't parse. */
  program(code: CodeText): AstNode | undefined
  /**
   * The program the `Function` constructor compiles from its arguments' code (the parameters, then the body), re-based
   * into the host artifact, or none when the parameters and body don't parse as they are.
   */
  functionProgram(parts: readonly CodeText[]): AstNode | undefined
  /**
   * Grafts the code of every direct eval of a code literal in `program` (`eval("…")`) in place of its literal, as an
   * arrow function whose body is that code, and records each graft in `grafts`. Code that doesn't parse is left alone:
   * the eval would throw a SyntaxError. The names are not resolved here, so a graft only stands for eval code when
   * its call's `eval` turns out to be the global one.
   */
  graftDirectEvals(program: AstNode, grafts: Map<AstNode, Graft>): void
}

/** Whether a node is a code literal: a string literal, or a template literal without substitutions. */
export function isCodeLiteral(node: AstNode): boolean {
  if (node.type === 'Literal') return typeof node['value'] === 'string'
  if (node.type !== 'TemplateLiteral' || (node['expressions'] as AstNode[]).length > 0) return false
  return cooked(node) !== null
}

/** Nested code in one host artifact, whose source text is `hostText`. */
export function nestedCode(hostText: string): NestedCode {
  // Where each code literal inside nested code was written. A literal in the host's own code is written in the host.
  const sources = new WeakMap<AstNode, LiteralSource>()
  const sourceOf = (literal: AstNode): LiteralSource =>
    sources.get(literal) ?? { raw: hostText.slice(literal.start, literal.end), host: (offset) => literal.start + offset }

  function code(literal: AstNode): CodeText {
    const source = sourceOf(literal)
    const text = literal.type === 'Literal' ? (literal['value'] as string) : cooked(literal)!
    // Both kinds of literal have a one-character delimiter on each side.
    const raw = rawOffsets(source.raw.slice(1, -1), text, literal.type === 'TemplateLiteral')
    return { text, host: (offset) => source.host(1 + raw[offset]!) }
  }

  function converted(literal: AstNode): CodeText {
    const text = String(literal['value'] as number | bigint | boolean | null)
    const { start, end } = literal
    return { text, host: (offset) => (offset < text.length ? start : end) }
  }

  /** Parses `code` as a script and re-bases it into the host, if it parses and has the shape `shaped` wants. */
  function located(code: CodeText, shaped: (program: AstNode) => boolean = () => true): AstNode | undefined {
    const parsed = parse(code.text, 'script')
    if ('error' in parsed || !shaped(parsed.program)) return undefined
    walkTree(parsed.program, {
      enter(node) {
        const { start, end } = node
        if (isCodeLiteral(node)) {
          sources.set(node, { raw: code.text.slice(start, end), host: (offset) => code.host(start + offset) })
        }
        node.start = code.host(start)
        node.end = code.host(end)
        if (Array.isArray(node['range'])) node['range'] = [node.start, node.end]
      },
    })
    return parsed.program
  }

  function functionProgram(parts: readonly CodeText[]): AstNode | undefined {
    // ECMA-262 CreateDynamicFunction: the source text is `function anonymous(<parameters>\n) {\n<body>\n}`, which is
    // parsed here as a parenthesized function expression.
    const body = parts.at(-1)
    if (body === undefined) return undefined
    const segments: { from: number; code: CodeText }[] = []
    let text = '(function anonymous('
    parts.slice(0, -1).forEach((part, index) => {
      if (index > 0) text += ','
      segments.push({ from: text.length, code: part })
      text += part.text
    })
    text += '\n) '
    const brace = text.length
    text += '{\n'
    segments.push({ from: text.length, code: body })
    text += `${body.text}\n})`
    // The glue between the parts is located at the start of the part after it, or at the end of the last part.
    const host = (offset: number): number => {
      for (const { from, code } of segments) {
        if (offset < from) return code.host(0)
        if (offset <= from + code.text.length) return code.host(offset - from)
      }
      return body.host(body.text.length)
    }
    // The parameters and the body parse on their own, so neither can close the function early and add code after it.
    return located({ text, host }, (program) => {
      const [statement, ...more] = program['body'] as AstNode[]
      const made = statement?.['expression'] as AstNode | undefined
      return (
        more.length === 0 &&
        made?.type === 'FunctionExpression' &&
        made.start === 1 &&
        made.end === text.length - 1 &&
        (made['body'] as AstNode).start === brace
      )
    })
  }

  function graftDirectEvals(program: AstNode, grafts: Map<AstNode, Graft>): void {
    const calls: AstNode[] = []
    walkTree(program, {
      enter(node) {
        if (!isEvalCall(node)) return
        const [argument] = node['arguments'] as AstNode[]
        if (argument !== undefined && isCodeLiteral(argument)) calls.push(node)
      },
    })
    for (const call of calls) {
      const args = call['arguments'] as AstNode[]
      const literal = args[0]!
      const nested = located(code(literal))
      if (nested === undefined) continue
      graftDirectEvals(nested, grafts)
      const { start, end } = literal
      const graft: AstNode = {
        type: 'ArrowFunctionExpression',
        start,
        end,
        range: [start, end],
        id: null,
        expression: false,
        generator: false,
        async: false,
        params: [],
        body: { type: 'BlockStatement', start, end, range: [start, end], body: nested['body'] },
      }
      args[0] = graft
      grafts.set(graft, { call })
    }
  }

  return { code, converted, program: (code) => located(code), functionProgram, graftDirectEvals }
}

/** A template literal's cooked text, or null when an escape in it is invalid. */
function cooked(template: AstNode): string | null {
  const [quasi] = template['quasis'] as AstNode[]
  return (quasi!['value'] as { cooked: string | null }).cooked
}

/**
 * For each UTF-16 offset of a literal's cooked text, from 0 to its length, the offset in `content` (the literal's
 * source between its delimiters) where the character is written. Every unit an escape gives is at the escape's
 * backslash, a line continuation gives nothing, and in a template a CR or CRLF gives one LF.
 */
function rawOffsets(content: string, text: string, template: boolean): number[] {
  const offsets: number[] = []
  let at = 0
  while (at < content.length) {
    const char = content[at]!
    if (char === '\\') {
      const [length, units] = escape(content, at)
      for (let unit = 0; unit < units; unit++) offsets.push(at)
      at += length
    } else if (template && char === '\r') {
      offsets.push(at)
      at += content[at + 1] === '\n' ? 2 : 1
    } else {
      offsets.push(at)
      at++
    }
  }
  offsets.push(content.length)
  // The escapes were read as the parser reads them, so the lengths agree. Were they ever not to, locations would still
  // stay inside the literal and never decrease.
  if (offsets.length !== text.length + 1) {
    return Array.from({ length: text.length + 1 }, (_, offset) => Math.min(offset, content.length))
  }
  return offsets
}

/** The escape sequence at `at` in a literal's source: how many characters it takes, and how many UTF-16 units it gives. */
function escape(content: string, at: number): [length: number, units: number] {
  const next = content[at + 1] ?? ''
  // A line continuation: a backslash before a line terminator gives nothing.
  if (next === '\r') return [content[at + 2] === '\n' ? 3 : 2, 0]
  if (next === '\n' || next === '\u2028' || next === '\u2029') return [2, 0]
  if (next === 'x') return [4, 1]
  if (next === 'u') {
    if (content[at + 2] !== '{') return [6, 1]
    const close = content.indexOf('}', at + 3)
    return [close + 1 - at, Number.parseInt(content.slice(at + 3, close), 16) > 0xffff ? 2 : 1]
  }
  // `\0` and the legacy octal escapes of sloppy strings: up to three octal digits from 0-3, or two from 4-7.
  if (next >= '0' && next <= '7') {
    const most = next <= '3' ? 3 : 2
    let digits = 1
    while (digits < most && (content[at + 1 + digits] ?? '') >= '0' && (content[at + 1 + digits] ?? '') <= '7') digits++
    return [1 + digits, 1]
  }
  // Any other escaped character stands for itself: one code point, which may be a surrogate pair.
  const point = content.codePointAt(at + 1) ?? 0
  return point > 0xffff ? [3, 2] : [2, 1]
}

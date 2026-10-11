// The YAML that `pnpm-lock.yaml` and Yarn Berry's `yarn.lock` are written in (§10 Introducing dependencies): block
// mappings and sequences, flow mappings and sequences, and plain or quoted scalars, every scalar read as a string.
// Anchors, tags and block scalars, which neither lockfile writes, make the text unreadable. Pure.

/** A value read from lockfile YAML: every scalar is a string. */
export type YamlValue = string | null | YamlValue[] | { [key: string]: YamlValue }

/** Thrown for text outside the lockfile subset. */
class Unreadable extends Error {}

interface Line {
  indent: number
  text: string
}

/**
 * Reads lockfile YAML, or returns null when the text is outside the subset. A stream of several documents (pnpm writes
 * its environment lockfile first) reads as its last document.
 */
export function readYaml(input: string): YamlValue | null {
  const text = input.startsWith('﻿') ? input.slice(1) : input
  const documents: Line[][] = [[]]
  for (const raw of text.split(/\r?\n/)) {
    if (/^---\s*$/.test(raw)) {
      documents.push([])
      continue
    }
    if (/^\.\.\.\s*$/.test(raw)) continue
    const body = withoutComment(raw).trimEnd()
    if (body.trim() === '') continue
    if (body.includes('\t') && /^\s*\t/.test(body)) return null
    const indent = body.length - body.trimStart().length
    documents.at(-1)!.push({ indent, text: body.trimStart() })
  }
  const lines = documents.filter((each) => each.length > 0).at(-1) ?? []
  try {
    if (lines.length === 0) return null
    const at = { i: 0 }
    const value = block(lines, at, lines[0]!.indent)
    if (at.i < lines.length) throw new Unreadable()
    return value
  } catch (error) {
    if (error instanceof Unreadable) return null
    throw error
  }
}

/** A line without its comment: `#` at the start or after a space, outside quotes. */
function withoutComment(line: string): string {
  let quote: string | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote !== null) {
      if (quote === "'" && c === "'" && line[i + 1] === "'") i++
      else if (quote === '"' && c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === "'" || c === '"') {
      if (i === 0 || /[\s:[{,-]/.test(line[i - 1]!)) quote = c
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i)
  }
  return line
}

/** The block at `indent` starting at `at.i`: a sequence when its first line is a `- ` item, else a mapping. */
function block(lines: readonly Line[], at: { i: number }, indent: number): YamlValue {
  const first = lines[at.i]!
  if (first.text === '-' || first.text.startsWith('- ')) return sequence(lines, at, indent)
  return mapping(lines, at, indent)
}

function sequence(lines: readonly Line[], at: { i: number }, indent: number): YamlValue[] {
  const out: YamlValue[] = []
  while (at.i < lines.length) {
    const line = lines[at.i]!
    if (line.indent < indent) break
    if (line.indent > indent || !(line.text === '-' || line.text.startsWith('- '))) throw new Unreadable()
    const rest = line.text.slice(1).trimStart()
    at.i++
    if (rest === '') {
      out.push(nested(lines, at, indent))
    } else if (keyOf(rest) !== null) {
      // An item that is a mapping: its first key sits on the item's line.
      const shifted = [{ indent: indent + (line.text.length - rest.length), text: rest }]
      const inner = { i: 0 }
      const own: Line[] = [...shifted]
      while (at.i < lines.length && lines[at.i]!.indent > indent) own.push(lines[at.i++]!)
      out.push(mapping(own, inner, shifted[0]!.indent))
      if (inner.i < own.length) throw new Unreadable()
    } else out.push(inline(rest))
  }
  return out
}

/** The more-indented block after a line that ends in `:` or `-`, or null when none follows. */
function nested(lines: readonly Line[], at: { i: number }, indent: number): YamlValue {
  const next = lines[at.i]
  if (next === undefined || next.indent <= indent) {
    // A block sequence may sit at its key's own indent.
    if (next !== undefined && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) {
      return sequence(lines, at, indent)
    }
    return null
  }
  return block(lines, at, next.indent)
}

function mapping(lines: readonly Line[], at: { i: number }, indent: number): { [key: string]: YamlValue } {
  const out: { [key: string]: YamlValue } = {}
  while (at.i < lines.length) {
    const line = lines[at.i]!
    if (line.indent < indent) break
    if (line.indent > indent) throw new Unreadable()
    const found = keyOf(line.text)
    if (found === null) throw new Unreadable()
    const { key, rest } = found
    at.i++
    const value = rest === '' ? nested(lines, at, indent) : inline(rest)
    Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true })
  }
  return out
}

/** A mapping line's key and the text after its `:`, or null when the line is no `key:` line. */
function keyOf(text: string): { key: string; rest: string } | null {
  if (text.startsWith('"') || text.startsWith("'")) {
    const { value, end } = quoted(text, 0)
    const after = text.slice(end).trimStart()
    if (!after.startsWith(':')) return null
    if (after.length > 1 && after[1] !== ' ') return null
    return { key: value, rest: after.slice(1).trim() }
  }
  if (/^[[{&*!|>%@`]/.test(text)) return null
  for (let i = 0; i < text.length; i++) {
    if (text[i] === ':' && (i + 1 === text.length || text[i + 1] === ' ')) {
      return { key: text.slice(0, i).trimEnd(), rest: text.slice(i + 1).trim() }
    }
  }
  return null
}

/** A value written on its key's line: a flow collection or a scalar. */
function inline(text: string): YamlValue {
  if (/^[&*!|>]/.test(text)) throw new Unreadable()
  const at = { i: 0 }
  const value = flow(text, at)
  if (text.slice(at.i).trim() !== '') throw new Unreadable()
  return value
}

/** A flow value at `at.i`: `{…}`, `[…]`, a quoted scalar, or a plain scalar that ends at `,`, `]` or `}`. */
function flow(text: string, at: { i: number }, inCollection = false): YamlValue {
  skipSpaces(text, at)
  const c = text[at.i]
  if (c === '{') {
    at.i++
    const out: { [key: string]: YamlValue } = {}
    for (;;) {
      skipSpaces(text, at)
      if (text[at.i] === '}') {
        at.i++
        return out
      }
      const key = flowScalar(text, at, true)
      skipSpaces(text, at)
      let value: YamlValue = null
      if (text[at.i] === ':') {
        at.i++
        value = flow(text, at, true)
      }
      Object.defineProperty(out, key ?? '', { value, enumerable: true, writable: true, configurable: true })
      skipSpaces(text, at)
      if (text[at.i] === ',') at.i++
      else if (text[at.i] !== '}') throw new Unreadable()
    }
  }
  if (c === '[') {
    at.i++
    const out: YamlValue[] = []
    for (;;) {
      skipSpaces(text, at)
      if (text[at.i] === ']') {
        at.i++
        return out
      }
      out.push(flow(text, at, true))
      skipSpaces(text, at)
      if (text[at.i] === ',') at.i++
      else if (text[at.i] !== ']') throw new Unreadable()
    }
  }
  return flowScalar(text, at, inCollection)
}

function flowScalar(text: string, at: { i: number }, inCollection: boolean): string | null {
  skipSpaces(text, at)
  const c = text[at.i]
  if (c === '"' || c === "'") {
    const { value, end } = quoted(text, at.i)
    at.i = end
    return value
  }
  const start = at.i
  while (at.i < text.length) {
    const d = text[at.i]!
    if (inCollection && (d === ',' || d === ']' || d === '}')) break
    if (inCollection && d === ':' && (at.i + 1 === text.length || /[\s,\]}]/.test(text[at.i + 1]!))) break
    at.i++
  }
  const plain = text.slice(start, at.i).trim()
  if (plain === '') return inCollection ? null : ''
  return plain === '~' || plain === 'null' ? null : plain
}

/** A quoted scalar starting at `start`: its value and the index after its closing quote. */
function quoted(text: string, start: number): { value: string; end: number } {
  const quote = text[start]!
  let value = ''
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]!
    if (quote === "'") {
      if (c === "'") {
        if (text[i + 1] === "'") {
          value += "'"
          i++
          continue
        }
        return { value, end: i + 1 }
      }
      value += c
    } else {
      if (c === '"') return { value, end: i + 1 }
      if (c === '\\') {
        const e = text[++i]
        const escapes: Record<string, string> = { n: '\n', t: '\t', '"': '"', '\\': '\\', '/': '/', '0': '\0', r: '\r' }
        if (e === 'u' || e === 'x') {
          const length = e === 'u' ? 4 : 2
          const hex = text.slice(i + 1, i + 1 + length)
          if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== length) throw new Unreadable()
          value += String.fromCharCode(parseInt(hex, 16))
          i += length
        } else if (e !== undefined && e in escapes) value += escapes[e]
        else throw new Unreadable()
      } else value += c
    }
  }
  throw new Unreadable()
}

function skipSpaces(text: string, at: { i: number }): void {
  while (at.i < text.length && text[at.i] === ' ') at.i++
}

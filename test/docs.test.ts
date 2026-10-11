// The user docs can't drift from the CLI: every `npx monkeypatchlist …` command in README.md and the guides under docs/ is run
// here, in document order, against the example storefront build (docs/examples/storefront), and must exit as the doc
// says. Hidden directives in the Markdown drive the run:
//
//   <!-- docs-test: build v2 -->      swap the sandbox's build, maps and lockfile for docs/examples/storefront/v2
//   <!-- docs-test: file <path> -->   the next code block is written to <path> in the sandbox before anything runs on it
//   <!-- docs-test: output -->        the next code block is the stdout of the last command, byte for byte
//   <!-- docs-test: subset <path> --> the next JSON block is a subset of the JSON file at <path> in the sandbox
//   <!-- docs-test: corpus <site> --> the next shell block scans a validation-corpus site; its output block is checked
//                                     against the committed corpus snapshot (corpus-snapshot/protected/<site>.json),
//                                     which `npm run corpus:check` keeps equal to a real scan
//
// A shell command expects exit 0 unless its line ends with `# exits <n>`. Each doc runs in its own sandbox, which
// starts as a copy of the v1 build: `dist/`, `maps/`, `package.json` and `package-lock.json`.

import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, test } from 'vitest'
import { usage } from '../src/cli.ts'
import { renderTerminal } from '../src/packages/report/terminal.ts'
import { runCli, type CliRun } from './support/fixture-build.ts'

const root = new URL('../', import.meta.url)
const rootPath = (path: string): string => new URL(path, root).pathname
const read = (path: string): string => readFileSync(rootPath(path), 'utf8')

/** README.md and every user guide in docs/. The spec (docs/spec.md) is design material, not a guide. */
const docs = [
  'README.md',
  ...readdirSync(rootPath('docs'))
    .filter((name) => name.endsWith('.md') && name !== 'spec.md')
    .sort()
    .map((name) => `docs/${name}`),
]

const example = rootPath('docs/examples/storefront/')
const exampleFiles = ['dist', 'maps', 'package.json', 'package-lock.json']

/** Every flag the CLI takes, from its usage text. */
const cliFlags = [...new Set(usage.match(/--[a-z][a-z-]*/g))].sort()

/** The mapping the validation corpus is scanned with (tools/corpus-scan.ts). */
const corpusMap = 'https://app.corpus.test/=.'

const scratch = mkdtempSync(join(tmpdir(), 'monkeypatchlist-docs-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

interface Block {
  lang: string
  text: string
  /** The directives just above the block. */
  directives: string[]
  line: number
}

/** A doc in order: its code blocks, and the directives that stand alone between them. */
type Item = { kind: 'block'; block: Block } | { kind: 'directive'; directive: string; line: number }

function parse(markdown: string): Item[] {
  const items: Item[] = []
  const lines = markdown.split('\n')
  let pending: { directive: string; line: number }[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const directive = /^<!-- docs-test: (.+?) -->$/.exec(line.trim())
    if (directive !== null) {
      pending.push({ directive: directive[1] ?? '', line: i + 1 })
      continue
    }
    // A fence may be indented, inside a list item; its body loses the same indent.
    const fence = /^( *)```(\S*)\s*$/.exec(line)
    if (fence !== null) {
      const start = i + 1
      const indent = fence[1] ?? ''
      const body: string[] = []
      for (i++; i < lines.length && lines[i] !== `${indent}\`\`\``; i++) {
        const each = lines[i] ?? ''
        if (each !== '' && !each.startsWith(indent)) throw new Error(`line ${i + 1}: under-indented in a code block`)
        body.push(each.slice(indent.length))
      }
      const attached = pending.filter((each) => !standalone(each.directive))
      for (const each of pending) if (standalone(each.directive)) items.push({ kind: 'directive', ...each })
      items.push({
        kind: 'block',
        block: { lang: fence[2] ?? '', text: `${body.join('\n')}\n`, directives: attached.map((each) => each.directive), line: start },
      })
      pending = []
      continue
    }
    if (line.trim() !== '') {
      for (const each of pending) {
        if (!standalone(each.directive)) throw new Error(`line ${each.line}: '${each.directive}' is not above a code block`)
        items.push({ kind: 'directive', ...each })
      }
      pending = []
    }
  }
  return items
}

const standalone = (directive: string): boolean => directive.startsWith('build ')

/** A shell command line split into words. Docs commands are literal: no variables, globs or substitutions. */
function words(command: string): string[] {
  const result: string[] = []
  let word: string | null = null
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    if (char === "'") {
      const end = command.indexOf("'", i + 1)
      if (end < 0) throw new Error(`unterminated quote in: ${command}`)
      word = (word ?? '') + command.slice(i + 1, end)
      i = end
    } else if (char === '"') {
      const end = command.indexOf('"', i + 1)
      if (end < 0) throw new Error(`unterminated quote in: ${command}`)
      const text = command.slice(i + 1, end)
      if (/[$`\\]/.test(text)) throw new Error(`docs commands are literal: ${command}`)
      word = (word ?? '') + text
      i = end
    } else if (/\s/.test(char)) {
      if (word !== null) result.push(word)
      word = null
    } else if (/[$`*?|;&<>(){}\\]/.test(char)) {
      throw new Error(`docs commands are literal (found '${char}'): ${command}`)
    } else {
      word = (word ?? '') + char
    }
  }
  if (word !== null) result.push(word)
  return result
}

interface Command {
  argv: string[]
  exitCode: number
  text: string
}

/** The `npx monkeypatchlist …` commands of a code block: shell lines, or the `run:` steps of a CI workflow. */
function commands(block: Block): Command[] {
  const found: Command[] = []
  const joined = block.text.replace(/\\\n\s*/g, ' ')
  for (const raw of joined.split('\n')) {
    const match = /(?:^|\s)npx monkeypatchlist (.*)$/.exec(raw)
    if (match === null) continue
    const [body = '', comment] = (match[1] ?? '').split(/\s+#\s*/, 2)
    const exit = comment === undefined ? null : /^exits (\d)\b/.exec(comment)
    if (comment !== undefined && exit === null) throw new Error(`line ${block.line}: unknown comment '# ${comment}'`)
    found.push({ argv: words(body), exitCode: exit === null ? 0 : Number(exit[1]), text: `npx monkeypatchlist ${body}` })
  }
  return found
}

/**
 * The title line carries the monkeypatchlist and catalog versions, which releases change, and `--version` the analyzer
 * version too; the rest is compared byte for byte.
 */
const normalize = (output: string): string =>
  output
    .replace(/^monkeypatchlist \S+ · catalog \d+ ·/, 'monkeypatchlist <version> · catalog <catalog> ·')
    .replace(/^(monkeypatchlist <version> · catalog <catalog> · analyzer) \S+$/m, '$1 <analyzer>')

/** `expected` is a subset of `actual`: every key it has matches, and every element of its arrays matches one. */
function isSubset(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((each) => actual.some((other) => isSubset(each, other)))
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false
    return Object.entries(expected).every(([key, value]) => key in actual && isSubset(value, (actual as Record<string, unknown>)[key]))
  }
  return Object.is(expected, actual)
}

function sandbox(version: 'v1' | 'v2', dir = mkdtempSync(join(scratch, 'sandbox-'))): string {
  for (const name of exampleFiles) {
    rmSync(join(dir, name), { recursive: true, force: true })
    cpSync(join(example, version, name), join(dir, name), { recursive: true })
  }
  return dir
}

/** No doc example may reach the network: `--mode resolve` runs on a build with no remote scripts. */
const noNetwork = {
  resolveFetcher: () => ({
    fetch: async (url: string): Promise<never> => {
      throw new Error(`a docs example fetched ${url}`)
    },
  }),
}

/** Runs one doc's examples and returns every command it ran. */
async function runDoc(path: string): Promise<Command[]> {
  const cwd = sandbox('v1')
  const ran: Command[] = []
  let last: { command: string; stdout: string } | null = null
  for (const item of parse(read(path))) {
    if (item.kind === 'directive') {
      const build = /^build (v1|v2)$/.exec(item.directive)
      if (build === null) throw new Error(`${path}:${item.line}: unknown directive '${item.directive}'`)
      sandbox(build[1] as 'v1' | 'v2', cwd)
      continue
    }
    const { block } = item
    const where = `${path}:${block.line}`
    const corpus = block.directives.map((each) => /^corpus (\S+)$/.exec(each)?.[1]).find((each) => each !== undefined)
    for (const directive of block.directives) {
      const [kind = '', argument] = directive.split(' ', 2)
      if (kind === 'file' && argument !== undefined) {
        if (block.lang === 'json') JSON.parse(block.text)
        writeFileSync(join(cwd, argument), block.text)
      } else if (kind === 'output') {
        expect(last, `${where}: an output block follows no command`).not.toBeNull()
        expect(normalize(block.text), `${where}: output of \`${last?.command}\``).toBe(normalize(last?.stdout ?? ''))
      } else if (kind === 'subset' && argument !== undefined) {
        const actual = JSON.parse(readFileSync(join(cwd, argument), 'utf8'))
        expect(isSubset(JSON.parse(block.text), actual), `${where}: not a subset of ${argument}`).toBe(true)
      } else if (kind !== 'corpus') {
        throw new Error(`${where}: unknown directive '${directive}'`)
      }
    }
    const found = commands(block)
    if (corpus !== undefined) {
      expect(found.map((each) => each.argv), where).toEqual([['scan', expect.stringMatching(/\S/), '--map', corpusMap]])
      const report = JSON.parse(read(`corpus-snapshot/protected/${corpus}.json`))
      last = { command: found[0]?.text ?? '', stdout: renderTerminal(report) }
      ran.push(...found)
      continue
    }
    for (const command of found) {
      const run: CliRun = await runCli(command.argv, { cwd, deps: noNetwork })
      expect(run.exitCode, `${where}: \`${command.text}\` exited ${run.exitCode}:\n${run.stderr}`).toBe(command.exitCode)
      last = { command: command.text, stdout: run.stdout }
      ran.push(command)
    }
  }
  return ran
}

const ranByDoc = new Map<string, Command[]>()

describe('user docs', () => {
  test.each(docs)('%s: every documented command runs and exits as documented, with the output shown', async (path) => {
    ranByDoc.set(path, await runDoc(path))
  })

  test('the docs run every flag and every command the CLI has', () => {
    const ran = [...ranByDoc.values()].flat()
    expect(ranByDoc.size).toBe(docs.length)
    const flags = new Set(ran.flatMap((command) => command.argv.filter((word) => word.startsWith('--'))))
    expect(cliFlags.filter((flag) => !flags.has(flag))).toEqual([])
    const verbs = new Set(ran.map((command) => (command.argv[0] === 'baseline' ? `baseline ${command.argv[1]}` : command.argv[0])))
    expect([...verbs].sort()).toEqual(['--version', 'baseline init', 'baseline update', 'explain', 'scan'])
  })

  test.each(docs)('%s: names only flags the CLI has', (path) => {
    const named = read(path).match(/(?<![\w-])--[a-z][a-z-]*/g) ?? []
    expect([...new Set(named)].filter((flag) => !cliFlags.includes(flag))).toEqual([])
  })

  test('the configuration guide covers every config key and every flag', () => {
    const guide = read('docs/configuration.md')
    const schema = JSON.parse(read('schema/config.schema.json'))
    for (const key of Object.keys(schema.properties)) expect(guide, key).toContain(`\`${key}\``)
    for (const flag of cliFlags) expect(guide, flag).toContain(`\`${flag}`)
  })

  test('the report guide names every top-level field and every finding field of the report schema', () => {
    const guide = read('docs/report-format.md')
    const schema = JSON.parse(read('schema/report.schema.json'))
    const fields = [...Object.keys(schema.properties), ...Object.keys(schema.$defs.finding.properties)]
    for (const key of fields) expect(guide, key).toContain(`\`${key}\``)
  })

  test.each(docs)('%s: relative links resolve, and nothing points into private project material', (path) => {
    const text = read(path)
    expect(text).not.toMatch(/\.scratch\/|AGENTS\.md|docs\/agents\//)
    // Nor at the design process: spec sections, tickets or the sealed holdout.
    expect(text).not.toMatch(/§|\bticket \d|holdout/i)
    for (const [, target = ''] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/.test(target) || target.startsWith('#')) continue
      const file = target.split('#')[0] ?? ''
      // LICENSE is added by the licensing change that ships alongside these docs.
      if (file === 'LICENSE' || file === '../LICENSE') continue
      expect(existsSync(join(dirname(rootPath(path)), file)), `${path}: ${target}`).toBe(true)
    }
  })
})

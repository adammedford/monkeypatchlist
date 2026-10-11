// Reading the fixture pages (the validation corpus's `fixtures/` root): each page's resolver expectation from
// `expectations.json`, and its build directory under `static-sites/`. Build-time only; never published.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** A fixture page the check can't use, or a root that isn't a fixture-page root. The command exits 2. */
export class FixturePagesError extends Error {}

/** What the scanner is expected to report for one page (spec §20 Fixture pages; corpus README, Fixture pages). */
export interface Expectation {
  /** `target|effect`, one per finding (§3's outcome table: controls and installs). */
  findings: readonly string[]
  /** `target|reason|throws`, one per ineffective-write record and `throws` of its occurrences (§3 Ineffective writes). */
  ineffective: readonly string[]
  /** The target of each proven restore (§3 Restores). */
  restores: readonly string[]
}

/**
 * A page's restore write, as the corpus marks it with `/*R{*\/ … /*}R*\/`: the inline script it is in (the `n`th
 * script without `src`, as the scanner numbers its `#inline-<n>` artifacts) and its UTF-16 range in that script's text.
 */
export interface RestoreRegion {
  inline: number
  start: number
  end: number
}

export interface FixturePage {
  name: string
  /** The page's build directory: `static-sites/<name>/`. */
  dir: string
  expected: Expectation
  restoreRegions: readonly RestoreRegion[]
}

/** Every page `expectations.json` lists, each with its build directory. Every directory must be listed. */
export function readPages(root: string): FixturePage[] {
  const file = join(root, 'expectations.json')
  if (!existsSync(file)) throw new FixturePagesError(`no expectations.json in ${root}`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new FixturePagesError(`${file} is not JSON: ${(error as Error).message}`)
  }
  if (!Array.isArray(raw)) throw new FixturePagesError(`${file} is not a list of pages`)

  const sites = join(root, 'static-sites')
  const pages = raw.map((entry, i) => readPage(entry, i, sites))

  const names = new Set<string>()
  for (const page of pages) {
    if (names.has(page.name)) throw new FixturePagesError(`the page ${page.name} is listed twice`)
    names.add(page.name)
    if (!existsSync(page.dir) || !statSync(page.dir).isDirectory()) {
      throw new FixturePagesError(`the page ${page.name} has no build directory at ${page.dir}`)
    }
    page.restoreRegions = readRestoreRegions(page.name, join(page.dir, 'index.html'))
    if (page.expected.restores.length > 0 && page.restoreRegions.length === 0) {
      throw new FixturePagesError(`the page ${page.name} expects a restore but marks no restore write with /*R{*/ … /*}R*/`)
    }
  }
  // Every page is scanned: a build directory without an expectation would go unchecked.
  const unlisted = existsSync(sites)
    ? readdirSync(sites, { withFileTypes: true }).filter((d) => d.isDirectory() && !names.has(d.name))
    : []
  if (unlisted.length > 0) {
    const list = unlisted.map((d) => d.name).sort()
    throw new FixturePagesError(`static-sites has pages expectations.json doesn't list: ${list.join(', ')}`)
  }
  return pages
}

function readPage(entry: unknown, i: number, sites: string): FixturePage {
  const where = `expectations.json[${i}]`
  if (typeof entry !== 'object' || entry === null) throw new FixturePagesError(`${where} is not a page`)
  const { name, resolver } = entry as Record<string, unknown>
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) throw new FixturePagesError(`${where} has no page name`)
  if (typeof resolver !== 'object' || resolver === null) {
    throw new FixturePagesError(`the page ${name} has no resolver expectation`)
  }
  const fields = resolver as Record<string, unknown>
  return {
    name,
    dir: join(sites, name),
    expected: {
      findings: strings(fields.findings, `${name}: resolver.findings`, true),
      ineffective: strings(fields.ineffective, `${name}: resolver.ineffective`, false),
      restores: strings(fields.restores, `${name}: resolver.restores`, false),
    },
    restoreRegions: [],
  }
}

const scriptElement = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi
const restoreOpen = '/*R{*/'
const restoreClose = '/*}R*/'

/** The marked restore writes of a page's `index.html`, in document order. */
function readRestoreRegions(name: string, file: string): RestoreRegion[] {
  if (!existsSync(file)) throw new FixturePagesError(`the page ${name} has no index.html`)
  const html = readFileSync(file, 'utf8')
  const regions: RestoreRegion[] = []
  let inline = 0
  for (const [, attributes, text] of html.matchAll(scriptElement)) {
    if (/\bsrc\s*=/i.test(attributes!)) continue
    inline++
    let from = 0
    for (;;) {
      const start = text!.indexOf(restoreOpen, from)
      if (start === -1) break
      const close = text!.indexOf(restoreClose, start)
      if (close === -1) throw new FixturePagesError(`the page ${name} opens a restore mark it never closes`)
      const end = close + restoreClose.length
      regions.push({ inline, start, end })
      from = end
    }
  }
  return regions
}

/** A list of strings; an absent optional list is empty. */
function strings(value: unknown, where: string, required: boolean): string[] {
  if (value === undefined && !required) return []
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new FixturePagesError(`${where} is not a list of strings`)
  }
  return value as string[]
}

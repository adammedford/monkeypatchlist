// Catalog enumeration of member sweeps (§5 Resolver capabilities 9, §14 `enumeration`): a sweep over a native
// holder's keys expands against the catalog, including enumerability, each expanded target its own finding at high
// target confidence. Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { loadCatalog } from '../src/catalog.ts'
import { defaultBudget } from '../src/packages/analysis/index.ts'
import { readFileSync } from 'node:fs'
import { scanBuild } from './support/fixture-build.ts'

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const scan = (code: string) => scanBuild(classic(code))

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

const names = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.target.name).sort()
const kinds = (finding: Finding): string[] => finding.occurrences[0].trace.map((step: { kind: string }) => step.kind)
const enumerationOf = (finding: Finding) =>
  finding.occurrences[0].trace.find((step: { kind: string }) => step.kind === 'enumeration')

// The catalog is the independent source of the expected members: the targets named on a holder, as the generator
// wrote them.
const targets = loadCatalog().targets.window
const ownMembers = (holder: string) =>
  Object.entries(targets)
    .filter(([name, target]) => name === `${holder}.${target.member}`)
    .map(([name, target]) => ({ name, ...target }))
const stringOwn = (holder: string) => ownMembers(holder).filter((member) => !member.member.startsWith('@@'))

describe('catalog enumeration of member sweeps', () => {
  test('Object.getOwnPropertyNames(console) gives one finding per string-keyed catalog member of console', async () => {
    const { report } = await scan('Object.getOwnPropertyNames(console).forEach(k => console[k] = wrap(console[k]))')

    const expected = stringOwn('console').map((member) => member.name)
    expect(expected).toContain('console.log')
    expect(names(report)).toEqual(expected.sort())
    for (const finding of report.findings) {
      expect(finding.confidence.target.level).toBe('high')
      expect(finding.effect).toBe('wrap')
      expect(kinds(finding)).toContain('enumeration')
    }
    const log = report.findings.find((finding: Finding) => finding.target.name === 'console.log')
    expect(enumerationOf(log)).toMatchObject({ holder: 'console', enumeration: 'Object.getOwnPropertyNames', member: 'log' })
  })

  test.each([
    ['Object.keys', 'Object.keys(XMLHttpRequest.prototype).forEach(k => { XMLHttpRequest.prototype[k] = wrap(XMLHttpRequest.prototype[k]) })', true],
    ['Object.getOwnPropertyNames', 'Object.getOwnPropertyNames(XMLHttpRequest.prototype).forEach(k => { XMLHttpRequest.prototype[k] = wrap(XMLHttpRequest.prototype[k]) })', false],
    ['a for…of over Object.keys', 'for (const k of Object.keys(XMLHttpRequest.prototype)) XMLHttpRequest.prototype[k] = wrap(XMLHttpRequest.prototype[k])', true],
  ])('%s expands %s members of the holder', async (_, code, enumerableOnly) => {
    const { report } = await scan(code)

    // The operations are writable data properties, so each swept one is a finding. An attribute's setter throws on the
    // prototype (Principle 1), and gives nothing.
    const operations = stringOwn('XMLHttpRequest.prototype').filter((member) => member.kind === 'operation')
    expect(operations.map((member) => member.name)).toContain('XMLHttpRequest.prototype.open')
    expect(names(report).filter((name) => name !== 'XMLHttpRequest.prototype.constructor')).toEqual(
      operations.map((member) => member.name).sort(),
    )
    if (enumerableOnly) expect(names(report)).not.toContain('XMLHttpRequest.prototype.constructor')
    else expect(names(report)).toContain('XMLHttpRequest.prototype.constructor')
  })

  test('for…in over a native holder visits the enumerable members of its catalog chain, each a shadowing write', async () => {
    const { report } = await scan('for (var k in history) history[k] = wrap(history[k])')

    const operations = ownMembers('History.prototype').filter((member) => member.kind === 'operation' && member.descriptor.enumerable)
    expect(operations.length).toBeGreaterThan(1)
    expect(names(report)).toEqual(operations.map((member) => member.name.replace('History.prototype.', 'history.')).sort())
    const push = report.findings.find((finding: Finding) => finding.target.name === 'history.pushState')
    expect(push.target.shadows).toBe('History.prototype.pushState')
    expect(enumerationOf(push)).toMatchObject({ holder: 'history', enumeration: 'for-in', member: 'pushState' })
  })

  test('for…in over the window adds the inherited EventTarget members, named on the window', async () => {
    const { report } = await scan('for (var k in window) if (k === "addEventListener" || k === "fetch") window[k] = wrap(window[k])')

    expect(names(report)).toEqual(['Window.addEventListener', 'Window.fetch'])
  })

  test('a typeof filter on a for…in sweep keeps the function-valued members of the whole chain', async () => {
    const { report } = await scan(
      "for (var k in XMLHttpRequest.prototype) if (typeof XMLHttpRequest.prototype[k] === 'function') XMLHttpRequest.prototype[k] = wrap(XMLHttpRequest.prototype[k])",
    )

    const found = names(report)
    for (const name of ['open', 'send', 'addEventListener', 'removeEventListener', 'dispatchEvent']) {
      expect(found).toContain(`XMLHttpRequest.prototype.${name}`)
    }
    const add = report.findings.find((finding: Finding) => finding.target.name === 'XMLHttpRequest.prototype.addEventListener')
    expect(add.target.shadows).toBe('EventTarget.prototype.addEventListener')
    expect(add.reachability).toBe('unconditional')
    // The sweep visits the XMLHttpRequestEventTarget `on*` members too, but assigning an event handler attribute is
    // API use (§3), so they give nothing.
    expect(found.filter((name) => /\.on\w+$/.test(name))).toEqual([])
  })

  test('Object.entries over a native holder gives each function-valued member, decided by its typeof', async () => {
    const { report } = await scan(
      "Object.entries(console).forEach(([k, v]) => { if (typeof v === 'function') console[k] = wrap(v) })",
    )

    const operations = stringOwn('console').filter((member) => member.kind === 'operation' && member.descriptor.enumerable)
    expect(names(report)).toEqual(operations.map((member) => member.name).sort())
    for (const finding of report.findings) {
      expect(finding.effect).toBe('wrap')
      expect(finding.reachability).toBe('unconditional')
    }
  })

  test.each([
    ['Reflect.ownKeys', 'Reflect.ownKeys(console).forEach(k => { Object.defineProperty(console, k, { value: w }) })', true, true],
    ['Object.getOwnPropertySymbols', 'Object.getOwnPropertySymbols(console).forEach(k => { Object.defineProperty(console, k, { value: w }) })', false, true],
    ['the keys of Object.getOwnPropertyDescriptors', 'Object.keys(Object.getOwnPropertyDescriptors(console)).forEach(k => { Object.defineProperty(console, k, { value: w }) })', true, false],
    ['for…in over Object.getOwnPropertyDescriptors', 'for (var k in Object.getOwnPropertyDescriptors(console)) Object.defineProperty(console, k, { value: w })', true, false],
  ])('%s sweeps the keys ECMA-262 gives it, symbol keys naming @@ members', async (_, code, strings, symbols) => {
    const { report } = await scan(code)

    const found = names(report)
    expect(found.includes('console.@@toStringTag')).toBe(symbols)
    expect(found.includes('console.log')).toBe(strings)
    const expected = ownMembers('console').filter((member) => (member.member.startsWith('@@') ? symbols : strings))
    expect(found).toEqual(expected.map((member) => member.name).sort())
  })

  // zone.js's `patchProperty`, cut down: it redefines an event handler property with an accessor of its own.
  const patch = 'function patch(o, k) { Object.defineProperty(o, k, { get: g, set: s, configurable: true, enumerable: true }) }'
  const onMembers = stringOwn('Window').filter((member) => member.member.startsWith('on') && member.member.length > 2)

  test.each([
    ['a regular-expression literal', '/^on/.test(k)'],
    ['indexOf', "k.indexOf('on') === 0"],
    ['slice', "k.slice(0, 2) === 'on'"],
    ['substr', "k.substr(0,2) == 'on'"],
    ['indexing', "k[0]+k[1]==='on'"],
    ['startsWith and length', "k.startsWith('on') && k.length > 2"],
    ['charAt', "k.charAt(0) === 'o' && k.at(1) === 'n'"],
  ])('a filter written with %s is evaluated on each swept key', async (_, filter) => {
    const { report } = await scan(`${patch}\nObject.getOwnPropertyNames(window).forEach(k => { if (${filter}) patch(window, k) })`)

    expect(onMembers.length).toBe(132)
    expect(names(report)).toEqual(onMembers.map((member) => member.name).sort())
    for (const finding of report.findings) {
      expect(finding.effect).toBe('descriptor-change')
      expect(finding.reachability).toBe('unconditional')
      expect(finding.confidence.target.level).toBe('high')
    }
    expect(report.completeness.level).toBe('complete')
  })

  test.each([
    ['an unresolved call', 'cfg.shouldPatch(k)'],
    ['a RegExp built at runtime', 'new RegExp(userInput).test(k)'],
    ['a page-set list', 'window.__ignore.indexOf(k) === -1'],
  ])('a filter on %s expands every member it may keep, at conditional reachability', async (_, filter) => {
    const { report } = await scan(
      `${patch}\nObject.getOwnPropertyNames(window).filter(n => n.startsWith('on')).forEach(k => { if (${filter}) patch(window, k) })`,
    )

    expect(names(report)).toEqual(onMembers.map((member) => member.name).sort())
    for (const finding of report.findings) {
      expect(finding.reachability).toBe('conditional')
      expect(finding.confidence.target.level).toBe('high')
      const guards = finding.occurrences[0].trace.filter((step: { kind: string }) => step.kind === 'guard')
      expect(guards.map((step: { class: string }) => step.class)).toContain('undecided')
    }
  })

  test('an undecided filter call keeps every member it may keep, each a constant, at conditional reachability', async () => {
    const { report } = await scan(
      `${patch}\nObject.getOwnPropertyNames(window).filter(n => n.startsWith('on') && cfg.keep(n)).forEach(k => patch(window, k))`,
    )

    expect(names(report)).toEqual(onMembers.map((member) => member.name).sort())
    const onload = report.findings.find((finding: Finding) => finding.target.name === 'Window.onload')
    expect(onload.reachability).toBe('conditional')
    expect(onload.confidence.target.level).toBe('high')
    expect(enumerationOf(onload)).toMatchObject({
      holder: 'Window',
      enumeration: 'Object.getOwnPropertyNames',
      member: 'onload',
      filters: [{ result: 'undecided' }],
    })
    const guard = onload.occurrences[0].trace.find((step: { kind: string }) => step.kind === 'guard')
    expect(guard).toMatchObject({ class: 'undecided', result: 'conditional' })
  })

  // zone.js's `getOnEventNames`, and its indexed loop over the names it gives.
  const onEventNames = "Object.getOwnPropertyNames(window).filter(n => n.startsWith('on') && n.length > 2).map(n => n.substring(2))"
  const indexed = 'for (let i = 0; i < properties.length; i++) patch(window, "on" + properties[i])'
  const smallCaps = { ...defaultBudget, caps: { ...defaultBudget.caps, iterations: 4, contexts: 4, alternatives: 4 } }

  test.each([
    ['decided', `var properties = ${onEventNames};`, 'unconditional'],
    ['undecided', `var properties = ${onEventNames}.filter(n => ignored.indexOf(n) === -1);`, 'conditional'],
  ])('an indexed loop over a %s catalog-bounded list unrolls every element, uncapped', async (_, list, reachability) => {
    const { report } = await scanBuild(classic(`${patch}\n${list}\n${indexed}`), [], { deps: { budget: smallCaps } })

    expect(names(report)).toEqual(onMembers.map((member) => member.name).sort())
    for (const finding of report.findings) expect(finding.reachability).toBe(reachability)
    expect(report.completeness.level).toBe('complete')
    expect(report.completeness.limitations).toEqual([])
  })

  test('a list that mixes in code-built elements falls back under the iteration cap', async () => {
    const code = `${patch}\nvar properties = ${onEventNames}.concat(['x']);\n${indexed}`
    const { report } = await scanBuild(classic(code), [], { deps: { budget: smallCaps } })

    expect(report.findings.length).toBeLessThan(onMembers.length)
    expect(report.completeness.limitations.map((limitation: { kind: string }) => limitation.kind)).toContain('analysis-budget')
  })

  test("zone.js's propertyDescriptorPatch gives one descriptor-change per on* member of Window, conditional through its undecided ignore list", async () => {
    const fixture = new URL('fixtures/zone-on-properties/', import.meta.url)
    const files = Object.fromEntries(['index.html', 'main.js'].map((name) => [name, readFileSync(new URL(name, fixture), 'utf8')]))
    const { report } = await scanBuild(files, [], { deps: { budget: smallCaps } })

    expect(names(report)).toEqual(onMembers.map((member) => member.name).sort())
    for (const finding of report.findings) {
      expect(finding.effect).toBe('descriptor-change')
      expect(finding.reachability).toBe('conditional')
      expect(finding.confidence.target.level).toBe('high')
      expect(kinds(finding)).toContain('enumeration')
    }
    expect(report.completeness.limitations).toEqual([])
  })

  test('prefix, length and exclusion-list filters are applied, and the enumeration step records them', async () => {
    const { report } = await scan(
      `${patch}\nfor (var k in window) if (k.startsWith('on') && k.length > 2 && ['onclick', 'onload'].indexOf(k) === -1) patch(window, k)`,
    )

    const kept = onMembers.filter((member) => member.descriptor.enumerable && !['onclick', 'onload'].includes(member.member))
    expect(names(report)).toEqual(kept.map((member) => member.name).sort())
    const onabort = report.findings.find((finding: Finding) => finding.target.name === 'Window.onabort')
    expect(enumerationOf(onabort)).toMatchObject({
      holder: 'Window',
      enumeration: 'for-in',
      member: 'onabort',
      filters: [
        { expression: 'k.startsWith("on")', result: 'kept' },
        { expression: 'k.length > 2', result: 'kept' },
        { expression: '["onclick", "onload"].indexOf(k) === -1', result: 'kept' },
      ],
    })
  })
})

// Factory wrap evidence through fill-style helpers (§5 Resolver capabilities 10, §8 Effect and mechanism): a
// helper that reads `source[name]`, passes it to a factory and writes the factory's result back gives a `wrap` when the
// factory is a user function or unresolved. Every scenario goes through `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

const scan = async (code: string) => (await scanBuild(classic(code))).report
/** Each finding as `target|effect`. */
const found = (report: { findings: Finding[] }): string[] =>
  report.findings.map((finding) => `${finding.target.name}|${finding.effect}`)

/** Sentry 7's `fill` (`@sentry/utils` `object.js`), as shipped. */
const fill = lines(
  'function fill(source, name, replacementFactory) {',
  '  if (!(name in source)) { return }',
  '  const original = source[name]',
  '  const wrapped = replacementFactory(original)',
  "  if (typeof wrapped === 'function') { markFunctionWrapped(wrapped, original) }",
  '  source[name] = wrapped',
  '}',
)

describe('factory wrap evidence through a fill-style helper', () => {
  test('a user-function factory given the original the helper reads is a wrap', async () => {
    const report = await scan(
      lines(
        fill,
        "fill(XMLHttpRequest.prototype, 'open', function (orig) { return function () { return orig.apply(this, arguments) } })",
      ),
    )
    expect(found(report)).toEqual(['XMLHttpRequest.prototype.open|wrap'])
  })

  test.each([
    ['an arrow factory', "fill(XMLHttpRequest.prototype, 'open', orig => function(){ return orig.apply(this, arguments) })", ['XMLHttpRequest.prototype.open|wrap']],
    ['an unresolved factory', "fill(window, 'fetch', makeWrapper)", ['Window.fetch|wrap']],
    ['a factory whose result never calls the original, since the rule looks only at the call', "fill(window, 'fetch', () => polyfillFetch)", ['Window.fetch|wrap']],
    [
      'a helper called for several targets',
      "fill(console, 'log', o => function(){ return o.apply(console, arguments) }); fill(console, 'warn', o => function(){ return o.apply(console, arguments) })",
      ['console.log|wrap', 'console.warn|wrap'],
    ],
  ])('%s through the helper is a wrap', async (_, call, expected) => {
    const report = await scan(lines(fill, call))
    expect(found(report)).toEqual(expected)
  })

  test('a catalog native factory through the helper is a replace', async () => {
    const report = await scan(lines(fill, "fill(window, 'Promise', Object.freeze)"))
    expect(found(report)).toEqual(['Window.Promise|replace'])
  })

  test('a factory given something other than the read original is a replace', async () => {
    const helper = lines(
      'function fillWith(source, name, factory, seed) {',
      '  const made = factory(seed)',
      '  source[name] = made',
      '}',
    )
    const report = await scan(lines(helper, "fillWith(window, 'fetch', s => function(){ return s }, 1)"))
    expect(found(report)).toEqual(['Window.fetch|replace'])
  })
})

// In a dynamic import's options, and in the `with` they give, the left operand of `&&` counts only as its falsy value
// (§2 Import attributes; Principles 1 and 2).

import { describe, expect, test } from 'vitest'
import { scanBuild } from './support/fixture-build.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Json = any

/** Scans a module that makes one dynamic import of `./t.js` with `args`, and gives what it followed and recorded. */
async function scanImport(args: string) {
  const { report } = await scanBuild({
    'index.html': '<script type="module" src="main.js"></script>',
    'main.js': `const c = Math.random() > 0.5\nimport("./t.js", ${args})`,
    't.js': 'window.fetch = f',
  })
  const followed = report.artifacts.some(({ url, discovery }: Json) => url.endsWith('/t.js') && discovery === 'reference')
  const records = report.completeness.limitations.map(({ kind }: Json) => kind)
  return { followed, records, level: report.completeness.level }
}

describe("`&&`'s left operand is its falsy value", () => {
  test('a name on the left follows the specifier as JavaScript and raises no record', async () => {
    const scan = await scanImport('c && { with: { type: "json" } }')

    expect(scan).toEqual({ followed: true, records: [], level: 'complete' })
  })
})

describe('`||` and `??` keep their branch-by-branch reading, and an unreadable branch is still recorded', () => {
  test.each([
    ['c || { with: { type: "json" } }', false, ['unresolved-reference']],
    ['c ?? { with: { type: "json" } }', false, ['unresolved-reference']],
    ['c ? undefined : o', true, ['unresolved-reference']],
  ])('import(s, %s)', async (args, followed, records) => {
    const scan = await scanImport(args)

    expect({ followed: scan.followed, records: scan.records }).toEqual({ followed, records })
  })
})

describe('the falsy reading applies wherever an `&&` gives the options, and only there', () => {
  test.each([
    // An `&&` that is a branch of a `?:`, or the right operand of `||`, still gives the options.
    ['c ? (c && { with: { type: "json" } }) : { with: { type: "css" } }', true, []],
    ['c || (c && { with: { type: "json" } })', true, ['unresolved-reference']],
    // A left operand the analyzer reads as never falsy gives no branch; a falsy one other than `undefined` is rejected.
    ['{} && { with: { type: "json" } }', false, []],
    ['"x" && { with: { type: "json" } }', false, []],
    ['"" && { with: { type: "json" } }', false, []],
    ['null && { with: { type: "json" } }', false, []],
    // `&&` as `||`'s left operand stays as built (it gives the options only when truthy).
    ['(c && c) || { with: { type: "json" } }', false, ['unresolved-reference']],
  ])('import(s, %s)', async (args, followed, records) => {
    const scan = await scanImport(args)

    expect({ followed: scan.followed, records: scan.records }).toEqual({ followed, records })
  })
})

describe("`&&` that gives the `with` value: its left operand is its falsy value", () => {
  test('a name on the left follows the specifier as JavaScript and raises no record', async () => {
    const scan = await scanImport('{ with: c && { type: "json" } }')

    expect(scan).toEqual({ followed: true, records: [], level: 'complete' })
  })

  test.each([
    // A readable object on the left is never falsy, so only the JSON reading is left.
    ['{ with: {} && { type: "json" } }', false, []],
    ['{ with: { type: "css" } && { type: "json" } }', false, []],
    // A falsy `with` other than `undefined` is rejected (Principle 1).
    ['{ with: null && { type: "json" } }', false, []],
    // `||` and `??` inside `with` keep their reading.
    ['{ with: c || { type: "json" } }', false, ['unresolved-reference']],
    ['{ with: c ?? { type: "json" } }', false, ['unresolved-reference']],
    ['{ with: c ? undefined : { type: "json" } }', true, []],
    // Wherever an `&&` gives the `with` value: a branch of a `?:` in `with`, `with` in a branch of the options, the
    // options' prototype, or a spread into the options.
    ['{ with: c ? (c && { type: "json" }) : { type: "css" } }', true, []],
    ['c ? { with: c && { type: "json" } } : undefined', true, []],
    ['{ with: c && { type: "json" } } ?? { with: { type: "css" } }', true, []],
    ['{ __proto__: { with: c && { type: "json" } } }', true, []],
    ['{ ...{ with: c && { type: "json" } } }', true, []],
    // An `&&` deeper inside `with` gives an attribute's value, not `with`: a `type` names no JavaScript module whatever
    // its value.
    ['{ with: { type: c && "json" } }', false, []],
  ])('import(s, %s)', async (args, followed, records) => {
    const scan = await scanImport(args)

    expect({ followed: scan.followed, records: scan.records }).toEqual({ followed, records })
  })
})

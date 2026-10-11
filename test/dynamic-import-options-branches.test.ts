// Dynamic-import options read branch by branch (§2 Import attributes; §13
// `unresolved-reference`; Principle 3).

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
  return { followed, records, report }
}

describe('conditional and logical options are read branch by branch (§2 Import attributes)', () => {
  test.each([
    ['c ? { with: { type: "json" } } : undefined', true, []],
    ['c ? undefined : { with: { type: "json" } }', true, []],
    ['undefined && { with: { type: "json" } }', true, []],
    ['undefined || { with: { type: "json" } }', true, []],
    ['undefined ?? { with: { type: "json" } }', true, []],
    // Each operand is a branch, a name included (Principle 3); `&&`'s left operand is its falsy value.
    ['c || { with: { type: "json" } }', false, ['unresolved-reference']],
    ['c ?? undefined', true, ['unresolved-reference']],
    ['c ? { with: { type: "json" } } : { with: { type: "css" } }', false, []],
    ['{ with: c ? { type: "json" } : undefined }', true, []],
    ['{ with: c ? { type: "json" } : { type: "css" } }', false, []],
    ['{ with: undefined || { type: "json" } }', true, []],
    ['{ with: c ? { type: "json" } : o }', false, ['unresolved-reference']],
    ['c ? { with: { type: "json" } } : o', false, ['unresolved-reference']],
  ])('import(s, %s)', async (args, followed, kinds) => {
    const scan = await scanImport(args)
    expect({ followed: scan.followed, records: scan.records }).toEqual({ followed, records: kinds })
  })

  test('options that are a class or have an accessor `with` keep today\'s record', async () => {
    for (const args of ['class {}', '{ get with() { return 1 } }', 'c ? class {} : { with: { type: "json" } }']) {
      const scan = await scanImport(args)
      expect({ args, followed: scan.followed, records: scan.records }).toEqual({
        args,
        followed: false,
        records: ['unresolved-reference'],
      })
    }
  })
})

describe('an unreadable branch that could change `with`', () => {
  test('still raises the record when another branch follows the specifier', async () => {
    const { followed, records, report } = await scanImport('c ? undefined : o')

    expect(followed).toBe(true)
    expect(records).toEqual(['unresolved-reference'])
    expect(report.completeness.level).toBe('complete-with-limitations')
  })

  test('also for a `with` branch', async () => {
    const { followed, records } = await scanImport('{ with: c ? undefined : o }')

    expect(followed).toBe(true)
    expect(records).toEqual(['unresolved-reference'])
  })
})

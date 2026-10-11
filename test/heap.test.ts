// The heap (§5 Resolver capabilities 5): a flow-insensitive heap keyed by allocation site. Object and array literals,
// `new` expressions and the objects some natives return are allocation sites, each per summary instantiation and per
// unrolled loop iteration. A field's values are what its literal gives it and what the code writes to it anywhere; a
// field written after allocation may be absent, which touches presence only. Heap-read values never decide a test.
// Descriptors are heap objects, and the global object's expandos share one heap cell. Every scenario goes through
// `monkeypatchlist scan --json`.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'
import { mappings, type Segment } from './support/source-map.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

// The shipped resolver, with eslint-scope behind the binding-resolution seam, and the verified drop-in (§19).
const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join('\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Finding = any

/**
 * A build whose `main.js` has one line per source, each copied unchanged from its own original file, with a sidecar map
 * that holds each file's content.
 */
function mapped(files: [source: string, code: string][]): Record<string, string> {
  const code = files.map(([, text]) => text).join('\n')
  const lines = files.map(([, text], index) => {
    const segments: Segment[] = []
    for (const match of text.matchAll(/[\w$]+|[^\s\w$]/g)) segments.push([match.index, index, 0, match.index])
    return segments
  })
  const map = {
    version: 3,
    sources: files.map(([source]) => source),
    sourcesContent: files.map(([, text]) => text),
    names: [],
    mappings: mappings(lines),
  }
  return { 'index.html': '<script src="main.js"></script>', 'main.js': code, 'main.js.map': JSON.stringify(map) }
}

const sdk = 'webpack://app/./node_modules/@acme/sdk/index.js'
const patchKit = 'webpack://app/./node_modules/patch-kit/index.js'

const fingerprints = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.fingerprint)
/** A finding's attribution key: the last part of its fingerprint (§11). */
const keyOf = (finding: Finding): string => finding.fingerprint.split('|').at(-1)
const names = (report: { findings: Finding[] }): string[] => report.findings.map((finding) => finding.target.name)
const send = 'window|XMLHttpRequest.prototype.send|replace|unknown'

describe.each(resolvers)('the heap, with %s behind the binding-resolution seam', (_, resolver) => {
  const scan = (code: string) => scanBuild(classic(code), [], { deps: { resolver } })

  test('a holder read from an object literal field is that holder', async () => {
    const { report } = await scan('const cfg = { t: XMLHttpRequest.prototype }; cfg.t.send = w')

    expect(fingerprints(report)).toEqual([send])
    expect(report.findings[0].occurrences[0].confidence.target.level).toBe('high')
  })

  test.each([
    ['an array literal', 'const list = []; list.t = XMLHttpRequest.prototype; list.t.send = w'],
    ['a new of a user class', 'function Cfg() {} const o = new Cfg(); o.t = XMLHttpRequest.prototype; o.t.send = w'],
    ['an object passed to a function that writes it', 'function init(o) { o.t = XMLHttpRequest.prototype } const c = {}; init(c); c.t.send = w'],
  ])('a field written to %s reads back', async (_, code) => {
    const { report } = await scan(code)

    expect(fingerprints(report)).toEqual([send])
  })

  test('an expando on a native holder is a heap cell', async () => {
    const { report } = await scan('XMLHttpRequest.__impl = { t: history }; XMLHttpRequest.__impl.t.pushState = w')

    expect(names(report)).toEqual(['XMLHttpRequest.__impl', 'history.pushState'])
  })

  describe('a property written after allocation is maybe-absent, which touches presence only', () => {
    test('a read of it returns only the values written, with no undefined', async () => {
      const { report } = await scan("const m = {}; m.name = 'send'; XMLHttpRequest.prototype[m.name] = w")

      expect(fingerprints(report)).toEqual([send])
      expect(report.findings[0].confidence.target.level).toBe('high')
    })

    test('a field holding the original, written back, is a write-back and gives nothing', async () => {
      const { report } = await scan('const s = {}; s.orig = window.fetch; window.fetch = s.orig')

      expect(fingerprints(report)).toEqual([])
    })

    test.each([
      ['if (s.orig)', "const s = {}; s.orig = 'send'; if (s.orig) XMLHttpRequest.prototype.send = w"],
      ['s.orig || p', "const s = {}; s.orig = 'send'; XMLHttpRequest.prototype[s.orig || 'open'] = w"],
    ])('a presence test of it stays undecided: %s', async (_, code) => {
      const { report } = await scan(code)

      // `if (s.orig)` keeps its arm, and `s.orig || 'open'` both its alternatives, each a candidate.
      expect(names(report)).toEqual(
        code.includes('if') ? ['XMLHttpRequest.prototype.send'] : ['XMLHttpRequest.prototype.open', 'XMLHttpRequest.prototype.send'],
      )
    })
  })

  describe('heap-read constants and presence never decide a test', () => {
    test.each([
      ['?:', "XMLHttpRequest.prototype[c.on ? 'open' : 'send'] = w", ['open', 'send']],
    ])('a heap-read constant in %s selection is not decided', async (_, write, members) => {
      const { report } = await scan(lines("const c = { on: true, off: false, none: null }", write))

      // Both alternatives stay, each a candidate with `member-alternatives`.
      expect(names(report)).toEqual(members.map((member) => `XMLHttpRequest.prototype.${member}`))
      for (const finding of report.findings) expect(finding.confidence.target.reasons).toEqual(['member-alternatives'])
    })

    test.each([
      ['&&', "XMLHttpRequest.prototype[c.on && 'open'] = w", 'open'],
      ['&&, a heap false', "XMLHttpRequest.prototype[c.off && 'open'] = w", 'open'],
      ['||', "XMLHttpRequest.prototype[c.off || 'send'] = w", 'send'],
      ['||, a heap true', "XMLHttpRequest.prototype[c.on || 'send'] = w", 'send'],
      ['??', "XMLHttpRequest.prototype[c.none ?? 'send'] = w", 'send'],
      ['??, a heap undefined', "XMLHttpRequest.prototype[c.gone ?? 'send'] = w", 'send'],
      ['??, a heap true', "XMLHttpRequest.prototype[c.on ?? 'send'] = w", 'send'],
      ['&&, through a variable', "const k = c.on && 'open'; XMLHttpRequest.prototype[k] = w", 'open'],
    ])(
      'a heap-read test operand\'s boolean, null or undefined in %s selection is never a key, and the key keeps member-alternatives',
      async (_, write, member) => {
        const { report } = await scan(lines('const c = { on: true, off: false, none: null, gone: undefined }', write))

        expect(names(report)).toEqual([`XMLHttpRequest.prototype.${member}`])
        expect(report.findings[0].confidence.target.level).toBe('medium')
        expect(report.findings[0].confidence.target.reasons).toEqual(['member-alternatives'])
        const step = report.findings[0].occurrences[0].trace.find(
          (each: Finding) => each.kind === 'confidence-reason' && each.reason === 'member-alternatives',
        )
        expect(step).toBeDefined()
      },
    )

    test('a boolean read from the heap and used as a key is still one: o[c.on] names .true', async () => {
      const { report } = await scan(lines('const c = { on: true }', 'XMLHttpRequest.prototype[c.on] = w'))

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.true'])
    })

    test("an object literal's field values that Object.values iterates are heap values too", async () => {
      const { report } = await scan("for (const v of Object.values({ a: true })) XMLHttpRequest.prototype[v ? 'open' : 'send'] = w")

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.open', 'XMLHttpRequest.prototype.send'])
    })

    test('a heap-read constant tested in an if statement never prunes its arm', async () => {
      const { report } = await scan(lines('const c = { on: false }', 'if (c.on) XMLHttpRequest.prototype.send = w'))

      expect(fingerprints(report)).toEqual([send])
    })

    test("a native holder read from the heap is still that holder: the write's holder is history", async () => {
      const { report } = await scan(
        "const t = { h: history }; if (!Object.prototype.hasOwnProperty.call(t.h, 'pushState')) t.h.pushState = w",
      )

      // The un-negated test is statically false against the catalog, so its write is pruned:
      // test/catalog-checked-guards.test.ts shows that half.
      expect(names(report)).toEqual(['history.pushState'])
    })
  })

  describe('an object literal passed directly as a call argument decides tests inside that call', () => {
    // core-js's export helper (core-js@3.50.0 `internals/export.js`): its holder comes from the options literal.
    const exportHelper = lines(
      'function $(options, source) {',
      '  var GLOBAL = options.global, STATIC = options.stat, target, key',
      '  if (GLOBAL) target = window',
      '  else if (STATIC) target = window[options.target]',
      '  else target = window[options.target].prototype',
      '  for (key in source) target[key] = source[key]',
      '}',
    )

    test("the export helper called with { target: 'Array', proto: true } writes only the proto arm's holder", async () => {
      const { report } = await scan(lines(exportHelper, "$({ target: 'Array', proto: true }, { at: function () {} })"))

      expect(names(report)).toEqual(['Array.prototype.at'])
    })

    test.each([
      ['global', "$({ global: true }, { fetch: function () {} })", 'Window.fetch'],
      ['stat', "$({ target: 'Promise', stat: true }, { any: function () {} })", 'Promise.any'],
    ])('a %s literal takes its own arm', async (_, call, name) => {
      const { report } = await scan(lines(exportHelper, call))

      expect(names(report)).toEqual([name])
    })

    test.each([
      ['?:', "function f(o) { XMLHttpRequest.prototype[o.on ? 'open' : 'send'] = w } f({ on: true })", ['open']],
      ['&&', "function f(o) { XMLHttpRequest.prototype[o.on && 'open' || 'send'] = w } f({})", ['send']],
      ['??', "function f(o) { XMLHttpRequest.prototype[o.k ?? 'send'] = w } f({})", ['send']],
      ['an if statement', 'function f(o) { if (o.off) XMLHttpRequest.prototype.open = w; XMLHttpRequest.prototype.send = w } f({ off: false })', ['send']],
    ])('a property read in %s decides, and an absent one reads undefined', async (_, code, members) => {
      const { report } = await scan(code)

      expect(names(report)).toEqual(members.map((member) => `XMLHttpRequest.prototype.${member}`))
    })

    test("a call in an arm the literal rules out is not reached: core-js's defineGlobalProperty in the STATIC arm", async () => {
      const { report } = await scan(
        lines(
          'function defineGlobal(name) { window[name] = {} }',
          'function $(options) { if (options.stat) defineGlobal(options.target) }',
          "$({ target: 'Array', proto: true })",
          "$({ target: 'Iterator', stat: true })",
        ),
      )

      expect(names(report)).toEqual(['Window.Iterator'])
    })

    test('two calls with different literals each take their own arm', async () => {
      const { report } = await scan(
        lines("function f(o) { XMLHttpRequest.prototype[o.on ? 'open' : 'send'] = w }", 'f({ on: true })', 'f({ on: false })'),
      )

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.open', 'XMLHttpRequest.prototype.send'])
    })

    test.each([
      ['a literal written after the call', "function f(o) { XMLHttpRequest.prototype[o.on ? 'open' : 'send'] = w; return o } var r = f({ on: true }); r.on = false"],
      ['a literal written inside the call', "function f(o) { o.on = true; XMLHttpRequest.prototype[o.on ? 'open' : 'send'] = w } f({ on: true })"],
      ['a literal written at another key', "function f(o) { o.seen = 1; XMLHttpRequest.prototype[o.on ? 'open' : 'send'] = w } f({ on: true })"],
      ['a literal bound to a variable, not passed directly', "function f(o) { XMLHttpRequest.prototype[o.on ? 'open' : 'send'] = w } var c = { on: true }; f(c)"],
      ['a read outside the call', "var kept; function f(o) { kept = o } f({ on: true }); XMLHttpRequest.prototype[kept.on ? 'open' : 'send'] = w"],
      ['a property it inherits from Object.prototype', "function f(o) { XMLHttpRequest.prototype[o.toString ? 'open' : 'send'] = w } f({})"],
      ['a literal with a spread', "function f(o) { XMLHttpRequest.prototype[o.on ? 'open' : 'send'] = w } f({ ...x })"],
      ['a literal with a __proto__', "function f(o) { XMLHttpRequest.prototype[o.on ? 'open' : 'send'] = w } f({ __proto__: x })"],
    ])('%s keeps the test undecided', async (_, code) => {
      const { report } = await scan(code)

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.open', 'XMLHttpRequest.prototype.send'])
    })

    test.each([
      ['a key it has', "{ on: 'open' }", ['open', 'send']],
      ['a key it lacks, with no undefined added', '{}', ['send']],
    ])('a read of %s that the code writes gives what the code writes too', async (_, literal, members) => {
      const { report } = await scan(`function f(o) { XMLHttpRequest.prototype[o.on] = w; o.on = 'send' } f(${literal})`)

      expect(names(report)).toEqual(members.map((member) => `XMLHttpRequest.prototype.${member}`))
    })

    test("a module-level table keeps its test undecided: core-js's DOMIterables[NAME]", async () => {
      const { report } = await scan(
        lines(
          'var DOMIterables = { NodeList: 1, Foo: 0 }',
          'function handle(NAME) { if (DOMIterables[NAME]) window[NAME].prototype.forEach = w; else window[NAME].prototype.item = w }',
          "handle('NodeList')",
        ),
      )

      expect(names(report)).toEqual(['NodeList.prototype.forEach', 'NodeList.prototype.item'])
    })

    test("a native presence test through the literal's field keeps its tested native: rrweb's `void 0 !== win.WebGLRenderingContext`", async () => {
      const { report } = await scan(
        'function f(o) { if (void 0 !== o.win.WebGLRenderingContext) o.win.WebGLRenderingContext.prototype.getError = w } f({ win: window })',
      )

      const guards = report.findings[0].occurrences[0].trace.filter((step: { kind: string }) => step.kind === 'guard')
      expect(guards).toMatchObject([{ class: 'transparent', tested: 'Window.WebGLRenderingContext', result: 'unconditional' }])
    })

    test("an absence test of a native through the literal's field is no argument-literal test: its polyfill stays a finding", async () => {
      const { report } = await scan(
        'function f(o) { if (void 0 === o.win.WebGLRenderingContext) o.win.WebGLRenderingContext = w } f({ win: window })',
      )

      expect(names(report)).toEqual(['Window.WebGLRenderingContext'])
      const guards = report.findings[0].occurrences[0].trace.filter((step: { kind: string }) => step.kind === 'guard')
      expect(guards).toMatchObject([{ class: 'absence', tested: 'Window.WebGLRenderingContext', result: 'guarded-native-absence' }])
    })
  })

  describe('each write the argument-literal rule drops is counted and traced as a prune', () => {
    const pruned = (report: Finding): number => report.completeness.counters.statistics.pruned
    const prunes = (report: Finding, name: string): Finding[] =>
      report.findings
        .find((finding: Finding) => finding.target.name === name)
        .occurrences.flatMap((occurrence: Finding) => occurrence.trace)
        .filter((step: Finding) => step.kind === 'prune')
        .map(({ text, ...fields }: Finding) => {
          expect(typeof text).toBe('string')
          return fields
        })

    test('a write in an if arm the literal rules out is counted', async () => {
      const { report } = await scan(
        'function f(o) { if (o.off) XMLHttpRequest.prototype.open = w; XMLHttpRequest.prototype.send = w } f({ off: false })',
      )

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.send'])
      expect(pruned(report)).toBe(1)
    })

    test('the write in the arm the literal lets through traces the prune: the test, its count and the literal', async () => {
      const { report } = await scan(
        'function f(o) { if (o.on) XMLHttpRequest.prototype.open = w; else XMLHttpRequest.prototype.send = w }\nf({ on: false })',
      )

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.send'])
      expect(pruned(report)).toBe(1)
      expect(prunes(report, 'XMLHttpRequest.prototype.send')).toEqual([
        {
          kind: 'prune',
          count: 1,
          expression: 'o.on',
          generated: { start: 20, end: 24, line: 1, column: 20 },
          judgement: 'argument-literal',
          literal: { expression: '{ on: false }', generated: { start: 104, end: 117, line: 2, column: 2 } },
        },
      ])
      const kinds = report.findings[0].occurrences[0].trace.map((step: Finding) => step.kind)
      expect(kinds.indexOf('prune')).toBe(kinds.indexOf('guard') + 1)
    })

    // core-js's export helper, as `internals/export.js` has it: its holder comes from the arm the options literal takes.
    const exportHelper = lines(
      'function $(options, source) {',
      '  var GLOBAL = options.global, STATIC = options.stat, target, key',
      '  if (GLOBAL) target = window',
      '  else if (STATIC) target = window[options.target]',
      '  else target = window[options.target].prototype',
      '  for (key in source) target[key] = source[key]',
      '}',
    )

    const literal = { expression: '{ target: "Array", proto: true }', generated: { start: 278, end: 310, line: 8, column: 2 } }
    const ruledOut = (expression: string, generated: object) => ({ kind: 'prune', count: 1, expression, generated, judgement: 'argument-literal', literal })
    const global = ruledOut('GLOBAL', { start: 102, end: 108, line: 3, column: 6 })
    const statics = ruledOut('STATIC', { start: 137, end: 143, line: 4, column: 11 })

    test("core-js's export helper gives only the proto arm's finding, and a prune for the write the STATIC arm drops", async () => {
      const { report } = await scan(lines(exportHelper, "$({ target: 'Array', proto: true }, { at: function () {} })"))

      expect(names(report)).toEqual(['Array.prototype.at'])
      // `Array.at`, from the STATIC arm. The GLOBAL arm's `window.at` is an expando, which is no write of a target.
      expect(pruned(report)).toBe(1)
      expect(prunes(report, 'Array.prototype.at')).toEqual([statics])
    })

    test('each write the export helper drops is put with the test whose arm alone gives it', async () => {
      const { report } = await scan(lines(exportHelper, "$({ target: 'Array', proto: true }, { fetch: function () {} })"))

      expect(names(report)).toEqual(['Array.prototype.fetch'])
      // `Window.fetch` from the GLOBAL arm, and `Array.fetch` from the STATIC arm.
      expect(pruned(report)).toBe(2)
      expect(prunes(report, 'Array.prototype.fetch')).toEqual([global, statics])
    })

    test("a ?: alternative the literal rules out is counted, and the selected one's write traces it", async () => {
      const { report } = await scan("function f(o) { XMLHttpRequest.prototype[o.on ? 'open' : 'send'] = w }\nf({ on: true })")

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.open'])
      expect(pruned(report)).toBe(1)
      expect(prunes(report, 'XMLHttpRequest.prototype.open')).toEqual([
        {
          kind: 'prune',
          count: 1,
          expression: 'o.on',
          generated: { start: 41, end: 45, line: 1, column: 41 },
          judgement: 'argument-literal',
          literal: { expression: '{ on: true }', generated: { start: 73, end: 85, line: 2, column: 2 } },
        },
      ])
    })

    test('a literal whose field the code writes after the call keeps both arms and gives no prune', async () => {
      const { report } = await scan(
        "function f(o) { XMLHttpRequest.prototype[o.on ? 'open' : 'send'] = w; return o } var r = f({ on: true }); r.on = false",
      )

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.open', 'XMLHttpRequest.prototype.send'])
      expect(pruned(report)).toBe(0)
      expect(report.findings.flatMap((finding: Finding) => finding.occurrences.flatMap((each: Finding) => each.trace)).filter((step: Finding) => step.kind === 'prune')).toEqual([])
    })
  })

  describe('an allocation site is a syntactic site per summary instantiation and per unrolled loop iteration', () => {
    test.each([
      [
        'a factory called twice',
        lines(
          'function spec(h, m) { return { h, m } }',
          'function install(s) { s.h[s.m] = wrap(s.h[s.m]) }',
          "install(spec(XMLHttpRequest.prototype, 'send')); install(spec(WebSocket.prototype, 'close'))",
        ),
      ],
      [
        'one literal per unrolled iteration',
        "for (const [h, m] of [[XMLHttpRequest.prototype, 'send'], [WebSocket.prototype, 'close']]) { const t = { h, m }; t.h[t.m] = w }",
      ],
    ])('%s gives exactly the two targets, at high target confidence', async (_, code) => {
      const { report } = await scan(code)

      expect(names(report)).toEqual(['WebSocket.prototype.close', 'XMLHttpRequest.prototype.send'])
      for (const finding of report.findings) expect(finding.confidence.target.level).toBe('high')
    })
  })

  describe('a global expando shares one heap cell across free names and member forms', () => {
    test.each([
      ['the loader shape', 'window.SDK || (SDK = {}); SDK.o = { XHR: window.XMLHttpRequest }; SDK.o.XHR.prototype.open = w', 'XMLHttpRequest.prototype.open'],
      ['a member write read as a free name', 'window.__cfg = { h: history }; __cfg.h.pushState = w', 'history.pushState'],
      ['a free name read as a member', 'cfg = { h: history }; self.cfg.h.pushState = w', 'history.pushState'],
      ['a top-level var read through globalThis', 'var cfg = { h: history }; globalThis.cfg.h.pushState = w', 'history.pushState'],
      ["top-level this", 'this.cfg = { h: history }; cfg.h.pushState = w', 'history.pushState'],
    ])('%s', async (_, code, target) => {
      const { report } = await scan(code)

      expect(names(report)).toEqual([target])
    })

    test("a module's top-level declaration doesn't touch the cell", async () => {
      const { report } = await scanBuild(
        { 'index.html': '<script type="module" src="main.js"></script>', 'main.js': 'var cfg = { h: history }; globalThis.cfg.h.pushState = w' },
        [],
        { deps: { resolver } },
      )

      expect(names(report)).toEqual([])
    })
  })

  describe("an argument carries the values its object's heap fields hold, at any depth", () => {
    const scanMapped = (files: [string, string][]) => scanBuild(mapped(files), [], { deps: { resolver } })
    const installPatch =
      'function installPatch(spec) { const o = spec.target[spec.method]; spec.target[spec.method] = function () { return o.apply(this, arguments) } }'

    test("installPatch({ target, method: 'send' }) keys the calling package, looked up at the 'send' literal with its token", async () => {
      const call = "installPatch({ target: XMLHttpRequest.prototype, method: 'send' })"
      const { report } = await scanMapped([
        [patchKit, installPatch],
        [sdk, call],
      ])

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.send'])
      expect(keyOf(report.findings[0])).toBe('pkg:@acme/sdk')
      const [occurrence] = report.findings[0].occurrences
      // The reported position stays the helper's write, and attribution looks up the literal that supplies the member.
      expect(occurrence.generated).toMatchObject({ line: 1 })
      expect(occurrence.original).toMatchObject({ source: sdk, line: 1, column: call.indexOf("'send'") })
      expect(occurrence.trace.at(-1)).toMatchObject({ kind: 'token-check', result: 'passed', token: 'send' })
      expect(report.findings[0].confidence.attribution.level).toBe('high')
    })

    test('at any depth', async () => {
      const call = "installPatch({ spec: { target: XMLHttpRequest.prototype, method: 'send' } })"
      const { report } = await scanMapped([
        [patchKit, 'function installPatch(o) { const spec = o.spec; spec.target[spec.method] = w }'],
        [sdk, call],
      ])

      expect(report.findings.map(keyOf)).toEqual(['pkg:@acme/sdk'])
      expect(report.findings[0].occurrences[0].original).toMatchObject({ source: sdk, column: call.indexOf("'send'") })
    })

    test('when the key is not written in the call, the lookup falls back to the call start with no token', async () => {
      const call = 'installPatch(s)'
      const { report } = await scanMapped([
        [patchKit, installPatch],
        [sdk, `const s = { target: XMLHttpRequest.prototype, method: 'send' }; ${call}`],
      ])

      expect(report.findings.map(keyOf)).toEqual(['pkg:@acme/sdk'])
      const [occurrence] = report.findings[0].occurrences
      expect(occurrence.original).toMatchObject({ source: sdk, column: 64 })
      expect(report.findings[0].confidence.attribution.reasons).toEqual(['token-check-n/a'])
    })

    test('when patch-kit loops over a list @acme/sdk exports, no call carries both, and the helper write is looked up', async () => {
      const { report } = await scanMapped([
        [sdk, "var TARGETS = [{ target: XMLHttpRequest.prototype, method: 'send' }]"],
        [patchKit, 'for (const spec of TARGETS) { const o = spec.target[spec.method]; spec.target[spec.method] = function () { return o.apply(this, arguments) } }'],
      ])

      expect(names(report)).toEqual(['XMLHttpRequest.prototype.send'])
      expect(keyOf(report.findings[0])).toBe('pkg:patch-kit')
    })
  })

  describe('descriptors are heap objects', () => {
    /** Each finding's target, effect, locks and mutation-confidence reasons. */
    const defines = (report: { findings: Finding[] }) =>
      report.findings.map((finding) => ({
        name: finding.target.name,
        effect: finding.effect,
        locks: finding.locks,
        reasons: finding.confidence.mutation.reasons ?? [],
      }))

    test.each([
      ['a data descriptor', 'const d = { value: w }', 'replace'],
      ['an accessor descriptor', 'const d = { get: function () { return w } }', 'descriptor-change'],
      ['a descriptor that changes nothing', 'const d = { configurable: true }', undefined],
    ])('%s built in a variable, then passed to defineProperty, decides the effect', async (_, built, effect) => {
      const { report } = await scan(`${built}; Object.defineProperty(window, 'fetch', d)`)

      expect(defines(report)).toEqual(effect === undefined ? [] : [{ name: 'Window.fetch', effect, locks: false, reasons: [] }])
    })

    test('a field written after allocation may be absent: the define is a replace with outcome-undecidable, and locks comes from the fields shown', async () => {
      const { report } = await scan("const d = { configurable: true }; d.value = w; Object.defineProperty(window, 'fetch', d)")

      expect(defines(report)).toEqual([{ name: 'Window.fetch', effect: 'replace', locks: false, reasons: ['outcome-undecidable'] }])
      const step = report.findings[0].occurrences[0].trace.find((each: Finding) => each.kind === 'confidence-reason')
      // The evidence is the write that may not have run.
      expect(step).toMatchObject({ reason: 'outcome-undecidable', sites: [{ line: 1, column: 34 }] })
    })

    test('a field written many times after allocation is present with any one of its writes, or absent', async () => {
      const writes = Array.from({ length: 7 }, (_, index) => `d.value = w${index}`).join('; ')
      const { report } = await scan(`const d = { configurable: true }; ${writes}; Object.defineProperty(window, 'fetch', d)`)

      expect(defines(report)).toEqual([{ name: 'Window.fetch', effect: 'replace', locks: false, reasons: ['outcome-undecidable'] }])
      expect(report.completeness.limitations).toEqual([])
    })

    test('past the descriptor-alternatives cap, maybe-absent fields are read as unseen, and analysis-budget is raised (Principle 5)', async () => {
      const writes = [
        ...['w1', 'w2', 'w3'].map((value) => `d.value = ${value}`),
        ...['writable', 'enumerable'].flatMap((field) => ['true', 'false', 'true'].map((value) => `d.${field} = ${value}`)),
        'd.configurable = true',
      ].join('; ')
      const { report } = await scan(`const d = {}; ${writes}; Object.defineProperty(window, 'fetch', d)`)

      expect(defines(report)).toEqual([
        { name: 'Window.fetch', effect: 'descriptor-change', locks: 'unknown', reasons: ['outcome-undecidable'] },
      ])
      expect(report.completeness.limitations.map((limitation: Finding) => limitation.kind)).toEqual(['analysis-budget'])
      expect(report.completeness.counters.statistics.caps).toMatchObject({ descriptors: 1 })
    })

    test.each([
      ['a variable reassigned on one branch', "let d = { value: w }; if (lazy) d = { get: () => w }; Object.defineProperty(window, 'fetch', d)"],
      ['a ?: between two literals', "Object.defineProperty(window, 'fetch', c ? { value: w } : { get: g })"],
    ])('a descriptor that is several heap objects with different effects gives one finding per effect: %s', async (_, code) => {
      const { report } = await scan(code)

      expect(defines(report)).toEqual([
        { name: 'Window.fetch', effect: 'descriptor-change', locks: false, reasons: ['outcome-undecidable'] },
        { name: 'Window.fetch', effect: 'replace', locks: false, reasons: ['outcome-undecidable'] },
      ])
    })

    describe('a descriptor that is several heap objects, some of which cannot change the target (§3 Ineffective writes)', () => {
      /** Each ineffective record as `target|reason`, with its occurrences as `effect mechanism throws mayChangeNothing`. */
      const records = (report: Finding) =>
        report.ineffectiveWrites.map((record: Finding) => [
          `${record.target.name}|${record.reason}`,
          record.occurrences.map((occurrence: Finding) => {
            const outcome = occurrence.trace.find((step: Finding) => step.kind === 'outcome')
            return `${occurrence.effect} ${occurrence.mechanism} ${occurrence.throws} ${outcome.mayChangeNothing}`
          }),
        ])

      test('a fresh value on a non-configurable member is ineffective, and a field that may be absent may also change nothing', async () => {
        const { report } = await scan("const d = {}; d.value = function () {}; Object.defineProperty(Math, 'PI', d)")

        expect(report.findings).toEqual([])
        expect(records(report)).toEqual([['Math.PI|non-configurable', ['replace define-property always true']]])
      })

      test('a fresh value a heap field holds is plainly ineffective on a non-configurable member', async () => {
        const { report } = await scan("const d = { value: function () {} }; Object.defineProperty(Math, 'PI', d)")

        expect(report.findings).toEqual([])
        expect(records(report)).toEqual([['Math.PI|non-configurable', ['replace define-property always false']]])
      })

      test('heap objects that are all ineffective with different intended effects give one occurrence per effect, in the order of the objects', async () => {
        const { report } = await scan("Object.defineProperty(Math, 'PI', c ? { value: function () {} } : { get: g })")

        expect(report.findings).toEqual([])
        expect(records(report)).toEqual([
          ['Math.PI|non-configurable', ['replace define-property always false', 'descriptor-change define-property always false']],
        ])
      })

      test('when one heap object can change the target, the write is a finding with outcome-undecidable and no ineffective record', async () => {
        const { report } = await scan(
          "let d = { get: g }; if (c) d = Object.getOwnPropertyDescriptor(Array.prototype, 'length'); Object.defineProperty(Array.prototype, 'length', d)",
        )

        expect(defines(report)).toEqual([
          { name: 'Array.prototype.length', effect: 'descriptor-change', locks: 'unknown', reasons: ['outcome-undecidable'] },
        ])
        expect(report.ineffectiveWrites).toEqual([])
      })

      test.each([
        ['every heap object is ineffective on every candidate', 'PI', []],
        ['a heap object can change a candidate', 'fetch', ['Window.fetch']],
      ])('on an object the analyzer cannot resolve, a target is a candidate only when a heap object can change it: %s', async (_, member, candidates) => {
        const { report } = await scan(`Object.defineProperty(o, '${member}', c ? { get: function () { return w } } : { value: function () {} })`)

        const holders = report.completeness.limitations.filter((record: Finding) => record.kind === 'unresolved-holder')
        expect(holders.map((record: Finding) => candidates.filter((name) => record.detail.includes(name)))).toEqual(
          candidates.length === 0 ? [] : [candidates],
        )
      })
    })

    test('an object passed to a call the analyzer cannot resolve keeps only the field writes it sees', async () => {
      const { report } = await scan("const d = { value: w, configurable: true }; track(d); Object.defineProperty(window, 'fetch', d)")

      expect(defines(report)).toEqual([{ name: 'Window.fetch', effect: 'replace', locks: false, reasons: [] }])
      expect(report.findings[0].confidence.mutation.level).toBe('high')
    })

    describe('a spread or Object.assign copy of a heap object copies its seen fields', () => {
      test.each([
        ['a spread', "const base = { value: w }; Object.defineProperty(window, 'fetch', { configurable: true, ...base })"],
        ['Object.assign', "const base = { configurable: true }; Object.defineProperty(window, 'fetch', Object.assign({}, base, { value: w }))"],
      ])('%s gives a replace with locks false and no outcome-undecidable', async (_, code) => {
        const { report } = await scan(code)

        expect(defines(report)).toEqual([{ name: 'Window.fetch', effect: 'replace', locks: false, reasons: [] }])
      })

      test('a copy that changes nothing gives no finding', async () => {
        const { report } = await scan("const base = { configurable: true }; Object.defineProperty(window, 'fetch', { ...base })")

        expect(defines(report)).toEqual([])
      })

      test('a maybe-absent field stays maybe-absent through the copy', async () => {
        const { report } = await scan("const base = {}; base.value = w; Object.defineProperty(window, 'fetch', { configurable: true, ...base })")

        expect(defines(report)).toEqual([{ name: 'Window.fetch', effect: 'replace', locks: false, reasons: ['outcome-undecidable'] }])
      })

      test('a spread of a value the heap does not hold stays unseen', async () => {
        const { report } = await scan("Object.defineProperty(window, 'fetch', { configurable: true, ...opts })")

        expect(defines(report)).toEqual([{ name: 'Window.fetch', effect: 'descriptor-change', locks: 'unknown', reasons: ['outcome-undecidable'] }])
      })
    })

    describe("an object a native returns has unseen base fields plus the field writes the analyzer sees", () => {
      test('a gOPD descriptor with a new value is a replace with outcome-undecidable and locks unknown, sharing its fingerprint', async () => {
        const { report } = await scan(
          lines(
            "const d = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'send'); d.value = w; Object.defineProperty(XMLHttpRequest.prototype, 'send', d)",
            "const desc = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'send'); Object.defineProperty(XMLHttpRequest.prototype, 'send', { ...desc, value: w })",
            'XMLHttpRequest.prototype.send = w',
          ),
        )

        expect(fingerprints(report)).toEqual([send])
        expect(report.findings[0].locks).toBe('unknown')
        expect(report.findings[0].occurrences.map((occurrence: Finding) => occurrence.confidence.mutation.reasons ?? [])).toEqual([
          ['outcome-undecidable'],
          ['outcome-undecidable'],
          [],
        ])
      })

      test('unseen parts never disappear: delete d.value; d.get = g is a descriptor-change with outcome-undecidable', async () => {
        const { report } = await scan(
          "const d = Object.getOwnPropertyDescriptor(XMLHttpRequest.prototype, 'send'); delete d.value; d.get = g; Object.defineProperty(XMLHttpRequest.prototype, 'send', d)",
        )

        expect(defines(report)).toEqual([
          { name: 'XMLHttpRequest.prototype.send', effect: 'descriptor-change', locks: 'unknown', reasons: ['outcome-undecidable'] },
        ])
      })

      test('Object.create(null) is treated like {}', async () => {
        const { report } = await scan("const d = Object.create(null); d.value = w; d.configurable = true; Object.defineProperty(window, 'fetch', d)")

        expect(defines(report)).toEqual([{ name: 'Window.fetch', effect: 'replace', locks: false, reasons: ['outcome-undecidable'] }])
      })
    })
  })
})

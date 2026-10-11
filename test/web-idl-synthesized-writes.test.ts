// Writes to the members the Web IDL binding synthesizes (§3, §4 Sources and Targets and holders): they are
// catalog targets, so a write to one gets its catalogued effect, where it used to read as an `add` of a non-native key.
// Every scenario goes through `monkeypatchlist scan --json`, with both binding resolvers behind the seam.

import { describe, expect, test } from 'vitest'
import { createJsResolver } from '../src/packages/analysis/binding.ts'
import { jsResolver, type Resolver } from '../src/packages/analysis/index.ts'
import { scanBuild } from './support/fixture-build.ts'
import { typescriptEslintBindings } from './support/typescript-eslint-bindings.ts'

const resolvers: [string, Resolver][] = [
  ['eslint-scope', jsResolver],
  ['@typescript-eslint/scope-manager', createJsResolver(typescriptEslintBindings)],
]

const classic = (code: string) => ({ 'index.html': '<script src="main.js"></script>', 'main.js': code })
const lines = (...code: string[]) => code.join(';\n')

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read report fields freely
type Report = any

/** Each finding as `target effect`, in report order. */
const findings = (report: Report): string[] =>
  report.findings.map(({ target, effect }: { target: { name: string }; effect: string }) => `${target.name} ${effect}`)

describe.each(resolvers)('writes to members Web IDL synthesizes, with %s behind the seam', (_, resolver) => {
  const scan = async (code: string) => (await scanBuild(classic(code), [], { deps: { resolver } })).report

  test('a symbol-keyed write to a synthesized member gets its catalogued effect, not the interim add', async () => {
    const report = await scan(
      lines(
        'NodeList.prototype[Symbol.iterator] = f',
        'HTMLCollection.prototype[Symbol.iterator] = Array.prototype[Symbol.iterator]',
        'Headers.prototype[Symbol.iterator] = g',
        'ReadableStream.prototype[Symbol.asyncIterator] = h',
      ),
    )

    expect(findings(report)).toEqual([
      'HTMLCollection.prototype.@@iterator replace',
      'Headers.prototype.@@iterator replace',
      'NodeList.prototype.@@iterator replace',
      'ReadableStream.prototype.@@asyncIterator replace',
    ])
  })

  test('stringifiers, iteration methods and maplike and setlike members are replaced; a readonly maplike has no set', async () => {
    const report = await scan(
      lines(
        'URL.prototype.toString = a',
        'Headers.prototype.entries = b',
        'RTCStatsReport.prototype.get = c',
        'RTCStatsReport.prototype.set = d',
        'FontFaceSet.prototype.add = e',
        'delete FontFaceSet.prototype.clear',
      ),
    )

    expect(findings(report)).toEqual([
      'FontFaceSet.prototype.add replace',
      'FontFaceSet.prototype.clear delete',
      'Headers.prototype.entries replace',
      'RTCStatsReport.prototype.get replace',
      'RTCStatsReport.prototype.set add',
      'URL.prototype.toString replace',
    ])
  })

  test("'own value' is a read of the same slot: members Web IDL makes the same function are replaced", async () => {
    const report = await scan(
      lines(
        // rrweb
        'NodeList.prototype.forEach = Array.prototype.forEach',
        'DOMTokenList.prototype.forEach = Array.prototype.forEach',
        'window.URL = window.URL || window.webkitURL',
        // A write-back of the same slot changes nothing.
        'NodeList.prototype.forEach = NodeList.prototype.forEach',
      ),
    )

    expect(findings(report)).toEqual([
      'DOMTokenList.prototype.forEach replace',
      'NodeList.prototype.forEach replace',
      'Window.URL replace',
    ])
  })

  test('structural properties follow their descriptors; length and name are not targets', async () => {
    const report = await scan(
      lines(
        'Node.prototype.constructor = C',
        'delete Node.prototype[Symbol.toStringTag]',
        'Object.defineProperty(Element.prototype, Symbol.unscopables, { value: {} })',
        // Non-writable: an ineffective [[Set]], which gives nothing.
        'Node.prototype = P',
        'XMLHttpRequest.prototype[Symbol.toStringTag] = "x"',
        // Not targets, and never adds.
        'Node.length = 1',
        'Node.name = "n"',
        'Node.prototype.appendChild.name = "a"',
      ),
    )

    expect(findings(report)).toEqual([
      'Element.prototype.@@unscopables replace',
      'Node.prototype.@@toStringTag delete',
      'Node.prototype.constructor replace',
    ])
  })

  test('[LegacyWindowAlias] names are global targets holding the same interface object', async () => {
    const report = await scan(lines('window.webkitURL = X', 'webkitURL.createObjectURL = f', 'webkitURL.prototype.foo = g'))

    expect(findings(report)).toEqual(['URL.createObjectURL replace', 'URL.prototype.foo add', 'Window.webkitURL replace'])
  })

  test('Image, Audio and Option are their own constructor holders, whose prototype is the element prototype', async () => {
    const report = await scan(
      lines(
        'Image.prototype.decode = w',
        "Object.defineProperty(Image.prototype, 'src', { set(v) {} })",
        'Image.foo = 1',
        'Object.setPrototypeOf(Image, P)',
        'Image.length = 1',
        'Image.name = "i"',
        'Audio.prototype.play = p',
        'Option.prototype.foo = 2',
        'window.Image = I',
      ),
    )

    expect(findings(report)).toEqual([
      'HTMLAudioElement.prototype.play replace',
      'HTMLImageElement.prototype.decode replace',
      'HTMLImageElement.prototype.src descriptor-change',
      'HTMLOptionElement.prototype.foo add',
      'Image.[[Prototype]] prototype-change',
      'Image.foo add',
      'Window.Image replace',
    ])
  })
  test("a write on the global or a prototype of a synthesized member it inherits is a shadowing write", async () => {
    const report = await scan(
      lines(
        'window.constructor = f',
        'HTMLOptionsCollection.prototype[Symbol.iterator] = g',
        "Reflect.set(o, 'constructor', h, window)",
      ),
    )

    expect(
      report.findings.map(({ target, effect }: { target: { name: string; shadows?: string }; effect: string }) => [
        target.name,
        target.shadows,
        effect,
      ]),
    ).toEqual([
      ['HTMLOptionsCollection.prototype.@@iterator', 'HTMLCollection.prototype.@@iterator', 'replace'],
      ['Window.constructor', 'Window.prototype.constructor', 'replace'],
    ])
    expect(report.findings[1].occurrences).toHaveLength(2)
  })
  test("core-js's web.dom-collections.iterator writes give a replace on every collection the catalog has", async () => {
    // core-js's DOMIterables. Its loop (`for (var NAME in DOMIterables) handlePrototype(global[NAME] && …)`) reaches
    // these through a for-in and a function call, which the resolver can't follow yet, so the writes
    // are unrolled here. CSSValueList, ClientRectList, PaintRequestList and SVGPathSegList no longer ship, so core-js
    // skips them, and the catalog has no holder for them.
    const collections = (
      'CSSRuleList CSSStyleDeclaration DOMRectList DOMStringList DOMTokenList DataTransferItemList FileList ' +
      'HTMLAllCollection HTMLCollection HTMLFormElement HTMLSelectElement MediaList MimeTypeArray NamedNodeMap NodeList ' +
      'Plugin PluginArray SVGLengthList SVGNumberList SVGPointList SVGStringList SVGTransformList SourceBufferList ' +
      'StyleSheetList TextTrackCueList TextTrackList TouchList'
    ).split(' ')
    const report = await scan(
      collections
        .map(
          (name) =>
            `Object.defineProperty(${name}.prototype, Symbol.iterator, { value: Array.prototype.values, writable: true, configurable: true })`,
        )
        .join(';\n'),
    )

    expect(findings(report)).toEqual(collections.map((name) => `${name}.prototype.@@iterator replace`).sort())
  })
})


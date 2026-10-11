import { readFileSync } from 'node:fs'
import { Ajv2020 } from 'ajv/dist/2020.js'
import { describe, expect, test } from 'vitest'
import { realms, surfaces } from '../src/index.ts'
import {
  codeCallees,
  effects,
  globalForms,
  limitationKinds,
  mechanisms,
  traceStepKinds,
} from '../src/packages/analysis/index.ts'
import { attributionReasons, levels, mutationReasons, targetReasons } from '../src/packages/confidence/index.ts'

const schema = JSON.parse(readFileSync('schema/report.schema.json', 'utf8'))
const { $defs } = schema

describe('the report JSON Schema (§15)', () => {
  test('pins reportVersion 1', () => {
    expect(schema.properties.reportVersion).toEqual({ const: 1 })
  })

  test('encodes the closed lists the spec fixes, as the runtime does', () => {
    // §14: trace step kinds; §8: effects; §3: mechanisms; §4: realms; §12: surfaces.
    expect($defs.traceStep.properties.kind.enum).toEqual([...traceStepKinds])
    expect(traceStepKinds).toHaveLength(16)
    expect($defs.finding.properties.effect.enum).toEqual([...effects])
    expect($defs.occurrence.properties.mechanism.enum).toEqual([...mechanisms])
    expect($defs.realm.enum).toEqual([...realms])
    expect($defs.finding.properties.surface.enum).toEqual([...surfaces])
    // §9: confidence levels and each dimension's reasons.
    expect($defs.dimension.properties.level.enum).toEqual([...levels])
    const reasons = (dimension: string) => $defs.confidence.properties[dimension].properties.reasons.items.enum
    expect(reasons('target')).toEqual(Object.keys(targetReasons))
    expect(reasons('mutation')).toEqual(Object.keys(mutationReasons))
    expect(reasons('attribution')).toEqual(Object.keys(attributionReasons))
    // §13: limitation kinds and completeness levels.
    expect($defs.limitation.properties.kind.enum).toEqual([...limitationKinds])
    expect(limitationKinds).toHaveLength(13)
    expect(schema.properties.completeness.properties.level.enum).toEqual([
      'complete',
      'complete-with-limitations',
      'incomplete',
    ])
  })

  test('a confidence dimension is high with no reasons, and below high with one or more of its own (§9)', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/confidence' })
    const high = { level: 'high', reasons: [] }
    const confidence = { target: high, mutation: high, attribution: { level: 'low', reasons: ['no-map'] } }

    expect(validate(confidence)).toBe(true)
    expect(validate({ ...confidence, target: { level: 'high', reasons: ['with-scope'] } })).toBe(false)
    expect(validate({ ...confidence, target: { level: 'low', reasons: [] } })).toBe(false)
    expect(validate({ ...confidence, target: { level: 'low', reasons: ['no-map'] } })).toBe(false)
    expect(validate({ ...confidence, target: { level: 'low', reasons: ['with-scope', 'with-scope'] } })).toBe(false)
    expect(validate({ ...confidence, target: { ...high, note: 'x' } })).toBe(false)
  })

  test('a trace step carries the fields of its kind and no others (§14)', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const binding = {
      kind: 'binding',
      name: 'window',
      resolution: 'alias',
      form: 'global-name',
      aliasOf: 'Window',
      realm: 'window',
      realmInstance: 'current',
      text: 't',
    }

    expect(validate(binding)).toBe(true)
    expect(validate({ ...binding, holder: 'Window' })).toBe(false)
    expect(validate({ kind: 'note', text: 't', name: 'window' })).toBe(false)
  })

  test('a confidence-reason step names its dimension, a reason of that dimension, its level and its evidence', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const step = {
      kind: 'confidence-reason',
      dimension: 'target',
      reason: 'with-scope',
      level: 'low',
      name: 'fetch',
      sites: [{ start: 0, end: 22, line: 1, column: 0 }],
      text: 't',
    }

    expect(validate(step)).toBe(true)
    expect(validate({ ...step, dimension: 'mutation' })).toBe(false)
    expect(validate({ ...step, reason: 'no-map' })).toBe(false)
    expect(validate({ ...step, level: 'high' })).toBe(false)
    expect(validate({ ...step, aliasOf: 'Window' })).toBe(false)
  })

  test('a note step names what it is about; a nested-code note, the native that compiles the code and its call (§2)', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const call = { start: 0, end: 30, line: 1, column: 0 }
    const note = { kind: 'note', about: 'nested-code', callee: 'eval', scope: 'caller', call, text: 't' }

    // `script` is an injected script element's literal text.
    expect($defs.traceStep.allOf[2].then.properties.callee.enum).toEqual([...codeCallees, 'script'])
    expect(validate(note)).toBe(true)
    expect(validate({ ...note, callee: 'Function', scope: 'global' })).toBe(true)
    expect(validate({ ...note, callee: 'setImmediate' })).toBe(false)
    expect(validate({ ...note, scope: 'module' })).toBe(false)
    expect(validate({ kind: 'note', about: 'nested-code', text: 't' })).toBe(false)
    expect(validate({ kind: 'note', text: 't' })).toBe(false)
    expect(validate({ ...note, about: 'other' })).toBe(false)
    expect(validate({ ...note, name: 'eval' })).toBe(false)
  })

  test('a lexical-collision note names the bare name, the declaring artifact and the declaration there (§3)', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const generated = { start: 4, end: 9, line: 1, column: 4 }
    const note = {
      kind: 'note',
      about: 'lexical-collision',
      name: 'fetch',
      declaration: 'const',
      artifact: 'https://app.example/a.js',
      generated,
      text: 't',
    }

    expect(validate(note)).toBe(true)
    expect(validate({ ...note, declaration: 'class' })).toBe(true)
    expect(validate({ ...note, declaration: 'var' })).toBe(false)
    expect(validate({ ...note, artifact: undefined })).toBe(false)
    expect(validate({ kind: 'note', about: 'nested-code', name: 'fetch', text: 't' })).toBe(false)
  })

  test('a fold step records the expression folded, where it is, and the constant; a name when it reads a const', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const generated = { start: 15, end: 38, line: 1, column: 15 }
    const fold = { kind: 'fold', expression: '"add" + "EventListener"', generated, value: 'addEventListener', text: 't' }

    expect(validate(fold)).toBe(true)
    expect(validate({ ...fold, name: 'method' })).toBe(true)
    for (const value of [0, false, null]) expect(validate({ ...fold, value })).toBe(true)
    expect(validate({ ...fold, value: {} })).toBe(false)
    for (const field of ['value', 'expression', 'generated']) {
      expect(validate(Object.fromEntries(Object.entries(fold).filter(([key]) => key !== field)))).toBe(false)
    }
    expect(validate({ ...fold, about: 'nested-code' })).toBe(false)
  })

  test('an alias step records the variable, its definition and where the definition is', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const generated = { start: 4, end: 32, line: 1, column: 4 }
    const alias = { kind: 'alias', name: 'p', expression: 'p = XMLHttpRequest.prototype', generated, text: 't' }

    expect(validate(alias)).toBe(true)
    for (const field of ['name', 'expression', 'generated']) {
      expect(validate(Object.fromEntries(Object.entries(alias).filter(([key]) => key !== field)))).toBe(false)
    }
    expect(validate({ ...alias, value: 'x' })).toBe(false)
  })

  test('a call step records the callee, the call site, the function and the argument bindings', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const generated = { start: 40, end: 62, line: 2, column: 0 }
    const fn = { start: 0, end: 39, line: 1, column: 0 }
    const bindings = [
      { parameter: 'obj', argument: 'window' },
      { parameter: 'fn', argument: null },
    ]
    const call = { kind: 'call', callee: 'patch', generated, function: fn, bindings, text: 't' }

    expect(validate(call)).toBe(true)
    for (const field of ['callee', 'generated', 'function', 'bindings']) {
      expect(validate(Object.fromEntries(Object.entries(call).filter(([key]) => key !== field)))).toBe(false)
    }
    expect(validate({ ...call, bindings: [{ parameter: 'obj' }] })).toBe(false)
    expect(validate({ ...call, name: 'x' })).toBe(false)
  })

  test('a catalog-holder step records the expression, where it is, the holder whose prototype it is and that prototype', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const generated = { start: 0, end: 30, line: 1, column: 0 }
    const step = {
      kind: 'catalog-holder',
      expression: 'Object.getPrototypeOf(console)',
      generated,
      prototypeOf: 'console',
      holder: 'console.[[Prototype]]',
      text: 't',
    }

    expect(validate(step)).toBe(true)
    for (const field of ['expression', 'generated', 'prototypeOf', 'holder']) {
      expect(validate(Object.fromEntries(Object.entries(step).filter(([key]) => key !== field))), field).toBe(false)
    }
    expect(validate({ ...step, value: 'x' })).toBe(false)
  })

  test('a catalog-holder step for an own-property test or a prototype walk carries its own fields and no others (§4)', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const generated = { start: 0, end: 30, line: 1, column: 0 }
    const test = { kind: 'catalog-holder', expression: 'Object.hasOwn(history, m)', generated, tested: 'history', member: 'pushState', owns: false, text: 't' }
    const walk = {
      kind: 'catalog-holder',
      expression: 'for (; o && !Object.hasOwn(o, t); ) o = f(o)',
      generated,
      walk: ['XMLHttpRequest.prototype', 'XMLHttpRequestEventTarget.prototype', 'EventTarget.prototype'],
      member: 'addEventListener',
      holder: 'EventTarget.prototype',
      text: 't',
    }
    const without = (step: object, field: string) => Object.fromEntries(Object.entries(step).filter(([key]) => key !== field))

    expect(validate(test)).toBe(true)
    expect(validate(without(test, 'member'))).toBe(true)
    expect(validate(walk)).toBe(true)
    expect(validate(without(walk, 'member'))).toBe(true)
    for (const field of ['tested', 'owns']) expect(validate(without(test, field)), field).toBe(false)
    for (const field of ['walk', 'holder']) expect(validate(without(walk, field)), field).toBe(false)
    expect(validate({ ...test, holder: 'History.prototype' })).toBe(false)
    expect(validate({ ...walk, owns: true })).toBe(false)
    expect(validate({ ...walk, prototypeOf: 'Window' })).toBe(false)
    expect(validate({ ...walk, walk: [] })).toBe(false)
  })

  test('a fold to a well-known symbol records the symbol, spelt as a catalog member, in place of a value', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const generated = { start: 16, end: 31, line: 1, column: 16 }
    const fold = { kind: 'fold', expression: 'Symbol.iterator', generated, symbol: '@@iterator', text: 't' }

    expect(validate(fold)).toBe(true)
    expect(validate({ ...fold, name: 'it' })).toBe(true)
    expect(validate({ ...fold, symbol: 'iterator' })).toBe(false)
    expect(validate({ ...fold, value: '@@iterator' })).toBe(false)
    expect(validate({ kind: 'fold', expression: 'x', generated, text: 't' })).toBe(false)
  })

  test('a binding step carries aliasOf for an alias, and its declaration exactly when it resolved to one', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const step = { kind: 'binding', name: 'fetch', form: 'global-property', realm: 'window', realmInstance: 'current', text: 't' }
    const declaration = { kind: 'var', generated: { start: 0, end: 10, line: 1, column: 0 } }

    expect(validate({ ...step, resolution: 'global' })).toBe(true)
    expect(validate({ ...step, resolution: 'global', aliasOf: 'Window' })).toBe(false)
    expect(validate({ ...step, resolution: 'global', declaration })).toBe(false)
    expect(validate({ ...step, resolution: 'alias' })).toBe(false)
    expect(validate({ ...step, resolution: 'declaration', declaration })).toBe(true)
    expect(validate({ ...step, resolution: 'declaration', form: 'global-name', aliasOf: 'Window', declaration })).toBe(true)
    expect(validate({ ...step, resolution: 'declaration' })).toBe(false)
    expect(validate({ ...step, resolution: 'declaration', declaration: { ...declaration, kind: 'using' } })).toBe(false)
    expect(validate({ ...step, resolution: 'declaration', declaration: { ...declaration, kind: 'let' } })).toBe(true)
  })

  test('a binding step records the form the global object was recognized in (§5 Global resolution)', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const step = { kind: 'binding', realm: 'window', realmInstance: 'current', text: 't' }
    const alias = { ...step, name: 'window', resolution: 'alias', aliasOf: 'Window' }
    const chain = { start: 0, end: 40, line: 1, column: 0 }

    expect($defs.traceStep.allOf[0].then.properties.form.enum).toEqual([...globalForms])
    expect(validate({ ...alias, form: 'global-name', chain })).toBe(true)
    expect(validate(alias)).toBe(false)
    expect(validate({ ...alias, form: 'global-property' })).toBe(false)
    expect(validate({ ...alias, form: 'global-name', chain: { line: 1 } })).toBe(false)
    expect(validate({ ...alias, name: 'this', form: 'top-level-this' })).toBe(true)
    expect(validate({ ...alias, name: 'global', form: 'guarded-global' })).toBe(true)
    expect(validate({ ...alias, name: 'Function', form: 'function-return-this' })).toBe(true)
    expect(validate({ ...alias, name: 'global', form: 'global-name', holds: 'Window' })).toBe(false)
    // A bare constructor is a global property whose value is a native holder.
    const property = { ...step, name: 'XMLHttpRequest', resolution: 'global', form: 'global-property' }
    expect(validate({ ...property, holds: 'XMLHttpRequest' })).toBe(true)
    expect(validate({ ...property, form: 'top-level-this' })).toBe(false)
    expect(validate({ ...property, form: 'guarded-global', aliasOf: 'Window' })).toBe(false)
  })

  test('a binding step for another window or a singleton records its realm instance, and a singleton its access path', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/traceStep' })
    const window = { kind: 'binding', name: 'parent', resolution: 'alias', form: 'other-window', aliasOf: 'Window', text: 't' }
    const singleton = { ...window, name: 'location', form: 'singleton', path: 'document.location', aliasOf: 'location' }

    for (const realmInstance of ['current', 'other', 'unknown']) {
      expect(validate({ ...window, realm: 'window', realmInstance })).toBe(true)
      expect(validate({ ...singleton, realm: 'window', realmInstance })).toBe(true)
    }
    const other = { realm: 'window', realmInstance: 'other' }
    expect(validate({ ...window, ...other, realmInstance: 'parent' })).toBe(false)
    expect(validate({ ...window, ...other, aliasOf: undefined })).toBe(false)
    expect(validate({ ...window, ...other, path: 'parent' })).toBe(false)
    expect(validate({ ...singleton, ...other, path: undefined })).toBe(false)
    expect(validate({ ...singleton, ...other, resolution: 'global' })).toBe(false)
    expect(validate({ ...singleton, ...other, holds: 'location' })).toBe(false)
  })

  test('an occurrence records its realm instance (§8)', () => {
    const validate = new Ajv2020({ strict: true }).compile({ $schema: schema.$schema, $defs, $ref: '#/$defs/occurrence' })
    const high = { level: 'high', reasons: [] }
    const occurrence = {
      artifact: { url: 'https://app.example/main.js', hash: 'sha256:0', origin: 'local-build' },
      generated: { start: 0, end: 16, line: 1, column: 0 },
      original: null,
      mechanism: 'assign',
      reachability: 'unconditional',
      reachabilityBasis: 'call-path',
      installContext: 'load',
      installEntry: null,
      realmInstance: 'other',
      evidence: {},
      confidence: { target: high, mutation: high, attribution: high },
      trace: [],
    }

    expect(validate(occurrence)).toBe(true)
    expect(validate({ ...occurrence, realmInstance: 'iframe' })).toBe(false)
    expect(validate({ ...occurrence, realmInstance: undefined })).toBe(false)
    expect(validate({ ...occurrence, reachabilityBasis: 'creation-site' })).toBe(true)
    expect(validate({ ...occurrence, reachabilityBasis: 'caller' })).toBe(false)
    expect(validate({ ...occurrence, installContext: 'deferred', installEntry: 'init' })).toBe(true)
    expect(validate({ ...occurrence, installContext: 'later' })).toBe(false)
    expect(validate({ ...occurrence, installEntry: undefined })).toBe(false)
  })
})

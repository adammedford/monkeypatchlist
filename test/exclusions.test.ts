import { describe, expect, test } from 'vitest'
import { generate } from '../tools/catalog-generator/generate.ts'

const upstream = { '@webref/idl': '1.0.0', webidl2: '24.5.0' }

/** The global interfaces of the four realms. */
const globals = `
  [Global=Window, Exposed=Window] interface Window {};
  [Global=(Worker,DedicatedWorker), Exposed=DedicatedWorker] interface DedicatedWorkerGlobalScope {};
  [Global=(Worker,SharedWorker), Exposed=SharedWorker] interface SharedWorkerGlobalScope {};
  [Global=(Worker,ServiceWorker), Exposed=ServiceWorker] interface ServiceWorkerGlobalScope {};`

const testutils = '[Exposed=(Window,Worker)] namespace TestUtils { Promise<undefined> gc(); };'

function catalogOf(idl: Record<string, string>, exclusions: Record<string, string>) {
  return JSON.parse(generate({ idl: { globals, ...idl }, exclusions, upstream }).catalog)
}

describe('exclusions', () => {
  test('an excluded namespace, its members and the global property that holds it are absent, and listed as excluded', () => {
    const catalog = catalogOf({ testutils }, { TestUtils: 'Exists only in test harnesses.' })

    for (const realm of ['window', 'dedicated-worker', 'shared-worker', 'service-worker']) {
      expect(Object.keys(catalog.targets[realm]).filter((name) => name.includes('TestUtils')), realm).toEqual([])
      expect(catalog.holders[realm], realm).not.toHaveProperty('TestUtils')
    }
    expect(catalog.exclusions).toEqual({
      TestUtils: {
        reason: 'Exists only in test harnesses.',
        targets: {
          window: ['TestUtils.@@toStringTag', 'TestUtils.gc', 'Window.TestUtils'],
          'dedicated-worker': ['DedicatedWorkerGlobalScope.TestUtils', 'TestUtils.@@toStringTag', 'TestUtils.gc'],
          'shared-worker': ['SharedWorkerGlobalScope.TestUtils', 'TestUtils.@@toStringTag', 'TestUtils.gc'],
          'service-worker': ['ServiceWorkerGlobalScope.TestUtils', 'TestUtils.@@toStringTag', 'TestUtils.gc'],
        },
      },
    })
  })

  test("an excluded interface's holders, targets, interface object property and per-instance members are absent", () => {
    const catalog = catalogOf(
      {
        probe: `
          [Exposed=Window]
          interface Probe {
            undefined run();
            static undefined reset();
            [LegacyUnforgeable] readonly attribute long id;
          };`,
      },
      { Probe: 'Test-only.' },
    )

    expect(catalog.exclusions.Probe.targets.window).toEqual([
      'Probe.prototype',
      'Probe.prototype.@@toStringTag',
      'Probe.prototype.constructor',
      'Probe.prototype.run',
      'Probe.reset',
      'Window.Probe',
    ])
    expect(catalog.holders.window).not.toHaveProperty('Probe')
    expect(catalog.holders.window).not.toHaveProperty('Probe.prototype')
    expect(catalog.instanceMembers.window).not.toHaveProperty('Probe')
    expect(Object.keys(catalog.targets.window).filter((name) => name.includes('Probe'))).toEqual([])
  })

  test('refuses an exclusion that names nothing in the catalog, and one that another holder inherits from', () => {
    const idl = {
      testutils,
      dom: '[Exposed=Window] interface Base {}; [Exposed=Window] interface Derived : Base {};',
    }

    expect(() => catalogOf(idl, { TestUtil: 'Typo.' })).toThrow('exclusion TestUtil names nothing in the catalog')
    expect(() => catalogOf(idl, { Base: 'Inherited.' })).toThrow(
      'exclusion Base removes Base.prototype, which Derived.prototype inherits from in window',
    )
  })
})

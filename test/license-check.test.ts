import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { runtimeLicenses, type Lockfile } from '../tools/license-check/check.ts'

describe('the dependency-license check', () => {
  it('judges runtime packages only, and flags a license not compatible with Apache-2.0, reading SPDX OR and AND with parentheses', () => {
    const lock: Lockfile = {
      packages: {
        '': { version: '0.0.0', license: 'Apache-2.0' },
        'node_modules/a': { version: '1.0.0', license: 'MIT' },
        'node_modules/a/node_modules/@s/b': { version: '2.0.0', license: '(MIT OR GPL-3.0)' },
        'node_modules/c': { version: '1.0.0', license: 'GPL-3.0' },
        'node_modules/d': { version: '1.0.0', license: 'MPL-2.0', dev: true },
        'node_modules/e': { version: '1.0.0' },
        'node_modules/f': { version: '1.0.0', license: '(MIT OR Apache-2.0) AND (GPL-3.0 OR GPL-2.0)' },
        'node_modules/g': { version: '1.0.0', license: '(MIT OR GPL-3.0) AND (BSD-3-Clause OR GPL-2.0)' },
      },
    }
    expect(runtimeLicenses(lock)).toEqual([
      { name: '@s/b', version: '2.0.0', license: '(MIT OR GPL-3.0)', compatible: true },
      { name: 'a', version: '1.0.0', license: 'MIT', compatible: true },
      { name: 'c', version: '1.0.0', license: 'GPL-3.0', compatible: false },
      { name: 'e', version: '1.0.0', license: 'UNKNOWN', compatible: false },
      { name: 'f', version: '1.0.0', license: '(MIT OR Apache-2.0) AND (GPL-3.0 OR GPL-2.0)', compatible: false },
      { name: 'g', version: '1.0.0', license: '(MIT OR GPL-3.0) AND (BSD-3-Clause OR GPL-2.0)', compatible: true },
    ])
  })

  it("passes on monkeypatchlist's own lockfile", () => {
    const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as Lockfile
    expect(runtimeLicenses(lock).filter((entry) => !entry.compatible)).toEqual([])
  })
})

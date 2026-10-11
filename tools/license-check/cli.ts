// The entry of `npm run licenses:check` (tools/license-check/check.ts): lists every runtime dependency's license and
// exits 1 when one is not compatible with Apache-2.0. Build-time only; never published.

import { readFile } from 'node:fs/promises'
import { runtimeLicenses, type Lockfile } from './check.ts'

const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8')) as Lockfile
const licenses = runtimeLicenses(lock)
for (const { name, version, license, compatible } of licenses) {
  process.stdout.write(`${compatible ? 'ok  ' : 'FAIL'} ${name}@${version} ${license}\n`)
}
const failing = licenses.filter((entry) => !entry.compatible)
process.stdout.write(
  `${licenses.length} runtime packages; ${failing.length} with a license not compatible with Apache-2.0.\n`,
)
process.exitCode = failing.length === 0 ? 0 : 1

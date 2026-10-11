// A scan worker process of the corpus check's pool (tools/corpus-snapshot/workers.ts): it loads the catalog once, then
// scans each site the parent sends with the production `monkeypatchlist scan --json`, in process, exactly as the check does
// with one job (with the binding implementation its first argument names), and sends back the JSON text it printed or why the scan failed. Build-time only; never published.

import { loadCatalog } from '../../src/catalog.ts'
import { scanCorpusSite } from '../corpus-scan.ts'
import { isBindingName, resolverFor } from './bindings.ts'
import type { ScanReply, ScanRequest } from './workers.ts'

const catalog = loadCatalog()
const bindings = process.argv[2] ?? 'eslint-scope'
if (!isBindingName(bindings)) throw new Error(`no binding implementation ${bindings}`)
const resolver = resolverFor(bindings)

process.on('message', (request: ScanRequest) => {
  const reply = (message: ScanReply) => process.send!(message)
  scanCorpusSite(request.dir, request.surface, catalog, resolver === undefined ? {} : { resolver }).then(
    (report) => reply({ id: request.id, report }),
    (error: unknown) => reply({ id: request.id, error: error instanceof Error ? error.message : String(error) }),
  )
})
// The parent closes the channel when the check is done, or when it exits.
process.on('disconnect', () => process.exit(0))

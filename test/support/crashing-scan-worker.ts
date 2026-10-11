// A stand-in scan worker for the corpus check's process pool (tools/corpus-snapshot/workers.ts): it answers each scan
// with `<dir> <surface>`, throws for a directory named `throws`, and exits mid-scan for one named `crash`.

import type { ScanReply, ScanRequest } from '../../tools/corpus-snapshot/workers.ts'

process.on('message', ({ id, dir, surface }: ScanRequest) => {
  if (dir.endsWith('crash')) process.exit(3)
  const reply: ScanReply = dir.endsWith('throws') ? { id, error: `cannot scan ${dir}` } : { id, report: `${dir} ${surface}` }
  setTimeout(() => process.send!(reply), 20)
})
process.on('disconnect', () => process.exit(0))

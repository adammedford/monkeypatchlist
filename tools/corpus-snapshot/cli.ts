// The entry of `npm run corpus:check` and `npm run corpus:snapshot` (tools/corpus-snapshot/main.ts). Build-time only;
// never published.
import { main } from './main.ts'

process.exitCode = await main(process.argv.slice(2), process)

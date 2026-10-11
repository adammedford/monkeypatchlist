// The entry of `npm run corpus:fetch` (tools/corpus-fetch/main.ts). Build-time only; never published.
import { main } from './main.ts'

process.exitCode = await main(process.argv.slice(2), process)

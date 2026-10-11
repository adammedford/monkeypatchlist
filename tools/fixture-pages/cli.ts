// The entry of `npm run fixtures:check` (tools/fixture-pages/main.ts). Build-time only; never published.
import { main } from './main.ts'

process.exitCode = await main(process.argv.slice(2), process)

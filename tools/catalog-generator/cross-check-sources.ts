// Reads the cross-check's inputs (§4 Sources): SES `permits` and BCD, exact-pinned devDependencies. They are checks,
// never sources: nothing here feeds the catalog. Build-time only; never published.
import { readFile } from 'node:fs/promises'
import type { Bcd, CrossCheckSources, SesPermit, SesPermits, SesRecord } from './cross-check.ts'
import { exactPin } from './upstream.ts'

const root = new URL('../../', import.meta.url)

/** The packages the cross-check reads, each exact-pinned in package.json. */
export const crossCheckPackages = { ses: 'ses', bcd: '@mdn/browser-compat-data' } as const

/**
 * Reads SES's `src/permits.js` and all of BCD's `data.json` at their pinned versions. Refuses a range pin, or an
 * installed version that differs from the pin.
 */
export async function loadCrossCheckSources(): Promise<CrossCheckSources> {
  const pins = { ses: await exactPin(crossCheckPackages.ses), bcd: await exactPin(crossCheckPackages.bcd) }
  const permits = await import(new URL('node_modules/ses/src/permits.js', root).href)
  const bcd: Bcd = JSON.parse(await readFile(new URL('node_modules/@mdn/browser-compat-data/data.json', root), 'utf8'))
  return { ses: sesPermits(permits), bcd, pins }
}

/** The shape of SES's `src/permits.js` exports that the cross-check reads. */
interface PermitsModule {
  constantProperties: Record<string, unknown>
  universalPropertyNames: Record<string, string>
  initialGlobalPropertyNames: Record<string, string>
  sharedGlobalPropertyNames: Record<string, string>
  uniqueGlobalPropertyNames: Record<string, string>
  permitted: Record<string, unknown>
  FunctionInstance: object
  AsyncFunctionInstance: object
  isAccessorPermit: (permit: unknown) => boolean
}

/**
 * SES's permits as plain data. The start compartment's global object has SES's universal, shared, unique and constant
 * properties, with the initial ones in place of the shared ones they replace.
 */
function sesPermits(module: PermitsModule): SesPermits {
  const permit = (value: unknown): SesPermit => {
    if (value === module.FunctionInstance || value === module.AsyncFunctionInstance) return 'fn'
    if (module.isAccessorPermit(value)) return 'accessor'
    if (value === false || typeof value === 'string') return value
    return 'record'
  }
  const record = (value: object): SesRecord => {
    const { '[[Proto]]': proto, ...properties } = value as Record<string, unknown>
    return {
      proto: proto === undefined ? '%ObjectPrototype%' : (proto as string | null),
      properties: Object.fromEntries(Object.entries(properties).map(([name, item]) => [name, permit(item)])),
    }
  }
  const globals: Record<string, string> = {
    ...Object.fromEntries(Object.keys(module.constantProperties).map((name) => [name, name])),
    ...module.universalPropertyNames,
    ...module.sharedGlobalPropertyNames,
    ...module.uniqueGlobalPropertyNames,
    ...module.initialGlobalPropertyNames,
  }
  const intrinsics: SesPermits['intrinsics'] = {}
  for (const [name, value] of Object.entries(module.permitted)) {
    if (name === '[[Proto]]') continue
    const described = permit(value)
    intrinsics[name] = described === 'record' ? record(value as object) : described
  }
  return { globals, intrinsics }
}

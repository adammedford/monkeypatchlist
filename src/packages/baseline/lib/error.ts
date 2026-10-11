// Why a text is no baseline this monkeypatchlist reads.

import type { ErrorObject } from 'ajv/dist/2020.js'

/** A baseline text that isn't a baseline this monkeypatchlist reads. The message says what is wrong with it. */
export class BaselineError extends Error {
  override name = 'BaselineError'
  /**
   * Whether the text is a baseline in a `formatVersion` newer than this monkeypatchlist's, which is a hard error (§11 Format
   * versions). Otherwise the text is not a readable baseline at all.
   */
  readonly newerFormat: boolean

  constructor(message: string, options: { newerFormat?: boolean } = {}) {
    super(message)
    this.newerFormat = options.newerFormat ?? false
  }
}

/** A validation error as `<JSON Pointer>: <what is wrong>`. */
export function problem({ keyword, instancePath, params, message }: ErrorObject): string {
  const at = instancePath === '' ? '(top level)' : instancePath
  if (keyword === 'required') return `${instancePath}/${params.missingProperty}: is required`
  if (keyword === 'enum') {
    const allowed: unknown[] = params.allowedValues
    return `${at}: must be one of ${allowed.map((value) => JSON.stringify(value)).join(', ')}`
  }
  return `${at}: ${message}`
}

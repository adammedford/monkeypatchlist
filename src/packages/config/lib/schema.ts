// The config JSON Schema (§16) that ships in the package, at `schema/config.schema.json`. It validates the file.

import { readFileSync } from 'node:fs'
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js'

let validate: ValidateFunction | undefined

/** Validates a parsed config file against the shipped schema. Returns one line per problem, each naming its path. */
export function schemaProblems(value: unknown): string[] {
  validate ??= new Ajv2020({ allErrors: true, strict: true }).compile(
    JSON.parse(readFileSync(new URL('../../../../schema/config.schema.json', import.meta.url), 'utf8')),
  )
  return validate(value) ? [] : (validate.errors ?? []).map(problem)
}

/** A validation error as `<JSON Pointer>: <what is wrong>`. */
function problem({ keyword, instancePath, params, message }: ErrorObject): string {
  switch (keyword) {
    case 'additionalProperties':
      return `${instancePath}/${escape(params.additionalProperty)}: unknown key`
    case 'required':
      return `${instancePath}/${escape(params.missingProperty)}: is required`
    case 'enum': {
      const allowed: unknown[] = params.allowedValues
      return `${at(instancePath)}: must be one of ${allowed.map((value) => JSON.stringify(value)).join(', ')}`
    }
    default:
      return `${at(instancePath)}: ${message}`
  }
}

function at(pointer: string): string {
  return pointer === '' ? '(top level)' : pointer
}

/** Escapes a key as a JSON Pointer reference token (RFC 6901). */
function escape(key: string): string {
  return key.replaceAll('~', '~0').replaceAll('/', '~1')
}

import type * as WebIDL2 from 'webidl2'
import type { AssignKind, Descriptor, MemberKind, Realm } from '../../src/catalog.ts'

/**
 * A member the Web IDL ECMAScript binding defines on an interface's or namespace's objects, although no IDL member
 * declares it (§4 Sources): a stringifier's `toString`, the methods an iterable, async_iterable, maplike or setlike
 * declaration or an indexed property getter implies, and the structural properties `prototype`, `constructor`,
 * `@@toStringTag` and `@@unscopables`.
 */
export interface Synthesized {
  /** The property's catalog member name: `toString`, `@@iterator`, `size`. */
  name: string
  kind: Extract<MemberKind, 'operation' | 'attribute' | 'function' | 'value'>
  descriptor: Descriptor
  assign?: AssignKind
  /**
   * Where the binding defines it: on the interface prototype object, on the interface object, or on the namespace
   * object. A `[LegacyUnforgeable]` stringifier's `toString` is on each instance instead (`instance`).
   */
  on: 'prototype' | 'object' | 'namespace'
  instance?: true
  /** For a property whose value is one of the interface's own objects, which one it holds. */
  holds?: 'interface object' | 'interface prototype object'
  /** The spec credited on the target: the one that declares what implies the member. */
  spec: string
  /** The interface mixin the implying declaration reached its owner through. */
  mixin?: string
  /** The realms it is in: those of the declarations that imply it. */
  realms: Realm[]
}

/** A member of an interface or namespace, merged from its partials and mixins, with where it was declared. */
export interface SynthesisMember {
  member: WebIDL2.IDLInterfaceMemberType | WebIDL2.IDLNamespaceMemberType
  spec: string
  mixin?: string | undefined
  /** The realms the member is exposed in. */
  realms: Realm[]
}

/** Data properties as the binding defines them: an operation-like method, and one DefineMethodProperty makes. */
const method: Descriptor = { type: 'data', writable: true, enumerable: true, configurable: true }
const hiddenMethod: Descriptor = { type: 'data', writable: true, enumerable: false, configurable: true }
/** `[LegacyUnforgeable]` makes a stringifier's `toString` neither writable nor configurable. */
const unforgeableMethod: Descriptor = { type: 'data', writable: false, enumerable: true, configurable: false }
/** A maplike or setlike declaration's `size`: a getter, with no setter. */
const size: Descriptor = { type: 'accessor', setter: false, enumerable: true, configurable: true }
/** `@@toStringTag`, `@@unscopables` and a prototype's `constructor`. */
export const tag: Descriptor = { type: 'data', writable: false, enumerable: false, configurable: true }
export const constructorProperty: Descriptor = { type: 'data', writable: true, enumerable: false, configurable: true }
/** An interface object's, or legacy factory function's, `prototype`. */
export const prototypeProperty: Descriptor = { type: 'data', writable: false, enumerable: false, configurable: false }

/**
 * The members the binding synthesizes for an interface or namespace (Web IDL, ECMAScript binding):
 * - a stringifier: `toString`, on each instance for a `[LegacyUnforgeable]` one
 * - an interface with an indexed property getter: `@@iterator` (`%Array.prototype.values%`), whether or not it
 *   declares `iterable` ("define the iteration methods")
 * - `iterable<V>`: `entries`, `keys`, `values` and `forEach` (with the indexed getter's `@@iterator`); `iterable<K, V>`:
 *   those and `@@iterator`
 * - `async_iterable<V>`: `@@asyncIterator` and `values`; `async_iterable<K, V>`: `entries` and `keys` too
 * - `maplike<K, V>`: `size`, `entries`, `forEach`, `get`, `has`, `keys`, `values`, `@@iterator`, and `set`, `delete`
 *   and `clear` unless readonly; `setlike<V>` the same with `add` for `set` and no `get`
 * - every interface: `@@toStringTag` on its prototype; with an interface object, that object's `prototype` and the
 *   prototype's `constructor`; with `[Unscopable]` members, `@@unscopables` on its prototype
 * - a namespace: `@@toStringTag`
 *
 * An interface or namespace that declares a member of the same name keeps it: the caller skips a synthesized member
 * whose name is taken. `@@iterator` and each method are operation-like, `size` a readonly attribute, and the structural
 * properties are values, `constructor` a function, as the ECMAScript intrinsics' are.
 */
export function synthesize(
  definition: { type: 'interface' | 'namespace' | 'callback interface' | 'interface mixin'; spec: string },
  members: readonly SynthesisMember[],
  { realms, interfaceObject }: { realms: Realm[]; interfaceObject: boolean },
): Synthesized[] {
  if (definition.type === 'namespace') {
    return [{ name: '@@toStringTag', kind: 'value', descriptor: tag, on: 'namespace', spec: definition.spec, realms }]
  }
  if (definition.type !== 'interface') return []
  const synthesized: Synthesized[] = []
  const from = ({ spec, mixin, realms }: SynthesisMember) => ({ spec, realms, ...(mixin && { mixin }) })
  const methods = (declaration: SynthesisMember, names: readonly string[], descriptor = method) => {
    for (const name of names) synthesized.push({ name, kind: 'operation', descriptor, on: 'prototype', ...from(declaration) })
  }

  for (const declared of members) {
    const { member } = declared
    if (member.type === 'operation' || member.type === 'attribute') {
      if (member.special === 'stringifier') {
        const unforgeable = member.extAttrs.some(({ name }) => name === 'LegacyUnforgeable')
        const descriptor = unforgeable ? unforgeableMethod : method
        synthesized.push({
          name: 'toString',
          kind: 'operation',
          descriptor,
          on: 'prototype',
          ...(unforgeable && { instance: true as const }),
          ...from(declared),
        })
      }
      if (isIndexedGetter(member)) methods(declared, ['@@iterator'], hiddenMethod)
      continue
    }
    if (member.type === 'const' || member.type === 'constructor') continue
    const type = member.type as string
    const pair = member.idlType.length === 2
    if (type === 'iterable') {
      if (pair) methods(declared, ['@@iterator'], hiddenMethod)
      methods(declared, ['entries', 'keys', 'values', 'forEach'])
    } else if (type === 'async_iterable') {
      methods(declared, ['@@asyncIterator'], hiddenMethod)
      methods(declared, pair ? ['entries', 'keys', 'values'] : ['values'])
    } else if (type === 'maplike' || type === 'setlike') {
      const readonly = 'readonly' in member && member.readonly
      synthesized.push({ name: 'size', kind: 'attribute', descriptor: size, assign: 'readonly', on: 'prototype', ...from(declared) })
      methods(declared, ['@@iterator'], hiddenMethod)
      const readers = type === 'maplike' ? ['entries', 'forEach', 'get', 'has', 'keys', 'values'] : ['entries', 'forEach', 'has', 'keys', 'values']
      methods(declared, readers)
      if (!readonly) methods(declared, [type === 'maplike' ? 'set' : 'add', 'delete', 'clear'])
    }
  }

  const { spec } = definition
  synthesized.push({ name: '@@toStringTag', kind: 'value', descriptor: tag, on: 'prototype', spec, realms })
  if (interfaceObject) {
    synthesized.push(
      { name: 'prototype', kind: 'value', descriptor: prototypeProperty, on: 'object', holds: 'interface prototype object', spec, realms },
      { name: 'constructor', kind: 'function', descriptor: constructorProperty, on: 'prototype', holds: 'interface object', spec, realms },
    )
  }
  const unscopable = members.filter(({ member }) => member.extAttrs.some(({ name }) => name === 'Unscopable'))
  if (unscopable.length) {
    const unscopableRealms = realms.filter((realm) => unscopable.some((declared) => declared.realms.includes(realm)))
    synthesized.push({ name: '@@unscopables', kind: 'value', descriptor: tag, on: 'prototype', spec, realms: unscopableRealms })
  }
  return synthesized
}

/** Whether a member is an indexed property getter: a getter whose one argument is an `unsigned long` (Web IDL). */
function isIndexedGetter(member: WebIDL2.OperationMemberType | WebIDL2.AttributeMemberType): boolean {
  if (member.type !== 'operation' || member.special !== 'getter') return false
  return member.arguments[0]?.idlType.idlType === 'unsigned long'
}

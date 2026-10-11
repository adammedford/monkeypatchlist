// Patch shape (§5 Partially resolved writes): whether a write site whose holder the analyzer can't resolve keeps the
// original of the slot it writes, so that it may patch a native. A site keeps it when it reads the same (holder,
// member) first, in the same function, and that read is:
//
// - called, or `.call`/`.apply`/`.bind`-ed
// - passed to a call whose callee isn't a catalog native (`wrap(o.fetch)`, not `String(o.fetch)`)
// - stored: a variable's initializer, an assignment's value, an object literal's field or an array element
// - kept when present: `o.m = o.m || p`, `o.m ||= p`, `if (!o.m) o.m = p`, `o.m || (o.m = p)`
//
// A define also counts when its descriptor gives `get` or `set`, or when a `getOwnPropertyDescriptor` of the same slot
// comes before it. A delete counts only after the original was captured, by such a read or a descriptor read.
//
// The same (holder, member) is the same root variable, parameter or `this`, through the same constant property chain
// after aliases, with no redefinition of a root variable between the read and the write. A holder chosen by `?:`,
// `&&`, `||` or `??` among such expressions is the same when every part is.

import { calleeExpression, walkTree, type AstNode } from './ast.ts'
import type { Definitions, VariableKey } from './definitions.ts'
import { literalKey, type Key as MemberKey } from './keys.ts'
import type { OpenWrite, WildWrite } from './writes.ts'

export interface ShapeContext {
  program: AstNode
  definitions: Definitions
  /** The constant key an expression folds to, as ToPropertyKey converts it, or none when it doesn't fold to one. */
  fold(key: AstNode): MemberKey | undefined
  /** Whether a callee is a catalog native: a native function, a native holder, or a catalog member read from one. */
  isCatalogNative(callee: AstNode): boolean
  /** Whether a callee is `Object.getOwnPropertyDescriptor` or `Reflect.getOwnPropertyDescriptor`. */
  isDescriptorReader(callee: AstNode): boolean
  /** How deep an alias chain is followed to its root (§18, `Caps.aliasDepth`). */
  aliasDepth: number
  /** Counts a hit of the `aliasDepth` cap at the alias it keeps from being followed (§18). */
  aliasCut(id: AstNode): void
  /** The functions the program makes that a callee can be, for reads made in a summarized callee. */
  calleeFunctions(callee: AstNode): AstNode[]
}

/**
 * How a wildcard write reuses its key (§5 Partially resolved writes): the reads of the same (holder, key) before
 * it, which give the original, and whether the write keeps the member when present, which makes its value equal the
 * read then.
 */
export interface Reuse {
  /** Whether a node gives the original: a read of the slot, a summarized call that reads it, or a fetched descriptor's `value`. */
  isOriginal(node: AstNode): boolean
  /** Whether the write keeps the member when present: `o[k] || p`, `o[k] ||= p`, `if (!o[k])`, `if (!(k in o))`. */
  keptWhenPresent: boolean
  /** Whether the value written is a read of the same slot, which writes back what is there. */
  writesBack: boolean
}

/** Patch-shape and key-reuse judgements over one program (§5 Partially resolved writes). */
export interface Shapes {
  /** Whether a write site whose holder doesn't resolve keeps the original of its slot. */
  patchShaped(write: OpenWrite): boolean
  /** How a wildcard write reuses its key, or undefined when it doesn't: no read of it, nor its descriptor, comes first. */
  reuse(write: WildWrite): Reuse | undefined
}

/** Functions, whose own code is apart from the code around them. */
const functionTypes: ReadonlySet<string> = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/**
 * Holder signatures over one program (§5 Partially resolved writes): the same for two expressions that give the same
 * holder, the same root variable, parameter or `this` through the same constant property chain after aliases.
 */
export interface Slots {
  /** A holder expression's signature, with the variables it reads in `roots`; none when it is no such expression. */
  signature(expression: AstNode, roots: VariableKey[]): string | undefined
  /**
   * A key expression's signature, with the variables it reads in `roots`, read from the syntax alone, with nothing
   * evaluated: the same for two expressions that give the same key, a literal, or the same variable, parameter or
   * `this` through the same property chain, whose computed keys are such expressions too (`names[i]`); none for
   * anything else.
   */
  keySignature(expression: AstNode, roots: VariableKey[]): string | undefined
  /** Whether a root variable is defined again between `from` and `to`. */
  redefined(roots: readonly VariableKey[], from: number, to: number): boolean
}

export function slotSignatures(context: Pick<ShapeContext, 'definitions' | 'fold' | 'aliasDepth' | 'aliasCut'>): Slots {
  /** The constant key a member expression reads: its name, or a computed key that folds. */
  const keyOf = (member: AstNode): MemberKey | undefined => {
    const property = member['property'] as AstNode
    if (member['computed'] === true) return context.fold(property)
    return property.type === 'Identifier' ? (property['name'] as string) : undefined
  }

  /** The variable an identifier names, followed through aliases that have one definition, a plain name or member. */
  const rooted = (id: AstNode, roots: VariableKey[], depth: number): string | undefined => {
    const key = context.definitions.keyOf(id)
    if (key === undefined) return undefined
    const definitions = context.definitions.of(key)
    const [only] = definitions
    if (
      definitions.length === 1 &&
      only?.site.type === 'VariableDeclarator' &&
      only.pattern.type === 'Identifier' &&
      only.source !== undefined
    ) {
      const source = unwrapped(only.source)
      if (source.type === 'Identifier' || source.type === 'MemberExpression' || source.type === 'ThisExpression') {
        // An alias past the cap is taken as the root, a hit of the cap (§18).
        if (depth >= context.aliasDepth) context.aliasCut(id)
        else {
          const followed = signature(source, roots, depth + 1)
          if (followed !== undefined) return followed
        }
      }
    }
    roots.push(key)
    return `v(${key.scope === 'global' ? 'global' : key.scope.start}:${key.name})`
  }

  /**
   * A holder expression's signature, the same for two expressions that give the same holder, with the variables it
   * reads in `roots`; none when it is no such expression (a call, a literal).
   */
  const signature = (expression: AstNode, roots: VariableKey[], depth = 0): string | undefined => {
    const node = unwrapped(expression)
    switch (node.type) {
      case 'Identifier':
        return rooted(node, roots, depth)
      case 'ThisExpression':
        return 'this'
      case 'MemberExpression': {
        const object = signature(node['object'] as AstNode, roots, depth)
        const key = keyOf(node)
        return object === undefined || key === undefined ? undefined : `m(${object},${keySignature(key)})`
      }
      case 'ConditionalExpression': {
        const parts = ['test', 'consequent', 'alternate'].map((part) => signature(node[part] as AstNode, roots, depth))
        return parts.every((part) => part !== undefined) ? `c(${parts.join(',')})` : undefined
      }
      case 'LogicalExpression': {
        const parts = ['left', 'right'].map((part) => signature(node[part] as AstNode, roots, depth))
        return parts.every((part) => part !== undefined) ? `l${node['operator'] as string}(${parts.join(',')})` : undefined
      }
      default:
        return undefined
    }
  }

  /** Whether a root variable is defined again between `from` and `to`. */
  const redefined = (roots: readonly VariableKey[], from: number, to: number): boolean =>
    roots.some((key) => context.definitions.of(key).some(({ site }) => site.start >= from && site.start < to))

  /** A key expression's signature (`Slots.keySignature`). */
  const keyExpression = (expression: AstNode, roots: VariableKey[]): string | undefined => {
    const node = unwrapped(expression)
    switch (node.type) {
      case 'Literal': {
        const literal = literalKey(node)
        return literal === undefined ? undefined : keySignature(literal)
      }
      case 'Identifier':
        return rooted(node, roots, 0)
      case 'ThisExpression':
        return 'this'
      case 'MemberExpression': {
        const object = keyExpression(node['object'] as AstNode, roots)
        const property = node['property'] as AstNode
        const key =
          node['computed'] === true
            ? keyExpression(property, roots)
            : property.type === 'Identifier'
              ? JSON.stringify(property['name'])
              : undefined
        return object === undefined || key === undefined ? undefined : `m(${object},${key})`
      }
      // A key built from such parts by `+` or a template, as a prefix and a name (`"get" + k`).
      case 'BinaryExpression': {
        if (node['operator'] !== '+') return undefined
        const parts = ['left', 'right'].map((part) => keyExpression(node[part] as AstNode, roots))
        return parts.every((part) => part !== undefined) ? `+(${parts.join(',')})` : undefined
      }
      case 'TemplateLiteral': {
        const quasis = (node['quasis'] as AstNode[]).map((quasi) => (quasi['value'] as { cooked: string | null }).cooked)
        const expressions = (node['expressions'] as AstNode[]).map((each) => keyExpression(each, roots))
        if (quasis.some((cooked) => cooked === null) || expressions.some((each) => each === undefined)) return undefined
        return `t(${JSON.stringify(quasis)},${expressions.join(',')})`
      }
      default:
        return undefined
    }
  }

  return { signature: (expression, roots) => signature(expression, roots), keySignature: keyExpression, redefined }
}

/** Patch-shape and key-reuse judgements over one program: its parents, computed once. */
export function patchShapes(context: ShapeContext): Shapes {
  /** The constant key a member expression reads: its name, or a computed key that folds. */
  const keyOf = (member: AstNode): MemberKey | undefined => {
    const property = member['property'] as AstNode
    if (member['computed'] === true) return context.fold(property)
    return property.type === 'Identifier' ? (property['name'] as string) : undefined
  }
  const { signature, keySignature: keyExpression, redefined } = slotSignatures(context)

  let parents: Map<AstNode, AstNode> | undefined
  const parentOf = (node: AstNode): AstNode | undefined => {
    if (parents === undefined) {
      const built = new Map<AstNode, AstNode>()
      walkTree(context.program, {
        enter(child, parent) {
          if (parent !== null) built.set(child, parent)
        },
      })
      parents = built
    }
    return parents.get(node)
  }

  /** The function (or the program) whose own code a node is in. */
  const ownerOf = (node: AstNode): AstNode => {
    let at = parentOf(node)
    while (at !== undefined && !functionTypes.has(at.type)) at = parentOf(at)
    return at ?? context.program
  }

  /** The member expressions and calls in `owner`'s own code, nested functions left out, in document order. */
  const members = new Map<AstNode, AstNode[]>()
  const membersOf = (owner: AstNode): AstNode[] => {
    const cached = members.get(owner)
    if (cached !== undefined) return cached
    const found: AstNode[] = []
    walkTree(owner, {
      enter(node) {
        if (node !== owner && functionTypes.has(node.type)) return false
        if (node.type === 'MemberExpression' || node.type === 'CallExpression') found.push(node)
        else if (node.type === 'BinaryExpression' && node['operator'] === 'in') found.push(node)
      },
    })
    members.set(owner, found)
    return found
  }

  /**
   * The expression a value's use is judged at: past the parentheses, optional chains, `?:` arms, the last expression
   * of a comma sequence and the operands of `&&`, `||` and `??` it sits in. `present` says it passed the left of an
   * `||` or `??`, which keeps it when present.
   */
  const useOf = (node: AstNode): { use: AstNode; parent: AstNode | undefined; present: boolean } => {
    let use = node
    let present = false
    for (;;) {
      const parent = parentOf(use)
      if (parent === undefined) return { use, parent, present }
      const transparent =
        parent.type === 'ParenthesizedExpression' ||
        parent.type === 'ChainExpression' ||
        (parent.type === 'ConditionalExpression' && parent['test'] !== use) ||
        (parent.type === 'SequenceExpression' && (parent['expressions'] as AstNode[]).at(-1) === use) ||
        parent.type === 'LogicalExpression'
      if (!transparent) return { use, parent, present }
      if (parent.type === 'LogicalExpression' && parent['left'] === use && parent['operator'] !== '&&') present = true
      use = parent
    }
  }

  /** Whether `node` lies within `outer`. */
  const within = (node: AstNode, outer: AstNode): boolean => node.start >= outer.start && node.end <= outer.end

  /** Whether a read of the original, `read`, keeps it for the write `write`. */
  const keeps = (read: AstNode, write: OpenWrite): boolean => {
    const { use, parent, present } = useOf(read)
    if (parent === undefined) return false
    // Kept when present: `o.m = o.m || p`.
    if (parent === write.site && use === write.value && present) return true
    // Tested before the write: `if (!o.m) o.m = p`, `o.m || (o.m = p)`, `o.m ? … : (o.m = p)`.
    if (testedBefore(read, write.site)) return true
    switch (parent.type) {
      case 'CallExpression':
      case 'NewExpression':
        if (parent['callee'] === use) return true
        return (parent['arguments'] as AstNode[]).includes(use) && !context.isCatalogNative(parent['callee'] as AstNode)
      case 'MemberExpression': {
        if (parent['object'] !== use) return false
        const key = keyOf(parent)
        return key === 'call' || key === 'apply' || key === 'bind'
      }
      case 'VariableDeclarator':
        return parent['init'] === use
      case 'AssignmentExpression':
        // The write's own value is no store: `o.m = o.m` writes it back.
        return parent['right'] === use && parent !== write.site
      case 'Property':
        // A bulk mechanism's own field is no store: `Object.assign(o, { m: o.m })` writes it back.
        return parent['value'] === use && parent !== write.site && parentOf(parent)?.type === 'ObjectExpression'
      case 'ArrayExpression':
        return true
      default:
        return false
    }
  }

  /**
   * Whether `read` is tested for presence so that `site` runs only when the original is absent, which keeps it when
   * present: the read itself, negated, its `typeof` compared with a string, or the read compared with `null`,
   * `undefined`, `void` or a string, as the test of an `if` or `?:` with `site` in the arm that runs when it is absent,
   * or as the left of `&&`, `||` or `??` with `site` on the right (`if (!o.m) o.m = p`, `o.m || (o.m = p)`, not
   * `if (o.m) o.m = p` nor `o.m && (o.m = p)`). Parts of a test joined by `&&` or `||` carry what they imply.
   */
  const testedBefore = (read: AstNode, site: AstNode): boolean => {
    // What the value at `child` being truthy, or falsy, says of the original, and what that value is: the read itself,
    // its `typeof`, or a boolean derived from it.
    let sense: Sense = { truthy: 'present', falsy: 'absent' }
    let mode: 'read' | 'typeof' | 'boolean' = 'read'
    for (let child = read, at = parentOf(read); at !== undefined; child = at, at = parentOf(at)) {
      switch (at.type) {
        case 'ParenthesizedExpression':
        case 'ChainExpression':
          continue
        case 'UnaryExpression':
          if (mode === 'read' && at['operator'] === 'typeof') mode = 'typeof'
          else if (mode !== 'typeof' && at['operator'] === '!') {
            sense = { truthy: sense.falsy, falsy: sense.truthy }
            mode = 'boolean'
          } else return false
          continue
        case 'BinaryExpression': {
          if (mode === 'boolean') return false
          const compared = comparison(at, child, mode)
          if (compared === undefined) return false
          sense = compared
          mode = 'boolean'
          continue
        }
        case 'LogicalExpression': {
          if (mode === 'typeof') return false
          const operator = at['operator'] as string
          if (at['left'] === child && within(site, at['right'] as AstNode)) {
            if (operator === '&&') return sense.truthy === 'absent'
            if (operator === '||') return sense.falsy === 'absent'
            return mode === 'read'
          }
          // A part of a larger test: the whole being truthy says each part of an `&&` is, and falsy each part of an `||`.
          if (operator === '&&') sense = { truthy: sense.truthy, falsy: undefined }
          else if (operator === '||') sense = { truthy: undefined, falsy: sense.falsy }
          else return false
          mode = 'boolean'
          continue
        }
        case 'IfStatement':
        case 'ConditionalExpression': {
          if (at['test'] !== child || mode === 'typeof') return false
          const [consequent, alternate] = [at['consequent'], at['alternate']] as (AstNode | null | undefined)[]
          if (consequent != null && within(site, consequent)) return sense.truthy === 'absent'
          if (alternate != null && within(site, alternate)) return sense.falsy === 'absent'
          return false
        }
        default:
          return false
      }
    }
    return false
  }

  const patchShaped = (write: OpenWrite): boolean => {
    const roots: VariableKey[] = []
    const holder = signature(write.holder, roots)
    if (holder === undefined) return false
    const slot = `m(${holder},${keySignature(write.change.member)})`
    const change = write.change
    if (change.kind === 'define' && (change.descriptor.get || change.descriptor.set)) return true
    const owner = ownerOf(write.site)
    for (const node of membersOf(owner)) {
      // Only what comes before the write, or is part of it, counts, and never the member expression written.
      if (node.start >= write.site.end || node === write.target) continue
      if (write.target !== undefined && within(node, write.target)) continue
      if (redefined(roots, node.end, write.site.start)) continue
      if (node.type === 'BinaryExpression') continue
      if (node.type === 'CallExpression') {
        // A descriptor read of the same slot captures the original for a define or a delete.
        if (change.kind === 'set' || !context.isDescriptorReader(calleeExpression(node['callee'] as AstNode))) continue
        const [object, key] = node['arguments'] as AstNode[]
        if (object === undefined || key === undefined || node.end > write.site.start) continue
        const readRoots: VariableKey[] = []
        const read = signature(object, readRoots)
        const member = context.fold(key)
        if (read === holder && member !== undefined && keySignature(member) === keySignature(change.member)) return true
        continue
      }
      const readRoots: VariableKey[] = []
      const object = signature(node['object'] as AstNode, readRoots)
      const key = keyOf(node)
      if (object === undefined || key === undefined || `m(${object},${keySignature(key)})` !== slot) continue
      if (keeps(node, write)) return true
    }
    return write.keepsPresent === true
  }

  /**
   * Whether a function reads the slot of its `index`th parameter, as a key, from the holder `holder` signs: through
   * another parameter whose argument in `args` gives that holder, or through an expression that gives it.
   */
  const readsParameter = (fn: AstNode, index: number, args: readonly AstNode[], holder: string): boolean => {
    const params = fn['params'] as AstNode[]
    /** The parameter an identifier in the function's own code reads, by its index; -1 for none. */
    const parameterOf = (id: AstNode): number => {
      const variable = context.definitions.keyOf(id)
      if (variable?.scope !== fn) return -1
      return params.findIndex((param) => param.type === 'Identifier' && param['name'] === variable.name)
    }
    if (params[index]?.type !== 'Identifier') return false
    return membersOf(fn).some((node) => {
      if (node.type !== 'MemberExpression' || node['computed'] !== true) return false
      const property = unwrapped(node['property'] as AstNode)
      if (property.type !== 'Identifier' || parameterOf(property) !== index) return false
      const object = unwrapped(node['object'] as AstNode)
      const at = object.type === 'Identifier' ? parameterOf(object) : -1
      const arg = at < 0 ? undefined : args[at]
      if (at >= 0) return arg !== undefined && arg.type !== 'SpreadElement' && signature(arg, []) === holder
      return signature(object, []) === holder
    })
  }

  const reuse = (write: WildWrite): Reuse | undefined => {
    const roots: VariableKey[] = []
    const holder = signature(write.object, roots)
    const key = holder === undefined ? undefined : keyExpression(write.key, roots)
    if (holder === undefined || key === undefined) return undefined
    const slot = `m(${holder},${key})`
    const signs = (object: AstNode, member: AstNode | undefined): boolean => {
      if (member === undefined || signature(object, []) !== holder) return false
      return keyExpression(member, []) === key
    }
    /** The key a member expression reads, signed as `keyExpression` signs it. */
    const memberKey = (member: AstNode): string | undefined => {
      const property = member['property'] as AstNode
      if (member['computed'] === true) return keyExpression(property, [])
      return property.type === 'Identifier' ? JSON.stringify(property['name']) : undefined
    }
    const reads = new Set<AstNode>()
    const descriptors = new Set<AstNode>()
    let keptWhenPresent = write.keepsPresent === true
    const owner = ownerOf(write.site)
    for (const node of membersOf(owner)) {
      // Only what comes before the write, or is part of it, counts, and never the member expression written.
      if (node.start >= write.site.end || node === write.target) continue
      if (write.target !== undefined && within(node, write.target)) continue
      if (redefined(roots, node.end, write.site.start)) continue
      if (node.type === 'BinaryExpression') {
        // `k in o` tests presence: the write keeps the member when it runs only on its absence.
        if (signs(node['right'] as AstNode, node['left'] as AstNode) && testedBefore(node, write.site)) keptWhenPresent = true
        continue
      }
      if (node.type === 'CallExpression') {
        if (node.end > write.site.start) continue
        const args = node['arguments'] as AstNode[]
        const callee = calleeExpression(node['callee'] as AstNode)
        if (context.isDescriptorReader(callee)) {
          if (signs(args[0]!, args[1])) descriptors.add(node)
          continue
        }
        // A read in a summarized callee whose parameter is bound to the same key binding.
        const index = args.findIndex((arg) => arg.type !== 'SpreadElement' && keyExpression(arg, []) === key)
        if (index < 0) continue
        if (context.calleeFunctions(callee).some((fn) => readsParameter(fn, index, args, holder))) reads.add(node)
        continue
      }
      const object = signature(node['object'] as AstNode, [])
      const member = memberKey(node)
      if (object === undefined || member === undefined || `m(${object},${member})` !== slot) continue
      reads.add(node)
      const { use, parent, present } = useOf(node)
      if ((parent === write.site && use === write.value && present) || testedBefore(node, write.site)) keptWhenPresent = true
    }
    if (reads.size === 0 && descriptors.size === 0 && !keptWhenPresent) return undefined
    const value = write.value === undefined ? undefined : unwrapped(write.value)
    const writesBack = value !== undefined && value.type === 'MemberExpression' && reads.has(value)
    /** Whether an expression gives a descriptor fetched from the slot: the call, or a variable it alone defines. */
    const fetched = (node: AstNode): boolean => {
      const expression = unwrapped(node)
      if (descriptors.has(expression)) return true
      if (expression.type !== 'Identifier') return false
      const variable = context.definitions.keyOf(expression)
      const definitions = variable === undefined ? [] : context.definitions.of(variable)
      return (
        definitions.length > 0 &&
        definitions.every((each) => each.source !== undefined && descriptors.has(unwrapped(each.source)))
      )
    }
    const isOriginal = (node: AstNode): boolean => {
      const expression = unwrapped(node)
      if (reads.has(expression)) return true
      if (expression.type !== 'MemberExpression' || expression['computed'] === true) return false
      const property = expression['property'] as AstNode
      return property.type === 'Identifier' && property['name'] === 'value' && fetched(expression['object'] as AstNode)
    }
    return { isOriginal, keptWhenPresent, writesBack }
  }

  return { patchShaped, reuse }
}

/** The operators that compare a value with `null`, `undefined` or a string. */
const equalities: ReadonlySet<string> = new Set(['==', '!=', '===', '!=='])

/** Whether the original is present or absent, or neither is known. */
type Presence = 'present' | 'absent' | undefined

/** What a test value being truthy, or falsy, says of the original. */
interface Sense {
  truthy: Presence
  falsy: Presence
}

/**
 * What a comparison of `child` (the read, or its `typeof`) says of the original: with `null`, `undefined` or `void`,
 * that it is absent or present; with a string, the read's `typeof` equal to `'undefined'` that it is absent, and any
 * other string equal that it is present. None for any other comparison.
 */
function comparison(node: AstNode, child: AstNode, mode: 'read' | 'typeof'): Sense | undefined {
  const operator = node['operator'] as string
  if (!equalities.has(operator)) return undefined
  const other = (node['left'] === child ? node['right'] : node['left']) as AstNode
  const nullish =
    (other.type === 'Literal' && other['value'] === null && other['raw'] === 'null') ||
    (other.type === 'Identifier' && other['name'] === 'undefined') ||
    (other.type === 'UnaryExpression' && other['operator'] === 'void')
  const string = other.type === 'Literal' && typeof other['value'] === 'string' ? (other['value'] as string) : undefined
  let equal: Sense
  if (mode === 'read' && nullish) equal = { truthy: 'absent', falsy: 'present' }
  else if (string === undefined) return undefined
  else if (mode === 'typeof' && string === 'undefined') equal = { truthy: 'absent', falsy: 'present' }
  else equal = { truthy: 'present', falsy: undefined }
  return operator.startsWith('!') ? { truthy: equal.falsy, falsy: equal.truthy } : equal
}

/** A key's signature: a string's JSON, or a well-known symbol's description. */
function keySignature(key: MemberKey): string {
  return typeof key === 'symbol' ? `s:${key.description ?? ''}` : JSON.stringify(key)
}

/** An expression past its parentheses and optional chain. */
function unwrapped(node: AstNode): AstNode {
  let at = node
  while (at.type === 'ParenthesizedExpression' || at.type === 'ChainExpression') at = at['expression'] as AstNode
  return at
}

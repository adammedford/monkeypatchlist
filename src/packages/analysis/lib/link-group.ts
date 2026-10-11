// Link groups (§6 Link groups, §19, ADR 0010): an entry artifact plus every artifact reachable from it through its
// static and dynamic imports, analyzed as one program with one heap and one realm.
//
// The group's members are joined into one program, so that the rest of the resolver sees one AST, as it would for a
// scope-hoisted single-file build:
//
// - The group's text is its members' texts one after another, each starting on a line of its own, and every node's
//   offsets are shifted into it. `GroupLines` gives each location back in the coordinates of its own artifact.
// - The entry's code stays at the top level, as it runs. Every other member's code is the body of a function of its
//   own, which gives it a module scope of its own. A member the entry's static imports reach runs at load, before the
//   code that imports it: its function is called at the top level, in evaluation order. A member only dynamic imports
//   reach runs when one of them does (`loadedBy`), never at load (§6, §7 Install context).
// - An import binding is the variable the module it names exports (`bound`), followed through re-exports, so a read
//   or call of it is a read or call of that variable. An import whose module isn't in the group is a broken link
//   (`unlinked`).
// - A member that doesn't parse fails every module graph that holds it, which gives nothing (Principle 1), and is
//   recorded (§13 `parse-failure`).

import { walkTree, type AstNode } from './ast.ts'
import { registriesOf } from './chunk-registry.ts'
import { GroupLines, lineStarts } from './line-starts.ts'
import { parse } from './parse.ts'
import { boundNames } from './scope.ts'
import type { AnalyzeGroupInput, ArtifactSource } from './types.ts'

/** The variable an import binding is (`LinkGroup.bound`): its declaration, and the name it declares. */
export interface Bound {
  declaration: AstNode
  name: string
}

/** A module request in a member's code (§6 Module links). */
interface Request {
  /** The `import` or `export … from` declaration, or the `import(…)` expression. */
  node: AstNode
  specifier: string
  dynamic: boolean
  target?: Member
}

interface Member {
  source: ArtifactSource
  program?: AstNode
  /** The program's statements as parsed, before its imports become declarations of the group's program. */
  statements: AstNode[]
  error?: string
  requests: Request[]
  /**
   * Whether a loader's chunk registry links the member (§6 idiom 6): a lazy chunk, whose code runs only when the loader
   * loads it, or an initial chunk its page references, which runs at load.
   */
  chunk?: 'lazy' | 'initial'
}

export interface LinkGroup {
  /** The group's text: its members' texts, one after another. */
  text: string
  /** The group's program. */
  program: AstNode
  sourceType: 'script' | 'module'
  lines: GroupLines
  /** The group's members, entry first, then in the order their code sits in the group's text. */
  members: ArtifactSource[]
  /** The members that don't parse, with the parser's error. */
  failures: { source: ArtifactSource; error: string }[]
  /** The variable the import binding `name` of a declaration is, when the declaration is an import. */
  bound(declaration: AstNode, name: string): Bound | undefined
  /** The function each member other than the entry runs in, and the member. */
  wrappers: ReadonlyMap<AstNode, ArtifactSource>
  /** The `import(…)` calls that run each member only dynamic imports reach, by its function (§6). */
  loadedBy: ReadonlyMap<AstNode, readonly AstNode[]>
  /** The members a chunk registry links (§6 idiom 6), by URL: lazy chunks, whose code is always `deferred`. */
  chunks: ReadonlySet<string>
  /** How many module requests of each member's code name no member of the group (§6 Degradation), by URL. */
  unlinked: ReadonlyMap<string, number>
  /**
   * The import bindings whose module isn't in the group, by their import declaration, which a reference to one resolves
   * to, and name, each with the import declaration.
   */
  unlinkedBindings: ReadonlyMap<AstNode, ReadonlyMap<string, AstNode>>
}

/**
 * The link group of `entry`: its members, pulled in through the module requests `resolveImport` resolves, and joined
 * into one program. A group of one artifact is that artifact's program, unchanged. Undefined when the entry's own
 * module graph fails; `failures` then says why.
 */
export function linkGroup(
  entry: ArtifactSource,
  { artifact, resolveImport, chunks, initialChunks }: Pick<AnalyzeGroupInput, 'artifact' | 'resolveImport' | 'chunks' | 'initialChunks'>,
): { group?: LinkGroup; failures: { source: ArtifactSource; error: string }[]; pulled: ArtifactSource[] } {
  const byUrl = new Map<string, Member>()
  const queue: Member[] = []
  const add = (source: ArtifactSource, sourceType: 'script' | 'module'): Member => {
    const parsed = parse(source.text, sourceType)
    const member: Member =
      'error' in parsed
        ? { source, statements: [], error: parsed.error, requests: [] }
        : { source, program: parsed.program, statements: [...(parsed.program['body'] as AstNode[])], requests: [] }
    byUrl.set(source.url, member)
    queue.push(member)
    return member
  }
  add(entry, entry.sourceType)
  for (let next = 0; next < queue.length; next++) {
    const member = queue[next]!
    if (member.program === undefined) continue
    member.requests = requestsOf(member.program)
    for (const request of member.requests) {
      const url = resolveImport?.(member.source.url, request.specifier)
      const found = url === undefined ? undefined : (byUrl.get(url)?.source ?? artifact(url))
      if (found === undefined) continue
      // An import always loads a module (HTML § Fetch a single module script).
      request.target = byUrl.get(found.url) ?? add({ ...found, sourceType: 'module' }, 'module')
    }
    // The chunks a loader of the member's code loads (§6 idiom 6): every build-directory artifact that pushes an
    // id its id table maps into the registry it reads, each with its own source type. A stale copy pushing the same id
    // joins too, as an alternative (Principle 3).
    // The page's initial chunks join too.
    for (const load of registriesOf(member.program).loads) {
      const pull = (url: string, kind: 'lazy' | 'initial') => {
        if (byUrl.has(url)) return
        const found = artifact(url)
        if (found !== undefined) add(found, found.sourceType).chunk = kind
      }
      for (const url of initialChunks?.(load.registry) ?? []) pull(url, 'initial')
      if (chunks === undefined) continue
      for (const id of load.ids === 'any' ? [null] : [...load.ids].sort()) {
        for (const url of chunks(load.registry, id)) pull(url, 'lazy')
      }
    }
  }

  const failures = queue.flatMap(({ source, error }) => (error === undefined ? [] : [{ source, error }]))
  // A module graph fails when a module its static imports reach doesn't parse (Principle 1).
  const failed = new Map<Member, boolean>()
  const fails = (member: Member): boolean => {
    const known = failed.get(member)
    if (known !== undefined) return known
    failed.set(member, false)
    const result =
      member.error !== undefined ||
      member.requests.some((request) => !request.dynamic && request.target !== undefined && fails(request.target))
    failed.set(member, result)
    return result
  }
  const first = queue[0]!
  const pulled = queue.map((member) => member.source)
  if (fails(first)) return { failures, pulled }

  // The members the entry's static imports reach run at load, each after the modules it imports (ECMA-262
  // InnerModuleEvaluation), the entry last. The others run only when a dynamic import does.
  const loaded: Member[] = []
  const visiting = new Set<Member>()
  const visit = (member: Member) => {
    if (visiting.has(member)) return
    visiting.add(member)
    for (const request of member.requests) {
      if (!request.dynamic && request.target !== undefined) visit(request.target)
    }
    loaded.push(member)
  }
  visit(first)
  // A page's initial chunks run at load, after its entry, in URL order.
  for (const member of queue) if (member.chunk === 'initial' && member.error === undefined) visit(member)
  const isLoaded = new Set(loaded)
  const included = queue.filter((member) => !fails(member))
  const order = [...loaded, ...included.filter((member) => !isLoaded.has(member))]

  // The group's text, and each member's code shifted into it.
  let text = ''
  const bases = new Map<Member, number>()
  for (const member of order) {
    bases.set(member, text.length)
    if (text.length > 0) shift(member.program!, text.length)
    text += member.source.text
    if (member !== order.at(-1)) text += '\n'
  }
  const lines = new GroupLines(
    order.map((member) => {
      const { url, hash, origin } = member.source
      const base = bases.get(member)!
      const starts = lineStarts(member.source.text)
      return { url, hash, ...(origin === undefined ? {} : { origin }), base, length: member.source.text.length, starts }
    }),
  )
  const members = [first, ...order.filter((member) => member !== first)].map((member) => member.source)
  const unlinked = new Map<string, number>()
  for (const member of order) {
    const count = member.requests.filter((request) => request.target === undefined).length
    if (count > 0) unlinked.set(member.source.url, count)
  }

  if (order.length === 1) {
    const { program } = first
    return {
      group: {
        text,
        program: program!,
        sourceType: entry.sourceType,
        lines,
        members,
        failures,
        bound: () => undefined,
        wrappers: new Map(),
        loadedBy: new Map(),
        chunks: new Set(),
        unlinked,
        unlinkedBindings: unlinkedBindingsOf(order),
      },
      failures,
      pulled,
    }
  }

  // Each member other than the entry runs in a function of its own; its imports become declarations of that function.
  const sourceType = entry.sourceType
  const declarationOf = new Map<AstNode, AstNode>()
  const wrappers = new Map<AstNode, ArtifactSource>()
  const wrapperOf = new Map<Member, AstNode>()
  const body: AstNode[] = []
  for (const member of order) {
    if (member === first) {
      body.push(...member.statements)
      continue
    }
    const base = bases.get(member)!
    const end = base + member.source.text.length
    const span = { start: base, end, range: [base, end] }
    const statements = member.statements.map((statement) => {
      if (statement.type !== 'ImportDeclaration') return statement
      const specifiers = statement['specifiers'] as AstNode[]
      const at = { start: statement.start, end: statement.end, range: [statement.start, statement.end] }
      if (specifiers.length === 0) return { type: 'EmptyStatement', ...at }
      const declaration: AstNode = {
        type: 'VariableDeclaration',
        kind: 'let',
        declare: false,
        declarations: specifiers.map((specifier) => ({
          type: 'VariableDeclarator',
          id: specifier['local'],
          init: null,
          definite: false,
          start: specifier.start,
          end: specifier.end,
          range: [specifier.start, specifier.end],
        })),
        ...at,
      }
      declarationOf.set(statement, declaration)
      return declaration
    })
    // A module's code is strict mode code, wherever it sits.
    if (sourceType === 'script' && member.source.sourceType === 'module') {
      const at = { start: base, end: base, range: [base, base] }
      const literal = { type: 'Literal', value: 'use strict', raw: '"use strict"', ...at }
      statements.unshift({ type: 'ExpressionStatement', expression: literal, directive: 'use strict', ...at })
    }
    const wrapper: AstNode = {
      type: 'FunctionExpression',
      id: null,
      generator: false,
      async: false,
      params: [],
      body: { type: 'BlockStatement', body: statements, ...span },
      expression: false,
      ...span,
    }
    wrappers.set(wrapper, member.source)
    wrapperOf.set(member, wrapper)
    const expression: AstNode = isLoaded.has(member)
      ? { type: 'CallExpression', callee: wrapper, arguments: [], optional: false, ...span }
      : wrapper
    body.push({ type: 'ExpressionStatement', expression, ...span })
  }
  const entryProgram = first.program!
  const program: AstNode = {
    ...entryProgram,
    body,
    start: 0,
    end: text.length,
    range: [0, text.length],
  }

  // The `import(…)` calls that run each member only dynamic imports reach: those whose static graph holds it.
  const loadedBy = new Map<AstNode, AstNode[]>()
  for (const member of included) {
    for (const request of member.requests) {
      if (!request.dynamic || request.target === undefined || fails(request.target)) continue
      for (const runs of staticGraph(request.target)) {
        if (isLoaded.has(runs)) continue
        const wrapper = wrapperOf.get(runs)!
        const calls = loadedBy.get(wrapper)
        if (calls === undefined) loadedBy.set(wrapper, [request.node])
        else if (!calls.includes(request.node)) calls.push(request.node)
      }
    }
  }

  // Each import binding, by the declaration the binding-resolution seam gives it: the entry's import declaration, or the
  // declaration a member's import became.
  const bindings = new Map<AstNode, Map<string, Bound>>()
  for (const member of included) {
    for (const statement of member.statements) {
      if (statement.type !== 'ImportDeclaration') continue
      const request = member.requests.find((each) => each.node === statement)
      const names = new Map<string, Bound>()
      for (const specifier of statement['specifiers'] as AstNode[]) {
        const local = (specifier['local'] as AstNode)['name'] as string
        const imported = importedName(specifier)
        const target = request?.target
        const found =
          target === undefined || imported === undefined || fails(target) ? undefined : exported(target, imported, new Set())
        names.set(local, found ?? { declaration: statement, name: local })
      }
      bindings.set(member === first ? statement : (declarationOf.get(statement) ?? statement), names)
    }
  }

  return {
    group: {
      text,
      program,
      sourceType,
      lines,
      members,
      failures,
      bound: (declaration, name) => bindings.get(declaration)?.get(name),
      wrappers,
      loadedBy,
      chunks: new Set(order.filter((member) => member.chunk === 'lazy').map((member) => member.source.url)),
      unlinked,
      unlinkedBindings: unlinkedBindingsOf(order),
    },
    failures,
    pulled,
  }

  /** The included members a member's static imports reach, itself first. */
  function staticGraph(start: Member): Member[] {
    const seen = new Set<Member>([start])
    const list = [start]
    for (let index = 0; index < list.length; index++) {
      for (const request of list[index]!.requests) {
        const target = request.target
        if (request.dynamic || target === undefined || seen.has(target) || fails(target)) continue
        seen.add(target)
        list.push(target)
      }
    }
    return list
  }

  /** The variable a module exports as `name`, followed through re-exports (ECMA-262 ResolveExport). */
  function exported(module: Member, name: string, seen: Set<string>): Bound | undefined {
    const key = `${module.source.url} ${name}`
    if (seen.has(key)) return undefined
    seen.add(key)
    const targetOf = (statement: AstNode) => {
      const target = module.requests.find((request) => request.node === statement)?.target
      return target === undefined || fails(target) ? undefined : target
    }
    for (const statement of module.statements) {
      if (statement.type === 'ExportNamedDeclaration') {
        const declaration = statement['declaration'] as AstNode | null
        if (declaration !== null) {
          if (declares(declaration, name)) return { declaration, name }
          continue
        }
        for (const specifier of statement['specifiers'] as AstNode[]) {
          if (moduleExportName(specifier['exported'] as AstNode) !== name) continue
          const local = moduleExportName(specifier['local'] as AstNode)
          if (statement['source'] === null) return local === undefined ? undefined : declared(module, local, seen)
          const target = targetOf(statement)
          return target === undefined || local === undefined ? undefined : exported(target, local, seen)
        }
      } else if (statement.type === 'ExportDefaultDeclaration' && name === 'default') {
        const declaration = statement['declaration'] as AstNode
        if (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') {
          const id = declaration['id'] as AstNode | null
          return { declaration, name: id === null ? 'default' : (id['name'] as string) }
        }
        return declaration.type === 'Identifier' ? declared(module, declaration['name'] as string, seen) : undefined
      }
    }
    // `export *` re-exports every name but `default` (ECMA-262 GetExportedNames).
    if (name === 'default') return undefined
    for (const statement of module.statements) {
      if (statement.type !== 'ExportAllDeclaration' || statement['exported'] !== null) continue
      const target = targetOf(statement)
      const found = target === undefined ? undefined : exported(target, name, seen)
      if (found !== undefined) return found
    }
    return undefined
  }

  /** The variable a module's top level declares as `name`, or the one its import of that name is. */
  function declared(module: Member, name: string, seen: Set<string>): Bound | undefined {
    for (const statement of module.statements) {
      const declaration =
        statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration'
          ? (statement['declaration'] as AstNode | null)
          : statement
      if (declaration === null) continue
      if (declaration.type === 'ImportDeclaration') {
        for (const specifier of declaration['specifiers'] as AstNode[]) {
          if ((specifier['local'] as AstNode)['name'] !== name) continue
          const target = module.requests.find((request) => request.node === declaration)?.target
          const imported = importedName(specifier)
          if (target === undefined || fails(target) || imported === undefined) return undefined
          return exported(target, imported, seen)
        }
      } else if (declares(declaration, name)) return { declaration, name }
    }
    return undefined
  }
}

/** Whether a declaration statement declares `name`. */
function declares(declaration: AstNode, name: string): boolean {
  switch (declaration.type) {
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
      return (declaration['id'] as AstNode | null)?.['name'] === name
    case 'VariableDeclaration':
      return (declaration['declarations'] as AstNode[]).some((declarator) =>
        boundNames(declarator['id'] as AstNode).includes(name),
      )
    default:
      return false
  }
}

/** The name an import specifier imports: `default` for a default import, none for a namespace import. */
function importedName(specifier: AstNode): string | undefined {
  if (specifier.type === 'ImportDefaultSpecifier') return 'default'
  if (specifier.type !== 'ImportSpecifier') return undefined
  return moduleExportName(specifier['imported'] as AstNode)
}

/** A ModuleExportName: an identifier, or a string literal. */
function moduleExportName(node: AstNode): string | undefined {
  if (node.type === 'Identifier') return node['name'] as string
  return node.type === 'Literal' && typeof node['value'] === 'string' ? node['value'] : undefined
}

/**
 * The module requests of a program (§6 Module links): its static imports and re-exports, and its dynamic imports with a
 * literal specifier, in document order. A static request with a `type` attribute names a module that isn't JavaScript,
 * which is no link.
 */
function requestsOf(program: AstNode): Request[] {
  const requests: Request[] = []
  for (const statement of program['body'] as AstNode[]) {
    if (
      statement.type !== 'ImportDeclaration' &&
      statement.type !== 'ExportAllDeclaration' &&
      !(statement.type === 'ExportNamedDeclaration' && statement['source'] !== null)
    ) {
      continue
    }
    const attributes = (statement['attributes'] as AstNode[] | undefined) ?? []
    if (attributes.some((attribute) => moduleExportName(attribute['key'] as AstNode) === 'type')) continue
    const specifier = (statement['source'] as AstNode)['value'] as string
    requests.push({ node: statement, specifier, dynamic: false })
  }
  walkTree(program, {
    enter(node) {
      if (node.type !== 'ImportExpression') return
      const specifier = literalString(node['source'] as AstNode)
      if (specifier !== undefined) requests.push({ node, specifier, dynamic: true })
    },
  })
  return requests.sort((a, b) => a.node.start - b.node.start)
}

/** A string literal's value, or a template literal's with no substitutions. */
function literalString(node: AstNode): string | undefined {
  if (node.type === 'Literal') return typeof node['value'] === 'string' ? node['value'] : undefined
  if (node.type !== 'TemplateLiteral' || (node['expressions'] as AstNode[]).length > 0) return undefined
  return ((node['quasis'] as AstNode[])[0]!['value'] as { cooked: string | null }).cooked ?? undefined
}

/**
 * The import bindings of each member whose static import names no member of the group, by their import declaration and
 * name, each with the import declaration.
 */
function unlinkedBindingsOf(order: readonly Member[]): Map<AstNode, Map<string, AstNode>> {
  const found = new Map<AstNode, Map<string, AstNode>>()
  for (const member of order) {
    for (const request of member.requests) {
      if (request.target !== undefined || request.node.type !== 'ImportDeclaration') continue
      const names = new Map<string, AstNode>()
      for (const specifier of request.node['specifiers'] as AstNode[]) {
        names.set((specifier['local'] as AstNode)['name'] as string, request.node)
      }
      found.set(request.node, names)
    }
  }
  return found
}

/** Shifts every offset in a parsed tree by `by`: each object's `start`, `end` and `range`, once each. */
function shift(root: AstNode, by: number): void {
  const seen = new Set<object>()
  const stack: unknown[] = [root]
  while (stack.length > 0) {
    const value = stack.pop()
    if (typeof value !== 'object' || value === null || seen.has(value)) continue
    seen.add(value)
    if (Array.isArray(value)) {
      stack.push(...value)
      continue
    }
    if (value instanceof RegExp) continue
    const node = value as Record<string, unknown>
    if (typeof node['start'] === 'number') node['start'] = (node['start'] as number) + by
    if (typeof node['end'] === 'number') node['end'] = (node['end'] as number) + by
    const range = node['range']
    if (Array.isArray(range) && range.length === 2 && typeof range[0] === 'number') {
      node['range'] = [range[0] + by, (range[1] as number) + by]
      seen.add(node['range'] as object)
    }
    for (const key of Object.keys(node)) if (key !== 'range') stack.push(node[key])
  }
}

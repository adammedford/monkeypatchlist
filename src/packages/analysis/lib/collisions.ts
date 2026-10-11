// The scan-wide lexical-name check (§3 Declarations in classic scripts, §9 Mutation confidence). There is no
// evaluation-order modelling between scripts. Instead, per realm, the top-level `let`, `const` and `class` names of
// every classic script are collected, and a write in another script that reads one of those names bare keeps its
// finding with a `note` naming the declaring artifact:
// - a bare-identifier write of the name (`fetch = w`, `delete fetch`)
// - a write whose holder chain starts at the name (`Node.prototype.foo = f`, `var P = Promise; P.prototype.x = g`)
// An assignment to a name another script declares with `const` throws, so it also gets the mutation-confidence reason
// `const-collision`. Reading a `const` doesn't throw, so a holder chain through one doesn't. A redeclaration across
// scripts (a `declare` write of the name) is ignored.

import type { Realm, SerializedCatalog } from '../../../catalog.ts'
import { mutationConfidence, mutationReasons } from '../../confidence/index.ts'
import { globalHolder } from './global-object.ts'
import type {
  BindingStep,
  ConfidenceReasonStep,
  LexicalCollisionStep,
  LexicalDeclaration,
  RawOccurrence,
  TraceStep,
} from './types.ts'

/** An occurrence, with the realm of the group that found it. */
export interface RealmOccurrence {
  realm: Realm
  occurrence: RawOccurrence
}

/**
 * A classic script's top-level lexical declaration, with its realm, and `id`: the name its artifact's occurrences give
 * it, so that a script's own writes are never checked against its own declarations.
 */
export interface RealmDeclaration {
  realm: Realm
  id: string
  declaration: LexicalDeclaration
}

/**
 * Each occurrence, in the order given, with the scan-wide lexical-name check applied. The result depends only on the
 * set of declarations, never on the order artifacts are listed in: each occurrence's notes are sorted by the declaring
 * artifact and the declaration's place in it.
 */
export function lexicalCollisions(
  occurrences: readonly RealmOccurrence[],
  declarations: readonly RealmDeclaration[],
  catalog: SerializedCatalog,
): RawOccurrence[] {
  const byName = new Map<string, RealmDeclaration[]>()
  for (const declared of declarations) {
    const key = JSON.stringify([declared.realm, declared.declaration.name])
    const found = byName.get(key)
    if (found === undefined) byName.set(key, [declared])
    else found.push(declared)
  }
  for (const found of byName.values()) found.sort(inDeclarationOrder)
  if (byName.size === 0) return occurrences.map(({ occurrence }) => occurrence)

  return occurrences.map(({ realm, occurrence }) => {
    // A redeclaration across scripts is ignored.
    if (occurrence.mechanism === 'declare') return occurrence
    const global = globalHolder(catalog, realm)
    let throws: string | undefined
    let noted = false
    const trace: TraceStep[] = []
    for (const step of occurrence.trace) {
      trace.push(step)
      if (!isBareGlobalRead(step, realm)) continue
      const colliding = (byName.get(JSON.stringify([realm, step.name])) ?? []).filter(
        ({ id }) => id !== occurrence.artifact,
      )
      if (colliding.length === 0) continue
      noted = true
      trace.push(...colliding.map(({ declaration }) => noteStep(declaration)))
      const bareWrite = occurrence.target.name === `${global}.${step.name}`
      if (bareWrite && occurrence.mechanism === 'assign' && colliding.some(({ declaration }) => declaration.kind === 'const')) {
        throws ??= step.name
      }
    }
    if (!noted) return occurrence
    if (throws === undefined) return { ...occurrence, trace }
    const { target, mutation } = occurrence.confidence
    return {
      ...occurrence,
      confidence: { target, mutation: mutationConfidence([...mutation.reasons, 'const-collision']) },
      trace: [...trace, constCollisionStep(throws)],
    }
  })
}

/** A free name that resolved to no declaration, as the global object's property: a bare name read in global code. */
function isBareGlobalRead(step: TraceStep, realm: Realm): step is BindingStep {
  return (
    step.kind === 'binding' &&
    step.resolution === 'global' &&
    step.form === 'global-property' &&
    step.realm === realm &&
    step.realmInstance === 'current'
  )
}

function inDeclarationOrder(a: RealmDeclaration, b: RealmDeclaration): number {
  const x = a.declaration
  const y = b.declaration
  if (x.artifact !== y.artifact) return x.artifact < y.artifact ? -1 : 1
  if (a.id !== b.id) return a.id < b.id ? -1 : 1
  return x.generated.start - y.generated.start
}

function noteStep({ name, kind, artifact, generated }: LexicalDeclaration): LexicalCollisionStep {
  return {
    kind: 'note',
    about: 'lexical-collision',
    name,
    declaration: kind,
    artifact,
    generated,
    text:
      `${artifact} declares \`${name}\` with a top-level \`${kind}\` at ${generated.line}:${generated.column}, so when ` +
      `both scripts load, \`${name}\` here reaches that binding and not the global object's property`,
  }
}

function constCollisionStep(name: string): ConfidenceReasonStep {
  return {
    kind: 'confidence-reason',
    dimension: 'mutation',
    reason: 'const-collision',
    level: mutationReasons['const-collision'],
    name,
    text: `another classic script in the realm declares \`${name}\` with \`const\`, so assigning it most likely throws`,
  }
}

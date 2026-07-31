// src/cli/commands-schema.ts
//
// `hafez schema` — machine-readable lookup surface. Three forms:
//
//   hafez schema                 # list every op
//   hafez schema <op>            # full JSON schema for one op
//   hafez schema <op> --examples # working JSON examples per enum value
//
// Output is JSON by default. All data is derived from schema-introspect.ts.
// Unknown op names produce a did-you-mean error and exit non-zero.

import { HafezError } from '../types.js'
import { listOps, zodToJsonSchema, getOpExample, getEnumValues, getOpSchema, DIGEST_DESCRIPTION, type FieldSchema } from './schema-introspect.js'
import { didYouMean } from './batch-errors.js'

export async function cmdSchema(_os: unknown, args: string[]): Promise<string> {
  // args come in already-stripped of global flags; first positional is the op name (if any)
  const target = args[0]
  const wantExamples = args.includes('--examples')

  if (!target) {
    // Form 1 — list ops. Digest is appended by hand: it is a stdin pipe, not
    // a BatchOperationSchema branch, so listOps() deliberately excludes it.
    const ops = listOps().map(o => ({ name: o.name, op: o.op, kind: o.kind, description: o.description }))
    ops.push({ name: 'digest', op: 'digest', kind: undefined, description: DIGEST_DESCRIPTION })
    return JSON.stringify({ ops }, null, 2)
  }

  // Form 2 / 3 — single op
  const json = zodToJsonSchema(target)
  if (!json) {
    const names = [...listOps().map(o => o.name), 'digest']
    const suggestion = didYouMean(target, names)
    const hint = suggestion ? ` (did you mean "${suggestion}"?)` : ''
    throw new HafezError(
      'VALIDATION_FAILED',
      `Unknown op: "${target}"${hint}`,
      [`Available ops: ${names.join(', ')}`],
    )
  }

  if (!wantExamples) {
    return JSON.stringify(json, null, 2)
  }

  // Form 3 — include working examples, one per enum value on primary enums.
  const examples: Record<string, unknown>[] = []
  const base = getOpExample(target)
  if (base) examples.push(base)

  // Expand examples across each enum field in the op's fields tree.
  const opSchema = getOpSchema(target)
  if (opSchema && base) {
    for (const [enumPath, enumValues] of enumFieldsOf(target, opSchema.fields)) {
      // Skip literal fields (op, kind) — those are fixed for the branch.
      if (enumPath === 'op' || enumPath === 'kind') continue
      for (const v of enumValues) {
        const variant = structuredClone(base)
        setDottedValue(variant, enumPath, v)
        examples.push(variant)
      }
    }
  }

  return JSON.stringify({ schema: json, examples }, null, 2)
}

function* enumFieldsOf(
  _opName: string,
  fields: Record<string, FieldSchema>,
  prefix: string[] = [],
): Generator<[string, readonly string[]]> {
  for (const [k, f] of Object.entries(fields)) {
    const path = [...prefix, k]
    if (f.type === 'enum' && f.enum) {
      yield [path.join('.'), f.enum]
    } else if (f.type === 'object' && f.fields) {
      yield* enumFieldsOf(_opName, f.fields, path)
    }
  }
}

function setDottedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: any = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {}
    cur = cur[p]
  }
  cur[parts[parts.length - 1]] = value
}

// Re-export for consumers that want a direct enum lookup.
export { getEnumValues }

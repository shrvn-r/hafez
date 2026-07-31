// tests/cli-schema-parity.test.ts
//
// Phase 0 guarantee: every enum value ever rendered or validated comes from
// the canonical tuples in src/contracts.ts. This test has two jobs:
//
//   (a) Set-equality check between each z.enum(...) inside BatchOperationSchema
//       and its counterpart tuple in contracts.ts (order-independent).
//   (b) Grep-based check that no file outside src/contracts.ts re-declares these
//       tuples locally. Catches the re-introduction of drift by accident.
//
// If this test fails, Phase 0's "cannot drift" claim is no longer true — fix
// the drift rather than loosening the test.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  ENTITY_TYPES,
  ENTITY_STATUSES,
  SESSION_LOG_TYPES,
  CONFIDENCE_LEVELS,
  VALID_SUBTYPES,
} from '../src/contracts.js'
import {
  BatchOperationSchema,
  SessionLogSchema,
  UpdateFieldsSchema,
} from '../src/cli/commands.js'

// --- Helpers ---

function setsEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  const aSet = new Set(a)
  const bSet = new Set(b)
  if (aSet.size !== bSet.size) return false
  for (const v of aSet) if (!bSet.has(v)) return false
  return true
}

/** Extract literal values from a Zod v4 ZodEnum. */
function enumValues(schema: any): string[] {
  const def = schema?._def
  if (!def) return []
  if (def.entries && typeof def.entries === 'object') return Object.values(def.entries) as string[]
  if (Array.isArray(def.values)) return def.values as string[]
  if (Array.isArray(schema?.options)) return schema.options as string[]
  return []
}

/** Read the literal value of a Zod v4 ZodLiteral. `_def.values` is an array. */
function literalValue(schema: any): unknown {
  const vs = schema?._def?.values
  return Array.isArray(vs) ? vs[0] : schema?._def?.value
}

function shapeOf(schema: any): Record<string, any> {
  const def = schema?._def
  if (def?.shape && typeof def.shape === 'object') return def.shape
  if (schema?.shape) return schema.shape
  return {}
}

/**
 * Walk a Zod v4 discriminatedUnion tree looking for the first option (at any nesting
 * depth) whose `shape[key]` literal equals `literal`. If an option is itself a nested
 * union (type === 'union'), recurse into its options.
 */
function findBranchByLiteral(root: any, key: string, literal: string): any {
  const options = root?._def?.options ?? []
  for (const opt of options) {
    const type = opt?._def?.type
    if (type === 'object') {
      const shape = shapeOf(opt)
      const litField = shape[key]
      if (litField && literalValue(litField) === literal) return opt
    } else if (type === 'union') {
      const found = findBranchByLiteral(opt, key, literal)
      if (found) return found
    }
  }
  return null
}

/** Same, but only returns options (recursing into nested unions) — used to find a
 * nested discriminatedUnion itself by matching any of its branches against a literal. */
function findNestedUnion(root: any, key: string, literal: string): any {
  const options = root?._def?.options ?? []
  for (const opt of options) {
    const type = opt?._def?.type
    if (type === 'union') {
      // Check if any branch of this inner union has shape[key] === literal
      for (const inner of opt._def.options ?? []) {
        const shape = shapeOf(inner)
        if (literalValue(shape[key]) === literal) return opt
      }
    }
  }
  return null
}

// --- (a) Set-equality checks ---

describe('cli-schema-parity: BatchOperationSchema enums match contracts.ts tuples', () => {
  /** Unwrap ZodOptional / ZodNullable / ZodDefault to the innermost schema. */
  function unwrap(schema: any): any {
    let s = schema
    while (s?._def?.type === 'optional' || s?._def?.type === 'nullable' || s?._def?.type === 'default') {
      s = s._def.innerType
    }
    return s
  }

  it('SessionLogSchema.type matches SESSION_LOG_TYPES', () => {
    const shape = shapeOf(SessionLogSchema)
    expect(setsEqual(enumValues(unwrap(shape.type)), SESSION_LOG_TYPES)).toBe(true)
  })

  it('UpdateFieldsSchema.status matches ENTITY_STATUSES', () => {
    const shape = shapeOf(UpdateFieldsSchema)
    expect(setsEqual(enumValues(unwrap(shape.status)), ENTITY_STATUSES)).toBe(true)
  })

  it('UpdateFieldsSchema.confidence matches CONFIDENCE_LEVELS', () => {
    const shape = shapeOf(UpdateFieldsSchema)
    expect(setsEqual(enumValues(unwrap(shape.confidence)), CONFIDENCE_LEVELS)).toBe(true)
  })

  it('create/entity fields.type matches ENTITY_TYPES', () => {
    const createUnion = findNestedUnion(BatchOperationSchema, 'op', 'create')
    expect(createUnion).toBeTruthy()
    const entityBranch = findBranchByLiteral(createUnion, 'kind', 'entity')
    expect(entityBranch).toBeTruthy()
    const fieldsShape = shapeOf(unwrap(shapeOf(entityBranch).fields))
    expect(setsEqual(enumValues(unwrap(fieldsShape.type)), ENTITY_TYPES)).toBe(true)
  })

  it('create/knowledge fields.subtype matches VALID_SUBTYPES', () => {
    const createUnion = findNestedUnion(BatchOperationSchema, 'op', 'create')
    const knowledgeBranch = findBranchByLiteral(createUnion, 'kind', 'knowledge')
    expect(knowledgeBranch).toBeTruthy()
    const fieldsShape = shapeOf(unwrap(shapeOf(knowledgeBranch).fields))
    expect(setsEqual(enumValues(unwrap(fieldsShape.subtype)), VALID_SUBTYPES)).toBe(true)
  })

  it('link.relation matches [parent, related]', () => {
    const linkBranch = findBranchByLiteral(BatchOperationSchema, 'op', 'link')
    expect(linkBranch).toBeTruthy()
    expect(setsEqual(enumValues(unwrap(shapeOf(linkBranch).relation)), ['parent', 'related'])).toBe(true)
  })
})

// --- (b) Grep-based local-declaration check ---

describe('cli-schema-parity: no file outside src/contracts.ts re-declares canonical tuples', () => {
  const repoSrc = new URL('../src', import.meta.url).pathname
  const CONSTANT_NAMES = [
    'ENTITY_TYPES',
    'ENTITY_STATUSES',
    'SESSION_LOG_TYPES',
    'CONFIDENCE_LEVELS',
    'VALID_SUBTYPES',
  ]
  // Match "const NAME =" or "const NAME:" — declarations only, not imports or usages.
  const DECL_RE = new RegExp(
    `\\b(?:const|let|var)\\s+(${CONSTANT_NAMES.join('|')})\\s*[:=]`,
  )

  function walk(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry)
      const st = statSync(p)
      if (st.isDirectory()) {
        out.push(...walk(p))
      } else if (p.endsWith('.ts')) {
        out.push(p)
      }
    }
    return out
  }

  it('no declaration appears outside contracts.ts', () => {
    const offenders: string[] = []
    for (const file of walk(repoSrc)) {
      if (file.endsWith('/contracts.ts')) continue
      const body = readFileSync(file, 'utf-8')
      if (DECL_RE.test(body)) {
        offenders.push(relative(repoSrc, file))
      }
    }
    expect(offenders).toEqual([])
  })
})

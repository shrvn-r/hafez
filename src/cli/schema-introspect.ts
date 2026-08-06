// src/cli/schema-introspect.ts
//
// Single introspection surface that `help --agent`, `schema <op>`, and error
// formatters all read from. Walks the Zod v4 `BatchOperationSchema` tree to
// produce plain objects describing ops, fields, enums, and example payloads.
// The digest stdin pipe is introspected too (special-cased — it is not a
// batch op and stays out of listOps()).
//
// Hand-rolled walker (no zod-to-json-schema dependency). Supports the node
// types actually used in BatchOperationSchema plus a few forward-looking ones
// (`default`, `effects`, `union`) so the walker does not explode when the
// schema is extended.

import { z } from 'zod'
import {
  BatchOperationSchema,
  SessionLogSchema,
  UpdateFieldsSchema,
  OP_SPECS,
} from '../batch-ops.js'
import { DigestInputSchema } from '../digest.js'
import { ALIAS_KEYS } from '../contracts.js'

// --- Types ---

export interface FieldSchema {
  type: string                // 'string' | 'number' | 'boolean' | 'array' | 'object' | 'enum' | 'literal' | 'null' | 'unknown'
  optional?: boolean
  nullable?: boolean
  enum?: readonly string[]
  literal?: unknown
  items?: FieldSchema         // for arrays
  fields?: Record<string, FieldSchema>  // for nested objects
  description?: string
  strict?: boolean            // for objects
}

export interface OpSchema {
  op: string
  /** For create: kind name (entity | knowledge | session). Undefined for others. */
  kind?: string
  /** Top-level required/optional fields for the op body. */
  fields: Record<string, FieldSchema>
  strict: boolean
  description?: string
}

// --- Walker ---

/** Unwrap optional/nullable/default wrappers and mark the metadata on the result. */
function walk(node: any): FieldSchema {
  if (!node) return { type: 'unknown' }
  const def = node._def
  if (!def) return { type: 'unknown' }

  const type = def.type as string
  // Zod v4 stores .describe() text on the schema's registry-backed
  // `description` getter, not on _def — read both, _def first for
  // forward-compatibility.
  const description = def.description ?? node.description

  // Wrapper types — unwrap and annotate. A .describe() applied after the
  // wrapper lands on the wrapper node, so carry it down to the inner schema.
  if (type === 'optional') {
    const inner = walk(def.innerType)
    inner.optional = true
    inner.description ??= description
    return inner
  }
  if (type === 'nullable') {
    const inner = walk(def.innerType)
    inner.nullable = true
    inner.description ??= description
    return inner
  }
  if (type === 'default') {
    const inner = walk(def.innerType)
    inner.optional = true
    inner.description ??= description
    return inner
  }
  if (type === 'pipe' || type === 'effects' || type === 'transform' || type === 'readonly') {
    // Zod effects / transforms / pipes — descend to the inner schema.
    const inner = def.in ?? def.schema ?? def.innerType
    if (inner) return walk(inner)
  }

  // Leaf / container types.
  if (type === 'string') return { type: 'string', description }
  if (type === 'number') return { type: 'number', description }
  if (type === 'boolean') return { type: 'boolean', description }
  if (type === 'null') return { type: 'null' }
  if (type === 'any' || type === 'unknown') return { type: 'unknown' }

  if (type === 'literal') {
    const values = def.values
    const literal = Array.isArray(values) ? values[0] : def.value
    return { type: 'literal', literal }
  }

  if (type === 'enum') {
    const entries = def.entries
    const values = entries && typeof entries === 'object'
      ? (Object.values(entries) as string[])
      : (Array.isArray(def.values) ? (def.values as string[]) : [])
    return { type: 'enum', enum: values, description }
  }

  if (type === 'array') {
    const element = def.element ?? def.type
    return { type: 'array', items: walk(element), description }
  }

  if (type === 'object') {
    const rawShape = def.shape
    const shape: Record<string, any> = typeof rawShape === 'function' ? rawShape() : rawShape ?? {}
    const fields: Record<string, FieldSchema> = {}
    for (const [k, v] of Object.entries(shape)) fields[k] = walk(v)
    // Zod v4: strict objects use a catchall that throws on extra keys. For our
    // purposes we flag every object we emit as strict (we opt in explicitly on
    // all BatchOperationSchema objects) — the plan's error surface depends on it.
    return { type: 'object', fields, strict: true, description }
  }

  if (type === 'union') {
    // A plain z.union is uncommon in the current schema but possible. Return
    // the first option as a representative. The error formatter has specific
    // handling for union discriminators; introspection just needs shape.
    const first = def.options?.[0]
    if (first) return walk(first)
    return { type: 'unknown' }
  }

  return { type: 'unknown' }
}

// --- Branch discovery for the top-level schema ---

function topOptions(): any[] {
  return (BatchOperationSchema as any)._def.options ?? []
}

function shapeOf(obj: any): Record<string, any> {
  const rawShape = obj?._def?.shape
  return typeof rawShape === 'function' ? rawShape() : rawShape ?? {}
}

function literalOf(schema: any): unknown {
  const vs = schema?._def?.values
  return Array.isArray(vs) ? vs[0] : schema?._def?.value
}

function unwrapOptional(s: any): any {
  let cur = s
  while (cur?._def?.type === 'optional' || cur?._def?.type === 'nullable') cur = cur._def.innerType
  return cur
}

/**
 * Flatten the outer discriminatedUnion into a list of (op, kind?, branch) tuples.
 * Nested discriminatedUnion branches (type === 'union') are descended.
 */
interface BranchInfo { op: string; kind?: string; branch: any }

function enumerateBranches(): BranchInfo[] {
  const out: BranchInfo[] = []
  for (const opt of topOptions()) {
    if (opt?._def?.type === 'object') {
      const shape = shapeOf(opt)
      const op = literalOf(shape.op) as string
      out.push({ op, branch: opt })
    } else if (opt?._def?.type === 'union') {
      for (const inner of opt._def.options ?? []) {
        const shape = shapeOf(inner)
        const op = literalOf(shape.op) as string
        const kind = literalOf(shape.kind) as string | undefined
        out.push({ op, kind, branch: inner })
      }
    }
  }
  return out
}

// --- Public API ---

/**
 * List every op in canonical order. `create` is one entry per kind — so the
 * list has 8 entries, not 6. Each entry carries the display name the help
 * renderer uses in the op catalog.
 */
export interface OpCatalogEntry {
  op: string
  kind?: string
  /** Stable identifier used by `schema <name>`. `create-entity` / `update` / `link`. */
  name: string
  description: string
}

// --- Digest (stdin pipe, NOT a batch op) ---
//
// `hafez digest` reads its own JSON from stdin and prints a batch payload:
//   echo '<digest-json>' | hafez digest | hafez batch
// It is deliberately excluded from listOps() so the op catalog and batch
// examples never imply {"op":"digest"} is valid batch JSON. It still gets
// `hafez schema digest` via the special cases below.

export const DIGEST_DESCRIPTION =
  'Convert session-context JSON (stdin) into a batch payload. Not a batch op — pipe: echo \'<json>\' | hafez digest | hafez batch'

/** Canonical digest input example. The drift test asserts it parses against
 * DigestInputSchema, so it cannot silently diverge from the schema. */
export const DIGEST_EXAMPLE: Record<string, unknown> = {
  entities_touched: ['slug-1', 'slug-2'],
  decisions: ['Decision made'],
  narrative: 'One to three sentence cross-cutting summary.',
  session_date: '2026-01-15',
  agent: 'claude',
}

// Descriptions live in the Op Spec table (src/batch-ops.ts) — one row per op.
const OP_DESCRIPTIONS: Record<string, string> = Object.fromEntries(OP_SPECS.map(s => [s.name, s.description]))

export function listOps(): OpCatalogEntry[] {
  return enumerateBranches().map(({ op, kind }) => {
    const name = kind ? `${op}-${kind}` : op
    return { op, kind, name, description: OP_DESCRIPTIONS[name] ?? '' }
  })
}

/** Return the full introspected schema for a single op, by `name`. */
export function getOpSchema(name: string): OpSchema | null {
  if (name === 'digest') {
    const root = walk(DigestInputSchema)
    return {
      op: 'digest',
      fields: root.fields ?? {},
      strict: false,
      description: DIGEST_DESCRIPTION,
    }
  }
  for (const { op, kind, branch } of enumerateBranches()) {
    const n = kind ? `${op}-${kind}` : op
    if (n !== name) continue
    const shape = shapeOf(branch)
    const fields: Record<string, FieldSchema> = {}
    for (const [k, v] of Object.entries(shape)) fields[k] = walk(v)
    return {
      op,
      kind,
      fields,
      strict: true,
      description: OP_DESCRIPTIONS[n],
    }
  }
  return null
}

/**
 * Look up an enum's values by dotted path. Supported paths include:
 *   - 'update.fields.status'
 *   - 'update.fields.confidence'
 *   - 'update.fields.session_log.type'
 *   - 'create-entity.fields.type'
 *   - 'create-knowledge.fields.subtype'
 *   - 'link.relation'
 *
 * Returns `null` if the path does not resolve to an enum field.
 */
export function getEnumValues(path: string): readonly string[] | null {
  const parts = path.split('.')
  const opName = parts.shift()
  if (!opName) return null
  const opSchema = getOpSchema(opName)
  if (!opSchema) return null

  let cur: FieldSchema | undefined = { type: 'object', fields: opSchema.fields, strict: true }
  for (const part of parts) {
    if (!cur || cur.type !== 'object' || !cur.fields) return null
    cur = cur.fields[part]
  }
  if (!cur) return null
  if (cur.type === 'enum' && cur.enum) return cur.enum
  return null
}

/**
 * Build a minimal, valid-looking example payload for an op. Uses the first
 * enum value for enums, "<slug>"/"<name>"/"text" placeholders for strings,
 * 0 for numbers, empty arrays for arrays, and recurses for nested objects.
 * Optional fields are skipped unless they are the only way to make the
 * example illustrative (op / kind literals are always emitted).
 *
 * Aliased keys (per contracts.ts ALIAS_KEYS) are stripped from the output
 * so only canonical names appear in rendered help.
 */
export function getOpExample(name: string): Record<string, unknown> | null {
  if (name === 'digest') return structuredClone(DIGEST_EXAMPLE)
  const opSchema = getOpSchema(name)
  if (!opSchema) return null

  const opPath = name  // 'update' | 'create-entity' | ...
  const out: Record<string, unknown> = {}

  for (const [k, field] of Object.entries(opSchema.fields)) {
    const fullPath = `${opPath === 'update' ? 'update' : opPath}.${k}`
    if (shouldStrip(fullPath, k)) continue
    if (k === 'fields') {
      if (field.type === 'object' && field.fields) {
        const inner: Record<string, unknown> = {}
        for (const [fk, ff] of Object.entries(field.fields)) {
          const fp = aliasPathFor(opSchema.op, opSchema.kind, fk)
          if (shouldStrip(fp, fk)) continue
          // Skip most optional fields for minimalism, but always include the
          // primary discriminator-like fields (type for create-entity,
          // subtype for create-knowledge).
          const keepOptional = isDefaultIncluded(opSchema.op, opSchema.kind, fk)
          if (ff.optional && !keepOptional) continue
          inner[fk] = sampleValue(ff)
        }
        out[k] = inner
      }
      continue
    }
    if (field.type === 'literal') {
      out[k] = field.literal
      continue
    }
    if (!field.optional) {
      out[k] = sampleValue(field)
    }
  }
  return out
}

function aliasPathFor(op: string, kind: string | undefined, fieldKey: string): string {
  if (op === 'update') return `update.fields.${fieldKey}`
  if (op === 'create' && kind) return `create.${kind}.fields.${fieldKey}`
  return `${op}.${fieldKey}`
}

function shouldStrip(path: string, _key: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALIAS_KEYS, path)
}

function isDefaultIncluded(op: string, kind: string | undefined, fieldKey: string): boolean {
  // Example-inclusion hints live in the Op Spec table, one row per op.
  const spec = OP_SPECS.find(s => s.op === op && s.kind === kind)
  return spec ? spec.exampleInclude.includes(fieldKey) : false
}

function sampleValue(field: FieldSchema): unknown {
  switch (field.type) {
    case 'string': return 'text'
    case 'number': return 0
    case 'boolean': return true
    case 'null': return null
    case 'literal': return field.literal
    case 'enum': return field.enum?.[0] ?? 'value'
    case 'array': return field.items ? [sampleValue(field.items)] : []
    case 'object': {
      const o: Record<string, unknown> = {}
      if (field.fields) {
        for (const [k, f] of Object.entries(field.fields)) {
          if (f.optional) continue
          o[k] = sampleValue(f)
        }
      }
      return o
    }
    default: return null
  }
}

/**
 * Flatten an OpSchema to a JSON-schema-shaped plain object for the
 * `hafez schema <op>` command. Not full draft-7 — just a readable
 * structure agents can parse.
 */
export function zodToJsonSchema(name: string): Record<string, unknown> | null {
  const opSchema = getOpSchema(name)
  if (!opSchema) return null
  return {
    op: opSchema.op,
    kind: opSchema.kind,
    description: opSchema.description,
    fields: fieldsToJson(opSchema.fields),
  }
}

function fieldsToJson(fields: Record<string, FieldSchema>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, f] of Object.entries(fields)) out[k] = fieldToJson(f)
  return out
}

function fieldToJson(f: FieldSchema): Record<string, unknown> {
  const j: Record<string, unknown> = { type: f.type }
  if (f.optional) j.optional = true
  if (f.nullable) j.nullable = true
  if (f.enum) j.enum = f.enum
  if (f.literal !== undefined) j.literal = f.literal
  if (f.description) j.description = f.description
  if (f.type === 'array' && f.items) j.items = fieldToJson(f.items)
  if (f.type === 'object' && f.fields) j.fields = fieldsToJson(f.fields)
  return j
}

// Small re-exports so callers don't need to import from multiple places.
export { BatchOperationSchema, SessionLogSchema, UpdateFieldsSchema }

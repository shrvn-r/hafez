// tests/batch-ops-coverage.test.ts
// Replaces the cli-schema-parity/cli-schema-drift suites: with shape,
// semantics, description, and example hints all living in the Op Spec table
// (src/batch-ops.ts), the only drift left to guard is coverage — every op in
// the table must surface through introspection, help, and a valid example.
import { describe, it, expect } from 'vitest'
import { OP_SPECS, BatchOperationSchema } from '../src/batch-ops.js'
import { listOps, getOpSchema, getOpExample, DIGEST_EXAMPLE, type FieldSchema } from '../src/cli/schema-introspect.js'
import { DigestInputSchema, parseDigestInput } from '../src/digest.js'
import { ALIAS_KEYS } from '../src/contracts.js'

describe('Op Spec table coverage', () => {
  it('every spec has a description and appears in the op catalog', () => {
    const catalog = new Map(listOps().map(o => [o.name, o]))
    for (const spec of OP_SPECS) {
      expect(spec.description.length, `${spec.name} description`).toBeGreaterThan(0)
      const entry = catalog.get(spec.name)
      expect(entry, `${spec.name} missing from listOps()`).toBeDefined()
      expect(entry!.description).toBe(spec.description)
    }
  })

  it('the catalog contains nothing outside the table', () => {
    const names = new Set(OP_SPECS.map(s => s.name))
    for (const entry of listOps()) {
      expect(names.has(entry.name), `catalog entry ${entry.name} has no spec`).toBe(true)
    }
  })

  it('every spec introspects and its generated example parses against the union', () => {
    for (const spec of OP_SPECS) {
      expect(getOpSchema(spec.name), `${spec.name} schema introspection`).not.toBeNull()
      const example = getOpExample(spec.name)
      expect(example, `${spec.name} example`).not.toBeNull()
      const parsed = BatchOperationSchema.safeParse(example)
      expect(parsed.success, `${spec.name} example invalid: ${JSON.stringify(example)}`).toBe(true)
    }
  })

  it('every exampleInclude hint names a real field of that op', () => {
    for (const spec of OP_SPECS) {
      const schema = getOpSchema(spec.name)!
      const fieldsNode = schema.fields.fields
      const validKeys = new Set([
        ...Object.keys(schema.fields),
        ...(fieldsNode?.type === 'object' && fieldsNode.fields ? Object.keys(fieldsNode.fields) : []),
      ])
      for (const hint of spec.exampleInclude) {
        expect(validKeys.has(hint), `${spec.name} exampleInclude '${hint}' is not a field`).toBe(true)
      }
    }
  })

  it('the digest example parses against DigestInputSchema', () => {
    expect(DigestInputSchema.safeParse(DIGEST_EXAMPLE).success).toBe(true)
  })

  it('the digest example carries no unknown fields (strict parse)', () => {
    // Plain safeParse strips unknown keys — a stale key in the published
    // example would pass while warning at runtime for every agent copying it
    const result = parseDigestInput(DIGEST_EXAMPLE)
    expect(result.success).toBe(true)
    if (result.success) expect(result.unknownFields).toEqual([])
  })
})

// ALIAS_KEYS is hand-maintained: a field rename leaves an alias path stale and
// isAliasedKey silently stops stripping it from agent-facing output.
describe('ALIAS_KEYS entries resolve to real schema fields', () => {
  function walkField(fields: Record<string, FieldSchema>, parts: string[]): FieldSchema | null {
    let cur: FieldSchema | undefined = { type: 'object', fields, strict: true }
    for (const p of parts) {
      if (!cur || cur.type !== 'object' || !cur.fields) return null
      cur = cur.fields[p]
    }
    return cur ?? null
  }

  it('every key in ALIAS_KEYS points at a declared Zod field, and its canonical target exists beside it', () => {
    for (const [path, canonical] of Object.entries(ALIAS_KEYS)) {
      // path shape is "<opName>.fields.<field>" or "<op>.<kind>.fields.<field>"
      const parts = path.split('.')
      let opName = parts[0]
      let rest = parts.slice(1)
      if (rest[0] === 'knowledge' || rest[0] === 'session' || rest[0] === 'entity') {
        opName = `${opName}-${rest[0]}`
        rest = rest.slice(1)
      }
      const opSchema = getOpSchema(opName)
      expect(opSchema, `${path}: unknown op ${opName}`).not.toBeNull()
      expect(walkField(opSchema!.fields, rest), `${path}: aliased field missing`).not.toBeNull()
      expect(
        walkField(opSchema!.fields, [...rest.slice(0, -1), canonical]),
        `${path}: canonical field '${canonical}' missing`,
      ).not.toBeNull()
    }
  })
})

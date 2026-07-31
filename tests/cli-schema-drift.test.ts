// tests/cli-schema-drift.test.ts
//
// Parses the prompt-gate output via its <!-- SECTION --> markers and asserts
// that every enum value and op name in the generated sections came from
// schema-introspect.ts (not hardcoded prose). Catches accidental drift where
// someone hand-edits help-agent.ts instead of contracts.ts.
//
// Also verifies every key in ALIAS_KEYS resolves to a real field in the Zod
// schema (catches stale alias entries).

import { describe, it, expect } from 'vitest'
import { renderAgentHelp } from '../src/cli/help-agent.js'
import { listOps, getEnumValues, getOpSchema, DIGEST_EXAMPLE, BatchOperationSchema, type FieldSchema } from '../src/cli/schema-introspect.js'
import { parseDigestInput } from '../src/digest.js'
import { ALIAS_KEYS } from '../src/contracts.js'

function extractSection(output: string, name: string): string {
  const start = `<!-- SECTION:${name} -->`
  const end = `<!-- /SECTION:${name} -->`
  const s = output.indexOf(start)
  const e = output.indexOf(end)
  if (s === -1 || e === -1) throw new Error(`missing section ${name}`)
  return output.slice(s + start.length, e)
}

describe('cli-schema-drift: generated sections derive from schema-introspect', () => {
  const output = renderAgentHelp()

  it('op-catalog section lists every op returned by listOps()', () => {
    const catalog = extractSection(output, 'op-catalog')
    const schemaOps = new Set(listOps().map(o => o.name))
    for (const name of schemaOps) expect(catalog).toContain(name)
    // No unknown op names snuck in — iterate lines, for each `hafez schema <name>`
    // reference, confirm the <name> is in schemaOps.
    const matches = catalog.matchAll(/hafez schema (\S+)/g)
    for (const m of matches) {
      const name = m[1].replace(/[`.,)]+$/, '')
      // Skip placeholder tokens like `<name>` in header prose.
      if (name.startsWith('<')) continue
      expect(schemaOps.has(name)).toBe(true)
    }
  })

  it('critical-enums section values match schema-introspect exactly', () => {
    const enums = extractSection(output, 'critical-enums')
    const expected: Record<string, readonly string[]> = {
      'update.fields.status': getEnumValues('update.fields.status')!,
      'update.fields.session_log.type': getEnumValues('update.fields.session_log.type')!,
      'update.fields.confidence': getEnumValues('update.fields.confidence')!,
      'create-entity.fields.type': getEnumValues('create-entity.fields.type')!,
      'create-knowledge.fields.subtype': getEnumValues('create-knowledge.fields.subtype')!,
      'link.relation': getEnumValues('link.relation')!,
    }
    for (const [path, values] of Object.entries(expected)) {
      expect(enums).toContain(path)
      for (const v of values) expect(enums).toContain(v)
    }
  })
})

describe('cli-schema-drift: digest section derives from DigestInputSchema', () => {
  const output = renderAgentHelp()

  it('digest section lists every field of the digest schema', () => {
    const section = extractSection(output, 'digest')
    const schema = getOpSchema('digest')
    expect(schema).not.toBeNull()
    const fieldNames = Object.keys(schema!.fields)
    expect(fieldNames.length).toBeGreaterThan(0)
    for (const name of fieldNames) expect(section).toContain(name)
  })

  it('DIGEST_EXAMPLE parses against DigestInputSchema with no unknown fields', () => {
    const result = parseDigestInput(DIGEST_EXAMPLE)
    expect(result.success).toBe(true)
    if (result.success) expect(result.unknownFields).toEqual([])
  })

  it('every DIGEST_EXAMPLE key is a declared schema field', () => {
    const schema = getOpSchema('digest')!
    for (const key of Object.keys(DIGEST_EXAMPLE)) {
      expect(schema.fields[key]).toBeDefined()
    }
  })

  it('digest is NOT a batch op: absent from listOps, rejected by BatchOperationSchema', () => {
    // The whole design rests on this: the op catalog and batch examples must
    // never imply {"op":"digest"} is valid batch JSON.
    expect(listOps().map(o => o.name)).not.toContain('digest')
    const parsed = BatchOperationSchema.safeParse({ op: 'digest', slug: 'x', fields: {} })
    expect(parsed.success).toBe(false)
  })
})

describe('cli-schema-drift: ALIAS_KEYS entries resolve to real schema fields', () => {
  function walkField(fields: Record<string, FieldSchema>, parts: string[]): FieldSchema | null {
    let cur: FieldSchema | undefined = { type: 'object', fields, strict: true }
    for (const p of parts) {
      if (!cur || cur.type !== 'object' || !cur.fields) return null
      cur = cur.fields[p]
    }
    return cur ?? null
  }

  it('every key in ALIAS_KEYS points at a declared Zod field', () => {
    for (const path of Object.keys(ALIAS_KEYS)) {
      // path shape is "<opName>.fields.<field>" or "<op>.<kind>.fields.<field>".
      // First try the simple `<op>.fields.<field>` form.
      const parts = path.split('.')
      let opName = parts[0]
      let rest = parts.slice(1)
      if (rest[0] === 'knowledge' || rest[0] === 'session' || rest[0] === 'entity') {
        // create.<kind>.fields.<field>
        opName = `${opName}-${rest[0]}`
        rest = rest.slice(1)
      }
      const opSchema = getOpSchema(opName)
      expect(opSchema).not.toBeNull()
      const field = walkField(opSchema!.fields, rest)
      expect(field).not.toBeNull()
    }
  })
})

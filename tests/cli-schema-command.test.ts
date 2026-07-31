// tests/cli-schema-command.test.ts
//
// Smoke tests for the `hafez schema` subcommand in all three forms plus
// the unknown-op did-you-mean error path.

import { describe, it, expect } from 'vitest'
import { cmdSchema } from '../src/cli/commands-schema.js'
import { HafezError } from '../src/types.js'

async function run(args: string[]): Promise<string> {
  return cmdSchema(null, args)
}

describe('cmdSchema', () => {
  it('no args: returns JSON list of all ops', async () => {
    const out = JSON.parse(await run([]))
    expect(Array.isArray(out.ops)).toBe(true)
    const names = (out.ops as { name: string }[]).map(o => o.name)
    expect(names).toContain('update')
    expect(names).toContain('create-entity')
    expect(names).toContain('link')
    expect(names).toContain('digest')
  })

  it('digest: returns input schema with described fields', async () => {
    const out = JSON.parse(await run(['digest']))
    expect(out.op).toBe('digest')
    expect(out.description).toContain('Not a batch op')
    expect(out.fields.entities_touched).toBeDefined()
    expect(out.fields.entities_touched.type).toBe('array')
    expect(out.fields.narrative.type).toBe('string')
    expect(out.fields.narrative.description).toBeTruthy()
    expect(out.fields.decisions.optional).toBe(true)
  })

  it('digest with --examples: example is present', async () => {
    const out = JSON.parse(await run(['digest', '--examples']))
    expect(out.schema).toBeDefined()
    expect(out.examples.length).toBeGreaterThanOrEqual(1)
    expect(out.examples[0].session_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('single op: returns JSON schema with fields tree', async () => {
    const out = JSON.parse(await run(['update']))
    expect(out.op).toBe('update')
    expect(out.fields).toBeDefined()
    expect(out.fields.fields.fields.status).toBeDefined()
    expect(out.fields.fields.fields.status.type).toBe('enum')
    expect(out.fields.fields.fields.status.enum).toContain('active')
  })

  it('single op with --examples: includes an examples array', async () => {
    const out = JSON.parse(await run(['update', '--examples']))
    expect(out.schema).toBeDefined()
    expect(Array.isArray(out.examples)).toBe(true)
    expect(out.examples.length).toBeGreaterThanOrEqual(1)
    // Every example must parse as a valid-shaped update op with the right
    // literal.
    for (const ex of out.examples) expect(ex.op).toBe('update')
  })

  it('unknown op: throws HafezError with did-you-mean hint', async () => {
    try {
      await run(['updaet'])
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(HafezError)
      const lifeErr = err as HafezError
      expect(lifeErr.code).toBe('VALIDATION_FAILED')
      expect(lifeErr.message).toContain('Unknown op')
      expect(lifeErr.message).toContain('did you mean "update"')
    }
  })

  it('completely unrelated op: no did-you-mean, lists available', async () => {
    try {
      await run(['zzzzzz'])
      expect.fail('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(HafezError)
      const lifeErr = err as HafezError
      expect(lifeErr.message).toContain('Unknown op')
      expect(lifeErr.details?.[0]).toContain('Available ops')
    }
  })
})

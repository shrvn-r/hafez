// tests/cli-batch.test.ts
import { describe, it, expect } from 'vitest'
import { parseBatchInput } from '../src/cli/commands.js'
import { HafezError } from '../src/types.js'

describe('parseBatchInput', () => {
  it('parses a valid batch of updates', () => {
    const ops = parseBatchInput(JSON.stringify([
      { op: 'update', slug: 'foo', fields: { status: 'done' } },
      { op: 'update', slug: 'bar', fields: { add_action: 'Write tests' } },
    ]))
    expect(ops).toHaveLength(2)
    expect(ops[0]).toEqual({ op: 'update', slug: 'foo', fields: { status: 'done' } })
  })

  it('parses mixed operation types', () => {
    const ops = parseBatchInput(JSON.stringify([
      { op: 'update', slug: 'foo', fields: { status: 'active' } },
      { op: 'create', kind: 'entity', name: 'New Project', fields: { type: 'project' } },
      { op: 'capture', name: 'Quick note' },
      { op: 'link', slug: 'a', target: 'b', relation: 'related' },
      { op: 'unlink', slug: 'a', target: 'b', relation: 'related' },
      { op: 'create', kind: 'session', name: 'Session 2026-04-06 10:00:00' },
    ]))
    expect(ops).toHaveLength(6)
  })

  it('parses update with session_log', () => {
    const ops = parseBatchInput(JSON.stringify([
      { op: 'update', slug: 'foo', fields: {
        session_log: { type: 'progress', summary: 'Did stuff', agent: 'claude' },
      } },
    ]))
    expect(ops[0]).toEqual({
      op: 'update', slug: 'foo', fields: {
        session_log: { type: 'progress', summary: 'Did stuff', agent: 'claude' },
      },
    })
  })

  it('throws VALIDATION_FAILED on invalid JSON', () => {
    expect(() => parseBatchInput('not json')).toThrow(HafezError)
    try { parseBatchInput('not json') } catch (e) {
      expect((e as HafezError).code).toBe('VALIDATION_FAILED')
    }
  })

  it('throws VALIDATION_FAILED on non-array input', () => {
    expect(() => parseBatchInput('{"op":"update"}')).toThrow(HafezError)
    try { parseBatchInput('{"op":"update"}') } catch (e) {
      expect((e as HafezError).code).toBe('VALIDATION_FAILED')
      expect((e as HafezError).message).toContain('array')
    }
  })

  it('throws VALIDATION_FAILED on empty array', () => {
    expect(() => parseBatchInput('[]')).toThrow(HafezError)
    try { parseBatchInput('[]') } catch (e) {
      expect((e as HafezError).code).toBe('VALIDATION_FAILED')
      expect((e as HafezError).message).toContain('empty')
    }
  })

  it('throws VALIDATION_FAILED with index on schema violation', () => {
    const input = JSON.stringify([
      { op: 'update', slug: 'foo', fields: { status: 'active' } },
      { op: 'update', slug: 'bar' }, // missing fields
    ])
    expect(() => parseBatchInput(input)).toThrow(HafezError)
    try { parseBatchInput(input) } catch (e) {
      expect((e as HafezError).code).toBe('VALIDATION_FAILED')
      const err = e as HafezError
      expect(err.details).toBeDefined()
      expect(err.details?.join('\n')).toContain('index 1')
    }
  })

  it('throws VALIDATION_FAILED on unknown op', () => {
    const input = JSON.stringify([{ op: 'delete', slug: 'foo' }])
    expect(() => parseBatchInput(input)).toThrow(HafezError)
    try { parseBatchInput(input) } catch (e) {
      expect((e as HafezError).code).toBe('VALIDATION_FAILED')
      const err = e as HafezError
      expect(err.details?.join('\n')).toContain('index 0')
    }
  })

  it('parses create entity with brief and add_action', () => {
    const ops = parseBatchInput(JSON.stringify([
      { op: 'create', kind: 'entity', name: 'Test', fields: {
        type: 'project', brief: 'Context.', add_action: 'First task',
      } },
    ]))
    expect(ops).toHaveLength(1)
    const op = ops[0] as any
    expect(op.fields.brief).toBe('Context.')
    expect(op.fields.add_action).toBe('First task')
  })

  it('accepts knowledge metadata fields in batch update schema', () => {
    const ops = parseBatchInput(JSON.stringify([
      { op: 'update', slug: 'some-knowledge', fields: {
        domain: ['engineering', 'ai'],
        confidence: 'pattern',
        tags: ['testing'],
        related: ['other-slug'],
        insight: 'Updated insight text',
      } },
    ]))
    expect(ops).toHaveLength(1)
    const op = ops[0] as any
    expect(op.fields.domain).toEqual(['engineering', 'ai'])
    expect(op.fields.confidence).toBe('pattern')
    expect(op.fields.tags).toEqual(['testing'])
    // insight is aliased to synthesis during parsing
    expect(op.fields.synthesis).toBe('Updated insight text')
    expect(op.fields.insight).toBeUndefined()
  })

  it('accepts synthesis field directly in batch update schema', () => {
    const ops = parseBatchInput(JSON.stringify([
      { op: 'update', slug: 'some-knowledge', fields: {
        synthesis: 'Direct synthesis text',
        add_evidence: 'New evidence item',
        add_source: 'https://example.com',
      } },
    ]))
    expect(ops).toHaveLength(1)
    const op = ops[0] as any
    expect(op.fields.synthesis).toBe('Direct synthesis text')
    expect(op.fields.add_evidence).toBe('New evidence item')
    expect(op.fields.add_source).toBe('https://example.com')
  })

  it('synthesis takes precedence over insight when both are provided in batch', () => {
    const ops = parseBatchInput(JSON.stringify([
      { op: 'update', slug: 'some-knowledge', fields: {
        synthesis: 'Explicit synthesis',
        insight: 'Legacy insight',
      } },
    ]))
    expect(ops).toHaveLength(1)
    const op = ops[0] as any
    // synthesis already present, so insight alias should not overwrite it
    expect(op.fields.synthesis).toBe('Explicit synthesis')
  })

  it('accepts add_actions (plural) in batch update schema', () => {
    const ops = parseBatchInput(JSON.stringify([
      { op: 'update', slug: 'some-entity', fields: {
        add_actions: ['First action', 'Second action'],
      } },
    ]))
    expect(ops).toHaveLength(1)
    const op = ops[0] as any
    expect(op.fields.add_actions).toEqual(['First action', 'Second action'])
  })

  it('rejects invalid confidence value in update schema', () => {
    const input = JSON.stringify([
      { op: 'update', slug: 'foo', fields: { confidence: 'confirmed' } },
    ])
    expect(() => parseBatchInput(input)).toThrow(HafezError)
    try { parseBatchInput(input) } catch (e) {
      expect((e as HafezError).code).toBe('VALIDATION_FAILED')
    }
  })

  it('gives clear deprecation message for retired reinforce op', () => {
    const input = JSON.stringify([
      { op: 'reinforce', slug: 'some-knowledge', evidence: 'new data' },
    ])
    expect(() => parseBatchInput(input)).toThrow(HafezError)
    try { parseBatchInput(input) } catch (e) {
      expect((e as HafezError).code).toBe('VALIDATION_FAILED')
      const err = e as HafezError
      const blob = err.details?.join('\n') ?? ''
      expect(blob).toContain('reinforce')
      expect(blob).toContain('deprecated')
      expect(blob).toContain('add_evidence')
    }
  })

  // --- Phase 1: multi-error + did-you-mean + strict coverage ---

  it('unrecognized key on link op suggests "relation" for "kind"', () => {
    const input = JSON.stringify([
      { op: 'link', slug: 'foo', target: 'bar', kind: 'parent' },
    ])
    try { parseBatchInput(input) } catch (e) {
      const err = e as HafezError
      const blob = err.details?.join('\n') ?? ''
      expect(blob).toContain('unknown field')
      expect(blob).toContain('did you mean "relation"')
    }
  })

  it('invalid enum on session_log.type lists expected values', () => {
    const input = JSON.stringify([
      { op: 'update', slug: 'foo', fields: { session_log: { type: 'audit', summary: 's', agent: 'claude' } } },
    ])
    try { parseBatchInput(input) } catch (e) {
      const err = e as HafezError
      const blob = err.details?.join('\n') ?? ''
      expect(blob).toContain('progress')
      expect(blob).toContain('decision')
      expect(blob).toContain('blocker')
      expect(blob).toContain('research')
    }
  })

  it('typo in op reports unknown op with full op list', () => {
    const input = JSON.stringify([{ op: 'updaet', slug: 'foo', fields: { status: 'done' } }])
    try { parseBatchInput(input) } catch (e) {
      const err = e as HafezError
      const blob = err.details?.join('\n') ?? ''
      expect(blob).toContain('unknown op')
      expect(blob).toContain('update')
      expect(blob).toContain('create')
    }
  })

  it('multi-error: 3 ops each failing once returns 3 detail blocks', () => {
    const input = JSON.stringify([
      { op: 'update', slug: 'a', fields: { status: 'paaused' } }, // bad enum
      { op: 'link', slug: 'b', target: 'c', kind: 'parent' },     // unknown key
      { op: 'create', kind: 'entity', name: 'n', fields: { type: 'nope' } }, // bad enum
    ])
    try { parseBatchInput(input) } catch (e) {
      const err = e as HafezError
      expect(err.details).toBeDefined()
      expect(err.details!.length).toBe(3)
      const blob = err.details!.join('\n')
      expect(blob).toContain('index 0')
      expect(blob).toContain('index 1')
      expect(blob).toContain('index 2')
    }
  })

  it('multi-error: 1 op with 3 simultaneous issues returns 3 issues in one block', () => {
    const input = JSON.stringify([
      { op: 'update', slug: 'a', fields: { status: 'bad', confidence: 'bad', unknown_field: 'x' } },
    ])
    try { parseBatchInput(input) } catch (e) {
      const err = e as HafezError
      expect(err.details).toBeDefined()
      // Multi-issue within one op is concatenated into a single details entry
      // by formatBatchError, so details.length should be 1 but contain 3 blocks.
      expect(err.details!.length).toBe(1)
      const block = err.details![0]
      const issueCount = (block.match(/\[index 0\]/g) || []).length
      expect(issueCount).toBeGreaterThanOrEqual(3)
    }
  })

  it('insight → synthesis alias still normalizes post-refactor', () => {
    const ops = parseBatchInput(JSON.stringify([
      { op: 'update', slug: 'k', fields: { insight: 'note text' } },
    ]))
    const op = ops[0] as any
    expect(op.fields.synthesis).toBe('note text')
    expect(op.fields.insight).toBeUndefined()
  })
})

describe('parseBatchInput description/resource null-clear', () => {
  it('accepts null to clear description and resource on update', () => {
    const ops = parseBatchInput(JSON.stringify([
      { op: 'update', slug: 'x', fields: { description: null, resource: null } },
    ]))
    expect(ops).toHaveLength(1)
    expect((ops[0] as any).fields.description).toBeNull()
    expect((ops[0] as any).fields.resource).toBeNull()
  })
})

// tests/digest.test.ts
import { describe, it, expect } from 'vitest'
import { parseDigestInput, digest } from '../src/digest.js'
import type { BatchOperation } from '../src/types.js'

describe('parseDigestInput', () => {
  it('accepts valid input with all fields', () => {
    const result = parseDigestInput({
      entities_touched: ['simorgh', 'hafez'],
      decisions: ['Merged auth middleware'],
      narrative: 'Focused session on auth rewrite.',
      session_date: '2026-03-29',
      agent: 'claude',
    })
    expect(result.success).toBe(true)
  })

  it('accepts input with empty decisions', () => {
    const result = parseDigestInput({
      entities_touched: ['simorgh'],
      decisions: [],
      narrative: 'Some narrative',
      session_date: '2026-03-29',
    })
    expect(result.success).toBe(true)
  })

  it('accepts input with empty entities_touched', () => {
    const result = parseDigestInput({
      entities_touched: [],
      decisions: [],
      narrative: 'Some narrative',
      session_date: '2026-03-29',
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing narrative', () => {
    const result = parseDigestInput({
      entities_touched: ['simorgh'],
      decisions: [],
      session_date: '2026-03-29',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('narrative')
    }
  })

  it('rejects missing session_date', () => {
    const result = parseDigestInput({
      entities_touched: ['simorgh'],
      decisions: [],
      narrative: 'Some narrative',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('session_date')
    }
  })

  it('rejects missing entities_touched', () => {
    const result = parseDigestInput({
      decisions: [],
      narrative: 'Some narrative',
      session_date: '2026-03-29',
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('entities_touched')
    }
  })

  it('detects unknown fields via strict parse', () => {
    const result = parseDigestInput({
      entities_touched: [],
      decisions: [],
      narrative: 'Some narrative',
      session_date: '2026-03-29',
      unknown_field: 'oops',
    })
    // parsing still succeeds but unknown fields are detected
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.unknownFields).toContain('unknown_field')
    }
  })
})

describe('digest()', () => {
  const KNOWN_SLUGS = new Set(['simorgh', 'hafez', 'command-center'])
  const FIXED_NOW = new Date('2026-03-29T14:30:00Z')

  it('produces session log updates for each known slug', () => {
    const ops = digest(
      {
        entities_touched: ['simorgh', 'hafez'],
        decisions: ['Merged auth middleware'],
        narrative: 'Focused session on auth rewrite.',
        session_date: '2026-03-29',
        agent: 'claude',
      },
      KNOWN_SLUGS,
      FIXED_NOW,
    )

    const updates = ops.filter(o => o.op === 'update')
    const slugs = updates.map(o => (o as any).slug)
    expect(slugs).toContain('simorgh')
    expect(slugs).toContain('hafez')
  })

  it('session log entry type is progress', () => {
    const ops = digest(
      {
        entities_touched: ['simorgh'],
        decisions: [],
        narrative: 'Did some work.',
        session_date: '2026-03-29',
        agent: 'claude',
      },
      KNOWN_SLUGS,
      FIXED_NOW,
    )

    const update = ops.find(o => o.op === 'update' && (o as any).slug === 'simorgh') as any
    expect(update).toBeDefined()
    expect(update.fields.session_log.type).toBe('progress')
    expect(update.fields.session_log.agent).toBe('claude')
    expect(typeof update.fields.session_log.summary).toBe('string')
    expect(update.fields.session_log.summary.length).toBeGreaterThan(0)
  })

  it('session log entry uses the agent from input', () => {
    const ops = digest(
      {
        entities_touched: ['simorgh'],
        decisions: [],
        narrative: 'Did some work.',
        session_date: '2026-03-29',
        agent: 'custom-agent',
      },
      KNOWN_SLUGS,
      FIXED_NOW,
    )

    const update = ops.find(o => o.op === 'update' && (o as any).slug === 'simorgh') as any
    expect(update.fields.session_log.agent).toBe('custom-agent')
  })

  it('creates a session note with kind: session', () => {
    const ops = digest(
      {
        entities_touched: ['simorgh'],
        decisions: ['Deferred caching'],
        narrative: 'Auth rewrite session.',
        session_date: '2026-03-29',
        agent: 'claude',
      },
      KNOWN_SLUGS,
      FIXED_NOW,
    )

    const creates = ops.filter(o => o.op === 'create') as any[]
    const sessionNote = creates.find(o => o.kind === 'session')
    expect(sessionNote).toBeDefined()
    // Deterministic name with injected timestamp: "Session YYYY-MM-DD HH:MM:SS"
    expect(sessionNote.name).toBe('Session 2026-03-29 14:30:00')
    expect(sessionNote.fields['session-date']).toBe('2026-03-29')
  })

  it('session note body references narrative and decisions via synthesis field', () => {
    const ops = digest(
      {
        entities_touched: ['simorgh'],
        decisions: ['Deferred caching', 'Merged auth middleware'],
        narrative: 'Auth rewrite session.',
        session_date: '2026-03-29',
        agent: 'claude',
      },
      KNOWN_SLUGS,
      FIXED_NOW,
    )

    const creates = ops.filter(o => o.op === 'create') as any[]
    const sessionNote = creates.find(o => o.kind === 'session')
    // synthesis field carries the body content
    expect(sessionNote.fields.synthesis).toContain('Auth rewrite session.')
    expect(sessionNote.fields.synthesis).toContain('Deferred caching')
    expect(sessionNote.fields.synthesis).toContain('Merged auth middleware')
  })

  it('links session note to touched entities via related field', () => {
    const ops = digest(
      {
        entities_touched: ['simorgh', 'hafez'],
        decisions: [],
        narrative: 'Cross-cutting session.',
        session_date: '2026-03-29',
        agent: 'claude',
      },
      KNOWN_SLUGS,
      FIXED_NOW,
    )

    const creates = ops.filter(o => o.op === 'create') as any[]
    const sessionNote = creates.find(o => o.kind === 'session')
    expect(sessionNote.fields.related).toContain('simorgh')
    expect(sessionNote.fields.related).toContain('hafez')
  })

  it('includes all touched slugs in related (no cap)', () => {
    const manySlugs = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    const ops = digest(
      {
        entities_touched: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        decisions: [],
        narrative: 'Big session.',
        session_date: '2026-03-29',
        agent: 'claude',
      },
      manySlugs,
      FIXED_NOW,
    )

    const creates = ops.filter(o => o.op === 'create') as any[]
    const sessionNote = creates.find(o => o.kind === 'session')
    expect(sessionNote.fields.related.length).toBe(7)
  })

  it('skips unknown slugs in entity updates (creates note only)', () => {
    const ops = digest(
      {
        entities_touched: ['simorgh', 'does-not-exist'],
        decisions: [],
        narrative: 'Some session.',
        session_date: '2026-03-29',
        agent: 'claude',
      },
      KNOWN_SLUGS,
      FIXED_NOW,
    )

    const updates = ops.filter(o => o.op === 'update')
    const slugs = updates.map(o => (o as any).slug)
    expect(slugs).toContain('simorgh')
    expect(slugs).not.toContain('does-not-exist')
  })

  it('omits unknown slugs from the session note body too', () => {
    const ops = digest(
      {
        entities_touched: ['simorgh', 'does-not-exist'],
        decisions: [],
        narrative: 'Some session.',
        session_date: '2026-03-29',
        agent: 'claude',
      },
      KNOWN_SLUGS,
      FIXED_NOW,
    )

    const note = ops.find(o => o.op === 'create') as any
    expect(note.fields.synthesis).toContain('simorgh')
    expect(note.fields.synthesis).not.toContain('does-not-exist')
    expect(note.fields.related).toEqual(['simorgh'])
  })

  it('on empty entities_touched: creates only the session knowledge note, no updates', () => {
    const ops = digest(
      {
        entities_touched: [],
        decisions: ['Decided to rest'],
        narrative: 'Planning session with no specific entities.',
        session_date: '2026-03-29',
        agent: 'claude',
      },
      KNOWN_SLUGS,
      FIXED_NOW,
    )

    const updates = ops.filter(o => o.op === 'update')
    expect(updates).toHaveLength(0)
    const creates = ops.filter(o => o.op === 'create') as any[]
    expect(creates.some(o => o.kind === 'session')).toBe(true)
  })

  it('produces valid BatchOperation types', () => {
    const ops = digest(
      {
        entities_touched: ['simorgh'],
        decisions: [],
        narrative: 'Test.',
        session_date: '2026-03-29',
        agent: 'claude',
      },
      KNOWN_SLUGS,
      FIXED_NOW,
    )

    for (const op of ops) {
      expect(['update', 'create', 'capture', 'link', 'unlink', 'reinforce', 'promote']).toContain(op.op)
    }
  })
})

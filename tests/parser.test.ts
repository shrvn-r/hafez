// tests/parser.test.ts
import { describe, it, expect } from 'vitest'
import { parseSessionLogHeading, formatSessionLogEntry, parseSessionLog } from '../src/parser.js'

describe('parseSessionLogHeading', () => {
  it('parses v2 format with type tag', () => {
    const result = parseSessionLogHeading('### 2026-03-10 — Simorgh [progress]')
    expect(result).toEqual({ date: '2026-03-10', agent: 'Simorgh', type: 'progress' })
  })
  it('parses legacy format without type tag', () => {
    const result = parseSessionLogHeading('### 2026-03-10 — Claude Code')
    expect(result).toEqual({ date: '2026-03-10', agent: 'Claude Code', type: 'progress' })
  })
  it('parses legacy format with double-hyphen separator', () => {
    const result = parseSessionLogHeading('### 2026-03-02 -- Terminal (Claude Code direct)')
    expect(result).toEqual({ date: '2026-03-02', agent: 'Terminal (Claude Code direct)', type: 'progress' })
  })
  it('returns null for non-matching lines', () => {
    expect(parseSessionLogHeading('## Session Log')).toBeNull()
  })
})

describe('parseSessionLog', () => {
  it('parses standard session log entries', () => {
    const body = `## Brief

Some brief.

## Session Log

### 2026-03-29 — claude [progress]
Summary: Did the thing

### 2026-03-28 — parisa [decision]
Summary: Chose approach A
`
    const entries = parseSessionLog(body)
    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({ date: '2026-03-29', agent: 'claude', type: 'progress', summary: 'Did the thing' })
    expect(entries[1]).toEqual({ date: '2026-03-28', agent: 'parisa', type: 'decision', summary: 'Chose approach A' })
  })

  it('returns empty array when no Session Log section', () => {
    const body = '## Brief\n\nSome content.\n'
    expect(parseSessionLog(body)).toEqual([])
  })

  it('defaults type to progress when bracket omitted', () => {
    const body = `## Session Log

### 2026-03-29 — claude
Summary: No type bracket
`
    const entries = parseSessionLog(body)
    expect(entries).toHaveLength(1)
    expect(entries[0].type).toBe('progress')
  })

  it('handles empty Session Log section', () => {
    const body = '## Session Log\n\n'
    expect(parseSessionLog(body)).toEqual([])
  })

  it('skips entries without Summary line', () => {
    const body = `## Session Log

### 2026-03-29 — claude [progress]
Just some body text without Summary prefix.

### 2026-03-28 — claude [decision]
Summary: This one has a summary
`
    const entries = parseSessionLog(body)
    expect(entries).toHaveLength(1)
    expect(entries[0].date).toBe('2026-03-28')
  })
})

describe('formatSessionLogEntry', () => {
  it('formats a full entry', () => {
    const result = formatSessionLogEntry({
      type: 'decision',
      summary: 'Chose approach B',
      body: '- Evaluated 3 options\n- B won on simplicity',
      agent: 'Simorgh'
    })
    expect(result).toContain('[decision]')
    expect(result).toContain('Summary: Chose approach B')
    expect(result).toContain('- Evaluated 3 options')
  })
  it('formats entry without body', () => {
    const result = formatSessionLogEntry({ type: 'progress', summary: 'Did stuff', agent: 'Claude' })
    expect(result).not.toContain('undefined')
    expect(result).toContain('Summary: Did stuff')
  })
})

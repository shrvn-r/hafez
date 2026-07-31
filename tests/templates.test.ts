import { describe, it, expect } from 'vitest'
import { bodyTemplate, knowledgeBodyTemplate } from '../src/templates.js'

describe('bodyTemplate', () => {
  it('capture: renders Notes section', () => {
    const result = bodyTemplate('capture')
    expect(result).toContain('## Notes')
  })

  it('capture: injects notes field content', () => {
    const result = bodyTemplate('capture', { notes: 'quick thought' })
    expect(result).toContain('## Notes')
    expect(result).toContain('quick thought')
  })

  it('entity: renders Context and Session Log sections', () => {
    const result = bodyTemplate('entity')
    expect(result).toContain('## Context')
    expect(result).toContain('## Session Log')
  })

  it('entity: does not inject notes into Context', () => {
    const result = bodyTemplate('entity', { notes: 'should not appear' })
    expect(result).not.toContain('should not appear')
  })

  it('project: renders Purpose, Goals, Session Log sections', () => {
    const result = bodyTemplate('project')
    expect(result).toContain('## Purpose')
    expect(result).toContain('## Goals')
    expect(result).toContain('## Session Log')
  })

  it('project: injects purpose field content', () => {
    const result = bodyTemplate('project', { purpose: 'to build something great' })
    expect(result).toContain('## Purpose')
    expect(result).toContain('to build something great')
  })

  it('project: sections appear in order: Purpose, Goals, Session Log', () => {
    const result = bodyTemplate('project')
    const purposeIdx = result.indexOf('## Purpose')
    const goalsIdx = result.indexOf('## Goals')
    const logIdx = result.indexOf('## Session Log')
    expect(purposeIdx).toBeLessThan(goalsIdx)
    expect(goalsIdx).toBeLessThan(logIdx)
  })
})

describe('knowledgeBodyTemplate', () => {
  it('defaults to insight subtype when none given', () => {
    const result = knowledgeBodyTemplate()
    expect(result).toContain('## Synthesis')
    expect(result).toContain('## Evidence')
    expect(result).toContain('## Sources')
  })

  it('insight: renders Synthesis, Evidence, and Sources sections', () => {
    const result = knowledgeBodyTemplate('insight')
    expect(result).toContain('## Synthesis')
    expect(result).toContain('## Evidence')
    expect(result).toContain('## Sources')
  })

  it('insight: does not render ## Insight heading', () => {
    const result = knowledgeBodyTemplate('insight')
    expect(result).not.toContain('## Insight')
  })

  it('produces Synthesis section for insight subtype', () => {
    const body = knowledgeBodyTemplate('insight', { synthesis: 'Test content' })
    expect(body).toContain('## Synthesis')
    expect(body).toContain('Test content')
    expect(body).not.toContain('## Insight')
  })

  it('produces Sources section for insight subtype', () => {
    const body = knowledgeBodyTemplate('insight')
    expect(body).toContain('## Sources')
  })

  it('insight: injects synthesis field content', () => {
    const result = knowledgeBodyTemplate('insight', { synthesis: 'key learning here' })
    expect(result).toContain('## Synthesis')
    expect(result).toContain('key learning here')
  })

  it('session subtype throws error', () => {
    expect(() => knowledgeBodyTemplate('session' as any)).toThrow("subtype 'session' is no longer supported")
  })

  it('plan: renders Goal, Steps, Dependencies sections', () => {
    const result = knowledgeBodyTemplate('plan')
    expect(result).toContain('## Goal')
    expect(result).toContain('## Steps')
    expect(result).toContain('## Dependencies')
  })
})

// tests/schema.test.ts
import { describe, it, expect } from 'vitest'
import { validateEntityFrontmatter, validateKnowledgeFrontmatter, validateSlugReference } from '../src/schema.js'

describe('validateEntityFrontmatter', () => {
  it('passes for valid entity', () => {
    const errors = validateEntityFrontmatter({
      name: 'Test', type: 'project', status: 'active',
      created: '2026-03-10', 'last-touched': '2026-03-10'
    })
    expect(errors).toEqual([])
  })
  it('fails for missing name', () => {
    const errors = validateEntityFrontmatter({ type: 'project', status: 'active', created: '2026-03-10', 'last-touched': '2026-03-10' })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]).toContain('name')
  })
  it('fails for invalid status', () => {
    const errors = validateEntityFrontmatter({ name: 'T', type: 'project', status: 'invalid', created: '2026-03-10', 'last-touched': '2026-03-10' })
    expect(errors.some(e => e.includes('status'))).toBe(true)
  })
  it('accepts capture type', () => {
    const errors = validateEntityFrontmatter({ name: 'T', type: 'capture', status: 'active', created: '2026-03-10', 'last-touched': '2026-03-10' })
    expect(errors).toEqual([])
  })
})


describe('validateSlugReference', () => {
  it('fails for non-existent slug', () => {
    const check = (slug: string) => false
    expect(validateSlugReference('bad-slug', 'parent', check)).toContain('does not exist')
  })
  it('passes for existing slug', () => {
    const check = (slug: string) => true
    expect(validateSlugReference('good-slug', 'parent', check)).toBeNull()
  })
})

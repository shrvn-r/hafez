import { describe, it, expect } from 'vitest'
import { getContract, ALL_CONTRACTS, hasCapability } from '../src/contracts.js'

describe('contracts', () => {
  it('returns capture contract', () => {
    const c = getContract('capture')
    expect(c.type).toBe('capture')
    expect(c.kind).toBe('item')
    expect(c.validStatuses).toEqual(['active', 'done'])
    expect(c.canPromoteTo).toContain('entity')
    expect(c.canPromoteTo).toContain('project')
    expect(c.canPromoteTo).toContain('knowledge')
  })

  it('returns entity contract', () => {
    const c = getContract('entity')
    expect(c.type).toBe('entity')
    expect(c.kind).toBe('item')
    expect(c.validStatuses).toEqual(['active', 'paused', 'done'])
    expect(c.defaultSections).toContain('Context')
    expect(c.defaultSections).toContain('Session Log')
    expect(c.canPromoteTo).toEqual(['project'])
  })

  it('returns project contract', () => {
    const c = getContract('project')
    expect(c.kind).toBe('item')
    expect(c.defaultSections).toContain('Purpose')
    expect(c.defaultSections).toContain('Goals')
    expect(c.canPromoteTo).toEqual([])
  })

  it('returns knowledge contract', () => {
    const c = getContract('knowledge')
    expect(c.kind).toBe('knowledge')
    expect(c.canPromoteTo).toEqual([])
  })

  it('throws on invalid type', () => {
    expect(() => getContract('thread' as any)).toThrow()
  })

  it('hasCapability checks optional sections', () => {
    expect(hasCapability('entity', 'Next Actions')).toBe(true)
    expect(hasCapability('capture', 'Next Actions')).toBe(true)
    expect(hasCapability('capture', 'Goals')).toBe(false)
    expect(hasCapability('project', 'Goals')).toBe(true)
  })

  it('exports all 4 contracts', () => {
    expect(ALL_CONTRACTS).toHaveLength(4)
    const types = ALL_CONTRACTS.map(c => c.type)
    expect(types).toEqual(['capture', 'entity', 'project', 'knowledge'])
  })
})

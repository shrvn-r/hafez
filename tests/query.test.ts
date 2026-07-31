// tests/query.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { queryEntities, queryChildren, queryRelatedTo, queryKnowledge, queryUnified } from '../src/query.js'
import { createIndex, type HafezIndex } from '../src/db.js'
import { serializeFile } from '../src/vault.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { EntityQueryOpts, UnifiedResult } from '../src/types.js'

const TMP = join(tmpdir(), 'hafez-test-query-' + Date.now())

function writeEntity(slug: string, fm: Record<string, any>, body = '') {
  writeFileSync(join(TMP, 'entities', `${slug}.md`), serializeFile(fm, body || '## Purpose\n\n## Session Log\n'))
}

function writeKnowledge(slug: string, fm: Record<string, any>, body = '') {
  writeFileSync(join(TMP, 'knowledge', `${slug}.md`), serializeFile(fm, body || '## Insight\n\n## Evidence\n'))
}

const today = new Date().toISOString().slice(0, 10)
const daysAgo = (n: number) => {
  const d = new Date(); d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

let index: HafezIndex

beforeAll(() => {
  mkdirSync(join(TMP, 'entities'), { recursive: true })
  mkdirSync(join(TMP, 'knowledge'), { recursive: true })

  writeEntity('simorgh', { name: 'Simorgh', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': today, description: 'Autonomous agent project', resource: 'https://github.com/org/simorgh' })
  writeEntity('dashboard', { name: 'Dashboard', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': daysAgo(20), parent: 'simorgh' })
  writeEntity('hafez', { name: 'Hafez', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': daysAgo(35) })
  writeEntity('old-idea', { name: 'Old Idea', type: 'entity', status: 'paused', created: '2025-01-01', 'last-touched': '2025-06-01' })
  writeEntity('done-thing', { name: 'Done Thing', type: 'project', status: 'done', created: '2025-01-01', 'last-touched': '2025-12-01' })
  writeEntity('custom-stale', { name: 'Custom Stale', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': daysAgo(10), 'staleness-days': 7 })
  writeEntity('inbox-item', { name: 'Inbox Item', type: 'capture', status: 'active', created: today, 'last-touched': today })
  writeEntity('child-one', { name: 'Child One', type: 'entity', status: 'active', created: today, 'last-touched': today, parent: 'simorgh', related: ['dashboard'] })
  writeEntity('proj-a', { name: 'Proj A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': today, tags: ['infra', 'api'] })

  writeKnowledge('tdd-pattern', { name: 'TDD Pattern', domain: ['engineering'], confidence: 'pattern', created: '2026-01-01', 'reinforcement-count': 3, related: ['simorgh'], description: 'Write tests first' })
  writeKnowledge('new-obs', { name: 'New Observation', domain: ['ai'], confidence: 'observation', created: today, 'reinforcement-count': 0 })
  writeKnowledge('orphan-note', { name: 'Orphan Note', domain: ['misc'], confidence: 'observation', created: today, 'reinforcement-count': 0 })

  index = createIndex(TMP)
})

afterAll(() => {
  index.close()
  rmSync(TMP, { recursive: true, force: true })
})

describe('queryEntities', () => {
  it('returns only active entities for active filter', () => {
    const { items: results } = queryEntities(index, { filter: 'active' })
    expect(results.every(r => r.status === 'active')).toBe(true)
    expect(results.some(r => r.slug === 'simorgh')).toBe(true)
    expect(results.some(r => r.slug === 'old-idea')).toBe(false)
  })

  it('returns stale active entities past 14-day threshold', () => {
    const { items: results } = queryEntities(index, { filter: 'stale' })
    expect(results.some(r => r.slug === 'dashboard')).toBe(true)  // 20 days > 14
    expect(results.some(r => r.slug === 'simorgh')).toBe(false)   // touched today
  })

  it('respects custom staleness-days on entity', () => {
    const { items: results } = queryEntities(index, { filter: 'stale' })
    expect(results.some(r => r.slug === 'custom-stale')).toBe(true)  // 10 days > 7 custom
  })

  it('includes active entities past 14-day threshold in stale results', () => {
    const { items: results } = queryEntities(index, { filter: 'stale' })
    expect(results.some(r => r.slug === 'hafez')).toBe(true)  // 35 days > 14
  })

  it('filters by type', () => {
    const { items: results } = queryEntities(index, { type: 'project' })
    expect(results.every(r => r.type === 'project')).toBe(true)
  })

  it('filters by parent', () => {
    const { items: results } = queryEntities(index, { parent: 'simorgh' })
    expect(results.every(r => r.parent === 'simorgh')).toBe(true)
    expect(results.length).toBe(2) // dashboard + child-one
  })

  it('returns only capture entities for capture filter', () => {
    const { items: results } = queryEntities(index, { filter: 'capture' })
    expect(results.every(r => r.type === 'capture')).toBe(true)
    expect(results.length).toBe(1)
  })

  it('returns all entities for all filter', () => {
    const { items: results } = queryEntities(index, { filter: 'all' })
    expect(results.length).toBe(9)
  })
})

describe('queryChildren', () => {
  it('returns entities where parent matches slug', () => {
    const { items: results } = queryChildren(index, 'simorgh')
    expect(results.length).toBe(2)
    expect(results.some(r => r.slug === 'dashboard')).toBe(true)
    expect(results.some(r => r.slug === 'child-one')).toBe(true)
  })
})

describe('queryRelatedTo', () => {
  it('returns entities and knowledge where related contains slug', () => {
    const { items: results } = queryRelatedTo(index, 'simorgh')
    expect(results.some(r => r.slug === 'tdd-pattern')).toBe(true)
  })

  it('returns entities with related containing slug', () => {
    const { items: results } = queryRelatedTo(index, 'dashboard')
    expect(results.some(r => r.slug === 'child-one')).toBe(true)
  })
})

describe('queryKnowledge', () => {
  it('filters by domain', () => {
    const { items: results } = queryKnowledge(index, { domain: 'engineering' })
    expect(results.length).toBe(1)
    expect(results[0].slug).toBe('tdd-pattern')
  })

  it('filters by confidence', () => {
    const { items: results } = queryKnowledge(index, { confidence: 'observation' })
    expect(results.every(r => r.confidence === 'observation')).toBe(true)
    expect(results.length).toBe(2)
  })
})

describe('queryEntities options object', () => {
  it('accepts options object', () => {
    const { items: results } = queryEntities(index, { filter: 'active' })
    expect(results.every(r => r.status === 'active')).toBe(true)
  })

  it('passes time filters through', () => {
    const { items: results } = queryEntities(index, { since: today })
    expect(results.every(r => r.last_touched >= today)).toBe(true)
  })

  it('filters by domain', () => {
    writeEntity('domain-test', {
      name: 'Domain Test', type: 'project', status: 'active',
      domain: ['engineering'], created: today, 'last-touched': today,
    })
    index.syncIfStale()
    const { items: results } = queryEntities(index, { domain: 'engineering' })
    expect(results.some(r => r.slug === 'domain-test')).toBe(true)
  })

  it('rejects invalid date format', () => {
    expect(() => queryEntities(index, { since: 'last Tuesday' })).toThrow()
    expect(() => queryEntities(index, { before: '2026/03/25' })).toThrow()
    expect(() => queryEntities(index, { createdSince: '' })).toThrow()
  })

  it('returns all entities when called with no args', () => {
    const { items: results } = queryEntities(index)
    expect(results.length).toBeGreaterThan(0)
  })
})

describe('queryEntities tag filter', () => {
  it('forwards tags to queryItems', () => {
    const { items: results } = queryEntities(index, { tags: ['infra'] })
    expect(results.length).toBe(1)
    expect(results[0].slug).toBe('proj-a')
  })
})

describe('queryEntities return shape', () => {
  it('returns { items, total } object', () => {
    const result = queryEntities(index, { filter: 'active' })
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('total')
    expect(Array.isArray(result.items)).toBe(true)
    expect(typeof result.total).toBe('number')
  })

  it('passes sort_by through to queryItems', () => {
    const result = queryEntities(index, { filter: 'all', sort_by: 'name', sort_order: 'asc' })
    expect(result.items.length).toBeGreaterThan(0)
    // Verify sorted by name ascending
    const names = result.items.map(r => r.name)
    const sorted = [...names].sort()
    expect(names).toEqual(sorted)
  })

  it('passes limit through to queryItems', () => {
    const all = queryEntities(index, { filter: 'all' })
    const limited = queryEntities(index, { filter: 'all', limit: 2 })
    expect(limited.items.length).toBe(2)
    expect(limited.total).toBe(all.total) // total is unbounded count
  })

  it('total matches items length when no limit applied', () => {
    const result = queryEntities(index, { filter: 'active' })
    expect(result.total).toBe(result.items.length)
  })
})

describe('queryKnowledge return shape', () => {
  it('returns { items, total } object', () => {
    const result = queryKnowledge(index)
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('total')
    expect(Array.isArray(result.items)).toBe(true)
    expect(typeof result.total).toBe('number')
  })

  it('passes sort_by through', () => {
    const result = queryKnowledge(index, { sort_by: 'name', sort_order: 'asc' })
    expect(result.items.length).toBeGreaterThan(0)
    const names = result.items.map(r => r.name)
    const sorted = [...names].sort()
    expect(names).toEqual(sorted)
  })

  it('filters by domain via options object', () => {
    const result = queryKnowledge(index, { domain: 'engineering' })
    expect(result.items.every(r => r.domain.includes('engineering'))).toBe(true)
    expect(result.total).toBe(result.items.length)
  })

  it('passes limit through', () => {
    const all = queryKnowledge(index)
    const limited = queryKnowledge(index, { limit: 1 })
    expect(limited.items.length).toBe(1)
    expect(limited.total).toBe(all.total)
  })
})

describe('queryChildren return shape', () => {
  it('returns { items, total } object', () => {
    const result = queryChildren(index, 'simorgh')
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('total')
    expect(Array.isArray(result.items)).toBe(true)
    expect(typeof result.total).toBe('number')
    expect(result.items.length).toBe(2)
    expect(result.total).toBe(2)
  })
})

describe('queryRelatedTo return shape', () => {
  it('returns { items, total } object', () => {
    const result = queryRelatedTo(index, 'simorgh')
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('total')
    expect(Array.isArray(result.items)).toBe(true)
    expect(typeof result.total).toBe('number')
    expect(result.items.some(r => r.slug === 'tdd-pattern')).toBe(true)
  })
})

describe('unified query (kind: all)', () => {
  it('returns both entities and knowledge in a flat list', () => {
    const result = queryUnified(index, { kind: 'all', filter: 'all' })
    expect(result).toHaveProperty('items')
    expect(result).toHaveProperty('total')
    const hasEntity = result.items.some(i => i.kind === 'entity')
    const hasKnowledge = result.items.some(i => i.kind === 'knowledge')
    expect(hasEntity).toBe(true)
    expect(hasKnowledge).toBe(true)
  })

  it('applies single limit across both kinds', () => {
    const all = queryUnified(index, { kind: 'all', filter: 'all' })
    const limited = queryUnified(index, { kind: 'all', filter: 'all', limit: 3 })
    expect(limited.items.length).toBe(3)
    expect(limited.total).toBe(all.total) // total is unbounded
  })

  it('sorts across kinds by last_touched descending by default', () => {
    const result = queryUnified(index, { kind: 'all', filter: 'all', sort_by: 'last_touched', sort_order: 'desc' })
    const dates = result.items.map(i => {
      if (i.kind === 'entity') return (i as any).last_touched ?? '0000-00-00'
      return '0000-00-00' // knowledge may not have last_touched
    })
    // Spot check: no earlier date should come before a later date among entity items
    const entityItems = result.items.filter(i => i.kind === 'entity') as any[]
    const entityDates = entityItems.map(i => i.last_touched)
    for (let j = 0; j < entityDates.length - 1; j++) {
      expect(entityDates[j] >= entityDates[j + 1]).toBe(true)
    }
  })

  it('has kind discriminator for type narrowing', () => {
    const result = queryUnified(index, { kind: 'all', filter: 'all' })
    for (const item of result.items) {
      expect(['entity', 'knowledge']).toContain(item.kind)
      if (item.kind === 'entity') {
        const typed = item as UnifiedResult & { kind: 'entity' }
        expect(typed).toHaveProperty('status')
        expect(typed).toHaveProperty('type')
      } else {
        const typed = item as UnifiedResult & { kind: 'knowledge' }
        expect(typed).toHaveProperty('confidence')
        expect(typed).toHaveProperty('domain')
      }
    }
  })

  it('respects domain filter across kinds', () => {
    const result = queryUnified(index, { kind: 'all', filter: 'all', domain: 'engineering' })
    // Should include the entity with domain=engineering and the knowledge with domain=['engineering']
    const slugs = result.items.map(i => i.slug)
    expect(slugs).toContain('tdd-pattern')
    expect(slugs).toContain('domain-test')
  })
})

describe('description in query results', () => {
  it('entity results include description (null when unset)', () => {
    const { items } = queryEntities(index, { filter: 'active' })
    expect(items.find(i => i.slug === 'simorgh')!.description).toBe('Autonomous agent project')
    expect(items.find(i => i.slug === 'proj-a')!.description).toBeNull()
  })

  it('knowledge results include description', () => {
    const { items } = queryKnowledge(index, {})
    expect(items.find(i => i.slug === 'tdd-pattern')!.description).toBe('Write tests first')
    expect(items.find(i => i.slug === 'new-obs')!.description).toBeNull()
  })
})

describe('resource in query results', () => {
  it('entity results include resource (null when unset)', () => {
    const { items } = queryEntities(index, { filter: 'active' })
    expect(items.find(i => i.slug === 'simorgh')!.resource).toBe('https://github.com/org/simorgh')
    expect(items.find(i => i.slug === 'proj-a')!.resource).toBeNull()
  })
})

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { createIndex, SCHEMA_VERSION } from '../src/db.js'
import { serializeFile } from '../src/vault.js'
import { writeFileSync, mkdirSync, rmSync, existsSync, unlinkSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'hafez-test-db-' + Date.now())

function writeEntity(slug: string, fm: Record<string, any>, body = '## Purpose\n\nTest\n\n## Session Log\n') {
  writeFileSync(join(TMP, 'entities', `${slug}.md`), serializeFile(fm, body))
}

function writeKnowledge(slug: string, fm: Record<string, any>, body = '## Insight\n\nTest insight\n\n## Evidence\n') {
  writeFileSync(join(TMP, 'knowledge', `${slug}.md`), serializeFile(fm, body))
}

const today = new Date().toISOString().slice(0, 10)

beforeAll(() => {
  mkdirSync(join(TMP, 'entities'), { recursive: true })
  mkdirSync(join(TMP, 'knowledge'), { recursive: true })
  writeEntity('proj-a', { name: 'Project A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': today, domain: ['backend'], tags: ['infra', 'api'], description: 'Backend project A', resource: 'https://github.com/org/proj-a' })
  writeEntity('proj-b', { name: 'Project B', type: 'project', status: 'done', created: '2026-01-01', 'last-touched': '2026-02-01', parent: 'proj-a', related: ['proj-a'] })
  writeEntity('inbox-item', { name: 'Inbox Item', type: 'capture', status: 'active', created: today, 'last-touched': today })
  writeKnowledge('tdd-insight', { name: 'TDD Insight', domain: ['engineering', 'testing'], confidence: 'pattern', created: '2026-01-01', 'reinforcement-count': 3, related: ['proj-a'], description: 'Test-first catches design flaws' })
  writeKnowledge('new-obs', { name: 'New Observation', domain: ['ai'], confidence: 'observation', created: today, 'reinforcement-count': 0 })
  writeKnowledge('tagged-knowledge', {
    name: 'Tagged Knowledge', domain: ['devops'], confidence: 'observation',
    created: today, 'reinforcement-count': 0, tags: ['devops']
  })
  writeKnowledge('plan-note', {
    name: 'Plan Note', domain: ['planning'], confidence: 'observation',
    created: today, 'reinforcement-count': 0, subtype: 'plan'
  })
  // Entities with specific dates for time-filter testing
  writeEntity('old-project', {
    name: 'Old Project', type: 'project', status: 'done',
    created: '2025-03-15', 'last-touched': '2025-06-15',
  })
  writeEntity('mid-project', {
    name: 'Mid Project', type: 'project', status: 'paused',
    created: '2025-09-01', 'last-touched': '2025-12-15',
  })
  writeEntity('recent-project', {
    name: 'Recent Project', type: 'project', status: 'active',
    created: '2026-02-01', 'last-touched': today,
  })

  // Entity with next actions for stats testing
  writeEntity('has-actions', {
    name: 'Has Actions', type: 'entity', status: 'active',
    created: today, 'last-touched': today, tags: ['test']
  }, '## Purpose\n\nTest\n\n## Next Actions\n\n- [ ] Task one\n- [ ] Task two\n\n## Session Log\n')

  // Stale entity: active, touched 20 days ago
  const twentyDaysAgo = new Date(Date.now() - 20 * 86400000).toISOString().slice(0, 10)
  writeEntity('stale-entity', {
    name: 'Stale Entity', type: 'entity', status: 'active',
    created: '2026-01-01', 'last-touched': twentyDaysAgo,
  })

  // Entity with brief and session log for enriched index testing
  writeFileSync(join(TMP, 'entities', 'enriched-entity.md'), `---
name: Enriched Entity
type: entity
status: active
created: 2026-01-01
last-touched: 2026-03-29
---

## Brief

This is the brief text.

## Next Actions

- [ ] Do something

## Session Log

### 2026-03-29 — claude [progress]
Summary: Made progress on the thing

### 2026-03-28 — parisa [decision]
Summary: Decided on approach
`)
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('createIndex', () => {
  it('creates database and populates from vault files', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({})
    expect(items.length).toBe(13) // 9 entities + 4 knowledge
    db.close()
  })

  it('indexes entity frontmatter correctly', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'entity', status: 'active' })
    expect(items.some((i: any) => i.slug === 'proj-a')).toBe(true)
    expect(items.some((i: any) => i.slug === 'proj-b')).toBe(false) // status=done
    db.close()
  })

  it('indexes knowledge frontmatter correctly', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'knowledge', confidence: 'pattern' })
    expect(items.length).toBe(1)
    expect(items[0].slug).toBe('tdd-insight')
    db.close()
  })

  it('indexes links (related, tags, domains)', () => {
    const db = createIndex(TMP)
    // proj-b has related: ['proj-a']
    const { items: relatedTo } = db.queryItems({ relatedTo: 'proj-a' })
    expect(relatedTo.some((i: any) => i.slug === 'proj-b')).toBe(true)
    expect(relatedTo.some((i: any) => i.slug === 'tdd-insight')).toBe(true) // knowledge related to proj-a
    db.close()
  })

  it('queries by parent', () => {
    const db = createIndex(TMP)
    const { items: children } = db.queryItems({ parent: 'proj-a' })
    expect(children.length).toBe(1)
    expect(children[0].slug).toBe('proj-b')
    db.close()
  })

  it('queries by domain for entities', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'entity', domain: 'backend' })
    expect(items.length).toBe(1)
    expect(items[0].slug).toBe('proj-a')
    db.close()
  })

  it('queries by domain for knowledge', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'knowledge', domain: 'engineering' })
    expect(items.length).toBe(1)
    expect(items[0].slug).toBe('tdd-insight')
    db.close()
  })

  it('does not return entities for non-matching domain', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'entity', domain: 'nonexistent' })
    expect(items.length).toBe(0)
    db.close()
  })

  it('subtype round-trip: filters knowledge by subtype', () => {
    const db = createIndex(TMP)
    // Query with subtype filter — should return only plan-note
    const { items: planItems } = db.queryItems({ kind: 'knowledge', subtype: 'plan' })
    expect(planItems.length).toBe(1)
    expect(planItems[0].slug).toBe('plan-note')
    // Query without subtype filter — should return all knowledge including plan-note
    const { items: allKnowledge } = db.queryItems({ kind: 'knowledge' })
    expect(allKnowledge.length).toBe(4)
    expect(allKnowledge.some(i => i.slug === 'plan-note')).toBe(true)
    db.close()
  })
})

describe('malformed files', () => {
  it('skips files missing required fields without crashing', () => {
    // Write a file with no 'created' field — should not crash the index
    writeFileSync(join(TMP, 'knowledge', 'bad-no-created.md'),
      serializeFile({ name: 'Bad Note' }, '## Insight\n\nNo created field\n'))
    // Write a file with no 'name' field
    writeFileSync(join(TMP, 'entities', 'bad-no-name.md'),
      serializeFile({ type: 'project', status: 'active', created: '2026-01-01' } as any, '## Purpose\n\nNo name\n'))

    const db = createIndex(TMP)
    const { items } = db.queryItems({})
    // Should have the original 11 items, not the malformed ones
    expect(items.some((i: any) => i.slug === 'bad-no-created')).toBe(false)
    expect(items.some((i: any) => i.slug === 'bad-no-name')).toBe(false)
    expect(items.length).toBe(13)
    db.close()
  })
})

describe('search', () => {
  it('finds entities by body content', () => {
    const db = createIndex(TMP)
    // All entities have "Test" in body from writeEntity helper
    const results = db.search('Test')
    expect(results.length).toBeGreaterThan(0)
    db.close()
  })

  it('finds knowledge by insight content', () => {
    const db = createIndex(TMP)
    const results = db.search('insight')
    expect(results.some(r => r.kind === 'knowledge')).toBe(true)
    db.close()
  })

  it('finds items by name', () => {
    const db = createIndex(TMP)
    const results = db.search('Project A')
    expect(results.some(r => r.slug === 'proj-a')).toBe(true)
    db.close()
  })

  it('filters by kind', () => {
    const db = createIndex(TMP)
    const results = db.search('Test', 'knowledge')
    expect(results.every(r => r.kind === 'knowledge')).toBe(true)
    db.close()
  })

  it('strips stopwords from query', () => {
    const db = createIndex(TMP)
    // "the" is a stopword, "Project" is not — should still find results
    const results = db.search('the Project')
    expect(results.some(r => r.slug === 'proj-a')).toBe(true)
    db.close()
  })

  it('returns empty for no matches', () => {
    const db = createIndex(TMP)
    const results = db.search('xyznonexistent')
    expect(results.length).toBe(0)
    db.close()
  })
})

describe('queryItems time filters', () => {
  it('filters by since (last_touched >= date)', () => {
    const index = createIndex(TMP)
    const { items } = index.queryItems({ kind: 'entity', since: '2026-01-01' })
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(r => r.last_touched >= '2026-01-01')).toBe(true)
    index.close()
  })

  it('filters by before (last_touched <= date)', () => {
    const index = createIndex(TMP)
    const { items } = index.queryItems({ kind: 'entity', before: '2025-12-31' })
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(r => r.last_touched <= '2025-12-31')).toBe(true)
    index.close()
  })

  it('filters by createdSince', () => {
    const index = createIndex(TMP)
    const { items } = index.queryItems({ kind: 'entity', createdSince: '2026-01-01' })
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(r => r.created >= '2026-01-01')).toBe(true)
    index.close()
  })

  it('filters by createdBefore', () => {
    const index = createIndex(TMP)
    const { items } = index.queryItems({ kind: 'entity', createdBefore: '2025-12-31' })
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(r => r.created <= '2025-12-31')).toBe(true)
    index.close()
  })

  it('combines since + before as a date range', () => {
    const index = createIndex(TMP)
    const { items } = index.queryItems({
      kind: 'entity',
      since: '2025-06-01',
      before: '2025-12-31',
    })
    expect(items.length).toBeGreaterThan(0)
    expect(items.every(r =>
      r.last_touched >= '2025-06-01' && r.last_touched <= '2025-12-31'
    )).toBe(true)
    index.close()
  })
})

describe('queryItems tag filters', () => {
  it('filters by single tag', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'entity', tags: ['infra'] })
    expect(items.length).toBe(1)
    expect(items[0].slug).toBe('proj-a')
    db.close()
  })

  it('filters by multiple tags (AND)', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'entity', tags: ['infra', 'api'] })
    expect(items.length).toBe(1)
    expect(items[0].slug).toBe('proj-a')
    db.close()
  })

  it('returns empty for nonexistent tag', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'entity', tags: ['nonexistent'] })
    expect(items.length).toBe(0)
    db.close()
  })

  it('returns empty when entity has only one of two required tags', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'entity', tags: ['infra', 'nonexistent'] })
    expect(items.length).toBe(0)
    db.close()
  })

  it('combines tag + status filter', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'entity', status: 'active', tags: ['infra'] })
    expect(items.length).toBe(1)
    expect(items[0].slug).toBe('proj-a')
    db.close()
  })

  it('finds knowledge by tag', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'knowledge', tags: ['devops'] })
    expect(items.length).toBe(1)
    expect(items[0].slug).toBe('tagged-knowledge')
    db.close()
  })

  it('returns empty for nonexistent tag on knowledge', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'knowledge', tags: ['nonexistent'] })
    expect(items.length).toBe(0)
    db.close()
  })
})

describe('enriched index', () => {
  it('includes brief and session_log fields in query results', () => {
    const index = createIndex(TMP)
    const { items } = index.queryItems({ kind: 'entity' })
    const item = items.find(i => i.slug === 'enriched-entity')
    expect(item).toBeDefined()
    expect((item as any).brief).toBe('This is the brief text.')
    expect((item as any).session_log_count).toBe(2)
    expect((item as any).last_session_date).toBe('2026-03-29')
    expect((item as any).last_session_type).toBe('progress')
    expect((item as any).last_session_summary).toBe('Made progress on the thing')
    index.close()
  })
})

describe('getStats', () => {
  it('returns correct status counts with zero-initialized values', () => {
    const db = createIndex(TMP)
    const stats = db.getStats()
    expect(stats.counts.active).toBeGreaterThan(0)
    expect(stats.counts.done).toBeGreaterThan(0)
    expect(typeof stats.counts.paused).toBe('number')
    db.close()
  })

  it('returns correct type counts', () => {
    const db = createIndex(TMP)
    const stats = db.getStats()
    expect(stats.by_type.project).toBeGreaterThan(0)
    expect(typeof stats.by_type.capture).toBe('number')
    expect(typeof stats.by_type.entity).toBe('number')
    db.close()
  })

  it('identifies stale entities', () => {
    const db = createIndex(TMP)
    const stats = db.getStats()
    expect(stats.stale.some(s => s.slug === 'stale-entity')).toBe(true)
    expect(stats.stale.every(s => s.days_since_touched > 14)).toBe(true)
    db.close()
  })

  it('identifies active entities without next actions', () => {
    const db = createIndex(TMP)
    const stats = db.getStats()
    // has-actions should NOT be in no_next_action (it has 2 actions)
    expect(stats.no_next_action.every(s => s.slug !== 'has-actions')).toBe(true)
    // proj-a and recent-project are active but have no actions
    expect(stats.no_next_action.some(s => s.slug === 'proj-a')).toBe(true)
    db.close()
  })

  it('returns recently_touched sorted desc, limited to 5', () => {
    const db = createIndex(TMP)
    const stats = db.getStats()
    expect(stats.recently_touched.length).toBeLessThanOrEqual(5)
    for (let i = 1; i < stats.recently_touched.length; i++) {
      expect(stats.recently_touched[i - 1].last_touched >= stats.recently_touched[i].last_touched).toBe(true)
    }
    db.close()
  })

  it('stats include knowledge_count', () => {
    const db = createIndex(TMP)
    const stats = db.getStats()
    expect(stats).toHaveProperty('knowledge_count')
    expect(typeof stats.knowledge_count).toBe('number')
    expect(stats.knowledge_count).toBe(4) // 4 knowledge notes in beforeAll
    db.close()
  })

  it('returns recently_created sorted desc, limited to 5', () => {
    const db = createIndex(TMP)
    const stats = db.getStats()
    expect(stats.recently_created.length).toBeLessThanOrEqual(5)
    for (let i = 1; i < stats.recently_created.length; i++) {
      expect(stats.recently_created[i - 1].created >= stats.recently_created[i].created).toBe(true)
    }
    db.close()
  })
})

describe('queryItems sort/limit/offset', () => {
  it('sorts by name ascending', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'entity', sort_by: 'name', sort_order: 'asc' })
    const names = items.map(i => i.name)
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)))
    db.close()
  })

  it('sorts by created descending', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'entity', sort_by: 'created', sort_order: 'desc' })
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1].created >= items[i].created).toBe(true)
    }
    db.close()
  })

  it('defaults to last_touched desc', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'entity' })
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1].last_touched ?? ''
      const b = items[i].last_touched ?? ''
      expect(a >= b).toBe(true)
    }
    db.close()
  })

  it('falls back to last_touched for invalid sort on entities (reinforcement_count)', () => {
    const db = createIndex(TMP)
    // reinforcement_count is knowledge-only; entity query should fall back to last_touched desc
    const { items } = db.queryItems({ kind: 'entity', sort_by: 'reinforcement_count' })
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1].last_touched ?? ''
      const b = items[i].last_touched ?? ''
      expect(a >= b).toBe(true)
    }
    db.close()
  })

  it('applies limit', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ limit: 3 })
    expect(items.length).toBe(3)
    db.close()
  })

  it('applies offset', () => {
    const db = createIndex(TMP)
    const { items: all } = db.queryItems({})
    const { items: paged } = db.queryItems({ limit: 3, offset: 2 })
    expect(paged.length).toBe(3)
    expect(paged[0].slug).toBe(all[2].slug)
    db.close()
  })

  it('returns total count always', () => {
    const db = createIndex(TMP)
    const { total } = db.queryItems({})
    expect(total).toBe(13) // 9 entities + 4 knowledge
    db.close()
  })

  it('total reflects full count even with limit', () => {
    const db = createIndex(TMP)
    const { items, total } = db.queryItems({ limit: 2 })
    expect(items.length).toBe(2)
    expect(total).toBe(13)
    db.close()
  })

  it('sorts knowledge by reinforcement_count descending', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({ kind: 'knowledge', sort_by: 'reinforcement_count', sort_order: 'desc' })
    // tdd-insight has reinforcement_count=3, others have 0
    expect(items[0].slug).toBe('tdd-insight')
    db.close()
  })
})

describe('wiki link harvesting and parent links', () => {
  const VAULT2 = join(tmpdir(), 'hafez-test-wiki-links-' + Date.now())

  beforeAll(() => {
    mkdirSync(join(VAULT2, 'entities'), { recursive: true })
    mkdirSync(join(VAULT2, 'knowledge'), { recursive: true })
  })

  beforeEach(() => {
    // Remove the DB before each test to force a full rebuild (avoids stale change-detection)
    const dbPath = join(VAULT2, '.hafez.db')
    if (existsSync(dbPath)) unlinkSync(dbPath)
  })

  afterAll(() => rmSync(VAULT2, { recursive: true, force: true }))

  it('harvests [[wiki links]] from body as mention relations', () => {
    writeFileSync(join(VAULT2, 'entities/target.md'), serializeFile({
      name: 'Target', type: 'entity', status: 'active',
      created: '2026-01-01', 'last-touched': '2026-01-01'
    }, '## Purpose\n\nTest\n'))
    writeFileSync(join(VAULT2, 'knowledge/source.md'), serializeFile({
      name: 'Source', created: '2026-01-01'
    }, '## Synthesis\n\nThis references [[target]] in prose.\n\n## Evidence\n\n## Sources\n'))

    const idx = createIndex(VAULT2)
    idx.close()

    const Database = require('better-sqlite3')
    const db = new Database(join(VAULT2, '.hafez.db'), { readonly: true })
    const links = db.prepare("SELECT * FROM links WHERE source = 'source' AND target = 'target' AND relation = 'mention'").all()
    expect(links).toHaveLength(1)
    db.close()
  })

  it('excludes [[links]] inside ## Related section from mention harvesting', () => {
    writeFileSync(join(VAULT2, 'entities/mention-excl-target.md'), serializeFile({
      name: 'Mention Excl Target', type: 'entity', status: 'active',
      created: '2026-01-01', 'last-touched': '2026-01-01'
    }, '## Purpose\n\nTest\n'))
    writeFileSync(join(VAULT2, 'knowledge/mention-excl-source.md'), serializeFile({
      name: 'Mention Excl Source', created: '2026-01-01'
    }, '## Synthesis\n\nNo inline links.\n\n## Related\n- [[mention-excl-target]]\n'))

    const idx = createIndex(VAULT2)
    idx.close()

    const Database = require('better-sqlite3')
    const db = new Database(join(VAULT2, '.hafez.db'), { readonly: true })
    const links = db.prepare("SELECT * FROM links WHERE source = 'mention-excl-source' AND target = 'mention-excl-target' AND relation = 'mention'").all()
    expect(links).toHaveLength(0)
    db.close()
  })

  it('indexes parent as a link relation', () => {
    writeFileSync(join(VAULT2, 'entities/parent-entity.md'), serializeFile({
      name: 'Parent Entity', type: 'project', status: 'active',
      created: '2026-01-01', 'last-touched': '2026-01-01'
    }, '## Purpose\n\nTest\n'))
    writeFileSync(join(VAULT2, 'entities/child-entity.md'), serializeFile({
      name: 'Child Entity', type: 'entity', status: 'active',
      created: '2026-01-01', 'last-touched': '2026-01-01',
      parent: 'parent-entity'
    }, '## Purpose\n\nTest\n'))

    const idx = createIndex(VAULT2)
    idx.close()

    const Database = require('better-sqlite3')
    const db = new Database(join(VAULT2, '.hafez.db'), { readonly: true })
    const links = db.prepare("SELECT * FROM links WHERE source = 'child-entity' AND target = 'parent-entity' AND relation = 'parent'").all()
    expect(links).toHaveLength(1)
    db.close()
  })
})

describe('description indexing', () => {
  it('returns description for entities and knowledge in query results', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({})
    expect(items.find(i => i.slug === 'proj-a')!.description).toBe('Backend project A')
    expect(items.find(i => i.slug === 'tdd-insight')!.description).toBe('Test-first catches design flaws')
    expect(items.find(i => i.slug === 'proj-b')!.description).toBeNull()
    db.close()
  })
})

describe('resource indexing', () => {
  it('returns resource for entities, null when unset', () => {
    const db = createIndex(TMP)
    const { items } = db.queryItems({})
    expect(items.find(i => i.slug === 'proj-a')!.resource).toBe('https://github.com/org/proj-a')
    expect(items.find(i => i.slug === 'proj-b')!.resource).toBeNull()
    db.close()
  })
})

describe('schema version rebuild', () => {
  it('forces a full rebuild when stored schema version is stale', () => {
    let db = createIndex(TMP)
    db.close()

    const dbPath = join(TMP, '.hafez.db')
    const raw = new Database(dbPath)
    raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')").run()
    raw.close()

    db = createIndex(TMP)
    const { items } = db.queryItems({})
    expect(items.length).toBeGreaterThan(0)
    db.close()

    const check = new Database(dbPath, { readonly: true })
    const row = check.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }
    // Compare against the imported constant, never a hardcoded literal
    expect(row.value).toBe(SCHEMA_VERSION)
    check.close()
  })
})

describe('corrupt DB recovery (COR-3)', () => {
  it('recovers from a garbage .hafez.db by rebuilding it', () => {
    let db = createIndex(TMP)
    db.close()

    const dbPath = join(TMP, '.hafez.db')
    // Simulate a partial write / kill during WAL checkpoint
    writeFileSync(dbPath, 'this is not a sqlite database, not even close')
    writeFileSync(dbPath + '-wal', 'stale wal garbage')

    db = createIndex(TMP)
    const { items } = db.queryItems({})
    expect(items.length).toBeGreaterThan(0)
    db.close()
  })

  it('read-only open of a garbage .hafez.db degrades to null instead of crashing', () => {
    const dbPath = join(TMP, '.hafez.db')
    writeFileSync(dbPath, 'still not a sqlite database')

    const ro = createIndex(TMP, { readonly: true })
    expect(ro).toBeNull()

    // Heal for subsequent test files' sake
    const db = createIndex(TMP)
    db.close()
  })
})

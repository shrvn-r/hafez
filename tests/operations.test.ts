// tests/operations.test.ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { createHafez } from '../src/index.js'
import { parseFilePath } from '../src/vault.js'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import simpleGit from 'simple-git'

const TMP = join(tmpdir(), 'hafez-test-ops-' + Date.now())
const BARE = join(TMP, 'remote.git')
const VAULT = join(TMP, 'vault')

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  mkdirSync(BARE, { recursive: true })
  await simpleGit(BARE).init(true)
  await simpleGit().clone(BARE, VAULT)
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })
  // Initial commit
  writeFileSync(join(VAULT, '.gitkeep'), '')
  const git = simpleGit(VAULT)
  await git.add('.gitkeep')
  await git.commit('init')
  const branch = (await git.branchLocal()).current
  await git.push('origin', branch)
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

function makeOS() {
  return createHafez({ vaultPath: VAULT, git: { push: false } })
}

describe('create', () => {
  it('creates an entity file and returns slug', async () => {
    const os = makeOS()
    const slug = await os.create('entity', 'Test Project', { type: 'project', purpose: 'Testing' })
    expect(slug).toBe('test-project')
    const { frontmatter } = parseFilePath(join(VAULT, 'entities/test-project.md'))
    expect(frontmatter.name).toBe('Test Project')
    expect(frontmatter.type).toBe('project')
    expect(frontmatter.status).toBe('active')
  })

  it('throws SLUG_EXISTS for duplicate name', async () => {
    const os = makeOS()
    await expect(os.create('entity', 'Test Project', { type: 'project' }))
      .rejects.toThrow('already exists')
  })

  it('throws VALIDATION_FAILED for invalid parent', async () => {
    const os = makeOS()
    await expect(os.create('entity', 'Bad Parent Child', { type: 'entity', parent: 'nonexistent' }))
      .rejects.toThrow('does not exist')
  })

  it('creates a knowledge file with defaults', async () => {
    const os = makeOS()
    const slug = await os.create('knowledge', 'Test Pattern', { domain: ['engineering'] })
    expect(slug).toBe('test-pattern')
    const { frontmatter } = parseFilePath(join(VAULT, 'knowledge/test-pattern.md'))
    expect(frontmatter.confidence).toBe('observation')
    expect(frontmatter['reinforcement-count']).toBe(0)
  })

  it('creates entity with parent reference', async () => {
    const os = makeOS()
    const slug = await os.create('entity', 'Child Thread', { type: 'entity', parent: 'test-project' })
    expect(slug).toBe('child-thread')
    const { frontmatter } = parseFilePath(join(VAULT, 'entities/child-thread.md'))
    expect(frontmatter.parent).toBe('test-project')
  })
})

describe('capture', () => {
  it('creates capture entity with notes', async () => {
    const os = makeOS()
    const slug = await os.capture('Quick Idea', 'Some notes here')
    expect(slug).toBe('quick-idea')
    const { frontmatter, body } = parseFilePath(join(VAULT, 'entities/quick-idea.md'))
    expect(frontmatter.type).toBe('capture')
    expect(body).toContain('Some notes here')
  })
})

describe('read', () => {
  it('reads frontmatter only', async () => {
    const os = makeOS()
    const result = await os.read('test-project', 'frontmatter')
    expect(result.frontmatter.name).toBe('Test Project')
    expect(result.body).toBe('')
  })

  it('reads summary (no session log)', async () => {
    const os = makeOS()
    const result = await os.read('test-project', 'summary')
    expect(result.body).toContain('## Purpose')
    expect(result.body).not.toContain('## Session Log')
  })

  it('reads full content', async () => {
    const os = makeOS()
    const result = await os.read('test-project', 'full')
    expect(result.body).toContain('## Session Log')
  })

  it('throws NOT_FOUND for missing slug', async () => {
    const os = makeOS()
    await expect(os.read('nonexistent')).rejects.toThrow('not found')
  })
})

describe('update', () => {
  it('updates status and last-touched', async () => {
    const os = makeOS()
    await os.update('test-project', { status: 'paused' })
    const { frontmatter } = parseFilePath(join(VAULT, 'entities/test-project.md'))
    expect(frontmatter.status).toBe('paused')
    expect(frontmatter['last-touched']).toBe(new Date().toISOString().slice(0, 10))
  })

  it('appends session log entry newest-first', async () => {
    const os = makeOS()
    await os.update('test-project', {
      session_log: { type: 'progress', summary: 'Did something', agent: 'Test' }
    })
    const { body } = parseFilePath(join(VAULT, 'entities/test-project.md'))
    const slIdx = body.indexOf('## Session Log')
    const entryIdx = body.indexOf('[progress]')
    expect(entryIdx).toBeGreaterThan(slIdx)
    expect(body).toContain('Summary: Did something')
  })

  it('clears next_action when set to null', async () => {
    const os = makeOS()
    await os.update('test-project', { next_action: 'do this' })
    let fm = parseFilePath(join(VAULT, 'entities/test-project.md')).frontmatter
    expect(fm['next-action']).toBe('do this')

    await os.update('test-project', { next_action: null })
    fm = parseFilePath(join(VAULT, 'entities/test-project.md')).frontmatter
    expect(fm['next-action']).toBeUndefined()
  })

  it('inserts current_state before session log', async () => {
    const os = makeOS()
    await os.update('test-project', { current_state: 'Everything is fine' })
    const { body } = parseFilePath(join(VAULT, 'entities/test-project.md'))
    expect(body).toContain('## Current State')
    expect(body).toContain('Everything is fine')
    const csIdx = body.indexOf('## Current State')
    const slIdx = body.indexOf('## Session Log')
    expect(csIdx).toBeLessThan(slIdx)
  })

  it('throws NOT_FOUND for missing slug', async () => {
    const os = makeOS()
    await expect(os.update('nonexistent', { status: 'active' })).rejects.toThrow('not found')
  })

  it('rejects update --related with non-existent slug', async () => {
    const os = makeOS()
    const slug = await os.create('entity', 'Slug Validation Test', { type: 'entity' })
    await expect(os.update(slug, { related: ['non-existent-slug'] }))
      .rejects.toThrow(/does not exist/)
  })

  it('archives oldest session log entry when count >= 10', async () => {
    const os = makeOS()
    // Create a fresh entity for this test
    await os.create('entity', 'Archive Test', { type: 'project' })
    // Add 10 session log entries
    for (let i = 0; i < 10; i++) {
      await os.update('archive-test', {
        session_log: { type: 'progress', summary: `Entry ${i}`, agent: 'Test' }
      })
    }
    const archivePath = join(VAULT, 'entities', 'archive', 'archive-test-log.md')
    expect(existsSync(archivePath)).toBe(true)
    const archiveContent = readFileSync(archivePath, 'utf-8')
    expect(archiveContent).toContain('Entry')
  })
})

describe('link', () => {
  it('sets parent relation', async () => {
    const os = makeOS()
    await os.create('entity', 'Link Target', { type: 'entity' })
    await os.create('entity', 'Link Source', { type: 'entity' })
    await os.link('link-source', 'link-target', 'parent')
    const { frontmatter } = parseFilePath(join(VAULT, 'entities/link-source.md'))
    expect(frontmatter.parent).toBe('link-target')
  })

  it('appends to related array', async () => {
    const os = makeOS()
    await os.link('link-source', 'test-project', 'related')
    const { frontmatter } = parseFilePath(join(VAULT, 'entities/link-source.md'))
    expect(frontmatter.related).toContain('test-project')
  })

  it('throws for non-existent target', async () => {
    const os = makeOS()
    await expect(os.link('link-source', 'nonexistent', 'related')).rejects.toThrow('does not exist')
  })

  it('allows more than 5 related items', async () => {
    const os = makeOS()
    // Create enough targets
    for (let i = 0; i < 5; i++) {
      await os.create('entity', `Filler ${i}`, { type: 'entity' }).catch(() => {})
    }
    // link-source already has 'test-project' in related
    await os.link('link-source', 'link-target', 'related').catch(() => {})
    await os.link('link-source', 'child-thread', 'related').catch(() => {})
    await os.link('link-source', 'quick-idea', 'related').catch(() => {})
    await os.link('link-source', 'archive-test', 'related').catch(() => {})
    // This should now succeed — no cap
    await expect(os.link('link-source', 'filler-0', 'related')).resolves.not.toThrow()
  })
})

describe('unlink', () => {
  it('removes parent relation', async () => {
    const os = makeOS()
    await os.unlink('link-source', 'link-target', 'parent')
    const { frontmatter } = parseFilePath(join(VAULT, 'entities/link-source.md'))
    expect(frontmatter.parent).toBeUndefined()
  })

  it('removes from related array', async () => {
    const os = makeOS()
    await os.unlink('link-source', 'test-project', 'related')
    const { frontmatter } = parseFilePath(join(VAULT, 'entities/link-source.md'))
    expect(frontmatter.related || []).not.toContain('test-project')
  })
})

describe('knowledge', () => {
  it('add_evidence increments reinforcement-count and sets last-reinforced', async () => {
    const os = makeOS()
    const slug = await os.create('knowledge', 'Evidence Test Note', { synthesis: 'Initial' })
    await os.update(slug, { add_evidence: 'New evidence found' })
    const { frontmatter, body } = await os.read(slug, 'full')
    expect(frontmatter['reinforcement-count']).toBe(1)
    expect(frontmatter['last-reinforced']).toBeDefined()
    expect(body).toContain('New evidence found')
    expect(body).toContain('## Evidence')
  })
})

describe('batch', () => {
  it('applies create + link in single commit', async () => {
    const os = makeOS()
    await os.batch([
      { op: 'create', kind: 'entity', name: 'Batch Entity', fields: { type: 'project' } },
      { op: 'link', slug: 'batch-entity', target: 'test-project', relation: 'related' },
    ])
    const { frontmatter } = parseFilePath(join(VAULT, 'entities/batch-entity.md'))
    expect(frontmatter.related).toContain('test-project')
  })

  it('rolls back on failure mid-batch', async () => {
    const os = makeOS()
    await os.create('entity', 'Rollback Target', { type: 'entity' }).catch(() => {})
    const beforeUpdate = readFileSync(join(VAULT, 'entities/rollback-target.md'), 'utf-8')

    await expect(os.batch([
      { op: 'update', slug: 'rollback-target', fields: { status: 'done' } },
      { op: 'link', slug: 'rollback-target', target: 'completely-nonexistent', relation: 'parent' },
    ])).rejects.toThrow()

    const afterRollback = readFileSync(join(VAULT, 'entities/rollback-target.md'), 'utf-8')
    expect(afterRollback).toBe(beforeUpdate)
  })

  it('accepts knowledge metadata fields in batch update for knowledge note', async () => {
    const os = makeOS()
    // Create a knowledge note first
    await os.create('knowledge', 'Batch Knowledge Test', {
      insight: 'Initial insight',
      domain: ['engineering'],
    }).catch(() => {}) // may already exist from prior runs
    const results = await os.batch([
      { op: 'update', slug: 'batch-knowledge-test', fields: {
        domain: ['engineering', 'ai'],
        confidence: 'pattern',
        tags: ['testing'],
        insight: 'Updated insight',
      } },
    ])
    expect(results[0].status).toBe('ok')
    const { frontmatter: fm } = parseFilePath(join(VAULT, 'knowledge/batch-knowledge-test.md'))
    expect(fm.domain).toContain('engineering')
    expect(fm.confidence).toBe('pattern')
  })

  it('rejects entity-only fields on knowledge in batch', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Batch Kind Guard Test', {}).catch(() => {})
    await expect(os.batch([
      { op: 'update', slug: 'batch-kind-guard-test', fields: { status: 'done' } as any },
    ])).rejects.toThrow('entity-only')
  })

  it('rejects batch update with non-existent related slug', async () => {
    const os = makeOS()
    await os.create('entity', 'Batch Related Test', { type: 'entity' })
    await expect(os.batch([
      { op: 'update', slug: 'batch-related-test', fields: { related: ['non-existent-slug'] } },
    ])).rejects.toThrow(/does not exist/)
  })
})

describe('syncRelatedSection', () => {
  it('generates ## Related section with wiki links on create', async () => {
    const os = makeOS()
    const target = await os.create('entity', 'Wiki Target', { type: 'entity' })
    const slug = await os.create('knowledge', 'Wiki Note', {
      synthesis: 'Some content',
      related: [target]
    })
    const { body } = await os.read(slug, 'full')
    expect(body).toContain('## Related')
    expect(body).toContain(`[[${target}]]`)
  })

  it('generates ## Related section on link', async () => {
    const os = makeOS()
    const a = await os.create('entity', 'Wiki Entity A', { type: 'entity' })
    const b = await os.create('entity', 'Wiki Entity B', { type: 'entity' })
    await os.link(a, b, 'related')
    const { body } = await os.read(a, 'full')
    expect(body).toContain(`[[${b}]]`)
  })
})

describe('related_to with relation filter', () => {
  it('filters by mention relation', async () => {
    const os = makeOS()
    const target = await os.create('entity', 'Mention Target', { type: 'entity' })
    const note = await os.create('knowledge', 'Mention Source', {
      synthesis: `References [[${target}]] in context.`,
    })
    const result = await os.related_to(target, 'mention')
    expect(result.items).toHaveLength(1)
    expect(result.items[0].slug).toBe(note)
  })

  it('defaults to related relation for backward compat', async () => {
    const os = makeOS()
    const target = await os.create('entity', 'Compat Target', { type: 'entity' })
    const related = await os.create('entity', 'Compat Related', { type: 'entity' })
    await os.link(related, target, 'related')
    // A knowledge note that mentions target should NOT appear without relation filter (defaults to 'related')
    await os.create('knowledge', 'Compat Note', {
      synthesis: `See [[${target}]].`,
    })
    const result = await os.related_to(target)
    expect(result.items).toHaveLength(1)
    expect(result.items[0].slug).toBe(related)
  })

  it('returns all link types with relation=all', async () => {
    const os = makeOS()
    const target = await os.create('entity', 'All Target', { type: 'entity' })
    const related = await os.create('entity', 'All Related', { type: 'entity' })
    await os.link(related, target, 'related')
    const note = await os.create('knowledge', 'All Note', {
      synthesis: `References [[${target}]].`,
    })
    const result = await os.related_to(target, 'all')
    const slugs = result.items.map(i => i.slug)
    expect(slugs).toContain(related)
    expect(slugs).toContain(note)
  })

  it('knowledge query results include last_touched field', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Last Touched Test', { synthesis: 'Content here.' })
    const result = await os.query_knowledge({})
    const found = result.items.find(i => i.slug === 'last-touched-test')
    expect(found).toBeDefined()
    expect('last_touched' in found!).toBe(true)
    // Regular knowledge notes don't have last-touched in frontmatter, so it will be null
    expect(found!.last_touched).toBeNull()
  })
})

describe('validate', () => {
  it('reports broken parent references', async () => {
    const os = makeOS()
    // Manually write an entity with bad parent
    writeFileSync(join(VAULT, 'entities/bad-parent.md'),
      '---\nname: Bad Parent\ntype: project\nstatus: active\ncreated: 2026-01-01\nlast-touched: 2026-01-01\nparent: does-not-exist\n---\n\n## Purpose\n\n## Session Log\n')
    const report = await os.validate()
    expect(report.broken_slugs.some(b => b.slug === 'bad-parent' && b.field === 'parent')).toBe(true)
  })

  it('reports orphaned knowledge', async () => {
    const os = makeOS()
    // Create knowledge with no related and not referenced
    writeFileSync(join(VAULT, 'knowledge/orphan.md'),
      '---\nname: Orphan\ncreated: 2026-01-01\nconfidence: observation\nreinforcement-count: 0\n---\n\n## Insight\n\n## Evidence\n')
    const report = await os.validate()
    expect(report.orphaned_knowledge).toContain('orphan')
  })

  it('counts entities and knowledge', async () => {
    const os = makeOS()
    const report = await os.validate()
    expect(report.total_entities).toBeGreaterThan(0)
    expect(report.total_knowledge).toBeGreaterThan(0)
  })
})

describe('description field', () => {
  it('create entity with description writes frontmatter and query returns it', async () => {
    const os = makeOS()
    const slug = await os.create('entity', 'Described Entity', { type: 'project', description: 'One-line summary' })
    const { frontmatter } = parseFilePath(join(VAULT, 'entities/described-entity.md'))
    expect(frontmatter.description).toBe('One-line summary')
    const { items } = await os.query({ filter: 'all' })
    expect(items.find(i => i.slug === slug)!.description).toBe('One-line summary')
  })

  it('create knowledge with description writes frontmatter and query returns it', async () => {
    const os = makeOS()
    const slug = await os.create('knowledge', 'Described Note', { description: 'Knowledge summary' })
    const { frontmatter } = parseFilePath(join(VAULT, 'knowledge/described-note.md'))
    expect(frontmatter.description).toBe('Knowledge summary')
    const { items } = await os.query_knowledge({})
    expect(items.find(i => i.slug === slug)!.description).toBe('Knowledge summary')
  })

  it('update sets description and empty string clears it', async () => {
    const os = makeOS()
    await os.create('entity', 'Desc Update Target', { type: 'entity' })
    await os.update('desc-update-target', { description: 'Now described' })
    let fm = parseFilePath(join(VAULT, 'entities/desc-update-target.md')).frontmatter
    expect(fm.description).toBe('Now described')
    await os.update('desc-update-target', { description: '' })
    fm = parseFilePath(join(VAULT, 'entities/desc-update-target.md')).frontmatter
    expect(fm.description).toBeUndefined()
  })

  it('batch create carries description for entity and knowledge', async () => {
    const os = makeOS()
    await os.batch([
      { op: 'create', kind: 'entity', name: 'Batch Desc Entity', fields: { type: 'entity', description: 'Batch entity desc' } },
      { op: 'create', kind: 'knowledge', name: 'Batch Desc Note', fields: { description: 'Batch knowledge desc' } },
    ])
    expect(parseFilePath(join(VAULT, 'entities/batch-desc-entity.md')).frontmatter.description).toBe('Batch entity desc')
    expect(parseFilePath(join(VAULT, 'knowledge/batch-desc-note.md')).frontmatter.description).toBe('Batch knowledge desc')
  })
})

describe('resource field', () => {
  it('create entity with resource writes frontmatter and query returns it', async () => {
    const os = makeOS()
    const slug = await os.create('entity', 'Resourced Entity', { type: 'project', resource: 'https://github.com/org/repo' })
    const { frontmatter } = parseFilePath(join(VAULT, 'entities/resourced-entity.md'))
    expect(frontmatter.resource).toBe('https://github.com/org/repo')
    const { items } = await os.query({ filter: 'all' })
    expect(items.find(i => i.slug === slug)!.resource).toBe('https://github.com/org/repo')
  })

  it('update sets resource and empty string clears it', async () => {
    const os = makeOS()
    await os.create('entity', 'Resource Update Target', { type: 'entity' })
    await os.update('resource-update-target', { resource: 'https://example.com/dashboard' })
    let fm = parseFilePath(join(VAULT, 'entities/resource-update-target.md')).frontmatter
    expect(fm.resource).toBe('https://example.com/dashboard')
    await os.update('resource-update-target', { resource: '' })
    fm = parseFilePath(join(VAULT, 'entities/resource-update-target.md')).frontmatter
    expect(fm.resource).toBeUndefined()
  })

  it('rejects resource on knowledge notes', async () => {
    const os = makeOS()
    await os.create('knowledge', 'No Resource Note', {})
    await expect(os.update('no-resource-note', { resource: 'https://example.com' }))
      .rejects.toThrow('entity-only')
  })

  it('batch create carries resource for entity', async () => {
    const os = makeOS()
    await os.batch([
      { op: 'create', kind: 'entity', name: 'Batch Resource Entity', fields: { type: 'entity', resource: 'https://example.com/batch' } },
    ])
    expect(parseFilePath(join(VAULT, 'entities/batch-resource-entity.md')).frontmatter.resource).toBe('https://example.com/batch')
  })
})

describe('null clears description and resource', () => {
  it('update with null clears both fields (batch-API parity with brief)', async () => {
    const os = makeOS()
    await os.create('entity', 'Null Clear Target', { type: 'entity', description: 'Set', resource: 'https://example.com' })
    await os.update('null-clear-target', { description: null, resource: null })
    const fm = parseFilePath(join(VAULT, 'entities/null-clear-target.md')).frontmatter
    expect(fm.description).toBeUndefined()
    expect(fm.resource).toBeUndefined()
  })
})

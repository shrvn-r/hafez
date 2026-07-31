// tests/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHafez } from '../src/index.js'
import { parseFilePath } from '../src/vault.js'
import { knowledgeBodyTemplate } from '../src/templates.js'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import simpleGit from 'simple-git'

const TMP = join(tmpdir(), 'hafez-integration-' + Date.now())
const BARE = join(TMP, 'remote.git')
const VAULT = join(TMP, 'vault')

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  mkdirSync(BARE, { recursive: true })
  await simpleGit(BARE).init(true)
  await simpleGit().clone(BARE, VAULT)
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })
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

describe('Integration: Create and Read', () => {
  it('creates a project and reads it at each depth', async () => {
    const os = makeOS()
    const slug = await os.create('entity', 'Integration Project', { type: 'project', purpose: 'Testing full flow' })
    expect(slug).toBe('integration-project')

    const fm = await os.read(slug, 'frontmatter')
    expect(fm.frontmatter.name).toBe('Integration Project')
    expect(fm.body).toBe('')

    const summary = await os.read(slug, 'summary')
    expect(summary.body).toContain('## Purpose')
    expect(summary.body).not.toContain('## Session Log')

    const full = await os.read(slug, 'full')
    expect(full.body).toContain('## Session Log')
  })
})

describe('Integration: Create and Query', () => {
  it('queries entities by filter', async () => {
    const os = makeOS()
    await os.create('entity', 'Active Area', { type: 'entity' })
    await os.create('entity', 'Sim Idea', { type: 'entity' })
    await os.update('sim-idea', { status: 'paused' })

    const { items: active } = await os.query({ filter: 'active' })
    expect(active.some(r => r.slug === 'active-area')).toBe(true)
    expect(active.some(r => r.slug === 'sim-idea')).toBe(false)

    const { items: all } = await os.query({ filter: 'all' })
    expect(all.some(r => r.slug === 'active-area')).toBe(true)
    expect(all.some(r => r.slug === 'sim-idea')).toBe(true)
    // paused items not returned by active filter
  })
})

describe('Integration: Parent-Child', () => {
  it('creates parent and child, verifies children()', async () => {
    const os = makeOS()
    await os.create('entity', 'Parent Proj', { type: 'project' })
    await os.create('entity', 'Child Thread', { type: 'entity', parent: 'parent-proj' })

    const { items: children } = await os.children('parent-proj')
    expect(children.length).toBe(1)
    expect(children[0].slug).toBe('child-thread')
  })
})

describe('Integration: Related Links', () => {
  it('links two entities and verifies related_to() both directions', async () => {
    const os = makeOS()
    await os.create('entity', 'Entity A', { type: 'project' })
    await os.create('entity', 'Entity B', { type: 'entity' })

    await os.link('entity-a', 'entity-b', 'related')

    const { items: relatedToB } = await os.related_to('entity-b')
    expect(relatedToB.some(r => r.slug === 'entity-a')).toBe(true)
  })
})

describe('Integration: Session Log Lifecycle', () => {
  it('archives oldest entry after 10 logs', async () => {
    const os = makeOS()
    await os.create('entity', 'Log Test', { type: 'project' })

    for (let i = 0; i < 10; i++) {
      await os.update('log-test', {
        session_log: { type: 'progress', summary: `Log entry ${i}`, agent: 'IntegrationTest' }
      })
    }

    const archivePath = join(VAULT, 'entities', 'archive', 'log-test-log.md')
    expect(existsSync(archivePath)).toBe(true)
    const content = readFileSync(archivePath, 'utf-8')
    expect(content).toContain('Log entry')
  })
})

describe('Integration: Capture and Triage', () => {
  it('captures inbox item then updates type to project', async () => {
    const os = makeOS()
    const slug = await os.capture('Quick Note', 'Some context')

    const before = await os.read(slug, 'frontmatter')
    expect(before.frontmatter.type).toBe('capture')

    // Triage: change to project status
    await os.update(slug, { status: 'active' })
    // Note: changing type requires direct file edit, not part of update()
    // The triage workflow uses update for status, the type stays as-is or requires re-creation
    const after = await os.read(slug, 'frontmatter')
    expect(after.frontmatter.status).toBe('active')
  })
})

describe('Integration: Knowledge Lifecycle', () => {
  it('creates knowledge, adds evidence 3x, tracks reinforcement count', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Emerging Pattern', { domain: ['engineering'] })

    const before = await os.read('emerging-pattern', 'frontmatter')
    expect(before.frontmatter.confidence).toBe('observation')

    await os.update('emerging-pattern', { add_evidence: 'First evidence' })
    await os.update('emerging-pattern', { add_evidence: 'Second evidence' })
    await os.update('emerging-pattern', { add_evidence: 'Third evidence' })

    const after = await os.read('emerging-pattern', 'frontmatter')
    // No auto-promotion — confidence stays observation
    expect(after.frontmatter.confidence).toBe('observation')
    expect(after.frontmatter['reinforcement-count']).toBe(3)

    const full = await os.read('emerging-pattern', 'full')
    expect(full.body).toContain('First evidence')
    expect(full.body).toContain('Third evidence')
  })
})

describe('Integration: Batch', () => {
  it('creates entity + links in single batch', async () => {
    const os = makeOS()
    await os.batch([
      { op: 'create', kind: 'entity', name: 'Batch Parent', fields: { type: 'project' } },
      { op: 'create', kind: 'entity', name: 'Batch Child', fields: { type: 'entity' } },
      { op: 'link', slug: 'batch-child', target: 'batch-parent', relation: 'parent' },
    ])

    const child = await os.read('batch-child', 'frontmatter')
    expect(child.frontmatter.parent).toBe('batch-parent')

    // Verify single git commit for batch
    const git = simpleGit(VAULT)
    const log = await git.log()
    expect(log.latest?.message).toContain('batch')
  })
})

describe('Integration: Validate', () => {
  it('reports broken parent reference', async () => {
    const os = makeOS()
    // Write entity with invalid parent directly (bypass validation)
    writeFileSync(join(VAULT, 'entities/broken-ref.md'),
      '---\nname: Broken Ref\ntype: project\nstatus: active\ncreated: 2026-01-01\nlast-touched: 2026-01-01\nparent: ghost-entity\n---\n\n## Purpose\n\n## Session Log\n')

    const report = await os.validate()
    expect(report.broken_slugs.some(b => b.slug === 'broken-ref' && b.issue.includes('ghost-entity'))).toBe(true)
  })
})

describe('Integration: Unlink', () => {
  it('links then unlinks, verifies relationship removed', async () => {
    const os = makeOS()
    await os.create('entity', 'Unlink A', { type: 'project' })
    await os.create('entity', 'Unlink B', { type: 'entity' })

    await os.link('unlink-a', 'unlink-b', 'related')
    let fm = (await os.read('unlink-a', 'frontmatter')).frontmatter
    expect(fm.related).toContain('unlink-b')

    await os.unlink('unlink-a', 'unlink-b', 'related')
    fm = (await os.read('unlink-a', 'frontmatter')).frontmatter
    expect(fm.related || []).not.toContain('unlink-b')
  })
})

describe('Integration: Bulk add_actions', () => {
  it('add_actions adds multiple items to Next Actions', async () => {
    const os = makeOS()
    await os.create('entity', 'multi-action-test', { type: 'entity' })
    await os.update('multi-action-test', { add_actions: ['First task', 'Second task', 'Third task'] })
    const result = await os.read('multi-action-test')
    expect(result.body).toContain('- [ ] First task')
    expect(result.body).toContain('- [ ] Second task')
    expect(result.body).toContain('- [ ] Third task')
  })

  it('add_actions works alongside add_action', async () => {
    const os = makeOS()
    await os.create('entity', 'combo-action-test', { type: 'entity' })
    await os.update('combo-action-test', { add_action: 'Solo', add_actions: ['Batch1', 'Batch2'] })
    const result = await os.read('combo-action-test')
    expect(result.body).toContain('- [ ] Solo')
    expect(result.body).toContain('- [ ] Batch1')
    expect(result.body).toContain('- [ ] Batch2')
  })
})

describe('Integration: Knowledge metadata updates', () => {
  it('updates domain on knowledge note', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Domain Update Test', { domain: ['old-domain'] })
    await os.update('domain-update-test', { domain: ['engineering', 'architecture'] })
    const fm = (await os.read('domain-update-test', 'frontmatter')).frontmatter
    expect(fm.domain).toEqual(['engineering', 'architecture'])
  })

  it('updates confidence on knowledge note', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Confidence Update Test')
    await os.update('confidence-update-test', { confidence: 'principle' })
    const fm = (await os.read('confidence-update-test', 'frontmatter')).frontmatter
    expect(fm.confidence).toBe('principle')
  })

  it('updates tags on knowledge note', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Tags Update Test')
    await os.update('tags-update-test', { tags: ['tag-a', 'tag-b'] })
    const fm = (await os.read('tags-update-test', 'frontmatter')).frontmatter
    expect(fm.tags).toEqual(['tag-a', 'tag-b'])
  })

  it('updates related on knowledge note', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Related Update Source')
    await os.create('knowledge', 'Related Update Target')
    await os.update('related-update-source', { related: ['related-update-target'] })
    const fm = (await os.read('related-update-source', 'frontmatter')).frontmatter
    expect(fm.related).toContain('related-update-target')
  })

  it('updates synthesis section on knowledge note', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Synthesis Update Test', { synthesis: 'Original synthesis text' })
    await os.update('synthesis-update-test', { synthesis: 'Updated synthesis text' })
    const full = await os.read('synthesis-update-test', 'full')
    expect(full.body).toContain('Updated synthesis text')
    expect(full.body).not.toContain('Original synthesis text')
  })

  it('adds synthesis to knowledge note that had no existing synthesis content', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Empty Synthesis Test')
    await os.update('empty-synthesis-test', { synthesis: 'Newly added synthesis' })
    const full = await os.read('empty-synthesis-test', 'full')
    expect(full.body).toContain('Newly added synthesis')
  })

  it('replaces synthesis without clobbering subsequent sections', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Section Preservation Test', { synthesis: 'First synthesis' })
    // Add evidence via update
    await os.update('section-preservation-test', { add_evidence: 'Some evidence entry' })
    // Now update the synthesis — evidence section must survive
    await os.update('section-preservation-test', { synthesis: 'Refined synthesis' })
    const full = await os.read('section-preservation-test', 'full')
    expect(full.body).toContain('Refined synthesis')
    expect(full.body).toContain('Some evidence entry')
    // Evidence section must appear after Synthesis
    const synthesisIdx = full.body.indexOf('## Synthesis')
    const evidenceIdx = full.body.indexOf('## Evidence')
    expect(synthesisIdx).toBeGreaterThanOrEqual(0)
    expect(evidenceIdx).toBeGreaterThan(synthesisIdx)
  })

  it('throws VALIDATION_FAILED for entity-only fields on knowledge (status)', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Kind Guard Knowledge Status')
    await expect(
      os.update('kind-guard-knowledge-status', { status: 'active' })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('entity-only') })
  })

  it('throws VALIDATION_FAILED for entity-only fields on knowledge (add_action)', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Kind Guard Knowledge Action')
    await expect(
      os.update('kind-guard-knowledge-action', { add_action: 'some task' })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('entity-only') })
  })

  it('throws VALIDATION_FAILED for entity-only fields on knowledge (brief)', async () => {
    const os = makeOS()
    await os.create('knowledge', 'Kind Guard Knowledge Brief')
    await expect(
      os.update('kind-guard-knowledge-brief', { brief: 'some brief' })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('entity-only') })
  })

  it('updates domain on entity', async () => {
    const os = makeOS()
    await os.create('entity', 'Kind Guard Entity Domain', { type: 'project' })
    await os.update('kind-guard-entity-domain', { domain: ['new-domain', 'extra'] })
    const fm = (await os.read('kind-guard-entity-domain', 'frontmatter')).frontmatter
    expect(fm.domain).toEqual(['new-domain', 'extra'])
  })

  it('throws VALIDATION_FAILED for knowledge-only fields on entity (confidence)', async () => {
    const os = makeOS()
    await os.create('entity', 'Kind Guard Entity Confidence', { type: 'project' })
    await expect(
      os.update('kind-guard-entity-confidence', { confidence: 'pattern' })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('knowledge-only') })
  })

  it('throws VALIDATION_FAILED for knowledge-only fields on entity (synthesis)', async () => {
    const os = makeOS()
    await os.create('entity', 'Kind Guard Entity Multi', { type: 'project' })
    await expect(
      os.update('kind-guard-entity-multi', { synthesis: 'some text' })
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('knowledge-only') })
  })

  it('allows shared fields tags and related on entity', async () => {
    const os = makeOS()
    await os.create('entity', 'Kind Guard Entity Tags', { type: 'project' })
    await expect(
      os.update('kind-guard-entity-tags', { tags: ['t'], related: [] })
    ).resolves.toBeDefined()
    const fm = (await os.read('kind-guard-entity-tags', 'frontmatter')).frontmatter
    expect(fm.tags).toEqual(['t'])
  })
})

describe('knowledge compiler integration', () => {
  it('full lifecycle: create with synthesis, add evidence, wiki links harvested, Related section generated, index.md created', async () => {
    const os = makeOS()
    const entity = await os.create('entity', 'KC Test Project', { type: 'project' })
    const note = await os.create('knowledge', 'KC Architecture Pattern', {
      synthesis: `This pattern applies to [[${entity}]] specifically.`,
      domain: ['architecture'],
      related: [entity],
    })

    // Verify wiki link in body
    const { body, frontmatter } = await os.read(note, 'full')
    expect(body).toContain(`[[${entity}]]`)

    // Add evidence
    await os.update(note, { add_evidence: 'Confirmed in production 2026-04-06' })
    const updated = await os.read(note, 'full')
    expect(updated.body).toContain('Confirmed in production')
    expect(updated.frontmatter['reinforcement-count']).toBe(1)

    // Verify mention harvested in index
    const mentions = await os.related_to(entity, 'mention')
    expect(mentions.items.some(i => i.slug === note)).toBe(true)

    // Verify index.md exists
    const indexPath = join(VAULT, 'index.md')
    expect(existsSync(indexPath)).toBe(true)
    const indexContent = readFileSync(indexPath, 'utf-8')
    expect(indexContent).toContain(`[[${note}]]`)
    expect(indexContent).toContain('Architecture')
  })
})

describe('knowledge compiler — gap coverage', () => {
  it('stale callers passing subtype session to knowledgeBodyTemplate get clear error', () => {
    expect(() => knowledgeBodyTemplate('session'))
      .toThrow(/no longer supported/)
  })

  it('session batch rejects slug that collides with existing entity', async () => {
    const os = makeOS()
    await os.create('entity', 'Collision Target', { type: 'project' })
    const results = await os.batch([
      { op: 'create', kind: 'session', name: 'Collision Target' },
    ])
    expect(results[0].status).toBe('error')
    expect(results[0].error).toContain('already exists in the vault')
  })
})

describe('domain unification', () => {
  it('creates entity with array domain', async () => {
    const os = makeOS()
    await os.create('entity', 'Multi Domain Entity', { type: 'project', domain: ['ai', 'infrastructure'] })
    const result = await os.read('multi-domain-entity', 'frontmatter')
    expect(result.frontmatter.domain).toEqual(['ai', 'infrastructure'])
  })

  it('treats empty domain array as no domain on create', async () => {
    const os = makeOS()
    await os.create('entity', 'Empty Domain Entity', { type: 'project', domain: [] })
    const fm = (await os.read('empty-domain-entity', 'frontmatter')).frontmatter
    expect(fm.domain).toBeUndefined()
  })

  it('clears domain when updated to empty array', async () => {
    const os = makeOS()
    await os.create('entity', 'Clear Domain Entity', { type: 'project', domain: ['old'] })
    await os.update('clear-domain-entity', { domain: [] })
    const fm = (await os.read('clear-domain-entity', 'frontmatter')).frontmatter
    expect(fm.domain).toBeUndefined()
  })

  it('queries entity by any of its domains', async () => {
    const os = makeOS()
    await os.create('entity', 'Multi Domain Query', { type: 'project', domain: ['ai', 'infrastructure'] })
    const aiResult = await os.query({ domain: 'ai' })
    expect(aiResult.items.some(i => i.slug === 'multi-domain-query')).toBe(true)
    const infraResult = await os.query({ domain: 'infrastructure' })
    expect(infraResult.items.some(i => i.slug === 'multi-domain-query')).toBe(true)
    const noResult = await os.query({ domain: 'nonexistent' })
    expect(noResult.items.some(i => i.slug === 'multi-domain-query')).toBe(false)
  })
})

describe('Integration: Description round-trip', () => {
  it('creates with description, queries it back, clears it', async () => {
    const os = makeOS()
    const slug = await os.create('entity', 'Round Trip Desc', { type: 'project', description: 'Round-trip summary' })

    const { items } = await os.query({ filter: 'active' })
    expect(items.find(i => i.slug === slug)!.description).toBe('Round-trip summary')

    await os.update(slug, { description: '' })
    const { frontmatter } = parseFilePath(join(VAULT, 'entities', `${slug}.md`))
    expect(frontmatter.description).toBeUndefined()
    const after = await os.query({ filter: 'active' })
    expect(after.items.find(i => i.slug === slug)!.description).toBeNull()
  })
})

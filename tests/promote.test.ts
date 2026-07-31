// tests/promote.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { createHafez } from '../src/index.js'
import { mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { execSync } from 'child_process'

function createTestVault(): string {
  const vaultPath = join(tmpdir(), `hafez-test-${randomUUID()}`)
  mkdirSync(join(vaultPath, 'entities'), { recursive: true })
  mkdirSync(join(vaultPath, 'knowledge'), { recursive: true })
  execSync('git init', { cwd: vaultPath })
  execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: vaultPath })
  return vaultPath
}

describe('promote', () => {
  let vaultPath: string
  let os: ReturnType<typeof createHafez>

  beforeEach(() => {
    vaultPath = createTestVault()
    os = createHafez({ vaultPath, git: { push: false } })
  })

  it('promotes capture to entity and preserves content', async () => {
    const slug = await os.capture('My Bug', 'Important finding about auth')
    await os.promote(slug, 'entity')
    const summary = await os.read(slug)
    const full = await os.read(slug, 'full')
    expect(summary.frontmatter.type).toBe('entity')
    expect(summary.body).toContain('## Context')
    expect(summary.body).toContain('Important finding about auth')
    expect(full.body).toContain('## Session Log')
    expect(summary.body).not.toContain('## Notes')
  })

  it('promotes capture to project', async () => {
    const slug = await os.capture('My Feature')
    await os.promote(slug, 'project')
    const file = await os.read(slug)
    expect(file.frontmatter.type).toBe('project')
    expect(file.body).toContain('## Purpose')
    expect(file.body).toContain('## Goals')
  })

  it('promotes capture to knowledge and strips entity fields', async () => {
    const slug = await os.capture('Interesting pattern')
    await os.promote(slug, 'knowledge')
    expect(existsSync(join(vaultPath, 'knowledge', `${slug}.md`))).toBe(true)
    expect(existsSync(join(vaultPath, 'entities', `${slug}.md`))).toBe(false)
    const file = await os.read(slug)
    expect(file.body).toContain('## Synthesis')
    expect(file.frontmatter.status).toBeUndefined()
    expect(file.frontmatter['last-touched']).toBeUndefined()
    expect(file.frontmatter.subtype).toBe('insight')
  })

  it('promotes entity to project', async () => {
    await os.create('entity', 'Fix auth', { type: 'entity' })
    await os.promote('fix-auth', 'project')
    const file = await os.read('fix-auth')
    expect(file.frontmatter.type).toBe('project')
    expect(file.body).toContain('## Purpose')
  })

  it('rejects invalid promotion paths', async () => {
    await os.create('entity', 'Test Project', { type: 'project' })
    await expect(os.promote('test-project', 'entity')).rejects.toThrow()
  })

  it('records promotion in session log', async () => {
    const slug = await os.capture('My Bug')
    await os.promote(slug, 'entity')
    const file = await os.read(slug, 'full')
    expect(file.body).toContain('Promoted from capture')
  })

  it('commits the source-file deletion on promote to knowledge (clean tree)', async () => {
    const slug = await os.capture('Deletion must be staged')
    await os.promote(slug, 'knowledge')
    // The old entities/<slug>.md removal must be part of the promote commit —
    // otherwise the vault is left permanently dirty and later syncs break.
    const status = execSync('git status --porcelain', { cwd: vaultPath }).toString().trim()
    expect(status).toBe('')
    const show = execSync('git show --stat HEAD', { cwd: vaultPath }).toString()
    expect(show).toContain(`knowledge/${slug}.md`)
    expect(show).toContain(`entities/${slug}.md`)
  })

  it('copies description on promote to knowledge', async () => {
    const slug = await os.capture('Descriptive capture')
    await os.update(slug, { description: 'Carried over' })
    await os.promote(slug, 'knowledge')
    const file = await os.read(slug)
    expect(file.frontmatter.description).toBe('Carried over')
  })

  it('drops resource on promote to knowledge', async () => {
    const slug = await os.capture('Resourced capture')
    await os.update(slug, { resource: 'https://example.com/repo' })
    await os.promote(slug, 'knowledge')
    const file = await os.read(slug)
    expect(file.frontmatter.resource).toBeUndefined()
  })

  it('works in batch', async () => {
    const slug = await os.capture('Batch test')
    const results = await os.batch([
      { op: 'promote', slug, target: 'entity' }
    ])
    expect(results[0].status).toBe('ok')
    const file = await os.read(slug)
    expect(file.frontmatter.type).toBe('entity')
  })
})

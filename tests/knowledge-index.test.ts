import { describe, it, expect, beforeEach } from 'vitest'
import { generateVaultIndex } from '../src/knowledge-index.js'
import { createHafez } from '../src/index.js'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import matter from 'gray-matter'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { execSync } from 'child_process'

describe('generateVaultIndex', () => {
  let vault: string

  beforeEach(() => {
    vault = join(tmpdir(), `test-vault-${Date.now()}-${randomUUID().slice(0, 8)}`)
    mkdirSync(join(vault, 'knowledge'), { recursive: true })
  })

  it('generates index.md with knowledge grouped by domain', () => {
    writeFileSync(join(vault, 'knowledge/note-a.md'), matter.stringify(
      '## Synthesis\n\nFirst line of synthesis.\n\n## Evidence\n\n## Sources\n',
      { name: 'Note A', created: '2026-01-01', domain: ['architecture'], confidence: 'pattern' }
    ))
    writeFileSync(join(vault, 'knowledge/note-b.md'), matter.stringify(
      '## Synthesis\n\nAnother synthesis.\n\n## Evidence\n\n## Sources\n',
      { name: 'Note B', created: '2026-01-01', domain: ['business'], confidence: 'observation' }
    ))
    generateVaultIndex(vault)
    const content = readFileSync(join(vault, 'index.md'), 'utf-8')
    expect(content).toContain('## Knowledge')
    expect(content).toContain('### Architecture')
    expect(content).toContain('[[note-a]]')
    expect(content).toContain('(pattern)')
    expect(content).toContain('### Business')
    expect(content).toContain('[[note-b]]')
  })

  it('puts notes without domain under Uncategorized', () => {
    writeFileSync(join(vault, 'knowledge/orphan.md'), matter.stringify(
      '## Synthesis\n\nOrphan note.\n',
      { name: 'Orphan', created: '2026-01-01' }
    ))
    generateVaultIndex(vault)
    const content = readFileSync(join(vault, 'index.md'), 'utf-8')
    expect(content).toContain('### Uncategorized')
    expect(content).toContain('[[orphan]]')
  })

  it('uses ## Goal for plan subtype summary', () => {
    writeFileSync(join(vault, 'knowledge/plan.md'), matter.stringify(
      '## Goal\n\nPlan goal text.\n\n## Steps\n\n## Dependencies\n',
      { name: 'My Plan', created: '2026-01-01', subtype: 'plan', domain: ['ops'] }
    ))
    generateVaultIndex(vault)
    const content = readFileSync(join(vault, 'index.md'), 'utf-8')
    expect(content).toContain('Plan goal text')
  })

  it('excludes session files in sessions/ directory', () => {
    mkdirSync(join(vault, 'sessions'), { recursive: true })
    writeFileSync(join(vault, 'sessions/session-2026.md'), matter.stringify('## Summary\n', {
      name: 'Session', created: '2026-01-01'
    }))
    writeFileSync(join(vault, 'knowledge/real-note.md'), matter.stringify('## Synthesis\n\nReal.\n', {
      name: 'Real Note', created: '2026-01-01'
    }))
    generateVaultIndex(vault)
    const content = readFileSync(join(vault, 'index.md'), 'utf-8')
    expect(content).not.toContain('session-2026')
  })

  it('includes entities grouped by status with type suffix', () => {
    mkdirSync(join(vault, 'entities'), { recursive: true })
    writeFileSync(join(vault, 'entities/active-proj.md'), matter.stringify(
      '## Purpose\n\nActive purpose.\n\n## Session Log\n',
      { name: 'Active Proj', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' }
    ))
    writeFileSync(join(vault, 'entities/paused-ent.md'), matter.stringify(
      '## Context\n\n## Session Log\n',
      { name: 'Paused Ent', type: 'entity', status: 'paused', created: '2026-01-01', 'last-touched': '2026-01-01' }
    ))
    writeFileSync(join(vault, 'entities/done-proj.md'), matter.stringify(
      '## Purpose\n\n## Session Log\n',
      { name: 'Done Proj', type: 'project', status: 'done', created: '2026-01-01', 'last-touched': '2026-01-01' }
    ))
    generateVaultIndex(vault)
    const content = readFileSync(join(vault, 'index.md'), 'utf-8')
    expect(content).toContain('## Entities')
    expect(content).toContain('### Active')
    expect(content).toContain('[[active-proj]]')
    expect(content).toContain('(project)')
    expect(content).toContain('### Paused')
    expect(content).toContain('[[paused-ent]]')
    expect(content).toContain('### Done')
    expect(content).toContain('[[done-proj]]')
  })

  it('prefers description over Brief for entity summary, and description over Synthesis for knowledge', () => {
    mkdirSync(join(vault, 'entities'), { recursive: true })
    writeFileSync(join(vault, 'entities/described.md'), matter.stringify(
      '## Brief\n\nBrief text here.\n\n## Session Log\n',
      { name: 'Described', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01', description: 'Frontmatter summary wins' }
    ))
    writeFileSync(join(vault, 'entities/briefed.md'), matter.stringify(
      '## Brief\n\nBrief fallback line.\n\n## Session Log\n',
      { name: 'Briefed', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' }
    ))
    writeFileSync(join(vault, 'knowledge/desc-note.md'), matter.stringify(
      '## Synthesis\n\nSynthesis line.\n',
      { name: 'Desc Note', created: '2026-01-01', description: 'Knowledge description wins' }
    ))
    generateVaultIndex(vault)
    const content = readFileSync(join(vault, 'index.md'), 'utf-8')
    expect(content).toContain('[[described]] — Frontmatter summary wins (project)')
    expect(content).toContain('[[briefed]] — Brief fallback line. (project)')
    expect(content).toContain('[[desc-note]] — Knowledge description wins (observation)')
  })

  it('excludes entities/archive/ via non-recursive readdir', () => {
    mkdirSync(join(vault, 'entities', 'archive'), { recursive: true })
    writeFileSync(join(vault, 'entities/live-ent.md'), matter.stringify(
      '## Purpose\n\n## Session Log\n',
      { name: 'Live Ent', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' }
    ))
    writeFileSync(join(vault, 'entities/archive/old-ent.md'), matter.stringify(
      '## Purpose\n\n## Session Log\n',
      { name: 'Old Ent', type: 'entity', status: 'done', created: '2026-01-01', 'last-touched': '2026-01-01' }
    ))
    generateVaultIndex(vault)
    const content = readFileSync(join(vault, 'index.md'), 'utf-8')
    expect(content).toContain('[[live-ent]]')
    expect(content).not.toContain('old-ent')
  })

  it('skips malformed entity files but still writes the index', () => {
    mkdirSync(join(vault, 'entities'), { recursive: true })
    writeFileSync(join(vault, 'entities/good-ent.md'), matter.stringify(
      '## Purpose\n\n## Session Log\n',
      { name: 'Good Ent', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' }
    ))
    // Unparseable frontmatter
    writeFileSync(join(vault, 'entities/broken.md'), '---\nname: [unclosed\n---\n\nbody\n')
    // Missing name
    writeFileSync(join(vault, 'entities/no-name.md'), matter.stringify(
      '## Purpose\n', { type: 'entity', status: 'active', created: '2026-01-01' }
    ))
    generateVaultIndex(vault)
    const content = readFileSync(join(vault, 'index.md'), 'utf-8')
    expect(content).toContain('[[good-ent]]')
    expect(content).not.toContain('no-name')
  })

  it('renders non-standard statuses in a fallback bucket instead of dropping them', () => {
    mkdirSync(join(vault, 'entities'), { recursive: true })
    writeFileSync(join(vault, 'entities/odd-status.md'), matter.stringify(
      '## Purpose\n\n## Session Log\n',
      { name: 'Odd Status', type: 'entity', status: 'archived', created: '2026-01-01', 'last-touched': '2026-01-01' }
    ))
    generateVaultIndex(vault)
    const content = readFileSync(join(vault, 'index.md'), 'utf-8')
    expect(content).toContain('### Archived')
    expect(content).toContain('[[odd-status]]')
  })

  it('returns without writing when neither entities/ nor knowledge/ exists', () => {
    const empty = join(tmpdir(), `test-vault-empty-${Date.now()}`)
    mkdirSync(empty, { recursive: true })
    generateVaultIndex(empty)
    expect(existsSync(join(empty, 'index.md'))).toBe(false)
    rmSync(empty, { recursive: true, force: true })
  })
})

describe('vault index regeneration on writes', () => {
  let vault: string
  let os: ReturnType<typeof createHafez>

  function readIndex(): string {
    return readFileSync(join(vault, 'index.md'), 'utf-8')
  }

  beforeEach(() => {
    vault = join(tmpdir(), `hafez-vidx-${randomUUID()}`)
    mkdirSync(join(vault, 'entities'), { recursive: true })
    execSync('git init', { cwd: vault })
    execSync('git config user.email "test@test.com" && git config user.name "Test"', { cwd: vault })
    os = createHafez({ vaultPath: vault, git: { push: false } })
  })

  it('create entity regenerates the index (no knowledge/ dir required)', async () => {
    await os.create('entity', 'Index On Create', { type: 'project', description: 'Created entity' })
    expect(readIndex()).toContain('[[index-on-create]] — Created entity (project)')
  })

  it('capture regenerates the index even when knowledge/ does not exist', async () => {
    expect(existsSync(join(vault, 'knowledge'))).toBe(false)
    await os.capture('Quick Thought')
    expect(readIndex()).toContain('[[quick-thought]]')
  })

  it('update regenerates the index for entities', async () => {
    await os.create('entity', 'Update Target', { type: 'entity' })
    await os.update('update-target', { description: 'Freshly described' })
    expect(readIndex()).toContain('[[update-target]] — Freshly described (entity)')
  })

  it('link regenerates the index', async () => {
    await os.create('entity', 'Link A', { type: 'entity' })
    await os.create('entity', 'Link B', { type: 'entity' })
    rmSync(join(vault, 'index.md'))
    await os.link('link-a', 'link-b', 'related')
    expect(existsSync(join(vault, 'index.md'))).toBe(true)
    expect(readIndex()).toContain('[[link-a]]')
  })

  it('promote regenerates the index', async () => {
    const slug = await os.capture('Promote Me')
    await os.promote(slug, 'project')
    expect(readIndex()).toContain('[[promote-me]]')
    expect(readIndex()).toContain('(project)')
  })

  it('batch touching entities regenerates the index', async () => {
    await os.batch([
      { op: 'create', kind: 'entity', name: 'Batch Ent', fields: { type: 'entity', description: 'From batch' } },
    ])
    expect(readIndex()).toContain('[[batch-ent]] — From batch (entity)')
  })

  it('session-only batch does not rewrite the index', async () => {
    await os.create('entity', 'Session Anchor', { type: 'entity' })
    const before = readIndex()
    // Overwrite with sentinel to detect a rewrite
    writeFileSync(join(vault, 'index.md'), before + '\n<!-- sentinel -->\n')
    await os.batch([
      { op: 'create', kind: 'session', name: 'Session Only 2026-07-18' },
    ])
    expect(readIndex()).toContain('<!-- sentinel -->')
  })

  it('adds /index.md to .git/info/exclude so the index never dirties the worktree', async () => {
    await os.capture('Exclude Check')
    const exclude = readFileSync(join(vault, '.git', 'info', 'exclude'), 'utf-8')
    expect(exclude.split('\n')).toContain('/index.md')
    const status = execSync('git status --porcelain', { cwd: vault, encoding: 'utf-8' })
    expect(status).not.toContain('index.md')
  })

  it('index write failure warns but does not fail the already-committed operation', async () => {
    await os.create('entity', 'Survives Index Failure', { type: 'entity' })
    // Make index.md unwritable by replacing it with a directory (EISDIR on write)
    rmSync(join(vault, 'index.md'))
    mkdirSync(join(vault, 'index.md'))
    await expect(os.update('survives-index-failure', { description: 'Still fine' }))
      .resolves.toBeDefined()
    const { readFileSync: rf } = await import('fs')
    expect(rf(join(vault, 'entities/survives-index-failure.md'), 'utf-8')).toContain('Still fine')
  })

  it('entity create succeeds with a malformed sibling in entities/', async () => {
    writeFileSync(join(vault, 'entities/broken-sibling.md'), '---\nname: [unclosed\n---\n\nbody\n')
    const slug = await os.create('entity', 'Healthy Entity', { type: 'entity' })
    expect(slug).toBe('healthy-entity')
    expect(readIndex()).toContain('[[healthy-entity]]')
  })
})

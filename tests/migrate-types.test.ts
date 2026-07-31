// tests/migrate-types.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { serializeFile, parseFilePath } from '../src/vault.js'
import { migrateTypes, type MigrationReport } from '../src/migrate-types.js'

const TMP = join(tmpdir(), 'hafez-test-migrate-types-' + Date.now())
const VAULT = join(TMP, 'vault')

beforeAll(() => {
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })

  // thread → entity (needs type migration)
  writeFileSync(join(VAULT, 'entities/my-thread.md'), serializeFile(
    { name: 'My Thread', type: 'thread', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
    '## Context\n\nSome context.\n\n## Session Log\n'
  ))

  // idea → entity (needs type migration)
  writeFileSync(join(VAULT, 'entities/my-idea.md'), serializeFile(
    { name: 'My Idea', type: 'idea', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
    '## Context\n\nSome content.\n\n## Session Log\n'
  ))

  // area → project (needs type migration)
  writeFileSync(join(VAULT, 'entities/my-area.md'), serializeFile(
    { name: 'My Area', type: 'area', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
    '## Purpose\n\nSome purpose.\n\n## Session Log\n'
  ))

  // inbox → capture (needs type migration)
  writeFileSync(join(VAULT, 'entities/my-inbox.md'), serializeFile(
    { name: 'My Inbox', type: 'inbox', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
    '## Notes\n\nSome notes.\n\n'
  ))

  // simmering → paused (needs status migration)
  writeFileSync(join(VAULT, 'entities/simmering-project.md'), serializeFile(
    { name: 'Simmering Project', type: 'project', status: 'simmering', created: '2026-01-01', 'last-touched': '2026-03-01' },
    '## Purpose\n\nSome purpose.\n\n## Session Log\n'
  ))

  // dormant → paused (needs status migration)
  writeFileSync(join(VAULT, 'entities/dormant-entity.md'), serializeFile(
    { name: 'Dormant Entity', type: 'thread', status: 'dormant', created: '2026-01-01', 'last-touched': '2026-03-01' },
    '## Context\n\nSome context.\n\n## Session Log\n'
  ))

  // already-valid entity — must NOT be modified
  writeFileSync(join(VAULT, 'entities/valid-entity.md'), serializeFile(
    { name: 'Valid Entity', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
    '## Context\n\nContent.\n\n## Session Log\n'
  ))

  // malformed — missing type — must be skipped with warning
  writeFileSync(join(VAULT, 'entities/malformed.md'), serializeFile(
    { name: 'Malformed', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
    '## Context\n\n'
  ))

  // archive subdirectory — valid file needing migration
  mkdirSync(join(VAULT, 'entities/archive'), { recursive: true })
  writeFileSync(join(VAULT, 'entities/archive/archived-thread.md'), serializeFile(
    { name: 'Archived Thread', type: 'thread', status: 'done', created: '2026-01-01', 'last-touched': '2026-02-01' },
    '## Context\n\nArchived content.\n\n'
  ))

  // archive — no frontmatter at all (matches real vault session-log archives)
  writeFileSync(join(VAULT, 'entities/archive/no-frontmatter-log.md'), '### 2026-01-01\nSome log content\n')

  // Knowledge file without subtype — needs subtype: insight added
  writeFileSync(join(VAULT, 'knowledge/my-insight.md'), serializeFile(
    { name: 'My Insight', confidence: 'observation', 'reinforcement-count': 1, created: '2026-01-01', 'last-reinforced': '2026-03-01' },
    '## Insight\n\nSomething learned.\n\n## Evidence\n\n'
  ))

  // Knowledge file already with subtype — must NOT be modified
  writeFileSync(join(VAULT, 'knowledge/already-typed.md'), serializeFile(
    { name: 'Already Typed', subtype: 'insight', confidence: 'pattern', created: '2026-01-01' },
    '## Insight\n\nAlready has subtype.\n\n## Evidence\n\n'
  ))

  // idea with ## Hypothesis — body section must be renamed to ## Context
  writeFileSync(join(VAULT, 'entities/idea-with-hypothesis.md'), serializeFile(
    { name: 'Idea With Hypothesis', type: 'idea', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
    '## Hypothesis\n\nMy hypothesis here.\n\n## Evidence\n\nSome evidence.\n\n## Session Log\n'
  ))

  // entity already using ## Context — body must not be modified
  writeFileSync(join(VAULT, 'entities/entity-with-context.md'), serializeFile(
    { name: 'Entity With Context', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
    '## Context\n\nExisting context content.\n\n## Session Log\n'
  ))
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('migrateTypes — dry run', () => {
  it('reports candidates without modifying files', () => {
    const contentBefore = readFileSync(join(VAULT, 'entities/my-thread.md'), 'utf-8')
    const report = migrateTypes(VAULT, false)
    const contentAfter = readFileSync(join(VAULT, 'entities/my-thread.md'), 'utf-8')

    expect(contentAfter).toBe(contentBefore)
    expect(report.typeChanges).toBeGreaterThan(0)
    expect(report.statusChanges).toBeGreaterThan(0)
    expect(report.applied).toBe(false)
  })

  it('reports malformed files without crashing', () => {
    const report = migrateTypes(VAULT, false)
    expect(report.malformed).toContain('entities/malformed.md')
  })
})

describe('migrateTypes — apply: type mapping', () => {
  beforeAll(() => migrateTypes(VAULT, true))

  it('renames thread → entity', () => {
    const { frontmatter: fm } = parseFilePath(join(VAULT, 'entities/my-thread.md'))
    expect(fm.type).toBe('entity')
  })

  it('renames idea → entity', () => {
    const { frontmatter: fm } = parseFilePath(join(VAULT, 'entities/my-idea.md'))
    expect(fm.type).toBe('entity')
  })

  it('renames area → project', () => {
    const { frontmatter: fm } = parseFilePath(join(VAULT, 'entities/my-area.md'))
    expect(fm.type).toBe('project')
  })

  it('renames inbox → capture', () => {
    const { frontmatter: fm } = parseFilePath(join(VAULT, 'entities/my-inbox.md'))
    expect(fm.type).toBe('capture')
  })
})

describe('migrateTypes — apply: status mapping', () => {
  it('renames simmering → paused', () => {
    const { frontmatter: fm } = parseFilePath(join(VAULT, 'entities/simmering-project.md'))
    expect(fm.status).toBe('paused')
  })

  it('renames dormant → paused (combined with thread → entity)', () => {
    const { frontmatter: fm } = parseFilePath(join(VAULT, 'entities/dormant-entity.md'))
    expect(fm.status).toBe('paused')
    expect(fm.type).toBe('entity')
  })
})

describe('migrateTypes — apply: invariants', () => {
  it('does not modify already-valid files', () => {
    const contentBefore = readFileSync(join(VAULT, 'entities/valid-entity.md'), 'utf-8')
    migrateTypes(VAULT, true)
    const contentAfter = readFileSync(join(VAULT, 'entities/valid-entity.md'), 'utf-8')
    expect(contentAfter).toBe(contentBefore)
  })

  it('skips malformed files and does not write them', () => {
    const contentBefore = readFileSync(join(VAULT, 'entities/malformed.md'), 'utf-8')
    const report = migrateTypes(VAULT, true)
    const contentAfter = readFileSync(join(VAULT, 'entities/malformed.md'), 'utf-8')
    expect(contentAfter).toBe(contentBefore)
    expect(report.malformed).toContain('entities/malformed.md')
  })

  it('preserves body content unchanged after type/status rename', () => {
    const { body } = parseFilePath(join(VAULT, 'entities/my-thread.md'))
    expect(body).toContain('## Context')
    expect(body).toContain('Some context.')
  })

  it('is idempotent — running twice produces same result', () => {
    const snapshot: Record<string, string> = {}
    const files = ['my-thread.md', 'my-idea.md', 'my-area.md', 'my-inbox.md', 'simmering-project.md']
    for (const f of files) {
      snapshot[f] = readFileSync(join(VAULT, 'entities', f), 'utf-8')
    }
    migrateTypes(VAULT, true)
    for (const f of files) {
      expect(readFileSync(join(VAULT, 'entities', f), 'utf-8')).toBe(snapshot[f])
    }
  })
})

describe('migrateTypes — apply: archive subdirectory', () => {
  it('migrates valid archive files', () => {
    migrateTypes(VAULT, true)
    const { frontmatter: fm } = parseFilePath(join(VAULT, 'entities/archive/archived-thread.md'))
    expect(fm.type).toBe('entity')
  })

  it('reports no-frontmatter archive files as malformed', () => {
    const report = migrateTypes(VAULT, false)
    expect(report.malformed).toContain('entities/archive/no-frontmatter-log.md')
  })
})

describe('migrateTypes — report format', () => {
  it('dry-run report has correct counts', () => {
    const freshTmp = join(tmpdir(), 'hafez-report-test-' + Date.now())
    const freshVault = join(freshTmp, 'vault')
    mkdirSync(join(freshVault, 'entities'), { recursive: true })
    mkdirSync(join(freshVault, 'knowledge'), { recursive: true })

    writeFileSync(join(freshVault, 'entities/t1.md'), serializeFile(
      { name: 'T1', type: 'thread', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
      '## Context\n\n'
    ))
    writeFileSync(join(freshVault, 'entities/t2.md'), serializeFile(
      { name: 'T2', type: 'project', status: 'simmering', created: '2026-01-01', 'last-touched': '2026-03-01' },
      '## Purpose\n\n'
    ))
    writeFileSync(join(freshVault, 'entities/malform.md'), serializeFile(
      { name: 'Malform', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
      '## Context\n\n'
    ))
    writeFileSync(join(freshVault, 'knowledge/k1.md'), serializeFile(
      { name: 'K1', confidence: 'observation', created: '2026-01-01' },
      '## Insight\n\n'
    ))

    const report = migrateTypes(freshVault, false)
    expect(report.typeChanges).toBe(1)        // thread → entity
    expect(report.statusChanges).toBe(1)      // simmering → paused
    expect(report.knowledgeSubtypeAdded).toBe(1)
    expect(report.malformed).toEqual(['entities/malform.md'])
    expect(report.applied).toBe(false)

    rmSync(freshTmp, { recursive: true, force: true })
  })

  it('details array contains human-readable change descriptions', () => {
    const freshTmp = join(tmpdir(), 'hafez-detail-test-' + Date.now())
    const freshVault = join(freshTmp, 'vault')
    mkdirSync(join(freshVault, 'entities'), { recursive: true })
    mkdirSync(join(freshVault, 'knowledge'), { recursive: true })

    writeFileSync(join(freshVault, 'entities/t1.md'), serializeFile(
      { name: 'T1', type: 'thread', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
      '## Context\n\n'
    ))

    const report = migrateTypes(freshVault, false)
    expect(report.details.some(d => d.includes('thread') && d.includes('entity'))).toBe(true)

    rmSync(freshTmp, { recursive: true, force: true })
  })
})

describe('migrateTypes — apply: knowledge subtype', () => {
  it('adds subtype: insight to knowledge files missing it', () => {
    migrateTypes(VAULT, true)
    const { frontmatter: fm } = parseFilePath(join(VAULT, 'knowledge/my-insight.md'))
    expect(fm.subtype).toBe('insight')
  })

  it('does not modify knowledge files that already have a subtype', () => {
    const contentBefore = readFileSync(join(VAULT, 'knowledge/already-typed.md'), 'utf-8')
    migrateTypes(VAULT, true)
    const contentAfter = readFileSync(join(VAULT, 'knowledge/already-typed.md'), 'utf-8')
    expect(contentAfter).toBe(contentBefore)
  })

  it('preserves existing knowledge frontmatter fields when adding subtype', () => {
    const { frontmatter: fm } = parseFilePath(join(VAULT, 'knowledge/my-insight.md'))
    expect(fm.confidence).toBe('observation')
    expect(fm['reinforcement-count']).toBe(1)
    expect(fm['last-reinforced']).toBe('2026-03-01')
  })

  it('preserves knowledge body content when adding subtype', () => {
    const { body } = parseFilePath(join(VAULT, 'knowledge/my-insight.md'))
    expect(body).toContain('## Insight')
    expect(body).toContain('Something learned.')
    expect(body).toContain('## Evidence')
  })
})

describe('migrateTypes — apply: body section restructuring', () => {
  it('renames ## Hypothesis to ## Context in idea entities', () => {
    migrateTypes(VAULT, true)
    const { body } = parseFilePath(join(VAULT, 'entities/idea-with-hypothesis.md'))
    expect(body).not.toContain('## Hypothesis')
    expect(body).toContain('## Context')
    expect(body).toContain('My hypothesis here.')
  })

  it('preserves content after renamed section heading', () => {
    const { body } = parseFilePath(join(VAULT, 'entities/idea-with-hypothesis.md'))
    expect(body).toContain('## Evidence')
    expect(body).toContain('Some evidence.')
  })

  it('does not rename ## Context when it already exists', () => {
    const contentBefore = readFileSync(join(VAULT, 'entities/entity-with-context.md'), 'utf-8')
    migrateTypes(VAULT, true)
    const contentAfter = readFileSync(join(VAULT, 'entities/entity-with-context.md'), 'utf-8')
    expect(contentAfter).toBe(contentBefore)
  })

  it('counts body restructures in report', () => {
    // Reset fixtures for a fresh dry-run count
    writeFileSync(join(VAULT, 'entities/hypothesis-fresh.md'), serializeFile(
      { name: 'Hypothesis Fresh', type: 'idea', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
      '## Hypothesis\n\nFresh.\n\n## Session Log\n'
    ))
    const report = migrateTypes(VAULT, false)
    expect(report.bodySectionsRestructured).toBeGreaterThan(0)
  })
})

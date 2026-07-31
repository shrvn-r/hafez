import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHafez, HafezError } from '../src/index.js'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createIndex } from '../src/db.js'

describe('readOnly mode', () => {
  let vaultDir: string

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'hafez-ro-'))
    mkdirSync(join(vaultDir, 'entities'), { recursive: true })
    mkdirSync(join(vaultDir, 'knowledge'), { recursive: true })
    writeFileSync(join(vaultDir, 'entities', 'test.md'), `---
name: Test
type: entity
status: active
created: 2026-01-01
last-touched: 2026-03-29
---

## Brief

Test brief.

## Session Log

### 2026-03-29 — claude [progress]
Summary: Test progress
`)
  })

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true })
  })

  it('read() works in readOnly mode', async () => {
    const os = createHafez({ vaultPath: vaultDir, readOnly: true })
    const result = await os.read('test', 'summary')
    expect(result.frontmatter.name).toBe('Test')
    expect(result.body).toContain('Test brief')
  })

  it('query() returns empty when no index exists', async () => {
    const os = createHafez({ vaultPath: vaultDir, readOnly: true })
    const { items, total } = await os.query()
    expect(items).toEqual([])
    expect(total).toBe(0)
  })

  it('query() works against existing index', async () => {
    // Build index first (write mode)
    const writeIdx = createIndex(vaultDir)
    writeIdx.close()

    // Now open readOnly
    const os = createHafez({ vaultPath: vaultDir, readOnly: true })
    const { items, total } = await os.query()
    expect(total).toBe(1)
    expect(items[0].slug).toBe('test')
    expect(items[0].brief).toBe('Test brief.')
  })

  it('search() returns empty when no index exists', async () => {
    const os = createHafez({ vaultPath: vaultDir, readOnly: true })
    const results = await os.search('test')
    expect(results).toEqual([])
  })

  it('stats() returns zeroed when no index exists', async () => {
    const os = createHafez({ vaultPath: vaultDir, readOnly: true })
    const stats = await os.stats()
    expect(stats.counts.active).toBe(0)
    expect(stats.knowledge_count).toBe(0)
  })

  it('write operations throw in readOnly mode', async () => {
    const os = createHafez({ vaultPath: vaultDir, readOnly: true })
    await expect(os.update('test', { status: 'done' })).rejects.toThrow('read-only')
    await expect(os.create('entity', 'New', { type: 'entity' })).rejects.toThrow('read-only')
    await expect(os.capture('Quick')).rejects.toThrow('read-only')
    await expect(os.link('test', 'other', 'related')).rejects.toThrow('read-only')
    await expect(os.unlink('test', 'other', 'related')).rejects.toThrow('read-only')
    await expect(os.promote('test', 'project')).rejects.toThrow('read-only')
    await expect(os.batch([{ op: 'update', slug: 'test', fields: { status: 'done' } }])).rejects.toThrow('read-only')
    await expect(os.sync()).rejects.toThrow('read-only')
    await expect(os.rebuildIndex()).rejects.toThrow('read-only')
  })

  it('validate() works in readOnly mode (filesystem only)', async () => {
    const os = createHafez({ vaultPath: vaultDir, readOnly: true })
    const report = await os.validate()
    expect(report.total_entities).toBe(1)
  })
})

describe('readOnly mode with stale index schema', () => {
  let vaultDir: string

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'hafez-ro-stale-'))
    mkdirSync(join(vaultDir, 'entities'), { recursive: true })
    writeFileSync(join(vaultDir, 'entities', 'test.md'),
      '---\nname: Test\ntype: entity\nstatus: active\ncreated: 2026-01-01\nlast-touched: 2026-03-29\n---\n\n## Brief\n\nTest brief.\n')
  })

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true })
  })

  it('query() degrades to empty results instead of crashing on a pre-v6 DB', async () => {
    // Build a current index, then fake a stale schema version
    const writeIdx = createIndex(vaultDir)
    writeIdx.close()
    const Database = (await import('better-sqlite3')).default
    const raw = new Database(join(vaultDir, '.hafez.db'))
    raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')").run()
    raw.close()

    const os = createHafez({ vaultPath: vaultDir, readOnly: true })
    const { items, total } = await os.query()
    expect(items).toEqual([])
    expect(total).toBe(0)
  })

  it('recovers after a writer rebuilds the index (null open is not latched)', async () => {
    // Stale index on disk → read-only open returns null and serves empty
    const writeIdx = createIndex(vaultDir)
    writeIdx.close()
    const Database = (await import('better-sqlite3')).default
    const raw = new Database(join(vaultDir, '.hafez.db'))
    raw.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '5')").run()
    raw.close()

    const os = createHafez({ vaultPath: vaultDir, readOnly: true })
    expect((await os.query()).total).toBe(0)

    // A write-capable process rebuilds the index to the current schema
    const rebuilt = createIndex(vaultDir)
    rebuilt.close()

    // The same read-only instance now serves data without a restart
    const { items, total } = await os.query()
    expect(total).toBe(1)
    expect(items[0].slug).toBe('test')
  })
})

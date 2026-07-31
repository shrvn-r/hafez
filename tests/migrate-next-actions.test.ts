// tests/migrate-next-actions.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { parseFilePath, serializeFile } from '../src/vault.js'
import { migrateNextActions } from '../src/migrate-next-actions.js'

const TMP = join(tmpdir(), 'hafez-test-migrate-na-' + Date.now())
const VAULT = join(TMP, 'vault')

beforeAll(() => {
  mkdirSync(join(VAULT, 'entities'), { recursive: true })

  // Entity with next-action
  writeFileSync(join(VAULT, 'entities/has-action.md'), serializeFile(
    { name: 'Has Action', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01', 'next-action': 'Deploy to VPS and test' },
    '## Purpose\n\nSome purpose.\n\n## Session Log\n'
  ))

  // Entity without next-action
  writeFileSync(join(VAULT, 'entities/no-action.md'), serializeFile(
    { name: 'No Action', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01' },
    '## Purpose\n\nSome purpose.\n\n## Session Log\n'
  ))

  // Entity with null next-action
  writeFileSync(join(VAULT, 'entities/null-action.md'), serializeFile(
    { name: 'Null Action', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-01', 'next-action': null },
    '## Purpose\n\nSome purpose.\n\n## Session Log\n'
  ))
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('migrate-next-actions', () => {
  it('dry run reports entities with next-action', () => {
    const report = migrateNextActions(VAULT, false)
    expect(report.migrated).toBe(0)
    expect(report.candidates).toBe(1)
  })

  it('migrates next-action to ## Next Actions body section', () => {
    const report = migrateNextActions(VAULT, true)
    expect(report.migrated).toBe(1)

    const { frontmatter, body } = parseFilePath(join(VAULT, 'entities/has-action.md'))
    expect(frontmatter['next-action']).toBeUndefined()
    expect(body).toContain('## Next Actions')
    expect(body).toContain('- [ ] Deploy to VPS and test')
    expect(body.indexOf('## Next Actions')).toBeLessThan(body.indexOf('## Session Log'))
  })

  it('does not modify entities without next-action', () => {
    const before = readFileSync(join(VAULT, 'entities/no-action.md'), 'utf-8')
    migrateNextActions(VAULT, true)
    const after = readFileSync(join(VAULT, 'entities/no-action.md'), 'utf-8')
    expect(after).toBe(before)
  })

  it('is idempotent', () => {
    const before = readFileSync(join(VAULT, 'entities/has-action.md'), 'utf-8')
    migrateNextActions(VAULT, true)
    const after = readFileSync(join(VAULT, 'entities/has-action.md'), 'utf-8')
    expect(after).toBe(before)
  })
})

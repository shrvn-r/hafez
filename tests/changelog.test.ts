import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { gitChangelog } from '../src/git.js'
import { mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { simpleGit } from 'simple-git'

const TMP = join(tmpdir(), 'hafez-test-changelog-' + Date.now())
// Full ISO timestamp, not a bare date: git fills a date-only --since with the
// *current* time-of-day, which excludes commits made seconds ago and made this
// test flake whenever beforeAll crossed a second boundary.
const sinceDate = new Date(Date.now() - 120000).toISOString()

beforeAll(async () => {
  mkdirSync(join(TMP, 'entities'), { recursive: true })
  mkdirSync(join(TMP, 'knowledge'), { recursive: true })

  const git = simpleGit(TMP)
  await git.init()
  await git.addConfig('user.email', 'test@test.com')
  await git.addConfig('user.name', 'Test')

  // Commit 1: create an entity
  writeFileSync(join(TMP, 'entities', 'test-entity.md'), '---\nname: Test\n---\n')
  await git.add('entities/test-entity.md')
  await git.commit('create: test-entity')

  // Commit 2: update it
  writeFileSync(join(TMP, 'entities', 'test-entity.md'), '---\nname: Test Updated\n---\n')
  await git.add('entities/test-entity.md')
  await git.commit('update: test-entity')

  // Commit 3: create knowledge
  writeFileSync(join(TMP, 'knowledge', 'test-note.md'), '---\nname: Note\n---\n')
  await git.add('knowledge/test-note.md')
  await git.commit('create: test-note')

  // Commit 4: scaffold files — must never surface as changelog rows
  writeFileSync(join(TMP, 'entities', '.gitkeep'), '')
  writeFileSync(join(TMP, 'knowledge', '.gitkeep'), '')
  await git.add(['entities/.gitkeep', 'knowledge/.gitkeep'])
  await git.commit('init vault scaffold')
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('gitChangelog', () => {
  it('returns changelog entries for recent commits', async () => {
    const entries = await gitChangelog(TMP, sinceDate)
    expect(entries.length).toBe(3)
  })

  it('includes correct operations', async () => {
    const entries = await gitChangelog(TMP, sinceDate)
    const entityEntries = entries.filter(e => e.slug === 'test-entity')
    expect(entityEntries.some(e => e.operation === 'created')).toBe(true)
    expect(entityEntries.some(e => e.operation === 'updated')).toBe(true)
  })

  it('includes knowledge entries', async () => {
    const entries = await gitChangelog(TMP, sinceDate)
    expect(entries.some(e => e.slug === 'test-note' && e.kind === 'knowledge')).toBe(true)
  })

  it('filters non-.md scaffold files like .gitkeep', async () => {
    const entries = await gitChangelog(TMP, sinceDate)
    expect(entries.some(e => e.slug.includes('.gitkeep'))).toBe(false)
    // and the scaffold commit contributes no rows at all
    expect(entries.some(e => e.commit_message === 'init vault scaffold')).toBe(false)
  })

  it('returns today\'s commits for --since <today> (bare date = local midnight)', async () => {
    // Pins the root fix for "changelog --since <today> returns nothing":
    // git approxidate fills a date-only --since with the current time of day.
    const today = new Date()
    const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
    const entries = await gitChangelog(TMP, localDate)
    expect(entries.length).toBe(3)
  })

  it('returns empty for future date', async () => {
    const entries = await gitChangelog(TMP, '2099-01-01')
    expect(entries.length).toBe(0)
  })
})

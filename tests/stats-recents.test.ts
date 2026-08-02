// tests/stats-recents.test.ts
//
// Stats "Recently Touched"/"Recently Created" with day-granularity ties —
// the exact new-user vault shape that exposed the bug: every entity created
// the same day, so ORDER BY last_touched alone leaked SQLite row order
// (alphabetical-and-missing-newest lists). Ties now break on git commit
// time, then name for files with no commit history.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHafez } from '../src/index.js'
import { serializeFile } from '../src/vault.js'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { simpleGit } from 'simple-git'

const TMP = join(tmpdir(), 'hafez-test-stats-recents-' + Date.now())
const TODAY = new Date().toISOString().slice(0, 10)

// Commit order deliberately not alphabetical, so an alphabetical or
// row-order leak can't accidentally pass.
const COMMIT_ORDER = ['delta', 'alpha', 'golf', 'bravo', 'echo', 'charlie', 'foxtrot']

beforeAll(async () => {
  mkdirSync(join(TMP, 'entities'), { recursive: true })
  mkdirSync(join(TMP, 'knowledge'), { recursive: true })
  const git = simpleGit(TMP)
  await git.init()
  await git.addConfig('user.email', 'test@test.com')
  await git.addConfig('user.name', 'Test')

  // All entities share one frontmatter day; git commit times differ.
  // Seed times are relative to now (one hour ago, one minute apart) — fixed
  // wall-clock times like T10:00 sit in the future when the suite runs
  // earlier in the day, which inverted the tiebreak against commits made
  // during the test itself.
  const base = Date.now() - 60 * 60 * 1000
  let minute = 0
  for (const slug of COMMIT_ORDER) {
    writeFileSync(
      join(TMP, 'entities', `${slug}.md`),
      serializeFile(
        { name: slug, type: 'entity', status: 'active', created: TODAY, 'last-touched': TODAY },
        '## Context\n\n## Session Log\n',
      ),
    )
    const date = new Date(base + minute * 60_000).toISOString()
    minute++
    // Minimal env: simple-git refuses any *EDITOR var (unsafe-operations plugin)
    await git
      .env({ PATH: process.env.PATH!, HOME: process.env.HOME!, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date })
      .add(`entities/${slug}.md`)
      .commit(`create: ${slug}`)
  }
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('stats recents with same-day ties', () => {
  it('recently_created lists the 5 most recently committed, newest first', async () => {
    const os = createHafez({ vaultPath: TMP, git: { push: false } })
    const stats = await os.stats()
    expect(stats.recently_created.map(r => r.slug)).toEqual(
      [...COMMIT_ORDER].slice(-5).reverse(),
    )
  })

  it('recently_touched uses last commit time within the day tie', async () => {
    const os = createHafez({ vaultPath: TMP, git: { push: false } })
    // Touch the oldest-committed entity now (same frontmatter day, newer commit)
    await os.update('delta', { brief: 'touched last' })
    const stats = await os.stats()
    expect(stats.recently_touched[0].slug).toBe('delta')
    expect(stats.recently_touched).toHaveLength(5)
  })

  it('files with no commit history sort after committed ones, by name', async () => {
    // Hand-written file, never committed — same frontmatter day
    writeFileSync(
      join(TMP, 'entities', 'aaa-uncommitted.md'),
      serializeFile(
        { name: 'aaa-uncommitted', type: 'entity', status: 'active', created: TODAY, 'last-touched': TODAY },
        '## Context\n',
      ),
    )
    const os = createHafez({ vaultPath: TMP, git: { push: false } })
    await os.rebuildIndex()
    const stats = await os.stats()
    // Alphabetically first, but no git history — must not displace committed rows
    expect(stats.recently_created.map(r => r.slug)).not.toContain('aaa-uncommitted')
  })
})

// tests/stats-recents.test.ts
//
// Stats "Recently Touched"/"Recently Created" with day-granularity ties —
// the exact new-user vault shape that exposed the bug: every entity created
// the same day, so ORDER BY last_touched alone leaked SQLite row order
// (alphabetical-and-missing-newest lists). Ties now break on journal commit
// time, then name for files with no commit history.
//
// Runs against the in-memory Journal: commit times are seeded directly
// instead of crafting real git commits with forged author dates.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHafez } from '../src/index.js'
import { serializeFile } from '../src/vault.js'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createMemoryJournal } from './helpers/memory-journal.js'

const TMP = join(tmpdir(), 'hafez-test-stats-recents-' + Date.now())
const TODAY = new Date().toISOString().slice(0, 10)

// Commit order deliberately not alphabetical, so an alphabetical or
// row-order leak can't accidentally pass.
const COMMIT_ORDER = ['delta', 'alpha', 'golf', 'bravo', 'echo', 'charlie', 'foxtrot']

// One shared journal: the "touched" test's update must commit into the same
// time maps stats() reads.
const journal = createMemoryJournal()

beforeAll(() => {
  mkdirSync(join(TMP, 'entities'), { recursive: true })
  mkdirSync(join(TMP, 'knowledge'), { recursive: true })

  // All entities share one frontmatter day; journal commit times differ.
  // Seed times are relative to now (one hour ago, one minute apart) so a
  // commit made during the test itself always lands newest.
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
    journal.addedTimes.set(`entities/${slug}.md`, date)
    journal.modifiedTimes.set(`entities/${slug}.md`, date)
  }
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('stats recents with same-day ties', () => {
  it('recently_created lists the 5 most recently committed, newest first', async () => {
    const os = createHafez({ vaultPath: TMP, persistence: journal })
    const stats = await os.stats()
    expect(stats.recently_created.map(r => r.slug)).toEqual(
      [...COMMIT_ORDER].slice(-5).reverse(),
    )
  })

  it('recently_touched uses last commit time within the day tie', async () => {
    const os = createHafez({ vaultPath: TMP, persistence: journal })
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
    const os = createHafez({ vaultPath: TMP, persistence: journal })
    await os.rebuildIndex()
    const stats = await os.stats()
    // Alphabetically first, but no commit history — must not displace committed rows
    expect(stats.recently_created.map(r => r.slug)).not.toContain('aaa-uncommitted')
  })
})

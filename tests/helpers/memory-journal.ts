// tests/helpers/memory-journal.ts
// In-memory Journal adapter (see CONTEXT.md: Journal). Lets logic tests run
// against createHafez() with zero git setup: commits are recorded, sync is a
// local-only no-op, changelog/fileTimes serve whatever the test seeds.
//
// Fidelity contract (mirrors the git adapter's observable behavior):
// - commit() resolves normally and stamps fileTimes like a commit would.
// - sync() reports a remote-less vault, matching the README-default setup.
// Deliberately NOT modeled — covered on real repos by git.test.ts /
// merge.test.ts / integration.test.ts / operations-git.test.ts instead:
// - push retries, semantic merge, rebase repair, commit-failure cleanup
// - git's no-op on idempotent writes (the fake records a commit and bumps
//   modifiedTimes even when content is unchanged)
// - delete-then-re-add addedTimes (git reports the NEWEST add; the fake
//   keeps the first) and deletion stamps in modifiedTimes
// - changelog() ignores `since` and path filtering: it returns exactly what
//   the test seeded
import type { Journal, ChangelogEntry } from '../../src/types.js'

export interface RecordedCommit {
  written: string[]
  deleted: string[]
  message: string
}

export interface MemoryJournal extends Journal {
  commits: RecordedCommit[]
  /** Times served by fileTimes('modified') — vault-relative path → ISO time. */
  modifiedTimes: Map<string, string>
  /** Times served by fileTimes('added') — vault-relative path → ISO time. */
  addedTimes: Map<string, string>
  /** Entries served by changelog(); tests seed these directly. */
  changelogEntries: ChangelogEntry[]
}

export function createMemoryJournal(): MemoryJournal {
  const journal: MemoryJournal = {
    commits: [],
    modifiedTimes: new Map(),
    addedTimes: new Map(),
    changelogEntries: [],

    async commit(written, deleted, message) {
      journal.commits.push({ written: [...written], deleted: [...deleted], message })
      // Mirror git: modified = newest commit touching the file, added = the
      // commit that created it. Seeded times survive unless re-committed.
      const now = new Date().toISOString()
      for (const f of written) {
        journal.modifiedTimes.set(f, now)
        if (!journal.addedTimes.has(f)) journal.addedTimes.set(f, now)
      }
    },

    async sync() {
      return { pulled: false, pushed: false, remote: false }
    },

    async changelog() {
      return journal.changelogEntries
    },

    async fileTimes(mode) {
      return mode === 'added' ? journal.addedTimes : journal.modifiedTimes
    },
  }
  return journal
}

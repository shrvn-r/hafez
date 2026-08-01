# Changelog

## 1.0.2 — 2026-07-31

Data-safety release. Every fix below was verified against a reproduction
before and after; the sync fixes were driven by a real multi-machine vault
that lost data to the old conflict path.

### Fixed

- **Sync no longer destroys unpushed local commits on conflict.** The old
  semantic merge did `git reset --hard origin` and re-applied only the
  conflicting files — any other unpushed commit was silently discarded while
  sync reported success. Conflicts are now resolved *inside* the
  `pull --rebase` (merged content is written, staged, and the rebase
  continues), so every non-conflicting commit survives. The conflict/retry
  machinery, previously triplicated across `gitSync` and `gitCommitAndPush`,
  is now one shared code path.
- **Concurrent hafez processes no longer lose writes.** The write mutex was
  in-process only; two CLIs (or a bot plus a CLI) racing on one vault could
  drop session-log entries with both reporting ok. Mutations and sync now
  take a vault-level cross-process lock (`.hafez.lock`, via proper-lockfile)
  with retry/backoff and stale-lock takeover. New error code `VAULT_LOCKED`.
- **Concurrent remote appends are no longer discarded on merge.** Merge
  policy is now: append-only sections (Session Log, Next Actions, Evidence,
  Sources) union with dedup; scalar fields and sections resolve
  newest-wins by `last-touched`, local on tie. Previously everything outside
  Session Log / Next Actions was silently "local wins".
- **Path traversal via slugs is rejected.** Slugs like `../../outside/note`
  could read, overwrite, or delete `.md` files outside the vault through
  `read`, `update`, `promote`, and friends. Slugs are now validated at the
  single path-resolution choke point (path separators, leading dots, and
  drive colons rejected — names with spaces or non-Latin characters, as a
  hand-edited Obsidian vault contains, still work, and `slugify` now keeps
  non-Latin letters instead of collapsing them to an empty slug). A failed
  entity→knowledge promote also no longer deletes the file it just restored.
- **Corrupt `.hafez.db` self-heals.** The recovery path never ran
  (better-sqlite3 defers file access past the constructor the catch was
  wrapping), so a truncated or garbage index file crashed every command
  permanently. Recovery now covers the real failure point and clears stale
  `-wal`/`-shm` files before rebuilding. The index is a disposable cache —
  nothing is lost.
- **`batch()` failures leave a consistent vault.** A commit-stage failure
  (e.g. a raced `.git/index.lock`) now rolls all batch file writes back to
  their originals; a push-stage failure keeps the local commit and the
  updated index, matching its "changes saved locally" contract.
- `npm test` builds `dist/` first, so CLI end-to-end tests can no longer
  pass against stale code.

### Removed

- The pre-1.0 vault migrations (`hafez migrate types|next-actions|knowledge-v2`)
  and the deprecated input shims: `hafez create inbox` (use `hafez capture`),
  `--next-action` (use `--add-action`), and the positional link relation
  (use `--relation`). No vault created by a released version needs any of them.
  Passing `--next-action` now fails loudly rather than being silently ignored.

## 1.0.1 — 2026-07-31

### Fixed

- README: the npm 12+ install line now includes `--allow-remote=root` —
  npm 12 disables URL-tarball fetches by default, so the documented command
  failed with `EALLOWREMOTE` before reaching the install-scripts step.

## 1.0.0 — 2026-07-31

First public release.

Hafez (حافظ, "the keeper") is an agent-native personal knowledge vault:
markdown files with YAML frontmatter as the source of truth, a SQLite FTS5
read index, and git for history and sync.

- `hafez` CLI: entities, projects, captures, knowledge notes, and session
  notes with create / read / update / query / search / link / promote ops
- `hafez batch` — atomic multi-op mutations from JSON on stdin, one commit
  and one push per batch
- `hafez digest` — turn end-of-session context into a batch payload
  (`echo '<json>' | hafez digest | hafez batch`)
- `hafez help --agent` and `hafez schema <op>` — machine-readable API
  reference generated at runtime from the live Zod schemas
- `createHafez()` — the same operations as a Node.js library
- Bundled Claude Code skill (`skill/SKILL.md`) covering the full session
  lifecycle: context loading, mid-session vault ops, session-end digest

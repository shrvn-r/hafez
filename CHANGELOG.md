# Changelog

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

# AGENTS.md

Hafez — agent-native personal knowledge vault. Markdown files with YAML
frontmatter (entities, knowledge, sessions), SQLite FTS5 read index, git as
source of truth and sync. See `README.md` for concepts and the CLI overview.

## Working in this repo

```bash
npm install        # runs prepare → tsc → dist/
npm run build      # pure tsc, no side effects
npm test           # builds dist/ first, then vitest (CLI tests exec dist/cli.js)
npx vitest run tests/git.test.ts     # single file
npx vitest run -t "creates entity"   # by name
```

Requires Node.js 22+ and git.

## Orientation

- `src/index.ts` — `createHafez()` factory; all operations hang off it
- `src/cli/` — CLI router, subcommand handlers, markdown formatters
- `src/vault.ts` / `src/schema.ts` — file I/O and frontmatter validation
- `src/db.ts` — SQLite FTS5 read index (rebuilt from files; never source of truth)
- `src/git.ts` / `src/merge.ts` — commit/push with semantic conflict merging
- `skill/SKILL.md` — the bundled Claude Code skill (optional adapter; the CLI is the whole interface)

`hafez help --agent` prints the full operation reference; `hafez schema <op>
--examples` gives machine-readable schemas. Trust those over prose.

This repo receives squash-snapshot releases; development history lives in a
private tree. Issues and PRs welcome here.

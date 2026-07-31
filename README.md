# Hafez

**An agent-native personal knowledge vault.** *Hafez* (حافظ) is Persian for "the keeper — the one who memorizes," after the poet. It keeps a durable, structured memory for AI agents: plain markdown files you own, backed by SQLite full-text search and git.

## Why

AI agents forget everything between sessions. Hafez gives them a place to remember — projects, insights, decisions, session history — as a knowledge graph they can read, query, and write through a CLI.

The files stay yours. Everything is markdown with YAML frontmatter in a git repo: readable in any editor, Obsidian-compatible, diffable, and synced like code. The SQLite index (`.hafez.db`) is a disposable read cache rebuilt from the files; git is the source of truth and the sync mechanism.

## Setup

Hafez is a tool for agents — so let an agent install it. Paste this into
Claude Code (or any agent with shell access):

```text
Set up Hafez, an agent-native knowledge vault (github.com/shrvn-r/hafez):

1. Install the CLI (needs Node.js 22+ and git):
   npm install -g https://github.com/shrvn-r/hafez/releases/latest/download/hafez.tgz
   On npm 12+, append --allow-remote=root --allow-scripts=better-sqlite3
   (npm 12 blocks URL-tarball installs and install scripts by default;
   the SQLite bindings need their install script).
2. Check git identity is configured (git config user.name and user.email);
   if not, ask me for a name and email and set them with git config --global.
3. Create my vault — a git repo with entities/ and knowledge/ directories and an
   initial commit. Suggest ~/vault but ask me where I want it first.
4. Register it: hafez init --register <vault-path>
5. Install the bundled agent skill: copy skill/SKILL.md from the installed
   package ("$(npm root -g)/hafez/skill/SKILL.md") to ~/.claude/skills/hafez/SKILL.md
6. Read hafez help --agent, then verify end-to-end: create a test capture,
   hafez read it back, and show me hafez stats.
7. Tell me what you set up, and give me three example asks I can use in future
   sessions to see the vault working (e.g. "what am I working on?").
```

From then on, just mention your projects by name in any session — the skill
teaches the agent when to read and write the vault, no commands required.

### Manual setup

The same thing by hand:

```bash
# Install (Node.js 22+ and git required).
# On npm 12+, append: --allow-remote=root --allow-scripts=better-sqlite3
npm install -g https://github.com/shrvn-r/hafez/releases/latest/download/hafez.tgz

# One-time, if you've never used git on this machine:
#   git config --global user.name "Your Name"
#   git config --global user.email "you@example.com"

mkdir -p ~/vault/entities ~/vault/knowledge
cd ~/vault && git init && git commit --allow-empty -m "init vault"

hafez init --register ~/vault           # remember this vault (one-time)
hafez init                              # show current vault resolution

# Claude Code skill (optional but recommended)
mkdir -p ~/.claude/skills/hafez
cp "$(npm root -g)/hafez/skill/SKILL.md" ~/.claude/skills/hafez/SKILL.md
```

On npm ≤11, `npm install -g github:shrvn-r/hafez` also works (npm 12 disables
git installs by default). An npm registry package is planned; GitHub is the
distribution channel for now.

## Quick start

Whether you drive it or an agent does, the CLI is the whole interface:

```bash
# Create a project
hafez create entity "Auth Refactor" --type project \
  --description "Move auth service to JWT" --add-action "Write migration plan"

# Quick capture for later triage
hafez capture "Look into passkeys" --notes "Saw this mentioned in an RFC"

# Read it back
hafez read auth-refactor

# Query
hafez query --filter active --type project
hafez query --kind knowledge --domain security

# Full-text search across the whole vault
hafez search "token rotation"

# Record progress
hafez update auth-refactor --log "progress: JWT flow implemented" --agent claude
hafez update auth-refactor --complete-action "migration plan"
```

Every mutating command commits to git and syncs with the remote (if one is configured).

## Core concepts

Three kinds of documents, all markdown + YAML frontmatter:

- **Entities** (`entities/*.md`) — the things you're working on. Types: `capture` (inbox item), `entity` (anything worth tracking), `project` (has outcomes). Statuses: `active | paused | done`. Bodies start from a per-type template (capture: `## Notes`; entity: `## Context`; project: `## Purpose` + `## Goals`) plus a `## Session Log` of dated agent entries; `## Brief` (freeform handoff context) and `## Next Actions` (checkbox list) appear when first written to.
- **Knowledge** (`knowledge/*.md`) — durable insights that outlive any one project. Subtypes `insight | plan`; confidence levels `observation → pattern → principle` (promoted manually). Bodies hold `## Synthesis`, `## Evidence`, and `## Sources` — evidence accumulates over time via `--add-evidence`.
- **Sessions** (`sessions/*.md`) — session summaries written via `batch`, kept as history, not indexed.

Frontmatter at a glance:

| Field | Entities | Knowledge |
|---|---|---|
| `name`, `created` | required | required |
| `type`, `status`, `last-touched` | required | — |
| `description` (one-line summary) | optional | optional |
| `domain` (string[]), `tags`, `related` | optional | optional |
| `parent` (slug) | optional | — |
| `resource` (canonical URI) | optional | — |
| `subtype`, `confidence` | — | optional |

Links (`parent`, `related`) are validated — they must point at slugs that exist. `hafez validate` checks vault integrity.

## CLI overview

| Command | What it does |
|---|---|
| `hafez read <slug> [--depth frontmatter\|summary\|full]` | Read an entity or knowledge note |
| `hafez query [--filter active\|paused\|done\|stale\|capture\|all] [--type] [--kind entity\|knowledge\|all] [--domain] [--tag] [--parent] [--related-to] [--limit]` | Filter and list |
| `hafez search <terms> [--kind ...]` | FTS5 full-text search |
| `hafez create <entity\|knowledge> <name> [flags]` | Create a document |
| `hafez capture <name> [--notes]` | Quick inbox capture |
| `hafez promote <slug> <entity\|project\|knowledge>` | Promote a capture upward |
| `hafez update <slug> [flags]` | Status, brief, actions, session log, synthesis, evidence… |
| `hafez link / unlink <slug> <target> --relation <parent\|related>` | Manage relationships |
| `hafez batch [--dry-run]` | JSON ops on stdin → atomic multi-op, single git commit, rollback on failure |
| `hafez stats` | Vault summary: counts, stale items, recents |
| `hafez changelog --since 7.days.ago` | Git-derived change history |
| `hafez sync` | Pull remote, push local commits (semantic merge on conflicts) |
| `hafez validate` / `hafez index rebuild` | Integrity check / rebuild the read index |
| `hafez schema [op] [--examples]` | Machine-readable JSON schema for every operation |
| `hafez export --okf [--out <dir>]` | Read-only OKF v0.1 bundle export |

This is not exhaustive — `hafez help --agent` prints the full, always-current reference. Add `--json` to any command for structured output.

## Library usage

```typescript
import { createHafez } from 'hafez'

const os = createHafez({ vaultPath: '/path/to/vault' })

const slug = await os.create('entity', 'New Project', {
  type: 'project',
  brief: 'Context here',
  add_action: 'Start design',
})

await os.update(slug, { status: 'active', add_action: 'Write tests' })

const { items } = await os.query({ filter: 'active', type: 'project' })
const results = await os.search('auth pattern')
const note = await os.read(slug, 'full')

// Atomic multi-op — single git commit, rollback on failure
await os.batch([
  { op: 'update', slug, fields: { status: 'done' } },
  { op: 'create', kind: 'knowledge', name: 'What we learned', fields: { domain: ['auth'] } },
])
```

Writes are serialized through an internal mutex, so a single `Hafez` instance is safe to share.

## Agent integration

Hafez is built to be operated by agents:

- **Claude Code skill** — the package bundles a skill (installed in [Setup](#setup)) covering the full session lifecycle: loading context at session start, vault ops mid-session, and a session-end digest.
- **`hafez help --agent`** — a complete API reference designed to be loaded into an agent's context.
- **`hafez schema <op> --examples`** — JSON schemas with working examples for every batch operation, so agents can self-correct.
- **`hafez batch`** — apply a whole session's worth of updates atomically from a single JSON payload. Validation errors report every bad op at once with did-you-mean hints.
- **Markdown-native output** by default, `--json` everywhere for machine consumption.

## Vault discovery

The CLI resolves the vault in order:

1. `--vault <path>` flag (explicit, highest priority)
2. `~/.config/hafez/vault` (or `$XDG_CONFIG_HOME/hafez/vault`) — a plain-text file containing the vault path, written by `hafez init --register`

If the config points at a path that isn't a vault, the CLI errors loudly instead of silently falling through.

## License

MIT

---
name: hafez
description: >
  Hafez vault — personal knowledge base of captures, entities, projects,
  and knowledge notes (with subtypes: insight, plan). Use when the user says /hafez, asks to query the vault
  ("what am I working on?", "show active projects", "what's stale?"), wants to
  read or create an entity, or references Hafez directly. Also use at session
  start to load context for identifiable topics, and at session end to record
  a digest. Even if the user just casually mentions a project by name,
  use this skill to check if it's a Hafez entity.
---

# Hafez — Vault Operations

All operations use the `hafez` CLI. No file manipulation — the CLI handles reads, writes, validation, and git.

If `hafez` is not installed, or `hafez init` reports no vault, stop and follow the setup in the project README (github.com/shrvn-r/hafez) before using this skill. If the vault exists but is empty, run `hafez onboard` and follow what it prints.

## CLI Reference

Run `hafez help --agent` for the complete, always-current API reference including all commands, flags, batch schema, and valid enum values.

Quick reference for common operations:

| Situation | Command |
|-----------|---------|
| Read an entity | `hafez read <slug>` |
| Active projects | `hafez query --filter active` |
| Stale items | `hafez query --filter stale` |
| Full-text search | `hafez search "<terms>"` |
| Search knowledge only | `hafez search "<terms>" --kind knowledge` |
| Create entity | `hafez create entity "<name>" --type project [--purpose "text"] [--description "text"] [--resource "uri"] [--brief "text"] [--add-action "task"]` |
| Quick capture | `hafez capture "<name>"` |
| List inbox captures | `hafez query --filter capture` |
| Update entity | `hafez update <slug> --brief "text" --add-action "task"` |
| Complete action | `hafez update <slug> --complete-action "substring"` |
| Session log | `hafez update <slug> --log "progress: summary" --agent claude` |
| Link entities | `hafez link <slug> <target> --relation related` |
| Promote | `hafez promote <slug> <target>` (capture→entity/project/knowledge, entity→project) |
| Add synthesis to knowledge | `hafez update <slug> --synthesis "text"` |
| Add evidence to knowledge | `hafez update <slug> --add-evidence "text"` |
| Add source to knowledge | `hafez update <slug> --add-source "url"` |
| Export OKF bundle | `hafez export --okf [--out <dir>]` (re-export overwrites, never deletes) |
| Digest session → batch | `echo '{...}' \| hafez digest \| hafez batch` |

Note: `--insight` is an alias for `--synthesis`.

## Session Start — Context Loading

When a topic is identifiable from the user's first message:

1. Run `hafez read <slug>` to load entity context
2. If the entity has a `parent`, also read the parent at frontmatter depth: `hafez read <parent> --depth frontmatter`
3. Search for related knowledge (`hafez search "<topic>" --kind knowledge`) and read any relevant note: `hafez read <knowledge-slug>`
4. Present a brief context line: "Loaded context for {name} (status: {status}, next: {next_action})"

Don't load context speculatively. Only when you can identify a specific entity slug or topic.

## Mid-Session — Working With the Vault

| Situation | Action |
|-----------|--------|
| User asks "what am I working on?" | `hafez query --filter active` |
| User asks about stale items | `hafez query --filter stale` |
| User mentions a project by name | `hafez read <slug>` |
| New workstream emerges | `hafez create entity "<name>" --type project [--brief "context"] [--add-action "task"]` |
| Quick thought, no classification | `hafez capture "<name>"` |
| Promote capture to entity/project | `hafez promote <slug> entity` |
| Insight worth preserving | Search first (`hafez search "<topic>"`), then create or update |
| Entity relates to another | `hafez link <slug> <target> --relation related` |
| Thread belongs to a project | `hafez link <slug> <parent> --relation parent` |
| Knowledge needs new synthesis | `hafez update <slug> --synthesis "text"` |
| Knowledge backed by new evidence | `hafez update <slug> --add-evidence "text"` |
| Knowledge has a source to cite | `hafez update <slug> --add-source "url"` |
| Need children of a project | `hafez query --parent <slug>` |
| Need related entities/knowledge | `hafez query --related-to <slug>` |
| Search for something | `hafez search "<terms>"` |
| Set handoff context | `hafez update <slug> --brief "context"` |
| Set one-line description | `hafez update <slug> --description "summary"` |
| Set resource URI (entity) | `hafez update <slug> --resource "https://..."` |
| Add a next action | `hafez update <slug> --add-action "task"` |
| Complete a next action | `hafez update <slug> --complete-action "task"` |
| Rebuild stale index | `hafez index rebuild` |
| Pull latest from remote | `hafez sync` |

### Ingest Reflex — Before Creating New Knowledge

Before creating a new knowledge note, always check if one already exists:

```bash
hafez search "<topic>"
hafez search "<topic>" --kind knowledge
```

If a related note exists, update it rather than creating a duplicate. Use `--synthesis` to revise the main insight text, `--add-evidence` to append supporting evidence, or `--add-source` to cite a new source.

Only create a new note when no existing knowledge covers the topic.

### Wiki Links in Knowledge Notes

When writing or updating knowledge note prose (brief, synthesis, insight body), use `[[wiki links]]` to reference related entities and knowledge naturally. This makes the vault navigable as a wiki:

- Reference related projects: `[[project-slug]]`
- Reference other knowledge: `[[knowledge-slug]]`
- Reference people or areas: `[[entity-slug]]`

The CLI does not enforce link syntax — write them naturally in the prose content you pass to `--synthesis`, `--brief`, or `--insight`.

### Deliberate Ingest Pattern

When processing a source (document, conversation, research) to extract knowledge:

```bash
# 1. Search for existing coverage
hafez search "<topic>" --kind knowledge

# 2a. If exists — update it
hafez update <slug> --synthesis "Revised insight" --add-source "url"
hafez update <slug> --add-evidence "New evidence from source"

# 2b. If new — create it
hafez create knowledge "<name>" --related slug1,slug2

# 3. Then update the note body via --synthesis with wiki links to related notes
hafez update <slug> --synthesis "Insight text referencing [[related-slug]]"
```

## Batch Operations

**Rule: Use `hafez batch` when making 2+ mutating calls.** Individual commands auto-commit after each call (and push, when the vault has a remote). Running multiple individual commands back-to-back causes git push races on synced vaults. Batch does all operations in one commit + one push.

```bash
echo '[
  {"op":"update","slug":"foo","fields":{"status":"done"}},
  {"op":"update","slug":"foo","fields":{"session_log":{"type":"progress","summary":"Shipped it","agent":"claude"}}},
  {"op":"update","slug":"bar","fields":{"add_action":"Write tests"}},
  {"op":"create","kind":"entity","name":"New Thing","fields":{"type":"project","brief":"Context here.","add_action":"First task"}},
  {"op":"create","kind":"knowledge","name":"Insight","fields":{"related":["foo"]}},
  {"op":"create","kind":"session","name":"2026-04-06 Session","fields":{"synthesis":"Summary text"}},
  {"op":"update","slug":"k1","fields":{"synthesis":"Updated synthesis text"}}
]' | hafez batch
```

Batch output includes created slugs: `Batch complete: 3 operations (created: new-thing, insight)`

For a single operation, individual commands are fine — they auto-sync.

## Session End — Digest

At the end of a working session (or a natural breakpoint), record what happened:

1. Identify the entities touched this session — read, updated, or created, or whose code was worked on. If unsure whether a name maps to an entity, run `hafez search "<term>"`.
2. If no entities were touched (pure tooling work with no vault relevance), skip the digest.
3. Pipe session context through digest into batch (`session_date` is today's real date):

```bash
echo '{
  "entities_touched": ["slug-1", "slug-2"],
  "decisions": ["Decision made", "Another decision"],
  "narrative": "One to three sentence cross-cutting summary.",
  "session_date": "2026-07-31",
  "agent": "claude"
}' | hafez digest | hafez batch
```

Digest adds a session log entry to each touched entity and creates a session note linking them all. Authoritative field docs: `hafez schema digest`.

Digest itself is pure — it only prints batch JSON; `hafez batch` is what writes. If you are unsure the slugs exist, run `hafez digest` alone first: unknown slugs warn on stderr (they are omitted from the output). Fix `entities_touched`, regenerate, and pipe to batch **once** — re-running the full pipe after a successful batch creates a duplicate session note.

**Mid-session updates and the digest coexist.** Point-in-time updates (`--status done`, `--complete-action`, brief changes) happen as they happen — don't defer them to session end. Digest adds the overall narrative on top. Do NOT hand-write session log entries (`--log`) right before digesting — digest builds the session summary itself. Use `--log` mid-session only for significant milestones (deployed, merged, discovered a bug).

## Knowledge Maintenance

Knowledge notes are the primary durable output of sessions — not a side effect. Treat the vault as a living wiki.

**Active maintenance pattern:**
1. At session start: search for knowledge relevant to the topic
2. During work: when insights emerge, search before creating — update existing notes first
3. Use `[[wiki links]]` in knowledge prose to connect related concepts
4. At session end: review what was learned and update or create knowledge notes

**Periodic lint** (run at session end or on demand):
```bash
hafez validate
hafez query --kind knowledge --filter stale
```
Surface orphaned notes (no related links) and stale knowledge for review or archival.

**Knowledge boundary:** before writing an insight down, ask where it belongs. Useful beyond the current session or repo → vault knowledge note. Specific to one repo's code or workflow → that repo's own docs (CLAUDE.md, README, comments), not the vault.


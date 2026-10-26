# Changelog

## 2.4.0 — 2026-10-26

An entity's `resource` is a list of the places its work lives, the Block
asks for it, and the SessionStart hook prints only the folder match.

### Highlights

- **`resource` holds every place the work lives.** A repo URL and a local
  checkout, or several repos, on one entity. `--resource` repeats on
  `create entity` and `update`; each value appends and a duplicate is
  skipped (two URLs equal after normalisation count as one). `update
  --resource ""` clears every value; `""` beside a value is a usage error
  and nothing is written. The `read` header joins the values with ` · `,
  the SessionStart hook matches any of them, and the OKF export writes the
  first as `resource` and all of them under `resources` when there are
  several. A `resource` written as a single string still reads and is
  rewritten as a list on the entity's next write.
- **`--resource .` is this folder.** It resolves to the git root's `origin`
  URL as configured, else its first remote (credentials dropped), else the
  main checkout's root path, else the working dir; a subfolder or a linked
  worktree resolves to the repo. `create entity`, `update` and `batch`
  (`"resource": "."`) resolve it the same way, and `batch --dry-run` shows
  the resolved value.
- **Agent Contract v4: the Block's create line carries `--resource <. if
  the work lives in this folder>`**, so an entity made from a session
  is found by the hook in later sessions. In a git folder no entity
  matches, the hook prints one line asking for `--resource .` on the next
  write. `hafez upgrade` reports the installed Block and `hafez` skill as
  stale; `hafez onboard --install` refreshes them.

### Fixed

- **A relative vault path worked as no vault at all.** `--vault .` (or a
  relative `vaultPath` to `createHafez`) read every entity as a knowledge
  note and refused entity writes. The path is resolved to absolute once at
  the entry, before anything reads it.
- **Two processes syncing the index could fail on `UNIQUE items.slug`.**
  Two write-capable processes that saw the same changed note both deleted
  its row, then both inserted it. Each note is now replaced in one
  transaction that re-checks the file hash under the lock, so the second
  process waits and skips.

### Changed

- **The SessionStart hook prints only the folder match, never the Block.**
  The instructions file already carries the Block, so the hook's copy was
  loaded twice per session. No match in a non-git folder prints nothing.
- **Library: `resource` is `string[]`.** `EntityFrontmatter.resource` was
  `string | null`; create takes a string or a list, update appends, and
  `null`, `''` or `[]` clears. `UpdateResult` gains `resource_added`. A
  literal `.` through the library is `VALIDATION_FAILED`; only the CLI and
  `batch` resolve it.
- **Index schema v14.** Run `hafez index rebuild` after upgrading.

## 2.3.0 — 2026-10-25

A live graph of the vault in the browser, a health check that says what to
re-place, and `related` links that keep both ends.

### Highlights

- **`hafez graph` opens a live graph of the vault.** Serves a page on
  127.0.0.1 (first free port from 4747; `--port N`, `--no-open`): entities
  and knowledge joined by parent, related and wiki-link edges, sized by
  open actions, glowing by recency, ringed when stale. A Live work /
  Everything scope, a Knowledge toggle, `/` search over every note, a local
  graph (depth 1 or 2) around the selection, and a note panel with the
  Brief, aged actions, the Agent history and children. Left sidebar: Live
  work, Unlinked notes with the `hafez link` line that places them,
  Activity, and tag/domain Highlight chips. Any writer's commit pulses the
  notes it touched within about 2 s; Follow moves the camera to them.
  `hafez graph <slug>` opens focused on a note; scope, focus and depth live
  in the URL. `hafez graph --json [--layers tag,domain,session]` prints the
  structure instead. Library: `graph()`.
- **`hafez health` lists what placement would change.** Read-only, exit 0,
  `--json` for agents: unsplit workstreams, names recurring across an
  entity's log, a parent's log leaking a child's work, one-way `related`
  edges and unlinked `[[slug]]` mentions (each with the `hafez link` line
  that closes it), and knowledge notes that restate a decision. It applies
  nothing; the `hafez` skill carries the procedure (propose by kind, apply
  only what you confirm). Library: `health()`.
- **`related` is symmetric.** A same-kind `related` link (entity↔entity,
  knowledge↔knowledge) now writes both ends in one commit, through `link`,
  `unlink`, `create` and `update`; deleting a knowledge note drops the
  back-edges it owns. Cross-kind links stay one-way, and an existing one-way
  link is left as it is (`hafez health` lists them).
- **A parent's `read` lists its children.** The header carries the child
  count with their open actions and a `hafez read` line for the five most
  recently touched, plus a workstream line for each unsplit family of
  actions; `--json` gains `children`, `children_total` and `workstreams`.
- **`changesSince(cursor)`** in the library: the notes created, updated or
  deleted since a history cursor, from any writer. `changelog()` takes a
  `limit` and each entry carries its commit hash.
- **README: "Where your judgement matters".** The calls that stay yours:
  child or related, split a workstream or not, decision or lesson, retire
  or delete, and reading `hafez health`.

### Fixed

- **Saved sessions fill their own sections.** `hafez-save` put the
  decisions and touched entities inside Summary, leaving Decisions and
  Entities Touched empty. They now land one bullet per decision and one
  `[[slug]]` per entity. A session saved before still counts as saved.
- **`hafez upgrade`'s dev-checkout step runs `npm ci`** between the pull
  and the build, so a changed `package-lock.json` no longer breaks the
  build.

### Changed

- **Parent subsumes related.** A `related` that names the entity's parent
  or one of its children, or an `update --parent` naming a related entity,
  is rejected with `VALIDATION_FAILED`.
- **The Block gains placement rules.** A workstream too big for one action
  becomes a Child with its actions moved; `create` takes
  `--parent <slug you read, or its parent>`; work a child owns is written
  there. `hafez upgrade` reports the installed Block as stale;
  `hafez onboard --install` refreshes it.
- **One index sync per CLI command.** An entity `read` on a WSL-mounted
  vault went from about 2.2 s to 1.3 s. The library still syncs before
  every read.
- **Index schema v13.** Run `hafez index rebuild` after upgrading.

## 2.2.0 — 2026-10-18

Session notes are readable and queryable, the archived log is one flag away
from its entity, Claude Code cloud sessions get a setup script, and Hafez
runs natively on Windows.

### Highlights

- **Sessions are indexed.** The notes `hafez-save` writes (`sessions/*.md`)
  were the one kind the CLI could not read back. `read <session-slug>` shows
  one (no Footer: a session is written once, never updated). `query --kind
  session` lists them newest first, with `--since`/`--before`, sort and
  paging; `query --kind session --related-to <entity>` returns the sessions
  that touched an entity, and the entity's `read` header carries a
  `sessions:` line (count, latest day, that query) while any did. The
  library gains `query_sessions()`. The index rebuilds once on first use.
- **`read <entity> --archive` prints the archived log.** The entries
  `entities/archive/<slug>-log.md` holds, as written. The archive stays out
  of the index and out of search; it is reached from its entity on purpose.
  The entity's header carries an `archive:` line (entry count, the command)
  while the file exists. Library: `archive(slug)`.
- **`hafez onboard --cloud --vault-repo <owner>/<repo>`** prints the setup
  script for a Claude Code cloud session: it installs Hafez, registers the
  vault when it is attached, and writes a Block with one rule more, which
  attaches, clones and registers the repo when a session starts without a
  vault. The script never clones the vault itself (no credentials at
  setup); no step fails session start. `onboard`, `upgrade` and the
  install check recognise a cloud Block by its begin marker.
- **Native Windows.** The suite is green on Windows and CI runs it there.
  Fixed on the way: a `promote` left its source deletion unstaged and the
  tree dirty; `index.md` was never regenerated; `stats` recents missed the
  same-day tie-break; `onboard --block` never matched a resource equal to
  the git root (git's `C:/` against `C:\`); `changelog --since` and
  `query --since` could disagree about where a day starts. Checkouts are
  LF everywhere (`.gitattributes`).
- **`Hafez.close()`** releases the SQLite index handle (idempotent; the
  next call reopens it). Call it before deleting a vault: Windows cannot
  remove a directory holding an open file. The CLI closes its instance on
  every entry point.

### Fixed

- **A push or sync that hit a vault-file conflict could hang** waiting for
  an editor. Hafez's own git calls now run with `GIT_EDITOR=true`, which
  outranks `core.editor`, `VISUAL` and `EDITOR`.

### Changed

- **`--kind all` is literal: sessions included.** `search` and `query`
  default to the working set, entities and knowledge, so a session note
  (which names every entity it touched) never crowds out the note being
  looked for. `--kind session` reaches them alone. `--related-to` narrows
  by `--kind`; `delete` removes a session note; `validate` counts sessions
  and reports a broken `related` (a session with no `related` is never an
  orphan). A `read` miss offers session slugs among the closest; a create
  cannot take a slug a session holds.
- **Git read failures throw instead of reading as empty.** `changelog` and
  `stats` on a vault whose git is unusable (not a repository, a `GIT_DIR`
  pointing elsewhere, a gitfile whose worktree is gone) now fail with
  `GIT_READ_FAILED`, exit 8, carrying git's message. Only an unborn
  history reads as empty.
- **The Block gains a decision trigger.** A decision made goes into the
  repo's own decisions record when it keeps one, with a decision log entry
  on the owning entity; otherwise into the save's decisions, as before.
  "Work landed" now targets the entity that owns the work, not the one
  read this session. `hafez upgrade` reports an installed Block as stale
  once; `hafez onboard --install` refreshes it.

### Security

- **simple-git 4** closes GHSA-x6jw-m9v5-85vh (critical),
  GHSA-858h-whjf-mvg5, GHSA-g4wm-2vf7-vfgr and GHSA-v5rq-49vh-5v5c. Its
  child-env guard is opened in full, so a shell's `GIT_SSH_COMMAND`,
  `GIT_AUTHOR_*`, `GIT_EXEC_PATH` or `GIT_CONFIG_*` still reaches git as
  it did before. js-yaml, nanoid and source-map-js patched alongside.

## 2.1.0 — 2026-10-17

Tick or remove several next actions in one update, and Hafez now finds the
1.x instructions section that older installs left behind.

### Highlights

- **`--complete-action` and `--remove-action` repeat**, like `--add-action`.
  One `hafez update` can tick and remove several actions in a single commit,
  e.g. `--remove-action 4c1e --remove-action 9b20 --complete-action 0a1b`.
  Every query matches the list as it was before the update; two queries
  naming the same line are an error. Batch and the library take the array
  fields `complete_actions` / `remove_actions` (at least one item each).
  `hafez --help` marks the three repeating flags.

### Fixed

- **A leftover 1.x section is no longer mistaken for invoke-only.** Hafez
  1.2–1.4 had you paste a `## Hafez — Session Memory` section with no
  markers. `hafez upgrade` now reports that install as always-on (legacy)
  and puts the section's removal first; `--json` carries
  `integration.legacy`. Bare `hafez onboard` names it in the status and
  puts its removal ahead of the install.
- **`onboard --install` names the 1.x section too.** In either Mode it
  still installs, then prints the section's file and line with the removal
  step, so the old text no longer loads beside the Block unnoticed.
  Hafez never deletes the section: with no markers, its end is unknown.

## 2.0.0 — 2026-10-09

The agent contract release. Every surface an agent reads (the Block, both
skills, and the output of `read`, `update` and `onboard`) now comes from one
source and ends with the next command to run, and `hafez onboard` installs
and checks the integration itself. Major version because some exported
library types, `help --agent` and the skill file layout changed: see
**Changed** and **Removed**.

### Highlights

- **Every `read` ends with a write line you can run.** At every depth,
  `read` ends with the Footer: one `hafez update <slug> …` line filled in
  for that note's kind, type and subtype (a capture gets the `promote`
  line), so writing back never needs a flag lookup. `read --json` carries
  it as a `writes` op object.
- **Handles on open actions.** `read` shows a short hex Handle (at least
  four characters) in front of each open next action, and
  `--complete-action` / `--remove-action` (and the batch fields) take a
  Handle or text. Any prefix of four or more hex characters that names
  exactly one open line works, so handles from an earlier `read` still
  resolve after a sibling is ticked, removed or added. `read --json` open
  actions carry `handle`.
- **Action lines are dated and never lost.** Every add (create, update,
  batch, digest) stamps `(added YYYY-MM-DD)` with the local day; every
  reader strips the stamp, and older unstamped lines are left as they are.
  A removed or cleared action, and the oldest ticked ones once Next Actions
  holds ten or more (nine stay), move to the entity's archive log
  (`entities/archive/<slug>-log.md`) in the update's own commit, along with
  any sub-bullets or notes under them.
- **Stale actions are marked on `read` and named after an `update`** (#97).
  An open action older than the entity's `staleness-days` (default 14)
  since its added day reads `… (added 2026-08-01) · stale 62d`; an undated
  one reads `… · stale, undated`, whatever the entity's status. `read
  --json` open actions are `{handle, text, added, age_days, stale}` (undated:
  `added` and `age_days` null, `stale` true). While Stale lines remain on the
  entity, `update` success adds a second line: `2 stale actions remain:
  a3f9, 7c21. Tick what landed, drop what is dead.` An existing vault shows
  its whole undated backlog as stale on first read; expected.
- **A `read` miss offers the closest slugs.** An unknown slug prints up to
  five `hafez read` lines for the closest notes by name, slug and
  description (a typo or a cut-short word still matches), else a
  `hafez search` line, then the `create` line, on stderr with exit 1;
  under `--json`, `{slug, closest}` on stdout. `hafez list` stays an unknown
  command but now points at `hafez query --filter active`.
- **`create knowledge` refuses near-duplicates.** A name sharing all but one
  of the shorter name's significant words with an existing note (at least
  three) is refused with exit 5, naming each match with a ready `update`
  line; `--new` creates it anyway. A weaker resemblance creates the note and
  suggests one relate line. `batch` warns instead of refusing, `--dry-run`
  included.
- **`hafez onboard` installs and checks the integration.** `onboard
  --install --mode <always-on|invoke-only> [--harness <h>]` writes the
  `hafez` and `hafez-save` skills to `~/.claude/skills` and
  `~/.agents/skills` and, always-on, the Block between hash markers in the
  harness's instructions file; nothing outside the markers is written. A
  hand-edited Block is shown as a diff and left alone without `--confirm`.
  `onboard --remove` deletes both skills and every Block. Cursor gets the
  Block printed for manual paste. Bare `onboard` reports the vault and, per
  harness found, the Block, skills, hook and allowlist, then the script the
  agent follows; re-running walks only what is not current.
- **`onboard --block`, for a session-start hook.** Prints the Block, then a
  `hafez read` line for each entity whose `resource` (a path or a git
  remote URL) or slug matches the working directory, its git root, or a
  worktree's main repository, active first. Any failure, a bad flag
  included, prints nothing and exits 0, so a broken hook never blocks a
  session.
- **`hafez delete <slug>` and a batch `delete` op, for knowledge and session
  notes.** A duplicate note (a save that ran twice) can now be retired
  through the CLI instead of by hand. One op, one commit; the index drops
  the note. An entity is never deleted — the error points at
  `hafez update <slug> --status done`. A note that another entity or
  knowledge note links to (`parent`/`related`) is rejected, naming the
  referrers, so `validate` stays clean after every delete that lands; an
  `unlink` or a re-pointing `update` earlier in the same batch counts, in
  `--dry-run` and apply alike. Library: `os.delete(slug)` resolves to the
  kind deleted. (#88, closes #26)
- **`<command> --help` / `-h` prints that command's usage, exit 0.** It used
  to be an unknown flag; `update <slug> --brief x -h` wrote the brief, and
  `sync --help` pulled and pushed.
- **`--data` on `digest` and `batch`** takes the JSON payload as one
  argument, so every stage of the save pipe is a plain `hafez` command a
  harness allow rule can cover. Both skills use it, and say to write
  apostrophes as `’` inside the single-quoted JSON.
- **New fields:** `update --parent <slug>` (entity-only; the parent must
  exist), `update --body` (detail for the `--log` entry) and `create
  knowledge --confidence`. Batch `domain`, `tags` and `related` accept one
  comma string as well as an array, split like the CLI flags.

### Fixed

- **Next Actions fields in one `update` op compose as prune, tick, add.**
  `clear_actions` → `remove_action` → `complete_action` → `add_action(s)`.
  Apply ran the adds first and the clear last, so the natural "rebuild the
  list" payload (`clear_actions` + `add_actions`) committed an entity with
  no Next Actions section at all, and `remove_action` + `add_actions` matched
  the query against a list that already held the new lines — a query
  overlapping the replacement text removed the new line and kept the old,
  exit 0. Queries now see the list as it was before the op (so a remove
  and a complete that name the same line is an error, not a silent
  overwrite); the lines the op adds can never be cleared, removed or
  mis-matched by the same op, and completing the last open line while
  adding the next one edits the section in place — the checked line and
  the section's position both survive.
  `clear_actions` alongside a query field is statically contradictory and
  is rejected in the validate phase (visible in `batch --dry-run`) rather
  than failing at apply with "No matching action".
- **`update` reports each action query's match under its own name.**
  `complete_action` and `remove_action` in one op used to share a single
  `matched_action` slot, so the completed line's text was never reported.
  The result is now `{ completed_action?, removed_action? }` — library and
  `--json` alike. `matched_action` is gone, not aliased.
- **The library query path applied or dropped; now it applies or
  rejects.** `os.query({ confidence: 'pattern' })` typechecked, validated
  the value, was then never mapped into the query, and returned every
  active entity with exit 0. The mirror case existed on the knowledge
  branch, where `filter` / `type` / `parent` were neither validated nor
  applied. The CLI had rejected these since 1.3.0 — the rule lived only
  there, so an MCP wrapper, a library caller or an agent building opts as
  JSON got the silence. The rule now lives behind the read surface, so
  both callers get it; unified (`kind: 'all'`) queries still take opts
  from both sides, because they map both. `confidence` is also no longer
  declared on the entity opts type, so compile time and runtime say the
  same thing.
- **A unified query narrowed by `kind` rejects the same opts the dedicated
  branch does.** `queryUnified` maps both sides only under `kind: 'all'`.
  Passed `kind: 'entity'` or `kind: 'knowledge'`, the out-of-scope
  conditions landed on columns the selected kind leaves NULL, so
  `queryUnified({ kind: 'knowledge', filter: 'active' })` returned zero
  results with exit 0 — the same wrong answer the dedicated branches now
  refuse. `kind: 'all'` is unaffected, and it is the only shape the CLI
  produces.
- **A knowledge-only sort field on an entity query is rejected, not
  substituted.** `hafez query --sort-by reinforcement_count` returned
  entities in `last_touched` order and exited 0 — asking for one order
  and getting another, silently. Reachable from the CLI as well as the
  library. `reinforcement_count` and `last_reinforced` now fail with the
  same validation error the out-of-scope opts throw; knowledge and
  unified (`kind: 'all'`) queries still honour them, and the entity opts
  type no longer declares them.
- **Parent cycles are rejected.** `update`, `link` and `batch` refuse a
  `parent` that is the note itself or whose chain leads back to it, naming
  the cycle (`alpha → beta → alpha`); `validate` reports a cycle already on
  disk under Broken Slugs.
- **Stale entities count whole local days, like their actions.** `query`'s
  stale filter and `stats` compared against the current UTC time, so an
  entity exactly `staleness-days` old read as stale late in the day.
  `stats`' `days_since_touched` is now a whole local-day count.
- **Batch errors show the value sent**, never `got: undefined`.
- **Slugs drop the curly apostrophe:** `Token Rotation’s` slugifies to
  `token-rotations`, not `token-rotation-s`.
- **Flags and commands named after JavaScript built-ins** (`--constructor`,
  `hafez constructor`) are reported as unknown instead of failing as a
  repeated flag or crashing.

### Changed

- **Every entity update writes a session log entry.** An update with no
  `--log` gets a `progress` entry naming the fields written (`Updated
  brief, status`), on every path: CLI, batch, library. Updates that only
  touch actions are exempt, and knowledge notes never get one. The entry's
  agent is detected (`codex`, `claude-code`, else `agent`); `--agent`
  overrides it.
- **A flag given twice is a usage error** on every command, where the last
  value used to win silently. `--add-action` is the one repeatable flag:
  each repeat appends. `--body` without `--log` is a usage error.
- **`digest` fails on an unknown slug** in `entities_touched` (`NOT_FOUND`,
  naming them) instead of dropping it with a warning. A second save of the
  same session is recognised and skipped, so no duplicate log entries land.
- **`hafez upgrade` checks both skills and the Block by hash**, in both
  skill directories and each harness's instructions file, and prints the
  `hafez onboard --install` line that refreshes them; the hand-reconcile
  integration snippet is gone. Still writes nothing; every outcome exits 0.
- **`hafez help --agent` prints the `hafez` skill body** (#100). One text
  from one source, for an agent whose harness has no skill installed; the
  op catalogue, enum lists and batch examples it used to print are gone
  (`hafez schema <op> --examples` has them). The skill files are
  `skill/hafez/SKILL.md` and `skill/hafez-save/SKILL.md` (the old
  `skill/SKILL.md` is gone); `npm run install:local` copies both to
  `~/.claude/skills` and `~/.agents/skills`. Every surface — the Block, the
  skills, and samples of `read`, `update`, `create knowledge` and `onboard`
  output — is rendered from the same source and checked byte for byte in
  CI.
- **`read`: the `parent:` line stands alone and carries the parent's
  description** — `parent: platform (Shared services every product team
  builds on)`; a parent with no description, or one that cannot be read,
  is the slug alone. A plan's header shows `subtype: plan | status | domain`
  and `created | last-touched` in place of an insight's confidence and
  reinforcement lines.
- **Breaking (exported type):** `UnifiedQueryOpts` is now a union
  discriminated on `kind` rather than a single interface. `kind: 'all'`
  (or unset) still takes opts from both sides; `kind: 'entity'` takes the
  entity opts and `kind: 'knowledge'` the knowledge ones, so the
  combinations the read surface rejects at runtime are a compile error
  first. Code that wrote `interface X extends UnifiedQueryOpts` needs
  `X extends AllQueryOpts` (newly exported) or an intersection.
- **Exit codes moved to `hafez --help`** (#89). `--help` lists every exit
  code with its meaning, printed from the same table the error → exit
  adapter maps through (`EXIT_TABLE`, from which `EXIT_CODES` now
  derives); a test fails if the printed list and the table diverge.
  `help --agent` no longer carries an exit-codes section. The codes
  themselves are unchanged.
- **`hafez update` says what changed in one line, and a misuse returns the
  Footer** (#95). Success is `Updated <slug>: log added, 1 action ticked,
  1 action added.` — one phrase per change, the mechanised log included,
  nothing untouched named; `--json` carries the matched action text. A
  misuse — an unknown or repeated flag, a missing value, a bad `--log`, a
  value the Op Spec rejects, an action query no open line or more than one
  matches, no flag at all — prints the error, "Nothing was written.", then
  the Footer `read` shows for that slug, exit 2; a slug that names no file
  gets the `read` miss instead. A well-formed update to a missing slug
  prints the `read` miss, exit 1 (under `--json`, `read`'s `{slug,
  closest}` on stdout). Library: `UpdateResult` gains `logged` when a
  session log entry was written; "No matching action", "Ambiguous match"
  and a remove and complete naming the same line are now
  `VALIDATION_FAILED` (they were untyped errors, exit 1).

### Removed

- **Breaking (exported type):** `ValidationReport.oversized_related` is
  gone. It was a leftover from a removed related-list cap — always `[]`,
  never written to, yet still rendered as an "Oversized Related" section
  and counted toward `hafez validate`'s issue total. `validate --json`
  no longer carries the key.

## 1.4.0 — 2026-08-08

An update path that finally exists, a much faster CLI, and the largest
correctness sweep so far: a full-codebase review turned up roughly
twenty user-visible defects, several of them silently destroying vault
content.

### Highlights

- **`hafez upgrade`** — new command. Checks whether the installed hafez
  is behind the npm registry and whether the installed skill copy has
  drifted, then prints the exact update steps. It never installs: those
  steps install code and overwrite your agent instructions, so the
  privileged step stays yours. Runs pre-vault, so it still answers when
  the vault is unresolvable or the native binding is unbuilt — exactly
  when someone is upgrading. `--json` for machine consumption; every
  check outcome exits 0.
- **Plan lifecycle is reachable.** `status` on the `plan` knowledge
  subtype was documented and schema-validated but had no path to set it
  — only hand-edited files could carry one. Now settable at create
  (`--subtype plan --status active`) and via `update <slug> --status
  done`, across CLI, batch and library. `active | done`, no `paused`.
  Insights still reject it.
- **Non-vault CLI commands start ~5× faster.** Dispatch used to
  statically import the core factory on every invocation — and with it
  the SQLite native binding, git, and YAML parsing. Measured medians:
  `--version` 120ms → 23ms, `help` 123ms → 23ms, `init` 126ms → 52ms.
  Vault commands cost the same as before.
- **Writes stop paying for a full-vault re-parse.** `index.md` now
  renders from the index rows the mutation just updated: 300 entities
  9.0ms → 4.2ms, 1500 entities 30.9ms → 18.3ms, and the gap widens with
  vault size.

### Fixed

- **Section rewrites no longer delete sections.** Structural boundaries
  were derived too narrowly, so any file legitimately carrying a section
  outside its current type's contract — a merged capture's Notes, a
  plan-shaped note with no persisted subtype, a hand edit — had those
  headings demoted to plain text, and the next write silently dropped
  them. Boundaries now bind per file kind: every same-kind heading is a
  boundary. Captures also regain `Current State`, which adjacent
  rewrites had been deleting.
- **An empty flag value can no longer wipe the section it targets.**
  `--synthesis "$VAR"` with `$VAR` unset printed "Updated", exited 0,
  and left an empty section where a paragraph had been. Every
  non-nullable field that writes body text now rejects empty and
  whitespace-only values by name; `--brief ""` still clears, since null
  is its documented clear signal.
- **Conflict merge preserves what both sides wrote.** Three loss paths
  closed: same-day session-log entries from two machines, indented
  sub-bullets and notes under Next Actions, and heading-less archive log
  files that previously merged wholesale with one side winning.
- **Next Action edits stay inside Next Actions.** Completing or removing
  an action matched section-scoped but edited body-wide, so a Brief
  quoting an action got checked while the real action stayed open — and
  `$` patterns in action text were expanded during the replace.
- **Concurrent edits from outside hafez read as races, not bugs.** A
  vault file created or deleted by Obsidian, a hand `rm`, or a git
  checkout between validation and apply used to report "unreachable, file
  a bug" or silently overwrite the intruding file. Both directions now
  raise actionable `NOT_FOUND` / `SLUG_EXISTS`, and nothing is
  overwritten.
- **One calendar-day convention — the local day.** Stamps came from the
  UTC day while comparisons used the local one, so west of UTC after
  ~13:00 local a fresh entity was stamped tomorrow, `query --before
  <today>` excluded it, and `query --since` disagreed with `changelog
  --since` about the same mutation.
- **Search and query apply what you asked for.** Search dropped
  non-Latin queries entirely and crashed on a bare uppercase
  `NOT`/`OR`/`AND`; `query --kind all` silently returned entities only;
  the knowledge and related-to branches dropped `--filter/--type/
  --parent` and the time flags; typo'd `--filter` values ran unfiltered
  at exit 0. Every branch now honours or loudly rejects each flag, and
  enum, sort and paging values are validated for library callers too.
- **The index survives external change.** Re-indexing a hand-edited or
  pulled file left ghost terms behind (integrity-check reported the
  index malformed) and could make search return the wrong document;
  `index rebuild` ran outside the vault lock; and the change-detection
  watermark was stamped late enough that a file written mid-scan was
  skipped by every later sync, permanently stale.
- **Git operations that used to be dead ends.** Adding a remote to a
  previously local-only vault left the branch unpublished and untracked,
  so every subsequent mutation exited 4. Standalone promotes never
  committed at all and vanished from `changelog`. A batch creating then
  cross-kind-promoting the same slug rolled back entirely. `promote …
  knowledge` had no collision check and no mkdir. And `update` swept
  unrelated hand-edits of `entities/archive/` into its commits.
- **Input is applied or rejected, never quietly discarded.** `create`
  dropped whichever flags its kind branch didn't name; empty values to
  the action, evidence and source flags reported success and wrote
  nothing; the `insight` alias worked only through the CLI's batch
  parsing and was dropped on every library path; comma lists went
  untrimmed, so `--domain "ai, ml"` stored `" ml"` where `--domain ml`
  would never match it.
- **Smaller losses swept up:** wiki-links written `[[ with spacing ]]`
  were invisible to link parsing (Related coverage, mention harvesting);
  OKF export wrote a doc slugged `index` over the bundle's own
  `index.md`; worktree vaults skipped local-exclude setup, so the
  generated `index.md` wasn't kept out of git; a duplicate session op
  was a skip in `batch --dry-run` and an error in apply; and the
  better-sqlite3 "reinstall the bindings" hint matched the stack of
  *every* SQLite error, printing build advice over the real message.

### Changed

- **Unknown fields on the public library API are rejected** with the
  batch error shape instead of being silently dropped. Every mutation —
  single-op method or batch — now validates through the same strict
  table.
- **All six single-op methods adopt batch's failure policy**: a commit
  failure rolls files back, a push failure keeps the local commit.
  Previously five had no commit/push failure handling at all, so a
  commit failure left written-but-uncommitted files with a stale index.
- **A create field whose section the chosen template lacks rejects the
  whole op**, naming the available sections, instead of discarding the
  text — `--purpose` with `--type entity`, `--synthesis` on a plan. The
  text is never dropped and never redirected.
- `""` to an enum flag (`--status`, `--confidence`) rejects by name
  instead of no-opping; empty-string clearing extends from `--brief` to
  `--description` and `--resource`.
- `--vault --json` and a trailing `--vault` exit 2 with a usage error
  instead of consuming the next token as the vault path; a duplicate
  `--vault` is a usage error, not last-wins.
- An invalid `subtype` on the direct create path exits 2 instead of
  crashing with a raw TypeError.
- `index.md` membership follows the index: an entity carrying `name` but
  no `created` is skipped by the indexer and no longer appears. It was
  already absent from query, search and stats.
- `findSection` is no longer re-exported from the library API — it is
  Document-internal.
- The shipped skill was rewritten for clarity, and its broken
  stale-knowledge lint replaced with one that works.
- The index schema version bumped, so existing indexes rebuild once on
  first access.

## 1.3.0 — 2026-08-06

The CLI's error surface is now a documented contract — every command
declares its flags, and exit codes are a stable, documented map. Plus a
series of section-handling fixes for bugs that could corrupt document
bodies in hand-edited vaults.

### Highlights

- **Documented exit codes** — `hafez help --agent` now carries the full
  exit-code map, asserted by a contract test. Validation and usage
  errors exit 2; slug collisions (5), git commit failures (6), and vault
  lock exhaustion (7) get distinct codes instead of falling through to a
  generic 1. Agents can branch on the exit code to self-repair payloads.
- **Strict flag parsing** — every command parses through one declared-
  flag parser. Unknown flags and missing flag values are usage errors
  (exit 2) instead of silently ignored tokens, and a flag sitting where
  another flag's value should be (`--brief --clear-actions`) errors
  instead of storing the literal flag text.

### Fixed

- **Section headings with trailing whitespace** (common in hand-edited
  Obsidian vaults) were invisible to section lookups: `--log` created a
  duplicate Session Log section, the 10-entry archival never fired, and
  summary-depth reads returned the full body.
- **Mid-line mentions of section headings no longer corrupt bodies.**
  Current-state/synthesis updates and session-log inserts previously
  matched heading text anywhere in the body, which could truncate
  content or splice entries into the Brief. Section operations now
  target real headings only, and merge treats sections atomically.
- **`update --status` / `--confidence` reject invalid values.** They
  previously wrote straight into frontmatter (exit 0), after which the
  index skipped the file. Now exit 2, matching batch.
- **`promote` keeps its local commit when only the push fails.** An
  unreachable remote no longer rewrites files after the commit landed,
  leaving the worktree contradicting HEAD.
- **Batch updates archive session logs at 10 entries**, matching
  single-op updates and the documented contract.
- **Failed commits leave the read index consistent** — a failed promote
  or batch commit no longer drops rows from queries until a rebuild.
- **`export` and `digest` honor the error contract** — missing `--okf`,
  unknown export flags, and bad digest payloads all exit 2 (previously
  exit 1, or silently accepted).
- **Vaults under a directory named `sessions`** no longer classify every
  file as a session file.
- **`npm run build` keeps the CLI executable** — tsc recreated `dist/`
  without the exec bit, breaking a symlinked install until the next
  `install:local`.

### Changed

- **Usage errors exit 2** (previously 1) across all commands, including
  empty `digest` stdin.
- **`export --okf` skips dotfile `.md` files** (their slugs are
  unreachable by every operation); `validate` no longer counts them.
- **Batch validation reporting unified** — one summary header
  (`Batch failed validation: N invalid operations (0 of M applied)`),
  and a session create referencing an entity created earlier in the same
  batch now warns at validate time instead of silently skipping at
  apply.

## 1.2.0 — 2026-08-02

Fixes from the first fully-external onboarding (Windows 11, PowerShell,
npm 11): Windows is now a first-class platform, and `batch --dry-run` is
a real contract — it can no longer pass a payload the apply rejects.

### Highlights

- **`--file` on `batch` and `digest`** — the portable payload path for
  shells that can't pipe stdin to native executables (Windows PowerShell
  5.1, where the documented pipe idiom fails). Reads UTF-16LE and BOM'd
  UTF-8 (what PowerShell redirection actually writes) as well as plain
  UTF-8. The pipe idiom still works everywhere else.
- **Dry-run parity, by construction** — `batch --dry-run` now runs the
  same validate phase as a real apply: kind rules, slug existence, link
  targets, promote contracts. It also reports the derived slug for every
  create op, and same-batch references validate — create-then-link works
  in one payload.
- **Batch errors localise** — every validation error reads
  `op[<i>] (<op> <slug>): <message>`, and all errors for a payload
  surface at once. No more bisecting a 7-op batch by hand.
- **Slug contract documented** (`hafez help --agent` + skill): slug =
  deterministic slugify(name); batch executes sequentially, so later ops
  may reference earlier creates' slugs; collisions hard-error, so a
  wrong prediction can never hit an existing document.
- **`add_actions` on create** — seed a project with all its next actions
  in one create op, matching update's semantics.
- **Guided bindings failure** — an unbuilt better-sqlite3 module now
  prints the exact `--allow-scripts=better-sqlite3` remedy instead of a
  stack trace (npm 11+ blocks install scripts but reports success).
- **Library:** new `validateBatch()` on the Hafez interface.

### Fixed

- **Windows: every `update` failed.** Entity/knowledge classification
  used a POSIX-only path check, so on Windows all entities were
  classified as knowledge notes and every mutating update was rejected.
  Now separator-agnostic, with win32-path unit tests.
- **`changelog --since <today>` returned nothing.** git fills a bare
  date with the current time of day; date-only input is now normalised
  to local midnight, so "what happened today" works.
- **`stats` recents are true recency lists.** Same-day ties (the shape
  of every new vault) now break on git commit time instead of leaking
  index row order, which produced alphabetical lists missing the newest
  documents.
- **`.gitkeep` scaffold files** no longer surface as documents in
  `changelog`.
- **README install threshold corrected:** npm 11+ blocks install
  scripts, not 12+. Also noted: upgraders from this tool's earlier name
  should remove the old skill directory.

### Changed

- **`batch --dry-run --json`** now returns the full per-op validation
  report (derived slugs, errors, warnings) instead of
  `{valid, operations: <count>}`.

## 1.1.1 — 2026-08-01

Docs release: the README now says what Hafez is for, not just what it is
made of. No code changes.

### Changed

- **README identity rewritten.** Hafez is a knowledge and project vault
  shared between you and your agents: humans have short-term context,
  agents have session context, and the vault is where both remember. The
  Why now explains the division of labor — agents write through a CLI
  that enforces the schema (a malformed write fails, links must
  resolve), so every agent treats the vault the same and spends its
  context on content, not conventions.
- **Data freedom stated explicitly.** `hafez export --okf` is now
  covered in the README's "files stay yours" paragraph, with a link to
  the OKF v0.1 spec — Hafez's schema is stricter than OKF's, so the
  export loses nothing.
- **npm package description and AGENTS.md** aligned to the same
  identity.

## 1.1.0 — 2026-08-01

First-run onboarding release: a fresh install now has a guided path from
empty vault to working memory loop, and the docs follow the AGENTS.md
standard so any agent harness can drive Hafez.

### Highlights

- **`hafez onboard`** — an agent-directed first-run guide in the same
  spirit as `help --agent`. It walks the agent through a seeding
  interview (3–7 real projects with descriptions, briefs, and next
  actions; anything vague becomes a capture, written in one `hafez
  batch`), then a choice of integration level: an always-active block
  for the harness's global instructions file, or invoke-only. An empty
  vault now points to it from `hafez stats`.
- **Any harness, one interface** — onboarding names both conventions:
  `~/.claude/CLAUDE.md` for Claude Code, and the harness's global
  AGENTS.md (e.g. `~/.codex/AGENTS.md`) for everything on the AGENTS.md
  standard. The bundled Claude Code skill is an optional adapter; the
  CLI is the whole interface.
- **AGENTS.md ships** — the repo now follows the AGENTS.md convention
  itself: `AGENTS.md` is the canonical agent doc and `CLAUDE.md` is a
  thin import of it, so the two can never drift.

### Fixed

- `npm run install:local` restores the executable bit on `dist/cli.js`
  before linking — a bare `npm run build` previously left the local
  symlink pointing at a non-executable file.

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

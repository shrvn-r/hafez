---
name: hafez
description: >
  Hafez vault: the less common operations and the tool itself. Use when the
  user asks what is in the vault ("what am I working on?", "what's stale?"),
  wants to promote, link, unlink, delete, change a status or validate, asks
  to check the vault or clean it up, or wants to update or reconfigure Hafez
  ("upgrade hafez", "set up hafez"). Also the reference to read when no
  Hafez block is in your instructions.
hash: 51b62e879085
---

# Hafez

- Update an entity or note: `hafez read <slug>`. The end of its output shows the write command.
- Create an entity or a knowledge note: the two `hafez create` lines below.
- Save the session: the `hafez-save` skill. No skill: `hafez schema digest`.

Never ask the user whether to write to the vault. Write, then say so in one line naming the slug and what you did.
Update only what you have read this session. Not read yet: read it first.
Open actions on an entity you read are yours: tick what landed, drop what is dead. Lines `read` marks stale are due.

## Create

```
hafez create entity "<name>" --type <project|entity> --parent <slug you read, or its parent> --resource <. if the work lives in this folder> --description "<one sentence>" --brief "<where things stand>" --add-action "<next step>"
hafez create knowledge "<name>" --synthesis "<the insight>" --confidence <observation|pattern|principle> --related <slug>
```

A plan is `--subtype plan` without `--synthesis`. Cannot tell entity from knowledge: `hafez capture "<name>"`.

## Find

```
hafez query --filter <active|paused|done|stale|capture>
hafez search "<terms>" --kind <entity|knowledge|session|all>
hafez query --kind session --related-to <slug>
hafez stats
```

`search` and `query` reach entities and knowledge notes; `--kind all` adds the session notes, `--kind session` lists them alone, newest first. `hafez read <slug> --archive` prints an entity's archived log entries.

## Less common operations

```
hafez promote <slug> <entity|project|knowledge>
hafez link <slug> <target> --relation <parent|related>
hafez unlink <slug> <target> --relation <parent|related>
hafez update <slug> --status <active|paused|done>
hafez delete <slug>
hafez validate
hafez health
```

A plan's status is `active|done`. `delete` removes a knowledge or session note only; an entity is retired with `--status done`. `health` lists what placement would change and applies nothing.

A vault check ("check the vault", "clean up the vault", "what has drifted"): run `hafez health --json` and bring back proposals grouped by kind, never the rows. In a session that read an entity, lead with that entity's rows; the rest of the vault as counts.
One line per kind, with the count: the Workstreams to split (a `create entity … --parent` line each, named as the actions name it); the one-way edges and the unlinked mentions as one `hafez batch` of `link` ops, one commit; the restated decisions and the leakage pairs as a short list for the user to judge, nothing proposed.
Apply nothing until the user confirms a kind, not even a `link` line that looks safe; then one `batch` per kind.

Several writes that must land together go in one batch: a bare array, no wrapper. A slug is the name lowercased, apostrophes dropped, each other run of characters that are not letters or digits turned into one `-` and none left at either end, so a later op can name what an earlier one creates.

```
hafez batch --data '[
  {"op":"create","kind":"entity","name":"Token Rotation","fields":{"type":"entity"}},
  {"op":"link","slug":"token-rotation","target":"auth-refactor","relation":"parent"}
]'
```

In the JSON, write each apostrophe as `’` (`isn’t`): a straight `'` ends the quoted argument and the batch fails.

No pipe (PowerShell 5.1): `hafez batch --file ops.json`. Machine-readable shape of any op: `hafez schema <op>`, with `--examples` for a sample.

## The tool itself

- Upgrade: `hafez upgrade`. It checks and prints, it never installs. Show the user the printed steps and run them only after a yes.
- Set up or reconfigure: `hafez onboard`.

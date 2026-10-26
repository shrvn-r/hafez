<!-- hafez:begin ba7b2e9e434d -->
## Hafez

Hafez is this user's vault: what they are working on (entities) and what they have learned (knowledge). You reach it only through the `hafez` command.

**Load.** At the start of a session, if the first message or the working folder names a piece of work, run `hafez read <slug>` on your best guess at the slug before anything else. A miss prints the closest slugs: read the one that fits. The work has no entity: create one with the line below. Nothing is named: load nothing.

**Write as it happens.** Each of these is due the moment it occurs:

- Work landed (a commit, a merged PR, CI green): update the entity that owns the work. That is the entity you read; the entity you read has a child that owns it: write there; the work belongs to another: read that one first. The end of its `read` output shows the command.
- A workstream your own actions or the user already name, too big for one action, gets a Child with that name under the entity you read: create it with `--parent`, move its open actions there (one `update` on the parent: `--remove-action` each, `--log "decision: split <child> out, open actions moved"`), and write there from now on.
- A decision was made: one `decision` log entry, now, on the entity that owns the work. The repo keeps its own decisions record: write it there and the log entry points at it (`hafez update <slug> --log "decision: <one line>, see decisions.md"`).
- A lesson that holds without this entity: create a knowledge note; what we chose is a decision entry, not a note. An insight about this repo's code alone goes in the repo's own docs instead.
- The user says "note this" or "record that": write it.
- You are weighing whether something is worth writing: write it, as knowledge with `--confidence observation`.

```
hafez create entity "<name>" --type <project|entity> --parent <slug you read, or its parent> --resource <. if the work lives in this folder> --description "<one sentence>" --brief "<where things stand>" --add-action "<next step>"
hafez create knowledge "<name>" --synthesis "<the insight>" --confidence <observation|pattern|principle> --related <slug>
```

A plan is `--subtype plan` without `--synthesis`. Cannot tell entity from knowledge: `hafez capture "<name>"`.

**Rules.**

- Never ask the user whether to write to the vault. Write, then say so in one line naming the slug and what you did. Every write is a git commit and can be undone.
- Update only what you have read this session. Not read yet: read it first.
- One command per write.
- Open actions on an entity you read are yours: tick what landed, drop what is dead. Lines `read` marks stale are due.
- Never edit vault files by hand.
- Never save the session unprompted. The user saves with the `hafez-save` skill.
<!-- hafez:end -->

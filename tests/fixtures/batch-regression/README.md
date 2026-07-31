# Batch Regression Fixtures

Real `hafez batch` payloads captured from real Claude Code session transcripts. Used as inputs for `tests/cli-batch-regression.test.ts` to guarantee the Phase 0 refactor (contracts consolidation + nested `discriminatedUnion` + `.strict()`) does not change observable behavior for real historical inputs.

Captured 2026-04-11 as Phase 0 step 0 of the plan at `plans/parsed-zooming-hoare.md`.

## Fixtures

| File | Shape | Source |
|---|---|---|
| `01-single-op-update.json` | Minimal single-op `update` setting `status: done` | Synthesized from observed patterns — transcripts only contained multi-op payloads, so this is the degenerate case |
| `02-multi-op-mixed.json` | 3 ops — `create/entity` (project) + 2 `link` ops (parent + related) | `20218563-62ae-4de6-a86f-7e994308a098.jsonl` event ~518 |
| `03-session-log-updates.json` | 5 ops — 4 `update` ops including one with `session_log` (type: progress) | `1365df02-f8c7-44a7-aded-fbab91b81683.jsonl` event ~508 |

## Scrub status

**No scrubbing needed.** All three payloads validate cleanly against the current `BatchOperationSchema` in `src/cli/commands.ts`:

- `status` values ∈ `['active', 'paused', 'done']` ✓
- `session_log.type` values ∈ `['progress', 'decision', 'blocker', 'research']` ✓
- entity `type` values ∈ `['project', 'entity', 'capture']` ✓
- `relation` values ∈ `['parent', 'related']` ✓
- No deprecated names observed (`"kind"` on link, `"subtype": "session"`, `"reinforce"` op)

Payloads are from active Phase 1/2 implementation sessions that already used the v2 contract system, so they're contemporary with current validator expectations.

## Golden regeneration

Goldens live at `golden-01.txt`, `golden-02.txt`, `golden-03.txt` (generated during test implementation, not yet present).

When the test runs, each fixture seeds a temp vault (via `simpleGit` + tmpdir, same pattern as `tests/integration.test.ts`), runs `cmdBatch` on the fixture, then:

```bash
git add -A && git status --porcelain
```

produces a stable, sorted list of changes that must match the golden file exactly.

To regenerate goldens after an intentional behavior change:

```bash
UPDATE_GOLDENS=1 npx vitest run tests/cli-batch-regression.test.ts
```

Review the diff in the PR before committing. Any unintended golden change is a regression.

## Why real fixtures?

Synthetic fixtures would miss the edge cases real usage produces: verbose `brief` text, long `add_action` strings, `session_log.summary` with multi-line content, multiple `complete_action` operations in sequence. The regression guard exists to catch the scenario where Phase 0's `.strict()` rejects something that previously parsed successfully — the only way to find those is to use payloads that agents actually sent.

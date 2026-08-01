// src/cli/onboard.ts
//
// `hafez onboard` — agent-directed first-run guide. Same pattern as
// `hafez help --agent`: plain text printed for the agent operating on the
// user's behalf. Covers the two things a fresh install leaves open — seeding
// the empty vault and choosing how deeply the agent integrates.
//
// Static by design, and deliberately NOT part of the skill: the skill loads
// into every session forever, this is read once. Living in the CLI also means
// it works before the skill is installed.

export const INTEGRATION_SNIPPET = `## Hafez — Session Memory

- Session start: if the first message names a project or topic, load context
  with \`hafez read <slug>\` (or \`hafez search "<topic>"\`). Don't load
  speculatively.
- Mid-session: new workstream -> create an entity. Durable insight -> create
  or update a knowledge note (search first). User mentions a project by
  name -> check if it's a Hafez entity. Use \`hafez batch\` for 2+ mutations.
- Session end: record a digest (\`hafez digest | hafez batch\`) with the
  entities touched, decisions made, and a short narrative.
- Knowledge boundary: useful beyond this repo/session -> vault knowledge
  note. Specific to one repo's code -> that repo's own docs, not the vault.`

export function renderOnboard(): string {
  return `# Hafez — First Run

You are an agent reading this on behalf of your user. Walk them through the
steps below conversationally — do not dump this document on them.

Prerequisites: \`hafez init\` resolves a vault, and you have read
\`hafez help --agent\` (do that now if not). The CLI is the whole interface —
no other pieces are required. If your harness is Claude Code, also install
the bundled skill — see the README Setup (github.com/shrvn-r/hafez).

## Step 1 — Seed the vault

An empty vault gives the agent nothing to trigger on, so the memory loop
never starts. The goal here is a small set of high-quality entries — not a
bulk import.

1. Interview the user: "What are you actively working on right now?" Aim for
   3-7 projects or areas. For each one, draw out:
   - a one-line description (\`description\`)
   - current state / handoff context, 2-4 sentences (\`brief\`)
   - 1-2 concrete next actions (\`add_action\`)
2. Offer to mine sources they already have — a repo's README, existing notes,
   a TODO list. Read what they point you at, propose entries, and let them
   approve before writing anything.
3. Anything vague, aspirational, or someday-maybe becomes a capture, not a
   project. Captures are the inbox; promotion comes later. When in doubt,
   capture.
4. Write everything in ONE \`hafez batch\` call (see
   \`hafez schema create-entity --examples\`), then show the user
   \`hafez stats\`.

Quality bar: every project entry should let a future agent with zero context
pick the work up from the brief alone. If a brief would not do that, ask one
more question.

## Step 2 — Choose the integration level

Ask the user how they want Hafez wired into their sessions. Recommend the
first option.

RECOMMENDED — always active. Add the block below to the user's global agent
instructions file — Claude Code: \`~/.claude/CLAUDE.md\`; any harness that
follows the AGENTS.md standard (Codex, Cursor, Copilot, ...): its global
AGENTS.md, e.g. \`~/.codex/AGENTS.md\` for Codex CLI. This makes memory
automatic: context loads at session start, the vault is updated as work
happens, and a digest records each session. Show them the block, get a yes,
then append it verbatim:

${INTEGRATION_SNIPPET}

FALLBACK — invoke only. If the user prefers to stay in control, add nothing.
Explain how invocation works: the agent touches the vault only when they
mention Hafez or name a project ("what am I working on?", "read <slug>").
Nothing is loaded or written unless asked. They can upgrade later
by re-running \`hafez onboard\`.

## Step 3 — Hand over

Finish with three example asks tailored to what was just seeded, e.g.:

- "What am I working on?"
- "Read <their-project-slug> and pick up where we left off."
- "Capture: <idea> — I'll triage it later."
`
}

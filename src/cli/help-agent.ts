// src/cli/help-agent.ts
//
// `hafez help --agent` — the prompt-gate. Plain text, no ANSI, no markdown
// decoration. Designed for an LLM with zero Hafez context to read once per
// session and then produce valid batch JSON on first try.
//
// Hand-written sections: Preamble + Hard rules (prose, free-form).
// Generated sections (wrapped in <!-- SECTION:name --> markers so tests can
// parse them): op-catalog, critical-enums, batch-examples, digest.
//
// Generated sections derive from the Op Spec table (batch-ops.ts via
// schema-introspect.ts), so they cannot drift from the Zod schemas. Do NOT
// enumerate enum values inside the preamble or hard rules — those come from
// schema-introspect.ts.

import { listOps, getEnumValues, getOpExample, getOpSchema } from './schema-introspect.js'

const PREAMBLE = `# Hafez — Agent Prompt Gate

Hafez is your persistent knowledge graph for projects, entities, captures,
knowledge notes, and session notes. The \`hafez\` CLI is the ONLY supported
write path into the vault — never edit files under \`entities/\`, \`knowledge/\`,
or \`sessions/\` by hand. Every mutation goes through the CLI so the git history,
SQLite index, and link integrity stay in sync.

Mental model:

- An \`entity\` is tracked work with substance — a bug, a feature, a decision.
  Entities have status, can have children, and carry a session log. The three
  entity types are \`capture\` (raw inbox), \`entity\` (standalone tracked item),
  and \`project\` (scoped effort with deliverables, can have child entities).
- A \`knowledge\` note is an insight or a plan. Insights distil a pattern or
  principle and mature through added evidence. Plans are structured steps
  toward a goal. Knowledge is searchable, linkable, and timestamped.
- A \`session\` note records what happened in a working session and references
  the entities it touched. Session notes are created via \`create/session\`
  and are not indexed in SQLite — they are for narrative, not query.
- \`capture\` is the quick-inbox path: grab a link or thought, no structure.
  A capture can later be promoted to entity, project, or knowledge.
- Entities relate to each other through links: \`parent\` (hierarchy) or
  \`related\` (soft reference). Use \`link\` / \`unlink\` ops to manage them.
- Every meaningful update should include a session_log entry so the history
  of the work is preserved. Sessions are how future-you reconstructs why a
  decision was made.

Single source of truth: the exact field names, enum values, and op signatures
below are generated at runtime from the live Zod schema. If a field is not
listed here, it does not exist — do not invent fields.

## Hard rules (read before writing a batch)

- ALWAYS batch 2+ mutations into one \`hafez batch\` call. Many single-op
  calls fragment git history and clobber the vault index's atomicity guarantee.
- NEVER invent field names. If a field is not in \`hafez schema <op>\`, it
  does not exist. Unknown fields are rejected by the validator with a pointer
  to the right schema.
- NEVER write to vault files directly. Always go through the CLI.
- STRONGLY PREFERRED: include a \`session_log\` on update ops that reflect
  meaningful work. The validator does not enforce this — omitting it is a
  code smell, not a hard error.
- When in doubt, run \`hafez schema <op>\` before writing a batch. Cheap,
  deterministic, no side effects.
- Use \`hafez batch --dry-run\` to validate a payload without touching the
  vault. Same validation as a real apply, zero filesystem mutation.

## Slug contract (create-then-link in one batch)

Slugs are deterministic: slug = slugify(name) — lowercase, non-alphanumeric
runs collapse to single \`-\`, edges trimmed (\`"Auth Refactor!"\` →
\`auth-refactor\`). A batch executes sequentially, so later ops may reference
the slugs of earlier creates in the same batch (\`create\` then \`link\`/\`update\`
works in one payload). Collisions hard-error — a wrong slug prediction can
never silently hit an existing document. To verify predictions first:
\`hafez batch --dry-run\` reports the derived slug for every create op.
`

function renderOpCatalog(): string {
  const lines = ['<!-- SECTION:op-catalog -->']
  lines.push('Ops (run `hafez schema <name>` for the full field list):')
  for (const op of listOps()) {
    const desc = op.description ? ` — ${op.description}` : ''
    lines.push(`  ${op.name}${desc}`)
    lines.push(`    → hafez schema ${op.name}`)
  }
  lines.push('<!-- /SECTION:op-catalog -->')
  return lines.join('\n')
}

function renderCriticalEnums(): string {
  const entries: [string, string][] = [
    ['update.fields.status', 'update.fields.status'],
    ['update.fields.session_log.type', 'update.fields.session_log.type'],
    ['update.fields.confidence', 'update.fields.confidence'],
    ['create-entity.fields.type', 'create-entity.fields.type'],
    ['create-knowledge.fields.subtype', 'create-knowledge.fields.subtype'],
    ['link.relation', 'link.relation'],
  ]
  const lines = ['<!-- SECTION:critical-enums -->']
  lines.push('Critical enums (value lists — values are authoritative):')
  for (const [label, path] of entries) {
    const values = getEnumValues(path)
    if (!values) continue
    lines.push(`  ${label} = [${values.join(', ')}]`)
  }
  lines.push('<!-- /SECTION:critical-enums -->')
  return lines.join('\n')
}

function renderBatchExamples(): string {
  const lines = ['<!-- SECTION:batch-examples -->']
  lines.push('Batch JSON shape — wrap one or more ops in an array:')
  lines.push('')
  lines.push('  echo \'[...]\' | hafez batch          # POSIX shells')
  lines.push('  hafez batch --file payload.json     # any platform (PowerShell 5.1 cannot pipe stdin)')
  lines.push('')
  lines.push('Minimal example per op (canonical field names; aliased keys stripped):')
  lines.push('')
  for (const op of listOps()) {
    const example = getOpExample(op.name)
    if (!example) continue
    lines.push(`# ${op.name}`)
    lines.push(JSON.stringify(example, null, 2))
    lines.push('')
  }
  lines.push('<!-- /SECTION:batch-examples -->')
  return lines.join('\n')
}

function renderDigestSection(): string {
  const lines = ['<!-- SECTION:digest -->']
  lines.push('Session digest — turn end-of-session context into a batch payload.')
  lines.push('NOT a batch op: it reads its own JSON and prints batch JSON.')
  lines.push('')
  lines.push("  echo '<digest-json>' | hafez digest | hafez batch")
  lines.push('  # No stdin pipes (PowerShell 5.1): hafez digest --file summary.json > ops.json,')
  lines.push('  # then hafez batch --file ops.json')
  lines.push('')
  lines.push('Input fields (`hafez schema digest` for the full schema):')
  const schema = getOpSchema('digest')
  for (const [name, field] of Object.entries(schema?.fields ?? {})) {
    const req = field.optional ? 'optional' : 'required'
    const desc = field.description ? ` — ${field.description}` : ''
    lines.push(`  ${name} (${req})${desc}`)
  }
  lines.push('')
  lines.push('Example input:')
  lines.push(JSON.stringify(getOpExample('digest'), null, 2))
  lines.push('<!-- /SECTION:digest -->')
  return lines.join('\n')
}

const FOOTER = `## Lookup pointers

- \`hafez schema\`                      — list all ops
- \`hafez schema <op>\`                 — full JSON schema for one op
- \`hafez schema <op> --examples\`      — working JSON examples per enum value
- \`hafez batch --dry-run\`             — validate without touching the vault
`

/**
 * Render the full prompt-gate output. Token budget: 1500-3000 tokens when
 * measured as char/3.5. The drift test in tests/cli-help-agent.test.ts
 * enforces the ceiling.
 */
const EXIT_CODES_SECTION = `## Exit codes

| code | meaning |
|------|---------|
| 0 | success |
| 1 | not found / unknown error |
| 2 | validation or usage error (bad flags, bad payload, core rejected the write) |
| 3 | git push failed — the write IS committed locally |
| 4 | write succeeded but the auto-sync after it failed |
| 5 | slug already exists |
| 6 | git commit failed — nothing was written to history |
| 7 | vault locked by another hafez process — retry when it finishes |`

export function renderAgentHelp(): string {
  return [
    PREAMBLE,
    renderOpCatalog(),
    '',
    renderCriticalEnums(),
    '',
    renderBatchExamples(),
    '',
    renderDigestSection(),
    '',
    EXIT_CODES_SECTION,
    '',
    FOOTER,
  ].join('\n')
}

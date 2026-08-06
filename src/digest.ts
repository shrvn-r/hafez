// src/digest.ts
import { z } from 'zod'
import type { BatchOperation, UpdateFields } from './types.js'
import type { CreateSessionFieldsInput } from './batch-ops.js'

// --- Schema ---

export const DigestInputSchema = z.object({
  entities_touched: z.array(z.string())
    .describe('Slugs of entities worked on. Each gets a session log entry; the session note links them all. Unknown slugs warn on stderr and are omitted.'),
  decisions: z.array(z.string())
    .describe('Key decisions made this session (may be empty). Recorded in the session note.')
    .default([]),
  narrative: z.string().min(1)
    .describe('1-3 sentence cross-cutting summary — what happened, connections discovered.'),
  session_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD')
    .describe('Session date, YYYY-MM-DD.'),
  agent: z.string()
    .describe('Agent identifier recorded in session logs.')
    .default('claude'),
})

export type DigestInput = z.infer<typeof DigestInputSchema>

/**
 * Validate and parse raw digest input from stdin.
 * Returns unknown fields so callers can warn on stderr.
 * Uses strict() parse to detect unknown keys, then normal parse for the clean result.
 */
export function parseDigestInput(raw: unknown): { success: true; data: DigestInput; unknownFields: string[] } | { success: false; error: z.ZodError } {
  const result = DigestInputSchema.safeParse(raw)
  if (!result.success) {
    return { success: false, error: result.error }
  }

  // Detect unknown fields via strict parse (Zod's unrecognized_keys error code)
  const unknownFields: string[] = []
  const strictResult = DigestInputSchema.strict().safeParse(raw)
  if (!strictResult.success) {
    for (const issue of strictResult.error.issues) {
      if (issue.code === 'unrecognized_keys') unknownFields.push(...(issue as any).keys)
    }
  }

  return { success: true, data: result.data, unknownFields }
}

/**
 * Convert session context into a hafez batch payload.
 * Pure function — no file I/O, no vault access.
 * Unknown slugs in entities_touched are silently omitted (caller should warn).
 */
export function digest(input: DigestInput, existingSlugs: Set<string>, now: Date = new Date()): BatchOperation[] {
  const ops: BatchOperation[] = []

  // 1. Session log updates for each known slug
  const knownTouched = input.entities_touched.filter(s => existingSlugs.has(s))
  for (const slug of knownTouched) {
    const sessionLogSummary = buildSessionLogSummary(input)
    const fields: UpdateFields = {
      session_log: {
        type: 'progress',
        summary: sessionLogSummary,
        agent: input.agent,
      },
    }
    ops.push({ op: 'update', slug, fields })
  }

  // 2. Session note — built from known slugs only, so unknown slugs never
  //    leak into the note body (the schema promises they are omitted).
  const noteBody = buildSessionNoteBody(input, knownTouched)
  const related = knownTouched
  // Typechecked against the Op Spec's session-create schema so digest output
  // can never silently diverge from what batch validation accepts.
  const noteFields: CreateSessionFieldsInput = {
    synthesis: noteBody,
    'session-date': input.session_date,
    ...(related.length > 0 ? { related } : {}),
  }
  const noteName = `Session ${input.session_date} ${now.toISOString().slice(11, 19)}`
  ops.push({ op: 'create', kind: 'session', name: noteName, fields: noteFields })

  return ops
}

// --- Helpers ---

function buildSessionLogSummary(input: DigestInput): string {
  const parts: string[] = [input.narrative.trim()]
  if (input.decisions.length > 0) {
    parts.push(`Decisions: ${input.decisions.join('; ')}`)
  }
  return parts.join(' | ')
}

function buildSessionNoteBody(input: DigestInput, knownTouched: string[]): string {
  const lines: string[] = [input.narrative.trim()]

  if (input.decisions.length > 0) {
    lines.push('')
    lines.push('**Decisions:**')
    for (const d of input.decisions) {
      lines.push(`- ${d}`)
    }
  }

  if (knownTouched.length > 0) {
    lines.push('')
    lines.push(`**Entities touched:** ${knownTouched.join(', ')}`)
  }

  return lines.join('\n')
}

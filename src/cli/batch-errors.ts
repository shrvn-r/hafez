// src/cli/batch-errors.ts
//
// Multi-error batch formatter. Takes a Zod `safeParse` issue list for one op
// index and returns a human-readable block keyed to the op + index, with a
// "did you mean" suggestion on unknown keys and a `hafez schema <op>`
// pointer at the end of every block.
//
// Depends on Phase 0 step 2 (discriminatedUnion) and step 3 (.strict()):
// without those, the `unrecognized_keys` and `invalid_union_discriminator`
// paths are unreachable.

import type { z } from 'zod'
import { getOpSchema, listOps, type FieldSchema } from './schema-introspect.js'

// --- did-you-mean (cheap Levenshtein) ---

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  const prev = new Array(b.length + 1).fill(0).map((_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur.push(Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost))
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]
  }
  return prev[b.length]
}

/**
 * Known deprecated key names that don't match their canonical name by
 * Levenshtein distance. Checked before the generic Levenshtein pass so
 * `{"kind": "parent"}` on a link op maps to "relation" even though the
 * edit distance is much larger than the threshold.
 */
const DEPRECATED_KEY_ALIASES: Record<string, string> = {
  kind: 'relation',
}

export function didYouMean(key: string, validKeys: readonly string[], maxDistance = 3): string | null {
  // Manual alias pass first — covers rename history where the new and old
  // names have no shared letters.
  const manual = DEPRECATED_KEY_ALIASES[key]
  if (manual && validKeys.includes(manual)) return manual

  let best: { key: string; dist: number } | null = null
  for (const k of validKeys) {
    const d = levenshtein(key, k)
    if (d === 0) continue
    if (d <= maxDistance && (!best || d < best.dist)) best = { key: k, dist: d }
  }
  return best ? best.key : null
}

// --- Schema-key lookup for unrecognized_keys hints ---

/**
 * Collect the full set of valid keys at the level where `path` points. Used for
 * did-you-mean across `unrecognized_keys` issues. `path` is the Zod issue path —
 * typically something like `['fields']` or `[]` at the op level.
 */
function validKeysAtPath(opName: string, path: (string | number)[]): readonly string[] {
  const opSchema = getOpSchema(opName)
  if (!opSchema) return []
  let cur: FieldSchema = { type: 'object', fields: opSchema.fields, strict: true }
  for (const seg of path) {
    if (cur.type !== 'object' || !cur.fields) return []
    const next = cur.fields[String(seg)]
    if (!next) return []
    cur = next
  }
  if (cur.type === 'object' && cur.fields) return Object.keys(cur.fields)
  return []
}

// --- Op-name resolution from an unknown input ---

/**
 * Given the raw op JSON, determine a display name for the schema pointer.
 * For create ops, returns `create-<kind>` if kind is a valid literal, else `create`.
 * For typos in `op` itself, returns null.
 */
export function opNameOf(raw: Record<string, unknown> | undefined): string | null {
  if (!raw) return null
  const op = raw.op
  if (typeof op !== 'string') return null
  if (op === 'create') {
    const kind = raw.kind
    if (typeof kind === 'string') return `create-${kind}`
    return 'create'
  }
  const known = new Set(listOps().map(o => o.op))
  return known.has(op) ? op : null
}

// --- Block formatting ---

export interface FormattedError {
  /** The block shown to the user — one issue, multi-line. */
  block: string
}

function formatPath(path: readonly PropertyKey[]): string {
  if (!path.length) return '(root)'
  return path.map(p => (typeof p === 'number' ? `[${p}]` : typeof p === 'symbol' ? p.toString() : p)).join('.')
}

function lookupByPath(obj: unknown, path: readonly PropertyKey[]): unknown {
  let cur: any = obj
  for (const p of path) {
    if (cur == null) return undefined
    cur = cur[p as any]
  }
  return cur
}

function toStr(v: unknown): string {
  if (typeof v === 'string') return `"${v}"`
  if (v === null) return 'null'
  if (v === undefined) return 'undefined'
  try { return JSON.stringify(v) } catch { return String(v) }
}

const VALID_OPS = ['update', 'create', 'capture', 'link', 'unlink', 'promote']

/**
 * Format a single Zod issue into a readable block. Caller supplies the op
 * index and the raw op JSON so the block can reference the right `hafez
 * schema <op>` pointer.
 */
export function formatIssue(
  issue: z.ZodIssue,
  opIndex: number,
  raw: Record<string, unknown> | undefined,
): string {
  const opDisplay = opNameOf(raw) ?? (typeof raw?.op === 'string' ? String(raw.op) : '?')
  const pointerName = opNameOf(raw) ?? 'update' // fallback pointer so the tip still renders
  const fieldPath = formatPath(issue.path)
  const tip = `tip: run \`hafez schema ${pointerName}\` for the full field list`
  const header = `[index ${opIndex}] op=${opDisplay}`

  const anyIssue = issue as any
  const code = anyIssue.code as string

  // Zod v4 emits `invalid_union` with a `discriminator` field when the
  // discriminatedUnion can't match the discriminator value to a branch.
  // For the outer `op` union this means "unknown op". For the inner create
  // union this means "unknown kind".
  if (code === 'invalid_union' && anyIssue.discriminator) {
    const discriminator = anyIssue.discriminator as string
    if (discriminator === 'op') {
      const got = typeof raw?.op === 'string' ? `"${raw.op}"` : toStr(raw?.op)
      return [
        header,
        `  field: op`,
        `  issue: unknown op ${got} (expected one of [${VALID_OPS.join(', ')}])`,
        `  tip: run \`hafez schema\` for the op catalog`,
      ].join('\n')
    }
    if (discriminator === 'kind') {
      const got = typeof raw?.kind === 'string' ? `"${raw.kind}"` : toStr(raw?.kind)
      return [
        header,
        `  field: kind`,
        `  issue: unknown kind ${got} (expected one of [entity, knowledge, session])`,
        `  ${tip}`,
      ].join('\n')
    }
  }

  if (code === 'unrecognized_keys') {
    const keys = (issue as any).keys as string[] | undefined
    const first = keys?.[0] ?? '<unknown>'
    const stringPath: (string | number)[] = []
    for (const p of issue.path) stringPath.push(typeof p === 'symbol' ? p.toString() : p)
    const valid = validKeysAtPath(pointerName, stringPath)
    const suggestion = didYouMean(first, valid)
    const suggestText = suggestion ? ` (did you mean "${suggestion}"?)` : ''
    return [
      header,
      `  field: ${first}${fieldPath === '(root)' ? '' : ` (under ${fieldPath})`}`,
      `  issue: unknown field${suggestText}`,
      ...(valid.length ? [`  allowed: ${valid.join(', ')}`] : []),
      `  ${tip}`,
    ].join('\n')
  }

  if (code === 'invalid_enum_value' || code === 'invalid_value') {
    // Zod v3 uses `options`, Zod v4 uses `values`.
    const expected = anyIssue.options ?? anyIssue.values
    // Zod v4 doesn't attach the received value to the issue, so walk the raw
    // input by path to find it.
    const received = anyIssue.received ?? anyIssue.input ?? lookupByPath(raw, issue.path)
    return [
      header,
      `  field: ${fieldPath}`,
      `  issue: invalid value`,
      ...(expected ? [`  expected: one of [${(expected as string[]).join(', ')}]`] : []),
      `  got:      ${toStr(received)}`,
      `  ${tip}`,
    ].join('\n')
  }

  if (code === 'invalid_type') {
    const expected = (issue as any).expected
    const received = (issue as any).received
    return [
      header,
      `  field: ${fieldPath}`,
      `  issue: wrong type`,
      `  expected: ${expected}`,
      `  got:      ${received}`,
      `  ${tip}`,
    ].join('\n')
  }

  if (code === 'invalid_literal') {
    const expected = (issue as any).expected
    return [
      header,
      `  field: ${fieldPath}`,
      `  issue: invalid literal`,
      `  expected: ${toStr(expected)}`,
      `  ${tip}`,
    ].join('\n')
  }

  // Fallback — unknown issue code.
  return [
    header,
    `  field: ${fieldPath}`,
    `  issue: ${issue.message}`,
    `  ${tip}`,
  ].join('\n')
}

/**
 * Top-level entry for a single op. Returns one composite block that concatenates
 * every issue the safeParse returned, preserving all N issues (never drops).
 */
export function formatBatchError(
  issues: z.ZodIssue[],
  opIndex: number,
  raw: Record<string, unknown> | undefined,
): string {
  return issues.map(i => formatIssue(i, opIndex, raw)).join('\n')
}

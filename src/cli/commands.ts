// src/cli/commands.ts
import { z } from 'zod'
import type { Hafez, ReadDepth, EntityType, QueryFilter, ConfidenceLevel, EntityStatus, CreateEntityFields, BatchOperation, KnowledgeQueryOpts, QueryResult, KnowledgeQueryResult } from '../types.js'
import { HafezError } from '../types.js'
import {
  ENTITY_TYPES,
  ENTITY_STATUSES,
  SESSION_LOG_TYPES,
  CONFIDENCE_LEVELS,
  VALID_SUBTYPES,
} from '../contracts.js'
import { formatBatchError } from './batch-errors.js'
import { parseDigestInput, digest } from '../digest.js'
import { formatEntityHeader, formatKnowledgeHeader, formatQueryTable, formatKnowledgeTable, formatSearchResults, formatValidation, formatStats, formatChangelog } from './format.js'

export interface CommandOpts { json?: boolean }

function jsonOut(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

export async function cmdRead(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const slug = args[0]
  if (!slug) throw new Error('Usage: hafez read <slug> [--depth frontmatter|summary|full]')
  const depth = (getFlag(args, '--depth') ?? 'summary') as ReadDepth
  const result = await os.read(slug, depth)
  if (opts.json) return jsonOut(result)
  const fm = result.frontmatter as Record<string, any>
  if ('type' in fm) return formatEntityHeader(fm, result.body)
  return formatKnowledgeHeader(fm, result.body)
}

export async function cmdQuery(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const kind = getFlag(args, '--kind') ?? 'entity'
  const filter = (getFlag(args, '--filter') ?? 'active') as QueryFilter
  const type = getFlag(args, '--type') as EntityType | undefined
  const parent = getFlag(args, '--parent')
  const relatedTo = getFlag(args, '--related-to')
  const domain = getFlag(args, '--domain')
  const confidence = getFlag(args, '--confidence') as ConfidenceLevel | undefined
  const since = getFlag(args, '--since')
  const before = getFlag(args, '--before')
  const createdSince = getFlag(args, '--created-since')
  const createdBefore = getFlag(args, '--created-before')
  const tagRaw = getFlag(args, '--tag')
  const tags = tagRaw ? tagRaw.split(',').map(t => t.trim()).filter(Boolean) : undefined
  const sortBy = getFlag(args, '--sort-by') as any
  const sortOrder = getFlag(args, '--sort-order') as 'asc' | 'desc' | undefined
  const limitRaw = getFlag(args, '--limit')
  const offsetRaw = getFlag(args, '--offset')
  const limit = limitRaw != null ? parseInt(limitRaw, 10) : undefined
  const offset = offsetRaw != null ? parseInt(offsetRaw, 10) : undefined

  const sortOpts = { sort_by: sortBy, sort_order: sortOrder, limit, offset }

  // --related-to: always returns both entities and knowledge
  if (relatedTo) {
    const result = await os.related_to(relatedTo)
    if (opts.json) return jsonOut(result)
    const { items: results, total } = result
    const entities = results.filter((r: any) => 'type' in r)
    const knowledge = results.filter((r: any) => 'confidence' in r)
    const sections: string[] = []
    if (entities.length > 0) sections.push('## Entities\n\n' + formatQueryTable(entities as any, total))
    if (knowledge.length > 0) sections.push('## Knowledge\n\n' + formatKnowledgeTable(knowledge as any, total))
    return sections.length > 0 ? sections.join('\n\n') : 'No results.'
  }

  const queryOpts = { filter, type, parent, domain, since, before, createdSince, createdBefore, tags, ...sortOpts }

  // --kind knowledge: query knowledge only
  // Note: time flags only apply to entity queries.
  if (kind === 'knowledge') {
    const subtype = getFlag(args, '--subtype') as any
    const kOpts: KnowledgeQueryOpts = { domain: domain ?? undefined, confidence, subtype, tags, ...sortOpts }
    const result = await os.query_knowledge(kOpts)
    if (opts.json) return jsonOut(result)
    return formatKnowledgeTable(result.items, result.total)
  }

  // --kind all: query both entities and knowledge via unified query
  if (kind === 'all') {
    const result = await os.queryUnified({ ...queryOpts, kind: 'all', confidence })
    if (opts.json) return jsonOut(result)
    const { items, total } = result
    const entities = items.filter(i => i.kind === 'entity')
    const knowledge = items.filter(i => i.kind === 'knowledge')
    const sections: string[] = []
    if (entities.length > 0) sections.push('## Entities\n\n' + formatQueryTable(entities as QueryResult[]))
    if (knowledge.length > 0) sections.push('## Knowledge\n\n' + formatKnowledgeTable(knowledge as KnowledgeQueryResult[]))
    if (items.length < total) sections.push(`\nShowing ${items.length} of ${total}`)
    return sections.length > 0 ? sections.join('\n\n') : 'No results.'
  }

  // --kind entity (default): query entities
  const result = await os.query(queryOpts)
  if (opts.json) return jsonOut(result)
  return formatQueryTable(result.items, result.total)
}

export async function cmdSearch(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const terms = positionalArgs(args).join(' ')
  if (!terms) throw new Error('Usage: hafez search <terms> [--kind entity|knowledge|all]')
  const kind = (getFlag(args, '--kind') ?? 'all') as 'entity' | 'knowledge' | 'all'
  const results = await os.search(terms, kind)
  if (opts.json) return jsonOut(results)
  return formatSearchResults(results)
}

export async function cmdCreate(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const kind = args[0]
  if (!kind) throw new Error('Usage: hafez create <entity|knowledge> <name> [options]')

  const name = positionalArgs(args.slice(1)).join(' ')
  if (!name) throw new Error(`Usage: hafez create ${kind} <name> [options]`)

  if (kind === 'entity') {
    const type = getFlag(args, '--type') as CreateEntityFields['type']
    if (!type) throw new Error('--type is required for entity creation')
    const slug = await os.create('entity', name, {
      type,
      purpose: getFlag(args, '--purpose'),
      description: getFlag(args, '--description'),
      resource: getFlag(args, '--resource'),
      domain: getFlag(args, '--domain')?.split(',').map(d => d.trim()),
      parent: getFlag(args, '--parent'),
      related: getFlag(args, '--related')?.split(','),
      tags: getFlag(args, '--tags')?.split(','),
      brief: getFlag(args, '--brief'),
      add_action: getFlag(args, '--add-action'),
    })
    return opts.json ? jsonOut({ slug }) : slug
  }

  if (kind === 'knowledge') {
    const slug = await os.create('knowledge', name, {
      subtype: getFlag(args, '--subtype') as any,
      synthesis: getFlag(args, '--synthesis') ?? getFlag(args, '--insight'),
      description: getFlag(args, '--description'),
      domain: getFlag(args, '--domain')?.split(','),
      related: getFlag(args, '--related')?.split(','),
      tags: getFlag(args, '--tags')?.split(','),
    })
    return opts.json ? jsonOut({ slug }) : slug
  }

  throw new Error(`Unknown kind: ${kind}. Use entity or knowledge.`)
}

export async function cmdUpdate(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const slug = args[0]
  if (!slug) throw new Error('Usage: hafez update <slug> [--brief text] [--description text] [--resource uri] [--add-action text] [--complete-action text] [--remove-action text] [--clear-actions] [--status s] [--log "type: summary"]')

  const fields: Record<string, any> = {}
  const status = getFlag(args, '--status') as EntityStatus | undefined
  if (status) fields.status = status

  // Removed flag must fail loudly, not silently drop the value: older
  // installed skills/scripts still pass it, and "Updated <slug>" with the
  // action discarded is a false success.
  if (args.includes('--next-action')) {
    throw new Error('--next-action was removed in v1.0.2. Use --add-action (and --clear-actions) instead.')
  }

  const currentState = getFlag(args, '--current-state')
  if (currentState) fields.current_state = currentState

  // Brief
  const brief = getFlag(args, '--brief')
  if (brief !== undefined) {
    fields.brief = brief === '' ? null : brief
  }

  // Next Actions
  const addAction = getFlag(args, '--add-action')
  if (addAction) fields.add_action = addAction

  const completeAction = getFlag(args, '--complete-action')
  if (completeAction) fields.complete_action = completeAction

  const removeAction = getFlag(args, '--remove-action')
  if (removeAction) fields.remove_action = removeAction

  if (args.includes('--clear-actions')) fields.clear_actions = true

  const log = getFlag(args, '--log')
  if (log) {
    const colonIdx = log.indexOf(':')
    if (colonIdx === -1) throw new Error('--log format: "type: summary". Types: progress, decision, blocker, research')
    const type = log.slice(0, colonIdx).trim()
    const summary = log.slice(colonIdx + 1).trim()
    const agent = getFlag(args, '--agent') ?? 'claude'
    fields.session_log = { type, summary, agent }
  }

  // Shared metadata (entity + knowledge)
  const description = getFlag(args, '--description')
  if (description !== undefined) fields.description = description
  const resource = getFlag(args, '--resource')
  if (resource !== undefined) fields.resource = resource
  const domainRaw = getFlag(args, '--domain')
  if (domainRaw) fields.domain = domainRaw.split(',').map((d: string) => d.trim())
  const conf = getFlag(args, '--confidence')
  if (conf) fields.confidence = conf
  const tagsRaw = getFlag(args, '--tags')
  if (tagsRaw) fields.tags = tagsRaw.split(',').map((t: string) => t.trim())
  const relatedRaw = getFlag(args, '--related')
  if (relatedRaw) fields.related = relatedRaw.split(',').map((r: string) => r.trim())
  const insight = getFlag(args, '--insight')
  if (insight) fields.synthesis = insight
  const synthesis = getFlag(args, '--synthesis')
  if (synthesis) fields.synthesis = synthesis
  const addEvidence = getFlag(args, '--add-evidence')
  if (addEvidence) fields.add_evidence = addEvidence
  const addSource = getFlag(args, '--add-source')
  if (addSource) fields.add_source = addSource

  const result = await os.update(slug, fields)
  if (opts.json) return jsonOut({ slug, ...result })
  const lines = [`Updated ${slug}`]
  if (result.matched_action) {
    lines.push(`matched action: ${result.matched_action}`)
  }
  return lines.join('\n')
}

function parseLinkArgs(args: string[], verb: 'link' | 'unlink'): { slug: string; target: string; relation: string } {
  const relation = getFlag(args, '--relation')
  // After getFlag the relation value is still at its original positional slot
  // (getFlag does NOT splice), so strip it manually before reading positionals.
  const positionals = args.filter((a, i) => {
    if (a === '--relation') return false
    if (i > 0 && args[i - 1] === '--relation') return false
    return !a.startsWith('--')
  })
  const [slug, target] = positionals
  if (!slug || !target || !relation) {
    throw new Error(`Usage: hafez ${verb} <slug> <target> --relation <parent|related>`)
  }
  if (!['parent', 'related'].includes(relation)) {
    throw new Error(`Invalid relation: ${relation}. Must be parent or related.`)
  }
  return { slug, target, relation }
}

export async function cmdLink(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { slug, target, relation } = parseLinkArgs(args, 'link')
  await os.link(slug, target, relation as any)
  return opts.json ? jsonOut({ slug, target, relation }) : `Linked ${slug} → ${target} (${relation})`
}

export async function cmdUnlink(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { slug, target, relation } = parseLinkArgs(args, 'unlink')
  await os.unlink(slug, target, relation as any)
  return opts.json ? jsonOut({ slug, target, relation }) : `Unlinked ${slug} — ${target} (${relation})`
}

/** Top-level capture command — aligns the CLI verb with the batch op name. */
export async function cmdCapture(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const name = positionalArgs(args).join(' ')
  if (!name) throw new Error('Usage: hafez capture <name> [--notes "text"]')
  const notes = getFlag(args, '--notes')
  const slug = await os.capture(name, notes)
  return opts.json ? jsonOut({ slug }) : slug
}

export async function cmdPromote(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const slug = args[0]
  const target = args[1]
  if (!slug || !target) throw new Error('Usage: hafez promote <slug> <entity|project|knowledge>')
  if (!['entity', 'project', 'knowledge'].includes(target)) {
    throw new Error(`Invalid target: ${target}. Must be entity, project, or knowledge.`)
  }
  await os.promote(slug, target as any)
  if (opts.json) return jsonOut({ slug, target })
  return `Promoted ${slug} → ${target}`
}

export async function cmdValidate(os: Hafez, _args: string[], opts: CommandOpts = {}): Promise<string> {
  const report = await os.validate()
  if (opts.json) return jsonOut(report)
  return formatValidation(report)
}

export async function cmdIndexRebuild(os: Hafez): Promise<string> {
  await os.rebuildIndex()
  return 'Index rebuilt.'
}

export async function cmdSync(os: Hafez, _args: string[]): Promise<string> {
  const result = await os.sync()
  if (!result.remote) return 'No remote configured — vault is local-only. Every write is already committed to git.'
  if (result.pulled && result.pushed) return 'Synced: pulled remote changes and pushed local commits.'
  if (result.pulled) return 'Synced: pulled remote changes.'
  if (result.pushed) return 'Synced: pushed local commits.'
  return 'Already up to date.'
}

export async function cmdStats(os: Hafez, _args: string[], opts: CommandOpts = {}): Promise<string> {
  const stats = await os.stats()
  if (opts.json) return jsonOut(stats)
  return formatStats(stats)
}

export async function cmdChangelog(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const since = getFlag(args, '--since')
  if (!since) throw new Error('Usage: hafez changelog --since <date|relative>\nExamples: --since 2026-03-20, --since 7.days.ago, --since 1.week.ago')
  const entries = await os.changelog(since)
  if (opts.json) return jsonOut(entries)
  return formatChangelog(entries)
}

// --- Batch ---

// All enums are built from contracts.ts tuples so help-renderer, file validators,
// and CLI-input validator share a single source of truth. cli-schema-parity.test.ts
// enforces this on every build.
// Every z.object(...) is .strict() — unknown keys become `unrecognized_keys` issues
// (not silently dropped), which is load-bearing for the error-formatter's did-you-mean
// hints and for catching typos like `{"kind": "parent"}` on a link op.

export const SessionLogSchema = z.object({
  type: z.enum([...SESSION_LOG_TYPES] as [string, ...string[]]),
  summary: z.string(),
  body: z.string().optional(),
  agent: z.string(),
}).strict()

export const UpdateFieldsSchema = z.object({
  status: z.enum([...ENTITY_STATUSES] as [string, ...string[]]).optional(),
  current_state: z.string().optional(),
  session_log: SessionLogSchema.optional(),
  brief: z.string().nullable().optional(),
  add_action: z.string().optional(),
  add_actions: z.array(z.string()).optional(),
  complete_action: z.string().optional(),
  remove_action: z.string().optional(),
  clear_actions: z.boolean().optional(),
  // Knowledge metadata
  description: z.string().nullable().optional(),
  resource: z.string().nullable().optional(),
  domain: z.array(z.string()).optional(),
  confidence: z.enum([...CONFIDENCE_LEVELS] as [string, ...string[]]).optional(),
  tags: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  synthesis: z.string().optional(),
  insight: z.string().optional(),     // alias for synthesis (normalized in parseBatchInput)
  add_evidence: z.string().optional(),
  add_source: z.string().optional(),
}).strict()

const CreateEntityFieldsSchema = z.object({
  type: z.enum([...ENTITY_TYPES] as [string, ...string[]]),
  purpose: z.string().optional(),
  description: z.string().optional(),
  resource: z.string().optional(),
  domain: z.array(z.string()).optional(),
  parent: z.string().optional(),
  related: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  brief: z.string().optional(),
  add_action: z.string().optional(),
}).strict()

const CreateKnowledgeFieldsSchema = z.object({
  subtype: z.enum([...VALID_SUBTYPES] as [string, ...string[]]).optional(),
  synthesis: z.string().optional(),
  insight: z.string().optional(),
  description: z.string().optional(),
  domain: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  'session-date': z.string().optional(),
}).strict()

const CreateSessionFieldsSchema = z.object({
  synthesis: z.string().optional(),
  insight: z.string().optional(),
  related: z.array(z.string()).optional(),
  'session-date': z.string().optional(),
}).strict()

const CreateEntityBranch = z.object({
  op: z.literal('create'),
  kind: z.literal('entity'),
  name: z.string(),
  fields: CreateEntityFieldsSchema,
}).strict()

const CreateKnowledgeBranch = z.object({
  op: z.literal('create'),
  kind: z.literal('knowledge'),
  name: z.string(),
  fields: CreateKnowledgeFieldsSchema.optional(),
}).strict()

const CreateSessionBranch = z.object({
  op: z.literal('create'),
  kind: z.literal('session'),
  name: z.string(),
  fields: CreateSessionFieldsSchema.optional(),
}).strict()

// Nested discriminated union: outer on `op`, inner on `kind` for create branch.
// A flat `discriminatedUnion('op', [...])` cannot work because three branches share
// op=create — Zod requires unique discriminator values per branch and throws at
// schema construction time if violated.
const CreateBranch = z.discriminatedUnion('kind', [
  CreateEntityBranch,
  CreateKnowledgeBranch,
  CreateSessionBranch,
])

export const BatchOperationSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('update'),
    slug: z.string(),
    fields: UpdateFieldsSchema,
  }).strict(),
  // create is a nested discriminatedUnion on `kind` — see CreateBranch above.
  // discriminatedUnion accepts a ZodDiscriminatedUnion as a branch via option-flattening.
  CreateBranch as unknown as z.ZodObject<{ op: z.ZodLiteral<'create'> }>,
  z.object({
    op: z.literal('capture'),
    name: z.string(),
    notes: z.string().optional(),
  }).strict(),
  z.object({
    op: z.literal('link'),
    slug: z.string(),
    target: z.string(),
    relation: z.enum(['parent', 'related']),
  }).strict(),
  z.object({
    op: z.literal('unlink'),
    slug: z.string(),
    target: z.string(),
    relation: z.enum(['parent', 'related']),
  }).strict(),
  z.object({
    op: z.literal('promote'),
    slug: z.string(),
    target: z.enum(['entity', 'project', 'knowledge']),
  }).strict(),
])

export function parseBatchInput(json: string): BatchOperation[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new HafezError('VALIDATION_FAILED', 'Invalid JSON input for batch')
  }

  if (!Array.isArray(parsed)) {
    throw new HafezError('VALIDATION_FAILED', 'Batch input must be a JSON array')
  }

  if (parsed.length === 0) {
    throw new HafezError('VALIDATION_FAILED', 'Batch input must not be empty')
  }

  // Multi-error collect: iterate every op, accumulate formatted failure blocks,
  // throw once at the end with all N errors. Zero ops apply if any fail.
  const operations: BatchOperation[] = []
  const failureBlocks: string[] = []

  for (let i = 0; i < parsed.length; i++) {
    const raw = parsed[i] as Record<string, unknown>

    // Deprecated op: synthesize a failure block so it joins the multi-error
    // array rather than short-circuiting.
    if (raw?.op === 'reinforce') {
      const slugPart = raw.slug ? String(raw.slug) : '...'
      failureBlocks.push(
        [
          `[index ${i}] op=reinforce`,
          `  field: op`,
          `  issue: "reinforce" is deprecated`,
          `  use:   {"op": "update", "slug": "${slugPart}", "fields": {"add_evidence": "your evidence"}}`,
          `  tip: run \`hafez schema update\` for the full field list`,
        ].join('\n'),
      )
      continue
    }

    const result = BatchOperationSchema.safeParse(raw)
    if (!result.success) {
      failureBlocks.push(formatBatchError(result.error.issues, i, raw))
      continue
    }
    const op = result.data as Record<string, unknown> & { fields?: Record<string, unknown> }
    // Alias: insight → synthesis for create knowledge/session and update ops.
    // Runs only on successfully-parsed ops, preserving prior semantics.
    if (op.fields) {
      if (op.fields.insight && !op.fields.synthesis) {
        op.fields.synthesis = op.fields.insight
        delete op.fields.insight
      }
    }
    operations.push(op as BatchOperation)
  }

  if (failureBlocks.length > 0) {
    const header = `Batch contains ${failureBlocks.length} invalid operation${failureBlocks.length === 1 ? '' : 's'} (0 of ${parsed.length} applied, batch aborted):`
    throw new HafezError('VALIDATION_FAILED', header, failureBlocks)
  }

  return operations
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

export async function cmdBatch(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const dryRun = args.includes('--dry-run')
  const input = await readStdin()
  if (!input.trim()) {
    throw new HafezError('VALIDATION_FAILED', 'No input received. Pipe JSON array to stdin: echo \'[...]\' | hafez batch')
  }
  const operations = parseBatchInput(input)
  if (dryRun) {
    if (opts.json) return jsonOut({ valid: true, operations: operations.length })
    return `Batch valid: ${operations.length} operations would be applied`
  }
  const results = await os.batch(operations)
  if (opts.json) return jsonOut(results)
  const created = results.filter(r => r.created).map(r => r.slug)
  let output = `Batch complete: ${operations.length} operations`
  if (created.length > 0) output += ` (created: ${created.join(', ')})`
  return output
}

export async function cmdDigest(os: Hafez, _args: string[], _opts: CommandOpts = {}): Promise<string> {
  // Read stdin — reuses the existing readStdin() defined in this file
  const raw = await readStdin()
  if (!raw.trim()) {
    throw new Error('No input received. Pipe JSON object to stdin: echo \'{"entities_touched":...}\' | hafez digest')
  }

  // Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Invalid JSON on stdin: ' + (raw.slice(0, 80)))
  }

  const result = parseDigestInput(parsed)
  if (!result.success) {
    const fields = result.error.issues.map(i => i.path.join('.')).join(', ')
    throw new Error(`Invalid digest input — missing or invalid fields: ${fields}`)
  }

  // Warn about unknown fields
  if (result.unknownFields.length > 0) {
    process.stderr.write(`Warning: digest input contains unknown fields (may indicate Zod safeParse silent-strip): ${result.unknownFields.join(', ')}\n`)
  }

  // Resolve existing entity slugs — digest only generates update ops for entities
  const { items: entityItems } = await os.query({ filter: 'all', limit: 9999 })
  const existingSlugs = new Set(entityItems.map(i => i.slug))

  // Warn about unknown entity slugs
  const unknownSlugs = result.data.entities_touched.filter(s => !existingSlugs.has(s))
  for (const slug of unknownSlugs) {
    process.stderr.write(`Warning: entity slug '${slug}' not found in vault — skipping session log update\n`)
  }

  const ops = digest(result.data, existingSlugs)
  return JSON.stringify(ops, null, 2)
}

// --- Arg helpers ---

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1) return undefined
  return args[idx + 1]
}

/** Extract positional args by skipping --flag value pairs */
function positionalArgs(args: string[]): string[] {
  const result: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      i++ // skip the flag's value too
    } else {
      result.push(args[i])
    }
  }
  return result
}

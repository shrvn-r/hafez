// src/cli/commands.ts
import { readFileSync } from 'fs'
import { parseArgs, splitList, str, UsageError, type FlagSpec } from './args.js'
import type { Hafez, ReadDepth, EntityType, QueryFilter, ConfidenceLevel, EntityStatus, CreateEntityFields, BatchOperation, KnowledgeQueryOpts, QueryResult, KnowledgeQueryResult } from '../types.js'
import { HafezError } from '../types.js'
import { BatchOperationSchema } from '../batch-ops.js'
import { formatBatchError } from './batch-errors.js'
import { parseDigestInput, digest } from '../digest.js'
import { formatEntityHeader, formatKnowledgeHeader, formatQueryTable, formatKnowledgeTable, formatSearchResults, formatValidation, formatStats, formatChangelog } from './format.js'

export interface CommandOpts { json?: boolean }

function jsonOut(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

const READ_USAGE = 'Usage: hafez read <slug> [--depth frontmatter|summary|full]'
const READ_FLAGS: FlagSpec = { depth: 'string' }

export async function cmdRead(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags, positionals } = parseArgs(args, READ_FLAGS, READ_USAGE)
  const slug = positionals[0]
  if (!slug) throw new UsageError(READ_USAGE)
  const depth = (str(flags.depth) ?? 'summary') as ReadDepth
  const result = await os.read(slug, depth)
  if (opts.json) return jsonOut(result)
  const fm = result.frontmatter as Record<string, any>
  if (result.kind === 'entity') return formatEntityHeader(fm, result.body)
  return formatKnowledgeHeader(fm, result.body)
}

const QUERY_USAGE = 'Usage: hafez query [--kind entity|knowledge|all] [--filter ...] [--type t] [--parent slug] [--related-to slug] [--domain d] [--confidence c] [--subtype s] [--tag t] [--since d] [--before d] [--created-since d] [--created-before d] [--sort-by f] [--sort-order asc|desc] [--limit n] [--offset n]'
const QUERY_FLAGS: FlagSpec = {
  kind: 'string', filter: 'string', type: 'string', parent: 'string', 'related-to': 'string',
  domain: 'string', confidence: 'string', subtype: 'string', tag: 'string',
  since: 'string', before: 'string', 'created-since': 'string', 'created-before': 'string',
  'sort-by': 'string', 'sort-order': 'string', limit: 'string', offset: 'string',
}

export async function cmdQuery(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags } = parseArgs(args, QUERY_FLAGS, QUERY_USAGE)
  const kind = str(flags.kind) ?? 'entity'
  const filter = (str(flags.filter) ?? 'active') as QueryFilter
  const type = str(flags.type) as EntityType | undefined
  const parent = str(flags.parent)
  const relatedTo = str(flags['related-to'])
  const domain = str(flags.domain)
  const confidence = str(flags.confidence) as ConfidenceLevel | undefined
  const since = str(flags.since)
  const before = str(flags.before)
  const createdSince = str(flags['created-since'])
  const createdBefore = str(flags['created-before'])
  const tagRaw = str(flags.tag)
  const tags = tagRaw ? tagRaw.split(',').map(t => t.trim()).filter(Boolean) : undefined
  const sortBy = str(flags['sort-by']) as any
  const sortOrder = str(flags['sort-order']) as 'asc' | 'desc' | undefined
  const limitRaw = str(flags.limit)
  const offsetRaw = str(flags.offset)
  const limit = limitRaw != null ? parseInt(limitRaw, 10) : undefined
  const offset = offsetRaw != null ? parseInt(offsetRaw, 10) : undefined

  const sortOpts = { sort_by: sortBy, sort_order: sortOrder, limit, offset }

  // --related-to: always returns both entities and knowledge
  if (relatedTo) {
    const result = await os.related_to(relatedTo)
    if (opts.json) return jsonOut(result)
    const { items: results, total } = result
    const entities = results.filter(r => r.kind === 'entity')
    const knowledge = results.filter(r => r.kind === 'knowledge')
    const sections: string[] = []
    if (entities.length > 0) sections.push('## Entities\n\n' + formatQueryTable(entities as any, total))
    if (knowledge.length > 0) sections.push('## Knowledge\n\n' + formatKnowledgeTable(knowledge as any, total))
    return sections.length > 0 ? sections.join('\n\n') : 'No results.'
  }

  const queryOpts = { filter, type, parent, domain, since, before, createdSince, createdBefore, tags, ...sortOpts }

  // --kind knowledge: query knowledge only
  // Note: time flags only apply to entity queries.
  if (kind === 'knowledge') {
    const subtype = str(flags.subtype) as any
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

const SEARCH_USAGE = 'Usage: hafez search <terms> [--kind entity|knowledge|all]'
const SEARCH_FLAGS: FlagSpec = { kind: 'string' }

export async function cmdSearch(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags, positionals } = parseArgs(args, SEARCH_FLAGS, SEARCH_USAGE)
  const terms = positionals.join(' ')
  if (!terms) throw new UsageError(SEARCH_USAGE)
  const kind = (str(flags.kind) ?? 'all') as 'entity' | 'knowledge' | 'all'
  const results = await os.search(terms, kind)
  if (opts.json) return jsonOut(results)
  return formatSearchResults(results)
}

const CREATE_USAGE = 'Usage: hafez create <entity|knowledge> <name> [options]'
const CREATE_FLAGS: FlagSpec = {
  type: 'string', purpose: 'string', description: 'string', resource: 'string',
  domain: 'string', parent: 'string', related: 'string', tags: 'string',
  brief: 'string', 'add-action': 'string',
  subtype: 'string', synthesis: 'string', insight: 'string',
}

export async function cmdCreate(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags, positionals } = parseArgs(args, CREATE_FLAGS, CREATE_USAGE)
  const kind = positionals[0]
  if (!kind) throw new UsageError(CREATE_USAGE)

  const name = positionals.slice(1).join(' ')
  if (!name) throw new UsageError(`Usage: hafez create ${kind} <name> [options]`)

  if (kind === 'entity') {
    const type = str(flags.type) as CreateEntityFields['type']
    if (!type) throw new UsageError('--type is required for entity creation')
    const slug = await os.create('entity', name, {
      type,
      purpose: str(flags.purpose),
      description: str(flags.description),
      resource: str(flags.resource),
      domain: splitList(flags.domain),
      parent: str(flags.parent),
      related: str(flags.related)?.split(','),
      tags: str(flags.tags)?.split(','),
      brief: str(flags.brief),
      add_action: str(flags['add-action']),
    })
    return opts.json ? jsonOut({ slug }) : slug
  }

  if (kind === 'knowledge') {
    const slug = await os.create('knowledge', name, {
      subtype: str(flags.subtype) as any,
      synthesis: str(flags.synthesis) ?? str(flags.insight),
      description: str(flags.description),
      domain: str(flags.domain)?.split(','),
      related: str(flags.related)?.split(','),
      tags: str(flags.tags)?.split(','),
    })
    return opts.json ? jsonOut({ slug }) : slug
  }

  throw new UsageError(`Unknown kind: ${kind}. Use entity or knowledge.`)
}

const UPDATE_USAGE = 'Usage: hafez update <slug> [--brief text] [--description text] [--resource uri] [--add-action text] [--complete-action text] [--remove-action text] [--clear-actions] [--status s] [--log "type: summary"]'
const UPDATE_FLAGS: FlagSpec = {
  status: 'string', 'current-state': 'string', brief: 'string',
  'add-action': 'string', 'complete-action': 'string', 'remove-action': 'string',
  'clear-actions': 'boolean', log: 'string', agent: 'string',
  description: 'string', resource: 'string', domain: 'string', confidence: 'string',
  tags: 'string', related: 'string', insight: 'string', synthesis: 'string',
  'add-evidence': 'string', 'add-source': 'string',
  // Removed flag, declared so it fails with guidance instead of a generic
  // unknown-flag error: older installed skills/scripts still pass it, and
  // "Updated <slug>" with the action discarded is a false success.
  'next-action': 'string',
}

export async function cmdUpdate(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags, positionals } = parseArgs(args, UPDATE_FLAGS, UPDATE_USAGE)
  const slug = positionals[0]
  if (!slug) throw new UsageError(UPDATE_USAGE)

  if (flags['next-action'] !== undefined) {
    throw new UsageError('--next-action was removed in v1.0.2. Use --add-action (and --clear-actions) instead.')
  }

  const fields: Record<string, any> = {}
  const status = str(flags.status) as EntityStatus | undefined
  if (status) fields.status = status

  const currentState = str(flags['current-state'])
  if (currentState) fields.current_state = currentState

  // Brief
  const brief = str(flags.brief)
  if (brief !== undefined) {
    fields.brief = brief === '' ? null : brief
  }

  // Next Actions
  const addAction = str(flags['add-action'])
  if (addAction) fields.add_action = addAction

  const completeAction = str(flags['complete-action'])
  if (completeAction) fields.complete_action = completeAction

  const removeAction = str(flags['remove-action'])
  if (removeAction) fields.remove_action = removeAction

  if (flags['clear-actions']) fields.clear_actions = true

  const log = str(flags.log)
  if (log) {
    const colonIdx = log.indexOf(':')
    if (colonIdx === -1) throw new UsageError('--log format: "type: summary". Types: progress, decision, blocker, research')
    const type = log.slice(0, colonIdx).trim()
    const summary = log.slice(colonIdx + 1).trim()
    const agent = str(flags.agent) ?? 'claude'
    fields.session_log = { type, summary, agent }
  }

  // Shared metadata (entity + knowledge)
  const description = str(flags.description)
  if (description !== undefined) fields.description = description
  const resource = str(flags.resource)
  if (resource !== undefined) fields.resource = resource
  const domain = splitList(flags.domain)
  if (domain) fields.domain = domain
  const conf = str(flags.confidence)
  if (conf) fields.confidence = conf
  const tags = splitList(flags.tags)
  if (tags) fields.tags = tags
  const related = splitList(flags.related)
  if (related) fields.related = related
  const insight = str(flags.insight)
  if (insight) fields.synthesis = insight
  const synthesis = str(flags.synthesis)
  if (synthesis) fields.synthesis = synthesis
  const addEvidence = str(flags['add-evidence'])
  if (addEvidence) fields.add_evidence = addEvidence
  const addSource = str(flags['add-source'])
  if (addSource) fields.add_source = addSource

  const result = await os.update(slug, fields)
  if (opts.json) return jsonOut({ slug, ...result })
  const lines = [`Updated ${slug}`]
  if (result.matched_action) {
    lines.push(`matched action: ${result.matched_action}`)
  }
  return lines.join('\n')
}

const LINK_FLAGS: FlagSpec = { relation: 'string' }

function parseLinkArgs(args: string[], verb: 'link' | 'unlink'): { slug: string; target: string; relation: string } {
  const usage = `Usage: hafez ${verb} <slug> <target> --relation <parent|related>`
  const { flags, positionals } = parseArgs(args, LINK_FLAGS, usage)
  const relation = str(flags.relation)
  const [slug, target] = positionals
  if (!slug || !target || !relation) {
    throw new UsageError(usage)
  }
  if (!['parent', 'related'].includes(relation)) {
    throw new UsageError(`Invalid relation: ${relation}. Must be parent or related.`)
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
const CAPTURE_USAGE = 'Usage: hafez capture <name> [--notes "text"]'
const CAPTURE_FLAGS: FlagSpec = { notes: 'string' }

export async function cmdCapture(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags, positionals } = parseArgs(args, CAPTURE_FLAGS, CAPTURE_USAGE)
  const name = positionals.join(' ')
  if (!name) throw new UsageError(CAPTURE_USAGE)
  const notes = str(flags.notes)
  const slug = await os.capture(name, notes)
  return opts.json ? jsonOut({ slug }) : slug
}

const PROMOTE_USAGE = 'Usage: hafez promote <slug> <entity|project|knowledge>'

export async function cmdPromote(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { positionals } = parseArgs(args, {}, PROMOTE_USAGE)
  const [slug, target] = positionals
  if (!slug || !target) throw new UsageError(PROMOTE_USAGE)
  // Target validity is core's rule (contract canPromoteTo) — no CLI re-check.
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

const CHANGELOG_USAGE = 'Usage: hafez changelog --since <date|relative>\nExamples: --since 2026-03-20, --since 7.days.ago, --since 1.week.ago'
const CHANGELOG_FLAGS: FlagSpec = { since: 'string' }

export async function cmdChangelog(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags } = parseArgs(args, CHANGELOG_FLAGS, CHANGELOG_USAGE)
  const since = str(flags.since)
  if (!since) throw new UsageError(CHANGELOG_USAGE)
  const entries = await os.changelog(since)
  if (opts.json) return jsonOut(entries)
  return formatChangelog(entries)
}

// --- Batch ---

// All enums are built from contracts.ts tuples so help-renderer, file validators,
// and CLI-input validator share a single source of truth — drift is structurally
// impossible (the Op Spec table in batch-ops.ts is the only consumer).
// Every z.object(...) is .strict() — unknown keys become `unrecognized_keys` issues
// (not silently dropped), which is load-bearing for the error-formatter's did-you-mean
// hints and for catching typos like `{"kind": "parent"}` on a link op.

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
    const header = `Batch failed validation: ${failureBlocks.length} invalid operation${failureBlocks.length === 1 ? '' : 's'} (0 of ${parsed.length} applied)`
    throw new HafezError('VALIDATION_FAILED', header, failureBlocks)
  }

  return operations
}

// --file payload reader. Exists because Windows PowerShell 5.1 cannot pipe
// stdin to native executables — the documented pipe idiom fails there, so a
// file is the portable session-end path. PowerShell's own redirection writes
// UTF-16LE (and other tools write BOM'd UTF-8), so decode both rather than
// trading the pipe footgun for an encoding one.
function readPayloadFile(path: string): string {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    throw new HafezError('VALIDATION_FAILED', `Cannot read --file: ${path}`)
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '')
  return buf.toString('utf-8').replace(/^\uFEFF/, '')
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

const BATCH_USAGE = "Usage: hafez batch [--dry-run] [--file payload.json]  (or pipe JSON to stdin)"
const BATCH_FLAGS: FlagSpec = { 'dry-run': 'boolean', file: 'string' }

export async function cmdBatch(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags } = parseArgs(args, BATCH_FLAGS, BATCH_USAGE)
  const dryRun = flags['dry-run'] === true
  const file = str(flags.file)
  const input = file ? readPayloadFile(file) : await readStdin()
  if (!input.trim()) {
    throw new HafezError('VALIDATION_FAILED', 'No input received. Pipe JSON array to stdin (echo \'[...]\' | hafez batch) or pass --file payload.json')
  }
  const operations = parseBatchInput(input)
  if (dryRun) {
    // Same validate phase as apply — dry-run can never green-light a payload
    // apply rejects. Reports derived slugs so agents can predict create slugs.
    const report = await os.validateBatch(operations)
    if (opts.json) return jsonOut(report)
    if (!report.valid) {
      const invalidCount = report.operations.filter(o => o.errors.length > 0).length
      const lines = report.operations.flatMap(o => o.errors.map(e => `op[${o.index}] (${o.op} ${o.slug}): ${e}`))
      throw new HafezError(
        'VALIDATION_FAILED',
        `Batch invalid: ${invalidCount} of ${operations.length} operation${operations.length === 1 ? '' : 's'} failed validation (0 would be applied)`,
        lines,
      )
    }
    const out = [`Batch valid: ${operations.length} operations would be applied`]
    const creates = report.operations.filter(o => o.created)
    if (creates.length > 0) {
      out.push('Derived slugs:')
      for (const c of creates) out.push(`  op[${c.index}] ${c.op} → ${c.slug}`)
    }
    for (const o of report.operations) {
      if (o.warning) out.push(`Warning: op[${o.index}] ${o.warning}`)
    }
    return out.join('\n')
  }
  const results = await os.batch(operations)
  if (opts.json) return jsonOut(results)
  const created = results.filter(r => r.created).map(r => r.slug)
  let output = `Batch complete: ${operations.length} operations`
  if (created.length > 0) output += ` (created: ${created.join(', ')})`
  return output
}

const DIGEST_USAGE = 'Usage: hafez digest [--file summary.json]  (or pipe JSON to stdin)'
const DIGEST_FLAGS: FlagSpec = { file: 'string' }

export async function cmdDigest(os: Hafez, args: string[], _opts: CommandOpts = {}): Promise<string> {
  const { flags } = parseArgs(args, DIGEST_FLAGS, DIGEST_USAGE)
  const file = str(flags.file)
  const raw = file ? readPayloadFile(file) : await readStdin()
  if (!raw.trim()) {
    throw new UsageError('No input received. Pipe JSON object to stdin (echo \'{"entities_touched":...}\' | hafez digest) or pass --file summary.json')
  }

  // Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HafezError('VALIDATION_FAILED', 'Invalid JSON on stdin: ' + (raw.slice(0, 80)))
  }

  const result = parseDigestInput(parsed)
  if (!result.success) {
    const fields = result.error.issues.map(i => i.path.join('.')).join(', ')
    throw new HafezError('VALIDATION_FAILED', `Invalid digest input — missing or invalid fields: ${fields}`)
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


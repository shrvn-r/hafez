// src/query.ts
import type { QueryFilter, EntityType, QueryResult, KnowledgeQueryResult, ConfidenceLevel, EntityQueryOpts, KnowledgeQueryOpts, UnifiedResult } from './types.js'
import { HafezError } from './types.js'
import type { HafezIndex, QueryOpts } from './db.js'

function toQueryResult(slug: string, row: Record<string, any>): QueryResult {
  return {
    slug,
    name: row.name,
    type: row.type,
    status: row.status,
    description: row.description ?? null,
    resource: row.resource ?? null,
    domain: row.domain ?? [],
    last_touched: row.last_touched,
    next_action: row.next_action ?? null,
    next_action_count: row.next_action_count ?? 0,
    parent: row.parent ?? null,
    related: row.related ?? [],
    staleness_days: row.staleness_days ?? null,
    tags: row.tags ?? [],
    brief: row.brief ?? null,
    session_log_count: row.session_log_count ?? 0,
    last_session_date: row.last_session_date ?? null,
    last_session_type: row.last_session_type ?? null,
    last_session_summary: row.last_session_summary ?? null,
  }
}

function toKnowledgeResult(slug: string, row: Record<string, any>): KnowledgeQueryResult {
  return {
    slug,
    name: row.name,
    description: row.description ?? null,
    domain: row.domain ?? [],
    confidence: row.confidence ?? 'observation',
    related: row.related ?? [],
    reinforcement_count: row.reinforcement_count ?? 0,
    last_reinforced: row.last_reinforced ?? null,
    last_touched: row.last_touched ?? null,
  }
}

const STATUS_FILTERS = new Set<string>(['active', 'paused', 'done'])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function validateDateOpts(opts?: EntityQueryOpts): void {
  const fields = ['since', 'before', 'createdSince', 'createdBefore'] as const
  for (const f of fields) {
    if (opts?.[f] !== undefined && !ISO_DATE.test(opts[f]!)) {
      throw new HafezError('VALIDATION_FAILED', `Invalid date format for ${f}: "${opts[f]}". Must be YYYY-MM-DD.`)
    }
  }
}

export function queryEntities(index: HafezIndex, opts?: EntityQueryOpts): { items: QueryResult[], total: number } {
  index.syncIfStale()
  validateDateOpts(opts)
  const qopts: QueryOpts = { kind: 'entity' }
  if (opts?.filter && STATUS_FILTERS.has(opts.filter)) qopts.status = opts.filter
  if (opts?.filter === 'stale') qopts.filter = 'stale'
  if (opts?.filter === 'capture') qopts.filter = 'capture'
  if (opts?.type) qopts.type = opts.type
  if (opts?.parent) qopts.parent = opts.parent
  if (opts?.domain) qopts.domain = opts.domain
  if (opts?.since) qopts.since = opts.since
  if (opts?.before) qopts.before = opts.before
  if (opts?.createdSince) qopts.createdSince = opts.createdSince
  if (opts?.createdBefore) qopts.createdBefore = opts.createdBefore
  if (opts?.tags) qopts.tags = opts.tags
  if (opts?.sort_by) qopts.sort_by = opts.sort_by
  if (opts?.sort_order) qopts.sort_order = opts.sort_order
  if (opts?.limit != null) qopts.limit = opts.limit
  if (opts?.offset != null) qopts.offset = opts.offset
  const { items, total } = index.queryItems(qopts)
  return { items: items.map(i => toQueryResult(i.slug, i)), total }
}

export function queryChildren(index: HafezIndex, parentSlug: string): { items: QueryResult[], total: number } {
  return queryEntities(index, { parent: parentSlug })
}

export function queryRelatedTo(index: HafezIndex, slug: string, relation?: string): { items: (QueryResult | KnowledgeQueryResult)[], total: number } {
  index.syncIfStale()
  const { items, total } = index.queryItems({ relatedTo: slug, relation })
  return {
    items: items.map(i =>
      i.kind === 'entity' ? toQueryResult(i.slug, i) : toKnowledgeResult(i.slug, i)
    ),
    total,
  }
}

export function queryKnowledge(index: HafezIndex, opts?: KnowledgeQueryOpts): { items: KnowledgeQueryResult[], total: number } {
  index.syncIfStale()
  const qopts: QueryOpts = { kind: 'knowledge' }
  if (opts?.domain) qopts.domain = opts.domain
  if (opts?.confidence) qopts.confidence = opts.confidence
  if (opts?.subtype) qopts.subtype = opts.subtype
  if (opts?.tags) qopts.tags = opts.tags
  if (opts?.sort_by) qopts.sort_by = opts.sort_by
  if (opts?.sort_order) qopts.sort_order = opts.sort_order
  if (opts?.limit != null) qopts.limit = opts.limit
  if (opts?.offset != null) qopts.offset = opts.offset
  const { items, total } = index.queryItems(qopts)
  return { items: items.map(i => toKnowledgeResult(i.slug, i)), total }
}

export function queryUnified(
  index: HafezIndex,
  opts?: EntityQueryOpts & { kind?: 'entity' | 'knowledge' | 'all' },
): { items: UnifiedResult[], total: number } {
  index.syncIfStale()
  validateDateOpts(opts)
  const qopts: QueryOpts = {}
  if (opts?.kind && opts.kind !== 'all') qopts.kind = opts.kind
  // When kind is 'all' or unset, no kind filter — both entities and knowledge are returned
  if (opts?.filter && STATUS_FILTERS.has(opts.filter)) qopts.status = opts.filter
  if (opts?.filter === 'stale') qopts.filter = 'stale'
  if (opts?.filter === 'capture') qopts.filter = 'capture'
  if (opts?.type) qopts.type = opts.type
  if (opts?.parent) qopts.parent = opts.parent
  if (opts?.domain) qopts.domain = opts.domain
  if (opts?.confidence) qopts.confidence = opts.confidence
  if (opts?.since) qopts.since = opts.since
  if (opts?.before) qopts.before = opts.before
  if (opts?.createdSince) qopts.createdSince = opts.createdSince
  if (opts?.createdBefore) qopts.createdBefore = opts.createdBefore
  if (opts?.tags) qopts.tags = opts.tags
  if (opts?.sort_by) qopts.sort_by = opts.sort_by
  if (opts?.sort_order) qopts.sort_order = opts.sort_order
  if (opts?.limit !== undefined) qopts.limit = opts.limit
  if (opts?.offset !== undefined) qopts.offset = opts.offset

  const result = index.queryItems(qopts)
  const items: UnifiedResult[] = result.items.map(i => {
    if (i.kind === 'entity') {
      return { ...toQueryResult(i.slug, i), kind: 'entity' as const }
    } else {
      return { ...toKnowledgeResult(i.slug, i), kind: 'knowledge' as const }
    }
  })
  return { items, total: result.total }
}

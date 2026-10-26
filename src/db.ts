import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { readFileSync, statSync, existsSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { parseFilePath, scanVaultDir, kindDir, INDEXED_KINDS, MUTABLE_KINDS, type VaultKind } from './vault.js'
import { ensureLocalExclude, type VaultIndexRow } from './knowledge-index.js'
import { WIKI_LINK_RE, documentForFile } from './document.js'
import { ENTITY_STATUSES, ENTITY_TYPES, CONFIDENCE_LEVELS, VALID_SUBTYPES, DEFAULT_KNOWLEDGE_SUBTYPE, GRAPH_LAYERS, GRAPH_NOTE_RELATIONS, SYNTHETIC_LAYERS } from './contracts.js'
import { GRAPH_ROW_FIELDS } from './graph/fields.js'
import type { SearchResult, SearchKind, VaultStats, EntityStatus, EntityType, QueryResult, KnowledgeQueryResult, SessionQueryResult, UnifiedResult, EntityQueryOpts, KnowledgeQueryOpts, SessionQueryOpts, UnifiedQueryOpts, SortField, Graph, GraphNode, GraphEdge, GraphOpts } from './types.js'
import { HafezError } from './types.js'
import { STOPWORDS } from './stopwords.js'
import { closestSlugs, type SlugCandidate } from './closest.js'
import { ENTITY_AGE_DAYS_SQL, ENTITY_STALE_SQL, DEFAULT_STALENESS_DAYS, actionAge } from './stale.js'
import { localDay } from './dates.js'

// Bump this when indexing logic changes to force a full rebuild.
// v5: wiki link harvesting (mention relations), parent link indexing, relation filter on queries.
// v6: description column on items.
// v7: resource column on items (entities only).
// v8: per-kind structural section binding (documentFor) changes how brief,
//     next-action, and session-log columns are derived from bodies.
// v9: Document binds the kind-level section union (no type/subtype
//     narrowing), changing section boundaries body columns derive from.
// v10: re-indexing an externally changed file is delete-then-insert instead of
//     INSERT OR REPLACE. Indexes written by v9 and earlier may hold ghost FTS
//     rows (REPLACE never fired the delete trigger) and must be rebuilt, not reused.
// v11: next_action and the searchable body store action text with its
//     added-date stamp stripped.
// v12: sessions are indexed (#35); session_date column.
// v13: action_added column, the open actions' added days (the Graph's stale-action count, #271).
// v14: resource holds the entity's list as JSON (#304).
// Existing instances will fully rebuild the index on first access after upgrade.
export const SCHEMA_VERSION = '14'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS items (
  slug               TEXT PRIMARY KEY,
  kind               TEXT NOT NULL,
  name               TEXT NOT NULL,
  type               TEXT,
  status             TEXT,
  parent             TEXT,
  next_action        TEXT,
  next_action_count  INTEGER DEFAULT 0,
  staleness_days     INTEGER,
  confidence         TEXT,
  reinforcement_count INTEGER,
  last_reinforced    TEXT,
  created            TEXT NOT NULL,
  last_touched       TEXT,
  body               TEXT NOT NULL,
  file_hash          TEXT NOT NULL,
  subtype            TEXT,
  description        TEXT,
  resource           TEXT,
  brief              TEXT,
  session_log_count  INTEGER DEFAULT 0,
  last_session_date  TEXT,
  last_session_type  TEXT,
  last_session_summary TEXT,
  session_date       TEXT,
  action_added       TEXT
);

CREATE TABLE IF NOT EXISTS links (
  source   TEXT NOT NULL,
  target   TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (source, target, relation)
);

CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  name, body,
  content=items,
  content_rowid=rowid
);

CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, name, body) VALUES (new.rowid, new.name, new.body);
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, name, body) VALUES ('delete', old.rowid, old.name, old.body);
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, name, body) VALUES ('delete', old.rowid, old.name, old.body);
  INSERT INTO items_fts(rowid, name, body) VALUES (new.rowid, new.name, new.body);
END;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

interface IndexItem {
  slug: string
  kind: VaultKind
  name: string
  type: string | null
  status: string | null
  parent: string | null
  next_action: string | null
  next_action_count: number
  staleness_days: number | null
  confidence: string | null
  reinforcement_count: number | null
  last_reinforced: string | null
  created: string
  last_touched: string | null
  body: string
  file_hash: string
  subtype: string | null
  description: string | null
  resource: string | null          // the entity's list as JSON, null when none
  brief: string | null
  session_log_count: number
  last_session_date: string | null
  last_session_type: string | null
  last_session_summary: string | null
  session_date: string | null
  /** An entity's open actions' added days as a JSON array, null for an undated line. */
  action_added: string | null
}

export interface IndexQueryResult {
  items: IndexItem[]
  total: number
}

export interface HafezIndex {
  rebuild(): void
  /** Catch the index up with the files, whatever the mode: a stat per note
   * (read-only: reopen a database another process rewrote). */
  syncIfStale(): void
  /** What a read runs first, by the index's `sync` mode (`IndexOpts`). */
  syncForRead(): void
  upsertFromFile(slug: string, kind: VaultKind): void
  removeItem(slug: string): void
  queryItems(opts: QueryOpts): IndexQueryResult
  search(query: string, kind?: SearchKind): SearchResult[]
  getStats(): VaultStats
  /** Every indexed document, in the shape index.md is rendered from. */
  indexEntries(): VaultIndexRow[]
  /** The rows the Graph is shaped from: every item, every link. */
  graphRows(): GraphRows
  close(): void
  // The public read surface (S5): the index's interface IS the query
  // interface — staleness sync, opts mapping, and row shaping live behind
  // these instead of in a pass-through module.
  queryEntities(opts?: EntityQueryOpts): { items: QueryResult[]; total: number }
  queryChildren(parentSlug: string): { items: QueryResult[]; total: number }
  queryRelatedTo(slug: string, relation?: string): { items: UnifiedResult[]; total: number }
  queryKnowledge(opts?: KnowledgeQueryOpts): { items: KnowledgeQueryResult[]; total: number }
  querySessions(opts?: SessionQueryOpts): { items: SessionQueryResult[]; total: number }
  queryUnified(opts?: UnifiedQueryOpts): { items: UnifiedResult[]; total: number }
  queryGraph(opts?: GraphOpts): Graph
}

export interface GraphRows {
  items: Array<Pick<IndexItem, 'slug' | 'kind' | 'name' | 'type' | 'status' | 'subtype' | 'confidence' | 'last_touched' | 'description' | 'next_action_count' | 'staleness_days' | 'action_added'> & {
    /** Entity-stale by the index's stale rule, 1 or 0; null for a note with no last-touched. */
    stale: number | null
  }>
  links: Array<{ source: string; target: string; relation: string }>
}

/** `kind` unset is the working set, entity + knowledge; `all` is literal. */
export interface QueryOpts {
  kind?: VaultKind | 'all'
  status?: string
  type?: string
  subtype?: string
  parent?: string
  relatedTo?: string
  relation?: string
  domain?: string
  confidence?: string
  filter?: string
  since?: string
  before?: string
  createdSince?: string
  createdBefore?: string
  tags?: string[]
  sort_by?: SortField
  sort_order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

// --- Query input validation ---
//
// Every enum-ish query opt is checked before it can influence (or fail to
// influence) SQL. The mappers below only forward values they recognise, so an
// unchecked typo used to be *dropped*: `--filter actvie` ran unfiltered and
// exited 0. Validating here covers the CLI and library callers at once.

const SORT_COL_MAP: Record<string, string> = {
  name: 'i.name',
  created: 'i.created',
  last_touched: 'i.last_touched',
  staleness: 'i.staleness_days',
  reinforcement_count: 'i.reinforcement_count',
  last_reinforced: 'i.last_reinforced',
  session_date: 'i.session_date',
}
/** Sort fields one branch cannot honour: the column is NULL for its rows. */
const SORT_REJECTS: Record<VaultKind, ReadonlySet<string>> = {
  entity: new Set(['reinforcement_count', 'last_reinforced', 'session_date']),
  knowledge: new Set(['session_date']),
  session: new Set(['reinforcement_count', 'last_reinforced', 'last_touched', 'staleness']),
}
const SORT_FIELDS = Object.keys(SORT_COL_MAP)
const SORT_ORDERS = ['asc', 'desc'] as const
const QUERY_FILTERS = [...ENTITY_STATUSES, 'all', 'stale', 'capture'] as const

function assertEnum(value: unknown, valid: readonly string[], label: string): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'string' || !valid.includes(value)) {
    throw new HafezError('VALIDATION_FAILED', `Invalid ${label}: "${String(value)}". Valid values: ${valid.join(', ')}.`)
  }
}

function assertSortOrder(value: unknown): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'string' || !SORT_ORDERS.includes(value.toLowerCase() as 'asc' | 'desc')) {
    throw new HafezError('VALIDATION_FAILED', `Invalid sort_order: "${String(value)}". Valid values: asc, desc.`)
  }
}

function assertCount(value: unknown, label: 'limit' | 'offset'): void {
  if (value === undefined || value === null) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new HafezError('VALIDATION_FAILED', `Invalid ${label}: "${String(value)}". Must be a non-negative integer.`)
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
type TimeOpts = Pick<EntityQueryOpts, 'since' | 'before' | 'createdSince' | 'createdBefore'>

function validateTimeOpts(opts?: TimeOpts): void {
  const fields = ['since', 'before', 'createdSince', 'createdBefore'] as const
  for (const f of fields) {
    if (opts?.[f] !== undefined && !ISO_DATE.test(opts[f]!)) {
      throw new HafezError('VALIDATION_FAILED', `Invalid date format for ${f}: "${opts[f]}". Must be YYYY-MM-DD.`)
    }
  }
}

function validateListOpts(opts?: ListOpts): void {
  assertEnum(opts?.sort_by, SORT_FIELDS, 'sort_by')
  assertSortOrder(opts?.sort_order)
  assertCount(opts?.limit, 'limit')
  assertCount(opts?.offset, 'offset')
}

// --- Shared query functions (used by both write and readonly paths) ---

function sanitizeFtsQuery(raw: string): { fts: string; terms: string[] } {
  // Unicode-aware: keep letters/digits/underscore in ANY script, strip
  // punctuation. `[^\w\s]` was ASCII-only, so it erased whole non-Latin
  // queries (日本語 → '') and the vault's non-Latin notes were unfindable.
  // For ASCII input this class is identical to the old one.
  const cleaned = raw.replace(/[^\p{L}\p{N}_\s]/gu, ' ')
  const tokens = cleaned.split(/\s+/).filter(t => t.length > 0)
  const filtered = tokens.filter(t => !STOPWORDS.has(t.toLowerCase()))
  // All-stopword queries fall back to the raw tokens — which is how bare
  // AND/OR/NOT reach fts5. Quoting makes every term a literal string, never
  // an operator, and a trailing `*` still gives prefix matching.
  const terms = filtered.length === 0 ? tokens : filtered
  return { fts: terms.map(t => `"${t.replace(/"/g, '""')}"*`).join(' OR '), terms }
}

function queryItemsFn(db: InstanceType<typeof Database>, opts: QueryOpts): IndexQueryResult {
  const conditions: string[] = []
  const params: Record<string, any> = {}

  if (opts.kind && opts.kind !== 'all') {
    conditions.push('i.kind = @kind')
    params.kind = opts.kind
  } else if (!opts.kind) {
    // Unset is the working set. Sessions are a record of what happened, not
    // a thing being worked on, and each one names every entity it touched:
    // in the default view they would crowd out the note being looked for.
    conditions.push("i.kind != 'session'")
  }
  if (opts.status) {
    // Status is an entity attribute — other kinds are indexed with a NULL
    // status. In a kind-unset (unified) query the status filter narrows the
    // entity side only; applying it to every row is what made `query --kind
    // all` (filter defaults to active) return entities and nothing else.
    conditions.push(opts.kind === 'entity' ? 'i.status = @status' : "(i.kind != 'entity' OR i.status = @status)")
    params.status = opts.status
  }
  if (opts.type) {
    conditions.push('i.type = @type')
    params.type = opts.type
  }
  if (opts.subtype) {
    conditions.push('i.subtype = @subtype')
    params.subtype = opts.subtype
  }
  if (opts.parent) {
    conditions.push('i.parent = @parent')
    params.parent = opts.parent
  }
  if (opts.confidence) {
    conditions.push('i.confidence = @confidence')
    params.confidence = opts.confidence
  }

  if (opts.domain) {
    conditions.push("EXISTS (SELECT 1 FROM links l WHERE l.source = i.slug AND l.relation = 'domain' AND l.target = @domain)")
    params.domain = opts.domain
  }
  if (opts.relatedTo) {
    const effectiveRelation = opts.relation ?? 'related' // backward compat default
    if (effectiveRelation === 'all') {
      conditions.push("EXISTS (SELECT 1 FROM links l WHERE l.source = i.slug AND l.target = @relatedTo)")
      params.relatedTo = opts.relatedTo
    } else {
      conditions.push("EXISTS (SELECT 1 FROM links l WHERE l.source = i.slug AND l.target = @relatedTo AND l.relation = @relation)")
      params.relatedTo = opts.relatedTo
      params.relation = effectiveRelation
    }
  }

  if (opts.filter === 'stale') {
    conditions.push("i.kind = 'entity'")
    conditions.push("i.status = 'active'")
    conditions.push(`(${ENTITY_STALE_SQL})`)
    params.today = localDay()
  }
  if (opts.filter === 'capture') {
    conditions.push("i.type = 'capture'")
  }

  // A session's one day is its session date: the window reads it where an
  // entity or knowledge note has last_touched.
  if (opts.since) {
    conditions.push('COALESCE(i.last_touched, i.session_date) >= @since')
    params.since = opts.since
  }
  if (opts.before) {
    conditions.push('COALESCE(i.last_touched, i.session_date) <= @before')
    params.before = opts.before
  }
  if (opts.createdSince) {
    conditions.push('i.created >= @createdSince')
    params.createdSince = opts.createdSince
  }
  if (opts.createdBefore) {
    conditions.push('i.created <= @createdBefore')
    params.createdBefore = opts.createdBefore
  }

  if (opts.tags?.length) {
    for (let i = 0; i < opts.tags.length; i++) {
      const paramKey = `tag${i}`
      conditions.push(`EXISTS (SELECT 1 FROM links WHERE source = i.slug AND relation = 'tag' AND target = @${paramKey})`)
      params[paramKey] = opts.tags[i]
    }
  }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''

  // sort_order / limit / offset are the three opts that reach SQL as text
  // rather than bound params — check them at the interpolation site, so a
  // caller that skips the read surface can't hand raw SQL to prepare().
  assertSortOrder(opts.sort_order)
  assertCount(opts.limit, 'limit')
  assertCount(opts.offset, 'offset')

  let sortCol = opts.kind === 'session' ? 'i.session_date' : 'i.last_touched'
  if (opts.sort_by) {
    // Same rule as the unmappable opts, one code path over: a sort field the
    // branch cannot honour is rejected, not quietly swapped for recency.
    if (opts.kind && opts.kind !== 'all' && SORT_REJECTS[opts.kind].has(opts.sort_by)) {
      outOfScope('sort_by', opts.sort_by, opts.kind)
    }
    if (SORT_COL_MAP[opts.sort_by]) sortCol = SORT_COL_MAP[opts.sort_by]
  }

  let sortOrder: 'ASC' | 'DESC'
  if (opts.sort_order) {
    sortOrder = opts.sort_order.toUpperCase() as 'ASC' | 'DESC'
  } else if (opts.sort_by === 'name' || opts.sort_by === 'staleness') {
    sortOrder = 'ASC'
  } else {
    sortOrder = 'DESC'
  }

  const countSql = `SELECT COUNT(*) as cnt FROM items i ${where}`
  const totalRow = db.prepare(countSql).get(params) as { cnt: number }
  const total = totalRow.cnt

  let limitClause = ''
  if (opts.limit != null) {
    limitClause = ` LIMIT ${opts.limit}`
    if (opts.offset != null) {
      limitClause += ` OFFSET ${opts.offset}`
    }
  } else if (opts.offset != null) {
    limitClause = ` LIMIT -1 OFFSET ${opts.offset}`
  }

  const sql = `SELECT i.slug, i.kind, i.name, i.type, i.status, i.parent,
                      i.next_action, i.next_action_count, i.staleness_days,
                      i.confidence, i.reinforcement_count, i.last_reinforced,
                      i.created, i.last_touched, i.subtype,
                      i.description, i.resource, i.brief, i.session_log_count, i.last_session_date,
                      i.last_session_type, i.last_session_summary, i.session_date
               FROM items i ${where}
               ORDER BY ${sortCol} ${sortOrder}${limitClause}`

  const rows = db.prepare(sql).all(params) as IndexItem[]

  const getRelated = db.prepare("SELECT target FROM links WHERE source = ? AND relation = 'related'")
  const getDomains = db.prepare("SELECT target FROM links WHERE source = ? AND relation = 'domain'")
  const getTags = db.prepare("SELECT target FROM links WHERE source = ? AND relation = 'tag'")
  for (const row of rows) {
    (row as any).related = (getRelated.all(row.slug) as Array<{ target: string }>).map(r => r.target)
    ;(row as any).domain = (getDomains.all(row.slug) as Array<{ target: string }>).map(r => r.target)
    ;(row as any).tags = (getTags.all(row.slug) as Array<{ target: string }>).map(r => r.target)
  }

  return { items: rows, total }
}

/** Every indexed document, in the shape index.md renders from. The vault-root
 * index needs name/status/type/confidence/description/domain and the body (for
 * the derived summary) — all of it already indexed, so regenerating index.md
 * after a mutation costs one query instead of a second full-vault parse. */
function indexEntriesFn(db: InstanceType<typeof Database>): VaultIndexRow[] {
  const rows = db.prepare(
    'SELECT slug, kind, name, type, status, confidence, description, body FROM items'
  ).all() as Array<Omit<VaultIndexRow, 'domain'>>
  const getDomains = db.prepare("SELECT target FROM links WHERE source = ? AND relation = 'domain'")
  return rows.map(row => ({
    ...row,
    domain: (getDomains.all(row.slug) as Array<{ target: string }>).map(d => d.target),
  }))
}

function graphRowsFn(db: InstanceType<typeof Database>): GraphRows {
  return {
    items: db.prepare(
      `SELECT slug, kind, name, type, status, subtype, confidence, last_touched, description,
              next_action_count, staleness_days, action_added, (${ENTITY_STALE_SQL}) AS stale
       FROM items i ORDER BY slug`
    ).all({ today: localDay() }) as GraphRows['items'],
    links: db.prepare('SELECT source, target, relation FROM links ORDER BY source, target, relation').all() as GraphRows['links'],
  }
}

function searchFn(db: InstanceType<typeof Database>, query: string, kind?: SearchKind): SearchResult[] {
  const { fts: ftsQuery, terms } = sanitizeFtsQuery(query)
  if (!ftsQuery) return []

  // Same rule as queryItemsFn: unset is the working set, `all` is literal.
  let kindFilter = "AND i.kind != 'session'"
  const params: Record<string, any> = { query: ftsQuery }
  if (kind === 'all') {
    kindFilter = ''
  } else if (kind) {
    kindFilter = 'AND i.kind = @kind'
    params.kind = kind
  }

  const nameExact = query.replace(/'/g, "''")
  const nameLike = terms.map(t => `i.name LIKE '%${t.replace(/'/g, "''")}%'`).join(' AND ')
  const nameTermCount = terms.length > 1
    ? '0 - (' + terms.map(t => `(CASE WHEN LOWER(i.name) LIKE '%${t.replace(/'/g, "''").toLowerCase()}%' THEN 1 ELSE 0 END)`).join(' + ') + ')'
    : 'NULL'
  const termCoverageExpr = terms.length > 1
    ? '0 - (' + terms.map(t => {
        const escaped = t.replace(/'/g, "''").toLowerCase()
        return `(CASE WHEN LOWER(i.name) || ' ' || LOWER(i.body) LIKE '%${escaped}%' THEN 1 ELSE 0 END)`
      }).join(' + ') + ')'
    : 'NULL'
  const tfExpr = terms.length > 0
    ? '0 - (' + terms.map(t => {
        const escaped = t.replace(/'/g, "''").toLowerCase()
        return `(LENGTH(LOWER(i.body)) - LENGTH(REPLACE(LOWER(i.body), '${escaped}', ''))) / MAX(LENGTH('${escaped}'), 1)`
      }).join(' + ') + ')'
    : 'NULL'

  const sql = `
    SELECT i.slug, i.kind, i.name, i.type, i.status, i.confidence,
           snippet(items_fts, 1, '**', '**', '...', 30) as snippet
    FROM items_fts f
    JOIN items i ON i.rowid = f.rowid
    WHERE items_fts MATCH @query ${kindFilter}
    ORDER BY
      CASE
        WHEN LOWER(i.name) = LOWER('${nameExact}') THEN 0
        WHEN (${nameLike}) THEN 1
        ELSE 2
      END,
      ${nameTermCount},
      ${termCoverageExpr},
      ${tfExpr}
    LIMIT 20
  `

  return db.prepare(sql).all(params) as SearchResult[]
}

function getStatsFn(db: InstanceType<typeof Database>): VaultStats {
  const counts: Record<string, number> = { active: 0, paused: 0, done: 0 }
  const statusRows = db.prepare("SELECT status, COUNT(*) as cnt FROM items WHERE kind = 'entity' GROUP BY status").all() as Array<{ status: string; cnt: number }>
  for (const row of statusRows) {
    if (row.status in counts) counts[row.status] = row.cnt
  }

  const by_type: Record<string, number> = { capture: 0, entity: 0, project: 0 }
  const typeRows = db.prepare("SELECT type, COUNT(*) as cnt FROM items WHERE kind = 'entity' GROUP BY type").all() as Array<{ type: string; cnt: number }>
  for (const row of typeRows) {
    if (row.type in by_type) by_type[row.type] = row.cnt
  }

  const stale = db.prepare(`
    SELECT slug, name, type, ${ENTITY_AGE_DAYS_SQL} as days_since_touched
    FROM items i
    WHERE kind = 'entity' AND status = 'active' AND ${ENTITY_STALE_SQL}
    ORDER BY days_since_touched DESC
  `).all({ today: localDay() }) as Array<{ slug: string; name: string; type: EntityType; days_since_touched: number }>

  const no_next_action = db.prepare(`
    SELECT slug, name, type FROM items
    WHERE kind = 'entity' AND status = 'active' AND next_action_count = 0
    ORDER BY last_touched DESC
  `).all() as Array<{ slug: string; name: string; type: EntityType }>

  // Full lists, not top-5: day-granularity timestamps tie massively (a
  // new vault ties on everything), so the caller resolves ties (git commit
  // time, then name) and caps. Name tiebreak here keeps the base order
  // deterministic instead of leaking SQLite row order.
  const recently_touched = db.prepare(`
    SELECT slug, name, last_touched FROM items
    WHERE kind = 'entity'
    ORDER BY last_touched DESC, name COLLATE NOCASE ASC
  `).all() as Array<{ slug: string; name: string; last_touched: string }>

  const recently_created = db.prepare(`
    SELECT slug, name, created FROM items
    WHERE kind = 'entity'
    ORDER BY created DESC, name COLLATE NOCASE ASC
  `).all() as Array<{ slug: string; name: string; created: string }>

  const knowledgeCount = (db.prepare("SELECT COUNT(*) as cnt FROM items WHERE kind = 'knowledge'").get() as { cnt: number }).cnt

  return {
    counts: counts as VaultStats['counts'],
    by_type: by_type as VaultStats['by_type'],
    knowledge_count: knowledgeCount,
    stale,
    no_next_action,
    recently_touched,
    recently_created,
  }
}

// Internal test seam — NOT public API (createHafez never exposes it). Fires
// inside syncIfStale after the scan has read the vault and before the new
// watermark is recorded, so the mid-scan-write race can be injected
// deterministically instead of raced against the clock.
// Recorded sync watermarks sit this far behind the scan-start instant: FS
// timestamps and Date.now() are read from the same kernel clock but round
// differently, and a write landing in that rounding gap must stay dirty.
const WATERMARK_SLACK_MS = 10

let afterScanHook: (() => void) | null = null
/** @internal */
export function __setAfterScanHook(fn: (() => void) | null): void { afterScanHook = fn }

// Internal test seam — NOT public API. Fires inside indexFile at two steps of
// a note's replacement, so a second instance's sync can be run against it
// (#293): 'changed' once the hash is found changed, before the write
// transaction begins; 'deleted' inside it, between the delete and the insert.
type ReplaceStep = 'changed' | 'deleted'
let replaceHook: ((step: ReplaceStep) => void) | null = null
/** @internal */
export function __setReplaceHook(fn: ((step: ReplaceStep) => void) | null): void { replaceHook = fn }

// --- createIndex: overloaded for write and readonly modes ---

/** `sync`: what `syncForRead`, run first by every read-surface query, does.
 * 'read' (default): runs `syncIfStale`. 'once': runs it until a sync has
 * caught the index up, then trusts the index (#269). 'manual': trusts the
 * index, and the caller syncs it. */
export type IndexSync = 'read' | 'once' | 'manual'
export interface IndexOpts { sync?: IndexSync }

export function createIndex(vaultPath: string, opts?: IndexOpts & { readonly?: false }): HafezIndex
export function createIndex(vaultPath: string, opts: IndexOpts & { readonly: true }): HafezIndex | null
export function createIndex(vaultPath: string, opts?: IndexOpts & { readonly?: boolean }): HafezIndex | null {
  const dbPath = join(vaultPath, '.hafez.db')
  const isReadOnly = opts?.readonly ?? false
  const sync = opts?.sync ?? 'read'

  if (isReadOnly) {
    if (!existsSync(dbPath)) return null

    let db = new Database(dbPath, { readonly: true })
    db.pragma('busy_timeout = 5000')
    let dbMtime = statSync(dbPath).mtimeMs

    // A stale schema is unusable, not merely stale: queries SELECT columns that
    // older schemas lack (e.g. description/resource) and would throw SqliteError.
    // Treat a version mismatch like a missing DB — warn and return null so
    // callers degrade to empty results until a write-capable command rebuilds.
    let storedVersion: string | undefined
    try {
      const vr = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
      storedVersion = vr?.value
    } catch { /* meta table may not exist */ }
    if (storedVersion !== SCHEMA_VERSION) {
      process.stderr.write(`Warning: .hafez.db schema v${storedVersion ?? 'unknown'} != expected v${SCHEMA_VERSION}. Ignoring index until a write command (e.g. hafez index rebuild) rebuilds it.\n`)
      try { db.close() } catch {}
      return null
    }

    function syncIfStale(): void {
      try {
        const currentMtime = statSync(dbPath).mtimeMs
        if (currentMtime !== dbMtime) {
          try { db.close() } catch {}
          db = new Database(dbPath, { readonly: true })
          db.pragma('busy_timeout = 5000')
          dbMtime = currentMtime
        }
      } catch { /* DB may have been temporarily deleted during rebuild */ }
    }

    return withReadSurface({
      rebuild: () => { throw new Error('Index is read-only') },
      syncIfStale,
      upsertFromFile: () => { throw new Error('Index is read-only') },
      removeItem: () => { throw new Error('Index is read-only') },
      queryItems: (qopts) => queryItemsFn(db, qopts),
      search: (q, k) => searchFn(db, q, k),
      getStats: () => getStatsFn(db),
      indexEntries: () => indexEntriesFn(db),
      graphRows: () => graphRowsFn(db),
      close: () => { try { db.close() } catch {} },
    }, sync)
  }

  // --- Write-capable path ---
  // The db files are a disposable local cache — keep them out of the user's
  // `git status` without dirtying their vault with a tracked .gitignore.
  ensureLocalExclude(vaultPath)

  function removeDbFiles(): void {
    // The -wal/-shm siblings must go too: a fresh db next to a stale WAL is
    // itself corrupt.
    for (const suffix of ['', '-wal', '-shm']) {
      try { unlinkSync(dbPath + suffix) } catch { /* may not exist */ }
    }
  }

  function openDb(): InstanceType<typeof Database> {
    const fresh = new Database(dbPath)
    try {
      fresh.pragma('journal_mode = WAL')
      fresh.pragma('busy_timeout = 5000')
      fresh.pragma('foreign_keys = ON')
      fresh.exec(SCHEMA)
      return fresh
    } catch (err) {
      // Close before the caller unlinks — on filesystems without POSIX
      // delete-while-open semantics, unlinking an open db fails silently and
      // recovery would just reopen the same corrupt file.
      try { fresh.close() } catch { /* already unusable */ }
      throw err
    }
  }

  let db: InstanceType<typeof Database>
  try {
    db = openDb()
  } catch {
    // Corrupted DB (garbage bytes, truncated WAL checkpoint). better-sqlite3
    // doesn't touch the file until the first statement, so corruption surfaces
    // at the pragma/exec inside openDb, not at the constructor — the whole
    // open sequence must be inside this catch. The index is a disposable
    // cache: delete and rebuild.
    removeDbFiles()
    db = openDb()
  }

  // Schema migration: if next_action_count column missing, delete DB and recreate
  try {
    db.prepare('SELECT next_action_count FROM items LIMIT 0').run()
  } catch {
    db.close()
    removeDbFiles()
    db = openDb()
  }

  // Schema migration: if domain_entity column exists, delete DB and recreate
  try {
    db.prepare('SELECT domain_entity FROM items LIMIT 0').run()
    // Column exists — old schema, needs rebuild
    db.close()
    removeDbFiles()
    db = openDb()
  } catch {
    // Column doesn't exist — correct schema, continue
  }

  // Schema version check — forces full rebuild when indexing logic changes
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
  if (!versionRow || versionRow.value !== SCHEMA_VERSION) {
    db.close()
    removeDbFiles()
    db = openDb()
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION)
  }

  // Prepared statements
  // Plain INSERT, never INSERT OR REPLACE: REPLACE's implicit delete does not
  // fire the AFTER DELETE trigger (recursive_triggers is off), so the replaced
  // row's terms would linger in the external-content FTS index as ghosts.
  // Callers delete the row first — see indexFile.
  const insertStmt = db.prepare(`
    INSERT INTO items
      (slug, kind, name, type, status, parent, next_action, next_action_count, staleness_days,
       confidence, reinforcement_count, last_reinforced, created, last_touched, body, file_hash, subtype,
       description, resource, brief, session_log_count, last_session_date, last_session_type, last_session_summary,
       session_date, action_added)
    VALUES
      (@slug, @kind, @name, @type, @status, @parent, @next_action, @next_action_count, @staleness_days,
       @confidence, @reinforcement_count, @last_reinforced, @created, @last_touched, @body, @file_hash, @subtype,
       @description, @resource, @brief, @session_log_count, @last_session_date, @last_session_type, @last_session_summary,
       @session_date, @action_added)
  `)
  const deleteItemStmt = db.prepare('DELETE FROM items WHERE slug = ?')
  const deleteLinksStmt = db.prepare('DELETE FROM links WHERE source = ?')
  const insertLinkStmt = db.prepare('INSERT OR IGNORE INTO links (source, target, relation) VALUES (?, ?, ?)')
  const getHashStmt = db.prepare('SELECT file_hash FROM items WHERE slug = ?')

  const storedHash = (slug: string): string | undefined =>
    (getHashStmt.get(slug) as { file_hash: string } | undefined)?.file_hash

  function indexFile(filePath: string, kind: VaultKind, knownSlugs?: Set<string>): void {
    const content = readFileSync(filePath, 'utf-8')
    const slug = basename(filePath, '.md')
    const hash = hashContent(content)

    // Skip if unchanged — checked outside any transaction, so a sync over
    // notes another process has already indexed takes no write lock.
    if (storedHash(slug) === hash) return

    replaceHook?.('changed')
    // One IMMEDIATE transaction per note (#293): a second process replacing
    // the same note waits out busy_timeout here instead of interleaving its
    // delete and insert with ours. Per note, never per sync pass — a pass-long
    // write lock on a large pull outlasts the other process's busy_timeout.
    // (A full rebuild is one transaction already; this nests in it.)
    replaceTransaction.immediate(filePath, kind, slug, hash, knownSlugs)
  }

  const replaceTransaction = db.transaction((filePath: string, kind: VaultKind, slug: string, hash: string, knownSlugs?: Set<string>): void => {
    // Re-checked under the write lock: another process may have replaced the
    // row since the check above, and then there is nothing left to do.
    if (storedHash(slug) === hash) return

    let fm: Record<string, any>, body: string
    try {
      const parsed = parseFilePath(filePath)
      fm = parsed.frontmatter as Record<string, any>
      body = parsed.body
    } catch (err) {
      process.stderr.write(`Warning: skipping ${kind}/${slug}.md: failed to parse (${(err as Error).message})\n`)
      return
    }

    // Validate required fields — skip malformed files instead of crashing
    if (!fm.name || !fm.created) {
      const missing = [!fm.name && 'name', !fm.created && 'created'].filter(Boolean).join(', ')
      process.stderr.write(`Warning: skipping ${kind}/${slug}.md: missing required field(s): ${missing}\n`)
      return
    }

    const doc = documentForFile({ kind })
    const bodyActions = doc.getNextActions(body)
    const nextAction = bodyActions.length > 0 ? bodyActions[0] : null
    const nextActionCount = bodyActions.length

    const brief = doc.getBrief(body)?.slice(0, 300) ?? null
    const logs = doc.parseSessionLog(body)
    const lastLog = logs[0] ?? null

    const item: IndexItem = {
      slug,
      kind,
      name: fm.name,
      type: kind === 'entity' ? (fm.type ?? null) : null,
      status: kind === 'entity' ? (fm.status ?? null) : null,
      parent: fm.parent ?? null,
      next_action: nextAction,
      next_action_count: nextActionCount,
      staleness_days: fm['staleness-days'] ?? null,
      confidence: kind === 'knowledge' ? (fm.confidence ?? null) : null,
      reinforcement_count: fm['reinforcement-count'] ?? null,
      last_reinforced: fm['last-reinforced'] ?? null,
      created: fm.created,
      last_touched: fm['last-touched'] ?? null,
      // Search sees action text, not the added-date stamp (file format only).
      body: doc.stripNextActionStamps(body),
      file_hash: hash,
      subtype: kind === 'knowledge' ? (fm.subtype ?? DEFAULT_KNOWLEDGE_SUBTYPE) : null,
      description: fm.description ?? null,
      resource: kind === 'entity' && fm.resource?.length ? JSON.stringify(fm.resource) : null,
      brief,
      session_log_count: logs.length,
      last_session_date: lastLog?.date ?? null,
      last_session_type: lastLog?.type ?? null,
      last_session_summary: lastLog?.summary?.slice(0, 300) ?? null,
      // A session note's one day; the created stamp when digest gave none.
      session_date: kind === 'session' ? (fm['session-date'] ?? fm.created) : null,
      action_added: kind === 'entity'
        ? JSON.stringify(doc.getActionItems(body).flatMap(a => a.handle === undefined ? [] : [a.added]))
        : null,
    }

    // Replace item and rebuild links. Delete-then-insert keeps the FTS index
    // trigger-consistent for externally changed files (hand edit, git pull),
    // the same path hafez's own mutations take via upsertFromFile.
    deleteItemStmt.run(slug)
    deleteLinksStmt.run(slug)
    replaceHook?.('deleted')
    insertStmt.run(item)

    // Index related links
    if (fm.related && Array.isArray(fm.related)) {
      for (const target of fm.related) insertLinkStmt.run(slug, target, 'related')
    }
    // Index tags
    if (fm.tags && Array.isArray(fm.tags)) {
      for (const tag of fm.tags) insertLinkStmt.run(slug, tag, 'tag')
    }
    // Index domains for ALL item types (both entity and knowledge)
    if (fm.domain && Array.isArray(fm.domain)) {
      for (const d of fm.domain) insertLinkStmt.run(slug, d, 'domain')
    }

    // Index parent link
    if (fm.parent) {
      insertLinkStmt.run(slug, fm.parent, 'parent')
    }

    // Harvest [[wiki links]] from body (excluding ## Related section)
    // Strip the Related section to avoid double-counting generated links
    let authoredBody = body
    const relatedSection = doc.findSection(body, 'Related')
    if (relatedSection) {
      authoredBody = body.slice(0, relatedSection.start) + body.slice(relatedSection.end)
    }
    let wikiMatch: RegExpExecArray | null
    const linkRe = new RegExp(WIKI_LINK_RE.source, 'g')
    while ((wikiMatch = linkRe.exec(authoredBody)) !== null) {
      const targetSlug = wikiMatch[1]
      // Check if target file exists on disk (not in index — target may not be
      // indexed yet), in every indexed dir — the same set the rebuild's
      // knownSlugs covers, so a mention links the same way on either path.
      const targetExists = knownSlugs
        ? knownSlugs.has(targetSlug)
        : INDEXED_KINDS.some(k => existsSync(join(vaultPath, kindDir(k), `${targetSlug}.md`)))
      if (targetExists) {
        insertLinkStmt.run(slug, targetSlug, 'mention')
      }
    }
  })

  const rebuildTransaction = db.transaction(() => {
    // Watermark the scan by when it STARTED (see syncIfStale).
    const scanStart = Date.now() - WATERMARK_SLACK_MS
    db.exec('DELETE FROM items')
    db.exec('DELETE FROM links')

    // Collect all vault slugs for wiki link target validation
    const allVaultSlugs = new Set<string>()
    for (const kind of INDEXED_KINDS) {
      for (const file of scanVaultDir(join(vaultPath, kindDir(kind)))) {
        allVaultSlugs.add(basename(file, '.md'))
      }
    }

    for (const kind of INDEXED_KINDS) {
      for (const file of scanVaultDir(join(vaultPath, kindDir(kind)))) {
        indexFile(file, kind, allVaultSlugs)
      }
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)")
      .run(scanStart.toString())
  })

  function rebuild(): void {
    rebuildTransaction()
  }

  function syncIfStale(): void {
    const lastSync = db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").get() as { value: string } | undefined
    if (!lastSync) { rebuild(); return }

    const lastSyncTime = parseInt(lastSync.value, 10)
    let changed = false

    // Watermark the scan by when it STARTED, not when it finished. A file
    // written while the scan is in flight — after its read, before the record —
    // would otherwise be stamped as already-indexed and skipped by every later
    // sync, leaving it permanently stale. `>=` covers the same-millisecond
    // case; a re-read of an unchanged file is a cheap hash compare. The slack
    // absorbs FS-vs-Date.now clock rounding at the boundary — a file whose
    // mtime rounds just below the instant the scan started must still read as
    // dirty; the only cost is re-hashing files touched inside the window.
    const scanStart = Date.now() - WATERMARK_SLACK_MS

    const dirs = INDEXED_KINDS.map(kind => ({ dir: kindDir(kind), kind }))

    for (const { dir, kind } of dirs) {
      for (const file of scanVaultDir(join(vaultPath, dir))) {
        if (statSync(file).mtimeMs >= lastSyncTime) {
          indexFile(file, kind)
          changed = true
        }
      }
    }

    // Detect deleted files — remove orphaned DB entries
    const dbSlugs = (db.prepare('SELECT slug FROM items').all() as Array<{ slug: string }>).map(r => r.slug)
    const fileSlugs = new Set<string>()
    for (const { dir } of dirs) {
      for (const file of scanVaultDir(join(vaultPath, dir))) {
        fileSlugs.add(basename(file, '.md'))
      }
    }
    for (const slug of dbSlugs) {
      if (!fileSlugs.has(slug)) {
        removeItem(slug)
        changed = true
      }
    }

    afterScanHook?.()

    if (changed) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)")
        .run(scanStart.toString())
    }
  }

  // The forced re-index is one unit too: the replacement nests inside it.
  const upsertTransaction = db.transaction((slug: string, kind: VaultKind): void => {
    const filePath = join(vaultPath, kindDir(kind), `${slug}.md`)
    if (existsSync(filePath)) {
      // Force re-index by clearing cached hash
      deleteItemStmt.run(slug)
      deleteLinksStmt.run(slug)
      indexFile(filePath, kind)
    }
  })

  function upsertFromFile(slug: string, kind: VaultKind): void {
    upsertTransaction.immediate(slug, kind)
  }

  function removeItem(slug: string): void {
    deleteItemStmt.run(slug)
    deleteLinksStmt.run(slug)
  }

  // Auto-rebuild on first creation if empty
  const count = (db.prepare('SELECT COUNT(*) as c FROM items').get() as any).c
  if (count === 0) rebuild()

  return withReadSurface({
    rebuild, syncIfStale, upsertFromFile, removeItem,
    queryItems: (qopts) => queryItemsFn(db, qopts),
    search: (q, k) => searchFn(db, q, k),
    getStats: () => getStatsFn(db),
    indexEntries: () => indexEntriesFn(db),
    graphRows: () => graphRowsFn(db),
    close: () => db.close(),
  }, sync)
}

// --- The read surface: opts mapping + row shaping over queryItemsFn ---

/** The read-surface methods exist in exactly one place: attached here over
 * any core index (write-capable or read-only). Each first runs `syncForRead`,
 * the `sync` mode's rule. */
type IndexCore = Omit<HafezIndex, 'syncForRead' | 'queryEntities' | 'queryChildren' | 'queryRelatedTo' | 'queryKnowledge' | 'querySessions' | 'queryUnified' | 'queryGraph'>

function withReadSurface(core: IndexCore, sync: IndexSync): HafezIndex {
  // Any sync catches the index up, a caller's own included; from then on the
  // index stays current with this process's writes (the Spine indexes them).
  let caughtUp = false
  const syncIfStale = (): void => { core.syncIfStale(); caughtUp = true }
  const syncForRead = (): void => {
    if (sync === 'read' || (sync === 'once' && !caughtUp)) syncIfStale()
  }
  const synced = <A extends unknown[], R>(fn: (...args: A) => R) => (...args: A): R => {
    syncForRead()
    return fn(...args)
  }
  const index: HafezIndex = {
    ...core,
    syncIfStale,
    syncForRead,
    queryEntities: synced((opts) => queryEntitiesFn(index, opts)),
    queryChildren: synced((parentSlug) => queryEntitiesFn(index, { parent: parentSlug })),
    queryRelatedTo: synced((slug, relation) => queryRelatedToFn(index, slug, relation)),
    queryKnowledge: synced((opts) => queryKnowledgeFn(index, opts)),
    querySessions: synced((opts) => querySessionsFn(index, opts)),
    queryUnified: synced((opts) => queryUnifiedFn(index, opts)),
    queryGraph: synced((opts) => queryGraphFn(index, opts)),
  }
  return index
}

function toQueryResult(slug: string, row: Record<string, any>): QueryResult {
  return {
    slug,
    name: row.name,
    type: row.type,
    status: row.status,
    description: row.description ?? null,
    resource: row.resource ? JSON.parse(row.resource) : [],
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

function toSessionResult(slug: string, row: Record<string, any>): SessionQueryResult {
  return {
    slug,
    name: row.name,
    session_date: row.session_date,
    created: row.created,
    related: row.related ?? [],
  }
}

/** One row of any kind, shaped for its kind. */
function toUnifiedResult(i: IndexItem): UnifiedResult {
  if (i.kind === 'entity') return { ...toQueryResult(i.slug, i), kind: 'entity' }
  if (i.kind === 'session') return { ...toSessionResult(i.slug, i), kind: 'session' }
  return { ...toKnowledgeResult(i.slug, i), kind: 'knowledge' }
}

const STATUS_FILTERS = new Set<string>(ENTITY_STATUSES)

// One mapper per opts family: the entity filter set (entities + unified), the
// knowledge filter set (knowledge + unified), the time window (every kind
// carries created/last_touched), and the tags/sort/paging tail every list
// query shares. Each opt maps in exactly one place, so the filtered and
// unified views can't silently diverge. Domain appears in both filter mappers
// (both kinds carry it) — mapping it twice is idempotent.
// Keyed off the knowledge opts, which carry the full sort field set — the
// entity opts declare only the subset that branch can honour.
type ListOpts = Pick<KnowledgeQueryOpts, 'tags' | 'sort_order' | 'limit' | 'offset'> & { sort_by?: SortField }

function mapEntityFilterOpts(qopts: QueryOpts, opts?: Pick<EntityQueryOpts, 'filter' | 'type' | 'parent' | 'domain'>): void {
  if (opts?.filter && STATUS_FILTERS.has(opts.filter)) qopts.status = opts.filter
  if (opts?.filter === 'stale') qopts.filter = 'stale'
  if (opts?.filter === 'capture') qopts.filter = 'capture'
  if (opts?.type) qopts.type = opts.type
  if (opts?.parent) qopts.parent = opts.parent
  if (opts?.domain) qopts.domain = opts.domain
}

function mapTimeOpts(qopts: QueryOpts, opts?: TimeOpts): void {
  if (opts?.since) qopts.since = opts.since
  if (opts?.before) qopts.before = opts.before
  if (opts?.createdSince) qopts.createdSince = opts.createdSince
  if (opts?.createdBefore) qopts.createdBefore = opts.createdBefore
}

function mapListOpts(qopts: QueryOpts, opts?: ListOpts): void {
  if (opts?.tags) qopts.tags = opts.tags
  if (opts?.sort_by) qopts.sort_by = opts.sort_by
  if (opts?.sort_order) qopts.sort_order = opts.sort_order
  if (opts?.limit != null) qopts.limit = opts.limit
  if (opts?.offset != null) qopts.offset = opts.offset
}

function mapKnowledgeFilterOpts(qopts: QueryOpts, opts?: { domain?: string; confidence?: string; subtype?: string }): void {
  if (opts?.domain) qopts.domain = opts.domain
  if (opts?.confidence) qopts.confidence = opts.confidence
  if (opts?.subtype) qopts.subtype = opts.subtype
}

function validateEntityFilterOpts(opts?: Pick<EntityQueryOpts, 'filter' | 'type'>): void {
  assertEnum(opts?.filter, QUERY_FILTERS, 'filter')
  assertEnum(opts?.type, ENTITY_TYPES, 'type')
}

/** Opts a branch cannot map into SQL. Declared per branch and rejected on
 * sight: the CLI has rejected these since 43124ba, but the rule lived only
 * there, so a library caller got the silent drop the CLI had already closed.
 * Asserted against the CLI's flag matrix in query-surface.test.ts. */
export const ENTITY_ONLY_OPTS = ['filter', 'type', 'parent'] as const
export const KNOWLEDGE_ONLY_OPTS = ['confidence', 'subtype'] as const
/** What a session query cannot map: both sides' opts, and the two every
 * other kind shares — a session note carries no domain and no tags. */
export const SESSION_REJECTED_OPTS = [...ENTITY_ONLY_OPTS, ...KNOWLEDGE_ONLY_OPTS, 'domain', 'tags'] as const

/** The one sentence both scope rejections speak — opts here, sort fields in
 * queryItemsFn — so a caller sees the same shape whichever one they hit. */
function outOfScope(label: string, name: string, branch: VaultKind): never {
  const belongsTo = branch === 'entity' ? 'knowledge notes only'
    : branch === 'knowledge' ? 'entities only'
    : 'entities and knowledge notes only'
  throw new HafezError(
    'VALIDATION_FAILED',
    `Invalid ${label} for a ${branch} query: "${name}" — ${belongsTo}. Use kind: 'all' to query every kind.`,
  )
}

/** Every opt any branch might carry, flattened. Only the unified read uses it,
 * and only to check: the checks must see an opt the caller's own type forbids,
 * because an untyped caller can still send it. */
export type UnmappableCheckOpts =
  Omit<EntityQueryOpts, 'sort_by'>
  & Omit<KnowledgeQueryOpts, 'sort_by'>
  & { kind?: VaultKind | 'all'; sort_by?: SortField }

function rejectUnmappableOpts(
  opts: Partial<Record<string, unknown>> | undefined,
  reject: readonly string[],
  branch: VaultKind,
): void {
  if (!opts) return
  // Only a *defined* value is a request — an explicit `undefined` (what a
  // spread of unset CLI flags produces) asks for nothing.
  for (const name of reject) if (opts[name] !== undefined) outOfScope('opt', name, branch)
}

function validateKnowledgeFilterOpts(opts?: { confidence?: string; subtype?: string }): void {
  assertEnum(opts?.confidence, CONFIDENCE_LEVELS, 'confidence')
  assertEnum(opts?.subtype, VALID_SUBTYPES, 'subtype')
}

function queryEntitiesFn(index: HafezIndex, opts?: EntityQueryOpts): { items: QueryResult[], total: number } {
  validateEntityFilterOpts(opts)
  // Was validateKnowledgeFilterOpts — it checked the *value* of an opt this
  // branch then discarded, so a valid-looking one returned unfiltered.
  rejectUnmappableOpts(opts as Record<string, unknown> | undefined, KNOWLEDGE_ONLY_OPTS, 'entity')
  validateTimeOpts(opts)
  validateListOpts(opts)
  const qopts: QueryOpts = { kind: 'entity' }
  mapEntityFilterOpts(qopts, opts)
  mapTimeOpts(qopts, opts)
  mapListOpts(qopts, opts)
  const { items, total } = index.queryItems(qopts)
  return { items: items.map(i => toQueryResult(i.slug, i)), total }
}

/** Every kind: the sessions that touched an entity are the look back from it. */
function queryRelatedToFn(index: HafezIndex, slug: string, relation?: string): { items: UnifiedResult[], total: number } {
  const { items, total } = index.queryItems({ kind: 'all', relatedTo: slug, relation })
  return { items: items.map(toUnifiedResult), total }
}

function queryKnowledgeFn(index: HafezIndex, opts?: KnowledgeQueryOpts): { items: KnowledgeQueryResult[], total: number } {
  validateKnowledgeFilterOpts(opts)
  rejectUnmappableOpts(opts as Record<string, unknown> | undefined, ENTITY_ONLY_OPTS, 'knowledge')
  validateTimeOpts(opts)
  validateListOpts(opts)
  const qopts: QueryOpts = { kind: 'knowledge' }
  mapKnowledgeFilterOpts(qopts, opts)
  mapTimeOpts(qopts, opts)
  mapListOpts(qopts, opts)
  const { items, total } = index.queryItems(qopts)
  return { items: items.map(i => toKnowledgeResult(i.slug, i)), total }
}

function querySessionsFn(index: HafezIndex, opts?: SessionQueryOpts): { items: SessionQueryResult[], total: number } {
  rejectUnmappableOpts(opts as Record<string, unknown> | undefined, SESSION_REJECTED_OPTS, 'session')
  validateTimeOpts(opts)
  validateListOpts(opts)
  const qopts: QueryOpts = { kind: 'session' }
  mapTimeOpts(qopts, opts)
  mapListOpts(qopts, opts)
  const { items, total } = index.queryItems(qopts)
  return { items: items.map(i => toSessionResult(i.slug, i)), total }
}

function queryUnifiedFn(
  index: HafezIndex,
  opts?: UnifiedQueryOpts,
): { items: UnifiedResult[], total: number } {
  // The public type is a union discriminated on `kind`, so an out-of-scope opt
  // is a compile error. The runtime still has to see every opt to reject it —
  // an untyped caller (JS, JSON over MCP) reaches here regardless — so widen
  // once, here, and let the checks below speak for both.
  const o = opts as UnmappableCheckOpts | undefined
  assertEnum(o?.kind, ['entity', 'knowledge', 'session', 'all'], 'kind')
  validateEntityFilterOpts(o)
  validateKnowledgeFilterOpts(o)
  // Only `kind: 'all'` (or unset) maps both sides. `kind` also narrows this
  // query to one of them, and a narrowed branch maps no more than the
  // dedicated one does: the out-of-scope conditions land on columns the
  // selected kind leaves NULL, so every row is excluded and the caller gets
  // 0 results with exit 0 — the same wrong answer, one function over.
  if (o?.kind === 'entity') rejectUnmappableOpts(o, KNOWLEDGE_ONLY_OPTS, 'entity')
  if (o?.kind === 'knowledge') rejectUnmappableOpts(o, ENTITY_ONLY_OPTS, 'knowledge')
  if (o?.kind === 'session') rejectUnmappableOpts(o, SESSION_REJECTED_OPTS, 'session')
  validateTimeOpts(o)
  validateListOpts(o)
  // Unset is the working set (entity + knowledge); 'all' reaches every kind.
  const qopts: QueryOpts = { kind: o?.kind }
  mapEntityFilterOpts(qopts, o)
  mapKnowledgeFilterOpts(qopts, o)
  mapTimeOpts(qopts, o)
  mapListOpts(qopts, o)

  const result = index.queryItems(qopts)
  return { items: result.items.map(toUnifiedResult), total: result.total }
}

/** The Graph's node kinds by default: the working set, entities and knowledge. */
const GRAPH_KINDS = new Set<string>(MUTABLE_KINDS)
const GRAPH_RELATIONS = new Set<string>(GRAPH_NOTE_RELATIONS)

/** The opts graph() applies; any other is rejected, never dropped. */
const GRAPH_OPTS: readonly string[] = ['layers']
/** The layers whose nodes are synthetic: one per distinct value, `<layer>:<value>`. */
const SYNTHETIC = new Set<string>(SYNTHETIC_LAYERS)

function queryGraphFn(index: HafezIndex, opts?: GraphOpts): Graph {
  for (const [name, value] of Object.entries(opts ?? {})) {
    if (value !== undefined && !GRAPH_OPTS.includes(name)) {
      throw new HafezError('VALIDATION_FAILED', `Invalid opt for a graph query: "${name}"`)
    }
  }
  const given: unknown = opts?.layers ?? []
  if (!Array.isArray(given) || given.some(l => !(GRAPH_LAYERS as readonly unknown[]).includes(l))) {
    throw new HafezError('VALIDATION_FAILED', `Invalid graph layers: ${JSON.stringify(given)}. Valid values: ${GRAPH_LAYERS.join(', ')}.`)
  }
  const layers = new Set<string>(given)
  const { items, links } = index.graphRows()
  const nodes: GraphNode[] = []
  for (const i of items) {
    if (!GRAPH_KINDS.has(i.kind) && !(i.kind === 'session' && layers.has('session'))) continue
    const node: GraphNode = { id: i.slug, kind: i.kind as GraphNode['kind'], name: i.name }
    // The index's columns are plain strings; what it stores there for a
    // note is the frontmatter's validated enum value.
    for (const key of GRAPH_ROW_FIELDS) if (i[key] != null) Object.assign(node, { [key]: i[key] })
    if (i.kind === 'entity') Object.assign(node, entitySignals(i))
    nodes.push(node)
  }
  markUnlinked(nodes, links)
  // An edge needs both ends on the graph: a missing note, or a session, tag or
  // domain outside its layer, is no node. Related is one edge per unordered
  // pair (ADR 0002); a legacy one-way edge is emitted once, as written.
  const ids = new Set(nodes.map(n => n.id))
  // A Session's only edges are the `related` it names: the Entities it touched.
  const sessions = new Set(nodes.filter(n => n.kind === 'session').map(n => n.id))
  const pairs = new Set<string>()
  const edges: GraphEdge[] = []
  // A tag or domain node exists for each value a node carries; its id cannot
  // collide with a slug, which never holds `:`.
  const layerNodes = new Map<string, GraphNode>()
  for (const l of links) {
    if (layers.has(l.relation) && SYNTHETIC.has(l.relation)) {
      if (!ids.has(l.source) || sessions.has(l.source)) continue
      const id = `${l.relation}:${l.target}`
      if (!layerNodes.has(id)) layerNodes.set(id, { id, kind: l.relation as GraphNode['kind'], name: l.target })
      edges.push({ source: l.source, target: id, relation: l.relation as GraphEdge['relation'] })
      continue
    }
    if (!GRAPH_RELATIONS.has(l.relation) || !ids.has(l.source) || !ids.has(l.target)) continue
    if (sessions.has(l.target) || (sessions.has(l.source) && l.relation !== 'related')) continue
    if (l.relation === 'related') {
      const pair = [l.source, l.target].sort().join('\n')
      if (pairs.has(pair)) continue
      pairs.add(pair)
    }
    edges.push({ source: l.source, target: l.target, relation: l.relation as GraphEdge['relation'] })
  }
  nodes.push(...[...layerNodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
  return { nodes, edges }
}

/** What an Entity node carries of its state (#271): every Entity its effective
 * staleness-days; an active or paused one its open actions and stale-action
 * count too (#277: the sidebar's Paused rows count them), and an active one
 * its Stale flag. A done Entity carries no action signal. */
function entitySignals(i: GraphRows['items'][number]): Pick<GraphNode, 'open_actions' | 'stale' | 'stale_actions' | 'staleness_days'> {
  const staleness_days = i.staleness_days ?? DEFAULT_STALENESS_DAYS
  if (i.status !== 'active' && i.status !== 'paused') return { staleness_days }
  const today = localDay()
  const added = JSON.parse(i.action_added ?? '[]') as Array<string | null>
  return {
    open_actions: i.next_action_count,
    ...(i.status === 'active' && { stale: i.stale === 1 }),
    stale_actions: added.filter(day => actionAge(day, staleness_days, today).stale).length,
    staleness_days,
  }
}

/** Mark each Unlinked note (CONTEXT: no Parent, Related or Wiki-link edge to
 * another Entity or Knowledge note, either way; tags and Sessions do not
 * count) and give it `best`, the slug its placing line names: the closest
 * linked note (src/closest.ts, which weighs each linked note's name and
 * description) to the Unlinked note's name, else to its description; the
 * same kind when one matches, else any kind; none when nothing matches. */
function markUnlinked(nodes: GraphNode[], links: GraphRows['links']): void {
  const notes = new Map(nodes.filter(n => n.kind === 'entity' || n.kind === 'knowledge').map(n => [n.id, n]))
  const linked = new Set<string>()
  for (const l of links) {
    if (!GRAPH_RELATIONS.has(l.relation) || l.source === l.target || !notes.has(l.source) || !notes.has(l.target)) continue
    linked.add(l.source)
    linked.add(l.target)
  }
  const candidates = [...notes.values()].filter(n => linked.has(n.id))
    .map(n => ({ kind: n.kind, slug: n.id, name: n.name, description: n.description ?? null }))
  const closest = (n: GraphNode, among: SlugCandidate[]) =>
    closestSlugs(n.name, among)[0] ?? (n.description ? closestSlugs(n.description, among)[0] : undefined)
  for (const n of notes.values()) {
    if (linked.has(n.id)) continue
    n.unlinked = true
    const best = closest(n, candidates.filter(c => c.kind === n.kind)) ?? closest(n, candidates)
    if (best !== undefined) n.best = best
  }
}

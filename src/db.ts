import Database from 'better-sqlite3'
import { createHash } from 'crypto'
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from 'fs'
import { join, basename } from 'path'
import { parseFilePath } from './vault.js'
import { ensureLocalExclude } from './knowledge-index.js'
import { getNextActions, getBrief, WIKI_LINK_RE, findSection } from './sections.js'
import { parseSessionLog } from './parser.js'
import type { SearchResult, VaultStats, EntityStatus, EntityType } from './types.js'

// Bump this when indexing logic changes to force a full rebuild.
// v5: wiki link harvesting (mention relations), parent link indexing, relation filter on queries.
// v6: description column on items.
// v7: resource column on items (entities only).
// Existing instances will fully rebuild the index on first access after upgrade.
export const SCHEMA_VERSION = '7'

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
  last_session_summary TEXT
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

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
  'may', 'might', 'can', 'shall', 'not', 'no', 'nor', 'so', 'if', 'then', 'than',
  'that', 'this', 'these', 'those', 'it', 'its', 'my', 'your', 'his', 'her',
  'our', 'their', 'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'all', 'each', 'every', 'both', 'few', 'more', 'most', 'some', 'any', 'such',
  'about', 'into', 'over', 'after', 'before',
  'work', 'works', 'working', 'use', 'using', 'used', 'get', 'got', 'make', 'made',
  'need', 'want', 'like', 'just', 'also', 'still', 'already', 'very', 'much',
])

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

function scanDir(dirPath: string): string[] {
  try {
    return readdirSync(dirPath).filter(f => f.endsWith('.md')).map(f => join(dirPath, f))
  } catch { return [] }
}

interface IndexItem {
  slug: string
  kind: 'entity' | 'knowledge'
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
  resource: string | null
  brief: string | null
  session_log_count: number
  last_session_date: string | null
  last_session_type: string | null
  last_session_summary: string | null
}

export interface IndexQueryResult {
  items: IndexItem[]
  total: number
}

export interface HafezIndex {
  rebuild(): void
  syncIfStale(): void
  upsertFromFile(slug: string, kind: 'entity' | 'knowledge'): void
  removeItem(slug: string): void
  queryItems(opts: QueryOpts): IndexQueryResult
  search(query: string, kind?: 'entity' | 'knowledge' | 'all'): SearchResult[]
  getStats(): VaultStats
  close(): void
}

export interface QueryOpts {
  kind?: 'entity' | 'knowledge' | 'all'
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
  sort_by?: 'last_touched' | 'created' | 'name' | 'staleness' | 'last_reinforced' | 'reinforcement_count'
  sort_order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

// --- Shared query functions (used by both write and readonly paths) ---

function sanitizeFtsQuery(raw: string): { fts: string; terms: string[] } {
  const cleaned = raw.replace(/[^\w\s]/g, ' ')
  const tokens = cleaned.split(/\s+/).filter(t => t.length > 0)
  const filtered = tokens.filter(t => !STOPWORDS.has(t.toLowerCase()))
  const terms = filtered.length === 0 ? tokens : filtered
  return { fts: terms.map(t => `${t}*`).join(' OR '), terms }
}

function queryItemsFn(db: InstanceType<typeof Database>, opts: QueryOpts): IndexQueryResult {
  const conditions: string[] = []
  const params: Record<string, any> = {}

  if (opts.kind && opts.kind !== 'all') {
    conditions.push('i.kind = @kind')
    params.kind = opts.kind
  }
  if (opts.status) {
    conditions.push('i.status = @status')
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
    conditions.push(`(
      julianday('now') - julianday(i.last_touched) >
      CASE
        WHEN i.staleness_days IS NOT NULL THEN i.staleness_days
        ELSE 14
      END
    )`)
  }
  if (opts.filter === 'capture') {
    conditions.push("i.type = 'capture'")
  }

  if (opts.since) {
    conditions.push('i.last_touched >= @since')
    params.since = opts.since
  }
  if (opts.before) {
    conditions.push('i.last_touched <= @before')
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

  const knowledgeOnlySorts = new Set(['reinforcement_count', 'last_reinforced'])
  const sortColMap: Record<string, string> = {
    name: 'i.name',
    created: 'i.created',
    last_touched: 'i.last_touched',
    staleness: 'i.staleness_days',
    reinforcement_count: 'i.reinforcement_count',
    last_reinforced: 'i.last_reinforced',
  }

  let sortCol = 'i.last_touched'
  if (opts.sort_by) {
    const isKnowledgeOnly = knowledgeOnlySorts.has(opts.sort_by)
    const isEntityQuery = opts.kind === 'entity'
    if (isKnowledgeOnly && isEntityQuery) {
      sortCol = 'i.last_touched'
    } else if (sortColMap[opts.sort_by]) {
      sortCol = sortColMap[opts.sort_by]
    }
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
                      i.last_session_type, i.last_session_summary
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

function searchFn(db: InstanceType<typeof Database>, query: string, kind?: 'entity' | 'knowledge' | 'all'): SearchResult[] {
  const { fts: ftsQuery, terms } = sanitizeFtsQuery(query)
  if (!ftsQuery) return []

  let kindFilter = ''
  const params: Record<string, any> = { query: ftsQuery }
  if (kind && kind !== 'all') {
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
    SELECT slug, name, type, CAST(julianday('now') - julianday(last_touched) AS INTEGER) as days_since_touched
    FROM items
    WHERE kind = 'entity' AND status = 'active'
      AND julianday('now') - julianday(last_touched) >
        CASE
          WHEN staleness_days IS NOT NULL THEN staleness_days
          ELSE 14
        END
    ORDER BY days_since_touched DESC
  `).all() as Array<{ slug: string; name: string; type: EntityType; days_since_touched: number }>

  const no_next_action = db.prepare(`
    SELECT slug, name, type FROM items
    WHERE kind = 'entity' AND status = 'active' AND next_action_count = 0
    ORDER BY last_touched DESC
  `).all() as Array<{ slug: string; name: string; type: EntityType }>

  const recently_touched = db.prepare(`
    SELECT slug, name, last_touched FROM items
    WHERE kind = 'entity'
    ORDER BY last_touched DESC LIMIT 5
  `).all() as Array<{ slug: string; name: string; last_touched: string }>

  const recently_created = db.prepare(`
    SELECT slug, name, created FROM items
    WHERE kind = 'entity'
    ORDER BY created DESC LIMIT 5
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

// --- createIndex: overloaded for write and readonly modes ---

export function createIndex(vaultPath: string): HafezIndex
export function createIndex(vaultPath: string, opts: { readonly: true }): HafezIndex | null
export function createIndex(vaultPath: string, opts?: { readonly?: boolean }): HafezIndex | null {
  const dbPath = join(vaultPath, '.hafez.db')
  const isReadOnly = opts?.readonly ?? false

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

    return {
      rebuild: () => { throw new Error('Index is read-only') },
      syncIfStale,
      upsertFromFile: () => { throw new Error('Index is read-only') },
      removeItem: () => { throw new Error('Index is read-only') },
      queryItems: (qopts) => queryItemsFn(db, qopts),
      search: (q, k) => searchFn(db, q, k),
      getStats: () => getStatsFn(db),
      close: () => { try { db.close() } catch {} },
    }
  }

  // --- Write-capable path ---
  // The db files are a disposable local cache — keep them out of the user's
  // `git status` without dirtying their vault with a tracked .gitignore.
  ensureLocalExclude(vaultPath)
  let db: InstanceType<typeof Database>
  try {
    db = new Database(dbPath)
  } catch {
    // Corrupted DB — delete and recreate
    try { unlinkSync(dbPath) } catch {}
    db = new Database(dbPath)
  }
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)

  // Schema migration: if next_action_count column missing, delete DB and recreate
  try {
    db.prepare('SELECT next_action_count FROM items LIMIT 0').run()
  } catch {
    db.close()
    unlinkSync(dbPath)
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
  }

  // Schema migration: if domain_entity column exists, delete DB and recreate
  try {
    db.prepare('SELECT domain_entity FROM items LIMIT 0').run()
    // Column exists — old schema, needs rebuild
    db.close()
    unlinkSync(dbPath)
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
  } catch {
    // Column doesn't exist — correct schema, continue
  }

  // Schema version check — forces full rebuild when indexing logic changes
  const versionRow = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined
  if (!versionRow || versionRow.value !== SCHEMA_VERSION) {
    db.close()
    unlinkSync(dbPath)
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 5000')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION)
  }

  // Prepared statements
  const upsertStmt = db.prepare(`
    INSERT OR REPLACE INTO items
      (slug, kind, name, type, status, parent, next_action, next_action_count, staleness_days,
       confidence, reinforcement_count, last_reinforced, created, last_touched, body, file_hash, subtype,
       description, resource, brief, session_log_count, last_session_date, last_session_type, last_session_summary)
    VALUES
      (@slug, @kind, @name, @type, @status, @parent, @next_action, @next_action_count, @staleness_days,
       @confidence, @reinforcement_count, @last_reinforced, @created, @last_touched, @body, @file_hash, @subtype,
       @description, @resource, @brief, @session_log_count, @last_session_date, @last_session_type, @last_session_summary)
  `)
  const deleteItemStmt = db.prepare('DELETE FROM items WHERE slug = ?')
  const deleteLinksStmt = db.prepare('DELETE FROM links WHERE source = ?')
  const insertLinkStmt = db.prepare('INSERT OR IGNORE INTO links (source, target, relation) VALUES (?, ?, ?)')
  const getHashStmt = db.prepare('SELECT file_hash FROM items WHERE slug = ?')

  function indexFile(filePath: string, kind: 'entity' | 'knowledge', knownSlugs?: Set<string>): void {
    const content = readFileSync(filePath, 'utf-8')
    const slug = basename(filePath, '.md')
    const hash = hashContent(content)

    // Skip if unchanged
    const existing = getHashStmt.get(slug) as { file_hash: string } | undefined
    if (existing && existing.file_hash === hash) return

    let fm: Record<string, any>, body: string
    try {
      const parsed = parseFilePath(filePath)
      fm = parsed.frontmatter
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

    // Parse next actions from body (new), fall back to frontmatter (legacy pre-migration)
    const bodyActions = getNextActions(body)
    const nextAction = bodyActions.length > 0 ? bodyActions[0] : (fm['next-action'] ?? null)
    const nextActionCount = bodyActions.length

    const brief = getBrief(body)?.slice(0, 300) ?? null
    const logs = parseSessionLog(body)
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
      body,
      file_hash: hash,
      subtype: kind === 'knowledge' ? (fm.subtype ?? 'insight') : null,
      description: fm.description ?? null,
      resource: kind === 'entity' ? (fm.resource ?? null) : null,
      brief,
      session_log_count: logs.length,
      last_session_date: lastLog?.date ?? null,
      last_session_type: lastLog?.type ?? null,
      last_session_summary: lastLog?.summary?.slice(0, 300) ?? null,
    }

    // Upsert item and rebuild links
    deleteLinksStmt.run(slug)
    upsertStmt.run(item)

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
    const relatedSection = findSection(body, 'Related')
    if (relatedSection) {
      authoredBody = body.slice(0, relatedSection.start) + body.slice(relatedSection.end)
    }
    let wikiMatch: RegExpExecArray | null
    const linkRe = new RegExp(WIKI_LINK_RE.source, 'g')
    while ((wikiMatch = linkRe.exec(authoredBody)) !== null) {
      const targetSlug = wikiMatch[1]
      // Check if target file exists on disk (not in index — target may not be indexed yet)
      const targetEntityPath = join(vaultPath, 'entities', `${targetSlug}.md`)
      const targetKnowledgePath = join(vaultPath, 'knowledge', `${targetSlug}.md`)
      const targetExists = knownSlugs
        ? knownSlugs.has(targetSlug)
        : existsSync(targetEntityPath) || existsSync(targetKnowledgePath)
      if (targetExists) {
        insertLinkStmt.run(slug, targetSlug, 'mention')
      }
    }
  }

  const rebuildTransaction = db.transaction(() => {
    db.exec('DELETE FROM items')
    db.exec('DELETE FROM links')

    // Collect all vault slugs for wiki link target validation
    const allVaultSlugs = new Set<string>()
    for (const file of scanDir(join(vaultPath, 'entities'))) {
      allVaultSlugs.add(basename(file, '.md'))
    }
    for (const file of scanDir(join(vaultPath, 'knowledge'))) {
      allVaultSlugs.add(basename(file, '.md'))
    }

    for (const file of scanDir(join(vaultPath, 'entities'))) {
      indexFile(file, 'entity', allVaultSlugs)
    }
    for (const file of scanDir(join(vaultPath, 'knowledge'))) {
      indexFile(file, 'knowledge', allVaultSlugs)
    }

    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)")
      .run(Date.now().toString())
  })

  function rebuild(): void {
    rebuildTransaction()
  }

  function syncIfStale(): void {
    const lastSync = db.prepare("SELECT value FROM meta WHERE key = 'last_sync'").get() as { value: string } | undefined
    if (!lastSync) { rebuild(); return }

    const lastSyncTime = parseInt(lastSync.value, 10)
    let changed = false

    const dirs: Array<{ dir: string; kind: 'entity' | 'knowledge' }> = [
      { dir: 'entities', kind: 'entity' },
      { dir: 'knowledge', kind: 'knowledge' },
    ]

    for (const { dir, kind } of dirs) {
      for (const file of scanDir(join(vaultPath, dir))) {
        if (statSync(file).mtimeMs > lastSyncTime) {
          indexFile(file, kind)
          changed = true
        }
      }
    }

    // Detect deleted files — remove orphaned DB entries
    const dbSlugs = (db.prepare('SELECT slug FROM items').all() as Array<{ slug: string }>).map(r => r.slug)
    const fileSlugs = new Set<string>()
    for (const { dir } of dirs) {
      for (const file of scanDir(join(vaultPath, dir))) {
        fileSlugs.add(basename(file, '.md'))
      }
    }
    for (const slug of dbSlugs) {
      if (!fileSlugs.has(slug)) {
        removeItem(slug)
        changed = true
      }
    }

    if (changed) {
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_sync', ?)")
        .run(Date.now().toString())
    }
  }

  function upsertFromFile(slug: string, kind: 'entity' | 'knowledge'): void {
    const dir = kind === 'entity' ? 'entities' : 'knowledge'
    const filePath = join(vaultPath, dir, `${slug}.md`)
    if (existsSync(filePath)) {
      // Force re-index by clearing cached hash
      deleteItemStmt.run(slug)
      deleteLinksStmt.run(slug)
      indexFile(filePath, kind)
    }
  }

  function removeItem(slug: string): void {
    deleteItemStmt.run(slug)
    deleteLinksStmt.run(slug)
  }

  // Auto-rebuild on first creation if empty
  const count = (db.prepare('SELECT COUNT(*) as c FROM items').get() as any).c
  if (count === 0) rebuild()

  return {
    rebuild, syncIfStale, upsertFromFile, removeItem,
    queryItems: (qopts) => queryItemsFn(db, qopts),
    search: (q, k) => searchFn(db, q, k),
    getStats: () => getStatsFn(db),
    close: () => db.close(),
  }
}

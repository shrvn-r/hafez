// src/types.ts

// --- Enums ---

export type EntityType = 'capture' | 'entity' | 'project'
export type EntityStatus = 'active' | 'paused' | 'done'
export type ConfidenceLevel = 'observation' | 'pattern' | 'principle'
export type SessionLogType = 'progress' | 'decision' | 'blocker' | 'research'
export type ReadDepth = 'frontmatter' | 'summary' | 'full'
export type QueryFilter = 'active' | 'paused' | 'done' | 'all' | 'stale' | 'capture'
export type LinkRelation = 'parent' | 'related'
export type KnowledgeSubtype = 'insight' | 'plan'

// --- Query Options ---

export interface EntityQueryOpts {
  filter?: QueryFilter
  type?: EntityType
  parent?: string
  domain?: string
  confidence?: ConfidenceLevel
  since?: string          // ISO date — last_touched >= since
  before?: string         // ISO date — last_touched <= before
  createdSince?: string   // ISO date — created >= createdSince
  createdBefore?: string  // ISO date — created <= createdBefore
  tags?: string[]
  sort_by?: 'last_touched' | 'created' | 'name' | 'staleness' | 'last_reinforced' | 'reinforcement_count'
  sort_order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface KnowledgeQueryOpts {
  domain?: string
  confidence?: ConfidenceLevel
  subtype?: KnowledgeSubtype
  tags?: string[]
  sort_by?: 'last_touched' | 'created' | 'name' | 'staleness' | 'last_reinforced' | 'reinforcement_count'
  sort_order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

// --- Frontmatter ---

export interface EntityFrontmatter {
  name: string
  type: EntityType
  status: EntityStatus
  description?: string
  resource?: string
  domain?: string[]
  parent?: string
  related?: string[]
  created: string      // YYYY-MM-DD
  'last-touched': string // YYYY-MM-DD
  'staleness-days'?: number
  tags?: string[]
}

export interface KnowledgeFrontmatter {
  name: string
  subtype?: KnowledgeSubtype
  description?: string
  domain?: string[]
  confidence?: ConfidenceLevel
  related?: string[]
  created: string
  'last-reinforced'?: string
  'reinforcement-count'?: number
  tags?: string[]
  'session-date'?: string
  status?: 'active' | 'done'     // plan subtype only
  'last-touched'?: string         // plan subtype only
}

// --- Parsed file ---

export interface ParsedFile<T = EntityFrontmatter | KnowledgeFrontmatter> {
  frontmatter: T
  body: string
}

// --- Session log ---

export interface SessionLogEntry {
  type: SessionLogType
  summary: string
  body?: string
  agent: string
}

export interface ParsedSessionLogEntry {
  date: string
  agent: string
  type: SessionLogType
  summary: string
  body: string
}

// --- Operation inputs ---

export interface UpdateFields {
  status?: EntityStatus
  next_action?: string | null        // DEPRECATED — kept for migration, will be removed
  current_state?: string
  session_log?: SessionLogEntry
  brief?: string | null              // string = set/replace, null = remove section
  add_action?: string                // add one item to Next Actions
  add_actions?: string[]             // add multiple items to Next Actions
  complete_action?: string           // complete matching item (substring, case-insensitive)
  remove_action?: string             // remove matching item without completing
  clear_actions?: boolean            // remove entire Next Actions section
  // Domain (shared) + knowledge-only metadata
  description?: string | null      // '' or null clears
  resource?: string | null         // entity-only canonical URI, '' or null clears
  domain?: string[]
  confidence?: ConfidenceLevel
  tags?: string[]
  related?: string[]
  synthesis?: string        // replaces insight — rewrites ## Synthesis section
  add_evidence?: string     // appends to ## Evidence section
  add_source?: string       // appends to ## Sources section
}

export interface UpdateResult {
  previous_next_action?: string | null   // only set during legacy next_action updates
  matched_action?: string                // the full text of action that was completed/removed
}

export interface CreateEntityFields {
  type: EntityType
  purpose?: string
  description?: string
  resource?: string
  domain?: string[]
  parent?: string
  related?: string[]
  tags?: string[]
  brief?: string
  add_action?: string
}

export interface CreateKnowledgeFields {
  subtype?: KnowledgeSubtype
  synthesis?: string        // replaces insight
  description?: string
  domain?: string[]
  related?: string[]
  tags?: string[]
  'session-date'?: string  // ISO date for session notes
}

// --- Operation results ---

export interface QueryResult {
  slug: string
  name: string
  type: EntityType
  status: EntityStatus
  description: string | null
  resource: string | null
  domain: string[]
  last_touched: string
  next_action: string | null
  next_action_count: number        // total unchecked items
  parent: string | null
  related: string[]
  staleness_days: number | null
  tags: string[]
  brief: string | null
  session_log_count: number
  last_session_date: string | null
  last_session_type: string | null
  last_session_summary: string | null
}

export interface KnowledgeQueryResult {
  slug: string
  name: string
  description: string | null
  domain: string[]
  confidence: ConfidenceLevel
  related: string[]
  reinforcement_count: number
  last_reinforced: string | null
  last_touched: string | null
}

export type UnifiedResult =
  | (QueryResult & { kind: 'entity' })
  | (KnowledgeQueryResult & { kind: 'knowledge' })

export interface ValidationIssue {
  slug: string
  field: string
  issue: string
}

export interface ValidationReport {
  broken_slugs: ValidationIssue[]
  orphaned_knowledge: string[]
  oversized_related: ValidationIssue[]
  missing_fields: ValidationIssue[]
  total_entities: number
  total_knowledge: number
}

export interface SearchResult {
  slug: string
  kind: 'entity' | 'knowledge'
  name: string
  snippet: string
  type?: EntityType
  status?: EntityStatus
  confidence?: ConfidenceLevel
}

// --- Vault Stats ---

export interface VaultStats {
  counts: Record<EntityStatus, number>
  by_type: Record<EntityType, number>
  knowledge_count: number
  stale: Array<{ slug: string; name: string; type: EntityType; days_since_touched: number }>
  no_next_action: Array<{ slug: string; name: string; type: EntityType }>
  recently_touched: Array<{ slug: string; name: string; last_touched: string }>
  recently_created: Array<{ slug: string; name: string; created: string }>
}

// --- Changelog ---

export interface ChangelogEntry {
  slug: string
  kind: 'entity' | 'knowledge'
  operation: 'created' | 'updated' | 'deleted'
  timestamp: string
  commit_message: string
}

// --- Batch ---

export interface BatchResult {
  op: string
  slug: string
  status: 'ok' | 'error'
  error?: string
  created?: boolean
}

export type BatchOperation =
  | { op: 'update'; slug: string; fields: UpdateFields }
  | { op: 'create'; kind: 'entity'; name: string; fields: CreateEntityFields }
  | { op: 'create'; kind: 'knowledge'; name: string; fields?: CreateKnowledgeFields }
  | { op: 'create'; kind: 'session'; name: string; fields?: CreateKnowledgeFields }
  | { op: 'capture'; name: string; notes?: string }
  | { op: 'link'; slug: string; target: string; relation: LinkRelation }
  | { op: 'unlink'; slug: string; target: string; relation: LinkRelation }
  | { op: 'promote'; slug: string; target: 'entity' | 'project' | 'knowledge' }

// --- Errors ---

export type HafezErrorCode = 'NOT_FOUND' | 'SLUG_EXISTS' | 'VALIDATION_FAILED' | 'GIT_PUSH_FAILED'

export class HafezError extends Error {
  constructor(public code: HafezErrorCode, message: string, public details?: string[]) {
    super(message)
    this.name = 'HafezError'
  }
}

// --- Config ---

export interface GitConfig {
  push?: boolean  // default true
}

export interface HafezConfig {
  vaultPath: string
  readOnly?: boolean
  git?: GitConfig
  onWrite?: (slug: string, operation: string) => void
}

// --- Public API ---

export interface Hafez {
  read(slug: string, depth?: ReadDepth): Promise<ParsedFile>
  update(slug: string, fields: UpdateFields): Promise<UpdateResult>
  query(opts?: EntityQueryOpts): Promise<{ items: QueryResult[], total: number }>
  queryUnified(opts?: EntityQueryOpts & { kind?: 'entity' | 'knowledge' | 'all' }): Promise<{ items: UnifiedResult[], total: number }>
  create(kind: 'entity', name: string, fields: CreateEntityFields): Promise<string>
  create(kind: 'knowledge', name: string, fields?: CreateKnowledgeFields): Promise<string>
  capture(name: string, notes?: string): Promise<string>
  link(slug: string, target: string, relation: LinkRelation): Promise<void>
  unlink(slug: string, target: string, relation: LinkRelation): Promise<void>
  promote(slug: string, target: 'entity' | 'project' | 'knowledge'): Promise<string>
  batch(operations: BatchOperation[]): Promise<BatchResult[]>
  sync(): Promise<{ pulled: boolean; pushed: boolean; remote: boolean }>
  children(slug: string): Promise<{ items: QueryResult[], total: number }>
  related_to(slug: string, relation?: string): Promise<{ items: (QueryResult | KnowledgeQueryResult)[], total: number }>
  query_knowledge(opts?: KnowledgeQueryOpts): Promise<{ items: KnowledgeQueryResult[], total: number }>
  validate(): Promise<ValidationReport>
  search(query: string, kind?: 'entity' | 'knowledge' | 'all'): Promise<SearchResult[]>
  rebuildIndex(): Promise<void>
  stats(): Promise<VaultStats>
  changelog(since: string): Promise<ChangelogEntry[]>
}

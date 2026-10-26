// src/types.ts

// Type-only import: erased at compile time, so contracts.ts importing back
// from here stays a types-only cycle with no runtime edge.
import type {
  ENTITY_TYPES,
  ENTITY_STATUSES,
  CONFIDENCE_LEVELS,
  SESSION_LOG_TYPES,
  VALID_SUBTYPES,
  PLAN_STATUSES,
  GRAPH_LAYERS,
  SYNTHETIC_LAYERS,
  GRAPH_NOTE_RELATIONS,
  CHANGE_OPS,
} from './contracts.js'

// --- Enums ---
// Derived from the canonical tuples in contracts.ts — contracts is the single
// source of truth for enum membership, so a value added there widens the type
// here instead of needing a matching hand-edit that can drift.

export type EntityType = typeof ENTITY_TYPES[number]
export type EntityStatus = typeof ENTITY_STATUSES[number]
export type ConfidenceLevel = typeof CONFIDENCE_LEVELS[number]
export type SessionLogType = typeof SESSION_LOG_TYPES[number]
export type ReadDepth = 'frontmatter' | 'summary' | 'full'
export type QueryFilter = EntityStatus | 'all' | 'stale' | 'capture'
export type LinkRelation = 'parent' | 'related'
export type KnowledgeSubtype = typeof VALID_SUBTYPES[number]
/** Plans are the one knowledge subtype with a lifecycle (see PLAN_STATUSES). */
export type PlanStatus = typeof PLAN_STATUSES[number]
/** The kinds of note the Vault holds, one directory each (the Layout,
 * vault.ts, re-exports it). Declared here so this file imports no module
 * with runtime dependencies: the graph page's bundle reads its types. */
export type VaultKind = 'entity' | 'knowledge' | 'session'

// --- Query Options ---

/** Sort fields, and the two an entity query cannot honour — reinforcement
 * lives on knowledge notes only. Asking for one on the entity branch is a
 * validation error, not a silent fall back to recency, so the entity opts
 * type declares only what that branch can actually sort by. */
export type SortField = 'last_touched' | 'created' | 'name' | 'staleness' | 'last_reinforced' | 'reinforcement_count' | 'session_date'
export type EntitySortField = Exclude<SortField, 'last_reinforced' | 'reinforcement_count' | 'session_date'>
export type KnowledgeSortField = Exclude<SortField, 'session_date'>
/** A session note carries only its dates and its name. */
export type SessionSortField = 'session_date' | 'created' | 'name'

/** What `search` reaches. Unset is the working set, entity + knowledge;
 * `all` is literal, sessions included. */
export type SearchKind = 'entity' | 'knowledge' | 'session' | 'all'

export interface EntityQueryOpts {
  filter?: QueryFilter
  type?: EntityType
  parent?: string
  domain?: string
  since?: string          // ISO date — last_touched >= since
  before?: string         // ISO date — last_touched <= before
  createdSince?: string   // ISO date — created >= createdSince
  createdBefore?: string  // ISO date — created <= createdBefore
  tags?: string[]
  sort_by?: EntitySortField
  sort_order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

export interface KnowledgeQueryOpts {
  domain?: string
  confidence?: ConfidenceLevel
  subtype?: KnowledgeSubtype
  since?: string          // ISO date — last_touched >= since
  before?: string         // ISO date — last_touched <= before
  createdSince?: string   // ISO date — created >= createdSince
  createdBefore?: string  // ISO date — created <= createdBefore
  tags?: string[]
  sort_by?: KnowledgeSortField
  sort_order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/** Sessions carry no status, domain or tags: the time window (`since`/`before`
 * against `session-date`), sort and paging are all a session query takes. */
export interface SessionQueryOpts {
  since?: string          // ISO date — session_date >= since
  before?: string         // ISO date — session_date <= before
  createdSince?: string
  createdBefore?: string
  sort_by?: SessionSortField
  sort_order?: 'asc' | 'desc'
  limit?: number
  offset?: number
}

/** `kind: 'all'` (or unset): reaches both sides, so it takes opts from both
 * and can honour every sort field. Status filters narrow the entity side only
 * — knowledge notes carry no status and are never excluded by one. Unset
 * is the working set, entity + knowledge; `all` is literal and reaches the
 * sessions too. */
export interface AllQueryOpts extends Omit<EntityQueryOpts, 'sort_by'> {
  kind?: 'all'
  confidence?: ConfidenceLevel
  subtype?: KnowledgeSubtype
  sort_by?: SortField
}

/** The unified query, discriminated on `kind`. Naming a single kind narrows
 * this query to that kind's opts, because a narrowed branch maps no more than
 * the dedicated one does: an out-of-scope condition would land on a column the
 * selected kind leaves NULL and silently exclude every row. The read surface
 * rejects those at runtime for callers without types; the union is what makes
 * them a compile error first. */
export type UnifiedQueryOpts =
  | AllQueryOpts
  | (EntityQueryOpts & { kind: 'entity' })
  | (KnowledgeQueryOpts & { kind: 'knowledge' })
  | (SessionQueryOpts & { kind: 'session' })

// --- Frontmatter ---

export interface EntityFrontmatter {
  name: string
  type: EntityType
  status: EntityStatus
  description?: string
  resource?: string[]
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
  status?: PlanStatus            // plan subtype only
  'last-touched'?: string         // stamped by every update; at create only with status
}

// --- Parsed file ---

export interface SessionFrontmatter {
  name: string
  created: string
  'session-date'?: string
  related?: string[]
}

/** What parseFilePath returns: the kind comes from Layout (the file's
 * directory), so consumers switch on `kind` instead of sniffing keys. */
export type ParsedVaultFile =
  | { kind: 'entity'; frontmatter: EntityFrontmatter; body: string }
  | { kind: 'knowledge'; frontmatter: KnowledgeFrontmatter; body: string }
  | { kind: 'session'; frontmatter: SessionFrontmatter; body: string }

/** What read() returns: any vault file, so consumers narrow on `kind`. */
export type ParsedFile = ParsedVaultFile

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
  current_state?: string
  session_log?: SessionLogEntry
  agent?: string                     // entity-only; names the agent on the entry added when session_log is absent (default: detected from the Harness)
  brief?: string | null              // string = set/replace, null = remove section
  // Next Actions fields compose within one op as prune, tick, add:
  // clear_actions → remove_action(s) → complete_action(s) → add_action(s).
  // Queries match the list as it was before the op (two queries naming one
  // line is an error); added lines land last.
  add_action?: string                // add one item to Next Actions
  add_actions?: string[]             // add multiple items to Next Actions
  complete_action?: string           // complete the item: an open line's Handle, else a substring (case-insensitive)
  complete_actions?: string[]        // complete several items, each query as complete_action
  remove_action?: string             // remove the item without completing: Handle or substring, as above
  remove_actions?: string[]          // remove several items, each query as remove_action
  clear_actions?: boolean            // remove entire Next Actions section (rejected with a query field)
  parent?: string                    // entity-only; sets the parent link (slug must exist)
  // Domain (shared) + knowledge-only metadata
  description?: string | null      // '' or null clears
  resource?: string | string[] | null  // entity-only; appends, skipping duplicates; null, '' or [] clears
  domain?: string[]
  confidence?: ConfidenceLevel
  tags?: string[]
  related?: string[]
  synthesis?: string        // replaces insight — rewrites ## Synthesis section
  insight?: string          // alias for synthesis (knowledge-only); synthesis wins when both are set
  add_evidence?: string     // appends to ## Evidence section
  add_source?: string       // appends to ## Sources section
}

export interface UpdateResult {
  completed_action?: string              // text of the line complete_action matched, stamp stripped
  removed_action?: string                // text of the line remove_action matched, stamp stripped
  completed_actions?: string[]           // texts of the lines complete_actions matched, in query order
  removed_actions?: string[]             // texts of the lines remove_actions matched, in query order
  logged?: true                          // a session log entry was written: given, or mechanised by the Spine
  resource_added?: string[]              // the values resource added, the duplicate rule applied ([]: every one already held)
}

export interface CreateEntityFields {
  type: EntityType
  purpose?: string
  description?: string
  resource?: string | string[]
  domain?: string[]
  parent?: string
  related?: string[]
  tags?: string[]
  brief?: string
  add_action?: string
  add_actions?: string[]
}

export interface CreateKnowledgeFields {
  subtype?: KnowledgeSubtype
  status?: PlanStatus       // plan subtype only — insights have no lifecycle
  confidence?: ConfidenceLevel  // defaults to observation
  synthesis?: string        // replaces insight
  insight?: string          // alias for synthesis; synthesis wins when both are set
  description?: string
  domain?: string[]
  related?: string[]
  tags?: string[]
  'session-date'?: string  // ISO date for session notes
}

export interface CreateSessionFields {
  synthesis?: string        // the Summary section
  insight?: string          // alias for synthesis; synthesis wins when both are set
  related?: string[]
  'session-date'?: string
  decisions?: string[]      // one `- ` bullet each under Decisions
  entities_touched?: string[]  // one `- [[slug]]` each under Entities Touched
}

// --- Operation results ---

export interface QueryResult {
  slug: string
  name: string
  type: EntityType
  status: EntityStatus
  description: string | null
  resource: string[]               // entity-only; empty when none
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

export interface SessionQueryResult {
  slug: string
  name: string
  session_date: string
  created: string
  related: string[]
}

export type UnifiedResult =
  | (QueryResult & { kind: 'entity' })
  | (KnowledgeQueryResult & { kind: 'knowledge' })
  | (SessionQueryResult & { kind: 'session' })

export interface ValidationIssue {
  slug: string
  field: string
  issue: string
}

export interface ValidationReport {
  broken_slugs: ValidationIssue[]
  orphaned_knowledge: string[]
  missing_fields: ValidationIssue[]
  total_entities: number
  total_knowledge: number
  total_sessions: number
}

// --- The Health pass (#239) ---
// One key per check.

/** Check (i): an unsplit prefix family on an entity, from the family module. */
export interface HealthWorkstream {
  entity: string
  prefix: string
  open_actions: number
}

/** Check (ii): a name recurring in `units` units of one entity across `days`. */
export interface HealthRecurringName {
  entity: string
  term: string
  units: number
  days: string[]
}

/** Check (iv): `hits` of the parent's log entries dated on or after the
 * child's `created` (`entries` of them) name the child. */
export interface HealthLeak {
  parent: string
  child: string
  relation: 'parent' | 'related'
  hits: number
  entries: number
}

/** Check (iii): `from`'s `related` names `to`, a note of the same kind,
 * whose `related` does not name `from`. Check (v): `from`'s body mentions
 * `[[to]]`, a note of the same kind, with no `related` edge either way.
 * Neither lists a parent and its child: parent subsumes related. */
export interface HealthEdge {
  from: string
  to: string
}

/** Check (vi): the knowledge note `note`, created on `day` and related to
 * `entity`, shares `share` (0..1) of the summary tokens of a `decision`
 * entry of that day on the entity. */
export interface HealthRestatedDecision {
  day: string
  entity: string
  note: string
  share: number
  summary: string
}

export interface HealthReport {
  workstreams: HealthWorkstream[]
  recurring_names: HealthRecurringName[]
  leakage: HealthLeak[]
  one_way_edges: HealthEdge[]
  unlinked_mentions: HealthEdge[]
  restated_decisions: HealthRestatedDecision[]
}

// --- The Graph (#251) ---
// The Vault's structure: Entities and Knowledge notes joined by Parent,
// Related and Wiki-link (`mention`) edges; tags, domains and Sessions are
// optional layers.

export type GraphLayer = typeof GRAPH_LAYERS[number]
export type SyntheticLayer = typeof SYNTHETIC_LAYERS[number]

export interface GraphNode {
  /** The slug; `tag:<t>` / `domain:<d>` for a layer node (a slug never holds `:`). */
  id: string
  kind: VaultKind | SyntheticLayer
  name: string
  type?: EntityType
  status?: EntityStatus
  subtype?: KnowledgeSubtype
  confidence?: ConfidenceLevel
  last_touched?: string
  description?: string
  /** An active or paused Entity's open Next Actions. */
  open_actions?: number
  /** An active Entity untouched past its staleness-days: the index's stale rule. */
  stale?: boolean
  /** An active or paused Entity's open actions the Stale rule marks, undated ones included. */
  stale_actions?: number
  /** Every Entity's effective staleness-days: its own, else 14. */
  staleness_days?: number
  /** An Entity or Knowledge note with no Parent, Related or Wiki-link edge either way. */
  unlinked?: true
  /** On an Unlinked note: the closest other linked note by name and description,
   * the same kind when one matches; absent when none does. */
  best?: string
}

export interface GraphEdge {
  source: string
  target: string
  relation: typeof GRAPH_NOTE_RELATIONS[number] | SyntheticLayer
}

export interface Graph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** Any other opt is rejected, never dropped. */
export interface GraphOpts {
  /** Optional layers added to the default graph; they combine. */
  layers?: GraphLayer[]
}

export interface SearchResult {
  slug: string
  kind: 'entity' | 'knowledge' | 'session'
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
  kind: 'entity' | 'knowledge' | 'session'
  operation: 'created' | 'updated' | 'deleted'
  timestamp: string
  commit_message: string
  /** The commit's hash: what tells the entries of one commit from another's. */
  commit: string
}

/** What a write did to a note, as history tells it. */
export type ChangeOp = typeof CHANGE_OPS[number]

/** A file history changed between two points, as the Journal names it:
 * vault-relative and '/'-separated, any file (Layout decides which are notes). */
export interface FileChange {
  path: string
  op: ChangeOp
}

/** A note created, updated or deleted since a cursor (`changesSince`). */
export interface NoteChange {
  slug: string
  kind: VaultKind
  op: ChangeOp
}

/** What the graph server's `/events` pushes, one per poll that found
 * changes (src/graph/live.ts); the page reads it too. */
export interface CommitEvent {
  type: 'commit'
  changes: NoteChange[]
}

/** One row of the graph server's `/activity` (#278): a note's run of
 * consecutive writes, newest first. `op`, `kind` and `timestamp` are the
 * newest write's; `name` is the slug once the note is gone; `agent` is the
 * agent of the Entity's newest Session Log entry dated the write's local day,
 * absent where the Vault records none. */
export interface ActivityRow {
  slug: string
  kind: VaultKind
  op: ChangeOp
  timestamp: string
  name: string
  count: number
  agent?: string
}

export interface ChangesSince {
  /** The history point now: pass it back to get what changed after it.
   * Empty when the Vault has no history yet. */
  cursor: string
  changes: NoteChange[]
}

// --- Batch ---

export interface BatchResult {
  op: string
  slug: string
  /** 'skipped' = the Op Spec green-lit the op but there was nothing to do
   * (today: a duplicate session note) — no write, no error, batch continues.
   * Dry-run reports the same disposition as a warning. */
  status: 'ok' | 'error' | 'skipped'
  error?: string
  /** Why an op was skipped — same text the dry-run warning carries. */
  warning?: string
  /** Error class when the failure — or the skip — maps to a specific HafezError
   * code, so a single-op caller unwrapping this result keeps the right exit code. */
  code?: 'SLUG_EXISTS'
  created?: boolean
}

export type BatchOperation =
  | { op: 'update'; slug: string; fields: UpdateFields }
  | { op: 'create'; kind: 'entity'; name: string; fields: CreateEntityFields }
  | { op: 'create'; kind: 'knowledge'; name: string; fields?: CreateKnowledgeFields }
  | { op: 'create'; kind: 'session'; name: string; fields?: CreateSessionFields }
  | { op: 'capture'; name: string; notes?: string }
  | { op: 'link'; slug: string; target: string; relation: LinkRelation }
  | { op: 'unlink'; slug: string; target: string; relation: LinkRelation }
  | { op: 'promote'; slug: string; target: 'entity' | 'project' | 'knowledge' }
  | { op: 'delete'; slug: string }

/** What `delete` may remove. An entity is never deleted: it is retired with
 * `status: done`. */
export type DeletableKind = 'knowledge' | 'session'

// Per-op result of the shared validate phase (dry-run and apply both run it).
// `slug` is the derived slug for create/capture ops — the dry-run slug oracle.
export interface BatchOpValidation {
  index: number
  op: string
  slug: string
  created?: boolean
  errors: string[]
  warning?: string
  /** Error class of the primary failure (NOT_FOUND / SLUG_EXISTS) when it
   * maps to a specific HafezError code; single-op callers surface it as that
   * code, batch-level failures stay VALIDATION_FAILED. */
  primaryCode?: 'NOT_FOUND' | 'SLUG_EXISTS'
}

export interface BatchValidationReport {
  valid: boolean
  operations: BatchOpValidation[]
}

// --- Errors ---

export type HafezErrorCode = 'NOT_FOUND' | 'SLUG_EXISTS' | 'VALIDATION_FAILED' | 'GIT_PUSH_FAILED' | 'GIT_COMMIT_FAILED' | 'GIT_READ_FAILED' | 'VAULT_LOCKED'

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

/**
 * The persistence seam (see CONTEXT.md: Journal) — everything core needs
 * from the history layer: the commit behind every vault mutation, sync, and
 * the history reads (changelog, file times, the changes since a cursor). Git
 * satisfies it in production (src/git.ts); tests may inject an in-memory
 * adapter.
 */
export interface Journal {
  /** Persist one logical change: stage written+deleted paths (vault-relative,
   * '/'-separated on every platform) and commit under message. Must clean up
   * its own partial state (e.g. staged files) before rethrowing on a
   * commit-stage failure; a push-stage failure surfaces as GIT_PUSH_FAILED
   * with the commit kept. */
  commit(written: string[], deleted: string[], message: string): Promise<void>
  /** Bidirectional sync with the remote, if any. */
  sync(): Promise<{ pulled: boolean; pushed: boolean; remote: boolean }>
  /** History-derived changelog for the indexed dirs since a date ('' = all
   * history), newest first; `limit` reads only the newest that many commits.
   * Empty when the repo has no commits; any other git failure throws `GIT_READ_FAILED`. */
  changelog(since: string, limit?: number): Promise<ChangelogEntry[]>
  /** Newest history timestamp per vault file (modified = any change, added = creation).
   * Empty when the repo has no commits; any other git failure throws `GIT_READ_FAILED`. */
  fileTimes(mode: 'modified' | 'added'): Promise<Map<string, string>>
  /** The history point now (`cursor`, '' before the first commit) and the
   * indexed-dir files whose content differs between `from` and it, each with
   * its net status across the whole span (a rename is a delete and a
   * create). `from` unset: the cursor only, no files; `from` '': every file
   * in history now is a create. An unknown `from` or any other git failure
   * throws `GIT_READ_FAILED`. */
  changesSince(from?: string): Promise<{ cursor: string; files: FileChange[] }>
}

export interface HafezConfig {
  vaultPath: string
  readOnly?: boolean
  git?: GitConfig
  /** Override the persistence layer. Defaults to the git adapter. */
  persistence?: Journal
  onWrite?: (slug: string, operation: string) => void
}

// --- Public API ---

export interface Hafez {
  read(slug: string, depth?: ReadDepth): Promise<ParsedFile>
  update(slug: string, fields: UpdateFields): Promise<UpdateResult>
  query(opts?: EntityQueryOpts): Promise<{ items: QueryResult[], total: number }>
  queryUnified(opts?: UnifiedQueryOpts): Promise<{ items: UnifiedResult[], total: number }>
  create(kind: 'entity', name: string, fields: CreateEntityFields): Promise<string>
  create(kind: 'knowledge', name: string, fields?: CreateKnowledgeFields): Promise<string>
  capture(name: string, notes?: string): Promise<string>
  link(slug: string, target: string, relation: LinkRelation): Promise<void>
  unlink(slug: string, target: string, relation: LinkRelation): Promise<void>
  promote(slug: string, target: 'entity' | 'project' | 'knowledge'): Promise<string>
  /** Delete a knowledge or session note; resolves to the kind deleted. */
  delete(slug: string): Promise<DeletableKind>
  batch(operations: BatchOperation[]): Promise<BatchResult[]>
  validateBatch(operations: BatchOperation[]): Promise<BatchValidationReport>
  sync(): Promise<{ pulled: boolean; pushed: boolean; remote: boolean }>
  children(slug: string): Promise<{ items: QueryResult[], total: number }>
  related_to(slug: string, relation?: string): Promise<{ items: UnifiedResult[], total: number }>
  query_knowledge(opts?: KnowledgeQueryOpts): Promise<{ items: KnowledgeQueryResult[], total: number }>
  query_sessions(opts?: SessionQueryOpts): Promise<{ items: SessionQueryResult[], total: number }>
  /** An entity's archived log entries (`entities/archive/<slug>-log.md`), as
   * written; null when it has none. Read from disk, never indexed: the
   * archive is reached from its entity on purpose, never found by search. */
  archive(slug: string): Promise<string | null>
  validate(): Promise<ValidationReport>
  /** The Health pass: what placement would change, from the files on disk
   * (never the index); applies nothing. */
  health(): Promise<HealthReport>
  search(query: string, kind?: SearchKind): Promise<SearchResult[]>
  /** The Vault's structure: Entity and Knowledge nodes, Parent, Related (one
   * per unordered pair) and Wiki-link edges among them; `layers` adds tag,
   * domain and Session nodes with their edges. */
  graph(opts?: GraphOpts): Promise<Graph>
  rebuildIndex(): Promise<void>
  stats(): Promise<VaultStats>
  /** The changes since a date ('' = all history), newest first; `limit`
   * reads only the newest that many commits, a positive whole number
   * (anything else is VALIDATION_FAILED). */
  changelog(since: string, limit?: number): Promise<ChangelogEntry[]>
  /** The notes created, updated or deleted since `cursor`, from history, and
   * the cursor to pass next time. No cursor: the current cursor and no
   * changes, so a follower starts from now. */
  changesSince(cursor?: string): Promise<ChangesSince>
  /** Release the SQLite index handle. Idempotent; the next call that needs
   * the index reopens it. Call before deleting the vault: Windows cannot
   * remove a directory holding an open file. */
  close(): void
}

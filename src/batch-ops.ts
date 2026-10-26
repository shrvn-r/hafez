// src/batch-ops.ts
// The Op Spec (see CONTEXT.md): one table defining every batch operation —
// shape (Zod), semantic check, description, and example hints — from which
// validation, error text, and schema introspection all derive. Adding an op
// means one entry here plus one arm in the Apply table (src/apply.ts), which
// the compiler enforces: the arm table is keyed by this table's names.
//
// Every semantic gate lives here and runs exactly once, in the validate phase.
// Apply assumes the payload it receives passed these checks.
import { z } from 'zod'
import type { BatchOperation, CreateEntityFields, CreateKnowledgeFields, DeletableKind, KnowledgeSubtype, SessionLogEntry, UpdateFields } from './types.js'
import {
  ALIAS_KEYS,
  ENTITY_TYPES,
  ENTITY_STATUSES,
  SESSION_LOG_TYPES,
  CONFIDENCE_LEVELS,
  VALID_SUBTYPES,
  PLAN_STATUSES,
  getContract,
} from './contracts.js'
import { slugify } from './vault.js'
import { HafezError } from './types.js'

// --- Shapes ---
// All enums are built from contracts.ts tuples so help-renderer, file validators,
// and CLI-input validator share a single source of truth.
// Every z.object(...) is .strict() — unknown keys become `unrecognized_keys` issues
// (not silently dropped), which is load-bearing for the error-formatter's did-you-mean
// hints and for catching typos like `{"kind": "parent"}` on a link op.

// Body-section text must have text after trimming. An empty or whitespace-only
// value (an agent expanding an unset variable) used to sail through the shape —
// on the action/evidence fields it was dropped by a truthiness guard in apply
// (exit 0, nothing on disk); on the section-setting fields below it was worse,
// because apply trusts the validate phase and `setSection(body, 'Synthesis',
// '')` wipes what was already there. Same false-success class the CLI loop
// closed for the enum flags, once silent and once destructive.
//
// The rule: every non-nullable string field that writes body-section text is
// nonEmptyText. The nullable ones (update's brief/description/resource) are
// excluded by construction — null is their documented clear signal, and the
// CLI maps `--brief ""` to it. Trimming also keeps accidental padding out of
// stored text.
const nonEmptyText = z.string().trim().min(1, 'must contain text — an empty value is rejected, never silently dropped')

// A list field (domain, tags, related) takes a string[] or, like the CLI's
// list flags (`--domain "a,b"`), one comma string. The split is the one rule
// for both paths — the CLI's `splitList` calls it — so `"a, b"` is the same
// two values everywhere (#33).
export const splitCommaList = (value: string): string[] => value.split(',').map(s => s.trim()).filter(Boolean)
const stringList = z.preprocess(v => typeof v === 'string' ? splitCommaList(v) : v, z.array(z.string()))

// `resource` takes one value or a list (#304), a string being a one-value
// list. `''` clears (update) or adds nothing (create) on its own; beside a
// value it is ambiguous, so rejected. A literal `.` names the CLI's working
// folder, which the library cannot see.
const RESOURCE_DOT_REASON = '`.` is resolved by the CLI; pass the folder\'s remote URL or path'
export const RESOURCE_CLEAR_REASON = 'an empty value clears every value and cannot stand beside another'
/** `''` beside a value: whether the clear or the add won would be ambiguous. */
export const clearsBesideValue = (list: string[]): boolean => list.length > 1 && list.includes('')
const resourceValues = z.preprocess(v => typeof v === 'string' ? [v] : v, z.array(z.string()).superRefine((list, ctx) => {
  if (list.includes('.')) ctx.addIssue({ code: 'custom', message: RESOURCE_DOT_REASON })
  if (clearsBesideValue(list)) ctx.addIssue({ code: 'custom', message: RESOURCE_CLEAR_REASON })
}))

/** A valid `resource` field's values: one value or a list; null, `''` and
 * `[]` are none. */
export function resourceList(value: string | string[] | null | undefined): string[] {
  return (typeof value === 'string' ? [value] : value ?? []).filter(v => v !== '')
}

export const SessionLogSchema = z.object({
  type: z.enum([...SESSION_LOG_TYPES] as [string, ...string[]]),
  summary: z.string(),
  body: nonEmptyText.optional(),
  agent: z.string(),
}).strict()

export const UpdateFieldsSchema = z.object({
  status: z.enum([...ENTITY_STATUSES] as [string, ...string[]]).optional(),
  current_state: nonEmptyText.optional(),
  session_log: SessionLogSchema.optional(),
  agent: nonEmptyText.optional(),     // entity-only; names the agent on the added session log entry
  brief: z.string().nullable().optional(),
  add_action: nonEmptyText.optional(),
  add_actions: z.array(nonEmptyText).optional(),
  complete_action: nonEmptyText.optional(),
  complete_actions: z.array(nonEmptyText).min(1).optional(),
  remove_action: nonEmptyText.optional(),
  remove_actions: z.array(nonEmptyText).min(1).optional(),
  clear_actions: z.boolean().optional(),
  parent: z.string().optional(),     // entity-only; the slug must exist, no cycle
  // Knowledge metadata
  description: z.string().nullable().optional(),
  resource: resourceValues.nullable().optional(),
  domain: stringList.optional(),
  confidence: z.enum([...CONFIDENCE_LEVELS] as [string, ...string[]]).optional(),
  tags: stringList.optional(),
  related: stringList.optional(),
  synthesis: nonEmptyText.optional(),
  insight: nonEmptyText.optional(),   // alias for synthesis (normalized by normalizeAliases)
  add_evidence: nonEmptyText.optional(),
  add_source: nonEmptyText.optional(),
}).strict()

export const CreateEntityFieldsSchema = z.object({
  type: z.enum([...ENTITY_TYPES] as [string, ...string[]]),
  purpose: nonEmptyText.optional(),
  description: z.string().optional(),
  resource: resourceValues.optional(),
  domain: stringList.optional(),
  parent: z.string().optional(),
  related: stringList.optional(),
  tags: stringList.optional(),
  brief: nonEmptyText.optional(),
  add_action: nonEmptyText.optional(),
  add_actions: z.array(nonEmptyText).optional(),
}).strict()

export const CreateKnowledgeFieldsSchema = z.object({
  subtype: z.enum([...VALID_SUBTYPES] as [string, ...string[]]).optional(),
  // Plan-only: insights have no lifecycle, so the semantic check rejects
  // status on any other subtype (the shape only pins the allowed values).
  status: z.enum([...PLAN_STATUSES] as [string, ...string[]]).optional(),
  confidence: z.enum([...CONFIDENCE_LEVELS] as [string, ...string[]]).optional(),
  synthesis: nonEmptyText.optional(),
  insight: nonEmptyText.optional(),
  description: z.string().optional(),
  domain: stringList.optional(),
  related: stringList.optional(),
  tags: stringList.optional(),
  'session-date': z.string().optional(),
}).strict()

export const CreateSessionFieldsSchema = z.object({
  synthesis: nonEmptyText.optional(),
  insight: nonEmptyText.optional(),
  related: stringList.optional(),
  'session-date': z.string().optional(),
  // Decisions are prose: a list only, never a comma string split apart.
  decisions: z.array(nonEmptyText).optional(),
  entities_touched: stringList.optional(),
}).strict()

/** What `digest` may put in a session-create op — typechecked against the
 * schema so the two can never silently diverge again. */
export type CreateSessionFieldsInput = z.infer<typeof CreateSessionFieldsSchema>

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

/** Update fields the mechanised session log neither counts nor names:
 * ticking a box is not history worth an entry, and `agent` only names it. */
const UNLOGGED_FIELDS = new Set<keyof UpdateFields>(['add_action', 'add_actions', 'complete_action', 'complete_actions', 'remove_action', 'remove_actions', 'clear_actions', 'agent'])

/** The fields an update's mechanised session log entry names — empty when
 * the update earns none. Shared by the update check (which rejects an
 * `agent` with no entry to name) and the Apply update arm (which writes it). */
export function loggedFields(fields: UpdateFields): (keyof UpdateFields)[] {
  return (Object.keys(fields) as (keyof UpdateFields)[])
    .filter(f => fields[f] !== undefined && !UNLOGGED_FIELDS.has(f))
}

const UpdateBranch = z.object({
  op: z.literal('update'),
  slug: z.string(),
  fields: UpdateFieldsSchema,
}).strict()

const CaptureBranch = z.object({
  op: z.literal('capture'),
  name: z.string(),
  notes: z.string().optional(),
}).strict()

const LinkBranch = z.object({
  op: z.literal('link'),
  slug: z.string(),
  target: z.string(),
  relation: z.enum(['parent', 'related']),
}).strict()

const UnlinkBranch = z.object({
  op: z.literal('unlink'),
  slug: z.string(),
  target: z.string(),
  relation: z.enum(['parent', 'related']),
}).strict()

const PromoteBranch = z.object({
  op: z.literal('promote'),
  slug: z.string(),
  target: z.enum(['entity', 'project', 'knowledge']),
}).strict()

// No `kind`: the slug alone says what is being deleted, the same as
// `hafez delete <slug>`. The check resolves it and rejects an entity.
const DeleteBranch = z.object({
  op: z.literal('delete'),
  slug: z.string(),
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
  UpdateBranch,
  // create is a nested discriminatedUnion on `kind` — see CreateBranch above.
  // discriminatedUnion accepts a ZodDiscriminatedUnion as a branch via option-flattening.
  CreateBranch as unknown as z.ZodObject<{ op: z.ZodLiteral<'create'> }>,
  CaptureBranch,
  LinkBranch,
  UnlinkBranch,
  PromoteBranch,
  DeleteBranch,
])

// --- Alias normalization ---
// The one place a declared alias (contracts.ts ALIAS_KEYS) becomes its canonical
// field. It runs before validation, so validate and apply both see the canonical
// op on every entry point — library create/update/batch and CLI batch input
// alike. Normalizing anywhere else is what made the alias a silent drop: the
// strict shapes accepted `insight`, nothing rewrote it, and the apply step (which
// only reads `synthesis`) wrote an empty Synthesis section and reported ok.

/** ALIAS_KEYS re-keyed by op path prefix: 'update.fields' → [[alias, canonical]]. */
const ALIASES_BY_PATH = new Map<string, [string, string][]>()
for (const [path, canonical] of Object.entries(ALIAS_KEYS)) {
  const cut = path.lastIndexOf('.')
  const prefix = path.slice(0, cut)
  const list = ALIASES_BY_PATH.get(prefix) ?? []
  list.push([path.slice(cut + 1), canonical])
  ALIASES_BY_PATH.set(prefix, list)
}

/** Canonicalize an operation's declared aliases.
 *
 * Precedence when both are present: the canonical field wins and the alias is
 * dropped. Never mutates the caller's object — an op carrying no alias is
 * returned as-is. */
export function normalizeAliases<T>(op: T): T {
  const o = op as { op?: unknown; kind?: unknown; fields?: Record<string, unknown> } | null
  if (!o || typeof o !== 'object' || !o.fields || typeof o.fields !== 'object') return op
  const prefix = `${String(o.op)}${o.kind === undefined ? '' : `.${String(o.kind)}`}.fields`
  const aliases = ALIASES_BY_PATH.get(prefix)
  if (!aliases) return op
  let fields: Record<string, unknown> | undefined
  for (const [alias, canonical] of aliases) {
    if (o.fields[alias] === undefined) continue
    fields ??= { ...o.fields }
    if (fields[canonical] === undefined) fields[canonical] = fields[alias]
    delete fields[alias]
  }
  return fields ? { ...o, fields } as T : op
}

/** normalizeAliases over a payload — the form the Spine and dry-run use. */
export function normalizeOperations(operations: BatchOperation[]): BatchOperation[] {
  return operations.map(op => normalizeAliases(op))
}

// --- Semantic checks ---

/** What a slug resolves to. `subtype` is carried for knowledge so ops that
 * gate on the plan/insight distinction see it for files already on disk AND
 * for notes created earlier in the same batch. */
export interface ResolvedTarget {
  kind: 'entity' | 'knowledge'
  type: string
  subtype?: KnowledgeSubtype
}

/** The frontmatter links `validate` checks: what makes one file a referrer
 * of another. */
export interface FileLinks {
  parent?: string
  related?: string[]
}

/** Vault context handed to each spec's semantic check by validateBatchCore.
 * Simulation-aware: creates earlier in the batch count as existing. */
export interface OpCheckContext {
  resolve(slug: string): ResolvedTarget | null
  existsAnywhere(slug: string): boolean
  sessionExists(slug: string): boolean
  simulate(slug: string, info: ResolvedTarget): void
  simulateSession(slug: string): void
  /** The parent/related a file carries after the earlier ops in the batch. */
  linksOf(slug: string): FileLinks
  /** Record the parent/related a file will carry after this op. Every op
   * that changes a link calls it, so `referrers` sees the batch so far. */
  simulateLinks(slug: string, links: FileLinks): void
  /** Entities and knowledge notes whose parent or related names `slug`,
   * after the earlier ops in the batch. A file never refers to itself. */
  referrers(slug: string): string[]
  simulateDelete(slug: string, kind: DeletableKind): void
  /** Kind gating is subtype-aware for knowledge: a plan carries `status`,
   * an insight does not (see contracts.SUBTYPE_STATUSES). */
  validateKindFields(kind: 'entity' | 'knowledge', fields: UpdateFields, subtype?: KnowledgeSubtype): void
  validateSessionLogEntry(entry: SessionLogEntry): string[]
  buildEntityFrontmatter(name: string, fields: CreateEntityFields): void
  buildKnowledgeFrontmatter(name: string, fields: CreateKnowledgeFields): void
}

export interface OpCheckResult {
  slug: string
  errors: string[]
  created?: boolean
  warning?: string
  /** Error class of the primary failure, when it maps to a specific
   * HafezError code. The Spine uses it so single-op callers keep NOT_FOUND /
   * SLUG_EXISTS semantics (and their exit codes) through spec validation;
   * batch-level failures stay VALIDATION_FAILED regardless. */
  primaryCode?: 'NOT_FOUND' | 'SLUG_EXISTS'
}

function pushErr(errors: string[], err: unknown): void {
  const e = err as HafezError
  errors.push(e.details?.length ? `${e.message}: ${e.details.join('; ')}` : e.message)
}

/** The one source of the missing-slug error text — specs and the Spine's
 * shape-failure precedence rule (validateBatchCore) must not drift apart. */
export function notFoundError(slug: string): string {
  return `'${slug}' not found`
}

/** The one op-error line format. Every surface that localises an error to its
 * op — the validate phase's error list, apply's execution-time failures, and
 * the CLI's dry-run report — renders it through here, so an agent parsing
 * `op[i] (op slug): …` sees one shape whichever surface produced it. */
export function opErrorLine(index: number, op: string, slug: string, message: string): string {
  return `op[${index}] (${op} ${slug}): ${message}`
}

/** The one "the batch was rejected, nothing landed" header — shared by the
 * library's validate gate and the CLI's shape-parse gate, which reject the
 * same payload at different depths and must say so identically. `batch
 * --dry-run` deliberately words its own header differently: it reports a
 * hypothetical ("would be applied"), not a refusal. */
export function batchInvalidHeader(invalidCount: number, total: number): string {
  return `Batch failed validation: ${invalidCount} invalid operation${invalidCount === 1 ? '' : 's'} (0 of ${total} applied)`
}

/** The one source of the duplicate-session disposition text. A duplicate
 * session is not an error — the op is skipped and the batch continues — and
 * dry-run (spec warning) and apply (BatchResult.warning) report it with this
 * same sentence so the two can never drift. */
export function duplicateSessionWarning(slug: string): string {
  return `session '${slug}' already exists — op skipped (batch continues)`
}

/** The create-style gate, in one place so the invariant can't be re-broken:
 * a taken slug is a SLUG_EXISTS error and must NOT be simulated (simulating
 * over an existing slug shadows the real file's kind for later ops in the
 * batch). The builder runs before the claim — it must see the pre-claim
 * world so a self-referencing parent still fails. */
function claimNew(
  ctx: OpCheckContext,
  errors: string[],
  slug: string,
  info: ResolvedTarget,
  build?: () => void,
): OpCheckResult['primaryCode'] {
  // A session note holds its slug too: every kind shares one index row per
  // slug, so a create must not take one a session already has.
  const taken = ctx.existsAnywhere(slug) || ctx.sessionExists(slug)
  if (taken) errors.push(`Slug '${slug}' already exists`)
  if (build) { try { build() } catch (err) { pushErr(errors, err) } }
  if (!taken) ctx.simulate(slug, info)
  return taken ? 'SLUG_EXISTS' : undefined
}

/** The link fields an update payload sets, or null when it sets none. */
function linkFieldsOf(fields: UpdateFields): FileLinks | null {
  const links: FileLinks = {}
  if (fields.parent !== undefined) links.parent = fields.parent
  if (fields.related !== undefined) links.related = fields.related
  return Object.keys(links).length > 0 ? links : null
}

/** The parent chain `slug → parent → … → slug` that giving `slug` this
 * parent closes, or null when the chain ends or loops without `slug`.
 * Shared by the Op Spec checks (against the simulated batch) and
 * `validateVault` (against the files). */
export function parentCycle(slug: string, parent: string | undefined, parentOf: (s: string) => string | undefined): string[] | null {
  const path = [slug]
  const seen = new Set(path)
  for (let p = parent; p !== undefined; p = parentOf(p)) {
    path.push(p)
    if (p === slug) return path
    if (seen.has(p)) return null
    seen.add(p)
  }
  return null
}

function parentCycleError(slug: string, parent: string, ctx: OpCheckContext): string | null {
  const cycle = parentCycle(slug, parent, s => ctx.linksOf(s).parent)
  return cycle ? `Parent '${parent}' would make a cycle: ${cycle.join(' → ')}` : null
}

/** An entity and its own parent or child are never `related` (ADR 0002):
 * `parent` subsumes it. The errors for the links `slug` would carry after
 * the op — the parent named in its related, a related whose parent is
 * `slug`, or a parent whose related names `slug` (a legacy one-way edge) —
 * against the batch so far. */
function parentSubsumesErrors(slug: string, links: FileLinks, ctx: OpCheckContext): string[] {
  const errors: string[] = []
  for (const r of links.related ?? []) {
    if (r === links.parent) errors.push(`'${r}' is the parent of '${slug}' — parent subsumes related`)
    else if (ctx.existsAnywhere(r) && ctx.linksOf(r).parent === slug) errors.push(`'${r}' is a child of '${slug}' — parent subsumes related`)
  }
  const p = links.parent
  if (p && ctx.existsAnywhere(p) && ctx.linksOf(p).related?.includes(slug)) errors.push(`'${p}' names '${slug}' in its related — parent subsumes related`)
  return errors
}

/** Record what the edge writer and dropper will do to the targets: a
 * same-kind `related` edge has two ends, so after `slug`'s related changes
 * from `before` to `after`, every added same-kind target carries `slug` and
 * every dropped one loses it. Cross-kind and unknown targets are left as
 * they are, like the files. */
function simulateBackEdges(slug: string, before: string[] | undefined, after: string[] | undefined, ctx: OpCheckContext): void {
  const kind = ctx.resolve(slug)?.kind
  const was = before ?? []
  const now = after ?? []
  for (const r of [...now.filter(r => !was.includes(r)), ...was.filter(r => !now.includes(r))]) {
    if (r === slug || !kind || !ctx.existsAnywhere(r) || ctx.resolve(r)?.kind !== kind) continue
    const links = ctx.linksOf(r)
    const rest = (links.related ?? []).filter(x => x !== slug)
    const related = now.includes(r) ? [...rest, slug] : rest
    ctx.simulateLinks(r, { ...links, related: related.length > 0 ? related : undefined })
  }
}

/** The link fields after an op, simulated for `slug` and mirrored on the
 * targets its related gained or lost. */
function simulateLinkChange(slug: string, before: FileLinks, after: FileLinks, ctx: OpCheckContext): void {
  ctx.simulateLinks(slug, after)
  simulateBackEdges(slug, before.related, after.related, ctx)
}

// --- The table ---

export interface OpSpec {
  /** Stable identifier used by `schema <name>` and the op catalog. */
  name: string
  op: BatchOperation['op']
  kind?: 'entity' | 'knowledge' | 'session'
  schema: z.ZodType
  description: string
  /** Optional fields force-included in the generated example payload. */
  exampleInclude: readonly string[]
  /** The op's `slug` may name a session note as well as an entity or
   * knowledge note. */
  addressesSessions?: boolean
  check(op: any, ctx: OpCheckContext): OpCheckResult
}

// `as const satisfies` rather than a `: OpSpec[]` annotation: it keeps each
// row's `name` a literal, which is what OpSpecName (and through it the Apply
// table's key type) is derived from. OP_SPECS below re-exports the rows under
// the interface, so consumers still read optional fields (`kind`) off them.
const OP_SPEC_ROWS = [
  {
    name: 'update',
    op: 'update',
    schema: UpdateBranch,
    description: 'Update an entity or knowledge note (status, brief, next actions, session log, synthesis, …). Next Actions fields compose within one op as prune, tick, add: `clear_actions` → `remove_action(s)` → `complete_action(s)` → `add_action(s)` — queries match the list as it was before the op (two queries naming one line is an error), added lines land last, so `clear_actions` + `add_actions` rebuilds the list; `clear_actions` with a query field is rejected. Lines leaving the list (removed, cleared, pruned with an emptied section, ticked past nine, oldest first) move to the entity\'s archive log. A Handle of an open action (as `read` shows it, or any longer or shorter prefix of four or more hex that names only that line) names that line; anything else is a case-insensitive substring of the text. `parent` sets the parent link (entity-only; the slug must exist, and the parent chain must not lead back to the entity). `insight` is an alias for `synthesis` (knowledge-only; ignored when `synthesis` is also given). An entity update with no `session_log` gets a `progress` entry naming the fields written, unless its only fields are action fields; `agent` names the agent on it (entity-only, detected from the Harness when absent, rejected alongside `session_log`). On knowledge notes `status` is plan-subtype only (active|done); insights reject it.',
    exampleInclude: ['status'],
    check(op: Extract<BatchOperation, { op: 'update' }>, ctx) {
      const errors: string[] = []
      let primaryCode: OpCheckResult['primaryCode']
      const target = ctx.resolve(op.slug)
      if (!target) { errors.push(notFoundError(op.slug)); primaryCode = 'NOT_FOUND' }
      else {
        try { ctx.validateKindFields(target.kind, op.fields, target.subtype) } catch (err) { pushErr(errors, err) }
      }
      // Statically contradictory: clear_actions runs first and empties the
      // list, so any query in the same op would fail at apply time with a
      // misleading "No matching action". Reject here, where the message can
      // say why and land beside the batch's other errors. Entity targets
      // only — on a knowledge note validateKindFields has already rejected
      // the fields themselves, and a second error about their order is noise.
      if (target?.kind === 'entity' && op.fields.clear_actions) {
        const queries = (['remove_action', 'remove_actions', 'complete_action', 'complete_actions'] as const).filter(f => op.fields[f] !== undefined)
        if (queries.length > 0) {
          errors.push(`clear_actions empties the list before ${queries.slice(0, -1).join(', ')}${queries.length > 1 ? ' and ' : ''}${queries.at(-1)} would run — drop the clear or use a separate op`)
        }
      }
      // `agent` names the entry the Spine adds; with nothing added it would be
      // dropped. Entity targets only — on a knowledge note validateKindFields
      // has already rejected it as entity-only.
      if (target?.kind === 'entity' && op.fields.agent !== undefined) {
        if (op.fields.session_log) {
          errors.push('agent names the session log entry added when session_log is absent — with session_log, set session_log.agent instead')
        } else if (loggedFields(op.fields).length === 0) {
          errors.push('agent names the session log entry, and an update of action fields alone writes none — drop agent')
        }
      }
      if (op.fields.session_log) {
        const logErrors = ctx.validateSessionLogEntry(op.fields.session_log)
        if (logErrors.length > 0) errors.push(`Invalid session log entry: ${logErrors.join('; ')}`)
      }
      if (op.fields.related) {
        for (const r of op.fields.related) {
          if (!ctx.existsAnywhere(r)) errors.push(`Related slug '${r}' does not exist`)
        }
      }
      if (op.fields.parent !== undefined) {
        if (!ctx.existsAnywhere(op.fields.parent)) errors.push(`Parent '${op.fields.parent}' does not exist`)
        else if (target?.kind === 'entity') {
          const cycle = parentCycleError(op.slug, op.fields.parent, ctx)
          if (cycle) errors.push(cycle)
        }
      }
      if (target) {
        const links = linkFieldsOf(op.fields)
        if (links) {
          const before = ctx.linksOf(op.slug)
          const after = { ...before, ...links }
          errors.push(...parentSubsumesErrors(op.slug, after, ctx))
          simulateLinkChange(op.slug, before, after, ctx)
        }
      }
      return { slug: op.slug, errors, primaryCode }
    },
  },
  {
    name: 'create-entity',
    op: 'create',
    kind: 'entity',
    schema: CreateEntityBranch,
    description: 'Create a new entity (capture / entity / project). A field whose section the chosen type lacks is rejected, never dropped — `purpose` needs type project.',
    exampleInclude: ['type'],
    check(op: Extract<BatchOperation, { op: 'create'; kind: 'entity' }>, ctx) {
      const errors: string[] = []
      const slug = slugify(op.name)
      const primaryCode = claimNew(ctx, errors, slug, { kind: 'entity', type: op.fields.type },
        () => ctx.buildEntityFrontmatter(op.name, op.fields))
      if (!primaryCode) {
        const links = { parent: op.fields.parent, related: op.fields.related }
        errors.push(...parentSubsumesErrors(slug, links, ctx))
        simulateLinkChange(slug, {}, links, ctx)
      }
      return { slug, errors, created: errors.length === 0, primaryCode }
    },
  },
  {
    name: 'create-knowledge',
    op: 'create',
    kind: 'knowledge',
    schema: CreateKnowledgeBranch,
    description: 'Create a new knowledge note (insight / plan subtype). `confidence` defaults to observation. `insight` is an alias for `synthesis` (ignored when `synthesis` is also given). `status` (active|done) is plan-only; `synthesis` is insight-only — plan bodies are Goal/Steps/Dependencies, and a field whose section the subtype lacks is rejected, never dropped.',
    exampleInclude: ['subtype', 'synthesis'],
    check(op: Extract<BatchOperation, { op: 'create'; kind: 'knowledge' }>, ctx) {
      const errors: string[] = []
      const slug = slugify(op.name)
      const primaryCode = claimNew(ctx, errors, slug,
        { kind: 'knowledge', type: 'knowledge', subtype: op.fields?.subtype as KnowledgeSubtype | undefined },
        () => ctx.buildKnowledgeFrontmatter(op.name, (op.fields || {}) as CreateKnowledgeFields))
      if (!primaryCode) simulateLinkChange(slug, {}, { related: op.fields?.related }, ctx)
      return { slug, errors, created: errors.length === 0, primaryCode }
    },
  },
  {
    name: 'create-session',
    op: 'create',
    kind: 'session',
    schema: CreateSessionBranch,
    description: 'Create a new session note linked to an entity. `synthesis` writes Summary, `decisions` one bullet each under Decisions, `entities_touched` one `[[slug]]` bullet each under Entities Touched. `insight` is an alias for `synthesis` (ignored when `synthesis` is also given).',
    exampleInclude: ['synthesis'],
    check(op: Extract<BatchOperation, { op: 'create'; kind: 'session' }>, ctx) {
      const slug = slugify(op.name)
      if (ctx.existsAnywhere(slug) || ctx.sessionExists(slug)) {
        return { slug, errors: [], warning: duplicateSessionWarning(slug) }
      }
      ctx.simulateSession(slug)
      return { slug, errors: [], created: true }
    },
  },
  {
    name: 'capture',
    op: 'capture',
    schema: CaptureBranch,
    description: 'Quick capture — a raw inbox item with no structure required.',
    exampleInclude: ['notes'],
    check(op: Extract<BatchOperation, { op: 'capture' }>, ctx) {
      const errors: string[] = []
      const slug = slugify(op.name)
      const primaryCode = claimNew(ctx, errors, slug, { kind: 'entity', type: 'capture' })
      return { slug, errors, created: errors.length === 0, primaryCode }
    },
  },
  {
    name: 'link',
    op: 'link',
    schema: LinkBranch,
    description: 'Add a parent or related link. A same-kind related link (entity↔entity, knowledge↔knowledge) is written on both files; a related naming the entity\'s parent or a child is rejected (parent subsumes related).',
    exampleInclude: [],
    check(op: Extract<BatchOperation, { op: 'link' }>, ctx) {
      const errors: string[] = []
      let primaryCode: OpCheckResult['primaryCode']
      if (!ctx.resolve(op.slug)) { errors.push(notFoundError(op.slug)); primaryCode = 'NOT_FOUND' }
      if (!ctx.existsAnywhere(op.target)) errors.push(`Target '${op.target}' does not exist`)
      else if (!primaryCode && op.relation === 'parent') {
        const cycle = parentCycleError(op.slug, op.target, ctx)
        if (cycle) errors.push(cycle)
      }
      if (!primaryCode) {
        const links = ctx.linksOf(op.slug)
        const after = op.relation === 'parent'
          ? { ...links, parent: op.target }
          : { ...links, related: [...(links.related ?? []).filter(r => r !== op.target), op.target] }
        errors.push(...parentSubsumesErrors(op.slug, after, ctx))
        simulateLinkChange(op.slug, links, after, ctx)
      }
      return { slug: op.slug, errors, primaryCode }
    },
  },
  {
    name: 'unlink',
    op: 'unlink',
    schema: UnlinkBranch,
    description: 'Remove a parent or related link. A same-kind related link is dropped from both files, a legacy one-way edge from whichever file carries it.',
    exampleInclude: [],
    check(op: Extract<BatchOperation, { op: 'unlink' }>, ctx) {
      const errors: string[] = []
      let primaryCode: OpCheckResult['primaryCode']
      if (!ctx.resolve(op.slug)) { errors.push(notFoundError(op.slug)); primaryCode = 'NOT_FOUND' }
      else {
        const links = ctx.linksOf(op.slug)
        simulateLinkChange(op.slug, links, op.relation === 'parent'
          ? { ...links, parent: links.parent === op.target ? undefined : links.parent }
          : { ...links, related: links.related?.filter(r => r !== op.target) }, ctx)
        // A legacy one-way edge may live on the target alone: the dropper
        // takes it there too.
        if (op.relation === 'related' && !links.related?.includes(op.target)) simulateBackEdges(op.slug, [op.target], [], ctx)
      }
      return { slug: op.slug, errors, primaryCode }
    },
  },
  {
    name: 'promote',
    op: 'promote',
    schema: PromoteBranch,
    description: 'Promote a capture to entity/project/knowledge, or an entity to project.',
    exampleInclude: [],
    check(op: Extract<BatchOperation, { op: 'promote' }>, ctx) {
      const errors: string[] = []
      let primaryCode: OpCheckResult['primaryCode']
      const cur = ctx.resolve(op.slug)
      if (!cur) { errors.push(notFoundError(op.slug)); primaryCode = 'NOT_FOUND' }
      else {
        const currentType = cur.kind === 'knowledge' ? 'knowledge' : cur.type
        try {
          const contract = getContract(currentType)
          if (!contract.canPromoteTo.includes(op.target)) {
            errors.push(`Cannot promote ${currentType} to ${op.target}. Valid targets: ${contract.canPromoteTo.join(', ') || 'none (terminal type)'}`)
          } else {
            ctx.simulate(op.slug, op.target === 'knowledge' ? { kind: 'knowledge', type: 'knowledge' } : { kind: 'entity', type: op.target })
            // A promoted knowledge note keeps related but not parent.
            if (op.target === 'knowledge') ctx.simulateLinks(op.slug, { related: ctx.linksOf(op.slug).related })
          }
        } catch (err) { pushErr(errors, err) }
      }
      return { slug: op.slug, errors, primaryCode }
    },
  },
  {
    name: 'delete',
    op: 'delete',
    schema: DeleteBranch,
    description: 'Delete a knowledge or session note. An entity is never deleted — retire it with `hafez update <slug> --status done`. The back-edges the note owns (a knowledge note in its own related that names it back) are dropped with it, in the same commit. Rejected while any other entity or knowledge note links to the note (parent/related): unlink or re-point those first — an earlier op in the same batch counts.',
    exampleInclude: [],
    addressesSessions: true,
    check(op: Extract<BatchOperation, { op: 'delete' }>, ctx) {
      const errors: string[] = []
      let primaryCode: OpCheckResult['primaryCode']
      const target = ctx.resolve(op.slug)
      const session = ctx.sessionExists(op.slug)
      if (target?.kind === 'entity') {
        errors.push(`'${op.slug}' is an entity (${target.type}) — an entity is never deleted; retire it with \`hafez update ${op.slug} --status done\``)
      } else if (target && session) {
        errors.push(`'${op.slug}' is ambiguous — it names both a knowledge note and a session note, and delete will not guess which`)
      } else if (!target && !session) {
        errors.push(notFoundError(op.slug)); primaryCode = 'NOT_FOUND'
      } else {
        // Only knowledge can be linked to: a parent/related slug must name an
        // entity or knowledge note, never a session. A same-kind back-edge
        // the note owns — a note in its own related that names it back — is
        // the other end of its edge, dropped with it (#243), not a blocker.
        const own = target ? ctx.linksOf(op.slug).related ?? [] : []
        const referrers = target
          ? ctx.referrers(op.slug).filter(r => !(own.includes(r) && ctx.resolve(r)?.kind === target.kind))
          : []
        if (referrers.length > 0) {
          errors.push(`'${op.slug}' is still linked from ${referrers.join(', ')} (parent/related) — unlink or re-point those first; an earlier op in the same batch counts`)
        } else {
          if (target) simulateBackEdges(op.slug, own, [], ctx)
          ctx.simulateDelete(op.slug, target ? 'knowledge' : 'session')
        }
      }
      return { slug: op.slug, errors, primaryCode }
    },
  },
] as const satisfies readonly OpSpec[]

/** Every op the table defines. The Apply table (src/apply.ts) is keyed by this
 * union, so a spec row added here without an apply arm fails to build. */
export type OpSpecName = (typeof OP_SPEC_ROWS)[number]['name']

export const OP_SPECS: readonly (OpSpec & { name: OpSpecName })[] = OP_SPEC_ROWS

/** Find the spec for a (shape-valid) operation. */
export function specFor(op: BatchOperation): OpSpec & { name: OpSpecName } {
  const spec = OP_SPECS.find(s => s.op === op.op && (s.kind === undefined || s.kind === (op as { kind?: string }).kind))
  if (!spec) throw new HafezError('VALIDATION_FAILED', `Unknown batch op: ${(op as { op?: string }).op}`)
  return spec
}

/** Op names for error text ("expected one of […]") — derived, never hardcoded. */
export function validOpNames(): string[] {
  return [...new Set(OP_SPECS.map(s => s.op))]
}

/** Ops whose payload addresses an existing file by `slug` — derived from the
 * Zod shapes, so a new slug-bearing op picks up slug-level rules (the
 * NOT_FOUND precedence on shape failure in validateBatchCore) without a
 * hand-kept list. */
export function slugBearingOpNames(): string[] {
  return [...new Set(OP_SPECS
    .filter(s => {
      const shape = (s.schema as { shape?: Record<string, unknown> }).shape
      return shape !== undefined && 'slug' in shape
    })
    .map(s => s.op))]
}

/** Slug-bearing ops whose slug may name a session note — a missing entity
 * or knowledge note alone is not NOT_FOUND for them. */
export function sessionAddressingOpNames(): string[] {
  return OP_SPECS.filter(s => s.addressesSessions).map(s => s.op)
}

/** Create kinds for error text — derived from the table. */
export function validCreateKinds(): string[] {
  return OP_SPECS.filter(s => s.op === 'create' && s.kind).map(s => s.kind!)
}

// src/batch-ops.ts
// The Op Spec (see CONTEXT.md): one table defining every batch operation —
// shape (Zod), semantic check, description, and example hints — from which
// validation, error text, and schema introspection all derive. Adding an op
// means adding one entry here.
import { z } from 'zod'
import type { BatchOperation, CreateEntityFields, CreateKnowledgeFields, SessionLogEntry, UpdateFields } from './types.js'
import {
  ENTITY_TYPES,
  ENTITY_STATUSES,
  SESSION_LOG_TYPES,
  CONFIDENCE_LEVELS,
  VALID_SUBTYPES,
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

export const CreateEntityFieldsSchema = z.object({
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
  add_actions: z.array(z.string()).optional(),
}).strict()

export const CreateKnowledgeFieldsSchema = z.object({
  subtype: z.enum([...VALID_SUBTYPES] as [string, ...string[]]).optional(),
  synthesis: z.string().optional(),
  insight: z.string().optional(),
  description: z.string().optional(),
  domain: z.array(z.string()).optional(),
  related: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  'session-date': z.string().optional(),
}).strict()

export const CreateSessionFieldsSchema = z.object({
  synthesis: z.string().optional(),
  insight: z.string().optional(),
  related: z.array(z.string()).optional(),
  'session-date': z.string().optional(),
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
])

// --- Semantic checks ---

/** Vault context handed to each spec's semantic check by validateBatchCore.
 * Simulation-aware: creates earlier in the batch count as existing. */
export interface OpCheckContext {
  resolve(slug: string): { kind: 'entity' | 'knowledge'; type: string } | null
  existsAnywhere(slug: string): boolean
  sessionExists(slug: string): boolean
  simulate(slug: string, info: { kind: 'entity' | 'knowledge'; type: string }): void
  simulateSession(slug: string): void
  validateKindFields(kind: 'entity' | 'knowledge', fields: UpdateFields): void
  validateSessionLogEntry(entry: SessionLogEntry): string[]
  buildEntityFrontmatter(name: string, fields: CreateEntityFields): void
  buildKnowledgeFrontmatter(name: string, fields: CreateKnowledgeFields): void
}

export interface OpCheckResult {
  slug: string
  errors: string[]
  created?: boolean
  warning?: string
}

function pushErr(errors: string[], err: unknown): void {
  const e = err as HafezError
  errors.push(e.details?.length ? `${e.message}: ${e.details.join('; ')}` : e.message)
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
  exampleInclude: string[]
  check(op: any, ctx: OpCheckContext): OpCheckResult
}

export const OP_SPECS: OpSpec[] = [
  {
    name: 'update',
    op: 'update',
    schema: UpdateBranch,
    description: 'Update an entity or knowledge note (status, brief, next actions, session log, synthesis, …).',
    exampleInclude: ['status'],
    check(op: Extract<BatchOperation, { op: 'update' }>, ctx) {
      const errors: string[] = []
      const target = ctx.resolve(op.slug)
      if (!target) errors.push(`'${op.slug}' not found`)
      else {
        try { ctx.validateKindFields(target.kind, op.fields) } catch (err) { pushErr(errors, err) }
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
      return { slug: op.slug, errors }
    },
  },
  {
    name: 'create-entity',
    op: 'create',
    kind: 'entity',
    schema: CreateEntityBranch,
    description: 'Create a new entity (capture / entity / project).',
    exampleInclude: ['type'],
    check(op: Extract<BatchOperation, { op: 'create'; kind: 'entity' }>, ctx) {
      const errors: string[] = []
      const slug = slugify(op.name)
      if (ctx.existsAnywhere(slug)) errors.push(`Slug '${slug}' already exists`)
      try { ctx.buildEntityFrontmatter(op.name, op.fields) } catch (err) { pushErr(errors, err) }
      ctx.simulate(slug, { kind: 'entity', type: op.fields.type })
      return { slug, errors, created: errors.length === 0 }
    },
  },
  {
    name: 'create-knowledge',
    op: 'create',
    kind: 'knowledge',
    schema: CreateKnowledgeBranch,
    description: 'Create a new knowledge note (insight / plan subtype).',
    exampleInclude: ['subtype', 'synthesis'],
    check(op: Extract<BatchOperation, { op: 'create'; kind: 'knowledge' }>, ctx) {
      const errors: string[] = []
      const slug = slugify(op.name)
      if (ctx.existsAnywhere(slug)) errors.push(`Slug '${slug}' already exists`)
      try { ctx.buildKnowledgeFrontmatter(op.name, (op.fields || {}) as CreateKnowledgeFields) } catch (err) { pushErr(errors, err) }
      ctx.simulate(slug, { kind: 'knowledge', type: 'knowledge' })
      return { slug, errors, created: errors.length === 0 }
    },
  },
  {
    name: 'create-session',
    op: 'create',
    kind: 'session',
    schema: CreateSessionBranch,
    description: 'Create a new session note linked to an entity.',
    exampleInclude: ['synthesis'],
    check(op: Extract<BatchOperation, { op: 'create'; kind: 'session' }>, ctx) {
      const slug = slugify(op.name)
      if (ctx.existsAnywhere(slug) || ctx.sessionExists(slug)) {
        return { slug, errors: [], warning: `session '${slug}' already exists — op will be skipped (batch continues)` }
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
      if (ctx.existsAnywhere(slug)) errors.push(`Slug '${slug}' already exists`)
      ctx.simulate(slug, { kind: 'entity', type: 'capture' })
      return { slug, errors, created: errors.length === 0 }
    },
  },
  {
    name: 'link',
    op: 'link',
    schema: LinkBranch,
    description: 'Add a parent or related link between two entities.',
    exampleInclude: [],
    check(op: Extract<BatchOperation, { op: 'link' }>, ctx) {
      const errors: string[] = []
      if (!ctx.resolve(op.slug)) errors.push(`'${op.slug}' not found`)
      if (!ctx.existsAnywhere(op.target)) errors.push(`Target '${op.target}' does not exist`)
      return { slug: op.slug, errors }
    },
  },
  {
    name: 'unlink',
    op: 'unlink',
    schema: UnlinkBranch,
    description: 'Remove a parent or related link between two entities.',
    exampleInclude: [],
    check(op: Extract<BatchOperation, { op: 'unlink' }>, ctx) {
      const errors: string[] = []
      if (!ctx.resolve(op.slug)) errors.push(`'${op.slug}' not found`)
      return { slug: op.slug, errors }
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
      const cur = ctx.resolve(op.slug)
      if (!cur) errors.push(`'${op.slug}' not found`)
      else {
        const currentType = cur.kind === 'knowledge' ? 'knowledge' : cur.type
        try {
          const contract = getContract(currentType)
          if (!contract.canPromoteTo.includes(op.target)) {
            errors.push(`Cannot promote ${currentType} to ${op.target}. Valid targets: ${contract.canPromoteTo.join(', ') || 'none (terminal type)'}`)
          } else {
            ctx.simulate(op.slug, op.target === 'knowledge' ? { kind: 'knowledge', type: 'knowledge' } : { kind: 'entity', type: op.target })
          }
        } catch (err) { pushErr(errors, err) }
      }
      return { slug: op.slug, errors }
    },
  },
]

/** Find the spec for a (shape-valid) operation. */
export function specFor(op: BatchOperation): OpSpec {
  const spec = OP_SPECS.find(s => s.op === op.op && (s.kind === undefined || s.kind === (op as { kind?: string }).kind))
  if (!spec) throw new HafezError('VALIDATION_FAILED', `Unknown batch op: ${(op as { op?: string }).op}`)
  return spec
}

/** Op names for error text ("expected one of […]") — derived, never hardcoded. */
export function validOpNames(): string[] {
  return [...new Set(OP_SPECS.map(s => s.op))]
}

/** Create kinds for error text — derived from the table. */
export function validCreateKinds(): string[] {
  return OP_SPECS.filter(s => s.op === 'create' && s.kind).map(s => s.kind!)
}

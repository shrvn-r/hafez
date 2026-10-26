import type { KnowledgeSubtype, UpdateFields } from './types.js'

// --- Canonical enum tuples (single source of truth) ---
// Every consumer (file validators, the Op Spec table, help renderer, and the
// enum unions in types.ts) imports these — no other file may declare local
// copies, and the contracts below are built out of them rather than beside
// them.

export const ENTITY_TYPES = ['capture', 'entity', 'project'] as const
export const ENTITY_STATUSES = ['active', 'paused', 'done'] as const
export const SESSION_LOG_TYPES = ['progress', 'decision', 'blocker', 'research'] as const
export const CONFIDENCE_LEVELS = ['observation', 'pattern', 'principle'] as const

// 'insight' is the subtype (frontmatter classification), 'Synthesis' is the section heading.
// The rename was insight→synthesis for the section/field only; the subtype stays 'insight'.
export const VALID_SUBTYPES = ['insight', 'plan'] as const

/** The Graph's layers whose nodes are synthetic, one per distinct value
 * (`<layer>:<value>`); each adds the edge relation of the same name. */
export const SYNTHETIC_LAYERS = ['tag', 'domain'] as const
/** The Graph's optional layers (#253): tag and domain nodes, Session nodes. */
export const GRAPH_LAYERS = [...SYNTHETIC_LAYERS, 'session'] as const
/** The Graph's edges between notes; the synthetic layers add their own. */
export const GRAPH_NOTE_RELATIONS = ['parent', 'related', 'mention'] as const
/** What a write did to a note, as history tells it (changesSince, #258). */
export const CHANGE_OPS = ['create', 'update', 'delete'] as const

export interface TypeContract {
  type: string
  description: string
  kind: 'item' | 'knowledge'
  requiredFields: string[]
  optionalFields: string[]
  validStatuses: string[]
  defaultSections: string[]
  optionalSections: string[]
  canPromoteTo: string[]
}

/** The item frontmatter contract, shared by all three item types — they
 * differ in sections and lifecycle, never in which fields are mandatory.
 * schema.validateEntityFrontmatter enforces exactly this list (parity test in
 * tests/contracts.test.ts). */
const ITEM_REQUIRED = ['name', 'type', 'status', 'created', 'last-touched']
/** Optional frontmatter for the types that can sit in a hierarchy. A capture
 * has not been triaged yet, so it carries neither links nor staleness. */
const ITEM_OPTIONAL = ['domain', 'parent', 'related', 'tags', 'staleness-days']

const CAPTURE: TypeContract = {
  type: 'capture',
  description: 'Quick capture. A link, a thought, a bug report. No structure required — just get it in.',
  kind: 'item',
  requiredFields: ITEM_REQUIRED,
  optionalFields: ['domain', 'tags'],
  // A capture is triage-stage: it is either open or dealt with, never paused.
  validStatuses: ENTITY_STATUSES.filter(s => s !== 'paused'),
  defaultSections: ['Notes'],
  // Brief/Next Actions: the CLI never type-gated setBrief/addNextAction, so captures
  // carrying a delivery brief and actions are established practice — the contract
  // follows observed behaviour (decided 2026-07-19). Current State likewise:
  // update --current-state is kind-gated, not type-gated, so captures can carry
  // it — omitting it here made the heading non-structural under the per-type
  // Document binding and a later Brief rewrite silently deleted the section.
  optionalSections: ['Session Log', 'Brief', 'Next Actions', 'Current State'],
  canPromoteTo: ['entity', 'project', 'knowledge'],
}

const ENTITY: TypeContract = {
  type: 'entity',
  description: 'Tracked work with substance. A bug, feature, decision, or task. The atomic unit of work.',
  kind: 'item',
  requiredFields: ITEM_REQUIRED,
  optionalFields: ITEM_OPTIONAL,
  validStatuses: [...ENTITY_STATUSES],
  defaultSections: ['Context', 'Session Log'],
  optionalSections: ['Brief', 'Next Actions', 'Current State'],
  canPromoteTo: ['project'],
}

const PROJECT: TypeContract = {
  type: 'project',
  description: 'Scoped effort with goals and deliverables. Can have children. Can be finite or perpetual.',
  kind: 'item',
  requiredFields: ITEM_REQUIRED,
  optionalFields: ITEM_OPTIONAL,
  validStatuses: [...ENTITY_STATUSES],
  defaultSections: ['Purpose', 'Goals', 'Session Log'],
  optionalSections: ['Brief', 'Next Actions', 'Current State', 'Open Questions'],
  canPromoteTo: [],
}

const KNOWLEDGE: TypeContract = {
  type: 'knowledge',
  description: 'Insight or plan. Searchable, linkable, timestamped. Insights mature through reinforcement.',
  kind: 'knowledge',
  requiredFields: ['name', 'created'],
  optionalFields: ['subtype', 'domain', 'related', 'tags', 'confidence', 'reinforcement-count', 'last-reinforced', 'session-date', 'status', 'last-touched'],
  validStatuses: [],
  defaultSections: ['Synthesis', 'Evidence', 'Sources'],
  optionalSections: [],
  canPromoteTo: [],
}

const CONTRACT_MAP: Record<string, TypeContract> = {
  capture: CAPTURE,
  entity: ENTITY,
  project: PROJECT,
  knowledge: KNOWLEDGE,
}

export const ALL_CONTRACTS: TypeContract[] = [CAPTURE, ENTITY, PROJECT, KNOWLEDGE]

export function getContract(type: string): TypeContract {
  const contract = CONTRACT_MAP[type]
  if (!contract) throw new Error(`Unknown type: ${type}. Valid types: ${Object.keys(CONTRACT_MAP).join(', ')}`)
  return contract
}

/** Every section a type's contract declares, default and optional alike —
 * the one place the two lists are concatenated (sectionsFor and hasCapability
 * both answer from it). */
function contractSections(type: string): string[] {
  const contract = getContract(type)
  return [...contract.defaultSections, ...contract.optionalSections]
}

export function hasCapability(type: string, section: string): boolean {
  return contractSections(type).includes(section)
}

/** A knowledge note with no persisted subtype is an insight — the one place
 * that default lives. Every consumer (templates, index rows, exports) reads
 * it from here so classification can't drift between surfaces. */
export const DEFAULT_KNOWLEDGE_SUBTYPE = 'insight' as const

// --- Alias table ---
// Declared-alias fields, keyed by the op path they may appear on and mapped to
// their canonical name. The Op Spec layer (normalizeAliases in batch-ops.ts)
// normalizes them once, before validation, so every entry point applies the same
// canonical op; an op path absent from this table (create.entity.fields.insight)
// is the kind gate — the strict shape rejects the alias there.
// schema-introspect cannot infer these from Zod alone (both are declared .optional()),
// so rendering code reads this table to strip aliased keys from user-facing output.
export const ALIAS_KEYS = {
  'update.fields.insight': 'synthesis',
  'create.knowledge.fields.insight': 'synthesis',
  'create.session.fields.insight': 'synthesis',
} as const

export const SUBTYPE_SECTIONS: Record<KnowledgeSubtype, string[]> = {
  insight: ['Synthesis', 'Evidence', 'Sources'],
  plan: ['Goal', 'Steps', 'Dependencies'],
}

/** Sections whose content only ever grows — sync merges union their lines
 * instead of letting the newer side replace the older (see merge.ts). */
export const APPEND_ONLY_SECTIONS: ReadonlySet<string> = new Set(['Evidence', 'Sources'])

/** Session-file sections. Sessions have no TypeContract (they are not typed
 * entities), but their headings are still structural for Document splitting. */
export const SESSION_SECTIONS = ['Summary', 'Entities Touched', 'Decisions'] as const

/** Statuses a plan-subtype knowledge note may carry. Plans are tracked work
 * with a lifecycle; the file validator and the mutation gate read this one
 * tuple so they cannot drift. */
export const PLAN_STATUSES = ['active', 'done'] as const

/** Statuses by knowledge subtype. An empty list means `status` is not part of
 * that subtype's contract at all — mutations setting it are rejected. */
export const SUBTYPE_STATUSES: Record<KnowledgeSubtype, readonly string[]> = {
  insight: [],
  plan: PLAN_STATUSES,
}

/** What a mutation is aimed at — enough to answer "does this document's
 * contract have that field / that section?". Knowledge capabilities are
 * subtype-level (plans and insights have different bodies and lifecycles),
 * entity capabilities are type-level. */
export type DocTarget =
  | { kind: 'entity'; type: string }
  | { kind: 'knowledge'; subtype?: KnowledgeSubtype }

/** Sections a document of this shape can carry — the one answer to "would
 * text written into section X survive on this document?". */
export function sectionsFor(target: DocTarget): string[] {
  if (target.kind === 'knowledge') {
    return [...SUBTYPE_SECTIONS[target.subtype ?? DEFAULT_KNOWLEDGE_SUBTYPE]]
  }
  return contractSections(target.type)
}

/** Statuses this document may carry. Empty ⇒ `status` is not a field of its
 * contract, so setting it is a validation error. */
export function statusesFor(target: DocTarget): readonly string[] {
  return target.kind === 'knowledge'
    ? SUBTYPE_STATUSES[target.subtype ?? DEFAULT_KNOWLEDGE_SUBTYPE]
    : getContract(target.type).validStatuses
}

/** Create-op fields that write their text into a named body section. The
 * chosen template decides whether that section exists; when it doesn't, the
 * text has nowhere to land, so the op is rejected (see `unreachableFields`).
 * Update-op content fields are absent on purpose — `setSection` /
 * `appendToSection` create a missing section, so update never loses text. */
export const CREATE_FIELD_SECTIONS: Record<string, string> = {
  purpose: 'Purpose',
  notes: 'Notes',
  brief: 'Brief',
  add_action: 'Next Actions',
  add_actions: 'Next Actions',
  synthesis: 'Synthesis',
}

/** Fields present in `fields` whose target section this document cannot hold.
 * Policy is reject-never-route: text is never silently dropped and never
 * redirected into a section the caller did not name. */
export function unreachableFields(
  target: DocTarget,
  fields: Record<string, unknown>,
): Array<{ field: string; section: string }> {
  const available = new Set(sectionsFor(target))
  return Object.entries(CREATE_FIELD_SECTIONS)
    .filter(([field, section]) => fields[field] !== undefined && !available.has(section))
    .map(([field, section]) => ({ field, section }))
}

/** Human label for a target, used in every gate's error text. */
export function describeTarget(target: DocTarget): string {
  return target.kind === 'entity'
    ? `type '${target.type}'`
    : `knowledge subtype '${target.subtype ?? DEFAULT_KNOWLEDGE_SUBTYPE}'`
}

// --- The read Footer's Write Line ---

/** Which Footer a document's `read` ends with. Entity and project share one;
 * a capture's is the promote line, since it is sorted before it is written to. */
export type FooterForm = 'entity' | 'insight' | 'plan' | 'capture'

export function footerForm(target: DocTarget): FooterForm {
  if (target.kind === 'knowledge') return target.subtype ?? DEFAULT_KNOWLEDGE_SUBTYPE
  return target.type === 'capture' ? 'capture' : 'entity'
}

/** The update fields each Footer names, in the order it names them. Every
 * other field that contract's update accepts is in WRITE_LINE_OMITS with its
 * reason; drift check 3 (tests/read-footer.test.ts) holds the two together
 * against the Op Spec update shape and the kind gate. */
export const WRITE_LINE_FIELDS = {
  entity: ['session_log', 'complete_action', 'remove_action', 'add_actions', 'brief', 'current_state', 'related', 'parent'],
  insight: ['add_evidence', 'add_source', 'synthesis', 'confidence', 'domain', 'related'],
  plan: ['status', 'domain', 'related'],
} as const satisfies Record<Exclude<FooterForm, 'capture'>, readonly (keyof UpdateFields)[]>

export type WriteLineField = (typeof WRITE_LINE_FIELDS)[keyof typeof WRITE_LINE_FIELDS][number]

const SET_AT_CREATE = 'set at create, rarely rewritten; `hafez schema update` has it'
const INSIGHT_ALIAS = 'an alias of synthesis'
const PLAN_BODY = 'a plan\'s body is Goal, Steps and Dependencies, which no op writes'

/** Update fields a contract accepts that its Footer leaves out, and why. */
export const WRITE_LINE_OMITS: Record<Exclude<FooterForm, 'capture'>, Partial<Record<keyof UpdateFields, string>>> = {
  entity: {
    status: 'a lifecycle change, not a write-back: the `hafez` skill\'s rare ops carry the status line',
    agent: 'detected from the Harness; the override is never shown',
    add_action: 'the one-line form of add_actions, written by the same flag',
    complete_actions: 'the repeated form of complete_action, written by the same flag',
    remove_actions: 'the repeated form of remove_action, written by the same flag',
    clear_actions: 'drops lines unseen; the Footer drops one line by its Handle',
    description: SET_AT_CREATE,
    resource: 'added where the hook\'s no-match line asks; shown on every read it would attach unrelated folders',
    domain: SET_AT_CREATE,
    tags: SET_AT_CREATE,
  },
  insight: {
    insight: INSIGHT_ALIAS,
    description: SET_AT_CREATE,
    tags: SET_AT_CREATE,
  },
  plan: {
    synthesis: PLAN_BODY,
    add_evidence: PLAN_BODY,
    add_source: PLAN_BODY,
    insight: INSIGHT_ALIAS,
    confidence: 'an insight matures by confidence; a plan moves by status',
    description: SET_AT_CREATE,
    tags: SET_AT_CREATE,
  },
}

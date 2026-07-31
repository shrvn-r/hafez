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

const CAPTURE: TypeContract = {
  type: 'capture',
  description: 'Quick capture. A link, a thought, a bug report. No structure required — just get it in.',
  kind: 'item',
  requiredFields: ['name', 'type', 'status', 'created', 'last-touched'],
  optionalFields: ['domain', 'tags'],
  validStatuses: ['active', 'done'],
  defaultSections: ['Notes'],
  // Brief/Next Actions: the CLI never type-gated setBrief/addNextAction, so captures
  // carrying a delivery brief and actions are established practice — the contract
  // follows observed behaviour (decided 2026-07-19).
  optionalSections: ['Session Log', 'Brief', 'Next Actions'],
  canPromoteTo: ['entity', 'project', 'knowledge'],
}

const ENTITY: TypeContract = {
  type: 'entity',
  description: 'Tracked work with substance. A bug, feature, decision, or task. The atomic unit of work.',
  kind: 'item',
  requiredFields: ['name', 'type', 'status', 'created', 'last-touched'],
  optionalFields: ['domain', 'parent', 'related', 'tags', 'staleness-days'],
  validStatuses: ['active', 'paused', 'done'],
  defaultSections: ['Context', 'Session Log'],
  optionalSections: ['Brief', 'Next Actions', 'Current State'],
  canPromoteTo: ['project'],
}

const PROJECT: TypeContract = {
  type: 'project',
  description: 'Scoped effort with goals and deliverables. Can have children. Can be finite or perpetual.',
  kind: 'item',
  requiredFields: ['name', 'type', 'status', 'created', 'last-touched'],
  optionalFields: ['domain', 'parent', 'related', 'tags', 'staleness-days'],
  validStatuses: ['active', 'paused', 'done'],
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

export function hasCapability(type: string, section: string): boolean {
  const contract = getContract(type)
  return contract.defaultSections.includes(section) || contract.optionalSections.includes(section)
}

import type { KnowledgeSubtype } from './types.js'

// --- Canonical enum tuples (single source of truth) ---
// Every consumer (file validators, CLI input validator, help renderer) imports these.
// The cli-schema-parity test enforces that no other file declares local copies.

export const ENTITY_TYPES = ['capture', 'entity', 'project'] as const
export const ENTITY_STATUSES = ['active', 'paused', 'done'] as const
export const SESSION_LOG_TYPES = ['progress', 'decision', 'blocker', 'research'] as const
export const CONFIDENCE_LEVELS = ['observation', 'pattern', 'principle'] as const

// 'insight' is the subtype (frontmatter classification), 'Synthesis' is the section heading.
// The rename was insight→synthesis for the section/field only; the subtype stays 'insight'.
export const VALID_SUBTYPES = ['insight', 'plan'] as const

// --- Alias table ---
// Declared-alias fields that parseBatchInput normalizes to their canonical name.
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

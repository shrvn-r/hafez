// src/schema.ts

import {
  ENTITY_TYPES,
  ENTITY_STATUSES,
  CONFIDENCE_LEVELS,
  SESSION_LOG_TYPES,
  VALID_SUBTYPES,
  PLAN_STATUSES,
} from './contracts.js'

export function validateEntityFrontmatter(fm: Record<string, any>): string[] {
  const errors: string[] = []
  if (!fm.name || typeof fm.name !== 'string') errors.push('missing required field: name')
  if (!fm.type || !ENTITY_TYPES.includes(fm.type)) errors.push(`invalid type: ${fm.type} (expected: ${ENTITY_TYPES.join(', ')})`)
  if (!fm.status || !ENTITY_STATUSES.includes(fm.status)) errors.push(`invalid status: ${fm.status} (expected: ${ENTITY_STATUSES.join(', ')})`)
  if (!fm.created) errors.push('missing required field: created')
  if (!fm['last-touched']) errors.push('missing required field: last-touched')
  if (fm.domain !== undefined && !Array.isArray(fm.domain)) errors.push('entity domain must be an array')
  if (fm.resource != null && !(Array.isArray(fm.resource) && fm.resource.every((v: unknown) => typeof v === 'string' && v !== ''))) {
    errors.push('entity resource must be a list of non-empty strings')
  }
  return errors
}

export function validateKnowledgeFrontmatter(fm: Record<string, any>): string[] {
  const errors: string[] = []
  if (!fm.name || typeof fm.name !== 'string') errors.push('missing required field: name')
  if (!fm.created) errors.push('missing required field: created')
  if (fm.confidence && !CONFIDENCE_LEVELS.includes(fm.confidence)) {
    errors.push(`invalid confidence: ${fm.confidence} (expected: ${CONFIDENCE_LEVELS.join(', ')})`)
  }
  if (fm.domain !== undefined && !Array.isArray(fm.domain)) errors.push('knowledge domain must be an array')
  errors.push(...validateKnowledgeSubtype(fm))
  return errors
}

/** A session note: its name and created stamp, nothing else is required. */
export function validateSessionFrontmatter(fm: Record<string, any>): string[] {
  const errors: string[] = []
  if (!fm.name || typeof fm.name !== 'string') errors.push('missing required field: name')
  if (!fm.created) errors.push('missing required field: created')
  if (fm.related !== undefined && !Array.isArray(fm.related)) errors.push('session related must be an array')
  return errors
}

export function validateKnowledgeSubtype(fm: Record<string, any>): string[] {
  const errors: string[] = []
  if (fm.subtype && !VALID_SUBTYPES.includes(fm.subtype)) {
    errors.push(`invalid subtype: ${fm.subtype} (expected: ${VALID_SUBTYPES.join(', ')})`)
  }
  // Plan-specific: status must be one of the plan lifecycle statuses
  if (fm.subtype === 'plan' && fm.status && !PLAN_STATUSES.includes(fm.status)) {
    errors.push(`invalid plan status: ${fm.status} (expected: ${PLAN_STATUSES.join(', ')})`)
  }
  return errors
}

export function validateSlugReference(slug: string, field: string, exists: (s: string) => boolean): string | null {
  if (!exists(slug)) return `${field} reference '${slug}' does not exist`
  return null
}

export function validateSessionLogEntry(entry: { type?: string; summary?: string; agent?: string }): string[] {
  const errors: string[] = []
  if (!entry.type || !SESSION_LOG_TYPES.includes(entry.type as any)) {
    errors.push(`invalid session log type: ${entry.type} (expected: ${SESSION_LOG_TYPES.join(', ')})`)
  }
  if (!entry.summary || typeof entry.summary !== 'string') errors.push('session log entry must have a summary')
  if (!entry.agent || typeof entry.agent !== 'string') errors.push('session log entry must have an agent')
  return errors
}

// src/templates.ts
import type { EntityType, KnowledgeSubtype } from './types.js'
import { SUBTYPE_SECTIONS } from './contracts.js'

const ITEM_TEMPLATES: Record<EntityType, string[]> = {
  capture: ['## Notes'],
  entity: ['## Context', '## Session Log'],
  project: ['## Purpose', '## Goals', '## Session Log'],
}

export function bodyTemplate(type: EntityType, fields?: { purpose?: string; notes?: string }): string {
  const sections = ITEM_TEMPLATES[type]
  if (!sections) throw new Error(`Unknown item type: ${type}`)
  const lines: string[] = []
  for (const section of sections) {
    lines.push(section)
    if (section === '## Purpose' && fields?.purpose) {
      lines.push('', fields.purpose)
    }
    if (section === '## Notes' && fields?.notes) {
      lines.push('', fields.notes)
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function knowledgeBodyTemplate(subtype?: KnowledgeSubtype, fields?: { synthesis?: string }): string {
  if ((subtype as string) === 'session') {
    throw new Error(
      "subtype 'session' is no longer supported for knowledge notes. " +
      "Use batch kind: 'session' instead. See knowledge-v2 migration."
    )
  }
  const sections = SUBTYPE_SECTIONS[subtype ?? 'insight']
  const lines: string[] = []
  for (const section of sections) {
    lines.push(`## ${section}`)
    if ((section === 'Synthesis' || section === 'Summary') && fields?.synthesis) {
      lines.push('', fields.synthesis)
    }
    lines.push('')
  }
  return lines.join('\n')
}

// src/cli/format.ts
import type { QueryResult, KnowledgeQueryResult, ValidationReport, SearchResult, VaultStats, ChangelogEntry } from '../types.js'

export function formatEntityHeader(fm: Record<string, any>, body: string): string {
  const lines: string[] = [`# ${fm.name}`]
  if (fm.description) lines.push(`> ${fm.description}`)

  const meta: string[] = []
  if (fm.status) meta.push(`status: ${fm.status}`)
  if (fm.type) meta.push(`type: ${fm.type}`)
  if (fm.domain?.length) meta.push(`domain: ${fm.domain.join(', ')}`)
  if (meta.length) lines.push(meta.join(' | '))

  const meta2: string[] = []
  if (fm.parent) meta2.push(`parent: ${fm.parent}`)
  if (fm['last-touched']) meta2.push(`last-touched: ${fm['last-touched']}`)
  if (fm.created) meta2.push(`created: ${fm.created}`)
  if (meta2.length) lines.push(meta2.join(' | '))

  if (fm.related?.length) lines.push(`related: ${fm.related.join(', ')}`)
  if (fm.tags?.length) lines.push(`tags: ${fm.tags.join(', ')}`)
  if (fm.resource) lines.push(`resource: ${fm.resource}`)

  lines.push('')
  lines.push(body)
  return lines.join('\n')
}

export function formatKnowledgeHeader(fm: Record<string, any>, body: string): string {
  const lines: string[] = [`# ${fm.name}`]
  if (fm.description) lines.push(`> ${fm.description}`)

  const meta: string[] = []
  if (fm.confidence) meta.push(`confidence: ${fm.confidence}`)
  if (fm.domain?.length) meta.push(`domain: ${Array.isArray(fm.domain) ? fm.domain.join(', ') : fm.domain}`)
  if (meta.length) lines.push(meta.join(' | '))

  const meta2: string[] = []
  if (fm['reinforcement-count'] != null) meta2.push(`reinforcement-count: ${fm['reinforcement-count']}`)
  if (fm['last-reinforced']) meta2.push(`last-reinforced: ${fm['last-reinforced']}`)
  if (meta2.length) lines.push(meta2.join(' | '))

  if (fm.related?.length) lines.push(`related: ${fm.related.join(', ')}`)

  lines.push('')
  lines.push(body)
  return lines.join('\n')
}

export function formatQueryTable(results: QueryResult[], total?: number): string {
  if (results.length === 0) return 'No results.'
  const lines = ['| slug | name | type | status | next-action |', '|------|------|------|--------|-------------|']
  for (const r of results) {
    let actionDisplay = r.next_action ?? ''
    if (r.next_action && r.next_action_count > 1) {
      actionDisplay = `${r.next_action} (+${r.next_action_count - 1} more)`
    }
    lines.push(`| ${r.slug} | ${r.name} | ${r.type} | ${r.status} | ${actionDisplay} |`)
  }
  if (total != null && results.length < total) {
    lines.push(`\nShowing ${results.length} of ${total}`)
  }
  return lines.join('\n')
}

export function formatKnowledgeTable(results: KnowledgeQueryResult[], total?: number): string {
  if (results.length === 0) return 'No results.'
  const lines = ['| slug | name | confidence | domains | reinforcements |', '|------|------|------------|---------|----------------|']
  for (const r of results) {
    lines.push(`| ${r.slug} | ${r.name} | ${r.confidence} | ${r.domain.join(', ')} | ${r.reinforcement_count} |`)
  }
  if (total != null && results.length < total) {
    lines.push(`\nShowing ${results.length} of ${total}`)
  }
  return lines.join('\n')
}

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No results.'

  const entities = results.filter(r => r.kind === 'entity')
  const knowledge = results.filter(r => r.kind === 'knowledge')
  const sections: string[] = []

  if (entities.length > 0) {
    const lines = ['## Entities', '', '| slug | name | type | match |', '|------|------|------|-------|']
    for (const r of entities) lines.push(`| ${r.slug} | ${r.name} | ${r.type ?? ''} | ${r.snippet} |`)
    sections.push(lines.join('\n'))
  }
  if (knowledge.length > 0) {
    const lines = ['## Knowledge', '', '| slug | name | confidence | match |', '|------|------|------------|-------|']
    for (const r of knowledge) lines.push(`| ${r.slug} | ${r.name} | ${r.confidence ?? ''} | ${r.snippet} |`)
    sections.push(lines.join('\n'))
  }
  return sections.join('\n\n')
}

export function formatStats(stats: VaultStats): string {
  const lines: string[] = []

  const totalEntities = stats.counts.active + stats.counts.paused + stats.counts.done
  if (totalEntities === 0 && stats.knowledge_count === 0) {
    lines.push('Vault is empty — run `hafez onboard` for the guided first run (seeding interview + agent integration).')
    lines.push('')
  }

  lines.push('## Status Counts')
  lines.push(`Active: ${stats.counts.active} | Paused: ${stats.counts.paused} | Done: ${stats.counts.done}`)

  lines.push('\n## Type Counts')
  lines.push(`Project: ${stats.by_type.project} | Entity: ${stats.by_type.entity} | Capture: ${stats.by_type.capture}`)

  if (stats.stale.length > 0) {
    lines.push('\n## Stale')
    lines.push('| Slug | Type | Days |')
    lines.push('|------|------|------|')
    for (const s of stats.stale) lines.push(`| ${s.slug} | ${s.type} | ${s.days_since_touched} |`)
  }

  if (stats.no_next_action.length > 0) {
    lines.push('\n## Active Without Next Actions')
    for (const s of stats.no_next_action) lines.push(`- ${s.slug} (${s.type})`)
  }

  lines.push('\n## Recently Touched')
  for (const s of stats.recently_touched) lines.push(`- ${s.slug} (${s.last_touched})`)

  lines.push('\n## Recently Created')
  for (const s of stats.recently_created) lines.push(`- ${s.slug} (${s.created})`)

  return lines.join('\n')
}

export function formatChangelog(entries: ChangelogEntry[]): string {
  if (entries.length === 0) return 'No changes found.'
  const header = '| Slug | Kind | Op | Date | Message |'
  const sep = '|------|------|-----|------|---------|'
  const rows = entries.map(e =>
    `| ${e.slug} | ${e.kind} | ${e.operation} | ${e.timestamp.slice(0, 10)} | ${e.commit_message} |`
  )
  return [header, sep, ...rows].join('\n')
}

export function formatValidation(report: ValidationReport): string {
  const issues = report.broken_slugs.length + report.orphaned_knowledge.length +
                 report.oversized_related.length + report.missing_fields.length

  if (issues === 0) {
    return `Vault OK — ${report.total_entities} entities, ${report.total_knowledge} knowledge, 0 issues`
  }

  const sections: string[] = [`## Vault Validation — ${report.total_entities} entities, ${report.total_knowledge} knowledge`]

  const addSection = (title: string, items: string[]) => {
    if (items.length === 0) return
    sections.push(`\n### ${title} (${items.length})`)
    for (const item of items) sections.push(`- ${item}`)
  }

  addSection('Broken Slugs', report.broken_slugs.map(i => `${i.slug}: ${i.issue}`))
  addSection('Orphaned Knowledge', report.orphaned_knowledge.map(s => `${s} (no related links, not referenced by any entity)`))
  addSection('Oversized Related', report.oversized_related.map(i => `${i.slug}: ${i.issue}`))
  addSection('Missing Fields', report.missing_fields.map(i => `${i.slug}: ${i.issue}`))

  return sections.join('\n')
}

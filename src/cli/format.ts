// src/cli/format.ts
import type { QueryResult, KnowledgeQueryResult, SessionQueryResult, ValidationReport, HealthReport, SearchResult, VaultStats, ChangelogEntry } from '../types.js'
import { ITEMS } from '../surfaces/items.js'

/** `parent` is the rendered value of the `parent:` line (the slug with the
 * parent's description); absent, the slug alone. `pointers` are the lines
 * naming what hangs off the entity elsewhere (its sessions, its archive). */
export function formatEntityHeader(fm: Record<string, any>, body: string, parent: string | undefined = fm.parent, pointers: string[] = []): string {
  const lines: string[] = [`# ${fm.name}`]
  if (fm.description) lines.push(`> ${fm.description}`)

  const meta: string[] = []
  if (fm.status) meta.push(`status: ${fm.status}`)
  if (fm.type) meta.push(`type: ${fm.type}`)
  if (fm.domain?.length) meta.push(`domain: ${fm.domain.join(', ')}`)
  if (meta.length) lines.push(meta.join(' | '))

  // The parent line stands alone: with its description it is a sentence.
  if (parent) lines.push(`parent: ${parent}`)

  const meta2: string[] = []
  if (fm['last-touched']) meta2.push(`last-touched: ${fm['last-touched']}`)
  if (fm.created) meta2.push(`created: ${fm.created}`)
  if (meta2.length) lines.push(meta2.join(' | '))

  if (fm.related?.length) lines.push(`related: ${fm.related.join(', ')}`)
  if (fm.tags?.length) lines.push(`tags: ${fm.tags.join(', ')}`)
  if (fm.resource?.length) lines.push(`resource: ${fm.resource.join(' · ')}`)
  lines.push(...pointers)

  lines.push('')
  lines.push(body)
  return lines.join('\n')
}

/** A session note: its day, then the entities it touched. */
export function formatSessionHeader(fm: Record<string, any>, body: string): string {
  const lines: string[] = [`# ${fm.name}`]
  const meta: string[] = []
  if (fm['session-date']) meta.push(`session-date: ${fm['session-date']}`)
  if (fm.created) meta.push(`created: ${fm.created}`)
  if (meta.length) lines.push(meta.join(' | '))
  if (fm.related?.length) lines.push(`related: ${fm.related.join(', ')}`)
  lines.push('')
  lines.push(body)
  return lines.join('\n')
}

export function formatKnowledgeHeader(fm: Record<string, any>, body: string): string {
  const lines: string[] = [`# ${fm.name}`]
  if (fm.description) lines.push(`> ${fm.description}`)

  // A plan has a lifecycle and no reinforcement: its subtype, status and
  // dates; an insight its confidence and reinforcement.
  const plan = fm.subtype === 'plan'
  const meta: string[] = []
  if (plan) meta.push('subtype: plan')
  if (plan && fm.status) meta.push(`status: ${fm.status}`)
  if (!plan && fm.confidence) meta.push(`confidence: ${fm.confidence}`)
  if (fm.domain?.length) meta.push(`domain: ${Array.isArray(fm.domain) ? fm.domain.join(', ') : fm.domain}`)
  if (meta.length) lines.push(meta.join(' | '))

  const meta2: string[] = []
  if (plan) {
    if (fm.created) meta2.push(`created: ${fm.created}`)
    if (fm['last-touched']) meta2.push(`last-touched: ${fm['last-touched']}`)
  } else {
    if (fm['reinforcement-count'] != null) meta2.push(`reinforcement-count: ${fm['reinforcement-count']}`)
    if (fm['last-reinforced']) meta2.push(`last-reinforced: ${fm['last-reinforced']}`)
  }
  if (meta2.length) lines.push(meta2.join(' | '))

  if (fm.related?.length) lines.push(`related: ${fm.related.join(', ')}`)

  lines.push('')
  lines.push(body)
  return lines.join('\n')
}

export type QueryTableRow = Pick<QueryResult, 'slug' | 'name' | 'type' | 'status' | 'next_action' | 'next_action_count'>

export function formatQueryTable(results: QueryTableRow[], total?: number): string {
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

export type KnowledgeTableRow = Pick<KnowledgeQueryResult, 'slug' | 'name' | 'confidence' | 'domain' | 'reinforcement_count'>

export function formatKnowledgeTable(results: KnowledgeTableRow[], total?: number): string {
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

export type SessionTableRow = Pick<SessionQueryResult, 'slug' | 'name' | 'session_date' | 'related'>

export function formatSessionTable(results: SessionTableRow[], total?: number): string {
  if (results.length === 0) return 'No results.'
  const lines = ['| slug | name | session-date | related |', '|------|------|--------------|---------|']
  for (const r of results) {
    lines.push(`| ${r.slug} | ${r.name} | ${r.session_date} | ${r.related.join(', ')} |`)
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
  const sessions = results.filter(r => r.kind === 'session')
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
  if (sessions.length > 0) {
    const lines = ['## Sessions', '', '| slug | name | match |', '|------|------|-------|']
    for (const r of sessions) lines.push(`| ${r.slug} | ${r.name} | ${r.snippet} |`)
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

/** The Health pass as markdown: one section per check, every section
 * printed, so an empty report still shows what was checked. */
export function formatHealth(report: HealthReport): string {
  const out: string[] = ['## Health']
  const section = (title: string, items: string[]) => {
    out.push('', `### ${title} (${items.length})`)
    for (const item of items) out.push(`- ${item}`)
  }
  // The workstream Item's own text (ADR 0001), prefixed with the entity.
  section('Workstreams', report.workstreams.map(w => `${w.entity} ${ITEMS.workstreamLine.render(w)}`))
  section('Recurring names', report.recurring_names.map(r =>
    `${r.entity}: \`${r.term}\` in ${r.units} units across ${r.days.length} days (${r.days[0]} .. ${r.days[r.days.length - 1]})`))
  section('Leakage', report.leakage.map(l =>
    `${l.parent} → ${l.child} (${l.relation}): ${l.hits} of ${l.entries} entries (${Math.round(100 * l.hits / l.entries)}%)`))
  section('One-way edges', report.one_way_edges.map(e =>
    `${e.from} → ${e.to}: \`hafez link ${e.to} ${e.from} --relation related\``))
  section('Unlinked mentions', report.unlinked_mentions.map(e =>
    `${e.from} mentions [[${e.to}]]: \`hafez link ${e.from} ${e.to} --relation related\``))
  section('Restated decisions', report.restated_decisions.map(r =>
    `${r.day} ${r.entity} → ${r.note} (${Math.round(100 * r.share)}%): ${r.summary}`))
  return out.join('\n')
}

export function formatValidation(report: ValidationReport): string {
  const issues = report.broken_slugs.length + report.orphaned_knowledge.length +
                 report.missing_fields.length

  const counts = `${report.total_entities} entities, ${report.total_knowledge} knowledge, ${report.total_sessions} sessions`
  if (issues === 0) {
    return `Vault OK — ${counts}, 0 issues`
  }

  const sections: string[] = [`## Vault Validation — ${counts}`]

  const addSection = (title: string, items: string[]) => {
    if (items.length === 0) return
    sections.push(`\n### ${title} (${items.length})`)
    for (const item of items) sections.push(`- ${item}`)
  }

  addSection('Broken Slugs', report.broken_slugs.map(i => `${i.slug}: ${i.issue}`))
  addSection('Orphaned Knowledge', report.orphaned_knowledge.map(s => `${s} (no related links, not referenced by any entity)`))
  addSection('Missing Fields', report.missing_fields.map(i => `${i.slug}: ${i.issue}`))

  return sections.join('\n')
}

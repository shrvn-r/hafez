// src/merge.ts
import { parseContent, serializeFile } from './vault.js'
import { parseSessionLogHeading } from './parser.js'

// Fields that are ISO date strings — latest date wins
const DATE_FIELDS = ['last-touched', 'last-reinforced', 'created']
// Fields that are numeric counters — max wins
const COUNT_FIELDS = ['reinforcement-count', 'staleness-days']
// Fields that are always arrays — union with dedup
const ARRAY_FIELDS_UNCAPPED = ['tags', 'domain', 'related']

export function mergeVaultContent(remote: string, local: string): string {
  const r = parseContent(remote)
  const l = parseContent(local)

  // Scalar policy: the side with the newer last-touched wins; local on tie.
  // Append-only sections (Session Log, Next Actions, Evidence, Sources) and
  // array/date/count frontmatter fields are always unioned regardless.
  const localWins =
    String(l.frontmatter?.['last-touched'] ?? '') >= String(r.frontmatter?.['last-touched'] ?? '')

  const fm = mergeFrontmatter(r.frontmatter, l.frontmatter, localWins)
  const body = mergeBody(r.body, l.body, localWins)

  return serializeFile(fm, body)
}

function mergeFrontmatter(
  remote: Record<string, any>,
  local: Record<string, any>,
  localWins: boolean
): Record<string, any> {
  // Overlay the winning side's scalars on top of the other's
  const merged = localWins ? { ...remote, ...local } : { ...local, ...remote }

  // Date fields: latest wins
  for (const key of DATE_FIELDS) {
    const r = remote[key], l = local[key]
    if (r && l) merged[key] = r > l ? r : l
    else if (r) merged[key] = r
  }

  // Count fields: max wins
  for (const key of COUNT_FIELDS) {
    const r = remote[key], l = local[key]
    if (r != null && l != null) merged[key] = Math.max(r, l)
    else if (r != null) merged[key] = r
  }

  // Array fields: union
  for (const key of ARRAY_FIELDS_UNCAPPED) {
    merged[key] = unionArrays(remote[key], local[key])
    if (merged[key].length === 0) delete merged[key]
  }
  return merged
}

function unionArrays(a: any, b: any): string[] {
  // Local (b) items first so they survive cap truncation
  const arrA = Array.isArray(a) ? a : a ? [a] : []
  const arrB = Array.isArray(b) ? b : b ? [b] : []
  return [...new Set([...arrB, ...arrA])]
}

// --- Body merge ---

interface Section { heading: string; content: string }

function splitSections(body: string): { preamble: string; sections: Section[] } {
  const parts = body.split(/\n(?=## )/g)
  const sections: Section[] = []
  let preamble = ''

  for (const part of parts) {
    if (part.startsWith('## ')) {
      const nlIdx = part.indexOf('\n')
      const heading = nlIdx === -1 ? part : part.slice(0, nlIdx)
      const content = nlIdx === -1 ? '' : part.slice(nlIdx + 1)
      sections.push({ heading: heading.trim(), content: content.trim() })
    } else {
      preamble = part.trim()
    }
  }

  return { preamble, sections }
}

function mergeBody(remoteBody: string, localBody: string, localWins: boolean): string {
  if (remoteBody === localBody) return localBody

  const remote = splitSections(remoteBody)
  const local = splitSections(localBody)

  // Build merged sections starting from local (local section order is canonical)
  const localHeadings = new Set(local.sections.map(s => s.heading))
  const mergedSections: Section[] = []

  for (const ls of local.sections) {
    const rs = remote.sections.find(s => s.heading === ls.heading)
    if (ls.heading === '## Session Log' && rs) {
      mergedSections.push({ heading: ls.heading, content: mergeSessionLogs(rs.content, ls.content) })
    } else if (ls.heading === '## Next Actions' && rs) {
      mergedSections.push({ heading: ls.heading, content: mergeNextActions(rs.content, ls.content) })
    } else if ((ls.heading === '## Evidence' || ls.heading === '## Sources') && rs) {
      // Append-only sections: union lines from both sides, dedup identical
      mergedSections.push({ heading: ls.heading, content: mergeAppendOnlyLines(rs.content, ls.content) })
    } else if (rs && !localWins) {
      // Scalar sections (Brief, Current State, Synthesis, ...): newer side wins
      mergedSections.push(rs)
    } else {
      mergedSections.push(ls)
    }
  }

  // Append remote-only sections (not in local)
  for (const rs of remote.sections) {
    if (!localHeadings.has(rs.heading)) {
      mergedSections.push(rs)
    }
  }

  // Reassemble
  const preamble = localWins
    ? (local.preamble || remote.preamble)
    : (remote.preamble || local.preamble)
  const parts = [preamble, ...mergedSections.map(s => `${s.heading}\n\n${s.content}`)].filter(Boolean)
  return parts.join('\n\n')
}

/** Union merge for append-only free-text sections: local lines first, then
 *  remote lines not already present. Blank lines are kept only from local. */
function mergeAppendOnlyLines(remoteContent: string, localContent: string): string {
  if (remoteContent === localContent) return localContent
  const localLines = localContent.split('\n')
  const seen = new Set(localLines.map(l => l.trim()).filter(Boolean))
  const remoteOnly = remoteContent
    .split('\n')
    .filter(l => l.trim() && !seen.has(l.trim()))
  if (remoteOnly.length === 0) return localContent
  return [...localLines, ...remoteOnly].join('\n')
}

function mergeSessionLogs(remoteContent: string, localContent: string): string {
  const remoteEntries = parseLogEntries(remoteContent)
  const localEntries = parseLogEntries(localContent)

  // Index local entries by identity key for dedup
  const localKeys = new Set(localEntries.map(e => e.key))
  const merged = [...localEntries]

  // Add remote entries not present in local
  for (const re of remoteEntries) {
    if (!localKeys.has(re.key)) {
      merged.push(re)
    }
  }

  // Sort newest-first, with stable tiebreaker on identity key
  merged.sort((a, b) => b.date.localeCompare(a.date) || a.key.localeCompare(b.key))

  return merged.map(e => e.raw).join('\n\n')
}

interface LogEntry { key: string; date: string; raw: string }

function parseLogEntries(content: string): LogEntry[] {
  const entries: LogEntry[] = []
  const blocks = content.split(/\n(?=### \d{4}-\d{2}-\d{2})/)

  for (const block of blocks) {
    const trimmed = block.trim()
    if (!trimmed) continue
    const firstLine = trimmed.split('\n')[0]
    const parsed = parseSessionLogHeading(firstLine)
    if (parsed) {
      entries.push({
        key: `${parsed.date}|${parsed.agent}|${parsed.type}`,
        date: parsed.date,
        raw: trimmed,
      })
    }
  }

  return entries
}

function mergeNextActions(remoteContent: string, localContent: string): string {
  const remoteItems = parseActionItems(remoteContent)
  const localItems = parseActionItems(localContent)

  // Build merged set: start with local items
  const seen = new Set<string>()
  const merged: { checked: boolean; text: string }[] = []

  // Add all local items
  for (const item of localItems) {
    seen.add(item.text)
    merged.push(item)
  }

  // Add remote items not in local
  for (const item of remoteItems) {
    if (!seen.has(item.text)) {
      seen.add(item.text)
      merged.push(item)
    } else {
      // If remote has it checked but local has it unchecked, upgrade to checked
      const existing = merged.find(m => m.text === item.text)
      if (existing && item.checked && !existing.checked) {
        existing.checked = true
      }
    }
  }

  return merged.map(i => `- [${i.checked ? 'x' : ' '}] ${i.text}`).join('\n')
}

function parseActionItems(content: string): { checked: boolean; text: string }[] {
  const items: { checked: boolean; text: string }[] = []
  for (const line of content.split('\n')) {
    const unchecked = line.match(/^- \[ \] (.+)$/)
    if (unchecked) { items.push({ checked: false, text: unchecked[1] }); continue }
    const checked = line.match(/^- \[x\] (.+)$/)
    if (checked) { items.push({ checked: true, text: checked[1] }); continue }
  }
  return items
}

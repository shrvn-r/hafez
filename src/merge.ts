// src/merge.ts
import { parseContent, serializeFile, ARRAY_FIELDS } from './vault.js'
import { parseSessionLogHeading, splitLogEntries, documentFor, stripActionStamp, type DocSection, type Doc } from './document.js'
import { APPEND_ONLY_SECTIONS } from './contracts.js'
import { addResources } from './resource.js'

// Fields that are ISO date strings — latest date wins
const DATE_FIELDS = ['last-touched', 'last-reinforced', 'created']
// Fields that are numeric counters — max wins
const COUNT_FIELDS = ['reinforcement-count', 'staleness-days']
// Array fields (vault.ARRAY_FIELDS — the same set parsing coerces) union with dedup;
// `resource` by the duplicate rule (resource.ts), so two spellings of one repo are one

export function mergeVaultContent(remote: string, local: string, kind: 'entity' | 'knowledge' | 'session'): string {
  const r = parseContent(remote)
  const l = parseContent(local)

  // Scalar policy: the side with the newer last-touched wins; local on tie.
  // Append-only sections (Session Log, Next Actions, Evidence, Sources) and
  // array/date/count frontmatter fields are always unioned regardless.
  const localWins =
    String(l.frontmatter?.['last-touched'] ?? '') >= String(r.frontmatter?.['last-touched'] ?? '')

  const fm = mergeFrontmatter(r.frontmatter, l.frontmatter, localWins)
  // The Document binds by kind — the same binding every write path uses (see
  // DocContext), so a section this merge preserves stays structural for the
  // next update too. The two sides come from divergent histories whose type
  // may differ (a promote race leaves one side 'capture' and the other
  // 'project'); the kind-level set keeps every same-kind section structural,
  // while cross-KIND headings (a session-only ## Decisions quoted in an
  // entity Brief) are not boundaries. Known residual: a same-kind heading
  // quoted at line start in one side's section splits at that false boundary
  // and can survive the merge as its own section — the fix is fence/quote
  // awareness in Document's splitter, not a narrower binding here.
  const doc = documentFor({ kind })
  const body = mergeBody(doc, r.body, l.body, localWins)

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
  for (const key of ARRAY_FIELDS) {
    merged[key] = key === 'resource' ? addResources(asArray(local[key]), asArray(remote[key])) : unionArrays(remote[key], local[key])
    if (merged[key].length === 0) delete merged[key]
  }
  return merged
}

function unionArrays(a: any, b: any): string[] {
  // Local (b) items first: nothing is truncated, but the local side's order is
  // the one the user last saw, so it stays the order they get back.
  return [...new Set([...asArray(b), ...asArray(a)])]
}

/** An array field's values: a scalar is one value, absent none. */
function asArray(v: any): string[] {
  return Array.isArray(v) ? v : v ? [v] : []
}

// --- Body merge ---

function mergeBody(doc: Doc, remoteBody: string, localBody: string, localWins: boolean): string {
  if (remoteBody === localBody) return localBody

  // Structural split (see document.ts): sections are atomic — a user ##
  // heading inside a Brief or a session-log entry body stays with its
  // section instead of being split out and merged under its own policy.
  const remote = doc.splitStructural(remoteBody)
  const local = doc.splitStructural(localBody)

  // Build merged sections starting from local (local section order is canonical)
  const localHeadings = new Set(local.sections.map(s => s.heading))
  const mergedSections: DocSection[] = []

  for (const ls of local.sections) {
    const rs = remote.sections.find(s => s.heading === ls.heading)
    if (ls.heading === 'Session Log' && rs) {
      mergedSections.push({ heading: ls.heading, content: mergeSessionLogs(rs.content, ls.content) })
    } else if (ls.heading === 'Next Actions' && rs) {
      mergedSections.push({ heading: ls.heading, content: mergeNextActions(rs.content, ls.content) })
    } else if (APPEND_ONLY_SECTIONS.has(ls.heading) && rs) {
      // Append-only sections (contracts.ts): union lines from both sides, dedup identical
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

  // Reassemble. A preamble that is itself a session-log entry stream is
  // append-only content living outside any heading — the archive-log files
  // under entities/archive/ are exactly this shape. Merging those by the
  // scalar wins policy drops one machine's archived entries wholesale, so
  // union them by the same entry policy the Session Log section uses.
  const preamble =
    isLogEntryStream(remote.preamble) && isLogEntryStream(local.preamble)
      ? mergeSessionLogs(remote.preamble, local.preamble)
      : localWins
        ? (local.preamble || remote.preamble)
        : (remote.preamble || local.preamble)
  const parts = [preamble, ...mergedSections.map(s => `## ${s.heading}\n\n${s.content}`)].filter(Boolean)
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

/** True when a block is nothing but session-log entries — it starts with an
 *  entry heading, so splitLogEntries drops no leading prose. */
function isLogEntryStream(text: string): boolean {
  const first = text.trim().split('\n')[0]
  return first !== '' && parseSessionLogHeading(first) !== null
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
  // Document owns entry block splitting; the identity key and dedup/sort
  // policy stay here — merge semantics, not document structure.
  //
  // Identity is the entry's whole content. Date+agent+type is not an identity:
  // two machines each running a digest on the same day produce two entries with
  // the same heading and different bodies, and keying on the heading collapses
  // them to one — the other machine's session history is gone. Entries the two
  // sides share came from the same commit, so they are byte-identical and still
  // dedup.
  return splitLogEntries(content).map(raw => {
    const parsed = parseSessionLogHeading(raw.split('\n')[0])!
    return { key: raw, date: parsed.date, raw }
  })
}

function mergeNextActions(remoteContent: string, localContent: string): string {
  const remote = parseActionItems(remoteContent)
  const local = parseActionItems(localContent)

  // Start with local items; index by action text for the remote pass. Identity
  // is the unstamped text: one action stamped on two days is one action, and
  // the local line (its stamp included) wins.
  const merged = local.items.map(i => ({ ...i, notes: [...i.notes] }))
  const byText = new Map(merged.map(i => [stripActionStamp(i.text), i]))

  for (const item of remote.items) {
    const existing = byText.get(stripActionStamp(item.text))
    if (!existing) {
      merged.push({ ...item, notes: [...item.notes] })
      byText.set(stripActionStamp(item.text), merged[merged.length - 1])
      continue
    }
    // Checked on either side means done
    if (item.checked) existing.checked = true
    // Union the item's own notes/sub-bullets — they are authored content, not
    // re-derivable from the checkbox line
    existing.notes.push(...unionLines(item.notes, existing.notes))
  }

  const lines = [...local.preamble, ...unionLines(remote.preamble, local.preamble)]
  for (const item of merged) {
    lines.push(`- [${item.checked ? 'x' : ' '}] ${item.text}`)
    lines.push(...item.notes)
  }
  return lines.join('\n').replace(/\n+$/, '')
}

interface ActionItem { checked: boolean; text: string; notes: string[] }

/** Lines of `from` not already present in `into` (blank lines only from `into`). */
function unionLines(from: string[], into: string[]): string[] {
  const seen = new Set(into.map(l => l.trim()).filter(Boolean))
  return from.filter(l => l.trim() && !seen.has(l.trim()))
}

/**
 * Split a Next Actions section into its leading non-item lines and its items,
 * each item carrying the lines that follow it (indented sub-bullets, notes)
 * until the next checkbox. Non-checkbox lines are authored content — parsing
 * checkbox lines alone and re-rendering from them deletes everything else.
 * `- [X]` is the same as `- [x]`: a completed action, not an unknown line.
 */
function parseActionItems(content: string): { preamble: string[]; items: ActionItem[] } {
  const preamble: string[] = []
  const items: ActionItem[] = []
  for (const line of content.split('\n')) {
    const match = line.match(/^- \[([ xX])\] (.+)$/)
    if (match) {
      items.push({ checked: match[1].toLowerCase() === 'x', text: match[2], notes: [] })
    } else if (items.length === 0) {
      preamble.push(line)
    } else {
      items[items.length - 1].notes.push(line)
    }
  }
  return { preamble, items }
}

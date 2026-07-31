// src/parser.ts
import type { SessionLogEntry, SessionLogType } from './types.js'
import { findNextStructuralHeading } from './sections.js'
const HEADING_RE = /^### (\d{4}-\d{2}-\d{2}) (?:—|--) (.+?)(?:\s+\[(\w+)\])?$/

export function parseSessionLogHeading(line: string): { date: string; agent: string; type: SessionLogType } | null {
  const match = line.match(HEADING_RE)
  if (!match) return null
  return {
    date: match[1],
    agent: match[2],
    type: (match[3] as SessionLogType) || 'progress'
  }
}

export function formatSessionLogEntry(entry: SessionLogEntry): string {
  const today = new Date().toISOString().slice(0, 10)
  const lines = [`### ${today} — ${entry.agent} [${entry.type}]`, `Summary: ${entry.summary}`]
  if (entry.body) lines.push(entry.body)
  return lines.join('\n')
}

export function countSessionLogEntries(body: string): number {
  return (body.match(/^### \d{4}-\d{2}-\d{2} (?:—|--)/gm) || []).length
}

export function parseSessionLog(body: string): Array<{
  date: string
  agent: string
  type: SessionLogType
  summary: string
}> {
  // Inline section extraction to avoid circular import with sections.ts
  const idx = body.indexOf('## Session Log')
  if (idx === -1) return []
  const afterPos = idx + '## Session Log'.length
  // Find end: next structural ## heading or end of string
  const nextH = findNextStructuralHeading(body, afterPos)
  const sectionContent = nextH !== -1 ? body.slice(afterPos, nextH) : body.slice(afterPos)

  const entries: Array<{ date: string; agent: string; type: SessionLogType; summary: string }> = []
  const lines = sectionContent.split('\n')

  let current: { date: string; agent: string; type: SessionLogType } | null = null
  let summaryLine: string | null = null

  for (const line of lines) {
    const heading = parseSessionLogHeading(line)
    if (heading) {
      if (current && summaryLine) {
        entries.push({ ...current, summary: summaryLine })
      }
      current = heading
      summaryLine = null
    } else if (current && !summaryLine && line.startsWith('Summary: ')) {
      summaryLine = line.slice('Summary: '.length)
    }
  }
  if (current && summaryLine) {
    entries.push({ ...current, summary: summaryLine })
  }

  return entries
}

export function extractOldestSessionLogEntry(body: string): { entry: string; remaining: string } | null {
  const sectionStart = body.indexOf('## Session Log')
  if (sectionStart === -1) return null

  const afterHeader = body.slice(sectionStart + '## Session Log'.length)
  const entryStarts = [...afterHeader.matchAll(/^### \d{4}-\d{2}-\d{2} (?:—|--)/gm)]
  if (entryStarts.length < 2) return null

  // Entries are newest-first in the file, so the oldest is the last match
  const lastIdx = entryStarts.length - 1
  const oldestStart = entryStarts[lastIdx].index!
  const entry = afterHeader.slice(oldestStart).trim()
  const remaining = body.slice(0, sectionStart + '## Session Log'.length) + afterHeader.slice(0, oldestStart)

  return { entry, remaining }
}

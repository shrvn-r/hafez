// src/export-okf.ts
// Read-only export of the vault as an OKF v0.1 bundle (entities + knowledge + sessions).
// Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
// Pure sync function — no Hafez instance, index, git, or lock.
// Re-export overwrites a prior bundle in place but never deletes: files for vault
// docs renamed or removed since the last export linger (unreferenced by the
// regenerated indexes) until the bundle directory is deleted and re-exported.
import { readdirSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve, sep, basename } from 'path'
import { parseFilePath, serializeFile } from './vault.js'
import { deriveSummary } from './sections.js'

export interface OkfExportReport {
  outDir: string
  entities: number
  knowledge: number
  sessions: number
  skipped: Array<{ file: string; reason: string }>
  unresolvedLinks: number
}

type SourceKind = 'entity' | 'knowledge' | 'session'

const KIND_DIRS: Array<{ dir: string; kind: SourceKind }> = [
  { dir: 'entities', kind: 'entity' },
  { dir: 'knowledge', kind: 'knowledge' },
  { dir: 'sessions', kind: 'session' },
]

// Local capturing variant of the shared WIKI_LINK_RE — captures display text in
// group 2, which the shared regex's consumers don't need.
const OKF_LINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g

interface ParsedDoc {
  slug: string
  dir: string
  kind: SourceKind
  fm: Record<string, any>
  body: string
}

function scanDir(dirPath: string): string[] {
  try {
    return readdirSync(dirPath).filter(f => f.endsWith('.md')).map(f => join(dirPath, f))
  } catch { return [] }
}

function mapFrontmatter(doc: ParsedDoc): Record<string, any> {
  const { fm, kind, body } = doc
  const mapped: Record<string, any> = {}

  if (kind === 'entity') mapped.type = fm.type ?? 'entity'
  else if (kind === 'knowledge') mapped.type = fm.subtype ? `knowledge/${fm.subtype}` : 'knowledge'
  else mapped.type = 'session'

  mapped.title = fm.name
  const description = deriveSummary(kind, fm, body)
  if (description) mapped.description = description
  if (kind === 'entity' && fm.resource) mapped.resource = fm.resource
  if (fm.tags) mapped.tags = fm.tags

  let timestamp: string | undefined
  if (kind === 'entity') timestamp = fm['last-touched'] ?? fm.created
  else if (kind === 'knowledge') timestamp = fm['last-reinforced'] ?? fm.created
  else timestamp = fm['session-date'] ?? fm.created
  if (timestamp) mapped.timestamp = timestamp

  // Carry all remaining original keys verbatim; drop only name (mapped to title).
  const consumed = new Set(['name', 'type', 'description', 'resource', 'tags'])
  for (const [key, value] of Object.entries(fm)) {
    if (!consumed.has(key) && !(key in mapped)) mapped[key] = value
  }
  return mapped
}

export function exportOkf(vaultPath: string, outDir: string): OkfExportReport {
  const resolvedVault = resolve(vaultPath)
  const resolvedOut = resolve(outDir)

  if (resolvedOut === resolvedVault || resolvedOut.startsWith(resolvedVault + sep)) {
    throw new Error(`Export target ${resolvedOut} is inside the vault. Pass --out <path> outside the vault.`)
  }
  if (existsSync(resolvedOut)) {
    const existing = readdirSync(resolvedOut)
    if (existing.length > 0) {
      const rootIndex = join(resolvedOut, 'index.md')
      let isPriorBundle = false
      if (existsSync(rootIndex)) {
        try {
          isPriorBundle = parseFilePath(rootIndex).frontmatter.okf_version !== undefined
        } catch { /* unparseable — treat as not a bundle */ }
      }
      if (!isPriorBundle) {
        throw new Error(`Export target ${resolvedOut} is non-empty and not a prior OKF bundle. Refusing to write.`)
      }
    }
  }

  const report: OkfExportReport = {
    outDir: resolvedOut, entities: 0, knowledge: 0, sessions: 0,
    skipped: [], unresolvedLinks: 0,
  }

  // Enumerate and parse. Sessions are not in SQLite — disk enumeration is required.
  const docs: ParsedDoc[] = []
  for (const { dir, kind } of KIND_DIRS) {
    for (const filePath of scanDir(join(resolvedVault, dir))) {
      const slug = basename(filePath, '.md')
      const relFile = `${dir}/${slug}.md`
      let fm: Record<string, any>, body: string
      try {
        const parsed = parseFilePath(filePath)
        fm = parsed.frontmatter
        body = parsed.body
      } catch (err) {
        report.skipped.push({ file: relFile, reason: `failed to parse (${(err as Error).message})` })
        process.stderr.write(`Warning: skipping ${relFile}: failed to parse\n`)
        continue
      }
      if (!fm.name) {
        report.skipped.push({ file: relFile, reason: 'missing name' })
        process.stderr.write(`Warning: skipping ${relFile}: missing name\n`)
        continue
      }
      docs.push({ slug, dir, kind, fm, body })
    }
  }

  // Slug→dir map: insertion order entities/knowledge/sessions, first write wins,
  // giving entity precedence on cross-kind slug collisions.
  const slugDirs = new Map<string, string>()
  for (const doc of docs) {
    if (!slugDirs.has(doc.slug)) slugDirs.set(doc.slug, doc.dir)
  }

  function transformBody(body: string): string {
    return body.replace(OKF_LINK_RE, (_m, rawSlug: string, rawDisplay?: string) => {
      // Trim: Obsidian-idiomatic [[ foo ]] / [[foo | Label]] carry whitespace in the captures
      const slug = rawSlug.trim()
      const label = rawDisplay?.trim() || slug
      const dir = slugDirs.get(slug)
      if (!dir) {
        report.unresolvedLinks++
        return label
      }
      // Bundle-root-absolute path, hardcoded '/' separators
      return `[${label}](/${dir}/${slug}.md)`
    })
  }

  mkdirSync(resolvedOut, { recursive: true })

  const byDir = new Map<string, Array<{ slug: string; title: string; description: string }>>()
  for (const doc of docs) {
    const mapped = mapFrontmatter(doc)
    const outSubdir = join(resolvedOut, doc.dir)
    mkdirSync(outSubdir, { recursive: true })
    writeFileSync(join(outSubdir, `${doc.slug}.md`), serializeFile(mapped, transformBody(doc.body)))

    if (doc.kind === 'entity') report.entities++
    else if (doc.kind === 'knowledge') report.knowledge++
    else report.sessions++

    const list = byDir.get(doc.dir) ?? []
    list.push({ slug: doc.slug, title: mapped.title, description: mapped.description ?? '' })
    byDir.set(doc.dir, list)
  }

  // Per-dir index.md — reserved file: NO frontmatter, sorted bullets
  for (const [dir, items] of byDir) {
    const heading = dir.charAt(0).toUpperCase() + dir.slice(1)
    const lines = [`# ${heading}`, '']
    for (const item of items.sort((a, b) => a.title.localeCompare(b.title))) {
      const desc = item.description ? ` — ${item.description}` : ''
      lines.push(`- [${item.title}](/${dir}/${item.slug}.md)${desc}`)
    }
    writeFileSync(join(resolvedOut, dir, 'index.md'), lines.join('\n') + '\n')
  }

  // Root index.md — the only place okf_version may appear
  const counts: Array<[string, number]> = [
    ['entities', report.entities],
    ['knowledge', report.knowledge],
    ['sessions', report.sessions],
  ]
  const rootLines = ['# Vault Export', '']
  for (const [dir, count] of counts) {
    if (count === 0) continue
    const heading = dir.charAt(0).toUpperCase() + dir.slice(1)
    rootLines.push(`- [${heading}](/${dir}/index.md) — ${count} concepts`)
  }
  writeFileSync(join(resolvedOut, 'index.md'), serializeFile({ okf_version: '0.1' }, rootLines.join('\n')))

  return report
}

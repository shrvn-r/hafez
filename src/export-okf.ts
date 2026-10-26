// src/export-okf.ts
// Read-only export of the vault as an OKF v0.1 bundle (entities + knowledge + sessions).
// Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
// Pure sync function — no Hafez instance, index, git, or lock.
// Re-export overwrites a prior bundle in place but never deletes: files for vault
// docs renamed or removed since the last export linger (unreferenced by the
// regenerated indexes) until the bundle directory is deleted and re-exported.
import { readdirSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join, resolve, sep, basename } from 'path'
import { parseFilePath, serializeFile, scanVaultDir, kindDir } from './vault.js'
import { DEFAULT_KNOWLEDGE_SUBTYPE } from './contracts.js'
import { deriveSummary, documentFor, WIKI_LINK_RE } from './document.js'

export interface OkfExportReport {
  outDir: string
  entities: number
  knowledge: number
  sessions: number
  skipped: Array<{ file: string; reason: string }>
  unresolvedLinks: number
}

type SourceKind = 'entity' | 'knowledge' | 'session'

const SOURCE_KINDS: SourceKind[] = ['entity', 'knowledge', 'session']
const KIND_DIRS: Array<{ dir: string; kind: SourceKind }> = SOURCE_KINDS.map(kind => ({ dir: kindDir(kind), kind }))

const ENTITY_DOC = documentFor({ kind: 'entity' })

// The shared wiki-link syntax (document.ts) — group 1 slug, group 2 display.
const OKF_LINK_RE = new RegExp(WIKI_LINK_RE.source, 'g')

/** Frontmatter of an exported OKF document. Not vault frontmatter: `name` maps
 * to `title`, `type` is normalized per kind, `timestamp` (and `description`,
 * when the source has none) is derived, `resource` (its first value, every
 * value under `resources` when there are several) survives only on entities,
 * and the remaining keys are carried through verbatim. */
export interface OkfFrontmatter {
  type: string
  title: string
  description?: string
  resource?: string
  resources?: string[]
  tags?: string[]
  timestamp?: string
  [key: string]: unknown
}

interface ParsedDoc {
  slug: string
  dir: string
  kind: SourceKind
  fm: Record<string, any>
  body: string
  /** Bundle file base name — the slug, unless it hit the reserved index name. */
  file: string
}

/** `index.md` is reserved in every bundle directory for the generated index, so
 * a vault doc slugged `index` cannot keep its name — before this it was silently
 * overwritten by the index that ran after it. Deterministic rule: rename to
 * `index-doc`, then `index-doc-2`, `index-doc-3`, … until the name is free among
 * that directory's real slugs (a vault may legitimately hold both `index` and
 * `index-doc`). Same vault contents always produce the same bundle names, and
 * every link/index reference is written against the renamed file. */
const RESERVED_INDEX = 'index'

function assignBundleNames(docs: ParsedDoc[]): void {
  const slugsByDir = new Map<string, Set<string>>()
  for (const doc of docs) {
    const slugs = slugsByDir.get(doc.dir) ?? new Set<string>()
    slugs.add(doc.slug)
    slugsByDir.set(doc.dir, slugs)
  }
  for (const doc of docs) {
    if (doc.slug !== RESERVED_INDEX) continue
    const taken = slugsByDir.get(doc.dir)!
    let candidate = `${RESERVED_INDEX}-doc`
    for (let n = 2; taken.has(candidate); n++) candidate = `${RESERVED_INDEX}-doc-${n}`
    doc.file = candidate
  }
}

function mapFrontmatter(doc: ParsedDoc): OkfFrontmatter {
  const { fm, kind, body } = doc
  let type: string
  if (kind === 'entity') type = fm.type ?? 'entity'
  else if (kind === 'knowledge') type = `knowledge/${fm.subtype ?? DEFAULT_KNOWLEDGE_SUBTYPE}`
  else type = 'session'
  const mapped: OkfFrontmatter = { type, title: fm.name }

  const description = deriveSummary(kind, fm, body)
  if (description) mapped.description = description
  // OKF's `resource` is one URI: the first value; several also go whole
  // under the `resources` extension key, so the bundle loses none (#304).
  if (kind === 'entity' && fm.resource?.length) {
    mapped.resource = fm.resource[0]
    if (fm.resource.length > 1) mapped.resources = fm.resource
  }
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
          isPriorBundle = (parseFilePath(rootIndex).frontmatter as Record<string, any>).okf_version !== undefined
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
    for (const filePath of scanVaultDir(join(resolvedVault, dir))) {
      const slug = basename(filePath, '.md')
      const relFile = `${dir}/${slug}.md`
      let fm: Record<string, any>, body: string
      try {
        const parsed = parseFilePath(filePath)
        fm = parsed.frontmatter as Record<string, any>
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
      docs.push({ slug, dir, kind, fm, body, file: slug })
    }
  }

  assignBundleNames(docs)

  // Slug→bundle path map: insertion order entities/knowledge/sessions, first write
  // wins, giving entity precedence on cross-kind slug collisions. Paths are
  // bundle-root-absolute with hardcoded '/' separators.
  const slugPaths = new Map<string, string>()
  for (const doc of docs) {
    if (!slugPaths.has(doc.slug)) slugPaths.set(doc.slug, `/${doc.dir}/${doc.file}.md`)
  }

  function transformBody(body: string): string {
    return body.replace(OKF_LINK_RE, (_m, rawSlug: string, rawDisplay?: string) => {
      const slug = rawSlug.trim()
      const label = rawDisplay?.trim() || slug
      const path = slugPaths.get(slug)
      if (!path) {
        report.unresolvedLinks++
        return label
      }
      return `[${label}](${path})`
    })
  }

  mkdirSync(resolvedOut, { recursive: true })

  const byDir = new Map<string, Array<{ file: string; title: string; description: string }>>()
  for (const doc of docs) {
    const mapped = mapFrontmatter(doc)
    const outSubdir = join(resolvedOut, doc.dir)
    mkdirSync(outSubdir, { recursive: true })
    // The added-date stamp is vault file format, not action text: exported
    // Next Actions carry the unstamped text.
    const body = doc.kind === 'entity' ? ENTITY_DOC.stripNextActionStamps(doc.body) : doc.body
    writeFileSync(join(outSubdir, `${doc.file}.md`), serializeFile(mapped, transformBody(body)))

    if (doc.kind === 'entity') report.entities++
    else if (doc.kind === 'knowledge') report.knowledge++
    else report.sessions++

    const list = byDir.get(doc.dir) ?? []
    list.push({ file: doc.file, title: mapped.title, description: mapped.description ?? '' })
    byDir.set(doc.dir, list)
  }

  // Per-dir index.md — reserved file: NO frontmatter, sorted bullets
  for (const [dir, items] of byDir) {
    const heading = dir.charAt(0).toUpperCase() + dir.slice(1)
    const lines = [`# ${heading}`, '']
    for (const item of items.sort((a, b) => a.title.localeCompare(b.title))) {
      const desc = item.description ? ` — ${item.description}` : ''
      lines.push(`- [${item.title}](/${dir}/${item.file}.md)${desc}`)
    }
    writeFileSync(join(resolvedOut, dir, 'index.md'), lines.join('\n') + '\n')
  }

  // Root index.md — the only place okf_version may appear
  const counts: Array<[string, number]> = [
    [kindDir('entity'), report.entities],
    [kindDir('knowledge'), report.knowledge],
    [kindDir('session'), report.sessions],
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

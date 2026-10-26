// src/vault.ts
import matter from 'gray-matter'
import yaml from 'js-yaml'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join, relative, sep } from 'path'
import { HafezError } from './types.js'
import type { ParsedVaultFile, EntityFrontmatter, KnowledgeFrontmatter, SessionFrontmatter, VaultKind } from './types.js'

// Prevent gray-matter from auto-coercing YAML date strings into JS Date objects
const MATTER_OPTIONS = { engines: { yaml: (s: string) => yaml.load(s, { schema: yaml.JSON_SCHEMA }) as Record<string, any> } }

export function slugify(name: string): string {
  // Unicode-aware: non-Latin letters/digits are kept, so "日本語のメモ" gets a
  // real slug instead of collapsing to ''.
  return name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .replace(/-{2,}/g, '-')
}

// ---------------------------------------------------------------------------
// Layout (see CONTEXT.md): the single statement of "what lives where" —
// directory↔kind mapping, vault-file membership, scanning. Every other
// module asks these questions here instead of restating directory names.
// ---------------------------------------------------------------------------

export type { VaultKind }

const KIND_DIRS = { entity: 'entities', knowledge: 'knowledge', session: 'sessions' } as const

/** Kinds that live in the SQLite read index: every kind. Sessions joined in
 * #35 — before that they were files-and-git only, for no recorded reason. */
export const INDEXED_KINDS: ReadonlyArray<VaultKind> = ['entity', 'knowledge', 'session']

/** The two kinds a mutation can address. A session note is written once and
 * read; `update`, `link`, `promote` never resolve one. */
export const MUTABLE_KINDS: ReadonlyArray<'entity' | 'knowledge'> = ['entity', 'knowledge']

/** Vault directory for a kind, relative to the vault root. */
export function kindDir(kind: VaultKind): string {
  return KIND_DIRS[kind]
}

/** A vault content file: anything a sync/merge must treat semantically. */
export const VAULT_FILE_RE = new RegExp(`^(?:${Object.values(KIND_DIRS).join('|')})/.+\\.md$`)

/** True for vault-relative paths of a mutable kind — what index.md shows. */
export function isMutableRelPath(relPath: string): boolean {
  return MUTABLE_KINDS.some(k => relPath.startsWith(`${KIND_DIRS[k]}/`))
}

/** History pathspecs covering the indexed dirs (changelog, file times). */
export const INDEXED_DIR_PATHSPECS: ReadonlyArray<string> = INDEXED_KINDS.map(k => `${KIND_DIRS[k]}/`)

/** Classify a vault-relative path into an indexed kind + slug; null outside
 * the indexed dirs (sessions, non-vault files). Nested paths keep their
 * historical shape: entities/archive/x-log.md → entity 'archive/x-log'. */
export function classifyIndexedRelPath(relPath: string): { kind: VaultKind; slug: string } | null {
  for (const kind of INDEXED_KINDS) {
    const prefix = `${KIND_DIRS[kind]}/`
    if (relPath.startsWith(prefix)) {
      return { kind, slug: relPath.replace(prefix, '').replace('.md', '') }
    }
  }
  return null
}

/** The note a vault-relative ('/'-separated) path is, or null: the files
 * scanVaultDir lists — a non-dot `.md` directly in a kind dir. Archive logs,
 * scaffold files and anything outside the kind dirs are not notes. */
export function noteAtRelPath(relPath: string): { kind: VaultKind; slug: string } | null {
  const match = relPath.match(/^([^/]+)\/([^/]+)\.md$/)
  if (!match || match[2].startsWith('.')) return null
  const kind = INDEXED_KINDS.find(k => KIND_DIRS[k] === match[1])
  return kind ? { kind, slug: match[2] } : null
}

/** All .md files directly in dir — non-recursive (archive/ subdirs are
 * invisible by construction) and dotfile-free: dotfile slugs are rejected by
 * resolveFilePath, so listing them would surface files no operation can reach. */
export function scanVaultDir(dirPath: string): string[] {
  try {
    return readdirSync(dirPath).filter(f => f.endsWith('.md') && !f.startsWith('.')).map(f => join(dirPath, f))
  } catch { return [] }
}

/** Where an entity's overflow session-log entries are archived. */
export function archiveLogPath(vaultPath: string, slug: string): string {
  return join(vaultPath, KIND_DIRS.entity, 'archive', `${slug}-log.md`)
}

// Slugs are path components: anything with separators (or a leading dot, or a
// Windows drive colon) could escape the vault — "../../outside/secret" reads,
// writes, and deletes files anywhere on disk. Block only those; spaces and
// non-Latin names are legitimate in a hand-edited (Obsidian) vault. Single
// choke point for every slug-consuming operation.
export function resolveFilePath(vaultPath: string, slug: string, kind: VaultKind): string {
  if (!slug || slug.startsWith('.') || /[/\\:\0]/.test(slug)) {
    throw new HafezError('VALIDATION_FAILED', `Invalid slug: '${slug}'`)
  }
  return join(vaultPath, KIND_DIRS[kind], `${slug}.md`)
}

/** The inverse of resolveFilePath / archiveLogPath: a vault file as the
 * Journal names it — vault-relative and '/'-separated on every platform.
 * Everything downstream compares these lists as POSIX paths: stageablePaths
 * (src/git.ts) keeps an absent path only if `git ls-files` echoes it back,
 * always with '/', so a '\' deletion was dropped and never staged; and the
 * index.md gate (isMutableRelPath) never matched a '\' path (#187). */
export function vaultRel(vaultPath: string, filePath: string): string {
  return relative(vaultPath, filePath).split(sep).join('/')
}

/** The mutable file a slug names, or null — entities are resolved before
 * knowledge, the one resolution order every mutation sees. */
export function findVaultFile(vaultPath: string, slug: string): string | null {
  const entity = resolveFilePath(vaultPath, slug, 'entity')
  if (existsSync(entity)) return entity
  const knowledge = resolveFilePath(vaultPath, slug, 'knowledge')
  if (existsSync(knowledge)) return knowledge
  return null
}

/** The file `read` resolves: the mutable kinds first, then a session note. */
export function findReadableFile(vaultPath: string, slug: string): string | null {
  const mutable = findVaultFile(vaultPath, slug)
  if (mutable) return mutable
  const session = resolveFilePath(vaultPath, slug, 'session')
  return existsSync(session) ? session : null
}

/** Does this slug name a vault file? An invalid slug definitionally doesn't
 * exist — reference checks (create parent/related, link targets, validate)
 * must report "does not exist", not crash. validate() in particular exists to
 * REPORT malformed refs. */
export function vaultFileExists(vaultPath: string, slug: string): boolean {
  try { return findVaultFile(vaultPath, slug) !== null } catch { return false }
}

// Separator-agnostic: OS paths use '/' or '\' depending on platform, and a
// POSIX-only check silently classifies every entity as knowledge on Windows
// (all updates then fail on kind rules). Exported pure so win32 paths are
// unit-testable from any platform.
// The DEEPEST kind-dir occurrence wins: the in-vault dir is always deeper
// than any ancestor, so a vault living under a directory named 'entities'
// (e.g. ~/data/entities/myvault) can't shadow its knowledge/ files.
export function kindFromPath(filePath: string): 'entity' | 'knowledge' {
  const lastMatch = (dir: string): number => {
    let idx = -1
    for (const m of filePath.matchAll(new RegExp(`[/\\\\]${dir}[/\\\\]`, 'g'))) idx = m.index
    return idx
  }
  return lastMatch(KIND_DIRS.entity) > lastMatch(KIND_DIRS.knowledge) ? 'entity' : 'knowledge'
}

/** Fields that must always be arrays when present (may be scalar in
 * hand-edited YAML). Parsing coerces them here; merge.ts unions them on
 * conflict — one list, so a new list-valued field cannot be normalized on
 * read and then overwritten wholesale on merge. */
export const ARRAY_FIELDS = ['related', 'tags', 'domain', 'resource']

function normalizeFrontmatter(fm: Record<string, any>): Record<string, any> {
  for (const field of ARRAY_FIELDS) {
    if (field in fm && typeof fm[field] === 'string') {
      fm[field] = [fm[field]]
    }
  }
  return fm
}

/** Full-kind path classification (kindFromPath only distinguishes the
 * indexed kinds — sessions default to knowledge there for compatibility).
 * Session files live directly in sessions/, so only the immediate parent
 * counts — matching anywhere in the path misclassifies every file of a
 * vault that happens to live under a directory named "sessions". */
export function vaultKindFromPath(filePath: string): VaultKind {
  if (new RegExp(`[/\\\\]${KIND_DIRS.session}[/\\\\][^/\\\\]+$`).test(filePath)) return 'session'
  return kindFromPath(filePath)
}

/** Total kind classification for a vault-relative content file (anything
 * matching VAULT_FILE_RE) — derived from KIND_DIRS, so adding a vault dir
 * can't silently fall a new kind through to the wrong one. Throws on paths
 * outside the vault dirs; callers gate on VAULT_FILE_RE first. */
export function vaultKindFromRelPath(relPath: string): VaultKind {
  for (const [kind, dir] of Object.entries(KIND_DIRS) as Array<[VaultKind, string]>) {
    if (relPath.startsWith(`${dir}/`)) return kind
  }
  throw new HafezError('VALIDATION_FAILED', `Not a vault content path: ${relPath}`)
}

export function parseFilePath(path: string): ParsedVaultFile {
  const content = readFileSync(path, 'utf-8')
  const { data, content: body } = matter(content, MATTER_OPTIONS)
  const fm = normalizeFrontmatter(data)
  const trimmed = body.trim()
  const kind = vaultKindFromPath(path)
  // Types over classes (C7): the frontmatter is normalized once here and
  // asserted to the kind's shape — validation of required fields stays with
  // schema.ts and the index builder, which tolerate malformed files.
  if (kind === 'entity') return { kind, frontmatter: fm as EntityFrontmatter, body: trimmed }
  if (kind === 'session') return { kind, frontmatter: fm as SessionFrontmatter, body: trimmed }
  return { kind: 'knowledge', frontmatter: fm as KnowledgeFrontmatter, body: trimmed }
}

export function parseContent(content: string): { frontmatter: Record<string, any>; body: string } {
  const { data, content: body } = matter(content, MATTER_OPTIONS)
  return { frontmatter: normalizeFrontmatter(data), body: body.trim() }
}

export function serializeFile(frontmatter: Record<string, any>, body: string): string {
  return matter.stringify(body.endsWith('\n') ? body : body + '\n', frontmatter)
}

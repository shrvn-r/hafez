// src/vault.ts
import matter from 'gray-matter'
import yaml from 'js-yaml'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { HafezError } from './types.js'
import type { ParsedVaultFile, EntityFrontmatter, KnowledgeFrontmatter, SessionFrontmatter } from './types.js'

// Prevent gray-matter from auto-coercing YAML date strings into JS Date objects
const MATTER_OPTIONS = { engines: { yaml: (s: string) => yaml.load(s, { schema: yaml.JSON_SCHEMA }) as Record<string, any> } }

export function slugify(name: string): string {
  // Unicode-aware: non-Latin letters/digits are kept, so "日本語のメモ" gets a
  // real slug instead of collapsing to ''.
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-|-$/g, '')
    .replace(/-{2,}/g, '-')
}

// ---------------------------------------------------------------------------
// Layout (see CONTEXT.md): the single statement of "what lives where" —
// directory↔kind mapping, vault-file membership, scanning. Every other
// module asks these questions here instead of restating directory names.
// ---------------------------------------------------------------------------

export type VaultKind = 'entity' | 'knowledge' | 'session'

const KIND_DIRS = { entity: 'entities', knowledge: 'knowledge', session: 'sessions' } as const

/** Kinds that live in the SQLite read index (sessions are files-and-git only). */
export const INDEXED_KINDS: ReadonlyArray<'entity' | 'knowledge'> = ['entity', 'knowledge']

/** Vault directory for a kind, relative to the vault root. */
export function kindDir(kind: VaultKind): string {
  return KIND_DIRS[kind]
}

/** A vault content file: anything a sync/merge must treat semantically. */
export const VAULT_FILE_RE = new RegExp(`^(?:${Object.values(KIND_DIRS).join('|')})/.+\\.md$`)

/** True for vault-relative paths whose kind lives in the read index. */
export function isIndexedRelPath(relPath: string): boolean {
  return INDEXED_KINDS.some(k => relPath.startsWith(`${KIND_DIRS[k]}/`))
}

/** History pathspecs covering the indexed dirs (changelog, file times). */
export const INDEXED_DIR_PATHSPECS: ReadonlyArray<string> = INDEXED_KINDS.map(k => `${KIND_DIRS[k]}/`)

/** Classify a vault-relative path into an indexed kind + slug; null outside
 * the indexed dirs (sessions, non-vault files). Nested paths keep their
 * historical shape: entities/archive/x-log.md → entity 'archive/x-log'. */
export function classifyIndexedRelPath(relPath: string): { kind: 'entity' | 'knowledge'; slug: string } | null {
  for (const kind of INDEXED_KINDS) {
    const prefix = `${KIND_DIRS[kind]}/`
    if (relPath.startsWith(prefix)) {
      return { kind, slug: relPath.replace(prefix, '').replace('.md', '') }
    }
  }
  return null
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

// Separator-agnostic: OS paths use '/' or '\' depending on platform, and a
// POSIX-only check silently classifies every entity as knowledge on Windows
// (all updates then fail on kind rules). Exported pure so win32 paths are
// unit-testable from any platform.
export function kindFromPath(filePath: string): 'entity' | 'knowledge' {
  return /[/\\]entities[/\\]/.test(filePath) ? 'entity' : 'knowledge'
}

// Fields that must always be arrays when present (may be scalar in hand-edited YAML)
const ARRAY_FIELDS = ['related', 'tags', 'domain']

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

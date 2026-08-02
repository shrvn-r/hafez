// src/vault.ts
import matter from 'gray-matter'
import yaml from 'js-yaml'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { HafezError } from './types.js'

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

// Slugs are path components: anything with separators (or a leading dot, or a
// Windows drive colon) could escape the vault — "../../outside/secret" reads,
// writes, and deletes files anywhere on disk. Block only those; spaces and
// non-Latin names are legitimate in a hand-edited (Obsidian) vault. Single
// choke point for every slug-consuming operation.
export function resolveFilePath(vaultPath: string, slug: string, kind: 'entity' | 'knowledge'): string {
  if (!slug || slug.startsWith('.') || /[/\\:\0]/.test(slug)) {
    throw new HafezError('VALIDATION_FAILED', `Invalid slug: '${slug}'`)
  }
  const dir = kind === 'entity' ? 'entities' : 'knowledge'
  return join(vaultPath, dir, `${slug}.md`)
}

// Separator-agnostic: OS paths use '/' or '\' depending on platform, and a
// POSIX-only check silently classifies every entity as knowledge on Windows
// (all updates then fail on kind rules). Exported pure so win32 paths are
// unit-testable from any platform.
export function kindFromPath(filePath: string): 'entity' | 'knowledge' {
  return /[/\\]entities[/\\]/.test(filePath) ? 'entity' : 'knowledge'
}

export function slugExists(vaultPath: string, slug: string): boolean {
  return existsSync(resolveFilePath(vaultPath, slug, 'entity'))
    || existsSync(resolveFilePath(vaultPath, slug, 'knowledge'))
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

export function parseFilePath(path: string): { frontmatter: Record<string, any>; body: string } {
  const content = readFileSync(path, 'utf-8')
  const { data, content: body } = matter(content, MATTER_OPTIONS)
  return { frontmatter: normalizeFrontmatter(data), body: body.trim() }
}

export function parseContent(content: string): { frontmatter: Record<string, any>; body: string } {
  const { data, content: body } = matter(content, MATTER_OPTIONS)
  return { frontmatter: normalizeFrontmatter(data), body: body.trim() }
}

export function serializeFile(frontmatter: Record<string, any>, body: string): string {
  return matter.stringify(body.endsWith('\n') ? body : body + '\n', frontmatter)
}

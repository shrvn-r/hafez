// src/vault.ts
import matter from 'gray-matter'
import yaml from 'js-yaml'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'

// Prevent gray-matter from auto-coercing YAML date strings into JS Date objects
const MATTER_OPTIONS = { engines: { yaml: (s: string) => yaml.load(s, { schema: yaml.JSON_SCHEMA }) as Record<string, any> } }

export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/-{2,}/g, '-')
}

export function resolveFilePath(vaultPath: string, slug: string, kind: 'entity' | 'knowledge'): string {
  const dir = kind === 'entity' ? 'entities' : 'knowledge'
  return join(vaultPath, dir, `${slug}.md`)
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

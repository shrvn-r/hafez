// tests/vault.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { parseFilePath, parseContent, serializeFile, slugify, resolveFilePath, kindFromPath, vaultKindFromPath } from '../src/vault.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join, posix, win32 } from 'path'
import { tmpdir } from 'os'

const TMP = join(tmpdir(), 'hafez-test-vault-' + Date.now())

describe('slugify', () => {
  it('converts name to kebab-case', () => {
    expect(slugify('Dashboard Scheduler Upgrade')).toBe('dashboard-scheduler-upgrade')
  })
  it('handles special characters', () => {
    expect(slugify("Parisa's 30K Business")).toBe('parisas-30k-business')
  })
  it('collapses multiple hyphens', () => {
    expect(slugify('foo  --  bar')).toBe('foo-bar')
  })
  it('keeps non-Latin characters instead of collapsing to empty', () => {
    expect(slugify('日本語のメモ')).toBe('日本語のメモ')
    expect(slugify('Café Notes')).toBe('café-notes')
  })
})

describe('resolveFilePath', () => {
  it('resolves entity path', () => {
    expect(resolveFilePath('/vault', 'simorgh', 'entity')).toBe('/vault/entities/simorgh.md')
  })
  it('resolves knowledge path', () => {
    expect(resolveFilePath('/vault', 'my-pattern', 'knowledge')).toBe('/vault/knowledge/my-pattern.md')
  })

  // SEC-1: slugs are path components — anything that can escape the vault must throw
  it('rejects path traversal slugs', () => {
    for (const slug of [
      '../../outside/secret',
      '../evil',
      'a/b',
      'a\\b',
      '/etc/passwd',
      'C:\\evil',
      '.hidden',
      '..',
      '',
    ]) {
      expect(() => resolveFilePath('/vault', slug, 'entity'), `slug: ${slug}`).toThrow('Invalid slug')
    }
  })

  it('accepts the names a hand-edited vault actually contains', () => {
    for (const slug of ['simorgh', 'my-pattern', 'v1.0-notes', 'some_slug', 'A-Mixed-Case', 'my note', '日本語のメモ']) {
      expect(() => resolveFilePath('/vault', slug, 'entity'), `slug: ${slug}`).not.toThrow()
    }
  })
})

describe('kindFromPath', () => {
  // Regression for the Windows update blocker: a POSIX-only separator check
  // classified every entity as knowledge on win32, so every mutating update
  // failed on entity-only kind rules. Paths built with path.win32/path.posix
  // exercise both platforms from any host OS.
  it('classifies POSIX paths', () => {
    expect(kindFromPath(posix.join('/vault', 'entities', 'simorgh.md'))).toBe('entity')
    expect(kindFromPath(posix.join('/vault', 'knowledge', 'my-pattern.md'))).toBe('knowledge')
  })

  it('classifies win32 paths', () => {
    expect(kindFromPath(win32.join('C:\\vault', 'entities', 'simorgh.md'))).toBe('entity')
    expect(kindFromPath(win32.join('C:\\vault', 'knowledge', 'my-pattern.md'))).toBe('knowledge')
  })

  it('classifies mixed-separator paths (drvfs/WSL)', () => {
    expect(kindFromPath('C:\\Users\\x\\vault/entities/simorgh.md')).toBe('entity')
    expect(kindFromPath('/mnt/c/vault\\entities\\simorgh.md')).toBe('entity')
  })

  it('does not match "entities" as a filename or slug substring', () => {
    expect(kindFromPath(win32.join('C:\\vault', 'knowledge', 'entities.md'))).toBe('knowledge')
    expect(kindFromPath(posix.join('/vault', 'knowledge', 'legal-entities-note.md'))).toBe('knowledge')
  })
})

describe('vaultKindFromPath', () => {
  it('classifies session files by their immediate parent dir', () => {
    expect(vaultKindFromPath(posix.join('/vault', 'sessions', '2026-08-05.md'))).toBe('session')
    expect(vaultKindFromPath(win32.join('C:\\vault', 'sessions', '2026-08-05.md'))).toBe('session')
  })

  it('a vault living under a directory named "sessions" is not misclassified', () => {
    // Only the immediate parent counts — an ancestor named sessions must not
    // turn every entity into a session
    expect(vaultKindFromPath(posix.join('/data/sessions/vault', 'entities', 'foo.md'))).toBe('entity')
    expect(vaultKindFromPath(posix.join('/data/sessions/vault', 'knowledge', 'bar.md'))).toBe('knowledge')
  })
})

describe('parseFilePath', () => {
  beforeAll(() => {
    mkdirSync(join(TMP, 'entities'), { recursive: true })
    writeFileSync(join(TMP, 'entities/test-entity.md'), [
      '---',
      'name: Test Entity',
      'type: project',
      'status: active',
      'created: 2026-03-10',
      'last-touched: 2026-03-10',
      '---',
      '',
      '## Purpose',
      'A test project.',
      '',
      '## Session Log',
      '### 2026-03-10 — Claude [progress]',
      'Summary: Did something',
      '- detail',
    ].join('\n'))
  })
  afterAll(() => rmSync(TMP, { recursive: true, force: true }))

  it('parses frontmatter and body', () => {
    const result = parseFilePath(join(TMP, 'entities/test-entity.md'))
    expect(result.frontmatter.name).toBe('Test Entity')
    expect(result.frontmatter.type).toBe('project')
    expect(result.body).toContain('## Purpose')
  })
  it('preserves date fields as strings, not Date objects', () => {
    const result = parseFilePath(join(TMP, 'entities/test-entity.md'))
    expect(typeof result.frontmatter.created).toBe('string')
    expect(result.frontmatter.created).toBe('2026-03-10')
  })
})

describe('parseContent', () => {
  it('parses raw markdown content', () => {
    const content = '---\nname: Inline\ntype: idea\nstatus: active\ncreated: 2026-03-10\nlast-touched: 2026-03-10\n---\n\n## Hypothesis\nSomething.\n'
    const result = parseContent(content)
    expect(result.frontmatter.name).toBe('Inline')
    expect(result.body).toContain('## Hypothesis')
  })
})

describe('frontmatter normalization', () => {
  it('converts scalar related to array', () => {
    const content = '---\nname: Test\nrelated: simorgh\ncreated: 2026-01-01\n---\nbody\n'
    const result = parseContent(content)
    expect(Array.isArray(result.frontmatter.related)).toBe(true)
    expect(result.frontmatter.related).toEqual(['simorgh'])
  })

  it('converts scalar tags to array', () => {
    const content = '---\nname: Test\ntags: infra\ncreated: 2026-01-01\n---\nbody\n'
    const result = parseContent(content)
    expect(Array.isArray(result.frontmatter.tags)).toBe(true)
    expect(result.frontmatter.tags).toEqual(['infra'])
  })

  it('leaves array related untouched', () => {
    const content = '---\nname: Test\nrelated:\n  - a\n  - b\ncreated: 2026-01-01\n---\nbody\n'
    const result = parseContent(content)
    expect(result.frontmatter.related).toEqual(['a', 'b'])
  })

  it('normalizes scalar domain on knowledge notes', () => {
    const content = '---\nname: Test\nconfidence: pattern\ndomain: engineering\ncreated: 2026-01-01\n---\nbody\n'
    const result = parseContent(content)
    expect(Array.isArray(result.frontmatter.domain)).toBe(true)
    expect(result.frontmatter.domain).toEqual(['engineering'])
  })

  it('normalizes scalar domain on entity notes to array', () => {
    const content = '---\nname: Test\ntype: project\nstatus: active\ndomain: backend\ncreated: 2026-01-01\n---\nbody\n'
    const result = parseContent(content)
    expect(Array.isArray(result.frontmatter.domain)).toBe(true)
    expect(result.frontmatter.domain).toEqual(['backend'])
  })
})

describe('serializeFile', () => {
  it('round-trips frontmatter and body', () => {
    const fm = { name: 'Test', type: 'project', status: 'active', created: '2026-03-10', 'last-touched': '2026-03-10' }
    const body = '## Purpose\nA test.\n'
    const serialized = serializeFile(fm, body)
    expect(serialized).toContain('name: Test')
    expect(serialized).toContain('## Purpose')
    const reparsed = parseContent(serialized)
    expect(reparsed.frontmatter.name).toBe('Test')
  })
})

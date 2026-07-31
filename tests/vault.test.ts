// tests/vault.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { parseFilePath, parseContent, serializeFile, slugify, resolveFilePath } from '../src/vault.js'
import { writeFileSync, mkdirSync, rmSync } from 'fs'
import { join } from 'path'
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
})

describe('resolveFilePath', () => {
  it('resolves entity path', () => {
    expect(resolveFilePath('/vault', 'simorgh', 'entity')).toBe('/vault/entities/simorgh.md')
  })
  it('resolves knowledge path', () => {
    expect(resolveFilePath('/vault', 'my-pattern', 'knowledge')).toBe('/vault/knowledge/my-pattern.md')
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

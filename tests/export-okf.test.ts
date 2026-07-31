// tests/export-okf.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { exportOkf } from '../src/export-okf.js'
import { parseFilePath, parseContent, serializeFile } from '../src/vault.js'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'

let vault: string
let out: string

beforeEach(() => {
  const base = join(tmpdir(), `hafez-okf-${randomUUID()}`)
  vault = join(base, 'vault')
  out = join(base, 'bundle')
  mkdirSync(join(vault, 'entities'), { recursive: true })
  mkdirSync(join(vault, 'knowledge'), { recursive: true })
  mkdirSync(join(vault, 'sessions'), { recursive: true })
})

afterEach(() => {
  rmSync(join(vault, '..'), { recursive: true, force: true })
})

function writeEntity(slug: string, fm: Record<string, any>, body = '## Purpose\n\nTest\n\n## Session Log\n') {
  writeFileSync(join(vault, 'entities', `${slug}.md`), serializeFile(fm, body))
}

function writeKnowledge(slug: string, fm: Record<string, any>, body = '## Synthesis\n\nInsight line.\n\n## Evidence\n') {
  writeFileSync(join(vault, 'knowledge', `${slug}.md`), serializeFile(fm, body))
}

function writeSession(slug: string, fm: Record<string, any>, body = '## Summary\n\nSession summary line.\n') {
  writeFileSync(join(vault, 'sessions', `${slug}.md`), serializeFile(fm, body))
}

describe('exportOkf frontmatter mapping', () => {
  it('maps entity, knowledge, and session frontmatter to OKF fields', () => {
    writeEntity('proj', {
      name: 'My Project', type: 'project', status: 'active',
      created: '2026-01-01', 'last-touched': '2026-02-02',
      description: 'A project', resource: 'https://github.com/org/repo',
      tags: ['infra'], domain: ['backend'],
    })
    writeKnowledge('plan-note', {
      name: 'Plan Note', subtype: 'plan', created: '2026-01-05',
      'last-reinforced': '2026-03-03', confidence: 'pattern',
    })
    writeSession('session-a', { name: 'Session A', created: '2026-01-10', 'session-date': '2026-01-09' })

    const report = exportOkf(vault, out)
    expect(report.entities).toBe(1)
    expect(report.knowledge).toBe(1)
    expect(report.sessions).toBe(1)

    const ent = parseFilePath(join(out, 'entities', 'proj.md')).frontmatter
    expect(ent.type).toBe('project')
    expect(ent.title).toBe('My Project')
    expect(ent.description).toBe('A project')
    expect(ent.resource).toBe('https://github.com/org/repo')
    expect(ent.tags).toEqual(['infra'])
    expect(ent.timestamp).toBe('2026-02-02')
    // Remaining original keys carried verbatim; name dropped
    expect(ent.domain).toEqual(['backend'])
    expect(ent.status).toBe('active')
    expect(ent.created).toBe('2026-01-01')
    expect(ent.name).toBeUndefined()

    const kn = parseFilePath(join(out, 'knowledge', 'plan-note.md')).frontmatter
    expect(kn.type).toBe('knowledge/plan')
    expect(kn.title).toBe('Plan Note')
    expect(kn.timestamp).toBe('2026-03-03')
    expect(kn.confidence).toBe('pattern')

    const ses = parseFilePath(join(out, 'sessions', 'session-a.md')).frontmatter
    expect(ses.type).toBe('session')
    expect(ses.timestamp).toBe('2026-01-09')
    expect(ses.description).toBe('Session summary line.')
  })

  it('falls back to knowledge without subtype as type knowledge and Synthesis description', () => {
    writeKnowledge('bare-note', { name: 'Bare Note', created: '2026-01-01' })
    exportOkf(vault, out)
    const kn = parseFilePath(join(out, 'knowledge', 'bare-note.md')).frontmatter
    expect(kn.type).toBe('knowledge')
    expect(kn.description).toBe('Insight line.')
    expect(kn.timestamp).toBe('2026-01-01')
  })

  it('uses first Brief line as entity description fallback', () => {
    writeEntity('briefed', {
      name: 'Briefed', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01',
    }, '## Brief\n\nBrief first line.\nSecond line.\n\n## Session Log\n')
    exportOkf(vault, out)
    const ent = parseFilePath(join(out, 'entities', 'briefed.md')).frontmatter
    expect(ent.description).toBe('Brief first line.')
  })
})

describe('exportOkf link rewriting', () => {
  it('rewrites [[slug]] and [[slug|display]] to bundle-root-absolute markdown links', () => {
    writeEntity('alpha', { name: 'Alpha', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' },
      'See [[beta]] and [[beta|the beta project]].\n\n## Session Log\n')
    writeEntity('beta', { name: 'Beta', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' })

    const report = exportOkf(vault, out)
    const body = parseFilePath(join(out, 'entities', 'alpha.md')).body
    expect(body).toContain('[beta](/entities/beta.md)')
    expect(body).toContain('[the beta project](/entities/beta.md)')
    expect(report.unresolvedLinks).toBe(0)
  })

  it('resolves cross-kind links to the target kind directory, never hardcoded', () => {
    writeEntity('linker', { name: 'Linker', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' },
      'Links: [[some-note]] and [[some-session]].\n\n## Session Log\n')
    writeKnowledge('some-note', { name: 'Some Note', created: '2026-01-01' })
    writeSession('some-session', { name: 'Some Session', created: '2026-01-01' })

    exportOkf(vault, out)
    const body = parseFilePath(join(out, 'entities', 'linker.md')).body
    expect(body).toContain('[some-note](/knowledge/some-note.md)')
    expect(body).toContain('[some-session](/sessions/some-session.md)')
  })

  it('resolves cross-kind slug collision to the entity path (first-write-wins)', () => {
    writeEntity('dupe', { name: 'Dupe Entity', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' })
    writeKnowledge('dupe', { name: 'Dupe Note', created: '2026-01-01' })
    writeEntity('pointer', { name: 'Pointer', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' },
      'Points at [[dupe]].\n\n## Session Log\n')

    exportOkf(vault, out)
    const body = parseFilePath(join(out, 'entities', 'pointer.md')).body
    expect(body).toContain('[dupe](/entities/dupe.md)')
    expect(body).not.toContain('/knowledge/dupe.md')
  })

  it('trims whitespace in Obsidian-style spaced links before resolving', () => {
    writeEntity('spacer', { name: 'Spacer', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' },
      'See [[ beta ]] and [[beta | the beta project]].\n\n## Session Log\n')
    writeEntity('beta', { name: 'Beta', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' })

    const report = exportOkf(vault, out)
    const body = parseFilePath(join(out, 'entities', 'spacer.md')).body
    expect(body).toContain('[beta](/entities/beta.md)')
    expect(body).toContain('[the beta project](/entities/beta.md)')
    expect(report.unresolvedLinks).toBe(0)
  })

  it('renders unresolved links as plain text and counts them', () => {
    writeEntity('lonely', { name: 'Lonely', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' },
      'Mentions [[ghost]] and [[ghost|a ghost]].\n\n## Session Log\n')

    const report = exportOkf(vault, out)
    const body = parseFilePath(join(out, 'entities', 'lonely.md')).body
    expect(body).toContain('Mentions ghost and a ghost.')
    expect(body).not.toContain('[[')
    expect(report.unresolvedLinks).toBe(2)
  })
})

describe('exportOkf guards and edge cases', () => {
  it('refuses an outDir inside the vault', () => {
    expect(() => exportOkf(vault, join(vault, 'export'))).toThrow('inside the vault')
    expect(() => exportOkf(vault, vault)).toThrow('inside the vault')
  })

  it('refuses a non-empty outDir that is not a prior bundle', () => {
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'unrelated.txt'), 'hello')
    expect(() => exportOkf(vault, out)).toThrow('not a prior OKF bundle')
  })

  it('re-exports over a prior bundle in place', () => {
    writeEntity('stable', { name: 'Stable', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' })
    exportOkf(vault, out)
    writeEntity('newcomer', { name: 'Newcomer', type: 'entity', status: 'active', created: '2026-01-02', 'last-touched': '2026-01-02' })
    const report = exportOkf(vault, out)
    expect(report.entities).toBe(2)
    expect(existsSync(join(out, 'entities', 'newcomer.md'))).toBe(true)
  })

  it('skips malformed files and reports them', () => {
    writeEntity('good', { name: 'Good', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01' })
    writeFileSync(join(vault, 'entities', 'broken.md'), '---\nname: [unclosed\n---\n\nbody\n')
    writeFileSync(join(vault, 'knowledge', 'nameless.md'), serializeFile({ created: '2026-01-01' }, '## Synthesis\n'))

    const report = exportOkf(vault, out)
    expect(report.entities).toBe(1)
    expect(report.skipped).toHaveLength(2)
    expect(report.skipped.some(s => s.file === 'entities/broken.md')).toBe(true)
    expect(report.skipped.some(s => s.file === 'knowledge/nameless.md' && s.reason === 'missing name')).toBe(true)
    expect(existsSync(join(out, 'entities', 'broken.md'))).toBe(false)
  })

  it('exports an empty vault as root index.md only with zero counts', () => {
    const report = exportOkf(vault, out)
    expect(report.entities).toBe(0)
    expect(report.knowledge).toBe(0)
    expect(report.sessions).toBe(0)
    expect(readdirSync(out)).toEqual(['index.md'])
  })
})

describe('exportOkf OKF v0.1 conformance', () => {
  it('produced bundle satisfies the three conformance rules', () => {
    writeEntity('proj', {
      name: 'Proj', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01',
      description: 'A described project',
    })
    writeKnowledge('note', { name: 'Note', created: '2026-01-01' })
    writeSession('sess', { name: 'Sess', created: '2026-01-01' })

    exportOkf(vault, out)

    // Rule 1+2: every non-index .md has parseable frontmatter with non-empty string type
    for (const dir of ['entities', 'knowledge', 'sessions']) {
      for (const file of readdirSync(join(out, dir))) {
        if (file === 'index.md') continue
        const { frontmatter } = parseFilePath(join(out, dir, file))
        expect(typeof frontmatter.type).toBe('string')
        expect(frontmatter.type.length).toBeGreaterThan(0)
      }
      // Rule 3a: subdir index.md has NO frontmatter
      const idx = readFileSync(join(out, dir, 'index.md'), 'utf-8')
      expect(idx.startsWith('---')).toBe(false)
      const parsed = parseContent(idx)
      expect(parsed.frontmatter).toEqual({})
    }

    // Rule 3b: root index.md frontmatter is exactly { okf_version: '0.1' }
    const root = parseFilePath(join(out, 'index.md'))
    expect(root.frontmatter).toEqual({ okf_version: '0.1' })
    expect(root.body).toContain('[Entities](/entities/index.md)')
    expect(root.body).toContain('1 concepts')

    // Subdir index bullets carry description
    const entIdx = readFileSync(join(out, 'entities', 'index.md'), 'utf-8')
    expect(entIdx).toContain('- [Proj](/entities/proj.md) — A described project')
  })
})

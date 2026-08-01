// tests/merge.test.ts
import { describe, it, expect } from 'vitest'
import { mergeVaultContent } from '../src/merge.js'
import { parseContent } from '../src/vault.js'
import matter from 'gray-matter'

// Helper to build vault file content
function vaultFile(fm: Record<string, any>, body = ''): string {
  const yaml = Object.entries(fm)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map(i => `  - ${i}`).join('\n')}`
      return `${k}: ${v}`
    })
    .join('\n')
  return `---\n${yaml}\n---\n${body}`
}

describe('mergeVaultContent', () => {
  // 1. Scalar conflict — local wins
  it('local wins for scalar fields (status, name, type)', () => {
    const remote = vaultFile({ name: 'Foo', type: 'project', status: 'paused', created: '2026-01-01', 'last-touched': '2026-03-23' })
    const local = vaultFile({ name: 'Foo', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' })
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('status: active')
  })

  // 2. Date fields take latest
  it('takes the latest date for last-touched', () => {
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' })
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-20' })
    const merged = mergeVaultContent(remote, local)
    const parsed = parseContent(merged)
    expect(parsed.frontmatter['last-touched']).toBe('2026-03-23')
  })

  // 3. Count fields take max
  it('takes max for reinforcement-count', () => {
    const remote = vaultFile({ name: 'K', confidence: 'pattern', created: '2026-01-01', 'reinforcement-count': 5 })
    const local = vaultFile({ name: 'K', confidence: 'pattern', created: '2026-01-01', 'reinforcement-count': 3 })
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('reinforcement-count: 5')
  })

  // 4. Array union (related)
  it('unions related arrays', () => {
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23', related: ['a', 'b', 'c'] })
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23', related: ['b', 'd', 'e'] })
    const merged = mergeVaultContent(remote, local)
    for (const slug of ['a', 'b', 'c', 'd', 'e']) {
      expect(merged).toContain(slug)
    }
  })

  // 5. Array union — all items preserved without cap
  it('unions related arrays without cap, preserving all items', () => {
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23', related: ['a', 'b', 'c'] })
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23', related: ['d', 'e', 'f'] })
    const result = mergeVaultContent(remote, local)
    const parsed = parseContent(result)
    const related = parsed.frontmatter.related as string[]
    expect(related).toHaveLength(6)
    expect(related).toContain('a')
    expect(related).toContain('d')
    expect(related).toContain('e')
    expect(related).toContain('f')
  })

  // 6. Tags union (no cap)
  it('unions tags without cap', () => {
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23', tags: ['x', 'y'] })
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23', tags: ['y', 'z'] })
    const merged = mergeVaultContent(remote, local)
    for (const tag of ['x', 'y', 'z']) {
      expect(merged).toContain(tag)
    }
  })

  // 7. Knowledge domain array union
  it('unions knowledge domain arrays', () => {
    const remote = vaultFile({ name: 'K', confidence: 'observation', created: '2026-01-01', domain: ['health', 'finance'] })
    const local = vaultFile({ name: 'K', confidence: 'observation', created: '2026-01-01', domain: ['health', 'tech'] })
    const merged = mergeVaultContent(remote, local)
    for (const d of ['health', 'finance', 'tech']) {
      expect(merged).toContain(d)
    }
  })

  // 8. Session log entries from both sides preserved
  it('merges session log entries from both sides', () => {
    const remoteBody = '\n## Session Log\n\n### 2026-03-23 — Simorgh [progress]\nSummary: Did thing A\n'
    const localBody = '\n## Session Log\n\n### 2026-03-23 — Claude [decision]\nSummary: Did thing B\n'
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, remoteBody)
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, localBody)
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('Simorgh [progress]')
    expect(merged).toContain('Claude [decision]')
    expect(merged).toContain('Did thing A')
    expect(merged).toContain('Did thing B')
  })

  // 9. Session log deduplication — local wins for same identity
  it('deduplicates session log entries by identity, local wins', () => {
    const remoteBody = '\n## Session Log\n\n### 2026-03-23 — Simorgh [progress]\nSummary: Remote version\n'
    const localBody = '\n## Session Log\n\n### 2026-03-23 — Simorgh [progress]\nSummary: Local version\n'
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, remoteBody)
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, localBody)
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('Local version')
    expect(merged).not.toContain('Remote version')
  })

  // 10. Next Actions from both sides preserved
  it('unions Next Actions from both sides', () => {
    const remoteBody = '\n## Next Actions\n\n- [ ] Deploy fix\n- [ ] Write docs\n'
    const localBody = '\n## Next Actions\n\n- [ ] Write tests\n- [ ] Deploy fix\n'
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, remoteBody)
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, localBody)
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('- [ ] Deploy fix')
    expect(merged).toContain('- [ ] Write docs')
    expect(merged).toContain('- [ ] Write tests')
    const deployCount = (merged.match(/Deploy fix/g) ?? []).length
    expect(deployCount).toBe(1)
  })

  // 11. Brief takes local
  it('takes local Brief over remote', () => {
    const remoteBody = '\n## Brief\n\nRemote context\n'
    const localBody = '\n## Brief\n\nLocal context\n'
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, remoteBody)
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, localBody)
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('Local context')
    expect(merged).not.toContain('Remote context')
  })

  // 12. Remote-only section preserved
  it('preserves sections from remote not present in local', () => {
    const remoteBody = '\n## Current State\n\nSome state info\n\n## Session Log\n\n### 2026-03-23 — Simorgh [progress]\nSummary: x\n'
    const localBody = '\n## Session Log\n\n### 2026-03-23 — Claude [progress]\nSummary: y\n'
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, remoteBody)
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, localBody)
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('## Current State')
    expect(merged).toContain('Some state info')
  })

  // 13. Missing field on one side handled
  it('preserves related from remote when local has none', () => {
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23', related: ['foo'] })
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' })
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('foo')
  })

  // 14. Checked Next Actions preserved from either side
  it('preserves checked state from either side', () => {
    const remoteBody = '\n## Next Actions\n\n- [x] Done task\n- [ ] Open task\n'
    const localBody = '\n## Next Actions\n\n- [ ] Open task\n- [ ] New task\n'
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, remoteBody)
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, localBody)
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('- [x] Done task')
    expect(merged).toContain('- [ ] Open task')
    expect(merged).toContain('- [ ] New task')
  })

  // 15. Malformed input: empty file
  it('handles empty remote gracefully', () => {
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' })
    const merged = mergeVaultContent('', local)
    expect(merged).toContain('name: A')
  })

  // 16. Malformed input: missing frontmatter
  it('handles remote with no frontmatter', () => {
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' })
    const merged = mergeVaultContent('just some text', local)
    expect(merged).toContain('name: A')
  })

  // 17. Malformed input: scalar where array expected
  it('handles scalar related field on one side', () => {
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23', related: 'single-slug' as any })
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23', related: ['other-slug'] })
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('single-slug')
    expect(merged).toContain('other-slug')
  })

  it('preserves more than 5 related items during merge', () => {
    const remote = vaultFile({
      name: 'Test', type: 'entity', status: 'active',
      created: '2026-01-01', 'last-touched': '2026-01-01',
      related: ['a', 'b', 'c', 'd', 'e', 'f']
    })
    const local = vaultFile({
      name: 'Test', type: 'entity', status: 'active',
      created: '2026-01-01', 'last-touched': '2026-01-02',
      related: ['a', 'b', 'c', 'd', 'e', 'g', 'h']
    })
    const result = mergeVaultContent(remote, local)
    const { data } = matter(result)
    expect(data.related).toContain('f')
    expect(data.related).toContain('g')
    expect(data.related).toContain('h')
    expect(data.related.length).toBeGreaterThan(5)
  })

  it('unions entity domain arrays', () => {
    const remote = vaultFile({ name: 'P', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01', domain: ['backend', 'infra'] })
    const local = vaultFile({ name: 'P', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01', domain: ['backend', 'devops'] })
    const merged = mergeVaultContent(remote, local)
    const fm = parseContent(merged).frontmatter
    expect(fm.domain).toContain('backend')
    expect(fm.domain).toContain('infra')
    expect(fm.domain).toContain('devops')
    expect(fm.domain.length).toBe(3)
  })

  it('merges scalar domain with array domain during transition', () => {
    const remote = vaultFile({ name: 'P', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01', domain: 'backend' })
    const local = vaultFile({ name: 'P', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-01', domain: ['backend', 'infra'] })
    const merged = mergeVaultContent(remote, local)
    const fm = parseContent(merged).frontmatter
    expect(fm.domain).toContain('backend')
    expect(fm.domain).toContain('infra')
    expect(fm.domain.length).toBe(2)
  })

  // --- COR-4: union appends, newest-wins scalars ---

  it('unions Evidence lines from both sides (COR-4)', () => {
    const remoteBody = '\n## Evidence\n\n- Remote observed the pattern again\n- Shared evidence line\n'
    const localBody = '\n## Evidence\n\n- Shared evidence line\n- Local observed a counterexample\n'
    const remote = vaultFile({ name: 'K', confidence: 'pattern', created: '2026-01-01', 'last-touched': '2026-03-23' }, remoteBody)
    const local = vaultFile({ name: 'K', confidence: 'pattern', created: '2026-01-01', 'last-touched': '2026-03-23' }, localBody)
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('Remote observed the pattern again')
    expect(merged).toContain('Local observed a counterexample')
    const sharedCount = (merged.match(/Shared evidence line/g) ?? []).length
    expect(sharedCount).toBe(1)
  })

  it('unions Sources lines from both sides (COR-4)', () => {
    const remoteBody = '\n## Sources\n\n- https://example.com/remote\n'
    const localBody = '\n## Sources\n\n- https://example.com/local\n'
    const remote = vaultFile({ name: 'K', confidence: 'pattern', created: '2026-01-01', 'last-touched': '2026-03-23' }, remoteBody)
    const local = vaultFile({ name: 'K', confidence: 'pattern', created: '2026-01-01', 'last-touched': '2026-03-23' }, localBody)
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('https://example.com/remote')
    expect(merged).toContain('https://example.com/local')
  })

  it('remote wins scalars and scalar sections when remote is newer (COR-4)', () => {
    const remoteBody = '\n## Brief\n\nRemote context\n'
    const localBody = '\n## Brief\n\nLocal context\n'
    const remote = vaultFile({ name: 'A', type: 'project', status: 'paused', created: '2026-01-01', 'last-touched': '2026-03-25' }, remoteBody)
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, localBody)
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('status: paused')
    expect(merged).toContain('Remote context')
    expect(merged).not.toContain('Local context')
    expect(parseContent(merged).frontmatter['last-touched']).toBe('2026-03-25')
  })

  it('local wins scalars on last-touched tie (COR-4)', () => {
    const remote = vaultFile({ name: 'A', type: 'project', status: 'paused', created: '2026-01-01', 'last-touched': '2026-03-23' })
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' })
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('status: active')
  })

  it('still unions append-only sections when remote is newer (COR-4)', () => {
    const remoteBody = '\n## Session Log\n\n### 2026-03-25 — Simorgh [progress]\nSummary: Remote work\n'
    const localBody = '\n## Session Log\n\n### 2026-03-23 — Claude [progress]\nSummary: Local work\n'
    const remote = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-25' }, remoteBody)
    const local = vaultFile({ name: 'A', type: 'project', status: 'active', created: '2026-01-01', 'last-touched': '2026-03-23' }, localBody)
    const merged = mergeVaultContent(remote, local)
    expect(merged).toContain('Remote work')
    expect(merged).toContain('Local work')
  })
})

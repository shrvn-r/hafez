// tests/format.test.ts
import { describe, it, expect } from 'vitest'
import { formatEntityHeader, formatKnowledgeHeader, formatQueryTable, formatKnowledgeTable, formatSearchResults, formatValidation } from '../src/cli/format.js'

describe('formatEntityHeader', () => {
  it('renders entity as markdown header block', () => {
    const result = formatEntityHeader({
      name: 'Test Project',
      type: 'project',
      status: 'active',
      domain: ['backend'],
      parent: 'parent-proj',
      'last-touched': '2026-03-14',
      created: '2026-01-01',
    }, '## Purpose\n\nTest purpose\n\n## Session Log\n')

    expect(result).toContain('# Test Project')
    expect(result).toContain('status: active')
    expect(result).toContain('type: project')
    expect(result).toContain('## Purpose')
  })

  it('omits optional fields when absent', () => {
    const result = formatEntityHeader({
      name: 'Minimal',
      type: 'entity',
      status: 'paused',
      created: '2026-01-01',
      'last-touched': '2026-03-14',
    }, '')

    expect(result).toContain('# Minimal')
    expect(result).toContain('status: paused')
    expect(result).not.toContain('parent:')
    expect(result).not.toContain('next-action:')
    expect(result).not.toContain('domain:')
  })

  it('renders description line when set', () => {
    const result = formatEntityHeader({
      name: 'Described',
      type: 'entity',
      status: 'active',
      description: 'One-line entity summary',
      created: '2026-01-01',
      'last-touched': '2026-03-14',
    }, '')

    expect(result).toContain('> One-line entity summary')
  })

  it('renders resource line when set', () => {
    const result = formatEntityHeader({
      name: 'Resourced',
      type: 'entity',
      status: 'active',
      resource: 'https://github.com/org/repo',
      created: '2026-01-01',
      'last-touched': '2026-03-14',
    }, '')

    expect(result).toContain('resource: https://github.com/org/repo')
  })

  it('renders related and tags when present', () => {
    const result = formatEntityHeader({
      name: 'Tagged',
      type: 'project',
      status: 'active',
      created: '2026-01-01',
      'last-touched': '2026-03-14',
      related: ['slug-a', 'slug-b'],
      tags: ['backend', 'priority'],
    }, '')

    expect(result).toContain('related: slug-a, slug-b')
    expect(result).toContain('tags: backend, priority')
  })
})

describe('formatKnowledgeHeader', () => {
  it('renders knowledge note as markdown header block', () => {
    const result = formatKnowledgeHeader({
      name: 'TDD Pattern',
      confidence: 'pattern',
      domain: ['engineering', 'testing'],
      'reinforcement-count': 3,
      'last-reinforced': '2026-03-10',
      related: ['proj-a'],
      created: '2026-01-01',
    }, '## Insight\n\nTest insight\n')

    expect(result).toContain('# TDD Pattern')
    expect(result).toContain('confidence: pattern')
    expect(result).toContain('domain: engineering, testing')
    expect(result).toContain('reinforcement-count: 3')
    expect(result).toContain('last-reinforced: 2026-03-10')
    expect(result).toContain('related: proj-a')
    expect(result).toContain('## Insight')
  })

  it('omits optional fields when absent', () => {
    const result = formatKnowledgeHeader({
      name: 'Bare Note',
      created: '2026-01-01',
    }, 'body text')

    expect(result).toContain('# Bare Note')
    expect(result).toContain('body text')
    expect(result).not.toContain('confidence:')
    expect(result).not.toContain('reinforcement-count:')
  })
})

describe('formatKnowledgeHeader description', () => {
  it('renders description line when set', () => {
    const result = formatKnowledgeHeader({
      name: 'Described Note',
      confidence: 'observation',
      description: 'One-line knowledge summary',
      created: '2026-01-01',
    }, '')

    expect(result).toContain('> One-line knowledge summary')
  })
})

describe('formatQueryTable', () => {
  it('renders entity results as markdown table', () => {
    const result = formatQueryTable([
      { slug: 'proj-a', name: 'Project A', type: 'project', status: 'active', last_touched: '2026-03-14', next_action: 'Do thing', next_action_count: 1, parent: null, related: [] },
      { slug: 'proj-b', name: 'Project B', type: 'entity', status: 'paused', last_touched: '2026-03-01', next_action: null, next_action_count: 0, parent: 'proj-a', related: ['proj-a'] },
    ])
    expect(result).toContain('| slug ')
    expect(result).toContain('| proj-a |')
    expect(result).toContain('| proj-b |')
    expect(result).toContain('Do thing')
  })

  it('shows +N more when next_action_count > 1', () => {
    const result = formatQueryTable([
      { slug: 'proj-a', name: 'Project A', type: 'project', status: 'active', last_touched: '2026-03-14', next_action: 'First action', next_action_count: 3, parent: null, related: [] },
    ])
    expect(result).toContain('First action (+2 more)')
  })

  it('returns message for empty results', () => {
    const result = formatQueryTable([])
    expect(result).toContain('No results')
  })
})

describe('formatKnowledgeTable', () => {
  it('renders knowledge results as markdown table', () => {
    const result = formatKnowledgeTable([
      { slug: 'tdd-pattern', name: 'TDD Pattern', domain: ['engineering'], confidence: 'pattern', related: [], reinforcement_count: 3, last_reinforced: '2026-03-10' },
    ])
    expect(result).toContain('| slug ')
    expect(result).toContain('| tdd-pattern |')
    expect(result).toContain('engineering')
    expect(result).toContain('pattern')
  })

  it('returns message for empty results', () => {
    const result = formatKnowledgeTable([])
    expect(result).toContain('No results')
  })
})

describe('formatSearchResults', () => {
  it('renders mixed results with entity and knowledge sections', () => {
    const result = formatSearchResults([
      { slug: 'proj-a', kind: 'entity', name: 'Project A', snippet: 'matched text', type: 'project', status: 'active' },
      { slug: 'tdd-pat', kind: 'knowledge', name: 'TDD Pattern', snippet: 'test insight', confidence: 'pattern' },
    ])
    expect(result).toContain('## Entities')
    expect(result).toContain('## Knowledge')
    expect(result).toContain('proj-a')
    expect(result).toContain('tdd-pat')
  })

  it('renders only entity section when no knowledge results', () => {
    const result = formatSearchResults([
      { slug: 'proj-a', kind: 'entity', name: 'Project A', snippet: 'matched', type: 'project' },
    ])
    expect(result).toContain('## Entities')
    expect(result).not.toContain('## Knowledge')
  })

  it('returns message for empty results', () => {
    const result = formatSearchResults([])
    expect(result).toContain('No results')
  })
})

describe('formatValidation', () => {
  it('renders clean report', () => {
    const result = formatValidation({
      broken_slugs: [], orphaned_knowledge: [], oversized_related: [], missing_fields: [],
      total_entities: 10, total_knowledge: 5,
    })
    expect(result).toContain('Vault OK')
    expect(result).toContain('10 entities')
    expect(result).toContain('5 knowledge')
  })

  it('renders issues', () => {
    const result = formatValidation({
      broken_slugs: [{ slug: 'x', field: 'parent', issue: 'not found' }],
      orphaned_knowledge: ['lonely'],
      oversized_related: [{ slug: 'y', field: 'related', issue: '6 items' }],
      missing_fields: [{ slug: 'z', field: 'name', issue: 'missing required field' }],
      total_entities: 10, total_knowledge: 5,
    })
    expect(result).toContain('Broken Slugs')
    expect(result).toContain('x: not found')
    expect(result).toContain('Orphaned Knowledge')
    expect(result).toContain('lonely')
    expect(result).toContain('Oversized Related')
    expect(result).toContain('Missing Fields')
  })

  it('does not say Vault OK when there are issues', () => {
    const result = formatValidation({
      broken_slugs: [{ slug: 'x', field: 'parent', issue: 'not found' }],
      orphaned_knowledge: [], oversized_related: [], missing_fields: [],
      total_entities: 10, total_knowledge: 5,
    })
    expect(result).not.toContain('Vault OK')
  })
})

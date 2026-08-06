import { describe, it, expect } from 'vitest'
import { syncRelatedSection } from '../src/document.js'

describe('syncRelatedSection', () => {
  it('adds Related section for uncovered frontmatter links', () => {
    const body = '## Synthesis\n\nSome content.'
    const result = syncRelatedSection(body, { related: ['foo', 'bar'] })
    expect(result).toContain('## Related')
    expect(result).toContain('- [[foo]]')
    expect(result).toContain('- [[bar]]')
  })

  it('skips links already mentioned inline as [[slug]]', () => {
    const body = '## Synthesis\n\nThis references [[foo]] already.'
    const result = syncRelatedSection(body, { related: ['foo', 'bar'] })
    expect(result).toContain('- [[bar]]')
    expect(result).not.toMatch(/## Related[\s\S]*\[\[foo\]\]/)
  })

  it('removes Related section when all links covered inline', () => {
    const body = '## Synthesis\n\nReferences [[foo]] and [[bar]].\n\n## Related\n- [[old]]'
    const result = syncRelatedSection(body, { related: ['foo', 'bar'] })
    expect(result).not.toContain('## Related')
  })

  it('includes parent with label', () => {
    const body = '## Synthesis\n\nContent.'
    const result = syncRelatedSection(body, { parent: 'parent-slug', related: [] })
    expect(result).toContain('- [[parent-slug]] (parent)')
  })

  it('does not count links inside existing ## Related section as coverage', () => {
    const body = '## Synthesis\n\nContent.\n\n## Related\n- [[foo]]'
    const result = syncRelatedSection(body, { related: ['foo'] })
    // foo is only in the generated section, not in authored content
    expect(result).toContain('## Related')
    expect(result).toContain('- [[foo]]')
  })

  it('is idempotent — same input produces same output', () => {
    const body = '## Synthesis\n\nContent referencing [[foo]].'
    const fm = { related: ['foo', 'bar'] }
    const first = syncRelatedSection(body, fm)
    const second = syncRelatedSection(first, fm)
    expect(second).toBe(first)
  })

  it('returns body unchanged when no frontmatter links', () => {
    const body = '## Synthesis\n\nContent.'
    const result = syncRelatedSection(body, {})
    expect(result).toBe(body)
  })

  it('handles body with fenced code containing ## headings', () => {
    const body = '## Synthesis\n\nContent.\n\n```markdown\n## Related\n- [[fake]]\n```\n'
    const result = syncRelatedSection(body, { related: ['foo'] })
    expect(result).toContain('- [[foo]]')
  })
})

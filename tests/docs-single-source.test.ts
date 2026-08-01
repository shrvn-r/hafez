// tests/docs-single-source.test.ts
//
// AGENTS.md is the one canonical agent doc (the cross-harness standard);
// CLAUDE.md must stay a thin @AGENTS.md import. The two files drifted apart
// once when they were maintained by hand — this guard makes that structural.
// Runs identically in the private tree (full AGENTS.md) and the public
// release tree (slim AGENTS.md swapped in by tools/release.sh).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'

describe('agent docs single source', () => {
  it('CLAUDE.md is a thin pointer that imports AGENTS.md', () => {
    const claude = readFileSync('CLAUDE.md', 'utf-8')
    expect(claude).toContain('@AGENTS.md')
    expect(claude.length).toBeLessThan(400)
  })

  it('AGENTS.md is the canonical doc, not a pointer', () => {
    const agents = readFileSync('AGENTS.md', 'utf-8')
    expect(agents.length).toBeGreaterThan(500)
    expect(agents).not.toContain('@AGENTS.md')
  })
})

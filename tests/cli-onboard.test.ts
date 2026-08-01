// tests/cli-onboard.test.ts
//
// Structural assertions on the first-run guide, same approach as
// cli-help-agent.test.ts: verify the document's top-level promises,
// not its exact wording.

import { describe, it, expect } from 'vitest'
import { renderOnboard, INTEGRATION_SNIPPET } from '../src/cli/onboard.js'

describe('cli-onboard: structural guarantees', () => {
  const output = renderOnboard()

  it('addresses the agent, not the end user', () => {
    expect(output).toContain('You are an agent')
  })

  it('covers the seeding interview with the quality guardrails', () => {
    expect(output).toContain('Seed the vault')
    expect(output).toMatch(/3-7 projects/)
    expect(output).toMatch(/capture/i)
    expect(output).toMatch(/ONE `hafez batch`/)
  })

  it('recommends always-active integration and embeds the snippet verbatim', () => {
    expect(output).toContain('RECOMMENDED — always active')
    expect(output).toContain(INTEGRATION_SNIPPET)
  })

  it('covers Claude Code and the AGENTS.md standard', () => {
    expect(output).toContain('~/.claude/CLAUDE.md')
    expect(output).toContain('AGENTS.md standard')
    expect(output).toContain('~/.codex/AGENTS.md')
    expect(output).not.toContain('GEMINI.md')
  })

  it('teaches the invoke-only fallback', () => {
    expect(output).toContain('FALLBACK — invoke only')
    expect(output).toContain('re-running `hafez onboard`')
  })

  it('snippet covers the session lifecycle', () => {
    expect(INTEGRATION_SNIPPET).toContain('Session start')
    expect(INTEGRATION_SNIPPET).toContain('Mid-session')
    expect(INTEGRATION_SNIPPET).toContain('Session end')
    expect(INTEGRATION_SNIPPET).toContain('hafez digest | hafez batch')
  })

  it('only references CLI commands that exist', () => {
    const referenced = [...output.matchAll(/`hafez ([a-z-]+)/g)].map(m => m[1])
    const known = new Set(['read', 'search', 'batch', 'schema', 'stats', 'init', 'help', 'onboard', 'digest'])
    for (const cmd of referenced) expect(known).toContain(cmd)
  })
})

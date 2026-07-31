// tests/cli-help-agent.test.ts
//
// Structural assertions on the prompt-gate output. NOT a snapshot test —
// snapshots churn the diff every time the preamble is tuned, and the drift
// mitigation is handled separately in cli-schema-drift.test.ts. These tests
// just verify the top-level promises of the help document.
//
// Token count ceiling uses a char/3.5 proxy, documented inline as a
// conservative overcount (safe-fail direction — false positives force
// review, never false passes).

import { describe, it, expect } from 'vitest'
import { renderAgentHelp } from '../src/cli/help-agent.js'
import { listOps, getEnumValues } from '../src/cli/schema-introspect.js'

describe('cli-help-agent: structural guarantees', () => {
  const output = renderAgentHelp()

  it('contains the hard-rules block with ALWAYS/NEVER markers', () => {
    expect(output).toMatch(/ALWAYS batch/)
    expect(output).toMatch(/NEVER invent field names/)
  })

  it('contains every op from listOps() at least once', () => {
    for (const op of listOps()) expect(output).toContain(op.name)
  })

  it('contains every critical enum value from schema-introspect', () => {
    const paths = [
      'update.fields.status',
      'update.fields.session_log.type',
      'update.fields.confidence',
      'create-entity.fields.type',
      'create-knowledge.fields.subtype',
      'link.relation',
    ]
    for (const p of paths) {
      const values = getEnumValues(p)
      expect(values).not.toBeNull()
      for (const v of values!) expect(output).toContain(v)
    }
  })

  it('contains every required section marker', () => {
    expect(output).toContain('<!-- SECTION:op-catalog -->')
    expect(output).toContain('<!-- /SECTION:op-catalog -->')
    expect(output).toContain('<!-- SECTION:critical-enums -->')
    expect(output).toContain('<!-- /SECTION:critical-enums -->')
    expect(output).toContain('<!-- SECTION:batch-examples -->')
    expect(output).toContain('<!-- /SECTION:batch-examples -->')
    expect(output).toContain('<!-- SECTION:digest -->')
    expect(output).toContain('<!-- /SECTION:digest -->')
  })

  it('documents the digest pipe usage', () => {
    expect(output).toContain('hafez digest | hafez batch')
    expect(output).toContain('hafez schema digest')
  })

  it('token count stays under 3000', () => {
    // char/3.5 is a conservative proxy (overcounts by ~15% for mixed prose+JSON)
    // biased toward failing the test rather than letting a bloated payload ship.
    // If a real tokenizer is added later, swap the function without changing the ceiling.
    const tokens = Math.ceil(output.length / 3.5)
    expect(tokens).toBeLessThan(3000)
  })
})

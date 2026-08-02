// tests/integration-dry-run.test.ts
//
// Verifies `hafez batch --dry-run` validates the payload without touching
// the filesystem. Uses `git status --porcelain` + `git rev-parse HEAD` on a
// temp vault as the no-mutation assertion — same pattern as
// tests/integration.test.ts.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import simpleGit from 'simple-git'
import { serializeFile } from '../src/vault.js'

const TMP = join(tmpdir(), 'hafez-dry-run-test-' + Date.now())
const BARE = join(TMP, 'remote.git')
const VAULT = join(TMP, 'vault')
const CLI = join(process.cwd(), 'dist', 'cli.js')

function runWithStdin(stdinInput: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, '--vault', VAULT, ...args], {
      encoding: 'utf-8',
      stderr: 'pipe',
      input: stdinInput,
    }) as string
    return { stdout, stderr: '', exitCode: 0 }
  } catch (err: any) {
    return {
      stdout: (err.stdout ?? '') as string,
      stderr: (err.stderr ?? '') as string,
      exitCode: err.status ?? 1,
    }
  }
}

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  mkdirSync(BARE, { recursive: true })
  await simpleGit(BARE).init(true)
  await simpleGit().clone(BARE, VAULT)
  mkdirSync(join(VAULT, 'entities'), { recursive: true })

  const today = new Date().toISOString().slice(0, 10)
  writeFileSync(
    join(VAULT, 'entities', 'test-proj.md'),
    serializeFile(
      { name: 'Test Project', type: 'project', status: 'active', created: today, 'last-touched': today },
      '## Purpose\n\n## Session Log\n',
    ),
  )
  const git = simpleGit(VAULT)
  await git.add('.')
  await git.commit('seed')
  const branch = (await git.branchLocal()).current
  await git.push('origin', branch)
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('batch --dry-run', () => {
  it('validates a valid 2-op batch without touching the vault', async () => {
    const git = simpleGit(VAULT)
    const headBefore = (await git.revparse(['HEAD'])).trim()
    const porcelainBefore = (await git.status()).files
    expect(porcelainBefore).toHaveLength(0)

    const input = JSON.stringify([
      { op: 'update', slug: 'test-proj', fields: { status: 'done' } },
      { op: 'capture', name: 'Dry run capture' },
    ])
    const { stdout, exitCode } = runWithStdin(input, 'batch', '--dry-run')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Batch valid: 2 operations would be applied')

    const headAfter = (await git.revparse(['HEAD'])).trim()
    const porcelainAfter = (await git.status()).files
    expect(headAfter).toBe(headBefore)
    expect(porcelainAfter).toHaveLength(0)
  })

  it('exits non-zero on validation failure and still does not touch the vault', async () => {
    const git = simpleGit(VAULT)
    const headBefore = (await git.revparse(['HEAD'])).trim()

    const input = JSON.stringify([
      { op: 'update', slug: 'test-proj', fields: { status: 'bogus' } },
    ])
    const { stderr, exitCode } = runWithStdin(input, 'batch', '--dry-run')
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('invalid operation')

    const headAfter = (await git.revparse(['HEAD'])).trim()
    const porcelainAfter = (await git.status()).files
    expect(headAfter).toBe(headBefore)
    expect(porcelainAfter).toHaveLength(0)
  })

  // Parity regression (telemetry 2026-08-01): dry-run green-lit a payload the
  // real apply rejected on entity-vs-knowledge kind rules. Dry-run and apply
  // now share one validate phase, so this class of divergence is structural,
  // not a synced list.
  it('rejects kind-rule violations that apply would reject, localised to the op', async () => {
    runWithStdin(JSON.stringify([{ op: 'create', kind: 'knowledge', name: 'Kind Guard Note' }]), 'batch')

    const input = JSON.stringify([
      { op: 'update', slug: 'test-proj', fields: { brief: 'fine' } },
      { op: 'update', slug: 'kind-guard-note', fields: { status: 'done', session_log: { type: 'progress', summary: 's', agent: 'a' } } },
    ])
    const dry = runWithStdin(input, 'batch', '--dry-run')
    expect(dry.exitCode).not.toBe(0)
    expect(dry.stderr).toContain('op[1] (update kind-guard-note)')
    expect(dry.stderr).toContain('entity-only')

    // and apply agrees, with the same localisation
    const apply = runWithStdin(input, 'batch')
    expect(apply.exitCode).not.toBe(0)
    expect(apply.stderr).toContain('op[1] (update kind-guard-note)')
  })

  it('reports derived slugs for create ops (slug oracle)', () => {
    const input = JSON.stringify([
      { op: 'create', kind: 'entity', name: 'Auth Refactor!', fields: { type: 'project' } },
      { op: 'capture', name: 'Quick Thought' },
    ])
    const { stdout, exitCode } = runWithStdin(input, 'batch', '--dry-run')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Derived slugs:')
    expect(stdout).toContain('op[0] create → auth-refactor')
    expect(stdout).toContain('op[1] capture → quick-thought')
  })

  it('validates same-batch references: create-then-link passes dry-run and apply', async () => {
    const input = JSON.stringify([
      { op: 'create', kind: 'entity', name: 'Batch Parent', fields: { type: 'project' } },
      { op: 'create', kind: 'entity', name: 'Batch Child', fields: { type: 'entity', parent: 'batch-parent' } },
      { op: 'link', slug: 'batch-parent', target: 'batch-child', relation: 'related' },
    ])
    const dry = runWithStdin(input, 'batch', '--dry-run')
    expect(dry.exitCode).toBe(0)
    expect(dry.stdout).toContain('Batch valid: 3 operations')

    const apply = runWithStdin(input, 'batch')
    expect(apply.exitCode).toBe(0)
    expect(apply.stdout).toContain('Batch complete: 3 operations')
  })

  it('rejects slug collisions at dry-run, including within the batch itself', () => {
    const input = JSON.stringify([
      { op: 'capture', name: 'Dup Note' },
      { op: 'capture', name: 'Dup Note' },
    ])
    const { stderr, exitCode } = runWithStdin(input, 'batch', '--dry-run')
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain("op[1] (capture dup-note): Slug 'dup-note' already exists")
  })

  // --file: the portable session-end path — PowerShell 5.1 can't pipe stdin
  // to native executables, and its own redirection writes UTF-16LE.
  it('reads the payload from --file instead of stdin', () => {
    const payload = join(TMP, 'batch-payload.json')
    writeFileSync(payload, JSON.stringify([{ op: 'capture', name: 'From File' }]))
    const { stdout, exitCode } = runWithStdin('', 'batch', '--file', payload, '--dry-run')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('op[0] capture → from-file')
  })

  it('accepts UTF-16LE and BOM-prefixed --file payloads (PowerShell redirection)', () => {
    const json = JSON.stringify([{ op: 'capture', name: 'Utf Sixteen' }])
    const utf16 = join(TMP, 'payload-utf16.json')
    writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, 'utf16le')]))
    const r16 = runWithStdin('', 'batch', '--file', utf16, '--dry-run')
    expect(r16.exitCode).toBe(0)
    expect(r16.stdout).toContain('utf-sixteen')

    const bom8 = join(TMP, 'payload-bom8.json')
    writeFileSync(bom8, '﻿' + json)
    const r8 = runWithStdin('', 'batch', '--file', bom8, '--dry-run')
    expect(r8.exitCode).toBe(0)
    expect(r8.stdout).toContain('utf-sixteen')
  })

  it('errors loudly on a missing --file', () => {
    const { stderr, exitCode } = runWithStdin('', 'batch', '--file', join(TMP, 'nope.json'))
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('Cannot read --file')
  })
})

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
})

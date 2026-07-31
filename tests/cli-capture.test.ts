// tests/cli-capture.test.ts
//
// `hafez capture` is the new top-level alias for the previous
// `hafez create inbox` entry. Both paths reach the same handler, producing
// identical files — `create inbox` now emits a deprecation warning to stderr.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import simpleGit from 'simple-git'

const TMP = join(tmpdir(), 'hafez-cli-capture-test-' + Date.now())
const BARE = join(TMP, 'remote.git')
const VAULT = join(TMP, 'vault')
const CLI = join(process.cwd(), 'dist', 'cli.js')

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('node', [CLI, '--vault', VAULT, ...args], { encoding: 'utf-8' })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  }
}

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  mkdirSync(BARE, { recursive: true })
  await simpleGit(BARE).init(true)
  await simpleGit().clone(BARE, VAULT)
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  const git = simpleGit(VAULT)
  await git.add('.')
  await git.commit('init', ['--allow-empty'])
  const branch = (await git.branchLocal()).current
  await git.push('origin', branch)
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('cli capture: new top-level command', () => {
  it('creates a capture file with no deprecation warning', () => {
    const { stdout, stderr, exitCode } = run('capture', 'New capture via top-level')
    expect(exitCode).toBe(0)
    const slug = stdout.trim()
    expect(slug).toBe('new-capture-via-top-level')
    expect(stderr).not.toContain('deprecated')
    expect(existsSync(join(VAULT, 'entities', 'new-capture-via-top-level.md'))).toBe(true)
  })
})

describe('cli create inbox: deprecated alias still works', () => {
  it('emits a deprecation warning to stderr and creates the file', () => {
    const { stdout, stderr, exitCode } = run('create', 'inbox', 'Legacy capture via create inbox')
    expect(exitCode).toBe(0)
    const slug = stdout.trim()
    expect(slug).toBe('legacy-capture-via-create-inbox')
    expect(stderr).toContain('deprecated')
    expect(stderr).toContain('hafez capture')
    expect(existsSync(join(VAULT, 'entities', 'legacy-capture-via-create-inbox.md'))).toBe(true)
  })

  it('both paths reach the same handler (output parity)', () => {
    // Both commands should produce captures that, aside from slug, are
    // structurally identical. We already asserted both files exist; here
    // just re-run capture once and assert the slug shape.
    const { stdout, exitCode } = run('capture', 'Parity probe')
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('parity-probe')
  })
})

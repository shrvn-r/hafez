// tests/operations-git.test.ts
// Adapter/e2e coverage of mutation persistence on a REAL git repo: commit-
// stage vs push-stage failure handling, rollback consistency (files + git
// index + SQLite), and batch commits carrying archival writes. The pure
// operation logic lives in operations.test.ts against the in-memory Journal.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHafez } from '../src/index.js'
import { mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import simpleGit from 'simple-git'
import Database from 'better-sqlite3'

const TMP = join(tmpdir(), 'hafez-test-ops-git-' + Date.now())
const BARE = join(TMP, 'remote.git')
const VAULT = join(TMP, 'vault')

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  mkdirSync(BARE, { recursive: true })
  await simpleGit(BARE).init(true)
  await simpleGit().clone(BARE, VAULT)
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })
  // Initial commit
  writeFileSync(join(VAULT, '.gitkeep'), '')
  const git = simpleGit(VAULT)
  await git.add('.gitkeep')
  await git.commit('init')
  const branch = (await git.branchLocal()).current
  await git.push('origin', branch)
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

function makeOS() {
  return createHafez({ vaultPath: VAULT, git: { push: false } })
}

describe('batch commit-stage vs push-stage failure (COR-5 / TST-1)', () => {
  it('rolls back file writes when the commit stage fails', async () => {
    const os = makeOS()
    await os.create('entity', 'Rollback Probe', { type: 'project' })
    const filePath = join(VAULT, 'entities', 'rollback-probe.md')
    const before = readFileSync(filePath, 'utf-8')

    // Simulate a raced git process holding the index lock — add/commit will fail
    const indexLock = join(VAULT, '.git', 'index.lock')
    writeFileSync(indexLock, '')
    try {
      await expect(
        os.batch([{ op: 'update', slug: 'rollback-probe', fields: { brief: 'should not survive' } }])
      ).rejects.toThrow()
    } finally {
      rmSync(indexLock, { force: true })
    }

    // The half-applied write must be rolled back...
    expect(readFileSync(filePath, 'utf-8')).toBe(before)
    expect(readFileSync(filePath, 'utf-8')).not.toContain('should not survive')
    // ...including the git index: nothing staged, or the next commit would
    // publish the rolled-back content under the wrong message
    const status = await simpleGit(VAULT).status()
    expect(status.staged).toHaveLength(0)
  })

  it('rolls back and unstages when the commit itself fails after staging', async () => {
    const os = makeOS()
    await os.create('entity', 'Hook Probe', { type: 'project' })
    // A failing pre-commit hook makes `git add` succeed but `git commit` fail —
    // the case where content is left staged without a commit
    const hookPath = join(VAULT, '.git', 'hooks', 'pre-commit')
    writeFileSync(hookPath, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    try {
      await expect(
        os.batch([{ op: 'update', slug: 'hook-probe', fields: { brief: 'staged then failed' } }])
      ).rejects.toThrow()
    } finally {
      rmSync(hookPath, { force: true })
    }
    const status = await simpleGit(VAULT).status()
    expect(status.staged).toHaveLength(0)
    expect(readFileSync(join(VAULT, 'entities', 'hook-probe.md'), 'utf-8')).not.toContain('staged then failed')
  })

  it('keeps the local commit when only the push stage fails', async () => {
    const os = createHafez({ vaultPath: VAULT })
    await os.create('entity', 'Push Fail Probe', { type: 'project' })

    // Point origin at a nonexistent path so push (and pull) fail without conflict
    const git = simpleGit(VAULT)
    const originUrl = (await git.getRemotes(true)).find(r => r.name === 'origin')!.refs.push
    await git.raw(['remote', 'set-url', 'origin', join(TMP, 'no-such-remote.git')])
    try {
      await expect(
        os.batch([{ op: 'update', slug: 'push-fail-probe', fields: { brief: 'survives push failure' } }])
      ).rejects.toMatchObject({ code: 'GIT_PUSH_FAILED' })
    } finally {
      await git.raw(['remote', 'set-url', 'origin', originUrl])
    }

    // The write is committed locally — file keeps the new content
    const content = readFileSync(join(VAULT, 'entities', 'push-fail-probe.md'), 'utf-8')
    expect(content).toContain('survives push failure')
    const log = await git.log()
    expect(log.latest?.message).toContain('batch: 1 operations')

    // Heal: push the stranded commit so later tests see a clean state
    const branch = (await git.branchLocal()).current
    await git.push('origin', branch)
  }, 30_000)
})

describe('index consistency when the commit stage fails', () => {
  function indexSlugs(): string[] {
    const db = new Database(join(VAULT, '.hafez.db'), { readonly: true })
    try {
      return (db.prepare('SELECT slug FROM items').all() as Array<{ slug: string }>).map(r => r.slug)
    } finally {
      db.close()
    }
  }

  it('failed batch containing a promote leaves the SQLite index consistent', async () => {
    const os = makeOS()
    await os.capture('Batch Promote Probe')
    expect(indexSlugs()).toContain('batch-promote-probe')

    const indexLock = join(VAULT, '.git', 'index.lock')
    writeFileSync(indexLock, '')
    try {
      await expect(
        os.batch([{ op: 'promote', slug: 'batch-promote-probe', target: 'knowledge' }])
      ).rejects.toThrow()
    } finally {
      rmSync(indexLock, { force: true })
    }

    // Files rolled back: entity restored, knowledge file gone
    expect(existsSync(join(VAULT, 'entities', 'batch-promote-probe.md'))).toBe(true)
    expect(existsSync(join(VAULT, 'knowledge', 'batch-promote-probe.md'))).toBe(false)
    // Index untouched: the entity row must survive (pre-collapse, promote
    // removed its row mid-apply and rollback restored files only)
    expect(indexSlugs()).toContain('batch-promote-probe')
  })

  it('failed single-op promote leaves the SQLite index consistent', async () => {
    const os = makeOS()
    await os.capture('Solo Promote Probe')
    expect(indexSlugs()).toContain('solo-promote-probe')

    const indexLock = join(VAULT, '.git', 'index.lock')
    writeFileSync(indexLock, '')
    try {
      await expect(os.promote('solo-promote-probe', 'knowledge')).rejects.toThrow()
    } finally {
      rmSync(indexLock, { force: true })
    }

    expect(existsSync(join(VAULT, 'entities', 'solo-promote-probe.md'))).toBe(true)
    expect(existsSync(join(VAULT, 'knowledge', 'solo-promote-probe.md'))).toBe(false)
    expect(indexSlugs()).toContain('solo-promote-probe')
  })
})

describe('single-op promote when only the push stage fails', () => {
  it('keeps the promoted files and index — never rolls back a landed commit', async () => {
    const os = createHafez({ vaultPath: VAULT })
    await os.capture('Push Fail Promote Probe')

    const git = simpleGit(VAULT)
    const originUrl = (await git.getRemotes(true)).find(r => r.name === 'origin')!.refs.push
    await git.raw(['remote', 'set-url', 'origin', join(TMP, 'no-such-remote.git')])
    try {
      await expect(
        os.promote('push-fail-promote-probe', 'knowledge')
      ).rejects.toMatchObject({ code: 'GIT_PUSH_FAILED' })
    } finally {
      await git.raw(['remote', 'set-url', 'origin', originUrl])
    }

    // The promote commit exists locally — the worktree must match it, not the
    // pre-promote state (rolling back here left disk contradicting HEAD)
    expect(existsSync(join(VAULT, 'entities', 'push-fail-promote-probe.md'))).toBe(false)
    expect(existsSync(join(VAULT, 'knowledge', 'push-fail-promote-probe.md'))).toBe(true)
    expect((await git.log()).latest?.message).toContain('promote: push-fail-promote-probe')
    expect((await git.status()).isClean()).toBe(true)

    // Index follows the commit: the row flipped from entity to knowledge
    const db = new Database(join(VAULT, '.hafez.db'), { readonly: true })
    try {
      const rows = db.prepare("SELECT kind FROM items WHERE slug = 'push-fail-promote-probe'").all() as Array<{ kind: string }>
      expect(rows.map(r => r.kind)).toEqual(['knowledge'])
    } finally {
      db.close()
    }

    // Heal: push the stranded commit so later tests see a clean state
    const branch = (await git.branchLocal()).current
    await git.push('origin', branch)
  }, 30_000)
})

describe('batch session log archival rides the batch commit', () => {
  it('the archive file lands tracked in the same commit', async () => {
    const os = makeOS()
    await os.create('entity', 'Batch Archive Test', { type: 'project' })
    const ops = Array.from({ length: 10 }, (_, i) => ({
      op: 'update' as const,
      slug: 'batch-archive-test',
      fields: { session_log: { type: 'progress' as const, summary: `Batch entry ${i}`, agent: 'Test' } },
    }))
    await os.batch(ops)

    const git = simpleGit(VAULT)
    expect((await git.log()).latest?.message).toContain('batch: 10 operations')
    const tracked = await git.raw(['ls-files', 'entities/archive/batch-archive-test-log.md'])
    expect(tracked.trim()).toBe('entities/archive/batch-archive-test-log.md')
  })
})

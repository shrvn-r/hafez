// tests/concurrency.test.ts
// COR-2 regression: the write mutex used to be in-process only, so two hafez
// processes racing on the same vault lost updates (verified: 6 of 12 session
// log entries vanished across six rounds, with both processes reporting ok).
// The vault-level proper-lockfile lock must serialize them.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import simpleGit from 'simple-git'
import { serializeFile } from '../src/vault.js'
import { createHafez } from '../src/index.js'
import { createMemoryJournal } from './helpers/memory-journal.js'

const execFileAsync = promisify(execFile)

const TMP = join(tmpdir(), 'hafez-test-conc-' + Date.now())
const VAULT = join(TMP, 'vault')
const CLI = join(process.cwd(), 'dist', 'cli.js')

beforeAll(async () => {
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })

  const today = new Date().toISOString().slice(0, 10)
  writeFileSync(
    join(VAULT, 'entities', 'race-target.md'),
    serializeFile(
      { name: 'Race Target', type: 'project', status: 'active', created: today, 'last-touched': today },
      '## Purpose\n\nConcurrency test target\n\n## Session Log\n',
    ),
  )

  // Local-only vault: commit-only path, no remote needed
  const git = simpleGit(VAULT)
  await git.init()
  await git.addConfig('user.email', 'test@test.com')
  await git.addConfig('user.name', 'Test')
  await git.add('.')
  await git.commit('init')
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('cross-process write lock (COR-2)', () => {
  it('two concurrent CLI processes both land their session log entries', async () => {
    for (let round = 0; round < 3; round++) {
      await Promise.all([
        execFileAsync('node', [CLI, '--vault', VAULT, 'update', 'race-target', '--log', `progress: entry A${round}`, '--agent', `procA${round}`]),
        execFileAsync('node', [CLI, '--vault', VAULT, 'update', 'race-target', '--log', `progress: entry B${round}`, '--agent', `procB${round}`]),
      ])
      const content = readFileSync(join(VAULT, 'entities', 'race-target.md'), 'utf-8')
      expect(content).toContain(`entry A${round}`)
      expect(content).toContain(`entry B${round}`)
    }
  }, 120_000)

  it('two in-process instances with separate mutexes are serialized by the vault lock', async () => {
    // Lock logic only — no git: each instance gets its own in-memory journal,
    // so the serialization under test is purely the vault lockfile.
    const VAULT2 = join(TMP, 'vault-nogit')
    mkdirSync(join(VAULT2, 'entities'), { recursive: true })
    const today = new Date().toISOString().slice(0, 10)
    writeFileSync(
      join(VAULT2, 'entities', 'race-target.md'),
      serializeFile(
        { name: 'Race Target', type: 'project', status: 'active', created: today, 'last-touched': today },
        '## Purpose\n\nConcurrency test target\n\n## Session Log\n',
      ),
    )
    const os1 = createHafez({ vaultPath: VAULT2, persistence: createMemoryJournal() })
    const os2 = createHafez({ vaultPath: VAULT2, persistence: createMemoryJournal() })
    await Promise.all([
      os1.update('race-target', { session_log: { summary: 'instance one entry', type: 'progress', agent: 'inst1' } }),
      os2.update('race-target', { session_log: { summary: 'instance two entry', type: 'progress', agent: 'inst2' } }),
    ])
    const content = readFileSync(join(VAULT2, 'entities', 'race-target.md'), 'utf-8')
    expect(content).toContain('instance one entry')
    expect(content).toContain('instance two entry')
  }, 60_000)
})

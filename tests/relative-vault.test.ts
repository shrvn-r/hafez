// tests/relative-vault.test.ts
//
// A vault path is absolute from the moment it enters hafez (#291). The Layout's
// kind match finds a kind dir with a separator on both sides, so a relative
// vault (`.`) made `entities/probe.md` fall through to knowledge: every entity
// read as a knowledge note and every entity write was refused.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { simpleGit } from 'simple-git'
import { createHafez, removeTemp } from './helpers/hafez.js'

const TMP = join(tmpdir(), 'hafez-relative-vault-test-' + Date.now())
const VAULT = join(TMP, 'vault')
const CONFIG = join(TMP, 'config')
const CLI = join(process.cwd(), 'dist', 'cli.js')

function run(vault: string, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('node', [CLI, '--vault', vault, ...args], {
    cwd: VAULT,
    encoding: 'utf-8',
    env: { ...process.env, XDG_CONFIG_HOME: CONFIG },
  })
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', exitCode: result.status ?? 1 }
}

beforeAll(async () => {
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })
  const git = simpleGit(VAULT)
  await git.init()
  await git.addConfig('user.email', 'test@test.com')
  await git.addConfig('user.name', 'Test')
  await git.commit('init', ['--allow-empty'])
  expect(run(VAULT, 'create', 'entity', 'Probe', '--type', 'project', '--brief', 'probe brief').exitCode).toBe(0)
})

afterAll(() => removeTemp(TMP))

describe('createHafez with a relative vaultPath', () => {
  it('reads an entity as an entity with cwd inside the vault', async () => {
    const cwd = process.cwd()
    process.chdir(VAULT)
    try {
      const os = createHafez({ vaultPath: '.' })
      const note = await os.read('probe')
      expect(note.kind).toBe('entity')
      expect(note.frontmatter).toMatchObject({ type: 'project' })
    } finally {
      process.chdir(cwd)
    }
  })
})

describe('hafez --vault . (cwd inside the vault)', () => {
  it("reads the issue's probe as an entity, text and --json", () => {
    const text = run('.', 'read', 'probe')
    expect(text.exitCode).toBe(0)
    expect(text.stdout).toContain('status: active | type: project')
    const json = run('.', 'read', 'probe', '--json')
    expect(JSON.parse(json.stdout).kind).toBe('entity')
  })

  it('gives the same output as the absolute form on read, query, search', () => {
    for (const args of [['read', 'probe'], ['read', 'probe', '--json'], ['query', '--filter', 'all'], ['search', 'probe']]) {
      const rel = run('.', ...args)
      expect(rel.exitCode, args.join(' ')).toBe(0)
      expect(rel.stdout, args.join(' ')).toBe(run(VAULT, ...args).stdout)
    }
  })

  it('creates and updates an entity as the absolute form does', () => {
    const created = run('.', 'create', 'entity', 'Rel Made', '--type', 'project')
    expect(created.exitCode).toBe(0)
    expect(created.stdout.trim()).toBe('rel-made')
    expect(readFileSync(join(VAULT, 'entities', 'rel-made.md'), 'utf-8')).toContain('type: project')

    const updated = run('.', 'update', 'probe', '--status', 'paused')
    expect(updated.exitCode, updated.stderr).toBe(0)
    expect(readFileSync(join(VAULT, 'entities', 'probe.md'), 'utf-8')).toContain('status: paused')
  })

  it('init reports the absolute path', () => {
    const { stdout, exitCode } = run('.', 'init')
    expect(exitCode).toBe(0)
    expect(stdout).toBe(`Vault: ${VAULT} (--vault flag)\n`)
  })
})

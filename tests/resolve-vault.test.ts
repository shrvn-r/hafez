// tests/resolve-vault.test.ts
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'

const TMP = join(tmpdir(), 'hafez-resolve-test-' + Date.now())
const FAKE_VAULT = join(TMP, 'vault')
const FAKE_VAULT_2 = join(TMP, 'vault2')
const CONFIG_DIR = join(TMP, 'config', 'hafez')
const CONFIG_FILE = join(CONFIG_DIR, 'vault')
const CLI = join(process.cwd(), 'dist', 'cli.js')

function runEnv(extraEnv: Record<string, string>, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(TMP, 'config'),
    ...extraEnv,
  }

  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      encoding: 'utf-8',
      stderr: 'pipe',
      env,
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

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  return runEnv({}, ...args)
}

function gitInitWithIdentity(dir: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir })
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true })
  // Create two fake vaults — registration requires a git repo with identity
  mkdirSync(join(FAKE_VAULT, 'entities'), { recursive: true })
  mkdirSync(join(FAKE_VAULT_2, 'entities'), { recursive: true })
  gitInitWithIdentity(FAKE_VAULT)
  gitInitWithIdentity(FAKE_VAULT_2)
  // Clean config
  if (existsSync(CONFIG_DIR)) rmSync(CONFIG_DIR, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('vault discovery', () => {
  it('--vault flag takes highest priority', () => {
    // Set config to vault2, but --vault points to vault
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, FAKE_VAULT_2 + '\n')

    const { stdout, exitCode } = run('--vault', FAKE_VAULT, 'init')
    expect(exitCode).toBe(0)
    expect(stdout).toContain(FAKE_VAULT)
    expect(stdout).toContain('--vault flag')
  })

  it('config file is used when no --vault flag', () => {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, FAKE_VAULT + '\n')

    const { stdout, exitCode } = run('init')
    expect(exitCode).toBe(0)
    expect(stdout).toContain(FAKE_VAULT)
    expect(stdout).toContain('config:')
  })

  it('no vault found shows helpful error', () => {
    const { stderr, exitCode } = run('query')
    expect(exitCode).toBe(1)
    expect(stderr).toContain('No vault found')
    expect(stderr).toContain('init --register')
  })
})

describe('bad config — loud failure', () => {
  it('config pointing to non-existent path errors loudly', () => {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, '/does/not/exist\n')

    const { stderr, exitCode } = run('query')
    expect(exitCode).toBe(1)
    expect(stderr).toContain("doesn't look like a vault")
    expect(stderr).toContain('init --register')
  })

  it('config pointing to dir without entities/ errors loudly', () => {
    const badDir = join(TMP, 'not-a-vault')
    mkdirSync(badDir, { recursive: true })
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, badDir + '\n')

    const { stderr, exitCode } = run('query')
    expect(exitCode).toBe(1)
    expect(stderr).toContain("doesn't look like a vault")
  })

  it('malformed config file falls through gracefully', () => {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, '')  // empty file

    const { stderr, exitCode } = run('query')
    expect(exitCode).toBe(1)
    // Should show "no vault found" — not crash
    expect(stderr).toContain('No vault found')
  })
})

describe('init --register', () => {
  it('registers a valid vault path', () => {
    const { stdout, exitCode } = run('init', '--register', FAKE_VAULT)
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Registered vault:')
    expect(stdout).toContain(FAKE_VAULT)

    // Verify config was written
    const config = readFileSync(CONFIG_FILE, 'utf-8').trim()
    expect(config).toBe(FAKE_VAULT)
  })

  it('rejects a non-existent path', () => {
    const { stderr, exitCode } = run('init', '--register', '/no/such/path')
    expect(exitCode).toBe(1)
    expect(stderr).toContain('does not exist')
  })

  it('rejects a directory without entities/', () => {
    const badDir = join(TMP, 'empty-dir')
    mkdirSync(badDir, { recursive: true })

    const { stderr, exitCode } = run('init', '--register', badDir)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('not a vault')
  })

  it('missing path argument shows usage', () => {
    const { stderr, exitCode } = run('init', '--register')
    expect(exitCode).toBe(1)
    expect(stderr).toContain('Usage:')
  })

  it('rejects a vault directory that is not a git repository', () => {
    const noGit = join(TMP, 'no-git-vault')
    mkdirSync(join(noGit, 'entities'), { recursive: true })

    const { stderr, exitCode } = run('init', '--register', noGit)
    expect(exitCode).toBe(1)
    expect(stderr).toContain('not a git repository')
    expect(stderr).toContain('git init')
  })

  it('rejects a vault when git has no identity configured', () => {
    const noIdent = join(TMP, 'no-ident-vault')
    mkdirSync(join(noIdent, 'entities'), { recursive: true })
    execFileSync('git', ['init', '-q'], { cwd: noIdent })

    // Hide global/system git config so the check sees a truly fresh machine
    const { stderr, exitCode } = runEnv(
      { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
      'init', '--register', noIdent,
    )
    expect(exitCode).toBe(1)
    expect(stderr).toContain('no identity')
    expect(stderr).toContain('git config --global user.name')
  })
})

describe('bare init — status', () => {
  it('shows vault from config', () => {
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(CONFIG_FILE, FAKE_VAULT + '\n')

    const { stdout, exitCode } = run('init')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Vault:')
    expect(stdout).toContain(FAKE_VAULT)
  })

  it('shows no-vault diagnostics when nothing configured', () => {
    const { stderr, exitCode } = run('init')
    expect(exitCode).toBe(1)
    expect(stderr).toContain('No vault found')
  })
})

describe('noVaultMessage format', () => {
  it('includes both checked sources and init hint', () => {
    const { stderr } = run('query')
    expect(stderr).toContain('--vault flag')
    expect(stderr).toContain('config')
    expect(stderr).toContain('init --register')
  })
})

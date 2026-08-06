// tests/cli.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { serializeFile } from '../src/vault.js'
import simpleGit from 'simple-git'

const TMP = join(tmpdir(), 'hafez-cli-test-' + Date.now())
const BARE = join(TMP, 'remote.git')
const VAULT = join(TMP, 'vault')
const CLI = join(process.cwd(), 'dist', 'cli.js')

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, '--vault', VAULT, ...args], {
      encoding: 'utf-8',
      stderr: 'pipe',
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
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })

  const today = new Date().toISOString().slice(0, 10)
  writeFileSync(
    join(VAULT, 'entities', 'test-proj.md'),
    serializeFile(
      { name: 'Test Project', type: 'project', status: 'active', created: today, 'last-touched': today },
      '## Purpose\n\nA test project\n\n## Session Log\n',
    ),
  )
  writeFileSync(
    join(VAULT, 'knowledge', 'test-insight.md'),
    serializeFile(
      { name: 'Test Insight', confidence: 'observation', 'reinforcement-count': 0, created: today, domain: ['testing'] },
      '## Insight\n\nSome insight\n\n## Evidence\n',
    ),
  )

  const git = simpleGit(VAULT)
  await git.add('.')
  await git.commit('init')
  const branch = (await git.branchLocal()).current
  await git.push('origin', branch)
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('install:local', () => {
  // Isolated HOME: the script must never touch the real user's ~/.local/bin
  // or ~/.claude/skills when the test suite runs (contributors, CI, and the
  // release preflight all run tests on machines whose HOME is not ours).
  const INSTALL_HOME = join(tmpdir(), 'hafez-install-home-' + Date.now())

  beforeAll(() => {
    mkdirSync(INSTALL_HOME, { recursive: true })
    execFileSync('npm', ['run', 'install:local'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: { ...process.env, HOME: INSTALL_HOME },
    })
  })

  afterAll(() => rmSync(INSTALL_HOME, { recursive: true, force: true }))

  it('creates symlink in ~/.local/bin', () => {
    const { existsSync, lstatSync, readlinkSync } = require('fs')
    const link = join(INSTALL_HOME, '.local', 'bin', 'hafez')
    expect(existsSync(link)).toBe(true)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readlinkSync(link)).toContain('dist/cli.js')
  })

  it('installs skill to ~/.claude/skills', () => {
    const { existsSync, lstatSync, readFileSync } = require('fs')
    const skillPath = join(INSTALL_HOME, '.claude', 'skills', 'hafez', 'SKILL.md')
    expect(existsSync(skillPath)).toBe(true)
    expect(lstatSync(skillPath).isSymbolicLink()).toBe(false)
    expect(readFileSync(skillPath, 'utf-8')).toContain('name: hafez')
  })

  it('linked binary is executable and responds to --help', () => {
    const { stdout, exitCode } = (() => {
      try {
        const out = execFileSync('node', [join(INSTALL_HOME, '.local', 'bin', 'hafez'), '--help'], {
          encoding: 'utf-8', stderr: 'pipe',
        }) as string
        return { stdout: out, exitCode: 0 }
      } catch (err: any) {
        return { stdout: err.stdout ?? '', exitCode: err.status ?? 1 }
      }
    })()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Usage: hafez')
  })
})

describe('CLI', () => {
  it('--help prints usage', () => {
    const { stdout, exitCode } = run('--help')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Usage: hafez')
  })

  it('--version prints the package version', () => {
    const { stdout, exitCode } = run('--version')
    expect(exitCode).toBe(0)
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'))
    expect(stdout.trim()).toBe(`hafez ${pkg.version}`)
  })

  it('help lists every dispatched command', () => {
    const { stdout } = run('help')
    for (const cmd of ['read', 'query', 'search', 'create', 'capture', 'promote', 'update', 'batch', 'digest', 'sync', 'stats', 'changelog', 'schema', 'validate', 'init', 'onboard', 'help --agent']) {
      expect(stdout).toContain(cmd)
    }
  })

  it('query --filter active returns markdown table', () => {
    const { stdout, exitCode } = run('query', '--filter', 'active')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('test-proj')
    expect(stdout).toContain('| slug')
  })

  it('read returns entity markdown', () => {
    const { stdout, exitCode } = run('read', 'test-proj')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('# Test Project')
    expect(stdout).toContain('status: active')
  })

  it('search finds content', () => {
    const { stdout, exitCode } = run('search', 'insight')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('test-insight')
  })

  it('read nonexistent slug exits 1', () => {
    const { exitCode } = run('read', 'nonexistent-slug')
    expect(exitCode).toBe(1)
  })

  it('unknown command exits 1', () => {
    const { exitCode } = run('badcommand')
    expect(exitCode).toBe(1)
  })

  it('create entity with --brief and --add-action', () => {
    const { stdout, exitCode } = run('create', 'entity', 'CLI Create Fields Test', '--type', 'entity', '--brief', 'CLI brief context.', '--add-action', 'CLI task @dev')
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toBe('cli-create-fields-test')

    const { stdout: readOut } = run('read', 'cli-create-fields-test', '--depth', 'full')
    expect(readOut).toContain('CLI brief context.')
    expect(readOut).toContain('CLI task @dev')
  })

  it('update --synthesis sets synthesis on knowledge note', () => {
    const { stdout, exitCode } = run('update', 'test-insight', '--synthesis', 'Updated synthesis text')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('test-insight')

    const { stdout: readOut } = run('read', 'test-insight', '--depth', 'full')
    expect(readOut).toContain('Updated synthesis text')
  })

  it('update --insight (alias) sets synthesis on knowledge note', () => {
    const { stdout, exitCode } = run('update', 'test-insight', '--insight', 'Insight alias text')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('test-insight')
  })

  it('create knowledge --synthesis sets synthesis field', () => {
    const { stdout, exitCode } = run('create', 'knowledge', 'CLI Synthesis Test', '--synthesis', 'The synthesis content', '--subtype', 'insight')
    expect(exitCode).toBe(0)
    const slug = stdout.trim()
    expect(slug).toBe('cli-synthesis-test')

    const { stdout: readOut } = run('read', slug, '--depth', 'full')
    expect(readOut).toContain('The synthesis content')
  })

  it('create knowledge --insight (alias) sets synthesis field', () => {
    const { stdout, exitCode } = run('create', 'knowledge', 'CLI Insight Alias Test', '--insight', 'Insight alias content')
    expect(exitCode).toBe(0)
    const slug = stdout.trim()
    expect(slug).toBe('cli-insight-alias-test')
  })

  it('help --agent output contains hard-rules prompt-gate section', () => {
    // Migrated from the old --synthesis/--add-evidence assertions. Help is now a
    // prompt-gate, not a flat CLI reference — the individual update flags live
    // in `hafez schema update`, not here.
    const { stdout, exitCode } = run('help', '--agent')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Hard rules')
    expect(stdout).toContain('ALWAYS batch')
    expect(stdout).toContain('NEVER invent field names')
  })

  it('help --agent contains every op from the schema in the op-catalog section', () => {
    const { stdout, exitCode } = run('help', '--agent')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('<!-- SECTION:op-catalog -->')
    for (const name of ['update', 'create-entity', 'create-knowledge', 'create-session', 'capture', 'link', 'unlink', 'promote']) {
      expect(stdout).toContain(name)
    }
  })

  it('HafezError details appear in stderr', () => {
    const { stderr, exitCode } = run('update', 'test-proj', '--log', 'audit: checking stuff', '--agent', 'claude')
    expect(exitCode).toBe(2) // VALIDATION_FAILED
    expect(stderr).toContain('Invalid session log entry')
    expect(stderr).toContain('invalid session log type: audit')
    expect(stderr).toContain('progress, decision, blocker, research')
  })

  it('help --agent contains session-log enum values from the live schema', () => {
    const { stdout, exitCode } = run('help', '--agent')
    expect(exitCode).toBe(0)
    // Enum values must come from schema-introspect.ts, not hardcoded prose.
    // The critical-enums section is delimited for machine parsing.
    expect(stdout).toContain('<!-- SECTION:critical-enums -->')
    expect(stdout).toContain('progress')
    expect(stdout).toContain('decision')
    expect(stdout).toContain('blocker')
    expect(stdout).toContain('research')
  })

  it('help without --agent shows usage', () => {
    const { stdout, exitCode } = run('help')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Usage: hafez')
  })

  it('batch output includes created slugs', () => {
    const input = JSON.stringify([
      { op: 'create', kind: 'entity', name: 'CLI Batch Slug Test', fields: { type: 'entity' } },
    ])
    const { stdout, exitCode } = (() => {
      try {
        const out = execFileSync('node', [CLI, '--vault', VAULT, 'batch'], {
          input,
          encoding: 'utf-8',
          stderr: 'pipe',
        }) as string
        return { stdout: out, stderr: '', exitCode: 0 }
      } catch (err: any) {
        return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 }
      }
    })()
    expect(exitCode).toBe(0)
    expect(stdout).toContain('cli-batch-slug-test')
    expect(stdout).toContain('created:')
  })
})

describe('description flag', () => {
  it('create entity --description round-trips through read and query --json', () => {
    const create = run('create', 'entity', 'Desc CLI Proj', '--type', 'project', '--description', 'CLI summary')
    expect(create.exitCode).toBe(0)

    const read = run('read', 'desc-cli-proj')
    expect(read.stdout).toContain('> CLI summary')

    const q = run('query', '--filter', 'all', '--json')
    const data = JSON.parse(q.stdout)
    expect(data.items.find((i: any) => i.slug === 'desc-cli-proj').description).toBe('CLI summary')
  })

  it('update --description "" clears the field', () => {
    const upd = run('update', 'desc-cli-proj', '--description', '')
    expect(upd.exitCode).toBe(0)

    const q = run('query', '--filter', 'all', '--json')
    const data = JSON.parse(q.stdout)
    expect(data.items.find((i: any) => i.slug === 'desc-cli-proj').description).toBeNull()
  })
})

describe('resource flag', () => {
  it('create entity --resource round-trips through read and query --json', () => {
    const create = run('create', 'entity', 'Resource CLI Proj', '--type', 'project', '--resource', 'https://example.com/repo')
    expect(create.exitCode).toBe(0)

    const read = run('read', 'resource-cli-proj')
    expect(read.stdout).toContain('resource: https://example.com/repo')

    const q = run('query', '--filter', 'all', '--json')
    const data = JSON.parse(q.stdout)
    expect(data.items.find((i: any) => i.slug === 'resource-cli-proj').resource).toBe('https://example.com/repo')
  })

  it('update --resource on knowledge is rejected', () => {
    const r = run('update', 'test-insight', '--resource', 'https://example.com')
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('entity-only')
  })
})

describe('export --okf', () => {
  it('exports a bundle read-only (vault git log unchanged), re-export overwrites', () => {
    const { execSync } = require('child_process')
    const outDir = join(TMP, 'okf-out')
    const logBefore = execSync('git log --oneline', { cwd: VAULT, encoding: 'utf-8' })

    const first = run('export', '--okf', '--out', outDir)
    expect(first.exitCode).toBe(0)
    expect(first.stdout).toContain('Exported')
    const { existsSync: exists } = require('fs')
    expect(exists(join(outDir, 'index.md'))).toBe(true)
    expect(exists(join(outDir, 'entities', 'test-proj.md'))).toBe(true)

    const logAfter = execSync('git log --oneline', { cwd: VAULT, encoding: 'utf-8' })
    expect(logAfter).toBe(logBefore)

    const second = run('export', '--okf', '--out', outDir)
    expect(second.exitCode).toBe(0)
  })

  it('errors without --okf, as a usage error (exit 2)', () => {
    const r = run('export')
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('Usage: hafez export --okf')
  })

  it('rejects unknown flags instead of silently ignoring them', () => {
    const r = run('export', '--okf', '--bogus', 'x')
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('Unknown flag --bogus')
  })
})

describe('removed --next-action flag', () => {
  it('fails loudly instead of silently dropping the value', () => {
    const r = run('update', 'test-proj', '--next-action', 'Deploy fix')
    expect(r.exitCode).not.toBe(0)
    expect(r.stderr).toContain('--next-action was removed')
    expect(r.stderr).toContain('--add-action')
  })
})

describe('exit-code contract (C5)', () => {
  it('read of a missing slug exits 1 (NOT_FOUND)', () => {
    expect(run('read', 'no-such-slug').exitCode).toBe(1)
  })

  it('an unknown flag exits 2 (usage error)', () => {
    const r = run('read', 'test-proj', '--bogus')
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('Unknown flag --bogus')
  })

  it('a duplicate create exits 5 (SLUG_EXISTS)', () => {
    const r = run('create', 'entity', 'Test Proj', '--type', 'project')
    expect(r.exitCode).toBe(5)
    expect(r.stderr).toContain('already exists')
  })

  it('an invalid direct update enum exits 2 and writes nothing', () => {
    const r = run('update', 'test-proj', '--status', 'bananas')
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('Invalid status')
    expect(readFileSync(join(VAULT, 'entities', 'test-proj.md'), 'utf-8')).not.toContain('bananas')
  })

  it('help --agent documents the exit codes', () => {
    const { stdout, exitCode } = run('help', '--agent')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('## Exit codes')
    expect(stdout).toContain('vault locked')
  })
})

// tests/cli.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { serializeFile } from '../src/vault.js'
import { simpleGit } from 'simple-git'
import { localDay } from '../src/dates.js'

const TMP = join(tmpdir(), 'hafez-cli-test-' + Date.now())
const BARE = join(TMP, 'remote.git')
const VAULT = join(TMP, 'vault')
const CLI = join(process.cwd(), 'dist', 'cli.js')

function runWithStdin(input: string | undefined, ...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync('node', [CLI, '--vault', VAULT, ...args], {
      encoding: 'utf-8',
      input,
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
  return runWithStdin(undefined, ...args)
}

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  mkdirSync(BARE, { recursive: true })
  await simpleGit(BARE).init(true)
  await simpleGit().clone(BARE, VAULT)
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })

  const today = localDay()
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

// install:local is a dev-checkout script in POSIX shell (ln -s, ~, chmod),
// which npm runs through cmd.exe on Windows. Windows installs through npm and
// `onboard --install` instead (#177).
describe.skipIf(process.platform === 'win32')('install:local', () => {
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
    const { stdout, stderr, exitCode } = (() => {
      try {
        const out = execFileSync('node', [join(INSTALL_HOME, '.local', 'bin', 'hafez'), '--help'], {
          encoding: 'utf-8',
        }) as string
        return { stdout: out, stderr: '', exitCode: 0 }
      } catch (err: any) {
        return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', exitCode: err.status ?? 1 }
      }
    })()
    expect(exitCode, stderr).toBe(0)
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
    for (const cmd of ['read', 'query', 'search', 'create', 'capture', 'promote', 'update', 'batch', 'digest', 'sync', 'stats', 'changelog', 'schema', 'validate', 'init', 'onboard', 'upgrade', 'help --agent']) {
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

  // #91: the miss render, on stderr, exit 1 (the not-found code).
  const CREATE_TAIL = '--type <project|entity> --parent <slug you read, or its parent> --resource <. if the work lives in this folder> --description "<one sentence>" --brief "<where things stand>" --add-action "<next step>"'

  it('read miss with close slugs prints them read-ready, then the create line', () => {
    const { stdout, stderr, exitCode } = run('read', 'test-projects')
    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe([
      "Error: no entity or knowledge note 'test-projects'.",
      'hafez read test-proj',
      'hafez read test-insight',
      `hafez create entity "test projects" ${CREATE_TAIL}`,
      '',
    ].join('\n'))
  })

  it('read miss with no close slug prints the search line and the create line, nothing else', () => {
    const { stdout, stderr, exitCode } = run('read', 'launchpads')
    expect(exitCode).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toBe([
      "Error: no entity or knowledge note 'launchpads'.",
      'hafez search "launchpads"',
      `hafez create entity "launchpads" ${CREATE_TAIL}`,
      '',
    ].join('\n'))
  })

  it('read miss --json returns the candidates as a list on stdout, exit 1', () => {
    const hit = run('--json', 'read', 'test-projects')
    expect(hit.exitCode).toBe(1)
    expect(JSON.parse(hit.stdout)).toEqual({ slug: 'test-projects', closest: ['test-proj', 'test-insight'] })
    const none = run('--json', 'read', 'launchpads')
    expect(none.exitCode).toBe(1)
    expect(JSON.parse(none.stdout)).toEqual({ slug: 'launchpads', closest: [] })
  })

  it('list is an unknown command that names query (#30)', () => {
    const { stderr, exitCode } = run('list')
    expect(exitCode).toBe(1)
    expect(stderr.split('\n')[0]).toBe('Unknown command: list. To list the vault: hafez query --filter active')
  })

  it('unknown command exits 1', () => {
    const { exitCode } = run('badcommand')
    expect(exitCode).toBe(1)
  })

  it('a command named after an Object.prototype member is unknown (#134)', () => {
    for (const name of ['constructor', 'toString', '__proto__']) {
      const { stderr, exitCode } = run(name)
      expect(exitCode).toBe(1)
      expect(stderr.split('\n')[0]).toBe(`Unknown command: ${name}`)
    }
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
    // The slug is the first line; a relate line follows it, since this name
    // resembles the note the previous test created.
    const slug = stdout.split('\n')[0]
    expect(slug).toBe('cli-insight-alias-test')
  })

  it('create entity --insight is rejected, not silently dropped', () => {
    // insight is knowledge-only: the Op Spec's kind gate rejects it. A flag the
    // CLI drops on the floor is a false success.
    const { stderr, exitCode } = run('create', 'entity', 'CLI Insight On Entity', '--type', 'entity', '--insight', 'nope')
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('insight')
    expect(existsSync(join(VAULT, 'entities', 'cli-insight-on-entity.md'))).toBe(false)
  })

  it('help --agent prints the hafez skill body (#100)', () => {
    // The one text from one source: the byte-for-byte check against the
    // committed skill file is in tests/surfaces.test.ts; the old op catalogue
    // lives in `hafez schema`.
    const { stdout, exitCode } = run('help', '--agent')
    expect(exitCode).toBe(0)
    expect(stdout.startsWith('# Hafez\n')).toBe(true)
    expect(stdout).toContain('## Less common operations')
    expect(stdout).toContain('hafez schema <op>')
    expect(stdout).not.toContain('<!-- SECTION:')
  })

  it('HafezError details appear in stderr', () => {
    // Two invalid fields → two Op Spec shape errors → message plus detail lines
    const { stderr, exitCode } = run('update', 'test-proj', '--status', 'bananas', '--log', 'audit: checking stuff', '--agent', 'claude')
    expect(exitCode).toBe(2) // VALIDATION_FAILED
    expect(stderr).toContain('invalid shape at fields.status')
    expect(stderr).toContain('invalid shape at fields.session_log.type')
    expect(stderr).toContain('  - ') // details rendered as list lines
    expect(stderr).toContain('"progress"|"decision"|"blocker"|"research"')
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
    const { stdout, exitCode } = runWithStdin(input, 'batch')
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
    expect(data.items.find((i: any) => i.slug === 'resource-cli-proj').resource).toEqual(['https://example.com/repo'])
  })

  it('several values: one ` · `-joined header line, the list in read --json', () => {
    expect(run('create', 'entity', 'Two Places', '--type', 'project', '--resource', 'https://example.com/a').exitCode).toBe(0)
    expect(run('update', 'two-places', '--resource', '/srv/two-places').exitCode).toBe(0)
    const lines = run('read', 'two-places').stdout.split('\n').filter(l => l.startsWith('resource:'))
    expect(lines).toEqual(['resource: https://example.com/a · /srv/two-places'])
    const json = JSON.parse(run('read', 'two-places', '--json').stdout)
    expect(json.frontmatter.resource).toEqual(['https://example.com/a', '/srv/two-places'])
  })

  it('no resource line when the entity has none', () => {
    expect(run('create', 'entity', 'No Place', '--type', 'entity').exitCode).toBe(0)
    expect(run('read', 'no-place').stdout).not.toMatch(/^resource:/m)
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
    expect(r.stderr).toContain('invalid shape at fields.status')
    expect(r.stderr).toContain('"active"|"paused"|"done"')
    expect(readFileSync(join(VAULT, 'entities', 'test-proj.md'), 'utf-8')).not.toContain('bananas')
  })

  it('hafez --help documents the exit codes; help --agent does not (#89)', () => {
    const help = run('--help')
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain('Exit codes:')
    expect(help.stdout).toContain('vault locked')
    const agent = run('help', '--agent')
    expect(agent.exitCode).toBe(0)
    expect(agent.stdout).not.toMatch(/exit codes/i)
  })

  it('<command> --help or -h prints that command\'s usage on stdout, exit 0 (#32)', () => {
    const digest = run('digest', '--help')
    expect(digest.exitCode, digest.stderr).toBe(0)
    expect(digest.stdout).toContain('Usage: hafez digest')
    expect(digest.stdout).not.toContain('Unknown flag')
    const update = run('update', '-h')
    expect(update.exitCode, update.stderr).toBe(0)
    expect(update.stdout).toContain('Usage: hafez update <slug>')
    expect(update.stdout).toContain('[--complete-action handle-or-text (repeats)] [--remove-action handle-or-text (repeats)]')
    const read = run('read', 'test-proj', '--help')
    expect(read.exitCode, read.stderr).toBe(0)
    expect(read.stdout.trim()).toBe('Usage: hafez read <slug> [--depth frontmatter|summary|full] [--archive]')
    for (const [args, usage] of [
      [['upgrade', '-h'], 'Usage: hafez upgrade [--json]'],
      [['index', '--help'], 'Usage: hafez index rebuild'],
      [['stats', '--help'], 'Usage: hafez stats'],
      [['validate', '-h'], 'Usage: hafez validate'],
      [['schema', '--help'], 'Usage: hafez schema [op] [--examples]'],
      [['init', '--help'], 'Usage: hafez init [--register <path>]'],
    ] as const) {
      const r = run(...args)
      expect(r.exitCode, r.stderr).toBe(0)
      expect(r.stdout.trim()).toBe(usage)
    }
  })

  it('sync --help prints usage and never pulls or pushes (#32)', async () => {
    // A scratch vault one commit ahead of its remote: a real sync would push it.
    const root = join(TMP, 'sync-help')
    const bare = join(root, 'remote.git')
    const vault = join(root, 'vault')
    mkdirSync(bare, { recursive: true })
    await simpleGit(bare).init(true)
    await simpleGit().clone(bare, vault)
    mkdirSync(join(vault, 'entities'), { recursive: true })
    writeFileSync(join(vault, 'entities', '.keep'), '')
    const git = simpleGit(vault)
    await git.add('.')
    await git.commit('init')
    const branch = (await git.branchLocal()).current
    await git.push('origin', branch)
    writeFileSync(join(vault, 'entities', '.keep'), 'ahead')
    await git.add('.')
    await git.commit('unpushed')
    const local = await git.revparse(['HEAD'])
    const remote = await simpleGit(bare).revparse([branch])

    for (const flag of ['--help', '-h']) {
      let stdout = ''
      let exitCode = 0
      try {
        stdout = execFileSync('node', [CLI, '--vault', vault, 'sync', flag], { encoding: 'utf-8' })
      } catch (err: any) {
        stdout = err.stdout ?? ''
        exitCode = err.status ?? 1
      }
      expect(exitCode).toBe(0)
      expect(stdout).toContain('Usage: hafez sync')
    }
    expect(await git.revparse(['HEAD'])).toBe(local)
    expect(await simpleGit(bare).revparse([branch])).toBe(remote)
    expect((await git.status()).isClean()).toBe(true)
  })

  it('update <slug> -h writes nothing (#32)', () => {
    const before = readFileSync(join(VAULT, 'entities', 'test-proj.md'), 'utf-8')
    const r = run('update', 'test-proj', '--brief', 'not written', '-h')
    expect(r.exitCode, r.stderr).toBe(0)
    expect(r.stdout).toContain('Usage: hafez update <slug>')
    expect(readFileSync(join(VAULT, 'entities', 'test-proj.md'), 'utf-8')).toBe(before)
  })

  it('an invalid subtype on direct create exits 2, not a crash (Spine strictness)', () => {
    const r = run('create', 'knowledge', 'Bad Subtype Note', '--subtype', 'bogus')
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toContain('invalid shape at fields.subtype')
    expect(existsSync(join(VAULT, 'knowledge', 'bad-subtype-note.md'))).toBe(false)
  })
})

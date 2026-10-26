// tests/onboard-block.test.ts
//
// The temp-home seam for `onboard --block`, the SessionStart hook's render:
// one line per entity whose `resource` or slug matches the folder, and never
// the Block, which the instructions file already carries (#234). Three
// folders are tried, each exactly: the working directory, its git root, and
// in a linked worktree the main repository's root. No match in a git folder
// that is not the vault's checkout prints the no-match line; any other miss,
// and any failure, prints nothing. The three renders in
// tests/fixtures/surfaces/onboard.md are checked whole in tests/surfaces.test.ts.

import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, realpathSync, symlinkSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cmdOnboard } from '../src/cli/onboard.js'
import { ITEMS } from '../src/surfaces/items.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const tempDir = (prefix: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  dirs.push(dir)
  return dir
}

interface Seed {
  slug: string
  status?: 'active' | 'paused' | 'done'
  description?: string
  resource?: string | string[]
}

/** A home whose config names a vault holding `entities`. */
function setup(entities: Seed[]): { home: string; vault: string } {
  const home = tempDir('hafez-home-')
  const vault = tempDir('hafez-vault-')
  mkdirSync(join(vault, 'entities'))
  mkdirSync(join(vault, 'knowledge'))
  for (const e of entities) {
    writeFileSync(join(vault, 'entities', `${e.slug}.md`), [
      '---',
      `name: ${e.slug}`,
      'type: project',
      `status: ${e.status ?? 'active'}`,
      'created: 2026-10-01',
      'last-touched: 2026-10-01',
      ...(e.description ? [`description: ${e.description}`] : []),
      ...(Array.isArray(e.resource) ? ['resource:', ...e.resource.map(r => `  - '${r}'`)] : e.resource ? [`resource: '${e.resource}'`] : []),
      '---',
      '',
      '## Brief',
      '',
      'x',
      '',
    ].join('\n'))
  }
  mkdirSync(join(home, '.config', 'hafez'), { recursive: true })
  writeFileSync(join(home, '.config', 'hafez', 'vault'), vault + '\n')
  return { home, vault }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'pipe' }).toString()

/** A git repository at `parent/name`, with one commit so worktrees can branch. */
function repo(parent: string, name: string): string {
  const root = join(parent, name)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init')
  return root
}

const block = (home: string, cwd: string, ...args: string[]) =>
  cmdOnboard(['--block', ...args], { home, env: {}, cwd })

/** The built CLI, run from `home` with `home` as the user's home. */
const cli = (home: string, ...args: string[]) =>
  spawnSync('node', [join(process.cwd(), 'dist', 'cli.js'), ...args], {
    cwd: home,
    env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
    encoding: 'utf-8',
  })

const AUTH = { slug: 'auth-refactor', description: 'Move session handling from cookies to short-lived tokens' }
const LINE = 'hafez read auth-refactor (Move session handling from cookies to short-lived tokens)'
const NO_MATCH = `${ITEMS.noMatchLine.render()}\n`

describe('onboard --block: the render', () => {
  it('prints the read line alone, never the Block', async () => {
    const { home } = setup([AUTH])
    const cwd = join(tempDir('work-'), 'auth-refactor')
    mkdirSync(cwd)
    expect(await block(home, cwd)).toBe(`This folder is a Hafez entity. Read it first:\n${LINE}\n`)
  })

  it('prints nothing when nothing matches outside git', async () => {
    const { home } = setup([AUTH])
    expect(await block(home, tempDir('elsewhere-'))).toBeNull()
  })

  it('the built CLI prints nothing and exits 0 when nothing matches', () => {
    const { home } = setup([AUTH])
    const r = cli(home, 'onboard', '--block')
    expect({ stdout: r.stdout, status: r.status }).toEqual({ stdout: '', status: 0 })
  })

  it('prints the slug alone when the entity has no description', async () => {
    const { home } = setup([{ slug: 'auth-refactor' }])
    const cwd = join(tempDir('work-'), 'auth-refactor')
    mkdirSync(cwd)
    expect(await block(home, cwd)).toBe('This folder is a Hafez entity. Read it first:\nhafez read auth-refactor\n')
  })

  it('looks for the config under XDG_CONFIG_HOME over ~/.config when it is set', async () => {
    const { home } = setup([AUTH])
    const xdg = tempDir('xdg-')
    expect(await cmdOnboard(['--block'], { home, env: { XDG_CONFIG_HOME: xdg }, cwd: home })).toBeNull()
  })

  it('accepts --harness', async () => {
    const { home } = setup([])
    expect(await block(home, tempDir('elsewhere-'), '--harness', 'claude-code')).toBeNull()
  })
})

describe('onboard --block: the three folders', () => {
  it('matches a resource equal to the working directory', async () => {
    const cwd = tempDir('anything-')
    const { home } = setup([{ ...AUTH, resource: cwd }])
    expect(await block(home, cwd)).toContain(LINE)
  })

  it('matches a slug equal to the git root\'s name from a subdirectory', async () => {
    const { home } = setup([AUTH])
    const root = repo(tempDir('work-'), 'auth-refactor')
    const cwd = join(root, 'src', 'deep')
    mkdirSync(cwd, { recursive: true })
    expect(await block(home, cwd)).toContain(LINE)
  })

  it('matches a resource equal to the git root', async () => {
    const root = repo(tempDir('work-'), 'checkout')
    const { home } = setup([{ ...AUTH, resource: root }])
    const cwd = join(root, 'src')
    mkdirSync(cwd)
    expect(await block(home, cwd)).toContain(LINE)
  })

  it('matches a resource that reaches the git root through a symlink', async () => {
    const work = tempDir('work-')
    const root = repo(work, 'checkout')
    const link = join(work, 'link')
    // A junction on Windows, which needs no privilege; the type is ignored elsewhere.
    symlinkSync(root, link, 'junction')
    const { home } = setup([{ ...AUTH, resource: link }])
    expect(await block(home, root)).toContain(LINE)
  })

  // git prints `C:/…`, and a resource may be typed in any letter case (#189).
  it.runIf(process.platform === 'win32')('matches a resource equal to the git root in another spelling', async () => {
    const root = repo(tempDir('work-'), 'checkout')
    const { home } = setup([{ ...AUTH, resource: root.toLowerCase().replaceAll('\\', '/') }])
    const cwd = join(root, 'src')
    mkdirSync(cwd)
    expect(await block(home, cwd)).toContain(LINE)
  })

  it('matches a resource equal to the git root\'s remote URL, however it is spelled', async () => {
    const root = repo(tempDir('work-'), 'checkout')
    git(root, 'remote', 'add', 'origin', 'git@github.com:Acme/Auth-Service.git')
    const { home } = setup([{ ...AUTH, resource: 'https://github.com/acme/auth-service/' }])
    expect(await block(home, root)).toContain(LINE)
  })

  it('matches a slug equal to the main repository\'s name from a linked worktree', async () => {
    const work = tempDir('work-')
    const main = repo(work, 'auth-refactor')
    git(main, 'worktree', 'add', '-q', join(work, 'auth-refactor-42'))
    const cwd = join(work, 'auth-refactor-42', 'src')
    mkdirSync(cwd)
    const { home } = setup([AUTH])
    expect(await block(home, cwd)).toContain(LINE)
  })

  it('matches a resource equal to the main repository\'s root from a linked worktree', async () => {
    const work = tempDir('work-')
    const main = repo(work, 'checkout')
    git(main, 'worktree', 'add', '-q', join(work, 'wt'))
    const { home } = setup([{ ...AUTH, resource: main }])
    expect(await block(home, join(work, 'wt'))).toContain(LINE)
  })

  it('does not match a parent directory of the working directory', async () => {
    const { home } = setup([AUTH])
    const cwd = join(tempDir('work-'), 'auth-refactor', 'notes')
    mkdirSync(cwd, { recursive: true })
    expect(await block(home, cwd)).toBeNull()
  })

  it('does not match a directory between the working directory and the git root', async () => {
    const { home } = setup([AUTH])
    const root = repo(tempDir('work-'), 'checkout')
    const cwd = join(root, 'auth-refactor', 'src')
    mkdirSync(cwd, { recursive: true })
    expect(await block(home, cwd)).toBe(NO_MATCH)
  })

  it('does not match a directory above the git root', async () => {
    const { home } = setup([AUTH])
    const root = repo(join(tempDir('work-'), 'auth-refactor'), 'checkout')
    expect(await block(home, root)).toBe(NO_MATCH)
  })
})

describe('onboard --block: the no-match line', () => {
  it('prints the no-match line in a git folder no entity matches', async () => {
    const { home } = setup([AUTH])
    const root = repo(tempDir('work-'), 'checkout')
    expect(await block(home, root)).toBe(NO_MATCH)
  })

  it('prints only the read line in a git folder an entity matches', async () => {
    const { home } = setup([AUTH])
    const root = repo(tempDir('work-'), 'auth-refactor')
    expect(await block(home, root)).toBe(`This folder is a Hafez entity. Read it first:\n${LINE}\n`)
  })

  it('prints nothing in the vault\'s own checkout, from its root or a subfolder', async () => {
    const { home, vault } = setup([AUTH])
    git(vault, 'init', '-q')
    expect(await block(home, vault)).toBeNull()
    expect(await block(home, join(vault, 'entities'))).toBeNull()
  })

  it('prints nothing in a linked worktree of the vault\'s repository', async () => {
    const { home, vault } = setup([AUTH])
    git(vault, 'init', '-q')
    git(vault, 'add', '-A')
    git(vault, 'commit', '-q', '-m', 'init')
    const wt = join(tempDir('work-'), 'vault-wt')
    git(vault, 'worktree', 'add', '-q', wt)
    expect(await block(home, wt)).toBeNull()
  })
})

describe('onboard --block: several matches', () => {
  it('prints them all, active first', async () => {
    const cwd = join(tempDir('work-'), 'auth-refactor')
    mkdirSync(cwd)
    const { home } = setup([
      { slug: 'auth-a', status: 'done', resource: cwd },
      { slug: 'auth-b', status: 'paused', resource: cwd },
      { slug: 'auth-refactor', status: 'active' },
      { slug: 'unrelated', status: 'active' },
    ])
    const out = (await block(home, cwd))!
    expect(out).toBe([
      'This folder matches several Hafez entities. Read the one that fits first:',
      'hafez read auth-refactor',
      'hafez read auth-b',
      'hafez read auth-a',
      '',
    ].join('\n'))
  })
})

describe('onboard --block: several values (#304)', () => {
  it('prints the read line when any one of several values matches', async () => {
    const root = repo(tempDir('work-'), 'checkout')
    git(root, 'remote', 'add', 'origin', 'git@github.com:acme/auth-service-dev.git')
    const { home } = setup([{ ...AUTH, resource: ['https://github.com/acme/auth-service', '/nowhere/auth', 'https://github.com/acme/auth-service-dev'] }])
    expect(await block(home, root)).toContain(LINE)
  })
})

describe('onboard --block: any failure prints nothing', () => {
  it('prints nothing when no vault is configured', async () => {
    const home = tempDir('hafez-home-')
    expect(await block(home, home)).toBeNull()
  })

  it('prints nothing when the config names a folder that is not a vault', async () => {
    const home = tempDir('hafez-home-')
    mkdirSync(join(home, '.config', 'hafez'), { recursive: true })
    writeFileSync(join(home, '.config', 'hafez', 'vault'), join(home, 'nowhere') + '\n')
    expect(await block(home, home)).toBeNull()
  })

  it('prints nothing when the working directory is gone', async () => {
    const { home } = setup([AUTH])
    expect(await block(home, join(home, 'deleted'))).toBeNull()
  })

  it('prints nothing and leaves no index behind when --vault names a folder that is not a vault', async () => {
    const home = tempDir('hafez-home-')
    const notVault = tempDir('not-vault-')
    expect(await cmdOnboard(['--block'], { home, env: {}, cwd: home, vaultFlag: notVault })).toBeNull()
    expect(readdirSync(notVault)).toEqual([])
  })

  it('the built CLI exits 0 with empty stdout on an unresolvable vault', () => {
    const home = tempDir('hafez-home-')
    const stdout = execFileSync('node', [join(process.cwd(), 'dist', 'cli.js'), 'onboard', '--block'], {
      cwd: home,
      // os.homedir() reads USERPROFILE on Windows: without it the CLI finds
      // the real user's config, and the real vault.
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home },
      encoding: 'utf-8',
    })
    expect(stdout).toBe('')
  })

  // A hand-edited hook line, or one an older install wrote with a flag a newer
  // binary dropped, must not block the session either (#132).
  it.each([
    ['an unknown harness', ['onboard', '--block', '--harness', 'nope']],
    ['an unknown flag', ['onboard', '--block', '--bogus']],
    ['a flag --block does not take', ['onboard', '--block', '--install', '--mode', 'always-on']],
    ['an unexpected argument', ['onboard', '--block', 'extra']],
    ['--vault with no value', ['onboard', '--block', '--vault']],
    ['--vault given twice', ['--vault', '/a', 'onboard', '--block', '--vault', '/b']],
  ])('the built CLI prints nothing and exits 0 on %s', (_, args) => {
    const { home } = setup([AUTH])
    const r = cli(home, ...args)
    expect({ stdout: r.stdout, stderr: r.stderr, status: r.status }).toEqual({ stdout: '', stderr: '', status: 0 })
    expect(readdirSync(home)).toEqual(['.config'])
  })

  it('without --block, a bad onboard invocation is still a usage error', () => {
    const home = tempDir('hafez-home-')
    const r = cli(home, 'onboard', '--harness', 'nope')
    expect(r.status).toBe(2)
    expect(r.stderr).toMatch(/^Error: /)
  })
})

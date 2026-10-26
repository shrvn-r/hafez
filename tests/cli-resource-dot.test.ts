// tests/cli-resource-dot.test.ts
//
// The `.` token (#306): `--resource .` on `create entity` and `update`, and
// `"resource": "."` in a `batch` payload, resolve against the command's
// working directory before the library sees them: the git root's `origin`
// URL as git prints it, else its first remote's, else the git root's
// canonical path, else the working directory's. Driven at the command
// functions with an injected cwd, over temp git repos.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHafez, removeTemp } from './helpers/hafez.js'
import { createMemoryJournal } from './helpers/memory-journal.js'
import { cmdBatch, cmdCreate, cmdUpdate } from '../src/cli/commands.js'
import { cmdOnboard } from '../src/cli/onboard.js'
import { canonical } from '../src/resource.js'
import type { Hafez } from '../src/types.js'

let TMP: string
let os: Hafez

beforeEach(() => {
  TMP = realpathSync(mkdtempSync(join(tmpdir(), 'hafez-dot-')))
  const vault = join(TMP, 'vault')
  mkdirSync(join(vault, 'entities'), { recursive: true })
  mkdirSync(join(vault, 'knowledge'), { recursive: true })
  os = createHafez({ vaultPath: vault, persistence: createMemoryJournal() })
})

afterEach(() => removeTemp(TMP))

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'pipe' }).toString()

/** A git repository at `TMP/name`, with one commit so worktrees can branch. */
function repo(name: string, remotes: [string, string][] = []): string {
  const root = join(TMP, name)
  mkdirSync(root, { recursive: true })
  git(root, 'init', '-q')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init')
  for (const [remote, url] of remotes) git(root, 'remote', 'add', remote, url)
  return root
}

const resourceOf = async (slug: string): Promise<unknown> =>
  ((await os.read(slug)) as unknown as { frontmatter: Record<string, unknown> }).frontmatter.resource

describe('--resource . on create entity', () => {
  it('resolves to the origin URL as git prints it', async () => {
    const root = repo('app', [['upstream', 'https://github.com/up/app'], ['origin', 'git@github.com:Org/App.git']])
    await cmdCreate(os, ['entity', 'App', '--type', 'project', '--resource', '.'], { cwd: root })
    expect(await resourceOf('app')).toEqual(['git@github.com:Org/App.git'])
  })
})

describe('--resource . never writes credentials', () => {
  it.each([
    ['https://user:s3cret@example.com/org/app.git', 'https://example.com/org/app.git'],
    ['https://token@example.com/org/app', 'https://example.com/org/app'],
    ['ssh://git@example.com:2222/org/app.git', 'ssh://example.com:2222/org/app.git'],
    ['git@github.com:Org/App.git', 'git@github.com:Org/App.git'],
  ])('%s is written as %s', async (url, written) => {
    const root = repo('app', [['origin', url]])
    await cmdCreate(os, ['entity', 'App', '--type', 'project', '--resource', '.'], { cwd: root })
    expect(await resourceOf('app')).toEqual([written])
  })
})

describe('--resource . writes what the hook matches', () => {
  /** A vault home whose config names the test vault, for the hook. */
  const hookHome = (): string => {
    const home = join(TMP, 'home')
    mkdirSync(join(home, '.config', 'hafez'), { recursive: true })
    writeFileSync(join(home, '.config', 'hafez', 'vault'), join(TMP, 'vault') + '\n')
    return home
  }

  it('the remote URL as configured, before any url.<base>.insteadOf rewrite', async () => {
    const root = repo('app', [['origin', 'ex:org/app']])
    git(root, 'config', 'url.https://example.com/.insteadOf', 'ex:')
    await cmdCreate(os, ['entity', 'App', '--type', 'project', '--resource', '.'], { cwd: root })
    expect(await resourceOf('app')).toEqual(['ex:org/app'])
    expect(await cmdOnboard(['--block'], { home: hookHome(), env: {}, cwd: root })).toContain('hafez read app')
  })

  it('in a repo with no remote, a linked worktree and the main checkout write the main root, which the hook matches from both', async () => {
    const root = repo('local')
    const wt = join(TMP, 'local-wt')
    git(root, 'worktree', 'add', '-q', '-b', 'side', wt)
    await cmdCreate(os, ['entity', 'Local', '--type', 'project', '--resource', '.'], { cwd: wt })
    await cmdUpdate(os, ['local', '--resource', '.'], { cwd: root })
    expect(await resourceOf('local')).toEqual([canonical(root)])
    const home = hookHome()
    expect(await cmdOnboard(['--block'], { home, env: {}, cwd: wt })).toContain('hafez read local')
    expect(await cmdOnboard(['--block'], { home, env: {}, cwd: root })).toContain('hafez read local')
  })
})

describe('--resource . resolution order', () => {
  const dot = async (cwd: string, name: string): Promise<unknown> => {
    await cmdCreate(os, ['entity', name, '--type', 'project', '--resource', '.'], { cwd })
    return resourceOf(name.toLowerCase())
  }

  it('without origin, resolves to the first remote', async () => {
    const root = repo('app', [['upstream', 'https://github.com/up/app'], ['mirror', 'https://gitlab.com/m/app']])
    expect(await dot(root, 'App')).toEqual(['https://github.com/up/app'])
  })

  it('without a remote, resolves to the git root canonical path', async () => {
    const root = repo('local')
    expect(await dot(root, 'Local')).toEqual([canonical(root)])
  })

  it('outside git, resolves to the working directory canonical path', async () => {
    const plain = join(TMP, 'plain')
    mkdirSync(plain)
    expect(await dot(plain, 'Plain')).toEqual([canonical(plain)])
  })

  it('from a subfolder, resolves to the repo, not the subfolder', async () => {
    const root = repo('local')
    const sub = join(root, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    expect(await dot(sub, 'Local')).toEqual([canonical(root)])
  })

  it('from a linked worktree, resolves to the same value as the main checkout', async () => {
    const root = repo('app', [['origin', 'https://github.com/org/app.git']])
    const wt = join(TMP, 'app-wt')
    git(root, 'worktree', 'add', '-q', '-b', 'side', wt)
    expect(await dot(wt, 'Wt')).toEqual(await dot(root, 'Main'))
  })

  it('a no-remote path is what the hook Folder match finds, from any subfolder', async () => {
    const root = repo('local')
    const sub = join(root, 'pkg')
    mkdirSync(sub)
    await cmdCreate(os, ['entity', 'Local', '--type', 'project', '--resource', '.'], { cwd: sub })
    const home = join(TMP, 'home')
    mkdirSync(join(home, '.config', 'hafez'), { recursive: true })
    writeFileSync(join(home, '.config', 'hafez', 'vault'), join(TMP, 'vault') + '\n')
    const out = await cmdOnboard(['--block'], { home, env: {}, cwd: sub })
    expect(out).toContain('hafez read local')
  })
})

describe('update --resource .', () => {
  it('twice from one repo leaves one value; from a second repo adds a second', async () => {
    const one = repo('one', [['origin', 'git@github.com:org/one.git']])
    const two = repo('two')
    await cmdCreate(os, ['entity', 'Work', '--type', 'project'])
    await cmdUpdate(os, ['work', '--resource', '.'], { cwd: one })
    await cmdUpdate(os, ['work', '--resource', '.'], { cwd: one })
    expect(await resourceOf('work')).toEqual(['git@github.com:org/one.git'])
    await cmdUpdate(os, ['work', '--resource', '.'], { cwd: two })
    expect(await resourceOf('work')).toEqual(['git@github.com:org/one.git', canonical(two)])
  })
})

describe('batch "resource": "."', () => {
  it('--data resolves . in create and update ops, string or list', async () => {
    const root = repo('app', [['origin', 'https://github.com/org/app']])
    await cmdCreate(os, ['entity', 'Old', '--type', 'project'])
    const payload = JSON.stringify([
      { op: 'create', kind: 'entity', name: 'New', fields: { type: 'project', resource: '.' } },
      { op: 'update', slug: 'old', fields: { resource: ['https://docs.example.com', '.'] } },
    ])
    await cmdBatch(os, ['--data', payload], { cwd: root })
    expect(await resourceOf('new')).toEqual(['https://github.com/org/app'])
    expect(await resourceOf('old')).toEqual(['https://docs.example.com', 'https://github.com/org/app'])
  })

  it('--dry-run shows the resolved value and writes nothing', async () => {
    const root = repo('app', [['origin', 'https://github.com/org/app']])
    const payload = JSON.stringify([{ op: 'create', kind: 'entity', name: 'New', fields: { type: 'project', resource: '.' } }])
    const out = await cmdBatch(os, ['--data', payload, '--dry-run'], { cwd: root })
    expect(out).toContain('Batch valid: 1 operations would be applied')
    expect(out).toContain('op[0] resource . → https://github.com/org/app')
    await expect(os.read('new')).rejects.toThrow()
  })
})

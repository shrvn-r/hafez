// src/resource.ts
//
// The Resource module (#303): what a folder is to the Folder match, one
// definition the SessionStart hook (`onboard --block`) and the write path
// share. Three folders are tried, each exactly: the working directory, its
// git root, and in a linked worktree the main repository's root; no directory
// in between. A `resource` matches a folder's path or the URL of one of its
// git remotes (case, scheme, user, `.git`, trailing slash, ssh `host:` form
// aside). Two URLs are one by the same rule, other values when equal as
// written (`addResources`, the duplicate rule). The CLI spells
// `--resource .` with `resolveDot`, the folder as the match will see it. Git runs only
// when a git-backed helper is called: importing this module, or calling
// `normaliseUrl` or `addResources`, runs no git and reads no cwd.

import { execFileSync } from 'child_process'
import { existsSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, resolve } from 'path'

/** git's output, or null when git fails or is absent. */
function git(cwd: string, ...args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim()
  } catch {
    return null
  }
}

/** The working directory, its git root, and in a linked worktree the main
 * repository's root. `roots` is `gitRoots(cwd)`, given when the caller holds
 * it already (each git run costs on drvfs). */
export function foldersOf(cwd: string, roots: string[] = gitRoots(cwd)): string[] {
  return [...new Set([cwd, ...roots])]
}

/** The git root of the work tree holding `cwd`, and in a linked worktree the
 * main repository's root; none outside a work tree. */
export function gitRoots(cwd: string): string[] {
  const out = git(cwd, 'rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir')
  const [top, common] = out?.split('\n') ?? []
  // Before git 2.31 `--path-format` is echoed back, not obeyed: no git root.
  if (!top || !common || !isAbsolute(top) || !isAbsolute(common)) return []
  const root = canonical(top)
  // A linked worktree shares the main checkout's `.git` as its common dir.
  // The shape is read off git's own path: a symlinked `.git` resolves to a
  // directory with some other name.
  const main = canonical(dirname(common))
  return basename(common) === '.git' && main !== root ? [root, main] : [root]
}

/** One spelling per folder, so paths from git, the working directory and a
 * `resource` compare equal: git prints `C:/…` on Windows, realpath `C:\…`.
 * The native realpath, since only it returns the filesystem's own letter case
 * (`c:\users\…` is `C:\Users\…`) and long names for 8.3 ones. */
export function canonical(path: string): string {
  const abs = resolve(path)
  return existsSync(abs) ? realpathSync.native(abs) : abs
}

/** What `--resource .` names (#306): the `origin` URL as configured, else
 * the first remote's, else the main checkout's root, else the working
 * directory. The URL is the raw config value the hook's `remoteUrls` reads
 * (no `insteadOf` rewrite), userinfo dropped. A subfolder resolves to the
 * repo, and a linked worktree to what its main checkout resolves to: the
 * remote config is shared, and the main root is a folder the hook tries from
 * both. A path is `canonical`, the spelling the Folder match compares. */
export function resolveDot(cwd: string): string {
  const root = gitRoots(cwd).at(-1)
  if (!root) return canonical(cwd)
  const remotes = remoteConfig(root)
  const url = (remotes.find(([name]) => name === 'origin') ?? remotes[0])?.[1]
  return url ? withoutUserinfo(url) : root
}

/** A scheme URL with its userinfo (user and password) dropped, so a token
 * in a remote URL never lands in the vault; an scp-form `git@host:path` is
 * left as written, its user no secret. */
function withoutUserinfo(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1')
}

/** Every remote's URL, normalised. */
export function remoteUrls(cwd: string): string[] {
  return remoteConfig(cwd).map(([, url]) => normaliseUrl(url))
}

/** Each remote URL with its remote's name, as the config holds them, in
 * config order (`git remote` sorts names; `get-url` applies `insteadOf`):
 * the one read `.` and the hook share, so what `.` writes is what the hook
 * matches. */
function remoteConfig(cwd: string): [name: string, url: string][] {
  const out = git(cwd, 'config', '--get-regexp', '^remote\\..*\\.url$')
  return (out ? out.split('\n') : []).map(line => {
    const space = line.indexOf(' ')
    return [line.slice('remote.'.length, space - '.url'.length), line.slice(space + 1)]
  })
}

/** `git@github.com:Org/Repo.git`, `ssh://git@github.com/org/repo` and
 * `https://github.com/org/repo/` are all `github.com/org/repo`. */
export function normaliseUrl(url: string): string {
  return url.trim().toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d)/, '$1/')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '')
}

/** A scheme URL (`https://…`, `ssh://…`) or an scp-form `user@host:path`. */
const URL_SHAPED = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^@/\s]+@[^:/\s]+:)/i

/** The duplicate rule: `values` added to `existing`, skipping each that is
 * already there. A URL (a scheme `://`, or scp-form `user@host:path`)
 * compares normalised; every other value as written (the resolver writes
 * paths canonical). The first spelling and first-addition order stay. */
export function addResources(existing: string[], values: string[]): string[] {
  const key = (v: string): string => URL_SHAPED.test(v) ? `url ${normaliseUrl(v)}` : `as-written ${v}`
  const seen = new Set(existing.map(key))
  const out = [...existing]
  for (const v of values) {
    if (seen.has(key(v))) continue
    seen.add(key(v))
    out.push(v)
  }
  return out
}

export function resourceMatches(resource: string, folders: string[], remotes: string[]): boolean {
  if (isAbsolute(resource)) return folders.includes(canonical(resource))
  return remotes.includes(normaliseUrl(resource))
}

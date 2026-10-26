// src/cli/block-hook.ts
//
// `onboard --block`, what the SessionStart hook prints (onboard decision #58):
// the read line for every entity whose `resource` or slug matches the folder,
// and never the Block, which the instructions file already carries (#234).
// The folders and what a `resource` matches are the Resource module's
// (src/resource.ts); a slug matches a folder's name. With no match, inside a
// git work tree that is not the vault's own checkout, it prints the no-match
// line asking for `--resource .` (#307); else nothing. The hook never loads:
// the agent does the read.
//
// The hook must never block a session: any failure (no vault, bad config, an
// unbuilt native binding, no git) prints nothing. So the core and its native
// binding load here, inside the catch, never at module top. A bad invocation
// (unknown flag or harness) throws a usage error from `cmdOnboard`, which the
// CLI's `main` silences for `onboard --block` like any other failure (#132).

import { existsSync } from 'fs'
import { basename } from 'path'
import { ENTITY_STATUSES } from '../contracts.js'
import { canonical, foldersOf, gitRoots, remoteUrls, resourceMatches } from '../resource.js'
import type { ConfigHome } from './resolve-vault.js'

export interface BlockHookCtx extends ConfigHome {
  /** Defaults to the process's; read inside the catch, since a deleted
   * working directory makes reading it throw. */
  cwd?: string
  vaultFlag?: string
}

/** The render, or null for no match or any failure: the caller prints nothing. */
export async function blockHook(ctx: BlockHookCtx): Promise<string | null> {
  try {
    const { isVault, resolveVaultPath } = await import('./resolve-vault.js')
    const vaultPath = resolveVaultPath(ctx.vaultFlag, ctx)
    // A --vault flag is not checked by resolution; opening a non-vault would
    // leave an index file in it.
    if (typeof vaultPath !== 'string' || !isVault(vaultPath)) return null
    const dir = ctx.cwd ?? process.cwd()
    // A deleted working directory: no folder to match.
    if (!existsSync(dir)) return null
    const cwd = canonical(dir)
    const roots = gitRoots(cwd)
    const folders = foldersOf(cwd, roots)
    const remotes = remoteUrls(cwd)

    const { createHafez } = await import('../index.js')
    const os = createHafez({ vaultPath, git: { push: false } })
    const { items } = await os.query({ filter: 'all' }).finally(() => os.close())
    const matches = items
      .filter(e => folders.some(f => basename(f) === e.slug) || e.resource.some(r => resourceMatches(r, folders, remotes)))
      // Active first: the status tuple is ordered active, paused, done.
      .sort((a, b) => ENTITY_STATUSES.indexOf(a.status) - ENTITY_STATUSES.indexOf(b.status))

    const { renderBlockHook } = await import('../surfaces/surfaces.js')
    return renderBlockHook(matches, matches.length === 0 && isGitFolderNotVault(roots, vaultPath)) || null
  } catch {
    return null
  }
}

/** Inside a git work tree (`roots`, the working directory's `gitRoots`) that
 * is not the vault's own checkout: the two share no git root (a worktree of
 * the vault shares its main repository's). */
function isGitFolderNotVault(roots: string[], vaultPath: string): boolean {
  if (roots.length === 0) return false
  const vaultRoots = gitRoots(canonical(vaultPath))
  return !roots.some(r => vaultRoots.includes(r))
}

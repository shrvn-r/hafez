// src/git.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { simpleGit, type SimpleGit } from 'simple-git'

import { mergeVaultContent } from './merge.js'
import { HafezError, type GitConfig, type ChangelogEntry } from './types.js'

const logMerge = (msg: string) => process.stderr.write(`[hafez-merge] ${msg}\n`)

const MAX_PUSH_RETRIES = 3
const RETRY_BASE_MS = 200
// A pull --rebase replays one local commit at a time; each can stop on a
// conflict. Bound the resolution loop far above any realistic commit count.
const MAX_REBASE_STEPS = 50

function isRebaseInProgress(vaultPath: string): boolean {
  return (
    existsSync(join(vaultPath, '.git', 'rebase-merge')) ||
    existsSync(join(vaultPath, '.git', 'rebase-apply'))
  )
}

function isMergeInProgress(vaultPath: string): boolean {
  return existsSync(join(vaultPath, '.git', 'MERGE_HEAD'))
}

/**
 * Abort any in-progress rebase or merge, restoring the repo to a clean state.
 * Silently ignores "nothing to abort" errors (TOCTOU race: another process
 * may have resolved the state between our check and the abort call).
 */
async function ensureCleanState(git: SimpleGit, vaultPath: string): Promise<void> {
  if (isRebaseInProgress(vaultPath)) {
    try {
      await git.rebase(['--abort'])
    } catch {
      // Already resolved by another process — safe to ignore
    }
  }
  if (isMergeInProgress(vaultPath)) {
    try {
      await git.raw(['merge', '--abort'])
    } catch {
      // Already resolved by another process — safe to ignore
    }
  }
}

const VAULT_FILE_RE = /^(?:entities|knowledge|sessions)\/.+\.md$/

/**
 * True if the vault repo has an `origin` remote. A local-only vault (the
 * default the README setup produces) has none — every pull/push must be
 * skipped for it, silently: the commit IS the whole job.
 */
async function hasOriginRemote(git: SimpleGit): Promise<boolean> {
  const remotes = await git.getRemotes()
  return remotes.some(r => r.name === 'origin')
}

/** Read one side of a conflicted file from the index; null if that side deleted it. */
async function showStage(git: SimpleGit, stage: 2 | 3, file: string): Promise<string | null> {
  try {
    return await git.show([`:${stage}:${file}`])
  } catch (err) {
    // Only a genuinely absent stage means "this side deleted the file". Any
    // other failure (spawn error, repo corruption) must abort resolution —
    // treating it as a deletion would silently drop that side's content.
    if (/not at stage|does not exist/i.test(String(err))) return null
    throw err
  }
}

/**
 * Resolve a conflicted in-progress rebase by semantically merging each
 * conflicting vault file and continuing the rebase — never by resetting.
 * Every non-conflicting local commit is replayed untouched, so nothing
 * outside the conflicting files can be lost.
 *
 * On failure (non-vault conflicts, malformed content, unexpected git error)
 * the rebase is aborted, which restores the local branch exactly as it was
 * before the pull. Returns the conflicting files either way, for error messages.
 */
async function resolveRebaseConflicts(
  git: SimpleGit,
  vaultPath: string
): Promise<{ resolved: boolean; files: string[] }> {
  let lastFiles: string[] = []

  // Only rebase conflicts are resolvable here. A merge (MERGE_HEAD) can only
  // come from an interrupted non-rebase pull, which hafez never runs — abort it.
  if (isMergeInProgress(vaultPath)) {
    await ensureCleanState(git, vaultPath)
    return { resolved: false, files: [] }
  }

  try {
    for (let step = 0; step < MAX_REBASE_STEPS && isRebaseInProgress(vaultPath); step++) {
      const conflictFiles = await getConflictingFiles(git)
      if (conflictFiles.length > 0) lastFiles = conflictFiles

      if (!conflictFiles.every(f => VAULT_FILE_RE.test(f))) {
        await ensureCleanState(git, vaultPath)
        return { resolved: false, files: conflictFiles }
      }

      if (conflictFiles.length > 0) {
        logMerge(`conflict detected, attempting semantic merge for: ${conflictFiles.join(', ')}`)
      }

      for (const file of conflictFiles) {
        // During a rebase, stage 2 ("ours") is the upstream/remote side and
        // stage 3 ("theirs") is the local commit being replayed.
        const remoteContent = await showStage(git, 2, file)
        const localContent = await showStage(git, 3, file)

        if (remoteContent === null && localContent === null) {
          // Deleted on both sides — accept the deletion
          await git.raw(['rm', '--force', '--ignore-unmatch', '--', file])
          continue
        }
        const merged =
          localContent === null ? remoteContent!
          : remoteContent === null ? localContent
          : mergeVaultContent(remoteContent, localContent)

        const fullPath = join(vaultPath, file)
        mkdirSync(dirname(fullPath), { recursive: true })
        writeFileSync(fullPath, merged)
        await git.add([file])
      }

      // Decide structurally whether this step still has anything to commit:
      // no staged paths means the merged result is identical to the already-
      // applied tree, so the replayed commit became empty and must be skipped.
      // Output-based on purpose — never `--quiet` exit codes (simple-git
      // swallows diff's silent exit 1) and never git's error prose (localized,
      // and it quotes commit subjects; a false "empty" match would skip a
      // real commit — the COR-1 bug class again).
      const staged = (await git.raw(['diff', '--cached', '--name-only'])).trim()
      const stepEmpty = staged.length === 0

      try {
        // Non-interactive: --continue reuses the replayed commit's message
        await git.rebase([stepEmpty ? '--skip' : '--continue'])
      } catch (err) {
        // --continue/--skip exit non-zero when the rebase stops again on the
        // NEXT local commit's conflict. That is progress, not failure — the
        // loop resolves the new conflicts on its next pass. Anything else
        // (stuck with nothing to resolve) aborts via the outer catch.
        const nextConflicts = await getConflictingFiles(git)
        if (!isRebaseInProgress(vaultPath) || nextConflicts.length === 0) {
          throw err
        }
      }
    }

    if (isRebaseInProgress(vaultPath)) {
      // Step budget exhausted — bail out safely
      await ensureCleanState(git, vaultPath)
      return { resolved: false, files: lastFiles }
    }

    if (lastFiles.length > 0) logMerge(`semantic merge succeeded for: ${lastFiles.join(', ')}`)
    return { resolved: true, files: lastFiles }
  } catch (err) {
    logMerge(`semantic merge failed, restoring local state: ${err}`)
    try { await ensureCleanState(git, vaultPath) } catch { /* last resort failed */ }
    return { resolved: false, files: lastFiles }
  }
}

/**
 * One `pull --rebase` attempt, resolving vault-file conflicts inside the
 * rebase. Throws HafezError when a conflict cannot be auto-resolved (the
 * repo is left clean, local commits intact); rethrows the raw git error on
 * transient failures so the caller can retry.
 */
async function pullResolving(
  git: SimpleGit,
  vaultPath: string,
  conflictMessage: (files: string[]) => string
): Promise<void> {
  try {
    await git.pull('origin', undefined, { '--rebase': null })
  } catch (err) {
    if (isRebaseInProgress(vaultPath) || isMergeInProgress(vaultPath)) {
      const { resolved, files } = await resolveRebaseConflicts(git, vaultPath)
      if (resolved) return
      const detail = err instanceof Error ? err.message : String(err)
      throw new HafezError('GIT_PUSH_FAILED', conflictMessage(files), [detail])
    }
    try { await ensureCleanState(git, vaultPath) } catch { /* preserve error */ }
    throw err
  }
}

/**
 * Push local commits, pulling with rebase and resolving vault-file conflicts
 * semantically when the push is rejected. Push-first: callers either just
 * pulled (gitSync) or usually have a current remote view, so the extra
 * round-trip only happens when the remote actually moved. Shared by gitSync
 * and gitCommitAndPush — this is the single code path that decides whether
 * local data survives a conflict.
 */
async function pushResolving(
  git: SimpleGit,
  vaultPath: string,
  conflictMessage: (files: string[]) => string,
  exhaustedMessage: string
): Promise<void> {
  let lastDetail = ''
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    try {
      await git.push()
      return
    } catch (pushErr) {
      lastDetail = pushErr instanceof Error ? pushErr.message : String(pushErr)
      // Rejected (remote moved) or transient — integrate remote, then retry
      try {
        await pullResolving(git, vaultPath, conflictMessage)
      } catch (err) {
        if (err instanceof HafezError) throw err
        lastDetail = err instanceof Error ? err.message : String(err)
      }
      if (attempt === MAX_PUSH_RETRIES) {
        throw new HafezError('GIT_PUSH_FAILED', exhaustedMessage, [lastDetail])
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * attempt))
    }
  }
}

/**
 * Bidirectional sync: pull remote changes, push local commits.
 * All work must be committed before calling — no file save/restore needed.
 */
export async function gitSync(
  vaultPath: string
): Promise<{ pulled: boolean; pushed: boolean; remote: boolean }> {
  const git: SimpleGit = simpleGit(vaultPath)

  if (!(await hasOriginRemote(git))) {
    return { pulled: false, pushed: false, remote: false }
  }

  // Clean up any stuck rebase/merge from a previous crash.
  // Safe to abort without saving files — all work is already committed.
  await ensureCleanState(git, vaultPath)

  const syncConflictMessage = (files: string[]) =>
    `Git conflict during sync (files: ${files.join(', ')}). Changes saved locally.`

  let pulled = false

  // Always pull first (bidirectional sync)
  const headBefore = (await git.revparse(['HEAD'])).trim()
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    try {
      await pullResolving(git, vaultPath, syncConflictMessage)
      const headAfter = (await git.revparse(['HEAD'])).trim()
      pulled = headAfter !== headBefore
      break
    } catch (err) {
      if (err instanceof HafezError) throw err
      if (attempt === MAX_PUSH_RETRIES) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new HafezError(
          'GIT_PUSH_FAILED',
          `Git pull failed after ${MAX_PUSH_RETRIES} attempts during sync. Changes saved locally.`,
          [detail]
        )
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * attempt))
    }
  }

  // Check if there are local commits to push
  const ahead = await git.raw(['rev-list', '--count', '@{u}..HEAD']).then(s => parseInt(s.trim(), 10))
  if (ahead === 0) return { pulled, pushed: false, remote: true }

  await pushResolving(
    git, vaultPath, syncConflictMessage,
    `Git push failed after ${MAX_PUSH_RETRIES} attempts during sync. Changes saved locally.`
  )
  return { pulled, pushed: true, remote: true }
}

/**
 * Unstage files (best effort). Used by batch rollback: a commit that fails
 * after `git add` leaves the new blobs staged in .git/index, and the next
 * successful commit would publish the rolled-back content under the wrong
 * message. Clearing the index entries restores worktree/HEAD/index agreement.
 */
export async function gitUnstage(vaultPath: string, files: string[]): Promise<void> {
  try {
    await simpleGit(vaultPath).raw(['reset', '-q', 'HEAD', '--', ...files])
  } catch { /* best effort — rollback must not mask the original error */ }
}

/** Get list of files with unresolved conflicts */
async function getConflictingFiles(git: SimpleGit): Promise<string[]> {
  try {
    const output = await git.diff(['--name-only', '--diff-filter=U'])
    return output.split('\n').map(f => f.trim()).filter(Boolean)
  } catch {
    return []
  }
}

const FILE_STATUS_MAP: Record<string, 'created' | 'updated' | 'deleted'> = {
  A: 'created',
  M: 'updated',
  D: 'deleted',
}

export async function gitChangelog(vaultPath: string, since: string): Promise<ChangelogEntry[]> {
  const git: SimpleGit = simpleGit(vaultPath)

  // git approxidate fills a date-only --since with the *current* time of
  // day, so `--since <today>` means "since right now" and silently returns
  // nothing — the obvious "what happened today" query was the one that
  // failed. Normalise bare dates to local midnight.
  const normalizedSince = /^\d{4}-\d{2}-\d{2}$/.test(since) ? `${since}T00:00:00` : since

  let output: string
  try {
    output = await git.raw([
      'log', `--since=${normalizedSince}`, '--name-status',
      '--pretty=format:%H|%aI|%s', '--', 'entities/', 'knowledge/',
    ])
  } catch {
    return [] // No git history or invalid since — return empty
  }

  if (!output.trim()) return []

  const entries: ChangelogEntry[] = []
  const blocks = output.split(/\n(?=[0-9a-f]{40}\|)/)

  for (const block of blocks) {
    const lines = block.split('\n').filter(l => l.trim())
    if (lines.length === 0) continue

    const headerMatch = lines[0].match(/^([0-9a-f]+)\|(.+?)\|(.*)$/)
    if (!headerMatch) continue

    const [, , timestamp, commit_message] = headerMatch

    for (let i = 1; i < lines.length; i++) {
      const fileMatch = lines[i].match(/^([AMDRC])\t(.+)$/)
      if (!fileMatch) continue

      const [, statusChar, filePath] = fileMatch
      const operation = FILE_STATUS_MAP[statusChar]
      if (!operation) continue
      // Only vault documents — scaffold files (.gitkeep) live in the same
      // dirs and would otherwise surface as changelog rows.
      if (!filePath.endsWith('.md')) continue

      let kind: 'entity' | 'knowledge'
      let slug: string
      if (filePath.startsWith('entities/')) {
        kind = 'entity'
        slug = filePath.replace('entities/', '').replace('.md', '')
      } else if (filePath.startsWith('knowledge/')) {
        kind = 'knowledge'
        slug = filePath.replace('knowledge/', '').replace('.md', '')
      } else {
        continue
      }

      entries.push({ slug, kind, operation, timestamp, commit_message })
    }
  }

  return entries
}

/**
 * Latest git time per file (repo-relative, forward-slash paths). Used to
 * break day-granularity frontmatter ties in stats recents. `modified` maps
 * each file to its most recent commit; `added` to the commit that added it.
 * Files with no history (not yet committed) are absent from the map.
 */
export async function gitFileTimes(vaultPath: string, mode: 'modified' | 'added'): Promise<Map<string, string>> {
  const git: SimpleGit = simpleGit(vaultPath)
  let output: string
  try {
    const args = ['log', '--pretty=format:%x00%aI', '--name-only', '--', 'entities/', 'knowledge/']
    if (mode === 'added') args.splice(1, 0, '--diff-filter=A')
    output = await git.raw(args)
  } catch {
    return new Map() // no git history
  }
  const times = new Map<string, string>()
  let current = ''
  for (const line of output.split('\n')) {
    if (line.startsWith('\0')) { current = line.slice(1); continue }
    const file = line.trim()
    if (file && !times.has(file)) times.set(file, current) // first hit = newest
  }
  return times
}

export async function gitCommitAndPush(
  vaultPath: string,
  files: string[],
  message: string,
  config: GitConfig = {}
): Promise<void> {
  const git: SimpleGit = simpleGit(vaultPath)

  // If a previous run crashed mid-rebase/merge, the repo is stuck.
  // Aborting restores tracked files to their pre-rebase state, which may
  // overwrite files that index.ts just wrote. Save and restore them.
  if (isRebaseInProgress(vaultPath) || isMergeInProgress(vaultPath)) {
    const saved = new Map<string, Buffer>()
    for (const f of files) {
      const full = join(vaultPath, f)
      if (existsSync(full)) saved.set(full, readFileSync(full))
    }

    await ensureCleanState(git, vaultPath)

    for (const [fullPath, content] of saved) {
      writeFileSync(fullPath, content)
    }
  }

  await git.add(files)

  // Handle "nothing to commit" (e.g., idempotent update wrote identical content)
  const status = await git.status()
  if (status.staged.length === 0) return

  const committed = await git.commit(message)
  // simple-git swallows some commit failures (e.g. a rejected pre-commit
  // hook) into an empty result instead of throwing. Staged content with no
  // commit hash means the commit did NOT land — surface it so callers
  // (batch rollback in particular) treat it as a commit-stage failure.
  if (!committed.commit) {
    throw new HafezError('GIT_COMMIT_FAILED', `git commit produced no commit for: ${files.join(', ')}`)
  }

  if (config.push === false) return
  if (!(await hasOriginRemote(git))) return

  await pushResolving(
    git, vaultPath,
    (conflictFiles) => `Git conflict with remote (files: ${conflictFiles.join(', ')}). Changes saved locally.`,
    `Git push failed after ${MAX_PUSH_RETRIES} attempts. Changes saved locally.`
  )
}

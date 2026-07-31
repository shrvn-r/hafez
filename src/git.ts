// src/git.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { simpleGit, type SimpleGit } from 'simple-git'

import { mergeVaultContent } from './merge.js'
import { HafezError, type GitConfig, type ChangelogEntry } from './types.js'

const logMerge = (msg: string) => process.stderr.write(`[hafez-merge] ${msg}\n`)

const MAX_PUSH_RETRIES = 3
const RETRY_BASE_MS = 200

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

async function attemptSemanticMerge(
  git: SimpleGit,
  vaultPath: string,
  files: string[],
  message: string
): Promise<boolean> {
  // Only merge vault files — non-vault files fall through to error
  if (!files.every(f => VAULT_FILE_RE.test(f))) return false

  logMerge(`conflict detected, attempting semantic merge for: ${files.join(', ')}`)
  const branch = (await git.branchLocal()).current

  // Save local commit SHA so we can restore if merge fails after reset
  const localSHA = (await git.log(['-1'])).latest!.hash

  // Read local content from working tree (preserved after rebase abort)
  const localContents = new Map<string, string>()
  for (const file of files) {
    localContents.set(file, readFileSync(join(vaultPath, file), 'utf-8'))
  }

  // Get remote content and merge — all done BEFORE any destructive ops
  const mergedContents = new Map<string, string>()
  try {
    for (const file of files) {
      let remoteContent: string
      try {
        remoteContent = await git.show(`origin/${branch}:${file}`)
      } catch {
        // File doesn't exist on remote — no merge needed, keep local
        mergedContents.set(file, localContents.get(file)!)
        continue
      }
      mergedContents.set(file, mergeVaultContent(remoteContent, localContents.get(file)!))
    }
  } catch {
    // Merge failed (malformed content, etc.) — local commit is still intact
    return false
  }

  // --- Destructive section: reset + rewrite ---
  // If anything fails below, restore the local commit
  try {
    await git.reset(['--hard', `origin/${branch}`])
    for (const [file, content] of mergedContents) {
      const fullPath = join(vaultPath, file)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content)
    }
    await git.add(files)

    const status = await git.status()
    if (status.staged.length === 0) {
      // Contents identical after merge — nothing to commit, but we're on remote now
      return true
    }

    await git.commit(message)
    logMerge(`semantic merge succeeded for: ${files.join(', ')}`)
    return true
  } catch (err) {
    // Restore local commit — "changes saved locally" must remain true
    logMerge(`merge failed after reset, restoring local commit ${localSHA}: ${err}`)
    try { await git.reset(['--hard', localSHA]) } catch { /* last resort failed */ }
    return false
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

  let pulled = false

  // Always pull first (bidirectional sync)
  const headBefore = (await git.revparse(['HEAD'])).trim()
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    try {
      await git.pull('origin', undefined, { '--rebase': null })
      const headAfter = (await git.revparse(['HEAD'])).trim()
      pulled = headAfter !== headBefore
      break
    } catch (err) {
      const hadConflict =
        isRebaseInProgress(vaultPath) || isMergeInProgress(vaultPath)

      if (hadConflict) {
        // Discover conflicting files from git status
        const conflictFiles = await getConflictingFiles(git)
        try { await ensureCleanState(git, vaultPath) } catch { /* preserve error */ }

        if (conflictFiles.length > 0) {
          const merged = await attemptSemanticMerge(
            git, vaultPath, conflictFiles, `sync: resolve conflicts`
          )
          if (merged) {
            pulled = true
            break
          }
        }
        // Merge not possible
        const detail = err instanceof Error ? err.message : String(err)
        throw new HafezError(
          'GIT_PUSH_FAILED',
          `Git conflict during sync (files: ${conflictFiles.join(', ')}). Changes saved locally.`,
          [detail]
        )
      }

      try { await ensureCleanState(git, vaultPath) } catch { /* preserve error */ }

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

  // Push local commits
  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    try {
      await git.push()
      return { pulled, pushed: true, remote: true }
    } catch (err) {
      // Another writer may have pushed — pull and retry
      try {
        await git.pull('origin', undefined, { '--rebase': null })
      } catch (pullErr) {
        const hadConflict =
          isRebaseInProgress(vaultPath) || isMergeInProgress(vaultPath)
        if (hadConflict) {
          const conflictFiles = await getConflictingFiles(git)
          try { await ensureCleanState(git, vaultPath) } catch { /* preserve error */ }
          if (conflictFiles.length > 0) {
            const merged = await attemptSemanticMerge(
              git, vaultPath, conflictFiles, `sync: resolve conflicts`
            )
            if (merged) continue // retry push
          }
        } else {
          try { await ensureCleanState(git, vaultPath) } catch { /* preserve error */ }
        }
      }

      if (attempt === MAX_PUSH_RETRIES) {
        const detail = err instanceof Error ? err.message : String(err)
        throw new HafezError(
          'GIT_PUSH_FAILED',
          `Git push failed after ${MAX_PUSH_RETRIES} attempts during sync. Changes saved locally.`,
          [detail]
        )
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * attempt))
    }
  }

  return { pulled, pushed: false, remote: true } // unreachable, but satisfies TS
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

  let output: string
  try {
    output = await git.raw([
      'log', `--since=${since}`, '--name-status',
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

  await git.commit(message)

  if (config.push === false) return
  if (!(await hasOriginRemote(git))) return

  for (let attempt = 1; attempt <= MAX_PUSH_RETRIES; attempt++) {
    try {
      await git.pull('origin', undefined, { '--rebase': null })
      await git.push()
      return // success
    } catch (err) {
      const hadConflict =
        isRebaseInProgress(vaultPath) || isMergeInProgress(vaultPath)

      // Always restore clean state before throwing or retrying.
      // Wrap in try-catch to preserve the original error if abort fails.
      try {
        await ensureCleanState(git, vaultPath)
      } catch {
        // Abort failed — repo may be in a bad state, but we still throw
        // the original error so the caller gets useful diagnostics.
      }

      const detail = err instanceof Error ? err.message : String(err)

      if (hadConflict) {
        const merged = await attemptSemanticMerge(git, vaultPath, files, message)
        if (merged) {
          // Try pushing the merged result
          try {
            await git.push()
            return // success
          } catch (pushErr) {
            // One final retry: another writer may have pushed during our merge
            try {
              await git.pull('origin', undefined, { '--rebase': null })
              await git.push()
              return
            } catch (retryErr) {
              try { await ensureCleanState(git, vaultPath) } catch { /* preserve original error */ }
              const retryDetail = retryErr instanceof Error ? retryErr.message : String(retryErr)
              throw new HafezError(
                'GIT_PUSH_FAILED',
                `Git push failed after semantic merge. Changes saved locally.`,
                [retryDetail]
              )
            }
          }
        }
        // Merge not possible (non-vault files) — original behavior
        throw new HafezError(
          'GIT_PUSH_FAILED',
          `Git conflict with remote (files: ${files.join(', ')}). Changes saved locally.`,
          [detail]
        )
      }

      // Transient error (network, push race). Retry if attempts remain.
      if (attempt === MAX_PUSH_RETRIES) {
        throw new HafezError(
          'GIT_PUSH_FAILED',
          `Git push failed after ${MAX_PUSH_RETRIES} attempts. Changes saved locally.`,
          [detail]
        )
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_MS * attempt))
    }
  }
}

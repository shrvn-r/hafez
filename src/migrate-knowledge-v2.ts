import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, appendFileSync } from 'fs'
import { join } from 'path'
import { parseFilePath, serializeFile } from './vault.js'
import { syncRelatedSection, findSection } from './sections.js'
import { generateVaultIndex } from './knowledge-index.js'
import { spawnSync } from 'child_process'

export interface MigrationReport {
  sessionsToMove: string[]
  emptyToDelete: string[]
  insightToRename: string[]
  relatedToGenerate: string[]
  gitignoreNeeded: boolean
  gitCommitFailed: boolean
}

export function migrateKnowledgeV2(vaultPath: string, opts: { apply: boolean }): MigrationReport {
  const report: MigrationReport = {
    sessionsToMove: [],
    emptyToDelete: [],
    insightToRename: [],
    relatedToGenerate: [],
    gitignoreNeeded: false,
    gitCommitFailed: false,
  }

  const knowledgeDir = join(vaultPath, 'knowledge')
  const sessionsDir = join(vaultPath, 'sessions')
  const entitiesDir = join(vaultPath, 'entities')

  // Step 1: Find session knowledge notes (by frontmatter subtype, not filename)
  if (existsSync(knowledgeDir)) {
    for (const file of readdirSync(knowledgeDir).filter(f => f.endsWith('.md'))) {
      try {
        const { frontmatter } = parseFilePath(join(knowledgeDir, file))
        if (frontmatter.subtype === 'session') {
          report.sessionsToMove.push(file)
        }
      } catch { continue }
    }
  }

  // Step 2: Find empty-body knowledge notes
  if (existsSync(knowledgeDir)) {
    for (const file of readdirSync(knowledgeDir).filter(f => f.endsWith('.md'))) {
      if (report.sessionsToMove.includes(file)) continue // already moving
      try {
        const { body } = parseFilePath(join(knowledgeDir, file))
        // "Empty" = body only has section headings (## ...) and whitespace
        const stripped = body.replace(/^## .+$/gm, '').trim()
        if (!stripped) report.emptyToDelete.push(file)
      } catch { continue }
    }
  }

  // Step 3: Find knowledge notes with ## Insight heading
  if (existsSync(knowledgeDir)) {
    for (const file of readdirSync(knowledgeDir).filter(f => f.endsWith('.md'))) {
      if (report.sessionsToMove.includes(file) || report.emptyToDelete.includes(file)) continue
      try {
        const { body } = parseFilePath(join(knowledgeDir, file))
        if (findSection(body, 'Insight')) report.insightToRename.push(file)
      } catch { continue }
    }
  }

  // Step 4: Find files needing ## Related section generation
  for (const [dir, kind] of [[entitiesDir, 'entity'], [knowledgeDir, 'knowledge']] as const) {
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      if (kind === 'knowledge' && (report.sessionsToMove.includes(file) || report.emptyToDelete.includes(file))) continue
      try {
        const { frontmatter: fm, body } = parseFilePath(join(dir, file))
        const hasLinks = (fm.related?.length > 0) || fm.parent
        if (hasLinks) {
          const synced = syncRelatedSection(body, fm)
          if (synced !== body) report.relatedToGenerate.push(`${kind === 'entity' ? 'entities' : 'knowledge'}/${file}`)
        }
      } catch { continue }
    }
  }

  // Step 5: Check .gitignore
  const gitignorePath = join(vaultPath, '.gitignore')
  if (existsSync(gitignorePath)) {
    const content = readFileSync(gitignorePath, 'utf-8')
    if (!content.includes('/index.md')) report.gitignoreNeeded = true
  } else {
    report.gitignoreNeeded = true
  }

  if (!opts.apply) return report

  // --- Apply ---

  // Step 1: Move sessions
  if (report.sessionsToMove.length > 0) {
    mkdirSync(sessionsDir, { recursive: true })
    for (const file of report.sessionsToMove) {
      renameSync(join(knowledgeDir, file), join(sessionsDir, file))
    }
  }

  // Step 2: Delete empty notes
  for (const file of report.emptyToDelete) {
    unlinkSync(join(knowledgeDir, file))
  }

  // Step 3: Rename ## Insight to ## Synthesis, add ## Sources if missing
  for (const file of report.insightToRename) {
    const filePath = join(knowledgeDir, file)
    const content = readFileSync(filePath, 'utf-8')
    let updated = content.replace(/^## Insight$/gm, '## Synthesis')
    // Add ## Sources section if missing (new notes get it by default)
    if (!findSection(updated, 'Sources')) {
      updated = updated.trimEnd() + '\n\n## Sources\n'
    }
    writeFileSync(filePath, updated)
  }

  // Step 4: Generate ## Related sections
  for (const relPath of report.relatedToGenerate) {
    const filePath = join(vaultPath, relPath)
    const { frontmatter: fm, body } = parseFilePath(filePath)
    const newBody = syncRelatedSection(body, fm)
    writeFileSync(filePath, serializeFile(fm, newBody))
  }

  // Step 5: Update .gitignore
  if (report.gitignoreNeeded) {
    appendFileSync(gitignorePath, '\n/index.md\n')
  }

  // Git commit only the files this migration touched
  const filesToStage: string[] = []
  for (const f of report.sessionsToMove) {
    filesToStage.push(`knowledge/${f}`)   // deleted from knowledge/
    filesToStage.push(`sessions/${f}`)     // added to sessions/
  }
  for (const f of report.emptyToDelete) filesToStage.push(`knowledge/${f}`)
  for (const f of report.insightToRename) filesToStage.push(`knowledge/${f}`)
  for (const relPath of report.relatedToGenerate) filesToStage.push(relPath)
  if (report.gitignoreNeeded) filesToStage.push('.gitignore')

  if (filesToStage.length > 0) {
    spawnSync('git', ['add', '--', ...filesToStage], { cwd: vaultPath, stdio: 'pipe' })
  }
  const commitResult = spawnSync('git', ['commit', '-m', 'migrate: knowledge-v2 (wiki links, synthesis, session move, cleanup)'], { cwd: vaultPath, stdio: 'pipe' })
  if (commitResult.status !== 0) {
    const stderr = commitResult.stderr?.toString() ?? 'unknown error'
    process.stderr.write(`Warning: git commit failed: ${stderr}\n`)
    report.gitCommitFailed = true
  }

  // Post-commit: generate index.md (not committed — gitignored)
  generateVaultIndex(vaultPath)

  return report
}

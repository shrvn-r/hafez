// src/migrate-types.ts
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join, relative } from 'path'
import { parseFilePath, serializeFile } from './vault.js'

// --- Type and status mapping tables ---

const TYPE_MAP: Record<string, string> = {
  thread: 'entity',
  idea: 'entity',
  area: 'project',
  inbox: 'capture',
}

const STATUS_MAP: Record<string, string> = {
  simmering: 'paused',
  dormant: 'paused',
}

export interface MigrationReport {
  typeChanges: number
  statusChanges: number
  knowledgeSubtypeAdded: number
  bodySectionsRestructured: number
  malformed: string[]
  skipped: string[]
  details: string[]
  applied: boolean
}

function newReport(applied: boolean): MigrationReport {
  return { typeChanges: 0, statusChanges: 0, knowledgeSubtypeAdded: 0, bodySectionsRestructured: 0, malformed: [], skipped: [], details: [], applied }
}

/** Migrate a single entity file's frontmatter. Returns null if no change needed. */
function migrateEntityFrontmatter(
  fm: Record<string, any>,
  filename: string,
  report: MigrationReport
): Record<string, any> | null {
  const rawType = fm.type

  // Malformed: missing type field
  if (rawType === undefined || rawType === null) {
    report.malformed.push(filename)
    report.details.push(`${filename}: SKIPPED — missing type field`)
    return null
  }

  // Already-valid type and status — skip
  const mappedType = TYPE_MAP[rawType] ?? rawType
  const mappedStatus = STATUS_MAP[fm.status] ?? fm.status

  const typeChanged = mappedType !== rawType
  const statusChanged = mappedStatus !== fm.status

  if (!typeChanged && !statusChanged) {
    report.skipped.push(filename)
    return null
  }

  const newFm = { ...fm }
  if (typeChanged) {
    newFm.type = mappedType
    report.typeChanges++
    report.details.push(`${filename}: type ${rawType} → ${mappedType}`)
  }
  if (statusChanged) {
    newFm.status = mappedStatus
    report.statusChanges++
    report.details.push(`${filename}: status ${fm.status} → ${mappedStatus}`)
  }

  return newFm
}

/**
 * Restructure body sections for old template types.
 * - idea entities: ## Hypothesis → ## Context
 * Returns the new body and whether any restructuring occurred.
 * Checks unconditionally for ## Hypothesis — only idea entities use that heading,
 * and this makes the rename idempotent regardless of whether the type rename already ran.
 */
function migrateEntityBody(body: string): { body: string; changed: boolean } {
  let newBody = body
  let changed = false

  // idea template used ## Hypothesis where entity template expects ## Context.
  // Check unconditionally so a partial migration (type renamed, body not yet renamed) is safe to rerun.
  const re = /^## Hypothesis$/m
  if (re.test(newBody)) {
    newBody = newBody.replace(re, '## Context')
    changed = true
  }

  return { body: newBody, changed }
}

/** Scan entity dir (and entities/archive if present) and return all .md files with their paths. */
function collectEntityFiles(vaultPath: string): string[] {
  const entDir = join(vaultPath, 'entities')
  const files: string[] = readdirSync(entDir)
    .filter(f => f.endsWith('.md'))
    .map(f => join(entDir, f))

  const archiveDir = join(entDir, 'archive')
  if (existsSync(archiveDir)) {
    readdirSync(archiveDir)
      .filter(f => f.endsWith('.md'))
      .forEach(f => files.push(join(archiveDir, f)))
  }

  return files
}

export function migrateTypes(vaultPath: string, apply: boolean): MigrationReport {
  const report = newReport(apply)

  // --- 1. Entity files ---
  const entityFiles = collectEntityFiles(vaultPath)
  const entityWrites: Array<{ filePath: string; content: string }> = []

  for (const filePath of entityFiles) {
    const filename = relative(vaultPath, filePath)
    const { frontmatter: fm, body } = parseFilePath(filePath)

    const newFm = migrateEntityFrontmatter(fm, filename, report)

    // Skip malformed files entirely — no body migration either
    if (report.malformed.includes(filename)) continue

    // Check body restructuring (unconditional — idempotent regardless of type rename order)
    const { body: newBody, changed: bodyChanged } = migrateEntityBody(body)
    if (bodyChanged) {
      report.bodySectionsRestructured++
      report.details.push(`${filename}: ## Hypothesis → ## Context`)
    }

    if (newFm === null && !bodyChanged) continue  // nothing to do

    // Use newFm if frontmatter changed, else original fm (for body-only changes)
    const finalFm = newFm ?? fm
    entityWrites.push({ filePath, content: serializeFile(finalFm, newBody) })
  }

  // --- 2. Knowledge files: add subtype: insight ---
  const knowledgeDir = join(vaultPath, 'knowledge')
  const knowledgeFiles = existsSync(knowledgeDir)
    ? readdirSync(knowledgeDir).filter(f => f.endsWith('.md')).map(f => join(knowledgeDir, f))
    : []

  const knowledgeWrites: Array<{ filePath: string; content: string }> = []
  const REVIEW_KEYWORDS = /reference|guide|template|framework|checklist|how-to|integration/i

  for (const filePath of knowledgeFiles) {
    const filename = relative(vaultPath, filePath)
    const { frontmatter: fm, body } = parseFilePath(filePath)

    if (fm.subtype !== undefined) {
      report.skipped.push(filename)
      continue
    }

    const newFm = { ...fm, subtype: 'insight' }
    report.knowledgeSubtypeAdded++
    const needsReview = REVIEW_KEYWORDS.test(filename)
    report.details.push(`${filename}: added subtype: insight${needsReview ? ' ⚠ review — may not be an insight' : ''}`)
    knowledgeWrites.push({ filePath, content: serializeFile(newFm, body) })
  }

  if (!apply) return report

  // --- Write all changed files. Crash during write-back → git checkout HEAD -- entities/ knowledge/ ---
  const allWrites = [...entityWrites, ...knowledgeWrites]
  try {
    for (const { filePath, content } of allWrites) {
      writeFileSync(filePath, content)
    }
  } catch (err) {
    process.stderr.write(`\nMigration failed during write: ${err}\n`)
    process.stderr.write(`Recovery: git -C ${vaultPath} checkout HEAD -- entities/ knowledge/\n`)
    throw err
  }

  return report
}

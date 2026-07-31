// src/migrate-next-actions.ts
import { readdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { parseFilePath, serializeFile } from './vault.js'
import { addNextAction } from './sections.js'

export interface MigrationReport {
  candidates: number
  migrated: number
  details: string[]
}

export function migrateNextActions(vaultPath: string, apply: boolean): MigrationReport {
  const entDir = join(vaultPath, 'entities')
  const files = readdirSync(entDir).filter(f => f.endsWith('.md'))
  const report: MigrationReport = { candidates: 0, migrated: 0, details: [] }

  for (const file of files) {
    const filePath = join(entDir, file)
    const { frontmatter: fm, body } = parseFilePath(filePath)
    const nextAction = fm['next-action']

    // Skip if no next-action or it's null/empty
    if (!nextAction || typeof nextAction !== 'string' || nextAction.trim() === '') continue

    // Skip if already has a Next Actions section (idempotent)
    if (body.includes('## Next Actions')) {
      report.details.push(`${file}: skipped (already has ## Next Actions)`)
      continue
    }

    report.candidates++
    report.details.push(`${file}: next-action = "${nextAction}"`)

    if (apply) {
      const newBody = addNextAction(body, nextAction)
      delete fm['next-action']
      writeFileSync(filePath, serializeFile(fm, newBody))
      report.migrated++
    }
  }

  return report
}

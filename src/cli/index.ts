// src/cli/index.ts
import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createHafez } from '../index.js'
import { HafezError } from '../types.js'
import { cmdRead, cmdQuery, cmdSearch, cmdCreate, cmdUpdate, cmdLink, cmdUnlink, cmdPromote, cmdValidate, cmdIndexRebuild, cmdBatch, cmdSync, cmdStats, cmdChangelog, cmdDigest, cmdMigrateKnowledgeV2, cmdCapture, type CommandOpts } from './commands.js'
import { cmdSchema } from './commands-schema.js'
import { renderAgentHelp } from './help-agent.js'
import { resolveVaultPath, noVaultMessage, cmdInit } from './resolve-vault.js'

const COMMANDS: Record<string, (os: any, args: string[], opts: CommandOpts) => Promise<string>> = {
  read: cmdRead,
  query: cmdQuery,
  search: cmdSearch,
  create: cmdCreate,
  capture: cmdCapture,
  update: cmdUpdate,
  link: cmdLink,
  unlink: cmdUnlink,
  promote: cmdPromote,
  batch: cmdBatch,
  schema: cmdSchema,
  validate: cmdValidate,
  index: (os, args) => {
    if (args[0] === 'rebuild') return cmdIndexRebuild(os)
    throw new Error('Usage: hafez index rebuild')
  },
  stats: cmdStats,
  changelog: cmdChangelog,
  digest: cmdDigest,
}

// Commands that modify vault files — auto-sync after these
const MUTATING_COMMANDS = new Set(['update', 'create', 'capture', 'link', 'unlink', 'batch', 'promote'])

const USAGE = `Usage: hafez <command> [args]

Commands:
  read <slug>                Read entity or knowledge note
  query [--filter ...] ...   Filter entities/knowledge
  search <terms>             Full-text search
  create <kind> <name>       Create entity, knowledge, or inbox
  capture <name> [--notes]   Quick inbox capture
  promote <slug> <target>    Promote capture→entity/project/knowledge, entity→project
  update <slug> [--status]   Update an entity or knowledge note
    --brief "text"           Set/replace Brief (use --brief "" to clear)
    --description "text"     Set one-line description (use --description "" to clear)
    --resource "uri"         Set canonical resource URI, entities only (use --resource "" to clear)
    --add-action "text"      Add a next action
    --complete-action "text"  Complete matching action
    --remove-action "text"   Remove matching action
    --clear-actions          Remove all next actions
    --synthesis "text"       Set/replace Synthesis section (--insight is an alias)
    --add-evidence "text"    Append to Evidence section
    --add-source "text"      Append to Sources section
  batch                      Apply multiple operations atomically (JSON on stdin)
  digest                     Apply digest input (JSON stdin) → batch payload (JSON stdout)
  export --okf [--out <dir>] Export vault as an OKF v0.1 bundle (read-only)
  sync                       Pull remote changes and push local commits
  migrate next-actions       Migrate next-action frontmatter to body sections
  migrate types              Migrate vault to v2 type system (dry-run by default)
  migrate knowledge-v2       Migrate knowledge notes to v2 section structure (dry-run by default)
    --apply                  Execute migration (writes files, does not commit)
  link <slug> <target> <rel> Add a link
  unlink <slug> <target> <rel> Remove a link
  stats                      Vault summary: counts, stale items, recents
  changelog --since <when>   Git-derived change history (e.g. --since 7.days.ago)
  schema [op] [--examples]   Machine-readable JSON schema for batch operations
  validate                   Check vault integrity
  index rebuild              Rebuild the SQLite index
  init --register <path>     Register an existing vault
  init                       Show current vault resolution
  help --agent               Full API reference for agents

Global flags:
  --vault <path>    Vault path (overrides config)
  --json            JSON output (structured, machine-readable)
  --version         Print the hafez version

Vault discovery: --vault flag > ~/.config/hafez/vault
`

export async function main(argv: string[]): Promise<void> {
  const args = argv.slice(2)

  // Extract global flags
  const vaultIdx = args.indexOf('--vault')
  let flagValue: string | undefined
  if (vaultIdx !== -1) {
    flagValue = args[vaultIdx + 1]
    args.splice(vaultIdx, 2)
  }

  const jsonIdx = args.indexOf('--json')
  const json = jsonIdx !== -1
  if (json) args.splice(jsonIdx, 1)

  const command = args.shift()
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE)
    return
  }

  if (command === '--version' || command === '-v' || command === 'version') {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8'))
    process.stdout.write(`hafez ${pkg.version}\n`)
    return
  }

  // help runs before vault resolution — works without a registered vault
  if (command === 'help') {
    if (args[0] === '--agent') {
      process.stdout.write(renderAgentHelp())
      return
    }
    process.stdout.write(USAGE)
    return
  }

  // schema runs before vault resolution — pure Zod introspection, no vault needed.
  if (command === 'schema') {
    try {
      const result = await cmdSchema(null, args)
      process.stdout.write(result + '\n')
    } catch (err) {
      if (err instanceof HafezError) {
        process.stderr.write(`Error: ${err.message}\n`)
        if (err.details?.length) {
          for (const detail of err.details) process.stderr.write(`  - ${detail}\n`)
        }
        process.exit(2)
      }
      process.stderr.write(`Error: ${(err as Error).message}\n`)
      process.exit(1)
    }
    return
  }

  // init runs before vault resolution
  if (command === 'init') {
    cmdInit(args, flagValue)
    return
  }

  // Resolve vault
  const resolution = resolveVaultPath(flagValue)
  if (resolution === null) {
    process.stderr.write(noVaultMessage())
    process.exit(1)
  }
  if (typeof resolution === 'object' && 'error' in resolution) {
    process.stderr.write(`Error: ${resolution.error}\n`)
    process.exit(1)
  }
  const vaultPath = resolution

  // export runs before Hafez instance creation — read-only, no auto-sync
  if (command === 'export') {
    if (!args.includes('--okf')) {
      process.stderr.write('Usage: hafez export --okf [--out <dir>]\n')
      process.exit(1)
    }
    const outIdx = args.indexOf('--out')
    let outDir = resolve(process.cwd(), 'okf-export')
    if (outIdx !== -1) {
      const outValue = args[outIdx + 1]
      if (!outValue) {
        process.stderr.write('Usage: hafez export --okf [--out <dir>]\n')
        process.exit(1)
      }
      outDir = resolve(outValue)
    }
    const { exportOkf } = await import('../export-okf.js')
    try {
      const report = exportOkf(vaultPath, outDir)
      if (json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      } else {
        const lines = [`Exported ${report.entities} entities, ${report.knowledge} knowledge, ${report.sessions} sessions to ${report.outDir}`]
        for (const s of report.skipped) lines.push(`  skipped ${s.file}: ${s.reason}`)
        if (report.unresolvedLinks > 0) lines.push(`  unresolved links: ${report.unresolvedLinks}`)
        process.stdout.write(lines.join('\n') + '\n')
      }
    } catch (err) {
      process.stderr.write(`Error: ${(err as Error).message}\n`)
      process.exit(1)
    }
    return
  }

  // migrate runs before Hafez instance creation
  if (command === 'migrate') {
    const subcommand = args[0]

    if (subcommand === 'next-actions') {
      const { migrateNextActions } = await import('../migrate-next-actions.js')
      const apply = args.includes('--apply')
      const report = migrateNextActions(vaultPath, apply)
      const lines: string[] = []
      if (!apply) lines.push('DRY RUN — use --apply to execute')
      lines.push(`Candidates: ${report.candidates}`)
      if (apply) lines.push(`Migrated: ${report.migrated}`)
      for (const d of report.details) lines.push(`  ${d}`)
      process.stdout.write(lines.join('\n') + '\n')
      return
    }

    if (subcommand === 'types') {
      const { migrateTypes } = await import('../migrate-types.js')
      const apply = args.includes('--apply')
      const report = migrateTypes(vaultPath, apply)
      const lines: string[] = []

      if (!apply) {
        lines.push('DRY RUN — use --apply to execute')
        lines.push('')
      }

      lines.push(`Type renames:         ${report.typeChanges}`)
      lines.push(`Status renames:       ${report.statusChanges}`)
      lines.push(`Subtypes added:       ${report.knowledgeSubtypeAdded}`)
      lines.push(`Body restructures:    ${report.bodySectionsRestructured}`)
      lines.push(`Malformed (skipped):  ${report.malformed.length}`)

      if (report.malformed.length > 0) {
        lines.push('')
        lines.push('Malformed files (no type field):')
        for (const f of report.malformed) lines.push(`  ⚠ ${f}`)
      }

      if (report.details.length > 0) {
        lines.push('')
        lines.push('Changes:')
        for (const d of report.details) lines.push(`  ${d}`)
      }

      if (apply) {
        lines.push('')
        lines.push('Migration applied. Run `hafez index rebuild` to refresh the index.')
      }

      process.stdout.write(lines.join('\n') + '\n')
      return
    }

    if (subcommand === 'knowledge-v2') {
      await cmdMigrateKnowledgeV2(args.slice(1), vaultPath)
      return
    }

    process.stderr.write('Usage: hafez migrate <next-actions|types|knowledge-v2> [--apply]\n')
    process.exit(1)
  }

  // sync is handled specially — always runs, not gated by MUTATING_COMMANDS
  if (command === 'sync') {
    const os = createHafez({ vaultPath, git: { push: false } })
    try {
      const result = await cmdSync(os, args)
      process.stdout.write(result + '\n')
    } catch (err) {
      if (err instanceof HafezError) {
        process.stderr.write(`Error: ${err.message}\n`)
        if (err.details?.length) {
          for (const detail of err.details) {
            process.stderr.write(`  - ${detail}\n`)
          }
        }
        const exitCodes: Record<string, number> = { NOT_FOUND: 1, VALIDATION_FAILED: 2, GIT_PUSH_FAILED: 3 }
        process.exit(exitCodes[err.code] ?? 1)
      }
      process.stderr.write(`Error: ${(err as Error).message}\n`)
      process.exit(1)
    }
    return
  }

  const handler = COMMANDS[command]
  if (!handler) {
    process.stderr.write(`Unknown command: ${command}\n${USAGE}`)
    process.exit(1)
  }

  const os = createHafez({ vaultPath, git: { push: false } })

  try {
    const result = await handler(os, args, { json })

    // Auto-sync after mutating commands
    if (MUTATING_COMMANDS.has(command)) {
      try {
        await os.sync()
      } catch (syncErr) {
        // Operation succeeded but sync failed — emit result with warning, exit 4
        process.stdout.write(result + '\n')
        process.stderr.write(`Warning: ${(syncErr as HafezError).message ?? (syncErr as Error).message}\n`)
        process.exit(4)
      }
    }

    process.stdout.write(result + '\n')
  } catch (err) {
    if (err instanceof HafezError) {
      process.stderr.write(`Error: ${err.message}\n`)
      if (err.details?.length) {
        for (const detail of err.details) {
          process.stderr.write(`  - ${detail}\n`)
        }
      }
      const exitCodes: Record<string, number> = { NOT_FOUND: 1, VALIDATION_FAILED: 2, GIT_PUSH_FAILED: 3 }
      process.exit(exitCodes[err.code] ?? 1)
    }
    process.stderr.write(`Error: ${(err as Error).message}\n`)
    process.exit(1)
  }
}


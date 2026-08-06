// src/cli/index.ts
import { readFileSync } from 'fs'
import { dirname, join, resolve } from 'path'
import { fileURLToPath } from 'url'
import { createHafez } from '../index.js'
import { HafezError } from '../types.js'
import { parseArgs, UsageError } from './args.js'
import { cmdRead, cmdQuery, cmdSearch, cmdCreate, cmdUpdate, cmdLink, cmdUnlink, cmdPromote, cmdValidate, cmdIndexRebuild, cmdBatch, cmdSync, cmdStats, cmdChangelog, cmdDigest, cmdCapture, type CommandOpts } from './commands.js'
import { cmdSchema } from './commands-schema.js'
import { renderAgentHelp } from './help-agent.js'
import { renderOnboard } from './onboard.js'
import { resolveVaultPath, noVaultMessage, cmdInit } from './resolve-vault.js'

const COMMANDS: Record<string, (os: any, args: string[], opts: CommandOpts) => Promise<string>> = {
  read: cmdRead,
  sync: cmdSync,
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
    throw new UsageError('Usage: hafez index rebuild')
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
  create <kind> <name>       Create entity or knowledge note
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
  link <slug> <target> --relation <rel>    Add a link
  unlink <slug> <target> --relation <rel>  Remove a link
  stats                      Vault summary: counts, stale items, recents
  changelog --since <when>   Git-derived change history (e.g. --since 7.days.ago)
  schema [op] [--examples]   Machine-readable JSON schema for batch operations
  validate                   Check vault integrity
  index rebuild              Rebuild the SQLite index
  init --register <path>     Register an existing vault
  init                       Show current vault resolution
  onboard                    Agent-directed first run: seed the vault, pick integration level
  help --agent               Full API reference for agents

Global flags:
  --vault <path>    Vault path (overrides config)
  --json            JSON output (structured, machine-readable)
  --version         Print the hafez version

Vault discovery: --vault flag > ~/.config/hafez/vault
`

/** Exit codes, documented in `hafez help --agent`. 0 = success; 4 is the
 * mutate-succeeded-sync-failed warning path; anything unmapped = 1. */
const EXIT_CODES: Record<string, number> = {
  NOT_FOUND: 1,
  VALIDATION_FAILED: 2,
  GIT_PUSH_FAILED: 3,
  SLUG_EXISTS: 5,
  GIT_COMMIT_FAILED: 6,
  VAULT_LOCKED: 7,
}

/** The one error → exit adapter. Usage errors (bad flags/args) are distinct
 * from vault errors and from unknown crashes. */
function report(err: unknown): never {
  if (err instanceof UsageError) {
    process.stderr.write(`Error: ${err.message}\n`)
    process.exit(2)
  }
  if (err instanceof HafezError) {
    process.stderr.write(`Error: ${err.message}\n`)
    if (err.details?.length) {
      for (const detail of err.details) process.stderr.write(`  - ${detail}\n`)
    }
    process.exit(EXIT_CODES[err.code] ?? 1)
  }
  failUnknown(err)
}

// Terminal handler for non-Hafez errors. Special-cases unbuilt better-sqlite3
// bindings: npm 11+ blocks install scripts by default, so `npm install -g
// hafez` reports success with the native module unbuilt and the first indexed
// command dies here — guide instead of stack-tracing.
function failUnknown(err: unknown): never {
  const e = err as Error
  if (/better[-_]sqlite3|Could not locate the bindings file/i.test(`${e.message}\n${e.stack ?? ''}`)) {
    process.stderr.write(
      'Error: the SQLite bindings (better-sqlite3) are not built.\n' +
      'npm 11+ blocks install scripts by default, so the install reports success\n' +
      'while skipping the native build. Fix with:\n\n' +
      '  npm install -g hafez --allow-scripts=better-sqlite3\n',
    )
    process.exit(1)
  }
  process.stderr.write(`Error: ${e.message}\n`)
  process.exit(1)
}

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

  // onboard runs before vault resolution — static agent-directed text
  if (command === 'onboard') {
    process.stdout.write(renderOnboard())
    return
  }

  // schema runs before vault resolution — pure Zod introspection, no vault needed.
  if (command === 'schema') {
    try {
      const result = await cmdSchema(null, args)
      process.stdout.write(result + '\n')
    } catch (err) {
      report(err)
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
    try {
      const EXPORT_USAGE = 'Usage: hafez export --okf [--out <dir>]'
      const { flags } = parseArgs(args, { okf: 'boolean', out: 'string' }, EXPORT_USAGE)
      if (flags.okf !== true) throw new UsageError(EXPORT_USAGE)
      const outDir = typeof flags.out === 'string' ? resolve(flags.out) : resolve(process.cwd(), 'okf-export')
      const { exportOkf } = await import('../export-okf.js')
      const exportReport = exportOkf(vaultPath, outDir)
      if (json) {
        process.stdout.write(JSON.stringify(exportReport, null, 2) + '\n')
      } else {
        const lines = [`Exported ${exportReport.entities} entities, ${exportReport.knowledge} knowledge, ${exportReport.sessions} sessions to ${exportReport.outDir}`]
        for (const s of exportReport.skipped) lines.push(`  skipped ${s.file}: ${s.reason}`)
        if (exportReport.unresolvedLinks > 0) lines.push(`  unresolved links: ${exportReport.unresolvedLinks}`)
        process.stdout.write(lines.join('\n') + '\n')
      }
    } catch (err) {
      report(err)
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
    report(err)
  }
}


// src/cli/index.ts
//
// Import discipline: this module is loaded for EVERY invocation, so it may
// only import what every invocation needs — node builtins, the flag parser,
// and the error type. Everything else (the core factory and its native SQLite
// binding, zod-backed schema introspection, the markdown formatters, even
// vault-path resolution) loads on demand from the command that needs it, so
// `hafez --version` / `help` / `init` no longer pay for the whole program.
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { HafezError, type HafezErrorCode } from '../types.js'
import { HelpRequest, MisuseError, RenderedError, UsageError, helpIfAsked } from './args.js'
import type { CommandOpts } from './commands.js'

// The one dispatch table. `pre-vault` commands run without a resolved vault
// (help, schema, onboarding, registration); `vault` commands get a resolved
// vault path and a Hafez instance. `mutating` entries auto-sync afterwards.
// Every command lives here — nothing dispatches inline from main() (the
// inline bypass region is where three of the last five CLI fixes landed).
type PreVaultRun = (args: string[], ctx: { json: boolean; vaultFlag?: string }) => Promise<string | null> | string | null
type VaultRun = (os: any, args: string[], opts: CommandOpts) => Promise<string>

export type CommandSpec =
  | { phase: 'pre-vault'; run: PreVaultRun }
  | { phase: 'vault'; mutating?: boolean; run: VaultRun }

/** Bind a vault command to its handler without importing the handler module
 * until the command actually runs. */
function lazy(pick: (m: typeof import('./commands.js')) => VaultRun): VaultRun {
  return async (os, args, opts) => pick(await import('./commands.js'))(os, args, opts)
}

export const COMMANDS: Record<string, CommandSpec> = {
  // --- pre-vault ---
  help: { phase: 'pre-vault', run: async (args) => (args[0] === '--agent' ? (await import('../surfaces/surfaces.js')).renderAgentHelp() : USAGE) },
  onboard: { phase: 'pre-vault', run: async (args, ctx) => (await import('./onboard.js')).cmdOnboard(args, { vaultFlag: ctx.vaultFlag }) },
  schema: { phase: 'pre-vault', run: async (args) => (await import('./commands-schema.js')).cmdSchema(null, args) },
  version: { phase: 'pre-vault', run: () => versionLine() },
  init: { phase: 'pre-vault', run: async (args, ctx) => { (await import('./resolve-vault.js')).cmdInit(args, ctx.vaultFlag); return null } },
  // Binds (args, ctx) explicitly: cmdUpgrade's third parameter is its
  // dependency seam, and PreVaultRun's signature keeps dispatch from ever
  // passing a third argument into it.
  upgrade: { phase: 'pre-vault', run: async (args, ctx) => (await import('./upgrade.js')).cmdUpgrade(args, ctx) },
  // --- vault ---
  read: { phase: 'vault', run: lazy(m => m.cmdRead) },
  sync: { phase: 'vault', run: lazy(m => m.cmdSync) },
  query: { phase: 'vault', run: lazy(m => m.cmdQuery) },
  search: { phase: 'vault', run: lazy(m => m.cmdSearch) },
  create: { phase: 'vault', mutating: true, run: lazy(m => m.cmdCreate) },
  capture: { phase: 'vault', mutating: true, run: lazy(m => m.cmdCapture) },
  update: { phase: 'vault', mutating: true, run: lazy(m => m.cmdUpdate) },
  link: { phase: 'vault', mutating: true, run: lazy(m => m.cmdLink) },
  unlink: { phase: 'vault', mutating: true, run: lazy(m => m.cmdUnlink) },
  promote: { phase: 'vault', mutating: true, run: lazy(m => m.cmdPromote) },
  delete: { phase: 'vault', mutating: true, run: lazy(m => m.cmdDelete) },
  batch: { phase: 'vault', mutating: true, run: lazy(m => m.cmdBatch) },
  validate: { phase: 'vault', run: lazy(m => m.cmdValidate) },
  health: { phase: 'vault', run: lazy(m => m.cmdHealth) },
  graph: { phase: 'vault', run: lazy(m => m.cmdGraph) },
  index: {
    phase: 'vault',
    run: async (os, args) => {
      const usage = 'Usage: hafez index rebuild'
      helpIfAsked(args, usage)
      if (args[0] === 'rebuild') return (await import('./commands.js')).cmdIndexRebuild(os)
      throw new UsageError(usage)
    },
  },
  stats: { phase: 'vault', run: lazy(m => m.cmdStats) },
  changelog: { phase: 'vault', run: lazy(m => m.cmdChangelog) },
  digest: { phase: 'vault', run: lazy(m => m.cmdDigest) },
  export: { phase: 'vault', run: lazy(m => m.cmdExport) },
}

/** The one exit-code table. The error → exit adapter maps HafezError codes
 * through `errorCodes`; `hafez --help` prints every row. 4 is the
 * mutate-succeeded-sync-failed warning path; anything unmapped = 1. */
export const EXIT_TABLE: ReadonlyArray<{ exit: number; meaning: string; errorCodes?: readonly HafezErrorCode[] }> = [
  { exit: 0, meaning: 'success' },
  { exit: 1, meaning: 'not found (slug, command or vault) / unknown error', errorCodes: ['NOT_FOUND'] },
  { exit: 2, meaning: 'validation or usage error (bad flags, bad payload, core rejected the write)', errorCodes: ['VALIDATION_FAILED'] },
  { exit: 3, meaning: 'git push failed — the write IS committed locally', errorCodes: ['GIT_PUSH_FAILED'] },
  { exit: 4, meaning: 'write succeeded but the auto-sync after it failed' },
  { exit: 5, meaning: 'slug already exists', errorCodes: ['SLUG_EXISTS'] },
  { exit: 6, meaning: 'git commit failed — nothing was written to history', errorCodes: ['GIT_COMMIT_FAILED'] },
  { exit: 7, meaning: 'vault locked by another hafez process — retry when it finishes', errorCodes: ['VAULT_LOCKED'] },
  { exit: 8, meaning: "git read failed (changelog, stats) — the vault's git is unusable", errorCodes: ['GIT_READ_FAILED'] },
]

export const EXIT_CODES: Record<string, number> = Object.fromEntries(
  EXIT_TABLE.flatMap(row => (row.errorCodes ?? []).map(code => [code, row.exit])),
)

/** Exported so a guard test can assert every registered command is documented
 * here — a registered-but-undocumented command is otherwise invisible. */
export const USAGE = `Usage: hafez <command> [args]

Commands:
  read <slug>                Read an entity, knowledge note or session note
    --archive                An entity's archived log entries
  query [--filter ...] ...   Filter entities/knowledge
    --kind all               Every kind, sessions included; --filter matches
                             entity status only, so the rest always show
    --kind session           Session notes alone, newest first
  search <terms>             Full-text search of entities and knowledge
    --kind session|all       Session notes alone, or every kind
  create <kind> <name>       Create entity or knowledge note
  capture <name> [--notes]   Quick inbox capture
  promote <slug> <target>    Promote capture→entity/project/knowledge, entity→project
  delete <slug>              Delete a knowledge or session note (an entity: update --status done)
  update <slug> [--status]   Update an entity or knowledge note
    --brief "text"           Set/replace Brief (use --brief "" to clear)
    --description "text"     Set one-line description (use --description "" to clear)
    --resource "uri-or-path" Add a place the work lives, entities only (repeats; . is this folder; --resource "" clears every value)
    --add-action "text"      Add a next action (repeats)
    --complete-action handle-or-text  Complete the action with that Handle (as read shows it), else the matching one (repeats)
    --remove-action handle-or-text    Remove the action with that Handle, else the matching one (repeats)
    --clear-actions          Remove all next actions
    --synthesis "text"       Set/replace Synthesis section (--insight is an alias)
    --add-evidence "text"    Append to Evidence section
    --add-source "text"      Append to Sources section
  batch                      Apply multiple operations atomically (JSON on stdin, --data or --file)
  digest                     Apply digest input (JSON on stdin, --data or --file) → batch payload (JSON stdout)
  export --okf [--out <dir>] Export vault as an OKF v0.1 bundle (read-only)
  sync                       Pull remote changes and push local commits
  link <slug> <target> --relation <rel>    Add a link
  unlink <slug> <target> --relation <rel>  Remove a link
  stats                      Vault summary: counts, stale items, recents
  changelog --since <when>   Git-derived change history (e.g. --since 7.days.ago)
  schema [op] [--examples]   Machine-readable JSON schema for batch operations
  validate                   Check vault integrity
  health                     The Health pass: what placement would change (applies nothing)
  graph --json               The vault's structure: entities and knowledge, parent/related/wiki-link edges
    --layers tag,domain,session  Add tag and domain nodes, and sessions
  graph [slug] [--port N] [--no-open]
                             Serve the graph on 127.0.0.1 (first free port from 4747) and open the browser;
                             a slug opens it focused on that note, local graph at depth 2
  index rebuild              Rebuild the SQLite index
  init --register <path>     Register an existing vault
  init                       Show current vault resolution
  onboard                    Setup status, then the script your agent follows to set Hafez up
    --install --mode <always-on|invoke-only> [--harness <h>] [--vault-repo <o/r>] [--confirm]
                             Write both skills and, always-on, the Block
                             (--vault-repo: the cloud Block, which attaches that repo)
    --remove [--confirm]     Remove the skills and the Block region
    --block [--harness <h>]  Print the entities matching this folder
                             (the SessionStart hook; no match in a git folder that is not the
                             vault's checkout asks for --resource .; else nothing, exit 0)
    --cloud --vault-repo <o/r>
                             Print the setup script for Claude Code cloud sessions
  upgrade                    Check whether hafez is outdated and print the update steps
  help --agent               The hafez skill body: the reference when the skill is not installed

Global flags:
  --vault <path>    Vault path (overrides config)
  --json            JSON output (structured, machine-readable)
  --version         Print the hafez version

Vault discovery: --vault flag > ~/.config/hafez/vault

Exit codes:
${EXIT_TABLE.map(row => `  ${row.exit}  ${row.meaning}`).join('\n')}
`

/** The pure half of the error → exit adapter: which code an error maps to.
 * Exported so the exit-code contract is testable without spawning the CLI. */
export function exitCodeFor(err: unknown): number {
  if (err instanceof HelpRequest) return 0
  if (err instanceof UsageError) return 2
  if (err instanceof HafezError) return EXIT_CODES[err.code] ?? 1
  return 1
}

/** The text half of the error adapter: what it prints for a usage or vault
 * error. A misuse ends with the shape to retry from. */
export function errorText(err: UsageError | HafezError): string {
  const lines = [`Error: ${err.message}`]
  if (err instanceof HafezError) for (const detail of err.details ?? []) lines.push(`  - ${detail}`)
  if (err instanceof MisuseError) lines.push('', err.shape)
  return lines.join('\n') + '\n'
}

/** The one error → exit adapter. Usage errors (bad flags/args) are distinct
 * from vault errors and from unknown crashes. */
function report(err: unknown): never {
  if (err instanceof HelpRequest) {
    process.stdout.write(err.usage + '\n')
    process.exit(exitCodeFor(err))
  }
  if (err instanceof RenderedError) {
    process[err.stream].write(err.output + '\n')
    process.exit(exitCodeFor(err))
  }
  if (err instanceof UsageError || err instanceof HafezError) {
    process.stderr.write(errorText(err))
    process.exit(exitCodeFor(err))
  }
  failUnknown(err)
}

/** Does this error mean the native module failed to load/build?
 *
 * Matched on the MESSAGE only, and only on the messages a load/ABI failure
 * actually produces. The old test also scanned the stack for "better-sqlite3",
 * which every SqliteError's stack contains — so a plain query error ("near
 * 'abc': syntax error") printed reinstall advice instead of itself. */
export function isBindingsFailure(err: unknown): boolean {
  const message = (err as Error | undefined)?.message
  if (typeof message !== 'string') return false
  return /Could not locate the bindings file|better_sqlite3\.node|was compiled against a different Node\.js version|NODE_MODULE_VERSION|invalid ELF header/i.test(message)
}

// Terminal handler for non-Hafez errors. Special-cases unbuilt better-sqlite3
// bindings: npm 11+ blocks install scripts by default, so `npm install -g
// hafez` reports success with the native module unbuilt and the first indexed
// command dies here — guide instead of stack-tracing.
function failUnknown(err: unknown): never {
  const e = err as Error
  if (isBindingsFailure(e)) {
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

function versionLine(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const pkg = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf-8'))
  return `hafez ${pkg.version}`
}

/** Extract the global flags (--vault <path>, --json) from anywhere in argv.
 * Exported for the in-process dispatch tests. A flag sitting where the vault
 * path should be means the value is missing — never consume it (the same
 * value-position rule parseArgs applies to declared command flags). */
export function extractGlobalFlags(args: string[]): { rest: string[]; vaultFlag?: string; json: boolean } {
  const rest: string[] = []
  let vaultFlag: string | undefined
  let json = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--vault') {
      const v = args[i + 1]
      if (v === undefined || v.startsWith('--')) throw new UsageError('--vault requires a path value')
      // The old one-shot extraction left a second --vault in the command args
      // where the declared-flag parser rejected it — keep failing loudly
      // rather than silently letting the last one win (a mutating command
      // would write to a different vault than the first flag named).
      if (vaultFlag !== undefined) throw new UsageError('--vault specified more than once')
      vaultFlag = v
      i++
    } else if (a === '--json') {
      json = true
    } else {
      rest.push(a)
    }
  }
  return { rest, vaultFlag, json }
}

/** Is this the SessionStart hook's form, `onboard --block`? Read from the raw
 * args, the token after `--vault` skipped, so it holds when parsing them fails. */
export function isBlockHook(args: string[]): boolean {
  const command = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '--vault')
  return command === 'onboard' && args.includes('--block')
}

export async function main(argv: string[]): Promise<void> {
  // The hook must never block a session: under `onboard --block` any failure
  // at all, a bad flag included, prints nothing and exits 0 (#132).
  const hook = isBlockHook(argv.slice(2))
  try {
    const { rest: args, vaultFlag, json } = extractGlobalFlags(argv.slice(2))

    const command = args.shift()
    if (!command || command === '--help' || command === '-h') {
      process.stdout.write(USAGE)
      return
    }
    const name = command === '--version' || command === '-v' ? 'version' : command

    const spec = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined
    if (!spec) {
      // `list` is the command agents guess for listing the vault (#30).
      const hint = command === 'list' ? '. To list the vault: hafez query --filter active' : ''
      process.stderr.write(`Unknown command: ${command}${hint}\n${USAGE}`)
      process.exit(1)
    }

    if (spec.phase === 'pre-vault') {
      const out = await spec.run(args, { json, vaultFlag })
      if (out !== null) process.stdout.write(out.endsWith('\n') ? out : out + '\n')
      return
    }

    // Resolve vault (loaded here, not at module top: the pre-vault commands
    // above return without ever needing the vault machinery)
    const { resolveVaultPath, noVaultMessage } = await import('./resolve-vault.js')
    const resolution = resolveVaultPath(vaultFlag)
    if (resolution === null) {
      process.stderr.write(noVaultMessage())
      process.exit(1)
    }
    if (typeof resolution === 'object' && 'error' in resolution) {
      process.stderr.write(`Error: ${resolution.error}\n`)
      process.exit(1)
    }
    const vaultPath = resolution

    // First touch of the core — and so of the native SQLite binding. A
    // failure to load it lands in the catch below and is recognised by
    // isBindingsFailure, exactly as it was when this import was static.
    const { createInternalHafez } = await import('../internal.js')
    // One index scan per process (#269): the first read syncs, later reads trust it.
    const os = createInternalHafez({ vaultPath, git: { push: false }, indexSync: 'once' })
    try {
      const result = await spec.run(os, args, { json, vaultPath })

      // Auto-sync after mutating commands
      if (spec.mutating) {
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
    } finally {
      os.close()
    }
  } catch (err) {
    if (hook) return
    report(err)
  }
}


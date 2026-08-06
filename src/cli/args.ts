// src/cli/args.ts
// The one flag parser behind every CLI command. Each command declares its
// flags; parseArgs enforces the declaration — unknown flags and missing
// values are UsageErrors instead of silently ignored tokens (the getFlag era
// needed a documented workaround because values stayed in the positional
// stream).

/** Bad invocation (unknown flag, missing value, missing positional).
 * Distinct from crashes: the error adapter maps it to exit 2. */
export class UsageError extends Error {}

export type FlagType = 'string' | 'boolean'

/** Flag names WITHOUT the leading dashes, e.g. { 'add-action': 'string' }. */
export type FlagSpec = Record<string, FlagType>

export interface ParsedArgs {
  flags: Record<string, string | boolean | undefined>
  positionals: string[]
}

export function parseArgs(args: string[], spec: FlagSpec, usage: string): ParsedArgs {
  const flags: Record<string, string | boolean | undefined> = {}
  const positionals: string[] = []

  for (let i = 0; i < args.length; i++) {
    const token = args[i]
    if (token.startsWith('--')) {
      const name = token.slice(2)
      const type = spec[name]
      if (!type) throw new UsageError(`Unknown flag --${name}\n${usage}`)
      if (type === 'boolean') {
        flags[name] = true
        continue
      }
      const value = args[i + 1]
      // A declared flag in value position means the value was omitted
      // (`--brief --clear-actions`) — consuming it would both corrupt the
      // string and silently drop the swallowed flag.
      if (value === undefined || (value.startsWith('--') && value.slice(2) in spec)) {
        throw new UsageError(`--${name} requires a value\n${usage}`)
      }
      flags[name] = value
      i++
    } else {
      positionals.push(token)
    }
  }

  return { flags, positionals }
}

/** Comma-separated list flag → trimmed array (undefined stays undefined). */
export function splitList(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== 'string') return undefined
  return value.split(',').map(s => s.trim())
}

export function str(value: string | boolean | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}

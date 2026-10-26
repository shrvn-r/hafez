// src/cli/resolve-vault.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import { kindDir } from '../vault.js'
import { helpIfAsked } from './args.js'

/** Where the config is looked for. The environment and home are inputs so the
 * `onboard --block` hook runs against a temporary home in tests. */
export interface ConfigHome {
  env: Record<string, string | undefined>
  home: string
}

const processHome = (): ConfigHome => ({ env: process.env, home: homedir() })

export function getConfigDir({ env, home }: ConfigHome = processHome()): string {
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'hafez')
}

export function getConfigPath(at: ConfigHome = processHome()): string {
  return join(getConfigDir(at), 'vault')
}

export function readVaultConfig(at: ConfigHome = processHome()): string | null {
  const configPath = getConfigPath(at)
  if (!existsSync(configPath)) return null
  try {
    const content = readFileSync(configPath, 'utf-8').trim()
    return content || null
  } catch {
    return null
  }
}

export function saveVaultConfig(vaultPath: string): void {
  const dir = getConfigDir()
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'vault'), resolve(vaultPath) + '\n')
}

export function isVault(dirPath: string): boolean {
  return existsSync(dirPath) && statSync(dirPath).isDirectory() && existsSync(join(dirPath, kindDir('entity')))
}

/**
 * Resolve vault path. Returns string or null.
 * If config exists but points to a bad path, returns an error object instead.
 */
export function resolveVaultPath(flagValue?: string, at: ConfigHome = processHome()): string | null | { error: string } {
  // 1. Explicit flag, absolute as the config's is (#291)
  if (flagValue) return resolve(flagValue)

  // 2. Config file
  const configValue = readVaultConfig(at)
  if (configValue) {
    if (isVault(configValue)) return configValue
    // Config exists but points to bad path — loud failure
    return {
      error: `Config (${getConfigPath(at)}) points to ${configValue} but it doesn't look like a vault.\nRun 'hafez init --register /correct/path' to fix.`,
    }
  }

  return null
}

export function noVaultMessage(): string {
  const configPath = getConfigPath()
  const configStatus = existsSync(configPath) ? 'path invalid' : 'no config file'

  return `No vault found.

Checked:
  --vault flag            not provided
  ${configPath}  ${configStatus}

Get started:
  hafez init --register /path/to/vault    Register an existing vault
`
}

export function cmdInit(args: string[], flagValue?: string): void {
  helpIfAsked(args, 'Usage: hafez init [--register <path>]')
  const registerIdx = args.indexOf('--register')

  if (registerIdx !== -1) {
    // hafez init --register <path>
    const path = args[registerIdx + 1]
    if (!path) {
      process.stderr.write('Usage: hafez init --register <path>\n')
      process.exit(1)
    }
    const abs = resolve(path)
    if (!isVault(abs)) {
      process.stderr.write(`Error: ${abs} does not exist or is not a vault (missing entities/ directory).\n`)
      process.exit(1)
    }
    // Every vault write is a git commit — catch the two states that would
    // otherwise make every later command fail with a raw git error.
    if (!existsSync(join(abs, '.git'))) {
      process.stderr.write(
        `Error: ${abs} is not a git repository — hafez uses git for history and sync.\n` +
        `Set it up, then re-register:\n` +
        `  cd ${abs} && git init && git commit --allow-empty -m "init vault"\n`
      )
      process.exit(1)
    }
    let identityOk = false
    try {
      const email = execSync('git config user.email', { cwd: abs, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      const name = execSync('git config user.name', { cwd: abs, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
      identityOk = email.length > 0 && name.length > 0
    } catch { /* unset config exits non-zero */ }
    if (!identityOk) {
      process.stderr.write(
        `Error: git has no identity configured — every vault write is a git commit.\n` +
        `Fix (one-time), then re-register:\n` +
        `  git config --global user.name "Your Name"\n` +
        `  git config --global user.email "you@example.com"\n`
      )
      process.exit(1)
    }
    saveVaultConfig(abs)
    process.stdout.write(`Registered vault: ${abs}\n`)
    return
  }

  // Bare `hafez init` — show current resolution status
  if (flagValue) {
    process.stdout.write(`Vault: ${resolve(flagValue)} (--vault flag)\n`)
    return
  }

  const configValue = readVaultConfig()
  if (configValue) {
    if (isVault(configValue)) {
      process.stdout.write(`Vault: ${configValue} (config: ${getConfigPath()})\n`)
    } else {
      process.stderr.write(`Config (${getConfigPath()}) points to ${configValue} but it doesn't look like a vault.\nRun 'hafez init --register /correct/path' to fix.\n`)
      process.exit(1)
    }
    return
  }

  process.stderr.write(noVaultMessage())
  process.exit(1)
}

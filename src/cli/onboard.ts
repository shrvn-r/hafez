// src/cli/onboard.ts
//
// `hafez onboard` — the user side of the Agent Contract (onboard decision
// #58). Bare, it prints where things stand, then the script the agent follows
// for its user: ask the Mode, install, allow the command, offer the hook and
// any other Harness found, seed an empty vault, hand over with the teaching
// lines. The files are the state: re-running walks only what is not current.
//
// `--install` and `--remove` write the files Hafez owns outside the vault
// (install.ts). The binary has no interactive prompts: the agent asks, then
// passes the answer as a flag. `--block` is the SessionStart hook's render
// (block-hook.ts) and writes nothing. `--cloud` prints the setup script for a
// Claude Code cloud environment, whose `--install --vault-repo` writes the
// Block with the rule that attaches the vault repo (#160).

import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { UsageError, parseArgs, str } from './args.js'
import { HARNESSES, ONBOARD_HARNESSES, detectAgent, isHarness, isOnboardHarness, type HarnessId, type OnboardHarness } from '../harness.js'
import { MODES, SKILL_DIRS, fixBrokenMarkers, install, installState, instructionsFile, isMode, legacyLine, remove, removeLegacy, vaultRepoFlag, type InstallState, type Mode } from './install.js'
import { noVaultMessage, resolveVaultPath, type ConfigHome } from './resolve-vault.js'
import { HafezError } from '../types.js'
import { kindDir, scanVaultDir } from '../vault.js'
import { ITEMS, isVaultRepo } from '../surfaces/items.js'
import { renderBlock } from '../surfaces/surfaces.js'
import { blockHook, type BlockHookCtx } from './block-hook.js'

const HARNESS_IDS = Object.keys(HARNESSES).join('|')
const MODE_IDS = MODES.join('|')

const ONBOARD_USAGE = `Usage:
  hafez onboard
  hafez onboard --install --mode <${MODE_IDS}> [--harness <${HARNESS_IDS}>] [--vault-repo <owner>/<repo>] [--confirm]
  hafez onboard --remove [--confirm]
  hafez onboard --block [--harness <${HARNESS_IDS}>]
  hafez onboard --cloud --vault-repo <owner>/<repo>`

/** What `onboard` reads from its surroundings, each defaulting to the process's. */
export type OnboardCtx = Partial<ConfigHome> & Pick<BlockHookCtx, 'cwd' | 'vaultFlag'>

/** `ctx` is the temp-home seam: tests pass a temporary home and environment;
 * the install functions are given the home, never read it. `vaultFlag` is the
 * global `--vault`; without it the bare form reports on the registered vault.
 * `--block` returns a promise of its render, or of null when it must print nothing. */
export function cmdOnboard(args: string[], ctx: OnboardCtx = {}): string | Promise<string | null> {
  const { home = homedir(), env = process.env, cwd, vaultFlag } = ctx
  const { flags, positionals } = parseArgs(
    args,
    { install: 'boolean', remove: 'boolean', block: 'boolean', cloud: 'boolean', mode: 'string', harness: 'string', 'vault-repo': 'string', confirm: 'boolean' },
    ONBOARD_USAGE,
  )
  const fail = (why: string): never => {
    throw new UsageError(`${why}\n${ONBOARD_USAGE}`)
  }
  if (positionals.length) fail(`Unexpected argument: ${positionals[0]}`)
  const mode = str(flags.mode)
  const harnessFlag = str(flags.harness)
  const vaultRepo = str(flags['vault-repo'])
  const confirm = flags.confirm === true

  if (flags.install && flags.remove) fail('--install and --remove are separate commands')
  if (vaultRepo !== undefined && !isVaultRepo(vaultRepo)) fail(`--vault-repo takes the vault's GitHub repo as <owner>/<repo>, got: ${vaultRepo}`)
  if (vaultRepo !== undefined && !flags.cloud && !flags.install) fail('--vault-repo goes with --cloud or --install')
  if (flags.cloud) {
    if (flags.install || flags.remove || flags.block || mode !== undefined || harnessFlag !== undefined || confirm) {
      fail('--cloud takes only --vault-repo: it prints the setup script and writes nothing')
    }
    if (vaultRepo === undefined) return fail('--cloud needs --vault-repo <owner>/<repo>, the vault\'s GitHub repo')
    return ITEMS.cloudSetup.render({ vaultRepo })
  }
  if (flags.block) {
    if (flags.install || flags.remove || mode !== undefined || confirm) fail('--block takes only --harness: it prints the folder match and writes nothing')
    if (harnessFlag !== undefined && !isHarness(harnessFlag)) fail(`Unknown harness: ${harnessFlag}`)
    return blockHook({ home, env, cwd, vaultFlag })
  }
  if (flags.remove) {
    if (mode !== undefined || harnessFlag !== undefined) fail('--remove takes no --mode or --harness: it removes everything Hafez wrote')
    return remove({ home, confirm })
  }
  if (flags.install) {
    if (mode === undefined) return fail(`--install needs --mode <${MODE_IDS}>`)
    if (!isMode(mode)) return fail(`Unknown mode: ${mode}`)
    const harness = harnessFlag ?? detectAgent(env)
    if (!isHarness(harness)) {
      return fail(harnessFlag === undefined ? `No harness detected: pass --harness <${HARNESS_IDS}>` : `Unknown harness: ${harnessFlag}`)
    }
    // The cloud Block's rule is Claude Code's: cloud sessions attach repos there.
    if (vaultRepo !== undefined && (mode !== 'always-on' || harness !== 'claude-code')) {
      fail('--vault-repo is for a Claude Code cloud container: --mode always-on --harness claude-code')
    }
    return install({ home, harness, mode, confirm, vaultRepo })
  }
  if (mode !== undefined || harnessFlag !== undefined || confirm) fail('--mode, --harness and --confirm go with --install, --remove or --block')
  const harness = detectAgent(env)
  if (!isOnboardHarness(harness)) {
    return fail('No harness detected: run `hafez onboard` from inside Claude Code or Codex. Another harness: `hafez onboard --install --harness <h>`')
  }
  return renderOnboard({ home, harness, vault: resolvedVault(vaultFlag) })
}

function resolvedVault(flag: string | undefined): string {
  const resolution = resolveVaultPath(flag)
  if (resolution === null) throw new HafezError('NOT_FOUND', noVaultMessage())
  if (typeof resolution === 'object') throw new HafezError('NOT_FOUND', resolution.error)
  return resolution
}

// --- Bare onboard: status, then the script ---

const read = (home: string, rel: string): string | null => {
  try {
    return readFileSync(join(home, rel), 'utf-8')
  } catch {
    return null
  }
}

/** Whether the SessionStart hook and the permission entries are already in
 * the Harness's config: present when found, absent otherwise (an unreadable
 * file included). Claude Code's settings are JSON; Codex's rule and TOML are
 * matched as text. */
function harnessConfig(home: string, harness: OnboardHarness, vault: string): { hook: boolean; allowlist: boolean } {
  const isHook = (command: unknown) => typeof command === 'string' && command.includes('hafez onboard --block')
  if (harness === 'claude-code') {
    const { hooks, allowEntry } = ONBOARD_HARNESSES[harness]
    let settings: any = null
    try {
      settings = JSON.parse(read(home, hooks) ?? 'null')
    } catch {
      settings = null
    }
    const groups: unknown[] = Array.isArray(settings?.hooks?.SessionStart) ? settings.hooks.SessionStart : []
    const allow: unknown[] = Array.isArray(settings?.permissions?.allow) ? settings.permissions.allow : []
    return {
      hook: groups.some((group: any) => Array.isArray(group?.hooks) && group.hooks.some((h: any) => isHook(h?.command))),
      allowlist: allow.includes(allowEntry),
    }
  }
  const { hooks, rules, config } = ONBOARD_HARNESSES[harness]
  const toml = read(home, config) ?? ''
  return {
    hook: isHook(read(home, hooks)) || isHook(toml),
    allowlist: /prefix_rule\(\s*pattern\s*=\s*\[\s*"hafez"\s*\]/.test(read(home, rules) ?? '') && toml.includes(JSON.stringify(vault)),
  }
}

const hookEntry = (harness: OnboardHarness) =>
  `{"matcher": "startup|compact", "hooks": [{"type": "command", "command": "hafez onboard --block --harness ${harness}"}]}`

/** Mode is never stored: a Block present means always-on, skills `onboard`
 * installed without one mean invoke-only. Neither is a first run, a setup from
 * before `onboard` (a hand-pasted section, a skill with no hash) included. */
const modeOf = ({ block, onboarded }: InstallState): Mode | null =>
  block !== null && block !== 'absent' ? 'always-on' : onboarded ? 'invoke-only' : null

/** Current in its Mode: the skills current, and the Block too where there is
 * one. A Harness with no Block file (Cursor) is current on its skills. */
const isCurrent = (state: InstallState) =>
  state.skills === 'current' && (state.block === null || state.block === 'current' || modeOf(state) === 'invoke-only')

const statusLine = (label: string, { block, skills }: InstallState, extra: string[] = []) =>
  `${label}: ${[...(block === null ? [] : [`Block ${block === 'broken' ? 'broken markers' : block}`]), `skills ${skills}`, ...extra].join(' | ')}`

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
const listed = (names: string[]) => (names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

export function renderOnboard({ home, harness, vault }: { home: string; harness: OnboardHarness; vault: string }): string {
  const { label, instructions } = HARNESSES[harness]
  const state = installState(home, harness)
  const config = harnessConfig(home, harness, vault)
  const others = (Object.keys(HARNESSES) as HarnessId[])
    .filter(id => id !== harness && existsSync(join(home, HARNESSES[id].dir)))
    .map(id => ({ id, ...HARNESSES[id], state: installState(home, id) }))
  const entities = scanVaultDir(join(vault, kindDir('entity'))).length
  const knowledge = scanVaultDir(join(vault, kindDir('knowledge'))).length

  const mode = modeOf(state)
  const otherMode: Mode = mode === 'always-on' ? 'invoke-only' : 'always-on'
  const installCurrent = isCurrent(state)
  const teaching = (m: Mode) => ITEMS.teachingLines.render({ harness, mode: m })
  const line2 = (m: Mode) => ITEMS.teachingLines.render({ harness, mode: m, line2Only: true })
  const instructionsRel = `~/${instructionsFile(home, instructions)}`
  // A cloud Block stays one: its install line and Block keep the vault repo.
  const block = `\`\`\`\`\n${renderBlock(state.vaultRepo)}\`\`\`\``
  const showBlock = `show the user the Block below word for word, not a summary, say it goes into ${instructionsRel} between two marker lines and nothing else in that file changes, and get a yes. Then run:`

  const status = [
    `Vault: ${vault} (${plural(entities, 'entity', 'entities')}, ${plural(knowledge, 'knowledge note', 'knowledge notes')})`,
    statusLine(`${label} (this harness)`, state, [`hook ${config.hook ? 'present' : 'absent'}`, `allowlist ${config.allowlist ? 'present' : 'absent'}`]),
    ...others.map(o => statusLine(`${o.label} (found at ~/${o.dir})`, o.state)),
    // `--install` and `--remove` refuse broken markers: only a hand fix walks on.
    ...[{ ...HARNESSES[harness], state }, ...others]
      .filter(h => h.state.block === 'broken')
      .map(h => fixBrokenMarkers(`~/${instructionsFile(home, h.instructions!)}`, 'hafez onboard')),
    ...[{ ...HARNESSES[harness], state }, ...others]
      .filter(h => h.state.legacy !== null)
      .map(h => `${legacyLine(`~/${instructionsFile(home, h.instructions!)}`, h.state.legacy!)}, from Hafez 1.x, with no markers.`),
  ]

  // With the install current there is no install step: switching the Mode is
  // walked here, and re-running `onboard` afterwards walks what it changed.
  const switchMode = !installCurrent || mode === null
    ? []
    : otherMode === 'always-on'
      ? [`To switch to always-on, ${showBlock}`, '', 'hafez onboard --install --mode always-on', '', 'then `hafez onboard` again for the session-start hook.', '', block]
      : [
        'To switch to invoke-only, run:',
        '',
        'hafez onboard --install --mode invoke-only',
        ...(config.hook ? ['', `and remove the hafez entry from hooks.SessionStart in ~/${ONBOARD_HARNESSES[harness].hooks}.`] : []),
      ]

  const steps: Array<{ title: string; body?: string }> = []
  steps.push({
    title: 'Ask how Hafez should run',
    body: [
      'Ask one question and recommend the first answer.',
      '',
      '- Always-on: you load the vault at the start of a session and write to it as work lands.',
      '- Invoke-only: nothing happens unless the user asks. No load at start, no writes during the session.',
      ...(mode === null ? [] : ['', `It runs ${mode} now.${switchMode.length ? ` ${switchMode[0]}` : ''}`, ...switchMode.slice(1)]),
    ].join('\n'),
  })
  if (!installCurrent && state.block !== 'broken') {
    steps.push({
      title: 'Install',
      body: [
        // Either install leaves the 1.x section in place, beside the Block or alone.
        ...(state.legacy === null ? [] : [`${removeLegacy(instructionsRel, state.legacy)} Do this before either install below.`, '']),
        `Always-on: ${showBlock}`,
        '',
        `hafez onboard --install --mode always-on${vaultRepoFlag(state.vaultRepo)}`,
        '',
        'Invoke-only: no file of theirs is edited. Run:',
        '',
        'hafez onboard --install --mode invoke-only',
        '',
        `Both install two skills, \`hafez\` and \`hafez-save\`, into ${SKILL_DIRS.map(d => `~/${d}`).join(' and ')}.`,
        '',
        block,
      ].join('\n'),
    })
  }
  if (installCurrent && state.legacy !== null) {
    steps.push({ title: 'Remove the Hafez 1.x section', body: removeLegacy(instructionsRel, state.legacy) })
  }
  if (!config.allowlist) {
    steps.push({ title: 'Allow the command', body: ITEMS.harnessPermissions.render({ harness, vault }) })
  }
  if (!config.hook && mode !== 'invoke-only') {
    steps.push({
      title: 'Offer the session-start hook (always-on only)',
      body: 'Ask: should the start of every session, and every compaction, name the entity the working folder belongs to? '
        + `If yes, show this entry, then add it to ~/${ONBOARD_HARNESSES[harness].hooks} under hooks.SessionStart:\n\n${hookEntry(harness)}`
        // Live run (#101): Codex asks once whether to trust a new hook.
        + (harness === 'codex' ? '\n\nTell the user Codex will ask once, at the next session start, whether to trust this hook: the answer is yes.' : ''),
    })
  }
  const offered = others.filter(o => !isCurrent(o.state) && o.state.block !== 'broken')
  if (offered.length > 0) {
    const one = offered.length === 1
    steps.push({
      title: 'Offer the other harness',
      body: [
        `${listed(offered.map(o => o.label))} ${one ? 'is' : 'are'} installed too. Ask once whether to set ${one ? 'it' : 'them'} up the same way. If yes:`,
        '',
        // A first run cannot know the answer to step 1 yet; the agent carries it.
        ...offered.map(o => `hafez onboard --install --harness ${o.id} --mode ${mode ?? 'always-on'}`),
      ].join('\n'),
    })
  }
  steps.push(entities + knowledge === 0
    ? {
      title: 'Seed the vault',
      body: [
        'An empty vault gives you nothing to load. Ask: "What are you working on right now?" Aim for three to seven pieces of work. For each, draw out one sentence of description, where things stand, and the next step, then write it:',
        '',
        ITEMS.createLines.render('<name>'),
        '',
        'Anything vague or someday: `hafez capture "<name>"`. Read a README or notes only if the user points you at them. Do not ask for approval before writing. When done, show them `hafez stats`.',
      ].join('\n'),
    }
    : { title: 'Seed the vault (skipped: the vault is not empty)' })
  // On a re-run only line 2's subject can have changed: the Mode, if the
  // user switches it in step 1.
  steps.push({
    title: 'Hand over',
    body: mode === null
      ? [
        'Say these to the user in your own words, then give three example asks drawn from their vault, each naming an entity or note in it.',
        '',
        'Always-on:',
        '',
        teaching('always-on'),
        '',
        'Invoke-only, line 2:',
        '',
        line2('invoke-only'),
      ].join('\n')
      : `The user has heard the teaching lines before. Only if they switched to ${otherMode} in step 1, tell them in your own words:\n\n${line2(otherMode)}`,
  })

  return [
    '# Hafez setup',
    '',
    'You are an agent reading this for your user. Talk them through it; do not paste this to them.',
    '',
    '## Where things stand',
    '',
    ...status,
    ...steps.flatMap(({ title, body }, i) => ['', `## ${i + 1}. ${title}`, ...(body === undefined ? [] : ['', body])]),
  ].join('\n')
}

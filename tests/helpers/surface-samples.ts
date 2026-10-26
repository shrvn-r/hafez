// tests/helpers/surface-samples.ts
//
// Every committed surface file of the Agent Contract, rendered from the one
// source (docs/agent-contract/README.md, drift check 1). The static files —
// the Block and the two skills — come from the Item table alone. The samples
// under tests/fixtures/surfaces/ are what the command functions print against one
// fixture vault, on one fixed day: four reads, the miss, the update renders,
// the `create knowledge` renders and the `onboard` renders. The prose around
// a sample's fenced blocks lives here too, so a file is edited nowhere else.
// `scripts/render-surfaces.ts` writes the files; tests/surfaces.test.ts
// fails on any difference.

import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHafez, removeTemp } from './hafez.js'
import { cmdBatch, cmdCreate, cmdHealth, cmdRead, cmdUpdate } from '../../src/cli/commands.js'
import { cmdOnboard } from '../../src/cli/onboard.js'
import { RenderedError } from '../../src/cli/args.js'
import { errorText } from '../../src/cli/index.js'
import { HafezError, type Hafez } from '../../src/types.js'
import { ITEMS } from '../../src/surfaces/items.js'
import { renderBlock, renderHafezSaveSkill, renderHafezSkill } from '../../src/surfaces/surfaces.js'
import { createMemoryJournal } from './memory-journal.js'

/** The day the samples show: 62 days after the oldest stamped action. */
export const SAMPLE_DAY = '2026-10-02'

/** The committed files, repo-relative, in the surfaces README's order. */
export const SURFACE_FILES = [
  'tests/fixtures/surfaces/block.md',
  'skill/hafez/SKILL.md',
  'skill/hafez-save/SKILL.md',
  'tests/fixtures/surfaces/read-project.md',
  'tests/fixtures/surfaces/read-insight.md',
  'tests/fixtures/surfaces/read-plan.md',
  'tests/fixtures/surfaces/read-capture.md',
  'tests/fixtures/surfaces/read-hub.md',
  'tests/fixtures/surfaces/update-output.md',
  'tests/fixtures/surfaces/read-miss.md',
  'tests/fixtures/surfaces/create-knowledge-output.md',
  'tests/fixtures/surfaces/onboard.md',
  'tests/fixtures/surfaces/health.md',
] as const

export type SurfaceFile = (typeof SURFACE_FILES)[number]

/** Run `fn` with `new Date()` and `Date.now()` pinned to noon of `day`, so
 * the stale ages and the stamps in the samples never move. */
export async function onDay<T>(day: string, fn: () => Promise<T>): Promise<T> {
  const RealDate = Date
  const now = new RealDate(`${day}T12:00:00`).getTime()
  const Pinned = class extends RealDate {
    constructor(...args: unknown[]) {
      super(...((args.length === 0 ? [now] : args) as [number]))
    }

    static now(): number {
      return now
    }
  }
  globalThis.Date = Pinned as unknown as DateConstructor
  try {
    return await fn()
  } finally {
    globalThis.Date = RealDate
  }
}

const fence = (body: string, ticks = '```') => `${ticks}\n${body}\n${ticks}`

const file = (frontmatter: string[], body: string[]) => ['---', ...frontmatter, '---', '', ...body, ''].join('\n')

/** The fixture vault the samples are rendered against: the project, its
 * parent (a Hub with one unsplit family, a one-way `related` edge and the
 * decision a note restates), its sibling (the second child, one recurring
 * name, a `[[slug]]` mention with no edge), the insight, the plan, the
 * capture, two entities a miss comes close to, one the second `--block`
 * render also matches, and the note a new knowledge note near-matches. */
function writeFixtureVault(vault: string, sessionTokensResource: string): void {
  const put = (dir: string, slug: string, text: string) => writeFileSync(join(vault, dir, `${slug}.md`), text)
  mkdirSync(join(vault, 'entities'), { recursive: true })
  mkdirSync(join(vault, 'knowledge'), { recursive: true })

  put('entities', 'auth-refactor', file([
    'name: Auth Refactor',
    'type: project',
    'status: active',
    'created: 2026-07-14',
    'last-touched: 2026-09-28',
    'description: Move session handling from cookies to short-lived tokens',
    'resource: https://github.com/acme/auth',
    'domain:',
    '  - engineering',
    'parent: platform',
    'related:',
    '  - token-rotation-policy',
  ], [
    '## Purpose',
    '',
    'Stop long-lived cookies from being the only thing between a stolen laptop and an account.',
    '',
    '## Brief',
    '',
    'Token endpoint is live behind a flag. Web client is on it; mobile still uses cookies. See [[token-rotation-policy]] for the lifetimes.',
    '',
    '## Next Actions',
    '',
    '- [ ] Migrate the mobile client to the token endpoint (added 2026-09-25)',
    '- [ ] Remove the cookie fallback (added 2026-08-01)',
    '- [ ] Ask security about refresh lifetime',
    '- [x] Ship the token endpoint (added 2026-09-10)',
    '',
    '## Session Log',
    '',
    '### 2026-09-28 — claude [progress]',
    'Summary: Token endpoint live behind a flag',
    'Web client switched over; no errors in the first day.',
  ]))
  put('entities', 'platform', file([
    'name: Platform',
    'type: project',
    'status: active',
    'created: 2026-05-01',
    'last-touched: 2026-09-10',
    'description: Shared services every product team builds on',
    'related:',
    '  - meeting-transcript-pipeline',
  ], [
    '## Brief',
    '',
    'One team, every shared service.',
    '',
    '## Next Actions',
    '',
    '- [ ] QUEUE Cap the per-tenant depth (added 2026-09-20)',
    '- [ ] QUEUE Alert when a job is older than an hour (added 2026-09-20)',
    '- [x] QUEUE Drain the retry backlog (added 2026-09-05)',
    '',
    '## Session Log',
    '',
    '### 2026-09-10 — claude [progress]',
    'Summary: Billing Service moved invoicing onto the shared queue',
    '',
    '### 2026-09-01 — claude [decision]',
    'Summary: Webhook retries draw on one shared hourly budget',
  ]))
  put('entities', 'billing-service', file([
    'name: Billing Service',
    'type: project',
    'status: active',
    'created: 2026-08-20',
    'last-touched: 2026-09-20',
    'description: Invoices and payouts for every product',
    'parent: platform',
  ], [
    '## Brief',
    '',
    "Charges clear through [[auth-refactor]]'s token endpoint; payouts settle through Stripe.",
    '',
    '## Next Actions',
    '',
    '- [ ] Reconcile the Stripe payouts every Monday (added 2026-09-18)',
    '- [ ] Move refunds onto Stripe credit notes (added 2026-09-18)',
    '- [x] Mirror the Stripe webhooks into the ledger (added 2026-09-12)',
    '- [x] Map every invoice to a Stripe customer (added 2026-09-02)',
    '- [x] Back-fill the Stripe customer ids (added 2026-09-02)',
    '- [x] Switch the Stripe sandbox to live keys (added 2026-08-28)',
    '- [x] Verify the Stripe account for payouts (added 2026-08-22)',
    '- [x] Open the Stripe account (added 2026-08-20)',
    '',
    '## Session Log',
    '',
    '### 2026-09-20 — claude [progress]',
    'Summary: First live payout landed through Stripe',
    '',
    '### 2026-09-12 — claude [progress]',
    'Summary: Every Stripe webhook now mirrors into the ledger',
  ]))
  put('entities', 'rate-limit-the-token-endpoint', file([
    'name: Rate limit the token endpoint',
    'type: capture',
    'status: active',
    'created: 2026-09-30',
    'last-touched: 2026-09-30',
  ], ['## Notes', '', 'Saw 400 requests a second from one client during the load test.']))
  put('entities', 'meeting-transcript-pipeline', file([
    'name: Meeting Transcript Pipeline',
    'type: project',
    'status: active',
    'created: 2026-06-10',
    'last-touched: 2026-09-15',
    'description: Audio to notes',
  ], ['## Brief', '', 'Whisper, then a summary.']))
  put('entities', 'farsi-meeting-transcription-script', file([
    'name: Farsi Meeting Transcription Script',
    'type: project',
    'status: active',
    'created: 2026-06-12',
    'last-touched: 2026-09-16',
  ], ['## Brief', '', 'One script, one language.']))
  put('entities', 'session-tokens', file([
    'name: Session tokens',
    'type: entity',
    'status: done',
    'created: 2026-04-02',
    'last-touched: 2026-07-01',
    `resource: ${sessionTokensResource}`,
  ], ['## Brief', '', 'Superseded by the auth refactor.']))

  put('knowledge', 'short-lived-tokens-beat-revocation-lists', file([
    'name: Short-lived tokens beat revocation lists',
    'created: 2026-08-03',
    'description: Expiry does the work a revocation list has to be asked to do',
    'confidence: pattern',
    'domain:',
    '  - engineering',
    '  - security',
    'reinforcement-count: 2',
    'last-reinforced: 2026-09-12',
    'related:',
    '  - auth-refactor',
  ], [
    '## Synthesis',
    '',
    'A token that expires in minutes needs no revocation path for most threats; a list has to be consulted on every request and is the first thing skipped under load.',
    '',
    '## Evidence',
    '',
    '- 2026-08-03: the cookie incident was a revocation that never propagated.',
    '- 2026-09-12: load test, the list lookup was 40% of auth latency.',
    '',
    '## Sources',
    '',
    '- https://example.com/token-lifetimes',
  ]))
  put('knowledge', 'cookie-fallback-removal', file([
    'name: Cookie fallback removal',
    'created: 2026-09-20',
    'last-touched: 2026-09-20',
    'description: Order of work for taking the cookie path out',
    'subtype: plan',
    'status: active',
    'domain:',
    '  - engineering',
    'related:',
    '  - auth-refactor',
  ], [
    '## Goal',
    '',
    'No request is authenticated by cookie.',
    '',
    '## Steps',
    '',
    '1. Mobile client on the token endpoint.',
    '2. Log cookie-authenticated requests for a week.',
    '3. Delete the fallback.',
    '',
    '## Dependencies',
    '',
    '- [[auth-refactor]] token endpoint out from behind its flag.',
  ]))
  put('knowledge', 'webhook-retries-share-one-budget', file([
    'name: Webhook retries share one budget',
    'created: 2026-09-01',
    'description: Every retry to an endpoint draws on one hourly budget.',
    'related:',
    '  - platform',
  ], ['## Synthesis', '', 'Every retry to an endpoint draws on one hourly budget.']))
}

/** The error a command function rejects with. */
async function failure(p: Promise<unknown>): Promise<unknown> {
  try {
    await p
  } catch (err) {
    return err
  }
  throw new Error('expected a rejection, got success')
}

/** What the CLI prints for a rejection: a rendered output as it is, a vault
 * error through the error adapter's text. */
async function printed(p: Promise<unknown>): Promise<string> {
  const err = await failure(p)
  if (err instanceof RenderedError) return err.output
  if (err instanceof HafezError) return errorText(err).replace(/\n$/, '')
  throw err
}

const OPEN_LINE = /^- \[ \] ([0-9a-f]+) {2}(.*)$/gm

/** The open actions of a rendered read: Handle and the rest of the line. */
const openLines = (out: string) => [...out.matchAll(OPEN_LINE)].map(m => ({ handle: m[1], rest: m[2] }))

/** Every committed surface file, keyed by its repo-relative path. */
export async function renderSurfaceFiles(): Promise<Record<SurfaceFile, string>> {
  const root = mkdtempSync(join(tmpdir(), 'hafez-surfaces-'))
  try {
    return await onDay(SAMPLE_DAY, () => renderIn(root))
  } finally {
    removeTemp(root)
  }
}

async function renderIn(root: string): Promise<Record<SurfaceFile, string>> {
  const vault = join(root, 'vault')
  // The second `--block` render's folder, matched by `session-tokens`'s resource.
  const severalCwd = join(root, 'work-several', 'auth-refactor')
  writeFixtureVault(vault, severalCwd)
  const os: Hafez = createHafez({ vaultPath: vault, persistence: createMemoryJournal() })

  const files: Partial<Record<SurfaceFile, string>> = {
    'tests/fixtures/surfaces/block.md': renderBlock(),
    'skill/hafez/SKILL.md': renderHafezSkill(),
    'skill/hafez-save/SKILL.md': renderHafezSaveSkill(),
  }

  // `onboard` first: its status line counts the vault before anything is written.
  files['tests/fixtures/surfaces/onboard.md'] = await renderOnboard(root, vault, severalCwd)

  // A command's output, as the CLI prints it: with its final newline.
  const read = async (args: string[]) => `${await cmdRead(os, args)}\n`
  files['tests/fixtures/surfaces/read-project.md'] = await read(['auth-refactor', '--depth', 'full'])
  files['tests/fixtures/surfaces/read-insight.md'] = await read(['short-lived-tokens-beat-revocation-lists'])
  files['tests/fixtures/surfaces/read-plan.md'] = await read(['cookie-fallback-removal'])
  files['tests/fixtures/surfaces/read-capture.md'] = await read(['rate-limit-the-token-endpoint'])
  files['tests/fixtures/surfaces/read-hub.md'] = await read(['platform'])
  files['tests/fixtures/surfaces/health.md'] = `${await cmdHealth(os, [])}\n`

  const miss = (slug: string) => printed(cmdRead(os, [slug]))
  files['tests/fixtures/surfaces/read-miss.md'] = [
    'Two renders of what `hafez read` prints for a slug that does not exist. Each fenced block is one complete output, on stderr, with the not-found exit code. Under `--json` the miss is `{"slug": "<slug>", "closest": ["<slug>", …]}` on stdout, with the same exit code. The create line is the Block\'s entity create line with the miss\'s slug words as the name; a miss is a guessed entity slug far more often than a knowledge one.',
    '',
    '## Close slugs',
    '',
    fence(await miss('meeting-transcriber')),
    '',
    '## No close slug',
    '',
    fence(await miss('launchpads')),
    '',
  ].join('\n')

  files['tests/fixtures/surfaces/update-output.md'] = await renderUpdateOutput(os)
  files['tests/fixtures/surfaces/create-knowledge-output.md'] = await renderCreateKnowledgeOutput(os, root)

  return files as Record<SurfaceFile, string>
}

/** The three `update` renders. The misuse comes first, before anything is
 * written; the success with Stale lines ticks the project's first action;
 * the plain success is the same write once the Stale lines are gone. */
async function renderUpdateOutput(os: Hafez): Promise<string> {
  const slug = 'auth-refactor'
  const misuse = await printed(cmdUpdate(os, [slug, '--add-actions', 'x']))
  const landed = (handle: string, added: string) =>
    cmdUpdate(os, [slug, '--log', 'progress: Web client switched', '--complete-action', handle, '--add-action', added])
  const [first] = openLines(await cmdRead(os, [slug]))
  const withStale = await landed(first.handle, 'Log cookie-authenticated requests for a week')
  const stale = openLines(await cmdRead(os, [slug])).filter(l => l.rest.includes('· stale'))
  for (const line of stale) await cmdUpdate(os, [slug, '--remove-action', line.handle])
  const [next] = openLines(await cmdRead(os, [slug]))
  const plain = await landed(next.handle, 'Delete the fallback')
  return [
    'Three renders of what `hafez update` prints. Each fenced block is one complete output.',
    '',
    '## Success',
    '',
    fence(plain),
    '',
    '## Success, stale lines remain',
    '',
    fence(withStale),
    '',
    '## Misuse',
    '',
    'The error line, then the footer `read` shows for this slug.',
    '',
    fence(misuse, '````'),
    '',
  ].join('\n')
}

/** The Near-match refusal, the relate line after a weaker resemblance, and
 * `batch`'s warning, each judged by the real rule against the fixture. */
async function renderCreateKnowledgeOutput(os: Hafez, root: string): Promise<string> {
  const refused = { name: 'Webhook retries share a budget per endpoint', synthesis: 'A burst to one endpoint cannot starve the others.' }
  const refusal = await printed(cmdCreate(os, ['knowledge', refused.name, '--synthesis', refused.synthesis, '--confidence', 'observation']))
  const related = await cmdCreate(os, ['knowledge', 'Jitter webhook retries'])
  const ops = join(root, 'ops.json')
  writeFileSync(ops, JSON.stringify([{ op: 'create', kind: 'knowledge', name: refused.name, fields: { synthesis: refused.synthesis } }]))
  const batch = (await cmdBatch(os, ['--file', ops])).split('\n').filter(line => line.startsWith('Warning:'))
  return [
    'Three renders of what Hafez prints when a new knowledge note\'s name resembles an existing one. Each fenced block is one complete output.',
    '',
    '## Near-match: refused',
    '',
    '`create knowledge` writes nothing and exits 5, the slug-exists code. Up to three near-matches are listed, each with its own line: an existing plan gets `--status` instead of `--add-evidence`, and a create with no `--synthesis` leaves `"<evidence>"` to fill in.',
    '',
    fence(refusal, '````'),
    '',
    '## Weaker resemblance: written, one relate line',
    '',
    'The note is written; the relate line follows the slug. Optional, not due. Nothing follows the slug when nothing resembles.',
    '',
    fence(related),
    '',
    '## Batch: written, one warning line',
    '',
    '`batch` never refuses: a save must not fail on a near-match. The warning follows the `Batch complete` line.',
    '',
    fence(batch.join('\n')),
    '',
  ].join('\n')
}

/** The vault path the bare render shows in place of the fixture's. */
const SHOWN_VAULT = '/home/ana/vault'

/** The four `onboard` renders: the hook's `--block` form on a folder one
 * entity matches, on one two match and on a git folder none matches; the bare form on a home with nothing
 * installed and Codex found; step 6 on an empty vault; the teaching lines;
 * `--cloud`, with the paragraph the cloud Block adds. */
async function renderOnboard(root: string, vault: string, severalCwd: string): Promise<string> {
  const home = join(root, 'home')
  mkdirSync(join(home, '.config', 'hafez'), { recursive: true })
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.config', 'hafez', 'vault'), `${vault}\n`)
  const oneCwd = join(root, 'work', 'auth-refactor')
  mkdirSync(oneCwd, { recursive: true })
  mkdirSync(severalCwd, { recursive: true })
  const gitCwd = join(root, 'work', 'invoice-exporter')
  mkdirSync(gitCwd)
  execFileSync('git', ['init', '-q'], { cwd: gitCwd, stdio: 'pipe' })
  const empty = join(root, 'empty-vault')
  mkdirSync(join(empty, 'entities'), { recursive: true })
  mkdirSync(join(empty, 'knowledge'))

  const hook = async (cwd: string) => {
    const out = await cmdOnboard(['--block'], { home, env: {}, cwd })
    if (out === null) throw new Error('onboard --block printed nothing')
    return out.replace(/\n$/, '')
  }
  const claude = { CLAUDECODE: '1' }
  const teaching = ITEMS.teachingLines.render({ harness: 'claude-code', mode: 'always-on' })
  const line2 = ITEMS.teachingLines.render({ harness: 'claude-code', mode: 'invoke-only', line2Only: true })
  const bare = (await cmdOnboard([], { home, env: claude, vaultFlag: vault }) as string)
    .replace(vault, SHOWN_VAULT)
    .replace(`\`\`\`\`\n${renderBlock()}\`\`\`\``, '(the Block)')
    .replace(`Always-on:\n\n${teaching}\n\nInvoke-only, line 2:\n\n${line2}`, '(the teaching lines)')
  const seeding = /^## \d+\. Seed the vault\n[\s\S]*?(?=\n\n## )/m.exec(await cmdOnboard([], { home, env: claude, vaultFlag: empty }) as string)
  if (!seeding) throw new Error('onboard on an empty vault has no seeding step')

  return [
    'Four renders from `hafez onboard`. Each fenced block is one complete output.',
    '',
    '## `hafez onboard --block` (what the SessionStart hook prints)',
    '',
    'One line per entity matching the folder, never the Block: the instructions file already carries it. The folder is the working directory, its git root, and, in a linked worktree, the main repository\'s root; each is matched exactly, and no directory in between is tried.',
    '',
    fence(await hook(oneCwd), '````'),
    '',
    'Several matches, all printed, active first; an entity with no description gets its slug alone:',
    '',
    fence(await hook(severalCwd), '````'),
    '',
    'No match in a git folder that is not the vault\'s own checkout: one line asking for `--resource .` on the next write to the entity whose work lives there. No match outside git, or in the vault\'s checkout: nothing.',
    '',
    fence(await hook(gitCwd), '````'),
    '',
    '## `hafez onboard` (status, then the script the agent follows)',
    '',
    fence(bare, '````'),
    '',
    'Step 6 on an empty vault:',
    '',
    fence(seeding[0], '````'),
    '',
    '## Teaching lines',
    '',
    'Line 1 carries the keystroke of the harness `onboard` ran in: `/hafez-save` on Claude Code, `$hafez-save` on Codex. The Block names the skill and never the keystroke, because one instruction file can serve two harnesses.',
    '',
    'Always-on:',
    '',
    fence(teaching),
    '',
    'Invoke-only, line 2:',
    '',
    fence(line2),
    '',
    '## `hafez onboard --cloud --vault-repo ana/vault` (the setup script for Claude Code cloud sessions)',
    '',
    fence(cmdOnboard(['--cloud', '--vault-repo', 'ana/vault'], { home, env: {} }) as string, '````'),
    '',
    'The Block its install line writes is the Block in `block.md` with the repo in its begin marker and one paragraph more, after the first:',
    '',
    fence([renderBlock('ana/vault').split('\n')[0], '…', renderBlock('ana/vault').split('\n\n')[2], '…'].join('\n')),
    '',
  ].join('\n')
}

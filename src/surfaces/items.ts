// src/surfaces/items.ts
//
// The typed Item table of the Agent Contract (docs/agent-contract/README.md,
// ADR 0001). One Item per row of the contract's owner table: each carries its
// Owner, at most one declared fallback, its Invoke-only behaviour, an evidence
// pointer, and its own text (placed by a static Surface) or a render function
// for what the binary computes. Two Items carry neither: the session log on
// update is behaviour, and `schema` output is the Op Spec's own rendering. Surfaces compose Items in
// surfaces.ts; nothing instructional is written anywhere else.
//
// Edit an Item here, then re-render: `npx tsx scripts/render-surfaces.ts`.

import {
  CONFIDENCE_LEVELS,
  ENTITY_STATUSES,
  ENTITY_TYPES,
  PLAN_STATUSES,
  SESSION_LOG_TYPES,
  WRITE_LINE_FIELDS,
  getContract,
  statusesFor,
  footerForm,
  type DocTarget,
  type WriteLineField,
} from '../contracts.js'
import { renderActionHandles } from '../document.js'
import { slugify } from '../vault.js'
import type { ActionAge } from '../stale.js'
import type { Workstream } from '../workstream.js'
import type { KnowledgeSubtype, UpdateFields, UpdateResult } from '../types.js'
import { ONBOARD_HARNESSES, type OnboardHarness } from '../harness.js'
import type { Mode } from '../cli/install.js'

/** Every Surface the contract names. The static ones are composed in
 * surfaces.ts; the binary ones are command output, rendered at run time. */
export type SurfaceId =
  | 'block'
  | 'hafezSkillDescription'
  | 'hafezSkillBody'
  | 'hafezSaveDescription'
  | 'hafezSaveBody'
  | 'read'
  | 'readHeader'
  | 'readFooter'
  | 'readMiss'
  | 'updateSuccess'
  | 'updateMisuse'
  | 'createKnowledge'
  | 'digestError'
  | 'batchMisuse'
  | 'mechanised'
  | 'schema'
  | 'onboard'

/** Places another Item inside this one's text, counted against the same Surface. */
export type Place = (id: string) => string

/** What a static Surface is composed for. `vaultRepo`: the Block for a cloud
 * container, whose vault is that GitHub repo (#160). */
export interface SurfaceCtx {
  vaultRepo?: string
}

export interface Item {
  /** The Item's row text in the owner table. */
  label: string
  owner: SurfaceId
  /** A declared second placement, for agents whose Owner is absent. */
  fallback?: SurfaceId
  /** The owner table's Invoke-only column. */
  invokeOnly: string
  /** The audit row, field count or ticket that earns the Item its place. */
  evidence: string
  /** Static text. A function form may place nested Items, and may give the
   * fallback a shorter form than the Owner. */
  text?: string | ((place: Place, at: 'owner' | 'fallback', ctx: SurfaceCtx) => string)
  /** What the binary computes: for Items owned by command output, and for a
   * static Item a binary Surface places filled in (the create line in the
   * `read` miss). */
  render?: (input: never) => string
}

const fence = (body: string) => '```\n' + body + '\n```'
const oneOf = (values: readonly string[]) => `<${values.join('|')}>`

/** A value as one shell word: bare when nothing in it is special, otherwise
 * double-quoted with `\ " $ `` escaped. `always` quotes plain words too. */
const shellArg = (value: string, always = false): string =>
  !always && /^[\w.,:@/=+-]+$/.test(value) ? value : `"${value.replace(/[\\"$`]/g, '\\$&')}"`

/** An existing note a Near-match names. */
export interface NearMatchNote {
  slug: string
  name: string
  description?: string | null
  subtype: KnowledgeSubtype
}

/** An entity matching the working folder, as `onboard --block` names it. */
export interface FolderMatch {
  slug: string
  description: string | null
}

/** The three outputs of the Near-match Item: the `create knowledge` refusal
 * (the message the error line carries), the relate line printed after a
 * written note's slug, and `batch`'s warning line. */
export type NearMatchRender =
  | {
    form: 'refusal'
    name: string
    /** The flags the create was given, in order: `[flag]` for a switch. */
    flags: [flag: string, value?: string][]
    /** The text passed as `--synthesis`, offered as evidence. */
    evidence?: string
    matches: NearMatchNote[]
  }
  | { form: 'relate'; slug: string; related: string[]; resembles: string[] }
  | { form: 'batchWarning'; index: number; name: string; matches: string[] }

// The create line is spelled out here; the update lines are Write Lines.
function renderNearMatch(input: NearMatchRender): string {
  if (input.form === 'relate') {
    return `Optional, it resembles ${input.resembles.join(', ')}: ${updateLine(input.slug, { related: [...input.related, ...input.resembles] })}`
  }
  if (input.form === 'batchWarning') {
    return `Warning: op[${input.index}] create knowledge ${shellArg(input.name, true)} near-matches ${input.matches.join(', ')}; batch writes it anyway.`
  }
  const { name, flags, evidence, matches } = input
  const one = matches.length === 1
  const matchLine = (m: NearMatchNote) => m.subtype === 'plan'
    ? updateLine(m.slug, { status: oneOf(PLAN_STATUSES) })
    : updateLine(m.slug, { add_evidence: evidence ?? '<evidence>' })
  const createLine = [
    `hafez create knowledge ${shellArg(name, true)}`,
    ...flags.map(([flag, value]) => value === undefined ? `--${flag}` : `--${flag} ${shellArg(value)}`),
    '--new',
  ].join(' ')
  return [
    `${shellArg(name, true)} near-matches ${one ? 'an existing knowledge note' : `${matches.length} existing knowledge notes`}. Nothing was written.`,
    '',
    one ? 'Use it instead:' : 'Use one of them instead:',
    ...matches.flatMap(m => [
      '',
      `${m.name} (${m.slug})${m.description ? `: ${m.description}` : ''}`,
      fence(matchLine(m)),
    ]),
    '',
    'A different note after all: create it anyway.',
    fence(createLine),
  ].join('\n')
}

// --- The Write Line and the read Footer ---

/** Update fields whose value is free text: their flag quotes it. Every other
 * value is a slug, Handle, enum or placeholder, written bare. */
const TEXT_FIELDS = new Set<keyof UpdateFields>(['brief', 'current_state', 'add_action', 'add_evidence', 'add_source', 'synthesis'])

/** `hafez update <slug>` with one flag per field, in field order: the batch
 * field with dashes; the log is type and summary in one value plus `--body`
 * (its agent is detected, never shown); the action list repeats its flag;
 * other lists are comma-joined. */
function updateLine(slug: string, fields: Record<string, unknown>): string {
  const flag = (field: string, value: string) =>
    `--${field.replace(/_/g, '-')} ${TEXT_FIELDS.has(field as keyof UpdateFields) ? shellArg(value, true) : value}`
  const flags = Object.entries(fields).flatMap(([field, value]) => {
    if (field === 'session_log') {
      const log = value as { type: string; summary: string; body?: string }
      return [`--log ${shellArg(`${log.type}: ${log.summary}`, true)}`, ...(log.body ? [`--body ${shellArg(log.body, true)}`] : [])]
    }
    if (field === 'add_actions') return (value as string[]).map(v => flag('add_action', v))
    return [flag(field, Array.isArray(value) ? value.join(',') : String(value))]
  })
  return [`hafez update ${slug}`, ...flags].join(' ')
}

/** What a `read` Footer is rendered from: the file it ends. */
export interface FooterInput {
  slug: string
  target: DocTarget
  /** The first open action's Handle; absent when no action is open. */
  handle?: string
  /** Who the session log entry names: detected from the Harness. */
  agent: string
}

/** The Footer's op as the batch object carries it: what `read --json` puts
 * under `writes`, and what the Write Line renders. */
export type FooterOp =
  | { op: 'update'; slug: string; fields: Partial<Record<WriteLineField, unknown>> }
  | { op: 'promote'; slug: string; target: string }

/** Each Footer field's placeholder. `undefined` leaves the field out. */
const PLACEHOLDERS: Record<WriteLineField, (input: FooterInput) => unknown> = {
  session_log: ({ agent }) => ({ type: oneOf(SESSION_LOG_TYPES), summary: '<one line>', body: '<detail>', agent }),
  complete_action: ({ handle }) => handle,
  remove_action: () => '<handle>',
  add_actions: () => ['<text>'],
  brief: () => '<text>',
  current_state: () => '<text>',
  related: () => ['<slug>'],
  parent: () => '<slug>',
  add_evidence: () => '<what you saw>',
  add_source: () => '<url or citation>',
  synthesis: () => '<the whole insight, rewritten>',
  confidence: () => oneOf(CONFIDENCE_LEVELS),
  domain: () => ['<domain>'],
  status: ({ target }) => oneOf(statusesFor(target)),
}

export function footerOp(input: FooterInput): FooterOp {
  const form = footerForm(input.target)
  if (form === 'capture') {
    return { op: 'promote', slug: input.slug, target: oneOf(getContract('capture').canPromoteTo) }
  }
  const fields: Partial<Record<WriteLineField, unknown>> = {}
  for (const field of WRITE_LINE_FIELDS[form]) {
    const value = PLACEHOLDERS[field](input)
    if (value !== undefined) fields[field] = value
  }
  return { op: 'update', slug: input.slug, fields }
}

/** The Footer: a blank line, a rule line, plain prose and one fenced block. */
function renderFooter(input: FooterInput): string {
  const op = footerOp(input)
  const [prose, line] = op.op === 'promote'
    ? ['A capture waits to be sorted. Once you can tell what it is, one command:', `hafez promote ${op.slug} ${op.target}`]
    : ['Write back with one command. Keep the flags you need, drop the rest:', updateLine(op.slug, op.fields)]
  return ['', '---', prose, '', fence(line)].join('\n')
}

// --- `update` output ---

type ChangePhrase = (f: UpdateFields, r: UpdateResult) => string | undefined

/** A field that is set or, given empty, cleared: `<name> set` / `<name> cleared`.
 * A field whose value appends says so (`resource added`). */
const setOrCleared = (field: keyof UpdateFields, name = field.replace(/_/g, ' '), verb = 'set'): ChangePhrase => f => {
  const value = f[field]
  if (value === undefined) return undefined
  return value === null || value === '' || (Array.isArray(value) && value.length === 0) ? `${name} cleared` : `${name} ${verb}`
}

/** `<n> action(s) <verb>` over a Next Actions field's one-line and array forms. */
function countPhrase(one: string | undefined, many: string[] | undefined, verb: string): string | undefined {
  const n = (one !== undefined ? 1 : 0) + (many?.length ?? 0)
  return n > 0 ? `${n} action${n === 1 ? '' : 's'} ${verb}` : undefined
}

/** What each update field did, for the success line; `null` for a field that
 * changes nothing of its own. Keyed by every update field, so a new field
 * without a phrase fails the build. Key order is the line's order: the
 * entity Footer's, then the rest. */
const CHANGE_PHRASES: Record<keyof UpdateFields, ChangePhrase | null> = {
  session_log: (_f, r) => r.logged ? 'log added' : undefined,
  clear_actions: f => f.clear_actions ? 'actions cleared' : undefined,
  complete_action: f => countPhrase(f.complete_action, f.complete_actions, 'ticked'),
  complete_actions: null, // counted with complete_action
  remove_action: f => countPhrase(f.remove_action, f.remove_actions, 'removed'),
  remove_actions: null, // counted with remove_action
  add_actions: f => countPhrase(f.add_action, f.add_actions, 'added'),
  add_action: null, // counted with add_actions
  brief: setOrCleared('brief'),
  current_state: f => f.current_state !== undefined ? 'current state set' : undefined,
  related: setOrCleared('related'),
  parent: f => f.parent !== undefined ? `parent set to ${f.parent}` : undefined,
  status: f => f.status !== undefined ? `status set to ${f.status}` : undefined,
  description: setOrCleared('description'),
  // A resource already held adds nothing, so nothing is named (#302).
  resource: (f, r) => r.resource_added ? (r.resource_added.length > 0 ? 'resource added' : undefined) : setOrCleared('resource', 'resource', 'added')(f, r),
  domain: setOrCleared('domain'),
  tags: setOrCleared('tags'),
  confidence: f => f.confidence !== undefined ? `confidence set to ${f.confidence}` : undefined,
  synthesis: f => f.synthesis !== undefined || f.insight !== undefined ? 'synthesis set' : undefined,
  insight: null, // the alias of synthesis
  add_evidence: f => f.add_evidence !== undefined ? 'evidence added' : undefined,
  add_source: f => f.add_source !== undefined ? 'source added' : undefined,
  agent: null, // names the log entry's agent
}

/** `Updated <slug>: <what changed>.` — one phrase per change, nothing else. */
function renderUpdateSummary({ slug, fields, result }: { slug: string; fields: UpdateFields; result: UpdateResult }): string {
  const phrases = Object.values(CHANGE_PHRASES).flatMap(phrase => phrase?.(fields, result) ?? [])
  return phrases.length > 0 ? `Updated ${slug}: ${phrases.join(', ')}.` : `Updated ${slug}.`
}

/** The suffix a Stale open line carries on `read`: its age, or that it is
 * undated. A fresh line carries none. */
function renderStaleMarker({ stale, age_days }: ActionAge): string {
  if (!stale) return ''
  return age_days === null ? ' · stale, undated' : ` · stale ${age_days}d`
}

/** The `read` header line naming the sessions that touched an entity, with
 * the look back from it. None: no line. */
function renderSessionsLine({ slug, count, latest }: { slug: string; count: number; latest: string | null }): string {
  if (count === 0) return ''
  return `sessions: ${count}${latest ? ` · latest ${latest}` : ''} · hafez query --kind session --related-to ${slug}`
}

/** The `read` header line naming an entity's archived log entries, with the
 * command that reads them. No archive: no line. */
function renderArchivePointer({ slug, entries }: { slug: string; entries: number }): string {
  if (entries === 0) return ''
  return `archive: ${entries} older log ${entries === 1 ? 'entry' : 'entries'} · hafez read ${slug} --archive`
}

/** A child as the `read` header shows it. */
export interface ChildLine { slug: string; description: string | null; open_actions: number; last_touched: string }

/** How many children the header lists; the rest are one overflow line. */
export const CHILDREN_SHOWN = 5

/** The `read` header's children block: the count line (children, open
 * actions across all of them), one `hafez read` line per child (description,
 * open count, last-touched day) for the first `CHILDREN_SHOWN`, and the
 * overflow line naming the query that lists the rest. Children arrive sorted
 * by last-touched descending. No children: no block. */
function renderChildrenBlock({ slug, children }: { slug: string; children: ChildLine[] }): string {
  if (children.length === 0) return ''
  const open = children.reduce((sum, c) => sum + c.open_actions, 0)
  const shown = children.slice(0, CHILDREN_SHOWN)
  const width = Math.max(...shown.map(c => c.slug.length))
  const lines = [`children: ${children.length} · ${open} open action${open === 1 ? '' : 's'}`]
  for (const c of shown) {
    const facts = [c.description, `${c.open_actions} open`, c.last_touched].filter(Boolean).join(' · ')
    lines.push(`  hafez read ${c.slug.padEnd(width)}  ${facts}`)
  }
  const rest = children.length - shown.length
  if (rest > 0) lines.push(`  … and ${rest} more · hafez query --parent ${slug}`)
  return lines.join('\n')
}

/** The `read` header's fact line for one unsplit prefix family (#230):
 * its open-line count and the family, and that no child carries it. A
 * fact, never a filled create line or a question. */
function renderWorkstreamLine({ prefix, open_actions }: Workstream): string {
  return `workstream: ${open_actions} open action${open_actions === 1 ? '' : 's'} with \`${prefix}\`; no child named it`
}

/** The line after an update's success while Stale lines remain on the entity. */
function renderStaleReminder({ handles }: { handles: string[] }): string {
  const n = handles.length
  return `${n} stale action${n === 1 ? '' : 's'} ${n === 1 ? 'remains' : 'remain'}: ${handles.join(', ')}. Tick what landed, drop what is dead.`
}

/** What a misuse retries from: the file's Footer, or the `read` miss when the
 * slug names no file. */
export type MisuseRetry = { footer: FooterInput } | { miss: { slug: string; closest: string[] } }

/** The error line stating nothing was written, any detail lines, then the
 * Footer (which brings its own blank line) or, after a blank line, the miss. */
function renderUpdateMisuse(input: { error: string; details?: string[] } & MisuseRetry): string {
  const error = /[.!?]$/.test(input.error) ? input.error : `${input.error}.`
  return [
    `Error: ${error} Nothing was written.`,
    ...(input.details ?? []).map(d => `  - ${d}`),
    'footer' in input ? ITEMS.writeLine.render(input.footer) : `\n${ITEMS.slugMissRecovery.render(input.miss)}`,
  ].join('\n')
}

const CREATE_TYPES: (typeof ENTITY_TYPES)[number][] = ['project', 'entity']
const RELATIONS = ['parent', 'related'] as const

/** The entity create line, one text everywhere: the Block, the skill body and
 * the `read` miss. `--parent` carries the placement rule in its placeholder
 * (#226, #230); at a miss with nothing read the agent drops it. `--resource`
 * carries its rule the same way (#219): the agent writes `.` when the folder
 * holds the work, which the binary resolves (#217), and drops the flag
 * otherwise, so a literal `.` is never copied blind. */
const createEntityLine = (name: string) =>
  `hafez create entity "${name}" --type ${oneOf(CREATE_TYPES)} --parent <slug you read, or its parent> --resource <. if the work lives in this folder> --description "<one sentence>" --brief "<where things stand>" --add-action "<next step>"`

const CREATE_LINES = fence([
  createEntityLine('<name>'),
  `hafez create knowledge "<name>" --synthesis "<the insight>" --confidence ${oneOf(CONFIDENCE_LEVELS)} --related <slug>`,
].join('\n'))

/** Step 3 of the onboard script: the exact entries that let `hafez` run and
 * write the vault without a prompt. Claude Code runs it from an allow entry;
 * Codex from a command rule, with the vault a writable root of the sandbox. */
function renderHarnessPermissions({ harness, vault }: { harness: OnboardHarness; vault: string }): string {
  const lead = 'A permission prompt on a hafez command means setup is unfinished.'
  if (harness === 'claude-code') {
    const { hooks, allowEntry } = ONBOARD_HARNESSES[harness]
    return `${lead} Show the user this entry, then add it to ~/${hooks} under permissions.allow:\n\n${JSON.stringify(allowEntry)}`
  }
  const { rules, rule, config } = ONBOARD_HARNESSES[harness]
  return [
    `${lead} Show the user these two entries, then add the first to ~/${rules}:`,
    '',
    rule,
    '',
    `and the second to ~/${config} under [sandbox_workspace_write], merged into any writable_roots already there:`,
    '',
    `writable_roots = [${JSON.stringify(vault)}]`,
  ].join('\n')
}

const TEACHING_LINE_2: Record<Mode, string> = {
  'always-on': '2. Hafez is always on: the agent loads your work at the start of a session and writes to the vault as work lands.',
  'invoke-only': '2. Hafez is invoke-only: nothing is loaded and nothing is written unless you ask. Say "read <name>" to load, "note this" to write.',
}

/** The four lines said to the user at hand-over, or line 2 alone. Line 1
 * carries the save keystroke of the Harness `onboard` ran in; line 2 is the
 * Mode. */
function renderTeachingLines({ harness, mode, line2Only = false }: { harness: OnboardHarness; mode: Mode; line2Only?: boolean }): string {
  if (line2Only) return TEACHING_LINE_2[mode]
  return [
    `1. Nothing saves itself. Run ${ONBOARD_HARNESSES[harness].keystroke} before you end a session.`,
    TEACHING_LINE_2[mode],
    '3. The agent writes without asking and tells you in one line. Every write is a git commit, so any of them can be undone.',
    '4. If a hafez command ever asks for permission, setup is unfinished: run `hafez onboard` again.',
  ].join('\n')
}

/** A GitHub `<owner>/<repo>`, as one shell word safe to print in a command
 * and to name a directory by: not `.` or `..`, not a clone URL's `.git`. */
export const isVaultRepo = (value: string): boolean =>
  /^[A-Za-z0-9-]+\/[\w.-]+$/.test(value) && !/\/\.\.?$/.test(value) && !value.endsWith('.git')

/** Where a cloud container clones a repo attached to the session. */
const CLOUD_HOME = '/home/user'
const repoName = (vaultRepo: string) => vaultRepo.slice(vaultRepo.indexOf('/') + 1)

/** The Block's self-heal rule in a cloud container: a session started without
 * the vault attached attaches, clones and registers it (verified, #160). */
function renderCloudVault(vaultRepo: string): string {
  const path = `${CLOUD_HOME}/${repoName(vaultRepo)}`
  return `If \`hafez init\` shows no registered vault: attach \`${vaultRepo}\` to this session (add_repo, push access), clone it to ${path}, run \`hafez init --register ${path}\`, then continue. Never create a throwaway vault.`
}

/** `onboard --cloud`: the cloud environment's setup script. It cannot clone
 * (it runs without GitHub credentials) and no step may fail session start: a
 * failed install exits 0, leaving a session without Hafez rather than none. */
function renderCloudSetup({ vaultRepo }: { vaultRepo: string }): string {
  return [
    `Each Claude Code cloud session is a fresh container: no \`hafez\`, no vault, no Block. Paste this into the cloud environment's Setup script; the Trusted network policy is enough.`,
    '',
    fence([
      '#!/bin/bash',
      'npm install -g hafez --allow-scripts=better-sqlite3 || exit 0',
      `VAULT=${CLOUD_HOME}/${repoName(vaultRepo)}`,
      'if [ -d "$VAULT/.git" ]; then',
      '  hafez init --register "$VAULT"',
      'fi',
      `hafez onboard --install --mode always-on --harness claude-code --vault-repo ${vaultRepo} || true`,
    ].join('\n')),
    '',
    `Attach ${vaultRepo} when you start a session, with push access, and the script registers it. The script cannot clone it: it runs without GitHub credentials. A session started without it attached is told by the Block to attach, clone and register it.`,
  ].join('\n')
}

const BATCH_EXAMPLE_OP = '{"op":"create","kind":"entity","name":"Token Rotation","fields":{"type":"entity"}}'

export const ITEMS = {
  loadTriggers: {
    label: 'Load triggers: read the best guess, create when there is no entity, load nothing when nothing is named',
    owner: 'block',
    invokeOnly: 'absent',
    evidence: 'L1, M1',
    text: 'At the start of a session, if the first message or the working folder names a piece of work, run `hafez read <slug>` on your best guess at the slug before anything else. A miss prints the closest slugs: read the one that fits. The work has no entity: create one with the line below. Nothing is named: load nothing.',
  },
  slugMissRecovery: {
    label: 'Slug miss recovery',
    owner: 'readMiss',
    invokeOnly: 'same',
    evidence: 'L1; Codex corpus, 6 of 13 reads missed, none recovered',
    // The closest slugs read-ready, else the search line; then the create
    // line, named by the miss's slug words so it creates the slug it missed.
    render: ({ slug, closest }: { slug: string; closest: string[] }): string => {
      const name = slugify(slug).replace(/-/g, ' ')
      const miss = `Error: no entity or knowledge note '${slug}'.`
      // No word to search for or name a note by: the miss line alone.
      if (!name) return miss
      return [
        miss,
        ...(closest.length > 0 ? closest.map(s => `hafez read ${s}`) : [`hafez search "${name}"`]),
        ITEMS.createLines.render(name),
      ].join('\n')
    },
  },
  parentDescription: {
    label: 'Parent description',
    owner: 'readHeader',
    invokeOnly: 'same',
    evidence: 'L2',
    /** The `parent:` line's value: the slug, with the parent's description
     * in brackets when it has one. */
    render: ({ slug, description }: { slug: string; description: string | null }): string =>
      description ? `${slug} (${description})` : slug,
  },
  childrenBlock: {
    label: 'Children block: the Hub\'s children as read lines',
    owner: 'readHeader',
    invokeOnly: 'same',
    evidence: '#230',
    render: renderChildrenBlock,
  },
  workstreamLine: {
    label: 'Workstream fact line: an unsplit prefix family',
    owner: 'readHeader',
    invokeOnly: 'same',
    evidence: '#230',
    render: renderWorkstreamLine,
  },
  sessionsLine: {
    label: 'Sessions line: the look back from an entity',
    owner: 'readHeader',
    invokeOnly: 'same',
    evidence: '#35',
    render: renderSessionsLine,
  },
  archivePointer: {
    label: 'Archive pointer',
    owner: 'readHeader',
    invokeOnly: 'same',
    evidence: '#34',
    render: renderArchivePointer,
  },
  writeTriggers: {
    label: 'Write triggers: work landed, a split, decision made, a lesson, weighing, "note this"',
    owner: 'block',
    invokeOnly: 'absent',
    evidence: 'M11, M2, never-ask decision #42, decision-record miss #159; placement #226, #229',
    text: place => [
      '- Work landed (a commit, a merged PR, CI green): update the entity that owns the work. That is the entity you read; the entity you read has a child that owns it: write there; the work belongs to another: read that one first. The end of its `read` output shows the command.',
      '- A workstream your own actions or the user already name, too big for one action, gets a Child with that name under the entity you read: create it with `--parent`, move its open actions there (one `update` on the parent: `--remove-action` each, `--log "decision: split <child> out, open actions moved"`), and write there from now on.',
      '- A decision was made: one `decision` log entry, now, on the entity that owns the work. The repo keeps its own decisions record: write it there and the log entry points at it (`hafez update <slug> --log "decision: <one line>, see decisions.md"`).',
      `- A lesson that holds without this entity: create a knowledge note; what we chose is a decision entry, not a note. ${place('knowledgeBoundary')}`,
      '- The user says "note this" or "record that": write it.',
      `- You are weighing whether something is worth writing: write it, as knowledge with \`--confidence ${CONFIDENCE_LEVELS[0]}\`.`,
    ].join('\n'),
  },
  knowledgeBoundary: {
    label: 'Knowledge boundary',
    owner: 'block',
    invokeOnly: 'absent',
    evidence: 'M3',
    text: "An insight about this repo's code alone goes in the repo's own docs instead.",
  },
  neverAsk: {
    label: 'Never ask; the tell line',
    owner: 'block',
    fallback: 'hafezSkillBody',
    invokeOnly: 'via the skill body',
    evidence: 'audit §3',
    text: (_place, at) => 'Never ask the user whether to write to the vault. Write, then say so in one line naming the slug and what you did.'
      + (at === 'owner' ? ' Every write is a git commit and can be undone.' : ''),
  },
  readBeforeWrite: {
    label: 'Read before write-back',
    owner: 'block',
    fallback: 'hafezSkillBody',
    invokeOnly: 'via the skill body',
    evidence: 'makes the footer sufficient',
    text: 'Update only what you have read this session. Not read yet: read it first.',
  },
  oneCommand: {
    label: 'One command per write',
    owner: 'block',
    invokeOnly: 'absent',
    evidence: 'M8',
    text: 'One command per write.',
  },
  openActions: {
    label: 'Open actions are the agent\'s; stale lines are due',
    owner: 'block',
    fallback: 'hafezSkillBody',
    invokeOnly: 'via the skill body and the write reminder',
    evidence: 'M11',
    text: 'Open actions on an entity you read are yours: tick what landed, drop what is dead. Lines `read` marks stale are due.',
  },
  neverEditByHand: {
    label: 'Never edit vault files by hand',
    owner: 'block',
    invokeOnly: 'absent',
    evidence: 'help decision #49',
    text: 'Never edit vault files by hand.',
  },
  neverSaveUnprompted: {
    label: 'Never save unprompted',
    owner: 'block',
    invokeOnly: 'not applicable',
    evidence: 'D1, D8',
    text: 'Never save the session unprompted. The user saves with the `hafez-save` skill.',
  },
  createLines: {
    label: 'Create lines, their enums, plan, capture',
    owner: 'block',
    fallback: 'hafezSkillBody',
    invokeOnly: 'via the skill body',
    evidence: 'fields: kind/name 18, synthesis 16, subtype 15; --parent #230; --resource #219',
    text: CREATE_LINES + '\n\nA plan is `--subtype plan` without `--synthesis`. Cannot tell entity from knowledge: `hafez capture "<name>"`.',
    /** The entity create line for one name: what the `read` miss places. */
    render: createEntityLine,
  },
  writeLine: {
    label: 'Update field vocabulary, log type enum, the Write Line',
    owner: 'readFooter',
    fallback: 'updateMisuse',
    invokeOnly: 'same',
    evidence: 'fields: session_log 26, add_actions 27, complete_action 19, current_state 19, brief 14, related 14, remove_action 8',
    render: renderFooter,
  },
  handles: {
    label: 'Handles',
    owner: 'read',
    invokeOnly: 'same',
    evidence: 'M11: 131 ticks, 28 matched a line the agent had read',
    render: renderActionHandles,
  },
  staleMarker: {
    label: 'Stale marker',
    owner: 'read',
    invokeOnly: 'same',
    evidence: 'M11',
    render: renderStaleMarker,
  },
  staleReminder: {
    label: 'Stale reminder',
    owner: 'updateSuccess',
    invokeOnly: 'same',
    evidence: 'M11',
    render: renderStaleReminder,
  },
  updateSummary: {
    label: 'What an update changed, in one line: the tell line',
    owner: 'updateSuccess',
    invokeOnly: 'same',
    evidence: 'never-ask decision #42: one tell line per write',
    render: renderUpdateSummary,
  },
  updateMisuse: {
    label: 'The corrected shape after a misuse: nothing written, then the Footer',
    owner: 'updateMisuse',
    invokeOnly: 'same',
    evidence: '19 of 84 writes errored after reading the reference',
    render: renderUpdateMisuse,
  },
  sessionLogOnUpdate: {
    label: 'Session log on update',
    owner: 'mechanised',
    invokeOnly: 'same',
    evidence: 'M7',
  },
  nearMatch: {
    label: 'Near-match on create knowledge',
    owner: 'createKnowledge',
    invokeOnly: 'same',
    evidence: 'M4',
    render: renderNearMatch,
  },
  saveTrigger: {
    label: 'Save trigger',
    owner: 'hafezSaveDescription',
    invokeOnly: 'same',
    evidence: 'D1; 111 digest calls, 7 errors when invoked',
    text: 'Save this session to the Hafez vault. Use when the user invokes hafez-save or says "save", "save the session" or "wrap up". Never run it unprompted.',
  },
  saveMechanics: {
    label: 'Save mechanics: shape, date, known slugs, no-pipe form',
    owner: 'hafezSaveBody',
    invokeOnly: 'same',
    evidence: 'fields: digest keys 14 each; D2, D3, D4; harness research; #135',
    text: [
      '1. List the slugs you read, updated or created this session. Use only those; a slug you did not see in `hafez` output this session does not go in. No slugs: tell the user there is nothing to save and stop.',
      '2. Run this once, with today\'s date:',
      '',
      fence([
        "hafez digest --data '{",
        '  "entities_touched": ["<slug>", "<slug>"],',
        '  "decisions": ["<a decision made this session>"],',
        '  "narrative": "<one to three sentences: what happened and how it connects>",',
        '  "session_date": "<YYYY-MM-DD>"',
        "}' | hafez batch",
      ].join('\n')),
      '',
      'In the JSON, write each apostrophe as `’` (`isn’t`): a straight `\'` ends the quoted argument and the save fails.',
      '',
      'No pipe (PowerShell 5.1): put the JSON in `summary.json`, then `hafez digest --file summary.json > ops.json`, then `hafez batch --file ops.json`.',
      '',
      '3. Tell the user in one line: the session note\'s slug and the entities it logged to.',
      '',
      '`decisions` may be an empty array. Each slug in `entities_touched` gets a session log entry and the session note links them all. An unknown slug fails the save and names the slug: fix the list and run it again. A session already saved is skipped, so a second run does no harm.',
    ].join('\n'),
  },
  unknownSlugAtSave: {
    label: 'Unknown slug at save',
    owner: 'digestError',
    invokeOnly: 'same',
    evidence: 'D2',
    render: (slugs: readonly string[]) =>
      `Unknown slug${slugs.length === 1 ? '' : 's'} in entities_touched: ${slugs.map(s => `'${s}'`).join(', ')}. Nothing was saved: fix the list and run the save again.`,
  },
  find: {
    label: 'Find: query, search, stats',
    owner: 'hafezSkillBody',
    invokeOnly: 'same',
    evidence: 'help decision #49',
    text: fence([
      `hafez query --filter ${oneOf([...ENTITY_STATUSES, 'stale', 'capture'])}`,
      'hafez search "<terms>" --kind <entity|knowledge|session|all>',
      'hafez query --kind session --related-to <slug>',
      'hafez stats',
    ].join('\n'))
      + '\n\n`search` and `query` reach entities and knowledge notes; `--kind all` adds the session notes, `--kind session` lists them alone, newest first. `hafez read <slug> --archive` prints an entity\'s archived log entries.',
  },
  rareOps: {
    label: 'Rare ops: promote, link, unlink, status, delete, validate, health',
    owner: 'hafezSkillBody',
    invokeOnly: 'same',
    evidence: 'help decision #49; owner decision #43',
    text: fence([
      `hafez promote <slug> ${oneOf(getContract('capture').canPromoteTo)}`,
      `hafez link <slug> <target> --relation ${oneOf(RELATIONS)}`,
      `hafez unlink <slug> <target> --relation ${oneOf(RELATIONS)}`,
      `hafez update <slug> --status ${oneOf(ENTITY_STATUSES)}`,
      'hafez delete <slug>',
      'hafez validate',
      'hafez health',
    ].join('\n'))
      + `\n\nA plan's status is \`${PLAN_STATUSES.join('|')}\`. \`delete\` removes a knowledge or session note only; an entity is retired with \`--status done\`. \`health\` lists what placement would change and applies nothing.`,
  },
  healthProcedure: {
    label: 'Health procedure: run with --json, propose by kind, apply nothing unconfirmed',
    owner: 'hafezSkillBody',
    invokeOnly: 'same',
    evidence: '#248; health is agent input, the owner never reads the raw report',
    text: [
      'A vault check ("check the vault", "clean up the vault", "what has drifted"): run `hafez health --json` and bring back proposals grouped by kind, never the rows. In a session that read an entity, lead with that entity\'s rows; the rest of the vault as counts.',
      'One line per kind, with the count: the Workstreams to split (a `create entity … --parent` line each, named as the actions name it); the one-way edges and the unlinked mentions as one `hafez batch` of `link` ops, one commit; the restated decisions and the leakage pairs as a short list for the user to judge, nothing proposed.',
      'Apply nothing until the user confirms a kind, not even a `link` line that looks safe; then one `batch` per kind.',
    ].join('\n'),
  },
  batchShape: {
    label: 'Batch shape',
    owner: 'hafezSkillBody',
    fallback: 'batchMisuse',
    invokeOnly: 'same',
    evidence: 'M8; batch-examples needed by 73 write events; #145',
    // The fallback is the `batch` misuse error's tail: the shape alone, one op.
    text: (_place, at) => at === 'owner'
      ? [
        'Several writes that must land together go in one batch: a bare array, no wrapper. A slug is the name lowercased, apostrophes dropped, each other run of characters that are not letters or digits turned into one `-` and none left at either end, so a later op can name what an earlier one creates.',
        '',
        fence([
          "hafez batch --data '[",
          `  ${BATCH_EXAMPLE_OP},`,
          '  {"op":"link","slug":"token-rotation","target":"auth-refactor","relation":"parent"}',
          "]'",
        ].join('\n')),
        '',
        'In the JSON, write each apostrophe as `’` (`isn’t`): a straight `\'` ends the quoted argument and the batch fails.',
        '',
        'No pipe (PowerShell 5.1): `hafez batch --file ops.json`.',
      ].join('\n')
      : `A batch is a bare JSON array of ops, no wrapper:\n\n${fence(`[\n  ${BATCH_EXAMPLE_OP}\n]`)}`,
  },
  upgradeReconfigure: {
    label: 'Upgrade, reconfigure',
    owner: 'hafezSkillBody',
    invokeOnly: 'same',
    evidence: 'help decision #49; onboard decision #58',
    text: [
      '- Upgrade: `hafez upgrade`. It checks and prints, it never installs. Show the user the printed steps and run them only after a yes.',
      '- Set up or reconfigure: `hafez onboard`.',
    ].join('\n'),
  },
  opShape: {
    label: 'Machine-readable op shape',
    owner: 'schema',
    invokeOnly: 'same',
    evidence: 'help decision #49',
  },
  folderMatch: {
    label: 'The working folder is an entity: its read line, the Folder match, never the Block',
    owner: 'onboard',
    invokeOnly: 'not offered',
    evidence: 'L1; onboard decision #58',
    // Every match, in the order given (active first); the agent picks and reads.
    render: (matches: FolderMatch[]): string => [
      matches.length === 1
        ? 'This folder is a Hafez entity. Read it first:'
        : 'This folder matches several Hafez entities. Read the one that fits first:',
      ...matches.map(m => `hafez read ${m.slug}${m.description ? ` (${m.description})` : ''}`),
    ].join('\n'),
  },
  noMatchLine: {
    label: 'A git folder no entity matches: one line asking for `--resource .` on the write to the entity whose work lives here',
    owner: 'onboard',
    invokeOnly: 'not offered',
    evidence: '#217; v2 baseline, the hook read a line in 16 of 54 sessions, no create set resource',
    // The one line the hook prints in a git folder no entity matches (#307).
    render: (): string => 'No Hafez entity names this folder: add `--resource .` when you write to the entity whose work lives here.',
  },
  harnessPermissions: {
    label: 'Binary on the harness allowlist; vault path writable',
    owner: 'onboard',
    invokeOnly: 'same',
    evidence: 'never-ask decision #42; onboard decision #58',
    render: renderHarnessPermissions,
  },
  cloudVault: {
    label: 'Cloud session: no vault registered, attach the vault repo, clone, register',
    owner: 'block',
    invokeOnly: 'absent',
    evidence: '#160, verified 2026-10-16',
    // Placed only in a Block composed for a cloud container, whose begin
    // marker names the repo (renderBlock).
    text: (_place, _at, { vaultRepo = '<owner>/<repo>' }) => renderCloudVault(vaultRepo),
  },
  cloudSetup: {
    label: 'The cloud environment\'s setup script',
    owner: 'onboard',
    invokeOnly: 'not offered',
    evidence: '#160, verified 2026-10-16',
    render: renderCloudSetup,
  },
  teachingLines: {
    label: 'The four teaching lines (to the user, not the agent)',
    owner: 'onboard',
    invokeOnly: 'same, line 2 differs',
    evidence: 'onboard decision #58',
    render: renderTeachingLines,
  },
} satisfies Record<string, Item>

export type ItemId = keyof typeof ITEMS

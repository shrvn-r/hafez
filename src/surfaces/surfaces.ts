// src/surfaces/surfaces.ts
//
// Surfaces of the Agent Contract and how the static ones compose Items. A
// static Surface is text the binary writes out (the Block, the two skill
// files); a binary Surface is command output whose Items carry a render
// function. Every Surface has the label the owner table names it by.
//
// Hashes (onboard decision #58): first 12 hex of SHA-256. The Block's begin
// marker hashes the text between the marker lines; a skill file's `hash:`
// frontmatter line hashes everything after the closing `---`.

import { createHash } from 'crypto'
import { ITEMS, type FolderMatch, type Item, type ItemId, type SurfaceCtx, type SurfaceId } from './items.js'

export interface Surface<Id extends string = ItemId> {
  /** How the owner table names this Surface. */
  label: string
  /** Static Surfaces only: the text, built by placing Items. */
  compose?: (place: (id: Id) => string, ctx: SurfaceCtx) => string
}

export const SURFACES: Record<SurfaceId, Surface> = {
  block: {
    label: 'Block',
    compose: (place, { vaultRepo }) => [
      '## Hafez',
      '',
      'Hafez is this user\'s vault: what they are working on (entities) and what they have learned (knowledge). You reach it only through the `hafez` command.',
      '',
      ...(vaultRepo === undefined ? [] : [`**Cloud session.** ${place('cloudVault')}`, '']),
      `**Load.** ${place('loadTriggers')}`,
      '',
      '**Write as it happens.** Each of these is due the moment it occurs:',
      '',
      place('writeTriggers'),
      '',
      place('createLines'),
      '',
      '**Rules.**',
      '',
      `- ${place('neverAsk')}`,
      `- ${place('readBeforeWrite')}`,
      `- ${place('oneCommand')}`,
      `- ${place('openActions')}`,
      `- ${place('neverEditByHand')}`,
      `- ${place('neverSaveUnprompted')}`,
      '',
    ].join('\n'),
  },
  hafezSkillDescription: {
    label: '`hafez` skill description',
    compose: () => 'Hafez vault: the less common operations and the tool itself. Use when the user asks what is in the vault ("what am I working on?", "what\'s stale?"), wants to promote, link, unlink, delete, change a status or validate, asks to check the vault or clean it up, or wants to update or reconfigure Hafez ("upgrade hafez", "set up hafez"). Also the reference to read when no Hafez block is in your instructions.',
  },
  hafezSkillBody: {
    label: '`hafez` skill body',
    compose: place => [
      '',
      '# Hafez',
      '',
      '- Update an entity or note: `hafez read <slug>`. The end of its output shows the write command.',
      '- Create an entity or a knowledge note: the two `hafez create` lines below.',
      '- Save the session: the `hafez-save` skill. No skill: `hafez schema digest`.',
      '',
      place('neverAsk'),
      place('readBeforeWrite'),
      place('openActions'),
      '',
      '## Create',
      '',
      place('createLines'),
      '',
      '## Find',
      '',
      place('find'),
      '',
      '## Less common operations',
      '',
      place('rareOps'),
      '',
      place('healthProcedure'),
      '',
      `${place('batchShape')} Machine-readable shape of any op: \`hafez schema <op>\`, with \`--examples\` for a sample.`,
      '',
      '## The tool itself',
      '',
      place('upgradeReconfigure'),
      '',
    ].join('\n'),
  },
  hafezSaveDescription: {
    label: '`hafez-save` description',
    compose: place => place('saveTrigger'),
  },
  hafezSaveBody: {
    label: '`hafez-save` body',
    compose: place => ['', '# Save the session', '', place('saveMechanics'), ''].join('\n'),
  },
  read: { label: 'Binary: `read`' },
  readHeader: { label: 'Binary: `read` header' },
  readFooter: { label: 'Binary: `read` Footer' },
  readMiss: { label: 'Binary: `read` miss' },
  updateSuccess: { label: 'Binary: `update` success output' },
  updateMisuse: { label: 'Binary: `update` misuse error' },
  createKnowledge: { label: 'Binary: `create knowledge` output' },
  digestError: { label: 'Binary: `digest` error' },
  batchMisuse: { label: 'Binary: `batch` misuse error' },
  mechanised: { label: 'Binary, mechanised' },
  schema: { label: '`schema`' },
  onboard: { label: '`onboard`' },
}

/** Every context a static Surface is composed in: the default, and the
 * Block for a cloud container. */
const CONTEXTS: SurfaceCtx[] = [{}, { vaultRepo: '<owner>/<repo>' }]

export const contentHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 12)

/** Compose a static Surface, placing each Item's text in the form its role
 * (Owner or fallback) calls for. `onPlace` sees every placement, nested ones
 * included. */
function composeWith(
  items: Record<string, Item>,
  surfaceId: string,
  surface: Surface<string>,
  ctx: SurfaceCtx = {},
  onPlace: (id: string) => void = () => {},
): string {
  const place = (id: string): string => {
    onPlace(id)
    const item = items[id]
    if (!item) throw new Error(`${surfaceId} places unknown Item ${id}`)
    const text = item.text
    if (typeof text === 'function') return text(place, item.owner === surfaceId ? 'owner' : 'fallback', ctx)
    if (text === undefined) throw new Error(`${surfaceId} places ${id}, which has no text`)
    return text
  }
  if (!surface.compose) throw new Error(`${surfaceId} is not a static surface`)
  return surface.compose(place, ctx)
}

const compose = (id: SurfaceId, ctx: SurfaceCtx = {}) => composeWith(ITEMS, id, SURFACES[id] as Surface<string>, ctx)

/** An Item's text as a binary Surface places it at run time, in the form its
 * role there (Owner or fallback) calls for. */
export function placeIn(surfaceId: SurfaceId, id: ItemId): string {
  const item: Item = ITEMS[id]
  if (surfaceId !== item.owner && surfaceId !== item.fallback) {
    throw new Error(`${surfaceId} places ${id}, which is neither its owner nor its fallback`)
  }
  return composeWith(ITEMS, surfaceId, { label: SURFACES[surfaceId].label, compose: place => place(id) })
}

/** YAML folded scalar lines: greedy wrap at 76 columns, two-space indent. */
function fold(text: string): string {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && 2 + line.length + 1 + word.length > 76) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  lines.push(line)
  return lines.map(l => `  ${l}`).join('\n')
}

function skillFile(name: string, description: SurfaceId, body: SurfaceId): string {
  const text = compose(body)
  return `---\nname: ${name}\ndescription: >\n${fold(compose(description))}\nhash: ${contentHash(text)}\n---\n${text}`
}

/** The Block; with `vaultRepo`, the Block for a cloud container whose vault
 * is that repo. Its begin marker names the repo, so a check reads it from
 * there and never from the Block's wording, which a release may change. */
export function renderBlock(vaultRepo?: string): string {
  const inner = compose('block', { vaultRepo })
  const repo = vaultRepo === undefined ? '' : ` vault-repo=${vaultRepo}`
  return `<!-- hafez:begin ${contentHash(inner)}${repo} -->\n${inner}<!-- hafez:end -->\n`
}

/** `onboard --block`, what the SessionStart hook prints: the read line for
 * each entity matching the folder; with none, in a git folder other than the
 * vault's checkout (`unmatchedGitFolder`), the no-match line; else nothing.
 * Never the Block, which the instructions file already carries, compaction
 * included (#234). */
export function renderBlockHook(matches: FolderMatch[], unmatchedGitFolder: boolean): string {
  if (matches.length > 0) return `${ITEMS.folderMatch.render(matches)}\n`
  return unmatchedGitFolder ? `${ITEMS.noMatchLine.render()}\n` : ''
}

export const renderHafezSkill = (): string => skillFile('hafez', 'hafezSkillDescription', 'hafezSkillBody')

/** `help --agent`: the `hafez` skill body, the one text, without the blank
 * line that parts it from the skill file's frontmatter or the newline that
 * ends the file (the CLI adds one to every output). */
export const renderAgentHelp = (): string => compose('hafezSkillBody').replace(/^\n/, '').replace(/\n$/, '')

export const renderHafezSaveSkill = (): string => skillFile('hafez-save', 'hafezSaveDescription', 'hafezSaveBody')

// --- The owner table, rendered into a marked region of the contract README ---

export const OWNER_TABLE_BEGIN = '<!-- owner-table:begin (rendered from src/surfaces/items.ts; edit the Item, then run scripts/render-surfaces.ts) -->'
export const OWNER_TABLE_END = '<!-- owner-table:end -->'

export function renderOwnerTable(): string {
  const rows = Object.values(ITEMS).map((item: Item) => {
    const fallback = item.fallback ? SURFACES[item.fallback].label : '—'
    return `| ${item.label} | ${SURFACES[item.owner].label} | ${fallback} | ${item.invokeOnly} |`
  })
  return ['| Item | Owner | Fallback | Invoke-only |', '|---|---|---|---|', ...rows, ''].join('\n')
}

/** Replace the marked owner-table region of `doc` with a fresh render. */
export function spliceOwnerTable(doc: string): string {
  const begin = doc.indexOf(OWNER_TABLE_BEGIN)
  const end = doc.indexOf(OWNER_TABLE_END, begin)
  if (begin < 0 || end < 0) throw new Error('owner table markers missing or out of order')
  if (doc.indexOf(OWNER_TABLE_BEGIN, begin + 1) >= 0 || doc.indexOf(OWNER_TABLE_END, end + 1) >= 0) {
    throw new Error('owner table markers appear more than once')
  }
  return doc.slice(0, begin + OWNER_TABLE_BEGIN.length) + '\n' + renderOwnerTable() + doc.slice(end)
}

// --- Drift check 2: the typed Item table ---

/** Every problem with the Item table: an Item with no Owner or no evidence
 * pointer, an Item its Owner or static fallback never places in any context, or one placed more
 * than once in a Surface or in a Surface that is neither its Owner nor its declared fallback.
 * Placement is checked for static Surfaces only; binary ones place at run time. */
export function itemProblems(items: Record<string, Item>, surfaces: Record<string, Surface<string>>): string[] {
  const problems: string[] = []
  // Per Surface, the most times each Item is placed in one of its contexts.
  const placed: Record<string, Record<string, number>> = {}
  for (const [sid, surface] of Object.entries(surfaces)) {
    if (!surface.compose) continue
    const most: Record<string, number> = (placed[sid] = {})
    for (const ctx of CONTEXTS) {
      const counts: Record<string, number> = {}
      try {
        composeWith(items, sid, surface, ctx, id => { counts[id] = (counts[id] ?? 0) + 1 })
      } catch (err) {
        if (!problems.includes((err as Error).message)) problems.push((err as Error).message)
      }
      for (const [id, n] of Object.entries(counts)) most[id] = Math.max(most[id] ?? 0, n)
    }
  }
  for (const [id, item] of Object.entries(items)) {
    if (!item.owner) problems.push(`${id}: no owner`)
    else if (!surfaces[item.owner]) problems.push(`${id}: unknown owner ${item.owner}`)
    if (item.fallback && !surfaces[item.fallback]) problems.push(`${id}: unknown fallback ${item.fallback}`)
    if (!item.evidence?.trim()) problems.push(`${id}: no evidence pointer`)
    for (const [sid, counts] of Object.entries(placed)) {
      const n = counts[id] ?? 0
      if (n > 0 && sid !== item.owner && sid !== item.fallback) {
        problems.push(`${id}: placed in ${sid}, which is neither its owner nor its fallback`)
      }
      if (n > 1) problems.push(`${id}: placed ${n} times in ${sid}`)
    }
    if (item.owner && surfaces[item.owner]?.compose && !placed[item.owner]?.[id]) {
      problems.push(`${id}: not placed in its owner ${item.owner}`)
    }
    if (item.fallback && surfaces[item.fallback]?.compose && !placed[item.fallback]?.[id]) {
      problems.push(`${id}: not placed in its fallback ${item.fallback}`)
    }
  }
  return problems
}

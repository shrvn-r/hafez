// src/cli/commands.ts
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { helpIfAsked, parseArgs, splitList, str, MisuseError, RenderedError, UnknownFlagError, UsageError, type FlagSpec, type FlagValue } from './args.js'
import type { Hafez, ReadDepth, UpdateFields, UpdateResult, EntityType, QueryFilter, ConfidenceLevel, KnowledgeSubtype, CreateEntityFields, CreateKnowledgeFields, BatchOperation, KnowledgeQueryOpts, QueryResult, KnowledgeQueryResult, SessionQueryResult, SearchKind, UnifiedResult, GraphLayer } from '../types.js'
import { HafezError } from '../types.js'
import { BatchOperationSchema, normalizeAliases, opErrorLine, batchInvalidHeader, clearsBesideValue, RESOURCE_CLEAR_REASON } from '../batch-ops.js'
import { formatBatchError } from './batch-errors.js'
import { parseDigestInput, digest } from '../digest.js'
import { detectAgent } from '../harness.js'
import { resemblances } from '../near-match.js'
import { actionAge, staleHandles, stalenessDaysOf } from '../stale.js'
import { slugify } from '../vault.js'
import { resolveDot } from '../resource.js'
import { GRAPH_LAYERS } from '../contracts.js'
import { ITEMS, type MisuseRetry, type NearMatchNote } from '../surfaces/items.js'
import { footerFor, pointersFor, readJsonOf } from '../read-json.js'
import { placeIn } from '../surfaces/surfaces.js'
import { formatEntityHeader, formatKnowledgeHeader, formatSessionHeader, formatQueryTable, formatKnowledgeTable, formatSessionTable, formatSearchResults, formatValidation, formatHealth, formatStats, formatChangelog } from './format.js'

export interface CommandOpts {
  json?: boolean
  /** Resolved vault path — for handlers that read the vault directly
   * (export) rather than through the Hafez instance. */
  vaultPath?: string
  /** The folder `--resource .` names (#306); `process.cwd()` when unset. */
  cwd?: string
}

function jsonOut(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

const READ_USAGE = 'Usage: hafez read <slug> [--depth frontmatter|summary|full] [--archive]'
const READ_FLAGS: FlagSpec = { depth: 'string', archive: 'boolean' }

export async function cmdRead(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags, positionals } = parseArgs(args, READ_FLAGS, READ_USAGE)
  const slug = positionals[0]
  if (!slug) throw new UsageError(READ_USAGE)
  const depth = (str(flags.depth) ?? 'summary') as ReadDepth
  const result = await os.read(slug, depth).catch(err => { throw readMiss(err, slug, opts) })
  if (flags.archive) {
    // The archive is an entity's: reached from it on purpose (#34).
    if (result.kind !== 'entity') throw new UsageError(`--archive reads an entity's archived log entries; '${slug}' is a ${result.kind === 'session' ? 'session note' : 'knowledge note'}\n${READ_USAGE}`)
    const archive = await os.archive(slug)
    if (opts.json) return jsonOut({ slug, archive })
    return archive ?? `no archive for ${slug}`
  }
  if (opts.json) return jsonOut(await readJsonOf(os, slug, depth, result))
  // A session note is read, never written: no Footer (#35).
  if (result.kind === 'session') return formatSessionHeader(result.frontmatter, result.body)
  // The Footer and the pointers are the same at every depth: they read the
  // whole file, not the body this depth shows.
  const whole = depth === 'full' ? result : await os.read(slug, 'full') as typeof result
  const footer = footerFor(slug, whole)
  const pointers = whole.kind === 'entity' ? await pointersFor(os, slug, whole.body) : null
  const fm = result.frontmatter as Record<string, any>
  const days = stalenessDaysOf(fm)
  const staleMark = (added: string | null) => ITEMS.staleMarker.render(actionAge(added, days))
  const text = result.kind === 'entity'
    ? formatEntityHeader(fm, ITEMS.handles.render(result.body, staleMark), await parentLine(os, fm.parent), [
      ITEMS.childrenBlock.render({ slug, children: pointers!.children }),
      ...pointers!.workstreams.map(w => ITEMS.workstreamLine.render(w)),
      ITEMS.sessionsLine.render({ slug, ...pointers!.sessions }),
      ITEMS.archivePointer.render({ slug, entries: pointers!.archive_entries }),
    ].filter(Boolean))
    : formatKnowledgeHeader(fm, result.body)
  // Trailing newlines only: the Footer brings its own blank line.
  return `${text.replace(/\n+$/, '')}\n${ITEMS.writeLine.render(footer)}`
}

/** A `read` miss as the CLI renders it: the closest slugs on stderr (`--json`:
 * `{slug, closest}` on stdout), exit 1. Any other error passes through. */
function readMiss(err: unknown, slug: string, opts: CommandOpts): unknown {
  if (!(err instanceof HafezError) || err.code !== 'NOT_FOUND') return err
  const closest = err.details ?? []
  return opts.json
    ? new RenderedError('NOT_FOUND', jsonOut({ slug, closest }), 'stdout')
    : new RenderedError('NOT_FOUND', ITEMS.slugMissRecovery.render({ slug, closest }), 'stderr')
}

/** The `parent:` line's value: the slug with the parent's description. The
 * one thing `read` takes from another file; a parent that cannot be read
 * (a broken slug) is named by its slug alone. */
async function parentLine(os: Hafez, parent: string | undefined): Promise<string | undefined> {
  if (!parent) return undefined
  const description = await os.read(parent, 'frontmatter')
    .then(file => (file.frontmatter as { description?: string | null }).description ?? null)
    .catch(() => null)
  return ITEMS.parentDescription.render({ slug: parent, description })
}

/** The Handles of the Stale lines an entity holds after a write; none for a
 * knowledge note. Best-effort: the write is committed, so a failed read here
 * drops the reminder rather than failing the update. */
async function staleAfterWrite(os: Hafez, slug: string): Promise<string[]> {
  try {
    const file = await os.read(slug, 'full')
    return file.kind === 'entity' ? staleHandles(file.body, file.frontmatter) : []
  } catch {
    return []
  }
}

const QUERY_USAGE = `Usage: hafez query [--kind entity|knowledge|session|all] [--filter ...] [--type t] [--parent slug] [--related-to slug] [--domain d] [--confidence c] [--subtype s] [--tag t] [--since d] [--before d] [--created-since d] [--created-before d] [--sort-by f] [--sort-order asc|desc] [--limit n] [--offset n]

  --filter active|paused|done matches entity status; knowledge and session
  notes carry no status, so under --kind all they are always included
  alongside the matching entities. --filter stale|capture are entity-only
  views and return no knowledge. --filter/--type/--parent are rejected with
  --kind knowledge, and --confidence/--subtype are rejected with --kind
  entity, rather than being silently dropped. --kind session lists session
  notes newest first and takes the time window, sort and paging flags only.
  --related-to takes --kind to narrow to one kind and no other query flag.`
const QUERY_FLAGS: FlagSpec = {
  kind: 'string', filter: 'string', type: 'string', parent: 'string', 'related-to': 'string',
  domain: 'string', confidence: 'string', subtype: 'string', tag: 'string',
  since: 'string', before: 'string', 'created-since': 'string', 'created-before': 'string',
  'sort-by': 'string', 'sort-order': 'string', limit: 'string', offset: 'string',
}

/** Every flag the query parser accepts, for the branch-support matrix. */
export const QUERY_FLAG_NAMES = Object.keys(QUERY_FLAGS)

export type QueryBranch = 'entity' | 'knowledge' | 'session' | 'all' | 'related-to'

/** Which flags each kind branch actually applies. A branch that cannot honour
 * a flag rejects it (below) instead of dropping it: `--kind knowledge --filter
 * stale` used to return every knowledge note with exit 0, and `--confidence`
 * never reached an entity query at all. */
export const QUERY_FLAG_SUPPORT: Record<QueryBranch, readonly string[]> = {
  entity: ['kind', 'filter', 'type', 'parent', 'domain', 'tag', 'since', 'before', 'created-since', 'created-before', 'sort-by', 'sort-order', 'limit', 'offset'],
  knowledge: ['kind', 'domain', 'confidence', 'subtype', 'tag', 'since', 'before', 'created-since', 'created-before', 'sort-by', 'sort-order', 'limit', 'offset'],
  session: ['kind', 'since', 'before', 'created-since', 'created-before', 'sort-by', 'sort-order', 'limit', 'offset'],
  all: ['kind', 'filter', 'type', 'parent', 'domain', 'confidence', 'subtype', 'tag', 'since', 'before', 'created-since', 'created-before', 'sort-by', 'sort-order', 'limit', 'offset'],
  'related-to': ['related-to', 'kind'],
}

const FLAG_SCOPE_REASON: Record<string, string> = {
  filter: 'it selects entity status (or the entity-only stale/capture views); knowledge notes carry no status',
  type: 'entity types only',
  parent: 'entity hierarchy only',
  confidence: 'knowledge notes only',
  subtype: 'knowledge notes only',
}

const QUERY_KINDS = ['entity', 'knowledge', 'session', 'all'] as const

function rejectUnsupportedFlags(branch: QueryBranch, flags: Record<string, FlagValue>): void {
  const supported = new Set(QUERY_FLAG_SUPPORT[branch])
  for (const [name, value] of Object.entries(flags)) {
    if (value === undefined || supported.has(name)) continue
    const where = branch === 'related-to'
      ? 'with --related-to (it returns every entity, knowledge note and session note linked to the slug)'
      : `with --kind ${branch}`
    const scope = branch === 'session' && (name === 'domain' || name === 'tag') ? 'a session note carries none' : FLAG_SCOPE_REASON[name]
    const reason = scope ? ` — ${scope}` : ''
    throw new UsageError(`--${name} is not supported ${where}${reason}\n${QUERY_USAGE}`)
  }
}

/** Paging flags reach SQL as text — parse them strictly here so `--limit abc`
 * is a usage error rather than a prepare-time SqliteError. */
function intFlag(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${name} must be a non-negative integer (got "${raw}")\n${QUERY_USAGE}`)
  return Number(raw)
}

export async function cmdQuery(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags } = parseArgs(args, QUERY_FLAGS, QUERY_USAGE)
  const relatedTo = str(flags['related-to'])
  const kindFlag = str(flags.kind)
  const branch: QueryBranch = relatedTo !== undefined ? 'related-to' : (kindFlag ?? 'entity') as QueryBranch
  if (kindFlag !== undefined && !QUERY_KINDS.includes(kindFlag as any)) {
    throw new UsageError(`--kind must be one of ${QUERY_KINDS.join(', ')} (got "${kindFlag}")\n${QUERY_USAGE}`)
  }
  rejectUnsupportedFlags(branch, flags)

  const filter = (str(flags.filter) ?? 'active') as QueryFilter
  const type = str(flags.type) as EntityType | undefined
  const parent = str(flags.parent)
  const domain = str(flags.domain)
  const confidence = str(flags.confidence) as ConfidenceLevel | undefined
  const subtype = str(flags.subtype) as KnowledgeSubtype | undefined
  const since = str(flags.since)
  const before = str(flags.before)
  const createdSince = str(flags['created-since'])
  const createdBefore = str(flags['created-before'])
  const tagRaw = str(flags.tag)
  const tags = tagRaw ? tagRaw.split(',').map(t => t.trim()).filter(Boolean) : undefined
  const sortBy = str(flags['sort-by']) as any
  const sortOrder = str(flags['sort-order']) as 'asc' | 'desc' | undefined
  const limit = intFlag(str(flags.limit), 'limit')
  const offset = intFlag(str(flags.offset), 'offset')

  const sortOpts = { sort_by: sortBy, sort_order: sortOrder, limit, offset }
  const timeOpts = { since, before, createdSince, createdBefore }

  // --related-to: every kind linked to the slug, the sessions that touched
  // an entity included; --kind narrows to one (the entity header's
  // `--kind session --related-to` line)
  if (relatedTo) {
    const linked = await os.related_to(relatedTo)
    const items = kindFlag && kindFlag !== 'all' ? linked.items.filter(i => i.kind === kindFlag) : linked.items
    const result = { items, total: items.length }
    if (opts.json) return jsonOut(result)
    return formatUnifiedSections(result.items, result.total)
  }

  const queryOpts = { filter, type, parent, domain, ...timeOpts, tags, ...sortOpts }

  // --kind knowledge: query knowledge only. The time window applies here too —
  // knowledge rows carry created (and last-touched once updated).
  if (branch === 'knowledge') {
    const kOpts: KnowledgeQueryOpts = { domain: domain ?? undefined, confidence, subtype, ...timeOpts, tags, ...sortOpts }
    const result = await os.query_knowledge(kOpts)
    if (opts.json) return jsonOut(result)
    return formatKnowledgeTable(result.items, result.total)
  }

  // --kind session: the session notes alone, newest first
  if (branch === 'session') {
    const result = await os.query_sessions({ ...timeOpts, ...sortOpts })
    if (opts.json) return jsonOut(result)
    return formatSessionTable(result.items, result.total)
  }

  // --kind all: every kind via the unified query, sessions included
  if (branch === 'all') {
    const result = await os.queryUnified({ ...queryOpts, kind: 'all', confidence, subtype })
    if (opts.json) return jsonOut(result)
    return formatUnifiedSections(result.items, result.total)
  }

  // --kind entity (default): query entities
  const result = await os.query(queryOpts)
  if (opts.json) return jsonOut(result)
  return formatQueryTable(result.items, result.total)
}

/** One section per kind present, in the order entities, knowledge,
 * sessions; a page line when the page is short of the total. */
function formatUnifiedSections(items: UnifiedResult[], total: number): string {
  const entities = items.filter((i): i is UnifiedResult & { kind: 'entity' } => i.kind === 'entity')
  const knowledge = items.filter((i): i is UnifiedResult & { kind: 'knowledge' } => i.kind === 'knowledge')
  const sessions = items.filter((i): i is UnifiedResult & { kind: 'session' } => i.kind === 'session')
  const sections: string[] = []
  if (entities.length > 0) sections.push('## Entities\n\n' + formatQueryTable(entities as QueryResult[]))
  if (knowledge.length > 0) sections.push('## Knowledge\n\n' + formatKnowledgeTable(knowledge as KnowledgeQueryResult[]))
  if (sessions.length > 0) sections.push('## Sessions\n\n' + formatSessionTable(sessions as SessionQueryResult[]))
  if (items.length < total) sections.push(`\nShowing ${items.length} of ${total}`)
  return sections.length > 0 ? sections.join('\n\n') : 'No results.'
}

const SEARCH_USAGE = `Usage: hafez search <terms> [--kind entity|knowledge|session|all]

  Without --kind, entities and knowledge notes are searched. --kind all adds
  the session notes; --kind session searches them alone.`
const SEARCH_FLAGS: FlagSpec = { kind: 'string' }
const SEARCH_KINDS = ['entity', 'knowledge', 'session', 'all'] as const

export async function cmdSearch(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags, positionals } = parseArgs(args, SEARCH_FLAGS, SEARCH_USAGE)
  const terms = positionals.join(' ')
  if (!terms) throw new UsageError(SEARCH_USAGE)
  const kind = str(flags.kind) as SearchKind | undefined
  if (kind !== undefined && !SEARCH_KINDS.includes(kind)) {
    throw new UsageError(`--kind must be one of ${SEARCH_KINDS.join(', ')} (got "${kind}")\n${SEARCH_USAGE}`)
  }
  const results = await os.search(terms, kind)
  if (opts.json) return jsonOut(results)
  return formatSearchResults(results)
}

/** Flags whose value is a comma list, on create and update alike. */
const LIST_FLAGS = new Set(['domain', 'related', 'tags'])

/** The Write Line grammar, one mapper for create and update: every provided
 * flag → its field, the flag name with dashes as underscores. A comma-list
 * flag is split; a `clearable` flag maps `""` to null (its clear signal); a
 * repeatable flag given once is its own field (`--add-action` → `add_action`)
 * and given more than once is the array form of that field (`add_actions`),
 * so each repeat appends. Which fields a target accepts is the Op Spec's
 * call, not the CLI's — the strict shape does all accepting and rejecting.
 * Only provided flags are included: a present-but-undefined key would trip
 * that same strict shape. */
function flagFields(
  spec: FlagSpec,
  flags: Record<string, FlagValue>,
  opts: { skip?: Set<string>; clearable?: Set<string> } = {},
): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  for (const flag of Object.keys(spec)) {
    const raw = flags[flag]
    if (raw === undefined || opts.skip?.has(flag)) continue
    const field = flag.replace(/-/g, '_')
    if (Array.isArray(raw)) {
      if (raw.length === 1) fields[field] = raw[0]
      else fields[`${field}s`] = raw
    } else if (typeof raw === 'boolean') fields[field] = raw
    else if (LIST_FLAGS.has(flag)) fields[field] = splitList(raw)
    else fields[field] = raw === '' && opts.clearable?.has(flag) ? null : raw
  }
  return fields
}

/** Repeat flags whose every value goes to the one field, a list when
 * repeated (never the `<field>s` array form): create and update alike.
 * flagFields skips them; each command maps them itself. */
export const ONE_FIELD_REPEATS = new Set(['resource'])

/** `--resource`'s values as the `resource` field, appended by the library.
 * `""` alone is the clear signal (null: update clears, create writes none);
 * `""` beside a value is the Op Spec's misuse, caught here as a usage error.
 * Each `.` is the command's folder, resolved here: the library rejects a
 * literal `.` (#306). */
function resourceField(given: string[], cwd: string): string | string[] | null {
  if (clearsBesideValue(given)) throw new UsageError(`--resource "": ${RESOURCE_CLEAR_REASON}`)
  const values = given.map(v => v === '.' ? resolveDot(cwd) : v)
  if (values.length > 1) return values
  return values[0] === '' ? null : values[0]
}

// --status is knowledge/plan only, and --purpose needs --type project: a field
// whose section the chosen template lacks is rejected, never silently dropped.
const CREATE_USAGE = 'Usage: hafez create <entity|knowledge> <name> [options]\n  entity:    --type <capture|entity|project> [--purpose text (project only)] [--brief text] [--add-action text (repeats)] …\n  knowledge: [--subtype <insight|plan>] [--status <active|done> (plan only)] [--synthesis text (insight only)] [--confidence <observation|pattern|principle>] [--new (write despite a near-match)] …'
/** Exported so tests can assert the flag × kind matrix is exhaustive. */
export const CREATE_FLAGS: FlagSpec = {
  type: 'string', purpose: 'string', description: 'string', resource: 'repeat',
  domain: 'string', parent: 'string', related: 'string', tags: 'string',
  brief: 'string', 'add-action': 'repeat',
  subtype: 'string', synthesis: 'string', insight: 'string', confidence: 'string',
  // knowledge, plan subtype only — insights have no lifecycle
  status: 'string',
  // knowledge only: write despite a Near-match. Not a field of any shape.
  new: 'boolean',
}

/** Every knowledge note, with its subtype, for the Near-match check. */
async function knowledgeNotes(os: Hafez): Promise<NearMatchNote[]> {
  const plans = new Set((await os.query_knowledge({ subtype: 'plan' })).items.map(n => n.slug))
  return (await os.query_knowledge()).items.map(n => ({
    slug: n.slug, name: n.name, description: n.description, subtype: plans.has(n.slug) ? 'plan' : 'insight',
  }))
}

/** The parsed flags as `[flag, value?]` pairs, in the order first given,
 * for echoing a create line back. */
function echoFlags(flags: Record<string, FlagValue>): [string, string?][] {
  return Object.entries(flags).flatMap(([flag, value]): [string, string?][] =>
    value === true ? [[flag]]
      : Array.isArray(value) ? value.map(v => [flag, v] as [string, string])
        : typeof value === 'string' ? [[flag, value]] : [])
}

/** `batch`'s Near-match warnings (#60): a save never fails on one, so they
 * only warn. Each create is judged against the vault plus the batch's
 * earlier creates. */
async function nearMatchWarnings(os: Hafez, operations: BatchOperation[]): Promise<string[]> {
  if (!operations.some(op => op.op === 'create' && op.kind === 'knowledge')) return []
  const seen = await knowledgeNotes(os)
  return operations.flatMap((op, index) => {
    if (op.op !== 'create' || op.kind !== 'knowledge') return []
    const { near } = resemblances(op.name, seen)
    seen.push({ slug: slugify(op.name), name: op.name, subtype: op.fields?.subtype ?? 'insight' })
    return near.length > 0
      ? [ITEMS.nearMatch.render({ form: 'batchWarning', index, name: op.name, matches: near.map(n => n.slug) })]
      : []
  })
}

export async function cmdCreate(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags, positionals } = parseArgs(args, CREATE_FLAGS, CREATE_USAGE)
  const kind = positionals[0]
  if (!kind) throw new UsageError(CREATE_USAGE)

  const name = positionals.slice(1).join(' ')
  if (!name) throw new UsageError(`Usage: hafez create ${kind} <name> [options]`)

  if (flags.new !== undefined && kind !== 'knowledge') {
    throw new UsageError('--new is for create knowledge only: it writes a note despite a near-match')
  }

  // Kind-agnostic on purpose: the per-kind hand-filter this replaced
  // discarded whatever its branch didn't name (--brief on knowledge,
  // --subtype on entity) and still exited 0 with the value nowhere on disk.
  const fields = flagFields(CREATE_FLAGS, flags, { skip: new Set(['new', ...ONE_FIELD_REPEATS]) })
  // `""` reaches the library as given: no value on an entity, a field a
  // knowledge note rejects.
  if (Array.isArray(flags.resource)) fields.resource = resourceField(flags.resource, opts.cwd ?? process.cwd()) ?? ''

  if (kind === 'entity') {
    // The only per-kind rule the CLI still owns: --type is required, and a
    // missing one deserves better than a shape error naming a JSON field.
    if (fields.type === undefined) throw new UsageError('--type is required for entity creation')
    const slug = await os.create('entity', name, fields as unknown as CreateEntityFields)
    return opts.json ? jsonOut({ slug }) : slug
  }

  if (kind === 'knowledge') {
    // --insight passes through untouched: the Op Spec normalizes the alias
    // (and drops it when --synthesis is also given). On entity it stays
    // `insight` and the kind gate rejects it. --status flows through the
    // same way; the subtype-aware gate accepts it on plans only.
    const knowledgeFields = fields as unknown as CreateKnowledgeFields
    const { near, weak } = resemblances(name, await knowledgeNotes(os))
    // Near-match (#60): refuse unless --new, handing back the update line.
    // Only a create that would otherwise be written: an invalid one, or an
    // exact slug collision, gets its own error rather than a --new line that
    // would fail the same way.
    if (near.length > 0 && flags.new === undefined
      && (await os.validateBatch([{ op: 'create', kind: 'knowledge', name, fields: knowledgeFields }])).valid) {
      throw new HafezError('SLUG_EXISTS', ITEMS.nearMatch.render({
        form: 'refusal', name, flags: echoFlags(flags), matches: near,
        evidence: str(flags.synthesis) ?? str(flags.insight),
      }))
    }
    const slug = await os.create('knowledge', name, knowledgeFields)
    if (opts.json) return jsonOut({ slug })
    const related = knowledgeFields.related ?? []
    const resembles = [...near, ...weak].map(n => n.slug).filter(r => !related.includes(r)).slice(0, 3)
    if (resembles.length === 0) return slug
    return `${slug}\n${ITEMS.nearMatch.render({ form: 'relate', slug, related, resembles })}`
  }

  throw new UsageError(`Unknown kind: ${kind}. Use entity or knowledge.`)
}

const UPDATE_USAGE = 'Usage: hafez update <slug> [--brief text] [--description text] [--resource uri-or-path (repeats; "" clears)] [--add-action text (repeats)] [--complete-action handle-or-text (repeats)] [--remove-action handle-or-text (repeats)] [--clear-actions] [--status <active|paused|done>] [--parent slug] [--log "<progress|decision|blocker|research>: summary" [--body text]]'
/** Exported so tests can assert the table covers the update schema. */
export const UPDATE_FLAGS: FlagSpec = {
  status: 'string', 'current-state': 'string', brief: 'string',
  'add-action': 'repeat', 'complete-action': 'repeat', 'remove-action': 'repeat',
  'clear-actions': 'boolean', parent: 'string',
  description: 'string', resource: 'repeat', domain: 'string', confidence: 'string',
  tags: 'string', related: 'string', insight: 'string', synthesis: 'string',
  'add-evidence': 'string', 'add-source': 'string', agent: 'string',
  // Composed, not mapped: --log "type: summary" plus --body (and --agent, when
  // given) build session_log.
  log: 'string', body: 'string',
  // Removed flag, declared so it fails with guidance instead of a generic
  // unknown-flag error: older installed skills/scripts still pass it, and
  // "Updated <slug>" with the action discarded is a false success.
  'next-action': 'string',
}

/** Flags where an empty string is the clear signal — exactly the nullable
 * fields of the update shape. Every other flag passes its value through
 * untouched, so `--status ""` reaches the enum and is rejected by name
 * instead of silently no-opping (which is how it read before: the guard
 * each flag got was an accident of which one was typed). */
const UPDATE_CLEARABLE_FLAGS = new Set(['brief', 'description', 'resource'])

/** Flags the generic loop skips because they are not a field of the update
 * shape — each is hand-handled in cmdUpdate. */
export const UPDATE_SPECIAL_FLAGS = new Set(['log', 'body', 'next-action'])

/** Update-shape fields with no flag of their own, and why. The exhaustiveness
 * test consults this, so a gap here is a stated decision rather than the
 * silent hole `add_actions` was. */
export const UPDATE_FIELDS_WITHOUT_FLAGS: Record<string, string> = {
  session_log: 'composed by --log "type: summary" (+ --body, --agent), never passed raw',
}

export async function cmdUpdate(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  // Every Write Line names the slug first, so a misuse that stops the parse
  // part-way is still reported against it.
  let slug = args[0]?.startsWith('--') ? undefined : args[0]
  let fields: UpdateFields
  let result: UpdateResult
  try {
    ({ slug, fields } = parseUpdate(args, opts.cwd ?? process.cwd()))
    result = await os.update(slug, fields)
  } catch (err) {
    throw await updateFailure(os, slug, err, opts)
  }
  if (opts.json) return jsonOut({ slug, ...result })
  const summary = ITEMS.updateSummary.render({ slug, fields, result })
  const stale = await staleAfterWrite(os, slug)
  return stale.length > 0 ? `${summary}\n${ITEMS.staleReminder.render({ handles: stale })}` : summary
}

/** The update's argv as its slug and fields: the Write Line grammar. */
function parseUpdate(args: string[], cwd: string): { slug: string; fields: UpdateFields } {
  const { flags, positionals } = parseArgs(args, UPDATE_FLAGS, UPDATE_USAGE)
  const slug = positionals[0]
  if (!slug) throw new UsageError(UPDATE_USAGE)

  if (flags['next-action'] !== undefined) {
    throw new UsageError('--next-action was removed in v1.0.2. Use --add-action (and --clear-actions) instead.')
  }

  // --insight is the declared alias; the Op Spec normalizes it (and drops it
  // when --synthesis is also given).
  const fields = flagFields(UPDATE_FLAGS, flags, { skip: new Set([...UPDATE_SPECIAL_FLAGS, ...ONE_FIELD_REPEATS]), clearable: UPDATE_CLEARABLE_FLAGS })
  if (Array.isArray(flags.resource)) fields.resource = resourceField(flags.resource, cwd)

  // The one genuinely CLI-owned convenience: session_log is a nested object,
  // so the flag pair composes it rather than naming a field. Without --log,
  // the Spine adds the entry itself and --agent rides along as `agent`.
  const log = str(flags.log)
  const body = str(flags.body)
  if (body !== undefined && log === undefined) {
    throw new UsageError('--body is the detail of a session log entry and needs --log "type: summary"')
  }
  if (log !== undefined) {
    const colonIdx = log.indexOf(':')
    if (colonIdx === -1) throw new UsageError('--log format: "type: summary". Types: progress, decision, blocker, research')
    fields.session_log = {
      type: log.slice(0, colonIdx).trim(),
      summary: log.slice(colonIdx + 1).trim(),
      ...(body !== undefined && { body }),
      agent: fields.agent ?? detectAgent(),
    }
    delete fields.agent
  }
  // An update that names nothing to change would print a success line that
  // names nothing either.
  if (Object.keys(fields).length === 0) throw new UsageError('update needs at least one flag')
  return { slug, fields: fields as UpdateFields }
}

/** What a failed update reports (Agent Contract: a misuse returns the
 * corrected shape). A misuse — a usage error or a write the Op Spec rejected —
 * says nothing was written, then gives the Footer `read` shows for the slug;
 * a slug that names no file gets the `read` miss instead. Anything else, and
 * any failure with no slug to report against, passes through unchanged. */
async function updateFailure(os: Hafez, slug: string | undefined, err: unknown, opts: CommandOpts): Promise<unknown> {
  const misuse = err instanceof UsageError
    ? { error: err instanceof UnknownFlagError ? `update has no flag --${err.flag}` : err.reason }
    : err instanceof HafezError && err.code === 'VALIDATION_FAILED' ? { error: err.message, details: err.details }
      : undefined
  const missing = err instanceof HafezError && err.code === 'NOT_FOUND'
  // Under --json only the miss has a machine form (read's); a misuse's
  // Footer is prose, so the error passes through as it always has.
  if (slug === undefined || (!misuse && !missing) || (opts.json && misuse)) return err
  let retry: MisuseRetry
  try {
    const file = await os.read(slug, 'full')
    // The Op Spec resolves no session note, so the update missed; the slug
    // names one all the same. Say what it is instead of offering a Footer
    // it will never have.
    if (file.kind === 'session') {
      return new RenderedError('VALIDATION_FAILED', `'${slug}' is a session note: written once and read, never updated. What matters from it belongs on the entity it touched.`, 'stderr')
    }
    retry = { footer: footerFor(slug, file) }
  } catch (readErr) {
    if (!(readErr instanceof HafezError) || readErr.code !== 'NOT_FOUND') return err
    retry = { miss: { slug, closest: readErr.details ?? [] } }
  }
  if (misuse) return new RenderedError('VALIDATION_FAILED', ITEMS.updateMisuse.render({ ...misuse, ...retry }), 'stderr')
  if (!('miss' in retry)) return err
  return opts.json
    ? new RenderedError('NOT_FOUND', jsonOut(retry.miss), 'stdout')
    : new RenderedError('NOT_FOUND', ITEMS.slugMissRecovery.render(retry.miss), 'stderr')
}

const LINK_FLAGS: FlagSpec = { relation: 'string' }

function parseLinkArgs(args: string[], verb: 'link' | 'unlink'): { slug: string; target: string; relation: string } {
  const usage = `Usage: hafez ${verb} <slug> <target> --relation <parent|related>`
  const { flags, positionals } = parseArgs(args, LINK_FLAGS, usage)
  const relation = str(flags.relation)
  const [slug, target] = positionals
  if (!slug || !target || !relation) {
    throw new UsageError(usage)
  }
  if (!['parent', 'related'].includes(relation)) {
    throw new UsageError(`Invalid relation: ${relation}. Must be parent or related.`)
  }
  return { slug, target, relation }
}

export async function cmdLink(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { slug, target, relation } = parseLinkArgs(args, 'link')
  await os.link(slug, target, relation as any)
  return opts.json ? jsonOut({ slug, target, relation }) : `Linked ${slug} → ${target} (${relation})`
}

export async function cmdUnlink(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { slug, target, relation } = parseLinkArgs(args, 'unlink')
  await os.unlink(slug, target, relation as any)
  return opts.json ? jsonOut({ slug, target, relation }) : `Unlinked ${slug} — ${target} (${relation})`
}

/** Top-level capture command — aligns the CLI verb with the batch op name. */
const CAPTURE_USAGE = 'Usage: hafez capture <name> [--notes "text"]'
const CAPTURE_FLAGS: FlagSpec = { notes: 'string' }

export async function cmdCapture(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags, positionals } = parseArgs(args, CAPTURE_FLAGS, CAPTURE_USAGE)
  const name = positionals.join(' ')
  if (!name) throw new UsageError(CAPTURE_USAGE)
  const notes = str(flags.notes)
  const slug = await os.capture(name, notes)
  return opts.json ? jsonOut({ slug }) : slug
}

const PROMOTE_USAGE = 'Usage: hafez promote <slug> <entity|project|knowledge>'

export async function cmdPromote(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { positionals } = parseArgs(args, {}, PROMOTE_USAGE)
  const [slug, target] = positionals
  if (!slug || !target) throw new UsageError(PROMOTE_USAGE)
  // Target validity is core's rule (contract canPromoteTo) — no CLI re-check.
  await os.promote(slug, target as any)
  if (opts.json) return jsonOut({ slug, target })
  return `Promoted ${slug} → ${target}`
}

const DELETE_USAGE = 'Usage: hafez delete <slug>  (knowledge and session notes only — retire an entity with `hafez update <slug> --status done`)'

export async function cmdDelete(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { positionals } = parseArgs(args, {}, DELETE_USAGE)
  if (positionals.length !== 1) throw new UsageError(DELETE_USAGE)
  const [slug] = positionals
  // What may be deleted (not an entity, nothing linking to it) is core's rule.
  const kind = await os.delete(slug)
  return opts.json ? jsonOut({ slug, kind }) : `Deleted ${slug} (${kind})`
}

export async function cmdValidate(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  helpIfAsked(args, 'Usage: hafez validate')
  const report = await os.validate()
  if (opts.json) return jsonOut(report)
  return formatValidation(report)
}

export async function cmdHealth(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  helpIfAsked(args, 'Usage: hafez health  (what placement would change; applies nothing)')
  const report = await os.health()
  if (opts.json) return jsonOut(report)
  return formatHealth(report)
}

const GRAPH_USAGE = "Usage: hafez graph [slug] [--port N] [--no-open]  (serve the vault's graph on 127.0.0.1 and open it in the browser; a slug opens it focused on that note)\n       hafez graph --json [--layers tag,domain,session]  (the vault's structure as {nodes, edges})"
const GRAPH_FLAGS: FlagSpec = { layers: 'string', port: 'string', 'no-open': 'boolean' }

/** The local-graph depth `hafez graph <slug>` opens at (#256). */
const GRAPH_FOCUS_DEPTH = 2

export async function cmdGraph(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags, positionals } = parseArgs(args, GRAPH_FLAGS, GRAPH_USAGE)
  if (positionals.length > 1) throw new UsageError(GRAPH_USAGE)
  const slug = positionals[0]
  if (!opts.json) {
    if (flags.layers !== undefined) throw new UsageError('--layers requires --json', GRAPH_USAGE)
    // A miss fails as `read` does, before any server starts.
    if (slug !== undefined) await os.read(slug, 'frontmatter').catch(err => { throw readMiss(err, slug, opts) })
    return serveGraph(opts.vaultPath!, flags, slug)
  }
  if (slug !== undefined) throw new UsageError('a slug opens the page focused on it; --json prints the whole Graph', GRAPH_USAGE)
  if (flags.port !== undefined || flags['no-open']) throw new UsageError('--port and --no-open serve the page; --json prints the Graph and exits', GRAPH_USAGE)
  const layers = splitList(flags.layers)
  const unknown = layers?.find(l => !(GRAPH_LAYERS as readonly string[]).includes(l))
  if (unknown !== undefined) throw new UsageError(`Unknown layer: ${unknown}. Valid layers: ${GRAPH_LAYERS.join(', ')}`, GRAPH_USAGE)
  return jsonOut(await os.graph(layers ? { layers: layers as GraphLayer[] } : undefined))
}

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

/** `hafez graph` without --json: serve the page until Ctrl-C or SIGTERM, then close the
 * server and the index. The server gets its own instance whose reads trust the
 * index: it syncs the index when its poll sees a commit (#271). */
async function serveGraph(vaultPath: string, flags: Record<string, FlagValue>, focus: string | undefined): Promise<string> {
  const portFlag = str(flags.port)
  if (portFlag !== undefined && !(/^\d+$/.test(portFlag) && Number(portFlag) <= 65535)) {
    throw new UsageError(`--port takes a port number (0-65535), got "${portFlag}"`, GRAPH_USAGE)
  }
  const port = portFlag === undefined ? undefined : Number(portFlag)
  const { startGraphServer, DEFAULT_PORT } = await import('../graph/server.js')
  const { createInternalHafez } = await import('../internal.js')
  const os = createInternalHafez({ vaultPath, git: { push: false }, indexSync: 'manual' })
  const server = await startGraphServer({ os, port }).catch(err => {
    os.close()
    if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || port === undefined) throw err
    throw new UsageError(`port ${port} is in use: pick another with --port, or leave it off for the first free port from ${DEFAULT_PORT}`)
  })
  // The page reads its view from the URL: a focus opens local-graph mode around it.
  const url = focus === undefined ? server.url : `${server.url}/?focus=${encodeURIComponent(focus)}&depth=${GRAPH_FOCUS_DEPTH}`
  process.stdout.write(`Serving the graph at ${url}  (Ctrl-C to stop)\n`)
  if (!flags['no-open']) (await import('../graph/open.js')).openBrowser(url)
  // SIGTERM (a supervisor's kill) stops it as Ctrl-C does, so the index is
  // closed either way (#280). A second signal during the close is not caught.
  await new Promise<void>(resolve => {
    const stop = () => {
      for (const signal of STOP_SIGNALS) process.off(signal, stop)
      resolve()
    }
    for (const signal of STOP_SIGNALS) process.on(signal, stop)
  })
  await server.close()
  return 'Graph server stopped.'
}

export async function cmdIndexRebuild(os: Hafez): Promise<string> {
  await os.rebuildIndex()
  return 'Index rebuilt.'
}

export async function cmdSync(os: Hafez, args: string[]): Promise<string> {
  helpIfAsked(args, 'Usage: hafez sync  (pull remote changes, push local commits)')
  const result = await os.sync()
  if (!result.remote) return 'No remote configured — vault is local-only. Every write is already committed to git.'
  if (result.pulled && result.pushed) return 'Synced: pulled remote changes and pushed local commits.'
  if (result.pulled) return 'Synced: pulled remote changes.'
  if (result.pushed) return 'Synced: pushed local commits.'
  return 'Already up to date.'
}

export async function cmdStats(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  helpIfAsked(args, 'Usage: hafez stats')
  const stats = await os.stats()
  if (opts.json) return jsonOut(stats)
  return formatStats(stats)
}

const CHANGELOG_USAGE = 'Usage: hafez changelog --since <date|relative>\nExamples: --since 2026-03-20, --since 7.days.ago, --since 1.week.ago'
const CHANGELOG_FLAGS: FlagSpec = { since: 'string' }

export async function cmdChangelog(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags } = parseArgs(args, CHANGELOG_FLAGS, CHANGELOG_USAGE)
  const since = str(flags.since)
  if (!since) throw new UsageError(CHANGELOG_USAGE)
  const entries = await os.changelog(since)
  if (opts.json) return jsonOut(entries)
  return formatChangelog(entries)
}

// --- Batch ---

// All enums are built from contracts.ts tuples so help-renderer, file validators,
// and CLI-input validator share a single source of truth — drift is structurally
// impossible (the Op Spec table in batch-ops.ts is the only consumer).
// Every z.object(...) is .strict() — unknown keys become `unrecognized_keys` issues
// (not silently dropped), which is load-bearing for the error-formatter's did-you-mean
// hints and for catching typos like `{"kind": "parent"}` on a link op.

export function parseBatchInput(json: string): BatchOperation[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new HafezError('VALIDATION_FAILED', 'Invalid JSON input for batch')
  }

  if (!Array.isArray(parsed)) {
    throw new HafezError('VALIDATION_FAILED', 'Batch input must be a JSON array')
  }

  if (parsed.length === 0) {
    throw new HafezError('VALIDATION_FAILED', 'Batch input must not be empty')
  }

  // Multi-error collect: iterate every op, accumulate formatted failure blocks,
  // throw once at the end with all N errors. Zero ops apply if any fail.
  const operations: BatchOperation[] = []
  const failureBlocks: string[] = []

  for (let i = 0; i < parsed.length; i++) {
    const raw = parsed[i] as Record<string, unknown>

    // Deprecated op: synthesize a failure block so it joins the multi-error
    // array rather than short-circuiting.
    if (raw?.op === 'reinforce') {
      const slugPart = raw.slug ? String(raw.slug) : '...'
      failureBlocks.push(
        [
          `[index ${i}] op=reinforce`,
          `  field: op`,
          `  issue: "reinforce" is deprecated`,
          `  use:   {"op": "update", "slug": "${slugPart}", "fields": {"add_evidence": "your evidence"}}`,
          `  tip: run \`hafez schema update\` for the full field list`,
        ].join('\n'),
      )
      continue
    }

    const result = BatchOperationSchema.safeParse(raw)
    if (!result.success) {
      failureBlocks.push(formatBatchError(result.error.issues, i, raw))
      continue
    }
    const op = result.data as Record<string, unknown> & { fields?: Record<string, unknown> }
    // Alias normalization is the Op Spec's (normalizeAliases) — the CLI just
    // hands back canonical ops so `batch --dry-run` output names real fields.
    operations.push(normalizeAliases(op) as BatchOperation)
  }

  if (failureBlocks.length > 0) {
    throw new HafezError('VALIDATION_FAILED', batchInvalidHeader(failureBlocks.length, parsed.length), failureBlocks)
  }

  return operations
}

// --file payload reader. Exists because Windows PowerShell 5.1 cannot pipe
// stdin to native executables — the documented pipe idiom fails there, so a
// file is the portable session-end path. PowerShell's own redirection writes
// UTF-16LE (and other tools write BOM'd UTF-8), so decode both rather than
// trading the pipe footgun for an encoding one.
function readPayloadFile(path: string): string {
  let buf: Buffer
  try {
    buf = readFileSync(path)
  } catch {
    throw new HafezError('VALIDATION_FAILED', `Cannot read --file: ${path}`)
  }
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^\uFEFF/, '')
  return buf.toString('utf-8').replace(/^\uFEFF/, '')
}

// The payload as one argument. Exists because Codex runs a command outside its
// sandbox (where the vault's .git is writable) only when every stage of a pipe
// matches an allow rule: `hafez digest --data '…' | hafez batch` does, an `echo`
// stage does not.
function readPayload(flags: { data?: FlagValue; file?: FlagValue }, usage: string): Promise<string> | string {
  const data = str(flags.data)
  const file = str(flags.file)
  if (data !== undefined && file !== undefined) throw new UsageError(`--data and --file are two ways to pass one payload; give one.\n${usage}`)
  if (data !== undefined) return data
  return file ? readPayloadFile(file) : readStdin()
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', chunk => { data += chunk })
    process.stdin.on('end', () => resolve(data))
    process.stdin.on('error', reject)
  })
}

/** Each `.` in a create entity or update op's `resource` (a string or in a
 * list) resolved against `cwd`, before the shape check, which rejects a
 * literal `.` (#306): the payload with them resolved, and one line per `.`
 * for `--dry-run` to show. A payload that is not a JSON array is returned as
 * given, for parseBatchInput to report. */
function resolveBatchDots(input: string, cwd: string): { input: string; resolved: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    return { input, resolved: [] }
  }
  if (!Array.isArray(parsed)) return { input, resolved: [] }
  const resolved: string[] = []
  parsed.forEach((op, i) => {
    const fields = op?.fields
    if (!(op?.op === 'update' || (op?.op === 'create' && op.kind === 'entity')) || !fields || typeof fields !== 'object') return
    const dot = (v: unknown): unknown => {
      if (v !== '.') return v
      const value = resolveDot(cwd)
      resolved.push(`op[${i}] resource . → ${value}`)
      return value
    }
    if (Array.isArray(fields.resource)) fields.resource = fields.resource.map(dot)
    else fields.resource = dot(fields.resource)
  })
  return resolved.length > 0 ? { input: JSON.stringify(parsed), resolved } : { input, resolved }
}

const BATCH_USAGE = "Usage: hafez batch [--dry-run] [--data '<payload>' | --file payload.json]  (or pipe JSON to stdin)"
const BATCH_FLAGS: FlagSpec = { 'dry-run': 'boolean', data: 'string', file: 'string' }

export async function cmdBatch(os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const { flags } = parseArgs(args, BATCH_FLAGS, BATCH_USAGE)
  const dryRun = flags['dry-run'] === true
  const input = await readPayload(flags, BATCH_USAGE)
  // A payload that is not a well-formed batch is a misuse: the error carries
  // the batch shape so the retry is right. Semantic failures (a missing slug)
  // are not shape problems and say only what failed.
  // No input is not one: in a pipe it means the stage before failed and said
  // why, and a batch shape there would invite hand-writing the ops.
  if (!input.trim()) {
    throw new HafezError('VALIDATION_FAILED', 'No input received. Pipe JSON array to stdin (echo \'[...]\' | hafez batch) or pass --data \'[...]\' or --file payload.json')
  }
  const { input: payload, resolved } = resolveBatchDots(input, opts.cwd ?? process.cwd())
  let operations: BatchOperation[]
  try {
    operations = parseBatchInput(payload)
  } catch (err) {
    throw err instanceof HafezError ? new MisuseError(err, placeIn('batchMisuse', 'batchShape')) : err
  }
  const nearMatches = await nearMatchWarnings(os, operations)
  // Under --json stdout is the report alone; the warnings go to stderr.
  if (opts.json) for (const w of nearMatches) process.stderr.write(`${w}\n`)
  if (dryRun) {
    // Same validate phase as apply — dry-run can never green-light a payload
    // apply rejects. Reports derived slugs so agents can predict create slugs.
    const report = await os.validateBatch(operations)
    if (opts.json) return jsonOut(resolved.length > 0 ? { ...report, resolved } : report)
    if (!report.valid) {
      const invalidCount = report.operations.filter(o => o.errors.length > 0).length
      const lines = report.operations.flatMap(o => o.errors.map(e => opErrorLine(o.index, o.op, o.slug, e)))
      // Dry-run's own header: it reports a hypothetical, so it says "would be
      // applied" rather than the refusal wording batchInvalidHeader carries.
      throw new HafezError(
        'VALIDATION_FAILED',
        `Batch invalid: ${invalidCount} of ${operations.length} operation${operations.length === 1 ? '' : 's'} failed validation (0 would be applied)`,
        lines,
      )
    }
    const out = [`Batch valid: ${operations.length} operations would be applied`]
    const creates = report.operations.filter(o => o.created)
    if (creates.length > 0) {
      out.push('Derived slugs:')
      for (const c of creates) out.push(`  op[${c.index}] ${c.op} → ${c.slug}`)
    }
    for (const o of report.operations) {
      if (o.warning) out.push(`Warning: op[${o.index}] ${o.warning}`)
    }
    if (resolved.length > 0) out.push('Resolved:', ...resolved.map(r => `  ${r}`))
    return [...out, ...nearMatches].join('\n')
  }
  const results = await os.batch(operations)
  if (opts.json) return jsonOut(results)
  const created = results.filter(r => r.created).map(r => r.slug)
  let output = `Batch complete: ${operations.length} operations`
  if (created.length > 0) output += ` (created: ${created.join(', ')})`
  // Skipped ops carry the same warning line dry-run printed for them.
  const lines = [output]
  results.forEach((r, i) => {
    if (r.status === 'skipped' && r.warning) lines.push(`Warning: op[${i}] ${r.warning}`)
  })
  return [...lines, ...nearMatches].join('\n')
}

const DIGEST_USAGE = "Usage: hafez digest [--data '<summary>' | --file summary.json]  (or pipe JSON to stdin)"
const DIGEST_FLAGS: FlagSpec = { data: 'string', file: 'string' }

export async function cmdDigest(os: Hafez, args: string[], _opts: CommandOpts = {}): Promise<string> {
  const { flags } = parseArgs(args, DIGEST_FLAGS, DIGEST_USAGE)
  const raw = await readPayload(flags, DIGEST_USAGE)
  if (!raw.trim()) {
    throw new UsageError('No input received. Pipe JSON object to stdin (echo \'{"entities_touched":...}\' | hafez digest) or pass --data \'<summary>\' or --file summary.json')
  }

  // Parse JSON
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HafezError('VALIDATION_FAILED', 'Invalid JSON on stdin: ' + (raw.slice(0, 80)))
  }

  const result = parseDigestInput(parsed)
  if (!result.success) {
    const fields = result.error.issues.map(i => i.path.join('.')).join(', ')
    throw new HafezError('VALIDATION_FAILED', `Invalid digest input — missing or invalid fields: ${fields}`)
  }

  // Warn about unknown fields
  if (result.unknownFields.length > 0) {
    process.stderr.write(`Warning: digest input contains unknown fields (may indicate Zod safeParse silent-strip): ${result.unknownFields.join(', ')}\n`)
  }

  // Resolve existing entity slugs — digest only generates update ops for entities
  const { items: entityItems } = await os.query({ filter: 'all', limit: 9999 })
  const { items: knowledgeItems } = await os.query_knowledge({ limit: 9999 })

  const ops = digest(result.data, new Set(entityItems.map(i => i.slug)), new Set(knowledgeItems.map(i => i.slug)))

  // A session already saved: emit the session note alone, which batch skips
  // as a duplicate, so a second save writes no second set of log entries.
  const note = ops.find(o => o.op === 'create')!
  const [check] = (await os.validateBatch([note])).operations
  if (check.warning) {
    process.stderr.write(`Session already saved as '${check.slug}' — skipped, nothing new to write\n`)
    return JSON.stringify([note], null, 2)
  }
  return JSON.stringify(ops, null, 2)
}


export async function cmdExport(_os: Hafez, args: string[], opts: CommandOpts = {}): Promise<string> {
  const EXPORT_USAGE = 'Usage: hafez export --okf [--out <dir>]'
  const { flags } = parseArgs(args, { okf: 'boolean', out: 'string' }, EXPORT_USAGE)
  if (flags.okf !== true) throw new UsageError(EXPORT_USAGE)
  const outDir = typeof flags.out === 'string' ? resolve(flags.out) : resolve(process.cwd(), 'okf-export')
  if (!opts.vaultPath) throw new HafezError('VALIDATION_FAILED', 'export requires a resolved vault path (CommandOpts.vaultPath)')
  const { exportOkf } = await import('../export-okf.js')
  const exportReport = exportOkf(opts.vaultPath, outDir)
  if (opts.json) return JSON.stringify(exportReport, null, 2)
  const lines = [`Exported ${exportReport.entities} entities, ${exportReport.knowledge} knowledge, ${exportReport.sessions} sessions to ${exportReport.outDir}`]
  for (const s of exportReport.skipped) lines.push(`  skipped ${s.file}: ${s.reason}`)
  if (exportReport.unresolvedLinks > 0) lines.push(`  unresolved links: ${exportReport.unresolvedLinks}`)
  return lines.join('\n')
}

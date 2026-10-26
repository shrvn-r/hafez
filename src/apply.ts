// src/apply.ts
// Apply (see CONTEXT.md): the Spine's apply stage — one arm per Op Spec row,
// behind a dispatch table keyed by the same names. The table's key type is
// derived from the Op Spec's, so a spec row with no arm here fails to build:
// adding an op is one Op Spec entry plus one entry in APPLY.
//
// Apply trusts the Spine: every semantic gate ran exactly once, in the
// validate phase (the Op Spec's check), so no arm re-checks a rule. Branches
// validation has ruled out are bare internal throws — a Spine bug must be loud
// in the test suite, not masquerade as caller error. The branches that are
// NOT internal are the two directions of the validate→apply race, where an
// external actor removed a file the op resolved (vanished()) or created one
// the op claimed (appeared()); both throw caller-facing.
//
// Apply owns every vault-file write and nothing else — it touches neither git
// nor SQLite. The Spine commits [...filesWritten, ...filesDeleted] under
// commitMessage and runs the index updates afterwards. The Op Spec table stays
// pure (no filesystem access); the frontmatter builders live here and are
// exported so the batch validate phase can run them against a simulated vault.
import { writeFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { parseFilePath, serializeFile, slugify, resolveFilePath, vaultRel, kindFromPath, kindDir, archiveLogPath, findVaultFile, vaultFileExists, type VaultKind } from './vault.js'
import { validateEntityFrontmatter, validateKnowledgeFrontmatter } from './schema.js'
import { bodyTemplate, knowledgeBodyTemplate, sessionBodyTemplate } from './templates.js'
import { formatSessionLogEntry, stampAction, documentFor, documentForFile, type Doc } from './document.js'
import { sectionsFor, statusesFor, unreachableFields, describeTarget, type DocTarget } from './contracts.js'
import { localDay } from './dates.js'
import { addResources } from './resource.js'
import { detectAgent } from './harness.js'
import { specFor, loggedFields, resourceList, type OpSpecName } from './batch-ops.js'
import type { BatchOperation, BatchResult, CreateEntityFields, DeletableKind, CreateKnowledgeFields, KnowledgeSubtype, UpdateFields, UpdateResult } from './types.js'
import { HafezError } from './types.js'

// One applied mutation: what was written/deleted (repo-relative, ready to
// stage), the per-op commit message, and which SQLite rows to touch AFTER the
// commit lands. Single-op methods apply exactly one and commit it under its
// own message; batch() applies many and composes a single commit.
export interface AppliedOp {
  filesWritten: string[]
  filesDeleted: string[]
  result: BatchResult
  commitMessage: string
  indexRemovals: string[]
  indexUpserts: Array<{ slug: string; kind: VaultKind }>
  /** Set by the update arm: the line each Next Actions query matched. */
  updateResult?: UpdateResult
  /** Set by the delete arm: the kind of note it removed. */
  deletedKind?: DeletableKind
}

/** Everything an apply arm needs from its caller: where the vault is, and how
 * to hand the Spine a pre-write snapshot for rollback. Path resolution, the
 * existence checks, and the local-day clock are ordinary imports — one adapter
 * would only be a hypothetical seam. */
export interface ApplyContext {
  vaultPath: string
  captureOriginal(path: string): void
}

/** A vault file that validation resolved but is gone at apply time. The vault
 * lock excludes other hafez processes, not external actors (Obsidian, a hand
 * rm, a git checkout), so unlike a branch validation has truly ruled out —
 * which would stay a bare internal throw, loud in the test suite — this is a
 * recoverable race: a caller-facing NOT_FOUND naming the actionable fact, and
 * a HafezError so batch mode keeps its op[i] localisation. */
function vanished(slug: string): never {
  throw new HafezError('NOT_FOUND', `'${slug}' vanished after validation — something outside hafez removed it; re-run`)
}

/** The mirror image: a vault file validation confirmed absent, but which
 * exists at apply time. Same external actors, same window — and a create arm
 * that wrote anyway would overwrite a file hafez never saw, which rollback
 * only undoes when some LATER op in the batch happens to fail. Guarding one
 * direction of the race and not the other reads as intentional to the next
 * person, so both directions throw. */
function appeared(slug: string): never {
  throw new HafezError('SLUG_EXISTS', `'${slug}' appeared after validation — something outside hafez created it; nothing was overwritten, re-run`)
}

function entityPath(vaultPath: string, slug: string): string { return resolveFilePath(vaultPath, slug, 'entity') }
function knowledgePath(vaultPath: string, slug: string): string { return resolveFilePath(vaultPath, slug, 'knowledge') }
function today(): string { return localDay() }

// --- Field policy ---

const ENTITY_ONLY_FIELDS: (keyof UpdateFields)[] = ['status', 'add_action', 'add_actions', 'complete_action', 'complete_actions', 'remove_action', 'remove_actions', 'clear_actions', 'brief', 'current_state', 'session_log', 'agent', 'resource', 'parent']
const KNOWLEDGE_ONLY_FIELDS: (keyof UpdateFields)[] = ['confidence', 'synthesis', 'add_evidence', 'add_source']

// An entity-only field is still reachable on a knowledge note when THAT
// note's contract declares the capability the field needs. The gate asks the
// contract (contracts.ts), not the field name, so the plan/insight split is
// one table entry rather than a special case threaded through the paths.
const KNOWLEDGE_FIELD_CAPABILITY: Partial<Record<keyof UpdateFields, (t: DocTarget) => boolean>> = {
  status: t => statusesFor(t).length > 0,
}

/** Reject a status the target's contract does not define (a plan has no
 * 'paused'; an insight has no status at all). One check for create and
 * update alike. */
function assertStatusAllowed(target: DocTarget, status: string): void {
  const allowed = statusesFor(target)
  if (allowed.length === 0) {
    throw new HafezError('VALIDATION_FAILED', `Cannot set status on ${describeTarget(target)}: status is plan-subtype only`)
  }
  if (!allowed.includes(status)) {
    throw new HafezError('VALIDATION_FAILED', `Invalid status '${status}' for ${describeTarget(target)} (expected: ${allowed.join(', ')})`)
  }
}

/** Content-field policy: reject, never route, never drop. A create field
 * writes into a named body section; when the chosen template has no such
 * section the text would vanish on write, so the op fails loudly instead.
 * Generic over the (template, field) pair — see contracts.unreachableFields. */
function assertFieldsReachable(target: DocTarget, fields: Record<string, unknown>): void {
  const unreachable = unreachableFields(target, fields)
  if (unreachable.length === 0) return
  const named = unreachable.map(u => `'${u.field}' (needs a '## ${u.section}' section)`).join(', ')
  throw new HafezError(
    'VALIDATION_FAILED',
    `Cannot set ${named} on ${describeTarget(target)} — its template has no such section, and text is never silently dropped. Sections available: ${sectionsFor(target).join(', ')}`,
  )
}

export function validateKindFields(kind: 'entity' | 'knowledge', fields: UpdateFields, subtype?: KnowledgeSubtype): void {
  if (kind === 'knowledge') {
    const target: DocTarget = { kind: 'knowledge', subtype }
    const invalid = ENTITY_ONLY_FIELDS.filter(
      f => fields[f] !== undefined && !(KNOWLEDGE_FIELD_CAPABILITY[f]?.(target) ?? false),
    )
    if (invalid.length > 0) {
      throw new HafezError('VALIDATION_FAILED', `Cannot set entity-only fields on knowledge note: ${invalid.join(', ')}`)
    }
    if (fields.status !== undefined) assertStatusAllowed(target, fields.status)
  }
  if (kind === 'entity') {
    const invalid = KNOWLEDGE_ONLY_FIELDS.filter(f => fields[f] !== undefined)
    if (invalid.length > 0) {
      throw new HafezError('VALIDATION_FAILED', `Cannot set knowledge-only fields on entity: ${invalid.join(', ')}`)
    }
  }
}

// --- Builders ---
// Shared by the create arms and the batch validate phase so optional fields
// can't silently diverge between paths (see CLAUDE.md Validation Gotchas).
// `existsFn` is the caller's: apply passes the real vault, validateBatchCore a
// simulation-aware check (same-batch creates count as existing).

export function buildEntityFrontmatter(name: string, ef: CreateEntityFields, existsFn: (slug: string) => boolean): Record<string, any> {
  assertFieldsReachable({ kind: 'entity', type: ef.type }, ef as unknown as Record<string, unknown>)
  const fm: Record<string, any> = { name, type: ef.type, status: 'active', created: today(), 'last-touched': today() }
  if (ef.domain?.length) fm.domain = ef.domain
  if (ef.parent) {
    if (!existsFn(ef.parent)) throw new HafezError('VALIDATION_FAILED', `Parent '${ef.parent}' does not exist`)
    fm.parent = ef.parent
  }
  if (ef.related?.length) {
    for (const r of ef.related) {
      if (!existsFn(r)) throw new HafezError('VALIDATION_FAILED', `Related slug '${r}' does not exist`)
    }
    fm.related = ef.related
  }
  if (ef.tags?.length) fm.tags = ef.tags
  if (ef.description) fm.description = ef.description
  const resource = addResources([], resourceList(ef.resource))
  if (resource.length > 0) fm.resource = resource
  const errors = validateEntityFrontmatter(fm)
  if (errors.length > 0) throw new HafezError('VALIDATION_FAILED', 'Invalid entity frontmatter', errors)
  return fm
}

// Every action add — create, update, batch, digest — lands here, so this is
// the one place the added-date stamp is written (local day, never twice).
function addStampedAction(doc: Doc, body: string, action: string): string {
  return doc.addNextAction(body, stampAction(action, today()))
}

// Body-side optional fields (brief, actions) must behave identically in both
// paths, like buildEntityFrontmatter's.
function buildEntityBody(ef: CreateEntityFields): string {
  const doc = documentFor({ kind: 'entity' })
  let body = bodyTemplate(ef.type, { purpose: ef.purpose })
  if (ef.brief) body = doc.setBrief(body, ef.brief)
  if (ef.add_action !== undefined) body = addStampedAction(doc, body, ef.add_action)
  for (const action of ef.add_actions ?? []) body = addStampedAction(doc, body, action)
  return body
}

export function buildKnowledgeFrontmatter(name: string, kf: CreateKnowledgeFields, existsFn: (slug: string) => boolean): Record<string, any> {
  const target: DocTarget = { kind: 'knowledge', subtype: kf.subtype }
  assertFieldsReachable(target, kf as unknown as Record<string, unknown>)
  const fm: Record<string, any> = { name, confidence: kf.confidence ?? 'observation', 'reinforcement-count': 0, created: today() }
  if (kf.domain?.length) fm.domain = kf.domain
  if (kf.related?.length) {
    for (const r of kf.related) {
      if (!existsFn(r)) throw new HafezError('VALIDATION_FAILED', `Related slug '${r}' does not exist`)
    }
    fm.related = kf.related
  }
  if (kf.tags?.length) fm.tags = kf.tags
  if (kf.description) fm.description = kf.description
  if (kf.status !== undefined) {
    // Plans are tracked work: they carry a lifecycle and therefore a
    // last-touched day, exactly like entities do.
    assertStatusAllowed(target, kf.status)
    fm.status = kf.status
    fm['last-touched'] = today()
  }
  const errors = validateKnowledgeFrontmatter(fm)
  if (errors.length > 0) throw new HafezError('VALIDATION_FAILED', 'Invalid knowledge frontmatter', errors)
  if (kf.subtype) fm.subtype = kf.subtype
  if (kf['session-date']) fm['session-date'] = kf['session-date']
  return fm
}

// The Next Actions fields are the one group in UpdateFields that all touch
// the same section, so their order within an op IS their meaning. The
// contract: prune, tick, add — clear_actions → remove_action(s) →
// complete_action(s) → add_action → add_actions. Every query is resolved
// against the list as it stands after the clear and before any edit, so a
// query never sees a line another field of the same op removed or added;
// two queries naming one line is a collision, not a silent overwrite. The
// section is pruned once at the end, after the adds — a tick that empties
// the open list and an add in the same op edit the section in place rather
// than removing and recreating it. The "rebuild the list" payload
// (`clear_actions` + `add_actions`) does what it reads as. Contradictory
// payloads (clear + a query) are rejected in the validate phase, not here.
//
// Lines leaving the list go to the archive log, never nowhere: the removed
// line, a cleared list, the ticked lines a prune takes with the section, and
// — once the section holds ARCHIVE_LIMIT or more ticked lines — the oldest of
// them, leaving one fewer than the limit (the session log's rule). Each line
// takes the lines nested under it (up to the next checkbox line). Run on
// every update, so a list grown by hand is trimmed by the next write; never
// on read.
const ARCHIVE_LIMIT = 10

/** Action lines an update took out of Next Actions, as the file held them. */
interface ArchivedActions { cleared: string[]; removed: string[]; ticked: string[] }

function applyNextActionFields(doc: Doc, body: string, fields: UpdateFields): { body: string; result: UpdateResult; archived: ArchivedActions } {
  const result: UpdateResult = {}
  const cleared = fields.clear_actions ? doc.actionLines(body) : []
  if (fields.clear_actions) body = doc.clearNextActions(body)
  type QueryField = 'remove_action' | 'remove_actions' | 'complete_action' | 'complete_actions'
  const match = (field: QueryField, query: string) => ({ field, match: doc.matchNextAction(body, query) })
  const removes = [
    ...(fields.remove_action !== undefined ? [match('remove_action', fields.remove_action)] : []),
    ...(fields.remove_actions ?? []).map(q => match('remove_actions', q)),
  ]
  const completes = [
    ...(fields.complete_action !== undefined ? [match('complete_action', fields.complete_action)] : []),
    ...(fields.complete_actions ?? []).map(q => match('complete_actions', q)),
  ]
  // Caller misuse, not a Spine bug: like no-match and ambiguous (matchNextAction),
  // it depends on the list as the earlier ops of a batch leave it, so it is
  // resolved here rather than in the validate phase.
  const seen = new Map<number, QueryField>()
  for (const { field, match: m } of [...removes, ...completes]) {
    const first = seen.get(m.line)
    if (first !== undefined) {
      throw new HafezError('VALIDATION_FAILED', first === field
        ? `${field} matches "${m.text}" twice — one line, one query`
        : `${first} and ${field} both match "${m.text}" — one line, one field`)
    }
    seen.set(m.line, field)
  }
  // The singular query, when sent, is first in its list; the array form is the rest.
  const texts = (list: typeof removes) => list.map(q => q.match.text)
  const removeOffset = fields.remove_action !== undefined ? 1 : 0
  const completeOffset = fields.complete_action !== undefined ? 1 : 0
  if (removeOffset) result.removed_action = removes[0].match.text
  if (fields.remove_actions !== undefined) result.removed_actions = texts(removes.slice(removeOffset))
  if (completeOffset) result.completed_action = completes[0].match.text
  if (fields.complete_actions !== undefined) result.completed_actions = texts(completes.slice(completeOffset))
  // Every match is a line position in the pre-edit list. A tick leaves every
  // position where it was; a removal shifts the lines below it — so tick
  // first, then remove bottom-up. The archive keeps query order.
  for (const { match: m } of completes) body = doc.completeNextAction(body, m).body
  const removed: string[] = []
  for (const i of removes.map((_, i) => i).sort((x, y) => removes[y].match.line - removes[x].match.line)) {
    ({ body, line: removed[i] } = doc.removeNextAction(body, removes[i].match))
  }
  if (fields.add_action !== undefined) body = addStampedAction(doc, body, fields.add_action)
  if (fields.add_actions !== undefined) {
    for (const action of fields.add_actions) {
      body = addStampedAction(doc, body, action)
    }
  }
  const overflow = doc.extractOldestTickedActions(body, ARCHIVE_LIMIT - 1)
  // With no open line left the prune takes the section, ticked lines and all.
  const pruned = doc.getNextActions(overflow.body).length === 0 ? doc.actionLines(overflow.body) : []
  return {
    body: doc.pruneNextActions(overflow.body),
    result,
    archived: { cleared, removed, ticked: [...overflow.lines, ...pruned] },
  }
}

// Pure field application, like every arm above it: the Spine has already run
// Op Spec validation (shape + semantics). `doc` is the Document bound to the
// file's kind (see documentFor).
function applyUpdateFields(doc: Doc, fm: Record<string, any>, body: string, fields: UpdateFields): { fm: Record<string, any>; body: string; updateResult: UpdateResult; archivedActions: string[] } {
  if (fields.status !== undefined) fm.status = fields.status
  if (fields.current_state !== undefined) {
    body = doc.setSection(body, 'Current State', fields.current_state, 'Session Log')
  }
  if (fields.brief !== undefined) {
    body = fields.brief === null ? doc.removeBrief(body) : doc.setBrief(body, fields.brief)
  }
  const actions = applyNextActionFields(doc, body, fields)
  body = actions.body
  if (fields.session_log) {
    body = doc.prependSessionLogEntry(body, formatSessionLogEntry(fields.session_log))
  }
  // Domain (shared) + knowledge-only metadata
  if (fields.domain !== undefined) {
    if (fields.domain.length === 0) delete fm.domain
    else fm.domain = fields.domain
  }
  if (fields.description !== undefined) {
    if (fields.description === '' || fields.description === null) delete fm.description
    else fm.description = fields.description
  }
  if (fields.resource !== undefined) {
    const values = resourceList(fields.resource)
    if (values.length === 0) delete fm.resource
    else fm.resource = addResources(fm.resource ?? [], values)
  }
  if (fields.confidence !== undefined) fm.confidence = fields.confidence
  if (fields.parent !== undefined) fm.parent = fields.parent
  if (fields.tags !== undefined) fm.tags = fields.tags
  if (fields.related !== undefined) fm.related = fields.related
  if (fields.synthesis !== undefined) {
    body = doc.setSection(body, 'Synthesis', fields.synthesis)
  }
  if (fields.add_evidence !== undefined) {
    const sanitized = fields.add_evidence.replace(/^#{1,2}\s/gm, '### ')
    body = doc.appendToSection(body, 'Evidence', sanitized)
    fm['reinforcement-count'] = (fm['reinforcement-count'] ?? 0) + 1
    fm['last-reinforced'] = today()
    // NOTE: Confidence auto-promotion (observation→pattern at count>=3) was intentionally
    // removed. Confidence changes are now a deliberate decision via update --confidence.
  }
  if (fields.add_source !== undefined) {
    body = doc.appendToSection(body, 'Sources', fields.add_source)
  }
  if (fm['last-touched'] !== today()) fm['last-touched'] = today()
  const updateResult: UpdateResult = { ...actions.result, ...(fields.session_log && { logged: true }) }
  return { fm, body, updateResult, archivedActions: archivedActionEntries(actions.archived) }
}

/** The archive log's entries for action lines leaving the list. Entry-shaped
 * like the session log entries archived beside them, so the file stays one
 * entry stream (merge.ts unions it by entry). */
function archivedActionEntries(archived: ArchivedActions): string[] {
  const entries: string[] = []
  const plural = (n: number) => n === 1 ? '' : 's'
  if (archived.cleared.length > 0) {
    const n = archived.cleared.length
    entries.push(formatSessionLogEntry({ type: 'progress', agent: 'system', summary: `Cleared ${n} action${plural(n)}`, body: archived.cleared.join('\n') }))
  }
  for (const line of archived.removed) {
    entries.push(formatSessionLogEntry({ type: 'progress', agent: 'system', summary: 'Removed action', body: line }))
  }
  const n = archived.ticked.length
  if (n > 0) {
    entries.push(formatSessionLogEntry({ type: 'progress', agent: 'system', summary: `Archived ${n} ticked action${plural(n)}`, body: archived.ticked.join('\n') }))
  }
  return entries
}

/** Mechanised session log (#85, moved into the Spine by #107): an entity
 * update with no session_log gets a `progress` entry naming the fields
 * written, so history is complete whichever caller wrote it. Action-only
 * updates are exempt, and only entities carry a Session Log. */
function withMechanisedLog(kind: 'entity' | 'knowledge', fields: UpdateFields): UpdateFields {
  if (kind !== 'entity' || fields.session_log) return fields
  const logged = loggedFields(fields)
  if (logged.length === 0) return fields
  return {
    ...fields,
    session_log: {
      type: 'progress',
      summary: `Updated ${logged.map(f => f.replace(/_/g, '-')).join(', ')}`,
      agent: fields.agent ?? detectAgent(),
    },
  }
}

// --- Related edges (ADR 0002) ---
// A same-kind `related` edge (entity↔entity, knowledge↔knowledge) is one
// edge with two ends the tool keeps: the arm that writes or drops `b` on
// `a`'s file calls one of these to mirror it on `b`'s file, in the same
// commit, captured for the same rollback. A cross-kind edge stays one-way
// (the index answers the reverse); a self-edge and a target already in (or
// already without) the mirror are left alone — a file the op would not
// change is never rewritten, which is also why a legacy one-way edge is
// never repaired.

/** The mirror file an edge op touched: what the arm appends to its
 * filesWritten and indexUpserts. */
export interface EdgeTouch {
  file: string
  upsert: { slug: string; kind: VaultKind }
}

function mirrorEdge(ctx: ApplyContext, a: string, aKind: VaultKind, b: string, mode: 'write' | 'drop'): EdgeTouch | null {
  if (a === b) return null
  const bPath = findVaultFile(ctx.vaultPath, b)
  if (!bPath || kindFromPath(bPath) !== aKind) return null
  const parsed = parseFilePath(bPath)
  const fm = parsed.frontmatter as Record<string, any>
  const related: string[] = fm.related ?? []
  if (mode === 'write' ? related.includes(a) : !related.includes(a)) return null
  ctx.captureOriginal(bPath)
  if (mode === 'write') fm.related = [...related, a]
  else {
    fm.related = related.filter(r => r !== a)
    if (fm.related.length === 0) delete fm.related
  }
  const body = documentForFile(parsed).syncRelatedSection(parsed.body, fm)
  writeFileSync(bPath, serializeFile(fm, body))
  return { file: vaultRel(ctx.vaultPath, bPath), upsert: { slug: b, kind: aKind } }
}

/** Write `a` into `b`'s related when the edge is same-kind. */
function writeBackEdge(ctx: ApplyContext, a: string, aKind: VaultKind, b: string): EdgeTouch | null {
  return mirrorEdge(ctx, a, aKind, b, 'write')
}

/** Write `a` into every same-kind target's related. */
function backEdges(ctx: ApplyContext, a: string, aKind: VaultKind, targets: string[]): EdgeTouch[] {
  return targets.flatMap(b => writeBackEdge(ctx, a, aKind, b) ?? [])
}

/** Drop `a` from `b`'s related when the edge is same-kind. Exported for the
 * delete arm (#243) as well. */
export function dropBackEdge(ctx: ApplyContext, a: string, aKind: VaultKind, b: string): EdgeTouch | null {
  return mirrorEdge(ctx, a, aKind, b, 'drop')
}

// --- The arms ---

function applyUpdate(op: Extract<BatchOperation, { op: 'update' }>, ctx: ApplyContext): AppliedOp {
  const { vaultPath } = ctx
  const filePath = findVaultFile(vaultPath, op.slug) ?? vanished(op.slug)
  ctx.captureOriginal(filePath)
  const kind = kindFromPath(filePath)

  const parsedFile = parseFilePath(filePath)
  const doc = documentForFile(parsedFile)
  let fm = parsedFile.frontmatter as Record<string, any>
  let body = parsedFile.body
  // The related list before the fields replace it: the diff against the new
  // one is what the edge writer and dropper mirror on the targets.
  const relatedBefore: string[] = fm.related ?? []
  // The values `resource` adds by the duplicate rule. None (every one already
  // held) is no write: the update goes on without the field, so neither the
  // mechanised log entry nor the tell line names it.
  const resourceValues = resourceList(op.fields.resource)
  const held: string[] = fm.resource ?? []
  const resourceAdded = resourceValues.length > 0 ? addResources(held, resourceValues).slice(held.length) : undefined
  const { resource: _resource, ...withoutResource } = op.fields
  const fields = resourceAdded?.length === 0 ? withoutResource : op.fields
  const applied = applyUpdateFields(doc, fm, body, withMechanisedLog(kind, fields))
  fm = applied.fm
  body = applied.body

  // Archival: action lines that left the list, and the oldest session log entry
  const archiveEntries = [...applied.archivedActions]
  if (doc.countSessionLogEntries(body) >= ARCHIVE_LIMIT) {
    const extracted = doc.extractOldestSessionLogEntry(body)
    if (extracted) {
      archiveEntries.push(extracted.entry)
      body = extracted.remaining
    }
  }
  const archivePath = archiveLogPath(vaultPath, op.slug)
  const wroteArchive = archiveEntries.length > 0
  if (wroteArchive) {
    ctx.captureOriginal(archivePath)
    mkdirSync(dirname(archivePath), { recursive: true })
    appendFileSync(archivePath, archiveEntries.map(e => e + '\n\n').join(''))
  }

  body = doc.syncRelatedSection(body, fm)
  writeFileSync(filePath, serializeFile(fm, body))

  const touches: EdgeTouch[] = []
  if (op.fields.related !== undefined) {
    const relatedAfter: string[] = fm.related ?? []
    touches.push(...backEdges(ctx, op.slug, kind, relatedAfter.filter(r => !relatedBefore.includes(r))))
    for (const r of relatedBefore.filter(r => !relatedAfter.includes(r))) {
      const t = dropBackEdge(ctx, op.slug, kind, r)
      if (t) touches.push(t)
    }
  }

  // Only the files THIS update wrote. Keying off the archive file merely
  // existing swept any external hand-edit sitting in entities/archive/
  // into an unrelated commit.
  const files = [vaultRel(vaultPath, filePath)]
  if (wroteArchive) files.push(vaultRel(vaultPath, archivePath))
  files.push(...touches.map(t => t.file))

  return {
    filesWritten: files,
    filesDeleted: [],
    result: { op: 'update', slug: op.slug, status: 'ok' },
    commitMessage: `update: ${op.slug}`,
    indexRemovals: [],
    indexUpserts: [{ slug: op.slug, kind }, ...touches.map(t => t.upsert)],
    updateResult: { ...applied.updateResult, ...(resourceAdded && { resource_added: resourceAdded }) },
  }
}

function applyCreateEntity(op: Extract<BatchOperation, { op: 'create'; kind: 'entity' }>, ctx: ApplyContext): AppliedOp {
  const { vaultPath } = ctx
  const slug = slugify(op.name)
  const ef = op.fields
  const fm = buildEntityFrontmatter(op.name, ef, s => vaultFileExists(vaultPath, s))
  let body = buildEntityBody(ef)
  const filePath = entityPath(vaultPath, slug)
  // Re-checked against the same cross-kind test claimNew ran (vaultFileExists
  // is the real-disk half of the Spine's existsAnywhere) — not a re-litigation
  // of the rule, just the race window.
  if (vaultFileExists(vaultPath, slug)) appeared(slug)
  ctx.captureOriginal(filePath)
  mkdirSync(join(vaultPath, kindDir('entity')), { recursive: true })
  body = documentFor({ kind: 'entity' }).syncRelatedSection(body, fm)
  writeFileSync(filePath, serializeFile(fm, body))
  const touches = backEdges(ctx, slug, 'entity', fm.related ?? [])
  return {
    filesWritten: [vaultRel(vaultPath, filePath), ...touches.map(t => t.file)],
    filesDeleted: [],
    result: { op: 'create', slug, status: 'ok', created: true },
    commitMessage: `create: ${op.name}`,
    indexRemovals: [],
    indexUpserts: [{ slug, kind: 'entity' }, ...touches.map(t => t.upsert)],
  }
}

function applyCreateKnowledge(op: Extract<BatchOperation, { op: 'create'; kind: 'knowledge' }>, ctx: ApplyContext): AppliedOp {
  const { vaultPath } = ctx
  const slug = slugify(op.name)
  const kf = (op.fields || {}) as CreateKnowledgeFields
  const fm = buildKnowledgeFrontmatter(op.name, kf, s => vaultFileExists(vaultPath, s))
  let body = knowledgeBodyTemplate(kf.subtype, { synthesis: kf.synthesis })
  const filePath = knowledgePath(vaultPath, slug)
  if (vaultFileExists(vaultPath, slug)) appeared(slug)
  ctx.captureOriginal(filePath)
  mkdirSync(join(vaultPath, kindDir('knowledge')), { recursive: true })
  body = documentFor({ kind: 'knowledge' }).syncRelatedSection(body, fm)
  writeFileSync(filePath, serializeFile(fm, body))
  const touches = backEdges(ctx, slug, 'knowledge', fm.related ?? [])
  return {
    filesWritten: [vaultRel(vaultPath, filePath), ...touches.map(t => t.file)],
    filesDeleted: [],
    result: { op: 'create', slug, status: 'ok', created: true },
    commitMessage: `create: ${op.name}`,
    indexRemovals: [],
    indexUpserts: [{ slug, kind: 'knowledge' }, ...touches.map(t => t.upsert)],
  }
}

function applyCreateSession(op: Extract<BatchOperation, { op: 'create'; kind: 'session' }>, ctx: ApplyContext): AppliedOp {
  const { vaultPath } = ctx
  const slug = slugify(op.name)
  // A slug taken at validate time never reaches here: that is the
  // create-session spec's skip disposition (a warning, not an error), and the
  // Spine synthesizes the result without calling Apply. One taken DURING the
  // validate→apply window does reach here, and overwriting someone else's
  // session note is worse than the error — so the race throws even though the
  // ordinary duplicate warns. Mirrors the spec's own `existsAnywhere ||
  // sessionExists` test.
  const sessionDir = join(vaultPath, kindDir('session'))
  mkdirSync(sessionDir, { recursive: true })
  const filePath = join(sessionDir, `${slug}.md`)
  if (existsSync(filePath) || vaultFileExists(vaultPath, slug)) appeared(slug)
  ctx.captureOriginal(filePath)
  const fm: Record<string, any> = { name: op.name, created: today() }
  const kf = op.fields ?? {}
  if (kf['session-date']) fm['session-date'] = kf['session-date']
  if (kf.related?.length) fm.related = kf.related
  // Session sections come from contracts.SESSION_SECTIONS — the same list
  // Document splits on, so the written body and the structural set agree.
  let sessionBody = sessionBodyTemplate({ synthesis: kf.synthesis, decisions: kf.decisions, entities_touched: kf.entities_touched })
  sessionBody = documentFor({ kind: 'session' }).syncRelatedSection(sessionBody, fm)
  writeFileSync(filePath, serializeFile(fm, sessionBody))
  return {
    filesWritten: [vaultRel(vaultPath, filePath)],
    filesDeleted: [],
    result: { op: 'create', slug, status: 'ok', created: true },
    commitMessage: `create: ${op.name}`,
    indexRemovals: [],
    indexUpserts: [{ slug, kind: 'session' }],
  }
}

function applyCapture(op: Extract<BatchOperation, { op: 'capture' }>, ctx: ApplyContext): AppliedOp {
  const { vaultPath } = ctx
  const slug = slugify(op.name)
  const fm: Record<string, any> = {
    name: op.name,
    type: 'capture',
    status: 'active',
    created: today(),
    'last-touched': today(),
  }
  const filePath = entityPath(vaultPath, slug)
  if (vaultFileExists(vaultPath, slug)) appeared(slug)
  ctx.captureOriginal(filePath)
  mkdirSync(join(vaultPath, kindDir('entity')), { recursive: true })
  writeFileSync(filePath, serializeFile(fm, bodyTemplate('capture', { notes: op.notes })))
  return {
    filesWritten: [vaultRel(vaultPath, filePath)],
    filesDeleted: [],
    result: { op: 'capture', slug, status: 'ok', created: true },
    commitMessage: `capture: ${op.name}`,
    indexRemovals: [],
    indexUpserts: [{ slug, kind: 'entity' }],
  }
}

function applyLink(op: Extract<BatchOperation, { op: 'link' }>, ctx: ApplyContext): AppliedOp {
  const { vaultPath } = ctx
  const filePath = findVaultFile(vaultPath, op.slug) ?? vanished(op.slug)
  ctx.captureOriginal(filePath)

  const parsedFile = parseFilePath(filePath)
  const fm = parsedFile.frontmatter as Record<string, any>
  let body = parsedFile.body

  const kind = kindFromPath(filePath)
  let touch: EdgeTouch | null = null
  if (op.relation === 'parent') {
    fm.parent = op.target
  } else {
    const related = fm.related || []
    if (!related.includes(op.target)) related.push(op.target)
    fm.related = related
    touch = writeBackEdge(ctx, op.slug, kind, op.target)
  }

  body = documentForFile(parsedFile).syncRelatedSection(body, fm)
  writeFileSync(filePath, serializeFile(fm, body))
  return {
    filesWritten: [vaultRel(vaultPath, filePath), ...(touch ? [touch.file] : [])],
    filesDeleted: [],
    result: { op: 'link', slug: op.slug, status: 'ok' },
    commitMessage: `link: ${op.slug} → ${op.target} (${op.relation})`,
    indexRemovals: [],
    indexUpserts: [{ slug: op.slug, kind }, ...(touch ? [touch.upsert] : [])],
  }
}

function applyUnlink(op: Extract<BatchOperation, { op: 'unlink' }>, ctx: ApplyContext): AppliedOp {
  const { vaultPath } = ctx
  const filePath = findVaultFile(vaultPath, op.slug) ?? vanished(op.slug)
  ctx.captureOriginal(filePath)

  const parsedFile = parseFilePath(filePath)
  const fm = parsedFile.frontmatter as Record<string, any>
  let body = parsedFile.body

  const kind = kindFromPath(filePath)
  let touch: EdgeTouch | null = null
  if (op.relation === 'parent' && fm.parent === op.target) {
    delete fm.parent
  } else if (op.relation === 'related') {
    if (fm.related) {
      fm.related = fm.related.filter((r: string) => r !== op.target)
      if (fm.related.length === 0) delete fm.related
    }
    // The target's end goes too, even when this file never carried the edge
    // (a legacy one-way edge).
    touch = dropBackEdge(ctx, op.slug, kind, op.target)
  }

  body = documentForFile(parsedFile).syncRelatedSection(body, fm)
  writeFileSync(filePath, serializeFile(fm, body))
  return {
    filesWritten: [vaultRel(vaultPath, filePath), ...(touch ? [touch.file] : [])],
    filesDeleted: [],
    result: { op: 'unlink', slug: op.slug, status: 'ok' },
    commitMessage: `unlink: ${op.slug} ✕ ${op.target} (${op.relation})`,
    indexRemovals: [],
    indexUpserts: [{ slug: op.slug, kind }, ...(touch ? [touch.upsert] : [])],
  }
}

function applyPromote(op: Extract<BatchOperation, { op: 'promote' }>, ctx: ApplyContext): AppliedOp {
  const { vaultPath } = ctx
  const filePath = findVaultFile(vaultPath, op.slug) ?? vanished(op.slug)
  ctx.captureOriginal(filePath)
  if (op.target === 'knowledge') ctx.captureOriginal(knowledgePath(vaultPath, op.slug))
  const kind = kindFromPath(filePath)
  const parsedFile = parseFilePath(filePath)
  const fm = parsedFile.frontmatter as Record<string, any>
  const body = parsedFile.body
  const sourceType = kind === 'knowledge' ? 'knowledge' : (fm.type as string)

  const modifiedFiles: string[] = []
  const deletedFiles: string[] = []

  if (op.target === 'knowledge') {
    // Cross-kind: move file from entities/ to knowledge/. The source body
    // is read under the entity Document binding.
    const sourceDoc = documentFor({ kind: 'entity' })
    const newPath = knowledgePath(vaultPath, op.slug)
    // Promote must behave like create AT THE TARGET. A diverged vault can
    // hold the same slug as both an entity and a knowledge note (findFile
    // resolves entities first, so the validate phase sees only the entity);
    // without this check the write below silently destroys the note.
    if (existsSync(newPath)) {
      throw new HafezError('SLUG_EXISTS', `Slug '${op.slug}' already exists in ${kindDir('knowledge')}/`)
    }
    const notesSection = sourceDoc.findSection(body, 'Notes')
    const notesContent = notesSection?.content ?? ''
    const newFm: Record<string, any> = {
      name: fm.name, subtype: 'insight', confidence: 'observation', created: fm.created || today(),
    }
    if (fm.description) newFm.description = fm.description
    // resource is intentionally dropped on entity→knowledge promote (entity-only field)
    if (fm.domain) newFm.domain = fm.domain
    if (fm.related) newFm.related = fm.related
    if (fm.tags) newFm.tags = fm.tags

    const knBody = knowledgeBodyTemplate('insight', { synthesis: notesContent || undefined })
    const finalBody = documentFor({ kind: 'knowledge' }).syncRelatedSection(knBody, newFm)
    // An entities-only vault has no knowledge/ yet — create it like the
    // create-knowledge arm does, and map any fs failure onto a HafezError
    // so no raw ENOENT/ENOTDIR escapes the promote path.
    try {
      mkdirSync(join(vaultPath, kindDir('knowledge')), { recursive: true })
      writeFileSync(newPath, serializeFile(newFm, finalBody))
      unlinkSync(filePath)
    } catch (err) {
      throw new HafezError(
        'VALIDATION_FAILED',
        `Failed to promote '${op.slug}' to knowledge: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    modifiedFiles.push(vaultRel(vaultPath, newPath))
    // The deletion must be staged too — `git add` of a removed path stages
    // the removal; omitting it leaves the vault permanently dirty.
    deletedFiles.push(vaultRel(vaultPath, filePath))
  } else {
    // Same-kind: capture→entity, capture→project, entity→project
    fm.type = op.target
    fm['last-touched'] = today()

    // All body reshaping goes through Document — structural sections only,
    // so quoted heading mentions inside content can no longer suppress or
    // hijack the splice points.
    const doc = documentFor({ kind: 'entity' })
    let newBody = body
    if (op.target === 'entity') {
      newBody = doc.renameSection(newBody, 'Notes', 'Context')
    } else {
      // project
      newBody = doc.renameSection(newBody, 'Notes', 'Purpose')
      newBody = doc.renameSection(newBody, 'Context', 'Purpose')
      newBody = doc.ensureSection(newBody, 'Goals', { after: 'Purpose' })
    }
    newBody = doc.prependSessionLogEntry(newBody, formatSessionLogEntry({
      type: 'decision',
      agent: 'system',
      summary: `Promoted from ${sourceType} to ${op.target}`,
    }))

    newBody = doc.syncRelatedSection(newBody, fm)
    writeFileSync(filePath, serializeFile(fm, newBody))
    modifiedFiles.push(vaultRel(vaultPath, filePath))
  }

  return {
    filesWritten: modifiedFiles,
    filesDeleted: deletedFiles,
    result: { op: 'promote', slug: op.slug, status: 'ok' },
    commitMessage: `promote: ${op.slug} ${sourceType} → ${op.target}`,
    indexRemovals: op.target === 'knowledge' ? [op.slug] : [],
    indexUpserts: [{ slug: op.slug, kind: op.target === 'knowledge' ? 'knowledge' : 'entity' }],
  }
}

function applyDelete(op: Extract<BatchOperation, { op: 'delete' }>, ctx: ApplyContext): AppliedOp {
  const { vaultPath } = ctx
  // By path, not findVaultFile's entity-first order: the Op Spec ruled out
  // an entity, and resolved the slug to exactly one of these two.
  const knowledgeFile = knowledgePath(vaultPath, op.slug)
  const kind: DeletableKind = existsSync(knowledgeFile) ? 'knowledge' : 'session'
  const filePath = kind === 'knowledge' ? knowledgeFile : resolveFilePath(vaultPath, op.slug, 'session')
  if (!existsSync(filePath)) vanished(op.slug)
  // The snapshot is the rollback: a commit-stage failure writes it back.
  ctx.captureOriginal(filePath)
  // The other end of every same-kind edge the note owns goes with it (#243).
  const own: string[] = kind === 'knowledge' ? (parseFilePath(filePath).frontmatter as Record<string, any>).related ?? [] : []
  unlinkSync(filePath)
  const touches = own.flatMap(r => dropBackEdge(ctx, op.slug, 'knowledge', r) ?? [])
  return {
    filesWritten: touches.map(t => t.file),
    filesDeleted: [vaultRel(vaultPath, filePath)],
    result: { op: 'delete', slug: op.slug, status: 'ok' },
    commitMessage: `delete: ${op.slug} (${kind})`,
    indexRemovals: [op.slug],
    indexUpserts: touches.map(t => t.upsert),
    deletedKind: kind,
  }
}

// --- The table ---

/** The op payload an arm receives, by Op Spec name. The three create specs
 * split on `kind`; every other name IS its op. */
type OpFor<N extends OpSpecName> =
  N extends 'create-entity' ? Extract<BatchOperation, { op: 'create'; kind: 'entity' }>
  : N extends 'create-knowledge' ? Extract<BatchOperation, { op: 'create'; kind: 'knowledge' }>
  : N extends 'create-session' ? Extract<BatchOperation, { op: 'create'; kind: 'session' }>
  : Extract<BatchOperation, { op: N }>

/** One arm per Op Spec row — the key type is the spec table's own name union,
 * so a spec row with no arm here is a compile error, not a runtime surprise. */
type ApplyTable = { [N in OpSpecName]: (op: OpFor<N>, ctx: ApplyContext) => AppliedOp }

const APPLY: ApplyTable = {
  'update': applyUpdate,
  'create-entity': applyCreateEntity,
  'create-knowledge': applyCreateKnowledge,
  'create-session': applyCreateSession,
  'capture': applyCapture,
  'link': applyLink,
  'unlink': applyUnlink,
  'promote': applyPromote,
  'delete': applyDelete,
}

/** The single apply path for every mutation. Writes vault files but never
 * touches git or SQLite: the Spine commits [...filesWritten, ...filesDeleted]
 * under commitMessage (single ops) or one composed batch message, then runs
 * the index updates. ctx.captureOriginal snapshots files for rollback before
 * they change. */
export function applyOperation(op: BatchOperation, ctx: ApplyContext): AppliedOp {
  const arm = APPLY[specFor(op).name] as (op: BatchOperation, ctx: ApplyContext) => AppliedOp
  return arm(op, ctx)
}

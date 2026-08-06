// src/index.ts
import { parseFilePath, serializeFile, slugify, resolveFilePath, kindFromPath, kindDir, scanVaultDir, archiveLogPath, isIndexedRelPath } from './vault.js'
import { createGitJournal } from './git.js'
import { validateEntityFrontmatter, validateKnowledgeFrontmatter, validateSessionLogEntry } from './schema.js'
import { bodyTemplate, knowledgeBodyTemplate } from './templates.js'
import { formatSessionLogEntry, countSessionLogEntries, extractOldestSessionLogEntry, setBrief, removeBrief, addNextAction, completeNextAction, removeNextAction, clearNextActions, syncRelatedSection, findSection, setSection, appendToSection, prependSessionLogEntry, bodyBeforeSessionLog } from './document.js'
import { queryEntities, queryChildren, queryRelatedTo, queryKnowledge, queryUnified } from './query.js'
import { getContract, ENTITY_STATUSES, CONFIDENCE_LEVELS } from './contracts.js'
import { createIndex, type HafezIndex } from './db.js'
import { generateVaultIndex } from './knowledge-index.js'
import type { Hafez, HafezConfig, ReadDepth, ParsedFile, UpdateFields, CreateEntityFields, CreateKnowledgeFields, QueryFilter, EntityType, EntityQueryOpts, KnowledgeQueryOpts, LinkRelation, ConfidenceLevel, QueryResult, KnowledgeQueryResult, UnifiedResult, ValidationReport, BatchOperation, BatchResult, BatchOpValidation, BatchValidationReport, SearchResult, VaultStats } from './types.js'
import { HafezError } from './types.js'
import { BatchOperationSchema, specFor, type OpCheckContext } from './batch-ops.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, unlinkSync } from 'fs'
import { join, relative, basename, dirname } from 'path'
import { lock as lockVault } from 'proper-lockfile'

// One applied mutation: what was written/deleted (repo-relative, ready to
// stage), the per-op commit message, and which SQLite rows to touch AFTER the
// commit lands. Single-op methods apply exactly one and commit it under its
// own message; batch() applies many and composes a single commit.
interface AppliedOp {
  filesWritten: string[]
  filesDeleted: string[]
  result: BatchResult
  commitMessage: string
  indexRemovals: string[]
  indexUpserts: Array<{ slug: string; kind: 'entity' | 'knowledge' }>
  matchedAction?: string
}

export function createHafez(config: HafezConfig): Hafez {
  const { vaultPath, readOnly = false, git: gitConfig = {}, onWrite } = config

  // The persistence seam (CONTEXT.md: Journal). Everything below talks to
  // history through this port; git is just the default adapter.
  const journal = config.persistence ?? createGitJournal(vaultPath, gitConfig)

  // Two-level write lock: an in-process promise chain serializes calls within
  // this instance, then a cross-process advisory lock (proper-lockfile, mkdir
  // based — works on network/drvfs mounts) serializes against other hafez
  // processes sharing the vault (concurrent CLIs, a bot, another agent).
  let lockPromise: Promise<void> = Promise.resolve()
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lockPromise
    let release: () => void
    lockPromise = new Promise(resolve => { release = resolve })
    return prev.then(() => withVaultLock(fn)).finally(() => release!())
  }

  async function withVaultLock<T>(fn: () => Promise<T>): Promise<T> {
    let releaseVault: (() => Promise<void>) | null = null
    try {
      releaseVault = await lockVault(vaultPath, {
        lockfilePath: join(vaultPath, '.hafez.lock'),
        stale: 30_000,
        retries: { retries: 20, minTimeout: 100, maxTimeout: 1_000, randomize: true },
      })
    } catch (err) {
      throw new HafezError(
        'VAULT_LOCKED',
        'Vault is locked by another hafez process. Retry when it finishes.',
        [err instanceof Error ? err.message : String(err)]
      )
    }
    try {
      return await fn()
    } finally {
      try { await releaseVault() } catch { /* stale lock reclaimed by another process */ }
    }
  }

  function entityPath(slug: string): string { return resolveFilePath(vaultPath, slug, 'entity') }
  function knowledgePath(slug: string): string { return resolveFilePath(vaultPath, slug, 'knowledge') }
  function findFile(slug: string): string | null {
    const ep = entityPath(slug)
    if (existsSync(ep)) return ep
    const kp = knowledgePath(slug)
    if (existsSync(kp)) return kp
    return null
  }
  function exists(slug: string): boolean {
    // An invalid slug definitionally doesn't exist — reference checks (create
    // parent/related, link targets, validate) must report "does not exist",
    // not crash. validate() in particular exists to REPORT malformed refs.
    try { return findFile(slug) !== null } catch { return false }
  }
  function today(): string { return new Date().toISOString().slice(0, 10) }

  const ENTITY_ONLY_FIELDS: (keyof UpdateFields)[] = ['status', 'add_action', 'add_actions', 'complete_action', 'remove_action', 'clear_actions', 'brief', 'current_state', 'session_log', 'resource']
  const KNOWLEDGE_ONLY_FIELDS: (keyof UpdateFields)[] = ['confidence', 'synthesis', 'add_evidence', 'add_source']

  function validateKindFields(kind: 'entity' | 'knowledge', fields: UpdateFields): void {
    if (kind === 'knowledge') {
      const invalid = ENTITY_ONLY_FIELDS.filter(f => fields[f] !== undefined)
      if (invalid.length > 0) {
        throw new HafezError('VALIDATION_FAILED', `Cannot set entity-only fields on knowledge note: ${invalid.join(', ')}`)
      }
    }
    if (kind === 'entity') {
      const invalid = KNOWLEDGE_ONLY_FIELDS.filter(f => fields[f] !== undefined)
      if (invalid.length > 0) {
        throw new HafezError('VALIDATION_FAILED', `Cannot set knowledge-only fields on entity: ${invalid.join(', ')}`)
      }
    }
  }

  function regenerateIndexSafe(): void {
    // Runs post-commit: the vault write is already persisted/pushed, so an
    // index.md failure must warn, never reject the operation.
    try {
      generateVaultIndex(vaultPath)
    } catch (err) {
      process.stderr.write(`Warning: failed to regenerate index.md: ${(err as Error).message}\n`)
    }
  }

  // Shared by create(), batch(), and the batch validate phase so optional
  // fields can't silently diverge between paths (see CLAUDE.md Validation
  // Gotchas). `existsFn` is pluggable so validateBatchCore can supply a
  // simulation-aware check (same-batch creates count as existing).
  function buildEntityFrontmatter(name: string, ef: CreateEntityFields, existsFn: (slug: string) => boolean = exists): Record<string, any> {
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
    if (ef.resource) fm.resource = ef.resource
    const errors = validateEntityFrontmatter(fm)
    if (errors.length > 0) throw new HafezError('VALIDATION_FAILED', 'Invalid entity frontmatter', errors)
    return fm
  }

  // Shared by create() and batch() like buildEntityFrontmatter — body-side
  // optional fields (brief, actions) must behave identically in both paths.
  function buildEntityBody(ef: CreateEntityFields): string {
    let body = bodyTemplate(ef.type, { purpose: ef.purpose })
    if (ef.brief) body = setBrief(body, ef.brief)
    if (ef.add_action) body = addNextAction(body, ef.add_action)
    for (const action of ef.add_actions ?? []) body = addNextAction(body, action)
    return body
  }

  function buildKnowledgeFrontmatter(name: string, kf: CreateKnowledgeFields, existsFn: (slug: string) => boolean = exists): Record<string, any> {
    const fm: Record<string, any> = { name, confidence: 'observation', 'reinforcement-count': 0, created: today() }
    if (kf.domain?.length) fm.domain = kf.domain
    if (kf.related?.length) {
      for (const r of kf.related) {
        if (!existsFn(r)) throw new HafezError('VALIDATION_FAILED', `Related slug '${r}' does not exist`)
      }
      fm.related = kf.related
    }
    if (kf.tags?.length) fm.tags = kf.tags
    if (kf.description) fm.description = kf.description
    const errors = validateKnowledgeFrontmatter(fm)
    if (errors.length > 0) throw new HafezError('VALIDATION_FAILED', 'Invalid knowledge frontmatter', errors)
    if (kf.subtype) fm.subtype = kf.subtype
    if (kf['session-date']) fm['session-date'] = kf['session-date']
    return fm
  }

  function applyUpdateFields(fm: Record<string, any>, body: string, fields: UpdateFields): { fm: Record<string, any>; body: string; matchedAction?: string } {
    // Enum checks mirror the batch Zod shapes — without them the direct CLI
    // path writes invalid values straight into frontmatter.
    if (fields.status !== undefined) {
      if (!(ENTITY_STATUSES as readonly string[]).includes(fields.status)) {
        throw new HafezError('VALIDATION_FAILED', `Invalid status '${fields.status}'. Valid: ${ENTITY_STATUSES.join(', ')}`)
      }
      fm.status = fields.status
    }
    if (fields.current_state !== undefined) {
      body = setSection(body, 'Current State', fields.current_state, 'Session Log')
    }
    if (fields.brief !== undefined) {
      body = fields.brief === null ? removeBrief(body) : setBrief(body, fields.brief)
    }
    let matchedAction: string | undefined
    if (fields.add_action) body = addNextAction(body, fields.add_action)
    if (fields.add_actions) {
      for (const action of fields.add_actions) {
        body = addNextAction(body, action)
      }
    }
    if (fields.complete_action) {
      const r = completeNextAction(body, fields.complete_action); body = r.body; matchedAction = r.matched
    }
    if (fields.remove_action) {
      const r = removeNextAction(body, fields.remove_action); body = r.body; matchedAction = r.matched
    }
    if (fields.clear_actions) body = clearNextActions(body)
    if (fields.session_log) {
      const logErrors = validateSessionLogEntry(fields.session_log)
      if (logErrors.length > 0) throw new HafezError('VALIDATION_FAILED', 'Invalid session log entry', logErrors)
      body = prependSessionLogEntry(body, formatSessionLogEntry(fields.session_log))
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
      if (fields.resource === '' || fields.resource === null) delete fm.resource
      else fm.resource = fields.resource
    }
    if (fields.confidence !== undefined) {
      if (!(CONFIDENCE_LEVELS as readonly string[]).includes(fields.confidence)) {
        throw new HafezError('VALIDATION_FAILED', `Invalid confidence '${fields.confidence}'. Valid: ${CONFIDENCE_LEVELS.join(', ')}`)
      }
      fm.confidence = fields.confidence
    }
    if (fields.tags !== undefined) fm.tags = fields.tags
    if (fields.related !== undefined) {
      for (const r of fields.related) {
        if (!exists(r)) throw new HafezError('VALIDATION_FAILED', `Related slug '${r}' does not exist`)
      }
      fm.related = fields.related
    }
    if (fields.synthesis !== undefined) {
      body = setSection(body, 'Synthesis', fields.synthesis)
    }
    if (fields.add_evidence) {
      const sanitized = fields.add_evidence.replace(/^#{1,2}\s/gm, '### ')
      body = appendToSection(body, 'Evidence', sanitized)
      fm['reinforcement-count'] = (fm['reinforcement-count'] ?? 0) + 1
      fm['last-reinforced'] = today()
      // NOTE: Confidence auto-promotion (observation→pattern at count>=3) was intentionally
      // removed. Confidence changes are now a deliberate decision via update --confidence.
    }
    if (fields.add_source) {
      body = appendToSection(body, 'Sources', fields.add_source)
    }
    if (fm['last-touched'] !== today()) fm['last-touched'] = today()
    return { fm, body, matchedAction }
  }

  let _index: HafezIndex | null = null
  let _indexInitialized = false
  function getIndex(): HafezIndex | null {
    if (!_indexInitialized) {
      _index = readOnly ? createIndex(vaultPath, { readonly: true }) : createIndex(vaultPath)
      // A null read-only open means the on-disk index is missing or from another
      // schema version. Don't latch it: retry on the next call so a long-lived
      // read-only instance starts serving once a write-capable process rebuilds.
      _indexInitialized = !readOnly || _index !== null
    }
    return _index
  }

  async function read(slug: string, depth: ReadDepth = 'summary'): Promise<ParsedFile> {
    const filePath = findFile(slug)
    if (!filePath) throw new HafezError('NOT_FOUND', `Entity or knowledge '${slug}' not found`)
    const parsed = parseFilePath(filePath)
    // findFile only resolves the indexed kinds, so the session arm is unreachable
    const kind = parsed.kind === 'session' ? 'knowledge' : parsed.kind
    const frontmatter = parsed.frontmatter as ParsedFile['frontmatter']
    const body = parsed.body
    if (depth === 'frontmatter') return { kind, frontmatter, body: '' }
    if (depth === 'summary') {
      return { kind, frontmatter, body: bodyBeforeSessionLog(body) }
    }
    return { kind, frontmatter, body }
  }

  function rollbackFiles(originals: Map<string, string | null>): void {
    for (const [path, content] of originals) {
      if (content === null) {
        try { unlinkSync(path) } catch {}
      } else {
        writeFileSync(path, content)
      }
    }
  }

  // All SQLite writes happen here, strictly after the git commit succeeded.
  // A failed commit rolls back files only — the index was never touched, so
  // files, git, and index stay consistent (pre-collapse, promote removed its
  // index row mid-apply and a rollback lost it).
  function updateIndexPostCommit(applied: AppliedOp[]): void {
    for (const a of applied) {
      for (const slug of a.indexRemovals) getIndex()!.removeItem(slug)
      for (const u of a.indexUpserts) getIndex()!.upsertFromFile(u.slug, u.kind)
    }
  }

  // The single apply path for every mutation. Writes vault files but never
  // touches git or SQLite: callers commit [...filesWritten, ...filesDeleted]
  // under commitMessage (single ops) or one composed batch message, then run
  // updateIndexPostCommit. captureOriginal lets batch() snapshot files for
  // rollback before they change.
  function applyOperation(op: BatchOperation, captureOriginal: (path: string) => void = () => {}): AppliedOp {
    if (op.op === 'update') {
      const filePath = findFile(op.slug)
      if (!filePath) throw new HafezError('NOT_FOUND', `'${op.slug}' not found`)
      captureOriginal(filePath)
      const kind = kindFromPath(filePath)
      validateKindFields(kind, op.fields)

      const parsedFile = parseFilePath(filePath)
      let fm = parsedFile.frontmatter as Record<string, any>
      let body = parsedFile.body
      const applied = applyUpdateFields(fm, body, op.fields)
      fm = applied.fm
      body = applied.body

      // Session log archival
      const archivePath = archiveLogPath(vaultPath, op.slug)
      if (countSessionLogEntries(body) >= 10) {
        const extracted = extractOldestSessionLogEntry(body)
        if (extracted) {
          captureOriginal(archivePath)
          mkdirSync(dirname(archivePath), { recursive: true })
          appendFileSync(archivePath, extracted.entry + '\n\n')
          body = extracted.remaining
        }
      }

      body = syncRelatedSection(body, fm)
      writeFileSync(filePath, serializeFile(fm, body))

      const files = [relative(vaultPath, filePath)]
      if (existsSync(archivePath)) files.push(relative(vaultPath, archivePath))

      return {
        filesWritten: files,
        filesDeleted: [],
        result: { op: 'update', slug: op.slug, status: 'ok' },
        commitMessage: `update: ${op.slug}`,
        indexRemovals: [],
        indexUpserts: [{ slug: op.slug, kind }],
        matchedAction: applied.matchedAction,
      }
    }

    if (op.op === 'create' && op.kind === 'session') {
      const slug = slugify(op.name)
      if (exists(slug)) {
        return {
          filesWritten: [], filesDeleted: [],
          result: { op: 'create', slug, status: 'error', error: `Slug '${slug}' already exists in the vault` },
          commitMessage: `create: ${op.name}`, indexRemovals: [], indexUpserts: [],
        }
      }
      const sessionDir = join(vaultPath, kindDir('session'))
      mkdirSync(sessionDir, { recursive: true })
      const filePath = join(sessionDir, `${slug}.md`)
      if (existsSync(filePath)) {
        return {
          filesWritten: [], filesDeleted: [],
          result: { op: 'create', slug, status: 'error', error: `Session '${slug}' already exists` },
          commitMessage: `create: ${op.name}`, indexRemovals: [], indexUpserts: [],
        }
      }
      captureOriginal(filePath)
      const fm: Record<string, any> = { name: op.name, created: today() }
      const kf = (op.fields ?? {}) as CreateKnowledgeFields
      if (kf['session-date']) fm['session-date'] = kf['session-date']
      if (kf.related?.length) fm.related = kf.related
      // Session files use sections: Summary, Entities Touched, Decisions
      const sections = ['Summary', 'Entities Touched', 'Decisions']
      const lines: string[] = []
      for (const section of sections) {
        lines.push(`## ${section}`)
        if (section === 'Summary' && kf.synthesis) lines.push('', kf.synthesis)
        lines.push('')
      }
      let sessionBody = lines.join('\n')
      sessionBody = syncRelatedSection(sessionBody, fm)
      writeFileSync(filePath, serializeFile(fm, sessionBody))
      // Sessions are not indexed (db.ts only scans entities/ and knowledge/).
      // They ARE included in git semantic merge (git.ts VAULT_FILE_RE).
      return {
        filesWritten: [relative(vaultPath, filePath)],
        filesDeleted: [],
        result: { op: 'create', slug, status: 'ok', created: true },
        commitMessage: `create: ${op.name}`,
        indexRemovals: [],
        indexUpserts: [],
      }
    }

    if (op.op === 'create') {
      const slug = slugify(op.name)
      if (exists(slug)) throw new HafezError('SLUG_EXISTS', `Slug '${slug}' already exists`)

      if (op.kind === 'entity') {
        const ef = op.fields
        const fm = buildEntityFrontmatter(op.name, ef)
        let body = buildEntityBody(ef)
        const filePath = entityPath(slug)
        captureOriginal(filePath)
        mkdirSync(join(vaultPath, kindDir('entity')), { recursive: true })
        body = syncRelatedSection(body, fm)
        writeFileSync(filePath, serializeFile(fm, body))
        return {
          filesWritten: [relative(vaultPath, filePath)],
          filesDeleted: [],
          result: { op: 'create', slug, status: 'ok', created: true },
          commitMessage: `create: ${op.name}`,
          indexRemovals: [],
          indexUpserts: [{ slug, kind: 'entity' }],
        }
      }

      const kf = (op.fields || {}) as CreateKnowledgeFields
      const fm = buildKnowledgeFrontmatter(op.name, kf)
      let body = knowledgeBodyTemplate(kf.subtype, { synthesis: kf.synthesis })
      const filePath = knowledgePath(slug)
      captureOriginal(filePath)
      mkdirSync(join(vaultPath, kindDir('knowledge')), { recursive: true })
      body = syncRelatedSection(body, fm)
      writeFileSync(filePath, serializeFile(fm, body))
      return {
        filesWritten: [relative(vaultPath, filePath)],
        filesDeleted: [],
        result: { op: 'create', slug, status: 'ok', created: true },
        commitMessage: `create: ${op.name}`,
        indexRemovals: [],
        indexUpserts: [{ slug, kind: 'knowledge' }],
      }
    }

    if (op.op === 'capture') {
      const slug = slugify(op.name)
      if (exists(slug)) throw new HafezError('SLUG_EXISTS', `Slug '${slug}' already exists`)
      const fm: Record<string, any> = {
        name: op.name,
        type: 'capture',
        status: 'active',
        created: today(),
        'last-touched': today(),
      }
      const filePath = entityPath(slug)
      captureOriginal(filePath)
      mkdirSync(join(vaultPath, kindDir('entity')), { recursive: true })
      writeFileSync(filePath, serializeFile(fm, bodyTemplate('capture', { notes: op.notes })))
      return {
        filesWritten: [relative(vaultPath, filePath)],
        filesDeleted: [],
        result: { op: 'capture', slug, status: 'ok', created: true },
        commitMessage: `capture: ${op.name}`,
        indexRemovals: [],
        indexUpserts: [{ slug, kind: 'entity' }],
      }
    }

    if (op.op === 'link') {
      const filePath = findFile(op.slug)
      if (!filePath) throw new HafezError('NOT_FOUND', `'${op.slug}' not found`)
      if (!exists(op.target)) throw new HafezError('VALIDATION_FAILED', `Target '${op.target}' does not exist`)
      captureOriginal(filePath)

      const parsedFile = parseFilePath(filePath)
      const fm = parsedFile.frontmatter as Record<string, any>
      let body = parsedFile.body

      if (op.relation === 'parent') {
        fm.parent = op.target
      } else {
        const related = fm.related || []
        if (!related.includes(op.target)) related.push(op.target)
        fm.related = related
      }

      body = syncRelatedSection(body, fm)
      writeFileSync(filePath, serializeFile(fm, body))
      return {
        filesWritten: [relative(vaultPath, filePath)],
        filesDeleted: [],
        result: { op: 'link', slug: op.slug, status: 'ok' },
        commitMessage: `link: ${op.slug} → ${op.target} (${op.relation})`,
        indexRemovals: [],
        indexUpserts: [{ slug: op.slug, kind: kindFromPath(filePath) }],
      }
    }

    if (op.op === 'unlink') {
      const filePath = findFile(op.slug)
      if (!filePath) throw new HafezError('NOT_FOUND', `'${op.slug}' not found`)
      captureOriginal(filePath)

      const parsedFile = parseFilePath(filePath)
      const fm = parsedFile.frontmatter as Record<string, any>
      let body = parsedFile.body

      if (op.relation === 'parent' && fm.parent === op.target) {
        delete fm.parent
      } else if (op.relation === 'related' && fm.related) {
        fm.related = fm.related.filter((r: string) => r !== op.target)
        if (fm.related.length === 0) delete fm.related
      }

      body = syncRelatedSection(body, fm)
      writeFileSync(filePath, serializeFile(fm, body))
      return {
        filesWritten: [relative(vaultPath, filePath)],
        filesDeleted: [],
        result: { op: 'unlink', slug: op.slug, status: 'ok' },
        commitMessage: `unlink: ${op.slug} ✕ ${op.target} (${op.relation})`,
        indexRemovals: [],
        indexUpserts: [{ slug: op.slug, kind: kindFromPath(filePath) }],
      }
    }

    // promote
    const filePath = findFile(op.slug)
    if (!filePath) throw new HafezError('NOT_FOUND', `'${op.slug}' not found`)
    captureOriginal(filePath)
    if (op.target === 'knowledge') captureOriginal(knowledgePath(op.slug))
    const kind = kindFromPath(filePath)
    const parsedFile = parseFilePath(filePath)
    const fm = parsedFile.frontmatter as Record<string, any>
    const body = parsedFile.body
    const sourceType = kind === 'knowledge' ? 'knowledge' : (fm.type as string)
    const { modifiedFiles, deletedFiles } = promoteCore(op.slug, op.target, filePath, fm, body, kind)
    return {
      filesWritten: modifiedFiles,
      filesDeleted: deletedFiles,
      result: { op: 'promote', slug: op.slug, status: 'ok' },
      commitMessage: `promote: ${op.slug} ${sourceType} → ${op.target}`,
      indexRemovals: op.target === 'knowledge' ? [op.slug] : [],
      indexUpserts: [{ slug: op.slug, kind: op.target === 'knowledge' ? 'knowledge' : 'entity' }],
    }
  }

  async function create(kind: 'entity', name: string, fields: CreateEntityFields): Promise<string>
  async function create(kind: 'knowledge', name: string, fields?: CreateKnowledgeFields): Promise<string>
  async function create(kind: 'entity' | 'knowledge', name: string, fields?: CreateEntityFields | CreateKnowledgeFields): Promise<string> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const a = kind === 'entity'
        ? applyOperation({ op: 'create', kind, name, fields: fields as CreateEntityFields })
        : applyOperation({ op: 'create', kind, name, fields: fields as CreateKnowledgeFields | undefined })
      await journal.commit(a.filesWritten, a.filesDeleted, a.commitMessage)
      updateIndexPostCommit([a])
      onWrite?.(a.result.slug, 'create')
      regenerateIndexSafe()
      return a.result.slug
    })
  }

  async function capture(name: string, notes?: string): Promise<string> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const a = applyOperation({ op: 'capture', name, notes })
      await journal.commit(a.filesWritten, a.filesDeleted, a.commitMessage)
      updateIndexPostCommit([a])
      regenerateIndexSafe()
      onWrite?.(a.result.slug, 'capture')
      return a.result.slug
    })
  }

  async function update(slug: string, fields: UpdateFields) {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const a = applyOperation({ op: 'update', slug, fields })
      await journal.commit(a.filesWritten, a.filesDeleted, a.commitMessage)
      updateIndexPostCommit([a])
      regenerateIndexSafe()
      onWrite?.(slug, 'update')
      return { matched_action: a.matchedAction }
    })
  }

  async function link(slug: string, target: string, relation: LinkRelation): Promise<void> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const a = applyOperation({ op: 'link', slug, target, relation })
      await journal.commit(a.filesWritten, a.filesDeleted, a.commitMessage)
      updateIndexPostCommit([a])
      regenerateIndexSafe()
      onWrite?.(slug, 'link')
    })
  }

  async function unlink(slug: string, target: string, relation: LinkRelation): Promise<void> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const a = applyOperation({ op: 'unlink', slug, target, relation })
      await journal.commit(a.filesWritten, a.filesDeleted, a.commitMessage)
      updateIndexPostCommit([a])
      regenerateIndexSafe()
      onWrite?.(slug, 'unlink')
    })
  }

  // "Recent" with day-granularity dates: primary sort is the frontmatter day,
  // ties break on git commit time (the real recency signal), then name for
  // files with no commit history yet. Without this the top-5 lists leak
  // SQLite row order — a brand-new vault (everything same-day) showed
  // alphabetical-and-missing-newest lists.
  async function rankRecents<T extends { slug: string; name: string }>(
    rows: T[],
    dateKey: 'last_touched' | 'created',
    mode: 'modified' | 'added',
  ): Promise<T[]> {
    const day = (r: T) => (r as Record<string, any>)[dateKey] as string
    if (rows.length <= 1) return rows
    // Everything sharing the 5th row's day (or newer) could land in the top 5
    const cutoffDay = day(rows[Math.min(4, rows.length - 1)])
    const candidates = rows.filter(r => day(r) >= cutoffDay)
    const hasTies = new Set(candidates.map(day)).size < candidates.length
    if (!hasTies) return rows.slice(0, 5)
    const times = await journal.fileTimes(mode)
    const gitTime = (r: T) => times.get(`${kindDir('entity')}/${r.slug}.md`) ?? ''
    candidates.sort((a, b) => {
      const dayCmp = day(b).localeCompare(day(a))
      if (dayCmp !== 0) return dayCmp
      const gitCmp = gitTime(b).localeCompare(gitTime(a)) // '' (uncommitted) sorts last
      if (gitCmp !== 0) return gitCmp
      return a.name.localeCompare(b.name)
    })
    return candidates.slice(0, 5)
  }

  // Shared validate phase — dry-run and apply both run this, so dry-run can
  // never pass a payload apply rejects (parity by construction). Simulates
  // creates so same-batch references validate: batch executes sequentially,
  // so op N really does see op 1's creates on disk at apply time.
  function validateBatchCore(operations: BatchOperation[]): BatchValidationReport {
    // slug → what it would be after earlier ops in this batch
    const simulated = new Map<string, { kind: 'entity' | 'knowledge'; type: string }>()
    const simulatedSessions = new Set<string>()
    const existsAnywhere = (slug: string) => simulated.has(slug) || exists(slug)

    // Vault context for the Op Spec table's semantic checks (src/batch-ops.ts).
    const ctx: OpCheckContext = {
      resolve: (slug) => {
        const sim = simulated.get(slug)
        if (sim) return sim
        const fp = findFile(slug)
        if (!fp) return null
        const kind = kindFromPath(fp)
        if (kind === 'knowledge') return { kind, type: 'knowledge' }
        try {
          const pf = parseFilePath(fp)
          return { kind, type: pf.kind === 'entity' ? pf.frontmatter.type : 'entity' }
        } catch { return { kind, type: 'entity' } }
      },
      existsAnywhere,
      sessionExists: (slug) => existsSync(join(vaultPath, kindDir('session'), `${slug}.md`)) || simulatedSessions.has(slug),
      simulate: (slug, info) => { simulated.set(slug, info) },
      simulateSession: (slug) => { simulatedSessions.add(slug) },
      validateKindFields,
      validateSessionLogEntry: (entry) => validateSessionLogEntry(entry),
      buildEntityFrontmatter: (name, fields) => { buildEntityFrontmatter(name, fields, existsAnywhere) },
      buildKnowledgeFrontmatter: (name, fields) => { buildKnowledgeFrontmatter(name, fields, existsAnywhere) },
    }

    const report: BatchOpValidation[] = []
    for (const [index, op] of operations.entries()) {
      // Shape and semantics in one pass: library callers get the same runtime
      // guarantee the CLI's JSON path has always had.
      const shape = BatchOperationSchema.safeParse(op)
      if (!shape.success) {
        const raw = op as Record<string, unknown> | undefined
        const label = raw && typeof raw.slug === 'string' ? raw.slug
          : raw && typeof raw.name === 'string' ? slugify(raw.name) : ''
        report.push({
          index,
          op: typeof raw?.op === 'string' ? raw.op : '?',
          slug: label,
          errors: shape.error.issues.map(i => `invalid shape at ${i.path.join('.') || '(root)'}: ${i.message}`),
        })
        continue
      }
      const spec = specFor(op)
      const res = spec.check(op, ctx)
      const entry: BatchOpValidation = { index, op: op.op, slug: res.slug, errors: res.errors }
      if (res.created) entry.created = true
      if (res.warning) entry.warning = res.warning
      report.push(entry)
    }

    return { valid: report.every(o => o.errors.length === 0), operations: report }
  }

  function formatOpErrors(report: BatchValidationReport): string[] {
    return report.operations.flatMap(o => o.errors.map(e => `op[${o.index}] (${o.op} ${o.slug}): ${e}`))
  }

  async function batch(operations: BatchOperation[]): Promise<BatchResult[]> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      // Validate the whole payload before touching anything — all errors
      // surface at once, localised to their op.
      const validation = validateBatchCore(operations)
      if (!validation.valid) {
        const invalidCount = validation.operations.filter(o => o.errors.length > 0).length
        throw new HafezError(
          'VALIDATION_FAILED',
          `Batch failed validation: ${invalidCount} invalid operation${invalidCount === 1 ? '' : 's'} (0 of ${operations.length} applied)`,
          formatOpErrors(validation),
        )
      }

      // Capture originals for rollback
      const originals = new Map<string, string | null>()
      function captureOriginal(filePath: string) {
        if (!originals.has(filePath)) {
          originals.set(filePath, existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null)
        }
      }

      const appliedOps: AppliedOp[] = []
      const results: BatchResult[] = []

      let currentOp = -1
      try {
        for (const op of operations) {
          currentOp++
          const a = applyOperation(op, captureOriginal)
          results.push(a.result)
          if (a.result.status === 'ok') appliedOps.push(a)
        }
      } catch (err) {
        rollbackFiles(originals)
        // Localise: which op failed, by index and slug/name. The validate
        // phase above catches semantic errors pre-execution; this covers
        // residual execution-time failures (races, disk errors).
        if (err instanceof HafezError && currentOp >= 0) {
          const op = operations[currentOp]
          const label = 'slug' in op ? op.slug : slugify(op.name)
          throw new HafezError(err.code, `op[${currentOp}] (${op.op} ${label}): ${err.message}`, err.details)
        }
        throw err
      }

      // Single journal commit for all batch operations
      const writtenAll = [...new Set(appliedOps.flatMap(a => a.filesWritten))]
      const deletedAll = [...new Set(appliedOps.flatMap(a => a.filesDeleted))]

      const indexAfterBatch = () => {
        updateIndexPostCommit(appliedOps)
        // Regenerate vault index if any entity or knowledge was touched (session-only batches skip)
        const anyIndexedTouched = [...writtenAll, ...deletedAll].some(isIndexedRelPath)
        if (anyIndexedTouched) {
          regenerateIndexSafe()
        }
        // Session creates carry no index upserts — they were never notified
        // pre-collapse either (sessions aren't indexed entities).
        for (const a of appliedOps) {
          if (a.indexUpserts.length > 0) onWrite?.(a.result.slug, 'batch')
        }
      }

      if (writtenAll.length + deletedAll.length > 0) {
        try {
          await journal.commit(writtenAll, deletedAll, `batch: ${operations.length} operations`)
        } catch (err) {
          if (!(err instanceof HafezError && err.code === 'GIT_PUSH_FAILED')) {
            // Commit-stage failure (e.g. a raced .git/index.lock): nothing was
            // committed — restore the captured originals so files, journal,
            // and index stay consistent instead of leaving the batch
            // half-applied. The adapter has already cleaned up its own
            // partial state (staged files) before rethrowing.
            rollbackFiles(originals)
            throw err
          }
          // Push-stage failure: the batch commit exists locally ("changes
          // saved locally") — keep it and index it, then surface the error.
          indexAfterBatch()
          throw err
        }
        indexAfterBatch()
      }
      return results
    })
  }

  async function validate(): Promise<ValidationReport> {
    const report: ValidationReport = {
      broken_slugs: [],
      orphaned_knowledge: [],
      oversized_related: [],
      missing_fields: [],
      total_entities: 0,
      total_knowledge: 0,
    }

    const allSlugs = new Set<string>()
    const knowledgeSlugs = new Set<string>()
    const referencedKnowledge = new Set<string>()

    // Scan entities
    const entDir = join(vaultPath, kindDir('entity'))
    {
      const files = scanVaultDir(entDir)
      report.total_entities = files.length
      for (const filePath of files) {
        const slug = basename(filePath, '.md')
        allSlugs.add(slug)
        let fm: Record<string, any>
        try {
          fm = parseFilePath(filePath).frontmatter
        } catch {
          report.missing_fields.push({ slug, field: '', issue: 'failed to parse frontmatter' })
          continue
        }

        const errors = validateEntityFrontmatter(fm)
        for (const e of errors) report.missing_fields.push({ slug, field: '', issue: e })

        if (fm.parent) {
          if (!exists(fm.parent)) report.broken_slugs.push({ slug, field: 'parent', issue: `parent '${fm.parent}' does not exist` })
        }
        if (fm.related && Array.isArray(fm.related)) {
          for (const r of fm.related) {
            if (!exists(r)) report.broken_slugs.push({ slug, field: 'related', issue: `related '${r}' does not exist` })
            // Track referenced knowledge
            referencedKnowledge.add(r)
          }
        }
      }
    }

    // Scan knowledge
    const knDir = join(vaultPath, kindDir('knowledge'))
    {
      const files = scanVaultDir(knDir)
      report.total_knowledge = files.length
      for (const filePath of files) {
        const slug = basename(filePath, '.md')
        allSlugs.add(slug)
        knowledgeSlugs.add(slug)
        let fm: Record<string, any>
        try {
          fm = parseFilePath(filePath).frontmatter
        } catch {
          report.missing_fields.push({ slug, field: '', issue: 'failed to parse frontmatter' })
          continue
        }

        const errors = validateKnowledgeFrontmatter(fm)
        for (const e of errors) report.missing_fields.push({ slug, field: '', issue: e })

        if (fm.related && Array.isArray(fm.related)) {
          for (const r of fm.related) {
            if (!exists(r)) report.broken_slugs.push({ slug, field: 'related', issue: `related '${r}' does not exist` })
          }
        }
      }
    }

    // Find orphaned knowledge: no related, and not referenced by any entity
    for (const slug of knowledgeSlugs) {
      let fm: Record<string, any>
      try {
        fm = parseFilePath(join(knDir, `${slug}.md`)).frontmatter
      } catch {
        continue // already reported above
      }
      const hasRelated = fm.related && Array.isArray(fm.related) && fm.related.length > 0
      if (!hasRelated && !referencedKnowledge.has(slug)) {
        report.orphaned_knowledge.push(slug)
      }
    }

    return report
  }

  function promoteCore(
    slug: string,
    target: 'entity' | 'project' | 'knowledge',
    filePath: string,
    fm: Record<string, any>,
    body: string,
    kind: 'entity' | 'knowledge'
  ): { modifiedFiles: string[]; deletedFiles: string[] } {
    const currentType = kind === 'knowledge' ? 'knowledge' : (fm.type as string)
    const contract = getContract(currentType)
    if (!contract.canPromoteTo.includes(target)) {
      throw new HafezError('VALIDATION_FAILED', `Cannot promote ${currentType} to ${target}. Valid targets: ${contract.canPromoteTo.join(', ') || 'none (terminal type)'}`)
    }

    const modifiedFiles: string[] = []
    const deletedFiles: string[] = []

    if (target === 'knowledge') {
      // Cross-kind: move file from entities/ to knowledge/
      const newPath = knowledgePath(slug)
      const notesSection = findSection(body, 'Notes')
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
      const finalBody = syncRelatedSection(knBody, newFm)
      writeFileSync(newPath, serializeFile(newFm, finalBody))
      unlinkSync(filePath)
      modifiedFiles.push(relative(vaultPath, newPath))
      // The deletion must be staged too — `git add` of a removed path stages
      // the removal; omitting it leaves the vault permanently dirty.
      deletedFiles.push(relative(vaultPath, filePath))
    } else {
      // Same-kind: capture→entity, capture→project, entity→project
      fm.type = target
      fm['last-touched'] = today()

      let newBody = body
      if (target === 'entity') {
        newBody = newBody.replace(/^## Notes$/m, '## Context')
      } else {
        // project
        newBody = newBody.replace(/^## Notes$/m, '## Purpose')
        newBody = newBody.replace(/^## Context$/m, '## Purpose')
        if (!newBody.includes('## Goals')) {
          const sections = newBody.split(/\n(?=## )/m)
          const purposeIdx = sections.findIndex(s => s.startsWith('## Purpose'))
          if (purposeIdx !== -1) {
            sections.splice(purposeIdx + 1, 0, '## Goals\n')
          } else {
            sections.push('## Goals\n')
          }
          newBody = sections.join('\n')
        }
      }
      if (!newBody.includes('## Session Log')) newBody += '\n## Session Log\n'

      // Add promotion session log entry
      const logEntry = `### ${today()} — system [decision]\nSummary: Promoted from ${currentType} to ${target}\n`
      const logIdx = newBody.lastIndexOf('## Session Log')
      if (logIdx !== -1) {
        const insertAt = logIdx + '## Session Log'.length + 1
        newBody = newBody.slice(0, insertAt) + '\n' + logEntry + newBody.slice(insertAt)
      }

      newBody = syncRelatedSection(newBody, fm)
      writeFileSync(filePath, serializeFile(fm, newBody))
      modifiedFiles.push(relative(vaultPath, filePath))
    }

    return { modifiedFiles, deletedFiles }
  }

  async function promote(slug: string, target: 'entity' | 'project' | 'knowledge'): Promise<string> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const filePath = findFile(slug)
      if (!filePath) throw new HafezError('NOT_FOUND', `'${slug}' not found`)

      // Capture original content for rollback
      const originalContent = target === 'knowledge' ? readFileSync(filePath, 'utf-8') : null
      const knowledgeTarget = target === 'knowledge' ? knowledgePath(slug) : null

      let a: ReturnType<typeof applyOperation> | undefined
      try {
        a = applyOperation({ op: 'promote', slug, target })
        await journal.commit(a.filesWritten, a.filesDeleted, a.commitMessage)
      } catch (err) {
        if (a && err instanceof HafezError && err.code === 'GIT_PUSH_FAILED') {
          // Push-stage failure: the promote commit exists locally — keep the
          // files and index them (same policy as batch); rolling back here
          // would leave the worktree contradicting HEAD.
          updateIndexPostCommit([a])
          regenerateIndexSafe()
          throw err
        }
        // Apply- or commit-stage failure: nothing was committed — restore.
        if (target === 'knowledge' && originalContent) {
          writeFileSync(filePath, originalContent)
          // Never unlink the file we just restored (SEC-4)
          if (knowledgeTarget && knowledgeTarget !== filePath && existsSync(knowledgeTarget)) unlinkSync(knowledgeTarget)
        }
        throw err
      }
      updateIndexPostCommit([a])
      regenerateIndexSafe()
      onWrite?.(slug, 'promote')
      return slug
    })
  }

  const emptyStats: VaultStats = {
    counts: { active: 0, paused: 0, done: 0 },
    by_type: { capture: 0, entity: 0, project: 0 },
    knowledge_count: 0,
    stale: [], no_next_action: [], recently_touched: [], recently_created: [],
  }

  return {
    read,
    update,
    promote,
    query: async (opts?: EntityQueryOpts) => {
      const idx = getIndex()
      if (!idx) return { items: [], total: 0 }
      return queryEntities(idx, opts)
    },
    queryUnified: async (opts?: EntityQueryOpts & { kind?: 'entity' | 'knowledge' | 'all' }) => {
      const idx = getIndex()
      if (!idx) return { items: [], total: 0 }
      return queryUnified(idx, opts)
    },
    create,
    capture,
    link,
    unlink,
    batch,
    validateBatch: async (operations: BatchOperation[]) => validateBatchCore(operations),
    sync: async () => {
      if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
      return withLock(() => journal.sync())
    },
    children: async (slug: string) => {
      const idx = getIndex()
      if (!idx) return { items: [], total: 0 }
      return queryChildren(idx, slug)
    },
    related_to: async (slug: string, relation?: string) => {
      const idx = getIndex()
      if (!idx) return { items: [], total: 0 }
      return queryRelatedTo(idx, slug, relation)
    },
    query_knowledge: async (opts?: KnowledgeQueryOpts) => {
      const idx = getIndex()
      if (!idx) return { items: [], total: 0 }
      return queryKnowledge(idx, opts)
    },
    validate,
    search: async (query: string, kind?: 'entity' | 'knowledge' | 'all'): Promise<SearchResult[]> => {
      const idx = getIndex()
      if (!idx) return []
      idx.syncIfStale()
      return idx.search(query, kind)
    },
    rebuildIndex: async () => {
      if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
      getIndex()!.rebuild()
    },
    stats: async () => {
      const idx = getIndex()
      if (!idx) return emptyStats
      idx.syncIfStale()
      const s = idx.getStats()
      s.recently_touched = await rankRecents(s.recently_touched, 'last_touched', 'modified')
      s.recently_created = await rankRecents(s.recently_created, 'created', 'added')
      return s
    },
    changelog: (since: string) => journal.changelog(since),
  }
}

export { HafezError } from './types.js'
export type { Hafez, HafezConfig, HafezErrorCode, EntityType, EntityStatus, EntityQueryOpts, KnowledgeQueryOpts, EntityFrontmatter, KnowledgeFrontmatter, ParsedFile, SessionLogEntry, UpdateFields, UpdateResult, CreateEntityFields, CreateKnowledgeFields, QueryFilter, QueryResult, KnowledgeQueryResult, UnifiedResult, ValidationReport, BatchOperation, BatchResult, ReadDepth, ConfidenceLevel, LinkRelation, GitConfig, Journal, SearchResult, VaultStats, ChangelogEntry, KnowledgeSubtype } from './types.js'
export { getBrief, getNextActions, findSection } from './document.js'
export { parseSessionLogHeading, parseSessionLog } from './document.js'

// src/index.ts
import { parseFilePath, slugify, kindFromPath, kindDir, isMutableRelPath, findVaultFile, findReadableFile, vaultFileExists, resolveFilePath, scanVaultDir, archiveLogPath, noteAtRelPath, MUTABLE_KINDS } from './vault.js'
import { createGitJournal } from './git.js'
import { validateSessionLogEntry } from './schema.js'
import { validateVault } from './validate.js'
import { healthReport } from './health.js'
import { documentForFile } from './document.js'
import { createIndex, type HafezIndex } from './db.js'
import { closestSlugs } from './closest.js'
import { generateVaultIndex } from './knowledge-index.js'
import type { Hafez, HafezConfig, DeletableKind, ReadDepth, ParsedFile, UpdateFields, CreateEntityFields, CreateKnowledgeFields, QueryFilter, EntityType, EntityQueryOpts, KnowledgeQueryOpts, SessionQueryOpts, UnifiedQueryOpts, LinkRelation, ConfidenceLevel, QueryResult, KnowledgeQueryResult, UnifiedResult, ValidationReport, HealthReport, BatchOperation, BatchResult, BatchOpValidation, BatchValidationReport, SearchResult, SearchKind, VaultStats, GraphOpts } from './types.js'
import { HafezError } from './types.js'
import type { InternalHafez, InternalHafezConfig } from './internal.js'
import { BatchOperationSchema, specFor, slugBearingOpNames, sessionAddressingOpNames, notFoundError, normalizeOperations, opErrorLine, batchInvalidHeader, type OpCheckContext, type ResolvedTarget, type FileLinks } from './batch-ops.js'
import { applyOperation, buildEntityFrontmatter, buildKnowledgeFrontmatter, validateKindFields, type AppliedOp } from './apply.js'
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs'
import { join, basename, resolve } from 'path'
import { lock as lockVault } from 'proper-lockfile'

export function createHafez(config: HafezConfig): Hafez {
  const { readOnly = false, git: gitConfig = {}, onWrite, indexSync = 'read' } = config as InternalHafezConfig
  // When reads catch the index up with the files (src/internal.ts, off the
  // public types): 'once' is the CLI's (#269), 'manual' the graph server's (#271).
  // Absolute from here on (#291): the Layout's kind match needs a separator
  // before the kind dir, which a relative vault ('.') never gives `entities/x.md`.
  const vaultPath = resolve(config.vaultPath)

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

  // Layout answers where a slug lives; these bind the vault path once.
  // Mutations resolve the mutable kinds; `read` reaches a session note too.
  function findFile(slug: string): string | null { return findVaultFile(vaultPath, slug) }
  function exists(slug: string): boolean { return vaultFileExists(vaultPath, slug) }

  function regenerateIndexSafe(): void {
    // Runs post-commit: the vault write is already persisted/pushed, so an
    // index.md failure must warn, never reject the operation.
    try {
      // index.md is rendered from the rows updateIndexPostCommit just
      // refreshed, not from a second full-vault read: everything it shows
      // (name, status, type, confidence, description, domain, body-derived
      // summary) is already indexed. syncIfStale first so files changed
      // outside hafez — a hand edit, a git pull — are represented too; that
      // costs a stat per file, where the old path paid a parse per file on
      // every single mutation.
      // Under 'once' the process's first read already caught up.
      const idx = getIndex()
      if (indexSync === 'once') idx?.syncForRead()
      else idx?.syncIfStale()
      generateVaultIndex(vaultPath, idx?.indexEntries())
    } catch (err) {
      process.stderr.write(`Warning: failed to regenerate index.md: ${(err as Error).message}\n`)
    }
  }

  let _index: HafezIndex | null = null
  let _indexInitialized = false
  function getIndex(): HafezIndex | null {
    if (!_indexInitialized) {
      _index = readOnly ? createIndex(vaultPath, { readonly: true, sync: indexSync }) : createIndex(vaultPath, { sync: indexSync })
      // A null read-only open means the on-disk index is missing or from another
      // schema version. Don't latch it: retry on the next call so a long-lived
      // read-only instance starts serving once a write-capable process rebuilds.
      _indexInitialized = !readOnly || _index !== null
    }
    return _index
  }

  // The one null-index guard: a read-only instance may have no on-disk index
  // yet — reads then return their empty shape instead of crashing.
  function withIndex<T>(fn: (idx: HafezIndex) => T, empty: T): T {
    const idx = getIndex()
    return idx ? fn(idx) : empty
  }

  async function read(slug: string, depth: ReadDepth = 'summary'): Promise<ParsedFile> {
    const filePath = findReadableFile(vaultPath, slug)
    if (!filePath) {
      // A miss carries the closest slugs as its details: the recovery the
      // `read` miss output renders (#91).
      const closest = withIndex(idx => { idx.syncForRead(); return closestSlugs(slug, idx.indexEntries()) }, [] as string[])
      throw new HafezError('NOT_FOUND', `Entity or knowledge '${slug}' not found`, closest)
    }
    const parsed = parseFilePath(filePath)
    if (depth === 'frontmatter') return { ...parsed, body: '' }
    if (depth === 'summary') {
      return { ...parsed, body: documentForFile(parsed).bodyBeforeSessionLog(parsed.body) }
    }
    return parsed
  }

  /** The archive is an attachment of its entity, reached from it on purpose
   * (#34): a disk read behind the entity's own slug, never an index row. */
  async function archive(slug: string): Promise<string | null> {
    const entity = resolveFilePath(vaultPath, slug, 'entity')
    if (!existsSync(entity)) throw new HafezError('NOT_FOUND', `Entity '${slug}' not found`)
    const path = archiveLogPath(vaultPath, slug)
    return existsSync(path) ? readFileSync(path, 'utf-8') : null
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

  // The Spine (CONTEXT.md): the one path every vault mutation takes —
  // validate (Op Spec) → apply → commit (Journal) → index. Single-op methods
  // run it with one op under that op's own commit message; batch() composes
  // many under one commit. The failure policy is uniform: a commit-stage
  // failure rolls the written files back (nothing landed); a push-stage
  // failure keeps the local commit, indexes it, and surfaces the error.
  type WriteAction = 'create' | 'capture' | 'update' | 'link' | 'unlink' | 'promote' | 'delete'

  async function runMutations(
    operations: BatchOperation[],
    single: { action: WriteAction } | null,
  ): Promise<{ applied: AppliedOp[]; results: BatchResult[] }> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    // Declared aliases (insight → synthesis) become canonical before anything
    // else reads the payload: validate and apply must never see different
    // field names, or an alias validates ok and then applies as nothing.
    operations = normalizeOperations(operations)
    return withLock(async () => {
      // Validate the whole payload before touching anything — all errors
      // surface at once, localised to their op. Single ops surface their
      // primary error class (NOT_FOUND / SLUG_EXISTS) as the thrown code.
      const validation = validateBatchCore(operations)
      if (!validation.valid) {
        if (single) {
          const opv = validation.operations[0]
          throw new HafezError(
            opv.primaryCode ?? 'VALIDATION_FAILED',
            opv.errors.length === 1 ? opv.errors[0] : opv.errors.join('; '),
            opv.errors.length > 1 ? opv.errors : undefined,
          )
        }
        const invalidCount = validation.operations.filter(o => o.errors.length > 0).length
        throw new HafezError(
          'VALIDATION_FAILED',
          batchInvalidHeader(invalidCount, operations.length),
          formatOpErrors(validation),
        )
      }

      // Apply receives the shape's output, not the raw payload, so a shape
      // transform lands in the file instead of existing only in the
      // validator's view.
      operations = validation.parsedOps

      // Capture originals for rollback
      const originals = new Map<string, string | null>()
      function captureOriginal(filePath: string) {
        if (!originals.has(filePath)) {
          originals.set(filePath, existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null)
        }
      }

      const applied: AppliedOp[] = []
      const results: BatchResult[] = []

      let currentOp = -1
      try {
        for (const op of operations) {
          currentOp++
          // A warned op is the validate phase's skip disposition (today: a
          // duplicate session — green-lit so the batch runs on, but nothing
          // to write). The Spine synthesizes the result rather than calling
          // Apply, so the rule lives only in the Op Spec. `code` rides along
          // for the single-op unwrap: that caller has nothing to return and
          // must throw under the target-exists class, not a generic one.
          const warning = validation.operations[currentOp].warning
          if (warning) {
            results.push({
              op: op.op, slug: validation.operations[currentOp].slug,
              status: 'skipped', warning, code: 'SLUG_EXISTS',
            })
            continue
          }
          const a = applyOperation(op, { vaultPath, captureOriginal })
          results.push(a.result)
          if (a.result.status === 'ok') applied.push(a)
        }
      } catch (err) {
        rollbackFiles(originals)
        // The validate phase above catches semantic errors pre-execution;
        // this localises residual execution-time failures (races, disk
        // errors) to their op in batch mode.
        if (!single && err instanceof HafezError && currentOp >= 0) {
          const op = operations[currentOp]
          const label = 'slug' in op ? op.slug : slugify(op.name)
          throw new HafezError(err.code, opErrorLine(currentOp, op.op, label, err.message), err.details)
        }
        throw err
      }

      // Batch reports per-op non-'ok' results; a single-op caller unwraps
      // applied[0], so anything that did not apply must surface as a thrown
      // error, not a TypeError on the unwrap — under the result's own error
      // class where it has one.
      if (single && applied.length === 0) {
        const failed = results.find(r => r.status !== 'ok')
        throw new HafezError(
          failed?.code ?? 'VALIDATION_FAILED',
          failed?.error || failed?.warning || 'operation was not applied',
        )
      }

      const writtenAll = [...new Set(applied.flatMap(a => a.filesWritten))]
      const deletedAll = [...new Set(applied.flatMap(a => a.filesDeleted))]

      const finalize = () => {
        updateIndexPostCommit(applied)
        // index.md shows the mutable kinds: a session-only write leaves it.
        if ([...writtenAll, ...deletedAll].some(isMutableRelPath)) {
          regenerateIndexSafe()
        }
        for (const a of applied) {
          if (a.indexUpserts.length > 0) onWrite?.(a.result.slug, single ? single.action : 'batch')
        }
      }

      if (writtenAll.length + deletedAll.length > 0) {
        const message = single ? applied[0].commitMessage : `batch: ${operations.length} operations`
        try {
          await journal.commit(writtenAll, deletedAll, message)
        } catch (err) {
          if (!(err instanceof HafezError && err.code === 'GIT_PUSH_FAILED')) {
            // Commit-stage failure (e.g. a raced .git/index.lock): nothing was
            // committed — restore the captured originals so files, journal,
            // and index stay consistent. The adapter has already cleaned up
            // its own partial state (staged files) before rethrowing.
            rollbackFiles(originals)
            throw err
          }
          // Push-stage failure: the commit exists locally ("changes saved
          // locally") — keep it and index it, then surface the error.
          finalize()
          throw err
        }
        finalize()
      }
      return { applied, results }
    })
  }

  async function create(kind: 'entity', name: string, fields: CreateEntityFields): Promise<string>
  async function create(kind: 'knowledge', name: string, fields?: CreateKnowledgeFields): Promise<string>
  async function create(kind: 'entity' | 'knowledge', name: string, fields?: CreateEntityFields | CreateKnowledgeFields): Promise<string> {
    const op: BatchOperation = kind === 'entity'
      ? { op: 'create', kind, name, fields: fields as CreateEntityFields }
      : { op: 'create', kind, name, fields: fields as CreateKnowledgeFields | undefined }
    const { applied } = await runMutations([op], { action: 'create' })
    return applied[0].result.slug
  }

  async function capture(name: string, notes?: string): Promise<string> {
    const { applied } = await runMutations([{ op: 'capture', name, notes }], { action: 'capture' })
    return applied[0].result.slug
  }

  async function update(slug: string, fields: UpdateFields) {
    const { applied } = await runMutations([{ op: 'update', slug, fields }], { action: 'update' })
    return applied[0].updateResult ?? {}
  }

  async function link(slug: string, target: string, relation: LinkRelation): Promise<void> {
    await runMutations([{ op: 'link', slug, target, relation }], { action: 'link' })
  }

  async function unlink(slug: string, target: string, relation: LinkRelation): Promise<void> {
    await runMutations([{ op: 'unlink', slug, target, relation }], { action: 'unlink' })
  }

  async function del(slug: string): Promise<DeletableKind> {
    const { applied } = await runMutations([{ op: 'delete', slug }], { action: 'delete' })
    return applied[0].deletedKind!
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
  function validateBatchCore(operations: BatchOperation[]): BatchValidationReport & { parsedOps: BatchOperation[] } {
    // slug → what it would be after earlier ops in this batch
    const simulated = new Map<string, ResolvedTarget>()
    const simulatedSessions = new Set<string>()
    // Deletes earlier in the batch: the slug is absent to every later op, so
    // delete-then-create of one slug is a rewrite, not a collision.
    const deleted = new Set<string>()
    const deletedSessions = new Set<string>()
    // slug → its parent/related after the earlier ops; files absent here
    // carry what is on disk.
    const simulatedLinks = new Map<string, FileLinks>()
    const existsAnywhere = (slug: string) => !deleted.has(slug) && (simulated.has(slug) || exists(slug))
    const linksOf = (slug: string): FileLinks => {
      const sim = simulatedLinks.get(slug)
      if (sim) return sim
      const fp = findFile(slug)
      if (!fp) return {}
      try {
        const pf = parseFilePath(fp)
        if (pf.kind === 'entity') return { parent: pf.frontmatter.parent, related: pf.frontmatter.related }
        return { related: pf.frontmatter.related }
      } catch { return {} }
    }

    // Vault context for the Op Spec table's semantic checks (src/batch-ops.ts).
    const ctx: OpCheckContext = {
      resolve: (slug) => {
        if (deleted.has(slug)) return null
        const sim = simulated.get(slug)
        if (sim) return sim
        const fp = findFile(slug)
        if (!fp) return null
        const kind = kindFromPath(fp)
        // The subtype decides which fields a knowledge note accepts (plan vs
        // insight), so it is resolved here rather than re-read per op.
        if (kind === 'knowledge') {
          try {
            const pf = parseFilePath(fp)
            const subtype = pf.kind === 'knowledge' ? pf.frontmatter.subtype : undefined
            return { kind, type: 'knowledge', subtype }
          } catch { return { kind, type: 'knowledge' } }
        }
        try {
          const pf = parseFilePath(fp)
          return { kind, type: pf.kind === 'entity' ? pf.frontmatter.type : 'entity' }
        } catch { return { kind, type: 'entity' } }
      },
      existsAnywhere,
      // resolveFilePath, not a bare join: delete acts on this answer, and a
      // '../' slug must never reach a file outside sessions/.
      sessionExists: (slug) => {
        if (deletedSessions.has(slug)) return false
        if (simulatedSessions.has(slug)) return true
        try { return existsSync(resolveFilePath(vaultPath, slug, 'session')) } catch { return false }
      },
      simulate: (slug, info) => { deleted.delete(slug); simulated.set(slug, info) },
      simulateSession: (slug) => { deletedSessions.delete(slug); simulatedSessions.add(slug) },
      linksOf,
      simulateLinks: (slug, links) => { simulatedLinks.set(slug, links) },
      // Read from disk, not the index: the validate phase must see the vault
      // as `validate` will, and a stale index row would let a linked note go.
      // The mutable kinds only: a session note's related are a record of
      // what it touched, and a record must not keep a note from being deleted.
      referrers: (slug) => {
        const candidates = new Set(simulated.keys())
        for (const kind of MUTABLE_KINDS) {
          for (const fp of scanVaultDir(join(vaultPath, kindDir(kind)))) candidates.add(basename(fp, '.md'))
        }
        return [...candidates]
          .filter(from => from !== slug && !deleted.has(from))
          .filter(from => { const l = linksOf(from); return l.parent === slug || (l.related ?? []).includes(slug) })
          .sort()
      },
      simulateDelete: (slug, kind) => {
        if (kind === 'session') { deletedSessions.add(slug); simulatedSessions.delete(slug); return }
        deleted.add(slug)
        simulated.delete(slug)
        // A file created under this slug later in the batch starts unlinked.
        simulatedLinks.set(slug, {})
      },
      validateKindFields,
      validateSessionLogEntry: (entry) => validateSessionLogEntry(entry),
      buildEntityFrontmatter: (name, fields) => { buildEntityFrontmatter(name, fields, existsAnywhere) },
      buildKnowledgeFrontmatter: (name, fields) => { buildKnowledgeFrontmatter(name, fields, existsAnywhere) },
    }

    const report: BatchOpValidation[] = []
    // The shape's OUTPUT, index-aligned with the report. Shapes may transform
    // (action/evidence text is trimmed), and the semantic checks and Apply
    // must both see what the shape emitted — validating the trimmed value but
    // writing the raw one would store what validation never looked at.
    const parsedOps: BatchOperation[] = []
    for (const [index, op] of operations.entries()) {
      // Shape and semantics in one pass: library callers get the same runtime
      // guarantee the CLI's JSON path has always had.
      const shape = BatchOperationSchema.safeParse(op)
      if (!shape.success) {
        parsedOps.push(op)
        const raw = op as Record<string, unknown> | undefined
        const label = raw && typeof raw.slug === 'string' ? raw.slug
          : raw && typeof raw.name === 'string' ? slugify(raw.name) : ''
        const entry: BatchOpValidation = {
          index,
          op: typeof raw?.op === 'string' ? raw.op : '?',
          slug: label,
          errors: shape.error.issues.map(i => `invalid shape at ${i.path.join('.') || '(root)'}: ${i.message}`),
        }
        // A missing slug outranks field-shape problems: spec.check never runs
        // when the shape fails, but the direct paths always surfaced NOT_FOUND
        // first (and scripts branch on its exit code) — keep that precedence.
        if (raw && typeof raw.slug === 'string' && raw.slug &&
            slugBearingOpNames().includes(entry.op) &&
            !existsAnywhere(raw.slug) &&
            !(sessionAddressingOpNames().includes(entry.op) && ctx.sessionExists(raw.slug))) {
          entry.errors.unshift(notFoundError(raw.slug))
          entry.primaryCode = 'NOT_FOUND'
        }
        report.push(entry)
        continue
      }
      const parsed = shape.data as BatchOperation
      parsedOps.push(parsed)
      const spec = specFor(parsed)
      const res = spec.check(parsed, ctx)
      const entry: BatchOpValidation = { index, op: parsed.op, slug: res.slug, errors: res.errors }
      if (res.created) entry.created = true
      if (res.warning) entry.warning = res.warning
      if (res.primaryCode) entry.primaryCode = res.primaryCode
      report.push(entry)
    }

    return { valid: report.every(o => o.errors.length === 0), operations: report, parsedOps }
  }

  function formatOpErrors(report: BatchValidationReport): string[] {
    return report.operations.flatMap(o => o.errors.map(e => opErrorLine(o.index, o.op, o.slug, e)))
  }

  async function batch(operations: BatchOperation[]): Promise<BatchResult[]> {
    const { results } = await runMutations(operations, null)
    return results
  }

  async function validate(): Promise<ValidationReport> {
    return validateVault(vaultPath)
  }

  async function health(): Promise<HealthReport> {
    return healthReport(vaultPath)
  }

  async function promote(slug: string, target: 'entity' | 'project' | 'knowledge'): Promise<string> {
    // Rollback safety rides the Spine: applyOperation's promote arm captures
    // both the source file and (for cross-kind moves) the knowledge target
    // before writing, so a commit-stage failure restores the source and
    // removes the created file (SEC-4: never unlink a restored path —
    // rollbackFiles only unlinks paths captured as previously-absent).
    await runMutations([{ op: 'promote', slug, target }], { action: 'promote' })
    return slug
  }

  const emptyStats: VaultStats = {
    counts: { active: 0, paused: 0, done: 0 },
    by_type: { capture: 0, entity: 0, project: 0 },
    knowledge_count: 0,
    stale: [], no_next_action: [], recently_touched: [], recently_created: [],
  }

  // An InternalHafez: syncIndex() is here, off the public Hafez type.
  const hafez: InternalHafez = {
    read,
    update,
    promote,
    query: async (opts?: EntityQueryOpts) => withIndex(idx => idx.queryEntities(opts), { items: [], total: 0 }),
    queryUnified: async (opts?: UnifiedQueryOpts) =>
      withIndex(idx => idx.queryUnified(opts), { items: [], total: 0 }),
    create,
    capture,
    link,
    unlink,
    delete: del,
    batch,
    // Same normalization as the apply path — dry-run must judge the payload
    // apply would actually run.
    validateBatch: async (operations: BatchOperation[]) => {
      // parsedOps is the Spine's internal handoff, not part of the report.
      const { valid, operations: report } = validateBatchCore(normalizeOperations(operations))
      return { valid, operations: report }
    },
    sync: async () => {
      if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
      return withLock(() => journal.sync())
    },
    children: async (slug: string) => withIndex(idx => idx.queryChildren(slug), { items: [], total: 0 }),
    related_to: async (slug: string, relation?: string) =>
      withIndex(idx => idx.queryRelatedTo(slug, relation), { items: [], total: 0 }),
    query_knowledge: async (opts?: KnowledgeQueryOpts) =>
      withIndex(idx => idx.queryKnowledge(opts), { items: [], total: 0 }),
    query_sessions: async (opts?: SessionQueryOpts) =>
      withIndex(idx => idx.querySessions(opts), { items: [], total: 0 }),
    archive,
    validate,
    health,
    search: async (query: string, kind?: SearchKind): Promise<SearchResult[]> =>
      withIndex(idx => { idx.syncForRead(); return idx.search(query, kind) }, []),
    graph: async (opts?: GraphOpts) => withIndex(idx => idx.queryGraph(opts), { nodes: [], edges: [] }),
    syncIndex: async () => { withIndex(idx => idx.syncIfStale(), undefined) },
    rebuildIndex: async () => {
      if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
      // A rebuild reads every vault file and rewrites the whole index, so it
      // takes the same two-level write lock every mutation takes — otherwise it
      // can interleave with a mutation's file writes and index a half-written
      // vault.
      await withLock(async () => { getIndex()!.rebuild() })
    },
    stats: async () => {
      const idx = getIndex()
      if (!idx) return emptyStats
      idx.syncForRead()
      const s = idx.getStats()
      s.recently_touched = await rankRecents(s.recently_touched, 'last_touched', 'modified')
      s.recently_created = await rankRecents(s.recently_created, 'created', 'added')
      return s
    },
    changelog: async (since: string, limit?: number) => {
      if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
        throw new HafezError('VALIDATION_FAILED', `changelog limit must be a positive whole number of commits, got ${limit}`)
      }
      return journal.changelog(since, limit)
    },
    changesSince: async (cursor?: string) => {
      const { cursor: next, files } = await journal.changesSince(cursor)
      const changes = files.flatMap(({ path, op }) => {
        const note = noteAtRelPath(path)
        return note ? [{ ...note, op }] : []
      })
      return { cursor: next, changes }
    },
    close: () => {
      // Forget the handle even if closing it throws: a retry must not
      // re-throw, and getIndex() must never hand out a closed handle.
      try {
        _index?.close()
      } finally {
        _index = null
        _indexInitialized = false
      }
    },
  }
  return hafez
}

export { HafezError } from './types.js'
export type { Hafez, HafezConfig, HafezErrorCode, EntityType, EntityStatus, EntityQueryOpts, KnowledgeQueryOpts, SessionQueryOpts, SessionQueryResult, SearchKind, UnifiedQueryOpts, AllQueryOpts, SortField, EntitySortField, KnowledgeSortField, SessionSortField, EntityFrontmatter, KnowledgeFrontmatter, ParsedFile, SessionLogEntry, UpdateFields, UpdateResult, CreateEntityFields, CreateKnowledgeFields, CreateSessionFields, QueryFilter, QueryResult, KnowledgeQueryResult, UnifiedResult, ValidationReport, BatchOperation, BatchResult, ReadDepth, ConfidenceLevel, LinkRelation, GitConfig, Journal, SearchResult, VaultStats, ChangelogEntry, KnowledgeSubtype, Graph, GraphNode, GraphEdge, GraphOpts, ChangesSince, NoteChange, ChangeOp, FileChange } from './types.js'
export { getBrief, getNextActions } from './document.js'
export { parseSessionLogHeading, parseSessionLog } from './document.js'

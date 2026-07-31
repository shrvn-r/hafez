// src/index.ts
import { parseFilePath, serializeFile, slugify, resolveFilePath } from './vault.js'
import { gitCommitAndPush, gitSync, gitChangelog } from './git.js'
import { validateEntityFrontmatter, validateKnowledgeFrontmatter, validateSessionLogEntry } from './schema.js'
import { bodyTemplate, knowledgeBodyTemplate } from './templates.js'
import { formatSessionLogEntry, countSessionLogEntries, extractOldestSessionLogEntry } from './parser.js'
import { setBrief, removeBrief, addNextAction, completeNextAction, removeNextAction, clearNextActions, syncRelatedSection, findNextStructuralHeading, findSection } from './sections.js'
import { queryEntities, queryChildren, queryRelatedTo, queryKnowledge, queryUnified } from './query.js'
import { getContract } from './contracts.js'
import { createIndex, type HafezIndex } from './db.js'
import { generateVaultIndex } from './knowledge-index.js'
import type { Hafez, HafezConfig, ReadDepth, ParsedFile, UpdateFields, CreateEntityFields, CreateKnowledgeFields, QueryFilter, EntityType, EntityQueryOpts, KnowledgeQueryOpts, LinkRelation, ConfidenceLevel, QueryResult, KnowledgeQueryResult, UnifiedResult, ValidationReport, BatchOperation, BatchResult, SearchResult, VaultStats } from './types.js'
import { HafezError } from './types.js'
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync, unlinkSync } from 'fs'
import { join, relative, basename } from 'path'

export function createHafez(config: HafezConfig): Hafez {
  const { vaultPath, readOnly = false, git: gitConfig = {}, onWrite } = config

  // Per-instance mutex — each createHafez() gets its own lock
  let lockPromise: Promise<void> = Promise.resolve()
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = lockPromise
    let release: () => void
    lockPromise = new Promise(resolve => { release = resolve })
    return prev.then(fn).finally(() => release!())
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
  function exists(slug: string): boolean { return findFile(slug) !== null }
  function today(): string { return new Date().toISOString().slice(0, 10) }

  function kindFromPath(filePath: string): 'entity' | 'knowledge' {
    return filePath.includes('/entities/') ? 'entity' : 'knowledge'
  }

  const ENTITY_ONLY_FIELDS: (keyof UpdateFields)[] = ['status', 'next_action', 'add_action', 'add_actions', 'complete_action', 'remove_action', 'clear_actions', 'brief', 'current_state', 'session_log', 'resource']
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

  // Shared by create() and batch() so optional fields can't silently diverge
  // between the two paths (see CLAUDE.md Validation Gotchas).
  function buildEntityFrontmatter(name: string, ef: CreateEntityFields): Record<string, any> {
    const fm: Record<string, any> = { name, type: ef.type, status: 'active', created: today(), 'last-touched': today() }
    if (ef.domain?.length) fm.domain = ef.domain
    if (ef.parent) {
      if (!exists(ef.parent)) throw new HafezError('VALIDATION_FAILED', `Parent '${ef.parent}' does not exist`)
      fm.parent = ef.parent
    }
    if (ef.related?.length) {
      for (const r of ef.related) {
        if (!exists(r)) throw new HafezError('VALIDATION_FAILED', `Related slug '${r}' does not exist`)
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

  function buildKnowledgeFrontmatter(name: string, kf: CreateKnowledgeFields): Record<string, any> {
    const fm: Record<string, any> = { name, confidence: 'observation', 'reinforcement-count': 0, created: today() }
    if (kf.domain?.length) fm.domain = kf.domain
    if (kf.related?.length) {
      for (const r of kf.related) {
        if (!exists(r)) throw new HafezError('VALIDATION_FAILED', `Related slug '${r}' does not exist`)
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

  function replaceSection(body: string, heading: string, content: string, insertBefore?: string): string {
    const idx = body.indexOf(heading)
    if (idx >= 0) {
      const afterPos = idx + heading.length
      const nextH = findNextStructuralHeading(body, afterPos)
      if (nextH !== -1) {
        return body.slice(0, afterPos) + '\n\n' + content + '\n' + body.slice(nextH)
      }
      return body.slice(0, afterPos) + '\n\n' + content + '\n'
    }
    if (insertBefore) {
      const beforeIdx = body.indexOf(insertBefore)
      if (beforeIdx >= 0) {
        return body.slice(0, beforeIdx) + heading + '\n\n' + content + '\n\n' + body.slice(beforeIdx)
      }
    }
    return body + '\n\n' + heading + '\n\n' + content + '\n'
  }

  function insertSessionLog(body: string, entry: string): string {
    const slHeader = '## Session Log'
    const slIdx = body.indexOf(slHeader)
    if (slIdx >= 0) {
      const insertPos = slIdx + slHeader.length
      return body.slice(0, insertPos) + '\n\n' + entry + '\n' + body.slice(insertPos)
    }
    return body + '\n\n' + slHeader + '\n\n' + entry + '\n'
  }

  function appendToSection(body: string, heading: string, content: string): string {
    const idx = body.indexOf(heading)
    if (idx >= 0) {
      const afterPos = idx + heading.length
      const nextH = findNextStructuralHeading(body, afterPos)
      if (nextH !== -1) {
        return body.slice(0, afterPos) + body.slice(afterPos, nextH) + '\n' + content + body.slice(nextH)
      }
      return body.slice(0, afterPos) + body.slice(afterPos) + '\n' + content + '\n'
    }
    return body + '\n\n' + heading + '\n\n' + content + '\n'
  }

  function applyUpdateFields(fm: Record<string, any>, body: string, fields: UpdateFields): { fm: Record<string, any>; body: string; matchedAction?: string } {
    if (fields.status !== undefined) fm.status = fields.status
    if (fields.next_action !== undefined) {
      if (fields.next_action === null) delete fm['next-action']
      else fm['next-action'] = fields.next_action
    }
    if (fields.current_state !== undefined) {
      body = replaceSection(body, '## Current State', fields.current_state, '## Session Log')
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
      body = insertSessionLog(body, formatSessionLogEntry(fields.session_log))
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
    if (fields.confidence !== undefined) fm.confidence = fields.confidence
    if (fields.tags !== undefined) fm.tags = fields.tags
    if (fields.related !== undefined) {
      for (const r of fields.related) {
        if (!exists(r)) throw new HafezError('VALIDATION_FAILED', `Related slug '${r}' does not exist`)
      }
      fm.related = fields.related
    }
    if (fields.synthesis !== undefined) {
      body = replaceSection(body, '## Synthesis', fields.synthesis)
    }
    if (fields.add_evidence) {
      const sanitized = fields.add_evidence.replace(/^#{1,2}\s/gm, '### ')
      body = appendToSection(body, '## Evidence', sanitized)
      fm['reinforcement-count'] = (fm['reinforcement-count'] ?? 0) + 1
      fm['last-reinforced'] = today()
      // NOTE: Confidence auto-promotion (observation→pattern at count>=3) was intentionally
      // removed. Confidence changes are now a deliberate decision via update --confidence.
    }
    if (fields.add_source) {
      body = appendToSection(body, '## Sources', fields.add_source)
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
    const frontmatter = parsed.frontmatter as ParsedFile['frontmatter']
    const body = parsed.body
    if (depth === 'frontmatter') return { frontmatter, body: '' }
    if (depth === 'summary') {
      const sessionLogIdx = body.indexOf('## Session Log')
      return { frontmatter, body: sessionLogIdx >= 0 ? body.slice(0, sessionLogIdx).trim() : body }
    }
    return { frontmatter, body }
  }

  async function create(kind: 'entity', name: string, fields: CreateEntityFields): Promise<string>
  async function create(kind: 'knowledge', name: string, fields?: CreateKnowledgeFields): Promise<string>
  async function create(kind: 'entity' | 'knowledge', name: string, fields?: CreateEntityFields | CreateKnowledgeFields): Promise<string> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const slug = slugify(name)
      if (exists(slug)) throw new HafezError('SLUG_EXISTS', `Slug '${slug}' already exists`)

      if (kind === 'entity') {
        const ef = fields as CreateEntityFields
        const fm = buildEntityFrontmatter(name, ef)

        let body = bodyTemplate(ef.type, { purpose: ef.purpose })
        if (ef.brief) body = setBrief(body, ef.brief)
        if (ef.add_action) body = addNextAction(body, ef.add_action)
        const filePath = entityPath(slug)
        mkdirSync(join(vaultPath, 'entities'), { recursive: true })
        body = syncRelatedSection(body, fm)
        writeFileSync(filePath, serializeFile(fm, body))

        await gitCommitAndPush(vaultPath, [relative(vaultPath, filePath)], `create: ${name}`, gitConfig)
        getIndex()!.upsertFromFile(slug, 'entity')
        onWrite?.(slug, 'create')
      } else {
        const kf = (fields || {}) as CreateKnowledgeFields
        const fm = buildKnowledgeFrontmatter(name, kf)
        let body = knowledgeBodyTemplate(kf.subtype, { synthesis: kf.synthesis })

        const filePath = knowledgePath(slug)
        mkdirSync(join(vaultPath, 'knowledge'), { recursive: true })
        body = syncRelatedSection(body, fm)
        writeFileSync(filePath, serializeFile(fm, body))

        await gitCommitAndPush(vaultPath, [relative(vaultPath, filePath)], `create: ${name}`, gitConfig)
        getIndex()!.upsertFromFile(slug, 'knowledge')
        onWrite?.(slug, 'create')
      }

      regenerateIndexSafe()
      return slug
    })
  }

  async function capture(name: string, notes?: string): Promise<string> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const slug = slugify(name)
      if (exists(slug)) throw new HafezError('SLUG_EXISTS', `Slug '${slug}' already exists`)

      const fm: Record<string, any> = {
        name,
        type: 'capture',
        status: 'active',
        created: today(),
        'last-touched': today(),
      }
      const body = bodyTemplate('capture', { notes })
      const filePath = entityPath(slug)
      mkdirSync(join(vaultPath, 'entities'), { recursive: true })
      writeFileSync(filePath, serializeFile(fm, body))

      await gitCommitAndPush(vaultPath, [relative(vaultPath, filePath)], `capture: ${name}`, gitConfig)
      getIndex()!.upsertFromFile(slug, 'entity')
      regenerateIndexSafe()
      onWrite?.(slug, 'capture')
      return slug
    })
  }

  async function update(slug: string, fields: UpdateFields) {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const filePath = findFile(slug)
      if (!filePath) throw new HafezError('NOT_FOUND', `'${slug}' not found`)

      const kind = kindFromPath(filePath)
      validateKindFields(kind, fields)

      let { frontmatter: fm, body } = parseFilePath(filePath)
      const previousNextAction: string | null = fm['next-action'] ?? null
      const applied = applyUpdateFields(fm, body, fields)
      fm = applied.fm
      body = applied.body

      // Session log archival
      if (countSessionLogEntries(body) >= 10) {
        const extracted = extractOldestSessionLogEntry(body)
        if (extracted) {
          const archiveDir = join(vaultPath, 'entities', 'archive')
          mkdirSync(archiveDir, { recursive: true })
          const archivePath = join(archiveDir, `${slug}-log.md`)
          appendFileSync(archivePath, extracted.entry + '\n\n')
          body = extracted.remaining
        }
      }

      body = syncRelatedSection(body, fm)
      writeFileSync(filePath, serializeFile(fm, body))

      const files = [relative(vaultPath, filePath)]
      const archivePath = join(vaultPath, 'entities', 'archive', `${slug}-log.md`)
      if (existsSync(archivePath)) files.push(relative(vaultPath, archivePath))

      await gitCommitAndPush(vaultPath, files, `update: ${slug}`, gitConfig)
      getIndex()!.upsertFromFile(slug, kind)
      regenerateIndexSafe()
      onWrite?.(slug, 'update')
      return { previous_next_action: previousNextAction, matched_action: applied.matchedAction }
    })
  }

  async function link(slug: string, target: string, relation: LinkRelation): Promise<void> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const filePath = findFile(slug)
      if (!filePath) throw new HafezError('NOT_FOUND', `'${slug}' not found`)
      if (!exists(target)) throw new HafezError('VALIDATION_FAILED', `Target '${target}' does not exist`)

      let { frontmatter: fm, body } = parseFilePath(filePath)

      if (relation === 'parent') {
        fm.parent = target
      } else {
        const related = fm.related || []
        if (!related.includes(target)) related.push(target)
        fm.related = related
      }

      body = syncRelatedSection(body, fm)
      writeFileSync(filePath, serializeFile(fm, body))
      await gitCommitAndPush(vaultPath, [relative(vaultPath, filePath)], `link: ${slug} → ${target} (${relation})`, gitConfig)
      const kind = kindFromPath(filePath)
      getIndex()!.upsertFromFile(slug, kind)
      regenerateIndexSafe()
      onWrite?.(slug, 'link')
    })
  }

  async function unlink(slug: string, target: string, relation: LinkRelation): Promise<void> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const filePath = findFile(slug)
      if (!filePath) throw new HafezError('NOT_FOUND', `'${slug}' not found`)

      let { frontmatter: fm, body } = parseFilePath(filePath)

      if (relation === 'parent' && fm.parent === target) {
        delete fm.parent
      } else if (relation === 'related' && fm.related) {
        fm.related = fm.related.filter((r: string) => r !== target)
        if (fm.related.length === 0) delete fm.related
      }

      body = syncRelatedSection(body, fm)
      writeFileSync(filePath, serializeFile(fm, body))
      await gitCommitAndPush(vaultPath, [relative(vaultPath, filePath)], `unlink: ${slug} ✕ ${target} (${relation})`, gitConfig)
      const kind = kindFromPath(filePath)
      getIndex()!.upsertFromFile(slug, kind)
      regenerateIndexSafe()
      onWrite?.(slug, 'unlink')
    })
  }

  async function batch(operations: BatchOperation[]): Promise<BatchResult[]> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      // Capture originals for rollback
      const originals = new Map<string, string | null>()
      function captureOriginal(filePath: string) {
        if (!originals.has(filePath)) {
          originals.set(filePath, existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null)
        }
      }

      const modifiedFiles: string[] = []
      const affectedSlugs: string[] = []
      const results: BatchResult[] = []

      try {
        for (const op of operations) {
          if (op.op === 'update') {
            const filePath = findFile(op.slug)
            if (!filePath) throw new HafezError('VALIDATION_FAILED', `'${op.slug}' not found`)
            captureOriginal(filePath)
            validateKindFields(kindFromPath(filePath), op.fields)

            const { frontmatter: fm, body } = parseFilePath(filePath)
            const applied = applyUpdateFields(fm, body, op.fields)
            applied.body = syncRelatedSection(applied.body, applied.fm)
            writeFileSync(filePath, serializeFile(applied.fm, applied.body))
            modifiedFiles.push(relative(vaultPath, filePath))
            affectedSlugs.push(op.slug)
            results.push({ op: 'update', slug: op.slug, status: 'ok' })

          } else if (op.op === 'create' && op.kind === 'session') {
            const slug = slugify(op.name)
            if (exists(slug)) {
              results.push({ op: 'create', slug, status: 'error', error: `Slug '${slug}' already exists in the vault` })
              continue
            }
            const sessionDir = join(vaultPath, 'sessions')
            mkdirSync(sessionDir, { recursive: true })
            const filePath = join(sessionDir, `${slug}.md`)
            if (existsSync(filePath)) {
              results.push({ op: 'create', slug, status: 'error', error: `Session '${slug}' already exists` })
              continue
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
            modifiedFiles.push(relative(vaultPath, filePath))
            // Sessions are not indexed (db.ts only scans entities/ and knowledge/).
            // They ARE included in git semantic merge (git.ts VAULT_FILE_RE).
            results.push({ op: 'create', slug, status: 'ok', created: true })

          } else if (op.op === 'create') {
            const slug = slugify(op.name)
            if (exists(slug)) throw new HafezError('VALIDATION_FAILED', `Slug '${slug}' already exists`)

            if (op.kind === 'entity') {
              const ef = op.fields
              const fm = buildEntityFrontmatter(op.name, ef)
              let entBody = bodyTemplate(ef.type, { purpose: ef.purpose })
              if (ef.brief) entBody = setBrief(entBody, ef.brief)
              if (ef.add_action) entBody = addNextAction(entBody, ef.add_action)
              const filePath = entityPath(slug)
              captureOriginal(filePath)
              mkdirSync(join(vaultPath, 'entities'), { recursive: true })
              entBody = syncRelatedSection(entBody, fm)
              writeFileSync(filePath, serializeFile(fm, entBody))
              modifiedFiles.push(relative(vaultPath, filePath))
              affectedSlugs.push(slug)
              results.push({ op: 'create', slug, status: 'ok', created: true })
            } else {
              const kf = (op.fields || {}) as CreateKnowledgeFields
              const fm = buildKnowledgeFrontmatter(op.name, kf)
              let body = knowledgeBodyTemplate(kf.subtype, { synthesis: kf.synthesis })
              const filePath = knowledgePath(slug)
              captureOriginal(filePath)
              mkdirSync(join(vaultPath, 'knowledge'), { recursive: true })
              body = syncRelatedSection(body, fm)
              writeFileSync(filePath, serializeFile(fm, body))
              modifiedFiles.push(relative(vaultPath, filePath))
              affectedSlugs.push(slug)
              results.push({ op: 'create', slug, status: 'ok', created: true })
            }

          } else if (op.op === 'capture') {
            const slug = slugify(op.name)
            if (exists(slug)) throw new HafezError('VALIDATION_FAILED', `Slug '${slug}' already exists`)
            const fm: Record<string, any> = { name: op.name, type: 'capture', status: 'active', created: today(), 'last-touched': today() }
            const filePath = entityPath(slug)
            captureOriginal(filePath)
            mkdirSync(join(vaultPath, 'entities'), { recursive: true })
            writeFileSync(filePath, serializeFile(fm, bodyTemplate('capture', { notes: op.notes })))
            modifiedFiles.push(relative(vaultPath, filePath))
            affectedSlugs.push(slug)
            results.push({ op: 'capture', slug, status: 'ok', created: true })

          } else if (op.op === 'link') {
            const filePath = findFile(op.slug)
            if (!filePath) throw new HafezError('VALIDATION_FAILED', `'${op.slug}' not found`)
            if (!exists(op.target)) throw new HafezError('VALIDATION_FAILED', `Target '${op.target}' does not exist`)
            captureOriginal(filePath)
            let { frontmatter: fm, body } = parseFilePath(filePath)
            if (op.relation === 'parent') {
              fm.parent = op.target
            } else {
              const related = fm.related || []
              if (!related.includes(op.target)) related.push(op.target)
              fm.related = related
            }
            body = syncRelatedSection(body, fm)
            writeFileSync(filePath, serializeFile(fm, body))
            modifiedFiles.push(relative(vaultPath, filePath))
            affectedSlugs.push(op.slug)
            results.push({ op: 'link', slug: op.slug, status: 'ok' })

          } else if (op.op === 'unlink') {
            const filePath = findFile(op.slug)
            if (!filePath) throw new HafezError('VALIDATION_FAILED', `'${op.slug}' not found`)
            captureOriginal(filePath)
            let { frontmatter: fm, body } = parseFilePath(filePath)
            if (op.relation === 'parent' && fm.parent === op.target) delete fm.parent
            else if (op.relation === 'related' && fm.related) {
              fm.related = fm.related.filter((r: string) => r !== op.target)
              if (fm.related.length === 0) delete fm.related
            }
            body = syncRelatedSection(body, fm)
            writeFileSync(filePath, serializeFile(fm, body))
            modifiedFiles.push(relative(vaultPath, filePath))
            affectedSlugs.push(op.slug)
            results.push({ op: 'unlink', slug: op.slug, status: 'ok' })

          } else if (op.op === 'promote') {
            const filePath = findFile(op.slug)
            if (!filePath) throw new HafezError('VALIDATION_FAILED', `'${op.slug}' not found`)
            captureOriginal(filePath)
            if (op.target === 'knowledge') {
              captureOriginal(knowledgePath(op.slug))
            }
            const kind = kindFromPath(filePath)
            const { frontmatter: fm, body } = parseFilePath(filePath)
            const { modifiedFiles: promoteFiles } = promoteCore(op.slug, op.target, filePath, fm, body, kind)
            modifiedFiles.push(...promoteFiles)
            affectedSlugs.push(op.slug)
            results.push({ op: 'promote', slug: op.slug, status: 'ok' })
          }
        }
      } catch (err) {
        // Rollback all modified files
        for (const [path, content] of originals) {
          if (content === null) {
            try { unlinkSync(path) } catch {}
          } else {
            writeFileSync(path, content)
          }
        }
        throw err
      }

      // Single git commit for all batch operations
      const uniqueFiles = [...new Set(modifiedFiles)]
      if (uniqueFiles.length > 0) {
        await gitCommitAndPush(vaultPath, uniqueFiles, `batch: ${operations.length} operations`, gitConfig)
        for (const slug of affectedSlugs) {
          const fp = findFile(slug)
          if (fp) {
            getIndex()!.upsertFromFile(slug, kindFromPath(fp))
          }
        }
        // Regenerate vault index if any entity or knowledge was touched (session-only batches skip)
        const anyIndexedTouched = uniqueFiles.some(f => f.startsWith('knowledge/') || f.startsWith('entities/'))
        if (anyIndexedTouched) {
          regenerateIndexSafe()
        }
        for (const slug of affectedSlugs) onWrite?.(slug, 'batch')
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
    const entDir = join(vaultPath, 'entities')
    if (existsSync(entDir)) {
      const files = readdirSync(entDir).filter(f => f.endsWith('.md'))
      report.total_entities = files.length
      for (const file of files) {
        const slug = basename(file, '.md')
        allSlugs.add(slug)
        let fm: Record<string, any>
        try {
          fm = parseFilePath(join(entDir, file)).frontmatter
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
    const knDir = join(vaultPath, 'knowledge')
    if (existsSync(knDir)) {
      const files = readdirSync(knDir).filter(f => f.endsWith('.md'))
      report.total_knowledge = files.length
      for (const file of files) {
        const slug = basename(file, '.md')
        allSlugs.add(slug)
        knowledgeSlugs.add(slug)
        let fm: Record<string, any>
        try {
          fm = parseFilePath(join(knDir, file)).frontmatter
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
  ): { modifiedFiles: string[] } {
    const currentType = kind === 'knowledge' ? 'knowledge' : (fm.type as string)
    const contract = getContract(currentType)
    if (!contract.canPromoteTo.includes(target)) {
      throw new HafezError('VALIDATION_FAILED', `Cannot promote ${currentType} to ${target}. Valid targets: ${contract.canPromoteTo.join(', ') || 'none (terminal type)'}`)
    }

    const modifiedFiles: string[] = []

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
      modifiedFiles.push(relative(vaultPath, filePath))
      getIndex()!.removeItem(slug)
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

    return { modifiedFiles }
  }

  async function promote(slug: string, target: 'entity' | 'project' | 'knowledge'): Promise<string> {
    if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
    return withLock(async () => {
      const filePath = findFile(slug)
      if (!filePath) throw new HafezError('NOT_FOUND', `'${slug}' not found`)

      const kind = kindFromPath(filePath)
      // Capture original content for rollback before parsing (avoids double read)
      const originalContent = target === 'knowledge' ? readFileSync(filePath, 'utf-8') : null
      const knowledgeTarget = target === 'knowledge' ? knowledgePath(slug) : null

      const { frontmatter: fm, body } = parseFilePath(filePath)
      const sourceType = kind === 'knowledge' ? 'knowledge' : (fm.type as string)

      try {
        const { modifiedFiles } = promoteCore(slug, target, filePath, fm, body, kind)
        await gitCommitAndPush(vaultPath, modifiedFiles, `promote: ${slug} ${sourceType} → ${target}`, gitConfig)
        getIndex()!.upsertFromFile(slug, target === 'knowledge' ? 'knowledge' : 'entity')
        regenerateIndexSafe()
        onWrite?.(slug, 'promote')
      } catch (err) {
        if (target === 'knowledge' && originalContent) {
          writeFileSync(filePath, originalContent)
          if (knowledgeTarget && existsSync(knowledgeTarget)) unlinkSync(knowledgeTarget)
        }
        throw err
      }
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
    sync: async () => {
      if (readOnly) throw new HafezError('VALIDATION_FAILED', 'Hafez instance is read-only')
      return withLock(() => gitSync(vaultPath))
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
      return idx.getStats()
    },
    changelog: (since: string) => gitChangelog(vaultPath, since),
  }
}

export { HafezError } from './types.js'
export type { Hafez, HafezConfig, HafezErrorCode, EntityType, EntityStatus, EntityQueryOpts, KnowledgeQueryOpts, EntityFrontmatter, KnowledgeFrontmatter, ParsedFile, SessionLogEntry, UpdateFields, UpdateResult, CreateEntityFields, CreateKnowledgeFields, QueryFilter, QueryResult, KnowledgeQueryResult, UnifiedResult, ValidationReport, BatchOperation, BatchResult, ReadDepth, ConfidenceLevel, LinkRelation, GitConfig, SearchResult, VaultStats, ChangelogEntry, KnowledgeSubtype } from './types.js'
export { getBrief, getNextActions, findSection } from './sections.js'
export { parseSessionLogHeading, parseSessionLog } from './parser.js'
export { formatStats, formatChangelog, formatValidation } from './cli/format.js'

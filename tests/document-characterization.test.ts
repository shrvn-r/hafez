// tests/document-characterization.test.ts
//
// C3 characterization suite (plans/2026-08-02-architecture-deepening.md):
// originally pinned the divergent behavior of the four pre-unification
// section splitters (see the commit that introduced this file). With
// src/document.ts landed, every DIVERGENCE test now pins the FIXED,
// owner-reviewed behavior of the one structural splitter. The old
// expectations live in git history for comparison.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHafez } from '../src/index.js'
import { serializeFile } from '../src/vault.js'
import { findSection, getBrief } from '../src/document.js'
import { parseSessionLog, countSessionLogEntries, prependSessionLogEntry, bodyBeforeSessionLog } from '../src/document.js'
import { mergeVaultContent } from '../src/merge.js'
import { parseContent } from '../src/vault.js'
import { mkdirSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createMemoryJournal } from './helpers/memory-journal.js'

const TMP = join(tmpdir(), 'hafez-test-doc-char-' + Date.now())
const VAULT = join(TMP, 'vault')
const TODAY = new Date().toISOString().slice(0, 10)

beforeAll(() => {
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

function makeOS() {
  return createHafez({ vaultPath: VAULT, persistence: createMemoryJournal() })
}

// ---------------------------------------------------------------------------
// Baseline: the structural model (sections.ts) — the unification target
// ---------------------------------------------------------------------------

describe('structural model baseline (sections.ts)', () => {
  it('heading text mid-line is not a section heading', () => {
    const body = 'intro that mentions ## Brief casually\n\n## Session Log\n'
    expect(getBrief(body)).toBeNull()
  })

  it('non-structural ## headings stay inside section content', () => {
    const body = '## Brief\n\nintro\n\n## My Working Notes\n\nnotes here\n\n## Session Log\n'
    expect(getBrief(body)).toBe('intro\n\n## My Working Notes\n\nnotes here')
    // Asymmetry worth knowing: lookup BY NAME still finds a non-structural
    // heading — only section BOUNDARIES are filtered to structural headings.
    // The same text is simultaneously inside Brief and its own findable section.
    expect(findSection(body, 'My Working Notes')?.content).toBe('notes here')
  })
})

// ---------------------------------------------------------------------------
// DIVERGENCE 1 — index.ts replaceSection uses indexOf: a mid-line mention of
// the heading false-matches and the rest of the containing section is
// REPLACED by the new content (data loss inside Brief).
// ---------------------------------------------------------------------------

describe('DIVERGENCE: replaceSection indexOf false-match (index.ts)', () => {
  it('current_state update lands inside a Brief that mentions "## Current State"', async () => {
    const os = makeOS()
    await os.create('entity', 'Replace Probe', {
      type: 'entity',
      brief: 'see ## Current State below for detail',
    })
    await os.update('replace-probe', { current_state: 'FRESH' })

    const body = readFileSync(join(VAULT, 'entities', 'replace-probe.md'), 'utf-8')
    const parsed = parseContent(body).body
    // FIXED: the mid-line mention is ignored — the Brief is untouched and a
    // real Current State section is created.
    expect(getBrief(parsed)).toContain('below for detail')
    expect(getBrief(parsed)).not.toContain('FRESH')
    expect(findSection(parsed, 'Current State')?.content).toBe('FRESH')
  })
})

// ---------------------------------------------------------------------------
// DIVERGENCE 2 — read(slug, 'summary') truncates at indexOf('## Session Log'):
// a mid-line mention inside the Brief cuts the summary short.
// ---------------------------------------------------------------------------

describe('DIVERGENCE: summary depth truncates at a Session Log mention (index.ts read)', () => {
  it('summary body stops at the mention inside the Brief', async () => {
    const os = makeOS()
    await os.create('entity', 'Summary Probe', {
      type: 'entity',
      brief: 'the ## Session Log format is documented elsewhere',
    })
    const res = await os.read('summary-probe', 'summary')
    // FIXED: only the real Session Log section is stripped from the summary.
    expect(res.body).toContain('format is documented')
  })
})

// ---------------------------------------------------------------------------
// DIVERGENCE 3 — insertSessionLog uses indexOf: with a mention in the Brief,
// new session-log entries are inserted into the Brief, not the real section.
// ---------------------------------------------------------------------------

describe('DIVERGENCE: insertSessionLog false-match (index.ts)', () => {
  it('a session log entry lands inside the Brief that mentions the heading', async () => {
    const os = makeOS()
    await os.create('entity', 'Log Probe', {
      type: 'entity',
      brief: 'we keep a ## Session Log below',
    })
    await os.update('log-probe', {
      session_log: { type: 'progress', summary: 'real entry', agent: 'Char' },
    })
    const body = parseContent(readFileSync(join(VAULT, 'entities', 'log-probe.md'), 'utf-8')).body
    // FIXED: the entry lands in the real Session Log section.
    expect(getBrief(body)).not.toContain('real entry')
    const real = findSection(body, 'Session Log')
    expect(real?.content ?? '').toContain('real entry')
  })
})

// ---------------------------------------------------------------------------
// DIVERGENCE 4 — parser.parseSessionLog uses indexOf: a mention BEFORE the
// real section makes it read the wrong slice and return no entries.
// ---------------------------------------------------------------------------

describe('DIVERGENCE: parseSessionLog reads from the first mention (parser.ts)', () => {
  it('returns no entries when a Brief mentions the heading before the real section', () => {
    const body = [
      '## Brief',
      '',
      'we keep a ## Session Log below',
      '',
      '## Session Log',
      '',
      `### ${TODAY} — Char [progress]`,
      'Summary: the real entry',
      '',
    ].join('\n')
    // FIXED: entries are parsed from the real section.
    const entries = parseSessionLog(body)
    expect(entries).toHaveLength(1)
    expect(entries[0].summary).toBe('the real entry')
  })
})

// ---------------------------------------------------------------------------
// DIVERGENCE 5 — countSessionLogEntries counts ### lines ANYWHERE in the
// body, not just inside the Session Log section.
// ---------------------------------------------------------------------------

describe('DIVERGENCE: countSessionLogEntries counts globally (parser.ts)', () => {
  it('an entry-shaped line inside the Brief inflates the count', () => {
    const body = [
      '## Brief',
      '',
      '### 2026-01-01 — Someone [progress]',
      '',
      '## Session Log',
      '',
      `### ${TODAY} — Char [progress]`,
      'Summary: real',
      '',
    ].join('\n')
    // FIXED: only entries inside the Session Log section count — the
    // archival threshold can no longer be inflated by Brief content.
    expect(countSessionLogEntries(body)).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// DIVERGENCE 6 — merge.ts splits on ANY "## " line: a user content heading
// inside the Brief becomes its own section during merge, so section policies
// apply to the two halves independently (mixed-provenance output).
// ---------------------------------------------------------------------------

describe('DIVERGENCE: merge splits user ## headings out of their section (merge.ts)', () => {
  const fmLocal = { name: 'Merge Probe', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-02' }
  const fmRemote = { name: 'Merge Probe', type: 'entity', status: 'active', created: '2026-01-01', 'last-touched': '2026-01-03' }

  it('remote Brief wins but the local embedded subsection survives standalone', () => {
    const local = serializeFile(fmLocal,
      '## Brief\n\nlocal intro\n\n## My Working Notes\n\nprecious notes\n\n## Session Log\n')
    const remote = serializeFile(fmRemote,
      '## Brief\n\nremote intro\n\n## Session Log\n')

    const merged = parseContent(mergeVaultContent(remote, local))
    // FIXED (owner decision: atomic sections): the Brief is one unit — the
    // newer side wins it whole, embedded user headings included.
    expect(getBrief(merged.body)).toBe('remote intro')
    expect(merged.body).not.toContain('My Working Notes')
  })

  it('a ## line inside a session-log entry detaches from its entry during merge', () => {
    const localEntry = '### 2026-01-05 — Char [progress]\nSummary: local entry\n## Detail\nmore text'
    const remoteEntry = '### 2026-01-03 — Remote [progress]\nSummary: remote entry'
    const local = serializeFile(fmLocal, `## Session Log\n\n${localEntry}\n`)
    const remote = serializeFile(fmRemote, `## Session Log\n\n${remoteEntry}\n`)

    const merged = parseContent(mergeVaultContent(remote, local))
    const sl = findSection(merged.body, 'Session Log')!.content
    // FIXED: the entry keeps its authored ## Detail tail; the remote entry
    // sorts after the (newer) local entry and its tail.
    expect(sl.indexOf('local entry')).toBeLessThan(sl.indexOf('## Detail'))
    expect(sl.indexOf('## Detail')).toBeLessThan(sl.indexOf('remote entry'))
  })
})

// ---------------------------------------------------------------------------
// FIXED with unification — session-log archival extraction is bounded by the
// section's structural end: an auto-appended Related section after the
// Session Log can no longer be swallowed into the archive file.
// ---------------------------------------------------------------------------

describe('archival extraction is bounded by the Session Log section', () => {
  it('a trailing Related section stays out of the archived entry', async () => {
    const os = makeOS()
    await os.create('entity', 'Bound Target', { type: 'entity' })
    await os.create('entity', 'Bound Probe', { type: 'entity', related: ['bound-target'] })
    for (let i = 0; i < 10; i++) {
      await os.update('bound-probe', {
        session_log: { type: 'progress', summary: `Entry ${i}`, agent: 'Char' },
      })
    }
    const archive = readFileSync(join(VAULT, 'entities', 'archive', 'bound-probe-log.md'), 'utf-8')
    expect(archive).toContain('Entry 0')
    expect(archive).not.toContain('## Related')
    // The vault file keeps its Related section
    const body = parseContent(readFileSync(join(VAULT, 'entities', 'bound-probe.md'), 'utf-8')).body
    expect(findSection(body, 'Related')?.content).toContain('bound-target')
  })
})

// ---------------------------------------------------------------------------
// FIXED with unification — adjacent structural headings (no blank line, as in
// hand-edited files) are real boundaries. Pre-unification, findSection's scan
// started one char past the heading's newline, so mutators could swallow an
// immediately-following section.
// ---------------------------------------------------------------------------

describe('adjacent structural headings are boundaries', () => {
  it('findSection ends a section at a heading on the very next line', () => {
    const body = '## Current State\n## Session Log\n\n### 2026-01-01 — X [progress]\nSummary: kept'
    expect(findSection(body, 'Current State')?.content).toBe('')
    expect(findSection(body, 'Session Log')?.content).toContain('Summary: kept')
  })
})

// ---------------------------------------------------------------------------
// FIXED post-review — trailing whitespace on a heading line (hand-edited /
// Obsidian vaults). The splitter's boundary tokenizer trims headings, so
// `## Session Log ` was a boundary but findSection couldn't find it: --log
// created a DUPLICATE Session Log section and countSessionLogEntries returned
// 0, so archival never fired.
// ---------------------------------------------------------------------------

describe('trailing whitespace on a structural heading', () => {
  const body = 'intro\n\n## Session Log \n\n### 2026-01-01 — X [progress]\nSummary: kept'

  it('findSection finds the section, content intact', () => {
    expect(findSection(body, 'Session Log')?.content).toContain('Summary: kept')
  })

  it('countSessionLogEntries counts inside it', () => {
    expect(countSessionLogEntries(body)).toBe(1)
  })

  it('prependSessionLogEntry inserts into the existing section — no duplicate heading', () => {
    const updated = prependSessionLogEntry(body, '### 2026-01-02 — Y [progress]\nSummary: new')
    expect(updated.match(/## Session Log/g)).toHaveLength(1)
    // Newest-first: the new entry lands before the existing one
    expect(updated.indexOf('Summary: new')).toBeLessThan(updated.indexOf('Summary: kept'))
  })

  it('bodyBeforeSessionLog truncates at the real section', () => {
    expect(bodyBeforeSessionLog(body)).toBe('intro')
  })
})

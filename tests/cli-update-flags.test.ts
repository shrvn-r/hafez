// tests/cli-update-flags.test.ts
// Every declared `update` flag is applied to the vault file or rejected with
// the Op Spec's error — never silently dropped. The hand-written flag mapping
// this replaces had already drifted: empty-string handling differed per flag
// by accident of which guard was typed, and a schema field (add_actions) was
// unreachable with nothing to catch it. Mirrors tests/cli-create-flags.test.ts,
// at the same command-function seam over a memory-Journal factory.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHafez, removeTemp } from './helpers/hafez.js'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createMemoryJournal } from './helpers/memory-journal.js'
import { cmdCreate, cmdUpdate, UPDATE_FLAGS, UPDATE_SPECIAL_FLAGS, UPDATE_FIELDS_WITHOUT_FLAGS, ONE_FIELD_REPEATS } from '../src/cli/commands.js'
import { cmdSchema } from '../src/cli/commands-schema.js'
import { exitCodeFor } from '../src/cli/index.js'
import { UpdateFieldsSchema } from '../src/batch-ops.js'
import { localDay } from '../src/dates.js'
import { detectAgent } from '../src/harness.js'
import type { Hafez } from '../src/types.js'

const TMP = join(tmpdir(), 'hafez-test-cli-update-flags-' + Date.now())
const VAULT = join(TMP, 'vault')

let os: Hafez

beforeAll(async () => {
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })
  os = createHafez({ vaultPath: VAULT, persistence: createMemoryJournal() })
  await os.create('entity', 'Alpha', { type: 'project' })
  await os.create('entity', 'Beta', { type: 'project' })
})

afterAll(() => removeTemp(TMP))

type Kind = 'entity' | 'knowledge'
type Read = { frontmatter: Record<string, any>; body: string }

interface FlagCase {
  /** Declared CLI flag, without the leading dashes. */
  flag: string
  /** Argv tokens under test. Defaults to `--<flag> <value>`. */
  args?: string[]
  value?: string
  /** Kinds the flag is applicable to — every other kind must reject it. */
  applies: Kind[]
  /** What the rejection must name, when it isn't the flag itself. */
  rejectMatch?: RegExp
  /** Observable proof the flag reached the file. */
  assert?(read: Read): void
}

// Every target entity is seeded with these actions, so the action flags have
// something real to match against. Two of them, because completing the last
// pending action clears the section outright (Apply prunes it after the op) —
// with one seed there would be no checked line left to observe.
const SEEDED_ACTION = 'Ship it @dev'
const SECOND_ACTION = 'Write the docs @dev'

const FLAG_CASES: FlagCase[] = [
  { flag: 'status', value: 'paused', applies: ['entity'], assert: r => expect(r.frontmatter.status).toBe('paused') },
  { flag: 'current-state', value: 'Mid-flight', applies: ['entity'], assert: r => expect(r.body).toContain('Mid-flight') },
  { flag: 'brief', value: 'Handoff context', applies: ['entity'], assert: r => expect(r.body).toContain('Handoff context') },
  { flag: 'add-action', value: 'Deploy fix @dev', applies: ['entity'], assert: r => expect(r.body).toContain('- [ ] Deploy fix @dev') },
  { flag: 'complete-action', value: 'Ship', applies: ['entity'], assert: r => expect(r.body).toContain(`- [x] ${SEEDED_ACTION}`) },
  { flag: 'remove-action', value: 'Ship', applies: ['entity'], assert: r => expect(r.body).not.toContain(SEEDED_ACTION) },
  { flag: 'clear-actions', applies: ['entity'], assert: r => expect(r.body).not.toContain('- [ ]') },
  { flag: 'description', value: 'One-line summary', applies: ['entity', 'knowledge'], assert: r => expect(r.frontmatter.description).toBe('One-line summary') },
  { flag: 'resource', value: 'https://example.com/repo', applies: ['entity'], assert: r => expect(r.frontmatter.resource).toEqual(['https://example.com/repo']) },
  { flag: 'domain', value: 'engineering', applies: ['entity', 'knowledge'], assert: r => expect(r.frontmatter.domain).toContain('engineering') },
  { flag: 'confidence', value: 'pattern', applies: ['knowledge'], assert: r => expect(r.frontmatter.confidence).toBe('pattern') },
  { flag: 'tags', value: 'mytag', applies: ['entity', 'knowledge'], assert: r => expect(r.frontmatter.tags).toContain('mytag') },
  { flag: 'related', value: 'alpha', applies: ['entity', 'knowledge'], assert: r => expect(r.frontmatter.related).toContain('alpha') },
  { flag: 'synthesis', value: 'The synthesis body', applies: ['knowledge'], assert: r => expect(r.body).toContain('The synthesis body') },
  // The declared alias: normalized to `synthesis` before validation, so the
  // entity rejection names the canonical field.
  { flag: 'insight', value: 'The insight body', applies: ['knowledge'], rejectMatch: /synthesis/, assert: r => expect(r.body).toContain('The insight body') },
  { flag: 'parent', value: 'alpha', applies: ['entity'], assert: r => expect(r.frontmatter.parent).toBe('alpha') },
  { flag: 'add-evidence', value: 'Fresh evidence', applies: ['knowledge'], assert: r => expect(r.body).toContain('Fresh evidence') },
  { flag: 'add-source', value: 'https://example.com/paper', applies: ['knowledge'], assert: r => expect(r.body).toContain('https://example.com/paper') },
  // session_log has no flag of its own — the pair composes it.
  {
    flag: 'log', args: ['--log', 'progress: Did the thing'], applies: ['entity'],
    rejectMatch: /session_log/,
    assert: r => expect(r.body).toContain(`### ${localDay()} — ${detectAgent()} [progress]`),
  },
  {
    flag: 'agent', args: ['--log', 'progress: Did the thing', '--agent', 'codex'], applies: ['entity'],
    rejectMatch: /session_log/,
    assert: r => expect(r.body).toContain(`### ${localDay()} — codex [progress]`),
  },
  {
    flag: 'body', args: ['--log', 'progress: Did the thing', '--body', 'The detail'], applies: ['entity'],
    rejectMatch: /session_log/,
    assert: r => expect(r.body).toContain('Summary: Did the thing\nThe detail'),
  },
  // Removed flag: rejected on every kind, with the replacement named.
  { flag: 'next-action', value: 'x', applies: [], rejectMatch: /removed in v1\.0\.2/ },
]

/** A fresh target of the given kind, so each case observes only its own write. */
async function seedTarget(kind: Kind, name: string): Promise<string> {
  if (kind === 'entity') {
    const slug = (await cmdCreate(os, ['entity', name, '--type', 'project', '--add-action', SEEDED_ACTION])).trim()
    await cmdUpdate(os, [slug, '--add-action', SECOND_ACTION])
    return slug
  }
  // The matrix's names near-match one another ("Ux add-action knowledge",
  // "Ux complete-action knowledge"): --new writes them anyway. The slug is
  // the first line; a relate line may follow it.
  return (await cmdCreate(os, ['knowledge', name, '--new'])).split('\n')[0]
}

function argsFor(slug: string, c: FlagCase): string[] {
  const tokens = c.args ?? (c.value === undefined ? [`--${c.flag}`] : [`--${c.flag}`, c.value])
  return [slug, ...tokens]
}

/** Message plus details — batch reports the offending field in `details`. */
async function errorText(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    const e = err as Error & { details?: string[] }
    return [e.message, ...(e.details ?? [])].join('\n')
  }
  throw new Error('expected a rejection, got success')
}

describe('update flag × kind matrix — applied or rejected, never dropped', () => {
  for (const c of FLAG_CASES) {
    for (const kind of ['entity', 'knowledge'] as Kind[]) {
      const applicable = c.applies.includes(kind)
      it(`--${c.flag} on ${kind} is ${applicable ? 'applied' : 'rejected'}`, async () => {
        const slug = await seedTarget(kind, `Ux ${c.flag} ${kind}`)
        if (applicable) {
          await cmdUpdate(os, argsFor(slug, c))
          c.assert!(await os.read(slug, 'full') as unknown as Read)
        } else {
          const expected = c.rejectMatch ?? new RegExp(c.flag.replace(/-/g, '[-_]'))
          expect(await errorText(cmdUpdate(os, argsFor(slug, c)))).toMatch(expected)
        }
      })
    }
  }

  it('the matrix covers every declared update flag', () => {
    expect(new Set(FLAG_CASES.map(c => c.flag))).toEqual(new Set(Object.keys(UPDATE_FLAGS)))
  })
})

describe('the flag table tracks the update shape', () => {
  const schemaKeys = Object.keys(UpdateFieldsSchema.shape)
  const flagFields = Object.keys(UPDATE_FLAGS)
    .filter(f => !UPDATE_SPECIAL_FLAGS.has(f))
    // A repeatable flag also reaches the array form of its field (`add_actions`),
    // except a one-field repeat (--resource), whose list is the field itself.
    .flatMap(f => {
      const field = f.replace(/-/g, '_')
      return UPDATE_FLAGS[f] === 'repeat' && !ONE_FIELD_REPEATS.has(f) ? [field, `${field}s`] : [field]
    })

  it('covers every update-schema field except the declared exclusions', () => {
    const missing = schemaKeys.filter(k => !flagFields.includes(k) && !(k in UPDATE_FIELDS_WITHOUT_FLAGS))
    expect(missing).toEqual([])
  })

  it('declares no flag that is not an update-schema field', () => {
    expect(flagFields.filter(k => !schemaKeys.includes(k))).toEqual([])
  })

  it('every exclusion is a real schema field with a stated rationale', () => {
    for (const [field, reason] of Object.entries(UPDATE_FIELDS_WITHOUT_FLAGS)) {
      expect(schemaKeys).toContain(field)
      expect(reason.length).toBeGreaterThan(20)
    }
  })
})

describe('empty-string policy — clear on the nullable fields, reject elsewhere', () => {
  it('--brief "" clears the Brief section', async () => {
    const slug = await seedTarget('entity', 'Ux clear brief')
    await cmdUpdate(os, [slug, '--brief', 'Some context'])
    expect(((await os.read(slug, 'full')) as unknown as Read).body).toContain('Some context')
    await cmdUpdate(os, [slug, '--brief', ''])
    expect(((await os.read(slug, 'full')) as unknown as Read).body).not.toContain('Some context')
  })

  it('--description "" clears the field', async () => {
    const slug = await seedTarget('entity', 'Ux clear description')
    await cmdUpdate(os, [slug, '--description', 'A summary'])
    await cmdUpdate(os, [slug, '--description', ''])
    expect(((await os.read(slug)) as unknown as Read).frontmatter.description).toBeUndefined()
  })

  it('--resource "" clears the field', async () => {
    const slug = await seedTarget('entity', 'Ux clear resource')
    await cmdUpdate(os, [slug, '--resource', 'https://example.com'])
    await cmdUpdate(os, [slug, '--resource', ''])
    expect(((await os.read(slug)) as unknown as Read).frontmatter.resource).toBeUndefined()
  })

  it('--resource appends to the values held, a duplicate spelling skipped (#305)', async () => {
    const slug = await seedTarget('entity', 'Ux append resource')
    await cmdUpdate(os, [slug, '--resource', 'https://github.com/org/repo'])
    await cmdUpdate(os, [slug, '--resource', 'git@github.com:org/repo.git', '--resource', 'https://docs.example.com'])
    expect(((await os.read(slug)) as unknown as Read).frontmatter.resource)
      .toEqual(['https://github.com/org/repo', 'https://docs.example.com'])
  })

  it('--resource "" clears every value (#305)', async () => {
    const slug = await seedTarget('entity', 'Ux clear many resource')
    await cmdUpdate(os, [slug, '--resource', 'https://a.example.com', '--resource', 'https://b.example.com'])
    await cmdUpdate(os, [slug, '--resource', ''])
    expect(((await os.read(slug)) as unknown as Read).frontmatter.resource).toBeUndefined()
  })

  for (const argv of [['--resource', '', '--resource', 'https://a.example.com'], ['--resource', 'https://a.example.com', '--resource', '']]) {
    it(`${argv.join(' ')} is a usage error, nothing written (#305)`, async () => {
      const slug = await seedTarget('entity', `Ux mixed resource ${argv[1] === '' ? 'first' : 'last'}`)
      await cmdUpdate(os, [slug, '--resource', 'https://held.example.com'])
      const before = await os.read(slug, 'full') as unknown as Read
      const err = await cmdUpdate(os, [slug, ...argv]).then(() => null, e => e)
      expect(exitCodeFor(err)).toBe(2)
      expect(err.message).toContain('--resource ""')
      expect(await os.read(slug, 'full')).toEqual(before)
    })
  }

  it('--status "" is rejected by name instead of silently no-opping', async () => {
    const slug = await seedTarget('entity', 'Ux empty status')
    const text = await errorText(cmdUpdate(os, [slug, '--status', '']))
    expect(text).toMatch(/status/)
    expect(text).toMatch(/active/)
    expect(((await os.read(slug)) as unknown as Read).frontmatter.status).toBe('active')
  })

  it('--confidence "" is rejected by name instead of silently no-opping', async () => {
    const slug = await seedTarget('knowledge', 'Ux empty confidence')
    const text = await errorText(cmdUpdate(os, [slug, '--confidence', '']))
    expect(text).toMatch(/confidence/)
    expect(text).toMatch(/observation/)
    expect(((await os.read(slug)) as unknown as Read).frontmatter.confidence).toBe('observation')
  })

  // The action/evidence fields: empty AND whitespace-only reject at the shape
  // (trim + nonempty). These used to reach apply and be dropped by a
  // truthiness guard — `--add-action "$TASK"` with $TASK unset exited 0 with
  // nothing on disk.
  const ACTION_EVIDENCE_FLAGS: Array<{ flag: string; kind: Kind }> = [
    { flag: 'add-action', kind: 'entity' },
    { flag: 'complete-action', kind: 'entity' },
    { flag: 'remove-action', kind: 'entity' },
    { flag: 'add-evidence', kind: 'knowledge' },
    { flag: 'add-source', kind: 'knowledge' },
  ]
  for (const { flag, kind } of ACTION_EVIDENCE_FLAGS) {
    it(`--${flag} rejects empty and whitespace-only, nothing written`, async () => {
      const slug = await seedTarget(kind, `Ux empty ${flag}`)
      const before = ((await os.read(slug, 'full')) as unknown as Read).body
      for (const value of ['', '   ']) {
        const text = await errorText(cmdUpdate(os, [slug, `--${flag}`, value]))
        expect(text).toMatch(new RegExp(flag.replace(/-/g, '[-_]')))
      }
      expect(((await os.read(slug, 'full')) as unknown as Read).body).toBe(before)
    })
  }

  // add_actions is reached by a repeated --add-action — its elements carry
  // the same rule, pinned here at the library seam.
  it('add_actions with a whitespace-only element is rejected as a whole', async () => {
    const slug = await seedTarget('entity', 'Ux empty add actions element')
    const before = ((await os.read(slug, 'full')) as unknown as Read).body
    const text = await errorText(os.update(slug, { add_actions: ['Real task @dev', ' '] }))
    expect(text).toMatch(/add_actions/)
    expect(((await os.read(slug, 'full')) as unknown as Read).body).toBe(before)
  })

  it('action text is stored trimmed', async () => {
    const slug = await seedTarget('entity', 'Ux trimmed action')
    await cmdUpdate(os, [slug, '--add-action', '  Padded task @dev  '])
    const body = ((await os.read(slug, 'full')) as unknown as Read).body
    expect(body).toContain(`- [ ] Padded task @dev (added ${localDay()})\n`)
  })

  // The section-setting fields. Same class as the action/evidence flags above,
  // but destructive rather than merely silent: apply trusts the validate phase,
  // so `setSection(body, 'Synthesis', '')` wiped what was already written and
  // still exited 0 with "Updated <slug>".
  // `field` is what the error names: --insight is normalized to synthesis
  // before the shape runs, so the rejection is reported against the canonical
  // field, not the alias the user typed.
  const SECTION_FLAGS: Array<{ flag: string; field: string; kind: Kind; seeded: string }> = [
    { flag: 'synthesis', field: 'synthesis', kind: 'knowledge', seeded: 'Important long-held synthesis text' },
    { flag: 'insight', field: 'synthesis', kind: 'knowledge', seeded: 'Important long-held synthesis text' },
    { flag: 'current-state', field: 'current_state', kind: 'entity', seeded: 'Where the work stands right now' },
  ]
  for (const { flag, field, kind, seeded } of SECTION_FLAGS) {
    it(`--${flag} rejects empty and whitespace-only instead of wiping the section`, async () => {
      const slug = await seedTarget(kind, `Ux empty ${flag}`)
      await cmdUpdate(os, [slug, `--${flag}`, seeded])
      const before = ((await os.read(slug, 'full')) as unknown as Read).body
      expect(before).toContain(seeded)
      for (const value of ['', '   ']) {
        const text = await errorText(cmdUpdate(os, [slug, `--${flag}`, value]))
        expect(text).toMatch(new RegExp(field))
      }
      // The whole point: the seeded text is still there.
      expect(((await os.read(slug, 'full')) as unknown as Read).body).toBe(before)
    })
  }

  it('section text is stored trimmed', async () => {
    const slug = await seedTarget('knowledge', 'Ux trimmed synthesis')
    await cmdUpdate(os, [slug, '--synthesis', '  Padded synthesis  '])
    expect(((await os.read(slug, 'full')) as unknown as Read).body).toContain('Padded synthesis\n')
  })
})

describe('Write Line parser — repeat-append, repeated scalar, --body, --parent', () => {
  it('--add-action repeated appends every value, in order', async () => {
    const slug = await seedTarget('entity', 'Wl repeat add')
    await cmdUpdate(os, [slug, '--add-action', 'First new @dev', '--add-action', 'Second new @dev'])
    const body = ((await os.read(slug, 'full')) as unknown as Read).body
    expect(body).toContain(`- [ ] First new @dev (added ${localDay()})\n- [ ] Second new @dev (added ${localDay()})`)
    expect(body).toContain(SEEDED_ACTION)
  })

  // Every scalar flag, never last-wins: the second value would otherwise
  // overwrite the first with exit 0.
  for (const [flag, type] of Object.entries(UPDATE_FLAGS)) {
    if (type === 'repeat') continue
    it(`--${flag} given twice is a usage error naming the flag, nothing written`, async () => {
      const slug = await seedTarget('entity', `Wl twice ${flag}`)
      const before = await os.read(slug, 'full') as unknown as Read
      const once = type === 'boolean' ? [`--${flag}`] : [`--${flag}`, 'x']
      const err = await cmdUpdate(os, [slug, ...once, ...once]).then(() => null, e => e)
      expect(exitCodeFor(err)).toBe(2)
      expect(err.message).toContain(`--${flag}`)
      expect(await os.read(slug, 'full')).toEqual(before)
    })
  }

  it('--body without --log is a usage error, nothing written', async () => {
    const slug = await seedTarget('entity', 'Wl body alone')
    const before = await os.read(slug, 'full') as unknown as Read
    const err = await cmdUpdate(os, [slug, '--body', 'detail']).then(() => null, e => e)
    expect(exitCodeFor(err)).toBe(2)
    expect(err.message).toMatch(/--body.*--log/)
    expect(await os.read(slug, 'full')).toEqual(before)
  })

  it('--body "" is rejected by name instead of silently dropped', async () => {
    const slug = await seedTarget('entity', 'Wl body empty')
    for (const value of ['', '   ']) {
      expect(await errorText(cmdUpdate(os, [slug, '--log', 'progress: x', '--body', value]))).toMatch(/body/)
    }
  })

  it('--parent replaces an existing parent and shows it under Related', async () => {
    const slug = await seedTarget('entity', 'Wl parent swap')
    await cmdUpdate(os, [slug, '--parent', 'alpha'])
    await cmdUpdate(os, [slug, '--parent', 'beta'])
    const read = await os.read(slug, 'full') as unknown as Read
    expect(read.frontmatter.parent).toBe('beta')
    expect(read.body).toContain('[[beta]]')
    expect(read.body).not.toContain('[[alpha]]')
  })

  it('--parent with a slug that does not exist is rejected by name, nothing written', async () => {
    const slug = await seedTarget('entity', 'Wl parent missing')
    expect(await errorText(cmdUpdate(os, [slug, '--parent', 'no-such-slug']))).toMatch(/Parent 'no-such-slug' does not exist/)
    expect(((await os.read(slug)) as unknown as Read).frontmatter.parent).toBeUndefined()
  })

  it('the batch update op accepts parent', async () => {
    const slug = await seedTarget('entity', 'Wl batch parent')
    await os.batch([{ op: 'update', slug, fields: { parent: 'alpha' } }])
    expect(((await os.read(slug)) as unknown as Read).frontmatter.parent).toBe('alpha')
  })

  it('a batch can parent onto an entity created earlier in the same batch', async () => {
    const slug = await seedTarget('entity', 'Wl batch parent fresh')
    await os.batch([
      { op: 'create', kind: 'entity', name: 'Wl Fresh Parent', fields: { type: 'project' } },
      { op: 'update', slug, fields: { parent: 'wl-fresh-parent' } },
    ])
    expect(((await os.read(slug)) as unknown as Read).frontmatter.parent).toBe('wl-fresh-parent')
  })

  it('schema update reflects parent', async () => {
    const out = JSON.parse(await cmdSchema(null, ['update']))
    expect(out.fields.fields.fields.parent).toBeDefined()
  })
})

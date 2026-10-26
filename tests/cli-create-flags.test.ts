// tests/cli-create-flags.test.ts
// Every declared `create` flag is applied or strict-rejected — never silently
// dropped (the knowledge branch used to swallow --brief/--parent/--type, the
// entity branch --subtype/--synthesis/--insight, exit 0 and nothing written).
// Plus the one comma-list parser: trimmed, empty segments dropped, identical
// for create and update.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHafez, removeTemp } from './helpers/hafez.js'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createMemoryJournal } from './helpers/memory-journal.js'
import { cmdCreate, cmdUpdate, CREATE_FLAGS, ONE_FIELD_REPEATS } from '../src/cli/commands.js'
import { cmdSchema } from '../src/cli/commands-schema.js'
import { CreateEntityFieldsSchema } from '../src/batch-ops.js'
import { splitList, UsageError } from '../src/cli/args.js'
import type { Hafez } from '../src/types.js'
import { localDay } from '../src/dates.js'

const TMP = join(tmpdir(), 'hafez-test-cli-create-flags-' + Date.now())
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

interface FlagCase {
  /** Declared CLI flag, without the leading dashes. */
  flag: string
  /** Absent for a switch. */
  value?: string
  /** Kinds the flag is applicable to — every other kind must reject it. */
  applies: Kind[]
  /** Observable proof the flag reached the file. */
  assert(read: { frontmatter: Record<string, any>; body: string }): void
}

const FLAG_CASES: FlagCase[] = [
  { flag: 'type', value: 'project', applies: ['entity'], assert: r => expect(r.frontmatter.type).toBe('project') },
  { flag: 'purpose', value: 'The stated purpose', applies: ['entity'], assert: r => expect(r.body).toContain('The stated purpose') },
  { flag: 'description', value: 'One-line summary', applies: ['entity', 'knowledge'], assert: r => expect(r.frontmatter.description).toBe('One-line summary') },
  { flag: 'resource', value: 'https://example.com/repo', applies: ['entity'], assert: r => expect(r.frontmatter.resource).toEqual(['https://example.com/repo']) },
  { flag: 'domain', value: 'engineering', applies: ['entity', 'knowledge'], assert: r => expect(r.frontmatter.domain).toContain('engineering') },
  { flag: 'parent', value: 'alpha', applies: ['entity'], assert: r => expect(r.frontmatter.parent).toBe('alpha') },
  { flag: 'related', value: 'alpha', applies: ['entity', 'knowledge'], assert: r => expect(r.frontmatter.related).toContain('alpha') },
  { flag: 'tags', value: 'mytag', applies: ['entity', 'knowledge'], assert: r => expect(r.frontmatter.tags).toContain('mytag') },
  { flag: 'brief', value: 'Handoff context', applies: ['entity'], assert: r => expect(r.body).toContain('Handoff context') },
  { flag: 'add-action', value: 'Ship it @dev', applies: ['entity'], assert: r => expect(r.body).toContain('Ship it @dev') },
  { flag: 'subtype', value: 'insight', applies: ['knowledge'], assert: r => expect(r.frontmatter.subtype).toBe('insight') },
  { flag: 'synthesis', value: 'The synthesis body', applies: ['knowledge'], assert: r => expect(r.body).toContain('The synthesis body') },
  { flag: 'insight', value: 'The insight body', applies: ['knowledge'], assert: r => expect(r.body).toContain('The insight body') },
  { flag: 'confidence', value: 'pattern', applies: ['knowledge'], assert: r => expect(r.frontmatter.confidence).toBe('pattern') },
  // Plan-subtype only: the matrix's bare kinds (entity; subtype-less knowledge,
  // which defaults to insight) both reject it. The applied path is covered by
  // tests/plan-subtype.test.ts.
  { flag: 'status', value: 'done', applies: [], assert: () => { throw new Error('unreachable') } },
  { flag: 'new', applies: ['knowledge'], assert: r => expect(r.frontmatter.name).toMatch(/^Mx new/) },
]

/** Args for `create <kind> <name>` with one flag under test. Entity creation
 * always needs --type, so it is added unless the case supplies it. */
function argsFor(kind: Kind, name: string, c: FlagCase): string[] {
  const base = [kind, name]
  if (kind === 'entity' && c.flag !== 'type') base.push('--type', 'project')
  return [...base, `--${c.flag}`, ...(c.value === undefined ? [] : [c.value])]
}

/** The slug: create prints it first, maybe followed by a relate line. */
const firstLine = (out: string) => out.split('\n')[0]

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

describe('create flag × kind matrix — applied or rejected, never dropped', () => {
  for (const c of FLAG_CASES) {
    for (const kind of ['entity', 'knowledge'] as Kind[]) {
      const applicable = c.applies.includes(kind)
      it(`--${c.flag} on ${kind} is ${applicable ? 'applied' : 'rejected'}`, async () => {
        const name = `Mx ${c.flag} ${kind}`
        if (applicable) {
          const slug = await cmdCreate(os, argsFor(kind, name, c))
          c.assert(await os.read(firstLine(slug), 'full') as any)
        } else {
          expect(await errorText(cmdCreate(os, argsFor(kind, name, c))))
            .toMatch(new RegExp(c.flag.replace(/-/g, '[-_]')))
        }
      })
    }
  }

  it('the matrix covers every declared create flag', () => {
    expect(new Set(FLAG_CASES.map(c => c.flag))).toEqual(new Set(Object.keys(CREATE_FLAGS)))
  })
})

describe('non-applicable create flags fail loudly (batch parity)', () => {
  it('knowledge create rejects --brief instead of dropping it', async () => {
    expect(await errorText(cmdCreate(os, ['knowledge', 'Drop Brief Note', '--brief', 'context'])))
      .toMatch(/brief/)
    await expect(os.read('drop-brief-note')).rejects.toThrow()
  })

  it('knowledge create rejects a nonexistent --parent instead of passing unremarked', async () => {
    expect(await errorText(cmdCreate(os, ['knowledge', 'Phantom Parent Note', '--parent', 'no-such-slug'])))
      .toMatch(/parent/)
    await expect(os.read('phantom-parent-note')).rejects.toThrow()
  })

  it('entity create rejects --synthesis instead of dropping it', async () => {
    expect(await errorText(cmdCreate(os, ['entity', 'Drop Synthesis Proj', '--type', 'project', '--synthesis', 'text'])))
      .toMatch(/synthesis/)
    await expect(os.read('drop-synthesis-proj')).rejects.toThrow()
  })

  it('batch rejects the same field — the CLI now matches it', async () => {
    expect(await errorText(os.batch([
      { op: 'create', kind: 'knowledge', name: 'Batch Brief Note', fields: { brief: 'context' } as any },
    ]))).toMatch(/brief/)
  })

  // Same rule as update's action fields: an empty or whitespace-only action
  // used to write an empty checkbox on create.
  it('entity create rejects an empty --add-action instead of writing a blank checkbox', async () => {
    for (const value of ['', '   ']) {
      expect(await errorText(cmdCreate(os, ['entity', 'Blank Action Proj', '--type', 'project', '--add-action', value])))
        .toMatch(/add[-_]action/)
    }
    await expect(os.read('blank-action-proj')).rejects.toThrow()
  })

  // Create carries the same rule as update for the section-setting fields, so
  // the shapes cannot disagree about what an empty value means for one field
  // name. Nothing here is destructive (there is no prior content on create) —
  // it is the false-success half: "created, purpose set" with a blank section.
  // `field` is what the error names: --insight normalizes to synthesis before
  // the shape runs.
  const SECTION_CASES: Array<{ kind: Kind; flag: string; field: string; extra: string[]; slug: string }> = [
    { kind: 'entity', flag: 'purpose', field: 'purpose', extra: ['--type', 'project'], slug: 'blank-purpose-proj' },
    { kind: 'entity', flag: 'brief', field: 'brief', extra: ['--type', 'project'], slug: 'blank-brief-proj' },
    { kind: 'knowledge', flag: 'synthesis', field: 'synthesis', extra: [], slug: 'blank-synthesis-note' },
    { kind: 'knowledge', flag: 'insight', field: 'synthesis', extra: [], slug: 'blank-insight-note' },
  ]
  for (const { kind, flag, field, extra, slug } of SECTION_CASES) {
    it(`${kind} create rejects an empty --${flag}`, async () => {
      const name = slug.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join(' ')
      for (const value of ['', '   ']) {
        expect(await errorText(cmdCreate(os, [kind, name, ...extra, `--${flag}`, value]))).toMatch(new RegExp(field))
      }
      await expect(os.read(slug)).rejects.toThrow()
    })
  }

  it('session create rejects an empty synthesis at the library seam', async () => {
    // No CLI flag for session creates — digest is the producer.
    expect(await errorText(os.batch([
      { op: 'create', kind: 'session', name: 'Blank Session', fields: { synthesis: '  ' } },
    ]))).toMatch(/synthesis/)
  })
})

describe('one comma-list parser — trimmed, empty segments dropped', () => {
  it('splitList trims and drops empty segments', () => {
    expect(splitList('a, b ,c')).toEqual(['a', 'b', 'c'])
    expect(splitList('eng,')).toEqual(['eng'])
    expect(splitList('a,,b')).toEqual(['a', 'b'])
    expect(splitList('')).toEqual([])
    expect(splitList(undefined)).toBeUndefined()
  })

  it('create knowledge --domain "ai, ml" is findable by domain ml', async () => {
    const slug = firstLine(await cmdCreate(os, ['knowledge', 'Spaced Domain Note', '--domain', 'ai, ml']))
    const { frontmatter } = await os.read(slug) as any
    expect(frontmatter.domain).toEqual(['ai', 'ml'])
    const { items } = await os.query_knowledge({ domain: 'ml' })
    expect(items.map(i => i.slug)).toContain(slug)
  })

  it('create --related "alpha, beta" resolves both slugs', async () => {
    const slug = (await cmdCreate(os, ['entity', 'Spaced Related Proj', '--type', 'project', '--related', 'alpha, beta'])).trim()
    const { frontmatter } = await os.read(slug) as any
    expect(frontmatter.related).toEqual(['alpha', 'beta'])
  })

  it('update --related "alpha, beta" resolves both slugs (create/update parity)', async () => {
    await cmdCreate(os, ['entity', 'Update Related Proj', '--type', 'project'])
    await cmdUpdate(os, ['update-related-proj', '--related', 'alpha, beta'])
    const { frontmatter } = await os.read('update-related-proj') as any
    expect(frontmatter.related).toEqual(['alpha', 'beta'])
  })

  it('trailing comma segments never persist on create', async () => {
    const slug = (await cmdCreate(os, ['entity', 'Trailing Comma Proj', '--type', 'project', '--tags', 'a,b,', '--domain', 'eng,'])).trim()
    const { frontmatter } = await os.read(slug) as any
    expect(frontmatter.tags).toEqual(['a', 'b'])
    expect(frontmatter.domain).toEqual(['eng'])
  })

  it('trailing comma segments never persist on update', async () => {
    await cmdCreate(os, ['entity', 'Trailing Update Proj', '--type', 'project'])
    await cmdUpdate(os, ['trailing-update-proj', '--domain', 'eng,', '--tags', 'x,,y'])
    const { frontmatter } = await os.read('trailing-update-proj') as any
    expect(frontmatter.domain).toEqual(['eng'])
    expect(frontmatter.tags).toEqual(['x', 'y'])
  })
})

describe('--resource repeats on create (#305)', () => {
  it('--resource repeated writes every value, in order', async () => {
    const slug = (await cmdCreate(os, ['entity', 'Cw Two Resources', '--type', 'project', '--resource', 'https://github.com/org/repo', '--resource', 'https://docs.example.com'])).trim()
    expect(((await os.read(slug)) as any).frontmatter.resource).toEqual(['https://github.com/org/repo', 'https://docs.example.com'])
  })

  it('--resource "" with a value is a usage error, nothing written', async () => {
    const err = await cmdCreate(os, ['entity', 'Cw Mixed Resource', '--type', 'project', '--resource', '', '--resource', 'https://a.example.com']).then(() => null, e => e)
    expect(err).toBeInstanceOf(UsageError)
    expect(err.message).toContain('--resource ""')
    await expect(os.read('cw-mixed-resource')).rejects.toThrow()
  })
})

describe('Write Line parser on create — repeat-append, repeated scalar, --confidence', () => {
  it('--add-action repeated appends every value, in order', async () => {
    const slug = (await cmdCreate(os, ['entity', 'Cw Repeat Add', '--type', 'project', '--add-action', 'First @dev', '--add-action', 'Second @dev'])).trim()
    const { body } = await os.read(slug, 'full') as any
    expect(body).toContain(`- [ ] First @dev (added ${localDay()})\n- [ ] Second @dev (added ${localDay()})`)
  })

  for (const [flag, type] of Object.entries(CREATE_FLAGS)) {
    if (type === 'repeat') continue
    it(`--${flag} given twice is a usage error naming the flag, nothing written`, async () => {
      const name = `Cw Twice ${flag}`
      const once = [`--${flag}`, flag === 'type' ? 'project' : 'x']
      const base = flag === 'type' ? ['entity', name] : ['entity', name, '--type', 'project']
      const err = await cmdCreate(os, [...base, ...once, ...once]).then(() => null, e => e)
      expect(err).toBeInstanceOf(UsageError)
      expect(err.message).toContain(`--${flag}`)
      await expect(os.read(`cw-twice-${flag}`)).rejects.toThrow()
    })
  }

  // A repeated flag maps to the array form of its field — that field must
  // exist; a one-field repeat (--resource) maps to its own field, a list.
  it('every repeatable create flag has an array field on the entity shape', () => {
    const keys = Object.keys(CreateEntityFieldsSchema.shape)
    for (const [flag, type] of Object.entries(CREATE_FLAGS)) {
      const field = flag.replace(/-/g, '_')
      if (type === 'repeat') expect(keys).toContain(ONE_FIELD_REPEATS.has(flag) ? field : `${field}s`)
    }
  })

  it('create knowledge --confidence observation writes it', async () => {
    const slug = firstLine(await cmdCreate(os, ['knowledge', 'Cw Observed Note', '--confidence', 'observation']))
    expect(((await os.read(slug)) as any).frontmatter.confidence).toBe('observation')
  })

  it('create knowledge --confidence principle overrides the observation default', async () => {
    const slug = firstLine(await cmdCreate(os, ['knowledge', 'Cw Principled Note', '--confidence', 'principle']))
    expect(((await os.read(slug)) as any).frontmatter.confidence).toBe('principle')
  })

  it('an invalid --confidence is rejected by name, nothing written', async () => {
    const text = await errorText(cmdCreate(os, ['knowledge', 'Cw Bad Confidence', '--confidence', 'certain']))
    expect(text).toMatch(/confidence/)
    expect(text).toMatch(/observation/)
    await expect(os.read('cw-bad-confidence')).rejects.toThrow()
  })

  it('the batch create-knowledge shape accepts confidence', async () => {
    await os.batch([{ op: 'create', kind: 'knowledge', name: 'Cw Batch Confidence', fields: { confidence: 'pattern' } }])
    expect(((await os.read('cw-batch-confidence')) as any).frontmatter.confidence).toBe('pattern')
  })

  it('schema create-knowledge reflects confidence', async () => {
    const out = JSON.parse(await cmdSchema(null, ['create-knowledge']))
    expect(out.fields.fields.fields.confidence.enum).toEqual(['observation', 'pattern', 'principle'])
  })
})

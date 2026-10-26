// tests/cli-update-output.test.ts
// What `update` prints (#95): one line saying what changed, and a misuse that
// says nothing was written and ends with the Footer `read` shows for that
// slug (a slug that does not exist: the `read` miss instead). Asserted at the
// command-function seam over a memory-Journal factory — the string returned
// or the error thrown, and the vault file afterwards. The three update
// samples are checked whole in tests/surfaces.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHafez, removeTemp } from './helpers/hafez.js'
import { createMemoryJournal } from './helpers/memory-journal.js'
import { cmdRead, cmdUpdate } from '../src/cli/commands.js'
import { RenderedError, UsageError } from '../src/cli/args.js'
import { exitCodeFor } from '../src/cli/index.js'
import { ITEMS } from '../src/surfaces/items.js'
import type { Hafez } from '../src/types.js'

const TMP = join(tmpdir(), 'hafez-test-cli-update-output-' + Date.now())
const VAULT = join(TMP, 'vault')

let os: Hafez

beforeAll(async () => {
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })
  os = createHafez({ vaultPath: VAULT, persistence: createMemoryJournal() })
  await os.create('entity', 'Auth Refactor', { type: 'project', add_actions: ['Migrate the mobile client', 'Remove the cookie fallback'] })
  await os.create('entity', 'Platform', { type: 'project' })
})
afterAll(() => removeTemp(TMP))

let seq = 0
const entity = async (actions: string[] = []) =>
  os.create('entity', `Output Entity ${++seq}`, { type: 'entity', ...(actions.length > 0 && { add_actions: actions }) })
const insight = async () => os.create('knowledge', `Output Insight ${++seq}`, { synthesis: 'Something held.' })
const fileOf = (slug: string, dir = 'entities') => readFileSync(join(VAULT, dir, `${slug}.md`), 'utf-8')
const handles = async (slug: string) => [...(await cmdRead(os, [slug])).matchAll(/^- \[ \] ([0-9a-f]+) {2}/gm)].map(m => m[1])
/** Everything from the blank line before the rule: the Footer portion. */
const footerOf = (out: string) => out.slice(out.lastIndexOf('\n\n---\n') + 1)

async function failure(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (err) {
    return err as Error
  }
  throw new Error('expected a rejection, got success')
}

describe('update success: one line saying what changed', () => {
  it('names the log, the tick and the add, in the Footer\'s order', async () => {
    const [first] = await handles('auth-refactor')
    const out = await cmdUpdate(os, ['auth-refactor', '--log', 'progress: Web client switched', '--complete-action', first, '--add-action', 'Ask security about refresh lifetime'])
    expect(out).toBe('Updated auth-refactor: log added, 1 action ticked, 1 action added.')
  })

  // Every flag alone (or with what it needs), and the exact line: nothing it
  // did not touch is named. An entity write that is not actions alone carries
  // the mechanised log, so "log added" is named too.
  const ENTITY_CASES: Array<[string[], string]> = [
    [['--log', 'decision: Tokens over cookies'], 'log added'],
    [['--log', 'decision: Tokens over cookies', '--body', 'Detail'], 'log added'],
    [['--add-action', 'One'], '1 action added'],
    [['--add-action', 'One', '--add-action', 'Two'], '2 actions added'],
    [['--clear-actions'], 'actions cleared'],
    [['--brief', 'Where it stands'], 'log added, brief set'],
    [['--brief', ''], 'log added, brief cleared'],
    [['--current-state', 'Halfway'], 'log added, current state set'],
    [['--related', 'platform'], 'log added, related set'],
    [['--related', ''], 'log added, related cleared'],
    [['--parent', 'platform'], 'log added, parent set to platform'],
    [['--status', 'paused'], 'log added, status set to paused'],
    [['--description', 'One sentence'], 'log added, description set'],
    [['--description', ''], 'log added, description cleared'],
    [['--resource', 'https://example.com'], 'log added, resource added'],
    [['--resource', 'https://a.example.com', '--resource', 'https://b.example.com'], 'log added, resource added'],
    [['--resource', ''], 'log added, resource cleared'],
    [['--domain', 'eng,ops'], 'log added, domain set'],
    [['--tags', 'a,b'], 'log added, tags set'],
    [['--brief', 'x', '--agent', 'someone'], 'log added, brief set'],
  ]
  for (const [argv, said] of ENTITY_CASES) {
    it(`entity ${argv.join(' ')} → ${said}`, async () => {
      const slug = await entity(['Seeded'])
      expect(await cmdUpdate(os, [slug, ...argv])).toBe(`Updated ${slug}: ${said}.`)
    })
  }

  it('ticking and removing by Handle', async () => {
    const slug = await entity(['Tick me', 'Drop me', 'Keep me'])
    const [tick, drop] = await handles(slug)
    expect(await cmdUpdate(os, [slug, '--complete-action', tick, '--remove-action', drop]))
      .toBe(`Updated ${slug}: 1 action ticked, 1 action removed.`)
  })

  it('repeated --complete-action and --remove-action count each', async () => {
    const slug = await entity(['One', 'Two', 'Three', 'Four', 'Keep'])
    expect(await cmdUpdate(os, [slug, '--complete-action', 'One', '--complete-action', 'Two', '--remove-action', 'Three', '--remove-action', 'Four']))
      .toBe(`Updated ${slug}: 2 actions ticked, 2 actions removed.`)
  })

  it('a resource already held (another spelling of it) is not named', async () => {
    const slug = await entity()
    await cmdUpdate(os, [slug, '--resource', 'https://github.com/org/held'])
    expect(await cmdUpdate(os, [slug, '--resource', 'git@github.com:Org/Held.git'])).toBe(`Updated ${slug}.`)
    expect(await cmdUpdate(os, [slug, '--resource', 'https://github.com/org/held', '--status', 'paused']))
      .toBe(`Updated ${slug}: log added, status set to paused.`)
    expect(await cmdUpdate(os, [slug, '--resource', 'https://github.com/org/held', '--resource', '/srv/held']))
      .toBe(`Updated ${slug}: log added, resource added.`)
  })

  const KNOWLEDGE_CASES: Array<[string[], string]> = [
    [['--synthesis', 'Rewritten.'], 'synthesis set'],
    [['--insight', 'Rewritten.'], 'synthesis set'],
    [['--add-evidence', 'Seen again'], 'evidence added'],
    [['--add-source', 'https://example.com'], 'source added'],
    [['--confidence', 'pattern'], 'confidence set to pattern'],
    [['--domain', 'eng'], 'domain set'],
    [['--tags', ''], 'tags cleared'],
    [['--related', 'platform', '--add-evidence', 'Seen again'], 'related set, evidence added'],
  ]
  for (const [argv, said] of KNOWLEDGE_CASES) {
    it(`knowledge ${argv.join(' ')} → ${said}`, async () => {
      const slug = await insight()
      expect(await cmdUpdate(os, [slug, ...argv])).toBe(`Updated ${slug}: ${said}.`)
    })
  }

  it('a plan: status', async () => {
    const slug = await os.create('knowledge', `Output Plan ${++seq}`, { subtype: 'plan', status: 'active' })
    expect(await cmdUpdate(os, [slug, '--status', 'done'])).toBe(`Updated ${slug}: status set to done.`)
  })
})

describe('update misuse: the error, nothing written, then the Footer', () => {
  // Each misuse kind the CLI or the Op Spec catches: the output is the error
  // line ending "Nothing was written.", then exactly the Footer `read` prints.
  const MISUSES: Array<[string, string[], RegExp]> = [
    ['an unknown flag', ['--add-actions', 'x'], /^Error: update has no flag --add-actions\. Nothing was written\.$/],
    // Object.prototype member names are undeclared flags too, not already-given ones (#134)
    ...['constructor', 'toString', 'hasOwnProperty', '__proto__'].map((name): [string, string[], RegExp] =>
      [`a flag named after Object.prototype.${name}`, [`--${name}`, 'x'], new RegExp(`^Error: update has no flag --${name}\\. Nothing was written\\.$`)]),
    ['a repeated scalar', ['--brief', 'a', '--brief', 'b'], /^Error: --brief was given more than once; it takes one value\. Nothing was written\.$/],
    ['a missing value', ['--brief'], /^Error: --brief requires a value\. Nothing was written\.$/],
    ['a bad enum', ['--status', 'finished'], /^Error: .*status.*"active"\|"paused"\|"done".*\. Nothing was written\.$/],
    ['a log with no type', ['--log', 'did the thing'], /^Error: --log format: .*\. Nothing was written\.$/],
    ['a bad log type', ['--log', 'shipped: it'], /^Error: .*session_log\.type.*\. Nothing was written\.$/],
    ['no flag at all', [], /^Error: update needs at least one flag\. Nothing was written\.$/],
    ['an action no open line matches', ['--complete-action', 'zzzz'], /^Error: No matching action for "zzzz"\. Actions: \["Seeded"\]\. Nothing was written\.$/],
    ['an action two open lines match', ['--remove-action', 'e'], /^Error: Ambiguous match for "e": Seeded, Second\. Nothing was written\.$/],
    ['remove and complete naming one line', ['--remove-action', 'Seeded', '--complete-action', 'Seeded'], /^Error: remove_action and complete_action both match "Seeded" — one line, one field\. Nothing was written\.$/],
  ]
  for (const [what, argv, errorLine] of MISUSES) {
    it(`${what}: the Footer, exit 2, the file unchanged`, async () => {
      const slug = await entity(what.includes('two open lines') ? ['Seeded', 'Second'] : ['Seeded'])
      const before = fileOf(slug)
      const err = await failure(cmdUpdate(os, [slug, ...argv]))
      expect(err).toBeInstanceOf(RenderedError)
      const { output, stream } = err as RenderedError
      expect(stream).toBe('stderr')
      expect(output.split('\n')[0]).toMatch(errorLine)
      expect(output.slice(output.indexOf('\n') + 1)).toBe(footerOf(await cmdRead(os, [slug])))
      expect(exitCodeFor(err)).toBe(2)
      expect(fileOf(slug)).toBe(before)
    })
  }

  it('a knowledge note gets its own Footer', async () => {
    const slug = await insight()
    const before = fileOf(slug, 'knowledge')
    const err = await failure(cmdUpdate(os, [slug, '--brief', 'x']))
    const { output } = err as RenderedError
    expect(output.split('\n')[0]).toBe('Error: Cannot set entity-only fields on knowledge note: brief. Nothing was written.')
    expect(output.slice(output.indexOf('\n') + 1)).toBe(footerOf(await cmdRead(os, [slug])))
    expect(output).toContain('--add-evidence')
    expect(exitCodeFor(err)).toBe(2)
    expect(fileOf(slug, 'knowledge')).toBe(before)
  })

  it('a slug that does not exist: the miss output instead of the Footer, exit 2', async () => {
    const err = await failure(cmdUpdate(os, ['auth-refactr', '--add-actions', 'x']))
    expect((err as RenderedError).output).toBe([
      'Error: update has no flag --add-actions. Nothing was written.',
      '',
      ITEMS.slugMissRecovery.render({ slug: 'auth-refactr', closest: ['auth-refactor'] }),
    ].join('\n'))
    expect(exitCodeFor(err)).toBe(2)
  })

  it('a well-formed update to a slug that does not exist: the miss output, the not-found code', async () => {
    const err = await failure(cmdUpdate(os, ['auth-refactr', '--brief', 'x']))
    expect(err).toBeInstanceOf(RenderedError)
    expect((err as RenderedError).output).toBe(ITEMS.slugMissRecovery.render({ slug: 'auth-refactr', closest: ['auth-refactor'] }))
    expect(exitCodeFor(err)).toBe(1)
  })

  it('under --json a missing slug is the read miss as JSON on stdout', async () => {
    const err = await failure(cmdUpdate(os, ['auth-refactr', '--brief', 'x'], { json: true }))
    expect(err).toBeInstanceOf(RenderedError)
    expect((err as RenderedError).stream).toBe('stdout')
    expect(JSON.parse((err as RenderedError).output)).toEqual({ slug: 'auth-refactr', closest: ['auth-refactor'] })
    expect(exitCodeFor(err)).toBe(1)
  })

  it('no slug at all: the usage error, no Footer', async () => {
    const err = await failure(cmdUpdate(os, ['--add-actions', 'x']))
    expect(err).toBeInstanceOf(UsageError)
    expect(exitCodeFor(err)).toBe(2)
  })
})

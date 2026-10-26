// tests/multi-resource.test.ts
// `resource` is a list (#304): the library Spine through the test helper.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHafez, removeTemp } from './helpers/hafez.js'
import { createMemoryJournal } from './helpers/memory-journal.js'

let TMP: string
let VAULT: string

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), 'hafez-multi-resource-'))
  VAULT = join(TMP, 'vault')
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })
})

afterEach(() => removeTemp(TMP))

const makeOS = () => createHafez({ vaultPath: VAULT, persistence: createMemoryJournal() })
const fileOf = (slug: string) => readFileSync(join(VAULT, 'entities', `${slug}.md`), 'utf-8')
const resourceOf = async (os: ReturnType<typeof makeOS>, slug: string) =>
  (await os.query({ filter: 'all' })).items.find(i => i.slug === slug)!.resource

describe('create', () => {
  it('a string is a one-value list, written as a YAML list', async () => {
    const os = makeOS()
    await os.create('entity', 'One', { type: 'project', resource: 'https://github.com/org/repo' })
    expect(fileOf('one')).toMatch(/^resource:\n {2}- 'https:\/\/github\.com\/org\/repo'\n/m)
    expect(await resourceOf(os, 'one')).toEqual(['https://github.com/org/repo'])
  })

  it('a list keeps its order and drops a later spelling of the same repo', async () => {
    const os = makeOS()
    await os.create('entity', 'Two', { type: 'project', resource: ['git@github.com:Org/Repo.git', '/srv/docs', 'https://github.com/org/repo'] })
    expect(await resourceOf(os, 'two')).toEqual(['git@github.com:Org/Repo.git', '/srv/docs'])
  })

  it('only URL-shaped values compare normalised: any other spelling is its own value', async () => {
    const os = makeOS()
    const values = ['~/Work/App', '~/work/app', 'C:\\Work\\App', 'c:\\work\\app', 'docs/App', 'docs/app', 'github.com/org/app']
    await os.create('entity', 'Paths', { type: 'project', resource: [...values, 'https://github.com/org/app'] })
    expect(await resourceOf(os, 'paths')).toEqual([...values, 'https://github.com/org/app'])
  })

  it('no resource is an empty list', async () => {
    const os = makeOS()
    await os.create('entity', 'None', { type: 'entity' })
    expect(fileOf('none')).not.toContain('resource')
    expect(await resourceOf(os, 'none')).toEqual([])
  })
})

describe('update', () => {
  it('appends, skipping an ssh or https spelling of a repo already held', async () => {
    const os = makeOS()
    await os.create('entity', 'App', { type: 'project', resource: 'https://github.com/org/repo' })
    await os.update('app', { resource: 'git@github.com:org/repo.git' })
    await os.update('app', { resource: ['/srv/app', 'https://github.com/org/repo-dev'] })
    await os.update('app', { resource: '/srv/app' })
    expect(await resourceOf(os, 'app')).toEqual(['https://github.com/org/repo', '/srv/app', 'https://github.com/org/repo-dev'])
  })

  it.each([[null], [''], [[]]])('%j clears every value', async (clear) => {
    const os = makeOS()
    await os.create('entity', 'Clear', { type: 'entity', resource: ['https://example.com/a', '/srv/b'] })
    await os.update('clear', { resource: clear as string | string[] | null })
    expect(fileOf('clear')).not.toMatch(/^resource:/m)
    expect(await resourceOf(os, 'clear')).toEqual([])
  })

  it('a resource already held writes no log entry naming it', async () => {
    const os = makeOS()
    await os.create('entity', 'Held', { type: 'project', resource: 'https://github.com/org/held' })
    await os.update('held', { resource: 'git@github.com:org/held.git' })
    await os.update('held', { resource: ['https://github.com/org/held'], status: 'paused' })
    const log = fileOf('held').slice(fileOf('held').indexOf('## Session Log'))
    expect(log.match(/^Summary: .*$/gm)).toEqual(['Summary: Updated status'])
    expect(await resourceOf(os, 'held')).toEqual(['https://github.com/org/held'])
  })

  it('a write that does not name resource leaves it alone', async () => {
    const os = makeOS()
    await os.create('entity', 'Kept', { type: 'entity', resource: '/srv/kept' })
    await os.update('kept', { brief: 'moved on' })
    expect(await resourceOf(os, 'kept')).toEqual(['/srv/kept'])
  })
})

describe('rejects, writing nothing', () => {
  it("'' beside a value", async () => {
    const os = makeOS()
    await expect(os.create('entity', 'Mixed', { type: 'entity', resource: ['', '/srv/x'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await os.create('entity', 'Mixed', { type: 'entity', resource: '/srv/x' })
    const before = fileOf('mixed')
    await expect(os.update('mixed', { resource: ['/srv/y', ''] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    expect(fileOf('mixed')).toBe(before)
  })

  it('a literal `.`, naming the CLI as the resolver', async () => {
    const os = makeOS()
    await expect(os.create('entity', 'Dot', { type: 'entity', resource: '.' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining("`.` is resolved by the CLI; pass the folder's remote URL or path") })
    expect(() => fileOf('dot')).toThrow()
    await os.create('entity', 'Dot', { type: 'entity' })
    const before = fileOf('dot')
    await expect(os.update('dot', { resource: ['/srv/x', '.'] }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('`.` is resolved by the CLI') })
    expect(fileOf('dot')).toBe(before)
  })
})

describe('a legacy scalar', () => {
  const legacy = "---\nname: Old\ntype: project\nstatus: active\ncreated: '2026-01-01'\nlast-touched: '2026-01-01'\nresource: https://github.com/org/old\n---\n## Purpose\n"

  it('reads as a one-value list and is rewritten as a list only on its next write', async () => {
    writeFileSync(join(VAULT, 'entities', 'old.md'), legacy)
    const os = makeOS()
    expect(await resourceOf(os, 'old')).toEqual(['https://github.com/org/old'])
    await os.read('old')
    await os.rebuildIndex()
    expect(await resourceOf(os, 'old')).toEqual(['https://github.com/org/old'])
    expect(fileOf('old')).toBe(legacy)
    await os.update('old', { resource: '/srv/old' })
    expect(fileOf('old')).toMatch(/^resource:\n {2}- 'https:\/\/github\.com\/org\/old'\n {2}- \/srv\/old\n/m)
  })
})

describe('promote', () => {
  it('entity to project keeps the list; capture to knowledge drops it', async () => {
    const os = makeOS()
    await os.create('entity', 'To Project', { type: 'entity', resource: ['/srv/a', 'https://example.com/a'] })
    await os.promote('to-project', 'project')
    expect(await resourceOf(os, 'to-project')).toEqual(['/srv/a', 'https://example.com/a'])
    const note = await os.capture('To Note')
    await os.update(note, { resource: ['/srv/b', 'https://example.com/b'] })
    await os.promote(note, 'knowledge')
    expect(readFileSync(join(VAULT, 'knowledge', 'to-note.md'), 'utf-8')).not.toContain('resource')
  })
})

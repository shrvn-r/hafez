// tests/brief-actions.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createHafez } from '../src/index.js'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import simpleGit from 'simple-git'

const TMP = join(tmpdir(), 'hafez-test-brief-actions-' + Date.now())
const BARE = join(TMP, 'remote.git')
const VAULT = join(TMP, 'vault')

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  mkdirSync(BARE, { recursive: true })
  await simpleGit(BARE).init(true)
  await simpleGit().clone(BARE, VAULT)
  mkdirSync(join(VAULT, 'entities'), { recursive: true })
  mkdirSync(join(VAULT, 'knowledge'), { recursive: true })
  writeFileSync(join(VAULT, '.gitkeep'), '')
  const git = simpleGit(VAULT)
  await git.add('.gitkeep')
  await git.commit('init')
  const branch = (await git.branchLocal()).current
  await git.push('origin', branch)
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

function makeOS() {
  return createHafez({ vaultPath: VAULT, git: { push: false } })
}

describe('Brief via update()', () => {
  it('sets a brief on an entity', async () => {
    const os = makeOS()
    await os.create('entity', 'Brief Test Project', { type: 'project', purpose: 'Testing' })
    await os.update('brief-test-project', { brief: 'This is the handoff context.\nMultiple lines.' })

    const { body } = await os.read('brief-test-project', 'full')
    expect(body).toContain('## Brief')
    expect(body).toContain('This is the handoff context.')
    expect(body.indexOf('## Brief')).toBeLessThan(body.indexOf('## Session Log'))
  })

  it('replaces an existing brief', async () => {
    const os = makeOS()
    await os.update('brief-test-project', { brief: 'Updated brief.' })
    const { body } = await os.read('brief-test-project', 'full')
    expect(body).toContain('Updated brief.')
    expect(body).not.toContain('This is the handoff context.')
  })

  it('removes brief when set to null', async () => {
    const os = makeOS()
    await os.update('brief-test-project', { brief: null })
    const { body } = await os.read('brief-test-project', 'full')
    expect(body).not.toContain('## Brief')
  })

  it('brief appears in summary depth', async () => {
    const os = makeOS()
    await os.update('brief-test-project', { brief: 'Visible in summary.' })
    const { body } = await os.read('brief-test-project', 'summary')
    expect(body).toContain('Visible in summary.')
  })
})

describe('Next Actions via update()', () => {
  it('adds a next action', async () => {
    const os = makeOS()
    await os.create('entity', 'Actions Test Project', { type: 'project' })
    await os.update('actions-test-project', { add_action: 'Deploy to VPS @dev' })

    const { body } = await os.read('actions-test-project', 'full')
    expect(body).toContain('## Next Actions')
    expect(body).toContain('- [ ] Deploy to VPS @dev')
  })

  it('adds multiple actions', async () => {
    const os = makeOS()
    await os.update('actions-test-project', { add_action: 'Test /start command @simorgh' })
    const { body } = await os.read('actions-test-project', 'full')
    expect(body).toContain('Deploy to VPS @dev')
    expect(body).toContain('Test /start command @simorgh')
  })

  it('completes an action by substring', async () => {
    const os = makeOS()
    const result = await os.update('actions-test-project', { complete_action: 'Deploy' })
    expect(result.matched_action).toBe('Deploy to VPS @dev')
    const { body } = await os.read('actions-test-project', 'full')
    expect(body).not.toContain('- [ ] Deploy to VPS @dev')
    expect(body).toContain('Test /start command @simorgh')
  })

  it('removes an action', async () => {
    const os = makeOS()
    const result = await os.update('actions-test-project', { remove_action: '/start' })
    expect(result.matched_action).toBe('Test /start command @simorgh')
    const { body } = await os.read('actions-test-project', 'full')
    expect(body).not.toContain('## Next Actions') // last item removed, section gone
  })

  it('clear_actions removes entire section', async () => {
    const os = makeOS()
    await os.update('actions-test-project', { add_action: 'Action 1 @dev' })
    await os.update('actions-test-project', { add_action: 'Action 2 @dev' })
    await os.update('actions-test-project', { clear_actions: true })
    const { body } = await os.read('actions-test-project', 'full')
    expect(body).not.toContain('## Next Actions')
  })
})

describe('Next Actions on create (add_actions parity with update)', () => {
  // Seeding a project with N actions used to force create + follow-up
  // update, because create only accepted single add_action.
  it('create() accepts add_actions array', async () => {
    const os = makeOS()
    await os.create('entity', 'Seeded Project', {
      type: 'project',
      add_actions: ['First task @dev', 'Second task @dev', 'Third task @dev'],
    })
    const { body } = await os.read('seeded-project', 'full')
    expect(body).toContain('- [ ] First task @dev')
    expect(body).toContain('- [ ] Second task @dev')
    expect(body).toContain('- [ ] Third task @dev')
  })

  it('batch create accepts add_actions array', async () => {
    const os = makeOS()
    await os.batch([
      { op: 'create', kind: 'entity', name: 'Batch Seeded Project', fields: {
        type: 'project',
        add_action: 'Single one @dev',
        add_actions: ['Array one @dev', 'Array two @dev'],
      } },
    ])
    const { body } = await os.read('batch-seeded-project', 'full')
    expect(body).toContain('- [ ] Single one @dev')
    expect(body).toContain('- [ ] Array one @dev')
    expect(body).toContain('- [ ] Array two @dev')
  })
})

describe('Query with body-parsed next actions', () => {
  it('query returns first unchecked action and count', async () => {
    const os = makeOS()
    await os.create('entity', 'Query Actions Test', { type: 'project' })
    await os.update('query-actions-test', { add_action: 'First action @dev' })
    await os.update('query-actions-test', { add_action: 'Second action @simorgh' })

    const { items: results } = await os.query({ filter: 'active', type: 'project' })
    const item = results.find(r => r.slug === 'query-actions-test')
    expect(item).toBeDefined()
    expect(item!.next_action).toBe('First action @dev')
    expect(item!.next_action_count).toBe(2)
  })

  it('query returns null next_action when no actions section', async () => {
    const os = makeOS()
    await os.create('entity', 'No Actions Entity', { type: 'project' })
    const { items: results } = await os.query({ filter: 'active', type: 'project' })
    const item = results.find(r => r.slug === 'no-actions-entity')
    expect(item).toBeDefined()
    expect(item!.next_action).toBeNull()
    expect(item!.next_action_count).toBe(0)
  })
})

describe('Brief and Next Actions via create()', () => {
  it('creates entity with brief', async () => {
    const os = makeOS()
    await os.create('entity', 'Create Brief Test', { type: 'project', brief: 'Initial handoff context.' })
    const { body } = await os.read('create-brief-test', 'full')
    expect(body).toContain('## Brief')
    expect(body).toContain('Initial handoff context.')
  })

  it('creates entity with add_action', async () => {
    const os = makeOS()
    await os.create('entity', 'Create Action Test', { type: 'project', add_action: 'First task @dev' })
    const { body } = await os.read('create-action-test', 'full')
    expect(body).toContain('## Next Actions')
    expect(body).toContain('- [ ] First task @dev')
  })

  it('creates entity with both brief and add_action', async () => {
    const os = makeOS()
    await os.create('entity', 'Create Both Test', { type: 'project', brief: 'Context here.', add_action: 'Do something @dev' })
    const { body } = await os.read('create-both-test', 'full')
    expect(body).toContain('## Brief')
    expect(body).toContain('Context here.')
    expect(body).toContain('## Next Actions')
    expect(body).toContain('- [ ] Do something @dev')
    // Brief should come before Next Actions
    expect(body.indexOf('## Brief')).toBeLessThan(body.indexOf('## Next Actions'))
  })
})

describe('Batch with Brief and Next Actions', () => {
  it('batch update sets brief and adds action', async () => {
    const os = makeOS()
    await os.create('entity', 'Batch Test', { type: 'project' })
    await os.batch([
      { op: 'update', slug: 'batch-test', fields: { brief: 'Batch brief content.' } },
      { op: 'update', slug: 'batch-test', fields: { add_action: 'Batch action @dev' } },
    ])
    const { body } = await os.read('batch-test', 'full')
    expect(body).toContain('## Brief')
    expect(body).toContain('Batch brief content.')
    expect(body).toContain('- [ ] Batch action @dev')
  })

  it('batch create with brief and add_action persists both', async () => {
    const os = makeOS()
    await os.batch([
      { op: 'create', kind: 'entity', name: 'Batch Create Fields', fields: {
        type: 'project', brief: 'Batch brief.', add_action: 'Batch task @dev',
      } },
    ])
    const { body } = await os.read('batch-create-fields', 'full')
    expect(body).toContain('## Brief')
    expect(body).toContain('Batch brief.')
    expect(body).toContain('- [ ] Batch task @dev')
  })

  it('batch create then update same entity in one batch', async () => {
    const os = makeOS()
    await os.batch([
      { op: 'create', kind: 'entity', name: 'Batch Chain Test', fields: { type: 'project' } },
      { op: 'update', slug: 'batch-chain-test', fields: { add_action: 'Chained action @dev' } },
    ])
    const { body } = await os.read('batch-chain-test', 'full')
    expect(body).toContain('- [ ] Chained action @dev')
  })

  it('batch returns results with created slugs', async () => {
    const os = makeOS()
    const results = await os.batch([
      { op: 'create', kind: 'entity', name: 'Result Test One', fields: { type: 'entity' } },
      { op: 'update', slug: 'result-test-one', fields: { brief: 'Updated.' } },
    ])
    expect(results).toHaveLength(2)
    expect(results[0]).toEqual({ op: 'create', slug: 'result-test-one', status: 'ok', created: true })
    expect(results[1]).toEqual({ op: 'update', slug: 'result-test-one', status: 'ok' })
  })
})

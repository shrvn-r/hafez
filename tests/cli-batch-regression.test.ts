// tests/cli-batch-regression.test.ts
//
// Phase 0 regression guard. Each fixture in tests/fixtures/batch-regression/
// is a real batch payload captured from a past session. Running the fixture
// against a seeded temp vault produces a set of file changes; that set is
// compared against a checked-in golden (git status --porcelain output).
//
// Regenerate goldens with:
//   UPDATE_GOLDENS=1 npx vitest run tests/cli-batch-regression.test.ts
//
// A diff is a regression unless the golden is intentionally regenerated.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import simpleGit from 'simple-git'
import { createHafez } from '../src/index.js'
import { serializeFile } from '../src/vault.js'
import { parseBatchInput } from '../src/cli/commands.js'

const FIXTURES_DIR = join(process.cwd(), 'tests', 'fixtures', 'batch-regression')
const ROOT = join(tmpdir(), 'hafez-batch-regression-' + Date.now())
const UPDATE = process.env.UPDATE_GOLDENS === '1'

interface Fixture {
  name: string
  ops: unknown[]
  goldenPath: string
}

function loadFixtures(): Fixture[] {
  const files = ['01-single-op-update', '02-multi-op-mixed', '03-session-log-updates']
  return files.map(name => {
    const ops = JSON.parse(readFileSync(join(FIXTURES_DIR, `${name}.json`), 'utf-8'))
    return {
      name,
      ops,
      goldenPath: join(FIXTURES_DIR, `golden-${name.split('-')[0]}.txt`),
    }
  })
}

async function seedVault(path: string): Promise<void> {
  const bare = join(ROOT, `${Math.random().toString(36).slice(2)}.git`)
  mkdirSync(path, { recursive: true })
  mkdirSync(bare, { recursive: true })
  await simpleGit(bare).init(true)
  await simpleGit().clone(bare, path)
  mkdirSync(join(path, 'entities'), { recursive: true })
  mkdirSync(join(path, 'knowledge'), { recursive: true })
  mkdirSync(join(path, 'sessions'), { recursive: true })

  // Seed entities referenced by fixtures. The fixtures reference:
  //   hafez, simorgh-dashboard, phase-2-dashboard-vault-reader-replacement,
  //   phase-3-hafez-simorgh-integration
  const today = '2026-04-11'
  // Seed entities that the fixtures REFERENCE (as update targets or link
  // endpoints). Do NOT pre-create entities the fixtures themselves create.
  const seedEntities = [
    'hafez',
    'simorgh-dashboard',
    'phase-2-dashboard-vault-reader-replacement',
  ]
  for (const slug of seedEntities) {
    writeFileSync(
      join(path, 'entities', `${slug}.md`),
      serializeFile(
        { name: slug, type: 'project', status: 'active', created: today, 'last-touched': today },
        '## Purpose\n\nSeed.\n\n## Next Actions\n\n- [ ] Execute Phase 1 implementation plan\n- [ ] Implement knowledge subtype schema\n\n## Session Log\n',
      ),
    )
  }

  const git = simpleGit(path)
  await git.add('.')
  await git.commit('seed')
  const branch = (await git.branchLocal()).current
  await git.push('origin', branch)
}

async function runFixture(fixture: Fixture): Promise<string> {
  const vault = join(ROOT, fixture.name)
  await seedVault(vault)
  const git = simpleGit(vault)
  const seedHead = (await git.revparse(['HEAD'])).trim()

  const os = createHafez({ vaultPath: vault, git: { push: false } })
  const ops = parseBatchInput(JSON.stringify(fixture.ops))
  await os.batch(ops)

  // Batch commits atomically — diff the seed commit to current HEAD to see
  // every file the fixture touched. Strip SQLite index noise (the FTS5 DB is
  // an implementation detail that changes on every build).
  const raw = await git.raw(['diff', '--name-status', seedHead, 'HEAD'])
  const lines = raw
    .split('\n')
    .filter(Boolean)
    .filter(l => !l.includes('.hafez.db'))
    .sort()
  return lines.join('\n')
}

beforeAll(() => {
  mkdirSync(ROOT, { recursive: true })
})

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

describe('batch regression fixtures', () => {
  const fixtures = loadFixtures()
  for (const fixture of fixtures) {
    it(`${fixture.name} matches golden`, async () => {
      const actual = await runFixture(fixture)

      if (UPDATE) {
        writeFileSync(fixture.goldenPath, actual + '\n')
        return
      }

      if (!existsSync(fixture.goldenPath)) {
        // First-run convenience: write the golden so reviewers can inspect
        // it in the same PR that adds the test.
        writeFileSync(fixture.goldenPath, actual + '\n')
        return
      }

      const golden = readFileSync(fixture.goldenPath, 'utf-8').trimEnd()
      expect(actual).toBe(golden)
    })
  }
})

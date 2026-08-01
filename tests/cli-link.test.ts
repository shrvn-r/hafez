// tests/cli-link.test.ts
//
// Naming alignment — `hafez link` and `hafez unlink` now accept a
// `--relation <value>` named flag. The legacy positional form remains
// accepted as a deprecated alias with a one-line warning on stderr.
// Batch JSON with `kind: parent` (the old drift) now fails strictly
// with a did-you-mean hint pointing at `relation`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawnSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import simpleGit from 'simple-git'
import { serializeFile } from '../src/vault.js'
import { parseBatchInput } from '../src/cli/commands.js'
import { HafezError } from '../src/types.js'

const TMP = join(tmpdir(), 'hafez-cli-link-test-' + Date.now())
const BARE = join(TMP, 'remote.git')
const VAULT = join(TMP, 'vault')
const CLI = join(process.cwd(), 'dist', 'cli.js')

function run(...args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = spawnSync('node', [CLI, '--vault', VAULT, ...args], { encoding: 'utf-8' })
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    exitCode: result.status ?? 1,
  }
}

beforeAll(async () => {
  mkdirSync(TMP, { recursive: true })
  mkdirSync(BARE, { recursive: true })
  await simpleGit(BARE).init(true)
  await simpleGit().clone(BARE, VAULT)
  mkdirSync(join(VAULT, 'entities'), { recursive: true })

  const today = new Date().toISOString().slice(0, 10)
  for (const name of ['foo', 'bar']) {
    writeFileSync(
      join(VAULT, 'entities', `${name}.md`),
      serializeFile(
        { name, type: 'entity', status: 'active', created: today, 'last-touched': today },
        '## Context\n\n',
      ),
    )
  }
  const git = simpleGit(VAULT)
  await git.add('.')
  await git.commit('seed')
  const branch = (await git.branchLocal()).current
  await git.push('origin', branch)
})

afterAll(() => rmSync(TMP, { recursive: true, force: true }))

describe('cli link: removed positional relation form is rejected', () => {
  it('positional relation errors with usage', () => {
    const { stderr, exitCode } = run('link', 'foo', 'bar', 'related')
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('--relation')
  })
})

describe('cli link: --relation flag works cleanly', () => {
  it('--relation flag succeeds', () => {
    const { stdout, stderr, exitCode } = run('link', 'foo', 'bar', '--relation', 'related')
    expect(exitCode).toBe(0)
    expect(stdout).toContain('Linked foo')
    expect(stderr).not.toContain('deprecated')
    // Clean up the link for later tests
    const unlinked = run('unlink', 'foo', 'bar', '--relation', 'related')
    expect(unlinked.exitCode).toBe(0)
  })
})

describe('batch json: relation vs kind', () => {
  it('batch with "relation" key succeeds', () => {
    const ops = parseBatchInput(JSON.stringify([
      { op: 'link', slug: 'foo', target: 'bar', relation: 'parent' },
    ]))
    expect(ops).toHaveLength(1)
  })

  it('batch with "kind" key fails with did-you-mean "relation"', () => {
    const input = JSON.stringify([
      { op: 'link', slug: 'foo', target: 'bar', kind: 'parent' },
    ])
    try {
      parseBatchInput(input)
      expect.fail('expected throw')
    } catch (err) {
      const e = err as HafezError
      const blob = e.details?.join('\n') ?? ''
      expect(blob).toContain('unknown field')
      expect(blob).toContain('did you mean "relation"')
    }
  })
})
